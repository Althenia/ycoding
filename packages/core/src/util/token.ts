export * as Token from "./token"

const CHARS_PER_TOKEN = 4

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

const isDataUri = (value: string) => /^data:[^;]+;base64,/i.test(value)

const isLongBase64 = (value: string) => value.length > 1_024 && /^[A-Za-z0-9+/=\s]+$/.test(value)

export const stripMedia = (value: unknown): unknown => {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return isDataUri(value) ? "" : value
  if (value instanceof Uint8Array) return ""
  if (Array.isArray(value)) return value.map(stripMedia)
  if (typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if (record.type === "media" && "data" in record) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      if (key === "data") copy[key] = ""
      else copy[key] = stripMedia(entry)
    }
    return copy
  }
  if ("data" in record) {
    const data = record.data
    if (typeof data === "string" && (isDataUri(data) || isLongBase64(data))) {
      const copy: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(record)) {
        if (key === "data") copy[key] = ""
        else copy[key] = stripMedia(entry)
      }
      return copy
    }
    if (data instanceof Uint8Array) {
      const copy: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(record)) {
        if (key === "data") copy[key] = ""
        else copy[key] = stripMedia(entry)
      }
      return copy
    }
  }
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" && isDataUri(entry)) {
      result[key] = ""
      continue
    }
    result[key] = stripMedia(entry)
  }
  return result
}

export const estimateJson = (value: unknown) => estimate(JSON.stringify(stripMedia(value)))
