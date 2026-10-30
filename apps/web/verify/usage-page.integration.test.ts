import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchBrowser } from "./cdp"

const port = 4593
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let captures = ""

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
  captures = await mkdtemp(join(tmpdir(), "usage-page-"))
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("summary sparklines never overlap the exact spend and token totals", async () => {
  for (const width of [1280, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
      await wait(page, `document.querySelectorAll('.usage-tile').length === 3`)
      await page.evaluate(`document.fonts.ready`)
      expect(await page.evaluate<{ visible: boolean; separated: boolean; contained: boolean }>(`(() => {
        const chart=document.querySelector('.usage-tile svg'),tile=chart.closest('.usage-tile'),box=chart.getBoundingClientRect(),bounds=tile.getBoundingClientRect();
        return {visible:box.width>0&&box.height>0,separated:[...tile.querySelectorAll('h3,strong,.usage-tile__meta span')].every(text=>{const rect=text.getBoundingClientRect();return rect.bottom<=box.top||rect.top>=box.bottom||rect.right<=box.left||rect.left>=box.right}),contained:box.left>=bounds.left&&box.right<=bounds.right&&box.top>=bounds.top&&box.bottom<=bounds.bottom};
      })()`)).toEqual({ visible: true, separated: true, contained: true })
    } finally { await page.close() }
  }
}, 30_000)

