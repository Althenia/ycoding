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
