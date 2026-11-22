export const interactionExtensionDirectory = "ycoding-chrome-extension"
export const interactionSigningSHA1 = "9dd524184b0db949ffac7f0ada0ae860ac7f5f85"
export const interactionCLIIdentifier = "app.ycoding.cli"
export const interactionSigningRequirement = (identifier: string) =>
  `=identifier "${identifier}" and certificate leaf = H"${interactionSigningSHA1}"`
export const interactionExtensionFiles = [
  "icons/active-16.png", "icons/active-32.png", "icons/idle-128.png", "icons/idle-16.png", "icons/idle-32.png", "icons/idle-48.png",
  "manifest.json", "panel.css", "panel.html", "panel.js", "popup.css", "popup.html", "popup.js", "service-worker.js",
] as const
export const interactionApplication = {
  name: "YCoding Interaction.app",
  executable: "ycoding-interaction",
  identifier: "app.ycoding.interaction",
  displayName: "YCoding Interaction",
} as const

export function usesInteractionLayout(version: string) {
  const match = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)(?=$|[+-])/.exec(version)
  if (!match) return false
  return Number(match[1]) > 0 || Number(match[2]) >= 12
}

export function usesNativeReleaseLayout(version: string) {
  const match = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)(?=$|[+-])/.exec(version)
  return match !== null && (Number(match[1]) > 0 || Number(match[2]) >= 13)
}
