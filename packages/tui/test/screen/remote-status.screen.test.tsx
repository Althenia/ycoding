/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { renderScreen } from "./harness"
import { json } from "../fixture/tui-client"
import type { RemoteStatus } from "../../src/remote-connector"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("remote control lives in one palette row, not the bottom footer, and View status keeps failures", async () => {
  const directory = "/tmp/ycoding/remote-status"
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-screen-"))
  let status: RemoteStatus = { state: "off" }
  let starts = 0
  const listeners = new Set<(value: RemoteStatus) => void>()
  const emit = (next: RemoteStatus) => { status = next; listeners.forEach((listener) => listener(next)) }
  const screen = await renderScreen({
    width: 80, height: 24, settle: "Message YCoding…", state,
    route: (url) => {
      const location = { directory, project: { id: "proj_remote", directory } }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main" } })
      if (["/api/agent", "/api/model", "/api/provider", "/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
        return json({ location, data: [] })
      return undefined
    },
    remote: { create: async () => ({
      notice: "All backend Sessions are available to the owner.",
      status: () => status,
      subscribe: (listener) => { listeners.add(listener); listener(status); return () => { listeners.delete(listener) } },
      start: async () => { starts++; emit({ state: "on" }) },
      stop: async () => emit({ state: "off" }),
    }) },
  })
  try {
    expect(screen.frame()).not.toMatch(/remote (?:off|on elsewhere|on|connecting|error)/)
    screen.input.pressKey("p", { ctrl: true })
    const openedDeadline = Date.now() + 5_000
    while (Date.now() < openedDeadline && !screen.frame().includes("Commands")) await Bun.sleep(10)
    await screen.input.typeText("remote")
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !screen.frame().includes("Remote connection")) await Bun.sleep(10)
    expect(screen.frame()).toContain("Remote connection")
    expect(screen.frame().match(/Remote connection/g)).toHaveLength(1)
    expect(screen.frame()).not.toContain("Connect remote")
    expect(screen.frame()).not.toContain("Disconnect remote")
    screen.input.pressEnter()
    const connectedDeadline = Date.now() + 5_000
    while (Date.now() < connectedDeadline && !screen.frame().includes("All backend Sessions are available to the owner.")) await Bun.sleep(10)
    expect(starts).toBe(1)
    expect(screen.frame()).not.toMatch(/remote (?:off|on elsewhere|on|connecting|error)/)
    expect(screen.frame()).toContain("All backend Sessions are available to the owner.")
    emit({ state: "other-process", message: "Remote is on in another process (PID 1234)" })
    screen.input.pressKey("p", { ctrl: true })
    const contendedDeadline = Date.now() + 5_000
    while (Date.now() < contendedDeadline && !screen.frame().includes("Commands")) await Bun.sleep(10)
    await screen.input.typeText("Remote connection")
    screen.input.pressEnter()
    expect(starts).toBe(1)
    const noticeDeadline = Date.now() + 5_000
    while (Date.now() < noticeDeadline && !screen.frame().includes("Remote is on in another process (PID 1234)")) await Bun.sleep(10)
    expect(screen.frame()).toContain("Remote is on in another process (PID 1234)")
    screen.input.pressKey("p", { ctrl: true })
    const statusPaletteDeadline = Date.now() + 5_000
    while (Date.now() < statusPaletteDeadline && !screen.frame().includes("Commands")) await Bun.sleep(10)
    await screen.input.typeText("View status")
    screen.input.pressEnter()
    const openedStatusDeadline = Date.now() + 5_000
    while (Date.now() < openedStatusDeadline && !screen.frame().includes("   Status")) await Bun.sleep(10)
    await screen.input.typeText("Remote")
    const detailDeadline = Date.now() + 5_000
    while (Date.now() < detailDeadline && !screen.frame().includes("Remote is on in another process (PID 1234)")) await Bun.sleep(10)
    expect(screen.lines().some((line) => line.includes("Remote") && line.includes("PID 1234"))).toBe(true)
    emit({ state: "error", message: "synthetic relay failure" })
    const failedDeadline = Date.now() + 5_000
    while (Date.now() < failedDeadline && !screen.frame().includes("synthetic relay failure")) await Bun.sleep(10)
    expect(screen.lines().some((line) => line.includes("Remote") && line.includes("synthetic relay failure"))).toBe(true)
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 20_000)
