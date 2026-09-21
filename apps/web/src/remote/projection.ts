/**
 * Narrow readers and projection for the relay event stream.
 *
 * The relay forwards the local `packages/protocol` event payload verbatim, so
 * every field is read defensively and unknown events are counted rather than
 * guessed. Nothing here invents content the agent did not send.
 */

import type { Form } from "../../../../packages/schema/src/form"

/** `packages/schema` `Model.Ref`: an object, never a plain string. */
export type ModelRefView = {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export function readModelRef(value: unknown): ModelRefView | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = stringField(record.id)
  const providerID = stringField(record.providerID)
  if (id === undefined || providerID === undefined) return undefined
  const variant = stringField(record.variant)
  return { id, providerID, ...(variant === undefined ? {} : { variant }) }
}

/** Display form of a model reference: `provider/model` plus an optional `#variant`. */
export function modelLabel(model: ModelRefView | undefined): string | undefined {
  if (model === undefined) return undefined
  return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

export type ToolContentBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "other"; readonly type: string; readonly summary: string }

/**
 * `Shell.Output` page the client holds. `cursor` is the absolute byte offset after the
 * page and `size` the total bytes captured on the device, so `cursor < size` means the
 * remainder is still on the device. Keeping the page and its metadata makes the
 * collapsed view a display decision instead of a data-loss point.
 */
export type ShellOutputView = {
  readonly text: string
  readonly cursor: number
  readonly size: number
  readonly truncated: boolean
}

/**
 * Client page-request state for one shell capture. It is not device data: the device's
 * own page stays in `ShellOutputView`, and this records only what the last explicit
 * request did, so a stalled or failed read is never rendered as output the device sent.
 */
export type ShellOutputFetch =
  /** No request is in flight and the last one settled cleanly. */
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  /** A settled page added nothing while the device still holds bytes. */
  | { readonly state: "stalled" }

/** `Session.Event.FileChange.Info`: one path's recorded patch. */
export type FileChangeView = {
  readonly path: string
  readonly patch: string
  readonly additions: number
  readonly deletions: number
}

export type AssistantPart =
  | {
      readonly kind: "text"
      readonly ordinal: number
      readonly text: string
      readonly phase?: "commentary" | "final_answer"
    }
  | { readonly kind: "reasoning"; readonly ordinal: number; readonly text: string }
  | {
      readonly kind: "tool"
      readonly callID: string
      readonly name: string
      readonly status: "streaming" | "running" | "completed" | "failed"
      readonly inputText?: string
      readonly input?: Readonly<Record<string, unknown>>
      readonly content: readonly ToolContentBlock[]
      /** `ToolState.*.structured` as sent: shell correlation and truncation flags. */
      readonly structured?: Readonly<Record<string, unknown>>
      /** Paged capture of the shell this tool ran, when the device reported one. */
      readonly shellOutput?: ShellOutputView
      /** Client request state for `shellOutput`, kept apart from the device's bytes. */
      readonly shellOutputFetch?: ShellOutputFetch
      readonly error?: string
    }

export type RemoteMessageView =
  | {
      readonly kind: "user"
      readonly id: string
      readonly text: string
      /** Absent when the projection does not carry a delivery mode. */
      readonly delivery?: "steer" | "queue"
      readonly state: "pending" | "promoted" | "consumed"
      readonly created: number
    }
  | {
      readonly kind: "assistant"
      readonly id: string
      readonly agent?: string
      readonly model?: ModelRefView
      readonly parts: readonly AssistantPart[]
      readonly created: number
      readonly completed?: number
      readonly error?: string
      readonly retry?: { readonly attempt: number; readonly at: number; readonly code: string }
    }
  | { readonly kind: "system"; readonly id: string; readonly text: string; readonly created: number }
  | {
      readonly kind: "synthetic"
      readonly id: string
      readonly text: string
      readonly description?: string
      readonly created: number
    }
  | {
      readonly kind: "shell"
      readonly id: string
      readonly shellID: string
      readonly command: string
      readonly status: string
      readonly exit?: number
      readonly output?: ShellOutputView
      /** Client request state for `output`; a running shell has no page yet. */
      readonly outputFetch?: ShellOutputFetch
      readonly created: number
      readonly completed?: number
    }
  | {
      readonly kind: "compaction"
      readonly id: string
      readonly status: "pending" | "running" | "completed" | "failed"
      readonly trigger?: string
      readonly summary?: string
      readonly error?: string
    }
  | {
      readonly kind: "notice"
      readonly id: string
      readonly notice: "agent-switched" | "model-switched" | "skill" | "revert"
      readonly text: string
      readonly created: number
    }

export type FormFieldView = Form.Field
export type FormWhenView = Form.When
export type FormAnswerView = Form.Answer
export type FormView = Omit<Form.Info, "id" | "fields"> & { readonly id: string; readonly fields: readonly FormFieldView[] }

export type PendingRequestView =
  | {
      readonly kind: "permission"
      readonly id: string
      readonly action: string
      readonly resources: readonly string[]
      readonly askedAt: number
    }
  | {
      readonly kind: "guardrail"
      readonly id: string
      readonly sessionID: string
      readonly rootSessionID?: string
      readonly action: string
      readonly resources: readonly string[]
      readonly reason: string
      readonly hardReview: boolean
      readonly askedAt: number
    }
  | {
      readonly kind: "form"
      readonly id: string
      readonly form: FormView
      readonly askedAt: number
    }

export type ActivityItem = {
  readonly id: string
  readonly kind: "tool" | "terminal" | "file" | "approval" | "status"
  readonly title: string
  readonly detail?: string
  readonly status?: string
  readonly at: number
}

export type SessionAutonomyView = {
  readonly mode: "normal" | "yolo" | "goal"
  readonly yolo: 0 | 1 | 2 | 3
  readonly goal?: {
    readonly text: string
    readonly status: "active" | "completed" | "stopped" | "exhausted"
    readonly iteration: number
    readonly noProgress: number
    readonly maxNoProgress: number
  }
}

export type SessionView = {
  readonly id: string
  readonly title?: string
  readonly agent?: string
  readonly model?: ModelRefView
  readonly status: "idle" | "running" | "interrupted" | "failed"
  readonly archived?: boolean
  readonly lastError?: { readonly code: string; readonly message: string }
  readonly autonomy?: SessionAutonomyView
  readonly retry?: { readonly attempt: number; readonly at: number; readonly code: string }
  readonly messages: readonly RemoteMessageView[]
  readonly requests: readonly PendingRequestView[]
  /** Latest recorded patch per changed path, from the ledger read and live records. */
  readonly fileChanges: readonly FileChangeView[]
  readonly activity: readonly ActivityItem[]
  readonly unhandledEvents: number
  readonly updatedAt?: number
  /** Highest durable sequence applied for this session; the snapshot watermark seeds it. */
  readonly watermark?: number
  /** Server process epoch the current projection came from. */
  readonly sourceEpoch?: string
}

