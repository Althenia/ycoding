import { expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Session.node]), [
  [SessionExecution.node, SessionExecution.noopLayer],
]))

const jobCount = 105
const window = 100
const metrics = (i: number) => ({ excludedMessages: i, excludedParts: 1, inputTokens: 1000 + i, retainedTokens: 100 })
const jobs = Array.from({ length: jobCount }, (_, i) => ({
  i,
  jobID: SessionCompaction.ID.make(`cmp_job${String(i).padStart(3, "0")}`),
  created: 1000 + Math.floor(i / 2),
  status: i % 10 === 3 ? ("failed" as const) : i % 10 === 7 ? ("pending" as const) : ("completed" as const),
}))

const message = (job: (typeof jobs)[number]) => {
  const base = {
    id: SessionMessage.ID.make(`msg_${job.jobID}`),
    type: "compaction" as const,
    jobID: job.jobID,
    trigger: "manual" as const,
    time: { created: DateTime.makeUnsafe(job.created) },
  }
  if (job.status === "pending") return SessionMessage.CompactionPending.make({ ...base, status: "pending" })
  if (job.status === "failed")
    return SessionMessage.CompactionFailedCurrent.make({ ...base, status: "failed", code: "provider_failed", error: { type: "provider", message: "failed" } })
  return SessionMessage.CompactionCompletedCurrent.make({
    ...base,
    status: "completed",
    revision: 0,
    boundary: { messageID: SessionMessage.ID.make("msg_boundary"), seq: 0 },
    metrics: metrics(job.i),
    summary: "x".repeat(2000),
  })
}

const row = (sessionID: Session.ID, seq: number, input: SessionMessage.Info) => {
  const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(input)
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, time_created: seq * 3, data }
}

it.effect("summarizes every job-keyed compaction of one Session, bounded to the newest 100", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* Session.Service
    const sessionID = Session.ID.make("ses_compaction_history")
    const bystander = Session.ID.make("ses_compaction_bystander")
    const empty = Session.ID.make("ses_compaction_empty")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values([sessionID, bystander, empty].map((id) => ({ id, project_id: Project.ID.global, directory: "/project", title: id }))).run()
    const legacy = SessionMessage.CompactionCompletedV1.make({
      id: SessionMessage.ID.make("msg_legacy_compaction"),
      type: "compaction",
      reason: "auto",
      status: "completed",
      summary: "legacy",
      recent: "legacy",
      time: { created: DateTime.makeUnsafe(1) },
    })
    yield* db.insert(SessionMessageTable).values([
      ...jobs.map((job) => row(sessionID, 1000 - job.i, message(job))),
      row(sessionID, 2000, legacy),
      row(bystander, 1, message({ i: 900, jobID: SessionCompaction.ID.make("cmp_bystander"), created: 5000, status: "completed" })),
    ]).run()

    const completed = jobs.filter((job) => job.status === "completed")
    const newest = jobs.slice(-window)
    const history = yield* sessions.compactionHistory(sessionID)

    expect(history.data.map((job) => job.jobID)).toEqual(newest.map((job) => job.jobID))
    expect(history.truncated).toBe(true)
    expect(history.completedCount).toBe(completed.length)
    expect(history.completedBefore).toBe(completed.filter((job) => !newest.includes(job)).length)
    expect(history.totalSavedTokens).toBe(completed.reduce((total, job) => total + metrics(job.i).inputTokens - metrics(job.i).retainedTokens, 0))
    expect(history.data.find((job) => job.jobID === jobs[10].jobID)).toEqual({
      jobID: jobs[10].jobID, trigger: "manual", status: "completed", created: jobs[10].created, metrics: metrics(10),
    })
    expect(history.data.find((job) => job.jobID === jobs[103].jobID)).toEqual({
      jobID: jobs[103].jobID, trigger: "manual", status: "failed", created: jobs[103].created, code: "provider_failed",
    })
    expect(history.data.find((job) => job.jobID === jobs[97].jobID)).toEqual({
      jobID: jobs[97].jobID, trigger: "manual", status: "pending", created: jobs[97].created,
    })

    expect(yield* sessions.compactionHistory(empty)).toEqual({ data: [], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 })
    expect(yield* Effect.flip(sessions.compactionHistory(Session.ID.make("ses_compaction_missing")))).toMatchObject({ _tag: "Session.NotFoundError" })
  }),
)
