import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { launchBrowser } from "./cdp"

const port = 4181
const browserPath = process.env.YCODING_WEB_CHROME
const output = join(import.meta.dir, "../output/docs-layout")
const routes = ["/", "/docs", "/docs/quickstart", "/docs/configuration", "/changelog", "/not-a-route"] as const
const widths = [320, 390, 768, 1024, 1280, 1440, 1920, 2560] as const

if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable before running this integration test.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the public component server")
  browser = await launchBrowser(browserPath, 1440, 900)
  await mkdir(output, { recursive: true })
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("public docs and site layout", () => {
  test("keeps shared public surfaces inside the header grid at every assigned width", async () => {
    const page = await requireBrowser().openPage()
    for (const width of widths) {
      await page.setViewport(width, 1000)
      for (const route of routes) {
        await page.navigate(url(route))
        const layout = await page.evaluate<{
          readonly width: number
          readonly scrollWidth: number
          readonly header: readonly number[]
          readonly content?: readonly number[]
          readonly rail?: readonly number[]
          readonly docsBar?: readonly number[]
          readonly footer?: readonly number[]
          readonly mainSurface?: readonly number[]
          readonly toc?: readonly number[]
          readonly tocVisible: boolean
          readonly cardWidths: readonly number[]
        }>(`(() => {
          const box = (element) => { const rect = element.getBoundingClientRect(); return [rect.left, rect.right] }
          const header = document.querySelector('.app-header__inner')
          const content = document.querySelector('.docs-shell')
          const article = document.querySelector('.docs-article')
          const rail = document.querySelector('.docs-shell__nav')
          const toc = document.querySelector('.docs-shell__toc')
          const docsBar = document.querySelector('.docs-bar__inner')
          const footer = document.querySelector('.site-footer .container')
          const mainSurface = document.querySelector('.hero .container, .not-found__card')
          if (!(header instanceof HTMLElement)) throw new Error('Public header missing')
          return {
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            header: box(header),
            content: article instanceof HTMLElement ? box(article) : content instanceof HTMLElement ? box(content) : undefined,
            rail: rail instanceof HTMLElement && getComputedStyle(rail).display !== 'none' ? box(rail) : undefined,
            docsBar: docsBar instanceof HTMLElement ? box(docsBar) : undefined,
            footer: footer instanceof HTMLElement ? box(footer) : undefined,
            mainSurface: mainSurface instanceof HTMLElement ? box(mainSurface) : undefined,
            toc: toc instanceof HTMLElement && getComputedStyle(toc).display !== 'none' ? box(toc) : undefined,
            tocVisible: toc instanceof HTMLElement && getComputedStyle(toc).display !== 'none',
            cardWidths: [...document.querySelectorAll('.docs--index .card')].map(card => card.getBoundingClientRect().width),
          }
        })()`)
        expect({ route, width, overflow: layout.scrollWidth <= width }).toEqual({ route, width, overflow: true })
        if (layout.content && width >= 1024) {
          expect(layout.content[0]!).toBeGreaterThanOrEqual(layout.header[0]! - 1)
          expect(layout.content[1]!).toBeLessThanOrEqual(layout.header[1]! + 1)
        }
        if (layout.rail && width >= 1024) {
          expect(layout.rail[0]!).toBeGreaterThanOrEqual(layout.header[0]! - 1)
          expect(layout.rail[1]!).toBeLessThanOrEqual(layout.header[1]! + 1)
        }
        for (const aligned of [layout.docsBar, layout.footer]) {
          if (aligned) expect(aligned).toEqual([expect.closeTo(layout.header[0]!, 1), expect.closeTo(layout.header[1]!, 1)])
        }
        if (layout.mainSurface) {
          expect(layout.mainSurface[0]!).toBeGreaterThanOrEqual(layout.header[0]! - 1)
          expect(layout.mainSurface[1]!).toBeLessThanOrEqual(layout.header[1]! + 1)
        }
        if (layout.toc && width >= 1280) {
          expect(layout.toc[0]!).toBeGreaterThanOrEqual(layout.header[0]! - 1)
          expect(layout.toc[1]!).toBeLessThanOrEqual(layout.header[1]! + 1)
        }
        if (route === "/docs/quickstart" && width >= 1280) expect(layout.tocVisible).toBe(true)
        if (route === "/docs") expect(layout.cardWidths.filter(cardWidth => cardWidth > 420), `index cards wider than 420px at ${width}px`).toEqual([])
      }
    }
    await page.close()
  }, 60_000)

  test("captures responsive route and theme audit renders", async () => {
    const page = await requireBrowser().openPage()
    for (const width of widths) {
      await page.setViewport(width, viewportHeight(width))
      for (const route of routes) {
        await page.navigate(url(route))
        await saveScreenshot(page, "after", route, width, "light")
      }
    }
    for (const width of [390, 1024, 1440] as const) {
      await page.setViewport(width, viewportHeight(width))
      for (const theme of ["light", "dark"] as const) {
        for (const route of routes) {
          await page.navigate(url(route))
          await page.evaluate<void>(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
          await saveScreenshot(page, "after", route, width, theme)
        }
      }
    }
    await page.close()
  }, 60_000)
})

async function saveScreenshot(page: { screenshot(): Promise<string> }, phase: "before" | "after", route: string, width: number, theme: "light" | "dark"): Promise<void> {
  const path = join(output, phase, `${route === "/" ? "home" : route.slice(1).replaceAll("/", "-")}-${width}-${theme}.png`)
  await mkdir(join(output, phase), { recursive: true })
  await Bun.write(path, Buffer.from(await page.screenshot(), "base64"))
}

function viewportHeight(width: number): number {
  return ({ 320: 568, 390: 844, 768: 1024, 1024: 1366, 1280: 800, 1440: 900, 1920: 1080, 2560: 1600 } as const)[width as 320 | 390 | 768 | 1024 | 1280 | 1440 | 1920 | 2560]
}

async function ready(): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/`).then((response) => response.ok, () => false)
}

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

function requireBrowser() {
  if (!browser) throw new Error("Browser setup did not complete")
  return browser
}
