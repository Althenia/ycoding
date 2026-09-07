import { Option, Schema } from "effect"

const sessionStatePrefix = "Authoritative current Session state (JSON):\n"
const teamViewPrefix =
  "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n"

export function noticeMarkdown(source: string | undefined, text: string) {
  const prefix = source === "session-state" ? sessionStatePrefix : source === "team-view" ? teamViewPrefix : undefined
  if (!prefix || !text.startsWith(prefix)) return { structured: false, content: text, summary: "" }

  const body = text.slice(prefix.length)
  const [json, ...trailing] = body.split("\n")
  const value = parseObject(json)
  if (!value)
    return {
      structured: true,
      content: text,
      summary: source === "session-state" ? "Session state · unavailable" : "TeamView · unavailable",
    }

  return {
    structured: true,
    content: `## ${source === "session-state" ? "Session state" : "TeamView"}${tables(value)}${trailing.length ? `\n\n${trailing.join("\n").trim()}` : ""}`,
    summary: source === "session-state" ? sessionStateSummary(value) : teamViewSummary(value),
  }
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
  const states = children
    .map(record)
    .flatMap((child) => (typeof child?.state === "string" ? [child.state] : []))
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

function parseObject(text: string) {
  return record(Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)))
}

function tables(value: Record<string, unknown>) {
  return Object.entries(value)
    .map(([key, entry]) => `\n\n### ${escape(key)}\n\n${table(entry)}`)
    .join("")
}

function table(value: unknown) {
  if (Array.isArray(value)) return arrayTable(value)
  if (value && typeof value === "object") return objectTable(value as Record<string, unknown>)
  return `| Value |\n| --- |\n| ${cell(value)} |`
}

function objectTable(value: Record<string, unknown>) {
  return `| Field | Value |\n| --- | --- |\n${Object.entries(value)
    .map(([key, entry]) => `| ${escape(key)} | ${cell(entry)} |`)
    .join("\n")}`
}

function arrayTable(value: unknown[]) {
  const rows = value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
  if (rows.length !== value.length) return `| Value |\n| --- |\n${value.map((entry) => `| ${cell(entry)} |`).join("\n")}`
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  if (!keys.length) return "| Value |\n| --- |\n| — |"
  if (keys.length > 4)
    return `| Field | Value |\n| --- | --- |\n${rows
      .flatMap((row, index) => Object.entries(row).map(([key, entry]) => `| ${index + 1}. ${escape(key)} | ${cell(entry)} |`))
      .join("\n")}`
  return `| ${keys.map(escape).join(" | ")} |\n| ${keys.map(() => "---").join(" | ")} |\n${rows
    .map((row) => `| ${keys.map((key) => cell(row[key])).join(" | ")} |`)
    .join("\n")}`
}

function cell(value: unknown) {
  if (typeof value === "string") return escape(value)
  if (value === undefined) return ""
  return escape(JSON.stringify(value))
}

function escape(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>")
    .replace(/([`*_{}\[\]()#+!])/g, "\\$1")
}
