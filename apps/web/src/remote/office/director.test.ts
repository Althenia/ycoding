import { expect, test } from "bun:test"
import { OfficeDirector } from "./director"
import { findPath } from "./navigation"
import { actor, officeLayout, snapshot } from "./layout.test-helper"

const center = (cell: { x: number; y: number }) => ({ x: cell.x * 32 + 16, y: cell.y * 32 + 16 })
const cellAt = (point: { x: number; y: number }) => ({ x: Math.floor(point.x / 32), y: Math.floor(point.y / 32) })
const run = (director: OfficeDirector, ms = 50) => director.tick(ms, false)
const frame = (director: OfficeDirector, id: string) => director.tick(0, false).find((item) => item.actor.id === id)!

test("navigation uses injected walkability and excludes its start", () => {
  const layout = officeLayout()
  const path = findPath(layout, { x: 1, y: 10 }, { x: 3, y: 10 })!
  expect(path[0]).not.toEqual({ x: 1, y: 10 })
  expect(path.at(-1)).toEqual({ x: 3, y: 10 })
  expect(path.every((point) => layout.walkable(point.x, point.y))).toBe(true)
  expect(path.every((point, index) => {
    const previous = index ? path[index - 1]! : { x: 1, y: 10 }
    return Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) === 1
  })).toBe(true)
  expect(findPath(layout, { x: 4, y: 4 }, { x: 4, y: 4 })).toEqual([])
  expect(findPath(layout, { x: 2, y: 8 }, { x: 14, y: 8 })).toBeUndefined()
  expect(findPath(layout, { x: 2, y: 8 }, { x: 30, y: 8 })).toBeUndefined()
  expect(findPath(layout, { x: 14, y: 8 }, { x: 15, y: 8 })).toBeUndefined()
})

test("hydrates directly into unique home work spots and same destination status changes do not move", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const first = actor("work", { homeRoom: "developer" })
  director.sync(snapshot([first]))
  const initial = frame(director, first.id)
  expect(initial.position).toEqual(center(layout.work.developer[0]!.cell))
  expect(initial.moving).toBe(false)
  expect(initial.room).toBe("developer")
  expect(initial.pose).toBe("type")
  director.sync(snapshot([{ ...first, status: "tool" }]))
  expect(frame(director, first.id).position).toEqual(initial.position)
})

test("a running root leaves the lounge for a Developer desk and stays there while thinking", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const root = actor("root", { kind: "session", homeRoom: "developer", status: "idle" })
  director.sync(snapshot([root]))
  expect(frame(director, root.id).room).toBe("lounge")
  for (const status of ["working", "thinking"] as const) {
    director.sync(snapshot([{ ...root, status, bubble: status === "thinking" ? "Thinking" : "Working" }]))
    for (let step = 0; step < 500 && frame(director, root.id).moving; step++) run(director)
    const current = frame(director, root.id)
    expect(current.room).toBe("developer")
    expect(current.position).toEqual(center(layout.work.developer[0]!.cell))
    expect(current.actor.bubble).toBe(status === "thinking" ? "Thinking" : "Working")
  }
})

test("work and lounge transitions route on walkable cells and return to the reserved work spot", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const initialActor = actor("worker")
  director.sync(snapshot([initialActor]))
  director.sync(snapshot([{ ...initialActor, status: "idle" }]))
  let moved = false
  for (let index = 0; index < 300; index++) {
    const current = run(director)
    const worker = current.find((item) => item.actor.id === initialActor.id)!
    moved ||= worker.moving
    expect(layout.walkable(cellAt(worker.position).x, cellAt(worker.position).y)).toBe(true)
    if (moved && !worker.moving) break
  }
  expect(moved).toBe(true)
  expect(frame(director, initialActor.id).room).toBe("lounge")
  expect(layout.lounge.map((spot) => center(spot.cell))).toContainEqual(frame(director, initialActor.id).position)
  director.sync(snapshot([initialActor]))
  for (let index = 0; index < 500 && frame(director, initialActor.id).moving; index++) run(director)
  expect(frame(director, initialActor.id).position).toEqual(center(layout.work.developer[0]!.cell))
})

