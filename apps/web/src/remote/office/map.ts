import type { OfficeLayout, OfficeSpot, Point } from "./types"

export const tileSize = 32
export const columns = 48
export const rows = 38
export const worldWidth = columns * tileSize
export const worldHeight = rows * tileSize

export type OfficeFurniture = "developerDesk" | "developerDeskLamp" | "developerDeskPlant" | "researchDesk" | "qaDesk" | "qaDeskMug"
  | "compactDeskCode" | "compactDeskChart" | "compactDeskTest" | "cornerDesk" | "cornerReturn" | "credenza" | "partition"
  | "conferenceTable" | "sofaPeach" | "sofaOrange" | "coffeeTable" | "beanBag" | "beanBagBlue" | "beanBagPink" | "pingPong"
  | "kitchenCounter" | "fridge" | "coffeeMachine" | "bistroTable" | "serverRack"
  | "deviceRack" | "bookshelf" | "whiteboard" | "bugBoard" | "wallTv" | "waterDispenser"
  | "plantFern" | "plantMonstera" | "plantBamboo" | "plantSucculent" | "plantFlowers"
  | "globe" | "readingSeat" | "receptionDesk" | "blueRug" | "rugRound" | "rugRunner" | "rugMat" | "rugSage"
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
  readonly template: PodTemplate
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly spots: Readonly<Record<"implement" | "research" | "verify" | "coordinate", OfficeSpot>>
}

type PodSpots = OfficePod["spots"]
type Piece = Omit<OfficeProp, "pod">
type Swap = Partial<Record<OfficeFurniture, OfficeFurniture>>

function piece(kind: OfficeFurniture, x: number, y: number, width: number, height: number, blocks = true, layer: OfficeProp["layer"] = "object"): Piece {
  return { kind, cell: { x, y }, width, height, blocks, layer }
}

const rug = (kind: OfficeFurniture, x: number, y: number, width: number, height: number) => piece(kind, x, y, width, height, false, "floor")
const board = (kind: "whiteboard" | "bugBoard", x: number, y: number) => piece(kind, x, y, 3, 1, false)
const spot = (x: number, y: number, facing: OfficeSpot["facing"], pose: OfficeSpot["pose"]): OfficeSpot => ({ cell: { x, y }, facing, pose })

const templates = {
  row: {
    width: 8, height: 5,
    pieces: [piece("developerDesk", 0, 0, 3, 2), piece("bookshelf", 3, 0, 2, 2), piece("qaDesk", 5, 0, 3, 2), board("whiteboard", 2, 4)],
    spots: { implement: spot(1, 2, "up", "sit"), research: spot(4, 2, "up", "stand"), verify: spot(6, 2, "up", "sit"), coordinate: spot(3, 3, "down", "stand") },
  },
  corner: {
    width: 8, height: 6,
    pieces: [piece("cornerDesk", 0, 0, 4, 2), piece("cornerReturn", 3, 2, 1, 2), piece("bookshelf", 4, 0, 2, 2), piece("compactDeskTest", 6, 0, 2, 2), board("whiteboard", 3, 5)],
    spots: { implement: spot(1, 2, "up", "sit"), research: spot(5, 2, "up", "stand"), verify: spot(7, 2, "up", "sit"), coordinate: spot(4, 4, "down", "stand") },
  },
  bench: {
    width: 6, height: 5,
    pieces: [piece("compactDeskCode", 0, 0, 2, 2), piece("credenza", 2, 1, 2, 1), piece("compactDeskTest", 4, 0, 2, 2), board("whiteboard", 1, 4)],
    spots: { implement: spot(1, 2, "up", "sit"), research: spot(3, 2, "up", "stand"), verify: spot(5, 2, "up", "sit"), coordinate: spot(2, 3, "down", "stand") },
  },
  stagger: {
    width: 8, height: 6,
    pieces: [piece("developerDesk", 0, 0, 3, 2), piece("bookshelf", 3, 0, 2, 2), piece("partition", 5, 1, 2, 1), piece("qaDesk", 5, 2, 3, 2), board("whiteboard", 0, 5)],
    spots: { implement: spot(1, 2, "up", "sit"), research: spot(4, 2, "up", "stand"), verify: spot(6, 4, "up", "sit"), coordinate: spot(1, 4, "down", "stand") },
  },
  studio: {
    width: 7, height: 5,
    pieces: [piece("researchDesk", 0, 0, 3, 2), piece("bookshelf", 3, 0, 2, 2), piece("deviceRack", 5, 0, 2, 2), board("bugBoard", 2, 4)],
    spots: { implement: spot(1, 2, "up", "sit"), research: spot(4, 2, "up", "stand"), verify: spot(6, 2, "up", "stand"), coordinate: spot(3, 3, "down", "stand") },
  },
} satisfies Record<string, { width: number; height: number; pieces: readonly Piece[]; spots: PodSpots }>

type PodTemplate = keyof typeof templates

