import { expect, test } from "bun:test"
import { harness } from "./support/relay"
import {
  create,
  ScopeSchema,
  session_attachment_read_RequestSchema,
  session_attachment_read_ResultSchema,
  encodeStrict,
  encodeLossless,
  encodeAssetMetadata,
  ResultSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  ContentKind,
  LedgerClass,
} from "../../../packages/protocol/src/v5"
import { frameReservation, readHttpBulk, remoteDescriptors } from "../../../packages/remote/src/index"

async function fixture(length = 65537, options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options)
  const agent = await h.attach("agent", "agent")
  const browser = await h.attach("browser")
  const operation = remoteDescriptors.find((operation) => operation.diagnosticName === "session.attachment.read")!
  const request = browser.request(
    operation.operationId,
    create(ScopeSchema, { target: { case: "session", value: "ses_1" } }),
    encodeStrict(
      session_attachment_read_RequestSchema,
      create(session_attachment_read_RequestSchema, {
        params: { sessionID: encodeLossless("ses_1"), digest: encodeLossless("a".repeat(64)) },
      }),
    ),
    512,
    0,
  )
  browser.expectHttpBulk(request.requestID!)
  await h.send("browser")
  const dispatch = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "dispatch")!
  if (dispatch.type !== "dispatch") throw new Error("Missing backend request")
  agent.consume(LedgerClass.NORMAL, dispatch.ordinal, 0)
  for (const body of [
    {
      case: "result" as const,
      value: create(ResultSchema, {
        requestId: dispatch.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: {
          case: "assetMetadata",
          value: encodeAssetMetadata(
            session_attachment_read_ResultSchema,
            create(session_attachment_read_ResultSchema, {
              data: { mime: encodeLossless("image/png"), bytes: BigInt(length) },
            }),
          ),
        },
      }),
    },
    {
      case: "bulkStart" as const,
      value: create(BulkStartSchema, {
        requestId: dispatch.requestID,
        transferId: "backend-http",
        operationId: operation.operationId,
        typeName: operation.resultType,
        contentKind: ContentKind.ASSET,
        byteCount: BigInt(length),
        chunkCount: Math.ceil(length / 65536),
      }),
    },
  ]) {
    agent.enqueue(body, frameReservation(body), 0)
    await h.send("agent")
  }
  const declaration = h
    .receive("browser")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "httpBulkStart")!
  if (declaration.type !== "httpBulkStart") throw new Error("Missing browser declaration")
  const headers = new Headers({
    "x-ycoding-owner": "owner",
    "x-ycoding-device": "device",
    "x-ycoding-browser-session": "browser",
    "x-ycoding-connection-epoch": browser.connectionEpoch,
    "x-ycoding-request-id": request.requestID!,
    "x-ycoding-transfer-id": declaration.start.transferId,
    "x-ycoding-target-session": "ses_1",
    "x-ycoding-target-digest": "a".repeat(64),
  })
  return { h, agent, browser, declaration, headers }
}

test("HTTP bulk forwards real protocol pieces only after binding and retains the canonical terminal settlement", async () => {
  const f = await fixture()
  const response = await f.h.relay.readContent(new Request("https://relay.invalid/read", { headers: f.headers }), false)
  expect(response.status).toBe(200)
  expect(response.headers.get("content-length")).toBe("65537")
  const jobs: Promise<void>[] = []
  const reading = readHttpBulk(f.browser, f.declaration, response, {
    now: f.h.now,
    apply() {
      f.h.at(f.h.now() + 25)
      jobs.push(f.h.send("browser"))
    },
  })
  for (let index = 0; index < 2; index++) {
    const body = {
      case: "bulkPiece" as const,
      value: create(BulkPieceSchema, {
        transferId: "backend-http",
        index,
        offset: BigInt(index * 65536),
        data: new Uint8Array(index ? 1 : 65536).fill(217),
      }),
    }
    f.agent.enqueue(body, frameReservation(body), f.h.now())
    await f.h.send("agent")
  }
  const end = {
    case: "bulkEnd" as const,
    value: create(BulkEndSchema, {
      transferId: "backend-http",
      byteCount: 65537n,
      outcome: { case: "success", value: {} },
    }),
  }
  f.agent.enqueue(end, frameReservation(end), f.h.now())
  await f.h.send("agent")
  await reading
  await Promise.all(jobs)
  const complete = f.h
    .receive("browser")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "bulkComplete")!
  if (complete.type !== "bulkComplete") throw new Error("Missing HTTP terminal")
  expect(complete.data).toEqual(new Uint8Array(65537).fill(217))
  f.browser.releaseBulk(complete.transferID)
  f.h.relay.closeDevice()
  expect(f.h.relay.reservation.used).toBe(0)
})

