import { expect, test } from "bun:test"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import { make, methodCoverage } from "../src/v5/index.js"
import type { V5Client } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const report = {
  rows: [
    {
      providerID: "openai",
      modelID: "gpt-5.6",
      agent: "build",
      fallbacks: 3,
      escalated: 2,
      rejected: 1,
      last: 1_700_000_000_000,
    },
    { providerID: "anthropic", modelID: "claude-opus-5", fallbacks: 0, escalated: 0, rejected: 0, last: 0 },
  ],
  groups: 2,
}
const minimalItem = {
  id: "inc_a",
  time: 10,
  kind: "fallback" as const,
  category: "rate_limit",
  ruleIDs: [] as string[],
  agent: "build",
}
const fullItem = {
  id: "inc_b",
  time: 20,
  kind: "guardrail-rejected" as const,
  category: "guardrail",
  ruleIDs: ["standard.review.force-push", "custom.review.release"],
  agent: "build",
  variant: "high",
  profile: "work",
  target: { providerID: "openai", id: "gpt-5.6" },
  decidedBy: "decision-model" as const,
}
const recent = { items: [minimalItem, fullItem] }
const guidance = { text: "Prefer a smaller model after repeated rate limits.", clearedAt: 5, enabled: true }

const type = (name: string) => `ycoding.v5.${name}`
const roundtrip = (name: string, value: unknown) => decodeDomain(type(name), encodeDomain(type(name), value))

test("REQ-WIRE-001 every incident message survives the native wire boundary unchanged", () => {
  expect(roundtrip("incident_report_Result", { data: report })).toEqual({ data: report })
  expect(roundtrip("incident_recent_Result", { data: recent })).toEqual({ data: recent })
  for (const operation of ["get", "clear"]) {
    expect(roundtrip(`incident_guidance_${operation}_Result`, { data: guidance })).toEqual({ data: guidance })
    expect(roundtrip(`incident_guidance_${operation}_Result`, { data: { enabled: false } })).toEqual({
      data: { enabled: false },
    })
  }
  expect(roundtrip("incident_report_Result", { data: { rows: [], groups: 0 } })).toEqual({
    data: { rows: [], groups: 0 },
  })
})

test("REQ-WIRE-001 requests carry the released query fields and omit absent optional ones", () => {
  const full = { query: { group: "agent", from: 1, to: 9, offset: 0, limit: 200 } }
  expect(roundtrip("incident_report_Request", full)).toEqual(full)
  expect(roundtrip("incident_report_Request", { query: { group: "model" } })).toEqual({ query: { group: "model" } })
  const recentQuery = { query: { provider: "openai", model: "gpt-5.6", agent: "build", limit: 50 } }
  expect(roundtrip("incident_recent_Request", recentQuery)).toEqual(recentQuery)
  expect(roundtrip("incident_recent_Request", { query: { provider: "p", model: "m" } })).toEqual({
    query: { provider: "p", model: "m" },
  })
  for (const operation of ["get", "clear"]) {
    expect(roundtrip(`incident_guidance_${operation}_Request`, { query: { provider: "p", model: "m" } })).toEqual({
      query: { provider: "p", model: "m" },
    })
    const located = { query: { provider: "p", model: "m", location: { directory: "/work", workspace: "ws_1" } } }
    expect(roundtrip(`incident_guidance_${operation}_Request`, located)).toEqual(located)
  }
})

