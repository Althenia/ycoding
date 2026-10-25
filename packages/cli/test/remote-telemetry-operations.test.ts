import { expect, test } from "bun:test"
import { isRemoteLatencySample, remoteOperations } from "@ycoding-ai/remote"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { Schema } from "effect"

const excluded = [
  "machine.latency.append",
  "machine.latency.list",
  "machine.telemetry.consent.get",
  "machine.telemetry.consent.set",
]
const sample = (operation: string) => ({
  kind: "request",
  at: "2026-10-04T12:00:00.000Z",
  operation,
  outcome: "ok",
  queueMs: 5,
  settlementMs: 20,
  totalMs: 25,
})

test("every recordable remote request operation decodes as closed local telemetry", () => {
  const recordable = remoteOperations.filter((operation) => !excluded.includes(operation))
  expect(recordable).toHaveLength(remoteOperations.length - excluded.length)
  expect(recordable).toEqual(
    expect.arrayContaining([
      "session.dots.targets",
      "session.dots.status",
      "session.dots.bind",
      "session.dots.unbind",
      "session.dots.send",
      "session.dots.pause",
      "session.dots.resume",
    ]),
  )
  for (const operation of recordable) {
    expect([operation, isRemoteLatencySample(sample(operation))]).toEqual([operation, true])
    expect(Schema.decodeUnknownSync(Telemetry.Operation)(operation)).toBe(operation as never)
    expect<unknown>(Schema.decodeUnknownSync(Telemetry.Sample)(sample(operation))).toEqual(sample(operation))
  }
  expect(Schema.is(Telemetry.Batch)({ samples: recordable.slice(0, 20).map(sample) })).toBe(true)
})

test("telemetry endpoint operations stay outside both closed sample contracts", () => {
  for (const operation of excluded) {
    expect(remoteOperations).toContain(operation as never)
    expect([operation, isRemoteLatencySample(sample(operation))]).toEqual([operation, false])
    expect(Schema.is(Telemetry.Operation)(operation)).toBe(false)
  }
})
