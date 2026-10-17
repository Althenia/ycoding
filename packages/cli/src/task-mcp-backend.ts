import {
  isFormInvalidAnswerError,
  isInvalidRequestError,
  isSessionNotFoundError,
  YCoding,
  type FormInfo,
  type GuardrailRequestListOutput,
  type ModelRef,
  type PermissionRequest,
  type QuestionInfo,
  type QuestionRequest,
  type SessionInfo,
  type SessionReviewItem,
} from "@ycoding-ai/client/promise"
import { TaskMCPTasks } from "@ycoding-ai/core/task-mcp/tasks"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"

type PendingInteraction =
  | { kind: "form"; value: FormInfo }
  | { kind: "question"; value: QuestionRequest }
  | { kind: "permission"; value: PermissionRequest }
  | { kind: "guardrail"; value: GuardrailRequestListOutput[number] }
  | { kind: "review"; value: SessionReviewItem }

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
  const pendingInteractions = async (sessionID: string, workspace: string): Promise<PendingInteraction[]> => {
    if (!(await session(sessionID, workspace))) throw new TaskMCPTasks.TaskError("Task Session is unavailable")
    const [forms, questions, permissions, guardrails, reviews] = await Promise.all([
      client.form.list({ sessionID }, request(workspace)),
      client.question.list({ sessionID }, request(workspace)),
      client.permission.list({ sessionID }, request(workspace)),
      client.guardrail.request.list({ sessionID }, request(workspace)),
      client.review.list({ sessionID }, request(workspace)),
    ])
    if (!(await session(sessionID, workspace))) throw new TaskMCPTasks.TaskError("Task Session is unavailable")
    return [
      ...forms.filter((value) => value.sessionID === sessionID).map((value) => ({ kind: "form" as const, value })),
      ...questions
        .filter((value) => value.sessionID === sessionID)
        .map((value) => ({ kind: "question" as const, value })),
      ...permissions
        .filter((value) => value.sessionID === sessionID)
        .map((value) => ({ kind: "permission" as const, value })),
      ...guardrails
        .filter((value) => value.rootSessionID === sessionID)
        .map((value) => ({ kind: "guardrail" as const, value })),
      ...reviews
        .filter((value) => value.rootSessionID === sessionID)
        .map((value) => ({ kind: "review" as const, value })),
    ]
  }
  const replies = new Map<string, Promise<void>>()
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
      const [active, outstanding, pending, permissions, forms, questions, guardrails, reviews] = await Promise.all([
        client.session.active(request(workspace)),
        client.session.outstanding({ failures: true }, request(workspace)),
        client.session.pending.list({ sessionID }, request(workspace)),
        client.permission.list({ sessionID }, request(workspace)),
        client.form.list({ sessionID }, request(workspace)),
        client.question.list({ sessionID }, request(workspace)),
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
      if (permissions.length || forms.length || questions.length || guardrails.length || reviews.length)
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
    async interactions(sessionID, workspace) {
      const pending = (await pendingInteractions(sessionID, workspace))
        .map((item) => presentInteraction(item, sessionID))
        .sort((left, right) => left.interactionId.localeCompare(right.interactionId))
      const items: TaskMCPTasks.Interaction[] = []
      for (const item of pending) {
        if (
          items.length === 50 ||
          Buffer.byteLength(JSON.stringify({ items: [...items, item], truncated: true })) > 65536
        )
          break
        items.push(item)
      }
      return { items, truncated: items.length < pending.length }
    },
    respond(sessionID, workspace, input) {
      const previous = replies.get(sessionID) ?? Promise.resolve()
      const work = previous
        .catch(() => undefined)
        .then(async () => {
          const parsed = TaskMCPTasks.interactionResponseSchema.safeParse(input.response)
          if (!parsed.success) throw new TaskMCPTasks.InteractionRejected("Invalid interaction response")
          const response = parsed.data
          const pending = await pendingInteractions(sessionID, workspace)
          const selected = pending.find(
            (item) => presentInteraction(item, sessionID).interactionId === input.interactionId,
          )
          if (!selected) throw new TaskMCPTasks.TaskError("Interaction is no longer pending")
          const interaction = presentInteraction(selected, sessionID)
          if (interaction.revision !== input.revision)
            throw new TaskMCPTasks.TaskError("Interaction changed; read it again before replying")
          if (!interaction.actionable || !interaction.allowedResponses.includes(response.action))
            throw new TaskMCPTasks.InteractionRejected(
              "Response is not available for this interaction; use the local interface",
            )
          if (selected.kind === "form") {
            if (response.action === "cancel")
              return client.form.cancel({ sessionID, formID: selected.value.id }, request(workspace))
            if (response.action !== "form") throw new TaskMCPTasks.InteractionRejected("Form answer required")
            return client.form
              .reply({ sessionID, formID: selected.value.id, answer: response.answer }, request(workspace))
              .catch((error: unknown) => {
                if (isFormInvalidAnswerError(error))
                  throw new TaskMCPTasks.InteractionRejected("Form answer does not satisfy the requested fields")
                throw error
              })
          }
          if (selected.kind === "question") {
            if (response.action === "cancel")
              return client.question.reject({ sessionID, requestID: selected.value.id }, request(workspace))
            if (response.action !== "question") throw new TaskMCPTasks.InteractionRejected("Question answers required")
            validateQuestionAnswers(selected.value.questions, response.answers)
            return client.question.reply(
              { sessionID, requestID: selected.value.id, answers: response.answers },
              request(workspace),
            )
          }
          if (selected.kind === "permission") {
            // A distinct request-scoped route fails closed on older services; never fall back to reject-all.
            if (response.action === "reject")
              return client.permission.reject({ sessionID, requestID: selected.value.id }, request(workspace))
            if (response.action !== "once")
              throw new TaskMCPTasks.InteractionRejected("Explicit permission response required")
            return client.permission.reply(
              { sessionID, requestID: selected.value.id, reply: "once" },
              request(workspace),
            )
          }
          if (selected.kind === "guardrail") {
            if (response.action !== "once" && response.action !== "reject")
              throw new TaskMCPTasks.InteractionRejected("Explicit guardrail response required")
            return client.guardrail.request.reply(
              { sessionID, requestID: selected.value.id, reply: response.action },
              request(workspace),
            )
          }
          const item = selected.value
          if (item.kind === "question" && response.action === "cancel")
            return client.review.decide(
              { sessionID, itemID: item.itemID, decision: { kind: "question", dismissed: true } },
              request(workspace),
            )
          if (item.kind === "question" && item.payload.type === "form" && response.action === "form")
            return client.review
              .decide(
                { sessionID, itemID: item.itemID, decision: { kind: "question", answers: response.answer } },
                request(workspace),
              )
              .catch((error: unknown) => {
                // This endpoint emits InvalidRequestError only for validation before recording a decision.
                if (isInvalidRequestError(error))
                  throw new TaskMCPTasks.InteractionRejected("Form answer does not satisfy the requested fields")
                throw error
              })
          if (item.kind === "question" && item.payload.type === "question" && response.action === "question") {
            validateQuestionAnswers(item.payload.questions, response.answers)
            return client.review.decide(
              { sessionID, itemID: item.itemID, decision: { kind: "question", answers: response.answers } },
              request(workspace),
            )
          }
          if (
            (item.kind === "permission" || item.kind === "guardrail") &&
            (response.action === "once" || response.action === "reject")
          )
            return client.review.decide(
              { sessionID, itemID: item.itemID, decision: { kind: item.kind, reply: response.action } },
              request(workspace),
            )
          throw new TaskMCPTasks.InteractionRejected("This review requires the local interface")
        })
      replies.set(sessionID, work)
      return work.finally(() => {
        if (replies.get(sessionID) === work) replies.delete(sessionID)
      })
    },
  }
}

