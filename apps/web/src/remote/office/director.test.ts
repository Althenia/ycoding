import { expect, test } from "bun:test"
import { OfficeDirector } from "./director"
import { officeLayout, pods } from "./map"
import { actor, snapshot } from "./layout.test-helper"

const cell = (position: { x: number; y: number }) => ({ x: Math.floor(position.x / 32), y: Math.floor(position.y / 32) })
const inPod = (position: { x: number; y: number }, index: number) => {
  const point = cell(position)
  const pod = pods[index]!
  return point.x >= pod.left && point.x <= pod.right && point.y >= pod.top && point.y <= pod.bottom
}
const run = (director: OfficeDirector, duration: number) => {
  for (let ms = 0; ms < duration; ms += 50) director.tick(50, false)
  return director.tick(0, false)
}
const leisurePhase = (director: OfficeDirector, actorID: string) => director.leisurePhase(actorID)

test("activity changes route at once to the own object and never dwell at stale work", () => {
  const director = new OfficeDirector(officeLayout)
  const worker = actor("worker", { activity: "implement" })
  director.sync(snapshot([worker]))
  expect(cell(director.tick(0, false)[0]!.position)).toEqual(pods[0]!.spots.implement.cell)
  director.sync(snapshot([{ ...worker, activity: "research" }]))
  expect(director.tick(0, false)[0]!.moving).toBe(true)
  run(director, 300)
  director.sync(snapshot([{ ...worker, activity: "verify" }]))
  run(director, 5_000)
  expect(cell(director.tick(0, false)[0]!.position)).toEqual(pods[0]!.spots.verify.cell)
  director.sync(snapshot([{ ...worker, activity: "coordinate" }]))
  run(director, 5_000)
  expect(cell(director.tick(0, false)[0]!.position)).toEqual(pods[0]!.spots.coordinate.cell)
})

test("sixteen agents have distinct reserved blocks regardless of home room or activity", () => {
  const director = new OfficeDirector(officeLayout)
  const workers = Array.from({ length: 16 }, (_, index) => actor(`worker-${index}`, { role: index % 2 ? "Reviewer" : "Researcher", activity: "verify" }))
  director.sync(snapshot(workers))
  expect(director.tick(0, false).map((frame) => cell(frame.position))).toEqual(pods.map((pod) => pod.spots.verify.cell))
  director.sync(snapshot([...workers, actor("overflow")]))
  expect(director.tick(0, false)).toHaveLength(16)
})

test("idle rests at the desk before moving to a unique lounge spot; resuming returns home", () => {
  const director = new OfficeDirector(officeLayout)
  const first = actor("first", { activity: "implement" })
  const second = actor("second", { activity: "implement" })
  director.sync(snapshot([first, second]))
  director.sync(snapshot([{ ...first, status: "idle" }, { ...second, status: "idle" }]))
  run(director, 1_000)
  expect(director.tick(0, false).every((frame) => frame.room === "block")).toBe(true)
  run(director, 40_000)
  const rest = director.tick(0, false)
  expect(rest.every((frame) => ["lounge", "block", "hall"].includes(frame.room ?? ""))).toBe(true)
  expect(new Set(rest.map((frame) => `${cell(frame.position).x},${cell(frame.position).y}`)).size).toBe(rest.length)
  director.sync(snapshot([first, second]))
  run(director, 20_000)
  expect(director.tick(0, false).map((frame) => cell(frame.position))).toEqual(pods.slice(0, 2).map((pod) => pod.spots.implement.cell))
})

test("arrival and departure use the perimeter without traversing another block", () => {
  const director = new OfficeDirector(officeLayout)
  const root = actor("root")
  const child = actor("child", { kind: "task", taskState: "running" })
  director.sync(snapshot([root]))
  director.sync(snapshot([root, child]))
  expect(cell(director.tick(0, false)[1]!.position)).toEqual(officeLayout.door)
  for (let i = 0; i < 500; i++) {
    const frame = director.tick(50, false).find((item) => item.actor.id === child.id)!
    const point = cell(frame.position)
    expect(pods.every((pod, index) => index === 1 || point.x < pod.left || point.x > pod.right || point.y < pod.top || point.y > pod.bottom)).toBe(true)
    if (!frame.moving) break
  }
  expect(cell(director.tick(0, false)[1]!.position)).toEqual(pods[1]!.spots.implement.cell)
  director.sync(snapshot([root, { ...child, taskState: "completed" }]))
  for (let i = 0; i < 500 && director.tick(0, false).some((item) => item.actor.id === child.id); i++) director.tick(50, false)
  expect(director.tick(0, false).some((item) => item.actor.id === child.id)).toBe(false)
})

