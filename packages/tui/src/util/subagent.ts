import type { SessionOrchestrationTask } from "@ycoding-ai/client"

export function isActiveSubagent(state: SessionOrchestrationTask["state"]) {
  return state === "starting" || state === "running" || state === "waiting" || state === "cancelling"
}

export function activeSubagentSessionIDs(
  tasks: ReadonlyArray<Pick<SessionOrchestrationTask, "sessionID" | "state">>,
  family: ReadonlyArray<string>,
  parentID: string,
  isRunning: (sessionID: string) => boolean,
) {
  const active = new Set(tasks.filter((task) => isActiveSubagent(task.state)).map((task) => task.sessionID))
  family
    .filter((sessionID) => sessionID !== parentID && isRunning(sessionID))
    .forEach((sessionID) => active.add(sessionID))
  return [...active]
}
