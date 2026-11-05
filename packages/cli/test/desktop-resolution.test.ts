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

test("desktop shared managed discovery refuses missing service without starting it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-discovery-"))
  const ensure = spyOn(Service, "ensure").mockImplementation(() => Effect.fail(new Error("Unexpected service startup")))
  const args = { mismatch: "error" as const, managed: "discover" as const }
  try {
    await expect(Effect.runPromise(ServerConnection.resolve(args).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))).rejects.toThrow("No compatible managed server is running")
    expect(ensure).not.toHaveBeenCalled()
  } finally {
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
