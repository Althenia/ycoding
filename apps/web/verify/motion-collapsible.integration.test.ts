import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 5183
const url = `http://127.0.0.1:${port}/verify/motion-collapsible-fixture.html`
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore" })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(url).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Motion fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

const state = `(() => {
  const panel = document.getElementById('panel')
  const style = getComputedStyle(panel)
  return {
    open: panel.hasAttribute('data-open'),
    inert: panel.inert,
    ariaHidden: panel.getAttribute('aria-hidden'),
    opacity: Number(style.opacity),
    height: panel.getBoundingClientRect().height,
    belowTop: document.getElementById('below').getBoundingClientRect().top,
    mounted: document.getElementById('body') !== null,
    mounts: window.__mounts,
  }
})()`

type Snapshot = { readonly open: boolean; readonly inert: boolean; readonly ariaHidden: string | null; readonly opacity: number; readonly height: number; readonly belowTop: number; readonly mounted: boolean; readonly mounts: number }

async function ready(page: Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>) {
  await page.navigate(url)
  for (let attempt = 0; attempt < 100 && !await page.evaluate<boolean>(`document.getElementById('toggle') !== null`); attempt += 1) await Bun.sleep(50)
  await Bun.sleep(400)
}

test("expanding animates height and opacity so content below slides, and a collapse keeps the children mounted", async () => {
  const page = await browser!.openPage()
  try {
    await ready(page)
    const closed = await page.evaluate<Snapshot>(state)
    expect(closed).toMatchObject({ open: false, inert: true, ariaHidden: "true", opacity: 0, height: 0, mounted: false, mounts: 0 })
    await page.evaluate(`document.getElementById('toggle').click()`)
    await Bun.sleep(90)
    const middle = await page.evaluate<Snapshot>(state)
    expect(middle.open).toBe(true)
    expect(middle.height).toBeGreaterThan(0)
    expect(middle.belowTop).toBeGreaterThan(closed.belowTop)
    expect(middle.opacity).toBeGreaterThan(0)
    await Bun.sleep(500)
    const opened = await page.evaluate<Snapshot>(state)
    expect(opened).toMatchObject({ open: true, inert: false, ariaHidden: null, opacity: 1, mounted: true, mounts: 1 })
    expect(opened.height).toBeGreaterThanOrEqual(120)
    expect(middle.height).toBeLessThan(opened.height)
    expect(middle.belowTop).toBeLessThan(opened.belowTop)
    await page.evaluate(`document.getElementById('toggle').click()`)
    await Bun.sleep(600)
    const collapsed = await page.evaluate<Snapshot>(state)
    expect(collapsed).toMatchObject({ open: false, inert: true, ariaHidden: "true", opacity: 0, height: 0, mounted: true, mounts: 1 })
    expect(collapsed.belowTop).toBe(closed.belowTop)
  } finally { await page.close() }
})

test("reduced motion makes the expand instant, keeps a crossfade at or under 150ms and removes entrance travel", async () => {
  const page = await browser!.openPage()
  try {
    await page.setReducedMotion(true)
    await ready(page)
    const timing = await page.evaluate<{ readonly panel: string; readonly properties: string; readonly enter: string; readonly enterName: string }>(`(() => {
      const panel = getComputedStyle(document.getElementById('panel'))
      const enter = getComputedStyle(document.getElementById('below'))
      return { panel: panel.transitionDuration, properties: panel.transitionProperty, enter: enter.animationDuration, enterName: enter.animationName }
    })()`)
    expect(timing.properties).toBe("grid-template-rows, opacity")
    expect(timing.panel).toBe("0s, 0.08s")
    expect(timing.enterName).toBe("yc-motion-fade, yc-motion-rise")
    expect(timing.enter).toBe("0.08s, 0s")
    const closed = await page.evaluate<Snapshot>(state)
    await page.evaluate(`document.getElementById('toggle').click()`)
    await Bun.sleep(40)
    const opened = await page.evaluate<Snapshot>(state)
    expect(opened.height).toBeGreaterThanOrEqual(120)
    expect(opened.belowTop - closed.belowTop).toBe(opened.height)
    await Bun.sleep(200)
    expect((await page.evaluate<Snapshot>(state)).opacity).toBe(1)
  } finally { await page.close() }
})
