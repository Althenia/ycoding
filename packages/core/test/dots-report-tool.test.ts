import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@ycoding-ai/schema/agent"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsReportTool } from "../src/dots/report-tool"
import { Session } from "../src/session"
import { SessionMessage } from "../src/session/message"
import { Permission } from "../src/permission"

const context = { sessionID: Session.ID.make("ses_reporter"), messageID: SessionMessage.ID.make("msg_reporter"), callID: "call_reporter", agent: Agent.ID.make("build"), progress: () => Effect.void }
const record = Dots.ExchangeRecord.make({ sessionID: Session.ID.make("ses_anchor"), targetSessionID: context.sessionID, exchangeID: "exchange_fixture", inputID: SessionMessage.ID.make("msg_input"), expectedAttachment: { profile: "fixture", dotID: "dot_fixture", threadID: "thread_fixture", generation: "1", label: "V" }, accountDigest: "digest", fingerprint: "fingerprint", source: { requestID: "req_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } }, grantID: "grant_fixture", scope: { rootSessionID: context.sessionID } })

test("Dots report tool passes authored intent but stamps tool identity from runtime context", async () => {
  const received: unknown[] = []
  const order: string[] = []
  const tool = DotsReportTool.make({
    resolve: () => Effect.sync(() => { order.push("resolve"); return { record, generation: 1 } }),
    report: (input) => Effect.sync(() => { order.push("report"); received.push(input); return Dots.ExchangeOutput.make({ deliveryID: "report_fixture", messageID: context.messageID, text: input.text, envelope: { coordinator: record.source.principal, scope: { epoch: record.source.epoch, grantID: record.grantID }, exchangeID: record.exchangeID, messageID: context.messageID, sourceSessionID: context.sessionID, replyToMessageID: record.inputID, origin: "agent", kind: input.kind } }) }),
    permission: { assert: () => Effect.sync(() => { order.push("permission") }) },
    guardrail: { assert: () => Effect.sync(() => { order.push("guardrail"); return { release: Effect.sync(() => { order.push("release") }) } }) },
  })
  const result = await Effect.runPromise(tool.execute({ kind: "blocker", text: "Synthetic blocker" }, context))
  expect(received).toEqual([{ sessionID: context.sessionID, messageID: context.messageID, callID: context.callID, kind: "blocker", text: "Synthetic blocker" }])
  expect(order).toEqual(["resolve", "permission", "guardrail", "report", "release"])
  expect(result.envelope.sourceSessionID).toBe(context.sessionID)
})

test("Dots report tool does not record after a denied permission", async () => {
  let calls = 0
  const tool = DotsReportTool.make({
    resolve: () => Effect.succeed({ record, generation: 1 }),
    report: () => { calls++; return Effect.die("Unexpected report") },
    permission: { assert: () => Effect.fail(new Permission.BlockedError({ permission: "dots_report", resources: [], rules: [] })) },
    guardrail: { assert: () => Effect.die("Unexpected guardrail") },
  })
  expect((await Effect.runPromise(Effect.exit(tool.execute({ kind: "progress", text: "Synthetic progress" }, context))))._tag).toBe("Failure")
  expect(calls).toBe(0)
})
