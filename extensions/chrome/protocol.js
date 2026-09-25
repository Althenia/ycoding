export const VERSION = 3
export const MAX_CAPTURE_BYTES = 1024 * 1024
export const MAX_ELEMENTS = 200
export const MAX_SHARED_TABS = 8

export function validateServerURL(input) {
  const url = new URL(input)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("YCoding bridge URL must use HTTP on the loopback host")
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Bridge URL cannot contain credentials or parameters")
  return url
}

export function connectURL(serverURL) {
  const url = validateServerURL(serverURL)
  url.protocol = "ws:"
  url.pathname = "/api/browser/connect"
  return url.toString()
}

export function reconnectDelay(attempt) {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt))
}

export function safePage(input) {
  const url = new URL(input)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only credential-free HTTP and HTTPS tabs can be shared")
  return { origin: url.origin, path: url.pathname || "/" }
}

export function tabID() {
  return `btab_${crypto.randomUUID().replaceAll("-", "")}`
}
