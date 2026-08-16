import { expect, test } from "bun:test"
import { CommandMap } from "../src/config/keybind"

test("every configurable keybind has a runtime consumer", async () => {
  const files: string[] = []
  for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan(".")) {
    if (file === "src/config/keybind.ts") continue
    files.push(await Bun.file(file).text())
  }
  const source = files.join("\n")
  const missing = [...new Set(Object.values(CommandMap))].filter((id) => !source.includes(`"${id}"`))

  expect(missing).toEqual([])
})

test("session goal keeps palette and autonomy state wiring", async () => {
  const prompt = await Bun.file("src/component/prompt/index.tsx").text()
  const session = await Bun.file("src/routes/session/index.tsx").text()

  expect(prompt).toContain("currentGoal={props.autonomy?.goal?.text}")
  expect(prompt).toContain("onUpdated={(state) => props.onAutonomyUpdated?.(sessionID, state)}")
  expect(session).toContain("autonomy={autonomy()}")
  expect(session).toContain("onAutonomyUpdated={acceptAutonomy}")
})

test("retained submission retry is an explicit conditional Prompt command", async () => {
  const prompt = await Bun.file("src/component/prompt/index.tsx").text()

  expect(prompt).toContain('title: "Retry previous submission"')
  expect(prompt).toContain('name: "prompt.retry"')
  expect(prompt).toMatch(/\.\.\.\(retry\(\)\s*\?/)
  expect(prompt).toContain("enabled: true")
  expect(prompt).toContain("Run Retry previous submission; current draft will be preserved in stash")
})

test("session skills is registered only by the session route", async () => {
  const session = await Bun.file("src/routes/session/index.tsx").text()

  expect(session).toContain('title: "Session skills"')
  expect(session).toContain('id: "session.skills"')
  expect(session).toContain("<DialogSessionSkills sessionID={route.sessionID} location={location()} />")
})

test("shell output relies on configurable action bindings", async () => {
  const route = await Bun.file("src/routes/shell-output.tsx").text()

  expect(route).toContain('id: "shell-output.back"')
  expect(route).toContain('id: "shell-output.kill"')
  expect(route).not.toContain('bind: "escape"')
  expect(route).not.toContain('bind: "ctrl+d"')
})
