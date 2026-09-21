import { describe, expect, test } from "bun:test"
import { matchPath, matchRoutes, normalizePath, parseLocation } from "./route"

describe("parseLocation", () => {
  test("splits path, query, and hash", () => {
    expect(parseLocation("/docs/usage/tui?q=search#installation")).toEqual({
      path: "/docs/usage/tui",
      hash: "installation",
    })
    expect(parseLocation("/changelog")).toEqual({ path: "/changelog", hash: "" })
    expect(parseLocation("")).toEqual({ path: "/", hash: "" })
  })

  test("normalizes trailing slashes and duplicate separators", () => {
    expect(parseLocation("/docs/").path).toBe("/docs")
    expect(parseLocation("/docs//usage///").path).toBe("/docs/usage")
    expect(parseLocation("/").path).toBe("/")
    expect(normalizePath("docs")).toBe("/docs")
  })

  test("decodes percent-encoded path segments", () => {
    expect(parseLocation("/docs/usage%20guide").path).toBe("/docs/usage guide")
  })
})

describe("matchPath", () => {
  test("matches exact paths only", () => {
    expect(matchPath("/", "/")).toEqual({})
    expect(matchPath("/", "/docs")).toBeNull()
    expect(matchPath("/changelog", "/changelog")).toEqual({})
    expect(matchPath("/docs", "/docs/usage")).toBeNull()
  })

  test("captures a single dynamic segment", () => {
    expect(matchPath("/docs/:section/:page", "/docs/usage/tui")).toEqual({ section: "usage", page: "tui" })
    expect(matchPath("/docs/:section", "/docs/usage/tui")).toBeNull()
    expect(matchPath("/docs/:section", "/docs//")).toBeNull()
  })

  test("captures a multi-segment wildcard and requires at least one segment", () => {
    expect(matchPath("/docs/*slug", "/docs/usage")).toEqual({ slug: "usage" })
    expect(matchPath("/docs/*slug", "/docs/usage/tui")).toEqual({ slug: "usage/tui" })
    expect(matchPath("/docs/*slug", "/docs")).toBeNull()
    expect(matchPath("/*rest", "/")).toBeNull()
    expect(matchPath("/*rest", "/anything/else")).toEqual({ rest: "anything/else" })
  })

  test("is case sensitive and ignores trailing separators", () => {
    expect(matchPath("/docs", "/Docs")).toBeNull()
    expect(matchPath("/docs/*slug", "/docs/usage/")).toEqual({ slug: "usage" })
  })
})

describe("matchRoutes", () => {
  const routes = [
    { path: "/", id: "landing" },
    { path: "/docs", id: "docs-index" },
    { path: "/docs/*slug", id: "docs-page" },
    { path: "/remote", id: "remote" },
  ] as const

  test("returns the first declared match", () => {
    expect(matchRoutes(routes, "/")?.route.id).toBe("landing")
    expect(matchRoutes(routes, "/docs")?.route.id).toBe("docs-index")
    expect(matchRoutes(routes, "/docs/usage/tui")).toEqual({ route: routes[2], params: { slug: "usage/tui" } })
    expect(matchRoutes(routes, "/remote")?.route.id).toBe("remote")
  })

  test("returns null for unknown paths including unknown trailing segments", () => {
    expect(matchRoutes(routes, "/unknown")).toBeNull()
    expect(matchRoutes(routes, "/remote/unknown")).toBeNull()
  })
})
