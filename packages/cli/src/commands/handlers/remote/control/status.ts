import { Effect } from "effect"
import { Runtime } from "../../../../framework/runtime"
import { RemoteCommand } from "../../../remote"
import { controlClient, printControlStatus } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.control.commands.status,
  Effect.fn("cli.remote.control.status")(function* (input) {
    const client = yield* controlClient(input)
    printControlStatus(yield* Effect.tryPromise(() => client.remote.control.get()))
  }),
)
