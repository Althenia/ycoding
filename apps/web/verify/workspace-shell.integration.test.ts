import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { join } from "node:path"

const port = 4276
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

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

describe("quiet workspace", () => {
  test("UI correction: waiting, running and pinned Sessions keep activity priority inside workspace groups", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1&priorityPins=1`)
      await until(page, `document.querySelector('.workspace__rail [data-session-id="ses_idle_pinned"]') !== null && document.querySelector('.workspace__rail .session-filters button')?.getAttribute('aria-label') === 'All 4'`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .session-panel__summary, .workspace__rail .session-panel__workspace, .workspace__rail .pane__head--sessions').length`)).toBe(0)
      const groups = (panel: string) => `(() => { let group=''; return [...document.querySelectorAll('${panel} .session-list__row')].map(row => { if (row.classList.contains('session-list__group')) { group=row.textContent.trim(); return group } const session=row.querySelector('[data-session-id]'); return session ? group + ':' + session.dataset.sessionId : '' }).filter(Boolean) })()`
      const expected = ["ycoding", "ycoding:ses_fixture", "ycoding:ses_running", "ycoding:ses_idle_pinned", "Not reported", "Not reported:ses_archived"]
      expect(await page.evaluate<string[]>(groups('.workspace__rail'))).toEqual(expected)
      await page.evaluate(`window.remoteOfflineInventory()`)
      await until(page, `document.querySelector('.workspace__rail .panel__note')?.textContent?.includes('Last session list')`)
      await page.evaluate(`(() => { const rail=document.querySelector('.workspace__rail-body'); rail.scrollTop=rail.scrollHeight })()`)
      await until(page, `document.querySelector('.workspace__rail [data-session-id="ses_archived"]') !== null`)
      expect(await page.evaluate<string[]>(groups('.workspace__rail'))).toEqual(expected)
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1&priorityPins=1`)
      await until(page, `document.querySelector('.composer-resident textarea') !== null`)
      await page.evaluate(`document.querySelector('[aria-label="Open sessions"]').click()`)
      await until(page, `document.querySelector('.overlay--sessions-sheet [data-session-id="ses_idle_pinned"]') !== null`)
      expect(await page.evaluate<string[]>(groups('.overlay--sessions-sheet'))).toEqual(expected)
    } finally { await page.close() }
  }, 30_000)

  test("UI correction: Ctrl and Cmd K open the palette with either rail state", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.workspace__rail input[aria-label="Search sessions"]') !== null`)
      expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail input[aria-label="Search sessions"]').closest('label').querySelector('kbd') === null`)).toBe(true)
      for (const collapsed of [false, true]) {
        if (collapsed) { await page.evaluate(`document.querySelector('[aria-label="Hide workspace sidebar"]').click()`); await until(page, `document.querySelector('.app--rail-collapsed') !== null`) }
        for (const modifier of ["ctrlKey", "metaKey"]) {
          await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ${modifier}: true, bubbles: true, cancelable: true }))`)
          await until(page, `document.querySelector('dialog.overlay--command-palette[open]') !== null`)
          await until(page, `document.activeElement === document.getElementById('command-palette-input')`)
          await page.pressEscape()
          await until(page, `document.querySelector('dialog.overlay--command-palette') === null`)
        }
      }
      await page.evaluate(`document.querySelector('[aria-label="Show workspace sidebar"]').click()`)
      await until(page, `document.querySelector('.workspace__rail').getBoundingClientRect().width === 256`)
    } finally { await page.close() }
  }, 30_000)

  test("UI correction: context hierarchy distinguishes measured window from estimate", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1&theme=dark`)
      await until(page, `document.querySelector('.companion-context-trigger') !== null`)
      await page.evaluate(`document.querySelector('.companion-context-trigger').click()`)
      await until(page, `document.querySelector('#companion-context:not([hidden]) .companion__context-total') !== null`)
      const typography = await page.evaluate<{ total: { fontSize: string; fontWeight: string; color: string; fontFamily: string }; capacity: { fontSize: string; fontWeight: string; color: string; fontFamily: string }; eyebrow: { fontFamily: string; textTransform: string }; primary: string; mono: string; sans: string; totalText: string; capacityText: string; eyebrowText: string; summaryText: string; summaryFont: string; oneRow: boolean; count: number; rows: number }>(`(() => { const context=document.querySelector('#companion-context'), style = selector => { const s=getComputedStyle(context.querySelector(selector)); return { fontSize:s.fontSize,fontWeight:s.fontWeight,color:s.color,fontFamily:s.fontFamily.replaceAll('"','') } }, total=context.querySelector('.companion__context-total').getBoundingClientRect(), capacity=context.querySelector('.companion__context-capacity').getBoundingClientRect(); return { total:style('.companion__context-total'), capacity:style('.companion__context-capacity'), eyebrow:{ fontFamily:getComputedStyle(context.querySelector('.companion__context-eyebrow')).fontFamily.replaceAll('"',''), textTransform:getComputedStyle(context.querySelector('.companion__context-eyebrow')).textTransform }, primary:getComputedStyle(context).color, mono:getComputedStyle(context).getPropertyValue('--yc-font-mono').trim().replaceAll('"',''), sans:getComputedStyle(context).getPropertyValue('--yc-font-sans').trim().replaceAll('"',''), totalText:context.querySelector('.companion__context-total').textContent, capacityText:context.querySelector('.companion__context-capacity').textContent, eyebrowText:context.querySelector('.companion__context-eyebrow').textContent, summaryText:context.querySelector('.rl-context-summary').textContent, summaryFont:getComputedStyle(context.querySelector('.rl-context-summary')).fontFamily.replaceAll('"',''), oneRow: capacity.left >= total.right && capacity.top < total.bottom, count:context.querySelectorAll('.companion__context-bar-segment').length, rows:context.querySelectorAll('.companion__context-swatch').length } })()`)
      expect(typography.total).toEqual({ fontSize: "28px", fontWeight: "700", color: typography.primary, fontFamily: typography.mono })
      expect(typography.capacity.fontSize).toBe("14px")
      expect(typography.capacity.fontFamily).toBe(typography.mono)
      expect(typography.capacity.color).not.toBe(typography.primary)
      expect(typography.eyebrow).toEqual({ fontFamily: typography.mono, textTransform: "none" })
      expect(typography.eyebrowText).toBe("Active window")
      expect(typography.totalText).toBe("24K")
      expect(typography.capacityText).toBe("/ 128K tokens")
      expect(typography.summaryText).toBe("104,000 remaining · 19% used")
      expect(typography.summaryFont).toBe(typography.sans)
      expect(typography.oneRow).toBe(true)
      expect([typography.count, typography.rows]).toEqual([7, 7])
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1&theme=dark`)
      await until(page, `document.querySelector('.companion-context-trigger') !== null`)
      await page.evaluate(`document.querySelector('.companion-context-trigger').click()`)
      await until(page, `document.querySelector('#companion-context:not([hidden]) .companion__context-total') !== null`)
      expect(await page.evaluate<boolean>(`(() => { const context=document.querySelector('#companion-context'), sheet=document.querySelector('#session-companion-panel'), total=context.querySelector('.companion__context-total').getBoundingClientRect(), capacity=context.querySelector('.companion__context-capacity').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && sheet.scrollWidth <= sheet.clientWidth && context.scrollWidth <= context.clientWidth && capacity.left >= total.right && capacity.top < total.bottom && capacity.right <= sheet.getBoundingClientRect().right })()`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("UI correction: dark phone chat does not overflow horizontally", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1&theme=dark`)
      await until(page, `document.querySelector('.composer-resident textarea') !== null`)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.workspace__main').getBoundingClientRect().right <= innerWidth`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("UI correction: composer names creation and existing Session actions separately", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.composer-resident:not([inert]) .mini-composer__send') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('.composer-resident:not([inert]) .mini-composer__send').getAttribute('aria-label')`)).toBe("Send prompt")
      await page.evaluate(`document.querySelector('.workspace__rail .workspace__new-chat').click()`)
      await until(page, `document.querySelector('.new-session-composer:not([inert]) .mini-composer__send') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('.new-session-composer:not([inert]) .mini-composer__send').getAttribute('aria-label')`)).toBe("New chat")
    } finally { await page.close() }
  }, 30_000)

  test("daily spend table displays unavailable costs without hiding known costs", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=usage`)
      await until(page, `document.querySelector('.usage-chart__head button') !== null`)
      await page.evaluate(`document.querySelector('.usage-chart__head button').click()`)
      await until(page, `document.querySelectorAll('#usage-daily-table tbody tr').length === 30`)
      const costs = await page.evaluate<string[]>(`[...document.querySelectorAll('#usage-daily-table tbody tr td:first-of-type')].map(cell => cell.textContent.trim())`)
      expect(costs).toContain("—")
      expect(costs.some((cost) => cost.startsWith("$"))).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("captured changes header shares one row and expands full width", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.file-change-card__view') !== null`)
      expect(await page.evaluate<boolean>(`(() => { const card=document.querySelector('.file-change-card'), summary=card.querySelector('.file-change-card__summary').getBoundingClientRect(), view=card.querySelector('.file-change-card__view').getBoundingClientRect(); return summary.top < view.bottom && view.top < summary.bottom && view.height >= 44 })()`)).toBe(true)
      await page.evaluate(`document.querySelector('.file-change-card__summary').click()`)
      expect(await page.evaluate<boolean>(`(() => { const card=document.querySelector('.file-change-card'), files=card.querySelector('.file-change-card__files'); return !files.hidden && Math.abs(files.getBoundingClientRect().width - card.getBoundingClientRect().width) < 1 })()`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("rail labels, row actions and running Session remain independently visible", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 1000)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.workspace__rail [data-session-id="ses_running"]') !== null`)
      const layout = await page.evaluate<{ filters: boolean; spacing: boolean; pins: boolean; rows: boolean; heights: boolean; running: boolean }>(`(() => { const rail = document.querySelector('.workspace__rail'), root = rail.querySelector('.workspace__rail-body'), chips = [...rail.querySelectorAll('.session-filters__option')], box = e => e.getBoundingClientRect(), text = e => { const range = document.createRange(); range.selectNodeContents(e); return range.getBoundingClientRect() }, hit = (a,b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom, rows = [...rail.querySelectorAll('.session-row')], running = box(rail.querySelector('[data-session-id="ses_running"] .session-row__name')), viewport = box(root); return { filters: chips.every((e,i) => chips.slice(i+1).every(other => !hit(box(e),box(other))) && e.scrollWidth <= e.clientWidth), spacing: chips.slice(1).every((e,i) => text(e).left - text(chips[i]).right >= 4), pins: rail.querySelectorAll('.session-pin__button').length === 0, rows: rows.every(row => box(row).width >= box(rail).width - 40), heights: rows.every(row => box(row).height === 36), running: running.top >= viewport.top && running.bottom <= viewport.bottom } })()`)
      expect(layout).toEqual({ filters: true, spacing: true, pins: true, rows: true, heights: true, running: true })
      await page.evaluate(`document.querySelector('.workspace__rail .workspace__new-chat').click()`)
      await until(page, `document.querySelector('.workspace__rail .resume-session') !== null || location.pathname === '/remote'`)
      expect(await page.evaluate<boolean>(`(() => { const rail=document.querySelector('.workspace__rail'), bounds=rail.querySelector('.workspace__rail-body').getBoundingClientRect(), row=rail.querySelector('[data-session-id="ses_running"] .session-row__name').getBoundingClientRect(), heading=[...rail.querySelectorAll('.session-list__group')].find(e=>e.textContent.trim() === 'ycoding').getBoundingClientRect(); return [row,heading].every(r=>r.top>=bounds.top-1 && r.bottom<=bounds.bottom+1) })()`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("open companion leaves title unobstructed and styles its context", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 1000)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.companion-context-trigger') !== null`)
      const closedHeight = await page.evaluate<number>(`document.querySelector('.workspace__heading').getBoundingClientRect().height`)
      await page.evaluate(`document.querySelector('.companion-context-trigger').click()`)
      await until(page, `document.querySelector('#companion-context:not([hidden]) .companion__context-total') !== null`)
      const layout = await page.evaluate<{ titleHit: boolean; bodyStyled: boolean }>(`(() => { const title = document.querySelector('.conversation-breadcrumb h1'), r = title.getBoundingClientRect(), hit = document.elementFromPoint(r.left + Math.min(70,r.width-2),r.top+r.height/2), body = document.querySelector('#companion-context .rl-context-summary'); return { titleHit: title.contains(hit), bodyStyled: parseFloat(getComputedStyle(body).fontSize) < 16 } })()`)
      expect(layout).toEqual({ titleHit: true, bodyStyled: true })
      expect(await page.evaluate<string>(`document.querySelector('.companion__context-eyebrow')?.textContent`)).toBe("Active window")
      expect(await page.evaluate<number>(`document.querySelectorAll('.companion__context-bar .companion__context-bar-segment').length`)).toBe(7)
      expect(await page.evaluate<number>(`document.querySelectorAll('.companion__context-breakdown .companion__context-swatch').length`)).toBe(7)
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.companion__context-row dt')].map((element) => element.textContent.trim())`)).toEqual(["System", "Tools", "User", "Assistant", "Reasoning", "Tool calls", "Other"])
      expect(await page.evaluate<boolean>(`(() => { const segments = [...document.querySelectorAll('.companion__context-bar-segment')]; return segments.map((segment) => Number.parseFloat(getComputedStyle(segment).flexGrow)).join(',') === '3200,4800,2400,4600,3000,5200,800' })()`)).toBe(true)
      const breakdown = await page.evaluate<string[][]>(`[...document.querySelectorAll('#companion-context .companion__context-row')].map((row) => [...row.querySelectorAll('dd')].map((value) => value.textContent.trim()))`)
      expect(breakdown[0]).toEqual(["3,200", "13.3%"])
      expect(breakdown[5]).toEqual(["5,200", "21.7%"])
      expect(await page.evaluate<boolean>(`(() => { const rows = [...document.querySelectorAll('#companion-context .companion__context-row')]; return [0, 1].every((column) => new Set(rows.map((row) => Math.round(row.querySelectorAll('dd')[column].getBoundingClientRect().right))).size === 1) })()`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector('#companion-context')?.innerText ?? ''`)).toContain("Estimated input breakdown by category, separate from provider-reported window tokens and cumulative spend.")
      expect(await page.evaluate<number>(`document.querySelector('.workspace__heading').getBoundingClientRect().height`)).toBeLessThanOrEqual(closedHeight + 8)
    } finally { await page.close() }
  }, 30_000)

  test("composer presents model, agent and autonomy in one desktop metadata row", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 1000)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.composer .session-status__autonomous-trigger') !== null`)
      const sameRow = await page.evaluate<boolean>(`(() => { const root = document.querySelector('.composer'), elements = ['.model-control__trigger','.mini-picker__trigger','.session-status__autonomous-trigger'].map(s => root.querySelector(s).getBoundingClientRect()); return Math.max(...elements.map(r => r.top)) < Math.min(...elements.map(r => r.bottom)) })()`)
      expect(sameRow).toBe(true)
      expect(await page.evaluate<boolean>(`document.querySelector('.workspace__main .session-status__modes,.workspace__main .session-status__active-goal') === null`)).toBe(true)
      await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
      await until(page, `document.querySelector('#session-companion-panel') !== null`)
      const details = await page.evaluate<string>(`document.querySelector('#session-companion-panel').innerText`)
      expect(details).toContain('Permissions Auto')
      expect(details).toContain('Guardrails Auto')
      expect(details).toContain('Goal active · Ship the remote workspace')
      const narrowed = await page.evaluate<boolean>(`(() => { const root=document.querySelector('.composer'), elements=['.model-control__trigger','.mini-picker__trigger','.session-status__autonomous-trigger'].map(s=>root.querySelector(s).getBoundingClientRect()); return Math.max(...elements.map(r=>r.top)) < Math.min(...elements.map(r=>r.bottom)) })()`)
      expect(narrowed).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("phone composer keeps primary selectors together and details in the companion", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.composer__mobile-trigger') !== null && document.querySelector('.session-status__goal-trigger') !== null`)
      const result = await page.evaluate<{ row: boolean; detailsAbsent: boolean }>(`(() => { const composer=document.querySelector('.composer'), rects=['.composer__mobile-trigger','.session-status__autonomous-trigger','.session-status__goal-trigger'].map(s=>composer.querySelector(s).getBoundingClientRect()); return { row: Math.max(...rects.map(r=>r.top)) < Math.min(...rects.map(r=>r.bottom)), detailsAbsent: !document.querySelector('.session-status__modes,.session-status__active-goal') } })()`)
      expect(result).toEqual({ row: true, detailsAbsent: true })
      await page.evaluate(`document.querySelector('.companion-context-trigger').click()`)
      await until(page, `document.querySelector('#session-companion-panel .session-status__active-goal') !== null`)
      const text = await page.evaluate<string>(`document.querySelector('#session-companion-panel').innerText`)
      expect(text).toContain('Permissions Auto')
      expect(text).toContain('Guardrails Auto')
      expect(text).toContain('Goal active · Ship the remote workspace')
    } finally { await page.close() }
  }, 30_000)

  test("Usage range text and refresh fit their buttons", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=usage&acceptedPreview=1`)
      await until(page, `document.querySelector('.usage-refresh') !== null && document.querySelector('[aria-label="Usage range"]') !== null`)
      const fits = await page.evaluate<boolean>(`(() => { const range = [...document.querySelectorAll('[aria-label="Usage range"] button')], refresh = document.querySelector('.usage-refresh'), buttons = [...range, refresh]; return buttons.every(e => { const r=e.getBoundingClientRect(), g=document.createRange(); g.selectNodeContents(e); const t=g.getBoundingClientRect(); return t.left >= r.left && t.right <= r.right && t.top >= r.top && t.bottom <= r.bottom && t.height <= parseFloat(getComputedStyle(e).lineHeight) + 2 }) && new Set(range.map(e => e.getBoundingClientRect().top)).size === 1 })()`)
      expect(fits).toBe(true)
    } finally { await page.close() }
  }, 30_000)
  test("rail children and search stay inside the compact navigation", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.workspace__rail .session-list') !== null`)
      const bounds = await page.evaluate<{ over: string[] }>(`(() => { const rail = document.querySelector('.workspace__rail'), right = rail.getBoundingClientRect().right; return { over: [...rail.querySelectorAll('*')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > right + 0.5).map(e => e.className) } })()`)
      expect(bounds.over).toEqual([])
    } finally { await page.close() }
  }, 30_000)

  test("phone composer controls have separate hit targets and a compact header", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.composer__mobile-trigger') !== null && document.querySelector('.companion-context-trigger') !== null`)
      const result = await page.evaluate<{ goalHit: string; overlap: boolean; title: number; context: number; disclosure: boolean }>(`(() => { const goal = document.querySelector('.session-status__goal-trigger'), attach = document.querySelector('[aria-label="Attach files"]'), mobile = document.querySelector('.composer__mobile-trigger'), title = document.querySelector('.conversation-breadcrumb h1'), context = document.querySelector('.companion-context-trigger'); const g = goal.getBoundingClientRect(), a = attach.getBoundingClientRect(), m = mobile.getBoundingClientRect(); return { goalHit: document.elementFromPoint(g.x + g.width / 2, g.y + g.height / 2)?.closest('button')?.getAttribute('aria-label'), overlap: a.left < m.right && a.right > m.left && a.top < m.bottom && a.bottom > m.top, title: title.getBoundingClientRect().width, context: context.getBoundingClientRect().height, disclosure: document.body.innerText.includes('browser cannot read host paths') } })()`)
      expect(result.goalHit).toBe("Goal active")
      expect(result.overlap).toBe(false)
      expect(result.title).toBeGreaterThanOrEqual(80)
      expect(result.context).toBeLessThanOrEqual(44)
      expect(result.disclosure).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("phone companion is named and offers one back action", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('[aria-label="Open Team"]') !== null`)
      await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
      await until(page, `document.querySelector('#session-companion-panel') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('#session-companion-panel').getAttribute('aria-label')`)).toBe("Session companion")
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('#session-companion-panel button')].some(button => button.textContent.includes('Back to chat'))`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('#session-companion-panel [aria-label="Close Team"]').length`)).toBe(1)
      expect(await page.evaluate<number>(`document.querySelectorAll('#session-companion-panel .team-view__header').length`)).toBe(0)
      expect(await page.evaluate<number>(`[...document.querySelectorAll('#session-companion-panel strong')].filter(e => e.textContent.trim().toLowerCase() === 'session companion' && e.getClientRects().length).length`)).toBe(0)
    } finally { await page.close() }
  }, 30_000)

  test("desktop composer and title remain contained with the companion open", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.mini-composer__input-wrap') !== null`)
      await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
      await until(page, `document.querySelector('#session-companion-panel') !== null`)
      const result = await page.evaluate<{ inside: boolean; title: number }>(`(() => { const box = document.querySelector('.composer').getBoundingClientRect(), controls = [...document.querySelectorAll('.composer .composer__attach, .composer .mini-composer__send')]; return { inside: controls.length === 2 && controls.every(e => { const r = e.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom }), title: document.querySelector('.conversation-breadcrumb h1').getBoundingClientRect().width } })()`)
      expect(result.inside).toBe(true)
      expect(result.title).toBeGreaterThanOrEqual(140)
    } finally { await page.close() }
  }, 30_000)

  test("new chat hero keeps its brand and copy within the phone viewport", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `[...document.querySelectorAll('[aria-label="New chat"]')].some(button => button.getClientRects().length)`)
      await page.evaluate(`[...document.querySelectorAll('[aria-label="New chat"]')].find(button => button.getClientRects().length).click()`)
      await until(page, `document.querySelector('.new-session-composer__header h2') !== null`)
      const result = await page.evaluate<{ brand: boolean; vertical: boolean; overflow: boolean }>(`(() => { const header = document.querySelector('.new-session-composer__header'), brand = header.querySelector('.brand__mark'), children = [...header.children].map(e => e.getBoundingClientRect()); return { brand: !!brand && brand.getBoundingClientRect().width > 0, vertical: children.every((r, i) => i === 0 || r.top >= children[i-1].bottom), overflow: children.some(r => r.left < 0 || r.right > innerWidth) } })()`)
      expect(result).toEqual({ brand: true, vertical: true, overflow: false })
      const copy = await page.evaluate<{ aligned: boolean; agentFits: boolean }>(`(() => { const section = document.querySelector('.new-session-composer'), paragraphs = [...section.children].filter(e => e.tagName === 'P'), agent = section.querySelector('.composer__controls .mini-picker__trigger'); return { aligned: paragraphs.every(e => getComputedStyle(e).textAlign === 'center'), agentFits: !!agent && agent.scrollWidth <= agent.clientWidth && [...agent.querySelectorAll('*')].every(e => e.scrollWidth <= e.clientWidth) } })()`)
      expect(copy).toEqual({ aligned: true, agentFits: true })
    } finally { await page.close() }
  }, 30_000)
  test("pinned Session status and pin remain on one desktop row", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 1000)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&acceptedPreview=1`)
      await until(page, `document.querySelector('.sessions-table__row [aria-pressed="true"]') !== null`)
      const inline = await page.evaluate<boolean>(`(() => { const row=document.querySelector('.sessions-table__row:has([aria-pressed="true"])'), status=row.querySelector('.sessions-table__status .chip').getBoundingClientRect(), pin=row.querySelector('.session-pin__button').getBoundingClientRect(); return status.top < pin.bottom && pin.top < status.bottom })()`)
      expect(inline).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("phone Sessions heading clears its header and pinned actions stay compact", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&acceptedPreview=1`)
      await until(page, `document.querySelector('.sessions-page h1') !== null && document.querySelector('.sessions-table__row .session-pin__button') !== null`)
      const result = await page.evaluate<{ top: number; headerBottom: number; projects: boolean; pins: string[] }>(`(() => { const h = document.querySelector('.sessions-page h1').getBoundingClientRect(), header = document.querySelector('.app-header').getBoundingClientRect(); return { top: h.top, headerBottom: header.bottom, projects: !!document.querySelector('.sessions-page a[href="/remote/projects"]'), pins: [...document.querySelectorAll('.sessions-table__row .session-pin__button')].map(e => getComputedStyle(e).backgroundColor) } })()`)
      expect(result.top).toBeGreaterThanOrEqual(result.headerBottom)
      expect(result.projects).toBe(false)
      expect(new Set(result.pins).size).toBe(1)
    } finally { await page.close() }
  }, 30_000)
  test("workspace shows the accepted navigation and a docked companion", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.workspace__rail') !== null`)
      expect(await page.evaluate<number>(`document.querySelector('.workspace__rail').getBoundingClientRect().width`)).toBe(256)
      expect(await page.evaluate<string>(`document.querySelector('.workspace__rail .session-list__group').textContent.trim()`)).toBe('ycoding')
      expect((await page.evaluate<string>(`document.querySelector('.workspace__rail').innerText`)).toLowerCase()).not.toContain('needs action')
      await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
      await until(page, `document.querySelector('#session-companion-panel') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('#session-companion-panel').innerText`)).toContain('Activity')
      expect(await page.evaluate<boolean>(`document.querySelector('#session-companion-panel').contains(document.activeElement)`)).toBe(true)
      await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await until(page, `document.querySelector('[aria-label="Open Team"]').getAttribute('aria-expanded') === 'false'`)
    } finally { await page.close() }
  }, 30_000)

  for (const width of [390, 1440]) test(`Session companion tabs and dismissal remain keyboard operable at ${width}`, async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('[aria-label="Open Team"]') !== null`)
      await page.evaluate(`document.querySelector('[aria-label="Open Team"]').focus(); document.querySelector('[aria-label="Open Team"]').click()`)
      await until(page, `document.querySelector('[role="tab"][aria-selected="true"]') !== null`)
      await page.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
      expect(await page.evaluate<string>(`document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim()`)).toBe("Changes")
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('[role="tab"][aria-selected="true"]')`)).toBe(true)
      if (width === 1440) expect(await page.evaluate<number>(`document.querySelector('#session-companion-panel').getBoundingClientRect().width`)).toBe(448)
      await page.pressEscape()
      await until(page, `document.querySelector('[aria-label="Open Team"]').getAttribute('aria-expanded') === 'false'`)
      await until(page, `document.activeElement === document.querySelector('[aria-label="Open Team"]')`)
    } finally { await page.close() }
  }, 30_000)

  test("new chat is accessible on phone and explains its workspace boundary", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `[...document.querySelectorAll('[aria-label="New chat"]')].some(button => button.getClientRects().length > 0)`)
      await page.evaluate(`[...document.querySelectorAll('[aria-label="New chat"]')].find(button => button.getClientRects().length > 0).click()`)
      await until(page, `document.body.innerText.includes('Start with a conversation.')`)
      expect(await page.evaluate<string>(`document.body.innerText`)).toContain('requires selecting a repository')
    } finally { await page.close() }
  }, 30_000)

  test("usage exposes quick ranges and a visible refresh label", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=usage`)
      await until(page, `document.body.innerText.includes('Usage')`)
      const text = await page.evaluate<string>(`document.body.innerText`)
      expect(text).toContain('7 days')
      expect(text).toContain('30 days')
      expect(text).toContain('Refresh')
      const controls = await page.evaluate<{ fits: boolean; nowrap: boolean }>(`(() => { const buttons = [...document.querySelectorAll('[aria-label="Usage range"] button'), document.querySelector('.usage-refresh')], page = document.querySelector('.usage-page').getBoundingClientRect(); return { fits: buttons.every(e => e.getBoundingClientRect().right <= page.right), nowrap: buttons.every(e => getComputedStyle(e).whiteSpace === 'nowrap') } })()`)
      expect(controls).toEqual({ fits: true, nowrap: true })
      for (const range of ['Today', '7 days', '30 days']) {
        await page.evaluate(`[...document.querySelectorAll('[aria-label="Usage range"] button')].find(button => button.textContent === ${JSON.stringify(range)}).click()`)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[aria-label="Usage range"] button[aria-pressed="true"]')].map(button => button.textContent)`)).toEqual([range])
      }
    } finally { await page.close() }
  }, 30_000)
  test("permission conflicts remain visible on the request card", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1&permissionConflict=hold`)
      await until(page, `document.querySelector('.request--permission .button--primary') !== null`)
      await page.evaluate(`document.querySelector('.request--permission .button--primary').click()`)
      await until(page, `typeof window.releasePermissionConflict === 'function' && document.querySelector('.request--permission .request__note[role=status]')?.textContent.includes('Sending human decision')`)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.request--permission .request__actions button')].every(button => button.disabled)`)).toBe(true)
      await page.evaluate(`window.releasePermissionConflict()`)
      await until(page, `document.querySelector('.request--permission .request__note[role=status]')?.textContent.includes('already settled from another browser')`)
      expect(await page.evaluate<boolean>(`document.querySelector('.request--permission') !== null`)).toBe(true)
      await page.evaluate(`document.querySelector('.request--permission .button--danger').click()`)
      await until(page, `document.querySelector('.request--permission .request__note[role=status]')?.textContent.includes('Sending human decision')`)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.request--permission .request__actions button')].every(button => button.disabled)`)).toBe(true)
      await page.evaluate(`window.releasePermissionConflict()`)
      await until(page, `document.querySelector('.request--permission .request__note[role=status]')?.textContent.includes('already settled from another browser')`)
    } finally { await page.close() }
  }, 30_000)

  test("Settings explains browser closing and machine-managed capabilities", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const width of [390, 1440]) {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings`)
        await until(page, `document.querySelector('[aria-labelledby="app-settings"]') !== null`)
        const text = await page.evaluate<string>(`document.querySelector('[aria-labelledby="app-settings"]').innerText`)
        expect(text).toContain("Closing this browser disconnects only this tab")
        expect(text).toContain("Saved permissions, MCP servers, plugins and project artifacts")
        expect(text).toContain("interactive terminals or Git working trees")
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
      }
    } finally { await page.close() }
  }, 30_000)

  test("rail rows carry no pin while the Sessions table pins and unpins without opening a Session", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('.workspace__rail [data-session-id="ses_running"]') !== null`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .session-pin__button').length`)).toBe(0)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&acceptedPreview=1`)
      await until(page, `document.querySelector('.sessions-table button[aria-label="Pin Verify provider auth fallback"]') !== null`)
      await page.evaluate(`document.querySelector('.sessions-table button[aria-label="Pin Verify provider auth fallback"]').click()`)
      await until(page, `document.querySelector('.sessions-table button[aria-label="Unpin Verify provider auth fallback"][aria-pressed="true"]') !== null`)
      expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote/sessions")
      await page.evaluate(`document.querySelector('.sessions-table button[aria-label="Unpin Verify provider auth fallback"]').click()`)
      await until(page, `document.querySelector('.sessions-table button[aria-label="Pin Verify provider auth fallback"][aria-pressed="false"]') !== null`)
      expect(await page.evaluate<string[]>(`window.requestLog.filter(item => item.operation === 'session.pin' || item.operation === 'session.unpin').map(item => item.operation)`)).toEqual(["session.pin", "session.unpin"])
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('[aria-label="Open sessions"]') !== null`)
      await page.evaluate(`document.querySelector('[aria-label="Open sessions"]').click()`)
      await until(page, `document.querySelector('.overlay--sessions-sheet [data-session-id="ses_running"]') !== null`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.overlay--sessions-sheet .session-pin__button').length`)).toBe(0)
    } finally { await page.close() }
  }, 30_000)

  test("Sessions page pin controls report failures without changing state", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&acceptedPreview=1&pinFailure=1`)
      await until(page, `document.querySelector('.sessions-table__row button[aria-label="Pin Verify provider auth fallback"]') !== null`)
      await page.evaluate(`document.querySelector('.sessions-table__row button[aria-label="Pin Verify provider auth fallback"]').click()`)
      await until(page, `document.querySelector('.session-pin__error')?.textContent.includes('Pinning denied')`)
      expect(await page.evaluate<string>(`document.querySelector('.sessions-table__row button[aria-label="Pin Verify provider auth fallback"]').getAttribute('aria-pressed')`)).toBe("false")
      expect(await page.evaluate<string[]>(`window.requestLog.filter(item => item.operation === 'session.pin' || item.operation === 'session.unpin').map(item => item.operation)`)).toEqual(["session.pin"])
    } finally { await page.close() }
  }, 30_000)
  test("five workspace destinations have distinct routes, current-page state and working history", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two`)
      await until(page, `document.querySelector('.remote-nav') !== null`)
      for (const [label, path] of [["Projects", "/remote/projects"], ["Sessions", "/remote/sessions"], ["Workspaces", "/remote/workspaces"], ["Usage", "/remote/usage"], ["Settings", "/remote/settings"]] as const) {
        const previous = await page.evaluate<string>(`location.pathname`)
        await page.evaluate(`document.querySelector('.remote-nav a.remote-nav__link--${label.toLowerCase()}').click()`)
        await until(page, `location.pathname === ${JSON.stringify(path)} && document.querySelector('.remote-nav a.remote-nav__link--${label.toLowerCase()}')?.getAttribute('aria-current') === 'page'`)
        expect(await page.evaluate<number>(`document.querySelectorAll('.remote-nav [aria-current="page"]').length`)).toBe(1)
        if (label === "Workspaces") {
          await until(page, `document.querySelector('.workspaces-page')?.innerText.includes('Other repository')`)
          expect(await page.evaluate<boolean>(`document.querySelectorAll('.workspace__rail').length === 1 && document.querySelectorAll('.workspaces-page h1').length === 1`)).toBe(true)
        }
        await page.evaluate(`history.back()`)
        const previousLabel = previous === "/remote/session" ? "Sessions" : previous.split("/").at(-1)!.replace(/^./, (first) => first.toUpperCase())
        await until(page, `location.pathname === ${JSON.stringify(previous)} && document.querySelector('.remote-nav a.remote-nav__link--${previousLabel.toLowerCase()}')?.getAttribute('aria-current') === 'page'`)
        await page.evaluate(`history.forward()`)
        await until(page, `location.pathname === ${JSON.stringify(path)} && document.querySelector('.remote-nav a.remote-nav__link--${label.toLowerCase()}')?.getAttribute('aria-current') === 'page'`)
      }
      await page.evaluate(`history.back()`)
      await until(page, `location.pathname === '/remote/usage' && document.querySelector('.remote-nav a.remote-nav__link--usage')?.getAttribute('aria-current') === 'page'`)
      await page.evaluate(`history.forward()`)
      await until(page, `location.pathname === '/remote/settings' && document.querySelector('.remote-nav a.remote-nav__link--settings')?.getAttribute('aria-current') === 'page'`)
      expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote/settings")
    } finally { await page.close() }
  }, 30_000)
  test("workspace directory shows actual repositories and reports empty and failed reads on phone", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      for (const [query, text] of [["", "Other repository"], ["&workspaces=many", "llama-cpp-proxy-with-a-long-repository-name"], ["&workspaces=empty", "No previously opened workspaces"], ["&workspaces=error", "Workspace inventory unavailable"]] as const) {
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=workspaces${query}`)
        await until(page, `document.querySelector('.workspaces-page')?.innerText.includes(${JSON.stringify(text)})`)
        expect(await page.evaluate<boolean>(`(() => { const page=document.querySelector('.workspaces-page'); return page.getBoundingClientRect().width > 0 && document.documentElement.scrollWidth <= innerWidth })()`)).toBe(true)
      }
    } finally { await page.close() }
  }, 30_000)
  test("companion overlays at 1180px and docks above it", async () => {
    for (const width of [1180, 1181]) {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two`)
        await until(page, `document.querySelector('[aria-label="Open Team"]:not([disabled])') !== null`)
        await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
        await until(page, `document.querySelector('.team-control__panel') !== null`)
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.team-control__panel')).position`)).toBe(width === 1180 ? "fixed" : "static")
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)
  test("Team shows the current Session context, autonomy and active goal", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1`)
      await until(page, `document.querySelector('[aria-label="Open Team"]:not([disabled])') !== null`)
      await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
      await until(page, `document.querySelector('.companion__header') !== null`)
      await page.evaluate(`document.querySelector('.companion__tabs [aria-controls="companion-context"]').click()`)
      const summary = await page.evaluate<string>(`document.querySelector('#companion-context').innerText`)
      expect(summary).toContain("104,000 remaining · 19% used")
      expect(summary).toContain("Open Usage · cumulative spend")
      expect(summary).toContain("Compact context")
      expect(summary).toContain("Loaded transcript messages")
      expect(await page.evaluate<number>(`document.querySelectorAll('#companion-context .companion__context-actions').length`)).toBe(0)
      expect(await page.evaluate<string>(`document.querySelector('.companion__header').innerText`)).toContain("Autonomous")
      expect(await page.evaluate<string>(`document.querySelector('.companion__header').innerText`)).toContain("Goal · Active")
      expect(await page.evaluate<boolean>(`document.querySelector('.team-view__session-summary') === null`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.querySelector('.workspace__main').getBoundingClientRect().right <= document.querySelector('.team-control__panel').getBoundingClientRect().left`)).toBe(true)
      await page.evaluate(`[...document.querySelectorAll('.companion__header button')].find(button => button.textContent.includes('Autonomous')).click()`)
      await until(page, `document.querySelector('dialog[aria-label="Autonomous"]') !== null`)
    } finally { await page.close() }
  }, 30_000)
  for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of ["light", "dark"] as const) {
    test(`session navigation shows priority counts and filters at ${width} in ${theme}`, async () => {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&acceptedPreview=1&theme=${theme}`)
        await until(page, `document.querySelector('.composer-resident textarea') !== null`)
        if (width < 768) await page.evaluate(`document.querySelector('[aria-label="Open sessions"]').click()`)
        const panel = width < 768 ? ".overlay--sessions-sheet" : ".workspace__rail"
        await until(page, `document.querySelector('${panel} .session-filters button')?.getAttribute('aria-label') === 'All 3'`)
        await until(page, `document.querySelector('${panel} .session-row__state')?.textContent === 'Waiting'`)
        expect(await page.evaluate<number>(`document.querySelectorAll('${panel} .session-pin__button, ${panel} .session-row__meta, ${panel} .session-panel__summary').length`)).toBe(0)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('${panel} .session-filters button')].map(button => button.getAttribute('aria-label'))`)).toEqual(["All 3", "Waiting 1", "Running 1", "Idle 1"])
        expect(await page.evaluate<number>(`new Set([...document.querySelectorAll('${panel} .session-filters button')].map(button => Math.round(button.getBoundingClientRect().top))).size`)).toBe(1)
        expect(await page.evaluate<boolean>(`(() => { const strip = document.querySelector('${panel} .session-filters'), box = strip.getBoundingClientRect(); return [...strip.children].every((button) => button.getBoundingClientRect().right <= box.right + 0.5) })()`)).toBe(true)
        expect(await page.evaluate<string>(`document.querySelector('${panel} .session-list__group').textContent.trim()`)).toBe("ycoding")
        expect(await page.evaluate<string>(`document.querySelector('${panel} .session-list').textContent`)).toContain("Waiting for approval")
        await page.evaluate(`document.querySelector('${panel} .session-filters button:nth-child(2)').click()`)
        await until(page, `document.querySelector('${panel} .session-filters button:nth-child(2)')?.getAttribute('aria-pressed') === 'true'`)
        await page.evaluate(`document.querySelector('${panel} .session-filters button:first-child').click()`)
        await until(page, `document.querySelector('${panel} .session-filters button:first-child')?.getAttribute('aria-pressed') === 'true'`)
        if (width < 768) {
          await page.pressEscape()
          await until(page, `document.querySelector('.overlay--sessions-sheet') === null`)
        }
        await until(page, `document.querySelector('.file-change-card__summary') !== null`)
        await page.evaluate(`document.querySelector('.file-change-card__summary').click()`)
        await until(page, `document.querySelector('.file-change-card__file-toggle') !== null`)
        await page.evaluate(`document.querySelector('.file-change-card__file-toggle').click()`)
        await until(page, `document.querySelector('.file-change-card__diff .file-change-card__code') !== null && document.querySelector('${width < 768 ? ".composer__mobile-context-ring" : ".composer__context"}') !== null`)
        expect(await page.evaluate<string>(`document.querySelector('${width < 768 ? ".composer__mobile-trigger" : ".composer__context-trigger"}').getAttribute('aria-label')`)).toContain("19% used · 81% left")
        expect(await page.evaluate<string>(`document.querySelector('.file-change-card__diff').innerText`)).toContain("export { next }")
        if (width >= 768) {
          await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
          await until(page, `document.querySelector('.companion__tabs [aria-controls="companion-context"]') !== null`)
          await page.evaluate(`document.querySelector('.companion__tabs [aria-controls="companion-context"]').click()`)
          await until(page, `document.querySelector('#companion-context')?.innerText.includes('19% used')`)
          await until(page, `document.querySelector('.team-control__panel:not(.team-control--entering)') !== null`)
          await page.evaluate(`Promise.all(document.querySelector('.team-control__panel').getAnimations().map(animation => animation.finished.catch(() => undefined)))`)
        }
        await page.evaluate(`document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove()`)
        if (width < 768) {
          await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = root.scrollHeight })()`)
          expect(await page.evaluate<boolean>(`(() => { const deny = document.querySelector('.request--permission .button--danger').getBoundingClientRect(), nav = document.querySelector('.transcript-navigation__controls').getBoundingClientRect(); return deny.bottom <= nav.top || deny.right <= nav.left })()`)).toBe(true)
        }
        const directory = process.env.YCODING_WEB_CAPTURE_DIR
        if (directory) await Bun.write(join(directory, `accepted-ui-unobscured-${width}-${theme}-${crypto.randomUUID()}.png`), Buffer.from(await page.screenshot(), "base64"))
        if (width < 768) {
          await page.wheel(width / 2, height / 3, 0, -500)
          await until(page, `document.querySelector('.file-change-card__summary').getBoundingClientRect().top >= document.querySelector('.workspace__topbar:not([inert])').getBoundingClientRect().bottom`)
          await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'), card = document.querySelector('.file-change-card'); root.scrollTop += card.getBoundingClientRect().top - root.getBoundingClientRect().top - 12 })()`)
          await until(page, `document.querySelector('.transcript-navigation__controls').style.marginBlockEnd === '0px'`)
          expect(await page.evaluate(`(() => { const deny = document.querySelector('.request--permission .button--danger'), before = deny.getBoundingClientRect(), scroll = document.querySelector('.workspace__scroll').getBoundingClientRect(), controls = document.querySelector('.transcript-navigation__controls'), navBefore = controls.getBoundingClientRect(); const reserve = parseFloat(getComputedStyle(document.querySelector('.workspace__main')).getPropertyValue('--yc-composer-reserve')) || 0, visibleBottom = scroll.bottom - reserve; const visibleClear = before.top >= visibleBottom || before.bottom <= navBefore.top || before.right <= navBefore.left; deny.focus(); const rect = deny.getBoundingClientRect(), nav = controls.getBoundingClientRect(); const hit = [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]].every(([x, y]) => document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y) === deny); return { visibleClear, clear: rect.bottom <= nav.top || rect.right <= nav.left, hit, focus: document.activeElement === deny, deny: rect.toJSON(), nav: nav.toJSON() } })()`)).toMatchObject({ visibleClear: true, clear: true, hit: true, focus: true })
          if (directory) await Bun.write(join(directory, `accepted-ui-scrolled-${width}-${theme}-${crypto.randomUUID()}.png`), Buffer.from(await page.screenshot(), "base64"))
        }
      } finally { await page.close() }
    }, 30_000)
  }
  test("keeps the machine state unknown while the account read is pending", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?account=pending&noSelection=1`)
      await until(page, `document.querySelector('.status-strip__body') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('.status-strip__body').textContent`)).toContain("Checking account")
      expect(await page.evaluate<number>(`document.querySelectorAll('.workspace__rail-footer').length`)).toBe(0)
    } finally { await page.close() }
  })

  test("names generic and repository-scoped creation New chat", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
      await until(page, `document.querySelector('.sessions-page__content .new-session__trigger') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('.sessions-page > .page-head .new-session__trigger').getAttribute('aria-label')`)).toBe("New chat")
      expect(await page.evaluate<string>(`document.querySelector('.sessions-page__content .new-session__trigger').getAttribute('aria-label')`)).toBe("New chat in ycoding")
      expect(await page.evaluate<string>(`document.querySelector('.sessions-page__content .new-session__trigger').title`)).toBe("New chat in ycoding")
      await page.evaluate(`document.querySelector('.sessions-page > .page-head .new-session__trigger').click()`)
      await until(page, `document.querySelector('.new-session-composer') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('.new-session-composer').getAttribute('aria-label')`)).toBe("New chat")
      await page.setViewport(844, 390)
      await page.setCoarsePointer(true)
      await until(page, `getComputedStyle(document.querySelector('.bottom-nav__new')).display !== 'none'`)
      expect(await page.evaluate<string>(`document.querySelector('.bottom-nav__new').getAttribute('aria-label')`)).toBe("New chat")
      expect(await page.evaluate<string>(`document.querySelector('.bottom-nav__new').title`)).toBe("New chat")
    } finally { await page.close() }
  })

  for (const [width, height] of [[1440, 900], [390, 400], [320, 568]]) {
    test(`pins the Session title and Back action while reading the latest output at ${width}`, async () => {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
        await until(page, `document.querySelector('.composer-resident textarea') !== null`)
        await page.evaluate(`document.querySelector('.fixture__banner')?.remove();document.querySelector('.fixture__controls')?.remove();document.querySelector('.workspace__scroll').scrollTop=1000000`)
        const layout = await page.evaluate<{ pinned: boolean; visible: boolean; reading: number; composerVisible: boolean }>(`(() => {
          const back=document.querySelector('.conversation-back'), title=document.querySelector('.workspace__topbar h1'), header=document.querySelector('.workspace__topbar'), scroll=document.querySelector('.workspace__scroll'), field=document.querySelector('.composer-resident textarea');
          const b=back.getBoundingClientRect(),t=title.getBoundingClientRect(),f=field.getBoundingClientRect();return {pinned:(header?.contains(back) && header.contains(title)) ?? false,visible:t.top>=0&&t.bottom<=innerHeight&&(innerWidth>=768 ? getComputedStyle(back).display==='none' : b.top>=0&&b.bottom<=innerHeight&&b.width>=44&&b.height>=44),reading:scroll.clientHeight,composerVisible:f.top>=0&&f.bottom<=document.querySelector('.bottom-nav').getBoundingClientRect().top||innerWidth>=768&&f.bottom<=innerHeight}
        })()`)
        expect(layout.pinned).toBe(true)
        expect(layout.visible).toBe(true)
        expect(layout.reading).toBeGreaterThanOrEqual(48)
        expect(layout.composerVisible).toBe(true)
      } finally { await page.close() }
    }, 30_000)
  }

  test("owns the approved navigation across inventory, detail, creation and preferences", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const width of [390, 768, 1440]) {
        await page.setViewport(width, 900)
        for (const view of ["chat", "sessions", "usage", "settings"]) {
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=${view}&theme=light`)
          await until(page, `document.querySelector('.remote-connection-label')?.textContent.includes('Connected') && document.querySelector('.bottom-nav') !== null`)
          const state = await page.evaluate<{ links: string[]; current: string; rail: number; headerLinks: number; overflow: boolean; undersized: number; minHeight: number }>(`(() => {
            const nav = document.querySelector(innerWidth < 768 ? '.bottom-nav' : '.workspace__rail .remote-nav')
            const links = [...(nav?.querySelectorAll('.remote-nav__link, .bottom-nav__item') ?? [])]
            return {
              links: links.map(link => new URL(link.href).pathname),
              current: nav?.querySelector('[aria-current="page"]')?.textContent.trim() ?? '',
              rail: document.querySelector('.workspace__rail')?.getBoundingClientRect().width ?? 0,
              headerLinks: document.querySelectorAll('.app-header .remote-nav a').length,
              overflow: document.documentElement.scrollWidth > innerWidth,
              minHeight: innerWidth < 768 ? 44 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-space-8')),
              undersized: links.filter(link => { const box=link.getBoundingClientRect();return box.width < 44 || box.height < (innerWidth < 768 ? 44 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-space-8'))) }).length,
            }
          })()`)
          expect(state.links).toEqual(width < 768 ? ["/remote/sessions", "/remote/usage", "/remote/settings"] : ["/remote/projects", "/remote/sessions", "/remote/workspaces", "/remote/usage", "/remote/settings"])
          expect(state.current).toBe(view === "usage" ? "Usage" : view === "settings" ? "Settings" : "Sessions")
          expect(state.rail).toBe(width < 768 ? 0 : 256)
          expect(state.headerLinks).toBe(0)
          expect(state.overflow).toBe(false)
          expect(state.minHeight).toBeGreaterThanOrEqual(32)
          expect(state.undersized).toBe(0)
        }
      }
    } finally { await page.close() }
  }, 120_000)

  test("creates only from the composer and resumes the identified Session without losing its draft", async () => {
    for (const width of [390, 1440]) {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=dark`)
        await until(page, `document.querySelector('.composer-resident textarea') !== null`)
        await page.evaluate(`(() => { const field=document.querySelector('.composer-resident textarea');field.value='Keep this Session draft';field.dispatchEvent(new InputEvent('input',{bubbles:true})); })()`)
        await page.evaluate(`document.querySelector(innerWidth < 768 ? '.bottom-nav a[href="/remote/settings"]' : '.workspace__rail .remote-nav a[href="/remote/settings"]').click()`)
        await until(page, `document.querySelector('.app--settings') !== null`)
        const resume = width < 768 ? ".app-header .workspace-resume" : ".workspace__rail .workspace-resume"
        expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(resume)})?.getAttribute('href') ?? ''`)).toBe("/remote/session?session_id=ses_fixture&device_id=dev_studio")
        await page.evaluate(`document.querySelector(${JSON.stringify(resume)}).click()`)
        await until(page, `document.querySelector('.app--selected') !== null`)
        expect(await page.evaluate<string>(`document.querySelector('.composer-resident textarea').value`)).toBe("Keep this Session draft")
        await page.evaluate(`document.querySelector('.conversation-back').click()`)
        await until(page, `document.querySelector('.app--sessions') !== null`)
        await page.evaluate(`document.querySelector('.sessions-page > .page-head .new-session__trigger').click()`)
        await until(page, `document.querySelector('.new-session-composer') !== null && !document.querySelector('.new-session-composer').closest('[inert]')`)
        expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote")
        expect(await page.evaluate<number>(`window.remoteMutationReport().filter(item => item.operation === 'session.create' || item.operation === 'session.prompt').length`)).toBe(0)
      } finally { await page.close() }
    }
  }, 60_000)

  test("collapses the shared rail on non-conversation routes without hiding navigation or workspace selection", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&workspaces=many&theme=dark`)
      await until(page, `document.querySelectorAll('.sessions-table__name').length > 0`)
      await page.evaluate(`document.querySelector('.workspace__rail button[aria-label="Hide workspace sidebar"]').click()`)
      await until(page, `document.querySelector('.app--rail-collapsed') !== null`)
      expect(await page.evaluate<{ width: number; links: number; focus: string; picker: boolean; bodyHidden: boolean }>(`(() => {
        const rail=document.querySelector('.workspace__rail');const body=rail.querySelector('.workspace__rail-body');
        return {width:rail.getBoundingClientRect().width,links:rail.querySelectorAll('.remote-nav a').length,focus:document.activeElement?.getAttribute('aria-label') ?? '',picker:document.querySelector('.sessions-page__workspace-select').getBoundingClientRect().height>0,bodyHidden:body.inert && body.getClientRects().length===0}
      })()`)).toEqual({ width: 60, links: 5, focus: "Show workspace sidebar", picker: true, bodyHidden: true })
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.workspace__rail .remote-nav a')].every(link => { const box=link.getBoundingClientRect();return box.width>=44&&box.height>=32 })`)).toBe(true)
      await page.evaluate(`document.querySelector('.workspace__rail .remote-nav a[href="/remote/settings"]').click()`)
      await until(page, `document.querySelector('.app--settings') !== null`)
      expect(await page.evaluate<boolean>(`['.workspace-resume','.workspace__new-chat'].every(selector => {const element=document.querySelector('.workspace__rail '+selector),box=element.getBoundingClientRect();return box.width>=44&&box.height>=44&&box.right<=60})`)).toBe(true)
      await page.evaluate(`document.querySelector('.workspace__rail button[aria-label="Show workspace sidebar"]').click()`)
      await until(page, `document.querySelector('.workspace__rail').getBoundingClientRect().width === 256`)
      expect(await page.evaluate<string>(`document.activeElement?.getAttribute('aria-label') ?? ''`)).toBe("Hide workspace sidebar")
    } finally { await page.close() }
  }, 30_000)
})

function requireBrowser() {
  if (!browser) throw new Error("Browser unavailable")
  return browser
}

async function until(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  await page.evaluate(`new Promise((resolve,reject) => { const deadline=performance.now()+8000;const check=()=>{ if(${expression}) {resolve(true);return;} if(performance.now()>deadline) {reject(new Error('Workspace condition did not settle'));return;} requestAnimationFrame(check); };check(); })`)
}

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then(response => response.ok, () => false)
}
