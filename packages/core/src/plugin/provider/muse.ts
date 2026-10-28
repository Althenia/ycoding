import { define } from "../catalog-host"
import type { IntegrationOAuthMethodRegistration } from "@ycoding-ai/plugin/effect/integration"
import { Clock, Effect, Option, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AISDK } from "../../aisdk"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { EventRuntime } from "../../event"
import { Integration } from "../../integration"
import { CatalogModel } from "../../model"
import { settingsForEffort } from "../../models-dev"
import { LocationAnnouncements } from "../../location-announcements"
import { Provider } from "../../provider"
import { ProviderUsage, ProviderUsageRuntime } from "../../provider-usage"
import { MuseUsage } from "../../provider-usage/muse"
import { SessionRunnerModel } from "../../session/runner/model"
import type { PluginCatalogHost } from "../catalog-host"

const integrationID = Integration.ID.make("muse")
const providerID = Provider.ID.make("muse")
const methodID = Integration.MethodID.make("device")
const clientID = "1031625952748946"
const baseURL = "https://api.meta.ai/v1"
const processSessionID = crypto.randomUUID()
const reconnect =
  "Muse account token expired or was rejected; log in again: run ycoding, then /connect and choose Muse (Meta)."

const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Unknown),
})
const Token = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})
const Mint = Schema.Struct({
  api_key: Schema.optional(Schema.String),
  base_url: Schema.optional(Schema.String),
  require_payment: Schema.optional(Schema.Boolean),
  action_url: Schema.optional(Schema.NullOr(Schema.String)),
  is_subs_active: Schema.optional(Schema.Boolean),
  subs_tier_name: Schema.optional(Schema.String),
})
const ModelRow = Schema.Struct({
  id: Schema.String,
  metadata: Schema.Struct({
    "muse-code": Schema.Struct({
      name: Schema.optional(Schema.String),
      family: Schema.optional(Schema.String),
      release_date: Schema.optional(Schema.String),
      is_hidden: Schema.optional(Schema.Boolean),
      tool_call: Schema.optional(Schema.Boolean),
      modalities: Schema.Struct({ input: Schema.Array(Schema.String), output: Schema.Array(Schema.String) }),
      limit: Schema.optional(Schema.Struct({ context: Schema.Int, output: Schema.Int })),
      options: Schema.optional(Schema.Struct({ reasoningEffort: Schema.optional(Schema.String) })),
      variants: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ reasoningEffort: Schema.String }))),
    }),
  }),
})
const decodeRow = Schema.decodeUnknownOption(ModelRow)
const decodeBody = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
type MintedKey = { readonly api_key: string; readonly base_url: string }
type Fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>

export function observeMuseUsage(response: Response, usage: ProviderUsageRuntime.Interface, profileKey?: string) {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
    return response
  const decoder = new TextDecoder()
  let pending = ""
  const observeLine = (line: string) => {
    if (!line.startsWith("data:") || !line.includes("response.subscription_usage")) return
    const event = Option.getOrUndefined(decodeBody(line.slice(5).trim()))
    const snapshot = MuseUsage.normalize(event, Date.now())
    if (!snapshot) {
      Effect.runSync(Effect.logWarning("invalid Muse subscription usage event"))
      return
    }
    if (snapshot.windows.length === 0) return
    Effect.runSync(
      usage.observe(
        new ProviderUsage.Observation({
          providerID: snapshot.providerID,
          label: snapshot.label,
          source: snapshot.source,
          stability: snapshot.stability,
          observedAt: snapshot.updatedAt,
          windows: snapshot.windows,
        }),
        profileKey,
      ),
    )
  }
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          pending += decoder.decode(chunk, { stream: true })
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ""
          for (const line of lines) observeLine(line)
        },
        flush() {
          observeLine(pending + decoder.decode())
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  )
}

