import { expect, test } from "bun:test"
import { OfficeDirector } from "./director"
import { findPath } from "./navigation"
import { officeLayout, pods, props, roomAt } from "./map"
import { actor, snapshot } from "./layout.test-helper"

const cell = (position: { x: number; y: number }) => ({ x: Math.floor(position.x / 32), y: Math.floor(position.y / 32) })
const inside = (index: number, position: { x: number; y: number }) => {
  const pod = pods[index]!
  return position.x >= pod.left && position.x <= pod.right && position.y >= pod.top && position.y <= pod.bottom
}

test("opposite traffic on the central corridor passes without overlapping or entering another claim", () => {
  const layout = { ...officeLayout, lounge: [
    { cell: { x: 25, y: 17 }, facing: "left" as const, pose: "play" as const, leisure: "table" as const },
    { cell: { x: 24, y: 17 }, facing: "right" as const, pose: "play" as const, leisure: "table" as const },
  ] }
  const director = new OfficeDirector(layout)
  const workers = Array.from({ length: 14 }, (_, index) => index === 0 || index === 13 ? actor(index === 0 ? "a" : "b", { status: "idle" }) : actor(`stationary-${index}`, { source: "unavailable" }))
  director.sync(snapshot(workers))
  director.sync(snapshot(workers.map((worker) => ({ ...worker, status: "working" as const, activity: "research" as const }))))
  for (let tick = 0; tick < 500; tick++) {
    const frames = director.tick(50, false).filter((frame) => frame.actor.source === "projection")
    expect(new Set(frames.map((frame) => JSON.stringify(cell(frame.position)))).size, `tick ${tick}`).toBe(2)
    expect(Math.hypot(frames[0]!.position.x - frames[1]!.position.x, frames[0]!.position.y - frames[1]!.position.y), `tick ${tick}`).toBeGreaterThanOrEqual(32)
    for (const [index, frame] of frames.entries()) {
      const position = cell(frame.position)
      const owner = pods.findIndex((pod) => position.x >= pod.left && position.x <= pod.right && position.y >= pod.top && position.y <= pod.bottom)
      expect(owner === -1 || owner === (index === 0 ? 0 : 13)).toBe(true)
    }
  }
  expect(director.tick(0, false).filter((frame) => frame.actor.source === "projection").map((frame) => cell(frame.position))).toEqual([pods[0]!.spots.research.cell, pods[13]!.spots.research.cell])
})

test("sixteen concurrent central-corridor movers reach work within thirty seconds at 20 and 30 FPS", () => {
  for (const fps of [20, 30]) {
    const layout = { ...officeLayout, lounge: Array.from({ length: 16 }, (_, index) => ({
      cell: { x: 10 + index, y: 17 }, facing: "up" as const, pose: "play" as const, leisure: "table" as const,
    })) }
    const director = new OfficeDirector(layout)
    const workers = Array.from({ length: 16 }, (_, index) => actor(`traffic-${index.toString().padStart(2, "0")}`, { status: "idle" }))
    director.sync(snapshot(workers))
    director.sync(snapshot(workers.map((worker) => ({ ...worker, status: "working" as const, activity: "research" as const }))))
    const waits = Array.from({ length: 16 }, () => 0)
    for (let tick = 0; tick < fps * 30; tick++) {
      const frames = director.tick(1_000 / fps, false)
      expect(new Set(frames.map((frame) => JSON.stringify(cell(frame.position)))).size, `${fps} FPS tick ${tick}`).toBe(16)
      for (const [index, frame] of frames.entries()) {
        const point = cell(frame.position)
        waits[index] = !frame.moving && JSON.stringify(point) !== JSON.stringify(pods[index]!.spots.research.cell) ? waits[index]! + 1 : 0
        expect(waits[index], `${fps} FPS actor ${index} yield`).toBeLessThanOrEqual(fps * 2)
        const owner = pods.findIndex((pod) => point.x >= pod.left && point.x <= pod.right && point.y >= pod.top && point.y <= pod.bottom)
        expect(owner === -1 || owner === index, `${fps} FPS tick ${tick}, actor ${index}`).toBe(true)
        for (const peer of frames.slice(index + 1)) expect(Math.hypot(frame.position.x - peer.position.x, frame.position.y - peer.position.y), `${fps} FPS tick ${tick}`).toBeGreaterThanOrEqual(32 - 0.001)
      }
    }
    expect(director.tick(0, false).map((frame) => cell(frame.position)), `${fps} FPS`).toEqual(pods.map((pod) => pod.spots.research.cell))
    expect(director.tick(0, false).every((frame) => !frame.moving)).toBe(true)
  }
})

