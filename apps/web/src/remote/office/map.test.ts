import { expect, test } from "bun:test"
import { findPath } from "./navigation"
import { columns, floorFrameAt, officeLayout, pods, props, roomAt, rows, tileSize, wallAt, worldHeight, worldWidth } from "./map"
import type { OfficeProp } from "./map"

const inside = (pod: (typeof pods)[number], x: number, y: number) => x >= pod.left && x <= pod.right && y >= pod.top && y <= pod.bottom
const inAnyPod = (x: number, y: number) => pods.some((pod) => inside(pod, x, y))
const cellsOf = (prop: OfficeProp) => Array.from({ length: prop.height }, (_, dy) => Array.from({ length: prop.width }, (_, dx) => ({ x: prop.cell.x + dx, y: prop.cell.y + dy }))).flat()

function reachableWithoutPods() {
  const seen = new Set<string>([`${officeLayout.door.x},${officeLayout.door.y}`])
  const queue = [officeLayout.door]
  for (let head = 0; head < queue.length; head++) {
    const point = queue[head]!
    for (const next of [{ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y }, { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 }]) {
      if (!officeLayout.walkable(next.x, next.y) || inAnyPod(next.x, next.y) || seen.has(`${next.x},${next.y}`)) continue
      seen.add(`${next.x},${next.y}`)
      queue.push(next)
    }
  }
  return seen
}

test("the compact world has a walled perimeter and one centred two-tile entrance", () => {
  expect({ columns, rows, tileSize, worldWidth, worldHeight }).toEqual({ columns: 48, rows: 38, tileSize: 32, worldWidth: 1536, worldHeight: 1216 })
  expect(worldWidth / worldHeight).toBeLessThanOrEqual(4 / 3)
  expect(officeLayout).toMatchObject({ columns: 48, rows: 38, tileSize: 32, door: { x: 23, y: 37 } })
  for (let x = 0; x < columns; x++) for (let y = 0; y < rows; y++) {
    const edge = x === 0 || y === 0 || x === columns - 1 || y === rows - 1
    const door = y === rows - 1 && (x === 23 || x === 24)
    expect(wallAt(x, y), `${x},${y}`).toBe(edge && !door)
  }
  expect(officeLayout.walkable(23, 37)).toBe(true)
  expect(officeLayout.walkable(24, 37)).toBe(true)
})

test("sixteen claims are disjoint, interior, and own every task spot within twelve steps", () => {
  expect(pods).toHaveLength(16)
  const seats = new Set<string>()
  for (const [index, pod] of pods.entries()) {
    expect(pod.left).toBeGreaterThanOrEqual(1)
    expect(pod.top).toBeGreaterThanOrEqual(2)
    expect(pod.right).toBeLessThanOrEqual(columns - 2)
    expect(pod.bottom).toBeLessThanOrEqual(rows - 2)
    for (const other of pods.slice(index + 1)) {
      expect(pod.right < other.left || other.right < pod.left || pod.bottom < other.top || other.bottom < pod.top, `${index} overlaps`).toBe(true)
    }
    for (const spot of Object.values(pod.spots)) {
      expect(inside(pod, spot.cell.x, spot.cell.y)).toBe(true)
      expect(officeLayout.walkable(spot.cell.x, spot.cell.y)).toBe(true)
      expect(seats.has(`${spot.cell.x},${spot.cell.y}`)).toBe(false)
      seats.add(`${spot.cell.x},${spot.cell.y}`)
      expect(officeLayout.roomAt(spot.cell)).toBe("block")
    }
    for (const from of Object.values(pod.spots)) for (const to of Object.values(pod.spots)) {
      const path = findPath(officeLayout, from.cell, to.cell, (point) => inside(pod, point.x, point.y))
      expect(path, `pod ${index}`).toBeDefined()
      expect(path!.length).toBeLessThanOrEqual(12)
    }
  }
})

test("every spot is reachable from the entrance without entering another claim", () => {
  for (const [index, pod] of pods.entries()) for (const spot of Object.values(pod.spots)) {
    const route = findPath(officeLayout, officeLayout.door, spot.cell, (point) => !pods.some((other, otherIndex) => otherIndex !== index && inside(other, point.x, point.y)))
    expect(route, `pod ${index}`).toBeDefined()
    expect(route!.every((point) => !pods.some((other, otherIndex) => otherIndex !== index && inside(other, point.x, point.y)))).toBe(true)
  }
})

