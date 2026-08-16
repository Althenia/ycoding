import type { SessionMessageAssistant, SessionMessageInfo } from "@ycoding-ai/client"
import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useData } from "../../context/data"
import { useClient } from "../../context/client"
import { isActiveSubagent } from "../../util/subagent"

export type PartRef = {
  messageID: string
  partID: string
}

export type SessionRow =
  | { type: "message"; messageID: string }
  | { type: "compaction"; jobID: string }
  | { type: "guardrail"; requestID: string; reason: string }
  | { type: "subagent"; sessionID: string; agent: string; created: number }
  | { type: "task"; content: string; status: "completed" | "in_progress" }
  | { type: "part"; ref: PartRef }
  | {
      type: "group"
      kind: "reasoning"
      refs: PartRef[]
      completed: boolean
    }
  | {
      type: "group"
      kind: "exploration"
      refs: PartRef[]
      pending: PartRef[]
      completed: boolean
    }
  | { type: "assistant-footer"; messageID: string }

export async function resolveMessageJump(input: {
  resident: () => boolean
  load: () => Promise<boolean>
  settled: () => Promise<void>
  jump: () => void
}) {
  if (input.resident()) {
    input.jump()
    return "resident" as const
  }
  if (!(await input.load())) return "missing" as const
  await input.settled()
  if (!input.resident()) return "missing" as const
  input.jump()
  return "loaded" as const
}

