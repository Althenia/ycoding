import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4577
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/todo-fixture.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 390, 820)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Todo fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("todo panel occupies composer flow and keeps transcript clear on phone, tablet, and desktop", async () => {
  if (!browser) throw new Error("Browser not started")
  for (const width of [390, 820, 1440]) for (const theme of ["light", "dark"] as const) {
    const page = await browser.openPage()
    try {
      await page.setViewport(width, 820)
      await page.setColorScheme(theme)
      await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.todo.expanded')`)
      await page.navigate(`http://127.0.0.1:${port}/verify/todo-fixture.html?theme=${theme}`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`!!document.querySelector('.todo-panel__toggle')`); attempt++) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`!!document.querySelector('.todo-panel__toggle')`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector('.todo-panel__toggle').getAttribute('aria-expanded')`)).toBe("false")
      expect(await page.evaluate<string>(`document.querySelector('.todo-panel__progress').textContent.trim()`)).toBe("3/8")
      const alignment = await page.evaluate<{ icon: boolean; offset: number }>(`(() => { const label = document.querySelector('.todo-panel__heading').getBoundingClientRect(); const icon = document.querySelector('.todo-panel__chevron svg')?.getBoundingClientRect(); return { icon: !!icon, offset: icon ? Math.abs((label.top + label.bottom)/2 - (icon.top + icon.bottom)/2) : Infinity }; })()`)
      expect(alignment.icon).toBe(true)
      expect(alignment.offset).toBeLessThanOrEqual(1)
      await page.setCoarsePointer(true)
      expect(await page.evaluate<number>(`document.querySelector('.todo-panel__toggle').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44)
      await page.evaluate(`document.querySelector('.todo-panel__toggle').click()`)
      expect(await page.evaluate<string>(`document.querySelector('.todo-panel__toggle').getAttribute('aria-expanded')`)).toBe("true")
      expect(await page.evaluate<number>(`document.querySelectorAll('.todo-panel__item').length`)).toBe(8)
      expect(await page.evaluate<{ completed: string; active: string; cancelled: string; struck: boolean; contrast: boolean }>(`(() => { const done = document.querySelector('.todo-panel__item--completed'); const active = document.querySelector('.todo-panel__item--in_progress'); const cancelled = document.querySelector('.todo-panel__item--cancelled'); return { completed: done.querySelector('.todo-panel__marker').textContent, active: active.querySelector('.todo-panel__marker').textContent, cancelled: cancelled.querySelector('.todo-panel__marker').textContent, struck: getComputedStyle(cancelled.querySelector('.todo-panel__text')).textDecorationLine.includes('line-through'), contrast: getComputedStyle(done).color !== getComputedStyle(active).color }; })()`)).toEqual({ completed: "✓", active: "●", cancelled: "–", struck: true, contrast: true })
      const bounds = await page.evaluate<{ transcriptBottom: number; panelTop: number; panelBottom: number; composerTop: number; scrollable: boolean; pageOverflow: boolean }>(`(() => { const t = document.querySelector('[data-testid="transcript"]').getBoundingClientRect(); const p = document.querySelector('.todo-panel').getBoundingClientRect(); const c = document.querySelector('.composer').getBoundingClientRect(); const l = document.querySelector('.todo-panel__list'); return { transcriptBottom: t.bottom, panelTop: p.top, panelBottom: p.bottom, composerTop: c.top, scrollable: l.scrollHeight > l.clientHeight, pageOverflow: document.documentElement.scrollWidth > innerWidth }; })()`)
      expect(bounds.transcriptBottom).toBeLessThanOrEqual(bounds.panelTop)
      expect(bounds.panelBottom).toBeLessThanOrEqual(bounds.composerTop)
      expect(bounds.scrollable).toBe(true)
      expect(bounds.pageOverflow).toBe(false)
      await page.evaluate(`window.updateTodos([{content:'Live work',status:'in_progress',priority:'high'}])`)
      expect(await page.evaluate<string>(`document.querySelector('.todo-panel__item').textContent`)).toContain("Live work")
      expect(await page.evaluate<string>(`document.querySelector('.todo-panel__progress').textContent.trim()`)).toBe("0/1")
      await page.evaluate(`window.updateTodos([{content:'Live work',status:'completed',priority:'high'},{content:'Wrapped up',status:'completed',priority:'low'}])`)
      expect(await page.evaluate<boolean>(`document.querySelector('.todo-panel') === null`)).toBe(true)
      await page.evaluate(`window.updateTodos([{content:'Live work',status:'completed',priority:'high'},{content:'Follow-up',status:'pending',priority:'low'}])`)
      expect(await page.evaluate<string>(`document.querySelector('.todo-panel__progress').textContent.trim()`)).toBe("1/2")
      await page.evaluate(`window.updateTodos([])`)
      expect(await page.evaluate<boolean>(`document.querySelector('.todo-panel') === null`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("no-todo Session keeps the composer at its original bottom edge", async () => {
  if (!browser) throw new Error("Browser not started")
  for (const width of [390, 820, 1440]) {
    const page = await browser.openPage()
    try {
      await page.setViewport(width, 820)
      await page.navigate(`http://127.0.0.1:${port}/verify/todo-fixture.html?panel=off`)
      expect(await page.evaluate<boolean>(`document.querySelector('.todo-panel') === null`)).toBe(true)
      const original = await page.evaluate<number>(`document.querySelector('.composer').getBoundingClientRect().bottom`)
      await page.navigate(`http://127.0.0.1:${port}/verify/todo-fixture.html`)
      await page.evaluate(`window.updateTodos([])`)
      const empty = await page.evaluate<{ panel: boolean; composerBottom: number; transcriptBottom: number; composerTop: number }>(`(() => { const c = document.querySelector('.composer').getBoundingClientRect(); return { panel: !!document.querySelector('.todo-panel'), composerBottom: c.bottom, composerTop: c.top, transcriptBottom: document.querySelector('[data-testid="transcript"]').getBoundingClientRect().bottom }; })()`)
      expect(empty.panel).toBe(false)
      expect(empty.composerBottom).toBe(original)
      expect(empty.transcriptBottom).toBeLessThanOrEqual(empty.composerTop)
    } finally { await page.close() }
  }
})

test("todo toggle persists per browser and reduced motion disables expansion transitions", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.setReducedMotion(true)
    await page.injectOnNewDocument(`if (!sessionStorage.getItem('todo-persistence-started')) { localStorage.removeItem('ycoding.remote.todo.expanded'); sessionStorage.setItem('todo-persistence-started', 'true') }`)
    await page.navigate(`http://127.0.0.1:${port}/verify/todo-fixture.html?theme=dark`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`!!document.querySelector('.todo-panel__toggle')`); attempt++) await Bun.sleep(50)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.todo-panel__drawer')).transitionDuration`)).toBe("0s")
    await page.evaluate(`document.querySelector('.todo-panel__toggle').click()`)
    expect(await page.evaluate<string>(`localStorage.getItem('ycoding.remote.todo.expanded')`)).toBe("true")
    await page.navigate(`http://127.0.0.1:${port}/verify/todo-fixture.html?theme=dark`)
    expect(await page.evaluate<string>(`document.querySelector('.todo-panel__toggle').getAttribute('aria-expanded')`)).toBe("true")
  } finally { await page.close() }
})
