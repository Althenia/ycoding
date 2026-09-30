import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4421
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

type Page = Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>
type Geometry = { readonly bubble: readonly number[]; readonly ring: readonly number[] | null; readonly lastLine: readonly number[]; readonly status: string; readonly focused: boolean; readonly animation: string; readonly toasts: number }

const long = "Please review the release workflow, the installer contract, and every notification surface before the next tag so nothing regresses"

const geometry = `(() => {
  const bubble = document.querySelector('.transcript-message__bubble');
  const box = (rect) => [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 10) / 10);
  const range = document.createRange(); range.selectNodeContents(bubble.firstChild);
  const lines = [...range.getClientRects()];
  const anchor = bubble.querySelector('.transcript-message__sending');
  const ring = anchor ? getComputedStyle(anchor, '::after') : null;
  const anchorBox = anchor?.getBoundingClientRect();
  return {
    bubble: box(bubble.getBoundingClientRect()),
    ring: anchor ? [anchorBox.left + parseFloat(ring.left), anchorBox.top + parseFloat(ring.top), parseFloat(ring.width), parseFloat(ring.height)].map((value) => Math.round(value * 10) / 10) : null,
    lastLine: box(lines.at(-1)),
    status: anchor?.getAttribute('role') === 'status' ? anchor.textContent : '',
    focused: document.activeElement === document.querySelector('.mini-composer__mount .composer__input'),
    animation: ring?.animationName ?? '',
    toasts: document.querySelectorAll('.mutation-toast').length,
  };
})()`

async function open(width: number, text: string, reducedMotion = false): Promise<Page> {
  const page = await browser!.openPage()
  await page.setViewport(width, 900)
  await page.setReducedMotion(reducedMotion)
  await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
  await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
  await page.evaluate(`window.composerSetPending('steer', ${JSON.stringify(text)}); document.querySelector('.mini-composer__mount .composer__input').focus()`)
  await wait(page, `document.querySelector('.transcript-message__bubble') !== null`)
  await page.evaluate(`Promise.allSettled(document.querySelector('.transcript-message').getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))`)
  return page
}

for (const [width, text] of [[390, "Review"], [390, long], [1440, long]] as const) test(`the submitted prompt shows a sending ring right after its last character without moving the bubble at ${width}px (${text.length} chars)`, async () => {
  const page = await open(width, text)
  try {
    const before = await page.evaluate<Geometry>(geometry)
    expect(before.ring).toBeNull()
    await page.evaluate(`window.composerSetMutation('sending')`)
    await wait(page, `document.querySelector('.transcript-message__sending') !== null`)
    const sending = await page.evaluate<Geometry>(geometry)
    expect(sending.bubble).toEqual(before.bubble)
    expect(sending.lastLine).toEqual(before.lastLine)
    expect(sending.status).toBe("Sending prompt")
    expect(sending.focused).toBe(true)
    expect(sending.toasts).toBe(0)
    expect(sending.animation).toBe("transcript-sending")
    const [ringLeft, ringTop, ringWidth, ringHeight] = sending.ring!
    const [lineLeft, lineTop, lineWidth, lineHeight] = sending.lastLine
    expect(ringLeft).toBeGreaterThanOrEqual(lineLeft! + lineWidth!)
    expect(ringLeft! - (lineLeft! + lineWidth!)).toBeLessThan(ringWidth!)
    expect(ringTop).toBeGreaterThanOrEqual(lineTop!)
    expect(ringTop! + ringHeight!).toBeLessThanOrEqual(lineTop! + lineHeight! + 1)
    await page.evaluate(`window.composerSetMutation('sent')`)
    await wait(page, `document.querySelector('.transcript-message__sending') === null`)
    const accepted = await page.evaluate<Geometry>(geometry)
    expect(accepted.bubble).toEqual(before.bubble)
    expect(accepted.toasts).toBe(0)
    expect(accepted.focused).toBe(true)
  } finally { await page.close() }
})

test("a failed or unknown send removes the ring and raises its error toast with Retry send", async () => {
  const page = await open(390, "Review")
  try {
    for (const status of ["failed", "unknown"] as const) {
      await page.evaluate(`window.composerSetMutation('sending')`)
      await wait(page, `document.querySelector('.transcript-message__sending') !== null`)
      await page.evaluate(`window.composerSetMutation(${JSON.stringify(status)})`)
      await wait(page, `document.querySelector('.mutation-toast--${status}') !== null`)
      expect(await page.evaluate<{ ring: boolean; retry: number }>(`({ ring: document.querySelector('.transcript-message__sending') !== null, retry: document.querySelectorAll('.transcript-message__send-error button').length })`))
        .toEqual({ ring: false, retry: 1 })
      await page.evaluate(`window.composerSetMutation(null)`)
    }
  } finally { await page.close() }
})

test("a send in flight for another Session never rings on this Session's message", async () => {
  const page = await open(390, "Review")
  try {
    await page.evaluate(`window.composerSetMutation('sending', 'ses_other')`)
    await Bun.sleep(150)
    expect(await page.evaluate<boolean>(`document.querySelector('.transcript-message__sending') !== null`)).toBe(false)
    await page.evaluate(`window.composerSetMutation('sending')`)
    await wait(page, `document.querySelector('.transcript-message__sending') !== null`)
    await page.evaluate(`window.composerSwitchSession()`)
    await wait(page, `document.querySelector('.transcript-message__bubble') === null`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-message__sending').length`)).toBe(0)
  } finally { await page.close() }
})

test("reduced motion shows the same ring without rotation", async () => {
  const page = await open(390, "Review", true)
  try {
    await page.evaluate(`window.composerSetMutation('sending')`)
    await wait(page, `document.querySelector('.transcript-message__sending') !== null`)
    const reduced = await page.evaluate<Geometry>(geometry)
    expect(reduced.ring).not.toBeNull()
    expect(reduced.animation).toBe("none")
    expect(reduced.status).toBe("Sending prompt")
  } finally { await page.close() }
})

async function ready() {
  return await fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok, () => false)
}

async function wait(page: Page, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}
