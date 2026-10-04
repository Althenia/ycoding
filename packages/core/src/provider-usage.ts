export * as ProviderUsageRuntime from "./provider-usage"
export { ProviderUsage } from "@ycoding-ai/schema/provider-usage"

import { Config } from "./config"
import { Catalog } from "./catalog"
import { Credential } from "./credential"
import { makeLocationNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { Integration } from "@ycoding-ai/schema/integration"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "@ycoding-ai/schema/provider"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { InstallationVersion } from "./installation/version"
import {
  createClaudeCodeCredentialStore,
  createSystemClaudeCodeCredentialSource,
} from "./plugin/provider/anthropic-claude-code-account"
import { CopilotUsage } from "./provider-usage/copilot"
import { ClaudeUsage } from "./provider-usage/claude"
import { CodexUsage } from "./provider-usage/codex"
import { MetaUsage } from "./provider-usage/meta"
import { OpenAIUsage } from "./provider-usage/openai"
import { OpenRouterUsage } from "./provider-usage/openrouter"
import { GrokUsage } from "./provider-usage/grok"
import { ZAIUsage } from "./provider-usage/zai"
import { CursorUsage } from "./provider-usage/cursor"
import { GoUsage } from "./provider-usage/go"
import { ProviderUsageCache } from "./provider-usage/cache"
import { Database } from "./database/database"
import { SessionProviderRequestTable } from "./session/sql"
import { gte } from "drizzle-orm"

const minute = 60_000

// Org login whose billing summary last reported Copilot AI-credit usage, per
// provider. Steady-state refresh then makes one summary call per cycle and
// re-discovers through /user/orgs only after the remembered org stops
// answering or the refresh for another reason reports nothing.
const copilotOrgLogins = new Map<Provider.ID, string>()

export interface GetInput {
  readonly providerID: Provider.ID
  readonly credentialID?: Credential.ID
  readonly refresh?: boolean
}

export interface Interface {
  readonly get: (input: GetInput) => Effect.Effect<ProviderUsage.Snapshot>
  readonly list: (input?: { readonly refresh?: boolean }) => Effect.Effect<ReadonlyArray<ProviderUsage.Snapshot>>
  readonly observe: (observation: ProviderUsage.Observation) => Effect.Effect<void>
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
  readonly localSpend?: () => Effect.Effect<ReadonlyArray<LocalSpendRow>, unknown>
}

interface LocalSpendRow {
  readonly model: { readonly providerID: string }
  readonly cost: number | null
  readonly timeCreated: number
}

const localSpendProviders = new Set(["anthropic", "openai", "opencode", "opencode-go", "xai"])

export function localSpendSnapshots(rows: ReadonlyArray<LocalSpendRow>, now: number) {
  const start = new Date(now).setHours(0, 0, 0, 0)
  const end = new Date(start).setDate(new Date(start).getDate() + 1)
  const totals = rows.filter((row): row is LocalSpendRow & { readonly cost: number } =>
    row.cost !== null && Number.isFinite(row.cost) && row.cost >= 0 &&
    row.timeCreated >= start && row.timeCreated < end && localSpendProviders.has(row.model.providerID),
  ).reduce((values, row) => values.set(row.model.providerID, (values.get(row.model.providerID) ?? 0) + row.cost), new Map<string, number>())
  return [...totals].toSorted(([left], [right]) => left.localeCompare(right)).map(([providerID, used]) =>
    new ProviderUsage.Snapshot({
      providerID: Provider.ID.make(providerID),
      label: providerID === "opencode" ? "OpenCode Zen" : providerID === "opencode-go" ? "OpenCode Go" : providerLabel(Provider.ID.make(providerID)),
      profile: "YCoding local", status: "available", source: "local_session", stability: "stable",
      updatedAt: Math.max(0, Math.trunc(now)),
      windows: [new ProviderUsage.Window({ id: "today", label: "Today", unit: "usd", used })],
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
  const observations = new Map<Provider.ID, ProviderUsage.Snapshot>()

  const unavailable = (
    providerID: Provider.ID,
    status: "unsupported" | "unauthorized" | "error",
    message: string,
  ) =>
    new ProviderUsage.Snapshot({
      providerID,
      label: providerLabel(providerID),
      status,
      source: "provider_api",
      stability: "stable",
      updatedAt: Math.max(0, Math.trunc(now())),
      windows: [],
      message,
    })

  const credentialsFor = (credentials: ReadonlyArray<Credential.Info>, providerID: Provider.ID) =>
    credentials.filter((item) => item.integrationID === Integration.ID.make(providerID))

  const load = Effect.fnUntraced(function* (
    providerID: Provider.ID,
    candidates: ReadonlyArray<Credential.Info>,
    credentialID: Credential.ID | undefined,
    refresh: boolean | undefined,
  ) {
    // With several profiles stored for one provider, quota must follow the requested profile;
    // falling back to the first row would report another account's usage.
    const primary = candidates.find((item) => item.active) ?? candidates[0]
    const selected = credentialID ? candidates.find((item) => item.id === credentialID) : primary
    // Response-header observations come from Session requests, which run as the active profile.
    const observed = () => (selected === primary ? observations.get(providerID) : undefined)
    const profiled = (snapshot: ProviderUsage.Snapshot) =>
      candidates.length > 1 && selected?.label ? new ProviderUsage.Snapshot({
        providerID: snapshot.providerID, label: snapshot.label, profile: selected.label,
        status: snapshot.status, source: snapshot.source, stability: snapshot.stability,
        updatedAt: snapshot.updatedAt, windows: snapshot.windows,
        ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
      }) : snapshot

    const current = observed()
    if (!refresh && current) return profiled(current)

    const adapter = input.adapters[providerID]
    if (!adapter) return unavailable(providerID, "unsupported", "Provider usage is unsupported")
    if (!selected) return unavailable(providerID, "unsupported", "No supported credential is configured")

    const updatedAt = Math.max(0, Math.trunc(now()))
    const snapshot = yield* cache
      .get({
        key: `${providerID}:${selected.id}`,
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
            ),
          ),
        ),
      )
    const latest = observed()
    return profiled(latest && latest.updatedAt >= snapshot.updatedAt ? latest : snapshot)
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
    list: Effect.fn("ProviderUsage.list")(function* (request) {
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
        (target) => load(target.providerID, target.candidates, target.credentialID, request?.refresh),
        { concurrency: 4 },
      )
      const local = input.localSpend
        ? yield* input.localSpend().pipe(
            Effect.map((rows) => localSpendSnapshots(rows, now())),
            Effect.catchCause(() => Effect.succeed([])),
          )
        : []
      const available = new Set(providers.map((provider) => provider.id))
      return [...snapshots, ...local.filter((snapshot) => available.has(snapshot.providerID))]
    }),
    observe: Effect.fn("ProviderUsage.observe")((observation) =>
      Effect.sync(() => {
        const snapshot = new ProviderUsage.Snapshot({
          providerID: observation.providerID,
          label: observation.label,
          status: "available",
          source: observation.source,
          stability: observation.stability,
          updatedAt: observation.observedAt,
          windows: observation.windows,
        })
        const current = observations.get(observation.providerID)
        if (!current || snapshot.updatedAt >= current.updatedAt) observations.set(observation.providerID, snapshot)
      }),
    ),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const catalog = yield* Catalog.Service
    const credentials = yield* Credential.Service
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const database = yield* Database.Service
    const providerUsage = Config.latest(yield* config.entries(), "provider_usage")
    const claude = createClaudeCodeCredentialStore({
      source: createSystemClaudeCodeCredentialSource({ home: global.home }),
    })
    return Service.of(
      make({
        credentials,
        providers: catalog.provider,
        adapters: {
          anthropic: (input) => claudeOAuth(http, claude, input),
          openrouter: (input) => openRouter(http, input),
          openai: (input) => openAI(http, input, providerUsage?.codex_app_server),
          meta: (input) => meta(http, input),
          "github-copilot": (input) => githubCopilot(http, input),
          xai: (input) => grok(http, input),
          zai: (input) => zai(http, input),
          "zai-coding-plan": (input) => zai(http, input),
          cursor: (input) => cursor(http, input),
          "opencode-go": (input) => goUsage(http, input),
        },
        ttlMs: { anthropic: 5 * minute },
        localSpend: () => database.db.select({
          model: SessionProviderRequestTable.model,
          cost: SessionProviderRequestTable.cost,
          timeCreated: SessionProviderRequestTable.time_created,
        }).from(SessionProviderRequestTable)
          .where(gte(SessionProviderRequestTable.time_created, new Date().setHours(0, 0, 0, 0)))
          .all(),
      }),
    )
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Catalog.node, Config.node, Credential.node, Database.node, Global.node, httpClient] })

const claudeOAuth = (
  http: HttpClient.HttpClient,
  store: ReturnType<typeof createClaudeCodeCredentialStore>,
  input: AdapterInput,
) =>
  Effect.gen(function* () {
    if (input.credential.value.type !== "oauth" || input.credential.value.metadata?.authKind !== "claude-code")
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
    const source =
      typeof input.credential.value.metadata.source === "string"
        ? input.credential.value.metadata.source
        : input.credential.value.access
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
    const snapshot = key.status === 401 || key.status === 403
      ? new ProviderUsage.Snapshot({
          providerID: input.providerID, label: input.label, status: "available", source: "provider_api",
          stability: "stable", updatedAt: input.updatedAt, windows: [],
        })
      : OpenRouterUsage.normalizeKey({
          providerID: input.providerID, label: input.label, updatedAt: input.updatedAt, response: key.body,
        })
    const credits = yield* jsonResponse(http, "https://openrouter.ai/api/v1/credits", input.credential.value.key)
      .pipe(Effect.option)
    if (credits._tag === "None" || credits.value.status < 200 || credits.value.status >= 300) {
      if (key.status === 401 || key.status === 403) return yield* new RequestError({ status: key.status })
      return snapshot
    }
    if (key.status === 401 || key.status === 403)
      return yield* Effect.try(() => OpenRouterUsage.mergeCredits(snapshot, credits.value.body))
    return yield* Effect.try(() => OpenRouterUsage.mergeCredits(snapshot, credits.value.body))
      .pipe(Effect.orElseSucceed(() => snapshot))
  })

export const grok = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    const credential = input.credential.value
    if (credential.type !== "oauth" || !["browser", "device"].includes(credential.methodID))
      return new ProviderUsage.Snapshot({
        providerID: input.providerID, label: "Grok", status: "unsupported",
        source: "provider_internal_api", stability: "best_effort", updatedAt: input.updatedAt, windows: [],
        message: "Grok Build usage requires a connected xAI subscription account",
      })
    const response = yield* json(http, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", credential.access)
    return GrokUsage.normalize({ ...input, label: "Grok", response })
  })

