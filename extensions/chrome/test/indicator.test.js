import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FAVICON_SVG, markerScript, timing, tokens } from "../indicator.js"
import { createFakePage } from "./fixtures/fake-page.js"

test("the page expiry outlasts several missed refreshes and is checked more often than it is refreshed", () => {
  expect(timing.expiry).toBeGreaterThanOrEqual(3 * timing.refresh)
  expect(timing.check).toBeLessThan(timing.refresh)
  expect(timing.clear).toBeLessThan(timing.mark)
})

test("the marker script takes only the operation and carries no cursor, label, ripple, or font payload", () => {
  expect(markerScript.length).toBe(1)
  for (const op of ["mark", "clear"]) expect(markerScript(op)).not.toMatch(/"cursor"|"fontData"|"fontFamily"|"ripple"|attachShadow|requestAnimationFrame|YCoding ·/)
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
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true })
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
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true })
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
  expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true })
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
    for (const [op, expected] of [
      ["mark", { ok: true }],
      ["clear", { ok: true }],
    ]) {
      const script = bundled.markerScript(op)
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
  expect(await createFakePage().evaluate(script)).toEqual({ ok: true })
})

describe("the marker never draws in the page", () => {
  const ownFace = { family: "Geist", status: "loaded" }
  const drawn = (page) => ({
    hosts: page.hosts().length,
    chipText: page.chipText(),
    animations: page.animations.length,
    moves: page.moves.length,
    frameRequests: page.frameRequests,
    faces: page.fontFaces().filter((face) => face !== ownFace),
    text: page.domText().includes("YCoding ·"),
  })
  const none = { hosts: 0, chipText: [], animations: 0, moves: 0, frameRequests: 0, faces: [], text: false }

  test("mark adds the favicon marker only: no cursor host, label, ripple, animation frame, or page font", async () => {
    const page = createFakePage()
    page.document.fonts.add(ownFace)
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true })
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true })
    expect(page.markers()).toHaveLength(1)
    expect(page.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
    expect(drawn(page)).toEqual(none)
    expect(page.fontFaces()).toEqual([ownFace])
  })

  test("clear, page removal of the marker, and expiry each leave the page without drawn elements and keep the page's own font face", async () => {
    const clearing = createFakePage()
    clearing.document.fonts.add(ownFace)
    await clearing.evaluate(markerScript("mark"))
    await clearing.evaluate(markerScript("clear"))
    expect(drawn(clearing)).toEqual(none)
    expect(clearing.fontFaces()).toEqual([ownFace])

    const removed = createFakePage()
    await removed.evaluate(markerScript("mark"))
    removed.markers()[0].remove()
    await Bun.sleep(2)
    expect(removed.markers()).toHaveLength(0)
    expect(drawn(removed)).toEqual(none)

    const expiring = createFakePage()
    await expiring.evaluate(markerScript("mark"))
    expiring.clock.advance(timing.expiry + timing.check)
    expect(expiring.markers()).toHaveLength(0)
    expect(drawn(expiring)).toEqual(none)
  })

  test("a navigation drops the marker and the next mark again draws nothing", async () => {
    const page = createFakePage()
    await page.evaluate(markerScript("mark"))
    page.navigate()
    expect(page.markers()).toHaveLength(0)
    expect(await page.evaluate(markerScript("mark"))).toEqual({ ok: true })
    expect(page.markers()).toHaveLength(1)
    expect(drawn(page)).toEqual(none)
  })
})
