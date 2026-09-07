import type { SessionMessageAssistant, SessionMessageInfo } from "@ycoding-ai/client"
import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useData } from "../../context/data"
import { useClient } from "../../context/client"

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

function residentCompactionBoundary(sessionID: string, messages: SessionMessageInfo[], compactionList: ReturnType<ReturnType<typeof useData>["session"]["compaction"]["list"]>) {
  const fromStore = compactionList
    .filter((lifecycle) => lifecycle.status === "completed" && !!lifecycle.boundary)
    .map((lifecycle) => messages.findIndex((message) => message.id === lifecycle.boundary!.messageID))
    .reduce((latest, position) => Math.max(latest, position), -1)
  const fromMessages = messages
    .filter(
      (message): message is Extract<SessionMessageInfo, { type: "compaction" }> =>
        message.type === "compaction" &&
        "jobID" in message &&
        (message as unknown as { status: string }).status === "completed" &&
        !!(message as unknown as { boundary?: unknown }).boundary,
    )
    .map((message) => messages.findIndex((item) => item.id === (message as unknown as { boundary: { messageID: string } }).boundary.messageID))
    .reduce((latest, position) => Math.max(latest, position), -1)
  return Math.max(fromStore, fromMessages)
}

export function createSessionRows(sessionID: Accessor<string>, activity = () => true) {
  const data = useData()
  const client = useClient()
  const [rows, setRows] = createStore<SessionRow[]>([])
  const revertBoundary = () => data.session.get(sessionID())?.revert?.messageID

  function hydrateCompactionLifecycle(targetID: string) {
    // Re-derive completed compaction boundaries from both the store lifecycle
    // and the resident message payloads so pruning is reapplied before
    // resident rows are published on sessionID change. This covers the
    // keep_recent_messages:0 case where covered rows must stay pruned after
    // jumping to a subagent and back (previously only initial hydration/reconnect pruned).
    const messages = data.session.message.list(targetID)
    void data.session.compaction.list(targetID)
    void messages
  }

  function reduce() {
    const messages = data.session.message.list(sessionID())
    const inputs = new Set(data.session.input.list(sessionID()))
    const revertID = revertBoundary()
    const compactions = data.session.compaction.list(sessionID())
    const compactionBoundaryIndex = residentCompactionBoundary(sessionID(), messages, compactions)
    const pruned = compactionBoundaryIndex === -1 ? messages : messages.filter((message, index) => index > compactionBoundaryIndex || message.type === "compaction")
    const latestLifecycle = compactions.filter(compactionTranscriptVisible).at(-1)
    const latestLegacy = pruned.findLast(
      (message): message is Extract<SessionMessageInfo, { type: "compaction" }> =>
        message.type === "compaction" && compactionMessageTranscriptVisible(message),
    )
    const showLifecycle =
      latestLifecycle !== undefined &&
      (latestLegacy === undefined || latestLifecycle.time.created >= latestLegacy.time.created)
    const visible = (revertID ? pruned.filter((message) => message.id < revertID) : pruned).filter(
      (message) => message.type !== "compaction" || (!showLifecycle && message.id === latestLegacy?.id),
    )
    const rows = reduceSessionRows(visible, inputs, data.session.status(sessionID()) === "idle")
    if (showLifecycle) {
      const row: SessionRow = { type: "compaction", jobID: latestLifecycle.jobID }
      const index = compactionRowIndex(latestLifecycle, messages, rows)
      if (index === -1) rows.push(row)
      else rows.splice(index, 0, row)
    }
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
    return data.session.guardrail
      .list(sessionID())
      .map((request): SessionRow => ({ type: "guardrail", requestID: request.id, reason: request.reason }))
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
    on([sessionID, () => client.connection.status()], ([id, status]) => {
      if (status !== "connected") return
      hydrateCompactionLifecycle(id)
      setRows(reconcile(reduce(), { key: "key" }))
      void data.session.pending.sync(id).catch(() => undefined)
      void data.session.diagnostics.sync(id).catch(() => undefined)
      void data.session.message.sync(id).then(
        () => {
          if (sessionID() !== id) return
          hydrateCompactionLifecycle(id)
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
        append(draft, ref, part, queuedStart(draft), true)
      }),
    )

  const appendFooter = (messageID: string) =>
    setRows(
      produce((draft) => {
        if (draft.some((row) => row.type === "assistant-footer" && row.messageID === messageID)) return
        const index = queuedStart(draft)
        completePrevious(draft, index)
        const row: SessionRow = { type: "assistant-footer", messageID }
        Object.assign(row, { key: rowKey(row) })
        draft.splice(index, 0, row)
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
    data.on("session.context.observed", message),
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

export function compactionMessageTranscriptVisible(message: Extract<SessionMessageInfo, { type: "compaction" }>) {
  if ("jobID" in message) return false
  return message.status !== "failed" || message.error.type === "aborted"
}

export function compactionTranscriptVisible(lifecycle: {
  status: "pending" | "running" | "completed" | "failed"
  code?: string
}) {
  return lifecycle.status !== "failed" || lifecycle.code === "cancelled" || lifecycle.code === "superseded"
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

// `keyed` is set only on the incremental store paths (appendPart) so newly created rows carry the
// same key reduce() would assign. Without it, a later reconcile(reduce(), { key }) cannot match the
// streamed rows and tears down and recreates their renderables (and native text buffers). reduce()
// itself passes keyed=false and re-keys its whole output afterwards, so its shape stays unchanged.
function append(rows: SessionRow[], ref: PartRef, part: AppendPart, index = rows.length, keyed = false) {
  const insert = (row: SessionRow) => {
    if (keyed) Object.assign(row, { key: rowKey(row) })
    rows.splice(index, 0, row)
  }
  if (part.type === "reasoning") {
    const previous = rows[index - 1]
    if (previous?.type === "group" && previous.kind === "reasoning") {
      previous.refs.push(ref)
      return
    }
    completePrevious(rows, index)
    insert({ type: "group", kind: "reasoning", refs: [ref], completed: false })
    return
  }
  if (part.type === "tool" && exploration(part.name)) {
    const previous = rows[index - 1]
    if (previous?.type === "group" && previous.kind === "exploration") {
      previous.refs.push(ref)
      return
    }
    completePrevious(rows, index)
    insert({ type: "group", kind: "exploration", refs: [ref], pending: [], completed: false })
    return
  }
  completePrevious(rows, index)
  insert({ type: "part", ref })
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
      // Task activity rows have no runtime producer, so `content` is the only stable identity
      // available and cannot collide.
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

function compactionRowIndex(
  lifecycle: {
    messageID?: string
    status: "pending" | "running" | "completed" | "failed"
    boundary?: { messageID: string; seq: number }
  },
  messages: SessionMessageInfo[],
  rows: SessionRow[],
) {
  if (!lifecycle.messageID) {
    if (lifecycle.status !== "completed" || !lifecycle.boundary) return -1
    return rows.findIndex((row) => {
      if (row.type === "compaction") return false
      if (row.type !== "message") return true
      return messages.find((message) => message.id === row.messageID)?.type !== "compaction"
    })
  }
  const position = messages.findIndex((message) => message.id === lifecycle.messageID)
  if (position === -1) return -1
  const laterMessageIDs = new Set(messages.slice(position + 1).map((message) => message.id))
  return rows.findIndex((row) => {
    const messageID = sessionRowMessageID(row)
    return messageID !== undefined && laterMessageIDs.has(messageID)
  })
}

function sessionRowMessageID(row: SessionRow) {
  if (row.type === "message" || row.type === "assistant-footer") return row.messageID
  if (row.type === "part") return row.ref.messageID
  if (row.type === "group") return row.refs[0]?.messageID ?? (row.kind === "exploration" ? row.pending[0]?.messageID : undefined)
}

function hasPart(rows: SessionRow[], ref: PartRef) {
  return rows.some((row) => {
    if (row.type === "part") return row.ref.messageID === ref.messageID && row.ref.partID === ref.partID
    if (row.type !== "group") return false
    const refs = row.kind === "exploration" ? [...row.refs, ...row.pending] : row.refs
    return refs.some((item) => item.messageID === ref.messageID && item.partID === ref.partID)
  })
}
