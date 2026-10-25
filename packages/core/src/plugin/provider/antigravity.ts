import { createServer } from "node:http"
import { define } from "@ycoding-ai/plugin/effect/plugin"
import type { IntegrationOAuthMethodRegistration } from "@ycoding-ai/plugin/effect/integration"
import { Clock, Deferred, Effect, Option, Redacted, Schedule, Schema, Semaphore, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AISDK } from "../../aisdk"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { EventRuntime } from "../../event"
import { Integration } from "../../integration"
import { CatalogModel } from "../../model"
import { OauthCallbackPage } from "../../oauth/page"
import { Provider } from "../../provider"
import type { PluginInternal } from "../internal"

declare const YCODING_ANTIGRAVITY_OAUTH: unknown

const integrationID = Integration.ID.make("antigravity")
const providerID = Provider.ID.make("antigravity")
const methodID = Integration.MethodID.make("google")
const callbackPort = 51121
const redirectURI = `http://localhost:${callbackPort}/oauth-callback`
export const antigravityBaseURL = "https://daily-cloudcode-pa.googleapis.com"
export const clientVersion = "2.26.0"
const scopes = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]
const reconnect =
  "Antigravity account token expired or was rejected; log in again: run ycoding, then /connect and choose Antigravity."

export function antigravityUserAgent() {
  const os = process.platform === "win32" ? "windows" : process.platform
  return `antigravity/hub/${clientVersion} (aidev_client; os_type=${os}; arch=${process.arch})`
}

const Token = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})
const Tier = Schema.Struct({
  id: Schema.optional(Schema.String),
  isDefault: Schema.optional(Schema.Boolean),
})
const LoadCodeAssist = Schema.Struct({
  cloudaicompanionProject: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ id: Schema.optional(Schema.String) })]),
  ),
  currentTier: Schema.optional(Schema.NullOr(Tier)),
  allowedTiers: Schema.optional(Schema.NullOr(Schema.Array(Tier))),
})
const OnboardUser = Schema.Struct({
  done: Schema.optional(Schema.Boolean),
  response: Schema.optional(
    Schema.Struct({
      cloudaicompanionProject: Schema.optional(
        Schema.Union([Schema.String, Schema.Struct({ id: Schema.optional(Schema.String) })]),
      ),
    }),
  ),
})
const ModelEntry = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  maxTokens: Schema.optional(Schema.Number),
  maxOutputTokens: Schema.optional(Schema.Number),
  supportsImages: Schema.optional(Schema.Boolean),
  supportsThinking: Schema.optional(Schema.Boolean),
  thinkingLevel: Schema.optional(Schema.Number),
  thinkingBudget: Schema.optional(Schema.Number),
  supportsVideo: Schema.optional(Schema.Boolean),
  supportsPdf: Schema.optional(Schema.Boolean),
  isInternal: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
})
const decodeEntry = Schema.decodeUnknownOption(ModelEntry)
const decodeBody = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const gatewayModelSettingsKey = "antigravityModelID"
const efforts = ["minimal", "low", "medium", "high", "max"] as const
type Effort = (typeof efforts)[number]
type ModelRow = { id: string; entry: typeof ModelEntry.Type }
type EffortRow = ModelRow & { effort: Effort; name: string }

function thinkingSettings(entry: typeof ModelEntry.Type) {
  if (entry.supportsThinking !== true) return undefined
  const level =
    entry.thinkingLevel === 1
      ? "low"
      : entry.thinkingLevel === 2
        ? "medium"
        : entry.thinkingLevel === 3
          ? "high"
          : entry.thinkingLevel === 4
            ? "minimal"
            : undefined
  return {
    thinkingConfig: {
      includeThoughts: true,
      ...(level !== undefined
        ? { thinkingLevel: level }
        : entry.thinkingBudget !== undefined
          ? { thinkingBudget: entry.thinkingBudget }
          : {}),
    },
  }
}

function effortRow(row: ModelRow): (EffortRow & { base: string }) | undefined {
  const match = /-(minimal|low|medium|high|max)$/.exec(row.id)
  const effort = efforts.find((item) => item === match?.[1])
  if (!match || !effort) return undefined
  const displayName = row.entry.displayName
  if (displayName !== undefined) {
    const name = /^(.*)\s\((Minimal|Low|Medium|High|Max)\)$/.exec(displayName)
    if (!name || name[2].toLowerCase() !== effort) return undefined
    return { ...row, effort, name: name[1], base: row.id.slice(0, -match[0].length) }
  }
  const base = row.id.slice(0, -match[0].length)
  return { ...row, effort, name: base, base }
}

