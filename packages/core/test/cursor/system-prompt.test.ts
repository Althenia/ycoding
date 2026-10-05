import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CacheHint, LLM, Message, ToolDefinition } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { CursorModels } from "@ycoding-ai/core/cursor/models"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { expect, it as test } from "bun:test"
import { Effect, Layer } from "effect"
import { ycodingProjectConfigDirs, ycodingGlobalConfigDirs, ycodingConfigFileNames } from "../../src/cursor/provider/context/paths"
import { buildDynamicRequestContext } from "../../src/cursor/provider/context/build"
import { safeTraceEvent } from "../../src/cursor/provider/debug"
import { cursorGrpcError, cursorHttpError } from "../../src/cursor/provider/errors"
import { collectProjectLayout } from "../../src/cursor/provider/context/layout"
import { loadMergedConfig } from "../../src/cursor/provider/context/rules"
import { extractPromptHistory, ycodingSessionKey } from "../../src/cursor/provider/language-model"
import { deliverContinuationResults, extractTrailingToolResults, pump } from "../../src/cursor/provider/language-model"
import { mapAvailableModelsResponse, readCache, refreshModelCache } from "../../src/cursor/provider/models"
import type { CursorSession } from "../../src/cursor/provider/session"
import { buildLanguageModelV3UsageFromTurnEnded } from "../../src/cursor/provider/usage"
import { decodeMessage, decodeMessageSparse, encodeMessage } from "../../src/cursor/provider/protocol/messages"
import { buildSeedConversationState } from "../../src/cursor/provider/protocol/request"
import { buildRequestContextResult, resolveCursorSubagentType } from "../../src/cursor/provider/protocol/tools"
import { resolveSessionWorkspaceRoot } from "../../src/cursor/provider/session-directory"
import { testEffect } from "../lib/effect"

const it = testEffect(AISDK.locationLayer)
const client = LLMClient.layer.pipe(
  Layer.provide(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("Unexpected HTTP request") }),
    ),
  ),
)
const [cursor] = CursorModels.fromCursor([{ id: "claude-opus-4-8", displayName: "Opus 4.8", variants: [] }])
const identity = "You are an AI agent, not Cursor."
const legacyHost = ["open", "code"].join("")
const legacyProjectDir = `.${legacyHost}`
const legacyConfigFlag = `${legacyHost.toUpperCase()}_DISABLE_PROJECT_CONFIG`
const read = ToolDefinition.make({
  name: "read",
  description: "Read the requested file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
})

test("keeps Cursor diagnostics categorical without local paths or credentials", () => {
  expect(safeTraceEvent("project-dir: workspace=/private/tenant/cache token=crsr_sensitive")).toBe("project-dir")
  expect(safeTraceEvent("GetServerConfig POST https://private.example/secret")).toBe("provider event")
  expect(safeTraceEvent("/private/tenant/cache")).toBe("provider event")
})

test("separates Cursor authentication failures from transient Run errors", () => {
  expect(cursorHttpError("AvailableModels", 401)).toMatchObject({
    name: "CursorAuthError", origin: "auth", transient: false, replaySafe: false,
  })
  expect(cursorGrpcError("Run", 14)).toMatchObject({
    name: "CursorServerError", origin: "server", transient: true, replaySafe: true,
  })
  expect(cursorGrpcError("Run", 16)).toMatchObject({
    name: "CursorAuthError", origin: "auth", transient: false, replaySafe: false,
  })
})

test("does not route Cursor subagents to a recipient absent from the executor catalog", () => {
  expect(resolveCursorSubagentType("generalPurpose", { agents: [], complete: false })).toBeUndefined()
  expect(resolveCursorSubagentType("scout", { agents: [{ name: "scout" }], complete: true })).toBe("scout")
})