/** Caps a derived summary (compaction, non-text tool content) so it cannot dominate the page. */
export const messageTextLimit = 4_000
export const activityLimit = 200

/**
 * Events the client receives but does not project: they carry no user-visible
 * transcript or request state here, so they are ignored without inflating the
 * unhandled counter.
 */
const ignoredEventTypes: readonly string[] = [
  "session.context.observed",
  "session.instructions.updated",
  "session.task.updated",
  "session.project-artifacts-ended",
  "session.moved",
  "session.forked",
  "session.deleted",
  "session.usage.recorded",
  "session.usage.updated",
  "session.diagnostics.updated",
  "session.provider.request.recorded",
  "session.skill.deactivated",
  "session.compaction.delta",
  "session.compaction.replaced",
  "todo.updated",
  "server.connected",
]

export function createSessionView(id: string): SessionView {
  return { id, status: "idle", messages: [], requests: [], fileChanges: [], activity: [], unhandledEvents: 0 }
}

export function boundedText(
  text: string,
  limit = messageTextLimit,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/** Collapsed-output budget: a few lines, also bounded by characters. */
const previewLineLimit = 12
const previewCharLimit = 2_000

/**
 * Collapsed preview of available text. `hasMore` is true only when the preview is
 * shorter than the text, so a control built on it always changes what is rendered.
 */
export function previewText(
  text: string,
  limit: { readonly lines: number; readonly chars: number } = { lines: previewLineLimit, chars: previewCharLimit },
): { readonly text: string; readonly hasMore: boolean } {
  const wholeLines = text.split("\n").slice(0, limit.lines).join("\n")
  const cut = wholeLines.length > limit.chars ? wholeLines.slice(0, limit.chars) : wholeLines
  return { text: cut, hasMore: cut.length < text.length }
}

/**
 * Source-side limit notice. It stays separate from the collapsed preview so a
 * "Show more" control never has to stand in for output the device did not send.
 */
export function shellOutputNotice(output: ShellOutputView): string | undefined {
  if (output.cursor < output.size) {
    return `Showing the first ${output.cursor} of ${output.size} bytes retained on the device; the rest stays on the device.`
  }
  if (output.truncated) return `The device reports this output as truncated at ${output.size} bytes.`
  return undefined
}

function readShellOutput(value: unknown): ShellOutputView | undefined {
  if (!isRecord(value)) return undefined
  const text = typeof value.output === "string" ? value.output : undefined
  const cursor = numberField(value.cursor)
  const size = numberField(value.size)
  if (text === undefined || cursor === undefined || size === undefined) return undefined
  return { text, cursor, size, truncated: value.truncated === true }
}

/** Reads a `session.shell.output` response envelope: `{ data: Shell.Output }`. */
export function readShellOutputPage(payload: unknown): ShellOutputView | undefined {
  return readShellOutput(isRecord(payload) ? payload.data : undefined)
}

/**
 * Applies a device page that starts at byte zero, from a `session.shell.*` event or a
 * snapshot message. A client that already fetched past it keeps its longer text: both
 * are decodings of the same capture prefix, so the device page adds nothing new.
 */
export function mergeShellOutputSnapshot(
  existing: ShellOutputView | undefined,
  page: ShellOutputView,
): ShellOutputView {
  if (existing === undefined || existing.cursor < page.cursor) return page
  return {
    ...existing,
    size: Math.max(existing.size, page.size),
    truncated: existing.truncated || page.truncated,
  }
}

/**
 * Appends one fetched continuation page. `from` is the byte cursor the page was asked
 * for, so bytes a durable update already delivered are dropped instead of repeated. A
 * device read clamps a cursor past its own capture to the captured size, so a reply can
 * name a smaller cursor than the client holds and must never rewind it.
 */
export function appendShellOutputPage(
  existing: ShellOutputView | undefined,
  page: ShellOutputView,
  from: number,
): ShellOutputView {
  if (existing !== undefined && existing.cursor > from) {
    return {
      ...existing,
      size: Math.max(existing.size, page.size),
      truncated: existing.truncated || page.truncated,
    }
  }
  return {
    text: `${existing?.text ?? ""}${page.text}`,
    cursor: Math.max(existing?.cursor ?? 0, page.cursor),
    size: Math.max(existing?.size ?? 0, page.size),
    truncated: (existing?.truncated ?? false) || page.truncated,
  }
}

/**
 * The shell a tool call ran on the device, read from the `structured` record the device
 * sent. A tool call that carries no such record has no readable capture: the transcript
 * never carries a capture path, and remote input never selects one.
 */
export function toolShellID(part: Extract<AssistantPart, { kind: "tool" }>): string | undefined {
  const value = part.structured?.shellID
  return typeof value === "string" && /^sh_[A-Za-z0-9]+$/.test(value) ? value : undefined
}

/**
 * The paged capture the client holds for one shell, from its transcript message or from
 * the tool call that ran it. `undefined` means no page has been read for that shell yet.
 */
export function shellOutputFor(view: SessionView, shellID: string): ShellOutputView | undefined {
  const message = view.messages.find(
    (entry): entry is Extract<RemoteMessageView, { kind: "shell" }> =>
      entry.kind === "shell" && entry.shellID === shellID,
  )
  return message === undefined ? findToolShellPart(view, shellID)?.shellOutput : message.output
}

/** The client page-request state for one shell, wherever the client holds that shell. */
export function shellOutputFetchFor(view: SessionView, shellID: string): ShellOutputFetch | undefined {
  const message = view.messages.find(
    (entry): entry is Extract<RemoteMessageView, { kind: "shell" }> =>
      entry.kind === "shell" && entry.shellID === shellID,
  )
  return message === undefined ? findToolShellPart(view, shellID)?.shellOutputFetch : message.outputFetch
}

/** Records the client page-request state for one shell without touching device data. */
export function withShellOutputFetch(view: SessionView, shellID: string, fetch: ShellOutputFetch): SessionView {
  return updateShellOutput(
    view,
    shellID,
    (message) => ({ ...message, outputFetch: fetch }),
    (part) => ({ ...part, shellOutputFetch: fetch }),
  )
}

/**
 * Applies one fetched page to the shell it names, wherever the client holds that shell.
 * A shell the view no longer contains is left alone, so a late page cannot attach to a
 * different shell or session.
 */
export function withShellOutputPage(
  view: SessionView,
  shellID: string,
  page: ShellOutputView,
  from: number,
  fetch: ShellOutputFetch,
): SessionView {
  return updateShellOutput(
    view,
    shellID,
    (message) => ({ ...message, output: appendShellOutputPage(message.output, page, from), outputFetch: fetch }),
    (part) => ({ ...part, shellOutput: appendShellOutputPage(part.shellOutput, page, from), shellOutputFetch: fetch }),
  )
}

function findToolShellPart(
  view: SessionView,
  shellID: string,
): Extract<AssistantPart, { kind: "tool" }> | undefined {
  for (const message of view.messages) {
    if (message.kind !== "assistant") continue
    for (const part of message.parts) {
      if (part.kind === "tool" && toolShellID(part) === shellID) return part
    }
  }
  return undefined
}

function updateShellOutput(
  view: SessionView,
  shellID: string,
  updateMessage: (
    message: Extract<RemoteMessageView, { kind: "shell" }>,
  ) => Extract<RemoteMessageView, { kind: "shell" }>,
  updatePart: (part: Extract<AssistantPart, { kind: "tool" }>) => Extract<AssistantPart, { kind: "tool" }>,
): SessionView {
  let changed = false
  const messages = view.messages.map((message) => {
    if (message.kind === "shell" && message.shellID === shellID) {
      changed = true
      return updateMessage(message)
    }
    if (message.kind !== "assistant") return message
    if (!message.parts.some((part) => part.kind === "tool" && toolShellID(part) === shellID)) return message
    changed = true
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.kind === "tool" && toolShellID(part) === shellID ? updatePart(part) : part,
      ),
    }
  })
  return changed ? { ...view, messages } : view
}

