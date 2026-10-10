export * as Telemetry from "./telemetry.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

const At = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/))

const DurationMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(600_000))

export const Operation = Schema.Literals([
  "provider.auth.list",
  "provider.auth.key",
  "provider.auth.begin",
  "provider.auth.status",
  "provider.auth.complete",
  "provider.auth.cancel",
  "workspace.list",
  "session.list",
  "session.active",
  "session.get",
  "session.messages",
  "session.capturedChanges.list",
  "session.compaction.list",
  "session.compact",
  "session.snapshot",
  "session.pending.list",
  "session.attachment.read",
  "session.message.stream",
  "session.todo.list",
  "session.subagent.list",
  "session.pin",
  "session.unpin",
  "session.subagent.cancel",
  "session.subagent.answer",
  "session.team.economics",
  "session.team.shell.list",
  "session.team.shell.kill",
  "session.side-chat.list",
  "session.side-chat.create",
  "session.family.activity",
  "session.log",
  "session.subscribe",
  "session.unsubscribe",
  "session.prompt",
  "session.attachment.upload",
  "session.interrupt",
  "session.permission.list",
  "session.permission.reply",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.guardrail.reply",
  "session.form.list",
  "session.form.reply",
  "session.form.cancel",
  "session.shell.output",
  "session.autonomy.get",
  "session.autonomy.set",
  "session.goal.set",
  "session.goal.stop",
  "session.create",
  "session.status",
  "session.catalog",
  "workspace.catalog",
  "session.file.find",
  "workspace.file.find",
  "session.switchModel",
  "session.switchAgent",
  "session.command",
  "session.skill",
  "usage.providers",
  "usage.summary",
  "usage.report",
  "machine.keepAwake.get",
  "machine.keepAwake.set",
]).check(Schema.isMaxLength(64))

export const RequestSample = Schema.Struct({
  kind: Schema.Literal("request"),
  at: At,
  operation: Operation,
  outcome: Schema.Literals(["ok", "failed", "unknown", "unavailable"]),
  reason: Schema.Literals(["not-connected", "in-flight-limit", "request-limit", "cancelled"]).pipe(optional),
  queueMs: DurationMs,
  settlementMs: DurationMs.pipe(optional),
  totalMs: DurationMs,
}).annotate({ identifier: "Telemetry.RequestSample", parseOptions: { onExcessProperty: "error" } })

export const LongTaskSample = Schema.Struct({
  kind: Schema.Literal("long-task"),
  at: At,
  durationMs: DurationMs.check(Schema.isGreaterThanOrEqualTo(50)),
}).annotate({ identifier: "Telemetry.LongTaskSample", parseOptions: { onExcessProperty: "error" } })

export const Sample = Schema.Union([RequestSample, LongTaskSample]).annotate({ identifier: "Telemetry.Sample" })
export type Sample = typeof Sample.Type

export const Batch = Schema.Struct({
  samples: Schema.Array(Sample).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
}).annotate({ identifier: "Telemetry.Batch", parseOptions: { onExcessProperty: "error" } })
export interface Batch extends Schema.Schema.Type<typeof Batch> {}

export const Page = Schema.Struct({
  data: Schema.Array(Schema.Struct({ receivedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), sample: Sample })),
  cursor: Schema.Struct({ next: Schema.String.pipe(optional) }),
}).annotate({ identifier: "Telemetry.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}
