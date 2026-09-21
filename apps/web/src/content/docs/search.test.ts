import { describe, expect, test } from "bun:test"
import { PUBLIC_DOC_PATHS } from "./registry"
import { searchDocs } from "./search"

describe("searchDocs", () => {
  test("returns nothing for an empty or blank query", () => {
    expect(searchDocs("")).toHaveLength(0)
    expect(searchDocs("   ")).toHaveLength(0)
  })

  test("finds configuration domains by name", () => {
    const hits = searchDocs("guardrails")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.page.slug).toBe("configuration/guardrails")
  })

  test("is case insensitive", () => {
    expect(searchDocs("GUARDRAILS")[0]?.page.slug).toBe("configuration/guardrails")
    expect(searchDocs("Notifications")[0]?.page.slug).toBe("configuration/notifications")
  })

  test("matches section headings and reports them for deep linking", () => {
    const hit = searchDocs("rejected configuration keys")[0]
    expect(hit?.page.slug).toBe("configuration")
    expect(hit?.matchedHeading).toBe("Rejected configuration keys")
  })

  test("matches body text when no title or heading matches", () => {
    const hits = searchDocs("YCODING_CONFIG_CONTENT")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.page.slug).toBe("configuration")
    expect(hits[0]?.matchedHeading).toBeUndefined()
  })

  test("returns nothing for unknown terms", () => {
    expect(searchDocs("zzzz-unfindable-term")).toHaveLength(0)
  })

  test("ranks title matches above heading and body matches", () => {
    const hits = searchDocs("models")
    expect(hits[0]?.page.slug).toBe("configuration/models")
  })

  test("limits results and only ever returns allowlisted pages", () => {
    const hits = searchDocs("session", 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(5)
    for (const hit of hits) expect(PUBLIC_DOC_PATHS).toContain(`/docs/${hit.page.slug}`)
  })
})
