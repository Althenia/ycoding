import { NodeFileSystem } from "@effect/platform-node"
import { FrontendPaths } from "../src/paths"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerConnection } from "../src/services/server-connection"
import { ServiceConfig } from "../src/services/service-config"
import { v5Server } from "./fixture/v5-server"

test("resolution groups Effect-native lifecycle operations only for the managed service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-server-resolution-"))
  const id = "server-resolution-test"
  const server = v5Server(() => ({
    data: {
      healthy: true,
      version: InstallationVersion,
      pid: process.pid,
      sourceEpoch: "source_test",
    },
  }))
  const registration = path.join(root, "state", ServiceConfig.filename())
  const layer = FrontendPaths.layerWith({
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
  })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, FrontendPaths.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))

  try {
    await fs.mkdir(path.dirname(registration), { recursive: true })
    await fs.writeFile(
      registration,
      JSON.stringify({
        id,
        version: InstallationVersion,
        url: server.url,
        pid: process.pid,
      }),
    )
    const resolved = await runPromise(ServerConnection.resolve({}))

    expect(resolved.endpoint.url).toBe(server.url)
    expect(resolved.service).toBeDefined()
    if (!resolved.service) throw new Error("Expected managed service capabilities")
    expect(Effect.isEffect(resolved.service.reconnect())).toBe(true)
    expect(Effect.isEffect(resolved.service.restart())).toBe(true)
    expect(await runPromise(resolved.service.reconnect())).toEqual(resolved.endpoint)

    const explicit = await runPromise(ServerConnection.resolve({ server: server.url }))
    expect(explicit.endpoint.url).toBe(server.url)
    expect(explicit.service).toBeUndefined()
  } finally {
    await server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
