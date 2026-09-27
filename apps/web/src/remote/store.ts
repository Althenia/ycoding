import type { CreateEnrollmentResponse, RemoteDeviceInfo, RemoteOperation, RemoteWorkspaceInfo } from "@ycoding-ai/remote"
import { catalogKey, readCatalog, readFileFind, type AgentAttachmentInput, type CatalogTarget, type CatalogView, type FileAttachmentInput, type FileFindResult } from "./catalog"
import { signInURL, type RemoteHttp, type RemoteHttpResult, type SignInProvider } from "./http"
import {
  createNotificationDelivery,
  notificationCategory,
  type NotificationDelivery,
  type RemoteNotificationView,
} from "./notifications"
import {
  applySessionEvent,
  canReplyToRequest,
  createSessionView,
  ephemeralAssistantID,
  ephemeralPartKey,
  mergeFileChanges,
  modelLabel,
  openedPartKey,
  readAggregateID,
  readAutonomy,
  readEventSequence,
  readFileChangeEvent,
  readFileChangeList,
  readModelRef,
  readShellOutputPage,
  sealedPartKeys,
  readGuardrailRequests,
  readPermissionRequests,
  readFormRequests,
  readSessionInfoList,
  readSnapshot,
  readTeamCue,
  replaceFileChanges,
  replaceRequests,
  shellOutputFetchFor,
  shellOutputFor,
  withShellOutputFetch,
  withShellOutputPage,
  type FileChangeView,
  type PendingRequestView,
  type RemoteMessageView,
  type SessionAutonomyView,
  type SessionView,
  type TeamCue,
  type ShellOutputFetch,
} from "./projection"
import type { ModelRefView } from "./projection"
import { assertRemoteRequestSize, uploadAttachments } from "./attachment-upload"
import type {
  RemoteRequestOutcome,
  RemoteTransport,
  RemoteTransportHandlers,
  RemoteTransportStatus,
} from "./transport"
import type { RemoteConnectionState } from "./view-model"
import { reportKey, type UsageProvider, type UsageReport, type UsageReportInput, type UsageSummary } from "./ui/usage-model"

type UsageRead<T> = { readonly status: "idle" | "loading" | "ready" | "unsupported" | "error"; readonly data?: T; readonly message?: string }
export type TodoView = { readonly content: string; readonly status: "pending" | "in_progress" | "completed" | "cancelled"; readonly priority: "high" | "medium" | "low" }

function readTodos(value: unknown): readonly TodoView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const todos = value.map((item: unknown) => {
    if (typeof item !== "object" || item === null) return undefined
    const content = Reflect.get(item, "content")
    const status = Reflect.get(item, "status")
    const priority = Reflect.get(item, "priority")
    if (typeof content !== "string" || !["pending", "in_progress", "completed", "cancelled"].includes(status) ||
      !["high", "medium", "low"].includes(priority)) return undefined
    return { content, status, priority } as TodoView
  })
  return todos.every((item) => item !== undefined) ? todos as readonly TodoView[] : undefined
}

function eventTodos(event: unknown, sessionID: string): readonly TodoView[] | undefined {
  if (typeof event !== "object" || event === null || Reflect.get(event, "type") !== "todo.updated") return undefined
  const data: unknown = Reflect.get(event, "data")
  if (typeof data !== "object" || data === null || Reflect.get(data, "sessionID") !== sessionID) return undefined
  return readTodos(Reflect.get(data, "todos"))
}
type UsageState = {
  readonly providers: UsageRead<readonly UsageProvider[]>
  readonly summary: UsageRead<UsageSummary>
  readonly reports: Readonly<Record<string, UsageRead<UsageReport>>>
}
const emptyUsage = (): UsageState => ({ providers: { status: "idle" }, summary: { status: "idle" }, reports: {} })

export type SessionInfoView = {
  readonly id: string
  readonly parentID?: string
  readonly title: string
  readonly projectID?: string
  readonly directory?: string
  readonly agent?: string
  readonly model?: ModelRefView
  readonly modelLabel?: string
  readonly updatedAt: number
  readonly archived: boolean
  readonly pinnedAt?: number
  /** Absent when the connection cannot report active sessions. */
  readonly running?: boolean
  readonly attention?: boolean
}

export type TeamTaskView = {
  readonly sessionID: string
  readonly parentID: string
  readonly description: string
  readonly agent?: string
  readonly modelLabel?: string
  readonly state: "starting" | "running" | "waiting" | "cancelling" | "cancelled" | "completed" | "failed" | "lost"
  readonly revision: number
  readonly updatedAt: number
}

export type TeamView = {
  readonly rootID: string
  readonly status: "loading" | "ready" | "unsupported" | "error"
  readonly tasks: readonly TeamTaskView[]
  readonly total?: number
  readonly next?: string
  readonly pageLoading: boolean
}

export type PendingMutation = {
  readonly id: string
  readonly kind: "prompt" | "command" | "skill" | "model" | "agent" | "interrupt" | "permission" | "guardrail" | "form" | "autonomy" | "goal"
  readonly label: string
  readonly state: "sending" | "unknown" | "failed"
  readonly detail?: string
  readonly sessionID: string
  readonly operation: RemoteOperation
  readonly input: Readonly<Record<string, unknown>>
}

export type SessionCreation = {
  readonly id: string
  readonly deviceID: string
  readonly workspace: RemoteWorkspaceInfo
  readonly status: "creating" | "unknown" | "failed"
  readonly message?: string
  readonly agent?: string
  readonly model?: ModelRefView
  readonly prompt?: { readonly text: string; readonly files?: readonly FileAttachmentInput[]; readonly agents?: readonly AgentAttachmentInput[]; readonly skills?: readonly string[] }
    | { readonly command: string; readonly arguments?: string; readonly files?: readonly FileAttachmentInput[]; readonly agents?: readonly AgentAttachmentInput[] }
}

export type RemoteStoreState = {
  readonly connection: RemoteConnectionState
  readonly owner?: { readonly id: string; readonly expiresAt: number }
  readonly devices: readonly RemoteDeviceInfo[]
  readonly activeDeviceID?: string
  readonly advertised: readonly string[]
  readonly sessions: readonly SessionInfoView[]
  readonly sessionStatus?: { readonly running: ReadonlySet<string>; readonly attention: ReadonlySet<string> }
  readonly catalogs: Readonly<Record<string, CatalogView>>
  readonly usage: UsageState
  readonly sessionGroups: readonly RemoteWorkspaceInfo[]
  readonly selectedWorkspaceID?: string
  readonly sessionQuery: string
  readonly sessionFilter: "all" | "running" | "idle"
  readonly sessionListStatus: "idle" | "loading" | "ready" | "error"
  readonly sessionPageLoading: boolean
  readonly sessionHasNext: boolean
  readonly sessionHasPrevious: boolean
  readonly selectedSessionInfo?: SessionInfoView
  readonly drafts: Readonly<Record<string, string>>
  readonly workspaces: readonly RemoteWorkspaceInfo[]
  readonly workspaceStatus: "idle" | "loading" | "ready" | "error"
  readonly workspaceError?: string
  readonly sessionCreation?: SessionCreation
  readonly activeSessionID?: string
  readonly view?: SessionView
  readonly todos?: readonly TodoView[]
  readonly team?: TeamView
  readonly teamCues: readonly TeamCue[]
  readonly transport: RemoteTransportStatus
  readonly mutations: readonly PendingMutation[]
  readonly notice?: string
  readonly upload?: { readonly sessionID: string; readonly name: string; readonly percent: number }
  readonly uploadError?: string
  readonly notifications: readonly RemoteNotificationView[]
  readonly unhandledEvents: number
}

export type RemoteStoreOptions = {
  readonly http: RemoteHttp
  readonly createTransport: (deviceID: string, handlers: RemoteTransportHandlers) => RemoteTransport
  readonly schedule?: (callback: () => void, ms: number) => () => void
  readonly now?: () => number
  /** Coalesces stream deltas into one state notification. */
  readonly batchMs?: number
  readonly createMessageID?: () => string
  readonly createSessionID?: () => string
  readonly deviceName?: (deviceID: string) => string
  /** Alerts for live events; the default reads stored preferences and the browser notification API. */
  readonly notificationDelivery?: NotificationDelivery
}

export type RemoteStore = {
  readonly state: () => RemoteStoreState
  readonly subscribe: (listener: () => void) => () => void
  readonly signInURL: (provider: SignInProvider, redirectAfter?: string) => string
  readonly load: () => Promise<void>
  readonly logout: () => Promise<void>
  readonly createEnrollment: () => Promise<RemoteHttpResult<CreateEnrollmentResponse>>
  readonly revokeDevice: (deviceID: string) => Promise<RemoteHttpResult<void>>
  readonly connect: (deviceID: string) => void
  readonly disconnect: () => void
  readonly selectSession: (sessionID: string) => Promise<void>
  readonly watchTeam: (enabled: boolean) => void
  readonly loadMoreTeam: () => Promise<void>
  readonly selectWorkspace: (workspaceID: string) => void
  readonly searchSessions: (query: string, filter?: "all" | "running" | "idle") => void
  readonly nextSessionsPage: () => Promise<void>
  readonly previousSessionsPage: () => Promise<void>
  readonly setDraft: (sessionID: string, text: string) => void
  readonly loadWorkspaces: () => Promise<void>
  readonly loadCatalog: (target: CatalogTarget, options?: { readonly refresh?: boolean }) => Promise<void>
  readonly loadUsage: (options?: { readonly refresh?: boolean }) => Promise<void>
  readonly loadUsageReport: (input: UsageReportInput) => Promise<void>
  readonly findFiles: (target: CatalogTarget, query: string, limit?: number) => Promise<FileFindResult>
  readonly createSession: (input: { readonly workspaceID: string; readonly agent?: string; readonly model?: ModelRefView; readonly prompt?: SessionCreation["prompt"] }) => Promise<string | undefined>
  readonly retrySessionCreation: () => Promise<string | undefined>
  readonly dismissSessionCreation: () => void
  readonly reloadMessages: () => Promise<void>
  readonly loadShellOutputPage: (shellID: string) => Promise<void>
  readonly sendPrompt: (input: { readonly text: string; readonly delivery: "steer" | "queue"; readonly files?: readonly FileAttachmentInput[]; readonly agents?: readonly AgentAttachmentInput[]; readonly skills?: readonly string[]; readonly agent?: string; readonly model?: ModelRefView }) => Promise<void | boolean>
  readonly runCommand: (input: { readonly command: string; readonly arguments?: string; readonly delivery: "steer" | "queue"; readonly files?: readonly FileAttachmentInput[]; readonly agents?: readonly AgentAttachmentInput[]; readonly agent?: string; readonly model?: ModelRefView }) => Promise<void | boolean>
  readonly cancelUpload: () => void
  readonly switchModel: (model: ModelRefView) => Promise<boolean>
  readonly switchAgent: (agent: string) => Promise<boolean>
  readonly retryMutation: (id: string) => Promise<void>
  readonly dismissMutation: (id: string) => void
  readonly dismissNotification: (id: string) => void
  readonly markNotificationsRead: () => void
  readonly clearNotifications: () => void
  readonly interrupt: () => Promise<void>
  readonly replyPermission: (id: string, reply: "once" | "always" | "reject") => Promise<void>
  readonly replyGuardrail: (id: string, reply: "once" | "always" | "reject") => Promise<void>
  readonly replyForm: (formID: string, answer: Readonly<Record<string, string | number | boolean | readonly string[]>>) => Promise<void>
  readonly cancelForm: (formID: string) => Promise<void>
  readonly setYolo: (level: 0 | 1 | 2 | 3) => Promise<void>
  readonly setGoal: (text: string) => Promise<void>
  readonly stopGoal: () => Promise<void>
  readonly setAutonomy: (autonomy: SessionAutonomyView) => void
  readonly dispose: () => void
}

const defaultBatchMs = 24
const sessionPageSize = 25
const retainedSessionPages = 3

/** One shell-output request reads at most the local default page; the device bounds it again. */
const shellOutputPageLimit = 65_536
const notConnectedPage = "The relay connection is not open."
const unreadablePage = "The device returned an output page this client cannot read."

/**
 * Replay window for one snapshot read: live events received while the canonical
 * snapshot is in flight are re-applied on top of it. Only the read that opened a
 * window closes it, so a superseded read cannot drop the current window.
 */
