// Client data layer: apply server events and cache API reads into a Solid store.
// Transcript request identities prevent an evicted session load from becoming reachable after
// navigation. Reconnect invalidates cached reads; active UI owners decide what to sync again.

import type {
  AgentInfo,
  CommandInfo,
  ConfigDiagnostic,
  FormInfo,
  GuardrailRequestListOutput,
  IntegrationInfo,
  LocationRef,
  LocationGetOutput,
  ModelRef,
  McpResource,
  McpServer,
  ModelInfo,
  PermissionSavedInfo,
  PermissionRequest,
  ProviderRequestSummary,
  ProviderInfo,
  ReferenceInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionInfo,
  SessionCompactionListOutput,
  SessionDiagnosticsOutput,
  SessionOrchestrationPage,
  SessionPendingInfo,
  SessionTodoInfo,
  ShellInfo,
  SkillInfo,
  TelemetryClientSample,
  YCodingEvent,
} from "@ycoding-ai/client"
import type { Plugin } from "@ycoding-ai/plugin/tui"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { batch, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { createPromptSubmissions } from "../prompt/submission"
import { errorMessage } from "../util/error"

export type DataSessionHistory = {
  status: "loading" | "paging" | "ready" | "error"
  before?: string
  checkpoint: boolean
  error?: string
  failedRead?: "latest" | "older"
  sourceEpoch?: string
  watermark?: number
}

const HISTORY_PAGE_SIZE = 100

export type DataSessionStatus = "idle" | "running"

export type DataSessionMemoryEstimate = {
  process: { heapUsed: number; heapTotal: number; rss: number }
  estimated: {
    total: number
    truncated: boolean
    categories: {
      message: number
      toolInput: number
      toolOutput: number
      toolStructured: number
      toolResult: number
      toolAttachments: number
      userFiles: number
      shellOutput: number
      other: number
    }
  }
  counts: { messages: number; residentSessions: number }
}

const messageIDFromEvent = (eventID: string) => eventID.replace(/^evt_/, "msg_")

type CurrentCompactionMessage = Extract<SessionMessageInfo, { type: "compaction"; jobID: string }>

export type DataSessionCompactionLifecycle = {
  jobID: string
  messageID?: string
  trigger?: CurrentCompactionMessage["trigger"]
  pressure?: CurrentCompactionMessage["pressure"]
  status: "pending" | "running" | "completed" | "failed"
  revision?: number
  boundary?: { messageID: string; seq: number }
  metrics?: { excludedMessages: number; excludedParts: number; inputTokens: number; retainedTokens: number }
  code?: Extract<CurrentCompactionMessage, { status: "failed" }>["code"]
  error?: { type: string; message: string }
  time: { created: number }
}

function currentCompaction(message: SessionMessageInfo): CurrentCompactionMessage | undefined {
  if (message.type !== "compaction" || !("jobID" in message)) return undefined
  return message
}

function compactionLifecycle(message: SessionMessageInfo): DataSessionCompactionLifecycle | undefined {
  const current = currentCompaction(message)
  if (!current) return undefined
  const base = {
    jobID: current.jobID,
    messageID: current.id,
    trigger: current.trigger,
    pressure: current.pressure,
    status: current.status,
    time: current.time,
  }
  if ("metrics" in current)
    return { ...base, revision: current.revision, boundary: current.boundary, metrics: current.metrics }
  if ("code" in current) return { ...base, code: current.code, error: current.error }
  return base
}

function mergeCompactionLifecycle(
  current: DataSessionCompactionLifecycle | undefined,
  update: DataSessionCompactionLifecycle,
): DataSessionCompactionLifecycle {
  if (!current) return update
  const rank = { pending: 0, running: 1, completed: 2, failed: 2 }
  const lifecycle = rank[update.status] >= rank[current.status] ? update : current
  const messageID = update.messageID ?? current.messageID
  const trigger = update.trigger ?? current.trigger
  const pressure = update.pressure ?? current.pressure
  const base = {
    jobID: update.jobID,
    ...(messageID ? { messageID } : {}),
    ...(trigger ? { trigger } : {}),
    ...(pressure ? { pressure } : {}),
    time: { created: Math.min(current.time.created, update.time.created) },
  }
  if (lifecycle.status === "completed")
    return {
      ...base,
      status: lifecycle.status,
      revision: lifecycle.revision,
      boundary: lifecycle.boundary,
      metrics: lifecycle.metrics,
    }
  if (lifecycle.status === "failed")
    return { ...base, status: lifecycle.status, code: lifecycle.code, error: lifecycle.error }
  return { ...base, status: lifecycle.status }
}

// Global MCP elicitations temporarily use "global" instead of a real session ID, so the
// server cannot recover their Location when settling them. Preserve the event Location
// until MCP elicitations carry session ownership.
export type FormWithLocation = FormInfo & { readonly location?: LocationRef }

type SubagentPage = SessionOrchestrationPage & {
  readonly offset: number
  readonly position: "top" | "older"
}

type LocationData = {
  info?: LocationGetOutput
  agent?: AgentInfo[]
  command?: CommandInfo[]
  integration?: IntegrationInfo[]
  mcp?: {
    server?: McpServer[]
    resource?: McpResource[]
  }
  config?: { diagnostics?: ConfigDiagnostic[] }
  model?: ModelInfo[]
  modelDefault?: ModelRef
  provider?: ProviderInfo[]
  reference?: ReferenceInfo[]
  // Currently running shell commands for this location, keyed by shell id. Entries are removed
  // once the command exits or is deleted, so this only ever holds in-flight shells.
  shell?: Record<string, ShellInfo>
  skill?: SkillInfo[]
}

type Store = {
  session: {
    info: Record<string, SessionInfo>
    // Family index keyed by a family's root (or furthest-known-ancestor when the
    // true root is not yet loaded). The value is a flat deduplicated list of every
    // session ID in that family, including the key itself once its info arrives.
    family: Record<string, string[]>
    active: Record<string, DataSessionStatus>
    diagnostics: Record<string, SessionDiagnosticsOutput>
    prediction: Record<string, { sourceMessageID: string; text: string } | undefined>
    predictionDismissed: Record<string, string | undefined>
    usage: Record<string, ProviderRequestSummary>
    message: Record<string, SessionMessageInfo[]>
    history: Record<string, DataSessionHistory>
    compaction: Record<string, Record<string, DataSessionCompactionLifecycle>>
    compactionHistory: Record<string, SessionCompactionListOutput>
    pending: Record<string, SessionPendingInfo[]>
    subagent: Record<string, SubagentPage>
    todo: Record<string, SessionTodoInfo[]>
    input: Record<string, string[]>
    permission: Record<string, PermissionRequest[]>
    guardrail: Record<string, GuardrailRequestListOutput>
    // Pending forms keyed by owner: a session ID or the temporary "global" elicitation sentinel.
    form: Record<string, FormWithLocation[]>
  }
  project: {
    permission: Record<string, PermissionSavedInfo[]>
  }
  location: Record<string, LocationData>
}

function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

function locationQuery(ref?: LocationRef) {
  return ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined
}

function isMessageComplete(message: SessionMessageInfo) {
  if (message.type === "shell") return message.status !== "running"
  if (message.type === "compaction") {
    if (currentCompaction(message)) return message.status === "completed" || message.status === "failed"
    return message.status !== "running"
  }
  if (message.type !== "assistant") return true
  if (!message.time.completed) return false
  return message.content.every((item) => {
    if (item.type === "tool") return item.state.status !== "streaming" && item.state.status !== "running"
    if (item.type === "reasoning" && item.time) return item.time.completed !== undefined
    return true
  })
}

function messageRevision(message: SessionMessageInfo) {
  const revision: unknown[] = [message.type, message.time.created, message.metadata]
  if (message.type === "user") revision.push(message.text, message.files, message.agents)
  if (message.type === "synthetic") revision.push(message.text, message.description)
  if (message.type === "system") revision.push(message.text)
  if (message.type === "skill") revision.push(message.skill, message.name, message.text, message.conflicts)
  if (message.type === "shell")
    revision.push(
      message.shellID,
      message.command,
      message.status,
      message.exit,
      message.output,
      message.time.completed,
    )
  if (message.type === "compaction") {
    if (currentCompaction(message)) {
      const current = currentCompaction(message)
      if (!current) return revision
      revision.push(
        current.jobID,
        current.trigger,
        current.status,
        "revision" in current ? current.revision : undefined,
        "boundary" in current ? current.boundary : undefined,
        "metrics" in current ? current.metrics : undefined,
        "code" in current ? current.code : undefined,
        "error" in current ? current.error : undefined,
      )
    } else {
      revision.push(
        message.status,
        "reason" in message ? message.reason : undefined,
        "summary" in message ? message.summary : undefined,
        "recent" in message ? message.recent : undefined,
        "error" in message ? message.error : undefined,
      )
    }
  }
  if (message.type === "agent-switched") revision.push(message.agent)
  if (message.type === "model-switched") revision.push(message.model, message.previous)
  if (message.type === "assistant") {
    revision.push(
      message.agent,
      message.model,
      message.snapshot,
      message.finish,
      message.cost,
      message.tokens,
      message.diagnostics,
      message.error,
      message.retry,
      message.time.completed,
      message.content.length,
    )
    message.content.forEach((content) => {
      revision.push(content.type)
      if (content.type === "text") revision.push(content.text)
      if (content.type === "reasoning")
        revision.push(content.text, content.state, content.time?.created, content.time?.completed)
      if (content.type === "tool")
        revision.push(
          content.id,
          content.name,
          content.executed,
          content.providerState,
          content.providerResultState,
          content.time.created,
          content.time.ran,
          content.time.completed,
          content.state.status,
          content.state.input,
          "structured" in content.state ? content.state.structured : undefined,
          "content" in content.state ? content.state.content : undefined,
          "result" in content.state ? content.state.result : undefined,
          "error" in content.state ? content.state.error : undefined,
        )
    })
  }
  return revision
}

function sameRevision(left: unknown[] | undefined, right: unknown[]) {
  return left?.length === right.length && right.every((value, index) => Object.is(value, left[index]))
}

function reconcileCanonicalMessages(
  api: SessionMessageInfo[],
  current: SessionMessageInfo[],
  touched: ReadonlySet<string>,
  active: ReadonlySet<string>,
  older: ReadonlySet<string> = new Set(),
) {
  const positions = new Map<string, number>()
  const messages: SessionMessageInfo[] = []
  api.forEach((message) => {
    const position = positions.get(message.id)
    if (position === undefined) {
      positions.set(message.id, messages.length)
      messages.push(message)
      return
    }
    messages[position] = message
  })
  const currentIndex = new Map(current.map((message, index) => [message.id, index]))
  current.forEach((message) => {
    const position = positions.get(message.id)
    const preserve =
      touched.has(message.id) ||
      active.has(message.id) ||
      (position === undefined && !isMessageComplete(message)) ||
      (position === undefined && older.has(message.id))
    if (!preserve) return
    if (position === undefined) {
      const origin = currentIndex.get(message.id) ?? current.length
      const insertAt =
        current
          .slice(origin + 1)
          .map((later) => positions.get(later.id))
          .find((later) => later !== undefined) ?? messages.length
      messages.splice(insertAt, 0, message)
      positions.forEach((value, id) => {
        if (value >= insertAt) positions.set(id, value + 1)
      })
      positions.set(message.id, insertAt)
      return
    }
    messages[position] = message
  })
  return messages.map((message) => {
    if (message.type !== "assistant" || message.time.completed !== undefined) return message
    const resident = current.find((item) => item.id === message.id)
    if (resident?.type !== "assistant" || resident === message) return message
    const ordinal = { text: 0, reasoning: 0 }
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "tool") {
          const live = resident.content.find((item) => item.type === "tool" && item.id === part.id)
          if (part.state.status !== "streaming" || live?.type !== "tool" || live.state.status !== "streaming")
            return part
          return live.state.input.startsWith(part.state.input)
            ? { ...part, state: { ...part.state, input: live.state.input } }
            : part
        }
        const live = resident.content.filter((item) => item.type === part.type)[ordinal[part.type]++]
        if (!live || live.type === "tool" || (part.type === "reasoning" && part.time?.completed)) return part
        return live.text.startsWith(part.text) ? { ...part, text: live.text } : part
      }),
    }
  })
}

