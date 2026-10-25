export * as DotsReport from "./dots-report.js"

import { Schema } from "effect"
import { Dots } from "./dots.js"

const decodeEnvelope = Schema.decodeUnknownSync(Dots.ReportEnvelope)

export function render(envelope: Dots.ReportEnvelope, body: string) {
  const report = decodeEnvelope(envelope, { onExcessProperty: "error" })
  requireBody(body)
  const to = [report.coordinator.ownerID, report.coordinator.deviceID, report.coordinator.clientID].map(encodeURIComponent).join("/")
  const fields = [
    `from=${encodeURIComponent(report.sourceSessionID)}`,
    `to=${to}`,
    `exchange=${encodeURIComponent(report.exchangeID)}`,
    `msg=${encodeURIComponent(report.messageID)}`,
    `reply=${encodeURIComponent(report.replyToMessageID)}`,
    `kind=${report.kind}`,
  ]
  return `[Dots | ${fields.join(" | ")}]\n${body}`
}

function requireBody(body: string) {
  if (body.trim() === "") throw new Error("Dots report body must not be blank")
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body)) throw new Error("Dots report body must not contain control characters")
  if (/[\u2028\u2029]/.test(body)) throw new Error("Dots report body must not contain Unicode line separators")
  if (/(^|\n)[\s\p{Cf}]*\[dots\b/iu.test(body)) throw new Error("Dots report body must not contain a Dots header")
}
