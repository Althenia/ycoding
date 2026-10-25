export * as AccountConnectorLibrary from "./library"

import { Effect, Schema } from "effect"
import { AttachmentStore } from "../attachment-store"
import type { Permission } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "../tool/tool"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:~-]{1,512}$/))
const Name = Schema.String.check(Schema.isPattern(/^[^/\\\r\n]{1,255}$/))
const Mime = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/))
const Item = Schema.Struct({
  id: ID,
  file_id: Schema.NullOr(Schema.String).pipe(Schema.optional),
  file_name: Schema.String,
  file_size_bytes: Schema.NullOr(Schema.Number).pipe(Schema.optional),
  mime_type: Schema.NullOr(Schema.String).pipe(Schema.optional),
  state: Schema.String.pipe(Schema.optional),
})
const Page = Schema.Struct({ items: Schema.Array(Item), cursor: Schema.NullOr(Schema.String).pipe(Schema.optional) })
const Materialized = Schema.Struct({ file_id: ID })
const Download = Schema.Struct({ download_url: Schema.String })
const Created = Schema.Struct({
  file_id: ID,
  upload_url: Schema.String,
  upload_headers: Schema.NullOr(Schema.Record(Schema.String, Schema.String)).pipe(Schema.optional),
})
const Event = Schema.Struct({
  event: Schema.String,
  file_id: Schema.String.pipe(Schema.optional),
  extra: Schema.NullOr(
    Schema.Struct({
      metadata_object_id: ID.pipe(Schema.optional),
      library_file_name: Schema.String.pipe(Schema.optional),
      library_persistence_result: Schema.String.pipe(Schema.optional),
    }),
  ).pipe(Schema.optional),
})

