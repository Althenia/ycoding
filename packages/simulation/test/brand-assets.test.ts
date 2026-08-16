import { expect, test } from "bun:test"
import { loadImage } from "@napi-rs/canvas"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const brand = path.join(root, "assets", "brand")

test("YCoding brand sources match the Penpot geometry and palette", async () => {
  const mark = await Bun.file(path.join(brand, "ycoding-mark.svg")).text()
  const mono = await Bun.file(path.join(brand, "ycoding-mark-mono.svg")).text()
  const icon = await Bun.file(path.join(brand, "ycoding-icon.svg")).text()
  const wordmark = await Bun.file(path.join(brand, "ycoding-wordmark.svg")).text()

  expect(mark).toContain('viewBox="0 0 256 256"')
  expect(mark).toContain("#67D7A4")
  expect(mark).toContain("#F2F3F5")
  expect(mark).toContain("#F0BE62")
  expect(mark).not.toContain("#24282F")
  expect(mono).toContain('fill="#F2F3F5"')
  expect(icon).toContain('rx="48"')
  expect(icon).toContain("#24282F")
  expect(wordmark).toContain(">YCoding</text>")
  expect(wordmark).toContain("terminal coding agent")
})

test("generated YCoding PNG assets have exact dimensions", async () => {
  for (const [name, size] of [
    ["ycoding-mark-256.png", 256],
    ["ycoding-mark-512.png", 512],
    ["ycoding-icon-256.png", 256],
    ["ycoding-icon-512.png", 512],
  ] as const) {
    const image = await loadImage(path.join(brand, name))
    expect(image.width).toBe(size)
    expect(image.height).toBe(size)
  }
})
