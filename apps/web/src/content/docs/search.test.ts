import { describe, expect, test } from "bun:test"
import { PUBLIC_DOC_PATHS } from "./registry"
import { searchDocs } from "./search"

describe("searchDocs", () => {
  test.each(["", "   ", "zzzz-unfindable-term"])("returns nothing for %p", (query) => {
    expect(searchDocs(query)).toHaveLength(0)
  })

  test.each([
    ["guardrails", "configuration/guardrails"],
    ["GUARDRAILS", "configuration/guardrails"],
    ["Notifications", "configuration/notifications"],
    ["models", "configuration/models"],
  ])("ranks the page titled by %s first, ignoring case", (query, slug) => {
    expect(searchDocs(query)[0]?.page.slug).toBe(slug)
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

  test("limits results and only ever returns allowlisted pages", () => {
    const hits = searchDocs("session", 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(5)
    for (const hit of hits) expect(PUBLIC_DOC_PATHS).toContain(`/docs/${hit.page.slug}`)
  })
})
