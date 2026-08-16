import { expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layer({ path: ":memory:" }))
const sessionID = SessionV2.ID.make("ses_autonomy")

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

it.effect("persists modes in the current autonomy column", () =>
  Effect.gen(function* () {
    const service = yield* setup
    expect(yield* service.get(sessionID)).toEqual({ mode: "normal" })
    expect(yield* service.setMode({ sessionID, mode: "yolo" })).toEqual({ mode: "yolo" })
    expect(yield* service.get(sessionID)).toEqual({ mode: "yolo" })
    const row = yield* (yield* Database.Service).db
      .select({ autonomy: SessionTable.autonomy })
      .from(SessionTable)
      .get()
      .pipe(Effect.orDie)
    expect(row?.autonomy).toEqual({ mode: "yolo" })
  }),
)

it.effect("snapshots autonomy state with a durable ABA fence", () =>
  Effect.gen(function* () {
    const service = yield* setup
    const initial = yield* service.snapshot(sessionID)
    expect(initial).toEqual({
      state: { mode: "normal" },
      sequence: 0,
      digest: "fa76e6a145e80d3ef8d955abd5a17426feba569df832d2cf6af7dbd5b86c5240",
    })

    expect(yield* service.advance({ sessionID, progress: "ignored" })).toEqual(initial.state)
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

it.effect("serializes concurrent state-dependent autonomy advances", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix" })

    yield* Effect.all(
      [service.advance({ sessionID, progress: "first" }), service.advance({ sessionID, progress: "second" })],
      { concurrency: "unbounded" },
    )

    expect(yield* service.snapshot(sessionID)).toMatchObject({
      state: { mode: "goal", goal: { iteration: 2, status: "active" } },
      sequence: 3,
    })
  }),
)

it.effect("persists the original text alongside an active goal", () =>
  Effect.gen(function* () {
    const service = yield* setup

    expect(yield* service.setGoal({ sessionID, text: "Ship the fix" })).toMatchObject({
      mode: "goal",
      goal: { text: "Ship the fix", rawText: "Ship the fix", status: "active" },
    })
  }),
)

it.effect("resets a completed goal to active with identical or new text", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 2 })
    yield* service.advance({ sessionID, progress: "done", completed: true })

    expect(yield* service.setGoal({ sessionID, text: "Ship the fix" })).toEqual({
      mode: "goal",
      goal: {
        text: "Ship the fix",
        rawText: "Ship the fix",
        status: "active",
        iteration: 0,
        noProgress: 0,
        maxNoProgress: 3,
      },
    })
    yield* service.advance({ sessionID, progress: "done", completed: true })

    expect(yield* service.setGoal({ sessionID, text: "Ship the follow-up" })).toEqual({
      mode: "goal",
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

it.effect("ends goal continuation by completion and repeated no-progress", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 3 })

    expect((yield* service.advance({ sessionID, progress: "step one" })).goal).toMatchObject({
      status: "active",
      iteration: 1,
      noProgress: 0,
    })
    expect((yield* service.advance({ sessionID, progress: "step one" })).goal).toMatchObject({
      status: "active",
      iteration: 2,
      noProgress: 1,
    })
    expect((yield* service.advance({ sessionID, progress: "step one" })).goal).toMatchObject({
      status: "active",
      iteration: 3,
      noProgress: 2,
    })
    const exhausted = yield* service.advance({ sessionID, progress: "step one" })
    expect(exhausted).toMatchObject({ mode: "normal", goal: { status: "exhausted", iteration: 4, noProgress: 3 } })

    yield* service.setGoal({ sessionID, text: "Finish" })
    const completed = yield* service.advance({ sessionID, progress: "done", completed: true })
    expect(completed).toMatchObject({ mode: "normal", goal: { status: "completed", iteration: 1 } })
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
      mode: "goal",
      goal: { status: "active", iteration: 51, noProgress: 0 },
    })
  }),
)

it.effect("stops an active goal durably", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Keep going" })
    expect(yield* service.stop(sessionID)).toMatchObject({ mode: "normal", goal: { status: "stopped" } })
    expect(yield* service.get(sessionID)).toMatchObject({ mode: "normal", goal: { status: "stopped" } })
  }),
)

