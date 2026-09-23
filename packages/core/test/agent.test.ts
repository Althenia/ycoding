import { describe, expect } from "bun:test"
import matter from "gray-matter"
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
        "GSD",
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
      for (const id of ["GSD", "architech", "god", "yangi", "occam", "omoikane", "wittgenstein", "zeus"]) {
        const item = agents.find((agent) => String(agent.id) === id)
        if (!item) throw new Error(`expected built-in agent ${id}`)
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
        expect(PermissionV2.evaluate("shell", "git status", item.permissions).effect).toBe("allow")
      }
      for (const id of ["GSD", "architech", "god", "yangi"]) {
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

  it.effect("replaces TLDR with the GSD orchestration-only delivery contract", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(testLocation)),
      )

      expect(yield* agent.get(AgentV2.ID.make("TLDR"))).toBeUndefined()
      const gsd = yield* agent.resolve(AgentV2.ID.make("GSD"))
      expect(gsd).toMatchObject({ id: "GSD", name: "GSD", mode: "primary", hidden: false })
      if (!gsd) throw new Error("expected the GSD primary agent")
      expect(gsd.system).toContain("You are GSD (Get shit done), an orchestration-only delivery lead.")
      expect(gsd.system).toContain("Do not implement, edit files, or run build/test commands yourself.")
      expect(gsd.system).toContain("Start every ready independent task in parallel")
      expect(gsd.system).toContain("Assign one writer per file or mutable resource")
      expect(gsd.system).toContain("Require TDD for executable behavior")
      expect(gsd.system).toContain("Never overengineer")
      expect(gsd.system).toContain("repository standards and guidelines")
      expect(gsd.system).toContain("Verify child evidence")
      expect(gsd.color).toBe("#e67e22")
      const source = yield* Effect.promise(() => Bun.file(new URL("../src/plugin/agent/GSD.md", import.meta.url)).text())
      expect(source.match(/^color:\s*"(#[0-9a-fA-F]{6})"/m)?.[1]).toBe(gsd.color)
      expect(PermissionV2.evaluate("subagent", "occam", gsd.permissions).effect).toBe("allow")
      expect(yield* agent.resolve()).toMatchObject({ id: "god" })
    }),
  )

  it.effect("loads each built-in's static metadata and prompt from its Markdown", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(testLocation)),
      )

      const catalog = [
        ["GSD", "primary", 0.3, "#e67e22"],
        ["architech", "primary", 0.3, "#3498db"],
        ["god", "primary", 0.2, "#f1c40f"],
        ["yangi", "primary", 0.1, "#2ecc71"],
        ["occam", "subagent", 0.1, "#2ecc71"],
        ["omoikane", "subagent", 0.3, "#3498db"],
        ["wittgenstein", "subagent", 0.1, "#95a5a6"],
        ["zeus", "subagent", 0.2, "#f1c40f"],
      ] as const
      for (const [id, mode, temperature, color] of catalog) {
        const item = yield* agent.get(AgentV2.ID.make(id))
        if (!item?.system) throw new Error(`expected ${id} with a system prompt`)
        const source = yield* Effect.promise(() =>
          Bun.file(new URL(`../src/plugin/agent/${id}.md`, import.meta.url)).text(),
        )
        const markdown = matter(source)
        expect(item).toMatchObject({ id, mode, color, request: { body: { temperature } } })
        expect(markdown.data).toMatchObject({
          description: item.description,
          mode,
          color,
          request: { body: { temperature } },
        })
        expect(markdown.data.permissions).toBeUndefined()
        expect(item.system.startsWith("YCoding is the terminal-first V2 runtime")).toBe(true)
        expect(item.system.split(markdown.content.trim())).toHaveLength(2)
        expect(PermissionV2.evaluate("read", ".env", item.permissions).effect).toBe("ask")
        expect(PermissionV2.evaluate("read", ".env.example", item.permissions).effect).toBe("allow")
        expect(PermissionV2.evaluate("external_directory", "/outside", item.permissions).effect).toBe("ask")
        expect(PermissionV2.evaluate("plan_exit", "*", item.permissions).effect).toBe("deny")
        expect(PermissionV2.evaluate("subagent", "zeus", item.permissions).effect).toBe(
          mode === "primary" ? "allow" : "deny",
        )
      }
    }),
  )

  it.effect("shares bounded-search guidance without duplicating GSD's instruction", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(testLocation)),
      )

      const guidance =
        "Bound repository searches by scope and output; reuse settled results, pivot a missing broad search to a likely file, symbol, caller, or directory, and repeat reads only for changed inputs or new evidence."
      for (const id of ["zeus", "GSD", "architech", "god", "yangi", "occam", "omoikane", "wittgenstein"]) {
        const item = yield* agent.get(AgentV2.ID.make(id))
        if (!item?.system) throw new Error(`expected ${id} with a system prompt`)
        expect(item.system.split(guidance)).toHaveLength(2)
        expect(item.system.indexOf(guidance)).toBeLessThan(item.system.indexOf("You are "))
      }
      const source = yield* Effect.promise(() => Bun.file(new URL("../src/plugin/agent/GSD.md", import.meta.url)).text())
      expect(source).not.toContain("Never repeat a settled search or tool call without changed input")
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

      expect(god.system.startsWith("YCoding is the terminal-first V2 runtime")).toBe(true)
      expect(zeus.system.startsWith("YCoding is the terminal-first V2 runtime")).toBe(true)
      expect(god.system).toContain("Follow the user's prompt or inquiry strictly")
      expect(zeus.system).toContain("Do not perform work the user did not request")
      expect(god.system).toContain("concrete evidence")
      expect(god.system).toContain("You are God, an autonomous production software builder.")
      expect(god.system).toContain("## Delivery")
      expect(god).toMatchObject({
        description:
          "Calm, sovereign, evidence-led builder that identifies the real need, corrects false premises, and delivers exceptional work.",
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
        description:
          "Evidence-led autonomous implementer that corrects false premises and completes one bounded task with exceptional quality.",
        mode: "subagent",
        request: { body: { temperature: 0.2 } },
        color: "#f1c40f",
      })
      expect(PermissionV2.evaluate("shell", "git status", zeus.permissions).effect).toBe("allow")
    }),
  )

  it.effect("gives execution agents explicit action boundaries and keeps the title prompt lean", () =>
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

      for (const id of ["GSD", "architech", "god", "yangi", "occam", "omoikane", "wittgenstein", "zeus"]) {
        const item = yield* agent.get(AgentV2.ID.make(id))
        if (!item?.system) throw new Error(`expected built-in agent ${id} with a system prompt`)
        expect(item.system).toContain(
          "For requests to answer, explain, review, diagnose, or plan, inspect the relevant material and report.",
        )
        expect(item.system).toContain("Do not make changes unless the request also asks for them.")
        expect(item.system).toContain(
          "For requests to change, build, or fix, make the requested in-scope local changes and run relevant non-destructive checks without asking first.",
        )
        expect(item.system).toContain(
          "Require confirmation before external writes, purchases, destructive or irreversible actions, dependency changes, data or schema migrations, CI/CD changes, public-contract breaks, or material scope expansion.",
        )
        expect(item.system).toContain(
          "If your permission ceiling prevents asking for confirmation, do not act; report the blocker.",
        )
        expect(item.system.split("For requests to change, build, or fix")).toHaveLength(2)
      }

      const god = yield* agent.get(AgentV2.ID.make("god"))
      if (!god?.system) throw new Error("expected god agent with a system prompt")
      expect(god.system).toContain("Explicit permission denies remain denied.")
      expect(god.system).toContain("Only effective YOLO 3 auto-approves guardrail reviews.")

      const zeus = yield* agent.get(AgentV2.ID.make("zeus"))
      if (!zeus?.system) throw new Error("expected zeus agent with a system prompt")
      expect(zeus.system).toContain("You are a durable child Session")
      expect(zeus.system).toContain("Do not spawn child agents")

      const title = yield* agent.get(AgentV2.ID.make("title"))
      if (!title?.system) throw new Error("expected title agent with a system prompt")
      expect(title.system).toContain("Output exactly one natural thread title")
      expect(title.system).not.toContain("<examples>")
      expect(title.system.length).toBeLessThan(900)
    }),
  )

  it.effect("preserves each utility agent's output contract", () =>
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

      const compaction = yield* agent.get(AgentV2.ID.make("compaction"))
      const goal = yield* agent.get(AgentV2.ID.make("goal"))
      const summary = yield* agent.get(AgentV2.ID.make("summary"))
      const btw = yield* agent.get(AgentV2.ID.make("btw"))
      if (!compaction?.system || !goal?.system || !summary?.system || !btw?.system) {
        throw new Error("expected utility agents with system prompts")
      }

      expect(compaction.system).toContain("previous conversation_memory")
      expect(compaction.system).toContain("in_progress")
      expect(compaction.system).toContain("decision")
      expect(compaction.system).toContain("skill")
      expect(compaction.system).toContain("Do not answer the conversation")
      expect(goal.system).toContain("observable completion condition")
      expect(goal.system).toContain("user-proxy steer")
      expect(goal.system).toContain("Never grant or imply human approval")
      expect(goal.system).toContain("Output exactly one concise imperative sentence")
      expect(summary.system).toContain("two or three first-person sentences")
      expect(summary.system).toContain("preserve it verbatim")
      expect(btw.system).toContain("read-only advisor")
      expect(btw.system).toContain("Do not mutate files, state, or external systems")
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
