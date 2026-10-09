/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

test("ignored configuration diagnostics appear in a toast and the Status dialog", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-config-diagnostics-"))
  const directory = "/tmp/ycoding/config-diagnostics"
  const diagnostic = {
    path: "/home/user/.config/ycoding/ycoding.jsonc",
    reason: "invalid-values",
    message: "The default agent value is invalid\nAdditional details",
  }
  const screen = await renderScreen({
    width: 100,
    height: 60,
    state,
    settle: "Message YCoding…",
    route: (url) => {
      const location = { directory, project: { id: "proj_config_diagnostics", directory } }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/config/diagnostics") return json({ location, data: [diagnostic] })
      if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main" } })
      if (["/api/agent", "/api/model", "/api/provider", "/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
        return json({ location, data: [] })
      return undefined
    },
  })
  const until = async (text: string) => {
    const deadline = Date.now() + 5_000
    while (!screen.frame().includes(text) && Date.now() < deadline) await Bun.sleep(10)
    expect(screen.frame()).toContain(text)
  }
  try {
    await until("Configuration file ignored")
    await until("ycoding.jsonc")
    expect(screen.frame()).toContain("default agent value is invalid")
    screen.input.pressKey("p", { ctrl: true })
    await until("Commands")
    await screen.input.typeText("View status")
    screen.input.pressEnter()
    await until("   Status")
    await screen.input.typeText("Configuration")
    await until("invalid-values")
    expect(screen.frame()).toContain("default agent value is invalid")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)
