import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { EventV2 } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Location } from "@ycoding-ai/core/location"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { AgentPlugin } from "@ycoding-ai/core/plugin/agent"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const testLocation = location({ directory: AbsolutePath.make("/project") })
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(testLocation))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([AgentV2.node, EventV2.node, Location.node]), [
    [Location.node, locationLayer],
  ]) as unknown as Layer.Layer<unknown, never>,
)

describe("AgentV2", () => {
  it.effect("publishes an updated event after agent changes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const events = yield* EventV2.Service
      const updated = yield* events
        .subscribe(AgentV2.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* agent.transform((editor) => editor.update(AgentV2.ID.make("reviewer"), () => {}))

      expect(yield* Fiber.join(updated)).toMatchObject([{ location: { directory: testLocation.directory } }])
    }),
  )

  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.list()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
      expect(yield* agent.select()).toEqual({ id: AgentV2.ID.make("god"), info: undefined })
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.list()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("lists the effective configured default agent first", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const god = AgentV2.ID.make("god")
      const reviewer = AgentV2.ID.make("reviewer")
      yield* agent.transform((editor) => {
        editor.update(god, () => {})
        editor.update(reviewer, () => {})
        editor.default(reviewer)
      })

      expect((yield* agent.list()).map((info) => info.id)).toEqual([reviewer, god])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      const reload = yield* agent.reload().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("500 millis")
      yield* Fiber.join(reload)

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("registers the maintained built-in catalog without ambient bash access", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.list()
      expect(agents[0]?.id).toBe(AgentV2.ID.make("god"))
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "TLDR",
        "architech",
        "btw",
        "compaction",
        "goal",
        "god",
        "occam",
        "omoikane",
        "summary",
        "title",
        "wittgenstein",
        "yangi",
        "zeus",
      ])
      expect(AgentV2.defaultID).toBe(AgentV2.ID.make("god"))
      expect(yield* agent.resolve()).toMatchObject({ id: AgentV2.ID.make("god"), mode: "primary" })
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
      expect(yield* agent.get(AgentV2.ID.make("plan"))).toBeUndefined()
      expect(yield* agent.get(AgentV2.ID.make("explore"))).toBeUndefined()
      expect(yield* agent.get(AgentV2.ID.make("general"))).toBeUndefined()
      expect(yield* agent.get(AgentV2.ID.make("analyze"))).toBeUndefined()
      expect(yield* agent.get(AgentV2.ID.make("brainstorm"))).toBeUndefined()
      for (const id of ["TLDR", "architech", "god", "yangi", "occam", "omoikane", "wittgenstein", "zeus"]) {
        const item = agents.find((agent) => String(agent.id) === id)
        if (!item) throw new Error(`expected built-in agent ${id}`)
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
        expect(PermissionV2.evaluate("shell", "git status", item.permissions).effect).toBe("allow")
      }
      for (const id of ["TLDR", "architech", "god", "yangi"]) {
        const item = agents.find((agent) => String(agent.id) === id)
        if (!item) throw new Error(`expected build-equivalent agent ${id}`)
        expect(PermissionV2.evaluate("edit", "README.md", item.permissions).effect).toBe("allow")
        expect(PermissionV2.evaluate("question", "*", item.permissions).effect).toBe("allow")
        expect(PermissionV2.evaluate("plan_enter", "*", item.permissions).effect).toBe("allow")
      }
      for (const id of ["occam", "omoikane", "wittgenstein", "zeus"]) {
        const item = agents.find((agent) => String(agent.id) === id)
        if (!item) throw new Error(`expected general-equivalent agent ${id}`)
        expect(PermissionV2.evaluate("edit", "README.md", item.permissions).effect).toBe("allow")
        expect(PermissionV2.evaluate("question", "*", item.permissions).effect).toBe("deny")
        expect(PermissionV2.evaluate("plan_enter", "*", item.permissions).effect).toBe("deny")
        expect(PermissionV2.evaluate("subagent", "*", item.permissions).effect).toBe("deny")
      }
    }),
  )

  it.effect("preserves representative built-in agent metadata and prompts", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const god = yield* agent.get(AgentV2.ID.make("god"))
      const zeus = yield* agent.get(AgentV2.ID.make("zeus"))
      if (!god?.system || !zeus?.system) throw new Error("expected built-in agents with system prompts")

      expect(god.system.startsWith("YCoding is the TUI-only V2 runtime")).toBe(true)
      expect(zeus.system.startsWith("YCoding is the TUI-only V2 runtime")).toBe(true)
      expect(god.system).toContain("Follow the user's prompt or inquiry strictly")
      expect(zeus.system).toContain("Do not perform work the user did not request")
      expect(god.system).toContain("concrete evidence")
      expect(god.system).toContain("You are God, an autonomous production software builder.")
      expect(god.system).toContain("## Delivery")
      expect(god).toMatchObject({
        description: "Calm, sovereign, evidence-led builder that identifies the real need, corrects false premises, and delivers exceptional work.",
        mode: "primary",
        request: { body: { temperature: 0.2 } },
        color: "#f1c40f",
      })
      expect(god.permissions).toEqual([
        { action: "*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "ask" },
        { action: "external_directory", resource: `${Global.Path.data}/shell/*/*`, effect: "allow" },
        { action: "external_directory", resource: `${Global.Path.tmp}/*`, effect: "allow" },
        { action: "question", resource: "*", effect: "deny" },
        { action: "plan_enter", resource: "*", effect: "deny" },
        { action: "plan_exit", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "read", resource: "*.env", effect: "ask" },
        { action: "read", resource: "*.env.*", effect: "ask" },
        { action: "read", resource: "*.env.example", effect: "allow" },
        { action: "question", resource: "*", effect: "allow" },
        { action: "plan_enter", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "allow" },
      ])
      expect(zeus.system).toContain("You are Zeus, an autonomous software implementer.")
      expect(zeus.system).toContain("## Execution")
      expect(zeus).toMatchObject({
        description: "Evidence-led autonomous implementer that corrects false premises and completes one bounded task with exceptional quality.",
        mode: "subagent",
        request: { body: { temperature: 0.2 } },
        color: "#f1c40f",
      })
      expect(PermissionV2.evaluate("shell", "git status", zeus.permissions).effect).toBe("allow")
    }),
  )

  it.effect("configures BTW as a read-only advisor that requests approval for mutations", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const btw = yield* agent.get(AgentV2.ID.make("btw"))
      if (!btw) throw new Error("expected BTW agent")
      expect(btw).toMatchObject({ name: "BTW", mode: "subagent", hidden: false })
      expect(PermissionV2.evaluate("read", "README.md", btw.permissions).effect).toBe("allow")
      expect(PermissionV2.evaluate("edit", "README.md", btw.permissions).effect).toBe("ask")
      expect(PermissionV2.evaluate("shell", "git status", btw.permissions).effect).toBe("ask")
    }),
  )
})
