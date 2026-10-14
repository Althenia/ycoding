import { harness } from "./relay"
import {
  create,
  encodeStrict,
  encodeLossless,
  encodeAssetMetadata,
  ScopeSchema,
  session_message_RequestSchema,
  session_message_ResultSchema,
  session_attachment_read_RequestSchema,
  session_attachment_read_ResultSchema,
  ResultSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  MessageNotFoundErrorSchema,
  TypedPayloadSchema,
  ContentKind,
  LedgerClass,
} from "../../../../packages/protocol/src/v5"
import { frameReservation, readHttpBulk, remoteDescriptors } from "../../../../packages/remote/src/index"
import type { Frame, BulkEnd } from "../../../../packages/protocol/src/v5"

export async function httpBulkFixture(kind: "message" | "asset") {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  const browser = await h.attach("browser")
  await h.attach("unrelated")
  const operation = remoteDescriptors.find(
    (operation) => operation.diagnosticName === (kind === "message" ? "session.message" : "session.attachment.read"),
  )!
  const data =
    kind === "message"
      ? encodeStrict(
          session_message_ResultSchema,
          create(session_message_ResultSchema, {
            data: {
              kind: {
                case: "value8",
                value: {
                  id: encodeLossless("msg_http"),
                  time: { created: 1 },
                  type: 1,
                  agent: encodeLossless("agent"),
                  model: { id: encodeLossless("model"), providerID: encodeLossless("provider") },
                  content: {
                    items: [
                      { kind: { case: "value1", value: { type: 1, text: encodeLossless("x".repeat(2_320_000)) } } },
                    ],
                  },
                },
              },
            },
          }),
        )
      : new Uint8Array(65537).fill(217)
  const request = browser.request(
    operation.operationId,
    create(ScopeSchema, { target: { case: "session", value: "ses_1" } }),
    kind === "message"
      ? encodeStrict(
          session_message_RequestSchema,
          create(session_message_RequestSchema, {
            params: { sessionID: encodeLossless("ses_1"), messageID: encodeLossless("msg_http") },
          }),
        )
      : encodeStrict(
          session_attachment_read_RequestSchema,
          create(session_attachment_read_RequestSchema, {
            params: { sessionID: encodeLossless("ses_1"), digest: encodeLossless("a".repeat(64)) },
          }),
        ),
    512,
    h.now(),
  )
  browser.expectHttpBulk(request.requestID!)
  await h.send("browser")
  const dispatch = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "dispatch")!
  if (dispatch.type !== "dispatch") throw new Error("Missing backend request")
  agent.consume(LedgerClass.NORMAL, dispatch.ordinal, h.now())
  async function send(body: Frame["body"]) {
    agent.enqueue(body, frameReservation(body), h.now())
    await h.send("agent")
    h.receive("agent")
  }
  if (kind === "asset")
    await send({
      case: "result",
      value: create(ResultSchema, {
        requestId: dispatch.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: {
          case: "assetMetadata",
          value: encodeAssetMetadata(
            session_attachment_read_ResultSchema,
            create(session_attachment_read_ResultSchema, {
              data: { mime: encodeLossless("image/png"), bytes: BigInt(data.length) },
            }),
          ),
        },
      }),
    })
  await send({
    case: "bulkStart",
    value: create(BulkStartSchema, {
      requestId: dispatch.requestID,
      transferId: "backend-http",
      operationId: operation.operationId,
      typeName: operation.resultType,
      contentKind: kind === "message" ? ContentKind.TYPED_MESSAGE : ContentKind.ASSET,
      byteCount: BigInt(data.length),
      chunkCount: Math.ceil(data.length / 65536),
    }),
  })
  const declaration = h
    .receive("browser")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "httpBulkStart")!
  if (declaration.type !== "httpBulkStart") throw new Error("Missing HTTP declaration")
  const response = await h.relay.readContent(
    new Request("https://relay.invalid/read", {
      headers: {
        "x-ycoding-owner": "owner",
        "x-ycoding-device": "device",
        "x-ycoding-browser-session": "browser",
        "x-ycoding-connection-epoch": browser.connectionEpoch,
        "x-ycoding-request-id": request.requestID!,
        "x-ycoding-transfer-id": declaration.start.transferId,
        "x-ycoding-target-session": "ses_1",
        ...(kind === "message"
          ? { "x-ycoding-target-message": "msg_http" }
          : { "x-ycoding-target-digest": "a".repeat(64) }),
      },
    }),
    kind === "message",
  )
  const jobs: Promise<void>[] = []
  const decisions: ReturnType<typeof browser.takeDecisions> = []
  const reading = readHttpBulk(browser, declaration, response, {
    now: h.now,
    apply(entries) {
      decisions.push(...entries)
      h.at(h.now() + 25)
      jobs.push(h.send("browser"))
    },
  })
  void reading.catch(() => undefined)
  async function piece(index: number) {
    await send({
      case: "bulkPiece",
      value: create(BulkPieceSchema, {
        transferId: "backend-http",
        index,
        offset: BigInt(index * 65536),
        data: data.slice(index * 65536, (index + 1) * 65536),
      }),
    })
    h.receive("browser")
  }
  async function end(outcome: "success" | Extract<BulkEnd["outcome"], { case: "error" }>, count = data.length) {
    await send({
      case: "bulkEnd",
      value: create(BulkEndSchema, {
        transferId: "backend-http",
        byteCount: BigInt(count),
        outcome: outcome === "success" ? { case: "success", value: {} } : outcome,
      }),
    })
    await Promise.all(jobs)
  }
  return {
    h,
    agent,
    browser,
    data,
    response,
    reading,
    decisions,
    piece,
    end,
    requestID: request.requestID!,
    failure: {
      case: "error" as const,
      value: create(TypedPayloadSchema, {
        typeName: MessageNotFoundErrorSchema.typeName,
        payload: encodeStrict(
          MessageNotFoundErrorSchema,
          create(MessageNotFoundErrorSchema, {
            Tag: 1,
            sessionID: encodeLossless("ses_1"),
            messageID: encodeLossless("msg_http"),
            message: encodeLossless("Message unavailable"),
          }),
        ),
      }),
    },
  }
}
