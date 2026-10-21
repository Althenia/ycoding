import { expect, test } from "bun:test"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import type { AutonomyState } from "../src/util/session-autonomy"
import {
  activateGoal,
  autonomyDecisionKind,
  autonomyDecisionLabel,
  autonomyModeLabel,
  autonomyModeParts,
  autonomyProgressLabel,
  autonomyToggleDescription,
  autonomyToggleTitle,
  createSessionAutonomyRefreshGuard,
  goalToggleAction,
  localAutonomyView,
  parseGoalCommand,
  parseToggleArg,
  yoloLabel,
  yoloOn,
} from "../src/util/session-autonomy"

function autonomyView(input: {
  yolo?: boolean
  effectiveYolo?: boolean
  goal?: boolean
  sleep?: boolean
  autoPermission?: boolean
  autoGuardrail?: boolean
  autoAnswer?: boolean
  permissionsAuto?: boolean
  permissionModelReviews?: boolean
  guardrailsEnabled?: boolean
  ordinaryReviewsAuto?: boolean
  modelReviews?: boolean
  hardModelReviews?: boolean
} = {}): SessionAutonomyView {
  const yolo = input.yolo ?? false
  return {
    mode: "normal",
    yolo,
    ...(input.goal ? { goal: { text: "ship", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 } } : {}),
    ...(input.sleep ? { sleep: {} } : {}),
    ...(input.autoPermission === undefined ? {} : { autoPermission: input.autoPermission }),
    ...(input.autoGuardrail === undefined ? {} : { autoGuardrail: input.autoGuardrail }),
    ...(input.autoAnswer === undefined ? {} : { autoAnswer: input.autoAnswer }),
    effective: {
      yolo: input.effectiveYolo ?? yolo,
      permissionsAuto: input.permissionsAuto ?? (input.autoPermission ?? false),
      permissionModelReviews: input.permissionModelReviews ?? false,
      asleep: input.sleep ?? false,
      guardrailsEnabled: input.guardrailsEnabled ?? true,
      ordinaryReviewsAuto: input.ordinaryReviewsAuto ?? ((input.autoGuardrail ?? false) && !(input.sleep ?? false)),
      modelReviews: input.modelReviews ?? false,
      hardModelReviews: input.hardModelReviews ?? false,
    },
  } as unknown as SessionAutonomyView
}

test("accepts only a boolean yolo; numeric values fail closed as unknown", () => {
  expect([true, false].map((yolo) => yoloOn({ yolo }))).toEqual([true, false])
  expect([0, 1, 2, 3, 1.5, Number.NaN, "true", null, undefined].map((yolo) => yoloOn({ yolo }))).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
  expect(parseToggleArg(undefined)).toBeUndefined()
  expect(parseToggleArg("on")).toBe(true)
  expect(parseToggleArg("off")).toBe(false)
  for (const token of ["0", "1", "2", "yes", "true"]) expect(parseToggleArg(token)).toBeNull()
  expect(yoloLabel(true)).toBe("YOLO")
  expect(yoloLabel(false)).toBe("YOLO off")
})

test("each auto flag decides only its own row and yolo evaluates what the flags leave", () => {
  const labels = (view: SessionAutonomyView) =>
    (["permissions", "guardrails", "questions"] as const).map((action) => autonomyDecisionLabel(view, action))
  expect(labels(autonomyView({}))).toEqual(["manual", "manual", "manual"])
  expect(labels(autonomyView({ goal: true }))).toEqual(["manual", "manual", "manual"])
  expect(labels(autonomyView({ yolo: true }))).toEqual(["yolo", "yolo", "yolo"])
  expect(labels(autonomyView({ yolo: true, goal: true }))).toEqual(["yolo", "yolo", "yolo"])
  expect(labels(autonomyView({ autoPermission: true }))).toEqual(["auto", "manual", "manual"])
  expect(labels(autonomyView({ autoGuardrail: true }))).toEqual(["manual", "auto", "manual"])
  expect(labels(autonomyView({ autoAnswer: true }))).toEqual(["manual", "manual", "auto"])
  expect(labels(autonomyView({ yolo: true, autoPermission: true, autoGuardrail: true }))).toEqual(["auto", "auto", "yolo"])
  expect(labels(autonomyView({ yolo: true, autoPermission: true, autoGuardrail: true, autoAnswer: true }))).toEqual(["auto", "auto", "auto"])
  expect(labels(autonomyView({ permissionsAuto: true, ordinaryReviewsAuto: true }))).toEqual(["auto", "auto", "manual"])
  expect(labels(autonomyView({ yolo: false, effectiveYolo: true }))).toEqual(["yolo", "yolo", "yolo"])
})

