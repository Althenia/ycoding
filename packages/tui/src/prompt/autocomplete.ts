// Pure ordering/merging helpers for the prompt autocomplete menu.
// Kept out of the component so they can be tested without a terminal renderer.

import { displaySlice, promptOffsetWidth } from "./display"
import fuzzysort from "fuzzysort"

export type MentionEntry = { path: string; type: "file" | "directory" }

export const MENTION_DIRECTORY_LIMIT = 8

export const MENTION_RESULT_LIMIT = 20

/** Backend entries carry a trailing platform separator on directories; keys ignore it. */
function mentionKey(entry: MentionEntry) {
  return entry.path.replaceAll("\\", "/").replace(/\/+$/, "")
}

export function mergeFileSearchEntries<T extends MentionEntry>(
  directories: readonly T[],
  files: readonly T[],
  query = "",
): T[] {
  const entries = [...directories.slice(0, MENTION_DIRECTORY_LIMIT), ...files]
  const matches = query.trim() ? fuzzysort.go(query.trim().replaceAll("\\", "/"), entries, { key: mentionKey }) : []
  const best = new Set(
    matches.filter((match) => match.score === matches[0]?.score).map((match) => mentionKey(match.obj)),
  )
  const seen = new Set<string>()
  const result: T[] = []
  for (const entry of [
    ...entries.filter((entry) => best.has(mentionKey(entry))),
    ...entries.filter((entry) => !best.has(mentionKey(entry))),
  ]) {
    const key = mentionKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

export function mergeAutocompleteOptions<T>(nonFiles: readonly T[], files: readonly T[]): T[] {
  return [...nonFiles, ...files]
}

/** Async results resize the menu, so the highlighted row must be pulled back in range. */
export function clampAutocompleteIndex(index: number, count: number) {
  if (count <= 0) return 0
  if (index < 0) return 0
  return Math.min(index, count - 1)
}

/** Keep only the rows that can be displayed resident while retaining their indexes in the full list. */
export function autocompleteWindow<T>(options: readonly T[], selected: number, rows: number) {
  const size = Math.max(0, Math.floor(rows))
  if (size === 0 || options.length === 0) return { start: 0, options: options.slice(0, 0) }
  const index = clampAutocompleteIndex(selected, options.length)
  const start = Math.min(Math.max(0, index - size + 1), Math.max(0, options.length - size))
  return { start, options: options.slice(start, start + size) }
}

/** Directory entries already carry a trailing separator; drilling into one must not double it. */
export function expandDirectoryQuery(display: string) {
  const text = display.trim()
  const base = text.startsWith("@") ? text.slice(1) : text
  return base.replace(/[\\/]*$/, "") + "/"
}

export function resourceTriggerIndex(value: string, offset: number) {
  const text = displaySlice(value, 0, offset)
  const index = text.lastIndexOf("#")
  if (index === -1) return undefined

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if (/\s/.test(query)) return undefined
  if (before !== undefined && !/\s/.test(before) && !"([{<\"'`,;:=|".includes(before)) return undefined

  return promptOffsetWidth(text.slice(0, index))
}
