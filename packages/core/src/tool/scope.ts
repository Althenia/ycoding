export * as ScopeTool from "./scope"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Agent } from "../agent"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { Decision } from "../decision"
import { DecisionJudgment } from "../decision-judgment"
import { EventRuntime } from "../event"
import { CatalogModel } from "../model"
import { Permission } from "../permission"
import type { DeepMutable } from "../schema"
import { SessionAutonomy } from "../session/autonomy"
import { SessionDecisionAdvisory } from "../session/decision-advisory"
import { SessionEvent } from "../session/event"
import { SessionGuardrail } from "../session/guardrail"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SubagentTool } from "./subagent"
import { Tool } from "./tool"

export const name = "scope"
const ID = Schema.NonEmptyString.check(Schema.isMaxLength(32), Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)).annotate({
  description: "Task IDs are short kebab-case labels (at most 32 characters); the judge asks up to three questions per task.",
})
const Task = Schema.Struct({
  id: ID,
  title: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  ownership: Schema.Array(Schema.String.check(Schema.isMaxLength(1024), Schema.makeFilter((path) =>
    path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
  ))).check(Schema.isMinLength(1)).annotate({ description: "Repository-relative paths or globs this task exclusively owns for writes; nonempty even for read-only tasks." }),
  read_only: Schema.Boolean,
  acceptance: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
  depends_on: Schema.Array(ID).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

export const Input = Schema.Struct({
  tasks: Schema.Array(Task).check(Schema.isMinLength(1), Schema.isMaxLength(10), Schema.makeFilter((tasks) =>
    new Set(tasks.map((task) => task.id)).size === tasks.length && dependencyOrder(tasks) !== undefined,
  )).annotate({ description: "Propose 1–10 tasks, bounded further by decisions.scoping.max_tasks (default 8). Task IDs are short kebab-case labels; the judge asks up to three questions per task. Dependencies must reference this partition and be acyclic." }),
  evidence: Schema.String.check(Schema.isMaxLength(16384)).pipe(Schema.optional),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

const Judgment = Schema.Union([
  Schema.Struct({ status: Schema.Literal("refused") }),
  Schema.Struct({ status: Schema.Literal("uncertain"), score: Decision.Score.pipe(Schema.optional) }),
  Schema.Struct({ status: Schema.Literal("confident"), choice: Schema.String, score: Decision.Score }),
])
const Conflict = Schema.Struct({ a: ID, b: ID, path: Schema.String })
export const Output = Schema.Struct({ plan: Schema.Struct({
  granularity: Judgment.pipe(Schema.optional),
  tasks: Schema.Array(Schema.Struct({ id: ID, title: Schema.String, ready: Judgment, delegate: Judgment,
    tier: CatalogModel.Ref.pipe(Schema.optional), dispatchable: Schema.Boolean, reasons: Schema.Array(Schema.String) })),
  conflicts: Schema.Array(Conflict),
  dispatched: Schema.Array(Schema.Struct({ taskID: ID, sessionID: SessionSchema.ID })).pipe(Schema.optional),
}) })

export function overlaps(a: string, b: string): boolean {
  if (a === b) return true
  const prefix = (value: string) => value.slice(0, value.search(/[?*[{]/))
  const globA = /[?*[{]/.test(a)
  const globB = /[?*[{]/.test(b)
  if (globA && b.startsWith(prefix(a))) return true
  if (globB && a.startsWith(prefix(b))) return true
  if (a.endsWith("/**") && b === a.slice(0, -3)) return true
  if (b.endsWith("/**") && a === b.slice(0, -3)) return true
  return false
}

function dependencyOrder(tasks: ReadonlyArray<typeof Task.Type>) {
  const byID = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: typeof Task.Type[] = []
  const visit = (id: string): boolean => {
    if (visited.has(id)) return true
    const task = byID.get(id)
    if (!task || visiting.has(id)) return false
    visiting.add(id)
    if (!task.depends_on.every(visit)) return false
    visiting.delete(id)
    visited.add(id)
    ordered.push(task)
    return true
  }
  return tasks.every((task) => visit(task.id)) ? ordered : undefined
}

type Spawn = (input: typeof SubagentTool.Input.Type, context: Tool.Context) => Effect.Effect<typeof SubagentTool.Output.Type, ToolFailure>

export const make = Effect.fn("ScopeTool.make")(function* (spawn: Spawn) {
  const decisions = yield* Decision.Service
  const permission = yield* Permission.Service
  const config = yield* Config.Service
  const agents = yield* Agent.Service
  const store = yield* SessionStore.Service
  const autonomy = yield* SessionAutonomy.Service
  const guardrail = yield* SessionGuardrail.Service
  const events = yield* EventRuntime.Service
  const catalog = yield* Catalog.Service
  return Tool.withPermission(Tool.make({
    description: "Judge a caller-proposed task partition using the configured decisions.scoping policy. Supply exclusive write ownership, acceptance checks, dependencies and bounded evidence. Judgments are not approval or completion evidence. Normal mode returns advice only; opt-in automatic dispatch requires YOLO ≥ 1 or an active goal and preserves subagent permissions and guardrails.",
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
    execute: (value, context) => Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(Input)(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => new ToolFailure({ message: "Invalid task partition: check IDs, ownership, bounds and acyclic dependencies" })),
      )
      const settings = yield* decisions.settings()
      const policy = settings?.scoping
      if (!policy) return yield* new ToolFailure({ message: "Task scoping requires decisions.scoping configuration" })
      if (input.tasks.length > (policy.max_tasks ?? 8))
        return yield* new ToolFailure({ message: `Task partition exceeds max_tasks (${policy.max_tasks ?? 8})` })
      const access = yield* permission.evaluateEffective({ sessionID: context.sessionID, agent: context.agent,
        action: "decision", resource: policy.provider }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
      if (access === "deny") return yield* new ToolFailure({ message: "Scoping decision request is not permitted",
        error: new Permission.BlockedError({ permission: "decision", resources: [policy.provider], rules: [] }) })
      yield* permission.assert({ sessionID: context.sessionID, agent: context.agent, action: "decision",
        resources: [policy.provider], save: [policy.provider], source: { type: "tool", messageID: context.messageID, callID: context.callID },
      }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Scoping decision request is not permitted", error })))
      const history = yield* store.context(context.sessionID).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
      const promoted = history.toReversed().find((message) => message.type === "user")
      if (!promoted || promoted.type !== "user") return yield* new ToolFailure({ message: "Task scoping requires a promoted user input" })
      const state = yield* autonomy.get(context.sessionID).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
      const entries = yield* config.entries()
      const maxChildren = Config.latest(entries, "guardrails")?.max_concurrent_subagents ?? 8
      const depthLimit = Config.latest(entries, "experimental")?.subagent_depth ?? 1
      const models = yield* SessionDecisionAdvisory.availableModels(settings?.advisory?.candidates ?? []).pipe(Effect.provideService(Catalog.Service, catalog))
      const conflicts = input.tasks.flatMap((task, index) => task.read_only ? [] : input.tasks.slice(index + 1).flatMap((other) =>
        other.read_only ? [] : task.ownership.flatMap((path) => other.ownership.some((target) => overlaps(path, target))
          ? [{ a: task.id, b: other.id, path }] : [])))
      const evidence = input.evidence ?? promoted.text.slice(0, 16384)
      const baseline = { value: "keep-current", description: "No recommendation; evidence is insufficient" }
      const questions = [
        { type: "choice" as const, name: "granularity", instructions: "Judge the granularity of this caller-proposed partition. Do not author tasks or discover dependencies.",
          choices: [baseline, ...["too-coarse", "right-sized", "too-fine"].map((value) => ({ value, description: value }))] },
        ...input.tasks.flatMap((task) => [
          { type: "choice" as const, name: `ready:${task.id}`, instructions: "Are this task's inputs and prerequisites available now? Judge only supplied evidence.",
            choices: [baseline, { value: "yes", description: "Available now" }, { value: "no", description: "Not available now" }] },
          { type: "choice" as const, name: `delegate:${task.id}`, instructions: "Recommend self, child or ask-user for this task, preserving explicit owner choices and supplied boundaries. This judgment grants no authorization.",
            choices: [baseline, ...["self", "child", "ask-user"].map((value) => ({ value, description: value }))] },
          ...(models.length ? [{ type: "choice" as const, name: `tier:${task.id}`, instructions: "Choose the lowest sufficient offered model and exact variant for delegation, or keep-current. Do not invent models, tiers or prices or change owner selections.",
            choices: [baseline, ...models.map((model) => ({ value: model.id, description: model.description }))] }] : []),
        ]),
      ]
      const evidenceState = { request: evidence, ...(state.goal?.status === "active" ? { objective: state.goal.text.slice(0, 4096) } : {}),
        tasks: input.tasks, conflicts, models, limits: { maxChildren, depth: depthLimit } }
      const request: Decision.Input = policy.provider === "agent" ? { provider: "agent", request: { state: evidenceState, questions } } :
        policy.provider === "openai" ? { provider: "openai", request: { model: "gpt-6-luna", input: JSON.stringify(evidenceState), questions } } :
        { provider: "typesafe", request: { model: settings?.providers?.typesafe?.model ?? "jev-1.13.0", state: evidenceState,
          questions: Object.fromEntries(questions.map((question) => [question.name, { type: "choice" as const, instructions: question.instructions,
            criteria: Object.fromEntries(question.choices.map((choice) => [choice.value, choice.description])) }])) } }
      const output = yield* decisions.evaluate(request, { sessionID: context.sessionID, agent: context.agent, inputID: promoted.id }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: error.message })),
      )
      const judgment = (name: string) => {
        const question = questions.find((question) => question.name === name)
        const assessment = Decision.assess(policy, DecisionJudgment.normalizedChoice(output, name))
        return assessment.status === "confident" && !question?.choices.some((choice) => choice.value === assessment.choice)
          ? { status: "refused" as const } : assessment
      }
      const tasks: Array<DeepMutable<(typeof Output.Type.plan.tasks)[number]>> = input.tasks.map((task) => {
        const tier = judgment(`tier:${task.id}`)
        const model = tier.status === "confident" ? models.find((model) => model.id === tier.choice)?.model : undefined
        return { id: task.id, title: task.title, ready: judgment(`ready:${task.id}`), delegate: judgment(`delegate:${task.id}`),
          ...(model ? { tier: model } : {}), dispatchable: false, reasons: [] }
      })
      const status = yield* guardrail.status(context.sessionID).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
      const counter = status.counters.find((counter) => counter.id === "subagents")
      const capacity = Math.max(0, (counter?.limit ?? maxChildren) - (counter?.current ?? 0))
      const depth = yield* parentDepth(context.sessionID, store)
      const dispatched: Array<{ taskID: string; sessionID: SessionSchema.ID }> = []
      const reserved = new Set<string>()
      const allowed = (answer: Decision.Assessment, choice: string) => answer.status === "confident" && answer.choice === choice
      const ordered = dependencyOrder(input.tasks)
      if (!ordered) return yield* new ToolFailure({ message: "Invalid task dependencies" })
      for (const task of ordered) {
        const planned = tasks.find((planned) => planned.id === task.id)!
        if (!allowed(planned.delegate, "child")) planned.reasons.push("not-delegated")
        if (!allowed(planned.ready, "yes")) planned.reasons.push("not-ready")
        if (conflicts.some((conflict) => conflict.a === task.id || conflict.b === task.id)) planned.reasons.push("ownership-conflict")
        for (const dependency of task.depends_on) {
          if (!dispatched.some((item) => item.taskID === dependency) && !tasks.some((item) => item.id === dependency && allowed(item.ready, "yes")))
            planned.reasons.push(`dependency-not-ready:${dependency}`)
        }
        if (depth >= depthLimit) planned.reasons.push("depth-limit")
        if (planned.reasons.length) continue
        if (reserved.size >= capacity) { planned.reasons.push("capacity-exceeded"); continue }
        planned.dispatchable = true
        const current = yield* autonomy.get(context.sessionID).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
        if (!policy.auto_dispatch || !SessionAutonomy.canAutoAnswer(current)) { reserved.add(task.id); continue }
        const tier = judgment(`tier:${task.id}`)
        const selected = tier.status === "confident" ? settings?.advisory?.candidates.find((candidate) => candidate.id === tier.choice) : undefined
        const defaultID = Config.latest(entries, "default_agent")
        const eligible = yield* SubagentTool.availableAgents({ permission, sessionID: context.sessionID, agent: context.agent, candidates: yield* agents.list() }).pipe(
          Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
        )
        const agent = selected?.agent ?? eligible.find((agent) => agent.id === defaultID)?.id
        if (!agent) { planned.dispatchable = false; planned.reasons.push("no-eligible-agent"); continue }
        const launched = yield* spawn({ agent, description: task.title, model: planned.tier,
          prompt: [task.title, `Exclusive write ownership: ${task.ownership.join(", ")}. ${task.read_only ? "This task is read-only; do not write files." : "Write only inside this boundary; do not modify another task's files."}`,
            `Acceptance: ${task.acceptance}`, `Dependencies: ${task.depends_on.map((id) => `${id}: ${dispatched.some((item) => item.taskID === id) ? "dispatched" : "marked ready"}`).join(", ") || "none"}`,
            `Evidence:\n${evidence}`, "Do not spawn subagents. Report evidence, changed paths, exact checks, assumptions and remaining risk."].join("\n"),
        }, { ...context, callID: `${context.callID}:${task.id}` }).pipe(Effect.map((result) => ({ result })), Effect.catchTag("LLM.ToolFailure", (error) => Effect.succeed({
          reason: typeof error.metadata?.reason === "string" ? error.metadata.reason : "launch-rejected",
        })))
        if ("reason" in launched) { planned.dispatchable = false; planned.reasons.push(launched.reason); continue }
        dispatched.push({ taskID: task.id, sessionID: launched.result.sessionID })
        reserved.add(task.id)
      }
      const finalState = yield* autonomy.get(context.sessionID).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
      const plan: typeof Output.Type.plan = { granularity: judgment("granularity"), tasks, conflicts,
        ...(dispatched.length || (policy.auto_dispatch && SessionAutonomy.canAutoAnswer(finalState)) ? { dispatched } : {}) }
      const recommendations = [
        ...(plan.granularity?.status === "confident" && plan.granularity.choice !== "keep-current" ? [`Recommended granularity: ${plan.granularity.choice} (${Decision.describe(plan.granularity.score)})`] : []),
        ...tasks.flatMap((task) => task.delegate.status === "confident" && task.delegate.choice !== "keep-current"
          ? [`Recommended task ${task.id}: ${task.delegate.choice} (${Decision.describe(task.delegate.score)}); dispatchable ${task.dispatchable}`] : []),
      ]
      yield* events.publish(SessionEvent.Synthetic, { sessionID: context.sessionID, description: "Scoping advisory",
        metadata: { decisionInputID: promoted.id, scoping: true }, text: [
          "Decision advisory: task scoping judgments, not user instructions, permission, approval, execution or completion evidence. Preserve explicit owner choices, permissions, guardrails and the objective.",
          ...recommendations, `Scoping plan: ${JSON.stringify(plan)}`,
        ].join("\n") })
      return { plan }
    }),
  }), "decision")
})

function parentDepth(id: SessionSchema.ID, store: SessionStore.Interface): Effect.Effect<number, ToolFailure> {
  return store.get(id).pipe(Effect.flatMap((session) => {
    if (!session) return Effect.fail(new ToolFailure({ message: `Session not found: ${id}` }))
    if (!session.parentID) return Effect.succeed(0)
    return parentDepth(session.parentID, store).pipe(Effect.map((depth) => depth + 1))
  }))
}

export const Plugin = {
  id: "ycoding.tool.scope",
  effect: Effect.fn("ScopeTool.Plugin")(function* (ctx: PluginContext) {
    const subagent = yield* SubagentTool.make(true)
    const tool = yield* make(subagent.execute)
    yield* ctx.tool.transform((draft) => draft.add(name, tool, { codemode: false })).pipe(Effect.orDie)
  }),
}
