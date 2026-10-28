import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4757
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

const widths = [320, 390, 768, 1440] as const
const origin = () => `http://127.0.0.1:${port}/verify`
const ready = () => fetch(`${origin()}/usage-fixture.html`).then((response) => response.ok, () => false)

async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 60; attempt++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
async function openUsage(width: number, theme: "light" | "dark" = "light", query = "forecast=states") {
  const page = await browser!.openPage()
  await page.setViewport(width, 844)
  await page.navigate(`${origin()}/usage-fixture.html?${query}`)
  await wait(page, `document.querySelectorAll('.usage-consumption__row').length === 3 && document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
  return page
}
async function openIncidents(width: number, mode = "default", theme: "light" | "dark" = "light") {
  const page = await browser!.openPage()
  await page.setViewport(width, 844)
  await page.navigate(`${origin()}/incident-usage-fixture.html?mode=${mode}`)
  await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length > 0`)
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
  return page
}
const hiddenLabel = (selector: string) => `(() => { const label = document.querySelector(${JSON.stringify(selector)}); const box = label.getBoundingClientRect(); return box.width <= 1 && box.height <= 1 })()`
const settled = (page: Page, selector: string) => page.evaluate(`Promise.all(document.querySelector(${JSON.stringify(selector)}).getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)))`)
const capture = async (page: Page, name: string) => Bun.write(new URL(`../../../.cache/tmp/mobile-usage-${name}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
const isPhone = (page: Page) => page.evaluate<boolean>(`document.querySelector('.usage-page').getBoundingClientRect().width <= 767`)
const overflow = (page: Page) => page.evaluate<boolean>(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)
const click = (page: Page, selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const setInput = (page: Page, label: string, value: string) => page.evaluate(`(() => {
  const input = document.querySelector('[aria-label=${JSON.stringify(label)}]') ?? [...document.querySelectorAll('dialog label')].find((item) => item.textContent.includes(${JSON.stringify(label)}))?.querySelector('input')
  input.value = ${JSON.stringify(value)}
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
const sheetButton = (page: Page, text: string) => page.evaluate(`[...document.querySelectorAll('dialog.overlay--usage-filters button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)}).click()`)
const lastBreakdown = (page: Page) => page.evaluate<Record<string, unknown>>(`window.usageRequests().filter((item) => item.input?.breakdown?.limit === 25).at(-1).input.breakdown`)
const text = (page: Page, selector: string) => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`)

async function chooseInSheet(page: Page, label: string, option: string) {
  await click(page, `dialog.overlay--usage-filters [aria-label="${label}"]`)
  await wait(page, `!!document.querySelector('[role="listbox"][aria-label="${label}"]')`)
  await page.evaluate(`[...document.querySelectorAll('[role="listbox"][aria-label="${label}"] [role="option"]')].find((item) => item.textContent.trim() === ${JSON.stringify(option)}).click()`)
  await page.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Confirm Selection'))?.click()`)
  await wait(page, `!document.querySelector('.custom-select__dialog')`)
}

test("phone Backend consumption rows are compact identity-and-rate summaries with an icon Details, and wide layouts keep the full identity", async () => {
  for (const width of widths) for (const theme of ["light", "dark"] as const) {
    const page = await openUsage(width, theme)
    try {
      expect(await overflow(page)).toBe(false)
      const phone = await isPhone(page)
      if (width === 390 || width === 1440) {
        await page.evaluate(`document.querySelector('.usage-consumption').scrollIntoView()`)
        await capture(page, `consumption-${width}-${theme}`)
      }
      const first = await page.evaluate<{ text: string; height: number; button: { name: string; title: string; labelHidden: boolean; width: number; height: number; popup: string | null } }>(`(() => {
        const row = document.querySelector('.usage-consumption__row'), button = row.querySelector('button'), box = button.getBoundingClientRect()
        return { text: row.innerText.replace(/\\s+/g, ' '), height: row.getBoundingClientRect().height,
          button: { name: button.getAttribute('aria-label'), title: button.title, labelHidden: (() => { const box = button.querySelector('.usage-details-trigger__label').getBoundingClientRect(); return box.width <= 1 && box.height <= 1 })(), width: box.width, height: box.height, popup: button.getAttribute('aria-haspopup') } }
      })()`)
      expect(first.button.name).toBe("openai · gpt-6-sol · profile Personal details")
      expect(first.button.popup).toBe("dialog")
      expect(first.button.title).toBe("Details")
      expect(first.button.height).toBeGreaterThanOrEqual(44)
      expect(first.text).toContain("gpt-6-sol")
      expect(first.text).toContain("12.3k tokens/min")
      if (phone) {
        expect(first.text).not.toContain("profile Personal")
        expect(first.button.labelHidden).toBe(true)
        expect(first.button.width).toBeGreaterThanOrEqual(44)
        expect(first.button.width).toBeLessThanOrEqual(46)
        expect(first.height).toBeLessThanOrEqual(112)
      } else {
        expect(first.text).toContain("openai · gpt-6-sol · profile Personal")
        expect(first.button.labelHidden).toBe(false)
      }
    } finally { await page.close() }
  }
}, 120_000)

test("a phone Details action opens the exact diagnostic dialog by keyboard and returns focus", async () => {
  const page = await openUsage(390)
  try {
    await page.evaluate(`document.querySelector('.usage-consumption__row button').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!!document.querySelector('dialog.overlay--usage-details[open]')`)
    const body = await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-details .overlay__body').innerText`)
    for (const exact of ["Rate 12,345.678 tokens/min", "5m 15,000.25 tokens/min · 60m 9,876.5 tokens/min", "Estimated cost rate $1.23456/hour", "40 priced · 0 unpriced"]) expect(body).toContain(exact)
    await page.pressEscape()
    await wait(page, `!document.querySelector('dialog.overlay--usage-details')`)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.usage-consumption__row button')`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("Breakdown opens with one filter summary and a Filters trigger on phones and keeps inline controls on wide layouts", async () => {
  for (const width of widths) {
    const page = await openUsage(width)
    try {
      const phone = await isPhone(page)
      const state = await page.evaluate<{ trigger: boolean; summary: string; inline: boolean; groupOutsideDialog: boolean; label: string | null; height: number }>(`(() => {
        const trigger = document.querySelector('.usage-filter-bar__trigger')
        return { trigger: !!trigger, label: trigger?.getAttribute('aria-label') ?? null, height: trigger?.getBoundingClientRect().height ?? 0, summary: document.querySelector('.usage-filter-bar__summary')?.textContent ?? '',
          inline: !!document.querySelector('.usage-filter-controls'), groupOutsideDialog: !!document.querySelector('.usage-breakdown__head [aria-label="Usage group"]') }
      })()`)
      expect(state.trigger).toBe(phone)
      expect(state.inline).toBe(!phone)
      expect(state.groupOutsideDialog).toBe(!phone)
      if (phone) {
        expect(state.summary).toBe("Model (recorded selection) · Last 30 days")
        expect(state.label).toBe("Filters")
        expect(state.height).toBeGreaterThanOrEqual(44)
        expect(await page.evaluate<number>(`document.querySelectorAll('.usage-breakdown-section select, .usage-breakdown-section .custom-select').length`)).toBe(0)
        const head = await page.evaluate<number>(`document.querySelector('.usage-filter-bar').getBoundingClientRect().height`)
        expect(head).toBeLessThanOrEqual(140)
      }
      expect(await overflow(page)).toBe(false)
    } finally { await page.close() }
  }
}, 90_000)

test("the Filters sheet holds every control, applies once, preserves selections and custom UTC dates, resets and cancels without applying", async () => {
  for (const [width, theme] of [[320, "dark"], [390, "light"]] as const) {
    const page = await openUsage(width, theme)
    try {
      await page.evaluate(`document.querySelector('.usage-filter-bar__trigger').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `!!document.querySelector('dialog.overlay--usage-filters[open]')`)
      await settled(page, "dialog.overlay--usage-filters")
      const sheet = await page.evaluate<{ modal: boolean; label: string | null; labels: string[]; ranges: string[]; pressed: string; inside: boolean; fits: boolean; applyVisible: boolean; vars: string; close: string | null }>(`(() => {
        const dialog = document.querySelector('dialog.overlay--usage-filters'), surface = dialog.querySelector('.overlay__surface'), box = surface.getBoundingClientRect()
        const apply = [...dialog.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Apply filters').getBoundingClientRect()
        return { modal: dialog.matches(':modal'), label: dialog.getAttribute('aria-label'), labels: [...dialog.querySelectorAll('.field__label')].map((item) => item.textContent.trim()),
          ranges: [...dialog.querySelectorAll('.usage-filter-sheet__range')].map((item) => item.textContent.trim()), pressed: dialog.querySelector('.usage-filter-sheet__range[aria-pressed="true"]').textContent.trim(),
          inside: dialog.contains(document.activeElement), fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight + 1,
          applyVisible: apply.top >= 0 && apply.bottom <= innerHeight + 1 && apply.height >= 44, vars: surface.style.getPropertyValue('--usage-filters-height'), close: dialog.querySelector('.overlay__close').getAttribute('aria-label') }
      })()`)
      await capture(page, `filters-sheet-${width}-${theme}`)
      expect(sheet.modal).toBe(true)
      expect(sheet.label).toBe("Usage filters")
      expect(sheet.close).toBe("Close Usage filters")
      expect(sheet.labels).toEqual(["Group", "Provider", "Recorded profile", "Model ID", "Selected effort", "Range"])
      expect(sheet.ranges).toEqual(["7 days", "30 days", "All retained", "Custom UTC"])
      expect(sheet.pressed).toBe("30 days")
      expect(sheet.inside).toBe(true)
      expect(sheet.fits).toBe(true)
      expect(sheet.applyVisible).toBe(true)
      expect(sheet.vars).toMatch(/^\d+px$/)
      for (let step = 0; step < 14; step++) {
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog.overlay--usage-filters').contains(document.activeElement)`)).toBe(true)
      }
      await chooseInSheet(page, "Usage group", "Provider / model")
      await setInput(page, "Recorded profile", "Personal")
      await setInput(page, "Model ID", "gpt-6-sol")
      await setInput(page, "Selected effort", "high")
      await click(page, `dialog.overlay--usage-filters .usage-filter-sheet__range:nth-child(1)`)
      expect(await page.evaluate<boolean>(`window.usageRequests().some((item) => item.input?.breakdown?.selectedEffort === 'high')`)).toBe(false)
      await sheetButton(page, "Apply filters")
      await wait(page, `!document.querySelector('dialog.overlay--usage-filters')`)
      await wait(page, `window.usageRequests().some((item) => item.input?.breakdown?.selectedEffort === 'high')`)
      expect(await lastBreakdown(page)).toMatchObject({ group: "provider-model", profile: "Personal", modelID: "gpt-6-sol", selectedEffort: "high", offset: 0, limit: 25 })
      expect(await text(page, ".usage-filter-bar__summary")).toBe("Provider / model · Last 7 days · Profile Personal · Model gpt-6-sol · Effort high")
      expect(await page.evaluate<string>(`document.querySelector('.usage-filter-bar__trigger').getAttribute('aria-label')`)).toBe("Filters, 5 active")
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.usage-filter-bar__trigger')`)).toBe(true)

      await click(page, ".usage-filter-bar__trigger")
      await wait(page, `!!document.querySelector('dialog.overlay--usage-filters[open]')`)
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('dialog.overlay--usage-filters .input')].map((item) => item.value)`)).toEqual(["Personal", "gpt-6-sol", "high"])
      expect(await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-filters .usage-filter-sheet__range[aria-pressed="true"]').textContent.trim()`)).toBe("7 days")
      await click(page, `dialog.overlay--usage-filters .usage-filter-sheet__range:nth-child(4)`)
      await wait(page, `!!document.querySelector('[aria-label="Usage from UTC"]')`)
      await setInput(page, "Usage from UTC", "2026-10-08")
      await setInput(page, "Usage to UTC", "2026-10-01")
      await sheetButton(page, "Apply filters")
      await wait(page, `!!document.querySelector('dialog.overlay--usage-filters [role="alert"]')`)
      expect(await text(page, "dialog.overlay--usage-filters [role='alert']")).toBe("Enter valid UTC dates with From before To.")
      await setInput(page, "Usage from UTC", "2026-10-01")
      await setInput(page, "Usage to UTC", "2026-10-08")
      await sheetButton(page, "Apply filters")
      await wait(page, `!document.querySelector('dialog.overlay--usage-filters')`)
      await wait(page, `window.usageRequests().some((item) => item.input?.breakdown?.from === ${Date.UTC(2026, 9, 1)})`)
      expect(await lastBreakdown(page)).toMatchObject({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 8) })
      expect(await text(page, ".usage-filter-bar__summary")).toContain("UTC 2026-10-01 to 2026-10-08 (exclusive)")

      await click(page, ".usage-filter-bar__trigger")
      await wait(page, `!!document.querySelector('dialog.overlay--usage-filters[open]')`)
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('dialog.overlay--usage-filters [aria-label^="Usage from"], dialog.overlay--usage-filters [aria-label^="Usage to"]')].map((item) => item.value)`)).toEqual(["2026-10-01", "2026-10-08"])
      await setInput(page, "Model ID", "discarded")
      await page.pressEscape()
      await wait(page, `!document.querySelector('dialog.overlay--usage-filters')`)
      expect(await text(page, ".usage-filter-bar__summary")).not.toContain("discarded")
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.usage-filter-bar__trigger')`)).toBe(true)

      await click(page, ".usage-filter-bar__trigger")
      await wait(page, `!!document.querySelector('dialog.overlay--usage-filters[open]')`)
      await sheetButton(page, "Reset")
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('dialog.overlay--usage-filters .input')].map((item) => item.value)`)).toEqual(["", "", ""])
      expect(await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-filters .usage-filter-sheet__range[aria-pressed="true"]').textContent.trim()`)).toBe("30 days")
      await sheetButton(page, "Apply filters")
      await wait(page, `!document.querySelector('dialog.overlay--usage-filters')`)
      await wait(page, `document.querySelector('.usage-filter-bar__summary').textContent === 'Model (recorded selection) · Last 30 days'`)
      await wait(page, `document.querySelector('.usage-breakdown caption')?.textContent === 'Model by usage'`)
      expect(await page.evaluate<string>(`document.querySelector('.usage-filter-bar__trigger').getAttribute('aria-label')`)).toBe("Filters")
      expect(await overflow(page)).toBe(false)
    } finally { await page.close() }
  }
}, 120_000)

