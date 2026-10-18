export * as ProviderUsageRuntime from "./provider-usage"
export { ProviderUsage } from "@ycoding-ai/schema/provider-usage"

import { Config } from "./config"
import { Catalog } from "./catalog"
import { Credential } from "./credential"
import { makeLocationNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { Integration } from "./integration"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "@ycoding-ai/schema/provider"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { InstallationVersion } from "./installation/version"
import { createClaudeCodeCredentialStore } from "./plugin/provider/anthropic-claude-code-account"
import { createManagedClaudeCodeCredentialSource } from "./plugin/provider/anthropic-claude-code-login"
import { join } from "node:path"
import { CopilotUsage } from "./provider-usage/copilot"
import { ClaudeUsage } from "./provider-usage/claude"
import { CodexUsage } from "./provider-usage/codex"
import { MetaUsage } from "./provider-usage/meta"
import { MuseUsage } from "./provider-usage/muse"
import { OpenAIUsage } from "./provider-usage/openai"
import { OpenRouterUsage } from "./provider-usage/openrouter"
import { GrokUsage } from "./provider-usage/grok"
import { ZAIUsage } from "./provider-usage/zai"
import { CursorUsage } from "./provider-usage/cursor"
import { SessionRunnerModel } from "./session/runner/model"
import { GoUsage } from "./provider-usage/go"
import { ProviderUsageCache } from "./provider-usage/cache"
import { ProviderUsageForecast } from "./provider-usage/forecast"
import { ProviderUsagePaceAlerts } from "./provider-usage/pace-alerts"
import { UsageForecast } from "@ycoding-ai/schema/usage-forecast"
import { Money } from "@ycoding-ai/schema/money"
import { Location } from "./location"
import { SessionUsageRead, type LocalUsageBin, type LocalSpend } from "./session/usage-read"
import { Database } from "./database/database"

const minute = 60_000

const copilotOrgLogins = new Map<string, string>()

export interface GetInput {
  readonly providerID: Provider.ID
  readonly credentialID?: Credential.ID
  readonly refresh?: boolean
}

export interface Interface {
  readonly get: (input: GetInput) => Effect.Effect<ProviderUsage.Snapshot>
  readonly list: (input?: { readonly refresh?: boolean }) => Effect.Effect<ReadonlyArray<ProviderUsage.Snapshot>>
  readonly observe: (observation: ProviderUsage.Observation, profileSource?: string) => Effect.Effect<void>
  readonly forecast: (input: UsageForecast.Input) => Effect.Effect<UsageForecast.Info>
}

export interface AdapterInput {
  readonly providerID: Provider.ID
  readonly label: string
  readonly credential: Credential.Info
  readonly updatedAt: number
}

export type Adapter = (input: AdapterInput) => Effect.Effect<ProviderUsage.Snapshot, Error>

export interface MakeInput {
  readonly credentials: Pick<Credential.Interface, "all">
  readonly providers: {
    readonly available: () => Effect.Effect<ReadonlyArray<Pick<Provider.Info, "id">>>
  }
  readonly adapters: Readonly<Record<string, Adapter>>
  readonly cache?: ProviderUsageCache.Interface
  readonly ttlMs?: Readonly<Record<string, number>>
  readonly now?: () => number
  readonly alerts?: Pick<ProviderUsagePaceAlerts.Interface, "observe">
  readonly localSpend?: () => Effect.Effect<ReadonlyArray<LocalSpend>, unknown>
  readonly localUsage?: (
    scope: UsageForecast.LocalScope,
    asOf: number,
  ) => Effect.Effect<ReadonlyArray<LocalUsageBin>, unknown>
  readonly accountUnknown?: (refresh?: boolean, cachedOnly?: boolean) => Effect.Effect<ReadonlyArray<ProviderUsage.Snapshot>>
}

const localSpendProviders = new Set(["anthropic", "openai", "opencode", "opencode-go", "xai"])

export function localSpendSnapshots(rows: ReadonlyArray<LocalSpend>, now: number) {
  return rows
    .filter((row) => localSpendProviders.has(row.providerID))
    .toSorted((left, right) => left.providerID.localeCompare(right.providerID))
    .map(
      (row) =>
        new ProviderUsage.Snapshot({
          providerID: row.providerID,
          label:
            row.providerID === "opencode"
              ? "OpenCode Zen"
              : row.providerID === "opencode-go"
                ? "OpenCode Go"
                : providerLabel(row.providerID),
          profile: "YCoding local",
          status: "available",
          source: "local_session",
          stability: "stable",
          updatedAt: Math.max(0, Math.trunc(now)),
          windows: [
            new ProviderUsage.Window({
              id: "today",
              label: "Today",
              unit: "usd",
              ...(row.knownUSD === undefined ? {} : { used: row.knownUSD }),
            }),
          ],
          ...(row.unpricedRequests === 0
            ? {}
            : {
                message:
                  row.pricedRequests === 0
                    ? "Local request prices are unreported"
                    : "Known local spend excludes unreported prices",
              }),
        }),
    )
}

export class RequestError extends Schema.TaggedErrorClass<RequestError>()("ProviderUsage.RequestError", {
  status: Schema.Number.pipe(Schema.optional),
  retryAfter: Schema.Number.pipe(Schema.optional),
}) {}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProviderUsage") {}

export function make(input: MakeInput): Interface {
  const now = input.now ?? Date.now
  const cache = input.cache ?? ProviderUsageCache.make({ now })
  const observations = new Map<string, ProviderUsage.Snapshot>()
  const forecast = ProviderUsageForecast.make()
  const accounts = new WeakMap<ProviderUsage.Snapshot, string>()
  const retain = (snapshot: ProviderUsage.Snapshot, account?: string) =>
    Effect.gen(function* () {
      if (account === undefined) return snapshot
      accounts.set(snapshot, account)
      for (const window of snapshot.windows) {
        const single = new ProviderUsage.Snapshot({ ...snapshot, windows: [window] })
        const semantics = quotaSemantics(snapshot, window)
        forecast.observe({ account, snapshot: single, semantics })
        if (input.alerts) yield* input.alerts.observe({ account, snapshot: single, semantics, now: now() })
      }
      return snapshot
    }).pipe(Effect.catchCause(() => Effect.succeed(snapshot)))

  const unavailable = (
    providerID: Provider.ID,
    status: "unsupported" | "unauthorized" | "error",
    message: string,
    credential?: Credential.Value,
  ) => {
    const chatGPT = providerID === "openai" && credential !== undefined && CodexUsage.isChatGPTCredential(credential)
    return new ProviderUsage.Snapshot({
      providerID,
      label: providerLabel(providerID),
      status,
      source: chatGPT ? "provider_internal_api" : "provider_api",
      stability: chatGPT ? "best_effort" : "stable",
      updatedAt: Math.max(0, Math.trunc(now())),
      windows: [],
      message,
    })
  }

  const credentialsFor = (credentials: ReadonlyArray<Credential.Info>, providerID: Provider.ID) =>
    credentials.filter((item) => item.integrationID === Integration.ID.make(providerID))

  const load = Effect.fnUntraced(function* (
    providerID: Provider.ID,
    candidates: ReadonlyArray<Credential.Info>,
    credentialID: Credential.ID | undefined,
    refresh: boolean | undefined,
    cachedOnly = false,
  ) {
    // With several profiles stored for one provider, quota must follow the requested profile;
    // falling back to the first row would report another account's usage.
    const primary = candidates.find((item) => item.active) ?? candidates[0]
    const selected = credentialID ? candidates.find((item) => item.id === credentialID) : primary
    const profileSource =
      selected &&
      (providerID === "muse" ||
        (selected.value.type === "oauth" &&
          selected.value.metadata?.managed === true &&
          typeof selected.value.metadata.source === "string"))
        ? SessionRunnerModel.accountIdentityDigest(selected)
        : undefined
    const observed = () =>
      profileSource !== undefined
        ? observations.get(`${providerID}:${profileSource}`)
        : credentialID === undefined
          ? observations.get(`${providerID}:`)
          : undefined
    const profiled = Effect.fnUntraced(function* (snapshot: ProviderUsage.Snapshot, bound = true) {
      if (!selected) return snapshot
      const currentCandidates = credentialsFor(yield* input.credentials.all(), providerID)
      const current = currentCandidates.find(
        (credential) =>
          credential.id === selected.id &&
          credential.integrationID === selected.integrationID &&
          credential.accountGeneration === selected.accountGeneration,
      )
      if (!current) return unavailable(providerID, "unsupported", "Provider usage account changed during refresh")
      const value =
        currentCandidates.length > 1 && current.label
          ? new ProviderUsage.Snapshot({
              providerID: snapshot.providerID,
              label: snapshot.label,
              profile: current.label,
              status: snapshot.status,
              source: snapshot.source,
              stability: snapshot.stability,
              updatedAt: snapshot.updatedAt,
              windows: snapshot.windows,
              ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
            })
          : snapshot
      return yield* retain(value, bound ? SessionRunnerModel.accountIdentityDigest(current) : undefined)
    })

    const current = observed()
    if (!refresh && current) return yield* profiled(current, profileSource !== undefined)

    const adapter = input.adapters[providerID]
    if (!adapter) return unavailable(providerID, "unsupported", "Provider usage is unsupported")
    if (!selected) {
      if (current) return current
      return providerID === "muse" && credentialID === undefined
        ? MuseUsage.unreported(now())
        : unavailable(providerID, "unsupported", "No supported credential is configured")
    }

    const cacheKey = `${providerID}:${selected.id}:${selected.accountGeneration}`
    if (cachedOnly) {
      const cached = yield* cache.peek({ key: cacheKey, generation: selected.generation })
      return cached
        ? yield* profiled(cached)
        : unavailable(providerID, "unsupported", "Provider usage has not been loaded", selected.value)
    }

    const updatedAt = Math.max(0, Math.trunc(now()))
    const snapshot = yield* cache
      .get({
        key: cacheKey,
        generation: selected.generation,
        ttlMs: input.ttlMs?.[providerID] ?? minute,
        refresh,
        load: adapter({
          providerID,
          label: providerLabel(providerID),
          credential: selected,
          updatedAt,
        }),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed(
            unavailable(
              providerID,
              error instanceof RequestError && (error.status === 401 || error.status === 403)
                ? "unauthorized"
                : error instanceof RequestError && error.status === 404
                  ? "unsupported"
                  : "error",
              error instanceof RequestError && (error.status === 401 || error.status === 403)
                ? "Provider usage credentials are unauthorized"
                : "Provider usage refresh failed",
              selected.value,
            ),
          ),
        ),
      )
    const fetched = yield* profiled(snapshot)
    const latest = observed()
    // A no-data unsupported snapshot (for example the Muse placeholder, whose timestamp is
    // only its generation time) carries no quota, so it cannot supersede a stored observation.
    if (
      latest &&
      (latest.updatedAt >= snapshot.updatedAt || (snapshot.status === "unsupported" && snapshot.windows.length === 0))
    )
      return yield* profiled(latest, profileSource !== undefined)
    return fetched
  })

  const list = Effect.fn("ProviderUsage.list")(function* (
    request?: { readonly refresh?: boolean; readonly cachedOnly?: boolean },
    includeLocal = true,
  ) {
    const providers = yield* input.providers.available()
    const credentials = yield* input.credentials.all()
    const targets = [...new Set(providers.map((provider) => provider.id))].toSorted().flatMap((providerID) => {
      const candidates = credentialsFor(credentials, providerID)
      const profiles =
        input.adapters[providerID] && candidates.length > 1
          ? candidates.toSorted((left, right) => left.label.localeCompare(right.label)).map((item) => item.id)
          : [undefined]
      return profiles.map((credentialID) => ({ providerID, candidates, credentialID }))
    })
    const snapshots = yield* Effect.forEach(
      targets,
      (target) => load(target.providerID, target.candidates, target.credentialID, request?.refresh, request?.cachedOnly),
      { concurrency: 4 },
    )
    const local =
      includeLocal && input.localSpend
        ? yield* Effect.suspend(input.localSpend).pipe(
            Effect.map((rows) => localSpendSnapshots(rows, now())),
            Effect.catchCause(() => Effect.succeed([])),
          )
        : []
    const available = new Set(providers.map((provider) => provider.id))
    const unknown = input.accountUnknown ? yield* input.accountUnknown(request?.refresh, request?.cachedOnly) : []
    const unbound = [...observations].flatMap(([key, snapshot]) =>
      key.endsWith(":") &&
      available.has(snapshot.providerID) &&
      credentialsFor(credentials, snapshot.providerID).length > 1
        ? [snapshot]
        : [],
    )
    return [
      ...snapshots,
      ...unbound,
      ...unknown.filter((snapshot) => available.has(snapshot.providerID)),
      ...local.filter((snapshot) => available.has(snapshot.providerID)),
    ]
  })

  return {
    get: Effect.fn("ProviderUsage.get")(function* (request: GetInput) {
      const credentials = yield* input.credentials.all()
      return yield* load(
        request.providerID,
        credentialsFor(credentials, request.providerID),
        request.credentialID,
        request.refresh,
      )
    }),
    list,
    forecast: Effect.fn("ProviderUsage.forecast")(function* (request) {
      const asOf = Math.max(0, Math.trunc(now()))
      const [snapshots, bins] = yield* Effect.all(
        [
          list({ cachedOnly: true }, false).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
          input.localUsage
            ? Effect.suspend(() => input.localUsage!(request.localScope, asOf)).pipe(
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
            : Effect.succeed([]),
        ],
        { concurrency: 2 },
      )
      const localRates = yield* Effect.sync(() => bins === undefined ? undefined : localRateForecasts(bins, asOf)).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      return yield* Effect.sync(() => ({
        asOf,
        localScope: request.localScope,
        ...(localRates === undefined ? {} : { localRates }),
        ...(snapshots === undefined ? {} : { quotas: snapshots.flatMap((snapshot) =>
          snapshot.source === "local_session"
            ? []
            : snapshot.windows.map((window) => ({
                providerID: snapshot.providerID,
                ...(snapshot.profile === undefined ? {} : { profile: snapshot.profile }),
                windowID: window.id,
                unit: window.unit,
                ...forecast.quota({
                  account: accounts.get(snapshot),
                  snapshot,
                  window,
                  now: asOf,
                  semantics: quotaSemantics(snapshot, window),
                  wholeWindowMean:
                    (snapshot.providerID === "cursor" && window.id === "included") ||
                    (snapshot.providerID === "xai" && window.id === "weekly"),
                }),
              })),
        ) }),
      })).pipe(
        Effect.catchCause(() => Effect.succeed({ asOf, localScope: request.localScope })),
      )
    }),
    observe: Effect.fn("ProviderUsage.observe")(function* (observation, profileSource) {
      yield* Effect.gen(function* () {
        const snapshot = new ProviderUsage.Snapshot({
          providerID: observation.providerID,
          label: observation.label,
          status: "available",
          source: observation.source,
          stability: observation.stability,
          updatedAt: observation.observedAt,
          windows: observation.windows,
        })
        const key = `${observation.providerID}:${profileSource ?? ""}`
        const current = observations.get(key)
        if (current && snapshot.updatedAt < current.updatedAt) return
        observations.delete(key)
        observations.set(key, snapshot)
        while (observations.size > 256) observations.delete(observations.keys().next().value!)
        if (profileSource === undefined) return
        yield* retain(snapshot, profileSource)
      }).pipe(Effect.catchCause(() => Effect.void))
    }),
  }
}

function quotaSemantics(
  snapshot: ProviderUsage.Snapshot,
  window: ProviderUsage.Window,
): ProviderUsageForecast.Semantics {
  if (snapshot.providerID === "opencode-go" && window.id === "session") return "rolling"
  if (
    snapshot.providerID === "github-copilot" &&
    window.unit === "percent" &&
    (window.limit !== undefined || window.remaining !== undefined)
  )
    return "unknown"
  if (
    window.unlimited === true ||
    (window.resetAt === undefined &&
      window.periodSeconds === undefined &&
      (window.remaining !== undefined || window.limit !== undefined))
  )
    return "balance"
  if (window.resetAt === undefined) return "unknown"
  const fixed =
    (window.unit === "percent" &&
      ((snapshot.providerID === "anthropic" && (window.id === "five-hour" || /^seven-day(?:-|$)/.test(window.id))) ||
        (snapshot.providerID === "openai" && /-(?:primary|secondary)$/.test(window.id)) ||
        (snapshot.providerID === "muse" && ["window", "weekly"].includes(window.id)) ||
        (snapshot.providerID === "github-copilot" && ["credits", "chat", "completions"].includes(window.id)) ||
        (snapshot.providerID === "xai" && window.id === "weekly") ||
        (["zai", "zai-coding-plan"].includes(snapshot.providerID) && ["session", "weekly"].includes(window.id)) ||
        (snapshot.providerID === "cursor" && window.id === "included") ||
        (snapshot.providerID === "opencode-go" && ["weekly", "monthly"].includes(window.id)))) ||
    (["zai", "zai-coding-plan"].includes(snapshot.providerID) &&
      window.id === "web-searches" &&
      window.unit === "count")
  if (fixed) return "fixed-reset"
  return "unknown"
}

function localRateForecasts(bins: ReadonlyArray<LocalUsageBin>, asOf: number): ReadonlyArray<UsageForecast.LocalRate> {
  const groups = new Map<string, LocalUsageBin[]>()
  for (const bin of bins) {
    const key = JSON.stringify([bin.providerID, bin.profile, bin.modelID])
    const current = groups.get(key)
    if (current) current.push(bin)
    if (!current) groups.set(key, [bin])
  }
  return [...groups.values()].map((values) => {
    const rate = ProviderUsageForecast.localRates(
      values.map((bin) => ({
        start: bin.start,
        tokens:
          bin.tokens.input + bin.tokens.output + bin.tokens.reasoning + bin.tokens.cache.read + bin.tokens.cache.write,
        ...(bin.knownUSD === undefined ? {} : { knownUSD: bin.knownUSD }),
        pricedRequests: bin.pricedRequests,
        unpricedRequests: bin.unpricedRequests,
      })),
      asOf,
    )
    return {
      providerID: values[0].providerID,
      ...(values[0].profile === undefined ? {} : { profile: values[0].profile }),
      modelID: values[0].modelID,
      observedFrom: rate.observedFrom,
      observedTo: rate.observedTo,
      tokensPerMinute: rate.tokensPerMinute,
      tokensPerMinute5: rate.tokensPerMinute5,
      tokensPerMinute60: rate.tokensPerMinute60,
      coverage: rate.coverage,
      ...(rate.estimatedUSDPerHour === undefined
        ? {}
        : { estimatedUSDPerHour: Money.USD.make(rate.estimatedUSDPerHour) }),
    }
  })
}

export function localReads(database: Database.Interface, location: Location.Ref, now: () => number = Date.now) {
  return {
    localSpend: () => {
      const dayStart = new Date(now()).setHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart).setDate(new Date(dayStart).getDate() + 1)
      return SessionUsageRead.localSpend(database, { dayStart, dayEnd })
    },
    localUsage: (scope: UsageForecast.LocalScope, asOf: number) =>
      SessionUsageRead.localUsage(database, {
        from: asOf - 60 * minute,
        to: asOf,
        scope: scope === "backend" ? { type: "backend" } : { type: "location", location },
      }),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const catalog = yield* Catalog.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const database = yield* Database.Service
    const location = yield* Location.Service
    const alerts = yield* ProviderUsagePaceAlerts.Service
    const providerUsage = Config.latest(yield* config.entries(), "provider_usage")
    const cache = ProviderUsageCache.make()
    const claude = createClaudeCodeCredentialStore({
      source: createManagedClaudeCodeCredentialSource({ directory: join(global.data, "claude-code", "profiles") }),
    })
    return Service.of(
      make({
        cache,
        alerts,
        credentials,
        providers: catalog.provider,
        adapters: {
          anthropic: (input) => claudeOAuth(http, claude, input),
          openrouter: (input) => openRouter(http, input),
          openai: (input) => openAI(http, input, integrations.connection),
          meta: (input) => meta(http, input),
          muse,
          "github-copilot": (input) => githubCopilot(http, input),
          xai: (input) => grok(http, input),
          zai: (input) => zai(http, input),
          "zai-coding-plan": (input) => zai(http, input),
          cursor: (input) => cursor(http, input),
          "opencode-go": (input) => goUsage(http, input),
        },
        ttlMs: { anthropic: 5 * minute },
        ...(providerUsage?.codex_app_server === undefined
          ? {}
          : {
              accountUnknown: (refresh?: boolean, cachedOnly?: boolean) =>
                cachedOnly
                  ? cache
                      .peek({ key: "openai:codex-app-server" })
                      .pipe(Effect.map((snapshot) => (snapshot ? [snapshot] : [])))
                  : cache
                  .get({
                    key: "openai:codex-app-server",
                    ttlMs: minute,
                    refresh,
                    load: Effect.tryPromise(() =>
                      CodexUsage.loadAppServer({
                        providerID: Provider.ID.make("openai"),
                        label: "Codex",
                        updatedAt: Date.now(),
                        client: CodexUsage.connectAppServer(providerUsage.codex_app_server!),
                      }),
                    ).pipe(
                      Effect.map(
                        (snapshot) => new ProviderUsage.Snapshot({ ...snapshot, profile: "Codex app-server" }),
                      ),
                    ),
                  })
                  .pipe(
                    Effect.map((snapshot) => [snapshot]),
                    Effect.catch(() => Effect.succeed([])),
                  ),
            }),
        ...localReads(database, location),
      }),
    )
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Catalog.node,
    Config.node,
    Credential.node,
    Integration.node,
    Database.node,
    Global.node,
    Location.node,
    ProviderUsagePaceAlerts.node,
    httpClient,
  ],
})

