import path from "node:path"

export function hostDirectory(input: string, home: string, platform: NodeJS.Platform = process.platform) {
  const windows = platform === "win32"
  const api = windows ? path.win32 : path.posix
  if (input.includes("\0")) return undefined
  const expanded = input === "~" ? home : (windows ? /^~[\\/]/ : /^~\//).test(input) ? api.join(home, input.slice(2)) : input
  const absolute = windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/]+[\\/][^\\/]+)/.test(expanded) : api.isAbsolute(expanded)
  return absolute ? api.resolve(expanded) : undefined
}