test("range choices keep distinct labelled values and expose selection without colour alone", async () => {
  const page = await openUsage(390)
  try {
    await click(page, ".usage-filter-bar__trigger")
    await wait(page, `!!document.querySelector('dialog.overlay--usage-filters[open]')`)
    const state = await page.evaluate<{ distinct: number; visibleChecks: number; pressed: string[] }>(`(() => {
      const buttons = [...document.querySelectorAll('dialog.overlay--usage-filters .usage-filter-sheet__range')]
      return { distinct: new Set(buttons.map((item) => item.textContent.trim())).size, visibleChecks: buttons.filter((item) => getComputedStyle(item.querySelector('svg')).visibility === 'visible').length,
        pressed: buttons.filter((item) => item.getAttribute('aria-pressed') === 'true').map((item) => item.textContent.trim()) }
    })()`)
    expect(state).toEqual({ distinct: 4, visibleChecks: 1, pressed: ["30 days"] })
  } finally { await page.close() }
}, 30_000)

test("breakdown pagination uses named icon actions that keyboard-page and disable at the ends", async () => {
  for (const width of [320, 390, 1440]) {
    const page = await openUsage(width)
    try {
      await page.evaluate(`document.querySelector('.usage-pagination').scrollIntoView({ block: 'center' })`)
      const buttons = await page.evaluate<{ name: string | null; title: string; labelHidden: boolean; width: number; height: number; disabled: boolean }[]>(`[...document.querySelectorAll('.usage-pagination button')].map((item) => ({ name: item.getAttribute('aria-label'), title: item.title, labelHidden: (() => { const box = item.querySelector('.usage-action-label').getBoundingClientRect(); return box.width <= 1 && box.height <= 1 })(), width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height, disabled: item.disabled }))`)
      expect(buttons.map((item) => item.name)).toEqual(["Previous breakdown page", "Next breakdown page"])
      expect(buttons.map((item) => item.title)).toEqual(["Previous page", "Next page"])
      expect(buttons.every((item) => item.labelHidden && item.width >= 44 && item.width <= 46 && item.height >= 44)).toBe(true)
      expect(buttons.map((item) => item.disabled)).toEqual([true, false])
      await page.evaluate(`document.querySelector('[aria-label="Next breakdown page"]').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `window.usageRequests().some((item) => item.input?.breakdown?.limit === 25 && item.input.breakdown.offset === 25)`)
      expect(await overflow(page)).toBe(false)
    } finally { await page.close() }
  }
}, 60_000)

test("phone incident rows are one compact summary each with exact counts and UTC time, without page overflow at any width", async () => {
  for (const width of widths) for (const theme of ["light", "dark"] as const) {
    const page = await openIncidents(width, "default", theme)
    try {
      expect(await overflow(page)).toBe(false)
      const phone = await isPhone(page)
      const row = await page.evaluate<{ text: string; height: number; time: string; datetime: string; after: string[]; details: { name: string | null; title: string; labelHidden: boolean; width: number; height: number; expanded: string | null } }>(`(() => {
        const row = document.querySelector('.incidents [data-incident-row]'), button = row.querySelector('[data-incident-details]'), time = row.querySelector('time')
        return { text: row.textContent.replace(/\\s+/g, ' '), height: row.getBoundingClientRect().height, time: time.textContent, datetime: time.dateTime,
          after: ['Fallbacks', 'Escalated', 'Rejected', 'Total'].map((label) => getComputedStyle(row.querySelector('[data-label="' + label + '"]'), '::after').content),
          details: { name: button.getAttribute('aria-label'), title: button.title, labelHidden: (() => { const box = button.querySelector('.usage-action-label').getBoundingClientRect(); return box.width <= 1 && box.height <= 1 })(), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height, expanded: button.getAttribute('aria-expanded') } }
      })()`)
      if (width === 320 || width === 390 || width === 1440) {
        await page.evaluate(`document.querySelector('.incidents').scrollIntoView()`)
        await capture(page, `incidents-${width}-${theme}`)
      }
      for (const exact of ["openai/gpt-6-sol", "1,234", "1,241"]) expect(row.text).toContain(exact)
      expect(row.time).toBe(new Date(row.datetime).toISOString().slice(0, 19).replace("T", " ") + " UTC")
      expect(row.details).toMatchObject({ name: "Details for openai/gpt-6-sol", title: "Details", expanded: "false" })
      expect(row.details.height).toBeGreaterThanOrEqual(44)
      expect(row.details.labelHidden).toBe(true)
      expect(row.details.width).toBeGreaterThanOrEqual(44)
      expect(row.details.width).toBeLessThanOrEqual(46)
      if (phone) {
        expect(row.height).toBeLessThanOrEqual(140)
        expect(row.after.every((content) => content.length > 3)).toBe(true)
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.incidents [data-incident-row] [data-label="Last incident"]'), '::before').content`)).toContain("Last")
      }
    } finally { await page.close() }
  }
}, 150_000)

