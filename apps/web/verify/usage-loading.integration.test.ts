import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4197
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60; index++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(browserPath, 1440, 1000)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

for (const [outcome, copy] of [["unsupported", "Update YCoding"], ["error", "Synthetic forecast failure"], ["empty", "No recorded consumption"]]) test(`Usage settles every region when the forecast is ${outcome}`, async () => {
  const page = await browser!.openPage()
  try {
    const started = performance.now()
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=usage&latency=100&usageForecast=${outcome}`)
    const settled = await page.evaluate<{ text: string; elapsed: number; placeholders: number }>(`new Promise((resolve, reject) => {
      const start = performance.now();
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Usage did not settle: ' + document.body.innerText.slice(-600))); }, 10000);
      const inspect = () => {
        const page = document.querySelector('.route-panel:not([inert]) .usage-page');
        const consumption = page?.querySelector('[aria-label="Recorded token consumption"]');
        if (!consumption?.textContent.includes(${JSON.stringify(copy)}) || !page.querySelector('.usage-provider') || !page.querySelector('.usage-tile')) return;
        const placeholders = page.querySelectorAll('.loading-placeholder').length;
        if (placeholders > 0) return;
        clearTimeout(timer); observer.disconnect(); resolve({ text: consumption.textContent, elapsed: performance.now() - start, placeholders });
      };
      const observer = new MutationObserver(inspect); observer.observe(document.body, { childList: true, subtree: true, characterData: true }); inspect();
    })`)
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(settled.placeholders).toBe(0)
    expect(settled.text).toContain("Recorded consumption")
    expect(settled.text).toContain(copy!)
  } finally { await page.close() }
}, 30_000)

for (const scheme of ["dark", "light"] as const) for (const width of [390, 1440]) test(`Usage shows whole-window pace beside the recent forecast at ${width}px in ${scheme}`, async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(width, 900)
    await page.setColorScheme(scheme)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=usage&usageForecast=pace`)
    const shown = await page.evaluate<{ theme: string; labels: string[]; colors: string[]; recent: string[]; openRouterPace: number; overflow: boolean }>(`new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Pace did not render: ' + document.body.innerText.slice(-600))); }, 10000);
      const inspect = () => {
        const page = document.querySelector('.route-panel:not([inert]) .usage-page');
        const labels = [...(page?.querySelectorAll('.usage-quota-pace') ?? [])];
        if (labels.length !== 3) return;
        clearTimeout(timer); observer.disconnect();
        const scroller = page.closest('.workspace__scroll') ?? document.scrollingElement;
        resolve({
          theme: document.documentElement.dataset.theme,
          labels: labels.map((label) => label.textContent),
          colors: labels.map((label) => getComputedStyle(label).color),
          recent: labels.map((label) => label.parentElement.textContent),
          openRouterPace: page.querySelectorAll('[data-provider-id="openrouter"] .usage-quota-pace').length,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || scroller.scrollWidth > scroller.clientWidth,
        });
      };
      const observer = new MutationObserver(inspect); observer.observe(document.body, { childList: true, subtree: true, characterData: true }); inspect();
    })`)
    expect(shown.theme).toBe(scheme)
    expect(shown.labels).toHaveLength(3)
    expect(shown.labels[0]).toBe("Pace: Ahead")
    expect(shown.labels[1]).toBe("Pace: Cutting it close")
    expect(shown.labels[2]).toStartWith("Pace: Will run out ")
    expect(new Set(shown.colors).size).toBe(3)
    expect(shown.recent[0]).toContain("run-out ")
    expect(shown.recent[0]).toContain("medium evidence")
    expect(shown.openRouterPace).toBe(0)
    expect(shown.overflow).toBe(false)
  } finally { await page.close() }
}, 30_000)
