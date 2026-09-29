import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TITLE_PREFIX, markerScript, timing } from "../indicator.js"
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
    for (const op of ["mark", "clear"]) {
      const script = bundled.markerScript(op)
      expect(script).not.toMatch(helpers)
      const page = createFakePage()
      expect(await page.evaluate(script)).toEqual({ ok: true })
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