export const muse: Adapter = (input) => Effect.succeed(MuseUsage.unreported(input.updatedAt))

const claudeOAuth = (
  http: HttpClient.HttpClient,
  store: ReturnType<typeof createClaudeCodeCredentialStore>,
  input: AdapterInput,
) =>
  Effect.gen(function* () {
    if (
      input.credential.value.type !== "oauth" ||
      input.credential.value.metadata?.authKind !== "claude-code" ||
      input.credential.value.metadata.managed !== true ||
      typeof input.credential.value.metadata.source !== "string"
    )
      return new ProviderUsage.Snapshot({
        providerID: input.providerID,
        label: "Claude",
        status: "unsupported",
        source: "provider_internal_api",
        stability: "best_effort",
        updatedAt: input.updatedAt,
        windows: [],
        message: "Claude subscription usage requires a Claude Code OAuth account",
      })
    const source = input.credential.value.metadata.source
    return yield* Effect.tryPromise({
      try: () =>
        ClaudeUsage.loadOAuth({
          providerID: input.providerID,
          label: "Claude",
          updatedAt: input.updatedAt,
          resolve: () => store.resolve(source),
          refresh: () => store.refresh(source),
          request: (accessToken) =>
            Effect.runPromise(
              jsonResponse(http, "https://api.anthropic.com/api/oauth/usage", accessToken, {
                "anthropic-beta": "oauth-2025-04-20",
              }),
            ),
        }),
      catch: (cause) =>
        cause instanceof ClaudeUsage.RequestError
          ? new RequestError({
              status: cause.status,
              ...(cause.retryAfter === undefined ? {} : { retryAfter: cause.retryAfter }),
            })
          : new Error("Claude usage refresh failed"),
    })
  })

