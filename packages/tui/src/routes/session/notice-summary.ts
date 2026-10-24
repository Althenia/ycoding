import { Option, Schema } from "effect"
import { autonomyCategories, autonomyMode } from "../../util/session-autonomy"

const sessionStatePrefix = "Authoritative current Session state (JSON):\n"
const teamViewPrefix =
  "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n"

export function noticeSummary(source: string | undefined, text: string) {
  const prefix = source === "session-state" ? sessionStatePrefix : source === "team-view" ? teamViewPrefix : undefined
  if (!prefix || !text.startsWith(prefix)) return undefined

  const [json] = text.slice(prefix.length).split("\n")
  const value = parseObject(json)
  if (!value) return source === "session-state" ? "Session state · unavailable" : "TeamView · unavailable"
  return source === "session-state" ? sessionStateSummary(value) : teamViewSummary(value)
}

function sessionStateSummary(value: Record<string, unknown>) {
  const autonomy = record(value.autonomy)
  const todos = Array.isArray(value.todos) ? value.todos.length : 0
  if (!autonomy) return `Session state · autonomy unreported · ${todos} ${todos === 1 ? "task" : "tasks"}`
  const modes = autonomyCategories.map((category) => [category, autonomyMode(autonomy[category])] as const)
  const parts = modes.some(([, mode]) => mode === undefined)
    ? ["unknown"]
    : [
        ...(modes.every(([, mode]) => mode === "manual")
          ? ["manual"]
          : modes.flatMap(([category, mode]) => (mode === "manual" ? [] : [`${category} ${mode}`]))),
        ...(record(autonomy.goal)?.status === "active" ? ["goal"] : []),
        ...(autonomy.sleep !== undefined && autonomy.sleep !== null ? ["asleep"] : []),
      ]
  return `Session state · ${parts.join(" · ")} · ${todos} ${todos === 1 ? "task" : "tasks"}`
}

function teamViewSummary(value: Record<string, unknown>) {
  const children = Array.isArray(value.children) ? value.children : []
  const states = children.map(record).flatMap((child) => (typeof child?.state === "string" ? [child.state] : []))
  const omitted = typeof value.omitted === "number" && value.omitted > 0 ? value.omitted : 0
  if (!states.length) return omitted ? `TeamView · ${omitted} omitted` : "TeamView · no children"
  return `TeamView · ${[...new Set(states)]
    .map((state) => `${states.filter((item) => item === state).length} ${state}`)
    .concat(omitted ? `${omitted} omitted` : [])
    .join(" · ")}`
}

function record(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
}

function parseObject(text: string | undefined) {
  if (text === undefined) return undefined
  return record(Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)))
}
