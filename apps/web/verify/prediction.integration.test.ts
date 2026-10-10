import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4396
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

test("ghost suggestion fills by Right or 44px touch action without sending; typing, Escape, activity and source mismatch dismiss", async () => {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, width === 390 ? 844 : 900)
      if (width === 390) await page.setCoarsePointer(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; localStorage.removeItem('ycoding.remote.composer-collapsed')`)
      const baseline = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)
      await page.evaluate(`window.composerPrediction()`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__use-prediction') !== null`)
      const layout = await page.evaluate<{ text: string; value: string; height: number; width: number; row: number; overflow: boolean }>(`(() => { const field=document.querySelector('.mini-composer__mount .composer__input'), button=document.querySelector('.composer__use-prediction'); return { text:field.placeholder, value:field.value, height:button.getBoundingClientRect().height, width:button.getBoundingClientRect().width, row:document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height, overflow:document.documentElement.scrollWidth>innerWidth }; })()`)
      expect(layout.text).toBe("Run the focused tests")
      expect(layout.value).toBe("")
      expect(layout.height).toBeGreaterThanOrEqual(44)
      expect(layout.width).toBeGreaterThanOrEqual(44)
      expect(layout.row).toBe(baseline)
      expect(layout.overflow).toBe(false)
      await page.evaluate(`(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); field.focus(); field.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true, cancelable:true })) })()`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input').value === 'Run the focused tests'`)
      expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
      await page.evaluate(`window.composerSetDraft('ses_fixture', ''); window.composerPrediction('Inspect the test results')`)
      await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
      await page.evaluate(`document.querySelector('.composer__use-prediction').click()`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input').value === 'Inspect the test results'`)
      expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
      await page.evaluate(`window.composerPrediction('Do not overwrite me')`)
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__input').value`)).toBe("Inspect the test results")
      expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
      await page.evaluate(`window.composerSetDraft('ses_fixture', ''); window.composerPrediction('Try the new behavior');`)
      await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
      await page.evaluate(`(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); field.value='My draft'; field.dispatchEvent(new Event('input',{bubbles:true})); field.value=''; field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
      await page.evaluate(`window.composerPrediction('Review the changes');`)
      await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
      await page.evaluate(`document.querySelector('.mini-composer__mount .composer__input').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }))`)
      expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
      await page.evaluate(`window.composerPrediction('Try the new behavior'); window.composerSetStatus('running')`)
      expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
      await page.evaluate(`window.composerPrediction('Check the result', 'msg_old')`)
      expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
    } finally { await page.close() }
  }
}, 60000)

async function ready() { try { return (await fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`)).ok } catch { return false } }
async function wait(page: { evaluate<T>(script: string): Promise<T> }, expression: string) {
  for (let index = 0; index < 100; index++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(50) }
  throw new Error(`Did not settle: ${expression}`)
}