/** Reads a Protocol response envelope: the JSON body is `{ data: [...] }`. */
export function readDataList(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return []
  return payload.data
}

export function readSessionInfoList(payload: unknown): readonly unknown[] {
  return readDataList(payload)
}

export function readMessageList(payload: unknown): readonly RemoteMessageView[] {
  return readDataList(payload).flatMap((item) => {
    const message = readSnapshotMessage(item)
    return message ? [message] : []
  })
}

export function readAutonomy(payload: unknown): SessionAutonomyView | undefined {
  const data = dataOf(payload)
  if (!isRecord(data)) return undefined
  const mode = data.mode === "goal" || data.mode === "yolo" ? data.mode : "normal"
  const goal = isRecord(data.goal) ? readGoal(data.goal) : undefined
  return {
    mode: goal?.status === "active" ? "goal" : mode,
    yolo: readYolo(data.yolo),
    ...(goal === undefined ? {} : { goal }),
  }
}

export function applySessionEvent(view: SessionView, payload: unknown, now: number): SessionView {
  const event = readEvent(payload)
  if (!event) return bump(view)
  if (ignoredEventTypes.includes(event.type)) return view
  const data = event.data
  switch (event.type) {
    case "session.created": {
      const created = readModelRef(data.model)
      return {
        ...view,
        title: stringField(data.title) ?? view.title,
        agent: stringField(data.agent) ?? view.agent,
        model: created ?? view.model,
        updatedAt: now,
      }
    }
    case "session.renamed":
      return { ...view, title: stringField(data.title) ?? view.title, updatedAt: now }
    case "session.archived":
      return { ...view, archived: true, updatedAt: now }
    case "session.unarchived":
      return { ...view, archived: false, updatedAt: now }
    case "session.agent.selected":
      return { ...view, agent: stringField(data.agent) ?? view.agent, updatedAt: now }
    case "session.model.selected": {
      const selected = readModelRef(data.model)
      return { ...view, model: selected ?? view.model, updatedAt: now }
    }
    case "session.execution.started":
      return { ...view, status: "running", retry: undefined, updatedAt: now }
    case "session.execution.succeeded":
      return { ...view, status: "idle", retry: undefined, updatedAt: now }
    case "session.execution.failed":
      return { ...view, status: "failed", lastError: readError(data.error), updatedAt: now }
    case "session.execution.interrupted":
      return { ...view, status: "interrupted", retry: undefined, updatedAt: now }
    case "session.status":
      return applyStatus(view, data, now)
    case "session.idle":
      return { ...view, status: "idle", retry: undefined, updatedAt: now }
    case "session.retry.scheduled":
      return {
        ...view,
        retry: {
          attempt: numberField(data.attempt) ?? 1,
          at: numberField(data.at) ?? now,
          code: readError(data.error)?.code ?? "unknown",
        },
        updatedAt: now,
      }
    case "session.input.admitted":
      return applyAdmitted(view, data, now)
    case "session.input.promoted":
      return updateUserMessage(view, stringField(data.inputID), (message) => ({ ...message, state: "promoted" }))
    case "session.input.consumed": {
      const ids = stringList(data.inputIDs)
      return ids.reduce(
        (current, id) => updateUserMessage(current, id, (message) => ({ ...message, state: "consumed" })),
        view,
      )
    }
    case "session.step.started":
      return withAssistant(view, data, now, (message) => {
        const stepModel = readModelRef(data.model)
        return {
          ...message,
          agent: stringField(data.agent) ?? message.agent,
          model: stepModel ?? message.model,
        }
      })
    case "session.step.ended":
      return withAssistant(view, data, now, (message) => ({ ...message, completed: now, retry: undefined }))
    case "session.step.failed":
      return withAssistant(view, data, now, (message) => ({
        ...message,
        completed: now,
        error: readError(data.error)?.message ?? "The step failed",
      }))
    case "session.text.started":
      return withTextPart(view, data, now, (part) => part)
    case "session.text.delta":
      return withTextPart(view, data, now, (part) => ({ ...part, text: part.text + (stringField(data.delta) ?? "") }))
    case "session.text.ended":
      return withTextPart(view, data, now, (part) => ({
        ...part,
        text: stringField(data.text) ?? part.text,
        ...(phaseField(data.phase) === undefined ? {} : { phase: phaseField(data.phase) }),
      }))
    case "session.reasoning.started":
      return withReasoningPart(view, data, now, (part) => part)
    case "session.reasoning.delta":
      return withReasoningPart(view, data, now, (part) => ({
        ...part,
        text: part.text + (stringField(data.delta) ?? ""),
      }))
    case "session.reasoning.ended":
      return withReasoningPart(view, data, now, (part) => ({ ...part, text: stringField(data.text) ?? part.text }))
    case "session.tool.input.started":
      return withToolActivity(
        withToolPart(view, data, now, (part) => ({
          ...part,
          name: stringField(data.name) ?? part.name,
          status: "streaming",
        })),
        data,
        "pending",
        now,
      )
    case "session.tool.input.delta":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "streaming",
        inputText: (part.inputText ?? "") + (stringField(data.delta) ?? ""),
      }))
    case "session.tool.input.ended":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "running",
        inputText: stringField(data.text) ?? part.inputText,
      }))
    case "session.tool.called":
      return withToolActivity(
        withToolPart(view, data, now, (part) => ({
          ...part,
          status: "running",
          input: recordField(data.input) ?? part.input,
        })),
        data,
        "running",
        now,
      )
    case "session.tool.progress":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "running",
        content: readToolContent(data.content),
        structured: recordField(data.structured) ?? part.structured,
      }))
    case "session.tool.success":
      return withToolActivity(
        withToolPart(view, data, now, (part) => ({
          ...part,
          status: "completed",
          content: readToolContent(data.content),
          input: recordField(data.input) ?? part.input,
          structured: recordField(data.structured) ?? part.structured,
        })),
        data,
        "completed",
        now,
      )
    case "session.tool.failed":
      return withToolActivity(
        withToolPart(view, data, now, (part) => ({
          ...part,
          status: "failed",
          error: readError(data.error)?.message ?? "The tool failed",
        })),
        data,
        "failed",
        now,
      )
    case "session.shell.started":
      return applyShell(view, data, now, false)
    case "session.shell.ended":
      return applyShell(view, data, now, true)
    case "session.file-change.recorded":
      return applyFileChange(view, data, now)
    case "session.compaction.admitted":
    case "session.compaction.started":
      return withCompaction(view, data, "running")
    case "session.compaction.ended":
      return withCompaction(view, data, "completed")
    case "session.compaction.failed":
      return withCompaction(view, data, "failed", readError(data.error)?.message)
    case "session.synthetic":
      return pushMessage(view, {
        kind: "synthetic",
        id: event.id ?? `synthetic_${view.messages.length}`,
        text: stringField(data.text) ?? "",
        ...(stringField(data.description) === undefined ? {} : { description: stringField(data.description) }),
        created: now,
      })
    case "session.skill.activated":
      return pushMessage(view, {
        kind: "notice",
        id: event.id ?? `skill_${view.messages.length}`,
        notice: "skill",
        text: `Skill activated: ${stringField(data.name) ?? stringField(data.id) ?? "unknown"}`,
        created: now,
      })
    case "session.revert.staged":
      return pushNotice(view, "revert", "Revert staged", now)
    case "session.revert.cleared":
      return pushNotice(view, "revert", "Revert cleared", now)
    case "session.revert.committed":
      return pushNotice(view, "revert", `Revert committed to ${stringField(data.to) ?? "boundary"}`, now)
    case "permission.v2.asked":
      return pushRequest(view, {
        kind: "permission",
        id: stringField(data.id) ?? "permission",
        action: stringField(data.action) ?? "unknown action",
        resources: stringList(data.resources),
        askedAt: now,
      })
    case "permission.v2.replied":
      return {
        ...removeRequest(view, stringField(data.requestID)),
        activity: pushActivity(view.activity, {
          id: `permission-${stringField(data.requestID) ?? now}`,
          kind: "approval",
          title: `Permission ${stringField(data.reply) ?? "resolved"}`,
          at: now,
        }),
      }
    case "guardrail.asked":
      return pushRequest(view, {
        kind: "guardrail",
        id: stringField(data.id) ?? "guardrail",
        sessionID: stringField(data.sessionID) ?? view.id,
        ...(stringField(data.rootSessionID) === undefined ? {} : { rootSessionID: stringField(data.rootSessionID) }),
        action: stringField(data.action) ?? "unknown action",
        resources: stringList(data.resources),
        reason: stringField(data.reason) ?? "Guardrail review required",
        hardReview: data.hardReview === true,
        askedAt: now,
      })
    case "guardrail.replied":
      return removeRequest(view, stringField(data.requestID))
    case "guardrail.decided":
      return {
        ...view,
        activity: pushActivity(view.activity, {
          id: `guardrail-${stringField(data.action) ?? now}`,
          kind: "approval",
          title: `Guardrail ${stringField(data.decision) ?? "decided"}`,
          ...(stringField(data.action) === undefined ? {} : { detail: stringField(data.action) }),
          at: now,
        }),
        updatedAt: now,
      }
    case "form.created": {
      const form = readForms([data.form])[0]
      if (form === undefined || form.sessionID !== view.id) return view
      return pushRequest(view, { kind: "form", id: form.id, form, askedAt: now })
    }
    case "form.replied":
    case "form.cancelled":
      return data.sessionID === view.id ? removeRequest(view, stringField(data.id)) : view
    default:
      return bump(view)
  }
}