export function museOAuth(http: HttpClient.HttpClient) {
  return {
    integrationID,
    method: { id: methodID, type: "oauth", label: "Meta Muse Code account", remote: true },
    authorize: (_inputs: Integration.Inputs) =>
      Effect.gen(function* () {
        const device = yield* HttpClient.filterStatusOk(http)
          .execute(
            HttpClientRequest.post("https://auth.meta.com/oidc/device/authorization/").pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bodyText(
                new URLSearchParams({ client_id: clientID }).toString(),
                "application/x-www-form-urlencoded",
              ),
            ),
          )
          .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Device)))
        const interval =
          typeof device.interval === "number" && Number.isFinite(device.interval) && device.interval > 0
            ? device.interval * 1000
            : 5000
        const deadline = (yield* Clock.currentTimeMillis) + device.expires_in * 1000
        const poll = (wait: number): Effect.Effect<Credential.OAuth, unknown> =>
          Effect.gen(function* () {
            if ((yield* Clock.currentTimeMillis) >= deadline)
              return yield* Effect.fail(new Error("Device authorization failed: expired_token"))
            const response = yield* http.execute(
              HttpClientRequest.post("https://auth.meta.com/oidc/device/token/").pipe(
                HttpClientRequest.acceptJson,
                HttpClientRequest.bodyText(
                  new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    device_code: device.device_code,
                    client_id: clientID,
                  }).toString(),
                  "application/x-www-form-urlencoded",
                ),
              ),
            )
            const token = yield* HttpClientResponse.schemaBodyJson(Token)(response)
            if (response.status >= 200 && response.status < 300 && token.access_token)
              return Credential.OAuth.make({
                type: "oauth",
                methodID,
                access: token.access_token,
                refresh: token.refresh_token ?? "",
                expires:
                  token.expires_in === undefined ? 0 : (yield* Clock.currentTimeMillis) + token.expires_in * 1000,
              })
            if (token.error !== "authorization_pending" && token.error !== "slow_down")
              return yield* Effect.fail(
                new Error(`Device authorization failed${token.error ? `: ${token.error}` : ""}`),
              )
            const next = token.error === "slow_down" ? wait + 5000 : wait
            yield* Effect.sleep(Math.min(next, Math.max(0, deadline - (yield* Clock.currentTimeMillis))))
            return yield* poll(next)
          })
        return {
          mode: "auto" as const,
          url: device.verification_uri_complete ?? device.verification_uri,
          instructions: `Enter code: ${device.user_code}`,
          callback: poll(interval),
        }
      }),
  } satisfies IntegrationOAuthMethodRegistration
}

export const mintMuseKey = Effect.fn("Muse.mintKey")(function* (http: HttpClient.HttpClient, value: Credential.OAuth) {
  if (value.expires !== 0 && value.expires <= (yield* Clock.currentTimeMillis))
    return yield* Effect.fail(new Error(reconnect))
  const response = yield* http.execute(
    HttpClientRequest.post("https://api.meta.ai/muse-code/key").pipe(
      HttpClientRequest.bearerToken(value.access),
      HttpClientRequest.setHeader("x-api-version", "1.0.0"),
      HttpClientRequest.bodyText(JSON.stringify({ onboard: false }), "application/json"),
    ),
  )
  if (response.status === 401 || response.status === 403) return yield* Effect.fail(new Error(reconnect))
  if (response.status < 200 || response.status >= 300)
    return yield* Effect.fail(new Error(`Muse key mint failed: ${response.status}`))
  const minted = yield* HttpClientResponse.schemaBodyJson(Mint)(response).pipe(
    Effect.catch(() => Effect.fail(new Error("Muse key mint returned an invalid response"))),
  )
  if (minted.require_payment === true || minted.is_subs_active === false)
    return yield* Effect.fail(
      new Error(`Muse subscription/payment setup is required${minted.action_url ? `: ${minted.action_url}` : ""}`),
    )
  if (!minted.api_key || !minted.base_url)
    return yield* Effect.fail(new Error("mint response missing api_key or base_url"))
  return { api_key: minted.api_key, base_url: minted.base_url }
})

export const discoverMuseModels = Effect.fn("Muse.discoverModels")(function* (
  http: HttpClient.HttpClient,
  key: MintedKey,
) {
  const response = yield* HttpClient.filterStatusOk(http)
    .execute(
      HttpClientRequest.get(new URL("/muse-code/models", key.base_url).href).pipe(
        HttpClientRequest.bearerToken(key.api_key),
        HttpClientRequest.setHeader("x-client-id", "tbh:exec"),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))))
  return (yield* Effect.forEach(response.data, (row) =>
    Effect.gen(function* () {
      const model = Option.getOrUndefined(decodeRow(row))
      const metadata = model?.metadata["muse-code"]
      if (
        !model ||
        !metadata?.limit ||
        metadata.is_hidden === true ||
        metadata.tool_call === false ||
        !metadata.modalities.output.includes("text")
      ) {
        yield* Effect.logWarning(
          "skipped Muse model row: hidden, non-tool, non-text, or missing integer context/output limits",
        )
        return undefined
      }
      const released = metadata.release_date === undefined ? 0 : Date.parse(metadata.release_date)
      const defaults = { ...settingsForEffort("@ai-sdk/openai", model.id, metadata.options?.reasoningEffort ?? "none") }
      if (metadata.options?.reasoningEffort === undefined) delete defaults.reasoningEffort
      return CatalogModel.Info.make({
        ...CatalogModel.Info.empty(providerID, CatalogModel.ID.make(model.id)),
        name: metadata.name ?? model.id,
        ...(metadata.family ? { family: CatalogModel.Family.make(metadata.family) } : {}),
        package: Provider.aisdk("@ai-sdk/openai"),
        settings: { baseURL: key.base_url, store: false, ...defaults },
        capabilities: { tools: true, input: metadata.modalities.input, output: metadata.modalities.output },
        time: { released: Number.isFinite(released) ? released : 0 },
        limit: metadata.limit,
        variants: Object.entries(metadata.variants ?? {}).map(([id, variant]) => ({
          id: CatalogModel.VariantID.make(id),
          settings: settingsForEffort("@ai-sdk/openai", model.id, variant.reasoningEffort),
        })),
      })
    }),
  )).filter((model) => model !== undefined)
})

