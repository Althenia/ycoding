import { expect, test } from "bun:test"
import {
  createRemoteConnection,
  createRelayConnection,
  remotePayloadCodecs,
  remoteDescriptors,
  encodeRemoteRequest,
  decodeRemoteResult,
  decodeRemoteEvent,
  encodeRemoteScope,
  decodeRemoteScope,
  encodeLossless,
  decodeLossless,
  create,
  encodeStrict,
  ScopeSchema,
  ResultSchema,
  ConnectorNoticeSettlementSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  PublicEventSchema,
  SessionLogItemSchema,
  TypedPayloadSchema,
  ContentKind,
  PeerRole,
  ReservationBudget,
  receiveBinary,
  handoffBinary,
  frameReservation,
  takeAsset,
} from "../src/index"
import type { Connection, Frame } from "../src/index"

function pair() {
  const client = createRemoteConnection({ now: 0 })
  const relay = createRelayConnection(
    PeerRole.REMOTE_CLIENT,
    "connection",
    "relay-source",
    0,
    new ReservationBudget(32 * 1024 * 1024),
  )
  const send = (from: Connection, to: Connection) => {
    const deliveries: ReturnType<typeof receiveBinary>[] = []
    handoffBinary(from, (bytes) => deliveries.push(receiveBinary(to, bytes.slice().buffer, 0)), 0)
    return deliveries
  }
  client.start(0)
  send(client, relay)
  send(relay, client)
  send(client, relay)
  send(relay, client)
  return { client, relay, send }
}

const session = create(ScopeSchema, { target: { case: "session", value: "ses_browser" } })

test("the remote client constructor fixes both authenticated roles and keeps caller budgets and ownership", () => {
  const reservation = new ReservationBudget(32 * 1024 * 1024)
  const client = createRemoteConnection(
    Object.assign(
      { now: 0, reservation, budgets: { pendingRequests: 4 } },
      { role: PeerRole.AGENT, peer: PeerRole.SERVER },
    ),
  )
  expect(client.options.role).toBe(PeerRole.REMOTE_CLIENT)
  expect(client.options.peer).toBe(PeerRole.RELAY)
  expect(client.reservation).toBe(reservation)
  expect(client.budgets.pendingRequests).toBe(4)
  const connected = pair()
  expect(connected.client.state).toBe("established")
  expect(connected.relay.state).toBe("established")
})

test("compiled payload codecs cover exactly the closed remote operation set and every declared typed error", async () => {
  expect(remotePayloadCodecs.size).toBe(79)
  expect([...remotePayloadCodecs.keys()].sort()).toEqual(
    remoteDescriptors.map((operation) => operation.diagnosticName).sort(),
  )
  for (const operation of remoteDescriptors) {
    const codec = remotePayloadCodecs.get(operation.diagnosticName)!
    expect(codec.request.schema.typeName).toBe(operation.requestType)
    expect(codec.result.schema.typeName).toBe(operation.resultType)
    expect([...codec.errors.keys()]).toEqual(operation.errorTypes)
    expect([...codec.errors.values()].map((error) => error.schema.typeName)).toEqual(operation.errorTypes)
  }
  expect(remotePayloadCodecs.has("health.stop")).toBe(false)
  expect(remotePayloadCodecs.has("fs.read")).toBe(false)
  for (const name of ["incident.report", "incident.recent", "incident.guidance.get"])
    expect(remotePayloadCodecs.has(name)).toBe(true)
  expect(remotePayloadCodecs.has("incident.guidance.clear")).toBe(false)
  const payloads = await import("../src/payloads")
  expect(
    Object.values(payloads)
      .map<string>((schema) => schema.typeName)
      .sort(),
  ).toEqual(
    [
      ...new Set(
        remoteDescriptors.flatMap((operation) => [
          operation.requestType,
          operation.resultType,
          ...operation.errorTypes,
        ]),
      ),
    ].sort(),
  )
})