export function estimateResidentSessionMemory(input: {
  messages: SessionMessageInfo[]
  residentSessions: number
  process: DataSessionMemoryEstimate["process"]
  maxNodes?: number
}): DataSessionMemoryEstimate {
  const categories = {
    message: 0,
    toolInput: 0,
    toolOutput: 0,
    toolStructured: 0,
    toolResult: 0,
    toolAttachments: 0,
    userFiles: 0,
    shellOutput: 0,
    other: 0,
  }
  const seen = new WeakSet<object>()
  const limit = input.maxNodes ?? 100_000
  let nodes = 0
  let truncated = false
  type Pending =
    | { type: "value"; value: unknown }
    | { type: "array"; value: unknown[]; index: number }
    | { type: "object"; iterator: Iterator<unknown> }
  const values = function* (value: object) {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      yield (value as Record<string, unknown>)[key]
    }
  }
  const add = (category: keyof typeof categories, value: unknown) => {
    const pending: Pending[] = [{ type: "value", value }]
    while (pending.length) {
      const frame = pending.pop()!
      if (frame.type === "array") {
        if (frame.index >= frame.value.length) continue
        pending.push({ ...frame, index: frame.index + 1 }, { type: "value", value: frame.value[frame.index] })
        continue
      }
      if (frame.type === "object") {
        const next = frame.iterator.next()
        if (next.done) continue
        pending.push(frame, { type: "value", value: next.value })
        continue
      }
      const item = frame.value
      if (item === undefined || item === null) continue
      nodes++
      if (nodes > limit) {
        truncated = true
        return
      }
      if (typeof item === "string") {
        categories[category] += Buffer.byteLength(item)
        continue
      }
      if (typeof item === "number" || typeof item === "bigint") {
        categories[category] += 8
        continue
      }
      if (typeof item === "boolean") {
        categories[category] += 4
        continue
      }
      if (typeof item !== "object" || seen.has(item)) continue
      seen.add(item)
      if (Array.isArray(item)) pending.push({ type: "array", value: item, index: 0 })
      else pending.push({ type: "object", iterator: values(item) })
    }
  }
  const inspect = (message: SessionMessageInfo) => {
    add("message", [message.id, message.type, message.metadata, message.time])
    if (message.type === "user") {
      add("message", [message.text, message.agents])
      add("userFiles", message.files)
      return
    }
    if (message.type === "assistant") {
      add("message", [
        message.agent,
        message.model,
        message.snapshot,
        message.finish,
        message.cost,
        message.tokens,
        message.diagnostics,
        message.error,
        message.retry,
      ])
      message.content.forEach((content) => {
        if (content.type !== "tool") {
          add("message", content)
          return
        }
        add("toolResult", [
          content.id,
          content.name,
          content.executed,
          content.providerState,
          content.providerResultState,
          content.time,
          content.state.status,
          "error" in content.state ? content.state.error : undefined,
          "result" in content.state ? content.state.result : undefined,
        ])
        add("toolInput", content.state.input)
        if (content.state.status === "streaming") return
        add("toolStructured", content.state.structured)
        content.state.content.forEach((item) => add(item.type === "file" ? "toolAttachments" : "toolOutput", item))
      })
      return
    }
    if (message.type === "shell") {
      add("other", [message.shellID, message.command, message.status, message.exit])
      add("shellOutput", message.output)
      return
    }
    if (message.type === "synthetic") add("other", [message.text, message.description])
    if (message.type === "system") add("other", message.text)
    if (message.type === "skill") add("other", [message.skill, message.name, message.text, message.conflicts])
    if (message.type === "compaction")
      add("other", [
        message.status,
        "reason" in message ? message.reason : undefined,
        "summary" in message ? message.summary : undefined,
        "recent" in message ? message.recent : undefined,
        "error" in message ? message.error : undefined,
      ])
    if (message.type === "agent-switched") add("other", message.agent)
    if (message.type === "model-switched") add("other", [message.model, message.previous])
  }
  input.messages.some((message) => {
    inspect(message)
    return truncated
  })
  return {
    process: input.process,
    estimated: {
      total: Object.values(categories).reduce((total, value) => total + value, 0),
      truncated,
      categories,
    },
    counts: {
      messages: input.messages.length,
      residentSessions: input.residentSessions,
    },
  }
}

export function formatMemoryBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

export function sessionMemoryLines(memory: DataSessionMemoryEstimate) {
  const categories = memory.estimated.categories
  return [
    "Global process metrics (direct)",
    `heapUsed  ${formatMemoryBytes(memory.process.heapUsed)}`,
    `heapTotal ${formatMemoryBytes(memory.process.heapTotal)}`,
    `rss       ${formatMemoryBytes(memory.process.rss)}`,
    "Estimated resident payload (approximate)",
    `Total                         ${formatMemoryBytes(memory.estimated.total)}`,
    `Message / text + reasoning    ${formatMemoryBytes(categories.message)}`,
    `Tool input                    ${formatMemoryBytes(categories.toolInput)}`,
    `Tool output                   ${formatMemoryBytes(categories.toolOutput)}`,
    `Tool structured               ${formatMemoryBytes(categories.toolStructured)}`,
    `Tool result                   ${formatMemoryBytes(categories.toolResult)}`,
    `Tool attachments              ${formatMemoryBytes(categories.toolAttachments)}`,
    `User files                    ${formatMemoryBytes(categories.userFiles)}`,
    `Shell output                  ${formatMemoryBytes(categories.shellOutput)}`,
    `Skill / synthetic / other     ${formatMemoryBytes(categories.other)}`,
    `Messages ${memory.counts.messages} · Resident sessions ${memory.counts.residentSessions}`,
    memory.estimated.truncated
      ? "Estimate truncated at the traversal limit; object overhead and shared backing stores are excluded."
      : "Estimate excludes object overhead and shared backing stores; it is not exact per-session heap attribution.",
  ]
}

