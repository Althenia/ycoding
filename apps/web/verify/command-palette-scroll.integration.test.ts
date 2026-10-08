import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4748
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

test("remote refresh keeps the scrolled option nodes, anchor, and active option identity", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.composer-resident:not([inert]) .composer__input') !== null`)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await wait(page, `document.querySelector('dialog.overlay--command-palette[open]') !== null`)
    await page.wheel(700, 600, 0, 520)
    const hovered = await page.evaluate<string>(`(() => { const row = [...document.querySelectorAll('[role=option]')].find((item) => item.querySelector('.command-palette__title').textContent === 'Go to Usage'); row.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); return row.id })()`)
    expect(await page.evaluate<string>(`document.querySelector('[role=option][aria-selected=true]').id`)).toBe(hovered)
    await page.wheel(700, 600, 0, 540)
    await wait(page, `document.querySelector('.command-palette__list').scrollTop > 900`)
    const before = await page.evaluate<{ anchorID: string; anchorTop: number; activeID: string; scrollTop: number }>(`(() => { const list = document.querySelector('.command-palette__list'); const rows = [...list.querySelectorAll('[role=option]')]; const anchor = rows.find((row) => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top); window.paletteScrollAnchor = anchor; return { anchorID: anchor.id, anchorTop: anchor.getBoundingClientRect().top, activeID: document.querySelector('[role=option][aria-selected=true]').id, scrollTop: list.scrollTop } })()`)
    expect(before.anchorID).not.toBe(hovered)
    await page.evaluate(`window.responseSnapshot([], [], true)`)
    await wait(page, `document.querySelector('[role=option][aria-selected=true]')?.id === ${JSON.stringify(hovered)}`)
    const after = await page.evaluate<{ anchorID: string; anchorTop: number; sameAnchorNode: boolean; activeID: string; overflow: boolean; scrollTop: number }>(`(() => { const anchor = document.getElementById(${JSON.stringify(before.anchorID)}); const list = document.querySelector('.command-palette__list'); return { anchorID: anchor.id, anchorTop: anchor.getBoundingClientRect().top, sameAnchorNode: anchor === window.paletteScrollAnchor, activeID: document.querySelector('[role=option][aria-selected=true]').id, overflow: list.scrollWidth > list.clientWidth, scrollTop: list.scrollTop } })()`)
    expect(after.activeID).toBe(hovered)
    expect(after.anchorID).toBe(before.anchorID)
    expect(Math.abs(after.anchorTop - before.anchorTop)).toBeLessThanOrEqual(1)
    expect(after.sameAnchorNode).toBe(true)
    expect(after.overflow).toBe(false)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
    await page.evaluate(`window.responseSnapshot([], [], false)`)
    await wait(page, `document.querySelector('[role=option][aria-selected=true]')?.id === ${JSON.stringify(hovered)}`)
    await page.pressKey("ArrowDown", "ArrowDown", 40)
    expect(await page.evaluate<boolean>(`(() => { const list = document.querySelector('.command-palette__list'); const active = document.querySelector('[role=option][aria-selected=true]').getBoundingClientRect(); const box = list.getBoundingClientRect(); return active.top >= box.top && active.bottom <= box.bottom })()`)).toBe(true)
    await page.evaluate(`window.responseSnapshot([], [], true)`)
    await page.evaluate(`document.getElementById('command-palette-option-session.interrupt').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))`)
    await page.evaluate(`window.responseSnapshot([], [], false)`)
    expect(await page.evaluate<boolean>(`(() => { const active = document.querySelector('.command-palette__option[aria-selected=true]'); return active !== null && document.getElementById('command-palette-input').getAttribute('aria-activedescendant') === active.id })()`)).toBe(true)
  } finally { await page.close() }
}, 60_000)

async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}

async function ready() { return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false) }