test("provider distribution keeps exact large values readable in one accessible legend", async () => {
  for (const width of [320, 390, 820, 1440]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?distribution-long-values`)
        await wait(page, `document.querySelectorAll('.usage-donut__arc').length === 2`)
        await page.evaluate(`document.fonts.ready`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        for (const metric of ["Spend", "Tokens"]) {
          await page.evaluate(`[...document.querySelectorAll('[aria-label="Distribution metric"] button')].find(button => button.textContent === ${JSON.stringify(metric)}).click()`)
          const expected = metric === "Spend" ? "$20.0m" : "4.0b"
          const exact = metric === "Spend" ? "$20,000,000.00" : "4,000,000,000"
          await wait(page, `document.querySelector('.usage-donut__total')?.textContent === ${JSON.stringify(expected)}`)
          await page.evaluate(`Promise.all(document.querySelector('.usage-distribution').getAnimations({subtree:true}).map(animation => animation.finished))`)
          const result = await page.evaluate<{ total: string; exact: string; title: string; unit: string; insideHole: boolean; exactTooWide: boolean; contained: boolean; overflow: boolean; rows: string[]; description: string }>(`(() => {
            const card = document.querySelector('.usage-distribution');
            const total = card.querySelector('.usage-donut__total');
            const chart = card.querySelector('.usage-donut').getBoundingClientRect();
            const bounds = card.getBoundingClientRect();
            const exact = ${JSON.stringify(exact)};
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            const totalStyle = getComputedStyle(total); context.font = totalStyle.fontWeight + ' ' + totalStyle.fontSize + ' ' + totalStyle.fontFamily;
            const exactTooWide = context.measureText(exact).width > chart.width * 118 / 200;
            const innerRadius = chart.width * 59 / 200;
            const insideHole = [total, card.querySelector('.usage-donut__caption')].every(node => {
              const rect = node.getBoundingClientRect();
              return [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]].every(([x, y]) => Math.hypot(x - (chart.left + chart.width / 2), y - (chart.top + chart.height / 2)) <= innerRadius);
            });
            const nodes = [...card.querySelectorAll('.usage-donut__total, .usage-donut__caption, .usage-distribution__legend li > span, .usage-distribution__legend li > strong')];
            return {total:total.textContent, exact:total.getAttribute('aria-label'), title:total.getAttribute('title'), unit:card.querySelector('.usage-donut__caption').textContent,
              insideHole, exactTooWide,
              contained:nodes.every(node => { const rect=node.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom && node.scrollWidth <= node.clientWidth; }),
              overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
              rows:[...card.querySelectorAll('.usage-distribution__legend li')].map(node=>node.textContent),
              description:card.querySelector('.usage-donut').getAttribute('aria-label')};
          })()`)
          expect(result.total).toBe(expected)
          expect(result.exact).toBe(`${metric === "Spend" ? "Exact known USD subtotal" : "Exact token total"}: ${exact}`)
          expect(result.title).toBe(result.exact)
          expect(result.unit).toBe(metric === "Spend" ? "known USD" : "tokens")
          expect(result.exactTooWide).toBe(true)
          expect(result.insideHole).toBe(true)
          expect(result.contained).toBe(true)
          expect(result.overflow).toBe(false)
          expect(result.rows.length).toBe(metric === "Spend" ? 2 : 3)
          expect(result.rows[0]).toContain("Provider with a long descriptive name and a shared workspace plan")
          expect(result.rows[0]).toContain(metric === "Spend" ? "$15,000,000.00" : "2,000,000,000")
          expect(result.description).toContain("legend")
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-distribution table, .usage-distribution__table-toggle').length`)).toBe(0)
        }
        await page.evaluate(`document.querySelector('.usage-distribution').scrollIntoView()`)
        await Bun.write(join(captures, `usage-distribution-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
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
        await wait(page, `document.querySelectorAll('.usage-provider').length === 6 && document.querySelectorAll('.usage-donut__arc').length === 2`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        await Bun.sleep(400)
        expect(await page.evaluate<string>(`document.querySelector('.usage-page')?.innerText ?? ''`)).toContain("AI credits")
        expect(await page.evaluate<number>(`document.querySelectorAll('.usage-provider:first-child .usage-meter').length`)).toBe(2)
        expect(await page.evaluate<string>(`document.querySelector('.usage-provider:first-child .usage-window__top')?.innerText ?? ''`)).toContain("38%")
        expect(await page.evaluate<string>(`document.querySelector('.usage-cost-note')?.textContent ?? ''`)).toContain("not provider bills")
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.usage-provider h3')].map(item => item.textContent.trim())`)).toEqual(["Codex", "Claude", "Copilot", "OpenRouter", "Disconnected provider", "Provider with an error"])
        expect(await page.evaluate<string>(`document.querySelector('.usage-provider')?.innerText ?? ''`)).not.toContain("provider api")
        expect(await page.evaluate<string>(`document.querySelector('.usage-provider time')?.getAttribute('aria-label') ?? ''`)).toBe("")
        await page.evaluate(`document.querySelector('.usage-provider button[aria-label="Codex details"]').focus()`)
        await page.pressKey("Enter", "Enter", 13, "\r")
        await wait(page, `document.querySelector('dialog.overlay--usage-details[open]') !== null`)
        expect(await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-details')?.innerText ?? ''`)).toContain("Source provider API · stability stable")
        await page.pressEscape()
        expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Codex details'`)).toBe(true)
        expect(await page.evaluate<string>(`document.querySelector('.usage-donut__total')?.textContent ?? ''`)).toBe("$15.00")
         expect(await page.evaluate<string>(`document.querySelector('.usage-donut__total')?.getAttribute('aria-label') ?? ''`)).toBe("Exact known USD subtotal: $15.00")
         expect(await page.evaluate<string>(`document.querySelector('.usage-donut__total')?.getAttribute('title') ?? ''`)).toBe("Exact known USD subtotal: $15.00")
        expect(await page.evaluate<string>(`[...document.querySelectorAll('.usage-provider')].find(card => card.textContent.includes('OpenRouter'))?.innerText ?? ''`)).toContain("$38.42 remaining")
        expect(await page.evaluate<string>(`[...document.querySelectorAll('.usage-provider')].find(card => card.textContent.includes('OpenRouter'))?.innerText ?? ''`)).toContain("$0.00")
        const result = await page.evaluate<{ overflow: boolean; providerColumns: number; tileColumns: number; visualColumns: number; cardRadius: string; innerBorder: string; headHeight: number; mobileRows: number; requests: number; controls: boolean; content: number }>(`(() => {
          const providers = document.querySelector('.usage-providers'); const tiles = document.querySelector('.usage-tiles'); const visuals = document.querySelector('.usage-visuals');
          return { content: document.querySelector('.usage-page').clientWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            providerColumns: getComputedStyle(providers).gridTemplateColumns.split(' ').length,
            tileColumns: getComputedStyle(tiles).gridTemplateColumns.split(' ').length,
            visualColumns: getComputedStyle(visuals).gridTemplateColumns.split(' ').length,
            cardRadius: getComputedStyle(document.querySelector('.usage-provider')).borderTopLeftRadius,
            innerBorder: getComputedStyle(document.querySelector('.usage-window')).borderTopWidth,
            headHeight: document.querySelector('.usage-head').getBoundingClientRect().height,
            mobileRows: [...document.querySelectorAll('.usage-mobile-row')].filter(row => row.getClientRects().length > 0).length,
            requests: window.usageRequests().length,
            controls: [...document.querySelectorAll('.usage-page button')].filter(button => getComputedStyle(button).display !== 'none' && button.getClientRects().length > 0).every(button => button.getBoundingClientRect().height >= 44) } })()`)
        expect(result.overflow).toBe(false)
        expect(result.providerColumns).toBe(result.content >= 1280 ? 3 : result.content >= 768 ? 2 : 1)
        expect(result.tileColumns).toBe(result.content >= 1024 ? 3 : 1)
        expect(result.visualColumns).toBe(result.content >= 1024 ? 2 : 1)
        expect(result.cardRadius).toBe("0px")
        expect(result.innerBorder).toBe("0px")
        if (width! >= 768) expect(result.headHeight).toBeLessThan(100)
        expect(result.mobileRows).toBe(width! < 768 ? 25 : 0)
        if (width! < 768) expect(await page.evaluate<number>(`document.querySelectorAll('.usage-mobile-row .usage-provider-chip').length`)).toBe(25)
        expect(result.requests).toBe(1)
        expect(result.controls).toBe(true)
        await Bun.write(join(captures, `usage-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
        if (width === 390 && theme === "dark" || width === 1440 && theme === "light") {
          await page.evaluate(`document.querySelector('.usage-tiles')?.scrollIntoView()`)
          await Bun.sleep(120)
          await Bun.write(join(captures, `usage-tiles-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`document.querySelector('.usage-distribution')?.scrollIntoView()`)
          await Bun.sleep(400)
          await Bun.write(join(captures, `usage-donut-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`document.querySelector('.usage-chart')?.scrollIntoView()`)
          await Bun.sleep(120)
          await Bun.write(join(captures, `usage-chart-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`document.querySelector('.usage-breakdown')?.scrollIntoView()`)
          await Bun.sleep(120)
          await Bun.write(join(captures, `usage-breakdown-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
        }
        if (width === 390 && theme === "light") {
          expect(await page.evaluate<unknown>(`window.usageRequests().find(item => item.input?.monthly?.limit === 200)?.input?.monthly`)).toMatchObject({ group: "model", limit: 200, sort: "cost", order: "desc" })
          await page.evaluate(`document.querySelector('.usage-distribution .usage-toggle button:last-child')?.click()`)
          expect(await page.evaluate<string>(`document.querySelector('.usage-donut__total')?.textContent ?? ''`)).toBe("91,840")
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-donut__arc').length`)).toBe(3)
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-distribution__legend li').length`)).toBe(3)
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-distribution table, .usage-distribution__table-toggle').length`)).toBe(0)
          expect(await page.evaluate<string>(`document.querySelector('.usage-head p')?.textContent ?? ''`)).toContain("Studio Mac")
          expect(await page.evaluate<number>(`document.querySelectorAll('.usage-tile svg').length`)).toBe(1)
          await page.evaluate(`document.querySelector('.usage-chart__head button')?.click()`)
          expect(await page.evaluate<number>(`document.querySelectorAll('#usage-daily-table tbody tr').length`)).toBe(30)
          await selectSessionGroup(page)
          await wait(page, `document.querySelector('#usage-breakdown-panel tbody tr')?.textContent?.includes('Session') === true`)
          await page.evaluate(`document.querySelector('.usage-breakdown__table-toggle')?.click()`)
          expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.usage-breakdown__table')).display`)).not.toBe("none")
          await page.evaluate(`document.querySelector('.usage-breakdown button[aria-label="Sort by Cost"]')?.click()`)
          await page.evaluate(`document.querySelector('.usage-pagination button:last-child')?.click()`)
          expect(await page.evaluate<unknown>(`window.usageRequests().filter(item => item.input?.breakdown?.group === 'session').at(-1)?.input?.breakdown`)).toMatchObject({ group: "session", sort: "cost", order: "asc", offset: 25 })
          await page.evaluate(`document.querySelector('.usage-refresh')?.click()`)
          expect(await page.evaluate<unknown>(`window.usageRequests().filter(item => item.input?.refresh === true).at(-1)?.input?.refresh`)).toBe(true)
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

test("a connector without the dashboard operation is one update prompt with no Retry, and a rejected dashboard request is an error with Retry", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?old`)
    await wait(page, `document.querySelector('.usage-page')?.textContent?.includes('Update YCoding on this machine to see usage.') === true`)
    expect(await page.evaluate<boolean>(`document.querySelector('.usage-page [role="alert"]') === null && ![...document.querySelectorAll('.usage-page button')].some((button) => button.textContent.trim() === 'Retry')`)).toBe(true)
    expect(await page.evaluate<string[]>(`[...new Set(window.usageRequests().map((item) => item.operation))]`)).toEqual(["usage.dashboard"])
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?invalid`)
    await wait(page, `document.querySelector('.usage-page [role="alert"]')?.textContent?.includes('The usage request was rejected.') === true`)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.usage-page [role="alert"] button')].some((button) => button.textContent.trim() === 'Retry') && !document.querySelector('.usage-page').textContent.includes('Update YCoding')`)).toBe(true)
  } finally { await page.close() }
}, 20_000)

