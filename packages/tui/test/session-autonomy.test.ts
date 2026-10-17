import { expect, test } from "bun:test"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import type { AutonomyState } from "../src/util/session-autonomy"
import {
  activateGoal,
  approvalLevelLabel,
  autonomyDecisionLabel,
  autonomyLevelDescription,
  autonomyModeLabel,
  autonomyModeParts,
  autonomyProgressLabel,
  createSessionAutonomyRefreshGuard,
  goalToggleAction,
  nextApprovalLevel,
  parseApprovalLevel,
  parseAutoAnswerArg,
  parseGoalCommand,
  yoloLevel,
} from "../src/util/session-autonomy"

function autonomyView(input: {
  yolo?: number | boolean
  effectiveYolo?: 0 | 1 | 2
  goal?: boolean
  sleep?: boolean
  autoAnswer?: boolean
  guardrailsEnabled?: boolean
  ordinaryReviewsAuto?: boolean
  modelReviews?: boolean
  hardModelReviews?: boolean
} = {}): SessionAutonomyView {
  const yolo = input.yolo ?? 0
  return {
    mode: "normal",
    yolo,
    ...(input.goal ? { goal: { text: "ship", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 } } : {}),
    ...(input.sleep ? { sleep: {} } : {}),
    ...(input.autoAnswer === undefined ? {} : { autoAnswer: input.autoAnswer }),
    effective: {
      yolo: input.effectiveYolo ?? (yolo === 1 || yolo === 2 ? yolo : 0),
      asleep: input.sleep ?? false,
      guardrailsEnabled: input.guardrailsEnabled ?? true,
      ordinaryReviewsAuto: input.ordinaryReviewsAuto ?? ((input.effectiveYolo ?? (yolo === 1 || yolo === 2 ? yolo : 0)) === 2 && !(input.sleep ?? false)),
      modelReviews: input.modelReviews ?? false,
      hardModelReviews: input.hardModelReviews ?? false,
    },
  } as unknown as SessionAutonomyView
}

test("accepts only approval levels 0-2 and never clamps an unsupported value", () => {
  expect([0, 1, 2, true, false].map((yolo) => yoloLevel({ yolo }))).toEqual([0, 1, 2, 2, 0])
  expect([3, 1.5, 9, Number.NaN, -1, "2", undefined].map((yolo) => yoloLevel({ yolo }))).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
  expect(parseApprovalLevel("0")).toBe(0)
  expect(parseApprovalLevel("2")).toBe(2)
  expect(parseApprovalLevel("3")).toBeUndefined()
  expect(([0, 1, 2] as const).map((level) => nextApprovalLevel(level))).toEqual([1, 2, 0])
})

test("names approval levels and states their exact grants without promising answers", () => {
  expect(([0, 1, 2] as const).map((level) => approvalLevelLabel(level))).toEqual(["Ask first", "Allow tools", "Tools + reviews"])
  expect(autonomyLevelDescription(0)).toBe("ask before ask-permission tools and ordinary reviews")
  expect(autonomyLevelDescription(1)).toBe("auto-approve ask-permission tools; ordinary reviews still ask")
  expect(autonomyLevelDescription(2)).toBe(
    "auto-approve ask-permission tools and ordinary reviews while awake; hard reviews never auto-approve by level",
  )
})

test("maps decisions from the effective level; a goal grants nothing", () => {
  const labels = (view: SessionAutonomyView) =>
    (["permissions", "guardrails", "questions"] as const).map((action) => autonomyDecisionLabel(view, action))
  expect(labels(autonomyView({ yolo: 0 }))).toEqual(["you", "you", "you"])
  expect(labels(autonomyView({ yolo: 1 }))).toEqual(["auto", "you", "you"])
  expect(labels(autonomyView({ yolo: 2 }))).toEqual(["auto", "auto", "you"])
  expect(labels(autonomyView({ yolo: 0, goal: true }))).toEqual(["you", "you", "you"])
  expect(labels(autonomyView({ yolo: 0, effectiveYolo: 2 }))).toEqual(["auto", "auto", "you"])
})

test("auto-answer is Session-local and independent of level, goal, and sleep", () => {
  for (const yolo of [0, 1, 2] as const) {
    const on = autonomyView({ yolo, autoAnswer: true })
    expect(autonomyDecisionLabel(on, "questions")).toBe("auto")
    expect(autonomyDecisionLabel(autonomyView({ yolo, autoAnswer: false }), "questions")).toBe("you")
  }
  const sleeping = autonomyView({ yolo: 0, sleep: true, autoAnswer: true, goal: true })
  expect(autonomyDecisionLabel(sleeping, "questions")).toBe("auto")
  expect(parseAutoAnswerArg(undefined)).toBeUndefined()
  expect(parseAutoAnswerArg("on")).toBe(true)
  expect(parseAutoAnswerArg("off")).toBe(false)
  expect(parseAutoAnswerArg("yes")).toBeNull()
})

test("sleep adds no grant: off automation defers to the review box", () => {
  for (const yolo of [0, 1, 2] as const) {
    const view = autonomyView({ yolo, sleep: true })
    expect(autonomyDecisionLabel(view, "guardrails")).toBe("review box")
    expect(autonomyDecisionLabel(view, "questions")).toBe("review box")
  }
  expect(autonomyDecisionLabel(autonomyView({ yolo: 0, sleep: true }), "permissions")).toBe("review box")
  expect(autonomyDecisionLabel(autonomyView({ yolo: 1, sleep: true }), "permissions")).toBe("auto")
  expect(autonomyDecisionLabel(autonomyView({ yolo: 2, sleep: true, modelReviews: true }), "guardrails")).toBe(
    "model, then review box",
  )
})

