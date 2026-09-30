/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { renderScreen } from "./harness"
import { json } from "../fixture/tui-client"
import type { KeepAwakeStatus } from "../../src/keep-awake"

test("the full TUI offers one Keep machine awake switch and lists its backend state in Status", async () => {
  const directory = "/tmp/ycoding/keep-awake-status"
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-keep-awake-screen-"))
  let status: KeepAwakeStatus = { state: "off" }
  const writes: boolean[] = []
  const screen = await renderScreen({
    width: 80, height: 24, settle: "Message YCoding…", state,
    route: (url) => {
      const location = { directory, project: { id: "proj_keep_awake", directory } }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main" } })
      if (["/api/agent", "/api/model", "/api/provider", "/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
        return json({ location, data: [] })
      return undefined
    },
    keepAwake: {
      get: async () => status,
      set: async (enabled) => { writes.push(enabled); status = { state: enabled ? "on" : "off" }; return status },
    },
  })
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !condition()) await Bun.sleep(10)
  }
  try {
    screen.input.pressKey("p", { ctrl: true })
    await until(() => screen.frame().includes("Commands"))
    await screen.input.typeText("Keep machine awake")
    await until(() => screen.frame().includes("● off"))
    expect(screen.frame()).toContain("Keep machine awake")
    screen.input.pressEnter()
    await until(() => writes.length === 1)
    expect(writes).toEqual([true])
    await until(() => screen.frame().includes("Idle sleep only"))
    expect(screen.frame()).toContain("Idle sleep only; manual sleep and lid still apply.")

    status = { state: "error", message: "synthetic inhibitor failure" }
    screen.input.pressKey("p", { ctrl: true })
    await until(() => screen.frame().includes("Commands"))
    await screen.input.typeText("View status")
    screen.input.pressEnter()
    await until(() => screen.frame().includes("   Status"))
    await screen.input.typeText("Keep awake")
    await until(() => screen.frame().includes("synthetic inhibitor failure"))
    expect(screen.frame()).toContain("Keep awake")
    expect(screen.frame()).toContain("synthetic inhibitor failure")
    expect(screen.frame()).toContain("error")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("Status remains Checking until the initial backend read reports On", async () => {
  const initial = Promise.withResolvers<KeepAwakeStatus>()
  const writes: boolean[] = []
  const screen = await renderScreen({
    width: 80, height: 24, settle: "Message YCoding…",
    keepAwake: {
      get: () => initial.promise,
      set: async (enabled) => { writes.push(enabled); return { state: enabled ? "on" : "off" } },
    },
  })
  const frame = async (text: string) => {
    const deadline = Date.now() + 5_000
    while (!screen.frame().includes(text) && Date.now() < deadline) await Bun.sleep(10)
    expect(screen.frame()).toContain(text)
  }
  try {
    screen.input.pressKey("p", { ctrl: true })
    await frame("Commands")
    await screen.input.typeText("View status")
    screen.input.pressEnter()
    await frame("   Status")
    await screen.input.typeText("Keep awake")
    await frame("Checking")
    expect(screen.lines().some((line) => line.includes("Keep awake") && /\boff\b/.test(line))).toBe(false)
    expect(writes).toEqual([])
    initial.resolve({ state: "on" })
    const deadline = Date.now() + 5_000
    while (screen.frame().includes("Checking") && Date.now() < deadline) await Bun.sleep(10)
    expect(screen.lines().some((line) => line.includes("Keep awake") && /\bon\b/.test(line))).toBe(true)
    expect(screen.frame()).not.toContain("Checking")
    expect(writes).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)
