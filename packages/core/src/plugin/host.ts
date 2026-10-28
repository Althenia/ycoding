export * as PluginHost from "./host"

import type { Plugin } from "@ycoding-ai/plugin/effect"
import { Effect, Schema } from "effect"
import { Agent } from "../agent"
import { Command } from "../command"
import { Location } from "../location"
import { MCP } from "../mcp"
import { PluginRegistry } from "../plugin"
import { PluginRuntime } from "./runtime"
import { Reference } from "../reference"
import { AbsolutePath, type DeepMutable } from "../schema"
import { Skill } from "../skill"
import { Tool } from "../tool/tool"
import { Tools } from "../tool/tools"
import { ToolHooks } from "../tool/hooks"
import { Workspace } from "../workspace"
import { PluginCatalogHost } from "./catalog-host"
import { PluginHooks } from "./hooks"

const mutable = <T>(value: T) => value as DeepMutable<T>
export const make = Effect.fn("PluginHost.make")(function* (plugin: PluginRegistry.Interface) {
  const agents = yield* Agent.Service
  const commands = yield* Command.Service
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
    ...(yield* PluginCatalogHost.make()),
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
    command: {
      list: () => response(commands.list()),
      reload: commands.reload,
      transform: (callback) =>
        commands.transform((draft) => {
          callback(draft)
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
      prompt: (input) => runtime.session.prompt({ ...input, origin: "plugin" }),
      generate: (input) => runtime.session.generate(input).pipe(Effect.map((text) => ({ text }))),
      command: (input) => runtime.session.command({ ...input, origin: "plugin" }),
      synthetic: runtime.session.synthetic,
      interrupt: (input) => runtime.session.interrupt(input.sessionID),
    },
  } satisfies Plugin.Context
})
