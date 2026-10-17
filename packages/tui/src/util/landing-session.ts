import type { LocationRef, ModelDaybreak, ModelRef, YCodingClient } from "@ycoding-ai/client"
import type { YoloLevel } from "./session-autonomy"

export type LandingAutonomy = { yolo: YoloLevel; goal?: string; autoAnswer?: boolean }

export function landingAutonomyPayload(autonomy: LandingAutonomy | undefined) {
  if (!autonomy || (autonomy.yolo <= 0 && autonomy.goal === undefined)) return
  if (autonomy.goal === undefined) return { yolo: autonomy.yolo }
  return { yolo: autonomy.yolo, goal: autonomy.goal }
}

export function landingAutonomyPayloads(autonomy: LandingAutonomy | undefined) {
  const primary = landingAutonomyPayload(autonomy)
  return [
    ...(primary ? [primary] : []),
    ...(autonomy?.autoAnswer ? [{ autoAnswer: true } as const] : []),
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
  input: { sessionID: string; payload: { yolo: YoloLevel; goal?: string } | { autoAnswer: boolean }; signal?: AbortSignal },
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
  for (const payload of landingAutonomyPayloads(input.autonomy))
    await persistLandingAutonomy(input.api, { sessionID: session.id, payload, signal: input.signal })
  if (input.daybreak)
    await persistLandingDaybreak(input.api, { sessionID: session.id, daybreak: input.daybreak, signal: input.signal })
  return session
}
