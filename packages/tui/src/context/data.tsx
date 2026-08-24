// Client data layer: apply server events and cache API reads into a Solid store.
// Transcript request identities prevent an evicted session load from becoming reachable after
// navigation. Reconnect invalidates cached reads; active UI owners decide what to sync again.

import type {
  AgentInfo,
  CommandInfo,
  FormInfo,
  GuardrailRequestListOutput,
  IntegrationInfo,
  LocationRef,
  LocationGetOutput,
  McpResource,
  McpServer,
  ModelInfo,
  PermissionSavedInfo,
  PermissionV2Request,
  ProviderRequestSummary,
  ProviderV2Info,
  ReferenceInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionInfo,
  SessionDiagnosticsOutput,
  SessionEventFileChangeInfo,
  SessionOrchestrationPage,
  SessionPendingInfo,
  SessionTodoInfo,
  ShellInfo,
  SkillInfo,
  YCodingEvent,
} from "@ycoding-ai/client"
import type { Plugin } from "@ycoding-ai/plugin/tui"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { batch, createEffect, createSignal, onCleanup } from "solid-js"

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
  const base = {
    jobID: update.jobID,
    ...(messageID ? { messageID } : {}),
    ...(trigger ? { trigger } : {}),
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

export type SubagentPage = SessionOrchestrationPage & {
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
  model?: ModelInfo[]
  provider?: ProviderV2Info[]
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
    usage: Record<string, ProviderRequestSummary>
    fileChange: Record<string, SessionEventFileChangeInfo[]>
    message: Record<string, SessionMessageInfo[]>
    compaction: Record<string, Record<string, DataSessionCompactionLifecycle>>
    pending: Record<string, SessionPendingInfo[]>
    subagent: Record<string, SubagentPage>
    todo: Record<string, SessionTodoInfo[]>
    input: Record<string, string[]>
    permission: Record<string, PermissionV2Request[]>
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

export function isMessageComplete(message: SessionMessageInfo) {
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

export function reconcileCanonicalMessages(
  api: SessionMessageInfo[],
  current: SessionMessageInfo[],
  touched: ReadonlySet<string>,
  active: ReadonlySet<string>,
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
  current.forEach((message) => {
    const position = positions.get(message.id)
    const preserve = touched.has(message.id) || active.has(message.id) || !isMessageComplete(message)
    if (!preserve) return
    if (position === undefined) {
      positions.set(message.id, messages.length)
      messages.push(message)
      return
    }
    messages[position] = message
  })
  return messages
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

function createSync() {
  const state = new Map<string, true | Promise<void>>()
  return {
    run(key: string, load: () => Promise<void>) {
      const active = state.get(key)
      if (active === true) return Promise.resolve()
      if (active) return active
      const pending = load()
        .then(() => {
          if (state.get(key) === pending) state.set(key, true)
        })
        .finally(() => {
          if (state.get(key) === pending) state.delete(key)
        })
      state.set(key, pending)
      return pending
    },
    complete(key: string) {
      if (state.has(key)) return
      state.set(key, true)
    },
    invalidate(key?: string) {
      if (key) {
        state.delete(key)
        return
      }
      state.clear()
    },
  }
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<Store>({
      session: {
        info: {},
        family: {},
        active: {},
        diagnostics: {},
        usage: {},
        fileChange: {},
        message: {},
        compaction: {},
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
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: process.cwd(),
    })
    const messageIndex = new Map<string, Map<string, number>>()
    const messageSyncLoad = new Map<string, object>()
    const messageVersion = new Map<string, number>()
    const messageMutations = new Map<string, Map<string, number>>()
    const subagentGeneration = new Map<string, number>()
    const sync = createSync()

    function replaceMessages(sessionID: string, messages: SessionMessageInfo[]) {
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
        .filter(
          (message): message is Extract<SessionMessageInfo, { type: "compaction" }> =>
            message.type === "compaction" &&
            "jobID" in message &&
            (message as unknown as { status: string }).status === "completed" &&
            !!(message as unknown as { boundary?: unknown }).boundary,
        )
        .map((message) => messages.findIndex((item) => item.id === (message as unknown as { boundary: { messageID: string } }).boundary.messageID))
        .reduce((latest, position) => Math.max(latest, position), -1)
      const boundary = Math.max(fromStore, fromMessages)
      if (boundary === -1) return messages
      return messages.filter((message, position) => position > boundary || message.type === "compaction")
    }

    async function syncMessages(sessionID: string) {
      const token = {}
      const requestVersion = messageVersion.get(sessionID) ?? 0
      messageSyncLoad.set(sessionID, token)
      try {
        const response = await client.api.message.list({ sessionID })
        if (messageSyncLoad.get(sessionID) !== token) return
        const active = new Set(store.session.input[sessionID] ?? [])
        const touched = new Set(
          [...(messageMutations.get(sessionID)?.entries() ?? [])]
            .filter(([, version]) => version > requestVersion)
            .map(([id]) => id),
        )
        const reconciled = reconcileCanonicalMessages(response, store.session.message[sessionID] ?? [], touched, active)
        batch(() => {
          response.forEach((item) => {
            const lifecycle = compactionLifecycle(item)
            if (!lifecycle) return
            setCompaction(sessionID, lifecycle)
          })
          replaceMessages(sessionID, reconciled)
        })
      } finally {
        if (messageSyncLoad.get(sessionID) === token) messageSyncLoad.delete(sessionID)
      }
    }

    function setSessionActive(sessionID: string, status: DataSessionStatus) {
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

    function updateCompaction(sessionID: string, lifecycle: DataSessionCompactionLifecycle) {
      setCompaction(sessionID, lifecycle)
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
            if (!sameRevision(before.get(item.id), messageRevision(item))) mutations.set(item.id, version)
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
      messageIndex.delete(sessionID)
      messageSyncLoad.delete(sessionID)
      messageVersion.delete(sessionID)
      messageMutations.delete(sessionID)
      subagentGeneration.delete(sessionID)
      sync.invalidate(`session:${sessionID}`)
      sync.invalidate(`session.pending:${sessionID}`)
      sync.invalidate(`session.subagent:${sessionID}`)
      sync.invalidate(`session.message:${sessionID}`)
      sync.invalidate(`session.diagnostics:${sessionID}`)
      sync.invalidate(`session.usage:${sessionID}`)
      sync.invalidate(`session.permission:${sessionID}`)
      sync.invalidate(`session.guardrail:${sessionID}`)
      sync.invalidate(`session.form:${sessionID}:`)
      setStore(
        "session",
        produce((draft) => {
          delete draft.info[sessionID]
          delete draft.active[sessionID]
          delete draft.message[sessionID]
          delete draft.compaction[sessionID]
          delete draft.diagnostics[sessionID]
          delete draft.usage[sessionID]
          delete draft.pending[sessionID]
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

    async function loadSubagentPage(
      parentID: string,
      input: { readonly cursor?: string },
      requested: "top" | "older",
      pageOffset: (page: SessionOrchestrationPage) => number,
    ) {
      const generation = (subagentGeneration.get(parentID) ?? 0) + 1
      subagentGeneration.set(parentID, generation)
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
    }

    async function completedSubagents(parentID: string) {
      const tasks = []
      let cursor: string | undefined
      do {
        const page = await client.api.session.subagent.list({ parentID, limit: 10, ...(cursor ? { cursor } : {}) })
        tasks.push(...page.data.filter((task) => task.state === "completed"))
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
          void result.session.sync(sessionID)
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
        case "todo.updated":
          setStore("session", "todo", event.data.sessionID, reconcile(event.data.todos))
          break
        case "session.file-change.recorded": {
          const parentID =
            store.session.info[event.data.sessionID]?.parentID ??
            Object.entries(store.session.subagent).find(([, page]) =>
              page.data.some((task) => task.sessionID === event.data.sessionID),
            )?.[0]
          const sessionIDs = [event.data.sessionID, parentID].filter((sessionID): sessionID is string => !!sessionID)
          sessionIDs.forEach((sessionID) => {
            result.session.fileChange.invalidate(sessionID)
            if (store.session.fileChange[sessionID] === undefined) return
            void result.session.fileChange.sync(sessionID).catch(() => undefined)
          })
          break
        }
        case "session.model.selected":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "model", event.data.model)
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
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "system",
              text: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
              metadata: event.metadata,
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
            const currentAssistant = message.activeAssistant(draft)
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
        case "permission.v2.asked":
          if (store.session.permission[event.data.sessionID]?.some((request) => request.id === event.data.id)) break
          setStore("session", "permission", event.data.sessionID, [
            ...(store.session.permission[event.data.sessionID] ?? []),
            event.data,
          ])
          break
        case "permission.v2.replied":
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
      on: client.event.on,
      listen: client.event.listen,
      session: {
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
            return sync.run(`session.pending:${sessionID}`, async () => {
              const pending = await client.api.session.pending.list({
                sessionID,
              })
              setStore("session", "pending", sessionID, reconcile(pending))
              setStore("session", "input", sessionID, reconcile(pending.map((item) => item.id)))
              pending.forEach(projectPending)
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
          completed(parentID: string) {
            return completedSubagents(parentID)
          },
          invalidate(parentID: string) {
            subagentGeneration.set(parentID, (subagentGeneration.get(parentID) ?? 0) + 1)
            sync.invalidate(`session.subagent:${parentID}`)
          },
        },
        sync(sessionID: string) {
          return sync.run(`session:${sessionID}`, async () => {
            setStore("session", "info", sessionID, await client.api.session.get({ sessionID }))
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
            return sync.run(`session.diagnostics:${sessionID}`, async () => {
              setStore("session", "diagnostics", sessionID, await client.api.session.diagnostics({ sessionID }))
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
            return sync.run(`session.usage:${sessionID}`, async () => {
              setStore("session", "usage", sessionID, await client.api.session.usage({ sessionID }))
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.usage:${sessionID}`)
          },
        },
        fileChange: {
          list(sessionID: string) {
            return store.session.fileChange[sessionID] ?? []
          },
          sync(sessionID: string) {
            return sync.run(`session.fileChange:${sessionID}`, async () => {
              setStore("session", "fileChange", sessionID, await client.api.session["file-change"].list({ sessionID }))
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.fileChange:${sessionID}`)
          },
        },
        todo: {
          get(sessionID: string) {
            return store.session.todo[sessionID] ?? []
          },
          sync(sessionID: string) {
            return sync.run(`session.todo:${sessionID}`, async () => {
              setStore("session", "todo", sessionID, reconcile(await client.api.session.todo.list({ sessionID })))
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.todo:${sessionID}`)
          },
        },
        message: {
          list(sessionID: string) {
            return store.session.message[sessionID] ?? []
          },
          memory(sessionID: string) {
            const memory = process.memoryUsage()
            return estimateResidentSessionMemory({
              messages: store.session.message[sessionID] ?? [],
              residentSessions: Object.keys(store.session.message).length,
              process: { heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, rss: memory.rss },
            })
          },
          get(sessionID: string, messageID: string) {
            const messages = store.session.message[sessionID]
            const position = messageIndex.get(sessionID)?.get(messageID)
            return position === undefined ? undefined : messages?.[position]
          },
          sync(sessionID: string) {
            return sync.run(`session.message:${sessionID}`, () => syncMessages(sessionID))
          },
          async find(sessionID: string, messageID: string) {
            if (result.session.message.get(sessionID, messageID)) return true
            sync.invalidate(`session.message:${sessionID}`)
            await result.session.message.sync(sessionID)
            return result.session.message.get(sessionID, messageID) !== undefined
          },
          evict(sessionID: string) {
            messageIndex.delete(sessionID)
            messageSyncLoad.delete(sessionID)
            messageVersion.delete(sessionID)
            messageMutations.delete(sessionID)
            sync.invalidate(`session.message:${sessionID}`)
            setStore(
              "session",
              produce((draft) => {
                delete draft.message[sessionID]
              }),
            )
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
        },
        permission: {
          list(sessionID: string) {
            return store.session.permission[sessionID]
          },
          sync(sessionID: string) {
            return sync.run(`session.permission:${sessionID}`, async () => {
              setStore("session", "permission", sessionID, await client.api.permission.list({ sessionID }))
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
            return sync.run(`session.guardrail:${sessionID}`, async () => {
              const requests = await client.api.guardrail.request.list({ sessionID })
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
            return sync.run(key, async () => {
              if (sessionID === "global") {
                const response = await client.api.form.request.list({
                  location: locationQuery(ref ?? defaultLocation()),
                })
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
              setStore("session", "form", sessionID, await client.api.form.list({ sessionID }))
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
            return sync.run(`project.permission:${projectID}`, async () => {
              setStore("project", "permission", projectID, await client.api.permission.saved.list({ projectID }))
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
          return sync.run(`location.shell:${id}`, async () => {
            const response = await client.api.shell.list({
              location: locationQuery(ref ?? defaultLocation()),
            })
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
          await sync.run(`location:${locationKey(current)}`, async () => {
            const location = await client.api.location.get({
              location: locationQuery(current),
            })
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
            return sync.run(`location.agent:${id}`, async () => {
              const response = await client.api.agent.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
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
            return sync.run(`location.command:${id}`, async () => {
              const response = await client.api.command.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
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
            return sync.run(`location.integration:${id}`, async () => {
              const response = await client.api.integration.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
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
              return sync.run(`location.mcp.server:${id}`, async () => {
                const response = await client.api.mcp.list({
                  location: locationQuery(ref ?? defaultLocation()),
                })
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
              return sync.run(`location.mcp.resource:${id}`, async () => {
                const response = await client.api.mcp.resource.catalog({
                  location: locationQuery(ref ?? defaultLocation()),
                })
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
        model: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.model
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.model:${id}`, async () => {
              const response = await client.api.model.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              const key = locationKey(response.location)
              setStore("location", key, {
                ...store.location[key],
                model: response.data,
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
            return sync.run(`location.provider:${id}`, async () => {
              const response = await client.api.provider.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
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
            return sync.run(`location.reference:${id}`, async () => {
              const response = await client.api.reference.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
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
            return sync.run(`location.skill:${id}`, async () => {
              const response = await client.api.skill.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
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
      if (client.connection.status() === "connected") return
      sync.invalidate()
      subagentGeneration.forEach((generation, parentID) => subagentGeneration.set(parentID, generation + 1))
      messageSyncLoad.clear()
    })

    onCleanup(
      client.event.listen(({ details }) => {
        if (details.type === "server.connected") {
          void client.api.session
            .active()
            .then(async (active) => {
              const sessionIDs = Object.keys(active)
              setStore(
                "session",
                "active",
                reconcile(Object.fromEntries(sessionIDs.map((sessionID) => [sessionID, "running" as const]))),
              )
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
            .catch(() => undefined)
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
            })
            .catch((error) => console.error("Failed to preload sessions", error))
          return
        }
        handleEvent(details)
      }),
    )

    return result
  },
})
