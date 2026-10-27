import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createRemoteHost } from "../src/remote-host"
import { createRemoteConnector } from "../src/commands/handlers/remote/connector"
import { startServer } from "./remote-harness"
import { RemoteSetupError } from "../src/remote-error"
import { DeviceAuthorizationError } from "../src/remote-credentials"

test("the server host persists one switch, resumes on restart, and stops without clearing preference", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  const started = Promise.withResolvers<void>()
  let connects = 0
  let closes = 0
  const create = async () => createRemoteConnector({
    directory, notice: "Machine owner access",
    makeBridge: () => ({
      connect: async () => { connects++; await started.promise },
      close: async () => { closes++ },
    }),
  })
  try {
    const first = await createRemoteHost({ file: path.join(directory, "remote.json"), create })
    expect(await first.status()).toEqual({ state: "off" })
    expect(await first.set(true)).toEqual({ state: "connecting" })
    expect(await Bun.file(path.join(directory, "remote.json")).json()).toEqual({ enabled: true })
    started.resolve()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && (await first.status()).state !== "on") await Bun.sleep(10)
    expect(await first.status()).toEqual({ state: "on" })
    await first.shutdown()
    expect(closes).toBe(1)
    const second = await createRemoteHost({ file: path.join(directory, "remote.json"), create })
    const resumed = Date.now() + 5_000
    while (Date.now() < resumed && (await second.status()).state !== "on") await Bun.sleep(10)
    expect(await second.status()).toEqual({ state: "on" })
    expect(connects).toBe(2)
    expect(await second.set(false)).toEqual({ state: "off" })
    expect(await Bun.file(path.join(directory, "remote.json")).json()).toEqual({ enabled: false })
    expect(closes).toBe(2)
    await second.shutdown()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a server blocked by another server's lock reports its PID and does not stop its connector", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  let closes = 0
  const create = () => createRemoteConnector({
    directory, notice: "Machine owner access",
    makeBridge: () => ({ connect: async () => {}, close: async () => { closes++ } }),
  })
  const owner = create()
  try {
    await owner.start()
    const host = await createRemoteHost({ file: path.join(directory, "remote.json"), create: async () => create() })
    expect(await host.set(true)).toEqual({ state: "connecting" })
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && (await host.status()).message === undefined) await Bun.sleep(10)
    expect(await host.status()).toMatchObject({ state: "connecting", message: expect.stringContaining(`PID ${process.pid}`) })
    await host.shutdown()
    expect(closes).toBe(0)
  } finally {
    await owner.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("an unenrolled server reports its failure without losing the enabled preference", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  try {
    const host = await createRemoteHost({ file: path.join(directory, "remote.json"), create: async () => {
      throw new RemoteSetupError("This machine is not enrolled; run `ycoding remote enroll <enrollmentID>` first")
    } })
    expect(await host.set(true)).toEqual({ state: "connecting" })
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && (await host.status()).state !== "error") await Bun.sleep(10)
    expect(await host.status()).toMatchObject({ state: "error", message: expect.stringContaining("not enrolled") })
    expect(await Bun.file(path.join(directory, "remote.json")).json()).toEqual({ enabled: true })
    await host.shutdown()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the last concurrent switch wins across a slow connector stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  const stopping = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let connections = 0
  const host = await createRemoteHost({
    file: path.join(directory, "remote.json"),
    create: async () => createRemoteConnector({
      directory, notice: "Owner access",
      makeBridge: () => ({
        connect: async () => { connections++ },
        close: async () => { stopping.resolve(); await release.promise },
      }),
    }),
  })
  try {
    await host.set(true)
    const ready = Date.now() + 5_000
    while (Date.now() < ready && (await host.status()).state !== "on") await Bun.sleep(10)
    const disable = host.set(false)
    await stopping.promise
    const enable = host.set(true)
    expect(await Bun.file(path.join(directory, "remote.json")).json()).toEqual({ enabled: false })
    release.resolve()
    await Promise.all([disable, enable])
    const resumed = Date.now() + 5_000
    while (Date.now() < resumed && (await host.status()).state !== "on") await Bun.sleep(10)
    expect(await host.status()).toEqual({ state: "on" })
    expect(await Bun.file(path.join(directory, "remote.json")).json()).toEqual({ enabled: true })
    expect(connections).toBe(2)
  } finally {
    release.resolve()
    await host.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("an enabled server serves remote status without any TUI and stops on server shutdown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  await Bun.write(path.join(directory, "remote.json"), JSON.stringify({ enabled: true }))
  let connections = 0
  let closes = 0
  const host = await createRemoteHost({
    file: path.join(directory, "remote.json"),
    create: async () => createRemoteConnector({
      directory, notice: "Owner access",
      makeBridge: () => ({
        connect: async () => { connections++ },
        close: async () => { closes++ },
      }),
    }),
  })
  const server = await startServer(directory, { remote: host })
  try {
    const deadline = Date.now() + 5_000
    let state = "connecting"
    while (Date.now() < deadline && state !== "on") {
      const response = await server.request("/api/remote")
      state = (await response.json()).data.state
      if (state !== "on") await Bun.sleep(10)
    }
    expect(state).toBe("on")
    expect(connections).toBe(1)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
  expect(closes).toBe(1)
})

test("a malformed remote preference leaves the server host available with a visible error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  await Bun.write(path.join(directory, "remote.json"), "{not-json")
  try {
    const host = await createRemoteHost({ file: path.join(directory, "remote.json"), create: async () => {
      throw new Error("the connector must not start from malformed state")
    } })
    expect(await host.status()).toMatchObject({ state: "error", message: expect.any(String) })
    await host.shutdown()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function retries() {
  const pending = new Map<() => void, number>()
  return {
    pending,
    schedule: (retry: () => void, delay: number) => {
      pending.set(retry, delay)
      return () => { pending.delete(retry) }
    },
    run: () => {
      const retry = pending.keys().next().value
      if (!retry) throw new Error("No retry scheduled")
      pending.delete(retry)
      retry()
    },
  }
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 1_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(1)
  }
}

test("enabled intent retries initial creation and bridge failures with bounded backoff until online", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  const retry = retries()
  let creates = 0
  let connects = 0
  let closes = 0
  const host = await createRemoteHost({
    file: path.join(directory, "remote.json"), scheduleRetry: retry.schedule,
    create: async () => {
      if (++creates === 1) throw new Error("Bearer synthetic-token startup temporarily unavailable")
      return createRemoteConnector({
        directory, notice: "Owner access",
        makeBridge: () => ({
          connect: async () => { if (++connects === 1) throw new Error("Bearer synthetic-token network down") },
          close: async () => { closes++ },
        }),
      })
    },
  })
  try {
    await host.set(true)
    await waitFor(() => retry.pending.size === 1)
    await host.set(true)
    expect(await host.status()).toMatchObject({ state: "connecting", message: expect.stringContaining("retry") })
    expect(JSON.stringify(await host.status())).not.toContain("synthetic-token")
    expect([...retry.pending.values()]).toEqual([1_000])
    retry.run()
    await waitFor(() => retry.pending.size === 1)
    expect([...retry.pending.values()]).toEqual([2_000])
    expect(JSON.stringify(await host.status())).not.toContain("synthetic-token")
    expect(closes).toBe(1)
    retry.run()
    await waitFor(() => connects === 2)
    expect(await host.status()).toEqual({ state: "on" })
    expect(creates).toBe(2)
    expect(await Bun.file(path.join(directory, "remote.json")).json()).toEqual({ enabled: true })
    await host.shutdown()
    expect(retry.pending.size).toBe(0)
    expect(closes).toBe(2)
  } finally {
    await host.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

test("lock contention retries acquisition without opening a second bridge", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  const retry = retries()
  let connections = 0
  const create = async () => createRemoteConnector({
    directory, notice: "Owner access",
    makeBridge: () => ({ connect: async () => { connections++ }, close: async () => {} }),
  })
  const owner = await create()
  const host = await createRemoteHost({ file: path.join(directory, "remote.json"), create, scheduleRetry: retry.schedule })
  try {
    await owner.start()
    await host.set(true)
    await waitFor(() => retry.pending.size === 1)
    expect(await host.status()).toMatchObject({ state: "connecting", message: expect.stringContaining(`PID ${process.pid}`) })
    expect(connections).toBe(1)
    await owner.stop()
    retry.run()
    await waitFor(() => connections === 2)
    expect(await host.status()).toEqual({ state: "on" })
  } finally {
    await host.shutdown()
    await owner.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("disable cancels retry and stale creation cannot start a connector", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  const retry = retries()
  const creating = Promise.withResolvers<ReturnType<typeof createRemoteConnector>>()
  let connections = 0
  const host = await createRemoteHost({ file: path.join(directory, "remote.json"), create: () => creating.promise, scheduleRetry: retry.schedule })
  try {
    await host.set(true)
    expect(await host.set(false)).toEqual({ state: "off" })
    creating.resolve(createRemoteConnector({
      directory, notice: "Owner access",
      makeBridge: () => ({ connect: async () => { connections++ }, close: async () => {} }),
    }))
    await host.shutdown()
    expect(connections).toBe(0)
    expect(await host.status()).toEqual({ state: "off" })
    expect(retry.pending.size).toBe(0)
    expect(await Bun.file(path.join(directory, "remote.json")).json()).toEqual({ enabled: false })
  } finally {
    await host.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

test("disable during recovery cancels the scheduled retry and shutdown preserves enabled intent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  const retry = retries()
  let creates = 0
  const host = await createRemoteHost({ file: path.join(directory, "remote.json"), scheduleRetry: retry.schedule,
    create: async () => { creates++; throw new Error("network down") },
  })
  try {
    await host.set(true)
    await waitFor(() => retry.pending.size === 1)
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      expect([...retry.pending.values()]).toEqual([delay])
      retry.run()
      await waitFor(() => retry.pending.size === 1)
    }
    await host.set(false)
    expect(retry.pending.size).toBe(0)
    expect(creates).toBe(8)
    await host.set(true)
    await waitFor(() => retry.pending.size === 1)
    await host.shutdown()
    expect(retry.pending.size).toBe(0)
    expect(await Bun.file(path.join(directory, "remote.json")).json()).toEqual({ enabled: true })
  } finally {
    await host.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

test("shutdown waits for cancelled creation from an earlier enabled generation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  const creating = Promise.withResolvers<ReturnType<typeof createRemoteConnector>>()
  const stale = createRemoteConnector({ directory, notice: "Owner access", makeBridge: () => ({ connect: async () => {}, close: async () => {} }) })
  let creates = 0
  const host = await createRemoteHost({
    file: path.join(directory, "remote.json"),
    create: async () => ++creates === 1 ? creating.promise : createRemoteConnector({
      directory, notice: "Owner access", makeBridge: () => ({ connect: async () => {}, close: async () => {} }),
    }),
  })
  try {
    await host.set(true)
    await host.set(false)
    await host.set(true)
    const shutdown = host.shutdown()
    const result = await Promise.race([shutdown.then(() => "shutdown"), Bun.sleep(10).then(() => "pending")])
    expect(result).toBe("pending")
    creating.resolve(stale)
    await shutdown
    expect(await host.status()).toEqual({ state: "off" })
  } finally {
    creating.resolve(stale)
    await host.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

test("explicit enable after repaired enrollment creates a fresh connector without automatic auth retries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-host-"))
  const retry = retries()
  let authorized = false
  let creates = 0
  let connections = 0
  const host = await createRemoteHost({
    file: path.join(directory, "remote.json"), scheduleRetry: retry.schedule,
    create: async () => {
      creates++
      const enrolled = authorized
      return createRemoteConnector({
        directory, notice: "Owner access",
        makeBridge: () => ({
          connect: async () => { connections++; if (!enrolled) throw new DeviceAuthorizationError(403) },
          close: async () => {},
        }),
      })
    },
  })
  try {
    await host.set(true)
    await waitFor(() => connections === 1)
    await waitFor(async () => (await host.status()).state === "error")
    expect(retry.pending.size).toBe(0)
    expect(creates).toBe(1)
    authorized = true
    await host.set(true)
    await waitFor(async () => (await host.status()).state === "on")
    expect(creates).toBe(2)
    expect(connections).toBe(2)
  } finally {
    await host.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