export const openRouter = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    if (input.credential.value.type !== "key")
      return yield* Effect.fail(new Error("OpenRouter usage requires a key credential"))
    const key = yield* jsonResponse(http, "https://openrouter.ai/api/v1/key", input.credential.value.key)
    if (key.status !== 401 && key.status !== 403 && (key.status < 200 || key.status >= 300))
      return yield* new RequestError({ status: key.status })
    const snapshot =
      key.status === 401 || key.status === 403
        ? new ProviderUsage.Snapshot({
            providerID: input.providerID,
            label: input.label,
            status: "available",
            source: "provider_api",
            stability: "stable",
            updatedAt: input.updatedAt,
            windows: [],
          })
        : OpenRouterUsage.normalizeKey({
            providerID: input.providerID,
            label: input.label,
            updatedAt: input.updatedAt,
            response: key.body,
          })
    const credits = yield* jsonResponse(http, "https://openrouter.ai/api/v1/credits", input.credential.value.key).pipe(
      Effect.option,
    )
    if (credits._tag === "None" || credits.value.status < 200 || credits.value.status >= 300) {
      if (key.status === 401 || key.status === 403) return yield* new RequestError({ status: key.status })
      return snapshot
    }
    if (key.status === 401 || key.status === 403)
      return yield* Effect.try(() => OpenRouterUsage.mergeCredits(snapshot, credits.value.body))
    return yield* Effect.try(() => OpenRouterUsage.mergeCredits(snapshot, credits.value.body)).pipe(
      Effect.orElseSucceed(() => snapshot),
    )
  })