test("selected research and QA verification roam their stations while implementation types and coordination meets", () => {
  for (const [activity, room] of [["research", "research"], ["verify", "qa"]] as const) {
    const layout = officeLayout()
    const director = new OfficeDirector(layout)
    const active = actor(`selected-${activity}`, { selected: true, homeRoom: "developer", activity })
    director.sync(snapshot([active]))
    const visited = new Set<string>()
    for (let step = 0; step < 1300; step++) {
      const current = run(director).find((item) => item.actor.id === active.id)!
      if (current.room === room && !current.moving) visited.add(JSON.stringify(current.position))
    }
    expect(visited.size, activity).toBeGreaterThanOrEqual(2)
    expect(frame(director, active.id).room).toBe(room)
    director.sync(snapshot([{ ...active, activity: "hold" }]))
    for (let step = 0; step < 200 && frame(director, active.id).moving; step++) run(director)
    const held = frame(director, active.id).position
    for (let step = 0; step < 200; step++) run(director)
    expect(frame(director, active.id).position).toEqual(held)
  }
  const director = new OfficeDirector(officeLayout())
  const builder = actor("builder", { activity: "implement", homeRoom: "developer", selected: true })
  director.sync(snapshot([builder]))
  expect(frame(director, builder.id)).toMatchObject({ room: "developer", pose: "type" })
  director.sync(snapshot([{ ...builder, activity: "coordinate" }]))
  for (let step = 0; step < 500 && frame(director, builder.id).moving; step++) run(director)
  expect(frame(director, builder.id).room).toBe("meeting")
  const reduced = new OfficeDirector(officeLayout())
  reduced.sync(snapshot([actor("quiet", { selected: true, activity: "research", homeRoom: "research" })]))
  const start = reduced.tick(0, true)[0]!.position
  for (let step = 0; step < 1000; step++) reduced.tick(50, true)
  expect(reduced.tick(0, true)[0]!.position).toEqual(start)
})

test("newly reported actors enter from the door with a 400 ms opacity ramp", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const base = actor("root")
  director.sync(snapshot([base]))
  director.sync(snapshot([base, actor("new", { homeRoom: "qa" })]))
  expect(cellAt(frame(director, "new").position)).toEqual(layout.door)
  expect(frame(director, "new").opacity).toBe(0)
  for (let index = 0; index < 8; index++) run(director)
  expect(frame(director, "new").opacity).toBeGreaterThan(0)
  for (let index = 0; index < 500 && frame(director, "new").moving; index++) run(director)
  expect(frame(director, "new").room).toBe("qa")
  const task = actor("task", { kind: "task", homeRoom: "research" })
  director.sync(snapshot([base, actor("new", { homeRoom: "qa" }), task], { team: { status: "ready", rootActorID: base.id, total: 1, shown: 1, more: false } }))
  expect(cellAt(frame(director, task.id).position)).toEqual(layout.door)
  expect(frame(director, task.id).opacity).toBe(0)
})

test("a newly reported child enters from the lobby and leaves after completion or cancellation", () => {
  for (const taskState of ["completed", "cancelled"] as const) {
    const layout = officeLayout()
    const director = new OfficeDirector(layout)
    const root = actor("root", { kind: "session", homeRoom: "developer" })
    const child = actor("child", { kind: "task", teamRootSessionID: root.sessionID, homeRoom: "qa", taskState: "running" })
    const team = { status: "ready" as const, rootActorID: root.id, total: 1, shown: 1, more: false }
    director.sync(snapshot([root], { team: { ...team, total: 0, shown: 0 } }))
    director.sync(snapshot([root, child], { team }))
    expect(cellAt(frame(director, child.id).position)).toEqual(layout.door)
    expect(frame(director, child.id).opacity).toBe(0)
    for (let step = 0; step < 500 && frame(director, child.id).moving; step++) run(director)
    expect(frame(director, child.id).room).toBe("qa")
    director.sync(snapshot([root, { ...child, status: "idle", taskState }], { team }))
    expect(frame(director, child.id).leaving).toBe(true)
    for (let step = 0; step < 500 && director.tick(0, false).some((item) => item.actor.id === child.id); step++) run(director)
    expect(director.tick(0, false).some((item) => item.actor.id === child.id)).toBe(false)
    expect(frame(director, root.id).leaving).toBe(false)
  }
})

