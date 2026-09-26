import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { REMOTE_SCENARIOS, type RemoteScenario } from "./remote-scenarios"

const port = 4300 + (process.pid % 200)
const origin = `http://127.0.0.1:${port}`
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

const viewports = [
  { width: 1440, height: 900, theme: "dark" },
  { width: 768, height: 1024, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
] as const
const publicFamilies = ["home-page", "documentation-index", "quickstart-page", "documentation-search", "changelog", "offline-and-not-found"] as const

function publicPath(scenarioName: (typeof publicFamilies)[number], width: number) {
  if (scenarioName === "home-page") return "/"
  if (scenarioName === "documentation-index" || scenarioName === "documentation-search") return "/docs"
  if (scenarioName === "quickstart-page") return "/docs/quickstart"
  if (scenarioName === "changelog") return "/changelog"
  return width === 390 ? "/offline.html" : "/not-a-route"
}

function publicHeading(scenarioName: (typeof publicFamilies)[number], width: number) {
  if (scenarioName === "home-page") return "Your coding agent. Your machine."
  if (scenarioName === "documentation-index" || scenarioName === "documentation-search") return "Documentation"
  if (scenarioName === "quickstart-page") return "Quickstart"
  if (scenarioName === "changelog") return "Changelog"
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
        return
      }
    } catch {
      // The local fixture server has not started yet.
    }
    await Bun.sleep(100)
  }
  throw new Error("Product-state fixture server did not start")
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

