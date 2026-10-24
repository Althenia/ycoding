import { afterEach, expect } from "bun:test"
import { LLMClient, LLMError, LLMEvent, LLMRequest, Model, TransportReason } from "@ycoding-ai/ai"
import { AnthropicMessages, OpenAIChat, OpenAIResponses } from "@ycoding-ai/ai/protocols"
import { RequestExecutor } from "@ycoding-ai/ai/route"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigEfficiency } from "@ycoding-ai/core/config/efficiency"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionProviderRequestTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionHelperPolicy, localTitle } from "@ycoding-ai/core/session/helper-policy"
import { SessionTitle } from "@ycoding-ai/core/session/title"
import { Session } from "@ycoding-ai/core/session"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Money } from "@ycoding-ai/schema/money"
import { Effect, Layer, Logger, Stream } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
let response: ((request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>) | undefined
afterEach(() => {
  response = undefined
})
const model = Model.make({
  id: "title-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const client = Layer.mock(LLMClient.Service)({
  prepare: () => Effect.die("unused"),
  stream: (request: LLMRequest) => {
    requests.push(request)
    if (response) return response(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "title", text: "Generated Title\n" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: {
          inputTokens: 15,
          outputTokens: 6,
          nonCachedInputTokens: 10,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          reasoningTokens: 2,
          promptEvalDurationNs: 4_000_000,
          providerMetadata: { anthropic: { cache_creation: { ephemeral_1h_input_tokens: 1 } } },
        },
      }),
      LLMEvent.finish({
        reason: "stop",
      }),
    )
  },
  generate: () => Effect.die("unused"),
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () => Effect.succeed(SessionRunnerModel.resolved(model, undefined, cost)),
})
let titleMode: SessionHelperPolicy.TitleMode = "local"
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    diagnostics: () => Effect.succeed([]),
    reload: () => Effect.void,
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            efficiency: new ConfigEfficiency.Info({
              prompt_cache: new ConfigEfficiency.PromptCache({ anthropic_ttl: "adaptive" }),
            }),
          }),
        }),
      ]),
  }),
)
const helperPolicy = Layer.succeed(
  SessionHelperPolicy.Service,
  SessionHelperPolicy.Service.of({
    get settings() {
      return { titleMode, models: {} }
    },
    localTitle,
    resolveRef: () => Effect.die("Unexpected exact helper resolution"),
    resolveModel: () => Effect.succeed(SessionRunnerModel.resolved(model, undefined, cost)),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      SessionHelperPolicy.node,
      SessionTitle.node,
    ]),
    [
      [llmClient, client],
      [SessionRunnerModel.node, models],
      [SessionHelperPolicy.node, helperPolicy],
      [Config.node, config],
    ],
  ),
)

const defaultTitle = "New session - 2026-10-24T00:00:00.000Z"

const insertSession = (id: Session.ID, title = defaultTitle) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        directory: "/project",
        title,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const prompt = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const messageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.InputAdmitted, {
      sessionID,
      inputID: messageID,
      input: { type: "user", data: { text }, delivery: "steer" },
    })
    yield* events.publish(SessionEvent.InputPromoted, {
      sessionID,
      inputID: messageID,
    })
  })

it.effect("uses a deterministic local title by default without a provider call", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "local"
    const sessionID = Session.ID.make("ses_title_local")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "# Help me debug the failing build\nIgnore this line")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    yield* (yield* SessionTitle.Service).generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
    const renamed = yield* store.get(sessionID)
    expect(renamed?.title).toBe("Help me debug the failing build")
    expect(renamed?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(renamed?.cost).toBe(Money.USD.zero)
  }),
)

it.effect("preserves model-generated titles when explicitly enabled", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "model"
    const agentService = yield* Agent.Service
    yield* agentService.transform((editor) => {
      editor.update(Agent.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "You are a title generator."
      })
    })
    const sessionID = Session.ID.make("ses_title_generate")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    yield* (yield* SessionTitle.Service).generateForFirstPrompt(session)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.http?.headers).toEqual({
      "x-session-affinity": sessionID,
      "X-Session-Id": sessionID,
      "User-Agent": `ycoding/${InstallationVersion}`,
      "x-ycoding-project": Project.ID.global,
      "x-ycoding-session": sessionID,
      "x-ycoding-client": "cli",
    })
    expect(JSON.stringify(requests[0]?.messages)).toContain("Help me debug the failing build")
    const renamed = yield* store.get(sessionID)
    expect(renamed?.title).toBe("Generated Title")
    expect(renamed?.tokens).toEqual({ input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } })
    expect(renamed?.cost).toBeCloseTo(0.0000248)
    const { db } = yield* Database.Service
    expect(
      yield* db
        .select({ timing: SessionProviderRequestTable.timing })
        .from(SessionProviderRequestTable)
        .where(eq(SessionProviderRequestTable.session_id, sessionID))
        .get(),
    ).toMatchObject({
      timing: { promptEvalDurationNs: 4_000_000 },
    })
    const promptCacheKey = requests[0]?.providerOptions?.openai?.promptCacheKey
    expect(typeof promptCacheKey).toBe("string")
    if (typeof promptCacheKey !== "string") {
      yield* Effect.die("prompt cache key missing")
      return
    }
    expect(promptCacheKey).toMatch(/^[0-9a-f]{64}$/)
  }),
)

