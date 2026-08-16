import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { formatDuration } from "./format"
import { isActiveSubagent } from "./subagent"

export function subagentElapsedSeconds(
  task: Pick<SessionOrchestrationTask, "state" | "time">,
  now = Date.now(),
) {
  const end = isActiveSubagent(task.state) ? now : task.time.updated
  return Math.max(0, (end - task.time.created) / 1000)
}

export function formatSubagentElapsed(
  task: Pick<SessionOrchestrationTask, "state" | "time">,
  now = Date.now(),
) {
  return formatDuration(subagentElapsedSeconds(task, now))
}
