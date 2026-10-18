export * as RemoteMcpEvents from "./mcp-events.ts"

import type { McpPrincipal } from "./mcp.ts"

export type AuthorizationRejection = "unauthorized" | "forbidden" | "not_found" | "unavailable"

export type AuthorizationRequest =
  | { readonly action: "capabilities" }
  | { readonly action: "resolve"; readonly requestID: string; readonly principal: McpPrincipal; readonly epoch: string }
  | { readonly action: "check"; readonly grantID: string; readonly principal: McpPrincipal; readonly epoch: string }

export type AuthorizationResponse =
  | { readonly action: "capabilities"; readonly supported: true }
  | { readonly action: "resolve" | "check"; readonly authorized: true; readonly grantID: string; readonly expiresAt: number }
  | { readonly action: "resolve" | "check"; readonly authorized: false; readonly reason: AuthorizationRejection }

const rejections: readonly string[] = ["unauthorized", "forbidden", "not_found", "unavailable"]

export function parseAuthorizationRequest(value: unknown): AuthorizationRequest | undefined {
  if (!record(value)) return
  if (value.action === "capabilities") return keys(value, ["action"]) ? { action: "capabilities" } : undefined
  if (value.action !== "resolve" && value.action !== "check") return
  const idField = value.action === "resolve" ? "requestID" : "grantID"
  if (!keys(value, ["action", idField, "principal", "epoch"])) return
  const id = value[idField]
  const principal = parsePrincipal(value.principal)
  if (!identifier(id) || principal === undefined || !identifier(value.epoch)) return
  return value.action === "resolve"
    ? { action: "resolve", requestID: id, principal, epoch: value.epoch }
    : { action: "check", grantID: id, principal, epoch: value.epoch }
}

export function parseAuthorizationResponse(value: unknown): AuthorizationResponse | undefined {
  if (!record(value)) return
  if (value.action === "capabilities")
    return keys(value, ["action", "supported"]) && value.supported === true ? { action: "capabilities", supported: true } : undefined
  if (value.action !== "resolve" && value.action !== "check") return
  if (value.authorized === true) {
    if (!keys(value, ["action", "authorized", "grantID", "expiresAt"])) return
    if (!identifier(value.grantID) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return
    return { action: value.action, authorized: true, grantID: value.grantID, expiresAt: value.expiresAt }
  }
  if (value.authorized !== false) return
  if (!keys(value, ["action", "authorized", "reason"])) return
  if (typeof value.reason !== "string" || !rejections.includes(value.reason)) return
  return { action: value.action, authorized: false, reason: value.reason as AuthorizationRejection }
}

function parsePrincipal(value: unknown): McpPrincipal | undefined {
  if (!record(value) || !keys(value, ["ownerID", "deviceID", "clientID"])) return
  if (!identifier(value.ownerID) || !identifier(value.deviceID)) return
  if (typeof value.clientID !== "string" || value.clientID.length === 0 || value.clientID.length > 2048 || /[\r\n\0]/.test(value.clientID)) return
  return { ownerID: value.ownerID, deviceID: value.deviceID, clientID: value.clientID }
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
