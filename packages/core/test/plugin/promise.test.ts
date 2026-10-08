import { describe, expect } from "bun:test"
import { Message, SystemPart } from "@ycoding-ai/ai"
import { DateTime, Effect, Schema } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { PluginPromise } from "@ycoding-ai/core/plugin/promise"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Provider } from "@ycoding-ai/core/provider"
import { Plugin } from "@ycoding-ai/plugin"
import type { SessionHooks } from "@ycoding-ai/plugin/effect/session"
import { Model } from "@ycoding-ai/schema/model"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { host as testHost } from "./host"

const it = testEffect(PluginTestLayer)

describe("fromPromise", () => {
  it.effect("forwards transient session generation", () =>
    Effect.gen(function* () {
      const host = testHost({
        session: {
          generate: (input) => Effect.succeed({ text: `${input.sessionID}: ${input.prompt}` }),
        },
      })

      yield* PluginPromise.fromPromise(
        Plugin.define({
          id: "promise-session-generate",
          setup: async (ctx) => {
            expect(await ctx.session.generate({ sessionID: "ses_generate", prompt: "Summarize" })).toEqual({
              text: "ses_generate: Summarize",
            })
          },
        }),
      ).effect(host)
    }),
  )

  it.effect("forwards synthetic session input", () =>
    Effect.gen(function* () {
      const input = {
        sessionID: "ses_synthetic",
        id: "msg_synthetic",
        text: "Background work completed",
        description: null,
        metadata: { shellID: "shell_1" },
        delivery: null,
        resume: null,
      }
      let seen: unknown
      const host = testHost({
        session: {
          synthetic: (value) => {
            seen = value
            return Effect.succeed(
              SessionPending.Synthetic.make({
                admittedSeq: 1,
                id: SessionMessage.ID.make(input.id),
                sessionID: Session.ID.make(input.sessionID),
                timeCreated: DateTime.makeUnsafe(0),
                type: "synthetic",
                data: {
                  text: input.text,
                  metadata: input.metadata,
                },
                delivery: "queue",
              }),
            )
          },
        },
      })

      yield* PluginPromise.fromPromise(
        Plugin.define({
          id: "promise-session-synthetic",
          setup: async (ctx) => {
            await ctx.session.synthetic(input)
          },
        }),
      ).effect(host)

      expect(seen).toEqual({
        ...input,
        description: undefined,
        delivery: undefined,
        resume: undefined,
      })
    }),
  )

  it.effect("forwards standard client reads", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginRegistry.Service
      const host = yield* PluginHost.make(plugin)
      const seen: string[] = []
      const promisePlugin = Plugin.define({
        id: "promise-client-reads",
        setup: async (ctx) => {
          const results = await Promise.all([
            ctx.agent.list(),
            ctx.catalog.provider.list(),
            ctx.catalog.model.list(),
            ctx.command.list(),
            ctx.integration.list(),
            ctx.plugin.list(),
            ctx.reference.list(),
            ctx.skill.list(),
          ])
          seen.push(...results.map((result) => result.location.directory))
        },
      })

      yield* PluginPromise.fromPromise(promisePlugin).effect(host)

      expect(seen).toHaveLength(8)
      expect(new Set(seen).size).toBe(1)
    }),
  )

  it.effect("returns the configured named-profile default selection through the direct Promise catalog adapter", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginRegistry.Service
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      const host = yield* PluginHost.make(plugin)
      const providerID = Provider.ID.make("profile-default")
      const modelID = CatalogModel.ID.make("configured-chat")
      yield* credentials.create({
        integrationID: Integration.ID.make(providerID),
        label: "Work",
        value: { type: "key", key: "fixture-profile-default" },
      })
      yield* catalog.transform((draft) =>
        draft.model.update(providerID, modelID, (model) => {
          model.enabled = true
          model.variants = [{ id: CatalogModel.VariantID.make("high") }]
        }),
      )
      let callbacks = 0
      yield* PluginPromise.fromPromise(
        Plugin.define({
          id: "promise-profile-default",
          setup: async (ctx) => {
            await ctx.catalog.transform((draft) => {
              callbacks += 1
              draft.model.default.set(providerID, modelID, { profile: "Work", variant: "high" })
            })
            const selected = await ctx.catalog.model.default()
            expect(selected.data).toMatchObject({
              id: modelID,
              providerID,
              selection: { id: modelID, providerID, profile: "Work", variant: "high" },
            })
            expect(selected.data?.profiles).toEqual([{ name: "Work", active: true, variants: ["high"] }])
            expect(JSON.stringify(selected.data)).not.toContain("fixture-profile-default")
          },
        }),
      ).effect(host)
      expect(callbacks).toBe(1)
    }),
  )

  it.effect("forwards direct agent and model reads", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const catalog = yield* Catalog.Service
      const plugin = yield* PluginRegistry.Service
      const host = yield* PluginHost.make(plugin)
      yield* agents.transform((draft) =>
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.description = "Reviews code"
        }),
      )
      yield* catalog.transform((draft) =>
        draft.model.update(Provider.ID.make("test"), CatalogModel.ID.make("alias"), (model) => {
          model.modelID = CatalogModel.ID.make("gpt-5")
        }),
      )

      yield* PluginPromise.fromPromise(
        Plugin.define({
          id: "promise-direct-reads",
          setup: async (ctx) => {
            expect(await ctx.agent.get("reviewer")).toMatchObject({ description: "Reviews code" })
            expect(await ctx.agent.get("missing")).toBeUndefined()
            expect(await ctx.catalog.model.get("test", "alias")).toMatchObject({ modelID: "gpt-5" })
            expect(await ctx.catalog.model.get("test", "missing")).toBeUndefined()
          },
        }),
      ).effect(host)
    }),
  )

  it.effect("loads a promise plugin and registers a transform hook", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plugin = yield* PluginRegistry.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = Plugin.define({
        id: "promise-example",
        setup: async (ctx) => {
          expect(ctx.options.mode).toBe("strict")
          await ctx.agent.transform((draft) => {
            draft.update("reviewer", (item) => {
              item.description = "Reviews code"
              item.mode = "subagent"
            })
          })
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect({ ...host, options: { mode: "strict" } })

      expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({
        description: "Reviews code",
        mode: "subagent",
      })
    }),
  )

  it.effect("forwards session context hooks", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginRegistry.Service
      const hooks = yield* PluginHooks.Service
      const host = yield* PluginHost.make(plugin)
      yield* PluginPromise.fromPromise(
        Plugin.define({
          id: "promise-session-context",
          setup: async (ctx) => {
            await ctx.session.hook("context", (event) => {
              event.system.push(SystemPart.make("Promise hook"))
              delete event.tools.echo
            })
          },
        }),
      ).effect(host)
      const event: SessionHooks["context"] = {
        sessionID: Session.ID.make("ses_promise_session_context"),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") }),
        system: [SystemPart.make("Initial")],
        messages: [Message.user("Hello")],
        tools: { echo: { description: "Echo", input: { type: "object" } } },
      }

      yield* hooks.trigger("session", "context", event)

      expect(event.system.map((part) => part.text)).toEqual(["Initial", "Promise hook"])
      expect(event.tools).toEqual({})
    }),
  )

  it.effect("disposes a hook registration on request", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plugin = yield* PluginRegistry.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = Plugin.define({
        id: "promise-dispose",
        setup: async (ctx) => {
          const registration = await ctx.agent.transform((draft) => {
            draft.update("temp", (item) => {
              item.description = "temporary"
            })
          })
          await registration.dispose()
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect(host)

      expect(yield* agents.get(Agent.ID.make("temp"))).toBeUndefined()
    }),
  )

  it.effect("runs the setup cleanup when the plugin scope closes", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginRegistry.Service
      const host = yield* PluginHost.make(plugin)
      const events: string[] = []
      const promisePlugin = Plugin.define({
        id: "promise-cleanup",
        setup: async () => {
          events.push("setup")
          return async () => {
            await Promise.resolve()
            events.push("cleanup")
          }
        },
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* PluginPromise.fromPromise(promisePlugin).effect(host)
          expect(events).toEqual(["setup"])
        }),
      )

      expect(events).toEqual(["setup", "cleanup"])
    }),
  )

  it.effect("constructs plain Promise tool declarations in the host", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginRegistry.Service
      const registry = yield* ToolRegistry.Service
      const host = yield* PluginHost.make(plugins)
      const progress: ToolRegistry.Progress[] = []
      const promisePlugin = Plugin.define({
        id: "promise-tool",
        setup: async (ctx) => {
          await ctx.tool.transform((tools) => {
            tools.add({
              name: "hello",
              options: { codemode: false },
              description: "Hello",
              input: Schema.Struct({ name: Schema.String }),
              output: Schema.String,
              execute: async ({ name }, context) => {
                await context.progress({ structured: { phase: "greeting" } })
                return `Hello, ${name}!`
              },
            })
          })
        },
      })

      yield* PluginPromise.fromPromise(promisePlugin).effect(host)

      const materialized = yield* registry.materialize()
      expect(materialized.definitions).toContainEqual(expect.objectContaining({ name: "hello", description: "Hello" }))
      expect(
        yield* materialized.settle({
          sessionID: Session.ID.make("ses_promise_tool"),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_promise_tool"),
          progress: (update) => Effect.sync(() => progress.push(update)),
          call: { type: "tool-call", id: "call_promise_tool", name: "hello", input: { name: "world" } },
        }),
      ).toMatchObject({ result: { type: "text", value: "Hello, world!" } })
      expect(progress).toEqual([{ structured: { phase: "greeting" }, content: [] }])
    }),
  )
})
