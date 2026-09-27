import { expect, test } from "bun:test"
import { findPath } from "./navigation"
import { floorFrameAt, officeLayout, props, rooms, wallAt } from "./map"
import type { OfficeHomeRoom, OfficeRoomID, OfficeSpot } from "./types"

const identities: readonly Exclude<OfficeRoomID, "hall">[] = ["ceo", "developer", "research", "qa", "meeting", "lounge"]

test("the original office fits the bounded 32px world and gives each room a distinct floor and door", () => {
  expect(officeLayout.tileSize).toBe(32)
  expect(officeLayout.columns).toBeLessThanOrEqual(56)
  expect(officeLayout.rows).toBeLessThanOrEqual(40)
  expect(officeLayout.columns).toBe(56)
  expect(officeLayout.rows).toBe(40)
  expect(new Set(rooms.map((room) => room.id))).toEqual(new Set(identities))
  expect(new Set(rooms.map((room) => floorFrameAt(room.center.x, room.center.y))).size).toBe(identities.length)
  expect(officeLayout.walkable(officeLayout.door.x, officeLayout.door.y)).toBe(true)
  expect(officeLayout.door.y).toBe(officeLayout.rows - 1)
  for (const cell of [{ x: -1, y: 1 }, { x: 1, y: -1 }, { x: officeLayout.columns, y: 1 }, { x: 1, y: officeLayout.rows }]) {
    expect(officeLayout.walkable(cell.x, cell.y)).toBe(false)
  }
  expect(wallAt(officeLayout.door.x - 1, officeLayout.door.y)).toBe(true)
  expect(wallAt(officeLayout.door.x + 2, officeLayout.door.y)).toBe(true)
  for (const room of rooms) {
    expect(room.title.length).toBeGreaterThan(0)
    expect(officeLayout.roomAt(room.center)).toBe(room.id)
    expect(room.doors.length).toBeGreaterThan(0)
    for (const door of room.doors) {
      expect(officeLayout.walkable(door.x, door.y)).toBe(true)
      expect(findPath(officeLayout, officeLayout.door, door)).toBeDefined()
    }
  }
})

test("every work, meeting, and lounge spot is distinct, walkable, correctly zoned, and reachable", () => {
  const categories: readonly { readonly room: OfficeRoomID; readonly spots: readonly OfficeSpot[]; readonly seated: number }[] = [
    ...(["ceo", "developer", "research", "qa"] as const).map((room: OfficeHomeRoom) => ({
      room, spots: officeLayout.work[room], seated: { ceo: 4, developer: 12, research: 6, qa: 6 }[room],
    })),
    { room: "meeting", spots: officeLayout.meeting, seated: 8 },
    { room: "lounge", spots: officeLayout.lounge, seated: 8 },
  ]
  for (const category of categories) {
    expect(category.spots.length).toBeGreaterThanOrEqual(16)
    expect(category.spots.filter((spot) => spot.pose === "sit").length).toBeGreaterThanOrEqual(category.seated)
    expect(new Set(category.spots.map((spot) => `${spot.cell.x},${spot.cell.y}`)).size).toBe(category.spots.length)
    for (const spot of category.spots) {
      expect(officeLayout.roomAt(spot.cell)).toBe(category.room)
      expect(officeLayout.walkable(spot.cell.x, spot.cell.y)).toBe(true)
      const path = findPath(officeLayout, officeLayout.door, spot.cell)
      expect(path).toBeDefined()
      const cells = [officeLayout.door, ...path!]
      for (let index = 1; index < cells.length; index++) {
        expect(officeLayout.walkable(cells[index]!.x, cells[index]!.y)).toBe(true)
        expect(Math.abs(cells[index]!.x - cells[index - 1]!.x) + Math.abs(cells[index]!.y - cells[index - 1]!.y)).toBe(1)
      }
      const returnPath = findPath(officeLayout, spot.cell, officeLayout.door)
      expect(returnPath).toBeDefined()
      const returnCells = [spot.cell, ...returnPath!]
      for (let index = 1; index < returnCells.length; index++) {
        expect(Math.abs(returnCells[index]!.x - returnCells[index - 1]!.x) + Math.abs(returnCells[index]!.y - returnCells[index - 1]!.y)).toBe(1)
      }
    }
  }
})

