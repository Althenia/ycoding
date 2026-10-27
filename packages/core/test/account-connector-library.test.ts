import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AccountConnectorLibrary } from "../src/account-connectors/library"
import { AttachmentStore } from "../src/attachment-store"
import { Agent } from "../src/agent"
import type { Permission } from "../src/permission"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { Tool } from "../src/tool/tool"

const root = await mkdtemp(path.join(tmpdir(), "ycoding-library-"))
afterAll(() => rm(root, { recursive: true, force: true }))
const attachments = AttachmentStore.make(root)
const bytes = new TextEncoder().encode("synthetic library artifact\n")
const context = {
  sessionID: SessionSchema.ID.make("ses_library"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_library"),
  callID: "call_library",
  progress: () => Effect.void,
}

const jsonBody = (request: { init?: RequestInit } | undefined) =>
  Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(Schema.decodeUnknownSync(Schema.String)(request?.init?.body))

const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("Expected the operation to fail")
    },
    (error: unknown) => {
      if (!(error instanceof Error)) throw new Error("Expected an Error failure")
      return error.message
    },
  )

function fixture(
  options: {
    denied?: boolean
    stale?: boolean
    invalidURL?: string
    incomplete?: boolean
    stream?: () => Response
    requestFailure?: string
    uploadHeaders?: Record<string, string>
  } = {},
) {
  const requests: Array<{ route: string; init?: RequestInit }> = []
  const permissions: Permission.AssertInput[] = []
  let stale = false
  const registration = AccountConnectorLibrary.make({
    attachments,
    current: () => (stale ? Effect.fail(new Error("profile changed")) : Effect.void),
    permission: {
      assert: (input) =>
        Effect.sync(() => {
          permissions.push(input)
          if (options.denied) throw new Error("denied")
          if (options.stale) stale = true
        }),
    },
    guardrail: { assert: () => Effect.succeed({ release: Effect.void }) },
    request: (route, init) =>
      Effect.sync(() => {
        requests.push({ route, init })
        if (options.requestFailure) throw new Error(options.requestFailure)
        if (route === "/files/library") return Response.json({ items: [], cursor: "opaque-page-2" })
        if (route === "/files/library/mounted/materialize") return Response.json({ file_id: "file-materialized" })
        if (route.startsWith("/estuary/upload_content_bytes")) return new Response(null, { status: 201 })
        if (route.startsWith("/files/library/content_download")) return new Response(bytes)
        if (route.endsWith("/download_url"))
          return Response.json({
            download_url: options.invalidURL ?? "https://synthetic.blob.core.windows.net/container/file?sig=synthetic",
          })
        if (route === "/files")
          return Response.json({
            file_id: "file-upload",
            upload_url: options.invalidURL ?? "https://synthetic.blob.core.windows.net/container/file?sig=synthetic",
            upload_headers: options.uploadHeaders ?? { "x-ms-blob-type": "BlockBlob" },
          })
        if (route === "/files/process_upload_stream")
          return new Response(
            [
              JSON.stringify({
                event: "file.processing.file_ready",
                file_id: "file-upload",
              }),
              JSON.stringify({
                event: "file.indexing.completed",
                file_id: "file-upload",
                extra: { metadata_object_id: "library-upload", library_file_name: "fixture.txt" },
              }),
              ...(options.incomplete
                ? []
                : [JSON.stringify({ event: "file.processing.completed", file_id: "file-upload" })]),
            ].join("\n"),
          )
        throw new Error("unexpected route")
      }),
    fetch: async (url, init) => {
      requests.push({ route: url.toString(), init })
      return init?.method === "PUT" ? new Response(null, { status: 201 }) : (options.stream?.() ?? new Response(bytes))
    },
  })
  const settle = (name: "list" | "materialize" | "download" | "upload", input: unknown) =>
    Tool.settle(registration.tools[`chatgpt_library_${name}`], { input }, context)
  const call = (name: "list" | "materialize" | "download" | "upload", input: unknown) =>
    Effect.runPromise(settle(name, input))
  return { call, settle, requests, permissions, registration }
}

