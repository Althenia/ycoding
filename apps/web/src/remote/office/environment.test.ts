import { expect, test } from "bun:test"
import { props } from "./map"
import { environmentFurniture, environmentTiles, wallTiles } from "../../../script/office-art/environment"

test("open-floor props use authored furniture sprites and the existing tile sheets", () => {
  const floors = environmentTiles()
  const walls = wallTiles()
  const furniture = environmentFurniture()
  expect(floors.width).toBe(9 * 32)
  expect(floors.height).toBe(32)
  expect(walls.width).toBe(4 * 32)
  expect(walls.height).toBe(32)
  expect(props.every((prop) => Object.hasOwn(furniture, prop.kind))).toBe(true)
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

test("desk variants differ in silhouette and details, not only color", () => {
  const furniture: Record<string, { readonly width: number; readonly height: number; readonly pixels: Uint8Array }> = environmentFurniture()
  const widths = (kinds: readonly string[]) => new Set(kinds.map((kind) => furniture[kind]?.width))
  expect(widths(["compactDeskCode", "developerDesk", "cornerDesk"]).size).toBe(3)
  expect(furniture.cornerReturn?.height).toBeGreaterThan(furniture.cornerReturn?.width ?? 0)
  const groups = [
    ["developerDesk", "developerDeskLamp", "developerDeskPlant"],
    ["qaDesk", "qaDeskMug"],
    ["compactDeskCode", "compactDeskChart", "compactDeskTest"],
    ["rugRound", "rugRunner", "rugMat", "rugSage", "blueRug"],
  ]
  for (const group of groups) for (const [index, first] of group.entries()) for (const second of group.slice(index + 1)) {
    expect(furniture[first]?.pixels, `${first} vs ${second}`).not.toEqual(furniture[second]?.pixels)
  }
})

test("rugs keep their native tile footprints so pixels are never stretched", () => {
  const furniture: Record<string, { readonly width: number; readonly height: number }> = environmentFurniture()
  for (const prop of props.filter((item) => item.layer === "floor")) {
    expect({ kind: prop.kind, width: furniture[prop.kind]?.width, height: furniture[prop.kind]?.height })
      .toEqual({ kind: prop.kind, width: prop.width * 32, height: prop.height * 32 })
  }
})

test("new floor frames read sage, neutral stone, and warm pantry tile", () => {
  const tiles = environmentTiles()
  const average = (frame: number, channel: number) => Array.from({ length: 32 * 32 }, (_, index) => tiles.pixels[((Math.floor(index / 32) * tiles.width) + frame * 32 + index % 32) * 4 + channel]!).reduce((sum, value) => sum + value, 0) / (32 * 32)
  expect(average(6, 1)).toBeGreaterThan(average(6, 0) + 5)
  expect(average(6, 1)).toBeGreaterThan(average(6, 2) + 10)
  expect(Math.max(average(7, 0), average(7, 1), average(7, 2)) - Math.min(average(7, 0), average(7, 1), average(7, 2))).toBeLessThan(20)
  expect(average(8, 0) - average(8, 2)).toBeGreaterThan(15)
})
