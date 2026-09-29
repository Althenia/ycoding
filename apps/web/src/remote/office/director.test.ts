import { expect, test } from "bun:test"
import { OfficeDirector } from "./director"
import { officeLayout, pods } from "./map"
import { actor, snapshot } from "./layout.test-helper"

const cell = (position: { x: number; y: number }) => ({ x: Math.floor(position.x / 32), y: Math.floor(position.y / 32) })
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
  const peers = [actor("peer-a", { status: "idle" }), actor("peer-b", { status: "idle" })]
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