export function readSnapshotParts(content: unknown): readonly AssistantPart[] {
  if (!Array.isArray(content)) return []
  const parts: AssistantPart[] = []
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === "text") {
      parts.push({
        kind: "text",
        ordinal: parts.length,
        text: stringField(item.text) ?? "",
        ...(phaseField(item.phase) === undefined ? {} : { phase: phaseField(item.phase) }),
      })
      continue
    }
    if (item.type === "reasoning") {
      parts.push({ kind: "reasoning", ordinal: parts.length, text: stringField(item.text) ?? "" })
      continue
    }
    if (item.type === "tool") {
      const state = isRecord(item.state) ? item.state : {}
      const status = stringField(state.status)
      parts.push({
        kind: "tool",
        callID: stringField(item.id) ?? `tool-${parts.length}`,
        name: stringField(item.name) ?? "tool",
        status: status === "error" ? "failed" : status === "streaming" || status === "running" ? status : "completed",
        ...(stringField(state.input) === undefined ? {} : { inputText: stringField(state.input) }),
        ...(recordField(state.input) === undefined ? {} : { input: recordField(state.input) }),
        content: readToolContent(state.content),
        ...(recordField(state.structured) === undefined ? {} : { structured: recordField(state.structured) }),
        ...(readError(state.error)?.message === undefined ? {} : { error: readError(state.error)?.message }),
      })
    }
  }
  return parts
}

export function readToolContent(content: unknown): readonly ToolContentBlock[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((item): readonly ToolContentBlock[] => {
    if (!isRecord(item)) return []
    const type = stringField(item.type) ?? "unknown"
    if (type === "text") {
      const text = stringField(item.text)
      return text === undefined ? [] : [{ kind: "text" as const, text }]
    }
    const summary = Object.entries(item)
      .flatMap(([key, entry]) => (typeof entry === "string" ? [`${key}: ${boundedText(entry, 200).text}`] : []))
      .join(", ")
    return [{ kind: "other" as const, type, summary }]
  })
}

/** Reads the browser-safe structural projection of `Form.Info` without importing runtime code. */
export function readForms(value: unknown): readonly FormView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): readonly FormView[] => {
    if (!isRecord(item)) return []
    const id = stringField(item.id)
    const sessionID = stringField(item.sessionID)
    const title = stringField(item.title)
    if (id === undefined || sessionID === undefined || title === undefined || !Array.isArray(item.fields)) return []
    const fields = item.fields.flatMap(readFormField)
    return fields.length === 0 || fields.length !== item.fields.length ? [] : [{ id, sessionID, title, ...(recordField(item.metadata) === undefined ? {} : { metadata: recordField(item.metadata) }), fields }]
  })
}

