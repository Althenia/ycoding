import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4377
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(browserPath, 980, 760)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Inventory fixture server did not start")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("remote inventory feed", () => {
  test("scrolls the conversation sidebar and finds a distant Session without loading intervening pages", async () => {
    if (!browser) throw new Error("Browser did not start")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&inventoryCount=14501`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<number>(`window.remoteInventoryReport?.().rows ?? 0`) === 25) break
        await Bun.sleep(100)
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .session-row').length`) === 25) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .session-row').length`)).toBe(25)
      expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`)).toContain("Stream remote output safely")
      await page.evaluate(`(() => { const root = document.querySelector('.workspace__rail'); root.tabIndex = 0; root.focus(); })()`)
      await page.pressKey("End", "End", 35)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`) >= 2) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)).toBe(2)
      await page.evaluate(`(() => { const input = document.querySelector('.workspace__rail input[type=search]'); input.value = 'Inventory Session 14000'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.workspace__rail .session-row')?.textContent?.includes('Inventory Session 14000') ?? false`)) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .session-row').length`)).toBe(1)
      expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`)).toContain("Stream remote output safely")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("renders one backend workspace page, advances on scroll without growing the DOM, and switches groups", async () => {
    if (!browser) throw new Error("Browser did not start")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=14501`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<number>(`window.remoteInventoryReport?.().rows ?? 0`) === 25) break
        await Bun.sleep(100)
      }
      expect(await page.evaluate(`window.remoteInventoryReport()`)).toMatchObject({ workspaceRequests: 1, rows: 25, groups: 2, next: true })
      expect(await page.evaluate<boolean>(`window.remoteInventoryReport().inputs.some(input => input.status === 'running' && input.workspace === undefined)`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`)).toBe(25)
      await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.tabIndex = 0; root.focus(); })()`)
      await page.pressKey("End", "End", 35)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`) >= 2) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)).toBe(2)
      for (let index = 0; index < 8; index += 1) {
        await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = root.scrollHeight; root.dispatchEvent(new WheelEvent('wheel', { deltaY: 250, bubbles: true })); })()`)
        await Bun.sleep(60)
      }
      expect(await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)).toBeGreaterThanOrEqual(5)
      expect(await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`)).toBeLessThanOrEqual(76)
      expect(await page.evaluate<number>(`[...document.querySelectorAll('.sessions-table__row')].filter(row => row.textContent.includes('Stream remote output safely')).length`)).toBe(1)
      const before = await page.evaluate<string>(`window.remoteInventoryReport().firstListed`)
      await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = 0; root.dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true })); })()`)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await page.evaluate<string>(`window.remoteInventoryReport().firstListed`) !== before) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<string>(`window.remoteInventoryReport().firstListed`)).not.toBe(before)
      expect(await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`)).toBeLessThanOrEqual(76)
      expect(await page.evaluate<number>(`[...document.querySelectorAll('.sessions-table__row')].filter(row => row.textContent.includes('Stream remote output safely')).length`)).toBe(1)
      await page.evaluate(`[...document.querySelectorAll('.workspace-nav__item')].find((item) => item.title === '/workspace/other')?.click()`)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.sessions-table__row')?.textContent?.includes('Inventory Session 1') ?? false`)) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`)).toBe(25)
      expect(await page.evaluate<string>(`document.querySelector('.sessions-table__row')?.textContent ?? ''`)).toContain("Inventory Session 1")
    } finally {
      await page.close()
    }
  }, 30_000)
})