test("backend work, attention, and connection facts clear decorative chat on the next snapshot", () => {
  for (const [status, connection, source] of [
    ["working", "ready", "projection"],
    ["attention", "ready", "projection"],
    ["offline", "offline", "unavailable"],
  ] as const) {
    const director = new OfficeDirector(officeLayout)
    const peers = ["a", "b", "c", "d"].map((id) => actor(id, { status: "idle" }))
    director.sync(snapshot(peers))
    let chatting = false
    for (let index = 0; index < 500; index += 1) chatting ||= director.tick(50, false).some((frame) => frame.speech === "chat")
    expect(chatting).toBe(true)
    director.sync(snapshot([{ ...peers[0]!, status, source }, ...peers.slice(1)], { connection }))
    expect(director.tick(0, false).find((frame) => frame.actor.id === peers[0]!.id)?.speech).toBeUndefined()
  }
})

test("clearing an ambient gesture preserves corroborated handoff feedback", () => {
  const director = new OfficeDirector(officeLayout)
  const peers = ["a", "b", "c", "d"].map((id) => actor(id, { status: "idle" }))
  director.sync(snapshot(peers))
  let ambient = director.tick(0, false).filter((frame) => frame.speech === "chat")
  for (let index = 0; !ambient.length && index < 500; index += 1) ambient = director.tick(50, false).filter((frame) => frame.speech === "chat")
  expect(ambient.length).toBeGreaterThanOrEqual(2)
  const root = peers.find((peer) => peer.id === ambient[0]!.actor.id)!
  const child = peers.find((peer) => peer.id === ambient[1]!.actor.id)!
  expect(director.playCue({ id: "delegate", kind: "delegate", fromActorID: root.id, toActorID: child.id })).toBe(true)
  director.sync(snapshot([{ ...root, status: "thinking" }, ...peers.filter((peer) => peer.id !== root.id)]))
  expect(director.tick(0, false).find((frame) => frame.actor.id === root.id)?.speech).toBe("delegate")
})

test("delegation and reports face only the two participants and restore activity facing", () => {
  const director = new OfficeDirector(officeLayout)
  const root = actor("root")
  const child = actor("child", { kind: "task", taskState: "running" })
  const peer = actor("peer", { activity: "research" })
  director.sync(snapshot([root, child, peer]))
  const initial = director.tick(0, false)
  expect(director.playCue({ id: "delegate", kind: "delegate", fromActorID: root.id, toActorID: child.id })).toBe(true)
  const during = director.tick(50, false)
  expect(during.map((frame) => frame.speech)).toEqual(["delegate", "chat", undefined])
  expect(during.map((frame) => frame.position)).toEqual(initial.map((frame) => frame.position))
  expect(during.slice(0, 2).map((frame) => frame.direction)).toEqual(["right", "left"])
  expect(during[2]!.direction).toBe(initial[2]!.direction)
  run(director, 2_500)
  expect(director.cueActive(root.id)).toBe(false)
  expect(director.tick(0, false).map((frame) => frame.direction)).toEqual([pods[0]!.spots.implement.facing, pods[1]!.spots.implement.facing, pods[2]!.spots.research.facing])
  expect(director.playCue({ id: "report", kind: "report", fromActorID: child.id, toActorID: root.id })).toBe(true)
  expect(director.tick(50, false).map((frame) => frame.speech)).toEqual(["chat", "report"])
  director.sync(snapshot([root, { ...child, status: "attention" }, peer], { cues: [{ id: "report", kind: "report", fromActorID: child.id, toActorID: root.id }] }))
  expect(director.tick(0, false).find((frame) => frame.actor.id === child.id)?.pose).toBe("wave")
  director.settle()
  expect(director.tick(0, false).map((frame) => frame.position)).toEqual(initial.map((frame) => frame.position))
  expect(director.tick(0, false).every((frame) => !frame.speech)).toBe(true)
})

