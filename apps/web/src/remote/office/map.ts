import type { OfficeLayout, OfficeRoomID, OfficeSpot, Point } from "./types"

export const tileSize = 32
export const columns = 56
export const rows = 40
export const worldWidth = columns * tileSize
export const worldHeight = rows * tileSize

export type OfficeFurniture = "executiveDesk" | "developerDesk" | "researchDesk" | "qaDesk" | "conferenceTable"
  | "sofa" | "sofaPeach" | "sofaOrange" | "coffeeTable" | "beanBag" | "beanBagBlue" | "beanBagPink" | "pingPong" | "kitchenCounter" | "fridge" | "serverRack"
  | "deviceRack" | "bookshelf" | "whiteboard" | "bugBoard" | "wallTv" | "waterDispenser"
  | "plantFern" | "plantMonstera" | "plantBamboo" | "plantSucculent" | "plantFlowers"
  | "aquarium" | "globe" | "readingSeat" | "receptionDesk" | "rug" | "blueRug"
  | "wallArt" | "clock" | "floorLamp" | "sideTable" | "filingCabinet" | "printer"

export type OfficeProp = {
  readonly room: OfficeRoomID
  readonly kind: OfficeFurniture
  readonly cell: Point
  readonly width: number
  readonly height: number
  readonly blocks: boolean
  readonly layer: "floor" | "object"
}

type OfficeRoom = {
  readonly id: Exclude<OfficeRoomID, "hall">
  readonly title: string
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly center: Point
  readonly label: Point
  readonly doors: readonly Point[]
  readonly floor: number
}

export const rooms: readonly OfficeRoom[] = [
  { id: "ceo", title: "CEO OFFICE", left: 2, top: 2, right: 16, bottom: 16, center: { x: 9, y: 9 }, label: { x: 9, y: 1 }, doors: [{ x: 8, y: 17 }, { x: 9, y: 17 }], floor: 1 },
  { id: "research", title: "RESEARCH LAB", left: 19, top: 2, right: 36, bottom: 16, center: { x: 27, y: 9 }, label: { x: 27, y: 1 }, doors: [{ x: 27, y: 17 }, { x: 28, y: 17 }], floor: 3 },
  { id: "qa", title: "QA LAB", left: 39, top: 2, right: 53, bottom: 16, center: { x: 46, y: 9 }, label: { x: 46, y: 1 }, doors: [{ x: 45, y: 17 }, { x: 46, y: 17 }], floor: 4 },
  { id: "developer", title: "DEVELOPER STUDIO", left: 2, top: 22, right: 19, bottom: 35, center: { x: 10, y: 28 }, label: { x: 6, y: 20.7 }, doors: [{ x: 10, y: 21 }, { x: 11, y: 21 }, { x: 10, y: 36 }, { x: 11, y: 36 }], floor: 2 },
  { id: "meeting", title: "MEETING ROOM", left: 24, top: 22, right: 35, bottom: 35, center: { x: 29, y: 29 }, label: { x: 25, y: 20.7 }, doors: [{ x: 29, y: 21 }, { x: 30, y: 21 }, { x: 29, y: 36 }, { x: 30, y: 36 }], floor: 5 },
  { id: "lounge", title: "RELAX LOUNGE", left: 40, top: 22, right: 53, bottom: 35, center: { x: 46, y: 29 }, label: { x: 42, y: 20.7 }, doors: [{ x: 46, y: 21 }, { x: 47, y: 21 }, { x: 46, y: 36 }, { x: 47, y: 36 }], floor: 6 },
]

const outerDoor = { x: 27, y: 39 }

function prop(room: OfficeRoomID, kind: OfficeFurniture, x: number, y: number, width: number, height: number, blocks = true, layer: OfficeProp["layer"] = "object"): OfficeProp {
  return { room, kind, cell: { x, y }, width, height, blocks, layer }
}

