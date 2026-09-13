import { Buffer } from "node:buffer"
import type { Readable, Writable } from "node:stream"

export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024

export interface Event {
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>>
  readonly sessionId?: string
}

type Pending = {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort?: () => void
}

export interface Client {
  readonly send: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
    signal?: AbortSignal,
  ) => Promise<unknown>
  readonly subscribe: (listener: (event: Event) => void) => () => void
  readonly closed: Promise<void>
  readonly close: () => void
}

export function connect(readable: Readable, writable: Writable, commandTimeoutMs = 5_000): Client {
  const listeners = new Set<(event: Event) => void>()
  const pending = new Map<number, Pending>()
  let sequence = 0
  let buffer = Buffer.alloc(0)
  let settled = false
  let resolveClosed = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const fail = (message: string) => {
    if (settled) return
    settled = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      if (entry.abort) entry.abort()
      entry.reject(new Error(message))
    }
    pending.clear()
    resolveClosed()
  }

  const onData = (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk])
    if (buffer.byteLength > MAX_MESSAGE_BYTES && !buffer.includes(0)) {
      fail("Chrome control message exceeded the configured limit")
      return
    }
    while (true) {
      const boundary = buffer.indexOf(0)
      if (boundary < 0) return
      const frame = buffer.subarray(0, boundary)
      buffer = buffer.subarray(boundary + 1)
      if (frame.byteLength === 0) continue
      if (frame.byteLength > MAX_MESSAGE_BYTES) {
        fail("Chrome control message exceeded the configured limit")
        return
      }
      const message = parseMessage(frame)
      if (!message) {
        fail("Chrome returned an invalid control message")
        return
      }
      if ("id" in message) {
        const entry = pending.get(message.id)
        if (!entry) continue
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if (entry.abort) entry.abort()
        if (message.error) {
          entry.reject(new Error(`${entry.method}: Chrome rejected the command`))
          continue
        }
        entry.resolve(message.result)
        continue
      }
      for (const listener of listeners) listener(message)
    }
  }
  const onError = () => fail("Chrome control pipe failed")
  const onClose = () => fail("Chrome control pipe closed")
  readable.on("data", onData)
  readable.on("error", onError)
  readable.on("close", onClose)
  writable.on("error", onError)
  writable.on("close", onClose)

  return {
    closed,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send: (method, params = {}, sessionId, signal) => {
      if (settled) return Promise.reject(new Error("Chrome control pipe is closed"))
      if (signal?.aborted) return Promise.reject(abortError())
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          const entry = pending.get(id)
          if (!entry) return
          pending.delete(id)
          if (entry.abort) entry.abort()
          reject(new Error(`Chrome command timed out: ${method}`))
        }, commandTimeoutMs)
        timer.unref()
        const onAbort = () => {
          const entry = pending.get(id)
          if (!entry) return
          pending.delete(id)
          clearTimeout(entry.timer)
          signal?.removeEventListener("abort", onAbort)
          reject(abortError())
        }
        if (signal) signal.addEventListener("abort", onAbort, { once: true })
        pending.set(id, {
          method,
          resolve,
          reject,
          timer,
          abort: signal ? () => signal.removeEventListener("abort", onAbort) : undefined,
        })
        const frame = `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`
        writable.write(frame, (error) => {
          if (!error) return
          const entry = pending.get(id)
          if (!entry) return
          pending.delete(id)
          clearTimeout(entry.timer)
          if (entry.abort) entry.abort()
          reject(new Error("Chrome control pipe write failed"))
        })
      })
    },
    close: () => {
      readable.off("data", onData)
      readable.off("error", onError)
      readable.off("close", onClose)
      writable.off("error", onError)
      writable.off("close", onClose)
      writable.end()
      fail("Chrome control pipe closed")
    },
  }
}

function parseMessage(frame: Buffer): ({ readonly id: number; readonly result?: unknown; readonly error?: unknown } | Event) | undefined {
  try {
    const value: unknown = JSON.parse(frame.toString("utf8"))
    if (!isRecord(value)) return undefined
    if (typeof value.id === "number") return { id: value.id, result: value.result, error: value.error }
    if (typeof value.method !== "string") return undefined
    return {
      method: value.method,
      params: isRecord(value.params) ? value.params : undefined,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    }
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
}

function abortError() {
  return new DOMException("The Chrome command was canceled", "AbortError")
}
