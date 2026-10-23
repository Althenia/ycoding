export * as CoordinationService from "./index"

import { Coordination } from "@ycoding-ai/schema/coordination"
import { Money } from "@ycoding-ai/schema/money"
import type { Session } from "@ycoding-ai/schema/session"
import type { SessionMessage } from "@ycoding-ai/schema/session-message"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { AbsolutePath } from "../schema"
import { CoordinationDispatchSelection } from "./selection"
import { SessionReviewFold } from "../session/review-fold"
import { SessionMessageTable, SessionTable } from "../session/sql"
import {
  CoordinationClaimTable,
  CoordinationDispatchTable,
  CoordinationGroupTable,
  CoordinationMemberTable,
  CoordinationReceiptTable,
  CoordinationWaitTable,
} from "./sql"

export type Actor =
  | { readonly kind: "human" }
  | { readonly kind: "coordinator"; readonly sessionID: Session.ID }
  | { readonly kind: "system" }

export interface RuntimeCapacitySnapshot {
  readonly hardLimit?: number
  readonly usedExternal?: number
}

export interface LayerOptions {
  readonly capacity?: () => Effect.Effect<RuntimeCapacitySnapshot>
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Coordination.NotFoundError", {
  message: Schema.String,
}) {}
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Coordination.ConflictError", {
  message: Schema.String,
}) {}
export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("Coordination.InvalidInputError", {
  message: Schema.String,
}) {}
export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()("Coordination.ForbiddenError", {
  message: Schema.String,
}) {}
export class IneligibleSessionError extends Schema.TaggedErrorClass<IneligibleSessionError>()(
  "Coordination.IneligibleSessionError",
  { message: Schema.String },
) {}
export class CapacityError extends Schema.TaggedErrorClass<CapacityError>()("Coordination.CapacityError", {
  message: Schema.String,
}) {}
export class OutstandingError extends Schema.TaggedErrorClass<OutstandingError>()("Coordination.OutstandingError", {
  message: Schema.String,
}) {}

export type Error =
  | NotFoundError
  | ConflictError
  | InvalidInputError
  | ForbiddenError
  | IneligibleSessionError
  | CapacityError
  | OutstandingError
  | CoordinationDispatchSelection.InvalidSelectionError

export interface MutationInput {
  readonly groupID: Coordination.GroupID
  readonly expectedRevision: Coordination.Revision
}

export interface AdmissionSnapshot {
  readonly groupID: Coordination.GroupID
  readonly dispatchID: Coordination.DispatchID
  readonly targetSessionID: Session.ID
  readonly generation: number
  readonly messageID: SessionMessage.ID
  readonly allowedTools?: ReadonlyArray<string>
  readonly resourceScope?: string
}

export interface PreparedAdmission {
  readonly snapshot: AdmissionSnapshot
  readonly commit: (seq: number) => Effect.Effect<void>
}

