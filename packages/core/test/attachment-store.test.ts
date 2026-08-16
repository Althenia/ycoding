import { afterAll, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Database } from "@ycoding-ai/core/database/database"
import { Global } from "@ycoding-ai/core/global"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm, stat, symlink, unlink, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "os"
import { testEffect } from "./lib/effect"

const root = await mkdtemp(path.join(tmpdir(), "ycoding-attachment-store-"))
afterAll(() => rm(root, { recursive: true, force: true }))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, AttachmentStore.node]), [
    [Database.node, Database.layerFromPath(path.join(root, "test.db"))],
    [Global.node, Global.layerWith({ data: root })],
  ]),
)

describe("AttachmentStore", () => {
  it.effect("imports content atomically with a verified managed reference", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const bytes = Buffer.from("managed attachment")
      const content = yield* store.import(bytes)

      expect(content).toEqual({
        type: "managed",
        digest: "41ec6d391622f64880fe2995d08baef45ddfa52fbd06dd04fae881f57c3a828d",
        bytes: bytes.byteLength,
        path: "attachments/sha256/41/41ec6d391622f64880fe2995d08baef45ddfa52fbd06dd04fae881f57c3a828d",
      })
      expect(Buffer.from(yield* store.read(content))).toEqual(bytes)
      expect((yield* Effect.promise(() => stat(store.absolutePath(content)))).mode & 0o777).toBe(0o600)
      expect(yield* store.import(bytes)).toEqual(content)
    }),
  )

  it.effect("rejects paths outside the managed content address", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const error = yield* store
        .read({
          type: "managed",
          digest: "0".repeat(64),
          bytes: 0,
          path: "../outside",
        })
        .pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "AttachmentStore.Error", reason: "invalid-reference" })
    }),
  )

  it.effect("rejects digest or size mismatches when reading", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const content = yield* store.import(Buffer.from("original"))
      yield* Effect.promise(() => Bun.write(store.absolutePath(content), "changed"))

      const error = yield* store.read(content).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "AttachmentStore.Error", reason: "integrity" })
    }),
  )

  it.effect("rejects attachments above the durable 20 MiB limit", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const error = yield* store.import(new Uint8Array(20 * 1024 * 1024 + 1)).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "AttachmentStore.Error", reason: "limit" })
    }),
  )

  it.effect("rejects symlinked managed files", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const bytes = Buffer.from("symlink target")
      const content = yield* store.import(bytes)
      const external = path.join(root, "external-attachment")
      yield* Effect.promise(() => writeFile(external, bytes))
      yield* Effect.promise(() => unlink(store.absolutePath(content)))
      yield* Effect.promise(() => symlink(external, store.absolutePath(content)))

      const error = yield* store.read(content).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "AttachmentStore.Error", reason: "invalid-reference" })
    }),
  )

  it.effect("migrates event, pending, and message copies before recording completion", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const { db } = yield* Database.Service
      const data = Buffer.from("legacy durable bytes").toString("base64")
      const file = { data, mime: "application/pdf", source: { type: "inline" }, name: "legacy.pdf" }
      yield* db.run(sql`DELETE FROM data_migration WHERE name = 'managed-attachments-v1'`)
      yield* db.run("PRAGMA foreign_keys = OFF")
      yield* db.run(sql`
        INSERT INTO event (id, aggregate_id, seq, created, type, data)
        VALUES ('evt_attachment_migration', 'ses_attachment_migration', 0, 0, 'session.input.admitted.1',
          ${JSON.stringify({ inputID: "msg_attachment_event", sessionID: "ses_attachment_migration", input: { type: "user", data: { text: "event", files: [file] }, delivery: "steer" } })})
      `)
      yield* db.run(sql`
        INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
        VALUES ('msg_attachment_pending', 'ses_attachment_migration', 'user',
          ${JSON.stringify({ text: "pending", files: [file] })}, 'steer', 1, 0)
      `)
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_attachment_message', 'ses_attachment_migration', 'user', 2, 0, 0,
          ${JSON.stringify({ text: "message", files: [file], time: { created: 0 } })})
      `)
      yield* db.run("PRAGMA foreign_keys = ON")

      yield* AttachmentStore.migrate(db, store)
      yield* AttachmentStore.migrate(db, store)

      const copies = yield* db.all<{ data: unknown }>(sql`
        SELECT data FROM event WHERE id = 'evt_attachment_migration'
        UNION ALL SELECT data FROM session_pending WHERE id = 'msg_attachment_pending'
        UNION ALL SELECT data FROM session_message WHERE id = 'msg_attachment_message'
      `)
      expect(copies).toHaveLength(3)
      for (const copy of copies) {
        const stored = typeof copy.data === "string" ? JSON.parse(copy.data) : copy.data
        expect(JSON.stringify(stored)).not.toContain(data)
        expect(JSON.stringify(stored)).toContain('"type":"managed"')
      }
      expect(yield* db.all(sql`SELECT name FROM data_migration WHERE name = 'managed-attachments-v1'`)).toHaveLength(1)
    }),
  )

  it.effect("leaves the marker absent when legacy payload migration fails", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const { db } = yield* Database.Service
      yield* db.run(sql`DELETE FROM data_migration WHERE name = 'managed-attachments-v1'`)
      yield* db.run("PRAGMA foreign_keys = OFF")
      yield* db.run(sql`
        INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
        VALUES ('msg_attachment_invalid', 'ses_attachment_migration', 'user',
          ${JSON.stringify({ text: "invalid", files: [{ data: "not-base64", mime: "image/png", source: { type: "inline" } }] })},
          'steer', 3, 0)
      `)
      yield* db.run("PRAGMA foreign_keys = ON")

      expect(yield* AttachmentStore.migrate(db, store).pipe(Effect.flip)).toMatchObject({
        _tag: "AttachmentStore.Error",
        reason: "migration",
      })
      expect(yield* db.all(sql`SELECT name FROM data_migration WHERE name = 'managed-attachments-v1'`)).toHaveLength(0)
      const rows = yield* db.all<{ data: unknown }>(sql`
        SELECT data FROM session_pending WHERE id = 'msg_attachment_invalid'
      `)
      expect(JSON.stringify(rows[0]?.data)).toContain("not-base64")
      yield* db.run(sql`DELETE FROM session_pending WHERE id = 'msg_attachment_invalid'`)
    }),
  )

  it.effect("reports malformed stored JSON as a retryable migration failure", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const { db } = yield* Database.Service
      yield* db.run(sql`DELETE FROM data_migration WHERE name = 'managed-attachments-v1'`)
      yield* db.run("PRAGMA foreign_keys = OFF")
      yield* db.run(sql`
        INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
        VALUES ('msg_attachment_invalid_json', 'ses_attachment_migration', 'user', '{', 'steer', 4, 0)
      `)
      yield* db.run("PRAGMA foreign_keys = ON")

      expect(yield* AttachmentStore.migrate(db, store).pipe(Effect.flip)).toMatchObject({
        _tag: "AttachmentStore.Error",
        reason: "migration",
      })
      expect(yield* db.all(sql`SELECT name FROM data_migration WHERE name = 'managed-attachments-v1'`)).toHaveLength(0)
      yield* db.run(sql`DELETE FROM session_pending WHERE id = 'msg_attachment_invalid_json'`)
    }),
  )

  it.effect("verifies already-managed rows before recording migration completion", () =>
    Effect.gen(function* () {
      const store = yield* AttachmentStore.Service
      const { db } = yield* Database.Service
      const digest = "f".repeat(64)
      const content = {
        type: "managed",
        digest,
        bytes: 1,
        path: `attachments/sha256/ff/${digest}`,
      }
      yield* db.run(sql`DELETE FROM data_migration WHERE name = 'managed-attachments-v1'`)
      yield* db.run("PRAGMA foreign_keys = OFF")
      yield* db.run(sql`
        INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
        VALUES ('msg_attachment_missing_managed', 'ses_attachment_migration', 'user',
          ${JSON.stringify({ text: "missing", files: [{ content, mime: "image/png" }] })}, 'steer', 5, 0)
      `)
      yield* db.run("PRAGMA foreign_keys = ON")

      expect(yield* AttachmentStore.migrate(db, store).pipe(Effect.flip)).toMatchObject({
        _tag: "AttachmentStore.Error",
        reason: "io",
      })
      expect(yield* db.all(sql`SELECT name FROM data_migration WHERE name = 'managed-attachments-v1'`)).toHaveLength(0)
    }),
  )
})