test("offline freezes travel and reduced motion settles directly without paths", () => {
  const director = new OfficeDirector(officeLayout)
  const worker = actor("worker", { activity: "implement" })
  director.sync(snapshot([worker]))
  director.sync(snapshot([{ ...worker, activity: "research" }]))
  const before = director.tick(0, false)[0]!.position
  director.sync(snapshot([{ ...worker, activity: "research" }], { connection: "offline" }))
  run(director, 1_000)
  expect(director.tick(0, false)[0]!.position).toEqual(before)
  director.sync(snapshot([{ ...worker, activity: "research" }]))
  expect(cell(director.tick(0, true)[0]!.position)).toEqual(pods[0]!.spots.research.cell)
  expect(director.tick(0, true)[0]!.moving).toBe(false)
})

test("idle peers can receive a decorative ambient gesture without leaving their facts", () => {
  const director = new OfficeDirector(officeLayout)
  const peers = ["a", "b", "c", "d"].map((name) => actor(`peer-${name}`, { status: "idle" }))
  director.sync(snapshot(peers))
  let chatted = false
  for (let i = 0; i < 500; i++) {
    const frames = director.tick(50, false)
    chatted ||= frames.some((frame) => frame.speech === "chat")
    expect(frames.every((frame) => frame.actor.status === "idle" && !frame.actor.bubble)).toBe(true)
  }
  expect(chatted).toBe(true)
})

test("settling a terminal reported child does not strand it in the scene", () => {
  const director = new OfficeDirector(officeLayout)
  const root = actor("root")
  const child = actor("child", { kind: "task", taskState: "running" })
  director.sync(snapshot([root, child]))
  director.sync(snapshot([root, { ...child, taskState: "completed" }], { cues: [{ id: "report", kind: "report", fromActorID: child.id, toActorID: root.id }] }))
  director.settle()
  expect(director.tick(0, true).map((frame) => frame.actor.id)).toEqual([root.id])
})

test("a reported terminal child leaves after its corroborated cue expires", () => {
  const director = new OfficeDirector(officeLayout)
  const root = actor("root")
  const child = actor("child", { kind: "task", taskState: "running" })
  director.sync(snapshot([root, child]))
  expect(director.playCue({ id: "report", kind: "report", fromActorID: child.id, toActorID: root.id })).toBe(true)
  director.sync(snapshot([root, { ...child, taskState: "completed" }], { cues: [{ id: "report", kind: "report", fromActorID: child.id, toActorID: root.id, outcome: "completed" }] }))
  expect(director.tick(0, false).find((frame) => frame.actor.id === child.id)?.leaving).toBe(false)
  run(director, 2_100)
  expect(director.tick(0, false).find((frame) => frame.actor.id === child.id)?.leaving).toBe(true)
})

const loading = { team: { status: "loading" as const, total: 0, shown: 0, more: false }, activityStatus: "loading" as const }
const ready = { team: { status: "ready" as const, total: 2, shown: 2, more: false }, activityStatus: "ready" as const }
const known = () => {
  const root = actor("root", { activity: "implement" })
  const first = actor("first", { kind: "task", taskState: "running", activity: "research" })
  const second = actor("second", { kind: "task", taskState: "running", status: "idle" })
  return { root, first, second, all: [root, first, second] }
}
const placements = (director: OfficeDirector) => director.tick(0, false).map((frame) => ({ id: frame.actor.id, cell: cell(frame.position), moving: frame.moving, leaving: frame.leaving }))

test("first hydration waits for the family inputs, then seats every known member directly from authoritative activity", () => {
  const director = new OfficeDirector(officeLayout)
  const family = known()
  director.sync(snapshot([family.root], loading))
  expect(director.tick(0, false)).toEqual([])
  director.sync(snapshot([family.root], { team: ready.team, activityStatus: "loading" }))
  expect(director.tick(0, false)).toEqual([])
  director.sync(snapshot(family.all, ready))
  const frames = placements(director)
  expect(frames.map((frame) => frame.id)).toEqual(["root", "first", "second"])
  expect(frames.every((frame) => !frame.moving && !frame.leaving)).toBe(true)
  expect(frames[0]!.cell).toEqual(pods[0]!.spots.implement.cell)
  expect(frames[1]!.cell).toEqual(pods[1]!.spots.research.cell)
  expect(director.tick(0, false)[2]!.room).toBe("lounge")
})

test("returning to a known Session after another follows the same initial hydration rule", () => {
  const director = new OfficeDirector(officeLayout)
  const family = known()
  director.sync(snapshot(family.all, { ...ready, scope: "scope-a" }))
  const seated = placements(director)
  director.sync(snapshot([actor("other")], { scope: "scope-b" }))
  director.sync(snapshot([family.root], { ...loading, scope: "scope-a" }))
  expect(director.tick(0, false)).toEqual([])
  director.sync(snapshot(family.all, { ...ready, scope: "scope-a" }))
  expect(placements(director)).toEqual(seated)
})