type HydrationWindow = {
  readonly sessionID: string
  readonly events: unknown[]
  readonly replayed: Set<string>
}

/**
 * Optional active-session read. It is not part of the shared operation list yet,
 * so an unsupported relay answer is ignored and `running` simply stays unknown.
 */
/** Live fragments carry no durable envelope; durable boundaries always do. */
function isEphemeralEvent(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && !("durable" in payload)
}

export function createRemoteStore(options: RemoteStoreOptions): RemoteStore {
  const schedule = options.schedule ?? ((callback, ms) => {
    const handle = setTimeout(callback, ms)
    return () => clearTimeout(handle)
  })
  const now = options.now ?? (() => Date.now())
  const batchMs = options.batchMs ?? defaultBatchMs
  const createMessageID = options.createMessageID ?? defaultMessageID
  const deviceName = options.deviceName ?? ((deviceID: string) => deviceID)
  const delivery = options.notificationDelivery ?? createNotificationDelivery()

  let state: RemoteStoreState = {
    connection: { kind: "loading" },
    devices: [],
    advertised: [],
    sessions: [],
    catalogs: {},
    usage: emptyUsage(),
    sessionGroups: [],
    sessionQuery: "",
    sessionFilter: "all",
    sessionListStatus: "idle",
    sessionPageLoading: false,
    sessionHasNext: false,
    sessionHasPrevious: false,
    drafts: {},
    workspaces: [],
    workspaceStatus: "idle",
    mutations: [],
    teamCues: [],
    notifications: [],
    transport: { kind: "idle" },
    unhandledEvents: 0,
  }
  let transport: RemoteTransport | undefined
  let activeUpload: AbortController | undefined
  let selectionToken = 0
  let selectionReadyToken: number | undefined
  let selectionFailedToken: number | undefined
  let teamWatching = false
  let teamWatchToken = 0
  let teamRead: { readonly owner: RemoteTransport; readonly token: number; readonly rootID: string; readonly watchToken: number } | undefined
  let pendingTeamRead: { readonly owner: RemoteTransport; readonly token: number; readonly rootID: string; readonly watchToken: number } | undefined
  /**
   * Generation of the backend Session-list context. A list read may publish only
   * while it still describes the generation it was issued for, and every
   * connection change or Session invalidation starts a new generation.
   */
  let sessionsToken = 0
  let sessionPages: { readonly rows: readonly SessionInfoView[]; readonly previous?: string; readonly next?: string }[] = []
  let loadingPageToken: number | undefined
  let statusReadOwner: RemoteTransport | undefined
  let catalogGeneration = 0
  let usageGeneration = 0
  const usageReads = new Map<string, Promise<void>>()
  const catalogReads = new Map<string, Promise<void>>()
  const fileReads = new Map<string, Promise<FileFindResult>>()
  const fileTokens = new Map<string, number>()
  let statusFrameRevision = 0
  let statusBaseline = false
  let statusReloading = false
  let statusReloadTrailing = false
  let lastStatusReload = -Infinity
  let cancelStatusReload: (() => void) | undefined
  let cancelSearch: (() => void) | undefined
  let workspacesToken = 0
  let inventoryRead: { readonly owner: RemoteTransport; trailing: boolean } | undefined
  /**
   * Account generation. A `/api/me` read may apply only while the account context it
   * was issued for still owns the store, so a read that settles after sign-out, a
   * rejected credential, a deliberate disconnect, or a newer read cannot restore an
   * account, a device list, or a connection the user has already dropped.
   */
  let accountToken = 0
  /**
   * Session this connection is registered to stream. The relay tracks client
   * subscriptions per socket and the agent refcounts them, so an unsubscribe is
   * only valid from the connection that registered it.
   */
  let subscribedSessionID: string | undefined
  let sealed: { readonly sessionID: string; readonly parts: Set<string>; readonly covered: Set<string> } | undefined
  let hydration: HydrationWindow | undefined
  /**
   * Live file changes that arrive while a ledger read is pending. The read describes
   * the device's ledger at one instant; a record this client applied after the read was
   * issued is newer, so it is re-applied over the read instead of being replaced by it.
   */
  let fileChangeRead: { readonly sessionID: string; readonly live: FileChangeView[] } | undefined
  let todoRead: { readonly sessionID: string; live?: readonly TodoView[] } | undefined
  const requestReads = new Set<{ readonly sessionID: string; readonly live: { readonly event: unknown; readonly at: number }[] }>()
  let cancelBatch: (() => void) | undefined
  let queued: { readonly sessionID: string; readonly event: unknown }[] = []
  /** Last published transport status, so only a live connection can report a drop. */
  let lastStatusKind: RemoteTransportStatus["kind"] = "idle"
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const setState = (patch: Partial<RemoteStoreState>) => {
    if (Object.hasOwn(patch, "view") && (patch.view === undefined || patch.view?.id !== state.view?.id)) sealed = undefined
    state = { ...state, ...patch }
    notify()
  }

  const clearCatalogs = () => {
    catalogGeneration += 1
    catalogReads.clear()
    fileReads.clear()
    fileTokens.clear()
    setState({ catalogs: {} })
  }

  const clearUsage = () => {
    usageGeneration += 1
    usageReads.clear()
    setState({ usage: emptyUsage() })
  }

  /**
   * Ends the alerts a connection raised. In-app notices and desktop alerts belong
   * to the live events of one connection, so sign-out, a rejected credential, a
   * device switch, and a disconnect all close them. The delivery stays usable, so
   * the next connection raises its own.
   */
  const endAlerts = () => {
    delivery.dispose()
    setState({ notifications: [] })
  }

  /**
   * Ends the stream one connection registered for one session. The unsubscribe goes
   * to that connection: the relay tracks subscriptions per socket and the agent
   * refcounts them, so releasing a session a socket never registered would stop a
   * stream another remote client still wants.
   */
  const releaseSubscription = (owner: RemoteTransport, sessionID: string) => {
    if (subscribedSessionID === sessionID) subscribedSessionID = undefined
    void owner.request("session.unsubscribe", { sessionID })
  }

  const recordCovered = (before: SessionView, after: SessionView) => {
    const retained = new Set(after.messages.map((message) => message.id))
    const removed = before.messages.filter((message) => message.kind === "assistant" && !retained.has(message.id))
    if (removed.length === 0) return
    const current = sealed?.sessionID === before.id ? sealed : { sessionID: before.id, parts: new Set<string>(), covered: new Set<string>() }
    for (const message of removed) {
      current.covered.add(message.id)
      for (const key of sealedPartKeys([message])) current.parts.delete(key)
    }
    sealed = current
  }

  const flush = () => {
    cancelBatch = undefined
    const batch = queued
    queued = []
    if (batch.length === 0) return
    let view = state.view
    let unhandled = state.unhandledEvents
    let teamCues = state.teamCues
    let refreshTeam = false
    let gap = false
    for (const item of batch) {
      if (!view || item.sessionID !== view.id) continue
      const sequence = readEventSequence(item.event)
      const aggregate = readAggregateID(item.event)
      if (aggregate !== undefined && aggregate !== view.id) continue
      const currentSeal = sealed?.sessionID === view.id ? sealed : undefined
      const opened = openedPartKey(item.event)
      if (opened !== undefined) currentSeal?.parts.delete(opened)
      const key = ephemeralPartKey(item.event)
      if (key !== undefined && isEphemeralEvent(item.event) &&
        (currentSeal?.parts.has(key) || currentSeal?.covered.has(ephemeralAssistantID(item.event) ?? ""))) continue
      if (sequence.seq !== undefined && view.watermark !== undefined) {
        // Duplicates below the watermark are dropped. The sequence is durable and
        // per aggregate, so a gap means a lost event and forces a re-read.
        if (sequence.seq <= view.watermark) continue
        if (sequence.seq > view.watermark + 1) gap = true
      }
      if (teamWatching && hydration === undefined && state.activeSessionID === item.sessionID && subscribedSessionID === item.sessionID &&
        state.team?.rootID === item.sessionID) {
        const cue = readTeamCue(item.event)
        if (cue !== undefined && !teamCues.some((entry) => entry.id === cue.id)) {
          teamCues = [...teamCues, cue].slice(-8)
          refreshTeam = true
        }
      }
      // Alerts follow the events that reach the projection: a dropped duplicate
      // raises nothing, and the snapshot paths below never call this loop.
      const category = notificationCategory(item.event)
      if (category !== undefined) delivery.deliver(category, { sessionID: item.sessionID,
        sessionTitle: state.sessions.find((row) => row.id === item.sessionID)?.title ?? state.selectedSessionInfo?.title })
      const at = now()
      const next = applySessionEvent(view, item.event, at)
      if (typeof item.event === "object" && item.event !== null && Reflect.get(item.event, "type") === "session.compaction.ended") recordCovered(view, next)
      unhandled += next.unhandledEvents - view.unhandledEvents
      view = sequence.seq === undefined ? next : { ...next, watermark: sequence.seq }
      const type = typeof item.event === "object" && item.event !== null ? Reflect.get(item.event, "type") : undefined
      const todos = eventTodos(item.event, item.sessionID)
      if (todos !== undefined) {
        state = { ...state, todos }
        if (todoRead?.sessionID === item.sessionID) todoRead.live = todos
      }
      if (type === "permission.v2.asked" || type === "permission.v2.replied" ||
        type === "guardrail.asked" || type === "guardrail.replied" ||
        type === "form.created" || type === "form.replied" || type === "form.cancelled") {
        for (const read of requestReads) {
          if (read.sessionID === item.sessionID) read.live.push({ event: item.event, at })
        }
      }
      if (fileChangeRead !== undefined && fileChangeRead.sessionID === item.sessionID) {
        const change = readFileChangeEvent(item.event)
        if (change !== undefined) fileChangeRead.live.push(change)
      }
      if (hydration !== undefined && hydration.sessionID === item.sessionID && key !== undefined) {
        hydration.events.push(item.event)
        hydration.replayed.add(key)
      }
    }
    state = {
      ...state,
      view,
      selectedSessionInfo: view !== undefined && state.selectedSessionInfo?.id === view.id
        ? { ...state.selectedSessionInfo, agent: view.agent ?? state.selectedSessionInfo.agent,
          model: view.model ?? state.selectedSessionInfo.model, modelLabel: modelLabel(view.model ?? state.selectedSessionInfo.model) ?? state.selectedSessionInfo.modelLabel }
        : state.selectedSessionInfo,
      unhandledEvents: unhandled,
      notifications: delivery.entries(),
      teamCues,
    }
    notify()
    if (gap) void reloadSnapshot(state.activeSessionID, selectionToken, "Events were missed, so history was reloaded.")
    if (refreshTeam && state.team?.status !== "unsupported" && state.team !== undefined && transport !== undefined)
      void loadTeam(transport, selectionToken, state.team.rootID, undefined, true)
  }

  const queueEvent = (sessionID: string, event: unknown) => {
    queued.push({ sessionID, event })
    cancelBatch ??= schedule(flush, batchMs)
  }

  const loadTeam = async (owner: RemoteTransport, token: number, rootID: string, cursor?: string, refresh = false) => {
    if (!teamWatching) return
    const watchToken = teamWatchToken
    if (teamRead !== undefined) {
      if (cursor === undefined && (refresh || teamRead.owner !== owner || teamRead.token !== token ||
        teamRead.rootID !== rootID || teamRead.watchToken !== watchToken)) pendingTeamRead = { owner, token, rootID, watchToken }
      return
    }
    if (token !== selectionToken || !isCurrentConnection(owner) || state.team?.rootID !== rootID || state.transport.kind !== "open") return
    const read = { owner, token, rootID, watchToken }
    teamRead = read
    setState({ team: { ...state.team, rootID, status: cursor === undefined && !(refresh && state.team.status === "ready") ? "loading" : state.team.status,
      pageLoading: cursor !== undefined || refresh } })
    const outcome = await owner.request("session.subagent.list", { sessionID: rootID,
      ...(cursor === undefined ? {} : { input: { cursor } }) })
    if (teamRead === read) teamRead = undefined
    const currentTeam = state.team
    if (teamWatching && watchToken === teamWatchToken && token === selectionToken && isCurrentConnection(owner) &&
      currentTeam?.rootID === rootID && state.transport.kind === "open") {
      if (refresh && currentTeam.status === "ready" && outcome.status !== "ok") {
        setState({ team: { ...currentTeam, pageLoading: false } })
      } else if (outcome.status === "failed" && outcome.error.code === "unknown_operation") {
        setState({ team: { rootID, status: "unsupported", tasks: [], pageLoading: false } })
      } else if (outcome.status !== "ok") {
        setState({ team: { ...currentTeam, status: "error", pageLoading: false } })
      } else {
        const value = outcome.value
        const data = typeof value === "object" && value !== null ? Reflect.get(value, "data") : undefined
        const summary = typeof value === "object" && value !== null ? Reflect.get(value, "summary") : undefined
        const cursors = typeof value === "object" && value !== null ? Reflect.get(value, "cursor") : undefined
        if (!Array.isArray(data) || typeof cursors !== "object" || cursors === null) {
          setState({ team: { ...currentTeam, status: "error", pageLoading: false } })
        } else {
          const rows = data.flatMap((item: unknown) => {
            const task = readTeamTask(item)
            return task?.parentID === rootID ? [task] : []
          })
          const next = Reflect.get(cursors, "next")
          const total = typeof summary === "object" && summary !== null ? Reflect.get(summary, "total") : undefined
          setState({ team: { rootID, status: "ready", tasks: cursor === undefined
            ? rows : [...currentTeam.tasks.filter((item) => !rows.some((row) => row.sessionID === item.sessionID)), ...rows],
            ...(typeof total === "number" && Number.isInteger(total) && total >= 0 ? { total } : {}),
            ...(typeof next === "string" && next.length > 0 ? { next } : {}), pageLoading: false } })
        }
      }
    }
    const pending = pendingTeamRead
    pendingTeamRead = undefined
    if (teamWatching && pending !== undefined && teamRead === undefined && pending.watchToken === teamWatchToken && pending.token === selectionToken &&
      isCurrentConnection(pending.owner) && state.transport.kind === "open" && state.team?.rootID === pending.rootID && state.team.status !== "unsupported")
      void loadTeam(pending.owner, pending.token, pending.rootID)
  }

  /**
   * A signed-in browser with no usable device is not signed out: the account is
   * known, and only the relay side is missing a machine to connect to.
   */
  const deviceConnection = (devices: number): RemoteConnectionState =>
    devices === 0 ? { kind: "no-device-enrolled" } : { kind: "no-device-selected" }

  const connectionFor = (status: RemoteTransportStatus, deviceID: string | undefined): RemoteConnectionState => {
    if (status.kind === "open") return { kind: "connected", deviceName: deviceID ? deviceName(deviceID) : "device" }
    if (status.kind === "connecting" || status.kind === "reconnecting") return { kind: "connecting" }
    if (status.kind === "closed") {
      if (!status.retryable && (status.code === 4401 || status.code === 4403)) return { kind: "signed-out" }
      return { kind: "error", message: status.reason }
    }
    return deviceConnection(state.devices.length)
  }

  /**
   * A replaced connection keeps delivering frames and statuses while its socket
   * finishes closing, so every callback it registered is fenced on being the
   * store's current connection before it may write state.
   */
  const isCurrentConnection = (owner: RemoteTransport) => transport === owner

  const cancelUpload = (reason = "Attachment upload cancelled. Files were not sent.") => {
    if (!activeUpload) return
    activeUpload.abort()
    activeUpload = undefined
    setState({ upload: undefined, uploadError: reason })
  }

  const prepareUploads = async (sessionID: string, files: readonly FileAttachmentInput[] | undefined, token: number) => {
    if (!files?.some((file) => file.uri.startsWith("data:"))) return files
    const owner = transport
    if (!owner || state.transport.kind !== "open" || activeUpload) {
      setState({ uploadError: activeUpload ? "Wait for the current attachment upload to finish." : "Connect to the machine before uploading attachments." })
      return undefined
    }
    const controller = new AbortController()
    activeUpload = controller
    setState({ upload: { sessionID, name: files.find((file) => file.uri.startsWith("data:"))?.name ?? "Attachment", percent: 0 }, uploadError: undefined })
    try {
      const uploaded = await uploadAttachments({ sessionID, files, request: owner.request, signal: controller.signal,
        onProgress: (name, percent) => { if (activeUpload === controller) setState({ upload: { sessionID, name, percent } }) } })
      if (controller.signal.aborted || !isCurrentConnection(owner) || token !== selectionToken || state.activeSessionID !== sessionID)
        throw new Error("Attachment upload lost its selected Session or connection. Files were not sent.")
      return uploaded
    } catch (cause) {
      if (activeUpload === controller) setState({ uploadError: cause instanceof Error ? cause.message : "Attachment upload failed. Files were not sent." })
      return undefined
    } finally {
      if (activeUpload === controller) { activeUpload = undefined; setState({ upload: undefined }) }
    }
  }

  const requestFits = (operation: "session.prompt" | "session.command", sessionID: string, input: Readonly<Record<string, unknown>>, files: readonly FileAttachmentInput[] | undefined) => {
    try {
      assertRemoteRequestSize(operation, sessionID, { ...input, ...(files === undefined ? {} : { files: files.map((file) => file.uri.startsWith("data:") ? { ...file, uri: `ycoding-upload://${"x".repeat(36)}` } : file) }) })
      return true
    } catch (cause) {
      setState({ uploadError: cause instanceof Error ? cause.message : "The remote message is too large to send." })
      return false
    }
  }

  const handleStatus = (owner: RemoteTransport, status: RemoteTransportStatus) => {
    // A status from a replaced connection says nothing about the connection that
    // replaced it: it must not overwrite the live transport, clear the live
    // subscription, raise or end the live alerts, or report a rejected credential.
    if (!isCurrentConnection(owner)) return
    if (status.kind === "closed" || status.kind === "reconnecting") cancelUpload("Attachment upload lost its machine connection. Files were not sent.")
    if (status.kind === "open") {
      cancelStatusReload?.()
      cancelStatusReload = undefined
      statusReloadTrailing = false
      lastStatusReload = -Infinity
      statusReadOwner = undefined
      statusFrameRevision += 1
      statusBaseline = false
      setState({ sessionStatus: undefined })
      if (lastStatusKind !== "idle" && lastStatusKind !== "connecting") { clearCatalogs(); clearUsage() }
    }
    const rejected = status.kind === "closed" && (status.code === 4401 || status.code === 4403)
    // Only a connection that was live can drop: a deliberate close, an initial
    // failure, and a credential rejection are not a device that stopped reporting.
    if (status.kind === "closed" && status.retryable && lastStatusKind === "open") {
      delivery.deliver("device-disconnected")
    }
    lastStatusKind = status.kind
    if (status.kind === "closed") subscribedSessionID = undefined
    if (status.kind === "closed") setState({ teamCues: [], ...(state.team === undefined ? {} : { team: { ...state.team, status: "loading", pageLoading: false } }) })
    if (rejected && status.kind === "closed") {
      clearCatalogs()
      clearUsage()
      sessionPages = []
      // Relay authorization can reject one revoked device while the browser account
      // remains valid. Tear down only that device, then let the authoritative account
      // answer decide whether the browser is truly signed out.
      sessionsToken += 1
      workspacesToken += 1
      setState({
        transport: status,
        connection: deviceConnection(state.devices.filter((device) => device.status === "active" && device.online).length),
        activeDeviceID: undefined,
        advertised: [],
        sessions: [],
        sessionGroups: [],
        selectedWorkspaceID: undefined,
        sessionListStatus: "idle",
        sessionPageLoading: false,
        sessionHasNext: false,
        sessionHasPrevious: false,
        selectedSessionInfo: undefined,
        team: undefined,
        teamCues: [],
        drafts: {},
        workspaces: [],
        workspaceStatus: "idle",
        workspaceError: undefined,
        sessionCreation: undefined,
        activeSessionID: undefined,
        view: undefined,
        notice: status.reason,
      })
      endAlerts()
      void api.load()
      return
    }
    setState({ transport: status, connection: connectionFor(status, state.activeDeviceID), notifications: delivery.entries() })
  }

  const request = async (
    mutation: PendingMutation,
    options: { readonly sessionID?: string } = {},
  ): Promise<RemoteRequestOutcome> => {
    const active = transport
    if (!active) {
      finishMutation(mutation.id, "failed", "The relay connection is not open")
      return { status: "unavailable", reason: "not-connected" }
    }
    setState({ mutations: [...state.mutations.filter((entry) => entry.id !== mutation.id), mutation] })
    const outcome = await active.request(mutation.operation, { sessionID: options.sessionID, input: mutation.input })
    if (outcome.status === "ok") {
      setState({ mutations: state.mutations.filter((entry) => entry.id !== mutation.id) })
      return outcome
    }
    if (outcome.status === "unknown") {
      finishMutation(
        mutation.id,
        "unknown",
        `Outcome unknown: ${outcome.error.message}. Retry only if you want to send it again.`,
      )
      return outcome
    }
    if (outcome.status === "failed") {
      finishMutation(mutation.id, "failed", outcome.error.message)
      return outcome
    }
    finishMutation(mutation.id, "failed", "The relay connection is not open")
    return { status: "unavailable", reason: "not-connected" }
  }

  const finishMutation = (id: string, mutationState: PendingMutation["state"], detail: string) => {
    setState({
      mutations: state.mutations.map((entry) => (entry.id === id ? { ...entry, state: mutationState, detail } : entry)),
    })
  }

  /**
   * Applies a canonical snapshot. A body that is not a session projection, or a
   * snapshot below the projection's durable watermark, is refused so the visible
   * transcript is never erased or rewound.
   */
  const applySnapshot = (sessionID: string, payload: unknown, base?: SessionView): { readonly view: SessionView; readonly coveredAssistantIDs: readonly string[]; readonly parentID?: string } | "invalid" | "stale" => {
    const snapshot = readSnapshot(payload)
    if (snapshot === undefined) return "invalid"
    if (base?.watermark !== undefined && snapshot.watermark !== undefined && snapshot.watermark < base.watermark) {
      return "stale"
    }
    const view: SessionView = {
      ...(base ?? createSessionView(sessionID)),
      id: sessionID,
      messages: snapshot.messages,
      ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
      ...(snapshot.agent === undefined ? {} : { agent: snapshot.agent }),
      ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
      ...(snapshot.archived === undefined ? {} : { archived: snapshot.archived }),
      watermark: snapshot.watermark,
      ...(snapshot.sourceEpoch === undefined ? {} : { sourceEpoch: snapshot.sourceEpoch }),
    }
    return { view, coveredAssistantIDs: snapshot.coveredAssistantIDs, parentID: snapshot.parentID }
  }

  const applyEvent = (view: SessionView, event: unknown, replaying: boolean): SessionView => {
    const aggregate = readAggregateID(event)
    if (aggregate !== undefined && aggregate !== view.id) return view
    const currentSeal = sealed?.sessionID === view.id ? sealed : undefined
    const opened = openedPartKey(event)
    if (opened !== undefined) currentSeal?.parts.delete(opened)
    const key = ephemeralPartKey(event)
    if (key !== undefined && isEphemeralEvent(event) &&
      (currentSeal?.covered.has(ephemeralAssistantID(event) ?? "") || (!replaying && currentSeal?.parts.has(key)))) return view
    const next = applySessionEvent(view, event, now())
    if (typeof event === "object" && event !== null && Reflect.get(event, "type") === "session.compaction.ended") recordCovered(view, next)
    return next
  }

  const loadTodos = async (owner: RemoteTransport, sessionID: string, token: number) => {
    const read = { sessionID, live: undefined as readonly TodoView[] | undefined }
    todoRead = read
    setState({ todos: undefined })
    try {
      const outcome = await owner.request("session.todo.list", { sessionID, timeoutMs: 5_000 }).catch(() => undefined)
      if (token !== selectionToken || !isCurrentConnection(owner) || state.activeSessionID !== sessionID || todoRead !== read) return
      const loaded = outcome?.status === "ok" ? readTodos(typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined) : undefined
      setState({ todos: read.live ?? loaded })
    } finally { if (todoRead === read) todoRead = undefined }
  }

  const loadSessionReads = async (sessionID: string, token: number, notice?: string) => {
    const active = transport
    if (!active) return
    const pending = { sessionID, live: [] as FileChangeView[] }
    const requestsDuringRead = { sessionID, live: [] as { readonly event: unknown; readonly at: number }[] }
    fileChangeRead = pending
    requestReads.add(requestsDuringRead)
    void loadTodos(active, sessionID, token)
    try {
      const [autonomy, permissions, guardrails, forms, changes] = await Promise.all([
        active.request("session.autonomy.get", { sessionID }),
        active.request("session.permission.list", { sessionID }),
        active.request("session.guardrail.request.list", { sessionID }),
        active.request("session.form.list", { sessionID }),
        active.request("session.fileChange.list", { sessionID }),
      ])
      if (token !== selectionToken || state.activeSessionID !== sessionID) return
      const view = state.view
      if (!view) return
      const requests = [
        ...(permissions.status === "ok" ? readPermissionRequests(permissions.value, now()) : view.requests.filter((request) => request.kind === "permission")),
        ...(guardrails.status === "ok" ? readGuardrailRequests(guardrails.value, now()) : view.requests.filter((request) => request.kind === "guardrail")),
        ...(forms.status === "ok" ? readFormRequests(forms.value, now()).filter((request) => request.form.sessionID === sessionID) : view.requests.filter((request) => request.kind === "form")),
      ]
      const withRequests = replaceRequests(view, requestsDuringRead.live.reduce<readonly PendingRequestView[]>(
        (current, item) => applySessionEvent({ ...view, requests: current }, item.event, item.at).requests,
        requests,
      ))
      // The ledger read is authoritative except for records that arrived while it was
      // pending: those describe a later instant than the read does.
      const withChanges =
        changes.status === "ok"
          ? replaceFileChanges(withRequests, mergeFileChanges(readFileChangeList(changes.value), pending.live))
          : withRequests
      const failure = [autonomy, permissions, guardrails, forms, changes].find(
        (outcome) => outcome.status !== "ok",
      )
      setState({
        view:
          autonomy.status === "ok"
            ? { ...withChanges, autonomy: readAutonomy(autonomy.value) ?? withChanges.autonomy }
            : withChanges,
        ...(notice === undefined
          ? failure === undefined
            ? {}
            : { notice: describeOutcome(failure, "Session state") }
          : { notice }),
      })
    } finally {
      if (fileChangeRead === pending) fileChangeRead = undefined
      requestReads.delete(requestsDuringRead)
    }
  }

  /**
   * Reads one explicit page of a shell's captured output for the session that owns it.
   * One user request reads one page: there is no automatic paging loop, so a running
   * command whose tail is an incomplete character is reported as stalled for the user to
   * retry rather than polled. A page is applied only while the selection that opened the
   * read still owns the view, so a late page cannot land on another session or connection.
   */
  const loadShellOutputPage = async (shellID: string) => {
    const sessionID = state.activeSessionID
    const view = state.view
    if (sessionID === undefined || view === undefined) return
    const token = selectionToken
    if (shellOutputFetchFor(view, shellID)?.state === "loading") return
    const from = shellOutputFor(view, shellID)?.cursor ?? 0
    setState({ view: withShellOutputFetch(view, shellID, { state: "loading" }) })
    const active = transport
    if (active === undefined) {
      setState({ view: withShellOutputFetch(view, shellID, { state: "error", message: notConnectedPage }) })
      return
    }
    const outcome = await active.request("session.shell.output", {
      sessionID,
      input: { shellID, cursor: from, limit: shellOutputPageLimit },
    })
    if (token !== selectionToken || state.activeSessionID !== sessionID) return
    const current = state.view
    if (current === undefined) return
    if (outcome.status !== "ok") {
      setState({ view: withShellOutputFetch(current, shellID, { state: "error", message: singlePageFailure(outcome) }) })
      return
    }
    const page = readShellOutputPage(outcome.value)
    if (page === undefined) {
      setState({ view: withShellOutputFetch(current, shellID, { state: "error", message: unreadablePage }) })
      return
    }
    // A settled page that added nothing while the device still holds bytes is a held
    // incomplete character. It is a state for the user to retry, never a reason to loop.
    const fetch: ShellOutputFetch =
      page.cursor <= from && page.cursor < page.size ? { state: "stalled" } : { state: "idle" }
    setState({ view: withShellOutputPage(current, shellID, page, from, fetch) })
  }

  /**
   * Reads the canonical synchronization snapshot for one session. The returned
   * outcome is meaningful only to the caller's ownership guard, which reports a
   * failure or applies the snapshot after verifying that the selection that opened
   * this read still owns the view.
   */
  const readSnapshotPayload = async (sessionID: string): Promise<RemoteRequestOutcome | undefined> => {
    const active = transport
    if (!active) return undefined
    return active.request("session.snapshot", { sessionID })
  }

  const reloadSnapshot = async (
    sessionID: string | undefined,
    token: number,
    notice?: string,
  ): Promise<"applied" | "refused" | "unavailable"> => {
    if (sessionID === undefined || state.activeSessionID !== sessionID) return "unavailable"
    const owned: HydrationWindow = { sessionID, events: [], replayed: new Set() }
    hydration = owned
    try {
      const outcome = await readSnapshotPayload(sessionID)
      if (token !== selectionToken || state.activeSessionID !== sessionID || outcome === undefined) {
        return "unavailable"
      }
      if (outcome.status !== "ok") {
        setState({ notice: describeOutcome(outcome, "Session history") })
        return "unavailable"
      }
      const applied = applySnapshot(sessionID, outcome.value, state.view)
      if (applied === "invalid") {
        setState({ notice: notice ?? "The session snapshot was not readable, so the current history is kept." })
        return "refused"
      }
      if (applied === "stale") {
        setState({ notice: notice ?? "An older session snapshot arrived and was ignored." })
        return "refused"
      }
      sealed = { sessionID, parts: new Set(sealedPartKeys(applied.view.messages)), covered: new Set(applied.coveredAssistantIDs) }
      let view = applied.view
      for (const event of owned.events) view = applyEvent(view, event, true)
      owned.replayed.forEach((key) => sealed?.parts.delete(key))
      setState({ view, ...(notice === undefined ? {} : { notice }) })
      const owner = transport
      if (teamWatching && owner !== undefined && state.team !== undefined) void loadTeam(owner, token, state.team.rootID, undefined, true)
      return "applied"
    } finally {
      if (hydration === owned) hydration = undefined
    }
  }

  const listFailure = (outcome: Exclude<RemoteRequestOutcome, { status: "ok" }>, label: string): Pick<RemoteStoreState, "connection"> =>
    outcome.status === "failed" && outcome.error.code === "agent_unavailable"
      ? { connection: { kind: "offline", deviceName: deviceName(state.activeDeviceID ?? "device") } }
      : { connection: { kind: "error", message: describeOutcome(outcome, label) } }

  const recoveredConnection = (owner: RemoteTransport): Partial<Pick<RemoteStoreState, "connection">> =>
    state.connection.kind === "offline" || state.connection.kind === "error"
      ? { connection: connectionFor(owner.status(), state.activeDeviceID) }
      : {}

  const sortSessions = (rows: readonly SessionInfoView[]) => [...new Map(rows.map((row) => [row.id, row])).values()].sort((left, right) => {
    if (left.running !== right.running) return left.running ? -1 : 1
    if (left.pinnedAt !== undefined && right.pinnedAt === undefined) return -1
    if (left.pinnedAt === undefined && right.pinnedAt !== undefined) return 1
    if (left.pinnedAt !== undefined && right.pinnedAt !== undefined && left.pinnedAt !== right.pinnedAt) return left.pinnedAt - right.pinnedAt
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id.localeCompare(right.id)
  })

  const publishSessionStatus = (status: NonNullable<RemoteStoreState["sessionStatus"]>) => {
    const rows = sessionPages.map((page) => ({ ...page, rows: page.rows.map((row) => ({ ...row,
      running: status.running.has(row.id), attention: status.attention.has(row.id),
    })) }))
    sessionPages = rows
    setState({ sessionStatus: status, sessions: sortSessions(rows.flatMap((page) => page.rows)) })
  }

  const readSessionStatus = async (owner: RemoteTransport) => {
    if (statusReadOwner === owner) return
    statusReadOwner = owner
    const revision = statusFrameRevision
    const outcome = await owner.request("session.status")
    if (!isCurrentConnection(owner) || revision !== statusFrameRevision || outcome.status !== "ok" ||
      (statusBaseline && state.sessionStatus !== undefined)) return
    const status = parseSessionStatus(outcome.value)
    if (status !== undefined) {
      statusBaseline = true
      publishSessionStatus(status)
    }
  }

  const applyStatusFrame = (owner: RemoteTransport, frame: { readonly running: readonly string[]; readonly attention: readonly string[] }) => {
    if (!isCurrentConnection(owner)) return
    statusFrameRevision += 1
    const status = { running: new Set(frame.running), attention: new Set(frame.attention) }
    const previous = state.sessionStatus
    const changed = previous === undefined || previous.running.size !== status.running.size || previous.attention.size !== status.attention.size ||
      [...status.running].some((id) => !previous.running.has(id)) || [...status.attention].some((id) => !previous.attention.has(id))
    if (statusBaseline && previous !== undefined) {
      for (const id of status.attention) if (!previous.attention.has(id)) delivery.deliver("approval-requested", { sessionID: id, sessionTitle: state.sessions.find((row) => row.id === id)?.title })
      for (const id of previous.running) if (!status.running.has(id)) delivery.deliver("agent-completed", { sessionID: id, sessionTitle: state.sessions.find((row) => row.id === id)?.title })
    }
    statusBaseline = true
    publishSessionStatus(status)
    setState({ notifications: delivery.entries() })
    if (changed && [...status.running, ...status.attention].some((id) => !state.sessions.some((row) => row.id === id))) void reloadStatusFirstPage(owner)
  }

  const reloadStatusFirstPage = async (owner: RemoteTransport) => {
    if (!isCurrentConnection(owner) || state.selectedWorkspaceID === undefined) return
    if (statusReloading) { statusReloadTrailing = true; return }
    if (performance.now() - lastStatusReload < 5_000) {
      statusReloadTrailing = true
      cancelStatusReload ??= schedule(() => {
        cancelStatusReload = undefined
        if (!statusReloadTrailing || !isCurrentConnection(owner)) return
        statusReloadTrailing = false
        void reloadStatusFirstPage(owner)
      }, Math.max(1, Math.ceil(5_000 - (performance.now() - lastStatusReload))))
      return
    }
    statusReloading = true
    lastStatusReload = performance.now()
    try {
      if (loadingPageToken === sessionsToken) statusReloadTrailing = true
      else await loadSessions(sessionsToken)
    } finally {
      statusReloading = false
      if (statusReloadTrailing) {
        statusReloadTrailing = false
        void reloadStatusFirstPage(owner)
      }
    }
  }

  const loadSessions = async (token: number, cursor?: string, direction: "next" | "previous" = "next") => {
    const active = transport
    const workspace = state.selectedWorkspaceID
    if (!active || workspace === undefined || loadingPageToken === token) return
    loadingPageToken = token
    setState({ sessionPageLoading: cursor !== undefined, ...(cursor === undefined ? { sessionListStatus: "loading" as const } : {}) })
    const listed = await active.request("session.list", { input: {
        workspace,
        limit: sessionPageSize,
        order: "active",
        parentID: null,
        searchFields: "summary",
        ...(state.sessionQuery.trim() === "" ? {} : { search: state.sessionQuery.trim() }),
        ...(state.sessionFilter === "all" ? {} : { status: state.sessionFilter }),
        ...(cursor === undefined ? {} : { cursor }),
      } })
    if (loadingPageToken === token) loadingPageToken = undefined
    if (token !== sessionsToken || !isCurrentConnection(active) || workspace !== state.selectedWorkspaceID) return
    if (listed.status !== "ok") {
      setState({ ...listFailure(listed, "Session list"), sessionListStatus: "error", sessionPageLoading: false })
      return
    }
    const rows = readSessionInfoList(listed.value).flatMap((entry) => {
      const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined
      const info = readSessionInfo(entry,
        state.sessionStatus === undefined || typeof id !== "string" ? {} : { running: state.sessionStatus.running.has(id), attention: state.sessionStatus.attention.has(id) })
      return info ? [info] : []
    })
    const value = typeof listed.value === "object" && listed.value !== null ? listed.value : undefined
    const cursors = value === undefined ? undefined : Reflect.get(value, "cursor")
    const next = typeof cursors === "object" && cursors !== null ? Reflect.get(cursors, "next") : undefined
    const previous = typeof cursors === "object" && cursors !== null ? Reflect.get(cursors, "previous") : undefined
    if (cursor !== undefined && (direction === "next" ? next === cursor : previous === cursor)) {
      setState({ sessionListStatus: "error", sessionPageLoading: false,
        connection: { kind: "error", message: "The device repeated a Session list cursor." } })
      return
    }
    const page = { rows, ...(typeof next === "string" && next.length > 0 ? { next } : {}),
      ...(typeof previous === "string" && previous.length > 0 ? { previous } : {}) }
    sessionPages = cursor === undefined ? [page] : direction === "next"
      ? [...sessionPages, page].slice(-retainedSessionPages)
      : [page, ...sessionPages].slice(0, retainedSessionPages)
    const sessions = sortSessions(sessionPages.flatMap((item) => item.rows))
    setState({
      ...recoveredConnection(active),
      sessions,
      advertised: sessions.map((session) => session.id),
      selectedSessionInfo: sessions.find((session) => session.id === state.activeSessionID) ?? state.selectedSessionInfo,
      sessionListStatus: "ready",
      sessionPageLoading: false,
      sessionHasPrevious: sessionPages[0]?.previous !== undefined,
      sessionHasNext: sessionPages.at(-1)?.next !== undefined,
    })
    if (cursor === undefined) void readSessionStatus(active)
  }

  const loadSessionGroups = async (token: number) => {
    const owner = transport
    if (owner === undefined) return
    const outcome = await owner.request("workspace.list", { input: { sessionsOnly: true } })
    if (token !== sessionsToken || !isCurrentConnection(owner)) return
    if (outcome.status !== "ok") {
      setState({ ...listFailure(outcome, "Session workspaces"), sessionListStatus: "error" })
      return
    }
    const groups = readWorkspaces(outcome.value)
    if (groups === undefined) {
      setState({ sessionListStatus: "error", connection: { kind: "error", message: "The device returned unreadable Session workspaces." } })
      return
    }
    const selectedWorkspaceID = groups.some((group) => group.id === state.selectedWorkspaceID)
      ? state.selectedWorkspaceID : groups[0]?.id
    const sameWorkspace = selectedWorkspaceID === state.selectedWorkspaceID
    if (!sameWorkspace) sessionPages = []
    setState({ ...recoveredConnection(owner), sessionGroups: groups, selectedWorkspaceID,
      ...(sameWorkspace ? {} : { sessions: [], advertised: [], sessionHasNext: false, sessionHasPrevious: false }),
      sessionListStatus: selectedWorkspaceID === undefined ? "ready" : "loading" })
    if (selectedWorkspaceID !== undefined) await loadSessions(token)
  }

  const refreshSessionGroups = async (owner: RemoteTransport) => {
    if (inventoryRead?.owner === owner) {
      inventoryRead.trailing = true
      return
    }
    const read = { owner, trailing: false }
    inventoryRead = read
    do {
      read.trailing = false
      await loadSessionGroups(sessionsToken)
    } while (read.trailing && isCurrentConnection(owner))
    if (inventoryRead === read) inventoryRead = undefined
  }

  const selectSession = async (sessionID: string) => {
    if (activeUpload) cancelUpload("Attachment upload was cancelled by Session selection. Files were not sent.")
    const active = transport
    // One selection owns the view; a superseded selection never writes state again.
    const token = ++selectionToken
    selectionReadyToken = undefined
    selectionFailedToken = undefined
    const info = state.sessions.find((session) => session.id === sessionID) ??
      (state.selectedSessionInfo?.id === sessionID ? state.selectedSessionInfo : { id: sessionID, title: sessionID, updatedAt: 0, archived: false })
    const rootID = info.parentID ?? sessionID
    setState({ activeSessionID: sessionID, selectedSessionInfo: info,
      view: createSessionView(sessionID), team: teamWatching ? { rootID, status: "loading", tasks: [], pageLoading: false } : undefined,
      teamCues: [], todos: undefined, notice: undefined })
    if (!active) {
      selectionFailedToken = token
      if (teamWatching) setState({ team: { rootID, status: "error", tasks: [], pageLoading: false } })
      return
    }
    // Subscribe before the snapshot so events during the read are queued and then
    // reconciled against the snapshot watermark instead of being lost.
    const subscribed = await active.request("session.subscribe", { sessionID })
    if (subscribed.status !== "ok") {
      // The selection left the previous session behind, so its stream ends even when
      // this one is not available.
      if (subscribedSessionID !== undefined && subscribedSessionID !== sessionID) {
        releaseSubscription(active, subscribedSessionID)
      }
      if (token !== selectionToken || state.activeSessionID !== sessionID) return
      selectionFailedToken = token
      setState({ notice: "This session is not available from the connected device.",
        ...(teamWatching ? { team: { rootID, status: "error" as const, tasks: [], pageLoading: false } } : {}) })
      return
    }
    if (token !== selectionToken || state.activeSessionID !== sessionID) {
      // A superseded selection registered a subscription this store no longer shows.
      releaseSubscription(active, sessionID)
      return
    }
    const previous = subscribedSessionID
    subscribedSessionID = sessionID
    if (previous !== undefined && previous !== sessionID) releaseSubscription(active, previous)
    const owned: HydrationWindow = { sessionID, events: [], replayed: new Set() }
    hydration = owned
    try {
      const outcome = await readSnapshotPayload(sessionID)
      if (token !== selectionToken || state.activeSessionID !== sessionID || outcome === undefined) return
      if (outcome.status !== "ok") {
        selectionFailedToken = token
        setState({ notice: describeOutcome(outcome, "Session history"),
          ...(teamWatching ? { team: { rootID, status: "error" as const, tasks: [], pageLoading: false } } : {}) })
        return
      }
      const applied = applySnapshot(sessionID, outcome.value, state.view)
      if (applied === "invalid") {
        selectionFailedToken = token
        setState({ notice: "The session snapshot was not readable, so the current history is kept.",
          ...(teamWatching ? { team: { rootID, status: "error" as const, tasks: [], pageLoading: false } } : {}) })
        return
      }
      if (applied === "stale") {
        selectionFailedToken = token
        setState({ notice: "An older session snapshot arrived and was ignored.",
          ...(teamWatching ? { team: { rootID, status: "error" as const, tasks: [], pageLoading: false } } : {}) })
        return
      }
      sealed = { sessionID, parts: new Set(sealedPartKeys(applied.view.messages)), covered: new Set(applied.coveredAssistantIDs) }
      let view = applied.view
      for (const event of owned.events) view = applyEvent(view, event, true)
      owned.replayed.forEach((key) => sealed?.parts.delete(key))
      selectionReadyToken = token
      const teamRootID = applied.parentID ?? state.selectedSessionInfo?.parentID ?? sessionID
      setState({ view, team: teamWatching ? { rootID: teamRootID, status: "loading", tasks: [], pageLoading: false } : undefined,
        selectedSessionInfo: state.selectedSessionInfo?.id === sessionID
        ? { ...state.selectedSessionInfo, title: view.title ?? state.selectedSessionInfo.title, agent: view.agent ?? state.selectedSessionInfo.agent,
            model: view.model ?? state.selectedSessionInfo.model, modelLabel: modelLabel(view.model) ?? state.selectedSessionInfo.modelLabel,
            ...(applied.parentID === undefined ? {} : { parentID: applied.parentID }) }
        : state.selectedSessionInfo })
      if (teamWatching) void loadTeam(active, token, teamRootID)
    } finally {
      if (hydration === owned) hydration = undefined
    }
    await loadSessionReads(sessionID, token)
  }

  const reloadMessages = async () => {
    const sessionID = state.activeSessionID
    if (sessionID === undefined) return
    await reloadSnapshot(sessionID, selectionToken)
  }

  const loadWorkspaces = async () => {
    const active = transport
    const token = ++workspacesToken
    setState({ workspaces: [], workspaceStatus: "loading", workspaceError: undefined })
    if (active === undefined || state.transport.kind !== "open" || state.connection.kind === "offline") {
      setState({ workspaceStatus: "error", workspaceError: "Connect to a machine to load its workspaces." })
      return
    }
    const outcome = await active.request("workspace.list")
    if (!isCurrentConnection(active) || token !== workspacesToken) return
    if (outcome.status !== "ok") {
      setState({ workspaceStatus: "error", workspaceError: describeOutcome(outcome, "Workspaces") })
      return
    }
    const workspaces = readWorkspaces(outcome.value)
    if (workspaces === undefined) {
      setState({ workspaceStatus: "error", workspaceError: "The device returned an unreadable workspace list." })
      return
    }
    setState({ workspaces, workspaceStatus: "ready" })
  }

  const createSession = async (attempt: SessionCreation, reconcile: boolean) => {
    const active = transport
    if (active === undefined || state.transport.kind !== "open" || state.connection.kind === "offline" || state.activeDeviceID !== attempt.deviceID) {
      setState({ sessionCreation: { ...attempt, status: attempt.status === "unknown" ? "unknown" : "failed", message: "Connect to the same machine before creating this session." } })
      return undefined
    }
    setState({ sessionCreation: { ...attempt, status: "creating", message: undefined } })
    const owns = () => isCurrentConnection(active) && state.sessionCreation?.id === attempt.id
    const accept = async (value: unknown) => {
      const data = typeof value === "object" && value !== null ? Reflect.get(value, "data") : undefined
      const session = readSessionInfo(data)
      const parentID = typeof data === "object" && data !== null ? Reflect.get(data, "parentID") : undefined
      if (!session || session.id !== attempt.id || session.directory !== attempt.workspace.directory || session.projectID !== attempt.workspace.projectID || parentID !== undefined) {
        setState({ sessionCreation: { ...attempt, status: "unknown", message: "The returned session does not match this workspace. Check Sessions before retrying." } })
        return undefined
      }
      await api.selectSession(session.id)
      if (attempt.prompt !== undefined) {
        const sent = "command" in attempt.prompt
          ? await api.runCommand({ ...attempt.prompt, delivery: "steer" })
          : await api.sendPrompt({ ...attempt.prompt, delivery: "steer" })
        if (sent === false) {
          setState({ sessionCreation: { ...attempt, status: "failed", message: state.uploadError ?? "The first message could not be sent. Retry to submit it to this Session." } })
          return undefined
        }
      }
      setState({ sessionCreation: undefined })
      return session.id
    }
    if (reconcile) {
      const existing = await active.request("session.get", { sessionID: attempt.id })
      if (!owns()) return undefined
      if (existing.status === "ok") return accept(existing.value)
      if (existing.status !== "failed" || existing.error.code !== "session_not_allowed") {
        setState({ sessionCreation: { ...attempt, status: "unknown", message: describeOutcome(existing, "Session check") } })
        return undefined
      }
    }
    const outcome = await active.request("session.create", { input: { id: attempt.id, workspace: attempt.workspace.id,
      ...(attempt.agent === undefined ? {} : { agent: attempt.agent }), ...(attempt.model === undefined ? {} : { model: attempt.model }) } })
    if (!owns()) return undefined
    if (outcome.status === "ok") return accept(outcome.value)
    setState({ sessionCreation: { ...attempt, status: outcome.status === "unknown" ? "unknown" : "failed", message: describeOutcome(outcome, "Session creation") } })
    return undefined
  }

  const prepareSelection = async (sessionID: string, token: number, input: { readonly agent?: string; readonly model?: ModelRefView }) => {
    const view = state.view
    if (input.agent !== undefined && input.agent !== view?.agent) {
      if (!await api.switchAgent(input.agent)) return false
      if (token !== selectionToken || state.activeSessionID !== sessionID) return false
    }
    if (input.model !== undefined && (input.model.id !== view?.model?.id || input.model.providerID !== view.model?.providerID || input.model.variant !== view.model?.variant)) {
      if (!await api.switchModel(input.model)) return false
      if (token !== selectionToken || state.activeSessionID !== sessionID) return false
    }
    return true
  }

  const api: RemoteStore = {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    signInURL: (provider, redirectAfter = "/remote/") => signInURL(provider, redirectAfter),
    load: async () => {
      const token = ++accountToken
      const me = await options.http.me()
      // A read that settles after sign-out, a rejected credential, a deliberate
      // disconnect, or a newer read describes an account this store no longer shows.
      if (token !== accountToken) return
      if (!me.ok) {
        if (me.status === 401 || me.status === 403) {
          // The account answer is authoritative: the browser session is gone, so the
          // connection that session authorized ends with it. The signed-out state is
          // published before the teardown, so no device-carrying state paints.
          setState({
            connection: { kind: "signed-out" },
            owner: undefined,
            devices: [],
            advertised: [],
            sessions: [],
            activeSessionID: undefined,
            view: undefined,
          })
          api.disconnect()
          return
        }
        if (me.kind === "unexpected-body") {
          // A static deployment answers API paths with the application document.
          setState({
            connection: { kind: "unavailable", reason: "not-configured" },
            owner: undefined,
            devices: [],
            sessions: [],
            advertised: [],
            activeSessionID: undefined,
            view: undefined,
          })
          return
        }
        // A failed refresh keeps the connection the workspace already resolved and
        // reports the failure. Only an account with no answer yet takes the failure as
        // its own state, so a read that really failed is never hidden behind the
        // pending state.
        setState(
          state.connection.kind === "loading"
            ? { connection: { kind: "error", message: me.message }, notice: me.message }
            : { notice: me.message },
        )
        return
      }
      const devices = me.value.devices
      const selected = devices.find((device) => device.id === state.activeDeviceID)
      if (selected?.status === "active" && !selected.online) {
        // The disconnect clears the list, so the selected device's last list is restored read-only.
        const sessions = state.sessions
        const sessionGroups = state.sessionGroups
        const selectedWorkspaceID = state.selectedWorkspaceID
        const drafts = state.drafts
        const creation = state.sessionCreation
        setState({ owner: { id: me.value.user.id, expiresAt: me.value.session.expiresAt }, devices })
        api.disconnect()
        setState({
          activeDeviceID: selected.id,
          sessions,
          sessionGroups,
          selectedWorkspaceID,
          sessionListStatus: "ready",
          sessionPageLoading: false,
          sessionHasNext: false,
          sessionHasPrevious: false,
          drafts,
          sessionCreation: creation?.status === "creating"
            ? { ...creation, status: "unknown", message: "The machine went offline before creation settled. Check or retry this session explicitly." }
            : creation,
          connection: { kind: "offline", deviceName: selected.name },
          transport: { kind: "idle" },
        })
        return
      }
      const activeDevices = devices.filter((device) => device.status === "active" && device.online)
      const first = activeDevices[0]
      const stillPresent = activeDevices.some((device) => device.id === state.activeDeviceID)
      const adoptOnlyDevice = !stillPresent && first !== undefined && activeDevices.length === 1
      setState({
        owner: { id: me.value.user.id, expiresAt: me.value.session.expiresAt },
        devices,
        connection: stillPresent
          ? state.connection
          : adoptOnlyDevice
            ? { kind: "connecting" }
            : deviceConnection(devices.filter((device) => device.status === "active").length),
      })
      if (adoptOnlyDevice && first !== undefined) api.connect(first.id)
      else if (!stillPresent && state.activeDeviceID !== undefined) api.disconnect()
    },
    logout: async () => {
      // The account answer this browser held is replaced by an explicit sign-out, so a
      // read that is still in flight must not restore it afterwards.
      accountToken += 1
      clearCatalogs()
      clearUsage()
      await options.http.logout()
      api.disconnect()
      setState({ owner: undefined, devices: [], sessions: [], advertised: [], activeSessionID: undefined, view: undefined,
        team: undefined, teamCues: [], connection: { kind: "signed-out" }, notice: "Signed out." })
    },
    createEnrollment: () => options.http.createEnrollment(),
    revokeDevice: async (deviceID) => {
      const result = await options.http.revokeDevice(deviceID)
      if (result.ok) {
        await api.load()
      }
      return result
    },
    connect: (deviceID) => {
      const drafts = state.activeDeviceID === deviceID ? state.drafts : {}
      const creation = state.sessionCreation?.deviceID === deviceID ? state.sessionCreation : undefined
      transport?.close(1000, "switching device")
      cancelSearch?.()
      sessionPages = []
      clearCatalogs()
      clearUsage()
      cancelStatusReload?.()
      cancelStatusReload = undefined
      statusReadOwner = undefined
      statusBaseline = false
      statusReloading = false
      statusReloadTrailing = false
      lastStatusReload = -Infinity
      // The new socket starts with no subscriptions, no alerts, and no list of its own.
      subscribedSessionID = undefined
      queued = []
      sessionsToken += 1
      workspacesToken += 1
      setState({ activeDeviceID: deviceID, sessions: [], sessionStatus: undefined, advertised: [], activeSessionID: undefined, view: undefined, notice: undefined, drafts,
        team: undefined, teamCues: [], todos: undefined,
        sessionGroups: [], selectedWorkspaceID: undefined, selectedSessionInfo: undefined, sessionQuery: "", sessionFilter: "all",
        sessionListStatus: "idle", sessionPageLoading: false, sessionHasNext: false, sessionHasPrevious: false,
        workspaces: [], workspaceStatus: "idle", workspaceError: undefined,
        sessionCreation: creation?.status === "creating" ? { ...creation, status: "unknown", message: "The connection changed before creation settled. Check or retry this session explicitly." } : creation,
      })
      endAlerts()
      const created = options.createTransport(deviceID, {
        onStatus: (status) => handleStatus(created, status),
        onSessionStatus: (status) => applyStatusFrame(created, status),
        onSessions: () => {
          if (!isCurrentConnection(created)) return
          cancelSearch?.()
          cancelSearch = undefined
          sessionsToken += 1
          setState({ sessionListStatus: "loading" })
          void refreshSessionGroups(created)
        },
        onEvent: (sessionID, event) => {
          if (!isCurrentConnection(created)) return
          queueEvent(sessionID, event)
        },
        onReconnect: () => {
          if (!isCurrentConnection(created)) return
          void reloadAfterReconnect(created)
        },
      })
      transport = created
      created.connect()
    },
    disconnect: () => {
      cancelUpload("Attachment upload was cancelled by disconnection. Files were not sent.")
      // The device choice the account reads describe ends here, so a read that is
      // still in flight cannot reconnect a device the user has dropped.
      accountToken += 1
      clearCatalogs()
      clearUsage()
      cancelStatusReload?.()
      cancelStatusReload = undefined
      statusReloadTrailing = false
      transport?.close(1000, "disconnected")
      cancelSearch?.()
      sessionPages = []
      transport = undefined
      subscribedSessionID = undefined
      queued = []
      sessionsToken += 1
      workspacesToken += 1
      setState({
        activeDeviceID: undefined,
        advertised: [],
        sessions: [],
        sessionGroups: [],
        selectedWorkspaceID: undefined,
        selectedSessionInfo: undefined,
        sessionListStatus: "idle",
        sessionPageLoading: false,
        sessionHasNext: false,
        sessionHasPrevious: false,
        drafts: {},
        workspaces: [],
        workspaceStatus: "idle",
        workspaceError: undefined,
        sessionCreation: undefined,
        activeSessionID: undefined,
        view: undefined,
        team: undefined, todos: undefined,
        teamCues: [],
        connection: state.owner === undefined ? { kind: "signed-out" } : deviceConnection(state.devices.length),
      })
      endAlerts()
    },
    selectSession,
    watchTeam: (enabled) => {
      if (teamWatching === enabled) return
      teamWatching = enabled
      teamWatchToken += 1
      pendingTeamRead = undefined
      if (!enabled) {
        setState({ team: undefined, teamCues: [] })
        return
      }
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return
      const rootID = state.selectedSessionInfo?.parentID ?? sessionID
      setState({ team: { rootID, status: selectionFailedToken === selectionToken ? "error" : "loading", tasks: [], pageLoading: false }, teamCues: [] })
      if (selectionReadyToken === selectionToken && transport !== undefined) void loadTeam(transport, selectionToken, rootID)
    },
    loadMoreTeam: async () => {
      const owner = transport
      const team = state.team
      if (!teamWatching || owner === undefined || team?.status !== "ready" || team.next === undefined || team.pageLoading || state.transport.kind !== "open") return
      await loadTeam(owner, selectionToken, team.rootID, team.next)
    },
    selectWorkspace: (workspaceID) => {
      if (state.transport.kind !== "open" || state.connection.kind === "offline") return
      if (!state.sessionGroups.some((group) => group.id === workspaceID) || state.selectedWorkspaceID === workspaceID) return
      cancelSearch?.()
      sessionsToken += 1
      sessionPages = []
      setState({ selectedWorkspaceID: workspaceID, sessions: [], advertised: [], sessionListStatus: "loading", sessionHasNext: false, sessionHasPrevious: false })
      void loadSessions(sessionsToken)
    },
    searchSessions: (query, filter = state.sessionFilter) => {
      if (state.transport.kind !== "open" || state.connection.kind === "offline") return
      if (state.sessionQuery === query && state.sessionFilter === filter) return
      cancelSearch?.()
      sessionsToken += 1
      sessionPages = []
      setState({ sessionQuery: query, sessionFilter: filter, sessions: [], advertised: [], sessionListStatus: "loading", sessionHasNext: false, sessionHasPrevious: false })
      cancelSearch = schedule(() => {
        cancelSearch = undefined
        void loadSessions(sessionsToken)
      }, 250)
    },
    nextSessionsPage: async () => {
      const cursor = sessionPages.at(-1)?.next
      if (cursor !== undefined && state.sessionListStatus === "ready" && state.transport.kind === "open") await loadSessions(sessionsToken, cursor)
    },
    previousSessionsPage: async () => {
      const cursor = sessionPages[0]?.previous
      if (cursor !== undefined && state.sessionListStatus === "ready" && state.transport.kind === "open") await loadSessions(sessionsToken, cursor, "previous")
    },
    setDraft: (sessionID, text) => {
      if (sessionID !== state.activeSessionID) return
      setState({ drafts: { ...state.drafts, [sessionID]: text } })
    },
    loadWorkspaces,
    loadUsage: async (options = {}) => {
      const owner = transport
      if (owner === undefined || state.transport.kind !== "open") return
      const reads = ["providers", "summary"] as const
      await Promise.all(reads.map(async (key) => {
        const prior = usageReads.get(key)
        if (prior) {
          await prior
          if (!options.refresh) return
        }
        if (!isCurrentConnection(owner) || state.transport.kind !== "open") return
        if (!options.refresh && state.usage[key].status !== "idle" && state.usage[key].status !== "error") return
        const generation = usageGeneration
        setState({ usage: { ...state.usage, [key]: { ...state.usage[key], status: "loading" } } })
        const read = (async () => {
          const outcome = await owner.request(key === "providers" ? "usage.providers" : "usage.summary", key === "providers" && options.refresh ? { input: { refresh: true } } : {})
          if (generation !== usageGeneration || !isCurrentConnection(owner) || state.transport.kind !== "open") return
          const raw = outcome.status === "ok" && typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
          const data = key === "providers" ? readUsageProviders(raw) : readUsageMetrics(raw)
          const status = outcome.status === "failed" && outcome.error.code === "unknown_operation" ? "unsupported" : data === undefined ? "error" : "ready"
          setState({ usage: { ...state.usage, [key]: { status, ...(status === "ready" ? { data } : {}),
            ...(status === "error" ? { message: outcome.status === "ok" ? "The device returned unreadable usage data." : describeOutcome(outcome, "Usage") } : {}) } } })
        })()
        usageReads.set(key, read)
        await read
        if (usageReads.get(key) === read) usageReads.delete(key)
      }))
    },
    loadUsageReport: async (input) => {
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) return
      const owner = transport
      if (owner === undefined || state.transport.kind !== "open") return
      const key = reportKey(input)
      if (state.usage.reports[key]?.status === "ready" || state.usage.reports[key]?.status === "unsupported") return
      if (usageReads.has(key)) return usageReads.get(key)
      const generation = usageGeneration
      setState({ usage: { ...state.usage, reports: { ...state.usage.reports, [key]: { status: "loading" } } } })
      const read = (async () => {
        const outcome = await owner.request("usage.report", { input })
        if (generation !== usageGeneration || !isCurrentConnection(owner) || state.transport.kind !== "open") return
        const raw = outcome.status === "ok" && typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
        const data = readUsageReport(raw, input.group)
        const status = outcome.status === "failed" && outcome.error.code === "unknown_operation" ? "unsupported" : data === undefined ? "error" : "ready"
        setState({ usage: { ...state.usage, reports: { ...state.usage.reports, [key]: { status,
          ...(data !== undefined && status === "ready" ? { data } : {}),
          ...(status === "error" ? { message: outcome.status === "ok" ? "The device returned an unreadable usage report." : describeOutcome(outcome, "Usage report") } : {}),
        } } } })
      })()
      usageReads.set(key, read)
      await read
      if (usageReads.get(key) === read) usageReads.delete(key)
    },
    loadCatalog: async (target, options = {}) => {
      const owner = transport
      if (owner === undefined || state.transport.kind !== "open") return
      const key = catalogKey(target)
      if (!options.refresh && state.catalogs[key] !== undefined) {
        await catalogReads.get(key)
        return
      }
      if (catalogReads.has(key)) {
        await catalogReads.get(key)
        if (!options.refresh) return
      }
      if (!isCurrentConnection(owner) || state.transport.kind !== "open") return
      const generation = catalogGeneration
      setState({ catalogs: { ...state.catalogs, [key]: { status: "loading", agents: [], models: [], commands: [], skills: [], references: [], resources: [] } } })
      const read = (async () => {
        const outcome = await owner.request("sessionID" in target ? "session.catalog" : "workspace.catalog",
          "sessionID" in target ? { sessionID: target.sessionID } : { input: { workspace: target.workspaceID } })
        if (generation !== catalogGeneration || !isCurrentConnection(owner)) return
        const value = outcome.status === "ok" ? readCatalog(outcome.value) : undefined
        const previous = state.catalogs[key]
        if (previous?.status !== "loading") return
        setState({ catalogs: { ...state.catalogs, [key]: value ?? { ...previous,
          status: outcome.status === "failed" && outcome.error.code === "unknown_operation" ? "unsupported" : "error",
          message: outcome.status === "ok" ? "The device returned an unreadable catalog." : describeOutcome(outcome, "Catalog"),
        } } })
      })()
      catalogReads.set(key, read)
      await read
      if (catalogReads.get(key) === read) catalogReads.delete(key)
    },
    findFiles: async (target, query, limit) => {
      if (!query.trim()) return { status: "failed", message: "Enter a file search query." }
      const key = catalogKey(target)
      const token = (fileTokens.get(key) ?? 0) + 1
      fileTokens.set(key, token)
      await fileReads.get(key)
      if (fileTokens.get(key) !== token) return { status: "failed", message: "Search superseded by a newer query." }
      const owner = transport
      if (owner === undefined || state.transport.kind !== "open") return { status: "failed", message: notConnectedPage }
      const generation = catalogGeneration
      const read = owner.request("sessionID" in target ? "session.file.find" : "workspace.file.find", {
        ...( "sessionID" in target ? { sessionID: target.sessionID } : {}),
        input: { ...( "workspaceID" in target ? { workspace: target.workspaceID } : {}), query, ...(limit === undefined ? {} : { limit }) },
      }).then((outcome): FileFindResult => {
        if (generation !== catalogGeneration || !isCurrentConnection(owner) || fileTokens.get(key) !== token)
          return { status: "failed", message: "Search superseded by a newer query or connection." }
        if (outcome.status !== "ok") return { status: outcome.status === "failed" && outcome.error.code === "unknown_operation" ? "unsupported" : "failed", message: describeOutcome(outcome, "File search") }
        const files = readFileFind(outcome.value)
        return files === undefined ? { status: "failed", message: "The device returned unreadable file matches." } : { status: "ok", files }
      })
      fileReads.set(key, read)
      const result = await read
      if (fileReads.get(key) === read) {
        fileReads.delete(key)
        if (fileTokens.get(key) === token) fileTokens.delete(key)
      }
      return result
    },
    createSession: async (input) => {
      if (state.sessionCreation?.status === "creating" || state.sessionCreation?.status === "unknown") return undefined
      const workspace = state.workspaces.find((item) => item.id === input.workspaceID)
      const deviceID = state.activeDeviceID
      if (!workspace || !deviceID || state.workspaceStatus !== "ready") {
        setState({ notice: "Select an available workspace from the connected machine." })
        return undefined
      }
      return createSession({ id: options.createSessionID?.() ?? `ses_${crypto.randomUUID().replaceAll("-", "")}`, deviceID, workspace, status: "creating",
        ...(input.agent === undefined ? {} : { agent: input.agent }), ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }) }, false)
    },
    retrySessionCreation: async () => {
      const attempt = state.sessionCreation
      if (!attempt || attempt.status === "creating") return undefined
      return createSession(attempt, true)
    },
    dismissSessionCreation: () => {
      if (state.sessionCreation?.status !== "creating") setState({ sessionCreation: undefined })
    },
    reloadMessages,
    loadShellOutputPage,
    switchModel: async (model) => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return false
      const outcome = await request({ id: `model_${now()}_${createMessageID()}`, kind: "model", label: "Switch model", state: "sending",
        sessionID, operation: "session.switchModel", input: { model } }, { sessionID })
      return outcome.status === "ok"
    },
    switchAgent: async (agent) => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return false
      const outcome = await request({ id: `agent_${now()}_${createMessageID()}`, kind: "agent", label: "Switch agent", state: "sending",
        sessionID, operation: "session.switchAgent", input: { agent } }, { sessionID })
      return outcome.status === "ok"
    },
    sendPrompt: async (input) => {
      const sessionID = state.activeSessionID
      const token = selectionToken
      const text = input.text.trim()
      if (sessionID === undefined) {
        setState({ notice: "Select a session before sending a prompt." })
        return false
      }
      if (text.length === 0 && !input.files?.length && !input.agents?.length && !input.skills?.length) return false
      if (!requestFits("session.prompt", sessionID, { text, delivery: input.delivery, agents: input.agents }, input.files)) return false
      const files = await prepareUploads(sessionID, input.files, token)
      if (input.files !== undefined && files === undefined) return false
      if (!await prepareSelection(sessionID, token, input) || token !== selectionToken || state.activeSessionID !== sessionID) return false
      for (const skill of input.skills ?? []) {
        const id = createMessageID()
        const outcome = await request({ id, kind: "skill", label: `Load ${skill}`, state: "sending", sessionID,
          operation: "session.skill", input: { id, skill, resume: false } }, { sessionID })
        if (outcome.status !== "ok" || token !== selectionToken || state.activeSessionID !== sessionID) return false
      }
      const messageID = createMessageID()
      const view = state.view ?? createSessionView(sessionID)
      const optimistic: RemoteMessageView = {
        kind: "user",
        id: messageID,
        text,
        delivery: input.delivery,
        state: "pending",
        created: now(),
      }
      setState({
        view: { ...view, messages: [...view.messages, optimistic] },
        mutations: [
          ...state.mutations,
          {
            id: messageID,
            kind: "prompt",
            label: input.delivery === "queue" ? "Queued prompt" : "Prompt",
            state: "sending",
            sessionID,
            operation: "session.prompt",
            input: { id: messageID, text, delivery: input.delivery,
              ...(input.files === undefined ? {} : { files }), ...(input.agents === undefined ? {} : { agents: input.agents }),
              ...(input.skills?.length ? { resume: false } : {}) },
          },
        ],
      })
      const promptInput = { id: messageID, text, delivery: input.delivery,
        ...(input.files === undefined ? {} : { files }), ...(input.agents === undefined ? {} : { agents: input.agents }),
        ...(input.skills?.length ? { resume: false } : {}) }
      const outcome = await request(
        {
          id: messageID,
          kind: "prompt",
          label: input.delivery === "queue" ? "Queued prompt" : "Prompt",
          state: "sending",
          sessionID,
          operation: "session.prompt",
          input: promptInput,
        },
        { sessionID },
      )
      if (!input.skills?.length || outcome.status !== "ok" || token !== selectionToken || state.activeSessionID !== sessionID) return true
      await request({ id: messageID, kind: "prompt", label: "Wake prompt", state: "sending", sessionID,
        operation: "session.prompt", input: { ...promptInput, resume: true } }, { sessionID })
      return true
    },
    runCommand: async (input) => {
      const sessionID = state.activeSessionID
      const token = selectionToken
      if (sessionID === undefined || !input.command.trim()) return false
      if (!requestFits("session.command", sessionID, { command: input.command, arguments: input.arguments, delivery: input.delivery, agents: input.agents }, input.files)) return false
      const files = await prepareUploads(sessionID, input.files, token)
      if (input.files !== undefined && files === undefined) return false
      if (!await prepareSelection(sessionID, token, input) || token !== selectionToken || state.activeSessionID !== sessionID) return false
      const id = createMessageID()
      await request({ id, kind: "command", label: `/${input.command}`, state: "sending", sessionID, operation: "session.command",
        input: { id, command: input.command, delivery: input.delivery,
          ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
          ...(input.files === undefined ? {} : { files }), ...(input.agents === undefined ? {} : { agents: input.agents }) },
      }, { sessionID })
      return true
    },
    cancelUpload: () => cancelUpload(),
    retryMutation: async (id) => {
      const mutation = state.mutations.find((entry) => entry.id === id)
      if (!mutation) return
      await request({ ...mutation, state: "sending", detail: undefined }, { sessionID: mutation.sessionID })
    },
    dismissMutation: (id) => {
      setState({ mutations: state.mutations.filter((entry) => entry.id !== id) })
    },
    dismissNotification: (id) => {
      delivery.dismiss(id)
      setState({ notifications: delivery.entries() })
    },
    markNotificationsRead: () => {
      delivery.markRead()
      setState({ notifications: delivery.entries() })
    },
    clearNotifications: () => {
      delivery.clear()
      setState({ notifications: delivery.entries() })
    },
    interrupt: async () => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return
      await request(
        {
          id: `interrupt_${now()}`,
          kind: "interrupt",
          label: "Interrupt",
          state: "sending",
          sessionID,
          operation: "session.interrupt",
          input: {},
        },
        { sessionID },
      )
    },
    replyPermission: async (id, reply) => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return
      const outcome = await request(
        {
          id: `permission_${id}_${reply}`,
          kind: "permission",
          label: `Permission ${reply}`,
          state: "sending",
          sessionID,
          operation: "session.permission.reply",
          input: { requestID: id, reply },
        },
        { sessionID },
      )
      settleRequest(id, outcome)
    },
    replyGuardrail: async (id, reply) => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return
      const pending = state.view?.requests.find((entry) => entry.id === id)
      if (pending && !canReplyToRequest(pending, sessionID)) {
        setState({ notice: "That review belongs to another session in this family. Open that session to answer it." })
        return
      }
      const outcome = await request(
        {
          id: `guardrail_${id}_${reply}`,
          kind: "guardrail",
          label: `Guardrail ${reply}`,
          state: "sending",
          sessionID,
          operation: "session.guardrail.reply",
          input: { requestID: id, reply },
        },
        { sessionID },
      )
      settleRequest(id, outcome)
    },
    replyForm: async (formID, answer) => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined || !ownsPendingForm(formID, sessionID)) return
      const token = selectionToken
      const outcome = await request(
        {
          id: `form_${formID}_${now()}`,
          kind: "form",
          label: "Answer",
          state: "sending",
          sessionID,
          operation: "session.form.reply",
          input: { formID, answer },
        },
        { sessionID },
      )
      if (token === selectionToken && state.activeSessionID === sessionID) settleRequest(formID, outcome)
    },
    cancelForm: async (formID) => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined || !ownsPendingForm(formID, sessionID)) return
      const token = selectionToken
      const outcome = await request({ id: `form_cancel_${formID}_${now()}`, kind: "form", label: "Cancel form", state: "sending", sessionID, operation: "session.form.cancel", input: { formID } }, { sessionID })
      if (token === selectionToken && state.activeSessionID === sessionID) settleRequest(formID, outcome)
    },
    setYolo: async (level) => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return
      const outcome = await request(
        {
          id: `autonomy_${level}_${now()}`,
          kind: "autonomy",
          label: level === 0 ? "Standard mode" : `YOLO ${level}`,
          state: "sending",
          sessionID,
          operation: "session.autonomy.set",
          input: { yolo: level },
        },
        { sessionID },
      )
      applyAutonomyResponse(outcome, sessionID)
    },
    setGoal: async (text) => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return
      const outcome = await request(
        {
          id: `goal_${now()}`,
          kind: "goal",
          label: "Set goal",
          state: "sending",
          sessionID,
          operation: "session.goal.set",
          input: { goal: text },
        },
        { sessionID },
      )
      applyAutonomyResponse(outcome, sessionID)
    },
    stopGoal: async () => {
      const sessionID = state.activeSessionID
      if (sessionID === undefined) return
      const outcome = await request(
        {
          id: `goal_stop_${now()}`,
          kind: "goal",
          label: "Stop goal",
          state: "sending",
          sessionID,
          operation: "session.goal.stop",
          input: { goal: null },
        },
        { sessionID },
      )
      applyAutonomyResponse(outcome, sessionID)
    },
    setAutonomy: (autonomy) => {
      const view = state.view
      if (!view) return
      setState({ view: { ...view, autonomy } })
    },
    dispose: () => {
      cancelUpload("Attachment upload was cancelled by workspace disposal. Files were not sent.")
      clearCatalogs()
      clearUsage()
      teamWatching = false
      teamWatchToken += 1
      pendingTeamRead = undefined
      sealed = undefined
      cancelSearch?.()
      cancelBatch?.()
      cancelStatusReload?.()
      cancelStatusReload = undefined
      sessionPages = []
      cancelBatch = undefined
      transport?.close(1000, "disposed")
      transport = undefined
      subscribedSessionID = undefined
      setState({ drafts: {}, workspaces: [], workspaceStatus: "idle", workspaceError: undefined, sessionCreation: undefined,
        team: undefined, teamCues: [] })
      endAlerts()
      listeners.clear()
    },
  }

  /**
   * Drops a request row once its reply settled. The agent also publishes a reply
   * event; removing locally keeps the row from accepting a second answer while
   * that event is in flight.
   */
  const ownsPendingForm = (formID: string, sessionID: string) => {
    if (state.view?.id === sessionID && state.view.requests.some((request) => request.kind === "form" && request.id === formID && request.form.sessionID === sessionID)) return true
    setState({ notice: "This form is no longer pending or belongs to another session." })
    return false
  }

  const settleRequest = (requestID: string, outcome: RemoteRequestOutcome) => {
    if (outcome.status !== "ok") return
    const view = state.view
    if (view === undefined) return
    setState({ view: replaceRequests(view, view.requests.filter((request) => request.id !== requestID)) })
  }

  const applyAutonomyResponse = (outcome: RemoteRequestOutcome, sessionID: string) => {
    if (outcome.status !== "ok") return
    const autonomy = readAutonomyFromResponse(outcome.value)
    if (autonomy === undefined) return
    const view = state.view
    // The response belongs to the session that asked. A selection that replaced it
    // owns the view now and must not take this autonomy.
    if (view === undefined || view.id !== sessionID) return
    setState({ view: { ...view, autonomy }, notice: undefined })
  }

  return api

  async function reloadAfterReconnect(owner: RemoteTransport) {
    const token = selectionToken
    // A device switch during the reload leaves a different connection owning the
    // store, so this one must not resubscribe, reload, or report again.
    if (!isCurrentConnection(owner)) return
    const sessionID = state.activeSessionID
    if (sessionID === undefined) {
      setState({ notice: "Reconnected." })
      return
    }
    const resubscribed = await owner.request("session.subscribe", { sessionID })
    if (!isCurrentConnection(owner)) return
    if (state.activeSessionID !== sessionID) {
      // A superseded reload registered a subscription this store no longer shows, so
      // release exactly what this connection just registered.
      if (resubscribed.status === "ok") releaseSubscription(owner, sessionID)
      return
    }
    // A new socket starts unsubscribed, so ownership follows this response and only
    // while the same selection still owns the view.
    subscribedSessionID = resubscribed.status === "ok" ? sessionID : undefined
    const reloaded = await reloadSnapshot(sessionID, token)
    if (!isCurrentConnection(owner)) return
    await loadSessionReads(sessionID, token)
    if (!isCurrentConnection(owner)) return
    if (reloaded === "applied") {
      setState({ notice: "Reconnected. Session history reloaded read-only." })
      return
    }
    const remaining = state.notice
    setState({
      notice:
        remaining === undefined
          ? "Reconnected. The connection is live again."
          : `Reconnected. ${remaining}`,
    })
  }

}