function readFormField(value: unknown): readonly FormFieldView[] {
  if (!isRecord(value)) return []
  const key = stringField(value.key)
  const type = stringField(value.type)
  if (key === undefined || type === undefined) return []
  const when = readFormWhen(value.when)
  if (value.when !== undefined && (!Array.isArray(value.when) || when.length !== value.when.length)) return []
  const common = { key, ...(stringField(value.title) === undefined ? {} : { title: stringField(value.title) }), ...(stringField(value.description) === undefined ? {} : { description: stringField(value.description) }), ...(typeof value.required === "boolean" ? { required: value.required } : {}), ...(value.when === undefined ? {} : { when }) }
  if (type === "external") {
    const url = stringField(value.url)
    return url === undefined ? [] : [{ key, type, url, ...(stringField(value.title) === undefined ? {} : { title: stringField(value.title) }), ...(stringField(value.description) === undefined ? {} : { description: stringField(value.description) }) }]
  }
  if (type === "string") {
    const options = readFormOptions(value.options)
    if (value.options !== undefined && (!Array.isArray(value.options) || options.length !== value.options.length)) return []
    return [{ ...common, type,
      ...(value.options === undefined ? {} : { options }),
      ...(typeof value.custom === "boolean" ? { custom: value.custom } : {}),
      ...(typeof value.default === "string" ? { default: value.default } : {}),
      ...(typeof value.placeholder === "string" ? { placeholder: value.placeholder } : {}),
      ...(typeof value.pattern === "string" ? { pattern: value.pattern } : {}),
      ...(typeof value.minLength === "number" ? { minLength: value.minLength } : {}),
      ...(typeof value.maxLength === "number" ? { maxLength: value.maxLength } : {}),
      ...(value.format === "email" || value.format === "uri" || value.format === "date" || value.format === "date-time" ? { format: value.format } : {}),
    }]
  }
  if (type === "multiselect") {
    const options = readFormOptions(value.options)
    if (!Array.isArray(value.options) || options.length !== value.options.length) return []
    return [{ ...common, type, options,
      ...(typeof value.custom === "boolean" ? { custom: value.custom } : {}),
      ...(Array.isArray(value.default) ? { default: stringList(value.default) } : {}),
      ...(typeof value.minItems === "number" ? { minItems: value.minItems } : {}),
      ...(typeof value.maxItems === "number" ? { maxItems: value.maxItems } : {}),
    }]
  }
  if (type === "number" || type === "integer") return [{ ...common, type, ...(typeof value.minimum === "number" ? { minimum: value.minimum } : {}), ...(typeof value.maximum === "number" ? { maximum: value.maximum } : {}), ...(typeof value.default === "number" ? { default: value.default } : {}) }]
  if (type === "boolean") return [{ ...common, type, ...(typeof value.default === "boolean" ? { default: value.default } : {}) }]
  return []
}

function readFormOptions(value: unknown) { return Array.isArray(value) ? value.flatMap((option) => isRecord(option) && stringField(option.value) !== undefined && stringField(option.label) !== undefined ? [{ value: stringField(option.value) ?? "", label: stringField(option.label) ?? "", ...(stringField(option.description) === undefined ? {} : { description: stringField(option.description) }) }] : []) : [] }
function readFormWhen(value: unknown): readonly FormWhenView[] { return Array.isArray(value) ? value.flatMap((when) => isRecord(when) && stringField(when.key) !== undefined && (when.op === "eq" || when.op === "neq") && (typeof when.value === "string" || typeof when.value === "number" || typeof when.value === "boolean") ? [{ key: stringField(when.key) ?? "", op: when.op, value: when.value }] : []) : [] }

export function readError(
  value: unknown,
): { readonly code: string; readonly message: string } | undefined {
  if (!isRecord(value)) return undefined
  const code = stringField(value.code) ?? stringField(value.type)
  const message = stringField(value.message)
  if (code === undefined && message === undefined) return undefined
  return { code: code ?? "error", message: message ?? code ?? "unknown error" }
}

function applyStatus(view: SessionView, data: Record<string, unknown>, now: number): SessionView {
  const status = isRecord(data.status) ? data.status : {}
  if (status.type === "busy") return { ...view, status: "running", updatedAt: now }
  if (status.type === "idle") return { ...view, status: "idle", retry: undefined, updatedAt: now }
  if (status.type === "retry") {
    return {
      ...view,
      status: "running",
      retry: {
        attempt: numberField(status.attempt) ?? 1,
        at: numberField(status.next) ?? now,
        code: stringField(status.message) ?? "retrying",
      },
      updatedAt: now,
    }
  }
  return bump(view)
}

function bump(view: SessionView): SessionView {
  return { ...view, unhandledEvents: view.unhandledEvents + 1 }
}

function readEvent(
  payload: unknown,
): { readonly type: string; readonly id?: string; readonly data: Record<string, unknown> } | undefined {
  if (!isRecord(payload)) return undefined
  const type = stringField(payload.type)
  if (type === undefined) return undefined
  if (!isRecord(payload.data)) return undefined
  return { type, id: stringField(payload.id), data: payload.data }
}

function applyAdmitted(view: SessionView, data: Record<string, unknown>, now: number): SessionView {
  const id = stringField(data.inputID)
  if (id === undefined) return bump(view)
  const existing = view.messages.find((message) => message.id === id)
  // `session.input.admitted` carries `SessionPending.Message`: `{ type, data, delivery }`.
  const pending = isRecord(data.input) ? data.input : {}
  const payload = isRecord(pending.data) ? pending.data : pending
  const text = stringField(payload.text) ?? (existing?.kind === "user" ? existing.text : "")
  const message: RemoteMessageView = {
    kind: "user",
    id,
    text,
    delivery: deliveryField(pending.delivery),
    state: existing?.kind === "user" ? existing.state : "pending",
    created: existing?.kind === "user" ? existing.created : now,
  }
  return existing ? replaceMessage(view, message) : pushMessage(view, message)
}

function pushNotice(view: SessionView, notice: Extract<RemoteMessageView, { kind: "notice" }>["notice"], text: string, now: number): SessionView {
  return pushMessage(view, { kind: "notice", id: `notice_${notice}_${view.messages.length}`, notice, text, created: now })
}

