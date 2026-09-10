import { Schema } from "effect"

export interface Capability {
  readonly platform: string
  readonly application: string
  readonly identity: {
    readonly kind: string
    readonly value: string
  }
  readonly operations: ReadonlyArray<string>
}

export interface Status {
  readonly platform: string
  readonly state: "supported" | "unsupported"
  readonly capabilities: ReadonlyArray<Capability>
}

export type NativeSuccess<Action extends string = string> = {
  readonly status: "ok"
  readonly action: Action
  readonly revision: string
}

export class NativeError extends Schema.TaggedErrorClass<NativeError>()("Computer.NativeError", {
  code: Schema.Literals([
    "unsupported_platform",
    "helper_unavailable",
    "invalid_request",
    "invalid_response",
    "app_not_running",
    "automation_denied",
    "target_not_found",
    "stale_revision",
    "target_conflict",
    "native_failure",
    "unknown_outcome",
  ]),
  message: Schema.String,
  outcome: Schema.Literals(["not_started", "unknown"]).pipe(Schema.optional),
}) {}
