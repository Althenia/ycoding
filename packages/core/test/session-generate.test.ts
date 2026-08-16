import { expect } from "bun:test"
import { LLMClient, LLMEvent, LLMResponse, Model, SystemPart, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { Instructions } from "@ycoding-ai/core/instructions"
import { InstructionBuiltIns } from "@ycoding-ai/core/instructions/builtins"
import { Location } from "@ycoding-ai/core/location"
import { McpInstructions } from "@ycoding-ai/core/mcp/instructions"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ProjectArtifactInstructions } from "@ycoding-ai/core/project-artifact/instructions"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { ReferenceInstructions } from "@ycoding-ai/core/reference/instructions"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGenerate } from "@ycoding-ai/core/session/generate"
import { SessionGenerateNode } from "@ycoding-ai/core/session/generate-node"
import { InstructionState } from "@ycoding-ai/core/session/instruction-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import {
  InstructionBlobTable,
  InstructionStateTable,
  SessionMessageTable,
  SessionPendingTable,
  SessionTable,
} from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SkillInstructions } from "@ycoding-ai/core/skill/instructions"
import { Money } from "@ycoding-ai/schema/money"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
let instruction: string | Instructions.Unavailable = "Initial context"
const sessionID = SessionSchema.ID.make("ses_generate_test")
const model = Model.make({ id: "generate-model", provider: "test", route: OpenAIChat.route })
const cost = {
  input: Money.USDPerMillionTokens.make(10),
  output: Money.USDPerMillionTokens.make(10),
  cache: {
    read: Money.USDPerMillionTokens.make(1),
    write: Money.USDPerMillionTokens.make(10),
  },
}

const generatedResponse = (text: string) => {
  const response = LLMResponse.fromEvents([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "generate" }),
    LLMEvent.textDelta({ id: "generate", text }),
    LLMEvent.textEnd({ id: "generate" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 100, outputTokens: 10 } }),
    LLMEvent.finish({ reason: "stop" }),
  ])
  if (!response) throw new Error("Incomplete generate response")
  return response
}

const client = Layer.mock(LLMClient.Service)({
  prepare: () => Effect.die(new Error("unused")),
  stream: () => Stream.die(new Error("unused")),
  generate: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return generatedResponse("Transient answer")
    }),
})
const models = SessionRunnerModel.layerWith(() =>
  Effect.succeed(SessionRunnerModel.resolved(model, undefined, [cost])),
)
const builtins = Layer.mock(InstructionBuiltIns.Service, {
  load: () =>
    Effect.succeed(
      Instructions.make({
        key: Instructions.Key.make("test/context"),
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.sync(() => instruction),
        render: {
          initial: String,
          changed: (_previous, current) => current,
        },
      }),
    ),
})
const discovery = Layer.mock(InstructionDiscovery.Service, { load: () => Effect.succeed(Instructions.empty) })
const skills = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const references = Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const mcp = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const plugins = Layer.mock(PluginSupervisor.Service, { flush: Effect.void })

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      InstructionBuiltIns.node,
      PluginHooks.node,
      SessionGenerateNode.node,
    ]),
    [
      [llmClient, client],
      [SessionRunnerModel.node, models],
      [InstructionBuiltIns.node, builtins],
      [InstructionDiscovery.node, discovery],
      [SkillInstructions.node, skills],
      [ReferenceInstructions.node, references],
      [McpInstructions.node, mcp],
      [PluginSupervisor.node, plugins],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    ],
  ),
)

const reset = () => {
  requests.length = 0
}

const durableState = (db: Database.Interface["db"], id: SessionSchema.ID) =>
  Effect.all({
    sequence: EventV2.latestSequence(db, id),
    events: db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie),
    messages: db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, id))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie),
    pending: db
      .select()
      .from(SessionPendingTable)
      .where(eq(SessionPendingTable.session_id, id))
      .orderBy(asc(SessionPendingTable.admitted_seq))
      .all()
      .pipe(Effect.orDie),
    instructions: db
      .select()
      .from(InstructionStateTable)
      .where(eq(InstructionStateTable.session_id, id))
      .get()
      .pipe(Effect.orDie),
    blobs: db.select().from(InstructionBlobTable).orderBy(asc(InstructionBlobTable.hash)).all().pipe(Effect.orDie),
    session: db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie),
  })

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const agents = yield* AgentV2.Service
  const instructionBuiltIns = yield* InstructionBuiltIns.Service
  yield* agents.transform((draft) =>
    draft.update(AgentV2.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      directory: "/project",
      title: "Generate test",
      agent: AgentV2.ID.make("build"),
    })
    .run()
    .pipe(Effect.orDie)
  return { db, events, instructions: yield* instructionBuiltIns.load(sessionID) }
})

