import worker, { DeviceRelay } from "../../src/index"
import { inspectPushRequest, inspectPushResponse } from "./push-diagnostic"
import { decodeStrict, FrameSchema, operations } from "../../../../packages/protocol/src/v5"

declare const PUSH_STUB_PORT: number
declare const PUSH_SERVED_PUBLIC_KEY_HASH: string
declare const MCP_AUTHORITY_FIXTURE: boolean

const send = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(endpoint)
  if (url.hostname === "fcm.googleapis.com" && url.pathname === "/fcm/send/flow-local-only")
    return send(`http://127.0.0.1:${PUSH_STUB_PORT}/push`, init)
  if (url.hostname === "fcm.googleapis.com" && url.pathname.startsWith("/fcm/send/admin-local-")) {
    if (url.pathname.endsWith("-unreachable")) return Promise.reject(new Error("Synthetic push transport failure"))
    return send(`http://127.0.0.1:${PUSH_STUB_PORT}/push/${url.pathname.slice("/fcm/send/admin-local-".length)}`, init)
  }
  if (url.hostname !== "fcm.googleapis.com") return send(input, init)
  const inspection = await Promise.resolve()
    .then(() =>
      inspectPushRequest(
        endpoint,
        new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization"),
        PUSH_SERVED_PUBLIC_KEY_HASH,
      ),
    )
    .catch(() => undefined)
  const outcome = await send(input, init).then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  )
  if (inspection !== undefined) {
    const response = "response" in outcome ? outcome.response : undefined
    const providerCode =
      response === undefined ? "unreported" : await inspectPushResponse(response).catch(() => "unreported" as const)
    await send(`http://127.0.0.1:${PUSH_STUB_PORT}/push-diagnostic`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...inspection,
        ...(response === undefined ? {} : { status: response.status }),
        providerCode,
      }),
    }).catch(() => undefined)
  }
  if ("error" in outcome) throw outcome.error
  return outcome.response
}

class PushFixtureRelay extends DeviceRelay {
  readonly #frames = new WeakMap<WebSocket, Promise<void>>()
  readonly #gates = new WeakMap<WebSocket, AbortController>()

  override async fetch(request: Request): Promise<Response> {
    if (
      typeof MCP_AUTHORITY_FIXTURE !== "undefined" &&
      MCP_AUTHORITY_FIXTURE &&
      ["/_ycoding/mcp", "/_ycoding/mcp-events/authorize"].includes(new URL(request.url).pathname) &&
      (request.headers.has("authorization") || request.headers.has("cookie"))
    )
      throw new Error("The internal MCP boundary received a credential header")
    return super.fetch(request)
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof MCP_AUTHORITY_FIXTURE === "undefined" || !MCP_AUTHORITY_FIXTURE) return this.#deliver(socket, message)
    const delivered = (this.#frames.get(socket) ?? Promise.resolve()).then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return
      const identity: unknown = socket.deserializeAttachment()
      if (
        typeof identity === "object" &&
        identity !== null &&
        "role" in identity &&
        identity.role === "agent" &&
        typeof message !== "string"
      ) {
        const frame = decodeStrict(FrameSchema, new Uint8Array(message))
        if (
          frame.body.case === "result" &&
          frame.body.value.operationId ===
            operations.find((operation) => operation.diagnosticName === "mcp.request")!.operationId
        ) {
          const gate = new AbortController()
          this.#gates.set(socket, gate)
          try {
            const released = await send(`http://127.0.0.1:${PUSH_STUB_PORT}/mcp-result`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              signal: gate.signal,
              body: JSON.stringify({
                case: "result",
                operationID: frame.body.value.operationId,
                requestID: frame.body.value.requestId,
              }),
            }).then(
              (response) => response.ok,
              (error: unknown) => {
                if (gate.signal.aborted) return false
                throw error
              },
            )
            if (!released) {
              if (gate.signal.aborted) return
              throw new Error("The native MCP result gate was not released")
            }
          } finally {
            if (this.#gates.get(socket) === gate) this.#gates.delete(socket)
          }
        }
      }
      if (socket.readyState === WebSocket.OPEN) await this.#deliver(socket, message)
    })
    this.#frames.set(socket, delivered)
    await delivered
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    this.#gates.get(socket)?.abort()
    await super.webSocketClose(socket)
  }

  async #deliver(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await super.webSocketMessage(socket, message)
    if (typeof MCP_AUTHORITY_FIXTURE !== "undefined" && MCP_AUTHORITY_FIXTURE) return
    const identity: unknown = socket.deserializeAttachment()
    if (
      typeof identity !== "object" ||
      identity === null ||
      !("role" in identity) ||
      identity.role !== "agent" ||
      typeof message === "string"
    )
      return
    const frame = decodeStrict(FrameSchema, new Uint8Array(message))
    if (frame.body.case !== "control" || frame.body.value.kind.case !== "status") return
    await send(`http://127.0.0.1:${PUSH_STUB_PORT}/relay-settled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attention: frame.body.value.kind.value.attention }),
    })
  }
}

export { PushFixtureRelay as DeviceRelay }
export default worker
