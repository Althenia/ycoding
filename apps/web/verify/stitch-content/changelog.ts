import type { ReleaseEntry } from "../../src/content/changelog"

// P13, export-adaptation/p13.html: the approved board supplies placeholders, not release metadata.
export const RELEASES: readonly ReleaseEntry[] = [
  {
    version: "[version]",
    date: "[release date]",
    title: "",
    tags: ["Added", "Changed", "Fixed"],
    changes: [
      { tag: "Added", text: "[release note]" },
      { tag: "Added", text: "[release note]" },
      { tag: "Changed", text: "[release note]" },
      { tag: "Changed", text: "[release note]" },
      { tag: "Fixed", text: "[release note]" },
    ],
  },
  {
    version: "[version]",
    date: "[release date]",
    title: "",
    tags: ["Added", "Changed", "Fixed"],
    changes: [
      { tag: "Added", text: "[release note]" },
      { tag: "Changed", text: "[release note]" },
      { tag: "Fixed", text: "[release note]" },
      { tag: "Fixed", text: "[release note]" },
    ],
  },
]

export function changeTagCounts(releases: readonly ReleaseEntry[]): Record<"Added" | "Changed" | "Fixed", number> {
  return releases.flatMap((release) => release.changes).reduce<Record<"Added" | "Changed" | "Fixed", number>>((counts, change) => ({ ...counts, [change.tag]: counts[change.tag] + 1 }), { Added: 0, Changed: 0, Fixed: 0 })
}

export function releaseYears(releases: readonly ReleaseEntry[]): readonly string[] {
  return [...new Set(releases.map((release) => release.date.slice(0, 4)))].sort().reverse()
}
