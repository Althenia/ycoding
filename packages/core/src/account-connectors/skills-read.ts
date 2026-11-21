export * as AccountSkillsRead from "./skills-read"

import { Effect, Option } from "effect"
import { AccountConnectors } from "../account-connectors"
import type { Agent } from "../agent"
import type { Integration } from "../integration"
import { Location } from "../location"
import { Session } from "../session"

export interface Input {
  readonly integrationID: Integration.ID
  readonly sessionID?: Session.ID
  readonly agent?: Agent.ID
  readonly profile?: string
  readonly id?: string
}

export class ReadError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message)
  }
}

export const read = Effect.fn("AccountSkillsRead.read")(function* (input: Input) {
  if (input.integrationID !== "openai")
    return yield* Effect.fail(
      new ReadError("unsupported_integration", "Account skills are only supported for the openai integration"),
    )
  if (!input.sessionID) return yield* Effect.fail(new ReadError("missing_provenance", "Session provenance is required"))
  const sessions = yield* Session.Service
  const target = yield* sessions.get(input.sessionID).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  if (!target) return yield* Effect.fail(new ReadError("session_not_found", "Session not found"))
  const location = yield* Location.Service
  if (
    target.location.directory !== location.directory ||
    (target.location.workspaceID ?? "") !== (location.workspaceID ?? "")
  )
    return yield* Effect.fail(
      new ReadError("cross_location_session", "Session does not belong to the requested location"),
    )
  if (!target.agent)
    return yield* Effect.fail(new ReadError("missing_session_agent", "Session has no configured agent"))
  if (input.agent && input.agent !== target.agent)
    return yield* Effect.fail(new ReadError("agent_mismatch", "Agent does not match session agent"))
  const connectors = yield* AccountConnectors.Service
  const reader = yield* connectors
    .skillsRead({ profile: input.profile, permission: { sessionID: target.id, agent: target.agent } })
    .pipe(Effect.mapError((error) => new ReadError("account_skills_configuration", error.message)))
  const list = yield* reader
    .list()
    .pipe(
      Effect.mapError(
        (error) =>
          new ReadError(
            error.message.includes("Permission denied") ? "permission_denied" : "account_skills_read",
            error.message,
          ),
      ),
    )
  if (input.id !== undefined && !list.ids.includes(input.id))
    return yield* Effect.fail(
      new ReadError("unlisted_skill_id", "Requested skill ID was not returned by account skills list"),
    )
  const id = input.id ?? list.ids[0]
  const detail =
    id === undefined
      ? undefined
      : yield* reader.detail(id).pipe(
          Effect.map((result) => ({ status: result.status, keys: result.keys })),
          Effect.mapError((error) => new ReadError("account_skills_read", error.message)),
        )
  return {
    status: list.status,
    keys: list.keys,
    count: list.count,
    hasNext: list.hasNext,
    paginationKeys: list.paginationKeys,
    detail,
  }
})
