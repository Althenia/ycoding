import type { OfficeLayout, OfficeSpot, Point } from "./types"

export const tileSize = 32
export const columns = 64
export const rows = 40
export const worldWidth = columns * tileSize
export const worldHeight = rows * tileSize

export type OfficeFurniture = "developerDesk" | "researchDesk" | "qaDesk" | "conferenceTable"
  | "sofaPeach" | "sofaOrange" | "coffeeTable" | "beanBag" | "beanBagBlue" | "beanBagPink" | "pingPong" | "kitchenCounter" | "fridge" | "serverRack"
  | "deviceRack" | "bookshelf" | "whiteboard" | "bugBoard" | "wallTv" | "waterDispenser"
  | "plantFern" | "plantMonstera" | "plantBamboo" | "plantSucculent" | "plantFlowers"
  | "globe" | "readingSeat" | "receptionDesk" | "blueRug"
  | "wallArt" | "clock" | "floorLamp" | "sideTable" | "filingCabinet" | "printer"
export type OfficeProp = {
  readonly pod?: number
  readonly kind: OfficeFurniture
  readonly cell: Point
  readonly width: number
  readonly height: number
  readonly blocks: boolean
  readonly layer: "floor" | "object"
}

export type OfficePod = {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly spots: Readonly<Record<"implement" | "research" | "verify" | "coordinate", OfficeSpot>>
}

export const pods: readonly OfficePod[] = [2, 11, 20, 29].flatMap((top) => [2, 17, 32, 47].map((left) => ({
  left, right: left + 11, top, bottom: top + 6,
  spots: {
    implement: { cell: { x: left + 2, y: top + 3 }, facing: "up", pose: "sit" },
    research: { cell: { x: left + 6, y: top + 3 }, facing: "up", pose: "stand" },
    verify: { cell: { x: left + 9, y: top + 3 }, facing: "up", pose: "sit" },
    coordinate: { cell: { x: left + 6, y: top + 5 }, facing: "down", pose: "stand" },
  },
})))

function prop(kind: OfficeFurniture, x: number, y: number, width: number, height: number, pod?: number, blocks = true, layer: OfficeProp["layer"] = "object"): OfficeProp {
  return { kind, cell: { x, y }, width, height, pod, blocks, layer }
}

export const props: readonly OfficeProp[] = [
  ...pods.flatMap((pod, index) => [
    prop("developerDesk", pod.left + 1, pod.top + 1, 3, 2, index),
    prop("bookshelf", pod.left + 5, pod.top + 1, 2, 2, index),
    prop("qaDesk", pod.left + 8, pod.top + 1, 3, 2, index),
    prop("whiteboard", pod.left + 5, pod.top + 6, 3, 1, index, false),
  ]),
  prop("blueRug", 19, 37, 16, 2, undefined, false, "floor"),
  prop("sofaPeach", 19, 37, 4, 1),
  prop("sofaOrange", 29, 37, 4, 1),
  prop("coffeeTable", 24, 37, 3, 1),
  prop("beanBag", 34, 37, 2, 2),
  prop("beanBagBlue", 37, 37, 2, 2),
  prop("kitchenCounter", 40, 37, 4, 1),
  prop("fridge", 45, 37, 1, 2),
  prop("receptionDesk", 9, 37, 2, 1),
  prop("plantFern", 6, 37, 1, 1),
  prop("plantMonstera", 51, 37, 1, 1),
  prop("plantBamboo", 55, 37, 1, 1),
]

const occupied = new Set(props.filter((item) => item.blocks).flatMap((item) =>
  Array.from({ length: item.height }, (_, dy) => Array.from({ length: item.width }, (_, dx) => `${item.cell.x + dx},${item.cell.y + dy}`)).flat(),
))
const outerDoor = { x: 31, y: rows - 1 }

export function wallAt(x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= columns || y >= rows) return true
  if (y === rows - 1 && (x === outerDoor.x || x === outerDoor.x + 1)) return false
  return x === 0 || x === columns - 1 || y === 0 || y === rows - 1
}

export function walkable(x: number, y: number): boolean {
  return !wallAt(x, y) && !occupied.has(`${x},${y}`)
}

export function roomAt(cell: Point): "block" | "lounge" | "hall" | undefined {
  if (wallAt(cell.x, cell.y)) return undefined
  if (pods.some((pod) => cell.x >= pod.left && cell.x <= pod.right && cell.y >= pod.top && cell.y <= pod.bottom)) return "block"
  if (cell.y >= 37 && cell.x >= 18 && cell.x <= 46) return "lounge"
  return "hall"
}

export function floorFrameAt(x: number, y: number): number {
  return pods.some((pod) => x >= pod.left && x <= pod.right && y >= pod.top && y <= pod.bottom) ? 1 : 0
}

export function wallFrameAt(x: number, y: number): number {
  return y === rows - 1 && (x === outerDoor.x || x === outerDoor.x + 1) ? 3 : wallAt(x, y) ? 0 : 2
}

export const officeLayout: OfficeLayout = {
  columns, rows, tileSize, walkable, roomAt, door: outerDoor, pods,
  lounge: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 39, 42].map((x) => ({ cell: { x, y: 38 }, facing: "up", pose: "stand" })),
}

export function center(cell: Point): Point {
  return { x: cell.x * tileSize + tileSize / 2, y: cell.y * tileSize + tileSize / 2 }
}
