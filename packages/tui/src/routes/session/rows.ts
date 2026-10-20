import type {
  GuardrailGrade,
  GuardrailRequestListOutput,
  GuardrailStatusOutput,
  SessionMessageAssistant,
  SessionMessageInfo,
} from "@ycoding-ai/client"
import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useData } from "../../context/data"
import { useClient } from "../../context/client"
import { isCompactionCheckpoint } from "../../util/session"
import { escapeTerminalText } from "../../util/terminal-text"
import { guardrailGradeDetails } from "./guardrail-grades"

export type PartRef = {
  messageID: string
  partID: string
}

export type GuardrailSourceRef = { messageID: string; callID: string }

export type GuardrailRowDetail = { label: string; value: string }

export type SessionRow =
  | { type: "message"; messageID: string }
  | { type: "compaction"; jobID: string }
  | { type: "guardrail"; requestID: string; reason: string; decided?: string; detail?: GuardrailRowDetail[] }
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

export function createSessionRows(sessionID: Accessor<string>) {
  const mountedSessionID = sessionID()
  const data = useData()
  const client = useClient()
  const [rows, setRows] = createStore<SessionRow[]>([])
  const revertBoundary = () => data.session.get(sessionID())?.revert?.messageID

  function reduce() {
    const messages = data.session.message.list(sessionID())
    const inputs = new Set(data.session.input.list(sessionID()))
    const revertID = revertBoundary()
    const residentIDs = new Set(messages.map((message) => message.id))
    const latestLifecycle = data.session.compaction
      .list(sessionID())
      .filter(
        (lifecycle) =>
          compactionTranscriptVisible(lifecycle) && (!lifecycle.messageID || residentIDs.has(lifecycle.messageID)),
      )
      .at(-1)
    const latestLegacy = messages.findLast(
      (message): message is Extract<SessionMessageInfo, { type: "compaction" }> =>
        message.type === "compaction" && compactionMessageTranscriptVisible(message),
    )
    const showLifecycle =
      latestLifecycle !== undefined &&
      (latestLegacy === undefined || latestLifecycle.time.created >= latestLegacy.time.created)
    const visible = (revertID ? messages.filter((message) => message.id < revertID) : messages).filter(
      (message) => message.type !== "compaction" || (!showLifecycle && message.id === latestLegacy?.id),
    )
    const rows = reduceSessionRows(visible, inputs, data.session.status(sessionID()) === "idle", {
      sessionID: sessionID(),
      decisions: data.session.guardrail.decided(sessionID()),
      dismissals: data.session.guardrail.dismissed(sessionID()),
      pending: data.session.guardrail.list(sessionID()),
    })
    if (showLifecycle) {
      const row: SessionRow = { type: "compaction", jobID: latestLifecycle.jobID }
      const index = latestLifecycle.status === "completed" ? 0 : compactionRowIndex(latestLifecycle, messages, rows)
      if (index === -1) rows.splice(reviewStart(rows), 0, row)
      else rows.splice(index, 0, row)
    }
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
        // The closing assistant footer depends on execution state, so idling must re-reduce.
        data.session.status(sessionID()),
        ...data.session.guardrail.list(sessionID()).map((request) => `${request.id}:${request.reason}`),
        ...data.session.guardrail
          .dismissed(sessionID())
          .map(
            (item) => `${item.eventID}:${item.confidence}:${item.source?.messageID ?? ""}:${item.source?.callID ?? ""}`,
          ),
        ...data.session.guardrail
          .decided(sessionID())
          .map(
            (item) =>
              `${item.requestID}:${item.reply}:${item.choice}:${item.confidence}:${item.source?.messageID ?? ""}:${item.source?.callID ?? ""}:${item.ruleIDs?.join(",") ?? ""}:${JSON.stringify(item.grades)}`,
          ),
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
          message.type === "user" || message.type === "synthetic" || message.type === "system"
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
          message?.type === "compaction" && pending
            ? queuedStart(draft)
            : pending
              ? reviewStart(draft)
              : queuedStart(draft)
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
    const index = rows.findIndex(
      (row) => (row.type === "message" && isPending(row.messageID)) || (row.type === "guardrail" && !row.decided),
    )
    return index === -1 ? rows.length : index
  }
  const reviewStart = (rows: SessionRow[]) => {
    const index = rows.findIndex((row) => row.type === "guardrail" && !row.decided)
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
    data.on("session.guardrail.escalated", message),
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
    data.on("session.step.rerouted", (event) => {
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
    data.session.message.evict(mountedSessionID)
  })

  return rows
}

export function reduceSessionRows(
  messages: SessionMessageInfo[],
  inputs = new Set<string>(),
  idle = false,
  guardrails?: {
    sessionID: string
    decisions: ReadonlyArray<
      NonNullable<GuardrailStatusOutput["decisions"]>[number] & {
        action?: string
        source?: GuardrailSourceRef
        ruleIDs?: readonly string[]
      }
    >
    dismissals: ReadonlyArray<
      NonNullable<GuardrailStatusOutput["dismissals"]>[number] & { source?: GuardrailSourceRef }
    >
    pending: GuardrailRequestListOutput
  },
) {
  const provenance = [
    ...(guardrails?.decisions ?? [])
      .filter((item) => item.sessionID === guardrails?.sessionID)
      .map((item) => {
        const model = item.authority === "baseline" ? "baseline decision model" : item.authority === "yolo" ? "YOLO decision model" : "decision model"
        const decided =
          (item.choice === "approve" || item.choice === "approve_all" || item.choice === "allow") && item.reply === "reject"
            ? `${model} ${item.choice.replaceAll("_", " ")} · ${item.confidence?.toString() ?? "unreported"} · rejected`
            : `${model} ${item.reply === "reject" ? "rejected" : item.reply === "always" ? "approved for this session" : "approved once"} · ${item.confidence?.toString() ?? "confidence unreported"}`
        return {
          created: item.created,
          row: {
            type: "guardrail",
            requestID: item.requestID,
            reason: item.action ?? "guardrail review",
            decided,
            detail: guardrailRowDetail(messages, {
              source: item.source,
              rules: item.ruleIDs ?? [],
              outcome: decided,
              action: item.action,
              grades: item.grades,
              choice: item.choice,
            }),
          } satisfies SessionRow,
        }
      }),
    ...(guardrails?.dismissals ?? [])
      .filter((item) => item.sessionID === guardrails?.sessionID)
      .map((item) => {
        const decided = `match verifier · not a real match · ${item.confidence.toString()}`
        return {
          created: item.created,
          row: {
            type: "guardrail",
            requestID: item.eventID,
            reason: item.ruleID,
            decided,
            detail: guardrailRowDetail(messages, { source: item.source, rules: [item.ruleID], outcome: decided }),
          } satisfies SessionRow,
        }
      }),
  ].sort((left, right) => left.created - right.created || left.row.requestID.localeCompare(right.row.requestID))
  let nextProvenance = 0
  const insertThrough = (rows: SessionRow[], created: number) => {
    while (nextProvenance < provenance.length && provenance[nextProvenance]!.created <= created) {
      completePrevious(rows)
      rows.push(provenance[nextProvenance++]!.row)
    }
  }
  const transcript = messages.filter(
    (message) =>
      !(message.type === "synthetic" && message.metadata?.decisionInputID !== undefined) &&
      !isCompactionCheckpoint(message),
  )
  const isInput = (message: SessionMessageInfo) => inputs.has(message.id)
  // An idle Session has stopped replying, so its last assistant message is terminal even when that
  // step settled on a tool call. Without this the conversation ends on a dangling tool row instead
  // of on YCoding's own block. A Session with no assistant message gets no invented footer.
  const closing = idle ? transcript.findLast((message) => message.type === "assistant")?.id : undefined
  const pendingCompactions = transcript.filter(
    (message) =>
      message.type === "compaction" &&
      (message.status === "running" ||
        ("jobID" in message && message.status !== "completed" && message.status !== "failed")),
  )
  const pending = new Set([...pendingCompactions.map((message) => message.id), ...inputs])
  const rows = [
    ...transcript.filter((message) => !pending.has(message.id)),
    ...pendingCompactions,
    ...transcript.filter(isInput),
  ].reduce<SessionRow[]>((rows, message) => {
    insertThrough(rows, message.time.created)
    if (message.type !== "assistant") {
      if (message.type === "synthetic" && !message.description?.trim()) return rows
      if (!pending.has(message.id)) completePrevious(rows)
      rows.push({ type: "message", messageID: message.id })
      return rows
    }
    const ordinals = { text: 0, reasoning: 0 }
    message.content.forEach((part) => {
      insertThrough(rows, "time" in part ? (part.time?.created ?? message.time.created) : message.time.created)
      const partID = part.type === "tool" ? part.id : `${part.type}:${ordinals[part.type]++}`
      if ((part.type === "text" || part.type === "reasoning") && !part.text.trim()) return
      append(rows, { messageID: message.id, partID }, part)
    })
    if (
      (message.finish && !["tool-calls", "unknown"].includes(message.finish)) ||
      message.error ||
      message.retry ||
      (message.reroutes?.length ?? 0) > 0 ||
      message.id === closing
    ) {
      completePrevious(rows)
      insertThrough(rows, message.time.completed ?? message.time.created)
      rows.push({ type: "assistant-footer", messageID: message.id })
    }
    return rows
  }, [])
  insertThrough(rows, Infinity)
  rows.push(
    ...(guardrails?.pending ?? []).map(
      (request): SessionRow => ({ type: "guardrail", requestID: request.id, reason: request.reason }),
    ),
  )
  return rows
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

function compactionRowIndex(lifecycle: { messageID?: string }, messages: SessionMessageInfo[], rows: SessionRow[]) {
  const position = messages.findIndex((message) => message.id === lifecycle.messageID)
  if (position === -1) return -1
  const laterMessageIDs = new Set(messages.slice(position + 1).map((message) => message.id))
  return rows.findIndex((row) => {
    const messageID = sessionRowMessageID(row)
    return messageID !== undefined && laterMessageIDs.has(messageID)
  })
}

export function sessionRowMessageID(row: SessionRow) {
  if (row.type === "message" || row.type === "assistant-footer") return row.messageID
  if (row.type === "part") return row.ref.messageID
  if (row.type === "group")
    return row.refs[0]?.messageID ?? (row.kind === "exploration" ? row.pending[0]?.messageID : undefined)
}

function guardrailRowDetail(
  messages: SessionMessageInfo[],
  input: {
    source?: GuardrailSourceRef
    rules: readonly string[]
    outcome: string
    action?: string
    grades?: readonly GuardrailGrade[]
    choice?: GuardrailGrade["choice"]
  },
): GuardrailRowDetail[] {
  const tool = input.source ? guardrailToolDetail(messages, input.source) : []
  return [
    ...tool,
    ...(tool.length === 0 && input.action ? [{ label: "action", value: input.action }] : []),
    ...input.rules.map((rule) => ({ label: "rule", value: rule })),
    { label: "outcome", value: input.outcome },
    ...guardrailGradeDetails(input.grades, input.choice),
  ]
}

function guardrailToolDetail(messages: SessionMessageInfo[], source: GuardrailSourceRef): GuardrailRowDetail[] {
  const message = messages.find(
    (item): item is SessionMessageAssistant => item.type === "assistant" && item.id === source.messageID,
  )
  const part = message?.content.find((item) => item.type === "tool" && item.id === source.callID)
  if (!part || part.type !== "tool") return []
  const input = "input" in part.state ? part.state.input : undefined
  return [{ label: "tool", value: part.name }, ...guardrailInputDetail(input)]
}

const guardrailInputPriority = ["command", "path", "filePath", "file", "pattern", "url", "query"]

function guardrailInputDetail(input: unknown): GuardrailRowDetail[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  const entries = Object.entries(input).flatMap(([key, value]) => {
    if (guardrailSensitiveField(key)) return []
    const text = guardrailInputText(value)
    return text ? [{ label: key, value: text }] : []
  })
  return entries.sort((left, right) => guardrailInputRank(left.label) - guardrailInputRank(right.label)).slice(0, 6)
}

function guardrailInputRank(key: string) {
  const index = guardrailInputPriority.indexOf(key)
  return index === -1 ? guardrailInputPriority.length : index
}

function guardrailInputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = escapeTerminalText(value.replace(/\s+/g, " ").trim())
    if (!text) return undefined
    return text.length > 160 ? `${text.slice(0, 159)}…` : text
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    const items = value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
    return items.length > 0 ? guardrailInputText(items.join(", ")) : undefined
  }
  return undefined
}

function guardrailSensitiveField(key: string) {
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return ["key", "token", "secret", "password", "authorization", "cookie", "credential", "header", "headers"].some(
    (word) => words.includes(word),
  )
}

function hasPart(rows: SessionRow[], ref: PartRef) {
  return rows.some((row) => {
    if (row.type === "part") return row.ref.messageID === ref.messageID && row.ref.partID === ref.partID
    if (row.type !== "group") return false
    const refs = row.kind === "exploration" ? [...row.refs, ...row.pending] : row.refs
    return refs.some((item) => item.messageID === ref.messageID && item.partID === ref.partID)
  })
}