it.effect("executes the provider for transient generation without durable mutation", () =>
  Effect.gen(function* () {
    reset()
    instruction = "Initial context"
    const { db } = yield* setup
    const before = yield* durableState(db, sessionID)

    const result = yield* SessionGenerate.Service.use((service) =>
      service.generate({ sessionID, prompt: "Generate privately" }),
    )

    expect(result).toBe("Transient answer")
    expect(requests).toHaveLength(1)
    expect(yield* durableState(db, sessionID)).toEqual(before)
  }),
)

it.effect("generates from fresh settled Session context without durable mutation", () =>
  Effect.gen(function* () {
    reset()
    instruction = "Initial context"
    const { db, events, instructions } = yield* setup
    yield* InstructionState.prepare(db, events, instructions, sessionID)
    const existing = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.InputAdmitted, {
      sessionID,
      inputID: existing,
      input: { type: "user", data: { text: "Existing durable context" }, delivery: "steer" },
    })
    yield* events.publish(SessionEvent.InputPromoted, { sessionID, inputID: existing })
    const settledAssistant = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID: settledAssistant,
      agent: AgentV2.ID.make("build"),
      model: { id: ModelV2.ID.make("generate-model"), providerID: ProviderV2.ID.make("test") },
    })
    yield* events.publish(SessionEvent.Text.Started, {
      sessionID,
      assistantMessageID: settledAssistant,
      ordinal: 0,
    })
    yield* events.publish(SessionEvent.Text.Ended, {
      sessionID,
      assistantMessageID: settledAssistant,
      ordinal: 0,
      text: "Settled partial answer",
    })
    const activeAssistant = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID: activeAssistant,
      agent: AgentV2.ID.make("build"),
      model: { id: ModelV2.ID.make("generate-model"), providerID: ProviderV2.ID.make("test") },
    })
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID: activeAssistant,
      callID: "active-call",
      name: "echo",
    })
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID: activeAssistant,
      callID: "active-call",
      text: "{}",
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID: activeAssistant,
      callID: "active-call",
      input: {},
      executed: false,
    })
    yield* events.publish(SessionEvent.InputAdmitted, {
      sessionID,
      inputID: SessionMessage.ID.create(),
      input: { type: "user", data: { text: "Queued input must remain invisible" }, delivery: "queue" },
    })
    instruction = "Changed context"
    const before = yield* durableState(db, sessionID)
    const generate = yield* SessionGenerate.Service
    yield* generate.generate({ sessionID, prompt: "Summarize privately" })
    const unhookedPromptCacheKey = requests[0]?.providerOptions?.openai?.promptCacheKey
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => {
        event.system = [SystemPart.make("Hooked system"), ...event.system]
      }),
    )

    const result = yield* generate.generate({ sessionID, prompt: "Summarize privately" })
    const request = requests.at(-1)
    if (!request) throw new Error("Missing generated request")

    expect(result).toBe("Transient answer")
    expect(requests).toHaveLength(2)
    expect(request.model).toBe(model)
    expect(request.system[0]?.text).toBe("Hooked system")
    expect(request.system.map((part) => part.text)).toContain("Initial context")
    expect(request.http?.headers).toMatchObject({ "X-Session-Id": sessionID })
    const promptCacheKey = request.providerOptions?.openai?.promptCacheKey
    expect(promptCacheKey).toMatch(/^[0-9a-f]{64}$/)
    expect(promptCacheKey).not.toBe(sessionID)
    expect(promptCacheKey).not.toBe(unhookedPromptCacheKey)
    expect(request.providerOptions?.openrouter.promptCacheKey).toBe(promptCacheKey)
    expect(request.providerOptions?.openrouter.sessionID).not.toBe(promptCacheKey)
    expect(request.providerOptions?.openrouter.sessionID).toMatch(/^[0-9a-f]{64}$/)
    expect(
      request.messages.flatMap((message) =>
        message.role === "system"
          ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
          : [],
      ),
    ).toEqual([["Changed context", ProjectArtifactInstructions.content].join("\n\n")])
    expect(userTexts(request)).toEqual(["Existing durable context", "Summarize privately"])
    expect(
      request.messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
          : [],
      ),
    ).toEqual(["Settled partial answer"])
    expect(request.tools).toEqual([])
    expect(request.toolChoice).toMatchObject({ type: "none" })
    expect(yield* durableState(db, sessionID)).toEqual(before)
  }),
)

it.effect("blocks unavailable initial instructions before generation", () =>
  Effect.gen(function* () {
    reset()
    instruction = Instructions.unavailable
    const { db } = yield* setup
    const before = yield* durableState(db, sessionID)
    const generate = yield* SessionGenerate.Service

    const error = yield* generate.generate({ sessionID, prompt: "Summarize privately" }).pipe(Effect.flip)

    expect(error).toBeInstanceOf(Instructions.InitializationBlocked)
    expect(requests).toEqual([])
    expect(yield* durableState(db, sessionID)).toEqual(before)
  }),
)
