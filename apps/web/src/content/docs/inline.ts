/**
 * Splits documentation text into prose and `inline code` runs. Text with an unpaired
 * backtick stays one literal run, so a stray quote character never swallows prose.
 */
export function inlineSegments(text: string): readonly { readonly code: boolean; readonly text: string }[] {
  const parts = text.split("`")
  if (parts.length % 2 === 0) return [{ code: false, text }]
  return parts.flatMap((part, index) => (part === "" ? [] : [{ code: index % 2 === 1, text: part }]))
}
