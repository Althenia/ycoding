import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4206
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

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
  if (!(await ready())) throw new Error("Vite did not start the theme scheme fixture server")
  browser = await launchBrowser(browserPath, 390, 844)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("web color schemes", () => {
  test("selects a scheme in mobile Settings, paints its mode, and restores it on reload", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setMobileViewport(390, 844)
      await page.navigate(`${url()}/verify/remote.html?view=settings&noSelection=1`)
      await waitFor(page, `document.querySelector('section[aria-labelledby="appearance-settings"] [aria-label="Color scheme"]') instanceof HTMLButtonElement`)
      await selectScheme(page, "One Dark")
      await waitFor(page, `document.documentElement.dataset.scheme === 'onedark'`)
      const light = await page.evaluate<{ scheme: string; mode: string; background: string; overflow: boolean }>(`(() => ({
        scheme: document.documentElement.dataset.scheme ?? '',
        mode: document.documentElement.dataset.theme ?? '',
        background: getComputedStyle(document.documentElement).getPropertyValue('--yc-bg').trim(),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }))()`)
      expect(light).toEqual({ scheme: "onedark", mode: "light", background: "#fafafa", overflow: false })

      await page.evaluate<void>(`[...document.querySelectorAll('section[aria-labelledby="appearance-settings"] [role="radio"]')].find(option => option.textContent?.trim() === 'Dark')?.click()`)
      await waitFor(page, `document.documentElement.dataset.theme === 'dark'`)
      const dark = await page.evaluate<{ scheme: string; mode: string; background: string; text: string; persistedScheme: string; persistedMode: string }>(`(() => ({
        scheme: document.documentElement.dataset.scheme ?? '',
        mode: document.documentElement.dataset.theme ?? '',
        background: getComputedStyle(document.documentElement).getPropertyValue('--yc-bg').trim(),
        text: getComputedStyle(document.documentElement).getPropertyValue('--yc-text').trim(),
        persistedScheme: localStorage.getItem('ycoding.theme-scheme') ?? '',
        persistedMode: localStorage.getItem('ycoding.theme') ?? '',
      }))()`)
      expect(dark).toEqual({ scheme: "onedark", mode: "dark", background: "#282c34", text: "#b6bdca", persistedScheme: "onedark", persistedMode: "dark" })

      await page.navigate(`${url()}/verify/remote.html?view=settings&noSelection=1`)
      await waitFor(page, `document.documentElement.dataset.scheme === 'onedark' && document.documentElement.dataset.theme === 'dark'`)
      expect(await page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue('--yc-bg').trim()`)).toBe("#282c34")

      await selectScheme(page, "One Dark Pro")
      await waitFor(page, `document.documentElement.dataset.scheme === 'onedark-pro'`)
      await page.evaluate<void>(`[...document.querySelectorAll('section[aria-labelledby="appearance-settings"] [role="radio"]')].find(option => option.textContent?.trim() === 'Light')?.click()`)
      await waitFor(page, `document.documentElement.dataset.theme === 'light'`)
      expect(await page.evaluate<{ scheme: string; background: string }>(`({ scheme: document.documentElement.dataset.scheme, background: getComputedStyle(document.documentElement).getPropertyValue('--yc-bg').trim() })`)).toEqual({ scheme: "onedark-pro", background: "#ffffff" })

      await selectScheme(page, "High contrast")
      await waitFor(page, `document.documentElement.dataset.scheme === 'high-contrast'`)
      expect(await page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue('--yc-green-strong').trim()`)).toBe("#004521")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("repaints a resident Settings tab when another tab changes its scheme", async () => {
    const first = await requireBrowser().openPage()
    const second = await requireBrowser().openPage()
    try {
      await first.navigate(url())
      await first.evaluate<void>(`localStorage.setItem('ycoding.theme', 'light'); localStorage.setItem('ycoding.theme-scheme', 'default')`)
      await first.setViewport(1440, 900)
      await first.navigate(`${url()}/verify/remote.html?view=settings&noSelection=1`)
      await waitFor(first, `document.querySelector('section[aria-labelledby="appearance-settings"] [aria-label="Color scheme"]') instanceof HTMLButtonElement`)
      expect(await first.evaluate<{ scheme: string; mode: string }>(`({ scheme: document.documentElement.dataset.scheme, mode: document.documentElement.dataset.theme })`)).toEqual({ scheme: "default", mode: "light" })
      await second.setViewport(1440, 900)
      await second.navigate(`${url()}/verify/remote.html?view=settings&noSelection=1`)
      await waitFor(second, `document.documentElement.dataset.scheme === 'default' && document.documentElement.dataset.theme === 'light'`)
      await selectScheme(second, "High contrast")
      await waitFor(first, `document.documentElement.dataset.scheme === 'high-contrast'`)
      const rendered = await first.evaluate<{ scheme: string; background: string; overflow: boolean }>(`(() => ({
        scheme: document.documentElement.dataset.scheme ?? '',
        background: getComputedStyle(document.documentElement).getPropertyValue('--yc-bg').trim(),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }))()`)
      expect(rendered).toEqual({ scheme: "high-contrast", background: "#ffffff", overflow: false })
    } finally {
      await first.close()
      await second.close()
    }
  }, 30_000)

  test("keeps the live browser theme-color tags aligned with an explicit scheme", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.navigate(url())
      await page.evaluate<void>(`localStorage.setItem('ycoding.theme', 'dark'); localStorage.setItem('ycoding.theme-scheme', 'onedark-pro')`)
      await page.navigate(url())
      await waitFor(page, `document.documentElement.dataset.scheme === 'onedark-pro' && document.documentElement.dataset.theme === 'dark'`)
      expect(await page.evaluate<{ colors: string[]; media: string[]; background: string }>(`({
        colors: [...document.querySelectorAll('meta[name="theme-color"]')].map(tag => tag.getAttribute('content') ?? ''),
        media: [...document.querySelectorAll('meta[name="theme-color"]')].map(tag => tag.getAttribute('media') ?? ''),
        background: getComputedStyle(document.documentElement).getPropertyValue('--yc-bg').trim(),
      })`)).toEqual({ colors: ["#282c34", "#282c34"], media: ["", ""], background: "#282c34" })
    } finally {
      await page.close()
    }
  }, 20_000)

  test("applies High contrast for System and Default but preserves explicit scheme or mode choices", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setColorScheme("light")
      await page.navigate(url())
      await page.evaluate<void>(`localStorage.setItem('ycoding.theme', 'system'); localStorage.setItem('ycoding.theme-scheme', 'default')`)
      await page.injectOnNewDocument(`(() => {
        const native = window.matchMedia.bind(window)
        window.matchMedia = query => {
          const media = native(query)
          if (query !== '(prefers-contrast: more)') return media
          return new Proxy(media, { get(target, key) {
            if (key === 'matches') return true
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          } })
        }
      })()`)
      await page.navigate(url())
      await waitFor(page, `document.documentElement.dataset.scheme === 'high-contrast' && document.documentElement.dataset.theme === 'light'`)
      expect(await page.evaluate<{ background: string; accent: string; preference: string }>(`({
        background: getComputedStyle(document.documentElement).getPropertyValue('--yc-bg').trim(),
        accent: getComputedStyle(document.documentElement).getPropertyValue('--yc-green-strong').trim(),
        preference: document.documentElement.dataset.themePreference ?? '',
      })`)).toEqual({ background: "#ffffff", accent: "#004521", preference: "system" })

      await page.navigate(`${url()}/verify/remote.html?view=settings&noSelection=1`)
      await waitFor(page, `document.documentElement.dataset.scheme === 'high-contrast'`)
      await selectScheme(page, "One Dark")
      await waitFor(page, `document.documentElement.dataset.scheme === 'onedark'`)
      expect(await page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue('--yc-bg').trim()`)).toBe("#fafafa")

      await selectScheme(page, "Default")
      await page.evaluate<void>(`[...document.querySelectorAll('section[aria-labelledby="appearance-settings"] [role="radio"]')].find(option => option.textContent?.trim() === 'Light')?.click()`)
      await waitFor(page, `document.documentElement.dataset.scheme === 'default' && document.documentElement.dataset.themePreference === 'light'`)
      expect(await page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue('--yc-green-strong').trim()`)).toBe("#0a7b47")
    } finally {
      await page.close()
    }
  }, 20_000)
})

