import { describe, expect } from "bun:test"
import matter from "gray-matter"
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@ycoding-ai/core/agent"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Location } from "@ycoding-ai/core/location"
import { Permission } from "@ycoding-ai/core/permission"
import { AgentPlugin } from "@ycoding-ai/core/plugin/agent"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const testLocation = location({ directory: AbsolutePath.make("/project") })
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(testLocation))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, EventRuntime.node, Location.node]), [
    [Location.node, locationLayer],
  ]) as unknown as Layer.Layer<unknown, never>,
)

describe("Agent", () => {
  it.effect("publishes an updated event after agent changes", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const events = yield* EventRuntime.Service
      const updated = yield* events
        .subscribe(Agent.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* agent.transform((editor) => editor.update(Agent.ID.make("reviewer"), () => {}))

      expect(yield* Fiber.join(updated)).toMatchObject([{ location: { directory: testLocation.directory } }])
    }),
  )

  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service

      expect(yield* agent.list()).toEqual([])
      expect(yield* agent.get(Agent.ID.make("build"))).toBeUndefined()
      expect(yield* agent.select()).toEqual({ id: Agent.ID.make("god"), info: undefined })
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("reviewer")
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
      const agent = yield* Agent.Service
      const god = Agent.ID.make("god")
      const reviewer = Agent.ID.make("reviewer")
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
      const agent = yield* Agent.Service
      const id = Agent.ID.make("reviewer")
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
      const agent = yield* Agent.Service
      const id = Agent.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("build")

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
      const agent = yield* Agent.Service
      const id = Agent.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(Agent.Info.empty(id))

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("registers the maintained built-in catalog without ambient bash access", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
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
      expect(agents[0]?.id).toBe(Agent.ID.make("god"))
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "GSD",
        "architech",
        "btw",
        "compaction",
        "decision",
        "goal",
        "god",
        "occam",
        "omoikane",
        "prediction",
        "prompt",
        "summary",
        "title",
        "wittgenstein",
        "yangi",
        "yolo-answer",
        "yolo-guardrail",
        "yolo-permission",
        "zeus",
      ])
      expect(Agent.defaultID).toBe(Agent.ID.make("god"))
      expect(yield* agent.resolve()).toMatchObject({ id: Agent.ID.make("god"), mode: "primary" })
      expect(yield* agent.get(Agent.ID.make("build"))).toBeUndefined()
      expect(yield* agent.get(Agent.ID.make("plan"))).toBeUndefined()
      expect(yield* agent.get(Agent.ID.make("explore"))).toBeUndefined()
      expect(yield* agent.get(Agent.ID.make("general"))).toBeUndefined()
      expect(yield* agent.get(Agent.ID.make("analyze"))).toBeUndefined()
      expect(yield* agent.get(Agent.ID.make("brainstorm"))).toBeUndefined()
      const prompt = agents.find((item) => String(item.id) === "prompt")
      expect(prompt).toMatchObject({ id: Agent.ID.make("prompt"), mode: "primary", hidden: true })
      if (!prompt) throw new Error("expected prompt agent")
      expect(Agent.isSelectable(prompt)).toBe(false)
      expect(prompt.system).toContain("Output only the prompt text")
      expect(prompt.system).toContain("same language as the intent")
      expect(prompt.system).toContain("comprehensive task opening")
      expect(prompt.system).toContain("mid-run correction")
      expect(prompt.system).toContain("follow-up task")
      expect(prompt.system).toContain("verifiable completion criteria")
      expect(prompt.system).toContain("Never invent repository facts")
      expect(Permission.evaluate("shell", "*", prompt.permissions).effect).toBe("deny")
      for (const id of ["GSD", "architech", "god", "yangi", "occam", "omoikane", "wittgenstein", "zeus"]) {
        const item = agents.find((agent) => String(agent.id) === id)
        if (!item) throw new Error(`expected built-in agent ${id}`)
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
        expect(Permission.evaluate("shell", "git status", item.permissions).effect).toBe("allow")
      }
      for (const id of ["GSD", "architech", "god", "yangi"]) {
        const item = agents.find((agent) => String(agent.id) === id)
        if (!item) throw new Error(`expected build-equivalent agent ${id}`)
        expect(Permission.evaluate("edit", "README.md", item.permissions).effect).toBe("allow")
        expect(Permission.evaluate("question", "*", item.permissions).effect).toBe("allow")
        expect(Permission.evaluate("plan_enter", "*", item.permissions).effect).toBe("allow")
      }
      for (const id of ["occam", "omoikane", "wittgenstein", "zeus"]) {
        const item = agents.find((agent) => String(agent.id) === id)
        if (!item) throw new Error(`expected general-equivalent agent ${id}`)
        expect(Permission.evaluate("edit", "README.md", item.permissions).effect).toBe("allow")
        expect(Permission.evaluate("question", "*", item.permissions).effect).toBe("deny")
        expect(Permission.evaluate("plan_enter", "*", item.permissions).effect).toBe("deny")
        expect(Permission.evaluate("subagent", "*", item.permissions).effect).toBe("deny")
      }
    }),
  )

  it.effect("loads each built-in's static metadata and prompt from its Markdown", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(testLocation)),
      )

      const catalog = [
        ["GSD", "GSD", "primary", 0.6, "#e67e22"],
        ["architech", "Architech", "primary", 0.5, "#3498db"],
        ["god", "God", "primary", 0.6, "#f1c40f"],
        ["yangi", "Yangi", "primary", 0.5, "#2ecc71"],
        ["occam", "Occam", "subagent", 0.4, "#2ecc71"],
        ["omoikane", "Omoikane", "subagent", 0.5, "#3498db"],
        ["wittgenstein", "Wittgenstein", "subagent", 0.4, "#95a5a6"],
        ["zeus", "Zeus", "subagent", 0.6, "#f1c40f"],
      ] as const
      for (const [id, name, mode, temperature, color] of catalog) {
        const item = yield* agent.get(Agent.ID.make(id))
        if (!item?.system) throw new Error(`expected ${id} with a system prompt`)
        const source = yield* Effect.promise(() =>
          Bun.file(new URL(`../src/plugin/agent/${id}.md`, import.meta.url)).text(),
        )
        const markdown = matter(source)
        expect(item).toMatchObject({ id, name, mode, color, request: { body: { temperature } } })
        expect(item.description).toBe(markdown.data.description)
        expect(item.system.startsWith("YCoding is the terminal-first runtime")).toBe(true)
        expect(item.system.split(markdown.content.trim())).toHaveLength(2)
        expect(Permission.evaluate("read", ".env", item.permissions).effect).toBe("ask")
        expect(Permission.evaluate("read", ".env.example", item.permissions).effect).toBe("allow")
        expect(Permission.evaluate("external_directory", "/outside", item.permissions).effect).toBe("ask")
        expect(Permission.evaluate("plan_exit", "*", item.permissions).effect).toBe("deny")
        expect(Permission.evaluate("subagent", "zeus", item.permissions).effect).toBe(
          mode === "primary" ? "allow" : "deny",
        )
      }
    }),
  )

  it.effect("places each shared guidance paragraph once before the role in every maintained built-in agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(testLocation)),
      )

      const shared = [
        "Keep a todo list for work with three or more steps, and keep it true to the work: mark an item in_progress when you start it, completed as soon as its check passes, and cancelled when it is dropped or superseded, and add new work as it appears. Every update resends the whole list with content, status, and priority for each item; a rejected update changes nothing, so fix and resend it. Before any response without tool calls, update the list so every item matches its actual state.",
        "Deliver the outcome the user asked for within the requested scope; do not perform unrequested work or add unrequested features. Treat stated causes, paths, and prescribed fixes as hypotheses: verify them by reproducing the reported symptom and confirming a fix removes it, and when evidence shows a different cause, fix that cause within scope and say so. Do not state details without concrete evidence.",
        "In replies and in every text you write, including documentation, instruction files, code comments, and commit messages, do not take the user's words literally, copy them into the text, or mention the request or its style instructions; write the intended meaning from verified evidence in the reader's own terms and conventions. Write directives and facts; omit explanations, rationale, and background the reader did not ask for.",
        "Use the supplied tool schema or discovered signature, not capability prose, to construct a call. After invalid input, inspect the returned field or path and correct the request only when the previous call is known not to have mutated state. Treat denial, unavailability, and invalid input as distinct outcomes; never replay an uncertain mutation automatically.",
        "Bound repository searches by scope and output; reuse settled results, pivot a missing broad search to a likely file, symbol, caller, or directory, and repeat reads only for changed inputs or new evidence.",
        "Never make atomic commits. Commit only a complete, self-contained product change or feature after its checks pass, as one commit that includes its code, tests, docs, and release-note entries and leaves the repository working. Never commit partial steps, follow-up fixes, or notes-only changes separately. Write the commit summary as the change's intent, and in the body state why the change exists, what behavior changed, and how it was verified, so a reviewer or auditor can understand the commit on its own.",
        "For requests to change, build, or fix, make the requested in-scope local changes and run relevant non-destructive checks without asking first.",
        "For requests to answer, explain, review, diagnose, or plan, inspect the relevant material and report. Do not make changes unless the request also asks for them.",
        "Require confirmation before external writes, purchases, destructive or irreversible actions, dependency changes, data or schema migrations, CI/CD changes, public-contract breaks, or material scope expansion.",
        "If your permission ceiling prevents asking for confirmation, do not act; report the blocker.",
        "Before overwriting or deleting existing data, check whether version control can restore it; treat untracked or ignored data as unrecoverable.",
        "Every report of changed work names each changed file by its repository-relative path; describing a change does not replace naming its file.",
        "Before building, design comprehensive test cases from the accepted requirements and contracts, and reproduce a reported failure at its boundary. Build the complete working feature or milestone together with those tests; do not alternate test and code for each small step, and add no mutation probes unless requested. At each feature checkpoint, run the focused tests once, fix failures, and rerun only the failing scope; run full suites and every affected required check at the integration or merge checkpoint.",
      ]
      for (const id of ["zeus", "GSD", "architech", "god", "yangi", "occam", "omoikane", "wittgenstein"]) {
        const item = yield* agent.get(Agent.ID.make(id))
        if (!item?.system) throw new Error(`expected ${id} with a system prompt`)
        for (const paragraph of shared) {
          expect(item.system.split(paragraph)).toHaveLength(2)
          expect(item.system.indexOf(paragraph)).toBeLessThan(item.system.indexOf("You are "))
        }
      }

      const god = yield* agent.get(Agent.ID.make("god"))
      const zeus = yield* agent.get(Agent.ID.make("zeus"))
      const title = yield* agent.get(Agent.ID.make("title"))
      const compaction = yield* agent.get(Agent.ID.make("compaction"))
      const goal = yield* agent.get(Agent.ID.make("goal"))
      const summary = yield* agent.get(Agent.ID.make("summary"))
      const btw = yield* agent.get(Agent.ID.make("btw"))
      const gsd = yield* agent.get(Agent.ID.make("GSD"))
      if (
        !gsd?.system ||
        !god?.system ||
        !zeus?.system ||
        !title?.system ||
        !compaction?.system ||
        !goal?.system ||
        !summary?.system ||
        !btw?.system
      ) {
        throw new Error("expected maintained built-in prompts")
      }
      expect(god.system).toContain("Denies remain denied.")
      expect(god.system).toContain("Four independent Session toggles: YOLO, autoPermission, autoGuardrail, and autoAnswer, each off by default; changing one rewrites none of the others")
      expect(god.system).toContain("autoPermission approves ask permissions by rule across the managed-task chain")
      expect(god.system).toContain("awake autoGuardrail approves ordinary standard guardrail reviews, never hard or custom-rule reviews")
      expect(god.system).toContain("autoAnswer supplies only an explicit valid default or a single option labelled (Recommended)")
      expect(god.system).toContain("YOLO alone enables the hidden yolo-permission, yolo-guardrail, and yolo-answer evaluators")
      expect(god.system).toContain("only YOLO generates answers, including free text")
      expect(god.system).toContain("guardrails.decide_reviews is on unless explicitly false")
      expect(god.system).toContain("strict allow, deny, or escalate")
      expect(god.system).toContain("never answers questions or forms")
      expect(god.system).toContain("A hard review is never model-approved")
      expect(god.system).toContain("Goals grant no permission, answer, or review authority")
      expect(god.system).toContain("Enabled standard verification dismisses only a confident non-match at confidence ≥0.9")
      expect(god.system).toContain("denies and custom rules are never verified")
      expect(god.system).toContain("asleep, it defers to the review box")
      for (const stale of ["YOLO 1", "YOLO 2", "default false", "≥0.95", "Session's auto-answer toggle, default off"])
        expect(god.system).not.toContain(stale)
      expect(god.system).toContain("Implement or delegate as your role directs.")
      expect(god.system).toContain("launch every ready independent task in parallel")
      expect(god.system).toContain("score size, difficulty, complexity, and risk against a rubric")
      expect(god.system).toContain(
        "never guess an identifier or variant, and without that knowledge omit the model so the child runs on this session's model",
      )
      for (const id of ["GSD", "architech", "god", "yangi"]) {
        const primary = yield* agent.get(Agent.ID.make(id))
        expect(primary?.system).toContain("Honor explicit user selections of subagent profile, provider, and model.")
        expect(primary?.system).toContain("Otherwise choose among configured available models for the task")
        expect(primary?.system).toContain("the child provider may differ from the parent's")
        expect(primary?.system).toContain("Set a model only with an exact provider, model, and advertised variant known to be available")
        expect(primary?.system).toContain("each changed file path")
        expect(primary?.system).toContain(
          "Keep working while subagents and background shells run. A response without tool calls stops you until a notification or the user arrives, so never send one only to wait or to report progress while any task is ready.",
        )
        expect(primary?.system).toContain("continue at once with every task that neither consumes a running task's output nor edits its files")
        expect(primary?.system).toContain("Start a long command, such as a build, test suite, or eval, in the background whenever other work remains.")
        expect(primary?.system).toContain("Stop only when every unfinished task waits on a running task or on the user, and name that dependency for each.")
        expect(primary?.system).not.toContain("Orchestrate; do not implement.")
        expect(primary?.system).toContain("Preserve permission ceilings")
        expect(primary?.system).toContain("never silently substitute a different profile or provider")
        expect(primary?.system).not.toContain("choose a model from the provider of this session's active model")
      }
      expect(god.system).toContain("Use the decision tool")
      expect(god.system).toContain("Issue independent tool calls together in one step. Serialize only for a real dependency")
      expect(god.system).toContain("A queued or running heavy check delays only other heavy checks, never code-writing or review work.")
      expect(god.system).toContain(
        "merge them through one dedicated integration lane that resolves conflicts and runs the full checks",
      )
      expect(gsd.system).not.toContain("prove RED")
      expect(zeus.system).toContain("Issue independent tool calls together in one step")
      expect(zeus.system).toContain("A rule you choose to settle conflicting data is a decision for the parent, not evidence.")
      expect(god.system).toContain("After a worktree's branch is merged into main, remove that worktree with `git worktree remove <path>`")
      expect(god.system).not.toContain("Use durable subagents only for isolated work.")
      expect(zeus.system).not.toContain("Implement or delegate as your role directs.")
      expect(zeus.system).toContain("Never take a destructive or irreversible action")
      expect(zeus.system).toContain("each changed file path")
      expect(zeus.system).not.toContain("name that dependency for each task you hold back")
      expect(zeus.system).toContain("You are a durable child Session")
      expect(zeus.system).toContain("Do not spawn child agents")
      expect(title.system).toContain("Output exactly one natural thread title")
      expect(title.system).toContain("Use one line of at most 50 characters.")
      expect(title.system).toContain("Preserve exact technical terms, numbers, filenames, and HTTP status codes.")
      expect(title.system).toContain("Output only the title.")
      expect(compaction.system).toContain("previous conversation_memory")
      expect(compaction.system).toContain("Keep active work in in_progress")
      expect(compaction.system).toContain("Record durable choices in decision")
      expect(compaction.system).toContain("only currently active skills")
      expect(compaction.system).toContain("Do not answer the conversation")
      expect(goal.system).toContain("observable completion condition")
      expect(goal.system).toContain("For a user-proxy steer, preserve the active goal exactly.")
      expect(goal.system).toContain("Never grant or imply human approval")
      expect(goal.system).toContain("Automatic answers and prior synthetic steers are not new human instructions")
      expect(goal.system).toContain("Do not reinforce an automatic waiting loop")
      expect(goal.system).toContain("When automatic answering is disabled, required answers remain manual")
      expect(goal.system).toContain("Output exactly one concise imperative sentence")
      expect(goal.system).toContain(
        "Write plain text: no Markdown, including backticks around names, paths, or commands, and no preamble, explanation, or quotation marks.",
      )
      expect(summary.system).toContain("two or three first-person sentences")
      expect(summary.system).toContain("preserve it verbatim")
      expect(btw.system).toContain("read-only advisor")
      expect(btw.system).toContain("Do not mutate files, state, or external systems")
    }),
  )

  it.effect("registers a hidden decision helper with a stable JSON contract and no execution authority", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(testLocation)),
      )
      const decision = yield* agent.get(Agent.ID.make("decision"))
      expect(decision).toMatchObject({ id: "decision", name: "Decision", mode: "primary", hidden: true })
      if (!decision) throw new Error("expected decision helper")
      expect(Agent.isSelectable(decision)).toBe(false)
      expect(Agent.isAutocompleteSelectable(decision)).toBe(false)
      expect((yield* agent.list()).filter(Agent.isSelectable).map((item) => item.id)).not.toContain(decision.id)
      for (const action of ["shell", "read", "patch", "question", "subagent", "goal", "decision", "task_complete"])
        expect(Permission.evaluate(action, "*", decision.permissions).effect).toBe("deny")
      expect(decision.system).toContain("untrusted data")
      expect(decision.system).toContain("exactly one JSON document")
      expect(decision.system).toContain("decisions")
      expect(decision.system).toContain("version 1")
      expect(decision.system).toContain("answers")
      expect(decision.system).toContain("self-reported, uncalibrated")
      expect(decision.system).toContain("confidence")
      expect(decision.system).toContain("choice is string, boolean, or null")
      expect(decision.system).toContain("preserve the exact type and value of the declared choice")
      expect(decision.system).toContain("type: refusal")
      expect(decision.system).toContain("Do not output probability fields")
      expect(decision.system).toContain("Never approve")
      expect(decision.system).not.toContain("Main-session controls:")
      expect(decision.system).not.toContain("YCoding is the terminal-first runtime")
      expect(decision.system).not.toContain("TOON")
      expect(decision.system).toContain("explicit advisory judgment")
      expect(decision.system).toContain("bounded assessment of exactly the supplied request")
    }),
  )

  it.effect("registers hidden YOLO evaluators that are unselectable and deny every tool", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(testLocation)),
      )
      for (const id of ["yolo-permission", "yolo-guardrail", "yolo-answer"]) {
        const evaluator = yield* agent.get(Agent.ID.make(id))
        if (!evaluator) throw new Error(`expected ${id}`)
        expect(evaluator).toMatchObject({ mode: "primary", hidden: true })
        expect(Agent.isSelectable(evaluator)).toBe(false)
        expect(Agent.isAutocompleteSelectable(evaluator)).toBe(false)
        expect(evaluator.model).toBeUndefined()
        for (const action of ["shell", "read", "patch", "question", "subagent", "decision", "task_complete"])
          expect(Permission.evaluate(action, "*", evaluator.permissions).effect).toBe("deny")
        expect(evaluator.system).toContain("exactly one JSON document")
      }
    }),
  )

  it.effect("gives the default primary agent its exact permission ruleset", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(testLocation)),
      )

      expect((yield* agent.get(Agent.ID.make("god")))?.permissions).toEqual([
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
    }),
  )

  it.effect("configures BTW as a read-only advisor that requests approval for mutations", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
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

      const btw = yield* agent.get(Agent.ID.make("btw"))
      if (!btw) throw new Error("expected BTW agent")
      expect(btw).toMatchObject({ name: "BTW", mode: "subagent", hidden: false })
      expect(Permission.evaluate("read", "README.md", btw.permissions).effect).toBe("allow")
      expect(Permission.evaluate("edit", "README.md", btw.permissions).effect).toBe("ask")
      expect(Permission.evaluate("shell", "git status", btw.permissions).effect).toBe("ask")
      expect(Permission.evaluate("worktree", "/data/worktrees/repo_abc/feature", btw.permissions).effect).toBe("ask")
    }),
  )
})
