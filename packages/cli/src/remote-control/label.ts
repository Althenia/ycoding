import { createHash } from "node:crypto"

export function serverNameForHost(name: string) {
  if (process.platform !== "darwin") return name
  return name.includes(".") ? name : `${name}.local`
}

export function defaultDotsLabel(hostname: string, installationID: string) {
  const suffix = ` (${createHash("sha256").update(installationID).digest("hex").slice(0, 6)})`
  return `${serverNameForHost(hostname).trim().slice(0, 100 - suffix.length)}${suffix}`
}
