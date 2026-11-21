export * as Interaction from "./interaction.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { optional, PositiveInt, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

const uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const id = uuid.pipe(Schema.brand("Interaction.ID")).annotate({ identifier: "Interaction.ID" })
export const ID = id.pipe(statics((schema: typeof id) => ({ create: () => schema.make(crypto.randomUUID()) })))
export type ID = typeof ID.Type

const generation = uuid.pipe(Schema.brand("Interaction.Generation")).annotate({ identifier: "Interaction.Generation" })
export const Generation = generation.pipe(statics((schema: typeof generation) => ({ create: () => schema.make(crypto.randomUUID()) })))
export type Generation = typeof Generation.Type

export const Revision = PositiveInt
export type Revision = typeof Revision.Type

export const Platform = Schema.Literals(["chrome", "macos"]).annotate({ identifier: "Interaction.Platform" })
export type Platform = typeof Platform.Type

const label = Schema.String.check(Schema.isMaxLength(256), Schema.isPattern(/^[^\u0000-\u001f\u007f]*$/u))
const webURL = Schema.String.check(Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[^/?#@:\s\\]+)(?::[0-9]{1,5})?(?:[/?#][^\s\\]*)?$/),
)
const origin = webURL.check(Schema.isPattern(/^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[^/?#@:\s\\]+)(?::[0-9]{1,5})?$/))
export const Pathname = Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^\/[^?#\s\\\u0000-\u001f\u007f]*$/u))
export type Pathname = typeof Pathname.Type

const chromeTarget = { id: ID, label, origin, pathname: Pathname }
export const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chrome-tab"), ...chromeTarget }),
  Schema.Struct({ kind: Schema.Literals(["chrome-owned", "chrome-isolated"]), ...chromeTarget, url: webURL }),
  Schema.Struct({ kind: Schema.Literal("macos-window"), id: ID, label, bundleID: Schema.String.check(
    Schema.isMaxLength(256), Schema.isPattern(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
  ) }),
]).annotate({ identifier: "Interaction.Target" })
export type Target = typeof Target.Type

const destructive = Schema.Literal(true).pipe(optional)
const text = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^[^\u0000-\u001f\u007f]*$/u))
const deltaY = Schema.Int.check(Schema.isGreaterThanOrEqualTo(-10_000), Schema.isLessThanOrEqualTo(10_000))
const chrome = { platform: Schema.Literal("chrome"), destructive }
const macos = { platform: Schema.Literal("macos"), destructive }
export const ChromeAction = Schema.Union([
  Schema.Struct({ ...chrome, type: Schema.Literal("click"), elementID: ID }),
  Schema.Struct({ ...chrome, type: Schema.Literal("fill"), elementID: ID, text }),
  Schema.Struct({ ...chrome, type: Schema.Literal("scroll"), deltaY }),
  Schema.Struct({ ...chrome, type: Schema.Literal("navigate"), url: webURL }),
]).annotate({ identifier: "Interaction.ChromeAction" })
export type ChromeAction = typeof ChromeAction.Type

export const MacOSAction = Schema.Union([
  Schema.Struct({ ...macos, type: Schema.Literal("press"), elementID: ID }),
  Schema.Struct({ ...macos, type: Schema.Literal("setValue"), elementID: ID, text }),
  Schema.Struct({ ...macos, type: Schema.Literal("scroll"), deltaY }),
]).annotate({ identifier: "Interaction.MacOSAction" })
export type MacOSAction = typeof MacOSAction.Type

export const Action = Schema.Union([ChromeAction, MacOSAction]).annotate({ identifier: "Interaction.Action" })
export type Action = typeof Action.Type

export const Observation = Schema.Struct({
  revision: Revision,
  pathname: Pathname.pipe(optional),
  elements: Schema.Array(Schema.Struct({ id: ID, role: label, label, editable: Schema.Boolean })).check(Schema.isMaxLength(200)),
}).annotate({ identifier: "Interaction.Observation" })
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const Refusal = Schema.Literals([
  "unsupported", "stale", "sensitive", "captcha", "policy", "permission", "target_lost", "confirmation_required", "busy",
]).annotate({ identifier: "Interaction.Refusal" })
export type Refusal = typeof Refusal.Type

export const PauseReason = Schema.Literals([
  "foreground_required", "file_chooser", "dialog", "captcha", "sensitive", "user_takeover",
]).annotate({ identifier: "Interaction.PauseReason" })
export type PauseReason = typeof PauseReason.Type

export const ActionResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("applied") }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: Refusal }),
  Schema.Struct({ outcome: Schema.Literal("uncertain") }),
  Schema.Struct({ outcome: Schema.Literal("paused"), reason: PauseReason }),
]).annotate({ identifier: "Interaction.ActionResult" })
export type ActionResult = typeof ActionResult.Type

export const ScriptMode = Schema.Literals(["script", "code"]).annotate({ identifier: "Interaction.ScriptMode" })
export type ScriptMode = typeof ScriptMode.Type

export const defaultScriptTimeoutMs = 10_000

