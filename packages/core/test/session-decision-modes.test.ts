import { expect, test } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import type { DecisionMode } from "@ycoding-ai/schema/session-autonomy"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layer({ path: ":memory:" }))
const rootID = Session.ID.make("ses_modes_root")
const childID = Session.ID.make("ses_modes_child")
const grandchildID = Session.ID.make("ses_modes_grandchild")
const tasklessID = Session.ID.make("ses_modes_taskless")
const modes = ["manual", "yolo", "auto"] as const satisfies ReadonlyArray<DecisionMode>
const manual = { permissions: "manual", guardrails: "manual", answers: "manual" } as const

const insertSession = (id: Session.ID, parentID?: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, directory: "/project", title: id, ...(parentID ? { parent_id: parentID } : {}) })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const insertTask = (id: Session.ID, parentID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTaskTable)
      .values({
        session_id: id,
        parent_id: parentID,
        parent_assistant_message_id: SessionMessage.ID.make(`msg_${id}_parent`),
        tool_call_id: `call_${id}`,
        input_id: SessionMessage.ID.make(`msg_${id}_input`),
        description: id,
        agent: Agent.ID.make("build"),
        model: CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("gpt-5.6") }),
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
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(rootID)
  yield* insertSession(childID, rootID)
  yield* insertTask(childID, rootID)
  yield* insertSession(grandchildID, childID)
  yield* insertTask(grandchildID, childID)
  yield* insertSession(tasklessID, rootID)
  return SessionAutonomy.make({ db })
})

const store = (id: Session.ID, value: unknown) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ autonomy: sql`${JSON.stringify(value)}` })
      .where(eq(SessionTable.id, id))
      .run()
      .pipe(Effect.orDie)
  })

it.effect("a new Session starts Manual in every category", () =>
  Effect.gen(function* () {
    const service = yield* setup
    expect(SessionAutonomy.defaultState).toEqual({ mode: "normal", ...manual })
    expect(yield* service.get(rootID)).toEqual({ mode: "normal", ...manual })
    expect(yield* service.effectiveDecisions(rootID)).toEqual({ ...manual, inherited: {} })
  }),
)

for (const permissions of modes)
  for (const guardrails of modes)
    for (const answers of modes)
      it.effect(`persists permissions=${permissions} guardrails=${guardrails} answers=${answers} in one revision`, () =>
        Effect.gen(function* () {
          const service = yield* setup
          const before = yield* service.snapshot(rootID)
          const state = yield* service.set({ sessionID: rootID, permissions, guardrails, answers })
          expect(state).toEqual({ mode: "normal", permissions, guardrails, answers })
          const after = yield* service.snapshot(rootID)
          const changed = permissions !== "manual" || guardrails !== "manual" || answers !== "manual"
          expect(after.sequence).toBe(before.sequence + (changed ? 1 : 0))
          expect(after.state).toEqual(state)
          expect(SessionAutonomy.decisions(after.state)).toEqual({ permissions, guardrails, answers })
          expect(yield* service.effectiveDecisions(rootID)).toEqual({ permissions, guardrails, answers, inherited: {} })
          for (const category of ["permissions", "guardrails", "answers"] as const)
            expect(yield* service.decisionMode(rootID, category)).toBe({ permissions, guardrails, answers }[category])
        }),
      )

it.effect("a partial update changes only the supplied categories and preserves goal and sleep", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.set({ sessionID: rootID, permissions: "auto", guardrails: "yolo", answers: "auto" })
    yield* service.setGoal({ sessionID: rootID, text: "Finish safely" })
    yield* service.set({ sessionID: rootID, sleep: true })
    const state = yield* service.set({ sessionID: rootID, guardrails: "manual" })
    expect(state).toMatchObject({ mode: "normal", permissions: "auto", guardrails: "manual", answers: "auto", sleep: {} })
    expect(state.goal).toMatchObject({ text: "Finish safely", status: "active" })
    const woken = yield* service.set({ sessionID: rootID, sleep: false })
    expect(woken).toMatchObject({ permissions: "auto", guardrails: "manual", answers: "auto" })
  }),
)

