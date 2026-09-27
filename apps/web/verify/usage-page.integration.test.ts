import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { launchBrowser } from "./cdp"

const port = 4497
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
  await mkdir(new URL("../../../.cache/tmp/", import.meta.url), { recursive: true })
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("provider allowances, spend, chart and breakdown reflow without overflow across themes", async () => {
  for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
        await wait(page, `document.querySelectorAll('.usage-provider').length === 5 && document.querySelectorAll('.usage-donut__arc').length === 2`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        await Bun.sleep(400)
        expect(await page.evaluate<string>(`document.querySelector('.usage-page')?.innerText ?? ''`)).toContain("AI credits")
        expect(await page.evaluate<number>(`document.querySelectorAll('.usage-provider:first-child .usage-meter').length`)).toBe(2)
        expect(await page.evaluate<string>(`document.querySelector('.usage-provider:first-child .usage-window__top')?.innerText ?? ''`)).toContain("38%")
        expect(await page.evaluate<string>(`document.querySelector('.usage-cost-note')?.textContent ?? ''`)).toContain("not provider bills")
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.usage-provider h3')].map(item => item.textContent.trim())`)).toEqual(["Codex", "Claude", "Copilot", "OpenRouter", "Provider with an error"])
        expect(await page.evaluate<string>(`document.querySelector('.usage-provider')?.innerText ?? ''`)).not.toContain("provider api")
        expect(await page.evaluate<string>(`document.querySelector('.usage-provider time')?.getAttribute('aria-label') ?? ''`)).toContain("source: provider API, stability: stable")
        expect(await page.evaluate<string>(`document.querySelector('.usage-donut__total')?.textContent ?? ''`)).toBe("$15.00")
        expect(await page.evaluate<string>(`[...document.querySelectorAll('.usage-provider')].find(card => card.textContent.includes('OpenRouter'))?.innerText ?? ''`)).toContain("$38.42 remaining")
        expect(await page.evaluate<string>(`[...document.querySelectorAll('.usage-provider')].find(card => card.textContent.includes('OpenRouter'))?.innerText ?? ''`)).toContain("$0.00")
        const result = await page.evaluate<{ overflow: boolean; providerColumns: number; tileColumns: number; visualColumns: number; cardRadius: string; innerRadius: string; headHeight: number; mobileRows: number; requests: number; controls: boolean }>(`(() => {
          const providers = document.querySelector('.usage-providers'); const tiles = document.querySelector('.usage-tiles'); const visuals = document.querySelector('.usage-visuals');
          return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            providerColumns: getComputedStyle(providers).gridTemplateColumns.split(' ').length,
            tileColumns: getComputedStyle(tiles).gridTemplateColumns.split(' ').length,
            visualColumns: getComputedStyle(visuals).gridTemplateColumns.split(' ').length,
            cardRadius: getComputedStyle(document.querySelector('.usage-provider')).borderTopLeftRadius,
            innerRadius: getComputedStyle(document.querySelector('.usage-window')).borderTopLeftRadius,
            headHeight: document.querySelector('.usage-head').getBoundingClientRect().height,
            mobileRows: [...document.querySelectorAll('.usage-mobile-row')].filter(row => row.getClientRects().length > 0).length,
            requests: window.usageRequests().length,
            controls: [...document.querySelectorAll('.usage-page button')].filter(button => getComputedStyle(button).display !== 'none' && button.getClientRects().length > 0).every(button => button.getBoundingClientRect().height >= 44) } })()`)
        expect(result.overflow).toBe(false)
        expect(result.providerColumns).toBe(width! >= 1280 ? 3 : width! >= 768 ? 2 : 1)
        expect(result.tileColumns).toBe(3)
        expect(result.visualColumns).toBe(width! >= 1024 ? 2 : 1)
        expect(result.cardRadius).toBe("16px")
        expect(result.innerRadius).toBe("12px")
        if (width! >= 768) expect(result.headHeight).toBeLessThan(100)
        expect(result.mobileRows).toBe(width! < 768 ? 25 : 0)
        if (width! < 768) expect(await page.evaluate<number>(`document.querySelectorAll('.usage-mobile-row .usage-provider-chip').length`)).toBe(25)
        expect(result.requests).toBe(5)
        expect(result.controls).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/usage-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        if (width === 390 && theme === "dark" || width === 1440 && theme === "light") {
          await page.evaluate(`document.querySelector('.usage-tiles')?.scrollIntoView()`)
          await Bun.sleep(120)
          await Bun.write(new URL(`../../../.cache/tmp/usage-tiles-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`document.querySelector('.usage-distribution')?.scrollIntoView()`)
          await Bun.sleep(400)
          await Bun.write(new URL(`../../../.cache/tmp/usage-donut-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`document.querySelector('.usage-chart')?.scrollIntoView()`)
          await Bun.sleep(120)
          await Bun.write(new URL(`../../../.cache/tmp/usage-chart-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`document.querySelector('.usage-breakdown')?.scrollIntoView()`)
          await Bun.sleep(120)
          await Bun.write(new URL(`../../../.cache/tmp/usage-breakdown-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        }
        if (width === 390 && theme === "light") {
          expect(await page.evaluate<unknown>(`window.usageRequests().find(item => item.operation === 'usage.report' && item.input?.limit === 200)?.input`)).toMatchObject({ group: "model", limit: 200, sort: "cost", order: "desc" })
          await page.evaluate(`document.querySelector('.usage-toggle button:last-child')?.click()`)
          expect(await page.evaluate<string>(`document.querySelector('.usage-donut__total')?.textContent ?? ''`)).toBe("91,840")
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-donut__arc').length`)).toBe(3)
          await page.evaluate(`document.querySelector('.usage-distribution__table-toggle')?.click()`)
          expect(await page.evaluate<number>(`document.querySelectorAll('#usage-distribution-table tbody tr').length`)).toBe(3)
          expect(await page.evaluate<string>(`document.querySelector('.usage-head p')?.textContent ?? ''`)).toContain("Studio Mac")
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-tile svg').length`)).toBe(1)
          await page.evaluate(`document.querySelector('.usage-chart__head button')?.click()`)
          expect(await page.evaluate<number>(`document.querySelectorAll('#usage-daily-table tbody tr').length`)).toBe(30)
          await page.evaluate(`document.querySelector('#usage-tab-session')?.click()`)
          await wait(page, `document.querySelector('#usage-breakdown-panel tbody tr')?.textContent?.includes('Session') === true`)
          await page.evaluate(`document.querySelector('.usage-breakdown__table-toggle')?.click()`)
          expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.usage-breakdown__table')).display`)).not.toBe("none")
          await page.evaluate(`document.querySelector('.usage-breakdown th:last-child button')?.click()`)
          await page.evaluate(`document.querySelector('.usage-pagination button:last-child')?.click()`)
          expect(await page.evaluate<unknown>(`window.usageRequests().at(-1)?.input`)).toMatchObject({ group: "session", sort: "cost", order: "asc", offset: 25 })
          await page.evaluate(`document.querySelector('.usage-refresh')?.click()`)
          expect(await page.evaluate<unknown>(`window.usageRequests().filter(item => item.operation === 'usage.providers').at(-1)?.input`)).toEqual({ refresh: true })
        }
      } finally { await page.close() }
    }
  }
}, 180_000)

test("an older connector shows an actionable update state", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?old`)
    await wait(page, `document.querySelector('.usage-page')?.textContent?.includes('Update YCoding on this machine to see usage.') === true`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.usage-provider').length`)).toBe(0)
  } finally { await page.close() }
})

