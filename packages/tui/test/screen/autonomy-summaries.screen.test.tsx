/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionAutonomyView } from "@ycoding-ai/client"
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

function autonomyView(yolo: boolean): SessionAutonomyView {
  return {
    mode: "normal",
    yolo,
    autoPermission: true,
    autoGuardrail: true,
    autoAnswer: true,
    effective: {
      yolo,
      permissionsAuto: true,
      permissionModelReviews: true,
      asleep: false,
      ordinaryReviewsAuto: true,
      guardrailsEnabled: true,
      modelReviews: false,
      hardModelReviews: false,
    },
  }
}

function fixture(goal = false) {
  const state = {
    autonomy: goal
      ? { ...autonomyView(true), goal: { text: "Ship safely", status: "active" as const, iteration: 1, noProgress: 0, maxNoProgress: 3 } }
      : autonomyView(true),
    puts: [] as unknown[],
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
        const payload = (await request.json()) as { yolo?: boolean }
        state.puts.push(payload)
        if (typeof payload.yolo === "boolean") state.autonomy = autonomyView(payload.yolo)
      }
      return json({ location, data: state.autonomy })
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

for (const width of [60, 110, 200]) {
  test(`the header status and footer carry no duplicate autonomy summaries at ${width} columns`, async () => {
    const { route } = fixture()
    const screen = await renderScreen({
      width,
      height: 50,
      args: { sessionID },
      route,
      settle: "waiting · 1 subagent",
      config: { animations: false },
    })
    try {
      await waitFor(screen, () => screen.frame().includes("commands"), "footer")
      const lines = screen.lines()
      const header = lines.find((line) => line.includes("waiting · 1 subagent"))!
      expect(header).toContain("review 1")
      if (width === 60) expect(lines.some((line) => /main\s+subagents 1\s+shells 0/.test(line))).toBe(true)
      expect(header).not.toMatch(modeWords)
      const footer = lines.find((line) => line.includes("commands"))!
      expect(footer.trimEnd().length).toBeLessThanOrEqual(width)
      expect(footer).not.toMatch(/goal|YOLO|permissions auto|guardrails auto|answers auto|review/)
      if (width >= 110) expect(footer).toMatch(footerPattern)
      else {
        expect(footer).toMatch(/^\s+⌃x shift\+u usage\s+⌃p commands\s*$/)
      }
      expect(screen.frame()).not.toContain("goal off")
      if (width < 120) expect(screen.frame()).not.toContain("YOLO")
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}

test("the docked AUTONOMY section keeps its decider rows without a YOLO row and drops the header summary", async () => {
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
    await waitFor(screen, () => /AUTONOMY/.test(screen.frame()) && /Permissions\s+auto/.test(screen.frame()), "autonomy rows")
    const row = screen.lines().find((line) => line.includes("AUTONOMY"))!
    expect(row.slice(row.indexOf("AUTONOMY")).trimEnd()).toBe("AUTONOMY")
    for (const pattern of [/Permissions\s+auto/, /Guardrails\s+auto/, /Questions\s+auto/, /Review\s+1 waiting/])
      expect(screen.frame()).toMatch(pattern)
    expect(screen.frame()).not.toMatch(/YOLO\s+(on|off|unknown)/)
    expect(screen.frame()).not.toContain("then yolo")
  } finally {
    await screen.dispose()
  }
}, 30_000)

for (const width of [60, 200]) {
  test(`/yolo off writes only the YOLO flag at ${width} columns`, async () => {
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
      await screen.input.typeText("/yolo off")
      screen.input.pressEnter()
      await waitFor(screen, () => state.puts.length === 1, "autonomy write")
      expect(state.puts).toEqual([{ yolo: false }])
      await waitFor(screen, () => screen.frame().includes("YOLO off for this Session"), "settled toast")
    } finally {
      await screen.dispose()
    }
  }, 30_000)

  test(`the command palette toggles YOLO at ${width} columns`, async () => {
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
      screen.input.pressKey("p", { ctrl: true })
      await waitFor(screen, () => screen.frame().includes("Commands"), "palette")
      await screen.input.typeText("YOLO")
      await waitFor(screen, () => screen.frame().includes("Toggle YOLO: on"), "YOLO palette row")
      screen.input.pressEnter()
      await waitFor(screen, () => state.puts.length === 1, "autonomy write")
      expect(state.puts).toEqual([{ yolo: false }])
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}

test("the sidebar toggle command opens the AUTONOMY rows below the docked width", async () => {
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
    await waitFor(screen, () => /AUTONOMY/.test(screen.frame()) && /Permissions\s+auto/.test(screen.frame()), "overlay rows")
    const row = screen.lines().find((line) => line.includes("AUTONOMY"))!
    expect(row.slice(row.indexOf("AUTONOMY")).trimEnd()).toBe("AUTONOMY")
    expect(screen.frame()).toMatch(/Review\s+1 waiting/)
    expect(screen.frame()).toMatch(/Questions\s+auto/)
    expect(screen.frame()).not.toMatch(/YOLO\s+(on|off|unknown)/)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("a sleeping Session keeps its distinct operational state in the header without footer badges", async () => {
  const { state, route } = fixture()
  state.autonomy = {
    ...state.autonomy,
    sleep: {},
    effective: { ...autonomyView(true).effective, asleep: true },
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
    expect(screen.lines().find((line) => line.includes("commands"))).not.toMatch(/asleep|YOLO|permissions auto|guardrails auto/)
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

const toggleDescriptions = [
  { filter: "YOLO", title: "Toggle YOLO", description: "evaluates unresolved requests" },
  { filter: "auto-permission", title: "Toggle Auto-permission", description: "approves ask permissions" },
  { filter: "auto-guardrail", title: "Toggle Auto-guardrail", description: "approves ordinary reviews while awake" },
  { filter: "auto-answer", title: "Toggle Auto-answer", description: "uses explicit defaults" },
]

for (const toggle of toggleDescriptions) {
  test(`the command palette row for ${toggle.filter} states its description in full at 80 columns`, async () => {
    const { route } = fixture()
    const screen = await renderScreen({
      width: 80,
      height: 50,
      args: { sessionID },
      route,
      settle: "waiting · 1 subagent",
      config: { animations: false },
    })
    try {
      screen.input.pressKey("p", { ctrl: true })
      await waitFor(screen, () => screen.frame().includes("Commands"), "palette")
      await screen.input.typeText(toggle.filter)
      await waitFor(screen, () => screen.frame().includes(toggle.title), "toggle palette row")
      const rows = screen.lines().filter((line) => line.includes(toggle.title))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain(toggle.description)
      expect(rows[0]).not.toContain("…")
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}

test("an inherited guardrail setting remains fully explained in the narrow palette", async () => {
  const { state, route } = fixture()
  state.autonomy = { ...state.autonomy, autoGuardrail: false }
  const screen = await renderScreen({ width: 80, height: 50, args: { sessionID }, route, settle: "waiting · 1 subagent", config: { animations: false } })
  try {
    screen.input.pressKey("p", { ctrl: true })
    await waitFor(screen, () => screen.frame().includes("Commands"), "palette")
    await screen.input.typeText("auto-guardrail")
    await waitFor(screen, () => screen.frame().includes("inherited on"), "inherited toggle")
    expect(screen.frame()).toContain("approves ordinary reviews while awake")
    expect(screen.lines().find((line) => line.includes("Auto-guardrail: inherited on"))).not.toContain("…")
  } finally {
    await screen.dispose()
  }
}, 30_000)
