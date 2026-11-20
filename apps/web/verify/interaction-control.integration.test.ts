import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer, type ViteDevServer } from "vite"
import { launchBrowser, type Page } from "./cdp"

const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME to the repository-provisioned Chrome for Testing executable.")
let server: ViteDevServer | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let origin: string
const first = "cf3aa01e-85ca-42fd-af3a-dd706075cb34"
const second = "b6559809-6be6-4483-a5a1-5c6046cdfd7b"
const pixels = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const status = `[aria-label="Interaction control"]`
const preview = `[aria-label="Interaction preview"]`
const stop = `button[aria-label="Stop interaction"]`
const reveal = `button[aria-label="Show interaction preview"]`

beforeAll(async () => {
  server = await createServer({ root: new URL("..", import.meta.url).pathname, server: { host: "127.0.0.1", port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string") throw new Error("The verification server did not open a port")
  origin = `http://127.0.0.1:${address.port}`
  browser = await launchBrowser(chrome, 1440, 900)
}, 30_000)

afterAll(async () => { await browser?.close(); await server?.close() })

async function wait(page: Page, condition: string) {
  await page.evaluate(`new Promise((resolve, reject) => { const until = performance.now() + 4000; const check = () => { if (${condition}) return resolve(true); if (performance.now() >= until) return reject(new Error(${JSON.stringify(condition)})); requestAnimationFrame(check); }; check(); })`)
}

function text(selector: string, content: string) {
  return `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(content)})`
}

function click(page: Page, selector: string) {
  return page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}

const stopReachable = `(() => { const stop = document.querySelector(${JSON.stringify(stop)}); const box = stop.getBoundingClientRect(); return box.height >= 24 && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2).closest('button') === stop; })()`

async function open(width: number) {
  const page = await browser!.openPage()
  await page.setViewport(width, 900)
  await page.navigate(`${origin}/verify/remote.html?interaction=1`)
  return page
}

test("Interaction status distinguishes unavailable and pending and stops pending consent once", async () => {
  const page = await open(1440)
  try {
    await wait(page, text(status, "Interaction unavailable"))
    await page.evaluate(`interactionFixture.change({ state: 'pending', platform: 'chrome', generation: ${JSON.stringify(first)} })`)
    await wait(page, text(status, "Chrome control · Awaiting local approval"))
    expect(await page.evaluate(`Array.from(document.querySelector(${JSON.stringify(status)}).querySelectorAll('button'), button => button.getAttribute('aria-label'))`)).toEqual(["Stop interaction"])
    await page.evaluate(`const stop = document.querySelector(${JSON.stringify(stop)}); stop.click(); stop.click()`)
    await wait(page, text(status, "Cleanup pending"))
    expect(await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.stop').map(call => call.input)`)).toEqual([{ generation: first }])
    expect(await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.preview')`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Interaction preview is revealed in Activity, discards the prior generation, and Stop settles once", async () => {
  const page = await open(1440)
  try {
    await wait(page, text(status, "Interaction unavailable"))
    await page.evaluate(`interactionFixture.change({ state: 'active', platform: 'chrome', label: 'Synthetic tab one', generation: ${JSON.stringify(first)} })`)
    await wait(page, text(status, "Synthetic tab one"))
    expect(await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.preview')`)).toEqual([])
    await page.evaluate(`interactionFixture.holdPreview(); document.querySelector(${JSON.stringify(reveal)}).focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `requestLog.some(call => call.operation === 'session.interaction.preview' && call.input.generation === ${JSON.stringify(first)})`)
    expect(await page.evaluate(`document.activeElement.closest(${JSON.stringify(status)}) !== null`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('[aria-label="Session companion"] ${preview}') !== null`)).toBe(true)
    await page.evaluate(`interactionFixture.change({ state: 'active', platform: 'chrome', label: 'Synthetic tab two', generation: ${JSON.stringify(second)} }); interactionFixture.releasePreview({ state: 'ready', generation: ${JSON.stringify(first)}, frame: { mimeType: 'image/png', base64: ${JSON.stringify(pixels)}, width: 1, height: 1 } })`)
    await wait(page, text(status, "Synthetic tab two"))
    expect(await page.evaluate(`document.querySelectorAll(${JSON.stringify(`${preview} img`)}).length`)).toBe(0)
    await wait(page, text(preview, "Preview withheld"))
    expect(await page.evaluate(stopReachable)).toBe(true)
    await page.evaluate(`const stop = document.querySelector(${JSON.stringify(stop)}); stop.click(); stop.click()`)
    await wait(page, text(status, "Cleanup pending"))
    expect(await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.stop').map(call => call.input)`)).toEqual([{ generation: second }])
    expect(await page.evaluate(`document.querySelectorAll(${JSON.stringify(preview)}).length`)).toBe(0)
    await page.evaluate(`interactionFixture.change({ state: 'stopped', platform: 'chrome', generation: ${JSON.stringify(second)}, reason: 'stopped', cleanup: 'complete' })`)
    await wait(page, text(status, "Cleanup complete"))
  } finally { await page.close() }
}, 30_000)

test("Interaction preview on a narrow run has one image and keeps the named Stop in the run", async () => {
  const page = await open(390)
  try {
    await wait(page, text(status, "Interaction unavailable"))
    await page.evaluate(`interactionFixture.change({ state: 'active', platform: 'chrome', label: 'Synthetic tab', generation: ${JSON.stringify(first)} }); interactionFixture.holdPreview()`)
    await wait(page, text(status, "Synthetic tab"))
    await click(page, reveal)
    await wait(page, `requestLog.some(call => call.operation === 'session.interaction.preview')`)
    await page.evaluate(`interactionFixture.releasePreview({ state: 'ready', generation: ${JSON.stringify(first)}, frame: { mimeType: 'image/png', base64: ${JSON.stringify(pixels)}, width: 1, height: 1 } })`)
    await wait(page, `document.querySelector(${JSON.stringify(`${preview} img`)})?.naturalWidth === 1`)
    expect(await page.evaluate(`({ frames: document.querySelectorAll(${JSON.stringify(`${preview} img`)}).length, inRun: !!document.querySelector(${JSON.stringify(`${status} ${preview}`)}), stop: !!document.querySelector(${JSON.stringify(`${status} ${stop}`)}), fits: document.documentElement.scrollWidth <= innerWidth })`)).toEqual({ frames: 1, inRun: true, stop: true, fits: true })
    expect(await page.evaluate(stopReachable)).toBe(true)
    await page.evaluate(`interactionFixture.holdPreview(); interactionFixture.change({ state: 'active', platform: 'chrome', label: 'Synthetic tab', generation: ${JSON.stringify(first)} })`)
    await wait(page, `requestLog.filter(call => call.operation === 'session.interaction.preview').length === 2`)
    await page.evaluate(`interactionFixture.releasePreview({ state: 'ready', generation: ${JSON.stringify(first)}, frame: { mimeType: 'image/png', base64: ${JSON.stringify(pixels)}, width: 961, height: 1 } })`)
    await wait(page, text(preview, "Preview withheld"))
    expect(await page.evaluate(`document.querySelectorAll(${JSON.stringify(`${preview} img`)}).length`)).toBe(0)
    await page.evaluate(`interactionFixture.holdPreview(); interactionFixture.change({ state: 'active', platform: 'chrome', label: 'Synthetic tab', generation: ${JSON.stringify(first)} })`)
    await wait(page, `requestLog.filter(call => call.operation === 'session.interaction.preview').length === 3`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Simulate disconnect and reconnect')).click(); interactionFixture.releasePreview({ state: 'ready', generation: ${JSON.stringify(first)}, frame: { mimeType: 'image/png', base64: ${JSON.stringify(pixels)}, width: 1, height: 1 } })`)
    await wait(page, `document.querySelector(${JSON.stringify(reveal)}) !== null && document.querySelector(${JSON.stringify(preview)}) === null`)
    expect(await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.preview').length`)).toBe(3)
  } finally { await page.close() }
}, 30_000)
