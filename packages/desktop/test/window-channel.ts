import { PassThrough, Writable } from "node:stream"

export type Sink = {
  write(chunk: Uint8Array): Promise<void>
  flush(): Promise<void>
  end(): Promise<void>
}
export type AppChannel = {
  readonly stdin: Sink
  readonly stdout: AsyncIterable<Uint8Array>
  readonly exited: Promise<number>
  readonly kill: () => void
}
export type Failure =
  | "line-limit"
  | "request-shape"
  | "response-shape"
  | "credential"
  | "write"
  | "app-unresponsive"
  | "stdout-held"
  | "startup"
  | "resource-identity"
export type Wait = (ms: number) => Promise<void>
export type Timing = {
  readonly startMs: number
  readonly graceMs: number
  readonly killMs: number
  readonly pumpMs: number
  readonly writeMs: number
}
export type ChannelOptions = {
  readonly secrets?: readonly string[]
  readonly resources: string
  readonly wait?: Wait
  readonly timing?: Partial<Timing>
  readonly limit?: number
}

const lineLimit = 8 * 1024 * 1024
const credentialKeys = new Set(["auth", "password", "authorization"])
const responseTypes = new Set(["state", "event", "reply"])
const timedOut = Symbol("timed out")
const defaultWait: Wait = (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() })

function join(parts: readonly Uint8Array[], size: number) {
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return bytes
}

function withNewline(line: Uint8Array) {
  const bytes = new Uint8Array(line.length + 1)
  bytes.set(line)
  bytes[line.length] = 10
  return bytes
}

function framer(limit: number) {
  let partial: Uint8Array[] = []
  let size = 0
  return {
    push(chunk: Uint8Array) {
      const lines: Uint8Array[] = []
      let start = 0
      for (;;) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        size += end - start
        if (size > limit) return { lines, overLimit: true }
        partial.push(chunk.slice(start, end))
        if (newline < 0) return { lines, overLimit: false }
        lines.push(join(partial, size))
        partial = []
        size = 0
        start = newline + 1
      }
    },
    pending: () => size > 0,
  }
}

function scan(value: unknown, depth: number): "ok" | "credential" | "deep" {
  if (typeof value !== "object" || value === null) return "ok"
  if (depth > 64) return "deep"
  for (const [key, item] of Object.entries(value)) {
    if (credentialKeys.has(key.toLowerCase())) return "credential"
    const found = scan(item, depth + 1)
    if (found !== "ok") return found
  }
  return "ok"
}

function decode(line: Uint8Array) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(line) } catch { return undefined }
}

