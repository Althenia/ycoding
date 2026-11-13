import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@ycoding-ai/core/global"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerConnection } from "../src/services/server-connection"
import { ServiceConfig } from "../src/services/service-config"

test("resolution groups Effect-native lifecycle operations only for the managed service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-server-resolution-"))
  const id = "server-resolution-test"
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        healthy: true,
        version: InstallationVersion,
        pid: process.pid,
        sourceEpoch: "source_test",
      })
    },
  })
  const registration = path.join(root, "state", ServiceConfig.filename())
  const layer = Global.layerWith({
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
  })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))

  try {
    await fs.mkdir(path.dirname(registration), { recursive: true })
    await fs.writeFile(
      registration,
      JSON.stringify({
        id,
        version: InstallationVersion,
        url: server.url.toString(),
        pid: process.pid,
      }),
    )
    const resolved = await runPromise(ServerConnection.resolve({}))

    expect(resolved.endpoint.url).toBe(server.url.toString())
    expect(resolved.service).toBeDefined()
    if (!resolved.service) throw new Error("Expected managed service capabilities")
    expect(Effect.isEffect(resolved.service.reconnect())).toBe(true)
    expect(Effect.isEffect(resolved.service.restart())).toBe(true)
    expect(await runPromise(resolved.service.reconnect())).toEqual(resolved.endpoint)

    const explicit = await runPromise(ServerConnection.resolve({ server: server.url.toString() }))
    expect(explicit.endpoint.url).toBe(server.url.toString())
    expect(explicit.service).toBeUndefined()
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

const secret = "synthetic-service-secret"
const expectedAuthorization = `Basic ${Buffer.from(`ycoding:${secret}`).toString("base64")}`

async function withRegisteredService(
  run: (input: {
    runPromise: <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) => Promise<A>
    register: (url: string) => Promise<void>
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-server-auth-"))
  const layer = Global.layerWith({
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
  })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))
  const register = async (url: string) => {
    await fs.mkdir(path.join(root, "state"), { recursive: true })
    await fs.writeFile(
      path.join(root, "state", "service.json"),
      JSON.stringify({ id: "shared-live", version: "0.11.6", url, pid: process.pid, password: secret }),
    )
  }
  try {
    await run({ runPromise, register })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("explicit server adopts the private password of the matching local registration", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== expectedAuthorization)
        return new Response("Unauthorized", { status: 401 })
      return Response.json({ healthy: true, version: "0.11.6", pid: process.pid, sourceEpoch: "epoch_1" })
    },
  })
  try {
    await withRegisteredService(async ({ runPromise, register }) => {
      await register(server.url.toString().replace(/\/$/, ""))
      const resolved = await runPromise(
        ServerConnection.resolve({ server: server.url.toString(), diagnostics: "sanitized" }),
      )
      expect(resolved.endpoint.auth).toEqual({ type: "basic", username: "ycoding", password: secret })
      expect(resolved.service).toBeUndefined()
    })
  } finally {
    await server.stop(true)
  }
})

test("explicit server adopts the registered password when the registered service answers health slowly", async () => {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      if (request.headers.get("authorization") !== expectedAuthorization)
        return new Response("Unauthorized", { status: 401 })
      await Bun.sleep(2_500)
      return Response.json({ healthy: true, version: "0.11.6", pid: process.pid, sourceEpoch: "epoch_1" })
    },
  })
  try {
    await withRegisteredService(async ({ runPromise, register }) => {
      await register(server.url.toString().replace(/\/$/, ""))
      const resolved = await runPromise(
        ServerConnection.resolve({ server: server.url.toString(), diagnostics: "sanitized" }),
      )
      expect(resolved.endpoint.auth).toEqual({ type: "basic", username: "ycoding", password: secret })
    })
  } finally {
    await server.stop(true)
  }
}, 20_000)

test("explicit server on a different origin never receives the registered password", async () => {
  const registered = Bun.serve({ port: 0, fetch: () => new Response("Unauthorized", { status: 401 }) })
  const seen: Array<string | null> = []
  const other = Bun.serve({
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization"))
      return Response.json({ healthy: true, version: InstallationVersion, pid: process.pid, sourceEpoch: "epoch_1" })
    },
  })
  try {
    await withRegisteredService(async ({ runPromise, register }) => {
      await register(registered.url.toString().replace(/\/$/, ""))
      const resolved = await runPromise(ServerConnection.resolve({ server: other.url.toString() }))
      expect(resolved.endpoint.auth).toBeUndefined()
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((value) => value === null)).toBe(true)
    })
  } finally {
    await other.stop(true)
    await registered.stop(true)
  }
})