function updateUserMessage(
  view: SessionView,
  id: string | undefined,
  update: (message: Extract<RemoteMessageView, { kind: "user" }>) => Extract<RemoteMessageView, { kind: "user" }>,
): SessionView {
  if (id === undefined) return bump(view)
  const existing = view.messages.find((message) => message.id === id)
  if (!existing || existing.kind !== "user") return view
  return replaceMessage(view, update(existing))
}

function withAssistant(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  update: (
    message: Extract<RemoteMessageView, { kind: "assistant" }>,
  ) => Extract<RemoteMessageView, { kind: "assistant" }>,
): SessionView {
  const id = stringField(data.assistantMessageID)
  if (id === undefined) return bump(view)
  const existing = view.messages.find((message) => message.id === id)
  if (existing && existing.kind !== "assistant") return view
  const message =
    existing ?? { kind: "assistant" as const, id, parts: [] as readonly AssistantPart[], created: now }
  const updated = update(message)
  return existing ? replaceMessage(view, updated) : pushMessage(view, updated)
}

function withTextPart(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  update: (part: Extract<AssistantPart, { kind: "text" }>) => Extract<AssistantPart, { kind: "text" }>,
): SessionView {
  return withPart(view, data, now, "text", update, (ordinal) => ({ kind: "text", ordinal, text: "" }))
}

function withReasoningPart(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  update: (part: Extract<AssistantPart, { kind: "reasoning" }>) => Extract<AssistantPart, { kind: "reasoning" }>,
): SessionView {
  return withPart(view, data, now, "reasoning", update, (ordinal) => ({ kind: "reasoning", ordinal, text: "" }))
}

function withPart<Kind extends "text" | "reasoning">(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  kind: Kind,
  update: (part: Extract<AssistantPart, { kind: Kind }>) => Extract<AssistantPart, { kind: Kind }>,
  create: (ordinal: number) => Extract<AssistantPart, { kind: Kind }>,
): SessionView {
  const ordinal = numberField(data.ordinal)
  if (ordinal === undefined) return bump(view)
  return withAssistant(view, data, now, (message) => {
    const index = message.parts.findIndex((part) => part.kind === kind && part.ordinal === ordinal)
    if (index < 0) return { ...message, parts: [...message.parts, update(create(ordinal))] }
    return {
      ...message,
      parts: message.parts.map((part, position) =>
        position === index ? update(part as Extract<AssistantPart, { kind: Kind }>) : part,
      ),
    }
  })
}

function withToolPart(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  update: (part: Extract<AssistantPart, { kind: "tool" }>) => Extract<AssistantPart, { kind: "tool" }>,
): SessionView {
  const callID = stringField(data.callID)
  if (callID === undefined) return bump(view)
  return withAssistant(view, data, now, (message) => {
    const index = message.parts.findIndex((part) => part.kind === "tool" && part.callID === callID)
    if (index < 0) {
      const created: Extract<AssistantPart, { kind: "tool" }> = {
        kind: "tool",
        callID,
        name: stringField(data.name) ?? "tool",
        status: "running",
        content: [],
      }
      return { ...message, parts: [...message.parts, update(created)] }
    }
    return {
      ...message,
      parts: message.parts.map((part, position) =>
        position === index && part.kind === "tool" ? update(part) : part,
      ),
    }
  })
}

function applyShell(view: SessionView, data: Record<string, unknown>, now: number, ended: boolean): SessionView {
  const shell = isRecord(data.shell) ? data.shell : data
  const shellID = stringField(shell.id) ?? stringField(data.shellID)
  if (shellID === undefined) return bump(view)
  const id = `msg_${shellID.replace(/^sh_/, "")}`
  const existing = view.messages.find((message) => message.id === id)
  const output = readShellOutput(data.output)
  const exit = numberField(shell.exit)
  const message: Extract<RemoteMessageView, { kind: "shell" }> = {
    kind: "shell",
    id,
    shellID,
    command: stringField(shell.command) ?? (existing?.kind === "shell" ? existing.command : "command"),
    status: ended ? stringField(shell.status) ?? "exited" : "running",
    ...(exit === undefined ? existing?.kind === "shell" && existing.exit !== undefined ? { exit: existing.exit } : {} : { exit }),
    ...(output === undefined
      ? existing?.kind === "shell" && existing.output !== undefined
        ? { output: existing.output }
        : {}
      : { output: mergeShellOutputSnapshot(existing?.kind === "shell" ? existing.output : undefined, output) }),
    ...(existing?.kind === "shell" && existing.outputFetch !== undefined ? { outputFetch: existing.outputFetch } : {}),
    created: existing?.kind === "shell" ? existing.created : now,
    ...(ended ? { completed: now } : {}),
  }
  const next = existing ? replaceMessage(view, message) : pushMessage(view, message)
  return {
    ...next,
    activity: pushActivity(next.activity, {
      id: `shell-${shellID}`,
      kind: "terminal",
      title: message.command,
      detail: message.status,
      status: message.status,
      at: now,
    }),
    updatedAt: now,
  }
}

function applyFileChange(view: SessionView, data: Record<string, unknown>, now: number): SessionView {
  const change = resolveFileChange(data)
  if (change === undefined) return bump(view)
  return {
    ...view,
    fileChanges: mergeFileChanges(view.fileChanges, [change]),
    activity: pushActivity(view.activity, {
      id: `file-${change.path}`,
      kind: "file",
      title: change.path,
      detail: `+${change.additions} −${change.deletions}`,
      at: now,
    }),
    updatedAt: now,
  }
}

function withCompaction(
  view: SessionView,
  data: Record<string, unknown>,
  status: "running" | "completed" | "failed",
  error?: string,
): SessionView {
  const id = stringField(data.jobID) ?? stringField(data.inputID) ?? `compaction_${view.messages.length}`
  const trigger = stringField(data.reason) ?? stringField(data.trigger)
  const existing = view.messages.find((message) => message.id === id)
  const message: Extract<RemoteMessageView, { kind: "compaction" }> = {
    kind: "compaction",
    id,
    status,
    ...(trigger === undefined ? {} : { trigger }),
    ...(error === undefined ? {} : { error }),
  }
  return existing ? replaceMessage(view, message) : pushMessage(view, message)
}

/** Mirrors one tool call into the activity stream so the panel reflects live work. */
function withToolActivity(
  view: SessionView,
  data: Record<string, unknown>,
  status: "pending" | "running" | "completed" | "failed",
  now: number,
): SessionView {
  const assistantMessageID = stringField(data.assistantMessageID)
  const callID = stringField(data.callID)
  if (assistantMessageID === undefined || callID === undefined) return view
  const message = view.messages.find((entry) => entry.id === assistantMessageID)
  const name =
    message?.kind === "assistant"
      ? message.parts.find(
          (part): part is Extract<AssistantPart, { kind: "tool" }> =>
            part.kind === "tool" && part.callID === callID,
        )?.name
      : undefined
  if (name === undefined) return view
  return {
    ...view,
    activity: pushActivity(view.activity, { id: `tool-${callID}`, kind: "tool", title: name, status, at: now }),
    updatedAt: now,
  }
}