test("decision kinds separate manual from automated rows", () => {
  const kinds = (view: SessionAutonomyView | undefined) =>
    (["permissions", "guardrails", "questions"] as const).map((action) => autonomyDecisionKind(view, action))
  expect(kinds(autonomyView({}))).toEqual(["manual", "manual", "manual"])
  expect(kinds(autonomyView({ yolo: true }))).toEqual(["automated", "automated", "automated"])
  expect(kinds(autonomyView({ sleep: true }))).toEqual(["automated", "automated", "automated"])
  expect(kinds(autonomyView({ guardrailsEnabled: false }))).toEqual(["manual", "manual", "manual"])
  expect(kinds(undefined)).toEqual(["unknown", "unknown", "unknown"])
})

test("baseline permission model assessment shows the human decider without any auto flag", () => {
  const baseline = autonomyView({ permissionModelReviews: true })
  expect(autonomyDecisionLabel(baseline, "permissions")).toBe("manual")
  expect(autonomyDecisionLabel(autonomyView({ permissionModelReviews: true, sleep: true }), "permissions")).toBe("review box")
  expect(autonomyDecisionLabel(autonomyView({ permissionModelReviews: true, autoPermission: true }), "permissions")).toBe("auto")
  expect(autonomyDecisionLabel(autonomyView({ permissionModelReviews: true, yolo: true }), "permissions")).toBe("yolo")
})

test("the local autonomy view defaults baseline permission model reviews on without numeric fallback", () => {
  const view = localAutonomyView({ mode: "normal", yolo: false })
  expect(view.effective).toMatchObject({ yolo: false, permissionsAuto: false, permissionModelReviews: true, ordinaryReviewsAuto: false })
  const numeric = localAutonomyView({ mode: "normal", yolo: 2 as never })
  expect(numeric.effective.yolo).toBe(false)
  expect(numeric.effective.permissionsAuto).toBe(false)
})

test("auto-answer outranks yolo and yolo answers only while auto-answer is off", () => {
  expect(autonomyDecisionLabel(autonomyView({ autoAnswer: true }), "questions")).toBe("auto")
  expect(autonomyDecisionLabel(autonomyView({ yolo: true, autoAnswer: true }), "questions")).toBe("auto")
  expect(autonomyDecisionLabel(autonomyView({ yolo: true, autoAnswer: false }), "questions")).toBe("yolo")
  expect(autonomyDecisionLabel(autonomyView({ autoAnswer: false }), "questions")).toBe("manual")
  const sleeping = autonomyView({ sleep: true, autoAnswer: true, goal: true })
  expect(autonomyDecisionLabel(sleeping, "questions")).toBe("auto")
})

test("sleep adds no grant: off automation defers to the review box", () => {
  const view = autonomyView({ sleep: true })
  expect(autonomyDecisionLabel(view, "guardrails")).toBe("review box")
  expect(autonomyDecisionLabel(view, "questions")).toBe("review box")
  expect(autonomyDecisionLabel(view, "permissions")).toBe("review box")
  const yolo = autonomyView({ yolo: true, sleep: true })
  for (const action of ["permissions", "guardrails", "questions"] as const) expect(autonomyDecisionLabel(yolo, action)).toBe("yolo")
  expect(autonomyDecisionLabel(autonomyView({ autoPermission: true, sleep: true }), "permissions")).toBe("auto")
  expect(autonomyDecisionLabel(autonomyView({ autoGuardrail: true, sleep: true, modelReviews: true }), "guardrails")).toBe(
    "review box",
  )
})

