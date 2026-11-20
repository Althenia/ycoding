import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeBoolean, decodeNumber, decodeRecord, decodeString } from "./cdp"

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
      for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('.workspace__rail') !== null`); attempt += 1) await Bun.sleep(50)
      const collapse = `.workspace__rail .session-panel__collapse`
      const expand = `.workspace__rail-expand`
      expect(await page.evaluate(`document.querySelector('.app-header .app-header__menu') === null || getComputedStyle(document.querySelector('.app-header .app-header__menu')).display === 'none'`)).toBe(true)
      expect(await page.evaluate(`(() => { const button = document.querySelector(${JSON.stringify(collapse)}); return { label: button?.getAttribute('aria-label') ?? null, expanded: button?.getAttribute('aria-expanded') ?? null }; })()`)).toEqual({ label: "Hide workspace sidebar", expanded: "true" })
      expect(await page.evaluate(`document.querySelector(${JSON.stringify(collapse)})?.getBoundingClientRect().width >= 44 && document.querySelector(${JSON.stringify(collapse)})?.getBoundingClientRect().height >= 44`)).toBe(true)
      await page.evaluate(`document.querySelector(${JSON.stringify(collapse)})?.click()`)
      for (let attempt = 0; attempt < 30 && !await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72`); attempt += 1) await Bun.sleep(20)
      expect(await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72 && document.querySelector('.workspace__rail-body').getClientRects().length === 0 && document.querySelector('.workspace__main').getBoundingClientRect().width > innerWidth * .85`)).toBe(true)
      expect(await page.evaluate(`(() => { const button = document.querySelector(${JSON.stringify(expand)}); return { label: button?.getAttribute('aria-label') ?? null, expanded: button?.getAttribute('aria-expanded') ?? null, focused: button !== null && document.activeElement === button }; })()`)).toEqual({ label: "Show workspace sidebar", expanded: "false", focused: true })
      expect(await page.evaluate(`[...document.querySelectorAll(".activity-bar a")].filter(link => link.getBoundingClientRect().width >= 44 && link.getBoundingClientRect().height >= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-control-h-dense'))).map(link => new URL(link.href).pathname)`)).toEqual(["/remote/session", "/remote/sessions", "/remote/projects", "/remote/workspaces", "/remote/usage", "/remote/settings"])
      expect(await page.evaluate(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-control-h-dense')) >= 36`)).toBe(true)
      expect(await page.evaluate(`(() => {
        const rail = getComputedStyle(document.querySelector('.workspace__rail'));
        const active = getComputedStyle(document.querySelector('.activity-bar__item[aria-current="page"]'));
        const root = getComputedStyle(document.documentElement);
        const probe = document.createElement('span'); document.body.append(probe);
        probe.style.background = root.getPropertyValue('--yc-cobalt-tonal');
        const fill = getComputedStyle(probe).backgroundColor; probe.remove();
        return rail.borderInlineEndWidth === '0px' && active.backgroundColor === fill && active.boxShadow === 'none' && parseFloat(active.borderRadius) > 44;
      })()`)).toBe(true)
      for (let index = 0; index < 12; index += 1) {
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate(`document.querySelector('.workspace__rail-body').contains(document.activeElement)`)).toBe(false)
      }
      await page.navigate(url)
      for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('.workspace__rail') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72 && document.querySelector('.workspace__rail-body').getClientRects().length === 0 && document.querySelector(${JSON.stringify(expand)})?.getAttribute('aria-expanded') === 'false'`)).toBe(true)
      await page.evaluate(`document.querySelector(${JSON.stringify(expand)})?.click()`)
      for (let attempt = 0; attempt < 30 && !await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width >= 220`); attempt += 1) await Bun.sleep(20)
      expect(await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width >= 220 && document.querySelector(${JSON.stringify(expand)}) === null && document.activeElement === document.querySelector(${JSON.stringify(collapse)})`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("keeps the global rail and its six destinations visible from tablet width and lets it collapse and reopen", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(768, 900)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-768`)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await page.evaluate(`document.body.innerText.includes("Token expiry refactor")`)) break
      await Bun.sleep(100)
    }

    try {
      for (const width of [768, 1023, 1024, 1279, 1280, 1440] as const) {
        await page.setViewport(width, 900)
        const state = await page.evaluate(`(() => {
          const visible = element => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0;
          return {
            links: [...document.querySelectorAll(".activity-bar a")].filter(visible).map(link => link.textContent.trim()),
            railVisible: visible(document.querySelector(".workspace__rail")),
            toggleVisible: visible(document.querySelector(".app-header__menu")),
            brandWidth: document.querySelector('.app-header .brand')?.getBoundingClientRect().width ?? 0,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, links: (decodeArray(decodeString))(record["links"]), railVisible: (decodeBoolean)(record["railVisible"]), toggleVisible: (decodeBoolean)(record["toggleVisible"]), brandWidth: (decodeNumber)(record["brandWidth"]), overflow: (decodeBoolean)(record["overflow"]) } })
        expect(state.links).toEqual(["Chat", "Sessions", "Projects", "Workspaces", "Usage", "Settings"])
        expect(state.railVisible).toBe(true)
        expect(state.toggleVisible).toBe(false)
        expect(state.overflow).toBe(false)
      }

      for (const width of [768, 1024] as const) {
        await page.setViewport(width, 900)
        expect(await page.evaluate(`document.querySelector(".workspace__rail .session-panel__collapse")?.getAttribute("aria-label") ?? ""`)).toBe("Hide workspace sidebar")
        await page.evaluate(`document.querySelector(".workspace__rail .session-panel__collapse")?.click()`)
        for (let attempt = 0; attempt < 30 && !await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width <= 72 && document.querySelector('.workspace__rail-body').getClientRects().length === 0 && document.querySelector('.workspace__rail-expand')?.getAttribute('aria-label') === 'Show workspace sidebar'`)).toBe(true)
        expect(await page.evaluate(`document.querySelector(".conversation-breadcrumb strong")?.textContent?.trim() ?? ""`)).toBe("Token expiry refactor")
        expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)

        await page.evaluate(`document.querySelector(".workspace__rail-expand")?.click()`)
        for (let attempt = 0; attempt < 30 && !await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width >= 220`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate(`document.querySelector('.workspace__rail').getBoundingClientRect().width >= 220 && document.querySelector('.workspace__rail-body').getClientRects().length > 0`)).toBe(true)
      }
    } finally {
      await page.close()
    }
  }, 30_000)

  test("labels the compact routes clearly without clipping at phone widths", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-390`)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await page.evaluate(`document.body.innerText.includes("Token expiry refactor")`)) break
      await Bun.sleep(100)
    }

    try {
      for (const width of [320, 390] as const) {
        await page.setViewport(width, 844)
        const state = await page.evaluate(`(() => {
          const items = [...document.querySelectorAll(".bottom-nav__item")];
          return {
            labels: items.map(item => item.textContent.trim()),
            widths: items.map(item => item.getBoundingClientRect().width),
            heights: items.map(item => item.getBoundingClientRect().height),
            leading: items.map(item => getComputedStyle(item.querySelector('.bottom-nav__label')).lineHeight),
            expectedLeading: getComputedStyle(document.documentElement).getPropertyValue('--yc-leading-2xs').trim(),
            clipped: items.some(item => item.scrollWidth > item.clientWidth + 1),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, labels: (decodeArray(decodeString))(record["labels"]), widths: (decodeArray(decodeNumber))(record["widths"]), heights: (decodeArray(decodeNumber))(record["heights"]), leading: (decodeArray(decodeString))(record["leading"]), expectedLeading: (decodeString)(record["expectedLeading"]), clipped: (decodeBoolean)(record["clipped"]), overflow: (decodeBoolean)(record["overflow"]) } })
        expect(state.labels).toEqual(["Projects", "Sessions", "Workspaces", "Usage", "Settings"])
        expect(state.widths.every((width) => width >= 44)).toBe(true)
        expect(Math.max(...state.widths) - Math.min(...state.widths)).toBeLessThanOrEqual(1)
        expect(state.heights.every((height) => height >= 44)).toBe(true)
        expect(state.leading).toEqual(Array(5).fill(state.expectedLeading))
        expect(state.expectedLeading).toBe("16px")
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
      if (await page.evaluate(`document.body.innerText.includes("Appearance")`)) break
      await Bun.sleep(100)
    }

    try {
      expect(await page.evaluate(`(() => {
        const toggle = document.querySelector(".app-header__menu");
        return toggle instanceof HTMLElement && getComputedStyle(toggle).display !== "none" && toggle.getBoundingClientRect().width > 0;
      })()`)).toBe(false)
      expect(await page.evaluate(`document.querySelector(".workspace__rail")?.getBoundingClientRect().width > 0`)).toBe(true)
      expect(await page.evaluate(`[...document.querySelectorAll(".activity-bar a")].filter(link => link.getBoundingClientRect().width > 0).map(link => link.textContent.trim())`)).toEqual(["Chat", "Sessions", "Projects", "Workspaces", "Usage", "Settings"])
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
