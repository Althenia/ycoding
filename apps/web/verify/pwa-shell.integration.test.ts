import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { CACHE_NAME } from "../src/pwa/offline"
import { launchBrowser } from "./cdp"

const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: Bun.Subprocess | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let origin = ""

beforeAll(async () => {
  if (!existsSync(new URL("../dist/index.html", import.meta.url))) throw new Error("Build apps/web before checking the PWA shell")
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 4391 + (process.pid % 100) + attempt * 101
    const candidate = Bun.spawn(["node_modules/.bin/vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "ignore",
      stderr: "ignore",
    })
    for (let poll = 0; poll < 60 && candidate.exitCode === null; poll += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) {
          server = candidate
          origin = `http://127.0.0.1:${port}`
          browser = await launchBrowser(browserPath, 390, 844)
          return
        }
      } catch {
        // The local preview server has not started yet.
      }
      await Bun.sleep(100)
    }
    candidate.kill()
    await candidate.exited
  }
  throw new Error("Vite preview did not start for the built PWA check")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("built PWA shell in Chrome", () => {
  test("resolves explicit light and system preferences before first paint", async () => {
    for (const [width, height] of [[320, 568], [390, 844], [430, 932], [768, 1024], [1024, 1366], [1280, 800], [1440, 900], [1920, 1080]] as const) {
      for (const [preference, scheme, expected] of [["light", "dark", "light"], ["system", "dark", "dark"], ["system", "light", "light"]] as const) {
        const themeServer = previewWithWorker(() => undefined)
        const page = await browser!.openPage()
        try {
          await page.setViewport(width, height)
          await page.disableCache()
          await page.setColorScheme(scheme)
          await page.injectOnNewDocument(`(() => {
          try { localStorage.setItem('ycoding.theme', ${JSON.stringify(preference)}) } catch {}
          window.__themeChanges = [];
          new MutationObserver(records => {
            for (const record of records) {
              if (record.attributeName === 'data-theme' && record.target === document.documentElement) {
                window.__themeChanges.push({ previous: record.oldValue, current: document.documentElement.dataset.theme ?? '', at: performance.now() });
              }
            }
          }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-theme'] });
        })()`)
          await page.navigate(`${themeServer.url.origin}/docs/quickstart`)
          const state = await page.evaluate<{
            readonly heading: string
            readonly preference: string
            readonly theme: string
            readonly systemDark: boolean
            readonly overflow: boolean
            readonly firstPaint: number | null
            readonly changes: readonly { readonly previous: string | null; readonly current: string; readonly at: number }[]
          }>(`({
          heading: document.querySelector('.docs-article > h1')?.textContent?.trim() ?? '',
          preference: document.documentElement.dataset.themePreference ?? '',
          theme: document.documentElement.dataset.theme ?? '',
          systemDark: matchMedia('(prefers-color-scheme: dark)').matches,
          overflow: document.documentElement.scrollWidth > innerWidth,
          firstPaint: performance.getEntriesByType('paint').find(entry => entry.name === 'first-paint')?.startTime ?? null,
          changes: window.__themeChanges ?? [],
        })`)
          expect(state.heading).toBe("Quickstart")
          expect(state.preference).toBe(preference)
          expect(state.theme).toBe(expected)
          expect(state.systemDark).toBe(scheme === "dark")
          expect(state.overflow).toBe(false)
          expect(state.firstPaint).not.toBeNull()
          expect(state.changes.some((change) => change.previous === "light" && change.current === expected && change.at <= state.firstPaint!)).toBe(true)
          console.info(`built theme paint probe: ${JSON.stringify({ width, height, preference, scheme, resolved: state.theme, themeAt: state.changes[0]?.at, firstPaint: state.firstPaint })}`)
        } finally {
          await page.close()
          await themeServer.stop(true)
        }
      }
    }
  }, 30_000)

  test("applies the stored theme before first paint on cold and delayed public navigations", async () => {
    const slowServer = previewWithWorker(() => undefined, { path: "/changelog", delayMs: 750 })
    const page = await browser!.openPage()
    const read = () => page.evaluate<{
      readonly path: string
      readonly heading: string
      readonly theme: string
      readonly preference: string
      readonly changes: readonly { readonly previous: string | null; readonly current: string; readonly at: number }[]
      readonly firstPaint: number | null
      readonly firstContentfulPaint: number | null
      readonly layoutShift: number
      readonly overflow: boolean
    }>(`(() => ({
      path: location.pathname,
      heading: document.querySelector('.docs-article > h1')?.textContent?.trim() ?? '',
      theme: document.documentElement.dataset.theme ?? '',
      preference: document.documentElement.dataset.themePreference ?? '',
      changes: window.__paintTrace?.changes ?? [],
      firstPaint: performance.getEntriesByType('paint').find(entry => entry.name === 'first-paint')?.startTime ?? null,
      firstContentfulPaint: performance.getEntriesByType('paint').find(entry => entry.name === 'first-contentful-paint')?.startTime ?? null,
      layoutShift: window.__paintTrace?.shifts.reduce((sum, value) => sum + value, 0) ?? 0,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }))()`)
    const settle = async (path: string, heading: string) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = await read()
        if (state.path === path && state.heading === heading && state.firstPaint !== null && state.firstContentfulPaint !== null) return state
        await Bun.sleep(100)
      }
      throw new Error(`Timed out waiting for painted ${path}: ${JSON.stringify(await read())}`)
    }
    try {
      await page.disableCache()
      await page.injectOnNewDocument(`(() => {
        try { localStorage.setItem('ycoding.theme', 'dark') } catch {}
        window.__paintTrace = { changes: [], shifts: [] };
        new MutationObserver(records => {
          for (const record of records) {
            if (record.attributeName === 'data-theme' && record.target === document.documentElement) {
              window.__paintTrace.changes.push({ previous: record.oldValue, current: document.documentElement.dataset.theme ?? '', at: performance.now() });
            }
          }
        }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-theme'] });
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__paintTrace.shifts.push(entry.value);
        }).observe({ type: 'layout-shift', buffered: true });
      })()`)

      await page.navigate(`${slowServer.url.origin}/docs/quickstart`)
      const cold = await settle("/docs/quickstart", "Quickstart")
      expect(cold.preference).toBe("dark")
      expect(cold.theme).toBe("dark")
      expect(cold.changes.some((change) => change.previous === "light" && change.current === "dark" && change.at <= cold.firstPaint!)).toBe(true)
      expect(cold.overflow).toBe(false)
      expect(cold.layoutShift).toBeLessThanOrEqual(0.1)
      await Bun.sleep(1200)
      expect((await read()).layoutShift).toBeLessThanOrEqual(0.1)

      await page.navigate(`${slowServer.url.origin}/changelog`)
      const delayed = await settle("/changelog", "Changelog")
      console.info(`built paint probe: ${JSON.stringify({ cold: { firstPaint: cold.firstPaint, fcp: cold.firstContentfulPaint, theme: cold.changes, layoutShift: cold.layoutShift }, delayed: { firstPaint: delayed.firstPaint, fcp: delayed.firstContentfulPaint, theme: delayed.changes, layoutShift: delayed.layoutShift } })}`)
      expect(delayed.preference).toBe("dark")
      expect(delayed.theme).toBe("dark")
      expect(delayed.changes.some((change) => change.previous === "light" && change.current === "dark" && change.at >= 650 && change.at <= delayed.firstPaint!)).toBe(true)
      expect(delayed.overflow).toBe(false)
      expect(delayed.layoutShift).toBeLessThanOrEqual(0.1)
      await Bun.sleep(1200)
      expect((await read()).layoutShift).toBeLessThanOrEqual(0.1)

      for (const [width, height] of [[320, 568], [768, 1024], [1440, 900]] as const) {
        await page.setViewport(width, height)
        await page.navigate(`${slowServer.url.origin}/docs/quickstart?viewport=${width}`)
        const sample = await settle("/docs/quickstart", "Quickstart")
        expect(sample.theme).toBe("dark")
        expect(sample.changes.some((change) => change.previous === "light" && change.current === "dark" && change.at <= sample.firstPaint!)).toBe(true)
        expect(sample.overflow).toBe(false)
        await Bun.sleep(1200)
        const later = await read()
        expect(later.heading).toBe("Quickstart")
        expect(later.layoutShift).toBeLessThanOrEqual(0.1)
        expect(later.overflow).toBe(false)
        console.info(`built viewport paint probe: ${JSON.stringify({ width, height, themeAt: sample.changes[0]?.at, firstPaint: sample.firstPaint, fcp: sample.firstContentfulPaint, lateLayoutShift: later.layoutShift })}`)
      }
    } finally {
      await page.close()
      await slowServer.stop(true)
    }
  }, 30_000)

  test("retains the visible frame while a slow public navigation is in flight", async () => {
    let signalRequest = () => {}
    const requested = new Promise<void>((resolve) => { signalRequest = resolve })
    let release = () => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    const digest = (png: string) => createHash("sha256").update(png).digest("hex")
    const slowServer = previewWithWorker(() => undefined, { path: "/changelog", hold, onRequest: signalRequest })
    const page = await browser!.openPage()
    try {
      await page.disableCache()
      await page.navigate(`${slowServer.url.origin}/docs/quickstart`)
      await Bun.sleep(1200)
      expect(await page.evaluate<string>(`document.querySelector('.docs-article > h1')?.textContent?.trim() ?? ''`)).toBe("Quickstart")
      const baseline = await page.screenshot()
      expect(baseline.length).toBeGreaterThan(1000)
      const navigation = page.navigate(`${slowServer.url.origin}/changelog`)
      expect(await Promise.race([requested.then(() => true), Bun.sleep(2_000).then(() => false)])).toBe(true)
      const first = await page.screenshot()
      await Bun.sleep(800)
      const second = await page.screenshot()
      console.info(`built in-flight frame digests: ${JSON.stringify({ baseline: digest(baseline), first: digest(first), second: digest(second) })}`)
      expect(digest(first)).toBe(digest(baseline))
      expect(digest(second)).toBe(digest(baseline))
      release()
      await navigation
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.docs-article > h1')?.textContent?.trim() === 'Changelog'`)) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<string>(`document.querySelector('.docs-article > h1')?.textContent?.trim() ?? ''`)).toBe("Changelog")
      console.info(`built in-flight frames: two Chrome PNG frames matched the settled docs frame before releasing a changelog response held for at least 800 ms; encoded PNG SHA-256 ${digest(baseline)}`)
    } finally {
      release()
      await page.close()
      await slowServer.stop(true)
    }
  }, 30_000)

  test("replaces old shell caches without deleting unrelated origin caches", async () => {
    const page = await browser!.openPage()
    try {
      await page.allowServiceWorker()
      await page.navigate(`${origin}/offline.html`)
      const names = await page.evaluate<readonly string[]>(`(async () => {
        await caches.open('ycoding-web-shell-v1');
        const unrelated = await caches.open('unrelated-local-cache');
        await unrelated.put('/', new Response('<p>Unrelated cached shell</p>', { headers: { 'content-type': 'text/html' } }));
        await navigator.serviceWorker.register('/sw.js', { type: 'module' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        }
        return caches.keys();
      })()`)
      expect(names).toContain("ycoding-web-shell-v2")
      expect(names).not.toContain("ycoding-web-shell-v1")
      expect(names).toContain("unrelated-local-cache")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("registers the worker and serves a public navigation while offline without caching API requests", async () => {
    const page = await browser!.openPage()
    try {
      await page.allowServiceWorker()
      await page.navigate(origin)
      const ready = await page.evaluate<boolean>(`(async () => {
        const registration = await navigator.serviceWorker.ready;
        if (!registration.active || !registration.scope.startsWith(location.origin)) return false;
        if (!navigator.serviceWorker.controller) {
          await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        }
        return Boolean(navigator.serviceWorker.controller) &&
          (await (await fetch('/manifest.webmanifest')).json()).display === 'standalone';
      })()`)
      expect(ready).toBe(true)
      expect(await page.installabilityErrors()).toEqual([])

      await page.setOffline(true)
      await page.navigate(`${origin}/docs/offline-probe`)
      const offline = await page.evaluate<{ readonly controlled: boolean; readonly publicShell: boolean; readonly privateReadFailed: boolean }>(`(async () => {
        let privateReadFailed = false;
        try { await fetch('/api/health'); } catch { privateReadFailed = true; }
        return {
          controlled: Boolean(navigator.serviceWorker.controller),
          publicShell: Boolean(document.querySelector('#app')) && Boolean(document.querySelector('a[href="/docs"]')),
          privateReadFailed,
        };
      })()`)
      expect(offline).toEqual({ controlled: true, publicShell: true, privateReadFailed: true })
    } finally {
      await page.setOffline(false)
      await page.close()
    }
  }, 30_000)

  test("keeps the controlling worker usable after a failed update and retries online", async () => {
    let failUpdate = false
    const updateServer = previewWithWorker(() => failUpdate ? new Response("Temporarily unavailable", { status: 503 }) : undefined)
    const page = await browser!.openPage()
    try {
      await page.allowServiceWorker()
      await page.navigate(updateServer.url.origin)
      expect(await page.evaluate<boolean>(`(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        }
        return Boolean(navigator.serviceWorker.controller);
      })()`)).toBe(true)

      failUpdate = true
      expect(await page.evaluate<{ readonly failed: boolean; readonly active: boolean }>(`(async () => {
        const registration = await navigator.serviceWorker.ready;
        const active = registration.active;
        try {
          await registration.update();
          return { failed: false, active: registration.active === active };
        } catch {
          return { failed: true, active: registration.active === active };
        }
      })()`)).toEqual({ failed: true, active: true })
      await page.setOffline(true)
      await page.navigate(`${updateServer.url.origin}/docs/update-recovery-probe`)
      expect(await page.evaluate<boolean>(`Boolean(navigator.serviceWorker.controller) &&
        Boolean(document.querySelector('#app')) && Boolean(document.querySelector('a[href="/docs"]'))`)).toBe(true)

      await page.setOffline(false)
      failUpdate = false
      await page.navigate(updateServer.url.origin)
      expect(await page.evaluate<boolean>(`(async () => {
        const registration = await navigator.serviceWorker.ready;
        await registration.update();
        return Boolean(registration.active) && Boolean(navigator.serviceWorker.controller);
      })()`)).toBe(true)
    } finally {
      await page.setOffline(false)
      await page.close()
      await updateServer.stop(true)
    }
  }, 30_000)

  test("upgrades a v1 worker to v2 and keeps the shell usable through an immediate outage", async () => {
    const worker = await Bun.file(new URL("../dist/sw.js", import.meta.url)).text()
    expect(worker).toContain(CACHE_NAME)
    const previousSource = process.env.YCODING_WEB_V1_WORKER
    const previousWorker = previousSource === undefined
      ? worker.replaceAll(CACHE_NAME, "ycoding-web-shell-v1")
      : await Bun.file(previousSource).text()
    expect(previousWorker).toContain("ycoding-web-shell-v1")
    expect(previousWorker).not.toBe(worker)
    let publishedWorker = previousWorker
    const updateServer = previewWithWorker(() => new Response(publishedWorker, {
      headers: { "content-type": "text/javascript", "cache-control": "no-store" },
    }))
    const updateOrigin = updateServer.url.origin
    let serverStopped = false
    const page = await browser!.openPage()
    try {
      await page.allowServiceWorker()
      await page.navigate(updateServer.url.origin)
      expect(await page.evaluate<{ readonly controlled: boolean; readonly names: readonly string[] }>(`(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        }
        await caches.open('unrelated-local-cache');
        return { controlled: Boolean(navigator.serviceWorker.controller), names: await caches.keys() };
      })()`)).toEqual({ controlled: true, names: ["ycoding-web-shell-v1", "unrelated-local-cache"] })

      publishedWorker = worker
      expect(await page.evaluate<{ readonly switched: boolean; readonly active: boolean; readonly names: readonly string[] }>(`(async () => {
        const registration = await navigator.serviceWorker.ready;
        const previous = navigator.serviceWorker.controller;
        await registration.update();
        for (let attempt = 0; attempt < 60; attempt++) {
          if (navigator.serviceWorker.controller !== previous && registration.active?.state === 'activated' &&
            !(await caches.keys()).includes('ycoding-web-shell-v1')) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return {
          switched: navigator.serviceWorker.controller !== previous,
          active: registration.active?.state === 'activated',
          names: await caches.keys(),
        };
      })()`)).toEqual({ switched: true, active: true, names: ["unrelated-local-cache", CACHE_NAME] })
      const previousFailures = page.networkFailures().length
      await updateServer.stop(true)
      serverStopped = true
      await page.navigate(`${updateOrigin}/docs/transport-outage-probe`)
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await page.evaluate<boolean>(`Boolean(document.querySelector('a[href="/docs"]'))`)) break
        await Bun.sleep(50)
      }
      expect({
        state: await page.evaluate(`({ path: location.pathname, controlled: Boolean(navigator.serviceWorker.controller), docs: Boolean(document.querySelector('a[href="/docs"]')) })`),
        failures: page.networkFailures().slice(previousFailures),
      }).toEqual({ state: { path: "/docs/transport-outage-probe", controlled: true, docs: true }, failures: [] })
    } finally {
      await page.setOffline(false)
      await page.close()
      if (!serverStopped) await updateServer.stop(true)
    }
  }, 30_000)
})

function previewWithWorker(workerResponse: () => Response | undefined, slow?: { readonly path: string; readonly delayMs?: number; readonly hold?: Promise<void>; readonly onRequest?: () => void }) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === slow?.path) {
        slow.onRequest?.()
        if (slow.hold) await slow.hold
        if (slow.delayMs !== undefined) await Bun.sleep(slow.delayMs)
      }
      const override = url.pathname === "/sw.js" ? workerResponse() : undefined
      if (override) return override
      const response = await fetch(new URL(`${url.pathname}${url.search}`, origin))
      const headers = new Headers(response.headers)
      headers.delete("content-encoding")
      headers.delete("content-length")
      return new Response(response.body, { status: response.status, headers })
    },
  })
}
