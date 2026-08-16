import { expect, test } from "bun:test"
import type { SessionAutonomyState } from "@ycoding-ai/client"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import {
  activateGoal,
  autonomyModeLabel,
  autonomyProgressLabel,
  createSessionAutonomyRefreshGuard,
  GOAL_COMPLETION_MARKER,
  GOAL_COMPLETION_PATTERN,
  parseGoalCommand,
  stripGoalCompletionMarker,
} from "../src/util/session-autonomy"

test("mirrors the goal completion marker the server instructs the model to emit", () => {
  expect(GOAL_COMPLETION_MARKER).toBe(SessionAutonomy.CompletionMarker)
  expect(GOAL_COMPLETION_PATTERN).toBe(SessionAutonomy.CompletionPattern)
})

test("hides the goal completion marker from rendered assistant text", () => {
  expect(stripGoalCompletionMarker(`Verified the fix. ${GOAL_COMPLETION_MARKER}`)).toBe("Verified the fix.")
  expect(stripGoalCompletionMarker(`Done.\n\n${GOAL_COMPLETION_MARKER}`)).toBe("Done.")
  expect(stripGoalCompletionMarker(GOAL_COMPLETION_MARKER)).toBe("")
  expect(stripGoalCompletionMarker("  Plain answer  ")).toBe("Plain answer")
  // Every spelling the server accepts as completion is a control token, so none of them render.
  expect(stripGoalCompletionMarker("Verified the fix. <goal-complete />")).toBe("Verified the fix.")
  expect(SessionAutonomy.isCompleted("Verified the fix. <goal-complete />")).toBe(true)
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

test("renders assistant text through the completion-marker filter", async () => {
  const source = await Bun.file(new URL("../src/routes/session/index.tsx", import.meta.url)).text()
  const body = source.slice(source.indexOf("function TextPart("))
  expect(body.slice(0, body.indexOf("\n}\n"))).toContain("stripGoalCompletionMarker")
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

test("admits a goal before setting mode and wakes only after mode is active", async () => {
  const calls: string[] = []
  await activateGoal({
    sessionID: "ses_123",
    id: "msg_goal",
    goal: "Finish the migration",
    get: async () => {
      calls.push("get")
      return { mode: "normal", yolo: 0 }
    },
    set: async () => {
      calls.push("set")
      return { mode: "normal", yolo: 0, goal: {
          text: "Finish the migration",
          status: "active",
          iteration: 0,
          noProgress: 0,
          maxNoProgress: 3,
        },
      }
    },
    prompt: async (input) => {
      calls.push(`prompt:${input.id}:${input.resume === false ? "admit" : "wake"}`)
    },
  })
  expect(calls).toEqual(["prompt:msg_goal:admit", "get", "set", "prompt:msg_goal:wake"])
})

test("retries a lost goal wake without resetting an identical active goal", async () => {
  const calls: string[] = []
  let state: SessionAutonomyState = { mode: "normal", yolo: 0 }
  let failWake = true
  const run = () =>
    activateGoal({
      sessionID: "ses_123",
      id: "msg_goal",
      goal: "Finish the migration",
      get: async () => {
        calls.push("get")
        return state
      },
      set: async () => {
        calls.push("set")
        state = { mode: "normal", yolo: 0, goal: {
            text: "Finish the migration",
            status: "active",
            iteration: 0,
            noProgress: 0,
            maxNoProgress: 3,
          },
        }
        return state
      },
      prompt: async (input) => {
        calls.push(input.resume === false ? "admit" : "wake")
        if (input.resume !== false && failWake) {
          failWake = false
          throw new Error("lost response")
        }
      },
    })

  await expect(run()).rejects.toThrow("lost response")
  await run()

  expect(calls).toEqual(["admit", "get", "set", "wake", "admit", "get", "wake"])
})

test("does not reset an active goal when its original text is re-activated", async () => {
  const calls: string[] = []
  await activateGoal({
    sessionID: "ses_123",
    id: "msg_goal",
    goal: "Fix the migration failure",
    get: async () => ({ mode: "normal" as const, yolo: 0, goal: {
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
    prompt: async (input) => {
      calls.push(input.resume === false ? "admit" : "wake")
    },
  })

  expect(calls).toEqual(["admit", "wake"])
})

test("resets a completed goal with identical original text to active", async () => {
  const calls: string[] = []
  const state = await activateGoal({
    sessionID: "ses_123",
    id: "msg_goal",
    goal: "Fix the migration failure",
    get: async () => ({ mode: "normal" as const, yolo: 0, goal: {
        text: "Repair the migration and verify the suite passes.",
        rawText: "Fix the migration failure",
        status: "completed" as const,
        iteration: 4,
        noProgress: 2,
        maxNoProgress: 3,
      },
    }),
    set: async () => {
      calls.push("set")
      return { mode: "normal" as const, yolo: 0, goal: {
          text: "Fix the migration failure",
          status: "active" as const,
          iteration: 0,
          noProgress: 0,
          maxNoProgress: 3,
        },
      }
    },
    prompt: async (input) => {
      calls.push(input.resume === false ? "admit" : "wake")
    },
  })

  expect(calls).toEqual(["admit", "set", "wake"])
  expect(state).toMatchObject({ mode: "normal", yolo: 0, goal: { status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 },
  })
  expect(autonomyProgressLabel(state)).toBe("0 · no progress 0/3")
})

test("retains the admitted goal when changed content is submitted after a lost wake", async () => {
  const util = await import("../src/util/session-autonomy")
  const original = util.retainSessionSubmission(undefined, "/goal Finish migration", 0, {
    goal: "Finish migration",
  })
  original.sessionID = "ses_123"
  const calls: string[] = []

  await expect(
    activateGoal({
      sessionID: original.sessionID,
      id: original.promptID,
      goal: original.payload.goal,
      get: async () => ({ mode: "normal", yolo: 0 }),
      set: async () => ({ mode: "normal", yolo: 0, goal: {
          text: original.payload.goal,
          status: "active",
          iteration: 0,
          noProgress: 0,
          maxNoProgress: 3,
        },
      }),
      prompt: async (input) => {
        calls.push(`${input.sessionID}:${input.id}:${input.resume === false ? "admit" : "wake"}`)
        if (input.resume !== false) throw new Error("lost response")
      },
    }),
  ).rejects.toThrow("lost response")

  const changed = util.retainSessionSubmission(original, "/goal Replace migration", 0, {
    goal: "Replace migration",
  })

  expect(changed).toBe(original)
  expect(changed.sessionID).toBe("ses_123")
  expect(changed.promptID).toBe(original.promptID)
  expect(changed.payload).toEqual({ goal: "Finish migration" })
  expect(calls).toEqual([
    `ses_123:${original.promptID}:admit`,
    `ses_123:${original.promptID}:wake`,
  ])
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