function pushMessage(view: SessionView, message: RemoteMessageView): SessionView {
  return { ...view, messages: [...view.messages, message] }
}

function replaceMessage(view: SessionView, message: RemoteMessageView): SessionView {
  const index = view.messages.findIndex((existing) => existing.id === message.id)
  if (index < 0) return { ...view, messages: [...view.messages, message] }
  return { ...view, messages: view.messages.map((existing, position) => (position === index ? message : existing)) }
}

function pushRequest(view: SessionView, request: PendingRequestView): SessionView {
  return { ...view, requests: [...view.requests.filter((existing) => existing.id !== request.id), request] }
}

function removeRequest(view: SessionView, requestID: string | undefined): SessionView {
  if (requestID === undefined) return bump(view)
  return { ...view, requests: view.requests.filter((request) => request.id !== requestID) }
}

function pushActivity(activity: readonly ActivityItem[], item: ActivityItem): readonly ActivityItem[] {
  return [...activity.filter((existing) => existing.id !== item.id), item].slice(-activityLimit)
}

function readSnapshotMessage(value: unknown): RemoteMessageView | undefined {
  if (!isRecord(value)) return undefined
  const id = stringField(value.id)
  const type = stringField(value.type)
  if (id === undefined || type === undefined) return undefined
  const time = isRecord(value.time) ? value.time : {}
  const created = numberField(time.created) ?? 0
  const completed = numberField(time.completed)

  if (type === "user") {
    // The projection carries no delivery mode and marks consumption by timestamp.
    return {
      kind: "user",
      id,
      text: stringField(value.text) ?? "",
      state: numberField(time.consumed) === undefined ? "promoted" : "consumed",
      created,
    }
  }
  if (type === "system") return { kind: "system", id, text: stringField(value.text) ?? "", created }
  if (type === "synthetic") {
    const description = stringField(value.description)
    return { kind: "synthetic", id, text: stringField(value.text) ?? "", ...(description === undefined ? {} : { description }), created }
  }
  if (type === "agent-switched") {
    return { kind: "notice", id, notice: "agent-switched", text: `Agent: ${stringField(value.agent) ?? "unknown"}`, created }
  }
  if (type === "model-switched") {
    return { kind: "notice", id, notice: "model-switched", text: `Model: ${modelLabel(readModelRef(value.model)) ?? "unknown"}`, created }
  }
  if (type === "skill") {
    return { kind: "notice", id, notice: "skill", text: `Skill: ${stringField(value.name) ?? stringField(value.skill) ?? "unknown"}`, created }
  }
  if (type === "shell") {
    const output = readShellOutput(value.output)
    const exit = numberField(value.exit)
    return {
      kind: "shell",
      id,
      shellID: stringField(value.shellID) ?? id,
      command: stringField(value.command) ?? "command",
      status: stringField(value.status) ?? "exited",
      ...(exit === undefined ? {} : { exit }),
      ...(output === undefined ? {} : { output }),
      created,
      ...(completed === undefined ? {} : { completed }),
    }
  }
  if (type === "compaction") {
    const status = stringField(value.status)
    const summary = stringField(value.summary)
    const trigger = stringField(value.reason)
    return {
      kind: "compaction",
      id,
      status: status === "pending" || status === "running" || status === "failed" ? status : "completed",
      ...(trigger === undefined ? {} : { trigger }),
      ...(summary === undefined ? {} : { summary: boundedText(summary).text }),
    }
  }
  if (type === "assistant") {
    const error = readError(value.error)
    const assistantModel = readModelRef(value.model)
    return {
      kind: "assistant",
      id,
      ...(stringField(value.agent) === undefined ? {} : { agent: stringField(value.agent) }),
      ...(assistantModel === undefined ? {} : { model: assistantModel }),
      parts: readSnapshotParts(value.content),
      created,
      ...(completed === undefined ? {} : { completed }),
      ...(error === undefined ? {} : { error: error.message }),
    }
  }
  return undefined
}

function readGoal(value: Record<string, unknown>): NonNullable<SessionAutonomyView["goal"]> | undefined {
  const text = stringField(value.text)
  if (text === undefined) return undefined
  const status = stringField(value.status)
  return {
    text,
    status: status === "completed" || status === "stopped" || status === "exhausted" ? status : "active",
    iteration: numberField(value.iteration) ?? 0,
    noProgress: numberField(value.noProgress) ?? 0,
    maxNoProgress: numberField(value.maxNoProgress) ?? 0,
  }
}

function readYolo(value: unknown): 0 | 1 | 2 | 3 {
  if (value === true) return 2
  if (value === 1 || value === 2 || value === 3) return value
  return 0
}

function deliveryField(value: unknown): "steer" | "queue" {
  return value === "queue" ? "queue" : "steer"
}

function phaseField(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined
}

function dataOf(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) return payload.data
  return payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function recordField(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/* -------------------------------------------------------------------------- */
/* Snapshot and list reads                                                    */
/* -------------------------------------------------------------------------- */

export type SessionSnapshot = {
  readonly messages: readonly RemoteMessageView[]
  readonly title?: string
  readonly agent?: string
  readonly model?: ModelRefView
  readonly archived?: boolean
  /** Highest durable sequence covered by the snapshot; events at or below it are duplicates. */
  readonly watermark?: number
  readonly sourceEpoch?: string
}

/**
 * Reads `v2.session.snapshot` (`{ sourceEpoch, session, messages, watermark }`).
 * A body that is not a session projection is rejected instead of being read as
 * an empty projection, so a wrong response cannot erase the transcript.
 */
export function readSnapshot(payload: unknown): SessionSnapshot | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined
  const session = isRecord(payload.session) ? payload.session : {}
  const watermark = isRecord(payload.watermark) ? numberField(payload.watermark.seq) : undefined
  const sourceEpoch = stringField(payload.sourceEpoch)
  const archived = isRecord(session.time) && numberField(session.time.archived) !== undefined
  const model = readModelRef(session.model)
  return {
    messages: payload.messages.flatMap((item) => {
      const message = readSnapshotMessage(item)
      return message ? [message] : []
    }),
    ...(stringField(session.title) === undefined ? {} : { title: stringField(session.title) }),
    ...(stringField(session.agent) === undefined ? {} : { agent: stringField(session.agent) }),
    ...(model === undefined ? {} : { model }),
    ...(archived ? { archived: true } : {}),
    ...(watermark === undefined ? {} : { watermark }),
    ...(sourceEpoch === undefined ? {} : { sourceEpoch }),
  }
}

