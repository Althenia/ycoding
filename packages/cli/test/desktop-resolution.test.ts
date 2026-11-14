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
import { ServiceConfig } from "../src/services/service-config"
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

test("desktop shared managed discovery with mismatch ignore attaches to a running version-mismatched service without stopping it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-ignore-running-"))
  const endpoint = {
    url: "http://127.0.0.1:49123",
    auth: { type: "basic" as const, username: "ycoding", password: "synthetic-service-secret" },
  }
  const discover = spyOn(Service, "discover").mockImplementation((options) =>
    Effect.succeed(options?.version === undefined ? endpoint : undefined),
  )
  const ensure = spyOn(Service, "ensure").mockImplementation(() => Effect.fail(new Error("Unexpected service startup")))
  const stop = spyOn(Service, "stop").mockImplementation(() => Effect.fail(new Error("Unexpected service stop")))
  try {
    const result = await Effect.runPromise(ServerConnection.resolve({
      mismatch: "ignore",
      managedCommand: ["/synthetic/resources/ycoding", "serve", "--service"],
    }).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))
    expect(result.endpoint).toEqual(endpoint)
    expect(ensure).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  } finally {
    discover.mockRestore()
    ensure.mockRestore()
    stop.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("desktop shared managed discovery with mismatch ignore starts the bundled service with unpinned version when none is running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-ignore-missing-"))
  const endpoint = {
    url: "http://127.0.0.1:49123",
    auth: { type: "basic" as const, username: "ycoding", password: "synthetic-service-secret" },
  }
  const managedCommand = ["/synthetic/resources/ycoding", "serve", "--service"] as const
  const discover = spyOn(Service, "discover").mockImplementation(() => Effect.succeed(undefined))
  const ensure = spyOn(Service, "ensure").mockImplementation(() => Effect.succeed(endpoint))
  try {
    const result = await Effect.runPromise(ServerConnection.resolve({
      mismatch: "ignore",
      managedCommand,
    }).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))
    expect(result.endpoint).toEqual(endpoint)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure.mock.calls[0]?.[0]?.command).toEqual(managedCommand)
    expect(ensure.mock.calls[0]?.[0]?.version).toBeUndefined()
  } finally {
    discover.mockRestore()
    ensure.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("isLoopbackOrigin classifies IPv4, localhost, and IPv6 loopback origins and rejects remote hosts", () => {
  const isLoopbackOrigin = (ServerConnection as unknown as { isLoopbackOrigin: (url: string) => boolean }).isLoopbackOrigin
  expect(isLoopbackOrigin("http://127.0.0.1:42188/")).toBe(true)
  expect(isLoopbackOrigin("http://localhost:42188/")).toBe(true)
  expect(isLoopbackOrigin("http://[::1]:42188/")).toBe(true)
  expect(isLoopbackOrigin("https://remote.example.com/")).toBe(false)
})

test("dead loopback sharedEndpoint falls back to local managed service with registered service auth", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-dead-loopback-"))
  const secret = "synthetic-service-secret"
  const expectedAuth = `Basic ${Buffer.from(`ycoding:${secret}`).toString("base64")}`
  const ephemeral = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
  const deadUrl = ephemeral.url.toString()
  await ephemeral.stop(true)
  const managed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== expectedAuth) return new Response("Unauthorized", { status: 401 })
      return Response.json({ healthy: true, version: "0.11.0", pid: process.pid, sourceEpoch: "epoch_local" })
    },
  })
  const stateDir = path.join(root, "state")
  const registrationPayload = JSON.stringify({
    id: "managed-live",
    version: "0.11.0",
    url: managed.url.toString(),
    pid: process.pid,
    password: secret,
  })
  try {
    await fs.mkdir(stateDir, { recursive: true })
    for (const file of new Set([ServiceConfig.filename(), "service.json"]))
      await fs.writeFile(path.join(stateDir, file), registrationPayload)
    const resolveArgs = {
      server: deadUrl,
      allowLoopbackFallback: true,
      mismatch: "ignore" as const,
      managedCommand: ["/synthetic/resources/ycoding", "serve", "--service"] as const,
    }
    const result = await Effect.runPromise(ServerConnection.resolve(resolveArgs as unknown as ServerConnection.Args).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: stateDir })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))
    expect(result.endpoint).toEqual({
      url: managed.url.toString(),
      auth: { type: "basic", username: "ycoding", password: secret },
    })
  } finally {
    await managed.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("unauthorized loopback sharedEndpoint falls back to local managed service instead of failing startup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-unauth-loopback-"))
  const unauthorized = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(
      { _tag: "UnauthorizedError", message: "Authentication required" },
      { status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' } },
    ),
  })
  const fallbackEndpoint = {
    url: "http://127.0.0.1:49123",
    auth: { type: "basic" as const, username: "ycoding", password: "synthetic-managed-secret" },
  }
  const managedCommand = ["/synthetic/resources/ycoding", "serve", "--service"] as const
  const discover = spyOn(Service, "discover").mockImplementation(() => Effect.succeed(undefined))
  const ensure = spyOn(Service, "ensure").mockImplementation(() => Effect.succeed(fallbackEndpoint))
  try {
    const resolveArgs = {
      server: unauthorized.url.toString(),
      allowLoopbackFallback: true,
      mismatch: "ignore" as const,
      managedCommand,
    }
    const result = await Effect.runPromise(ServerConnection.resolve(resolveArgs as unknown as ServerConnection.Args).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))
    expect(result.endpoint).toEqual(fallbackEndpoint)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure.mock.calls[0]?.[0]?.command).toEqual(managedCommand)
    expect(ensure.mock.calls[0]?.[0]?.version).toBeUndefined()
  } finally {
    discover.mockRestore()
    ensure.mockRestore()
    await unauthorized.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("non-loopback server never falls back to local Service.ensure even when allowLoopbackFallback is enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-remote-nofallback-"))
  const originalFetch = globalThis.fetch
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: URL | RequestInfo, init?: BunFetchRequestInit | RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (target.startsWith("https://example.invalid/"))
      return Promise.reject(new TypeError("Unable to connect to remote host"))
    return originalFetch(input as never, init)
  }) as unknown as typeof fetch)
  const discover = spyOn(Service, "discover").mockImplementation(() => Effect.die(new Error("Unexpected local discovery")))
  const ensure = spyOn(Service, "ensure").mockImplementation(() => Effect.fail(new Error("Unexpected local service startup")))
  try {
    const resolveArgs = {
      server: "https://example.invalid/",
      allowLoopbackFallback: true,
      mismatch: "ignore" as const,
      managedCommand: ["/synthetic/resources/ycoding", "serve", "--service"] as const,
    }
    await expect(Effect.runPromise(ServerConnection.resolve(resolveArgs as unknown as ServerConnection.Args).pipe(
      Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ))).rejects.toThrow("Could not reach server at https://example.invalid/")
    expect(discover).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  } finally {
    fetchSpy.mockRestore()
    discover.mockRestore()
    ensure.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("desktop-host handler passes mismatch ignore and allowLoopbackFallback alongside managedCommand", async () => {
  const source = await fs.readFile(path.join(import.meta.dir, "../src/commands/handlers/desktop-host.ts"), "utf8")
  expect(source).toContain('managedCommand: [input.backend, "serve", "--service"]')
  expect(source).toContain('mismatch: "ignore"')
  expect(source).toContain("allowLoopbackFallback: true")
  expect(source).not.toContain('mismatch: "error"')
})
