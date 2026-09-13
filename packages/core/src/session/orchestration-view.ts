import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionTaskTable } from "./sql"
import { canonicalJson } from "./runner/cache"
import { Task, TeamView, truncateUtf8, type State } from "@ycoding-ai/schema/session-orchestration"
import { eq } from "drizzle-orm"
import { Effect } from "effect"

const TeamViewBytes = 32 * 1024
const teamViewPrefix =
  "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n"
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
  const children = new Array<Task>()
  for (const task of sorted) {
    const view = TeamView.make({
      children: [...children, task],
      omitted: sorted.length - children.length - 1,
    })
    if (Buffer.byteLength(teamViewPrefix + JSON.stringify(view)) > maxBytes) break
    children.push(task)
  }
  const view = TeamView.make({ children, omitted: sorted.length - children.length })
  return { view, text: teamViewPrefix + JSON.stringify(view) }
}

// Automatic observations describe decisions, not delivery revisions. Explicit
// inspection still returns the complete Task, including its operational clocks.
export const renderTeamObservation = (tasks: ReadonlyArray<Task>, maxBytes = TeamViewBytes) => {
  const sorted = tasks
    .map((task) => ({
      sessionID: task.sessionID,
      parentID: task.parentID,
      description: truncateUtf8(task.description, 4 * 1024),
      agent: task.agent,
      model: task.model,
      background: task.background,
      state: task.state,
      progress: task.progress ? { text: truncateUtf8(task.progress.text, 4 * 1024) } : undefined,
      question: task.question
        ? { id: task.question.id, text: truncateUtf8(task.question.text, 8 * 1024), data: task.question.data }
        : undefined,
    }))
    .toSorted((a, b) => {
      const question = Number(b.question !== undefined) - Number(a.question !== undefined)
      if (question !== 0) return question
      const state = Number(isTerminal(a.state)) - Number(isTerminal(b.state))
      if (state !== 0) return state
      return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0
    })
  const children: typeof sorted = []
  for (const task of sorted) {
    const view = { children: [...children, task], omitted: sorted.length - children.length - 1 }
    if (Buffer.byteLength(teamViewPrefix + canonicalJson(view)) > maxBytes) break
    children.push(task)
  }
  const view = { children, omitted: sorted.length - children.length }
  return { view, text: teamViewPrefix + canonicalJson(view) }
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
  const tasks = yield* readTasks(db, parentID)
  return tasks.length === 0 ? undefined : renderTeamView(tasks)
})

export const readTeamObservation = Effect.fn("SessionOrchestrationView.readTeamObservation")(function* (
  db: DatabaseService,
  parentID: SessionSchema.ID,
) {
  const tasks = yield* readTasks(db, parentID)
  return tasks.length === 0 ? undefined : renderTeamObservation(tasks)
})

const readTasks = Effect.fn("SessionOrchestrationView.readTasks")(function* (
  db: DatabaseService,
  parentID: SessionSchema.ID,
) {
  return (yield* db
    .select()
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.parent_id, parentID))
    .all()
    .pipe(Effect.orDie)).map(taskFromRow)
})
