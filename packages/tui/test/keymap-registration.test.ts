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

test("session goal keeps palette and durable autonomy state wiring", async () => {
  const prompt = await Bun.file("src/component/prompt/index.tsx").text()
  const session = await Bun.file("src/routes/session/index.tsx").text()
  const command = prompt.slice(prompt.indexOf('title: "Set autonomous goal"'), prompt.indexOf('title: "Toggle YOLO"'))

  expect(command).toContain('name: "session.autonomy.goal"')
  expect(command).toContain("palette: true")
  expect(command).toContain('props.autonomy?.goal?.status === "active"')
  expect(command).toContain("store.prompt.text.trim() || props.autonomy?.goal?.text ||")
  expect(command).toContain("client.api.session.autonomy.set({ sessionID, payload: { goal: newGoal } })")
  expect(command).toContain("props.onAutonomyUpdated?.(sessionID, state as SessionAutonomyState)")
  expect(session).toContain("autonomy={autonomy()}")
  expect(session).toContain("onAutonomyUpdated={acceptAutonomy}")
})

test("session goal has one slash registration", async () => {
  const sources = await Promise.all([
    Bun.file("src/component/prompt/index.tsx").text(),
    Bun.file("src/routes/session/index.tsx").text(),
  ])

  expect(sources.join("\n").match(/slash:\s*\{\s*name:\s*"goal"\s*\}/g)).toHaveLength(1)
})

test("retained submission retry is an explicit conditional Prompt command", async () => {
  const prompt = await Bun.file("src/component/prompt/index.tsx").text()

  expect(prompt).toContain('title: "Retry previous submission"')
  expect(prompt).toContain('name: "prompt.retry"')
  expect(prompt).toMatch(/\.\.\.\(retry\(\)\s*\?/)
  expect(prompt).toContain("enabled: true")
  expect(prompt).toContain("Previous send is unresolved · Retry or discard it before sending this draft")
  expect(prompt).toContain('name: "prompt.retry.discard"')
})

test("session skills is registered only by the session route", async () => {
  const session = await Bun.file("src/routes/session/index.tsx").text()

  expect(session).toContain('title: "Session skills"')
  expect(session).toContain('id: "session.skills"')
  expect(session).toContain("<DialogSessionSkills sessionID={route.sessionID} location={location()} />")
})

test("session compact surfaces API rejection through the toast error path", async () => {
  const session = await Bun.file("src/routes/session/index.tsx").text()
  const command = session.slice(
    session.indexOf('title: "Compact session"'),
    session.indexOf('title: "Unshare session"'),
  )

  expect(command).toContain("client.api.session.compact({ sessionID: route.sessionID })")
  expect(command).toContain(".catch(toast.error)")
})

test("shell output relies on configurable action bindings", async () => {
  const route = await Bun.file("src/routes/shell-output.tsx").text()

  expect(route).toContain('id: "shell-output.back"')
  expect(route).toContain('id: "shell-output.kill"')
  expect(route).not.toContain('bind: "escape"')
  expect(route).not.toContain('bind: "ctrl+d"')
})
