import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  encodeLossless,
  operations,
  fs_read_RequestSchema,
  fs_read_ResultSchema,
  ResultSchema,
  AssetMetadataResultSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  FrameSchema,
  ScopeSchema,
  LedgerClass,
  ContentKind,
  EmptySchema,
  InvalidRequestErrorSchema,
  TypedPayloadSchema,
} from "../src/v5/index.js"
import { pair, send, receive } from "./connection-fixtures.js"
import { Connection } from "../src/v5/connection/index.js"
import {
  PeerRole,
  encodeAssetMetadata,
  session_attachment_read_RequestSchema,
  session_attachment_read_ResultSchema,
} from "../src/v5/index.js"

const operation = operations.find((operation) => operation.diagnosticName === "fs.read")!
function requested(length: number) {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const scope = create(ScopeSchema, { target: { case: "location", value: encodeLossless("/project") } })
  const payload = encodeStrict(
    fs_read_RequestSchema,
    create(fs_read_RequestSchema, { params: { path: encodeLossless("asset.bin") }, query: {} }),
  )
  const request = endpoints.client.request(operation.operationId, scope, payload, 512, 0)
  send(endpoints.client, endpoints.server)
  const metadata = create(AssetMetadataResultSchema, {
    mime: encodeLossless("application/octet-stream"),
    byteCount: BigInt(length),
    metadata: {
      typeName: operation.resultType,
      payload: encodeStrict(
        fs_read_ResultSchema,
        create(fs_read_ResultSchema, {
          data: { mime: encodeLossless("application/octet-stream"), byteCount: BigInt(length) },
        }),
      ),
    },
  })
  const result = create(ResultSchema, {
    requestId: request.requestID,
    operationId: operation.operationId,
    settlement: operation.settlement,
    outcome: { case: "assetMetadata", value: metadata },
  })
  const start = create(BulkStartSchema, {
    requestId: request.requestID,
    transferId: "asset-1",
    operationId: operation.operationId,
    typeName: operation.resultType,
    contentKind: ContentKind.ASSET,
    byteCount: BigInt(length),
    chunkCount: Math.ceil(length / 65536),
  })
  return { ...endpoints, result, metadata, start, requestID: request.requestID! }
}
function frame(
  body: ReturnType<typeof create<typeof FrameSchema>>["body"],
  ordinal: bigint,
  ledger = LedgerClass.NORMAL,
) {
  return create(FrameSchema, { revision: 5, connectionEpoch: "connection-1", deliveryOrdinal: ordinal, ledger, body })
}

test.each([0, 1, 65536, 65537])(
  "AC-WIRE-012 asset metadata and %s raw bytes settle once at exact BulkEnd",
  (length) => {
    const state = requested(length)
    state.server.enqueue({ case: "result", value: state.result }, 512, 0)
    const header = send(state.server, state.client).decisions
    expect(header.some((decision) => decision.type === "settled")).toBe(false)
    expect(header).toContainEqual(expect.objectContaining({ type: "assetMetadata", requestID: state.requestID }))
    state.server.enqueue({ case: "bulkStart", value: state.start }, 512, 0)
    send(state.server, state.client)
    const data = new Uint8Array(length).fill(255)
    for (let offset = 0, index = 0; offset < length; offset += 65536, index++) {
      state.server.enqueue(
        {
          case: "bulkPiece",
          value: create(BulkPieceSchema, {
            transferId: "asset-1",
            index,
            offset: BigInt(offset),
            data: data.subarray(offset, offset + 65536),
          }),
        },
        Math.min(65536, length - offset) + 128,
        0,
      )
      expect(send(state.server, state.client).decisions.some((decision) => decision.type === "settled")).toBe(false)
    }
    state.server.enqueue(
      {
        case: "bulkEnd",
        value: create(BulkEndSchema, {
          transferId: "asset-1",
          byteCount: BigInt(length),
          outcome: { case: "success", value: create(EmptySchema) },
        }),
      },
      512,
      0,
    )
    const terminal = send(state.server, state.client).decisions
    expect(terminal.filter((decision) => decision.type === "settled")).toHaveLength(1)
    expect(terminal).toContainEqual(
      expect.objectContaining({
        type: "settled",
        requestID: state.requestID,
        status: "success",
        payload: state.metadata.metadata,
      }),
    )
    expect(terminal).toContainEqual(expect.objectContaining({ type: "bulkComplete", data, metadata: state.metadata }))
    const completed = terminal.find((decision) => decision.type === "bulkComplete")
    const settled = terminal.find((decision) => decision.type === "settled")
    if (!completed?.metadata?.metadata || settled?.type !== "settled") throw new Error("asset settlement")
    expect(completed.result).toBe(completed.metadata.metadata)
    expect(settled.payload).toBe(completed.result)
    expect(state.client.assetMetadataRetainedBytes).toBeGreaterThan(0)
    state.client.releaseBulk("asset-1")
    expect(state.client.bulkRetainedBytes).toBe(0)
    expect(state.client.assetMetadataRetainedBytes).toBe(0)
    expect(state.server.ledger(LedgerClass.NORMAL).handedBytes).toBeGreaterThan(0)
    if (length) expect(state.server.ledger(LedgerClass.BULK).handedBytes).toBeGreaterThan(0)
  },
)

