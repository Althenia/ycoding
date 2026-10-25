import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4617
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
const finishGoalMotion = `(async () => { const animations = document.querySelector('.session-status__popover').getAnimations(); await Promise.all(animations.map(animation => animation.ready)); animations.forEach(animation => animation.finish()); await Promise.all(animations.map(animation => animation.finished)); await new Promise(resolve => requestAnimationFrame(resolve)); })()`

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

test("the Goal panel enters and leave over frames while restoring focus immediately", async () => {
  for (const [width, height] of [[820, 1180], [1440, 900]]) for (const theme of ["light", "dark"] as const) for (const reduce of [false, true]) for (const kind of ["goal"] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.setReducedMotion(reduce)
      await page.setAnimationPlaybackRate(0)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.session-status__${kind}-trigger') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.querySelector('.session-status__${kind}-trigger').click()`)
      const entering = await page.evaluate<{ duration: number; opacity: number; transform: string; focusInside: boolean; animations: number; name: string | null; time: number | null; present: boolean }>(sampleGoalMotion(reduce ? null : "session-status-goal-in"))
      expect(entering.focusInside).toBe(true)
      if (reduce) expect(entering).toMatchObject({ duration: 0, opacity: 1, transform: "none", animations: 0, present: true })
      else {
        expect(entering).toMatchObject({ animations: 1, name: "session-status-goal-in", time: 110, present: true })
        expect(entering.duration).toBe(220)
        expect(entering.opacity).toBeGreaterThan(0)
        expect(entering.opacity).toBeLessThan(1)
        expect(entering.transform).not.toBe("none")
      }
      await page.evaluate(finishGoalMotion)
      await page.pressEscape()
      const closedImmediately = await page.evaluate<{ expanded: string; focus: boolean; inert: boolean; hidden: boolean }>(`(() => { const panel = document.querySelector('.session-status__popover'); return { expanded: document.querySelector('.session-status__${kind}-trigger').getAttribute('aria-expanded'), focus: document.activeElement === document.querySelector('.session-status__${kind}-trigger'), inert: panel?.inert ?? false, hidden: panel?.getAttribute('aria-hidden') === 'true' }; })()`)
      expect(closedImmediately.expanded).toBe("false")
      expect(closedImmediately.focus).toBe(true)
      if (reduce) expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover') === null`)).toBe(true)
      else {
        expect(closedImmediately.inert).toBe(true)
        expect(closedImmediately.hidden).toBe(true)
        const leaving = await page.evaluate<{ duration: number; opacity: number; transform: string; animations: number; name: string; time: number; present: boolean }>(sampleGoalMotion("session-status-out"))
        expect(leaving).toMatchObject({ animations: 1, name: "session-status-out", time: 110, present: true })
        expect(leaving.duration).toBe(220)
        expect(leaving.opacity).toBeGreaterThan(0)
        expect(leaving.opacity).toBeLessThan(1)
        expect(leaving.transform).not.toBe("none")
        await page.evaluate(finishGoalMotion)
        expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover') === null`)).toBe(true)
      }
    } finally { await page.close() }
  }
}, 60_000)

test("reopening the Goal panel during exit cancels closure", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.setReducedMotion(false)
    await page.setAnimationPlaybackRate(0)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.session-status__goal-trigger') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.session-status__goal-trigger').click()`)
    await page.evaluate(finishGoalMotion)
    await page.pressEscape()
    await page.evaluate(sampleGoalMotion("session-status-out"))
    expect(await page.evaluate<boolean>(`(async () => {
      const panel = document.querySelector('.session-status__popover'), animation = panel.getAnimations().find(animation => animation.animationName === 'session-status-out');
      const cancelled = animation.finished.then(() => false, () => true);
      document.querySelector('.session-status__goal-trigger').click(); getComputedStyle(panel).animationName;
      return await cancelled;
    })()`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__goal-trigger').getAttribute('aria-expanded') === 'true' && document.querySelector('.session-status__popover')?.inert === false`)).toBe(true)
    await page.evaluate(finishGoalMotion)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover') !== null && document.querySelector('.session-status__popover')?.inert === false`)).toBe(true)
    await page.evaluate(`document.querySelector('.session-status__goal-trigger').click(); document.querySelector('.session-status__goal-trigger').click()`)
    await page.evaluate(sampleGoalMotion("session-status-goal-in"))
    await page.evaluate(`document.querySelector('.session-status__goal-trigger').click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover')?.inert === true`)).toBe(true)
    await page.evaluate(sampleGoalMotion("session-status-out"))
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover')?.inert === true`)).toBe(true)
    await page.evaluate(finishGoalMotion)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__popover') === null`)).toBe(true)
  } finally { await page.close() }
}, 15_000)

function sampleGoalMotion(name: "session-status-goal-in" | "session-status-out" | null) {
  return `(async () => {
    const panel = document.querySelector('.session-status__popover'), expected = ${JSON.stringify(name)}, animations = panel.getAnimations();
    const animation = animations.find(animation => animation instanceof CSSAnimation && animation.animationName === expected);
    if (expected) {
      if (!animation) throw new Error('Missing Goal animation: ' + expected);
      animation.pause(); await animation.ready; animation.currentTime = 110;
    }
    const style = getComputedStyle(panel);
    return { duration:parseFloat(style.animationDuration) * 1000, opacity:Number(style.opacity), transform:style.transform,
      focusInside:panel.contains(document.activeElement), animations:animations.length, name:animation?.animationName ?? null, time:animation?.currentTime ?? null, present:panel.isConnected };
  })()`
}
