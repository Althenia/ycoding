import { readDotsStatus, type RemoteDotsStatus } from "@ycoding-ai/remote"
import type { RemoteLink, QueryScope } from "./queries"
import { describeOutcome } from "./outcome"

export function dotsClient(link: RemoteLink, scope: QueryScope) {
  const read = (value: unknown): RemoteDotsStatus => {
    const data = typeof value === "object" && value !== null ? Reflect.get(value, "data") : undefined
    const status = readDotsStatus(data)
    if (!status) throw new Error("The machine returned invalid Dots status.")
    return status
  }
  return {
    get: async (signal?: AbortSignal) => {
      const outcome = await link.request(scope, "dots.get", { signal })
      if (outcome.status !== "ok") throw new Error(describeOutcome(outcome, "Dots connection"))
      return read(outcome.value)
    },
    set: async (enabled: boolean, expectedRevision: number) => {
      const outcome = await link.request(scope, "dots.set", { input: { enabled, expectedRevision } })
      if (outcome.status !== "ok") return outcome
      return { status: "ok" as const, value: read(outcome.value) }
    },
  }
}