test("usage waits for a connected machine and loads after connection opens", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?offline`)
    await wait(page, `document.querySelector('.usage-page')?.textContent?.includes('Connect to a machine to see usage.') === true`)
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(0)
    await page.evaluate(`window.usageConnect()`)
    await wait(page, `document.querySelectorAll('.usage-provider').length === 5`)
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(5)
  } finally { await page.close() }
})

test("a machine with no connected quota providers shows one explicit empty state", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?none`)
    await wait(page, `document.querySelector('.usage-page')?.textContent?.includes('No connected provider reports quotas.') === true`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.usage-provider').length`)).toBe(0)
  } finally { await page.close() }
})

test("paging keeps the table and page geometry mounted while the next report is in flight", async () => {
  for (const [width, height] of [[390, 844], [1024, 768], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?paged`)
      await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await page.evaluate(`(() => { document.querySelector('.usage-pagination')?.scrollIntoView({ block: 'center' }); window.usageNodes = {
        header: document.querySelector('.usage-head'), tiles: document.querySelector('.usage-tiles'), charts: document.querySelector('.usage-visuals'), table: document.querySelector('.usage-breakdown table')
      }; })()`)
      const before = await page.evaluate<{ scroll: number; height: number }>(`({ scroll: document.scrollingElement.scrollTop, height: document.scrollingElement.scrollHeight })`)
      await page.evaluate(`document.querySelector('.usage-pagination button:last-child')?.click()`)
      await wait(page, `window.usageRequests().some(item => item.operation === 'usage.report' && item.input?.offset === 25)`)
      const during = await page.evaluate<{ scroll: number; height: number; nodes: boolean; rows: number; busy: string | null }>(`({
        scroll: document.scrollingElement.scrollTop, height: document.scrollingElement.scrollHeight,
        nodes: window.usageNodes.header === document.querySelector('.usage-head') && window.usageNodes.tiles === document.querySelector('.usage-tiles') &&
          window.usageNodes.charts === document.querySelector('.usage-visuals') && window.usageNodes.table === document.querySelector('.usage-breakdown table'),
        rows: document.querySelectorAll('.usage-breakdown tbody tr').length,
        busy: document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') ?? null
      })`)
      if (width === 390 && theme === "light") await Bun.write(new URL("../../../.cache/tmp/usage-paging-pending.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      expect(during.nodes).toBe(true)
      expect(during.rows).toBe(25)
      expect(during.busy).toBe("true")
      expect(during.height).toBe(before.height)
      expect(Math.abs(during.scroll - before.scroll)).toBeLessThan(2)
      await page.evaluate(`window.usageReleasePage()`)
      await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 16`)
      expect(await page.evaluate<boolean>(`window.usageNodes.table === document.querySelector('.usage-breakdown table')`)).toBe(true)
      expect(await page.evaluate<string | null>(`document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') ?? null`)).toBe("false")
      const settled = await page.evaluate<{ scroll: number; height: number }>(`({ scroll: document.scrollingElement.scrollTop, height: document.scrollingElement.scrollHeight })`)
      expect(settled.height).toBe(before.height)
      expect(Math.abs(settled.scroll - before.scroll)).toBeLessThan(2)
    } finally { await page.close() }
  }
}, 180_000)