/** Part keys a snapshot already covers; matching ephemeral fragments are stale. */
export function sealedPartKeys(messages: readonly RemoteMessageView[]): readonly string[] {
  return messages.flatMap((message) => {
    if (message.kind !== "assistant") return []
    return message.parts.flatMap((part) => {
      if (part.kind === "text" || part.kind === "reasoning") return [partKey(message.id, part.kind, String(part.ordinal))]
      if (part.kind === "tool") return [partKey(message.id, "tool", part.callID)]
      return []
    })
  })
}

/** Part key for an ephemeral fragment, when it names one. */
export function ephemeralPartKey(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.type !== "string") return undefined
  if (!payload.type.startsWith("session.text.") && !payload.type.startsWith("session.reasoning.") && !payload.type.startsWith("session.tool.")) {
    return undefined
  }
  if (!isRecord(payload.data)) return undefined
  const assistantMessageID = stringField(payload.data.assistantMessageID)
  if (assistantMessageID === undefined) return undefined
  if (payload.type.startsWith("session.tool.")) {
    const callID = stringField(payload.data.callID)
    return callID === undefined ? undefined : partKey(assistantMessageID, "tool", callID)
  }
  const ordinal = numberField(payload.data.ordinal)
  if (ordinal === undefined) return undefined
  return partKey(assistantMessageID, payload.type.startsWith("session.reasoning.") ? "reasoning" : "text", String(ordinal))
}

/** Part key that a durable boundary re-opens. */
export function openedPartKey(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.type !== "string") return undefined
  if (!isRecord(payload.data)) return undefined
  const assistantMessageID = stringField(payload.data.assistantMessageID)
  if (assistantMessageID === undefined) return undefined
  if (payload.type === "session.tool.input.started") {
    const callID = stringField(payload.data.callID)
    return callID === undefined ? undefined : partKey(assistantMessageID, "tool", callID)
  }
  if (payload.type === "session.text.started" || payload.type === "session.reasoning.started") {
    const ordinal = numberField(payload.data.ordinal)
    if (ordinal === undefined) return undefined
    return partKey(assistantMessageID, payload.type === "session.reasoning.started" ? "reasoning" : "text", String(ordinal))
  }
  return undefined
}

/** Durable aggregate a payload belongs to, when it declares one. */
export function readAggregateID(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.durable)) return undefined
  return stringField(payload.durable.aggregateID)
}

function partKey(messageID: string, kind: string, part: string): string {
  return `${messageID}:${kind}:${part}`
}

export function readPermissionRequests(payload: unknown, now: number): readonly PendingRequestView[] {
  return readDataList(payload).flatMap((item) => {
    if (!isRecord(item)) return []
    const id = stringField(item.id)
    if (id === undefined) return []
    return [
      {
        kind: "permission" as const,
        id,
        action: stringField(item.action) ?? "unknown action",
        resources: stringList(item.resources),
        askedAt: now,
      },
    ]
  })
}

export function readGuardrailRequests(payload: unknown, now: number): readonly PendingRequestView[] {
  return readDataList(payload).flatMap((item) => {
    if (!isRecord(item)) return []
    const id = stringField(item.id)
    const sessionID = stringField(item.sessionID)
    if (id === undefined || sessionID === undefined) return []
    return [
      {
        kind: "guardrail" as const,
        id,
        sessionID,
        ...(stringField(item.rootSessionID) === undefined ? {} : { rootSessionID: stringField(item.rootSessionID) }),
        action: stringField(item.action) ?? "unknown action",
        resources: stringList(item.resources),
        reason: stringField(item.reason) ?? "Guardrail review required",
        hardReview: item.hardReview === true,
        askedAt: now,
      },
    ]
  })
}

export function readFormRequests(payload: unknown, now: number): readonly Extract<PendingRequestView, { kind: "form" }>[] {
  return readForms(payload).map((form) => ({ kind: "form", id: form.id, form, askedAt: now }))
}

/** Reads `GET /api/session/:sessionID/file-change`: `{ data: FileChange.Info[] }`. */
export function readFileChangeList(payload: unknown): readonly FileChangeView[] {
  return readDataList(payload).flatMap((item) => {
    const change = readFileChange(item)
    return change === undefined ? [] : [change]
  })
}

/** `session.file-change.recorded` change, when the payload is that event. */
export function readFileChangeEvent(payload: unknown): FileChangeView | undefined {
  if (!isRecord(payload) || payload.type !== "session.file-change.recorded") return undefined
  if (!isRecord(payload.data)) return undefined
  return resolveFileChange(payload.data)
}

/** Latest-per-path merge: an update replaces the same path and keeps first-seen order. */
export function mergeFileChanges(
  base: readonly FileChangeView[],
  updates: readonly FileChangeView[],
): readonly FileChangeView[] {
  const byPath = new Map(base.map((change) => [change.path, change] as const))
  for (const change of updates) byPath.set(change.path, change)
  return [...byPath.values()]
}

/** Replaces the recorded changes with an authoritative ledger read. */
export function replaceFileChanges(view: SessionView, fileChanges: readonly FileChangeView[]): SessionView {
  return { ...view, fileChanges: [...fileChanges] }
}

function resolveFileChange(data: Record<string, unknown>): FileChangeView | undefined {
  return readFileChange(isRecord(data.change) ? data.change : data)
}

function readFileChange(value: unknown): FileChangeView | undefined {
  if (!isRecord(value)) return undefined
  const path = stringField(value.path)
  if (path === undefined || typeof value.patch !== "string") return undefined
  return {
    path,
    patch: value.patch,
    additions: numberField(value.additions) ?? 0,
    deletions: numberField(value.deletions) ?? 0,
  }
}

/** Durable sequence and epoch carried by one event payload. */
export function readEventSequence(payload: unknown): { readonly seq?: number; readonly sourceEpoch?: string } {
  if (!isRecord(payload)) return {}
  const durable = isRecord(payload.durable) ? payload.durable : {}
  return {
    ...(numberField(durable.seq) === undefined ? {} : { seq: numberField(durable.seq) }),
    ...(stringField(payload.sourceEpoch) === undefined ? {} : { sourceEpoch: stringField(payload.sourceEpoch) }),
  }
}

/**
 * A guardrail list covers the root session family. Only reviews owned by the
 * active session may be answered from this client.
 */
export function canReplyToRequest(request: PendingRequestView, activeSessionID: string | undefined): boolean {
  if (request.kind !== "guardrail") return true
  return activeSessionID !== undefined && request.sessionID === activeSessionID
}

/** Replaces the request queue with an authoritative list read. */
export function replaceRequests(view: SessionView, requests: readonly PendingRequestView[]): SessionView {
  return { ...view, requests: [...requests] }
}
