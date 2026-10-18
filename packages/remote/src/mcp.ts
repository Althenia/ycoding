import {
  WireLimit,
  create,
  decodeLossless,
  decodeStrict,
  encodeLossless,
  encodeStrict,
  mcp_request_RequestSchema,
  mcp_request_ResultSchema,
} from "@ycoding-ai/protocol/v5"
import type { RemoteError } from "./index"

export const mcpScope = "ycoding:remote"
export const mcpHeaderNames = ["content-type", "accept", "mcp-protocol-version", "mcp-method", "mcp-name"] as const
export const McpLimits = Object.freeze({
  bodyChars: 32_768,
  headerChars: 1_024,
  clientIDChars: 2_048,
  responseBytes: 2 * 1024 * 1024,
  timeoutMs: 5 * 60_000,
  pendingPerClient: 32,
  requestsPerWindow: 120,
  rateWindowMs: 10_000,
})

export type McpHeaders = Partial<Record<(typeof mcpHeaderNames)[number], string>>
export type McpPrincipal = { readonly ownerID: string; readonly deviceID: string; readonly clientID: string }
export type McpResponse = { readonly status: number; readonly contentType: string; readonly body: string }

export function mcpResource(origin: string, deviceID: string) {
  if (!isMcpIdentifier(deviceID)) throw new Error("Invalid enrolled device ID")
  const url = new URL(origin)
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Invalid enrolled relay origin")
  return `${url.origin}/api/mcp/devices/${deviceID}`
}

export type McpForward = {
  readonly body: string
  readonly headers: McpHeaders
  readonly principal: McpPrincipal
  readonly epoch: string
}

export function encodeMcpRequest(
  input: McpForward,
): { readonly ok: true; readonly value: Uint8Array } | { readonly ok: false; readonly error: RemoteError } {
  if (input.body.length > McpLimits.bodyChars) return mcpFailure("message_too_large", "Request exceeds the relay frame bound")
  const headers = Object.entries(input.headers)
  if (
    input.body.length === 0 ||
    !isMcpIdentifier(input.epoch) ||
    !isMcpIdentifier(input.principal.ownerID) ||
    !isMcpIdentifier(input.principal.deviceID) ||
    !boundedText(input.principal.clientID, McpLimits.clientIDChars) ||
    !headers.every(
      ([name, value]) =>
        (mcpHeaderNames as readonly string[]).includes(name) &&
        typeof value === "string" &&
        value.length <= McpLimits.headerChars &&
        !/[\r\n\0]/.test(value),
    )
  )
    return mcpFailure("invalid_message", "Request is not a valid MCP forward")
  const bytes = (() => {
    try {
      return encodeStrict(
        mcp_request_RequestSchema,
        create(mcp_request_RequestSchema, {
          payload: {
            body: encodeLossless(input.body),
            headers: headers.map(([name, value]) => ({ name, value: encodeLossless(value ?? "") })),
            principal: {
              ownerID: input.principal.ownerID,
              deviceID: input.principal.deviceID,
              clientID: encodeLossless(input.principal.clientID),
            },
            epoch: input.epoch,
          },
        }),
      )
    } catch {
      return undefined
    }
  })()
  if (bytes === undefined) return mcpFailure("invalid_message", "Request is not a valid MCP forward")
  if (bytes.length > WireLimit.INLINE_BODY_BYTES)
    return mcpFailure("message_too_large", "Request exceeds the relay frame bound")
  return { ok: true, value: bytes }
}

export function decodeMcpResponse(bytes: Uint8Array): McpResponse | undefined {
  try {
    const data = decodeStrict(mcp_request_ResultSchema, bytes).data
    if (!data?.body) return undefined
    return { status: data.status, contentType: data.contentType, body: decodeLossless(data.body, McpLimits.responseBytes) }
  } catch {
    return undefined
  }
}

function boundedText(value: string, max: number) {
  return value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value)
}

function mcpFailure(code: RemoteError["code"], message: string) {
  return { ok: false as const, error: { code, message } }
}

export function isMcpIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}
