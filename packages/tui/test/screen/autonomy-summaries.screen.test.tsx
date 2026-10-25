/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import { AutonomyFixture } from "../fixture/autonomy"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_autonomy_summaries"
const directory = "/tmp/ycoding/autonomy-summaries"
const location = { directory, project: { id: "proj_summaries", directory } }
const session = {
  id: sessionID,
  title: "Autonomy summaries",
  projectID: "proj_summaries",
  location: { directory },
  agent: "build",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}
const reviewItem = {
  itemID: "rvw_summaries",
  kind: "guardrail",
  reason: "escalated",
  origin: { requestID: "grq_summaries" },
  payload: {
    type: "guardrail",
    action: "shell",
    resources: ["git reset --hard"],
    ruleIDs: ["standard.review.git-destructive"],
    reason: "Destructive Git operation",
    hardReview: true,
    directories: [],
    fingerprint: "c".repeat(64),
    requestID: "grq_summaries",
  },
  sessionID,
  rootSessionID: sessionID,
  sessionTitle: "Autonomy summaries",
  created: 2,
}

function autonomyView(modes: Partial<Pick<SessionAutonomyView, "permissions" | "guardrails" | "answers">> = {}): SessionAutonomyView {
  return AutonomyFixture.autonomyView({ permissions: "auto", guardrails: "auto", answers: "auto", ...modes })
}

