import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sessionFixture, v5Server } from "./fixture/v5-server"
import { createSession, password, startServer } from "./remote-harness"

async function run(args: string[], root?: string) {
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dirname, "../src/index.ts"), ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, YCODING_PASSWORD: password, ...(root ? { XDG_STATE_HOME: path.join(root, "state") } : {}) },
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test("remote help exposes backend enrollment and controls without per-Session access commands", async () => {
  const result = await run(["remote", "--help"])
  expect(result.exitCode).toBe(0)
  for (const name of ["enroll", "connect", "disconnect", "status", "sessions", "mcp"])
    expect(result.stdout).toContain(name)
  for (const name of ["allow", "deny"]) expect(result.stdout).not.toContain(`  ${name}`)
})

test("remote status reads only the backend device projection, not frontend credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-cli-device-"))
  await mkdir(path.join(root, "state/ycoding"), { recursive: true })
  await writeFile(path.join(root, "state/ycoding/remote-device.json"), "not a credential")
  const server = v5Server((name) => {
    if (name === "health.get")
      return { data: { healthy: true, version: "local", pid: process.pid, sourceEpoch: "source_fixture" } }
    if (name === "remote.get") return { data: { state: "off" } }
    throw new Error(name)
  })
  try {
    const result = await run(["remote", "status", "--server", server.url], root)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain("Not enrolled")
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("connect grants every existing and future Session to the owner and disconnect controls the same backend", async () => {
  let state = "off"
  const enabled: boolean[] = []
  const device = {
    name: "Fixture",
    deviceID: "dev_fixture",
    relayOrigin: "https://relay.example",
    enrolledAt: 1,
    credentialState: "not_authenticated",
  }
  const server = v5Server((name, data) => {
    if (name === "health.get")
      return { data: { healthy: true, version: "local", pid: process.pid, sourceEpoch: "source_fixture" } }
    if (name === "remote.get") return { data: { state, device } }
    if (name === "remote.set") {
      if (
        typeof data !== "object" ||
        data === null ||
        !("payload" in data) ||
        typeof data.payload !== "object" ||
        data.payload === null ||
        !("enabled" in data.payload) ||
        typeof data.payload.enabled !== "boolean"
      )
        throw new Error("Invalid control")
      enabled.push(data.payload.enabled)
      state = data.payload.enabled ? "on" : "off"
      return { data: { state } }
    }
    throw new Error(name)
  })
  try {
    const mismatched = await run(["remote", "connect", "--server", server.url, "--relay", "https://other.example"])
    expect(mismatched.exitCode).toBe(1)
    expect(enabled).toEqual([])
    const connected = await run(["remote", "connect", "--server", server.url])
    expect(connected.exitCode, connected.stderr).toBe(0)
    expect(connected.stdout).toContain("all existing and future backend Sessions are available to its owner")
    expect(connected.stdout).toContain("Remote connection on")
    const disconnected = await run(["remote", "disconnect", "--server", server.url])
    expect(disconnected.exitCode, disconnected.stderr).toBe(0)
    expect(disconnected.stdout).toContain("Remote connection off")
    expect(enabled).toEqual([true, false])
  } finally {
    await server.close()
  }
})

test("remote CLI uses a real Rust backend for enrollment status and complete Session inventory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-cli-inventory-"))
  const server = await startServer(directory)
  try {
    const status = await run(["remote", "status", "--server", server.base])
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).toContain("Not enrolled")
    const empty = await run(["remote", "sessions", "--server", server.base])
    expect(empty.exitCode, empty.stderr).toBe(0)
    expect(empty.stdout).toContain("The backend has no Sessions")
    await createSession(server, "ses_cli_shared", directory)
    const listed = await run(["remote", "sessions", "--server", server.base])
    expect(listed.exitCode, listed.stderr).toBe(0)
    expect(listed.stdout).toContain("ses_cli_shared")
    expect(listed.stdout).toContain(directory)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("remote sessions follows every opaque backend inventory page", async () => {
  const cursors: unknown[] = []
  const server = v5Server((name, data) => {
    if (name === "health.get")
      return { data: { healthy: true, version: "local", pid: process.pid, sourceEpoch: "source-1" } }
    if (name !== "session.list") throw new Error(name)
    const query = typeof data === "object" && data !== null && "query" in data ? data.query : undefined
    const cursor = typeof query === "object" && query !== null && "cursor" in query ? query.cursor : undefined
    cursors.push(cursor)
    return cursor === undefined
      ? { data: { data: [sessionFixture("ses_page_a", "/page/a")], cursor: { next: "opaque-page-two" } } }
      : { data: { data: [sessionFixture("ses_page_b", "/page/b")], cursor: {} } }
  })
  try {
    const result = await run(["remote", "sessions", "--server", server.url])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain("ses_page_a")
    expect(result.stdout).toContain("ses_page_b")
    expect(cursors).toEqual([undefined, "opaque-page-two"])
  } finally {
    await server.close()
  }
})

