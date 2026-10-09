import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4211
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
  browser = await launchBrowser(browserPath, 768, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("tablet remote navigation", () => {
  test("collapses the global workspace rail to a narrow expand rail, expands it there, and remembers the choice after reload", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      const url = `http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-1440`
      await page.navigate(url)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail') !== null`); attempt += 1) await Bun.sleep(50)
      const collapse = `.workspace__rail .session-panel__collapse`
      const expand = `.workspace__rail-expand`
      expect(await page.evaluate<boolean>(`document.querySelector('.app-header .app-header__menu') === null || getComputedStyle(document.querySelector('.app-header .app-header__menu')).display === 'none'`)).toBe(true)
      expect(await page.evaluate<{ readonly label: string | null; readonly expanded: string | null }>(`(() => { const button = document.querySelector(${JSON.stringify(collapse)}); return { label: button?.getAttribute('aria-label') ?? null, expanded: button?.getAttribute('aria-expanded') ?? null }; })()`)).toEqual({ label: "Hide workspace sidebar", expanded: "true" })
      expect(await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(collapse)})?.getBoundingClientRect().width >= 44 && document.querySelector(${JSON.stringify(collapse)})?.getBoundingClientRect().height >= 44`)).toBe(true)
      await page.evaluate(`document.querySelector(${JSON.stringify(collapse)})?.click()`)
      for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72`); attempt += 1) await Bun.sleep(20)
      expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72 && document.querySelector('.workspace__rail-body').getClientRects().length === 0 && document.querySelector('.workspace__main').getBoundingClientRect().width > innerWidth * .85`)).toBe(true)
      expect(await page.evaluate<{ readonly label: string | null; readonly expanded: string | null; readonly focused: boolean }>(`(() => { const button = document.querySelector(${JSON.stringify(expand)}); return { label: button?.getAttribute('aria-label') ?? null, expanded: button?.getAttribute('aria-expanded') ?? null, focused: button !== null && document.activeElement === button }; })()`)).toEqual({ label: "Show workspace sidebar", expanded: "false", focused: true })
      expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll(".workspace__rail .remote-nav a")].filter(link => link.getBoundingClientRect().width >= 44 && link.getBoundingClientRect().height >= 44).map(link => link.getAttribute("href"))`)).toEqual(["/remote/sessions", "/remote/usage", "/remote/settings"])
      for (let index = 0; index < 12; index += 1) {
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail-body').contains(document.activeElement)`)).toBe(false)
      }
      await page.navigate(url)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72 && document.querySelector('.workspace__rail-body').getClientRects().length === 0 && document.querySelector(${JSON.stringify(expand)})?.getAttribute('aria-expanded') === 'false'`)).toBe(true)
      await page.evaluate(`document.querySelector(${JSON.stringify(expand)})?.click()`)
      for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width >= 220`); attempt += 1) await Bun.sleep(20)
      expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width >= 220 && document.querySelector(${JSON.stringify(expand)}) === null && document.activeElement === document.querySelector(${JSON.stringify(collapse)})`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("keeps the global rail and its three destinations visible from tablet width and lets it collapse and reopen", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 900)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-768`)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await page.evaluate<boolean>(`document.body.innerText.includes("Token expiry refactor")`)) break
      await Bun.sleep(100)
    }

    try {
      for (const width of [768, 1023, 1024, 1279, 1280, 1440] as const) {
        await page.setViewport(width, 900)
        const state = await page.evaluate<{
          readonly links: readonly string[]
          readonly railVisible: boolean
          readonly toggleVisible: boolean
          readonly brandWidth: number
          readonly overflow: boolean
        }>(`(() => {
          const visible = element => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0;
          return {
            links: [...document.querySelectorAll(".remote-nav a")].filter(visible).map(link => link.textContent.trim()),
            railVisible: visible(document.querySelector(".workspace__rail")),
            toggleVisible: visible(document.querySelector(".app-header__menu")),
            brandWidth: document.querySelector('.app-header .brand')?.getBoundingClientRect().width ?? 0,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        })()`)
        expect(state.links).toEqual(["Sessions", "Usage", "Settings"])
        expect(state.railVisible).toBe(true)
        expect(state.toggleVisible).toBe(false)
        expect(state.overflow).toBe(false)
      }

      for (const width of [768, 1024] as const) {
        await page.setViewport(width, 900)
        expect(await page.evaluate<string>(`document.querySelector(".workspace__rail .session-panel__collapse")?.getAttribute("aria-label") ?? ""`)).toBe("Hide workspace sidebar")
        await page.evaluate(`document.querySelector(".workspace__rail .session-panel__collapse")?.click()`)
        for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72 && document.querySelector('.workspace__rail-body').getClientRects().length === 0 && document.querySelector('.workspace__rail-expand')?.getAttribute('aria-label') === 'Show workspace sidebar'`)).toBe(true)
        expect(await page.evaluate<string>(`document.querySelector(".conversation-breadcrumb strong")?.textContent?.trim() ?? ""`)).toBe("Token expiry refactor")
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)

        await page.evaluate(`document.querySelector(".workspace__rail-expand")?.click()`)
        for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width >= 220`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail').getBoundingClientRect().width >= 220 && document.querySelector('.workspace__rail-body').getClientRects().length > 0`)).toBe(true)
      }
    } finally {
      await page.close()
    }
  }, 30_000)

  test("labels the compact routes clearly without clipping at phone widths", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-390`)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await page.evaluate<boolean>(`document.body.innerText.includes("Token expiry refactor")`)) break
      await Bun.sleep(100)
    }

    try {
      for (const width of [320, 390] as const) {
        await page.setViewport(width, 844)
        const state = await page.evaluate<{
          readonly labels: readonly string[]
          readonly widths: readonly number[]
          readonly heights: readonly number[]
          readonly clipped: boolean
          readonly overflow: boolean
        }>(`(() => {
          const items = [...document.querySelectorAll(".bottom-nav__item")];
          return {
            labels: items.map(item => item.textContent.trim()),
            widths: items.map(item => item.getBoundingClientRect().width),
            heights: items.map(item => item.getBoundingClientRect().height),
            clipped: items.some(item => item.scrollWidth > item.clientWidth + 1),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        })()`)
        expect(state.labels).toEqual(["Sessions", "Usage", "Settings"])
        expect(state.widths.every((width) => width >= 44)).toBe(true)
        expect(Math.max(...state.widths) - Math.min(...state.widths)).toBeLessThanOrEqual(1)
        expect(state.heights.every((height) => height >= 44)).toBe(true)
        expect(state.clipped).toBe(false)
        expect(state.overflow).toBe(false)
      }
    } finally {
      await page.close()
    }
  }, 30_000)

  test("shows the global rail without a header toggle on routes that show no conversation", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 900)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=autonomy-goal-notification-settings-768`)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await page.evaluate<boolean>(`document.body.innerText.includes("Appearance")`)) break
      await Bun.sleep(100)
    }

    try {
      expect(await page.evaluate<boolean>(`(() => {
        const toggle = document.querySelector(".app-header__menu");
        return toggle instanceof HTMLElement && getComputedStyle(toggle).display !== "none" && toggle.getBoundingClientRect().width > 0;
      })()`)).toBe(false)
      expect(await page.evaluate<boolean>(`document.querySelector(".workspace__rail")?.getBoundingClientRect().width > 0`)).toBe(true)
      expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll(".remote-nav a")].filter(link => link.getBoundingClientRect().width > 0).map(link => link.textContent.trim())`)).toEqual(["Sessions", "Usage", "Settings"])
    } finally {
      await page.close()
    }
  }, 30_000)
})

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
