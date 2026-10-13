import { randomUUID } from "node:crypto"
import { decodeDomain, encodeDomain } from "@ycoding-ai/client/v5"
import { ScriptedPeer } from "../../../client/test/fixture/v5-peer"
import type { ModelInfo, SessionInfo } from "@ycoding-ai/client/v5"

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
  handle: (name: string, data: unknown) => unknown | Promise<unknown>,
  options: { httpRequests?: string[]; stop?: (instanceID: string) => boolean } = {},
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
      if (new URL(request.url).pathname !== "/ws/v5/local") return new Response("Not found", { status: 404 })
      authorizations.push(request.headers.get("authorization"))
      const peer = new ScriptedPeer(randomUUID())
      peers.add(peer)
      if (server.upgrade(request, { data: { peer } })) return
      return new Response("Upgrade required", { status: 400 })
    },
    websocket: {
      open(socket) {
        const peer = socket.data.peer
        peer.socket.deliver = (bytes) => {
          socket.sendBinary(bytes)
        }
        peer.onRequest = (dispatch) => {
          if (dispatch.operation.diagnosticName === "event.subscribe") {
            peer.subscribe(dispatch)
            return
          }
          if (dispatch.operation.diagnosticName === "event.unsubscribe") {
            peer.result(dispatch, {
              typeName: dispatch.operation.resultType,
              payload: encodeDomain(dispatch.operation.resultType, { data: {} }),
            })
            return
          }
          void Promise.resolve(
            handle(
              dispatch.operation.diagnosticName,
              decodeDomain(dispatch.operation.requestType, dispatch.request.payload),
            ),
          ).then(
            (result) => {
              if (result instanceof Error) {
                peer.reject(dispatch)
                return
              }
              peer.result(dispatch, {
                typeName: dispatch.operation.resultType,
                payload: encodeDomain(dispatch.operation.resultType, result),
              })
            },
            () => peer.reject(dispatch),
          )
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
