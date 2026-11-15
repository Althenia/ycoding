import { mentionPayload, type MentionPick, type PastedText } from "./form-rules"

export type PasteMode = "compact" | "full"

export const PASTE_STORAGE_KEY = "ycoding.desktop.paste"

export const parsePasteMode = (raw: string | null): PasteMode => raw === "full" ? "full" : "compact"

export const livePasted = (text: string, pasted: readonly PastedText[]): PastedText[] => pasted.filter((entry) => text.includes(entry.label))

function ranges(text: string, pasted: readonly PastedText[]) {
  return livePasted(text, pasted).map((entry) => ({ entry, start: text.indexOf(entry.label), end: text.indexOf(entry.label) + entry.label.length })).sort((left, right) => left.start - right.start)
}

export function expandPastedText(text: string, pasted: readonly PastedText[]): string {
  return ranges(text, pasted).reduceRight((result, range) => result.slice(0, range.start) + range.entry.text + result.slice(range.end), text)
}

export function expandPastedPrompt(text: string, picks: readonly MentionPick[], pasted: readonly PastedText[]) {
  const mentioned = mentionPayload(text, picks)
  const found = ranges(text, pasted)
  const shift = <T extends { readonly mention: { readonly start: number; readonly end: number; readonly text: string } }>(item: T): T => {
    const offset = found.filter((range) => range.end <= item.mention.start).reduce((total, range) => total + range.entry.text.length - range.entry.label.length, 0)
    return { ...item, mention: { ...item.mention, start: item.mention.start + offset, end: item.mention.end + offset } }
  }
  return { text: expandPastedText(text, pasted), files: mentioned.files.map(shift), agents: mentioned.agents.map(shift) }
}

export function placePaste(input: { readonly text: string; readonly pasted: readonly PastedText[]; readonly start: number; readonly end: number; readonly clipboard: string; readonly mode: PasteMode }): { readonly text: string; readonly caret: number; readonly pasted: readonly PastedText[] } {
  const start = Math.max(0, Math.min(input.start, input.text.length))
  const end = Math.max(start, Math.min(input.end, input.text.length))
  const normalized = input.clipboard.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const content = normalized.trim()
  const lines = (content.match(/\n/g)?.length ?? 0) + 1
  const compact = input.mode === "compact" && (lines >= 3 || content.length > 150)
  const base = `[Pasted ~${lines} lines]`
  let label = base
  if (compact) {
    for (let index = 2; input.text.includes(label) || input.pasted.some((entry) => entry.label === label); index++) label = `[Pasted ~${lines} lines #${index}]`
  }
  const inserted = compact ? label : normalized
  const text = input.text.slice(0, start) + inserted + input.text.slice(end)
  const kept = ranges(input.text, input.pasted).filter((range) => range.end <= start || range.start >= end).map((range) => range.entry)
  return { text, caret: start + inserted.length, pasted: ranges(text, compact ? [...kept, { label, text: content }] : kept).map((range) => range.entry) }
}
