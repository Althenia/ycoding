import { expect, test } from "bun:test"
import { LLM, Message, Model, SystemPart, ToolDefinition } from "@ycoding-ai/ai"
import { configure } from "@ycoding-ai/ai/providers/openai"
import { model } from "@ycoding-ai/ai/providers/anthropic"
import { provider } from "@ycoding-ai/ai/providers/google"
import { responses } from "@ycoding-ai/ai/providers/openrouter"
import type { OpenAIResponsesBody } from "@ycoding-ai/ai/protocols/openai-responses"
import { LLMClient } from "@ycoding-ai/ai/route"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { toLLMMessages } from "@ycoding-ai/core/session/runner/to-llm-message"
import { SessionSharedContext } from "@ycoding-ai/core/session/shared-context"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { DateTime, Effect } from "effect"

const timestamp = DateTime.makeUnsafe(0)
const parentID = SessionSchema.ID.make("ses_cache_source")
const sourceID = SessionMessage.ID.make("msg_cache_source")
const unselectedID = SessionMessage.ID.make("msg_unselected_source")
const modelRef = CatalogModel.Ref.make({ id: CatalogModel.ID.make("gpt-5.6"), providerID: Provider.ID.make("openai") })
const prefixText = `selected evidence ${"évidence ".repeat(520)}`
const source = SessionMessage.User.make({
  id: sourceID,
  type: "user",
  text: prefixText,
  files: [],
  agents: [],
  time: { created: timestamp },
})
const unselected = SessionMessage.User.make({
  id: unselectedID,
  type: "user",
  text: "Unselected full transcript must not be copied.",
  files: [],
  agents: [],
  time: { created: timestamp },
})
const prepare = (
  text: string,
  metadata?: Record<string, unknown>,
  cacheSharedContext = false,
  sessionID = "ses_cache_a",
  extraMessages: ReadonlyArray<Message> = [],
  openaiMode: "auto" | "explicit" = "explicit",
) => {
  const user = SessionMessage.User.make({
    id: SessionMessage.ID.make(`msg_${sessionID}`),
    type: "user",
    text,
    metadata,
    files: [],
    agents: [],
    time: { created: timestamp },
  })
  const lowered = toLLMMessages([user], modelRef, undefined, undefined, undefined, undefined, cacheSharedContext)
  const sharedContext = metadata === undefined ? undefined : SessionSharedContext.split(text, metadata)
  const cache = SessionRunnerCache.providerOptions({
    projectID: "project",
    directory: "/repo",
    providerID: "openai",
    modelID: "gpt-5.6",
    apiModelID: "gpt-5.6",
    sessionID,
    routeID: "openai-responses",
    accountIdentityDigest: "4".repeat(64),
    policyRevision: CACHE_POLICY_REVISION,
    permissions: [{ action: "read", resource: "**", effect: "allow" }],
    system: [SystemPart.make("Stable instructions")],
    tools: [ToolDefinition.make({ name: "search", description: "Search", inputSchema: { type: "object" } })],
    openaiMode,
    familyExperiment: sharedContext
      ? {
          rootSessionID: "ses_root",
          connectionIdentityDigest: "1".repeat(64),
          semanticOptionsDigest: "2".repeat(64),
          snapshotDigest: sharedContext.digest,
          endpointBaseURL: "https://api.openai.com/v1",
        }
      : undefined,
  })
  return Effect.runPromise(
    LLMClient.prepare<OpenAIResponsesBody>(
      LLM.request({
        model: configure({ apiKey: "fixture-key" }).responses("gpt-5.6"),
        system: [SystemPart.make("Stable instructions")],
        tools: [ToolDefinition.make({ name: "search", description: "Search", inputSchema: { type: "object" } })],
        messages: [...lowered, ...extraMessages],
        providerOptions: cache.providerOptions,
        cache: cache.cache,
      }),
    ),
  )
}

