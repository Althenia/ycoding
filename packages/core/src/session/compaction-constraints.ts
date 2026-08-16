export * as CompactionConstraints from "./compaction-constraints"

import { Hash } from "../util/hash"

export const DEFAULT_COMPACTION_CONSTRAINT_MAX_BYTES = 32 * 1024

const encoder = new TextEncoder()
const byteLength = (value: string) => encoder.encode(value).byteLength

const notice = (items: readonly { readonly text: string; readonly bytes: number }[]) => {
  const bytes = items.reduce((total, item) => total + item.bytes, 0)
  const digest = Hash.sha256(items.map((item) => item.text).join("\0"))
  return `[Omitted ${items.length} compaction constraint block(s), ${bytes} UTF-8 bytes; sha256=${digest}. Reload source rules after compaction if needed.]`
}

export function assembleCompactionConstraints(
  parts: readonly (string | undefined)[],
  maxBytes = DEFAULT_COMPACTION_CONSTRAINT_MAX_BYTES,
): readonly string[] {
  if (maxBytes <= 0) return []
  const items = parts
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .map((text) => ({ text, bytes: byteLength(text) }))
  if (items.length === 0) return []

  const included: { readonly text: string; readonly bytes: number; readonly index: number }[] = []
  const omitted: { readonly text: string; readonly bytes: number; readonly index: number }[] = []
  let used = 0

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    if (used + item.bytes <= maxBytes) {
      included.push({ ...item, index })
      used += item.bytes
      continue
    }
    omitted.push({ ...item, index })
  }

  if (omitted.length === 0) return included.map((item) => item.text)

  while (true) {
    const marker = notice(omitted.toSorted((left, right) => left.index - right.index))
    const markerBytes = byteLength(marker)
    if (markerBytes > maxBytes) return []
    if (used + markerBytes <= maxBytes) return [...included.map((item) => item.text), marker]
    const removed = included.pop()
    if (!removed) return [marker]
    used -= removed.bytes
    omitted.push(removed)
  }
}
