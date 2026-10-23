export * as CoordinationService from "./index"

import { Coordination } from "@ycoding-ai/schema/coordination"
import type { Session } from "@ycoding-ai/schema/session"
import { and, desc, eq, inArray, ne } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { SessionTable } from "../session/sql"
import { CoordinationGroupTable, CoordinationMemberTable } from "./sql"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Coordination.NotFoundError", {
  message: Schema.String,
}) {}
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Coordination.ConflictError", {
  message: Schema.String,
}) {}
export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("Coordination.InvalidInputError", {
  message: Schema.String,
}) {}
export class IneligibleSessionError extends Schema.TaggedErrorClass<IneligibleSessionError>()(
  "Coordination.IneligibleSessionError",
  { message: Schema.String },
) {}

export type Error = NotFoundError | ConflictError | InvalidInputError | IneligibleSessionError

export interface Group {
  readonly id: Coordination.GroupID
  readonly name: string
  readonly revision: Coordination.Revision
  readonly masterSessionID: Session.ID
  readonly memberSessionIDs: ReadonlyArray<Session.ID>
  readonly settings: Coordination.GroupSettings
  readonly active: boolean
  readonly pausedReason?: Coordination.PausedReason
  readonly time: { readonly created: number; readonly updated: number }
}

export interface Scope {
  readonly groupID: Coordination.GroupID
  readonly masterSessionID: Session.ID
  readonly memberSessionIDs: ReadonlyArray<Session.ID>
  readonly settings: Coordination.GroupSettings
  readonly active: boolean
  readonly pausedReason?: Coordination.PausedReason
}

