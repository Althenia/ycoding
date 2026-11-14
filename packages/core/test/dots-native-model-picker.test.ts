import { describe, expect } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Model } from "@ycoding-ai/schema/model"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { NativeDots } from "@ycoding-ai/core/dots/native"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { httpClient } from "@ycoding-ai/core/effect/app-node-platform"
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
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { testEffect } from "./lib/effect"

interface NativeModelEntry {
  readonly id: string
  readonly providerID: string
  readonly name?: string
  readonly profile?: string
  readonly active?: boolean
  readonly variants?: readonly string[]
  readonly isDefault?: boolean
}

type PickerChannel = NativeDots.Channel & {
  readonly models: () => Promise<readonly NativeModelEntry[]>
  readonly createRoot: (input: {
    readonly inputID: string
    readonly directory: string
    readonly title?: string
    readonly model?: Model.Ref
  }) => Promise<NativeDots.RootSnapshot>
  readonly prompt: (input: {
    readonly rootID: string
    readonly inputID: string
    readonly text: string
    readonly delivery: "steer" | "queue"
    readonly model?: Model.Ref
  }) => Promise<{ readonly messageID: string }>
  readonly selectModel?: (input: { readonly rootID: string; readonly model: Model.Ref }) => Promise<NativeDots.RootSnapshot>
  readonly defaultModel?: () => Promise<Model.Ref | undefined>
  readonly setDefaultModel?: (model: Model.Ref) => Promise<Model.Ref>
}

interface CapturedRequest {
  readonly path: string
  readonly method: string
  readonly authorization: string | null
  readonly body: unknown
}

const it = testEffect(Layer.empty)

const providerID = Provider.ID.make("custom-openai")
const otherProviderID = Provider.ID.make("other-provider")
const modelID = CatalogModel.ID.make("shared-model")

const alphaProfile = "profile-alpha"
const betaProfile = "profile-beta"
const nonexistentProfile = "nonexistent-profile"

const modelRef = (
  targetProvider: Provider.ID,
  options: { readonly profile?: string; readonly variant?: string } = {},
) =>
  CatalogModel.Ref.make({
    providerID: targetProvider,
    id: modelID,
    ...(options.profile === undefined ? {} : { profile: Model.ProfileName.make(options.profile) }),
    ...(options.variant === undefined ? {} : { variant: CatalogModel.VariantID.make(options.variant) }),
  })

const localOnlyHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (real) =>
    HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return real.execute(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ models: [] }, { status: 404 })))
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer))

