import { describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { NativeDots } from "@ycoding-ai/core/dots/native"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Integration } from "@ycoding-ai/core/integration"
import { Job } from "@ycoding-ai/core/job"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { KV } from "@ycoding-ai/core/kv"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { CatalogModel } from "@ycoding-ai/core/model"
import { ModelsDev } from "@ycoding-ai/core/models-dev"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Model } from "@ycoding-ai/schema/model"
import { Session as SessionSchema } from "@ycoding-ai/schema/session"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { createRemoteControlAppServer, type RemoteControlBackend, type RemoteControlModel } from "../src/remote-control/app-server"
import { remoteControlTransport } from "../src/remote-control/bootstrap"
import { createRemoteControlHost } from "../src/remote-control/host"
import { connectRemoteControlSocket } from "../src/remote-control/socket"
import { createRemoteControlStateStore } from "../src/remote-control/state"
import { unavailableConversation } from "./fixture/cca-scope"
import { requestBackend, sessionInfo } from "./remote-control-fixture"

// Exact ChatGPT.app / app.asar predicates (`FQih.eE`, `OeLR.Y$`, `OeLR.bo`, `OeLR.cc`, `OeLR.pd`, `Xvtr.a`)
const validChatGptEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"])
const fqihEe = (effort: string) => validChatGptEfforts.has(effort)
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function oelrResolveProfile(config: Record<string, unknown>) {
  const profiles = isPlainObject(config.profiles) ? config.profiles : null
  const active = typeof config.profile === "string" && profiles && isPlainObject(profiles[config.profile])
    ? profiles[config.profile] as Record<string, unknown>
    : null
  if (!active) return config
  const merged = { ...config }
  for (const [k, v] of Object.entries(active)) {
    if (v != null) merged[k] = v
  }
  return merged
}

function oelrBo(config: Record<string, unknown> | null | undefined) {
  return typeof config?.model_catalog_json === "string" && config.model_catalog_json.trim().length > 0
}

function oelrCc(config: Record<string, unknown> | null | undefined) {
  const t = config?.model_provider
  const n = isPlainObject(config?.model_providers) ? config.model_providers : null
  return typeof t === "string" && n !== null && Object.hasOwn(n, t)
}

function oelrPd(model: string, effort: string, profile: string | null = null) {
  const prefix = profile ? `profiles.${profile}.` : ""
  return {
    edits: [
      { keyPath: `${prefix}model`, value: model, mergeStrategy: "upsert" },
      { keyPath: `${prefix}model_reasoning_effort`, value: effort, mergeStrategy: "upsert" },
    ],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  }
}

type WireModel = {
  id: string
  model: string
  displayName: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
  defaultReasoningEffort: string | null
  providerId?: string
  profile?: string
  modelSpecialty?: string
  availableAccessPrograms?: { cyber?: string[] }
}

