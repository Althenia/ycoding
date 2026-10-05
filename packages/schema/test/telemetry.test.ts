import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Telemetry } from "../src/telemetry.js"

const request = {
  kind: "request",
  at: "2026-10-04T12:00:00.000Z",
  operation: "session.list",
  outcome: "ok",
  queueMs: 5,
  settlementMs: 20,
  totalMs: 25,
}

test("accepts only bounded anonymous request and long-task telemetry batches", () => {
  const valid = [request, { kind: "long-task", at: request.at, durationMs: 50 }]
  expect(Schema.is(Telemetry.Batch)({ samples: valid })).toBe(true)
  for (const input of [
    { samples: [] },
    { samples: Array.from({ length: 21 }, () => request) },
    { samples: valid, deviceID: "dev_private" },
    { samples: [{ ...request, payload: "secret" }] },
    { samples: [{ ...request, operation: "session.private-id" }] },
    { samples: [{ ...request, operation: "machine.latency.append" }] },
    { samples: [{ ...request, operation: "account.read" }] },
    { samples: [{ ...request, operation: "notice.list" }] },
    { samples: [{ ...request, at: "yesterday" }] },
    { samples: [{ ...request, totalMs: 600_001 }] },
    { samples: [{ ...request, settlementMs: Number.NaN }] },
    { samples: [{ ...request, reason: "raw-error" }] },
    { samples: [{ kind: "long-task", at: request.at, durationMs: 49 }] },
    { samples: [{ kind: "long-task", at: request.at, durationMs: 70, url: "private" }] },
  ])
    expect(Schema.is(Telemetry.Batch)(input)).toBe(false)
})
