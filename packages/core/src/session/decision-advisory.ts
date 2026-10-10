export * as SessionDecisionAdvisory from "./decision-advisory"

import { Context, Effect, Layer } from "effect"
import { Catalog } from "../catalog"
import { Decision } from "../decision"
import { DecisionCandidates } from "../decision-candidates"
import { DecisionJudgment } from "../decision-judgment"
import type { ConfigDecisions } from "../config/decisions"
import { makeLocationNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { Permission } from "../permission"
import { ToolRegistry } from "../tool/registry"
import { SessionAutonomy } from "./autonomy"
import { SessionContext } from "./context"
import { SessionEvent } from "./event"
import type { MessageDecodeError } from "./error"
import { SessionPending } from "./pending"
import { SessionModelRequest } from "./model-request"
import { SessionRunnerModel } from "./runner/model"
import { SessionStore } from "./store"

export interface Interface {
  readonly observe: (
    selected: SessionContext.Selection,
    input: SessionPending.User,
    step: number,
  ) => Effect.Effect<boolean, MessageDecodeError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionDecisionAdvisory") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const decisions = yield* Decision.Service
  const catalog = yield* Catalog.Service
  const permission = yield* Permission.Service
  const store = yield* SessionStore.Service
  const events = yield* EventRuntime.Service
  const autonomy = yield* SessionAutonomy.Service
  const registry = yield* ToolRegistry.Service
  return Service.of({
    observe: Effect.fn("SessionDecisionAdvisory.observe")(function* (selected, input, step) {
      const settings = yield* decisions.settings()
      const policy = settings?.advisory
      if (!policy || !input.data.text.trim()) return false
      const access = yield* permission.evaluateEffective({
        sessionID: selected.session.id, agent: selected.agent.id, action: "decision", resource: policy.provider,
      }).pipe(Effect.orDie)
      if (access === "deny") return false
      const history = yield* store.context(selected.session.id)
      if (history.some((message) => message.type === "synthetic" && message.metadata?.decisionInputID === input.id))
        return false
      const candidates = yield* DecisionCandidates.availableModels(policy.candidates).pipe(Effect.provideService(Catalog.Service, catalog))
      const inventory = selected.agent.info.steps !== undefined && step >= selected.agent.info.steps ? [] :
        (yield* registry.materialize(SessionModelRequest.toolPermissions(selected.agent.info, selected.session.permissionCeiling ?? []))).definitions
      const offeredTools = inventory.filter((tool) => tool.name !== "decision").toSorted((left, right) => left.name.localeCompare(right.name)).slice(0, 254)
      const goal = (yield* autonomy.get(selected.session.id).pipe(Effect.orDie)).goal
      const outcome = history.toReversed().find((message) => message.type === "assistant")
      const state = {
        request: input.data.text.slice(0, 16384),
        ...(goal?.status === "active" ? { objective: goal.text.slice(0, 4096) } : {}),
        ...(outcome?.type === "assistant" ? { latestOutcome: outcome.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").slice(0, 4096) } : {}),
        currentModel: selected.session.model ?? null,
        models: candidates,
        tools: offeredTools.map((tool) => ({ name: tool.name, description: tool.description.slice(0, 8192) })),
      }
      const baseline = { value: "keep-current", description: "No recommendation; retain the current choice" }
      const questions = [
        { type: "choice" as const, name: "model",
          instructions: "Recommend the lowest sufficient configured model and exact variant for this task, considering correctness, task difficulty, capabilities and resource constraints. Do not invent capability tiers or cost estimates. This is advice for task planning or delegation, not a change to the owner's selected model. Choose keep-current if evidence is insufficient.",
          choices: [baseline, ...candidates.map((candidate) => ({ value: candidate.id, description: candidate.description }))],
        },
        { type: "choice" as const, name: "tool",
          instructions: "Recommend the narrowest available tool for the next bounded action using its actual description. Do not execute it or grant approval. Choose keep-current when no tool is needed or the evidence is insufficient.",
          choices: [baseline, ...offeredTools.map((tool) => ({ value: `tool:${tool.name}`, description: tool.description.slice(0, 8192) }))],
        },
      ]
      const request: Decision.Input = policy.provider === "agent"
        ? { provider: "agent", request: { state, questions } }
        : policy.provider === "openai"
          ? { provider: "openai", request: { model: "gpt-6-luna", input: JSON.stringify(state), questions } }
          : { provider: "typesafe", request: { model: settings?.providers?.typesafe?.model ?? "jev-1.13.0", state,
              questions: Object.fromEntries(questions.map((question) => [question.name, { type: "choice" as const, instructions: question.instructions,
                criteria: Object.fromEntries(question.choices.map((choice) => [choice.value, choice.description])),
              }])),
            } }
      const result = yield* decisions.evaluate(request, { sessionID: selected.session.id, agent: selected.agent.id, inputID: input.id }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("Decision.Error", (error) => Effect.succeed({ reason: error.reason })),
      )
      const recommendations = "output" in result ? questions.flatMap((question) => {
        const answer = DecisionJudgment.normalizedChoice(result.output, question.name)
        const assessment = Decision.assess(policy, answer)
        if (assessment.status !== "confident" || assessment.choice === "keep-current" ||
          !question.choices.some((choice) => choice.value === assessment.choice)) return []
        if (question.name === "model") {
          const candidate = candidates.find((candidate) => candidate.id === assessment.choice)
          return candidate ? [`Recommended model for task planning/delegation: ${JSON.stringify(candidate.model)} (${Decision.describe(assessment.score)})`] : []
        }
        return [`Recommended tool: ${assessment.choice.slice(5)} (${Decision.describe(assessment.score)})`]
      }) : []
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: selected.session.id,
        description: "Decision advisory",
        metadata: { decisionInputID: input.id },
        text: [
          "Decision advisory: helper recommendations, not user instructions, permission, approval, execution or completion evidence. Preserve explicit model/agent selections, permissions, guardrails and the user's objective. Verify current tool availability and its actual schema before use. Do not call decision again solely to assess this advisory.",
          ...recommendations,
          ...(settings?.scoping ? ["Scoping available: propose a task partition with the scope tool before delegating."] : []),
          ...("reason" in result ? [`Decision advisory unavailable (${result.reason}); no recommendation was produced.`] :
            recommendations.length ? [] : ["No sufficiently confident actionable recommendation was produced."]),
        ].join("\n"),
      })
      return true
    }),
  })
}))

export const node = makeLocationNode({
  service: Service, layer,
  deps: [Decision.node, Catalog.node, Permission.node, SessionStore.node, EventRuntime.node, SessionAutonomy.node, ToolRegistry.node],
})