test("retains discovered Cursor models and source variant tuples across failed refresh", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "cursor-models-"))
  try {
    const models = mapAvailableModelsResponse({ models: [{
      name: "composer-2.5", clientDisplayName: "Composer 2.5", supportsThinking: true,
      variants: [{ parameterValues: [{ id: "effort", value: "high" }, { id: "context", value: "200k" }],
        isDefaultNonMaxConfig: true }],
    }] })
    expect(models).toMatchObject([{ id: "composer-2.5", maxContext: 200_000,
      variants: [{ parameterValues: [{ id: "effort", value: "high" }, { id: "context", value: "200k" }] }],
    }])
    await refreshModelCache(cacheDir, async () => models)
    const failure = await refreshModelCache(cacheDir, async () => { throw new Error("discovery denied") })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ message: "discovery denied" })
    expect((await readCache(cacheDir))?.models).toEqual(models)
    expect(() => mapAvailableModelsResponse({ models: [{ name: "broken", variants: "invalid" }] })).toThrow(
      "AvailableModels returned invalid variants",
    )
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

const runFrames = (messages: Uint8Array[], written: Uint8Array[] = []) => {
  let closed = false
  const session: CursorSession = {
    sessionId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    stream: {
      write: (message) => { written.push(message) },
      end: () => undefined,
      frames: async function* () { for (const payload of messages) yield { flags: 0, payload } },
      destroy: () => { closed = true },
      isClosed: () => closed,
      onTerminal: () => () => undefined,
    },
    frames: (async function* () { for (const payload of messages) yield { flags: 0, payload } })(),
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 1,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: { env: { workspace_paths: ["/tmp"] } },
    allowTools: false,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    pumpActive: false,
    pumpOwner: null,
    heartbeat: null,
    heartbeatCancel: null,
    hardDeadlineTimer: null,
    semanticDeadlineCancel: null,
    terminalUnsubscribe: null,
    deferredTerminalReason: null,
    policy: { semanticIdleMs: 120_000, hardCapMs: 600_000, heartbeatMs: 5_000 },
    createdAt: Date.now(),
    lastInboundAt: Date.now(),
    lastHeartbeatWriteAt: Date.now(),
    semanticDeadlineAt: Date.now() + 120_000,
    closeError: null,
    closed: false,
  }
  return session
}

test("holds a Cursor tool Run open and returns its result on the same stream", async () => {
  const written: Uint8Array[] = []
  const session = runFrames([
    encodeMessage("AgentServerMessage", { exec_server_message: { id: 7, mcp_args: {
      name: `${legacyHost}-echo`, provider_identifier: legacyHost, tool_name: "echo",
    } } }),
    encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
  ], written)
  session.toolDescriptors = [{ name: `${legacyHost}-echo`, provider_identifier: legacyHost, tool_name: "echo" }]
  session.permittedToolNames = new Set(["echo"])
  session.allowTools = true
  const parts: LanguageModelV3StreamPart[] = []
  let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  const stream = new ReadableStream<LanguageModelV3StreamPart>({ start(value) { controller = value } })
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
  controller.close()
  for await (const part of stream) parts.push(part)
  const tool = parts.find((part) => part.type === "tool-call")
  expect(tool).toMatchObject({ toolName: "echo", toolCallId: expect.stringContaining("_7") })
  expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } })
  expect(session.closed).toBe(false)
  if (tool?.type !== "tool-call") throw new Error("Cursor did not emit its host tool")
  expect(deliverContinuationResults(session, [{ toolCallId: tool.toolCallId, sessionId: session.sessionId,
    execId: 7, toolName: "echo", output: "done" }])).toBe(session)
  expect(written).toHaveLength(2)
  expect(decodeMessage("AgentClientMessage", written[0])).toMatchObject({
    exec_client_message: { id: 7, mcp_result: { success: { content: [{ text: { text: "done" } }] } } },
  })
  expect(decodeMessage("AgentClientMessage", written[1])).toMatchObject({
    exec_client_control_message: { stream_close: { id: 7 } },
  })
  const ending: LanguageModelV3StreamPart[] = []
  let endController!: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  const endStream = new ReadableStream<LanguageModelV3StreamPart>({ start(value) { endController = value } })
  await pump(session, endController, { textId: "text-2", reasoningId: "reasoning-2" })
  endController.close()
  for await (const part of endStream) ending.push(part)
  expect(ending.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
  expect(session.closed).toBe(true)
})