it.effect("leaves the generated title unchanged when title generation is off", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "off"
    const sessionID = Session.ID.make("ses_title_off")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    yield* (yield* SessionTitle.Service).generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
    expect((yield* store.get(sessionID))?.title).toBe(defaultTitle)
  }),
)

it.effect("preserves a known zero helper price", () => Effect.gen(function* () {
  const zero = Money.USDPerMillionTokens.make(0)
  yield* Effect.acquireUseRelease(
    Effect.sync(() => cost.splice(0, cost.length, { input: zero, output: zero, cache: { read: zero, write: zero } })),
    () => Effect.gen(function* () {
      requests = []
      titleMode = "model"
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => editor.update(Agent.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "You are a title generator."
      }))
      const sessionID = Session.ID.make("ses_title_zero_price")
      yield* insertSession(sessionID)
      yield* prompt(sessionID, "Debug the build")
      const store = yield* SessionStore.Service
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die("session missing")
      const title = yield* SessionTitle.Service
      yield* title.generateForFirstPrompt(session)
      const database = yield* Database.Service
      expect(requests).toHaveLength(1)
      expect(yield* database.db.select({ source: SessionProviderRequestTable.source, cost: SessionProviderRequestTable.cost }).from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, sessionID)).get()).toEqual({ source: "title", cost: 0 })
    }),
    (previous) => Effect.sync(() => cost.splice(0, cost.length, ...previous)),
  )
}))

it.effect("does not generate once a second user message exists", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "local"
    const agentService = yield* Agent.Service
    yield* agentService.transform((editor) => {
      editor.update(Agent.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "You are a title generator."
      })
    })
    const sessionID = Session.ID.make("ses_title_second_message")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "First message")
    yield* prompt(sessionID, "Second message")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    const title = yield* SessionTitle.Service
    yield* title.generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
    const untouched = yield* store.get(sessionID)
    expect(untouched?.title).toBe(defaultTitle)
  }),
)

it.effect("does not generate for a child session", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "local"
    const agentService = yield* Agent.Service
    yield* agentService.transform((editor) => {
      editor.update(Agent.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "You are a title generator."
      })
    })
    const sessionID = Session.ID.make("ses_title_child")
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        parent_id: Session.ID.make("ses_title_parent"),
        directory: "/project",
        title: "Child session - fake",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* prompt(sessionID, "Do this subtask")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    const title = yield* SessionTitle.Service
    yield* title.generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
  }),
)

it.effect("falls back to local title in model mode when the title agent is removed", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "model"
    const sessionID = Session.ID.make("ses_title_no_agent")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    const title = yield* SessionTitle.Service
    yield* title.generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
    const untouched = yield* store.get(sessionID)
    expect(untouched?.title).toBe("Help me debug the failing build")
  }),
)

const generateModelTitle = generateTitleFor(defaultTitle)

function generateTitleFor(initialTitle: string, mode: SessionHelperPolicy.TitleMode = "model") {
  return Effect.gen(function* () {
    requests = []
    titleMode = mode
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => {
      editor.update(Agent.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "Output only a conversation title."
      })
  })
  const sessionID = Session.ID.create()
  yield* insertSession(sessionID, initialTitle)
  yield* prompt(sessionID, "# Help me debug the failing build\nKeep the details private")
  const store = yield* SessionStore.Service
  const session = yield* store.get(sessionID)
  if (!session) return yield* Effect.die("session missing")
  const title = yield* SessionTitle.Service
  yield* title.generateForFirstPrompt(session)
  return (yield* store.get(sessionID))!
  })
}

const titleOutput = (text: string, stepReason: "stop" | "content-filter" = "stop", finishReason = stepReason) =>
  Stream.make(
    LLMEvent.textDelta({ id: "title", text }),
    LLMEvent.stepFinish({
      index: 0,
      reason: stepReason,
      usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5 },
    }),
    LLMEvent.finish({ reason: finishReason }),
  )

