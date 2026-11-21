const mask = "[redacted]"
const encodedMask = encodeURIComponent(mask)
const whole = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?<!\beyJ[A-Za-z0-9_-]*?)eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?=[A-Za-z0-9_])(?<![A-Za-z0-9_]-*)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])(?=([A-Za-z0-9_-]{31,}[A-Za-z0-9_]))\1/g,
]
const assignment = /\b(pass(?:word|wd)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|auth)(\s*[:=]\s*)(?!\[redacted\])[^\s&#,;]+/gi
const personal = [
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
  /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g,
  /(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?!\d)/g,
]
const sensitiveName = /^(?:pass(?:word|wd)?|pwd|otp|code|sig(?:nature)?|sid|key|session(?:_?id)?|.*secret.*|.*token.*|.*credential.*|api[_-]?key|auth.*|x-amz-.*)$/i

export const redactionPatterns = [...whole, assignment, ...personal].map((pattern) => ({ source: pattern.source, flags: pattern.flags }))

export function redactText(text) {
  if (typeof text !== "string") return ""
  const secret = whole.reduce((value, pattern) => value.replace(pattern, mask), text)
  return personal.reduce((value, pattern) => value.replace(pattern, mask), secret.replace(assignment, `$1$2${mask}`))
}

export function redactURL(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return undefined
  const url = URL.canParse(raw) ? new URL(raw) : undefined
  if (!url || !["http:", "https:"].includes(url.protocol)) return undefined
  const path = url.pathname.split("/").map(redactComponent).join("/")
  const query = url.search.slice(1).split("&").filter(Boolean).map((pair) => {
    const split = pair.indexOf("=")
    if (split < 0) return redactComponent(pair)
    const name = pair.slice(0, split)
    return `${name}=${sensitiveName.test(decode(name)) ? mask : redactComponent(pair.slice(split + 1))}`
  })
  const result = `${url.protocol}//${url.host}${path}${query.length ? `?${query.join("&")}` : ""}`
  return result.length <= 2048 ? result : undefined
}

function redactComponent(component) {
  const decoded = decode(component)
  const masked = redactText(decoded)
  return masked === decoded ? component : encodeURIComponent(masked).replaceAll(encodedMask, mask)
}

function decode(component) {
  try {
    return decodeURIComponent(component.replaceAll("+", " "))
  } catch {
    return component
  }
}
