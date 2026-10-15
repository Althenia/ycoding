import { Connection } from "@ycoding-ai/protocol/v5/connection"
import type { WebSocketOptions } from "bun"
import type { Decision, Options } from "@ycoding-ai/protocol/v5/connection"
import {
  create,
  encodeStrict,
  FrameSchema,
  ResultSchema,
  TypedPayloadSchema,
  PeerRole,
  operations,
  LedgerClass,
} from "@ycoding-ai/protocol/v5"
import type { Frame, Scope } from "@ycoding-ai/protocol/v5"
import {
  frameReservation,
  handoffBinary,
  receiveBinary,
  remoteEventTypes,
  createRemoteConnection,
  remotePayloadCodecs,
  encodeRemoteRequest,
} from "../src/index"

const NativeSocket = WebSocket as typeof WebSocket & { new (url: string, options: WebSocketOptions): WebSocket }

export class TestPeer {
  readonly connection: Connection
  readonly socket: WebSocket
  readonly queue: { frame?: Frame; decision: Decision }[] = []
  readonly raw: Frame[] = []
  readonly ready: Promise<void>
  readonly closed: Promise<{ code: number; reason: string }>
  readonly failures: Error[] = []
  autoConsume = true
  private readonly watchers = new Set<() => void>()
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    url: string,
    headers: Record<string, string>,
    role: PeerRole.AGENT | PeerRole.REMOTE_CLIENT,
    budgets?: Options["budgets"],
    hello?: (frame: Frame) => Frame,
  ) {
    this.connection =
      role === PeerRole.REMOTE_CLIENT
        ? createRemoteConnection({ now: performance.now(), budgets })
        : new Connection({
            role,
            peer: PeerRole.RELAY,
            operations,
            eventTypes: remoteEventTypes,
            now: performance.now(),
            budgets,
          })
    this.socket = new NativeSocket(url, { headers })
    this.socket.binaryType = "arraybuffer"
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener(
        "open",
        () => {
          this.connection.start(performance.now())
          if (!hello) {
            this.flush()
            return
          }
          const prepared = this.connection.prepareHandoff(performance.now())!
          const bytes = encodeStrict(FrameSchema, hello(prepared.frame))
          this.connection.handoff(prepared, encodeStrict(FrameSchema, prepared.frame).length, performance.now())
          this.socket.send(bytes)
        },
        { once: true },
      )
      this.socket.addEventListener("error", () => reject(new Error("Peer socket failed")), { once: true })
      this.socket.addEventListener(
        "close",
        () => {
          if (this.connection.state !== "established") reject(new Error("Peer closed before Ready"))
        },
        { once: true },
      )
      this.watchers.add(() => {
        if (this.connection.state === "established") resolve()
      })
    })
    void this.ready.catch(() => undefined)
    this.closed = new Promise((resolve) =>
      this.socket.addEventListener(
        "close",
        (event) => {
          this.collect(this.connection.restart(performance.now()))
          clearInterval(this.timer)
          resolve({ code: event.code, reason: event.reason })
          this.notify()
        },
        { once: true },
      ),
    )
    this.socket.addEventListener("message", (event) => {
      try {
        const incoming = receiveBinary(this.connection, event.data, performance.now())
        if (incoming.frame) this.raw.push(incoming.frame)
        if (this.raw.length > 256) this.raw.shift()
        this.collect(incoming.decisions, incoming.frame)
        if (
          this.autoConsume &&
          !incoming.decisions.some((decision) => decision.type === "assetMetadata" || decision.type === "resync") &&
          incoming.frame &&
          ["request", "result", "control"].includes(incoming.frame.body.case ?? "") &&
          incoming.frame.ledger === LedgerClass.NORMAL &&
          this.connection.state !== "closed"
        )
          this.collect(this.connection.consume(LedgerClass.NORMAL, incoming.frame.deliveryOrdinal, performance.now()))
        this.flush()
        this.notify()
      } catch (error) {
        this.failures.push(error instanceof Error ? error : new Error("Peer failure"))
        this.socket.close(1012, "EPOCH")
        this.notify()
      }
    })
    this.timer = setInterval(() => {
      this.collect(this.connection.advance(performance.now()))
      this.flush()
      this.notify()
    }, 25)
  }

  flush() {
    if (this.socket.readyState !== 1 || this.connection.state === "closed") return
    this.collect(handoffBinary(this.connection, (bytes) => this.socket.send(bytes), performance.now()))
  }
  request(name: string, scope: Scope, payload: Uint8Array) {
    const operation = operations.find((item) => item.diagnosticName === name)!
    const encoded =
      this.connection.options.role === PeerRole.REMOTE_CLIENT
        ? encodeRemoteRequest(name, remotePayloadCodecs.get(name)!.request.decode(payload))
        : payload
    const request = this.connection.request(
      operation.operationId,
      scope,
      encoded,
      encoded.length + 512,
      performance.now(),
    )
    this.collect(request.decisions)
    this.flush()
    if (!request.requestID) throw new Error(`Request refused: ${name}`)
    return request.requestID
  }
  send(body: Frame["body"]) {
    this.collect(this.connection.enqueue(body, frameReservation(body), performance.now()))
    this.flush()
  }
  result(dispatch: Extract<Decision, { type: "dispatch" }>, payload: Uint8Array) {
    this.send({
      case: "result",
      value: create(ResultSchema, {
        requestId: dispatch.requestID,
        operationId: dispatch.operation.operationId,
        settlement: dispatch.operation.settlement,
        outcome: {
          case: "success",
          value: create(TypedPayloadSchema, { typeName: dispatch.operation.resultType, payload }),
        },
      }),
    })
  }
  async next<Type extends Decision["type"]>(
    type: Type,
    requestID?: string,
  ): Promise<Extract<Decision, { type: Type }>> {
    await this.wait(() =>
      this.queue.some(
        (item) =>
          item.decision.type === type &&
          (requestID === undefined || ("requestID" in item.decision && item.decision.requestID === requestID)),
      ),
    ).catch((cause: unknown) => {
      throw new Error(
        `Waiting for ${type} ${requestID ?? ""} on role ${this.connection.options.role}, state ${this.connection.state}`,
        { cause },
      )
    })
    const index = this.queue.findIndex(
      (item) =>
        item.decision.type === type &&
        (requestID === undefined || ("requestID" in item.decision && item.decision.requestID === requestID)),
    )
    return this.queue.splice(index, 1)[0]!.decision as Extract<Decision, { type: Type }>
  }
  wait(predicate: () => boolean, timeout = 10_000): Promise<void> {
    if (predicate()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (this.failures.length) {
          clearTimeout(timer)
          this.watchers.delete(finish)
          reject(this.failures[0])
          return
        }
        if (!predicate()) return
        clearTimeout(timer)
        this.watchers.delete(finish)
        resolve()
      }
      const timer = setTimeout(() => {
        this.watchers.delete(finish)
        reject(new Error("Peer condition timed out"))
      }, timeout)
      this.watchers.add(finish)
    })
  }
  stop() {
    clearInterval(this.timer)
    if (this.socket.readyState === 1) this.socket.close(1000, "EPOCH")
  }
  private collect(decisions: readonly Decision[], frame?: Frame) {
    for (const decision of decisions) {
      if (decision.type === "closed") {
        if (this.socket.readyState === 1) this.socket.close(decision.code, "LIMIT")
        continue
      }
      if (decision.type === "ready") continue
      this.queue.push({ frame, decision })
      if (this.queue.length > 128) {
        this.failures.push(new Error("Test consumer queue exhausted"))
        this.stop()
        break
      }
    }
  }
  private notify() {
    for (const callback of this.watchers) callback()
  }
}
