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
  test("replaces the old shared navigation cache on update", () => {
    expect(CACHE_NAME).toBe("ycoding-web-shell-v4")
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
    for (const path of ["/ws/v4/client", "/ws/v5/client", "/api/remote/devices/dev_a/sessions/ses_a/messages/msg_a?connectionEpoch=e&requestID=1&transferID=t"])
      expect(shouldCacheStaticAsset(request(`${origin}${path}`, "GET", "websocket"), origin)).toBe(false)
    expect(shouldCacheStaticAsset(request("https://example.com/assets/app.js"), origin)).toBe(false)
  })

  test("never caches mutations or document navigations", () => {
    expect(shouldCacheStaticAsset(request(`${origin}/assets/index-abc123.js`, "POST"), origin)).toBe(false)
    expect(shouldCacheStaticAsset(request(`${origin}/docs/usage`, "GET", "document", "navigate"), origin)).toBe(false)
  })
})

describe("shouldHandleNavigation", () => {
  test("handles same-origin document navigations for public routes", () => {
    expect(shouldHandleNavigation({ url: `${origin}/docs/usage`, method: "GET", mode: "navigate" }, origin)).toBe(true)
    expect(shouldHandleNavigation({ url: `${origin}/remote/settings`, method: "GET", mode: "navigate" }, origin)).toBe(true)
  })

  test("leaves API, auth, and socket requests to the network", () => {
    expect(shouldHandleNavigation({ url: `${origin}/api/me`, method: "GET", mode: "navigate" }, origin)).toBe(false)
    expect(shouldHandleNavigation({ url: `${origin}/auth/google`, method: "GET", mode: "navigate" }, origin)).toBe(false)
    for (const path of ["/ws/v4/client", "/ws/v5/client", "/ws/v4/agent", "/ws/v5/agent"])
      expect(shouldHandleNavigation({ url: `${origin}${path}`, method: "GET", mode: "navigate" }, origin)).toBe(false)
    expect(shouldHandleNavigation({ url: `${origin}/docs/usage`, method: "POST", mode: "navigate" }, origin)).toBe(false)
  })

  test("leaves navigations to published text files to the network so they never replace the cached shell", () => {
    for (const path of ["/llms.txt", "/llms-full.txt", "/docs/quickstart.md", "/docs/index.md", "/sitemap.xml"]) {
      expect({ path, handled: shouldHandleNavigation({ url: `${origin}${path}`, method: "GET", mode: "navigate" }, origin) }).toEqual({ path, handled: false })
    }
  })
})

test("service worker caches each remote shell separately and never substitutes a different shell offline", async () => {
  const listeners = new Map<string, (event: unknown) => void>()
  const previous = Object.fromEntries(["addEventListener", "location", "caches", "fetch"].map((key) => [key, Reflect.get(globalThis, key)]))
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
  const cached = new Map([["/", html("Public shell")], [OFFLINE_FALLBACK_URL, html("Offline screen")]])
  let network: (() => Response) | undefined
  Reflect.set(globalThis, "addEventListener", (name: string, listener: (event: unknown) => void) => listeners.set(name, listener))
  Reflect.set(globalThis, "location", { origin })
  Reflect.set(globalThis, "caches", { open: async () => ({
    match: async (key: string) => cached.get(key)?.clone(),
    put: async (key: string, response: Response) => { cached.set(key, response) },
  }) })
  Reflect.set(globalThis, "fetch", async () => {
    if (!network) throw new TypeError("Offline")
    return network()
  })
  try {
    const workerModule = "../service-worker.ts?offline-navigation"
    await import(workerModule)
    const navigate = async (path: string) => {
      const request = { url: new URL(path, origin).href, method: "GET", mode: "navigate", destination: "document" }
      let response: Promise<Response> | undefined
      listeners.get("fetch")?.({ request, respondWith: (pending: Promise<Response>) => { response = pending } })
      return response === undefined ? undefined : (await response).text()
    }

    expect(await navigate("/remote/rust/settings")).toBe("Offline screen")
    network = () => html("Bun shell")
    expect(await navigate("/remote/usage?device_id=dev_bun")).toBe("Bun shell")
    network = undefined
    expect(await navigate("/remote/rust/settings")).toBe("Offline screen")
    network = () => html("Rust shell")
    expect(await navigate("/remote/rust/session?session_id=ses_rust")).toBe("Rust shell")
    network = () => Object.defineProperty(html("Redirected outside Rust"), "redirected", { value: true })
    expect(await navigate("/remote/rust/settings")).toBe("Redirected outside Rust")
    network = undefined
    expect(await navigate("/remote/rust/usage")).toBe("Rust shell")
    expect(await navigate("/remote/rusted")).toBe("Bun shell")
    expect(await navigate("/")).toBe("Public shell")
    expect(await navigate("https://example.test/remote/rust")).toBeUndefined()
  } finally {
    for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
  }
})
