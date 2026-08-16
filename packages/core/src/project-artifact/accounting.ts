export * as ProjectArtifactAccounting from "./accounting"

import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Agent } from "@ycoding-ai/schema/agent"
import { Project } from "@ycoding-ai/schema/project"
import { Session } from "@ycoding-ai/schema/session"
import type { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { createHmac, randomBytes } from "crypto"
import { and, eq, gte, inArray, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import {
  ProjectArtifactActivationTable,
  ProjectArtifactFeedbackTable,
  ProjectArtifactGlobalScopeTable,
  ProjectArtifactObservationTable,
  ProjectArtifactProjectScopeTable,
  ProjectArtifactScopeTable,
  ProjectArtifactTerminalTable,
  ProjectArtifactVersionTable,
} from "./sql"
import { Hash } from "../util/hash"

const day = 86_400_000
type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export interface Outcome {
  readonly activeArtifactCount: number
  readonly standardInvocationCount?: number
  readonly externalConfounded: boolean
  readonly terminalOutcome: ProjectArtifact.TerminalOutcome
  readonly goalStatus: ProjectArtifact.GoalStatus
}

export function eligible(input: Outcome) {
  return (
    input.activeArtifactCount === 1 &&
    (input.standardInvocationCount ?? 0) === 0 &&
    !input.externalConfounded &&
    input.terminalOutcome !== "interrupted" &&
    input.goalStatus !== "stopped"
  )
}

export function reward(input: Pick<Outcome, "terminalOutcome" | "goalStatus"> & { readonly repeatFix: boolean }) {
  if (input.terminalOutcome === "interrupted" || input.goalStatus === "stopped") return 0
  const base =
    input.terminalOutcome === "failed" || input.goalStatus === "exhausted"
      ? -1
      : input.goalStatus === "completed"
        ? 1
        : 0.25
  return Math.max(-1, base - (input.repeatFix ? 0.5 : 0))
}

export function penalty(action: ProjectArtifact.FeedbackAction) {
  if (action === "disable") return 4
  if (action === "revert") return 5
  if (action === "delete") return 6
  return 0
}

export function score(rewardUnits: number, penaltyUnits: number) {
  if (!Number.isFinite(rewardUnits) || !Number.isFinite(penaltyUnits) || rewardUnits < 0 || penaltyUnits < 0) return 0
  return (rewardUnits - penaltyUnits) / Math.max(rewardUnits + penaltyUnits, 1)
}

export function wilson(sampleCount: number, successCount: number) {
  if (
    !Number.isInteger(sampleCount) ||
    !Number.isInteger(successCount) ||
    sampleCount < 0 ||
    successCount < 0 ||
    successCount > sampleCount
  ) {
    return { lowerBound: 0, upperBound: 1 }
  }
  if (sampleCount === 0) return { lowerBound: 0, upperBound: 1 }
  const z = 1.96
  const ratio = successCount / sampleCount
  const denominator = 1 + (z * z) / sampleCount
  const center = ratio + (z * z) / (2 * sampleCount)
  const margin = z * Math.sqrt((ratio * (1 - ratio) + (z * z) / (4 * sampleCount)) / sampleCount)
  return { lowerBound: (center - margin) / denominator, upperBound: (center + margin) / denominator }
}

export interface ProjectBucketTotal {
  readonly bucketID: string
  readonly eligibleTotal: number
}

export interface ProjectBucketSample {
  readonly sampleID: string
  readonly bucketID: string
}

export function projectBucket(key: string, projectID: string) {
  return createHmac("sha256", key).update(projectID).digest("hex")
}

export function projectBucketTotals(samples: ReadonlyArray<ProjectBucketSample>): ReadonlyArray<ProjectBucketTotal> {
  return Array.from(
    samples.reduce(
      (totals, sample) => totals.set(sample.bucketID, (totals.get(sample.bucketID) ?? 0) + 1),
      new Map<string, number>(),
    ),
    ([bucketID, eligibleTotal]) => ({ bucketID, eligibleTotal }),
  ).toSorted((left, right) => left.bucketID.localeCompare(right.bucketID))
}

export function globalConfidence(candidateSampleCount: number, samples: ReadonlyArray<ProjectBucketSample>) {
  if (!Number.isInteger(candidateSampleCount) || candidateSampleCount < 30 || samples.length !== candidateSampleCount)
    return false
  if (samples.some((sample) => !sample.sampleID || !sample.bucketID)) return false
  if (new Set(samples.map((sample) => sample.sampleID)).size !== samples.length) return false
  const buckets = projectBucketTotals(samples)
  if (buckets.length < 3) return false
  return Math.max(...buckets.map((bucket) => bucket.eligibleTotal)) / candidateSampleCount <= 0.5
}

export interface ObservationalCohort {
  readonly projectID?: string
  readonly kind: string
  readonly agentID?: string
  readonly modelID?: string
  readonly goalMode: boolean
  readonly eligible: boolean
  readonly externalConfounded: boolean
  readonly managedActivationCount: number
  readonly standardInvocationCount: number
  readonly observedAt: number
}

export function matchedObservationalCohort<T extends ObservationalCohort>(input: {
  readonly projectID: string
  readonly kind: string
  readonly agentID?: string
  readonly modelID?: string
  readonly goalMode: boolean
  readonly now: number
  readonly observations: ReadonlyArray<T>
}) {
  return input.observations.filter(
    (observation) =>
      observation.projectID === input.projectID &&
      observation.kind === input.kind &&
      observation.agentID === input.agentID &&
      observation.modelID === input.modelID &&
      observation.goalMode === input.goalMode &&
      observation.eligible &&
      !observation.externalConfounded &&
      observation.managedActivationCount === 0 &&
      observation.standardInvocationCount === 0 &&
      observation.observedAt >= input.now - 30 * day &&
      observation.observedAt <= input.now,
  )
}

export interface GovernorState {
  readonly firstQualifiedAt: number | null
}

export interface GovernorTransitionInput {
  readonly stage: "trial" | "active"
  readonly createdAt: number
  readonly lastTransitionAt: number
  readonly restoredAt?: number
  readonly state: GovernorState
  readonly now: number
  readonly qualifies: boolean
  readonly action: "activate" | "degrade"
}

export interface GovernorTransition {
  readonly action: "activate" | "degrade" | "none"
  readonly state: GovernorState
}

export function governorTransition(input: GovernorTransitionInput): GovernorTransition {
  if (!input.qualifies) return { action: "none", state: { firstQualifiedAt: null } }
  if (input.now - input.createdAt < 7 * day) return { action: "none", state: { firstQualifiedAt: null } }
  if (input.restoredAt !== undefined && input.now - input.restoredAt < 7 * day) {
    return { action: "none", state: { firstQualifiedAt: null } }
  }
  if (input.action === "degrade" && input.now - input.lastTransitionAt < 7 * day) {
    return { action: "none", state: { firstQualifiedAt: null } }
  }
  if (input.state.firstQualifiedAt === null) return { action: "none", state: { firstQualifiedAt: input.now } }
  if (input.now - input.state.firstQualifiedAt < day) return { action: "none", state: input.state }
  return { action: input.action, state: { firstQualifiedAt: null } }
}

export interface DecisionInput {
  readonly stage: "trial" | "active"
  readonly createdAt: number
  readonly lastTransitionAt: number
  readonly restoredAt?: number
  readonly state: GovernorState
  readonly now: number
  readonly candidate: { readonly sampleCount: number; readonly successCount: number }
  readonly baseline?: { readonly sampleCount: number; readonly successCount: number }
  readonly explicitNegative?: boolean
  readonly global?: boolean
  readonly globalSamples?: ReadonlyArray<ProjectBucketSample>
}

export function decision(input: DecisionInput): GovernorTransition {
  const minimumSamples = input.global && input.stage === "active" ? 30 : 20
  if (input.explicitNegative || !validSampleCounts(input.candidate) || input.candidate.sampleCount < minimumSamples) {
    return { action: "none", state: { firstQualifiedAt: null } }
  }
  if (input.baseline && !validSampleCounts(input.baseline)) {
    return { action: "none", state: { firstQualifiedAt: null } }
  }
  const candidate = wilson(input.candidate.sampleCount, input.candidate.successCount)
  // Only a powered baseline can be compared against; a weaker one merely relaxes trial activation.
  const baseline =
    input.baseline && input.baseline.sampleCount >= 30
      ? wilson(input.baseline.sampleCount, input.baseline.successCount)
      : undefined
  const boundary = {
    stage: input.stage,
    createdAt: input.createdAt,
    lastTransitionAt: input.lastTransitionAt,
    restoredAt: input.restoredAt,
    state: input.state,
    now: input.now,
  }
  const degrades =
    baseline !== undefined &&
    input.candidate.sampleCount - input.candidate.successCount >= 5 &&
    candidate.upperBound + 0.1 < baseline.lowerBound &&
    (!input.global || globalConfidence(input.candidate.sampleCount, input.globalSamples ?? []))
  if (degrades) return governorTransition({ ...boundary, qualifies: true, action: "degrade" })
  if (input.stage === "active") return { action: "none", state: { firstQualifiedAt: null } }
  return governorTransition({
    ...boundary,
    qualifies: candidate.lowerBound >= 0.6 && (!baseline || candidate.lowerBound + 0.1 >= baseline.lowerBound),
    action: "activate",
  })
}

function validSampleCounts(input: { readonly sampleCount: number; readonly successCount: number }) {
  return (
    Number.isInteger(input.sampleCount) &&
    Number.isInteger(input.successCount) &&
    input.sampleCount >= 0 &&
    input.successCount >= 0 &&
    input.successCount <= input.sampleCount
  )
}

export function closeMovedProject<
  A extends { readonly scopeType: "project" | "global"; readonly projectID?: string; readonly deactivatedAt?: number },
>(activations: ReadonlyArray<A>, oldProjectID: string, at: number) {
  return activations.map((activation) =>
    activation.scopeType === "project" &&
    activation.projectID === oldProjectID &&
    activation.deactivatedAt === undefined
      ? { ...activation, deactivatedAt: at }
      : activation,
  )
}

function sameOptional(row: string | null, value: string | undefined) {
  return row === (value ?? null)
}

function sameActivation(
  row: {
    readonly id: string
    readonly scope_id: string
    readonly kind: string
    readonly artifact_id: string
    readonly version_id: string
    readonly project_id: string | null
    readonly session_id: string | null
    readonly agent_id: string | null
    readonly source: string
    readonly message_id: string | null
    readonly call_id: string | null
    readonly boundary_seq: number
    readonly activated_at: number
    readonly deactivated_at: number | null
  },
  activation: ProjectArtifact.Activation,
) {
  return (
    row.id === activation.id &&
    row.scope_id === activation.artifact.scopeID &&
    row.kind === activation.artifact.kind &&
    row.artifact_id === activation.artifact.id &&
    row.version_id === activation.artifact.versionID &&
    sameOptional(row.project_id, activation.projectID) &&
    sameOptional(row.session_id, activation.sessionID) &&
    sameOptional(row.agent_id, activation.agentID) &&
    row.source === activation.source &&
    sameOptional(row.message_id, activation.messageID) &&
    sameOptional(row.call_id, activation.callID) &&
    row.boundary_seq === activation.boundarySeq &&
    row.activated_at === activation.activatedAt &&
    row.deactivated_at === (activation.deactivatedAt ?? null)
  )
}

function activationIdentity(activation: ProjectArtifact.Activation) {
  return and(
    activation.sessionID === undefined
      ? isNull(ProjectArtifactActivationTable.session_id)
      : eq(ProjectArtifactActivationTable.session_id, activation.sessionID),
    eq(ProjectArtifactActivationTable.version_id, activation.artifact.versionID),
    eq(ProjectArtifactActivationTable.source, activation.source),
    eq(ProjectArtifactActivationTable.boundary_seq, activation.boundarySeq),
  )
}

function feedbackID(feedback: ProjectArtifact.Feedback) {
  return `paf_${Hash.sha256(
    [
      feedback.artifact.scopeID,
      feedback.artifact.kind,
      feedback.artifact.id,
      feedback.artifact.versionID,
      feedback.action,
      feedback.actor,
      feedback.timeCreated,
    ].join("\0"),
  ).slice(0, 32)}`
}

function sameFeedback(
  row: {
    readonly scope_id: string
    readonly kind: string
    readonly artifact_id: string
    readonly version_id: string
    readonly action: string
    readonly actor: string
    readonly time_created: number
  },
  feedback: ProjectArtifact.Feedback,
) {
  return (
    row.scope_id === feedback.artifact.scopeID &&
    row.kind === feedback.artifact.kind &&
    row.artifact_id === feedback.artifact.id &&
    row.version_id === feedback.artifact.versionID &&
    row.action === feedback.action &&
    row.actor === feedback.actor &&
    row.time_created === feedback.timeCreated
  )
}

function observationID(
  artifact: ProjectArtifact.Observation["artifact"],
  sessionID: Session.ID,
  terminalMessageID?: string,
) {
  return ProjectArtifact.ObservationID.make(
    `pao_${Hash.sha256([artifact.versionID, sessionID, terminalMessageID ?? "<absent>"].join("\0")).slice(0, 32)}`,
  )
}

function sameObservation(
  row: {
    readonly id: string
    readonly scope_id: string
    readonly kind: string
    readonly artifact_id: string
    readonly version_id: string
    readonly project_id: string | null
    readonly session_id: string | null
    readonly activation_set_digest: string
    readonly active_artifact_count: number
    readonly external_confounded: boolean
    readonly eligible: boolean
    readonly terminal_outcome: string
    readonly goal_status: string
    readonly repeat_fix: boolean
    readonly latency_ms: number | null
    readonly input_tokens: number | null
    readonly output_tokens: number | null
    readonly cache_read_tokens: number | null
    readonly completed_tool_count: number | null
    readonly failed_tool_count: number | null
    readonly terminal_message_id: string | null
    readonly observed_at: number
  },
  observation: ProjectArtifact.Observation,
) {
  return (
    row.id === observation.id &&
    row.scope_id === observation.artifact.scopeID &&
    row.kind === observation.artifact.kind &&
    row.artifact_id === observation.artifact.id &&
    row.version_id === observation.artifact.versionID &&
    sameOptional(row.project_id, observation.projectID) &&
    sameOptional(row.session_id, observation.sessionID) &&
    row.activation_set_digest === observation.activationSetDigest &&
    row.active_artifact_count === observation.activeArtifactCount &&
    row.external_confounded === observation.externalConfounded &&
    row.eligible === observation.eligible &&
    row.terminal_outcome === observation.terminalOutcome &&
    row.goal_status === observation.goalStatus &&
    row.repeat_fix === observation.repeatFix &&
    row.latency_ms === (observation.latencyMs ?? null) &&
    row.input_tokens === (observation.inputTokens ?? null) &&
    row.output_tokens === (observation.outputTokens ?? null) &&
    row.cache_read_tokens === (observation.cacheReadTokens ?? null) &&
    row.completed_tool_count === (observation.completedToolCount ?? null) &&
    row.failed_tool_count === (observation.failedToolCount ?? null) &&
    sameOptional(row.terminal_message_id, observation.terminalMessageID) &&
    row.observed_at === observation.observedAt
  )
}

function observationIdentity(observation: ProjectArtifact.Observation) {
  return and(
    eq(ProjectArtifactObservationTable.version_id, observation.artifact.versionID),
    observation.sessionID === undefined
      ? isNull(ProjectArtifactObservationTable.session_id)
      : eq(ProjectArtifactObservationTable.session_id, observation.sessionID),
    observation.terminalMessageID === undefined
      ? isNull(ProjectArtifactObservationTable.terminal_message_id)
      : eq(ProjectArtifactObservationTable.terminal_message_id, observation.terminalMessageID),
  )
}

function terminalID(input: ObserveInput) {
  return `pat_${Hash.sha256(
    [input.sessionID, input.terminalMessageID ?? `boundary:${input.boundarySeq}`].join("\0"),
  ).slice(0, 32)}`
}

function sameTerminal(
  row: typeof ProjectArtifactTerminalTable.$inferSelect,
  input: ObserveInput,
  id: string,
  managedActivationCount: number,
  externalConfounded: boolean,
) {
  return (
    row.id === id &&
    row.project_id === input.projectID &&
    row.session_id === input.sessionID &&
    sameOptional(row.terminal_message_id, input.terminalMessageID) &&
    row.boundary_seq === input.boundarySeq &&
    row.kind === input.kind &&
    sameOptional(row.agent_id, input.agentID) &&
    row.model_id === input.modelID &&
    row.goal_mode === input.goalMode &&
    row.managed_activation_count === managedActivationCount &&
    row.standard_invocation_count === input.standardInvocationCount &&
    row.external_confounded === externalConfounded &&
    row.terminal_outcome === input.terminalOutcome &&
    row.goal_status === input.goalStatus &&
    row.repeat_fix === input.repeatFix &&
    row.observed_at === input.observedAt
  )
}

function terminalIdentity(input: ObserveInput) {
  return and(
    eq(ProjectArtifactTerminalTable.session_id, input.sessionID),
    input.terminalMessageID === undefined
      ? and(
          isNull(ProjectArtifactTerminalTable.terminal_message_id),
          eq(ProjectArtifactTerminalTable.boundary_seq, input.boundarySeq),
        )
      : eq(ProjectArtifactTerminalTable.terminal_message_id, input.terminalMessageID),
  )
}

export type CohortScope = { readonly type: "project"; readonly projectID: Project.ID } | { readonly type: "global" }

export interface CohortInput {
  readonly scope: CohortScope
  readonly versionID: ProjectArtifact.VersionID
  readonly kind: ProjectArtifact.Kind
  readonly agentID?: Agent.ID
  readonly modelID: string
  readonly goalMode: boolean
  readonly now: number
}

export interface SampleCounts {
  readonly sampleCount: number
  readonly successCount: number
}

export interface CohortResult {
  readonly candidate: SampleCounts
  readonly baseline: SampleCounts
  readonly projectBuckets: ReadonlyArray<ProjectBucketTotal>
}

export interface DecideInput extends CohortInput {
  readonly explicitNegative?: boolean
}

export interface DecideResult extends GovernorTransition {
  readonly cohort: CohortResult
}

export interface ObserveInput {
  readonly projectID: Project.ID
  readonly sessionID: Session.ID
  readonly terminalMessageID?: string
  readonly boundarySeq: ProjectArtifact.Revision
  readonly kind: ProjectArtifact.Kind
  readonly agentID?: Agent.ID
  readonly modelID: string
  readonly goalMode: boolean
  readonly standardInvocationCount: ProjectArtifact.Revision
  readonly externalConfounded: boolean
  readonly terminalOutcome: ProjectArtifact.TerminalOutcome
  readonly goalStatus: ProjectArtifact.GoalStatus
  readonly repeatFix: boolean
  readonly latencyMs?: ProjectArtifact.TimestampMillis
  readonly inputTokens?: ProjectArtifact.Revision
  readonly outputTokens?: ProjectArtifact.Revision
  readonly cacheReadTokens?: ProjectArtifact.Revision
  readonly completedToolCount?: ProjectArtifact.Revision
  readonly failedToolCount?: ProjectArtifact.Revision
  readonly observedAt: ProjectArtifact.TimestampMillis
}

export interface Interface {
  readonly activate: (activation: ProjectArtifact.Activation) => Effect.Effect<ProjectArtifact.Activation, Error>
  readonly observe: (input: ObserveInput) => Effect.Effect<ReadonlyArray<ProjectArtifact.Observation>, Error>
  readonly feedback: (feedback: ProjectArtifact.Feedback) => Effect.Effect<string, Error>
  readonly feedbackInTransaction: (tx: Transaction, feedback: ProjectArtifact.Feedback) => Effect.Effect<string, Error>
  readonly deactivateProject: (input: {
    readonly sessionID: Session.ID
    readonly projectID: Project.ID
    readonly boundarySeq: ProjectArtifact.Revision
    readonly deactivatedAt: ProjectArtifact.TimestampMillis
  }) => Effect.Effect<number>
  readonly metrics: (versionID: ProjectArtifact.VersionID) => Effect.Effect<ProjectArtifact.Metrics>
  readonly cohort: (input: CohortInput) => Effect.Effect<CohortResult, Error>
  readonly decide: (input: DecideInput) => Effect.Effect<DecideResult, Error>
  readonly decideInTransaction: (tx: Transaction, input: DecideInput) => Effect.Effect<DecideResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProjectArtifactAccounting") {}

const makeLayer = (bucketSecret: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db

      const loadVersionOwner = Effect.fn("ProjectArtifactAccounting.loadVersionOwner")(function* (
        client: DatabaseClient | Transaction,
        versionID: ProjectArtifact.VersionID,
      ) {
        const owner = yield* client
          .select({
            scopeID: ProjectArtifactVersionTable.scope_id,
            kind: ProjectArtifactVersionTable.kind,
            artifactID: ProjectArtifactVersionTable.artifact_id,
            state: ProjectArtifactVersionTable.state,
            timeCreated: ProjectArtifactVersionTable.time_created,
            timeStateChanged: ProjectArtifactVersionTable.time_state_changed,
            firstQualifiedAt: ProjectArtifactVersionTable.first_qualified_at,
            lastRestoredAt: ProjectArtifactVersionTable.last_restored_at,
            lastGovernorTransitionAt: ProjectArtifactVersionTable.last_governor_transition_at,
            scopeType: ProjectArtifactScopeTable.type,
            projectID: ProjectArtifactProjectScopeTable.project_id,
            globalSingleton: ProjectArtifactGlobalScopeTable.singleton,
          })
          .from(ProjectArtifactVersionTable)
          .innerJoin(ProjectArtifactScopeTable, eq(ProjectArtifactVersionTable.scope_id, ProjectArtifactScopeTable.id))
          .leftJoin(
            ProjectArtifactProjectScopeTable,
            eq(ProjectArtifactVersionTable.scope_id, ProjectArtifactProjectScopeTable.scope_id),
          )
          .leftJoin(
            ProjectArtifactGlobalScopeTable,
            eq(ProjectArtifactVersionTable.scope_id, ProjectArtifactGlobalScopeTable.scope_id),
          )
          .where(eq(ProjectArtifactVersionTable.id, versionID))
          .get()
          .pipe(Effect.orDie)
        if (!owner) return yield* Effect.fail(new Error("Version owner mismatch"))
        if (owner.scopeType === "project" && owner.projectID !== null && owner.globalSingleton === null) return owner
        if (owner.scopeType === "global" && owner.projectID === null && owner.globalSingleton === 1) return owner
        return yield* Effect.fail(new Error("Version owner mismatch"))
      })

      const requireCohortOwner = Effect.fn("ProjectArtifactAccounting.requireCohortOwner")(function* (
        client: DatabaseClient | Transaction,
        input: CohortInput,
      ) {
        const owner = yield* loadVersionOwner(client, input.versionID)
        if (owner.kind !== input.kind) return yield* Effect.fail(new Error("Version owner mismatch"))
        if (input.scope.type === "project") {
          if (owner.scopeType !== "project" || owner.projectID !== input.scope.projectID) {
            return yield* Effect.fail(new Error("Version owner mismatch"))
          }
          return owner
        }
        if (owner.scopeType !== "global") return yield* Effect.fail(new Error("Version owner mismatch"))
        return owner
      })

      const activate = Effect.fn("ProjectArtifactAccounting.activate")(function* (
        activation: ProjectArtifact.Activation,
      ) {
        const existing = yield* db
          .select()
          .from(ProjectArtifactActivationTable)
          .where(eq(ProjectArtifactActivationTable.id, activation.id))
          .all()
          .pipe(Effect.orDie)
        if (existing[0]) {
          if (!sameActivation(existing[0], activation))
            return yield* Effect.fail(new Error("Conflicting activation ID"))
          return activation
        }
        const identity = yield* db
          .select()
          .from(ProjectArtifactActivationTable)
          .where(activationIdentity(activation))
          .all()
          .pipe(Effect.orDie)
        if (identity[0]) {
          if (sameActivation(identity[0], activation)) return activation
          return yield* Effect.fail(new Error("Conflicting activation identity"))
        }
        yield* db
          .insert(ProjectArtifactActivationTable)
          .values({
            id: activation.id,
            scope_id: activation.artifact.scopeID,
            kind: activation.artifact.kind,
            artifact_id: activation.artifact.id,
            version_id: activation.artifact.versionID,
            project_id: activation.projectID,
            session_id: activation.sessionID,
            agent_id: activation.agentID,
            source: activation.source,
            message_id: activation.messageID,
            call_id: activation.callID,
            boundary_seq: activation.boundarySeq,
            activated_at: activation.activatedAt,
            deactivated_at: activation.deactivatedAt,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const stored = yield* db
          .select()
          .from(ProjectArtifactActivationTable)
          .where(eq(ProjectArtifactActivationTable.id, activation.id))
          .all()
          .pipe(Effect.orDie)
        if (stored[0]) {
          if (!sameActivation(stored[0], activation)) return yield* Effect.fail(new Error("Conflicting activation ID"))
          return activation
        }
        const conflicting = yield* db
          .select()
          .from(ProjectArtifactActivationTable)
          .where(activationIdentity(activation))
          .all()
          .pipe(Effect.orDie)
        if (conflicting[0]) {
          if (sameActivation(conflicting[0], activation)) return activation
          return yield* Effect.fail(new Error("Conflicting activation identity"))
        }
        return yield* Effect.fail(new Error("Activation was not stored"))
      })

      const persistTerminal = Effect.fn("ProjectArtifactAccounting.persistTerminal")(function* (
        input: ObserveInput,
        managedActivationCount: number,
        externalConfounded: boolean,
      ) {
        const id = terminalID(input)
        const existing = yield* db
          .select()
          .from(ProjectArtifactTerminalTable)
          .where(eq(ProjectArtifactTerminalTable.id, id))
          .all()
          .pipe(Effect.orDie)
        if (existing[0]) {
          if (!sameTerminal(existing[0], input, id, managedActivationCount, externalConfounded)) {
            return yield* Effect.fail(new Error("Conflicting terminal fact ID"))
          }
          return undefined
        }
        const identity = yield* db
          .select()
          .from(ProjectArtifactTerminalTable)
          .where(terminalIdentity(input))
          .all()
          .pipe(Effect.orDie)
        if (identity[0]) {
          if (!sameTerminal(identity[0], input, id, managedActivationCount, externalConfounded)) {
            return yield* Effect.fail(new Error("Conflicting terminal fact identity"))
          }
          return undefined
        }
        yield* db
          .insert(ProjectArtifactTerminalTable)
          .values({
            id,
            project_id: input.projectID,
            session_id: input.sessionID,
            terminal_message_id: input.terminalMessageID,
            boundary_seq: input.boundarySeq,
            kind: input.kind,
            agent_id: input.agentID,
            model_id: input.modelID,
            goal_mode: input.goalMode,
            managed_activation_count: ProjectArtifact.Revision.make(managedActivationCount),
            standard_invocation_count: input.standardInvocationCount,
            external_confounded: externalConfounded,
            terminal_outcome: input.terminalOutcome,
            goal_status: input.goalStatus,
            repeat_fix: input.repeatFix,
            observed_at: input.observedAt,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const stored = yield* db
          .select()
          .from(ProjectArtifactTerminalTable)
          .where(terminalIdentity(input))
          .all()
          .pipe(Effect.orDie)
        if (!stored[0]) return yield* Effect.fail(new Error("Terminal fact was not stored"))
        if (!sameTerminal(stored[0], input, id, managedActivationCount, externalConfounded)) {
          return yield* Effect.fail(new Error("Conflicting terminal fact identity"))
        }
        return undefined
      })

      const observe = Effect.fn("ProjectArtifactAccounting.observe")(function* (input: ObserveInput) {
        const activations = yield* db
          .select()
          .from(ProjectArtifactActivationTable)
          .where(
            and(
              eq(ProjectArtifactActivationTable.session_id, input.sessionID),
              isNull(ProjectArtifactActivationTable.deactivated_at),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const externalConfounded = input.externalConfounded || input.standardInvocationCount > 0
        yield* persistTerminal(input, activations.length, externalConfounded)
        const activationSetDigest = ProjectArtifact.Digest.make(
          Hash.sha256(
            activations
              .map((activation) => activation.version_id)
              .toSorted()
              .join("\0"),
          ),
        )
        const isEligible = eligible({
          activeArtifactCount: activations.length,
          standardInvocationCount: input.standardInvocationCount,
          externalConfounded,
          terminalOutcome: input.terminalOutcome,
          goalStatus: input.goalStatus,
        })
        const observations = activations.map((activation) =>
          ProjectArtifact.Observation.make({
            id: observationID(
              {
                scopeID: activation.scope_id,
                kind: activation.kind,
                id: activation.artifact_id,
                versionID: activation.version_id,
              },
              input.sessionID,
              input.terminalMessageID,
            ),
            artifact: {
              scopeID: activation.scope_id,
              kind: activation.kind,
              id: activation.artifact_id,
              versionID: activation.version_id,
            },
            projectID: input.projectID,
            sessionID: input.sessionID,
            activationSetDigest,
            activeArtifactCount: ProjectArtifact.Revision.make(activations.length),
            externalConfounded,
            eligible: isEligible,
            terminalOutcome: input.terminalOutcome,
            goalStatus: input.goalStatus,
            repeatFix: input.repeatFix,
            latencyMs: input.latencyMs,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cacheReadTokens: input.cacheReadTokens,
            completedToolCount: input.completedToolCount,
            failedToolCount: input.failedToolCount,
            terminalMessageID: input.terminalMessageID,
            observedAt: input.observedAt,
          }),
        )
        return yield* Effect.forEach(observations, (observation) =>
          Effect.gen(function* () {
            const existing = yield* db
              .select()
              .from(ProjectArtifactObservationTable)
              .where(eq(ProjectArtifactObservationTable.id, observation.id))
              .all()
              .pipe(Effect.orDie)
            if (existing[0]) {
              if (!sameObservation(existing[0], observation))
                return yield* Effect.fail(new Error("Conflicting observation identity"))
              return observation
            }
            const identity = yield* db
              .select()
              .from(ProjectArtifactObservationTable)
              .where(observationIdentity(observation))
              .all()
              .pipe(Effect.orDie)
            if (identity[0]) {
              if (sameObservation(identity[0], observation)) return observation
              return yield* Effect.fail(new Error("Conflicting observation identity"))
            }
            yield* db
              .insert(ProjectArtifactObservationTable)
              .values({
                id: observation.id,
                scope_id: observation.artifact.scopeID,
                kind: observation.artifact.kind,
                artifact_id: observation.artifact.id,
                version_id: observation.artifact.versionID,
                project_id: observation.projectID,
                session_id: observation.sessionID,
                activation_set_digest: observation.activationSetDigest,
                active_artifact_count: activations.length,
                external_confounded: observation.externalConfounded,
                eligible: observation.eligible,
                terminal_outcome: observation.terminalOutcome,
                goal_status: observation.goalStatus,
                repeat_fix: observation.repeatFix,
                latency_ms: observation.latencyMs,
                input_tokens: observation.inputTokens,
                output_tokens: observation.outputTokens,
                cache_read_tokens: observation.cacheReadTokens,
                completed_tool_count: observation.completedToolCount,
                failed_tool_count: observation.failedToolCount,
                terminal_message_id: observation.terminalMessageID,
                observed_at: observation.observedAt,
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            const stored = yield* db
              .select()
              .from(ProjectArtifactObservationTable)
              .where(observationIdentity(observation))
              .all()
              .pipe(Effect.orDie)
            if (!stored[0]) return yield* Effect.fail(new Error("Observation was not stored"))
            if (!sameObservation(stored[0], observation))
              return yield* Effect.fail(new Error("Conflicting observation identity"))
            return observation
          }),
        )
      })

      const feedbackInTransaction = Effect.fn("ProjectArtifactAccounting.feedbackInTransaction")(function* (
        tx: Transaction,
        feedback: ProjectArtifact.Feedback,
      ) {
        const owner = yield* loadVersionOwner(tx, feedback.artifact.versionID)
        if (
          owner.scopeID !== feedback.artifact.scopeID ||
          owner.kind !== feedback.artifact.kind ||
          owner.artifactID !== feedback.artifact.id
        ) {
          return yield* Effect.fail(new Error("Version owner mismatch"))
        }
        const id = feedbackID(feedback)
        const existing = yield* tx
          .select()
          .from(ProjectArtifactFeedbackTable)
          .where(eq(ProjectArtifactFeedbackTable.id, id))
          .all()
          .pipe(Effect.orDie)
        if (existing[0] && !sameFeedback(existing[0], feedback)) {
          return yield* Effect.fail(new Error("Conflicting feedback ID"))
        }
        if (!existing[0]) {
          yield* tx
            .insert(ProjectArtifactFeedbackTable)
            .values({
              id,
              scope_id: feedback.artifact.scopeID,
              kind: feedback.artifact.kind,
              artifact_id: feedback.artifact.id,
              version_id: feedback.artifact.versionID,
              action: feedback.action,
              actor: feedback.actor,
              time_created: feedback.timeCreated,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const stored = yield* tx
            .select()
            .from(ProjectArtifactFeedbackTable)
            .where(eq(ProjectArtifactFeedbackTable.id, id))
            .all()
            .pipe(Effect.orDie)
          if (!stored[0]) return yield* Effect.fail(new Error("Feedback was not stored"))
          if (!sameFeedback(stored[0], feedback)) return yield* Effect.fail(new Error("Conflicting feedback ID"))
        }
        if (["disable", "delete", "revert", "restore", "enable"].includes(feedback.action)) {
          const version = yield* tx
            .select({ restoredAt: ProjectArtifactVersionTable.last_restored_at })
            .from(ProjectArtifactVersionTable)
            .where(
              and(
                eq(ProjectArtifactVersionTable.id, feedback.artifact.versionID),
                eq(ProjectArtifactVersionTable.scope_id, owner.scopeID),
                eq(ProjectArtifactVersionTable.kind, owner.kind),
                eq(ProjectArtifactVersionTable.artifact_id, owner.artifactID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!version) return yield* Effect.fail(new Error("Version not found"))
          const restoredAt =
            feedback.action === "restore" || feedback.action === "enable"
              ? version.restoredAt === null || version.restoredAt < feedback.timeCreated
                ? feedback.timeCreated
                : version.restoredAt
              : version.restoredAt
          yield* tx
            .update(ProjectArtifactVersionTable)
            .set({ first_qualified_at: null, last_restored_at: restoredAt })
            .where(
              and(
                eq(ProjectArtifactVersionTable.id, feedback.artifact.versionID),
                eq(ProjectArtifactVersionTable.scope_id, owner.scopeID),
                eq(ProjectArtifactVersionTable.kind, owner.kind),
                eq(ProjectArtifactVersionTable.artifact_id, owner.artifactID),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }
        return id
      })

      const feedback = Effect.fn("ProjectArtifactAccounting.feedback")(function* (value: ProjectArtifact.Feedback) {
        return yield* db
          .transaction((tx) => feedbackInTransaction(tx, value))
          .pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error("Feedback was not stored"))))
      })

      const deactivateProject = Effect.fn("ProjectArtifactAccounting.deactivateProject")(function* (input: {
        readonly sessionID: Session.ID
        readonly projectID: Project.ID
        readonly boundarySeq: ProjectArtifact.Revision
        readonly deactivatedAt: ProjectArtifact.TimestampMillis
      }) {
        const rows = yield* db
          .select({ id: ProjectArtifactActivationTable.id })
          .from(ProjectArtifactActivationTable)
          .innerJoin(
            ProjectArtifactProjectScopeTable,
            eq(ProjectArtifactActivationTable.scope_id, ProjectArtifactProjectScopeTable.scope_id),
          )
          .where(
            and(
              eq(ProjectArtifactActivationTable.session_id, input.sessionID),
              eq(ProjectArtifactProjectScopeTable.project_id, input.projectID),
              isNull(ProjectArtifactActivationTable.deactivated_at),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0) return 0
        yield* db
          .update(ProjectArtifactActivationTable)
          .set({ deactivated_at: input.deactivatedAt, boundary_seq: input.boundarySeq })
          .where(
            inArray(
              ProjectArtifactActivationTable.id,
              rows.map((row) => row.id),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        return rows.length
      })

      const deriveCohort = Effect.fn("ProjectArtifactAccounting.deriveCohort")(function* (
        client: DatabaseClient | Transaction,
        input: CohortInput,
        owner: { readonly kind: ProjectArtifact.Kind; readonly projectID: Project.ID | null },
      ) {
        const cutoff = input.now - 30 * day
        const observations = yield* client
          .select()
          .from(ProjectArtifactObservationTable)
          .where(
            and(
              eq(ProjectArtifactObservationTable.version_id, input.versionID),
              eq(ProjectArtifactObservationTable.kind, owner.kind),
              gte(ProjectArtifactObservationTable.observed_at, cutoff),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const terminals = yield* client
          .select()
          .from(ProjectArtifactTerminalTable)
          .where(
            and(
              eq(ProjectArtifactTerminalTable.kind, owner.kind),
              eq(ProjectArtifactTerminalTable.model_id, input.modelID),
              eq(ProjectArtifactTerminalTable.goal_mode, input.goalMode),
              gte(ProjectArtifactTerminalTable.observed_at, cutoff),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const matchedTerminals = terminals.filter(
          (terminal) =>
            sameOptional(terminal.agent_id, input.agentID) &&
            terminal.observed_at <= input.now &&
            (input.scope.type === "global" || terminal.project_id === owner.projectID),
        )
        const terminalByIdentity = matchedTerminals.reduce((items, terminal) => {
          const key = `${terminal.session_id}\0${terminal.terminal_message_id ?? "<absent>"}`
          const current = items.get(key)
          if (!current || current.observed_at < terminal.observed_at) items.set(key, terminal)
          return items
        }, new Map<string, typeof ProjectArtifactTerminalTable.$inferSelect>())
        const candidates = observations.reduce((items, observation) => {
          if (
            !observation.eligible ||
            observation.external_confounded ||
            observation.observed_at > input.now ||
            !observation.session_id ||
            !observation.project_id ||
            (input.scope.type === "project" && observation.project_id !== owner.projectID)
          )
            return items
          const terminal = terminalByIdentity.get(
            `${observation.session_id}\0${observation.terminal_message_id ?? "<absent>"}`,
          )
          if (
            !terminal ||
            terminal.project_id !== observation.project_id ||
            terminal.managed_activation_count !== 1 ||
            terminal.standard_invocation_count !== 0 ||
            terminal.external_confounded
          )
            return items
          const current = items.get(observation.session_id)
          if (!current || current.observation.observed_at < observation.observed_at) {
            items.set(observation.session_id, { observation, terminal })
          }
          return items
        }, new Map<string, { observation: typeof ProjectArtifactObservationTable.$inferSelect; terminal: typeof ProjectArtifactTerminalTable.$inferSelect }>())
        const candidateRows = Array.from(candidates.entries())
        const globalSamples =
          input.scope.type === "global"
            ? candidateRows.map(([sessionID, item]) => ({
                sampleID: createHmac("sha256", bucketSecret).update(`session\0${sessionID}`).digest("hex"),
                bucketID: projectBucket(bucketSecret, item.terminal.project_id),
              }))
            : []
        const candidateBuckets = new Set(globalSamples.map((sample) => sample.bucketID))
        const baselines = matchedTerminals.reduce((items, terminal) => {
          if (
            terminal.managed_activation_count !== 0 ||
            terminal.standard_invocation_count !== 0 ||
            terminal.external_confounded ||
            terminal.terminal_outcome === "interrupted" ||
            terminal.goal_status === "stopped" ||
            (input.scope.type === "global" && !candidateBuckets.has(projectBucket(bucketSecret, terminal.project_id)))
          )
            return items
          const current = items.get(terminal.session_id)
          if (!current || current.observed_at < terminal.observed_at) items.set(terminal.session_id, terminal)
          return items
        }, new Map<string, typeof ProjectArtifactTerminalTable.$inferSelect>())
        const candidate = {
          sampleCount: candidateRows.length,
          successCount: candidateRows.filter(
            ([, item]) =>
              item.observation.terminal_outcome === "succeeded" && item.observation.goal_status !== "exhausted",
          ).length,
        }
        const baselineRows = Array.from(baselines.values())
        const baseline = {
          sampleCount: baselineRows.length,
          successCount: baselineRows.filter(
            (terminal) => terminal.terminal_outcome === "succeeded" && terminal.goal_status !== "exhausted",
          ).length,
        }
        return {
          result: {
            candidate,
            baseline,
            projectBuckets: input.scope.type === "global" ? projectBucketTotals(globalSamples) : [],
          },
          globalSamples,
        }
      })

      const cohort = Effect.fn("ProjectArtifactAccounting.cohort")(function* (input: CohortInput) {
        const owner = yield* requireCohortOwner(db, input)
        return (yield* deriveCohort(db, input, owner)).result
      })

      const decideInTransaction = Effect.fn("ProjectArtifactAccounting.decideInTransaction")(function* (
        tx: Transaction,
        input: DecideInput,
      ) {
        const version = yield* requireCohortOwner(tx, input)
        const derived = yield* deriveCohort(tx, input, version)
        if (version.state !== "trial" && version.state !== "active") {
          return yield* Effect.fail(new Error("Version is not governable"))
        }
        const feedback = yield* tx
          .select({
            action: ProjectArtifactFeedbackTable.action,
            timeCreated: ProjectArtifactFeedbackTable.time_created,
          })
          .from(ProjectArtifactFeedbackTable)
          .where(
            and(
              eq(ProjectArtifactFeedbackTable.version_id, input.versionID),
              eq(ProjectArtifactFeedbackTable.scope_id, version.scopeID),
              eq(ProjectArtifactFeedbackTable.kind, version.kind),
              eq(ProjectArtifactFeedbackTable.artifact_id, version.artifactID),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const restoredAt = feedback
          .filter((item) => item.action === "restore")
          .reduce(
            (latest, item) => (latest === null || item.timeCreated > latest ? item.timeCreated : latest),
            version.lastRestoredAt,
          )
        const transition = decision({
          stage: version.state,
          createdAt: version.timeCreated,
          lastTransitionAt: version.lastGovernorTransitionAt ?? version.timeStateChanged,
          restoredAt: restoredAt ?? undefined,
          state: { firstQualifiedAt: version.firstQualifiedAt },
          now: input.now,
          candidate: derived.result.candidate,
          baseline: derived.result.baseline,
          explicitNegative:
            input.explicitNegative ||
            feedback.some((item) => item.action === "disable" || item.action === "delete" || item.action === "revert"),
          global: input.scope.type === "global",
          globalSamples: derived.globalSamples,
        })
        yield* tx
          .update(ProjectArtifactVersionTable)
          .set({
            first_qualified_at:
              transition.state.firstQualifiedAt === null
                ? null
                : ProjectArtifact.TimestampMillis.make(transition.state.firstQualifiedAt),
            last_evaluated_at: ProjectArtifact.TimestampMillis.make(input.now),
            last_restored_at: restoredAt,
            last_governor_transition_at:
              transition.action === "none"
                ? version.lastGovernorTransitionAt
                : ProjectArtifact.TimestampMillis.make(input.now),
          })
          .where(
            and(
              eq(ProjectArtifactVersionTable.id, input.versionID),
              eq(ProjectArtifactVersionTable.scope_id, version.scopeID),
              eq(ProjectArtifactVersionTable.kind, version.kind),
              eq(ProjectArtifactVersionTable.artifact_id, version.artifactID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        return { ...transition, cohort: derived.result }
      })

      const decide = Effect.fn("ProjectArtifactAccounting.decide")(function* (input: DecideInput) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const result = yield* decideInTransaction(tx, input)
              if (result.action !== "none") {
                return yield* Effect.fail(new Error("Actionable decision requires caller transaction"))
              }
              return result
            }),
          )
          .pipe(
            Effect.mapError((cause) => (cause instanceof Error ? cause : new Error("Decision state was not stored"))),
          )
      })

      const metrics = Effect.fn("ProjectArtifactAccounting.metrics")(function* (versionID: ProjectArtifact.VersionID) {
        const observations = yield* db
          .select()
          .from(ProjectArtifactObservationTable)
          .where(eq(ProjectArtifactObservationTable.version_id, versionID))
          .all()
          .pipe(Effect.orDie)
        const feedback = yield* db
          .select()
          .from(ProjectArtifactFeedbackTable)
          .where(eq(ProjectArtifactFeedbackTable.version_id, versionID))
          .all()
          .pipe(Effect.orDie)
        const samples = Array.from(
          observations
            .filter((observation) => observation.eligible)
            .reduce((items, observation) => {
              const key = observation.session_id ?? observation.id
              const current = items.get(key)
              if (!current || current.observed_at < observation.observed_at) items.set(key, observation)
              return items
            }, new Map<string, typeof ProjectArtifactObservationTable.$inferSelect>())
            .values(),
        )
        const successCount = samples.filter(
          (observation) => observation.terminal_outcome === "succeeded" && observation.goal_status !== "exhausted",
        ).length
        const interval = wilson(samples.length, successCount)
        const rewards = samples.map((observation) =>
          reward({
            terminalOutcome: observation.terminal_outcome,
            goalStatus: observation.goal_status,
            repeatFix: observation.repeat_fix,
          }),
        )
        const rewardUnits = rewards.filter((value) => value > 0).reduce((sum, value) => sum + value, 0)
        const penaltyUnits =
          rewards.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0) +
          feedback.reduce((sum, item) => sum + penalty(item.action), 0)
        return ProjectArtifact.Metrics.make({
          score: score(rewardUnits, penaltyUnits),
          confidence: {
            sampleCount: samples.length,
            successCount,
            lowerBound: interval.lowerBound,
            upperBound: interval.upperBound,
            eligible: samples.length >= 20,
          },
          rewardUnits,
          penaltyUnits,
        })
      })

      return Service.of({
        activate,
        observe,
        feedback,
        feedbackInTransaction,
        deactivateProject,
        metrics,
        cohort,
        decide,
        decideInTransaction,
      })
    }),
  )

export const layerWithSecret = (bucketSecret: string) => makeLayer(bucketSecret)
export const layer = layerWithSecret(randomBytes(32).toString("hex"))
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