function xvtrA(input: {
  additionalAvailableModels?: Set<string>
  apiKeyDaybreakSupported?: boolean
  authMethod: string | null
  availableModels: Set<string>
  defaultModel: string | null
  enabledReasoningEfforts: Set<string>
  hasConfiguredModelCatalog: boolean
  includeUltraReasoningEffort: boolean
  isCustomModelProvider: boolean
  models: WireModel[]
  useHiddenModels: boolean
}) {
  const {
    additionalAvailableModels,
    apiKeyDaybreakSupported = false,
    authMethod,
    availableModels,
    defaultModel,
    enabledReasoningEfforts,
    hasConfiguredModelCatalog,
    includeUltraReasoningEffort,
    isCustomModelProvider = false,
    models,
    useHiddenModels,
  } = input
  const p: WireModel[] = []
  let h: WireModel | null = null
  const hasModelSupportingMaxReasoningEffort = models.some((e) =>
    e.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === "max"),
  )
  const hasModelSupportingUltraReasoningEffort = includeUltraReasoningEffort && models.some((e) =>
    e.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === "ultra"),
  )
  models.forEach((a) => {
    const l = a.availableAccessPrograms?.cyber
    const keep =
      (authMethod !== "apikey" || !!apiKeyDaybreakSupported || l == null || !(l.length > 0) || !!l.includes("standard")) &&
      (
        additionalAvailableModels?.has(a.model) === true ||
        (
          a.model !== "codex-auto-review" &&
          (
            (hasConfiguredModelCatalog && !a.hidden) ||
            (
              useHiddenModels && !isCustomModelProvider && authMethod !== "amazonBedrock"
                ? (availableModels.has(a.model) || (authMethod === "apikey" && apiKeyDaybreakSupported && !a.hidden && l?.some((e) => e !== "standard") === true))
                : !a.hidden
            )
          )
        )
      )
    if (keep) {
      const e = includeUltraReasoningEffort
        ? a.supportedReasoningEfforts
        : a.supportedReasoningEfforts.filter(({ reasoningEffort }) => reasoningEffort !== "ultra")
      const t = (authMethod === "copilot"
        ? [e.find((item) => item.reasoningEffort === "medium") ?? { reasoningEffort: "medium", description: "medium effort" }]
        : e
      ).filter(({ reasoningEffort }) => fqihEe(reasoningEffort) && enabledReasoningEfforts.has(reasoningEffort))
      const i = { ...a, supportedReasoningEfforts: t }
      p.push(i)
      if (a.isDefault) h = i
    }
  })
  if (h == null) h = p.find((e) => e.model === defaultModel) ?? null
  return {
    models: p,
    defaultModel: h,
    hasModelSupportingMaxReasoningEffort,
    hasModelSupportingUltraReasoningEffort,
  }
}

async function rpc(server: ReturnType<typeof createRemoteControlAppServer>, method: string, params: unknown = {}, id: unknown = 1) {
  const reply = await server.handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  return reply === undefined ? undefined : JSON.parse(reply)
}

async function openServer(server: ReturnType<typeof createRemoteControlAppServer>) {
  expect((await rpc(server, "initialize", { clientInfo: { name: "Codex Desktop" }, capabilities: {} })).error).toBeUndefined()
  await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
}

function createPersistentPickerFixture(initialDefault?: Model.Ref) {
  const catalogModels: RemoteControlModel[] = [
    {
      id: "gemini-4-hydrogen",
      providerID: "antigravity",
      name: "Gemini 4 Hydrogen",
      profile: "alpha",
      active: true,
      variants: ["low", "medium", "high"],
    },
    {
      id: "gemini-4-hydrogen",
      providerID: "antigravity",
      name: "Gemini 4 Hydrogen",
      profile: "beta",
      active: false,
      variants: ["low", "medium", "high"],
    },
  ]
  let currentDefault: Model.Ref | undefined = initialDefault
  const threads = new Map<string, { session: SessionSchema.Info; selectedModel?: Model.Ref }>()
  const prompts: Array<{ threadID: string; text: string; delivery: "steer" | "queue"; model?: Model.Ref }> = []
  let threadCounter = 0

  const snapshotOf = (id: string): NativeDots.RootSnapshot => {
    const entry = threads.get(id)!
    return { session: entry.session, selectedModel: entry.selectedModel, active: false, waiting: [] }
  }

  const validate = (model: Model.Ref) => {
    const match = catalogModels.find(
      (item) => item.id === model.id && item.providerID === model.providerID && item.profile === model.profile,
    )
    if (!match) throw new Error("Unknown model or profile")
    if (model.variant !== undefined && !match.variants?.includes(model.variant)) {
      throw new Error("Unsupported reasoning effort")
    }
    return model
  }

  const makeBackend = (): RemoteControlBackend => ({
    ...requestBackend,
    createThread: async ({ location, title, model }) => {
      if (location.directory !== "/work/repo") throw new Error("Unrecorded directory")
      const chosen = model ?? currentDefault
      if (chosen) validate(chosen)
      const id = `ses_picker_${++threadCounter}`
      const session = sessionInfo({ id, title: title ?? "Picker", directory: location.directory })
      threads.set(id, { session: { ...session, ...(chosen ? { model: chosen } : {}) }, selectedModel: chosen })
      return snapshotOf(id)
    },
    getThread: async (id) => (threads.has(id) ? snapshotOf(id) : undefined),
    listThreads: async () => [...threads.keys()].map((id) => snapshotOf(id)),
    readThread: async (id) => {
      if (!threads.has(id)) throw new Error("Thread unavailable")
      return { ...snapshotOf(id), messages: [] }
    },
    selectModel: async (rootID, model) => {
      const entry = threads.get(rootID)
      if (!entry) throw new Error("Thread unavailable")
      const validated = validate(model)
      entry.selectedModel = validated
      entry.session = { ...entry.session, model: validated }
      return snapshotOf(rootID)
    },
    defaultModel: async () => currentDefault,
    setDefaultModel: async (model) => {
      currentDefault = validate(model)
      return currentDefault
    },
    prompt: async (threadID, input) => {
      const entry = threads.get(threadID)
      if (!entry) throw new Error("Thread unavailable")
      if (input.model) {
        const validated = validate(input.model)
        entry.selectedModel = validated
        entry.session = { ...entry.session, model: validated }
      }
      prompts.push({ threadID, text: input.text, delivery: input.delivery, ...(input.model ? { model: input.model } : {}) })
      return { messageID: `msg_${prompts.length}` }
    },
    interrupt: async () => {},
    models: async () => catalogModels,
    skills: async () => [],
    account: async () => ({ profile: "Work" }),
  })

  const startServer = () => createRemoteControlAppServer({
    backend: makeBackend(),
    codexHome: "/h",
    requestScope: "picker",
    send: () => {},
  })

  return { startServer, prompts, threads, getDefault: () => currentDefault }
}

