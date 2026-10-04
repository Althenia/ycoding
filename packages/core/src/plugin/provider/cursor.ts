import path from "path"
import type { IntegrationOAuthMethodRegistration } from "@ycoding-ai/plugin/effect/integration"
import { define } from "@ycoding-ai/plugin/effect/plugin"
import {
  buildLoginUrl,
  decodeJwtExpiryMs,
  generatePkceChallenge,
  generatePkceParams,
  pollForTokens,
  refreshAccessToken,
  resolveBearerToken,
  type TokenPair,
} from "../../cursor/provider/auth"
import { Effect, Schedule, Semaphore, Stream } from "effect"
import { Credential } from "../../credential"
import { CursorModels } from "../../cursor/models"
import { EventRuntime } from "../../event"
import { Global } from "../../global"
import { Integration } from "../../integration"
import { Location } from "../../location"
import type { CatalogModel } from "../../model"
import { Provider } from "../../provider"
import type { PluginInternal } from "../internal"

const integrationID = Integration.ID.make("cursor")
const methodID = Integration.MethodID.make("browser")

// Connection events are process-local, so a credential stored by another process, or an event
// published before this plugin subscribed, would otherwise leave a connected account with no
// models until the next connection change. The reconcile also retries a failed sync.
export const reconcileInterval = "60 seconds"

export const oauth = {
  integrationID,
  method: { id: methodID, type: "oauth", label: "Cursor account (browser login)" },
  authorize: () =>
    Effect.gen(function* () {
      const pkce = generatePkceParams()
      const challenge = yield* Effect.promise(() => generatePkceChallenge(pkce.verifier))
      return {
        mode: "auto" as const,
        url: buildLoginUrl(challenge, pkce.uuid),
        instructions: "Complete sign-in to Cursor in your browser.",
        callback: Effect.tryPromise({
          try: (signal) => pollForTokens(pkce.uuid, pkce.verifier, undefined, signal),
          catch: (cause) => cause,
        }).pipe(Effect.map(oauthCredential)),
      }
    }),
  refresh: (credential) =>
    Effect.tryPromise({
      try: () => refreshAccessToken(credential.refresh),
      catch: (cause) => cause,
    }).pipe(Effect.map(oauthCredential)),
} satisfies IntegrationOAuthMethodRegistration

export const CursorPlugin = define({
  id: "ycoding.provider.cursor",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventRuntime.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const cacheDir = path.join(global.cache, "cursor")
    const loading = Semaphore.makeUnsafe(1)
    const loaded: { models: readonly CatalogModel.Info[]; source?: string } = { models: [] }

    const activeToken = Effect.fn("CursorPlugin.activeToken")(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      return credential?.type === "key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined
    })

    const load = Effect.fn("CursorPlugin.load")(function* () {
      const token = yield* activeToken()
      if (!token) {
        loaded.models = []
        loaded.source = undefined
        return
      }
      const discovered = yield* Effect.tryPromise({
        try: async () => {
          const { discoverModels } = await import("../../cursor/provider/models")
          return CursorModels.fromCursor(await discoverModels(await resolveBearerToken({ apiKey: token }), cacheDir))
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to sync Cursor models", { cause }).pipe(Effect.as(undefined)),
        ),
      )
      // A failed sync keeps the inventory an earlier sync published, so one timeout cannot empty a
      // connected account's model list. Leaving the source unset makes the next reconcile retry.
      if (discovered === undefined) return
      loaded.models = discovered
      loaded.source = token
    })

    yield* ctx.integration.transform((draft) => {
      draft.update(integrationID, (integration) => (integration.name = "Cursor"))
      draft.method.update(oauth)
      draft.method.update({ integrationID, method: { type: "key", label: "Cursor API key (crsr_…)" } })
      draft.method.update({ integrationID, method: { type: "env", names: ["CURSOR_API_KEY"] } })
    })
    yield* ctx.catalog.transform((draft) => syncCatalog(draft, loaded.models))
    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    const reconcile = () =>
      activeToken().pipe(Effect.flatMap((token) => (token === loaded.source ? Effect.void : refresh())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    // Schedule.spaced runs the effect once, then waits between completions.
    yield* ctx.integration
      .reload()
      .pipe(
        Effect.andThen(reconcile().pipe(Effect.repeat(Schedule.spaced(reconcileInterval)), Effect.ignore)),
        Effect.forkScoped,
      )
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.package !== CursorModels.packageName) return
        const { createCursor } = yield* Effect.promise(() => import("../../cursor/provider"))
        evt.sdk = createCursor({
          name: CursorModels.providerID,
          apiKey: typeof evt.options.apiKey === "string" ? evt.options.apiKey : undefined,
          cacheDir,
          workspaceRoot: location.directory,
        })
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

export function syncCatalog(catalog: CursorCatalog, models: readonly CatalogModel.Info[]) {
  catalog.provider.update(CursorModels.providerID, (provider) => {
    provider.name = "Cursor"
    provider.package = Provider.aisdk(CursorModels.packageName)
    provider.integrationID = integrationID
  })
  const discovered = new Set<string>(models.map((model) => model.id))
  for (const id of catalog.provider.get(CursorModels.providerID)?.models.keys() ?? []) {
    if (!discovered.has(id)) catalog.model.remove(CursorModels.providerID, id)
  }
  for (const model of models) {
    catalog.model.update(CursorModels.providerID, model.id, (draft) => Object.assign(draft, structuredClone(model)))
  }
}

type CursorCatalog = {
  provider: {
    get: (providerID: string) => { models: ReadonlyMap<string, unknown> } | undefined
    update: (
      providerID: string,
      update: (provider: { name: string; package: string; integrationID?: string }) => void,
    ) => void
  }
  model: {
    remove: (providerID: string, modelID: string) => void
    update: (providerID: string, modelID: string, update: (model: object) => void) => void
  }
}

export function oauthCredential(tokens: TokenPair) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: decodeJwtExpiryMs(tokens.accessToken) ?? 0,
  })
}
