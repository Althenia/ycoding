import { expect, test } from "bun:test"
import { OfficeDirector } from "./director"
import { findPath } from "./navigation"
import { officeLayout, pods, props, wallAt } from "./map"
import { actor, snapshot } from "./layout.test-helper"

const cell = (position: { x: number; y: number }) => ({ x: Math.floor(position.x / 32), y: Math.floor(position.y / 32) })
const inside = (index: number, position: { x: number; y: number }) => {
  const pod = pods[index]!
  return position.x >= pod.left && position.x <= pod.right && position.y >= pod.top && position.y <= pod.bottom
}

test("one open floor contains sixteen disjoint, fully furnished and reachable blocks", () => {
  expect(pods).toHaveLength(16)
  expect(officeLayout.door.y).toBe(officeLayout.rows - 1)
  for (let y = 1; y < officeLayout.rows - 1; y++) for (let x = 1; x < officeLayout.columns - 1; x++) expect(wallAt(x, y)).toBe(false)
  const occupied = new Set<string>()
  for (const [index, pod] of pods.entries()) {
    expect(new Set(props.filter((prop) => prop.pod === index).map((prop) => prop.kind))).toEqual(new Set(["developerDesk", "bookshelf", "qaDesk", "whiteboard"]))
    for (const spot of Object.values(pod.spots)) {
      expect(inside(index, spot.cell)).toBe(true)
      expect(officeLayout.walkable(spot.cell.x, spot.cell.y)).toBe(true)
      expect(findPath(officeLayout, officeLayout.door, spot.cell)).toBeDefined()
      expect(officeLayout.roomAt(spot.cell)).toBe("block")
      expect(occupied.has(`${spot.cell.x},${spot.cell.y}`)).toBe(false)
      occupied.add(`${spot.cell.x},${spot.cell.y}`)
    }
    for (const from of Object.values(pod.spots)) for (const to of Object.values(pod.spots)) {
      const path = findPath(officeLayout, from.cell, to.cell)!
      expect(path.length).toBeLessThanOrEqual(12)
      expect(path.every((point) => inside(index, point))).toBe(true)
    }
  }
  const footprints = new Set<string>()
  for (const prop of props.filter((item) => item.blocks)) for (let y = prop.cell.y; y < prop.cell.y + prop.height; y++) for (let x = prop.cell.x; x < prop.cell.x + prop.width; x++) {
    const key = `${x},${y}`
    expect(footprints.has(key)).toBe(false)
    footprints.add(key)
  }
})

test("short actions and mid-walk changes immediately target only the actor's block", () => {
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

test("concurrent workers own different targets and never cross another block", () => {
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
