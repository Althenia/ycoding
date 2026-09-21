import type { ReleaseEntry } from "../../src/content/changelog"

export const RELEASES: readonly ReleaseEntry[] = [
  {
    version: "0.4.2",
    date: "2026-09-20",
    title: "Terminal-only product surface",
    tags: ["Changed", "Fixed"],
    changes: [
      { tag: "Changed", text: "The terminal application is the primary and only product surface." },
      { tag: "Fixed", text: "Removed stale references to a second presentation surface from product and contributor guides." },
    ],
  },
  {
    version: "0.4.1",
    date: "2026-09-20",
    title: "Attention notifications and catalog resilience",
    tags: ["Added", "Fixed"],
    changes: [
      { tag: "Added", text: "Attention notifications post from session lifecycle events when notification configuration and permissions allow it." },
      { tag: "Added", text: "Discover MCP-served skills through the Skills extension and load their content lazily after approval." },
      { tag: "Fixed", text: "Routine subagent completion stays silent while pending human input still alerts." },
      { tag: "Fixed", text: "Reconnecting the terminal preserves execution events received while session status loads." },
    ],
  },
]

export function changeTagCounts(releases: readonly ReleaseEntry[]): Record<"Added" | "Changed" | "Fixed", number> {
  return releases
    .flatMap((release) => release.changes)
    .reduce<Record<"Added" | "Changed" | "Fixed", number>>(
      (counts, change) => ({ ...counts, [change.tag]: counts[change.tag] + 1 }),
      { Added: 0, Changed: 0, Fixed: 0 },
    )
}

export function releaseYears(releases: readonly ReleaseEntry[]): readonly string[] {
  return [...new Set(releases.map((release) => release.date.slice(0, 4)))].sort().reverse()
}
