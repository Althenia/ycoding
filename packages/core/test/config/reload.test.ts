import path from "path"
import { describe, expect } from "bun:test"
import { Config as ConfigSchema } from "@ycoding-ai/schema/config"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Command } from "@ycoding-ai/core/command"
import { Config } from "@ycoding-ai/core/config"
import { ConfigAgentPlugin } from "@ycoding-ai/core/config/plugin/agent"
import { ConfigCommandPlugin } from "@ycoding-ai/core/config/plugin/command"
import { ConfigProviderPlugin } from "@ycoding-ai/core/config/plugin/provider"
import { ConfigPolicyPlugin } from "@ycoding-ai/core/config/plugin/policy"
import { ConfigReferencePlugin } from "@ycoding-ai/core/config/plugin/reference"
import { ConfigSkillPlugin } from "@ycoding-ai/core/config/plugin/skill"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { Integration } from "@ycoding-ai/core/integration"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { Provider } from "@ycoding-ai/core/provider"
import { Reference } from "@ycoding-ai/core/reference"
import { Skill } from "@ycoding-ai/core/skill"
import { Session } from "@ycoding-ai/schema/session"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { Deferred, Effect, Exit, Layer, Schema, Scope } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Config.Info)
const document = path.join(import.meta.dir, "ycoding.json")

