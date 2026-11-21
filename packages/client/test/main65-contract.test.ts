import { expect, test } from "bun:test"
import { IntegrationGroup } from "@ycoding-ai/protocol/groups/integration"
import { operations, PeerRole } from "@ycoding-ai/protocol/v5"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { Schema } from "effect"
import { methodCoverage } from "../src/v5/index.js"
import type { TelemetryRequestSample, TelemetrySample } from "../src/promise/index.js"

test("account skills HTTP and LocalClient contracts retain the existing operation", () => {
  const endpoint = IntegrationGroup.endpoints["integration.accountSkills.read"]
  expect(endpoint).toBeDefined()
  expect(endpoint.method).toBe("GET")
  expect(endpoint.path).toBe("/api/integration/:integrationID/account-skills")
  const matches = operations.filter((operation) => operation.diagnosticName === "integration.accountSkills.read")
  expect(matches).toHaveLength(1)
  expect(matches[0].roles).toEqual([PeerRole.LOCAL_CLIENT])
  expect(matches[0].errorTypes).toContain("ycoding.v5.InvalidRequestError")
  expect(methodCoverage.some((entry) => entry.operation === "integration.accountSkills.read")).toBe(true)
})

test("generated public DTOs retain concrete request and sample definitions", async () => {
  const request: TelemetryRequestSample = {
    kind: "request",
    at: "2026-01-01T00:00:00.000Z",
    operation: "session.list",
    outcome: "ok",
    queueMs: 0,
    totalMs: 1,
  }
  const sample: TelemetrySample = request
  expect(sample.kind).toBe("request")
  const types = await Bun.file(new URL("../src/promise/generated/types.ts", import.meta.url)).text()
  expect(types).toMatch(/export type TelemetryRequestSample = \{/)
  expect(types).toMatch(
    /export type TelemetrySample = TelemetryRequestSample \| TelemetryLongTaskSample \| TelemetryClientSample/,
  )
  expect(types).toMatch(/export type IntegrationAccountSkillsReadInput =/)
  expect(types).toMatch(/export type IntegrationAccountSkillsReadOutput =/)
  expect(types).toMatch(/background\?: "include" \| "exclude"/)
})

test("historical request operations are outside the legacy HTTP page and batch", () => {
  const sample = {
    kind: "request",
    at: "2026-01-01T00:00:00.000Z",
    operation: "artifact.demo.preview",
    outcome: "ok",
    queueMs: 0,
    totalMs: 1,
  }
  const page = { data: [{ receivedAt: 1, sample }], cursor: {} }
  expect(() => Schema.decodeUnknownSync(Telemetry.Page)(page)).toThrow()
  expect(() => Schema.decodeUnknownSync(Telemetry.Batch)({ samples: [sample] })).toThrow()
})

test("legacy HTTP pages preserve current samples and optional fields", () => {
  const sample = {
    kind: "request",
    at: "2026-01-01T00:00:00.000Z",
    operation: "session.list",
    outcome: "failed",
    reason: "cancelled",
    queueMs: 0,
    settlementMs: 1,
    totalMs: 2,
  }
  const page = { data: [{ receivedAt: 1, sample }], cursor: { next: "next" } }
  expect(Schema.decodeUnknownSync(Telemetry.Page)(page)).toEqual(page)
  expect(Schema.decodeUnknownSync(Telemetry.Batch)({ samples: [sample] })).toEqual({ samples: [sample] })
})
