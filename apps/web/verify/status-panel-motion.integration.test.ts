import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4617
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Composer fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("autonomy and Goal panels enter and leave over frames while restoring focus immediately", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ["light", "dark"] as const) for (const reduce of [false, true]) for (const kind of ["yolo", "goal"] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.setReducedMotion(reduce)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.session-status__${kind}-trigger') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.querySelector('.session-status__${kind}-trigger').click()`)
      const entering = await page.evaluate<{ duration: number; opacity: number; transform: string; focusInside: boolean }>(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const panel = document.querySelector('.session-status__popover'), style = getComputedStyle(panel); resolve({ duration: parseFloat(style.animationDuration) * 1000, opacity: Number(style.opacity), transform: style.transform, focusInside: panel.contains(document.activeElement) }); })))`)
      expect(entering.focusInside).toBe(true)
      if (reduce) expect(entering).toMatchObject({ duration: 0, opacity: 1, transform: "none" })
      else {
        expect(entering.duration).toBe(220)
        expect(entering.opacity).toBeGreaterThan(0)
        expect(entering.opacity).toBeLessThan(1)
        expect(entering.transform).not.toBe("none")
      }
      await page.evaluate(`Promise.all([...document.querySelector('.session-status__popover').getAnimations()].map(animation => animation.finished))`)
      await page.pressEscape()
      const closedImmediately = await page.evaluate<{ expanded: string; focus: boolean; inert: boolean; hidden: boolean }>(`(() => { const panel = document.querySelector('.session-status__popover'); return { expanded: document.querySelector('.session-status__${kind}-trigger').getAttribute('aria-expanded'), focus: document.activeElement === document.querySelector('.session-status__${kind}-trigger'), inert: panel?.inert ?? false, hidden: panel?.getAttribute('aria-hidden') === 'true' }; })()`)
      expect(closedImmediately.expanded).toBe("false")
      expect(closedImmediately.focus).toBe(true)
      if (reduce) expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover') === null`)).toBe(true)
      else {
        expect(closedImmediately.inert).toBe(true)
        expect(closedImmediately.hidden).toBe(true)
        const leaving = await page.evaluate<{ duration: number; opacity: number; transform: string }>(`new Promise(resolve => setTimeout(() => requestAnimationFrame(() => { const style = getComputedStyle(document.querySelector('.session-status__popover')); resolve({ duration: parseFloat(style.animationDuration) * 1000, opacity: Number(style.opacity), transform: style.transform }); }), 70))`)
        expect(leaving.duration).toBe(220)
        expect(leaving.opacity).toBeLessThan(1)
        expect(leaving.transform).not.toBe("none")
        await page.evaluate(`Promise.all([...document.querySelector('.session-status__popover').getAnimations()].map(animation => animation.finished))`)
        expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover') === null`)).toBe(true)
      }
    } finally { await page.close() }
  }
}, 60_000)

test("switching autonomy panels enters the new content and reopening during exit cancels closure", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(390, 844)
    await page.setReducedMotion(false)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.session-status__yolo-trigger') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.session-status__yolo-trigger').click()`)
    await page.evaluate(`Promise.all([...document.querySelector('.session-status__popover').getAnimations()].map(animation => animation.finished))`)
    await page.evaluate(`document.querySelector('.session-status__goal-trigger').click()`)
    const switched = await page.evaluate<{ expanded: string; opacity: number; focused: boolean }>(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const panel = document.querySelector('.session-status__popover'); resolve({ expanded: document.querySelector('.session-status__goal-trigger').getAttribute('aria-expanded'), opacity: Number(getComputedStyle(panel).opacity), focused: panel.contains(document.activeElement) }); })))`)
    expect(switched.expanded).toBe("true")
    expect(switched.focused).toBe(true)
    expect(switched.opacity).toBeLessThan(1)
    await page.evaluate(`Promise.all([...document.querySelector('.session-status__popover').getAnimations()].map(animation => animation.finished))`)
    await page.pressEscape()
    await page.evaluate(`document.querySelector('.session-status__goal-trigger').click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__goal-trigger').getAttribute('aria-expanded') === 'true' && document.querySelector('.session-status__popover')?.inert === false`)).toBe(true)
    await Bun.sleep(260)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover') !== null && document.querySelector('.session-status__popover')?.inert === false`)).toBe(true)
    await page.evaluate(`document.querySelector('.session-status__goal-trigger').click(); document.querySelector('.session-status__goal-trigger').click()`)
    await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.session-status__goal-trigger').click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover')?.inert === true`)).toBe(true)
    await Bun.sleep(50)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover')?.inert === true`)).toBe(true)
  } finally { await page.close() }
}, 15_000)
