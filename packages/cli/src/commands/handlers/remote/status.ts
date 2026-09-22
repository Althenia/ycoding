import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Service } from "@ycoding-ai/client/effect/service"
import { RemoteLocal } from "../../../remote-local"
import { RemoteCredentials } from "../../../remote-credentials"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { RemoteCommand } from "../../remote"
import { credentialState, line, resolveLocalServer } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.status,
  Effect.fn("cli.remote.status")(function* (input) {
    const identity = yield* RemoteCredentials.read()
    if (identity === undefined) {
      line("Not enrolled. Run `ycoding remote enroll <enrollmentID>` with a relay origin.")
      return
    }
    const local = yield* resolveLocalServer({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const sessions = yield* Effect.tryPromise(() => RemoteLocal.listSessions(local))
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
        `  Sessions      ${sessions.length} backend session(s), all owner-accessible while connected`,
        "",
      ].join(EOL) + EOL,
    )
  }),
)