function createSync(settled: () => void, closed: () => boolean) {
  type Load = (current: () => boolean) => Promise<void>
  type Entry = {
    generation: number
    requestGeneration: number
    loaded: boolean
    pending?: Promise<void>
    trailing?: Promise<void>
  }
  const state = new Map<string, Entry>()
  function finish(key: string, entry: Entry) {
    if (state.get(key) !== entry) return
    if (!entry.pending && !entry.trailing && !entry.loaded) state.delete(key)
    settled()
  }
  function run(key: string, load: Load): Promise<void> {
    const entry: Entry = state.get(key) ?? { generation: 0, requestGeneration: 0, loaded: false }
    state.set(key, entry)
    if (entry.pending) {
      if (entry.requestGeneration === entry.generation) return entry.pending
      if (entry.trailing) return entry.trailing
      const refresh = () => (state.get(key) === entry ? run(key, load) : Promise.resolve())
      const trailing = entry.pending.then(refresh, refresh).finally(() => {
        if (entry.trailing === trailing) entry.trailing = undefined
        finish(key, entry)
      })
      entry.trailing = trailing
      return trailing
    }
    if (entry.loaded) return Promise.resolve()
    const generation = entry.generation
    entry.requestGeneration = generation
    const current = () => state.get(key) === entry && entry.generation === generation
    const pending = load(current)
      .then(() => {
        if (current()) entry.loaded = true
      })
      .catch((error: unknown) => {
        if (!closed()) throw error
      })
      .finally(() => {
        if (entry.pending === pending) entry.pending = undefined
        finish(key, entry)
      })
    entry.pending = pending
    return pending
  }
  return {
    run,
    complete(key: string) {
      if (state.has(key)) return
      state.set(key, { generation: 0, requestGeneration: 0, loaded: true })
    },
    invalidate(key?: string) {
      for (const id of key ? [key] : [...state.keys()]) {
        const entry = state.get(id)
        if (!entry) continue
        if (!entry.pending && !entry.trailing) {
          state.delete(id)
          continue
        }
        entry.generation++
        entry.loaded = false
      }
    },
    forget(key: string) {
      state.delete(key)
    },
    pendingSessions() {
      return [...state].flatMap(([key, entry]) =>
        (entry.pending || entry.trailing) && key.startsWith("session")
          ? [key.startsWith("session.form:") ? key.slice("session.form:".length, -1) : key.slice(key.indexOf(":") + 1)]
          : [],
      )
    },
  }
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    recordTelemetry?: (metric: TelemetryClientSample["metric"], durationMs: number, at?: number) => void
    selectedSessionID?: () => string | undefined
  }) => {
    const [store, setStore] = createStore<Store>({
      session: {
        info: {},
        family: {},
        active: {},
        diagnostics: {},
        prediction: {},
        predictionDismissed: {},
        usage: {},
        message: {},
        history: {},
        compaction: {},
        compactionHistory: {},
        pending: {},
        subagent: {},
        todo: {},
        input: {},
        permission: {},
        guardrail: {},
        form: {},
      },
      project: {
        permission: {},
      },
      location: {},
    })

    const client = useClient()
    const submissions = createPromptSubmissions({
      api: () => client.api,
      promptAdmitted: (durationMs) => props.recordTelemetry?.("prompt.admit", durationMs),
      created: (session) => {
        setStore("session", "info", session.id, session)
        registerSession(session.id)
      },
      admitted: (pending) => {
        addPending(pending)
        if (!store.session.input[pending.sessionID]?.includes(pending.id))
          setStore("session", "input", pending.sessionID, [
            ...(store.session.input[pending.sessionID] ?? []),
            pending.id,
          ])
        projectPending(pending)
      },
    })
    onCleanup(() => submissions.dispose())
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: process.cwd(),
    })
    const messageIndex = new Map<string, Map<string, number>>()
    const messageSyncLoad = new Map<string, object>()
    const messageVersion = new Map<string, number>()
    const messageMutations = new Map<string, Map<string, number>>()
    const messageMutationSeq = new Map<string, Map<string, number>>()
    const messageOrderSeq = new Map<string, Map<string, number>>()
    const olderMessageIDs = new Map<string, Set<string>>()
    const historyOwner = new Map<string, object>()
    const olderLoads = new Map<string, Promise<void>>()
    const streamSequence = new Map<string, number>()
    let applyingSequence: number | undefined
    let sourceEpoch: string | undefined
    const subagentGeneration = new Map<string, number>()
    const metadataRecency = new Set<string>()
    const metadataReads = new Map<object, string>()
    const sync = createSync(pruneMetadata, () => client.api.transport.state === "closed")

    function replaceMessages(sessionID: string, messages: SessionMessageInfo[]) {
      submissions.reconcile(sessionID, messages, store.session.pending[sessionID] ?? [])
      const resident = compactResidentMessages(sessionID, messages)
      messageIndex.set(sessionID, new Map(resident.map((item, position) => [item.id, position])))
      const mutations = messageMutations.get(sessionID)
      if (mutations) {
        const residentIDs = new Set(resident.map((item) => item.id))
        mutations.forEach((_, id) => {
          if (!residentIDs.has(id)) mutations.delete(id)
        })
      }
      setStore("session", "message", sessionID, resident)
      const residentIDs = new Set(resident.map((message) => message.id))
      messageMutationSeq.get(sessionID)?.forEach((_, id) => {
        if (!residentIDs.has(id)) messageMutationSeq.get(sessionID)?.delete(id)
      })
      messageOrderSeq.get(sessionID)?.forEach((_, id) => {
        if (!residentIDs.has(id)) messageOrderSeq.get(sessionID)?.delete(id)
      })
      olderMessageIDs.get(sessionID)?.forEach((id) => {
        if (!residentIDs.has(id)) olderMessageIDs.get(sessionID)?.delete(id)
      })
      const checkpoint = resident.some((message) => message.type === "compaction" && message.status === "completed")
      if (checkpoint && store.session.history[sessionID])
        setStore("session", "history", sessionID, { before: undefined, checkpoint: true })
      return resident
    }

    function compactResidentMessages(sessionID: string, messages: SessionMessageInfo[]) {
      const fromStore = Object.values(store.session.compaction[sessionID] ?? {})
        .filter((lifecycle) => lifecycle.status === "completed" && lifecycle.boundary)
        .flatMap((lifecycle) => {
          const position = messages.findIndex((message) => message.id === lifecycle.boundary?.messageID)
          return position === -1 ? [] : [position]
        })
        .reduce((latest, position) => Math.max(latest, position), -1)
      const fromMessages = messages
        .flatMap((message) => {
          const current = currentCompaction(message)
          return current && "boundary" in current
            ? [messages.findIndex((item) => item.id === current.boundary.messageID)]
            : []
        })
        .reduce((latest, position) => Math.max(latest, position), -1)
      const boundary = Math.max(fromStore, fromMessages)
      if (boundary === -1) return messages
      return messages.filter((message, position) => position > boundary || message.type === "compaction")
    }

    async function syncMessages(sessionID: string, current: () => boolean) {
      const started = performance.now()
      const token = {}
      const requestVersion = messageVersion.get(sessionID) ?? 0
      messageSyncLoad.set(sessionID, token)
      historyOwner.set(sessionID, token)
      setStore("session", "history", sessionID, {
        ...store.session.history[sessionID],
        status: "loading",
        checkpoint: store.session.history[sessionID]?.checkpoint ?? false,
        error: undefined,
        failedRead: undefined,
      })
      try {
        const snapshot = await client.api.session.snapshot({ sessionID, limit: HISTORY_PAGE_SIZE })
        if (!current() || messageSyncLoad.get(sessionID) !== token) return
        if (
          snapshot.session.id !== sessionID ||
          snapshot.watermark.aggregateID !== sessionID ||
          (sourceEpoch && snapshot.sourceEpoch !== sourceEpoch)
        )
          throw new Error("The Session snapshot does not belong to the current connection")
        const previous = store.session.history[sessionID]
        if (
          previous?.sourceEpoch === snapshot.sourceEpoch &&
          previous.watermark !== undefined &&
          (snapshot.watermark.seq === undefined || snapshot.watermark.seq < previous.watermark)
        )
          throw new Error("The Session snapshot is older than the resident history")
        const response = snapshot.messages
        const active = new Set(store.session.input[sessionID] ?? [])
        const canonicalIDs = new Set(response.map((message) => message.id))
        const touched = new Set(
          [...(messageMutations.get(sessionID)?.entries() ?? [])]
            .filter(
              ([id, version]) =>
                !canonicalIDs.has(id) ||
                (version > requestVersion &&
                  (messageMutationSeq.get(sessionID)?.get(id) ?? Infinity) > (snapshot.watermark.seq ?? -1)),
            )
            .map(([id]) => id),
        )
        const older = olderMessageIDs.get(sessionID) ?? new Set<string>()
        const reconciled = reconcileCanonicalMessages(
          response,
          store.session.message[sessionID] ?? [],
          touched,
          active,
          older,
        )
        batch(() => {
          setStore("session", "info", sessionID, reconcile(snapshot.session))
          registerSession(sessionID)
          setStore("session", "history", sessionID, {
            status: "ready",
            checkpoint: false,
            error: undefined,
            failedRead: undefined,
            before: older.size > 0 ? previous?.before : (snapshot.before ?? undefined),
            sourceEpoch: snapshot.sourceEpoch,
            watermark: snapshot.watermark.seq,
          })
          if (snapshot.watermark.seq !== undefined)
            streamSequence.set(sessionID, Math.max(streamSequence.get(sessionID) ?? -1, snapshot.watermark.seq))
          response.forEach((item) => {
            const lifecycle = compactionLifecycle(item)
            if (!lifecycle) return
            setCompaction(sessionID, lifecycle)
          })
          replaceMessages(sessionID, reconciled)
          store.session.pending[sessionID]?.forEach(projectPending)
          const mutations = messageMutations.get(sessionID)
          response.forEach((message) => {
            const version = mutations?.get(message.id)
            if (version !== undefined && version <= requestVersion) mutations?.delete(message.id)
          })
          if (mutations?.size === 0) messageMutations.delete(sessionID)
        })
        refreshCompactionHistory(sessionID)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        props.recordTelemetry?.("transcript.load", performance.now() - started)
      } catch (error) {
        if (current() && messageSyncLoad.get(sessionID) === token)
          setStore("session", "history", sessionID, {
            status: "error",
            error: errorMessage(error),
            failedRead: "latest",
          })
        throw error
      } finally {
        if (messageSyncLoad.get(sessionID) === token) messageSyncLoad.delete(sessionID)
      }
    }

    async function loadOlderMessages(sessionID: string) {
      const history = store.session.history[sessionID]
      const before = history?.before
      const owner = historyOwner.get(sessionID)
      if (!history || !before || !owner || history.checkpoint || messageSyncLoad.has(sessionID)) return
      setStore("session", "history", sessionID, { status: "paging", error: undefined, failedRead: undefined })
      try {
        const snapshot = await client.api.session.snapshot({ sessionID, limit: HISTORY_PAGE_SIZE, before })
        if (historyOwner.get(sessionID) !== owner || store.session.history[sessionID]?.before !== before) return
        if (
          snapshot.session.id !== sessionID ||
          snapshot.watermark.aggregateID !== sessionID ||
          snapshot.sourceEpoch !== history.sourceEpoch
        )
          throw new Error("The older history page does not belong to the resident Session")
        if (snapshot.before === before) throw new Error("The older history cursor did not advance")
        const current = store.session.message[sessionID] ?? []
        const ids = new Set(snapshot.messages.map((message) => message.id))
        const older = olderMessageIDs.get(sessionID) ?? new Set<string>()
        snapshot.messages.forEach((message) => older.add(message.id))
        olderMessageIDs.set(sessionID, older)
        batch(() => {
          snapshot.messages.forEach((message) => {
            const lifecycle = compactionLifecycle(message)
            if (lifecycle) setCompaction(sessionID, lifecycle)
          })
          setStore("session", "history", sessionID, {
            status: "ready",
            before: snapshot.before ?? undefined,
            error: undefined,
            failedRead: undefined,
          })
          replaceMessages(sessionID, [
            ...snapshot.messages.map((message) => current.find((item) => item.id === message.id) ?? message),
            ...current.filter((message) => !ids.has(message.id)),
          ])
          store.session.pending[sessionID]?.forEach(projectPending)
        })
      } catch (error) {
        if (historyOwner.get(sessionID) === owner)
          setStore("session", "history", sessionID, {
            status: "error",
            error: errorMessage(error),
            failedRead: "older",
          })
        throw error
      }
    }

    let activeSnapshot: Map<string, DataSessionStatus> | undefined

    function setSessionActive(sessionID: string, status: DataSessionStatus) {
      activeSnapshot?.set(sessionID, status)
      setStore("session", "active", sessionID, status)
    }

    function addPending(item: SessionPendingInfo) {
      if (store.session.pending[item.sessionID]?.some((pending) => pending.id === item.id)) return
      setStore("session", "pending", item.sessionID, [...(store.session.pending[item.sessionID] ?? []), item])
    }

    function removePending(sessionID: string, inputID?: string) {
      if (!inputID) return
      setStore(
        "session",
        "pending",
        sessionID,
        (store.session.pending[sessionID] ?? []).filter((item) => item.id !== inputID),
      )
    }

    function setCompaction(sessionID: string, lifecycle: DataSessionCompactionLifecycle) {
      setStore("session", "compaction", sessionID, {
        ...store.session.compaction[sessionID],
        [lifecycle.jobID]: mergeCompactionLifecycle(store.session.compaction[sessionID]?.[lifecycle.jobID], lifecycle),
      })
    }

    function syncCompactionHistory(sessionID: string) {
      const visible = Object.values(store.session.compaction[sessionID] ?? {}).some(
        (lifecycle) =>
          lifecycle.status !== "failed" || lifecycle.code === "cancelled" || lifecycle.code === "superseded",
      )
      if (!visible) return Promise.resolve()
      return sync.run(`session.compaction:${sessionID}`, async (current) => {
        const history = await client.api.session.compaction.list({ sessionID })
        if (!current()) return
        setStore("session", "compactionHistory", sessionID, history)
      })
    }

    function refreshCompactionHistory(sessionID: string) {
      if (store.session.message[sessionID] === undefined && !messageSyncLoad.has(sessionID)) return
      sync.invalidate(`session.compaction:${sessionID}`)
      void syncCompactionHistory(sessionID).catch(() => undefined)
    }

    function updateCompaction(sessionID: string, lifecycle: DataSessionCompactionLifecycle) {
      setCompaction(sessionID, lifecycle)
      if (store.session.message[sessionID] === undefined && !messageSyncLoad.has(sessionID)) return
      replaceMessages(sessionID, store.session.message[sessionID] ?? [])
    }

    function projectPending(item: SessionPendingInfo) {
      message.update(item.sessionID, (draft, index) => {
        message.append(
          draft,
          index,
          item.type === "user"
            ? {
                id: item.id,
                type: "user",
                ...item.data,
                time: { created: item.timeCreated },
              }
            : {
                id: item.id,
                type: "synthetic",
                ...item.data,
                time: { created: item.timeCreated },
              },
        )
      })
    }

    const message = {
      update(sessionID: string, fn: (messages: SessionMessageInfo[], index: Map<string, number>) => void) {
        if (store.session.message[sessionID] === undefined && !messageSyncLoad.has(sessionID)) return
        const before = new Map((store.session.message[sessionID] ?? []).map((item) => [item.id, messageRevision(item)]))
        batch(() => {
          setStore(
            "session",
            "message",
            produce((draft) => {
              const messages = (draft[sessionID] ??= [])
              fn(messages, index(sessionID))
            }),
          )
          messageIndex.set(
            sessionID,
            new Map((store.session.message[sessionID] ?? []).map((item, position) => [item.id, position])),
          )
          const version = (messageVersion.get(sessionID) ?? 0) + 1
          messageVersion.set(sessionID, version)
          const mutations = messageMutations.get(sessionID) ?? new Map<string, number>()
          const resident = store.session.message[sessionID] ?? []
          resident.forEach((item) => {
            if (!sameRevision(before.get(item.id), messageRevision(item))) {
              mutations.set(item.id, version)
              if (applyingSequence !== undefined) {
                const sequences = messageMutationSeq.get(sessionID) ?? new Map<string, number>()
                sequences.set(item.id, applyingSequence)
                messageMutationSeq.set(sessionID, sequences)
                const order = messageOrderSeq.get(sessionID) ?? new Map<string, number>()
                if (!order.has(item.id)) order.set(item.id, applyingSequence)
                messageOrderSeq.set(sessionID, order)
              }
            }
          })
          const residentIDs = new Set(resident.map((item) => item.id))
          mutations.forEach((_, id) => {
            if (!residentIDs.has(id)) mutations.delete(id)
          })
          messageMutations.set(sessionID, mutations)
        })
      },
      append(messages: SessionMessageInfo[], index: Map<string, number>, item: SessionMessageInfo) {
        if (index.has(item.id)) return
        index.set(item.id, messages.length)
        messages.push(item)
      },
      place(
        sessionID: string,
        messages: SessionMessageInfo[],
        index: Map<string, number>,
        item: SessionMessageInfo,
        seq: number,
      ) {
        if (index.has(item.id)) return
        const sequences = messageOrderSeq.get(sessionID)
        const later = messages.findIndex((message) => {
          const messageSeq = sequences?.get(message.id)
          return messageSeq !== undefined && messageSeq > seq
        })
        messages.splice(later === -1 ? messages.length : later, 0, item)
        index.clear()
        messages.forEach((message, position) => index.set(message.id, position))
      },
      activeAssistant(messages: SessionMessageInfo[]) {
        const item = messages.findLast((item) => item.type === "assistant" && !item.time.completed)
        return item?.type === "assistant" ? item : undefined
      },
      assistant(messages: SessionMessageInfo[], index: Map<string, number>, messageID: string) {
        const position = index.get(messageID)
        const item = position === undefined ? undefined : messages[position]
        return item?.type === "assistant" ? item : undefined
      },
      shell(messages: SessionMessageInfo[], shellID: string) {
        const item = messages.findLast((item) => item.type === "shell" && item.shellID === shellID)
        return item?.type === "shell" ? item : undefined
      },
      compaction(messages: SessionMessageInfo[]) {
        const item = messages.findLast((item) => item.type === "compaction" && item.status === "running")
        return item?.type === "compaction" ? item : undefined
      },
      latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantTool =>
            item.type === "tool" && (callID === undefined || item.id === callID),
        )
      },
      latestText(assistant: SessionMessageAssistant | undefined) {
        return assistant?.content.findLast((item): item is SessionMessageAssistantText => item.type === "text")
      },
      latestReasoning(assistant: SessionMessageAssistant | undefined) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && !item.time?.completed,
        )
      },
    }

    function index(sessionID: string) {
      const existing = messageIndex.get(sessionID)
      if (existing) return existing
      const created = new Map<string, number>()
      messageIndex.set(sessionID, created)
      return created
    }

    // Walk parentID upward through loaded session info to the family root. When a
    // parent's info is missing, that missing ID is the furthest-known ancestor and
    // is returned so orphan subtrees group under it until the parent arrives. A
    // seen set guards against parent cycles, stopping at the last non-repeating
    // ancestor.
    function resolveRoot(sessionID: string) {
      let current = sessionID
      let parentID = store.session.info[sessionID]?.parentID
      const seen = new Set([sessionID])
      while (parentID) {
        if (seen.has(parentID)) break
        seen.add(parentID)
        current = parentID
        parentID = store.session.info[parentID]?.parentID
      }
      return current
    }

    // Register one session into the family index. Idempotent: syncing an
    // existing session never duplicates its ID. When a tentative family keyed by
    // sessionID exists (descendants arrived while sessionID's own info was
    // absent) but sessionID turns out to have a parent, fold the orphan subtree
    // into the resolved root's family and drop the tentative entry.
    function registerSession(sessionID: string) {
      const info = store.session.info[sessionID]
      if (!info) return
      metadataRecency.delete(sessionID)
      metadataRecency.add(sessionID)
      const rootID = resolveRoot(sessionID)
      setStore(
        "session",
        "family",
        produce((draft) => {
          if (sessionID !== rootID && draft[sessionID]) {
            const members = (draft[rootID] ??= [])
            for (const id of draft[sessionID]) {
              if (!members.includes(id)) members.push(id)
            }
            delete draft[sessionID]
          }
          const family = (draft[rootID] ??= [])
          if (!family.includes(sessionID)) family.push(sessionID)
        }),
      )
    }

    function removeSession(sessionID: string) {
      metadataRecency.delete(sessionID)
      messageIndex.delete(sessionID)
      messageSyncLoad.delete(sessionID)
      messageVersion.delete(sessionID)
      messageMutations.delete(sessionID)
      messageMutationSeq.delete(sessionID)
      messageOrderSeq.delete(sessionID)
      olderMessageIDs.delete(sessionID)
      historyOwner.delete(sessionID)
      olderLoads.delete(sessionID)
      streamSequence.delete(sessionID)
      subagentGeneration.delete(sessionID)
      sync.forget(`session:${sessionID}`)
      sync.forget(`session.pending:${sessionID}`)
      sync.forget(`session.subagent:${sessionID}`)
      sync.forget(`session.message:${sessionID}`)
      sync.forget(`session.compaction:${sessionID}`)
      sync.forget(`session.diagnostics:${sessionID}`)
      sync.forget(`session.usage:${sessionID}`)
      sync.forget(`session.todo:${sessionID}`)
      sync.forget(`session.permission:${sessionID}`)
      sync.forget(`session.guardrail:${sessionID}`)
      sync.forget(`session.form:${sessionID}:`)
      setStore(
        "session",
        produce((draft) => {
          delete draft.info[sessionID]
          delete draft.active[sessionID]
          delete draft.message[sessionID]
          delete draft.history[sessionID]
          delete draft.compaction[sessionID]
          delete draft.compactionHistory[sessionID]
          delete draft.diagnostics[sessionID]
          delete draft.prediction[sessionID]
          delete draft.predictionDismissed[sessionID]
          delete draft.usage[sessionID]
          delete draft.pending[sessionID]
          delete draft.todo[sessionID]
          delete draft.subagent[sessionID]
          for (const [parentID, page] of Object.entries(draft.subagent)) {
            if (page.data.some((task) => task.sessionID === sessionID)) delete draft.subagent[parentID]
          }
          delete draft.input[sessionID]
          delete draft.permission[sessionID]
          delete draft.guardrail[sessionID]
          for (const [rootID, requests] of Object.entries(draft.guardrail)) {
            const next = requests.filter((request) => request.sessionID !== sessionID)
            if (next.length === 0) delete draft.guardrail[rootID]
            else draft.guardrail[rootID] = next
          }
          delete draft.form[sessionID]
          for (const [rootID, family] of Object.entries(draft.family)) {
            const next = family.filter((id) => id !== sessionID)
            if (next.length === 0) delete draft.family[rootID]
            else draft.family[rootID] = next
          }
        }),
      )
    }

    function pruneMetadata() {
      const protectedIDs = new Set([
        ...Object.keys(store.session.message),
        ...Object.keys(store.session.active).filter((id) => store.session.active[id] === "running"),
        ...Object.keys(store.session.pending).filter((id) => store.session.pending[id]?.length),
        ...Object.keys(store.session.input).filter((id) => store.session.input[id]?.length),
        ...Object.keys(store.session.permission).filter((id) => store.session.permission[id]?.length),
        ...Object.keys(store.session.form).filter((id) => store.session.form[id]?.length),
        ...Object.entries(store.session.guardrail).flatMap(([id, requests]) =>
          requests.length ? [id, ...requests.map((request) => request.sessionID)] : [],
        ),
        ...Object.entries(store.session.subagent).flatMap(([id, page]) =>
          page.summary.active > 0
            ? [
                id,
                ...page.data
                  .filter((task) => ["starting", "running", "waiting", "cancelling"].includes(task.state))
                  .map((task) => task.sessionID),
              ]
            : [],
        ),
        ...Object.values(store.location).flatMap((location) =>
          Object.values(location.shell ?? {}).flatMap((shell) =>
            shell.status === "running" && shell.metadata.sessionID ? [shell.metadata.sessionID] : [],
          ),
        ),
        ...submissions
          .list()
          .map((entry) => entry.input.sessionID)
          .filter((id): id is string => id !== undefined),
        ...sync.pendingSessions(),
        ...metadataReads.values(),
        ...(props.selectedSessionID?.() ? [props.selectedSessionID()!] : []),
      ])
      const protectedRoots = new Set([...protectedIDs].map(resolveRoot))
      protectedRoots.forEach((root) => protectedIDs.add(root))
      Object.entries(store.session.family).forEach(([root, members]) => {
        if (protectedRoots.has(root)) members.forEach((id) => protectedIDs.add(id))
      })
      const ids = new Set([
        ...Object.values(store.session).flatMap((values) => Object.keys(values)),
        ...subagentGeneration.keys(),
      ])
      ids.forEach((id) => {
        if (!metadataRecency.has(id)) metadataRecency.add(id)
      })
      const inactive = [...ids].filter((id) => id !== "global" && !protectedIDs.has(id))
      const recent = new Set([...metadataRecency].filter((id) => inactive.includes(id)).slice(-50))
      batch(() => inactive.filter((id) => !recent.has(id)).forEach(removeSession))
    }

    async function loadSubagentPage(
      parentID: string,
      input: { readonly cursor?: string },
      requested: "top" | "older",
      pageOffset: (page: SessionOrchestrationPage) => number,
    ) {
      const generation = (subagentGeneration.get(parentID) ?? 0) + 1
      subagentGeneration.set(parentID, generation)
      const read = {}
      metadataReads.set(read, parentID)
      try {
        const page = await client.api.session.subagent.list({ parentID, limit: 10, ...input })
        if (subagentGeneration.get(parentID) !== generation) return
        const position = requested === "top" || page.cursor.previous === undefined ? "top" : "older"
        setStore("session", "subagent", parentID, {
          data: page.data.slice(0, 10),
          summary: page.summary,
          cursor: page.cursor,
          offset: position === "top" ? 0 : pageOffset(page),
          position,
        })
      } finally {
        metadataReads.delete(read)
        pruneMetadata()
      }
    }

    async function directSubagents(parentID: string) {
      const tasks = []
      let cursor: string | undefined
      do {
        const page = await client.api.session.subagent.list({ parentID, limit: 10, ...(cursor ? { cursor } : {}) })
        tasks.push(...page.data)
        cursor = page.cursor.next
      } while (cursor)
      return tasks
    }

    function restoreSubagentTop(parentID: string) {
      result.session.subagent.invalidate(parentID)
      void result.session.subagent
        .sync(parentID)
        .catch((error) => console.error("Failed to refresh durable subagent tasks", error))
    }

    function handleEvent(event: YCodingEvent) {
      switch (event.type) {
        case "session.created": {
          // The event already carries the creation-time record, including the
          // parent. Index it now so a child that starts and finishes before the
          // fetch below lands is still part of its parent's family.
          const sessionID = event.data.sessionID
          setStore("session", "info", sessionID, {
            id: sessionID,
            parentID: event.data.parentID,
            projectID: event.data.projectID,
            agent: event.data.agent,
            model: event.data.model,
            permissionCeiling: event.data.permissionCeiling,
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: event.data.created, updated: event.data.created },
            title: event.data.title,
            location: event.data.location,
            subpath: event.data.subpath,
          })
          registerSession(sessionID)
          result.session.invalidate(sessionID)
          void result.session
            .sync(sessionID)
            .catch((error) => console.error("Failed to refresh created Session", error))
          break
        }
        case "session.deleted":
          removeSession(event.data.sessionID)
          break
        case "session.task.updated": {
          const parentID =
            event.data.change.type === "launched"
              ? event.data.change.parentID
              : (Object.entries(store.session.subagent).find(([, page]) =>
                  page.data.some((task) => task.sessionID === event.data.sessionID),
                )?.[0] ?? store.session.info[event.data.sessionID]?.parentID)
          if (parentID) {
            restoreSubagentTop(parentID)
            break
          }
          void client.api.session
            .get({ sessionID: event.data.sessionID })
            .then((child) => {
              if (child.parentID) restoreSubagentTop(child.parentID)
            })
            .catch((error) => console.error("Failed to resolve durable subagent parent", error))
          break
        }
        case "session.usage.updated":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, {
              cost: event.data.cost,
              tokens: event.data.tokens,
            })
          result.session.usage.invalidate(event.data.sessionID)
          if (store.session.usage[event.data.sessionID] !== undefined)
            void result.session.usage.sync(event.data.sessionID).catch(() => undefined)
          break
        case "session.diagnostics.updated":
          setStore("session", "diagnostics", event.data.sessionID, event.data.diagnostics)
          break
        case "session.prediction.updated": {
          const words = event.data.text.trim().split(/\s+/).length
          if (
            !event.data.text.trim() ||
            words < 2 ||
            words > 40 ||
            event.data.text.length > 400 ||
            /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(event.data.text)
          )
            break
          if (store.session.predictionDismissed[event.data.sessionID] === event.data.sourceMessageID) break
          const sourceMessageID = result.session.message
            .list(event.data.sessionID)
            .findLast((message) => message.type === "assistant")?.id
          if (sourceMessageID && sourceMessageID !== event.data.sourceMessageID) break
          setStore("session", "prediction", event.data.sessionID, {
            sourceMessageID: event.data.sourceMessageID,
            text: event.data.text,
          })
          break
        }
        case "catalog.updated":
          result.location.model.invalidate(event.location)
          result.location.provider.invalidate(event.location)
          void Promise.all([result.location.model.sync(event.location), result.location.provider.sync(event.location)])
          break
        case "agent.updated":
          result.location.agent.invalidate(event.location)
          void result.location.agent.sync(event.location)
          break
        case "command.updated":
          result.location.command.invalidate(event.location)
          void result.location.command.sync(event.location)
          break
        case "config.updated":
          result.location.config.diagnostics.invalidate(event.location)
          void result.location.config.diagnostics.sync(event.location)
          break
        case "skill.updated":
          result.location.skill.invalidate(event.location)
          void result.location.skill.sync(event.location)
          break
        case "session.agent.selected":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "agent", event.data.agent)
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "agent-switched",
              agent: event.data.agent,
              time: { created: event.created },
            })
          })
          break
        case "session.daybreak.set":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "daybreak", event.data.daybreak)
          break
        case "todo.updated":
          setStore("session", "todo", event.data.sessionID, reconcile(event.data.todos))
          break
        case "session.model.selected":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "model", reconcile(event.data.model))
          if (!store.session.message[event.data.sessionID]) break
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "model-switched",
              model: event.data.model,
              time: { created: event.created },
            })
          })
          void client.api.session
            .message({
              sessionID: event.data.sessionID,
              messageID: messageIDFromEvent(event.id),
            })
            .then((item) => {
              message.update(event.data.sessionID, (draft, index) => {
                const position = index.get(item.id)
                if (position === undefined) return message.append(draft, index, item)
                draft[position] = item
              })
            })
            .catch((error) => console.error("Failed to load projected model switch message", error))
          break
        case "session.renamed":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "title", event.data.title)
          break
        case "session.archived":
        case "session.unarchived":
          if (store.session.info[event.data.sessionID])
            setStore(
              "session",
              "info",
              event.data.sessionID,
              "time",
              "archived",
              event.type === "session.archived" ? event.created : undefined,
            )
          break
        case "session.pinned":
        case "session.unpinned":
          if (store.session.info[event.data.sessionID])
            setStore(
              "session",
              "info",
              event.data.sessionID,
              "time",
              "pinned",
              event.type === "session.pinned" ? event.created : undefined,
            )
          break
        case "session.moved":
          if (store.session.info[event.data.sessionID]) {
            setStore("session", "info", event.data.sessionID, "location", event.data.location)
            if (event.data.projectID)
              setStore("session", "info", event.data.sessionID, "projectID", event.data.projectID)
            setStore("session", "info", event.data.sessionID, "subpath", event.data.subpath)
          }
          break
        case "session.input.promoted": {
          removePending(event.data.sessionID, event.data.inputID)
          const promoted = store.session.input[event.data.sessionID]?.includes(event.data.inputID) === true
          setStore(
            "session",
            "input",
            event.data.sessionID,
            (store.session.input[event.data.sessionID] ?? []).filter((id) => id !== event.data.inputID),
          )
          message.update(event.data.sessionID, (draft, index) => {
            const position = index.get(event.data.inputID)
            if (position === undefined) return
            const existing = draft[position]
            if (!existing || !promoted) return
            existing.time.created = event.created
            draft.splice(position, 1)
            draft.push(existing)
            index.clear()
            draft.forEach((message, indexValue) => index.set(message.id, indexValue))
          })
          break
        }
        case "session.input.admitted": {
          const pending = {
            id: event.data.inputID,
            sessionID: event.data.sessionID,
            admittedSeq: event.durable.seq,
            timeCreated: event.created,
            ...event.data.input,
          }
          addPending(pending)
          if (!store.session.input[event.data.sessionID]?.includes(event.data.inputID))
            setStore("session", "input", event.data.sessionID, [
              ...(store.session.input[event.data.sessionID] ?? []),
              event.data.inputID,
            ])
          projectPending(pending)
          break
        }
        case "session.input.consumed":
          message.update(event.data.sessionID, (draft, index) => {
            event.data.inputIDs.forEach((inputID) => {
              const position = index.get(inputID)
              if (position === undefined) return
              const existing = draft[position]
              if (existing?.type !== "user" || existing.time.consumed !== undefined) return
              existing.time.consumed = event.created
            })
          })
          break
        case "session.instructions.updated":
          const instructions = event.metadata?.instructions
          if (
            typeof instructions === "object" &&
            instructions !== null &&
            "initial" in instructions &&
            instructions.initial === true
          )
            break
          if (Object.keys(event.data.delta).length === 0) break
          message.update(event.data.sessionID, (draft, index) => {
            message.place(
              event.data.sessionID,
              draft,
              index,
              {
                id: messageIDFromEvent(event.id),
                type: "system",
                text: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
                metadata: event.metadata,
                time: { created: event.created },
              },
              event.durable.seq,
            )
          })
          break
        case "session.context.observed":
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              ...(event.data.source === "team-view"
                ? { type: "synthetic" as const, description: "TeamView update" }
                : { type: "system" as const }),
              text: event.data.text,
              metadata: { contextSource: event.data.source },
              time: { created: event.created },
            })
          })
          break
        case "session.synthetic":
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "synthetic",
              text: event.data.text,
              description: event.data.description,
              metadata: event.data.metadata,
              time: { created: event.created },
            })
          })
          break
        case "session.skill.activated":
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "skill",
              skill: event.data.id,
              name: event.data.name,
              text: event.data.text,
              conflicts: event.data.conflicts ?? { skills: [], instructions: [] },
              artifact: event.data.artifact,
              metadata: event.metadata,
              time: { created: event.created },
            })
          })
          break
        case "session.skill.deactivated":
          message.update(event.data.sessionID, (draft, index) => {
            const position = index.get(event.data.activationMessageID)
            const activation = position === undefined ? undefined : draft[position]
            if (activation?.type !== "skill" && activation?.type !== "assistant") return
            activation.skillDeactivations = [
              ...(activation.skillDeactivations ?? []),
              { skill: event.data.id, reason: event.data.reason },
            ]
          })
          break
        case "session.shell.started":
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "shell",
              shellID: event.data.shell.id,
              command: event.data.shell.command,
              status: event.data.shell.status,
              exit: event.data.shell.exit,
              metadata: event.metadata,
              time: { created: event.created },
            })
          })
          break
        case "session.shell.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.shell(draft, event.data.shell.id)
            if (!match) return
            match.status = event.data.shell.status
            match.exit = event.data.shell.exit
            match.output = event.data.output
            match.time.completed = event.created
          })
          break
        case "session.step.started":
          message.update(event.data.sessionID, (draft, index) => {
            const position = index.get(event.data.assistantMessageID)
            const existing = position === undefined ? undefined : draft[position]
            if (existing?.type === "assistant") {
              existing.agent = event.data.agent
              existing.model = event.data.model
              existing.retry = undefined
              existing.error = undefined
              existing.finish = undefined
              existing.time.completed = undefined
              if (event.data.snapshot)
                existing.snapshot = {
                  ...existing.snapshot,
                  start: event.data.snapshot,
                }
              return
            }
            const currentAssistant = message.activeAssistant(draft)
            if (currentAssistant) {
              currentAssistant.retry = undefined
              currentAssistant.time.completed = event.created
            }
            message.append(draft, index, {
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              metadata: event.metadata,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: event.created },
            })
          })
          break
        case "session.step.ended": {
          message.update(event.data.sessionID, (draft, index) => {
            const currentAssistant = message.assistant(draft, index, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.created
            currentAssistant.finish = event.data.finish
            currentAssistant.cost = event.data.cost
            currentAssistant.tokens = event.data.tokens
            currentAssistant.diagnostics =
              event.data.contextLimit === undefined ? undefined : { contextLimit: event.data.contextLimit }
            if (event.data.snapshot)
              currentAssistant.snapshot = {
                ...currentAssistant.snapshot,
                end: event.data.snapshot,
              }
          })
          result.session.diagnostics.invalidate(event.data.sessionID)
          void result.session.diagnostics.sync(event.data.sessionID).catch(() => undefined)
          break
        }
        case "session.step.failed":
          message.update(event.data.sessionID, (draft, index) => {
            const currentAssistant = message.assistant(draft, index, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.created
            currentAssistant.finish = "error"
            currentAssistant.error = event.data.error
            currentAssistant.retry = undefined
            if (event.data.cost !== undefined && event.data.tokens !== undefined) {
              currentAssistant.cost = event.data.cost
              currentAssistant.tokens = event.data.tokens
            }
            currentAssistant.diagnostics =
              event.data.contextLimit === undefined ? undefined : { contextLimit: event.data.contextLimit }
          })
          result.session.diagnostics.invalidate(event.data.sessionID)
          void result.session.diagnostics.sync(event.data.sessionID).catch(() => undefined)
          break
        case "session.text.started":
          message.update(event.data.sessionID, (draft, index) => {
            message.assistant(draft, index, event.data.assistantMessageID)?.content.push({
              type: "text",
              text: "",
            })
          })
          break
        case "session.text.delta":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestText(message.assistant(draft, index, event.data.assistantMessageID))
            if (match) match.text += event.data.delta
          })
          break
        case "session.text.ended":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestText(message.assistant(draft, index, event.data.assistantMessageID))
            if (match) match.text = event.data.text
          })
          break
        case "session.tool.input.started":
          message.update(event.data.sessionID, (draft, index) => {
            message.assistant(draft, index, event.data.assistantMessageID)?.content.push({
              type: "tool",
              id: event.data.callID,
              name: event.data.name,
              time: { created: event.created },
              state: { status: "streaming", input: "" },
            })
          })
          break
        case "session.tool.input.delta":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestTool(
              message.assistant(draft, index, event.data.assistantMessageID),
              event.data.callID,
            )
            if (match?.state.status === "streaming") match.state.input += event.data.delta
          })
          break
        case "session.tool.input.ended":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestTool(
              message.assistant(draft, index, event.data.assistantMessageID),
              event.data.callID,
            )
            if (match?.state.status === "streaming") match.state.input = event.data.text
          })
          break
        case "session.tool.called":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestTool(
              message.assistant(draft, index, event.data.assistantMessageID),
              event.data.callID,
            )
            if (!match) return
            match.time.ran = event.created
            match.executed = event.data.executed
            match.providerState = event.data.state
            match.state = {
              status: "running",
              input: event.data.input,
              structured: {},
              content: [],
            }
          })
          break
        case "session.tool.progress":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestTool(
              message.assistant(draft, index, event.data.assistantMessageID),
              event.data.callID,
            )
            if (match?.state.status !== "running") return
            match.state.structured = event.data.structured
            match.state.content = [...event.data.content]
          })
          break
        case "session.tool.success":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestTool(
              message.assistant(draft, index, event.data.assistantMessageID),
              event.data.callID,
            )
            if (match?.state.status !== "running") return
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.data.structured,
              content: [...event.data.content],
              result: event.data.result,
            }
            match.executed = event.data.executed || match.executed === true
            match.providerResultState = event.data.resultState
            match.time.completed = event.created
          })
          break
        case "session.tool.failed":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestTool(
              message.assistant(draft, index, event.data.assistantMessageID),
              event.data.callID,
            )
            if (!match || (match.state.status !== "streaming" && match.state.status !== "running")) return
            match.state = {
              status: "error",
              error: event.data.error,
              input: typeof match.state.input === "string" ? {} : match.state.input,
              structured: match.state.status === "running" ? match.state.structured : {},
              content: match.state.status === "running" ? match.state.content : [],
              result: event.data.result,
            }
            match.executed = event.data.executed || match.executed === true
            match.providerResultState = event.data.resultState
            match.time.completed = event.created
          })
          break
        case "session.reasoning.started":
          message.update(event.data.sessionID, (draft, index) => {
            message.assistant(draft, index, event.data.assistantMessageID)?.content.push({
              type: "reasoning",
              text: "",
              state: event.data.state,
              time: { created: event.created },
            })
          })
          break
        case "session.reasoning.delta":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestReasoning(message.assistant(draft, index, event.data.assistantMessageID))
            if (match) match.text += event.data.delta
          })
          break
        case "session.reasoning.ended":
          message.update(event.data.sessionID, (draft, index) => {
            const match = message.latestReasoning(message.assistant(draft, index, event.data.assistantMessageID))
            if (match) {
              match.text = event.data.text
              match.time = {
                created: match.time?.created ?? event.created,
                completed: event.created,
              }
              if (event.data.state !== undefined) match.state = event.data.state
            }
          })
          break
        case "session.retry.scheduled":
          message.update(event.data.sessionID, (draft, index) => {
            const currentAssistant = message.assistant(draft, index, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.retry = {
              attempt: event.data.attempt,
              at: event.data.at,
              error: event.data.error,
            }
          })
          break
        case "session.execution.started":
          setSessionActive(event.data.sessionID, "running")
          break
        case "session.compaction.admitted":
          updateCompaction(event.data.sessionID, {
            jobID: event.data.jobID,
            pressure: event.data.pressure,
            status: "pending",
            time: { created: event.created },
          })
          break
        case "session.compaction.started":
          updateCompaction(event.data.sessionID, {
            jobID: event.data.jobID,
            status: "running",
            time: { created: event.created },
          })
          break
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          setSessionActive(event.data.sessionID, "idle")
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = draft.findLast(
              (item): item is SessionMessageAssistant => item.type === "assistant",
            )
            if (currentAssistant) currentAssistant.retry = undefined
          })
          break
        case "session.revert.staged":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "revert", event.data.revert)
          result.session.diagnostics.invalidate(event.data.sessionID)
          void result.session.diagnostics.sync(event.data.sessionID).catch(() => undefined)
          break
        case "session.revert.cleared":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "revert", undefined)
          result.session.diagnostics.invalidate(event.data.sessionID)
          void result.session.diagnostics.sync(event.data.sessionID).catch(() => undefined)
          break
        case "session.revert.committed":
          // A list captured before this canonical deletion cannot settle as current.
          messageSyncLoad.delete(event.data.sessionID)
          sync.invalidate(`session.message:${event.data.sessionID}`)
          if (store.session.info[event.data.sessionID]) {
            setStore("session", "info", event.data.sessionID, "revert", undefined)
          }
          setStore(
            "session",
            "input",
            event.data.sessionID,
            (store.session.input[event.data.sessionID] ?? []).filter((id) => id < event.data.to),
          )
          message.update(event.data.sessionID, (draft, index) => {
            const position = draft.findIndex((item) => item.id >= event.data.to)
            if (position === -1) return
            for (const item of draft.splice(position)) index.delete(item.id)
          })
          result.session.diagnostics.invalidate(event.data.sessionID)
          void result.session.diagnostics.sync(event.data.sessionID).catch(() => undefined)
          break
        case "session.compaction.ended":
          updateCompaction(event.data.sessionID, {
            jobID: event.data.jobID,
            status: "completed",
            revision: event.data.revision,
            boundary: event.data.boundary,
            metrics: event.data.metrics,
            time: { created: event.created },
          })
          refreshCompactionHistory(event.data.sessionID)
          break
        case "session.compaction.failed":
          updateCompaction(event.data.sessionID, {
            jobID: event.data.jobID,
            status: "failed",
            code: event.data.code,
            error: event.data.error,
            time: { created: event.created },
          })
          break
        case "permission.asked":
          if (store.session.permission[event.data.sessionID]?.some((request) => request.id === event.data.id)) break
          setStore("session", "permission", event.data.sessionID, [
            ...(store.session.permission[event.data.sessionID] ?? []),
            event.data,
          ])
          break
        case "permission.replied":
          setStore(
            "session",
            "permission",
            event.data.sessionID,
            (store.session.permission[event.data.sessionID] ?? []).filter(
              (request) => request.id !== event.data.requestID,
            ),
          )
          break
        case "guardrail.asked":
          if (store.session.guardrail[event.data.rootSessionID]?.some((request) => request.id === event.data.id)) break
          setStore("session", "guardrail", event.data.rootSessionID, [
            ...(store.session.guardrail[event.data.rootSessionID] ?? []),
            event.data,
          ])
          break
        case "guardrail.replied":
          setStore(
            "session",
            "guardrail",
            event.data.rootSessionID,
            (store.session.guardrail[event.data.rootSessionID] ?? []).filter(
              (request) => request.id !== event.data.requestID,
            ),
          )
          break
        case "form.created":
          if (store.session.form[event.data.form.sessionID]?.some((form) => form.id === event.data.form.id)) break
          setStore("session", "form", event.data.form.sessionID, [
            ...(store.session.form[event.data.form.sessionID] ?? []),
            event.data.form.sessionID === "global" ? { ...event.data.form, location: event.location } : event.data.form,
          ])
          break
        case "form.replied":
        case "form.cancelled":
          setStore(
            "session",
            "form",
            event.data.sessionID,
            (store.session.form[event.data.sessionID] ?? []).filter((form) => form.id !== event.data.id),
          )
          break
        case "shell.created":
          setStore("location", locationKey(event.location ?? defaultLocation()), (data) => ({
            ...data,
            shell: { ...data?.shell, [event.data.info.id]: event.data.info },
          }))
          break
        case "shell.exited":
        case "shell.deleted":
          if (event.location) {
            setStore("location", locationKey(event.location), (data) => ({
              ...data,
              shell: Object.fromEntries(Object.entries(data?.shell ?? {}).filter(([id]) => id !== event.data.id)),
            }))
            break
          }
          setStore(
            "location",
            produce((draft) => {
              for (const data of Object.values(draft)) delete data.shell?.[event.data.id]
            }),
          )
          break
        case "reference.updated":
          result.location.reference.invalidate(event.location)
          void result.location.reference.sync(event.location)
          break
        case "integration.updated":
          result.location.integration.invalidate(event.location)
          result.location.model.invalidate(event.location)
          result.location.provider.invalidate(event.location)
          void Promise.all([
            result.location.integration.sync(event.location),
            result.location.model.sync(event.location),
            result.location.provider.sync(event.location),
          ])
          break
        // Authenticating an MCP integration reconnects its server, which emits mcp.status.changed,
        // so the mcp list syncs here rather than off integration.updated.
        case "mcp.status.changed":
          result.location.mcp.server.invalidate(event.location)
          void result.location.mcp.server.sync(event.location)
          break
        case "mcp.resources.changed":
          result.location.mcp.resource.invalidate(event.location)
          void result.location.mcp.resource.sync(event.location)
          break
      }
    }

    const result = {
      on: client.event.on ?? (() => () => {}),
      listen: client.event.listen,
      session: {
        submissions,
        list() {
          return Object.values(store.session.info).toSorted((a, b) => b.time.updated - a.time.updated)
        },
        get(sessionID: string) {
          return store.session.info[sessionID]
        },
        root(sessionID: string) {
          return resolveRoot(sessionID)
        },
        family(sessionID: string) {
          return store.session.family[resolveRoot(sessionID)] ?? []
        },
        cost(sessionID: string) {
          const session = store.session.info[sessionID]
          if (!session) return 0
          if (session.parentID) return session.cost
          return (store.session.family[sessionID] ?? [sessionID]).reduce(
            (total, id) => total + (store.session.info[id]?.cost ?? 0),
            0,
          )
        },
        status(sessionID: string) {
          return store.session.active[sessionID] ?? "idle"
        },
        prediction: {
          get(sessionID: string) {
            return store.session.prediction[sessionID]
          },
          dismiss(sessionID: string) {
            const sourceMessageID = result.session.message
              .list(sessionID)
              .findLast((message) => message.type === "assistant")?.id
            if (sourceMessageID) setStore("session", "predictionDismissed", sessionID, sourceMessageID)
            setStore("session", "prediction", sessionID, undefined)
          },
          request(sessionID: string, input: { memory: ReadonlyArray<"repository" | "knowledge">; hint?: string }) {
            setStore(
              "session",
              produce((draft) => {
                delete draft.predictionDismissed[sessionID]
                delete draft.prediction[sessionID]
              }),
            )
            return client.api.session.prediction({
              sessionID,
              memory: input.memory,
              ...(input.hint === undefined ? {} : { hint: input.hint }),
            })
          },
        },
        promptGenerate: {
          request(
            sessionID: string,
            input: {
              mode: "start" | "steer" | "queue" | "goal"
              intent: string
              memory: ReadonlyArray<"repository" | "knowledge">
            },
          ) {
            return client.api.session.promptGenerate({
              sessionID,
              mode: input.mode,
              intent: input.intent,
              memory: input.memory,
            })
          },
        },
        input: {
          list(sessionID: string) {
            return store.session.input[sessionID] ?? []
          },
          has(sessionID: string, inputID: string) {
            return store.session.input[sessionID]?.includes(inputID) ?? false
          },
        },
        pending: {
          list(sessionID: string) {
            return store.session.pending[sessionID] ?? []
          },
          sync(sessionID: string) {
            return sync.run(`session.pending:${sessionID}`, async (current) => {
              const pending = await client.api.session.pending.list({
                sessionID,
              })
              if (!current()) return
              setStore("session", "pending", sessionID, reconcile(pending))
              setStore("session", "input", sessionID, reconcile(pending.map((item) => item.id)))
              pending.forEach(projectPending)
              submissions.reconcile(sessionID, store.session.message[sessionID] ?? [], pending)
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.pending:${sessionID}`)
          },
        },
        subagent: {
          page(parentID: string) {
            return store.session.subagent[parentID]
          },
          summary(parentID: string) {
            return store.session.subagent[parentID]?.summary
          },
          navigation(parentID: string) {
            const page = store.session.subagent[parentID]
            return {
              position: page?.position ?? "top",
              older: page?.cursor?.next !== undefined,
              newer: page?.cursor?.previous !== undefined,
            }
          },
          sync(parentID: string) {
            return loadSubagentPage(parentID, {}, "top", () => 0)
          },
          loadOlder(parentID: string) {
            const page = store.session.subagent[parentID]
            if (!page || !page.cursor.next) return Promise.resolve()
            return loadSubagentPage(
              parentID,
              { cursor: page.cursor.next },
              "older",
              () => page.offset + page.data.length,
            )
          },
          loadNewer(parentID: string) {
            const page = store.session.subagent[parentID]
            if (!page || !page.cursor.previous) return Promise.resolve()
            return loadSubagentPage(parentID, { cursor: page.cursor.previous }, "older", (loaded) =>
              Math.max(0, page.offset - loaded.data.length),
            )
          },
          children(parentID: string) {
            return directSubagents(parentID)
          },
          invalidate(parentID: string) {
            subagentGeneration.set(parentID, (subagentGeneration.get(parentID) ?? 0) + 1)
            sync.invalidate(`session.subagent:${parentID}`)
          },
        },
        sync(sessionID: string) {
          return sync.run(`session:${sessionID}`, async (current) => {
            const info = await client.api.session.get({ sessionID })
            if (!current()) return
            setStore("session", "info", sessionID, info)
            registerSession(sessionID)
          })
        },
        invalidate(sessionID: string) {
          sync.invalidate(`session:${sessionID}`)
        },
        diagnostics: {
          get(sessionID: string) {
            return store.session.diagnostics[sessionID]
          },
          sync(sessionID: string) {
            return sync.run(`session.diagnostics:${sessionID}`, async (current) => {
              const diagnostics = await client.api.session.diagnostics({ sessionID })
              if (!current()) return
              setStore("session", "diagnostics", sessionID, diagnostics)
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.diagnostics:${sessionID}`)
          },
        },
        usage: {
          get(sessionID: string) {
            return store.session.usage[sessionID]
          },
          sync(sessionID: string) {
            return sync.run(`session.usage:${sessionID}`, async (current) => {
              const usage = await client.api.session.usage({ sessionID })
              if (!current()) return
              setStore("session", "usage", sessionID, usage)
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.usage:${sessionID}`)
          },
        },
        todo: {
          get(sessionID: string) {
            return store.session.todo[sessionID] ?? []
          },
          sync(sessionID: string) {
            return sync.run(`session.todo:${sessionID}`, async (current) => {
              const todo = await client.api.session.todo.list({ sessionID })
              if (!current()) return
              setStore("session", "todo", sessionID, reconcile(todo))
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.todo:${sessionID}`)
          },
        },
        message: {
          history(sessionID: string) {
            return store.session.history[sessionID]
          },
          list(sessionID: string) {
            const messages = store.session.message[sessionID] ?? []
            return [
              ...messages,
              ...submissions.list(sessionID).flatMap((entry) => {
                if (messages.some((message) => message.id === entry.input.promptID)) return []
                const message = submissions.message(sessionID, entry.input.promptID)
                return message ? [message] : []
              }),
            ]
          },
          memory(sessionID: string) {
            const memory = process.memoryUsage()
            return {
              ...estimateResidentSessionMemory({
                messages: store.session.message[sessionID] ?? [],
                residentSessions: Object.keys(store.session.message).length,
                process: { heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, rss: memory.rss },
              }),
              metadataKeys: Object.fromEntries(
                Object.entries(store.session).map(([key, values]) => [key, Object.keys(values).length]),
              ),
            }
          },
          get(sessionID: string, messageID: string) {
            const messages = store.session.message[sessionID]
            const position = messageIndex.get(sessionID)?.get(messageID)
            return position === undefined ? submissions.message(sessionID, messageID) : messages?.[position]
          },
          sync(sessionID: string) {
            return sync.run(`session.message:${sessionID}`, (current) => syncMessages(sessionID, current))
          },
          loadOlder(sessionID: string) {
            const current = olderLoads.get(sessionID)
            if (current) return current
            const pending = loadOlderMessages(sessionID).finally(() => {
              if (olderLoads.get(sessionID) === pending) olderLoads.delete(sessionID)
            })
            olderLoads.set(sessionID, pending)
            return pending
          },
          async find(sessionID: string, messageID: string) {
            if (result.session.message.get(sessionID, messageID)) return true
            await result.session.message.sync(sessionID)
            while (
              !result.session.message.get(sessionID, messageID) &&
              store.session.history[sessionID]?.before &&
              !store.session.history[sessionID]?.checkpoint &&
              client.connection.status() === "connected"
            )
              await result.session.message.loadOlder(sessionID)
            return result.session.message.get(sessionID, messageID) !== undefined
          },
          evict(sessionID: string) {
            setStore("session", "prediction", sessionID, undefined)
            messageIndex.delete(sessionID)
            messageSyncLoad.delete(sessionID)
            messageVersion.delete(sessionID)
            messageMutations.delete(sessionID)
            messageMutationSeq.delete(sessionID)
            messageOrderSeq.delete(sessionID)
            olderMessageIDs.delete(sessionID)
            historyOwner.delete(sessionID)
            olderLoads.delete(sessionID)
            streamSequence.delete(sessionID)
            sync.forget(`session.message:${sessionID}`)
            sync.forget(`session.compaction:${sessionID}`)
            setStore(
              "session",
              produce((draft) => {
                delete draft.message[sessionID]
                delete draft.history[sessionID]
                delete draft.compaction[sessionID]
                delete draft.compactionHistory[sessionID]
              }),
            )
            pruneMetadata()
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.message:${sessionID}`)
          },
        },
        compaction: {
          get(sessionID: string, jobID: string) {
            return store.session.compaction[sessionID]?.[jobID]
          },
          list(sessionID: string) {
            return Object.values(store.session.compaction[sessionID] ?? {}).toSorted(
              (a, b) => a.time.created - b.time.created || a.jobID.localeCompare(b.jobID),
            )
          },
          history(sessionID: string) {
            return store.session.compactionHistory[sessionID]
          },
          sync: syncCompactionHistory,
        },
        permission: {
          list(sessionID: string) {
            return store.session.permission[sessionID]
          },
          sync(sessionID: string) {
            return sync.run(`session.permission:${sessionID}`, async (current) => {
              const permissions = await client.api.permission.list({ sessionID })
              if (!current()) return
              setStore("session", "permission", sessionID, permissions)
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.permission:${sessionID}`)
          },
        },
        guardrail: {
          list(sessionID: string) {
            return store.session.guardrail[resolveRoot(sessionID)] ?? []
          },
          sync(sessionID: string) {
            return sync.run(`session.guardrail:${sessionID}`, async (current) => {
              const requests = await client.api.guardrail.request.list({ sessionID })
              if (!current()) return
              const rootID = requests[0]?.rootSessionID ?? resolveRoot(sessionID)
              setStore("session", "guardrail", rootID, reconcile(requests))
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.guardrail:${sessionID}`)
          },
        },
        form: {
          list(sessionID: string, ref?: LocationRef) {
            const forms = store.session.form[sessionID]
            if (sessionID !== "global") return forms
            if (!ref) return
            const key = locationKey(ref)
            return forms?.filter((form) => form.location && locationKey(form.location) === key)
          },
          sync(sessionID: string, ref?: LocationRef) {
            const key = `session.form:${sessionID}:${sessionID === "global" ? locationKey(ref ?? defaultLocation()) : ""}`
            return sync.run(key, async (current) => {
              if (sessionID === "global") {
                const response = await client.api.form.request.list({
                  location: locationQuery(ref ?? defaultLocation()),
                })
                if (!current()) return
                const location = {
                  directory: response.location.directory,
                  workspaceID: response.location.workspaceID,
                }
                const locationID = locationKey(location)
                setStore("session", "form", sessionID, [
                  ...(store.session.form[sessionID] ?? []).filter(
                    (form) => form.location && locationKey(form.location) !== locationID,
                  ),
                  ...response.data.filter((form) => form.sessionID === "global").map((form) => ({ ...form, location })),
                ])
                return
              }
              const forms = await client.api.form.list({ sessionID })
              if (!current()) return
              setStore("session", "form", sessionID, forms)
            })
          },
          invalidate(sessionID: string, ref?: LocationRef) {
            sync.invalidate(
              `session.form:${sessionID}:${sessionID === "global" ? locationKey(ref ?? defaultLocation()) : ""}`,
            )
          },
        },
      },
      project: {
        permission: {
          list(projectID: string) {
            return store.project.permission[projectID]
          },
          sync(projectID: string) {
            return sync.run(`project.permission:${projectID}`, async (current) => {
              const permissions = await client.api.permission.saved.list({ projectID })
              if (!current()) return
              setStore("project", "permission", projectID, permissions)
            })
          },
          invalidate(projectID: string) {
            sync.invalidate(`project.permission:${projectID}`)
          },
        },
      },
      shell: {
        list(location?: LocationRef) {
          return Object.values(store.location[locationKey(location ?? defaultLocation())]?.shell ?? {})
        },
        get(id: string) {
          return Object.values(store.location)
            .map((data) => data.shell?.[id])
            .find((shell) => shell !== undefined)
        },
        sync(ref?: LocationRef) {
          const id = locationKey(ref ?? defaultLocation())
          return sync.run(`location.shell:${id}`, async (current) => {
            const response = await client.api.shell.list({
              location: locationQuery(ref ?? defaultLocation()),
            })
            if (!current()) return
            const key = locationKey(response.location)
            setStore("location", key, {
              ...store.location[key],
              shell: Object.fromEntries(response.data.map((info) => [info.id, info])),
            })
          })
        },
        invalidate(ref?: LocationRef) {
          sync.invalidate(`location.shell:${locationKey(ref ?? defaultLocation())}`)
        },
      },
      location: {
        info(ref?: LocationRef) {
          return store.location[locationKey(ref ?? defaultLocation())]?.info
        },
        default() {
          return defaultLocation()
        },
        async sync(ref?: LocationRef) {
          const current = ref ?? defaultLocation()
          await sync.run(`location:${locationKey(current)}`, async (isCurrent) => {
            const location = await client.api.location.get({
              location: locationQuery(current),
            })
            if (!isCurrent()) return
            const key = locationKey(location)
            if (!store.location[key]) setStore("location", key, {})
            setStore("location", key, "info", location)
            if (!ref) {
              setDefaultLocation({
                directory: location.directory,
                workspaceID: location.workspaceID,
              })
            }
          })
          const location = ref ?? defaultLocation()
          await Promise.all([
            result.location.agent.sync(location),
            result.location.command.sync(location),
            result.location.integration.sync(location),
            result.location.mcp.server.sync(location),
            result.location.mcp.resource.sync(location),
            result.location.config.diagnostics.sync(location),
            result.location.model.sync(location),
            result.location.provider.sync(location),
            result.location.reference.sync(location),
            result.location.skill.sync(location),
            result.shell.sync(location),
            result.session.form.sync("global", location),
          ])
        },
        invalidate(ref?: LocationRef) {
          const location = ref ?? defaultLocation()
          sync.invalidate(`location:${locationKey(location)}`)
          result.location.agent.invalidate(location)
          result.location.command.invalidate(location)
          result.location.integration.invalidate(location)
          result.location.mcp.server.invalidate(location)
          result.location.mcp.resource.invalidate(location)
          result.location.config.diagnostics.invalidate(location)
          result.location.model.invalidate(location)
          result.location.provider.invalidate(location)
          result.location.reference.invalidate(location)
          result.location.skill.invalidate(location)
          result.shell.invalidate(location)
          result.session.form.invalidate("global", location)
        },
        agent: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.agent
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.agent:${id}`, async (current) => {
              const response = await client.api.agent.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              if (!current()) return
              const key = locationKey(response.location)
              setStore("location", key, {
                ...store.location[key],
                agent: response.data,
              })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.agent:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        command: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.command
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.command:${id}`, async (current) => {
              const response = await client.api.command.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              if (!current()) return
              const key = locationKey(response.location)
              setStore("location", key, {
                ...store.location[key],
                command: response.data,
              })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.command:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        integration: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.integration
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.integration:${id}`, async (current) => {
              const response = await client.api.integration.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              if (!current()) return
              const key = locationKey(response.location)
              setStore("location", key, {
                ...store.location[key],
                integration: response.data,
              })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.integration:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        mcp: {
          server: {
            list(location?: LocationRef) {
              return store.location[locationKey(location ?? defaultLocation())]?.mcp?.server
            },
            sync(ref?: LocationRef) {
              const id = locationKey(ref ?? defaultLocation())
              return sync.run(`location.mcp.server:${id}`, async (current) => {
                const response = await client.api.mcp.list({
                  location: locationQuery(ref ?? defaultLocation()),
                })
                if (!current()) return
                const key = locationKey(response.location)
                setStore("location", key, {
                  ...store.location[key],
                  mcp: { ...store.location[key]?.mcp, server: response.data },
                })
              })
            },
            invalidate(ref?: LocationRef) {
              sync.invalidate(`location.mcp.server:${locationKey(ref ?? defaultLocation())}`)
            },
          },
          resource: {
            list(location?: LocationRef) {
              return store.location[locationKey(location ?? defaultLocation())]?.mcp?.resource
            },
            sync(ref?: LocationRef) {
              const id = locationKey(ref ?? defaultLocation())
              return sync.run(`location.mcp.resource:${id}`, async (current) => {
                const response = await client.api.mcp.resource.catalog({
                  location: locationQuery(ref ?? defaultLocation()),
                })
                if (!current()) return
                const key = locationKey(response.location)
                setStore("location", key, {
                  ...store.location[key],
                  mcp: {
                    ...store.location[key]?.mcp,
                    resource: response.data.resources,
                  },
                })
              })
            },
            invalidate(ref?: LocationRef) {
              sync.invalidate(`location.mcp.resource:${locationKey(ref ?? defaultLocation())}`)
            },
          },
        },
        config: {
          diagnostics: {
            list(location?: LocationRef) {
              return store.location[locationKey(location ?? defaultLocation())]?.config?.diagnostics
            },
            sync(ref?: LocationRef) {
              const id = locationKey(ref ?? defaultLocation())
              return sync.run(`location.config.diagnostics:${id}`, async (current) => {
                const response = await client.api.config.diagnostics({
                  location: locationQuery(ref ?? defaultLocation()),
                })
                if (!current()) return
                const key = locationKey(response.location)
                setStore("location", key, {
                  ...store.location[key],
                  config: { ...store.location[key]?.config, diagnostics: response.data },
                })
              })
            },
            invalidate(ref?: LocationRef) {
              sync.invalidate(`location.config.diagnostics:${locationKey(ref ?? defaultLocation())}`)
            },
          },
        },
        model: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.model
          },
          default(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.modelDefault
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.model:${id}`, async (current) => {
              const requestedLocation = locationQuery(ref ?? defaultLocation())
              const configured = await client.api.model.default({ location: requestedLocation })
              if (!current()) return
              const response = await client.api.model.list({ location: requestedLocation })
              if (!current()) return
              const key = locationKey(response.location)
              setStore("location", key, {
                ...store.location[key],
                model: response.data,
                modelDefault: configured.data?.selection,
              })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.model:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        provider: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.provider
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.provider:${id}`, async (current) => {
              const response = await client.api.provider.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              if (!current()) return
              const key = locationKey(response.location)
              setStore("location", key, {
                ...store.location[key],
                provider: response.data,
              })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.provider:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        reference: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.reference
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.reference:${id}`, async (current) => {
              const response = await client.api.reference.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              if (!current()) return
              const key = locationKey(response.location)
              setStore("location", key, {
                ...store.location[key],
                reference: response.data,
              })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.reference:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        skill: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.skill
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.skill:${id}`, async (current) => {
              const response = await client.api.skill.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              if (!current()) return
              const key = locationKey(response.location)
              setStore("location", key, {
                ...store.location[key],
                skill: response.data,
              })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.skill:${locationKey(ref ?? defaultLocation())}`)
          },
        },
      },
    }
    result satisfies Plugin.Context["data"]

    createEffect(() => {
      props.selectedSessionID?.()
      untrack(pruneMetadata)
    })

    createEffect((previous) => {
      const status = client.connection.status()
      if (status === "connected" || previous !== "connected") return status
      setStore(
        "session",
        "prediction",
        produce((draft) => {
          Object.keys(draft).forEach((id) => {
            delete draft[id]
          })
        }),
      )
      activeSnapshot = undefined
      sync.invalidate()
      subagentGeneration.forEach((generation, parentID) => subagentGeneration.set(parentID, generation + 1))
      messageSyncLoad.clear()
      historyOwner.clear()
      olderLoads.clear()
      return status
    }, client.connection.status())

    onCleanup(
      client.event.listen(({ details }) => {
        if (
          [
            "session.input.admitted",
            "session.execution.started",
            "session.step.started",
            "session.moved",
            "session.deleted",
            "session.archived",
            "session.agent.selected",
            "session.model.selected",
          ].includes(details.type) &&
          "sessionID" in details.data
        )
          result.session.prediction.dismiss(details.data.sessionID)
        if (
          details.type === "session.text.delta" ||
          details.type === "session.reasoning.delta" ||
          details.type === "session.tool.input.delta"
        )
          props.recordTelemetry?.("stream.delay", Date.now() - details.created, Date.now())
        submissions.observe(details)
        if (details.type === "server.connected") {
          sourceEpoch = details.sourceEpoch
          const mutations = new Map<string, DataSessionStatus>()
          activeSnapshot = mutations
          // Durable task state is broader than execution activity: waiting and cancelling children
          // remain active while absent from the execution snapshot. Refresh every resident parent
          // after reconnect instead of leaving its cached summary dependent on a running child.
          void Promise.all(
            Object.keys(store.session.subagent).map((parentID) =>
              result.session.subagent.sync(parentID).catch(() => undefined),
            ),
          )
          void client.api.session
            .active()
            .then(async (active) => {
              if (activeSnapshot !== mutations) return
              activeSnapshot = undefined
              const statuses = {
                ...Object.fromEntries(Object.keys(active).map((sessionID) => [sessionID, "running" as const])),
                ...Object.fromEntries(mutations),
              }
              const sessionIDs = Object.keys(statuses).filter((sessionID) => statuses[sessionID] === "running")
              setStore("session", "active", reconcile(statuses))
              // The root preload below omits children. Resolve every active
              // Session first, then hydrate each durable parent task list so
              // the subagent indicator is complete immediately after restart.
              await Promise.all(
                sessionIDs.map((sessionID) =>
                  store.session.info[sessionID]
                    ? Promise.resolve()
                    : result.session.sync(sessionID).catch(() => undefined),
                ),
              )
              const parentIDs = new Set(
                sessionIDs.map((sessionID) => store.session.info[sessionID]?.parentID ?? sessionID),
              )
              await Promise.all(
                [...parentIDs].map((parentID) => result.session.subagent.sync(parentID).catch(() => undefined)),
              )
            })
            .catch(() => {
              if (activeSnapshot === mutations) activeSnapshot = undefined
            })
          void client.api.location
            .get({ location: locationQuery(defaultLocation()) })
            .then((location) => {
              const key = locationKey(location)
              setStore("location", key, {
                ...store.location[key],
                info: location,
              })
              return client.api.session.list({
                project: location.project.id,
                limit: 50,
                order: "desc",
                parentID: null,
              })
            })
            .then((response) => {
              setStore(
                "session",
                "info",
                produce((draft) => {
                  for (const session of response.data) draft[session.id] = session
                }),
              )
              for (const session of response.data) {
                sync.complete(`session:${session.id}`)
                registerSession(session.id)
              }
              pruneMetadata()
            })
            .catch((error) => console.error("Failed to preload sessions", error))
          return
        }
        applyingSequence = "durable" in details ? details.durable.seq : undefined
        handleEvent(details)
        applyingSequence = undefined
        pruneMetadata()
      }),
    )

    onCleanup(
      client.event.filter((event) => {
        if (sourceEpoch && event.sourceEpoch && event.sourceEpoch !== sourceEpoch) return false
        if (!("durable" in event)) return true
        const sessionID = event.durable.aggregateID
        const history = store.session.history[sessionID]
        if (!history) return true
        if (
          history.watermark !== undefined &&
          event.durable.seq <= history.watermark &&
          event.type !== "session.task.updated"
        )
          return false
        const previous = streamSequence.get(sessionID) ?? history.watermark
        streamSequence.set(sessionID, Math.max(previous ?? -1, event.durable.seq))
        if (previous !== undefined && event.durable.seq > previous + 1 && client.connection.status() === "connected") {
          result.session.message.invalidate(sessionID)
          void result.session.message.sync(sessionID).catch(() => undefined)
        }
        return true
      }),
    )

    return result
  },
})
