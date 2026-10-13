import { Effect, Option } from "effect"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, remoteClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.disconnect,
  Effect.fnUntraced(function* (input) {
    const client = yield* remoteClient({ server: Option.getOrUndefined(input.server), standalone: input.standalone })
    const status = yield* Effect.tryPromise(() => client.remote.set({ enabled: false }))
    if (status.state === "error") return yield* Effect.fail(new Error(status.message ?? "Remote disconnection failed"))
    line("Remote connection off.")
  }),
)
