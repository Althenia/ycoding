import { expect, test } from "bun:test"
import matter from "gray-matter"
import { ConfigMarkdown } from "../../src/config/markdown"

const parserCache = () => {
  const cache: unknown = Reflect.get(matter, "cache")
  if (cache === null || typeof cache !== "object") throw new Error("Expected the parser cache")
  return cache
}

test.each(["valid", "sanitized"] as const)(
  "should leave no retained document revisions when parsing %s frontmatter repeatedly",
  (syntax) => {
    const id = `changing-skill-${crypto.randomUUID()}`
    const preserved = `---\nname: preserved-${crypto.randomUUID()}\n---\nExisting consumer`
    const cache = parserCache()
    matter(preserved)
    const existing = Reflect.get(cache, preserved)
    try {
      for (let revision = 0; revision < 16; revision++) {
        const description = syntax === "sanitized" ? `Review: revision ${revision}` : `Revision ${revision}`
        const body = `${revision}:` + "x".repeat(65536)
        const input = `---\nname: ${id}\ndescription: ${description}\n---\n${body}`
        for (let turn = 0; turn < 2; turn++) {
          const parsed = ConfigMarkdown.parse(input)
          expect(parsed.data).toEqual({ name: id, description })
          expect(parsed.content).toBe(body)
        }
      }
      expect(Object.keys(cache).filter((key) => key.includes(id))).toEqual([])
      expect(Reflect.get(cache, preserved)).toBe(existing)
    } finally {
      for (const key of Object.keys(cache))
        if (key.includes(id) || key === preserved) Reflect.deleteProperty(cache, key)
    }
  },
)

test("should reject malformed frontmatter consistently without retaining failed documents", () => {
  const id = `invalid-skill-${crypto.randomUUID()}`
  const input = `---\nname: [\ndescription: ${id}\n---\nInvalid skill`
  const cache = parserCache()
  try {
    for (let turn = 0; turn < 16; turn++) expect(ConfigMarkdown.parseOption(input)).toBeUndefined()
    expect(Object.keys(cache).filter((key) => key.includes(id))).toEqual([])
  } finally {
    for (const key of Object.keys(cache)) if (key.includes(id)) Reflect.deleteProperty(cache, key)
  }
})
