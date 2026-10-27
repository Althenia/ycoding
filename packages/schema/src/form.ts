export * as Form from "./form.js"

import { Schema } from "effect"
import { Coordination } from "./coordination.js"
import { McpEvents } from "./mcp-events.js"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { NonNegativeInt, optional, PositiveInt, statics } from "./schema.js"
import { SessionReviewID } from "./session-review-id.js"
import { SessionID } from "./session-id.js"

const IDSchema = Schema.String.check(Schema.isStartsWith("frm_")).pipe(Schema.brand("Form.ID"))

export const ID = IDSchema.pipe(
  statics((schema: typeof IDSchema) => ({ create: (id?: string) => schema.make(id ?? "frm_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Metadata = Schema.Record(Schema.String, Schema.Unknown).annotate({ identifier: "Form.Metadata" })
export type Metadata = typeof Metadata.Type

export const Option = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  description: Schema.String.pipe(optional),
}).annotate({ identifier: "Form.Option" })
export interface Option extends Schema.Schema.Type<typeof Option> {}

export const OptionGrade = Schema.Struct({
  choice: Schema.String,
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  evidence: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)),
}).annotate({ identifier: "Form.OptionGrade" })
export interface OptionGrade extends Schema.Schema.Type<typeof OptionGrade> {}

export const FieldAssessment = Schema.Struct({
  key: Schema.String,
  status: Schema.Literals(["pending", "assessed", "unavailable", "not_assessed"]),
  reason: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)),
  grades: Schema.Array(OptionGrade).pipe(optional),
  recommendation: Schema.Array(Schema.String).pipe(optional),
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(optional),
}).annotate({ identifier: "Form.FieldAssessment" })
export interface FieldAssessment extends Schema.Schema.Type<typeof FieldAssessment> {}

export const Assessment = Schema.Struct({
  mode: Schema.Literals(["manual", "auto", "yolo"]),
  sourceSessionID: Schema.String,
  fields: Schema.Array(FieldAssessment),
}).annotate({ identifier: "Form.Assessment" })
export interface Assessment extends Schema.Schema.Type<typeof Assessment> {}

// One visibility condition on a field. A field's `when` is a list of conditions that must all
// hold (AND) against the current answers for the field to be active. Semantics:
// - `value` must match the referenced field's type; against a multiselect answer, `eq` means
//   "selection includes value" and `neq` means "selection does not include value".
// - An unanswered referenced field makes the condition false for both ops.
// - `key` must reference a field defined earlier in the form's field list.
// Inactive fields are neither required nor answerable.
export const When = Schema.Struct({
  key: Schema.String,
  op: Schema.Literals(["eq", "neq"]),
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
}).annotate({ identifier: "Form.When" })
export interface When extends Schema.Schema.Type<typeof When> {}

const FieldBase = {
  key: Schema.String,
  title: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  required: Schema.Boolean.pipe(optional),
  when: Schema.Array(When).pipe(optional),
}

export const StringField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literal("string"),
  format: Schema.Literals(["email", "uri", "date", "date-time"]).pipe(optional),
  minLength: NonNegativeInt.pipe(optional),
  maxLength: NonNegativeInt.pipe(optional),
  pattern: Schema.String.pipe(optional),
  placeholder: Schema.String.pipe(optional),
  default: Schema.String.pipe(optional),
  options: Schema.Array(Option).pipe(optional),
  custom: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Form.StringField" })
export interface StringField extends Schema.Schema.Type<typeof StringField> {}

export const NumberField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literal("number"),
  minimum: Schema.Finite.pipe(optional),
  maximum: Schema.Finite.pipe(optional),
  default: Schema.Finite.pipe(optional),
}).annotate({ identifier: "Form.NumberField" })
export interface NumberField extends Schema.Schema.Type<typeof NumberField> {}

export const IntegerField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literal("integer"),
  minimum: Schema.Finite.pipe(optional),
  maximum: Schema.Finite.pipe(optional),
  default: Schema.Finite.pipe(optional),
}).annotate({ identifier: "Form.IntegerField" })
export interface IntegerField extends Schema.Schema.Type<typeof IntegerField> {}

export const BooleanField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literal("boolean"),
  default: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Form.BooleanField" })
export interface BooleanField extends Schema.Schema.Type<typeof BooleanField> {}

export const MultiselectField = Schema.Struct({
  ...FieldBase,
  type: Schema.Literal("multiselect"),
  options: Schema.Array(Option),
  minItems: NonNegativeInt.pipe(optional),
  maxItems: NonNegativeInt.pipe(optional),
  custom: Schema.Boolean.pipe(optional),
  default: Schema.Array(Schema.String).pipe(optional),
}).annotate({ identifier: "Form.MultiselectField" })
export interface MultiselectField extends Schema.Schema.Type<typeof MultiselectField> {}

export const ExternalField = Schema.Struct({
  key: Schema.String,
  type: Schema.Literal("external"),
  url: Schema.String,
  title: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
}).annotate({ identifier: "Form.ExternalField" })
export interface ExternalField extends Schema.Schema.Type<typeof ExternalField> {}

export const Field = Schema.Union([
  StringField,
  NumberField,
  IntegerField,
  BooleanField,
  MultiselectField,
  ExternalField,
]).pipe(Schema.toTaggedUnion("type"), Schema.annotate({ identifier: "Form.Field" }))
export type Field = StringField | NumberField | IntegerField | BooleanField | MultiselectField | ExternalField