export const grok = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    const credential = input.credential.value
    if (credential.type !== "oauth" || !["browser", "device"].includes(credential.methodID))
      return new ProviderUsage.Snapshot({
        providerID: input.providerID,
        label: "Grok",
        status: "unsupported",
        source: "provider_internal_api",
        stability: "best_effort",
        updatedAt: input.updatedAt,
        windows: [],
        message: "Grok Build usage requires a connected xAI subscription account",
      })
    const response = yield* json(http, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", credential.access)
    return GrokUsage.normalize({ ...input, label: "Grok", response })
  })

export const zai = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    if (input.credential.value.type !== "key") return yield* Effect.fail(new Error("Z.ai usage requires an API key"))
    const key = input.credential.value.key
    const quota = yield* json(http, "https://api.z.ai/api/monitor/usage/quota/limit", key)
    if (
      record(quota) &&
      quota.success === false &&
      typeof quota.msg === "string" &&
      quota.msg.toLowerCase().includes("coding plan")
    )
      return new ProviderUsage.Snapshot({
        providerID: input.providerID,
        label: "Z.ai",
        status: "unsupported",
        source: "provider_internal_api",
        stability: "best_effort",
        updatedAt: input.updatedAt,
        windows: [],
        message: "No active GLM Coding Plan",
      })
    const plan = yield* jsonResponse(http, "https://api.z.ai/api/biz/subscription/list", key).pipe(Effect.option)
    return ZAIUsage.normalize({
      ...input,
      label: "Z.ai",
      quota,
      ...(plan._tag === "Some" && plan.value.status >= 200 && plan.value.status < 300
        ? { subscription: plan.value.body }
        : {}),
    })
  })

