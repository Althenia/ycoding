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
  test("keeps sidebar rows enabled on a background read and disables them only for a changed filter", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) for (const reduced of [false, true]) {
        await page.setViewport(width!, height!)
        await page.setColorScheme(theme)
        await page.setReducedMotion(reduced)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&inventoryCount=240&sessionListDelay=900`)
        for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .session-row').length`) !== 25; attempt++) await Bun.sleep(50)
        const baseline = await page.evaluate<{ requests: number; rows: number; busy: boolean; enabled: boolean }>(`(() => { const list = document.querySelector('.workspace__rail .session-list'); return { requests: window.remoteInventoryReport().workspaceRequests, rows: list.querySelectorAll('.session-row').length, busy: list.getAttribute('aria-busy') === 'true', enabled: [...list.querySelectorAll('.session-row')].every(row => !row.disabled) }; })()`)
        expect(baseline).toMatchObject({ requests: 1, rows: 25, busy: false, enabled: true })
        await page.evaluate(`window.remoteInvalidateSessions()`)
        for (let attempt = 0; attempt < 60 && await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`) <= baseline.requests; attempt++) await Bun.sleep(20)
        expect(await page.evaluate<{ status: string; busy: boolean; enabled: boolean; rows: number }>(`(() => { const list = document.querySelector('.workspace__rail .session-list'); return { status: window.remoteInventoryReport().listStatus, busy: list.getAttribute('aria-busy') === 'true', enabled: [...list.querySelectorAll('.session-row')].every(row => !row.disabled), rows: list.querySelectorAll('.session-row').length }; })()`))
          .toEqual({ status: "loading", busy: false, enabled: true, rows: 25 })
        for (let attempt = 0; attempt < 80 && await page.evaluate<string>(`window.remoteInventoryReport().listStatus`) !== "ready"; attempt++) await Bun.sleep(20)
        const residentRows = await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .session-row').length`)
        expect(residentRows).toBeGreaterThanOrEqual(baseline.rows)
        await page.evaluate(`(() => { const input = document.querySelector('.workspace__rail input[type=search]'); input.value = 'Inventory Session 0'; input.dispatchEvent(new InputEvent('input', { bubbles:true })); })()`)
        const pending = await page.evaluate<{ busy: boolean; disabled: boolean; rows: number; title: string }>(`(() => { const list = document.querySelector('.workspace__rail .session-list'); return { busy: list.getAttribute('aria-busy') === 'true', disabled: [...list.querySelectorAll('.session-row')].every(row => row.disabled), rows: list.querySelectorAll('.session-row').length, title: document.querySelector('.conversation-breadcrumb strong')?.textContent ?? '' }; })()`)
        expect(pending).toMatchObject({ busy: true, disabled: true, rows: residentRows })
        await page.evaluate(`document.querySelector('.workspace__rail .session-row').click()`)
        expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`)).toBe(pending.title)
        await Bun.sleep(140)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail .session-list').getAttribute('aria-busy') === 'true' && [...document.querySelectorAll('.workspace__rail .session-row')].every(row => row.disabled)`)).toBe(true)
        for (let attempt = 0; attempt < 100 && await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .session-row').length`) !== 1; attempt++) await Bun.sleep(25)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail .session-list').getAttribute('aria-busy') === 'true'`)).toBe(false)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail .session-row').disabled`)).toBe(false)
      }
    } finally { await page.close() }
  }, 40_000)

  test("keeps unchanged resident Sessions actionable during a delayed background reload", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) for (const reduced of [false, true]) {
        await page.setViewport(width!, height!)
        await page.setColorScheme(theme)
        await page.setReducedMotion(reduced)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=240&sessionListDelay=900`)
        for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`) !== 25; attempt++) await Bun.sleep(50)
        const initial = await page.evaluate<{ requests: number; rows: number; busy: string | null; enabled: boolean }>(`(() => { window.backgroundRow = document.querySelector('.sessions-table__row'); return { requests: window.remoteInventoryReport().workspaceRequests, rows: document.querySelectorAll('.sessions-table__row').length, busy: document.querySelector('.sessions-results').getAttribute('aria-busy'), enabled: !window.backgroundRow.querySelector('button').disabled }; })()`)
        expect(initial).toMatchObject({ requests: 1, rows: 25, busy: "false", enabled: true })
        await page.evaluate(`window.remoteInvalidateSessions()`)
        for (let attempt = 0; attempt < 60 && await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`) <= initial.requests; attempt++) await Bun.sleep(20)
        const pending = await page.evaluate<{ status: string; rows: number; busy: string | null; enabled: boolean; connected: boolean }>(`(() => ({ status: window.remoteInventoryReport().listStatus, rows: document.querySelectorAll('.sessions-table__row').length, busy: document.querySelector('.sessions-results').getAttribute('aria-busy'), enabled: [...document.querySelectorAll('.sessions-table__select')].every(button => !button.disabled), connected: window.backgroundRow.isConnected }))()`)
        expect(pending).toEqual({ status: "loading", rows: 25, busy: "false", enabled: true, connected: true })
        await Bun.sleep(140)
        expect(await page.evaluate<boolean>(`document.querySelector('.sessions-results').getAttribute('aria-busy') === 'false' && [...document.querySelectorAll('.sessions-table__select')].every(button => !button.disabled)`)).toBe(true)
        for (let attempt = 0; attempt < 80 && await page.evaluate<string>(`window.remoteInventoryReport().listStatus`) !== "ready"; attempt++) await Bun.sleep(20)
        expect(await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`)).toBeGreaterThanOrEqual(initial.rows)
        expect(await page.evaluate<boolean>(`document.querySelector('.sessions-results').getAttribute('aria-busy') === 'false'`)).toBe(true)
      }
    } finally { await page.close() }
  }, 35_000)

  test("holds stale Sessions rows non-actionable and anchored until a delayed filter settles", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) for (const reduced of [false, true]) {
        await page.setViewport(width!, height!)
        await page.setColorScheme(theme)
        await page.setReducedMotion(reduced)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=240&sessionListDelay=900`)
        for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`) !== 25; attempt++) await Bun.sleep(50)
        for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 10; attempt++) await Bun.sleep(25)
        const before = await page.evaluate<{ height: number; scrollHeight: number; top: number }>(`(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = 180; window.staleRow = [...document.querySelectorAll('.sessions-table__row')].find(row => row.textContent.includes('Inventory Session 0')); return { height: document.querySelector('.sessions-results').getBoundingClientRect().height, scrollHeight: root.scrollHeight, top: window.staleRow.getBoundingClientRect().top }; })()`)
        await page.evaluate(`(() => { const input = document.querySelector('.sessions-page input[type=search]'); input.value = 'Inventory Session 0'; input.dispatchEvent(new InputEvent('input', { bubbles:true })); })()`)
        for (const delay of [0, 140, 360]) {
          if (delay > 0) await Bun.sleep(delay)
          const pending = await page.evaluate<{ rows: number; connected: boolean; busy: boolean; disabled: boolean; height: number; scrollHeight: number; top: number }>(`(() => { const root = document.querySelector('.workspace__scroll'); const results = document.querySelector('.sessions-results'); return { rows: document.querySelectorAll('.sessions-table__row').length, connected: window.staleRow.isConnected, busy: results.getAttribute('aria-busy') === 'true', disabled: [...results.querySelectorAll('.sessions-table__select')].every(button => button.disabled), height: results.getBoundingClientRect().height, scrollHeight: root.scrollHeight, top: window.staleRow.getBoundingClientRect().top }; })()`)
          expect(pending.rows).toBe(25)
          expect(pending.connected).toBe(true)
          expect(pending.busy).toBe(true)
          expect(pending.disabled).toBe(true)
          expect(Math.abs(pending.height - before.height)).toBeLessThanOrEqual(2)
          expect(Math.abs(pending.scrollHeight - before.scrollHeight)).toBeLessThanOrEqual(2)
          expect(Math.abs(pending.top - before.top)).toBeLessThanOrEqual(2)
          if (theme === "light" && width === 390 && !reduced && delay === 140) console.info("inventory filter geometry", JSON.stringify({ before, pending }))
          await page.evaluate(`window.staleRow.querySelector('button').click()`)
          expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote/sessions")
        }
        for (let attempt = 0; attempt < 100 && await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`) !== 1; attempt++) await Bun.sleep(25)
        expect(await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`)).toBe(1)
        expect(await page.evaluate<boolean>(`window.staleRow.isConnected`)).toBe(true)
        expect(await page.evaluate<string>(`document.querySelector('.sessions-results').getAttribute('aria-busy')`)).toBe("false")
        expect(await page.evaluate<boolean>(`document.querySelector('.sessions-table__select').disabled`)).toBe(false)
      }
    } finally { await page.close() }
  }, 35_000)

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
      for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 10; attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`)).toBe(10)
      expect(await page.evaluate<readonly { readonly status: string; readonly limit: number }[]>(`window.remoteInventoryReport().inputs.filter(input => input.workspace === undefined).map(input => ({ status: input.status, limit: input.limit }))`)).toEqual([
        { status: "running", limit: 10 }, { status: "idle", limit: 10 },
      ])
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