function catalogModel(id: string, row: ModelRow, extra: Partial<CatalogModel.Info> = {}) {
  const entry = row.entry
  const image = id.includes("image")
  return CatalogModel.Info.make({
    ...CatalogModel.Info.empty(providerID, CatalogModel.ID.make(id)),
    name: entry.displayName ?? id,
    package: Provider.aisdk("@ai-sdk/google"),
    settings: thinkingSettings(entry),
    capabilities: {
      tools: !image,
      input: [
        "text",
        ...(entry.supportsImages ? ["image"] : []),
        ...(entry.supportsVideo ? ["video"] : []),
        ...(entry.supportsPdf ? ["pdf"] : []),
      ],
      output: image ? ["text", "image"] : ["text"],
    },
    limit: {
      context:
        entry.maxTokens !== undefined && Number.isInteger(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : 0,
      output: entry.maxOutputTokens ?? 8192,
    },
    ...extra,
  })
}
type Fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>
type Pkce = { verifier: string; challenge: string }

const projectIDOf = (value: string | { id?: string } | undefined) =>
  typeof value === "string" ? value || undefined : value?.id

const oauthClient = Schema.decodeUnknownEffect(
  Schema.Struct({
    clientID: Schema.NonEmptyString,
    clientSecret: Schema.RedactedFromValue(Schema.NonEmptyString),
  }),
)(typeof YCODING_ANTIGRAVITY_OAUTH === "undefined" ? {} : YCODING_ANTIGRAVITY_OAUTH).pipe(
  Effect.mapError(
    () =>
      new Error(
        "Antigravity OAuth requires YCODING_ANTIGRAVITY_CLIENT_ID and YCODING_ANTIGRAVITY_CLIENT_SECRET at build time.",
      ),
  ),
)

const tokenRequest = Effect.fnUntraced(function* (http: HttpClient.HttpClient, form: URLSearchParams) {
  const client = yield* oauthClient
  form.set("client_id", client.clientID)
  form.set("client_secret", Redacted.value(client.clientSecret))
  const response = yield* http.execute(
    HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader("User-Agent", antigravityUserAgent()),
      HttpClientRequest.bodyText(form.toString(), "application/x-www-form-urlencoded"),
    ),
  )
  const token = yield* HttpClientResponse.schemaBodyJson(Token)(response).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (!token?.access_token)
    return yield* Effect.fail(
      new Error(token?.error ? `Google authorization failed: ${token.error}` : reconnect),
    )
  return token
})

export const exchangeAntigravityCode = Effect.fn("Antigravity.exchange")(function* (
  http: HttpClient.HttpClient,
  code: string,
  verifier: string,
) {
  const token = yield* tokenRequest(
    http,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectURI,
      code_verifier: verifier,
    }),
  )
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: token.access_token!,
    refresh: token.refresh_token ?? "",
    expires: (yield* Clock.currentTimeMillis) + (token.expires_in ?? 3600) * 1000,
  })
})

const refreshAntigravity = Effect.fn("Antigravity.refresh")(function* (
  http: HttpClient.HttpClient,
  value: Credential.OAuth,
) {
  if (!value.refresh) return yield* Effect.fail(new Error(reconnect))
  const token = yield* tokenRequest(
    http,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: value.refresh }),
  )
  return Credential.OAuth.make({
    type: "oauth",
    methodID: value.methodID,
    access: token.access_token!,
    refresh: token.refresh_token ?? value.refresh,
    expires: (yield* Clock.currentTimeMillis) + (token.expires_in ?? 3600) * 1000,
    ...(value.metadata ? { metadata: value.metadata } : {}),
  })
})

const apiPost = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  access: string,
  action: string,
  body: unknown,
  onboard = false,
) {
  const base = HttpClientRequest.post(`${antigravityBaseURL}/v1internal:${action}`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(access),
    HttpClientRequest.setHeader(
      "User-Agent",
      onboard ? `${antigravityUserAgent()} google-api-nodejs-client/10.3.0` : antigravityUserAgent(),
    ),
    HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
  )
  const response = yield* http.execute(
    onboard
      ? base.pipe(HttpClientRequest.setHeader("X-Goog-Api-Client", `gl-node/${process.versions.node}`))
      : base,
  )
  if (response.status === 401 || response.status === 403) return yield* Effect.fail(new Error(reconnect))
  if (response.status < 200 || response.status >= 300)
    return yield* Effect.fail(new Error(`Antigravity ${action} failed: ${response.status}`))
  return response
})

