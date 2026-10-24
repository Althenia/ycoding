import type { LocationRef, ModelDaybreak, ModelRef, SessionAutonomyView, YCodingClient } from "@ycoding-ai/client"
import { autonomyMode, autonomyCategories, type AutonomyChange } from "./session-autonomy"

export type LandingAutonomy = Required<AutonomyChange> & { goal?: string }

export type LandingAutonomyPayload = Required<AutonomyChange> | { goal: string }

export function landingAutonomyOf(view: SessionAutonomyView | undefined, includeGoal: boolean): LandingAutonomy {
  const [permissions, guardrails, answers] = autonomyCategories.map((category) => autonomyMode(view?.[category]) ?? "manual")
  return {
    permissions: permissions!,
    guardrails: guardrails!,
    answers: answers!,
    ...(includeGoal && view?.goal?.status === "active" ? { goal: view.goal.text } : {}),
  }
}

export function landingAutonomyPayloads(autonomy: LandingAutonomy | undefined): LandingAutonomyPayload[] {
  if (!autonomy) return []
  const modes = { permissions: autonomy.permissions, guardrails: autonomy.guardrails, answers: autonomy.answers }
  return [
    ...(Object.values(modes).some((mode) => mode !== "manual") ? [modes] : []),
    ...(autonomy.goal !== undefined ? [{ goal: autonomy.goal }] : []),
  ]
}

function requestOptions(signal: AbortSignal | undefined) {
  if (!signal) return
  return { signal }
}

export function createLandingSession(
  api: YCodingClient,
  input: { id: string; location: LocationRef; agent: string; model: ModelRef; signal?: AbortSignal },
) {
  return api.session.create(
    { id: input.id, location: input.location, agent: input.agent, model: input.model },
    requestOptions(input.signal),
  )
}

export function persistLandingAutonomy(
  api: YCodingClient,
  input: { sessionID: string; payload: LandingAutonomyPayload; signal?: AbortSignal },
) {
  return api.session.autonomy.set({ sessionID: input.sessionID, payload: input.payload }, requestOptions(input.signal))
}

export function persistLandingDaybreak(
  api: YCodingClient,
  input: { sessionID: string; daybreak: ModelDaybreak; signal?: AbortSignal },
) {
  return api.session.daybreak.set(
    { sessionID: input.sessionID, daybreak: input.daybreak },
    requestOptions(input.signal),
  )
}

export async function establishLandingSession(input: {
  api: YCodingClient
  id: string
  location: LocationRef
  agent: string
  model: ModelRef
  autonomy?: LandingAutonomy
  daybreak?: ModelDaybreak
  signal?: AbortSignal
}) {
  const session = await createLandingSession(input.api, input)
  if (input.daybreak)
    await persistLandingDaybreak(input.api, { sessionID: session.id, daybreak: input.daybreak, signal: input.signal })
  for (const payload of landingAutonomyPayloads(input.autonomy))
    await persistLandingAutonomy(input.api, { sessionID: session.id, payload, signal: input.signal })
  return session
}
