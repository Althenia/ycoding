export * as PluginCatalogHost from "./catalog-host"

import type { Plugin } from "@ycoding-ai/plugin/effect"
import { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { Effect, Schema, type Scope, Stream } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { AISDK } from "../aisdk"
import { Catalog } from "../catalog"
import type { Config } from "../config"
import { Credential } from "../credential"
import { EventRuntime } from "../event"
import type { Global } from "../global"
import { Integration } from "../integration"
import { Location } from "../location"
import { CatalogModel } from "../model"
import type { ModelsDev } from "../models-dev"
import type { Npm } from "../npm"
import { Provider } from "../provider"
import type { ProviderUsageRuntime } from "../provider-usage"
import type { DeepMutable } from "../schema"
import type { WellKnown } from "../wellknown"
import type { PluginRuntime } from "./runtime"

export type Context = Pick<Plugin.Context, "options" | "aisdk" | "catalog" | "event" | "integration">

export type Requirements =
  | AISDK.Service
  | Catalog.Service
  | Config.Service
  | Credential.Service
  | EventRuntime.Service
  | Global.Service
  | HttpClient.HttpClient
  | Integration.Service
  | Location.Service
  | ModelsDev.Service
  | Npm.Service
  | PluginRuntime.Service
  | ProviderUsageRuntime.Service
  | WellKnown.Service
  | Scope.Scope

export interface Contribution<R = Requirements> {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, R>
}

export const define = <R extends Requirements>(plugin: Contribution<R>) => plugin

const mutable = <T>(value: T) => value as DeepMutable<T>
export const make = Effect.fn("PluginCatalogHost.make")(function* () {
  const aisdk = yield* AISDK.Service
  const catalog = yield* Catalog.Service
  const events = yield* EventRuntime.Service
  const integration = yield* Integration.Service
  const location = yield* Location.Service
  const response = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.map((data) => ({
        location: new Location.Info({
          directory: location.directory,
          workspaceID: location.workspaceID,
          project: location.project,
        }),
        data,
      })),
    )

  return {
    options: {},
    aisdk: {
      hook: (name, callback) => {
        if (name === "sdk") {
          return aisdk.hook.sdk((event) => {
            const output = {
              model: mutable(event.model),
              package: event.package,
              options: event.options,
              sdk: event.sdk,
            }
            return Reflect.apply(callback, undefined, [output]).pipe(
              Effect.tap(() => Effect.sync(() => (event.sdk = output.sdk))),
            )
          })
        }
        return aisdk.hook.language((event) => {
          const output = {
            model: mutable(event.model),
            options: event.options,
            sdk: event.sdk,
            language: event.language,
          }
          return Reflect.apply(callback, undefined, [output]).pipe(
            Effect.tap(() => Effect.sync(() => (event.language = output.language))),
          )
        })
      },
    },
    catalog: {
      provider: {
        list: () => response(catalog.provider.available()),
        get: (input) =>
          catalog.provider
            .get(Provider.ID.make(input.providerID))
            .pipe(
              Effect.flatMap((provider) =>
                provider === undefined
                  ? Effect.fail(new Error(`Provider not found: ${input.providerID}`))
                  : response(Effect.succeed(provider)),
              ),
            ),
      },
      model: {
        get: (providerID, modelID) => catalog.model.get(Provider.ID.make(providerID), CatalogModel.ID.make(modelID)),
        list: () => response(catalog.model.available()),
        default: () =>
          response(
            Effect.gen(function* () {
              const model = yield* catalog.model.default()
              const selection = yield* catalog.model.defaultSelection()
              return model && selection ? { ...model, selection } : undefined
            }),
          ),
      },
      reload: catalog.reload,
      transform: (callback) =>
        catalog.transform((draft) => {
          callback({
            provider: {
              list: () => mutable(draft.provider.list()),
              get: (id) => mutable(draft.provider.get(Provider.ID.make(id))),
              update: (id, update) => draft.provider.update(Provider.ID.make(id), update),
              remove: (id) => draft.provider.remove(Provider.ID.make(id)),
            },
            model: {
              get: (providerID, modelID) =>
                mutable(draft.model.get(Provider.ID.make(providerID), CatalogModel.ID.make(modelID))),
              update: (providerID, modelID, update) =>
                draft.model.update(Provider.ID.make(providerID), CatalogModel.ID.make(modelID), update),
              remove: (providerID, modelID) =>
                draft.model.remove(Provider.ID.make(providerID), CatalogModel.ID.make(modelID)),
              default: {
                get: draft.model.default.get,
                set: (providerID, modelID, selection) =>
                  draft.model.default.set(Provider.ID.make(providerID), CatalogModel.ID.make(modelID), {
                    variant:
                      selection?.variant === undefined ? undefined : CatalogModel.VariantID.make(selection.variant),
                    profile: selection?.profile,
                  }),
              },
            },
          })
        }),
    },
    event: {
      subscribe: () => events.subscribe().pipe(Stream.filter(EventManifest.isServer)),
    },
    integration: {
      list: () => response(integration.list()),
      get: (input) => response(integration.get(Integration.ID.make(input.integrationID))),
      connect: {
        key: (input) =>
          integration.connection.key({
            integrationID: Integration.ID.make(input.integrationID),
            key: input.key,
            label: input.label,
          }),
      },
      oauth: {
        connect: (input) =>
          response(
            integration.oauth.connect({
              integrationID: Integration.ID.make(input.integrationID),
              methodID: Integration.MethodID.make(input.methodID),
              inputs: input.inputs,
              label: input.label,
            }),
          ),
        status: (input) =>
          response(
            integration.oauth.status({
              integrationID: Integration.ID.make(input.integrationID),
              attemptID: Integration.AttemptID.make(input.attemptID),
            }),
          ),
        complete: (input) =>
          integration.oauth.complete({
            integrationID: Integration.ID.make(input.integrationID),
            attemptID: Integration.AttemptID.make(input.attemptID),
            code: input.code,
          }),
        cancel: (input) =>
          integration.oauth.cancel({
            integrationID: Integration.ID.make(input.integrationID),
            attemptID: Integration.AttemptID.make(input.attemptID),
          }),
      },
      command: {
        connect: (input) =>
          response(
            integration.command.connect({
              integrationID: Integration.ID.make(input.integrationID),
              methodID: Integration.MethodID.make(input.methodID),
              label: input.label,
            }),
          ),
        status: (input) =>
          response(
            integration.command.status({
              integrationID: Integration.ID.make(input.integrationID),
              attemptID: Integration.AttemptID.make(input.attemptID),
            }),
          ),
        cancel: (input) =>
          integration.command.cancel({
            integrationID: Integration.ID.make(input.integrationID),
            attemptID: Integration.AttemptID.make(input.attemptID),
          }),
      },
      reload: integration.reload,
      connection: {
        active: (id) => integration.connection.active(Integration.ID.make(id)),
        resolve: (connection) =>
          integration.connection.resolve(
            connection.type === "credential" ? { ...connection, id: Credential.ID.make(connection.id) } : connection,
          ),
      },
      transform: (callback) =>
        integration.transform((draft) => {
          callback({
            list: () => mutable(draft.list()),
            get: (id) => mutable(draft.get(Integration.ID.make(id))),
            update: (id, update) => draft.update(Integration.ID.make(id), update),
            remove: (id) => draft.remove(Integration.ID.make(id)),
            method: {
              list: (id) => mutable(draft.method.list(Integration.ID.make(id))),
              update: (input) => {
                if ("authorize" in input) {
                  const methodID = Integration.MethodID.make(input.method.id)
                  const refresh = input.refresh
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { ...input.method, id: methodID },
                    authorize: (inputs) =>
                      input.authorize(inputs).pipe(
                        Effect.map((authorization) => {
                          if (authorization.mode === "auto") {
                            return {
                              ...authorization,
                              callback: authorization.callback.pipe(
                                Effect.map((credential) =>
                                  Credential.OAuth.make({
                                    ...credential,
                                    methodID: Integration.MethodID.make(credential.methodID),
                                  }),
                                ),
                              ),
                            }
                          }
                          return {
                            ...authorization,
                            callback: (code: string) =>
                              authorization.callback(code).pipe(
                                Effect.map((credential) =>
                                  Credential.OAuth.make({
                                    ...credential,
                                    methodID: Integration.MethodID.make(credential.methodID),
                                  }),
                                ),
                              ),
                          }
                        }),
                      ),
                    ...(refresh
                      ? {
                          refresh: (value: Credential.OAuth) =>
                            refresh(value).pipe(
                              Effect.map((next) =>
                                Credential.OAuth.make({
                                  ...next,
                                  methodID: Integration.MethodID.make(next.methodID),
                                }),
                              ),
                            ),
                        }
                      : {}),
                    ...(input.label ? { label: input.label } : {}),
                  })
                  return
                }
                if (input.method.type === "env") {
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { type: "env", names: input.method.names },
                  })
                  return
                }
                if (input.method.type === "command") {
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: Schema.decodeUnknownSync(Integration.CommandMethod)(input.method),
                  })
                  return
                }
                draft.method.update({
                  integrationID: Integration.ID.make(input.integrationID),
                  method: { type: "key", label: input.method.label },
                })
              },
              remove: (id, method) =>
                draft.method.remove(Integration.ID.make(id), Schema.decodeUnknownSync(Integration.Method)(method)),
            },
          })
        }),
    },
  } satisfies Context
})