async function waitFor(page: { evaluate<T>(expression: string): Promise<T> }, expression: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(50)
  }
  throw new Error(`Browser condition did not settle: ${expression}; page text: ${await page.evaluate<string>("document.body.innerText")}`)
}

async function selectScheme(page: { evaluate<T>(expression: string): Promise<T> }, label: string) {
  await page.evaluate<void>(`document.querySelector('section[aria-labelledby="appearance-settings"] [aria-label="Color scheme"]').scrollIntoView({ block: 'center' })`)
  await page.evaluate<void>(`document.querySelector('section[aria-labelledby="appearance-settings"] [aria-label="Color scheme"]').click()`)
  await waitFor(page, `document.querySelector('dialog.custom-select__dialog [role="listbox"], .custom-select__surface [role="listbox"]') !== null`)
  const compact = await page.evaluate<boolean>(`document.querySelector('dialog.custom-select__dialog') !== null`)
  await page.evaluate<void>(`[...document.querySelectorAll(${JSON.stringify(compact ? "dialog.custom-select__dialog [role=option]" : ".custom-select__surface [role=option]")})].find(option => option.textContent?.includes(${JSON.stringify(label)}))?.click()`)
  if (compact) await page.evaluate<void>(`document.querySelector('dialog.custom-select__dialog .custom-select__confirm')?.click()`)
}

async function ready(): Promise<boolean> {
  return fetch(`${url()}/verify/remote.html`).then((response) => response.ok, () => false)
}

function url(): string {
  return `http://127.0.0.1:${port}`
}

function requireBrowser() {
  if (!browser) throw new Error("Browser setup did not complete")
  return browser
}
