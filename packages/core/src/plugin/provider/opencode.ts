import { Duration, Effect, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@ycoding-ai/plugin/effect/integration"
import { define } from "@ycoding-ai/plugin/effect/plugin"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EventV2 } from "../../event"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { Config } from "../../config"
import { Money } from "@ycoding-ai/schema/money"

const defaultServer = "https://console.opencode.ai"
const clientID = "opencode-cli"
const methodID = Integration.MethodID.make("device")
const RemoteResponse = Schema.Struct({ config: Config.Info })
const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
})
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
})
const TokenPending = Schema.Struct({ error: Schema.String })
const DeviceToken = Schema.Union([Token, TokenPending])
const User = Schema.Struct({ id: Schema.String, email: Schema.String })
const Org = Schema.Struct({ id: Schema.String, name: Schema.String })

function oauth(http: HttpClient.HttpClient) {
  return {
    integrationID: Integration.ID.make("opencode"),
    method: {
      id: methodID,
      type: "oauth",
      label: "OpenCode Console account",
    },
    authorize: (inputs) =>
      Effect.gen(function* () {
        const server = yield* normalizeServer(inputs.server ?? defaultServer)
        const device = yield* post(http, `${server}/auth/device/code`, { client_id: clientID }, Device)
        const verification = URL.canParse(device.verification_uri_complete)
          ? new URL(device.verification_uri_complete)
          : undefined
        if (verification && verification.protocol !== "http:" && verification.protocol !== "https:") {
          return yield* Effect.fail(new Error("Invalid device verification URL: expected HTTP(S)"))
        }
        return {
          mode: "auto" as const,
          url: verification?.href ?? `${server}/${device.verification_uri_complete.replace(/^\/+/, "")}`,
          instructions: `Enter code: ${device.user_code}`,
          callback: poll(http, server, device.device_code, Duration.seconds(device.interval)),
        }
      }),
    refresh: (credential) =>
      Effect.gen(function* () {
        const server = typeof credential.metadata?.server === "string" ? credential.metadata.server : defaultServer
        const token = yield* post(
          http,
          `${server}/auth/device/token`,
          { grant_type: "refresh_token", refresh_token: credential.refresh, client_id: clientID },
          Token,
        )
        return {
          ...credential,
          access: token.access_token,
          refresh: token.refresh_token,
          expires: Date.now() + token.expires_in * 1000,
        }
      }),
    label: (credential) => {
      return typeof credential.metadata?.orgName === "string" ? credential.metadata.orgName : undefined
    },
  } satisfies IntegrationOAuthMethodRegistration
}

