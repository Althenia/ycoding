import { RemoteLimits } from "./index.ts"

export const remoteMcpOperations = ["mcp.request"] as const
export const mcpScope = "ycoding:remote"
export const mcpHeaderNames = ["content-type", "accept", "mcp-protocol-version", "mcp-method", "mcp-name"] as const
export type McpHeaders = Partial<Record<(typeof mcpHeaderNames)[number], string>>
export type McpPrincipal = { readonly ownerID: string; readonly deviceID: string; readonly clientID: string }
export type McpRequest = {
  readonly type: "request"
  readonly id: string
  readonly operation: "mcp.request"
  readonly input: { readonly body: string; readonly headers: McpHeaders; readonly principal: McpPrincipal; readonly epoch: string }
}
export type McpState = { readonly type: "mcp.state"; readonly id: string; readonly enabled: boolean; readonly epoch: string }
export type McpStateAck = { readonly type: "mcp.state.ack"; readonly id: string; readonly enabled: boolean; readonly epoch: string }
export type McpResponse = { readonly status: number; readonly contentType: string; readonly body: string }

export function mcpResource(origin: string, deviceID: string) {
  if (!identifier(deviceID)) throw new Error("Invalid enrolled device ID")
  const url = new URL(origin)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("Invalid enrolled relay origin")
  return `${url.origin}/api/mcp/devices/${deviceID}`
}

export function parseMcpRequest(raw: string): McpRequest | undefined {
  const value = decode(raw)
  if (!record(value) || !keys(value, ["type", "id", "operation", "input"]) || value.type !== "request" ||
    value.operation !== "mcp.request" || !identifier(value.id) || !record(value.input)) return
  const input = value.input
  if (!keys(input, ["body", "headers", "principal", "epoch"]) || typeof input.body !== "string" ||
    input.body.length === 0 || !identifier(input.epoch) || !record(input.headers) || !record(input.principal)) return
  if (!Object.entries(input.headers).every(([key, field]) => (mcpHeaderNames as readonly string[]).includes(key) &&
    typeof field === "string" && field.length <= 1024 && !/[\r\n\0]/.test(field))) return
  const principal = input.principal
  if (!keys(principal, ["ownerID", "deviceID", "clientID"]) || !identifier(principal.ownerID) || !identifier(principal.deviceID) ||
    typeof principal.clientID !== "string" || principal.clientID.length === 0 || principal.clientID.length > 2048 || /[\r\n\0]/.test(principal.clientID)) return
  return { type: "request", id: value.id, operation: "mcp.request", input: {
    body: input.body, headers: input.headers, epoch: input.epoch,
    principal: { ownerID: principal.ownerID, deviceID: principal.deviceID, clientID: principal.clientID },
  } }
}

export function parseMcpState(raw: string): McpState | undefined {
  const value = decode(raw)
  return control(value, "mcp.state") ? { type: "mcp.state", id: value.id, enabled: value.enabled, epoch: value.epoch } : undefined
}

export function parseMcpStateAck(raw: string): McpStateAck | undefined {
  const value = decode(raw)
  return control(value, "mcp.state.ack") ? { type: "mcp.state.ack", id: value.id, enabled: value.enabled, epoch: value.epoch } : undefined
}

function control(value: unknown, type: string): value is { id: string; enabled: boolean; epoch: string } {
  return record(value) && keys(value, ["type", "id", "enabled", "epoch"]) && value.type === type &&
    identifier(value.id) && typeof value.enabled === "boolean" && identifier(value.epoch)
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function decode(raw: string): unknown {
  if (raw.length > RemoteLimits.maxClientMessageChars) return
  try { return JSON.parse(raw) } catch { return undefined }
}
