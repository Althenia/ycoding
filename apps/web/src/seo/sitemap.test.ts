import { describe, expect, test } from "bun:test"
import { PUBLIC_DOC_PATHS } from "../content/docs/registry"
import { SITE } from "../content/site"
import { resolveRouteMetadata } from "./metadata"
import { SITEMAP_PATHS, buildSitemap } from "./sitemap"

describe("sitemap public route set", () => {
  test("reuses the published documentation allowlist plus the fixed public pages", () => {
    const expected = ["/", "/docs", "/changelog", ...PUBLIC_DOC_PATHS]
    expect(SITEMAP_PATHS.length).toBe(expected.length)
    expect(new Set(SITEMAP_PATHS).size).toBe(SITEMAP_PATHS.length)
    for (const path of expected) expect(SITEMAP_PATHS).toContain(path)
  })

  test("lists only routes the metadata resolver marks indexable", () => {
    for (const path of SITEMAP_PATHS) expect({ path, kind: resolveRouteMetadata(path).kind }).toEqual({ path, kind: "public" })
  })

  test("never lists the private workspace or an unpublished documentation path", () => {
    for (const path of ["/remote", "/remote/sessions", "/docs/does-not-exist", "/docs/architecture"]) {
      expect(SITEMAP_PATHS).not.toContain(path)
    }
  })
})

describe("sitemap document", () => {
  test("emits one canonical absolute URL per public route on the product origin", () => {
    const document = buildSitemap()
    expect(document.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(document).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')

    const locations = [...document.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    expect(locations).toEqual(SITEMAP_PATHS.map((path) => `${SITE.origin}${path}`))
    expect(new Set(locations).size).toBe(locations.length)
  })

  test("carries no query, fragment, private workspace, or unpublished documentation URL", () => {
    const document = buildSitemap()
    const locations = [...document.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    expect(locations.length).toBeGreaterThan(0)
    for (const location of locations) {
      expect(location).not.toContain("?")
      expect(location).not.toContain("#")
    }
    for (const privatePath of ["/remote", "/remote/sessions", "/remote/activity", "/remote/settings"]) {
      expect(locations).not.toContain(`${SITE.origin}${privatePath}`)
    }
    expect(document).not.toContain("does-not-exist")
    expect(document).not.toContain("architecture")
  })
})