describe("remote-control ChatGPT model picker contract", () => {
  test("ChatGPT.app Xvtr.a + OeLR.cc + OeLR.pd keeps both alpha and beta non-OpenAI profiles visible with distinct identity and single default", async () => {
    const f = createPersistentPickerFixture(Model.Ref.parse("alpha#antigravity/gemini-4-hydrogen#medium"))
    const server = f.startServer()
    await openServer(server)

    const configReply = await rpc(server, "config/read", { includeLayers: false, cwd: null }, 2)
    expect(configReply.error).toBeUndefined()
    const effectiveConfig = oelrResolveProfile(configReply.result.config)
    expect(oelrCc(effectiveConfig)).toBe(true)
    expect(oelrBo(effectiveConfig)).toBe(false)
    expect(effectiveConfig).toEqual({
      model_provider: "ycoding",
      model_providers: { ycoding: { name: "YCoding" } },
      model: "alpha#antigravity/gemini-4-hydrogen",
      model_reasoning_effort: "medium",
    })

    const listReply = await rpc(server, "model/list", { includeHidden: true, cursor: null, limit: 100 }, 3)
    expect(listReply.error).toBeUndefined()
    const wireModels = listReply.result.data as WireModel[]
    expect(wireModels).toHaveLength(2)

    const xvtrResult = xvtrA({
      additionalAvailableModels: new Set(),
      authMethod: "chatgpt",
      availableModels: new Set(["gpt-5.5"]),
      defaultModel: "gpt-5.5",
      enabledReasoningEfforts: new Set(["low", "medium", "high", "xhigh", "persistent"]),
      hasConfiguredModelCatalog: oelrBo(effectiveConfig),
      includeUltraReasoningEffort: true,
      isCustomModelProvider: oelrCc(effectiveConfig),
      models: wireModels,
      useHiddenModels: true,
    })

    expect(xvtrResult.models).toHaveLength(2)
    expect(new Set(xvtrResult.models.map((m) => m.id))).toEqual(
      new Set(["alpha#antigravity/gemini-4-hydrogen", "beta#antigravity/gemini-4-hydrogen"]),
    )
    expect(new Set(xvtrResult.models.map((m) => m.model))).toEqual(
      new Set(["alpha#antigravity/gemini-4-hydrogen", "beta#antigravity/gemini-4-hydrogen"]),
    )
    expect(new Set(xvtrResult.models.map((m) => m.displayName))).toEqual(
      new Set(["Gemini 4 Hydrogen (antigravity · alpha)", "Gemini 4 Hydrogen (antigravity · beta)"]),
    )
    for (const model of xvtrResult.models) {
      expect(model.hidden).toBe(false)
      expect(Array.isArray(model.supportedReasoningEfforts)).toBe(true)
      expect(model.supportedReasoningEfforts.map((item) => item.reasoningEffort)).toEqual(["low", "medium", "high"])
      expect(model.defaultReasoningEffort).toBe("medium")
      expect(model.providerId).toBe("antigravity")
    }
    expect(xvtrResult.models.filter((m) => m.isDefault).map((m) => m.model)).toEqual(["alpha#antigravity/gemini-4-hydrogen"])
    expect(xvtrResult.defaultModel?.model).toBe("alpha#antigravity/gemini-4-hydrogen")

    const withoutCustomProvider = xvtrA({
      additionalAvailableModels: new Set(),
      authMethod: "chatgpt",
      availableModels: new Set(["gpt-5.5"]),
      defaultModel: "gpt-5.5",
      enabledReasoningEfforts: new Set(["low", "medium", "high"]),
      hasConfiguredModelCatalog: false,
      includeUltraReasoningEffort: true,
      isCustomModelProvider: false,
      models: wireModels,
      useHiddenModels: true,
    })
    expect(withoutCustomProvider.models).toEqual([])
    server.retire()
  })

  test("config/batchWrite updates default model and effort across config/read, model/list, and thread/start, and rejects invalid profiles", async () => {
    const f = createPersistentPickerFixture(Model.Ref.parse("alpha#antigravity/gemini-4-hydrogen#low"))
    const server = f.startServer()
    await openServer(server)

    const writeOk = await rpc(server, "config/batchWrite", oelrPd("beta#antigravity/gemini-4-hydrogen", "high"), 2)
    expect(writeOk.error).toBeUndefined()

    const configAfter = await rpc(server, "config/read", {}, 3)
    expect(configAfter.result.config).toEqual({
      model_provider: "ycoding",
      model_providers: { ycoding: { name: "YCoding" } },
      model: "beta#antigravity/gemini-4-hydrogen",
      model_reasoning_effort: "high",
    })

    const listAfter = (await rpc(server, "model/list", {}, 4)).result.data as WireModel[]
    expect(listAfter.filter((m) => m.isDefault).map((m) => m.model)).toEqual(["beta#antigravity/gemini-4-hydrogen"])
    expect(listAfter.find((m) => m.profile === "alpha")?.isDefault).toBe(false)

    const startedDefault = await rpc(server, "thread/start", { cwd: "/work/repo" }, 5)
    expect(startedDefault.error).toBeUndefined()
    expect(startedDefault.result.model).toBe("beta#antigravity/gemini-4-hydrogen")
    expect(startedDefault.result.modelProvider).toBe("antigravity")
    expect(startedDefault.result.reasoningEffort).toBe("high")

    for (const badParams of [
      oelrPd("missing#antigravity/gemini-4-hydrogen", "high"),
      oelrPd("antigravity/gemini-4-hydrogen", "high", "missing"),
      { edits: [{ keyPath: "approval_policy", value: "never", mergeStrategy: "upsert" }] },
    ]) {
      const bad = await rpc(server, "config/batchWrite", badParams, 6)
      expect(bad.error?.code).toBe(-32602)
    }

    expect((await rpc(server, "config/read", {}, 7)).result.config).toEqual({
      model_provider: "ycoding",
      model_providers: { ycoding: { name: "YCoding" } },
      model: "beta#antigravity/gemini-4-hydrogen",
      model_reasoning_effort: "high",
    })
    expect(((await rpc(server, "model/list", {}, 8)).result.data as WireModel[]).filter((m) => m.isDefault).map((m) => m.model)).toEqual([
      "beta#antigravity/gemini-4-hydrogen",
    ])
    server.retire()
  })

  test("thread/start, thread/settings/update, thread/resume, turn/start, and turn/steer preserve exact profile identity across reload and reject conflicts", async () => {
    const f = createPersistentPickerFixture(Model.Ref.parse("alpha#antigravity/gemini-4-hydrogen#low"))
    const server1 = f.startServer()
    await openServer(server1)

    const started = await rpc(server1, "thread/start", {
      cwd: "/work/repo",
      model: "alpha#antigravity/gemini-4-hydrogen",
      effort: "low",
    }, 2)
    expect(started.error).toBeUndefined()
    const threadId = started.result.thread.id as string
    expect(started.result.model).toBe("alpha#antigravity/gemini-4-hydrogen")
    expect(started.result.reasoningEffort).toBe("low")

    const updated = await rpc(server1, "thread/settings/update", {
      threadId,
      model: "beta#antigravity/gemini-4-hydrogen",
      effort: "high",
    }, 3)
    expect(updated.error).toBeUndefined()
    server1.retire()

    const server2 = f.startServer()
    await openServer(server2)
    const resumedBeta = await rpc(server2, "thread/resume", { threadId, excludeTurns: true }, 4)
    expect(resumedBeta.error).toBeUndefined()
    expect(resumedBeta.result.model).toBe("beta#antigravity/gemini-4-hydrogen")
    expect(resumedBeta.result.modelProvider).toBe("antigravity")
    expect(resumedBeta.result.reasoningEffort).toBe("high")
    expect(resumedBeta.result.thread.model).toBe("beta#antigravity/gemini-4-hydrogen")

    const turnNoProvider = await rpc(server2, "turn/start", {
      threadId,
      model: "beta#antigravity/gemini-4-hydrogen",
      input: [{ type: "text", text: "run on beta" }],
    }, 5)
    expect(turnNoProvider.error).toBeUndefined()
    expect(f.prompts.at(-1)?.model).toEqual(Model.Ref.parse("beta#antigravity/gemini-4-hydrogen"))

    const steeredAlpha = await rpc(server2, "turn/steer", {
      threadId,
      model: "alpha#antigravity/gemini-4-hydrogen",
      effort: "medium",
      input: [{ type: "text", text: "steer to alpha" }],
    }, 6)
    expect(steeredAlpha.error).toBeUndefined()
    expect(f.prompts.at(-1)?.model).toEqual(Model.Ref.parse("alpha#antigravity/gemini-4-hydrogen#medium"))
    server2.retire()

    const server3 = f.startServer()
    await openServer(server3)
    const resumedAlpha = await rpc(server3, "thread/resume", { threadId, excludeTurns: true }, 7)
    expect(resumedAlpha.error).toBeUndefined()
    expect(resumedAlpha.result.model).toBe("alpha#antigravity/gemini-4-hydrogen")
    expect(resumedAlpha.result.reasoningEffort).toBe("medium")

    for (const [method, params] of [
      ["thread/start", { cwd: "/work/repo", model: "beta#antigravity/gemini-4-hydrogen", modelProvider: "openai" }],
      ["thread/resume", { threadId, excludeTurns: true, model: "beta#antigravity/gemini-4-hydrogen", modelProvider: "openai" }],
      ["thread/settings/update", { threadId, model: "beta#antigravity/gemini-4-hydrogen", modelProvider: "openai" }],
      ["turn/start", { threadId, model: "beta#antigravity/gemini-4-hydrogen", modelProvider: "openai", input: [{ type: "text", text: "conflict" }] }],
      ["turn/steer", { threadId, model: "beta#antigravity/gemini-4-hydrogen", modelProvider: "openai", input: [{ type: "text", text: "conflict" }] }],
      ["turn/start", { threadId, modelProvider: "antigravity", input: [{ type: "text", text: "missing model" }] }],
      ["turn/start", { threadId, model: "missing#antigravity/gemini-4-hydrogen", input: [{ type: "text", text: "unknown profile" }] }],
    ] as const) {
      const rejected = await rpc(server3, method, params, 8)
      expect(rejected.error?.code).toBe(-32602)
    }
    expect((await rpc(server3, "thread/read", { threadId }, 9)).result.thread.model).toBe("alpha#antigravity/gemini-4-hydrogen")
    server3.retire()
  })
})

