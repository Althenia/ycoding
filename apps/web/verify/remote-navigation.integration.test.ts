import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { launchBrowser } from "./cdp"

const port = 4231
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

const captures = new URL("../../../.cache/tmp/remote-navigation/", import.meta.url).pathname
const viewports = [[390, 844], [820, 1180], [1024, 768], [1440, 900]] as const
const themes = ["light", "dark"] as const

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  mkdirSync(captures, { recursive: true })
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the remote fixture server")
  browser = await launchBrowser(browserPath, 1440, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("remote navigation", () => {
  test("lists workspaces by name in a sidebar, root Sessions only, and no native select", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const theme of themes) {
        for (const [width, height] of viewports) {
          await page.setViewport(width, height)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&workspaces=many&theme=${theme}`)
          await until(page, `document.querySelectorAll(".sessions-table__name").length > 0`)
          const report = await page.evaluate<{
            readonly navVisible: boolean
            readonly compactVisible: boolean
            readonly labels: readonly string[]
            readonly active: string | null
            readonly title: string | undefined
            readonly hashes: boolean
            readonly nativeSelects: number
            readonly overflow: boolean
            readonly rows: readonly string[]
          }>(`(() => {
            const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0
            return {
              navVisible: visible(document.querySelector(".workspace-nav")),
              compactVisible: visible(document.querySelector(".sessions-page__workspace-select")),
              labels: [...document.querySelectorAll(".workspace-nav__label")].map((label) => label.textContent.trim()),
              active: document.querySelector('.workspace-nav__item[aria-current="true"] .workspace-nav__label')?.textContent.trim() ?? null,
              title: document.querySelector(".sessions-page__title")?.textContent.trim(),
              hashes: /[0-9a-f]{40}/.test(document.body.innerText),
              nativeSelects: document.querySelectorAll("select").length,
              overflow: document.documentElement.scrollWidth > innerWidth,
              rows: [...document.querySelectorAll(".sessions-table__name")].map((name) => name.textContent.trim()),
            }
          })()`)
          expect(report.navVisible).toBe(width >= 768)
          expect(report.compactVisible).toBe(width < 768)
          expect(report.labels).toEqual(["ycoding (workspace)", ".agents", "office", "ycoding (Archive)", "llama-cpp-proxy-with-a-long-repository-name"])
          expect(report.active).toBe("ycoding (workspace)")
          expect(report.title).toBe("ycoding (workspace)")
          expect(report.hashes).toBe(false)
          expect(report.nativeSelects).toBe(0)
          expect(report.overflow).toBe(false)
          expect(report.rows).toContain("Stream remote output safely")
          expect(report.rows).not.toContain("Child: fix flaky suite")
          await capture(page, `sessions-${width}-${theme}`)
        }
      }

      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&workspaces=many&theme=dark`)
      await until(page, `document.querySelectorAll(".workspace-nav__item").length === 5 && document.querySelectorAll(".sessions-table__name").length > 0`)
      await page.evaluate(`[...document.querySelectorAll(".workspace-nav__item")].find((item) => item.textContent.trim() === ".agents").click()`)
      await until(page, `document.querySelector(".sessions-page__title")?.textContent.trim() === ".agents"`)
      expect(await page.evaluate<string | null>(`document.querySelector('.workspace-nav__item[aria-current="true"]')?.textContent.trim() ?? null`)).toBe(".agents")
    } finally {
      await page.close()
    }
  }, 180_000)

  test("marks the Conversation tab, navigation, and Session row while a decision is waiting", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const theme of themes) {
        for (const [width, height] of viewports) {
          await page.setViewport(width, height)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=${theme}`)
          await until(page, `document.getElementById("pending-requests") !== null && document.querySelector(".presentation-switch") ${width < 768 ? "===" : "!=="} null`)
          const report = await page.evaluate<{
            readonly tab: string | null
            readonly tabDot: boolean
            readonly bar: boolean
            readonly navDot: boolean
            readonly bottomDot: boolean
            readonly rowDot: boolean
            readonly rows: readonly string[]
            readonly overflow: boolean
          }>(`(() => {
            const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0
            return {
              tab: document.querySelector(".presentation-switch .filters__option--attention")?.getAttribute("aria-label") ?? null,
              tabDot: visible(document.querySelector(".presentation-switch .filters__option--attention .attention-dot")),
              bar: (() => { const bar = document.querySelector('.workspace__topbar'); return bar?.parentElement === document.querySelector('.workspace__main') && Boolean(bar?.querySelector('[aria-label="Open Team"]')) && (innerWidth < 768 ? bar.querySelector('.presentation-switch') === null : bar.querySelector('.presentation-switch') !== null) })(),
              navDot: visible(document.querySelector('.remote-nav a[href="/remote"] .attention-dot')),
              bottomDot: visible(document.querySelector('.bottom-nav a[href="/remote"] .attention-dot')),
              rowDot: document.querySelector(".session-row--active .session-row__attention") !== null,
              rows: [...document.querySelectorAll(".session-row__name")].map((name) => name.textContent.trim()),
              overflow: document.documentElement.scrollWidth > innerWidth,
            }
          })()`)
          expect(report.tab).toBe(width < 768 ? null : "Conversation, waiting for your decision")
          expect(report.tabDot).toBe(width >= 768)
          expect(report.bar).toBe(true)
          expect(report.navDot || report.bottomDot).toBe(true)
          expect(report.rowDot).toBe(true)
          expect(report.rows).not.toContain("Child: fix flaky suite")
          expect(report.overflow).toBe(false)
          await capture(page, `conversation-${width}-${theme}`)
        }
      }

      await page.setViewport(1440, 900)
      await page.evaluate(`[...document.querySelectorAll(".presentation-switch .filters__option")].find((option) => option.textContent.trim().startsWith("Office")).click()`)
      await until(page, `document.querySelector(".presentation-switch .filters__option--active")?.textContent.trim().startsWith("Office")`)
      expect(await page.evaluate<boolean>(`document.querySelector(".composer") === null && document.querySelector(".workspace__main .conversation-pane") === null`)).toBe(true)
      await page.evaluate(`[...document.querySelectorAll(".presentation-switch .filters__option")].find((option) => option.textContent.trim().startsWith("Conversation")).click()`)
      await until(page, `document.querySelector(".composer") !== null`)
    } finally {
      await page.close()
    }
  }, 180_000)

  test("collects live Session alerts in the notification center and opens their Session", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const [width, height] of [[1440, 900], [390, 844]] as const) {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=dark`)
        await until(page, `document.querySelector(".session-row--active .live-dot") !== null || document.querySelector(".live-dot") !== null`)
        expect(await page.evaluate<boolean>(`document.querySelector(".yc-notification-center__badge") === null`)).toBe(true)
        await page.evaluate(`window.remoteStatus([], ["ses_fixture", "ses_archived"])`)
        await until(page, `document.querySelector(".yc-notification-center__badge") !== null`)
        await page.evaluate(`document.querySelector(".yc-notification-center__trigger").click()`)
        await until(page, `document.querySelector(".yc-notification-panel") !== null`)
        const report = await page.evaluate<{
          readonly titles: readonly string[]
          readonly details: readonly string[]
          readonly badge: boolean
          readonly expanded: string | null
          readonly inViewport: boolean
        }>(`(() => {
          const panel = document.querySelector(".yc-notification-panel").getBoundingClientRect()
          return {
            titles: [...document.querySelectorAll(".yc-notification__open strong")].map((title) => title.textContent.trim()),
            details: [...document.querySelectorAll(".yc-notification__open span")].map((detail) => detail.textContent.trim()),
            badge: document.querySelector(".yc-notification-center__badge") !== null,
            expanded: document.querySelector(".yc-notification-center__trigger").getAttribute("aria-expanded"),
            inViewport: panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0,
          }
        })()`)
        expect(report.titles.length).toBeGreaterThanOrEqual(2)
        expect(report.details).toContain("Stream remote output safely")
        expect(report.details).toContain("Archived: release notes")
        expect(report.badge).toBe(false)
        expect(report.expanded).toBe("true")
        expect(report.inViewport).toBe(true)
        await capture(page, `notifications-${width}-dark`)

        await page.pressEscape()
        await until(page, `document.querySelector(".yc-notification-panel") === null`)
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector(".yc-notification-center__trigger")`)).toBe(true)

        await page.evaluate(`document.querySelector(".yc-notification-center__trigger").click()`)
        await until(page, `document.querySelector(".yc-notification-panel") !== null`)
        await page.evaluate(`[...document.querySelectorAll(".yc-notification__open")].find((item) => item.textContent.includes("Archived: release notes")).click()`)
        await until(page, `document.querySelector(".yc-notification-panel") === null && document.querySelector(".conversation-breadcrumb strong")?.textContent.trim() === "Archived: release notes"`)
      }
    } finally {
      await page.close()
    }
  }, 180_000)

  test("opens Usage with the connected machine's quotas, balance, and spend through the real store", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const theme of themes) {
        for (const [width, height] of viewports) {
          await page.setViewport(width, height)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=usage&theme=${theme}`)
          await until(page, `document.querySelectorAll(".usage-provider").length === 3 && document.querySelectorAll(".usage-tile").length > 0 && document.querySelector(".usage-breakdown table") !== null && document.querySelectorAll(".usage-distribution__legend li").length > 0`)
          const report = await page.evaluate<{
            readonly heading: string
            readonly providers: readonly string[]
            readonly openRouter: string
            readonly copilot: string
            readonly activeNav: readonly string[]
            readonly placeholders: readonly string[]
            readonly overflow: boolean
            readonly operations: Readonly<Record<string, number>>
            readonly distribution: readonly string[]
            readonly provenanceText: boolean
          }>(`(() => {
            const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0
            const card = (label) => [...document.querySelectorAll(".usage-provider")].find((item) => item.querySelector("h3")?.textContent.trim() === label)?.textContent ?? ""
            return {
              heading: document.querySelector(".usage-page h1")?.textContent.trim() ?? "",
              providers: [...document.querySelectorAll(".usage-provider h3")].map((item) => item.textContent.trim()),
              openRouter: card("OpenRouter"),
              copilot: card("GitHub Copilot"),
              activeNav: [...document.querySelectorAll('.remote-nav a[aria-current="page"], .bottom-nav a[aria-current="page"]')].filter(visible).map((link) => link.textContent.trim()),
              placeholders: [...document.querySelectorAll(".usage-page *")].filter((element) => element.children.length === 0 && ["-", "_", "—", "–"].includes(element.textContent.trim())).map((element) => element.outerHTML),
              overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              operations: window.remoteOperationReport().operations,
              distribution: [...document.querySelectorAll(".usage-distribution__legend .usage-distribution__name")].map((item) => item.textContent.trim()),
              provenanceText: [...document.querySelectorAll(".usage-provider")].some((card) => /source:|stability:/i.test(card.innerText)),
            }
          })()`)
          expect(report.heading).toBe("Usage")
          expect(report.providers).toEqual(["Codex", "OpenRouter", "GitHub Copilot"])
          expect(report.openRouter).toContain("Balance")
          expect(report.openRouter).toContain("$38.42")
          expect(report.copilot).toContain("AI credits")
          expect(report.copilot.toLowerCase()).not.toContain("premium")
          expect(report.activeNav).toEqual(["Usage"])
          expect(report.placeholders).toEqual([])
          expect(report.overflow).toBe(false)
          expect({ providers: report.operations["usage.providers"], summary: report.operations["usage.summary"] }).toEqual({ providers: 1, summary: 1 })
          expect(report.operations["usage.report"]).toBe(3)
          expect(report.distribution).toEqual(["Codex", "OpenRouter", "GitHub Copilot"])
          expect(report.provenanceText).toBe(false)
          if ((width === 390 && theme === "light") || (width === 1440 && theme === "dark")) await capture(page, `usage-${width}-${theme}`)
        }
      }
    } finally {
      await page.close()
    }
  }, 180_000)
})

async function capture(page: { screenshot(): Promise<string> }, name: string) {
  await Bun.write(`${captures}${name}.png`, Buffer.from(await page.screenshot(), "base64"))
}

async function until(page: { evaluate<T>(expression: string): Promise<T> }, expression: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)
}

function requireBrowser() {
  if (!browser) throw new Error("Browser did not start")
  return browser
}
