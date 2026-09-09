export * as Pty from "./pty.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { NonNegativeInt, PositiveInt, statics } from "./schema.js"

const IDSchema = Schema.String.check(Schema.isStartsWith("pty")).pipe(Schema.brand("PtyID"))

export const ID = IDSchema.pipe(
  statics((schema: typeof IDSchema) => {
    const create = () => schema.make("pty_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

export const MAX_COLS = 500
export const MAX_ROWS = 200
export const MAX_RUNTIME_SECONDS = 2 * 60 * 60
export const DEFAULT_RUNTIME_SECONDS = 30 * 60
export const MAX_RETAINED_BYTES = 2 * 1024 * 1024
export const MAX_INPUT_BYTES = 64 * 1024
export const MAX_ACTIVE = 8
export const MAX_ATTACHMENTS = 8

export const Generation = PositiveInt
export type Generation = typeof Generation.Type

export const Offset = NonNegativeInt
export type Offset = typeof Offset.Type

export const Size = Schema.Struct({
  rows: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ROWS)),
  cols: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_COLS)),
}).annotate({ identifier: "Pty.Size" })
export interface Size extends Schema.Schema.Type<typeof Size> {}

export const Actor = Schema.Literals(["agent", "user"])
export type Actor = typeof Actor.Type

export const ControlOwner = Schema.Literals(["agent", "user", "paused"])
export type ControlOwner = typeof ControlOwner.Type

export const Access = Schema.Literals(["inspect", "control"])
export type Access = typeof Access.Type

export const Info = Schema.Struct({
  id: ID,
  title: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  sessionID: SessionID,
  status: Schema.Literals(["running", "exited"]),
  pid: NonNegativeInt,
  exitCode: optional(NonNegativeInt),
  exitReason: Schema.Literals(["exit", "timeout", "terminated"]).pipe(optional),
  generation: Generation,
  size: Size,
  control: Schema.Struct({ owner: ControlOwner, fence: PositiveInt }),
  output: Schema.Struct({ startOffset: Offset, endOffset: Offset, truncated: Schema.Boolean }),
  limits: Schema.Struct({
    maxRuntimeSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RUNTIME_SECONDS)),
    maxRetainedBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RETAINED_BYTES)),
    maxInputBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_INPUT_BYTES)),
  }),
}).annotate({ identifier: "Pty" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Created = ephemeral({ type: "pty.created", schema: { info: Info } })
const Updated = ephemeral({ type: "pty.updated", schema: { info: Info } })
const Exited = ephemeral({
  type: "pty.exited",
  schema: { id: ID, exitCode: NonNegativeInt, reason: Schema.Literals(["exit", "timeout"]) },
})
const Deleted = ephemeral({ type: "pty.deleted", schema: { id: ID } })
export const Event = { Created, Updated, Exited, Deleted, Definitions: inventory(Created, Updated, Exited, Deleted) }

export const CreateInput = Schema.Struct({
  sessionID: SessionID,
  command: optional(Schema.String),
  args: optional(Schema.Array(Schema.String)),
  cwd: optional(Schema.String),
  title: optional(Schema.String),
  env: optional(Schema.Record(Schema.String, Schema.String)),
  size: optional(Size),
  maxRuntimeSeconds: optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RUNTIME_SECONDS))),
  maxRetainedBytes: optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RETAINED_BYTES))),
})
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const UpdateInput = Schema.Struct({
  sessionID: SessionID,
  generation: Generation,
  expectedFence: PositiveInt,
  actor: Actor,
  title: optional(Schema.String),
  size: optional(Size),
})
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}

export const OwnerInput = Schema.Struct({ sessionID: SessionID })
export interface OwnerInput extends Schema.Schema.Type<typeof OwnerInput> {}

export const ControlInput = Schema.Struct({
  sessionID: SessionID,
  generation: Generation,
  expectedFence: PositiveInt,
  action: Schema.Literals(["take", "pause", "agent"]),
})
export interface ControlInput extends Schema.Schema.Type<typeof ControlInput> {}

export const ConnectInput = Schema.Struct({
  sessionID: SessionID,
  access: Access,
  generation: Generation,
  expectedFence: PositiveInt.pipe(optional),
})
export interface ConnectInput extends Schema.Schema.Type<typeof ConnectInput> {}
