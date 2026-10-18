import { Effect } from "effect"
import { Runtime } from "../../../../framework/runtime"
import { RemoteCommand } from "../../../remote"
import { line } from "../shared"
import { mcpClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.mcp.commands.off,
  Effect.fn("cli.remote.mcp.off")(function* (input) {
    const client = yield* mcpClient(input)
    const status = yield* Effect.tryPromise(() => client.remote.mcp.set({ enabled: false }))
    if (status.state === "error") return yield* Effect.fail(new Error(status.message ?? "Relay MCP failed to stop"))
    line("Relay MCP off.")
  }),
)
