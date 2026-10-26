import { Effect, Option } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/promise"
import { RemoteLocal } from "../../../../remote-local"
import { ServerConnection } from "../../../../services/server-connection"
import { line } from "../shared"

export const controlClient = Effect.fn("cli.remote.control.client")(function* (input: {
  readonly server: Option.Option<string>
  readonly standalone: boolean
}) {
  const resolved = yield* ServerConnection.resolve({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
  })
  yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(resolved.endpoint))
  return YCoding.make({ baseUrl: resolved.endpoint.url, headers: Service.headers(resolved.endpoint) })
})

export function printControlStatus(status: { state: string; message?: string; profile?: string; serverName?: string }) {
  line(`  Remote control  ${status.state}${status.message ? ` · ${status.message}` : ""}`)
  if (status.profile) line(`  Profile         ${status.profile}`)
  if (status.serverName) line(`  Environment     ${status.serverName}`)
}