export const MusePlugin = define({
  id: "ycoding.provider.muse",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const aisdk = yield* AISDK.Service
    const catalog = yield* Catalog.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const events = yield* EventRuntime.Service
    const usage = yield* ProviderUsageRuntime.Service
    const loading = Semaphore.makeUnsafe(1)
    const keys = new Map<string, Promise<MintedKey>>()
    const loaded: {
      accounts: readonly { snapshot: Integration.Snapshot; models: readonly CatalogModel.Info[] }[]
      source?: string
    } = { accounts: [] }
    const identity = (snapshot: Integration.Snapshot) =>
      snapshot.credential ? JSON.stringify([snapshot.credential.id, snapshot.credential.generation]) : undefined
    const keyFor = async (snapshot: Integration.Snapshot, signal?: AbortSignal): Promise<MintedKey> => {
      const value = snapshot.value
      if (value?.type === "key") return { api_key: value.key, base_url: baseURL }
      if (value?.type !== "oauth")
        throw new Error("Run ycoding, then /connect and choose Muse (Meta), or set META_API_KEY.")
      if (value.expires !== 0 && value.expires <= Date.now()) throw new Error(reconnect)
      const id = identity(snapshot)
      if (!id) throw new Error("Muse account requires a stored credential; run ycoding, then /connect to log in again.")
      const existing = keys.get(id)
      if (existing) return existing
      const pending = Effect.runPromise(mintMuseKey(http, value).pipe(Effect.timeout("10 seconds")), { signal }).catch(
        (cause: unknown) => {
          if (keys.get(id) === pending) keys.delete(id)
          throw cause
        },
      )
      keys.set(id, pending)
      return pending
    }
    const source = Effect.fn(function* () {
      return JSON.stringify([
        (yield* credentials.list(integrationID)).map((credential) => [
          credential.id,
          credential.generation,
          credential.accountGeneration,
        ]),
        process.env.META_API_KEY,
      ])
    })
    const load = Effect.fn("MusePlugin.load")(function* () {
      const fingerprint = yield* source()
      const saved = yield* credentials.list(integrationID)
      const active = saved.length === 0 ? yield* integrations.connection.active(integrationID) : undefined
      const connections = [
        ...saved.map((credential) => ({
          type: "credential" as const,
          id: credential.id,
          label: credential.label,
          active: credential.active,
        })),
        ...(active?.type === "env" ? [active] : []),
      ]
      const previous = loaded.accounts
      let failed = false
      const current = new Set(saved.map((credential) => JSON.stringify([credential.id, credential.generation])))
      for (const id of keys.keys()) if (!current.has(id)) keys.delete(id)
      loaded.accounts = (yield* Effect.forEach(
        connections,
        (connection) =>
          Effect.gen(function* () {
            const snapshot = yield* integrations.connection
              .snapshot(connection)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!snapshot?.value) return undefined
            const models = yield* Effect.tryPromise({
              try: (signal) => keyFor(snapshot, signal),
              catch: (cause) => cause,
            }).pipe(
              Effect.flatMap((key) => discoverMuseModels(http, key)),
              Effect.timeout("10 seconds"),
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to sync Muse models; check the subscription and reconnect Muse if the account token expired",
                ).pipe(Effect.as(undefined)),
              ),
            )
            if (models === undefined) failed = true
            const retained = previous.find((account) =>
              snapshot.credential
                ? account.snapshot.credential?.id === snapshot.credential.id &&
                  account.snapshot.credential.accountGeneration === snapshot.credential.accountGeneration
                : account.snapshot.connection.type === "env" &&
                  account.snapshot.value?.type === "key" &&
                  snapshot.value?.type === "key" &&
                  account.snapshot.value.key === snapshot.value.key,
            )
            return { snapshot, models: models ?? retained?.models ?? [] }
          }),
        { concurrency: "unbounded" },
      )).filter((account) => account !== undefined)
      loaded.source = failed ? undefined : fingerprint
    })
    yield* ctx.integration.transform((draft) => {
      draft.update(integrationID, (integration) => (integration.name = "Muse (Meta)"))
      draft.method.update(museOAuth(http))
      draft.method.update({ integrationID, method: { type: "key", label: "Meta Model API key" } })
      draft.method.update({ integrationID, method: { type: "env", names: ["META_API_KEY"] } })
    })
    yield* catalog.transform((draft) => {
      draft.provider.update(providerID, (provider) => {
        provider.name = "Muse (Meta)"
        provider.package = Provider.aisdk("@ai-sdk/openai")
        provider.integrationID = integrationID
      })
      draft.model.account.clear(providerID)
      const models = new Map(
        loaded.accounts.flatMap((account) => account.models.map((model) => [model.id, model] as const)),
      )
      for (const id of draft.provider.get(providerID)?.models.keys() ?? [])
        if (!models.has(id)) draft.model.remove(providerID, id)
      for (const model of models.values())
        draft.model.update(providerID, model.id, (draft) => Object.assign(draft, structuredClone(model)))
      for (const account of loaded.accounts)
        if (account.snapshot.credential)
          draft.model.account.update(account.snapshot.credential, providerID, account.models)
    })
    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    const reconcile = () =>
      source().pipe(Effect.flatMap((value) => (value === loaded.source ? Effect.void : refresh())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* LocationAnnouncements.initial(ctx.integration.reload().pipe(Effect.andThen(reconcile()))).pipe(
      Effect.andThen(Effect.sleep("60 seconds").pipe(Effect.andThen(reconcile()), Effect.forever)),
      Effect.ignore,
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* aisdk.hook.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== providerID || evt.package !== "@ai-sdk/openai") return
        const snapshot = evt.snapshot ?? {
          connection: { type: "env" as const, name: "META_API_KEY" },
          value:
            typeof evt.options.apiKey === "string"
              ? Credential.Key.make({ type: "key", key: evt.options.apiKey })
              : undefined,
        }
        const send: Fetch = typeof evt.options.fetch === "function" ? evt.options.fetch : fetch
        const profileKey = snapshot.credential
          ? SessionRunnerModel.accountIdentityDigest(snapshot.credential)
          : undefined
        const wrapped: Fetch = async (input, init) => {
          const key = await keyFor(snapshot, init?.signal ?? undefined)
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${key.api_key}`)
          headers.set("x-client-id", "tbh:exec")
          headers.set("x-tbh-session-id", processSessionID)
          headers.set("x-meta-ai-gateway-session-id", processSessionID)
          const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url)
          const endpoint = new URL(`${key.base_url.replace(/\/$/, "")}/responses`)
          url.protocol = endpoint.protocol
          url.host = endpoint.host
          url.pathname = endpoint.pathname
          const response = await send(url.href, { ...init, headers })
          if (response.status !== 401 || snapshot.value?.type !== "oauth")
            return observeMuseUsage(response, usage, profileKey)
          await response.body?.cancel()
          const id = identity(snapshot)!
          const cached = keys.get(id)
          if (cached && (await cached) === key && keys.get(id) === cached) keys.delete(id)
          const renewed = await keyFor(snapshot, init?.signal ?? undefined)
          headers.set("authorization", `Bearer ${renewed.api_key}`)
          const retried = await send(`${renewed.base_url.replace(/\/$/, "")}/responses`, { ...init, headers })
          if (retried.status !== 401) return observeMuseUsage(retried, usage, profileKey)
          await retried.body?.cancel()
          if ((await keys.get(id)) === renewed) keys.delete(id)
          throw new Error(reconnect)
        }
        evt.options.fetch = wrapped
        evt.options.baseURL = baseURL
        evt.options.apiKey = "muse"
        const { createOpenAI } = yield* Effect.promise(() => import("@ai-sdk/openai"))
        evt.sdk = createOpenAI(evt.options)
      }),
    )
    yield* aisdk.hook.language((evt) => {
      if (evt.model.providerID === providerID && evt.model.package === Provider.aisdk("@ai-sdk/openai"))
        evt.language = evt.sdk.responses(evt.model.modelID ?? evt.model.id)
    })
  }),
} satisfies PluginCatalogHost.Contribution)
