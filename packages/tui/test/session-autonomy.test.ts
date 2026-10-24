import { expect, test } from "bun:test"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import type { AutonomyState } from "../src/util/session-autonomy"
import {
  activateGoal,
  allAutonomyChange,
  autonomyAutomated,
  autonomyCategories,
  autonomyDecisionKind,
  autonomyDecisionLabel,
  autonomyInheritance,
  autonomyModeLabel,
  autonomyModeParts,
  autonomyModeWord,
  autonomyProgressLabel,
  autonomyRows,
  createSessionAutonomyRefreshGuard,
  cycleAutonomyMode,
  goalToggleAction,
  localAutonomyView,
  parseGoalCommand,
} from "../src/util/session-autonomy"
import { activeGoal, autonomyState, autonomyView } from "./fixture/autonomy"

const categories = ["permissions", "guardrails", "answers"] as const

test("cycles Manual to YOLO to Auto and wraps in both directions", () => {
  expect(autonomyCategories).toEqual(categories)
  expect((["manual", "yolo", "auto"] as const).map((mode) => cycleAutonomyMode(mode, 1))).toEqual(["yolo", "auto", "manual"])
  expect((["manual", "yolo", "auto"] as const).map((mode) => cycleAutonomyMode(mode, -1))).toEqual(["auto", "manual", "yolo"])
  expect((["manual", "yolo", "auto"] as const).map(autonomyModeWord)).toEqual(["Manual", "YOLO", "Auto"])
})

test("set-all changes every category in one object", () => {
  expect(allAutonomyChange("auto")).toEqual({ permissions: "auto", guardrails: "auto", answers: "auto" })
  expect(allAutonomyChange("manual")).toEqual({ permissions: "manual", guardrails: "manual", answers: "manual" })
})

test("rows pair each category with its local and effective mode", () => {
  expect(autonomyRows(autonomyView({ permissions: "yolo", answers: "auto" }))).toEqual([
    { category: "permissions", title: "Permissions", local: "yolo", effective: "yolo", inherited: undefined },
    { category: "guardrails", title: "Guardrails", local: "manual", effective: "manual", inherited: undefined },
    { category: "answers", title: "Answers", local: "auto", effective: "auto", inherited: undefined },
  ])
})

test("an unloaded read has unknown rows, never Manual", () => {
  const rows = autonomyRows(undefined)
  expect(rows.map((row) => row.title)).toEqual(["Permissions", "Guardrails", "Answers"])
  for (const row of rows) expect([row.local, row.effective, row.inherited]).toEqual([undefined, undefined, undefined])
  for (const action of categories) expect(autonomyDecisionLabel(undefined, action)).toBe("unknown")
  expect(autonomyModeParts(undefined)).toEqual(["unknown"])
  expect(autonomyModeLabel(undefined)).toBe("unknown")
  expect(autonomyAutomated(undefined)).toBeUndefined()
})

test("an inherited effective mode keeps its source and never reads as the local mode", () => {
  const view = autonomyView(
    { permissions: "manual", answers: "yolo" },
    { permissions: "auto", inherited: { permissions: "ses_parent" } },
  )
  const rows = autonomyRows(view)
  expect(rows[0]).toEqual({ category: "permissions", title: "Permissions", local: "manual", effective: "auto", inherited: "ses_parent" })
  expect(autonomyInheritance(view, "permissions")).toBe("ses_parent")
  expect(autonomyInheritance(view, "guardrails")).toBeUndefined()
  expect(autonomyDecisionLabel(view, "permissions")).toBe("auto")
  expect(autonomyDecisionKind(view, "permissions")).toBe("automated")
  expect(autonomyModeParts(view)).toEqual(["permissions auto (inherited)", "answers yolo"])
})

test("an inherited source is shown whenever the backend supplies it, even when the modes match", () => {
  const yolo = autonomyView({ guardrails: "yolo" }, { inherited: { guardrails: "ses_root" } })
  expect(autonomyInheritance(yolo, "guardrails")).toBe("ses_root")
  expect(autonomyRows(yolo)[1]).toEqual({ category: "guardrails", title: "Guardrails", local: "yolo", effective: "yolo", inherited: "ses_root" })
  const manual = autonomyView({}, { inherited: { guardrails: "ses_root" } })
  expect(autonomyInheritance(manual, "guardrails")).toBe("ses_root")
  expect(autonomyRows(manual)[1]).toEqual({ category: "guardrails", title: "Guardrails", local: "manual", effective: "manual", inherited: "ses_root" })
  expect(autonomyModeParts(manual)).toEqual(["manual"])
  expect(autonomyModeParts(yolo)).toEqual(["guardrails yolo (inherited)"])
  expect(autonomyInheritance(autonomyView(), "guardrails")).toBeUndefined()
})

test("each category reads its own effective mode", () => {
  const labels = (view: SessionAutonomyView) => categories.map((action) => autonomyDecisionLabel(view, action))
  expect(labels(autonomyView())).toEqual(["manual", "manual", "manual"])
  expect(labels(autonomyView({ goal: activeGoal() }))).toEqual(["manual", "manual", "manual"])
  expect(labels(autonomyView({ permissions: "auto" }))).toEqual(["auto", "manual", "manual"])
  expect(labels(autonomyView({ guardrails: "yolo" }))).toEqual(["manual", "yolo", "manual"])
  expect(labels(autonomyView({ answers: "auto" }))).toEqual(["manual", "manual", "auto"])
  expect(labels(autonomyView({ permissions: "yolo", guardrails: "auto", answers: "yolo" }))).toEqual(["yolo", "auto", "yolo"])
})

