export * as AutonomyFixture from "./autonomy"

import type { SessionAutonomyView } from "@ycoding-ai/client"

type State = Omit<SessionAutonomyView, "effective">
type Effective = SessionAutonomyView["effective"]

export function autonomyState(input: Partial<State> = {}): State {
  return { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", ...input }
}

export function autonomyView(input: Partial<State> = {}, effective: Partial<Effective> = {}): SessionAutonomyView {
  const state = autonomyState(input)
  return {
    ...state,
    effective: {
      permissions: state.permissions,
      guardrails: state.guardrails,
      answers: state.answers,
      inherited: {},
      asleep: state.sleep !== undefined,
      guardrailsEnabled: true,
      ...effective,
    },
  }
}

export function activeGoal(text = "ship") {
  return { text, status: "active" as const, iteration: 1, noProgress: 0, maxNoProgress: 3 }
}
