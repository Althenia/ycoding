import { Effect, Option } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/promise"
import { RemoteLocal } from "../../../remote-local"
import { ServerConnection } from "../../../services/server-connection"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.disconnect,
  Effect.fn("cli.remote.disconnect")(function* (input) {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(server.endpoint))
    const client = YCoding.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    const status = yield* Effect.tryPromise(() => client.remote.set({ enabled: false }))
    if (status.state === "error") yield* Effect.fail(new Error(status.message ?? "Remote disconnection failed"))
    line("Remote connection off.")
  }),
)
