import { expect, test } from "bun:test"
import { props } from "./map"
import { environmentFurniture, environmentTiles, wallTiles } from "../../../script/office-art/environment"

test("original environment sheets cover every authored prop and six distinct 32px floors", () => {
  const floors = environmentTiles()
  const walls = wallTiles()
  const furniture = environmentFurniture()
  expect(floors.width).toBe(6 * 32)
  expect(floors.height).toBe(32)
  expect(walls.width).toBe(4 * 32)
  expect(walls.height).toBe(32)
  expect(new Set<string>(props.map((prop) => prop.kind))).toEqual(new Set(Object.keys(furniture)))
  for (const [kind, image] of Object.entries(furniture)) {
    expect(image.width).toBeGreaterThanOrEqual(32)
    expect(image.height).toBeGreaterThanOrEqual(32)
    const colors = new Set<string>()
    for (let index = 0; index < image.pixels.length; index += 4) {
      if (image.pixels[index + 3] === 0) continue
      colors.add(`${image.pixels[index]},${image.pixels[index + 1]},${image.pixels[index + 2]},${image.pixels[index + 3]}`)
    }
    expect(colors.size, kind).toBeGreaterThanOrEqual(5)
  }
})

test("the research stripe tile does not inherit QA diamond pixels from its neighbor", () => {
  const tiles = environmentTiles()
  const contains = (frame: number, rgb: readonly number[]) => {
    for (let y = 0; y < 32; y++) for (let x = frame * 32; x < frame * 32 + 32; x++) {
      const at = (y * tiles.width + x) * 4
      if (rgb.every((value, channel) => tiles.pixels[at + channel] === value)) return true
    }
    return false
  }
  expect(contains(2, [248, 244, 250])).toBe(false)
  expect(contains(3, [248, 244, 250])).toBe(true)
})

test("meeting tiles read cool, lounge planks read warm, and lounge seating has distinct hues", () => {
  const tiles = environmentTiles()
  const average = (frame: number, channel: number) => Array.from({ length: 32 * 32 }, (_, index) => tiles.pixels[((Math.floor(index / 32) * tiles.width) + frame * 32 + index % 32) * 4 + channel]!).reduce((sum, value) => sum + value, 0) / (32 * 32)
  expect(average(4, 2)).toBeGreaterThan(average(4, 0))
  expect(average(5, 0) - average(5, 2)).toBeGreaterThan(20)
  const furniture: Record<string, { readonly width: number; readonly pixels: Uint8Array }> = environmentFurniture()
  const channel = (kind: string, x: number, y: number, color: number) => {
    const image = furniture[kind]
    return image ? image.pixels[(y * image.width + x) * 4 + color] ?? 0 : 0
  }
  expect(channel("sofaPeach", 80, 20, 0)).toBeGreaterThan(channel("sofaPeach", 80, 20, 2))
  expect(channel("sofaOrange", 80, 20, 0)).toBeGreaterThan(channel("sofaOrange", 80, 20, 2))
  expect(channel("beanBagBlue", 32, 30, 2)).toBeGreaterThan(channel("beanBagBlue", 32, 30, 0))
  expect(channel("beanBagPink", 32, 30, 0)).toBeGreaterThan(channel("beanBagPink", 32, 30, 2))
  expect(furniture.sofaPeach?.pixels).not.toEqual(furniture.sofaOrange?.pixels)
})