test("a failed next-page read retains the table and shows an inline error", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?paged&page-error`)
    await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
    await page.evaluate(`document.querySelector('.usage-pagination button:last-child')?.click()`)
    await wait(page, `window.usageRequests().some(item => item.operation === 'usage.report' && item.input?.offset === 25)`)
    await page.evaluate(`window.usageReleasePage()`)
    await wait(page, `document.querySelector('.usage-breakdown [role="alert"]')?.textContent?.includes('could not be loaded') === true`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.usage-breakdown tbody tr').length`)).toBe(25)
    expect(await page.evaluate<string | null>(`document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') ?? null`)).toBe("false")
  } finally { await page.close() }
})

test("sort and group changes retain the same table while only its report changes", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?paged`)
    await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
    await page.evaluate(`window.usageTable = document.querySelector('.usage-breakdown table')`)
    await page.evaluate(`document.querySelector('.usage-breakdown th:last-child button')?.click()`)
    await wait(page, `window.usageRequests().some(item => item.operation === 'usage.report' && item.input?.order === 'asc')`)
    expect(await page.evaluate<boolean>(`window.usageTable === document.querySelector('.usage-breakdown table') && document.querySelectorAll('.usage-breakdown tbody tr').length === 25 && document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') === 'true'`)).toBe(true)
    await page.evaluate(`window.usageReleasePage()`)
    await wait(page, `document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') === 'false'`)
    await page.evaluate(`document.querySelector('#usage-tab-session')?.click()`)
    await wait(page, `window.usageRequests().some(item => item.operation === 'usage.report' && item.input?.group === 'session')`)
    expect(await page.evaluate<boolean>(`window.usageTable === document.querySelector('.usage-breakdown table') && document.querySelector('.usage-breakdown tbody tr')?.textContent?.includes('Session') === false && document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') === 'true'`)).toBe(true)
    await page.evaluate(`window.usageReleasePage()`)
    await wait(page, `document.querySelector('.usage-breakdown tbody tr')?.textContent?.includes('Session') === true`)
    expect(await page.evaluate<boolean>(`window.usageTable === document.querySelector('.usage-breakdown table')`)).toBe(true)
  } finally { await page.close() }
})