const plan = (template: PodTemplate, left: number, top: number, swap: Swap, extras: readonly Piece[]) => ({ template, left, top, swap, extras })

const one = (kind: OfficeFurniture, x: number, y: number) => piece(kind, x, y, 1, 1)

const plans = [
  plan("row", 1, 2, { developerDesk: "developerDeskLamp" }, [one("plantFern", 0, 3), one("floorLamp", 7, 3), rug("rugRunner", 2, 3, 4, 2)]),
  plan("bench", 11, 2, { compactDeskCode: "compactDeskChart" }, [one("globe", 5, 3)]),
  plan("corner", 19, 2, {}, [one("plantBamboo", 7, 4), rug("rugRound", 0, 3, 3, 3)]),
  plan("stagger", 28, 2, { developerDesk: "developerDeskPlant" }, [one("sideTable", 7, 0), one("floorLamp", 7, 5), rug("rugRunner", 2, 4, 4, 2)]),
  plan("studio", 38, 2, {}, [one("plantFlowers", 0, 3), one("printer", 6, 4)]),
  plan("stagger", 1, 10, { qaDesk: "qaDeskMug" }, [one("plantFern", 7, 5), one("globe", 0, 3), rug("rugMat", 1, 3, 3, 2)]),
  plan("studio", 10, 11, {}, [one("plantMonstera", 0, 4), one("sideTable", 6, 4)]),
  plan("bench", 19, 10, {}, [one("plantBamboo", 0, 3), one("printer", 5, 3), rug("rugMat", 1, 3, 3, 2)]),
  plan("row", 27, 11, { developerDesk: "developerDeskPlant", qaDesk: "qaDeskMug" }, [one("floorLamp", 0, 3), one("plantFlowers", 7, 4)]),
  plan("corner", 37, 10, {}, [one("floorLamp", 7, 3), rug("rugRound", 0, 3, 3, 3)]),
  plan("studio", 1, 18, {}, [one("plantBamboo", 0, 4), one("floorLamp", 6, 4), rug("rugMat", 4, 3, 3, 2)]),
  plan("row", 1, 25, { qaDesk: "qaDeskMug" }, [one("plantMonstera", 0, 3), one("sideTable", 7, 3)]),
  plan("bench", 1, 32, { compactDeskCode: "compactDeskChart" }, [one("plantFlowers", 0, 3), one("globe", 5, 4), rug("rugRunner", 1, 3, 4, 2)]),
  plan("row", 39, 18, { developerDesk: "developerDeskLamp", qaDesk: "qaDeskMug" }, [one("plantSucculent", 7, 3), one("printer", 0, 3)]),
  plan("bench", 41, 25, {}, [one("plantFern", 0, 3), one("floorLamp", 5, 3), rug("rugRound", 1, 2, 3, 3)]),
  plan("studio", 40, 32, {}, [one("plantMonstera", 6, 4), one("globe", 0, 3), rug("rugRunner", 2, 3, 4, 2)]),
]

export const pods: readonly OfficePod[] = plans.map((item) => {
  const template = templates[item.template]
  const shift = (value: OfficeSpot): OfficeSpot => ({ ...value, cell: { x: item.left + value.cell.x, y: item.top + value.cell.y } })
  return {
    template: item.template,
    left: item.left, right: item.left + template.width - 1, top: item.top, bottom: item.top + template.height - 1,
    spots: {
      implement: shift(template.spots.implement), research: shift(template.spots.research),
      verify: shift(template.spots.verify), coordinate: shift(template.spots.coordinate),
    },
  }
})

const podProps = plans.flatMap((item, pod) => [...templates[item.template].pieces, ...item.extras].map((entry): OfficeProp => ({
  ...entry, kind: item.swap[entry.kind] ?? entry.kind, cell: { x: item.left + entry.cell.x, y: item.top + entry.cell.y }, pod,
})))

function shared(kind: OfficeFurniture, x: number, y: number, width: number, height: number, blocks = true, layer: OfficeProp["layer"] = "object"): OfficeProp {
  return { kind, cell: { x, y }, width, height, blocks, layer }
}