test("ordinary guardrail rows read the actual live model-review flags", () => {
  expect(autonomyDecisionLabel(autonomyView({ yolo: 0, modelReviews: true }), "guardrails")).toBe("model, then you")
  expect(autonomyDecisionLabel(autonomyView({ yolo: 2, modelReviews: true }), "guardrails")).toBe("auto")
  expect(autonomyDecisionLabel(autonomyView({ yolo: 0, guardrailsEnabled: false }), "guardrails")).toBe("disabled")
  expect(autonomyDecisionLabel(autonomyView({ yolo: 2, guardrailsEnabled: false, ordinaryReviewsAuto: true }), "guardrails")).toBe("disabled")
})

test("effective level 2 without backend ordinary-review authority still asks for ordinary reviews", () => {
  const view = autonomyView({ yolo: 2, ordinaryReviewsAuto: false })
  expect(autonomyDecisionLabel(view, "permissions")).toBe("auto")
  expect(autonomyDecisionLabel(view, "guardrails")).toBe("you")
  const modeled = autonomyView({ yolo: 2, ordinaryReviewsAuto: false, modelReviews: true })
  expect(autonomyDecisionLabel(modeled, "guardrails")).toBe("model, then you")
})

test("an unloaded read is unknown, never Ask first or Off", () => {
  for (const action of ["permissions", "guardrails", "questions"] as const)
    expect(autonomyDecisionLabel(undefined, action)).toBe("unknown")
  expect(autonomyModeParts(undefined)).toEqual(["unknown"])
  expect(autonomyModeLabel(undefined)).toBe("unknown")
})

test("lists active modes in shared order", () => {
  const view = autonomyView({ yolo: 2, sleep: true, goal: true, autoAnswer: true })
  expect(autonomyModeParts(view)).toEqual(["Tools + reviews", "goal", "asleep", "answers auto"])
  expect(autonomyModeParts(autonomyView({ yolo: 2, goal: true }))).toEqual(["Tools + reviews", "goal"])
  expect(autonomyModeParts(autonomyView({ yolo: 0, effectiveYolo: 1 }))).toEqual(["Allow tools"])
})

test("represents explicit goal reports through the progress label", () => {
  expect(
    autonomyProgressLabel({
      mode: "normal",
      yolo: 0,
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

test("labels approval levels and goal state", () => {
  expect(autonomyModeLabel(autonomyView({ yolo: 0 }))).toBe("Ask first")
  expect(autonomyModeLabel(autonomyView({ yolo: 1 }))).toBe("Allow tools")
  expect(autonomyModeLabel(autonomyView({ yolo: 2 }))).toBe("Tools + reviews")
  expect(autonomyModeLabel(autonomyView({ yolo: 0, goal: true }))).toBe("Ask first · goal")
  expect(autonomyModeLabel(autonomyView({ yolo: 2, goal: true, autoAnswer: true }))).toBe(
    "Tools + reviews · goal · answers auto",
  )
})

function terminal(
  status: "completed" | "exhausted" | "stopped",
  overrides: { iteration?: number; noProgress?: number; maxNoProgress?: number } = {},
): AutonomyState {
  return {
    mode: "normal",
    yolo: 0,
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
      yolo: 0,
      goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 2,
        noProgress: 1,
        maxNoProgress: 3,
      },
    }),
  ).toBe("2 · no progress 1/3")
  expect(autonomyProgressLabel({ mode: "normal", yolo: 0 })).toBeUndefined()
})

test("renders goal iteration separately from no-progress", () => {
  expect(
    autonomyProgressLabel({
      mode: "normal",
      yolo: 0,
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
      yolo: 0,
      goal: { text: "Finish the migration", status: "active", iteration: 2, noProgress: 0, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "stop" })
})

test("resumes a retained goal without inventing or recalculating its objective", () => {
  expect(
    goalToggleAction({
      mode: "normal",
      yolo: 0,
      goal: { text: "Finish the migration", status: "completed", iteration: 4, noProgress: 1, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "resume", text: "Finish the migration" })
  expect(
    goalToggleAction({
      mode: "normal",
      yolo: 0,
      goal: { text: "Finish the migration", status: "stopped", iteration: 1, noProgress: 0, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "resume", text: "Finish the migration" })
})

test("requests an explicit objective when no retained goal text exists", () => {
  expect(goalToggleAction({ mode: "normal", yolo: 0 })).toEqual({ type: "request-objective" })
  expect(
    goalToggleAction({
      mode: "normal",
      yolo: 0,
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
      yolo: 0,
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
    get: async () => ({ mode: "normal" as const, yolo: 0 }),
    set: async (payload) => {
      calls.push(payload.goal)
      return {
        mode: "normal" as const,
        yolo: 0,
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
      get: async () => ({ mode: "normal" as const, yolo: 0 }),
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

  const goal = autonomyView({ yolo: 0, goal: true })
  const response = { sessionID: "ses_old", state: goal }

  expect(currentSessionAutonomy("ses_new", true, response)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", false, response)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", true, undefined)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", true, response)).toEqual(goal)
})
