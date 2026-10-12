export * as SessionCapturedChanges from "./captured-changes"

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionCapturedChanges } from "@ycoding-ai/schema/session-captured-changes"
import type { SessionSchema } from "./schema"
import { MessageDecodeError, NotFoundError } from "./error"
import { SessionMessageTable, SessionTable } from "./sql"

const decodeParts = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Array(Schema.Struct({
  id: Schema.NullOr(Schema.String),
  name: Schema.String,
  status: Schema.NullOr(Schema.String),
  questionID: Schema.NullOr(Schema.String),
  sessionID: Schema.NullOr(Schema.String),
  action: Schema.NullOr(Schema.String),
  taskSessionID: Schema.NullOr(Schema.String),
  files: Schema.NullOr(Schema.Array(Schema.Struct({ file: Schema.NullOr(Schema.String), patch: Schema.String, status: Schema.NullOr(Schema.String) }))),
})))))
const decode = Schema.decodeUnknownEffect(SessionCapturedChanges.Input)

export const page = Effect.fn("SessionCapturedChanges.page")(function* (
  db: Database.Interface["db"],
  input: { readonly sessionID: SessionSchema.ID; readonly after?: number; readonly limit: number },
) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200 ||
    input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0))
    return yield* Effect.die(new RangeError("Invalid captured input page"))
  const session = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
  if (!session) return yield* new NotFoundError({ sessionID: input.sessionID })
  const rows = yield* db.select({
    seq: SessionMessageTable.seq,
    id: SessionMessageTable.id,
    type: SessionMessageTable.type,
    kind: sql<string | null>`CASE WHEN ${SessionMessageTable.type} = 'synthetic' AND json_type(${SessionMessageTable.data}, '$.metadata.kind') = 'text' THEN json_extract(${SessionMessageTable.data}, '$.metadata.kind') END`,
    questionID: sql<string | null>`CASE WHEN ${SessionMessageTable.type} = 'synthetic' AND json_type(${SessionMessageTable.data}, '$.metadata.questionID') = 'text' THEN json_extract(${SessionMessageTable.data}, '$.metadata.questionID') END`,
    parts: sql<string | null>`CASE WHEN ${SessionMessageTable.type} = 'assistant' THEN (
      SELECT json_group_array(json_object(
        'id', json_extract(part.value, '$.id'),
        'name', json_extract(part.value, '$.name'),
        'status', json_extract(part.value, '$.state.status'),
        'questionID', CASE WHEN json_extract(part.value, '$.name') = 'subagent_control' AND json_type(part.value, '$.state.input.questionID') = 'text' THEN json_extract(part.value, '$.state.input.questionID') END,
        'sessionID', CASE WHEN json_extract(part.value, '$.name') = 'subagent' AND json_type(part.value, '$.state.structured.sessionID') = 'text' THEN json_extract(part.value, '$.state.structured.sessionID') END,
        'action', CASE WHEN json_extract(part.value, '$.name') = 'subagent_control' AND json_type(part.value, '$.state.structured.action') = 'text' THEN json_extract(part.value, '$.state.structured.action') END,
        'taskSessionID', CASE WHEN json_extract(part.value, '$.name') = 'subagent_control' AND json_type(part.value, '$.state.structured.task.sessionID') = 'text' THEN json_extract(part.value, '$.state.structured.task.sessionID') END,
        'files', CASE WHEN json_extract(part.value, '$.name') IN ('edit', 'patch', 'apply_patch') AND json_type(part.value, '$.state.structured.files') = 'array' THEN (
          SELECT json_group_array(json_object(
            'patch', json_extract(entry.value, '$.patch'),
            'file', CASE WHEN json_type(entry.value, '$.file') = 'text' THEN json_extract(entry.value, '$.file') END,
            'status', CASE WHEN json_type(entry.value, '$.status') = 'text' THEN json_extract(entry.value, '$.status') END))
          FROM json_each(part.value, '$.state.structured.files') AS entry
          WHERE entry.type = 'object' AND json_type(entry.value, '$.patch') = 'text'
        ) END
      )) FROM json_each(${SessionMessageTable.data}, '$.content') AS part
      WHERE part.type = 'object' AND json_extract(part.value, '$.type') = 'tool'
        AND json_extract(part.value, '$.name') IN ('edit', 'patch', 'apply_patch', 'subagent', 'subagent_control')
    ) END`,
  }).from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, input.sessionID),
    inArray(SessionMessageTable.type, ["user", "synthetic", "assistant"]),
    input.after === undefined ? undefined : gt(SessionMessageTable.seq, input.after),
  )).orderBy(asc(SessionMessageTable.seq)).limit(input.limit + 1).all().pipe(Effect.orDie)
  const data = yield* Effect.forEach(rows.slice(0, input.limit), (row) => Effect.gen(function* () {
    const parts = yield* decodeParts(row.parts ?? "[]")
    return yield* decode({
      id: row.id,
      type: row.type,
      ...(row.type === "synthetic" ? { metadata: { ...(row.kind === null ? {} : { kind: row.kind }), ...(row.questionID === null ? {} : { questionID: row.questionID }) } } : {}),
      ...(row.type === "assistant" ? { content: parts.map((part) => ({
        type: "tool",
        ...(part.id === null ? {} : { id: part.id }),
        name: part.name,
        state: {
          ...(part.status === null ? {} : { status: part.status }),
          ...(part.name === "subagent_control" ? { input: { ...(part.questionID === null ? {} : { questionID: part.questionID }) } } : {}),
          structured: {
            ...(part.files === null ? {} : { files: part.files.map((file) => ({ patch: file.patch, ...(file.file === null ? {} : { file: file.file }), ...(file.status === null ? {} : { status: file.status }) })) }),
            ...(part.sessionID === null ? {} : { sessionID: part.sessionID }),
            ...(part.action === null ? {} : { action: part.action }),
            ...(part.name === "subagent_control" ? { task: { ...(part.taskSessionID === null ? {} : { sessionID: part.taskSessionID }) } } : {}),
          },
        },
      })) } : {}),
    })
  }).pipe(Effect.mapError(() => new MessageDecodeError({ sessionID: input.sessionID, messageID: row.id }))))
  return { data, ...(rows.length > input.limit ? { next: rows[input.limit - 1]!.seq } : {}) }
})