test.each(["epoch", "request", "transfer", "session", "digest", "browser"])(
  "HTTP lookup rejects a different %s without adopting an unowned read",
  async (kind) => {
    const f = await fixture(1)
    const key = {
      epoch: "connection-epoch",
      request: "request-id",
      transfer: "transfer-id",
      session: "target-session",
      digest: "target-digest",
      browser: "browser-session",
    }[kind]!
    f.headers.set(`x-ycoding-${key}`, "another-owner")
    const response = await f.h.relay.readContent(
      new Request("https://relay.invalid/read", { headers: f.headers }),
      false,
    )
    expect(response.status).toBe(kind === "session" || kind === "digest" ? 400 : 409)
    f.h.relay.closeDevice()
    expect(f.h.relay.reservation.used).toBe(0)
  },
)

test("one HTTP owner per live transfer is enforced and abort releases all relay ownership", async () => {
  const f = await fixture(1)
  const aborted = new AbortController()
  const request = new Request("https://relay.invalid/read", { headers: f.headers, signal: aborted.signal })
  const response = await f.h.relay.readContent(request, false)
  expect(response.status).toBe(200)
  expect((await f.h.relay.readContent(new Request(request), false)).status).toBe(409)
  aborted.abort()
  await expect(response.arrayBuffer()).rejects.toThrow()
  f.h.relay.closeDevice()
  expect(f.h.relay.reservation.used).toBe(0)
})

test("a connection lost during fresh HTTP authorization cannot acquire a reader", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let held = false
  const f = await fixture(1, {
    authorize: async () => {
      if (held) {
        entered.resolve()
        await release.promise
      }
      return { ok: true, ownerID: "owner" }
    },
  })
  held = true
  const reading = f.h.relay.readContent(new Request("https://relay.invalid/read", { headers: f.headers }), false)
  await entered.promise
  f.h.relay.detach("browser")
  release.resolve()
  expect((await reading).status).toBe(409)
  f.h.relay.closeDevice()
  expect(f.h.relay.reservation.used).toBe(0)
})

test.each(["revocation", "deadline"])(
  "an HTTP body is torn down on %s without releasing a partial successful read",
  async (kind) => {
    const f = await fixture(1)
    const response = await f.h.relay.readContent(
      new Request("https://relay.invalid/read", { headers: f.headers }),
      false,
    )
    f.h.at(25)
    f.browser.beginHttpBody(f.declaration.start.transferId, f.browser.connectionEpoch, 25)
    f.h.at(50)
    await f.h.send("browser")
    const body = {
      case: "bulkPiece" as const,
      value: create(BulkPieceSchema, { transferId: "backend-http", index: 0, offset: 0n, data: Uint8Array.of(1) }),
    }
    f.agent.enqueue(body, frameReservation(body), 50)
    await f.h.send("agent")
    expect(f.h.relay.connection("browser")!.httpHandedBytes).toBe(1)
    if (kind === "revocation") await f.h.relay.revokeSession("browser")
    if (kind === "deadline") {
      f.h.at(30050)
      f.h.relay.sweep()
    }
    await expect(response.arrayBuffer()).rejects.toThrow()
    expect(f.h.close).toContainEqual(
      expect.objectContaining({ id: "browser", code: kind === "revocation" ? 4401 : 1002 }),
    )
    f.h.relay.closeDevice()
    expect(f.h.relay.reservation.used).toBe(0)
  },
)