it.effect("keeps goal history when a mode switch leaves goal mode", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Keep going" })
    expect(yield* service.setMode({ sessionID, mode: "normal" })).toMatchObject({
      mode: "normal",
      goal: { text: "Keep going", status: "stopped" },
    })
    expect(yield* service.get(sessionID)).toMatchObject({ mode: "normal", goal: { status: "stopped" } })

    yield* service.setGoal({ sessionID, text: "Finish" })
    expect(yield* service.setMode({ sessionID, mode: "yolo" })).toMatchObject({
      mode: "yolo",
      goal: { text: "Finish", status: "stopped" },
    })
  }),
)

it.effect("preserves an already terminal goal status across mode switches", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship it" })
    yield* service.advance({ sessionID, progress: "done", completed: true })
    expect(yield* service.setMode({ sessionID, mode: "yolo" })).toMatchObject({
      mode: "yolo",
      goal: { status: "completed" },
    })
  }),
)

it.effect("treats a text-free turn as neither progress nor repetition", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 2 })

    // Turns that end on tool calls carry no assistant text; absence of text is not a repeat.
    expect((yield* service.advance({ sessionID, progress: "" })).goal).toMatchObject({
      status: "active",
      iteration: 1,
      noProgress: 0,
    })
    expect((yield* service.advance({ sessionID, progress: "   " })).goal).toMatchObject({
      status: "active",
      iteration: 2,
      noProgress: 0,
    })
    expect((yield* service.advance({ sessionID, progress: "\n\t" })).goal).toMatchObject({
      status: "active",
      iteration: 3,
      noProgress: 0,
    })
  }),
)

it.effect("still detects repeated assistant text across a text-free turn", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 2 })

    expect((yield* service.advance({ sessionID, progress: "same" })).goal).toMatchObject({ noProgress: 0 })
    expect((yield* service.advance({ sessionID, progress: "" })).goal).toMatchObject({ noProgress: 0 })
    expect((yield* service.advance({ sessionID, progress: "same" })).goal).toMatchObject({ noProgress: 1 })
    expect((yield* service.advance({ sessionID, progress: "same" })).goal).toMatchObject({
      status: "exhausted",
      noProgress: 2,
    })
  }),
)

it.effect("creates continuation instructions and recognizes only the explicit completion marker", () =>
  Effect.sync(() => {
    const goal: SessionAutonomy.Goal = {
      text: "Ship the fix",
      status: "active",
      iteration: 2,
      noProgress: 0,
      maxNoProgress: 3,
    }
    const prompt = SessionAutonomy.continuationPrompt(goal)
    expect(prompt).toContain("Goal: Ship the fix")
    expect(prompt).toContain("Continuation: 3")
    expect(SessionAutonomy.isCompleted("work complete")).toBe(false)
    expect(SessionAutonomy.isCompleted(`verified ${SessionAutonomy.CompletionMarker}`)).toBe(true)
    // Models normalize self-closing tags, so the detector tolerates the spacing they emit.
    expect(SessionAutonomy.isCompleted("verified <goal-complete />")).toBe(true)
    expect(SessionAutonomy.isCompleted("verified `<goal-complete/>`")).toBe(true)
    expect(SessionAutonomy.isCompleted("<goal-completed/>")).toBe(false)
    expect(SessionAutonomy.isCompleted("<goal-complete>")).toBe(false)
  }),
)

it.effect("answers a free-text assistant question on the user's behalf before continuing the goal", () =>
  Effect.sync(() => {
    const goal: SessionAutonomy.Goal = {
      text: "Ship the fix",
      status: "active",
      iteration: 0,
      noProgress: 0,
      maxNoProgress: 3,
    }
    const prompt = SessionAutonomy.continuationPrompt(goal, {
      latestAssistantText: "Which database should I use?",
    })

    expect(prompt).toContain("The assistant is waiting for user input.")
    expect(prompt).toContain("Latest assistant request: Which database should I use?")
    expect(prompt).toContain("Answer it on the user's behalf")
    expect(
      SessionAutonomy.continuationPrompt(goal, { latestAssistantText: "Implemented the migration." }),
    ).not.toContain("The assistant is waiting for user input.")
  }),
)
