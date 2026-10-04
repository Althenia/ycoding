import { describe, expect, test } from "bun:test"
import {
  BLOCKED_PATH_PREFIXES,
  CACHE_NAME,
  OFFLINE_FALLBACK_URL,
  PRECACHE_URLS,
  isBlockedPath,
  shouldCacheStaticAsset,
  shouldHandleNavigation,
} from "./offline"

const origin = "https://ycoding.althenia.app"

describe("precache list", () => {
  test("refreshes cached manifest and app icons for installation", () => {
    expect(CACHE_NAME).toBe("ycoding-web-shell-v3")
  })
  test("contains only same-origin static shell paths", () => {
    expect(PRECACHE_URLS.length).toBeGreaterThan(0)
    for (const url of PRECACHE_URLS) {
      expect(url.startsWith("/")).toBe(true)
      expect(url.includes("?")).toBe(false)
      expect(url.includes("://")).toBe(false)
      expect(isBlockedPath(url)).toBe(false)
    }
  })

  test("precaches the shell entry and the honest offline screen", () => {
    expect(PRECACHE_URLS).toContain("/")
    expect(PRECACHE_URLS).toContain(OFFLINE_FALLBACK_URL)
    expect(PRECACHE_URLS).toContain("/manifest.webmanifest")
    expect(PRECACHE_URLS).toContain("/icons/icon-192.png")
  })
})

describe("offline fallback document", () => {
  test("provides the offline status, public navigation and a safe connection retry without scripts", async () => {
    const html = await Bun.file(new URL("../../public/offline.html", import.meta.url)).text()
    expect(html).toContain('aria-label="Public navigation"')
    expect(html).toContain('aria-labelledby="offline-title"')
    expect(html).toContain('<h1 id="offline-title">You are offline</h1>')
    expect(html).toMatch(/<a[^>]*href="\/remote"[^>]*>\s*Retry\s*<\/a>/)
    expect(html).toContain('href="/docs"')
    expect(html).toContain('href="/changelog"')
    expect(html).toContain("Nothing is queued or sent while offline.")
    expect(html).not.toMatch(/<script|<form|https?:\/\//)
  })

  test("uses the approved corner scale on the standalone offline card and controls", async () => {
    const html = await Bun.file(new URL("../../public/offline.html", import.meta.url)).text()
    expect(html).toMatch(/main\s*\{[^}]*border-radius:\s*10px/s)
    expect(html).toMatch(/\.offline-icon\s*\{[^}]*border-radius:\s*6px/s)
    expect(html).toMatch(/\.retry\s*\{[^}]*border-radius:\s*10px/s)
  })
})

describe("isBlockedPath", () => {
  test("blocks API, auth, socket, and discovery prefixes by path segment", () => {
    for (const prefix of BLOCKED_PATH_PREFIXES) {
      expect(isBlockedPath(prefix)).toBe(true)
      expect(isBlockedPath(`${prefix}/nested/route`)).toBe(true)
    }
    expect(isBlockedPath("/api/me")).toBe(true)
    expect(isBlockedPath("/api/devices")).toBe(true)
  })

  test("does not block public pages that merely share a prefix substring", () => {
    expect(isBlockedPath("/")).toBe(false)
    expect(isBlockedPath("/docs/usage/remote")).toBe(false)
    expect(isBlockedPath("/documentation")).toBe(false)
    expect(isBlockedPath("/apidocs")).toBe(false)
    expect(isBlockedPath("/authentication-guide")).toBe(false)
  })
})

describe("shouldCacheStaticAsset", () => {
  const request = (url: string, method = "GET", destination = "script", mode = "cors") => ({
    url,
    method,
    destination,
    mode,
  })

  test("caches same-origin static bundle assets and precached shell files", () => {
    expect(shouldCacheStaticAsset(request(`${origin}/assets/index-abc123.js`), origin)).toBe(true)
    expect(shouldCacheStaticAsset(request(`${origin}/assets/index-abc123.css`, "GET", "style"), origin)).toBe(true)
    expect(shouldCacheStaticAsset(request(`${origin}/brand/ycoding-mark.svg`, "GET", "image"), origin)).toBe(true)
  })

  test("never caches API, auth, socket, or cross-origin responses", () => {
    expect(shouldCacheStaticAsset(request(`${origin}/api/me`, "GET", ""), origin)).toBe(false)
    expect(shouldCacheStaticAsset(request(`${origin}/auth/google/callback`, "GET", ""), origin)).toBe(false)
    expect(shouldCacheStaticAsset(request(`${origin}/ws/v4/client`, "GET", "websocket"), origin)).toBe(false)
    expect(shouldCacheStaticAsset(request("https://example.com/assets/app.js"), origin)).toBe(false)
  })

  test("never caches mutations or document navigations", () => {
    expect(shouldCacheStaticAsset(request(`${origin}/assets/index-abc123.js`, "POST"), origin)).toBe(false)
    expect(shouldCacheStaticAsset(request(`${origin}/docs/usage`, "GET", "document", "navigate"), origin)).toBe(false)
  })
})

describe("shouldHandleNavigation", () => {
  test("handles same-origin document navigations for public routes", () => {
    expect(shouldHandleNavigation({ url: `${origin}/docs/usage`, method: "GET", mode: "navigate" })).toBe(true)
    expect(shouldHandleNavigation({ url: `${origin}/remote/settings`, method: "GET", mode: "navigate" })).toBe(true)
  })

  test("leaves API, auth, and socket requests to the network", () => {
    expect(shouldHandleNavigation({ url: `${origin}/api/me`, method: "GET", mode: "navigate" })).toBe(false)
    expect(shouldHandleNavigation({ url: `${origin}/auth/google`, method: "GET", mode: "navigate" })).toBe(false)
    expect(shouldHandleNavigation({ url: `${origin}/ws/v4/client`, method: "GET", mode: "cors" })).toBe(false)
    expect(shouldHandleNavigation({ url: `${origin}/docs/usage`, method: "POST", mode: "navigate" })).toBe(false)
  })

  test("leaves navigations to published text files to the network so they never replace the cached shell", () => {
    for (const path of ["/llms.txt", "/llms-full.txt", "/docs/quickstart.md", "/docs/index.md", "/sitemap.xml"]) {
      expect({ path, handled: shouldHandleNavigation({ url: `${origin}${path}`, method: "GET", mode: "navigate" }) }).toEqual({ path, handled: false })
    }
  })
})