test("chart details respond to hover, keyboard focus, and tap inside each card", async () => {
  for (const [width, height] of [[390, 844], [1024, 768], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
      await wait(page, `document.querySelectorAll('.usage-chart__bar').length === 30 && document.querySelectorAll('.usage-donut__arc').length === 2`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await page.evaluate(`document.querySelector('.usage-chart__bar:last-of-type')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))`)
      const daily = await page.evaluate<{ text: string; inside: boolean; name: string | null }>(`(() => { const card = document.querySelector('.usage-chart'); const tip = card.querySelector('.usage-chart__tooltip'); const bar = card.querySelector('.usage-chart__bar:last-of-type'); const a = card.getBoundingClientRect(); const b = tip?.getBoundingClientRect(); return { text: tip?.textContent ?? '', inside: !!b && b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom, name: bar?.getAttribute('aria-label') ?? null }; })()`)
      expect(daily.text).toContain("requests")
      expect(daily.text).toContain("tokens")
      expect(daily.text).toContain("$")
      expect(daily.inside).toBe(true)
      expect(daily.name).toContain("requests")
      if (width === 390 && theme === "light") {
        await page.evaluate(`document.querySelector('.usage-chart')?.scrollIntoView({ block: 'center' })`)
        await Bun.sleep(200)
        await Bun.write(new URL("../../../.cache/tmp/usage-day-tooltip.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      }
      await page.evaluate(`document.querySelector('.usage-chart__bar:first-of-type')?.focus()`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-chart__tooltip')?.textContent ?? ''`)).toMatch(/\d{4}-\d{2}-\d{2}/)
      await page.evaluate(`document.querySelector('.usage-chart__bar:last-of-type')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-chart__tooltip')?.textContent ?? ''`)).toContain("requests")
      await page.evaluate(`document.querySelector('.usage-donut__arc')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))`)
      const provider = await page.evaluate<{ text: string; inside: boolean; name: string | null }>(`(() => { const card = document.querySelector('.usage-distribution'); const tip = card.querySelector('.usage-distribution__tooltip'); const arc = card.querySelector('.usage-donut__arc'); const a = card.getBoundingClientRect(); const b = tip?.getBoundingClientRect(); return { text: tip?.textContent ?? '', inside: !!b && b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom, name: arc?.getAttribute('aria-label') ?? null }; })()`)
      expect(provider.text).toContain("Codex")
      expect(provider.text).toContain("$")
      expect(provider.text).toContain("%")
      expect(provider.inside).toBe(true)
      expect(provider.name).toContain("Codex")
      if (width === 1440 && theme === "dark") {
        await page.evaluate(`document.querySelector('.usage-distribution')?.scrollIntoView({ block: 'center' })`)
        await Bun.sleep(200)
        await Bun.write(new URL("../../../.cache/tmp/usage-provider-tooltip.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      }
      await page.evaluate(`document.querySelectorAll('.usage-donut__arc')[1]?.focus()`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-distribution__tooltip')?.textContent ?? ''`)).toContain("OpenRouter")
      await page.evaluate(`document.querySelectorAll('.usage-donut__arc')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-distribution__tooltip')?.textContent ?? ''`)).toContain("OpenRouter")
      if (width === 390 && theme === "light") {
        await page.evaluate(`document.querySelector('.usage-toggle button:last-child')?.click()`)
        await page.evaluate(`document.querySelector('.usage-donut__arc')?.focus()`)
        expect(await page.evaluate<string>(`document.querySelector('.usage-distribution__tooltip')?.textContent ?? ''`)).toContain("$10.00")
        expect(await page.evaluate<string>(`document.querySelector('.usage-distribution__tooltip')?.textContent ?? ''`)).toContain("tokens")
      }
      expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(5)
    } finally { await page.close() }
  }
}, 180_000)

async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/usage-fixture.html`).then((response) => response.ok, () => false) }
