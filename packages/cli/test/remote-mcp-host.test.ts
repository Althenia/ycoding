import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRemoteMcpHost } from "../src/remote-mcp-host"

test("relay MCP starts off and requires the existing Remote connection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-host-"))
  try {
    const host = await createRemoteMcpHost({ file: path.join(directory, "mcp.json"), remote: () => "off" })
    expect(host.status()).toEqual({ state: "off" })
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
    expect(await disabled).toEqual({ state: "off" })
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
    expect(restored.status()).toEqual({ state: "off" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
