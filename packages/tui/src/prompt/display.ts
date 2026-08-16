import { stringWidth } from "../util/string-width"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function promptOffsetWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    // Textarea offsets count newlines as one position; terminal width counts them as zero.
    width += part.segment === "\n" ? 1 : stringWidth(part.segment)
  }
  return width
}

function displayOffsetIndex(value: string, offset: number) {
  if (offset <= 0) return 0

  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + promptOffsetWidth(part.segment)
    if (next > offset) return part.index
    width = next
  }

  return value.length
}

export function displaySlice(value: string, start = 0, end = promptOffsetWidth(value)) {
  return value.slice(displayOffsetIndex(value, start), displayOffsetIndex(value, end))
}

export function displayCharAt(value: string, offset: number) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + promptOffsetWidth(part.segment)
    if (offset === width || offset < next) return part.segment
    width = next
  }
}

// Openers a mention or skill token may directly follow. Word characters, path
// separators, dots and emoji stay excluded so "foo@bar.com" and "src/@" never open a menu.
const TRIGGER_OPENERS = new Set(["(", "[", "{", "<", '"', "'", "`", ",", ";", ":", "=", "|"])

function triggerIndex(value: string, offset: number, prefix: "@" | "$") {
  const text = displaySlice(value, 0, offset)
  const index = text.lastIndexOf(prefix)
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if (/\s/.test(query)) return
  if (before !== undefined && !/\s/.test(before) && !TRIGGER_OPENERS.has(before)) return

  return promptOffsetWidth(text.slice(0, index))
}

export function mentionTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  return triggerIndex(value, offset, "@")
}

export function skillTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  return triggerIndex(value, offset, "$")
}

export function autocompleteTriggerIndex(value: string, offset: number, mode: "@" | "$") {
  if (mode === "@") return mentionTriggerIndex(value, offset)
  return skillTriggerIndex(value, offset)
}

export function promptCommandPalette(command: { palette?: boolean }) {
  if (!Object.hasOwn(command, "palette")) return true
  return command.palette === true ? true : undefined
}