export function createSessionRows(sessionID: Accessor<string>, activity = () => true) {
  const data = useData()
  const client = useClient()
  const [rows, setRows] = createStore<SessionRow[]>([])
  const revertBoundary = () => data.session.get(sessionID())?.revert?.messageID

  function reduce() {
    const messages = data.session.message.list(sessionID())
    const inputs = new Set(data.session.input.list(sessionID()))
    const boundary = revertBoundary()
    const rows = reduceSessionRows(
      (boundary ? messages.filter((message) => message.id < boundary) : messages).filter(
        (message) => message.type !== "compaction" || !("jobID" in message),
      ),
      inputs,
      data.session.status(sessionID()) === "idle",
    )
    rows.push(
      ...data.session.compaction
        .list(sessionID())
        .map((item): SessionRow => ({ type: "compaction", jobID: item.jobID })),
    )
    const activityBoundary = rows.findLastIndex((row) => {
      if (row.type === "compaction") return true
      if (row.type !== "message") return false
      return data.session.message.get(sessionID(), row.messageID)?.type === "compaction"
    })
    if (activity() && activityBoundary !== -1) rows.push(...activityRows())
    partitionPending(rows, pendingPermissions())
    // Attach a stable unique key so keyed reconcile reuses tail activity rows instead of
    // rebuilding them positionally when an earlier message row is inserted.
    rows.forEach((row) => {
      const message = row.type === "message" ? data.session.message.get(sessionID(), row.messageID) : undefined
      Object.assign(row, { key: rowKey(row, message) })
    })
    return rows
  }

  function pendingPermissions() {
    return new Set(
      (data.session.permission.list(sessionID()) ?? []).flatMap((request) =>
        request.source?.type === "tool" ? [request.source.callID] : [],
      ),
    )
  }

  function activityRows(): SessionRow[] {
    return [
      ...data.session.guardrail
        .list(sessionID())
        .map((request): SessionRow => ({ type: "guardrail", requestID: request.id, reason: request.reason })),
      ...(data.session.subagent
        .page(sessionID())
        ?.data.filter((task) => isActiveSubagent(task.state))
        .map(
          (task): SessionRow => ({
            type: "subagent",
            sessionID: task.sessionID,
            agent: task.agent,
            created: task.time.created,
          }),
        ) ?? []),
    ]
  }

  createEffect(() => {
    const pending = pendingPermissions()
    setRows(
      produce((draft) => {
        partitionPending(draft, pending)
      }),
    )
  })

  createEffect(
    on([sessionID, () => client.connection.status()], ([id, status], previous) => {
      if (previous && previous[0] !== id) data.session.message.evict(previous[0])
      if (status !== "connected") return
      setRows(reconcile(reduce(), { key: "key" }))
      void data.session.pending.sync(id).catch(() => undefined)
      void data.session.diagnostics.sync(id).catch(() => undefined)
      void data.session.message.sync(id).then(
        () => {
          if (sessionID() !== id) return
          setRows(reconcile(reduce(), { key: "key" }))
        },
        () => undefined,
      )
    }),
  )

  // Re-reduce when the revert boundary changes (stage/clear/commit).
  createEffect(
    on(revertBoundary, () => {
      setRows(reconcile(reduce(), { key: "key" }))
    }),
  )

  createEffect(
    on(
      () => [
        activity(),
        // The closing assistant footer depends on execution state, so idling must re-reduce.
        data.session.status(sessionID()),
        ...data.session.guardrail.list(sessionID()).map((request) => `${request.id}:${request.reason}`),
        ...(data.session.subagent
          .page(sessionID())
          ?.data.map((task) => `${task.sessionID}:${task.agent}:${task.state}:${task.time.created}`) ?? []),
      ],
      () => setRows(reconcile(reduce(), { key: "key" })),
    ),
  )

  createEffect(
    on(
      () => data.session.compaction.list(sessionID()).map((item) => `${item.jobID}:${item.status}:${item.messageID}`),
      () => setRows(reconcile(reduce(), { key: "key" })),
    ),
  )

  createEffect(
    on(
      () =>
        data.session.message.list(sessionID()).flatMap((message) =>
          message.type === "user" || message.type === "synthetic"
            ? [
                {
                  id: message.id,
                  created: message.time.created,
                  input: data.session.input.has(sessionID(), message.id),
                },
              ]
            : message.type === "compaction"
              ? [
                  {
                    id: message.id,
                    created: message.time.created,
                  },
                ]
              : [],
        ),
      () => setRows(reconcile(reduce(), { key: "key" })),
    ),
  )

  const appendMessage = (messageID: string) =>
    setRows(
      produce((draft) => {
        if (draft.some((row) => row.type === "message" && row.messageID === messageID)) return
        const pending = isPending(messageID)
        const message = data.session.message.get(sessionID(), messageID)
        const index =
          message?.type === "compaction" && pending ? queuedStart(draft) : pending ? draft.length : queuedStart(draft)
        if (!pending) completePrevious(draft, index)
        const row: SessionRow = { type: "message", messageID }
        Object.assign(row, { key: rowKey(row, message) })
        draft.splice(index, 0, row)
      }),
    )

  const appendPart = (ref: PartRef, part: AppendPart) =>
    setRows(
      produce((draft) => {
        if (hasPart(draft, ref)) return
        append(draft, ref, part, queuedStart(draft))
      }),
    )

  const appendFooter = (messageID: string) =>
    setRows(
      produce((draft) => {
        if (draft.some((row) => row.type === "assistant-footer" && row.messageID === messageID)) return
        const index = queuedStart(draft)
        completePrevious(draft, index)
        draft.splice(index, 0, { type: "assistant-footer", messageID })
      }),
    )

  const removeFooter = (messageID: string) =>
    setRows(
      produce((draft) => {
        const index = draft.findIndex((row) => row.type === "assistant-footer" && row.messageID === messageID)
        if (index !== -1) draft.splice(index, 1)
      }),
    )

  const isPending = (messageID: string) => {
    const message = data.session.message.get(sessionID(), messageID)
    if (message?.type === "user" || message?.type === "synthetic") return data.session.input.has(sessionID(), messageID)
    return false
  }

  const queuedStart = (rows: SessionRow[]) => {
    const index = rows.findIndex((row) => row.type === "message" && isPending(row.messageID))
    return index === -1 ? rows.length : index
  }

  const message = (event: { id: string; data: { sessionID: string } }) => {
    if (event.data.sessionID !== sessionID()) return
    const messageID = event.id.replace(/^evt_/, "msg_")
    // The client store can legitimately skip creating a message for this event
    // (an initial instructions sync, or a model switch before the message list
    // is loaded). Only append a row once the message actually exists, so this
    // stays in agreement with reduceSessionRows, which can only ever see real messages.
    if (data.session.message.get(sessionID(), messageID)) appendMessage(messageID)
  }
  const input = (event: {
    data: {
      sessionID: string
      inputID: string
      input: { type: "user" } | { type: "synthetic"; data: { description?: string } }
    }
  }) => {
    if (
      event.data.sessionID === sessionID() &&
      (event.data.input.type === "user" || event.data.input.data.description?.trim())
    )
      appendMessage(event.data.inputID)
  }
  const subscriptions = [
    data.on("session.input.admitted", input),
    data.on("session.instructions.updated", message),
    data.on("session.synthetic", (event) => {
      if (event.data.sessionID === sessionID() && event.data.description?.trim())
        appendMessage(event.id.replace(/^evt_/, "msg_"))
    }),
    data.on("session.shell.started", message),
    data.on("session.agent.selected", message),
    data.on("session.model.selected", message),
    data.on("session.text.delta", (event) => {
      if (event.data.sessionID === sessionID() && event.data.delta.trim())
        appendPart({ messageID: event.data.assistantMessageID, partID: `text:${event.data.ordinal}` }, { type: "text" })
    }),
    data.on("session.text.ended", (event) => {
      if (event.data.sessionID === sessionID() && event.data.text.trim())
        appendPart({ messageID: event.data.assistantMessageID, partID: `text:${event.data.ordinal}` }, { type: "text" })
    }),
    data.on("session.reasoning.delta", (event) => {
      if (event.data.sessionID === sessionID() && event.data.delta.trim())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: `reasoning:${event.data.ordinal}` },
          { type: "reasoning" },
        )
    }),
    data.on("session.reasoning.ended", (event) => {
      if (event.data.sessionID === sessionID() && event.data.text.trim())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: `reasoning:${event.data.ordinal}` },
          { type: "reasoning" },
        )
    }),
    data.on("session.tool.input.started", (event) => {
      if (event.data.sessionID === sessionID())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: event.data.callID },
          { type: "tool", name: event.data.name },
        )
    }),
    data.on("session.retry.scheduled", (event) => {
      if (event.data.sessionID === sessionID()) appendFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.started", (event) => {
      if (event.data.sessionID === sessionID()) removeFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.ended", (event) => {
      if (event.data.sessionID !== sessionID() || ["tool-calls", "unknown"].includes(event.data.finish)) return
      appendFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.failed", (event) => {
      if (event.data.sessionID === sessionID()) appendFooter(event.data.assistantMessageID)
    }),
  ]
  onCleanup(() => {
    subscriptions.forEach((unsubscribe) => unsubscribe())
    data.session.message.evict(sessionID())
  })

  return rows
}

