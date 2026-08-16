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
]
