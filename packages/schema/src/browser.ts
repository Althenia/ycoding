export * as Browser from "./browser.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema.js"
import { ascending } from "./identifier.js"

export const MAX_OBSERVATION_ELEMENTS = 200
export const MAX_TYPE_BYTES = 8 * 1024
export const MAX_CAPTURE_BYTES = 1024 * 1024
export const MAX_TITLE_LENGTH = 512
export const MAX_NAME_LENGTH = 1024

const utf8 = new TextEncoder()
const boundedUtf8 = (bytes: number) =>
  Schema.String.check(
    Schema.isMaxLength(bytes),
    Schema.makeFilter<string>((input) => utf8.encode(input).byteLength <= bytes, {
      expected: `a UTF-8 string of at most ${bytes} bytes`,
      meta: { _tag: "isMaxLength", maxLength: bytes },
      arbitrary: { constraint: { maxLength: bytes } },
    }),
  )

const TabIDSchema = Schema.String.check(Schema.isStartsWith("btab_")).pipe(Schema.brand("Browser.TabID"))
export const TabID = TabIDSchema.pipe(
  statics((schema: typeof TabIDSchema) => ({ create: () => schema.make(`btab_${ascending()}`) })),
)
export type TabID = typeof TabID.Type

export const Generation = PositiveInt
export type Generation = typeof Generation.Type

export const DocumentGeneration = PositiveInt
export type DocumentGeneration = typeof DocumentGeneration.Type

export const ObservationRevision = NonNegativeInt
export type ObservationRevision = typeof ObservationRevision.Type

export const CallID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export type CallID = typeof CallID.Type

const Origin = Schema.String.check(Schema.isPattern(/^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[^/?#@:]+)(?::[0-9]+)?$/))

const SafePath = Schema.String.check(Schema.isPattern(/^\/[^?#]*$/))

export const Page = Schema.Struct({ origin: Origin, path: SafePath }).annotate({ identifier: "Browser.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

export const TabStatus = Schema.Literals(["shared", "paused", "unavailable"])
export type TabStatus = typeof TabStatus.Type

export const PauseReason = Schema.Literals(["user_active", "requested", "uncertain", "disconnected"])
export type PauseReason = typeof PauseReason.Type

export const Tab = Schema.Struct({
  id: TabID,
  sessionID: SessionID,
  title: Schema.String.check(Schema.isMaxLength(MAX_TITLE_LENGTH)),
  page: Page,
  status: TabStatus,
  generation: Generation,
  documentGeneration: DocumentGeneration,
  observationRevision: ObservationRevision,
  pauseReason: PauseReason.pipe(optional),
  uncertainCallID: CallID.pipe(optional),
}).annotate({ identifier: "Browser.Tab" })
export interface Tab extends Schema.Schema.Type<typeof Tab> {}

export const BridgeState = Schema.Literals(["unavailable", "pairing", "connected", "paused"])
export type BridgeState = typeof BridgeState.Type

export const Status = Schema.Struct({
  state: BridgeState,
  generation: Generation.pipe(optional),
  pairingExpiresAt: NonNegativeInt.pipe(optional),
  extensionID: Schema.String.check(Schema.isPattern(/^[a-p]{32}$/)).pipe(optional),
  pendingCallID: CallID.pipe(optional),
}).annotate({ identifier: "Browser.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

export const Pairing = Schema.Struct({
  secret: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128)),
  expiresAt: NonNegativeInt,
}).annotate({ identifier: "Browser.Pairing" })
export interface Pairing extends Schema.Schema.Type<typeof Pairing> {}

export const Element = Schema.Struct({
  ref: Schema.String.check(Schema.isPattern(/^b[1-9][0-9]{0,3}$/)),
  role: Schema.String.check(Schema.isMaxLength(64)),
  name: Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH)),
  description: Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH)).pipe(optional),
  disabled: Schema.Boolean.pipe(optional),
  destination: Page.pipe(optional),
}).annotate({ identifier: "Browser.Element" })
export interface Element extends Schema.Schema.Type<typeof Element> {}

export const Observation = Schema.Struct({
  tabID: TabID,
  generation: Generation,
  documentGeneration: DocumentGeneration,
  revision: ObservationRevision,
  title: Schema.String.check(Schema.isMaxLength(MAX_TITLE_LENGTH)),
  page: Page,
  elements: Schema.Array(Element).check(Schema.isMaxLength(MAX_OBSERVATION_ELEMENTS)),
  truncated: Schema.Boolean,
}).annotate({ identifier: "Browser.Observation" })
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const Navigate = Schema.Struct({ type: Schema.Literal("navigate"), url: boundedUtf8(8 * 1024) })
export const Click = Schema.Struct({ type: Schema.Literal("click"), ref: Element.fields.ref })
export const Type = Schema.Struct({
  type: Schema.Literal("type"),
  ref: Element.fields.ref,
  text: boundedUtf8(MAX_TYPE_BYTES),
})
export const Scroll = Schema.Struct({
  type: Schema.Literal("scroll"),
  deltaY: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-10_000), Schema.isLessThanOrEqualTo(10_000)),
})
export const Capture = Schema.Struct({ type: Schema.Literal("capture") })
export const Action = Schema.Union([Navigate, Click, Type, Scroll, Capture])
export type Action = typeof Action.Type

export const ActionInput = Schema.Struct({
  sessionID: SessionID,
  tabID: TabID,
  generation: Generation,
  documentGeneration: DocumentGeneration,
  observationRevision: ObservationRevision,
  callID: CallID,
  action: Action,
}).annotate({ identifier: "Browser.ActionInput" })
export interface ActionInput extends Schema.Schema.Type<typeof ActionInput> {}

export const ObserveInput = Schema.Struct({
  sessionID: SessionID,
  tabID: TabID,
  generation: Generation,
  callID: CallID,
}).annotate({ identifier: "Browser.ObserveInput" })
export interface ObserveInput extends Schema.Schema.Type<typeof ObserveInput> {}

const CaptureData = Schema.String.check(
  Schema.isMaxLength(Math.ceil((MAX_CAPTURE_BYTES * 4) / 3) + 8),
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
)
export const CaptureOutput = Schema.Struct({
  mediaType: Schema.Literal("image/png"),
  data: CaptureData,
  bytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_CAPTURE_BYTES)),
}).annotate({ identifier: "Browser.CaptureOutput" })
export interface CaptureOutput extends Schema.Schema.Type<typeof CaptureOutput> {}

export const ActionResult = Schema.Struct({
  callID: CallID,
  tab: Tab,
  status: Schema.Literals(["completed", "paused", "rejected", "uncertain"]),
  message: Schema.String.check(Schema.isMaxLength(1024)).pipe(optional),
  capture: CaptureOutput.pipe(optional),
}).annotate({ identifier: "Browser.ActionResult" })
export interface ActionResult extends Schema.Schema.Type<typeof ActionResult> {}

export const ControlInput = Schema.Struct({ action: Schema.Literals(["pause", "resume"]) }).annotate({
  identifier: "Browser.ControlInput",
})
export interface ControlInput extends Schema.Schema.Type<typeof ControlInput> {}
