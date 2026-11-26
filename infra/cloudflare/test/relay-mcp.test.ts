import { expect, test } from "bun:test"
import {
  Connector_ErrorSchema,
  Connector_Error_code,
  ControlSchema,
  FrameSchema,
  LedgerClass,
  ScopeSchema,
  create,
  decodeStrict,
  encodeLossless,
  encodeStrict,
  mcp_request_RequestSchema,
  operations,
} from "../../../packages/protocol/src/v5"
import { retiredOperations } from "../../../packages/protocol/src/v5/retired-operations"
import { frameReservation } from "../../../packages/remote/src/index"
import { harness } from "./support/relay"

test("the binary relay rejects the retired MCP request without closing the browser or dispatching to the agent", async () => {
  const h = await harness()
  await h.attach("agent", "agent")
  const client = await h.attach("browser")
  const operationID = retiredOperations["mcp.request"]
  if (operationID === undefined) throw new Error("Missing retired MCP allocation")
  expect(operations.some(({ operationId }) => operationId === operationID)).toBe(false)
  const frame = create(FrameSchema, {
    revision: 5,
    connectionEpoch: client.connectionEpoch,
    ledger: LedgerClass.NORMAL,
    deliveryOrdinal: client.ledger(LedgerClass.NORMAL).sentOrdinal + 1n,
    body: {
      case: "request",
      value: {
        requestId: "1",
        operationId: operationID,
        scope: create(ScopeSchema, { target: { case: "machine", value: {} } }),
        payload: encodeStrict(
          mcp_request_RequestSchema,
          create(mcp_request_RequestSchema, {
            payload: {
              body: encodeLossless('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'),
              epoch: "retired",
              principal: { ownerID: "owner", deviceID: "device", clientID: encodeLossless("client") },
            },
          }),
        ),
      },
    },
  })
  await h.relay.handleClientMessage("browser", encodeStrict(FrameSchema, frame).slice().buffer)
  const result = h.receive("browser").find(({ frame }) => frame?.body.case === "result")?.frame?.body
  if (result?.case !== "result" || result.value.outcome.case !== "error") throw new Error("Expected a typed rejection")
  expect(result.value).toMatchObject({ requestId: "1", operationId: operationID })
  const error = result.value.outcome.value
  expect(error.typeName).toBe(Connector_ErrorSchema.typeName)
  expect(decodeStrict(Connector_ErrorSchema, error.payload).code).toBe(
    Connector_Error_code.CONNECTOR_ERROR_CODE_UNKNOWN_OPERATION,
  )
  expect(h.close).toEqual([])
  expect(h.receive("agent").flatMap(({ decisions }) => decisions).filter(({ type }) => type === "dispatch")).toEqual([])
  expect(h.relay.agentConnected()).toBe(true)
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})

test("an agent cannot enable the retired MCP relay with a state control", async () => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  await h.attach("browser")
  const body = {
    case: "control" as const,
    value: create(ControlSchema, { kind: { case: "mcpState", value: { id: "state", enabled: true, epoch: "retired" } } }),
  }
  agent.enqueue(body, frameReservation(body), h.now())
  await h.send("agent")
  expect(h.close).toEqual([{ id: "agent", code: 1002, reason: "DIRECTION" }])
  expect(h.receive("agent").some(({ frame }) => frame?.body.case === "control" && frame.body.value.kind.case === "mcpStateAck")).toBe(false)
  expect(h.receive("browser")).toEqual([])
  expect(h.relay.agentConnected()).toBe(false)
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})