export interface Interface {
  readonly create: (actor: Actor, input: Coordination.CreateInput) => Effect.Effect<Coordination.Info, Error>
  readonly list: (input: { readonly limit?: number }) => Effect.Effect<ReadonlyArray<Coordination.GroupSummary>, Error>
  readonly get: (groupID: Coordination.GroupID) => Effect.Effect<Coordination.Info, Error>
  readonly updateRoster: (
    actor: Actor,
    input: MutationInput & {
      readonly members: ReadonlyArray<Coordination.MemberInput>
      readonly policy?: Coordination.Policy
      readonly name?: string
    },
  ) => Effect.Effect<Coordination.Info, Error>
  readonly arm: (actor: Actor, input: MutationInput) => Effect.Effect<Coordination.Info, Error>
  readonly stop: (actor: Actor, input: MutationInput) => Effect.Effect<Coordination.Info, Error>
  readonly complete: (actor: Actor, input: MutationInput) => Effect.Effect<Coordination.Info, Error>
  readonly claim: (
    actor: Actor,
    input: MutationInput & { readonly targetSessionID: Session.ID; readonly leaseMs?: number },
  ) => Effect.Effect<Coordination.ClaimInfo, Error>
  readonly release: (
    actor: Actor,
    input: MutationInput & { readonly targetSessionID: Session.ID; readonly generation: number },
  ) => Effect.Effect<Coordination.ClaimInfo, Error>
  readonly claims: (input: {
    readonly groupID: Coordination.GroupID
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<Coordination.ClaimInfo>, Error>
  readonly dispatch: (
    actor: Actor,
    input: MutationInput & { readonly generation: number } & Coordination.DispatchInput,
  ) => Effect.Effect<Coordination.DispatchInfo, Error>
  readonly dispatches: (input: {
    readonly groupID: Coordination.GroupID
    readonly status?: Coordination.DispatchStatus
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<Coordination.DispatchInfo>, Error>
  readonly dispatchForInput: (input: {
    readonly messageID: SessionMessage.ID
  }) => Effect.Effect<Coordination.DispatchInfo | undefined, Error>
  readonly admittedFor: (input: {
    readonly targetSessionID: Session.ID
  }) => Effect.Effect<ReadonlyArray<Coordination.DispatchInfo>, Error>
  readonly prepareAdmission: (
    actor: Actor,
    input: {
      readonly groupID: Coordination.GroupID
      readonly dispatchID: Coordination.DispatchID
      readonly messageID: SessionMessage.ID
    },
  ) => Effect.Effect<PreparedAdmission, Error>
  readonly recordAdmission: (
    actor: Actor,
    input: {
      readonly groupID: Coordination.GroupID
      readonly dispatchID: Coordination.DispatchID
      readonly messageID: SessionMessage.ID
    },
  ) => Effect.Effect<Coordination.DispatchInfo, Error>
  readonly settleDispatch: (
    actor: Actor,
    input: {
      readonly groupID: Coordination.GroupID
      readonly dispatchID: Coordination.DispatchID
      readonly outcome: "completed" | "failed" | "cancelled"
      readonly detail?: string
    },
  ) => Effect.Effect<Coordination.DispatchInfo, Error>
  readonly advance: (actor: Actor, input: { readonly groupID: Coordination.GroupID }) => Effect.Effect<ReadonlyArray<Coordination.DispatchInfo>, Error>
  readonly wait: (actor: Actor, input: MutationInput & Coordination.WaitInput) => Effect.Effect<Coordination.WaitResult, Error>
  readonly cancelWait: (
    actor: Actor,
    input: MutationInput & { readonly waitID: Coordination.WaitID },
  ) => Effect.Effect<Coordination.WaitResult, Error>
  readonly receipts: (input: {
    readonly groupID: Coordination.GroupID
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<Coordination.Receipt>, Error>
  readonly capacity: (groupID: Coordination.GroupID) => Effect.Effect<Coordination.Capacity, Error>
  readonly roleFor: (sessionID: Session.ID) => Effect.Effect<Coordination.RoleAccess | undefined, Error>
  readonly standingRoles: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Coordination.RoleAccess>, Error>
  readonly accessForInput: (input: {
    readonly sessionID: Session.ID
    readonly messageID: SessionMessage.ID
  }) => Effect.Effect<Coordination.AssignmentAccess | undefined, Error>
  readonly recover: () => Effect.Effect<number, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Coordination") {}

type GroupRow = typeof CoordinationGroupTable.$inferSelect
type MemberRow = typeof CoordinationMemberTable.$inferSelect
type ClaimRow = typeof CoordinationClaimTable.$inferSelect
type DispatchRow = typeof CoordinationDispatchTable.$inferSelect
type WaitRow = typeof CoordinationWaitTable.$inferSelect

const WAIT_LIFETIME_MS = 3_600_000
const DEFAULT_LEASE_MS = 300_000

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const selections = yield* CoordinationDispatchSelection.Service
      const db = database.db
      const runtimeCapacity = options?.capacity ?? (() => Effect.succeed<RuntimeCapacitySnapshot>({}))

      const now = Clock.currentTimeMillis

      const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
        Schema.decodeUnknownEffect(schema as never, { onExcessProperty: "error" })(input).pipe(
          Effect.mapError((error) => new InvalidInputError({ message: String(error).slice(0, 500) })),
          Effect.map((value) => value as S["Type"]),
        )

      const limit = (value: number | undefined, fallback: number, max: number) =>
        Effect.gen(function* () {
          const resolved = value ?? fallback
          if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max)
            return yield* new InvalidInputError({ message: `Limit must be an integer from 1 to ${max}` })
          return resolved
        })

      const policyOf = (row: GroupRow): Coordination.Policy => ({
        concurrency: row.concurrency,
        queueCapacity: row.queue_capacity,
        ...(row.budget === null ? {} : { budget: Money.USD.make(row.budget) }),
        ...(row.delegated_decisions === null ? {} : { delegatedDecisions: row.delegated_decisions }),
      })

      const groupRow = Effect.fnUntraced(function* (groupID: Coordination.GroupID) {
        const row = yield* db
          .select()
          .from(CoordinationGroupTable)
          .where(eq(CoordinationGroupTable.id, groupID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ message: `Coordination group ${groupID} does not exist` })
        return row
      })

      const memberRows = (groupID: Coordination.GroupID) =>
        db
          .select()
          .from(CoordinationMemberTable)
          .where(eq(CoordinationMemberTable.group_id, groupID))
          .orderBy(asc(CoordinationMemberTable.session_id))
          .all()
          .pipe(Effect.orDie)

      const sessionRows = (ids: ReadonlyArray<Session.ID>) =>
        ids.length === 0
          ? Effect.succeed([])
          : db
              .select({
                id: SessionTable.id,
                parent_id: SessionTable.parent_id,
                time_archived: SessionTable.time_archived,
                directory: SessionTable.directory,
                workspace_id: SessionTable.workspace_id,
                cost: SessionTable.cost,
              })
              .from(SessionTable)
              .where(inArray(SessionTable.id, [...ids]))
              .all()
              .pipe(Effect.orDie)

      const activeWaitCount = (groupID: Coordination.GroupID) =>
        db
          .select({ count: sql<number>`count(*)` })
          .from(CoordinationWaitTable)
          .where(and(eq(CoordinationWaitTable.group_id, groupID), eq(CoordinationWaitTable.status, "active")))
          .get()
          .pipe(Effect.orDie, Effect.map((row) => row?.count ?? 0))

      const effectiveStatus = Effect.fnUntraced(function* (row: GroupRow) {
        if (row.status !== "armed") return row.status
        return (yield* activeWaitCount(row.id)) > 0 ? ("waiting" as const) : row.status
      })

      const infoOf = Effect.fnUntraced(function* (row: GroupRow) {
        const members = yield* memberRows(row.id)
        const sessions = new Map((yield* sessionRows(members.map((member) => member.session_id))).map((session) => [session.id, session]))
        return {
          id: row.id,
          name: row.name,
          status: yield* effectiveStatus(row),
          revision: Coordination.Revision.make(row.revision),
          policy: policyOf(row),
          fencingGeneration: row.fencing_generation,
          members: members.flatMap((member) => {
            const session = sessions.get(member.session_id)
            if (session === undefined) return []
            return [{
              sessionID: member.session_id,
              role: member.role,
              ...(member.allowed_tools === null ? {} : { allowedTools: member.allowed_tools }),
              ...(member.resource_scopes === null ? {} : { resourceScopes: member.resource_scopes }),
              location: {
                directory: AbsolutePath.make(session.directory),
                ...(session.workspace_id ? { workspaceID: session.workspace_id } : {}),
              },
            }]
          }),
          time: { created: row.time_created, updated: row.time_updated },
        } satisfies Coordination.Info
      })

      const claimInfo = (row: ClaimRow, at: number): Coordination.ClaimInfo => ({
        groupID: row.group_id,
        targetSessionID: row.target_session_id,
        holderSessionID: row.holder_session_id,
        generation: row.generation,
        status: row.status === "active" && row.lease_expires_at <= at ? "expired" : row.status,
        leaseExpiresAt: row.lease_expires_at,
      })

      const dispatchInfo = (row: DispatchRow): Coordination.DispatchInfo => ({
        id: row.id,
        groupID: row.group_id,
        targetSessionID: row.target_session_id,
        coordinatorSessionID: row.coordinator_session_id,
        generation: row.generation,
        status: row.status,
        ...(row.reason === null ? {} : { reason: row.reason }),
        text: row.text,
        selection: row.selection,
        ...(row.depends_on === null ? {} : { dependsOn: row.depends_on }),
        ...(row.resource_scope === null ? {} : { resourceScope: row.resource_scope }),
        ...(row.allowed_tools === null ? {} : { allowedTools: row.allowed_tools }),
        ...(row.message_id === null ? {} : { messageID: row.message_id }),
        time: { created: row.time_created, updated: row.time_updated },
      })

      const validateRoster = Effect.fnUntraced(function* (members: ReadonlyArray<Coordination.MemberInput>) {
        const ids = members.map((member) => member.sessionID)
        if (new Set(ids).size !== ids.length)
          return yield* new IneligibleSessionError({ message: "Coordination roster contains a duplicate Session" })
        if (!members.some((member) => member.role === "coordinator"))
          return yield* new InvalidInputError({ message: "Coordination roster requires at least one coordinator" })
        const sessions = new Map((yield* sessionRows(ids)).map((session) => [session.id, session]))
        for (const id of ids) {
          const session = sessions.get(id)
          if (!session) return yield* new IneligibleSessionError({ message: `Session ${id} does not exist` })
          if (session.parent_id !== null)
            return yield* new IneligibleSessionError({ message: `Session ${id} is a child Session, not a root` })
          if (session.time_archived !== null)
            return yield* new IneligibleSessionError({ message: `Session ${id} is archived` })
        }
      })

      const requireHuman = Effect.fnUntraced(function* (actor: Actor, action: string) {
        if (actor.kind !== "human")
          return yield* new ForbiddenError({ message: `Coordination ${action} requires a human actor` })
      })

      const requireRevision = Effect.fnUntraced(function* (row: GroupRow, expected: Coordination.Revision) {
        if (row.revision !== expected)
          return yield* new ConflictError({
            message: `Coordination group ${row.id} revision is ${row.revision}, expected ${expected}`,
          })
      })

      const coordinatorMember = Effect.fnUntraced(function* (actor: Actor, groupID: Coordination.GroupID) {
        if (actor.kind !== "coordinator")
          return yield* new ForbiddenError({ message: "Coordination action requires a coordinator Session actor" })
        const row = yield* db
          .select()
          .from(CoordinationMemberTable)
          .where(and(eq(CoordinationMemberTable.group_id, groupID), eq(CoordinationMemberTable.session_id, actor.sessionID)))
          .get()
          .pipe(Effect.orDie)
        if (!row || row.role !== "coordinator")
          return yield* new ForbiddenError({ message: `Session ${actor.sessionID} is not a coordinator of group ${groupID}` })
        return row
      })

      const updated = (groupID: Coordination.GroupID, revision: number) =>
        events
          .publish(Coordination.Event.Updated, { groupID, revision: Coordination.Revision.make(revision) })
          .pipe(Effect.asVoid)

      const insertMembers = (groupID: Coordination.GroupID, members: ReadonlyArray<Coordination.MemberInput>) =>
        db
          .insert(CoordinationMemberTable)
          .values(
            members.map((member) => ({
              group_id: groupID,
              session_id: member.sessionID,
              role: member.role,
              allowed_tools: member.allowedTools ?? null,
              resource_scopes: member.resourceScopes ?? null,
            })),
          )
          .run()
          .pipe(Effect.orDie)

      const bumpGroup = (row: GroupRow, at: number, patch?: Partial<GroupRow>) =>
        db
          .update(CoordinationGroupTable)
          .set({ ...patch, revision: row.revision + 1, time_updated: at })
          .where(eq(CoordinationGroupTable.id, row.id))
          .run()
          .pipe(Effect.orDie)

      const insertReceipt = (input: {
        groupID: Coordination.GroupID
        dispatchID?: Coordination.DispatchID
        kind: Coordination.Receipt["kind"]
        sessionID: Session.ID
        messageID?: SessionMessage.ID
        generation?: number
        detail?: string
        at: number
      }) =>
        db
          .insert(CoordinationReceiptTable)
          .values([
            {
              id: Coordination.ReceiptID.create(),
              group_id: input.groupID,
              dispatch_id: input.dispatchID ?? null,
              kind: input.kind,
              session_id: input.sessionID,
              message_id: input.messageID ?? null,
              generation: input.generation ?? null,
              detail: input.detail ?? null,
              time_created: input.at,
            },
          ])
          .run()
          .pipe(Effect.orDie)

      const counts = Effect.fnUntraced(function* (groupID: Coordination.GroupID) {
        const rows = yield* db
          .select({ status: CoordinationDispatchTable.status, count: sql<number>`count(*)` })
          .from(CoordinationDispatchTable)
          .where(eq(CoordinationDispatchTable.group_id, groupID))
          .groupBy(CoordinationDispatchTable.status)
          .all()
          .pipe(Effect.orDie)
        const byStatus = new Map(rows.map((row) => [row.status, row.count]))
        const global = yield* db
          .select({ count: sql<number>`count(*)` })
          .from(CoordinationDispatchTable)
          .where(inArray(CoordinationDispatchTable.status, ["pending", "admitted"]))
          .get()
          .pipe(Effect.orDie)
        return {
          active: (byStatus.get("pending") ?? 0) + (byStatus.get("admitted") ?? 0),
          queued: byStatus.get("queued") ?? 0,
          globalActive: global?.count ?? 0,
        }
      })

      const spentOf = Effect.fnUntraced(function* (groupID: Coordination.GroupID) {
        const members = yield* memberRows(groupID)
        const sessions = yield* sessionRows(members.map((member) => member.session_id))
        return sessions.reduce((total, session) => total + session.cost, 0)
      })

      const capacityOf = Effect.fnUntraced(function* (row: GroupRow) {
        const snapshot = yield* runtimeCapacity()
        const hardLimit =
          snapshot.hardLimit !== undefined && Number.isSafeInteger(snapshot.hardLimit) && snapshot.hardLimit > 0
            ? snapshot.hardLimit
            : undefined
        const current = yield* counts(row.id)
        const runtimeUsed = current.globalActive + Math.max(0, snapshot.usedExternal ?? 0)
        const policy = policyOf(row)
        const effective =
          policy.concurrency === null && hardLimit === undefined
            ? null
            : Math.min(policy.concurrency ?? Number.MAX_SAFE_INTEGER, hardLimit ?? Number.MAX_SAFE_INTEGER)
        const spent = yield* spentOf(row.id)
        const available =
          effective === null
            ? null
            : Math.max(
                0,
                Math.min(
                  policy.concurrency === null ? Number.MAX_SAFE_INTEGER : policy.concurrency - current.active,
                  hardLimit === undefined ? Number.MAX_SAFE_INTEGER : hardLimit - runtimeUsed,
                ),
              )
        return {
          capacity: {
            groupID: row.id,
            concurrency: policy.concurrency,
            hardLimit: hardLimit ?? null,
            effectiveLimit: effective,
            active: current.active,
            waiting: yield* activeWaitCount(row.id),
            queued: current.queued,
            queueCapacity: policy.queueCapacity,
            available,
            ...(hardLimit === undefined ? {} : { runtimeUsed }),
            ...(policy.budget === undefined
              ? {}
              : { budget: policy.budget, budgetRemaining: Money.USD.make(Math.max(0, policy.budget - spent)) }),
            spent: Money.USD.make(spent),
          } satisfies Coordination.Capacity,
          hardLimit,
          runtimeUsed,
          counts: current,
          spent,
        }
      })

      const depsComplete = Effect.fnUntraced(function* (dependsOn: ReadonlyArray<Coordination.DispatchID>) {
        if (dependsOn.length === 0) return true
        const rows = yield* db
          .select({ id: CoordinationDispatchTable.id, status: CoordinationDispatchTable.status })
          .from(CoordinationDispatchTable)
          .where(inArray(CoordinationDispatchTable.id, [...dependsOn]))
          .all()
          .pipe(Effect.orDie)
        return rows.length === dependsOn.length && rows.every((row) => row.status === "completed")
      })

      const placement = Effect.fnUntraced(function* (
        row: GroupRow,
        targetSessionID: Session.ID,
        dependsOn: ReadonlyArray<Coordination.DispatchID>,
      ) {
        const state = yield* capacityOf(row)
        const policy = policyOf(row)
        if (!(yield* depsComplete(dependsOn))) return { status: "queued" as const, reason: "dependency" as const, state }
        const targetActive = yield* db
          .select({ count: sql<number>`count(*)` })
          .from(CoordinationDispatchTable)
          .where(
            and(
              eq(CoordinationDispatchTable.target_session_id, targetSessionID),
              inArray(CoordinationDispatchTable.status, ["pending", "admitted"]),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if ((targetActive?.count ?? 0) > 0) return { status: "queued" as const, reason: "capacity" as const, state }
        if (policy.concurrency === null && state.hardLimit === undefined)
          return { status: "queued" as const, reason: "hard-limit" as const, state }
        if (state.hardLimit !== undefined && state.runtimeUsed + 1 > state.hardLimit)
          return { status: "queued" as const, reason: "hard-limit" as const, state }
        if (policy.concurrency !== null && state.counts.active + 1 > policy.concurrency)
          return { status: "queued" as const, reason: "capacity" as const, state }
        return { status: "pending" as const, reason: undefined, state }
      })

      const claimRow = (groupID: Coordination.GroupID, target: Session.ID) =>
        db
          .select()
          .from(CoordinationClaimTable)
          .where(and(eq(CoordinationClaimTable.group_id, groupID), eq(CoordinationClaimTable.target_session_id, target)))
          .get()
          .pipe(Effect.orDie)

      const admissionCommit = (input: {
        groupID: Coordination.GroupID
        dispatchID: Coordination.DispatchID
        messageID: SessionMessage.ID
        generation: number
        targetSessionID: Session.ID
      }) =>
        Effect.gen(function* () {
          const at = yield* now
          const group = yield* db
            .select({ status: CoordinationGroupTable.status })
            .from(CoordinationGroupTable)
            .where(eq(CoordinationGroupTable.id, input.groupID))
            .get()
            .pipe(Effect.orDie)
          const dispatch = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.id, input.dispatchID))
            .get()
            .pipe(Effect.orDie)
          const claim = yield* claimRow(input.groupID, input.targetSessionID)
          if (
            !group ||
            group.status !== "armed" ||
            !dispatch ||
            dispatch.group_id !== input.groupID ||
            dispatch.status !== "pending" ||
            dispatch.generation !== input.generation ||
            !claim ||
            claim.status !== "active" ||
            claim.lease_expires_at <= at ||
            claim.generation !== input.generation ||
            claim.holder_session_id !== dispatch.coordinator_session_id
          )
            return yield* new ConflictError({ message: `Coordination dispatch ${input.dispatchID} is no longer admissible` })
          yield* db
            .update(CoordinationDispatchTable)
            .set({ status: "admitted", reason: null, message_id: input.messageID, time_updated: at })
            .where(eq(CoordinationDispatchTable.id, input.dispatchID))
            .run()
            .pipe(Effect.orDie)
          yield* insertReceipt({
            groupID: input.groupID,
            dispatchID: input.dispatchID,
            kind: "admitted",
            sessionID: input.targetSessionID,
            messageID: input.messageID,
            generation: input.generation,
            at,
          })
        })

      const service: Interface = {
        create: Effect.fn("Coordination.create")(function* (actor, input) {
          yield* requireHuman(actor, "create")
          const decoded = yield* decode(Coordination.CreateInput, input)
          yield* validateRoster(decoded.members)
          const at = yield* now
          const groupID = Coordination.GroupID.create()
          yield* events.publish(
            Coordination.Event.Created,
            {
              groupID,
              revision: Coordination.Revision.make(0),
              name: decoded.name,
              policy: decoded.policy,
              members: decoded.members,
            },
            {
              commit: () =>
                Effect.gen(function* () {
                  yield* db
                    .insert(CoordinationGroupTable)
                    .values([
                      {
                        id: groupID,
                        name: decoded.name,
                        status: "disarmed",
                        revision: 0,
                        concurrency: decoded.policy.concurrency,
                        queue_capacity: decoded.policy.queueCapacity,
                        budget: decoded.policy.budget ?? null,
                        delegated_decisions: decoded.policy.delegatedDecisions ?? null,
                        fencing_generation: 0,
                        time_created: at,
                        time_updated: at,
                      },
                    ])
                    .run()
                    .pipe(Effect.orDie)
                  yield* insertMembers(groupID, decoded.members)
                }),
            },
          )
          yield* updated(groupID, 0)
          return yield* infoOf(yield* groupRow(groupID))
        }),

        list: Effect.fn("Coordination.list")(function* (input) {
          const size = yield* limit(input.limit, 100, 200)
          const rows = yield* db
            .select()
            .from(CoordinationGroupTable)
            .orderBy(desc(CoordinationGroupTable.time_updated), desc(CoordinationGroupTable.id))
            .limit(size)
            .all()
            .pipe(Effect.orDie)
          return yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              return {
                id: row.id,
                name: row.name,
                status: yield* effectiveStatus(row),
                revision: Coordination.Revision.make(row.revision),
                policy: policyOf(row),
                fencingGeneration: row.fencing_generation,
                memberCount: (yield* memberRows(row.id)).length,
                time: { created: row.time_created, updated: row.time_updated },
              } satisfies Coordination.GroupSummary
            }),
          )
        }),

        get: Effect.fn("Coordination.get")(function* (groupID) {
          return yield* infoOf(yield* groupRow(groupID))
        }),

        updateRoster: Effect.fn("Coordination.updateRoster")(function* (actor, input) {
          yield* requireHuman(actor, "roster update")
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          if (row.status === "completed")
            return yield* new ConflictError({ message: `Coordination group ${row.id} is completed` })
          const members = yield* decode(Schema.Array(Coordination.MemberInput), input.members)
          const policy = input.policy === undefined ? policyOf(row) : yield* decode(Coordination.Policy, input.policy)
          const name =
            input.name === undefined
              ? undefined
              : yield* decode(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)), input.name)
          yield* validateRoster(members)
          const current = yield* memberRows(row.id)
          const removed = current.filter((member) => !members.some((next) => next.sessionID === member.session_id))
          if (removed.length > 0) {
            const removedIDs = removed.map((member) => member.session_id)
            const at = yield* now
            const claims = yield* db
              .select()
              .from(CoordinationClaimTable)
              .where(eq(CoordinationClaimTable.group_id, row.id))
              .all()
              .pipe(Effect.orDie)
            if (
              claims.some(
                (claim) =>
                  claimInfo(claim, at).status === "active" &&
                  (removedIDs.includes(claim.target_session_id) || removedIDs.includes(claim.holder_session_id)),
              )
            )
              return yield* new OutstandingError({ message: "Coordination roster removal is blocked by an active claim" })
            const outstanding = yield* db
              .select({ id: CoordinationDispatchTable.id })
              .from(CoordinationDispatchTable)
              .where(
                and(
                  eq(CoordinationDispatchTable.group_id, row.id),
                  inArray(CoordinationDispatchTable.status, ["queued", "pending", "admitted"]),
                  inArray(CoordinationDispatchTable.target_session_id, removedIDs),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (outstanding)
              return yield* new OutstandingError({ message: "Coordination roster removal is blocked by outstanding dispatches" })
          }
          const at = yield* now
          yield* events.publish(
            Coordination.Event.RosterUpdated,
            {
              groupID: row.id,
              revision: Coordination.Revision.make(row.revision + 1),
              policy,
              members,
              ...(name === undefined ? {} : { name }),
            },
            {
              commit: () =>
                Effect.gen(function* () {
                  yield* db
                    .delete(CoordinationMemberTable)
                    .where(eq(CoordinationMemberTable.group_id, row.id))
                    .run()
                    .pipe(Effect.orDie)
                  yield* insertMembers(row.id, members)
                  yield* bumpGroup(row, at, {
                    ...(name === undefined ? {} : { name }),
                    concurrency: policy.concurrency,
                    queue_capacity: policy.queueCapacity,
                    budget: policy.budget ?? null,
                    delegated_decisions: policy.delegatedDecisions ?? null,
                  })
                }),
            },
          )
          yield* updated(row.id, row.revision + 1)
          return yield* infoOf(yield* groupRow(row.id))
        }),

        arm: Effect.fn("Coordination.arm")(function* (actor, input) {
          yield* requireHuman(actor, "arm")
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          if (row.status !== "disarmed" && row.status !== "needs-rearm" && row.status !== "stopped")
            return yield* new ConflictError({ message: `Coordination group ${row.id} cannot arm from ${row.status}` })
          const at = yield* now
          yield* events.publish(
            Coordination.Event.Armed,
            { groupID: row.id, revision: Coordination.Revision.make(row.revision + 1) },
            { commit: () => bumpGroup(row, at, { status: "armed" }) },
          )
          yield* updated(row.id, row.revision + 1)
          return yield* infoOf(yield* groupRow(row.id))
        }),

        stop: Effect.fn("Coordination.stop")(function* (actor, input) {
          yield* requireHuman(actor, "stop")
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          if (row.status === "completed" || row.status === "stopped")
            return yield* new ConflictError({ message: `Coordination group ${row.id} cannot stop from ${row.status}` })
          const at = yield* now
          yield* events.publish(
            Coordination.Event.Stopped,
            { groupID: row.id, revision: Coordination.Revision.make(row.revision + 1) },
            {
              commit: () =>
                Effect.gen(function* () {
                  const queued = yield* db
                    .select()
                    .from(CoordinationDispatchTable)
                    .where(
                      and(
                        eq(CoordinationDispatchTable.group_id, row.id),
                        inArray(CoordinationDispatchTable.status, ["queued", "pending"]),
                      ),
                    )
                    .all()
                    .pipe(Effect.orDie)
                  for (const dispatch of queued) {
                    yield* insertReceipt({
                      groupID: row.id,
                      dispatchID: dispatch.id,
                      kind: "cancelled",
                      sessionID: dispatch.target_session_id,
                      generation: dispatch.generation,
                      at,
                    })
                  }
                  yield* db
                    .update(CoordinationDispatchTable)
                    .set({ status: "cancelled", reason: null, time_updated: at })
                    .where(
                      and(
                        eq(CoordinationDispatchTable.group_id, row.id),
                        inArray(CoordinationDispatchTable.status, ["queued", "pending"]),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie)
                  yield* db
                    .update(CoordinationClaimTable)
                    .set({ status: "released", time_updated: at })
                    .where(and(eq(CoordinationClaimTable.group_id, row.id), eq(CoordinationClaimTable.status, "active")))
                    .run()
                    .pipe(Effect.orDie)
                  yield* db
                    .update(CoordinationWaitTable)
                    .set({ status: "cancelled", time_updated: at })
                    .where(and(eq(CoordinationWaitTable.group_id, row.id), eq(CoordinationWaitTable.status, "active")))
                    .run()
                    .pipe(Effect.orDie)
                  yield* bumpGroup(row, at, { status: "stopped" })
                }),
            },
          )
          yield* updated(row.id, row.revision + 1)
          return yield* infoOf(yield* groupRow(row.id))
        }),

        complete: Effect.fn("Coordination.complete")(function* (actor, input) {
          yield* requireHuman(actor, "complete")
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          if (row.status === "completed")
            return yield* new ConflictError({ message: `Coordination group ${row.id} is already completed` })
          const at = yield* now
          const state = yield* counts(row.id)
          if (state.active + state.queued > 0)
            return yield* new OutstandingError({ message: "Coordination group has outstanding dispatches" })
          if ((yield* activeWaitCount(row.id)) > 0)
            return yield* new OutstandingError({ message: "Coordination group has active waits" })
          const claims = yield* db
            .select()
            .from(CoordinationClaimTable)
            .where(eq(CoordinationClaimTable.group_id, row.id))
            .all()
            .pipe(Effect.orDie)
          if (claims.some((claim) => claimInfo(claim, at).status === "active"))
            return yield* new OutstandingError({ message: "Coordination group has active claims" })
          const members = yield* memberRows(row.id)
          for (const member of members) {
            if ((yield* SessionReviewFold.openCount(db, member.session_id)) > 0)
              return yield* new OutstandingError({ message: `Session ${member.session_id} has open review items` })
          }
          yield* events.publish(
            Coordination.Event.Completed,
            { groupID: row.id, revision: Coordination.Revision.make(row.revision + 1) },
            { commit: () => bumpGroup(row, at, { status: "completed" }) },
          )
          yield* updated(row.id, row.revision + 1)
          return yield* infoOf(yield* groupRow(row.id))
        }),

        claim: Effect.fn("Coordination.claim")(function* (actor, input) {
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          yield* coordinatorMember(actor, row.id)
          if (actor.kind !== "coordinator")
            return yield* new ForbiddenError({ message: "Coordination claim requires a coordinator Session actor" })
          if (row.status !== "armed")
            return yield* new ConflictError({ message: `Coordination group ${row.id} is not armed` })
          const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
          if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > WAIT_LIFETIME_MS)
            return yield* new InvalidInputError({ message: "Coordination lease must be from 1000 to 3600000 milliseconds" })
          const members = yield* memberRows(row.id)
          const target = members.find((member) => member.session_id === input.targetSessionID)
          if (!target || target.role !== "worker")
            return yield* new IneligibleSessionError({
              message: `Session ${input.targetSessionID} is not a worker in group ${row.id}`,
            })
          const at = yield* now
          const competing = yield* db
            .select()
            .from(CoordinationClaimTable)
            .where(
              and(
                eq(CoordinationClaimTable.target_session_id, input.targetSessionID),
                eq(CoordinationClaimTable.status, "active"),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          if (
            competing.some(
              (claim) => claim.lease_expires_at > at && !(claim.group_id === row.id && claim.holder_session_id === actor.sessionID),
            )
          )
            return yield* new ConflictError({ message: `Session ${input.targetSessionID} already has an active writer claim` })
          const existing = yield* claimRow(row.id, input.targetSessionID)
          const renew =
            existing?.status === "active" && existing.lease_expires_at > at && existing.holder_session_id === actor.sessionID
          const generation = renew ? existing.generation : (existing?.generation ?? 0) + 1
          const leaseExpiresAt = at + leaseMs
          yield* events.publish(
            Coordination.Event.ClaimAcquired,
            {
              groupID: row.id,
              revision: Coordination.Revision.make(row.revision + 1),
              targetSessionID: input.targetSessionID,
              holderSessionID: actor.sessionID,
              generation,
              leaseExpiresAt,
            },
            {
              commit: () =>
                Effect.gen(function* () {
                  if (existing) {
                    yield* db
                      .update(CoordinationClaimTable)
                      .set({
                        holder_session_id: actor.sessionID,
                        generation,
                        status: "active",
                        lease_expires_at: leaseExpiresAt,
                        time_updated: at,
                      })
                      .where(
                        and(
                          eq(CoordinationClaimTable.group_id, row.id),
                          eq(CoordinationClaimTable.target_session_id, input.targetSessionID),
                        ),
                      )
                      .run()
                      .pipe(Effect.orDie)
                  } else {
                    yield* db
                      .insert(CoordinationClaimTable)
                      .values([
                        {
                          group_id: row.id,
                          target_session_id: input.targetSessionID,
                          holder_session_id: actor.sessionID,
                          generation,
                          status: "active",
                          lease_expires_at: leaseExpiresAt,
                          time_created: at,
                          time_updated: at,
                        },
                      ])
                      .run()
                      .pipe(Effect.orDie)
                  }
                  yield* bumpGroup(row, at, { fencing_generation: Math.max(row.fencing_generation, generation) })
                }),
            },
          )
          yield* updated(row.id, row.revision + 1)
          const stored = yield* claimRow(row.id, input.targetSessionID)
          return claimInfo(stored!, at)
        }),

        release: Effect.fn("Coordination.release")(function* (actor, input) {
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          if (actor.kind === "coordinator") yield* coordinatorMember(actor, row.id)
          if (actor.kind !== "human" && actor.kind !== "coordinator")
            return yield* new ForbiddenError({ message: "Coordination release requires a human or coordinator actor" })
          const existing = yield* claimRow(row.id, input.targetSessionID)
          if (!existing) return yield* new NotFoundError({ message: `No coordination claim for Session ${input.targetSessionID}` })
          if (existing.generation !== input.generation)
            return yield* new ConflictError({ message: "Coordination claim generation does not match the live claim" })
          if (actor.kind === "coordinator" && existing.holder_session_id !== actor.sessionID)
            return yield* new ForbiddenError({ message: "Only the claim holder or a human can release a coordination claim" })
          const at = yield* now
          const revoke = actor.kind === "human" && existing.status === "active"
          const status = revoke ? "revoked" : "released"
          yield* events.publish(
            revoke ? Coordination.Event.ClaimRevoked : Coordination.Event.ClaimReleased,
            {
              groupID: row.id,
              revision: Coordination.Revision.make(row.revision + 1),
              targetSessionID: input.targetSessionID,
              generation: input.generation,
            },
            {
              commit: () =>
                Effect.gen(function* () {
                  yield* db
                    .update(CoordinationClaimTable)
                    .set({ status, time_updated: at })
                    .where(
                      and(
                        eq(CoordinationClaimTable.group_id, row.id),
                        eq(CoordinationClaimTable.target_session_id, input.targetSessionID),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie)
                  yield* bumpGroup(row, at)
                }),
            },
          )
          yield* updated(row.id, row.revision + 1)
          const stored = yield* claimRow(row.id, input.targetSessionID)
          return claimInfo(stored!, at)
        }),

        claims: Effect.fn("Coordination.claims")(function* (input) {
          yield* groupRow(input.groupID)
          const size = yield* limit(input.limit, 100, 500)
          const at = yield* now
          const rows = yield* db
            .select()
            .from(CoordinationClaimTable)
            .where(eq(CoordinationClaimTable.group_id, input.groupID))
            .orderBy(asc(CoordinationClaimTable.target_session_id))
            .limit(size)
            .all()
            .pipe(Effect.orDie)
          return rows.map((row) => claimInfo(row, at))
        }),

        dispatch: Effect.fn("Coordination.dispatch")(function* (actor, input) {
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          yield* coordinatorMember(actor, row.id)
          if (actor.kind !== "coordinator")
            return yield* new ForbiddenError({ message: "Coordination dispatch requires a coordinator Session actor" })
          if (row.status !== "armed")
            return yield* new ConflictError({ message: `Coordination group ${row.id} is not armed` })
          const decoded = yield* decode(Coordination.DispatchInput, {
            ...(input.dispatchID === undefined ? {} : { dispatchID: input.dispatchID }),
            targetSessionID: input.targetSessionID,
            text: input.text,
            selection: input.selection,
            ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
            ...(input.resourceScope === undefined ? {} : { resourceScope: input.resourceScope }),
            ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          })
          const members = yield* memberRows(row.id)
          const target = members.find((member) => member.session_id === decoded.targetSessionID)
          if (!target || target.role !== "worker")
            return yield* new IneligibleSessionError({
              message: `Session ${decoded.targetSessionID} is not a worker in group ${row.id}`,
            })
          const at = yield* now
          const claim = yield* claimRow(row.id, decoded.targetSessionID)
          if (
            !claim ||
            claim.status !== "active" ||
            claim.lease_expires_at <= at ||
            claim.holder_session_id !== actor.sessionID ||
            claim.generation !== input.generation
          )
            return yield* new ConflictError({ message: "Coordination dispatch requires the live claim generation for the target" })
          const dispatchID = decoded.dispatchID ?? Coordination.DispatchID.create()
          const duplicate = yield* db
            .select({ id: CoordinationDispatchTable.id })
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.id, dispatchID))
            .get()
            .pipe(Effect.orDie)
          if (duplicate) return yield* new ConflictError({ message: `Coordination dispatch ${dispatchID} already exists` })
          yield* selections.validate(decoded.targetSessionID, decoded.selection)
          const dependsOn = decoded.dependsOn ?? []
          if (dependsOn.length > 0) {
            const found = yield* db
              .select({ id: CoordinationDispatchTable.id, group_id: CoordinationDispatchTable.group_id })
              .from(CoordinationDispatchTable)
              .where(inArray(CoordinationDispatchTable.id, [...dependsOn]))
              .all()
              .pipe(Effect.orDie)
            if (found.length !== dependsOn.length || found.some((foundRow) => foundRow.group_id !== row.id))
              return yield* new InvalidInputError({ message: "Coordination dispatch dependencies must exist in the same group" })
          }
          const state = yield* capacityOf(row)
          const policy = policyOf(row)
          if (policy.budget !== undefined && state.spent >= policy.budget)
            return yield* new CapacityError({ message: "Coordination group budget has been reached" })
          if (state.counts.active + state.counts.queued >= policy.queueCapacity)
            return yield* new CapacityError({ message: "Coordination group queue capacity has been reached" })
          const placed = yield* placement(row, decoded.targetSessionID, dependsOn)
          yield* events.publish(
            Coordination.Event.DispatchRecorded,
            {
              groupID: row.id,
              revision: Coordination.Revision.make(row.revision + 1),
              dispatchID,
              targetSessionID: decoded.targetSessionID,
              coordinatorSessionID: actor.sessionID,
              generation: input.generation,
              status: placed.status,
              ...(placed.reason === undefined ? {} : { reason: placed.reason }),
              text: decoded.text,
              selection: decoded.selection,
              ...(dependsOn.length === 0 ? {} : { dependsOn }),
              ...(decoded.resourceScope === undefined ? {} : { resourceScope: decoded.resourceScope }),
              ...(decoded.allowedTools === undefined ? {} : { allowedTools: decoded.allowedTools }),
            },
            {
              commit: () =>
                Effect.gen(function* () {
                  yield* db
                    .insert(CoordinationDispatchTable)
                    .values([
                      {
                        id: dispatchID,
                        group_id: row.id,
                        target_session_id: decoded.targetSessionID,
                        coordinator_session_id: actor.sessionID,
                        generation: input.generation,
                        status: placed.status,
                        reason: placed.reason ?? null,
                        text: decoded.text,
                        selection: decoded.selection,
                        depends_on: dependsOn.length === 0 ? null : dependsOn,
                        resource_scope: decoded.resourceScope ?? null,
                        allowed_tools: decoded.allowedTools ?? null,
                        message_id: null,
                        time_created: at,
                        time_updated: at,
                      },
                    ])
                    .run()
                    .pipe(Effect.orDie)
                  yield* insertReceipt({
                    groupID: row.id,
                    dispatchID,
                    kind: "dispatched",
                    sessionID: decoded.targetSessionID,
                    generation: input.generation,
                    at,
                  })
                  yield* bumpGroup(row, at)
                }),
            },
          )
          yield* updated(row.id, row.revision + 1)
          const stored = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.id, dispatchID))
            .get()
            .pipe(Effect.orDie)
          return dispatchInfo(stored!)
        }),

        dispatches: Effect.fn("Coordination.dispatches")(function* (input) {
          yield* groupRow(input.groupID)
          const size = yield* limit(input.limit, 100, 500)
          const rows = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(
              and(
                eq(CoordinationDispatchTable.group_id, input.groupID),
                input.status === undefined ? undefined : eq(CoordinationDispatchTable.status, input.status),
              ),
            )
            .orderBy(asc(CoordinationDispatchTable.time_created), asc(CoordinationDispatchTable.id))
            .limit(size)
            .all()
            .pipe(Effect.orDie)
          return rows.map(dispatchInfo)
        }),

        dispatchForInput: Effect.fn("Coordination.dispatchForInput")(function* (input) {
          const row = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.message_id, input.messageID))
            .get()
            .pipe(Effect.orDie)
          return row ? dispatchInfo(row) : undefined
        }),