test("all shared floor is reachable from the entrance without crossing any claim", () => {
  const reachable = reachableWithoutPods()
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < columns - 1; x++) {
    if (!officeLayout.walkable(x, y) || inAnyPod(x, y)) continue
    expect(reachable.has(`${x},${y}`), `sealed ${x},${y}`).toBe(true)
  }
  expect(officeLayout.lounge.length).toBeGreaterThanOrEqual(16)
  const restingCells = new Set<string>()
  for (const spot of officeLayout.lounge) {
    expect(officeLayout.walkable(spot.cell.x, spot.cell.y)).toBe(true)
    expect(inAnyPod(spot.cell.x, spot.cell.y)).toBe(false)
    expect(reachable.has(`${spot.cell.x},${spot.cell.y}`)).toBe(true)
    expect(roomAt(spot.cell)).toBe("lounge")
    restingCells.add(`${spot.cell.x},${spot.cell.y}`)
  }
  expect(restingCells.size).toBe(officeLayout.lounge.length)
})

test("props keep to their owner, never overlap, and never stand on a task or resting spot", () => {
  const blocked = new Map<string, string>()
  const spotKeys = new Set([...pods.flatMap((pod) => Object.values(pod.spots)), ...officeLayout.lounge].map((spot) => `${spot.cell.x},${spot.cell.y}`))
  for (const prop of props) {
    for (const cell of cellsOf(prop)) {
      expect(cell.x >= 1 && cell.y >= 0 && cell.x <= columns - 2 && cell.y <= rows - 2, `${prop.kind} ${cell.x},${cell.y}`).toBe(true)
      if (prop.pod !== undefined) expect(inside(pods[prop.pod]!, cell.x, cell.y), `${prop.kind} leaves pod ${prop.pod}`).toBe(true)
      if (prop.pod === undefined && prop.layer === "object" && prop.blocks) expect(inAnyPod(cell.x, cell.y), `${prop.kind} enters a claim`).toBe(false)
      if (!prop.blocks) continue
      const key = `${cell.x},${cell.y}`
      expect(blocked.has(key), `${prop.kind} overlaps ${blocked.get(key)} at ${key}`).toBe(false)
      blocked.set(key, prop.kind)
      expect(spotKeys.has(key), `${prop.kind} covers a spot at ${key}`).toBe(false)
      expect(officeLayout.walkable(cell.x, cell.y)).toBe(false)
    }
  }
})

test("workstations are grouped and personal, not a lattice of identical blocks", () => {
  const templates = pods.map((pod) => pod.template)
  expect(new Set(templates).size).toBe(5)
  for (const template of new Set(templates)) expect(templates.filter((item) => item === template).length, template).toBeGreaterThanOrEqual(2)
  expect(new Set(pods.map((pod) => `${pod.right - pod.left + 1}x${pod.bottom - pod.top + 1}`)).size).toBeGreaterThanOrEqual(4)
  expect(new Set(pods.map((pod) => pod.top)).size).toBeGreaterThanOrEqual(5)
  expect(new Set(pods.map((pod) => pod.left)).size).toBeGreaterThanOrEqual(8)
  const signatures = pods.map((pod, index) => props.filter((prop) => prop.pod === index)
    .map((prop) => `${prop.kind}@${prop.cell.x - pod.left},${prop.cell.y - pod.top}`).sort().join("|"))
  expect(new Set(signatures).size).toBe(16)
  const rugs = props.filter((prop) => prop.pod !== undefined && prop.layer === "floor")
  expect(rugs.length).toBeGreaterThanOrEqual(6)
  expect(rugs.length).toBeLessThan(16)
  expect(new Set(rugs.map((prop) => prop.kind)).size).toBeGreaterThanOrEqual(3)
  for (const kind of ["developerDesk", "compactDeskCode", "cornerDesk", "researchDesk"] as const) {
    expect(props.some((prop) => prop.pod !== undefined && prop.kind === kind), kind).toBe(true)
  }
})

