import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@ycoding-ai/core/database/database"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { goalReminder } from "@ycoding-ai/core/session/live-state"
import { Agent } from "@ycoding-ai/core/agent"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { GoalTool } from "@ycoding-ai/core/tool/goal"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layer({ path: ":memory:" }))
const sessionID = Session.ID.make("ses_autonomy")

for (const autoPermission of [false, true]) {
  for (const autoGuardrail of [false, true]) {
    it.effect(`rule flags autoPermission=${autoPermission} autoGuardrail=${autoGuardrail} grant only their own capability`, () => Effect.gen(function* () {
      const service = yield* setup
      yield* service.set({ sessionID, autoPermission })
      const state = yield* service.set({ sessionID, autoGuardrail })
      expect(state).toEqual({ mode: "normal", yolo: false, autoPermission, autoGuardrail })
      expect(SessionAutonomy.canAutoAnswer(state)).toBe(false)
      expect(SessionAutonomy.canAutoPermission(state)).toBe(autoPermission)
      expect(SessionAutonomy.canAutoGuardrail(state)).toBe(autoGuardrail)
      expect(SessionAutonomy.canYolo(state)).toBe(false)
      expect(yield* service.canAutoAnswer(sessionID)).toBe(false)
      expect(yield* service.canAutoPermission(sessionID)).toBe(autoPermission)
      expect(yield* service.canAutoGuardrail(sessionID)).toBe(autoGuardrail)
      expect(yield* service.canYolo(sessionID)).toBe(false)
    }))
  }
}

it.effect("YOLO alone grants no answers, permissions, or guardrail approvals", () => Effect.gen(function* () {
  const service = yield* setup
  const state = yield* service.setYolo({ sessionID, yolo: true })
  expect(state.yolo).toBe(true)
  expect(SessionAutonomy.canYolo(state)).toBe(true)
  expect(SessionAutonomy.canAutoAnswer(state)).toBe(false)
  expect(SessionAutonomy.canAutoPermission(state)).toBe(false)
  expect(SessionAutonomy.canAutoGuardrail(state)).toBe(false)
  expect(yield* service.canYolo(sessionID)).toBe(true)
  expect(yield* service.canAutoAnswer(sessionID)).toBe(false)
  expect(yield* service.canAutoPermission(sessionID)).toBe(false)
  expect(yield* service.canAutoGuardrail(sessionID)).toBe(false)
}))

it.effect("rejected numeric YOLO values are not accepted or stored", () => Effect.gen(function* () {
  const service = yield* setup
  yield* service.setYolo({ sessionID, yolo: true })
  for (const yolo of [0, 1, 2, 3]) {
    const exit = yield* service.setYolo({ sessionID, yolo: yolo as unknown as boolean }).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    const setExit = yield* service.set({ sessionID, yolo: yolo as unknown as boolean }).pipe(Effect.exit)
    expect(setExit._tag).toBe("Failure")
  }
  expect((yield* service.get(sessionID)).yolo).toBe(true)
}))

it.effect("explicit false rule flags are stored once and absent is not rewritten as false", () => Effect.gen(function* () {
  const service = yield* setup
  const initial = yield* service.snapshot(sessionID)
  expect(initial.state).toEqual({ mode: "normal", yolo: false })
  const disabled = yield* service.set({ sessionID, autoPermission: false })
  expect(disabled.autoPermission).toBe(false)
  expect(disabled.autoGuardrail).toBeUndefined()
  const afterFalse = yield* service.snapshot(sessionID)
  expect(afterFalse.sequence).toBe(initial.sequence + 1)
  expect(afterFalse.digest).not.toBe(initial.digest)
  yield* service.set({ sessionID, autoPermission: false })
  expect((yield* service.snapshot(sessionID)).sequence).toBe(afterFalse.sequence)
  const guardrail = yield* service.set({ sessionID, autoGuardrail: true })
  expect(guardrail.autoPermission).toBe(false)
  expect(guardrail.autoGuardrail).toBe(true)
}))

