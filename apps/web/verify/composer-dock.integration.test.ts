import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4471
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 390, 844)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("the hide control sits above the draft, and an open keyboard lifts the composer by the shell inset", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount .composer__dock-toggle') !== null`)
    await page.evaluate(`document.documentElement.dataset.theme = "dark"; localStorage.removeItem('ycoding.remote.composer-collapsed'); window.composerSetDraft('ses_fixture', ${JSON.stringify("Keep the draft clear of the hide control. ".repeat(12))})`)
    for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
      await page.setViewport(viewport.width, viewport.height)
      const boxes = await page.evaluate<{ toggleBottom: number; fieldTop: number }>(`(() => { const toggle=document.querySelector('.mini-composer__mount .composer__dock-toggle').getBoundingClientRect(); const field=document.querySelector('.mini-composer__mount .composer__input').getBoundingClientRect(); return { toggleBottom:toggle.bottom, fieldTop:field.top }; })()`)
      expect(boxes.toggleBottom).toBeLessThanOrEqual(boxes.fieldTop + 0.5)
      await page.evaluate(`document.querySelector('.mini-composer__mount .composer__dock-toggle').click()`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer--collapsed') !== null`)
      const handle = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__dock').getBoundingClientRect().height`)
      expect(handle).toBeLessThanOrEqual(52)
      expect(handle).toBeGreaterThanOrEqual(44)
      await page.evaluate(`document.querySelector('.mini-composer__mount .composer__dock-toggle').click()`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer--collapsed') === null`)
    }
    await page.setViewport(390, 844)
    await page.setColorScheme("dark")
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-1440`)
    await wait(page, `document.querySelector('.composer-resident .composer__input') !== null`)
    const before = await page.evaluate<number>(`document.querySelector('.composer-resident .composer').getBoundingClientRect().bottom`)
    await page.evaluate(`document.documentElement.setAttribute('data-keyboard-open',''); document.documentElement.style.setProperty('--yc-keyboard-inset','280px')`)
    const lifted = await page.evaluate<{ margin: string; padding: string; bottom: number }>(`(() => { const node=document.querySelector('.composer-resident .composer'); const style=getComputedStyle(node); return { margin:style.marginBlockEnd, padding:style.paddingBlockEnd, bottom:node.getBoundingClientRect().bottom }; })()`)
    expect(lifted.margin).toBe("280px")
    expect(Number.parseFloat(lifted.padding)).toBeLessThan(16)
    expect(before - lifted.bottom).toBeGreaterThan(270)
    expect(before - lifted.bottom).toBeLessThan(290)
  } finally { await page.close() }
})

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok).catch(() => false)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 120; index++) {
    if (await page.evaluate<boolean>(expression).catch(() => false)) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
