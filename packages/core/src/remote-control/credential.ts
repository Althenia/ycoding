export * as RemoteControlCredential from "./credential"

import { Clock, Effect } from "effect"
import { Integration } from "../integration"
import { OpenAICodex } from "../plugin/provider/openai-codex"
import { refresh } from "../plugin/provider/openai"
import { Credential } from "../credential"

export type Resolved = {
  readonly access: string
  readonly accountID: string
  readonly key: string
  readonly profile: string
  readonly credentialID: string
  readonly accountGeneration: number
}

const integrationID = Integration.ID.make("openai")

export const resolveStored = Effect.fn("RemoteControlCredential.resolveStored")(function* (
  credentials: Credential.Interface,
  profile: string,
  rejectedAccessToken?: string,
) {
  const matching = (yield* credentials.list(integrationID)).filter((item) => item.label === profile)
  const saved = matching.length === 1 ? matching[0] : undefined
  if (!saved || saved.value.type !== "oauth" || !OpenAICodex.accountID(saved.value)) return undefined
  const now = yield* Clock.currentTimeMillis
  const current = saved.value.expires <= now + 300_000 || saved.value.access === rejectedAccessToken
    ? yield* credentials.refresh(saved, refresh(saved.value.methodID, saved.value)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    : saved
  if (!current || current.label !== profile || current.value.type !== "oauth") return undefined
  const accountID = OpenAICodex.accountID(current.value)
  if (!accountID) return undefined
  return { access: current.value.access, accountID, key: [current.id, current.accountGeneration, accountID].join("\0"),
    profile, credentialID: current.id, accountGeneration: current.accountGeneration } satisfies Resolved
})

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
    credentialID: snapshot.credential.id,
    accountGeneration: snapshot.credential.accountGeneration,
  } satisfies Resolved
})
