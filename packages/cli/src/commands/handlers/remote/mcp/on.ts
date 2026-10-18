import { Effect } from "effect"
import { Runtime } from "../../../../framework/runtime"
import { RemoteCommand } from "../../../remote"
import { line } from "../shared"
import { authorityNotice, mcpClient, printMcpStatus } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.mcp.commands.on,
  Effect.fnUntraced(function* (input) {
    const client = yield* mcpClient(input)
    const remote = yield* Effect.tryPromise(() => client.remote.get())
    if (!remote.device)
      return yield* Effect.fail(
        new Error("This machine is not enrolled; run `ycoding remote enroll <enrollmentID>` first"),
      )
    if (remote.state === "off")
      return yield* Effect.fail(new Error("Remote is off; run `ycoding remote connect` before enabling relay MCP"))
    const status = yield* Effect.tryPromise(() => client.remote.mcp.set({ enabled: true }))
    if (status.state === "error") return yield* Effect.fail(new Error(status.message ?? "Relay MCP failed to start"))
    line(authorityNotice)
    printMcpStatus(status)
  }),
)
