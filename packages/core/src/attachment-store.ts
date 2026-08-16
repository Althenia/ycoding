export * as AttachmentStore from "./attachment-store"

import type { ManagedAttachmentContent } from "@ycoding-ai/schema/prompt"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { chmod, link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { DataMigrationTable } from "./data-migration.sql"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { Global } from "./global"
import { EventTable } from "./event/sql"
import { SessionMessageTable, SessionPendingTable } from "./session/sql"

const MIGRATION = "managed-attachments-v1"
const URI_PATTERN = /^ycoding-attachment:\/\/sha256\/([0-9a-f]{64})$/
export const MAX_BYTES = 20 * 1024 * 1024

export class Error extends Schema.TaggedErrorClass<Error>()("AttachmentStore.Error", {
  reason: Schema.Literals(["invalid-reference", "integrity", "io", "limit", "migration"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly import: (bytes: Uint8Array) => Effect.Effect<ManagedAttachmentContent, Error>
  readonly read: (content: ManagedAttachmentContent) => Effect.Effect<Uint8Array, Error>
  readonly resolveURI: (uri: string) => Effect.Effect<ManagedAttachmentContent, Error>
  readonly absolutePath: (content: ManagedAttachmentContent) => string
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/AttachmentStore") {}

export const managedURI = (content: Pick<ManagedAttachmentContent, "digest">) =>
  `ycoding-attachment://sha256/${content.digest}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const database = yield* Database.Service
    const store = make(global.data)
    yield* migrate(database.db, store)
    return Service.of(store)
  }).pipe(Effect.orDie),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, Database.node],
})

export function make(dataRoot: string): Interface {
  const root = path.resolve(dataRoot)
  const absolutePath = (content: ManagedAttachmentContent) => {
    if (!/^[0-9a-f]{64}$/.test(content.digest))
      throw new Error({ reason: "invalid-reference", message: "Invalid managed digest" })
    if (!Number.isInteger(content.bytes) || content.bytes < 0)
      throw new Error({ reason: "invalid-reference", message: "Invalid managed attachment size" })
    if (content.bytes > MAX_BYTES)
      throw new Error({ reason: "limit", message: `Attachment exceeds the ${MAX_BYTES} byte limit` })
    const expected = relativePath(content.digest)
    if (content.path !== expected) throw new Error({ reason: "invalid-reference", message: "Invalid managed path" })
    const target = path.resolve(root, content.path)
    if (!contains(root, target))
      throw new Error({ reason: "invalid-reference", message: "Managed path escapes the data directory" })
    return target
  }

  const read = Effect.fn("AttachmentStore.read")(function* (content: ManagedAttachmentContent) {
    const target = yield* Effect.try({
      try: () => absolutePath(content),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error({ reason: "invalid-reference", message: String(cause) }),
    })
    yield* verifyManagedFile(root, target)
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(target),
      catch: (cause) => new Error({ reason: "io", message: `Unable to read managed attachment: ${String(cause)}` }),
    })
    if (bytes.byteLength !== content.bytes || digest(bytes) !== content.digest)
      return yield* new Error({ reason: "integrity", message: "Managed attachment failed integrity verification" })
    return bytes
  })

  const importContent = Effect.fn("AttachmentStore.import")(function* (input: Uint8Array) {
    const bytes = Buffer.from(input)
    if (bytes.byteLength > MAX_BYTES)
      return yield* new Error({ reason: "limit", message: `Attachment exceeds the ${MAX_BYTES} byte limit` })
    const digestValue = digest(bytes)
    const content: ManagedAttachmentContent = {
      type: "managed",
      digest: digestValue,
      bytes: bytes.byteLength,
      path: relativePath(digestValue),
    }
    const target = absolutePath(content)
    const exists = yield* targetExists(target)
    if (exists) {
      yield* read(content)
      return content
    }
    const temporary = `${target}.${randomUUID()}.tmp`
    yield* Effect.tryPromise({
      try: async () => {
        await ensureManagedDirectory(root, path.dirname(target))
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
        await chmod(temporary, 0o600)
        try {
          await link(temporary, target)
        } catch (cause) {
          if (!alreadyExists(cause)) throw cause
        }
      },
      catch: (cause) => new Error({ reason: "io", message: `Unable to import managed attachment: ${String(cause)}` }),
    }).pipe(Effect.ensuring(Effect.promise(() => unlink(temporary).catch(() => undefined))))
    yield* read(content)
    return content
  })

  const resolveURI = Effect.fn("AttachmentStore.resolveURI")(function* (uri: string) {
    const digestValue = URI_PATTERN.exec(uri)?.[1]
    if (digestValue === undefined)
      return yield* new Error({ reason: "invalid-reference", message: "Invalid managed attachment URI" })
    const target = path.join(root, relativePath(digestValue))
    const content = {
      type: "managed" as const,
      digest: digestValue,
      bytes: 0,
      path: relativePath(digestValue),
    }
    yield* verifyManagedFile(root, target)
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(target),
      catch: (cause) => new Error({ reason: "io", message: `Unable to read managed attachment: ${String(cause)}` }),
    })
    const resolved = { ...content, bytes: bytes.byteLength }
    yield* read(resolved)
    return resolved
  })

  return { import: importContent, read, resolveURI, absolutePath }
}

type Row = { readonly id: string; readonly data: unknown }

export const migrate = Effect.fn("AttachmentStore.migrate")(function* (db: Database.Interface["db"], store: Interface) {
  const completed = yield* db
    .select({ name: DataMigrationTable.name })
    .from(DataMigrationTable)
    .where(sql`${DataMigrationTable.name} = ${MIGRATION}`)
    .get()
  if (completed !== undefined) return

  const events = yield* db.all<Row>(sql`
    SELECT id, data FROM event
    WHERE type = 'session.input.admitted.1'
  `)
  const pending = yield* db.all<Row>(sql`
    SELECT id, data FROM session_pending
    WHERE type = 'user'
  `)
  const messages = yield* db.all<Row>(sql`
    SELECT id, data FROM session_message
    WHERE type = 'user'
  `)
  const migratedEvents = yield* Effect.forEach(events, (row) => migrateEvent(row, store), { concurrency: 4 })
  const migratedPending = yield* Effect.forEach(pending, (row) => migrateData(row, store), { concurrency: 4 })
  const migratedMessages = yield* Effect.forEach(messages, (row) => migrateData(row, store), { concurrency: 4 })

  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      for (const row of migratedEvents)
        yield* tx
          .update(EventTable)
          .set({ data: row.data as (typeof EventTable.$inferInsert)["data"] })
          .where(sql`${EventTable.id} = ${row.id}`)
          .run()
      for (const row of migratedPending)
        yield* tx
          .update(SessionPendingTable)
          .set({ data: row.data as (typeof SessionPendingTable.$inferInsert)["data"] })
          .where(sql`${SessionPendingTable.id} = ${row.id}`)
          .run()
      for (const row of migratedMessages)
        yield* tx
          .update(SessionMessageTable)
          .set({ data: row.data as (typeof SessionMessageTable.$inferInsert)["data"] })
          .where(sql`${SessionMessageTable.id} = ${row.id}`)
          .run()
      yield* tx.run(sql`INSERT INTO data_migration (name, time_completed) VALUES (${MIGRATION}, ${Date.now()})`)
    }),
  )
})

function migrateEvent(row: Row, store: Interface) {
  return Effect.gen(function* () {
    const data = yield* storedRecord(row.data)
    const input = yield* requireRecord(data.input)
    if (input.type !== "user") return { id: row.id, data }
    return {
      id: row.id,
      data: {
        ...data,
        input: { ...input, data: yield* migrateAttachments(yield* requireRecord(input.data), store) },
      },
    }
  })
}

function migrateData(row: Row, store: Interface) {
  return Effect.gen(function* () {
    return { id: row.id, data: yield* migrateAttachments(yield* storedRecord(row.data), store) }
  })
}

function migrateAttachments(data: Record<string, unknown>, store: Interface) {
  return Effect.gen(function* () {
    if (data.files === undefined) return data
    if (!Array.isArray(data.files))
      return yield* new Error({ reason: "migration", message: "Legacy attachment files are not an array" })
    const files = yield* Effect.forEach(data.files, (value) => migrateAttachment(value, store), { concurrency: 4 })
    return { ...data, files }
  })
}

function migrateAttachment(value: unknown, store: Interface) {
  return Effect.gen(function* () {
    const file = yield* requireRecord(value)
    if (isManagedContent(file.content)) {
      yield* store.read(file.content)
      return file
    }
    if (typeof file.data !== "string" || typeof file.mime !== "string")
      return yield* new Error({ reason: "migration", message: "Unsupported durable attachment shape" })
    const bytes = yield* decodeBase64(file.data)
    return {
      content: yield* store.import(bytes),
      mime: file.mime,
      ...(typeof file.name === "string" ? { name: file.name } : {}),
      ...(typeof file.description === "string" ? { description: file.description } : {}),
      ...(file.mention === undefined ? {} : { mention: file.mention }),
    }
  })
}

function decodeBase64(value: string) {
  return Effect.try({
    try: () => {
      const bytes = Buffer.from(value, "base64")
      if (bytes.toString("base64") !== value) throw new TypeError("Non-canonical base64")
      return bytes
    },
    catch: () => new Error({ reason: "migration", message: "Invalid durable attachment base64" }),
  })
}

function isManagedContent(value: unknown): value is ManagedAttachmentContent {
  if (typeof value !== "object" || value === null) return false
  const content = value as Record<string, unknown>
  return (
    content.type === "managed" &&
    typeof content.digest === "string" &&
    /^[0-9a-f]{64}$/.test(content.digest) &&
    typeof content.bytes === "number" &&
    Number.isInteger(content.bytes) &&
    content.bytes >= 0 &&
    content.path === relativePath(content.digest)
  )
}

function storedJSON(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    throw new Error({ reason: "migration", message: "Invalid stored attachment JSON" })
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new Error({ reason: "migration", message: "Invalid stored attachment record" })
}

function storedRecord(value: unknown) {
  return Effect.try({
    try: () => record(storedJSON(value)),
    catch: migrationError,
  })
}

function requireRecord(value: unknown) {
  return Effect.try({
    try: () => record(value),
    catch: migrationError,
  })
}

function migrationError(cause: unknown) {
  return cause instanceof Error
    ? cause
    : new Error({ reason: "migration", message: `Invalid stored attachment data: ${String(cause)}` })
}

function relativePath(value: string) {
  return `attachments/sha256/${value.slice(0, 2)}/${value}`
}

function contains(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function within(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function targetExists(target: string) {
  return Effect.tryPromise({
    try: () =>
      lstat(target).then(
        () => true,
        (cause) => {
          if (notFound(cause)) return false
          throw cause
        },
      ),
    catch: (cause) => new Error({ reason: "io", message: `Unable to inspect managed attachment: ${String(cause)}` }),
  })
}

function verifyManagedFile(root: string, target: string) {
  return Effect.tryPromise({
    try: async () => {
      const info = await lstat(target)
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error({ reason: "invalid-reference", message: "Managed attachment is not a regular file" })
      if (info.size > MAX_BYTES)
        throw new Error({ reason: "limit", message: `Attachment exceeds the ${MAX_BYTES} byte limit` })
      const canonicalRoot = await realpath(root)
      const canonicalTarget = await realpath(target)
      if (!contains(canonicalRoot, canonicalTarget))
        throw new Error({ reason: "invalid-reference", message: "Managed attachment escapes the data directory" })
      await inspectManagedDirectory(root, path.dirname(target))
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error({ reason: "io", message: `Unable to verify managed attachment: ${String(cause)}` }),
  })
}

async function inspectManagedDirectory(root: string, directory: string) {
  if (!within(root, directory))
    throw new Error({ reason: "invalid-reference", message: "Managed attachment directory escapes the data directory" })
  const entries = await Promise.all(managedDirectories(root, directory).map((value) => lstat(value)))
  if (entries.some((info) => info.isSymbolicLink() || !info.isDirectory()))
    throw new Error({ reason: "invalid-reference", message: "Managed attachment directory is not trusted" })
  if (!within(await realpath(root), await realpath(directory)))
    throw new Error({ reason: "invalid-reference", message: "Managed attachment directory escapes the data directory" })
}

async function ensureManagedDirectory(root: string, directory: string) {
  if (!within(root, directory))
    throw new Error({ reason: "invalid-reference", message: "Managed attachment directory escapes the data directory" })
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const value of managedDirectories(root, directory)) {
    await mkdir(value, { mode: 0o700 }).catch((cause) => {
      if (!alreadyExists(cause)) throw cause
    })
    const info = await lstat(value)
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error({ reason: "invalid-reference", message: "Managed attachment directory is not trusted" })
  }
  if (!within(await realpath(root), await realpath(directory)))
    throw new Error({ reason: "invalid-reference", message: "Managed attachment directory escapes the data directory" })
}

function managedDirectories(root: string, directory: string) {
  const relative = path.relative(root, directory)
  const segments = relative === "" ? [] : relative.split(path.sep)
  return segments.map((_, index) => path.join(root, ...segments.slice(0, index + 1)))
}

function notFound(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
}

function alreadyExists(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST"
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
