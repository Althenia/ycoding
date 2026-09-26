import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SITEMAP_PATHS } from "../src/seo/sitemap"
import { REMOTE_SCENARIOS } from "./remote-scenarios"
import { launchBrowser } from "./cdp"

const port = 4197
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable before running the design contract suite.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the design contract server")
  browser = await launchBrowser(browserPath, 1440, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("web design contract inventory", () => {
  test("covers every current public route and named router entry", async () => {
    const routeSource = await Bun.file(new URL("../src/app.tsx", import.meta.url)).text()
    const routerPaths = [...routeSource.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]!)
    const missing = missingRoutePatterns(SITEMAP_PATHS, routerPaths)
    expect(missing).toEqual([])
    expect(routerPaths.filter((path) => !path.startsWith("/remote") && !path.endsWith("/*slug") && !SITEMAP_PATHS.includes(path))).toEqual([])
    expect(SITEMAP_PATHS.length).toBeGreaterThan(0)

    const page = await requireBrowser().openPage()
    for (const path of SITEMAP_PATHS) {
      await page.navigate(url(path))
      const rendered = await page.evaluate<{ readonly title: string; readonly notFound: boolean; readonly overflow: boolean; readonly activeNav: string }>(`(() => {
        const main = document.querySelector("#main")
        if (!(main instanceof HTMLElement)) throw new Error("public route has no main landmark")
        return {
          title: main.querySelector("h1")?.textContent?.trim() ?? "",
          notFound: main.querySelector(".not-found__card") !== null,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          activeNav: document.querySelector('nav[aria-label="Primary"] .nav__link--active')?.textContent?.trim() ?? "",
        }
      })()`)
      expect({ path, ...rendered }).toMatchObject({ path, notFound: false, overflow: false })
      expect({ path, title: rendered.title }).toEqual({ path, title: expect.any(String) })
      expect(rendered.title.length).toBeGreaterThan(0)
      expect(rendered.activeNav).toBe(path === "/" ? "Home" : path.startsWith("/docs") ? "Documentation" : "Changelog")
    }
    await page.navigate(url("/not-a-route"))
    expect(await page.evaluate<boolean>(`document.querySelector("#main .not-found__card") !== null`)).toBe(true)
    await page.close()
  }, 60_000)

  test("rejects a missing route-pattern mapping instead of silently shrinking route coverage", () => {
    expect(missingRoutePatterns(["/", "/docs/quickstart"], ["/", "/docs/*slug"])).toEqual([])
    expect(missingRoutePatterns(["/", "/docs/quickstart"], ["/", "/docs"])).toEqual(["/docs/quickstart"])
  })

  test("renders every live remote fixture state within its route and viewport", async () => {
    const routeSource = await Bun.file(new URL("../src/app.tsx", import.meta.url)).text()
    const routerPaths = [...routeSource.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]!)
    const remoteRoutes = routerPaths.filter((path) => path.startsWith("/remote"))
    const fixtureViews = new Set(REMOTE_SCENARIOS.map((scenario) => fixturePath(scenario.view)))
    expect([...fixtureViews].filter((path) => !remoteRoutes.includes(path))).toEqual([])
    expect(remoteRoutes.filter((path) => !fixtureViews.has(path))).toEqual([])

    const page = await requireBrowser().openPage()
    for (const scenario of REMOTE_SCENARIOS) {
      await page.setViewport(scenario.viewport, 900)
      await page.navigate(`${url("/verify/remote.html")}?scenario=${scenario.name}-${scenario.viewport}`)
      const state = await page.evaluate<{ readonly theme: string; readonly background: string; readonly ink: string; readonly overflow: boolean; readonly path: string; readonly signIn: boolean }>(`(() => ({
        theme: document.documentElement.dataset.theme ?? "",
        background: getComputedStyle(document.documentElement).getPropertyValue("--yc-bg").trim(),
        ink: getComputedStyle(document.documentElement).getPropertyValue("--yc-text").trim(),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        path: document.querySelector(".app")?.className ?? "",
        signIn: document.querySelector("main.sign-in") !== null,
      }))()`)
      expect({ id: scenario.id, theme: state.theme }).toEqual({ id: scenario.id, theme: scenario.theme })
      expect(state.background).not.toBe("")
      expect(state.ink).not.toBe("")
      expect({ id: scenario.id, overflow: state.overflow }).toEqual({ id: scenario.id, overflow: false })
      // A signed-out browser sees only the sign-in screen, on every remote route.
      expect({ id: scenario.id, signIn: state.signIn }).toEqual({ id: scenario.id, signIn: scenario.account === "signedout" })
      if (!state.signIn) expect(state.path).toContain(`app--${scenario.view === "chat" ? "conversation" : scenario.view}`)
      if (!state.signIn && scenario.view !== "chat") {
        expect(await page.evaluate<string>(`document.querySelector('.remote-nav a[aria-current="page"]')?.textContent?.trim() ?? ""`)).toBe(
          scenario.view === "sessions" ? "Sessions" : scenario.view === "activity" ? "Activity" : "Settings",
        )
      }
      const visibleText = await page.evaluate<string>("document.body.innerText")
      for (const expected of scenario.expectedText) {
        expect({ id: scenario.id, missing: visibleText.includes(expected) ? undefined : expected }).toEqual({ id: scenario.id, missing: undefined })
      }
    }
    await page.close()
  }, 60_000)

  test("keeps computed public geometry, theme tokens, and controls within representative viewports", async () => {
    const page = await requireBrowser().openPage()
    for (const [path, width, height] of [
      ["/", 1440, 900],
      ["/docs/quickstart", 768, 1024],
      ["/changelog", 390, 844],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewport(width, height)
        await page.navigate(url(path))
        const geometry = await page.evaluate<{ readonly theme: string; readonly background: string; readonly ink: string; readonly overflow: boolean; readonly content: { readonly left: number; readonly right: number }; readonly footer: { readonly left: number; readonly right: number }; readonly controls: readonly { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }[] }>(`(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme)}
          const main = document.querySelector("#main")
          const footer = document.querySelector(".site-footer")
          if (!(main instanceof HTMLElement) || !(footer instanceof HTMLElement)) throw new Error("public shell landmarks missing")
          const content = main.querySelector(".docs-shell, .hero .container, .features .container, .install .container")
          const footerContent = footer.querySelector(".container")
          if (!(content instanceof HTMLElement) || !(footerContent instanceof HTMLElement)) throw new Error("aligned content containers missing")
          const box = (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
          return {
            theme: document.documentElement.dataset.theme ?? "",
            background: getComputedStyle(document.documentElement).getPropertyValue("--yc-bg").trim(),
            ink: getComputedStyle(document.documentElement).getPropertyValue("--yc-text").trim(),
            overflow: document.documentElement.scrollWidth > innerWidth,
            content: box(content),
            footer: box(footerContent),
            controls: [...document.querySelectorAll("#main button, #main a.button")].filter(element => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0).map(box),
          }
        })()`)
        expect(geometry.theme).toBe(theme)
        expect(geometry.background).not.toBe("")
        expect(geometry.ink).not.toBe("")
        expect(geometry.overflow).toBe(false)
        expect(geometry.content.left).toBeGreaterThanOrEqual(0)
        expect(geometry.content.right).toBeLessThanOrEqual(width)
        expect(geometry.footer.left).toBeGreaterThanOrEqual(0)
        expect(geometry.footer.right).toBeLessThanOrEqual(width)
        expect(Math.abs(geometry.content.left - geometry.footer.left)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.content.right - geometry.footer.right)).toBeLessThanOrEqual(1)
        expect(geometry.controls.every((control) => control.left >= 0 && control.right <= width && control.bottom > control.top)).toBe(true)
      }
    }
    for (const [path, width, height, short] of [["/not-a-route", 1440, 900, true], ["/docs/quickstart", 390, 844, false]] as const) {
      await page.setViewport(width, height)
      await page.navigate(url(path))
      const footer = await page.evaluate<{ readonly top: number; readonly bottom: number; readonly position: string; readonly short: boolean; readonly mainBottom: number; readonly scrollHeight: number }>(`(() => {
        const element = document.querySelector(".site-footer")
        const main = document.querySelector("#main")
        if (!(element instanceof HTMLElement) || !(main instanceof HTMLElement)) throw new Error("public page landmarks missing")
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, position: getComputedStyle(element).position, short: document.documentElement.scrollHeight <= innerHeight, mainBottom: main.getBoundingClientRect().bottom, scrollHeight: document.documentElement.scrollHeight }
      })()`)
      expect(footer.short).toBe(short)
      expect(footer.position).not.toBe("fixed")
      expect(footer.position).not.toBe("sticky")
      if (short) expect(Math.abs(footer.bottom - height)).toBeLessThanOrEqual(1)
      else {
        expect(footer.scrollHeight).toBeGreaterThan(height)
        expect(footer.top).toBeGreaterThanOrEqual(footer.mainBottom - 1)
        expect(footer.bottom).toBeGreaterThan(height)
      }
    }

    await page.setViewport(390, 700)
    await page.navigate(`${url("/verify/remote.html")}?view=settings`)
    const ownership = await page.evaluate<{ readonly owners: number; readonly documentScrollable: boolean; readonly edges: readonly { readonly left: number; readonly right: number }[] }>(`(() => {
      document.querySelector(".fixture__banner")?.remove()
      document.querySelector(".fixture__controls")?.remove()
      const fixture = document.querySelector(".fixture")
      if (fixture instanceof HTMLElement) { fixture.style.minHeight = "0"; fixture.style.height = "100dvh"; fixture.style.overflow = "hidden" }
      const candidates = [document.scrollingElement, ...document.querySelectorAll(".app,.workspace,.workspace__main,.workspace__scroll")].filter(element => element instanceof HTMLElement)
      const owners = candidates.filter(element => element.scrollHeight > element.clientHeight + 1 && ["auto", "scroll"].includes(getComputedStyle(element).overflowY)).length
      const sections = [...document.querySelectorAll(".settings > *, .settings__section")].filter(element => element instanceof HTMLElement && element.getBoundingClientRect().width > 0).slice(0, 4)
      return { owners, documentScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight && ["auto", "scroll"].includes(getComputedStyle(document.documentElement).overflowY), edges: sections.map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right } }) }
    })()`)
    expect(ownership.owners).toBe(1)
    expect(ownership.documentScrollable).toBe(false)
    expect(ownership.edges.length).toBeGreaterThan(1)
    expect(ownership.edges.every((edge) => Math.abs(edge.left - ownership.edges[0]!.left) <= 1 && Math.abs(edge.right - ownership.edges[0]!.right) <= 1)).toBe(true)

    await page.navigate(`${url("/verify/remote.html")}?scenario=conversation-workspace-390`)
    const dropdown = await page.evaluate<{ readonly expanded: boolean; readonly withinViewport: boolean }>(`(() => {
      const trigger = document.querySelector('[aria-label="Machine"]')
      const list = document.querySelector('[role="listbox"]')
      if (!(trigger instanceof HTMLElement) || !(list instanceof HTMLElement)) return { expanded: false, withinViewport: false }
      const rect = list.getBoundingClientRect()
      return { expanded: trigger.getAttribute("aria-expanded") === "true", withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight }
    })()`)
    expect(dropdown).toEqual({ expanded: true, withinViewport: true })
    await page.evaluate(`document.querySelector('[aria-label="Machine"]')?.focus()`)
    await page.pressEscape()
    expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Machine"]')?.getAttribute("aria-expanded") === "false" && document.activeElement?.getAttribute("aria-label") === "Machine"`)).toBe(true)

    await page.setViewport(768, 900)
    await page.navigate(`${url("/verify/remote.html")}?scenario=conversation-workspace-768`)
    await page.evaluate(`document.querySelector('button[aria-label="Open activity"]')?.click()`)
    await page.evaluate<void>(`Promise.all([...document.querySelector('dialog[aria-label="Activity"] .overlay__surface')?.getAnimations() ?? []].map(animation => animation.finished))`)
    const modal = await page.evaluate<{ readonly open: boolean; readonly focused: boolean; readonly withinViewport: boolean; readonly bounds: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } }>(`(() => {
      const dialog = document.querySelector('dialog[aria-label="Activity"]')
      const surface = dialog?.querySelector(".overlay__surface")
      if (!(dialog instanceof HTMLDialogElement) || !(surface instanceof HTMLElement)) return { open: false, focused: false, withinViewport: false, bounds: { left: 0, right: 0, top: 0, bottom: 0 } }
      const rect = surface.getBoundingClientRect()
      return { open: dialog.open, focused: document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement), withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, bounds: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
    })()`)
    expect({ open: modal.open, focused: modal.focused, withinViewport: modal.withinViewport }, JSON.stringify(modal)).toEqual({ open: true, focused: true, withinViewport: true })
    await page.pressEscape()
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Activity"]') === null`)).toBe(true)
    await page.close()
  }, 30_000)

  test("keeps the handoff viewport matrix usable on public and remote surfaces", async () => {
    const page = await requireBrowser().openPage()
    for (const [width, height] of [[320, 568], [360, 740], [430, 932], [1024, 1366], [1280, 800], [1920, 1080]] as const) {
      for (const theme of width === 1024 ? ["light", "dark"] as const : ["light"] as const) {
        await page.setViewport(width, height)
        for (const path of ["/", "/docs/quickstart", "/changelog", "/verify/remote.html?view=chat", "/verify/remote.html?view=activity", "/verify/remote.html?view=settings"]) {
          await page.navigate(url(path))
          const layout = await page.evaluate<{ readonly overflow: boolean; readonly escaped: readonly string[]; readonly undersizedTabs: readonly string[]; readonly composer: boolean }>(`(() => {
            document.documentElement.dataset.theme = ${JSON.stringify(theme)}
            const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
            const controls = [...document.querySelectorAll('.app-header button, .app-header a, .remote-nav a, .bottom-nav a, .site-header button, .site-header a')].filter(visible)
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              escaped: controls.filter(element => { const box = element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1 }).map(element => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName),
              undersizedTabs: [...document.querySelectorAll('.remote-nav a')].filter(visible).filter(element => { const box = element.getBoundingClientRect(); return box.width < 44 || box.height < 44 }).map(element => element.textContent?.trim() ?? ''),
              composer: visible(document.querySelector('.composer')),
            }
          })()`)
          expect(layout.overflow, `${path} ${width}/${theme}`).toBe(false)
          expect(layout.escaped, `${path} ${width}/${theme}`).toEqual([])
          expect(layout.undersizedTabs, `${path} ${width}/${theme}`).toEqual([])
          if (path.includes("view=chat")) expect(layout.composer, `${path} ${width}/${theme}`).toBe(true)
        }
      }
    }
    await page.close()
  }, 60_000)
})

function missingRoutePatterns(paths: readonly string[], patterns: readonly string[]): readonly string[] {
  return paths.filter((path) => !patterns.some((pattern) => pattern === path || (pattern.endsWith("/*slug") && path.startsWith(pattern.slice(0, -"*slug".length)))))
}

function fixturePath(view: string): string {
  return view === "chat" ? "/remote" : `/remote/${view}`
}

function requireBrowser() {
  if (!browser) throw new Error("Browser was not initialized")
  return browser
}

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

async function ready(): Promise<boolean> {
  try {
    return (await fetch(url("/verify/remote.html"))).ok
  } catch {
    return false
  }
}