test("a run-out time already past reads as now, and an unavailable forecast read is not shown as no consumption", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?forecast=past`)
    await wait(page, `document.querySelector('.usage-quota-forecast')?.textContent?.includes('Estimated · run-out now · medium evidence') === true`)
    expect(await page.evaluate<boolean>(`!document.querySelector('.usage-page').textContent.includes('1970') && document.querySelector('.usage-page').textContent.includes('No recorded consumption in the observation window.')`)).toBe(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?forecast=quotas-absent`)
    await wait(page, `[...document.querySelectorAll('.usage-window__details')].some((item) => item.textContent.includes('Forecast unavailable · lookup failed; refresh quotas to retry'))`)
    expect(await page.evaluate<boolean>(`document.querySelector('.usage-quota-forecast') === null && document.querySelector('.usage-page').textContent.includes('No recorded consumption in the observation window.')`)).toBe(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?forecast=rates-absent`)
    await wait(page, `document.querySelector('.usage-quota-forecast') !== null && document.querySelector('.usage-consumption .loading-placeholder') === null`)
    expect(await page.evaluate<boolean>(`(() => { const text = document.querySelector('.usage-page').textContent; return !text.includes('No recorded consumption in the observation window.') && !text.includes('Recorded consumption unreported') && !text.includes('lookup unavailable') && document.querySelector('.usage-consumption__row') === null && document.querySelector('.usage-consumption .usage-message') === null })()`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("quota status stays concise, diagnostics open by keyboard, and exhausted, stale and unreported states stay distinct at every width and theme", async () => {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?forecast=states`)
      await wait(page, `document.querySelectorAll('.usage-consumption__row').length === 3 && document.querySelectorAll('.usage-quota-forecast').length > 3`)
      await page.evaluate(`document.fonts.ready`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      const closed = await page.evaluate<string>(`document.querySelector('.usage-page').innerText`)
      for (const hidden of ["half-life", "Warming up after restart", "Source provider API", "5m 15,000.25", "Recorded requests on this backend", "Reason:"]) expect(closed).not.toContain(hidden)
      for (const shown of ["Exhausted", "Forecast stale", "Forecast expired", "No increase observed", "Forecast unavailable", "low evidence", "12.3k tokens/min", "<1 tokens/min", "0 tokens/min", "$1.23/hour est.", "$0.0042/hour est."]) expect(closed).toContain(shown)
      for (const missing of ["cost rate unreported", "Known $0.0042/hour"]) expect(closed).not.toContain(missing)
      expect(closed).not.toContain("12,345.678")
      expect(await page.evaluate<boolean>(`!!document.querySelector('.usage-consumption__row button[aria-label*=" details"]') && !!document.querySelector('.usage-window--exhausted .usage-pace--exhausted')?.textContent.includes('exhausted') && !document.querySelector('dialog[open]')`)).toBe(true)
      const colors = await page.evaluate<{ exhausted: string; normal: string; danger: string }>(`(() => {
        const probe = document.createElement('i'); probe.style.color = 'var(--yc-danger)'; document.body.append(probe)
        const danger = getComputedStyle(probe).color; probe.remove()
        const fill = (window) => getComputedStyle(window.querySelector('.usage-meter > span')).backgroundColor
        return { exhausted: fill(document.querySelector('.usage-window--exhausted')), normal: fill(document.querySelector('.usage-window:not(.usage-window--exhausted):has(.usage-meter)')), danger }
      })()`)
      expect(colors.exhausted).toBe(colors.danger)
      expect(colors.normal).not.toBe(colors.danger)
      await page.evaluate(`document.querySelector('.usage-consumption__row button').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `document.querySelector('dialog.overlay--usage-details[open]') !== null`)
      const rateDetails = await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-details .overlay__body')?.innerText ?? ''`)
      for (const exact of ["Rate 12,345.678 tokens/min", "5m 15,000.25 tokens/min · 60m 9,876.5 tokens/min", "Estimated cost rate $1.23456/hour", "40 priced · 0 unpriced", "Observed 2023-11-14T22:13:20.000Z – 2023-11-14T23:13:20.000Z"]) expect(rateDetails).toContain(exact)
      await page.pressEscape()
      await wait(page, `document.querySelector('dialog.overlay--usage-details') === null`)
      await page.evaluate(`document.querySelectorAll('.usage-consumption__row button')[1].focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `document.querySelector('dialog.overlay--usage-details[open]') !== null`)
      const unreportedRateDetails = await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-details[open] .overlay__body')?.innerText ?? ''`)
      for (const exact of ["Profile provider default at request time", "0 priced · 7 unpriced"]) expect(unreportedRateDetails).toContain(exact)
      for (const missing of ["5m", "60m", "Estimated cost rate", "unreported"]) expect(unreportedRateDetails).not.toContain(missing)
      await page.pressEscape()
      await wait(page, `document.querySelector('dialog.overlay--usage-details') === null`)
      for (const index of [0, 1, 2]) {
        await page.evaluate(`document.querySelectorAll('.usage-provider > button[aria-label$=" details"]')[${index}].focus()`)
        await page.pressKey("Enter", "Enter", 13, "\r")
        await wait(page, `document.querySelector('dialog.overlay--usage-details[open]') !== null`)
        const dialog = await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-details[open]')?.innerText ?? ''`)
        expect(dialog).toContain(index === 0 ? "Source provider API · stability stable" : index === 1 ? "Source provider API · stability best effort" : "Source local client rpc · stability client contract")
        if (index === 0) for (const exact of ["Quota burn 10.25 percentage points/hour", "Projected at reset 83.5 percentage points", "Recent quota deltas · 15m half-life · 1h horizon · low evidence", "Observed ", "Updated "]) expect(dialog).toContain(exact)
        if (index === 1) for (const exact of ["Reason: Quota observations are stale", "Reason: Quota window has expired", "Reason: No increase observed"]) expect(dialog).toContain(exact)
        if (index === 2) expect(dialog).toContain("Reason: Warming up after restart")
        await page.pressEscape()
        await wait(page, `document.querySelector('dialog.overlay--usage-details') === null`)
      }
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelectorAll('.usage-provider > button[aria-label$=" details"]')[2]`)).toBe(true)
      const layout = await page.evaluate<{ overflow: boolean; clipped: boolean }>(`(() => ({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        clipped: [...document.querySelectorAll('.usage-consumption__row, .usage-consumption__row > *')].some((item) => item.scrollWidth > item.clientWidth + 1 || item.getBoundingClientRect().right > document.querySelector('.usage-page').getBoundingClientRect().right + 1),
      }))()`)
      expect(layout).toEqual({ overflow: false, clipped: false })
      await page.evaluate(`document.querySelector('.usage-consumption__list').scrollIntoView()`)
      await Bun.write(join(captures, `usage-consumption-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`document.querySelector('.usage-window--exhausted').scrollIntoView()`)
      await Bun.write(join(captures, `usage-exhausted-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 60_000)

test("quota and recorded-consumption Details open bounded dialogs without moving the Usage page", async () => {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) for (const reduced of [false, true]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, width === 390 ? 844 : 900)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?provider=muse`)
      await wait(page, `document.querySelector('.usage-provider h3')?.textContent === 'Muse (Meta)' && document.querySelector('.usage-consumption__row') !== null`)
      await page.evaluate(`document.fonts.ready`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      for (const selector of ['.usage-provider button[aria-label="Muse (Meta) details"]', '.usage-consumption__row button']) {
        await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`)
        const baseline = await page.evaluate<{ cards: readonly { label: string; x: number; y: number; width: number; height: number }[]; scrollHeight: number; scrollTop: number }>(`(() => ({
          cards: [...document.querySelectorAll('.usage-provider')].map(card => { const rect=card.getBoundingClientRect(); return { label:card.querySelector('h3')?.textContent ?? '', x:rect.x, y:rect.y, width:rect.width, height:rect.height } }),
          scrollHeight: document.scrollingElement.scrollHeight, scrollTop: document.scrollingElement.scrollTop,
        }))()`)
        expect(baseline.cards.length).toBeGreaterThanOrEqual(4)
        expect(baseline.cards[0]?.label).toBe("Muse (Meta)")
        if (width === 1440) expect(new Set(baseline.cards.map((card) => Math.round(card.y))).size).toBeGreaterThanOrEqual(2)
        if (width === 390) expect(baseline.cards.slice(1).filter((card) => card.y > baseline.cards[0]!.y).length).toBeGreaterThanOrEqual(2)
        await page.evaluate(`(() => { const button=document.querySelector(${JSON.stringify(selector)}); button.focus(); button.dispatchEvent(new MouseEvent('click', { bubbles:true, detail:${selector.includes("usage-consumption") ? 1 : 0} })); })()`)
        await wait(page, `document.querySelector('dialog.overlay--usage-details[open]') !== null`)
        await page.evaluate(`Promise.all(document.querySelector('dialog.overlay--usage-details').getAnimations({subtree:true}).map(animation => animation.finished.catch(() => undefined)))`)
        const dialog = await page.evaluate<{ label: string; title: string; closeCount: number; closeName: string; closeInHeader: boolean; focused: boolean; modal: boolean; visible: boolean; contained: boolean; pointerFocus: boolean; triggerHasPopup: string | null; surface: { left: number; top: number; right: number; bottom: number }; cards: readonly { label: string; x: number; y: number; width: number; height: number }[]; scrollHeight: number; scrollTop: number }>(`(() => {
          const node=document.querySelector('dialog.overlay--usage-details'), rect=node.getBoundingClientRect(), surface=node.querySelector('.overlay__surface'), bounds=surface.getBoundingClientRect(), buttons=[...node.querySelectorAll('button[aria-label^="Close "]')];
          return { label:node.getAttribute('aria-label'), title:node.querySelector('.overlay__title')?.textContent, closeCount:buttons.length, closeName:buttons[0]?.getAttribute('aria-label'), closeInHeader:buttons[0]?.parentElement?.classList.contains('overlay__head') === true,
            focused:node.contains(document.activeElement), modal:node.matches(':modal'), visible:bounds.width>0&&bounds.height>0,
            pointerFocus:buttons[0]?.hasAttribute('data-pointer-focus') === true, triggerHasPopup:document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-haspopup') ?? null,
            contained:bounds.left>=-1&&bounds.right<=innerWidth+1&&bounds.top>=-1&&bounds.bottom<=innerHeight+1, surface:{left:bounds.left,top:bounds.top,right:bounds.right,bottom:bounds.bottom},
            cards:[...document.querySelectorAll('.usage-provider')].map(card=>{const cardRect=card.getBoundingClientRect();return{label:card.querySelector('h3')?.textContent??'',x:cardRect.x,y:cardRect.y,width:cardRect.width,height:cardRect.height}}),
            scrollHeight:document.scrollingElement.scrollHeight,scrollTop:document.scrollingElement.scrollTop };
        })()`)
        expect(dialog.label).toBe(selector.includes("usage-provider") ? "Muse (Meta) details" : "muse · muse-model · profile Muse details")
        expect(dialog.title).toBe(dialog.label)
        expect(dialog.closeCount).toBe(1)
        expect(dialog.closeName).toBe(`Close ${dialog.label}`)
        expect(dialog.closeInHeader).toBe(true)
        expect(dialog.focused).toBe(true)
        expect(dialog.modal).toBe(true)
        expect(dialog.visible).toBe(true)
        expect(dialog.contained, JSON.stringify(dialog)).toBe(true)
        expect(dialog.pointerFocus).toBe(selector.includes("usage-consumption"))
        expect(dialog.triggerHasPopup).toBe("dialog")
        expect(dialog.cards).toEqual(baseline.cards)
        expect(dialog.scrollHeight).toBe(baseline.scrollHeight)
        expect(dialog.scrollTop).toBe(baseline.scrollTop)
        const body = await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-details .overlay__body')?.innerText ?? ''`)
        if (selector.includes("usage-provider")) {
          for (const line of ["Source response stream · stability observed", "Updated ", "5-hour window", "Weekly", "No supported method · insufficient evidence", "Muse quota observations are warming up"]) expect(body).toContain(line)
        } else {
          for (const line of ["Rate 120 tokens/min", "5m 180 tokens/min · 60m 120 tokens/min", "0 priced · 3 unpriced", "Observed ", "not account quota or generation speed"]) expect(body).toContain(line)
        }
        if (width === 390 || width === 1440) {
          await Bun.write(join(captures, `usage-details-${width}-${theme}-${reduced ? "reduced" : "normal"}-${selector.includes("usage-provider") ? "quota" : "recorded"}.png`), Buffer.from(await page.screenshot(), "base64"))
        }
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog.overlay--usage-details')?.contains(document.activeElement) === true`)).toBe(true)
        await page.pressEscape()
        await wait(page, `document.querySelector('dialog.overlay--usage-details') === null`)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog.overlay--usage-details[open]') === null && document.activeElement === document.querySelector(${JSON.stringify(selector)})`)).toBe(true)
        expect(await page.evaluate<{ scrollHeight: number; scrollTop: number }>(`({ scrollHeight:document.scrollingElement.scrollHeight, scrollTop:document.scrollingElement.scrollTop })`)).toEqual({ scrollHeight: baseline.scrollHeight, scrollTop: baseline.scrollTop })
      }
    } finally { await page.close() }
  }
}, 90_000)

