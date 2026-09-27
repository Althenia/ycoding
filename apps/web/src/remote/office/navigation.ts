import type { OfficeLayout, Point } from "./types"

export function findPath(layout: OfficeLayout, start: Point, end: Point): readonly Point[] | undefined {
  if (!layout.walkable(start.x, start.y) || !layout.walkable(end.x, end.y)) return undefined
  const key = (point: Point) => point.y * layout.columns + point.x
  const queue: Point[] = [start]
  const parent = new Map<number, Point | undefined>([[key(start), undefined]])
  for (let head = 0; head < queue.length && head < layout.columns * layout.rows; head++) {
    const point = queue[head]!
    if (point.x === end.x && point.y === end.y) {
      const path: Point[] = []
      let step: Point | undefined = point
      while (step) {
        path.push(step)
        step = parent.get(key(step))
      }
      return path.reverse().slice(1)
    }
    for (const next of [{ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y }, { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 }]) {
      if (!layout.walkable(next.x, next.y) || parent.has(key(next))) continue
      parent.set(key(next), point)
      queue.push(next)
    }
  }
  return undefined
}
