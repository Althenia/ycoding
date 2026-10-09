import { Option, Schema } from "effect"

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
  const mode = typeof autonomy?.mode === "string" ? autonomy.mode : "unknown"
  const yolo = autonomy?.yolo ?? 0
  const todos = Array.isArray(value.todos) ? value.todos.length : 0
  return `Session state · ${mode} · YOLO ${yolo} · ${todos} ${todos === 1 ? "task" : "tasks"}`
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

const decisionAdvisoryPreamble = "Decision advisory:"

/**
 * Splits a Decision advisory notice into the one-line transcript summary and the lines worth
 * expanding. The first line is the fixed disclaimer, which the model needs but the user does not.
 * An advisory that produced nothing actionable is noise in the transcript and is not rendered;
 * an unavailable helper is still reported so the user can see the policy did not run.
 */
export function decisionAdvisory(text: string) {
  const lines = text.split("\n")
  if (!lines[0]?.startsWith(decisionAdvisoryPreamble)) return undefined
  const details = lines.slice(1).filter((line) => line.trim().length > 0)
  const recommendations = details.filter((line) => line.startsWith("Recommended "))
  if (recommendations.length === 0 && details.every((line) => line === noRecommendationOutcome))
    return { hidden: true as const }
  const summary = recommendations.length
    ? `Decision advisory · ${recommendations.length} ${recommendations.length === 1 ? "recommendation" : "recommendations"}`
    : (details[0] ?? "Decision advisory")
  return { hidden: false as const, summary, details }
}

const noRecommendationOutcome = "No sufficiently confident actionable recommendation was produced."

function record(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
}

function parseObject(text: string | undefined) {
  if (text === undefined) return undefined
  return record(Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)))
}
