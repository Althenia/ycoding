export * as DotsReportTool from "./report-tool"

import { Dots } from "@ycoding-ai/schema/dots"
import { Effect, Schema } from "effect"
import type { Permission } from "../permission"
import type { SessionGuardrail } from "../session/guardrail"
import { Tool } from "../tool/tool"
import { Hash } from "../util/hash"
import type { DotsReporting } from "./report"

export function make(options: {
  readonly resolve: DotsReporting.Options["resolve"]
  readonly report: ReturnType<typeof DotsReporting.make>["report"]
  readonly permission: Pick<Permission.Interface, "assert">
  readonly guardrail: Pick<SessionGuardrail.Interface, "assert">
}) {
  return Tool.make({
    description: "Report progress, a blocker or a decision request to the authenticated Dots coordinator of the current task. Routing identity is supplied by YCoding. A report grants no approval; use native question and review tools for explicit decisions. Recorded reports do not prove host delivery.",
    input: Schema.Struct({ kind: Schema.Literals(["progress", "blocker", "decision_request"]), text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32768)) }),
    output: Dots.ExchangeOutput,
    toModelOutput: ({ output }) => [{ type: "text", text: `Report recorded as ${output.deliveryID}. Host delivery is not confirmed.` }],
    execute: (args, context) => Effect.gen(function* () {
      const current = yield* options.resolve(context.sessionID, context.messageID)
      const source = { messageID: context.messageID, callID: context.callID }
      yield* options.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: "dots_report", resources: [current.record.source.principal.clientID], source: { type: "tool", ...source }, metadata: { operationDigest: Hash.json({ inputID: current.record.inputID, kind: args.kind, text: args.text }) } })
      const reservation = yield* options.guardrail.assert({ sessionID: context.sessionID, action: "dots_report", resources: [], source })
      return yield* options.report({ sessionID: context.sessionID, ...source, ...args }).pipe(Effect.ensuring(reservation.release))
    }).pipe(Effect.mapError((error) => new Tool.Failure({ message: error.message }))),
  })
}