test("furnished footprints block travel while room-specific props remain inside their rooms", () => {
  const required = {
    ceo: ["executiveDesk", "bookshelf", "aquarium", "sofa", "coffeeTable", "plantMonstera"],
    developer: ["developerDesk", "serverRack", "whiteboard", "plantFern"],
    research: ["researchDesk", "bookshelf", "readingSeat", "whiteboard", "globe"],
    qa: ["qaDesk", "deviceRack", "bugBoard"],
    meeting: ["conferenceTable", "wallTv", "whiteboard", "waterDispenser", "plantMonstera"],
    lounge: ["sofaPeach", "sofaOrange", "beanBag", "beanBagBlue", "beanBagPink", "coffeeTable", "pingPong", "kitchenCounter", "fridge", "waterDispenser", "wallTv"],
  } as const
  for (const room of rooms) {
    const kinds = new Set(props.filter((prop) => prop.room === room.id).map((prop) => prop.kind))
    for (const kind of required[room.id]) expect(kinds.has(kind)).toBe(true)
  }
  expect(new Set(props.filter((item) => item.kind.startsWith("plant")).map((item) => item.kind)).size).toBe(5)
  for (const prop of props) {
    const room = rooms.find((item) => item.id === prop.room)
    expect(prop.cell.x).toBeGreaterThanOrEqual(room?.left ?? 0)
    expect(prop.cell.y).toBeGreaterThanOrEqual(room?.top ?? 0)
    expect(prop.cell.x + prop.width - 1).toBeLessThanOrEqual(room?.right ?? officeLayout.columns - 1)
    expect(prop.cell.y + prop.height - 1).toBeLessThanOrEqual(room?.bottom ?? officeLayout.rows - 1)
  }
  const occupied = new Set<string>()
  for (const prop of props.filter((item) => item.blocks)) {
    for (let y = prop.cell.y; y < prop.cell.y + prop.height; y++) {
      for (let x = prop.cell.x; x < prop.cell.x + prop.width; x++) {
        const cell = `${x},${y}`
        expect(occupied.has(cell), `${prop.room} ${prop.kind} ${cell}`).toBe(false)
        occupied.add(cell)
        expect(officeLayout.walkable(x, y)).toBe(false)
      }
    }
    const perimeter = [
      ...Array.from({ length: prop.width }, (_, index) => ({ x: prop.cell.x + index, y: prop.cell.y - 1 })),
      ...Array.from({ length: prop.width }, (_, index) => ({ x: prop.cell.x + index, y: prop.cell.y + prop.height })),
      ...Array.from({ length: prop.height }, (_, index) => ({ x: prop.cell.x - 1, y: prop.cell.y + index })),
      ...Array.from({ length: prop.height }, (_, index) => ({ x: prop.cell.x + prop.width, y: prop.cell.y + index })),
    ]
    expect(perimeter.some((cell) => officeLayout.walkable(cell.x, cell.y))).toBe(true)
  }
  for (const room of rooms) {
    const spots = room.id === "meeting" ? officeLayout.meeting : room.id === "lounge" ? officeLayout.lounge : officeLayout.work[room.id]
    for (const spot of spots.filter((item) => item.pose === "sit")) {
      expect(props.some((item) => item.room === room.id && item.blocks
        && Math.max(item.cell.x - spot.cell.x, 0, spot.cell.x - item.cell.x - item.width + 1)
          + Math.max(item.cell.y - spot.cell.y, 0, spot.cell.y - item.cell.y - item.height + 1) === 1)).toBe(true)
    }
  }
})

test("each room has a furnished wall and a lit, lived-in floor without sacrificing routes", () => {
  for (const room of rooms) {
    const kinds = new Set<string>(props.filter((item) => item.room === room.id).map((item) => item.kind))
    for (const kind of ["wallArt", "clock", "floorLamp"]) expect(kinds.has(kind), `${room.id} ${kind}`).toBe(true)
    expect(kinds.has("filingCabinet") || kinds.has("printer"), `${room.id} storage`).toBe(true)
    expect(kinds.has("rug") || kinds.has("blueRug"), `${room.id} rug`).toBe(true)
  }
  const shelves = props.filter((item) => item.room === "research" && item.kind === "bookshelf").sort((a, b) => a.cell.y - b.cell.y)
  expect(shelves.length).toBeGreaterThanOrEqual(4)
  expect(shelves.every((item, index) => !index || item.cell.x === shelves[0]!.cell.x && item.cell.y === shelves[index - 1]!.cell.y + shelves[index - 1]!.height)).toBe(true)
  const research = new Set<string>(props.filter((item) => item.room === "research").map((item) => item.kind))
  expect(["readingSeat", "floorLamp", "sideTable", "globe", "whiteboard"].every((kind) => research.has(kind))).toBe(true)
  const qa = new Set<string>(props.filter((item) => item.room === "qa").map((item) => item.kind))
  expect(["bugBoard", "deviceRack", "qaDesk"].every((kind) => qa.has(kind))).toBe(true)
  const lounge = new Set<string>(props.filter((item) => item.room === "lounge").map((item) => item.kind))
  expect(["sofaPeach", "sofaOrange", "beanBag", "beanBagBlue", "beanBagPink", "blueRug", "kitchenCounter", "wallTv"].every((kind) => lounge.has(kind))).toBe(true)
})
