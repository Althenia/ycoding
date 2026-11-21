import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { sessionHistoryFixture } from "../fixture/session-history"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

function terminal(screen: Awaited<ReturnType<typeof renderScreen>>) {
  async function wait(text: string, ready: () => boolean = () => true) {
    const deadline = Date.now() + 4000
    while ((!screen.frame().includes(text) || !ready()) && Date.now() < deadline) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(screen.frame()).toContain(text)
    expect(ready()).toBe(true)
  }
  async function command(title: string) {
    screen.input.pressKey("p", { ctrl: true })
    await wait("Commands", () => screen.renderer.currentFocusedEditor instanceof InputRenderable)
    await screen.input.typeText(title)
    await wait(title, () => screen.renderer.currentFocusedEditor instanceof InputRenderable && screen.renderer.currentFocusedEditor.plainText === title)
    screen.input.pressEnter()
  }
  return { wait, command }
}

test("Interaction request opens native consent and keyboard Stop sends the active generation without reading pixels", async () => {
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const generation = "cf3aa01e-85ca-42fd-af3a-dd706075cb34"
  const route = `/api/session/${fixture.sessionID}/interaction`
  const controls: { path: string; body: unknown }[] = []
  let status: Record<string, unknown> = { state: "unavailable" }
  const screen = await renderScreen({
    width: 120, height: 36, args: { sessionID: fixture.sessionID }, settle: "Synthetic response 1", sessionReady: true,
    route: async (url, request) => {
      if (url.pathname.startsWith(route)) {
        controls.push({ path: url.pathname, body: request.method === "POST" ? await request.json() : null })
        if (url.pathname === route && request.method === "POST") status = { state: "pending", platform: "chrome", generation }
        if (url.pathname === `${route}/stop`) status = { state: "stopped", platform: "chrome", generation, reason: "stopped", cleanup: "complete" }
        return json({ data: status })
      }
      return fixture.route(url, request)
    },
  })
  const { wait, command } = terminal(screen)
  try {
    await wait("Synthetic response 1")
    expect(screen.frame()).not.toContain("Interaction unavailable")
    expect(screen.frame()).not.toContain("Interaction status unavailable")
    await command("Request Chrome control")
    await wait("Awaiting")
    status = { state: "active", platform: "chrome", generation, label: "Synthetic tab" }
    screen.events.emit({ id: "evt_interaction_ready", created: 1, type: "session.interaction.changed", data: { sessionID: fixture.sessionID, generation } })
    await wait("Synthetic tab")
    await command("Stop interaction")
    await wait("Cleanup complete")
    expect(controls.filter((call) => call.path !== route || call.body !== null)).toEqual([
      { path: route, body: { platform: "chrome", mode: "tab" } }, { path: `${route}/stop`, body: { generation } },
    ])
    await command("Request owned Chrome tab")
    await wait("Starting URL", () => screen.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(screen.frame()).toContain("Approve the target in Chrome")
    screen.input.pressEscape()
    await wait("Cleanup complete", () => !screen.frame().includes("Starting URL"))
    await command("Request isolated Chrome")
    await wait("Starting URL", () => screen.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(screen.frame()).toContain("Approve the target in the macOS system prompt")
    await screen.input.typeText("https://example.test/isolated")
    await wait("https://example.test/isolated")
    screen.input.pressEnter()
    await wait("Chrome control · Awaiting local approval")
    expect(controls.filter((call) => call.body !== null).at(-1)).toEqual({ path: route, body: { platform: "chrome", mode: "isolated", url: "https://example.test/isolated" } })
  } finally { await screen.dispose() }
}, 30_000)

test("Interaction Stop cancels pending consent from the TUI command palette", async () => {
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const generation = "cf3aa01e-85ca-42fd-af3a-dd706075cb34"
  const route = `/api/session/${fixture.sessionID}/interaction`
  const controls: { path: string; body: unknown }[] = []
  let stopped = false
  const screen = await renderScreen({
    width: 120, height: 36, args: { sessionID: fixture.sessionID }, settle: "Synthetic response 1", sessionReady: true,
    route: async (url, request) => {
      if (!url.pathname.startsWith(route)) return fixture.route(url, request)
      if (url.pathname !== route || request.method !== "GET") controls.push({ path: url.pathname, body: request.method === "POST" ? await request.json() : null })
      if (url.pathname === `${route}/stop` && request.method === "POST") stopped = true
      return json({ data: stopped ? { state: "stopped", platform: "chrome", generation, reason: "stopped", cleanup: "complete" } : { state: "pending", platform: "chrome", generation } })
    },
  })
  const { wait, command } = terminal(screen)
  try {
    await wait("Chrome control · Awaiting local approval")
    expect(screen.frame()).toContain("Stop interaction")
    await command("Stop interaction")
    await wait("Cleanup complete")
    expect(controls).toEqual([{ path: `${route}/stop`, body: { generation } }])
  } finally { await screen.dispose() }
}, 30_000)

test("a paused Interaction shows its reason with Resume and Stop, and Resume sends the paused generation", async () => {
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const generation = "cf3aa01e-85ca-42fd-af3a-dd706075cb34"
  const route = `/api/session/${fixture.sessionID}/interaction`
  const controls: { path: string; body: unknown }[] = []
  let status: Record<string, unknown> = { state: "paused", platform: "macos", generation, label: "Selected macOS window", reason: "file_chooser" }
  const screen = await renderScreen({
    width: 120, height: 36, args: { sessionID: fixture.sessionID }, settle: "Synthetic response 1", sessionReady: true,
    route: async (url, request) => {
      if (!url.pathname.startsWith(route)) return fixture.route(url, request)
      if (url.pathname !== route || request.method !== "GET") controls.push({ path: url.pathname, body: request.method === "POST" ? await request.json() : null })
      if (url.pathname === `${route}/resume`) status = { state: "active", platform: "macos", generation, label: "Selected macOS window" }
      return json({ data: status })
    },
  })
  const { wait, command } = terminal(screen)
  try {
    await wait("macOS control paused · Selected macOS window")
    expect(screen.frame()).toContain("Choose the file yourself")
    expect(screen.frame()).toContain("Resume interaction")
    expect(screen.frame()).toContain("Stop interaction")
    await command("Resume interaction")
    await wait("macOS control active · Selected macOS window")
    expect(screen.frame()).not.toContain("Resume interaction")
    expect(controls).toEqual([{ path: `${route}/resume`, body: { generation } }])
  } finally { await screen.dispose() }
}, 30_000)

test("when Interaction status read fails, the row stays hidden and Refresh interaction status in the palette retries it", async () => {
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const route = `/api/session/${fixture.sessionID}/interaction`
  let reads = 0
  let fail = true
  const screen = await renderScreen({
    width: 120, height: 36, args: { sessionID: fixture.sessionID }, settle: "Synthetic response 1", sessionReady: true,
    route: async (url, request) => {
      if (!url.pathname.startsWith(route)) return fixture.route(url, request)
      reads++
      if (fail) return new Response("unavailable", { status: 500 })
      return json({ data: { state: "active", platform: "macos", generation: "cf3aa01e-85ca-42fd-af3a-dd706075cb34", label: "Recovered window" } })
    },
  })
  const { wait, command } = terminal(screen)
  try {
    await wait("Synthetic response 1")
    expect(screen.frame()).not.toContain("Interaction status unavailable")
    expect(reads).toBeGreaterThan(0)
    const before = reads
    fail = false
    await command("Refresh interaction status")
    await wait("Recovered window")
    expect(reads).toBeGreaterThan(before)
  } finally { await screen.dispose() }
}, 30_000)
