import { Effect, Option } from "effect"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, resolveRemoteClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.disconnect,
  Effect.fn("cli.remote.disconnect")(function* (input) {
    const { client } = yield* resolveRemoteClient({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const status = yield* Effect.tryPromise((signal) => client.remote.set({ enabled: false }, { signal }))
    if (status.state === "error") yield* Effect.fail(new Error(status.message ?? "Remote disconnection failed"))
    line("Remote connection off.")
  }),
)
