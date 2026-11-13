import { NodeFileSystem } from "@effect/platform-node"
import { Service } from "@ycoding-ai/client/effect/service"
import { Global } from "@ycoding-ai/core/global"
import { expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerConnection } from "../src/services/server-connection"
import { Standalone } from "../src/services/standalone"

test("desktop shared managed discovery starts a missing service with the bundled executable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-discovery-"))
  const endpoint = { url: "http://127.0.0.1:49123" }
  const ensure = spyOn(Service, "ensure").mockImplementation(() => Effect.succeed(endpoint))
  const args = { managedCommand: ["/synthetic/resources/ycoding", "serve", "--service"] }
  try {
    const result = await Effect.runPromise(ServerConnection.resolve(args).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))
    expect(result.endpoint).toEqual(endpoint)
    expect(ensure.mock.calls[0]?.[0]?.command).toEqual(args.managedCommand)
  } finally {
    ensure.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("desktop shared managed discovery reuses a compatible service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-discovery-"))
  const endpoint = { url: "http://127.0.0.1:49123", auth: undefined }
  const discover = spyOn(Service, "discover").mockImplementation(() => Effect.succeed(endpoint))
  const ensure = spyOn(Service, "ensure").mockImplementation(() => Effect.fail(new Error("Unexpected service startup")))
  try {
    const result = await Effect.runPromise(ServerConnection.resolve({ managedCommand: ["/synthetic/resources/ycoding", "serve", "--service"] }).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))
    expect(result.endpoint).toEqual(endpoint)
    expect(ensure).not.toHaveBeenCalled()
  } finally {
    discover.mockRestore()
    ensure.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("desktop shared managed discovery leaves an incompatible service running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-discovery-"))
  const discover = spyOn(Service, "discover").mockImplementation((options) => Effect.succeed(options?.version === undefined ? { url: "http://127.0.0.1:49123", auth: undefined } : undefined))
  const ensure = spyOn(Service, "ensure").mockImplementation(() => Effect.fail(new Error("Unexpected service startup")))
  try {
    await expect(Effect.runPromise(ServerConnection.resolve({ mismatch: "error", managedCommand: ["/synthetic/resources/ycoding", "serve", "--service"] }).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))).rejects.toThrow("version does not match")
    expect(ensure).not.toHaveBeenCalled()
  } finally {
    discover.mockRestore()
    ensure.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("desktop private resolution forwards its explicit bundled backend command", async () => {
  const privateServer = { command: ["/synthetic/resources/ycoding", "serve"], env: { YCODING_DB: "/synthetic/data/runtime.db" } }
  const endpoint = {
    url: "http://127.0.0.1:49123",
    auth: { type: "basic" as const, username: "ycoding", password: "synthetic-lease" },
    pid: ChildProcessSpawner.ProcessId(12345),
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-private-"))
  const exited = Effect.void
  const start = spyOn(Standalone, "owned").mockImplementation(() => Effect.succeed({ endpoint, exited }))
  const args = { standalone: true, privateServer }
  try {
    const result = await Effect.runPromise(ServerConnection.resolve(args).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))
    expect(result.endpoint).toEqual(endpoint)
    expect(result).toHaveProperty("exited", exited)
    expect(start).toHaveBeenCalledWith(privateServer)
  } finally {
    start.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})