export const props: readonly OfficeProp[] = [
  prop("ceo", "rug", 4, 4, 11, 9, false, "floor"),
  prop("ceo", "executiveDesk", 5, 5, 4, 2),
  prop("ceo", "bookshelf", 2, 3, 2, 3),
  prop("ceo", "aquarium", 11, 3, 3, 2),
  prop("ceo", "sofa", 10, 9, 5, 2),
  prop("ceo", "coffeeTable", 11, 12, 3, 1),
  prop("ceo", "plantMonstera", 3, 14, 1, 1),
  prop("ceo", "plantFlowers", 15, 14, 1, 1),
  prop("ceo", "wallArt", 14, 2, 2, 1, false),
  prop("ceo", "clock", 5, 2, 1, 1, false),
  prop("ceo", "floorLamp", 15, 12, 1, 1),
  prop("ceo", "printer", 15, 5, 1, 1),
  ...[23, 26, 29, 32].flatMap((y) => [3, 9, 15].map((x) => prop("developer", "developerDesk", x, y, 3, 2))),
  prop("developer", "serverRack", 18, 23, 2, 3),
  prop("developer", "whiteboard", 6, 22, 4, 1, false),
  prop("developer", "plantFern", 2, 34, 1, 1),
  prop("developer", "plantBamboo", 19, 34, 1, 1),
  prop("developer", "blueRug", 7, 34, 5, 1, false, "floor"),
  prop("developer", "wallArt", 13, 22, 2, 1, false),
  prop("developer", "clock", 3, 22, 1, 1, false),
  prop("developer", "floorLamp", 2, 30, 1, 1),
  prop("developer", "filingCabinet", 18, 29, 2, 2),
  ...[4, 8, 12].flatMap((y) => [21, 29].map((x) => prop("research", "researchDesk", x, y, 3, 2))),
  prop("research", "bookshelf", 34, 3, 2, 3),
  prop("research", "bookshelf", 34, 6, 2, 3),
  prop("research", "bookshelf", 34, 9, 2, 3),
  prop("research", "bookshelf", 34, 12, 2, 3),
  prop("research", "readingSeat", 20, 15, 3, 2),
  prop("research", "whiteboard", 25, 2, 4, 1, false),
  prop("research", "globe", 26, 13, 1, 1),
  prop("research", "plantBamboo", 20, 3, 1, 1),
  prop("research", "blueRug", 20, 15, 6, 2, false, "floor"),
  prop("research", "wallArt", 22, 2, 2, 1, false),
  prop("research", "clock", 31, 2, 1, 1, false),
  prop("research", "floorLamp", 23, 15, 1, 1),
  prop("research", "sideTable", 24, 15, 1, 1),
  prop("research", "filingCabinet", 34, 15, 2, 2),
  ...[4, 8, 12].flatMap((y) => [40, 47].map((x) => prop("qa", "qaDesk", x, y, 3, 2))),
  prop("qa", "bugBoard", 43, 2, 4, 1, false),
  prop("qa", "deviceRack", 51, 7, 2, 3),
  prop("qa", "plantSucculent", 39, 14, 1, 1),
  prop("qa", "plantFlowers", 52, 14, 1, 1),
  prop("qa", "blueRug", 44, 14, 6, 2, false, "floor"),
  prop("qa", "wallArt", 39, 2, 2, 1, false),
  prop("qa", "clock", 50, 2, 1, 1, false),
  prop("qa", "floorLamp", 39, 9, 1, 1),
  prop("qa", "filingCabinet", 51, 12, 2, 2),
  prop("meeting", "blueRug", 25, 24, 10, 8, false, "floor"),
  prop("meeting", "conferenceTable", 26, 25, 8, 3),
  prop("meeting", "wallTv", 27, 22, 4, 1, false),
  prop("meeting", "whiteboard", 33, 22, 2, 1, false),
  prop("meeting", "waterDispenser", 24, 32, 1, 2),
  prop("meeting", "plantMonstera", 34, 33, 1, 1),
  prop("meeting", "wallArt", 24, 22, 2, 1, false),
  prop("meeting", "clock", 35, 22, 1, 1, false),
  prop("meeting", "floorLamp", 35, 29, 1, 1),
  prop("meeting", "printer", 24, 29, 1, 1),
  prop("lounge", "blueRug", 41, 24, 11, 9, false, "floor"),
  prop("lounge", "sofaPeach", 41, 24, 5, 2),
  prop("lounge", "sofaOrange", 48, 24, 5, 2),
  prop("lounge", "coffeeTable", 45, 27, 3, 1),
  prop("lounge", "beanBag", 42, 29, 2, 2),
  prop("lounge", "beanBagBlue", 46, 29, 2, 2),
  prop("lounge", "beanBagPink", 50, 29, 2, 2),
  prop("lounge", "pingPong", 45, 31, 4, 2),
  prop("lounge", "kitchenCounter", 40, 34, 5, 1),
  prop("lounge", "fridge", 52, 32, 1, 2),
  prop("lounge", "waterDispenser", 50, 33, 1, 2),
  prop("lounge", "wallTv", 46, 22, 3, 1, false),
  prop("lounge", "plantFern", 40, 32, 1, 1),
  prop("lounge", "plantFlowers", 53, 34, 1, 1),
  prop("lounge", "wallArt", 40, 22, 2, 1, false),
  prop("lounge", "clock", 52, 22, 1, 1, false),
  prop("lounge", "floorLamp", 53, 29, 1, 1),
  prop("lounge", "printer", 40, 27, 1, 1),
  prop("hall", "rug", 26, 38, 4, 1, false, "floor"),
  prop("hall", "receptionDesk", 32, 37, 2, 1),
  prop("hall", "plantBamboo", 24, 37, 1, 1),
  prop("hall", "plantMonstera", 34, 37, 1, 1),
]

