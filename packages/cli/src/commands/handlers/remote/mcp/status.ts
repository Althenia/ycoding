import { Effect } from "effect"
import { Runtime } from "../../../../framework/runtime"
import { RemoteCommand } from "../../../remote"
import { mcpClient, printMcpStatus } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.mcp.commands.status,
  Effect.fnUntraced(function* (input) {
    const client = yield* mcpClient(input)
    printMcpStatus(yield* Effect.tryPromise(() => client.remote.mcp.get()))
  }),
)
