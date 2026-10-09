import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4483
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
type Logged = { readonly at: number; readonly operation: string; readonly input?: unknown }
type Frame = { readonly at: number; readonly text: number; readonly frame: boolean; readonly content: boolean }

const panel = `document.querySelector(".workspace__scroll .route-panel:not([inert])")`
const usage = {
  href: "/remote/usage",
  frame: `${panel}?.querySelector(".usage-page h1")`,
  content: `${panel}?.querySelector(".usage-provider") && ${panel}?.querySelector(".usage-chart svg")`,
}
const settings = {
  href: "/remote/settings",
  frame: `${panel}?.querySelector("#machine-settings")`,
  content: `${panel}?.querySelector('section[aria-labelledby="machine-settings"] .defs__row[aria-busy="false"] .machine-awake__status')`,
}

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
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

describe("remote route transitions with a slow relay", () => {
  for (const route of [usage, settings]) test(`opening ${route.href} paints its frame at once and never blanks the panel`, async () => {
    const page = await requireBrowser().openPage()
    try {
      await openConversation(page, 400)
      const frames = await follow(page, route)
      const blank = frames.filter((frame) => frame.text === 0)
      expect(blank, `no frame leaves the active panel empty: ${JSON.stringify(frames.slice(0, 6))}`).toEqual([])
      expect(frames.findIndex((frame) => frame.frame), "the page frame or its skeleton paints within two frames").toBeLessThanOrEqual(1)
      expect(frames.at(-1)?.content, "the content arrives with the data").toBe(true)
    } finally { await page.close() }
  }, 60_000)

  test("returning to Usage within the stale window shows cached content on the first frame without a usage read", async () => {
    const page = await requireBrowser().openPage()
    try {
      await openConversation(page, 400)
      await follow(page, usage)
      await follow(page, settings)
      await drain(page)
      const frames = await follow(page, usage)
      await Bun.sleep(900)
      expect(frames[0]?.content, `cached usage paints on the first frame: ${JSON.stringify(frames.slice(0, 3))}`).toBe(true)
      expect((await drain(page)).filter((entry) => entry.operation.startsWith("usage."))).toEqual([])
    } finally { await page.close() }
  }, 60_000)

  test("hovering the Usage link preloads its reads so the click paints content on the first frame", async () => {
    const page = await requireBrowser().openPage()
    try {
      await openConversation(page, 400)
      await drain(page)
      const link = await page.evaluate<{ readonly x: number; readonly y: number }>(`(() => {
        const box = document.querySelector('.remote-nav a[href="/remote/usage"]').getBoundingClientRect()
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      })()`)
      const hoveredAt = await page.evaluate<number>("performance.now()")
      await page.mouse("mouseMoved", link.x, link.y)
      await until(page, `window.requestLog.filter((entry) => entry.operation === "usage.report").length === 3 && window.requestLog.some((entry) => entry.operation === "usage.providers")`)
      const preloaded = await drain(page)
      expect(Math.max(...preloaded.map((entry) => entry.at)) - hoveredAt, "the hover, not the idle warm-up, issued the reads").toBeLessThan(1_000)
      const frames = await follow(page, usage)
      expect(frames[0]?.content, `preloaded usage paints on the first frame: ${JSON.stringify(frames.slice(0, 3))}`).toBe(true)
      await Bun.sleep(600)
      expect((await drain(page)).filter((entry) => entry.operation.startsWith("usage."))).toEqual([])
    } finally { await page.close() }
  }, 60_000)

  test("a cold load shows a loading placeholder, never the New-session composer, until the session list resolves", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.injectOnNewDocument(`(() => {
        const seen = { composer: undefined, listed: undefined }
        window.coldLoad = seen
        new MutationObserver(() => {
          if (seen.listed === undefined && window.requestLog?.some((entry) => entry.operation === "session.list" && entry.input?.workspace !== undefined)) seen.listed = performance.now()
          if (seen.composer === undefined && document.querySelector(".new-session-composer")) seen.composer = performance.now()
        }).observe(document, { subtree: true, childList: true, characterData: true })
      })()`)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&latency=400`)
      await until(page, `document.querySelector(".transcript-message")`)
      const seen = await page.evaluate<{ readonly composer?: number; readonly listed?: number }>("window.coldLoad")
      expect(seen.listed, "the workspace session list resolved").toBeNumber()
      expect(seen.composer ?? Infinity, "the New-session composer never painted before the session list resolved").toBeGreaterThanOrEqual(seen.listed ?? 0)
    } finally { await page.close() }
  }, 60_000)

  test("a cold load reads each resource once and the route tour reuses warmed reads", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&latency=50`)
      await until(page, `document.querySelector(".transcript-message") && window.requestLog.some((entry) => entry.operation === "usage.summary")`)
      await Bun.sleep(1_000)
      const cold = await drain(page)
      const keys = cold.map((entry) => `${entry.operation} ${JSON.stringify(entry.input ?? null)}`)
      expect(keys.filter((key, index) => keys.indexOf(key) !== index), "no read repeats with the same input").toEqual([])
      expect(cold.map((entry) => entry.operation).filter((operation) => operation.startsWith("usage.") || operation === "machine.keepAwake.get").sort(),
        "the idle warm-up read Usage and keep-awake once").toEqual(["machine.keepAwake.get", "usage.providers", "usage.report", "usage.report", "usage.report", "usage.summary"])
      const tour = []
      for (const route of [usage, settings, { href: "/remote/session?session_id=ses_fixture&device_id=dev_studio", frame: `${panel}?.querySelector(".transcript-message")`, content: `${panel}?.querySelector(".transcript-message")` }, usage]) {
        await follow(page, route)
        await Bun.sleep(700)
        tour.push(...await drain(page))
      }
      expect(tour.map((entry) => entry.operation).filter((operation) => operation.startsWith("usage.") || operation === "workspace.list"),
        "warmed Usage and workspace reads are not read again during the tour").toEqual([])
      expect(tour.map((entry) => entry.operation).filter((operation) => operation === "machine.keepAwake.get"),
        "opening Settings re-reads keep-awake once because the machine can change it outside the browser").toEqual(["machine.keepAwake.get"])
      // 20 reads open the workspace and Session, 7 warm Usage, keep-awake and workspaces, and the tour adds one keep-awake re-read
      // plus the two per-Session list reads Conversation refreshes: well inside the relay's 117-per-window budget.
      expect(cold.length + tour.length, `requests: ${JSON.stringify([...cold, ...tour].map((entry) => entry.operation))}`).toBeLessThanOrEqual(30)
    } finally { await page.close() }
  }, 60_000)
})

async function openConversation(page: Page, latency: number) {
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&latency=${latency}`)
  await until(page, `document.querySelector(".transcript-message")`)
}

async function follow(page: Page, route: { readonly href: string; readonly frame: string; readonly content: string }) {
  return page.evaluate<Frame[]>(`(async () => {
    const link = [...document.querySelectorAll(".remote-nav a, .workspace-resume")].find((anchor) => anchor.getAttribute("href") === ${JSON.stringify(route.href)})
    const start = performance.now()
    const frames = []
    link.click()
    for (let index = 0; index < 300; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const active = ${panel}
      const content = Boolean(${route.content})
      frames.push({ at: Math.round(performance.now() - start), text: active?.textContent.trim().length ?? 0, frame: Boolean(${route.frame}), content })
      if (content) break
    }
    return frames
  })()`)
}

function drain(page: Page) {
  return page.evaluate<Logged[]>("window.requestLog.splice(0)")
}

async function until(page: Page, expression: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return
    await Bun.sleep(50)
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