it.effect("rule flags persist across YOLO, goal, sleep, and auto-answer changes", () => Effect.gen(function* () {
  const service = yield* setup
  yield* service.set({ sessionID, autoPermission: true })
  yield* service.set({ sessionID, autoGuardrail: true })
  yield* service.setYolo({ sessionID, yolo: true })
  yield* service.setGoal({ sessionID, text: "Finish safely" })
  yield* service.set({ sessionID, sleep: true })
  yield* service.set({ sessionID, autoAnswer: true })
  const state = yield* service.set({ sessionID, sleep: false })
  expect(state).toMatchObject({ yolo: true, autoPermission: true, autoGuardrail: true, autoAnswer: true })
}))

it.effect("active goal grants no answers, permissions, or guardrail approvals without rule flags", () => Effect.gen(function* () {
  const service = yield* setup
  const state = yield* service.setGoal({ sessionID, text: "Finish safely" })
  expect(SessionAutonomy.canAutoAnswer(state)).toBe(false)
  expect(SessionAutonomy.canAutoPermission(state)).toBe(false)
  expect(SessionAutonomy.canAutoGuardrail(state)).toBe(false)
  expect(yield* service.canAutoAnswer(sessionID)).toBe(false)
  expect(yield* service.canAutoPermission(sessionID)).toBe(false)
  expect(yield* service.canAutoGuardrail(sessionID)).toBe(false)
}))

it.effect("Session autoAnswer toggle persists across YOLO, goal, and sleep changes", () => Effect.gen(function* () {
  const service = yield* setup
  expect((yield* service.get(sessionID)).autoAnswer).toBeUndefined()
  const enabled = yield* service.set({ sessionID, autoAnswer: true })
  expect(enabled.autoAnswer).toBe(true)
  expect(SessionAutonomy.canAutoAnswer(enabled)).toBe(true)
  expect(yield* service.canAutoAnswer(sessionID)).toBe(true)
  yield* service.setYolo({ sessionID, yolo: true })
  yield* service.setGoal({ sessionID, text: "Finish safely" })
  yield* service.set({ sessionID, sleep: true })
  expect(yield* service.canAutoAnswer(sessionID)).toBe(true)
  const woken = yield* service.set({ sessionID, sleep: false })
  expect(woken.autoAnswer).toBe(true)
  const disabled = yield* service.set({ sessionID, autoAnswer: false })
  expect(disabled.autoAnswer).toBe(false)
  expect(yield* service.canAutoAnswer(sessionID)).toBe(false)
  expect((yield* service.get(sessionID)).yolo).toBe(true)
}))

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      directory: "/project",
      title: "autonomy",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return SessionAutonomy.make({ db })
})

it.effect("exposes one explicit agent no-progress report action", () =>
  Effect.sync(() => {
    expect(Schema.decodeUnknownSync(GoalTool.Input)({ action: "report" })).toEqual({ action: "report" })
    expect(Schema.decodeUnknownSync(GoalTool.Input)({ action: "update", status: "completed" })).toEqual({
      action: "update",
      status: "completed",
    })
  }),
)

it.effect("removes objective text from the agent goal tool input", () =>
  Effect.sync(() => {
    expect(Schema.decodeUnknownSync(GoalTool.Input)({ action: "update", text: "Replace objective" })).toEqual({
      action: "update",
    })
    expect(Schema.decodeUnknownSync(GoalTool.Input)({ action: "set", text: "New objective" })).toEqual({ action: "set" })
  }),
)

it.effect("renders terminal goals as visible Session-state reminders", () =>
  Effect.sync(() => {
    const state = (status: "completed" | "stopped" | "exhausted"): SessionAutonomy.State => ({
      mode: "normal",
      yolo: false,
      goal: {
        text: "Finish the bounded task",
        status,
        iteration: 2,
        noProgress: 1,
        maxNoProgress: 3,
      },
    })
    expect((["completed", "stopped", "exhausted"] as const).map((status) => goalReminder(state(status)))).toEqual([
      "Autonomous goal is completed: Finish the bounded task",
      "Autonomous goal is stopped: Finish the bounded task",
      "Autonomous goal is exhausted: Finish the bounded task",
    ])
  }),
)

