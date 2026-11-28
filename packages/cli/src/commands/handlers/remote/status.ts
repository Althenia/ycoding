import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, listBackendSessions, resolveRemoteClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.status,
  Effect.fn("cli.remote.status")(function* (input) {
    const { client, endpoint } = yield* resolveRemoteClient({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const remote = yield* Effect.tryPromise((signal) => client.remote.get({ signal }))
    const device = remote.device
    if (device === undefined) {
      line("Not enrolled. Run `ycoding remote enroll <enrollmentID>` with a relay origin.")
      return
    }
    const sessions = yield* Effect.tryPromise((signal) => listBackendSessions(client, signal))
    process.stdout.write(
      [
        "",
        `  Device        ${device.name} (${device.deviceID})`,
        `  Relay         ${device.relayOrigin}`,
        `  Credential    ${device.credentialState === "not_authenticated" ? "not yet authenticated" : device.credentialState}`,
        `  Connection    ${remote.state}${remote.message ? ` · ${remote.message}` : ""}`,
        `  Local server  ${new URL(endpoint.url).origin}`,
        `  Sessions      ${sessions.length} backend session(s), all owner-accessible while connected`,
        "",
      ].join(EOL) + EOL,
    )
  }),
)
