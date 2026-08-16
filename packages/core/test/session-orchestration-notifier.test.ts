import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionOrchestrationNotifier } from "@ycoding-ai/core/session/orchestration-notifier"

test("drains notification backlog in bounded batches", async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: `notification-${index}`, delivered: false }))
  const limits: number[] = []
  const delivered: string[] = []
  const notifier = SessionOrchestrationNotifier.make({
    list: (limit) =>
      Effect.sync(() => {
        limits.push(limit)
        return rows.filter((row) => !row.delivered).slice(0, limit)
      }),
    deliver: (row) =>
      Effect.sync(() => {
        delivered.push(row.id)
        return "admitted" as const
      }),
    markDelivered: (row) =>
      Effect.sync(() => {
        row.delivered = true
      }),
  })

  await Effect.runPromise(notifier.dispatch)

  expect(delivered).toHaveLength(205)
  expect(Math.max(...limits)).toBe(SessionOrchestrationNotifier.NotificationBatchSize)
  expect(limits).toEqual([100, 100, 100])
})

test("quarantines deterministic conflicts and does not retry them", async () => {
  const row = { id: "conflict", delivered: false }
  let attempts = 0
  const notifier = SessionOrchestrationNotifier.make({
    list: (limit) => Effect.succeed(row.delivered ? [] : [row].slice(0, limit)),
    deliver: () =>
      Effect.sync(() => {
        attempts++
        return "quarantined" as const
      }),
    markDelivered: () =>
      Effect.sync(() => {
        row.delivered = true
      }),
  })

  await Effect.runPromise(notifier.dispatch)
  await Effect.runPromise(notifier.dispatch)

  expect(attempts).toBe(1)
  expect(row.delivered).toBe(true)
})

test("leaves retryable missing-parent notifications undelivered without spinning", async () => {
  const row = { id: "missing-parent", delivered: false }
  let attempts = 0
  let lists = 0
  const notifier = SessionOrchestrationNotifier.make({
    list: () =>
      Effect.sync(() => {
        lists++
        return [row]
      }),
    deliver: () =>
      Effect.sync(() => {
        attempts++
        return "retry" as const
      }),
    markDelivered: () =>
      Effect.sync(() => {
        row.delivered = true
      }),
  })

  await Effect.runPromise(notifier.dispatch)

  expect(attempts).toBe(1)
  expect(lists).toBe(1)
  expect(row.delivered).toBe(false)
})
