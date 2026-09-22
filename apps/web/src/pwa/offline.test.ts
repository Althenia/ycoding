import { describe, expect, test } from "bun:test"
import {
  BLOCKED_PATH_PREFIXES,
  OFFLINE_FALLBACK_URL,
  PRECACHE_URLS,
  isBlockedPath,
  shouldCacheStaticAsset,
  shouldHandleNavigation,
} from "./offline"

const origin = "https://ycoding.althenia.app"

describe("precache list", () => {
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
    expect(shouldCacheStaticAsset(request(`${origin}/ws/v3/client`, "GET", "websocket"), origin)).toBe(false)
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
    expect(shouldHandleNavigation({ url: `${origin}/ws/v3/client`, method: "GET", mode: "cors" })).toBe(false)
    expect(shouldHandleNavigation({ url: `${origin}/docs/usage`, method: "POST", mode: "navigate" })).toBe(false)
  })
})

describe("service worker source", () => {
  test("uses the shared policy instead of inlined private paths", async () => {
    const source = await Bun.file(new URL("../service-worker.ts", import.meta.url)).text()
    expect(source).toContain('from "./pwa/offline"')
    expect(source).toContain("CACHE_NAME")
    expect(source).toContain("PRECACHE_URLS")
    expect(source).toContain("shouldHandleNavigation")
    expect(source).toContain("shouldCacheStaticAsset")
    expect(source.includes("/api")).toBe(false)
    expect(source.includes("/auth")).toBe(false)
    expect(source.includes("/ws/")).toBe(false)
  })

  test("declares no background mutation queue or deferred delivery", async () => {
    const source = await Bun.file(new URL("../service-worker.ts", import.meta.url)).text()
    expect(source.includes("indexedDB")).toBe(false)
    expect(source.includes("periodicsync")).toBe(false)
    expect(source.includes('addEventListener("sync"')).toBe(false)
    expect(source.includes("Notification")).toBe(false)
    // Cache names and blocked paths come from the shared policy, never literals.
    expect(source.includes('caches.open("')).toBe(false)
    // The offline fallback comes from the policy module rather than a literal.
    expect(source).toContain("OFFLINE_FALLBACK_URL")
  })
})