test("streams Cursor reasoning and text with exact raw usage without replaying visible output", async () => {
  const session = runFrames([
    encodeMessage("AgentServerMessage", { interaction_update: { thinking_delta: { text: "reason" } } }),
    encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "answer" } } }),
    encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {
      input_tokens: 20, output_tokens: 8, reasoning_tokens: 3, cache_read: 5, cache_write: 2,
    } } }),
  ])
  const parts: LanguageModelV3StreamPart[] = []
  const stream = new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
    return pump(session, controller, { textId: "text", reasoningId: "reasoning" })
      .then(() => controller.close(), (error: unknown) => controller.error(error))
  } })
  for await (const part of stream) parts.push(part)
  expect(parts.map((part) => part.type)).toEqual([
    "reasoning-start", "reasoning-delta", "reasoning-end", "text-start", "text-delta", "text-end", "finish",
  ])
  expect(parts.at(-1)).toMatchObject({
    type: "finish", finishReason: { unified: "stop" },
    providerMetadata: { cursor: { inputTokensRaw: 20, outputTokensRaw: 8, reasoningTokensRaw: 3 } },
  })
  expect(buildLanguageModelV3UsageFromTurnEnded({
    input_tokens: 20, output_tokens: 8, reasoning_tokens: 3, cache_read: 5, cache_write: 2,
  })).toMatchObject({ inputTokens: { total: 20, cacheRead: 5, cacheWrite: 2 }, outputTokens: { total: 8, reasoning: 3 } })
  expect(session.closed).toBe(true)
})

test("treats a missing Cursor turn-end as an interrupted Run and retains trailing tool results", async () => {
  const session = runFrames([
    encodeMessage("AgentServerMessage", { interaction_update: { thinking_delta: { text: "visible" } } }),
  ])
  let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  const stream = new ReadableStream<LanguageModelV3StreamPart>({ start(value) { controller = value } })
  const parts: LanguageModelV3StreamPart[] = []
  const failure = await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    .then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ name: "CursorRunInterruptedError", replaySafe: false })
  controller.close()
  for await (const part of stream) parts.push(part)
  expect(parts.map((part) => part.type)).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end"])
  expect(extractTrailingToolResults([
    { role: "tool", content: [{ type: "tool-result", toolCallId: "cursor_run-1_7", toolName: "read", output: { type: "text", value: "ok" } }] },
  ])).toMatchObject([{ execId: 7, output: "ok" }])
})

test("uses YCoding project configuration and Session headers at the Cursor host boundary", () => {
  const root = "/tmp/ycoding-cursor-host"
  expect(ycodingProjectConfigDirs(root).at(-1)).toBe(`${root}/.ycoding`)
  expect(ycodingProjectConfigDirs(root)).not.toContain(expect.stringContaining(legacyProjectDir))
  expect(ycodingGlobalConfigDirs()).not.toContain(expect.stringContaining(legacyHost))
  expect(ycodingConfigFileNames()).toEqual(["ycoding.json", "ycoding.jsonc"])
  expect(ycodingSessionKey({ prompt: [], headers: { "x-ycoding-session": "session-1" } })).toBe("session-1")
  expect(resolveSessionWorkspaceRoot({ headers: { "x-ycoding-directory": root }, workspaceRoot: "/tmp/other" })).toBe(root)
})

