import { expect, test } from "bun:test"
import { findPath } from "./navigation"
import { officeLayout, pods, props, wallAt, worldHeight, worldWidth } from "./map"

test("the open floor fits the bounded world with a perimeter entrance and clear circulation", () => {
  expect({ columns: officeLayout.columns, rows: officeLayout.rows, tileSize: officeLayout.tileSize }).toEqual({ columns: 64, rows: 40, tileSize: 32 })
  expect({ worldWidth, worldHeight }).toEqual({ worldWidth: 2048, worldHeight: 1280 })
  expect(officeLayout.walkable(officeLayout.door.x, officeLayout.door.y)).toBe(true)
  expect(wallAt(officeLayout.door.x - 1, officeLayout.door.y)).toBe(true)
  expect(wallAt(officeLayout.door.x + 2, officeLayout.door.y)).toBe(true)
  for (const pod of pods) for (const spot of Object.values(pod.spots)) {
    const privateRoute = findPath(officeLayout, officeLayout.door, spot.cell, (point) => !pods.some((other) => other !== pod && point.x >= other.left && point.x <= other.right && point.y >= other.top && point.y <= other.bottom))
    expect(privateRoute).toBeDefined()
    expect(privateRoute!.every((point) => !pods.some((other) => other !== pod && point.x >= other.left && point.x <= other.right && point.y >= other.top && point.y <= other.bottom))).toBe(true)
  }
  for (const spot of officeLayout.lounge) {
    expect(officeLayout.walkable(spot.cell.x, spot.cell.y)).toBe(true)
    expect(findPath(officeLayout, officeLayout.door, spot.cell)).toBeDefined()
  }
})

test("each block owns non-overlapping task furniture and interaction cells", () => {
  const occupied = new Set<string>()
  for (const [index, pod] of pods.entries()) {
    expect(new Set(props.filter((item) => item.pod === index).map((item) => item.kind))).toEqual(new Set(["developerDesk", "bookshelf", "qaDesk", "whiteboard"]))
    for (const spot of Object.values(pod.spots)) {
      expect(officeLayout.walkable(spot.cell.x, spot.cell.y)).toBe(true)
      expect(spot.cell.x).toBeGreaterThanOrEqual(pod.left)
      expect(spot.cell.x).toBeLessThanOrEqual(pod.right)
      expect(spot.cell.y).toBeGreaterThanOrEqual(pod.top)
      expect(spot.cell.y).toBeLessThanOrEqual(pod.bottom)
    }
  }
  for (const prop of props.filter((item) => item.blocks)) for (let y = prop.cell.y; y < prop.cell.y + prop.height; y++) for (let x = prop.cell.x; x < prop.cell.x + prop.width; x++) {
    const key = `${x},${y}`
    expect(occupied.has(key), `${prop.kind} ${key}`).toBe(false)
    occupied.add(key)
    expect(officeLayout.walkable(x, y)).toBe(false)
  }
})