const compileSelectedContext = async (
  model: Model,
  text: string,
  metadata: Record<string, unknown> | undefined,
  sessionID: string,
) => {
  const modelRef = CatalogModel.Ref.make({
    id: CatalogModel.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
  })
  const system = [SystemPart.make("Stable instructions")]
  const tools = [ToolDefinition.make({ name: "search", description: "Search", inputSchema: { type: "object" } })]
  const cacheSharedContext = SessionRunnerCache.sharedContextMarkerSupport({
    providerID: model.provider,
    routeID: model.route.id,
    apiModelID: model.id,
    openaiMode: "implicit",
    endpointBaseURL: model.route.endpoint.baseURL,
  })
  const lowered = toLLMMessages(
    [
      SessionMessage.User.make({
        id: SessionMessage.ID.make(`msg_${sessionID}`),
        type: "user",
        text,
        metadata,
        files: [],
        agents: [],
        time: { created: timestamp },
      }),
    ],
    modelRef,
    undefined,
    undefined,
    undefined,
    undefined,
    cacheSharedContext,
  )
  const cache = SessionRunnerCache.providerOptions({
    projectID: "project",
    directory: "/repo",
    providerID: model.provider,
    modelID: model.id,
    apiModelID: model.id,
    sessionID,
    routeID: model.route.id,
    policyRevision: CACHE_POLICY_REVISION,
    permissions: [{ action: "read", resource: "**", effect: "allow" }],
    system,
    tools,
    openaiMode: "implicit",
    anthropicTtlSeconds: 300,
  })
  const prepared = await Effect.runPromise(
    LLMClient.prepare(
      LLM.request({ model, system, tools, messages: lowered, providerOptions: cache.providerOptions, cache: cache.cache }),
    ),
  )
  return { body: prepared.body, lowered }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const textContent = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(textContent)
  if (!isRecord(value)) return []
  return [
    ...(value.type === "input_text" && typeof value.text === "string" ? [value.text] : []),
    ...Object.values(value).flatMap(textContent),
  ]
}

const markedText = (value: unknown, matching: (text: string) => boolean): string[] => {
  if (Array.isArray(value)) return value.flatMap((item) => markedText(item, matching))
  if (!isRecord(value)) return []
  return value.type === "input_text" &&
    typeof value.text === "string" &&
    value.prompt_cache_breakpoint !== undefined &&
    matching(value.text)
    ? [value.text]
    : Object.values(value).flatMap((item) => markedText(item, matching))
}

const inputTextBlocks = (value: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) return value.flatMap(inputTextBlocks)
  if (!isRecord(value)) return []
  return [
    ...(value.type === "input_text" ? [value] : []),
    ...Object.values(value).flatMap(inputTextBlocks),
  ]
}

const recordsWithText = (value: unknown): Array<Record<string, unknown> & { readonly text: string }> => {
  if (Array.isArray(value)) return value.flatMap(recordsWithText)
  if (!isRecord(value)) return []
  return [
    ...(typeof value.text === "string" ? [{ ...value, text: value.text }] : []),
    ...Object.values(value).flatMap(recordsWithText),
  ]
}

