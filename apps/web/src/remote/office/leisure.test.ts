import { expect, test } from "bun:test"
import { OfficeDirector } from "./director"
import { rallyBall, rallyPeriod } from "./leisure"
import { officeLayout, props, tileSize } from "./map"
import { actor, snapshot } from "./layout.test-helper"

const players = (count: number) => Array.from({ length: count }, (_, index) => actor(`player-${index}`, { status: "idle" }))
const framesOf = (count: number, reduced = false) => {
  const director = new OfficeDirector(officeLayout)
  director.sync(snapshot(players(count)))
  return director.tick(0, reduced)
}
const table = props.find((prop) => prop.kind === "pingPong")!
const tableBounds = { left: table.cell.x * tileSize, right: (table.cell.x + table.width) * tileSize, top: table.cell.y * tileSize, bottom: (table.cell.y + table.height) * tileSize }

test("the ball exists only while players are present at both table ends", () => {
  expect(rallyBall(framesOf(1), 0)).toBeUndefined()
  expect(rallyBall(framesOf(2), 0)).toBeDefined()
  expect(rallyBall(framesOf(4), 0)).toBeDefined()
  expect(rallyBall(framesOf(0), 0)).toBeUndefined()
})

test("the ball never travels in reduced motion or for players that are not playing", () => {
  expect(rallyBall(framesOf(4, true), 0)).toBeUndefined()
  const director = new OfficeDirector(officeLayout)
  const pair = players(2)
  director.sync(snapshot(pair))
  director.sync(snapshot([{ ...pair[0]!, status: "working" }, pair[1]!]))
  expect(rallyBall(director.tick(0, false), 0)).toBeUndefined()
})

test("the ball disappears as soon as either end player leaves the table", () => {
  for (const leaving of [0, 1]) {
    const director = new OfficeDirector(officeLayout)
    const pair = players(2)
    director.sync(snapshot(pair))
    expect(rallyBall(director.tick(0, false), 0)).toBeDefined()
    director.sync(snapshot(pair.map((player, index) => index === leaving ? { ...player, status: "working" } : player)))
    expect(rallyBall(director.tick(0, false), 0)).toBeUndefined()
  }
})

test("the ball crosses from one end player to the other and back, arcing over the table", () => {
  const frames = framesOf(2)
  const [west, east] = frames.map((frame) => frame.position.x)
  const start = rallyBall(frames, 0)!
  const middle = rallyBall(frames, rallyPeriod / 4)!
  const far = rallyBall(frames, rallyPeriod / 2)!
  const back = rallyBall(frames, rallyPeriod * 3 / 4)!
  expect(start.x).toBeGreaterThan(west!)
  expect(far.x).toBeLessThan(east!)
  expect(far.x).toBeGreaterThan(middle.x)
  expect(middle.x).toBeGreaterThan(start.x)
  expect(back.x).toBeLessThan(far.x)
  expect(middle.y).toBeLessThan(start.y)
  expect(rallyBall(frames, rallyPeriod)).toEqual(start)
  for (let time = 0; time < rallyPeriod; time += 50) {
    const ball = rallyBall(frames, time)!
    expect(ball.x).toBeGreaterThanOrEqual(tableBounds.left)
    expect(ball.x).toBeLessThanOrEqual(tableBounds.right)
    expect(ball.y).toBeGreaterThanOrEqual(tableBounds.top)
    expect(ball.y).toBeLessThanOrEqual(tableBounds.bottom)
  }
})