test("ordinary guardrail rows read the actual live model-review flags", () => {
  expect(autonomyDecisionLabel(autonomyView({ modelReviews: true }), "guardrails")).toBe("manual")
  expect(autonomyDecisionLabel(autonomyView({ modelReviews: true, sleep: true }), "guardrails")).toBe("review box")
  expect(autonomyDecisionLabel(autonomyView({ autoGuardrail: true, modelReviews: true }), "guardrails")).toBe("auto")
  expect(autonomyDecisionLabel(autonomyView({ yolo: true, modelReviews: true }), "guardrails")).toBe("yolo")
  expect(autonomyDecisionLabel(autonomyView({ guardrailsEnabled: false }), "guardrails")).toBe("disabled")
  expect(autonomyDecisionLabel(autonomyView({ guardrailsEnabled: false, yolo: true }), "guardrails")).toBe("disabled")
  expect(autonomyDecisionLabel(autonomyView({ guardrailsEnabled: false, ordinaryReviewsAuto: true }), "guardrails")).toBe("disabled")
})

test("auto-guardrail without backend ordinary-review authority still asks for ordinary reviews", () => {
  const view = autonomyView({ autoPermission: true, autoGuardrail: true, ordinaryReviewsAuto: false })
  expect(autonomyDecisionLabel(view, "permissions")).toBe("auto")
  expect(autonomyDecisionLabel(view, "guardrails")).toBe("manual")
  const modeled = autonomyView({ autoGuardrail: true, ordinaryReviewsAuto: false, modelReviews: true })
  expect(autonomyDecisionLabel(modeled, "guardrails")).toBe("manual")
})

test("an unloaded read is unknown, never an off state", () => {
  for (const action of ["permissions", "guardrails", "questions"] as const)
    expect(autonomyDecisionLabel(undefined, action)).toBe("unknown")
  expect(autonomyModeParts(undefined)).toEqual(["unknown"])
  expect(autonomyModeLabel(undefined)).toBe("unknown")
})

test("lists active modes in shared order", () => {
  const view = autonomyView({ yolo: true, autoPermission: true, autoGuardrail: true, sleep: true, goal: true, autoAnswer: true })
  expect(autonomyModeParts(view)).toEqual(["YOLO", "permissions auto", "goal", "asleep", "answers auto"])
  expect(autonomyModeParts(autonomyView({ yolo: true, autoGuardrail: true, goal: true }))).toEqual(["YOLO", "guardrails auto", "goal"])
  expect(autonomyModeParts(autonomyView({}))).toEqual(["YOLO off"])
  expect(autonomyModeParts(autonomyView({ effectiveYolo: true }))).toEqual(["YOLO"])
})

test("represents explicit goal reports through the progress label", () => {
  expect(
    autonomyProgressLabel({
      mode: "normal",
      yolo: false,
      goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 7,
        noProgress: 2,
        maxNoProgress: 3,
      },
    }),
  ).toBe("7 · no progress 2/3")
})

test("rejects a completed refresh that began before a local goal activation", () => {
  const guard = createSessionAutonomyRefreshGuard()
  const stale = guard.refresh()
  guard.invalidate()
  const current = guard.refresh()

  expect(guard.accepts(stale)).toBe(false)
  expect(guard.accepts(current)).toBe(true)
})

test("rejects an older refresh after a newer refresh starts", () => {
  const guard = createSessionAutonomyRefreshGuard()
  const stale = guard.refresh()
  const current = guard.refresh()

  expect(guard.accepts(stale)).toBe(false)
  expect(guard.accepts(current)).toBe(true)
})

test("labels yolo, auto flags, and goal state", () => {
  expect(autonomyModeLabel(autonomyView({}))).toBe("YOLO off")
  expect(autonomyModeLabel(autonomyView({ yolo: true }))).toBe("YOLO")
  expect(autonomyModeLabel(autonomyView({ goal: true }))).toBe("YOLO off · goal")
  expect(autonomyModeLabel(autonomyView({ yolo: true, autoPermission: true, goal: true, autoAnswer: true }))).toBe(
    "YOLO · permissions auto · goal · answers auto",
  )
})

