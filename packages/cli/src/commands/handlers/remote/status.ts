import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/promise"
import { RemoteLocal } from "../../../remote-local"
import { RemoteCredentials } from "../../../remote-credentials"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { RemoteCommand } from "../../remote"
import { credentialState, line } from "./shared"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(
  RemoteCommand.commands.status,
  Effect.fn("cli.remote.status")(function* (input) {
    const identity = yield* RemoteCredentials.read()
    if (identity === undefined) {
      line("Not enrolled. Run `ycoding remote enroll <enrollmentID>` with a relay origin.")
      return
    }
    const resolved = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(resolved.endpoint))
    const client = YCoding.make({ baseUrl: resolved.endpoint.url, headers: Service.headers(resolved.endpoint) })
    const remote = yield* Effect.tryPromise(() => client.remote.get())
    const local = RemoteLocal.createLocalServer(resolved.endpoint)
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
        `  Connection    ${remote.state}${remote.message ? ` · ${remote.message}` : ""}`,
        `  Local server  ${service}`,
        `  Sessions      ${sessions.length} backend session(s), all owner-accessible while connected`,
        "",
      ].join(EOL) + EOL,
    )
  }),
)
