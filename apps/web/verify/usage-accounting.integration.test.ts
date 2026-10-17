import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchBrowser } from "./cdp"

const port = 4669
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let captures = ""
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60; index++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/usage-accounting-fixture.html`).then((response) => response.ok, () => false)) break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(browserPath, 1440, 900)
  captures = await mkdtemp(join(tmpdir(), "usage-accounting-"))
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("cost, measured coverage and per-window forecasts reflow with keyboard disclosures in both themes and motion modes", async () => {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) for (const reduced of [false, true]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-accounting-fixture.html`)
      for (let index = 0; index < 100; index++) {
        if (await page.evaluate<boolean>(`!!document.querySelector('.usage-unit-cost')`)) break
        await Bun.sleep(20)
      }
      await page.evaluate(`document.fonts.ready`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await page.evaluate(`document.querySelector('[aria-label="Usage range"]').focus()`)
      await page.pressKey("Enter", "Enter", 13)
      await wait(page, `!!document.querySelector('[role="listbox"][aria-label="Usage range"]')`)
      if (width < 768) await page.evaluate(`document.querySelector('[role="listbox"][aria-label="Usage range"]').focus()`)
      await page.pressKey("Home", "Home", 36)
      await page.pressKey("Enter", "Enter", 13)
      if (width < 768) {
        await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('Confirm Selection'))?.focus()`)
        await page.pressKey("Enter", "Enter", 13, "\r")
      }
      await wait(page, `document.querySelector('[role="status"]').textContent === 'Selected range: last7'`)
      await wait(page, `!document.querySelector('.custom-select__dialog')`)
      await wait(page, `!document.querySelector('.custom-select__surface')`)
      expect(await page.evaluate<string>(`document.querySelector('[role="status"]').textContent`)).toBe("Selected range: last7")
      expect(await page.evaluate<string>(`document.body.innerText`)).toContain("so far · incomplete")
      expect(await page.evaluate<string>(`document.body.innerText`)).not.toContain("Warming up after restart")
      expect(await page.evaluate<string>(`document.body.innerText`)).not.toContain("half-life")
      await page.evaluate(`document.querySelector('.usage-unit-cost summary').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      for (let index = 0; index < 100 && !await page.evaluate<boolean>(`document.querySelector('.usage-unit-cost details').open`); index++) await Bun.sleep(20)
      expect(await page.evaluate<boolean>(`document.querySelector('.usage-unit-cost details').open`)).toBe(true)
      expect(await page.evaluate<string>(`document.body.innerText`)).toContain("Decision unreported")
      expect(await page.evaluate<string>(`document.body.innerText`)).toContain("Main $0.00 · Children Known $2.00 + unreported")
      await page.evaluate(`document.querySelector('.usage-statistics-details summary').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      for (let index = 0; index < 100 && !await page.evaluate<boolean>(`document.querySelector('.usage-statistics-details').open`); index++) await Bun.sleep(20)
      const text = await page.evaluate<string>(`document.body.innerText`)
      expect(text).toContain("median 20 tok/s · p90 50 tok/s")
      expect(text).toContain("4 measured requests · 1 provider-timed · 3 observed")
      expect(text).toContain("Cache read 400 · Cache write 50")
      expect(text).toContain("Estimated · projected 60 percentage points at reset · medium evidence")
      expect(text).toContain("Forecast unavailable")
      expect(text).not.toContain("Quota burn")
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.usage-statistics-details summary')`)).toBe(true)
      await page.evaluate(`document.querySelector('button[aria-label="Allowances details"]').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `document.querySelector('dialog.overlay--usage-details[open][aria-label="Allowances details"]') !== null`)
      const allowances = await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-details[open] .overlay__body')?.innerText ?? ''`)
      expect(allowances).toContain("Quota burn 10 percentage points/hour")
      expect(allowances).toContain("Recent quota deltas · 15m half-life · 1h horizon · medium evidence")
      expect(allowances).toContain("Reason: Warming up after restart")
      await page.pressEscape()
      await wait(page, `document.querySelector('dialog.overlay--usage-details') === null`)
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('button[aria-label="Allowances details"]')`)).toBe(true)
      await page.evaluate(`document.querySelector('button[aria-label="Recorded rate details"]').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `document.querySelector('dialog.overlay--usage-details[open][aria-label="Recorded rate details"]') !== null`)
      const recorded = await page.evaluate<string>(`document.querySelector('dialog.overlay--usage-details[open] .overlay__body')?.innerText ?? ''`)
      expect(recorded).toContain("Rate 12,345.678 tokens/min")
      expect(recorded).toContain("4 priced · 1 unpriced")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)).toBe(false)
      await page.pressEscape()
      await wait(page, `document.querySelector('dialog.overlay--usage-details') === null`)
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('button[aria-label="Recorded rate details"]')`)).toBe(true)
      await page.evaluate(`document.querySelector('[aria-label="Recursive task cost"] summary').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `document.querySelector('[aria-label="Recursive task cost"]').open`)
      expect(await page.evaluate<string>(`document.body.innerText`)).toContain("Inclusive task rows overlap; do not add them for a family total.")
      await Bun.write(join(captures, `usage-accounting-task-${width}-${theme}-${reduced ? "reduced" : "normal"}.png`), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`window.scrollTo(0, 0)`)
      await Bun.write(join(captures, `usage-accounting-${width}-${theme}-${reduced ? "reduced" : "normal"}.png`), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`document.querySelector('.usage-quota-forecast').scrollIntoView()`)
      await Bun.write(join(captures, `usage-accounting-forecast-${width}-${theme}-${reduced ? "reduced" : "normal"}.png`), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 90_000)

async function wait(page: Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>, expression: string) {
  for (let index = 0; index < 100; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(20)
  }
  throw new Error(`Accounting fixture did not settle: ${expression}`)
}
