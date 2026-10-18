import { expect, test } from "bun:test"
import {
  BulkEndSchema,
  BulkPieceSchema,
  BulkStartSchema,
  ContentKind,
  ControlSchema,
  Connector_ErrorSchema,
  Connector_Error_code,
  LedgerClass,
  ResultSchema,
  ScopeKind,
  create,
  decodeLossless,
  decodeStrict,
  encodeLossless,
  encodeStrict,
  mcp_request_RequestSchema,
  mcp_request_ResultSchema,
} from "../../../packages/protocol/src/v5"
import type { Frame } from "../../../packages/protocol/src/v5"
import type { Decision } from "../../../packages/protocol/src/v5/connection"
import { frameReservation } from "../../../packages/remote/src/index"
import type { McpState } from "../src/relay/mcp"
import { harness } from "./support/relay"

const principal = { ownerID: "owner", deviceID: "device", clientID: "https://client.example.invalid/client.json" }
const grant = { grantID: "grant", epoch: "e1", resource: "https://relay.example.invalid/api/mcp/devices/device", accessExpiresAt: 100_000, principal }
const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
const reply = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'

async function world() {
  const persisted: McpState[] = []
  const revoked: (string | undefined)[] = []
  const h = await harness({
    mcp: {
      timeoutMs: 60_000,
      authorize: async () => ({ ok: true }),
      authorizeDevice: async () => ({ ok: true }),
      revokeGrants: async (_deviceID, keep) => { revoked.push(keep) },
      persistState: async (_deviceID, state) => { persisted.push(state) },
    },
  })
  const agent = await h.attach("agent", "agent")
  const enqueue = async (body: Frame["body"]) => {
    agent.enqueue(body, frameReservation(body), h.now())
    await h.send("agent")
  }
  const state = async (value: { id: string; enabled: boolean; epoch: string }) => {
    await enqueue({ case: "control", value: create(ControlSchema, { kind: { case: "mcpState", value } }) })
    return h.receive("agent").flatMap((entry) => (entry.frame?.body.case === "control" && entry.frame.body.value.kind.case === "mcpStateAck" ? [entry.frame.body.value.kind.value] : []))
  }
  const dispatched = () =>
    h.receive("agent").flatMap((entry) => entry.decisions).filter((entry): entry is Extract<Decision, { type: "dispatch" }> => entry.type === "dispatch")
  const outcome = (promise: Promise<unknown>) => promise.then((value) => value, (error: unknown) => error)
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const requested = async () => {
    const pending = outcome(h.relay.requestMcp({ grant, body, headers: { "content-type": "application/json" } }))
    await tick()
    const dispatch = dispatched()
    expect(dispatch).toHaveLength(1)
    return { pending, dispatch: dispatch[0]! }
  }
  const success = (status = 200, text = reply) =>
    encodeStrict(mcp_request_ResultSchema, create(mcp_request_ResultSchema, { data: { status, contentType: "application/json", body: encodeLossless(text) } }))
  const result = (dispatch: Extract<Decision, { type: "dispatch" }>, outcome: { case: "success" | "error"; typeName: string; payload: Uint8Array }): Frame["body"] => ({
    case: "result",
    value: create(ResultSchema, {
      requestId: dispatch.requestID,
      operationId: dispatch.operation.operationId,
      settlement: dispatch.operation.settlement,
      outcome: { case: outcome.case, value: { typeName: outcome.typeName, payload: outcome.payload } },
    }),
  })
  return { h, agent, persisted, revoked, enqueue, state, dispatched, outcome, tick, requested, success, result }
}

const failure = (code: string) => expect.objectContaining({ name: "McpRelayError", code })

test("the agent's explicit epoch state is persisted and acknowledged before the relay sends any MCP request", async () => {
  const value = await world()
  expect(value.h.relay.mcpGate()).toMatchObject({ agentID: "agent", state: "unknown" })
  expect(await value.outcome(value.h.relay.requestMcp({ grant, body, headers: {} }))).toEqual(failure("agent_unavailable"))
  expect(value.dispatched()).toEqual([])
  const acks = await value.state({ id: "state_1", enabled: true, epoch: "e1" })
  expect(acks.map((ack) => [ack.id, ack.enabled, ack.epoch])).toEqual([["state_1", true, "e1"]])
  expect(value.persisted).toEqual([{ id: "state_1", enabled: true, epoch: "e1" }])
  expect(value.revoked).toEqual(["e1"])
  expect(value.h.relay.mcpGate()).toMatchObject({ state: "open", epoch: "e1" })
})

test("an MCP request reaches the agent as the relay-only machine-scoped raw operation and settles from its inline result", async () => {
  const value = await world()
  await value.state({ id: "state_1", enabled: true, epoch: "e1" })
  const run = await value.requested()
  expect(run.dispatch.operation.diagnosticName).toBe("mcp.request")
  expect(run.dispatch.request.scope?.target.case).toBe("machine")
  expect(run.dispatch.operation.scope).toBe(ScopeKind.MACHINE)
  const payload = decodeStrict(mcp_request_RequestSchema, run.dispatch.request.payload).payload!
  expect([decodeLossless(payload.body!), payload.epoch, payload.principal!.ownerID, decodeLossless(payload.principal!.clientID!)]).toEqual([body, "e1", "owner", principal.clientID])
  await value.enqueue(value.result(run.dispatch, { case: "success", typeName: mcp_request_ResultSchema.typeName, payload: value.success() }))
  expect(await run.pending).toEqual({ status: 200, contentType: "application/json", body: reply })
  expect(value.h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes).toBe(0)
})

