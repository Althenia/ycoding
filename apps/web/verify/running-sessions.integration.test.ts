import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4395
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Running Sessions fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

describe("running Sessions across workspaces", () => {
  test("renders only populated roots with workspace labels and usable focus and selection", async () => {
    if (!browser) throw new Error("Browser not started")
    for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"] as const) {
      const page = await browser.openPage()
      try {
        await page.setViewport(width, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?theme=${theme}`)
        for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 2; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ heading: string; labels: readonly string[]; overflow: boolean; targets: boolean }>(`({ heading: document.querySelector('.running-sessions h2')?.textContent.trim(),
          labels: [...document.querySelectorAll('.running-sessions__item')].map((button) => button.getAttribute('aria-label')),
          overflow: document.documentElement.scrollWidth > innerWidth,
          targets: [...document.querySelectorAll('.running-sessions__item')].every((button) => button.getBoundingClientRect().height >= 44) })`))
          .toEqual({ heading: "Running across workspaces", labels: ["Open Review test coverage in Alpha", "Open Debug remote response in Beta"], overflow: false, targets: true })
        await page.evaluate(`document.querySelector('.running-sessions__item').focus()`)
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.running-sessions__item') && getComputedStyle(document.activeElement).outlineStyle !== 'none'`)).toBe(true)
        await page.pressKey(" ", "Space", 32)
        expect(await page.evaluate<string[]>(`window.runningSelected()`)).toEqual(["ses_alpha"])
      } finally { await page.close() }
    }
    const empty = await browser.openPage()
    try {
      await empty.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?empty`)
      for (let attempt = 0; attempt < 40 && !(await empty.evaluate<boolean>(`document.querySelector('[data-running-fixture]') !== null`)); attempt += 1) await Bun.sleep(50)
      expect(await empty.evaluate<boolean>(`document.querySelector('[data-running-fixture]') !== null`)).toBe(true)
      expect(await empty.evaluate<boolean>(`document.querySelector('.running-sessions') === null`)).toBe(true)
    } finally { await empty.close() }
  }, 20_000)
})