export const cursor = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    const credential = input.credential.value
    if (credential.type !== "key" && credential.type !== "oauth")
      return yield* Effect.fail(new Error("Cursor usage requires an API key or OAuth credential"))
    const token = yield* Effect.tryPromise({
      try: async () => {
        const { resolveBearerToken } = await import("./cursor/provider/auth")
        return resolveBearerToken(
          credential.type === "key" ? { apiKey: credential.key } : { accessToken: credential.access },
        )
      },
      catch: () => new RequestError({}),
    })
    const usage = yield* cursorRpc(http, "GetCurrentPeriodUsage", token)
    const plan = yield* cursorRpc(http, "GetPlanInfo", token).pipe(Effect.option)
    return CursorUsage.normalize({
      ...input,
      label: "Cursor",
      usage,
      ...(plan._tag === "Some" ? { plan: plan.value } : {}),
    })
  })

const cursorRpc = Effect.fnUntraced(function* (http: HttpClient.HttpClient, method: string, token: string) {
  const response = yield* http
    .execute(
      HttpClientRequest.post(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("connect-protocol-version", "1"),
        HttpClientRequest.bodyText("{}", "application/json"),
      ),
    )
    .pipe(Effect.mapError(() => new RequestError({})))
  if (response.status < 200 || response.status >= 300)
    return yield* new RequestError({
      status: response.status,
      retryAfter: retryAfter(response.headers["retry-after"]),
    })
  return yield* response.json.pipe(Effect.mapError(() => new RequestError({ status: response.status })))
})

