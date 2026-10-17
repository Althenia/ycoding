import { isSessionNotFoundError, YCoding, type ModelRef, type SessionInfo } from "@ycoding-ai/client/promise"
import { TaskMCPTasks } from "@ycoding-ai/core/task-mcp/tasks"
import { realpath } from "node:fs/promises"
import path from "node:path"

/** Uses the public runtime API; durable Sessions remain the execution authority. */
export function makeTaskMcpBackend(
  client: ReturnType<typeof YCoding.make>,
  directory: string,
  agent?: string,
  model?: ModelRef,
): TaskMCPTasks.Backend {
  const request = (workspace: string, timeout = 30_000) => ({
    headers: { "x-ycoding-directory": encodeURIComponent(workspace) },
    signal: AbortSignal.timeout(timeout),
  })
  const verifyLocation = async (session: SessionInfo, sessionID: string, workspace: string) => {
    if (
      session.id !== sessionID ||
      session.location.workspaceID !== undefined ||
      (await realpath(workspace)) !== workspace ||
      (await realpath(session.location.directory)) !== workspace
    )
      throw new TaskMCPTasks.TaskError("Task Session is outside its owned workspace")
  }
  const session = async (sessionID: string, workspace: string) => {
    const found = await client.session.get({ sessionID }, request(workspace)).catch((error: unknown) => {
      if (isSessionNotFoundError(error)) return undefined
      throw error
    })
    if (found) await verifyLocation(found, sessionID, workspace)
    return found
  }
  return {
    async prepare(input) {
      const project = await client.project.current({}, request(directory))
      const copy = await client.projectCopy.create(
        {
          projectID: project.id,
          strategy: "git_worktree",
          directory: path.dirname(input.workspace),
          name: path.basename(input.workspace),
        },
        request(directory, 120_000),
      )
      // ProjectCopy chooses a suffixed name on collision. Never silently bind a different workspace.
      if ((await realpath(copy.directory)) !== input.workspace)
        throw new TaskMCPTasks.TaskError("Created worktree does not match the owned workspace")
      const created = await client.session.create(
        {
          id: input.sessionID,
          location: { directory: input.workspace },
          ...(agent === undefined ? {} : { agent }),
          ...(model === undefined ? {} : { model }),
        },
        request(input.workspace),
      )
      await verifyLocation(created, input.sessionID, input.workspace)
    },
    async start(input) {
      if (!(await session(input.sessionID, input.workspace)))
        throw new TaskMCPTasks.TaskError("Task Session is unavailable")
      await client.session.prompt(
        { sessionID: input.sessionID, id: input.promptID, text: input.prompt },
        request(input.workspace),
      )
    },
    async inspect(sessionID, workspace) {
      if (!(await session(sessionID, workspace))) return { state: "interrupted", text: "", truncated: false }
      const lifecycle: { state: TaskMCPTasks.Inspection["state"]; sequence: number } = {
        state: "interrupted",
        sequence: -1,
      }
      const readLifecycle = async () => {
        for await (const event of client.session.log(
          { sessionID, follow: false, ...(lifecycle.sequence < 0 ? {} : { after: lifecycle.sequence }) },
          request(workspace),
        )) {
          if (
            event.type === "log.synced" ||
            event.durable.aggregateID !== sessionID ||
            event.durable.seq <= lifecycle.sequence
          )
            continue
          lifecycle.sequence = event.durable.seq
          if (event.type === "session.execution.started") lifecycle.state = "running"
          if (event.type === "session.execution.succeeded") lifecycle.state = "completed"
          if (event.type === "session.execution.interrupted") lifecycle.state = "interrupted"
          if (event.type === "session.execution.failed")
            lifecycle.state = event.data.error.type === "interrupted" ? "interrupted" : "failed"
        }
      }
      await readLifecycle()
      const [active, outstanding, pending, permissions, forms, guardrails, reviews] = await Promise.all([
        client.session.active(request(workspace)),
        client.session.outstanding({ failures: true }, request(workspace)),
        client.session.pending.list({ sessionID }, request(workspace)),
        client.permission.list({ sessionID }, request(workspace)),
        client.form.list({ sessionID }, request(workspace)),
        client.guardrail.request.list({ sessionID }, request(workspace)),
        client.review.list({ sessionID }, request(workspace)),
      ])
      const running = active[sessionID] !== undefined || outstanding.running.includes(sessionID)
      // A run can settle between the finite log read and the active snapshot.
      if (lifecycle.state === "running" && !running) await readLifecycle()
      const snapshot = await client.session.snapshot({ sessionID, limit: 20 }, request(workspace))
      await verifyLocation(snapshot.session, sessionID, workspace)
      const assistant = snapshot.messages
        .filter((message) => message.type === "assistant")
        .findLast((message) => message.content.some((part) => part.type === "text" && part.text.length > 0))
      const bytes = Buffer.from(
        assistant?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n") ?? "",
      )
      const truncated = bytes.byteLength > 32 * 1024 || (!assistant && !!snapshot.before)
      // Streaming decode drops an incomplete trailing UTF-8 sequence at the byte limit.
      const text = new TextDecoder().decode(bytes.subarray(0, 32 * 1024), { stream: true })
      if (permissions.length || forms.length || guardrails.length || reviews.length)
        return { state: "waiting", text, truncated }
      if (running) return { state: "running", text, truncated }
      if (pending.length) return { state: "queued", text, truncated }
      if (outstanding.data.includes(sessionID)) return { state: "running", text, truncated }
      if (outstanding.lost.includes(sessionID) || lifecycle.state === "interrupted")
        return { state: "interrupted", text, truncated }
      if (outstanding.failed.includes(sessionID)) return { state: "failed", text, truncated }
      return { state: lifecycle.state === "running" ? "interrupted" : lifecycle.state, text, truncated }
    },
    async cancel(sessionID, workspace) {
      if (!(await session(sessionID, workspace))) return
      // Interrupt stops the current drain only; retained pending inputs remain visible to inspect.
      await client.session.interrupt({ sessionID }, request(workspace))
    },
  }
}
