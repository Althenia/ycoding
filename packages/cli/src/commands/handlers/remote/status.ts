import { Effect, Option } from "effect"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, remoteClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.status,
  Effect.fnUntraced(function* (input) {
    const client = yield* remoteClient({ server: Option.getOrUndefined(input.server), standalone: input.standalone })
    const remote = yield* Effect.tryPromise(() => client.remote.get())
    if (!remote.device) {
      line("Not enrolled. Run `ycoding remote enroll <enrollmentID>` with a relay origin.")
      return
    }
    line(`Device ${remote.device.name} (${remote.device.deviceID})`)
    line(`Relay ${remote.device.relayOrigin}`)
    line(`Credential ${remote.device.credentialState}`)
    line(`Connection ${remote.state}${remote.message ? ` · ${remote.message}` : ""}`)
    line("Every existing and future backend Session is owner-accessible while connected.")
  }),
)