test("discovers ancestor YCoding configuration before the selected workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-ancestor-"))
  const nested = path.join(root, "nested")
  try {
    await mkdir(path.join(root, ".ycoding"))
    await mkdir(path.join(nested, ".ycoding"), { recursive: true })
    await writeFile(path.join(root, ".ycoding", "ycoding.json"), JSON.stringify({
      instructions: ["ancestor.md"], mcp: { servers: { ancestor: {} } },
    }))
    await writeFile(path.join(nested, ".ycoding", "ycoding.json"), JSON.stringify({
      instructions: ["selected.md"], mcp: { servers: { selected: {} } },
    }))
    expect(ycodingProjectConfigDirs(nested)).toEqual(expect.arrayContaining([
      path.join(root, ".ycoding"), path.join(nested, ".ycoding"),
    ]))
    expect((await loadMergedConfig(nested)).instructions).toEqual(["ancestor.md", "selected.md"])
    expect(await loadMergedConfig(nested)).toMatchObject({ mcp: { servers: { ancestor: {}, selected: {} } } })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("does not read project Cursor context when YCoding project discovery is disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-disabled-"))
  const prior = process.env.YCODING_DISABLE_PROJECT_CONFIG
  try {
    await mkdir(path.join(root, ".ycoding"))
    await writeFile(path.join(root, ".ycoding", "ycoding.json"), JSON.stringify({ instructions: ["disabled.md"] }))
    process.env.YCODING_DISABLE_PROJECT_CONFIG = "true"
    expect((await loadMergedConfig(root)).instructions).not.toContain("disabled.md")
  } finally {
    if (prior === undefined) delete process.env.YCODING_DISABLE_PROJECT_CONFIG
    else process.env.YCODING_DISABLE_PROJECT_CONFIG = prior
    await rm(root, { recursive: true, force: true })
  }
})

test("advertises only subagents supplied by the permission-filtered executor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-subagents-"))
  try {
    await mkdir(path.join(root, ".ycoding", "agent"), { recursive: true })
    await mkdir(path.join(root, ".ycoding", "skills", "private"), { recursive: true })
    await writeFile(path.join(root, ".ycoding", "agent", "unavailable.md"), "# Not permitted this turn")
    await writeFile(path.join(root, ".ycoding", "skills", "private", "SKILL.md"), "---\ndescription: Activate explicitly\n---\nUnactivated private instruction")
    const unknown = await buildDynamicRequestContext({
      workspaceRoot: root,
      tools: [{ name: "subagent", description: "Spawn a configured agent", inputSchema: { type: "object" } }],
    })
    expect(unknown.custom_subagents).toEqual([])
    expect(unknown.custom_subagents_info_complete).toBe(false)
    const skills: unknown = unknown.agent_skills
    const privateSkill = Array.isArray(skills)
      ? skills.filter((entry: unknown): entry is { full_path: string; description?: string; content?: string } =>
        typeof entry === "object" && entry !== null && "full_path" in entry &&
        typeof entry.full_path === "string").find((entry) => entry.full_path.endsWith("/private/SKILL.md"))
      : undefined
    expect(privateSkill?.description).toBe("Activate explicitly")
    expect(privateSkill?.content).toBeUndefined()
    expect(JSON.stringify(unknown.agent_skills)).not.toContain("Unactivated private instruction")
    expect(unknown.agent_skills_info_complete).toBe(false)
    const reply = decodeMessageSparse<{ exec_client_message: { request_context_result: { success: {
      request_context: { agent_skills: { full_path: string; description: string; content?: string }[] },
    } } } }>("AgentClientMessage", buildRequestContextResult(9, unknown))
    const wireSkill = reply.exec_client_message.request_context_result.success.request_context.agent_skills
      .find((entry) => entry.full_path.endsWith("/private/SKILL.md"))
    expect(wireSkill?.description).toBe("Activate explicitly")
    expect(wireSkill?.content).toBeUndefined()
    const filtered = await buildDynamicRequestContext({
      workspaceRoot: root,
      tools: [{ name: "subagent", description: "Available subagents:\n- scout: Read-only research", inputSchema: { type: "object" } }],
    })
    expect(filtered.custom_subagents).toMatchObject([{ name: "scout", description: "Read-only research" }])
    expect(filtered.custom_subagents_info_complete).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("discovers YCoding configuration without consulting legacy project configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-config-"))
  const prior = process.env[legacyConfigFlag]
  try {
    await mkdir(path.join(root, ".ycoding"))
    await mkdir(path.join(root, legacyProjectDir))
    await mkdir(path.join(root, ".ycoding", "plugin"))
    await writeFile(path.join(root, ".ycoding", "plugin", "local.js"), "export default {}")
    await writeFile(path.join(root, ".ycoding", "ycoding.json"), JSON.stringify({
      instructions: ["native.md"],
      plugins: [{ package: "host-plugin" }],
      mcp: { servers: { demo: {} } },
    }))
    await writeFile(path.join(root, ".ycoding", "ycoding.jsonc"), '{ "instructions": ["native-jsonc.md",], }')
    await writeFile(path.join(root, legacyProjectDir, `${legacyHost}.json`), JSON.stringify({ instructions: ["legacy.md"] }))
    process.env[legacyConfigFlag] = "1"
    const config = await loadMergedConfig(root)
    expect(config.instructions).toContain("native.md")
    expect(config.instructions).toContain("native-jsonc.md")
    expect(config.instructions).not.toContain("legacy.md")
    const layout = await collectProjectLayout(root)
    expect(layout.children_dirs.map((entry: { abs_path: string }) => path.basename(entry.abs_path))).toContain(".ycoding")
    expect(layout.children_dirs.map((entry: { abs_path: string }) => path.basename(entry.abs_path))).not.toContain(legacyProjectDir)
    const dynamic = await buildDynamicRequestContext({
      workspaceRoot: root,
      tools: [{ name: "demo_lookup", inputSchema: { type: "object" } }],
    })
    expect(dynamic.hooks_additional_context).toContain("ycoding-plugin:npm:host-plugin")
    expect(dynamic.hooks_additional_context).toContain("ycoding-plugin:local:local")
    expect(dynamic.mcp_file_system_options).toMatchObject({
      mcp_descriptors: [{ server_identifier: "demo", tools: [{ tool_name: "lookup" }] }],
    })
  } finally {
    if (prior === undefined) delete process.env[legacyConfigFlag]
    else process.env[legacyConfigFlag] = prior
    await rm(root, { recursive: true, force: true })
  }
})

