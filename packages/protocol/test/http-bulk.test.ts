import { expect, test } from "bun:test"
import { httpFixture } from "./http-fixtures.js"
import {
  create,
  BulkPieceSchema,
  BulkEndSchema,
  FrameSchema,
  encodeStrict,
  LedgerClass,
  FailureCategory,
} from "../src/v5/index.js"

test("large HTTP bodies return tiny receipts without waiting for heartbeat or application traffic", () => {
  const length = 40 * 65536 + 1
  const h = httpFixture(length)
  h.bind()
  for (let offset = 0, index = 0; offset < length; offset += 65536, index++) {
    const piece = h.piece(index, Math.min(65536, length - offset))
    expect(h.relay.handoffHttpPiece(piece, 25).accepted).toBe(true)
    h.client.receiveHttpPiece("http-transfer", piece.data, 25)
    if (offset + piece.data.length === length) h.client.completeHttpBody("http-transfer", 25)
    h.flush(h.client, h.relay, 25)
    h.flush(h.relay, h.client, 25)
    h.flush(h.client, h.relay, 25)
  }
  expect(h.relay.httpBulkConsumed("http-transfer")).toBe(true)
  expect(h.relay.httpHandedBytes).toBe(0)
  expect(h.client.state).toBe("established")
  expect(h.relay.state).toBe("established")
})

test("a final HTTP Credit refused by a full tiny queue is retained until a real receipt frees capacity", () => {
  const length = 36 * 65536 + 1
  const h = httpFixture(length)
  h.bind()
  for (let offset = 0, index = 0; offset < length; offset += 65536, index++) {
    const piece = h.piece(index, Math.min(65536, length - offset))
    expect(h.relay.handoffHttpPiece(piece, 25).accepted).toBe(true)
    h.client.receiveHttpPiece("http-transfer", piece.data, 25)
    if (offset + piece.data.length === length) h.client.completeHttpBody("http-transfer", 25)
    h.flush(h.client, h.relay, 25)
  }
  expect(h.relay.httpBulkConsumed("http-transfer")).toBe(false)
  h.flush(h.relay, h.client, 25)
  h.flush(h.client, h.relay, 25)
  h.flush(h.relay, h.client, 25)
  expect(h.relay.httpBulkConsumed("http-transfer")).toBe(true)
  expect(h.relay.httpHandedBytes).toBe(0)
})

test.each([0, 65537])("HTTP assembly preserves a complete %s-byte asset through its canonical BulkEnd", (length) => {
  const h = httpFixture(length)
  h.bind()
  if (length === 0) {
    h.client.completeHttpBody("http-transfer", 25)
    h.flush(h.client, h.relay, 50)
  }
  for (let offset = 0, index = 0; offset < length; offset += 65536, index++) {
    const piece = h.piece(index, Math.min(65536, length - offset))
    expect(h.relay.handoffHttpPiece(piece, 25).accepted).toBe(true)
    h.client.receiveHttpPiece("http-transfer", piece.data, 25)
    if (offset + piece.data.length === length) h.client.completeHttpBody("http-transfer", 25)
    h.flush(h.client, h.relay, 25)
  }
  const now = length === 0 ? 50 : 25
  expect(
    h.queue(
      {
        case: "bulkEnd",
        value: create(BulkEndSchema, {
          transferId: "http-transfer",
          byteCount: BigInt(length),
          outcome: { case: "success", value: {} },
        }),
      },
      now,
    ),
  ).toEqual([])
  const ended = h.flush(h.relay, h.client, now)
  const complete = ended.find((entry) => entry.type === "bulkComplete")!
  if (complete.type !== "bulkComplete") throw new Error("Missing complete HTTP asset")
  expect(complete.data).toEqual(new Uint8Array(length).fill(137))
  expect(ended.some((entry) => entry.type === "settled" && entry.status === "success")).toBe(true)
  expect(h.relay.httpHandedBytes).toBe(0)
  h.client.releaseBulk("http-transfer")
  expect(h.client.bulkRetainedBytes).toBe(0)
})

test("HTTP selection retains BulkStart responsibility until a bound response releases its normal receipt", () => {
  const h = httpFixture()
  expect(h.relay.handoffHttpPiece(h.piece(), 0).accepted).toBe(true)
  expect(h.client.ledger(LedgerClass.NORMAL).receivedBytes).toBeGreaterThan(0)
  expect(h.relay.httpHandedBytes).toBe(65536)
  expect(() => h.client.beginHttpBody("http-transfer", "another-epoch", 0)).toThrow("HTTP body owner")
  h.bind()
  expect(h.relay.httpHandedBytes).toBe(65536)
})

test("native HTTP handoff stays charged until its exact transfer-scoped virtual prefix is consumed", () => {
  const h = httpFixture()
  h.bind()
  const owned = h.relay.reservation.used
  h.relay.handoffHttpPiece(h.piece(), 25)
  expect(h.relay.reservation.used).toBe(owned + 65536)
  expect(h.relay.httpBulkConsumed("http-transfer")).toBe(false)
  const consumed = h.credit(1n)
  expect(consumed).toContainEqual({
    type: "httpBulkReleased",
    transferID: "http-transfer",
    through: 1n,
    consumed: true,
  })
  expect(h.relay.reservation.used).toBe(owned)
  expect(h.relay.httpBulkConsumed("http-transfer")).toBe(true)
})

