export * as BrowserProtocol from "./protocol"

import { Browser } from "@ycoding-ai/schema/browser"
import { Option, Schema } from "effect"

export const VERSION = 3
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const MAX_SHARED_TABS = 8

const ExtensionID = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/))
const Pair = Schema.Struct({
  type: Schema.Literal("pair"),
  version: Schema.Literal(VERSION),
  extensionID: ExtensionID,
  secret: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128)),
})
const Authenticate = Schema.Struct({
  type: Schema.Literal("authenticate"),
  version: Schema.Literal(VERSION),
  extensionID: ExtensionID,
  serverID: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128)),
  credential: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128)),
})
const Shared = Schema.Struct({
  type: Schema.Literal("shared"),
  mode: Schema.Literal("profile"),
  tabID: Browser.TabID,
  title: Schema.String,
  url: Schema.String,
  documentGeneration: Browser.DocumentGeneration,
  active: Schema.Boolean,
})
const Revoked = Schema.Struct({ type: Schema.Literal("revoked"), tabID: Browser.TabID })
const ProfileAccess = Schema.Struct({ type: Schema.Literal("profile_access"), enabled: Schema.Boolean })
const Takeover = Schema.Struct({
  type: Schema.Literal("takeover"),
  tabID: Browser.TabID,
  documentGeneration: Browser.DocumentGeneration,
  active: Schema.Boolean,
})
const Updated = Schema.Struct({
  type: Schema.Literal("updated"),
  tabID: Browser.TabID,
  title: Schema.String,
  url: Schema.String,
  documentGeneration: Browser.DocumentGeneration,
})
const Observation = Schema.Struct({
  type: Schema.Literal("observation"),
  callID: Browser.CallID,
  tabID: Browser.TabID,
  generation: Browser.Generation,
  documentGeneration: Browser.DocumentGeneration,
  revision: Browser.ObservationRevision,
  title: Schema.String,
  url: Schema.String,
  elements: Schema.Array(
    Schema.Struct({
      ref: Browser.Element.fields.ref,
      role: Schema.String,
      name: Schema.String,
      description: Schema.String.pipe(Schema.optional),
      disabled: Schema.Boolean.pipe(Schema.optional),
      destination: Schema.String.pipe(Schema.optional),
    }),
  ),
  truncated: Schema.Boolean,
})
const Result = Schema.Struct({
  type: Schema.Literal("result"),
  callID: Browser.CallID,
  tabID: Browser.TabID,
  generation: Browser.Generation,
  documentGeneration: Browser.DocumentGeneration,
  observationRevision: Browser.ObservationRevision,
  status: Schema.Literals(["completed", "paused"]),
  title: Schema.String,
  url: Schema.String,
  message: Schema.String.pipe(Schema.optional),
  capture: Browser.CaptureOutput.pipe(Schema.optional),
  groupID: Browser.ActionResult.fields.groupID.pipe(Schema.optional),
})
const Failed = Schema.Struct({
  type: Schema.Literal("error"),
  callID: Browser.CallID,
  tabID: Browser.TabID,
  generation: Browser.Generation,
  dispatched: Schema.Boolean,
  message: Schema.String.check(Schema.isMaxLength(1024)),
})
const Pong = Schema.Struct({ type: Schema.Literal("pong") })
const Forget = Schema.Struct({ type: Schema.Literal("forget") })
const Opened = Schema.Struct({
  type: Schema.Literal("opened"), callID: Browser.CallID, tabID: Browser.TabID,
  generation: Browser.Generation, documentGeneration: Browser.DocumentGeneration,
  title: Schema.String, url: Schema.String, active: Schema.Boolean,
})
const Closed = Schema.Struct({
  type: Schema.Literal("closed"), callID: Browser.CallID, tabID: Browser.TabID, generation: Browser.Generation,
})

export const ClientMessage = Schema.Union([
  Pair,
  Authenticate,
  Shared,
  Revoked,
  ProfileAccess,
  Takeover,
  Updated,
  Observation,
  Result,
  Failed,
  Pong,
  Forget,
  Opened,
  Closed,
])
export type ClientMessage = typeof ClientMessage.Type
export type Handshake = typeof Pair.Type | typeof Authenticate.Type

export type ServerMessage =
  | {
      readonly type: "paired"
      readonly version: 3
      readonly generation: number
      readonly serverID: string
      readonly credential?: string
    }
  | { readonly type: "observe"; readonly callID: string; readonly tabID: Browser.TabID; readonly generation: number }
  | {
      readonly type: "action"
      readonly callID: string
      readonly tabID: Browser.TabID
      readonly generation: number
      readonly documentGeneration: number
      readonly observationRevision: number
      readonly allowedOrigins: ReadonlyArray<string>
      readonly action: Browser.Action
    }
  | { readonly type: "control"; readonly action: "pause" | "resume" | "stop" | "forget" }
  | { readonly type: "ping" }
  | { readonly type: "open"; readonly callID: string; readonly tabID: Browser.TabID; readonly generation: number; readonly url: string }
  | { readonly type: "close"; readonly callID: string; readonly tabID: Browser.TabID; readonly generation: number }
  | { readonly type: "release"; readonly tabID: Browser.TabID; readonly generation: number }
  | { readonly type: "error"; readonly message: string }

const decode = Schema.decodeUnknownOption(ClientMessage)
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function decodeClient(frame: string | Uint8Array | ArrayBuffer) {
  const bytes =
    typeof frame === "string" ? encoder.encode(frame) : frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame
  if (bytes.byteLength > MAX_FRAME_BYTES) return undefined
  try {
    const json = typeof frame === "string" ? frame : decoder.decode(bytes)
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(json).pipe(Option.flatMap(decode)),
    )
  } catch {
    return undefined
  }
}

export function encodeServer(message: ServerMessage) {
  return JSON.stringify(message)
}

export function extensionIDFromOrigin(origin: string | undefined) {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin ?? "")
  return match?.[1]
}
