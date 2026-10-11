/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

for (const example of [
  { title: "Configuration file ignored", reason: "invalid-json", message: "Invalid JSON" },
  { title: "Configuration item dropped", reason: "invalid-values", jsonPath: "$.agents.god.steps", message: "Invalid value" },
  { title: "Configuration fails closed", reason: "invalid-values", jsonPath: "$.permissions[0]", failClosed: true, message: "Invalid rule; fails closed" },
] as const) {
  for (const width of [80, 100]) {
    test(`${example.title} shows diagnostic details in toast and Status at ${width} columns`, async () => {
      const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-config-diagnostics-"))
      const directory = "/tmp/ycoding/config-diagnostics"
      const diagnostic = {
        path: "/home/user/.config/ycoding/ycoding.jsonc",
        reason: example.reason,
        ...("jsonPath" in example ? { jsonPath: example.jsonPath } : {}),
        ...("failClosed" in example ? { failClosed: example.failClosed } : {}),
        message: example.message,
      }
      const screen = await renderScreen({
        width,
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
        await until(example.title)
        await until("ycoding.jsonc")
        if (example.jsonPath) expect(screen.frame()).toContain(example.jsonPath)
        if ("failClosed" in example) expect(screen.frame()).toContain("fails closed")
        screen.input.pressKey("p", { ctrl: true })
        await until("Commands")
        await screen.input.typeText("View status")
        screen.input.pressEnter()
        await until("   Status")
        await screen.input.typeText("Configuration")
        await until(example.reason)
        const status = screen.frame().slice(screen.frame().indexOf("   Status"))
        expect(status).toContain(diagnostic.path)
        if (example.jsonPath) expect(status).toContain(example.jsonPath)
        if ("failClosed" in example) expect(status).toContain("fails closed")
        expect(status).toContain(example.message)
      } finally {
        await screen.dispose()
        await rm(state, { recursive: true, force: true })
      }
    }, 30_000)
  }
}
