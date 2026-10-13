import { expect, test } from "bun:test"
import { httpFixture } from "../../protocol/test/http-fixtures"
import { readHttpBulk, httpBulkQuery, takeAsset, ReservationBudget, create, BulkEndSchema } from "../src/index"

function headers(h: ReturnType<typeof httpFixture>) {
  return new Headers({
    "content-type": "image/png",
    "content-length": String(h.declaration.start.byteCount),
    "x-ycoding-connection-epoch": h.client.connectionEpoch,
    "x-ycoding-transfer-id": h.declaration.start.transferId,
  })
}

test.each([0, 65536, 65537])(
  "the browser reader folds native fragments into virtual pieces and confirms EOF for a %s-byte asset",
  async (length) => {
    const h = httpFixture(length)
    let now = 0
    let offset = 0
    let ended = false
    let bodyEnded = false
    let controller!: ReadableStreamDefaultController<Uint8Array>
    function pump() {
      if (ended) return
      while (offset < length) {
        const piece = h.piece(Math.floor(offset / 65536), Math.min(65536, length - offset))
        if (!h.relay.handoffHttpPiece(piece, now).accepted) break
        offset += piece.data.length
        controller.enqueue(piece.data.subarray(0, 1))
        if (piece.data.length > 1) controller.enqueue(piece.data.subarray(1))
      }
      if (offset === length && !bodyEnded) {
        bodyEnded = true
        controller.close()
      }
      if (!bodyEnded || !h.relay.httpBulkConsumed("http-transfer")) return
      ended = true
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
      )
      h.flush(h.relay, h.client, now)
    }
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    await expect(
      readHttpBulk(h.client, h.declaration, new Response(body, { headers: headers(h) }), {
        now: () => now,
        apply() {
          now += 25
          h.flush(h.client, h.relay, now)
          h.flush(h.relay, h.client, now)
          pump()
        },
      }),
    ).resolves.toEqual({ transferID: "http-transfer", bytes: BigInt(length) })
    const complete = h.decisions.find((entry) => entry.type === "bulkComplete")!
    if (complete.type !== "bulkComplete" || !complete.metadata) throw new Error("Missing canonical HTTP success")
    const owner = new ReservationBudget(2 * 1024 * 1024)
    const asset = takeAsset(h.client, complete, owner)!
    expect(asset.data).toEqual(new Uint8Array(length).fill(137))
    expect(h.relay.httpHandedBytes).toBe(0)
    asset.release()
    expect(owner.used).toBe(0)
  },
)

test.each(["length", "epoch", "transfer", "mime", "status", "encoding"])(
  "the browser reader rejects a mismatched HTTP %s before admitting bytes",
  async (kind) => {
    const h = httpFixture()
    const declared = headers(h)
    if (kind === "length") declared.set("content-length", "65536")
    if (kind === "epoch") declared.set("x-ycoding-connection-epoch", "another-connection")
    if (kind === "transfer") declared.set("x-ycoding-transfer-id", "another-transfer")
    if (kind === "mime") declared.set("content-type", "text/plain")
    if (kind === "encoding") declared.set("content-encoding", "gzip")
    let now = 0
    await expect(
      readHttpBulk(
        h.client,
        h.declaration,
        new Response(new Uint8Array(), { headers: declared, status: kind === "status" ? 403 : 200 }),
        {
          now: () => now,
          apply() {
            now += 25
            h.flush(h.client, h.relay, now)
            h.flush(h.relay, h.client, now)
          },
        },
      ),
    ).rejects.toThrow("declaration mismatch")
    expect(h.client.bulkRetainedBytes).toBe(0)
    expect(h.client.assetMetadataRetainedBytes).toBe(0)
    expect(h.decisions.some((entry) => entry.type === "settled" && entry.status === "success")).toBe(false)
  },
)

test.each([65536, 65538])("a body with %s bytes cannot settle an announced 65537-byte asset", async (length) => {
  const h = httpFixture()
  let now = 0
  let handed = false
  await expect(
    readHttpBulk(h.client, h.declaration, new Response(new Uint8Array(length).fill(137), { headers: headers(h) }), {
      now: () => now,
      apply() {
        now += 25
        h.flush(h.client, h.relay, now)
        h.flush(h.relay, h.client, now)
        if (!handed && length === 65536) {
          handed = true
          h.relay.handoffHttpPiece(h.piece(), now)
        }
      },
    }),
  ).rejects.toThrow(length === 65536 ? "incomplete" : "exceeds declared length")
  expect(h.client.bulkRetainedBytes).toBe(0)
  expect(h.decisions.some((entry) => entry.type === "settled" && entry.status === "success")).toBe(false)
})

test("abort interrupts a pending native read, cancels the owning transfer and releases its buffer", async () => {
  const h = httpFixture()
  const entered = Promise.withResolvers<void>()
  const abort = new AbortController()
  let cancelled = false
  let now = 0
  const body = new ReadableStream<Uint8Array>({
    pull() {
      entered.resolve()
    },
    cancel() {
      cancelled = true
    },
  })
  const reading = readHttpBulk(h.client, h.declaration, new Response(body, { headers: headers(h) }), {
    now: () => now,
    signal: abort.signal,
    apply() {
      now += 25
      h.flush(h.client, h.relay, now)
      h.flush(h.relay, h.client, now)
    },
  })
  await entered.promise
  abort.abort(new Error("reader aborted"))
  await expect(reading).rejects.toThrow("reader aborted")
  expect(cancelled).toBe(true)
  expect(h.client.bulkRetainedBytes).toBe(0)
  expect(h.relay.httpHandedBytes).toBe(0)
})

test("HTTP selectors identify the current connection, its admitted request and its declared transfer", () => {
  const h = httpFixture()
  expect(Object.fromEntries(httpBulkQuery(h.client, h.declaration))).toEqual({
    connectionEpoch: "http-epoch",
    requestID: h.declaration.start.requestId,
    transferID: "http-transfer",
  })
})