test("a terminal child reports to the supervisor before exiting and cannot reappear from the same report", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const root = actor("root", { homeRoom: "developer" })
  const child = actor("child", { kind: "task", teamRootSessionID: root.id, taskState: "running" })
  const team = { status: "ready" as const, rootActorID: root.id, total: 1, shown: 1, more: false }
  director.sync(snapshot([root, child], { team }))
  const cue = { id: "report-terminal", kind: "report" as const, fromActorID: child.id, toActorID: root.id, outcome: "completed" as const }
  const settled = snapshot([root, { ...child, status: "idle", taskState: "completed" }], { team, cues: [cue] })
  director.sync(settled)
  expect(frame(director, child.id).leaving).toBe(false)
  expect(director.playCue(cue)).toBe(true)
  let spoke = false
  let departed = false
  for (let step = 0; step < 600; step++) {
    const frames = run(director)
    spoke ||= frames.some((item) => item.actor.id === child.id && item.speech === "report")
    departed ||= frames.some((item) => item.actor.id === child.id && item.leaving)
    if (spoke && departed && !frames.some((item) => item.actor.id === child.id)) break
  }
  expect(spoke).toBe(true)
  expect(departed).toBe(true)
  expect(director.tick(0, false).some((item) => item.actor.id === child.id)).toBe(false)
  director.sync(settled)
  expect(director.tick(0, false).some((item) => item.actor.id === child.id)).toBe(false)
  expect(frame(director, root.id).leaving).toBe(false)
})

test("a terminal update during delegation keeps the child headed to the meeting before departure", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const root = actor("root", { homeRoom: "developer" })
  const child = actor("child", { kind: "task", teamRootSessionID: root.id, homeRoom: "developer", taskState: "running" })
  const team = { status: "ready" as const, rootActorID: root.id, total: 1, shown: 1, more: false }
  director.sync(snapshot([root, child], { team }))
  expect(director.playCue({ id: "delegate", kind: "delegate", fromActorID: root.id, toActorID: child.id })).toBe(true)
  for (let step = 0; step < 20; step++) run(director)
  director.sync(snapshot([root, { ...child, status: "idle", taskState: "completed" }], { team }))
  let met = false
  for (let step = 0; step < 600; step++) {
    const frames = run(director)
    const rootFrame = frames.find((item) => item.actor.id === root.id)
    const childFrame = frames.find((item) => item.actor.id === child.id)
    met ||= rootFrame?.room === "meeting" && childFrame?.room === "meeting" && childFrame.speech === "chat"
  }
  expect(met).toBe(true)
  expect(director.tick(0, false).some((item) => item.actor.id === child.id)).toBe(false)
})

test("team root replacement drops old task actors and hydrates new task actors directly", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const root = actor("root")
  const oldTask = actor("old-task", { kind: "task", homeRoom: "research" })
  director.sync(snapshot([root, oldTask], { team: { status: "ready", rootActorID: root.id, total: 1, shown: 1, more: false } }))
  director.sync(snapshot([root, actor("new-task", { kind: "task", homeRoom: "qa" })], {
    team: { status: "ready", rootActorID: "new-root", total: 1, shown: 1, more: false },
  }))
  const frames = director.tick(0, false)
  expect(frames.some((item) => item.actor.id === oldTask.id)).toBe(false)
  expect(frames.find((item) => item.actor.id === "new-task")?.position).toEqual(center(layout.work.qa[0]!.cell))
})

test("departures walk to the entrance, reappearance cancels leaving, and scope/reduced motion settle", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const item = actor("leaver")
  director.sync(snapshot([item]))
  director.sync(snapshot([]))
  expect(frame(director, item.id).leaving).toBe(true)
  director.sync(snapshot([item]))
  expect(frame(director, item.id).leaving).toBe(false)
  director.sync(snapshot([], { scope: "scope-b" }))
  expect(director.tick(0, false)).toHaveLength(0)
  const exiting = new OfficeDirector(layout)
  exiting.sync(snapshot([item]))
  exiting.sync(snapshot([]))
  const departing = exiting.tick(50, false).find((entry) => entry.actor.id === item.id)
  expect(departing?.leaving).toBe(true)
  expect(departing?.opacity).toBeLessThan(1)
  for (let index = 0; index < 500 && exiting.tick(0, false).length; index++) run(exiting)
  expect(exiting.tick(0, false)).toHaveLength(0)
  const reduced = new OfficeDirector(layout)
  reduced.sync(snapshot([item]))
  reduced.tick(0, true)
  reduced.sync(snapshot([]))
  expect(reduced.tick(0, true)).toHaveLength(0)
  director.sync(snapshot([item], { scope: "scope-b" }))
  director.sync(snapshot([{ ...item, status: "idle" }], { scope: "scope-b" }))
  const settled = director.tick(500, true).find((item) => item.actor.id === "leaver")!
  expect(settled.moving).toBe(false)
  expect(settled.opacity).toBe(1)
  expect(layout.lounge.map((spot) => center(spot.cell))).toContainEqual(settled.position)
})

