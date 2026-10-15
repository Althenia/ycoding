import { Buffer } from "node:buffer"
import type { WebSocketOptions } from "bun"
import { Connection, defaultBudgets } from "@ycoding-ai/protocol/v5/connection"
import type { Decision, ConfigurableBudgets } from "@ycoding-ai/protocol/v5/connection"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  FrameSchema,
  ScopeSchema,
  PeerRole,
  ScopeKind,
  Streaming,
  FailureCategory,
  LedgerClass,
  CONTRACT_DIGEST,
  operations,
  PublicEventSchema,
  SessionLogItemSchema,
  event_subscribe_ResultSchema,
  session_log_ResultSchema,
} from "@ycoding-ai/protocol/v5"
import type { Scope, OperationDescriptor } from "@ycoding-ai/protocol/v5"
import type { Endpoint } from "../service.js"
import type { RequestOptions } from "../promise/generated/client.js"
import { decodeDomain, encodeDomain } from "./codec.js"
import { V5ClientError } from "./error.js"
import { assetResult } from "./asset.js"
import { DeliveryStream } from "./stream.js"
import { globalScope } from "./surface.js"
import type { Binding } from "./surface.js"

export type Socket = {
  readonly readyState: number
  binaryType: string
  send(bytes: Uint8Array): unknown
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}
export type Discovery = Endpoint & { wireRevision?: number; contractDigest?: string }
export type V5Options = {
  endpoint?: Discovery
  discover?: () => Promise<Discovery>
  location?: { directory: string; workspaceID?: string }
  socket?: (url: string, headers: Readonly<Record<string, string>>) => Socket
  budgets?: Partial<ConfigurableBudgets>
}
type Pending = {
  binding: Binding
  operation: OperationDescriptor
  scope: Scope
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  stream?: DeliveryStream<unknown>
}
type Owner = {
  active: boolean
  ready: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
  connection?: Connection
  socket?: Socket | WebSocket
  timer?: ReturnType<typeof setInterval>
  detach?: () => void
  pending: Map<string, Pending>
  streams: Map<
    string,
    { stream: DeliveryStream<unknown>; operation: OperationDescriptor; scope: Scope; closing: boolean }
  >
  opening: number
  epoch?: string
  sourceEpoch?: string
}

export class LocalTransport {
  #owner: Owner
  #pumping = false
  readonly #options: V5Options

  constructor(options: V5Options) {
    if (!options.endpoint && !options.discover) throw new Error("A discovered v5 endpoint is required")
    this.#options = options
    this.#owner = this.open()
  }

  get state() {
    return this.#owner.active ? (this.#owner.connection?.state ?? "discovering") : "closed"
  }
  get sourceEpoch() {
    return this.#owner.sourceEpoch
  }
  get connectionEpoch() {
    return this.#owner.epoch
  }
  get retainedBytes() {
    return this.#owner.connection?.reservation.used ?? 0
  }
  ready() {
    return this.#owner.ready
  }
  globalScope = globalScope

