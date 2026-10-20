import type { LocationRef, ModelDaybreak, ModelRef, YCodingClient } from "@ycoding-ai/client"

export type LandingAutonomy = {
  yolo: boolean
  goal?: string
  autoPermission?: boolean
  autoGuardrail?: boolean
  autoAnswer?: boolean
}

export type LandingAutonomyPayload =
  | { yolo: boolean; goal?: string }
  | { goal: string }
  | { autoPermission: boolean }
  | { autoGuardrail: boolean }
  | { autoAnswer: boolean }

export function landingAutonomyPayloads(autonomy: LandingAutonomy | undefined): LandingAutonomyPayload[] {
  if (!autonomy) return []
  return [
    ...(autonomy.goal === undefined && autonomy.yolo ? [{ yolo: true } as const] : []),
    ...(autonomy.autoPermission ? [{ autoPermission: true } as const] : []),
    ...(autonomy.autoGuardrail ? [{ autoGuardrail: true } as const] : []),
    ...(autonomy.autoAnswer ? [{ autoAnswer: true } as const] : []),
    ...(autonomy.goal !== undefined ? [autonomy.yolo ? { yolo: true, goal: autonomy.goal } : { goal: autonomy.goal }] : []),
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
