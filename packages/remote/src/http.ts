import type { Connection, Decision } from "@ycoding-ai/protocol/v5/connection"
import { ContentKind, decodeLossless } from "@ycoding-ai/protocol/v5"

export function httpBulkQuery(connection: Connection, declaration: Extract<Decision, { type: "httpBulkStart" }>) {
  return new URLSearchParams({
    connectionEpoch: connection.connectionEpoch,
    requestID: declaration.start.requestId,
    transferID: declaration.start.transferId,
  })
}

export async function readHttpBulk(
  connection: Connection,
  declaration: Extract<Decision, { type: "httpBulkStart" }>,
  response: Response,
  options: { now: () => number; apply: (decisions: Decision[]) => void; signal?: AbortSignal },
) {
  const start = declaration.start
  const reader = response.body?.getReader()
  const capacity = Math.min(65536, Number(start.byteCount))
  let reserved = false
  try {
    const mime =
      start.contentKind === ContentKind.ASSET ? decodeLossless(declaration.metadata!.mime!) : "application/x-protobuf"
    if (
      response.status !== 200 ||
      response.headers.get("content-length") !== String(start.byteCount) ||
      response.headers.get("x-ycoding-connection-epoch") !== connection.connectionEpoch ||
      response.headers.get("x-ycoding-transfer-id") !== start.transferId ||
      response.headers.get("content-type") !== mime ||
      (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity") ||
      (!reader && start.byteCount !== 0n)
    )
      throw new Error("HTTP bulk declaration mismatch")
    options.signal?.throwIfAborted()
    if (!connection.reservation.reserve(capacity)) throw new Error("HTTP reader reservation exceeded")
    reserved = true
    const piece = new Uint8Array(capacity)
    let used = 0
    let received = 0n
    options.apply(connection.beginHttpBody(start.transferId, connection.connectionEpoch, options.now()))
    requireLiveConnection(connection)
    while (reader) {
      options.signal?.throwIfAborted()
      const chunk = await nextChunk(reader, options.signal)
      if (chunk.done) break
      if (received + BigInt(chunk.value.length) > start.byteCount)
        throw new Error("HTTP bulk body exceeds declared length")
      received += BigInt(chunk.value.length)
      let offset = 0
      while (offset < chunk.value.length) {
        const count = Math.min(piece.length - used, chunk.value.length - offset)
        piece.set(chunk.value.subarray(offset, offset + count), used)
        used += count
        offset += count
        if (used !== piece.length) continue
        options.apply(connection.receiveHttpPiece(start.transferId, piece, options.now()))
        requireLiveConnection(connection)
        used = 0
      }
    }
    if (received !== start.byteCount) throw new Error("HTTP bulk body is incomplete")
    if (used) {
      options.apply(connection.receiveHttpPiece(start.transferId, piece.subarray(0, used), options.now()))
      requireLiveConnection(connection)
    }
    options.apply(connection.completeHttpBody(start.transferId, options.now()))
    requireLiveConnection(connection)
    return { transferID: start.transferId, bytes: received }
  } catch (cause) {
    options.apply(connection.cancelTransfer(start.transferId, options.now()))
    if (reader) {
      const cancelled = await Promise.allSettled([reader.cancel(cause)])
      if (cancelled[0].status === "rejected")
        throw new AggregateError([cause, cancelled[0].reason], "HTTP bulk read and cancellation failed")
    }
    throw cause
  } finally {
    if (reserved) connection.reservation.release(capacity)
    reader?.releaseLock()
  }
}

function requireLiveConnection(connection: Connection) {
  if (connection.state === "closed") throw new Error("HTTP owning connection closed")
}

async function nextChunk(reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">, signal?: AbortSignal) {
  if (!signal) return reader.read()
  signal.throwIfAborted()
  return new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}
