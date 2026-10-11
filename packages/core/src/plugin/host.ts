export * as PluginHost from "./host"

import type { Plugin } from "@ycoding-ai/plugin/effect"
import { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { Effect, Schema, Stream } from "effect"
import { Agent } from "../agent"
import { AISDK } from "../aisdk"
import { Catalog } from "../catalog"
import { Command } from "../command"
import { Credential } from "../credential"
import { EventRuntime } from "../event"
import { Integration } from "../integration"
import { Location } from "../location"
import { MCP } from "../mcp"
import { CatalogModel } from "../model"
import { PluginRegistry } from "../plugin"
import { PluginRuntime } from "./runtime"
import { Provider } from "../provider"
import { Reference } from "../reference"
import { AbsolutePath, type DeepMutable } from "../schema"
import { Skill } from "../skill"
import { Tool } from "../tool/tool"
import { Tools } from "../tool/tools"
import { ToolHooks } from "../tool/hooks"
import { Workspace } from "../workspace"
import { PluginHooks } from "./hooks"

const mutable = <T>(value: T) => value as DeepMutable<T>
export const make = Effect.fn("PluginHost.make")(function* (plugin: PluginRegistry.Interface) {
  const agents = yield* Agent.Service
  const aisdk = yield* AISDK.Service
  const catalog = yield* Catalog.Service
  const commands = yield* Command.Service
  const events = yield* EventRuntime.Service
  const integration = yield* Integration.Service
  const mcp = yield* MCP.Service
  const location = yield* Location.Service
  const reference = yield* Reference.Service
  const skill = yield* Skill.Service
  const tools = yield* Tools.Service
  const toolHooks = yield* ToolHooks.Service
  const hooks = yield* PluginHooks.Service
  const runtime = yield* PluginRuntime.Service
  const locationInfo = () =>
    new Location.Info({
      directory: location.directory,
      workspaceID: location.workspaceID,
      project: location.project,
    })
  const locationRef = (input?: Parameters<Plugin.Context["agent"]["list"]>[0]) =>
    input?.location === undefined
      ? undefined
      : Location.Ref.make({
          directory: AbsolutePath.make(input.location.directory ?? location.directory),
          workspaceID:
            input.location.workspace === undefined ? location.workspaceID : Workspace.ID.make(input.location.workspace),
        })
  const isCurrentLocation = (ref: Location.Ref) =>
    ref.directory === location.directory && ref.workspaceID === location.workspaceID
  const response = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.map((data) => ({ location: locationInfo(), data })))

  return {
    options: {},
    agent: {
      get: (id) => agents.get(Agent.ID.make(id)),
      list: (input) => {
        const ref = locationRef(input)
        if (ref && !isCurrentLocation(ref)) return runtime.location.agent.list(ref)
        return agents.list().pipe(Effect.map((data) => ({ location: locationInfo(), data })))
      },
      reload: agents.reload,
      transform: (callback) =>
        agents.transform((draft) => {
          callback({
            list: () => mutable(draft.list()),
            get: (id) => mutable(draft.get(Agent.ID.make(id))),
            default: (id) => draft.default(id === undefined ? undefined : Agent.ID.make(id)),
            update: (id, update) => draft.update(Agent.ID.make(id), update),
            remove: (id) => draft.remove(Agent.ID.make(id)),
          })
        }),
    },
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
    command: {
      list: () => response(commands.list()),
      reload: commands.reload,
      transform: (callback) =>
        commands.transform((draft) => {
          callback(draft)
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
    mcp: {
      servers: mcp.servers,
      tools: mcp.tools,
      readResource: mcp.readResource,
      callTool: mcp.callTool,
    },
    plugin: {
      list: () => response(plugin.list()),
    },
    reference: {
      list: () => response(reference.list()),
      reload: reference.reload,
      transform: (callback) =>
        reference.transform((draft) => {
          callback({
            add: (name, source) => draft.add(name, Schema.decodeUnknownSync(Reference.Source)(source)),
            remove: draft.remove,
            list: draft.list,
          })
        }),
    },
    skill: {
      list: () => response(skill.list()),
      reload: skill.reload,
      transform: (callback) =>
        skill.transform((draft) => {
          callback({
            source: (source) => draft.source(Schema.decodeUnknownSync(Skill.Source)(source)),
            list: draft.list,
          })
        }),
    },
    tool: {
      transform: (callback) =>
        Effect.gen(function* () {
          const registrations: Array<{
            readonly name: string
            readonly tool: Tool.AnyTool
            readonly options?: Tool.RegisterOptions
          }> = []
          yield* Effect.sync(() =>
            callback({
              add: (name, tool, options) => {
                registrations.push({ name, tool, ...(options ? { options } : {}) })
              },
            }),
          )
          yield* tools
            .registerBatch(
              registrations.map((registration) => ({
                tools: { [registration.name]: registration.tool },
                ...(registration.options === undefined ? {} : { options: registration.options }),
              })),
            )
            .pipe(Effect.orDie)
          return { dispose: Effect.void }
        }),
      hook: (name, callback) => {
        if (name === "execute.before") {
          return toolHooks.hook.before((event) => {
            const output = {
              tool: event.tool,
              sessionID: event.sessionID,
              agent: event.agent,
              messageID: event.messageID,
              callID: event.callID,
              input: event.input,
            }
            return Reflect.apply(callback, undefined, [output]).pipe(
              Effect.tap(() => Effect.sync(() => (event.input = output.input))),
            )
          })
        }
        return toolHooks.hook.after((event) => {
          const output = {
            tool: event.tool,
            sessionID: event.sessionID,
            agent: event.agent,
            messageID: event.messageID,
            callID: event.callID,
            input: event.input,
            result: event.result,
            output: event.output,
            outputPaths: event.outputPaths,
          }
          return Reflect.apply(callback, undefined, [output]).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                event.result = output.result
                event.output = output.output
                event.outputPaths = output.outputPaths
              }),
            ),
          )
        })
      },
    },
    session: {
      hook: (name, callback) => hooks.register("session", name, callback),
      create: (input) =>
        runtime.session.create({
          id: input?.id,
          agent: input?.agent,
          model: input?.model,
          ...(input?.parentID
            ? { parentID: input.parentID }
            : {
                location:
                  input?.location ??
                  Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
              }),
        }),
      get: (input) => runtime.session.get(input.sessionID),
      prompt: runtime.session.prompt,
      generate: (input) => runtime.session.generate(input).pipe(Effect.map((text) => ({ text }))),
      command: runtime.session.command,
      synthetic: runtime.session.synthetic,
      interrupt: (input) => runtime.session.interrupt(input.sessionID),
    },
  } satisfies Plugin.Context
})