export const zai = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    if (input.credential.value.type !== "key")
      return yield* Effect.fail(new Error("Z.ai usage requires an API key"))
    const key = input.credential.value.key
    const quota = yield* json(http, "https://api.z.ai/api/monitor/usage/quota/limit", key)
    if (record(quota) && quota.success === false && typeof quota.msg === "string" && quota.msg.toLowerCase().includes("coding plan"))
      return new ProviderUsage.Snapshot({
        providerID: input.providerID, label: "Z.ai", status: "unsupported",
        source: "provider_internal_api", stability: "best_effort", updatedAt: input.updatedAt,
        windows: [], message: "No active GLM Coding Plan",
      })
    const plan = yield* jsonResponse(http, "https://api.z.ai/api/biz/subscription/list", key).pipe(Effect.option)
    return ZAIUsage.normalize({
      ...input, label: "Z.ai", quota,
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
        return resolveBearerToken(credential.type === "key" ? { apiKey: credential.key } : { accessToken: credential.access })
      },
      catch: () => new RequestError({}),
    })
    const usage = yield* cursorRpc(http, "GetCurrentPeriodUsage", token)
    const plan = yield* cursorRpc(http, "GetPlanInfo", token).pipe(Effect.option)
    return CursorUsage.normalize({
      ...input, label: "Cursor", usage,
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
    if (response.status === 403 && record(response.body) && record(response.body.error) && response.body.error.type === "EntitlementError")
      return new ProviderUsage.Snapshot({
        providerID: input.providerID, label: "OpenCode Go", status: "unsupported",
        source: "provider_api", stability: "stable", updatedAt: input.updatedAt,
        windows: [], message: "No OpenCode Go subscription on this key",
      })
    if (response.status < 200 || response.status >= 300) return yield* new RequestError({ status: response.status })
    return GoUsage.normalize({ ...input, label: "OpenCode Go", response: response.body })
  })