test("compiles one shared marked prefix and records offline wire metrics", async () => {
  const resolvedSnapshot = await Effect.runPromise(
    SessionSharedContext.resolve(parentID, { messageIDs: [sourceID] }, (_, messageID) =>
      Effect.succeed(messageID === sourceID ? source : unselected),
    ),
  )
  const taskA = "task A: continue precisely"
  const taskB = "task B: continue differently"
  const composedA = SessionSharedContext.compose(taskA, resolvedSnapshot)
  const composedB = SessionSharedContext.compose(taskB, resolvedSnapshot)
  const flattened = await prepare(composedA.text, undefined, false, "ses_flat")
  const first = await prepare(composedA.text, { sharedContext: composedA.sharedContext }, true, "ses_cache_a")
  const second = await prepare(composedB.text, { sharedContext: composedB.sharedContext }, true, "ses_cache_b")
  const expectedText = ["Stable instructions", composedA.text]
  const sharedPrefix = composedA.text.slice(0, composedA.sharedContext.prefixLength)
  const compiledText = textContent(first.body.input)
  const flattenedInput = Buffer.from(JSON.stringify(flattened.body.input))
  const sharedContextInput = Buffer.from(JSON.stringify(first.body.input))
  const firstDivergence = flattenedInput.findIndex((byte, index) => byte !== sharedContextInput[index])
  const metrics = {
    sharedPrefixBytes: Buffer.byteLength(composedA.text.slice(0, composedA.sharedContext.prefixLength), "utf8"),
    markedBoundaries: markedText(first.body.input, (text) => text === sharedPrefix).length,
    flattenedBaselineBoundaries: markedText(flattened.body.input, (text) => text === sharedPrefix).length,
    firstDivergence,
    siblingKeyPartitions: new Set([first.body.prompt_cache_key, second.body.prompt_cache_key]).size,
    liveCacheTokens: "unreported",
    liveCacheWrites: "unreported",
    liveTTFT: "unreported",
    liveCost: "unreported",
  }

  expect(metrics.sharedPrefixBytes).toBeGreaterThanOrEqual(4_700)
  expect(metrics.markedBoundaries).toBe(1)
  expect(metrics.flattenedBaselineBoundaries).toBe(0)
  expect(firstDivergence).toBeGreaterThanOrEqual(0)
  expect(metrics.siblingKeyPartitions).toBe(1)
  expect(compiledText.join("")).toBe(expectedText.join(""))
  expect(compiledText.join("")).toContain(taskA)
  expect(compiledText.join("")).toContain(resolvedSnapshot.text)
  expect(compiledText.join("")).not.toContain(unselected.text)
  expect(first.body.prompt_cache_key).toBe(second.body.prompt_cache_key)
  expect(first.body.tools).toEqual(flattened.body.tools)
  expect(first.body.input?.[0]).toEqual(flattened.body.input?.[0])
  expect(metrics).toMatchObject({
    liveCacheTokens: "unreported",
    liveCacheWrites: "unreported",
    liveTTFT: "unreported",
    liveCost: "unreported",
  })

  const laterMessages = Array.from({ length: 55 }, (_, index) => Message.user(`Later eligible message ${index}`))
  const volatileTail = Message.make({ role: "user", content: "live volatile state", volatile: true })
  const withVolatileTail = await prepare(
    composedA.text,
    { sharedContext: composedA.sharedContext },
    true,
    "ses_cache_volatile",
    [...laterMessages, volatileTail],
  )
  const implicit = await prepare(
    composedA.text,
    { sharedContext: composedA.sharedContext },
    true,
    "ses_cache_implicit",
    laterMessages,
    "auto",
  )
  const volatileInputText = inputTextBlocks(withVolatileTail.body.input)
  const firstSharedWirePart = volatileInputText.find(
    (part) => typeof part.text === "string" && part.text.includes("<shared-context>"),
  )
  const volatileWirePart = volatileInputText.find(
    (part) => typeof part.text === "string" && part.text.includes("live volatile state"),
  )
  expect(firstSharedWirePart?.prompt_cache_breakpoint).toEqual({ mode: "explicit" })
  expect(volatileWirePart?.prompt_cache_breakpoint).toBeUndefined()
  expect(volatileInputText.filter((part) => part.prompt_cache_breakpoint !== undefined).length).toBe(50)
  expect(implicit.body.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" })
  expect(inputTextBlocks(implicit.body.input).filter((part) => part.prompt_cache_breakpoint !== undefined).length).toBe(49)
  expect(
    inputTextBlocks(implicit.body.input).some(
      (part) => typeof part.text === "string" && part.text.includes("<shared-context>") && part.prompt_cache_breakpoint !== undefined,
    ),
  ).toBe(true)
})

test("keeps selected-context wire controls unchanged for Codex, Anthropic, OpenRouter, and Gemini", async () => {
  const openai = configure({ apiKey: "fixture-key" }).responses("gpt-5.6")
  const models = [
    Model.update(openai, {
      route: openai.route.with({ id: "openai-codex-responses", endpoint: { baseURL: "https://chatgpt.com/backend-api/codex" } }),
    }),
    model("claude-sonnet-4-5", { apiKey: "fixture-key" }),
    responses("openai/gpt-5.6", { apiKey: "fixture-key" }),
    provider.configure({ apiKey: "fixture-key" }).model("gemini-2.5-flash"),
  ]
  const resolvedSnapshot = await Effect.runPromise(
    SessionSharedContext.resolve(parentID, { messageIDs: [sourceID] }, () => Effect.succeed(source)),
  )
  const composed = SessionSharedContext.compose("Preserve the selected task.", resolvedSnapshot)

  for (const [index, model] of models.entries()) {
    const selected = await compileSelectedContext(
      model,
      composed.text,
      { sharedContext: composed.sharedContext },
      `ses_route_${index}`,
    )
    const flattened = await compileSelectedContext(model, composed.text, undefined, `ses_route_${index}`)
    const selectedBody = JSON.stringify(selected.body)
    const flattenedBody = JSON.stringify(flattened.body)
    const prefix = selected.lowered[0]?.content[0]
    expect(prefix && "cache" in prefix ? prefix.cache : undefined).toBeUndefined()
    expect(selectedBody).not.toContain("prompt_cache_options")
    expect(selectedBody).not.toContain("prompt_cache_retention")
    expect(selectedBody.match(/prompt_cache_breakpoint/g)?.length ?? 0).toBe(
      flattenedBody.match(/prompt_cache_breakpoint/g)?.length ?? 0,
    )
    expect(selectedBody.match(/cache_control/g)?.length ?? 0).toBe(flattenedBody.match(/cache_control/g)?.length ?? 0)
    expect(
      recordsWithText(selected.body).find((part) => part.text === composed.text.slice(0, composed.sharedContext.prefixLength))?.cache_control,
    ).toBeUndefined()
  }
})
