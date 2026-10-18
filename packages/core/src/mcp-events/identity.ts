export * as McpEventsIdentity from "./identity"

import { createHash } from "node:crypto"
import type { McpEvents } from "@ycoding-ai/schema/mcp-events"

export const DEFAULT_TTL_MS = 86_400_000
export const MIN_TTL_MS = 60_000
export const MAX_TTL_MS = 7 * 86_400_000

export interface NormalizedArguments {
  readonly session_id: string
  readonly include_descendants: boolean
}

export function normalizeArguments(args: McpEvents.Arguments): NormalizedArguments {
  return { session_id: args.session_id, include_descendants: args.include_descendants === true }
}

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item)).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
    .join(",")}}`
}

export function subscriptionIdentity(
  principal: McpEvents.Principal,
  url: string,
  name: McpEvents.Name,
  args: NormalizedArguments,
) {
  const hash = createHash("sha256")
    .update(canonicalJSON({
      principal: {
        ownerID: principal.ownerID,
        deviceID: principal.deviceID,
        clientID: principal.clientID,
        grantID: principal.grantID,
        epoch: principal.epoch,
      },
      url,
      name,
      arguments: args,
    }))
    .digest("hex")
  return { id: `sub_${hash.slice(0, 32)}`, hash, args }
}

export function grantTtl(input: { ttlMs?: number | null; grantExpiresAt: number; now: number }): number {
  const requested = input.ttlMs === undefined || input.ttlMs === null ? DEFAULT_TTL_MS : input.ttlMs
  const clamped = Math.min(Math.max(requested, MIN_TTL_MS), MAX_TTL_MS)
  return Math.min(input.now + clamped, input.grantExpiresAt)
}