function terminal(
  status: "completed" | "exhausted" | "stopped",
  overrides: { iteration?: number; noProgress?: number; maxNoProgress?: number } = {},
): AutonomyState {
  return {
    mode: "normal",
    yolo: false,
    goal: {
      text: "Finish the migration",
      status,
      iteration: overrides.iteration ?? 3,
      noProgress: overrides.noProgress ?? 0,
      maxNoProgress: overrides.maxNoProgress ?? 3,
    },
  }
}

test("formats goal progress", () => {
  expect(
    autonomyProgressLabel({
      mode: "normal",
      yolo: false,
      goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 2,
        noProgress: 1,
        maxNoProgress: 3,
      },
    }),
  ).toBe("2 · no progress 1/3")
  expect(autonomyProgressLabel({ mode: "normal", yolo: false })).toBeUndefined()
})

test("renders goal iteration separately from no-progress", () => {
  expect(
    autonomyProgressLabel({
      mode: "normal",
      yolo: false,
      goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 50,
        noProgress: 1,
        maxNoProgress: 3,
      },
    }),
  ).toBe("50 · no progress 1/3")
})

test("reports how a finished goal ended", () => {
  expect(autonomyProgressLabel(terminal("completed"))).toBe("completed after 3 iterations")
  expect(autonomyProgressLabel(terminal("stopped"))).toBe("stopped after 3 iterations")
  expect(autonomyProgressLabel(terminal("exhausted", { iteration: 12 }))).toBe(
    "exhausted after 0/3 repeats without progress",
  )
  expect(autonomyProgressLabel(terminal("exhausted", { noProgress: 3 }))).toBe(
    "exhausted after 3/3 repeats without progress",
  )
})

test("parses single-line, multiline, non-goal, and empty goal commands", () => {
  expect(parseGoalCommand("/goal Finish the migration")).toEqual({ goal: "Finish the migration" })
  expect(parseGoalCommand("/goal Finish the migration\nRun the tests")).toEqual({
    goal: "Finish the migration\nRun the tests",
  })
  expect(parseGoalCommand("/goals Finish the migration")).toBeUndefined()
  expect(parseGoalCommand("/goal")).toEqual({ goal: "" })
})