test("delegate choreography meets, talks, and returns both actors within the bound", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const supervisor = actor("supervisor", { homeRoom: "developer" })
  const child = actor("child", { kind: "task", homeRoom: "developer" })
  director.sync(snapshot([supervisor, child]))
  expect(director.playCue({ id: "briefing", kind: "delegate", fromActorID: supervisor.id, toActorID: child.id })).toBe(true)
  expect(director.cueActive(supervisor.id)).toBe(true)
  let speech = false
  let childSpeech = false
  for (let index = 0; index < 600 && director.cueActive(supervisor.id); index++) {
    const frames = director.tick(50, false)
    speech ||= frames.some((item) => item.speech === "delegate")
    childSpeech ||= frames.some((item) => item.actor.id === child.id && item.speech === "chat" && item.pose === "talk")
  }
  expect(speech).toBe(true)
  expect(childSpeech).toBe(true)
  expect(director.cueActive(supervisor.id)).toBe(false)
  expect(frame(director, supervisor.id).position).toEqual(center(layout.work.developer[0]!.cell))
  expect(frame(director, child.id).position).toEqual(center(layout.work.developer[1]!.cell))
})

test("report choreography returns an idle child to the lounge; cue refusal is truthful", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const supervisor = actor("supervisor", { homeRoom: "developer" })
  const child = actor("child", { kind: "task", status: "idle", homeRoom: "developer" })
  director.sync(snapshot([supervisor, child]))
  expect(director.playCue({ id: "report", kind: "report", fromActorID: child.id, toActorID: supervisor.id })).toBe(true)
  let adjacentReport = false
  for (let index = 0; index < 600 && director.cueActive(child.id); index++) {
    const frames = run(director)
    const childFrame = frames.find((item) => item.actor.id === child.id)!
    const supervisorFrame = frames.find((item) => item.actor.id === supervisor.id)!
    if (childFrame.speech === "report") {
      const childCell = cellAt(childFrame.position)
      const supervisorCell = cellAt(supervisorFrame.position)
      adjacentReport ||= Math.abs(childCell.x - supervisorCell.x) + Math.abs(childCell.y - supervisorCell.y) === 1
    }
  }
  expect(adjacentReport).toBe(true)
  expect(director.cueActive(child.id)).toBe(false)
  expect(layout.lounge.map((spot) => center(spot.cell))).toContainEqual(frame(director, child.id).position)
  expect(director.playCue({ id: "missing", kind: "report", fromActorID: "missing", toActorID: supervisor.id })).toBe(false)
  const unavailable = { ...child, source: "unavailable" as const }
  director.sync(snapshot([supervisor, unavailable]))
  const frozen = frame(director, child.id).position
  expect(director.playCue({ id: "unavailable", kind: "report", fromActorID: child.id, toActorID: supervisor.id })).toBe(false)
  expect(frame(director, child.id).position).toEqual(frozen)
})

test("unavailable actors freeze and sixteen work actors reserve unique walkable spots", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const unavailable = actor("unknown", { source: "unavailable", status: "unknown" })
  const actors = [unavailable, ...Array.from({ length: 16 }, (_, index) => actor(`dev-${index}`, { homeRoom: "developer" }))]
  director.sync(snapshot(actors))
  const frames = director.tick(0, false)
  expect(frames.find((item) => item.actor.id === unavailable.id)?.moving).toBe(false)
  const workers = frames.filter((item) => item.actor.id.startsWith("dev-"))
  expect(new Set(workers.map((item) => JSON.stringify(item.position))).size).toBe(16)
  expect(workers.every((item) => layout.walkable(cellAt(item.position).x, cellAt(item.position).y))).toBe(true)
})