it.effect("reminds an active goal's agent that automatic answers and model guardrail judgments stay opt-in", () =>
  Effect.sync(() => {
    const reminder = goalReminder({
      mode: "normal",
      yolo: false,
      goal: { text: "Finish the bounded task", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 },
    })
    expect(reminder).toContain("Required answers remain manual unless the answering Session's auto-answer toggle is on.")
    expect(reminder).toContain("Baseline model assessment of permission and guardrail requests follows guardrails.decide_reviews, which defaults on")
    expect(reminder).toContain("Automatic answers default off.")
    expect(reminder).toContain("a child Session's questions go to its parent Session.")
    expect(reminder).toContain("Goals do not override these gates.")
  }),
)

it.effect("persists modes in the current autonomy column", () =>
  Effect.gen(function* () {
    const service = yield* setup
    expect(yield* service.get(sessionID)).toEqual({ mode: "normal", yolo: false })
    expect(yield* service.setMode({ sessionID, mode: "yolo" })).toEqual({ mode: "normal", yolo: true })
    expect(yield* service.get(sessionID)).toEqual({ mode: "normal", yolo: true })
    const row = yield* (yield* Database.Service).db
      .select({ autonomy: SessionTable.autonomy })
      .from(SessionTable)
      .get()
      .pipe(Effect.orDie)
    expect(row?.autonomy).toEqual({ mode: "normal", yolo: true })
  }),
)

it.effect("snapshots autonomy state with a durable ABA fence", () =>
  Effect.gen(function* () {
    const service = yield* setup
    const initial = yield* service.snapshot(sessionID)
    expect(initial).toEqual({
      state: { mode: "normal", yolo: false },
      sequence: 0,
      digest: "0f21c912261173a7463037b3437f6189d64a8257994877d9e0e9e32264daecad",
    })

    expect(yield* service.report({ sessionID })).toEqual(initial.state)
    expect(yield* service.snapshot(sessionID)).toEqual(initial)

    yield* service.setMode({ sessionID, mode: "yolo" })
    const changed = yield* service.snapshot(sessionID)
    expect(changed.sequence).toBe(1)
    expect(changed.digest).not.toBe(initial.digest)

    yield* service.setMode({ sessionID, mode: "normal" })
    expect(yield* service.snapshot(sessionID)).toEqual({
      state: initial.state,
      sequence: 2,
      digest: initial.digest,
    })
  }),
)

it.effect("serializes concurrent no-progress reports", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix" })

    yield* Effect.all(
      [service.report({ sessionID }), service.report({ sessionID })],
      { concurrency: "unbounded" },
    )

    expect(yield* service.snapshot(sessionID)).toMatchObject({
      state: { mode: "normal", yolo: false, goal: { iteration: 0, noProgress: 2, status: "active" } },
      sequence: 3,
    })
  }),
)

it.effect("persists the original text alongside an active goal", () =>
  Effect.gen(function* () {
    const service = yield* setup

    expect(yield* service.setGoal({ sessionID, text: "Ship the fix" })).toMatchObject({
      mode: "normal",
      yolo: false,
      goal: { text: "Ship the fix", rawText: "Ship the fix", status: "active" },
    })
  }),
)

it.effect("resets a completed goal to active with identical or new text", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 2 })
    yield* service.complete(sessionID)

    expect(yield* service.setGoal({ sessionID, text: "Ship the fix" })).toEqual({
      mode: "normal",
      yolo: false,
      goal: {
        text: "Ship the fix",
        rawText: "Ship the fix",
        status: "active",
        iteration: 0,
        noProgress: 0,
        maxNoProgress: 3,
      },
    })
    yield* service.complete(sessionID)

    expect(yield* service.setGoal({ sessionID, text: "Ship the follow-up" })).toEqual({
      mode: "normal",
      yolo: false,
      goal: {
        text: "Ship the follow-up",
        rawText: "Ship the follow-up",
        status: "active",
        iteration: 0,
        noProgress: 0,
        maxNoProgress: 3,
      },
    })
  }),
)