test("a typed-bulk MCP result is reassembled within the relay bound and releases its reservation", async () => {
  const value = await world()
  await value.state({ id: "state_1", enabled: true, epoch: "e1" })
  const baseline = value.h.relay.reservation.used
  const run = await value.requested()
  const text = `{"jsonrpc":"2.0","id":1,"result":{"text":"${"x".repeat(150_000)}"}}`
  const bytes = value.success(200, text)
  const pieces = Array.from({ length: Math.ceil(bytes.length / 65_536) }, (_, index) => bytes.slice(index * 65_536, (index + 1) * 65_536))
  await value.enqueue({
    case: "bulkStart",
    value: create(BulkStartSchema, {
      requestId: run.dispatch.requestID,
      transferId: "mcp-bulk",
      operationId: run.dispatch.operation.operationId,
      typeName: mcp_request_ResultSchema.typeName,
      contentKind: ContentKind.TYPED_MESSAGE,
      byteCount: BigInt(bytes.length),
      chunkCount: pieces.length,
    }),
  })
  for (const [index, data] of pieces.entries()) {
    await value.enqueue({ case: "bulkPiece", value: create(BulkPieceSchema, { transferId: "mcp-bulk", index, offset: BigInt(index * 65_536), data }) })
    value.h.receive("agent")
  }
  await value.enqueue({ case: "bulkEnd", value: create(BulkEndSchema, { transferId: "mcp-bulk", byteCount: BigInt(bytes.length), outcome: { case: "success", value: {} } }) })
  expect(await run.pending).toEqual({ status: 200, contentType: "application/json", body: text })
  expect(value.h.relay.connection("agent")!.ledger(LedgerClass.BULK).receivedBytes).toBe(0)
  expect(value.h.relay.reservation.used).toBeLessThan(baseline + 4096)
})

test("a typed-bulk MCP result beyond two MiB is refused without partial success and cancelled at the agent", async () => {
  const value = await world()
  await value.state({ id: "state_1", enabled: true, epoch: "e1" })
  const run = await value.requested()
  await value.enqueue({
    case: "bulkStart",
    value: create(BulkStartSchema, {
      requestId: run.dispatch.requestID,
      transferId: "mcp-huge",
      operationId: run.dispatch.operation.operationId,
      typeName: mcp_request_ResultSchema.typeName,
      contentKind: ContentKind.TYPED_MESSAGE,
      byteCount: BigInt(2 * 1024 * 1024 + 1),
      chunkCount: 33,
    }),
  })
  expect(await run.pending).toEqual(failure("message_too_large"))
  const cancels = value.h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .filter((entry) => entry.type === "cancelled")
  expect(cancels).toEqual([expect.objectContaining({ requestID: run.dispatch.requestID })])
})

test("an agent's typed error passes through with its code and message", async () => {
  const value = await world()
  await value.state({ id: "state_1", enabled: true, epoch: "e1" })
  const run = await value.requested()
  const error = encodeStrict(Connector_ErrorSchema, create(Connector_ErrorSchema, { code: Connector_Error_code.CONNECTOR_ERROR_CODE_NOT_FOUND, message: encodeLossless("Session missing") }))
  await value.enqueue(value.result(run.dispatch, { case: "error", typeName: Connector_ErrorSchema.typeName, payload: error }))
  expect(await run.pending).toEqual(expect.objectContaining({ code: "not_found", message: "Session missing" }))
})

test("an agent disconnect after dispatch reports an unknown outcome and a replacement agent never receives a replay", async () => {
  const value = await world()
  await value.state({ id: "state_1", enabled: true, epoch: "e1" })
  const run = await value.requested()
  value.h.relay.detach("agent")
  expect(await run.pending).toEqual(failure("outcome_unknown"))
  value.h.at(50_000)
  await value.h.attach("replacement", "agent")
  expect(value.h.relay.mcpGate()).toMatchObject({ agentID: "replacement", state: "unknown" })
  expect(value.dispatched()).toEqual([])
  expect(value.h.receive("replacement").flatMap((entry) => entry.decisions).some((entry) => entry.type === "dispatch")).toBe(false)
})

test("turning relay MCP off withdraws dispatched work as unknown and refuses new requests as forbidden", async () => {
  const value = await world()
  await value.state({ id: "state_1", enabled: true, epoch: "e1" })
  const run = await value.requested()
  const acks = await value.state({ id: "state_2", enabled: false, epoch: "e1" })
  expect(await run.pending).toEqual(failure("outcome_unknown"))
  expect(acks.map((ack) => ack.enabled)).toEqual([false])
  expect(value.revoked).toEqual(["e1", undefined])
  expect(await value.outcome(value.h.relay.requestMcp({ grant, body, headers: {} }))).toEqual(failure("forbidden"))
})
