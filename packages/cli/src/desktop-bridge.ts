import { Service, type Endpoint } from "@ycoding-ai/client/effect/service"
import { decodeStrict, FrameSchema, WireLimit } from "@ycoding-ai/protocol/v5"
import { frame, FrameReader } from "@ycoding-ai/protocol/v5/framing"
import { once } from "node:events"
import type { Readable, Writable } from "node:stream"
import { WebSocket } from "ws"

export async function bridgeDesktop(endpoint: Endpoint, input: Readable, output: Writable, signal: AbortSignal) {
  const url = new URL("/ws/v5/local", endpoint.url)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid desktop bridge endpoint")
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const socket = new WebSocket(url, { headers: Service.headers(endpoint), maxPayload: WireLimit.SERVER_FRAME_BYTES })
  const stopped = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const failures: unknown[] = []
  let eof = false
  let closing = false
  let pendingWrites = 0
  const fail = (cause: unknown) => {
    if (closing) return
    failures.push(cause)
    socket.terminate()
    stopped.resolve()
  }
  const abort = () => fail(new Error("Desktop bridge cancelled"))
  const drain = () => socket.resume()
  const error = (cause: Error) => fail(cause)
  const close = () => {
    closed.resolve()
    stopped.resolve()
  }
  const message = (bytes: import("ws").RawData, binary: boolean) => {
    try {
      if (!binary || Array.isArray(bytes)) throw new Error("Invalid desktop bridge frame")
      const payload = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
      if (payload.byteLength > WireLimit.SERVER_FRAME_BYTES) throw new Error("Desktop bridge server frame limit")
      decodeStrict(FrameSchema, payload)
      const encoded = frame(payload, WireLimit.SERVER_FRAME_BYTES)
      if (output.writableLength + encoded.length > WireLimit.NORMAL_QUEUE_BYTES + WireLimit.SERVER_FRAME_BYTES)
        throw new Error("Desktop bridge output queue limit")
      pendingWrites += 1
      if (
        !output.write(encoded, (cause) => {
          if (closing) return
          pendingWrites -= 1
          if (cause) fail(cause)
        })
      )
        socket.pause()
    } catch (cause) {
      fail(cause)
    }
  }
  socket.on("message", message)
  socket.on("error", error)
  socket.on("close", close)
  output.on("error", error)
  output.on("drain", drain)
  signal.addEventListener("abort", abort, { once: true })
  let reader: Promise<void> | undefined
  try {
    if (signal.aborted) throw new Error("Desktop bridge cancelled")
    await Promise.race([
      once(socket, "open"),
      stopped.promise.then(() => {
        throw new Error("Desktop bridge did not connect")
      }),
    ])
    reader = (async () => {
      for await (const payload of desktopFrames(input)) {
        decodeStrict(FrameSchema, payload)
        await new Promise<void>((resolve, reject) =>
          socket.send(payload, { binary: true }, (cause) => (cause ? reject(cause) : resolve())),
        )
      }
      eof = true
      socket.terminate()
    })().catch(fail)
    await stopped.promise
    if (!eof && !signal.aborted && failures.length === 0) failures.push(new Error("Desktop bridge connection closed"))
  } catch (cause) {
    failures.push(cause)
  } finally {
    closing = true
    if (pendingWrites > 0 && failures.length === 0) failures.push(new Error("Desktop bridge output incomplete"))
    pendingWrites = 0
    socket.terminate()
    input.destroy()
    try {
      if (reader) await reader
    } catch (cause) {
      failures.push(cause)
    }
    try {
      await closed.promise
    } catch (cause) {
      failures.push(cause)
    }
    socket.off("message", message)
    socket.off("error", error)
    socket.off("close", close)
    output.off("error", error)
    output.off("drain", drain)
    signal.removeEventListener("abort", abort)
  }
  if (failures.length) throw new AggregateError(failures, "Desktop bridge transport failed")
}

export async function* desktopFrames(input: AsyncIterable<Uint8Array>) {
  const reader = new FrameReader(WireLimit.CLIENT_FRAME_BYTES)
  for await (const chunk of input) {
    yield* reader.read(chunk)
  }
  reader.finish()
}
