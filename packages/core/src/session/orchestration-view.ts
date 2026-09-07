import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionTaskTable } from "./sql"
import { Task, TeamView, truncateUtf8, type State } from "@ycoding-ai/schema/session-orchestration"
import { eq } from "drizzle-orm"
import { Effect } from "effect"

const TeamViewBytes = 32 * 1024
const terminalStates = new Set<State>(["cancelled", "completed", "failed", "lost"])
type DatabaseService = Database.Interface["db"]

export const isTerminal = (state: State) => terminalStates.has(state)

export const renderTeamView = (tasks: ReadonlyArray<Task>, maxBytes = TeamViewBytes) => {
  const sorted = tasks
    .map(
      (task): Task => ({
        ...task,
        description: truncateUtf8(task.description, 4 * 1024),
        progress: task.progress ? { ...task.progress, text: truncateUtf8(task.progress.text, 4 * 1024) } : undefined,
        question: task.question ? { ...task.question, text: truncateUtf8(task.question.text, 8 * 1024) } : undefined,
      }),
    )
    .toSorted((a, b) => {
      const state = Number(isTerminal(a.state)) - Number(isTerminal(b.state))
      if (state !== 0) return state
      if (a.time.updated !== b.time.updated) return b.time.updated - a.time.updated
      return String(a.sessionID).localeCompare(String(b.sessionID))
    })
  const prefix =
    "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n"
  const children = new Array<Task>()
  for (const task of sorted) {
    const view = TeamView.make({
      children: [...children, task],
      omitted: sorted.length - children.length - 1,
    })
    if (Buffer.byteLength(prefix + JSON.stringify(view)) > maxBytes) break
    children.push(task)
  }
  const view = TeamView.make({ children, omitted: sorted.length - children.length })
  return { view, text: prefix + JSON.stringify(view) }
}

export const taskFromRow = (row: typeof SessionTaskTable.$inferSelect): Task =>
  Task.make({
    sessionID: row.session_id,
    parentID: row.parent_id,
    description: row.description,
    agent: AgentV2.ID.make(row.agent),
    model: row.model,
    background: row.background,
    state: row.state,
    progress:
      row.progress === null || row.progress_time === null ? undefined : { text: row.progress, time: row.progress_time },
    question:
      row.question_id === null || row.question === null || row.question_time === null
        ? undefined
        : { id: row.question_id, text: row.question, data: row.question_data ?? undefined, time: row.question_time },
    revision: row.revision,
    time: { created: row.time_created, updated: row.time_updated },
  })

export const readTeamView = Effect.fn("SessionOrchestrationView.readTeamView")(function* (
  db: DatabaseService,
  parentID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.parent_id, parentID))
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) return undefined
  return renderTeamView(rows.map(taskFromRow))
})
