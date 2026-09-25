import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { launchBrowser } from "./cdp"
import { STITCH_REMOTE_SCENARIOS, type StitchRemoteScenario } from "./stitch-remote-data"

const port = 4300 + (process.pid % 200)
const origin = `http://127.0.0.1:${port}`
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

const output = new URL("../output/stitch-render3/", import.meta.url).pathname
const viewports = [
  { width: 1440, height: 900, theme: "dark" },
  { width: 768, height: 1024, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
] as const
const publicFamilies = ["p09", "p10", "p11", "p12", "p13", "p14"] as const

function publicPath(family: (typeof publicFamilies)[number], width: number) {
  if (family === "p09") return "/"
  if (family === "p10" || family === "p12") return "/docs"
  if (family === "p11") return "/docs/quickstart"
  if (family === "p13") return "/changelog"
  return width === 390 ? "/offline.html" : "/not-a-route"
}

function publicHeading(family: (typeof publicFamilies)[number], width: number) {
  if (family === "p09") return "Your coding agent. Your machine."
  if (family === "p10" || family === "p12") return "Documentation"
  if (family === "p11") return "Quickstart"
  if (family === "p13") return "Changelog"
  return width === 390 ? "You are offline" : "Page not found"
}

let server: Bun.Subprocess | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["node_modules/.bin/vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && server.exitCode === null; attempt += 1) {
    try {
      if ((await fetch(`${origin}/verify/remote.html`)).ok) {
        browser = await launchBrowser(browserPath, 1440, 900)
        await mkdir(output, { recursive: true })
        return
      }
    } catch {
      // The local fixture server has not started yet.
    }
    await Bun.sleep(100)
  }
  throw new Error("Render-3 fixture server did not start")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

function requireBrowser() {
  if (!browser) throw new Error("Chrome was not initialized")
  return browser
}

async function openRemote(scene: StitchRemoteScenario) {
  const page = await requireBrowser().openPage()
  await page.setViewport(scene.specimen, viewports.find((viewport) => viewport.width === scene.specimen)!.height)
  if (scene.specimen === 390) await page.setCoarsePointer(true)
  await page.navigate(`${origin}/verify/remote.html?stitch=${scene.family}&specimen=${scene.specimen}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`[...${JSON.stringify(scene.expectedText)}].every(text => document.body.innerText.includes(text))`)) return page
    await Bun.sleep(50)
  }
  const missing = await page.evaluate<readonly string[]>(`[...${JSON.stringify(scene.expectedText)}].filter(text => !document.body.innerText.includes(text))`)
  await page.close()
  throw new Error(`${scene.id}: fixture did not render ${JSON.stringify(missing)}`)
}

async function openPublic(family: (typeof publicFamilies)[number], viewport: (typeof viewports)[number]) {
  const page = await requireBrowser().openPage()
  await page.setViewport(viewport.width, viewport.height)
  if (viewport.width === 390) await page.setCoarsePointer(true)
  await page.injectOnNewDocument(`localStorage.setItem('ycoding.theme', ${JSON.stringify(viewport.theme)})`)
  await page.navigate(`${origin}${publicPath(family, viewport.width)}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelector('h1')?.textContent?.trim() === ${JSON.stringify(publicHeading(family, viewport.width))}`)) return page
    await Bun.sleep(50)
  }
  await page.close()
  throw new Error(`${family}-${viewport.width}: public heading did not render`)
}

describe("local render-3 implementation evidence", () => {
  test("captures R01–R08 fixture and P09–P14 public families at desktop, tablet, and phone widths", async () => {
    const captures: {
      readonly family: string
      readonly width: number
      readonly height: number
      readonly route: string
      readonly boundary: "synthetic-remote-fixture" | "public-app" | "static-offline"
      readonly heading: string
      readonly theme: string
      readonly visibleControls: number
      readonly screenshot: string
    }[] = []
    const scenes = [
      ...STITCH_REMOTE_SCENARIOS.map((scene) => ({ family: scene.family, viewport: viewports.find((viewport) => viewport.width === scene.specimen)!, scene })),
      ...publicFamilies.flatMap((family) => viewports.map((viewport) => ({ family, viewport, scene: undefined }))),
    ]
    expect(STITCH_REMOTE_SCENARIOS).toHaveLength(24)
    expect(scenes).toHaveLength(42)
    for (const { family, viewport, scene } of scenes) {
      const page = scene ? await openRemote(scene) : await openPublic(family, viewport)
      try {
        if (family === "p12") {
          const selector = viewport.width === 390 ? ".app-header__menu" : viewport.width === 768 ? ".docs-bar__nav-toggle" : ".docs-search-trigger"
          await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
          expect(await page.evaluate<number>(`document.querySelectorAll('dialog[open]').length`)).toBe(1)
        }
        const rendered = await page.evaluate<{
          readonly route: string
          readonly heading: string
          readonly theme: string
          readonly overflow: boolean
          readonly visibleControls: number
          readonly clippedNavigation: number
          readonly remote: boolean
        }>(`(() => {
          const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden';
          const controls = [...document.querySelectorAll('button,a,input,textarea,select')].filter(visible);
          const navigation = [...document.querySelectorAll('.bottom-nav__item,.remote-nav__link,.docs-bar__nav-toggle,.app-header__menu')].filter(visible);
          return {
            route: location.pathname,
            heading: document.querySelector('h1')?.textContent?.trim() ?? '',
            theme: document.documentElement.dataset.theme ?? 'static',
            overflow: document.documentElement.scrollWidth > innerWidth,
            visibleControls: controls.length,
            clippedNavigation: navigation.filter(element => { const rect = element.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1 || rect.height < 44; }).length,
            remote: document.querySelector('.app .workspace') !== null,
          };
        })()`)
        expect(rendered.overflow, `${family}-${viewport.width}: horizontal overflow`).toBe(false)
        expect(rendered.clippedNavigation, `${family}-${viewport.width}: clipped/undersized navigation`).toBe(0)
        expect(rendered.visibleControls, `${family}-${viewport.width}: no visible controls`).toBeGreaterThan(0)
        if (scene) expect(rendered.remote, `${scene.id}: remote component missing`).toBe(true)
        if (!scene) expect(rendered.heading).toBe(publicHeading(family, viewport.width))
        const screenshot = `${family}-${viewport.width}${family === "p14" && viewport.width === 390 ? "-offline" : ""}.png`
        await Bun.write(join(output, screenshot), Buffer.from(await page.screenshot(), "base64"))
        captures.push({
          family,
          width: viewport.width,
          height: viewport.height,
          route: rendered.route,
          boundary: scene ? "synthetic-remote-fixture" : family === "p14" && viewport.width === 390 ? "static-offline" : "public-app",
          heading: rendered.heading,
          theme: rendered.theme,
          visibleControls: rendered.visibleControls,
          screenshot,
        })
      } finally {
        await page.close()
      }
    }
    expect(new Set(captures.map((capture) => capture.family))).toEqual(new Set([...STITCH_REMOTE_SCENARIOS.map((scene) => scene.family), ...publicFamilies]))
    await Bun.write(join(output, "captures.json"), JSON.stringify({
      label: "local SolidJS render-3 implementation; remote data synthetic; P14 offline is static HTML; no Stitch parity or production assertion",
      captures,
    }, null, 2))
  }, 180_000)

  test("observes keyboard and click state changes across remote and public families", async () => {
    const remote = async (family: StitchRemoteScenario["family"], width: StitchRemoteScenario["specimen"]) =>
      openRemote(STITCH_REMOTE_SCENARIOS.find((scene) => scene.family === family && scene.specimen === width)!)

    const r01 = await remote("r01", 390)
    try {
      expect(await r01.evaluate<number>(`document.querySelectorAll('[role="listbox"]').length`)).toBe(1)
      await r01.evaluate(`document.querySelector('[aria-label="Device"]')?.focus()`)
      expect(await r01.evaluate<string>(`document.activeElement?.getAttribute('aria-label') ?? ''`)).toBe("Device")
      await r01.pressEscape()
      expect(await r01.evaluate<number>(`document.querySelectorAll('[role="listbox"]').length`)).toBe(0)
    } finally { await r01.close() }

    const r02 = await remote("r02", 768)
    try {
      expect(await r02.evaluate<number>(`document.querySelectorAll('.sessions-table__select').length`)).toBe(4)
      await r02.evaluate(`document.querySelectorAll('.session-filters__option')[1]?.click()`)
      expect(await r02.evaluate<string>(`document.querySelectorAll('.session-filters__option')[1]?.getAttribute('aria-pressed') ?? ''`)).toBe("true")
      const running = await r02.evaluate<{ readonly count: number; readonly labeled: boolean }>(`(() => {
        const rows = [...document.querySelectorAll('.sessions-table__row')].filter(row => row.querySelector('.sessions-table__select'));
        return { count: rows.length, labeled: rows.every(row => row.querySelector('.sessions-table__status')?.textContent?.includes('Running')) };
      })()`)
      expect(running.count).toBeGreaterThan(0)
      expect(running.count).toBeLessThan(4)
      expect(running.labeled).toBe(true)
    } finally { await r02.close() }

    const r03 = await remote("r03", 390)
    try {
      expect(await r03.evaluate<string>(`document.querySelector('.tool__toggle')?.getAttribute('aria-expanded') ?? ''`)).toBe("true")
      await r03.evaluate(`document.querySelector('.tool__toggle')?.click()`)
      expect(await r03.evaluate<string>(`document.querySelector('.tool__toggle')?.getAttribute('aria-expanded') ?? ''`)).toBe("false")
      await r03.evaluate(`document.querySelector('.tool__toggle')?.click()`)
      expect(await r03.evaluate<string>(`document.querySelector('.tool__toggle')?.getAttribute('aria-expanded') ?? ''`)).toBe("true")
      expect(await r03.evaluate<boolean>(`[...document.querySelectorAll('.tool pre.output')].some(output => output.textContent?.includes('pool_spin_ok'))`)).toBe(true)
    } finally { await r03.close() }

    const r04 = await remote("r04", 1440)
    try {
      const count = await r04.evaluate<number>(`document.querySelectorAll('.activity-page__decisions .request').length`)
      await r04.evaluate(`document.querySelector('.activity-page__decisions .request--guardrail button.button--danger')?.click()`)
      expect(await r04.evaluate<number>(`document.querySelectorAll('.activity-page__decisions .request').length`)).toBe(count - 1)
    } finally { await r04.close() }

    const r05 = await remote("r05", 1440)
    try {
      expect(await r05.evaluate<readonly string[]>(`[...document.querySelectorAll('.request--hard .request__actions button')].map(button => button.textContent.trim())`)).toEqual(["Approve once", "Reject"])
      await r05.evaluate(`document.querySelector('.request--hard button.button--danger')?.click()`)
      expect(await r05.evaluate<number>(`document.querySelectorAll('.request--hard').length`)).toBe(0)
    } finally { await r05.close() }

    const r06 = await remote("r06", 390)
    try {
      const before = await r06.evaluate<string>(`document.querySelector('[aria-label^="Theme:"]')?.getAttribute('aria-label') ?? ''`)
      expect(before).toContain("Theme:")
      await r06.evaluate(`document.querySelector('[aria-label^="Theme:"]')?.click()`)
      expect(await r06.evaluate<string>(`document.querySelector('[aria-label^="Theme:"]')?.getAttribute('aria-label') ?? ''`)).not.toBe(before)
      expect(await r06.evaluate<boolean>(`document.body.innerText.includes('Sign in to YCoding')`)).toBe(true)
    } finally { await r06.close() }

    const r07 = await remote("r07", 1440)
    try {
      expect(await r07.evaluate<boolean>(`document.body.innerText.includes('Enrollment code (shown once)')`)).toBe(true)
      await r07.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Hide')?.click()`)
      expect(await r07.evaluate<boolean>(`document.body.innerText.includes('Enrollment code (shown once)')`)).toBe(false)
      await r07.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent?.includes('Create enrollment code'))?.click()`)
      expect(await r07.evaluate<boolean>(`document.body.innerText.includes('Enrollment code (shown once)')`)).toBe(true)
    } finally { await r07.close() }

    const r08 = await remote("r08", 768)
    try {
      expect(await r08.evaluate<string>(`document.querySelector('#autonomy-settings + .settings__hint')?.textContent?.trim() ?? ''`)).toContain("Goal active: Refactor telemetry UI")
      await r08.evaluate(`[...document.querySelectorAll('.autonomy-choices button')].find(button => button.textContent?.includes('YOLO 3'))?.focus()`)
      await r08.pressKey(" ", "Space", 32)
      expect(await r08.evaluate<boolean>(`[...document.querySelectorAll('.autonomy-choices button')].some(button => button.textContent?.includes('YOLO 3') && button.getAttribute('aria-checked') === 'true')`)).toBe(true)
      expect(await r08.evaluate<string>(`document.querySelector('#autonomy-settings + .settings__hint')?.textContent?.trim() ?? ''`)).toContain("YOLO 3: levels 1-3 answer questions")
      await Bun.write(join(output, "r08-768-yolo3-after.png"), Buffer.from(await r08.screenshot(), "base64"))
    } finally { await r08.close() }

    const mobile = viewports[2]
    const tablet = viewports[1]
    const desktop = viewports[0]
    const p09 = await openPublic("p09", mobile)
    try {
      await p09.evaluate(`[...document.querySelectorAll('.hero__actions button')].find(button => button.textContent?.trim() === 'Get started')?.click()`)
      expect(await p09.evaluate<string>(`location.pathname`)).toBe("/docs/getting-started")
      expect(await p09.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Getting started")
    } finally { await p09.close() }

    const p10 = await openPublic("p10", tablet)
    try {
      await p10.evaluate(`document.querySelector('.docs-article a[href="/docs/configuration"]')?.click()`)
      expect(await p10.evaluate<string>(`location.pathname`)).toBe("/docs/configuration")
      expect(await p10.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Configuration")
    } finally { await p10.close() }

    const p11 = await openPublic("p11", desktop)
    try {
      await p11.evaluate(`document.querySelector('.docs-toc a[href^="#"]')?.click()`)
      expect(await p11.evaluate<boolean>(`location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1))) !== null`)).toBe(true)
    } finally { await p11.close() }

    const p12 = await openPublic("p12", mobile)
    try {
      await p12.evaluate(`document.querySelector('.app-header__menu')?.click()`)
      expect(await p12.evaluate<number>(`document.querySelectorAll('.overlay--primary-nav[open]').length`)).toBe(1)
      await p12.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
      expect(await p12.evaluate<number>(`document.querySelectorAll('.overlay--docs-search[open]').length`)).toBe(1)
      await p12.pressEscape()
      expect(await p12.evaluate<number>(`document.querySelectorAll('.overlay--primary-nav[open]').length`)).toBe(1)
      expect(await p12.evaluate<number>(`document.querySelectorAll('.overlay--docs-search[open]').length`)).toBe(0)
      for (let attempt = 0; attempt < 20 && !(await p12.evaluate<boolean>(`document.activeElement === document.querySelector('.overlay--primary-nav[open] .docs-search-trigger')`)); attempt += 1) await Bun.sleep(25)
      expect(await p12.evaluate<boolean>(`document.activeElement === document.querySelector('.overlay--primary-nav[open] .docs-search-trigger')`)).toBe(true)
      await p12.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
      expect(await p12.evaluate<number>(`document.querySelectorAll('.overlay--docs-search[open]').length`)).toBe(1)
      await p12.evaluate(`(() => {
        const input = document.querySelector('.overlay--docs-search[open] #docs-search-field');
        if (!(input instanceof HTMLInputElement)) throw new Error('Search input missing');
        input.focus();
        input.value = 'quickstart';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'quickstart' }));
      })()`)
      for (let attempt = 0; attempt < 20 && !(await p12.evaluate<boolean>(`document.querySelector('.overlay--docs-search[open] .search__result-title')?.textContent?.trim() === 'Quickstart'`)); attempt += 1) await Bun.sleep(25)
      const searchState = await p12.evaluate<{ readonly value: string; readonly open: boolean; readonly title: string; readonly empty: string }>(`({
        value: document.querySelector('.overlay--docs-search[open] #docs-search-field')?.value ?? '',
        open: document.querySelector('.overlay--docs-search[open]') !== null,
        title: document.querySelector('.overlay--docs-search[open] .search__result-title')?.textContent?.trim() ?? '',
        empty: document.querySelector('.overlay--docs-search[open] .search__empty')?.textContent?.trim() ?? '',
      })`)
      expect(searchState.value).toBe("quickstart")
      expect(searchState.open).toBe(true)
      expect(searchState.title, JSON.stringify(searchState)).toBe("Quickstart")
      expect(await p12.evaluate<boolean>(`(() => { const input = document.querySelector('.overlay--docs-search[open] #docs-search-field'); return input instanceof HTMLInputElement && document.activeElement === input && input.labels?.length === 1 && input.labels[0].textContent.trim() === 'Search documentation' })()`)).toBe(true)
      await p12.pressKey("Enter", "Enter", 13)
      expect(await p12.evaluate<string>(`location.pathname`)).toBe("/docs/quickstart")
      expect(await p12.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Quickstart")
      await Bun.write(join(output, "p12-390-search-quickstart-after.png"), Buffer.from(await p12.screenshot(), "base64"))
    } finally { await p12.close() }

    const p13 = await openPublic("p13", desktop)
    try {
      expect(await p13.evaluate<boolean>(`document.getElementById('0.7.0')?.textContent?.includes('Open recorded file patches') ?? false`)).toBe(true)
      const fixedFilter = ".docs--changelog .docs-shell__nav .filters--release .filters__group:nth-of-type(2) button:last-of-type"
      expect(await p13.evaluate<boolean>(`(() => { const button = document.querySelector(${JSON.stringify(fixedFilter)}); return button instanceof HTMLButtonElement && button.getBoundingClientRect().width > 0 && button.getAttribute('aria-pressed') === 'false' })()`)).toBe(true)
      for (let attempt = 0; attempt < 45 && !(await p13.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(fixedFilter)})`)); attempt += 1) await p13.pressKey("Tab", "Tab", 9)
      expect(await p13.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(fixedFilter)}) && document.activeElement.matches(':focus-visible') && parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2`)).toBe(true)
      await p13.pressKey(" ", "Space", 32)
      expect(await p13.evaluate<string>(`document.querySelector(${JSON.stringify(fixedFilter)})?.getAttribute('aria-pressed') ?? ''`)).toBe("true")
      expect(await p13.evaluate<number>(`document.querySelectorAll('.release').length`)).toBeGreaterThan(0)
      expect(await p13.evaluate<boolean>(`document.getElementById('0.7.0')?.textContent?.includes('Keep the selected machine and reconnect action') ?? false`)).toBe(true)
      expect(await p13.evaluate<boolean>(`document.getElementById('0.7.0')?.textContent?.includes('Open recorded file patches') ?? false`)).toBe(false)
      expect(await p13.evaluate<boolean>(`[...document.querySelectorAll('.release__change .tag')].length > 0 && [...document.querySelectorAll('.release__change .tag')].every(tag => tag.textContent.trim() === 'Fixed')`)).toBe(true)
      await Bun.write(join(output, "p13-1440-fixed-after.png"), Buffer.from(await p13.screenshot(), "base64"))
    } finally { await p13.close() }

    const p14 = await openPublic("p14", tablet)
    try {
      await p14.evaluate(`document.querySelector('.not-found__actions a[href="/"]')?.click()`)
      expect(await p14.evaluate<string>(`location.pathname`)).toBe("/")
      expect(await p14.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Your coding agent. Your machine.")
    } finally { await p14.close() }

    const p14Offline = await openPublic("p14", mobile)
    try {
      const retry = ".offline-card .retry[href='/remote']"
      expect(await p14Offline.evaluate<boolean>(`document.querySelector(${JSON.stringify(retry)})?.getBoundingClientRect().width > 0`)).toBe(true)
      for (let attempt = 0; attempt < 45 && !(await p14Offline.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(retry)})`)); attempt += 1) await p14Offline.pressKey("Tab", "Tab", 9)
      expect(await p14Offline.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(retry)}) && document.activeElement.matches(':focus-visible') && parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2`)).toBe(true)
      await p14Offline.pressKey("Enter", "Enter", 13)
      for (let attempt = 0; attempt < 50 && !(await p14Offline.evaluate<boolean>(`location.pathname === '/remote' && document.querySelector('.app.app--conversation') !== null`)); attempt += 1) await Bun.sleep(50)
      expect(await p14Offline.evaluate<string>(`location.pathname`)).toBe("/remote")
      expect(await p14Offline.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("No session selected")
      expect(await p14Offline.evaluate<boolean>(`document.querySelector('.offline-card') === null && document.querySelector('.app.app--conversation') !== null`)).toBe(true)
      await Bun.write(join(output, "p14-390-offline-retry-after.png"), Buffer.from(await p14Offline.screenshot(), "base64"))
    } finally { await p14Offline.close() }
  }, 120_000)
})