function parse(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

type Accepted = { readonly failure?: Failure; readonly forward?: boolean; readonly closed?: boolean }

export function windowChannel(app: AppChannel, options: ChannelOptions) {
  const limit = options.limit ?? lineLimit
  const secrets = (options.secrets ?? []).filter((secret) => secret.length > 0)
  const wait = options.wait ?? defaultWait
  const timing: Timing = { startMs: 30_000, graceMs: 20_000, killMs: 5_000, pumpMs: 2_000, writeMs: 10_000, ...options.timing }
  const input = new PassThrough({ highWaterMark: 65_536 })
  const operations = new Map<string, number>()
  const waiters = new Set<() => void>()
  const callbacks = new Set<(error?: Error) => void>()
  const settled = Promise.withResolvers<void>()
  const opening = Promise.withResolvers<void>()
  let state: "open" | "closing" | "closed" = "open"
  let failure: Failure | undefined
  let appExit: number | undefined
  let killed = false
  let openSeen = false
  let closedSeen = false
  let stdinEnding: Promise<void> | undefined
  let reaping: Promise<void> | undefined
  let closing: Promise<void> | undefined

  const first = async (promise: Promise<unknown>, ms: number) => (await Promise.race([promise, wait(ms).then(() => timedOut)])) !== timedOut
  const fail = (category: Failure) => { failure ??= category; queueMicrotask(() => { void close() }) }
  const drained = () => new Promise<void>((resolve) => {
    const done = () => { waiters.delete(done); input.off("drain", done); resolve() }
    waiters.add(done)
    input.once("drain", done)
  })
  const endApp = () => stdinEnding ??= Promise.resolve().then(() => app.stdin.end()).catch(() => { failure ??= "write" })
  const ended = async () => { if (!await first(endApp(), timing.writeMs)) failure ??= "write" }

  const exit = app.exited.then((code) => code, () => -1)
  const reap = () => reaping ??= (async () => {
    await ended()
    if (!await first(exit, timing.graceMs)) {
      killed = true
      failure ??= "app-unresponsive"
      try { app.kill() } catch { failure ??= "app-unresponsive" }
      await first(exit, timing.killMs)
    }
  })()

  const markerState = (value: object) => {
    if (!("type" in value) || value.type !== "desktop.channel" || !("state" in value)) return undefined
    const keys = Object.keys(value).sort().join()
    if (value.state === "open" && keys === "resources,state,type" && "resources" in value && typeof value.resources === "string") return { state: "open" as const, resources: value.resources }
    if (value.state === "closed" && keys === "state,type") return { state: "closed" as const }
    return undefined
  }

  const accept = (line: Uint8Array): Accepted => {
    const text = decode(line)
    const value = text === undefined ? undefined : parse(text)
    const isObject = typeof value === "object" && value !== null && !Array.isArray(value)
    const marker = isObject ? markerState(value) : undefined
    if (!openSeen) {
      if (marker?.state !== "open") return { failure: "startup" }
      if (marker.resources !== options.resources) return { failure: "resource-identity" }
      openSeen = true
      opening.resolve()
      return {}
    }
    if (!isObject) return { failure: "request-shape" }
    if ("type" in value && value.type === "desktop.channel") {
      if (marker?.state !== "closed" || closedSeen) return { failure: "request-shape" }
      closedSeen = true
      return { closed: true }
    }
    if (closedSeen) return { failure: "request-shape" }
    if (!Object.keys(value).every((key) => key === "id" || key === "operation" || key === "input")) return { failure: "request-shape" }
    if (!("id" in value) || !("operation" in value) || !Number.isSafeInteger(value.id) || typeof value.operation !== "string" || value.operation.length > 64) return { failure: "request-shape" }
    operations.set(value.operation, (operations.get(value.operation) ?? 0) + 1)
    return { forward: true }
  }

  const response = (line: Uint8Array): Failure | undefined => {
    const text = decode(line)
    if (text === undefined) return "response-shape"
    if (secrets.some((secret) => text.includes(secret))) return "credential"
    const value = parse(text)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "response-shape"
    if (!("type" in value) || typeof value.type !== "string" || !responseTypes.has(value.type)) return "response-shape"
    const found = scan(value, 0)
    return found === "credential" ? "credential" : found === "deep" ? "response-shape" : undefined
  }

  const pumping = (async () => {
    const frames = framer(limit)
    try {
      for await (const chunk of app.stdout) {
        if (state !== "open" || closedSeen) continue
        const { lines, overLimit } = frames.push(chunk)
        for (const line of lines) {
          if (state !== "open") break
          const accepted = accept(line)
          if (accepted.failure) { fail(accepted.failure); break }
          if (accepted.closed) {
            input.end()
            void reap()
            break
          }
          if (accepted.forward && !input.write(withNewline(line))) await drained()
        }
        if (overLimit && state === "open" && !closedSeen) fail("line-limit")
      }
      if (frames.pending() && state === "open" && !closedSeen) fail("request-shape")
    } catch {
      fail("stdout-held")
    } finally {
      input.end()
    }
  })()

  const answers = framer(limit)
  const output = new Writable({
    highWaterMark: 65_536,
    write(chunk, _encoding, callback) {
      if (state !== "open" || stdinEnding) { callback(new Error("Window channel is closed.")); return }
      let done = false
      const settle = (error?: Error) => {
        if (done) return
        done = true
        callbacks.delete(settle)
        callback(error)
      }
      callbacks.add(settle)
      const { lines, overLimit } = answers.push(chunk)
      const deliver = async () => {
        for (const line of lines) {
          const bad = response(line)
          if (bad) { fail(bad); throw new Error("Refused response.") }
          const writing = (async () => {
            await app.stdin.write(withNewline(line))
            await app.stdin.flush()
          })()
          writing.catch(() => undefined)
          try {
            if (!await first(writing, timing.writeMs)) throw new Error("Window channel write timed out.")
          } catch {
            fail("write")
            throw new Error("Refused response.")
          }
        }
        if (overLimit) { fail("line-limit"); throw new Error("Refused response.") }
      }
      deliver().then(() => settle(), () => settle(new Error("Window channel refused the response.")))
    },
    final(callback) {
      if (answers.pending()) failure ??= "response-shape"
      ended().then(() => callback(), () => callback())
    },
  })
  output.on("error", () => undefined)

  void first(opening.promise, timing.startMs).then((done) => { if (!done && !openSeen && state === "open") fail("startup") })

  const close = () => closing ??= (async () => {
    if (state === "open") state = "closing"
    for (const release of [...waiters]) release()
    for (const settle of [...callbacks]) settle(new Error("Window channel is closed."))
    input.end()
    output.destroy()
    await reap()
    if (!await first(pumping, timing.pumpMs)) failure ??= "stdout-held"
    state = "closed"
    settled.resolve()
  })()

  void exit.then((code) => {
    appExit = code
    if (state === "open" && !openSeen) failure ??= "startup"
    void close()
  })

  const finish = async () => {
    if (output.destroyed || output.writableFinished) return close()
    await new Promise<void>((resolve) => {
      output.once("close", () => resolve())
      output.end(() => resolve())
    })
    return close()
  }

  return {
    input,
    output,
    close,
    finish,
    settled: settled.promise,
    result: () => ({ operations: Object.fromEntries(operations), prompts: operations.get("prompt") ?? 0, failure, appExit, killed }),
  }
}