export const goUsage = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    if (input.credential.value.type !== "key")
      return yield* Effect.fail(new Error("OpenCode Go usage requires an API key"))
    const response = yield* jsonResponse(http, "https://opencode.ai/zen/go/v1/usage", input.credential.value.key)
    if (
      response.status === 403 &&
      record(response.body) &&
      record(response.body.error) &&
      response.body.error.type === "EntitlementError"
    )
      return new ProviderUsage.Snapshot({
        providerID: input.providerID,
        label: "OpenCode Go",
        status: "unsupported",
        source: "provider_api",
        stability: "stable",
        updatedAt: input.updatedAt,
        windows: [],
        message: "No OpenCode Go subscription on this key",
      })
    if (response.status < 200 || response.status >= 300) return yield* new RequestError({ status: response.status })
    return GoUsage.normalize({ ...input, label: "OpenCode Go", response: response.body })
  })

const githubCopilot = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    const credential = input.credential.value
    const accountKey = JSON.stringify([input.providerID, input.credential.id, input.credential.accountGeneration])
    if (credential.type !== "oauth")
      return yield* Effect.fail(new Error("GitHub Copilot usage requires an OAuth credential"))
    const enterpriseUrl =
      typeof credential.metadata?.enterpriseUrl === "string" ? credential.metadata.enterpriseUrl : undefined
    if (enterpriseUrl)
      return new ProviderUsage.Snapshot({
        providerID: input.providerID,
        label: input.label,
        status: "unsupported",
        source: "provider_api",
        stability: "stable",
        updatedAt: input.updatedAt,
        windows: [],
        message: "GitHub Copilot usage reporting supports github.com accounts",
      })
    const result = yield* Effect.tryPromise({
      try: () =>
        CopilotUsage.load({
          providerID: input.providerID,
          label: input.label,
          updatedAt: input.updatedAt,
          matchedOrg: copilotOrgLogins.get(accountKey),
          request: (path) => Effect.runPromise(copilotJson(http, "https://api.github.com", credential.refresh, path)),
        }),
      catch: (cause) =>
        cause instanceof CopilotUsage.RequestError
          ? new RequestError({
              status: cause.status,
              ...(cause.retryAfter === undefined ? {} : { retryAfter: cause.retryAfter }),
            })
          : new Error("GitHub Copilot usage refresh failed"),
    })
    if (result.matchedOrg === undefined) copilotOrgLogins.delete(accountKey)
    else copilotOrgLogins.set(accountKey, result.matchedOrg)
    return result.snapshot
  })