test("Muse pending quota card names the configured provider without numeric quota and shows reported zero after refresh", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?provider=muse-pending`)
    await wait(page, `document.querySelector('[data-provider-id="muse"] .usage-provider__empty')?.textContent === 'Quota is reported after the next Muse response'`)
    const pending = await page.evaluate<{ heading: string; plan: string; text: string; windows: number; meters: number; headings: string[] }>(`(() => {
      const card = document.querySelector('[data-provider-id="muse"]')
      return { heading: card.querySelector('h3')?.textContent ?? '', plan: card.querySelector('.usage-provider__plan')?.textContent ?? '', text: card.innerText ?? '',
        windows: card.querySelectorAll('.usage-window').length, meters: card.querySelectorAll('.usage-meter').length,
        headings: [...document.querySelectorAll('.usage-provider h3')].map((item) => item.textContent.trim()) }
    })()`)
    expect(pending.heading).toBe("Muse (Meta)")
    expect(pending.plan).toBe("Muse")
    expect(pending.windows).toBe(0)
    expect(pending.meters).toBe(0)
    expect(pending.text).not.toContain("%")
    expect(pending.headings).not.toContain("Other provider")
    expect(pending.headings).toContain("Disconnected provider")
    await page.evaluate(`document.querySelector('.usage-refresh')?.click()`)
    await wait(page, `document.querySelector('[data-provider-id="muse"]')?.textContent?.includes('0% used') === true && document.querySelector('[data-provider-id="muse"]')?.textContent?.includes('64% used') === true`)
    expect(await page.evaluate<number>(`document.querySelector('[data-provider-id="muse"]')?.querySelectorAll('.usage-meter').length ?? 0`)).toBe(2)
    expect(await page.evaluate<number>(`document.querySelector('[data-provider-id="muse"]')?.querySelectorAll('.usage-provider__empty').length ?? 0`)).toBe(0)
  } finally { await page.close() }
})

test("usage waits for a connected machine and loads after connection opens", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?offline`)
    await wait(page, `document.querySelector('.usage-page')?.textContent?.includes('Connect to a machine to see usage.') === true`)
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(0)
    expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page .loading-placeholder').length`)).toBe(0)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.usage-page [role="status"]')].filter((item) => !item.closest('.incidents')).map(item => item.textContent)`)).toEqual(["Connect to a machine to see usage.", "Connect to a machine to see recorded consumption."])
    await page.evaluate(`window.usageConnect()`)
    await wait(page, `document.querySelectorAll('.usage-provider').length === 6`)
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(1)
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

test("quota refresh returns to idle after a failed provider read", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?unknown-usage`)
    await wait(page, `document.querySelectorAll('.usage-provider').length === 6`)
    await page.evaluate(`window.usageAgentBack(true)`)
    await page.evaluate(`document.querySelector('.usage-refresh')?.click()`)
    await wait(page, `window.usageRequests().length === 2`)
    await wait(page, `document.querySelector('.usage-page [role="alert"]')?.textContent?.includes('Usage retry failed.') === true`)
    expect(await page.evaluate<{ busy: string | null; disabled: boolean }>(`(() => { const button = document.querySelector('.usage-refresh'); return { busy: button.getAttribute('aria-busy'), disabled: button.disabled }; })()`)).toEqual({ busy: "false", disabled: false })
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
      await wait(page, `window.usageRequests().some(item => item.input?.breakdown?.offset === 25)`)
      const during = await page.evaluate<{ scroll: number; height: number; nodes: boolean; rows: number; busy: string | null }>(`({
        scroll: document.scrollingElement.scrollTop, height: document.scrollingElement.scrollHeight,
        nodes: window.usageNodes.header === document.querySelector('.usage-head') && window.usageNodes.tiles === document.querySelector('.usage-tiles') &&
          window.usageNodes.charts === document.querySelector('.usage-visuals') && window.usageNodes.table === document.querySelector('.usage-breakdown table'),
        rows: document.querySelectorAll('.usage-breakdown tbody tr').length,
        busy: document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') ?? null
      })`)
      if (width === 390 && theme === "light") await Bun.write(join(captures, "usage-paging-pending.png"), Buffer.from(await page.screenshot(), "base64"))
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

