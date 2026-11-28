import { randomUUID } from "node:crypto"
import { decodeDomain, encodeDomain } from "@ycoding-ai/client/v5"
import { InvalidRequestErrorSchema, Streaming, WireLimit } from "@ycoding-ai/protocol/v5"
import { ScriptedPeer } from "../../../client/test/fixture/v5-peer"
import type { ModelInfo, SessionInfo } from "@ycoding-ai/client/v5"

type Stream = { send: (...values: unknown[]) => void; end: () => void }
const inlineBytes: number = WireLimit.INLINE_BODY_BYTES

export function modelFixture(providerID = "test", id = "model"): ModelInfo {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: 8192 },
  }
}

export function sessionFixture(id: string, directory: string): SessionInfo {
  return {
    id,
    title: "Fixture",
    projectID: "global",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory },
  }
}

export function v5Server(
  handle: (name: string, data: unknown) => unknown,
  options: {
    httpRequests?: string[]
    http?: (request: Request) => Response | undefined | Promise<Response | undefined>
    stop?: (instanceID: string) => boolean
    stream?: (name: string, data: unknown, stream: Stream) => () => void
  } = {},
) {
  const authorizations: (string | null)[] = []
  const peers = new Set<ScriptedPeer>()
  const server = Bun.serve<{ peer: ScriptedPeer }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const pathname = new URL(request.url).pathname
      if (pathname !== "/ws/v5/local") options.httpRequests?.push(`${request.method} ${pathname}`)
      if (pathname === "/api/service/stop") {
        const body: unknown = await request.json()
        const accepted =
          typeof body === "object" && body !== null && "instanceID" in body && typeof body.instanceID === "string"
            ? (options.stop?.(body.instanceID) ?? false)
            : false
        return Response.json({ accepted })
      }
      if (new URL(request.url).pathname === "/api/health") {
        const result = await handle("health.get", {})
        if (typeof result !== "object" || result === null || !("data" in result))
          throw new Error("Invalid health fixture")
        return Response.json(result.data)
      }
      const response = await options.http?.(request)
      if (response) return response
      if (new URL(request.url).pathname !== "/ws/v5/local") return new Response("Not found", { status: 404 })
      authorizations.push(request.headers.get("authorization"))
      const peer = new ScriptedPeer(randomUUID())
      peers.add(peer)
      if (server.upgrade(request, { data: { peer } })) return undefined
      return new Response("Upgrade required", { status: 400 })
    },
    websocket: {
      open(socket) {
        const peer = socket.data.peer
        const streams = new Map<string, (end: boolean) => void>()
        let sequence = 0
        peer.socket.addEventListener("close", () => {
          for (const close of streams.values()) close(false)
        }, { once: true })
        peer.socket.deliver = (bytes) => {
          socket.sendBinary(bytes)
        }
        peer.onRequest = (dispatch) => {
          const name = dispatch.operation.diagnosticName
          const data = decodeDomain(dispatch.operation.requestType, dispatch.request.payload)
          if (options.stream && dispatch.operation.streaming === Streaming.EVENTS) {
            const stream = options.stream
            const id = `subscription-${++sequence}`
            const typeName = dispatch.operation.eventTypes[0]
            let detach: (() => void) | undefined
            const close = (end: boolean) => {
              if (!streams.delete(id)) return
              if (end) peer.end(id)
              detach?.()
            }
            streams.set(id, close)
            peer.subscribe(dispatch, id)
            detach = stream(name, data, {
              send: (...values) => {
                if (!streams.has(id)) return
                peer.events(id, values.map((value) => ({ typeName, payload: encodeDomain(typeName, value) })))
              },
              end: () => close(true),
            })
            if (!streams.has(id)) detach()
            return
          }
          if (name === "event.subscribe") {
            peer.subscribe(dispatch)
            return
          }
          if (name === "event.unsubscribe") {
            if (typeof data === "object" && data !== null && "subscription_id" in data && typeof data.subscription_id === "string")
              streams.get(data.subscription_id)?.(true)
            peer.result(dispatch, {
              typeName: dispatch.operation.resultType,
              payload: encodeDomain(dispatch.operation.resultType, { data: {} }),
            })
            return
          }
          void (async () => {
            const result = await handle(name, data)
            if (result instanceof Error) throw result
            if (typeof result === "object" && result !== null && "_tag" in result && typeof result._tag === "string") {
              const tag = result._tag
              const typeName = dispatch.operation.errorTypes.find((name) => name === `ycoding.v5.${tag}`)
              if (!typeName) throw new Error(`Undeclared fixture error: ${tag}`)
              return { typeName, payload: encodeDomain(typeName, result), rejected: true }
            }
            const typeName = dispatch.operation.resultType
            const payload = encodeDomain(typeName, result)
            if (payload.length > 2 * WireLimit.BULK_PIECE_BYTES) throw new Error("Result exceeds two bulk pieces")
            return { typeName, payload, rejected: false }
          })().catch((error: unknown) => {
            const typeName = InvalidRequestErrorSchema.typeName
            const message = `${name} fixture: ${error instanceof Error ? error.message : String(error)}`
            return { typeName, payload: encodeDomain(typeName, { _tag: "InvalidRequestError", message }), rejected: true }
          }).then(({ typeName, payload, rejected }) => {
            if (!peers.has(peer) || peer.cancellations.includes(dispatch.requestID)) return
            if (!rejected && payload.length > inlineBytes) peer.bulk(dispatch, payload)
            else peer.result(dispatch, { typeName, payload }, rejected)
          })
        }
      },
      message(socket, message) {
        if (typeof message === "string") throw new Error("v5 requires binary frames")
        socket.data.peer.receive(new Uint8Array(message))
      },
      close(socket) {
        peers.delete(socket.data.peer)
        socket.data.peer.socket.close()
      },
    },
  })
  return { url: server.url.toString(), authorizations, peers, close: () => server.stop(true) }
}