async function bounded<A>(promise: Promise<A>, label: string, ms = 10_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const sseReply = (text: string) =>
  [
    `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")

const loopbackTest = testEffect(Layer.empty)

loopbackTest.live("NativeDots.live + real SQLite + KV + WebSocket loopback routes inference to the chosen profile credential", () => Effect.gen(function* () {
  const base = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir("ycoding-native-model-picker-")),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  )
  const configDir = path.join(base.path, "config")
  const dataDir = path.join(base.path, "data")
  const stateDir = path.join(base.path, "state")
  const cacheDir = path.join(base.path, "cache")
  const tmpDir = path.join(base.path, "tmp")
  const repoDir = path.join(base.path, "repo")
  yield* Effect.promise(() => Promise.all([
    fs.mkdir(configDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(cacheDir, { recursive: true }),
    fs.mkdir(tmpDir, { recursive: true }),
    fs.mkdir(repoDir, { recursive: true }),
  ]))
  yield* Effect.promise(() => fs.writeFile(
    path.join(configDir, "ycoding.json"),
    JSON.stringify({ dots: { enabled: true, profile: "dots-host" } }),
  ))
  yield* Effect.promise(() => fs.writeFile(path.join(repoDir, "ycoding.json"), "{}"))

  const inferenceCalls: Array<{ authorization: string | null; model: unknown }> = []
  const inferenceServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const authorization = request.headers.get("authorization")
      const body = await request.json() as { model?: unknown }
      inferenceCalls.push({ authorization, model: body.model })
      return new Response(sseReply(`reply:${authorization ?? "none"}`), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => inferenceServer.stop(true)))

  const providerID = Provider.ID.make("synthetic-compat")
  const modelID = CatalogModel.ID.make("gemini-4-hydrogen")
  const repoLocation = Location.Ref.make({ directory: AbsolutePath.make(repoDir) })
  const runtimeLayer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      KV.node,
      Global.node,
      FSUtil.node,
      EventRuntime.node,
      Config.globalNode,
      Credential.node,
      DotsAccess.node,
      Session.node,
      SessionStore.node,
      SessionExecution.node,
      SessionReview.node,
      SessionOrchestration.node,
      Project.node,
      LocationServiceMap.node,
      Job.node,
    ]),
    [
      [Database.node, Database.configured({ path: path.join(base.path, "ycoding.sqlite") })],
      [Global.node, Global.layerWith({ home: base.path, config: configDir, data: dataDir, state: stateDir, cache: cacheDir, tmp: tmpDir })],
      [ModelsDev.node, Layer.succeed(ModelsDev.Service, ModelsDev.Service.of({ get: () => Effect.succeed([]), refresh: () => Effect.void }))],
      [KeepAwake.node, Layer.mock(KeepAwake.Service, {
        hold: () => Effect.succeed({ state: "off" as const }),
        release: () => Effect.succeed({ state: "off" as const }),
        get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
      })],
      [Decision.node, Layer.mock(Decision.Service, {
        evaluate: (input: Decision.Input) => Effect.succeed(Schema.decodeUnknownSync(Decision.Output)({
          provider: "agent",
          response: {
            model: { providerID: "test", id: "loopback-decision" },
            semantics: "model-estimate",
            version: 1,
            answers: input.request.questions.map((question) => ({
              name: question.name,
              type: question.type,
              answer: question.type === "predicate" ? true : null,
              choice: question.type === "choice" ? question.choices[0]?.value ?? null : null,
              score: null,
              confidence: 0.7,
            })),
          },
        })),
      })],
      [Project.node, Layer.mock(Project.Service, {
        list: () => Effect.succeed([{ id: Project.ID.global, worktree: AbsolutePath.make(repoDir), sandboxes: [], time: { created: 0, updated: 0 } }]),
        resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
        directories: () => Effect.succeed([{ directory: AbsolutePath.make(repoDir) }]),
        recordOpened: () => Effect.void,
      })],
    ],
  )

  yield* Effect.gen(function* () {
    const access = yield* DotsAccess.Service
    const credentials = yield* Credential.Service
    const locations = yield* LocationServiceMap.Service
    const execution = yield* SessionExecution.Service
    const sessions = yield* Session.Service

    yield* credentials.create({
      integrationID: Integration.ID.make("openai"),
      label: "dots-host",
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-browser"),
        access: "synthetic-dots-access",
        refresh: "synthetic-dots-refresh",
        expires: Date.now() + 3_600_000,
        metadata: { accountID: "synthetic-dots-account" },
      }),
    })
    yield* access.set({ enabled: true, expectedRevision: 0 })

    yield* credentials.create({
      integrationID: Integration.ID.make(providerID),
      label: "alpha",
      value: Credential.Key.make({ type: "key", key: "secret-token-alpha" }),
    })
    yield* credentials.create({
      integrationID: Integration.ID.make(providerID),
      label: "beta",
      value: Credential.Key.make({ type: "key", key: "secret-token-beta" }),
    })

    yield* Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const agents = yield* Agent.Service
      yield* integrations.transform((draft) => {
        draft.update(Integration.ID.make(providerID), (item) => {
          item.name = "Synthetic Compat"
        })
      })
      yield* catalog.transform((draft) => {
        draft.provider.update(providerID, (item) => {
          item.name = "Synthetic Compat"
          item.package = Provider.aisdk("@ai-sdk/openai-compatible")
          item.settings = { baseURL: `http://127.0.0.1:${inferenceServer.port}/v1` }
        })
        draft.model.update(providerID, modelID, (item) => {
          item.name = "Gemini 4 Hydrogen"
          item.enabled = true
          item.limit = { context: 128_000, output: 4_096 }
          item.variants = [
            { id: CatalogModel.VariantID.make("low") },
            { id: CatalogModel.VariantID.make("medium") },
            { id: CatalogModel.VariantID.make("high") },
          ]
        })
      })
      yield* agents.transform((draft) => {
        draft.update(Agent.defaultID, (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
        })
      })
    }).pipe(Effect.provide(locations.get(repoLocation, [LocationServiceMap.full])))

    yield* sessions.create({ location: repoLocation })

    const native = yield* NativeDots.live
    const frames: Array<{ type: string; stream_id: string; message: Record<string, unknown> }> = []
    const listeners = new Set<() => void>()
    const connected = Promise.withResolvers<ServerWebSocket<undefined>>()
    const wsServer = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response(null, { status: 404 })),
      websocket: {
        open: (socket) => connected.resolve(socket),
        message: (_socket, text) => {
          const frame = JSON.parse(String(text)) as { type: string; stream_id: string; message: Record<string, unknown> }
          if (frame.type !== "server_message") return
          frames.push(frame)
          for (const listener of listeners) listener()
        },
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => wsServer.stop(true)))

    const host = createRemoteControlHost({
      native,
      store: createRemoteControlStateStore(path.join(base.path, "remote-control.json")),
      codexHome: base.path,
      hostname: () => "loopback-picker",
      fetchFn: async () => Response.json({
        server_id: "loopback-server",
        environment_id: "loopback-env",
        remote_control_token: "loopback-token",
      }),
      connect: (_url, headers) => connectRemoteControlSocket(`ws://127.0.0.1:${wsServer.port}`, headers),
    })
    const unavailableComputer = async () => ({ state: "unavailable" as const, problem: "configuration" as const })
    const unregister = native.attachTransport(
      remoteControlTransport(
        host.status,
        { computer: unavailableComputer, attach: unavailableComputer, detach: unavailableComputer, remove: unavailableComputer },
        unavailableConversation,
      ),
    )
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      unregister()
      await host.shutdown()
      await Effect.runPromise(execution.shutdown)
    }))

    yield* Effect.promise(() => host.start())
    const peer = yield* Effect.promise(() => bounded(connected.promise, "WebSocket connection"))
    let seq = 0
    let reqID = 0
    const send = (message: unknown) =>
      peer.send(JSON.stringify({
        type: "client_message",
        client_id: "loopback-client",
        stream_id: "picker-stream",
        env_id: "loopback-env",
        seq_id: seq++,
        message,
      }))
    const wait = (matches: (frame: (typeof frames)[number]) => boolean, label: string) => {
      const existing = frames.find(matches)
      if (existing) return Promise.resolve(existing)
      const pending = Promise.withResolvers<(typeof frames)[number]>()
      const check = () => {
        const found = frames.find(matches)
        if (found) pending.resolve(found)
      }
      listeners.add(check)
      return bounded(pending.promise, label).finally(() => listeners.delete(check))
    }
    const call = async (method: string, params: Record<string, unknown> = {}) => {
      const id = ++reqID
      send({ jsonrpc: "2.0", id, method, params })
      return (await wait((frame) => frame.message.id === id, method)).message as {
        id: number
        result?: Record<string, any>
        error?: { code: number; message: string }
      }
    }

    yield* Effect.promise(async () => {
      expect((await call("initialize", { clientInfo: { name: "Codex Desktop" } })).error).toBeUndefined()
      send({ jsonrpc: "2.0", method: "initialized" })

      const listed = await call("model/list", { includeHidden: true, cursor: null, limit: 100 })
      expect(listed.error).toBeUndefined()
      const wireModels = listed.result!.data as WireModel[]
      expect(wireModels.map((m) => m.model).toSorted()).toEqual([
        "alpha#synthetic-compat/gemini-4-hydrogen",
        "beta#synthetic-compat/gemini-4-hydrogen",
      ])

      const batchWrite = await call("config/batchWrite", oelrPd("alpha#synthetic-compat/gemini-4-hydrogen", "low"))
      expect(batchWrite.error).toBeUndefined()
      expect((await call("config/read")).result!.config).toEqual({
        model_provider: "ycoding",
        model_providers: { ycoding: { name: "YCoding" } },
        model: "alpha#synthetic-compat/gemini-4-hydrogen",
        model_reasoning_effort: "low",
      })

      const started = await call("thread/start", { cwd: repoDir })
      expect(started.error).toBeUndefined()
      expect(started.result!.model).toBe("alpha#synthetic-compat/gemini-4-hydrogen")
      expect(started.result!.reasoningEffort).toBe("low")
      const threadId = started.result!.thread.id as string

      const turn1Mark = frames.length
      const turn1 = await call("turn/start", { threadId, input: [{ type: "text", text: "Ping alpha" }] })
      expect(turn1.error).toBeUndefined()
      const done1 = await wait(
        (frame) => frames.indexOf(frame) >= turn1Mark && frame.message.method === "turn/completed",
        "alpha turn/completed",
      )
      expect((done1.message.params as { turn: { status: string } }).turn.status).toBe("completed")
      expect(inferenceCalls).toEqual([{ authorization: "Bearer secret-token-alpha", model: "gemini-4-hydrogen" }])

      const switched = await call("thread/settings/update", {
        threadId,
        model: "beta#synthetic-compat/gemini-4-hydrogen",
        effort: "high",
      })
      expect(switched.error).toBeUndefined()
      const readAfterSwitch = await call("thread/read", { threadId })
      expect(readAfterSwitch.result!.thread.model).toBe("beta#synthetic-compat/gemini-4-hydrogen")
      expect(readAfterSwitch.result!.thread.reasoningEffort).toBe("high")

      const turn2Mark = frames.length
      const turn2 = await call("turn/start", { threadId, input: [{ type: "text", text: "Ping beta" }] })
      expect(turn2.error).toBeUndefined()
      const done2 = await wait(
        (frame) => frames.indexOf(frame) >= turn2Mark && frame.message.method === "turn/completed",
        "beta turn/completed",
      )
      expect((done2.message.params as { turn: { status: string } }).turn.status).toBe("completed")
      expect(inferenceCalls).toEqual([
        { authorization: "Bearer secret-token-alpha", model: "gemini-4-hydrogen" },
        { authorization: "Bearer secret-token-beta", model: "gemini-4-hydrogen" },
      ])
    })
  }).pipe(Effect.provide(runtimeLayer))
}), 30_000)
