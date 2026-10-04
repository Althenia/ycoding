import { afterAll, expect } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { FileAttachment } from "@ycoding-ai/schema/prompt"
import { testEffect } from "./lib/effect"

const root = await mkdtemp(path.join(tmpdir(), "ycoding-attachment-read-"))
afterAll(() => rm(root, { recursive: true, force: true }))
const store = AttachmentStore.make(root)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Session.node]), [
  [SessionExecution.node, SessionExecution.noopLayer],
  [AttachmentStore.node, Layer.succeed(AttachmentStore.Service, store)],
]))
const sessionID = Session.ID.make("ses_attachment_owner")

it.effect("reads only this Session's managed user files and bounds missing, invalid and oversized references", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Attachment owner" }).run()
    const bytes = Buffer.from("image bytes")
    const content = yield* store.import(bytes)
    const other = yield* store.import(Buffer.from("unreferenced bytes"))
    const missingDigest = createHash("sha256").update("missing bytes").digest("hex")
    const invalidPathDigest = "e".repeat(64)
    const oversizedDigest = "f".repeat(64)
    const files = [
      FileAttachment.create({ content, mime: "image/png", name: "capture.png" }),
      FileAttachment.create({ content: { type: "managed", digest: missingDigest, bytes: 13, path: `attachments/sha256/${missingDigest.slice(0, 2)}/${missingDigest}` }, mime: "image/png" }),
      FileAttachment.create({ content: { type: "managed", digest: invalidPathDigest, bytes: 3, path: `attachments/sha256/ff/${invalidPathDigest}` }, mime: "image/png" }),
      FileAttachment.create({ content: { type: "managed", digest: oversizedDigest, bytes: 11 * 1024 * 1024, path: `attachments/sha256/${oversizedDigest.slice(0, 2)}/${oversizedDigest}` }, mime: "image/png" }),
    ]
    const { id: _, type, ...data } = Schema.encodeSync(SessionMessage.Info)(SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_attachment_owner"), type: "user", text: "See image", files, time: { created: DateTime.makeUnsafe(1) },
    }))
    yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make("msg_attachment_owner"), session_id: sessionID, type, seq: 1, time_created: 1, data }).run()
    const otherSession = Session.ID.make("ses_attachment_other")
    yield* db.insert(SessionTable).values({ id: otherSession, project_id: Project.ID.global, directory: "/project", title: "Other Session" }).run()
    const { id: _other, type: otherType, ...otherData } = Schema.encodeSync(SessionMessage.Info)(SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_attachment_other"), type: "user", text: "Other image",
      files: [FileAttachment.create({ content: other, mime: "image/png" })], time: { created: DateTime.makeUnsafe(2) },
    }))
    yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make("msg_attachment_other"), session_id: otherSession, type: otherType, seq: 1, time_created: 2, data: otherData }).run()
    const sessions = yield* Session.Service
    expect(yield* sessions.attachmentRead(sessionID, content.digest)).toEqual({ mime: "image/png", bytes: bytes.byteLength, data: bytes.toString("base64") })
    expect(yield* Effect.flip(sessions.attachmentRead(sessionID, other.digest))).toMatchObject({ _tag: "Session.AttachmentReadError", reason: "not-found" })
    expect((yield* sessions.attachmentRead(otherSession, other.digest)).bytes).toBe(Buffer.byteLength("unreferenced bytes"))
    expect(yield* Effect.flip(sessions.attachmentRead(sessionID, "../missing"))).toMatchObject({ _tag: "Session.AttachmentReadError", reason: "invalid" })
    expect(yield* Effect.flip(sessions.attachmentRead(sessionID, missingDigest))).toMatchObject({ _tag: "Session.AttachmentReadError", reason: "not-found" })
    expect(yield* Effect.flip(sessions.attachmentRead(sessionID, invalidPathDigest))).toMatchObject({ _tag: "Session.AttachmentReadError", reason: "not-found" })
    expect(yield* Effect.flip(sessions.attachmentRead(sessionID, oversizedDigest))).toMatchObject({ _tag: "Session.AttachmentReadError", reason: "too-large" })
    yield* Effect.promise(() => chmod(path.join(root, content.path), 0o600))
    yield* Effect.promise(() => writeFile(path.join(root, content.path), Buffer.from("broken data")))
    expect(yield* Effect.flip(sessions.attachmentRead(sessionID, content.digest))).toMatchObject({ _tag: "Session.AttachmentReadError", reason: "not-found" })
    yield* Effect.promise(() => writeFile(path.join(root, content.path), Buffer.alloc(AttachmentStore.MAX_BYTES + 1)))
    expect(yield* Effect.flip(sessions.attachmentRead(sessionID, content.digest))).toMatchObject({ _tag: "Session.AttachmentReadError", reason: "not-found" })
  }),
)

it.effect("reads managed files of an admitted prompt before promotion, only within its Session", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run()
    const pendingSession = Session.ID.make("ses_attachment_pending")
    const bystander = Session.ID.make("ses_attachment_bystander")
    yield* db.insert(SessionTable).values([
      { id: pendingSession, project_id: Project.ID.global, directory: "/project", title: "Pending attachment" },
      { id: bystander, project_id: Project.ID.global, directory: "/project", title: "Bystander" },
    ]).run()
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
    const content = yield* store.import(bytes)
    const sessions = yield* Session.Service
    yield* sessions.prompt({
      sessionID: pendingSession,
      text: "See the pending image",
      files: [{ uri: `ycoding-attachment://sha256/${content.digest}`, name: "pending.png" }],
      resume: false,
    })
    expect(yield* sessions.attachmentRead(pendingSession, content.digest)).toEqual({ mime: "image/png", bytes: bytes.byteLength, data: bytes.toString("base64") })
    expect(yield* Effect.flip(sessions.attachmentRead(bystander, content.digest))).toMatchObject({ _tag: "Session.AttachmentReadError", reason: "not-found" })
  }),
)