export function reduceSessionRows(messages: SessionMessageInfo[], inputs = new Set<string>(), idle = false) {
  const isInput = (message: SessionMessageInfo) => inputs.has(message.id)
  // An idle Session has stopped replying, so its last assistant message is terminal even when that
  // step settled on a tool call. Without this the conversation ends on a dangling tool row instead
  // of on YCoding's own block. A Session with no assistant message gets no invented footer.
  const closing = idle ? messages.findLast((message) => message.type === "assistant")?.id : undefined
  const pendingCompactions = messages.filter(
    (message) =>
      message.type === "compaction" &&
      (message.status === "running" ||
        ("jobID" in message && message.status !== "completed" && message.status !== "failed")),
  )
  const pending = new Set([...pendingCompactions.map((message) => message.id), ...inputs])
  return [
    ...messages.filter((message) => !pending.has(message.id)),
    ...pendingCompactions,
    ...messages.filter(isInput),
  ].reduce<SessionRow[]>((rows, message) => {
    if (message.type !== "assistant") {
      if (message.type === "synthetic" && !message.description?.trim()) return rows
      if (!pending.has(message.id)) completePrevious(rows)
      rows.push({ type: "message", messageID: message.id })
      return rows
    }
    const ordinals = { text: 0, reasoning: 0 }
    message.content.forEach((part) => {
      const partID = part.type === "tool" ? part.id : `${part.type}:${ordinals[part.type]++}`
      if ((part.type === "text" || part.type === "reasoning") && !part.text.trim()) return
      append(rows, { messageID: message.id, partID }, part)
    })
    if (
      (message.finish && !["tool-calls", "unknown"].includes(message.finish)) ||
      message.error ||
      message.retry ||
      message.id === closing
    ) {
      completePrevious(rows)
      rows.push({ type: "assistant-footer", messageID: message.id })
    }
    return rows
  }, [])
}

