/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { renderScreen } from "./harness"
import { json } from "../fixture/tui-client"
import type { RemoteStatus } from "../../src/remote-connector"

test("the full TUI shows one server remote switch without a bottom remote line", async () => {
  const directory = "/tmp/ycoding/remote-status"
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-screen-"))
  let status: RemoteStatus = { state: "off" }
  const writes: boolean[] = []
  const screen = await renderScreen({
    width: 80, height: 24, settle: "Message YCoding…", state,
    route: (url) => {
      const location = { directory, project: { id: "proj_remote", directory } }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main" } })
      if (url.pathname === "/api/remote/mcp") return json({ data: { state: "off" } })
      if (["/api/agent", "/api/model", "/api/provider", "/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
        return json({ location, data: [] })
      return undefined
    },
    remote: {
      get: async () => status,
      set: async (enabled) => { writes.push(enabled); status = { state: enabled ? "on" : "off" }; return status },
    },
  })
  try {
    expect(screen.frame()).not.toMatch(/remote (?:off|on|connecting|error)/)
    screen.input.pressKey("p", { ctrl: true })
    const opened = Date.now() + 5_000
    while (Date.now() < opened && !screen.frame().includes("Commands")) await Bun.sleep(10)
    await screen.input.typeText("Remote connection")
    const shown = Date.now() + 5_000
    while (Date.now() < shown && !screen.frame().includes("● off")) await Bun.sleep(10)
    expect(screen.frame().match(/Remote connection/g)?.length).toBeGreaterThanOrEqual(1)
    screen.input.pressEnter()
    const connected = Date.now() + 5_000
    while (Date.now() < connected && !screen.frame().includes("Connecting grants the machine owner access")) await Bun.sleep(10)
    expect(writes).toEqual([true])
    expect(screen.frame()).not.toMatch(/remote (?:off|on|connecting|error)/)
    screen.input.pressKey("p", { ctrl: true })
    const reopen = Date.now() + 5_000
    while (Date.now() < reopen && !screen.frame().includes("Commands")) await Bun.sleep(10)
    await screen.input.typeText("Remote connection")
    const on = Date.now() + 5_000
    while (Date.now() < on && !screen.frame().includes("● on")) await Bun.sleep(10)
    expect(screen.frame()).not.toContain("elsewhere")
    screen.input.pressEnter()
    const stopped = Date.now() + 5_000
    while (Date.now() < stopped && (writes.length < 2 || screen.frame().includes("Commands"))) await Bun.sleep(10)
    expect(writes).toEqual([true, false])
    status = { state: "error", message: "synthetic relay failure" }
    screen.input.pressKey("p", { ctrl: true })
    const palette = Date.now() + 5_000
    while (Date.now() < palette && !screen.frame().includes("Commands")) await Bun.sleep(10)
    await screen.input.typeText("View status")
    screen.input.pressEnter()
    const openedStatus = Date.now() + 5_000
    while (Date.now() < openedStatus && !screen.frame().includes("   Status")) await Bun.sleep(10)
    await screen.input.typeText("Remote")
    const detail = Date.now() + 5_000
    while (Date.now() < detail && !screen.frame().includes("synthetic relay failure")) await Bun.sleep(10)
    expect(screen.frame()).toContain("synthetic relay failure")
    expect(screen.frame()).not.toContain("on elsewhere")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("Status shows the Relay MCP state, error guidance, and the full wrapped device URL", async () => {
  const directory = "/tmp/ycoding/remote-mcp-status"
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-mcp-screen-"))
  const url = "https://relay.example/api/mcp/devices/dev_0123456789abcdef0123456789abcdef"
  let mcp: { state: string; message?: string; url?: string } = { state: "on", url }
  const screen = await renderScreen({
    width: 80, height: 24, settle: "Message YCoding…", state,
    route: (request) => {
      const location = { directory, project: { id: "proj_remote_mcp", directory } }
      if (request.pathname === "/api/location") return json(location)
      if (request.pathname === "/api/vcs/branch") return json({ location, data: { current: "main" } })
      if (request.pathname === "/api/remote/mcp") return json({ data: mcp })
      if (["/api/agent", "/api/model", "/api/provider", "/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(request.pathname))
        return json({ location, data: [] })
      return undefined
    },
  })
  const status = async (needle: string) => {
    screen.input.pressKey("p", { ctrl: true })
    const opened = Date.now() + 5_000
    while (Date.now() < opened && !screen.frame().includes("Commands")) await Bun.sleep(10)
    await screen.input.typeText("View status")
    screen.input.pressEnter()
    const shown = Date.now() + 5_000
    while (Date.now() < shown && !screen.frame().includes("   Status")) await Bun.sleep(10)
    await screen.input.typeText("Relay MCP")
    const detail = Date.now() + 5_000
    while (Date.now() < detail && !screen.frame().replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""))) await Bun.sleep(10)
    return screen.frame()
  }
  try {
    const on = await status(url)
    expect(on).toContain("Relay MCP")
    expect(on.replace(/\s+/g, "")).toContain(url)
    expect(on).toContain("on")
    screen.input.pressEscape()
    mcp = { state: "error", message: "Remote is off; run `ycoding remote connect` first" }
    const error = await status("ycoding remote connect")
    expect(error).toContain("Relay MCP")
    expect(error.replace(/\s+/g, " ")).toContain("ycoding remote connect")
    expect(error).toContain("error")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)
