import { Connection } from "../src/v5/connection/index.js"
import type { Decision, Options } from "../src/v5/connection/index.js"
import {
  create,
  encodeStrict,
  decodeStrict,
  FrameSchema,
  ScopeSchema,
  ResultSchema,
  BulkStartSchema,
  BulkPieceSchema,
  ControlSchema,
  CreditSchema,
  ContentKind,
  PeerRole,
  LedgerClass,
  operations,
  encodeAssetMetadata,
  encodeLossless,
  session_attachment_read_RequestSchema,
  session_attachment_read_ResultSchema,
} from "../src/v5/index.js"
import type { Frame } from "../src/v5/index.js"

export function httpFixture(length = 65537, budgets?: Options["budgets"]) {
  const client = new Connection({
    role: PeerRole.REMOTE_CLIENT,
    peer: PeerRole.RELAY,
    operations,
    eventTypes: [],
    now: 0,
    budgets,
  })
  const relay = new Connection({
    role: PeerRole.RELAY,
    peer: PeerRole.REMOTE_CLIENT,
    operations,
    eventTypes: [],
    now: 0,
    budgets,
    epoch: "http-epoch",
    sourceEpoch: "source",
  })
  const decisions: Decision[] = []
  function flush(from: Connection, to: Connection, now = 0) {
    const received: Decision[] = []
    for (;;) {
      const prepared = from.prepareHandoff(now)
      if (!prepared) break
      const bytes = encodeStrict(FrameSchema, prepared.frame)
      from.handoff(prepared, bytes.length, now)
      const token = to.admitIncoming(bytes.length)!
      received.push(...to.acceptIncoming(token, decodeStrict(FrameSchema, bytes), now))
    }
    decisions.push(...received)
    return received
  }
  client.start(0)
  flush(client, relay)
  flush(relay, client)
  flush(client, relay)
  const operation = operations.find((operation) => operation.diagnosticName === "session.attachment.read")!
  function queue(body: Frame["body"], now = 0) {
    return relay.enqueue(body, body.case === "bulkPiece" ? body.value.data.length + 512 : 1024, now)
  }
  function issue(bytes: number, http: boolean, transferID: string, now = 0) {
    const request = client.request(
      operation.operationId,
      create(ScopeSchema, { target: { case: "session", value: "ses_http" } }),
      encodeStrict(
        session_attachment_read_RequestSchema,
        create(session_attachment_read_RequestSchema, {
          params: { sessionID: encodeLossless("ses_http"), digest: encodeLossless("a".repeat(64)) },
        }),
      ),
      512,
      now,
    )
    if (http) client.expectHttpBulk(request.requestID!)
    const admitted = flush(client, relay, now).find((entry) => entry.type === "dispatch")!
    if (admitted.type !== "dispatch") throw new Error("Missing admitted request")
    relay.consume(LedgerClass.NORMAL, admitted.ordinal, now)
    queue(
      {
        case: "result",
        value: create(ResultSchema, {
          requestId: request.requestID!,
          operationId: operation.operationId,
          settlement: operation.settlement,
          outcome: {
            case: "assetMetadata",
            value: encodeAssetMetadata(
              session_attachment_read_ResultSchema,
              create(session_attachment_read_ResultSchema, {
                data: { mime: encodeLossless("image/png"), bytes: BigInt(bytes) },
              }),
            ),
          },
        }),
      },
      now,
    )
    flush(relay, client, now)
    queue(
      {
        case: "bulkStart",
        value: create(BulkStartSchema, {
          requestId: request.requestID!,
          transferId: transferID,
          operationId: operation.operationId,
          typeName: operation.resultType,
          contentKind: ContentKind.ASSET,
          byteCount: BigInt(bytes),
          chunkCount: Math.ceil(bytes / 65536),
        }),
      },
      now,
    )
    const declaration = flush(relay, client, now).find((entry) => entry.type === "httpBulkStart")
    if (http) relay.attachHttpBulk(transferID, now)
    return declaration
  }
  const declaration = issue(length, true, "http-transfer")!
  if (declaration.type !== "httpBulkStart") throw new Error("Missing HTTP declaration")
  function bind() {
    client.beginHttpBody("http-transfer", client.connectionEpoch, 0)
    flush(client, relay, 25)
    flush(relay, client, 25)
    if (client.state !== "established" || relay.state !== "established") throw new Error("HTTP fixture binding failed")
  }
  const piece = (index = 0, size = Math.min(length, 65536)) =>
    create(BulkPieceSchema, {
      transferId: "http-transfer",
      index,
      offset: BigInt(index * 65536),
      data: new Uint8Array(size).fill(137),
    })
  function credit(through: bigint, transferID = "http-transfer") {
    const frame = create(FrameSchema, {
      revision: 5,
      connectionEpoch: relay.connectionEpoch,
      ledger: LedgerClass.TINY,
      deliveryOrdinal: relay.ledger(LedgerClass.TINY).receivedOrdinal + 1n,
      body: {
        case: "control",
        value: create(ControlSchema, {
          kind: {
            case: "credit",
            value: create(CreditSchema, { ledger: LedgerClass.BULK, consumedThrough: through, transferId: transferID }),
          },
        }),
      },
    })
    const bytes = encodeStrict(FrameSchema, frame)
    return relay.acceptIncoming(relay.admitIncoming(bytes.length)!, frame, 25)
  }
  return { client, relay, declaration, decisions, flush, queue, bind, piece, credit, issue }
}