const occupied = new Set(props.filter((item) => item.blocks).flatMap((item) =>
  Array.from({ length: item.height }, (_, dy) => Array.from({ length: item.width }, (_, dx) => `${item.cell.x + dx},${item.cell.y + dy}`)).flat(),
))

export function wallAt(x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= columns || y >= rows) return true
  if (y === rows - 1 && (x === outerDoor.x || x === outerDoor.x + 1)) return false
  if (x === 0 || x === columns - 1 || y === 0 || y === rows - 1) return true
  return rooms.some((room) => {
    if (room.doors.some((door) => door.x === x && door.y === y)) return false
    return x >= room.left - 1 && x <= room.right + 1 && y >= room.top - 1 && y <= room.bottom + 1
      && (x === room.left - 1 || x === room.right + 1 || y === room.top - 1 || y === room.bottom + 1)
  })
}

export function walkable(x: number, y: number): boolean {
  return !wallAt(x, y) && !occupied.has(`${x},${y}`)
}

export function roomAt(cell: Point): OfficeRoomID | undefined {
  if (wallAt(cell.x, cell.y)) return undefined
  return rooms.find((room) => cell.x >= room.left && cell.x <= room.right && cell.y >= room.top && cell.y <= room.bottom)?.id ?? "hall"
}

export function floorFrameAt(x: number, y: number): number {
  const room = rooms.find((item) => x >= item.left && x <= item.right && y >= item.top && y <= item.bottom)
  return room?.floor ?? 0
}

export function wallFrameAt(x: number, y: number): number {
  if (y === rows - 1 && (x === outerDoor.x || x === outerDoor.x + 1)) return 3
  if (!wallAt(x, y)) return 2
  if (rooms.some((room) => y === room.top - 1 && x >= room.left + 2 && x <= room.right - 2 && x % 4 < 2)) return 1
  return 0
}

function spots(roomID: Exclude<OfficeRoomID, "hall">, seated: readonly Point[]): readonly OfficeSpot[] {
  const room = rooms.find((item) => item.id === roomID)!
  const seats: OfficeSpot[] = seated.map((cell) => ({ cell, facing: "up", pose: "sit" }))
  const used = new Set(seats.map((spot) => `${spot.cell.x},${spot.cell.y}`))
  const standing = Array.from({ length: room.bottom - room.top + 1 }, (_, dy) => room.top + dy)
    .flatMap((y) => Array.from({ length: room.right - room.left + 1 }, (_, dx) => ({ x: room.left + dx, y })))
    .filter((cell) => walkable(cell.x, cell.y) && !used.has(`${cell.x},${cell.y}`))
    .map((cell): OfficeSpot => ({ cell, facing: "down", pose: "stand" }))
  return [...seats, ...standing.slice(0, Math.max(0, 16 - seats.length))]
}

export const officeLayout: OfficeLayout = {
  columns, rows, tileSize, walkable, roomAt, door: outerDoor,
  work: {
    ceo: spots("ceo", [{ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 11, y: 11 }, { x: 12, y: 11 }, { x: 13, y: 11 }, { x: 14, y: 11 }]),
    developer: spots("developer", [25, 28, 31, 34].flatMap((y) => [4, 10, 16].map((x) => ({ x, y })))),
    research: spots("research", [6, 10, 14].flatMap((y) => [22, 30].map((x) => ({ x, y })))),
    qa: spots("qa", [6, 10, 14].flatMap((y) => [41, 48].map((x) => ({ x, y })))),
  },
  meeting: spots("meeting", [...[27, 29, 31, 33].map((x) => ({ x, y: 24 })), ...[27, 29, 31, 33].map((x) => ({ x, y: 28 }))]),
  lounge: spots("lounge", [...[42, 43, 44, 45].map((x) => ({ x, y: 26 })), ...[49, 50, 51, 52].map((x) => ({ x, y: 26 })), { x: 43, y: 31 }, { x: 50, y: 31 }]),
}

export function center(cell: Point): Point {
  return { x: cell.x * tileSize + tileSize / 2, y: cell.y * tileSize + tileSize / 2 }
}