export const OpencodePlugin = define<HttpClient.HttpClient | EventV2.Service | Scope.Scope>({
  id: "opencode.provider.opencode",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const http = yield* HttpClient.HttpClient
    const loading = Semaphore.makeUnsafe(1)
    let connected = false
    let providers: typeof Config.Info.Type.providers | undefined

    const load = Effect.fn("OpencodePlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active("opencode")
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      connected = connection !== undefined
      providers = credential
        ? yield* fetchProviders(http, credential).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to load OpenCode provider config", { cause }).pipe(Effect.as(undefined)),
            ),
          )
        : undefined
    })

    yield* ctx.integration.transform((draft) => {
      draft.update("opencode", (integration) => {
        integration.name = "OpenCode"
      })
      draft.method.update(oauth(http))
      draft.method.update({ integrationID: "opencode", method: { type: "key", label: "API key (service account)" } })
    })

    yield* load()
    yield* ctx.catalog.transform((catalog) => {
      for (const [providerID, item] of Object.entries(providers ?? {})) {
        catalog.provider.update(providerID, (provider) => {
          provider.integrationID = Integration.ID.make("opencode")
          if (item.name !== undefined) provider.name = item.name
          if (item.package !== undefined) provider.package = item.package
          if (item.settings !== undefined)
            provider.settings = ProviderV2.mergeOverlay(provider.settings, withoutCredentials(item.settings))
          if (item.headers !== undefined) provider.headers = ProviderV2.mergeHeaders(provider.headers, item.headers)
          if (item.body !== undefined) provider.body = ProviderV2.mergeOverlay(provider.body, item.body)
        })

        for (const [modelID, config] of Object.entries(item.models ?? {})) {
          catalog.model.update(providerID, modelID, (model) => {
            if (config.family !== undefined) model.family = config.family
            if (config.name !== undefined) model.name = config.name
            if (config.modelID !== undefined) model.modelID = config.modelID
            if (config.package !== undefined) model.package = config.package
            if (config.settings !== undefined)
              model.settings = ProviderV2.mergeOverlay(model.settings, withoutCredentials(config.settings))
            if (config.headers !== undefined) model.headers = ProviderV2.mergeHeaders(model.headers, config.headers)
            if (config.body !== undefined) model.body = ProviderV2.mergeOverlay(model.body, config.body)
            if (config.capabilities?.tools !== undefined) model.capabilities.tools = config.capabilities.tools
            if (config.capabilities?.input !== undefined) model.capabilities.input = [...config.capabilities.input]
            if (config.capabilities?.output !== undefined) model.capabilities.output = [...config.capabilities.output]
            if (config.variants !== undefined) {
              model.variants ??= []
              for (const variant of config.variants) {
                let existing = model.variants.find((candidate) => candidate.id === variant.id)
                if (!existing) {
                  existing = { id: variant.id }
                  model.variants.push(existing)
                }
                if (variant.settings !== undefined)
                  existing.settings = ProviderV2.mergeOverlay(existing.settings, withoutCredentials(variant.settings))
                if (variant.headers !== undefined)
                  existing.headers = ProviderV2.mergeHeaders(existing.headers, variant.headers)
                if (variant.body !== undefined) existing.body = ProviderV2.mergeOverlay(existing.body, variant.body)
              }
            }
            if (config.cost !== undefined) {
              model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                tier: cost.tier && { ...cost.tier },
                input: cost.input,
                output: cost.output,
                cache: {
                  read: cost.cache?.read ?? Money.USDPerMillionTokens.zero,
                  write: cost.cache?.write ?? Money.USDPerMillionTokens.zero,
                },
              }))
            }
            if (config.disabled !== undefined) model.enabled = !config.disabled
            if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
          })
        }
      }

      const item = catalog.provider.get(ProviderV2.ID.opencode)
      if (!item) return
      const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || item.provider.settings?.apiKey)
      catalog.provider.update(item.provider.id, (provider) => {
        if (!hasKey) provider.settings = { ...provider.settings, apiKey: "public" }
      })
      if (hasKey) return
      for (const model of item.models.values()) {
        if (!model.cost.some((cost) => cost.input > 0)) continue
        catalog.model.update(item.provider.id, model.id, (draft) => {
          draft.enabled = false
        })
      }
    })

    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === Integration.ID.make("opencode")),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function fetchProviders(
  http: HttpClient.HttpClient,
  value:
    | { readonly type: "oauth"; readonly access: string; readonly metadata?: Readonly<Record<string, unknown>> }
    | { readonly type: "key"; readonly key: string; readonly metadata?: Readonly<Record<string, unknown>> },
) {
  const metadata = value.metadata
  const server = typeof metadata?.server === "string" ? metadata.server : defaultServer
  const orgID = typeof metadata?.orgID === "string" ? metadata.orgID : undefined
  const token = value.type === "oauth" ? value.access : value.key
  return http
    .execute(
      HttpClientRequest.get(`${server}/api/config`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders(orgID ? { "x-org-id": orgID } : {}),
      ),
    )
    .pipe(
      Effect.flatMap((response) => {
        if (response.status === 404) return Effect.succeed(undefined)
        return HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RemoteResponse)),
          Effect.map((remote) => remote.config.providers),
        )
      }),
    )
}

function withoutCredentials(body: Readonly<Record<string, unknown>> | undefined) {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== "apiKey" && key !== "headers"))
}

function normalizeServer(input: string) {
  return Effect.try({
    try: () => {
      const url = new URL(input)
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("expected HTTP(S)")
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
    },
    catch: (cause) =>
      new Error(`Invalid OpenCode server URL: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
}

function poll(http: HttpClient.HttpClient, server: string, deviceCode: string, interval: Duration.Duration) {
  const loop = (wait: Duration.Duration): Effect.Effect<Credential.OAuth, unknown> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* post(
        http,
        `${server}/auth/device/token`,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientID,
        },
        DeviceToken,
        false,
      )
      if ("access_token" in result) return yield* credential(http, server, result)
      if (result.error === "authorization_pending") return yield* loop(wait)
      if (result.error === "slow_down") {
        return yield* loop(Duration.sum(wait, Duration.seconds(5)))
      }
      return yield* Effect.fail(new Error(`Device authorization failed: ${result.error}`))
    })
  return loop(interval)
}

function credential(http: HttpClient.HttpClient, server: string, token: typeof Token.Type) {
  return Effect.gen(function* () {
    const [user, orgs] = yield* Effect.all(
      [
        get(http, `${server}/api/user`, token.access_token, User),
        get(http, `${server}/api/orgs`, token.access_token, Schema.Array(Org)),
      ],
      { concurrency: 2 },
    )
    const org = orgs.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
    return Credential.OAuth.make({
      type: "oauth" as const,
      methodID,
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
      metadata: {
        server,
        accountID: user.id,
        email: user.email,
        orgID: org?.id,
        orgName: org?.name,
      },
    })
  })
}

function get<S extends Schema.Top>(http: HttpClient.HttpClient, url: string, token: string, schema: S) {
  return HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

function post<S extends Schema.Top>(
  http: HttpClient.HttpClient,
  url: string,
  body: Record<string, string>,
  schema: S,
  statusOk = true,
) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.String))(body),
    Effect.flatMap((request) => http.execute(request)),
    Effect.flatMap((response) => (statusOk ? HttpClientResponse.filterStatusOk(response) : Effect.succeed(response))),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  )
}
