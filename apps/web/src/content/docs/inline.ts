export type InlineSegment = { readonly code: boolean; readonly strong?: true; readonly text: string }

/**
 * Splits documentation text into prose, `inline code`, and **strong** runs. Code spans
 * are literal, so `**` inside them stays text. A span with an unpaired delimiter stays
 * literal, so a stray character never swallows the rest of the prose.
 */
export function inlineSegments(text: string): readonly InlineSegment[] {
  return pairs(text, "`").flatMap((part): readonly InlineSegment[] =>
    part.inside
      ? [{ code: true, text: part.text }]
      : pairs(part.text, "**").map((run) => (run.inside ? { code: false, strong: true, text: run.text } : { code: false, text: run.text })),
  )
}

function pairs(text: string, delimiter: string) {
  const parts = text.split(delimiter)
  if (parts.length % 2 === 0) return text === "" ? [] : [{ inside: false, text }]
  return parts.flatMap((part, index) => (part === "" ? [] : [{ inside: index % 2 === 1, text: part }]))
}