for (const scenario of [
  { name: "a filtered Step finish", stream: titleOutput("A plausible title", "content-filter", "stop") },
  { name: "a filtered request finish", stream: titleOutput("A plausible title", "stop", "content-filter") },
  { name: "a plain cannot refusal", stream: titleOutput("I cannot help with that request.") },
  { name: "a plain contraction refusal", stream: titleOutput("I can't assist with this request.") },
  { name: "a curly-apostrophe refusal", stream: titleOutput("I can’t provide that information.") },
  { name: "an apologetic refusal", stream: titleOutput("I'm sorry, but I cannot assist with that.") },
  { name: "an inability refusal", stream: titleOutput("I am unable to fulfill this request.") },
  { name: "a contracted inability refusal", stream: titleOutput("I’m unable to fulfill this request.") },
  { name: "a plural inability refusal", stream: titleOutput("We’re not able to assist with that request.") },
  { name: "an explicit declining response", stream: titleOutput("I decline to assist with that request.") },
  { name: "a refusal with a preamble", stream: titleOutput("Unfortunately, I cannot help with that request.") },
  { name: "a policy refusal", stream: titleOutput("As an AI assistant, I must decline this request.") },
  { name: "a quoted refusal", stream: titleOutput('"I cannot help with that request."') },
  {
    name: "a refusal split across chunks",
    stream: Stream.make(
      LLMEvent.textDelta({ id: "title", text: "\n  I can" }),
      LLMEvent.textDelta({ id: "title", text: "not help with that request." }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5 },
      }),
      LLMEvent.finish({ reason: "stop" }),
    ),
  },
])
  it.effect(`uses the local title for ${scenario.name} without losing reported usage`, () =>
    Effect.gen(function* () {
      response = () => scenario.stream
      const session = yield* generateModelTitle
      expect(session.title).toBe("Help me debug the failing build")
      expect(requests).toHaveLength(1)
      expect(session.tokens).toEqual({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } })
      expect(session.cost).toBeCloseTo(0.00002)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionProviderRequestTable)
          .where(eq(SessionProviderRequestTable.session_id, session.id))
          .all(),
      ).toMatchObject([{ source: "title", tokens: { input: 10, output: 5 }, cost: 0.00002 }])
    }),
  )

for (const text of ["Investigate model refusals", "Cannot connect to the database", "Repair the build\nMore details"])
  it.effect(`keeps the valid model title ${JSON.stringify(text)}`, () =>
    Effect.gen(function* () {
      response = () => titleOutput(text)
      const session = yield* generateModelTitle
      expect(session.title).toBe(text.split("\n")[0])
      expect(requests).toHaveLength(1)
    }),
  )