test("phone incident Details expands under its own row with exact incidents and guidance, keeps clear confirmation, and wide layouts keep the panel below the table", async () => {
  for (const width of [320, 390, 1440]) {
    const page = await openIncidents(width)
    try {
      const phone = await isPhone(page)
      await page.evaluate(`document.querySelector('[data-incident-details]').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `document.querySelectorAll('.incidents__recent li').length === 20 && !!document.querySelector('.incidents__preview')`)
      const state = await page.evaluate<{ expanded: string | null; controls: string | null; underRow: boolean; inTable: boolean; times: boolean; indicator: string; rotate: string }>(`(() => {
        const button = document.querySelector('[data-incident-details]'), panel = document.getElementById('incident-detail')
        return { expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'), underRow: panel.closest('tr')?.previousElementSibling === button.closest('tr'), inTable: !!panel.closest('table'),
          times: [...document.querySelectorAll('.incidents__recent time')].every((item) => /^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC$/.test(item.textContent)), indicator: document.querySelector('.incidents__indicator').textContent, rotate: getComputedStyle(button.querySelector('svg')).rotate }
      })()`)
      await page.evaluate(`document.querySelector('[data-incident-details]').scrollIntoView({ block: 'start' })`)
      await capture(page, `incident-detail-${width}`)
      expect(state).toMatchObject({ expanded: "true", controls: "incident-detail", times: true, indicator: "Guidance enabled", underRow: phone, inTable: phone })
      if (phone) expect(state.rotate).toBe("90deg")
      expect(await overflow(page)).toBe(false)
      await page.evaluate(`document.querySelector('[data-incident-clear]').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `!!document.querySelector('dialog.overlay--confirm[open]')`)
      expect(await text(page, "dialog.overlay--confirm")).toContain("Incident counts are kept")
      await page.pressEscape()
      await wait(page, `!document.querySelector('dialog.overlay--confirm')`)
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('[data-incident-clear]')`)).toBe(true)
      await page.evaluate(`document.querySelector('[data-incident-details]').focus()`)
      await page.pressKey(" ", "Space", 32, " ")
      await wait(page, `!document.getElementById('incident-detail')`)
      expect(await page.evaluate<string>(`document.querySelector('[data-incident-details]').getAttribute('aria-expanded')`)).toBe("false")
    } finally { await page.close() }
  }
}, 90_000)

test("incident pagination uses named icon actions at every width, pages by keyboard and keeps exact group counts", async () => {
  for (const width of [390, 1440]) {
  const page = await openIncidents(width, "paged")
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 25`)
    const start = await page.evaluate<{ names: (string | null)[]; hidden: boolean[]; widths: number[]; disabled: boolean[] }>(`(() => {
      const buttons = [...document.querySelectorAll('.incidents__pagination button')]
      return { names: buttons.map((item) => item.getAttribute('aria-label')), hidden: buttons.map((item) => { const box = item.querySelector('.usage-action-label').getBoundingClientRect(); return box.width <= 1 && box.height <= 1 }), widths: buttons.map((item) => item.getBoundingClientRect().width), disabled: buttons.map((item) => item.disabled) }
    })()`)
    expect(start.names).toEqual(["Previous incident groups", "Next incident groups"])
    expect(start.hidden).toEqual([true, true])
    expect(start.widths.every((width) => width >= 44 && width <= 46)).toBe(true)
    expect(start.disabled).toEqual([true, false])
    expect(await text(page, ".incidents__summary")).toBe("Showing 1–25 of 60 groups")
    await page.evaluate(`document.querySelector('[aria-label="Next incident groups"]').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.incidents__summary')?.textContent === 'Showing 26–50 of 60 groups'`)
    await page.evaluate(`document.querySelector('[aria-label="Previous incident groups"]').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.incidents__summary')?.textContent === 'Showing 1–25 of 60 groups'`)
    expect(await page.evaluate<unknown[]>(`window.incidentRequests().filter((item) => item.operation === 'incident.report').map((item) => item.input.offset)`)).toEqual([0, 25])
    expect(await overflow(page)).toBe(false)
  } finally { await page.close() }
  }
}, 60_000)

