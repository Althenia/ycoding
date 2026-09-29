import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { startRelayDouble } from "../test/relay-double"
import { launchBrowser } from "./cdp"

const port = 4196
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the remote fixture server")
  browser = await launchBrowser(browserPath, 2048, 1366)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("remote shell layout", () => {
  test("offers running and recent Sessions in Activity and keeps events on that page after selection", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await browser!.openPage()
      try {
        await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.lastSessions')`)
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=activity&noSelection=1`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.activity-page__events') !== null && document.querySelector('.running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.querySelector('.activity-page__events .running-sessions__item[aria-label^="Open Stream remote output safely"]') !== null`)).toBe(true)
        expect(await page.evaluate<boolean>(`document.querySelector('.activity-page__events .empty__title')?.textContent?.trim() === 'No session selected'`)).toBe(false)
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/activity-picker-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`document.querySelector('.activity-page__events .running-sessions__item[aria-label^="Open Stream remote output safely"]')?.click()`)
        for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.activity-page__events .activity-row').length`) === 0; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ readonly path: string; readonly pending: string }>(`({ path: location.pathname, pending: document.querySelector('.activity-page__decisions h2')?.textContent?.trim() ?? '' })`)).toEqual({ path: "/remote/activity", pending: "Pending decisions" })
        expect(await page.evaluate<number>(`document.querySelectorAll('.activity-page__events .activity-row').length`)).toBeGreaterThan(0)
      } finally { await page.close() }
    }
  }, 15_000)

  test("offers running roots before recent idle roots in Activity when no Session is selected", async () => {
    const page = await browser!.openPage()
    try {
      await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.lastSessions')`)
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=session-list-1440&noSelection=1`)
      for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 4; attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.remote-nav a[href="/remote/activity"]')?.click()`)
      for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.activity-page__events .running-sessions__item').length`) !== 4; attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('.activity-page__events .running-sessions__status')].map(item => item.textContent.trim())`)).toEqual([
        "Running", "Running", expect.stringContaining("Last active"), expect.stringContaining("Last active"),
      ])
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally { await page.close() }
  }, 15_000)

  test("restores the last opened machine Session's Activity events after a full reload", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await browser!.openPage()
      try {
        await page.injectOnNewDocument(`if (!sessionStorage.getItem('activity-restore-started')) { localStorage.removeItem('ycoding.remote.lastSessions'); sessionStorage.setItem('activity-restore-started', '1') }`)
        await page.setViewport(width, height)
        const address = `http://127.0.0.1:${port}/verify/remote.html?view=activity&noSelection=1`
        await page.navigate(address)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.activity-page__events .running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('.activity-page__events .running-sessions__item[aria-label^="Open Stream remote output safely"]')?.click()`)
        for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.activity-page__events .activity-row').length`) === 0; attempt += 1) await Bun.sleep(50)
        const before = await page.evaluate<string>(`document.querySelector('.activity-page__events .activity-row')?.textContent?.trim() ?? ''`)
        expect(before.length).toBeGreaterThan(0)
        const saved = await page.evaluate<string | null>(`localStorage.getItem('ycoding.remote.lastSessions')`)
        expect(JSON.parse(saved ?? "{}")).toMatchObject({ dev_studio: "ses_fixture" })
        await page.navigate(address)
        for (let attempt = 0; attempt < 80 && await page.evaluate<string>(`document.querySelector('.activity-page__events .activity-row')?.textContent?.trim() ?? ''`) !== before; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('.activity-page__events .activity-row')?.textContent?.trim() ?? ''`)).toBe(before)
      } finally { await page.close() }
    }
  }, 25_000)

  test("does not restore the previous machine's Activity on a device switch", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await browser!.openPage()
      try {
        await page.injectOnNewDocument(`localStorage.setItem('ycoding.remote.lastSessions', JSON.stringify({ dev_laptop: 'ses_fixture' }))`)
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=activity&noSelection=1`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.activity-page__events .running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('.activity-page__events .running-sessions__item[aria-label^="Open Stream remote output safely"]')?.click()`)
        for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.activity-page__events .activity-row').length`) === 0; attempt += 1) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('.remote-nav a[href="/remote/settings"]')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.click()`)
        await page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes('Laptop'))?.click()`)
        if (width === 390) await page.evaluate(`document.querySelector('.custom-select__confirm')?.click()`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.includes('Laptop') === true`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Laptop")
        expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.remote.lastSessions') ?? '{}')`)).toEqual({})
        await page.evaluate(`document.querySelector('.remote-nav a[href="/remote/activity"]')?.click()`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.activity-page__events .running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ readonly events: number; readonly picker: boolean; readonly path: string }>(`({ events: document.querySelectorAll('.activity-page__events .activity-row').length, picker: document.querySelector('.activity-page__events .running-sessions__item') !== null, path: location.pathname })`)).toEqual({ events: 0, picker: true, path: "/remote/activity" })
      } finally { await page.close() }
    }
  }, 25_000)

  test("does not auto-restore on returning to a machine after switching away", async () => {
    const page = await browser!.openPage()
    try {
      await page.injectOnNewDocument(`localStorage.setItem('ycoding.remote.lastSessions', JSON.stringify({ dev_studio: 'ses_fixture', dev_laptop: 'ses_fixture' }))`)
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&noSelection=1`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.includes('Studio Mac') === true`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.click()`)
      await page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes('Laptop'))?.click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.includes('Laptop') === true`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Laptop")
      await page.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.click()`)
      await page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes('Studio Mac'))?.click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.includes('Studio Mac') === true`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.remote.lastSessions') ?? '{}')`)).toEqual({})
      await page.evaluate(`document.querySelector('.remote-nav a[href="/remote/activity"]')?.click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.activity-page__events .running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<{ readonly events: number; readonly picker: boolean }>(`({ events: document.querySelectorAll('.activity-page__events .activity-row').length, picker: document.querySelector('.activity-page__events .running-sessions__item') !== null })`)).toEqual({ events: 0, picker: true })
    } finally { await page.close() }
  }, 20_000)

  test("scrolls Settings from the window edge while its content stays one centered column", async () => {
    for (const [width, height] of [[1440, 900], [1920, 1080]] as const) {
      const page = await fixture("view=settings&noSelection=1", width, "Desktop alerts", undefined, height)
      try {
        await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture = document.querySelector('.fixture'); fixture.style.height = '100dvh'; fixture.style.minHeight = '0'; fixture.style.overflow = 'hidden'; })()`)
        const layout = await page.evaluate<{ scrollable: boolean; left: number; right: number; viewport: number; edgeScrolls: boolean; column: number; columnCenter: number; contentCenter: number }>(`(() => {
          const scroller = document.querySelector('.app--settings .workspace__scroll')
          const box = scroller.getBoundingClientRect()
          const pane = document.querySelector('.app--settings .pane').getBoundingClientRect()
          const edge = document.elementFromPoint(innerWidth - 24, box.top + box.height / 2)
          return { scrollable: scroller.scrollHeight > scroller.clientHeight, left: box.left, right: box.right, viewport: innerWidth, edgeScrolls: scroller.contains(edge), column: pane.width, columnCenter: pane.left + pane.width / 2, contentCenter: box.left + scroller.clientLeft + scroller.clientWidth / 2 }
        })()`)
        expect(layout.scrollable).toBe(true)
        expect(Math.abs(layout.right - layout.viewport)).toBeLessThanOrEqual(1)
        expect(layout.edgeScrolls).toBe(true)
        expect(layout.column).toBeLessThanOrEqual(960)
        expect(Math.abs(layout.columnCenter - layout.contentCenter)).toBeLessThanOrEqual(1)
      } finally { await page.close() }
    }
  }, 30_000)

  test("removes the phone and desktop running dots and timer after a missed terminal reconnect", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await fixture("view=chat", width, "Stream remote output safely", undefined, height)
      try {
        const statusReads = await page.evaluate<number>(`window.remoteOperationReport().operations['session.status'] ?? 0`)
        await page.evaluate(`window.remoteMissTerminal()`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.session-status__slot .transcript-dot-trail') !== null && /^[0-9]+:[0-9]{2}$/.test(document.querySelector('.session-status__mobile')?.textContent?.trim() ?? '')`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.querySelector('.session-status__slot .transcript-dot-trail') !== null && /^[0-9]+:[0-9]{2}$/.test(document.querySelector('.session-status__mobile')?.textContent?.trim() ?? '')`)).toBe(true)
        await page.evaluate(`document.querySelector('.fixture__controls button:nth-child(2)')?.click()`)
        for (let attempt = 0; attempt < 100 && !await page.evaluate<boolean>(`document.querySelector('.session-status__slot')?.classList.contains('session-status__slot--empty') === true && (window.remoteOperationReport().operations['session.status'] ?? 0) > ${statusReads} && document.querySelector('.status-strip__body')?.textContent?.includes('Connected') === true`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ readonly empty: boolean; readonly dots: boolean; readonly label: string; readonly timer: string }>(`({ empty: document.querySelector('.session-status__slot')?.classList.contains('session-status__slot--empty') === true, dots: document.querySelector('.session-status__slot .transcript-dot-trail') !== null, label: document.querySelector('.session-status__label')?.textContent?.trim() ?? '', timer: document.querySelector('.session-status__mobile')?.textContent?.trim() ?? '' })`)).toEqual({ empty: true, dots: false, label: "", timer: "" })
      } finally { await page.close() }
    }
  }, 20_000)

  test("clears the saved Session when its machine no longer serves it", async () => {
    const page = await browser!.openPage()
    try {
      await page.injectOnNewDocument(`localStorage.setItem('ycoding.remote.lastSessions', JSON.stringify({ dev_studio: 'ses_fixture' }))`)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=activity&noSelection=1&removedSession=ses_fixture`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.status-strip__body')?.textContent?.includes('Connected') === true && document.querySelector('.activity-page__events') !== null`); attempt += 1) await Bun.sleep(50)
      for (let attempt = 0; attempt < 80 && await page.evaluate<boolean>(`JSON.parse(localStorage.getItem('ycoding.remote.lastSessions') ?? '{}').dev_studio !== undefined`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.remote.lastSessions') ?? '{}')`)).toEqual({})
      expect(await page.evaluate<{ readonly events: number; readonly explanation: boolean }>(`({ events: document.querySelectorAll('.activity-page__events .activity-row').length, explanation: document.querySelector('.activity-page__events')?.textContent?.includes('No running or recent Sessions') === true })`)).toEqual({ events: 0, explanation: true })
    } finally { await page.close() }
  }, 15_000)

  test("clears the browser's remembered machine Sessions on sign-out", async () => {
    const page = await browser!.openPage()
    try {
      await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.lastSessions')`)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=activity&noSelection=1`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.activity-page__events .running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.activity-page__events .running-sessions__item[aria-label^="Open Stream remote output safely"]')?.click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`JSON.parse(localStorage.getItem('ycoding.remote.lastSessions') ?? '{}').dev_studio === 'ses_fixture'`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.remote-nav a[href="/remote/settings"]')?.click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="account-settings"] button')?.textContent?.includes('Sign out') === true`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('[aria-labelledby="account-settings"] button')].some(button => button.textContent?.includes('Sign out'))`)).toBe(true)
      await page.evaluate(`[...document.querySelectorAll('[aria-labelledby="account-settings"] button')].find(button => button.textContent?.includes('Sign out'))?.click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('main.sign-in') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelector('main.sign-in') !== null`)).toBe(true)
      expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.remote.lastSessions') ?? '{}')`)).toEqual({})
    } finally { await page.close() }
  }, 15_000)

  test("records goal inputs and keeps the selected YOLO level through goal set and stop", async () => {
    const page = await fixture("view=chat", 1440, "Stream remote output safely")
    try {
      await page.evaluate(`document.querySelector('.workspace__main .session-status__yolo-trigger')?.click()`)
      await page.evaluate(`[...document.querySelectorAll('.session-status__yolo-popover [role="radio"]')].find(button => button.textContent?.includes('YOLO 3'))?.click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.session-status__yolo-trigger')?.textContent?.includes('YOLO 3') === true`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.workspace__main .session-status__goal-trigger')?.click()`)
      await page.evaluate(`(() => { const input = document.querySelector('.session-status__goal-popover input[aria-label="Goal"]'); input.value = 'Ship a reliable Session'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.closest('form')?.requestSubmit(); })()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`window.remoteMutationReport().some(item => item.operation === 'session.goal.set')`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<unknown>(`window.remoteMutationReport().find(item => item.operation === 'session.goal.set')`)).toEqual({ operation: "session.goal.set", input: { goal: "Ship a reliable Session" } })
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.session-status__goal-count')?.textContent === '0'`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<{ readonly goal: string; readonly yolo: string }>(`({ goal: document.querySelector('.session-status__goal-count')?.textContent ?? '', yolo: document.querySelector('.session-status__yolo-full')?.textContent ?? '' })`)).toEqual({ goal: "0", yolo: "YOLO 3" })
      await page.evaluate(`document.querySelector('.workspace__main .session-status__goal-trigger')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('.session-status__goal-popover')?.textContent ?? ''`)).toContain("Ship a reliable Session")
      await page.evaluate(`document.querySelector('.session-status__goal-popover button')?.click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`window.remoteMutationReport().some(item => item.operation === 'session.goal.stop')`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<unknown>(`window.remoteMutationReport().find(item => item.operation === 'session.goal.stop')`)).toEqual({ operation: "session.goal.stop", input: { goal: null } })
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.session-status__goal-trigger')?.getAttribute('aria-label') === 'Goal off'`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<{ readonly goal: string | null; readonly count: boolean; readonly yolo: string }>(`({ goal: document.querySelector('.session-status__goal-trigger')?.getAttribute('aria-label') ?? null, count: document.querySelector('.session-status__goal-count') !== null, yolo: document.querySelector('.session-status__yolo-full')?.textContent ?? '' })`)).toEqual({ goal: "Goal off", count: false, yolo: "YOLO 3" })
      expect(await page.evaluate<number>(labelAsymmetry(".workspace__main .session-status__goal-trigger"))).toBeLessThanOrEqual(1)
    } finally { await page.close() }
  }, 15_000)

  test("anchors the autonomy and Goal panels to their pills in the resident composer", async () => {
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]] as const) for (const kind of ["yolo", "goal"] as const) {
      const page = await fixture("view=chat", width, "Stream remote output safely", undefined, height)
      try {
        const trigger = `.workspace__main .session-status__${kind}-trigger`
        await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture = document.querySelector('.fixture'); fixture.style.height = '100dvh'; fixture.style.minHeight = '0'; fixture.style.overflow = 'hidden'; })()`)
        if (kind === "goal") expect(await page.evaluate<number>(labelAsymmetry(trigger))).toBeLessThanOrEqual(1)
        await page.evaluate(`document.querySelector('${trigger}')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.session-status__popover') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`Promise.all([...document.querySelector('.session-status__popover').getAnimations()].map(animation => animation.finished))`)
        const placement = await page.evaluate<{ readonly gap: number; readonly overlap: boolean; readonly inside: boolean }>(`(() => { const pill = document.querySelector('${trigger}').getBoundingClientRect(), panel = document.querySelector('.session-status__popover').getBoundingClientRect(); return { gap: Math.max(pill.top - panel.bottom, panel.top - pill.bottom), overlap: panel.left < pill.right && panel.right > pill.left, inside: panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight, pill: [pill.left, pill.top, pill.right, pill.bottom].map(Math.round), panel: [panel.left, panel.top, panel.right, panel.bottom].map(Math.round), viewport: [innerWidth, innerHeight] } })()`)
        expect({ width, kind, ...placement }).toMatchObject({ width, kind, overlap: true, inside: true })
        expect(placement.gap).toBeGreaterThanOrEqual(4)
        expect(placement.gap).toBeLessThanOrEqual(16)
      } finally { await page.close() }
    }
  }, 30_000)

  test("shows one screen loading placeholder only while the first account and connection read is pending", async () => {
    for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]] as const) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&accountDelay=3500`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.workspace__main .loading-placeholder--screen') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ readonly screen: number; readonly announced: number; readonly duplicate: number }>(`(() => ({
          screen: document.querySelectorAll('.workspace__main .loading-placeholder--screen').length,
          announced: document.querySelectorAll('.workspace__main .loading-placeholder--screen[role="status"]').length,
          duplicate: document.querySelectorAll('.app-header .loading-placeholder--screen,.workspace__rail .loading-placeholder--screen').length,
        }))()`)).toEqual({ screen: 1, announced: 1, duplicate: 0 })
        expect(await page.evaluate<boolean>(`document.querySelector('.loading-placeholder--screen')?.getBoundingClientRect().height >= 240 && document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
        for (let attempt = 0; attempt < 20 && await page.evaluate<number>(`Number(getComputedStyle(document.querySelector('.loading-placeholder--screen .loading-placeholder__shape')).opacity)`) < 0.9; attempt += 1) await Bun.sleep(25)
        await Bun.write(new URL(`../../../.cache/tmp/shell-loading-screen-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        for (let attempt = 0; attempt < 80 && await page.evaluate<boolean>(`document.querySelector('.workspace__main .loading-placeholder--screen') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__main .loading-placeholder--screen') === null && document.querySelector('.new-session-composer') !== null`)).toBe(true)
      } finally { await page.close() }
    }
  }, 20_000)

  test("holds one announced Session skeleton group in the page and rail until the first list settles", async () => {
    for (const [width, height, view, selector] of [[1440, 900, "sessions", ".sessions-results .sessions-table"], [1440, 900, "chat", ".workspace__rail .session-list"], [390, 844, "sessions", ".sessions-results .sessions-table"]] as const) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=${view}&inventoryCount=80&sessionListDelay=8000`)
        for (let attempt = 0; attempt < 100 && !await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector + ' .loading-placeholder--session')}) !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ readonly count: number; readonly announcements: number; readonly busy: boolean; readonly table: boolean }>(`(() => { const root = document.querySelector(${JSON.stringify(selector)}); return {
          count: root?.querySelectorAll('.loading-placeholder--session').length ?? 0,
          announcements: root?.querySelectorAll('.loading-placeholder--session[role="status"]').length ?? 0,
          busy: root?.getAttribute('aria-busy') === 'true' || root?.closest('[aria-busy="true"]') !== null,
          table: root?.getAttribute('role') === 'table',
        } })()`)).toEqual({ count: 3, announcements: 1, busy: true, table: false })
        expect(await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector + ' .loading-placeholder--session')})?.getBoundingClientRect().height >= 64 && document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
        for (let attempt = 0; attempt < 20 && await page.evaluate<number>(`Number(getComputedStyle(document.querySelector(${JSON.stringify(selector + ' .loading-placeholder__shape')})).opacity)`) < 0.9; attempt += 1) await Bun.sleep(25)
        await Bun.write(new URL(`../../../.cache/tmp/shell-loading-${view}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        const settled = `document.querySelector(${JSON.stringify(selector + ' .loading-placeholder--session')}) === null && document.querySelectorAll(${JSON.stringify(view === 'sessions' ? '.sessions-table__row' : '.workspace__rail .session-row')}).length > 0`
        for (let attempt = 0; attempt < 300 && !await page.evaluate<boolean>(settled); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(settled)).toBe(true)
      } finally { await page.close() }
    }
  }, 60_000)

  test("keeps resident Session rows during a same-machine inventory refresh", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=80&sessionListDelay=1800`)
        for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`) < 25; attempt += 1) await Bun.sleep(50)
        const before = await page.evaluate<{ readonly rows: number; readonly title: string; readonly requests: number }>(`({ rows: document.querySelectorAll('.sessions-table__row').length, title: document.querySelector('.sessions-table__row')?.textContent?.trim() ?? '', requests: window.remoteInventoryReport().workspaceRequests })`)
        expect(before.rows).toBeGreaterThanOrEqual(25)
        await page.evaluate(`window.remoteInvalidateSessions()`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`window.remoteInventoryReport().listStatus === 'loading' && window.remoteInventoryReport().workspaceRequests > ${before.requests}`); attempt += 1) await Bun.sleep(25)
        expect(await page.evaluate<{ readonly rows: number; readonly title: string; readonly loading: boolean; readonly placeholder: boolean; readonly fits: boolean }>(`({ rows: document.querySelectorAll('.sessions-table__row').length, title: document.querySelector('.sessions-table__row')?.textContent?.trim() ?? '', loading: window.remoteInventoryReport().listStatus === 'loading', placeholder: document.querySelector('.sessions-results .loading-placeholder') !== null, fits: document.documentElement.scrollWidth <= innerWidth })`)).toEqual({ rows: before.rows, title: before.title, loading: true, placeholder: false, fits: true })
      } finally { await page.close() }
    }
  }, 15_000)

  test("keeps existing Session rows while a next-page skeleton is loading", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=80&sessionListDelay=3500`)
      for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`) < 25; attempt += 1) await Bun.sleep(50)
      const existing = await page.evaluate<number>(`document.querySelectorAll('.sessions-table__row').length`)
      await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.tabIndex = 0; root.focus(); })()`)
      await page.pressKey("End", "End", 35)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.sessions-page__content .loading-placeholder--session') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<{ readonly rows: number; readonly placeholders: number; readonly label: string }>(`(() => ({
        rows: document.querySelectorAll('.sessions-table__row').length,
        placeholders: document.querySelectorAll('.sessions-page__content .loading-placeholder--session[role="status"]').length,
        label: document.querySelector('.sessions-page__content .loading-placeholder--session')?.textContent?.trim() ?? '',
      }))()`)).toEqual({ rows: existing, placeholders: 1, label: "Loading more sessions…" })
      await Bun.write(new URL(`../../../.cache/tmp/shell-loading-next-page-1440x900.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      for (let attempt = 0; attempt < 80 && await page.evaluate<boolean>(`document.querySelector('.sessions-page__content .loading-placeholder--session') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelectorAll('.sessions-table__row').length > ${existing} && document.querySelector('.sessions-page__content .loading-placeholder--session') === null`)).toBe(true)
    } finally { await page.close() }
  }, 15_000)

  test("places running Sessions before the workspace heading on the Sessions page", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`Boolean(document.querySelector('.running-sessions') && document.querySelector('.sessions-page__title'))`); attempt += 1) await Bun.sleep(50)
      const positions = await page.evaluate<{ readonly running: number; readonly heading: number; readonly toolbar: number }>(`(() => ({ running: document.querySelector('.running-sessions')?.getBoundingClientRect().top ?? Infinity, heading: document.querySelector('.sessions-page__title')?.getBoundingClientRect().top ?? -1, toolbar: document.querySelector('.sessions-page__toolbar')?.getBoundingClientRect().top ?? -1 }))()`)
      expect(positions.running).toBeLessThan(positions.heading)
      expect(positions.running).toBeLessThan(positions.toolbar)
    } finally { await page.close() }
  }, 30_000)

  test("shows the loaded Session count beside the workspace title and gives search the full width", async () => {
    for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]] as const) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`Boolean(document.querySelector('.sessions-page__title') && document.querySelector('.sessions-page__content input[type="search"]'))`); attempt += 1) await Bun.sleep(50)
        const layout = await page.evaluate<{ readonly count: string; readonly beside: boolean; readonly search: number; readonly content: number; readonly overflow: boolean }>(`(() => { const title = document.querySelector('.sessions-page__title').getBoundingClientRect(), chip = document.querySelector('.sessions-page__toolbar .sessions-page__count'), count = chip?.getBoundingClientRect(); return { count: chip?.textContent?.trim() ?? '', beside: count !== undefined && count.left >= title.right && count.top < title.bottom && count.bottom > title.top, search: document.querySelector('.sessions-page__content input[type="search"]').getBoundingClientRect().width, content: document.querySelector('.sessions-page__content').getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > innerWidth } })()`)
        expect(layout.count).toMatch(/^\d+ sessions? loaded$/)
        expect(layout.beside).toBe(true)
        expect(layout.content - layout.search).toBeLessThanOrEqual(1)
        expect(layout.overflow).toBe(false)
      } finally { await page.close() }
    }
  }, 30_000)

  test("keeps the no-selection Sessions overlay full width and the main empty content centered", async () => {
    for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [820, 1180]]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&theme=${theme}`)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.app--empty .app-header__menu') !== null && document.querySelector('.new-session-composer') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('.app-header__menu').click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.overlay--sessions-sheet[open] .session-row') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`Promise.all([...document.querySelector('.overlay--sessions-sheet .overlay__surface').getAnimations()].map(animation => animation.finished))`)
        const geometry = await page.evaluate<{ readonly labelLeft: number; readonly buttonRight: number; readonly headerTop: number; readonly buttonTop: number; readonly innerLeft: number; readonly innerRight: number; readonly workspaceLeft: number; readonly headingLeft: number; readonly selectorAbsent: boolean; readonly filterLeft: number; readonly filterRight: number; readonly rowTextLeft: number; readonly bodyOverflow: boolean; readonly listOverflow: boolean; readonly centered: boolean; readonly pageOverflow: boolean }>(`(() => { const overlay = document.querySelector('.overlay--sessions-sheet'); const pane = overlay.querySelector('.pane'); const content = pane.getBoundingClientRect(); const pad = parseFloat(getComputedStyle(pane).paddingLeft); const label = pane.querySelector('.pane__title').getBoundingClientRect(); const button = pane.querySelector('.pane__head button').getBoundingClientRect(); const workspace = pane.querySelector('.session-panel__workspace .workspace-select__label').getBoundingClientRect(); const heading = pane.querySelector('.session-panel__workspace h3').getBoundingClientRect(); const filter = pane.querySelector('input[placeholder="Filter sessions"]').getBoundingClientRect(); const list = pane.querySelector('.session-list'); const row = pane.querySelector('.session-row__title').getBoundingClientRect(); const body = overlay.querySelector('.overlay__body'); const main = document.querySelector('.workspace__main').getBoundingClientRect(); const empty = document.querySelector('.new-session-composer').getBoundingClientRect(); return { labelLeft: label.left, buttonRight: button.right, headerTop: label.top, buttonTop: button.top, innerLeft: content.left + pad, innerRight: content.right - pad, workspaceLeft: workspace.left, headingLeft: heading.left, selectorAbsent: !pane.querySelector('.workspace-select .custom-select__trigger'), filterLeft: filter.left, filterRight: filter.right, rowTextLeft: row.left, bodyOverflow: body.scrollWidth > body.clientWidth + 1, listOverflow: list.scrollWidth > list.clientWidth + 1, centered: Math.abs((empty.left + empty.right - main.left - main.right)/2) <= 1, pageOverflow: document.documentElement.scrollWidth > innerWidth } })()`)
        expect(Math.abs(geometry.labelLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.buttonRight - geometry.innerRight)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.headerTop - geometry.buttonTop)).toBeLessThanOrEqual(14)
        expect(Math.abs(geometry.workspaceLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.headingLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(geometry.selectorAbsent).toBe(true)
        expect(Math.abs(geometry.filterLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.filterRight - geometry.innerRight)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.rowTextLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(geometry.bodyOverflow).toBe(false)
        expect(geometry.listOverflow).toBe(false)
        expect(geometry.centered).toBe(true)
        expect(geometry.pageOverflow).toBe(false)
        await Bun.write(new URL(`../../../.cache/tmp/sessions-no-selection-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }, 30_000)

  test("shows Office only above phone sizes and keeps the selected Session and draft through rotation", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=office&theme=light`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.app--selected') !== null`); attempt += 1) await Bun.sleep(50)
      const layouts = [[390, 844, false, false], [1366, 650, false, true], [820, 1180, false, true], [1180, 820, false, true], [1440, 900, false, true], [1133, 744, true, true], [844, 390, true, false]] as const
      for (const [width, height, coarse, office] of layouts) {
        if (coarse) await page.setCoarsePointer(true)
        expect(await page.evaluate<boolean>(`matchMedia('(pointer: coarse)').matches`)).toBe(coarse)
        await page.setViewport(width, height)
        for (let attempt = 0; attempt < 40 && await page.evaluate<boolean>(`document.querySelector('.office-workspace') !== null`) !== office; attempt += 1) await Bun.sleep(50)
        const state = await page.evaluate<{ readonly switchVisible: boolean; readonly officeVisible: boolean; readonly conversationVisible: boolean; readonly session: string }>(`(() => { const visible=(selector) => { const element=document.querySelector(selector), panel=element?.closest('.route-panel'); return Boolean(element?.getBoundingClientRect().width && panel && getComputedStyle(panel).contentVisibility !== 'hidden') }; return { switchVisible: Boolean(document.querySelector('.presentation-switch')?.getBoundingClientRect().width), officeVisible: visible('.office-workspace'), conversationVisible: visible('.conversation-pane'), session: document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? '' } })()`)
        expect(state.switchVisible).toBe(office)
        expect(state.officeVisible).toBe(office)
        expect(state.conversationVisible).toBe(!office)
        if (!office) expect(state.session).toBe("Stream remote output safely")
        else expect(await page.evaluate<boolean>(`document.querySelector('.app--selected') !== null`)).toBe(true)
      }
      await page.setViewport(390, 844)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.composer__input') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`(() => { const input = document.querySelector('.composer__input'); input.value = 'Keep my rotation draft'; input.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("Keep my rotation draft")
      await page.setViewport(820, 1180)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.office-workspace') !== null`); attempt += 1) await Bun.sleep(50)
      await page.setViewport(390, 844)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.conversation-pane') !== null && document.querySelector('.composer__input') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("Keep my rotation draft")
      expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? ''`)).toBe("Stream remote output safely")
      const settings = await browser!.openPage()
      try {
        for (const [width, height, coarse, visible] of layouts) {
          if (coarse) await settings.setCoarsePointer(true)
          expect(await settings.evaluate<boolean>(`matchMedia('(pointer: coarse)').matches`)).toBe(coarse)
          await settings.setViewport(width, height)
          await settings.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&presentation=office`)
          for (let attempt = 0; attempt < 40 && !await settings.evaluate<boolean>(`document.querySelector('.settings__section[aria-labelledby="notification-settings"]') !== null`); attempt += 1) await Bun.sleep(50)
          expect(await settings.evaluate<boolean>(`document.querySelector('.settings__section[aria-labelledby="office-settings"]') !== null`)).toBe(visible)
        }
      } finally { await settings.close() }
    } finally { await page.close() }
  }, 45_000)

  test("follows another workspace's running Session from the carousel in desktop rail and phone sheet", async () => {
    for (const width of [1440, 390]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=session-list-${width === 390 ? 390 : 1440}`)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`window.remoteStatus && document.querySelector('.sessions-page__title')`); attempt += 1) await Bun.sleep(50)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`window.remoteStatus(['ses_fixture', 'ses_telemetry'], [])`)
        for (let attempt = 0; attempt < 160 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 4; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`)).toBe(4)
        await page.evaluate(`[...document.querySelectorAll('.running-sessions__item')].find(button => button.textContent.includes('Telemetry Event'))?.click()`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.app--conversation.app--selected') !== null`); attempt += 1) await Bun.sleep(50)
        if (width === 390) {
          await page.evaluate(`document.querySelector('.app-header__menu').click()`)
          for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.overlay--sessions-sheet[open] .session-panel__workspace') !== null`); attempt += 1) await Bun.sleep(50)
        }
        const result = await page.evaluate<{ readonly heading: string; readonly selector: boolean; readonly rows: readonly string[]; readonly active: string; readonly firstRunning: boolean }>(`(() => { const panel = document.querySelector(${width === 390 ? "'.overlay--sessions-sheet .pane'" : "'.workspace__rail .pane'"}); const rows = [...panel.querySelectorAll('.session-row')]; return { heading: panel.querySelector('.session-panel__workspace h3')?.textContent.trim() ?? '', selector: Boolean(panel.querySelector('.workspace-select .custom-select__trigger')), rows: rows.map(row => row.querySelector('.session-row__name')?.textContent.trim() ?? ''), active: panel.querySelector('.session-row--active .session-row__name')?.textContent.trim() ?? '', firstRunning: Boolean(rows[0]?.querySelector('.live-dot')) } })()`)
        expect(result.heading).toBe("telemetry-daemon")
        expect(result.selector).toBe(false)
        expect(result.rows).toContain("Telemetry Event Buffer Flush Daemon")
        expect(result.active).toBe("Telemetry Event Buffer Flush Daemon")
        expect(result.firstRunning).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("pins the combined presentation and Team bar above scrolling Conversation and Office content", async () => {
    for (const [width, height] of [[1440, 900], [820, 1180]] as const) {
      const page = await fixture("view=chat&team=two", width, "Team", undefined, height)
      try {
        await page.evaluate(`(() => {
          document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove();
          const fixture = document.querySelector('.fixture'); fixture.style.height = '100dvh'; fixture.style.minHeight = '0'; fixture.style.overflow = 'hidden';
        })()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb') !== null && document.querySelector('.transcript-message') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`(() => { const scroll = document.querySelector('.workspace__scroll'); scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); scroll.scrollTop = 0; })()`)
        const layout = () => page.evaluate<{ readonly combined: boolean; readonly top: number; readonly bottom: number; readonly scrollTop: number; readonly scrollBoxTop: number; readonly firstRowTop: number }>(`(() => {
          const bar = document.querySelector('.workspace__topbar'); const scroll = document.querySelector('.workspace__scroll');
          return { combined: bar?.parentElement === document.querySelector('.workspace__main') && Boolean(bar?.querySelector('.presentation-switch') && bar?.querySelector('[aria-label="Open Team"]')),
            top: bar?.getBoundingClientRect().top ?? -1, bottom: bar?.getBoundingClientRect().bottom ?? -1,
            scrollTop: scroll.scrollTop, scrollBoxTop: scroll.getBoundingClientRect().top,
            firstRowTop: document.querySelector('.conversation-breadcrumb')?.getBoundingClientRect().top ?? -1 };
        })()`)
        const initial = await layout()
        expect(initial.combined).toBe(true)
        expect(initial.bottom).toBeLessThanOrEqual(initial.scrollBoxTop + 1)
        expect(initial.firstRowTop).toBeGreaterThanOrEqual(initial.scrollBoxTop)
        const transcriptRow = await page.evaluate<{ readonly scrollTop: number; readonly top: number }>(`(() => { const scroll = document.querySelector('.workspace__scroll'); const row = document.querySelector('.transcript-message'); scroll.scrollTop = Math.max(1, row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 4); return { scrollTop: scroll.scrollTop, top: row.getBoundingClientRect().top }; })()`)
        expect(transcriptRow.scrollTop).toBeGreaterThan(0)
        expect(transcriptRow.top).toBeGreaterThanOrEqual(initial.bottom)
        await Bun.write(new URL(`../../../.cache/tmp/pinned-bar-conversation-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`(() => { document.querySelector('.conversation-pane').style.minHeight = '1900px'; const scroll = document.querySelector('.workspace__scroll'); scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); scroll.scrollTop = scroll.scrollHeight; })()`)
        const conversation = await layout()
        expect(conversation.scrollTop).toBeGreaterThan(200)
        expect(Math.abs(conversation.top - initial.top)).toBeLessThanOrEqual(1)
        const jump = width >= 1024 ? '.transcript-navigation__desktop-controls [aria-label="Jump to top"]' : '.transcript-navigation__mobile-controls [aria-label="Jump to top"]'
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(jump)}) !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(jump)}) !== null`)).toBe(true)
        await page.evaluate(`document.querySelector(${JSON.stringify(jump)})?.click()`)
        for (let attempt = 0; attempt < 80 && (await layout()).scrollTop > 8; attempt += 1) await Bun.sleep(20)
        expect((await layout()).scrollTop).toBeLessThanOrEqual(8)
        await page.evaluate(`document.querySelector('.presentation-switch [role="radio"]:last-child')?.click()`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.office-workspace canvas') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.querySelector('.office-workspace canvas') !== null`)).toBe(true)
        await page.evaluate(`document.querySelector('.office-workspace').style.minHeight = '1900px'`)
        const officeRow = await page.evaluate<{ readonly scrollTop: number; readonly top: number }>(`(() => { const scroll = document.querySelector('.workspace__scroll'); const row = document.querySelector('.office-workspace__canvas'); scroll.scrollTop = Math.max(1, row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 4); return { scrollTop: scroll.scrollTop, top: row.getBoundingClientRect().top }; })()`)
        expect(officeRow.scrollTop).toBeGreaterThan(0)
        expect(officeRow.top).toBeGreaterThanOrEqual(initial.bottom)
        await page.evaluate(`(() => { const scroll = document.querySelector('.workspace__scroll'); scroll.scrollTop = scroll.scrollHeight; })()`)
        const office = await layout()
        expect(office.scrollTop).toBeGreaterThan(200)
        expect(Math.abs(office.top - initial.top)).toBeLessThanOrEqual(1)
        expect(office.combined).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/pinned-bar-office-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`document.querySelector('.presentation-switch [role="radio"]:last-child')?.focus()`)
        await page.pressKey("Home", "Home", 36)
        expect(await page.evaluate<boolean>(`document.querySelector('.presentation-switch [role="radio"]:first-child')?.getAttribute('aria-checked') === 'true' && document.querySelector('.conversation-pane') !== null`)).toBe(true)
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.presentation-switch [role="radio"]:first-child') && getComputedStyle(document.activeElement).outlineStyle !== 'none'`)).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("collapses the selected Session rail to a narrow expand rail and restores it there across desktop and tablet sizes", async () => {
    for (const [width, height] of [[1024, 768], [1180, 820], [1280, 800], [1440, 900], [1920, 1080], [820, 1180]] as const) for (const theme of ["light", "dark"] as const) {
      const page = await browser!.openPage()
      try {
        await page.injectOnNewDocument(`if (!sessionStorage.getItem('rail-test-started')) { localStorage.removeItem('ycoding.remote.desktopRailCollapsed'); sessionStorage.setItem('rail-test-started','1') }`)
        await page.setViewport(width, height)
        const address = `http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}`
        await page.navigate(address)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .pane__head--sessions') !== null && document.querySelector('.conversation-breadcrumb') !== null`); attempt += 1) await Bun.sleep(50)
        const geometry = () => page.evaluate<{ rail: number; main: number; overflow: boolean; transition: string }>(`(() => { const rail=document.querySelector('.workspace__rail'), main=document.querySelector('.workspace__main'), workspace=document.querySelector('.workspace'); return { rail:rail.getBoundingClientRect().width, main:main.getBoundingClientRect().width, overflow:document.documentElement.scrollWidth>innerWidth, transition:getComputedStyle(workspace).transitionDuration } })()`)
        const initial = await geometry()
        expect(initial.rail).toBeGreaterThan(200)
        expect(initial.overflow).toBe(false)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail button[aria-label="Hide sessions sidebar"]')?.getBoundingClientRect().width >= 44`)).toBe(true)
        expect(await page.evaluate<boolean>(`document.querySelector('.app-header__rail-toggle') === null`)).toBe(true)
        expect(initial.transition).not.toBe("0s")
        const settle = () => page.evaluate(`Promise.all(document.querySelector('.workspace').getAnimations().map(animation => animation.finished))`)
        await page.evaluate(`document.querySelector('.workspace__rail button[aria-label="Hide sessions sidebar"]')?.click()`)
        await settle()
        const collapsed = await geometry()
        expect(collapsed.rail).toBeGreaterThanOrEqual(44)
        expect(collapsed.rail).toBeLessThanOrEqual(72)
        expect(collapsed.main).toBeGreaterThanOrEqual(initial.main + initial.rail - collapsed.rail - 2)
        expect(collapsed.overflow).toBe(false)
        const narrowRail = () => page.evaluate<{ readonly panelHidden: boolean; readonly railInteractive: boolean; readonly expandInside: boolean; readonly focused: boolean }>(`(() => { const rail = document.querySelector('.workspace__rail'), box = rail.getBoundingClientRect(), expand = rail.querySelector('button[aria-label="Show sessions sidebar"][aria-expanded="false"]'), button = expand?.getBoundingClientRect(); return { panelHidden: rail.querySelector('.pane')?.getClientRects().length === 0, railInteractive: !rail.inert && rail.getAttribute('aria-hidden') !== 'true', expandInside: button !== undefined && button.width >= 44 && button.height >= 44 && button.left >= box.left && button.right <= box.right && button.top >= box.top, focused: document.activeElement === expand } })()`)
        expect(await narrowRail()).toEqual({ panelHidden: true, railInteractive: true, expandInside: true, focused: true })
        await Bun.write(new URL(`../../../.cache/tmp/rail-collapsed-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.navigate(address)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb') !== null`); attempt += 1) await Bun.sleep(50)
        expect((await geometry()).rail).toBeLessThanOrEqual(72)
        expect(await narrowRail()).toMatchObject({ panelHidden: true, railInteractive: true, expandInside: true })
        await page.evaluate(`document.querySelector('.workspace__rail button[aria-label="Show sessions sidebar"]')?.click()`)
        await settle()
        const restored = await geometry()
        expect(restored.rail).toBeGreaterThan(200)
        expect(Math.abs(restored.main - initial.main)).toBeLessThanOrEqual(2)
        expect(restored.overflow).toBe(false)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail button[aria-label="Show sessions sidebar"]') === null && document.activeElement === document.querySelector('.workspace__rail button[aria-label="Hide sessions sidebar"]')`)).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/rail-restored-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.setReducedMotion(true)
        expect((await geometry()).transition).toBe("0s")
      } finally { await page.close() }
    }
  }, 120_000)

  test("Conversation and Office selection slides without moving the pinned Team control", async () => {
    for (const width of [1440, 820]) {
      const page = await fixture("view=chat", width, "Team")
      try {
        const measure = () => page.evaluate<{ left: number; width: number; target: number; targetWidth: number; duration: string; property: string; switchWidth: number; switchHeight: number; teamLeft: number; teamDuration: string }>(`(() => { const switcher=document.querySelector('.presentation-switch'), selected=switcher.querySelector('[aria-checked="true"]'), indicator=switcher.querySelector('.presentation-switch__indicator'), team=document.querySelector('.workspace__topbar [aria-label="Open Team"]'); const r=indicator?.getBoundingClientRect(), s=selected.getBoundingClientRect(), bar=switcher.getBoundingClientRect(); return { left:r?.left ?? -1, width:r?.width ?? 0, target:s.left, targetWidth:s.width, duration:indicator ? getComputedStyle(indicator).transitionDuration : '0s', property:indicator ? getComputedStyle(indicator).transitionProperty : '', switchWidth:bar.width, switchHeight:bar.height, teamLeft:team.getBoundingClientRect().left, teamDuration:getComputedStyle(team).transitionDuration } })()`)
        for (let attempt = 0; attempt < 20; attempt += 1) { const current = await measure(); if (Math.abs(current.left - current.target) <= 1 && Math.abs(current.width - current.targetWidth) <= 1) break; await Bun.sleep(20) }
        const initial = await measure()
        expect(Math.abs(initial.left - initial.target)).toBeLessThanOrEqual(1)
        expect(Math.abs(initial.width - initial.targetWidth)).toBeLessThanOrEqual(1)
        expect(initial.duration).not.toBe("0s")
        expect(initial.property).toContain("transform")
        await page.evaluate(`document.querySelector('.presentation-switch [role="radio"]:last-child')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.presentation-switch [role="radio"]:last-child')?.getAttribute('aria-checked') === 'true'`); attempt += 1) await Bun.sleep(50)
        for (let attempt = 0; attempt < 30; attempt += 1) { const current = await measure(); if (Math.abs(current.left - current.target) <= 1 && Math.abs(current.width - current.targetWidth) <= 1) break; await Bun.sleep(20) }
        const office = await measure()
        expect(Math.abs(office.left - office.target)).toBeLessThanOrEqual(1)
        expect(Math.abs(office.width - office.targetWidth)).toBeLessThanOrEqual(1)
        expect(Math.abs(office.switchWidth - initial.switchWidth)).toBeLessThanOrEqual(1)
        expect(Math.abs(office.switchHeight - initial.switchHeight)).toBeLessThanOrEqual(1)
        expect(Math.abs(office.teamLeft - initial.teamLeft)).toBeLessThanOrEqual(1)
        expect(office.teamDuration).not.toBe("0s")
        await Bun.write(new URL(`../../../.cache/tmp/presentation-switch-${width}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`document.querySelector('.workspace__topbar [aria-label="Open Team"]')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.workspace__topbar [aria-label="Open Team"]')?.getAttribute('aria-expanded') === 'true'`); attempt += 1) await Bun.sleep(25)
        expect(await page.evaluate<string>(`document.querySelector('.workspace__topbar [aria-label="Open Team"]')?.getAttribute('aria-expanded')`)).toBe("true")
        await page.setReducedMotion(true)
        const reduced = await measure()
        expect(reduced.duration).toBe("0s")
        expect(reduced.teamDuration).toBe("0s")
      } finally { await page.close() }
    }
  }, 30_000)

  test("keeps the phone Team bar above scrolling Conversation content while Office stays hidden", async () => {
    const page = await fixture("view=chat&team=two", 390, "Team", undefined, 844)
    try {
      await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture = document.querySelector('.fixture'); fixture.style.height = '100dvh'; fixture.style.minHeight = '0'; fixture.style.overflow = 'hidden'; })()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.transcript-message') !== null`); attempt += 1) await Bun.sleep(50)
      const initial = await page.evaluate<{ readonly top: number; readonly bottom: number; readonly scrollBoxTop: number; readonly hasTeam: boolean; readonly hasOffice: boolean }>(`(() => { const bar = document.querySelector('.workspace__topbar'); return { top: bar.getBoundingClientRect().top, bottom: bar.getBoundingClientRect().bottom, scrollBoxTop: document.querySelector('.workspace__scroll').getBoundingClientRect().top, hasTeam: bar.querySelector('[aria-label="Open Team"]') !== null, hasOffice: bar.querySelector('.presentation-switch') !== null }; })()`)
      expect(initial.hasTeam).toBe(true)
      expect(initial.hasOffice).toBe(false)
      expect(initial.bottom).toBeLessThanOrEqual(initial.scrollBoxTop + 1)
      const visible = await page.evaluate<{ readonly scrollTop: number; readonly top: number; readonly barTop: number }>(`(() => { const scroll = document.querySelector('.workspace__scroll'); const row = document.querySelector('.transcript-message'); document.querySelector('.conversation-pane').style.minHeight = '1900px'; scroll.scrollTop = Math.max(1, row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 4); return { scrollTop: scroll.scrollTop, top: row.getBoundingClientRect().top, barTop: document.querySelector('.workspace__topbar').getBoundingClientRect().top }; })()`)
      expect(visible.scrollTop).toBeGreaterThan(0)
      expect(visible.barTop).toBeCloseTo(initial.top, 0)
      expect(visible.top).toBeGreaterThanOrEqual(initial.bottom)
      await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop = document.querySelector('.workspace__scroll').scrollHeight`)
      expect(await page.evaluate<number>(`document.querySelector('.workspace__topbar').getBoundingClientRect().top`)).toBeCloseTo(initial.top, 0)
    } finally { await page.close() }
  }, 15_000)

  test("shows running roots before recent cross-workspace Sessions on desktop and phone", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await fixture(`scenario=session-list-${width}`, width, "Async Auth Token Revocation Migration")
      try {
        await page.setViewport(width, height)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`window.remoteStatus(['ses_fixture', 'ses_telemetry'], [])`)
        for (let attempt = 0; attempt < 160 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 4; attempt += 1) await Bun.sleep(50)
        const cards = await page.evaluate<readonly { readonly title: string; readonly running: boolean; readonly lastActive: boolean }[]>(`[...document.querySelectorAll('.running-sessions__item')].map(card => ({ title: card.querySelector('.running-sessions__title')?.textContent?.trim() ?? '', running: card.querySelector('.running-sessions__status')?.textContent?.trim() === 'Running', lastActive: card.querySelector('.running-sessions__status time[datetime]') !== null }))`)
        expect(cards).toEqual([
          { title: "Async Auth Token Revocation Migration", running: true, lastActive: false },
          { title: "Telemetry Event Buffer Flush Daemon", running: true, lastActive: false },
          { title: "Redis Cache Cluster Rebalancing Spec", running: false, lastActive: true },
          { title: "Postgres Partition Pruning Worker", running: false, lastActive: true },
        ])
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/running-recent-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }, 30_000)

  test("keeps a main-idle root running when its subagent executes", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await fixture(`scenario=session-list-${width}&carouselFamily=1`, width, "Async Auth Token Revocation Migration")
      try {
        await page.setViewport(width, height)
        await page.evaluate(`window.remoteStatus(['ses_fixture', 'ses_telemetry', 'ses_postgres'], [])`)
        for (let attempt = 0; attempt < 160 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 4; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<readonly { readonly title: string; readonly running: boolean }[]>(`[...document.querySelectorAll('.running-sessions__item')].map(card => ({ title: card.querySelector('.running-sessions__title')?.textContent?.trim() ?? '', running: card.querySelector('.running-sessions__status')?.textContent?.trim() === 'Running' }))`)).toEqual([
          { title: "Async Auth Token Revocation Migration", running: true },
          { title: "Telemetry Event Buffer Flush Daemon", running: true },
          { title: "Postgres Partition Pruning Worker", running: true },
          { title: "Redis Cache Cluster Rebalancing Spec", running: false },
        ])
      } finally { await page.close() }
    }
  }, 30_000)

  test("opens another Session from New session without leaving its composer in history", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await fixture("view=chat", width, "Stream remote output safely", undefined, height)
      try {
        if (width === 390) {
          await page.evaluate(`document.querySelector('.app-header__menu')?.click()`)
          for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.overlay--sessions-sheet[open] .session-row') !== null`); attempt += 1) await Bun.sleep(50)
          await page.evaluate(`document.querySelector('.overlay--sessions-sheet .pane__head button')?.click()`)
        } else await page.evaluate(`document.querySelector('.workspace__rail .pane__head button')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.new-session-composer') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`location.hash`)).toBe("#new-session")
        if (width === 390) {
          await page.evaluate(`document.querySelector('.app-header__menu')?.click()`)
          for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.overlay--sessions-sheet[open] .session-row') !== null`); attempt += 1) await Bun.sleep(50)
          await page.evaluate(`[...document.querySelectorAll('.overlay--sessions-sheet .session-row')].find(row => row.textContent.includes('Archived: release notes'))?.click()`)
        } else await page.evaluate(`[...document.querySelectorAll('.workspace__rail .session-row')].find(row => row.textContent.includes('Archived: release notes'))?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Archived: release notes') ?? false`); attempt += 1) await Bun.sleep(50)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.activeElement === document.querySelector('.remote-conversation-view .conversation-breadcrumb')`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.remote-conversation-view .conversation-breadcrumb')`)).toBe(true)
        expect(await page.evaluate<{ readonly hash: string; readonly closed: boolean; readonly title: string }>(`(() => { const composer=document.querySelector('.new-session-composer'), panel=composer?.closest('.route-panel'); return { hash: location.hash, closed: !composer || panel?.inert === true && panel?.getAttribute('aria-hidden') === 'true', title: document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? '' } })()`)).toEqual({ hash: "", closed: true, title: "Archived: release notes" })
        for (let attempt = 0; attempt < 20 && await page.evaluate<boolean>(`document.querySelector('.new-session-composer') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer') === null`)).toBe(true)
        await page.evaluate(`history.back()`)
        await Bun.sleep(100)
        expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.new-session-composer')].every((element) => element.closest('[inert]') !== null)`)).toBe(true)
        for (let attempt = 0; attempt < 20 && await page.evaluate<boolean>(`document.querySelector('.new-session-composer') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`location.hash === '' && document.querySelector('.new-session-composer') === null && document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Archived: release notes') === true`)).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("follows a deep-linked Session's workspace instead of the previously browsed workspace", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-1440`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`location.hash = '#session=ses_indexer'`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Query batch indexer') ?? false`); attempt += 1) await Bun.sleep(50)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .session-panel__workspace h3')?.textContent?.trim() === 'indexer' && document.querySelector('.workspace__rail .session-row--active .session-row__name')?.textContent?.trim() === 'Query batch indexer'`); attempt += 1) await Bun.sleep(50)
      const state = await page.evaluate<{ readonly heading: string; readonly active: string; readonly selector: boolean }>(`(() => ({ heading: document.querySelector('.workspace__rail .session-panel__workspace h3')?.textContent?.trim() ?? '', active: document.querySelector('.workspace__rail .session-row--active .session-row__name')?.textContent?.trim() ?? '', selector: Boolean(document.querySelector('.workspace__rail .workspace-select .custom-select__trigger')) }))()`)
      expect(state).toEqual({ heading: "indexer", active: "Query batch indexer", selector: false })
    } finally { await page.close() }
  }, 30_000)

  test("highlights the root when a child Session is opened from a deep link", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`location.hash = '#session=ses_child'`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Child: fix flaky suite') ?? false`); attempt += 1) await Bun.sleep(50)
      const result = await page.evaluate<{ readonly heading: string; readonly active: string; readonly dropdown: boolean }>(`(() => ({ heading: document.querySelector('.workspace__rail .session-panel__workspace h3')?.textContent?.trim() ?? '', active: document.querySelector('.workspace__rail .session-row--active .session-row__name')?.textContent?.trim() ?? '', dropdown: Boolean(document.querySelector('.workspace__rail .workspace-select .custom-select__trigger')) }))()`)
      expect(result).toEqual({ heading: "ycoding", active: "Stream remote output safely", dropdown: false })
    } finally { await page.close() }
  }, 30_000)

  test("opens a newly created Session in another repository and follows its sidebar workspace", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .pane__head--sessions button') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.workspace__rail .pane__head--sessions button').click()`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.new-session-composer .mini-picker__trigger[aria-label="Repository"]') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.new-session-composer .mini-picker__trigger[aria-label="Repository"]').click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`[...document.querySelectorAll('.mini-picker__option')].some(option => option.textContent.includes('Other repository'))`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`[...document.querySelectorAll('.mini-picker__option')].find(option => option.textContent.includes('Other repository'))?.click()`)
      await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]').click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('New session') ?? false`); attempt += 1) await Bun.sleep(50)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .session-row--active') !== null`); attempt += 1) await Bun.sleep(50)
      const result = await page.evaluate<{ readonly breadcrumb: string; readonly heading: string; readonly active: string }>(`(() => ({ breadcrumb: document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? '', heading: document.querySelector('.workspace__rail .session-panel__workspace h3')?.textContent?.trim() ?? '', active: document.querySelector('.workspace__rail .session-row--active .session-row__name')?.textContent?.trim() ?? '' }))()`)
      expect(result).toEqual({ breadcrumb: "New session", heading: "other", active: "New session" })
    } finally { await page.close() }
  }, 30_000)

  test("keeps workspace switching on the Sessions page at desktop and phone widths", async () => {
    for (const width of [1440, 390]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=session-list-${width === 390 ? 390 : 1440}`)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.sessions-page__title') !== null`); attempt += 1) await Bun.sleep(50)
        if (width === 1440) await page.evaluate(`document.querySelector('.workspace-nav__item[title="/workspace/telemetry-daemon"]').click()`)
        else {
          await page.evaluate(`document.querySelector('.sessions-page__workspace-select .custom-select__trigger').click()`)
          for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog .custom-select__option') !== null`); attempt += 1) await Bun.sleep(50)
          await page.evaluate(`[...document.querySelectorAll('.custom-select__dialog .custom-select__option')].find(option => option.textContent.includes('telemetry-daemon'))?.click()`)
          await page.evaluate(`document.querySelector('.custom-select__confirm').click()`)
        }
        for (let attempt = 0; attempt < 60 && await page.evaluate<string>(`document.querySelector('.sessions-page__title')?.textContent?.trim() ?? ''`) !== "telemetry-daemon"; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('.sessions-page__title')?.textContent?.trim() ?? ''`)).toBe("telemetry-daemon")
      } finally { await page.close() }
    }
  }, 30_000)
  test("keeps the selected Session and draft stable through a rendered reconnect", async () => {
    const page = await fixture("view=chat", 390, "Stream remote output safely")
    try {
      const initial = await page.evaluate<{ readonly status: string; readonly title: string; readonly draft: string; readonly disabled: boolean }>(`(() => {
        const input = document.querySelector('.composer__input');
        input.value = 'Keep this unsent draft';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        const read = () => {
          const strip = document.querySelector('.status-strip');
          return {
            status: strip?.querySelector('.status-strip__body')?.textContent?.trim() ?? '',
            title: document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? '',
            draft: document.querySelector('.composer__input')?.value ?? '',
            disabled: document.querySelector('button[aria-label="Send prompt"]')?.disabled ?? true,
            top: strip?.getBoundingClientRect().top ?? -1,
            height: strip?.getBoundingClientRect().height ?? -1,
          };
        };
        window.reconnectSamples = [read()];
        window.reconnectObserver = new MutationObserver(() => {
          const next = read();
          if (JSON.stringify(window.reconnectSamples.at(-1)) !== JSON.stringify(next)) window.reconnectSamples.push(next);
        });
        window.reconnectObserver.observe(document.querySelector('.app'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'disabled'] });
        return read();
      })()`)
      expect(initial).toMatchObject({ status: "Connected — Relay session active for Studio Mac.", title: "Stream remote output safely", draft: "Keep this unsent draft", disabled: false })

      await page.evaluate(`document.querySelector('.fixture__controls button:nth-child(2)')?.click()`)
      const drop = " · Last browser relay drop (1006): synthetic disconnect"
      expect(await page.evaluate<{ readonly status: string; readonly disabled: boolean }>(`window.reconnectSamples.at(-1)`)).toMatchObject({ status: `Connecting — Opening the relay connection.${drop}`, disabled: true })
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.notice-strip')?.textContent?.includes('Reconnected.') ?? false`)) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<string>(`document.querySelector('.notice-strip')?.textContent ?? ''`)).toContain("Reconnected.")
      const samples = await page.evaluate<readonly { readonly status: string; readonly title: string; readonly draft: string; readonly disabled: boolean; readonly top: number; readonly height: number }[]>(`(() => {
        window.reconnectObserver.disconnect();
        return window.reconnectSamples;
      })()`)
      expect(samples.at(-1)).toMatchObject({ status: `${initial.status}${drop}`, title: initial.title, draft: initial.draft, disabled: false })
      expect(samples.some((sample) => sample.status.startsWith("Connecting"))).toBe(true)
      expect(samples.every((sample) => sample.title === initial.title && sample.draft === initial.draft && !sample.status.startsWith("Signed out"))).toBe(true)
      expect(samples.every((sample) => Math.abs(sample.top - samples[0]!.top) <= 1 && Math.abs(sample.height - samples[0]!.height) <= 1)).toBe(true)
      expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === 'session.prompt').length`)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("keeps unsent prompts with the Session where they were drafted", async () => {
    const page = await fixture("view=chat", 390, "Stream remote output safely")
    try {
      await page.evaluate(`(() => {
        const input = document.querySelector('.composer__input');
        input.value = 'Work only in Session A';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        document.querySelectorAll('.session-row')[1]?.click();
      })()`)
      expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`)).toContain("Archived: release notes")
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("")
      expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Send prompt"]')?.disabled === true`)).toBe(true)
      expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === 'session.prompt').length`)).toBe(0)
      await page.evaluate(`document.querySelectorAll('.session-row')[0]?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("Work only in Session A")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("loads Unicode shell output through the rendered page controls", async () => {
    const page = await fixture("view=chat", 390, "bun test --verbose")
    const output = () => page.evaluate<readonly { readonly command: string; readonly output?: string; readonly buttons: readonly string[] }[]>(`window.remoteShellOutputReport()`)
    const paged = async () => (await output()).find((row) => row.command === "bun test --verbose")
    const click = (label: string) => page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.shell')].find(shell => shell.querySelector('.shell__header code')?.textContent === 'bun test --verbose');
      [...(row?.querySelectorAll('.transcript-shell-output button') ?? [])].find(button => button.textContent?.trim() === ${JSON.stringify(label)})?.click();
    })()`)
    try {
      expect((await paged())?.buttons).toContain("Show more")
      await click("Show more")
      expect((await paged())?.output).toContain("line 30: compiled module 29.ts")
      expect((await paged())?.output).not.toContain("λ unicode")
      expect((await paged())?.buttons).toContain("Load more output")

      await click("Load more output")
      for (let attempt = 0; attempt < 30 && !(await paged())?.output?.includes("λ unicode"); attempt++) await Bun.sleep(50)
      expect((await paged())?.output).toContain("λ unicode · page two arrived from the device")
      expect((await paged())?.buttons).toContain("Load more output")

      await click("Load more output")
      for (let attempt = 0; attempt < 30 && !(await paged())?.output?.includes("final line"); attempt++) await Bun.sleep(50)
      expect((await paged())?.output).toContain("final line")
      expect((await paged())?.buttons).not.toContain("Load more output")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("pages rendered Unicode shell output over the browser relay wire", async () => {
    const second = "λ unicode · page two arrived from the device\n"
    const third = "final line\n"
    const secondBytes = new TextEncoder().encode(second).length
    let firstBytes = 0
    const size = () => firstBytes + secondBytes + new TextEncoder().encode(third).length
    const relay = await startRelayDouble({
      handler: (request) => {
        if (request.operation !== "session.shell.output") return "default"
        if (request.input?.cursor === firstBytes) return { ok: true, value: { data: { output: second, cursor: firstBytes + secondBytes, size: size(), truncated: false } } }
        if (request.input?.cursor === firstBytes + secondBytes) return { ok: true, value: { data: { output: third, cursor: size(), size: size(), truncated: false } } }
        return "default"
      },
    })
    try {
      const page = await fixture(`view=chat&relay=${encodeURIComponent(relay.wsURL("dev_studio"))}`, 390, "bun test --verbose")
      const output = () => page.evaluate<readonly { readonly command: string; readonly output?: string; readonly buttons: readonly string[] }[]>(`window.remoteShellOutputReport()`)
      const paged = async () => (await output()).find((row) => row.command === "bun test --verbose")
      const click = (label: string) => page.evaluate(`(() => {
        const row = [...document.querySelectorAll('.shell')].find(shell => shell.querySelector('.shell__header code')?.textContent === 'bun test --verbose');
        [...(row?.querySelectorAll('.transcript-shell-output button') ?? [])].find(button => button.textContent?.trim() === ${JSON.stringify(label)})?.click();
      })()`)
      try {
        await click("Show more")
        const first = (await paged())?.output ?? ""
        expect(first).toContain("line 30: compiled module 29.ts")
        firstBytes = new TextEncoder().encode(first).length
        expect(secondBytes).toBeGreaterThan(second.length)

        await click("Load more output")
        for (let attempt = 0; attempt < 30 && (await paged())?.output !== first + second; attempt++) await Bun.sleep(50)
        expect((await paged())?.output).toBe(first + second)
        await click("Load more output")
        for (let attempt = 0; attempt < 30 && (await paged())?.output !== first + second + third; attempt++) await Bun.sleep(50)
        expect((await paged())?.output).toBe(first + second + third)
        expect((await paged())?.buttons).not.toContain("Load more output")
        expect(relay.rejectedFrames).toEqual([])
        expect(relay.requests.map((request) => ({ operation: request.operation, sessionID: request.sessionID, input: request.input }))).toEqual([
          { operation: "session.shell.output", sessionID: "ses_fixture", input: { shellID: "sh_paged", cursor: firstBytes, limit: 65_536 } },
          { operation: "session.shell.output", sessionID: "ses_fixture", input: { shellID: "sh_paged", cursor: firstBytes + secondBytes, limit: 65_536 } },
        ])
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      } finally {
        await page.close()
      }
    } finally {
      await relay.stop()
    }
  }, 30_000)

  test("opens a recorded file patch in Activity without escaping the mobile viewport", async () => {
    const page = await fixture("view=activity&files=recorded", 320, "src/remote/store.ts")
    const button = await page.evaluate<boolean>(`[...document.querySelectorAll('.activity-row--file button')].some(button => button.textContent?.includes('View diff'))`)
    expect(button).toBe(true)
    expect(await page.evaluate<string>(`document.querySelector('.activity-row--file button')?.getAttribute('aria-label') ?? ''`)).toBe("View diff for src/remote/store.ts")
    await page.evaluate(`document.querySelector('.activity-row--file button')?.click()`)
    const expanded = await page.evaluate<{ readonly text: string; readonly injected: boolean; readonly pageOverflow: boolean; readonly localScroll: boolean }>(`(() => {
      const row = document.querySelector('.activity-row--file')
      const output = row?.querySelector('pre')
      return {
        text: output?.textContent ?? '',
        injected: row?.querySelector('img') !== null,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        localScroll: output instanceof HTMLElement && output.scrollWidth > output.clientWidth,
      }
    })()`)
    expect(expanded.text).toContain('@@ -1 +1 @@')
    expect(expanded.text).toContain('<img src=x onerror=alert(1)>')
    expect(expanded.injected).toBe(false)
    expect(expanded.pageOverflow).toBe(false)
    expect(expanded.localScroll).toBe(true)
    await page.evaluate(`document.querySelector('.fixture__controls button')?.click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.activity-row--file button')?.getAttribute('aria-expanded') === 'true' && document.querySelector('.activity-row--file pre') !== null`)).toBe(true)
    await page.close()
  }, 30_000)

  test("keeps an unknown prompt retry and notice with its owning Session", async () => {
    const page = await fixture("view=chat&promptOutcome=unknown", 390, "Stream remote output safely")
    await page.evaluate(`(() => {
      const input=document.querySelector('.composer__input');
      input.value='Work on A';
      input.dispatchEvent(new InputEvent('input',{bubbles:true}));
      document.querySelector('button[aria-label="Send prompt"]')?.click();
    })()`)
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await page.evaluate<boolean>(`document.querySelector('.mutation--unknown') !== null`)) break
      await Bun.sleep(50)
    }
    expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown .button').length`)).toBe(2)
    await page.evaluate(`document.querySelectorAll('.session-row')[1]?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`)).toContain("Archived: release notes")
    expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown').length`)).toBe(0)
    expect(await page.evaluate<string>(`document.querySelector('.notice-strip--warning')?.textContent ?? ''`)).toBe("")
    await page.evaluate(`document.querySelectorAll('.session-row')[0]?.click()`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown').length`)).toBe(1)
    expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown .button').length`)).toBe(2)
    expect(await page.evaluate<string>(`document.querySelector('.notice-strip--warning')?.textContent ?? ''`)).toContain("Nothing was resent automatically")
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request=>request.operation==='session.prompt').length`)).toBe(1)
    await page.close()
  }, 30_000)

  test("uses the SVG chevron primitive without polluting the Device control name at compact and desktop widths", async () => {
    for (const width of [390, 1440] as const) {
      const page = await fixture("scenario=conversation-workspace-768", width, "Studio Mac")
      await page.evaluate(`document.querySelector('a[href="/remote/settings"]')?.click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]') !== null`); attempt += 1) await Bun.sleep(50)
      const state = await page.evaluate<{
        readonly controlName: string
        readonly glyph: boolean
        readonly path: boolean
        readonly hidden: string | null
        readonly icon: { readonly top: number; readonly bottom: number; readonly triggerTop: number; readonly triggerBottom: number }
        readonly label: { readonly right: number; readonly iconLeft: number; readonly scrollWidth: number; readonly width: number }
      }>(`(() => {
        const trigger=document.querySelector('[aria-label="Machine"]');
        const icon=trigger?.querySelector('.custom-select__chevron');
        const label=trigger?.querySelector('.custom-select__value');
        const iconBox=icon?.getBoundingClientRect();
        const triggerBox=trigger?.getBoundingClientRect();
        const labelBox=label?.getBoundingClientRect();
        return {
          controlName:trigger?.getAttribute('aria-label') ?? '',
          glyph:icon?.textContent?.trim() === '⌄',
          path:icon?.querySelector('svg path') !== null,
          hidden:icon?.getAttribute('aria-hidden') ?? null,
          icon:{top:iconBox?.top ?? 0,bottom:iconBox?.bottom ?? 0,triggerTop:triggerBox?.top ?? 0,triggerBottom:triggerBox?.bottom ?? 0},
          label:{right:labelBox?.right ?? 0,iconLeft:iconBox?.left ?? 0,scrollWidth:label?.scrollWidth ?? 0,width:label?.clientWidth ?? 0},
        };
      })()`)
      expect(state.controlName).toBe("Machine")
      expect(state.glyph).toBe(false)
      expect(state.path).toBe(true)
      expect(state.hidden).toBe("true")
      expect(state.icon.top).toBeGreaterThanOrEqual(state.icon.triggerTop)
      expect(state.icon.bottom).toBeLessThanOrEqual(state.icon.triggerBottom)
      expect(state.label.right).toBeLessThanOrEqual(state.label.iconLeft)
      expect(state.label.scrollWidth).toBeGreaterThanOrEqual(state.label.width)
      await page.evaluate(`document.querySelector('[aria-label="Machine"]')?.focus()`)
      await page.pressKey("Enter", "Enter", 13)
      expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Machine"]')?.getAttribute('aria-expanded') === 'true' && document.querySelector('[role="listbox"]') !== null`)).toBe(true)
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Machine'`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("centers unavailable and empty-state stacks in the usable main column without overflow", async () => {
    for (const width of [2048, 1440, 768, 390] as const) {
      const page = await fixture("view=chat&account=unavailable&sessions=empty", width, "Remote access is not available")
      const state = await page.evaluate<{
        readonly headingCenter: number
        readonly actionsCenter: number
        readonly mainCenter: number
        readonly order: boolean
        readonly emptyCards: number
        readonly overflow: boolean
      }>(`(() => {
        const main=document.querySelector('.workspace__main')?.getBoundingClientRect();
        const heading=document.querySelector('.page-head')?.getBoundingClientRect();
        const actions=document.querySelector('.workspace__main .pane')?.getBoundingClientRect();
        return {
          headingCenter:(heading?.left ?? 0)+(heading?.width ?? 0)/2,
          actionsCenter:(actions?.left ?? 0)+(actions?.width ?? 0)/2,
          mainCenter:(main?.left ?? 0)+(main?.width ?? 0)/2,
          order:(heading?.bottom ?? Infinity) <= (actions?.top ?? -Infinity),
          emptyCards:document.querySelectorAll('.workspace__main .empty').length,
          overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      })()`)
      expect(Math.abs(state.headingCenter - state.mainCenter)).toBeLessThanOrEqual(1)
      expect(Math.abs(state.actionsCenter - state.mainCenter)).toBeLessThanOrEqual(1)
      expect(state.order).toBe(true)
      expect(state.emptyCards).toBe(0)
      expect(state.overflow).toBe(false)
      await page.close()
    }
  }, 30_000)

  test("marks the active route in desktop and mobile navigation and follows keyboard activation", async () => {
    for (const [width, path, label] of [[1440, "/remote/sessions", "Sessions"], [390, "/remote/settings", "Settings"]] as const) {
      const page = await fixture(`view=${path.slice("/remote/".length)}&sessions=empty`, width, label)
      const active = await page.evaluate<string | null>(`document.querySelector('.remote-nav a[aria-current="page"]')?.textContent?.trim() ?? null`)
      expect(active).toBe(label)
      await page.evaluate(`(() => { const link=document.querySelector('.remote-nav a[href="/remote/activity"]'); link?.focus(); link?.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter'})); })()`)
      expect(await page.evaluate<boolean>(`location.pathname === '/remote/activity'`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("keeps one vertical scroll owner and one aligned responsive content column", async () => {
    for (const width of [1440, 768, 390] as const) {
      const page = await fixture("view=settings", width, "Notifications")
      const state = await page.evaluate<{
        readonly scrollOwners: number
        readonly documentScrollable: boolean
        readonly documentHeights: readonly number[]
        readonly edges: readonly { readonly left: number; readonly right: number }[]
        readonly overflow: boolean
        readonly finalControlReachable: boolean
      }>(`(() => {
        document.querySelector('.fixture__banner')?.remove();
        document.querySelector('.fixture__controls')?.remove();
        const fixture=document.querySelector('.fixture');
        if (fixture instanceof HTMLElement) { fixture.style.minHeight='0'; fixture.style.height='100dvh'; fixture.style.overflow='hidden'; }
        const elements=[document.scrollingElement,...document.querySelectorAll('.app,.workspace,.workspace__main,.workspace__scroll')].filter(element=>element instanceof HTMLElement);
        const scrollOwners=elements.filter(element=>element.scrollHeight > element.clientHeight + 1 && ['auto','scroll'].includes(getComputedStyle(element).overflowY)).length;
        const surfaces=[...document.querySelectorAll('.settings__section')].filter(element=>element instanceof HTMLElement&&element.getBoundingClientRect().width>0).slice(0,5).map(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:box.right}});
        const scroll=document.querySelector('.workspace__scroll');
        if (scroll instanceof HTMLElement) scroll.scrollTop=scroll.scrollHeight;
        const final=[...document.querySelectorAll('.workspace__scroll button')].at(-1)?.getBoundingClientRect();
        const scrollBox=scroll?.getBoundingClientRect();
        return {
          scrollOwners,
          documentScrollable:document.documentElement.scrollHeight > document.documentElement.clientHeight + 1 && ['auto','scroll'].includes(getComputedStyle(document.documentElement).overflowY),
          documentHeights:[document.documentElement.scrollHeight,document.documentElement.clientHeight],
          edges:surfaces,
          overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
          finalControlReachable:(final?.bottom ?? Infinity) <= (scrollBox?.bottom ?? -Infinity),
        };
      })()`)
      expect(state.scrollOwners).toBe(1)
      expect(state.documentScrollable, JSON.stringify(state)).toBe(false)
      expect(state.edges.length).toBeGreaterThan(1)
      expect(state.edges.every((edge) => Math.abs(edge.left - state.edges[0]!.left) <= 1 && Math.abs(edge.right - state.edges[0]!.right) <= 1)).toBe(true)
      expect(state.overflow).toBe(false)
      expect(state.finalControlReachable).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("keeps the mobile Settings machine picker usable with five-tab navigation", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("scenario=conversation-workspace-390", 390, "Token expiry refactor", theme, 620)
      await page.evaluate(`document.querySelector('a[href="/remote/settings"]')?.click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.click()`)
      await page.evaluate(`Promise.all([...document.querySelector('.custom-select__dialog .overlay__surface')?.getAnimations() ?? []].map(animation => animation.finished))`)
      const state = await page.evaluate<{
        readonly brandVisible: boolean
        readonly tabs: readonly string[]
        readonly sheet: { readonly top: number; readonly bottom: number }
        readonly options: readonly { readonly label: string; readonly height: number }[]
        readonly overflow: boolean
      }>(`(() => {
        const box=document.querySelector('.custom-select__dialog .overlay__surface')?.getBoundingClientRect();
        return {
          brandVisible:document.querySelector('.app-header .brand img') instanceof HTMLImageElement && document.querySelector('.app-header .brand img').getBoundingClientRect().width > 0,
          tabs:[...document.querySelectorAll('.bottom-nav__item')].filter(link=>link.getBoundingClientRect().width>0).map(link=>link.textContent.trim()),
          sheet:{top:box?.top ?? 0,bottom:box?.bottom ?? 0},
          options:[...document.querySelectorAll('.custom-select__option')].map(option=>({label:option.querySelector('.custom-select__option-body')?.textContent.trim() ?? '',height:option.getBoundingClientRect().height})),
          overflow:document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      expect(state.brandVisible).toBe(true)
      expect(state.tabs).toEqual(["Sessions", "Conversation", "Activity", "Usage", "Settings"])
      expect(state.sheet.bottom).toBeCloseTo(620, 0)
      expect(state.sheet.top).toBeLessThan(state.sheet.bottom)
      expect(state.options.map((option) => option.label)).toEqual(["Studio Mac", "Dev Linux"])
      expect(state.options.every((option) => option.height >= 44)).toBe(true)
      expect(state.overflow).toBe(false)
      await page.evaluate(`document.querySelector('.custom-select__option[aria-selected="false"]')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"] .custom-select__value')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      await page.evaluate(`document.querySelector('.custom-select__confirm')?.click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Machine"] .custom-select__value')?.textContent?.includes('Dev Linux') ?? false`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"] .custom-select__value')?.textContent?.trim() ?? ''`)).toBe("Dev Linux")
      expect(await page.evaluate<boolean>(`(() => { const dialog = document.querySelector('.custom-select__dialog'); return dialog === null || (!dialog.open && dialog.inert) })()`)).toBe(true)
      for (let attempt = 0; attempt < 20 && await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog') === null`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("keeps the mobile composer compact and sizes dense controls for the active pointer", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("scenario=conversation-tool-terminal-output-390", 390, "Run sanity checks on worker threads.", theme, 620)
      const state = await page.evaluate<{
        readonly height: number
        readonly input: number
        readonly mobileTrigger: number
        readonly actions: readonly { readonly label: string; readonly height: number }[]
        readonly messages: number
        readonly overflow: boolean
      }>(`(() => {
        const composer=document.querySelector('.composer');
        return {
          height:composer?.getBoundingClientRect().height ?? 0,
          input:composer?.querySelector('.composer__input')?.getBoundingClientRect().height ?? 0,
          mobileTrigger:document.querySelector('.composer__mobile-trigger')?.getBoundingClientRect().height ?? 0,
          actions:[...composer?.querySelectorAll('button') ?? []].filter(button=>button.getBoundingClientRect().width>0).map(button=>({label:button.getAttribute('aria-label') ?? button.textContent.trim(),height:button.getBoundingClientRect().height})),
          messages:document.querySelectorAll('.transcript > .transcript-navigation__item > .transcript-message').length,
          overflow:document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      expect(state.height).toBeLessThanOrEqual(160)
      expect(state.input).toBeGreaterThanOrEqual(44)
      expect(state.mobileTrigger).toBeGreaterThanOrEqual(44)
      expect(state.actions.map((action) => action.label)).toContain("Send prompt")
      expect(state.actions.every((action) => action.height >= 36), JSON.stringify(state.actions)).toBe(true)
      expect(state.messages).toBe(2)
      expect(state.overflow).toBe(false)
      await page.setCoarsePointer(true)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.composer button,.composer__mobile-trigger')].filter(button => button.getBoundingClientRect().width > 0).every(button => button.getBoundingClientRect().height >= 44)`)).toBe(true)
      await page.evaluate(`document.querySelector('.composer__delivery-toggle')?.click()`)
      expect(await page.evaluate<string | null>(`document.querySelector('.composer__delivery-toggle')?.getAttribute('aria-pressed') ?? null`)).toBe("true")
      await page.close()
    }
  }, 30_000)

  test("keeps mobile Activity decisions and event actions visible in a compact layout", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("scenario=activity-pending-decisions-390", 390, "Authorize branch push for feat/ast-cache", theme, 901)
      const state = await page.evaluate<{
        readonly sectionPadding: readonly number[]
        readonly eventRows: number
        readonly decisions: number
        readonly actions: readonly { readonly label: string; readonly height: number }[]
        readonly overflow: boolean
      }>(`(() => ({
        sectionPadding:[...document.querySelectorAll('.activity-page__events,.activity-page__decisions')].map(element=>parseFloat(getComputedStyle(element).paddingTop)),
        eventRows:document.querySelectorAll('.activity-page__events .activity-row').length,
        decisions:document.querySelectorAll('.activity-page__decisions .request').length,
        actions:[...document.querySelectorAll('.activity-page__decisions .request__actions button')].map(button=>({label:button.textContent.trim(),height:button.getBoundingClientRect().height})),
        overflow:document.documentElement.scrollWidth > innerWidth,
      }))()`)
      expect(state.sectionPadding.every((padding) => padding <= 16)).toBe(true)
      expect(state.eventRows).toBeGreaterThan(0)
      expect(state.decisions).toBe(2)
      expect(state.actions.map((action) => action.label)).toContain("Approve once")
      expect(state.actions.every((action) => action.height >= 44), JSON.stringify(state.actions)).toBe(true)
      expect(state.overflow).toBe(false)
      await page.close()
    }
  }, 30_000)

  test("keeps remote scenarios usable at 320, 390, 768, and 1440px in both themes", async () => {
    for (const width of [320, 390, 768, 1440] as const) {
      for (const theme of ["dark", "light"] as const) {
        const workspace = await fixture("scenario=conversation-workspace-390", width, "Token expiry refactor", theme, 901)
        const workspaceState = await workspace.evaluate<{ readonly overflow: boolean; readonly headerPickerAbsent: boolean; readonly statusVisible: boolean; readonly tabs: number }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          headerPickerAbsent:document.querySelector('.app-header [aria-label="Machine"]') === null,
          statusVisible:(document.querySelector('.app-header .remote-connection')?.getBoundingClientRect().width ?? 0) > 0,
          tabs:[...document.querySelectorAll('.bottom-nav__item')].filter(item=>item.getBoundingClientRect().width>0).length,
        }))()`)
        expect(workspaceState.overflow).toBe(false)
        expect(workspaceState.headerPickerAbsent && workspaceState.statusVisible).toBe(true)
        expect(workspaceState.tabs).toBe(width < 768 ? 5 : 0)
        expect(await workspace.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
        await workspace.close()

        const conversation = await fixture("scenario=conversation-tool-terminal-output-390", width, "Run sanity checks on worker threads.", theme, 901)
        const conversationState = await conversation.evaluate<{ readonly overflow: boolean; readonly messages: number; readonly input: number; readonly inputWidth: number; readonly send: number }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          messages:document.querySelectorAll('.transcript > .transcript-navigation__item > .transcript-message').length,
          input:document.querySelector('.composer__input')?.getBoundingClientRect().height ?? 0,
          inputWidth:document.querySelector('.composer__input')?.getBoundingClientRect().width ?? 0,
          send:document.querySelector('[aria-label="Send prompt"]')?.getBoundingClientRect().height ?? 0,
        }))()`)
        expect(conversationState.overflow).toBe(false)
        expect(conversationState.messages).toBe(2)
        expect(conversationState.input).toBeGreaterThanOrEqual(44)
        expect(conversationState.send).toBeGreaterThanOrEqual(36)
        if (width < 480) expect(conversationState.inputWidth, `${width}px composer input`).toBeGreaterThanOrEqual(96)
        expect(await conversation.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
        await conversation.close()

        const activity = await fixture("scenario=activity-pending-decisions-390", width, "Authorize branch push for feat/ast-cache", theme, 901)
        const activityState = await activity.evaluate<{ readonly overflow: boolean; readonly rows: number; readonly decisions: number; readonly actions: readonly number[] }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          rows:document.querySelectorAll('.activity-page__events .activity-row').length,
          decisions:document.querySelectorAll('.activity-page__decisions .request').length,
          actions:[...document.querySelectorAll('.activity-page__decisions .request__actions button')].map(button=>button.getBoundingClientRect().height),
        }))()`)
        const activityOrder = await activity.evaluate<{ readonly columns: number; readonly decisionsTop: number; readonly eventsTop: number }>(`(() => {
          const page=document.querySelector('.activity-page')
          if (!(page instanceof HTMLElement)) throw new Error('Activity page missing')
          return {
            columns:getComputedStyle(page).gridTemplateColumns.split(' ').filter(Boolean).length,
            decisionsTop:document.querySelector('.activity-page__decisions')?.getBoundingClientRect().top ?? Infinity,
            eventsTop:document.querySelector('.activity-page__events')?.getBoundingClientRect().top ?? -Infinity,
          }
        })()`)
        expect(activityState.overflow).toBe(false)
        expect(activityState.rows).toBeGreaterThan(0)
        expect(activityState.decisions).toBe(2)
        expect(activityOrder.columns).toBe(width < 1280 ? 1 : 2)
        if (width < 1280) expect(activityOrder.decisionsTop).toBeLessThan(activityOrder.eventsTop)
        if (width < 1024) expect(activityState.actions.every((height) => height >= 44)).toBe(true)
        expect(await activity.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
        await activity.close()
      }
    }
  }, 60_000)
})

function labelAsymmetry(selector: string) {
  return `(() => { const pill = document.querySelector(${JSON.stringify(selector)}), walker = document.createTreeWalker(pill, NodeFilter.SHOW_TEXT), boxes = []; for (let node = walker.nextNode(); node; node = walker.nextNode()) { if (!node.textContent.trim() || getComputedStyle(node.parentElement).visibility === 'hidden') continue; const range = document.createRange(); range.selectNodeContents(node); boxes.push(range.getBoundingClientRect()) } const box = pill.getBoundingClientRect(), left = Math.min(...boxes.map(glyphs => glyphs.left)), right = Math.max(...boxes.map(glyphs => glyphs.right)); return Math.abs((left - box.left) - (box.right - right)) })()`
}

async function fixture(query: string, width: number, expected: string, theme?: "dark" | "light", height = 1366) {
  const page = await requireBrowser().openPage()
  await page.setViewport(width, height)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(expected)})`)) {
      if (theme !== undefined) await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      return page
    }
    await Bun.sleep(100)
  }
  await page.close()
  throw new Error(`${query} at ${width}px did not settle`)
}

function requireBrowser() {
  if (!browser) throw new Error("Browser was not initialized")
  return browser
}

async function ready(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/verify/remote.html`)).ok
  } catch {
    return false
  }
}
