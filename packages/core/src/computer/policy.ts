export * as ComputerPolicy from "./policy"

export type Decision = "allowed" | "elevated" | "forbidden"

export interface Evaluation {
  readonly decision: Decision
  readonly bundleID: string
  readonly reason: string
}

export interface Overrides {
  readonly allow?: ReadonlyArray<string>
}

const forbidden: ReadonlyArray<readonly [string, string]> = [
  ["com.apple.systempreferences", "System Settings can change privacy and security configuration"],
  ["com.apple.keychainaccess", "Keychain Access stores credentials"],
  ["com.1password.1password", "1Password stores credentials"],
  ["com.bitwarden.desktop", "Bitwarden stores credentials"],
  ["com.dashlane.dashlanephonefinal", "Dashlane stores credentials"],
  ["app.ycoding.computer-use", "the YCoding Computer Use helper cannot control itself"],
]

const elevated: ReadonlyArray<readonly [string, string]> = [
  ["com.apple.Terminal", "terminals execute arbitrary commands"],
  ["com.googlecode.iterm2", "terminals execute arbitrary commands"],
  ["dev.warp.Warp-Stable", "terminals execute arbitrary commands"],
  ["com.mitchellh.ghostty", "terminals execute arbitrary commands"],
  ["net.kovidgoyal.kitty", "terminals execute arbitrary commands"],
  ["org.alacritty", "terminals execute arbitrary commands"],
  ["com.github.wez.wezterm", "terminals execute arbitrary commands"],
]

export const forbiddenBundleIDs = forbidden.map(([bundleID]) => bundleID)
export const elevatedBundleIDs = elevated.map(([bundleID]) => bundleID)

// The override is the comma-separated bundle ID list in YCODING_COMPUTER_ALLOW_APPS.
// It removes a bundle from the static forbidden list for users who accept the risk;
// elevated-risk apps stay elevated because that only drops saved approval.
export function overrideFromEnv(value: string | undefined): ReadonlyArray<string> {
  if (!value) return []
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

export function evaluate(bundleID: string, overrides: Overrides = {}): Evaluation {
  const banned = forbidden.find(([candidate]) => candidate === bundleID)
  if (banned && !(overrides.allow ?? []).includes(bundleID))
    return { decision: "forbidden", bundleID, reason: banned[1] }
  const risky = elevated.find(([candidate]) => candidate === bundleID)
  if (risky) return { decision: "elevated", bundleID, reason: risky[1] }
  return { decision: "allowed", bundleID, reason: "no static policy restriction" }
}
