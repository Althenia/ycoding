import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SITEMAP_PATHS } from "../src/seo/sitemap"
import { PUBLIC_ROUTE_PATTERNS, REMOTE_ROUTE_PATHS } from "../src/routes"
import { REMOTE_SCENARIOS } from "./remote-scenarios"
import { launchBrowser, decodeArray, decodeBoolean, decodeNullable, decodeNumber, decodeRecord, decodeString } from "./cdp"

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
    const routerPaths = [...PUBLIC_ROUTE_PATTERNS]
    const missing = missingRoutePatterns(SITEMAP_PATHS, routerPaths)
    expect(missing).toEqual([])
    expect(routerPaths.filter((path) => !path.endsWith("/*slug") && !SITEMAP_PATHS.includes(path))).toEqual([])
    expect(SITEMAP_PATHS.length).toBeGreaterThan(0)

    const page = await requireBrowser().openPage()
    for (const path of SITEMAP_PATHS) {
      await page.navigate(url(path))
      for (let attempt = 0; attempt < 50 && !(await page.evaluate(`document.querySelector("#main") instanceof HTMLElement`)); attempt += 1) await Bun.sleep(100)
      const rendered = await page.evaluate(`(() => {
        const main = document.querySelector("#main")
        if (!(main instanceof HTMLElement)) throw new Error("public route has no main landmark")
        return {
          title: main.querySelector("h1")?.textContent?.trim() ?? "",
          notFound: main.querySelector(".not-found__card") !== null,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          activeNav: document.querySelector('nav[aria-label="Primary"] .nav__link--active')?.textContent?.trim() ?? "",
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, title: (decodeString)(record["title"]), notFound: (decodeBoolean)(record["notFound"]), overflow: (decodeBoolean)(record["overflow"]), activeNav: (decodeString)(record["activeNav"]) } })
      expect({ path, ...rendered }).toMatchObject({ path, notFound: false, overflow: false })
      expect({ path, title: rendered.title }).toEqual({ path, title: expect.any(String) })
      expect(rendered.title.length).toBeGreaterThan(0)
      expect(rendered.activeNav).toBe(path === "/" ? "Home" : path.startsWith("/docs") ? "Documentation" : "Changelog")
    }
    await page.navigate(url("/not-a-route"))
    expect(await page.evaluate(`document.querySelector("#main .not-found__card") !== null`)).toBe(true)
    await page.close()
  }, 60_000)

  test("rejects a missing route-pattern mapping instead of silently shrinking route coverage", () => {
    expect(missingRoutePatterns(["/", "/docs/quickstart"], ["/", "/docs/*slug"])).toEqual([])
    expect(missingRoutePatterns(["/", "/docs/quickstart"], ["/", "/docs"])).toEqual(["/docs/quickstart"])
  })

  test("renders every live remote fixture state within its route and viewport", async () => {
    const remoteRoutes: readonly string[] = REMOTE_ROUTE_PATHS
    const fixtureViews = new Set(REMOTE_SCENARIOS.map((scenario) => fixturePath(scenario)))
    expect([...fixtureViews].filter((path) => !remoteRoutes.includes(path))).toEqual([])
    expect(remoteRoutes.filter((path) => !fixtureViews.has(path))).toEqual([])

    const page = await requireBrowser().openPage()
    for (const scenario of REMOTE_SCENARIOS) {
      await page.setViewport(scenario.viewport, 900)
      await page.navigate(`${url("/verify/remote.html")}?scenario=${scenario.name}-${scenario.viewport}`)
      for (let attempt = 0; attempt < 50 && !await page.evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(scenario.theme)} && (document.querySelector('.app') !== null || document.querySelector('main.sign-in') !== null)`); attempt += 1) await Bun.sleep(50)
      const state = await page.evaluate(`(() => ({
        theme: document.documentElement.dataset.theme ?? "",
        background: getComputedStyle(document.documentElement).getPropertyValue("--yc-plane-canvas").trim(),
        ink: getComputedStyle(document.documentElement).getPropertyValue("--yc-ink").trim(),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        path: document.querySelector(".app")?.className ?? "",
        pathname: location.pathname,
        sessionID: new URLSearchParams(location.search).get("session_id"),
        deviceID: new URLSearchParams(location.search).get("device_id"),
        signIn: document.querySelector("main.sign-in") !== null,
      }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, theme: (decodeString)(record["theme"]), background: (decodeString)(record["background"]), ink: (decodeString)(record["ink"]), overflow: (decodeBoolean)(record["overflow"]), path: (decodeString)(record["path"]), pathname: (decodeString)(record["pathname"]), sessionID: (decodeNullable(decodeString))(record["sessionID"]), deviceID: (decodeNullable(decodeString))(record["deviceID"]), signIn: (decodeBoolean)(record["signIn"]) } })
      expect({ id: scenario.id, theme: state.theme }).toEqual({ id: scenario.id, theme: scenario.theme })
      expect(state.background).not.toBe("")
      expect(state.ink).not.toBe("")
      expect({ id: scenario.id, overflow: state.overflow }).toEqual({ id: scenario.id, overflow: false })
      // A signed-out browser sees only the sign-in screen, on every remote route.
      expect({ id: scenario.id, signIn: state.signIn }).toEqual({ id: scenario.id, signIn: scenario.account === "signedout" })
      if (!state.signIn) expect(state.pathname).toBe(fixturePath(scenario))
      if (!state.signIn) expect(state.path).toContain(`app--${scenario.view === "chat" ? scenario.noSelection ? "conversation" : "selected" : scenario.view}`)
      if (!state.signIn && scenario.view === "chat" && !scenario.noSelection) expect({ sessionID: state.sessionID, deviceID: state.deviceID }).toEqual({ sessionID: "ses_fixture", deviceID: "dev_studio" })
      if (!state.signIn) {
        const current = scenario.view === "usage" ? "Usage" : scenario.view === "settings" ? "Settings" : scenario.view === "projects" ? "Projects" : scenario.view === "workspaces" ? "Workspaces" : scenario.view === "chat" && scenario.viewport >= 768 ? "Chat" : "Sessions"
        expect(await page.evaluate(`[...document.querySelectorAll('.activity-bar a[aria-current="page"], .bottom-nav a[aria-current="page"]')].filter(link => getComputedStyle(link).display !== "none" && link.getBoundingClientRect().width > 0).map(link => (link.querySelector(".activity-bar__label, .bottom-nav__label") ?? link).textContent?.trim() ?? "")`)).toEqual([current])
      }
      const settled = `${JSON.stringify(scenario.expectedText)}.every((text) => document.body.innerText.includes(text))`
      for (let attempt = 0; attempt < 50 && !(await page.evaluate(settled)); attempt += 1) await Bun.sleep(100)
      const visibleText = await page.evaluate("document.body.innerText", decodeString)
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
        const geometry = await page.evaluate(`(() => {
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
            background: getComputedStyle(document.documentElement).getPropertyValue("--yc-plane-canvas").trim(),
            ink: getComputedStyle(document.documentElement).getPropertyValue("--yc-ink").trim(),
            overflow: document.documentElement.scrollWidth > innerWidth,
            content: box(content),
            footer: box(footerContent),
            controls: [...document.querySelectorAll("#main button, #main a.button")].filter(element => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0).map(box),
          }
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, theme: (decodeString)(record["theme"]), background: (decodeString)(record["background"]), ink: (decodeString)(record["ink"]), overflow: (decodeBoolean)(record["overflow"]), content: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["content"]), footer: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["footer"]), controls: (decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]), top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]) } }))(record["controls"]) } })
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
      const footer = await page.evaluate(`(() => {
        const element = document.querySelector(".site-footer")
        const main = document.querySelector("#main")
        if (!(element instanceof HTMLElement) || !(main instanceof HTMLElement)) throw new Error("public page landmarks missing")
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, position: getComputedStyle(element).position, short: document.documentElement.scrollHeight <= innerHeight, mainBottom: main.getBoundingClientRect().bottom, scrollHeight: document.documentElement.scrollHeight }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), bottom: (decodeNumber)(record["bottom"]), position: (decodeString)(record["position"]), short: (decodeBoolean)(record["short"]), mainBottom: (decodeNumber)(record["mainBottom"]), scrollHeight: (decodeNumber)(record["scrollHeight"]) } })
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
    const ownership = await page.evaluate(`(() => {
      document.querySelector(".fixture__banner")?.remove()
      document.querySelector(".fixture__controls")?.remove()
      const fixture = document.querySelector(".fixture")
      if (fixture instanceof HTMLElement) { fixture.style.minHeight = "0"; fixture.style.height = "100dvh"; fixture.style.overflow = "hidden" }
      const candidates = [document.scrollingElement, ...document.querySelectorAll(".app,.workspace,.workspace__main,.workspace__scroll")].filter(element => element instanceof HTMLElement)
      const owners = candidates.filter(element => element.scrollHeight > element.clientHeight + 1 && ["auto", "scroll"].includes(getComputedStyle(element).overflowY)).length
      const sections = [...document.querySelectorAll(".settings > *, .settings__section")].filter(element => element instanceof HTMLElement && element.getBoundingClientRect().width > 0).slice(0, 4)
      return { owners, documentScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight && ["auto", "scroll"].includes(getComputedStyle(document.documentElement).overflowY), edges: sections.map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right } }) }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, owners: (decodeNumber)(record["owners"]), documentScrollable: (decodeBoolean)(record["documentScrollable"]), edges: (decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } }))(record["edges"]) } })
    expect(ownership.owners).toBe(1)
    expect(ownership.documentScrollable).toBe(false)
    expect(ownership.edges.length).toBeGreaterThan(1)
    expect(ownership.edges.every((edge) => Math.abs(edge.left - ownership.edges[0]!.left) <= 1 && Math.abs(edge.right - ownership.edges[0]!.right) <= 1)).toBe(true)

    await page.navigate(`${url("/verify/remote.html")}?scenario=conversation-workspace-390`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('a[href="/remote/settings"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('a[href="/remote/settings"]')?.click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('[aria-label="Color scheme"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('[aria-label="Color scheme"]')?.click()`)
    const dropdown = await page.evaluate(`(() => {
      const trigger = document.querySelector('[aria-label="Color scheme"]')
      const list = document.querySelector('[role="listbox"]')
      if (!(trigger instanceof HTMLElement) || !(list instanceof HTMLElement)) return { expanded: false, withinViewport: false }
      const rect = list.getBoundingClientRect()
      return { expanded: trigger.getAttribute("aria-expanded") === "true", withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight }
    })()`)
    expect(dropdown).toEqual({ expanded: true, withinViewport: true })
    await page.evaluate(`document.querySelector('[aria-label="Color scheme"]')?.focus()`)
    await page.pressEscape()
    expect(await page.evaluate(`document.querySelector('[aria-label="Color scheme"]')?.getAttribute("aria-expanded") === "false" && document.activeElement?.getAttribute("aria-label") === "Color scheme"`)).toBe(true)

    await page.close()
  }, 30_000)

  test("start-aligns fluid route columns and caps selected Session detail at 1200px", async () => {
    const page = await requireBrowser().openPage()
    const widths = { 1599: 1200, 1600: 1600, 1920: 1600, 2000: 1600, 2560: 1600 } as const
    for (const [width, expected] of Object.entries(widths).map(([key, value]) => [Number(key), value] as const)) {
      await page.setViewport(width, 1000)
      for (const [view, selector] of [["sessions", ".app--sessions .workspace__scroll > .route-panel--active"], ["usage", ".app--usage .workspace__scroll > .route-panel--active"], ["settings", ".app--settings .workspace__scroll > .route-panel--active > .pane"], ["chat", ".transcript"]] as const) {
        await page.navigate(url(`/verify/remote.html?view=${view}`))
        for (let attempt = 0; attempt < 100 && !await page.evaluate(`document.querySelector('.workspace__scroll') !== null`); attempt += 1) await Bun.sleep(50)
        for (let attempt = 0; attempt < 100 && !await page.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate(`JSON.stringify({ view: document.querySelector('.app')?.className ?? '', found: document.querySelector(${JSON.stringify(selector)}) !== null })`), `${view} ${width} mounted`).toContain('"found":true')
        const geometry = await page.evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)})
          const scroll = document.querySelector('.workspace__scroll')
          const box = element.getBoundingClientRect()
          const host = scroll.getBoundingClientRect()
          const styles = getComputedStyle(scroll)
          return {
            width: Math.round(box.width),
            available: Math.round(scroll.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)),
            gutter: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-gutter')),
            overflow: document.documentElement.scrollWidth > innerWidth,
            startAligned: Math.abs(box.left - host.left - parseFloat(styles.paddingLeft)) <= 1,
          }
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), available: (decodeNumber)(record["available"]), gutter: (decodeNumber)(record["gutter"]), overflow: (decodeBoolean)(record["overflow"]), startAligned: (decodeBoolean)(record["startAligned"]) } })
        expect(geometry.overflow, `${view} ${width}`).toBe(false)
        expect(geometry.startAligned, `${view} ${width}`).toBe(true)
        expect(geometry.gutter, `${view} ${width}`).toBe(width >= 1600 ? 48 : 40)
        if (view === "chat") {
          const column = Math.min(1200, geometry.available)
          expect(geometry.width, `${view} ${width}`).toBeLessThanOrEqual(column + 1)
          expect(geometry.width, `${view} ${width}`).toBeGreaterThanOrEqual(column - 1)
          continue
        }
        const cap = expected
        expect(geometry.width, `${view} ${width}`).toBeLessThanOrEqual(cap)
        expect(geometry.width, `${view} ${width}`).toBeGreaterThanOrEqual(Math.min(cap, geometry.available) - 1)
      }
    }
    await page.close()
  }, 60_000)

  test("renders Instrument plane steps, 3:1 pane separators and a running trace that stops under reduced motion", async () => {
    const page = await requireBrowser().openPage()
    const measure = `(() => {
      const lum = (value) => value.match(/[\\d.]+/g).slice(0, 3).map(Number).map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
      const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
      const rail = getComputedStyle(document.querySelector('.workspace__rail'))
      const canvas = getComputedStyle(document.querySelector('.workspace__topbar')).backgroundColor
      const raised = getComputedStyle(document.querySelector('.composer-resident .composer__row') ?? document.querySelector('.composer__row')).backgroundColor
      const edge = rail.boxShadow.match(/rgba?\\([^)]*\\)/)[0]
      const box = (selector) => document.querySelector(selector).getBoundingClientRect()
      return { canvasToRaised: ratio(canvas, raised), chromeToRaised: ratio(rail.backgroundColor, raised), edgeOnChrome: ratio(edge, rail.backgroundColor), edgeOnCanvas: ratio(edge, canvas), edgeOnRaised: ratio(edge, raised), headerTraceOffset: box('.workspace__topbar .trace').bottom - box('.workspace__topbar').bottom }
    })()`
    const animations = `document.getAnimations().filter((animation) => animation.playState === 'running').map((animation) => {
      const timing = animation.effect.getComputedTiming()
      const frames = animation.effect.getKeyframes()
      return { name: animation.animationName ?? animation.transitionProperty ?? '', loop: timing.iterations === Infinity, duration: Number(timing.duration) || 0, travel: frames.some((frame) => (frame.transform && frame.transform !== 'none') || (frame.translate && frame.translate !== 'none')) }
    })`
    const decodeAnimations = decodeArray((value: unknown) => { const record = decodeRecord(value); return { name: decodeString(record["name"]), loop: decodeBoolean(record["loop"]), duration: decodeNumber(record["duration"]), travel: decodeBoolean(record["travel"]) } })
    try {
      for (const theme of ["light", "dark"] as const) {
        for (const reduced of [false, true]) {
          await page.setViewport(1440, 900)
          await page.setColorScheme(theme)
          await page.setReducedMotion(reduced)
          await page.navigate(url(`/verify/remote.html?scenario=conversation-tool-terminal-output-1440&theme=${theme}`))
          for (let attempt = 0; attempt < 100 && !await page.evaluate(`document.body.innerText.includes('Test Suite Execution Output')`); attempt += 1) await Bun.sleep(50)
          await page.evaluate(`[...document.querySelectorAll('.fixture__controls button')].find((button) => button.textContent.trim() === 'Simulate streaming step').click()`)
          for (let attempt = 0; attempt < 100 && !await page.evaluate(`document.querySelector('.workspace__topbar .trace[data-run="true"]') !== null && document.querySelector('.status-bar') === null`); attempt += 1) await Bun.sleep(50)
          await Bun.sleep(400)
          const planes = await page.evaluate(measure, (value: unknown) => { const record = decodeRecord(value); return { canvasToRaised: decodeNumber(record["canvasToRaised"]), chromeToRaised: decodeNumber(record["chromeToRaised"]), edgeOnChrome: decodeNumber(record["edgeOnChrome"]), edgeOnCanvas: decodeNumber(record["edgeOnCanvas"]), edgeOnRaised: decodeNumber(record["edgeOnRaised"]), headerTraceOffset: decodeNumber(record["headerTraceOffset"]) } })
          if (theme === "light") {
            expect(planes.canvasToRaised, theme).toBeGreaterThanOrEqual(1.15)
            expect(planes.chromeToRaised, theme).toBeGreaterThanOrEqual(1.1)
          }
          for (const key of ["edgeOnChrome", "edgeOnCanvas", "edgeOnRaised"] as const) expect(planes[key], `${theme} ${key}`).toBeGreaterThanOrEqual(3)
          expect(Math.abs(planes.headerTraceOffset), `${theme} header trace on the bottom boundary`).toBeLessThanOrEqual(2)
          const running = await page.evaluate(animations, decodeAnimations)
          if (!reduced) {
            expect(running.filter((animation) => animation.name === "trace-run" && animation.loop).length, theme).toBeGreaterThanOrEqual(1)
            continue
          }
          expect(running.filter((animation) => animation.loop || animation.travel), `${theme} reduced`).toEqual([])
          expect(running.filter((animation) => animation.duration > 150), `${theme} reduced`).toEqual([])
          const exit = await page.evaluate(`new Promise((resolve) => {
            const start = performance.now()
            document.querySelector('.activity-bar a[data-destination="sessions"]').click()
            const check = () => !document.querySelector('.route-panel--exiting') && location.pathname === '/remote/sessions' ? resolve(performance.now() - start) : performance.now() - start > 2000 ? resolve(-1) : requestAnimationFrame(check)
            check()
          })`, decodeNumber)
          expect(exit, `${theme} reduced exit`).toBeGreaterThanOrEqual(0)
          expect(exit, `${theme} reduced exit`).toBeLessThan(140)
        }
      }
    } finally {
      await page.setReducedMotion(false)
      await page.close()
    }
  }, 60_000)

  test("keeps the handoff viewport matrix usable on public and remote surfaces", async () => {
    const page = await requireBrowser().openPage()
    for (const [width, height] of [[320, 568], [360, 740], [430, 932], [1024, 1366], [1280, 800], [1920, 1080]] as const) {
      for (const theme of width === 1024 ? ["light", "dark"] as const : ["light"] as const) {
        await page.setViewport(width, height)
        for (const path of ["/", "/docs/quickstart", "/changelog", "/verify/remote.html?view=chat", "/verify/remote.html?view=settings"]) {
          await page.navigate(url(path))
          if (path.includes("view=chat")) for (let attempt = 0; attempt < 50 && !await page.evaluate(`document.querySelector('.composer') !== null`); attempt += 1) await Bun.sleep(50)
          const layout = await page.evaluate(`(() => {
            document.documentElement.dataset.theme = ${JSON.stringify(theme)}
            const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
            const controls = [...document.querySelectorAll('.app-header button, .app-header a, .activity-bar a, .bottom-nav a, .site-header button, .site-header a')].filter(visible)
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              escaped: controls.filter(element => { const box = element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1 }).map(element => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName),
              undersizedTabs: [...document.querySelectorAll('.activity-bar a')].filter(visible).filter(element => { const box = element.getBoundingClientRect(); return box.width < 44 || box.height < 44 }).map(element => element.textContent?.trim() ?? ''),
              composer: visible(document.querySelector('.composer')),
            }
          })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, overflow: (decodeBoolean)(record["overflow"]), escaped: (decodeArray(decodeString))(record["escaped"]), undersizedTabs: (decodeArray(decodeString))(record["undersizedTabs"]), composer: (decodeBoolean)(record["composer"]) } })
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

function fixturePath(scenario: { readonly view: string; readonly noSelection?: boolean }): string {
  if (scenario.view === "chat") return scenario.noSelection ? "/remote" : "/remote/session"
  return `/remote/${scenario.view}`
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
