import { expect, test } from "bun:test"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const brand = path.join(root, "assets", "brand")

test("Meeting launcher PNGs derive from the branded microphone rather than the browser Y", async () => {
  const source = await Bun.file(path.join(brand, "ycoding-meeting-icon.svg")).text()
  expect([...new Set(source.match(/#[0-9A-F]{6}/g))].sort()).toEqual(["#24282F", "#3A404A", "#67D7A4", "#F2F3F5"])
  const image = await loadImage(Buffer.from(source))
  for (const size of [16, 32, 48, 128]) {
    const raster = await loadImage(path.join(brand, `ycoding-meeting-${size}.png`))
    expect([raster.width, raster.height]).toEqual([size, size])
    const expected = createCanvas(size, size)
    expected.getContext("2d").drawImage(image, 0, 0, size, size)
    const actual = createCanvas(size, size)
    const context = actual.getContext("2d")
    context.drawImage(raster, 0, 0)
    expect(context.getImageData(0, 0, size, size).data).toEqual(
      expected.getContext("2d").getImageData(0, 0, size, size).data,
    )
    const browser = await Bun.file(path.join(root, `extensions/chrome/icons/ycoding-${size}.png`)).arrayBuffer()
    expect(
      Buffer.from(await Bun.file(path.join(brand, `ycoding-meeting-${size}.png`)).arrayBuffer()).equals(
        Buffer.from(browser),
      ),
    ).toBe(false)
    const capsule = Array.from(context.getImageData(size / 2, size / 4, 1, 1).data)
    expect(capsule).toEqual([0x67, 0xd7, 0xa4, 255])
    const stand = Array.from(context.getImageData(size / 2, size * 0.75, 1, 1).data)
    expect(stand.slice(0, 3).every((channel) => channel >= 180)).toBe(true)
  }
})

test("YCoding brand sources match the Penpot geometry and palette", async () => {
  const mark = await Bun.file(path.join(brand, "ycoding-mark.svg")).text()
  const mono = await Bun.file(path.join(brand, "ycoding-mark-mono.svg")).text()
  const icon = await Bun.file(path.join(brand, "ycoding-icon.svg")).text()
  const wordmark = await Bun.file(path.join(brand, "ycoding-wordmark.svg")).text()

  expect(mark).toContain('viewBox="0 0 256 256"')
  expect(mark).toContain("#67D7A4")
  expect(mark).not.toContain("#24282F")
  expect(mono).toContain('fill="#F2F3F5"')
  expect(icon).toContain('rx="48"')
  expect(icon).toContain("#24282F")
  expect(icon).toContain("#F2F3F5")
  expect(icon).toContain("#F0BE62")
  expect(wordmark).toContain(">YCoding</text>")
  expect(wordmark).toContain("terminal coding agent")
})

test("the maskable icon fills its canvas and keeps the mark inside the maskable safe zone", async () => {
  const image = await loadImage(path.join(brand, "ycoding-icon-maskable-512.png"))
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext("2d")
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height).data
  const center = image.width / 2
  const safeRadius = image.width * 0.4
  const background = [0x24, 0x28, 0x2f]
  const offsets = Array.from({ length: image.width * image.height }, (_, index) => index)
  const transparent = offsets.filter((index) => pixels[index * 4 + 3] < 255).length
  const mark = offsets.filter((index) =>
    background.some((value, offset) => Math.abs(pixels[index * 4 + offset] - value) > 8),
  )
  const markOutsideSafeZone = mark.filter(
    (index) =>
      Math.hypot((index % image.width) + 0.5 - center, Math.floor(index / image.width) + 0.5 - center) > safeRadius,
  ).length
  const columns = mark.map((index) => index % image.width)
  const rows = mark.map((index) => Math.floor(index / image.width))
  expect({ transparent, markOutsideSafeZone }).toEqual({ transparent: 0, markOutsideSafeZone: 0 })
  expect(Math.max(...columns) - Math.min(...columns)).toBeGreaterThanOrEqual(image.width * 0.4)
  expect(Math.max(...rows) - Math.min(...rows)).toBeGreaterThanOrEqual(image.height * 0.4)
})

test("the app icon keeps a small, even margin around the Y mark", async () => {
  const image = await loadImage(path.join(brand, "ycoding-icon-512.png"))
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext("2d")
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height).data
  const markColors = [
    [0x67, 0xd7, 0xa4],
    [0xf2, 0xf3, 0xf5],
    [0xf0, 0xbe, 0x62],
  ]
  const mark = Array.from({ length: image.width * image.height }, (_, index) => index).filter((index) => {
    const offset = index * 4
    return markColors.some(
      (color) => Math.hypot(...color.map((value, channel) => pixels[offset + channel] - value)) < 60,
    )
  })
  const columns = mark.map((index) => index % image.width)
  const rows = mark.map((index) => Math.floor(index / image.width))
  const margins = [
    Math.min(...columns) / image.width,
    Math.min(...rows) / image.height,
    (image.width - 1 - Math.max(...columns)) / image.width,
    (image.height - 1 - Math.max(...rows)) / image.height,
  ]

  expect(margins.every((margin) => margin >= 0.17)).toBe(true)
  expect(Math.max(...margins) - Math.min(...margins)).toBeLessThanOrEqual(0.01)
})

test("generated YCoding PNG assets have exact dimensions", async () => {
  for (const [name, size] of [
    ["ycoding-mark-256.png", 256],
    ["ycoding-mark-512.png", 512],
    ["ycoding-icon-256.png", 256],
    ["ycoding-icon-192.png", 192],
    ["ycoding-icon-512.png", 512],
    ["ycoding-icon-maskable-512.png", 512],
  ] as const) {
    const image = await loadImage(path.join(brand, name))
    expect(image.width).toBe(size)
    expect(image.height).toBe(size)
  }
})