test("accounting renders while quota is preparing, and quota arrival fills providers without remounting accounting or resetting the sort", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?quota-preparing`)
    await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25 && document.querySelectorAll('.usage-tile').length === 3 && document.querySelectorAll('.usage-donut__arc').length === 2`)
    expect(await page.evaluate<{ providers: number; labels: string[] }>(`({ providers: document.querySelectorAll('.usage-provider').length, labels: [...document.querySelectorAll('.usage-page .loading-placeholder')].map((item) => item.textContent.trim()) })`)).toEqual({ providers: 0, labels: ["Preparing provider quotas…", "Preparing recorded consumption…"] })
    await page.evaluate(`window.usageNodes = { header: document.querySelector('.usage-head'), tiles: document.querySelector('.usage-tiles'), charts: document.querySelector('.usage-visuals'), table: document.querySelector('.usage-breakdown table') }; document.querySelector('.usage-breakdown button[aria-label="Sort by Cost"]')?.click()`)
    await wait(page, `window.usageRequests().some(item => item.input?.breakdown?.order === 'asc')`)
    await wait(page, `document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
    await page.evaluate(`window.usageNodes = { header: document.querySelector('.usage-head'), tiles: document.querySelector('.usage-tiles'), charts: document.querySelector('.usage-visuals'), table: document.querySelector('.usage-breakdown table') }; window.usageReleaseQuota()`)
    await wait(page, `document.querySelectorAll('.usage-provider').length === 6 && document.querySelectorAll('.usage-page .loading-placeholder').length === 0`)
    expect(await page.evaluate<boolean>(`window.usageNodes.header === document.querySelector('.usage-head') && window.usageNodes.tiles === document.querySelector('.usage-tiles') && window.usageNodes.charts === document.querySelector('.usage-visuals') && window.usageNodes.table === document.querySelector('.usage-breakdown table')`)).toBe(true)
    expect(await page.evaluate<unknown>(`window.usageRequests().at(-1).input.breakdown.order`)).toBe("asc")
    const before = await page.evaluate<number>(`window.usageRequests().length`)
    await Bun.sleep(1_500)
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(before)
  } finally { await page.close() }
}, 30_000)

test("a quota error replaces the provider and consumption content with its message, leaves accounting, stops polling, and keeps Refresh enabled", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?quota-error`)
    await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25 && document.querySelectorAll('.usage-tile').length === 3 && document.querySelectorAll('.usage-donut__arc').length === 2`)
    await wait(page, `[...document.querySelectorAll('.usage-page [role="alert"]')].filter((item) => item.textContent.includes('Provider quotas are unavailable right now.')).length === 2`)
    expect(await page.evaluate<{ providers: number; placeholders: number; refreshDisabled: boolean; consumption: boolean }>(`({ providers: document.querySelectorAll('.usage-provider').length, placeholders: document.querySelectorAll('.usage-page .loading-placeholder').length, refreshDisabled: document.querySelector('.usage-refresh').disabled, consumption: document.querySelector('.usage-consumption')?.textContent?.includes('Provider quotas are unavailable right now.') === true })`)).toEqual({ providers: 0, placeholders: 0, refreshDisabled: false, consumption: true })
    const before = await page.evaluate<number>(`window.usageRequests().length`)
    await Bun.sleep(1_500)
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(before)
  } finally { await page.close() }
}, 30_000)

test("a failed next-page read retains the table and shows an inline error", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?paged&page-error`)
    await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
    await page.evaluate(`document.querySelector('.usage-pagination button:last-child')?.click()`)
    await wait(page, `window.usageRequests().some(item => item.input?.breakdown?.offset === 25)`)
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
    await page.evaluate(`document.querySelector('.usage-breakdown button[aria-label="Sort by Cost"]')?.click()`)
    await wait(page, `window.usageRequests().some(item => item.input?.breakdown?.order === 'asc')`)
    expect(await page.evaluate<boolean>(`window.usageTable === document.querySelector('.usage-breakdown table') && document.querySelectorAll('.usage-breakdown tbody tr').length === 25 && document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') === 'true'`)).toBe(true)
    await page.evaluate(`window.usageReleasePage()`)
    await wait(page, `document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') === 'false'`)
    await selectSessionGroup(page)
    await wait(page, `window.usageRequests().some(item => item.input?.breakdown?.group === 'session')`)
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
      expect(daily.text).not.toMatch(/unreported|Estimated cost/)
      expect(daily.text).not.toContain("$0.00")
      expect(daily.inside).toBe(true)
      expect(daily.distance).toBeLessThan(25)
      expect(daily.name).toContain("requests")
      expect(daily.name).not.toContain("unreported")
      if (width === 390 && theme === "light") {
        await page.evaluate(`document.querySelector('.usage-chart')?.scrollIntoView({ block: 'center' })`)
        await Bun.sleep(200)
        await Bun.write(join(captures, "usage-day-tooltip.png"), Buffer.from(await page.screenshot(), "base64"))
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
        await Bun.write(join(captures, "usage-provider-tooltip.png"), Buffer.from(await page.screenshot(), "base64"))
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
      expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(1)
    } finally { await page.close() }
  }
}, 180_000)