test("a genuinely new member after the scene is ready enters from the door", () => {
  const director = new OfficeDirector(officeLayout)
  const family = known()
  director.sync(snapshot(family.all, ready))
  const newcomer = actor("newcomer", { kind: "task", taskState: "running" })
  director.sync(snapshot([...family.all, newcomer], ready))
  const frame = director.tick(0, false).find((item) => item.actor.id === "newcomer")!
  expect(cell(frame.position)).toEqual(officeLayout.door)
  expect(frame.moving).toBe(true)
  expect(placements(director).filter((item) => item.id !== "newcomer").every((item) => !item.moving)).toBe(true)
})

test("settled unsupported, failed, and disconnected inputs never hold the office empty", () => {
  const root = actor("root")
  const cases = [
    { team: { status: "unsupported" as const, total: 0, shown: 0, more: false }, activityStatus: "loading" as const },
    { team: { status: "error" as const, total: 0, shown: 0, more: false }, activityStatus: "loading" as const },
    { team: { status: "ready" as const, total: 0, shown: 0, more: false }, activityStatus: "unsupported" as const },
    { team: { status: "ready" as const, total: 0, shown: 0, more: false }, activityStatus: "error" as const },
    { team: { status: "none" as const, total: 0, shown: 0, more: false }, activityStatus: "loading" as const },
    { ...loading, connection: "offline" as const },
    { ...loading, connection: "reconnecting" as const },
  ]
  for (const options of cases) {
    const director = new OfficeDirector(officeLayout)
    director.sync(snapshot([root], options))
    expect(director.tick(0, false).map((frame) => frame.actor.id), JSON.stringify(options)).toEqual(["root"])
  }
})

test("a background refresh to loading keeps loaded members in place instead of departing them", () => {
  const director = new OfficeDirector(officeLayout)
  const family = known()
  director.sync(snapshot(family.all, ready))
  const seated = placements(director)
  director.sync(snapshot([family.root], loading))
  director.tick(50, false)
  expect(placements(director)).toEqual(seated)
  director.sync(snapshot(family.all, ready))
  expect(placements(director)).toEqual(seated)
})

const table = { west: { x: 14, y: 26 }, east: { x: 19, y: 26 }, southWest: { x: 16, y: 28 }, southEast: { x: 17, y: 28 } }
const idlePlayers = (count: number) => Array.from({ length: count }, (_, index) => actor(`player-${index}`, { status: "idle" }))

test("idle agents take the table-tennis spots first, facing the table and playing", () => {
  const director = new OfficeDirector(officeLayout)
  director.sync(snapshot(idlePlayers(4)))
  const frames = director.tick(0, false)
  expect(frames.every((frame) => frame.room === "lounge" && !frame.moving)).toBe(true)
  expect(frames.filter((frame) => frame.pose === "play").map((frame) => cell(frame.position)).sort((a, b) => a.x - b.x || a.y - b.y)).toEqual([table.west, table.east, table.southWest, table.southEast].sort((a, b) => a.x - b.x || a.y - b.y))
  expect(frames.filter((frame) => frame.pose === "play").every((frame) => frame.room === "lounge")).toBe(true)
  expect(frames.every((frame) => frame.speech === undefined)).toBe(true)
})

test("a fifth idle agent relaxes elsewhere in the lounge without playing", () => {
  const director = new OfficeDirector(officeLayout)
  director.sync(snapshot(idlePlayers(5)))
  const fifth = director.tick(0, false)[4]!
  expect(["sit", "stand"]).toContain(fifth.pose)
  expect(fifth.room).toBe("lounge")
})