function presentInteraction(item: PendingInteraction, sessionID: string): TaskMCPTasks.Interaction {
  const interactionId = `${item.kind}:${item.kind === "review" ? item.value.itemID : item.value.id}`
  const allowedResponses: TaskMCPTasks.InteractionResponse["action"][] =
    item.value.sessionID !== sessionID
      ? []
      : item.kind === "form"
        ? ["form", "cancel"]
        : item.kind === "question"
          ? ["question", "cancel"]
          : item.kind === "permission"
            ? ["once", "reject"]
            : item.kind === "guardrail"
              ? ["once", "reject"]
              : item.value.kind === "question" && item.value.payload.type === "form"
                ? ["form", "cancel"]
                : item.value.kind === "question" && item.value.payload.type === "question"
                  ? ["question", "cancel"]
                  : item.value.kind === "permission" || item.value.kind === "guardrail"
                    ? ["once", "reject"]
                    : []
  const reason =
    item.value.sessionID !== sessionID
      ? "This request belongs to a child Session; use the local interface"
      : allowedResponses.length === 0
        ? "This review requires the local interface"
        : undefined
  const details = item.value.sessionID === sessionID ? item.value : { message: reason }
  const encoded = JSON.stringify({
    interactionId,
    sessionID: item.value.sessionID,
    kind: item.kind,
    details,
    allowedResponses,
  })
  const revision = createHash("sha256").update(encoded).digest("hex")
  const oversized = Buffer.byteLength(encoded) > 16 * 1024
  return {
    interactionId,
    sessionID: item.value.sessionID,
    kind: item.kind,
    revision,
    details: oversized
      ? { message: "Request details exceed the gateway limit; review them in the local interface" }
      : details,
    allowedResponses: oversized ? [] : allowedResponses,
    actionable: !oversized && allowedResponses.length > 0,
    ...(oversized
      ? { reason: "Complete request details cannot be shown within the gateway limit" }
      : reason === undefined
        ? {}
        : { reason }),
  }
}

function validateQuestionAnswers(questions: QuestionInfo[], answers: string[][]) {
  if (answers.length !== questions.length)
    throw new TaskMCPTasks.InteractionRejected("Provide one answer list for every question")
  for (const [index, question] of questions.entries()) {
    const selected = answers[index]
    if (
      selected.length === 0 ||
      selected.some((answer) => !answer.trim()) ||
      (!question.multiple && selected.length !== 1) ||
      new Set(selected).size !== selected.length ||
      (question.custom === false &&
        selected.some((answer) => !question.options.some((option) => option.label === answer)))
    )
      throw new TaskMCPTasks.InteractionRejected(
        "Question answers must match the available choices and selection limits",
      )
  }
}