        admittedFor: Effect.fn("Coordination.admittedFor")(function* (input) {
          const rows = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(
              and(
                eq(CoordinationDispatchTable.target_session_id, input.targetSessionID),
                eq(CoordinationDispatchTable.status, "admitted"),
              ),
            )
            .orderBy(asc(CoordinationDispatchTable.time_created), asc(CoordinationDispatchTable.id))
            .all()
            .pipe(Effect.orDie)
          return rows.map(dispatchInfo)
        }),

        prepareAdmission: Effect.fn("Coordination.prepareAdmission")(function* (actor, input) {
          if (actor.kind !== "system")
            return yield* new ForbiddenError({ message: "Coordination admission preparation requires the system actor" })
          const row = yield* groupRow(input.groupID)
          const dispatch = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.id, input.dispatchID))
            .get()
            .pipe(Effect.orDie)
          if (!dispatch || dispatch.group_id !== row.id)
            return yield* new NotFoundError({ message: `Coordination dispatch ${input.dispatchID} does not exist in group ${row.id}` })
          const at = yield* now
          const claim = yield* claimRow(row.id, dispatch.target_session_id)
          if (
            row.status !== "armed" ||
            dispatch.status !== "pending" ||
            !claim ||
            claim.status !== "active" ||
            claim.lease_expires_at <= at ||
            claim.generation !== dispatch.generation ||
            claim.holder_session_id !== dispatch.coordinator_session_id
          )
            return yield* new ConflictError({ message: `Coordination dispatch ${input.dispatchID} is not admissible` })
          yield* selections.validate(dispatch.target_session_id, dispatch.selection)
          const member = (yield* memberRows(row.id)).find((entry) => entry.session_id === dispatch.target_session_id)
          const snapshot: AdmissionSnapshot = {
            groupID: row.id,
            dispatchID: dispatch.id,
            targetSessionID: dispatch.target_session_id,
            generation: dispatch.generation,
            messageID: input.messageID,
            ...((dispatch.allowed_tools ?? member?.allowed_tools)
              ? { allowedTools: dispatch.allowed_tools ?? member!.allowed_tools! }
              : {}),
            ...(dispatch.resource_scope === null ? {} : { resourceScope: dispatch.resource_scope }),
          }
          return {
            snapshot,
            commit: () =>
              admissionCommit({
                groupID: row.id,
                dispatchID: dispatch.id,
                messageID: input.messageID,
                generation: dispatch.generation,
                targetSessionID: dispatch.target_session_id,
              }).pipe(Effect.orDie),
          }
        }),

        recordAdmission: Effect.fn("Coordination.recordAdmission")(function* (actor, input) {
          const prepared = yield* service.prepareAdmission(actor, input)
          yield* db.transaction(() => prepared.commit(0)).pipe(Effect.orDie)
          const row = yield* groupRow(input.groupID)
          yield* updated(row.id, row.revision)
          const stored = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.id, input.dispatchID))
            .get()
            .pipe(Effect.orDie)
          return dispatchInfo(stored!)
        }),

        settleDispatch: Effect.fn("Coordination.settleDispatch")(function* (actor, input) {
          if (actor.kind !== "system")
            return yield* new ForbiddenError({ message: "Coordination dispatch settlement requires the system actor" })
          const row = yield* groupRow(input.groupID)
          const dispatch = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.id, input.dispatchID))
            .get()
            .pipe(Effect.orDie)
          if (!dispatch || dispatch.group_id !== row.id)
            return yield* new NotFoundError({ message: `Coordination dispatch ${input.dispatchID} does not exist in group ${row.id}` })
          const valid =
            input.outcome === "completed"
              ? dispatch.status === "admitted"
              : input.outcome === "failed"
                ? dispatch.status === "pending" || dispatch.status === "admitted"
                : dispatch.status === "queued" || dispatch.status === "pending"
          if (!valid)
            return yield* new ConflictError({
              message: `Coordination dispatch ${dispatch.id} cannot settle as ${input.outcome} from ${dispatch.status}`,
            })
          if (input.detail !== undefined && input.detail.length > 500)
            return yield* new InvalidInputError({ message: "Coordination settlement detail exceeds 500 characters" })
          const at = yield* now
          yield* events.publish(
            Coordination.Event.DispatchSettled,
            {
              groupID: row.id,
              revision: Coordination.Revision.make(row.revision + 1),
              dispatchID: dispatch.id,
              outcome: input.outcome,
              ...(input.detail === undefined ? {} : { detail: input.detail }),
            },
            {
              commit: () =>
                Effect.gen(function* () {
                  yield* db
                    .update(CoordinationDispatchTable)
                    .set({ status: input.outcome, reason: null, time_updated: at })
                    .where(eq(CoordinationDispatchTable.id, dispatch.id))
                    .run()
                    .pipe(Effect.orDie)
                  yield* insertReceipt({
                    groupID: row.id,
                    dispatchID: dispatch.id,
                    kind: input.outcome,
                    sessionID: dispatch.target_session_id,
                    ...(dispatch.message_id === null ? {} : { messageID: dispatch.message_id }),
                    generation: dispatch.generation,
                    ...(input.detail === undefined ? {} : { detail: input.detail }),
                    at,
                  })
                  yield* bumpGroup(row, at)
                }),
            },
          )
          yield* updated(row.id, row.revision + 1)
          const stored = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.id, dispatch.id))
            .get()
            .pipe(Effect.orDie)
          return dispatchInfo(stored!)
        }),

        advance: Effect.fn("Coordination.advance")(function* (actor, input) {
          if (actor.kind !== "system")
            return yield* new ForbiddenError({ message: "Coordination advance requires the system actor" })
          yield* groupRow(input.groupID)
          const promoted: Coordination.DispatchInfo[] = []
          while (true) {
            const row = yield* groupRow(input.groupID)
            if (row.status !== "armed") return promoted
            const queued = yield* db
              .select()
              .from(CoordinationDispatchTable)
              .where(and(eq(CoordinationDispatchTable.group_id, row.id), eq(CoordinationDispatchTable.status, "queued")))
              .orderBy(asc(CoordinationDispatchTable.time_created), asc(CoordinationDispatchTable.id))
              .all()
              .pipe(Effect.orDie)
            const policy = policyOf(row)
            const state = yield* capacityOf(row)
            if (policy.budget !== undefined && state.spent >= policy.budget) return promoted
            let advanced = false
            for (const candidate of queued) {
              const placed = yield* placement(row, candidate.target_session_id, candidate.depends_on ?? [])
              if (placed.status !== "pending") {
                if (candidate.reason !== placed.reason) {
                  yield* db
                    .update(CoordinationDispatchTable)
                    .set({ reason: placed.reason ?? null, time_updated: yield* now })
                    .where(eq(CoordinationDispatchTable.id, candidate.id))
                    .run()
                    .pipe(Effect.orDie)
                }
                continue
              }
              const at = yield* now
              yield* events.publish(
                Coordination.Event.DispatchAdvanced,
                { groupID: row.id, revision: Coordination.Revision.make(row.revision + 1), dispatchID: candidate.id },
                {
                  commit: () =>
                    Effect.gen(function* () {
                      yield* db
                        .update(CoordinationDispatchTable)
                        .set({ status: "pending", reason: null, time_updated: at })
                        .where(eq(CoordinationDispatchTable.id, candidate.id))
                        .run()
                        .pipe(Effect.orDie)
                      yield* bumpGroup(row, at)
                    }),
                },
              )
              yield* updated(row.id, row.revision + 1)
              promoted.push(dispatchInfo({ ...candidate, status: "pending", reason: null, time_updated: at }))
              advanced = true
              break
            }
            if (!advanced) return promoted
          }
        }),

        wait: Effect.fn("Coordination.wait")(function* (actor, input) {
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          yield* coordinatorMember(actor, row.id)
          if (actor.kind !== "coordinator")
            return yield* new ForbiddenError({ message: "Coordination wait requires a coordinator Session actor" })
          if (row.status !== "armed")
            return yield* new ConflictError({ message: `Coordination group ${row.id} is not armed` })
          const decoded = yield* decode(Coordination.WaitInput, {
            ...(input.waitID === undefined ? {} : { waitID: input.waitID }),
            ...(input.targets === undefined ? {} : { targets: input.targets }),
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            ...(input.batch === undefined ? {} : { batch: input.batch }),
          })
          const at = yield* now
          const existing =
            decoded.waitID === undefined
              ? undefined
              : yield* db
                  .select()
                  .from(CoordinationWaitTable)
                  .where(eq(CoordinationWaitTable.id, decoded.waitID))
                  .get()
                  .pipe(Effect.orDie)
          if (existing && existing.group_id !== row.id)
            return yield* new ConflictError({ message: `Coordination wait ${existing.id} belongs to another group` })
          if (existing && existing.status !== "active")
            return yield* new ConflictError({ message: `Coordination wait ${existing.id} is ${existing.status}` })
          if (existing && existing.coordinator_session_id !== actor.sessionID)
            return yield* new ForbiddenError({ message: "Coordination wait belongs to another coordinator" })

          let waitRow: WaitRow
          if (existing) {
            waitRow = existing
          } else {
            const members = yield* memberRows(row.id)
            const workers = members.filter((member) => member.role === "worker").map((member) => member.session_id)
            const targets = decoded.targets ?? workers
            if (targets.length === 0 || targets.some((target) => !workers.includes(target)))
              return yield* new IneligibleSessionError({ message: "Coordination wait targets must be workers in the group" })
            const waitID = decoded.waitID ?? Coordination.WaitID.create()
            const expiresAt = at + WAIT_LIFETIME_MS
            yield* events.publish(
              Coordination.Event.WaitStarted,
              {
                groupID: row.id,
                revision: Coordination.Revision.make(row.revision + 1),
                waitID,
                coordinatorSessionID: actor.sessionID,
                targets,
                expiresAt,
              },
              {
                commit: () =>
                  Effect.gen(function* () {
                    yield* db
                      .insert(CoordinationWaitTable)
                      .values([
                        {
                          id: waitID,
                          group_id: row.id,
                          coordinator_session_id: actor.sessionID,
                          status: "active",
                          targets,
                          cursors: {},
                          expires_at: expiresAt,
                          time_created: at,
                          time_updated: at,
                        },
                      ])
                      .run()
                      .pipe(Effect.orDie)
                    yield* bumpGroup(row, at)
                  }),
              },
            )
            yield* updated(row.id, row.revision + 1)
            waitRow = (yield* db
              .select()
              .from(CoordinationWaitTable)
              .where(eq(CoordinationWaitTable.id, waitID))
              .get()
              .pipe(Effect.orDie))!
          }

          if (waitRow.expires_at <= at) {
            const fresh = yield* groupRow(row.id)
            yield* events.publish(
              Coordination.Event.WaitExpired,
              { groupID: row.id, revision: Coordination.Revision.make(fresh.revision + 1), waitID: waitRow.id },
              {
                commit: () =>
                  Effect.gen(function* () {
                    yield* db
                      .update(CoordinationWaitTable)
                      .set({ status: "expired", time_updated: at })
                      .where(eq(CoordinationWaitTable.id, waitRow.id))
                      .run()
                      .pipe(Effect.orDie)
                    yield* bumpGroup(fresh, at)
                  }),
              },
            )
            yield* updated(row.id, fresh.revision + 1)
            return {
              waitID: waitRow.id,
              groupID: row.id,
              status: "expired",
              observations: [],
              cursors: waitRow.cursors,
            } satisfies Coordination.WaitResult
          }

          const batch = decoded.batch ?? 50
          const collect = Effect.fnUntraced(function* () {
            const observations: Coordination.Observation[] = []
            const cursors: Record<string, number> = { ...waitRow.cursors }
            for (const target of waitRow.targets) {
              const cursor = cursors[target] ?? -1
              const items = yield* events.log({ aggregateID: target, after: cursor, follow: false }).pipe(Stream.runCollect)
              const synced = items.find((item) => EventRuntime.isSynced(item))
              const syncedSeq = synced && EventRuntime.isSynced(synced) && synced.seq !== undefined ? synced.seq : -1
              const payloads = items.filter((item): item is EventRuntime.Payload => !EventRuntime.isSynced(item))
              if (cursor > syncedSeq) {
                observations.push({
                  sessionID: target,
                  seq: Math.max(syncedSeq, 0),
                  type: "coordination.gap",
                  time: at,
                  gap: true,
                })
                cursors[target] = syncedSeq
                continue
              }
              const remaining = batch - observations.length
              const taken = payloads.slice(0, Math.max(remaining, 0))
              for (const payload of taken) {
                observations.push({
                  sessionID: target,
                  eventID: payload.id,
                  seq: payload.durable?.seq ?? cursor,
                  type: payload.type,
                  time: DateTime.toEpochMillis(payload.created),
                })
              }
              cursors[target] =
                taken.length < payloads.length ? taken.at(-1)?.durable?.seq ?? cursor : Math.max(syncedSeq, cursor)
              if (observations.length >= batch) break
            }
            observations.sort((left, right) => left.time - right.time || left.seq - right.seq)
            return { observations, cursors }
          })

          let result = yield* collect()
          const timeoutMs = decoded.timeoutMs ?? 0
          if (result.observations.length === 0 && timeoutMs > 0) {
            yield* Effect.scoped(
              Effect.race(
                events
                  .subscribe()
                  .pipe(
                    Stream.filter(
                      (event) => event.durable !== undefined && waitRow.targets.includes(event.durable.aggregateID as Session.ID),
                    ),
                    Stream.runHead,
                  ),
                Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.as(Option.none())),
              ),
            )
            result = yield* collect()
          }
          yield* db
            .update(CoordinationWaitTable)
            .set({ cursors: result.cursors, time_updated: yield* now })
            .where(eq(CoordinationWaitTable.id, waitRow.id))
            .run()
            .pipe(Effect.orDie)
          return {
            waitID: waitRow.id,
            groupID: row.id,
            status: "active",
            observations: result.observations,
            cursors: result.cursors,
          } satisfies Coordination.WaitResult
        }),

        cancelWait: Effect.fn("Coordination.cancelWait")(function* (actor, input) {
          const row = yield* groupRow(input.groupID)
          yield* requireRevision(row, input.expectedRevision)
          if (actor.kind === "coordinator") yield* coordinatorMember(actor, row.id)
          if (actor.kind !== "human" && actor.kind !== "coordinator")
            return yield* new ForbiddenError({ message: "Coordination wait cancellation requires a human or coordinator actor" })
          const waitRow = yield* db
            .select()
            .from(CoordinationWaitTable)
            .where(eq(CoordinationWaitTable.id, input.waitID))
            .get()
            .pipe(Effect.orDie)
          if (!waitRow || waitRow.group_id !== row.id)
            return yield* new NotFoundError({ message: `Coordination wait ${input.waitID} does not exist in group ${row.id}` })
          if (waitRow.status !== "active")
            return yield* new ConflictError({ message: `Coordination wait ${waitRow.id} is ${waitRow.status}` })
          if (actor.kind === "coordinator" && waitRow.coordinator_session_id !== actor.sessionID)
            return yield* new ForbiddenError({ message: "Coordination wait belongs to another coordinator" })
          const at = yield* now
          yield* events.publish(
            Coordination.Event.WaitCancelled,
            { groupID: row.id, revision: Coordination.Revision.make(row.revision + 1), waitID: waitRow.id },
            {
              commit: () =>
                Effect.gen(function* () {
                  yield* db
                    .update(CoordinationWaitTable)
                    .set({ status: "cancelled", time_updated: at })
                    .where(eq(CoordinationWaitTable.id, waitRow.id))
                    .run()
                    .pipe(Effect.orDie)
                  yield* bumpGroup(row, at)
                }),
            },
          )
          yield* updated(row.id, row.revision + 1)
          return {
            waitID: waitRow.id,
            groupID: row.id,
            status: "cancelled",
            observations: [],
            cursors: waitRow.cursors,
          } satisfies Coordination.WaitResult
        }),

        receipts: Effect.fn("Coordination.receipts")(function* (input) {
          yield* groupRow(input.groupID)
          const size = yield* limit(input.limit, 100, 500)
          const rows = yield* db
            .select({ receipt: CoordinationReceiptTable, selection: CoordinationDispatchTable.selection })
            .from(CoordinationReceiptTable)
            .innerJoin(CoordinationDispatchTable, eq(CoordinationReceiptTable.dispatch_id, CoordinationDispatchTable.id))
            .where(eq(CoordinationReceiptTable.group_id, input.groupID))
            .orderBy(asc(CoordinationReceiptTable.time_created), asc(CoordinationReceiptTable.id))
            .limit(size)
            .all()
            .pipe(Effect.orDie)
          return rows.map(
            ({ receipt: row, selection }) =>
              ({
                id: row.id,
                groupID: row.group_id,
                ...(row.dispatch_id === null ? {} : { dispatchID: row.dispatch_id }),
                kind: row.kind,
                sessionID: row.session_id,
                ...(row.message_id === null ? {} : { messageID: row.message_id }),
                ...(row.generation === null ? {} : { generation: row.generation }),
                selection,
                time: row.time_created,
                ...(row.detail === null ? {} : { detail: row.detail }),
              }) satisfies Coordination.Receipt,
          )
        }),

        capacity: Effect.fn("Coordination.capacity")(function* (groupID) {
          const row = yield* groupRow(groupID)
          return (yield* capacityOf(row)).capacity
        }),

        roleFor: Effect.fn("Coordination.roleFor")(function* (sessionID) {
          const rows = yield* db
            .select({ member: CoordinationMemberTable, group: CoordinationGroupTable })
            .from(CoordinationMemberTable)
            .innerJoin(CoordinationGroupTable, eq(CoordinationMemberTable.group_id, CoordinationGroupTable.id))
            .where(eq(CoordinationMemberTable.session_id, sessionID))
            .all()
            .pipe(Effect.orDie)
          const live = rows.filter((row) => row.group.status !== "completed")
          if (live.length === 0) return undefined
          const precedence = { coordinator: 0, worker: 1, observer: 2 }
          live.sort(
            (left, right) =>
              precedence[left.member.role] - precedence[right.member.role] || right.group.time_updated - left.group.time_updated,
          )
          const chosen = live[0]!
          const policy = policyOf(chosen.group)
          return {
            groupID: chosen.group.id,
            revision: Coordination.Revision.make(chosen.group.revision),
            status: yield* effectiveStatus(chosen.group),
            role: chosen.member.role,
            ...(chosen.member.allowed_tools === null ? {} : { allowedTools: chosen.member.allowed_tools }),
            ...(chosen.member.resource_scopes === null ? {} : { resourceScopes: chosen.member.resource_scopes }),
            fencingGeneration: chosen.group.fencing_generation,
            ...(policy.delegatedDecisions === undefined ? {} : { delegatedDecisions: policy.delegatedDecisions }),
          } satisfies Coordination.RoleAccess
        }),

        standingRoles: Effect.fn("Coordination.standingRoles")(function* (sessionID) {
          const rows = yield* db
            .select({ member: CoordinationMemberTable, group: CoordinationGroupTable })
            .from(CoordinationMemberTable)
            .innerJoin(CoordinationGroupTable, eq(CoordinationMemberTable.group_id, CoordinationGroupTable.id))
            .where(eq(CoordinationMemberTable.session_id, sessionID))
            .orderBy(asc(CoordinationGroupTable.id))
            .all()
            .pipe(Effect.orDie)
          const accesses: Coordination.RoleAccess[] = []
          for (const row of rows) {
            const status = yield* effectiveStatus(row.group)
            if (status !== "armed" && status !== "waiting") continue
            const policy = policyOf(row.group)
            accesses.push({
              groupID: row.group.id,
              revision: Coordination.Revision.make(row.group.revision),
              status,
              role: row.member.role,
              ...(row.member.allowed_tools === null ? {} : { allowedTools: row.member.allowed_tools }),
              ...(row.member.resource_scopes === null ? {} : { resourceScopes: row.member.resource_scopes }),
              fencingGeneration: row.group.fencing_generation,
              ...(policy.delegatedDecisions === undefined ? {} : { delegatedDecisions: policy.delegatedDecisions }),
            })
          }
          return accesses
        }),

        accessForInput: Effect.fn("Coordination.accessForInput")(function* (input) {
          const message = yield* db
            .select({ data: SessionMessageTable.data })
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, input.messageID),
                eq(SessionMessageTable.session_id, input.sessionID),
                eq(SessionMessageTable.type, "user"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!message) return undefined
          const metadata = (message.data as { readonly metadata?: unknown }).metadata
          const provenance = Option.getOrUndefined(
            Schema.decodeUnknownOption(
              Schema.Struct({
                inputOrigin: Schema.Literal("coordination"),
                coordination: Schema.Struct({
                  groupID: Coordination.GroupID,
                  dispatchID: Coordination.DispatchID,
                  coordinatorSessionID: Schema.String,
                  generation: Schema.Int,
                }),
              }),
            )(metadata),
          )
          if (!provenance) return undefined
          const dispatch = yield* db
            .select()
            .from(CoordinationDispatchTable)
            .where(eq(CoordinationDispatchTable.message_id, input.messageID))
            .get()
            .pipe(Effect.orDie)
          if (
            !dispatch ||
            dispatch.id !== provenance.coordination.dispatchID ||
            dispatch.group_id !== provenance.coordination.groupID ||
            dispatch.target_session_id !== input.sessionID ||
            dispatch.coordinator_session_id !== provenance.coordination.coordinatorSessionID ||
            dispatch.generation !== provenance.coordination.generation ||
            dispatch.status !== "admitted"
          )
            return undefined
          const group = yield* groupRow(dispatch.group_id)
          const member = (yield* memberRows(group.id)).find((entry) => entry.session_id === input.sessionID)
          const allowedTools =
            dispatch.allowed_tools !== null && member?.allowed_tools
              ? dispatch.allowed_tools.filter((tool) => member.allowed_tools!.includes(tool))
              : (dispatch.allowed_tools ?? member?.allowed_tools ?? undefined)
          return {
            groupID: group.id,
            revision: Coordination.Revision.make(group.revision),
            status: yield* effectiveStatus(group),
            role: "worker",
            dispatchID: dispatch.id,
            coordinatorSessionID: dispatch.coordinator_session_id,
            generation: dispatch.generation,
            selection: dispatch.selection,
            ...(allowedTools === undefined ? {} : { allowedTools }),
            ...(!member || member.resource_scopes === null ? {} : { resourceScopes: member.resource_scopes }),
            ...(dispatch.resource_scope === null ? {} : { assignmentResourceScope: dispatch.resource_scope }),
          } satisfies Coordination.AssignmentAccess
        }),

        recover: Effect.fn("Coordination.recover")(function* () {
          const rows = yield* db
            .select()
            .from(CoordinationGroupTable)
            .where(eq(CoordinationGroupTable.status, "armed"))
            .all()
            .pipe(Effect.orDie)
          const at = yield* now
          for (const row of rows) {
            yield* events.publish(
              Coordination.Event.NeedsRearm,
              { groupID: row.id, revision: Coordination.Revision.make(row.revision + 1) },
              {
                commit: () =>
                  Effect.gen(function* () {
                    yield* db
                      .update(CoordinationWaitTable)
                      .set({ status: "expired", time_updated: at })
                      .where(and(eq(CoordinationWaitTable.group_id, row.id), eq(CoordinationWaitTable.status, "active")))
                      .run()
                      .pipe(Effect.orDie)
                    yield* bumpGroup(row, at, { status: "needs-rearm" })
                  }),
              },
            )
            yield* updated(row.id, row.revision + 1)
          }
          return rows.length
        }),
      }

      yield* service.recover().pipe(Effect.orDie)
      return Service.of(service)
    }),
  )

export const layer = layerWith()

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventRuntime.node, CoordinationDispatchSelection.node],
})
