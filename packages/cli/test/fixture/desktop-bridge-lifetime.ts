import { getEventListeners, once } from "node:events"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"
import { Connection } from "@ycoding-ai/protocol/v5/connection"
import {
  PeerRole,
  operations,
  encodeStrict,
  FrameSchema,
  PublicEventSchema,
  SessionLogItemSchema,
} from "@ycoding-ai/protocol/v5"
import { frame } from "@ycoding-ai/protocol/v5/framing"
import { sockets } from "./desktop-bridge-socket"

const mode = process.argv[2]
if (mode !== "eof" && mode !== "abort" && mode !== "flushed" && mode !== "error" && mode !== "late-error")
  throw new Error("Unknown lifetime fixture mode")
const filename = path.resolve(import.meta.dirname, "../../src/desktop-bridge.ts")
const source = await Bun.file(filename).text()
if (!source.includes('import { WebSocket } from "ws"')) throw new Error("Desktop websocket import changed")
const code = source.replace(
  /(from\s*["'])([^"']+)(["'])/g,
  (_match, before: string, specifier: string, after: string) =>
    before + import.meta.resolve(specifier === "ws" ? "./desktop-bridge-socket.ts" : specifier) + after,
)
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" })
const module = await import(
  `data:text/javascript;base64,${Buffer.from(transpiler.transformSync(code)).toString("base64")}`
)
const bridgeDesktop: typeof import("../../src/desktop-bridge").bridgeDesktop = module.bridgeDesktop
const client = new Connection({
  role: PeerRole.LOCAL_CLIENT,
  peer: PeerRole.SERVER,
  operations,
  eventTypes: [PublicEventSchema.typeName, SessionLogItemSchema.typeName],
  now: 0,
})
client.start(0)
const hello = client.prepareHandoff(0)
if (!hello) throw new Error("Fixture Hello was not prepared")
const blocked = Promise.withResolvers<void>()
let complete: ((cause?: Error | null) => void) | undefined
const input = new PassThrough()
const output = new Writable({
  autoDestroy: false,
  highWaterMark: 1,
  write(_bytes, _encoding, callback) {
    complete = callback
    blocked.resolve()
  },
})
const controller = new AbortController()
const operation = bridgeDesktop({ url: "http://synthetic.invalid" }, input, output, controller.signal)
const result = operation.then(
  () => ({ ok: true, cancelled: false, incomplete: false, writeFailed: false }),
  (cause: unknown) => {
    const errors = cause instanceof AggregateError ? cause.errors : [cause]
    return {
      ok: false,
      cancelled: errors.some(
        (error: unknown) => error instanceof Error && error.message === "Desktop bridge cancelled",
      ),
      incomplete: errors.some(
        (error: unknown) => error instanceof Error && error.message === "Desktop bridge output incomplete",
      ),
      writeFailed: errors.some(
        (error: unknown) => error instanceof Error && error.message === "Synthetic output failure",
      ),
    }
  },
)
input.write(frame(encodeStrict(FrameSchema, hello.frame)))
await blocked.promise
if (!complete) throw new Error("Fixture did not block a write")
let ownerError = false
if (mode === "eof" || mode === "late-error") input.end()
if (mode === "abort") controller.abort()
if (mode === "flushed") {
  const drained = once(output, "drain")
  complete()
  await drained
  input.end()
}
if (mode === "error") {
  const errored = once(output, "error")
  complete(new Error("Synthetic output failure"))
  const [cause] = await errored
  ownerError = cause instanceof Error && cause.message === "Synthetic output failure"
}
let timer: ReturnType<typeof setTimeout> | undefined
const outcome = await Promise.race([
  result,
  new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 1_000)
  }),
])
clearTimeout(timer)
if (mode === "eof" || mode === "abort") {
  const drained = once(output, "drain")
  complete()
  await drained
}
if (mode === "late-error") {
  const errored = once(output, "error")
  complete(new Error("Synthetic output failure"))
  const [cause] = await errored
  ownerError = cause instanceof Error && cause.message === "Synthetic output failure"
}
const receipt = {
  settled: outcome !== undefined,
  ok: outcome?.ok ?? false,
  cancelled: outcome?.cancelled ?? false,
  incomplete: outcome?.incomplete ?? false,
  writeFailed: outcome?.writeFailed ?? false,
  ownerError,
  inputDestroyed: input.destroyed,
  outputDestroyed: output.destroyed,
  socketClosed: sockets.every((socket) => socket.closed),
  listeners:
    sockets.reduce(
      (count, socket) => count + socket.eventNames().reduce((count, event) => count + socket.listenerCount(event), 0),
      0,
    ) +
    output.listenerCount("error") +
    output.listenerCount("drain") +
    getEventListeners(controller.signal, "abort").length,
  attempts: sockets.length,
}
await result
output.destroy()
console.log(JSON.stringify(receipt))