function readUsageProviders(value: unknown): readonly UsageProvider[] | undefined {
  if (!Array.isArray(value)) return undefined
  const statuses = ["available", "stale", "unsupported", "unauthorized", "error"]
  const units = ["percent", "usd", "requests", "tokens", "count"]
  if (!value.every((item) => typeof item === "object" && item !== null && typeof item.providerID === "string" &&
    typeof item.label === "string" && statuses.includes(item.status) && typeof item.source === "string" &&
    typeof item.stability === "string" && Number.isFinite(item.updatedAt) && !Number.isNaN(new Date(item.updatedAt).getTime()) &&
    (item.profile === undefined || typeof item.profile === "string") && (item.message === undefined || typeof item.message === "string") &&
    Array.isArray(item.windows) && item.windows.every((window: Record<string, unknown>) =>
      typeof window.id === "string" && typeof window.label === "string" && units.includes(String(window.unit)) &&
      [window.used, window.limit, window.remaining, window.resetAt, window.periodSeconds].every((n) => n === undefined || typeof n === "number" && Number.isFinite(n) && n >= 0) &&
      (window.unlimited === undefined || typeof window.unlimited === "boolean")))) return undefined
  return value as UsageProvider[]
}

function readUsageMetrics(value: unknown): UsageSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const fields = ["logical", "physical", "helpers", "continued", "fallback"]
  const tokens = Reflect.get(value, "tokens")
  if (fields.some((field) => !Number.isFinite(Reflect.get(value, field)) || Reflect.get(value, field) < 0) ||
    typeof tokens !== "object" || tokens === null ||
    ["input", "output", "reasoning"].some((field) => !Number.isFinite(Reflect.get(tokens, field))) ||
    typeof Reflect.get(tokens, "cache") !== "object" || Reflect.get(tokens, "cache") === null ||
    ["read", "write"].some((field) => !Number.isFinite(Reflect.get(Reflect.get(tokens, "cache"), field))) ||
    (Reflect.get(value, "cost") !== undefined && (!Number.isFinite(Reflect.get(value, "cost")) || Reflect.get(value, "cost") < 0)) ||
    (Reflect.get(value, "costProvenance") !== undefined && !["recorded", "current_catalog"].includes(Reflect.get(value, "costProvenance")))) return undefined
  return value as UsageSummary
}

