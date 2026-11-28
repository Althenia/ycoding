import { EOL } from "node:os"
import { Effect } from "effect"
import { ServerConnection } from "../../../services/server-connection"
import { RemoteCredentials } from "../../../remote-credentials"
import { RemoteLocal } from "../../../remote-local"
import { RemoteSetupError } from "../../../remote-error"
import { frontendClient, type createClient } from "../../../services/client"
import { RemoteLimits } from "@ycoding-ai/remote"

export const requireIdentity = Effect.fn("cli.remote.identity")(function* () {
  const identity = yield* RemoteCredentials.read()
  if (identity === undefined)
    return yield* Effect.fail(
      new RemoteSetupError("This machine is not enrolled; run `ycoding remote enroll <enrollmentID>` first"),
    )
  return identity
})

export const resolveRemoteClient = (input: { readonly server?: string; readonly standalone?: boolean }) =>
  Effect.gen(function* () {
    const server = input.server
    if (server !== undefined) yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint({ url: server }))
    const resolved = yield* ServerConnection.resolve({ server: input.server, standalone: input.standalone })
    yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(resolved.endpoint))
    const client = yield* frontendClient(resolved.endpoint)
    return { client, endpoint: resolved.endpoint }
  })

export async function listBackendSessions(client: ReturnType<typeof createClient>, signal: AbortSignal) {
  const sessions: Awaited<ReturnType<typeof client.session.list>>["data"] = []
  const visited = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await client.session.list({
      limit: RemoteLimits.maxSessionListPage,
      order: "desc",
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal })
    sessions.push(...page.data)
    cursor = page.cursor.next ?? undefined
    if (cursor === undefined || page.data.length === 0) return sessions
    if (visited.has(cursor)) throw new Error("Session inventory repeated a page cursor")
    visited.add(cursor)
  }
}

export function line(value: string) {
  process.stdout.write(value + EOL)
}