const copilotJson = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  origin: string,
  token: string,
  path: string,
) {
  const response = yield* http
    .execute(
      HttpClientRequest.get(`${origin}${path}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("Authorization", `token ${token}`),
        HttpClientRequest.setHeaders({
          "User-Agent": `ycoding/${InstallationVersion}`,
          "Editor-Version": `ycoding/${InstallationVersion}`,
          "Editor-Plugin-Version": `ycoding/${InstallationVersion}`,
          "X-GitHub-Api-Version": "2025-04-01",
        }),
      ),
    )
    .pipe(Effect.mapError(() => new RequestError({})))
  return {
    status: response.status,
    body: yield* response.json.pipe(Effect.catch(() => Effect.succeed(null))),
  }
})

export const openAI = (
  http: HttpClient.HttpClient,
  input: AdapterInput,
  connection: Pick<Integration.Interface["connection"], "snapshot">,
) =>
  Effect.gen(function* () {
    if (input.credential.value.type === "oauth" && CodexUsage.isChatGPTCredential(input.credential.value)) {
      const snapshot = yield* connection.snapshot({
        type: "credential",
        id: input.credential.id,
        label: input.credential.label,
        active: input.credential.active,
      })
      if (
        !snapshot.credential ||
        snapshot.credential.accountGeneration !== input.credential.accountGeneration ||
        snapshot.value?.type !== "oauth" ||
        !CodexUsage.isChatGPTCredential(snapshot.value)
      )
        return yield* Effect.fail(new Error("OpenAI usage account changed during refresh"))
      const response = yield* json(
        http,
        "https://chatgpt.com/backend-api/wham/usage",
        snapshot.value.access,
        CodexUsage.accountHeaders(snapshot.value),
      )
      return CodexUsage.normalize({
        providerID: input.providerID,
        label: "Codex",
        updatedAt: input.updatedAt,
        source: "provider_internal_api",
        stability: "best_effort",
        response,
      })
    }
    if (input.credential.value.type !== "key")
      return yield* Effect.fail(new Error("OpenAI usage requires an API key or ChatGPT OAuth credential"))
    if (!OpenAIUsage.isAdminCredential(input.credential.value.metadata))
      return new ProviderUsage.Snapshot({
        providerID: input.providerID,
        label: input.label,
        status: "unauthorized",
        source: "provider_api",
        stability: "stable",
        updatedAt: input.updatedAt,
        windows: [],
        message: "Organization usage requires an explicitly configured admin credential",
      })
    const now = new Date(input.updatedAt)
    const weekStart = utcWeekStart(now)
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
    const end = Math.floor(now.getTime() / 1000)
    const query = `start_time=${Math.min(weekStart, monthStart)}&end_time=${end}&bucket_width=1d&limit=31`
    const usage = yield* pages(
      http,
      `https://api.openai.com/v1/organization/usage/completions?${query}`,
      input.credential.value.key,
    )
    const costs = yield* pages(
      http,
      `https://api.openai.com/v1/organization/costs?${query}`,
      input.credential.value.key,
    )
    return OpenAIUsage.normalize({
      providerID: input.providerID,
      label: input.label,
      updatedAt: input.updatedAt,
      weekStart,
      monthStart,
      usage,
      costs,
    })
  })

