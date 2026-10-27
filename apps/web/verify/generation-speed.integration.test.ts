import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4465
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/generation-speed.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Generation fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("subagent speed renders from its own samples at phone and desktop widths", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]] as const) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      await page.setCoarsePointer(width === 390)
      await page.navigate(`http://127.0.0.1:${port}/verify/generation-speed.html`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`typeof window.generationSet === 'function'`); attempt++) await Bun.sleep(25)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      expect(await page.evaluate<boolean>(`document.querySelector('.subagent-bar').textContent.includes('tok/s')`)).toBe(false)
      await page.evaluate(`window.generationSet('estimated')`)
      expect(await page.evaluate<string>(`document.querySelector('.subagent-bar__header').textContent`)).toContain("≈ 100 tok/s")
      expect(await page.evaluate<boolean>(`(() => { const speed = document.querySelector('.subagent-bar__speed'), bar = document.querySelector('.subagent-bar'); return speed.scrollWidth <= speed.clientWidth && speed.getBoundingClientRect().right <= bar.getBoundingClientRect().right })()`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      await page.evaluate(`document.querySelector('[aria-label="Subagent details"]').click()`)
      expect(await page.evaluate<string>(`document.querySelector('[data-metric="speed"]').textContent`)).toContain("≈ 100 tok/s")
      await page.pressEscape()
      await page.evaluate(`window.generationSet('measured')`)
      expect(await page.evaluate<string>(`document.querySelector('.subagent-bar__header').textContent`)).toContain("100 tok/s")
      expect(await page.evaluate<string>(`document.querySelector('.subagent-bar__header').textContent`)).not.toContain("≈")
      await page.evaluate(`window.generationSet('insufficient')`)
      expect(await page.evaluate<boolean>(`document.querySelector('.subagent-bar__header').textContent.includes('tok/s')`)).toBe(false)
      await page.evaluate(`window.generationSet('live')`)
      expect(await page.evaluate<string>(`document.querySelector('.subagent-bar__header').textContent`)).toContain("≈ 150 tok/s")
      await page.evaluate(`document.querySelector('[aria-label="Subagent details"]').click()`)
      expect(await page.evaluate<string>(`document.querySelector('[data-metric="speed"]').textContent`)).toContain("≈ 150 tok/s")
      await page.evaluate(`window.generationSet('insufficient')`)
      expect(await page.evaluate<boolean>(`document.querySelector('[data-metric="speed"]') === null`)).toBe(true)
      await page.evaluate(`window.generationSet('measured')`)
      expect(await page.evaluate<string>(`document.querySelector('[data-metric="speed"]').textContent`)).toContain("100 tok/s")
      expect(await page.evaluate<string>(`document.querySelector('.subagent-bar__header').textContent`)).toContain("100 tok/s")
    } finally { await page.close() }
  }
}, 30_000)
