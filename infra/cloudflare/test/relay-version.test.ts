import { expect, spyOn, test } from "bun:test"
import {
  CONTRACT_DIGEST,
  Connector_ErrorSchema,
  Connector_Error_code,
  FrameSchema,
  create,
  decodeStrict,
  encodeStrict,
  EmptySchema,
  MutationClass,
  operations,
  ScopeSchema,
  Settlement,
  toBinary,
} from "../../../packages/protocol/src/v5"
import { handoffBinary } from "../../../packages/remote/src/index"
import { harness } from "./support/relay"

test("v5 relay accepts a different Hello digest and logs it once", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const h = await harness()
    const peer = await h.attach("client", "client", {}, undefined, false)
    peer.start(h.now())
    const frames: ArrayBuffer[] = []
    handoffBinary(
      peer,
      (_, frame) => {
        if (frame.body.case !== "hello") throw new Error("Expected Hello")
        frame.body.value.contractDigest = new Uint8Array(32).fill(1)
        frames.push(encodeStrict(FrameSchema, frame).slice().buffer)
      },
      h.now(),
    )
    await h.relay.handleClientMessage("client", frames[0])
    h.receive("client")
    await h.send("client")
    h.receive("client")
    expect(peer.state).toBe("established")
    expect(h.close).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls[0])).toContain(CONTRACT_DIGEST)
    expect(JSON.stringify(warn.mock.calls[0])).toContain("01".repeat(32))
  } finally {
    warn.mockRestore()
  }
})

test.each(["frame", "Hello"] as const)("v5 relay names both versions when %s revision differs", async (field) => {
  const h = await harness()
  const peer = await h.attach("client", "client", {}, undefined, false)
  peer.start(h.now())
  const frame = peer.prepareHandoff()!.frame
  if (frame.body.case !== "hello") throw new Error("Expected Hello")
  if (field === "frame") frame.revision = 6
  if (field === "Hello") frame.body.value.revision = 6
  await h.relay.handleClientMessage("client", encodeStrict(FrameSchema, frame).slice().buffer)
  expect(h.close).toEqual([{ id: "client", code: 1008, reason: "Contract version mismatch: local v5, peer v6" }])
  expect(h.receive("client")).toEqual([])
})

test("v5 relay rejects a malformed Hello digest before Ready", async () => {
  const h = await harness()
  const peer = await h.attach("client", "client", {}, undefined, false)
  peer.start(h.now())
  const frame = peer.prepareHandoff()!.frame
  if (frame.body.case !== "hello") throw new Error("Expected Hello")
  frame.body.value.contractDigest = new Uint8Array(31)
  await h.relay.handleClientMessage("client", encodeStrict(FrameSchema, frame).slice().buffer)
  expect(h.close).toEqual([{ id: "client", code: 1008, reason: "INCOMPATIBLE" }])
  expect(h.receive("client")).toEqual([])
})

test("v5 relay rejects only the unknown operation and still serves a known request", async () => {
  const notice = operations.find((operation) => operation.diagnosticName === "notice.subscribe")!
  const future = {
    ...notice,
    operationId: 999_999,
    diagnosticName: "future.start",
    mutation: MutationClass.MUTATION,
    settlement: Settlement.DURABLY_ADMITTED,
    requestType: EmptySchema.typeName,
    errorTypes: [],
  }
  const h = await harness({ operations: [...operations, future] })
  const peer = await h.attach("client")
  const scope = create(ScopeSchema, { target: { case: "machine", value: {} } })
  const requestID = peer.request(future.operationId, scope, new Uint8Array(), 512, h.now()).requestID!
  await h.send("client")
  const result = h
    .receive("client")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "settled")
  expect(result).toMatchObject({
    type: "settled",
    requestID,
    status: "rejected",
    payload: { typeName: Connector_ErrorSchema.typeName },
  })
  if (!result?.payload) throw new Error("Expected typed rejection")
  expect(decodeStrict(Connector_ErrorSchema, result.payload.payload).code).toBe(
    Connector_Error_code.CONNECTOR_ERROR_CODE_UNKNOWN_OPERATION,
  )
  const known = peer.request(notice.operationId, scope, Uint8Array.of(0xa0, 0x06, 0x01), 512, h.now()).requestID!
  expect(known).toBeDefined()
  await h.send("client")
  expect(h.receive("client").flatMap((entry) => entry.decisions)).toContainEqual(
    expect.objectContaining({ type: "settled", requestID: known, status: "success" }),
  )
  expect(h.close).toEqual([])
})

test("v5 relay rejects a future request scope without closing the connection", async () => {
  const h = await harness()
  const peer = await h.attach("client")
  const requestID = h.request(peer, "notice.subscribe")
  const frames: ArrayBuffer[] = []
  handoffBinary(
    peer,
    (_, frame) => {
      if (frame.body.case !== "request") throw new Error("Expected request")
      frame.body.value.scope = create(ScopeSchema)
      frame.body.value.scope.$unknown = [{ no: 8, wireType: 2, data: Uint8Array.of(0) }]
      frames.push(toBinary(FrameSchema, frame).slice().buffer)
    },
    h.now(),
  )
  for (const frame of frames) await h.relay.handleClientMessage("client", frame)
  const result = h
    .receive("client")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "settled")
  expect(result).toMatchObject({ requestID, status: "rejected" })
  expect(decodeStrict(Connector_ErrorSchema, result!.payload!.payload).code).toBe(
    Connector_Error_code.CONNECTOR_ERROR_CODE_UNKNOWN_OPERATION,
  )
  expect(h.close).toEqual([])
})
