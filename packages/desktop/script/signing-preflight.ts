import fs from "node:fs/promises"
import path from "node:path"

const environment = [
  "YCODING_MACOS_SIGNING_IDENTITY",
  "YCODING_MACOS_SIGNING_KEYCHAIN",
  "YCODING_ANTIGRAVITY_CLIENT_SECRET",
  "YCODING_MUSE_CLIENT_SECRET",
  "MODELS_DEV_API_JSON",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "APPLE_PROVIDER_SHORT_NAME",
  "TAURI_CONFIG",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]
const alternates = new Set(["tauri.conf.json5", "tauri.toml", "tauri.macos.conf.json", "tauri.macos.conf.json5", "tauri.macos.toml"])
const configured = ["signingIdentity", "providerShortName"]

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return Object.entries(value).find(([name]) => name === key)?.[1]
}

export function signingConfiguration(env: Record<string, string | undefined>, tauri: unknown, entries: readonly string[] = []) {
  const names = environment.filter((name) => Object.hasOwn(env, name))
  for (const entry of entries) if (alternates.has(entry.toLowerCase())) names.push(`src-tauri/${entry}`)
  const macOS = field(field(tauri, "bundle"), "macOS")
  for (const key of configured) {
    const value = field(macOS, key)
    if (value !== undefined && value !== null) names.push(`tauri.conf.json bundle.macOS.${key}`)
  }
  return names
}

export function dotenvEntries(names: readonly string[]) {
  return names.filter((name) => name.toLowerCase().startsWith(".env"))
}

export async function assertLocalArtifactSigning(env: Record<string, string | undefined> = process.env, desktop = path.resolve(import.meta.dir, "..")) {
  const found: string[] = []
  for (const directory of [desktop, path.resolve(desktop, "../cli"), path.resolve(desktop, "../..")])
    for (const name of dotenvEntries(await fs.readdir(directory))) found.push(path.join(directory, name))
  if (found.length > 0) throw new Error(`Dotenv files are present (${found.join(", ")}). Bun would load them before the build can refuse them; they were not read or changed, and the build is refused.`)
  const tauri: unknown = JSON.parse(await fs.readFile(path.join(desktop, "src-tauri/tauri.conf.json"), "utf8"))
  const names = signingConfiguration(env, tauri, await fs.readdir(path.join(desktop, "src-tauri")))
  if (names.length > 0) throw new Error(`Signing, signing-secret or configuration override is present (${names.join(", ")}). This constrained local build does not accept it, so it is refused; the configuration is left unchanged.`)
}
