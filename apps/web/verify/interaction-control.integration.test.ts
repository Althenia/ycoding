import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer, type ViteDevServer } from "vite"
import { decodeString, launchBrowser, type Page } from "./cdp"

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
const resume = `button[aria-label="Resume interaction"]`
const reveal = `button[aria-label="Show interaction preview"]`
const detach = `button[aria-label="Open picture-in-picture"]`
const interactionCalls = `(window.requestLog ?? []).filter(call => call.operation.startsWith('session.interaction.'))`

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

test("Interaction row is hidden when unavailable or errored and adds no offset above chat", async () => {
  const baseline = await browser!.openPage()
  let baselineTop: unknown = 0
  try {
    await baseline.setViewport(1440, 900)
    await baseline.navigate(`${origin}/verify/remote.html`)
    await wait(baseline, `document.querySelector('.workspace__scroll') !== null`)
    baselineTop = await baseline.evaluate(`document.querySelector('.workspace__scroll').getBoundingClientRect().top`)
  } finally { await baseline.close() }

  const page = await open(1440)
  try {
    await wait(page, `requestLog.some(call => call.operation === 'session.interaction.status')`)
    expect(await page.evaluate(`document.querySelector(${JSON.stringify(status)})`)).toBeNull()
    expect(await page.evaluate(`document.body.textContent.includes('Interaction unavailable') || document.body.textContent.includes('Interaction status unavailable')`)).toBe(false)
    expect(await page.evaluate(`document.querySelector('.workspace__scroll').getBoundingClientRect().top`)).toBe(baselineTop)

    await page.evaluate(`interactionFixture.change({ invalid: true, generation: ${JSON.stringify(first)} })`)
    await wait(page, `requestLog.filter(call => call.operation === 'session.interaction.status').length >= 2 && document.querySelector(${JSON.stringify(status)}) === null`)
    expect(await page.evaluate(`document.body.textContent.includes('Interaction status unavailable')`)).toBe(false)
    expect(await page.evaluate(`document.querySelector('.workspace__scroll').getBoundingClientRect().top`)).toBe(baselineTop)

    const beforeRefresh = await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.status').length`)
    await click(page, `button[aria-label="Open command palette"]`)
    await wait(page, `document.body.textContent.includes('Refresh interaction status')`)
    await page.evaluate(`Array.from(document.querySelectorAll('dialog button, [role="dialog"] button, [role="option"]')).find(el => el.textContent.includes('Refresh interaction status')).click()`)
    await wait(page, `requestLog.filter(call => call.operation === 'session.interaction.status').length > ${String(beforeRefresh)}`)
  } finally { await page.close() }
}, 30_000)

