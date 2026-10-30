import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { AccountConnectorLibrary } from "../src/account-connectors/library"
import { createLibraryFactory } from "../src/account-connectors/library-reservations"
import { AttachmentStore } from "../src/attachment-store"
import { LocationMutation } from "../src/location-mutation"
import { Location } from "../src/location"
import { Global } from "../src/global"
import { LayerNode } from "../src/effect/layer-node"
import { AbsolutePath } from "../src/schema"
import { location } from "./fixture/location"
import type { CcaAuthorizationInput } from "../src/cca/authorization"

const Upload = Schema.Struct({
  upload_session_id: Schema.String,
  file_id: Schema.String,
  file_name: Schema.String,
  workspace_path: Schema.String,
  purpose: Schema.Literal("create_library_file"),
  store_in_library: Schema.Literal(true),
  mime_type: Schema.String,
  file_size_bytes: Schema.Number,
})
const Prepared = Schema.Struct({ uploads: Schema.Array(Upload) })
const Finished = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      operation: Schema.Literal("create_library_file"),
      status: Schema.Literal("succeeded"),
      file_id: Schema.String,
      library_file_id: Schema.String,
      file_name: Schema.String,
    }),
  ),
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-library-reservation-"))
  const directory = path.join(root, "project")
  await mkdir(directory)
  const file = path.join(directory, "report.txt")
  const text = "synthetic compatible report"
  await writeFile(file, text)
  const attachments = AttachmentStore.make(path.join(root, "data"))
  const requests: string[] = []
  const grants: CcaAuthorizationInput[] = []
  let releases = 0
  let retired = false
  let denied = false
  let incomplete = false
  let loseTransfer = false
  let rejectedCreate = false
  let retireAfter = ""
  let now = 1_000
  let expiry: (() => void) | undefined
  let expiryCancelled = false
  let gate: Promise<void> | undefined
  let finalGate: Promise<void> | undefined
  const transferEntered = Promise.withResolvers<void>()
  const finalizerEntered = Promise.withResolvers<void>()
  const check = async () => {
    if (retired) throw new Error("scope retired")
  }
  const current = () => Effect.tryPromise({ try: check, catch: () => new Error("scope retired") })
  const files = AccountConnectorLibrary.nativeFiles({
    current,
    request: (route, _init, onDispatch) =>
      Effect.gen(function* () {
        yield* current()
        onDispatch?.()
        requests.push(route)
        if (route === "/files" && rejectedCreate)
          return yield* Effect.fail(new AccountConnectorLibrary.RequestRejected(403))
        if (route === retireAfter) retired = true
        if (route === "/files")
          return Response.json({
            file_id: "file-actual",
            upload_url: "https://synthetic.blob.core.windows.net/content?sig=private",
          })
        if (route === "/files/process_upload_stream") {
          finalizerEntered.resolve()
          yield* Effect.promise(() => finalGate ?? Promise.resolve())
          return new Response(
            [
              JSON.stringify({
                event: "file.indexing.completed",
                file_id: "file-actual",
                extra: { metadata_object_id: "library-actual", library_file_name: "report.txt" },
              }),
              ...(incomplete ? [] : [JSON.stringify({ event: "file.processing.completed", file_id: "file-actual" })]),
            ].join("\n"),
          )
        }
        throw new Error("unexpected native route")
      }),
    fetch: async (_url, init) => {
      requests.push(init?.method ?? "GET")
      transferEntered.resolve()
      const signal = init?.signal
      let abort = () => {}
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("synthetic transfer aborted"))
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) abort()
      })
      try {
        await Promise.race([gate ?? Promise.resolve(), interrupted])
      } finally {
        signal?.removeEventListener("abort", abort)
      }
      if (retireAfter === "PUT") retired = true
      if (loseTransfer) throw new Error("synthetic connection lost")
      return new Response(null, { status: 201 })
    },
  })
  const layer = LayerNode.compile(LocationMutation.node, [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ],
    [Global.node, Global.layerWith({ data: path.join(root, "data") })],
  ])
  const authorize = async (input: CcaAuthorizationInput) => {
    grants.push(input)
    if (denied) throw new Error("denied")
    return {
      release: async () => {
        releases++
      },
    }
  }
  const { factory, readFile } = await Effect.runPromise(
    Effect.gen(function* () {
      const local = yield* LocationMutation.Service
      const canonicalRoot = yield* Effect.promise(() => realpath(directory))
      const readFile = async (file: string) => {
        const target = await Effect.runPromise(local.resolve({ path: file, kind: "directory" }))
        const relative = path.relative(canonicalRoot, target.canonical)
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new Error("process sandbox denied")
        const grant = await authorize({ action: "read", resources: [target.canonical] })
        try {
          return {
            canonical: target.canonical,
            bytes: await Effect.runPromise(AccountConnectorLibrary.readLocalFile(target.canonical)),
          }
        } finally {
          await grant.release()
        }
      }
      const factory = createLibraryFactory({
        attachments,
        files,
        check,
        now: () => now,
        schedule: (callback) => {
          expiry = callback
          expiryCancelled = false
          return () => {
            expiryCancelled = true
          }
        },
        authorization: { authorize },
      })
      return { factory, readFile }
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
  const process = await factory.open({ processID: "process-a", cwd: directory, readFile })
  const spec = {
    workspace_path: file,
    file_name: "report.txt",
    purpose: "create_library_file",
    file_size_bytes: Buffer.byteLength(text),
    mime_type: "text/plain",
  }
  const prepare = async (input: unknown = spec) =>
    Schema.decodeUnknownSync(Prepared)(await process.call("ycoding_library.prepare_uploads", { uploads: [input] }))
      .uploads[0]!
  const finalize = (upload: typeof Upload.Type) =>
    process.call("ycoding_library.finalize_uploads", { uploads: [upload] })
  return {
    factory,
    process,
    prepare,
    finalize,
    spec,
    requests,
    grants,
    file,
    readFile,
    transferEntered: transferEntered.promise,
    finalizerEntered: finalizerEntered.promise,
    releases: () => releases,
    deny: () => {
      denied = true
    },
    rejectCreate: () => {
      rejectedCreate = true
    },
    retire: () => {
      retired = true
    },
    incomplete: () => {
      incomplete = true
    },
    loseTransfer: () => {
      loseTransfer = true
    },
    retireAfter: (phase: string) => {
      retireAfter = phase
    },
    expire: () => {
      now += 300_001
    },
    fireExpiry: () => {
      if (!expiry || expiryCancelled) return false
      expiry()
      return true
    },
    gate: (promise: Promise<void>) => {
      gate = promise
    },
    finalGate: (promise: Promise<void>) => {
      finalGate = promise
    },
    async [Symbol.asyncDispose]() {
      await process.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("private prepare performs actual create and transfer before returning the original path, and finalize verifies real identities", async () => {
  await using f = await fixture()
  expect(f.process.tools.map((tool) => tool.name)).toEqual([
    "ycoding_library.prepare_uploads",
    "ycoding_library.finalize_uploads",
  ])
  const upload = await f.prepare()
  expect(f.requests).toEqual(["/files", "PUT"])
  expect(upload).toMatchObject({
    file_id: "file-actual",
    file_name: "report.txt",
    purpose: "create_library_file",
    store_in_library: true,
  })
  expect(upload.workspace_path.endsWith("/project/report.txt")).toBe(true)
  expect(JSON.stringify(upload)).not.toContain("sig=")
  expect(JSON.stringify(upload)).not.toContain("attachments/sha256")
  const output = Schema.decodeUnknownSync(Finished)(await f.finalize(upload))
  expect(output.results[0]).toMatchObject({
    file_id: "file-actual",
    library_file_id: "library-actual",
    status: "succeeded",
  })
  expect(f.requests).toEqual(["/files", "PUT", "/files/process_upload_stream"])
  expect(await f.finalize(upload)).toEqual(output)
  expect(f.requests).toHaveLength(3)
  expect(f.releases()).toBe(f.grants.length)
  expect(f.grants).toContainEqual(
    expect.objectContaining({
      action: "chatgpt_library_upload",
      guardrailAction: "mcp_execute",
      metadata: expect.objectContaining({ operationDigest: expect.any(String) }),
    }),
  )
})

test("rejects unsupported helper features, size mismatches, unknown tools and multi-file batches before native writes", async () => {
  await using f = await fixture()
  for (const input of [
    { ...f.spec, purpose: "replace_library_file" },
    { ...f.spec, is_shared: true },
    { ...f.spec, directory_id: "dir" },
    { ...f.spec, library_artifact_type: "report" },
    { ...f.spec, expected_current_version: 1 },
    { ...f.spec, file_size_bytes: AttachmentStore.MAX_BYTES + 1 },
    { ...f.spec, file_size_bytes: f.spec.file_size_bytes + 1 },
  ])
    await expect(f.prepare(input)).rejects.toThrow()
  await expect(f.process.call("ycoding_library.prepare_uploads", { uploads: [f.spec, f.spec] })).rejects.toThrow()
  await expect(f.process.call("unadvertised", {})).rejects.toThrow()
  expect(f.requests).toEqual([])
})

test("opaque reservations reject another process even when its process label matches", async () => {
  await using f = await fixture()
  const upload = await f.prepare()
  const other = await f.factory.open({ processID: "process-a", cwd: path.dirname(f.file), readFile: f.readFile })
  try {
    await expect(other.call("ycoding_library.finalize_uploads", { uploads: [upload] })).rejects.toThrow()
    await expect(f.finalize({ ...upload, upload_session_id: "unknown-token" })).rejects.toThrow()
    expect(f.requests).toEqual(["/files", "PUT"])
    await f.finalize(upload)
  } finally {
    await other.close()
  }
})

test("changed echoed fields consume the reservation without a finalizer write", async () => {
  for (const field of ["file_id", "file_name", "workspace_path", "mime_type"] as const) {
    await using f = await fixture()
    const upload = await f.prepare()
    await expect(f.finalize({ ...upload, [field]: `${upload[field]}-changed` })).rejects.toThrow("unfinalized")
    await expect(f.finalize(upload)).rejects.toThrow()
    expect(f.requests).toEqual(["/files", "PUT"])
  }
})

test("a helper directory field first seen at finalize leaves the uploaded reservation unfinalized and cannot be stripped for retry", async () => {
  await using f = await fixture()
  const upload = await f.prepare()
  await expect(
    f.process.call("ycoding_library.finalize_uploads", { uploads: [{ ...upload, directory_id: "unsupported" }] }),
  ).rejects.toThrow("unfinalized")
  await expect(f.finalize(upload)).rejects.toThrow()
  expect(f.requests).toEqual(["/files", "PUT"])
  expect(f.releases()).toBe(f.grants.length)
})

test("denied or retired callers dispatch nothing, and expiration releases grants without replay", async () => {
  await using denied = await fixture()
  denied.deny()
  await expect(denied.prepare()).rejects.toThrow()
  expect(denied.requests).toEqual([])
  await using retired = await fixture()
  retired.retire()
  await expect(retired.prepare()).rejects.toThrow()
  expect(retired.requests).toEqual([])
  await using f = await fixture()
  const upload = await f.prepare()
  f.expire()
  await expect(f.finalize(upload)).rejects.toThrow()
  expect(f.requests).toEqual(["/files", "PUT"])
  expect(f.releases()).toBe(f.grants.length)
})

test("an explicit native account rejection stays a known HTTP failure rather than an uncertain upload", async () => {
  await using f = await fixture()
  f.rejectCreate()
  const outcome = await f.prepare().then(
    () => "unexpected success",
    (error: unknown) => (error instanceof Error ? error.message : "unexpected error"),
  )
  expect(outcome).toContain("HTTP 403")
  expect(outcome).not.toContain("uncertain")
  expect(f.requests).toEqual(["/files"])
  expect(f.releases()).toBe(f.grants.length)
})

test("a lost prepare transfer, stale post-write scope or incomplete finalizer never returns success and never repeats writes", async () => {
  for (const phase of ["lost", "/files", "PUT", "/files/process_upload_stream", "incomplete"] as const) {
    await using f = await fixture()
    if (phase === "lost") f.loseTransfer()
    else if (phase !== "incomplete") f.retireAfter(phase)
    if (phase === "incomplete") f.incomplete()
    if (phase === "/files/process_upload_stream" || phase === "incomplete") {
      const upload = await f.prepare()
      await expect(f.finalize(upload)).rejects.toThrow("do not retry")
      const count = f.requests.length
      await expect(f.finalize(upload)).rejects.toThrow()
      expect(f.requests).toHaveLength(count)
    } else {
      await expect(f.prepare()).rejects.toThrow("do not retry")
      const count = f.requests.length
      await expect(f.prepare()).rejects.toThrow()
      expect(f.requests).toHaveLength(count)
    }
  }
})

test("concurrent duplicate prepare cannot dispatch twice and a changed source cannot be finalized", async () => {
  await using f = await fixture()
  const gate = Promise.withResolvers<void>()
  f.gate(gate.promise)
  const first = f.prepare()
  await f.transferEntered
  await expect(f.prepare()).rejects.toThrow()
  gate.resolve()
  const upload = await first
  await writeFile(f.file, "changed local source")
  await expect(f.finalize(upload)).rejects.toThrow()
  expect(f.requests).toEqual(["/files", "PUT"])
})

test("concurrent duplicate finalize cannot dispatch twice", async () => {
  await using f = await fixture()
  const upload = await f.prepare()
  const gate = Promise.withResolvers<void>()
  f.finalGate(gate.promise)
  const first = f.finalize(upload)
  await f.finalizerEntered
  await expect(f.finalize(upload)).rejects.toThrow("already running")
  gate.resolve()
  Schema.decodeUnknownSync(Finished)(await first)
  expect(f.requests).toEqual(["/files", "PUT", "/files/process_upload_stream"])
})

test("a process reader denial cannot fall back to the broader Location reader", async () => {
  await using f = await fixture()
  const restricted = await f.factory.open({
    processID: "restricted",
    cwd: path.dirname(f.file),
    readFile: async () => {
      throw new Error("process sandbox denied")
    },
  })
  try {
    await expect(restricted.call("ycoding_library.prepare_uploads", { uploads: [f.spec] })).rejects.toThrow(
      "process sandbox denied",
    )
    expect(f.requests).toEqual([])
  } finally {
    await restricted.close()
  }
})

test("closing an in-flight process cancels publication and releases its grants without a finalizer request", async () => {
  await using f = await fixture()
  const gate = Promise.withResolvers<void>()
  f.gate(gate.promise)
  const attempt = f.prepare()
  const settlement = attempt.then(
    () => "succeeded",
    () => "rejected",
  )
  await f.transferEntered
  await f.process.close()
  expect(await settlement).toBe("rejected")
  gate.resolve()
  await expect(f.prepare()).rejects.toThrow()
  expect(f.requests).toEqual(["/files", "PUT"])
  expect(f.releases()).toBe(f.grants.length)
})

for (const outcome of ["completed", "uncertain"] as const)
  test(`idle ${outcome} outcome is closed by scheduled cleanup without a later operation or elapsed injected clock`, async () => {
    await using f = await fixture()
    if (outcome === "completed") await f.finalize(await f.prepare())
    else {
      f.loseTransfer()
      await expect(f.prepare()).rejects.toThrow("do not retry")
    }
    const count = f.requests.length
    expect(f.fireExpiry()).toBe(true)
    await expect(f.process.check()).rejects.toThrow("closed")
    await expect(f.prepare()).rejects.toThrow("closed")
    expect(f.requests).toHaveLength(count)
    expect(f.releases()).toBe(f.grants.length)
  })

test("a later known preflight denial does not cancel expiry of a retained completed receipt", async () => {
  await using f = await fixture()
  await f.finalize(await f.prepare())
  f.deny()
  await expect(f.prepare()).rejects.toThrow("denied")
  expect(f.fireExpiry()).toBe(true)
  await expect(f.process.check()).rejects.toThrow("closed")
  expect(f.requests).toEqual(["/files", "PUT", "/files/process_upload_stream"])
})
