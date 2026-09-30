import { officeLayout, props, tileSize } from "./map"
import type { ActorFrame, Point } from "./types"

export const rallyPeriod = 1_800

const table = props.find((prop) => prop.kind === "pingPong")!
const ends = officeLayout.lounge.filter((spot) => spot.pose === "play" && spot.cell.y === table.cell.y)
const west = ends.find((spot) => spot.facing === "right")!.cell
const east = ends.find((spot) => spot.facing === "left")!.cell
const surface = { left: table.cell.x * tileSize, right: (table.cell.x + table.width) * tileSize, y: (table.cell.y + table.height / 2) * tileSize }
const arcHeight = 10

export function rallyBall(frames: readonly ActorFrame[], elapsed: number): Point | undefined {
  const at = (cell: Point) => frames.some((frame) => frame.pose === "play" && Math.floor(frame.position.x / tileSize) === cell.x && Math.floor(frame.position.y / tileSize) === cell.y)
  if (!at(west) || !at(east)) return undefined
  const phase = (elapsed % rallyPeriod) / rallyPeriod
  const leg = phase < 0.5 ? phase * 2 : phase * 2 - 1
  const travel = phase < 0.5 ? leg : 1 - leg
  return { x: surface.left + 6 + travel * (surface.right - surface.left - 12), y: surface.y - Math.sin(leg * Math.PI) * arcHeight }
}
