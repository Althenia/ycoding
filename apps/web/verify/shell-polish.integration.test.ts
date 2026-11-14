import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4384
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  if (!await ready()) server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && !await ready(); attempt += 1) await Bun.sleep(100)
  if (!await ready()) throw new Error("Vite did not start the workspace fixture")
  browser = await launchBrowser(browserPath, 1440, 900)
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

const chat = (theme: string, extra = "") => `http://127.0.0.1:${port}/verify/remote.html?view=chat&acceptedPreview=1&theme=${theme}${extra}`

for (const theme of ["light", "dark"] as const) {
  describe(`request cards in ${theme}`, () => {
    test("space option rows evenly, align each radio with its first line and indent the free-text field to the labels", async () => {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(1440, 1400)
        await page.setColorScheme(theme)
        await page.navigate(chat(theme))
        await until(page, `document.querySelector('#pending-requests .question__custom input') !== null`)
        const card = await page.evaluate<{ gaps: number[]; centers: number[]; appearance: string[]; inputLeft: number; labelLeft: number; inputHeight: number; controlHeight: number; headerToLegend: number; legendToDescription: number; fieldToActions: number }>(`(() => {
          const card = document.querySelector('#pending-requests .question__custom input').closest('.request')
          const options = [...card.querySelectorAll('.question__option')]
          const box = (element) => element.getBoundingClientRect()
          const firstLine = (option) => { const range = document.createRange(); range.selectNodeContents(option.querySelector('span')); return range.getClientRects()[0] }
          const input = card.querySelector('.question__custom input')
          const question = card.querySelector('.question')
          return {
            gaps: options.slice(1).map((option, index) => Math.round(box(option).top - box(options[index]).bottom)),
            centers: options.map((option) => { const radio = box(option.querySelector('input')), line = firstLine(option); return Math.abs((radio.top + radio.height / 2) - (line.top + line.height / 2)) }),
            appearance: options.map((option) => getComputedStyle(option.querySelector('input')).appearance),
            inputLeft: box(input).left,
            labelLeft: firstLine(options[0]).left,
            inputHeight: box(input).height,
            controlHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-control-h')),
            headerToLegend: box(question.querySelector('legend')).top - box(card.querySelector('.request__header')).bottom,
            legendToDescription: box(question.querySelector(':scope > p')).top - box(question.querySelector('legend')).bottom,
            fieldToActions: box(card.querySelector('.request__actions .button')).top - box(input).bottom,
          }
        })()`)
        expect(new Set(card.gaps).size).toBe(1)
        expect(Math.max(...card.centers)).toBeLessThanOrEqual(1)
        expect(card.appearance.every((value) => value === "none")).toBe(true)
        expect(Math.abs(card.inputLeft - card.labelLeft)).toBeLessThanOrEqual(1)
        expect(card.inputHeight).toBe(card.controlHeight)
        expect(card.headerToLegend).toBeLessThanOrEqual(12)
        expect(card.legendToDescription).toBeLessThanOrEqual(4)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=permission-guardrail-hard-review-form-requests-1440&theme=${theme}`)
        await until(page, `document.querySelectorAll('#pending-requests form .request__actions').length >= 3`)
        const actionGaps = await page.evaluate<number[]>(`[...document.querySelectorAll('#pending-requests form')].map((form) => { const fields = [...form.querySelectorAll('.question')].at(-1), last = [...fields.querySelectorAll('.question__option, .question__custom input, .question__custom textarea')].at(-1); return Math.round(form.querySelector('.request__actions .button').getBoundingClientRect().top - last.getBoundingClientRect().bottom) })`)
        expect(new Set(actionGaps).size).toBe(1)
        expect(actionGaps[0]).toBe(card.fieldToActions)
      } finally { await page.close() }
    }, 30_000)

    test("keeps a resolved request card in a closing disclosure before it unmounts", async () => {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(1440, 1000)
        await page.setColorScheme(theme)
        await page.navigate(chat(theme))
        await until(page, `document.querySelector('#pending-requests .request--permission .button--primary') !== null`)
        expect(await page.evaluate<boolean>(`document.querySelector('#pending-requests .request--permission').closest('.collapsible')?.hasAttribute('data-open') === true`)).toBe(true)
        await page.evaluate(`window.__closing = false; new MutationObserver(() => { const host = [...document.querySelectorAll('#pending-requests .presence-item > .collapsible')].find((item) => !item.hasAttribute('data-open')); if (host) window.__closing = true }).observe(document.body, { subtree: true, attributes: true, childList: true }); document.querySelector('#pending-requests .request--permission .button--primary').click()`)
        await until(page, `document.querySelector('#pending-requests .request--permission') === null`)
        expect(await page.evaluate<boolean>(`window.__closing`)).toBe(true)
      } finally { await page.close() }
    }, 30_000)
  })

  describe(`Session companion in ${theme}`, () => {
    for (const width of [1440, 1280]) {
      test(`aligns the header, context total and breakdown columns at ${width}`, async () => {
        const page = await requireBrowser().openPage()
        try {
          await page.setViewport(width, 1000)
          await page.setColorScheme(theme)
          await page.navigate(chat(theme))
          await until(page, `document.querySelector('.companion-context-trigger') !== null`)
          await page.evaluate(`document.querySelector('.companion-context-trigger').click()`)
          await until(page, `document.querySelector('#companion-context:not([hidden]) .companion__context-row') !== null`)
          await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 400))`)
          const layout = await page.evaluate<{ column: number; centers: number[]; titleLeft: number; tabsLeft: number; contentLeft: number; pillGap: number; totalBaseline: number; unitBaseline: number; unitTop: number; totalTop: number; eyebrow: string; label: string; capacity: string; noteFont: string; labelFont: string; noteLines: number; countRights: number[]; percentRights: number[]; valueFont: string; numeric: string; actionHeights: number[]; actionRadii: string[]; actionPadding: string[] }>(`(() => {
            const panel = document.querySelector('#session-companion-panel')
            const box = (element) => element.getBoundingClientRect()
            const header = panel.querySelector('.companion__header')
            const pills = [...header.querySelectorAll('button:not([aria-label])')]
            const parts = [header.querySelector('.rl-pane-kicker'), ...pills, header.querySelector('[aria-label="Close Session companion"]')]
            const baseline = (element) => { const probe = document.createElement('span'); probe.style.cssText = 'display:inline-block;inline-size:0;block-size:0;vertical-align:baseline'; element.append(probe); const value = box(probe).top; probe.remove(); return value }
            const total = panel.querySelector('.companion__context-total'), unit = panel.querySelector('.companion__context-capacity'), eyebrow = panel.querySelector('.companion__context-eyebrow'), label = panel.querySelector('.rl-context-summary'), note = panel.querySelector('.rl-context-note')
            const lineHeight = parseFloat(getComputedStyle(label).lineHeight)
            const actions = [...panel.querySelectorAll('#companion-context .companion__context-footer .rl-context-footer-row')]
            return {
              column: parseFloat(getComputedStyle(document.querySelector('.app')).gridTemplateColumns.split(' ').at(-1)),
              centers: parts.map((part) => box(part).top + box(part).height / 2),
              titleLeft: box(parts[0]).left,
              tabsLeft: box(panel.querySelector('.companion__tabs')).left,
              contentLeft: box(panel.querySelector('#companion-context')).left,
              pillGap: box(pills[1]).left - box(pills[0]).right,
              totalBaseline: baseline(total), unitBaseline: baseline(unit), totalTop: box(total).top, unitTop: box(unit).top,
              eyebrow: eyebrow.textContent.trim(), label: label.textContent.trim(), capacity: unit.textContent.trim(), noteFont: getComputedStyle(note).fontFamily, labelFont: getComputedStyle(label).fontFamily, noteLines: Math.round(box(label).height / lineHeight),
              countRights: [...panel.querySelectorAll('.companion__context-row .companion__context-count')].map((value) => Math.round(box(value).right)),
              percentRights: [...panel.querySelectorAll('.companion__context-row .companion__context-percent')].map((value) => Math.round(box(value).right)),
              valueFont: getComputedStyle(panel.querySelector('.companion__context-row dd')).fontFamily,
              numeric: getComputedStyle(panel.querySelector('.companion__context-row dd')).fontVariantNumeric,
              actionHeights: actions.map((action) => box(action).height),
              actionRadii: actions.map((action) => getComputedStyle(action).borderRadius),
              actionPadding: actions.map((action) => getComputedStyle(action).paddingInline),
            }
          })()`)
          expect(layout.column).toBeCloseTo(Math.min(448, width * 0.4), 0)
          expect(Math.max(...layout.centers) - Math.min(...layout.centers)).toBeLessThanOrEqual(1)
          expect(Math.abs(layout.titleLeft - layout.tabsLeft)).toBeLessThanOrEqual(0.5)
          expect(Math.abs(layout.titleLeft - layout.contentLeft)).toBeLessThanOrEqual(0.5)
          expect(layout.pillGap).toBe(8)
          expect(Math.abs(layout.totalBaseline - layout.unitBaseline)).toBeLessThanOrEqual(1)
          expect(layout.eyebrow).toBe("Active window")
          expect(layout.capacity).toBe("/ 128K tokens")
          expect(layout.label).toBe("104,000 remaining · 19% used")
          for (const font of [layout.labelFont, layout.noteFont]) {
            expect(font).toContain("Geist")
            expect(font).not.toContain("Mono")
          }
          expect(layout.noteLines).toBe(1)
          expect(layout.countRights.length).toBe(7)
          expect(new Set(layout.countRights).size).toBe(1)
          expect(new Set(layout.percentRights).size).toBe(1)
          expect(layout.valueFont).not.toContain("Mono")
          expect(layout.numeric).toContain("tabular-nums")
          expect(layout.actionHeights.length).toBe(2)
          expect(new Set(layout.actionHeights).size).toBe(1)
          expect(new Set(layout.actionRadii).size).toBe(1)
          expect(new Set(layout.actionPadding).size).toBe(1)
        } finally { await page.close() }
      }, 30_000)
    }

    test("opens and switches tabs with the shared motion tokens", async () => {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(1440, 900)
        await page.setColorScheme(theme)
        await page.navigate(chat(theme))
        await until(page, `document.querySelector('[aria-label="Open Team"]') !== null`)
        await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
        await until(page, `document.querySelector('#session-companion-panel') !== null`)
        const motion = await page.evaluate<{ properties: string; durations: string; panelAnimation: string }>(`(() => { const panel = getComputedStyle(document.querySelector('#session-companion-panel')); return { properties: panel.transitionProperty, durations: panel.transitionDuration, panelAnimation: getComputedStyle(document.querySelector('#companion-activity')).animationName } })()`)
        expect(motion.properties).toBe("opacity, translate")
        expect(motion.durations).toBe("0.14s, 0.22s")
        expect(motion.panelAnimation).toContain("yc-motion-fade")
      } finally { await page.close() }
    }, 30_000)
  })

  describe(`sidebar in ${theme}`, () => {
    test("sizes the rail from its token and drops the machine footer", async () => {
      const page = await requireBrowser().openPage()
      try {
        for (const width of [1440, 1800]) {
          await page.setViewport(width, 900)
          await page.setColorScheme(theme)
          await page.navigate(chat(theme))
          await until(page, `document.querySelector('.workspace__rail .session-row') !== null`)
          const rail = await page.evaluate<{ width: number; token: number; overflow: number; footer: number; text: string }>(`(() => { const rail = document.querySelector('.workspace__rail'), box = rail.getBoundingClientRect(); return { width: box.width, token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-rail-w')), overflow: [...rail.querySelectorAll('*')].filter((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().right > box.right + 0.5).length, footer: document.querySelectorAll('.workspace__rail-footer').length, text: rail.innerText } })()`)
          expect(rail.width).toBe(256)
          expect(rail.width).toBe(rail.token)
          expect(rail.overflow).toBe(0)
          expect(rail.footer).toBe(0)
          expect(rail.text).not.toContain("Selected machine")
          expect(rail.text).not.toContain("Manage connection")
        }
        await page.setViewport(767, 900)
        await page.navigate(chat(theme))
        await until(page, `document.querySelector('.composer-resident textarea') !== null`)
        expect(await page.evaluate<{ rail: number; column: number }>(`({ rail: document.querySelector('.workspace__rail').getBoundingClientRect().width, column: document.querySelector('.workspace__scroll').getBoundingClientRect().width })`)).toMatchObject({ rail: 0 })
        expect(await page.evaluate<number>(`document.querySelector('.workspace__scroll').getBoundingClientRect().width`)).toBeGreaterThanOrEqual(320)
      } finally { await page.close() }
    }, 30_000)

    test("shows a pending account in the connection strip instead of a machine footer", async () => {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(1440, 900)
        await page.setColorScheme(theme)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?account=pending&noSelection=1&theme=${theme}`)
        await until(page, `document.querySelector('.status-strip__body') !== null`)
        expect(await page.evaluate<string>(`document.querySelector('.status-strip__body').textContent`)).toContain("Checking account")
      } finally { await page.close() }
    }, 30_000)

    test("signals running, waiting and failed Sessions on rows of one height", async () => {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(1440, 1000)
        await page.setColorScheme(theme)
        await page.navigate(chat(theme, "&priorityPins=1"))
        await until(page, `document.querySelector('.workspace__rail [data-session-id="ses_idle_pinned"]') !== null`)
        await page.evaluate(`window.remoteStatus(['ses_running'], ['ses_fixture'], ['ses_idle_pinned'])`)
        await until(page, `document.querySelector('.workspace__rail [data-session-id="ses_idle_pinned"] [data-signal="failed"]') !== null`)
        const rows = await page.evaluate<{ id: string; signal: string; text: string; height: number; right: number; animated: boolean; chips: string[] }[]>(`[...document.querySelectorAll('.workspace__rail .session-row')].map((row) => { const signal = row.querySelector('.session-row__signal'), box = row.getBoundingClientRect(); return { id: row.dataset.sessionId, signal: signal?.dataset.signal ?? '', text: signal?.textContent.trim() ?? '', height: box.height, right: Math.round(box.right), animated: signal ? getComputedStyle(signal.querySelector('.session-row__signal-mark')).animationName !== 'none' : false, chips: [...row.querySelectorAll('.chip')].map((chip) => chip.textContent.trim()) } })`)
        const byID = Object.fromEntries(rows.map((row) => [row.id, row]))
        expect(byID.ses_running).toMatchObject({ signal: "running", text: "Running", animated: true })
        expect(byID.ses_running?.chips).not.toContain("Running")
        expect(byID.ses_fixture).toMatchObject({ signal: "waiting", text: "Waiting for approval" })
        expect(byID.ses_idle_pinned).toMatchObject({ signal: "failed", text: "Failed" })
        expect(new Set(rows.map((row) => row.height)).size).toBe(1)
        expect(new Set(rows.map((row) => row.right)).size).toBe(1)
        expect(rows[0]?.right).toBe(await page.evaluate<number>(`(() => { const body = document.querySelector('.workspace__rail-body'); return Math.round(body.getBoundingClientRect().left + body.clientLeft + body.clientWidth) })()`))
        await page.setReducedMotion(true)
        await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 100))`)
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.workspace__rail [data-session-id="ses_running"] .session-row__signal-mark')).animationName`)).toBe("none")
      } finally { await page.close() }
    }, 30_000)

    test("collapses the rail without animating the grid track so its width settles at once", async () => {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(1440, 900)
        await page.setColorScheme(theme)
        await page.navigate(chat(theme))
        await until(page, `document.querySelector('.workspace__rail .session-row') !== null`)
        expect(await page.evaluate<{ property: string; duration: string }>(`({ property: getComputedStyle(document.querySelector('.app')).transitionProperty, duration: getComputedStyle(document.querySelector('.app')).transitionDuration })`)).toEqual({ property: "all", duration: "0s" })
      } finally { await page.close() }
    }, 30_000)
  })
}

function requireBrowser() {
  if (!browser) throw new Error("Browser unavailable")
  return browser
}

async function until(page: Page, expression: string) {
  await page.evaluate(`new Promise((resolve,reject) => { const deadline=performance.now()+8000;const check=()=>{ if(${expression}) {resolve(true);return;} if(performance.now()>deadline) {reject(new Error('Shell condition did not settle'));return;} requestAnimationFrame(check); };check(); })`)
}

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then(response => response.ok, () => false)
}