test("phone incident controls use distinct group icons and a labelled range selector that keeps 7, 30, All and Custom UTC distinguishable", async () => {
  const page = await openIncidents(390)
  try {
    expect(await page.evaluate<boolean>(`!document.querySelector('.incidents [role="group"][aria-label="Incident range"]')`)).toBe(true)
    expect(await page.evaluate<boolean>(`(() => { const icons = [...document.querySelectorAll('.incidents [aria-label="Incident grouping"] button svg')].map((item) => item.innerHTML); return icons.length === 2 && icons[0] !== icons[1] })()`)).toBe(true)
    expect(await text(page, '.incidents button[aria-label="Incident range"]')).toBe("All retained")
    await click(page, '.incidents button[aria-label="Incident range"]')
    await wait(page, `!!document.querySelector('[role="listbox"][aria-label="Incident range"]')`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[role="listbox"][aria-label="Incident range"] [role="option"]')].map((item) => item.textContent.trim().replace(/^✓/, ''))`)).toEqual(["7 days", "30 days", "All retained", "Custom UTC"])
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[role="listbox"][aria-label="Incident range"] [role="option"][aria-selected="true"]')].map((item) => item.textContent.trim().replace(/^✓/, ''))`)).toEqual(["All retained"])
    await page.evaluate(`[...document.querySelectorAll('[role="listbox"][aria-label="Incident range"] [role="option"]')].find((item) => item.textContent.trim() === '7 days').click()`)
    await page.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Confirm Selection'))?.click()`)
    await wait(page, `!document.querySelector('.custom-select__dialog')`)
    await wait(page, `window.incidentRequests().some((item) => item.operation === 'incident.report' && item.input.from !== undefined)`)
    expect(await text(page, '.incidents button[aria-label="Incident range"]')).toBe("7 days")
    await click(page, '.incidents button[aria-label="Incident range"]')
    await wait(page, `!!document.querySelector('[role="listbox"][aria-label="Incident range"]')`)
    await page.evaluate(`[...document.querySelectorAll('[role="listbox"][aria-label="Incident range"] [role="option"]')].find((item) => item.textContent.trim() === 'Custom UTC').click()`)
    await page.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Confirm Selection'))?.click()`)
    await wait(page, `!!document.querySelector('[aria-label="Incident from UTC"]')`)
    expect(await text(page, '.incidents button[aria-label="Incident range"]')).toBe("Custom UTC")
    expect(await overflow(page)).toBe(false)
  } finally { await page.close() }
}, 40_000)

test("incident loading, empty, unsupported and failed states stay compact and overflow-free on phones", async () => {
  for (const mode of ["loading", "empty", "old", "error"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(320, 844)
      await page.navigate(`${origin()}/incident-usage-fixture.html?mode=${mode}`)
      const expected = { loading: ".incidents .loading-placeholder", empty: ".incidents .usage-message", old: ".incidents .usage-message", error: ".incidents [role='alert']" }[mode]!
      await wait(page, `!!document.querySelector(${JSON.stringify(expected)})`)
      expect(await overflow(page)).toBe(false)
    } finally { await page.close() }
  }
}, 60_000)
