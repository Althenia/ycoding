import { Effect } from "effect"
import { YCoding as EffectYCoding, type AppApi as EffectApi } from "../src/effect"

type EffectClient = Effect.Success<ReturnType<typeof EffectYCoding.make>>
type PromiseClient = ReturnType<typeof import("../src/promise").YCoding.make>

declare const effectClient: EffectClient
declare const promiseClient: PromiseClient

const effectApi: EffectApi<unknown> = effectClient

declare const sessionID: Parameters<typeof effectApi.session.instructions.entry.list>[0]["sessionID"]

const effectList: Effect.Effect<
  ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
  unknown
> = effectApi.session.instructions.entry.list({ sessionID })
const effectPut: Effect.Effect<void, unknown> = effectApi.session.instructions.entry.put({
  sessionID,
  key: "review-notes",
  value: { text: "Check the diff" },
})
const effectRemove: Effect.Effect<void, unknown> = effectApi.session.instructions.entry.remove({
  sessionID,
  key: "review-notes",
})

const promiseList: Promise<ReadonlyArray<{ readonly key: string; readonly value: unknown }>> =
  promiseClient.session.instructions.entry.list({ sessionID: "ses_test" })
const promisePut: Promise<void> = promiseClient.session.instructions.entry.put({
  sessionID: "ses_test",
  key: "review-notes",
  value: { text: "Check the diff" },
})
const promiseRemove: Promise<void> = promiseClient.session.instructions.entry.remove({
  sessionID: "ses_test",
  key: "review-notes",
})

const effectAutonomyGet: Effect.Effect<
  { readonly mode: "normal" | "yolo" | "goal"; readonly goal?: { readonly text: string } },
  unknown
> = effectApi.session.autonomy.get({ sessionID })
const effectAutonomySet: Effect.Effect<
  { readonly mode: "normal" | "yolo" | "goal" },
  unknown
> = effectApi.session.autonomy.set({
  sessionID,
  payload: { mode: "goal", goal: "Finish the migration" },
})
const promiseAutonomyGet: Promise<{ readonly mode: "normal" | "yolo" | "goal" }> =
  promiseClient.session.autonomy.get({ sessionID: "ses_test" })
const promiseAutonomySet: Promise<{ readonly mode: "normal" | "yolo" | "goal" }> =
  promiseClient.session.autonomy.set({ sessionID: "ses_test", payload: { mode: "yolo" } })
const effectUsageReport: Effect.Effect<
  {
    readonly group: "day"
    readonly rows: ReadonlyArray<{ readonly key: string; readonly logical: number }>
    readonly rowCount: number
  },
  unknown
> = effectApi.session.usageReport({
  sessionID,
  group: "day",
  from: 0,
  to: 1,
  offset: 0,
  limit: 200,
  sort: "tokens",
  order: "desc",
})
const promiseUsageReport: Promise<{
  group: "model" | "hour" | "day" | "month" | "session" | "project" | "agent"
  rows: Array<{ key: string; label: string; logical: number }>
  rowCount: number
}> = promiseClient.session.usageReport({ sessionID: "ses_test", group: "model" })
const effectGlobalUsage: Effect.Effect<{ readonly logical: number }, unknown> = effectApi.usage.get()
const effectGlobalReport: Effect.Effect<{ readonly group: "project" }, unknown> = effectApi.usage.report({
  group: "project",
  sort: "tokens",
  order: "desc",
})
const promiseGlobalUsage: Promise<{ logical: number }> = promiseClient.usage.get()
const promiseGlobalReport: Promise<{ group: "project" | "model" | "hour" | "day" | "month" | "session" | "agent" }> =
  promiseClient.usage.report({ group: "project", limit: 25 })

void [
  effectList,
  effectPut,
  effectRemove,
  promiseList,
  promisePut,
  promiseRemove,
  effectAutonomyGet,
  effectAutonomySet,
  promiseAutonomyGet,
  promiseAutonomySet,
  effectUsageReport,
  promiseUsageReport,
  effectGlobalUsage,
  effectGlobalReport,
  promiseGlobalUsage,
  promiseGlobalReport,
]
