import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { tmpdir } from "node:os"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { EventTable } from "../src/event/sql"
import { CoordinationService } from "../src/coordination/index"
import { CoordinationGroupTable, CoordinationMemberTable } from "../src/coordination/sql"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"

const runtime = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, Session.node, CoordinationService.node]),
  [[SessionExecution.node, SessionExecution.noopLayer]],
)
type Services = Database.Service | EventRuntime.Service | Session.Service | CoordinationService.Service
const run = <A, E>(body: Effect.Effect<A, E, Services>, layer: Layer.Layer<Services, unknown> = runtime) =>
  Effect.runPromise(body.pipe(Effect.provide(layer), Effect.scoped))

const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const location = { directory: AbsolutePath.make(tmpdir()) }
  const master = yield* sessions.create({ location, title: "master" })
  const member = yield* sessions.create({ location, title: "member" })
  const other = yield* sessions.create({ location, title: "other" })
  const spare = yield* sessions.create({ location, title: "spare" })
  return { sessions, master, member, other, spare, location }
})

const create = Effect.fnUntraced(function* (ids: Effect.Success<typeof setup>) {
  const service = yield* CoordinationService.Service
  return yield* service.create({ name: "Docs", masterSessionID: ids.master.id, memberSessionIDs: [ids.member.id] })
})

const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.flip, Effect.map((error) => error as E & { readonly _tag: string; readonly message: string }))

describe("Project creation", () => {
  test("creates one Project with exactly one Master, members, and default settings", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      expect(group.id.startsWith("cgrp_")).toBe(true)
      expect(group.revision).toBe(Coordination.Revision.make(0))
      expect(group.masterSessionID).toBe(ids.master.id)
      expect(group.memberSessionIDs).toEqual([ids.member.id])
      expect(group.settings).toEqual({ concurrency: null })
      expect(group.active).toBe(false)
      expect(yield* service.get(group.id)).toEqual(group)
      expect((yield* service.list()).map((entry) => entry.id)).toEqual([group.id])
    })))

  test("a Project may start with no members", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* service.create({ name: "Solo", masterSessionID: ids.master.id, memberSessionIDs: [] })
      expect(group.memberSessionIDs).toEqual([])
    })))

  test("rejects invalid names and unknown fields", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      for (const name of ["", "x".repeat(121)])
        expect((yield* failure(service.create({ name, masterSessionID: ids.master.id, memberSessionIDs: [] })))._tag).toBe("Coordination.InvalidInputError")
      const extra = { name: "Docs", masterSessionID: ids.master.id, memberSessionIDs: [], role: "coordinator" } as never
      expect((yield* failure(service.create(extra)))._tag).toBe("Coordination.InvalidInputError")
    })))

  test("rejects unknown, child, archived, duplicate, and Master-as-member Sessions", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const { db } = yield* Database.Service
      const child = yield* ids.sessions.create({ parentID: ids.member.id, title: "child" })
      const archived = yield* ids.sessions.create({ location: ids.location, title: "archived" })
      yield* db.run(sql`UPDATE session SET time_archived = 1 WHERE id = ${archived.id}`).pipe(Effect.orDie)
      const attempt = (masterSessionID: Session.ID, memberSessionIDs: ReadonlyArray<Session.ID>) =>
        failure(service.create({ name: "Docs", masterSessionID, memberSessionIDs }))
      expect((yield* attempt(ids.master.id, [Session.ID.make("ses_missing")])).message).toContain("does not exist")
      expect((yield* attempt(ids.master.id, [child.id])).message).toContain("child Session")
      expect((yield* attempt(ids.master.id, [archived.id])).message).toContain("archived")
      expect((yield* attempt(archived.id, [])).message).toContain("archived")
      expect((yield* attempt(ids.master.id, [ids.member.id, ids.member.id]))._tag).toBe("Coordination.IneligibleSessionError")
      expect((yield* attempt(ids.master.id, [ids.master.id]))._tag).toBe("Coordination.IneligibleSessionError")
      expect(yield* service.list()).toEqual([])
    })))

  test("a Session belongs to at most one Project as Master or member", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const first = yield* create(ids)
      const attempt = (masterSessionID: Session.ID, memberSessionIDs: ReadonlyArray<Session.ID>) =>
        failure(service.create({ name: "Second", masterSessionID, memberSessionIDs }))
      for (const error of [
        yield* attempt(ids.other.id, [ids.member.id]),
        yield* attempt(ids.member.id, []),
        yield* attempt(ids.master.id, []),
        yield* attempt(ids.other.id, [ids.master.id]),
      ]) {
        expect(error._tag).toBe("Coordination.IneligibleSessionError")
        expect(error.message).toContain(first.id)
      }
      const second = yield* service.create({ name: "Second", masterSessionID: ids.other.id, memberSessionIDs: [ids.spare.id] })
      expect((yield* service.list()).map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort())
    })))

  test("the database enforces one Project per Session independently of validation", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const { db } = yield* Database.Service
      const group = yield* create(ids)
      const duplicate = yield* db
        .insert(CoordinationMemberTable)
        .values({ group_id: group.id, session_id: ids.member.id })
        .run()
        .pipe(Effect.exit)
      expect(duplicate._tag).toBe("Failure")
      const second = yield* db
        .insert(CoordinationGroupTable)
        .values({ id: Coordination.GroupID.create(), name: "Dup", revision: 0, master_session_id: ids.master.id, time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.exit)
      expect(second._tag).toBe("Failure")
    })))

  test("records durable created, changed, and deleted events in order", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const { db } = yield* Database.Service
      const group = yield* create(ids)
      yield* service.update(group.id, { revision: group.revision, name: "Renamed" })
      yield* service.delete(group.id)
      const rows = yield* db.select({ type: EventTable.type }).from(EventTable).where(eq(EventTable.aggregate_id, group.id)).orderBy(EventTable.seq).all().pipe(Effect.orDie)
      expect(rows.map((row) => row.type)).toEqual(["coordination.group.created.2", "coordination.group.changed.1", "coordination.group.deleted.1"])
    })))
})

