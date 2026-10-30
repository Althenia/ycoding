import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { ManagedAttachmentContent } from "@ycoding-ai/schema/prompt"
import type { CcaLibraryFactory, CcaLibraryProcess } from "../cca/library"
import type { CcaAuthorization } from "../cca/authorization"
import { AttachmentStore } from "../attachment-store"
import { Hash } from "../util/hash"
import { detect } from "../mime"
import { AccountConnectorLibrary } from "./library"

const namePattern = /^[^/\\\r\n]{1,255}$/
const mimePattern = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/
const Name = Schema.String.check(Schema.isPattern(namePattern))
const Mime = Schema.String.check(Schema.isPattern(mimePattern))
const Bytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AttachmentStore.MAX_BYTES }))
const Item = Schema.Struct({
  workspace_path: Schema.String.check(Schema.isMinLength(1)),
  file_name: Name,
  purpose: Schema.Literal("create_library_file"),
  file_size_bytes: Bytes,
  mime_type: Mime.pipe(Schema.optional),
})
const Echo = Schema.Struct({
  upload_session_id: Schema.String.check(Schema.isMinLength(1)),
  file_id: Schema.String,
  workspace_path: Schema.String,
  file_name: Name,
  purpose: Schema.Literal("create_library_file"),
  store_in_library: Schema.Literal(true),
  mime_type: Mime,
  file_size_bytes: Bytes,
})
const Prepare = Schema.Struct({ uploads: Schema.Array(Item).check(Schema.isMinLength(1), Schema.isMaxLength(1)) })
const Finalize = Schema.Struct({ uploads: Schema.Array(Echo).check(Schema.isMinLength(1), Schema.isMaxLength(1)) })
type Receipt = {
  results: {
    operation: "create_library_file"
    status: "succeeded"
    file_id: string
    library_file_id: string
    file_name: string
  }[]
}
const ttl = 300_000

class InvalidFinalization extends Error {
  constructor() {
    super(
      "Unsupported or changed Library finalize fields; the upload is unfinalized, not delivered. Do not retry this reservation.",
    )
  }
}

function suppliedToken(args: unknown) {
  if (
    typeof args !== "object" ||
    args === null ||
    !("uploads" in args) ||
    !Array.isArray(args.uploads) ||
    args.uploads.length !== 1
  )
    return undefined
  const item: unknown = args.uploads[0]
  return typeof item === "object" &&
    item !== null &&
    "upload_session_id" in item &&
    typeof item.upload_session_id === "string"
    ? item.upload_session_id
    : undefined
}

const tool = (name: string, inputSchema: CcaLibraryProcess["tools"][number]["inputSchema"]) => ({
  name,
  description:
    "YCoding private Library bridge. Supports one create_library_file upload using the process's authorized local file. No replacement, shared, directory, version or artifact-type operations.",
  inputSchema,
  _meta: { connector_id: "connector_openai_library", connector_name: "YCoding Library bridge" },
})
const fileProperties = {
  workspace_path: { type: "string", minLength: 1 },
  file_name: { type: "string", minLength: 1, maxLength: 255, pattern: namePattern.source },
  purpose: { const: "create_library_file", type: "string" },
  file_size_bytes: { type: "integer", minimum: 1, maximum: AttachmentStore.MAX_BYTES },
  mime_type: { type: "string", pattern: mimePattern.source },
}
const tools: CcaLibraryProcess["tools"] = [
  tool("ycoding_library.prepare_uploads", {
    type: "object",
    additionalProperties: false,
    required: ["uploads"],
    properties: {
      uploads: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: fileProperties,
          required: ["workspace_path", "file_name", "purpose", "file_size_bytes"],
        },
      },
    },
  }),
  tool("ycoding_library.finalize_uploads", {
    type: "object",
    additionalProperties: false,
    required: ["uploads"],
    properties: {
      uploads: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...fileProperties,
            upload_session_id: { type: "string" },
            file_id: { type: "string" },
            store_in_library: { const: true, type: "boolean" },
          },
          required: [...Object.keys(fileProperties), "upload_session_id", "file_id", "store_in_library"],
        },
      },
    },
  }),
]