export const ScriptRequest = Schema.Struct({
  mode: ScriptMode,
  source: Schema.String.check(Schema.isLengthBetween(1, 65_536)),
  timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60_000)).pipe(optional),
}).annotate({ identifier: "Interaction.ScriptRequest" })
export interface ScriptRequest extends Schema.Schema.Type<typeof ScriptRequest> {}

export const ConsoleEntry = Schema.Struct({
  level: Schema.Literals(["log", "info", "warn", "error", "debug"]),
  text: Schema.String.check(Schema.isMaxLength(2048)),
}).annotate({ identifier: "Interaction.ConsoleEntry" })
export interface ConsoleEntry extends Schema.Schema.Type<typeof ConsoleEntry> {}

export const ScriptError = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(128)),
  message: Schema.String.check(Schema.isMaxLength(2048)),
  stack: Schema.String.check(Schema.isMaxLength(8192)).pipe(optional),
}).annotate({ identifier: "Interaction.ScriptError" })
export interface ScriptError extends Schema.Schema.Type<typeof ScriptError> {}

const utf8 = new TextEncoder()
const scriptValue = Schema.Json.check(Schema.makeFilter((value: typeof Schema.Json.Type) => utf8.encode(JSON.stringify(value)).byteLength <= 65_536, {
  expected: "a JSON value of at most 65536 serialized bytes",
}))
const logs = {
  logs: Schema.Array(ConsoleEntry).check(Schema.isMaxLength(200)),
  logsTruncated: Schema.Literal(true).pipe(optional),
}

export const ScriptResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("completed"), value: scriptValue.pipe(optional), valueTruncated: Schema.Literal(true).pipe(optional), ...logs }),
  Schema.Struct({ outcome: Schema.Literal("error"), error: ScriptError, ...logs }),
  Schema.Struct({ outcome: Schema.Literal("timeout"), ...logs }),
  Schema.Struct({ outcome: Schema.Literal("stopped"), ...logs }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: Refusal }),
  Schema.Struct({ outcome: Schema.Literal("paused"), reason: PauseReason }),
]).annotate({ identifier: "Interaction.ScriptResult" })
export type ScriptResult = typeof ScriptResult.Type

const previewBytes = 160 * 1024
const previewBase64 = 4 * Math.ceil(previewBytes / 3)
const excessBase64Digits = Math.ceil(previewBytes * 4 / 3) + 1

export const Frame = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  base64: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(previewBase64),
    Schema.isPattern(new RegExp(`^(?![A-Za-z0-9+/]{${excessBase64Digits}})(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\\s\\S])`))),
  width: PositiveInt.check(Schema.isLessThanOrEqualTo(960)),
  height: PositiveInt.check(Schema.isLessThanOrEqualTo(720)),
}).annotate({ identifier: "Interaction.Frame" })
export interface Frame extends Schema.Schema.Type<typeof Frame> {}

export const StopReason = Schema.Literals([
  "stopped", "rejected", "expired", "disconnected", "target_lost", "uncertain", "permission", "shutdown",
]).annotate({ identifier: "Interaction.StopReason" })
export type StopReason = typeof StopReason.Type

const selection = { platform: Platform, generation: Generation }
export const Status = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unavailable") }),
  Schema.Struct({ state: Schema.Literal("pending"), ...selection }),
  Schema.Struct({ state: Schema.Literal("active"), ...selection, label }),
  Schema.Struct({ state: Schema.Literal("paused"), ...selection, label, reason: PauseReason }),
  Schema.Struct({ state: Schema.Literal("stopped"), ...selection, reason: StopReason,
    cleanup: Schema.Literals(["pending", "complete", "failed"]),
  }),
]).annotate({ identifier: "Interaction.Status" })
export type Status = typeof Status.Type

export const Preview = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unavailable"), generation: Generation }),
  Schema.Struct({ state: Schema.Literal("ready"), generation: Generation, frame: Frame }),
]).annotate({ identifier: "Interaction.Preview" })
export type Preview = typeof Preview.Type

export const Capture = Schema.Struct({
  generation: Generation,
  frame: Frame,
  title: label.pipe(optional),
  url: webURL.pipe(optional),
}).annotate({ identifier: "Interaction.Capture" })
export interface Capture extends Schema.Schema.Type<typeof Capture> {}

export const Request = Schema.Union([
  Schema.Struct({ platform: Schema.Literal("macos"), mode: Schema.Never.pipe(optional), url: Schema.Never.pipe(optional) }),
  Schema.Struct({ platform: Schema.Literal("chrome"), mode: Schema.Literal("tab").pipe(optional), url: Schema.Never.pipe(optional) }),
  Schema.Struct({ platform: Schema.Literal("chrome"), mode: Schema.Literals(["owned", "isolated"]), url: webURL }),
]).annotate({ identifier: "Interaction.Request" })
export type Request = typeof Request.Type

export const Fence = Schema.Struct({ generation: Generation }).annotate({ identifier: "Interaction.Fence" })
export interface Fence extends Schema.Schema.Type<typeof Fence> {}

export const Changed = Event.ephemeral({
  type: "session.interaction.changed",
  schema: { sessionID: SessionID, generation: Generation },
})
