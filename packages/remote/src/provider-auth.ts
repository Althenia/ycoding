export function isProviderAuthorizationURL(value: string) {
  if (value.length > 8192 || !URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.hostname !== "localhost" &&
    !url.hostname.endsWith(".localhost") &&
    !/^127\./.test(url.hostname) &&
    url.hostname !== "[::1]" &&
    !url.hostname.startsWith("[::ffff:7f")
  )
}