test("identity-seeded idle schedules vary reproducibly, reach leisure only after travel, and return to the desk", () => {
  const schedule = (identity: string) => {
    const director = new OfficeDirector(officeLayout)
    const worker = actor(identity, { activity: "implement" })
    director.sync(snapshot([worker]))
    director.sync(snapshot([{ ...worker, status: "idle", activity: undefined }]))
    const phases = new Set<string>()
    const timeline: string[] = []
    let previousPhase = ""
    let returnedHome = false
    for (let index = 0; index < 2_400; index++) {
      const frame = director.tick(50, false)[0]!
      const currentPhase = leisurePhase(director, frame.actor.id)
      phases.add(currentPhase?.kind ?? "none")
      const currentStage = currentPhase?.kind === "stretch" ? `${currentPhase.kind}:${currentPhase.stage}`
        : currentPhase?.kind === "travel" ? `${currentPhase.kind}:${currentPhase.arrival}` : currentPhase?.kind ?? "none"
      if (currentStage !== previousPhase) timeline.push(`${currentStage}:${index}`)
      previousPhase = currentStage
      if (currentPhase?.kind === "travel") expect(frame.pose).toBe("walk")
      if (currentPhase?.kind === "pantry") {
        expect(frame.position).toEqual({ x: 34 * 32 + 16, y: 31 * 32 + 16 })
        expect(frame.direction).toBe("up")
        expect(frame.pose).not.toBe("sit")
      }
      if (currentPhase?.kind === "rest" || currentPhase?.kind === "table") expect(frame.moving).toBe(false)
      if (currentPhase?.kind === "desk" && cell(frame.position).x === pods[0]!.spots.implement.cell.x && cell(frame.position).y === pods[0]!.spots.implement.cell.y) returnedHome = true
    }
    return { phases: [...phases].sort(), timeline, returnedHome }
  }
  const first = schedule("identity-one")
  expect(schedule("identity-one")).toEqual(first)
  expect(first.phases).toContain("desk")
  expect(first.phases).toContain("travel")
  expect(first.phases.some((phase) => ["pantry", "rest", "table"].includes(phase))).toBe(true)
  expect(first.phases).toContain("return")
  expect(first.returnedHome).toBe(true)
  expect(schedule("identity-two").timeline).not.toEqual(first.timeline)
})

test("leisure claims stay unique and release when a worker resumes", () => {
  const director = new OfficeDirector(officeLayout)
  const workers = Array.from({ length: 10 }, (_, index) => actor(`reserved-${index}`, { activity: "implement" }))
  director.sync(snapshot(workers))
  director.sync(snapshot(workers.map((worker) => ({ ...worker, status: "idle" as const, activity: undefined }))))
  for (let index = 0; index < 1_000; index++) {
    const frames = director.tick(50, false)
    const claimed = frames.flatMap((frame) => leisurePhase(director, frame.actor.id)?.kind === "rest" || leisurePhase(director, frame.actor.id)?.kind === "table" ? [`${cell(frame.position).x},${cell(frame.position).y}`] : [])
    expect(new Set(claimed).size).toBe(claimed.length)
  }
  director.sync(snapshot([{ ...workers[0]!, status: "working" }, ...workers.slice(1).map((worker) => ({ ...worker, status: "idle" as const, activity: undefined }))]))
  expect(leisurePhase(director, workers[0]!.id)).toBeUndefined()
})

test("work, attention, offline, and reduced motion cancel idle phases without catch-up", () => {
  for (const interrupt of ["working", "attention", "offline", "reduced"] as const) {
    const director = new OfficeDirector(officeLayout)
    const worker = actor(`interrupt-${interrupt}`, { activity: "implement" })
    director.sync(snapshot([worker]))
    director.sync(snapshot([{ ...worker, status: "idle", activity: undefined }]))
    run(director, 10_000)
    if (interrupt === "reduced") director.tick(50, true)
    else director.sync(snapshot([{ ...worker, status: interrupt === "offline" ? "offline" : interrupt, source: interrupt === "offline" ? "unavailable" : "projection" }], { connection: interrupt === "offline" ? "offline" : "ready" }))
    const stopped = director.tick(0, interrupt === "reduced")
    expect(director.leisurePhase(worker.id), interrupt).toBeUndefined()
    if (interrupt === "working" || interrupt === "attention") {
      director.sync(snapshot([{ ...worker, status: "idle", activity: undefined }]))
      expect(director.leisurePhase(worker.id)?.kind).toBe("desk")
    }
  }
})

test("summary-only idle actors never enter a decorative schedule", () => {
  const director = new OfficeDirector(officeLayout)
  const projected = actor("source-check", { status: "idle" })
  director.sync(snapshot([{ ...projected, source: "summary" }]))
  run(director, 30_000)
  expect(director.leisurePhase(projected.id)).toBeUndefined()
  expect(director.tick(0, false)[0]!.actor.status).toBe("idle")
})

