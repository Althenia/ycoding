import { McpLimits, mcpHeaderNames } from "../../../packages/remote/src/index"
import type { RelayNamespace } from "./router"

export type ForwardMcpPrincipal = {
  readonly ownerID: string
  readonly deviceID: string
  readonly clientID: string
  readonly grantID: string
  readonly epoch: string
  readonly expiresAt: number
}

export async function forwardMcpRequest(relay: RelayNamespace, principal: ForwardMcpPrincipal, request: Request): Promise<Response> {
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  if (reader) {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > McpLimits.bodyChars * 4) {
        await reader.cancel()
        return Response.json({ error: { code: "message_too_large", message: "MCP request exceeds the relay frame bound" } }, { status: 413 })
      }
      chunks.push(next.value)
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const body = decodeBody(bytes)
  if (body === undefined) return Response.json({ error: { code: "invalid_message", message: "MCP request must be valid UTF-8" } }, { status: 400 })
  if (body.length > McpLimits.bodyChars)
    return toolFailure(body, "message_too_large", 413)
  const headers = new Headers()
  for (const name of mcpHeaderNames) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set("x-ycoding-internal", "1")
  headers.set("x-ycoding-mcp-owner", principal.ownerID)
  headers.set("x-ycoding-mcp-device", principal.deviceID)
  headers.set("x-ycoding-mcp-client", principal.clientID)
  headers.set("x-ycoding-mcp-grant", principal.grantID)
  headers.set("x-ycoding-mcp-epoch", principal.epoch)
  headers.set("x-ycoding-mcp-expires", String(principal.expiresAt))
  headers.set("x-ycoding-mcp-resource", new URL(request.url).origin + new URL(request.url).pathname)
  const response = await relay.getByName(`${principal.ownerID}:${principal.deviceID}`).fetch(new Request("https://relay.internal/_ycoding/mcp", {
    method: "POST", headers, body, signal: request.signal,
  })).catch(() => Response.json({ error: { code: "outcome_unknown", message: "MCP transport outcome is unknown" } }, { status: 502 }))
  if (response.ok) return response
  const failure: unknown = await response.clone().json().catch(() => undefined)
  if (!record(failure) || !record(failure.error) || typeof failure.error.code !== "string") return response
  if (failure.error.code !== "outcome_unknown" && failure.error.code !== "unknown_operation" && failure.error.code !== "message_too_large") return response
  return toolFailure(body, failure.error.code, response.status)
}

function toolFailure(body: string, code: string, status: number) {
  const message = code === "unknown_operation"
    ? "Update YCoding on this machine with `ycoding update`, then run `ycoding service restart` before using relay MCP"
    : code === "message_too_large"
      ? "MCP data exceeds the relay frame bound; narrow the request or use a smaller page"
      : "MCP request outcome is unknown; inspect the Session state before retrying. This request was not replayed."
  const response = () => Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } })
  let rpc: unknown
  try { rpc = JSON.parse(body) } catch { return response() }
  if (!record(rpc) || rpc.jsonrpc !== "2.0" || rpc.method !== "tools/call" ||
    !(typeof rpc.id === "string" || typeof rpc.id === "number" && Number.isSafeInteger(rpc.id))) return response()
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { resultType: "complete", isError: true,
    content: [{ type: "text", text: message }] } }, { headers: { "cache-control": "no-store" } })
}

function decodeBody(bytes: Uint8Array) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) } catch { return undefined }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
