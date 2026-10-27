import { readDotsAccess, type RemoteDotsAccess } from "@ycoding-ai/remote"
import type { RemoteLink, QueryScope } from "./queries"
import { describeOutcome } from "./outcome"

export function dotsClient(link: RemoteLink, scope: QueryScope, sessionID: string) {
  const read = (value: unknown): RemoteDotsAccess => {
    const data = typeof value === "object" && value !== null ? Reflect.get(value, "data") : undefined
    const access = readDotsAccess(data)
    if (!access || access.sessionID !== sessionID) throw new Error("The machine returned invalid Dots access.")
    return access
  }
  return {
    get: async (signal?: AbortSignal) => {
      const outcome = await link.request(scope, "session.dots.access.get", { sessionID, signal })
      if (outcome.status !== "ok") throw new Error(describeOutcome(outcome, "Dots access"))
      return read(outcome.value)
    },
    set: async (enabled: boolean, expectedRevision: number) => {
      const outcome = await link.request(scope, "session.dots.access.set", { sessionID, input: { enabled, expectedRevision } })
      if (outcome.status !== "ok") return outcome
      return { status: "ok" as const, value: read(outcome.value) }
    },
  }
}