test("decision kinds separate manual from automated rows", () => {
  const kinds = (view: SessionAutonomyView | undefined) => categories.map((action) => autonomyDecisionKind(view, action))
  expect(kinds(autonomyView())).toEqual(["manual", "manual", "manual"])
  expect(kinds(autonomyView({ permissions: "yolo", guardrails: "auto", answers: "yolo" }))).toEqual(["automated", "automated", "automated"])
  expect(kinds(autonomyView({ sleep: {} }))).toEqual(["automated", "automated", "automated"])
  expect(kinds(autonomyView({}, { guardrailsEnabled: false }))).toEqual(["manual", "manual", "manual"])
  expect(kinds(undefined)).toEqual(["unknown", "unknown", "unknown"])
})

test("sleep sends only manual rows to the review box", () => {
  expect(categories.map((action) => autonomyDecisionLabel(autonomyView({ sleep: {} }), action))).toEqual([
    "review box",
    "review box",
    "review box",
  ])
  const configured = autonomyView({ sleep: {}, permissions: "auto", guardrails: "yolo" })
  expect(categories.map((action) => autonomyDecisionLabel(configured, action))).toEqual(["auto", "yolo", "review box"])
})

test("disabled guardrails read disabled whatever the mode", () => {
  expect(autonomyDecisionLabel(autonomyView({ guardrails: "auto" }, { guardrailsEnabled: false }), "guardrails")).toBe("disabled")
  expect(autonomyDecisionLabel(autonomyView({ permissions: "auto" }, { guardrailsEnabled: false }), "permissions")).toBe("auto")
})

test("the local autonomy view mirrors the draft as its effective modes", () => {
  const view = localAutonomyView(autonomyState({ permissions: "auto", answers: "yolo" }))
  expect(view.effective).toMatchObject({ permissions: "auto", guardrails: "manual", answers: "yolo", inherited: {}, asleep: false })
  expect(localAutonomyView(autonomyState({ sleep: {} })).effective.asleep).toBe(true)
})

test("a malformed mode reads unknown instead of Manual", () => {
  const view = autonomyView({}, { permissions: "bogus" as never })
  expect(autonomyDecisionLabel(view, "permissions")).toBe("unknown")
  expect(autonomyRows(view)[0]?.effective).toBeUndefined()
  expect(autonomyAutomated(view)).toBeUndefined()
})

test("automation is reported from any non-manual effective mode", () => {
  expect(autonomyAutomated(autonomyView())).toBe(false)
  expect(autonomyAutomated(autonomyView({ answers: "auto" }))).toBe(true)
  expect(autonomyAutomated(autonomyView({}, { guardrails: "yolo", inherited: { guardrails: "ses_root" } }))).toBe(true)
})

test("lists active modes in shared order", () => {
  const view = autonomyView({ permissions: "auto", guardrails: "yolo", answers: "auto", sleep: {}, goal: activeGoal() })
  expect(autonomyModeParts(view)).toEqual(["permissions auto", "guardrails yolo", "answers auto", "goal", "asleep"])
  expect(autonomyModeParts(autonomyView())).toEqual(["manual"])
  expect(autonomyModeParts(autonomyView({ goal: activeGoal() }))).toEqual(["manual", "goal"])
  expect(autonomyModeLabel(view)).toBe("permissions auto · guardrails yolo · answers auto · goal · asleep")
})

test("represents explicit goal reports through the progress label", () => {
  expect(
    autonomyProgressLabel({
      ...autonomyState(),
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


function terminal(
  status: "completed" | "exhausted" | "stopped",
  overrides: { iteration?: number; noProgress?: number; maxNoProgress?: number } = {},
): AutonomyState {
  return {
    ...autonomyState(),
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
      ...autonomyState(),
      goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 2,
        noProgress: 1,
        maxNoProgress: 3,
      },
    }),
  ).toBe("2 · no progress 1/3")
  expect(autonomyProgressLabel(autonomyState())).toBeUndefined()
})

test("renders goal iteration separately from no-progress", () => {
  expect(
    autonomyProgressLabel({
      ...autonomyState(),
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
      ...autonomyState(),
      goal: { text: "Finish the migration", status: "active", iteration: 2, noProgress: 0, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "stop" })
})

test("resumes a retained goal without inventing or recalculating its objective", () => {
  expect(
    goalToggleAction({
      ...autonomyState(),
      goal: { text: "Finish the migration", status: "completed", iteration: 4, noProgress: 1, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "resume", text: "Finish the migration" })
  expect(
    goalToggleAction({
      ...autonomyState(),
      goal: { text: "Finish the migration", status: "stopped", iteration: 1, noProgress: 0, maxNoProgress: 3 },
    }),
  ).toEqual({ type: "resume", text: "Finish the migration" })
})

test("requests an explicit objective when no retained goal text exists", () => {
  expect(goalToggleAction(autonomyState())).toEqual({ type: "request-objective" })
  expect(
    goalToggleAction({
      ...autonomyState(),
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
      ...autonomyState(),
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
    get: async () => ({ ...autonomyState() }),
    set: async (payload) => {
      calls.push(payload.goal)
      return {
        ...autonomyState(),
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
      get: async () => ({ ...autonomyState() }),
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

  const goal = autonomyView({ goal: activeGoal() })
  const response = { sessionID: "ses_old", state: goal }

  expect(currentSessionAutonomy("ses_new", true, response)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", false, response)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", true, undefined)).toBeUndefined()
  expect(currentSessionAutonomy("ses_old", true, response)).toEqual(goal)
})