describe("Project update", () => {
  test("is revision-checked and bumps the revision", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      const renamed = yield* service.update(group.id, { revision: group.revision, name: "Renamed" })
      expect(renamed.name).toBe("Renamed")
      expect(renamed.revision).toBe(Coordination.Revision.make(1))
      expect(renamed.memberSessionIDs).toEqual([ids.member.id])
      const stale = yield* failure(service.update(group.id, { revision: group.revision, name: "Stale" }))
      expect(stale._tag).toBe("Coordination.ConflictError")
      expect((yield* service.get(group.id)).name).toBe("Renamed")
      expect((yield* failure(service.update(Coordination.GroupID.make("cgrp_missing"), { revision: Coordination.Revision.make(0) })))._tag).toBe("Coordination.NotFoundError")
    })))

  test("replaces members, swaps the Master, and replaces settings as a whole", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      const grown = yield* service.update(group.id, {
        revision: group.revision,
        memberSessionIDs: [ids.member.id, ids.other.id],
        settings: { concurrency: 2, delegatedDecisions: { categories: ["question"] } },
      })
      expect(grown.memberSessionIDs.slice().sort()).toEqual([ids.member.id, ids.other.id].sort())
      expect(grown.settings).toEqual({ concurrency: 2, delegatedDecisions: { categories: ["question"] } })
      const preserved = yield* service.update(group.id, { revision: grown.revision, name: "Same settings" })
      expect(preserved.settings).toEqual(grown.settings)
      const swapped = yield* service.update(group.id, {
        revision: preserved.revision,
        masterSessionID: ids.other.id,
        memberSessionIDs: [ids.master.id, ids.member.id],
        settings: { concurrency: null },
      })
      expect(swapped.masterSessionID).toBe(ids.other.id)
      expect(swapped.memberSessionIDs.slice().sort()).toEqual([ids.master.id, ids.member.id].sort())
      expect(swapped.settings).toEqual({ concurrency: null })
    })))

  test("refuses to leave the Master in the member list or to take another Project's Session", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      const second = yield* service.create({ name: "Second", masterSessionID: ids.other.id, memberSessionIDs: [ids.spare.id] })
      expect((yield* failure(service.update(group.id, { revision: group.revision, masterSessionID: ids.member.id })))._tag).toBe("Coordination.IneligibleSessionError")
      expect((yield* failure(service.update(group.id, { revision: group.revision, memberSessionIDs: [ids.spare.id] })))._tag).toBe("Coordination.IneligibleSessionError")
      expect((yield* failure(service.update(group.id, { revision: group.revision, masterSessionID: ids.other.id })))._tag).toBe("Coordination.IneligibleSessionError")
      expect((yield* service.get(group.id)).revision).toBe(group.revision)
      yield* service.update(second.id, { revision: second.revision, memberSessionIDs: [] })
      const moved = yield* service.update(group.id, { revision: group.revision, memberSessionIDs: [ids.member.id, ids.spare.id] })
      expect(moved.memberSessionIDs).toContain(ids.spare.id)
    })))

  test("changing the Master pauses an active Project", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      yield* service.activate(group.id)
      expect((yield* service.get(group.id)).active).toBe(true)
      const renamed = yield* service.update(group.id, { revision: group.revision, name: "Still active" })
      expect(renamed.active).toBe(true)
      const swapped = yield* service.update(group.id, { revision: renamed.revision, masterSessionID: ids.other.id })
      expect(swapped.active).toBe(false)
    })))
})