for (const scenario of [
  {
    name: "Anthropic's refusal stop reason",
    model: AnthropicMessages.route.model({ id: "claude-sonnet-4-5" }),
    body: [
      {
        type: "message_start",
        message: {
          id: "msg_title",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A plausible title" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ],
  },
  {
    name: "OpenAI Chat's refusal field",
    model: OpenAIChat.route.model({ id: "gpt-title" }),
    body: [
      { choices: [{ delta: { refusal: "I cannot help with that request." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ],
  },
  {
    name: "OpenAI Responses' refusal content",
    model: OpenAIResponses.route.model({ id: "gpt-title" }),
    body: [
      {
        type: "response.refusal.delta",
        item_id: "msg_title",
        content_index: 0,
        delta: "I cannot help with that request.",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_title",
          output: [
            {
              type: "message",
              id: "msg_title",
              role: "assistant",
              content: [{ type: "refusal", refusal: "I cannot help with that request." }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ],
  },
])
  it.effect(`uses the local title for native ${scenario.name}`, () =>
    Effect.gen(function* () {
      response = (request) =>
        LLMClient.stream(LLMRequest.update(request, { model: scenario.model })).pipe(
          Stream.provide(
            LLMClient.layer.pipe(
              Layer.provide(
                Layer.succeed(RequestExecutor.Service, {
                  execute: (request) =>
                    Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        new Response(
                          scenario.body.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
                            "data: [DONE]\n\n",
                          { headers: { "content-type": "text/event-stream" } },
                        ),
                      ),
                    ),
                }),
              ),
            ),
          ),
        )
      const session = yield* generateModelTitle
      expect(session.title).toBe("Help me debug the failing build")
      expect(requests).toHaveLength(1)
      expect(session.tokens).toEqual({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } })
    }),
  )

for (const scenario of [
  {
    name: "a provider error event",
    stream: Stream.make(
      LLMEvent.textDelta({ id: "title", text: "Do not save this partial title" }),
      LLMEvent.providerError({ message: "Synthetic title provider unavailable" }),
    ),
  },
  {
    name: "a thrown provider error",
    stream: Stream.fail(
      new LLMError({
        module: "test",
        method: "stream",
        reason: new TransportReason({ message: "Synthetic title provider unavailable" }),
      }),
    ),
  },
])
  it.effect(`keeps ${scenario.name} observable while using the local title`, () =>
    Effect.gen(function* () {
      response = () => scenario.stream
      const logs: string[] = []
      const session = yield* generateModelTitle.pipe(
        Effect.provide(
          Logger.layer([Logger.make((entry) => logs.push(Bun.inspect(entry.message)))], { mergeWithExisting: false }),
        ),
      )
      expect(session.title).toBe("Help me debug the failing build")
      expect(logs.join("\n")).toContain("Synthetic title provider unavailable")
      expect(requests).toHaveLength(1)
    }),
  )

const responsesStream = (body: ReadonlyArray<unknown>) => (request: LLMRequest) =>
  LLMClient.stream(LLMRequest.update(request, { model: OpenAIResponses.route.model({ id: "gpt-title" }) })).pipe(
    Stream.provide(
      LLMClient.layer.pipe(
        Layer.provide(
          Layer.succeed(RequestExecutor.Service, {
            execute: (request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(body.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
                    headers: { "content-type": "text/event-stream" },
                  }),
                ),
              ),
          }),
        ),
      ),
    ),
  )

const responsesCompleted = {
  type: "response.completed",
  response: { id: "resp_title", output: [], usage: { input_tokens: 10, output_tokens: 5 } },
}

const commentary = "Inspecting source files before selecting a concise session label."

for (const scenario of [
  {
    name: "a commentary message before the final answer",
    expected: "Debug failing build",
    body: [
      { type: "response.output_item.added", item: { type: "message", id: "msg_commentary", phase: "commentary" } },
      { type: "response.output_text.delta", item_id: "msg_commentary", content_index: 0, delta: commentary },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "msg_commentary",
          phase: "commentary",
          content: [{ type: "output_text", text: commentary }],
        },
      },
      { type: "response.output_item.added", item: { type: "message", id: "msg_final", phase: "final_answer" } },
      { type: "response.output_text.delta", item_id: "msg_final", content_index: 0, delta: "Debug failing " },
      { type: "response.output_text.delta", item_id: "msg_final", content_index: 0, delta: "build" },
      responsesCompleted,
    ],
  },
  {
    name: "a commentary phase that is first reported when the message completes",
    expected: "Debug failing build",
    body: [
      { type: "response.output_text.delta", item_id: "msg_commentary", content_index: 0, delta: commentary },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "msg_commentary",
          phase: "commentary",
          content: [{ type: "output_text", text: commentary }],
        },
      },
      { type: "response.output_text.delta", item_id: "msg_final", content_index: 0, delta: "Debug failing build" },
      responsesCompleted,
    ],
  },
  {
    name: "only a commentary message",
    expected: "Help me debug the failing build",
    body: [
      { type: "response.output_item.added", item: { type: "message", id: "msg_commentary", phase: "commentary" } },
      { type: "response.output_text.delta", item_id: "msg_commentary", content_index: 0, delta: commentary },
      responsesCompleted,
    ],
  },
  {
    name: "reasoning summaries before the final answer",
    expected: "Debug failing build",
    body: [
      { type: "response.output_item.added", item: { type: "reasoning", id: "rs_title" } },
      { type: "response.reasoning_summary_part.added", item_id: "rs_title", summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_title", summary_index: 0, delta: commentary },
      { type: "response.output_item.done", item: { type: "reasoning", id: "rs_title" } },
      { type: "response.output_text.delta", item_id: "msg_final", content_index: 0, delta: "Debug failing build" },
      responsesCompleted,
    ],
  },
])
  it.effect(`derives the title from the OpenAI Responses answer for ${scenario.name}`, () =>
    Effect.gen(function* () {
      response = responsesStream(scenario.body)
      const session = yield* generateModelTitle
      expect(session.title).toBe(scenario.expected)
      expect(requests).toHaveLength(1)
      expect(session.tokens).toEqual({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } })
    }),
  )

for (const mode of ["model", "local"] as const)
  it.effect(`keeps an explicit session title in ${mode} mode`, () =>
    Effect.gen(function* () {
      const session = yield* generateTitleFor("Quarterly planning", mode)
      expect(session.title).toBe("Quarterly planning")
      expect(requests).toHaveLength(0)
    }),
  )
