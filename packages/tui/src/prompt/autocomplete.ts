// Pure ordering/merging helpers for the prompt autocomplete menu.
// Kept out of the component so they can be tested without a terminal renderer.

import { displaySlice, promptOffsetWidth } from "./display"

export type MentionEntry = { path: string; type: "file" | "directory" }

/** Number of non-file options (agents, references, MCP resources) shown above file results. */
export const AUTOCOMPLETE_NON_FILE_LIMIT = 5

/** Leading rows reserved for folders so a flood of file hits can never hide them. */
export const MENTION_DIRECTORY_LIMIT = 8

/** Total file-system rows a mention query contributes to the menu. */
export const MENTION_RESULT_LIMIT = 20

/** Backend entries carry a trailing platform separator on directories; keys ignore it. */
function mentionKey(entry: MentionEntry) {
  return entry.path.replaceAll("\\", "/").replace(/\/+$/, "")
}

/**
 * Folders and files are searched separately because a single mixed search lets file hits
 * take every slot, which is why existing folders never reached the menu. Folders keep the
 * leading rows, both groups keep their backend ranking, and a path returned by both
 * searches is listed once.
 */
export function mergeFileSearchEntries<T extends MentionEntry>(directories: readonly T[], files: readonly T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const entry of [...directories.slice(0, MENTION_DIRECTORY_LIMIT), ...files]) {
    if (result.length >= MENTION_RESULT_LIMIT) break
    const key = mentionKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

/**
 * Non-file options are capped so they can never push file results out of the menu.
 * When there are no file results (slash commands, skills) the list is returned untouched.
 */
export function mergeAutocompleteOptions<T>(nonFiles: readonly T[], files: readonly T[]): T[] {
  if (files.length === 0) return [...nonFiles]
  return [...nonFiles.slice(0, AUTOCOMPLETE_NON_FILE_LIMIT), ...files]
}

/** Async results resize the menu, so the highlighted row must be pulled back in range. */
export function clampAutocompleteIndex(index: number, count: number) {
  if (count <= 0) return 0
  if (index < 0) return 0
  return Math.min(index, count - 1)
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
