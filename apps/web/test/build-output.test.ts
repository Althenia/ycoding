import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"

/**
 * Verifies the built artifact, not the source: the shell, the service worker,
 * the PWA files, and the responsive CSS that ships to the browser.
 *
 * The suite requires a production build and fails without one: an absent `dist`
 * is a missing verification step, not a reason to skip the check.
 */
const dist = new URL("../dist/index.html", import.meta.url)

let server: Bun.Subprocess | undefined
let serverOrigin = ""

beforeAll(async () => {
  if (!existsSync(dist)) {
    throw new Error("dist/ is missing: run `bun run build` before `bun run test:integration`")
  }
  // Try a few ports: another preview server may already hold the first candidate.
  const base = 4173 + (process.pid % 200)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = base + attempt * 7
    const candidate = Bun.spawn(
      ["node_modules/.bin/vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    serverOrigin = `http://127.0.0.1:${port}`
    const started = Date.now()
    while (Date.now() - started < 12_000) {
      try {
        const response = await fetch(`${serverOrigin}/`)
        if (response.ok) {
          server = candidate
          return
        }
      } catch {
        // The preview server is still starting.
      }
      if (candidate.exitCode !== null) break
      await Bun.sleep(100)
    }
    candidate.kill()
  }
  throw new Error("vite preview did not start on any candidate port")
}, 60_000)

afterAll(() => {
  server?.kill()
})

describe("built web output", () => {
  test("serves the application shell with the persisted theme and manifest", async () => {
    const response = await fetch(`${serverOrigin}/`)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('localStorage.getItem("ycoding.theme")')
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain("/assets/")
  })

  test("serves every public route through the single-page fallback", async () => {
    for (const route of ["/docs", "/docs/configuration/guardrails", "/docs/usage/remote", "/changelog", "/remote", "/remote/settings"]) {
      const response = await fetch(`${serverOrigin}${route}`)
      expect({ route, status: response.status }).toEqual({ route, status: 200 })
      expect((await response.text()).includes('id="app"')).toBe(true)
    }
  })

  test("serves the service worker from the root without hashing", async () => {
    const response = await fetch(`${serverOrigin}/sw.js`)
    expect(response.status).toBe(200)
    const source = await response.text()
    expect(source).toContain("ycoding-web-shell-v1")
    // The blocked-path policy ships with the worker, so it skips API, auth, and socket traffic.
    expect(source).toContain('"/api"')
    expect(source).toContain('"/auth"')
    expect(source).toContain('"/ws"')
    // Nothing in the worker opens a cache by a literal name or runs background work.
    expect(source.includes('caches.open("')).toBe(false)
    expect(source.includes("indexedDB")).toBe(false)
    expect(/periodicsync|addEventListener\("sync"/.test(source)).toBe(false)
  })

  test("ships the PWA files and canonical brand assets", async () => {
    const manifest = await (await fetch(`${serverOrigin}/manifest.webmanifest`)).json()
    expect(manifest.start_url).toBe("/")
    for (const path of [...manifest.icons.map((icon: { src: string }) => icon.src), "/offline.html", "/robots.txt", "/brand/ycoding-mark.svg"]) {
      const response = await fetch(`${serverOrigin}${path}`)
      expect({ path, status: response.status }).toEqual({ path, status: 200 })
    }
  })

  test("ships responsive breakpoints for desktop, tablet, and mobile", async () => {
    const html = await (await fetch(`${serverOrigin}/`)).text()
    // Resolve the linked stylesheet instead of assuming a chunk name, so the check
    // holds for any build layout.
    const cssPath = html.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/)?.[1]
    expect(cssPath).toBeDefined()
    const css = (await (await fetch(`${serverOrigin}${cssPath}`)).text()).replace(/\s+/g, "")
    expect(css).toMatch(/@media\(min-width:768px\)/)
    expect(css).toMatch(/@media\(min-width:1280px\)/)
    expect(css).toContain("prefers-reduced-motion")
    expect(css).toMatch(/\[data-theme=?["']?dark["']?\]/)
    // Mobile is the default composition: a single column until the tablet query.
    expect(css).toContain("grid-template-columns:minmax(0,1fr)")
    expect(css).toContain(".workspace__rail,.workspace__activity{display:none")
  })
})
