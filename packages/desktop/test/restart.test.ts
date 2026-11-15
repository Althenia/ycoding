import { expect, test } from "bun:test"
import { BackendRestart, type RestartPorts } from "../src/restart"

function fixture(mode: "own" | "shared" = "shared") {
  const calls: string[] = []
  const state = { generation: 1, status: "connected" as const, mode, revision: 7, backendPID: 42 }
  const ports: RestartPorts = {
    state: () => state,
    selection: { mode },
    endpoint: { url: "http://127.0.0.1:1234/" },
    command: ["/synthetic/backend/ycoding", "serve", "--service"],
    version: "1.18.4",
    current: () => true,
    disconnect: async () => { calls.push("disconnect") },
    connect: async (selection) => { calls.push(`connect:${selection.mode}`); return { ...state, revision: 8 } },
    service: {
      discover: async () => { calls.push("discover"); return { url: "http://127.0.0.1:1234/" } },
      stop: async (options) => { expect(options).toEqual({ expected: { url: "http://127.0.0.1:1234/", pid: 42 } }); calls.push("stop") },
      ensure: async (options) => { expect(options).toEqual({ command: ports.command, version: "1.18.4" }); calls.push("ensure"); return { url: "http://127.0.0.1:5678/" } },
    },
  }
  return { calls, ports }
}

test("private restart reconnects only its owned backend without touching the shared service", async () => {
  const { calls, ports } = fixture("own")
  expect(await new BackendRestart().run({ revision: 7 }, ports)).toMatchObject({ status: "connected", revision: 8 })
  expect(calls).toEqual(["disconnect", "connect:own"])
})

test("registered shared restart stops once, ensures the bundled service and reconnects", async () => {
  const { calls, ports } = fixture()
  expect(await new BackendRestart().run({ revision: 7 }, ports)).toMatchObject({ status: "connected", revision: 8 })
  expect(calls).toEqual(["discover", "disconnect", "stop", "ensure", "connect:shared"])
})

test("remote and unregistered loopback endpoints cannot restart the local service", async () => {
  for (const url of ["https://example.invalid/", "http://127.0.0.1:9999/"]) {
    const { calls, ports } = fixture()
    ports.endpoint = { url }
    await expect(new BackendRestart().run({ revision: 7 }, ports)).rejects.toThrow(/registered local service/)
    expect(calls).not.toContain("stop")
    expect(calls).not.toContain("disconnect")
  }
})

test("shared restart refuses mismatched authentication without stopping anything", async () => {
  const { calls, ports } = fixture()
  ports.endpoint = { url: ports.endpoint.url, auth: { type: "basic", username: "synthetic", password: "test-only" } }
  await expect(new BackendRestart().run({ revision: 7 }, ports)).rejects.toThrow(/registered local service/)
  expect(calls).toEqual(["discover"])
})

test("invalid or stale restart requests perform no external operations", async () => {
  for (const input of [{ revision: 6 }, { revision: -1 }, { revision: 7, server: "http://other.invalid" }, null]) {
    const { calls, ports } = fixture()
    await expect(new BackendRestart().run(input, ports)).rejects.toThrow()
    expect(calls).toEqual([])
  }
})

test("shared restart requires the connected process identity before disconnecting", async () => {
  const { calls, ports } = fixture()
  ports.state = () => ({ generation: 1, status: "connected", mode: "shared", revision: 7 })
  await expect(new BackendRestart().run({ revision: 7 }, ports)).rejects.toThrow(/identity is unavailable/)
  expect(calls).toEqual([])
})

test("a changed connection during discovery blocks every restart mutation", async () => {
  const { calls, ports } = fixture()
  ports.current = () => false
  await expect(new BackendRestart().run({ revision: 7 }, ports)).rejects.toThrow(/changed/)
  expect(calls).toEqual(["discover"])
})

test("an unconfirmed service stop never proceeds to start or reconnect", async () => {
  const { calls, ports } = fixture()
  ports.service.stop = async () => { calls.push("stop"); throw new Error("synthetic stop failed") }
  await expect(new BackendRestart().run({ revision: 7 }, ports)).rejects.toThrow(/stop.*unconfirmed/)
  expect(calls).toEqual(["discover", "disconnect", "stop"])
})

test("a second restart cannot duplicate an in-flight service stop", async () => {
  const { calls, ports } = fixture()
  const gate = Promise.withResolvers<void>()
  const reached = Promise.withResolvers<void>()
  ports.service.stop = async () => { calls.push("stop"); reached.resolve(); await gate.promise }
  const restart = new BackendRestart()
  const pending = restart.run({ revision: 7 }, ports)
  await reached.promise
  await expect(restart.run({ revision: 7 }, ports)).rejects.toThrow(/already/)
  gate.resolve()
  await pending
  expect(calls.filter((call) => call === "stop")).toHaveLength(1)
})

test("a connection change after any retirement step prevents further restart operations", async () => {
  for (const stage of ["disconnect", "stop", "ensure"] as const) {
    const { calls, ports } = fixture()
    let current = true
    ports.current = () => current
    if (stage === "disconnect") ports.disconnect = async () => { calls.push("disconnect"); current = false }
    if (stage === "stop") ports.service.stop = async () => { calls.push("stop"); current = false }
    if (stage === "ensure") ports.service.ensure = async () => { calls.push("ensure"); current = false; return ports.endpoint }
    await expect(new BackendRestart().run({ revision: 7 }, ports)).rejects.toThrow(/changed/)
    expect(calls).not.toContain("connect:shared")
    if (stage !== "ensure") expect(calls).not.toContain("ensure")
    if (stage === "disconnect") expect(calls).not.toContain("stop")
  }
})
