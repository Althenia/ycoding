import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtemp, mkdir, open, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { AccountConnectorLibrary } from "../src/account-connectors/library"
import { AttachmentStore } from "../src/attachment-store"
import { Agent } from "../src/agent"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { Tool } from "../src/tool/tool"
import { Permission } from "../src/permission"
import { LocationMutation } from "../src/location-mutation"
import { Location } from "../src/location"
import { Global } from "../src/global"
import { LayerNode } from "../src/effect/layer-node"
import { location } from "./fixture/location"
import { AbsolutePath } from "../src/schema"

const context = {
  sessionID: SessionSchema.ID.make("ses_library_prepare"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_library_prepare"),
  callID: "call_prepare",
  progress: () => Effect.void,
}
const Prepared = Schema.Struct({
  status: Schema.Literal("prepared"),
  attachmentURI: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  bytes: Schema.Number,
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-library-prepare-"))
  const directory = path.join(root, "project")
  await mkdir(directory)
  const attachments = AttachmentStore.make(path.join(root, "data"))
  const permissions: Permission.AssertInput[] = []
  const requests: string[] = []
  let denied = ""
  let stale = false
  let afterPermission: (() => Promise<void>) | undefined
  let openLocalFile: typeof open = open
  const layers = LayerNode.compile(LocationMutation.node, [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ],
    [Global.node, Global.layerWith({ data: path.join(root, "data") })],
  ])
  const call = (input: unknown, operation: "prepare" | "upload" = "prepare") =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mutation = yield* LocationMutation.Service
        const registration = AccountConnectorLibrary.make({
          attachments,
          local: mutation,
          openLocalFile: (...args) => openLocalFile(...args),
          current: () => (stale ? Effect.fail(new Error("profile changed")) : Effect.void),
          permission: {
            assert: (request) =>
              Effect.gen(function* () {
                permissions.push(request)
                if (request.action === denied)
                  return yield* new Permission.BlockedError({
                    rules: [],
                    permission: request.action,
                    resources: request.resources,
                  })
                if (request.action === "read")
                  yield* Effect.promise(async () => {
                    await afterPermission?.()
                  })
              }),
          },
          guardrail: { assert: () => Effect.succeed({ release: Effect.void }) },
          request: (route) =>
            Effect.sync(() => {
              requests.push(route)
              if (route === "/files")
                return Response.json({
                  file_id: "file-synthetic",
                  upload_url: "https://synthetic.blob.core.windows.net/file?sig=private",
                })
              if (route === "/files/process_upload_stream")
                return new Response(
                  [
                    JSON.stringify({
                      event: "file.indexing.completed",
                      file_id: "file-synthetic",
                      extra: { metadata_object_id: "library-synthetic" },
                    }),
                    JSON.stringify({ event: "file.processing.completed", file_id: "file-synthetic" }),
                  ].join("\n"),
                )
              throw new Error("unexpected synthetic native route")
            }),
          fetch: async (_url, init) => {
            requests.push(init?.method ?? "GET")
            return new Response(null, { status: 201 })
          },
        })
        return yield* Tool.settle(registration.tools[`chatgpt_library_${operation}`], { input }, context)
      }).pipe(Effect.provide(layers), Effect.scoped),
    )
  return {
    root,
    directory,
    attachments,
    requests,
    permissions,
    call,
    deny: (action: string) => {
      denied = action
    },
    stale: () => {
      stale = true
    },
    afterPermission: (run: () => Promise<void>) => {
      afterPermission = run
    },
    openLocalFile: (run: typeof open) => {
      openLocalFile = run
    },
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("prepares a local report as an immutable verified managed attachment without network writes", async () => {
  await using f = await fixture()
  const bytes = new TextEncoder().encode("synthetic local report\n")
  await writeFile(path.join(f.directory, "report.txt"), bytes)
  const output = Schema.decodeUnknownSync(Prepared)((await f.call({ path: "report.txt" })).structured)
  expect(output).toMatchObject({ status: "prepared", name: "report.txt", mimeType: "text/plain", bytes: bytes.length })
  const content = await Effect.runPromise(f.attachments.resolveURI(output.attachmentURI))
  expect(await Effect.runPromise(f.attachments.read(content))).toEqual(bytes)
  await writeFile(path.join(f.directory, "report.txt"), "changed source")
  expect(await Effect.runPromise(f.attachments.read(content))).toEqual(bytes)
  expect(f.requests).toEqual([])
  expect(f.permissions).toContainEqual(
    expect.objectContaining({
      action: "read",
      resources: ["report.txt"],
      source: { type: "tool", messageID: context.messageID, callID: context.callID },
    }),
  )
})

test("authorizes an outside path canonically and retains the reader's refusal of an escaping internal symlink", async () => {
  await using f = await fixture()
  const outside = path.join(f.root, "outside")
  await mkdir(outside)
  await writeFile(path.join(outside, "report.txt"), "synthetic outside report")
  await symlink(path.join(outside, "report.txt"), path.join(f.directory, "link.txt"))
  const output = Schema.decodeUnknownSync(Prepared)(
    (await f.call({ path: path.join(outside, "report.txt") })).structured,
  )
  expect(output.status).toBe("prepared")
  expect(f.permissions.map((request) => request.action)).toEqual(["external_directory", "read"])
  expect(f.permissions[1]?.resources).toEqual([await realpath(path.join(outside, "report.txt"))])
  await expect(f.call({ path: "link.txt" })).rejects.toThrow()
  expect(f.requests).toEqual([])
})

test("a prepared receipt feeds the existing native upload, which reports success only after real synthetic finalization", async () => {
  await using f = await fixture()
  await writeFile(path.join(f.directory, "report.txt"), "synthetic prepared report")
  const output = Schema.decodeUnknownSync(Prepared)((await f.call({ path: "report.txt" })).structured)
  expect(f.requests).toEqual([])
  const uploaded = await f.call(
    { attachmentURI: output.attachmentURI, name: output.name, mimeType: output.mimeType },
    "upload",
  )
  expect(uploaded.structured).toEqual({
    fileID: "file-synthetic",
    libraryFileID: "library-synthetic",
    name: "report.txt",
  })
  expect(f.requests).toEqual(["/files", "PUT", "/files/process_upload_stream"])
})

test("denied reads, stale principals, directories, invalid paths and oversized files never produce a prepared receipt", async () => {
  for (const action of ["read", "external_directory"]) {
    await using f = await fixture()
    await writeFile(path.join(f.root, "outside.txt"), "synthetic")
    f.deny(action)
    await expect(f.call({ path: path.join(f.root, "outside.txt") })).rejects.toThrow("denied")
    expect(f.requests).toEqual([])
  }
  await using f = await fixture()
  await writeFile(path.join(f.directory, "report.txt"), "synthetic")
  await writeFile(path.join(f.directory, "oversized.bin"), "")
  await truncate(path.join(f.directory, "oversized.bin"), AttachmentStore.MAX_BYTES + 1)
  for (const file of [".", "missing.txt", "oversized.bin", "https://invalid.example/report.txt"])
    await expect(f.call({ path: file })).rejects.toThrow()
  f.afterPermission(async () => {
    f.stale()
  })
  await expect(f.call({ path: "report.txt" })).rejects.toThrow("profile changed")
  expect(f.requests).toEqual([])
})

test("rechecks the canonical path after approval instead of following a swapped symlink", async () => {
  await using f = await fixture()
  const target = path.join(f.directory, "report.txt")
  await writeFile(target, "synthetic")
  const outside = path.join(f.root, "other.txt")
  await writeFile(outside, "different source")
  f.afterPermission(async () => {
    await rm(target)
    await symlink(outside, target)
  })
  await expect(f.call({ path: "report.txt" })).rejects.toThrow()
  expect(f.requests).toEqual([])
})

test("rejects an outside opened descriptor even when the authorized path again identifies its original file", async () => {
  await using f = await fixture()
  const authorized = path.join(f.directory, "report.txt")
  const outside = path.join(f.root, "outside.txt")
  await writeFile(authorized, "authorized bytes")
  await writeFile(outside, "outside secret bytes")
  let opened = false
  f.openLocalFile(async () => {
    opened = true
    return open(outside, "r")
  })
  await expect(f.call({ path: "report.txt" })).rejects.toThrow("identity")
  expect(opened).toBe(true)
  expect(f.requests).toEqual([])
})

test("rejects basenames that the existing Library upload contract cannot accept", async () => {
  await using f = await fixture()
  for (const name of ["report\nsecret.txt", "report\\secret.txt"]) {
    await writeFile(path.join(f.directory, name), "synthetic")
    await expect(f.call({ path: name })).rejects.toThrow("filename")
  }
  expect(f.requests).toEqual([])
})