test("stops an active goal on a bare toggle", () => {
  expect(
    goalToggleAction({
      mode: "normal",
      yolo: false,
      goal: { text: "Finish the migration", status: "active", iteration: 2, noProgress: 0, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "stop" })
})

test("resumes a retained goal without inventing or recalculating its objective", () => {
  expect(
    goalToggleAction({
      mode: "normal",
      yolo: false,
      goal: { text: "Finish the migration", status: "completed", iteration: 4, noProgress: 1, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "resume", text: "Finish the migration" })
  expect(
    goalToggleAction({
      mode: "normal",
      yolo: false,
      goal: { text: "Finish the migration", status: "stopped", iteration: 1, noProgress: 0, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "resume", text: "Finish the migration" })
})

test("requests an explicit objective when no retained goal text exists", () => {
  expect(goalToggleAction({ mode: "normal", yolo: false })).toEqual({ type: "request-objective" })
  expect(
    goalToggleAction({
      mode: "normal",
      yolo: false,
      goal: { text: "   ", status: "stopped", iteration: 0, noProgress: 0, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "request-objective" })
})

test("does not reset an active goal when its original text is re-activated", async () => {
  const calls: string[] = []
  await activateGoal({
    sessionID: "ses_123",
    goal: "Fix the migration failure",
    get: async () => ({
      mode: "normal" as const,
      yolo: false,
      goal: {
        text: "Repair the migration and verify the suite passes.",
        rawText: "Fix the migration failure",
        status: "active" as const,
        iteration: 1,
        noProgress: 0,
        maxNoProgress: 3,
      },
    }),
    set: async () => {
      calls.push("set")
      throw new Error("an active goal with the same original text must not be reset")
    },
  })

  expect(calls).toEqual([])
})

test("calculates and replaces the goal when new objective text is submitted", async () => {
  const calls: string[] = []
  const state = await activateGoal({
    sessionID: "ses_123",
    goal: "Replace migration",
    get: async () => ({ mode: "normal" as const, yolo: false }),
    set: async (payload) => {
      calls.push(payload.goal)
      return {
        mode: "normal" as const,
        yolo: false,
        goal: {
          text: "Repair the migration and verify the suite passes.",
          rawText: payload.goal,
          status: "active" as const,
          iteration: 0,
          noProgress: 0,
          maxNoProgress: 3,
        },
      }
    },
  })

  expect(calls).toEqual(["Replace migration"])
  expect(autonomyProgressLabel(state)).toBe("0 · no progress 0/3")
})

test("surfaces a failed calculation so the dialog can preserve the draft", async () => {
  await expect(
    activateGoal({
      sessionID: "ses_123",
      goal: "Replace migration",
      get: async () => ({ mode: "normal" as const, yolo: false }),
      set: async () => {
        throw new Error("goal.calculation_failed")
      },
    }),
  ).rejects.toThrow("goal.calculation_failed")
})

test("keeps the goal dialog retry identity for a failed submission", async () => {
  const util = await import("../src/util/session-autonomy")
  const original = util.retainSessionSubmission(undefined, "/goal Finish migration", 0, {
    goal: "Finish migration",
  })
  original.sessionID = "ses_123"

  const changed = util.retainSessionSubmission(original, "/goal Replace migration", 0, {
    goal: "Replace migration",
  })

  expect(changed).toBe(original)
  expect(changed.sessionID).toBe("ses_123")
  expect(changed.promptID).toBe(original.promptID)
  expect(changed.payload).toEqual({ goal: "Finish migration" })
})

test("exposes autonomy only for the connected active session", async () => {
  const util = await import("../src/util/session-autonomy")
  const currentSessionAutonomy = Reflect.get(util, "currentSessionAutonomy")
  expect(typeof currentSessionAutonomy).toBe("function")
  if (typeof currentSessionAutonomy !== "function") return

  const goal = autonomyView({ yolo: false, goal: true })
  const response = { sessionID: "ses_old", state: goal }

  expect(currentSessionAutonomy("ses_new", true, response)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", false, response)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", true, undefined)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", true, response)).toEqual(goal)
})

test("toggle descriptions state each control's own grant", () => {
  expect(autonomyToggleDescription("yolo")).toBe("evaluates unresolved requests")
  expect(autonomyToggleDescription("autoPermission")).toBe("approves ask permissions")
  expect(autonomyToggleDescription("autoGuardrail")).toBe("approves ordinary reviews while awake")
  expect(autonomyToggleDescription("autoAnswer")).toBe("uses explicit defaults")
})

test("toggle titles show the loaded state and read unknown without one", () => {
  const state = localAutonomyView({ mode: "normal", yolo: false, autoAnswer: true })
  expect(autonomyToggleTitle(state, "yolo")).toBe("Toggle YOLO: off")
  expect(autonomyToggleTitle(state, "autoAnswer")).toBe("Toggle Auto-answer: on")
  expect(autonomyToggleTitle(undefined, "autoPermission")).toBe("Toggle Auto-permission: unknown")
})

test("toggle titles mark a local off that an inherited setting overrides", () => {
  const inherited = autonomyView({ yolo: false, effectiveYolo: true, autoPermission: false, permissionsAuto: true, autoGuardrail: false, autoAnswer: false })
  expect(autonomyToggleTitle(inherited, "yolo")).toBe("YOLO: inherited on")
  expect(autonomyToggleTitle(inherited, "autoPermission")).toBe("Auto-permission: inherited on")
  expect(autonomyToggleTitle(inherited, "autoGuardrail")).toBe("Toggle Auto-guardrail: off")
  expect(autonomyToggleTitle(inherited, "autoAnswer")).toBe("Toggle Auto-answer: off")
  const guardrail = { ...inherited, effective: { ...inherited.effective, ordinaryReviewsAuto: true } }
  expect(autonomyToggleTitle(guardrail, "autoGuardrail")).toBe("Auto-guardrail: inherited on")
  const local = autonomyView({ yolo: true, effectiveYolo: true })
  expect(autonomyToggleTitle(local, "yolo")).toBe("Toggle YOLO: on")
})