it.effect("an invalid decision mode is rejected and leaves the stored state unchanged", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.set({ sessionID: rootID, permissions: "auto" })
    const before = yield* service.snapshot(rootID)
    for (const value of [true, false, 1, "on", "Auto", null])
      expect((yield* service.set({ sessionID: rootID, answers: value as never }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* service.snapshot(rootID)).toEqual(before)
  }),
)

it.effect("an active goal grants no category authority", () =>
  Effect.gen(function* () {
    const service = yield* setup
    const state = yield* service.setGoal({ sessionID: rootID, text: "Finish safely" })
    expect(SessionAutonomy.decisions(state)).toEqual(manual)
    expect(yield* service.effectiveDecisions(rootID)).toEqual({ ...manual, inherited: {} })
  }),
)

test("the stored reader accepts only the current shape and fails closed", () => {
  const goal = { text: "Finish", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } as const
  expect(SessionAutonomy.read({ mode: "normal", permissions: "auto", guardrails: "yolo", answers: "manual", goal, sleep: {} })).toEqual({
    mode: "normal",
    permissions: "auto",
    guardrails: "yolo",
    answers: "manual",
    goal,
    sleep: {},
  })
  expect(
    SessionAutonomy.read({ mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", guardrailDecision: true }),
  ).toEqual({ mode: "normal", ...manual })
  for (const value of [
    undefined,
    null,
    "auto",
    { mode: "normal" },
    { mode: "normal", yolo: true },
    { mode: "normal", yolo: true, autoPermission: true, autoGuardrail: true, autoAnswer: true },
    { mode: "normal", yolo: 2 },
    { mode: "yolo", permissions: "auto", guardrails: "auto", answers: "auto" },
    { mode: "normal", permissions: "auto", guardrails: "auto" },
    { mode: "normal", permissions: true, guardrails: "auto", answers: "auto" },
    { mode: "normal", permissions: "on", guardrails: "auto", answers: "auto" },
    { mode: "normal", permissions: "auto", guardrails: "auto", answers: "auto", yolo: false },
    { mode: "normal", permissions: "auto", guardrails: "auto", answers: "auto", yolo: true },
    { mode: "normal", permissions: "auto", guardrails: "auto", answers: "auto", autoPermission: true },
    { mode: "normal", permissions: "auto", guardrails: "auto", answers: "auto", autoGuardrail: false },
    { mode: "normal", permissions: "auto", guardrails: "auto", answers: "auto", autoAnswer: true },
  ])
    expect(SessionAutonomy.read(value)).toEqual({ mode: "normal", ...manual })
})

it.effect("a stored old-shape state reads as Manual and grants nothing", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* store(rootID, { mode: "normal", yolo: true, autoPermission: true, autoGuardrail: true, autoAnswer: true })
    yield* store(childID, { mode: "normal", yolo: true, autoPermission: true })
    expect(yield* service.get(rootID)).toEqual({ mode: "normal", ...manual })
    expect(yield* service.effectiveDecisions(childID)).toEqual({ ...manual, inherited: { guardrails: rootID } })
  }),
)

it.effect("permissions: Auto anywhere in the managed-task chain wins over YOLO and Manual and names its source", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.set({ sessionID: rootID, permissions: "auto" })
    yield* service.set({ sessionID: childID, permissions: "yolo" })
    expect((yield* service.effectiveDecisions(grandchildID)).permissions).toBe("auto")
    expect((yield* service.effectiveDecisions(grandchildID)).inherited.permissions).toBe(rootID)
    expect((yield* service.effectiveDecisions(childID)).inherited.permissions).toBe(rootID)
    yield* service.set({ sessionID: grandchildID, permissions: "auto" })
    const local = yield* service.effectiveDecisions(grandchildID)
    expect(local.permissions).toBe("auto")
    expect(local.inherited.permissions).toBeUndefined()
    yield* service.set({ sessionID: rootID, permissions: "manual" })
    yield* service.set({ sessionID: grandchildID, permissions: "manual" })
    const yolo = yield* service.effectiveDecisions(grandchildID)
    expect(yolo.permissions).toBe("yolo")
    expect(yolo.inherited.permissions).toBe(childID)
    expect(yield* service.decisionMode(grandchildID, "permissions")).toBe("yolo")
    yield* service.set({ sessionID: grandchildID, permissions: "yolo" })
    expect((yield* service.effectiveDecisions(grandchildID)).inherited.permissions).toBeUndefined()
    yield* service.set({ sessionID: childID, permissions: "auto" })
    expect(yield* service.effectiveDecisions(grandchildID)).toMatchObject({ permissions: "auto", inherited: { permissions: childID } })
  }),
)