test.each(["missing", "duplicate", "mime", "length", "count", "piece", "offset", "early"])(
  "AC-WIRE-012 asset %s violation cannot succeed",
  (variant) => {
    const state = requested(65537)
    if (variant !== "missing") {
      if (variant === "mime") state.metadata.mime = encodeLossless("text/plain")
      if (variant === "length") state.metadata.byteCount++
      receive(state.client, frame({ case: "result", value: state.result }, 1n))
    }
    if (variant === "duplicate") receive(state.client, frame({ case: "result", value: state.result }, 2n))
    if (variant === "count") state.start.chunkCount = 1
    if (state.client.state !== "closed")
      receive(state.client, frame({ case: "bulkStart", value: state.start }, variant === "missing" ? 1n : 2n))
    if (state.client.state !== "closed") {
      const piece = create(BulkPieceSchema, {
        transferId: "asset-1",
        index: 0,
        offset: variant === "offset" ? 1n : 0n,
        data: new Uint8Array(variant === "piece" ? 1 : 65536),
      })
      if (variant !== "early") receive(state.client, frame({ case: "bulkPiece", value: piece }, 1n, LedgerClass.BULK))
      receive(
        state.client,
        frame(
          {
            case: "bulkEnd",
            value: create(BulkEndSchema, {
              transferId: "asset-1",
              byteCount: 65537n,
              outcome: { case: "success", value: {} },
            }),
          },
          3n,
        ),
      )
    }
    expect(state.client.state).toBe("closed")
    expect(state.client.reservation.used).toBe(0)
  },
)

test.each(["cancel", "expire", "restart", "transfer"])(
  "AC-WIRE-009/012 %s after metadata settles unknown and frees asset ownership",
  (mode) => {
    const state = requested(2)
    receive(state.client, frame({ case: "result", value: state.result }, 1n))
    if (mode === "transfer") receive(state.client, frame({ case: "bulkStart", value: state.start }, 2n))
    const decisions =
      mode === "restart"
        ? state.client.restart(0)
        : mode === "expire"
          ? state.client.expireRequest(state.requestID, 0)
          : mode === "transfer"
            ? state.client.cancelTransfer("asset-1", 0)
            : state.client.cancel(state.requestID, 0)
    expect(decisions).toContainEqual(
      expect.objectContaining({ type: "settled", requestID: state.requestID, status: "unknown" }),
    )
    expect(state.client.assetMetadataRetainedBytes).toBe(0)
    expect(state.client.bulkRetainedBytes).toBe(0)
    if (mode !== "restart")
      expect(
        receive(state.client, frame({ case: "result", value: state.result }, mode === "transfer" ? 3n : 2n)),
      ).toContainEqual(expect.objectContaining({ type: "dropped", reason: "late" }))
  },
)

