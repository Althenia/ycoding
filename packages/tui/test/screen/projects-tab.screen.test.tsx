import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { apiID, designID, docsID, groupID, infraID, leadID, planningID } from "../fixture/coordination-backend"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { mountCoordination, waitForFrame } from "../fixture/coordination-screen"

type Mounted = Awaited<ReturnType<typeof mountCoordination>>
type Screen = Mounted["screen"]

async function until(screen: Screen, check: () => boolean, label: string) {
  for (let i = 0; i < 300 && !check(); i++) {
    await screen.renderOnce()
    await Bun.sleep(10)
  }
  if (!check()) throw new Error(`Timed out waiting for ${label}:\n${screen.frame()}`)
}

async function settle(screen: Screen, frames = 8) {
  for (let i = 0; i < frames; i++) {
    await screen.renderOnce()
    await Bun.sleep(15)
  }
}

const roster = "MEMBERS 4 + MASTER"
const lines = (screen: Screen) => screen.frame().split("\n")
const tabBar = (screen: Screen) =>
  lines(screen).find((line) => line.includes("Subagents") && /\bShell\b/.test(line)) ?? ""

async function openComposer(screen: Screen) {
  screen.input.pressKey("x", { ctrl: true })
  screen.input.pressArrow("down")
  await until(screen, () => tabBar(screen) !== "", "composer tabs")
}

async function openProjects(screen: Screen) {
  screen.input.pressKey("x", { ctrl: true })
  screen.input.pressKey("p")
  await waitForFrame(screen, roster)
}

function refresh(mounted: Mounted, revision: number) {
  mounted.screen.events.emit({
    id: `evt_projects_tab_${revision}`,
    created: revision,
    type: "coordination.updated",
    data: { groupID, revision },
  } as never)
}

function expectFooterIdentity(screen: Screen, identity: string, width: number) {
  const all = lines(screen)
  const matches = all.flatMap((line, index) =>
    line.includes(identity.startsWith("◇") ? "◇" : "↑") && /shells \d|sh\d/.test(line) ? [index] : [],
  )
  expect(matches).toHaveLength(1)
  const filled = all.flatMap((line, index) => (line.trim() === "" ? [] : [index]))
  expect(all.slice(0, 3).some((line) => line.includes(identity))).toBe(false)
  expect(all[matches[0]!]!.trimEnd().length).toBeLessThanOrEqual(width)
  const footer = all[matches[0]]
  expect(footer).toMatch(/usage|\bu\b/i)
  for (const mode of [
    /Permissions Manual|P Manual|P:M/,
    /Guardrails Manual|G Manual|G:M/,
    /Answers Manual|A Manual|A:M/,
  ])
    expect(footer).toMatch(mode)
  expect(filled.at(-1)).toBe(matches[0])
  expect(all.slice(0, matches[0]!).some((line) => line.includes("Message YCoding…"))).toBe(true)
}