export const discoverAntigravityProject = Effect.fn("Antigravity.discoverProject")(function* (
  http: HttpClient.HttpClient,
  access: string,
) {
  const loaded = yield* apiPost(http, access, "loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(LoadCodeAssist)),
  )
  const existing = projectIDOf(loaded.cloudaicompanionProject)
  if (existing) return existing
  const tiers = loaded.allowedTiers ?? []
  const tierId = tiers.find((tier) => tier.isDefault)?.id ?? tiers[0]?.id ?? loaded.currentTier?.id ?? "free-tier"
  for (let attempt = 0; attempt < 15; attempt++) {
    const onboarded = yield* apiPost(
      http,
      access,
      "onboardUser",
      {
        tier_id: tierId,
        metadata: { ide_type: "ANTIGRAVITY", ide_version: clientVersion, ide_name: "antigravity" },
      },
      true,
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(OnboardUser)))
    if (onboarded.done) return projectIDOf(onboarded.response?.cloudaicompanionProject)
    yield* Effect.sleep("2 seconds")
  }
  return undefined
})

export const discoverAntigravityModels = Effect.fn("Antigravity.discoverModels")(function* (
  http: HttpClient.HttpClient,
  access: string,
  project: string | undefined,
) {
  const response = yield* apiPost(
    http,
    access,
    "fetchAvailableModels",
    project ? { project } : {},
  ).pipe(
    Effect.flatMap(
      HttpClientResponse.schemaBodyJson(
        Schema.Struct({
          models: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
          deprecatedModelIds: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    ),
  )
  const deprecated = new Set(Object.keys(response.deprecatedModelIds ?? {}))
  const rows = Object.entries(response.models ?? {})
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([id, row]) => {
      const entry = Option.getOrUndefined(decodeEntry(row))
      if (!entry || entry.disabled === true || entry.isInternal === true || deprecated.has(id)) return []
      return [{ id, entry }]
    })
  const groups = new Map<string, { base?: ModelRow; efforts: EffortRow[] }>()
  for (const row of rows) {
    const parsed = effortRow(row)
    const key = parsed?.base ?? row.id
    const group = groups.get(key) ?? { efforts: [] }
    if (parsed) group.efforts.push(parsed)
    if (!parsed) group.base = row
    groups.set(key, group)
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([base, group]) => {
      if (group.efforts.length === 0 && group.base) return [catalogModel(base, group.base)]
      const [first] = group.efforts
      if (group.base === undefined && group.efforts.length === 1 && first) return [catalogModel(first.id, first)]
      const preferred = (["medium", "high", "low", "max", "minimal"] as const).flatMap(
        (effort) => group.efforts.find((row) => row.effort === effort) ?? [],
      )[0]
      const pick = group.base ?? preferred ?? first
      if (!pick) return []
      const variants = group.efforts
        .toSorted((left, right) => efforts.indexOf(left.effort) - efforts.indexOf(right.effort))
        .map((row) => ({
          id: CatalogModel.VariantID.make(row.effort),
          settings: { ...thinkingSettings(row.entry), [gatewayModelSettingsKey]: row.id },
        }))
      return [
        catalogModel(base, pick, {
          modelID: CatalogModel.ID.make(pick.id),
          name: group.base ? (pick.entry.displayName ?? base) : ((preferred ?? first)?.name ?? base),
          variants,
        }),
      ]
    })
})

export function createAntigravityFetch(
  send: Fetch,
  session: { access: string; project?: string; model?: string },
): Fetch {
  const wrapped: Fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url)
    const match = url.pathname.match(/\/models\/([^/:]+):(streamGenerateContent|generateContent)$/)
    if (!match) return send(input, init)
    const model = session.model ?? decodeURIComponent(match[1]!)
    const action = match[2]!
    const body = typeof init?.body === "string" ? Option.getOrUndefined(decodeBody(init.body)) : undefined
    const request = stripTrailingModelContents(body)
    const headers = new Headers(init?.headers)
    headers.delete("x-goog-api-key")
    headers.set("authorization", `Bearer ${session.access}`)
    headers.set("user-agent", antigravityUserAgent())
    headers.set("content-type", "application/json")
    const response = await send(`${antigravityBaseURL}/v1internal:${action}${url.search}`, {
      ...init,
      headers,
      body: JSON.stringify({
        ...(session.project ? { project: session.project } : {}),
        model,
        userAgent: "antigravity",
        requestType: "agent",
        requestId: `agent-${crypto.randomUUID()}`,
        request: request ?? {},
      }),
    })
    if (!response.ok || !response.body) return response
    if (response.headers.get("content-type")?.includes("text/event-stream")) return unwrapStream(response)
    const text = await response.text()
    const payload = Option.getOrUndefined(decodeBody(text))
    if (!payload || typeof payload !== "object" || !("response" in payload))
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
    return new Response(JSON.stringify((payload as { response: unknown }).response), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  return wrapped
}

function stripTrailingModelContents(body: unknown) {
  if (!body || typeof body !== "object" || !("contents" in body) || !Array.isArray(body.contents)) return body
  const contents = [...body.contents]
  while (contents.length > 0) {
    const last = contents[contents.length - 1]
    if (!last || typeof last !== "object" || !("role" in last) || last.role !== "model") break
    contents.pop()
  }
  return contents.length === body.contents.length ? body : { ...body, contents }
}

function unwrapStream(response: Response) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const frames: string[] = []
  const partial: string[] = []
  const parser = Sse.makeParser((event) => {
    if (event._tag === "Retry") {
      frames.push(Sse.encoder.write(event))
      return
    }
    const payload = Option.getOrUndefined(decodeBody(event.data))
    frames.push(
      Sse.encoder.write({
        ...event,
        data:
          payload && typeof payload === "object" && "response" in payload
            ? JSON.stringify(payload.response)
            : event.data,
      }),
    )
  })
  const stream = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const lines = decoder.decode(chunk, { stream: true }).split("\n")
        for (const [index, line] of lines.entries()) {
          partial.push(line)
          if (index === lines.length - 1) continue
          parser.feed(`${partial.join("").replace(/\r$/, "")}\n`)
          partial.length = 0
        }
        if (frames.length > 0) controller.enqueue(encoder.encode(frames.splice(0).join("")))
      },
      flush(controller) {
        partial.push(decoder.decode())
        parser.feed(`${partial.join("").replace(/\r$/, "")}\n\n`)
        if (frames.length > 0) controller.enqueue(encoder.encode(frames.join("")))
      },
    }),
  )
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function generatePKCE(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(64)), (byte) => chars[byte % chars.length]).join("")
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
    "base64url",
  )
  return { verifier, challenge }
}

