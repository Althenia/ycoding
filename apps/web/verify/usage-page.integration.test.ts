import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { launchBrowser } from "./cdp"

const port = 4593
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

test("provider distribution keeps exact large values readable in one accessible legend", async () => {
  for (const width of [320, 390, 1440]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?distribution-long-values`)
        await wait(page, `document.querySelectorAll('.usage-donut__arc').length === 2`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        for (const metric of ["Spend", "Tokens"]) {
          await page.evaluate(`[...document.querySelectorAll('[aria-label="Distribution metric"] button')].find(button => button.textContent === ${JSON.stringify(metric)}).click()`)
          const expected = metric === "Spend" ? "$20,000,000.00" : "4,000,000,000"
          await wait(page, `document.querySelector('.usage-donut__total')?.textContent === ${JSON.stringify(expected)}`)
          await page.evaluate(`Promise.all(document.querySelector('.usage-distribution').getAnimations({subtree:true}).map(animation => animation.finished))`)
          const result = await page.evaluate<{ total: string; unit: string; below: boolean; contained: boolean; overflow: boolean; rows: string[]; description: string }>(`(() => {
            const card = document.querySelector('.usage-distribution');
            const total = card.querySelector('.usage-donut__total');
            const chart = card.querySelector('.usage-donut').getBoundingClientRect();
            const bounds = card.getBoundingClientRect();
            const nodes = [...card.querySelectorAll('.usage-donut__total, .usage-donut__caption, .usage-distribution__legend li > span, .usage-distribution__legend li > strong')];
            return {total:total.textContent, unit:card.querySelector('.usage-donut__caption').textContent,
              below:total.getBoundingClientRect().top >= chart.bottom,
              contained:nodes.every(node => { const rect=node.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom && node.scrollWidth <= node.clientWidth; }),
              overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
              rows:[...card.querySelectorAll('.usage-distribution__legend li')].map(node=>node.textContent),
              description:card.querySelector('.usage-donut').getAttribute('aria-label')};
          })()`)
          expect(result.total).toBe(expected)
          expect(result.unit).toBe(metric === "Spend" ? "estimated USD" : "tokens")
          expect(result.below).toBe(true)
          expect(result.contained).toBe(true)
          expect(result.overflow).toBe(false)
          expect(result.rows.length).toBe(metric === "Spend" ? 2 : 3)
          expect(result.rows[0]).toContain("Provider with a long descriptive name and a shared workspace plan")
          expect(result.rows[0]).toContain(metric === "Spend" ? "$15,000,000.00" : "2,000,000,000")
          expect(result.description).toContain("legend")
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-distribution table, .usage-distribution__table-toggle').length`)).toBe(0)
        }
        await page.evaluate(`document.querySelector('.usage-distribution').scrollIntoView()`)
        await Bun.write(new URL(`../../../.cache/tmp/usage-distribution-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }
}, 180000)

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
        expect(result.tileColumns).toBe(width! >= 1024 ? 3 : 1)
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
          await page.evaluate(`document.querySelector('.usage-distribution .usage-toggle button:last-child')?.click()`)
          expect(await page.evaluate<string>(`document.querySelector('.usage-donut__total')?.textContent ?? ''`)).toBe("91,840")
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-donut__arc').length`)).toBe(3)
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-distribution__legend li').length`)).toBe(3)
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-distribution table, .usage-distribution__table-toggle').length`)).toBe(0)
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
    expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page .loading-placeholder').length`)).toBe(0)
    expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page [role="status"]').length`)).toBe(1)
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
      await page.evaluate(`document.querySelector('.usage-chart')?.scrollIntoView({ block: 'center' })`)
      await page.evaluate(`(() => { const bar = document.querySelector('.usage-chart__bar:first-of-type'); const r = bar.getBoundingClientRect(); bar.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); })()`)
      const daily = await page.evaluate<{ text: string; inside: boolean; distance: number; name: string | null }>(`(() => { const card = document.querySelector('.usage-chart'); const tip = card.querySelector('.usage-chart__tooltip'); const bar = card.querySelector('.usage-chart__bar:first-of-type'); const a = card.getBoundingClientRect(); const b = tip?.getBoundingClientRect(); const r = bar.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; return { text: tip?.textContent ?? '', inside: !!b && b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight, distance: b ? Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom)) : Infinity, name: bar?.getAttribute('aria-label') ?? null }; })()`)
      expect(daily.text).toContain("requests")
      expect(daily.text).toContain("tokens")
      expect(daily.text).toContain("$")
      expect(daily.inside).toBe(true)
      expect(daily.distance).toBeLessThan(25)
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
      await page.evaluate(`document.querySelector('.usage-distribution')?.scrollIntoView({ block: 'center' })`)
      await page.evaluate(`(() => { const arc = document.querySelector('.usage-donut__arc'); const r = arc.getBoundingClientRect(); arc.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse', clientX: r.right - 20, clientY: r.top + r.height / 2 })); })()`)
      const provider = await page.evaluate<{ text: string; inside: boolean; distance: number; name: string | null }>(`(() => { const card = document.querySelector('.usage-distribution'); const tip = card.querySelector('.usage-distribution__tooltip'); const arc = card.querySelector('.usage-donut__arc'); const a = card.getBoundingClientRect(); const b = tip?.getBoundingClientRect(); const r = arc.getBoundingClientRect(); const x = r.right - 20, y = r.top + r.height / 2; return { text: tip?.textContent ?? '', inside: !!b && b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight, distance: b ? Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom)) : Infinity, name: arc?.getAttribute('aria-label') ?? null }; })()`)
      expect(provider.text).toContain("Codex")
      expect(provider.text).toContain("$")
      expect(provider.text).toContain("%")
      expect(provider.inside).toBe(true)
      expect(provider.distance).toBeLessThan(25)
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
        await page.evaluate(`document.querySelector('.usage-distribution .usage-toggle button:last-child')?.click()`)
        await page.evaluate(`document.querySelector('.usage-donut__arc')?.focus()`)
        expect(await page.evaluate<string>(`document.querySelector('.usage-distribution__tooltip')?.textContent ?? ''`)).toContain("$10.00")
        expect(await page.evaluate<string>(`document.querySelector('.usage-distribution__tooltip')?.textContent ?? ''`)).toContain("tokens")
      }
      expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(5)
    } finally { await page.close() }
  }
}, 180_000)

