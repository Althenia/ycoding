export * as SessionGoalVerification from "./goal-verification"

import { ToolInvocation } from "@ycoding-ai/schema/tool-invocation"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionMessageTable, SessionTable } from "./sql"

const changeTools: ReadonlySet<string> = new Set(["edit", "write", "patch"])
const checkTools: ReadonlySet<string> = new Set(["shell"])
const scriptPath = /(?<![\w./-])\.{1,2}\/[\w./-]*\.(?:sh|bash|zsh|ps1|cmd|bat)(?![\w/-]|\.[\w/-])/g

export type Verification = "none" | "verified" | "unverified"
export type CheckState = "unrun" | "stale" | "failing"

export interface UnmetCheck {
  readonly check: string
  readonly state: CheckState
}

const isChange = (call: ToolInvocation.Invocation) => call.status === "completed" && changeTools.has(call.name)

export function verification(messages: ReadonlyArray<SessionMessage.Info>): Verification {
  const calls = messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) => ToolInvocation.list(part).filter((call) => call.status === "completed"))
      : [],
  )
  const lastChange = calls.findLastIndex((call) =>
    isChange(call) ||
    (call.name === "goal" && typeof call.input === "object" && call.input !== null &&
      "action" in call.input && call.input.action === "rework" && "state" in call.input && call.input.state === "opened"))
  if (lastChange < 0) return "none"
  return calls.findLastIndex((call) => checkTools.has(call.name)) > lastChange ? "verified" : "unverified"
}

export function requiredChecks(objective: string) {
  const commands = [...objective.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1].trim().replace(/\s+/g, " "))
    .filter((span) => /\s/.test(span) || new RegExp(`^${scriptPath.source}$`).test(span))
  const scripts = [...objective.replace(/`[^`\n]*`/g, " ").matchAll(scriptPath)].map((match) => match[0])
  return [...new Set([...commands, ...scripts])]
}

export function unmetChecks(checks: ReadonlyArray<string>, calls: ReadonlyArray<ToolInvocation.Invocation>): ReadonlyArray<UnmetCheck> {
  const lastChange = calls.findLastIndex(isChange)
  if (checks.length === 0 || lastChange < 0) return []
  return checks.flatMap((check): ReadonlyArray<UnmetCheck> => {
    const latest = calls.findLastIndex((call) =>
      checkTools.has(call.name) && (call.status === "completed" || call.status === "error") && runs(call, check))
    if (latest < 0) return [{ check, state: "unrun" }]
    if (latest < lastChange) return [{ check, state: "stale" }]
    return passed(calls[latest]) ? [] : [{ check, state: "failing" }]
  })
}

export const familyCalls = Effect.fn("SessionGoalVerification.familyCalls")(function* (
  db: Database.Interface["db"],
  ownerID: SessionSchema.ID,
) {
  const family = yield* descendants(db, [ownerID], [ownerID])
  const rows = yield* db
    .select({ sessionID: SessionMessageTable.session_id, data: SessionMessageTable.data, time: SessionMessageTable.time_created })
    .from(SessionMessageTable)
    .where(and(inArray(SessionMessageTable.session_id, [...family]), eq(SessionMessageTable.type, "assistant")))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
    .toSorted((left, right) => family.indexOf(left.sessionID) - family.indexOf(right.sessionID))
    .flatMap((row) => {
      const content: ReadonlyArray<unknown> = "content" in row.data && Array.isArray(row.data.content) ? row.data.content : []
      return content.flatMap((part) => ToolInvocation.list(part).map((call) => ({ call, time: settledAt(part) ?? row.time })))
    })
    .toSorted((left, right) => left.time - right.time)
    .map((item) => item.call)
})

function descendants(
  db: Database.Interface["db"],
  frontier: ReadonlyArray<SessionSchema.ID>,
  found: ReadonlyArray<SessionSchema.ID>,
): Effect.Effect<ReadonlyArray<SessionSchema.ID>> {
  if (frontier.length === 0) return Effect.succeed(found)
  return db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(inArray(SessionTable.parent_id, [...frontier]))
    .all()
    .pipe(
      Effect.orDie,
      Effect.flatMap((rows) => {
        const next = rows.map((row) => row.id).filter((id) => !found.includes(id))
        return descendants(db, next, [...found, ...next])
      }),
    )
}

function runs(call: ToolInvocation.Invocation, check: string) {
  const command = typeof call.input === "object" && call.input !== null && "command" in call.input && typeof call.input.command === "string"
    ? call.input.command.trim().replace(/\s+/g, " ")
    : undefined
  if (command === undefined) return false
  if (!/^\.{1,2}\//.test(check)) return command.includes(check)
  const path = check.replace(/^\.\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|[\\s;&|(])(?:\\./)?${path}(?=$|[\\s;&|)])`).test(command)
}

function passed(call: ToolInvocation.Invocation) {
  const structured = call.structured
  return call.status === "completed" && typeof structured === "object" && structured !== null &&
    "exit" in structured && structured.exit === 0 &&
    !("timeout" in structured && structured.timeout === true) &&
    !("memoryLimit" in structured && structured.memoryLimit === true)
}

function settledAt(part: unknown) {
  if (typeof part !== "object" || part === null || !("time" in part) || typeof part.time !== "object" || part.time === null) return undefined
  const time = part.time
  if ("completed" in time && typeof time.completed === "number") return time.completed
  if ("created" in time && typeof time.created === "number") return time.created
  return undefined
}
