export * as SessionDecisionRouting from "./decision-routing"

import { Context, Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Agent } from "../agent"
import { Catalog } from "../catalog"
import { Database } from "../database/database"
import { Decision } from "../decision"
import { makeLocationNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { CatalogModel } from "../model"
import { Permission } from "../permission"
import { PluginSupervisor } from "../plugin/supervisor"
import { ProjectArtifactSource } from "../project-artifact/source"
import { StepFailedError } from "./error"
import { SessionEvent } from "./event"
import { SessionPending } from "./pending"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { SessionMessageTable } from "./sql"

export interface Interface {
  readonly route: (sessionID: SessionSchema.ID, delivery: SessionPending.Delivery | undefined) =>
    Effect.Effect<void, StepFailedError | SessionRunnerModel.Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionDecisionRouting") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const decision = yield* Decision.Service
  const agents = yield* Agent.Service
  const catalog = yield* Catalog.Service
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const permission = yield* Permission.Service
  const plugins = yield* PluginSupervisor.Service
  const artifacts = yield* ProjectArtifactSource.Service
  const models = yield* SessionRunnerModel.Service
  const store = yield* SessionStore.Service
  const db = database.db

  const eligible = Effect.fn("SessionDecisionRouting.eligible")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session || session.parentID || session.fork || session.agent !== undefined || session.model !== undefined) return undefined
    const message = yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID)).limit(1).get().pipe(Effect.orDie)
    if (message) return undefined
    const step = yield* db.select({ id: EventTable.id }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, sessionID),
      eq(EventTable.type, EventRuntime.versionedType(SessionEvent.Step.Started.type, SessionEvent.Step.Started.durable.version)),
    )).limit(1).get().pipe(Effect.orDie)
    if (step) return undefined
    return session
  })

  return Service.of({ route: Effect.fn("SessionDecisionRouting.route")(function* (sessionID, delivery) {
    if (!delivery) return
    const policy = (yield* decision.settings())?.routing
    if (!policy) return
    const session = yield* eligible(sessionID)
    if (!session) return
    const pending = (yield* SessionPending.list(db, sessionID)).find((entry) =>
      entry.type === "user" && (delivery === "queue" || entry.delivery === "steer"),
    )
    if (!pending || pending.type !== "user" || !pending.data.text.trim()) return
    yield* plugins.flush
    const availableAgents = yield* agents.list()
    const currentAgent = yield* agents.select()
    const availableModels = yield* catalog.model.available()
    const candidates = yield* Effect.filter(policy.candidates, (candidate) => Effect.gen(function* () {
      if (!candidate.agent && !candidate.model || candidate.id === "keep-current") return false
      if (candidate.agent) {
        const agent = availableAgents.find((agent) => agent.id === candidate.agent)
        if (!agent || !Agent.isSelectable(agent)) return false
        const access = yield* permission.evaluateEffective({ sessionID, agent: currentAgent.id,
          action: "agent", resource: candidate.agent }).pipe(Effect.orDie)
        if (access !== "allow") return false
      }
      if (!candidate.model) return true
      return availableModels.some((model) => model.providerID === candidate.model?.providerID &&
        model.id === candidate.model.model && SessionRunnerModel.supported(model) &&
        (candidate.model.variant === undefined || model.variants?.some((variant) => variant.id === candidate.model?.variant)))
    }))
    if (!candidates.length) return
    const answer = yield* decision.choose({
      context: { sessionID, agent: currentAgent.id, inputID: pending.id }, provider: policy.provider,
      state: { text: pending.data.text },
      instructions: "Choose the configured agent and model route best suited to the first user request. Choose keep-current when no route is clearly appropriate.",
      choices: Object.fromEntries([
        ["keep-current", "Keep the current default agent and model"],
        ...candidates.map((candidate) => [candidate.id, candidate.description]),
      ]),
    }).pipe(Effect.mapError((error) => new StepFailedError({ error: { type: "decision.routing.failed", message: error.message } })))
    if (answer.refused || answer.probability === undefined || !Number.isFinite(answer.probability) ||
      answer.probability < policy.min_probability || answer.probability > 1 || answer.choice === "keep-current") return
    const candidate = candidates.find((candidate) => candidate.id === answer.choice)
    if (!candidate) return
    const model = candidate.model ? CatalogModel.Ref.make({ providerID: candidate.model.providerID,
      id: candidate.model.model, ...(candidate.model.variant === undefined ? {} : { variant: candidate.model.variant }) }) : undefined
    const latest = yield* eligible(sessionID)
    if (!latest) return
    yield* models.resolve({ ...latest, ...(model === undefined ? {} : { model }) })
    const agent = candidate.agent === undefined ? undefined : Agent.ID.make(candidate.agent)
    const provenance = agent ? yield* artifacts.provenance("agent", agent) : undefined
    yield* db.transaction(() => Effect.gen(function* () {
      const current = yield* eligible(sessionID)
      if (!current || current.location.directory !== session.location.directory ||
        current.location.workspaceID !== session.location.workspaceID ||
        !(yield* SessionPending.find(db, pending.id))) return
      if (agent) {
        const selected = yield* agents.get(agent)
        if (!selected || !Agent.isSelectable(selected)) return
        const access = yield* permission.evaluateEffective({ sessionID, agent: currentAgent.id,
          action: "agent", resource: agent }).pipe(Effect.orDie)
        if (access !== "allow") return
      }
      if (model && !(yield* catalog.model.available()).some((available) => available.providerID === model.providerID &&
        available.id === model.id && (model.variant === undefined || available.variants?.some((variant) => variant.id === model.variant)))) return
      if (agent) yield* events.publish(SessionEvent.AgentSelected, { sessionID, agent,
        artifact: provenance ? { scopeID: provenance.scopeID, versionID: provenance.versionID, kind: provenance.kind,
          id: provenance.id, sourceScope: provenance.scope } : undefined }, {
        commit: provenance ? (seq) => artifacts.activate({ kind: "agent", id: agent, sessionID, agentID: agent,
          source: "agent-selected", boundarySeq: ProjectArtifact.Revision.make(seq),
          activatedAt: ProjectArtifact.TimestampMillis.make(Date.now()) }).pipe(Effect.orDie) : undefined,
      })
      if (model) yield* events.publish(SessionEvent.ModelSelected, { sessionID, model })
    })).pipe(Effect.orDie)
  }) })
}))

export const node = makeLocationNode({ service: Service, layer, deps: [
  Decision.node, Agent.node, Catalog.node, Database.node, EventRuntime.node, Permission.node,
  PluginSupervisor.node, ProjectArtifactSource.node, SessionRunnerModel.node, SessionStore.node,
] })
