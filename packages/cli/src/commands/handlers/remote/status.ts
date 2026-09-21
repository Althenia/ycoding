import { Effect } from "effect"
import { EOL } from "node:os"
import { Service } from "@ycoding-ai/client/effect/service"
import { RemoteConfig } from "../../../remote-config"
import { RemoteCredentials } from "../../../remote-credentials"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { RemoteCommand } from "../../remote"
import { credentialState, line } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.status,
  Effect.fn("cli.remote.status")(function* () {
    const identity = yield* RemoteCredentials.read()
    const sessions = yield* RemoteConfig.sessions()
    const shared = [
      `  Shared        ${sessions.length} session(s)`,
      ...sessions.flatMap((session) => [
        `    ${session.sessionID}  ${session.title ?? "(untitled)"}  ${session.directory}`,
      ]),
    ]
    if (identity === undefined) {
      line("Not enrolled. Run `ycoding remote enroll <enrollmentID>` with a relay origin.")
      process.stdout.write([...shared, ""].join(EOL) + EOL)
      return
    }
    const service = yield* Service.discover(yield* ServiceConfig.options()).pipe(
      Effect.map((found) => found?.url ?? "stopped"),
      Effect.catch(() => Effect.succeed("unknown")),
    )
    process.stdout.write(
      [
        "",
        `  Device        ${identity.name} (${identity.deviceID})`,
        `  Relay         ${identity.relayURL}`,
        `  Credential    ${credentialState(identity)}`,
        `  Local server  ${service}`,
        ...shared,
        "",
      ].join(EOL) + EOL,
    )
  }),
)
