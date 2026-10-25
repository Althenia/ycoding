import { expect, test } from "bun:test"
import { toolDisplayName } from "./tool-display"

test.each([
  ["tools.chatgpt.calendar.list_events", undefined, "ChatGPT · Calendar · List Events"],
  ["mcp__calendar__list-events", undefined, "Calendar · List Events"],
  ["calendar.\u001b[31mread\u202e", undefined, "Calendar · \\u001b[31mread\\u202e"],
  ["chatgpt_connector_42_list_events_012345abcdef", { connector: "connector-42", connectorLabel: "Work Calendar", tool: "list_events" }, "ChatGPT · Work Calendar · List Events"],
  ["chatgpt_connector_42_list_events_012345abcdef", { connector: "connector-42" }, "ChatGPT · List Events"],
  ["claude_connector_42_read_file_012345abcdef", { connector: "connector-42" }, "Claude · Read File"],
  ["chatgpt_connector_42_list_events_012345abcdef", undefined, "Tool name unavailable"],
  ["chatgpt_connector_42_list_events_012345abcdef", { connector: "wrong" }, "Tool name unavailable"],
  ["chatgpt_connector_42_list_events_012345abcdef", { connector: "connector-42", connectorLabel: "Calendar\u0000\u0007\t\n\u2028\u2029\u2066", tool: "list_events" }, "ChatGPT · Calendar\\u0000\\u0007\\u0009\\u000a\\u2028\\u2029\\u2066 · List Events"],
])("formats %s as display text without exposing connector identity", (name, metadata, label) => {
  expect(toolDisplayName(name, metadata)).toBe(label)
})