const sseCompletion = (text: string) =>
  [
    `data: ${JSON.stringify({
      id: "chatcmpl-synthetic",
      object: "chat.completion.chunk",
      created: 1780429944,
      model: modelID,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      usage: null,
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-synthetic",
      object: "chat.completion.chunk",
      created: 1780429944,
      model: modelID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n"

const setup = Effect.gen(function* () {
  const tmpRoot = realpathSync(
    yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "dots-native-model-picker-"))),
  )
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(tmpRoot, { recursive: true, force: true })))

  const workDir = AbsolutePath.make(path.join(tmpRoot, "work"))
  const globalConfigDir = path.join(tmpRoot, "config")
  const globalDataDir = path.join(tmpRoot, "data")
  const globalCacheDir = path.join(tmpRoot, "cache")
  const globalStateDir = path.join(tmpRoot, "state")
  yield* Effect.promise(() =>
    Promise.all([
      mkdir(workDir, { recursive: true }),
      mkdir(globalConfigDir, { recursive: true }),
      mkdir(globalDataDir, { recursive: true }),
      mkdir(globalCacheDir, { recursive: true }),
      mkdir(globalStateDir, { recursive: true }),
    ]),
  )
  yield* Effect.promise(() =>
    writeFile(
      path.join(globalConfigDir, "ycoding.json"),
      JSON.stringify({ dots: { enabled: true, profile: "trusted" } }),
    ),
  )

  const requests: CapturedRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [] })
      }
      const rawBody = request.method === "POST" ? await request.text() : ""
      const body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined
      requests.push({
        path: url.pathname,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body,
      })
      if (url.pathname === "/v1/chat/completions") {
        return new Response(sseCompletion("Synthetic inference reply"), {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        })
      }
      return new Response("Not found", { status: 404 })
    },
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
  const baseURL = `http://127.0.0.1:${server.port}/v1`

  const rootLayer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      KV.node,
      Global.node,
      FSUtil.node,
      Config.globalNode,
      Credential.node,
      DotsAccess.node,
      EventRuntime.node,
      Project.node,
      SessionStore.node,
      Session.node,
      SessionExecution.node,
      SessionAutonomy.node,
      SessionOrchestration.node,
      SessionReview.node,
      LocationServiceMap.node,
      Job.node,
    ]),
    [
      [
        Global.node,
        Global.layerWith({
          home: workDir,
          config: globalConfigDir,
          data: globalDataDir,
          cache: globalCacheDir,
          state: globalStateDir,
        }),
      ],
      [httpClient, localOnlyHttpClient],
      [
        ModelsDev.node,
        ModelsDev.configured({
          file: path.join(import.meta.dir, "plugin/fixtures/models-dev-priced.json"),
          fetch: false,
        }),
      ],
      [
        KeepAwake.node,
        Layer.mock(KeepAwake.Service, {
          hold: () => Effect.succeed({ state: "off" as const }),
          release: () => Effect.succeed({ state: "off" as const }),
          get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
        }),
      ],
      [
        Decision.node,
        Layer.mock(Decision.Service, {
          evaluate: (input) =>
            Effect.succeed(
              Schema.decodeUnknownSync(Decision.Output)({
                provider: "agent",
                response: {
                  model: { providerID: "test", id: "picker-decision" },
                  semantics: "model-estimate",
                  version: 1,
                  answers: input.request.questions.map((question) => ({
                    name: question.name,
                    type: question.type,
                    answer: question.type === "predicate" ? true : null,
                    choice: null,
                    score: null,
                    confidence: 0.9,
                  })),
                },
              }),
            ),
        }),
      ],
      [
        Project.node,
        Layer.mock(Project.Service, {
          list: () =>
            Effect.succeed([
              { id: Project.ID.global, worktree: workDir, sandboxes: [], time: { created: 0, updated: 0 } },
            ]),
          resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
          directories: () => Effect.succeed([{ directory: workDir }]),
          recordOpened: () => Effect.void,
        }),
      ],
    ],
  )

  const context = yield* Layer.build(rootLayer)
  const db = Context.get(context, Database.Service)
  const credentials = Context.get(context, Credential.Service)
  const access = Context.get(context, DotsAccess.Service)
  const sessions = Context.get(context, Session.Service)
  const execution = Context.get(context, SessionExecution.Service)
  const locations = Context.get(context, LocationServiceMap.Service)

  const trusted = yield* credentials.create({
    integrationID: Integration.ID.make("openai"),
    label: "trusted",
    value: Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("chatgpt-browser"),
      access: "tok-trusted",
      refresh: "refresh-trusted",
      expires: Date.now() + 3_600_000,
      metadata: { accountID: "acct-trusted" },
    }),
  })
  yield* access.set({ enabled: true, expectedRevision: 0 })

  const credBeta = yield* credentials.create({
    integrationID: Integration.ID.make(providerID),
    label: betaProfile,
    value: Credential.Key.make({ type: "key", key: "tok-beta" }),
  })
  const credAlpha = yield* credentials.create({
    integrationID: Integration.ID.make(providerID),
    label: alphaProfile,
    value: Credential.Key.make({ type: "key", key: "tok-alpha" }),
  })
  yield* credentials.activate(credAlpha.id)

  const workLocation = Location.Ref.make({ directory: workDir })
  const configureLocationCatalog = Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const catalog = yield* Catalog.Service
    yield* integrations.transform((draft) => {
      draft.update(Integration.ID.make(providerID), (item) => {
        item.name = "Custom OpenAI"
      })
    })
    const alphaModel = CatalogModel.Info.make({
      ...CatalogModel.Info.empty(providerID, modelID),
      name: "Shared Model",
      package: Provider.aisdk("@ai-sdk/openai-compatible"),
      settings: { baseURL },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 128000, output: 4096 },
      variants: [
        { id: CatalogModel.VariantID.make("low") },
        { id: CatalogModel.VariantID.make("medium") },
      ],
    })
    const betaModel = CatalogModel.Info.make({
      ...CatalogModel.Info.empty(providerID, modelID),
      name: "Shared Model",
      package: Provider.aisdk("@ai-sdk/openai-compatible"),
      settings: { baseURL },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 128000, output: 4096 },
      variants: [{ id: CatalogModel.VariantID.make("high"), settings: { reasoningEffort: "high" } }],
    })
    yield* catalog.transform((draft) => {
      draft.provider.update(providerID, (provider) => {
        provider.name = "Custom OpenAI"
        provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
        provider.settings = { baseURL }
      })
      draft.model.account.update(credAlpha, providerID, [alphaModel])
      draft.model.account.update(credBeta, providerID, [betaModel])
      draft.provider.update(otherProviderID, (provider) => {
        provider.name = "Other Provider"
        provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
        provider.settings = { baseURL, apiKey: "tok-other" }
      })
      draft.model.update(otherProviderID, modelID, (model) => {
        model.name = "Shared Model"
        model.enabled = true
        model.capabilities = { tools: true, input: ["text"], output: ["text"] }
        model.limit = { context: 64000, output: 2048 }
        model.variants = [{ id: CatalogModel.VariantID.make("fast") }]
      })
      draft.model.default.set(providerID, modelID, {
        profile: betaProfile,
        variant: CatalogModel.VariantID.make("high"),
      })
    })
  })
  yield* configureLocationCatalog.pipe(Effect.provide(locations.get(workLocation, [LocationServiceMap.full])))

  const baseRoot = yield* sessions.create({ location: workLocation })
  const pins: NativeDots.Pins = {
    accessRevision: 1,
    profile: "trusted",
    credentialID: trusted.id,
    accountID: "acct-trusted",
    accountGeneration: 0,
    environmentID: "env-synthetic",
    connectionID: "conn-synthetic",
    isCurrent: () => true,
  }

  let connectionIndex = 0
  const attachChannel = () =>
    Effect.gen(function* () {
      const host = yield* NativeDots.live.pipe(Effect.provideContext(context))
      const connection = yield* Effect.promise(() =>
        host.attach({ ...pins, connectionID: `conn-${++connectionIndex}` }),
      )
      const channel = connection.channel({ clientID: "client-picker", streamID: `stream-${connectionIndex}` }) as PickerChannel
      return { host, connection, channel }
    })

  const initial = yield* attachChannel()

  const readRow = (sessionID: Session.ID) =>
    db.db
      .select({
        model: SessionTable.model,
        profileBinding: SessionTable.profile_binding,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)

  const resolveModelForSession = (sessionID: Session.ID) =>
    Effect.gen(function* () {
      const session = yield* sessions.get(sessionID)
      const models = yield* SessionRunnerModel.Service
      return yield* models.resolve(session)
    }).pipe(Effect.provide(locations.get(workLocation, [LocationServiceMap.full])))

  return {
    workDir,
    workLocation,
    db,
    credentials,
    sessions,
    execution,
    locations,
    requests,
    credAlpha,
    credBeta,
    baseRoot,
    host: initial.host,
    connection: initial.connection,
    channel: initial.channel,
    attachChannel,
    configureLocationCatalog,
    readRow,
    resolveModelForSession,
  }
})

