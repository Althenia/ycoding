import { afterAll, describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionRetention } from "@ycoding-ai/core/session/retention"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const roots: string[] = []
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

const active = new Set<Session.ID>()
const hooks: Effect.Effect<void>[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.suspend(() => hooks.shift() ?? Effect.void).pipe(Effect.as(active)),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
    withTransition: (_sessionID, effect) => effect,
  }),
)

function services(input: { readonly days?: number; readonly database?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ycoding-session-retention-"))
  roots.push(root)
  if (input.days !== undefined)
    writeFileSync(path.join(root, "ycoding.json"), JSON.stringify({ session_retention: { days: input.days } }))
  return testEffect(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionRetention.node]),
      [
        [SessionExecution.node, execution],
        [Global.node, Global.layerWith({ config: root, home: root, data: path.join(root, "data") })],
        ...(input.database ? [[Database.node, Database.configured({ path: path.join(root, input.database) })] as const] : []),
      ],
    ),
  )
}

const it = services()
const configured = services({ days: 3 })
const reclaiming = services({ database: "retention.db" })

const day = 24 * 60 * 60 * 1000
const now = 100 * day
const old = now - 7 * day - 1
const recent = now - 7 * day

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const instructionEvent = "session.instructions.updated.2"

type Seed = {
  readonly id: string
  readonly updated: number
  readonly parent?: string
  readonly fork?: string
  readonly active?: number
  readonly pinned?: boolean
  readonly suspended?: boolean
  readonly goal?: boolean
  readonly pending?: boolean
  readonly instruction?: string
  readonly manifest?: string
  readonly providerState?: string
}

const seed = (input: Seed) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: Session.ID.make(input.id),
        project_id: Project.ID.global,
        directory: "/project",
        title: input.id,
        parent_id: input.parent ? Session.ID.make(input.parent) : null,
        fork_session_id: input.fork ? Session.ID.make(input.fork) : null,
        fork_seq: input.fork ? 0 : null,
        time_created: input.updated,
        time_updated: input.updated,
        time_active: input.active ?? null,
        time_pinned: input.pinned ? input.updated : null,
        time_suspended: input.suspended ? input.updated : null,
      })
      .run()
    if (input.goal)
      yield* db.run(
        sql`UPDATE session SET autonomy = json('{"mode":"goal","yolo":0,"goal":{"status":"active"}}') WHERE id = ${input.id}`,
      )
    yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES (${input.id}, 1)`)
    yield* db.run(
      sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES (${`evt_${input.id}_0`}, ${input.id}, 0, ${input.updated}, 'session.created.2', ${JSON.stringify({ sessionID: input.id })})`,
    )
    yield* db.run(
      sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (${`msg_${input.id}`}, ${input.id}, 'user', 0, ${input.updated}, ${input.updated}, '{}')`,
    )
    yield* db.run(
      sql`INSERT INTO session_context_revision (session_id, revision, time_created) VALUES (${input.id}, 0, ${input.updated})`,
    )
    if (input.pending)
      yield* db.run(
        sql`INSERT INTO session_pending (id, session_id, type, data, admitted_seq, time_created) VALUES (${`msg_pending_${input.id}`}, ${input.id}, 'user', '{}', 1, ${input.updated})`,
      )
    if (input.instruction) {
      const hash = digest(input.instruction)
      yield* db.run(
        sql`INSERT INTO instruction_blob (hash, value) VALUES (${hash}, ${JSON.stringify(input.instruction)}) ON CONFLICT DO NOTHING`,
      )
      yield* db.run(
        sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES (${`evt_${input.id}_1`}, ${input.id}, 1, ${input.updated}, ${instructionEvent}, ${JSON.stringify({ sessionID: input.id, delta: { "global:AGENTS.md": hash, "project:old": "removed" } })})`,
      )
      yield* db.run(
        sql`INSERT INTO instruction_state (session_id, epoch_start, through_seq, initial_values, current_values) VALUES (${input.id}, 1, 1, ${JSON.stringify({ "global:AGENTS.md": hash })}, ${JSON.stringify({ "global:AGENTS.md": hash })})`,
      )
    }
    if (input.manifest) {
      const hash = digest(input.manifest)
      yield* db.run(
        sql`INSERT INTO compaction_manifest_blob (digest, schema_version, content, input_tokens, retained_tokens, time_created) VALUES (${hash}, 1, '{}', 1, 1, 0) ON CONFLICT DO NOTHING`,
      )
      yield* db.run(
        sql`INSERT INTO session_context_revision (session_id, revision, parent_revision, manifest_digest, time_created) VALUES (${input.id}, 1, 0, ${hash}, ${input.updated})`,
      )
    }
    if (input.providerState) {
      const hash = digest(input.providerState)
      yield* db.run(
        sql`INSERT INTO session_provider_state_blob (digest, provider, model_id, item_type, content, time_created) VALUES (${hash}, 'openai', 'gpt-5.6', 'reasoning', '{}', 0) ON CONFLICT DO NOTHING`,
      )
      yield* db.run(
        sql`INSERT INTO session_provider_state_link (session_id, message_id, part_ordinal, part_kind, provider, model_id, blob_digest, context_revision, time_created) VALUES (${input.id}, ${`msg_${input.id}`}, 0, 'reasoning', 'openai', 'gpt-5.6', ${hash}, 0, 0)`,
      )
    }
  }).pipe(Effect.orDie)

