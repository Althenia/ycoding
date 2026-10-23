export * as CoordinationDecisions from "./coordination-decisions"

import type { Coordination } from "@ycoding-ai/schema/coordination"
import { Context, Effect, Layer } from "effect"
import { ConfigCoordination } from "../config/coordination"
import type { CoordinationService } from "../coordination/index"
import type { Form } from "../form"
import type { Permission } from "../permission"
import type { SessionGuardrail } from "./guardrail"
import type { SessionSchema } from "./schema"

export type Kind = "question" | "permission" | "review"

export interface EvaluateInput {
  readonly groupID: Coordination.GroupID
  readonly coordinatorSessionID: SessionSchema.ID
  readonly targetSessionID: SessionSchema.ID
  readonly requestID: string
  readonly kind: Kind
  readonly fingerprint: string
  readonly rationale: string
  readonly confidence?: number
  readonly answer?: Form.Answer
}

export interface Result {
  readonly outcome: "allowed" | "denied" | "escalated" | "stale"
  readonly kind: Kind
  readonly requestID: string
  readonly fingerprint: string
  readonly actor: "coordinator"
  readonly settled: boolean
  readonly via?: string
  readonly confidence?: number
  readonly source?: Form.ReplySource
  readonly rationale?: string
  readonly reason?: string
}

export interface Dependencies {
  readonly policy: () => Effect.Effect<ConfigCoordination.Resolved>
  readonly scopeOf: (sessionID: SessionSchema.ID) => Effect.Effect<CoordinationService.Scope | undefined>
  readonly permission: Pick<Permission.Interface, "snapshot" | "snapshots" | "reconsider">
  readonly form: Pick<Form.Interface, "snapshot" | "snapshots" | "reconsider">
  readonly guardrail: Pick<SessionGuardrail.Interface, "requestSnapshot" | "requestSnapshots" | "reconsider">
  readonly now?: Effect.Effect<number>
}

export interface PendingInput {
  readonly groupID: Coordination.GroupID
  readonly coordinatorSessionID: SessionSchema.ID
  readonly targetSessionID: SessionSchema.ID
  readonly limit?: number
}

export type PendingSnapshot =
  | { readonly kind: "permission"; readonly request: Permission.Request; readonly fingerprint: string }
  | { readonly kind: "review"; readonly request: SessionGuardrail.RequestSnapshot["request"]; readonly fingerprint: string }
  | { readonly kind: "question"; readonly form: Form.Info; readonly fingerprint: string; readonly state: Form.State }

export interface Interface {
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<Result>
  readonly pending: (input: PendingInput) => Effect.Effect<ReadonlyArray<PendingSnapshot>>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/CoordinationDecisions") {}

const readActions = new Set(["read", "glob", "grep", "webfetch", "websearch", "browser_read"])

function metadataText(value: unknown, depth = 0): string {
  if (depth > 3) return ""
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => metadataText(item, depth + 1)).join("\n")
  if (value === null || typeof value !== "object") return ""
  return Object.values(value).slice(0, 20).map((item) => metadataText(item, depth + 1)).join("\n")
}

