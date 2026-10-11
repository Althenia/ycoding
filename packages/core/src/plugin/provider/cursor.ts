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
import { AISDK } from "../../aisdk"
import { Catalog } from "../../catalog"
import { SessionRunnerModel } from "../../session/runner/model"
import { Hash } from "../../util/hash"
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
  method: { id: methodID, type: "oauth", label: "Cursor account (browser login)", remote: true },
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
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const aisdk = yield* AISDK.Service
    const cacheDir = path.join(global.cache, "cursor")
    const loading = Semaphore.makeUnsafe(1)
    const profileCacheDir = (snapshot: Integration.Snapshot | undefined, key?: string) =>
      path.join(
        cacheDir,
        snapshot?.credential
          ? SessionRunnerModel.accountIdentityDigest(snapshot.credential)
          : Hash.sha256(JSON.stringify(["cursor-auth", snapshot?.value?.type === "key" ? snapshot.value.key : key])),
      )
    const loaded: {
      accounts: readonly { snapshot: Integration.Snapshot; models: readonly CatalogModel.Info[] }[]
      source?: string
    } = { accounts: [] }

    const source = Effect.fn("CursorPlugin.source")(function* () {
      return JSON.stringify([
        (yield* credentials.list(integrationID)).map((credential) => [
          credential.id,
          credential.generation,
          credential.accountGeneration,
        ]),
        process.env.CURSOR_API_KEY,
      ])
    })

    const load = Effect.fn("CursorPlugin.load")(function* () {
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
      loaded.accounts = (yield* Effect.forEach(
        connections,
        (connection) =>
          Effect.gen(function* () {
            const snapshot = yield* integrations.connection
              .snapshot(connection)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            const token =
              snapshot?.value?.type === "key"
                ? snapshot.value.key
                : snapshot?.value?.type === "oauth"
                  ? snapshot.value.access
                  : undefined
            if (!snapshot || !token) return undefined
            const directory = profileCacheDir(snapshot, token)
            const discovered = yield* Effect.tryPromise({
              try: async () => {
                const { discoverModels } = await import("../../cursor/provider/models")
                return CursorModels.fromCursor(
                  await discoverModels(await resolveBearerToken({ apiKey: token }), directory),
                )
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to sync Cursor models", { cause }).pipe(Effect.as(undefined)),
              ),
            )
            if (discovered === undefined) failed = true
            const retained = previous.find((account) =>
              snapshot.credential
                ? account.snapshot.credential?.id === snapshot.credential.id &&
                  account.snapshot.credential.accountGeneration === snapshot.credential.accountGeneration
                : account.snapshot.connection.type === "env",
            )
            return { snapshot, models: discovered ?? retained?.models ?? [] }
          }),
        { concurrency: "unbounded" },
      )).filter((account) => account !== undefined)
      loaded.source = failed ? undefined : fingerprint
    })

    yield* ctx.integration.transform((draft) => {
      draft.update(integrationID, (integration) => (integration.name = "Cursor"))
      draft.method.update(oauth)
      draft.method.update({ integrationID, method: { type: "key", label: "Cursor API key (crsr_…)" } })
      draft.method.update({ integrationID, method: { type: "env", names: ["CURSOR_API_KEY"] } })
    })
    yield* catalog.transform((draft) => {
      syncCatalog(draft, [
        ...new Map(
          loaded.accounts.flatMap((account) => account.models.map((model) => [model.id, model] as const)),
        ).values(),
      ])
      draft.model.account.clear(CursorModels.providerID)
      for (const account of loaded.accounts)
        if (account.snapshot.credential)
          draft.model.account.update(account.snapshot.credential, CursorModels.providerID, account.models)
    })
    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    const reconcile = () =>
      source().pipe(Effect.flatMap((value) => (value === loaded.source ? Effect.void : refresh())))
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
    yield* aisdk.hook.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== CursorModels.packageName) return
        const { createCursor } = yield* Effect.promise(() => import("../../cursor/provider"))
        evt.sdk = createCursor({
          name: CursorModels.providerID,
          apiKey: typeof evt.options.apiKey === "string" ? evt.options.apiKey : undefined,
          cacheDir: profileCacheDir(
            evt.snapshot,
            typeof evt.options.apiKey === "string" ? evt.options.apiKey : undefined,
          ),
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
    get: (providerID: Provider.ID) => { models: ReadonlyMap<CatalogModel.ID, unknown> } | undefined
    update: (
      providerID: Provider.ID,
      update: (provider: { name: string; package: string; integrationID?: Integration.ID }) => void,
    ) => void
  }
  model: {
    remove: (providerID: Provider.ID, modelID: CatalogModel.ID) => void
    update: (providerID: Provider.ID, modelID: CatalogModel.ID, update: (model: object) => void) => void
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