export function messageBoundaryIDs(rows: SessionRow[], messages: SessionMessageInfo[]) {
  const byID = new Map(messages.map((message) => [message.id, message]))
  const seen = new Set<string>()
  return rows.map((row) => {
    const id = rowBoundaryMessageID(row, byID)
    if (!id || seen.has(id)) return undefined
    seen.add(id)
    return id
  })
}

function rowBoundaryMessageID(row: SessionRow, messages: Map<string, SessionMessageInfo>) {
  if (row.type === "message") {
    const message = messages.get(row.messageID)
    if (message?.type === "user" && message.text.trim()) return message.id
    return undefined
  }
  const messageID =
    row.type === "part"
      ? row.ref.messageID
      : row.type === "group"
        ? row.refs[0]?.messageID
        : row.type === "assistant-footer"
          ? row.messageID
          : undefined
  if (!messageID) return undefined
  const message = messages.get(messageID)
  if (message?.type === "assistant") return message.id
}

export function resolvePart(message: SessionMessageAssistant, partID: string) {
  const tool = message.content.find((part) => part.type === "tool" && part.id === partID)
  if (tool) return tool
  const match = /^(text|reasoning):(\d+)$/.exec(partID)
  if (!match) return
  const ordinal = Number(match[2])
  return message.content.filter((part) => part.type === match[1])[ordinal]
}

type AppendPart = { type: "text" } | { type: "reasoning" } | { type: "tool"; name: string }

function append(rows: SessionRow[], ref: PartRef, part: AppendPart, index = rows.length) {
  if (part.type === "reasoning") {
    const previous = rows[index - 1]
    if (previous?.type === "group" && previous.kind === "reasoning") {
      previous.refs.push(ref)
      return
    }
    completePrevious(rows, index)
    rows.splice(index, 0, { type: "group", kind: "reasoning", refs: [ref], completed: false })
    return
  }
  if (part.type === "tool" && exploration(part.name)) {
    const previous = rows[index - 1]
    if (previous?.type === "group" && previous.kind === "exploration") {
      previous.refs.push(ref)
      return
    }
    completePrevious(rows, index)
    rows.splice(index, 0, { type: "group", kind: "exploration", refs: [ref], pending: [], completed: false })
    return
  }
  completePrevious(rows, index)
  rows.splice(index, 0, { type: "part", ref })
}

function completePrevious(rows: SessionRow[], index = rows.length) {
  const previous = rows[index - 1]
  if (previous?.type === "group") previous.completed = true
}

function partitionPending(rows: SessionRow[], pending: Set<string>) {
  rows.forEach((row) => {
    if (row.type !== "group" || row.kind !== "exploration") return
    const refs = [...row.refs, ...row.pending]
    row.refs = refs.filter((ref) => !pending.has(ref.partID))
    row.pending = refs.filter((ref) => pending.has(ref.partID))
  })
}

function exploration(name: string) {
  return ["read", "glob", "grep"].includes(name.toLowerCase())
}

function rowKey(row: SessionRow, message?: SessionMessageInfo): string {
  switch (row.type) {
    case "message": {
      const jobID = message?.type === "compaction" && "jobID" in message ? message.jobID : undefined
      if (typeof jobID === "string") return `compaction:${jobID}`
      return `message:${row.messageID}`
    }
    case "compaction":
      return `compaction:${row.jobID}`
    case "guardrail":
      return `guardrail:${row.requestID}`
    case "subagent":
      return `subagent:${row.sessionID}`
    case "task":
      // Task activity rows have no runtime producer (activityRows() only emits guardrail and
      // subagent rows), so `content` is the only stable identity available and cannot collide.
      return `task:${row.content}`
    case "part":
      return `part:${row.ref.messageID}:${row.ref.partID}`
    case "group": {
      const first = row.refs[0] ?? (row.kind === "exploration" ? row.pending[0] : undefined)
      return `group:${row.kind}:${first?.messageID ?? ""}:${first?.partID ?? ""}`
    }
    case "assistant-footer":
      return `assistant-footer:${row.messageID}`
  }
}

function hasPart(rows: SessionRow[], ref: PartRef) {
  return rows.some((row) => {
    if (row.type === "part") return row.ref.messageID === ref.messageID && row.ref.partID === ref.partID
    if (row.type !== "group") return false
    const refs = row.kind === "exploration" ? [...row.refs, ...row.pending] : row.refs
    return refs.some((item) => item.messageID === ref.messageID && item.partID === ref.partID)
  })
}
