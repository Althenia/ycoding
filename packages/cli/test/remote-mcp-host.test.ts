import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRemoteMcpHost } from "../src/remote-mcp-host"

test("MCP client capability diagnostics are volatile and never restore authority", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  const file = path.join(directory, "mcp.json")
  try {
    const host = await createRemoteMcpHost({ file, remote: () => "on" })
    expect(host.status().clientCapabilities).toBeUndefined()
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async () => {})
    await host.set(true)
    const observed = [{ protocolVersion: "2026-07-28", elicitation: false, form: false, url: false, observedAt: 0 }]
    host.setClientCapabilities(observed)
    expect(host.status().clientCapabilities).toEqual(observed)
    host.setLaneHold(true)
    host.detach()
    expect(host.status().clientCapabilities).toBeUndefined()
    host.setClientCapabilities(observed)
    expect(host.status().clientCapabilities).toBeUndefined()
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async () => {})
    expect(host.status().message).toContain("read-only")
    expect(host.status().clientCapabilities).toBeUndefined()
    const restored = await createRemoteMcpHost({ file, remote: () => "on" })
    expect(restored.status().clientCapabilities).toBeUndefined()
    await host.set(false)
    expect(host.status().clientCapabilities).toBeUndefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("relay MCP starts off and requires the existing Remote connection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  try {
    const host = await createRemoteMcpHost({ file: path.join(directory, "mcp.json"), remote: () => "off" })
    expect(host.status()).toEqual({ state: "off", message: expect.stringContaining("fresh sign-in") })
    expect(await host.set(true)).toMatchObject({ state: "error", message: expect.stringContaining("ycoding remote connect") })
    expect(host.advertisement().enabled).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("relay MCP persists enablement and stable resource across restart without enabling Remote", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  const file = path.join(directory, "mcp.json")
  const url = "https://relay.example.invalid/api/mcp/devices/dev_test"
  try {
    const host = await createRemoteMcpHost({ file, remote: () => "on" })
    const states: { enabled: boolean; epoch: string }[] = []
    await host.attach(url, async (state) => { states.push(state) })
    expect(await host.set(true)).toEqual({ state: "on", url })
    const epoch = host.advertisement().epoch
    host.detach()
    expect(host.status().state).toBe("connecting")
    const restored = await createRemoteMcpHost({ file, remote: () => "connecting" })
    expect(restored.advertisement()).toEqual({ enabled: true, epoch })
    await restored.attach(url, async (state) => { states.push(state) })
    expect(restored.status()).toEqual({ state: "on", url })
    expect(states.at(-1)).toEqual({ enabled: true, epoch })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("off retires authority before relay acknowledgement and on starts a new epoch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  try {
    const host = await createRemoteMcpHost({ file: path.join(directory, "mcp.json"), remote: () => "on" })
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async () => {})
    await host.set(true)
    const epoch = host.advertisement().epoch
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async (state) => {
      if (state.enabled) return
      entered.resolve()
      await release.promise
    })
    const disabled = host.set(false)
    await entered.promise
    expect(host.allowed(epoch)).toBe(false)
    release.resolve()
    expect(await disabled).toEqual({ state: "off", message: expect.stringContaining("fresh sign-in") })
    await host.set(true)
    expect(host.advertisement().epoch).not.toBe(epoch)
    expect(host.allowed(epoch)).toBe(false)
  } finally { release.resolve(); await rm(directory, { recursive: true, force: true }) }
})

test("a late enable acknowledgement cannot reopen a detached connector", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  try {
    const host = await createRemoteMcpHost({ file: path.join(directory, "mcp.json"), remote: () => "on" })
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async (state) => {
      if (!state.enabled) return
      entered.resolve()
      await release.promise
    })
    const enabled = host.set(true)
    await entered.promise
    host.detach()
    release.resolve()
    await enabled
    expect(host.status().state).toBe("connecting")
    expect(host.allowed(host.advertisement().epoch)).toBe(false)
  } finally { release.resolve(); await rm(directory, { recursive: true, force: true }) }
})

