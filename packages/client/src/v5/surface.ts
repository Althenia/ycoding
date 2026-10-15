import { create, ScopeSchema } from "@ycoding-ai/protocol/v5"

export type Binding = { method: string; operationID: number; resultPath?: readonly string[]; empty?: boolean }
export function globalScope() {
  return create(ScopeSchema, { target: { case: "global", value: {} } })
}