test("relay MCP controls the same backend without enabling Remote and states its authority", async () => {
  let remote: "off" | "on" = "off"
  let enrolled = false
  let mcp: { state: "off" | "on" | "error"; message?: string; url?: string } = { state: "off" }
  const url = "https://relay.example/api/mcp/devices/dev_fixture"
  const writes: { remote: unknown[]; mcp: unknown[] } = { remote: [], mcp: [] }
  const device = {
    name: "Fixture",
    deviceID: "dev_fixture",
    relayOrigin: "https://relay.example",
    enrolledAt: 1,
    credentialState: "not_authenticated",
  }
  const server = v5Server((name, data) => {
    if (name === "health.get")
      return { data: { healthy: true, version: "local", pid: process.pid, sourceEpoch: "source_fixture" } }
    if (name === "remote.get") return { data: { state: remote, ...(enrolled ? { device } : {}) } }
    if (name === "remote.set") {
      writes.remote.push(data)
      return { data: { state: remote } }
    }
    if (name === "remote.mcp.get") return { data: mcp }
    if (name === "remote.mcp.set") {
      const enabled = (data as { payload: { enabled: boolean } }).payload.enabled
      writes.mcp.push(enabled)
      if (mcp.state === "error") return { data: mcp }
      mcp = enabled ? { state: "on", url } : { state: "off" }
      return { data: mcp }
    }
    throw new Error(name)
  })
  try {
    const help = await run(["remote", "mcp", "--help"])
    expect(help.exitCode, help.stderr).toBe(0)
    for (const name of ["on", "off", "status"]) expect(help.stdout).toContain(name)

    const unenrolled = await run(["remote", "mcp", "on", "--server", server.url])
    expect(unenrolled.exitCode).not.toBe(0)
    expect(unenrolled.stdout + unenrolled.stderr).toContain("ycoding remote enroll")

    enrolled = true
    const dependency = await run(["remote", "mcp", "on", "--server", server.url])
    expect(dependency.exitCode).not.toBe(0)
    expect(dependency.stdout + dependency.stderr).toContain("ycoding remote connect")
    expect(writes).toEqual({ remote: [], mcp: [] })

    const idle = await run(["remote", "mcp", "status", "--server", server.url])
    expect(idle.exitCode, idle.stderr).toBe(0)
    expect(idle.stdout).toContain("Relay MCP  off")

    remote = "on"
    const on = await run(["remote", "mcp", "on", "--server", server.url])
    expect(on.exitCode, on.stderr).toBe(0)
    for (const phrase of ["every existing and future Session", "below your home", "Always approvals", "YOLO"])
      expect(on.stdout.replace(/\s+/g, " ")).toContain(phrase)
    expect(on.stdout).toContain(url)
    expect(writes.mcp).toEqual([true])

    const status = await run(["remote", "mcp", "status", "--server", server.url])
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).toContain("Relay MCP  on")
    expect(status.stdout).toContain(url)

    const off = await run(["remote", "mcp", "off", "--server", server.url])
    expect(off.exitCode, off.stderr).toBe(0)
    expect(off.stdout).toContain("Relay MCP off.")
    expect(writes).toEqual({ remote: [], mcp: [true, false] })

    mcp = { state: "error", message: "relay revocation unconfirmed" }
    const failed = await run(["remote", "mcp", "status", "--server", server.url])
    expect(failed.exitCode, failed.stderr).toBe(0)
    expect(failed.stdout).toContain("Relay MCP  error · relay revocation unconfirmed")
    const failedOff = await run(["remote", "mcp", "off", "--server", server.url])
    expect(failedOff.exitCode).not.toBe(0)
  } finally {
    await server.close()
  }
}, 60_000)