test("REQ-WIRE-001 the wire enforces the released query and vocabulary bounds", () => {
  for (const bad of [
    { group: "provider" },
    { group: "model", offset: -1 },
    { group: "model", limit: 0 },
    { group: "model", limit: 201 },
    { group: "model", from: -1 },
    { group: "model", to: 1.5 },
  ])
    expect(() => encodeDomain(type("incident_report_Request"), { query: bad }), JSON.stringify(bad)).toThrow()
  for (const bad of [
    { provider: "p", model: "m", limit: 0 },
    { provider: "p", model: "m", limit: 51 },
    { provider: "p" },
  ])
    expect(() => encodeDomain(type("incident_recent_Request"), { query: bad }), JSON.stringify(bad)).toThrow()
  for (const operation of ["get", "clear"])
    expect(() => encodeDomain(type(`incident_guidance_${operation}_Request`), { query: { provider: "p" } })).toThrow()
  expect(() =>
    encodeDomain(type("incident_recent_Result"), { data: { items: [{ ...minimalItem, kind: "other" }] } }),
  ).toThrow()
  expect(() =>
    encodeDomain(type("incident_recent_Result"), { data: { items: [{ ...minimalItem, decidedBy: "robot" }] } }),
  ).toThrow()
  expect(() => encodeDomain(type("incident_report_Result"), { data: { rows: [], groups: -1 } })).toThrow()
  expect(() =>
    encodeDomain(type("incident_report_Result"), {
      data: { rows: [{ ...report.rows[0], fallbacks: 1.5 }], groups: 1 },
    }),
  ).toThrow()
  expect(() => encodeDomain(type("incident_guidance_get_Result"), { data: { text: "no flag" } })).toThrow()
})

async function dispatch<T>(invoke: (client: V5Client) => Promise<T>) {
  const results: Record<string, unknown> = {
    "incident.report": report,
    "incident.recent": recent,
    "incident.guidance.get": guidance,
    "incident.guidance.clear": { enabled: true },
  }
  const peer = new ScriptedPeer()
  peer.onRequest = (request) =>
    peer.result(request, {
      typeName: request.operation.resultType,
      payload: encodeDomain(request.operation.resultType, { data: results[request.operation.diagnosticName] }),
    })
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    location: { directory: "/fixture", workspaceID: "workspace_fixture" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const value = await invoke(client)
    expect(peer.requests).toHaveLength(1)
    const request = peer.requests[0]
    return {
      value,
      operation: request.operation.diagnosticName,
      operationID: request.operation.operationId,
      scope: request.request.scope?.target.case,
      payload: decodeDomain(request.operation.requestType, request.request.payload),
    }
  } finally {
    client.transport.close()
  }
}

test("REQ-WIRE-001 report and recent address the machine and return their unwrapped data", async () => {
  const reported = await dispatch((client) => client.incident.report({ group: "model", limit: 2 }))
  expect([reported.operation, reported.operationID, reported.scope]).toEqual(["incident.report", 2064, "machine"])
  expect(reported.payload).toEqual({ query: { group: "model", limit: 2 } })
  expect(reported.value).toEqual(report)

  const listed = await dispatch((client) => client.incident.recent({ provider: "openai", model: "gpt-5.6", limit: 20 }))
  expect([listed.operation, listed.operationID, listed.scope]).toEqual(["incident.recent", 2065, "machine"])
  expect(listed.payload).toEqual({ query: { provider: "openai", model: "gpt-5.6", limit: 20 } })
  expect(listed.value).toEqual(recent)
})

test("REQ-WIRE-001 guidance get and clear address the client's Location and return the guidance state", async () => {
  const read = await dispatch((client) => client.incident.guidance.get({ provider: "openai", model: "gpt-5.6" }))
  expect([read.operation, read.operationID, read.scope]).toEqual(["incident.guidance.get", 2066, "location"])
  expect(read.payload).toMatchObject({ query: { provider: "openai", model: "gpt-5.6" } })
  expect(read.value).toEqual(guidance)

  const cleared = await dispatch((client) => client.incident.guidance.clear({ provider: "openai", model: "gpt-5.6" }))
  expect([cleared.operation, cleared.operationID, cleared.scope]).toEqual(["incident.guidance.clear", 2067, "location"])
  expect(cleared.payload).toMatchObject({ query: { provider: "openai", model: "gpt-5.6" } })
  expect(cleared.value).toEqual({ enabled: true })
})

test("REQ-WIRE-001 the incident methods are four canonical LocalClient descriptors in the method inventory", () => {
  expect(
    methodCoverage
      .filter((entry) => entry.method.startsWith("incident."))
      .map((entry) => [entry.method, entry.operation, entry.operationID]),
  ).toEqual([
    ["incident.report", "incident.report", 2064],
    ["incident.recent", "incident.recent", 2065],
    ["incident.guidance.get", "incident.guidance.get", 2066],
    ["incident.guidance.clear", "incident.guidance.clear", 2067],
  ])
})
