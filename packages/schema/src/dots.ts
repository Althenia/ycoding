export * as Dots from "./dots.js"

import { Option, Schema } from "effect"
import { PromptInput } from "./prompt-input.js"
import { optional } from "./schema.js"

const Identity = Schema.String.check(Schema.isNonEmpty())

export interface Target extends Schema.Schema.Type<typeof Target> {}
export const Target = Schema.Struct({
  profile: Identity,
  dotID: Identity,
  threadID: Identity,
  generation: Identity,
  label: Schema.String,
}).annotate({ identifier: "Dots.Target" })

export const State = Schema.Literals(["disconnected", "connecting", "connected", "failed"]).annotate({
  identifier: "Dots.State",
})
export type State = typeof State.Type

export const RuntimeState = Schema.Literals(["paused", "unpaused", "unknown"]).annotate({
  identifier: "Dots.RuntimeState",
})
export type RuntimeState = typeof RuntimeState.Type

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  target: Target.pipe(optional),
  state: State,
  error: Schema.String.pipe(optional),
  runtimeState: RuntimeState.pipe(optional),
}).annotate({ identifier: "Dots.Status" })

export interface Control extends Schema.Schema.Type<typeof Control> {}
export const Control = Schema.Struct({
  expectedTarget: Target,
}).annotate({ identifier: "Dots.Control" })

export interface Send extends Schema.Schema.Type<typeof Send> {}
export const Send = Schema.Struct({
  id: Identity,
  text: Schema.String,
  files: Schema.Array(PromptInput.FileAttachment).pipe(optional),
  causalMessageID: Identity.pipe(optional),
  expectedTarget: Target,
}).annotate({ identifier: "Dots.Send" })

export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}
export const Delivery = Schema.Struct({
  messageID: Identity,
  status: Schema.Literals(["accepted", "unknown"]),
  turnID: Identity.pipe(optional),
}).annotate({ identifier: "Dots.Delivery" })

export const ErrorCode = Schema.Literals([
  "feature_disabled",
  "invalid_input",
  "session_not_found",
  "profile_unavailable",
  "profile_changed",
  "authentication_failed",
  "target_unavailable",
  "target_in_use",
  "target_changed",
  "not_bound",
  "connection_unavailable",
  "attachment_invalid",
  "send_failed",
  "runtime_unknown",
  "control_failed",
]).annotate({ identifier: "Dots.ErrorCode" })
export type ErrorCode = typeof ErrorCode.Type

export interface Peer extends Schema.Schema.Type<typeof Peer> {}
export const Peer = Schema.Struct({
  origin: Schema.Literal("dots-peer"),
  profile: Identity,
  dotID: Identity,
  threadID: Identity,
  turnID: Identity.pipe(optional),
  itemID: Identity,
  causalMessageID: Identity.pipe(optional),
}).annotate({ identifier: "Dots.Peer" })

const decodePeer = Schema.decodeUnknownOption(Peer)

export const peer = (metadata: Readonly<Record<string, unknown>> | undefined) =>
  metadata === undefined ? undefined : Option.getOrUndefined(decodePeer(metadata.dots))