test("three same-device reloads and Refresh update values without removing cards or replaying entrances", async () => {
  for (const [width, height] of [[390, 844], [820, 1180], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?refresh-cycle`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 6 && document.querySelectorAll('.usage-tile').length === 3 && document.querySelectorAll('.usage-donut__arc').length === 2`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await Bun.sleep(900)
      const refresh = await page.evaluate<{ accessibleName: string | null; title: string | null; text: string; idle: string | null; target: number; width: number; icon: boolean }>(`(() => {
        const button = document.querySelector('.usage-refresh');
        const rect = button.getBoundingClientRect();
        return { accessibleName: button.getAttribute('aria-label'), title: button.getAttribute('title'), text: button.innerText.trim(),
          idle: button.getAttribute('aria-busy'), target: rect.height, width: rect.width,
          icon: !!button.querySelector('svg[aria-hidden="true"]') };
      })()`)
      expect(refresh).toMatchObject({ accessibleName: "Refresh quotas", title: "Refresh quotas", text: "", idle: "false", icon: true })
      expect(refresh.target).toBeGreaterThanOrEqual(44)
      if (width === 390) expect(refresh.width).toBe(refresh.target)
      await page.evaluate(`(() => {
        const selectors = '.usage-provider, .usage-tile, .usage-chart, .usage-distribution, .usage-meter > span, .usage-donut__arc, .usage-distribution__legend li, .usage-chart__bar';
        const root = document.querySelector('.usage-page');
        const nodes = [...root.querySelectorAll(selectors)];
        const probe = { nodes, removed: 0, starts: 0, empty: 0 };
        root.addEventListener('animationstart', event => { if (!event.target.closest('.usage-refresh')) probe.starts++ });
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
        await wait(page, `window.usageRequests().length === ${cycle + 1}`)
        const pending = await page.evaluate<{ removed: number; starts: number; empty: number; same: boolean; providers: number; tiles: number; session: string; today: string; donut: string; height: number }>(`window.usageProbeSnapshot()`)
        if (cycle === 1 && width === 390 && theme === "light") await Bun.write(join(captures, "usage-reconnect-pending.png"), Buffer.from(await page.screenshot(), "base64"))
        expect(pending).toMatchObject({ removed: 0, starts: 0, empty: 0, same: true, providers: 6, tiles: 3, today: cycle === 1 ? "$5.40" : `$${(5.4 + cycle - 1).toFixed(2)}`, donut: cycle === 1 ? "$15.00" : `$${(15 + 3 * (cycle - 1)).toFixed(2)}`, height: baseline.height })
        await page.evaluate(`window.usageReleaseReload()`)
        await wait(page, `document.querySelector('.usage-provider:first-child .usage-window__top')?.textContent?.includes('${38 + cycle}%') === true`)
        const settled = await page.evaluate<{ removed: number; starts: number; empty: number; same: boolean; providers: number; tiles: number; today: string; donut: string; height: number }>(`window.usageProbeSnapshot()`)
        expect(settled).toMatchObject({ removed: 0, starts: 0, empty: 0, same: true, providers: 6, tiles: 3, today: `$${(5.4 + cycle).toFixed(2)}`, donut: `$${(15 + 3 * cycle).toFixed(2)}`, height: baseline.height })
      }
      await page.evaluate(`document.querySelector('.usage-refresh')?.click()`)
      await wait(page, `window.usageRequests().length === 5`)
      expect(await page.evaluate<{ busy: string | null; disabled: boolean; animation: string }>(`(() => {
        const button = document.querySelector('.usage-refresh');
        return { busy: button.getAttribute('aria-busy'), disabled: button.disabled, animation: getComputedStyle(button.querySelector('svg')).animationName };
      })()`)).toEqual({ busy: "true", disabled: true, animation: "usage-refresh-spin" })
      expect(await page.evaluate<{ removed: number; starts: number; empty: number; same: boolean }>(`window.usageProbeSnapshot()`)).toMatchObject({ removed: 0, starts: 0, empty: 0, same: true })
      await page.evaluate(`window.usageReleaseReload()`)
      await wait(page, `document.querySelector('.usage-provider:first-child .usage-window__top')?.textContent?.includes('42%') === true`)
      expect(await page.evaluate<string | null>(`document.querySelector('.usage-refresh')?.getAttribute('aria-busy') ?? null`)).toBe("false")
      expect(await page.evaluate<{ removed: number; starts: number; empty: number; same: boolean }>(`window.usageProbeSnapshot()`)).toMatchObject({ removed: 0, starts: 0, empty: 0, same: true })
      if (width === 390 && theme === "dark") await Bun.write(join(captures, "usage-refresh-settled.png"), Buffer.from(await page.screenshot(), "base64"))
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
      await Bun.write(join(captures, `usage-large-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 180_000)

test("a device switch, explicit disconnect, or sign-out clears the previous machine's usage", async () => {
  for (const action of ["usageSwitchDevice", "usageDisconnect", "usageSignOut"]) {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?refresh-cycle`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 6 && document.querySelectorAll('.usage-tile').length === 3`)
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
      await wait(page, `window.usageRequests().some(item => item.input?.daily?.timeZone === ${JSON.stringify(zone)})`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-chart h3')?.textContent ?? ''`)).toContain(zone)
      expect(await page.evaluate<string>(`document.querySelector('.usage-distribution h3')?.textContent ?? ''`)).toContain(zone)
      expect(await page.evaluate<string>(`document.querySelector('.usage-head [aria-label="Usage time zone"] button:last-child')?.getAttribute('aria-pressed') ?? ''`)).toBe("true")
      const bounds = await page.evaluate<{ day: { from: number; to: number }; month: { from: number }; breakdown: { from: number; to: number }; overflow: boolean }>(`(() => {
        const request = window.usageRequests().filter(item => item.input?.daily?.timeZone === ${JSON.stringify(zone)}).at(-1).input;
        const day = request.daily;
        const month = request.monthly;
        const breakdown = request.breakdown;
        return { day: { from: day.from, to: day.to }, month: { from: month.from }, breakdown: { from: breakdown.from, to: breakdown.to }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`)
      expect(bounds.breakdown).toEqual(bounds.day)
      expect(bounds.month.from).toBeLessThan(bounds.day.to)
      expect(bounds.overflow).toBe(false)
      if (width === 390) await Bun.write(join(captures, "usage-local-390.png"), Buffer.from(await page.screenshot(), "base64"))
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
      await wait(page, `document.querySelectorAll('.usage-donut__arc').length === 2`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-head [aria-label="Usage time zone"] button:last-child')?.getAttribute('aria-pressed') ?? ''`)).toBe("true")
      await page.evaluate(`window.usageDowngrade()`)
      await wait(page, `document.querySelector('.usage-chart .usage-message')?.textContent?.includes('Update YCoding') === true`)
      expect(await page.evaluate<{ tiles: number; arcs: number; rows: number }>(`({ tiles: document.querySelectorAll('.usage-tile').length, arcs: document.querySelectorAll('.usage-donut__arc').length, rows: document.querySelectorAll('.usage-breakdown tbody tr').length })`)).toEqual({ tiles: 0, arcs: 0, rows: 0 })
      await page.evaluate(`document.querySelector('[aria-label="Usage time zone"] button:first-child')?.click()`)
      await wait(page, `document.querySelector('.usage-chart h3')?.textContent?.includes('UTC') === true`)
      expect(await page.evaluate<{ message: boolean; tiles: number }>(`({ message: document.querySelector('.usage-chart .usage-message')?.textContent?.includes('Update YCoding') === true, tiles: document.querySelectorAll('.usage-tile').length })`)).toEqual({ message: true, tiles: 0 })
    } finally { await page.close() }
  }
  const old = await browser!.openPage()
  try {
    await old.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?old`)
    await wait(old, `document.querySelector('.usage-chart .usage-message')?.textContent?.includes('Update YCoding') === true`)
    await old.evaluate(`document.querySelector('[aria-label="Usage time zone"] button:last-child')?.click()`)
    await wait(old, `document.querySelector('.usage-chart h3')?.textContent?.includes('Local') === true`)
    expect(await old.evaluate<{ message: string; tiles: number }>(`({ message: document.querySelector('.usage-chart .usage-message')?.textContent ?? '', tiles: document.querySelectorAll('.usage-tile').length })`)).toEqual({ message: "Update YCoding on this machine to see usage.", tiles: 0 })
    await old.evaluate(`document.querySelector('[aria-label="Usage time zone"] button:first-child')?.click()`)
  } finally { await old.close() }
}, 180_000)

test("unknown Usage reads keep good panels while one recovery read settles, then replace them with one failed-retry error", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?unknown-usage`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 6 && document.querySelectorAll('.usage-tile').length === 3 && document.querySelectorAll('.usage-donut__arc').length === 2`)
      await page.evaluate(`window.usageOutage()`)
      expect(await page.evaluate<{ providers: number; tiles: number; arcs: number; rows: number; alerts: number; requests: number }>(`({
        providers: document.querySelectorAll('.usage-provider').length, tiles: document.querySelectorAll('.usage-tile').length,
        arcs: document.querySelectorAll('.usage-donut__arc').length, rows: document.querySelectorAll('.usage-breakdown tbody tr').length,
        alerts: document.querySelectorAll('.usage-page [role="alert"]').length, requests: window.usageRequests().length,
      })`)).toEqual({ providers: 6, tiles: 3, arcs: 2, rows: 25, alerts: 0, requests: 2 })
      await page.evaluate(`window.usageAgentBack(false)`)
      await wait(page, `window.usageRequests().length === 3`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page [role="alert"]').length`)).toBe(0)
      await page.evaluate(`window.usageOutage()`)
      await page.evaluate(`window.usageAgentBack(true)`)
      await wait(page, `window.usageRequests().length === 5`)
      expect(await page.evaluate<{ providers: number; tiles: number; arcs: number; rows: number; alerts: string[] }>(`({
        providers: document.querySelectorAll('.usage-provider').length, tiles: document.querySelectorAll('.usage-tile').length,
        arcs: document.querySelectorAll('.usage-donut__arc').length, rows: document.querySelectorAll('.usage-breakdown tbody tr').length,
        alerts: [...document.querySelectorAll('.usage-page [role="alert"]')].map(item => item.textContent ?? ''),
      })`)).toEqual({ providers: 0, tiles: 0, arcs: 0, rows: 0, alerts: [expect.stringContaining("Usage retry failed.")] })
    } finally { await page.close() }
  }
}, 180_000)

test("first Usage reads reserve visible placeholders without replacing settled cards or refresh data", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?initial-loading&refresh-cycle`)
      await wait(page, `window.usageRequests().length === 1 && document.querySelectorAll('.usage-page .loading-placeholder').length === 5`)
      const pending = await page.evaluate<{ kinds: string[]; labels: string[]; statuses: number; heights: number[]; cards: number[]; monthlyReserve: number; overflow: boolean }>(`(() => {
        const placeholders = [...document.querySelectorAll('.usage-page .loading-placeholder')];
        return { kinds: placeholders.map(item => [...item.classList].find(name => name.startsWith('loading-placeholder--'))), labels: placeholders.map(item => item.textContent.trim()),
          statuses: [...document.querySelectorAll('.usage-page [role="status"]')].filter((item) => !item.closest('.incidents')).length,
          heights: placeholders.map(item => item.getBoundingClientRect().height),
          cards: [...document.querySelectorAll('.usage-chart, .usage-distribution')].map(item => item.getBoundingClientRect().height),
          monthlyReserve: document.querySelectorAll('.usage-distribution .loading-placeholder__shape')[0]?.getBoundingClientRect().height ?? 0,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`)
      expect(pending.kinds).toEqual(["loading-placeholder--usage", "loading-placeholder--chart", "loading-placeholder--chart", "loading-placeholder--usage", "loading-placeholder--usage"])
      expect(pending.labels).toEqual(["Loading provider quotas…", "Loading daily spend…", "Loading monthly usage…", "Loading recorded consumption…", "Loading breakdown…"])
      expect(pending.statuses).toBe(5)
      expect(pending.heights.every((height) => height >= 64)).toBe(true)
      expect(pending.monthlyReserve).toBeGreaterThanOrEqual(width === 390 ? 400 : 280)
      expect(pending.overflow).toBe(false)
      await page.evaluate(`window.usageCards = [...document.querySelectorAll('.usage-chart, .usage-distribution, .usage-breakdown')]; window.usageReleaseInitial()`)
      await wait(page, `document.querySelectorAll('.usage-provider').length === 6 && document.querySelectorAll('.usage-donut__arc').length === 2 && document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
      const settled = await page.evaluate<{ placeholders: number; sameCards: boolean; cards: number[]; overflow: boolean }>(`({
        placeholders: document.querySelectorAll('.usage-page .loading-placeholder').length,
        sameCards: window.usageCards.every(node => node.isConnected && document.querySelector('.usage-page')?.contains(node)),
        cards: [...document.querySelectorAll('.usage-chart, .usage-distribution')].map(item => item.getBoundingClientRect().height),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      })`)
      expect(settled).toMatchObject({ placeholders: 0, sameCards: true, overflow: false })
      expect(settled.cards.map((height, index) => Math.abs(height - pending.cards[index]!)).every((difference) => difference <= 64)).toBe(true)
      await page.evaluate(`window.usageReconnect()`)
      await wait(page, `window.usageRequests().length === 2`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page .loading-placeholder').length`)).toBe(0)
      await page.evaluate(`window.usageReleaseReload()`)
      await wait(page, `document.querySelector('.usage-provider:first-child .usage-window__top')?.textContent?.includes('39%') === true`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.usage-page .loading-placeholder').length`)).toBe(0)
    } finally { await page.close() }
  }
}, 180_000)

test("the generation overview states live, monthly, estimated, and unreported figures and reflows without overflow", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?live`)
      await wait(page, `document.querySelectorAll('.usage-figure').length === 9 && document.querySelectorAll('[data-chart="live-rate"] polyline').length > 0`)
      const figures = await page.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('.usage-figure')].map(item => [item.dataset.figure, item.innerText.replace(/\\s+/g, ' ')]))`)
      expect((figures.active ?? "").toLowerCase()).toContain("active generations 2")
      expect(figures.live).toContain("≈ 42.5 tok/s")
      expect(figures.average).toContain("36.1 tok/s")
      expect(figures.average).toContain("Mean of 15 per-request rates")
      expect(figures.ttft).toContain("p50 330 ms · p95 940 ms")
      expect(figures.requests).toContain("14")
      expect(figures.outcomes).toContain("13 completed · 1 failed · 0 cancelled")
      expect(figures.cost).toContain("Estimate")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector('.usage-live-models')?.innerText ?? ''`)).toContain("gpt-6-sol")
    } finally { await page.close() }
  }
  const idle = await browser!.openPage()
  try {
    await idle.setViewport(1440, 900)
    await idle.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
    await wait(idle, `document.querySelectorAll('.usage-figure').length === 9`)
    expect(await idle.evaluate<string>(`document.querySelector('[data-figure="live"]').innerText`)).toContain("Idle")
    expect(await idle.evaluate<string>(`document.querySelector('[data-chart="live-rate"]').innerText`)).toContain("No live output")
  } finally { await idle.close() }
}, 60_000)

test("performance trends render each daily series with exact values in a table and no overflow", async () => {
  for (const width of [390, 820, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
      await wait(page, `document.querySelectorAll('.usage-trends [data-chart]').length === 7`)
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.usage-trends [data-chart]')].map(item => item.dataset.chart)`)).toEqual(["requests", "tokens", "ttft", "latency", "errors", "throughput", "concurrency"])
      expect(await page.evaluate<number>(`document.querySelectorAll('[data-chart="tokens"] .usage-series__legend li').length`)).toBe(5)
      expect(await page.evaluate<number>(`document.querySelectorAll('[data-chart="errors"] rect[data-series="errorRate"]').length`)).toBe(30)
      expect(await page.evaluate<number>(`document.querySelectorAll('[data-chart="ttft"] polyline[data-series="p95"]').length`)).toBeGreaterThan(1)
      await page.evaluate(`document.querySelector('[data-chart="ttft"] .usage-series__head button').click()`)
      expect(await page.evaluate<number>(`document.querySelectorAll('[data-chart="ttft"] tbody tr').length`)).toBe(30)
      expect(await page.evaluate<string>(`document.querySelector('[data-chart="ttft"] tbody tr:nth-child(5) td')?.textContent ?? 'missing'`)).toBe("")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.usage-trends .usage-series')].every(item => item.getBoundingClientRect().right <= document.querySelector('.usage-trends').getBoundingClientRect().right + 1)`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("model speed comparison ranks measurable models, and the breakdown adds speed columns with empty cells and provider drill-down", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
    await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25 && document.querySelectorAll('[data-model-speed]').length === 3`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[data-model-speed]')].map(item => item.dataset.modelSpeed)`)).toEqual(["openrouter/deepseek-v4", "openai/gpt-5", "openai/gpt-6-sol"])
    expect(await page.evaluate<string>(`document.querySelector('[data-model-speed] strong').textContent`)).toBe("37 tok/s")
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.usage-breakdown thead th')].map(item => item.textContent.replace(/[↑↓↕]/g, '').trim()).slice(-4)`)).toEqual(["Cost", "Avg tok/s", "Agg tok/s", "P95 TTFT"])
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.usage-breakdown tbody tr:nth-child(5) td')].slice(-3).map(item => item.textContent)`)).toEqual(["", "", ""])
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.usage-breakdown tbody tr:nth-child(1) td')].slice(-3).map(item => item.textContent)`)).toEqual(["35 tok/s", "33 tok/s", "900 ms"])
    await selectSessionGroup(page, "Provider")
    await wait(page, `document.querySelectorAll('.usage-drill').length > 0`)
    await page.evaluate(`document.querySelector('.usage-drill').click()`)
    await wait(page, `window.usageRequests().some(item => item.input?.breakdown?.group === 'provider-model' && item.input.breakdown.providerID === 'openai')`)
    await wait(page, `document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.usage-drill').length === 0`)
    await wait(page, `window.usageRequests().some(item => item.input?.daily?.providerID === 'openai' && !item.input.monthly?.providerID)`)
    expect(await page.evaluate<string>(`document.querySelector('.usage-spend__scope')?.textContent ?? ''`)).toContain("Provider Codex")
    expect(await page.evaluate<string>(`document.querySelector('.usage-visuals .usage-chart__head p')?.textContent ?? ''`)).toContain("Provider Codex")
    expect(await page.evaluate<string>(`document.querySelector('[data-chart="requests"] .usage-series__head p')?.textContent ?? ''`)).toContain("Provider Codex")
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
  } finally { await page.close() }
}, 60_000)

