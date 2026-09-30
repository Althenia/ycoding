import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FONT_ALIAS, TITLE_PREFIX, markerScript, timing, tokens } from "../indicator.js"
import { createFakePage } from "./fixtures/fake-page.js"

test("the page expiry outlasts several missed refreshes and is checked more often than it is refreshed", () => {
  expect(timing.expiry).toBeGreaterThanOrEqual(3 * timing.refresh)
  expect(timing.check).toBeLessThan(timing.refresh)
  expect(timing.clear).toBeLessThan(timing.mark)
})

test("the title marker is a fixed ASCII prefix that ends with one separating space", () => {
  expect(TITLE_PREFIX).toBe("[YCoding] ")
})

test("the serialized marker script is self-contained and runs with only page globals", async () => {
  for (const op of ["mark", "clear"]) expect(markerScript(op)).not.toMatch(/__name|__async|__spread/)
  const page = createFakePage()
  expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true, font: false })
  expect(await page.evaluate(markerScript("clear"))).toEqual({ ok: true })
})

const indicatorPath = new URL("../indicator.js", import.meta.url).pathname
const helpers = /__name|__async|__spread|__toESM|__commonJS|__publicField/

test.each([
  ["browser", false],
  ["browser", true],
  ["node", false],
  ["bun", true],
])("a %s bundle (minified: %p) serializes a marker script that needs no bundler helpers", async (target, minify) => {
  const built = await Bun.build({ entrypoints: [indicatorPath], target, minify, format: "esm" })
  expect(built.success).toBe(true)
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-indicator-bundle-"))
  try {
    const file = path.join(directory, "indicator.mjs")
    await Bun.write(file, built.outputs[0])
    const bundled = await import(file)
    for (const [op, font, expected] of [
      ["mark", undefined, { ok: true, font: false }],
      ["mark", Buffer.from("wOF2-test-payload").toString("base64"), { ok: true, font: true }],
      ["clear", undefined, { ok: true }],
    ]) {
      const script = bundled.markerScript(op, op === "mark" && font ? { x: 1, y: 2, label: "Click", click: false } : undefined, font)
      expect(script).not.toMatch(helpers)
      const page = createFakePage()
      expect(await page.evaluate(script)).toEqual(expected)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(!Bun.which("node"))("the source module serialized under Node runs with only page globals", async () => {
  const child = Bun.spawnSync(
    [
      "node",
      "--input-type=module",
      "-e",
      `import { markerScript } from ${JSON.stringify(indicatorPath)}; process.stdout.write(markerScript("mark"))`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  const script = child.stdout.toString()
  expect(script).not.toMatch(helpers)
  expect(await createFakePage().evaluate(script)).toEqual({ ok: true, font: false })
})

const fontData = Buffer.from("wOF2-test-payload").toString("base64")
const cursor = { x: 5, y: 6, label: "Click", click: false }

describe("the label font", () => {
  test("installs one page-scoped face under a unique alias when a cursor arrives with font data", async () => {
    const page = createFakePage()
    expect(await page.evaluate(markerScript("mark", cursor, fontData))).toEqual({ ok: true, font: true })
    const faces = page.fontFaces()
    expect(faces).toHaveLength(1)
    expect(faces[0].family).toBe(FONT_ALIAS)
    expect(faces[0].family).not.toBe("Geist")
    expect(Buffer.from(faces[0].source).toString()).toBe("wOF2-test-payload")
    expect(faces[0].descriptors).toEqual({ weight: "100 900", style: "normal", display: "swap" })
    expect(tokens.typography["agent-label"].fontFamily.startsWith(`${FONT_ALIAS},`)).toBe(true)
    await page.evaluate(markerScript("mark", { ...cursor, x: 9 }, fontData))
    await page.evaluate(markerScript("mark", { ...cursor, x: 10 }))
    expect(page.fontFaces()).toHaveLength(1)
    expect(page.fontLoads).toHaveLength(1)
  })

  test("a refresh without a cursor neither carries nor installs the font", async () => {
    const page = createFakePage()
    expect(markerScript("mark")).not.toContain(fontData)
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true, font: false })
    expect(page.fontFaces()).toEqual([])
  })

  test("explicit clear, page removal of the marker, and expiry each remove the face", async () => {
    const clearing = createFakePage()
    await clearing.evaluate(markerScript("mark", cursor, fontData))
    await clearing.evaluate(markerScript("clear"))
    expect(clearing.fontFaces()).toEqual([])

    const removed = createFakePage()
    await removed.evaluate(markerScript("mark", cursor, fontData))
    removed.markers()[0].remove()
    await Bun.sleep(2)
    expect(removed.fontFaces()).toEqual([])

    const expiring = createFakePage()
    await expiring.evaluate(markerScript("mark", cursor, fontData))
    expiring.clock.advance(timing.expiry + timing.check)
    expect(expiring.fontFaces()).toEqual([])
    expect(expiring.markers()).toHaveLength(0)
  })

  test("a face belongs to its document, so a navigation drops it and the next cursor installs it again", async () => {
    const page = createFakePage()
    await page.evaluate(markerScript("mark", cursor, fontData))
    page.navigate()
    expect(page.fontFaces()).toEqual([])
    expect(await page.evaluate(markerScript("mark", cursor, fontData))).toEqual({ ok: true, font: true })
    expect(page.fontFaces()).toHaveLength(1)
  })

  test.each([
    ["a face that fails to decode", (page) => (page.fontLoadFails = true)],
    ["a page without the FontFace API", (page) => (page.fontFaceMissing = true)],
  ])("%s still draws the label, marks the tab, and reports no font", async (_name, arrange) => {
    const page = createFakePage()
    arrange(page)
    expect(await page.evaluate(markerScript("mark", cursor, fontData))).toEqual({ ok: true, font: false })
    expect(page.fontFaces()).toEqual([])
    expect(page.chipText()).toEqual(["YCoding · Click"])
    expect(page.document.title.startsWith(TITLE_PREFIX.trim())).toBe(true)
  })

  describe("while the face is still loading", () => {
    const settles = (promise) => Promise.race([promise.then(() => true), Bun.sleep(100).then(() => false)])

    test("the cursor and label are drawn with the fallback without waiting, and the ack reports the face as not loaded", async () => {
      const page = createFakePage()
      page.fontLoadDeferred = true
      const marking = page.evaluate(markerScript("mark", cursor, fontData))
      expect(await settles(marking)).toBe(true)
      expect(await marking).toEqual({ ok: true, font: false })
      expect(page.chipText()).toEqual(["YCoding · Click"])
      expect(page.fontFaces().map((face) => [face.family, face.status])).toEqual([[FONT_ALIAS, "loading"]])
      await page.evaluate(markerScript("mark", { ...cursor, x: 9 }, fontData))
      expect(page.fontFaces()).toHaveLength(1)
      page.settleFonts("resolve")
      expect(await page.evaluate(markerScript("mark", { ...cursor, x: 10 }))).toEqual({ ok: true, font: true })
      expect(page.fontFaces().map((face) => face.status)).toEqual(["loaded"])
    })

    test.each([
      ["an explicit clear", async (page) => void (await page.evaluate(markerScript("clear")))],
      ["the page removing the marker", async (page) => {
        page.markers()[0].remove()
        await Bun.sleep(2)
      }],
      ["the page expiry", async (page) => page.clock.advance(timing.expiry + timing.check)],
    ])("%s leaves neither the face nor a cursor behind when the load settles afterwards", async (_name, end) => {
      const page = createFakePage()
      page.fontLoadDeferred = true
      await settlesThenMark(page)
      await end(page)
      expect(page.fontFaces()).toEqual([])
      page.settleFonts("resolve")
      await Bun.sleep(2)
      expect(page.fontFaces()).toEqual([])
      expect(page.hosts()).toHaveLength(0)
      expect(page.markers()).toHaveLength(0)
    })

    test("a load that fails after registration removes only its own face", async () => {
      const page = createFakePage()
      page.fontLoadDeferred = true
      const own = { family: "Geist", status: "loaded" }
      page.document.fonts.add(own)
      await settlesThenMark(page)
      page.settleFonts("reject")
      await Bun.sleep(2)
      expect(page.fontFaces()).toEqual([own])
      expect(page.chipText()).toEqual(["YCoding · Click"])
    })

    async function settlesThenMark(page) {
      const marking = page.evaluate(markerScript("mark", cursor, fontData))
      expect(await settles(marking)).toBe(true)
    }
  })

  test("the page's own face with another name is never removed", async () => {
    const page = createFakePage()
    const own = { family: "Geist", status: "loaded" }
    page.document.fonts.add(own)
    await page.evaluate(markerScript("mark", cursor, fontData))
    await page.evaluate(markerScript("clear"))
    expect(page.fontFaces()).toEqual([own])
  })
})
