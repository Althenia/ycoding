export * as IsolatedBrowser from "./isolated-browser.js"

import { Effect, Schema, SchemaGetter } from "effect"
import { Browser } from "./browser.js"
import { ascending } from "./identifier.js"
import { optional, statics } from "./schema.js"

const utf8 = new TextEncoder()
const safeURL = SchemaGetter.checkEffect<string>((input) =>
  Effect.succeed(isSafeURL(input) ? undefined : "a credential-free HTTP or HTTPS URL"),
)
const BoundedURL = Schema.String.check(
  Schema.isMaxLength(8 * 1024),
  Schema.makeFilter<string>((input) => utf8.encode(input).byteLength <= 8 * 1024, {
    expected: "a UTF-8 URL of at most 8192 bytes",
    meta: { _tag: "isMaxLength", maxLength: 8 * 1024 },
    arbitrary: { constraint: { maxLength: 8 * 1024 } },
  }),
)
const SafeURL = BoundedURL.check(
  Schema.makeFilter<string>((input) => isSafeURL(input), {
    expected: "a credential-free HTTP or HTTPS URL",
  }),
)
const SafeURLPayload = BoundedURL.pipe(
  Schema.decode({
    decode: safeURL,
    encode: safeURL,
  }),
)

function isSafeURL(input: string) {
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
}

const InstanceIDSchema = Schema.String.check(Schema.isStartsWith("ibrowser_")).pipe(
  Schema.brand("IsolatedBrowser.InstanceID"),
)
export const InstanceID = InstanceIDSchema.pipe(
  statics((schema: typeof InstanceIDSchema) => ({ create: () => schema.make(`ibrowser_${ascending()}`) })),
)
export type InstanceID = typeof InstanceID.Type

export const State = Schema.Literals(["unavailable", "starting", "ready", "paused", "stopped"])
export type State = typeof State.Type

export const Status = Schema.Struct({
  mode: Schema.Literal("isolated"),
  state: State,
  reason: Schema.String.check(Schema.isMaxLength(1024)).pipe(optional),
  instanceID: InstanceID.pipe(optional),
  tab: Browser.Tab.pipe(optional),
}).annotate({ identifier: "IsolatedBrowser.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

export const StartInput = Schema.Struct({ url: SafeURL }).annotate({ identifier: "IsolatedBrowser.StartInput" })
export interface StartInput extends Schema.Schema.Type<typeof StartInput> {}

export const StartPayload = Schema.Struct({ url: SafeURLPayload }).annotate({
  identifier: "IsolatedBrowser.StartPayload",
})
export interface StartPayload extends Schema.Schema.Type<typeof StartPayload> {}

export const ObserveInput = Schema.Struct({
  ...Browser.ObserveInput.fields,
  instanceID: InstanceID,
}).annotate({ identifier: "IsolatedBrowser.ObserveInput" })
export interface ObserveInput extends Schema.Schema.Type<typeof ObserveInput> {}

export const ActionInput = Schema.Struct({
  ...Browser.ActionInput.fields,
  instanceID: InstanceID,
}).annotate({ identifier: "IsolatedBrowser.ActionInput" })
export interface ActionInput extends Schema.Schema.Type<typeof ActionInput> {}

export const Observation = Schema.Struct({
  ...Browser.Observation.fields,
  mode: Schema.Literal("isolated"),
  instanceID: InstanceID,
}).annotate({ identifier: "IsolatedBrowser.Observation" })
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const ActionResult = Schema.Struct({
  mode: Schema.Literal("isolated"),
  instanceID: InstanceID,
  callID: Browser.CallID,
  tab: Browser.Tab,
  status: Schema.Literals(["completed", "rejected", "uncertain"]),
  message: Schema.String.check(Schema.isMaxLength(1024)).pipe(optional),
  capture: Browser.CaptureOutput.pipe(optional),
}).annotate({ identifier: "IsolatedBrowser.ActionResult" })
export interface ActionResult extends Schema.Schema.Type<typeof ActionResult> {}

export const ControlInput = Browser.ControlInput.annotate({ identifier: "IsolatedBrowser.ControlInput" })
export interface ControlInput extends Schema.Schema.Type<typeof ControlInput> {}