test("HTTP and socket bulk handoffs share the same negotiated byte window", () => {
  const h = httpFixture(131072, { bulkWindowBytes: 70000 })
  h.bind()
  expect(h.relay.handoffHttpPiece(h.piece(), 25).accepted).toBe(true)
  expect(h.relay.handoffHttpPiece(h.piece(1), 25).accepted).toBe(false)
  h.issue(65536, false, "socket-transfer", 25)
  expect(
    h.queue(
      {
        case: "bulkPiece",
        value: create(BulkPieceSchema, {
          transferId: "socket-transfer",
          index: 0,
          offset: 0n,
          data: new Uint8Array(65536),
        }),
      },
      25,
    ),
  ).toEqual([])
  expect(h.relay.prepareHandoff(25)).toBeUndefined()
  h.credit(1n)
  expect(h.relay.prepareHandoff(25)?.frame.body.case).toBe("bulkPiece")
})

test.each(["unknown", "future", "duplicate"])(
  "a %s HTTP consumption grant cannot refund unconsumed responsibility",
  (kind) => {
    const h = httpFixture()
    h.bind()
    h.relay.handoffHttpPiece(h.piece(), 25)
    if (kind === "duplicate") h.credit(1n)
    const rejected = h.credit(kind === "future" ? 2n : 1n, kind === "unknown" ? "unowned-transfer" : "http-transfer")
    expect(rejected).toContainEqual(expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }))
    expect(h.relay.httpHandedBytes).toBe(0)
    expect(h.relay.reservation.used).toBe(0)
  },
)

test.each(["index", "offset", "length"])(
  "HTTP pieces reject a wrong %s instead of accepting a discontinuous or short prefix",
  (kind) => {
    const h = httpFixture()
    h.bind()
    const piece = h.piece()
    if (kind === "index") piece.index = 1
    if (kind === "offset") piece.offset = 1n
    if (kind === "length") piece.data = new Uint8Array(65535)
    expect(h.relay.handoffHttpPiece(piece, 25).decisions).toContainEqual(
      expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }),
    )
    expect(h.relay.reservation.used).toBe(0)
  },
)

test("a stalled HTTP piece expires at its own consumption deadline and teardown refunds its entire owner", () => {
  const h = httpFixture()
  h.bind()
  h.relay.handoffHttpPiece(h.piece(), 25)
  h.flush(h.client, h.relay, 20000)
  h.flush(h.relay, h.client, 20000)
  expect(h.relay.advance(30024).some((entry) => entry.type === "closed")).toBe(false)
  expect(h.relay.advance(30025)).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.LIMIT }),
  )
  expect(h.relay.reservation.used).toBe(0)
})

test("cancellation and revocation release HTTP data and reservations without a successful settlement", () => {
  for (const revoke of [false, true]) {
    const h = httpFixture()
    h.bind()
    h.relay.handoffHttpPiece(h.piece(), 25)
    const ended = revoke ? h.relay.updateAuthority(1, false, 25, 4403) : h.relay.cancelTransfer("http-transfer", 25)
    expect(ended.some((entry) => entry.type === "settled" && entry.status === "success")).toBe(false)
    expect(h.relay.httpHandedBytes).toBe(0)
    if (revoke) expect(h.relay.reservation.used).toBe(0)
    h.client.cancelTransfer("http-transfer", 25)
    expect(h.client.bulkRetainedBytes).toBe(0)
  }
})

test("HTTP reservation refusal closes without copying data or refunding another owner's charge", () => {
  const h = httpFixture()
  h.bind()
  const outside = h.relay.reservation.limit - h.relay.reservation.used
  expect(h.relay.reservation.reserve(outside)).toBe(true)
  expect(h.relay.handoffHttpPiece(h.piece(), 25).decisions).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.LIMIT }),
  )
  expect(h.relay.httpHandedBytes).toBe(0)
  expect(h.relay.reservation.used).toBe(outside)
  h.relay.reservation.release(outside)
})

test("an HTTP body cannot settle successfully before the reader verifies exact EOF", () => {
  const h = httpFixture(1)
  h.bind()
  h.relay.handoffHttpPiece(h.piece(0, 1), 25)
  expect(h.client.receiveHttpPiece("http-transfer", Uint8Array.of(137), 25)).toEqual([])
  const frame = create(FrameSchema, {
    revision: 5,
    connectionEpoch: h.client.connectionEpoch,
    ledger: LedgerClass.NORMAL,
    deliveryOrdinal: h.client.ledger(LedgerClass.NORMAL).receivedOrdinal + 1n,
    body: {
      case: "bulkEnd",
      value: create(BulkEndSchema, {
        transferId: "http-transfer",
        byteCount: 1n,
        outcome: { case: "success", value: {} },
      }),
    },
  })
  const bytes = encodeStrict(FrameSchema, frame)
  const rejected = h.client.acceptIncoming(h.client.admitIncoming(bytes.length)!, frame, 25)
  expect(rejected.some((entry) => entry.type === "settled" && entry.status === "success")).toBe(false)
  expect(rejected).toContainEqual(expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }))
  expect(h.client.bulkRetainedBytes).toBe(0)
})