const expectProfileRejection = (operation: Promise<unknown>) =>
  Effect.promise(async () => {
    const caught = await operation.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeDefined()
    expect(caught instanceof NativeDots.Error || caught instanceof SessionRunnerModel.ProfileUnavailableError).toBe(true)
  })

describe("NativeDots multi-profile model picker", () => {
  it.live("distinguishes profiles, per-profile variants, default state, and providers sharing one modelID", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const models = yield* Effect.promise(() => f.channel.models())

      const customShared = models.filter((entry) => entry.providerID === providerID && entry.id === modelID)
      expect(customShared).toHaveLength(2)

      const alphaEntry = customShared.find((entry) => entry.profile === alphaProfile)
      const betaEntry = customShared.find((entry) => entry.profile === betaProfile)
      expect(alphaEntry).toBeDefined()
      expect(betaEntry).toBeDefined()
      expect(alphaEntry?.variants).toEqual(["low", "medium"])
      expect(betaEntry?.variants).toEqual(["high"])
      expect(alphaEntry?.active).toBe(true)
      expect(betaEntry?.active).toBe(false)
      expect(Boolean(alphaEntry?.isDefault)).toBe(false)
      expect(betaEntry?.isDefault).toBe(true)

      const otherShared = models.filter((entry) => entry.providerID === otherProviderID && entry.id === modelID)
      expect(otherShared).toHaveLength(1)
      expect(otherShared[0]?.profile).toBeUndefined()
      expect(otherShared[0]?.variants).toEqual(["fast"])
      expect(Boolean(otherShared[0]?.isDefault)).toBe(false)

      expect(JSON.stringify(models)).not.toContain("tok-alpha")
      expect(JSON.stringify(models)).not.toContain("tok-beta")
      expect(JSON.stringify(models)).not.toContain("tok-other")

      expect(typeof f.channel.defaultModel).toBe("function")
      expect(typeof f.channel.setDefaultModel).toBe("function")
      expect(yield* Effect.promise(() => f.channel.defaultModel!())).toBeUndefined()

      const updatedDefault = modelRef(providerID, { profile: alphaProfile, variant: "medium" })
      expect(yield* Effect.promise(() => f.channel.setDefaultModel!(updatedDefault))).toEqual(updatedDefault)
      expect(yield* Effect.promise(() => f.channel.defaultModel!())).toEqual(updatedDefault)
    }),
  )

  it.live("binds explicit profile on createRoot, switches via selectModel/prompt across reload, and never falls back on invalid profile", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const betaRef = modelRef(providerID, { profile: betaProfile, variant: "high" })
      const alphaRef = modelRef(providerID, { profile: alphaProfile, variant: "low" })

      const created = yield* Effect.promise(() =>
        f.channel.createRoot({
          directory: f.workDir,
          inputID: "create-beta",
          model: betaRef,
        }),
      )
      const rootID = created.session.id
      expect(created.selectedModel).toEqual(betaRef)

      const initialRow = yield* f.readRow(rootID)
      expect(initialRow?.model).toEqual(betaRef)
      expect(initialRow?.profileBinding).toMatchObject({
        providerID,
        profile: betaProfile,
        credentialID: f.credBeta.id,
        accountGeneration: f.credBeta.accountGeneration,
      })

      expect(typeof f.channel.selectModel).toBe("function")
      const switched = yield* Effect.promise(() => f.channel.selectModel!({ rootID, model: alphaRef }))
      expect(switched.selectedModel).toEqual(alphaRef)

      const switchedRow = yield* f.readRow(rootID)
      expect(switchedRow?.model).toEqual(alphaRef)
      expect(switchedRow?.profileBinding).toMatchObject({
        providerID,
        profile: alphaProfile,
        credentialID: f.credAlpha.id,
        accountGeneration: f.credAlpha.accountGeneration,
      })

      f.connection.retire()
      yield* f.locations.invalidate(f.workLocation)
      yield* f.configureLocationCatalog.pipe(Effect.provide(f.locations.get(f.workLocation, [LocationServiceMap.full])))
      const reloaded = yield* f.attachChannel()

      const reloadedSnapshot = yield* Effect.promise(() => reloaded.channel.getRoot(rootID))
      expect(reloadedSnapshot?.selectedModel).toEqual(alphaRef)
      const reloadedRead = yield* Effect.promise(() => reloaded.channel.readRoot(rootID))
      expect(reloadedRead.selectedModel).toEqual(alphaRef)

      const requestsBeforePrompt = f.requests.length
      const admittedPrompt = yield* Effect.promise(() =>
        reloaded.channel.prompt({
          rootID,
          inputID: "prompt-switch-beta",
          text: "Run with beta profile",
          delivery: "queue",
          model: betaRef,
        }),
      )
      yield* f.execution.awaitIdle(rootID)
      expect(yield* f.sessions.pending(rootID)).toEqual([])
      const afterPromptRead = yield* Effect.promise(() => reloaded.channel.readRoot(rootID))
      expect(afterPromptRead.selectedModel).toEqual(betaRef)
      expect(afterPromptRead.messages.filter((item) => item.type === "user").map((item) => String(item.id))).toEqual([
        admittedPrompt.messageID,
      ])
      expect(f.requests.length).toBe(requestsBeforePrompt + 1)
      expect(f.requests[requestsBeforePrompt]?.authorization).toBe("Bearer tok-beta")

      const promptRow = yield* f.readRow(rootID)
      expect(promptRow?.model).toEqual(betaRef)
      expect(promptRow?.profileBinding).toMatchObject({
        providerID,
        profile: betaProfile,
        credentialID: f.credBeta.id,
      })

      const rootsBeforeNegative = (yield* Effect.promise(() => reloaded.channel.listRoots())).map((item) => item.session.id)
      const defaultBeforeNegative = yield* Effect.promise(() => reloaded.channel.defaultModel!())
      const nonexistentRef = modelRef(providerID, { profile: nonexistentProfile })

      yield* expectProfileRejection(
        reloaded.channel.createRoot({
          directory: f.workDir,
          inputID: "create-nonexistent",
          model: nonexistentRef,
        }),
      )
      expect((yield* Effect.promise(() => reloaded.channel.listRoots())).map((item) => item.session.id)).toEqual(
        rootsBeforeNegative,
      )

      yield* expectProfileRejection(reloaded.channel.selectModel!({ rootID, model: nonexistentRef }))
      expect((yield* Effect.promise(() => reloaded.channel.getRoot(rootID)))?.selectedModel).toEqual(betaRef)
      expect((yield* f.readRow(rootID))?.profileBinding).toMatchObject({
        profile: betaProfile,
        credentialID: f.credBeta.id,
      })

      yield* expectProfileRejection(
        reloaded.channel.prompt({
          rootID,
          inputID: "prompt-nonexistent",
          text: "Must never admit",
          delivery: "queue",
          model: nonexistentRef,
        }),
      )
      yield* f.execution.awaitIdle(rootID)
      expect(yield* f.sessions.pending(rootID)).toEqual([])
      const afterRejectedRead = yield* Effect.promise(() => reloaded.channel.readRoot(rootID))
      expect(afterRejectedRead.selectedModel).toEqual(betaRef)
      expect(afterRejectedRead.messages.filter((item) => item.type === "user").map((item) => String(item.id))).toEqual([
        admittedPrompt.messageID,
      ])
      expect(f.requests.length).toBe(requestsBeforePrompt + 1)
      expect((yield* f.readRow(rootID))?.profileBinding).toMatchObject({
        profile: betaProfile,
        credentialID: f.credBeta.id,
      })

      expect(typeof reloaded.channel.setDefaultModel).toBe("function")
      yield* expectProfileRejection(reloaded.channel.setDefaultModel!(nonexistentRef))
      expect(yield* Effect.promise(() => reloaded.channel.defaultModel!())).toEqual(defaultBeforeNegative)
    }),
  )

  it.live("routes actual HTTP inference through the bound profile credential and updates on profile switch", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const alphaRef = modelRef(providerID, { profile: alphaProfile, variant: "low" })
      const betaRef = modelRef(providerID, { profile: betaProfile, variant: "high" })

      const created = yield* Effect.promise(() =>
        f.channel.createRoot({
          directory: f.workDir,
          inputID: "e2e-alpha-root",
          model: alphaRef,
        }),
      )
      const rootID = created.session.id

      const resolvedAlpha = yield* f.resolveModelForSession(rootID)
      expect(resolvedAlpha.ref).toEqual(alphaRef)
      expect(resolvedAlpha.profileBinding).toMatchObject({
        profile: alphaProfile,
        credentialID: f.credAlpha.id,
      })

      yield* Effect.promise(() =>
        f.channel.prompt({
          rootID,
          inputID: "e2e-prompt-alpha",
          text: "Hello alpha",
          delivery: "steer",
        }),
      )
      yield* f.execution.awaitIdle(rootID)

      expect(f.requests).toHaveLength(1)
      expect(f.requests[0]?.path).toBe("/v1/chat/completions")
      expect(f.requests[0]?.authorization).toBe("Bearer tok-alpha")
      expect(f.requests[0]?.authorization).not.toBe("Bearer tok-beta")

      expect(typeof f.channel.selectModel).toBe("function")
      yield* Effect.promise(() => f.channel.selectModel!({ rootID, model: betaRef }))

      const resolvedBeta = yield* f.resolveModelForSession(rootID)
      expect(resolvedBeta.ref).toEqual(betaRef)
      expect(resolvedBeta.profileBinding).toMatchObject({
        profile: betaProfile,
        credentialID: f.credBeta.id,
      })

      yield* Effect.promise(() =>
        f.channel.prompt({
          rootID,
          inputID: "e2e-prompt-beta",
          text: "Hello beta",
          delivery: "steer",
        }),
      )
      yield* f.execution.awaitIdle(rootID)

      expect(f.requests).toHaveLength(2)
      expect(f.requests[1]?.path).toBe("/v1/chat/completions")
      expect(f.requests[1]?.authorization).toBe("Bearer tok-beta")
      expect(f.requests[1]?.authorization).not.toBe("Bearer tok-alpha")

      yield* Effect.promise(() =>
        f.channel.prompt({
          rootID,
          inputID: "e2e-prompt-inline-alpha",
          text: "Hello inline alpha",
          delivery: "steer",
          model: alphaRef,
        }),
      )
      yield* f.execution.awaitIdle(rootID)

      expect(f.requests).toHaveLength(3)
      expect(f.requests[2]?.path).toBe("/v1/chat/completions")
      expect(f.requests[2]?.authorization).toBe("Bearer tok-alpha")
      expect(f.requests[2]?.authorization).not.toBe("Bearer tok-beta")
    }),
  )
})
