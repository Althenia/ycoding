import { describe, expect, test } from "bun:test"
import {
  characterAppearances,
  characterColumnCount,
  characterDirections,
  characterFeet,
  characterFrameHeight,
  characterFrameWidth,
} from "./sprites"
import { characterSheet } from "../../../script/office-art/characters"

function frameBytes(pixels: Uint8Array, sheetWidth: number, x: number, y: number, width: number, height: number) {
  const frame = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    frame.set(pixels.subarray(((y + row) * sheetWidth + x) * 4, ((y + row) * sheetWidth + x + width) * 4), row * width * 4)
  }
  return frame
}

describe("Office character art", () => {
  test("has the frozen atlas dimensions and opaque content in each frame", () => {
    const sheet = characterSheet()
    expect(sheet.width).toBe(characterFrameWidth * characterColumnCount)
    expect(sheet.height).toBe(characterFrameHeight * characterAppearances * characterDirections.length)
    expect(sheet.pixels.length).toBe(sheet.width * sheet.height * 4)
    for (let appearance = 0; appearance < characterAppearances; appearance++) {
      for (let direction = 0; direction < characterDirections.length; direction++) {
        for (let column = 0; column < characterColumnCount; column++) {
          const frame = frameBytes(sheet.pixels, sheet.width, column * characterFrameWidth, (appearance * characterDirections.length + direction) * characterFrameHeight, characterFrameWidth, characterFrameHeight)
          expect(frame.some((_, index) => index % 4 === 3 && frame[index] === 255)).toBe(true)
          if (column > 5 && column !== 11) continue
          expect([43, 44, 45, 46].some((row) => [characterFeet.x - 2, characterFeet.x, characterFeet.x + 2].some((x) => frame[(row * characterFrameWidth + x) * 4 + 3] === 255))).toBe(true)
        }
      }
    }
  })

  test("twelve down-facing appearances differ, and walking changes the stance", () => {
    const sheet = characterSheet()
    const at = (appearance: number, direction: number, column: number) => frameBytes(sheet.pixels, sheet.width, column * characterFrameWidth, (appearance * characterDirections.length + direction) * characterFrameHeight, characterFrameWidth, characterFrameHeight)
    const signatures = Array.from({ length: characterAppearances }, (_, appearance) => Buffer.from(at(appearance, 0, 0)).toString("base64"))
    expect(new Set(signatures).size).toBe(characterAppearances)
    for (let appearance = 0; appearance < characterAppearances; appearance++) {
      for (let direction = 0; direction < characterDirections.length; direction++) {
        const stand = at(appearance, direction, 0)
        for (const column of [2, 3, 4, 5]) expect(at(appearance, direction, column)).not.toEqual(stand)
        expect(at(appearance, direction, 6)).not.toEqual(at(appearance, direction, 7))
        expect(at(appearance, direction, 8)).not.toEqual(stand)
        expect(at(appearance, direction, 9)).not.toEqual(at(appearance, direction, 10))
        expect(at(appearance, direction, 11)).not.toEqual(stand)
        expect(stand[3]).toBe(0)
      }
    }
  })

  test("repeated generation produces the same byte stream", () => {
    expect(characterSheet().pixels).toEqual(characterSheet().pixels)
  })

  test("side profiles narrow the torso, stride, and sit facing sideways", () => {
    const sheet = characterSheet()
    const at = (direction: number, column: number) => frameBytes(sheet.pixels, sheet.width, column * characterFrameWidth, direction * characterFrameHeight, characterFrameWidth, characterFrameHeight)
    const span = (frame: Uint8Array, y: number) => {
      const xs = Array.from({ length: characterFrameWidth }, (_, x) => x).filter((x) => frame[(y * characterFrameWidth + x) * 4 + 3] !== 0)
      return Math.max(...xs) - Math.min(...xs) + 1
    }
    const down = at(0, 0)
    for (const direction of [1, 2]) {
      const stand = at(direction, 0)
      expect(span(stand, 30)).toBeLessThan(span(down, 30) - 3)
      const walk = [2, 3, 4, 5].map((column) => at(direction, column))
      expect(Math.max(...walk.map((frame) => span(frame, 43)))).toBeGreaterThan(span(stand, 43) + 3)
      expect(span(at(direction, 8), 38)).toBeGreaterThan(span(stand, 38) + 3)
    }
  })

  test("raised hand stays inside frame just above the head", () => {
    const sheet = characterSheet()
    const wave = frameBytes(sheet.pixels, sheet.width, 11 * characterFrameWidth, 0, characterFrameWidth, characterFrameHeight)
    const clearAboveHand = Array.from({ length: 4 }, (_, y) => Array.from({ length: 8 }, (_, x) => wave[(y * characterFrameWidth + x + 22) * 4 + 3]).every((alpha) => alpha === 0))
    expect(clearAboveHand).toEqual([true, true, true, true])
    const visibleHand = Array.from({ length: 7 }, (_, y) => wave[((y + 6) * characterFrameWidth + 25) * 4 + 3]).some((alpha) => alpha === 255)
    expect(visibleHand).toBe(true)
  })
})
