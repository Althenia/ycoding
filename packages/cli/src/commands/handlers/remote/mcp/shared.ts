import { Effect, Option } from "effect"
import type { Remote } from "@ycoding-ai/schema/remote"
import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/promise"
import { RemoteLocal } from "../../../../remote-local"
import { ServerConnection } from "../../../../services/server-connection"
import { line } from "../shared"

export const authorityNotice =
  "Relay MCP lets approved MCP clients act on every existing and future Session on this backend, create Sessions in any directory below your home, give Always approvals, and change YOLO."

export const mcpClient = Effect.fn("cli.remote.mcp.client")(function* (input: {
  readonly server: Option.Option<string>
  readonly standalone: boolean
}) {
  const resolved = yield* ServerConnection.resolve({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
  })
  yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(resolved.endpoint))
  return YCoding.make({ baseUrl: resolved.endpoint.url, headers: Service.headers(resolved.endpoint) })
})

export function printMcpStatus(status: Remote.McpStatus) {
  line(`  Relay MCP  ${status.state}${status.message ? ` · ${status.message}` : ""}`)
  if (status.url) line(`  URL        ${status.url}`)
}