describe("native account Library", () => {
  test("registers native operations without a hosted tool catalog", () => {
    expect(fixture().registration.options.paths).toEqual({
      chatgpt_library_list: "chatgpt.library.list",
      chatgpt_library_materialize: "chatgpt.library.materialize",
      chatgpt_library_download: "chatgpt.library.download",
      chatgpt_library_upload: "chatgpt.library.upload",
    })
  })

  test("preserves an empty page's opaque cursor and exact list body", async () => {
    const current = fixture()
    const result = await current.call("list", { cursor: "page-1", limit: 1, query: "fixture" })
    expect(result.structured).toEqual({ items: [], cursor: "opaque-page-2" })
    expect(jsonBody(current.requests[0])).toEqual({
      cursor: "page-1",
      limit: 1,
      q: "fixture",
      state: "ready",
    })
    expect(current.permissions[0]).toMatchObject({ action: "chatgpt_library_list", resources: ["library"] })
    expect(current.permissions[0]?.requireExplicitDecision).toBeUndefined()
  })

  test("materializes only a mounted identifier and returns its file identity", async () => {
    const current = fixture()
    const result = await current.call("materialize", {
      fileID: "external-gdrive:fixture",
      name: "fixture.txt",
      mimeType: "text/plain",
    })
    expect(result.structured).toEqual({ fileID: "file-materialized" })
    expect(jsonBody(current.requests[0])).toEqual({
      file_id: "external-gdrive:fixture",
      name: "fixture.txt",
      mime_type: "text/plain",
      index_for_retrieval: false,
    })
    expect(current.permissions[0]).toMatchObject({
      action: "chatgpt_library_materialize",
      resources: ["external-gdrive:fixture"],
    })
    expect(current.permissions[0]?.requireExplicitDecision).toBeUndefined()
  })

  test("downloads into the managed store without exposing a signed URL", async () => {
    const current = fixture()
    const result = await current.call("download", { fileID: "library-fixture" })
    const output = Schema.decodeUnknownSync(
      Schema.Struct({ attachmentURI: Schema.String, path: Schema.String, bytes: Schema.Number }),
    )(result.structured)
    expect(output.attachmentURI).toStartWith("ycoding-attachment://sha256/")
    expect(output.bytes).toBe(bytes.length)
    expect(await Bun.file(output.path).text()).toBe(new TextDecoder().decode(bytes))
    expect(
      await Effect.runPromise(attachments.resolveURI(output.attachmentURI).pipe(Effect.flatMap(attachments.read))),
    ).toEqual(bytes)
    expect(JSON.stringify(result)).not.toContain("sig=")
    expect(new Headers(current.requests[1]?.init?.headers).has("authorization")).toBe(false)
  })

  test("uploads a managed attachment and waits for the matching completion event", async () => {
    const current = fixture()
    const content = await Effect.runPromise(attachments.import(bytes))
    const result = await current.call("upload", {
      attachmentURI: AttachmentStore.managedURI(content),
      name: "fixture.txt",
      mimeType: "text/plain",
    })
    expect(result.structured).toEqual({ fileID: "file-upload", libraryFileID: "library-upload", name: "fixture.txt" })
    expect(current.requests.map((x) => x.route)).toEqual([
      "/files",
      "https://synthetic.blob.core.windows.net/container/file?sig=synthetic",
      "/files/process_upload_stream",
    ])
    expect(jsonBody(current.requests[0])).toMatchObject({
      file_name: "fixture.txt",
      file_size: bytes.length,
      store_in_library: true,
      entry_surface: "codex_library_upload",
    })
    expect(current.requests[1]?.init?.body).toEqual(bytes)
    expect(current.requests[1]?.init?.redirect).toBe("error")
    expect(new Headers(current.requests[1]?.init?.headers).has("authorization")).toBe(false)
    expect(jsonBody(current.requests[2])).toMatchObject({
      file_id: "file-upload",
      metadata: { store_in_library: true },
    })
    expect(current.permissions[0]).toMatchObject({ action: "chatgpt_library_upload", resources: ["fixture.txt"] })
    expect(current.permissions[0]?.requireExplicitDecision).toBeUndefined()
  })

  test("downloads native first-party content through the authenticated fixed-origin request boundary", async () => {
    const current = fixture({
      invalidURL: "https://chatgpt.com/backend-api/files/library/content_download?id=synthetic",
    })
    const result = await current.call("download", { fileID: "library-fixture" })
    expect(current.requests.map((request) => request.route)).toEqual([
      "/files/library/files/library-fixture/download_url",
      "/files/library/content_download?id=synthetic",
    ])
    expect(result.structured).toMatchObject({ bytes: bytes.length })
  })

  test("rejects denied or changed-account calls before network dispatch", async () => {
    for (const option of [{ denied: true }, { stale: true }]) {
      const current = fixture(option)
      await rejected(current.call("list", {}))
      expect(current.requests).toEqual([])
    }
  })

  test("rejects invalid inputs before permission or network", async () => {
    for (const [name, input] of [
      ["list", { limit: 101 }],
      ["download", { fileID: "https://evil.invalid" }],
      ["materialize", { fileID: "file-local", name: "fixture.txt" }],
      ["upload", { attachmentURI: "file:///secret", name: "fixture.txt" }],
    ] as const) {
      const current = fixture()
      await rejected(current.call(name, input))
      expect(current.permissions).toEqual([])
      expect(current.requests).toEqual([])
    }
  })

  test("rejects unsafe signed destinations without transferring bytes", async () => {
    for (const invalidURL of [
      "http://synthetic.blob.core.windows.net/file",
      "https://evil.invalid/file",
      "https://user:secret@synthetic.blob.core.windows.net/file",
      "https://127.0.0.1/file",
      "https://sdmntpsynthetic.oaiusercontent.com.evil.invalid/file",
      "https://fake-oaiusercontent.com/file",
      "https://sdmntpsynthetic.oaiusercontent.com:8443/file",
      "https://[::1]/file",
    ]) {
      const current = fixture({ invalidURL })
      await rejected(current.call("download", { fileID: "library-fixture" }))
      expect(current.requests).toHaveLength(1)
    }
  })

  test("does not report success or replay an upload with missing terminal completion", async () => {
    const current = fixture({ incomplete: true })
    const content = await Effect.runPromise(attachments.import(bytes))
    expect(
      await rejected(
        current.call("upload", {
          attachmentURI: AttachmentStore.managedURI(content),
          name: "fixture.txt",
          mimeType: "text/plain",
        }),
      ),
    ).toContain("completion")
    expect(current.requests.filter((x) => x.route === "/files")).toHaveLength(1)
    expect(current.requests.filter((x) => x.init?.method === "PUT")).toHaveLength(1)
  })

  test("preserves authenticated transport failures instead of mislabeling them as invalid JSON", async () => {
    const current = fixture({ requestFailure: "ChatGPT Library request rejected (HTTP 403)" })
    expect(await rejected(current.call("list", {}))).toContain("HTTP 403")
    expect(current.requests).toHaveLength(1)
  })

  test("cancels a blocked download stream when the tool is interrupted", async () => {
    const entered = Promise.withResolvers<void>()
    let cancelled = false
    const current = fixture({
      stream: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              entered.resolve()
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    })
    const fiber = Effect.runFork(current.settle("download", { fileID: "library-fixture" }))
    await entered.promise
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(cancelled).toBe(true)
  })

  test("cancels oversized download streams before storing any attachment", async () => {
    let cancelled = false
    const current = fixture({
      stream: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(AttachmentStore.MAX_BYTES + 1))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    })
    expect(await rejected(current.call("download", { fileID: "library-fixture" }))).toContain("size limit")
    expect(cancelled).toBe(true)
  })

  test("rejects credential-bearing upload headers before transferring bytes", async () => {
    const current = fixture({ uploadHeaders: { authorization: "forbidden-synthetic" } })
    const content = await Effect.runPromise(attachments.import(bytes))
    expect(
      await rejected(
        current.call("upload", {
          attachmentURI: AttachmentStore.managedURI(content),
          name: "fixture.txt",
          mimeType: "text/plain",
        }),
      ),
    ).toContain("upload headers")
    expect(current.requests).toHaveLength(1)
  })

  test("accepts the file host apex and uses the native Estuary upload form", async () => {
    const content = await Effect.runPromise(attachments.import(bytes))
    const direct = fixture({ invalidURL: "https://files.oaiusercontent.com/file?sig=synthetic" })
    await direct.call("upload", {
      attachmentURI: AttachmentStore.managedURI(content),
      name: "fixture.txt",
      mimeType: "text/plain",
    })
    expect(direct.requests[1]?.init?.method).toBe("PUT")
    const estuary = fixture({
      invalidURL:
        "https://chatgpt.com/backend-api/estuary/upload_content_bytes?upload_url=https%3A%2F%2Fsynthetic.blob.core.windows.net%2Ffile%3Fsig%3Dsynthetic",
    })
    await estuary.call("upload", {
      attachmentURI: AttachmentStore.managedURI(content),
      name: "fixture.txt",
      mimeType: "text/plain",
    })
    expect(estuary.requests[1]?.route).toStartWith("/estuary/upload_content_bytes?")
    const form = estuary.requests[1]?.init?.body
    expect(form).toBeInstanceOf(FormData)
    if (!(form instanceof FormData)) throw new Error("Missing upload form")
    const file = form.get("file")
    expect(file).toBeInstanceOf(Blob)
    if (!(file instanceof Blob)) throw new Error("Missing upload bytes")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
  })

  test("normalizes native root-relative Estuary upload paths", async () => {
    const current = fixture({
      invalidURL:
        "/estuary/upload_content_bytes?upload_url=https%3A%2F%2Fsynthetic.blob.core.windows.net%2Ffile%3Fsig%3Dsynthetic",
    })
    const content = await Effect.runPromise(attachments.import(bytes))
    await current.call("upload", {
      attachmentURI: AttachmentStore.managedURI(content),
      name: "fixture.txt",
      mimeType: "text/plain",
    })
    expect(current.requests[1]?.route).toStartWith("/estuary/upload_content_bytes?")
    expect(current.requests[1]?.init?.body).toBeInstanceOf(FormData)
  })

  test("accepts the native regional OpenAI content host without forwarding account credentials", async () => {
    const current = fixture({
      invalidURL: "https://sdmntpsynthetic.oaiusercontent.com/file?sig=synthetic",
      uploadHeaders: {},
    })
    const content = await Effect.runPromise(attachments.import(bytes))
    await current.call("upload", {
      attachmentURI: AttachmentStore.managedURI(content),
      name: "fixture.txt",
      mimeType: "text/plain",
    })
    expect(current.requests[1]?.init?.method).toBe("PUT")
    expect(new Headers(current.requests[1]?.init?.headers).has("authorization")).toBe(false)
    expect(new Headers(current.requests[1]?.init?.headers).get("x-ms-blob-type")).toBe("BlockBlob")
    expect(new Headers(current.requests[1]?.init?.headers).get("x-ms-version")).toBe("2020-04-08")
    expect(new Headers(current.requests[1]?.init?.headers).get("x-ms-blob-content-type")).toBe("text/plain")
    expect(current.requests[1]?.init?.redirect).toBe("error")
  })

  test("omits Azure-specific headers for a signed AWS upload", async () => {
    const current = fixture({
      invalidURL: "https://synthetic.s3.amazonaws.com/file?X-Amz-Algorithm=synthetic",
      uploadHeaders: {},
    })
    const content = await Effect.runPromise(attachments.import(bytes))
    await current.call("upload", {
      attachmentURI: AttachmentStore.managedURI(content),
      name: "fixture.txt",
      mimeType: "text/plain",
    })
    expect(new Headers(current.requests[1]?.init?.headers).has("x-ms-blob-type")).toBe(false)
  })
})