function childSession(id: string, title: string) {
  return {
    id,
    parentID: leadID,
    title,
    location: { directory: "/home/dev/Workspace/api" },
    projectID: "proj_test",
    agent: "build",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

function serveChild(child: ReturnType<typeof childSession>) {
  return (url: URL, request: Request) => {
    if (request.method !== "GET") return undefined
    if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
    if (url.pathname === `/api/session/${child.id}/snapshot`) return sessionSnapshot(child.id, [], { session: child })
  }
}

for (const width of [120, 80]) {
  test(`in-Project Master and member show Projects first while the composer still opens on Subagents at ${width} columns`, async () => {
    const mounted = await mountCoordination({ width })
    const screen = mounted.screen
    try {
      await settle(screen)
      expectFooterIdentity(screen, "◇ Master of Release train", width)
      if (width >= 120) expect(screen.frame()).toMatch(/\bSESSION\b/)
      expect(screen.frame()).not.toContain("members ›")
      expect(screen.frame()).not.toContain("ctrl+x p members")
      await openComposer(screen)
      const bar = tabBar(screen)
      expect(bar.indexOf("Projects")).toBeGreaterThanOrEqual(0)
      expect(bar.indexOf("Projects")).toBeLessThan(bar.indexOf("Subagents"))
      expect(bar.indexOf("Subagents")).toBeLessThan(bar.search(/\bShell\b/))
      expect(screen.frame()).not.toContain(roster)
      screen.input.pressEscape()
      await until(screen, () => tabBar(screen) === "", "composer closed")

      mounted.router().navigate({ type: "session", sessionID: docsID })
      await waitForFrame(screen, "↑ Member")
      await settle(screen)
      expectFooterIdentity(screen, "↑ Member of Release train · master Lead", width)
      await openProjects(screen)
      expect(tabBar(screen)).toContain("Projects")
      expect(screen.frame()).toContain("Docs worker")
    } finally {
      await screen.dispose()
    }
  }, 40_000)
}

test("a Session outside every Project has no Projects tab or entry, even with a Master-like title", async () => {
  const mounted = await mountCoordination({ width: 120 })
  const screen = mounted.screen
  try {
    mounted.server.state.sessions[planningID]!.title = "Master of Release train plans"
    mounted.router().navigate({ type: "session", sessionID: planningID })
    await waitForFrame(screen, "plan · main · Build")
    await settle(screen)
    expect(screen.frame()).not.toMatch(/⌃x p project/)
    await openComposer(screen)
    expect(tabBar(screen)).not.toContain("Projects")
    screen.input.pressEscape()
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await settle(screen)
    expect(screen.frame()).not.toContain(roster)
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("the Projects tab runs the roster actions and leaves no hidden-tab keyboard path", async () => {
  const mounted = await mountCoordination({ width: 120 })
  const screen = mounted.screen
  try {
    await openProjects(screen)
    expect(screen.frame()).not.toContain("[x] Remove")
    screen.input.pressArrow("down")
    await until(
      screen,
      () => (lines(screen).find((line) => line.includes("Docs worker")) ?? "").includes("▸ "),
      "member selection",
    )
    expect(screen.frame()).toContain("[x] Remove")
    screen.input.pressKey("x")
    await waitForFrame(screen, "Remove Docs worker from Release train?")
    screen.input.pressEscape()
    await until(screen, () => !screen.frame().includes("Remove Docs worker from Release train?"), "confirmation closed")
    screen.input.pressKey("a")
    await waitForFrame(screen, "ADD SESSION")
    screen.input.pressEnter()
    await until(screen, () => screen.renderer.currentFocusedEditor instanceof InputRenderable, "Find editor")
    await screen.input.typeText("planning")
    screen.input.pressEnter()
    await until(
      screen,
      () => screen.frame().includes("ADD SESSION") && screen.frame().includes("planning"),
      "saved Find field",
    )
    for (let attempt = 0; attempt < 2 && !screen.frame().includes(roster); attempt++) {
      screen.input.pressEscape()
      await settle(screen)
    }
    expect(screen.frame()).toContain(roster)
    expect(tabBar(screen)).toContain("Projects")
    screen.input.pressArrow("right")
    await until(screen, () => !screen.frame().includes(roster), "Subagents selected")
    expect(tabBar(screen)).toContain("Projects")
    screen.input.pressArrow("left")
    await waitForFrame(screen, roster)
    screen.input.pressArrow("right")
    await until(screen, () => !screen.frame().includes(roster), "Subagents selected again")
    screen.input.pressKey("a")
    await settle(screen)
    expect(screen.frame()).not.toContain("ADD SESSION")
    expect(mounted.server.state.writes).toHaveLength(0)
  } finally {
    await screen.dispose()
  }
}, 40_000)

for (const [width, height] of [
  [80, 24],
  [120, 36],
] as const) {
  test(`Projects L03 Team Find owns real typing and mouse selection at ${width}x${height}`, async () => {
    const mounted = await mountCoordination({ width, height })
    const { screen, server } = mounted
    try {
      await openProjects(screen)
      screen.input.pressKey("a")
      await waitForFrame(screen, "ADD SESSION")
      screen.input.pressEnter()
      await until(screen, () => screen.renderer.currentFocusedEditor instanceof InputRenderable, "Find editor")
      await screen.input.typeText("planning")
      await until(
        screen,
        () => screen.frame().includes("Planning") && !screen.frame().includes("Scratch"),
        "live title filter",
      )
      screen.input.pressArrow("left")
      expect(screen.frame()).toContain("ADD SESSION")
      screen.input.pressArrow("right")
      for (let index = 0; index < 8; index++) screen.input.pressBackspace()
      await until(screen, () => screen.frame().includes("Scratch"), "cleared results")
      await screen.input.typeText("no-match")
      await waitForFrame(screen, "No matching Sessions")
      screen.input.pressEscape()
      await until(screen, () => screen.frame().includes("Scratch"), "cancel restores query")
      screen.input.pressEnter()
      await until(screen, () => screen.renderer.currentFocusedEditor instanceof InputRenderable, "Find refocused")
      await screen.input.typeText("Workspace/plan")
      screen.input.pressEnter()
      await until(
        screen,
        () => screen.frame().includes("Planning") && !screen.frame().includes("Scratch"),
        "directory filter",
      )
      const rows = lines(screen)
      const y = rows.findIndex((row) => row.includes("Planning"))
      await screen.mouse.click(rows[y]!.indexOf("Planning"), y)
      await until(screen, () => server.state.projects[0]!.memberSessionIDs.includes(planningID), "mouse attachment")
      expect(server.state.writes.filter((write) => write.method === "PATCH")).toHaveLength(1)
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}

test("leaving the Project while Projects is selected falls back to Subagents", async () => {
  const mounted = await mountCoordination({ width: 120 })
  const screen = mounted.screen
  try {
    await screen.waitForEventStream()
    await openProjects(screen)
    mounted.server.state.projects.splice(0, 1)
    refresh(mounted, 8)
    await until(screen, () => !screen.frame().includes(roster), "Projects tab removed")
    await until(screen, () => tabBar(screen) !== "" && !tabBar(screen).includes("Projects"), "Subagents fallback")
    expect(screen.frame()).not.toContain("Master of Release train")
    screen.input.pressKey("a")
    await settle(screen)
    expect(screen.frame()).not.toContain("ADD SESSION")
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("a Master that becomes a member of the same Project keeps Projects selected", async () => {
  const mounted = await mountCoordination({ width: 120 })
  const screen = mounted.screen
  try {
    await screen.waitForEventStream()
    await openProjects(screen)
    const project = mounted.server.state.projects[0]!
    const lead = project.masterSessionID
    project.masterSessionID = docsID
    project.memberSessionIDs = [lead, apiID, infraID, designID]
    project.revision = 8
    refresh(mounted, 8)
    await waitForFrame(screen, "↑ Member")
    expect(screen.frame()).toContain(roster)
    expect(tabBar(screen)).toContain("Projects")
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("a Project member opened as a subagent keeps its identity in the single footer row", async () => {
  const child = {
    id: docsID,
    parentID: leadID,
    title: "Docs worker",
    location: { directory: "/home/dev/Workspace/docs" },
    projectID: "proj_test",
    agent: "build",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const mounted = await mountCoordination({
    width: 120,
    respond: (url, request) => {
      if (request.method !== "GET") return undefined
      if (url.pathname === `/api/session/${docsID}`) return json({ data: child })
      if (url.pathname === `/api/session/${docsID}/snapshot`) return sessionSnapshot(docsID, [], { session: child })
    },
  })
  const screen = mounted.screen
  try {
    mounted.router().navigate({ type: "session", sessionID: docsID })
    await waitForFrame(screen, "↑ Member")
    await settle(screen)
    const all = lines(screen)
    const identity = all.findIndex((line) => line.includes("↑ Member"))
    expect(all.filter((line) => line.includes("↑ Member"))).toHaveLength(1)
    expect(identity).toBeGreaterThan(all.length / 2)
    expect(all[identity]).toContain("→ next")
    expect(all.filter((line) => line.trim() !== "").at(-1)).toBe(all[identity])
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("a supervisor owning a recorded member gets the Project identity and Projects tab, and loses both when ownership is released", async () => {
  const supervisorID = "ses_supervisor0001"
  const mounted = await mountCoordination({
    width: 120,
    respond: serveChild(childSession(supervisorID, "Docs supervisor")),
  })
  const screen = mounted.screen
  try {
    await screen.waitForEventStream()
    mounted.server.state.sessions[docsID]!.owner = { sessionID: supervisorID, title: "Docs supervisor" }
    refresh(mounted, 8)
    mounted.router().navigate({ type: "session", sessionID: supervisorID })
    await waitForFrame(screen, "↑ Super")
    await settle(screen)
    const all = lines(screen)
    const identity = all.findIndex((line) => line.includes("↑ Super"))
    expect(all.filter((line) => line.includes("↑ Super"))).toHaveLength(1)
    expect(identity).toBeGreaterThan(all.length / 2)
    expect(all[identity]).toContain("Project")
    expect(screen.frame()).not.toContain("Member of Release train")
    await openProjects(screen)
    const bar = tabBar(screen)
    expect(bar.indexOf("Projects")).toBeGreaterThanOrEqual(0)
    expect(bar.indexOf("Projects")).toBeLessThan(bar.indexOf("Subagents"))
    expect(bar.indexOf("Subagents")).toBeLessThan(bar.search(/\bShell\b/))
    expect(screen.frame()).toContain("Docs worker")

    delete mounted.server.state.sessions[docsID]!.owner
    refresh(mounted, 9)
    await until(screen, () => !screen.frame().includes(roster), "Projects tab removed")
    await until(screen, () => tabBar(screen) !== "" && !tabBar(screen).includes("Projects"), "Subagents fallback")
    expect(screen.frame()).not.toContain("Supervisor in Release train")
    expect(screen.frame()).not.toContain("⌃x p project")
    screen.input.pressEscape()
    await until(screen, () => tabBar(screen) === "", "composer closed")
    expect(mounted.router().data).toMatchObject({ type: "session", sessionID: leadID })
    mounted.router().navigate({ type: "session", sessionID: supervisorID })
    await waitForFrame(screen, "SUBAGENT ECONOMICS")
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await settle(screen)
    expect(screen.frame()).not.toContain(roster)
    expect(mounted.server.state.writes).toHaveLength(0)
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("a child of the Master that owns no recorded member has no Project identity or Projects tab", async () => {
  const executorID = "ses_executor00001"
  const mounted = await mountCoordination({ width: 120, respond: serveChild(childSession(executorID, "Lint runner")) })
  const screen = mounted.screen
  try {
    mounted.router().navigate({ type: "session", sessionID: executorID })
    await waitForFrame(screen, "SUBAGENT ECONOMICS")
    await settle(screen)
    expect(screen.frame()).not.toContain("of Release train")
    expect(screen.frame()).not.toContain("Supervisor in")
    expect(screen.frame()).not.toContain("⌃x p project")
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await settle(screen)
    expect(screen.frame()).not.toContain(roster)
  } finally {
    await screen.dispose()
  }
}, 40_000)
