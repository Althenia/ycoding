import { describe, expect, test } from "bun:test"
import { RELEASES, changeTagCounts } from "./changelog"

const TAGS = ["Added", "Changed", "Fixed"] as const

describe("release entries", () => {
  test("includes the latest TUI release at the top of the public changelog", () => {
    const release = RELEASES.find((item) => item.version === "0.6.5")
    expect(RELEASES[0]?.version).toBe("0.6.5")
    expect(release).toMatchObject({
      date: "2026-09-23",
      title: "Sharper prompts and clearer subagent status",
      tags: ["Changed", "Fixed"],
    })
    expect(release?.changes.map((change) => change.text)).toEqual([
      "Show the active credential profile beside the agent in the session header when a provider has multiple credentials.",
      "Rank mini prompt @ agent and reference matches together while preserving backend file-search order.",
      "Keep rejected drafts editable and use a fresh prompt ID for corrected input; uncertain admission and wake retries reuse the exact prompt ID and managed attachments.",
      "Separate completed, cancelled, failed, and lost subagents into the composer's Idle tab, keep their elapsed time frozen, and page through terminal tasks when they are not on the current page.",
      "Update built-in agent guidance for bounded repository searches and refine GSD's orchestration instructions.",
      "Drop stored mini model variants when a resolved model offers no variants, while retaining them until the model catalog resolves.",
    ])
  })

  test("are unique and ordered newest first", () => {
    const versions = RELEASES.map((release) => release.version)
    expect(new Set(versions).size).toBe(versions.length)
    const sorted = [...versions].sort((a, b) => compare(b, a))
    expect(versions).toEqual(sorted)
  })

  test("carry a title, at least one tagged change, and a well-formed date", () => {
    for (const release of RELEASES) {
      expect(release.title.length).toBeGreaterThan(0)
      expect(release.changes.length).toBeGreaterThan(0)
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const change of release.changes) {
        expect(TAGS).toContain(change.tag)
        expect(change.text.trim().length).toBeGreaterThan(10)
      }
      expect(release.tags.length).toBe(new Set(release.tags).size)
      for (const tag of release.tags) expect(TAGS).toContain(tag)
    }
  })

  test("counts changes per tag", () => {
    const counts = changeTagCounts(RELEASES)
    const total = RELEASES.flatMap((release) => release.changes).length
    expect(counts.Added + counts.Changed + counts.Fixed).toBe(total)
  })
})

function compare(a: string, b: string) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