function fixture(goal = false) {
  const state = {
    autonomy: goal
      ? { ...autonomyView(), goal: { text: "Ship safely", status: "active" as const, iteration: 1, noProgress: 0, maxNoProgress: 3 } }
      : autonomyView(),
    puts: [] as unknown[],
    prompts: [] as unknown[],
  }
  const route = async (url: URL, request: Request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [], { session })
    if (url.pathname === `/api/session/${sessionID}/review`) return json({ data: [reviewItem] })
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({ data: [], summary: { total: 1, active: 1, running: 0, waiting: 1 }, cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/autonomy`) {
      if (request.method === "PUT") {
        const payload = (await request.json()) as Partial<Pick<SessionAutonomyView, "permissions" | "guardrails" | "answers">>
        state.puts.push(payload)
        state.autonomy = AutonomyFixture.autonomyView({ ...state.autonomy, ...payload }, state.autonomy.effective.inherited ? { inherited: state.autonomy.effective.inherited } : {})
      }
      return json({ location, data: state.autonomy })
    }
    if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
      state.prompts.push(await request.json())
      return new Response(null, { status: 500 })
    }
    if (url.pathname.endsWith("/guardrail"))
      return json({
        data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] },
      })
    if (url.pathname.endsWith("/permission") || url.pathname.endsWith("/todo")) return json({ data: [] })
  }
  return { state, route }
}

async function waitFor(screen: Awaited<ReturnType<typeof renderScreen>>, check: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${label}:\n${screen.frame()}`)
}

const modeWords = /YOLO|permissions auto|guardrails auto|goal|asleep|answers auto/

const footerPattern = /main\s+subagents 1\s+shells 0\s+.*⌃x shift\+u usage\s+⌃p commands/
const footerRow = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.lines().filter((line) => line.trim() !== "").at(-1) ?? ""
const modePattern = (title: "Permissions" | "Guardrails" | "Answers", mode: "Manual" | "Auto" | "YOLO" | "unknown") =>
  new RegExp(`${title} ${mode}|${title[0]} ${mode}|${title[0]}:${{ Manual: "M", Auto: "A", YOLO: "Y", unknown: "\\?" }[mode]}`)

for (const width of [40, 60, 79, 80, 110, 200]) {
  test(`the footer shows three effective modes and preserves controls and composer at ${width} columns`, async () => {
    const { route } = fixture()
    const screen = await renderScreen({
      width,
      height: 24,
      args: { sessionID },
      route,
      settle: "Message YCoding",
      sessionReady: true,
      config: { animations: false },
    })
    try {
      await waitFor(screen, () => /subagents 1|sa1/.test(footerRow(screen)) && modePattern("Permissions", "Auto").test(footerRow(screen)), "loaded footer")
      const lines = screen.lines()
      const header = lines.find((line) => line.includes("waiting · 1 subagent"))!
      if (width >= 60) expect(header).toContain("review 1")
      expect(footerRow(screen)).toMatch(/subagents 1|sa1/)
      expect(footerRow(screen)).toMatch(/shells 0|sh0/)
      if (header) expect(header).not.toMatch(modeWords)
      const footer = footerRow(screen)
      expect(footer.trimEnd().length).toBeLessThanOrEqual(width)
      expect(footer).not.toMatch(/goal|review box/)
      expect(footer).toContain("⌃p")
      if (width >= 160) expect(footer).toMatch(footerPattern)
      expect(screen.frame()).not.toContain("goal off")
      for (const title of ["Permissions", "Guardrails", "Answers"] as const) expect(footer).toMatch(modePattern(title, "Auto"))
      expect(lines.filter((line) => modePattern("Permissions", "Auto").test(line))).toEqual([footer])
      expect(screen.frame()).not.toContain("AUTONOMY")
      await screen.input.typeText("Editable draft")
      await waitFor(screen, () => screen.frame().includes("Editable draft"), "composer draft")
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}

test("the docked sidebar keeps the Review row without an AUTONOMY section", async () => {
  const { route } = fixture()
  const screen = await renderScreen({
    width: 200,
    height: 50,
    args: { sessionID },
    route,
    settle: "waiting · 1 subagent",
    config: { animations: false },
  })
  try {
    await waitFor(screen, () => /Review\s+1 waiting/.test(screen.frame()), "Review row")
    expect(screen.frame()).not.toContain("AUTONOMY")
    for (const pattern of [/Permissions Auto/, /Guardrails Auto/, /Answers Auto/, /Review\s+1 waiting/])
      expect(screen.frame()).toMatch(pattern)
    expect(screen.frame()).not.toMatch(/YOLO\s+(on|off|unknown)/)
    expect(screen.frame()).not.toContain("then yolo")
  } finally {
    await screen.dispose()
  }
}, 30_000)

async function openAutonomous(screen: Awaited<ReturnType<typeof renderScreen>>) {
  screen.input.pressKey("p", { ctrl: true })
  await waitFor(screen, () => screen.frame().includes("Commands"), "palette")
  await screen.input.typeText("Autonomous")
  await waitFor(screen, () => screen.lines().some((line) => /^\s*Autonomous\b/.test(line)), "Autonomous palette row")
  screen.input.pressEnter()
  await waitFor(screen, () => screen.frame().includes("Permissions") && screen.frame().includes("1 all Manual"), "Autonomous dialog")
}

for (const width of [60, 200]) {
  test(`the palette Autonomous dialog saves one category per cycle key at ${width} columns`, async () => {
    const { state, route } = fixture()
    const screen = await renderScreen({
      width,
      height: 50,
      args: { sessionID },
      route,
      settle: "waiting · 1 subagent",
      config: { animations: false },
    })
    try {
      await openAutonomous(screen)
      screen.input.pressArrow("left")
      await waitFor(screen, () => screen.lines().some((line) => /Permissions\s+YOLO\b/.test(line) && !/Guardrails|Answers/.test(line)), "settled permissions mode")
      screen.input.pressArrow("down")
      screen.input.pressArrow("right")
      await waitFor(screen, () => state.puts.length === 2, "guardrails write")
      expect(state.puts).toEqual([{ permissions: "yolo" }, { guardrails: "manual" }])
      await waitFor(screen, () => /Permissions\s+YOLO/.test(screen.frame()) && /Guardrails\s+Manual/.test(screen.frame()), "settled rows")
      expect(state.prompts).toEqual([])
      screen.input.pressEscape()
      await waitFor(screen, () => !screen.frame().includes("1 all Manual"), "closed dialog")
      const footer = screen.lines().slice(-5).join("\n")
      expect(footer).toMatch(modePattern("Permissions", "YOLO"))
      expect(footer).toMatch(modePattern("Guardrails", "Manual"))
      expect(footer).toMatch(modePattern("Answers", "Auto"))
      await openAutonomous(screen)
      expect(screen.frame()).toMatch(/Permissions\s+YOLO/)
      expect(screen.frame()).toMatch(/Guardrails\s+Manual/)
    } finally {
      await screen.dispose()
    }
  }, 30_000)

  test(`set-all from the dialog is one request at ${width} columns`, async () => {
    const { state, route } = fixture()
    const screen = await renderScreen({
      width,
      height: 50,
      args: { sessionID },
      route,
      settle: "waiting · 1 subagent",
      config: { animations: false },
    })
    try {
      await openAutonomous(screen)
      screen.input.pressKey("2")
      await waitFor(screen, () => state.puts.length === 1, "set-all write")
      expect(state.puts).toEqual([{ permissions: "yolo", guardrails: "yolo", answers: "yolo" }])
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}

test("/autonomous opens the dialog without admitting slash text", async () => {
  const { state, route } = fixture()
  const screen = await renderScreen({ width: 100, height: 50, args: { sessionID }, route, settle: "waiting · 1 subagent", config: { animations: false } })
  try {
    await screen.input.typeText("/autonomous")
    screen.input.pressEnter()
    await waitFor(screen, () => screen.frame().includes("Permissions") && screen.frame().includes("1 all Manual"), "Autonomous dialog")
    expect(state.prompts).toEqual([])
    expect(state.puts).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the four former autonomy commands are gone from the slash menu", async () => {
  const { route } = fixture()
  const screen = await renderScreen({ width: 100, height: 50, args: { sessionID }, route, settle: "waiting · 1 subagent", config: { animations: false } })
  try {
    await screen.input.typeText("/auto")
    await waitFor(screen, () => screen.frame().includes("/autonomous"), "slash menu")
    for (const removed of ["/yolo", "/auto-permission", "/auto-guardrail", "/auto-answer"]) expect(screen.frame()).not.toContain(removed)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the four former autonomy toggles are gone from the palette", async () => {
  const { route } = fixture()
  const screen = await renderScreen({ width: 100, height: 50, args: { sessionID }, route, settle: "waiting · 1 subagent", config: { animations: false } })
  try {
    screen.input.pressKey("p", { ctrl: true })
    await waitFor(screen, () => screen.frame().includes("Commands"), "palette")
    await screen.input.typeText("Toggle")
    await waitFor(screen, () => screen.frame().includes("Toggle"), "palette filter")
    for (const removed of ["Toggle YOLO", "Auto-permission", "Auto-guardrail", "Auto-answer"]) expect(screen.frame()).not.toContain(removed)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the palette lists exactly one Autonomous entry with its description in full at 80 columns", async () => {
  const { route } = fixture()
  const screen = await renderScreen({ width: 80, height: 50, args: { sessionID }, route, settle: "waiting · 1 subagent", config: { animations: false } })
  try {
    screen.input.pressKey("p", { ctrl: true })
    await waitFor(screen, () => screen.frame().includes("Commands"), "palette")
    await screen.input.typeText("Autonomous")
    await waitFor(screen, () => screen.lines().some((line) => /^\s*Autonomous\b/.test(line)), "Autonomous palette row")
    const rows = screen.lines().filter((line) => line.includes("permissions, guardrails, and answers"))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/^\s*Autonomous\b/)
    expect(rows[0]).not.toContain("…")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the sidebar toggle command preserves the Review row without an AUTONOMY section", async () => {
  const { route } = fixture()
  const screen = await renderScreen({
    width: 110,
    height: 50,
    args: { sessionID },
    route,
    settle: "waiting · 1 subagent",
    config: { animations: false },
  })
  try {
    expect(screen.frame()).not.toContain("AUTONOMY")
    screen.input.pressKey("p", { ctrl: true })
    await waitFor(screen, () => screen.frame().includes("Commands"), "palette")
    await screen.input.typeText("sidebar")
    await waitFor(screen, () => screen.frame().includes("Show sidebar"), "sidebar command")
    screen.input.pressEnter()
    await waitFor(screen, () => /Review\s+1 waiting/.test(screen.frame()), "overlay Review row")
    expect(screen.frame()).not.toContain("AUTONOMY")
    expect(screen.frame()).toMatch(/Review\s+1 waiting/)
    expect(footerRow(screen)).toMatch(modePattern("Answers", "Auto"))
    expect(screen.frame()).not.toMatch(/YOLO\s+(on|off|unknown)/)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("a sleeping Session shows an explicit footer marker without replacing effective modes", async () => {
  const { state, route } = fixture()
  state.autonomy = {
    ...state.autonomy,
    sleep: {},
    effective: { ...autonomyView().effective, asleep: true },
  }
  const screen = await renderScreen({
    width: 60,
    height: 50,
    args: { sessionID },
    route,
    settle: "review 1",
    config: { animations: false },
  })
  try {
    expect(screen.frame()).toContain("asleep")
    expect(footerRow(screen)).toMatch(/asleep|sl\*/)
    for (const title of ["Permissions", "Guardrails", "Answers"] as const) expect(footerRow(screen)).toMatch(modePattern(title, "Auto"))
    expect(footerRow(screen)).toContain("⌃p")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("an active goal shows in the docked GOAL section and nowhere in the header or footer", async () => {
  const { route } = fixture(true)
  const screen = await renderScreen({
    width: 200,
    height: 50,
    args: { sessionID },
    route,
    settle: "waiting · 1 subagent",
    config: { animations: false },
  })
  try {
    await waitFor(screen, () => /GOAL\s+active/.test(screen.frame()), "GOAL section")
    const lines = screen.lines()
    expect(lines.find((line) => line.includes("waiting · 1 subagent"))).not.toMatch(/goal/)
    expect(lines.find((line) => line.includes("commands"))).not.toMatch(/goal/)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("an inherited effective mode is marked in the footer with its source in the dialog", async () => {
  const { state, route } = fixture()
  state.autonomy = AutonomyFixture.autonomyView(
    { permissions: "manual", guardrails: "manual", answers: "manual" },
    { guardrails: "yolo", inherited: { guardrails: "ses_root" } },
  )
  const screen = await renderScreen({ width: 200, height: 50, args: { sessionID }, route, settle: "waiting · 1 subagent", config: { animations: false } })
  try {
    await waitFor(screen, () => /Guardrails YOLO +· inherited/.test(footerRow(screen)), "inherited guardrails indicator")
    expect(footerRow(screen)).toMatch(/Guardrails YOLO +· inherited/)
    expect(screen.frame()).toMatch(/Permissions Manual/)
    expect(screen.frame()).not.toContain("Guardrails Manual")
    await openAutonomous(screen)
    expect(screen.lines().find((line) => line.includes("Guardrails") && line.includes("YOLO · inherited"))).toBeDefined()
    expect(screen.frame()).toContain("Inherited from ses_root")
  } finally {
    await screen.dispose()
  }
}, 30_000)

for (const read of ["pending", "failed", "malformed"] as const) {
  test(`a ${read} autonomy read keeps all footer values unknown`, async () => {
    const backend = fixture()
    const gate = Promise.withResolvers<Response>()
    const screen = await renderScreen({
      width: 60, height: 24, args: { sessionID }, settle: "Message YCoding", config: { animations: false },
      route: (url, request) => {
        if (url.pathname.endsWith("/autonomy")) {
          if (read === "pending") return gate.promise
          if (read === "failed") return new Response("unavailable", { status: 500 })
          return json({ data: { ...backend.state.autonomy, effective: {} } })
        }
        return backend.route(url, request)
      },
    })
    try {
      const footer = screen.lines().slice(-6).join("\n")
      for (const title of ["Permissions", "Guardrails", "Answers"] as const)
        expect(footer).toMatch(modePattern(title, "unknown"))
      expect(footer).not.toMatch(/Manual|asleep/)
    } finally {
      gate.resolve(json({ data: backend.state.autonomy }))
      await screen.dispose()
    }
  }, 30_000)
}

test("disconnect makes footer modes unknown and reconnect reloads effective modes and family sleep", async () => {
  const backend = fixture()
  const reconnect = Promise.withResolvers<Response>()
  let holdEvents = false
  const screen = await renderScreen({
    width: 60, height: 24, args: { sessionID }, settle: "Message YCoding", config: { animations: false },
    route: (url, request) => url.pathname === "/api/event" && holdEvents ? reconnect.promise : backend.route(url, request),
  })
  try {
    await waitFor(screen, () => modePattern("Permissions", "Auto").test(footerRow(screen)), "loaded footer")
    await screen.waitForEventStream()
    holdEvents = true
    screen.events.disconnect()
    await waitFor(screen, () => modePattern("Permissions", "unknown").test(footerRow(screen)), "disconnected footer")
    expect(screen.lines().slice(-6).join("\n")).not.toContain("Auto")
    backend.state.autonomy = AutonomyFixture.autonomyView(
      {},
      { answers: "yolo", asleep: true, inherited: { answers: "ses_root" } },
    )
    reconnect.resolve(screen.events.connect())
    await waitFor(screen, () => /(?:Answers|A) YOLO(?: +· inherited| *\*)|A:Y *\*/.test(footerRow(screen)), "reconnected footer")
    const footer = screen.lines().slice(-6).join("\n")
    expect(footer).toMatch(modePattern("Permissions", "Manual"))
    expect(footer).toMatch(modePattern("Guardrails", "Manual"))
    expect(footer).toMatch(/asleep|sl\*/)
    expect(footer).not.toContain("review box")
  } finally {
    reconnect.resolve(screen.events.connect())
    await screen.dispose()
  }
}, 30_000)

test("a failed refresh clears previously loaded footer modes and the Autonomous dialog", async () => {
  const backend = fixture()
  backend.state.autonomy = AutonomyFixture.autonomyView(
    {},
    { permissions: "auto", asleep: true, inherited: { permissions: "ses_parent" } },
  )
  let failRead = false
  const screen = await renderScreen({
    width: 60, height: 24, args: { sessionID }, settle: "Message YCoding", config: { animations: false },
    route: (url, request) => {
      if (url.pathname.endsWith("/wait")) return new Response(null, { status: 204 })
      if (url.pathname.endsWith("/autonomy") && failRead) return new Response("unavailable", { status: 500 })
      return backend.route(url, request)
    },
  })
  try {
    await waitFor(screen, () => /(?:Permissions|P) Auto(?: +· inherited| *\*)|P:A *\*/.test(footerRow(screen)), "loaded inherited mode")
    expect(footerRow(screen)).toMatch(/asleep|sl\*/)
    await screen.waitForEventStream()
    failRead = true
    screen.events.emit({
      id: "evt_autonomy_refresh_failure", created: 20, type: "session.execution.succeeded",
      durable: { aggregateID: sessionID, seq: 1, version: 1 }, location: { directory }, data: { sessionID },
    })
    await waitFor(screen, () => modePattern("Permissions", "unknown").test(footerRow(screen)), "failed refresh")
    const footer = screen.lines().slice(-6).join("\n")
    for (const title of ["Permissions", "Guardrails", "Answers"] as const) expect(footer).toMatch(modePattern(title, "unknown"))
    expect(footer).not.toMatch(/Manual|Auto|asleep|inherited|disabled/)
    expect(screen.frame()).not.toContain("item waiting for your review")
    await openAutonomous(screen)
    for (const title of ["Permissions", "Guardrails", "Answers"])
      expect(screen.lines().find((line) => line.includes(title) && line.trimEnd().endsWith("unknown"))).toBeDefined()
    expect(backend.state.puts).toEqual([])
    screen.input.pressKey("ESCAPE")
    await waitFor(screen, () => !screen.frame().includes("Autonomous"), "closed unknown modes dialog")
    backend.state.autonomy = AutonomyFixture.autonomyView({ answers: "auto" })
    failRead = false
    screen.events.emit({
      id: "evt_autonomy_refresh_recovered", created: 21, type: "session.execution.succeeded",
      durable: { aggregateID: sessionID, seq: 2, version: 1 }, location: { directory }, data: { sessionID },
    })
    await waitFor(screen, () => modePattern("Answers", "Auto").test(footerRow(screen)), "recovered current modes")
    const recovered = screen.lines().slice(-6).join("\n")
    expect(recovered).toMatch(modePattern("Permissions", "Manual"))
    expect(recovered).toMatch(modePattern("Guardrails", "Manual"))
    expect(recovered).not.toMatch(/unknown|asleep|inherited/)
    expect(backend.state.puts).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("saved category modes reload into a newly mounted Session footer", async () => {
  const backend = fixture()
  const options = { width: 80, height: 24, args: { sessionID }, route: backend.route, settle: "Message YCoding", config: { animations: false } }
  const first = await renderScreen(options)
  try {
    await openAutonomous(first)
    first.input.pressKey("2")
    await waitFor(first, () => /Permissions\s+YOLO/.test(first.frame()), "saved modes")
    expect(backend.state.puts).toEqual([{ permissions: "yolo", guardrails: "yolo", answers: "yolo" }])
  } finally {
    await first.dispose()
  }
  const reloaded = await renderScreen(options)
  try {
    await waitFor(reloaded, () => modePattern("Permissions", "YOLO").test(footerRow(reloaded)), "reloaded modes")
    const footer = reloaded.lines().slice(-5).join("\n")
    for (const title of ["Permissions", "Guardrails", "Answers"] as const) expect(footer).toMatch(modePattern(title, "YOLO"))
    expect(backend.state.puts).toHaveLength(1)
  } finally {
    await reloaded.dispose()
  }
}, 30_000)
