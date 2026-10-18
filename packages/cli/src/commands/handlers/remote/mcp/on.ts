import { Effect } from "effect"
import { Runtime } from "../../../../framework/runtime"
import { RemoteSetupError } from "../../../../remote-error"
import { RemoteCommand } from "../../../remote"
import { line, requireIdentity } from "../shared"
import { authorityNotice, mcpClient, printMcpStatus } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.mcp.commands.on,
  Effect.fn("cli.remote.mcp.on")(function* (input) {
    yield* requireIdentity()
    const client = yield* mcpClient(input)
    const remote = yield* Effect.tryPromise(() => client.remote.get())
    if (remote.state === "off")
      return yield* Effect.fail(new RemoteSetupError("Remote is off; run `ycoding remote connect` before enabling relay MCP"))
    const status = yield* Effect.tryPromise(() => client.remote.mcp.set({ enabled: true }))
    if (status.state === "error") return yield* Effect.fail(new Error(status.message ?? "Relay MCP failed to start"))
    line(authorityNotice)
    printMcpStatus(status)
  }),
)
