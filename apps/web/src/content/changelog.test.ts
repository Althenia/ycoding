import { describe, expect, test } from "bun:test"
import { RELEASES, changeTagCounts } from "./changelog"

const TAGS = ["Added", "Changed", "Fixed"] as const

describe("release entries", () => {
  test("includes the latest TUI release at the top of the public changelog", () => {
    const latest = RELEASES[0]
    expect(latest).toMatchObject({
      version: "0.7.1",
      date: "2026-09-25",
      title: "Chrome and desktop control",
      tags: ["Added", "Changed", "Fixed"],
    })
    expect(latest?.changes.map((change) => change.text)).toEqual([
      "Pair Chrome from the Mini or full Session and use eligible open tabs, including the active tab.",
      "Open Session-owned background Chrome tabs and group or ungroup eligible inactive profile tabs.",
      "Inspect, capture, and control one targeted macOS app window with Accessibility and Screen Recording authorization.",
      "Record Runpod Ollama cached-input and request-timing diagnostics in Session usage when reported by the worker.",
      "Select refreshed Muse Spark models, including the 1.3 contributor entry, with updated catalog pricing.",
      "Read and capture paired Chrome tabs with site permission but without a hard access review; profile mutations still require hard human review.",
      "Use isolated browsing with installed Chrome 152 or newer on macOS arm64.",
      "Use the GSD agent for direct or delegated delivery with verification.",
      "Install or update the macOS CLI with a signed computer-helper app and replacement rollback.",
      "Keep model-visible tool definitions stable across eligible provider-cache requests; reuse remains provider-controlled.",
      "Reload the Chrome extension with the matching 0.7.1 backend for bridge protocol 3; re-pair if its connection is lost.",
      "Keep the selected model and variant in sync across the Session header and variant picker.",
      "Start landing-screen goals against the returned Session ID.",
      "Restore paired Chrome tabs after reconnect and clean up incomplete pairing attempts.",
    ])
    const release = RELEASES.find((item) => item.version === "0.7.0")
    expect(release).toMatchObject({
      date: "2026-09-24",
      title: "A clearer remote workspace",
      tags: ["Added", "Changed", "Fixed"],
    })
    expect(release?.changes.map((change) => change.text)).toEqual([
      "Open recorded file patches from remote Activity; long diffs scroll within their row.",
      "Use a responsive remote workspace for Sessions, conversation, Activity, approvals, and Settings across phone, tablet, and desktop layouts.",
      "Navigate refreshed landing, documentation, changelog, and offline pages in light and dark themes.",
      "Keep the selected machine and reconnect action when an account refresh reports it offline.",
      "Show a Session's project and directory only when the backend reports them.",
    ])
  })

  test("are unique and ordered newest first", () => {
    const versions = RELEASES.map((release) => release.version)
    expect(versions.slice(0, 8)).toEqual(["0.7.1", "0.7.0", "0.6.10", "0.6.9", "0.6.8", "0.6.7", "0.6.6", "0.6.5"])
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