function readUsageReport(value: unknown, group: UsageReportInput["group"]): UsageReport | undefined {
  if (typeof value !== "object" || value === null || Reflect.get(value, "group") !== group || !Array.isArray(Reflect.get(value, "rows")) ||
    !Number.isInteger(Reflect.get(value, "rowCount")) || Reflect.get(value, "rowCount") < 0 ||
    (Reflect.get(value, "nextOffset") !== undefined && (!Number.isInteger(Reflect.get(value, "nextOffset")) || Reflect.get(value, "nextOffset") < 0)) ||
    readUsageMetrics(Reflect.get(value, "total")) === undefined) return undefined
  const rows: unknown[] = Reflect.get(value, "rows")
  if (!rows.every((row) => typeof row === "object" && row !== null && typeof Reflect.get(row, "key") === "string" &&
    typeof Reflect.get(row, "label") === "string" && readUsageMetrics(row) !== undefined &&
    ((Reflect.get(row, "cost") === undefined) === (Reflect.get(row, "costProvenance") === undefined)))) return undefined
  return value as UsageReport
}

export function readSessionInfo(value: unknown, options: { readonly running?: boolean; readonly attention?: boolean } = {}): SessionInfoView | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined
  if (id === undefined) return undefined
  const time = typeof record.time === "object" && record.time !== null ? (record.time as Record<string, unknown>) : {}
  const location = typeof record.location === "object" && record.location !== null
    ? record.location as Record<string, unknown>
    : {}
  const model = readModelRef(record.model)
  return {
    id,
    ...(typeof record.parentID === "string" && record.parentID.length > 0 ? { parentID: record.parentID } : {}),
    title: typeof record.title === "string" && record.title.length > 0 ? record.title : id,
    ...(typeof record.projectID === "string" && record.projectID.length > 0 ? { projectID: record.projectID } : {}),
    ...(typeof location.directory === "string" && location.directory.length > 0 ? { directory: location.directory } : {}),
    ...(typeof record.agent === "string" ? { agent: record.agent } : {}),
    ...(model === undefined ? {} : { model, modelLabel: modelLabel(model) }),
    updatedAt: typeof time.updated === "number" ? time.updated : 0,
    archived: typeof time.archived === "number",
    ...(typeof time.pinned === "number" ? { pinnedAt: time.pinned } : {}),
    ...(options.running === undefined ? {} : { running: options.running }),
    ...(options.attention === undefined ? {} : { attention: options.attention }),
  }
}