test("AC-WIRE-012 declared asset stream error rejects without exposing partial successful bytes", () => {
  const state = requested(2)
  receive(state.client, frame({ case: "result", value: state.result }, 1n))
  receive(state.client, frame({ case: "bulkStart", value: state.start }, 2n))
  const error = create(TypedPayloadSchema, {
    typeName: InvalidRequestErrorSchema.typeName,
    payload: encodeStrict(
      InvalidRequestErrorSchema,
      create(InvalidRequestErrorSchema, { Tag: 1, message: encodeLossless("read failed") }),
    ),
  })
  const decisions = receive(
    state.client,
    frame(
      {
        case: "bulkEnd",
        value: create(BulkEndSchema, {
          transferId: "asset-1",
          byteCount: 0n,
          outcome: { case: "error", value: error },
        }),
      },
      3n,
    ),
  )
  expect(decisions).toContainEqual(expect.objectContaining({ type: "settled", status: "rejected", payload: error }))
  expect(decisions.some((decision) => decision.type === "bulkComplete")).toBe(false)
  expect(state.client.assetMetadataRetainedBytes).toBe(0)
})
test("AC-WIRE-012 relay forwards asset metadata and raw pieces without endpoint reassembly", () => {
  const agent = new Connection({ role: PeerRole.AGENT, peer: PeerRole.RELAY, operations, eventTypes: [], now: 0 })
  const relay = new Connection({
    role: PeerRole.RELAY,
    peer: PeerRole.AGENT,
    operations,
    eventTypes: [],
    epoch: "connection-1",
    sourceEpoch: "relay-source",
    now: 0,
  })
  agent.start(0)
  send(agent, relay)
  send(relay, agent)
  send(agent, relay)
  send(relay, agent)
  const operation = operations.find((operation) => operation.diagnosticName === "session.attachment.read")!
  const scope = create(ScopeSchema, { target: { case: "session", value: "ses_a" } })
  const request = relay.request(
    operation.operationId,
    scope,
    encodeStrict(
      session_attachment_read_RequestSchema,
      create(session_attachment_read_RequestSchema, {
        params: { sessionID: encodeLossless("ses_a"), digest: encodeLossless("a".repeat(64)) },
      }),
    ),
    512,
    0,
  )
  send(relay, agent)
  const metadata = encodeAssetMetadata(
    session_attachment_read_ResultSchema,
    create(session_attachment_read_ResultSchema, { data: { mime: encodeLossless("text/plain"), bytes: 1n } }),
  )
  agent.enqueue(
    {
      case: "result",
      value: create(ResultSchema, {
        requestId: request.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: { case: "assetMetadata", value: metadata },
      }),
    },
    512,
    0,
  )
  const header = send(agent, relay)
  expect(header.decisions).toContainEqual(expect.objectContaining({ type: "assetMetadata", frame: header.frame }))
  const bodies = [
    {
      case: "bulkStart" as const,
      value: create(BulkStartSchema, {
        requestId: request.requestID,
        transferId: "relay-asset",
        operationId: operation.operationId,
        typeName: operation.resultType,
        contentKind: ContentKind.ASSET,
        byteCount: 1n,
        chunkCount: 1,
      }),
    },
    {
      case: "bulkPiece" as const,
      value: create(BulkPieceSchema, { transferId: "relay-asset", index: 0, offset: 0n, data: new Uint8Array([255]) }),
    },
    {
      case: "bulkEnd" as const,
      value: create(BulkEndSchema, {
        transferId: "relay-asset",
        byteCount: 1n,
        outcome: { case: "success", value: {} },
      }),
    },
  ]
  for (const body of bodies) {
    agent.enqueue(body, 512, 0)
    const forwarded = send(agent, relay)
    expect(forwarded.decisions).toContainEqual({ type: "bulkForward", frame: forwarded.frame })
    expect(relay.bulkRetainedBytes).toBe(0)
    expect(relay.assetMetadataRetainedBytes).toBe(0)
    expect(forwarded.decisions.some((decision) => decision.type === "bulkComplete")).toBe(false)
  }
  expect(relay.ledger(LedgerClass.NORMAL).receivedBytes).toBeGreaterThan(0)
})
