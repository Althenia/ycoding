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
  run(director, 5_950)
  expect(director.tick(0, false).every((frame) => frame.room === "block")).toBe(true)
  run(director, 20_000)
  const rest = director.tick(0, false)
  expect(rest.every((frame) => frame.room === "lounge" && !frame.moving)).toBe(true)
  expect(rest[0]!.position).not.toEqual(rest[1]!.position)
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

test("delegation and reports speak from exclusive blocks and never replay on settle", () => {
  const director = new OfficeDirector(officeLayout)
  const root = actor("root")
  const child = actor("child", { kind: "task", taskState: "running" })
  director.sync(snapshot([root, child]))
  const initial = director.tick(0, false).map((frame) => frame.position)
  expect(director.playCue({ id: "delegate", kind: "delegate", fromActorID: root.id, toActorID: child.id })).toBe(true)
  expect(director.tick(50, false).map((frame) => frame.speech)).toEqual(["delegate", "chat"])
  expect(director.tick(0, false).map((frame) => frame.position)).toEqual(initial)
  run(director, 2_500)
  expect(director.cueActive(root.id)).toBe(false)
  expect(director.playCue({ id: "report", kind: "report", fromActorID: child.id, toActorID: root.id })).toBe(true)
  expect(director.tick(50, false).map((frame) => frame.speech)).toEqual(["chat", "report"])
  director.settle()
  expect(director.tick(0, false).map((frame) => frame.position)).toEqual(initial)
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

test("idle peers can chat in the relax area without entering another block", () => {
  const director = new OfficeDirector(officeLayout)
  const peers = ["a", "b", "c", "d"].map((name) => actor(`peer-${name}`, { status: "idle" }))
  director.sync(snapshot(peers))
  let chatted = false
  for (let i = 0; i < 500; i++) {
    const frames = director.tick(50, false)
    chatted ||= frames.some((frame) => frame.speech === "chat")
    expect(frames.every((frame) => frame.room === "lounge" && !frame.moving)).toBe(true)
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
  expect(frames.map((frame) => cell(frame.position))).toEqual([table.west, table.east, table.southWest, table.southEast])
  expect(frames.map((frame) => frame.direction)).toEqual(["right", "left", "up", "up"])
  expect(frames.every((frame) => frame.pose === "play" && frame.room === "lounge" && !frame.moving)).toBe(true)
  expect(frames.every((frame) => frame.speech === undefined)).toBe(true)
})

test("a fifth idle agent relaxes elsewhere in the lounge without playing", () => {
  const director = new OfficeDirector(officeLayout)
  director.sync(snapshot(idlePlayers(5)))
  const fifth = director.tick(0, false)[4]!
  expect(fifth.pose).toBe("stand")
  expect(fifth.room).toBe("lounge")
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
    expect(director.tick(0, false)[1]!.pose, status).toBe("play")
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
  expect(frames.map((frame) => frame.pose)).toEqual(["stand", "stand", "stand", "stand"])
  expect(frames.map((frame) => frame.direction)).toEqual(["right", "left", "up", "up"])
  expect(frames.every((frame) => !frame.moving)).toBe(true)
})

test("an idle agent walking to the table does not play until it arrives", () => {
  const director = new OfficeDirector(officeLayout)
  const worker = actor("walker", { activity: "implement" })
  director.sync(snapshot([worker]))
  director.sync(snapshot([{ ...worker, status: "idle" }]))
  run(director, 6_100)
  expect(director.tick(0, false)[0]!.pose).toBe("walk")
  run(director, 40_000)
  const arrived = director.tick(0, false)[0]!
  expect(cell(arrived.position)).toEqual(table.west)
  expect(arrived.pose).toBe("play")
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