test("unconfirmed off remains closed and is advertised before future access", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  const file = path.join(directory, "mcp.json")
  try {
    const host = await createRemoteMcpHost({ file, remote: () => "on" })
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async () => {})
    await host.set(true)
    host.detach()
    expect((await host.set(false)).state).toBe("error")
    host.detach()
    expect(host.status().state).toBe("error")
    expect((await host.set(false)).state).toBe("error")
    const restored = await createRemoteMcpHost({ file, remote: () => "connecting" })
    expect(restored.status().state).toBe("error")
    const states: boolean[] = []
    await restored.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async (state) => { states.push(state.enabled) })
    expect(states).toEqual([false])
    expect(restored.status()).toEqual({ state: "off", message: expect.stringContaining("fresh sign-in") })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("outbound authority is cancelled synchronously on disable and replaced only after acknowledgement", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-authority-"))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    const host = await createRemoteMcpHost({ file: path.join(directory, "mcp.json"), remote: () => "on" })
    expect(host.authorizationSignal().aborted).toBe(true)
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async () => {})
    await host.set(true)
    const original = host.authorizationSignal()
    expect(original.aborted).toBe(false)
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async (state) => {
      if (state.enabled) return
      entered.resolve()
      await release.promise
    })
    expect(original.aborted).toBe(true)
    const active = host.authorizationSignal()
    expect(active.aborted).toBe(false)
    const pending = host.set(false)
    expect(active.aborted).toBe(true)
    await entered.promise
    expect(host.authorizationSignal().aborted).toBe(true)
    release.resolve()
    await pending
    await host.set(true)
    expect(host.authorizationSignal()).not.toBe(active)
    expect(host.authorizationSignal().aborted).toBe(false)
    host.detach()
    expect(host.authorizationSignal().aborted).toBe(true)
  } finally {
    release.resolve()
    await rm(directory, { recursive: true, force: true })
  }
})

test("a failed relay acknowledgement never restores outbound authority", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-authority-"))
  try {
    const host = await createRemoteMcpHost({ file: path.join(directory, "mcp.json"), remote: () => "on" })
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async () => {})
    await host.set(true)
    const active = host.authorizationSignal()
    await host.attach("https://relay.example.invalid/api/mcp/devices/dev_test", async () => { throw new Error("fixture disconnect") })
    expect(active.aborted).toBe(true)
    expect(host.authorizationSignal().aborted).toBe(true)
    expect(host.allowed(host.advertisement().epoch)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const laneHoldMessage = "MCP lane read-only; recovery needed."

test("lane hold adds recovery guidance only while relay MCP is on and keeps the device URL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  const url = "https://relay.example.invalid/api/mcp/devices/dev_test"
  try {
    const host = await createRemoteMcpHost({ file: path.join(directory, "mcp.json"), remote: () => "on" })
    host.setLaneHold(true)
    expect(host.status()).toEqual({ state: "off", message: expect.stringContaining("fresh sign-in") })
    await host.attach(url, async () => {})
    await host.set(true)
    expect(host.status()).toEqual({ state: "on", url, message: laneHoldMessage })
    host.setLaneHold(false)
    expect(host.status()).toEqual({ state: "on", url })
    host.setLaneHold(true)
    expect(host.allowed(host.advertisement().epoch)).toBe(true)
    expect(host.advertisement().enabled).toBe(true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("lane hold never overrides error or connecting messages and survives detach and reattach", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  const url = "https://relay.example.invalid/api/mcp/devices/dev_test"
  try {
    const host = await createRemoteMcpHost({ file: path.join(directory, "mcp.json"), remote: () => "on" })
    await host.attach(url, async () => {})
    await host.set(true)
    host.setLaneHold(true)
    host.detach()
    expect(host.status()).toEqual({ state: "connecting" })
    await host.attach(url, async () => {})
    expect(host.status()).toEqual({ state: "on", url, message: laneHoldMessage })
    await host.attach(url, async () => { throw new Error("unconfirmed") })
    expect(host.status()).toMatchObject({ state: "error", message: expect.stringContaining("could not be confirmed") })
    expect(host.status().message).not.toBe(laneHoldMessage)
    await host.attach(url, async () => {})
    expect(host.status()).toEqual({ state: "on", url, message: laneHoldMessage })
    host.setLaneHold(false)
    expect(host.status()).toEqual({ state: "on", url })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
