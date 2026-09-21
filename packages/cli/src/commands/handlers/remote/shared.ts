import { EOL } from "node:os"
import { Effect } from "effect"
import { ServerConnection } from "../../../services/server-connection"
import { RemoteCredentials } from "../../../remote-credentials"
import { RemoteLocal } from "../../../remote-local"

export const requireIdentity = Effect.fn("cli.remote.identity")(function* () {
  const identity = yield* RemoteCredentials.read()
  if (identity === undefined)
    return yield* Effect.fail(
      new Error("This machine is not enrolled; run `ycoding remote enroll <enrollmentID>` first"),
    )
  return identity
})

export const resolveLocalServer = (input: { readonly server?: string; readonly standalone?: boolean }) =>
  Effect.gen(function* () {
    const resolved = yield* ServerConnection.resolve({ server: input.server, standalone: input.standalone })
    yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(resolved.endpoint))
    return RemoteLocal.createLocalServer(resolved.endpoint)
  })

export function credentialState(identity: RemoteCredentials.Identity, now = Date.now()) {
  if (identity.refreshToken === undefined || identity.refreshExpiresAt === undefined) return "not yet authenticated"
  if (identity.refreshExpiresAt <= now) return "expired; enroll again"
  const days = Math.floor((identity.refreshExpiresAt - now) / 86_400_000)
  return days >= 1 ? `valid for ${days} more day(s)` : "valid for less than a day"
}

export function line(value: string) {
  process.stdout.write(value + EOL)
}