function readTeamTask(value: unknown): TeamTaskView | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const sessionID = Reflect.get(value, "sessionID")
  const parentID = Reflect.get(value, "parentID")
  const description = Reflect.get(value, "description")
  const agent = Reflect.get(value, "agent")
  const state = Reflect.get(value, "state")
  const revision = Reflect.get(value, "revision")
  const time = Reflect.get(value, "time")
  const updatedAt = typeof time === "object" && time !== null ? Reflect.get(time, "updated") : undefined
  if (typeof sessionID !== "string" || sessionID.length === 0 || typeof parentID !== "string" || parentID.length === 0 ||
    typeof description !== "string" || (agent !== undefined && typeof agent !== "string") ||
    (state !== "starting" && state !== "running" && state !== "waiting" && state !== "cancelling" &&
      state !== "cancelled" && state !== "completed" && state !== "failed" && state !== "lost") ||
    typeof revision !== "number" || !Number.isInteger(revision) || revision < 0 ||
    typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined
  const model = readModelRef(Reflect.get(value, "model"))
  return { sessionID, parentID, description, ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { modelLabel: modelLabel(model) }), state, revision, updatedAt }
}

export function parseSessionStatus(payload: unknown): RemoteStoreState["sessionStatus"] {
  if (typeof payload !== "object" || payload === null) return undefined
  const body = Reflect.get(payload, "data") ?? payload
  if (typeof body !== "object" || body === null) return undefined
  const running = Reflect.get(body, "running")
  const attention = Reflect.get(body, "attention")
  if (!Array.isArray(running) || !running.every((id) => typeof id === "string" && id.startsWith("ses_")) ||
    !Array.isArray(attention) || !attention.every((id) => typeof id === "string" && id.startsWith("ses_"))) return undefined
  return { running: new Set(running), attention: new Set(attention) }
}