export function make(input: {
  readonly attachments: AttachmentStore.Interface
  readonly permission: Pick<Permission.Interface, "assert">
  readonly guardrail: Pick<SessionGuardrail.Interface, "assert">
  readonly current: () => Effect.Effect<unknown, Error>
  readonly request: (route: string, init?: RequestInit) => Effect.Effect<Response, Error>
  readonly fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>
}) {
  const json = <A, I>(route: string, schema: Schema.Codec<A, I>, body?: unknown) =>
    input.request(route, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }).pipe(
      Effect.flatMap((response) => readBytes(response, 2 * 1024 * 1024)),
      Effect.flatMap((bytes) =>
        Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(new TextDecoder().decode(bytes)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError(
            () =>
              new Error(
                body !== undefined && route !== "/files/library"
                  ? "ChatGPT Library returned an invalid response; write outcome is uncertain, do not retry"
                  : "ChatGPT Library returned an invalid response",
              ),
          ),
        ),
      ),
    )
  const run = <A>(operation: string, resource: string, context: Tool.Context, work: Effect.Effect<A, Error>) =>
    Effect.gen(function* () {
      yield* input.current()
      yield* input.permission.assert({
        action: `chatgpt_library_${operation}`,
        resources: [resource],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, callID: context.callID },
        metadata: { connectorLabel: "ChatGPT Library", operation },
      })
      yield* input.current()
      const reservation = yield* input.guardrail.assert({
        action: "mcp_execute",
        resources: [`chatgpt/library/${operation}`],
        sessionID: context.sessionID,
        source: { messageID: context.messageID, callID: context.callID },
      })
      return yield* work.pipe(Effect.ensuring(reservation.release))
    }).pipe(
      Effect.mapError((error) => new Tool.Failure({ message: SessionGuardrail.reviewMessage(error) ?? error.message })),
    )
  const transfer = (url: string, init?: RequestInit) =>
    Effect.gen(function* () {
      const target = yield* Effect.try({
        try: () => signedURL(url),
        catch: () => new Error("ChatGPT Library returned an unsupported file destination"),
      })
      yield* input.current()
      const response = yield* Effect.tryPromise({
        try: (signal) => (input.fetch ?? fetch)(target, { ...init, signal, redirect: "error" }),
        catch: () => new Error("ChatGPT Library file transfer failed; do not retry an uncertain upload"),
      })
      yield* input.current().pipe(
        Effect.onError(() =>
          Effect.promise(async () => {
            await response.body?.cancel()
          }),
        ),
      )
      if (!response.ok) {
        yield* Effect.promise(async () => {
          await response.body?.cancel()
        })
        return yield* Effect.fail(new Error(`ChatGPT Library file transfer rejected (HTTP ${response.status})`))
      }
      return response
    })
  const tools = {
    chatgpt_library_list: Tool.withPermission(
      Tool.make({
        description:
          "List one page of ChatGPT Library files for the selected account. Return the opaque cursor unchanged to continue, including after an empty page.",
        input: Schema.Struct({
          cursor: Schema.String.check(Schema.isMaxLength(4096)).pipe(Schema.optional),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.optional),
          query: Schema.String.check(Schema.isMaxLength(1024)).pipe(Schema.optional),
        }),
        output: Page,
        execute: (args, context) =>
          run(
            "list",
            "library",
            context,
            json("/files/library", Page, {
              limit: args.limit ?? 25,
              cursor: args.cursor ?? null,
              state: "ready",
              q: args.query || null,
            }).pipe(Effect.map((page) => ({ ...page, cursor: page.cursor ?? null }))),
          ),
      }),
      "chatgpt_library_list",
    ),
    chatgpt_library_materialize: Tool.withPermission(
      Tool.make({
        description:
          "Materialize one mounted external ChatGPT Library file. This may create a file copy in the selected account. Does not index it for retrieval.",
        input: Schema.Struct({
          fileID: Schema.String.check(Schema.isPattern(/^external-[A-Za-z0-9:%._~-]{1,1000}$/)),
          name: Name,
          mimeType: Mime.pipe(Schema.optional),
        }),
        output: Schema.Struct({ fileID: ID }),
        execute: (args, context) =>
          run(
            "materialize",
            args.fileID,
            context,
            json("/files/library/mounted/materialize", Materialized, {
              file_id: args.fileID,
              name: args.name,
              mime_type: args.mimeType ?? null,
              index_for_retrieval: false,
            }).pipe(Effect.map((value) => ({ fileID: value.file_id }))),
          ),
      }),
      "chatgpt_library_materialize",
    ),
    chatgpt_library_download: Tool.withPermission(
      Tool.make({
        description:
          "Download a ChatGPT Library file into verified managed attachment storage, at most 20 MiB. Returns a managed local path and attachment URI, never a signed URL or caller-selected path.",
        input: Schema.Struct({ fileID: ID }),
        output: Schema.Struct({ attachmentURI: Schema.String, path: Schema.String, bytes: Schema.Number }),
        execute: (args, context) =>
          run(
            "download",
            args.fileID,
            context,
            Effect.gen(function* () {
              const value = yield* json(
                `/files/library/files/${encodeURIComponent(args.fileID)}/download_url`,
                Download,
              )
              const route = nativeFileRoute(value.download_url)
              const response = yield* route === undefined ? transfer(value.download_url) : input.request(route)
              const bytes = yield* readBytes(response, AttachmentStore.MAX_BYTES)
              yield* input.current()
              const content = yield* input.attachments.import(bytes)
              return {
                attachmentURI: AttachmentStore.managedURI(content),
                path: input.attachments.absolutePath(content),
                bytes: content.bytes,
              }
            }),
          ),
      }),
      "chatgpt_library_download",
    ),
    chatgpt_library_upload: Tool.withPermission(
      Tool.make({
        description:
          "Upload a verified managed attachment, at most 20 MiB, to the selected ChatGPT Library. Creates one new Library file; never retries an uncertain write. Requires an existing managed attachment URI, filename, and MIME type.",
        input: Schema.Struct({
          attachmentURI: Schema.String.check(Schema.isPattern(/^ycoding-attachment:\/\/sha256\/[a-f0-9]{64}$/)),
          name: Name,
          mimeType: Mime,
        }),
        output: Schema.Struct({ fileID: ID, libraryFileID: ID, name: Schema.String }),
        execute: (args, context) =>
          run(
            "upload",
            args.name,
            context,
            Effect.gen(function* () {
              const content = yield* input.attachments.resolveURI(args.attachmentURI)
              const bytes = yield* input.attachments.read(content)
              if (bytes.byteLength === 0)
                return yield* Effect.fail(new Error("ChatGPT Library upload requires a nonempty attachment"))
              const created = yield* json("/files", Created, {
                entry_surface: "codex_library_upload",
                file_name: args.name,
                file_size: bytes.byteLength,
                client_resolved_mime_type: args.mimeType,
                mime_resolution_source: "declared_mime",
                mime_type: args.mimeType,
                reset_rate_limits: false,
                supports_direct_azure_multipart: false,
                timezone_offset_min: new Date().getTimezoneOffset(),
                upload_source: "codex_library_upload",
                use_case: "my_files",
                store_in_library: true,
                library_persistence_mode: "opportunistic",
              })
              const aws =
                URL.canParse(created.upload_url, "https://chatgpt.com") &&
                [...new URL(created.upload_url, "https://chatgpt.com").searchParams.keys()].some(
                  (key) => key.toLowerCase() === "x-amz-algorithm",
                )
              const headers = new Headers({
                "Content-Type": args.mimeType,
                ...(aws
                  ? {}
                  : {
                      "x-ms-blob-type": "BlockBlob",
                      "x-ms-version": "2020-04-08",
                      "x-ms-blob-content-type": args.mimeType,
                    }),
              })
              for (const [name, value] of Object.entries(created.upload_headers ?? {})) {
                if (!/^(content-type|x-ms-[a-z0-9-]+|x-amz-[a-z0-9-]+)$/i.test(name))
                  return yield* Effect.fail(new Error("ChatGPT Library returned unsupported upload headers"))
                headers.set(name, value)
              }
              const route = nativeFileRoute(created.upload_url)
              const uploaded = yield* route?.startsWith("/estuary/upload_content_bytes")
                ? Effect.gen(function* () {
                    const url = new URL(created.upload_url, "https://chatgpt.com")
                    const target = url.searchParams.get("upload_url")
                    if (!target)
                      return yield* Effect.fail(new Error("ChatGPT Library upload is missing its signed destination"))
                    yield* Effect.try({
                      try: () => signedURL(target),
                      catch: () => new Error("ChatGPT Library returned an unsupported file destination"),
                    })
                    const form = new FormData()
                    form.append("file", new Blob([Uint8Array.from(bytes)], { type: args.mimeType }), args.name)
                    form.append("upload_url", target)
                    return yield* input.request(route, { method: "POST", body: form })
                  })
                : transfer(created.upload_url, { method: "PUT", headers, body: Uint8Array.from(bytes) })
              yield* Effect.promise(async () => {
                await uploaded.body?.cancel()
              })
              const response = yield* input.request("/files/process_upload_stream", {
                method: "POST",
                body: JSON.stringify({
                  entry_surface: "codex_library_upload",
                  file_id: created.file_id,
                  file_name: args.name,
                  index_for_retrieval: true,
                  library_persistence_mode: "opportunistic",
                  metadata: { store_in_library: true },
                  mime_type: args.mimeType,
                  upload_source: "codex_library_upload",
                  use_case: "my_files",
                }),
              })
              const events = yield* readBytes(response, 2 * 1024 * 1024).pipe(
                Effect.flatMap((bytes) =>
                  Effect.forEach(
                    new TextDecoder()
                      .decode(bytes)
                      .split(/\r?\n/)
                      .filter((line) => line.trim()),
                    (line) =>
                      Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(line).pipe(
                        Effect.flatMap(Schema.decodeUnknownEffect(Event)),
                      ),
                  ),
                ),
                Effect.mapError(
                  () => new Error("ChatGPT Library upload completion could not be verified; do not retry"),
                ),
              )
              const own = events.filter((event) => event.file_id === created.file_id)
              if (
                events.some((event) => /(?:error|failed|cancelled)$/.test(event.event)) ||
                own.some((event) => event.extra?.library_persistence_result === "temporary")
              )
                return yield* Effect.fail(
                  new Error("ChatGPT Library upload failed to persist; do not retry an uncertain write"),
                )
              const ready = own.find((event) => event.extra?.metadata_object_id !== undefined)
              if (
                !own.some((event) => event.event === "file.processing.completed") ||
                !ready?.extra?.metadata_object_id
              )
                return yield* Effect.fail(
                  new Error("ChatGPT Library upload completion could not be verified; do not retry"),
                )
              yield* input.current()
              return {
                fileID: created.file_id,
                libraryFileID: ready.extra.metadata_object_id,
                name: ready.extra.library_file_name ?? args.name,
              }
            }),
          ),
      }),
      "chatgpt_library_upload",
    ),
  }
  return {
    tools,
    options: {
      paths: Object.fromEntries(
        Object.keys(tools).map((name) => [name, name.replace("chatgpt_library_", "chatgpt.library.")]),
      ),
    },
  }
}