export function humanOnlyReason(input: {
  readonly kind: Kind
  readonly action?: string
  readonly resources?: ReadonlyArray<string>
  readonly metadata?: unknown
  readonly hardReview?: boolean
  readonly ruleIDs?: ReadonlyArray<string>
}) {
  if (input.hardReview === true) return "human-only:hard-review"
  if (typeof input.metadata === "object" && input.metadata !== null && "requireHuman" in input.metadata && input.metadata.requireHuman === true)
    return "human-only:request"
  const action = input.action ?? ""
  const evidence = [action, ...(input.resources ?? []), ...(input.ruleIDs ?? []), metadataText(input.metadata)].join("\n").toLowerCase()
  const mutation = input.kind !== "question" && !readActions.has(action)
  const sensitive = /(credential|secret|api[_-]?key|access[_-]?token|private[_-]?key|id_rsa|\.env(?:\.|\b)|\.aws\/|\.ssh\/|keychain|password|oauth|\baccount\b)/
  if ((mutation || input.kind === "question") && sensitive.test(evidence)) return "human-only:credentials-account"
  if (mutation && /(\.github\/workflows\/|\.gitlab-ci|jenkinsfile|\.circleci\/|\bci\/cd\b|\bcicd\b)/.test(evidence)) return "human-only:ci-cd"
  if ((mutation || input.kind === "question") && /(db:migrate|database migration|prisma migrate|drizzle[^\n]*migrat|alembic upgrade|rails db:migrate|migrat[^\n]*(prod|production)|(prod|production)[^\n]*migrat)/.test(evidence))
    return "human-only:production-migration"
  if ((mutation || input.kind === "question") && /(purchase|checkout|payment|\bpaid\b|billing|subscribe|subscription|buy now)/.test(evidence))
    return "human-only:purchase-spend"
  if (mutation && /(git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|gh\s+(pr|release|issue)\s+(create|merge|comment)|\bpublish\b)/.test(evidence))
    return "human-only:publication"
  if (mutation && /(wrangler\s+deploy|kubectl\s+apply|terraform\s+apply|\bdeploy\b|release\s+create|git\s+tag\b)/.test(evidence))
    return "human-only:deploy-release"
  if (mutation && /(rm\s+-[a-z]*r|rm\s+--recursive|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|drop\s+(table|database)|truncate\s+table|delete\s+from\b|mkfs|dd\s+if=|\bshred\b)/.test(evidence))
    return "human-only:destructive-irreversible"
  if (mutation && /(\b(bun|npm|pnpm|yarn|pip|pip3|brew|apt|apt-get|cargo|go)\s+(install|add)\b|\bwget\b|\bcurl\b[^\n]*(?:\s-o\b|\s-o\s|--output)|\bdownload\b)/.test(evidence))
    return "human-only:dependency-install-download"
  if (mutation && (action === "external_directory" || /(curl\b[^\n]*(-x\s*(post|put|patch|delete)|--data|--form)|wget\b[^\n]*--post|\bscp\b|rsync\b[^\n]*:|ssh\b[^\n]*\s\S+@)/.test(evidence)))
    return "human-only:external-write"
  if ((mutation || input.kind === "question") && /(public contract|breaking change|scope expansion|expand (the )?scope)/.test(evidence)) return "human-only:scope-expansion"
  return undefined
}

const localWriteActions = new Set(["edit", "write", "patch", "file_mutation"])
const readShellCommands = new Set(["cat", "ls", "pwd", "grep", "rg", "find", "stat", "head", "tail", "wc", "test", "git"])