const sharedProps: readonly OfficeProp[] = [
  shared("clock", 23, 0, 1, 1, false),
  shared("waterDispenser", 17, 3, 1, 1),
  shared("plantFern", 18, 6, 1, 1),
  shared("printer", 36, 3, 1, 1),
  shared("plantBamboo", 37, 6, 1, 1),
  shared("floorLamp", 18, 9, 1, 1),
  shared("plantSucculent", 27, 8, 1, 1),
  shared("plantMonstera", 9, 17, 1, 1),
  shared("plantFlowers", 18, 16, 1, 1),
  shared("floorLamp", 36, 17, 1, 1),
  shared("plantFern", 46, 16, 1, 1),

  shared("bookshelf", 10, 19, 2, 2),
  shared("plantMonstera", 22, 18, 1, 1),
  shared("blueRug", 14, 21, 4, 3, false, "floor"),
  shared("sofaPeach", 14, 20, 4, 1),
  shared("floorLamp", 18, 20, 1, 1),
  shared("sofaOrange", 19, 20, 4, 1),
  shared("coffeeTable", 15, 22, 3, 1),
  shared("sideTable", 19, 22, 1, 1),
  shared("beanBag", 10, 23, 2, 2),
  shared("beanBagPink", 20, 23, 2, 2),
  shared("beanBagBlue", 12, 26, 2, 2),
  shared("pingPong", 15, 26, 4, 2),
  shared("rugRound", 15, 29, 3, 3, false, "floor"),
  shared("readingSeat", 10, 29, 3, 1),
  shared("sideTable", 13, 29, 1, 1),
  shared("bookshelf", 19, 29, 2, 2),
  shared("globe", 21, 29, 1, 1),
  shared("plantFern", 10, 32, 1, 1),
  shared("plantBamboo", 22, 32, 1, 1),

  shared("rugSage", 27, 21, 10, 5, false, "floor"),
  shared("whiteboard", 26, 18, 3, 1),
  shared("wallTv", 30, 18, 4, 1),
  shared("plantFern", 37, 19, 1, 1),
  shared("conferenceTable", 28, 22, 8, 3),
  shared("floorLamp", 37, 25, 1, 1),

  shared("kitchenCounter", 28, 30, 5, 1),
  shared("fridge", 33, 30, 1, 1),
  shared("coffeeMachine", 34, 30, 1, 1),
  shared("waterDispenser", 35, 30, 1, 1),
  shared("plantMonstera", 37, 30, 1, 1),
  shared("bistroTable", 28, 33, 2, 1),
  shared("bistroTable", 33, 33, 2, 1),
  shared("plantFlowers", 37, 35, 1, 1),

  shared("receptionDesk", 12, 35, 2, 1),
  shared("plantFlowers", 10, 33, 1, 1),
  shared("sideTable", 15, 35, 1, 1),
  shared("plantBamboo", 20, 34, 1, 1),
  shared("floorLamp", 21, 33, 1, 1),
  shared("plantFern", 26, 34, 1, 1),
]

export const props: readonly OfficeProp[] = [...podProps, ...sharedProps]

const occupied = new Set(props.filter((item) => item.blocks).flatMap((item) =>
  Array.from({ length: item.height }, (_, dy) => Array.from({ length: item.width }, (_, dx) => `${item.cell.x + dx},${item.cell.y + dy}`)).flat(),
))
const outerDoor = { x: 23, y: rows - 1 }

type Zone = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly frame: number }
const zone = (x0: number, y0: number, x1: number, y1: number, frame: number): Zone => ({ x0, y0, x1, y1, frame })

const social = [zone(10, 18, 22, 32, 5), zone(26, 18, 37, 26, 4), zone(26, 29, 37, 36, 8)]
const floorZones = [
  ...social,
  zone(10, 33, 25, 36, 7),
  zone(1, 1, 16, 7, 1), zone(19, 1, 35, 7, 6), zone(37, 1, 46, 7, 2),
  zone(1, 10, 16, 15, 6), zone(19, 10, 34, 15, 1), zone(37, 10, 46, 15, 3),
  zone(1, 18, 8, 36, 2), zone(39, 18, 46, 36, 1),
]

const within = (item: Zone, x: number, y: number) => x >= item.x0 && x <= item.x1 && y >= item.y0 && y <= item.y1

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
  if (social.some((item) => within(item, cell.x, cell.y))) return "lounge"
  return "hall"
}

export function floorFrameAt(x: number, y: number): number {
  return floorZones.find((item) => within(item, x, y))?.frame ?? 0
}

export function wallFrameAt(x: number, y: number): number {
  return y === rows - 1 && (x === outerDoor.x || x === outerDoor.x + 1) ? 3 : wallAt(x, y) ? 0 : 2
}

const rest = (x: number, y: number, facing: OfficeSpot["facing"] = "up", pose: OfficeSpot["pose"] = "stand"): OfficeSpot => spot(x, y, facing, pose)

export const officeLayout: OfficeLayout = {
  columns, rows, tileSize, walkable, roomAt, door: outerDoor, pods,
  lounge: [
    rest(14, 26, "right", "play"), rest(19, 26, "left", "play"), rest(16, 28, "up", "play"), rest(17, 28, "up", "play"),
    rest(14, 21), rest(15, 21), rest(16, 21), rest(17, 21), rest(19, 21), rest(20, 21), rest(21, 21), rest(22, 21),
    rest(10, 25), rest(11, 25), rest(20, 25), rest(21, 25), rest(11, 30), rest(12, 30),
    rest(27, 22, "right"), rest(27, 23, "right"), rest(36, 22, "left"), rest(36, 23, "left"),
    rest(29, 31), rest(31, 31), rest(34, 31), rest(36, 31),
  ],
}

export function center(cell: Point): Point {
  return { x: cell.x * tileSize + tileSize / 2, y: cell.y * tileSize + tileSize / 2 }
}