test("ambient motion only affects idle lounge actors and appearance stays stable", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const idle = actor("ambient", { status: "idle" })
  const idlePeer = actor("ambient-peer", { status: "idle", homeRoom: "qa" })
  const working = actor("working")
  const unknown = actor("unknown", { status: "unknown" })
  director.sync(snapshot([idle, idlePeer, working, unknown]))
  const before = director.tick(0, false)
  const appearance = before.find((item) => item.actor.id === idle.id)?.appearance
  let chatted = false
  let wandered = false
  for (let index = 0; index < 2400; index++) {
    const frames = director.tick(50, false)
    chatted ||= frames.some((item) => item.speech === "chat")
    wandered ||= JSON.stringify(frames.find((item) => item.actor.id === idle.id)?.position) !== JSON.stringify(before.find((item) => item.actor.id === idle.id)?.position)
  }
  const after = director.tick(0, false)
  expect(wandered).toBe(true)
  expect(chatted).toBe(true)
  expect(after.find((item) => item.actor.id === idle.id)?.appearance).toBe(appearance)
  expect(after.find((item) => item.actor.id === working.id)?.position).toEqual(before.find((item) => item.actor.id === working.id)?.position)
  expect(after.find((item) => item.actor.id === unknown.id)?.position).toEqual(before.find((item) => item.actor.id === unknown.id)?.position)
})

test("sync is idempotent, actor order is irrelevant, and identical walking updates do not restart movement", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const one = actor("one")
  const two = actor("two", { homeRoom: "qa" })
  const initial = snapshot([one, two])
  director.sync(initial)
  const original = director.tick(0, false)
  for (let index = 0; index < 1_000; index++) director.sync(initial)
  expect(director.tick(0, false)).toEqual(original)
  director.sync(snapshot([two, one]))
  expect(director.tick(0, false)).toEqual(original)
  director.sync(snapshot([{ ...one, status: "idle" }, two]))
  for (let index = 0; index < 20; index++) {
    director.sync(snapshot([{ ...one, status: "idle" }, two]))
    run(director)
  }
  for (let index = 0; index < 500 && frame(director, one.id).moving; index++) run(director)
  expect(frame(director, one.id).room).toBe("lounge")
})

test("offline freezes a route and ready resumes it; scope loss drops everyone and one tick clamps to 50 ms", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const item = actor("moving")
  director.sync(snapshot([item]))
  director.sync(snapshot([{ ...item, status: "idle" }]))
  run(director)
  const frozen = frame(director, item.id).position
  director.sync(snapshot([{ ...item, status: "idle" }], { connection: "offline" }))
  for (let index = 0; index < 20; index++) run(director)
  expect(frame(director, item.id).position).toEqual(frozen)
  director.sync(snapshot([{ ...item, status: "idle" }]))
  for (let index = 0; index < 500 && frame(director, item.id).moving; index++) run(director)
  expect(frame(director, item.id).room).toBe("lounge")
  director.sync(snapshot([{ ...item, status: "working" }]))
  const before = frame(director, item.id).position
  const after = director.tick(100_000, false).find((current) => current.actor.id === item.id)!.position
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeCloseTo(layout.tileSize * 4.5 * 50 / 1000, 10)
  director.sync(snapshot([], { scope: "" }))
  expect(director.tick(0, false)).toEqual([])
})

test("retargeting mid-walk keeps every interpolated position walkable", () => {
  const layout = officeLayout()
  const director = new OfficeDirector(layout)
  const item = actor("retarget")
  director.sync(snapshot([item]))
  for (const status of ["idle", "working", "idle", "working"] as const) {
    director.sync(snapshot([{ ...item, status }]))
    for (let index = 0; index < 30; index++) {
      const current = run(director).find((entry) => entry.actor.id === item.id)!
      expect(layout.walkable(cellAt(current.position).x, cellAt(current.position).y)).toBe(true)
    }
  }
})

test("concurrent delegate cues share the supervisor briefing and reserve separate meeting spots", () => {
  const director = new OfficeDirector(officeLayout())
  const supervisor = actor("supervisor", { homeRoom: "developer" })
  const first = actor("first", { kind: "task" })
  const second = actor("second", { kind: "task", homeRoom: "research" })
  director.sync(snapshot([supervisor, first, second]))
  expect(director.playCue({ id: "first-brief", kind: "delegate", fromActorID: supervisor.id, toActorID: first.id })).toBe(true)
  let started = false
  for (let index = 0; index < 300 && !started; index++) started = run(director).some((item) => item.actor.id === supervisor.id && item.speech === "delegate")
  expect(started).toBe(true)
  expect(director.playCue({ id: "second-brief", kind: "delegate", fromActorID: supervisor.id, toActorID: second.id })).toBe(true)
  const chatting = new Set<string>()
  for (let index = 0; index < 600 && director.cueActive(supervisor.id); index++) {
    for (const item of run(director)) if (item.speech === "chat") chatting.add(item.actor.id)
  }
  expect(chatting.has(first.id)).toBe(true)
  expect(chatting.has(second.id)).toBe(true)
  expect(director.cueActive(supervisor.id)).toBe(false)
})