test("Interaction status distinguishes pending and stops pending consent once", async () => {
  const page = await open(1440)
  try {
    await wait(page, `requestLog.some(call => call.operation === 'session.interaction.status')`)
    expect(await page.evaluate(`document.querySelector(${JSON.stringify(status)})`)).toBeNull()
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
    await wait(page, `${interactionCalls}.some(call => call.operation === 'session.interaction.status')`)
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
    await wait(page, `requestLog.some(call => call.operation === 'session.interaction.status')`)
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

test("Interaction Resume sends the paused generation once through the relay and returns to active", async () => {
  const page = await open(1440)
  try {
    await wait(page, `requestLog.some(call => call.operation === 'session.interaction.status')`)
    await page.evaluate(`interactionFixture.change({ state: 'paused', platform: 'chrome', label: 'Checkout tab', reason: 'dialog', generation: ${JSON.stringify(first)} })`)
    await wait(page, `document.querySelector(${JSON.stringify(resume)}) !== null`)
    await page.evaluate(`const resume = document.querySelector(${JSON.stringify(resume)}); resume.click(); resume.click()`)
    await wait(page, `${text(status, "Chrome control active · Checkout tab")} && document.querySelector(${JSON.stringify(resume)}) === null`)
    expect(await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.resume').map(call => call.input)`)).toEqual([{ generation: first }])
    expect(await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.stop').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("Interaction paused shows plain-word reason with Resume next to Stop", async () => {
  const page = await open(1440)
  try {
    await wait(page, `requestLog.some(call => call.operation === 'session.interaction.status')`)
    await page.evaluate(`interactionFixture.change({ state: 'paused', platform: 'chrome', label: 'Checkout tab', reason: 'file_chooser', generation: ${JSON.stringify(first)} })`)
    await wait(page, text(status, "Chrome control paused · Checkout tab · File chooser open"))
    expect(await page.evaluate(`Array.from(document.querySelector(${JSON.stringify(status)}).querySelectorAll('button'), button => button.getAttribute('aria-label'))`)).toEqual(["Resume interaction", "Stop interaction"])
    expect(await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(resume)}); const s = document.querySelector(${JSON.stringify(stop)}); return r && s ? r.getBoundingClientRect().right <= s.getBoundingClientRect().left + 1 : false; })()`)).toBe(true)
    await click(page, stop)
    await wait(page, text(status, "Cleanup pending"))
    expect(await page.evaluate(`requestLog.filter(call => call.operation === 'session.interaction.stop').map(call => call.input)`)).toEqual([{ generation: first }])
  } finally { await page.close() }
}, 30_000)

async function revealPiPFrame(page: Page, ready = true) {
  await wait(page, `${interactionCalls}.some(call => call.operation === 'session.interaction.status')`)
  await page.evaluate(`interactionFixture.change({ state: 'active', platform: 'chrome', label: 'Private target label', generation: ${JSON.stringify(first)} }); interactionFixture.holdPreview()`)
  await wait(page, text(status, "Private target label"))
  await click(page, reveal)
  await wait(page, `${interactionCalls}.some(call => call.operation === 'session.interaction.preview')`)
  const beforeWidth = await page.evaluate(`document.querySelector(${JSON.stringify(detach)})?.offsetWidth`)
  await page.evaluate(`interactionFixture.releasePreview(${JSON.stringify(ready
    ? { state: "ready", generation: first, frame: { mimeType: "image/png", base64: pixels, width: 1, height: 1 } }
    : { state: "unavailable", generation: first })})`)
  await wait(page, ready ? `document.querySelector(${JSON.stringify(`${preview} img`)})?.naturalWidth === 1` : text(preview, "Preview withheld"))
  return beforeWidth
}

async function pressDetach(page: Page) {
  const button = `document.querySelector(${JSON.stringify(detach)})`
  expect(await page.evaluate(`!!${button} && !${button}.disabled`)).toBe(true)
  await page.evaluate(`${button}.focus()`)
  await page.pressKey("Enter", "Enter", 13, "\r")
}

const pipWindow = "window.documentPictureInPicture.window"
const pipImage = `${pipWindow}?.document.querySelector('img')`

async function openPiP(page: Page) {
  await pressDetach(page)
  await wait(page, `${pipImage}?.naturalWidth === 1`)
}

test("Interaction PiP denies opening when the active grant has no frame", async () => {
  const page = await open(1440)
  try {
    await revealPiPFrame(page, false)
    const before = await page.evaluate(interactionCalls)
    expect(await page.evaluate(`document.querySelector(${JSON.stringify(detach)})?.disabled`)).toBe(true)
    await click(page, detach)
    expect(await page.evaluate(`!!${pipWindow}`)).toBe(false)
    expect(await page.evaluate(interactionCalls)).toEqual(before)
  } finally { await page.close() }
}, 30_000)

test("Interaction PiP opens the authorized image without another request and revokes it on browser close", async () => {
  const page = await open(1440)
  try {
    const buttonWidth = await revealPiPFrame(page)
    expect(await page.evaluate(`document.querySelector(${JSON.stringify(detach)})?.offsetWidth`)).toBe(buttonWidth)
    const before = await page.evaluate(interactionCalls)
    await openPiP(page)
    const source = await page.evaluate(`${pipImage}.src`, decodeString)
    expect(source).toStartWith("blob:")
    expect(await page.evaluate(`(() => {
      const doc = ${pipWindow}.document;
      return { location: doc.URL, elements: Array.from(doc.body.children, element => element.localName), scripts: doc.scripts.length,
        targetLabel: doc.documentElement.textContent.includes('Private target label'),
        inlineImage: document.querySelector(${JSON.stringify(`${preview} img`)})?.naturalWidth };
    })()`)).toEqual({ location: "about:blank", elements: ["img"], scripts: 0, targetLabel: false, inlineImage: 1 })
    expect(await page.evaluate(interactionCalls)).toEqual(before)
    await page.evaluate(`${pipWindow}.close()`)
    await wait(page, `!${pipWindow} && !document.querySelector(${JSON.stringify(detach)}).disabled`)
    expect(await page.evaluate(`fetch(${JSON.stringify(source)}).then(() => true, () => false)`)).toBe(false)
    await openPiP(page)
    expect(await page.evaluate(interactionCalls)).toEqual(before)
  } finally { await page.close() }
}, 30_000)

test.each([
  ["hide", `document.querySelector('button[aria-label="Hide interaction preview"]').click()`],
  ["pause", `interactionFixture.change({ state: 'paused', platform: 'chrome', reason: 'dialog', label: 'Private target label', generation: ${JSON.stringify(first)} })`],
  ["revocation", `interactionFixture.change({ state: 'stopped', platform: 'chrome', reason: 'permission', cleanup: 'complete', generation: ${JSON.stringify(first)} })`],
  ["generation switch", `interactionFixture.change({ state: 'active', platform: 'chrome', label: 'Next target', generation: ${JSON.stringify(second)} })`],
  ["connection switch", `Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Simulate disconnect and reconnect')).click()`],
])("Interaction PiP clears and revokes the image on %s", async (_name, invalidate) => {
  const page = await open(1440)
  try {
    await revealPiPFrame(page)
    await openPiP(page)
    const source = await page.evaluate(`${pipImage}.src`, decodeString)
    await page.evaluate(invalidate)
    await wait(page, `!${pipWindow}`)
    expect(await page.evaluate(`fetch(${JSON.stringify(source)}).then(() => true, () => false)`)).toBe(false)
  } finally { await page.close() }
}, 30_000)

test("Interaction PiP never paints a late native open after the grant changes", async () => {
  const page = await open(1440)
  try {
    await revealPiPFrame(page)
    const before = await page.evaluate(interactionCalls)
    await page.evaluate(`(() => {
      const api = documentPictureInPicture;
      const request = api.requestWindow.bind(api);
      api.requestWindow = (...args) => request(...args).then(pip => new Promise(resolve => {
        window.latePiP = { pip, painted: false, release: () => resolve(pip) };
        new MutationObserver(records => {
          if (records.some(record => Array.from(record.addedNodes).some(node => node.nodeName === 'IMG')))
            latePiP.painted = true;
        }).observe(pip.document.body, { childList: true, subtree: true });
      }));
    })()`)
    await pressDetach(page)
    await wait(page, "!!window.latePiP")
    expect(await page.evaluate(interactionCalls)).toEqual(before)
    await page.evaluate(`interactionFixture.change({ state: 'active', platform: 'chrome', label: 'Next target', generation: ${JSON.stringify(second)} })`)
    await wait(page, text(status, "Next target"))
    await page.evaluate("latePiP.release()")
    await wait(page, "latePiP.pip.closed")
    expect(await page.evaluate("latePiP.painted")).toBe(false)
  } finally { await page.close() }
}, 30_000)

test("Interaction PiP leaves the normal preview in place when the browser denies opening", async () => {
  const page = await open(1440)
  try {
    await revealPiPFrame(page)
    await page.evaluate(`documentPictureInPicture.requestWindow = () => Promise.reject(new DOMException('Not allowed', 'NotAllowedError'))`)
    const before = await page.evaluate(interactionCalls)
    await pressDetach(page)
    await wait(page, `document.querySelector(${JSON.stringify(status)})?.textContent.includes('Picture-in-picture unavailable')`)
    expect(await page.evaluate(`({ opened: !!${pipWindow}, inlineImage: document.querySelector(${JSON.stringify(`${preview} img`)})?.naturalWidth })`)).toEqual({ opened: false, inlineImage: 1 })
    expect(await page.evaluate(interactionCalls)).toEqual(before)
  } finally { await page.close() }
}, 30_000)

test("Interaction PiP has no fallback when the browser API is unsupported", async () => {
  const page = await browser!.openPage()
  try {
    await page.injectOnNewDocument(`Object.defineProperty(window, 'documentPictureInPicture', { value: undefined })`)
    await page.navigate(`${origin}/verify/remote.html?interaction=1`)
    await revealPiPFrame(page)
    expect(await page.evaluate(`document.querySelector(${JSON.stringify(detach)})`)).toBeNull()
    expect(await page.evaluate(`${interactionCalls}.map(call => call.operation).filter(operation => operation !== 'session.interaction.status')`)).toEqual(["session.interaction.preview"])
  } finally { await page.close() }
}, 30_000)