export interface Interface {
  readonly create: (input: Coordination.CreateInput) => Effect.Effect<Group, Error>
  readonly list: () => Effect.Effect<ReadonlyArray<Group>>
  readonly get: (groupID: Coordination.GroupID) => Effect.Effect<Group, NotFoundError>
  readonly update: (
    groupID: Coordination.GroupID,
    input: Coordination.UpdateInput,
  ) => Effect.Effect<Group, Error>
  readonly delete: (groupID: Coordination.GroupID) => Effect.Effect<void, NotFoundError>
  readonly scopeOf: (sessionID: Session.ID) => Effect.Effect<Scope | undefined>
  readonly memberOf: (sessionID: Session.ID) => Effect.Effect<Scope | undefined>
  readonly activate: (groupID: Coordination.GroupID) => Effect.Effect<void>
  readonly pause: (groupID: Coordination.GroupID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Coordination") {}

type GroupRow = typeof CoordinationGroupTable.$inferSelect

const maxAncestors = 32

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const lock = KeyedMutex.makeUnsafe<string>()
    const active = new Set<Coordination.GroupID>()
    const existing = yield* db.select({ id: CoordinationGroupTable.id }).from(CoordinationGroupTable).all().pipe(Effect.orDie)
    const pausedReasons = new Map<Coordination.GroupID, Coordination.PausedReason>(existing.map(({ id }) => [id, "restart"]))
    const now = Clock.currentTimeMillis

    const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
      Schema.decodeUnknownEffect(schema as never, { onExcessProperty: "error" })(input).pipe(
        Effect.mapError((error) => new InvalidInputError({ message: String(error).slice(0, 500) })),
        Effect.map((value) => value as S["Type"]),
      )

    const memberIDs = (groupID: Coordination.GroupID) =>
      db
        .select({ id: CoordinationMemberTable.session_id })
        .from(CoordinationMemberTable)
        .where(eq(CoordinationMemberTable.group_id, groupID))
        .orderBy(CoordinationMemberTable.session_id)
        .all()
        .pipe(Effect.orDie, Effect.map((rows) => rows.map((row) => row.id)))

    const settingsOf = (row: GroupRow): Coordination.GroupSettings => ({
      concurrency: row.concurrency,
      ...(row.delegated_decisions === null ? {} : { delegatedDecisions: row.delegated_decisions }),
    })

    const groupOf = Effect.fnUntraced(function* (row: GroupRow) {
      return {
        id: row.id,
        name: row.name,
        revision: Coordination.Revision.make(row.revision),
        masterSessionID: row.master_session_id,
        memberSessionIDs: yield* memberIDs(row.id),
        settings: settingsOf(row),
        active: active.has(row.id),
        ...(pausedReasons.has(row.id) ? { pausedReason: pausedReasons.get(row.id) } : {}),
        time: { created: row.time_created, updated: row.time_updated },
      } satisfies Group
    })

    const row = Effect.fnUntraced(function* (groupID: Coordination.GroupID) {
      const found = yield* db
        .select()
        .from(CoordinationGroupTable)
        .where(eq(CoordinationGroupTable.id, groupID))
        .get()
        .pipe(Effect.orDie)
      if (!found) return yield* new NotFoundError({ message: `Project ${groupID} does not exist` })
      return found
    })

    const validateSessions = Effect.fnUntraced(function* (
      groupID: Coordination.GroupID | undefined,
      masterSessionID: Session.ID,
      memberSessionIDs: ReadonlyArray<Session.ID>,
    ) {
      const ids = [masterSessionID, ...memberSessionIDs]
      if (new Set(ids).size !== ids.length)
        return yield* new IneligibleSessionError({ message: "A Project lists each Session once, and the Master is not a member" })
      const sessions = new Map(
        (yield* db
          .select({ id: SessionTable.id, parent_id: SessionTable.parent_id, time_archived: SessionTable.time_archived })
          .from(SessionTable)
          .where(inArray(SessionTable.id, ids))
          .all()
          .pipe(Effect.orDie)).map((session) => [session.id, session]),
      )
      for (const id of ids) {
        const session = sessions.get(id)
        if (!session) return yield* new IneligibleSessionError({ message: `Session ${id} does not exist` })
        if (session.parent_id !== null)
          return yield* new IneligibleSessionError({ message: `Session ${id} is a child Session, not a root` })
        if (session.time_archived !== null) return yield* new IneligibleSessionError({ message: `Session ${id} is archived` })
      }
      const other = (column: typeof CoordinationGroupTable.id | typeof CoordinationMemberTable.group_id) =>
        groupID === undefined ? undefined : ne(column, groupID)
      const mastered = yield* db
        .select({ session: CoordinationGroupTable.master_session_id, group: CoordinationGroupTable.id })
        .from(CoordinationGroupTable)
        .where(and(inArray(CoordinationGroupTable.master_session_id, ids), other(CoordinationGroupTable.id)))
        .all()
        .pipe(Effect.orDie)
      const membered = yield* db
        .select({ session: CoordinationMemberTable.session_id, group: CoordinationMemberTable.group_id })
        .from(CoordinationMemberTable)
        .where(and(inArray(CoordinationMemberTable.session_id, ids), other(CoordinationMemberTable.group_id)))
        .all()
        .pipe(Effect.orDie)
      const taken = [...mastered, ...membered][0]
      if (taken) return yield* new IneligibleSessionError({ message: `Session ${taken.session} already belongs to Project ${taken.group}` })
    })

    const updated = (groupID: Coordination.GroupID, revision: number) =>
      events.publish(Coordination.Event.Updated, { groupID, revision: Coordination.Revision.make(revision) }).pipe(Effect.asVoid)

    const insertMembers = (groupID: Coordination.GroupID, sessionIDs: ReadonlyArray<Session.ID>) =>
      sessionIDs.length === 0
        ? Effect.void
        : db
            .insert(CoordinationMemberTable)
            .values(sessionIDs.map((session_id) => ({ group_id: groupID, session_id })))
            .run()
            .pipe(Effect.orDie, Effect.asVoid)

    const scopeFor = Effect.fnUntraced(function* (found: GroupRow | undefined) {
      if (!found) return undefined
      return {
        groupID: found.id,
        masterSessionID: found.master_session_id,
        memberSessionIDs: yield* memberIDs(found.id),
        settings: settingsOf(found),
        active: active.has(found.id),
        ...(pausedReasons.has(found.id) ? { pausedReason: pausedReasons.get(found.id) } : {}),
      } satisfies Scope
    })

    const service: Interface = {
      create: Effect.fn("Coordination.create")((value) =>
        lock.withLock("projects")(
          Effect.gen(function* () {
            const input = yield* decode(Coordination.CreateInput, value)
            yield* validateSessions(undefined, input.masterSessionID, input.memberSessionIDs)
            const at = yield* now
            const groupID = Coordination.GroupID.create()
            const settings: Coordination.GroupSettings = { concurrency: null }
            yield* events.publish(
              Coordination.Event.Created,
              {
                groupID,
                revision: Coordination.Revision.make(0),
                name: input.name,
                masterSessionID: input.masterSessionID,
                memberSessionIDs: input.memberSessionIDs,
                settings,
              },
              {
                commit: () =>
                  Effect.gen(function* () {
                    yield* db
                      .insert(CoordinationGroupTable)
                      .values({
                        id: groupID,
                        name: input.name,
                        revision: 0,
                        master_session_id: input.masterSessionID,
                        concurrency: null,
                        delegated_decisions: null,
                        time_created: at,
                        time_updated: at,
                      })
                      .run()
                      .pipe(Effect.orDie)
                    yield* insertMembers(groupID, input.memberSessionIDs)
                  }),
              },
            )
            yield* updated(groupID, 0)
            return yield* groupOf(yield* row(groupID))
          }),
        ),
      ),

      list: Effect.fn("Coordination.list")(function* () {
        const rows = yield* db
          .select()
          .from(CoordinationGroupTable)
          .orderBy(desc(CoordinationGroupTable.time_updated), desc(CoordinationGroupTable.id))
          .limit(200)
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, groupOf)
      }),

      get: Effect.fn("Coordination.get")(function* (groupID) {
        return yield* groupOf(yield* row(groupID))
      }),

      update: Effect.fn("Coordination.update")((groupID, value) =>
        lock.withLock("projects")(
          Effect.gen(function* () {
            const input = yield* decode(Coordination.UpdateInput, value)
            const current = yield* row(groupID)
            if (current.revision !== input.revision)
              return yield* new ConflictError({ message: `Project ${groupID} revision is ${current.revision}, expected ${input.revision}` })
            const name = input.name ?? current.name
            const masterSessionID = input.masterSessionID ?? current.master_session_id
            const memberSessionIDs = input.memberSessionIDs ?? (yield* memberIDs(groupID))
            const settings = input.settings ?? settingsOf(current)
            yield* validateSessions(groupID, masterSessionID, memberSessionIDs)
            const at = yield* now
            const revision = current.revision + 1
            yield* events.publish(
              Coordination.Event.Changed,
              { groupID, revision: Coordination.Revision.make(revision), name, masterSessionID, memberSessionIDs, settings },
              {
                commit: () =>
                  Effect.gen(function* () {
                    yield* db.delete(CoordinationMemberTable).where(eq(CoordinationMemberTable.group_id, groupID)).run().pipe(Effect.orDie)
                    yield* db
                      .update(CoordinationGroupTable)
                      .set({
                        name,
                        revision,
                        master_session_id: masterSessionID,
                        concurrency: settings.concurrency,
                        delegated_decisions: settings.delegatedDecisions ?? null,
                        time_updated: at,
                      })
                      .where(eq(CoordinationGroupTable.id, groupID))
                      .run()
                      .pipe(Effect.orDie)
                    yield* insertMembers(groupID, memberSessionIDs)
                  }),
              },
            )
            if (masterSessionID !== current.master_session_id) {
              active.delete(groupID)
              pausedReasons.delete(groupID)
            }
            yield* updated(groupID, revision)
            return yield* groupOf(yield* row(groupID))
          }),
        ),
      ),

      delete: Effect.fn("Coordination.delete")((groupID) =>
        lock.withLock("projects")(
          Effect.gen(function* () {
            const current = yield* row(groupID)
            yield* events.publish(
              Coordination.Event.Deleted,
              { groupID, revision: Coordination.Revision.make(current.revision + 1) },
              {
                commit: () =>
                  Effect.gen(function* () {
                    yield* db.delete(CoordinationMemberTable).where(eq(CoordinationMemberTable.group_id, groupID)).run().pipe(Effect.orDie)
                    yield* db.delete(CoordinationGroupTable).where(eq(CoordinationGroupTable.id, groupID)).run().pipe(Effect.orDie)
                  }),
              },
            )
            active.delete(groupID)
            pausedReasons.delete(groupID)
            yield* updated(groupID, current.revision + 1)
          }),
        ),
      ),

      scopeOf: Effect.fn("Coordination.scopeOf")(function* (sessionID) {
        let current: Session.ID | null | undefined = sessionID
        for (let depth = 0; current && depth < maxAncestors; depth++) {
          const master: GroupRow | undefined = yield* db
            .select()
            .from(CoordinationGroupTable)
            .where(eq(CoordinationGroupTable.master_session_id, current))
            .get()
            .pipe(Effect.orDie)
          if (master) return yield* scopeFor(master)
          const parent: { id: Session.ID | null } | undefined = yield* db
            .select({ id: SessionTable.parent_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, current))
            .get()
            .pipe(Effect.orDie)
          current = parent?.id
        }
        return undefined
      }),

      memberOf: Effect.fn("Coordination.memberOf")(function* (sessionID) {
        const member = yield* db
          .select({ group: CoordinationMemberTable.group_id })
          .from(CoordinationMemberTable)
          .where(eq(CoordinationMemberTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!member) return undefined
        return yield* scopeFor(yield* db.select().from(CoordinationGroupTable).where(eq(CoordinationGroupTable.id, member.group)).get().pipe(Effect.orDie))
      }),

      activate: (groupID) =>
        active.has(groupID)
          ? Effect.void
          : Effect.suspend(() => {
              active.add(groupID)
              pausedReasons.delete(groupID)
              return row(groupID).pipe(Effect.flatMap((found) => updated(groupID, found.revision)), Effect.ignore)
            }),

      pause: (groupID) =>
        !active.has(groupID) && pausedReasons.get(groupID) === "interrupted"
          ? Effect.void
          : Effect.suspend(() => {
              active.delete(groupID)
              pausedReasons.set(groupID, "interrupted")
              return row(groupID).pipe(Effect.flatMap((found) => updated(groupID, found.revision)), Effect.ignore)
            }),
    }
    return Service.of(service)
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventRuntime.node] })