test("live polling runs only while generations are active, keeps mounted tables, sort and scroll, and stops when idle", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?live`)
    await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25 && document.querySelectorAll('.usage-figure').length === 9`)
    await page.evaluate(`document.querySelector('button[aria-label="Sort by Output"]').click()`)
    await wait(page, `window.usageRequests().some(item => item.input?.breakdown?.sort === 'output') && document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') === 'false'`)
    await page.evaluate(`(() => { document.querySelector('.usage-pagination').scrollIntoView({ block: 'center' }); window.usageNodes = { table: document.querySelector('.usage-breakdown table'), row: document.querySelector('.usage-breakdown tbody tr'), figures: document.querySelector('.usage-figures') }; window.usageScroll = document.scrollingElement.scrollTop })()`)
    const before = await page.evaluate<number>(`window.usageRequests().length`)
    const busy: (string | null)[] = []
    const polled = await page.evaluate<number>(`window.usageRequests().length`)
    for (let index = 0; index < 60 && (await page.evaluate<number>(`window.usageRequests().length`)) < polled + 2; index++) {
      busy.push(await page.evaluate<string | null>(`document.querySelector('.usage-breakdown')?.getAttribute('aria-busy') ?? null`))
      busy.push(await page.evaluate<string | null>(`document.querySelector('.usage-refresh')?.getAttribute('aria-busy') ?? null`))
      await Bun.sleep(100)
    }
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBeGreaterThanOrEqual(polled + 2)
    expect(busy.every((value) => value === "false")).toBe(true)
    expect(await page.evaluate<boolean>(`window.usageNodes.table === document.querySelector('.usage-breakdown table') && window.usageNodes.row === document.querySelector('.usage-breakdown tbody tr') && window.usageNodes.figures === document.querySelector('.usage-figures')`)).toBe(true)
    expect(await page.evaluate<boolean>(`Math.abs(document.scrollingElement.scrollTop - window.usageScroll) < 2`)).toBe(true)
    expect(await page.evaluate<boolean>(`!document.querySelector('.usage-pagination button:last-child').disabled`)).toBe(true)
    expect(await page.evaluate<unknown>(`window.usageRequests().at(-1).input.breakdown.sort`)).toBe("output")
    expect(await page.evaluate<boolean>(`window.usageRequests().slice(${before}).every(item => item.operation === 'usage.dashboard')`)).toBe(true)
    await page.evaluate(`window.usageSetLive(0)`)
    await wait(page, `document.querySelector('[data-figure="live"]').innerText.includes('Idle')`)
    expect(await page.evaluate<string>(`document.querySelector('[data-figure="active"]').innerText`)).toContain("0")
    await Bun.sleep(500)
    const settled = await page.evaluate<number>(`window.usageRequests().length`)
    await Bun.sleep(4_500)
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(settled)
    expect(await page.evaluate<boolean>(`window.usageNodes.table === document.querySelector('.usage-breakdown table')`)).toBe(true)
  } finally { await page.close() }
}, 90_000)