it.effect("permissions and answers never inherit into a taskless family member", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.set({ sessionID: rootID, permissions: "auto", answers: "yolo" })
    const taskless = yield* service.effectiveDecisions(tasklessID)
    expect(taskless.permissions).toBe("manual")
    expect(taskless.answers).toBe("manual")
    expect(taskless.inherited.permissions).toBeUndefined()
    expect(taskless.inherited.answers).toBeUndefined()
  }),
)

it.effect("guardrails always follow the root family and child views name the root as their source", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.set({ sessionID: childID, guardrails: "auto" })
    for (const id of [childID, grandchildID, tasklessID]) {
      const effective = yield* service.effectiveDecisions(id)
      expect(effective.guardrails).toBe("manual")
      expect(effective.inherited.guardrails).toBe(rootID)
      expect(yield* service.decisionMode(id, "guardrails")).toBe("manual")
    }
    yield* service.set({ sessionID: rootID, guardrails: "yolo" })
    for (const id of [childID, grandchildID, tasklessID])
      expect(yield* service.effectiveDecisions(id)).toMatchObject({ guardrails: "yolo", inherited: { guardrails: rootID } })
    const root = yield* service.effectiveDecisions(rootID)
    expect(root.guardrails).toBe("yolo")
    expect(root.inherited.guardrails).toBeUndefined()
  }),
)

it.effect("answers: local Auto wins, inherited YOLO stays visible under local Manual, and ancestor Auto never propagates", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.set({ sessionID: rootID, answers: "auto" })
    expect(yield* service.effectiveDecisions(grandchildID)).toMatchObject({ answers: "manual", inherited: {} })
    expect((yield* service.effectiveDecisions(grandchildID)).inherited.answers).toBeUndefined()
    yield* service.set({ sessionID: childID, answers: "yolo" })
    const inherited = yield* service.effectiveDecisions(grandchildID)
    expect(inherited.answers).toBe("yolo")
    expect(inherited.inherited.answers).toBe(childID)
    expect(yield* service.decisionMode(grandchildID, "answers")).toBe("yolo")
    expect((yield* service.effectiveDecisions(rootID)).answers).toBe("auto")
    yield* service.set({ sessionID: grandchildID, answers: "auto" })
    const local = yield* service.effectiveDecisions(grandchildID)
    expect(local.answers).toBe("auto")
    expect(local.inherited.answers).toBeUndefined()
    yield* service.set({ sessionID: grandchildID, answers: "yolo" })
    expect((yield* service.effectiveDecisions(grandchildID)).inherited.answers).toBeUndefined()
    yield* service.set({ sessionID: grandchildID, answers: "manual" })
    yield* service.set({ sessionID: childID, answers: "manual" })
    yield* service.set({ sessionID: rootID, answers: "yolo" })
    expect(yield* service.effectiveDecisions(grandchildID)).toMatchObject({ answers: "yolo", inherited: { answers: rootID } })
  }),
)

it.effect("the inherited snapshot fences ancestor answer-mode changes but not sibling changes", () =>
  Effect.gen(function* () {
    const service = yield* setup
    yield* service.set({ sessionID: rootID, answers: "yolo" })
    const held = yield* service.snapshot(grandchildID, { inherited: true })
    yield* service.set({ sessionID: tasklessID, answers: "auto" })
    expect(yield* service.snapshot(grandchildID, { inherited: true })).toEqual(held)
    yield* service.set({ sessionID: rootID, answers: "manual" })
    yield* service.set({ sessionID: rootID, answers: "yolo" })
    expect((yield* service.snapshot(grandchildID, { inherited: true })).digest).not.toBe(held.digest)
  }),
)