async function openRemote(scene: RemoteScenario) {
  const page = await requireBrowser().openPage()
  await page.setViewport(scene.viewport, viewports.find((viewport) => viewport.width === scene.viewport)!.height)
  if (scene.viewport === 390) await page.setCoarsePointer(true)
  await page.navigate(`${origin}/verify/remote.html?scenario=${scene.name}-${scene.viewport}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`[...${JSON.stringify(scene.expectedText)}].every(text => document.body.innerText.includes(text))`)) return page
    await Bun.sleep(50)
  }
  const missing = await page.evaluate<readonly string[]>(`[...${JSON.stringify(scene.expectedText)}].filter(text => !document.body.innerText.includes(text))`)
  await page.close()
  throw new Error(`${scene.id}: fixture did not render ${JSON.stringify(missing)}`)
}

async function openPublic(scenarioName: (typeof publicFamilies)[number], viewport: (typeof viewports)[number]) {
  const page = await requireBrowser().openPage()
  await page.setViewport(viewport.width, viewport.height)
  if (viewport.width === 390) await page.setCoarsePointer(true)
  await page.injectOnNewDocument(`localStorage.setItem('ycoding.theme', ${JSON.stringify(viewport.theme)})`)
  await page.navigate(`${origin}${publicPath(scenarioName, viewport.width)}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelector('h1')?.textContent?.trim() === ${JSON.stringify(publicHeading(scenarioName, viewport.width))}`)) return page
    await Bun.sleep(50)
  }
  await page.close()
  throw new Error(`${scenarioName}-${viewport.width}: public heading did not render`)
}

describe("remote and public product interactions", () => {
  test("updates navigation, reviews, enrollment, autonomy, search, and release filters through user input", async () => {
    const remote = async (scenarioName: RemoteScenario["name"], width: RemoteScenario["viewport"]) =>
      openRemote(REMOTE_SCENARIOS.find((scene) => scene.name === scenarioName && scene.viewport === width)!)

    const workspace = await remote("conversation-workspace", 390)
    try {
      expect(await workspace.evaluate<number>(`document.querySelectorAll('[role="listbox"]').length`)).toBe(1)
      expect(await workspace.evaluate<boolean>(`document.querySelector('dialog[aria-label="Select Active Machine"]')?.contains(document.activeElement) === true`)).toBe(true)
      await workspace.pressEscape()
      expect(await workspace.evaluate<number>(`document.querySelectorAll('[role="listbox"]').length`)).toBe(0)
      expect(await workspace.evaluate<string>(`document.activeElement?.getAttribute('aria-label') ?? ''`)).toBe("Machine")
    } finally { await workspace.close() }

    const sessions = await remote("session-list", 768)
    try {
      expect(await sessions.evaluate<number>(`document.querySelectorAll('.sessions-table__select').length`)).toBe(4)
      await sessions.evaluate(`document.querySelectorAll('.session-filters__option')[1]?.click()`)
      expect(await sessions.evaluate<string>(`document.querySelectorAll('.session-filters__option')[1]?.getAttribute('aria-pressed') ?? ''`)).toBe("true")
      const running = await sessions.evaluate<{ readonly count: number; readonly labeled: boolean }>(`(() => {
        const rows = [...document.querySelectorAll('.sessions-table__row')].filter(row => row.querySelector('.sessions-table__select'));
        return { count: rows.length, labeled: rows.every(row => row.querySelector('.sessions-table__status')?.textContent?.includes('Running')) };
      })()`)
      expect(running.count).toBeGreaterThan(0)
      expect(running.count).toBeLessThan(4)
      expect(running.labeled).toBe(true)
    } finally { await sessions.close() }

    const conversation = await remote("conversation-tool-terminal-output", 390)
    try {
      expect(await conversation.evaluate<string>(`document.querySelector('.tool__toggle')?.getAttribute('aria-expanded') ?? ''`)).toBe("true")
      await conversation.evaluate(`document.querySelector('.tool__toggle')?.click()`)
      expect(await conversation.evaluate<string>(`document.querySelector('.tool__toggle')?.getAttribute('aria-expanded') ?? ''`)).toBe("false")
      await conversation.evaluate(`document.querySelector('.tool__toggle')?.click()`)
      expect(await conversation.evaluate<string>(`document.querySelector('.tool__toggle')?.getAttribute('aria-expanded') ?? ''`)).toBe("true")
      expect(await conversation.evaluate<boolean>(`[...document.querySelectorAll('.tool pre.output')].some(output => output.textContent?.includes('pool_spin_ok'))`)).toBe(true)
    } finally { await conversation.close() }

    const activity = await remote("activity-pending-decisions", 1440)
    try {
      const count = await activity.evaluate<number>(`document.querySelectorAll('.activity-page__decisions .request').length`)
      await activity.evaluate(`document.querySelector('.activity-page__decisions .request--guardrail button.button--danger')?.click()`)
      expect(await activity.evaluate<number>(`document.querySelectorAll('.activity-page__decisions .request').length`)).toBe(count - 1)
    } finally { await activity.close() }

    const reviews = await remote("permission-guardrail-hard-review-form-requests", 1440)
    try {
      expect(await reviews.evaluate<readonly string[]>(`[...document.querySelectorAll('.request--hard .request__actions button')].map(button => button.textContent.trim())`)).toEqual(["Approve once", "Reject"])
      await reviews.evaluate(`document.querySelector('.request--hard button.button--danger')?.click()`)
      expect(await reviews.evaluate<number>(`document.querySelectorAll('.request--hard').length`)).toBe(0)
    } finally { await reviews.close() }

    const signedOut = await remote("signed-out", 390)
    try {
      const before = await signedOut.evaluate<string>(`document.querySelector('[aria-label^="Theme:"]')?.getAttribute('aria-label') ?? ''`)
      expect(before).toContain("Theme:")
      await signedOut.evaluate(`document.querySelector('[aria-label^="Theme:"]')?.click()`)
      expect(await signedOut.evaluate<string>(`document.querySelector('[aria-label^="Theme:"]')?.getAttribute('aria-label') ?? ''`)).not.toBe(before)
      expect(await signedOut.evaluate<boolean>(`document.body.innerText.includes('Sign in to your workspace')`)).toBe(true)
      await signedOut.evaluate(`[...document.querySelectorAll('.sign-in__provider')].find(button => button.textContent?.trim() === 'Continue with Google')?.click()`)
      for (let attempt = 0; attempt < 40 && !(await signedOut.evaluate<boolean>(`location.pathname === '/api/auth/google/start'`)); attempt += 1) await Bun.sleep(50)
      expect(await signedOut.evaluate<string>(`location.pathname + location.search`)).toBe("/api/auth/google/start?redirect_after=%2Fremote%2Fsettings")
    } finally { await signedOut.close() }

    const enrollment = await remote("devices-enrollment", 1440)
    try {
      expect(await enrollment.evaluate<boolean>(`document.body.innerText.includes('Enrollment code (shown once)')`)).toBe(true)
      await enrollment.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Hide')?.click()`)
      expect(await enrollment.evaluate<boolean>(`document.body.innerText.includes('Enrollment code (shown once)')`)).toBe(false)
      await enrollment.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent?.includes('Create enrollment code'))?.click()`)
      expect(await enrollment.evaluate<boolean>(`document.body.innerText.includes('Enrollment code (shown once)')`)).toBe(true)
    } finally { await enrollment.close() }

    const settings = await remote("autonomy-goal-notification-settings", 768)
    try {
      expect(await settings.evaluate<string>(`document.querySelector('#autonomy-settings + .settings__hint')?.textContent?.trim() ?? ''`)).toContain("Goal active: Refactor telemetry UI")
      await settings.evaluate(`[...document.querySelectorAll('.autonomy-choices button')].find(button => button.textContent?.includes('YOLO 3'))?.focus()`)
      await settings.pressKey(" ", "Space", 32)
      expect(await settings.evaluate<boolean>(`[...document.querySelectorAll('.autonomy-choices button')].some(button => button.textContent?.includes('YOLO 3') && button.getAttribute('aria-checked') === 'true')`)).toBe(true)
      expect(await settings.evaluate<string>(`document.querySelector('#autonomy-settings + .settings__hint')?.textContent?.trim() ?? ''`)).toContain("YOLO 3: levels 1-3 answer questions")
    } finally { await settings.close() }

    const mobile = viewports[2]
    const tablet = viewports[1]
    const desktop = viewports[0]
    const homePage = await openPublic("home-page", mobile)
    try {
      await homePage.evaluate(`[...document.querySelectorAll('.hero__actions button')].find(button => button.textContent?.trim() === 'Get started')?.click()`)
      expect(await homePage.evaluate<string>(`location.pathname`)).toBe("/docs/getting-started")
      expect(await homePage.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Getting started")
    } finally { await homePage.close() }

    const docsIndex = await openPublic("documentation-index", tablet)
    try {
      await docsIndex.evaluate(`document.querySelector('.docs-article a[href="/docs/configuration"]')?.click()`)
      expect(await docsIndex.evaluate<string>(`location.pathname`)).toBe("/docs/configuration")
      expect(await docsIndex.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Configuration")
    } finally { await docsIndex.close() }

    const quickstart = await openPublic("quickstart-page", desktop)
    try {
      await quickstart.evaluate(`document.querySelector('.docs-toc a[href^="#"]')?.click()`)
      expect(await quickstart.evaluate<boolean>(`location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1))) !== null`)).toBe(true)
    } finally { await quickstart.close() }

    const docsSearch = await openPublic("documentation-search", mobile)
    try {
      await docsSearch.evaluate(`document.querySelector('.app-header__menu')?.click()`)
      expect(await docsSearch.evaluate<number>(`document.querySelectorAll('.overlay--primary-nav[open]').length`)).toBe(1)
      await docsSearch.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
      expect(await docsSearch.evaluate<number>(`document.querySelectorAll('.overlay--docs-search[open]').length`)).toBe(1)
      await docsSearch.pressEscape()
      expect(await docsSearch.evaluate<number>(`document.querySelectorAll('.overlay--primary-nav[open]').length`)).toBe(1)
      expect(await docsSearch.evaluate<number>(`document.querySelectorAll('.overlay--docs-search[open]').length`)).toBe(0)
      for (let attempt = 0; attempt < 20 && !(await docsSearch.evaluate<boolean>(`document.activeElement === document.querySelector('.overlay--primary-nav[open] .docs-search-trigger')`)); attempt += 1) await Bun.sleep(25)
      expect(await docsSearch.evaluate<boolean>(`document.activeElement === document.querySelector('.overlay--primary-nav[open] .docs-search-trigger')`)).toBe(true)
      await docsSearch.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
      expect(await docsSearch.evaluate<number>(`document.querySelectorAll('.overlay--docs-search[open]').length`)).toBe(1)
      await docsSearch.evaluate(`(() => {
        const input = document.querySelector('.overlay--docs-search[open] #docs-search-field');
        if (!(input instanceof HTMLInputElement)) throw new Error('Search input missing');
        input.focus();
        input.value = 'quickstart';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'quickstart' }));
      })()`)
      for (let attempt = 0; attempt < 20 && !(await docsSearch.evaluate<boolean>(`document.querySelector('.overlay--docs-search[open] .search__result-title')?.textContent?.trim() === 'Quickstart'`)); attempt += 1) await Bun.sleep(25)
      const searchState = await docsSearch.evaluate<{ readonly value: string; readonly open: boolean; readonly title: string; readonly empty: string }>(`({
        value: document.querySelector('.overlay--docs-search[open] #docs-search-field')?.value ?? '',
        open: document.querySelector('.overlay--docs-search[open]') !== null,
        title: document.querySelector('.overlay--docs-search[open] .search__result-title')?.textContent?.trim() ?? '',
        empty: document.querySelector('.overlay--docs-search[open] .search__empty')?.textContent?.trim() ?? '',
      })`)
      expect(searchState.value).toBe("quickstart")
      expect(searchState.open).toBe(true)
      expect(searchState.title, JSON.stringify(searchState)).toBe("Quickstart")
      expect(await docsSearch.evaluate<boolean>(`(() => { const input = document.querySelector('.overlay--docs-search[open] #docs-search-field'); return input instanceof HTMLInputElement && document.activeElement === input && input.labels?.length === 1 && input.labels[0].textContent.trim() === 'Search documentation' })()`)).toBe(true)
      await docsSearch.pressKey("Enter", "Enter", 13)
      expect(await docsSearch.evaluate<string>(`location.pathname`)).toBe("/docs/quickstart")
      expect(await docsSearch.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Quickstart")
    } finally { await docsSearch.close() }

    const changelog = await openPublic("changelog", desktop)
    try {
      expect(await changelog.evaluate<boolean>(`document.getElementById('0.7.0')?.textContent?.includes('Open recorded file patches') ?? false`)).toBe(true)
      const fixedFilter = ".docs--changelog .docs-shell__nav .filters--release .filters__group:nth-of-type(2) button:last-of-type"
      expect(await changelog.evaluate<boolean>(`(() => { const button = document.querySelector(${JSON.stringify(fixedFilter)}); return button instanceof HTMLButtonElement && button.getBoundingClientRect().width > 0 && button.getAttribute('aria-pressed') === 'false' })()`)).toBe(true)
      for (let attempt = 0; attempt < 45 && !(await changelog.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(fixedFilter)})`)); attempt += 1) await changelog.pressKey("Tab", "Tab", 9)
      expect(await changelog.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(fixedFilter)}) && document.activeElement.matches(':focus-visible') && parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2`)).toBe(true)
      await changelog.pressKey(" ", "Space", 32)
      expect(await changelog.evaluate<string>(`document.querySelector(${JSON.stringify(fixedFilter)})?.getAttribute('aria-pressed') ?? ''`)).toBe("true")
      expect(await changelog.evaluate<number>(`document.querySelectorAll('.release').length`)).toBeGreaterThan(0)
      expect(await changelog.evaluate<boolean>(`document.getElementById('0.7.0')?.textContent?.includes('Keep the selected machine and reconnect action') ?? false`)).toBe(true)
      expect(await changelog.evaluate<boolean>(`document.getElementById('0.7.0')?.textContent?.includes('Open recorded file patches') ?? false`)).toBe(false)
      expect(await changelog.evaluate<boolean>(`[...document.querySelectorAll('.release__change .tag')].length > 0 && [...document.querySelectorAll('.release__change .tag')].every(tag => tag.textContent.trim() === 'Fixed')`)).toBe(true)
    } finally { await changelog.close() }

    const notFound = await openPublic("offline-and-not-found", tablet)
    try {
      await notFound.evaluate(`document.querySelector('.not-found__actions a[href="/"]')?.click()`)
      expect(await notFound.evaluate<string>(`location.pathname`)).toBe("/")
      expect(await notFound.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Your coding agent. Your machine.")
    } finally { await notFound.close() }

    const offlinePage = await openPublic("offline-and-not-found", mobile)
    try {
      const retry = ".offline-card .retry[href='/remote']"
      expect(await offlinePage.evaluate<boolean>(`document.querySelector(${JSON.stringify(retry)})?.getBoundingClientRect().width > 0`)).toBe(true)
      for (let attempt = 0; attempt < 45 && !(await offlinePage.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(retry)})`)); attempt += 1) await offlinePage.pressKey("Tab", "Tab", 9)
      expect(await offlinePage.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(retry)}) && document.activeElement.matches(':focus-visible') && parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2`)).toBe(true)
      await offlinePage.pressKey("Enter", "Enter", 13)
      for (let attempt = 0; attempt < 50 && !(await offlinePage.evaluate<boolean>(`location.pathname === '/remote' && document.querySelector('.app.app--conversation') !== null`)); attempt += 1) await Bun.sleep(50)
      expect(await offlinePage.evaluate<string>(`location.pathname`)).toBe("/remote")
      expect(await offlinePage.evaluate<string>(`document.querySelector('h1')?.textContent?.trim() ?? ''`)).toBe("Remote access is not available")
      expect(await offlinePage.evaluate<boolean>(`document.querySelector('.offline-card') === null && document.querySelector('.app.app--conversation') !== null`)).toBe(true)
    } finally { await offlinePage.close() }
  }, 120_000)
})