export function antigravityOAuth(http: HttpClient.HttpClient) {
  return {
    integrationID,
    method: { id: methodID, type: "oauth", label: "Google account (Antigravity subscription)" },
    authorize: (_inputs: Integration.Inputs) =>
      Effect.gen(function* () {
        const client = yield* oauthClient
        const pkce = yield* Effect.promise(generatePKCE)
        const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
        const code = yield* Deferred.make<string, Error>()
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", redirectURI)
          if (url.pathname !== "/oauth-callback") {
            response.writeHead(404).end("Not found")
            return
          }
          const error = url.searchParams.get("error")
          const value = url.searchParams.get("code")
          if (error) {
            Effect.runFork(Deferred.fail(code, new Error(error)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(error, { provider: "Antigravity" }))
            return
          }
          if (!value || url.searchParams.get("state") !== state) {
            const message = value ? "Invalid OAuth state" : "Missing authorization code"
            Effect.runFork(Deferred.fail(code, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "Antigravity" }))
            return
          }
          Effect.runFork(Deferred.succeed(code, value))
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.success({ provider: "Antigravity" }))
        })
        yield* Effect.callback<void, Error>((resume) => {
          server.once("error", (error) => resume(Effect.fail(error)))
          server.listen(callbackPort, "localhost", () => resume(Effect.void))
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
        const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
          client_id: client.clientID,
          response_type: "code",
          redirect_uri: redirectURI,
          scope: scopes.join(" "),
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "consent",
        })}`
        return {
          mode: "auto" as const,
          url,
          instructions: "Complete Google sign-in in your browser. This window will close automatically.",
          callback: Deferred.await(code).pipe(
            Effect.flatMap((value) => exchangeAntigravityCode(http, value, pkce.verifier)),
            Effect.flatMap((credential) =>
              discoverAntigravityProject(http, credential.access).pipe(
                Effect.timeout("60 seconds"),
                Effect.catch(() => Effect.succeed(undefined)),
                Effect.map((project) =>
                  project
                    ? Credential.OAuth.make({ ...credential, metadata: { ...credential.metadata, projectID: project } })
                    : credential,
                ),
              ),
            ),
          ),
        }
      }),
    refresh: (value: Credential.OAuth) => refreshAntigravity(http, value),
  } satisfies IntegrationOAuthMethodRegistration
}

export const AntigravityPlugin = define({
  id: "ycoding.provider.antigravity",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const aisdk = yield* AISDK.Service
    const catalog = yield* Catalog.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const events = yield* EventRuntime.Service
    const loading = Semaphore.makeUnsafe(1)
    const loaded: {
      accounts: readonly { snapshot: Integration.Snapshot; project?: string; models: readonly CatalogModel.Info[] }[]
      source?: string
    } = { accounts: [] }
    const storedProject = (snapshot: Integration.Snapshot) => {
      const value = snapshot.value?.type === "oauth" ? snapshot.value.metadata?.projectID : undefined
      return typeof value === "string" && value ? value : undefined
    }
    const source = Effect.fn(function* () {
      return JSON.stringify(
        (yield* credentials.list(integrationID)).map((credential) => [
          credential.id,
          credential.generation,
          credential.accountGeneration,
        ]),
      )
    })
    const load = Effect.fn("AntigravityPlugin.load")(function* () {
      const fingerprint = yield* source()
      const saved = yield* credentials.list(integrationID)
      const previous = loaded.accounts
      let failed = false
      loaded.accounts = (yield* Effect.forEach(
        saved,
        (credential) =>
          Effect.gen(function* () {
            const snapshot = yield* integrations.connection
              .snapshot({ type: "credential", id: credential.id, label: credential.label, active: credential.active })
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!snapshot || snapshot.value?.type !== "oauth") return undefined
            const retained = previous.find(
              (account) =>
                account.snapshot.credential?.id === snapshot.credential?.id &&
                account.snapshot.credential?.accountGeneration === snapshot.credential?.accountGeneration,
            )
            const project = yield* (
              storedProject(snapshot)
                ? Effect.succeed(storedProject(snapshot))
                : discoverAntigravityProject(http, snapshot.value.access)
            ).pipe(
              Effect.timeout("60 seconds"),
              Effect.catch(() =>
                Effect.logWarning("failed to discover the Antigravity project").pipe(Effect.as(retained?.project)),
              ),
            )
            const models = yield* discoverAntigravityModels(http, snapshot.value.access, project).pipe(
              Effect.timeout("15 seconds"),
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to sync Antigravity models; check the subscription and reconnect Antigravity if the account token expired",
                ).pipe(Effect.as(undefined)),
              ),
            )
            if (models === undefined) failed = true
            return { snapshot, project: project ?? retained?.project, models: models ?? retained?.models ?? [] }
          }),
        { concurrency: "unbounded" },
      )).filter((account) => account !== undefined)
      loaded.source = failed ? undefined : fingerprint
    })
    yield* ctx.integration.transform((draft) => {
      draft.update(integrationID, (integration) => (integration.name = "Antigravity"))
      draft.method.update(antigravityOAuth(http))
    })
    yield* catalog.transform((draft) => {
      draft.provider.update(providerID, (provider) => {
        provider.name = "Antigravity"
        provider.package = Provider.aisdk("@ai-sdk/google")
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
    yield* ctx.integration
      .reload()
      .pipe(
        Effect.andThen(reconcile().pipe(Effect.repeat(Schedule.spaced("60 seconds")), Effect.ignore)),
        Effect.forkScoped,
      )
    yield* aisdk.hook.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== providerID || evt.package !== "@ai-sdk/google") return
        const snapshot = evt.snapshot
        const send: Fetch = typeof evt.options.fetch === "function" ? evt.options.fetch : fetch
        if (!snapshot || snapshot.value?.type !== "oauth") {
          evt.options.fetch = () => Promise.reject(new Error("Run ycoding, then /connect and choose Antigravity."))
        } else {
          const account = loaded.accounts.find((item) => item.snapshot.credential?.id === snapshot.credential?.id)
          const gatewayModel = evt.model.settings?.[gatewayModelSettingsKey]
          delete evt.options[gatewayModelSettingsKey]
          evt.options.fetch = createAntigravityFetch(send, {
            access: snapshot.value.access,
            project: account?.project ?? storedProject(snapshot),
            ...(typeof gatewayModel === "string" ? { model: gatewayModel } : {}),
          })
        }
        evt.options.apiKey = "antigravity"
        const { createGoogleGenerativeAI } = yield* Effect.promise(() => import("@ai-sdk/google"))
        evt.sdk = createGoogleGenerativeAI(evt.options)
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)
