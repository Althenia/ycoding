import { Effect } from "effect"
import { Runtime } from "../../../../framework/runtime"
import { RemoteCommand } from "../../../remote"
import { line } from "../shared"
import { controlClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.control.commands.off,
  Effect.fn("cli.remote.control.off")(function* (input) {
    const client = yield* controlClient(input)
    const status = yield* Effect.tryPromise(() => client.remote.control.set({ enabled: false }))
    if (status.state === "error") return yield* Effect.fail(new Error(status.message ?? "Remote control failed to stop"))
    line("Remote control off.")
  }),
)
