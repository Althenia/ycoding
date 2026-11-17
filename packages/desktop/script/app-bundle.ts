import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

export const applicationName = "YCoding Desktop"

export function numericBundleVersion(version: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/.exec(version)
  if (!match) throw new Error("The prepared backend version must be a supported semantic version.")
  return `${match[1]}.${match[2]}.${match[3]}`
}

export function preparedVersion(manifest: string | URL) {
  const value: unknown = JSON.parse(readFileSync(manifest, "utf8"))
  if (typeof value !== "object" || value === null || !("version" in value) || typeof value.version !== "string")
    throw new Error("The prepared backend manifest must report its version.")
  numericBundleVersion(value.version)
  return value.version
}

export function writeBundleMetadata(app: string, version: string) {
  const core = numericBundleVersion(version)
  for (const key of ["CFBundleVersion", "CFBundleShortVersionString"])
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", core, path.join(app, "Contents/Info.plist")], { stdio: "pipe" })
}

if (import.meta.main) {
  const directory = process.env.ELECTROBUN_BUILD_DIR
  const version = process.env.ELECTROBUN_APP_VERSION
  if (process.env.ELECTROBUN_OS !== "macos" || !directory || !path.isAbsolute(directory) || !version)
    throw new Error("Bundle metadata requires the macOS Electrobun build context.")
  writeBundleMetadata(process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH ?? path.join(directory, `${applicationName}.app`), version)
}
