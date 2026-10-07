import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4719
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(browserPath, 1280, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Remote fixture did not start")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

const recordSystemAlerts = `(() => {
  window.__systemAlerts = [];
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
  const registration = {
    showNotification: async (title, options = {}) => { window.__systemAlerts.push({ title, tag: options.tag }) },
    pushManager: { getSubscription: async () => null },
  };
  ServiceWorkerContainer.prototype.getRegistration = async () => registration;
  ServiceWorkerContainer.prototype.register = async () => registration;
  Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { configurable: true, get: () => Promise.resolve(registration) });
})()`

async function openWorkspace(query: string) {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  await page.injectOnNewDocument(recordSystemAlerts)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&${query}`)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await page.evaluate<boolean>(`Boolean(window.remoteStatus) && document.querySelector('.sessions-page__title') !== null`)) return page
    await Bun.sleep(50)
  }
  await page.close()
  throw new Error("Remote workspace did not mount")
}

describe("System alerts in the remote workspace", () => {
  test("a browser the relay asks to present shows one System alert per new notice, and a notice left to push shows none from the page", async () => {
    const presenting = await openWorkspace("theme=dark")
    try {
      await presenting.evaluate(`window.remoteStatus([], [])`)
      await Bun.sleep(300)
      const baseline = await presenting.evaluate<number>(`window.__systemAlerts.length`)
      await presenting.evaluate(`window.remoteStatus([], ['ses_fixture']); window.remoteStatus([], ['ses_fixture', 'ses_telemetry'])`)
      for (let attempt = 0; attempt < 60 && await presenting.evaluate<number>(`window.__systemAlerts.length`) < baseline + 2; attempt += 1) await Bun.sleep(50)
      await Bun.sleep(200)
      const all = await presenting.evaluate<readonly { readonly title: string; readonly tag: string }[]>(`window.__systemAlerts`)
      const alerts = all.slice(baseline)
      expect(alerts.map((alert) => alert.title)).toEqual(["YCoding — needs your attention", "YCoding — needs your attention"])
      expect(new Set(all.map((alert) => alert.tag)).size).toBe(all.length)
      for (const alert of alerts) expect(alert.tag).toMatch(/^ycoding-dev_[a-z]+-ntc_\d+$/)
    } finally { await presenting.close() }

    const pushed = await openWorkspace("theme=dark&push=delivered")
    try {
      await pushed.evaluate(`window.remoteStatus([], []); window.remoteStatus([], ['ses_fixture'])`)
      for (let attempt = 0; attempt < 60 && !await pushed.evaluate<boolean>(`document.querySelector('.yc-notification-center__badge') !== null`); attempt += 1) await Bun.sleep(50)
      await Bun.sleep(300)
      expect(await pushed.evaluate<boolean>(`document.querySelector('.yc-notification-center__badge') !== null`)).toBe(true)
      expect(await pushed.evaluate<number>(`window.__systemAlerts.length`)).toBe(0)
    } finally { await pushed.close() }
  }, 30_000)

  test("opening a System alert marks its notice read and opens its Session", async () => {
    const page = await openWorkspace("theme=dark")
    const unread = `Number(document.querySelector('.yc-notification-center__badge')?.textContent ?? 0)`
    try {
      await page.evaluate(`window.remoteStatus([], []); window.remoteStatus([], ['ses_fixture'])`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`window.__systemAlerts.length > 0`); attempt += 1) await Bun.sleep(50)
      await Bun.sleep(300)
      const before = await page.evaluate<number>(unread)
      const match = /^ycoding-(dev_[a-z]+)-(ntc_\d+)$/.exec(await page.evaluate<string>(`window.__systemAlerts.at(-1).tag`))
      expect(match).not.toBeNull()
      expect(before).toBeGreaterThan(0)
      await page.evaluate(`window.dispatchEvent(new CustomEvent('ycoding:open-session', { detail: { sessionID: 'ses_fixture', deviceID: '${match?.[1]}', noticeID: '${match?.[2]}' } }))`)
      for (let attempt = 0; attempt < 60 && await page.evaluate<number>(unread) === before; attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<number>(unread)).toBe(before - 1)
      expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote/session")
    } finally { await page.close() }
  }, 30_000)
})