it.effect("resumes a retained goal without recalculating its text", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 2 })
    yield* service.report({ sessionID })
    yield* service.stop(sessionID)

    const resumed = yield* service.set({ sessionID, goal: true })
    expect(resumed).toEqual({
      mode: "normal",
      yolo: false,
      goal: {
        text: "Ship the fix",
        rawText: "Ship the fix",
        status: "active",
        iteration: 0,
        noProgress: 1,
        maxNoProgress: 2,
      },
    })
  }),
)

it.effect("leaves state untouched when resume has no retained goal", () =>
  Effect.gen(function* () {
    const service = yield* setup
    expect(yield* service.set({ sessionID, goal: true })).toEqual({ mode: "normal", yolo: false })
  }),
)

it.effect("applies a guarded goal calculation only at the expected autonomy revision", () =>
  Effect.gen(function* () {
    const service = yield* setup
    const before = yield* service.snapshot(sessionID)

    const applied = yield* service.setGoalIfCurrent({
      sessionID,
      expectedSequence: before.sequence,
      text: "Calculated goal",
      rawText: "raw request",
      yolo: true,
    })
    expect(applied.applied).toBe(true)
    expect(applied.state.yolo).toBe(true)
    expect(applied.state.goal).toMatchObject({ text: "Calculated goal", rawText: "raw request", status: "active" })

    const current = yield* service.snapshot(sessionID)
    yield* service.stop(sessionID)

    const stale = yield* service.setGoalIfCurrent({
      sessionID,
      expectedSequence: current.sequence,
      text: "Late calculation",
      rawText: "late request",
      yolo: false,
    })
    expect(stale.applied).toBe(false)
    expect(stale.state.yolo).toBe(true)
    expect(stale.state.goal).toMatchObject({ text: "Calculated goal", status: "stopped" })
  }),
)

it.effect("explicit stop preserves the objective and advances the autonomy fence", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setYolo({ sessionID, yolo: true })
    yield* service.setGoal({ sessionID, text: "Verified objective", rawText: "User request" })
    yield* service.report({ sessionID })
    const before = yield* service.snapshot(sessionID)
    const stopped = yield* service.stop(sessionID)
    expect(stopped).toEqual({
      ...before.state, goal: { ...before.state.goal!, status: "stopped" },
    })
    const after = yield* service.snapshot(sessionID)
    expect(after.sequence).toBe(before.sequence + 1)
  }),
)

it.effect("uses every report as one no-progress retry attempt", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 3 })

    expect((yield* service.report({ sessionID })).goal).toMatchObject({
      status: "active",
      iteration: 0,
      noProgress: 1,
    })
    expect((yield* service.report({ sessionID })).goal).toMatchObject({
      status: "active",
      iteration: 0,
      noProgress: 2,
    })
    const exhausted = yield* service.report({ sessionID })
    expect(exhausted).toMatchObject({ mode: "normal", goal: { status: "exhausted", iteration: 0, noProgress: 3 } })

    yield* service.setGoal({ sessionID, text: "Finish" })
    const completed = yield* service.complete(sessionID)
    expect(completed).toMatchObject({ mode: "normal", goal: { status: "completed", iteration: 0 } })
  }),
)

it.effect("explicit stop fences a pending first calculation even without a stored goal", () =>
  Effect.gen(function* () {
    const service = yield* setup
    const first = yield* service.snapshot(sessionID)
    yield* service.set({ sessionID, goal: null })
    expect((yield* service.setGoalIfCurrent({ sessionID, expectedSequence: first.sequence, text: "Late first goal" })).applied).toBe(false)
    const second = yield* service.snapshot(sessionID)
    yield* service.stop(sessionID)
    expect((yield* service.setGoalIfCurrent({ sessionID, expectedSequence: second.sequence, text: "Late replacement" })).applied).toBe(false)
    expect(yield* service.get(sessionID)).toEqual({ mode: "normal", yolo: false })
  }),
)

it.effect("keeps a progressing goal active beyond fifty-one iterations", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix" })

    const states = yield* Effect.forEach(Array.from({ length: 51 }), (_, index) =>
      service.advance({ sessionID, progress: `step ${index}` }),
    )

    expect(states.at(-1)).toMatchObject({
      mode: "normal",
      yolo: false,
      goal: { status: "active", iteration: 51, noProgress: 0 },
    })
  }),
)

