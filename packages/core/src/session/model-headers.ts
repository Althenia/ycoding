export * as SessionModelHeaders from "./model-headers"

import { InstallationVersion } from "../installation/version"
import { Provider } from "../provider"
import { SessionSchema } from "./schema"
import { Schema } from "effect"
import { Hash } from "../util/hash"

export const Options = Schema.Struct({
  client: Schema.optional(Schema.String),
  /** Selected provider, when the caller knows it. Gates provider-specific client headers. */
  providerID: Schema.optional(Schema.String),
  accountIdentityDigest: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

const SESSION_HEADER_PROVIDERS = new Set<string>([Provider.ID.opencode, Provider.ID.make("opencode-go")])

export const make = (session: Pick<SessionSchema.Info, "id" | "parentID" | "projectID">, options?: Options) => {
  const affinity =
    options?.accountIdentityDigest === undefined
      ? session.id
      : Hash.sha256(JSON.stringify([session.id, options.accountIdentityDigest]))
  return {
    "x-session-affinity": affinity,
    "X-Session-Id": affinity,
    ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
    // YCoding identifies itself with its own User-Agent. It never presents itself as another
    // client, so this stays constant across providers.
    "User-Agent": `ycoding/${InstallationVersion}`,
    ...(options?.providerID !== undefined && SESSION_HEADER_PROVIDERS.has(options.providerID)
      ? { "x-opencode-session": affinity }
      : {}),
    "x-ycoding-project": session.projectID,
    "x-ycoding-session": session.id,
    "x-ycoding-client": options?.client ?? "cli",
  }
}
