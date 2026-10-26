export * as RemoteControlCredential from "./credential"

import { Effect } from "effect"
import { Integration } from "../integration"
import { OpenAICodex } from "../plugin/provider/openai-codex"

export type Resolved = {
  readonly access: string
  readonly accountID: string
  readonly key: string
  readonly profile: string
}

const integrationID = Integration.ID.make("openai")

export const resolve = Effect.fn("RemoteControlCredential.resolve")(function* (
  integration: Integration.Interface,
  profile: string,
  rejectedAccessToken?: string,
) {
  const found = yield* integration.get(integrationID)
  const connection = found?.connections.find((item) => item.type === "credential" && item.label === profile)
  if (!connection) return undefined
  const snapshot = yield* integration.connection
    .snapshot(connection, rejectedAccessToken ? { rejectedAccessToken } : undefined)
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (snapshot === undefined) return undefined
  const accountID = OpenAICodex.accountID(snapshot.value)
  if (!snapshot.credential || snapshot.value?.type !== "oauth" || !accountID) return undefined
  return {
    access: snapshot.value.access,
    accountID,
    key: [snapshot.credential.id, snapshot.credential.accountGeneration, accountID].join("\0"),
    profile,
  } satisfies Resolved
})
