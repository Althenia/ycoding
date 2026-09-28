import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createRemoteHost } from "../src/remote-host"
import { createRemoteConnector } from "../src/commands/handlers/remote/connector"
import { startServer } from "./remote-harness"

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
    while (Date.now() < deadline && (await host.status()).state !== "error") await Bun.sleep(10)
    expect(await host.status()).toMatchObject({ state: "error", message: expect.stringContaining(`PID ${process.pid}`) })
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
      throw new Error("This machine is not enrolled; run `ycoding remote enroll <enrollmentID>` first")
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
