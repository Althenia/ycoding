import { Effect } from "effect"
import { Runtime } from "../../../../framework/runtime"
import { RemoteCommand } from "../../../remote"
import { line } from "../shared"
import { controlClient, printControlStatus } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.control.commands.on,
  Effect.fn("cli.remote.control.on")(function* (input) {
    const client = yield* controlClient(input)
    const status = yield* Effect.tryPromise(() =>
      client.remote.control.set({ enabled: true, profile: input.profile }),
    )
    if (status.state === "error") return yield* Effect.fail(new Error(status.message ?? "Remote control failed to start"))
    line("Enrolling this machine as a remote-control environment lets the pinned ChatGPT account start and steer YCoding Sessions on it. Approvals still settle only on this machine.")
    printControlStatus(status)
  }),
)