const resolve = (info: CatalogModel.Info, observed: LanguageModelV3CallOptions[] = []) =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: (id: string) =>
          ({
            specificationVersion: "v3",
            provider: info.providerID,
            modelId: id,
            supportedUrls: {},
            doGenerate: () => Promise.reject(new Error("Unexpected non-streaming request")),
            doStream: (options) => {
              observed.push(options)
              return Promise.resolve({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  start(controller) {
                    if (observed.length === 1)
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: "read_1",
                        toolName: "read",
                        input: '{"path":"a.ts"}',
                      })
                    controller.enqueue({
                      type: "finish",
                      finishReason: { unified: observed.length === 1 ? "tool-calls" : "stop", raw: "stop" },
                      usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 0, text: 0, reasoning: 0 },
                      },
                    })
                    controller.close()
                  },
                }),
              })
            },
          }) satisfies LanguageModelV3,
      }
    })
    return yield* SessionRunnerModel.fromCatalogModel(info, undefined, { loadAISDK: aisdk.model })
  })

it.effect("appends one stable Cursor SYSTEM instruction on the actual SDK and seed wire boundaries", () =>
  Effect.gen(function* () {
    const observed: LanguageModelV3CallOptions[] = []
    const model = yield* resolve(cursor, observed)
    const hint = new CacheHint({ type: "ephemeral", ttlSeconds: 300 })
    const request = LLM.request({
      model,
      system: [
        { type: "text", text: "Stable agent instructions", cache: hint },
        { type: "text", text: "Repository instructions" },
      ],
      messages: [Message.user("Read a.ts")],
      tools: [read],
      toolChoice: "auto",
    })
    const response = yield* LLMClient.generate(request).pipe(Effect.provide(client))
    expect(response.toolCalls).toMatchObject([{ id: "read_1", name: "read", input: { path: "a.ts" } }])
    yield* LLMClient.generate(
      LLM.updateRequest(request, {
        messages: [
          ...request.messages,
          Message.assistant(response.toolCalls),
          Message.tool({ id: "read_1", name: "read", result: { type: "text", value: "File contents" } }),
        ],
      }),
    ).pipe(Effect.provide(client))

    expect(observed).toHaveLength(2)
    const system = observed[0].prompt.find((part) => part.role === "system")
    expect(system).toBeDefined()
    if (!system) throw new Error("Missing initial SYSTEM message")
    expect(system.content.startsWith("Stable agent instructions\n\nRepository instructions\n\n")).toBe(true)
    expect(system.content.split(identity)).toHaveLength(2)
    expect(system.content).toContain("Do not claim to be Cursor")
    expect(system.content).toContain("Follow user instructions strictly")
    expect(system.content).toContain("subject to higher-priority instructions, permissions, and guardrails")
    expect(system.content).toContain("when the user's task requires it and the action is authorized")
    expect(system.content).toContain("Do not perform unrelated availability probes")
    expect(system.content).toContain("A permission denial is not evidence that a capability is unavailable")
    expect(system.content).toContain("Never invent tool or MCP capabilities")
    expect(system.providerOptions).toBeUndefined()
    expect(observed[1].prompt.filter((part) => part.role === "system")).toEqual([system])
    expect(
      JSON.stringify(observed.flatMap((options) => options.prompt.filter((part) => part.role !== "system"))),
    ).not.toContain(identity)
    expect(observed[0].tools).toEqual([
      {
        type: "function",
        name: "read",
        description: read.description,
        inputSchema: read.inputSchema,
      },
    ])
    expect(observed[1].tools).toEqual(observed[0].tools)
    expect(observed[0].toolChoice).toEqual({ type: "auto" })
    expect(observed[1].toolChoice).toEqual(observed[0].toolChoice)
    expect(observed[1].prompt.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "read_1", output: { type: "text", value: "File contents" } }],
    })
    expect(request.system.map((part) => part.text)).toEqual(["Stable agent instructions", "Repository instructions"])
    expect(request.system[0].cache).toEqual(hint)
    expect((yield* LLMClient.prepare<LanguageModelV3CallOptions>(request)).body.prompt[0]).toEqual(system)

    const seed = decodeMessage<{ root_prompt_messages_json: string[] }>(
      "ConversationStateStructure",
      buildSeedConversationState({
        systemPrompt: system.content,
        history: extractPromptHistory(observed[0].prompt),
      }),
    )
    expect(seed.root_prompt_messages_json).toEqual([JSON.stringify({ role: "system", content: system.content })])
  }),
)

it.effect("supplies a Cursor SYSTEM instruction without an existing system or Cursor provider label", () =>
  Effect.gen(function* () {
    const model = yield* resolve(CatalogModel.Info.make({ ...cursor, providerID: Provider.ID.make("custom-cursor") }))
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(LLM.request({ model, prompt: "Hello" }))
    expect(prepared.body.prompt[0]).toMatchObject({ role: "system", content: expect.stringContaining(identity) })
    expect(prepared.body.prompt[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "Hello" }] })
  }),
)

it.effect("does not add Cursor instructions to another package even when its provider is named Cursor", () =>
  Effect.gen(function* () {
    const model = yield* resolve(CatalogModel.Info.make({ ...cursor, package: Provider.aisdk("@ai-sdk/groq") }))
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model,
        system: "Stable agent instructions",
        messages: [Message.user("Read a.ts")],
        tools: [read],
      }),
    )
    expect(model.route.id).toBe("ai-sdk:@ai-sdk/groq")
    expect(prepared.body.prompt[0]).toEqual({ role: "system", content: "Stable agent instructions" })
    expect(prepared.body.tools?.map((tool) => tool.name)).toEqual(["read"])
    expect(JSON.stringify(prepared.body)).not.toContain(identity)
  }),
)