const githubCopilot = (http: HttpClient.HttpClient, input: AdapterInput) =>
  Effect.gen(function* () {
    const credential = input.credential.value
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
          matchedOrg: copilotOrgLogins.get(input.providerID),
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
    if (result.matchedOrg === undefined) copilotOrgLogins.delete(input.providerID)
    else copilotOrgLogins.set(input.providerID, result.matchedOrg)
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

const openAI = (
  http: HttpClient.HttpClient,
  input: AdapterInput,
  appServer: CodexUsage.AppServerCommand | undefined,
) =>
  Effect.gen(function* () {
    if (appServer) {
      const snapshot = yield* Effect.tryPromise(() =>
        CodexUsage.loadAppServer({
          providerID: input.providerID,
          label: "Codex",
          updatedAt: input.updatedAt,
          client: CodexUsage.connectAppServer(appServer),
        }),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (snapshot) return snapshot
    }
    if (input.credential.value.type === "oauth" && CodexUsage.isChatGPTCredential(input.credential.value)) {
      const response = yield* json(
        http,
        "https://chatgpt.com/backend-api/wham/usage",
        input.credential.value.access,
        CodexUsage.accountHeaders(input.credential.value),
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
    const costs = yield* pages(
      http,
      `https://api.llama.com/v1/organization/costs?${query}`,
      input.credential.value.key,
    )
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