export function readAutonomyFromResponse(value: unknown): SessionAutonomyView | undefined {
  return readAutonomy(value)
}

/**
 * A shell-output page read that failed. An explicit unsupported operation is the device
 * answering for itself; every other failure reports the answer it gave, including an
 * unsettled read, which never diagnoses a version mismatch on its own.
 */
function singlePageFailure(outcome: Exclude<RemoteRequestOutcome, { status: "ok" }>): string {
  if (outcome.status === "failed" && outcome.error.code === "unknown_operation")
    return "This device does not offer paged terminal output."
  return describeOutcome(outcome, "Terminal output")
}

function describeOutcome(outcome: Exclude<RemoteRequestOutcome, { status: "ok" }>, label: string): string {
  if (outcome.status === "unavailable")
    return outcome.reason === "not-connected"
      ? `${label} is unavailable while the relay connection is closed.`
      : `${label} is unavailable because the relay request limit was reached.`
  return `${label}: ${outcome.error.message}`
}

function defaultMessageID(): string {
  return `msg_${Date.now().toString(36)}${Math.floor(Math.random() * 1_000_000).toString(36)}`
}

function readWorkspaces(payload: unknown): readonly RemoteWorkspaceInfo[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const data = Reflect.get(payload, "data")
  if (!Array.isArray(data)) return undefined
  const workspaces = data.flatMap((value: unknown) => {
    if (typeof value !== "object" || value === null) return []
    const id = Reflect.get(value, "id")
    const projectID = Reflect.get(value, "projectID")
    const directory = Reflect.get(value, "directory")
    const name = Reflect.get(value, "name")
    const workspaceID = Reflect.get(value, "workspaceID")
    if (typeof id !== "string" || id.length === 0 || typeof projectID !== "string" || projectID.length === 0 || typeof directory !== "string" || directory.length === 0 || (name !== undefined && typeof name !== "string") || (workspaceID !== undefined && typeof workspaceID !== "string")) return []
    return [{ id, projectID, directory, ...(workspaceID === undefined ? {} : { workspaceID }), ...(name === undefined ? {} : { name }) }]
  })
  if (workspaces.length !== data.length || new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) return undefined
  return workspaces
}
