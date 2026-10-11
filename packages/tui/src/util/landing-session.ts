import type { LocationRef, ModelDaybreak, ModelRef, YCodingClient } from "@ycoding-ai/client"
import type { YoloLevel } from "./session-autonomy"

export function landingAutonomyPayload(autonomy: { yolo: YoloLevel; goal?: string } | undefined) {
  if (!autonomy || (autonomy.yolo <= 0 && autonomy.goal === undefined)) return
  if (autonomy.goal === undefined) return { yolo: autonomy.yolo }
  return { yolo: autonomy.yolo, goal: autonomy.goal }
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
  input: { sessionID: string; payload: { yolo: YoloLevel; goal?: string }; signal?: AbortSignal },
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
  autonomy?: { yolo: YoloLevel; goal?: string }
  daybreak?: ModelDaybreak
  signal?: AbortSignal
}) {
  const session = await createLandingSession(input.api, input)
  const autonomy = landingAutonomyPayload(input.autonomy)
  if (autonomy) await persistLandingAutonomy(input.api, { sessionID: session.id, payload: autonomy, signal: input.signal })
  if (input.daybreak)
    await persistLandingDaybreak(input.api, { sessionID: session.id, daybreak: input.daybreak, signal: input.signal })
  return session
}