async function selectSessionGroup(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, label = "Sessions") {
  const phone = await page.evaluate<boolean>(`!!document.querySelector('.usage-filter-bar__trigger')`)
  if (phone) {
    await page.evaluate(`document.querySelector('.usage-filter-bar__trigger').click()`)
    await wait(page, `!!document.querySelector('dialog.overlay--usage-filters[open]')`)
  }
  await page.evaluate(`document.querySelector('[aria-label="Usage group"]').click()`)
  await wait(page, `!!document.querySelector('[role="listbox"][aria-label="Usage group"]')`)
  await page.evaluate(`(() => { const option = [...document.querySelectorAll('[role="listbox"][aria-label="Usage group"] [role="option"]')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!option) throw new Error('Group missing'); option.click(); })()`)
  await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('Confirm Selection'))?.click()`)
  await wait(page, `!document.querySelector('.custom-select__surface') && !document.querySelector('.custom-select__dialog')`)
  if (phone) {
    await page.evaluate(`[...document.querySelectorAll('dialog.overlay--usage-filters button')].find(button => button.textContent.trim() === 'Apply filters').click()`)
    await wait(page, `!document.querySelector('dialog.overlay--usage-filters')`)
  }
}

async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/usage-fixture.html`).then((response) => response.ok, () => false) }
