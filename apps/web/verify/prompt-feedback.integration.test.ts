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
type Geometry = { readonly bubble: readonly number[]; readonly inline: boolean; readonly receipt: readonly number[]; readonly status: string; readonly focused: boolean; readonly animation: string; readonly toasts: number }

const long = "Please review the release workflow, the installer contract, and every notification surface before the next tag so nothing regresses"

const geometry = `(() => {
  const bubble = document.querySelector('.transcript-message__bubble');
  const box = (rect) => [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 10) / 10);
  const receipt = document.querySelector('.transcript-message__receipt');
  return {
    bubble: box(bubble.getBoundingClientRect()),
    inline: bubble.querySelector('.transcript-message__sending') !== null,
    receipt: box(receipt.getBoundingClientRect()),
    status: receipt.getAttribute('aria-label'),
    focused: document.activeElement === document.querySelector('.mini-composer__mount .composer__input'),
    animation: getComputedStyle(receipt).animationName,
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

for (const [width, text] of [[390, "Review"], [390, long], [1440, long]] as const) test(`the submitted prompt uses one static receipt beneath its bubble at ${width}px (${text.length} chars)`, async () => {
  const page = await open(width, text)
  try {
    const before = await page.evaluate<Geometry>(geometry)
    expect(before.inline).toBe(false)
    await page.evaluate(`window.composerSetMutation('sending')`)
    const sending = await page.evaluate<Geometry>(geometry)
    expect(sending.bubble).toEqual(before.bubble)
    expect(sending.inline).toBe(false)
    expect(sending.status).toBe("Sending prompt")
    expect(sending.focused).toBe(true)
    expect(sending.toasts).toBe(0)
    expect(sending.animation).toBe("none")
    expect(sending.receipt[1]).toBeGreaterThanOrEqual(sending.bubble[1]! + sending.bubble[3]!)
    expect(sending.receipt[3]).toEqual(before.receipt[3])
    await page.evaluate(`window.composerSetMutation('sent')`)
    await wait(page, `document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label') !== 'Sending prompt'`)
    const accepted = await page.evaluate<Geometry>(geometry)
    expect(accepted.bubble).toEqual(before.bubble)
    expect(accepted.toasts).toBe(0)
    expect(accepted.focused).toBe(true)
  } finally { await page.close() }
})

test("a failed or unknown send replaces the sending receipt and raises its error toast with Retry send", async () => {
  const page = await open(390, "Review")
  try {
    for (const status of ["failed", "unknown"] as const) {
      await page.evaluate(`window.composerSetMutation('sending')`)
      await wait(page, `document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label') === 'Sending prompt'`)
      await page.evaluate(`window.composerSetMutation(${JSON.stringify(status)})`)
      await wait(page, `document.querySelector('.mutation-toast--${status}') !== null`)
      expect(await page.evaluate<{ ring: boolean; retry: number }>(`({ ring: document.querySelector('.transcript-message__sending') !== null, retry: document.querySelectorAll('.transcript-message__send-error button').length })`))
        .toEqual({ ring: false, retry: 1 })
      expect(await page.evaluate<string>(`document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label')`)).toBe(status === "failed" ? "Send failed" : "Outcome unknown")
      await page.evaluate(`window.composerSetMutation(null)`)
    }
  } finally { await page.close() }
})

test("configured commands show sending and failure receipts with a correlated retry beneath their bubble", async () => {
  const page = await open(390, "/review")
  try {
    await page.evaluate(`window.composerSetMutation('sending'); window.composerUseCommandMutation()`)
    expect(await page.evaluate<string>(`document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label')`)).toBe("Sending prompt")
    for (const status of ["failed", "unknown"] as const) {
      await page.evaluate(`window.composerSetMutation(${JSON.stringify(status)}); window.composerUseCommandMutation()`)
      expect(await page.evaluate<string>(`document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label')`)).toBe(status === "failed" ? "Send failed" : "Outcome unknown")
      await page.evaluate(`document.querySelector('.transcript-message__send-error button').click()`)
    }
    expect(await page.evaluate<{ operation: string; input: { id: string } }[]>(`window.composerRequests()`)).toEqual([
      { operation: "retry", input: { id: "msg_fixture" } },
      { operation: "retry", input: { id: "msg_fixture" } },
    ])
  } finally { await page.close() }
})

test("a send in flight for another Session never changes this Session's receipt", async () => {
  const page = await open(390, "Review")
  try {
    await page.evaluate(`window.composerSetMutation('sending', 'ses_other')`)
    await Bun.sleep(150)
    expect(await page.evaluate<string>(`document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label')`)).not.toBe("Sending prompt")
    await page.evaluate(`window.composerSetMutation('sending')`)
    await wait(page, `document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label') === 'Sending prompt'`)
    await page.evaluate(`window.composerSwitchSession()`)
    await wait(page, `document.querySelector('.transcript-message__bubble') === null`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-message__sending').length`)).toBe(0)
  } finally { await page.close() }
})

test("reduced motion keeps the same static sending receipt", async () => {
  const page = await open(390, "Review", true)
  try {
    await page.evaluate(`window.composerSetMutation('sending')`)
    await wait(page, `document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label') === 'Sending prompt'`)
    const reduced = await page.evaluate<Geometry>(geometry)
    expect(reduced.inline).toBe(false)
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
