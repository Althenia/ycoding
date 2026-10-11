import { expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const directory = "/tmp/ycoding/telemetry-consent"

function route(consent?: { enabled: boolean; noticeVersion: 1; decidedAt: number }, failSet = false) {
  const writes: Array<{ enabled: boolean; noticeVersion: 1 }> = []
  const batches: Array<unknown[]> = []
  let reads = 0
  return {
    writes,
    batches,
    reads: () => reads,
    handler: async (url: URL, request: Request) => {
      if (url.pathname === "/api/location") return json({ directory, project: { id: "proj_telemetry", directory } })
      if (url.pathname === "/api/server/telemetry/consent" && request.method === "GET") {
        reads++
        return json({ consent, noticeVersion: 1 })
      }
      if (url.pathname === "/api/server/telemetry/consent" && request.method === "PUT") {
        const value = await request.json() as { enabled: boolean; noticeVersion: 1 }
        writes.push(value)
        if (failSet) return json({ message: "consent write failed" }, { status: 500 })
        consent = { ...value, decidedAt: Date.now() }
        return json(consent)
      }
      if (url.pathname === "/api/server/web-latency" && request.method === "POST") {
        batches.push((await request.json() as { samples: unknown[] }).samples)
        return json({ accepted: true })
      }
      if (url.pathname === "/api/vcs/branch") return json({ location: { directory }, data: { current: "main" } })
      if (["/api/agent", "/api/model", "/api/provider", "/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
        return json({ location: { directory }, data: [] })
      return undefined
    },
  }
}

async function waitFor(screen: Awaited<ReturnType<typeof renderScreen>>, text: string) {
  const deadline = Date.now() + 5_000
  while (!screen.frame().includes(text) && Date.now() < deadline) await Bun.sleep(10)
  expect(screen.frame()).toContain(text)
}

test("undecided machine consent shows one local-only notice and records either choice", async () => {
  const api = route()
  const screen = await renderScreen({ width: 100, height: 30, settle: "Message YCoding…", route: api.handler })
  try {
    await waitFor(screen, "Help improve YCoding")
    expect(screen.frame()).toContain("Save usage, speed, and latency for each provider, model, and profile")
    expect(screen.frame()).toContain("Nothing leaves your machine.")
    expect(screen.frame()).toContain("Agree")
    expect(screen.frame()).toContain("Not now")
    const lines = screen.lines()
    const row = lines.findIndex((line) => line.includes("Not now"))
    await screen.mouse.click(lines[row].indexOf("Not now") + 1, row)
    const deadline = Date.now() + 5_000
    while (api.writes.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(api.writes).toEqual([{ enabled: false, noticeVersion: 1 }])
    const hidden = Date.now() + 5_000
    while (screen.frame().includes("Help improve YCoding") && Date.now() < hidden) await Bun.sleep(10)
    expect(screen.frame()).not.toContain("Help improve YCoding")
  } finally {
    await screen.dispose()
  }
})

test("a decided machine consent never displays the first-run notice", async () => {
  const api = route({ enabled: true, noticeVersion: 1, decidedAt: 1 })
  const screen = await renderScreen({ width: 100, height: 30, settle: "Message YCoding…", route: api.handler })
  try {
    await waitFor(screen, "Message YCoding…")
    expect(screen.frame()).not.toContain("Help improve YCoding")
    expect(api.writes).toEqual([])
  } finally {
    await screen.dispose()
  }
})

test("Agree stores enabled consent and the command palette toggles the machine state", async () => {
  const api = route()
  const screen = await renderScreen({ width: 100, height: 30, settle: "Message YCoding…", route: api.handler })
  try {
    await waitFor(screen, "Help improve YCoding")
    const rows = screen.lines()
    const agree = rows.findIndex((line) => line.includes("Agree"))
    await screen.mouse.click(rows[agree].indexOf("Agree") + 1, agree)
    const deadline = Date.now() + 5_000
    while (api.writes.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(api.writes).toEqual([{ enabled: true, noticeVersion: 1 }])
    const hidden = Date.now() + 5_000
    while (screen.frame().includes("Help improve YCoding") && Date.now() < hidden) await Bun.sleep(10)
    expect(screen.frame()).not.toContain("Help improve YCoding")
    screen.input.pressKey("p", { ctrl: true })
    await waitFor(screen, "Commands")
    await screen.input.typeText("Telemetry: on")
    await waitFor(screen, "Telemetry: on")
    screen.input.pressEnter()
    const toggled = Date.now() + 5_000
    while (api.writes.length < 2 && Date.now() < toggled) await Bun.sleep(10)
    expect(api.writes).toEqual([
      { enabled: true, noticeVersion: 1 },
      { enabled: false, noticeVersion: 1 },
    ])
  } finally {
    await screen.dispose()
  }
})

test("a failed consent write shows a toast without retrying automatically", async () => {
  const api = route(undefined, true)
  const screen = await renderScreen({ width: 100, height: 30, settle: "Message YCoding…", route: api.handler })
  try {
    await waitFor(screen, "Help improve YCoding")
    const lines = screen.lines()
    const agree = lines.findIndex((line) => line.includes("Agree"))
    await screen.mouse.click(lines[agree].indexOf("Agree") + 1, agree)
    await waitFor(screen, "UnexpectedStatus")
    expect(api.writes).toEqual([{ enabled: true, noticeVersion: 1 }])
    expect(screen.frame()).toContain("Help improve YCoding")
    await Bun.sleep(100)
    expect(api.writes).toHaveLength(1)
  } finally {
    await screen.dispose()
  }
})

test("live server-timestamped stream events append samples only with enabled consent", async () => {
  const api = route({ enabled: true, noticeVersion: 1, decidedAt: 1 })
  const screen = await renderScreen({ width: 100, height: 30, settle: "Message YCoding…", route: api.handler })
  try {
    await waitFor(screen, "Message YCoding…")
    await screen.waitForEventStream()
    screen.events.emit({
      id: "evt_telemetry_stream",
      created: Date.now(),
      type: "session.text.delta",
      data: { sessionID: "ses_telemetry_stream", assistantMessageID: "msg_telemetry_stream", ordinal: 0, delta: "hello" },
    })
    const deadline = Date.now() + 15_000
    while (api.batches.length === 0 && Date.now() < deadline) await Bun.sleep(50)
    expect(api.batches).toHaveLength(1)
    expect(api.batches[0]).toHaveLength(1)
    expect(api.batches[0]?.[0]).toMatchObject({ kind: "client", surface: "tui", metric: "stream.delay" })
  } finally {
    await screen.dispose()
  }
})

test("live server-timestamped stream events are not appended while consent is off", async () => {
  const api = route({ enabled: false, noticeVersion: 1, decidedAt: 1 })
  const screen = await renderScreen({ width: 100, height: 30, settle: "Message YCoding…", route: api.handler })
  try {
    await waitFor(screen, "Message YCoding…")
    await screen.waitForEventStream()
    screen.events.emit({
      id: "evt_telemetry_off",
      created: Date.now(),
      type: "session.text.delta",
      data: { sessionID: "ses_telemetry_off", assistantMessageID: "msg_telemetry_off", ordinal: 0, delta: "hello" },
    })
    await Bun.sleep(10_200)
    expect(api.batches).toEqual([])
  } finally {
    await screen.dispose()
  }
})