export const Fields = Schema.NonEmptyArray(Field).annotate({ identifier: "Form.Fields" })
export type Fields = typeof Fields.Type

const InfoBase = {
  id: ID,
  // This should be typed as SessionID. It is a plain string only because MCP elicitation
  // temporarily needs the `"global"` sentinel owner, which is not a real session. Once
  // elicitations can be attributed to real sessions, revert this to SessionID. Do not rely
  // on non-session owners anywhere else.
  sessionID: Schema.String,
  title: Schema.String,
  metadata: Metadata.pipe(optional),
}

export const Info = Schema.Struct({
  ...InfoBase,
  fields: Fields,
  coordinationEscalation: Coordination.Escalation.pipe(optional),
  assessment: Assessment.pipe(optional),
}).annotate({ identifier: "Form.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Value = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]).annotate(
  {
    identifier: "Form.Value",
  },
)
export type Value = typeof Value.Type

export const Answer = Schema.Record(Schema.String, Value).annotate({ identifier: "Form.Answer" })
export type Answer = typeof Answer.Type

export const State = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("answered"), answer: Answer }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({ status: Schema.Literal("timed_out"), seconds: PositiveInt }),
  Schema.Struct({ status: Schema.Literal("deferred"), itemID: SessionReviewID }),
])
  .pipe(Schema.toTaggedUnion("status"))
  .annotate({ identifier: "Form.State" })
export type State = typeof State.Type

export const Reply = Schema.Struct({
  answer: Answer,
}).annotate({ identifier: "Form.Reply" })
export interface Reply extends Schema.Schema.Type<typeof Reply> {}

export const DelegatedReplySource = Schema.Struct({
  kind: Schema.Literal("dots-delegation"),
  anchorSessionID: SessionID,
  delegationID: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  revision: PositiveInt,
  exchangeID: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
}).annotate({ identifier: "Form.DelegatedReplySource" })
export interface DelegatedReplySource extends Schema.Schema.Type<typeof DelegatedReplySource> {}

export const DotsClientReplySource = Schema.Struct({
  kind: Schema.Literal("dots-client"),
  anchorSessionID: SessionID,
  bindingID: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  delegationID: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  revision: PositiveInt,
  exchangeID: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  principal: McpEvents.Principal,
}).annotate({ identifier: "Form.DotsClientReplySource" })
export interface DotsClientReplySource extends Schema.Schema.Type<typeof DotsClientReplySource> {}

export const NativeReplySource = Schema.Struct({
  kind: Schema.Literal("dots-native"),
  profile: Schema.String.check(Schema.isNonEmpty()),
  credentialID: Schema.String.check(Schema.isNonEmpty()),
  accountID: Schema.String.check(Schema.isNonEmpty()),
  accountGeneration: NonNegativeInt,
  environmentID: Schema.String.check(Schema.isNonEmpty()),
  connectionID: Schema.String.check(Schema.isNonEmpty()),
  clientID: Schema.String.check(Schema.isNonEmpty()),
  streamID: Schema.String.check(Schema.isNonEmpty()),
  rootSessionID: SessionID,
  accessRevision: NonNegativeInt,
  requestID: Schema.String.check(Schema.isNonEmpty()),
}).annotate({ identifier: "Form.NativeReplySource" })
export interface NativeReplySource extends Schema.Schema.Type<typeof NativeReplySource> {}

export const ClientReplySource = Schema.Union([DotsClientReplySource, NativeReplySource]).annotate({ identifier: "Form.ClientReplySource" })
export type ClientReplySource = typeof ClientReplySource.Type

export const ExternalReplySource = Schema.Union([DelegatedReplySource, ClientReplySource]).annotate({ identifier: "Form.ExternalReplySource" })
export type ExternalReplySource = typeof ExternalReplySource.Type

export const ReplySource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("coordinator"),
    coordinatorSessionID: Schema.String,
    groupID: Schema.String.pipe(optional),
    via: Schema.Literals(["auto-answer", "yolo", "coordination"]).pipe(optional),
    confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(optional),
    rationale: Schema.String.check(Schema.isMaxLength(500), Schema.isPattern(/\S/)).pipe(optional),
  }),
  ExternalReplySource,
]).annotate({ identifier: "Form.ReplySource" })
export type ReplySource = typeof ReplySource.Type

const Created = ephemeral({ type: "form.created", schema: { form: Info } })
const Replied = ephemeral({
  type: "form.replied",
  schema: { id: ID, sessionID: Schema.String, answer: Answer, source: ReplySource.pipe(optional) },
})
const Cancelled = ephemeral({ type: "form.cancelled", schema: { id: ID, sessionID: Schema.String } })
const TimedOut = ephemeral({ type: "form.timed_out", schema: { id: ID, sessionID: Schema.String } })
const Deferred = ephemeral({
  type: "form.deferred",
  schema: { id: ID, sessionID: Schema.String, itemID: SessionReviewID },
})
const Assessed = ephemeral({
  type: "form.assessed",
  schema: { id: ID, sessionID: Schema.String, assessment: Assessment },
})

export const Event = {
  Created,
  Replied,
  Cancelled,
  TimedOut,
  Deferred,
  Assessed,
  Definitions: inventory(Created, Replied, Cancelled, TimedOut, Deferred, Assessed),
}