function decode<A, I>(schema: Schema.Codec<A, I>, args: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema)(args, { onExcessProperty: "error" })
  } catch {
    throw new Error(
      "Unsupported private Library input: exactly one create_library_file item with the advertised fields is required",
    )
  }
}

export function createLibraryFactory(options: {
  readonly attachments: AttachmentStore.Interface
  readonly files: ReturnType<typeof AccountConnectorLibrary.nativeFiles>
  readonly check: () => Promise<void>
  readonly authorization: Pick<CcaAuthorization, "authorize">
  readonly identity?: string
  readonly now?: () => number
  readonly schedule?: (callback: () => void, milliseconds: number) => () => void
}): CcaLibraryFactory {
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((callback: () => void, milliseconds: number) => {
      const timer = setTimeout(callback, milliseconds)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  return {
    open: async (owner) => {
      await options.check()
      const nonce = randomUUID()
      const lifetime = new AbortController()
      const grants = new Set<() => Promise<void>>()
      let closed = false
      let busy = false
      let unknown = false
      let expires = 0
      let cancelTimer: (() => void) | undefined
      let closing: Promise<void> | undefined
      let active: { key: string; echo: typeof Echo.Type; content: ManagedAttachmentContent } | undefined
      let completed: { key: string; echo: typeof Echo.Type; reply: Receipt } | undefined
      const release = async () => {
        const held = [...grants]
        grants.clear()
        const settled = await Promise.allSettled(held.map((drop) => drop()))
        if (settled.some((item) => item.status === "rejected"))
          throw new Error("Private Library authorization cleanup failed")
      }
      const stopTimer = () => {
        cancelTimer?.()
        cancelTimer = undefined
      }
      const close = () => {
        if (closing) return closing
        closed = true
        lifetime.abort()
        stopTimer()
        active = undefined
        completed = undefined
        closing = release()
        return closing
      }
      const check = async () => {
        if (closed) throw new Error("Private Library process is closed")
        if (expires !== 0 && now() >= expires) {
          await close()
          throw new Error("Private Library reservation expired; earlier writes may have succeeded, do not retry")
        }
        try {
          await options.check()
        } catch {
          await close()
          throw new Error("Private Library scope or principal is retired")
        }
        if (closed) throw new Error("Private Library process is closed")
      }
      const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect, { signal: lifetime.signal })
      const read = async (file: string, expected: number) => {
        await check()
        const value = await owner.readFile(file)
        await check()
        if (
          !path.isAbsolute(value.canonical) ||
          value.bytes.byteLength !== expected ||
          value.bytes.byteLength === 0 ||
          value.bytes.byteLength > AttachmentStore.MAX_BYTES
        )
          throw new Error("Private Library source size or canonical path does not match the requested file")
        return { canonical: value.canonical, bytes: Uint8Array.from(value.bytes) }
      }
      const call = async (name: string, args: unknown): Promise<unknown> => {
        await check()
        if (unknown) throw AccountConnectorLibrary.uncertainWrite()
        if (busy) throw new Error("Private Library operation is already running; do not start another write")
        if (name !== "ycoding_library.prepare_uploads" && name !== "ycoding_library.finalize_uploads")
          throw new Error("Unsupported private Library tool")
        busy = true
        let dispatched = false
        let finalizing = false
        let createdFile = false
        try {
          if (name === "ycoding_library.prepare_uploads") {
            const item = decode(Prepare, args).uploads[0]!
            if (!path.isAbsolute(item.workspace_path) || path.basename(item.workspace_path) !== item.file_name)
              throw new Error("Private Library prepare requires the original absolute file path and basename")
            const source = await read(item.workspace_path, item.file_size_bytes)
            const content = await run(options.attachments.import(source.bytes))
            await check()
            const key = Hash.json({
              item,
              digest: content.digest,
              scope: options.identity,
              nonce,
              processID: owner.processID,
              cwd: owner.cwd,
            })
            if (active) {
              if (active.key !== key)
                throw new Error("Private Library supports one outstanding reservation per process")
              return { uploads: [structuredClone(active.echo)] }
            }
            if (completed?.key === key) return { uploads: [structuredClone(completed.echo)] }
            const grant = await options.authorization.authorize({
              action: "chatgpt_library_upload",
              guardrailAction: "mcp_execute",
              resources: [item.file_name],
              metadata: { operationDigest: key, connectorLabel: "YCoding Library bridge" },
            })
            if (closed) {
              await grant.release()
              throw new Error("Private Library process is closed")
            }
            grants.add(grant.release)
            await check()
            stopTimer()
            completed = undefined
            expires = now() + ttl
            cancelTimer = schedule(() => {
              void close().catch(() => undefined)
            }, ttl)
            const upload = { name: item.file_name, mimeType: item.mime_type ?? detect(source.bytes) }
            const created = await run(
              options.files.create(upload, content.bytes, () => {
                dispatched = true
              }),
            )
            createdFile = true
            await check()
            await run(
              options.files.transfer(created, upload, source.bytes, () => {
                dispatched = true
              }),
            )
            await check()
            const echo = {
              upload_session_id: randomUUID(),
              file_id: created.file_id,
              file_name: item.file_name,
              workspace_path: source.canonical,
              purpose: "create_library_file" as const,
              store_in_library: true as const,
              mime_type: upload.mimeType,
              file_size_bytes: content.bytes,
            }
            active = { key, echo, content }
            completed = undefined
            return { uploads: [structuredClone(echo)] }
          }
          let echo: typeof Echo.Type
          try {
            echo = decode(Finalize, args).uploads[0]!
          } catch (error) {
            if (active && suppliedToken(args) === active.echo.upload_session_id) {
              finalizing = true
              throw new InvalidFinalization()
            }
            throw error
          }
          if (completed && Hash.json(echo) === Hash.json(completed.echo)) return structuredClone(completed.reply)
          const reservation = active
          if (!reservation || echo.upload_session_id !== reservation.echo.upload_session_id)
            throw new Error("Private Library reservation does not belong to this process")
          finalizing = true
          if (Hash.json(echo) !== Hash.json(reservation.echo)) throw new InvalidFinalization()
          const source = await read(echo.workspace_path, echo.file_size_bytes)
          const stored = await run(options.attachments.read(reservation.content))
          await check()
          if (
            Hash.sha256(Buffer.from(source.bytes)) !== reservation.content.digest ||
            Hash.sha256(Buffer.from(stored)) !== reservation.content.digest
          )
            throw new Error("Private Library source snapshot changed; do not retry")
          active = undefined
          const value = await run(
            options.files.finalize(echo.file_id, { name: echo.file_name, mimeType: echo.mime_type }, () => {
              dispatched = true
            }),
          )
          await check()
          const reply: Receipt = {
            results: [
              {
                operation: "create_library_file",
                status: "succeeded",
                file_id: value.fileID,
                library_file_id: value.libraryFileID,
                file_name: value.name,
              },
            ],
          }
          await release()
          await check()
          completed = { key: reservation.key, echo: reservation.echo, reply }
          return structuredClone(reply)
        } catch (error) {
          if (
            !createdFile &&
            !finalizing &&
            error instanceof AccountConnectorLibrary.RequestRejected &&
            (error.status === 401 || error.status === 403)
          ) {
            stopTimer()
            expires = 0
            await release()
            throw error
          }
          if (dispatched || finalizing) {
            unknown = true
            active = undefined
            completed = undefined
            await release()
            throw error instanceof InvalidFinalization ? error : AccountConnectorLibrary.uncertainWrite()
          }
          if (!active && !completed) {
            stopTimer()
            expires = 0
          }
          if (!active) await release()
          throw error
        } finally {
          busy = false
        }
      }
      return { check, tools, call, close }
    },
  }
}
