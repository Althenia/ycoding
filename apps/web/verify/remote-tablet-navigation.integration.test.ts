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
  test("keeps route navigation visible and lets the selected conversation rail collapse and reopen", async () => {
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
          readonly toggleHeight: number
          readonly toggleWidth: number
          readonly brandWidth: number
          readonly overflow: boolean
        }>(`(() => {
          const visible = element => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0;
          const rail = document.querySelector(".workspace__rail");
          const toggle = document.querySelector(".app-header__menu");
          return {
            links: [...document.querySelectorAll(".remote-nav a")].filter(visible).map(link => link.textContent.trim()),
            railVisible: visible(rail),
            toggleVisible: visible(toggle),
            toggleHeight: toggle instanceof HTMLElement ? toggle.getBoundingClientRect().height : 0,
            toggleWidth: toggle instanceof HTMLElement ? toggle.getBoundingClientRect().width : 0,
            brandWidth: document.querySelector('.app-header .brand')?.getBoundingClientRect().width ?? 0,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        })()`)
        expect(state.links).toEqual(["Sessions", "Conversation", "Activity", "Settings"])
        expect(state.railVisible).toBe(true)
        expect(state.toggleVisible).toBe(width < 1024)
        if (state.toggleVisible) {
          expect(state.toggleHeight).toBeGreaterThanOrEqual(44)
          expect(state.toggleWidth).toBeGreaterThanOrEqual(44)
          expect(state.brandWidth).toBeGreaterThanOrEqual(44)
        }
        expect(state.overflow).toBe(false)
      }

      await page.setViewport(768, 900)
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await page.evaluate<string>(`document.querySelector(".app-header__menu")?.getAttribute("aria-label") ?? ""`) === "Hide sessions sidebar") break
        await Bun.sleep(10)
      }
      expect(await page.evaluate<{ readonly label: string | null; readonly expanded: string | null; readonly controls: string | null }>(`(() => {
        const toggle = document.querySelector(".app-header__menu");
        return { label: toggle?.getAttribute("aria-label") ?? null, expanded: toggle?.getAttribute("aria-expanded") ?? null, controls: toggle?.getAttribute("aria-controls") ?? null };
      })()`)).toEqual({ label: "Hide sessions sidebar", expanded: "true", controls: "session-rail" })
      await page.setViewport(1024, 900)
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await page.evaluate<string>(`document.querySelector(".app-header__menu")?.getAttribute("aria-label") ?? ""`) === "Open sessions") break
        await Bun.sleep(10)
      }
      expect(await page.evaluate<{ readonly label: string | null; readonly expanded: string | null; readonly controls: string | null }>(`(() => {
        const toggle = document.querySelector(".app-header__menu");
        return { label: toggle?.getAttribute("aria-label") ?? null, expanded: toggle?.getAttribute("aria-expanded") ?? null, controls: toggle?.getAttribute("aria-controls") ?? null };
      })()`)).toEqual({ label: "Open sessions", expanded: "false", controls: null })
      await page.setViewport(768, 900)
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await page.evaluate<string>(`document.querySelector(".app-header__menu")?.getAttribute("aria-label") ?? ""`) === "Hide sessions sidebar") break
        await Bun.sleep(10)
      }
      expect(await page.evaluate<string>(`document.querySelector(".app-header__menu")?.getAttribute("aria-label") ?? ""`)).toBe("Hide sessions sidebar")
      await page.evaluate(`document.querySelector(".app-header__menu")?.click()`)
      expect(await page.evaluate<boolean>(`getComputedStyle(document.querySelector(".workspace__rail")).display === "none"`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector(".conversation-breadcrumb strong")?.textContent?.trim() ?? ""`)).toBe("Token expiry refactor")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)

      await page.evaluate(`document.querySelector(".app-header__menu")?.click()`)
      expect(await page.evaluate<boolean>(`getComputedStyle(document.querySelector(".workspace__rail")).display !== "none"`)).toBe(true)
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
          readonly heights: readonly number[]
          readonly clipped: boolean
          readonly overflow: boolean
        }>(`(() => {
          const items = [...document.querySelectorAll(".bottom-nav__item")];
          return {
            labels: items.map(item => item.textContent.trim()),
            heights: items.map(item => item.getBoundingClientRect().height),
            clipped: items.some(item => item.scrollWidth > item.clientWidth + 1),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        })()`)
        expect(state.labels).toEqual(["Sessions", "Conversation", "Activity", "Settings"])
        expect(state.heights.every((height) => height >= 44)).toBe(true)
        expect(state.clipped).toBe(false)
        expect(state.overflow).toBe(false)
      }
    } finally {
      await page.close()
    }
  }, 30_000)

  test("does not expose a tablet rail toggle on routes without a session rail", async () => {
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
      expect(await page.evaluate<boolean>(`document.querySelector(".workspace__rail") === null`)).toBe(true)
      expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll(".remote-nav a")].filter(link => link.getBoundingClientRect().width > 0).map(link => link.textContent.trim())`)).toEqual(["Sessions", "Conversation", "Activity", "Settings"])
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