test("every leisure phase can be interrupted, including visibility suspension", () => {
  for (const phase of ["desk", "stretch", "travel", "pantry", "rest", "table", "return"] as const) {
    const director = new OfficeDirector(officeLayout)
    const worker = actor(`phase-${phase}`, { status: "idle" })
    director.sync(snapshot([worker]))
    director.tick(0, false)
    for (let index = 0; index < 8_000 && director.leisurePhase(worker.id)?.kind !== phase; index++) director.tick(50, false)
    expect(director.leisurePhase(worker.id)?.kind, phase).toBe(phase)
    director.sync(snapshot([{ ...worker, status: "attention" }]))
    expect(director.leisurePhase(worker.id), phase).toBeUndefined()
  }
  const hiddenDirector = new OfficeDirector(officeLayout)
  const hiddenWorker = actor("phase-hidden", { status: "idle" })
  hiddenDirector.sync(snapshot([hiddenWorker]))
  hiddenDirector.settle()
  expect(hiddenDirector.leisurePhase(hiddenWorker.id)).toBeUndefined()
})

test("any non-idle backend fact stops play at once and returns the agent to its own claim", () => {
  for (const status of ["working", "thinking", "tool", "attention", "failed", "interrupted"] as const) {
    const director = new OfficeDirector(officeLayout)
    const players = idlePlayers(2)
    director.sync(snapshot(players))
    expect(director.tick(0, false)[0]!.pose).toBe("play")
    director.sync(snapshot([{ ...players[0]!, status }, players[1]!]))
    const first = director.tick(0, false)[0]!
    expect(first.pose, status).not.toBe("play")
    expect(first.moving, status).toBe(true)
    for (let i = 0; i < 400; i++) director.tick(50, false)
    expect(director.tick(0, false)[1]!.actor.status, status).toBe("idle")
    expect(inPod(director.tick(0, false)[0]!.position, 0), status).toBe(true)
  }
})

test("reconnecting or offline never shows play", () => {
  for (const connection of ["reconnecting", "offline"] as const) {
    const director = new OfficeDirector(officeLayout)
    const players = idlePlayers(2)
    director.sync(snapshot(players))
    director.sync(snapshot(players.map((player) => ({ ...player, status: connection, source: "unavailable" as const })), { connection }))
    expect(director.tick(0, false).some((frame) => frame.pose === "play"), connection).toBe(false)
  }
})

test("reduced motion shows the static stand pose facing the table", () => {
  const director = new OfficeDirector(officeLayout)
  director.sync(snapshot(idlePlayers(4)))
  const frames = director.tick(0, true)
  expect(frames.map((frame) => frame.pose)).toEqual(["sit", "sit", "sit", "sit"])
  expect(frames.every((frame) => !frame.moving)).toBe(true)
})

test("an idle agent walking to leisure performs only after it arrives", () => {
  const director = new OfficeDirector(officeLayout)
  const worker = actor("walker", { activity: "implement" })
  director.sync(snapshot([worker]))
  director.sync(snapshot([{ ...worker, status: "idle" }]))
  for (let index = 0; index < 4_000 && director.leisurePhase(worker.id)?.kind !== "travel"; index++) director.tick(50, false)
  expect(director.leisurePhase(worker.id)?.kind).toBe("travel")
  expect(director.tick(0, false)[0]!.pose).toBe("walk")
  for (let index = 0; index < 4_000 && director.leisurePhase(worker.id)?.kind === "travel"; index++) director.tick(50, false)
  const arrived = director.tick(0, false)[0]!
  expect(director.leisurePhase(worker.id)?.kind).toMatch(/^(pantry|rest|table)$/)
  expect(arrived.moving).toBe(false)
})

test("degraded loading data never retargets or re-poses members already on the floor", () => {
  const director = new OfficeDirector(officeLayout)
  const family = known()
  director.sync(snapshot(family.all, ready))
  const seated = director.tick(0, false).map((frame) => ({ id: frame.actor.id, pose: frame.pose, cell: cell(frame.position), moving: frame.moving, status: frame.actor.status }))
  const degraded = family.all.map((member) => ({ ...member, status: "unknown" as const, activity: undefined, source: "summary" as const }))
  director.sync(snapshot(degraded, loading))
  director.tick(50, false)
  expect(director.tick(0, false).map((frame) => ({ id: frame.actor.id, pose: frame.pose, cell: cell(frame.position), moving: frame.moving, status: frame.actor.status }))).toEqual(seated)
})