test("real-office far routes reach their talk phases and destinations within 45 simulated seconds", async () => {
  const { officeLayout } = await import("./map")
  const homes = ["developer", "research", "qa"] as const
  for (const homeRoom of homes) {
    const spots = officeLayout.work[homeRoom]
    const target = spots.reduce((farthest, spot, index) => {
      const distance = findPath(officeLayout, officeLayout.door, spot.cell)!.length
      return distance > farthest.distance ? { spot, index, distance } : farthest
    }, { spot: spots[0]!, index: 0, distance: -1 })
    const director = new OfficeDirector(officeLayout)
    const fillers = spots.slice(0, target.index).map((_, index) => actor(`${homeRoom}-filler-${index}`, { homeRoom }))
    const traveler = actor(`${homeRoom}-arrival`, { homeRoom })
    director.sync(snapshot(fillers))
    director.sync(snapshot([...fillers, traveler]))
    let elapsed = 0
    for (; elapsed < 45_000 && frame(director, traveler.id).moving; elapsed += 50) {
      const frames = run(director)
      expect(frames.every((item) => officeLayout.walkable(cellAt(item.position).x, cellAt(item.position).y))).toBe(true)
    }
    expect(elapsed).toBeLessThanOrEqual(45_000)
    expect(frame(director, traveler.id).position).toEqual(center(target.spot.cell))
  }

  for (const [homeRoom, childRoom] of [["developer", "qa"], ["qa", "developer"]] as const) {
    const director = new OfficeDirector(officeLayout)
    const supervisor = actor(`supervisor-${homeRoom}`, { homeRoom })
    const child = actor(`child-${childRoom}`, { homeRoom: childRoom })
    director.sync(snapshot([supervisor, child]))
    expect(director.playCue({ id: `delegate-${homeRoom}`, kind: "delegate", fromActorID: supervisor.id, toActorID: child.id })).toBe(true)
    let supervisorTalked = false
    let childTalked = false
    let elapsed = 0
    for (; elapsed < 45_000 && director.cueActive(supervisor.id); elapsed += 50) {
      const frames = run(director)
      expect(frames.every((item) => officeLayout.walkable(cellAt(item.position).x, cellAt(item.position).y))).toBe(true)
      supervisorTalked ||= frames.some((item) => item.actor.id === supervisor.id && item.speech === "delegate")
      childTalked ||= frames.some((item) => item.actor.id === child.id && item.speech === "chat")
    }
    expect(supervisorTalked).toBe(true)
    expect(childTalked).toBe(true)
    expect(elapsed).toBeLessThanOrEqual(45_000)
    expect(frame(director, supervisor.id).position).toEqual(center(officeLayout.work[homeRoom][0]!.cell))
    expect(frame(director, child.id).position).toEqual(center(officeLayout.work[childRoom][0]!.cell))
  }

  const director = new OfficeDirector(officeLayout)
  const child = actor("research-report", { homeRoom: "research" })
  const supervisor = actor("developer-report", { homeRoom: "developer" })
  director.sync(snapshot([child, supervisor]))
  expect(director.playCue({ id: "research-report", kind: "report", fromActorID: child.id, toActorID: supervisor.id })).toBe(true)
  let reported = false
  let elapsed = 0
  for (; elapsed < 45_000 && director.cueActive(child.id); elapsed += 50) {
    const frames = run(director)
    expect(frames.every((item) => officeLayout.walkable(cellAt(item.position).x, cellAt(item.position).y))).toBe(true)
    reported ||= frames.some((item) => item.actor.id === child.id && item.speech === "report")
  }
  expect(reported).toBe(true)
  expect(elapsed).toBeLessThanOrEqual(45_000)
  expect(frame(director, child.id).position).toEqual(center(officeLayout.work.research[0]!.cell))
  expect(frame(director, supervisor.id).position).toEqual(center(officeLayout.work.developer[0]!.cell))
})
