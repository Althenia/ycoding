import type { OfficeActor, OfficeHomeRoom, OfficeLayout, OfficeSnapshot, OfficeSpot, Point } from "./types"

export function officeLayout(): OfficeLayout {
  const spotList = (x: number, y: number): readonly OfficeSpot[] => Array.from({ length: 20 }, (_, index) => ({
    cell: { x: x + index % 5, y: y + Math.floor(index / 5) },
    facing: index % 2 ? "left" : "right",
    pose: index % 3 ? "sit" : "stand",
  }))
  const rooms: Readonly<Record<OfficeHomeRoom, readonly OfficeSpot[]>> = {
    developer: spotList(9, 2), research: spotList(16, 2), qa: spotList(23, 2),
  }
  return {
    columns: 30,
    rows: 20,
    tileSize: 32,
    walkable: (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 30 && y >= 0 && y < 20 && !(x === 14 && y >= 7 && y <= 12),
    door: { x: 0, y: 10 },
    work: rooms,
    meeting: spotList(10, 10),
    lounge: spotList(22, 12),
    roomAt: (cell: Point) => {
      if (cell.x >= 9 && cell.x < 14 && cell.y >= 2 && cell.y < 6) return "developer"
      if (cell.x >= 16 && cell.x < 21 && cell.y >= 2 && cell.y < 6) return "research"
      if (cell.x >= 23 && cell.x < 28 && cell.y >= 2 && cell.y < 6) return "qa"
      if (cell.y >= 10 && cell.y < 14 && cell.x >= 10 && cell.x < 15) return "meeting"
      if (cell.y >= 12 && cell.y < 16 && cell.x >= 22 && cell.x < 27) return "lounge"
      return "hall"
    },
  }
}

export function actor(id: string, options: Partial<OfficeActor> = {}): OfficeActor {
  return {
    id,
    sessionID: id,
    kind: "session",
    name: id,
    role: "Developer",
    title: id,
    selected: false,
    status: "working",
    statusText: "Working",
    source: "projection",
    unknownOutcome: false,
    homeRoom: "developer",
    ...options,
  }
}

export function snapshot(actors: readonly OfficeActor[], options: Partial<OfficeSnapshot> = {}): OfficeSnapshot {
  return {
    scope: "scope-a",
    connection: "ready",
    actors,
    totalSessions: actors.length,
    overflow: 0,
    team: { status: "none", total: 0, shown: 0, more: false },
    cues: [],
    ...options,
  }
}
