import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4327
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(browserPath, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Session lifecycle fixture did not start")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function open(view: "chat" | "sessions") {
  if (!browser) throw new Error("Browser missing")
  const page = await browser.openPage()
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=${view}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(view === "chat" ? ".composer__input:not([disabled])" : ".sessions-table__select:not([disabled])")}) !== null`)) return page
    await Bun.sleep(50)
  }
  await page.close()
  throw new Error(`Session fixture did not render ${view}`)
}

describe("remote session lifecycle", () => {
  test("opens a previous session directly from Sessions without submitting a prompt", async () => {
    const page = await open("sessions")
    try {
      await page.evaluate(`document.querySelector('.sessions-table__select')?.click()`)
      expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote")
      expect(await page.evaluate<boolean>(`document.querySelector('.app--conversation .composer__input') !== null`)).toBe(true)
      expect(await page.evaluate<unknown[]>(`window.remoteMutationReport()`)).toEqual([])
    } finally { await page.close() }
  })

  test("keeps a session draft when visiting Settings and returning to Conversation", async () => {
    const page = await open("chat")
    try {
      await page.evaluate(`(() => { const input = document.querySelector('.composer__input'); input.value = 'Keep this unsent prompt'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.remote-nav a[href="/remote/settings"]')?.click(); })()`)
      expect(await page.evaluate<boolean>(`document.querySelector('.app--settings') !== null`)).toBe(true)
      await page.evaluate(`document.querySelector('.remote-nav a[href="/remote"]')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("Keep this unsent prompt")
    } finally { await page.close() }
  })
})