describe("Project deletion and Session lifecycle", () => {
  test("deleting a Project leaves its Sessions and releases them for other Projects", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      yield* service.delete(group.id)
      expect(yield* service.list()).toEqual([])
      expect((yield* failure(service.get(group.id)))._tag).toBe("Coordination.NotFoundError")
      expect((yield* failure(service.delete(group.id)))._tag).toBe("Coordination.NotFoundError")
      expect((yield* ids.sessions.get(ids.master.id)).id).toBe(ids.master.id)
      expect((yield* ids.sessions.get(ids.member.id)).id).toBe(ids.member.id)
      const again = yield* service.create({ name: "Again", masterSessionID: ids.member.id, memberSessionIDs: [ids.master.id] })
      expect(again.masterSessionID).toBe(ids.member.id)
    })))

  test("deleting a member Session removes it from its Project and deleting the Master Session deletes the Project", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      yield* ids.sessions.remove(ids.member.id)
      expect((yield* service.get(group.id)).memberSessionIDs).toEqual([])
      yield* ids.sessions.remove(ids.master.id)
      expect(yield* service.list()).toEqual([])
    })))
})

describe("Project scope", () => {
  test("interrupting an idle Master pauses its Project", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      yield* service.activate(group.id)
      yield* ids.sessions.interrupt(ids.master.id)
      expect((yield* service.get(group.id)).active).toBe(false)
      expect((yield* service.get(group.id)).pausedReason).toBe("interrupted")
    })))

  test("the Master and its descendants act for the Project; members and their descendants do not", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      const child = yield* ids.sessions.create({ parentID: ids.master.id, title: "master child" })
      const grandchild = yield* ids.sessions.create({ parentID: child.id, title: "master grandchild" })
      const memberChild = yield* ids.sessions.create({ parentID: ids.member.id, title: "member child" })
      for (const id of [ids.master.id, child.id, grandchild.id])
        expect(yield* service.scopeOf(id)).toMatchObject({ groupID: group.id, masterSessionID: ids.master.id, memberSessionIDs: [ids.member.id], active: false })
      for (const id of [ids.member.id, memberChild.id, ids.other.id]) expect(yield* service.scopeOf(id)).toBeUndefined()
      expect(yield* service.memberOf(ids.member.id)).toMatchObject({ groupID: group.id })
      for (const id of [ids.master.id, child.id, memberChild.id, ids.other.id]) expect(yield* service.memberOf(id)).toBeUndefined()
    })))

  test("activation is runtime state that publishes an invalidation and clears on pause", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const events = yield* EventRuntime.Service
      const group = yield* create(ids)
      const seen: string[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => { if (event.type === Coordination.Event.Updated.type) seen.push(event.type) }))
      yield* service.activate(group.id)
      yield* service.activate(group.id)
      expect((yield* service.scopeOf(ids.master.id))?.active).toBe(true)
      yield* service.pause(group.id)
      yield* service.pause(group.id)
      expect((yield* service.scopeOf(ids.master.id))?.active).toBe(false)
      expect((yield* service.get(group.id)).pausedReason).toBe("interrupted")
      yield* service.activate(group.id)
      expect((yield* service.get(group.id)).pausedReason).toBeUndefined()
      yield* unsubscribe
      expect(seen).toHaveLength(3)
    })))

  test("a backend restart leaves every Project inactive", () =>
    run(Effect.gen(function* () {
      const ids = yield* setup
      const service = yield* CoordinationService.Service
      const group = yield* create(ids)
      yield* service.activate(group.id)
      expect((yield* service.get(group.id)).active).toBe(true)
      const restarted = yield* CoordinationService.Service.pipe(Effect.provide(Layer.fresh(CoordinationService.layer)))
      expect((yield* restarted.get(group.id)).active).toBe(false)
      expect((yield* restarted.get(group.id)).pausedReason).toBe("restart")
      expect((yield* restarted.scopeOf(ids.master.id))?.active).toBe(false)
    })))
})