test("opposite work traffic in the widened corridor between claims five and six makes bounded progress", () => {
  const layout = { ...officeLayout, lounge: [
    { cell: { x: 9, y: 13 }, facing: "up" as const, pose: "play" as const, leisure: "table" as const },
    { cell: { x: 9, y: 12 }, facing: "down" as const, pose: "play" as const, leisure: "table" as const },
  ] }
  const director = new OfficeDirector(layout)
  const workers = Array.from({ length: 14 }, (_, index) => index === 0 || index === 13 ? actor(index === 0 ? "a" : "b", { status: "idle" }) : actor(`stationary-${index}`, { source: "unavailable" }))
  director.sync(snapshot(workers))
  director.sync(snapshot(workers.map((worker) => ({ ...worker, status: "working" as const, activity: "research" as const }))))
  for (let tick = 0; tick < 600; tick++) {
    const frames = director.tick(50, false).filter((frame) => frame.actor.source === "projection")
    expect(Math.hypot(frames[0]!.position.x - frames[1]!.position.x, frames[0]!.position.y - frames[1]!.position.y), `tick ${tick}`).toBeGreaterThanOrEqual(32)
  }
  expect(director.tick(0, false).filter((frame) => frame.actor.source === "projection").map((frame) => cell(frame.position))).toEqual([pods[0]!.spots.research.cell, pods[13]!.spots.research.cell])
})

test("sixteen movers use the widened corridor without overlap, starvation, or other-claim crossing", () => {
  for (const fps of [20, 30]) {
    const layout = { ...officeLayout, lounge: Array.from({ length: 16 }, (_, index) => ({
      cell: { x: 9 + index % 2, y: 8 + Math.floor(index / 2) }, facing: "up" as const, pose: "play" as const, leisure: "table" as const,
    })) }
    const director = new OfficeDirector(layout)
    const workers = Array.from({ length: 16 }, (_, index) => actor(`wide-${index.toString().padStart(2, "0")}`, { status: "idle" }))
    director.sync(snapshot(workers))
    director.sync(snapshot(workers.map((worker) => ({ ...worker, status: "working" as const, activity: "research" as const }))))
    const waits = Array.from({ length: 16 }, () => 0)
    for (let tick = 0; tick < fps * 30; tick++) {
      const frames = director.tick(1_000 / fps, false)
      for (const [index, frame] of frames.entries()) {
        const point = cell(frame.position)
        waits[index] = !frame.moving && JSON.stringify(point) !== JSON.stringify(pods[index]!.spots.research.cell) ? waits[index]! + 1 : 0
        expect(waits[index], `${fps} FPS actor ${index} yield`).toBeLessThanOrEqual(fps * 4)
        const owner = pods.findIndex((pod) => point.x >= pod.left && point.x <= pod.right && point.y >= pod.top && point.y <= pod.bottom)
        expect(owner === -1 || owner === index).toBe(true)
        for (const peer of frames.slice(index + 1)) expect(Math.hypot(frame.position.x - peer.position.x, frame.position.y - peer.position.y), `${fps} FPS tick ${tick}`).toBeGreaterThanOrEqual(32 - 0.001)
      }
    }
    expect(director.tick(0, false).map((frame) => cell(frame.position)), `${fps} FPS`).toEqual(pods.map((pod) => pod.spots.research.cell))
  }
})