it.effect("stops an active goal durably", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Keep going" })
    expect(yield* service.stop(sessionID)).toMatchObject({ mode: "normal", yolo: false, goal: { status: "stopped" } })
    expect(yield* service.get(sessionID)).toMatchObject({ mode: "normal", yolo: false, goal: { status: "stopped" } })
  }),
)

it.effect("keeps goal history when a mode switch leaves goal mode", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Keep going" })
    expect(yield* service.setMode({ sessionID, mode: "yolo" })).toMatchObject({
      mode: "normal",
      yolo: true,
      goal: { text: "Keep going", status: "active" },
    })
    expect(yield* service.get(sessionID)).toMatchObject({ mode: "normal", yolo: true, goal: { status: "active" } })
    expect(yield* service.stop(sessionID)).toMatchObject({
      mode: "normal",
      yolo: true,
      goal: { text: "Keep going", status: "stopped" },
    })

    yield* service.setGoal({ sessionID, text: "Finish" })
    expect(yield* service.setMode({ sessionID, mode: "normal" })).toMatchObject({
      mode: "normal",
      yolo: false,
      goal: { text: "Finish", status: "active" },
    })
  }),
)

it.effect("preserves an already terminal goal status across mode switches", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship it" })
    yield* service.complete(sessionID)
    expect(yield* service.setMode({ sessionID, mode: "yolo" })).toMatchObject({
      mode: "normal",
      yolo: true,
      goal: { status: "completed" },
    })
  }),
)

it.effect("does not spend or reset the no-progress budget when ordinary progress advances", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 2 })

    expect((yield* service.report({ sessionID })).goal).toMatchObject({
      status: "active",
      iteration: 0,
      noProgress: 1,
    })
    expect((yield* service.advance({ sessionID, progress: "Implemented the fix" })).goal).toMatchObject({
      status: "active",
      iteration: 1,
      noProgress: 1,
    })
    expect((yield* service.report({ sessionID })).goal).toMatchObject({
      status: "exhausted",
      iteration: 1,
      noProgress: 2,
    })
  }),
)

