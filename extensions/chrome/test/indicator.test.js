import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FAVICON_SVG, FONT_ALIAS, LABELS, markerScript, timing, tokens } from "../indicator.js"
import { createFakePage } from "./fixtures/fake-page.js"

test("the page expiry outlasts several missed refreshes and is checked more often than it is refreshed", () => {
  expect(timing.expiry).toBeGreaterThanOrEqual(3 * timing.refresh)
  expect(timing.check).toBeLessThan(timing.refresh)
  expect(timing.clear).toBeLessThan(timing.mark)
})

test("offers only the Click, Type, Scroll, Hover, and Select cursor labels", () => {
  expect(LABELS).toEqual({ click: "Click", type: "Type", scroll: "Scroll", hover: "Hover", select: "Select" })
})

test("the favicon marker is the canonical mint pixel-Y geometry on a dark tile", async () => {
  const asset = await Bun.file(new URL("../../../assets/brand/ycoding-mark.svg", import.meta.url)).text()
  const geometry = /<path d="([^"]+)"/.exec(asset)?.[1]
  expect(FAVICON_SVG).toContain(geometry)
  expect(FAVICON_SVG).toContain("#67D7A4")
  expect(tokens.colors["agent-mark"]).toBe("#67d7a4")
})

describe("the favicon logo marker", () => {
  test("mark swaps the page favicon for the logo data URL and leaves the title untouched", async () => {
    const page = createFakePage()
    page.setPageTitle("Example page")
    page.setPageIcon("https://example.test/favicon.ico")
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true, font: false })
    const links = page.iconLinks()
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toStartWith("data:image/svg+xml,")
    expect(decodeURIComponent(links[0].getAttribute("href"))).toContain("#67D7A4")
    expect(page.document.title).toBe("Example page")
  })

  test("clear and expiry each restore the page-authored favicon", async () => {
    const clearing = createFakePage()
    clearing.setPageIcon("/site.png")
    await clearing.evaluate(markerScript("mark"))
    await clearing.evaluate(markerScript("clear"))
    expect(clearing.iconLinks().map((node) => node.getAttribute("href"))).toEqual(["/site.png"])

    const expiring = createFakePage()
    expiring.setPageIcon("/site.png")
    await expiring.evaluate(markerScript("mark"))
    expiring.clock.advance(timing.expiry + timing.check)
    expect(expiring.iconLinks().map((node) => node.getAttribute("href"))).toEqual(["/site.png"])
    expect(expiring.markers()).toHaveLength(0)
  })

  test("a page favicon change while marked is re-asserted and becomes the restore target", async () => {
    const page = createFakePage()
    page.setPageIcon("/old.png")
    await page.evaluate(markerScript("mark"))
    page.setPageIcon("/new.png")
    await Bun.sleep(2)
    const links = page.iconLinks()
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toStartWith("data:image/svg+xml,")
    await page.evaluate(markerScript("clear"))
    expect(page.iconLinks().map((node) => node.getAttribute("href"))).toEqual(["/new.png"])
  })

  test("a favicon the page policy blocks fails the mark closed and leaves the page icons untouched", async () => {
    const page = createFakePage()
    page.setPageTitle("Strict page")
    page.setPageIcon("/site.png")
    page.faviconBlocked = true
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: false })
    expect(page.iconLinks().map((node) => node.getAttribute("href"))).toEqual(["/site.png"])
    expect(page.markers()).toHaveLength(0)
    expect(page.hosts()).toHaveLength(0)
    expect(page.document.title).toBe("Strict page")
    page.faviconBlocked = false
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true, font: false })
    expect(page.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
  })

  test("a page without any favicon ends with none after clear", async () => {
    const page = createFakePage()
    await page.evaluate(markerScript("mark"))
    expect(page.iconLinks()).toHaveLength(1)
    await page.evaluate(markerScript("clear"))
    expect(page.iconLinks()).toEqual([])
  })
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

test("the cursor label chip draws the mint pixel-Y brand mark inline before its words", async () => {
  const asset = await Bun.file(new URL("../../../assets/brand/ycoding-mark.svg", import.meta.url)).text()
  const page = createFakePage()
  await page.evaluate(markerScript("mark", cursor))
  const walk = (node) => [node, ...node.children.flatMap(walk), ...(node.shadow ? walk(node.shadow) : [])]
  const chip = walk(page.hosts()[0]).find((node) => node.tagName === "SPAN" && node.children.length > 0)
  const [mark, words] = chip.children
  expect(chip.children).toHaveLength(2)
  expect(mark.tagName).toBe("SVG")
  expect(mark.attributes.get("viewBox")).toBe("0 0 256 256")
  expect(mark.attributes.get("width")).toBe(String(parseInt(tokens.components["agent-mark"].size)))
  expect(mark.attributes.get("height")).toBe(String(parseInt(tokens.components["agent-mark"].size)))
  expect(mark.attributes.get("aria-hidden")).toBe("true")
  expect(mark.children.map((path) => [path.tagName, path.attributes.get("d"), path.attributes.get("fill")])).toEqual([
    ["PATH", /<path d="([^"]+)"/.exec(asset)?.[1], tokens.colors["agent-mark"]],
  ])
  expect(words.tagName).toBe("SPAN")
  expect(words.textContent).toBe("YCoding · Click")
  expect(chip.style.cssText).toContain(`gap:${tokens.components["agent-label"].gap}`)
})

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
    expect(page.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
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
