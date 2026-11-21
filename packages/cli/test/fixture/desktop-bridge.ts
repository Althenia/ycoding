import { mock } from "bun:test"
import { once } from "node:events"
import { PassThrough, Readable, Writable } from "node:stream"
import { Effect, Option } from "effect"
import { Connection } from "@ycoding-ai/protocol/v5/connection"
import {
  PeerRole,
  operations,
  PublicEventSchema,
  SessionLogItemSchema,
  create,
  encodeLossless,
  encodeStrict,
  FrameSchema,
  decodeStrict,
  session_get_RequestSchema,
} from "@ycoding-ai/protocol/v5"
import { frame, FrameReader } from "@ycoding-ai/protocol/v5/framing"
import { WebSocketServer } from "ws"
import { NodeServices } from "@effect/platform-node"
import type { main } from "../../src/main"

const mode = process.argv[2]
const endpoint = {
  url: "http://127.0.0.1:42617",
  auth: { type: "basic" as const, username: "ycoding", password: "synthetic-bridge-secret" },
}
const calls: unknown[] = []
let reads = 0
if (mode.includes("admission-")) {
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: [PublicEventSchema.typeName, SessionLogItemSchema.typeName],
    now: 0,
  })
  client.start(0)
  const hello = client.prepareHandoff(0)
  const operation = operations.find((operation) => operation.diagnosticName === "session.get")
  if (!hello || !operation) throw new Error("Missing synthetic protocol input")
  const request = create(FrameSchema, {
    revision: hello.frame.revision,
    connectionEpoch: "synthetic-connection",
    body: {
      case: "request",
      value: {
        requestId: "1",
        operationId: operation.operationId,
        scope: { target: { case: "session", value: "ses_synthetic_foreign" } },
        payload: encodeStrict(
          session_get_RequestSchema,
          create(session_get_RequestSchema, {
            params: { sessionID: encodeLossless("ses_synthetic_foreign") },
          }),
        ),
      },
    },
  })
  const input = Readable.from([
    frame(encodeStrict(FrameSchema, hello.frame)),
    frame(encodeStrict(FrameSchema, request)),
  ])
  const read = input.read.bind(input)
  input.read = (size?: number) => {
    reads++
    return read(size)
  }
  Object.defineProperty(process, "stdin", { value: input })
}
if (mode.startsWith("entry-")) {
  let execution: Promise<void> | undefined
  let ok = true
  let failure: string | undefined
  let attempts = 0
  if (mode.startsWith("entry-admission-")) {
    await mock.module("../../src/services/server-connection", () => ({
      ServerConnection: {
        resolve: (input: unknown) =>
          Effect.sync(() => {
            calls.push(input)
            return { endpoint }
          }),
      },
    }))
    await mock.module("../../src/desktop-bridge", () => ({
      bridgeDesktop: async () => {
        attempts++
      },
    }))
  } else
    await mock.module("../../src/commands/handlers/desktop-bridge", () => ({
      default: (input: unknown) =>
        Effect.sync(() => {
          calls.push(input)
        }),
    }))
  await mock.module("../../src/main", () => ({
    main: (program: Parameters<typeof main>[0]) => {
      execution = Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer), Effect.scoped)).catch(
        (cause: unknown) => {
          ok = false
          failure = cause instanceof Error ? cause.message : typeof cause
        },
      )
    },
  }))
  process.argv = [process.execPath, "synthetic-entry.ts", "desktop-bridge", "--stdio"]
  if (mode.endsWith("-node")) await import("../../src/node/index")
  else if (mode.endsWith("-tui")) await import("../../src/tui")
  else await import("../../src/index")
  if (!execution) throw new Error("Product entry did not dispatch its CLI program")
  await execution
  console.log(JSON.stringify({ ok, calls, attempts, failure, reads }))
} else if (["managed", "external", "private", "no-stdio"].includes(mode) || mode.startsWith("admission-")) {
  let attempts = 0
  await mock.module("../../src/services/server-connection", () => ({
    ServerConnection: {
      resolve: (input: unknown) =>
        Effect.sync(() => {
          calls.push(input)
          return { endpoint }
        }),
    },
  }))
  await mock.module("../../src/desktop-bridge", () => ({
    bridgeDesktop: async () => {
      attempts++
    },
  }))
  const { default: handler } = await import("../../src/commands/handlers/desktop-bridge")
  try {
    const claimed =
      mode === "admission-cleared"
        ? { caller: undefined, approved: undefined }
        : mode === "admission-malformed"
          ? { caller: "unverified" }
          : mode === "admission-native-task"
            ? {
                caller: {
                  kind: "native",
                  sessionID: "ses_synthetic_restricted",
                  permissionCeiling: [{ action: "subagent:*", resource: "*", effect: "deny" }],
                  permissions: "manual",
                },
              }
            : mode === "admission-claimed-human"
              ? { caller: { kind: "human" }, approved: true }
              : mode === "admission-claimed-app"
                ? { caller: { kind: "app" }, approved: true }
                : {}
    const input = Object.assign(
      {
        stdio: mode !== "no-stdio",
        standalone: mode === "private",
        server: mode === "external" ? Option.some(endpoint.url) : Option.none(),
      },
      claimed,
    )
    await Effect.runPromise(handler(input).pipe(Effect.scoped))
    console.log(JSON.stringify({ ok: true, calls, attempts, reads }))
  } catch (cause) {
    console.log(
      JSON.stringify({
        ok: false,
        calls,
        attempts,
        reads,
        failure: cause instanceof Error ? cause.message : typeof cause,
      }),
    )
  }
} else {
  const server = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    eventTypes: [PublicEventSchema.typeName, SessionLogItemSchema.typeName],
    now: 0,
    epoch: "synthetic-connection",
    sourceEpoch: "synthetic-source",
  })
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: [PublicEventSchema.typeName, SessionLogItemSchema.typeName],
    now: 0,
  })
  client.start(0)
  const hello = client.prepareHandoff(0)
  if (!hello) throw new Error("Missing protocol hello")
  const bytes = encodeStrict(FrameSchema, hello.frame)
  const incoming: Uint8Array[] = []
  const outgoing: Uint8Array[] = []
  let expected: Uint8Array | undefined
  let backpressuredWrites = 0
  let drains = 0
  let privateAuth = false
  let attempts = 0
  const sockets = new Set<import("ws").NodeWebSocket>()
  const listener = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (info, accept) => {
      attempts++
      privateAuth =
        info.req.headers.authorization === `Basic ${Buffer.from("ycoding:synthetic-bridge-secret").toString("base64")}`
      accept(mode !== "connect-error")
    },
  })
  await once(listener, "listening")
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Synthetic websocket listener has no address")
  listener.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("message", (data) => {
      const payload = new Uint8Array(data)
      incoming.push(payload)
      const reservation = server.admitIncoming(payload.length)
      if (!reservation) throw new Error("Protocol fixture rejected admission")
      server.acceptIncoming(reservation, decodeStrict(FrameSchema, payload), 0)
      const next = server.prepareHandoff(0)
      if (!next) throw new Error("Protocol fixture did not reply")
      expected = encodeStrict(FrameSchema, next.frame)
      server.handoff(next, expected.length, 0)
      socket.send(mode === "text" ? "invalid-text" : Buffer.from(mode === "malformed" ? [255] : expected))
    })
  })
  const { bridgeDesktop } = await import("../../src/desktop-bridge")
  const input = new PassThrough()
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Uint8Array, _encoding, callback) {
      outgoing.push(new Uint8Array(chunk))
      if (output.writableLength >= output.writableHighWaterMark) backpressuredWrites++
      queueMicrotask(() => {
        callback()
        input.end()
      })
    },
  })
  output.on("drain", () => {
    drains++
  })
  const controller = new AbortController()
  const operation = bridgeDesktop(
    { ...endpoint, url: `http://127.0.0.1:${address.port}` },
    input,
    output,
    controller.signal,
  )
  input.write(frame(bytes))
  let ok = true
  let failure: string | undefined
  try {
    await operation
  } catch (cause) {
    ok = false
    failure = (
      cause instanceof AggregateError
        ? cause.errors.map((error: unknown) => (error instanceof Error ? error.message : typeof error)).join("; ")
        : cause instanceof Error
          ? cause.message
          : typeof cause
    ).replaceAll(endpoint.auth.password, "[synthetic]")
  }
  const reader = new FrameReader()
  const frames = outgoing.flatMap((chunk) => reader.push(chunk))
  reader.finish()
  const exact = frames.length === 1 && expected !== undefined && Buffer.from(frames[0]).equals(Buffer.from(expected))
  output.destroy()
  for (const socket of sockets) socket.terminate()
  await new Promise<void>((resolve, reject) => listener.close((cause) => (cause ? reject(cause) : resolve())))
  console.log(
    JSON.stringify({
      ok,
      sent: incoming.length,
      frames: frames.length,
      exact,
      privateAuth,
      backpressuredWrites,
      drains,
      attempts,
      failure,
    }),
  )
}
