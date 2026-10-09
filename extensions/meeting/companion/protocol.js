export function bridgeURL(value) {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(value))
    throw new Error("invalid_bridge_url")
  const url = new URL(value)
  if (!url.port || Number(url.port) > 65535) throw new Error("invalid_bridge_url")
  return url.origin
}

export function meetURL(value) {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.hostname === "meet.google.com" &&
      !url.username &&
      !url.password &&
      /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)
    )
  } catch {
    return false
  }
}
