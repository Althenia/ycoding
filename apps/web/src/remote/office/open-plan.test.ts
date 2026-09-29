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
  expect(director.tick(0, false).every((frame) => officeLayout.roomAt(cell(frame.position)) === "lounge")).toBe(true)
})