function simpleReadOnlyShell(command: string) {
  const value = command.trim()
  if (value.length === 0 || /[;|&<>`$\\\n\r]/.test(value) || value.includes("$(")) return false
  const tokens = value.split(/\s+/).filter(Boolean)
  const first = tokens[0]?.replace(/^.*\//, "")
  if (first === undefined || !readShellCommands.has(first)) return false
  if (tokens.some((token) => ["-delete", "-exec", "-execdir", "--pre", "--output", "-o"].includes(token))) return false
  if (first === "git") return ["status", "diff", "log", "show", "rev-parse", "ls-files"].includes(tokens[1] ?? "")
  if (first === "find") return !tokens.some((token) => token.startsWith("-delete") || token.startsWith("-exec"))
  return true
}

export function routineEligible(input: {
  readonly kind: Kind
  readonly action?: string
  readonly resources?: ReadonlyArray<string>
}) {
  if (input.kind === "question") return true
  const action = input.action ?? ""
  if (readActions.has(action) || localWriteActions.has(action)) return true
  if (action === "shell") return (input.resources ?? []).length > 0 && (input.resources ?? []).every(simpleReadOnlyShell)
  return false
}

export function make(deps: Dependencies): Interface {
  const authorize = Effect.fnUntraced(function* (input: PendingInput, inspectMaster = false) {
    const scope = yield* deps.scopeOf(input.coordinatorSessionID)
    if (scope === undefined || scope.groupID !== input.groupID) return { ok: false as const, reason: "delegation-unavailable" }
    if (!(inspectMaster && input.targetSessionID === scope.masterSessionID) &&
      (!scope.memberSessionIDs.includes(input.targetSessionID) || input.coordinatorSessionID === input.targetSessionID))
      return { ok: false as const, reason: "delegation-out-of-scope" }
    return { ok: true as const, scope }
  })

  const validate = (input: EvaluateInput, action: string, resources: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const authorized = yield* authorize(input)
      if (!authorized.ok) return authorized
      if (!authorized.scope.active) return { ok: false as const, reason: "delegation-inactive" }
      const policy = yield* deps.policy()
      if (!policy.enabled) return { ok: false as const, reason: "delegation-revoked" }
      const now = yield* (deps.now ?? Effect.sync(() => Date.now()))
      const group = authorized.scope.settings.delegatedDecisions
      if ((policy.expiresAt !== undefined && policy.expiresAt <= now) || (group?.expiresAt !== undefined && group.expiresAt <= now))
        return { ok: false as const, reason: "delegation-expired" }
      if (!ConfigCoordination.permits(policy, group, { category: input.kind, action, resources, now }))
        return { ok: false as const, reason: "delegation-out-of-scope" }
      return { ok: true as const }
    })

  const pending = Effect.fn("CoordinationDecisions.pending")(function* (input: PendingInput) {
    if (!(yield* authorize(input, true)).ok) return [] as ReadonlyArray<PendingSnapshot>
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)))
    const permissions = yield* deps.permission.snapshots(input.targetSessionID)
    const reviews = yield* deps.guardrail
      .requestSnapshots(input.targetSessionID)
      .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed([] as ReadonlyArray<SessionGuardrail.RequestSnapshot>)))
    const questions = yield* deps.form.snapshots(input.targetSessionID)
    return [
      ...permissions.slice(0, limit).map((item): PendingSnapshot => ({ kind: "permission", request: item.request, fingerprint: item.fingerprint })),
      ...reviews.slice(0, limit).map((item): PendingSnapshot => ({ kind: "review", request: item.request, fingerprint: item.fingerprint })),
      ...questions.slice(0, limit).map((item): PendingSnapshot => ({ kind: "question", form: item.form, fingerprint: item.fingerprint, state: item.state })),
    ].slice(0, limit)
  })

  const evaluate = Effect.fn("CoordinationDecisions.evaluate")(function* (input: EvaluateInput) {
    const base = {
      kind: input.kind,
      requestID: input.requestID,
      fingerprint: input.fingerprint,
      actor: "coordinator" as const,
      rationale: input.rationale,
    }
    const stale: Result = { ...base, outcome: "stale", settled: false }
    const rationale = input.rationale.trim()
    if (rationale.length === 0 || rationale.length > 500)
      return { ...base, outcome: "escalated" as const, settled: false, reason: "rationale-required" }
    if (input.answer !== undefined && input.kind !== "question")
      return { ...base, outcome: "escalated" as const, settled: false, reason: "invalid-answer" }
    if (
      input.kind === "question" &&
      input.answer !== undefined &&
      input.confidence !== undefined &&
      (!Number.isFinite(input.confidence) || input.confidence < 0.8)
    )
      return { ...base, outcome: "escalated" as const, settled: false, reason: "low-confidence" }
    const source = { coordinatorSessionID: input.coordinatorSessionID, groupID: input.groupID, rationale }

    if (input.kind === "permission") {
      const snapshot = yield* deps.permission.snapshot(input.requestID as Permission.ID)
      if (snapshot === undefined || snapshot.request.sessionID !== input.targetSessionID || snapshot.fingerprint !== input.fingerprint)
        return stale
      const human = humanOnlyReason({
        kind: input.kind,
        action: snapshot.request.action,
        resources: snapshot.request.resources,
        metadata: snapshot.request.metadata,
      })
      if (human !== undefined) return { ...base, outcome: "escalated" as const, settled: false, reason: human }
      if (!routineEligible({ kind: input.kind, action: snapshot.request.action, resources: snapshot.request.resources }))
        return { ...base, outcome: "escalated" as const, settled: false, reason: "unknown-semantics" }
      const initial = yield* validate(input, snapshot.request.action, snapshot.request.resources)
      if (!initial.ok) return { ...base, outcome: "escalated" as const, settled: false, reason: initial.reason }
      const result = yield* deps.permission.reconsider({
        requestID: input.requestID as Permission.ID,
        fingerprint: input.fingerprint,
        actor: "coordinator",
        source,
        validate: (request) =>
          validate(input, request.action, request.resources).pipe(
            Effect.map(
              (checked) =>
                checked.ok &&
                routineEligible({ kind: input.kind, action: request.action, resources: request.resources }) &&
                humanOnlyReason({ kind: input.kind, action: request.action, resources: request.resources, metadata: request.metadata }) ===
                  undefined,
            ),
          ),
      })
      return { ...base, ...result }
    }

    if (input.kind === "review") {
      const snapshot = yield* deps.guardrail
        .requestSnapshot(input.targetSessionID, input.requestID as SessionGuardrail.RequestSnapshot["request"]["id"])
        .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
      if (snapshot === undefined || snapshot.fingerprint !== input.fingerprint) return stale
      const human = humanOnlyReason({
        kind: input.kind,
        action: snapshot.request.action,
        resources: snapshot.request.resources,
        metadata: snapshot.request.metadata,
        hardReview: snapshot.request.hardReview,
        ruleIDs: snapshot.request.ruleIDs,
      })
      if (human !== undefined) return { ...base, outcome: "escalated" as const, settled: false, reason: human }
      if (!routineEligible({ kind: input.kind, action: snapshot.request.action, resources: snapshot.request.resources }))
        return { ...base, outcome: "escalated" as const, settled: false, reason: "unknown-semantics" }
      const initial = yield* validate(input, snapshot.request.action, snapshot.request.resources)
      if (!initial.ok) return { ...base, outcome: "escalated" as const, settled: false, reason: initial.reason }
      const result = yield* deps.guardrail
        .reconsider({
          sessionID: input.targetSessionID,
          requestID: input.requestID as SessionGuardrail.RequestSnapshot["request"]["id"],
          fingerprint: input.fingerprint,
          actor: "coordinator",
          source,
          validate: (request) =>
            validate(input, request.action, request.resources).pipe(
              Effect.map(
                (checked) =>
                  checked.ok &&
                  routineEligible({ kind: input.kind, action: request.action, resources: request.resources }) &&
                  humanOnlyReason({
                    kind: input.kind,
                    action: request.action,
                    resources: request.resources,
                    metadata: request.metadata,
                    hardReview: request.hardReview,
                    ruleIDs: request.ruleIDs,
                  }) === undefined,
              ),
            ),
        })
        .pipe(
          Effect.catchTag("Session.NotFoundError", () =>
            Effect.succeed({ outcome: "stale" as const, requestID: input.requestID as never, fingerprint: input.fingerprint, settled: false }),
          ),
        )
      return { ...base, ...result }
    }

    const snapshot = yield* deps.form.snapshot(input.requestID as Form.ID)
    if (
      snapshot === undefined ||
      snapshot.form.sessionID !== input.targetSessionID ||
      snapshot.fingerprint !== input.fingerprint ||
      snapshot.state.status !== "pending"
    )
      return stale
    const formEvidence = {
      title: snapshot.form.title,
      fields: snapshot.form.fields.map((field) => ("title" in field ? (field.title ?? field.key) : field.key)),
      metadata: snapshot.form.metadata,
    }
    const human = humanOnlyReason({ kind: input.kind, action: "question", resources: [], metadata: formEvidence })
    if (human !== undefined) return { ...base, outcome: "escalated" as const, settled: false, reason: human }
    const initial = yield* validate(input, "question", [])
    if (!initial.ok) return { ...base, outcome: "escalated" as const, settled: false, reason: initial.reason }
    const result = yield* deps.form.reconsider({
      id: input.requestID as Form.ID,
      fingerprint: input.fingerprint,
      actor: "coordinator",
      source,
      ...(input.answer === undefined ? {} : { answer: input.answer }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      validate: (form) =>
        validate(input, "question", []).pipe(
          Effect.map(
            (checked) =>
              checked.ok &&
              humanOnlyReason({
                kind: input.kind,
                action: "question",
                resources: [],
                metadata: {
                  title: form.title,
                  fields: form.fields.map((field) => ("title" in field ? (field.title ?? field.key) : field.key)),
                  metadata: form.metadata,
                },
              }) === undefined,
          ),
        ),
    })
    return { ...base, ...result }
  })

  return { evaluate, pending }
}

export const layer = (deps: Dependencies) => Layer.succeed(Service, make(deps))
