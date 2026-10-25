import type { SessionMessageInfo } from "@ycoding-ai/client"
import { Dots } from "@ycoding-ai/schema/dots"
import { Schema } from "effect"

const decodeCoordination = Schema.decodeUnknownOption(Dots.CoordinationContext)
const reasons = {
  capability_disabled: "Dots capability disabled",
  no_task: "no active Dots task",
  task_settled: "Dots task settled",
  unavailable: "coordination unavailable",
  tool_unavailable: "dots_report unavailable",
}

export function dotsNoticeSummary(message: SessionMessageInfo) {
  if (message.type !== "system" || message.metadata?.contextSource !== "dots") return undefined
  const context = decodeCoordination(message.metadata.dotsCoordination)
  if (context._tag === "None") return "Dots coordination · state unavailable"
  if (context.value.state === "enabled") return "Dots coordination · enabled"
  return `Dots coordination · disabled · ${reasons[context.value.reason]}`
}
