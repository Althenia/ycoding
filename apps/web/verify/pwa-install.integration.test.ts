import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4673
const origin = `http://127.0.0.1:${port}`
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

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
        browser = await launchBrowser(browserPath, 390, 844)
        return
      }
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error("PWA fixture server did not start; check that port 4673 is free")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

const safariMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
const safariPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"

async function open(width: 390 | 1440, theme: "light" | "dark", setup = "") {
  const page = await browser!.openPage()
  await page.setViewport(width, width === 390 ? 844 : 900)
  if (width === 390) await page.setCoarsePointer(true)
  await page.injectOnNewDocument(`localStorage.setItem('ycoding.theme', ${JSON.stringify(theme)}); ${setup}`)
  await page.navigate(`${origin}/verify/remote.html?view=settings`)
  for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="app-settings"]') !== null`); attempt += 1) await Bun.sleep(50)
  expect(await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="app-settings"]') !== null`)).toBe(true)
  expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
  expect(await page.evaluate<string>(`document.documentElement.dataset.theme ?? ''`)).toBe(theme)
  return page
}

const button = `[aria-labelledby="app-settings"] button`
const mode = `[aria-labelledby="app-settings"] [role="status"]`
const label = `dialog[aria-label="Install YCoding"]`

describe("Settings installation in a real Chrome render", () => {
  test("captures the install prompt before Settings mounts", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`${origin}/verify/remote.html?view=sessions`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('a[href="/remote/settings"]') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="app-settings"]') !== null`)).toBe(false)
      expect(await page.evaluate<boolean>(`(() => {
        const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
          prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'accepted' })
        });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      })()`)).toBe(true)
      await page.evaluate(`document.querySelector('a[href="/remote/settings"]')?.click()`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('${button}') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelector('${button}') !== null`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  for (const width of [390, 1440] as const) for (const theme of ["light", "dark"] as const) {
    test(`native prompt accepted and dismissed at ${width} in ${theme}`, async () => {
      const page = await open(width, theme)
      try {
        expect(await page.evaluate<string>(`document.querySelector('${mode}')?.textContent?.trim() ?? ''`)).toBe("Browser")
        expect(await page.evaluate<boolean>(`document.querySelector('${button}') !== null`)).toBe(false)
        for (const outcome of ["accepted", "dismissed"] as const) {
          const prevented = await page.evaluate<boolean>(`(() => {
            const event = new Event('beforeinstallprompt', { cancelable: true });
            event.prompt = async () => { window.__promptCalls = (window.__promptCalls ?? 0) + 1 };
            event.userChoice = Promise.resolve({ outcome: '${outcome}' });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          })()`)
          expect(prevented).toBe(true)
          expect(await page.evaluate<boolean>(`document.querySelector('${button}')?.textContent?.trim() === 'Install App'`)).toBe(true)
          await page.evaluate(`document.querySelector('${button}')?.click()`)
          for (let attempt = 0; attempt < 30 && await page.evaluate<boolean>(`document.querySelector('${button}') !== null`); attempt += 1) await Bun.sleep(20)
          expect(await page.evaluate<boolean>(`document.querySelector('${button}') !== null`)).toBe(false)
          expect(await page.evaluate<number>(`window.__promptCalls ?? 0`)).toBe(outcome === "accepted" ? 1 : 2)
          expect(await page.evaluate<boolean>(`document.querySelector('${label}') !== null`)).toBe(false)
        }
        await page.evaluate(`window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'accepted' }) }))`)
        expect(await page.evaluate<boolean>(`document.querySelector('${button}') !== null`)).toBe(true)
        await page.evaluate(`window.dispatchEvent(new Event('appinstalled'))`)
        expect(await page.evaluate<string>(`document.querySelector('${mode}')?.textContent?.trim() ?? ''`)).toBe("Installed app")
        expect(await page.evaluate<boolean>(`document.querySelector('${button}, ${label}') !== null`)).toBe(false)
      } finally { await page.close() }
    }, 30_000)

    test(`standalone display mode at ${width} in ${theme}`, async () => {
      const page = await open(width, theme, `(() => {
        const original = window.matchMedia.bind(window);
        window.matchMedia = query => query === '(display-mode: standalone)' ? { matches: true, addEventListener() {}, removeEventListener() {} } : original(query);
      })()`)
      try {
        expect(await page.evaluate<string>(`document.querySelector('${mode}')?.textContent?.trim() ?? ''`)).toBe("Installed app")
        expect(await page.evaluate<boolean>(`document.querySelector('${button}, ${label}') !== null`)).toBe(false)
      } finally { await page.close() }
    }, 30_000)
  }

  for (const [name, setup, expected] of [
    ["iPhone Safari", `Object.defineProperties(Navigator.prototype, { userAgent: { configurable: true, get: () => ${JSON.stringify(safariPhone)} }, platform: { configurable: true, get: () => 'iPhone' } })`, ["Tap the Share button in Safari.", "Select Add to Home Screen.", "Tap Add."]],
    ["iPad Safari desktop user agent", `Object.defineProperties(Navigator.prototype, { userAgent: { configurable: true, get: () => ${JSON.stringify(safariMac)} }, platform: { configurable: true, get: () => 'MacIntel' }, maxTouchPoints: { configurable: true, get: () => 5 } })`, ["Tap the Share button in Safari.", "Select Add to Home Screen.", "Tap Add."]],
    ["macOS Safari", `Object.defineProperties(Navigator.prototype, { userAgent: { configurable: true, get: () => ${JSON.stringify(safariMac)} }, platform: { configurable: true, get: () => 'MacIntel' }, maxTouchPoints: { configurable: true, get: () => 0 } })`, ["On macOS Sonoma 14 or later, choose File → Add to Dock in Safari.", "Click Add."]],
  ] as const) {
    test(`${name} displays manual instructions with contained focus`, async () => {
      const page = await open(name === "macOS Safari" ? 1440 : 390, "light", setup)
      try {
        expect(await page.evaluate<boolean>(`document.querySelector('${button}') !== null`)).toBe(true)
        await page.evaluate(`document.querySelector('${button}')?.focus(); document.querySelector('${button}')?.click()`)
        for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('${label}')?.open === true`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('${label} li')].map(item => item.textContent.trim())`)).toEqual(expected)
        await page.evaluate(`Promise.all([...document.querySelector('${label}').getAnimations({ subtree: true })].map(animation => animation.finished.catch(() => {})))`)
        expect(await page.evaluate<{ count: number; named: boolean; hit: boolean }>(`(() => { const dialog = document.querySelector('${label}'); const close = dialog?.querySelector('.overlay__close'); const minimum = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-hit-min')); return { count: dialog?.querySelectorAll('.overlay__close').length ?? 0, named: close?.getAttribute('aria-label') === 'Close Install YCoding', hit: (close?.getBoundingClientRect().width ?? 0) >= minimum && (close?.getBoundingClientRect().height ?? 0) >= minimum } })()`)).toEqual({ count: 1, named: true, hit: true })
        expect(await page.evaluate<boolean>(`document.querySelector('${label}')?.contains(document.activeElement) === true`)).toBe(true)
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('${label}')?.contains(document.activeElement) === true`)).toBe(true)
        await page.pressEscape()
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('${button}')`)).toBe(true)
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
      } finally { await page.close() }
    }, 30_000)
  }

  test("unsupported browser has only the Browser status", async () => {
    const page = await open(1440, "dark", `Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 Firefox/130.0' })`)
    try {
      expect(await page.evaluate<string>(`document.querySelector('${mode}')?.textContent?.trim() ?? ''`)).toBe("Browser")
      expect(await page.evaluate<boolean>(`document.querySelector('${button}, ${label}') !== null`)).toBe(false)
    } finally { await page.close() }
  }, 30_000)
})