it.effect("stored autonomy ignores removed review fields and preserves sleep across goal and YOLO updates", () =>
  Effect.gen(function* () {
    const service = yield* setup
    const database = yield* Database.Service
    yield* database.db.update(SessionTable).set({ autonomy: sql`${JSON.stringify({ mode: "normal", yolo: false, guardrailDecision: true,
      sleep: { priorGuardrailDecision: false } })}` }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    expect(yield* service.get(sessionID)).toEqual({ mode: "normal", yolo: false, sleep: {} })
    yield* service.setYolo({ sessionID, yolo: true })
    yield* service.setGoal({ sessionID, text: "Verify the stored state" })
    expect(yield* service.get(sessionID)).toMatchObject({ yolo: true, sleep: {} })
    expect(yield* service.set({ sessionID, sleep: false })).not.toHaveProperty("guardrailDecision")
    yield* database.db.update(SessionTable).set({ autonomy: sql`${JSON.stringify({ mode: "yolo", yolo: true, guardrailDecision: true,
      sleep: { priorGuardrailDecision: true } })}` }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    expect(yield* service.get(sessionID)).toEqual({ mode: "normal", yolo: false })
  }),
)

for (const prior of [true, false] as const) {
  it.effect(`stored legacy sleep ${prior} decodes as a presence marker and wake clears it`, () =>
    Effect.gen(function* () {
      const service = yield* setup
      const database = yield* Database.Service
      yield* database.db.update(SessionTable).set({ autonomy: sql`${JSON.stringify({ mode: "normal", yolo: false, guardrailDecision: prior,
        sleep: { priorGuardrailDecision: prior } })}` }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      const asleep = yield* service.set({ sessionID, sleep: true })
      expect(asleep.sleep).toEqual({})
      expect(SessionAutonomy.isAsleep(asleep)).toBe(true)
      expect(yield* service.isAsleep(sessionID)).toBe(true)
      const woken = yield* service.set({ sessionID, sleep: false })
      expect(woken.sleep).toBeUndefined()
      expect(woken).not.toHaveProperty("guardrailDecision")
      expect(yield* service.isAsleep(sessionID)).toBe(false)
    }),
  )
}

it.effect("sleep and wake preserve the existing YOLO level", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.set({ sessionID, sleep: true })
    yield* service.set({ sessionID, yolo: true })
    const woken = yield* service.set({ sessionID, sleep: false })
    expect(woken.yolo).toBe(true)
  }),
)

it.effect("child Sessions inherit sleep from the root family", () =>
  Effect.gen(function* () {
    const service = yield* setup
    const { db } = yield* Database.Service
    const childID = Session.ID.make("ses_autonomy_child")
    yield* db
      .insert(SessionTable)
      .values({
        id: childID,
        project_id: Project.ID.global,
        parent_id: sessionID,
        directory: "/project",
        title: "child",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTaskTable)
      .values({
        session_id: childID,
        parent_id: sessionID,
        parent_assistant_message_id: SessionMessage.ID.make("msg_autonomy_parent"),
        tool_call_id: "call_autonomy",
        input_id: SessionMessage.ID.make("msg_autonomy_input"),
        description: "child",
        agent: Agent.ID.make("build"),
        model: CatalogModel.Ref.make({
          providerID: Provider.ID.make("openai"),
          id: CatalogModel.ID.make("gpt-5.6"),
          variant: CatalogModel.VariantID.make("high"),
        }),
        prompt_digest: "digest",
        background: true,
        delivery: "steer",
        state: "running",
        revision: 1,
        time_created: 1,
        time_updated: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    expect(yield* service.isAsleep(childID)).toBe(false)
    yield* service.set({ sessionID, sleep: true })
    expect(yield* service.isAsleep(childID)).toBe(true)
    yield* service.set({ sessionID, sleep: false })
    expect(yield* service.isAsleep(childID)).toBe(false)
    yield* service.set({ sessionID, autoAnswer: true })
    expect(yield* service.canAutoAnswer(sessionID)).toBe(true)
    expect(yield* service.canAutoAnswer(childID)).toBe(false)
    yield* service.set({ sessionID: childID, autoAnswer: true })
    yield* service.set({ sessionID, autoAnswer: false })
    expect(yield* service.canAutoAnswer(sessionID)).toBe(false)
    expect(yield* service.canAutoAnswer(childID)).toBe(true)
    expect(yield* service.canYolo(childID)).toBe(false)
    expect(yield* service.canAutoPermission(childID)).toBe(false)
    yield* service.setYolo({ sessionID, yolo: true })
    yield* service.set({ sessionID, autoPermission: true })
    expect(yield* service.canYolo(childID)).toBe(true)
    expect(yield* service.canAutoPermission(childID)).toBe(true)
    expect(yield* service.canAutoGuardrail(childID)).toBe(false)
  }),
)

it.effect("taskless family members inherit sleep without widening the existing YOLO and goal ladder", () =>
  Effect.gen(function* () {
    const service = yield* setup
    const database = yield* Database.Service
    const childID = Session.ID.make("ses_taskless_autonomy")
    yield* database.db
      .insert(SessionTable)
      .values({
        id: childID,
        project_id: Project.ID.global,
        parent_id: sessionID,
        directory: "/project",
        title: "Taskless child",
      })
      .run()
      .pipe(Effect.orDie)
    yield* service.setYolo({ sessionID, yolo: true })
    yield* service.set({ sessionID, autoPermission: true })
    yield* service.setGoal({ sessionID, text: "Parent objective" })
    yield* service.set({ sessionID, autoAnswer: true })
    expect(yield* service.canYolo(childID)).toBe(false)
    expect(yield* service.canAutoPermission(childID)).toBe(false)
    expect(yield* service.canAutoAnswer(childID)).toBe(false)
    yield* service.set({ sessionID, sleep: true })
    expect(yield* service.isAsleep(childID)).toBe(true)
    expect(yield* service.canAutoPermission(childID)).toBe(false)
  }),
)