const rows = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const count = (statement: ReturnType<typeof sql>) =>
      db.get<{ count: number }>(statement).pipe(
        Effect.orDie,
        Effect.map((row) => row?.count ?? 0),
      )
    return {
      session: yield* count(sql`SELECT count(*) AS count FROM session WHERE id = ${id}`),
      sequence: yield* count(sql`SELECT count(*) AS count FROM event_sequence WHERE aggregate_id = ${id}`),
      events: yield* count(sql`SELECT count(*) AS count FROM event WHERE aggregate_id = ${id}`),
      messages: yield* count(sql`SELECT count(*) AS count FROM session_message WHERE session_id = ${id}`),
      revisions: yield* count(sql`SELECT count(*) AS count FROM session_context_revision WHERE session_id = ${id}`),
    }
  })

const blobs = (value: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const hash = digest(value)
    const count = (statement: ReturnType<typeof sql>) =>
      db.get<{ count: number }>(statement).pipe(
        Effect.orDie,
        Effect.map((row) => row?.count ?? 0),
      )
    return {
      instruction: yield* count(sql`SELECT count(*) AS count FROM instruction_blob WHERE hash = ${hash}`),
      manifest: yield* count(sql`SELECT count(*) AS count FROM compaction_manifest_blob WHERE digest = ${hash}`),
      providerState: yield* count(sql`SELECT count(*) AS count FROM session_provider_state_blob WHERE digest = ${hash}`),
    }
  })

const gone = { session: 0, sequence: 0, events: 0, messages: 0, revisions: 0 }

const cleanup = (at = now) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(0)
    const retention = yield* SessionRetention.Service
    return yield* retention.cleanup(at)
  })

const removed = (id: string) => rows(id).pipe(Effect.map((value) => expect(value).toEqual(gone)))
const kept = (id: string) => rows(id).pipe(Effect.map((value) => expect(value.session).toBe(1)))

