import { create, ScopeSchema } from "@ycoding-ai/protocol/v5"
import { V5ClientError } from "./error.js"

export type Binding = { method: string; operationID: number; resultPath?: readonly string[]; empty?: boolean }
export function globalScope() {
  return create(ScopeSchema, { target: { case: "global", value: {} } })
}

export function requireSupportedForm(binding: Binding, input: unknown) {
  if (
    (binding.method === "form.reply" || binding.method === "form.cancel") &&
    typeof input === "object" &&
    input !== null &&
    "sessionID" in input &&
    input.sessionID === "global"
  ) {
    throw new V5ClientError("unsupported", binding.method, "Global Form Location is unsupported until contract")
  }
}