const meta = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    if (input.credential.value.type !== "key")
      return yield* Effect.fail(new Error("Meta usage requires an API key credential"))
    const now = new Date(input.updatedAt)
    const weekStart = utcWeekStart(now)
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
    const end = Math.floor(now.getTime() / 1000)
    const query = `start_time=${Math.min(weekStart, monthStart)}&end_time=${end}&bucket_width=1d&limit=31`
    const usage = yield* pages(
      http,
      `https://api.llama.com/v1/organization/usage/completions?${query}`,
      input.credential.value.key,
    )
    const costs = yield* pages(http, `https://api.llama.com/v1/organization/costs?${query}`, input.credential.value.key)
    return MetaUsage.normalize({
      providerID: input.providerID,
      label: input.label,
      updatedAt: input.updatedAt,
      weekStart,
      monthStart,
      usage,
      costs,
    })
  })

const pages = Effect.fnUntraced(function* (http: HttpClient.HttpClient, url: string, key: string) {
  const values: Array<{ readonly start_time?: unknown; readonly end_time?: unknown; readonly results?: unknown }> = []
  let next: string | undefined
  do {
    const target = next ? `${url}&page=${encodeURIComponent(next)}` : url
    const response = yield* json(http, target, key)
    if (!record(response) || !Array.isArray(response.data))
      return yield* Effect.fail(new Error("Invalid provider usage page"))
    values.push(...response.data)
    next = response.has_more === true && typeof response.next_page === "string" ? response.next_page : undefined
  } while (next)
  return values
})

const jsonResponse = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  url: string,
  key: string,
  headers: Readonly<Record<string, string>> = {},
) {
  const response = yield* http
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.setHeaders(headers),
      ),
    )
    .pipe(Effect.mapError(() => new RequestError({})))
  return {
    status: response.status,
    retryAfter: retryAfter(response.headers["retry-after"]),
    body: yield* response.json.pipe(Effect.catch(() => Effect.succeed(null))),
  }
})

const json = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  url: string,
  key: string,
  headers: Readonly<Record<string, string>> = {},
) {
  const response = yield* http
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.setHeaders(headers),
      ),
    )
    .pipe(Effect.mapError(() => new RequestError({})))
  if (response.status < 200 || response.status >= 300)
    return yield* new RequestError({
      status: response.status,
      retryAfter: retryAfter(response.headers["retry-after"]),
    })
  return yield* response.json.pipe(Effect.mapError(() => new RequestError({ status: response.status })))
})

function providerLabel(providerID: Provider.ID) {
  if (providerID === Provider.ID.anthropic) return "Claude"
  return providerID
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function retryAfter(value: string | undefined) {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

function utcWeekStart(value: Date) {
  const day = value.getUTCDay() || 7
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() - day + 1) / 1000
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