describe("SessionRetention", () => {
  it.effect("deletes an idle family with its events, projections, and orphaned blobs", () =>
    Effect.gen(function* () {
      yield* seed({ id: "ses_old_root", updated: old, instruction: "old root", manifest: "old manifest" })
      yield* seed({ id: "ses_old_child", parent: "ses_old_root", updated: old, providerState: "old reasoning" })
      yield* seed({ id: "ses_old_grandchild", parent: "ses_old_child", updated: old })

      expect(yield* cleanup()).toBe(3)

      yield* removed("ses_old_root")
      yield* removed("ses_old_child")
      yield* removed("ses_old_grandchild")
      expect(yield* blobs("old root")).toMatchObject({ instruction: 0 })
      expect(yield* blobs("old manifest")).toMatchObject({ manifest: 0 })
      expect(yield* blobs("old reasoning")).toMatchObject({ providerState: 0 })
    }),
  )

  it.effect("keeps families with any activity inside the retention window", () =>
    Effect.gen(function* () {
      yield* seed({ id: "ses_boundary", updated: recent })
      yield* seed({ id: "ses_recent_child_root", updated: old })
      yield* seed({ id: "ses_recent_child", parent: "ses_recent_child_root", updated: recent })
      yield* seed({ id: "ses_recent_active", updated: old, active: recent })

      expect(yield* cleanup()).toBe(0)

      yield* kept("ses_boundary")
      yield* kept("ses_recent_child_root")
      yield* kept("ses_recent_child")
      yield* kept("ses_recent_active")
    }),
  )

  it.effect("keeps exempt families", () =>
    Effect.gen(function* () {
      yield* seed({ id: "ses_pinned", updated: old, pinned: true })
      yield* seed({ id: "ses_goal_root", updated: old })
      yield* seed({ id: "ses_goal_child", parent: "ses_goal_root", updated: old, goal: true })
      yield* seed({ id: "ses_suspended", updated: old, suspended: true })
      yield* seed({ id: "ses_pending_root", updated: old })
      yield* seed({ id: "ses_pending_child", parent: "ses_pending_root", updated: old, pending: true })
      yield* seed({ id: "ses_running_root", updated: old })
      yield* seed({ id: "ses_running_child", parent: "ses_running_root", updated: old })
      yield* seed({ id: "ses_fork_source", updated: old })
      yield* seed({ id: "ses_fork", updated: recent, fork: "ses_fork_source" })
      active.add(Session.ID.make("ses_running_child"))

      expect(yield* cleanup()).toBe(0)
      active.clear()

      for (const id of [
        "ses_pinned",
        "ses_goal_root",
        "ses_goal_child",
        "ses_suspended",
        "ses_pending_root",
        "ses_pending_child",
        "ses_running_root",
        "ses_running_child",
        "ses_fork_source",
        "ses_fork",
      ])
        yield* kept(id)
    }),
  )

  it.effect("rechecks a selected family inside its deletion transaction", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed({ id: "ses_touched", updated: old })
      hooks.push(db.run(sql`UPDATE session SET time_updated = ${now} WHERE id = 'ses_touched'`).pipe(Effect.orDie, Effect.asVoid))

      expect(yield* cleanup()).toBe(0)
      hooks.length = 0

      yield* kept("ses_touched")
    }),
  )

  it.effect("preserves blobs still referenced by a kept Session", () =>
    Effect.gen(function* () {
      yield* seed({ id: "ses_shared_old", updated: old, instruction: "shared", manifest: "shared", providerState: "shared" })
      yield* seed({ id: "ses_shared_kept", updated: recent, instruction: "shared", manifest: "shared", providerState: "shared" })

      expect(yield* cleanup()).toBe(1)

      yield* removed("ses_shared_old")
      yield* kept("ses_shared_kept")
      expect(yield* blobs("shared")).toEqual({ instruction: 1, manifest: 1, providerState: 1 })
    }),
  )

  it.effect("deletes unreferenced instruction blobs across chunks after the sweep", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const values = Array.from({ length: 1200 }, (_, index) => `chunked ${index}`)
      yield* seed({ id: "ses_chunked_old", updated: old })
      yield* seed({ id: "ses_chunked_kept", updated: recent, instruction: "chunked 1100" })
      yield* Effect.forEach(
        values,
        (value) =>
          db.run(
            sql`INSERT INTO instruction_blob (hash, value) VALUES (${digest(value)}, ${JSON.stringify(value)}) ON CONFLICT DO NOTHING`,
          ),
        { discard: true },
      ).pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('evt_chunked', 'ses_chunked_old', 1, ${old}, ${instructionEvent}, ${JSON.stringify({ sessionID: "ses_chunked_old", delta: Object.fromEntries(values.map((value) => [`global:${value}`, digest(value)])) })})`,
        )
        .pipe(Effect.orDie)

      expect(yield* cleanup()).toBe(1)

      yield* removed("ses_chunked_old")
      const remaining = yield* Effect.forEach(values, (value) =>
        blobs(value).pipe(Effect.map((counts) => (counts.instruction === 1 ? [value] : []))),
      )
      expect(remaining.flat()).toEqual(["chunked 1100"])
    }),
  )

  configured.effect("uses the configured retention days", () =>
    Effect.gen(function* () {
      yield* seed({ id: "ses_four_days", updated: now - 4 * day })
      yield* seed({ id: "ses_two_days", updated: now - 2 * day })

      expect(yield* cleanup()).toBe(1)

      yield* removed("ses_four_days")
      yield* kept("ses_two_days")
    }),
  )

  reclaiming.effect("reclaims every free page after deleting a family", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect((yield* db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum").pipe(Effect.orDie))?.auto_vacuum).toBe(2)
      yield* seed({ id: "ses_large", updated: old })
      yield* db
        .run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
            WITH RECURSIVE counter(value) AS (VALUES (1) UNION ALL SELECT value + 1 FROM counter WHERE value < 3000)
            SELECT 'msg_large_' || value, 'ses_large', 'user', value, 0, 0, json_object('text', hex(randomblob(4096))) FROM counter`,
        )
        .pipe(Effect.orDie)

      const retention = yield* SessionRetention.Service
      expect(yield* retention.cleanup(now)).toBe(1)

      yield* removed("ses_large")
      expect((yield* db.get<{ freelist_count: number }>("PRAGMA freelist_count").pipe(Effect.orDie))?.freelist_count).toBe(0)
    }),
  )
})
