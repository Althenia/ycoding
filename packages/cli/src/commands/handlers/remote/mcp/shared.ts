import { Option } from "effect"
import { line, remoteClient } from "../shared"

export const authorityNotice =
  "Relay MCP lets approved MCP clients act on every existing and future Session on this backend, create Sessions in any directory below your home, give Always approvals, and change YOLO."

export function mcpClient(input: { readonly server: Option.Option<string>; readonly standalone: boolean }) {
  return remoteClient({ server: Option.getOrUndefined(input.server), standalone: input.standalone })
}

export function printMcpStatus(status: { readonly state: string; readonly message?: string; readonly url?: string }) {
  line(`  Relay MCP  ${status.state}${status.message ? ` · ${status.message}` : ""}`)
  if (status.url) line(`  URL        ${status.url}`)
}
