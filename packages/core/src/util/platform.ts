export * as Platform from "./platform"

export function upstreamOs(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "macos"
  if (platform === "win32") return "windows"
  return platform
}
