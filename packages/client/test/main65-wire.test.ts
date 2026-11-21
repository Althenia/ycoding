import { expect, test } from "bun:test"
import {
  MutationClass,
  Paging,
  PeerRole,
  ScopeKind,
  Sensitivity,
  Settlement,
  Streaming,
  operations,
} from "@ycoding-ai/protocol/v5"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { Schema } from "effect"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"

test("account skills has one appended private Location read descriptor", () => {
  const matches = operations.filter((operation) => operation.diagnosticName === "integration.accountSkills.read")
  expect(matches).toHaveLength(1)
  expect(matches[0]).toMatchObject({
    operationId: 2072,
    roles: [PeerRole.LOCAL_CLIENT],
    scope: ScopeKind.LOCATION,
    mutation: MutationClass.READ,
    settlement: Settlement.COMPLETED,
    paging: Paging.UNPAGED,
    streaming: Streaming.TYPED_BULK,
    sensitivity: Sensitivity.PRIVATE,
  })
  expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(operations.length)
  expect(matches[0].errorTypes).toContain("ycoding.v5.InvalidRequestError")
})

test("account skills request and proof preserve optional, empty and explicit fields", () => {
  const operation = operations.find((item) => item.diagnosticName === "integration.accountSkills.read")!
  const request = {
    params: { integrationID: "openai" },
    query: {
      location: { directory: "/fixture", workspace: "workspace_fixture" },
      sessionID: "ses_fixture",
      agent: "agent_fixture",
      profile: "",
      id: "skill_fixture",
    },
  }
  expect(decodeDomain(operation.requestType, encodeDomain(operation.requestType, request))).toEqual(request)
  expect(() => encodeDomain(operation.requestType, { query: {} })).toThrow()
  const location = { directory: "/fixture", project: { id: "project_fixture", directory: "/fixture" } }
  for (const data of [
    { status: 200, keys: [] },
    {
      status: 200,
      keys: ["items"],
      count: 0,
      hasNext: false,
      paginationKeys: [],
      detail: { status: 200, keys: ["id"] },
    },
  ]) {
    const result = { location, data }
    expect(decodeDomain(operation.resultType, encodeDomain(operation.resultType, result))).toEqual(result)
  }
})

test("all historical telemetry operations stay out of HTTP pages and batches but round-trip on v5", () => {
  const historical = [
    "artifact.demo.preview",
    "artifact.demo.export",
    "local.app.register",
    "local.app.list",
    "local.app.revoke",
    "local.app.open",
    "local.app.status",
    "local.app.http",
    "session.dots.targets",
    "session.dots.status",
    "session.dots.bind",
    "session.dots.unbind",
    "session.dots.send",
    "session.dots.pause",
    "session.dots.resume",
    "session.dots.exchange.create",
    "session.dots.exchange.read",
    "session.dots.delegation.status",
    "session.dots.delegation.create",
    "session.dots.delegation.revoke",
  ]
  for (const operation of historical) {
    const sample = { kind: "request", at: "2026-01-01T00:00:00.000Z", operation, outcome: "ok", queueMs: 0, totalMs: 1 }
    const page = { data: [{ receivedAt: 1, sample }], cursor: { next: "next" } }
    expect(() => Schema.decodeUnknownSync(Telemetry.Page)(page)).toThrow()
    expect(() => Schema.decodeUnknownSync(Telemetry.Batch)({ samples: [sample] })).toThrow()
    const descriptor = operations.find((item) => item.diagnosticName === "telemetry.list")!
    expect(decodeDomain(descriptor.resultType, encodeDomain(descriptor.resultType, { data: page }))).toEqual({
      data: page,
    })
  }
})
