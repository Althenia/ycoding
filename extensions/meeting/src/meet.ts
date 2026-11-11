export interface GoogleMeetInfo {
  code: string
  url: string
}

const MEET_CODE_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/

export function parseGoogleMeet(input: string): GoogleMeetInfo | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const lower = trimmed.toLowerCase()
  if (MEET_CODE_PATTERN.test(lower)) return { code: lower, url: `https://meet.google.com/${lower}` }
  const candidate = lower.startsWith("meet.google.com/") ? `https://${trimmed}` : trimmed
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "https:") return undefined
  if (parsed.hostname.toLowerCase() !== "meet.google.com") return undefined
  if (parsed.username || parsed.password) return undefined
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0)
  if (segments.length !== 1) return undefined
  const code = segments[0].toLowerCase()
  if (!MEET_CODE_PATTERN.test(code)) return undefined
  return { code, url: `https://meet.google.com/${code}` }
}

function stripControls(value: string): string {
  return Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 32
      return !(code <= 31 || (code >= 127 && code <= 159))
    })
    .join("")
}

const WHITESPACE_PATTERN = /\s+/g
const DISALLOWED_PATTERN = /[^\p{L}\p{N}._ -]/gu

export function normalizeChatSpeaker(sender?: string): string {
  const raw = stripControls((sender ?? "").trim())
  const collapsed = raw.replace(WHITESPACE_PATTERN, " ")
  const cleaned = collapsed.replace(DISALLOWED_PATTERN, "-")
  const capped = cleaned.slice(0, 48).trim()
  return `chat:${capped || "participant"}`
}