test("each claim has a seat desk, a research surface, a verify station, and a board", () => {
  const seatDesks = new Set(["developerDesk", "developerDeskLamp", "developerDeskPlant", "researchDesk", "compactDeskCode", "compactDeskChart", "cornerDesk"])
  const verifyDesks = new Set(["qaDesk", "qaDeskMug", "compactDeskTest", "deviceRack"])
  const shelves = new Set(["bookshelf", "credenza"])
  for (const [index, pod] of pods.entries()) {
    const own = props.filter((prop) => prop.pod === index)
    expect(own.some((prop) => seatDesks.has(prop.kind)), `seat ${index}`).toBe(true)
    expect(own.some((prop) => verifyDesks.has(prop.kind)), `verify ${index}`).toBe(true)
    expect(own.some((prop) => shelves.has(prop.kind)), `shelf ${index}`).toBe(true)
    expect(own.some((prop) => (prop.kind === "whiteboard" || prop.kind === "bugBoard") && !prop.blocks), `board ${index}`).toBe(true)
    const board = own.find((prop) => prop.kind === "whiteboard" || prop.kind === "bugBoard")!
    expect(pod.spots.coordinate.cell.y).toBe(board.cell.y - 1)
    expect(pod.spots.coordinate.facing).toBe("down")
    expect(pod.spots.implement.facing).toBe("up")
  }
})

test("meeting, lounge, pantry, and foyer are furnished shared rooms outside every claim", () => {
  const kinds = (predicate: (prop: OfficeProp) => boolean) => new Set(props.filter((prop) => prop.pod === undefined && predicate(prop)).map((prop) => prop.kind))
  const region = (x0: number, y0: number, x1: number, y1: number) => (prop: OfficeProp) => prop.cell.x >= x0 && prop.cell.x <= x1 && prop.cell.y >= y0 && prop.cell.y <= y1
  const meeting = kinds(region(26, 17, 37, 26))
  expect(meeting.has("conferenceTable") && meeting.has("wallTv") && meeting.has("whiteboard")).toBe(true)
  const lounge = kinds(region(10, 18, 22, 32))
  for (const kind of ["sofaPeach", "sofaOrange", "coffeeTable", "beanBag", "beanBagBlue", "beanBagPink", "pingPong", "readingSeat", "bookshelf", "floorLamp"] as const) expect(lounge.has(kind), kind).toBe(true)
  const pantry = kinds(region(26, 29, 37, 36))
  for (const kind of ["kitchenCounter", "fridge", "coffeeMachine", "waterDispenser", "bistroTable"] as const) expect(pantry.has(kind), kind).toBe(true)
  const foyer = kinds(region(10, 33, 25, 36))
  expect(foyer.has("receptionDesk")).toBe(true)
  const loungeCells = Array.from({ length: 15 }, (_, dy) => Array.from({ length: 13 }, (_, dx) => ({ x: 10 + dx, y: 18 + dy }))).flat().filter((cell) => officeLayout.walkable(cell.x, cell.y))
  expect(loungeCells.length).toBeGreaterThanOrEqual(110)
})

test("shared leisure spots reuse seats and pantry standing positions face the existing coffee machine", () => {
  const seated = officeLayout.lounge.filter((spot) => spot.pose === "sit")
  expect(seated.length).toBeGreaterThanOrEqual(4)
  expect(seated.every((spot) => officeLayout.walkable(spot.cell.x, spot.cell.y))).toBe(true)
  const coffee = props.find((prop) => prop.kind === "coffeeMachine")!
  const coffeeApproach = officeLayout.lounge.find((spot) => spot.cell.x === coffee.cell.x && spot.cell.y === coffee.cell.y + 1)
  expect(coffeeApproach).toMatchObject({ facing: "up", pose: "stand" })
})

test("meeting-edge gathering spots are distinct, walkable, and face inward beside the existing table", () => {
  expect(officeLayout.gathering).toHaveLength(3)
  expect(new Set(officeLayout.gathering.map((spot) => `${spot.cell.x},${spot.cell.y}`)).size).toBe(3)
  expect(officeLayout.gathering.every((spot) => officeLayout.walkable(spot.cell.x, spot.cell.y) && spot.pose === "stand" && spot.facing === "down")).toBe(true)
  expect(officeLayout.gathering.every((spot) => spot.cell.y === 21 && spot.cell.x >= 28 && spot.cell.x <= 34)).toBe(true)
})

test("floors zone each neighbourhood and room with authored tile frames", () => {
  const frames = new Set<number>()
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < columns - 1; x++) frames.add(floorFrameAt(x, y))
  expect([...frames].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  expect(floorFrameAt(12, 22)).toBe(5)
  expect(floorFrameAt(31, 21)).toBe(4)
  expect(floorFrameAt(32, 32)).toBe(8)
  expect(floorFrameAt(24, 35)).toBe(7)
  expect(floorFrameAt(17, 5)).toBe(0)
  expect(floorFrameAt(5, 4)).not.toBe(floorFrameAt(22, 4))
})
