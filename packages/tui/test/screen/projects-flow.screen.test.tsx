import { expect, test } from "bun:test"
import { InputRenderable, RenderableEvents, type Renderable } from "@opentui/core"
import { docsID, groupID, leadID, planningID, scratchID } from "../fixture/coordination-backend"
import { mountCoordination, waitForFrame } from "../fixture/coordination-screen"

type Mounted = Awaited<ReturnType<typeof mountCoordination>>
type Screen = Mounted["screen"]

async function settle(screen: Screen, frames = 8) {
  for (let i = 0; i < frames; i++) {
    await screen.renderOnce()
    await Bun.sleep(15)
  }
}
async function until(screen: Screen, check: () => boolean, label: string) {
  for (let i = 0; i < 300 && !check(); i++) {
    await screen.renderOnce()
    await Bun.sleep(10)
  }
  if (!check()) throw new Error(`Timed out waiting for ${label}:\n${screen.frame()}`)
}
const editing = (screen: Screen) => screen.renderer.currentFocusedEditor instanceof InputRenderable
const lineOf = (frame: string, ...needles: string[]) =>
  frame.split("\n").find((line) => needles.every((needle) => line.includes(needle))) ?? ""
const luminance = ([red, green, blue]: number[]) => {
  const channel = (value: number) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!)
}
const contrast = (first: number[], second: number[]) => {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (light! + 0.05) / (dark! + 0.05)
}
async function openMember(width: number) {
  const mounted = await mountCoordination({ width })
  mounted.router().navigate({ type: "session", sessionID: docsID })
  await waitForFrame(mounted.screen, "Draft the release")
  await settle(mounted.screen)
  return mounted
}

