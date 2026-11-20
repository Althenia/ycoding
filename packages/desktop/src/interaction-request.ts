export function chromeInteractionURL(value: string) {
  if (value.length > 2048 || !/^https?:\/\/[^/?#@\s\\]+(?:[/?#][^\s\\]*)?$/i.test(value) || !URL.canParse(value)) return undefined
  const url = new URL(value)
  return !url.username && !url.password && url.href.length <= 2048 ? url.href : undefined
}