test("sixteen disjoint claims own reachable spots joined by routes that stay in the claim", () => {
  expect(pods).toHaveLength(16)
  const occupied = new Set<string>()
  for (const [index, pod] of pods.entries()) {
    for (const spot of Object.values(pod.spots)) {
      expect(inside(index, spot.cell)).toBe(true)
      expect(findPath(officeLayout, officeLayout.door, spot.cell)).toBeDefined()
      expect(roomAt(spot.cell)).toBe("block")
      expect(occupied.has(`${spot.cell.x},${spot.cell.y}`)).toBe(false)
      occupied.add(`${spot.cell.x},${spot.cell.y}`)
    }
    for (const from of Object.values(pod.spots)) for (const to of Object.values(pod.spots)) {
      const path = findPath(officeLayout, from.cell, to.cell)!
      expect(path.length).toBeLessThanOrEqual(12)
      expect(path.every((point) => inside(index, point))).toBe(true)
    }
    expect(props.filter((prop) => prop.pod === index && prop.blocks).length).toBeGreaterThanOrEqual(4)
  }
})

test("short actions and mid-walk changes immediately target only the actor's claim", () => {
  const director = new OfficeDirector(officeLayout)
  const worker = actor("worker", { activity: "implement" })
  director.sync(snapshot([worker]))
  director.sync(snapshot([{ ...worker, activity: "research" }]))
  director.tick(50, false)
  director.sync(snapshot([{ ...worker, activity: "implement" }]))
  for (let i = 0; i < 6; i++) expect(inside(0, cell(director.tick(50, false)[0]!.position))).toBe(true)
  director.sync(snapshot([{ ...worker, activity: "verify" }]))
  director.tick(50, false)
  director.sync(snapshot([{ ...worker, activity: "coordinate" }]))
  for (let i = 0; i < 100; i++) expect(inside(0, cell(director.tick(50, false)[0]!.position))).toBe(true)
  expect(cell(director.tick(0, false)[0]!.position)).toEqual(pods[0]!.spots.coordinate.cell)
})

test("concurrent workers own different targets and never cross another claim", () => {
  const director = new OfficeDirector(officeLayout)
  const workers = Array.from({ length: 16 }, (_, index) => actor(`worker-${index}`, { activity: "implement" }))
  director.sync(snapshot(workers))
  for (const activity of ["research", "verify", "coordinate", "implement"] as const) {
    director.sync(snapshot(workers.map((worker) => ({ ...worker, activity }))))
    for (let tick = 0; tick < 100; tick++) {
      const frames = director.tick(50, false)
      expect(new Set(frames.map((frame) => JSON.stringify(cell(frame.position)))).size).toBe(frames.length)
      for (const [index, frame] of frames.entries()) expect(inside(index, cell(frame.position))).toBe(true)
    }
  }
})

test("idle workers walk from their claim to distinct shared resting spots without entering another claim", () => {
  const director = new OfficeDirector(officeLayout)
  const workers = Array.from({ length: 16 }, (_, index) => actor(`rest-${index}`, { activity: "implement" }))
  director.sync(snapshot(workers))
  director.sync(snapshot(workers.map((worker) => ({ ...worker, status: "idle" as const, activity: undefined }))))
  for (let tick = 0; tick < 800; tick++) {
    const frames = director.tick(50, false)
    for (const [index, frame] of frames.entries()) {
      const position = cell(frame.position)
      const owner = pods.findIndex((pod) => position.x >= pod.left && position.x <= pod.right && position.y >= pod.top && position.y <= pod.bottom)
      expect(owner === -1 || owner === index).toBe(true)
    }
  }
  const final = director.tick(0, false).map((frame) => JSON.stringify(cell(frame.position)))
  expect(new Set(final).size).toBe(16)
  const finalFrames = director.tick(0, false)
  expect(finalFrames.every((frame) => !frame.leaving)).toBe(true)
  expect(finalFrames.some((frame) => officeLayout.roomAt(cell(frame.position)) === "lounge")).toBe(true)
})