function signedURL(value: string) {
  if (!URL.canParse(value)) throw new Error("ChatGPT Library returned an unsupported file destination")
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    ![".blob.core.windows.net", ".s3.amazonaws.com", ".oaiusercontent.com"].some((suffix) =>
      url.hostname.endsWith(suffix),
    )
  )
    throw new Error("ChatGPT Library returned an unsupported file destination")
  return url
}

function nativeFileRoute(value: string) {
  if (!URL.canParse(value, "https://chatgpt.com")) return undefined
  const url = new URL(value, "https://chatgpt.com")
  if (url.origin !== "https://chatgpt.com" || url.username || url.password || url.hash) return undefined
  const pathname = url.pathname.replace(/^\/backend-api(?=\/)/, "")
  if (!["/estuary/upload_content_bytes", "/estuary/content", "/files/library/content_download"].includes(pathname))
    return undefined
  return pathname + url.search
}

function readBytes(response: Response, maximum: number) {
  return Effect.tryPromise({
    try: async (signal) => {
      const reader = response.body?.getReader()
      if (!reader) throw new Error("ChatGPT Library response has no body")
      const chunks: Uint8Array[] = []
      let size = 0
      const abort = () => {
        void reader.cancel().catch(() => undefined)
      }
      signal.addEventListener("abort", abort, { once: true })
      try {
        signal.throwIfAborted()
        if (!response.ok) throw new Error(`ChatGPT Library request rejected (HTTP ${response.status})`)
        if (Number(response.headers.get("content-length")) > maximum)
          throw new Error("ChatGPT Library response exceeds the managed size limit")
        while (true) {
          const next = await reader.read()
          signal.throwIfAborted()
          if (next.done) break
          size += next.value.byteLength
          if (size > maximum) throw new Error("ChatGPT Library response exceeds the managed size limit")
          chunks.push(next.value)
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return bytes
      } finally {
        signal.removeEventListener("abort", abort)
        await reader.cancel()
        reader.releaseLock()
      }
    },
    catch: () => new Error("ChatGPT Library response could not be read within its size limit"),
  })
}