test("three same-device reloads and Refresh update values without removing cards or replaying entrances", async () => {
  for (const [width, height] of [[390, 844], [820, 1180], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?refresh-cycle`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 5 && document.querySelectorAll('.usage-tile').length === 3 && document.querySelectorAll('.usage-donut__arc').length === 2`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await Bun.sleep(900)
      await page.evaluate(`(() => {
        const selectors = '.usage-provider, .usage-tile, .usage-chart, .usage-distribution, .usage-meter > span, .usage-donut__arc, .usage-distribution__legend li, .usage-chart__bar';
        const root = document.querySelector('.usage-page');
        const nodes = [...root.querySelectorAll(selectors)];
        const probe = { nodes, removed: 0, starts: 0, empty: 0 };
        root.addEventListener('animationstart', () => { probe.starts++ });
        const observer = new MutationObserver(records => {
          for (const record of records) for (const node of record.removedNodes) if (node.nodeType === 1 && (node.matches(selectors) || node.querySelector(selectors))) probe.removed++;
          if (!root.querySelector('.usage-provider') || !root.querySelector('.usage-tile') || !root.querySelector('.usage-chart__bar') || !root.querySelector('.usage-donut__arc')) probe.empty++;
        });
        observer.observe(root, { subtree: true, childList: true });
        window.usageProbe = probe;
        window.usageProbeSnapshot = () => ({ removed: probe.removed, starts: probe.starts, empty: probe.empty,
          same: nodes.every(node => node.isConnected && root.contains(node)),
          providers: root.querySelectorAll('.usage-provider').length, tiles: root.querySelectorAll('.usage-tile').length,
          session: root.querySelector('.usage-provider:first-child .usage-window__top')?.textContent ?? '',
          today: root.querySelector('.usage-tile:first-child strong')?.textContent ?? '',
          donut: root.querySelector('.usage-donut__total')?.textContent ?? '',
          height: document.documentElement.scrollHeight,
        });
      })()`)
      const baseline = await page.evaluate<{ height: number }>(`window.usageProbeSnapshot()`)
      for (let cycle = 1; cycle <= 3; cycle++) {
        await page.evaluate(`window.usageReconnect()`)
        await wait(page, `window.usageRequests().filter(item => item.operation === 'usage.providers').length === ${cycle + 1}`)
        const pending = await page.evaluate<{ removed: number; starts: number; empty: number; same: boolean; providers: number; tiles: number; session: string; today: string; donut: string; height: number }>(`window.usageProbeSnapshot()`)
        if (cycle === 1 && width === 390 && theme === "light") await Bun.write(new URL("../../../.cache/tmp/usage-reconnect-pending.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        expect(pending).toMatchObject({ removed: 0, starts: 0, empty: 0, same: true, providers: 5, tiles: 3, today: cycle === 1 ? "$5.40" : `$${(5.4 + cycle - 1).toFixed(2)}`, donut: cycle === 1 ? "$15.00" : `$${(15 + 3 * (cycle - 1)).toFixed(2)}`, height: baseline.height })
        await page.evaluate(`window.usageReleaseReload()`)
        await wait(page, `document.querySelector('.usage-provider:first-child .usage-window__top')?.textContent?.includes('${38 + cycle}%') === true`)
        const settled = await page.evaluate<{ removed: number; starts: number; empty: number; same: boolean; providers: number; tiles: number; today: string; donut: string; height: number }>(`window.usageProbeSnapshot()`)
        expect(settled).toMatchObject({ removed: 0, starts: 0, empty: 0, same: true, providers: 5, tiles: 3, today: `$${(5.4 + cycle).toFixed(2)}`, donut: `$${(15 + 3 * cycle).toFixed(2)}`, height: baseline.height })
      }
      await page.evaluate(`document.querySelector('.usage-refresh')?.click()`)
      await wait(page, `window.usageRequests().filter(item => item.operation === 'usage.providers').length === 5`)
      expect(await page.evaluate<{ removed: number; starts: number; empty: number; same: boolean }>(`window.usageProbeSnapshot()`)).toMatchObject({ removed: 0, starts: 0, empty: 0, same: true })
      await page.evaluate(`window.usageReleaseReload()`)
      await wait(page, `document.querySelector('.usage-provider:first-child .usage-window__top')?.textContent?.includes('42%') === true`)
      expect(await page.evaluate<{ removed: number; starts: number; empty: number; same: boolean }>(`window.usageProbeSnapshot()`)).toMatchObject({ removed: 0, starts: 0, empty: 0, same: true })
      if (width === 390 && theme === "dark") await Bun.write(new URL("../../../.cache/tmp/usage-refresh-settled.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 180_000)

test("large spend values keep each metric intact in usable tiles at 320, 390, and 820 pixels", async () => {
  for (const [width, height] of [[320, 720], [390, 844], [820, 1180]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?large-values`)
      await wait(page, `document.querySelector('.usage-tile:first-child .usage-tile__meta')?.textContent?.includes('2,267,963,225') === true`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      const geometry = await page.evaluate<{ columns: number; widths: number[]; fragments: number[]; overflow: boolean }>(`(() => {
        const tiles = [...document.querySelectorAll('.usage-tile')];
        return { columns: getComputedStyle(document.querySelector('.usage-tiles')).gridTemplateColumns.split(' ').length,
          widths: tiles.map(tile => tile.getBoundingClientRect().width),
          fragments: [...document.querySelectorAll('.usage-tile__meta span')].map(span => span.getClientRects().length),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`)
      expect(geometry.columns).toBe(1)
      expect(geometry.widths.every((value) => value >= 260)).toBe(true)
      expect(geometry.fragments.every((value) => value === 1)).toBe(true)
      expect(geometry.overflow).toBe(false)
      await page.evaluate(`document.querySelector('.usage-tiles')?.scrollIntoView({ block: 'start' })`)
      await Bun.sleep(400)
      await Bun.write(new URL(`../../../.cache/tmp/usage-large-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 180_000)

test("a device switch, explicit disconnect, or sign-out clears the previous machine's usage", async () => {
  for (const action of ["usageSwitchDevice", "usageDisconnect", "usageSignOut"]) {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?refresh-cycle`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 5 && document.querySelectorAll('.usage-tile').length === 3`)
      await page.evaluate(`window.${action}()`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 0 && document.querySelectorAll('.usage-tile').length === 0`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-quotas')?.textContent ?? ''`)).toContain("Connect to a machine")
    } finally { await page.close() }
  }
})

test("UTC and Local report choices persist and never label UTC data as local", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
      await wait(page, `document.querySelectorAll('.usage-donut__arc').length === 2`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-chart h3')?.textContent ?? ''`)).toContain("UTC")
      await page.evaluate(`document.querySelector('[aria-label="Usage time zone"] button:last-child')?.click()`)
      const zone = await page.evaluate<string>(`Intl.DateTimeFormat().resolvedOptions().timeZone`)
      await wait(page, `window.usageRequests().filter(item => item.operation === 'usage.report' && item.input?.timeZone === ${JSON.stringify(zone)}).length >= 3`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-chart h3')?.textContent ?? ''`)).toContain(zone)
      expect(await page.evaluate<string>(`document.querySelector('.usage-distribution h3')?.textContent ?? ''`)).toContain(zone)
      expect(await page.evaluate<string>(`document.querySelector('.usage-head [aria-label="Usage time zone"] button:last-child')?.getAttribute('aria-pressed') ?? ''`)).toBe("true")
      const bounds = await page.evaluate<{ day: { from: number; to: number }; month: { from: number }; breakdown: { from: number; to: number }; overflow: boolean }>(`(() => {
        const reports = window.usageRequests().filter(item => item.operation === 'usage.report' && item.input?.timeZone === ${JSON.stringify(zone)}).map(item => item.input);
        const day = reports.find(item => item.group === 'day');
        const month = reports.find(item => item.group === 'model' && item.limit === 200);
        const breakdown = reports.find(item => item.group === 'model' && item.limit === 25);
        return { day: { from: day.from, to: day.to }, month: { from: month.from }, breakdown: { from: breakdown.from, to: breakdown.to }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`)
      expect(bounds.breakdown).toEqual(bounds.day)
      expect(bounds.month.from).toBeLessThan(bounds.day.to)
      expect(bounds.overflow).toBe(false)
      if (width === 390) await Bun.write(new URL("../../../.cache/tmp/usage-local-390.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
      await wait(page, `document.querySelectorAll('.usage-donut__arc').length === 2`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-head [aria-label="Usage time zone"] button:last-child')?.getAttribute('aria-pressed') ?? ''`)).toBe("true")
      await page.evaluate(`window.usageDowngrade()`)
      await wait(page, `document.querySelector('.usage-chart .usage-message')?.textContent?.includes('Update YCoding') === true`)
      expect(await page.evaluate<{ tiles: number; arcs: number; rows: number }>(`({ tiles: document.querySelectorAll('.usage-tile').length, arcs: document.querySelectorAll('.usage-donut__arc').length, rows: document.querySelectorAll('.usage-breakdown tbody tr').length })`)).toEqual({ tiles: 0, arcs: 0, rows: 0 })
      await page.evaluate(`document.querySelector('[aria-label="Usage time zone"] button:first-child')?.click()`)
      await wait(page, `document.querySelector('.usage-chart h3')?.textContent?.includes('UTC') === true`)
    } finally { await page.close() }
  }
  const old = await browser!.openPage()
  try {
    await old.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?old-zone`)
    await wait(old, `document.querySelectorAll('.usage-tile').length === 3`)
    await old.evaluate(`document.querySelector('[aria-label="Usage time zone"] button:last-child')?.click()`)
    await wait(old, `document.querySelector('.usage-chart .usage-message')?.textContent?.includes('Update YCoding') === true`)
    expect(await old.evaluate<number>(`document.querySelectorAll('.usage-tile').length`)).toBe(0)
    expect(await old.evaluate<string>(`document.querySelector('.usage-chart h3')?.textContent ?? ''`)).toContain("Local")
    await old.evaluate(`document.querySelector('[aria-label="Usage time zone"] button:first-child')?.click()`)
  } finally { await old.close() }
}, 180_000)

test("unknown Usage reads keep good panels while one recovery read settles, then surface a failed retry", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?unknown-usage`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 5 && document.querySelectorAll('.usage-tile').length === 3 && document.querySelectorAll('.usage-donut__arc').length === 2`)
      await page.evaluate(`window.usageOutage()`)
      expect(await page.evaluate<{ providers: number; tiles: number; arcs: number; rows: number; alerts: number; requests: number }>(`({
        providers: document.querySelectorAll('.usage-provider').length, tiles: document.querySelectorAll('.usage-tile').length,
        arcs: document.querySelectorAll('.usage-donut__arc').length, rows: document.querySelectorAll('.usage-breakdown tbody tr').length,
        alerts: document.querySelectorAll('.usage-page [role="alert"]').length, requests: window.usageRequests().length,
      })`)).toEqual({ providers: 5, tiles: 3, arcs: 2, rows: 25, alerts: 0, requests: 10 })
      await page.evaluate(`window.usageAgentBack(false)`)
      await wait(page, `window.usageRequests().length === 15`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page [role="alert"]').length`)).toBe(0)
      await page.evaluate(`window.usageOutage()`)
      await page.evaluate(`window.usageAgentBack(true)`)
      await wait(page, `window.usageRequests().length === 25`)
      expect(await page.evaluate<{ providers: number; tiles: number; arcs: number; rows: number; alerts: string[] }>(`({
        providers: document.querySelectorAll('.usage-provider').length, tiles: document.querySelectorAll('.usage-tile').length,
        arcs: document.querySelectorAll('.usage-donut__arc').length, rows: document.querySelectorAll('.usage-breakdown tbody tr').length,
        alerts: [...document.querySelectorAll('.usage-page [role="alert"]')].map(item => item.textContent ?? ''),
      })`)).toMatchObject({ providers: 5, tiles: 3, arcs: 2, rows: 25, alerts: [expect.stringContaining("retry failed"), expect.stringContaining("retry failed"), expect.stringContaining("retry failed"), expect.stringContaining("retry failed")] })
    } finally { await page.close() }
  }
}, 180_000)

test("first Usage reads reserve visible placeholders without replacing settled cards or refresh data", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?initial-loading&refresh-cycle`)
      await wait(page, `window.usageRequests().length === 5 && document.querySelectorAll('.usage-page .loading-placeholder').length === 4`)
      const pending = await page.evaluate<{ kinds: string[]; labels: string[]; statuses: number; heights: number[]; cards: number[]; overflow: boolean }>(`(() => {
        const placeholders = [...document.querySelectorAll('.usage-page .loading-placeholder')];
        return { kinds: placeholders.map(item => [...item.classList].find(name => name.startsWith('loading-placeholder--'))), labels: placeholders.map(item => item.textContent.trim()),
          statuses: document.querySelectorAll('.usage-page [role="status"]').length,
          heights: placeholders.map(item => item.getBoundingClientRect().height),
          cards: [...document.querySelectorAll('.usage-chart, .usage-distribution')].map(item => item.getBoundingClientRect().height),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`)
      expect(pending.kinds).toEqual(["loading-placeholder--usage", "loading-placeholder--chart", "loading-placeholder--chart", "loading-placeholder--usage"])
      expect(pending.labels).toEqual(["Loading provider quotas…", "Loading daily spend…", "Loading monthly usage…", "Loading breakdown…"])
      expect(pending.statuses).toBe(4)
      expect(pending.heights.every((height) => height >= 64)).toBe(true)
      expect(pending.overflow).toBe(false)
      await page.evaluate(`window.usageCards = [...document.querySelectorAll('.usage-chart, .usage-distribution, .usage-breakdown')]; window.usageReleaseInitial()`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 5 && document.querySelectorAll('.usage-donut__arc').length === 2 && document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
      const settled = await page.evaluate<{ placeholders: number; sameCards: boolean; cards: number[]; overflow: boolean }>(`({
        placeholders: document.querySelectorAll('.usage-page .loading-placeholder').length,
        sameCards: window.usageCards.every(node => node.isConnected && document.querySelector('.usage-page')?.contains(node)),
        cards: [...document.querySelectorAll('.usage-chart, .usage-distribution')].map(item => item.getBoundingClientRect().height),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      })`)
      expect(settled).toMatchObject({ placeholders: 0, sameCards: true, overflow: false })
      expect(settled.cards.map((height, index) => Math.abs(height - pending.cards[index]!)).every((difference) => difference <= 64)).toBe(true)
      await page.evaluate(`window.usageReconnect()`)
      await wait(page, `window.usageRequests().length === 10`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page .loading-placeholder').length`)).toBe(0)
      await page.evaluate(`window.usageReleaseReload()`)
      await wait(page, `document.querySelector('.usage-provider:first-child .usage-window__top')?.textContent?.includes('39%') === true`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page .loading-placeholder').length`)).toBe(0)
    } finally { await page.close() }
  }
}, 180_000)

async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/usage-fixture.html`).then((response) => response.ok, () => false) }
