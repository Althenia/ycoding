import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { RELEASES } from "../src/content/changelog"
import { SITEMAP_PATHS } from "../src/seo/sitemap"
import { launchBrowser } from "./cdp"

const port = 4179
const browserPath = process.env.YCODING_WEB_CHROME
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
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("public Stitch fidelity", () => {
  test("keeps short-page footers at the viewport edge without fixing long-page footers", async () => {
    const page = await requireBrowser().openPage()
    const measure = () =>
      page.evaluate<{
        readonly viewport: { readonly width: number; readonly height: number }
        readonly footer: { readonly top: number; readonly bottom: number; readonly position: string }
        readonly main: { readonly top: number; readonly bottom: number }
        readonly document: { readonly height: number; readonly scrollHeight: number; readonly scrollWidth: number }
      }>(`(() => {
        const footer = document.querySelector(".site-footer")
        const main = document.querySelector("#main")
        if (!(footer instanceof HTMLElement) || !(main instanceof HTMLElement)) throw new Error("public shell missing")
        const footerBox = footer.getBoundingClientRect()
        const mainBox = main.getBoundingClientRect()
        const root = document.documentElement
        return {
          viewport: { width: innerWidth, height: innerHeight },
          footer: { top: footerBox.top, bottom: footerBox.bottom, position: getComputedStyle(footer).position },
          main: { top: mainBox.top, bottom: mainBox.bottom },
          document: { height: root.getBoundingClientRect().height, scrollHeight: root.scrollHeight, scrollWidth: root.scrollWidth },
        }
      })()`)
    await page.setViewport(2048, 1113)
    await page.navigate(url("/"))
    const short = await measure()
    expect(Math.abs(short.footer.bottom - short.viewport.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(short.footer.bottom - short.document.height)).toBeLessThanOrEqual(1)
    expect(short.document.scrollHeight).toBe(short.viewport.height)
    for (const path of ["/docs", "/changelog", "/not-a-route"]) {
      await page.navigate(url(path))
      const tall = await measure()
      expect(tall.document.scrollWidth).toBeLessThanOrEqual(tall.viewport.width)
      if (tall.document.scrollHeight <= tall.viewport.height) {
        expect(Math.abs(tall.footer.bottom - tall.document.height)).toBeLessThanOrEqual(1)
      }
    }
    await page.navigate(url("/docs/quickstart"))
    const long = await measure()
    expect(long.document.scrollHeight).toBeGreaterThan(long.viewport.height)
    expect(long.footer.position).not.toBe("fixed")
    expect(long.footer.position).not.toBe("sticky")
    expect(long.footer.top).toBeGreaterThanOrEqual(long.main.bottom - 1)
    await page.setViewport(390, 844)
    for (const path of ["/", "/docs/quickstart", "/changelog"]) {
      await page.navigate(url(path))
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    await page.close()
  })

  test("uses one radius for public controls and raised surfaces without narrow overflow", async () => {
    const page = await requireBrowser().openPage()
    const radii = async (path: string, selectors: readonly string[]) => {
      await page.navigate(url(path))
      return page.evaluate<readonly string[]>(`[...${JSON.stringify(selectors)}].map(selector => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error("missing public surface: " + selector)
        return getComputedStyle(element).borderRadius
      })`)
    }
    expect(await radii("/", [".button--primary", ".feature", ".code-block"])).toEqual(["10px", "10px", "10px"])
    expect(await radii("/docs", [".docs-bar__nav-toggle", ".docs-search-trigger", ".doc-section", ".card"])).toEqual(["10px", "10px", "10px", "10px"])
    expect(await radii("/docs/quickstart", [".code-block", ".callout"])).toEqual(["10px", "10px"])
    expect(await radii("/changelog", [".release", ".filters__option"])).toEqual(["10px", "10px"])
    await page.setViewport(390, 844)
    for (const path of ["/", "/docs", "/docs/quickstart", "/changelog"]) {
      await page.navigate(url(path))
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    await page.close()
  })

  test("keeps every published public route nonblank, in-flow, and within its viewport", async () => {
    const page = await requireBrowser().openPage()
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]] as const) {
      await page.setViewport(width, height)
      for (const theme of ["light", "dark"] as const) {
        for (const path of SITEMAP_PATHS) {
          await page.navigate(url(path))
          await page.evaluate<boolean>(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true })()`)
          const layout = await page.evaluate<{
            readonly overflow: boolean
            readonly mainHeight: number
            readonly footerBottom: number
            readonly rootHeight: number
            readonly short: boolean
          }>(`(() => {
            const main = document.querySelector("#main")
            const footer = document.querySelector(".site-footer")
            if (!(main instanceof HTMLElement) || !(footer instanceof HTMLElement)) throw new Error("public shell missing")
            const root = document.documentElement
            return {
              overflow: root.scrollWidth > innerWidth,
              mainHeight: main.getBoundingClientRect().height,
              footerBottom: footer.getBoundingClientRect().bottom,
              rootHeight: root.getBoundingClientRect().height,
              short: root.scrollHeight <= innerHeight,
            }
          })()`)
          expect(layout.overflow).toBe(false)
          expect(layout.mainHeight).toBeGreaterThan(0)
          if (layout.short) expect(Math.abs(layout.footerBottom - layout.rootHeight)).toBeLessThanOrEqual(1)
        }
      }
    }
    await page.close()
  }, 60_000)

  test("keeps P09 copy actionable and compact footer links reachable", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/"))
    const before = await page.evaluate<{ readonly copyVisible: boolean; readonly headVisible: boolean; readonly footerLinks: readonly string[] }>(`(() => {
      const copy = document.querySelector(".hero .code-block__copy")
      const head = document.querySelector(".hero .code-block__head")
      return { copyVisible: copy instanceof HTMLElement && getComputedStyle(copy).display !== "none", headVisible: head instanceof HTMLElement && getComputedStyle(head).display !== "none", footerLinks: [...document.querySelectorAll(".footer__compact .footer__links a")].map(link => link.getAttribute("href")) }
    })()`)
    expect(before.copyVisible).toBe(true)
    expect(before.headVisible).toBe(true)
    expect(before.footerLinks).toContain("/remote")
    await page.evaluate<void>(`document.querySelector(".hero .code-block__copy")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    expect(await page.evaluate<string>(`document.querySelector(".hero .code-block__copy")?.getAttribute("aria-label")`)).toBe("Copied")
    await page.close()
  })

  test("uses P10 group widths, P13 stacked cards, and P14 framed left-aligned status content", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/docs"))
    expect(await page.evaluate<readonly number[]>(`[...document.querySelectorAll(".docs--index .doc-section .card-grid")].map(grid => getComputedStyle(grid).gridTemplateColumns.split(" ").length)`)).toEqual([2, 2, 3, 1])
    await page.navigate(url("/changelog"))
    expect(await page.evaluate<{ readonly columns: number; readonly before: string }>(`(() => { const release = document.querySelector(".releases--timeline .release"); if (!(release instanceof HTMLElement)) throw new Error("release missing"); return { columns: getComputedStyle(release).gridTemplateColumns.split(" ").length, before: getComputedStyle(release, "::before").content } })()`)).toEqual({ columns: 1, before: "none" })
    await page.navigate(url("/not-a-route"))
    expect(await page.evaluate<{ readonly border: number; readonly justifyItems: string; readonly actions: string }>(`(() => { const card = document.querySelector(".not-found__card"); if (!(card instanceof HTMLElement)) throw new Error("not-found card missing"); const actions = card.querySelector(".not-found__actions"); return { border: Number.parseFloat(getComputedStyle(card).borderTopWidth), justifyItems: getComputedStyle(card).justifyItems, actions: actions instanceof HTMLElement ? getComputedStyle(actions).justifyContent : "" } })()`)).toEqual({ border: 1, justifyItems: "start", actions: "start" })
    await page.close()
  })

  test("renders P13 release status from the live changelog contract", async () => {
    const page = await requireBrowser().openPage()
    await page.navigate(url("/changelog"))
    const releases = await page.evaluate<readonly { readonly version: string; readonly date: string; readonly tags: readonly string[] }[]>(`[...document.querySelectorAll(".releases--timeline .release")].map(release => ({ version: release.querySelector(".release__version")?.textContent?.trim() ?? "", date: release.querySelector(".release__date")?.textContent?.trim() ?? "", tags: [...release.querySelectorAll(".release__tags .tag")].map(tag => tag.textContent?.trim() ?? "") }))`)
    expect(releases).toEqual(RELEASES.map((release) => ({ version: `v${release.version}`, date: release.date, tags: release.tags })))
    expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll(".releases--timeline .tag")].map(tag => tag.textContent?.trim() ?? "").filter(tag => tag === "Latest" || tag === "Current")`)).toEqual([])
    await page.close()
  })

  test("keeps P09 and P14 touch controls visible without mobile overflow", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/"))
    const landing = await page.evaluate<{ readonly overflow: boolean; readonly copy: number }>(`({ overflow: document.documentElement.scrollWidth > innerWidth, copy: document.querySelector(".hero .code-block__copy")?.getBoundingClientRect().width ?? 0 })`)
    expect(landing.overflow).toBe(false)
    expect(landing.copy).toBeGreaterThan(0)
    await page.navigate(url("/not-a-route"))
    const actions = await page.evaluate<readonly { readonly width: number; readonly parent: number }[]>(`[...document.querySelectorAll(".not-found__actions .button")].map(button => { const box = button.getBoundingClientRect(); return { width: box.width, parent: button.parentElement?.getBoundingClientRect().width ?? 0 } })`)
    expect(actions).toHaveLength(2)
    expect(actions.every((action) => Math.abs(action.width - action.parent) < 1)).toBe(true)
    await page.close()
  })

  test("keeps P10 compact at mobile while retaining its tablet and desktop group grids", async () => {
    const page = await requireBrowser().openPage()
    const index = async (width: number) => {
      await page.setViewport(width, 900)
      await page.navigate(url("/docs"))
      return page.evaluate<{ readonly navGettingStarted: string | undefined; readonly navUsage: string | undefined; readonly navUsageVisible: boolean; readonly indexGettingStarted: string | undefined; readonly indexUsage: string | undefined; readonly configuration: { readonly tracks: number; readonly summaries: number; readonly targetHeights: readonly number[]; readonly hrefs: readonly string[] }; readonly gettingStarted: { readonly borderedCards: number; readonly targetHeights: readonly number[]; readonly hrefs: readonly string[] } }>(`(() => {
        const group = name => document.querySelector('.docs-topic-index [data-doc-group="'+name+'"]')
        const measure = section => {
          if (!(section instanceof HTMLElement)) throw new Error("group missing")
          const grid = section.querySelector(".card-grid")
          const links = [...section.querySelectorAll(".card__link")]
          return { tracks: grid instanceof HTMLElement ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0, summaries: [...section.querySelectorAll(".card__text")].filter(card => getComputedStyle(card).display !== "none").length, targetHeights: links.map(link => link.getBoundingClientRect().height), hrefs: links.map(link => link.getAttribute("href") ?? "") }
        }
        const gettingStarted = group("get-started")
        const navTitles = [...document.querySelectorAll(".docs-shell__nav .docs-nav__title")]
        const navUsage = navTitles.find(element => element.textContent?.trim() === "Usage")
        return { navGettingStarted: navTitles.find(element => element.textContent?.trim() === "Getting started")?.textContent?.trim(), navUsage: navUsage?.textContent?.trim(), navUsageVisible: navUsage instanceof HTMLElement && getComputedStyle(navUsage).display !== "none", indexGettingStarted: [...document.querySelectorAll(".docs-topic-index h2")].map(element => element.textContent?.trim()).find(text => text === "Getting started"), indexUsage: [...document.querySelectorAll(".docs-topic-index h2")].map(element => element.textContent?.trim()).find(text => text === "Usage"), configuration: measure(group("configuration")), gettingStarted: { borderedCards: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card")].filter(card => getComputedStyle(card).borderTopWidth !== "0px").length : 0, targetHeights: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card__link")].map(link => link.getBoundingClientRect().height) : [], hrefs: gettingStarted instanceof HTMLElement ? [...gettingStarted.querySelectorAll(".card__link")].map(link => link.getAttribute("href") ?? "") : [] } }
      })()`)
    }
    const mobile = await index(390)
    expect(mobile.navUsage).toBe("Usage")
    expect(mobile.indexUsage).toBe("Usage")
    expect(mobile.configuration.tracks).toBe(2)
    expect(mobile.configuration.summaries).toBe(0)
    expect(mobile.configuration.hrefs).toContain("/docs/configuration")
    expect(mobile.configuration.targetHeights.length).toBeGreaterThan(0)
    expect(mobile.configuration.targetHeights.every((height) => height >= 44)).toBe(true)
    expect(mobile.gettingStarted.borderedCards).toBe(0)
    expect(mobile.gettingStarted.hrefs).toContain("/docs/quickstart")
    expect(mobile.gettingStarted.targetHeights.length).toBeGreaterThan(0)
    expect(mobile.gettingStarted.targetHeights.every((height) => height >= 44)).toBe(true)
    expect((await index(768)).configuration.tracks).toBe(3)
    const desktop = await index(1440)
    expect(desktop.navGettingStarted).toBe("Getting started")
    expect(desktop.navUsage).toBe("Usage")
    expect(desktop.navUsageVisible).toBe(true)
    expect(desktop.indexGettingStarted).toBe("Getting started")
    expect(desktop.configuration.tracks).toBe(3)
    await page.close()
  })

  test("uses P12 state-specific navigation surfaces and approved public heading scales", async () => {
    const page = await requireBrowser().openPage()
    const heading = async (path: string, width: number, selector = "h1") => {
      await page.setViewport(width, 900)
      await page.navigate(url(path))
      return page.evaluate<{ readonly size: number; readonly line: number }>(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error("heading missing"); const style = getComputedStyle(element); return { size: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight) } })()`)
    }
    await page.setViewport(768, 900)
    await page.navigate(url("/docs"))
    await page.evaluate<void>(`document.querySelector(".docs-bar__nav-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    await page.evaluate<void>(`new Promise(resolve => setTimeout(resolve, 250))`)
    const drawer = await page.evaluate<{ readonly width: number; readonly left: number; readonly top: number; readonly height: number; readonly headerHeight: number; readonly close: number }>(`(() => { const dialog = document.querySelector(".overlay--docs-nav"); const surface = dialog?.querySelector(".overlay__surface"); const close = dialog?.querySelector(".overlay__close"); const header = document.querySelector(".app-header"); if (!(surface instanceof HTMLElement) || !(close instanceof HTMLElement) || !(header instanceof HTMLElement)) throw new Error("docs drawer missing"); const box = surface.getBoundingClientRect(); return { width: box.width, left: box.left, top: box.top, height: box.height, headerHeight: header.getBoundingClientRect().height, close: close.getBoundingClientRect().height } })()`)
    expect(drawer).toEqual({ width: 320, left: 0, top: drawer.headerHeight, height: 900 - drawer.headerHeight, headerHeight: drawer.headerHeight, close: 44 })
    await page.setViewport(1440, 900)
    await page.navigate(url("/docs"))
    await page.evaluate<void>(`document.querySelector(".docs-search-trigger")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    expect(await page.evaluate<number>(`Number.parseFloat(getComputedStyle(document.querySelector(".overlay--docs-search .overlay__surface")).inlineSize)`)).toBe(620)
    await page.setViewport(390, 844)
    await page.navigate(url("/docs"))
    await page.evaluate<void>(`document.querySelector(".app-header__menu")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    const primary = await page.evaluate<{ readonly width: number; readonly height: number; readonly brand: boolean; readonly routeBoxes: number; readonly activeRoute: string | undefined; readonly actionOrder: readonly string[]; readonly targets: readonly number[] }>(`(() => { const dialog = document.querySelector(".overlay--primary-nav"); const surface = dialog?.querySelector(".overlay__surface"); if (!(surface instanceof HTMLElement)) throw new Error("primary navigation missing"); const box = surface.getBoundingClientRect(); const targets = [...surface.querySelectorAll("a,button")].map(target => target.getBoundingClientRect().height); return { width: box.width, height: box.height, brand: !!surface.querySelector(".primary-nav__brand"), routeBoxes: surface.querySelectorAll(".primary-nav__routes .docs-nav__link").length, activeRoute: surface.querySelector(".primary-nav__routes .docs-nav__link--active")?.textContent?.trim(), actionOrder: [...surface.querySelectorAll(".primary-nav__actions > *")].map(action => action.textContent?.trim() ?? ""), targets } })()`)
    expect(primary.width).toBe(390)
    expect(primary.height).toBe(844)
    expect(primary.brand).toBe(true)
    expect(primary.routeBoxes).toBe(3)
    expect(primary.activeRoute).toBe("Documentation")
    expect(primary.actionOrder).toEqual(["Open workspace", "Search docs/"])
    expect(primary.targets.every((height) => height >= 44)).toBe(true)
    expect(await heading("/", 390, ".hero__headline")).toEqual({ size: 24, line: 33 })
    expect(await heading("/", 768, ".hero__headline")).toEqual({ size: 30, line: 37.5 })
    expect(await heading("/", 1440, ".hero__headline")).toEqual({ size: 48, line: 48 })
    expect(await heading("/docs", 390, ".docs-article > h1")).toEqual({ size: 16, line: 24 })
    expect(await heading("/docs", 768, ".docs-article > h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/docs", 1440, ".docs-article > h1")).toEqual({ size: 24, line: 32 })
    expect(await heading("/docs/quickstart", 390, ".docs-article > h1")).toEqual({ size: 22, line: 22 })
    expect(await heading("/docs/quickstart", 768, ".docs-article > h1")).toEqual({ size: 24, line: 30 })
    expect(await heading("/docs/quickstart", 1440, ".docs-article > h1")).toEqual({ size: 26, line: 32 })
    expect(await heading("/changelog", 390, ".docs-article > h1")).toEqual({ size: 16, line: 24 })
    expect(await heading("/changelog", 768, ".docs-article > h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/changelog", 1440, ".docs-article > h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/not-a-route", 390, ".not-found h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/not-a-route", 768, ".not-found h1")).toEqual({ size: 18, line: 27 })
    expect(await heading("/not-a-route", 1440, ".not-found h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/offline.html", 390, ".offline-card h1")).toEqual({ size: 20, line: 28 })
    expect(await heading("/offline.html", 768, ".offline-card h1")).toEqual({ size: 18, line: 27 })
    expect(await heading("/offline.html", 1440, ".offline-card h1")).toEqual({ size: 20, line: 28 })
    await page.close()
  }, 10_000)

  test("keeps the P12 navigation search shortcut owned by its active dialog", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(390, 844)
    await page.navigate(url("/docs"))
    await page.evaluate<void>(`(() => { const menu = document.querySelector(".app-header__menu"); if (!(menu instanceof HTMLButtonElement)) throw new Error("menu missing"); menu.dispatchEvent(new MouseEvent("click", { bubbles: true })); menu.focus(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })) })()`)
    const opened = await page.evaluate<{ readonly dialogs: number; readonly inputIds: readonly string[] }>(`({ dialogs: document.querySelectorAll(".overlay--docs-search[open]").length, inputIds: [...document.querySelectorAll("#docs-search-field")].map(input => input.id) })`)
    expect(opened.dialogs).toBe(1)
    expect(new Set(opened.inputIds).size).toBe(1)
    expect(opened.inputIds).toEqual(["docs-search-field"])
    await page.evaluate<void>(`(() => { const input = document.querySelector(".overlay--docs-search #docs-search-field"); if (!(input instanceof HTMLInputElement)) throw new Error("search input missing"); input.value = "quickstart"; input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "quickstart" })) })()`)
    await page.pressEscape()
    await page.evaluate<void>(`new Promise(resolve => setTimeout(resolve, 50))`)
    expect(await page.evaluate<number>(`document.querySelectorAll(".overlay--primary-nav[open]").length`)).toBe(1)
    expect(await page.evaluate<number>(`document.querySelectorAll(".overlay--docs-search[open]").length`)).toBe(0)
    expect(await page.evaluate<{ readonly tag: string; readonly className: string }>(`({ tag: document.activeElement?.tagName ?? "", className: document.activeElement instanceof HTMLElement ? document.activeElement.className : "" })`)).toEqual({ tag: "BUTTON", className: "docs-search-trigger" })
    await page.evaluate<void>(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`)
    await page.evaluate<void>(`document.querySelector(".overlay--docs-search .search__result")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`)
    await page.evaluate<void>(`new Promise(resolve => setTimeout(resolve, 50))`)
    expect(await page.evaluate<{ readonly path: string; readonly dialogs: number }>(`({ path: location.pathname, dialogs: document.querySelectorAll("dialog[open]").length })`)).toEqual({ path: "/docs/quickstart", dialogs: 0 })
    await page.close()
  }, 10_000)
})

function requireBrowser() {
  if (!browser) throw new Error("Browser was not initialized")
  return browser
}

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

async function ready(): Promise<boolean> {
  try {
    return (await fetch(url("/"))).ok
  } catch {
    return false
  }
}