test("request payload codecs preserve raw upload octets and reject a different operation's generated message", () => {
  const codec = remotePayloadCodecs.get("session.attachment.upload")!
  const message = create(codec.request.schema, {
    payload: {
      uploadID: encodeLossless("00000000-0000-4000-8000-000000000000"),
      index: 0n,
      offset: 0n,
      last: true,
      data: Uint8Array.of(0, 255, 128),
    },
  })
  expect(codec.request.decode(encodeRemoteRequest("session.attachment.upload", message))).toEqual(message)
  expect(() => encodeRemoteRequest("notice.read", message)).toThrow("does not match")
  expect(() => encodeRemoteRequest("health.stop", message)).toThrow("Unknown remote operation")
  expect(() => codec.request.decode(Uint8Array.of(255))).toThrow()
})

test("result codecs preserve generated typed success and error identity and reject unrelated or malformed payloads", () => {
  const codec = remotePayloadCodecs.get("notice.read")!
  const result = create(codec.result.schema, { data: {} })
  const typed = decodeRemoteResult(
    "notice.read",
    create(TypedPayloadSchema, {
      typeName: codec.result.schema.typeName,
      payload: codec.result.encode(result),
    }),
    ConnectorNoticeSettlementSchema,
  )
  expect(typed.data?.$typeName).toBe("ycoding.v5.Empty")
  expect(
    decodeRemoteResult(
      "notice.read",
      create(TypedPayloadSchema, { typeName: codec.result.schema.typeName, payload: codec.result.encode(result) }),
    ),
  ).toEqual(result)
  const error = codec.errors.get("ycoding.v5.Connector_Error")!
  const failure = create(error.schema, { code: 1, message: encodeLossless("denied\ud800") })
  expect(
    decodeRemoteResult(
      "notice.read",
      create(TypedPayloadSchema, { typeName: error.schema.typeName, payload: error.encode(failure) }),
    ),
  ).toEqual(failure)
  expect(() =>
    decodeRemoteResult(
      "notice.read",
      create(TypedPayloadSchema, { typeName: PublicEventSchema.typeName, payload: new Uint8Array() }),
    ),
  ).toThrow("does not match")
  expect(() =>
    decodeRemoteResult(
      "notice.read",
      create(TypedPayloadSchema, { typeName: codec.result.schema.typeName, payload: Uint8Array.of(255) }),
    ),
  ).toThrow()
})

test("scope and lossless-string codecs retain their exact wire values", () => {
  expect(decodeRemoteScope(encodeRemoteScope(session))).toEqual(session)
  expect(() => decodeRemoteScope(Uint8Array.of(255))).toThrow()
  expect(decodeLossless(encodeLossless("empty\u0000lone\ud800"))).toBe("empty\u0000lone\ud800")
})

test("the event decoder accepts only the two declared event payload types and validates their bytes", () => {
  const event = create(PublicEventSchema, {
    kind: {
      case: "sessionStatus",
      value: {
        id: encodeLossless("evt_browser"),
        created: 0,
        type: 1,
        data: { sessionID: encodeLossless("ses_browser"), status: { kind: { case: "value1", value: { type: 1 } } } },
      },
    },
  })
  const typed = create(TypedPayloadSchema, {
    typeName: PublicEventSchema.typeName,
    payload: encodeStrict(PublicEventSchema, event),
  })
  expect(decodeRemoteEvent(typed)).toEqual(event)
  expect(() =>
    decodeRemoteEvent(
      create(TypedPayloadSchema, { typeName: SessionLogItemSchema.typeName, payload: Uint8Array.of(255) }),
    ),
  ).toThrow()
  expect(() =>
    decodeRemoteEvent(create(TypedPayloadSchema, { typeName: "ycoding.v5.Empty", payload: new Uint8Array() })),
  ).toThrow("Unknown remote event")
})

