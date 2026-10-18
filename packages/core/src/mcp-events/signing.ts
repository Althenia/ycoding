export * as McpEventsSigning from "./signing"

import { createHmac } from "node:crypto"

export function sign(input: {
  readonly id: string
  readonly timestampSeconds: number
  readonly body: string
  readonly secrets: ReadonlyArray<Uint8Array>
}): string {
  return input.secrets
    .map((key) => "v1," + createHmac("sha256", key).update(`${input.id}.${input.timestampSeconds}.${input.body}`).digest("base64"))
    .join(" ")
}
