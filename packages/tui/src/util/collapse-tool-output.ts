import { stringWidth } from "./string-width"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function takeGraphemes(value: string, count: number): string {
  const selected: string[] = []
  let taken = 0
  for (const item of graphemes.segment(value)) {
    if (taken >= count) break
    selected.push(item.segment)
    taken += 1
  }
  return selected.join("")
}

export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const segments = Array.from(output, (item) => item)
  const lines = output.split("\n")
  if (lines.length <= maxLines && segments.length <= maxChars) {
    return { output, overflow: false }
  }

  const visible = lines.slice(0, maxLines)
  if (lines.length > maxLines && visible.length > 0) visible[visible.length - 1] += "…"
  const preview = visible.join("\n")
  if (Array.from(preview).length > maxChars) {
    return {
      output: takeGraphemes(preview, Math.max(0, maxChars - 1)) + "…",
      overflow: true,
    }
  }

  return { output: preview, overflow: true }
}

/**
 * Bounds a preview by the rows the bubble actually paints.
 *
 * `collapseToolOutput` counts source lines and characters, but the bubble wraps text, so a
 * couple of long source lines can still paint many rows — and a one-source-line budget dropped
 * every line after the first. This wraps the text into rows first, spends the `maxLines` row
 * budget, and marks where the remainder was dropped.
 */
export function collapseWrappedOutput(output: string, maxLines: number, width: number) {
  const columns = Math.max(1, width)
  const rows = wrapRows(output, columns)
  if (rows.length <= maxLines) return { output, overflow: false }

  const visible = rows.slice(0, maxLines)
  visible[visible.length - 1] = takeGraphemes(visible[visible.length - 1]!, Math.max(0, columns - 1)) + "…"
  return { output: visible.join("\n"), overflow: true }
}

/** Greedy word wrap that preserves paragraph breaks, with a hard split for over-long words. */
function wrapRows(output: string, columns: number): string[] {
  const rows: string[] = []
  for (const source of output.split("\n")) {
    let row = ""
    for (const word of source.split(" ")) {
      const candidate = row === "" ? word : `${row} ${word}`
      if (stringWidth(candidate) <= columns) {
        row = candidate
        continue
      }
      if (row !== "") rows.push(row)
      let rest = word
      while (stringWidth(rest) > columns) {
        const segments = Array.from(graphemes.segment(rest), (item) => item.segment)
        rows.push(segments.slice(0, columns).join(""))
        rest = segments.slice(columns).join("")
      }
      row = rest
    }
    rows.push(row)
  }
  return rows
}

export function toolOutputBudget(width: number) {
  const maxLines = 4
  return { maxLines, maxChars: maxLines * Math.max(20, width - 6) }
}

export function toolOutputDisplay(output: string, expanded: boolean, maxLines: number, maxChars: number) {
  if (!output.trim()) return { output: "", visible: false, expandable: false }
  const collapsed = collapseToolOutput(output, maxLines, maxChars)
  const expandable = collapsed.overflow || collapsed.output !== output
  if (!expanded || !expandable) return { output: collapsed.output, visible: true, expandable }
  return { output, visible: true, expandable }
}
