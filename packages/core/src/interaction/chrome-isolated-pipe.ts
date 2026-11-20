import type { Readable, Writable } from "node:stream"

const maxFrame = 8 * 1024 * 1024

export function cdpObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

export function connectChromePipe(readable: Readable, writable: Writable) {
  const waiting = new Map<number, (error: Error | undefined, result?: Record<string, unknown>) => void>()
  const subscribers = new Set<(event: Record<string, unknown>) => void>()
  const ended = new AbortController()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let id = 0
  let pieces: Buffer[] = []
  let size = 0

  function close() {
    if (ended.signal.aborted) return
    ended.abort()
    for (const settle of waiting.values()) settle(new Error("Chrome pipe closed"))
    subscribers.clear()
    pieces = []
    size = 0
  }

  readable.on("data", (buffer: Buffer) => {
    if (ended.signal.aborted) return
    for (let cursor = 0; cursor < buffer.length;) {
      const next = buffer.indexOf(0, cursor)
      const piece = buffer.subarray(cursor, next < 0 ? buffer.length : next)
      size += piece.length
      if (size > maxFrame) { close(); return }
      if (piece.length > 0) pieces.push(piece)
      if (next < 0) return
      if (size === 0) { close(); return }
      try {
        const value = cdpObject(JSON.parse(decoder.decode(Buffer.concat(pieces, size))))
        if (typeof value.id === "number") waiting.get(value.id)?.(
          value.error === undefined ? undefined : new Error("Chrome command failed"), cdpObject(value.result),
        )
        else if (typeof value.method === "string") for (const notify of subscribers) notify(value)
        else { close(); return }
      } catch {
        close()
        return
      }
      pieces = []
      size = 0
      cursor = next + 1
    }
  })
  readable.once("close", close)
  readable.once("end", close)
  readable.once("error", close)
  writable.once("close", close)
  writable.once("error", close)

  return {
    signal: ended.signal,
    onEvent(notify: (event: Record<string, unknown>) => void) {
      subscribers.add(notify)
      return () => subscribers.delete(notify)
    },
    command(method: string, params: Record<string, unknown>, signal: AbortSignal, sessionId?: string) {
      if (waiting.size >= 64 || ended.signal.aborted || signal.aborted) return Promise.reject(new Error("Chrome pipe unavailable"))
      const request = ++id
      const message = `${JSON.stringify({ id: request, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`
      if (Buffer.byteLength(message) > maxFrame || writable.writableLength > maxFrame) return Promise.reject(new Error("Chrome pipe limit"))
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const settle = (error: Error | undefined, value?: Record<string, unknown>) => {
          waiting.delete(request)
          signal.removeEventListener("abort", abort)
          if (error) reject(error)
          else resolve(value ?? {})
        }
        const abort = () => settle(new Error("Chrome command interrupted"))
        waiting.set(request, settle)
        signal.addEventListener("abort", abort, { once: true })
        writable.write(message, (error) => { if (error) settle(error) })
      })
    },
    close,
  }
}