test.each([0, 65537])(
  "socket asset ownership hands the complete %s-byte body and canonical Result to a reserved reader",
  (length) => {
    const connected = pair()
    const codec = remotePayloadCodecs.get("session.attachment.read")!
    const request = connected.client.request(
      codec.operation.operationId,
      session,
      encodeRemoteRequest(
        "session.attachment.read",
        create(codec.request.schema, {
          params: { sessionID: encodeLossless("ses_browser"), digest: encodeLossless("a".repeat(64)) },
        }),
      ),
      512,
      0,
    )
    const received = connected.send(connected.client, connected.relay).flatMap((item) => item.decisions)
    expect(received.some((decision) => decision.type === "dispatch")).toBe(true)
    const payload = create(TypedPayloadSchema, {
      typeName: codec.result.schema.typeName,
      payload: codec.result.encode(
        create(codec.result.schema, { data: { mime: encodeLossless("image/png"), bytes: BigInt(length) } }),
      ),
    })
    const metadata = { metadata: payload, mime: encodeLossless("image/png"), byteCount: BigInt(length) }
    const deliver = (body: Frame["body"]) => {
      expect(
        connected.relay.enqueue(body, frameReservation(body), 0).some((decision) => decision.type === "closed"),
      ).toBe(false)
      return connected.send(connected.relay, connected.client).flatMap((item) => item.decisions)
    }
    const declared = deliver({
      case: "result",
      value: create(ResultSchema, {
        requestId: request.requestID!,
        operationId: codec.operation.operationId,
        settlement: codec.operation.settlement,
        outcome: { case: "assetMetadata", value: metadata },
      }),
    })
    expect(declared.some((decision) => decision.type === "assetMetadata")).toBe(true)
    expect(declared.some((decision) => decision.type === "settled")).toBe(false)
    deliver({
      case: "bulkStart",
      value: create(BulkStartSchema, {
        requestId: request.requestID!,
        transferId: "asset-browser",
        operationId: codec.operation.operationId,
        typeName: codec.result.schema.typeName,
        contentKind: ContentKind.ASSET,
        byteCount: BigInt(length),
        chunkCount: Math.ceil(length / 65536),
      }),
    })
    const data = new Uint8Array(length).fill(213)
    for (let offset = 0, index = 0; offset < length; offset += 65536, index++)
      deliver({
        case: "bulkPiece",
        value: create(BulkPieceSchema, {
          transferId: "asset-browser",
          offset: BigInt(offset),
          index,
          data: data.subarray(offset, offset + 65536),
        }),
      })
    const ended = deliver({
      case: "bulkEnd",
      value: create(BulkEndSchema, {
        transferId: "asset-browser",
        byteCount: BigInt(length),
        outcome: { case: "success", value: {} },
      }),
    })
    expect(ended).toContainEqual(
      expect.objectContaining({ type: "settled", requestID: request.requestID, status: "success" }),
    )
    const complete = ended.find((decision) => decision.type === "bulkComplete")!
    if (complete.type !== "bulkComplete" || !complete.metadata) throw new Error("Missing owned asset")
    expect(takeAsset(connected.client, complete, new ReservationBudget(1))).toBeUndefined()
    expect(connected.client.assetMetadataRetainedBytes).toBeGreaterThan(0)
    const owner = new ReservationBudget(2 * 1024 * 1024)
    const asset = takeAsset(connected.client, complete, owner)!
    expect(asset.data).toEqual(data)
    expect(asset.result).toEqual(payload)
    expect(decodeRemoteResult("session.attachment.read", asset.result)).toEqual(
      create(codec.result.schema, { data: { mime: encodeLossless("image/png"), bytes: BigInt(length) } }),
    )
    expect(connected.client.assetMetadataRetainedBytes).toBe(0)
    expect(owner.used).toBeGreaterThan(length)
    asset.release()
    asset.release()
    expect(owner.used).toBe(0)
  },
)
