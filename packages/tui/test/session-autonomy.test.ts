import { expect, test } from "bun:test"
import type { SessionAutonomyState } from "@ycoding-ai/client"
import {
  activateGoal,
  autonomyModeLabel,
  autonomyProgressLabel,
  createSessionAutonomyRefreshGuard,
  goalToggleAction,
  parseGoalCommand,
} from "../src/util/session-autonomy"

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

test("re-reads goal state when execution settles rather than when the assistant turn ends", async () => {
  const source = await Bun.file(new URL("../src/routes/session/index.tsx", import.meta.url)).text()
  // The server scores the turn after the drain, so a refresh keyed on the assistant message would
  // read the previous iteration and keep reporting goal mode after the goal already ended.
  expect(source).toContain('data.on("session.execution.succeeded"')
  expect(source).not.toContain("lastAssistant()?.time.completed")
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

test("renders durable assistant text directly without treating literal marker text as control state", async () => {
  const source = await Bun.file(new URL("../src/routes/session/index.tsx", import.meta.url)).text()
  const body = source.slice(source.indexOf("function TextPart("))
  const textPart = body.slice(0, body.indexOf("\n}\n"))
  expect(textPart).toContain("createMemo(() => props.part.text)")
  expect(textPart).not.toContain("stripGoalCompletionMarker")
})

test("labels normal, yolo, and goal modes", () => {
  expect(autonomyModeLabel({ mode: "normal", yolo: 0 } as unknown as SessionAutonomyState)).toBe("Normal")
  expect(autonomyModeLabel({ mode: "normal", yolo: 2 } as unknown as SessionAutonomyState)).toBe("YOLO 2")
  expect(autonomyModeLabel({ mode: "normal", yolo: 1 } as unknown as SessionAutonomyState)).toBe("YOLO 1")
  expect(autonomyModeLabel({ mode: "normal", yolo: 3 } as unknown as SessionAutonomyState)).toBe("YOLO 3")
  // legacy boolean true maps to YOLO 2, false to Normal
  expect(autonomyModeLabel({ mode: "normal", yolo: 2 as unknown as number } as unknown as SessionAutonomyState)).toBe("YOLO 2")
  expect(autonomyModeLabel({ mode: "normal", yolo: 0 as unknown as number } as unknown as SessionAutonomyState)).toBe("Normal")
  expect(
    autonomyModeLabel({ mode: "normal", yolo: 0, goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 2,
        noProgress: 0,
        maxNoProgress: 3,
      },
    } as unknown as SessionAutonomyState),
  ).toBe("Goal")
  expect(autonomyModeLabel({ mode: "normal", yolo: 2, goal: { text: "Finish the migration", status: "active", iteration: 2, noProgress: 0, maxNoProgress: 3 } } as unknown as SessionAutonomyState)).toBe("YOLO 2 + Goal")
  // A terminal goal no longer appears in the autonomy label.
  expect(autonomyModeLabel(terminal("completed"))).toBe("Normal")
  expect(autonomyModeLabel(terminal("exhausted"))).toBe("Normal")
  expect(autonomyModeLabel(terminal("stopped"))).toBe("Normal")
  expect(autonomyModeLabel({ ...terminal("stopped"), yolo: 3 } as unknown as SessionAutonomyState)).toBe("YOLO 3")
  expect(autonomyModeLabel({ ...terminal("completed"), yolo: 2 } as unknown as SessionAutonomyState)).toBe("YOLO 2")
})

function terminal(
  status: "completed" | "exhausted" | "stopped",
  overrides: { iteration?: number; noProgress?: number; maxNoProgress?: number } = {},
): SessionAutonomyState {
  return { mode: "normal", yolo: 0, goal: {
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
    autonomyProgressLabel({ mode: "normal", yolo: 0, goal: {
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
    autonomyProgressLabel({ mode: "normal", yolo: 0, goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 50,
        noProgress: 1,
        maxNoProgress: 3,
      },
    }),
  ).toBe("50 · no progress 1/3")
})

test("hides the goal panel when the goal is not active", async () => {
  const source = await Bun.file(new URL("../src/routes/session/sidebar.tsx", import.meta.url)).text()
  expect(source).toContain('props.autonomy.goal?.status === "active"')
  expect(source).not.toContain("<Show when={props.autonomy.goal}>")
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
  expect(parseGoalCommand("/goal Finish the migration\nRun the tests")).toEqual({ goal: "Finish the migration\nRun the tests" })
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

  const goal: SessionAutonomyState = { mode: "normal", yolo: 0, goal: {
      text: "Old session goal",
      status: "active",
      iteration: 1,
      noProgress: 0,
      maxNoProgress: 3,
    },
  }
  const response = { sessionID: "ses_old", state: goal }

  expect(currentSessionAutonomy("ses_new", true, response)).toEqual({ mode: "normal", yolo: 0 })
  expect(currentSessionAutonomy("ses_old", false, response)).toEqual({ mode: "normal", yolo: 0 })
  expect(currentSessionAutonomy("ses_old", true, response)).toEqual(goal)
})