describe("config plugin reloads", () => {
  for (const outcome of ["resumes", "is cancelled", "fails"] as const) {
    it.live(`does not retain transcript events while a config reload ${outcome}`, () => {
      let queued: readonly number[] = []
      let closing = false
      const closed = Promise.withResolvers<void>()
      return Effect.gen(function* () {
        const events = yield* EventRuntime.Service
        const agents = yield* Agent.Service
        const commands = yield* Command.Service
        const references = yield* Reference.Service
        const plugins = yield* PluginRegistry.Service
        const host = yield* PluginHost.make(plugins)
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const reloaded = yield* Deferred.make<void>()
        let current = "first"
        let blocked = false
        let waiting = 0
        let finished = 0
        const reads = new Map<string, string[]>()
        const interrupted: string[] = []
        const reload = (effect: Effect.Effect<void>) => effect.pipe(Effect.tap(() => {
          finished++
          return finished === 13 ? Deferred.succeed(reloaded, undefined) : Effect.void
        }))
        const context = {
          ...host,
          agent: { ...host.agent, reload: () => reload(host.agent.reload()) },
          command: { ...host.command, reload: () => reload(host.command.reload()) },
          skill: { ...host.skill, reload: () => reload(host.skill.reload()) },
          reference: { ...host.reference, reload: () => reload(host.reference.reload()) },
          catalog: { ...host.catalog, reload: () => reload(host.catalog.reload()) },
        }
        const setup = <R>(name: string, effect: Effect.Effect<void, never, R>) => effect.pipe(
          Effect.provideService(Config.Service, Config.Service.of({
            diagnostics: () => Effect.succeed([]),
            reload: () => Effect.void,
            entries: () => Effect.gen(function* () {
              const value = current
              reads.set(name, [...(reads.get(name) ?? []), value])
              if (blocked) {
                waiting++
                if (waiting === 6) yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                if (outcome === "fails") return yield* Effect.die(new Error("Controlled config read failure"))
              }
              return [config(value)]
            }).pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted.push(name)))),
          })),
          Effect.provideService(Scope.Scope, scope),
        )
        yield* setup("agent", ConfigAgentPlugin.Plugin.effect(context))
        yield* setup("command", ConfigCommandPlugin.Plugin.effect(context))
        yield* setup("skill", ConfigSkillPlugin.Plugin.effect(context))
        yield* setup("reference", ConfigReferencePlugin.Plugin.effect(context))
        yield* setup("provider", ConfigProviderPlugin.Plugin.effect(context))
        yield* setup("policy", ConfigPolicyPlugin.Plugin.effect(context))
        current = "second"
        blocked = true
        yield* events.publish(ConfigSchema.Event.Updated, {})
        yield* Deferred.await(entered)
        for (let index = 0; index < 16; index++) {
          yield* events.publish(SessionEvent.Text.Delta, {
            sessionID: Session.ID.make("ses_config_backlog"),
            assistantMessageID: SessionMessage.ID.make("msg_config_backlog"),
            ordinal: 0,
            delta: `${index}:${"x".repeat(64 * 1024)}`,
          })
        }
        expect(queued).toEqual([0, 0, 0, 0, 0, 0])
        current = "third"
        yield* events.publish(ConfigSchema.Event.Updated, {})
        expect(queued).toEqual([1, 1, 1, 1, 1, 1])
        yield* events.publish(Integration.Event.ConnectionUpdated, {
          integrationID: Integration.ID.make("int_config_backlog"),
        })
        expect(queued).toEqual([1, 1, 1, 1, 2, 1])
        if (outcome === "resumes") {
          blocked = false
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(reloaded)
          expect([...reads.values()]).toEqual(Array.from({ length: 6 }, () => ["first", "second", "third"]))
          expect((yield* agents.get(Agent.ID.make("third")))?.description).toBe("Third agent")
          expect((yield* commands.get("third"))?.description).toBe("Third command")
          expect((yield* references.list()).map((item) => item.name)).toEqual(["third"])
        }
        closing = true
        if (outcome === "fails") {
          yield* Deferred.succeed(release, undefined)
          yield* Effect.promise(() => closed.promise)
          expect(finished).toBe(0)
        } else {
          yield* Scope.close(scope, Exit.void)
        }
        expect(queued).toEqual([])
        expect(interrupted.toSorted()).toEqual(outcome === "is cancelled"
          ? ["agent", "command", "policy", "provider", "reference", "skill"]
          : [])
        const before = [...reads.values()]
        yield* events.publish(ConfigSchema.Event.Updated, {})
        expect([...reads.values()]).toEqual(before)
      }).pipe(Effect.provide(EventRuntime.layerWith({
        onLiveQueueChange: (counts) => {
          queued = counts
          if (closing && counts.length === 0) closed.resolve()
        },
      }).pipe(Layer.provide(AppNodeBuilder.build(Database.node)))))
    })
  }

  it.live("reloads config-backed domains without reloading external plugins", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const catalog = yield* Catalog.Service
      const commands = yield* Command.Service
      const events = yield* EventRuntime.Service
      const plugins = yield* PluginRegistry.Service
      const references = yield* Reference.Service
      const skills = yield* Skill.Service
      const host = yield* PluginHost.make(plugins)
      let entries: Config.Entry[] = [config("first")]
      const service = Config.Service.of({ diagnostics: () => Effect.succeed([]), reload: () => Effect.void, entries: () => Effect.sync(() => entries) })
      const setup = <R>(effect: Effect.Effect<void, never, R>) =>
        effect.pipe(Effect.provideService(Config.Service, service))

      yield* setup(ConfigAgentPlugin.Plugin.effect(host))
      yield* setup(ConfigCommandPlugin.Plugin.effect(host))
      yield* setup(ConfigSkillPlugin.Plugin.effect(host))
      yield* setup(ConfigReferencePlugin.Plugin.effect(host))
      yield* setup(ConfigProviderPlugin.Plugin.effect(host))

      expect((yield* agents.get(Agent.ID.make("first")))?.description).toBe("First agent")
      expect((yield* commands.get("first"))?.description).toBe("First command")
      expect(
        (yield* skills.sources()).some((source) => source.type === "directory" && source.path === "/skills/first"),
      ).toBe(true)
      expect((yield* references.list()).map((reference) => reference.name)).toEqual(["first"])
      expect(yield* catalog.provider.get(Provider.ID.make("first"))).toBeDefined()

      entries = [config("second")]
      yield* events.publish(ConfigSchema.Event.Updated, {})
      yield* waitUntil(
        Effect.gen(function* () {
          return (
            (yield* agents.get(Agent.ID.make("first"))) === undefined &&
            (yield* agents.get(Agent.ID.make("second")))?.description === "Second agent" &&
            (yield* commands.get("first")) === undefined &&
            (yield* commands.get("second"))?.description === "Second command" &&
            (yield* references.list()).some((reference) => reference.name === "second") &&
            (yield* catalog.provider.get(Provider.ID.make("first"))) === undefined &&
            (yield* catalog.provider.get(Provider.ID.make("second"))) !== undefined
          )
        }),
      )

      expect(
        (yield* skills.sources()).some((source) => source.type === "directory" && source.path === "/skills/first"),
      ).toBe(false)
      expect(
        (yield* skills.sources()).some((source) => source.type === "directory" && source.path === "/skills/second"),
      ).toBe(true)
    }).pipe(Effect.provideService(Global.Service, Global.Service.of(Global.make()))),
  )
})

function config(name: string) {
  return new Config.Document({
    type: "document",
    path: document,
    info: decode({
      agents: { [name]: { description: `${title(name)} agent`, mode: "subagent" } },
      commands: { [name]: { template: `${title(name)} command`, description: `${title(name)} command` } },
      skills: [`/skills/${name}`],
      references: { [name]: `/references/${name}` },
      providers: { [name]: { models: { chat: { name: `${title(name)} model` } } } },
    }),
  })
}

function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for config plugin reloads")
})