for (const width of [120, 80, 60]) {
  test(`member chat keeps identity, modes and actions in one footer row at ${width} columns`, async () => {
    const { screen } = await openMember(width)
    try {
      const frame = screen.frame()
      const lines = frame.split("\n")
      const identity = lines.filter((line) => line.includes("↑") && /shells \d|sh\d/.test(line))
      expect(identity).toHaveLength(1)
      if (width >= 120) expect(identity[0]).toContain("↑ Member")
      expect(identity[0]!.trimEnd().length).toBeLessThanOrEqual(width)
      const filled = lines.filter((line) => line.trim() !== "")
      expect(filled.at(-1)).toBe(identity[0])
      for (const label of [/Permissions Manual|P Manual|P:M/, /Guardrails Manual|G Manual|G:M/, /Answers Manual|A Manual|A:M/]) expect(identity[0]).toMatch(label)
      expect(identity[0]).toMatch(/usage|\bu\b/i)
      for (const absent of ["ctrl+x p members", "enter send · esc interrupt", "members ›"]) expect(frame).not.toContain(absent)
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}

test("Master chat keeps the Project shortcut beside Usage in its single footer row", async () => {
  const { screen } = await mountCoordination({ width: 200 })
  try {
    await settle(screen)
    const lines = screen.frame().split("\n")
    const shortcut = lines.filter((line) => line.includes("project") && line.includes("usage"))
    expect(shortcut).toHaveLength(1)
    expect(shortcut[0]).toContain("◇ Master of Release train")
    expect(shortcut[0].indexOf("project")).toBeLessThan(shortcut[0].indexOf("usage"))
    expect(lines.filter((line) => line.includes("members ›"))).toHaveLength(0)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("member chat Projects tab counts members without the Master and names the Master apart", async () => {
  const { screen } = await openMember(120)
  try {
    expect(screen.frame()).not.toContain("MEMBERS 4 + MASTER")
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitForFrame(screen, "MEMBERS 4 + MASTER")
    const frame = screen.frame()
    expect(frame).not.toContain("member 1 of 4")
    const rows = frame.split("\n")
    const at = (title: string) => rows.findIndex((line) => line.includes(title) && /\b(MASTER|MEMBER)\b/.test(line))
    expect(at("Lead")).toBeGreaterThan(-1)
    expect(at("Lead")).toBeLessThan(at("Docs worker"))
    expect(at("Docs worker")).toBeLessThan(at("Api worker"))
    expect(rows[at("Docs worker")]).toContain("● Docs worker")
    expect(frame).toContain("MEMBERS 4 + MASTER")
    expect(frame).not.toContain("MEMBERS 5")
    expect(frame).toContain("2/2 members running")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("Master chat Projects tab counts four members beside the Master", async () => {
  const { screen } = await mountCoordination({ width: 80 })
  try {
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitForFrame(screen, "MEMBERS 4 + MASTER")
    expect(screen.frame()).not.toContain("MEMBERS 5")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("Project chat keeps at most one keymap destroy listener per renderable across refreshes", async () => {
  const { screen, server } = await openMember(120)
  try {
    await screen.waitForEventStream()
    for (let index = 0; index < 6; index++) {
      server.state.sessions[docsID]!.state = index % 2 === 0 ? "running" : "idle"
      screen.events.emit({ id: `evt_${index}`, created: index, type: "coordination.updated", data: { groupID, revision: 7 } } as never)
      await settle(screen, 12)
    }
    await Bun.sleep(5_200)
    await settle(screen)
    const counts: number[] = []
    const visit = (node: Renderable) => {
      counts.push(node.listenerCount(RenderableEvents.DESTROYED))
      node.getChildren().forEach(visit)
    }
    visit(screen.renderer.root)
    expect(counts.length).toBeGreaterThan(50)
    expect(Math.max(...counts)).toBeLessThanOrEqual(1)
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("creating a Project from an existing Session through the real Projects route", async () => {
  const { screen, server, router } = await mountCoordination()
  try {
    router().navigate({ type: "projects", sessionID: leadID })
    await waitForFrame(screen, "preview")
    screen.input.pressKey("n")
    await waitForFrame(screen, "NEW PROJECT")
    await until(screen, () => editing(screen), "Name editor")
    await screen.input.typeText("Ship it")
    await settle(screen)
    const span = screen
      .spans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.includes("Ship it"))!
    expect(contrast(span.fg.toInts(), span.bg.toInts())).toBeGreaterThanOrEqual(4.5)
    screen.input.pressEnter()
    await settle(screen)
    screen.input.pressArrow("down")
    screen.input.pressEnter()
    await until(screen, () => editing(screen), "Find editor")
    await screen.input.typeText("scratch")
    await settle(screen)
    expect(screen.frame()).toContain("Scratch")
    expect(screen.frame()).not.toContain("Planning")
    expect(screen.frame()).not.toContain("Notes worker")
    screen.input.pressEnter()
    await settle(screen)
    screen.input.pressArrow("down")
    screen.input.pressEnter()
    await settle(screen)
    screen.input.pressKey("c")
    await until(screen, () => {
      const route = router().data
      return route.type === "session" && route.sessionID === scratchID
    }, "Master chat")
    expect(server.state.writes.find((write) => write.method === "POST" && write.path === "/api/coordination")?.body).toEqual({
      name: "Ship it",
      masterSessionID: scratchID,
      memberSessionIDs: [],
    })
    await waitForFrame(screen, "◇ Master")
    expect(router().data).toMatchObject({ type: "session", sessionID: scratchID })
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("creating a Project with a new Master in a chosen directory, then adding and creating members", async () => {
  const { screen, server, router } = await mountCoordination()
  try {
    router().navigate({ type: "projects", sessionID: leadID })
    await waitForFrame(screen, "preview")
    screen.input.pressKey("n")
    await waitForFrame(screen, "NEW PROJECT")
    await until(screen, () => editing(screen), "Name editor")
    await screen.input.typeText("Fresh start")
    screen.input.pressEnter()
    await settle(screen)
    screen.input.pressArrow("right")
    await settle(screen)
    screen.input.pressArrow("down")
    screen.input.pressEnter()
    await until(screen, () => editing(screen), "Directory editor")
    await screen.input.typeText("/home/dev/fresh")
    screen.input.pressEnter()
    await settle(screen)
    screen.input.pressKey("c")
    await waitForFrame(screen, "◇ Master")
    expect(router().data).toMatchObject({ type: "session", sessionID: "ses_new00000001" })
    const creates = () => server.state.writes.map((write) => [write.method, write.path, write.body] as const)
    expect(creates().slice(0, 2)).toEqual([
      ["POST", "/api/session", { location: { directory: "/home/dev/fresh" }, title: "Fresh start" }],
      ["POST", "/api/coordination", { name: "Fresh start", masterSessionID: "ses_new00000001", memberSessionIDs: [] }],
    ])
    await settle(screen)
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitForFrame(screen, "MEMBERS 0 + MASTER")
    screen.input.pressKey("a")
    await waitForFrame(screen, "ADD SESSION")
    screen.input.pressEnter()
    await until(screen, () => editing(screen), "Find editor")
    await screen.input.typeText("planning")
    await settle(screen)
    expect(screen.frame()).not.toContain("Scratch")
    screen.input.pressEnter()
    await settle(screen)
    screen.input.pressArrow("down")
    screen.input.pressEnter()
    await waitForFrame(screen, "MEMBERS 1 + MASTER")
    screen.input.pressKey("n")
    await waitForFrame(screen, "NEW SESSION")
    await until(screen, () => editing(screen), "Directory editor")
    await screen.input.typeText("/home/dev/second")
    screen.input.pressEnter()
    await settle(screen)
    screen.input.pressKey("c")
    await waitForFrame(screen, "MEMBERS 2 + MASTER")
    const patches = server.state.writes.filter((write) => write.method === "PATCH").map((write) => write.body)
    expect(patches).toEqual([
      { revision: 1, memberSessionIDs: [planningID] },
      { revision: 2, memberSessionIDs: [planningID, "ses_new00000002"] },
    ])
    expect(screen.frame()).not.toContain("Failed to")
  } finally {
    await screen.dispose()
  }
}, 60_000)

const runningMaster = (width: number) =>
  mountCoordination({
    width,
    backend: {
      sessions: {
        [leadID]: { title: "Lead", directory: "/home/dev/api", state: "running", lastActivity: Date.now(), updated: 1 },
        [docsID]: { title: "Docs worker", directory: "/home/dev/docs", state: "idle", lastActivity: Date.now(), updated: 1 },
      },
      projects: [
        {
          id: groupID,
          name: "Release train",
          revision: 1,
          active: true,
          masterSessionID: leadID,
          memberSessionIDs: [docsID],
          settings: { concurrency: null },
        },
      ],
    },
  })

test("a running Master with an idle member reads as one running Session in the Projects tab and list", async () => {
  const { screen, router } = await runningMaster(120)
  try {
    await settle(screen)
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitForFrame(screen, "MEMBERS 1 + MASTER")
    const frame = screen.frame()
    expect(lineOf(frame, "Docs worker", "MEMBER", "idle")).not.toBe("")
    expect(frame).toContain("0 members running · no limit")
    expect(lineOf(frame, "Lead", "MASTER")).toContain("MASTER ● running")
    router().navigate({ type: "projects", sessionID: leadID })
    await waitForFrame(screen, "preview")
    const list = lineOf(screen.frame(), "Release train", "›")
    expect(list).toContain("● active")
    expect(list).toContain("●1 ○1")
    expect(list).not.toContain("●0")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the narrow Master identity line names the Project without aggregate counts", async () => {
  const { screen } = await runningMaster(80)
  try {
    await settle(screen)
    const identity = lineOf(screen.frame(), "◇ Master")
    expect(identity).toContain("◇ Master")
    expect(identity).not.toMatch(/\d+ running/)
  } finally {
    await screen.dispose()
  }
}, 30_000)