  close() {
    this.shutdown(this.#owner, new V5ClientError("unavailable", undefined, "Connection closed"))
  }

  reconnect() {
    this.shutdown(this.#owner, new V5ClientError("unknown", undefined, "Connection replaced"))
    this.#owner = this.open()
    return this.#owner.ready
  }

  async call<A>(binding: Binding, data: Record<string, unknown>, input: unknown, options?: RequestOptions): Promise<A> {
    return (await this.execute(this.#owner, binding, data, input, options)) as A
  }

  stream<A>(
    binding: Binding,
    data: Record<string, unknown>,
    input: unknown,
    options?: RequestOptions,
  ): AsyncIterable<A> {
    const owner = this.#owner
    const transport = this
    return {
      [Symbol.asyncIterator]() {
        const lifetime = new AbortController()
        const signal = options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
        const iterator = (async function* () {
          const stream = new DeliveryStream<unknown>(
            owner.connection?.budgets.eventQueueCount ??
              transport.#options.budgets?.eventQueueCount ??
              defaultBudgets.eventQueueCount,
            owner.connection?.budgets.eventQueueBytes ??
              transport.#options.budgets?.eventQueueBytes ??
              defaultBudgets.eventQueueBytes,
          )
          const abort = () => stream.fail(new V5ClientError("unavailable", binding.method, "Subscription cancelled"))
          signal.addEventListener("abort", abort, { once: true })
          try {
            await transport.execute(owner, binding, data, input, { ...options, signal }, stream)
            if (binding.method === "event.subscribe")
              yield { id: owner.epoch, sourceEpoch: owner.sourceEpoch, type: "server.connected", data: {} } as A
            for await (const value of stream) yield value as A
          } finally {
            signal.removeEventListener("abort", abort)
            await stream.return()
          }
        })()
        return {
          next: () => iterator.next(),
          return: async () => {
            lifetime.abort()
            return iterator.return()
          },
          throw: async (error: unknown) => {
            lifetime.abort()
            return iterator.throw(error)
          },
          [Symbol.asyncIterator]() {
            return this
          },
        }
      },
    }
  }

  private open(): Owner {
    const deferred = Promise.withResolvers<void>()
    const owner: Owner = {
      active: true,
      ready: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject,
      pending: new Map(),
      streams: new Map(),
      opening: 0,
    }
    void owner.ready.catch(() => {})
    queueMicrotask(() => {
      void this.initialize(owner).catch(() =>
        this.shutdown(
          owner,
          new V5ClientError("unavailable", undefined, "Discovery or connection establishment failed"),
        ),
      )
    })
    return owner
  }

  private async initialize(owner: Owner) {
    const endpoint = this.#options.discover ? await this.#options.discover() : this.#options.endpoint!
    if (this.#owner !== owner || !owner.active) return
    if (
      (endpoint.wireRevision !== undefined && endpoint.wireRevision !== 5) ||
      (endpoint.contractDigest !== undefined && endpoint.contractDigest !== CONTRACT_DIGEST)
    ) {
      this.shutdown(owner, new V5ClientError("protocol", undefined, "Incompatible discovered wire contract"))
      return
    }
    const url = new URL("/ws/v5/local", endpoint.url)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Invalid local endpoint")
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const headers: Readonly<Record<string, string>> = endpoint.auth
      ? {
          Authorization: `Basic ${Buffer.from(`${endpoint.auth.username}:${endpoint.auth.password}`, "utf8").toString("base64")}`,
        }
      : {}
    const connection = new Connection({
      role: PeerRole.LOCAL_CLIENT,
      peer: PeerRole.SERVER,
      operations,
      eventTypes: [PublicEventSchema.typeName, SessionLogItemSchema.typeName],
      now: performance.now(),
      budgets: this.#options.budgets,
    })
    owner.connection = connection
    const NativeSocket = WebSocket as typeof WebSocket & { new (url: string, options: WebSocketOptions): WebSocket }
    const socket = this.#options.socket
      ? this.#options.socket(url.toString(), headers)
      : new NativeSocket(url.toString(), { headers })
    owner.socket = socket
    socket.binaryType = "arraybuffer"
    const live = () => owner === this.#owner && owner.active
    const open: EventListener = () => {
      if (!live()) return
      this.process(owner, connection.start(performance.now()))
      this.pump(owner)
    }
    const message: EventListener = (event) => {
      if (!live()) return
      const data: unknown = (event as MessageEvent<unknown>).data
      if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
        this.process(owner, connection.close(FailureCategory.MALFORMED))
        return
      }
      const token = connection.admitIncoming(data.byteLength)
      if (!token) {
        this.process(owner, connection.takeDecisions())
        return
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      const frame = (() => {
        try {
          return decodeStrict(FrameSchema, bytes)
        } catch {
          this.process(owner, connection.rejectIncoming(token))
          return undefined
        }
      })()
      if (!frame) return
      try {
        const decisions = connection.acceptIncoming(token, frame, performance.now())
        this.process(owner, decisions, bytes.length)
        if (
          owner.active &&
          ((frame.body.case === "result" && decisions.some((decision) => decision.type === "settled")) ||
            (frame.ledger === LedgerClass.NORMAL && decisions.some((decision) => decision.type === "control")))
        )
          this.process(owner, connection.consume(frame.ledger, frame.deliveryOrdinal, performance.now()))
      } catch {
        this.process(owner, connection.state === "closed" ? [] : connection.close(FailureCategory.MALFORMED))
      }
      this.pump(owner)
    }
    const close: EventListener = () => {
      if (live()) this.shutdown(owner, new V5ClientError("unavailable", undefined, "Socket disconnected"))
    }
    socket.addEventListener("open", open)
    socket.addEventListener("message", message)
    socket.addEventListener("close", close)
    socket.addEventListener("error", close)
    owner.detach = () => {
      socket.removeEventListener("open", open)
      socket.removeEventListener("message", message)
      socket.removeEventListener("close", close)
      socket.removeEventListener("error", close)
    }
    owner.timer = setInterval(() => {
      if (!live()) return
      this.process(owner, connection.advance(performance.now()))
      this.pump(owner)
    }, 25)
    if (socket.readyState === 1) open(new Event("open"))
  }

  private async execute(
    owner: Owner,
    binding: Binding,
    data: Record<string, unknown>,
    input: unknown,
    options?: RequestOptions,
    stream?: DeliveryStream<unknown>,
  ): Promise<unknown> {
    const operation = operations.find((operation) => operation.operationId === binding.operationID)!
    if (
      !owner.active ||
      owner !== this.#owner ||
      owner.opening + owner.pending.size >=
        (owner.connection?.budgets.pendingRequests ??
          this.#options.budgets?.pendingRequests ??
          defaultBudgets.pendingRequests)
    )
      throw new V5ClientError("unsent", binding.method)
    owner.opening++
    const aborted = Promise.withResolvers<never>()
    const abortOpening = () =>
      aborted.reject(new V5ClientError("unsent", binding.method, "Request cancelled before transmission"))
    options?.signal?.addEventListener("abort", abortOpening, { once: true })
    if (options?.signal?.aborted) abortOpening()
    try {
      await Promise.race([owner.ready, aborted.promise])
    } finally {
      owner.opening--
      options?.signal?.removeEventListener("abort", abortOpening)
    }
    if (owner !== this.#owner || !owner.active || options?.signal?.aborted)
      throw new V5ClientError("unsent", binding.method)
    const connection = owner.connection!
    const request = (() => {
      const reservation = connection.budgets.clientFrameBytes + connection.budgets.inlineBytes
      if (!connection.reservation.reserve(reservation))
        throw new V5ClientError("unsent", binding.method, "Request allocation limit")
      try {
        return this.prepare(operation, data, input, options, connection.budgets.inlineBytes)
      } catch {
        throw new V5ClientError("unsent", binding.method, "Input cannot be represented by v5")
      } finally {
        connection.reservation.release(reservation)
      }
    })()
    const pending = Promise.withResolvers<unknown>()
    const sent = connection.request(
      operation.operationId,
      request.scope,
      request.payload,
      request.payload.length + encodeStrict(ScopeSchema, request.scope).length + 256,
      performance.now(),
    )
    if (!sent.requestID) {
      this.process(owner, sent.decisions)
      throw new V5ClientError("unsent", binding.method, "Request was not admitted to transport")
    }
    owner.pending.set(sent.requestID, {
      binding,
      operation,
      scope: request.target ?? request.scope,
      resolve: pending.resolve,
      reject: pending.reject,
      stream,
    })
    this.process(owner, sent.decisions)
    const abort = () => {
      this.process(owner, connection.cancel(sent.requestID!, performance.now()))
      this.pump(owner)
    }
    options?.signal?.addEventListener("abort", abort, { once: true })
    if (options?.signal?.aborted) abort()
    this.pump(owner)
    try {
      return await pending.promise
    } finally {
      options?.signal?.removeEventListener("abort", abort)
    }
  }

  private prepare(
    operation: OperationDescriptor,
    data: Record<string, unknown>,
    input: unknown,
    options: RequestOptions | undefined,
    maximumBytes: number,
  ) {
    const params = data.params as Record<string, unknown> | undefined
    const query = data.query as Record<string, unknown> | undefined
    const identity = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
    const headers = new Headers(options?.headers)
    const selected =
      operation.diagnosticName === "session.create" && identity.location != null
        ? identity.location
        : headers.has("x-ycoding-directory")
          ? {
              directory: decodeURIComponent(headers.get("x-ycoding-directory")!),
              workspace: headers.get("x-ycoding-workspace") ?? undefined,
            }
          : (query?.location ?? {
              directory: this.#options.location?.directory ?? process.cwd(),
              workspace: this.#options.location?.workspaceID,
            })
    if (query && selected !== undefined && !query.location) query.location = selected
    const location =
      typeof selected === "object" && selected !== null && "directory" in selected ? selected.directory : undefined
    const workspace =
      typeof selected === "object" && selected !== null
        ? "workspaceID" in selected
          ? selected.workspaceID
          : "workspace" in selected
            ? selected.workspace
            : undefined
        : undefined
    if (
      operation.diagnosticName === "session.create" &&
      typeof data.payload === "object" &&
      data.payload !== null &&
      !("location" in data.payload && data.payload.location !== undefined)
    ) {
      data.payload = { ...data.payload, location: { directory: location ?? process.cwd(), workspaceID: workspace } }
    }
    const target = operation.diagnosticName === "event.subscribe" ? globalScope() : undefined
    const scope =
      operation.scope === ScopeKind.MACHINE
        ? create(ScopeSchema, { target: { case: "machine", value: {} } })
        : operation.scope === ScopeKind.GLOBAL
          ? globalScope()
          : operation.scope === ScopeKind.LOCATION
            ? create(ScopeSchema, {
                target: {
                  case: "location",
                  value: encodeLossless(typeof location === "string" ? location : process.cwd()),
                },
              })
            : operation.scope === ScopeKind.FORM
              ? create(ScopeSchema, {
                  target:
                    (params?.sessionID ?? identity.sessionID) === "global"
                      ? {
                          case: "globalForm",
                          value: {
                            directory: encodeLossless(typeof location === "string" ? location : process.cwd()),
                            ...(typeof workspace === "string" ? { workspaceId: encodeLossless(workspace) } : {}),
                          },
                        }
                      : { case: "form", value: String(params?.sessionID ?? identity.sessionID ?? "") },
                })
              : create(ScopeSchema, {
                  target: {
                    case: "session",
                    value: String(params?.sessionID ?? params?.parentID ?? identity.sessionID ?? ""),
                  },
                })
    const payload = encodeDomain(operation.requestType, data, maximumBytes)
    return { scope, target, payload }
  }

  private process(owner: Owner, decisions: readonly Decision[], frameBytes = 0) {
    const connection = owner.connection!
    const completedAssets = decisions.filter(
      (decision): decision is Extract<Decision, { type: "bulkComplete" }> => decision.type === "bulkComplete",
    )
    for (const decision of decisions) {
      if (decision.type === "ready") {
        owner.epoch = decision.epoch
        owner.sourceEpoch = decision.sourceEpoch
        owner.resolve()
        continue
      }
      if (decision.type === "closed") {
        this.shutdown(
          owner,
          new V5ClientError("protocol", undefined, FailureCategory[decision.category]),
          decision.code,
        )
        continue
      }
      if (decision.type === "bulkComplete") {
        connection.releaseBulk(decision.transferID)
        continue
      }
      if (decision.type === "settled") {
        const pending = owner.pending.get(decision.requestID)
        if (!pending) continue
        owner.pending.delete(decision.requestID)
        try {
          if (decision.status !== "success" && decision.status !== "rejected") {
            pending.reject(new V5ClientError(decision.status, pending.binding.method))
            continue
          }
          if (!decision.payload) {
            pending.reject(
              new V5ClientError("unsupported", pending.binding.method, "Asset metadata is unsupported until contract"),
            )
            continue
          }
          if (decision.status === "rejected") {
            pending.reject(decodeDomain(decision.payload.typeName, decision.payload.payload))
            continue
          }
          if (pending.operation.streaming === Streaming.ASSET_BULK) {
            try {
              pending.resolve(
                assetResult(
                  completedAssets.find((completion) => completion.start.requestId === decision.requestID),
                  pending.operation.diagnosticName,
                ),
              )
            } catch (error) {
              pending.reject(error)
            }
            continue
          }
          if (pending.stream) {
            const result =
              pending.operation.diagnosticName === "event.subscribe"
                ? decodeStrict(event_subscribe_ResultSchema, decision.payload.payload)
                : decodeStrict(session_log_ResultSchema, decision.payload.payload)
            const subscriptionID = decodeLossless(result.subscriptionId!)
            this.process(
              owner,
              connection.acceptSubscription(decision.requestID, subscriptionID, pending.scope, performance.now()),
            )
            if (!owner.active) {
              pending.reject(new V5ClientError("protocol", pending.binding.method))
              continue
            }
            pending.stream.subscriptionID = subscriptionID
            const subscription = {
              stream: pending.stream,
              operation: pending.operation,
              scope: pending.scope,
              closing: false,
            }
            owner.streams.set(subscriptionID, subscription)
            pending.stream.onReturn(async () => {
              subscription.closing = true
              if (!owner.active || owner !== this.#owner) return
              await this.execute(
                owner,
                { method: "event.unsubscribe", operationID: 4001 },
                { subscription_id: subscriptionID },
                undefined,
              )
            })
            pending.resolve(undefined)
            continue
          }
          const result = pending.binding.empty
            ? undefined
            : decodeDomain(decision.payload.typeName, decision.payload.payload)
          pending.resolve(
            (pending.binding.resultPath ?? []).reduce<unknown>(
              (value, key) =>
                typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined,
              result,
            ),
          )
        } catch {
          pending.reject(new V5ClientError("protocol", pending.binding.method, "Invalid typed domain result"))
          this.process(owner, connection.close(FailureCategory.MALFORMED))
        }
        continue
      }
      if (decision.type === "events") {
        const subscription = owner.streams.get(decision.subscriptionID)
        if (!subscription) continue
        if (subscription.closing) {
          if (decision.ordinal !== undefined)
            this.process(owner, connection.consume(LedgerClass.EVENT, decision.ordinal, performance.now()))
          continue
        }
        const cost =
          frameBytes || decision.batch.events.reduce((sum, event) => sum + (event.event?.payload.length ?? 0) + 512, 0)
        if (
          decision.batch.events.length > subscription.stream.capacity.count ||
          cost > subscription.stream.capacity.bytes ||
          !connection.reservation.reserve(cost)
        ) {
          this.process(owner, connection.close(FailureCategory.LIMIT))
          continue
        }
        try {
          const values = decision.batch.events.map((event) => decodeDomain(event.event!.typeName, event.event!.payload))
          subscription.stream.push(values, cost, () => connection.reservation.release(cost))
        } catch (error) {
          connection.reservation.release(cost)
          throw error
        }
        if (decision.ordinal !== undefined)
          this.process(owner, connection.consume(LedgerClass.EVENT, decision.ordinal, performance.now()))
        continue
      }
      if (decision.type === "streamEnded") {
        const subscription = owner.streams.get(decision.subscriptionID)
        owner.streams.delete(decision.subscriptionID)
        subscription?.stream.onReturn(async () => {})
        subscription?.stream.end()
        continue
      }
      if (decision.type === "resync") {
        owner.streams.forEach((subscription, id) => {
          if (!decision.subscriptionID || decision.subscriptionID === id)
            subscription.stream.fail(
              new V5ClientError("resync", subscription.operation.diagnosticName, "Canonical snapshot is required"),
            )
        })
      }
    }
  }

  private pump(owner: Owner) {
    if (this.#pumping || !owner.active || owner !== this.#owner || owner.socket?.readyState !== 1 || !owner.connection)
      return
    this.#pumping = true
    try {
      for (;;) {
        const prepared = owner.connection.prepareHandoff(performance.now())
        this.process(owner, owner.connection.takeDecisions())
        if (!prepared || !owner.active) break
        const bytes = encodeStrict(FrameSchema, prepared.frame)
        const decisions = owner.connection.handoff(prepared, bytes.length, performance.now())
        this.process(owner, decisions)
        if (!owner.active) break
        owner.socket.send(new Uint8Array(bytes))
      }
    } catch {
      this.shutdown(owner, new V5ClientError("unknown", undefined, "Socket handoff failed"))
    } finally {
      this.#pumping = false
    }
  }

  private shutdown(owner: Owner, error: V5ClientError, code = 1012) {
    if (!owner.active) return
    owner.active = false
    owner.reject(error)
    owner.detach?.()
    if (owner.timer) clearInterval(owner.timer)
    if (owner.connection) this.process(owner, owner.connection.restart(performance.now()))
    owner.pending.forEach((pending) => pending.reject(error))
    owner.pending.clear()
    owner.streams.forEach((subscription) => subscription.stream.fail(error))
    owner.streams.clear()
    owner.socket?.close(code, error.status === "protocol" ? error.reason : "connection_closed")
  }
}
