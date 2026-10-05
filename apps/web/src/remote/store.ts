import { RemoteLimits, isRemoteLatencySample, isWellFormedBase64, noticeSequence, type CreateEnrollmentResponse, type RemoteDeviceInfo, type RemoteFamilyActivity, parseNoticePage, type RemoteLatencySample, type RemoteNotice, type RemoteNoticeFrame, type RemoteNoticePage, type RemoteOperation, type RemoteWorkspaceInfo } from "@ycoding-ai/remote"
import { catalogKey, readCatalog, readFileFind, type AgentAttachmentInput, type CatalogTarget, type CatalogView, type FileAttachmentInput, type FileFindResult } from "./catalog"
import { signInURL, type RemoteHttp, type RemoteHttpResult, type SignInProvider } from "./http"
import {
  createNotificationDelivery,
  notificationCategory,
  type NotificationDelivery,
  type RemoteNotificationView,
} from "./notifications"
import { readRememberedMachine, writeRememberedMachine, type NotificationCategory } from "./preferences"
import { browserStorage, type StorageLike } from "../lib/storage"
import {
  applySessionEvent,
  clearAssistantRetry,
  canReplyToRequest,
  guardrailContextAvailable,
  createSessionView,
  ephemeralAssistantID,
  ephemeralPartKey,
  hasCompactionCheckpoint,
  isGoalSteerAdmission,
  modelLabel,
  openedPartKey,
  readAggregateID,
  readAutonomy,
  readCompactionHistory,
  readCapturedChangesPage,
  readEventSequence,
  readModelRef,
  readPendingInputs,
  readShellOutputPage,
  carryStreamedText,
  sealedPartKeys,
  streamedPartText,
  readGuardrailRequests,
  readPermissionRequests,
  readProjectedMessage,
  readFormRequests,
  readSessionInfoList,
  readSnapshot,
  readTeamCue,
  replaceRequests,
  reconcilePendingInputs,
  shellOutputFetchFor,
  shellOutputFor,
  withShellOutputFetch,
  withShellOutputPage,
  visibleTranscript,
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
import { createLatencyDiagnostics } from "./latency"
import type { RemoteConnectionState } from "./view-model"
import type { QueryClient } from "@tanstack/solid-query"
import { Store, batch } from "@tanstack/solid-store"
import { describeOutcome } from "./outcome"
import { createRemoteQueryClient, readWorkspaces, remoteKeys, type QueryScope, type RemoteLink } from "./queries"
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

function reuseTodos(previous: readonly TodoView[] | undefined, next: readonly TodoView[]): readonly TodoView[] {
  const items = next.map((todo, index) => {
    const old = previous?.[index]
    return old !== undefined && old.content === todo.content && old.status === todo.status && old.priority === todo.priority ? old : todo
  })
  return previous !== undefined && previous.length === items.length && items.every((todo, index) => todo === previous[index]) ? previous : items
}

function eventTodos(event: unknown, sessionID: string): readonly TodoView[] | undefined {
  if (typeof event !== "object" || event === null || Reflect.get(event, "type") !== "todo.updated") return undefined
  const data: unknown = Reflect.get(event, "data")
  if (typeof data !== "object" || data === null || Reflect.get(data, "sessionID") !== sessionID) return undefined
  return readTodos(Reflect.get(data, "todos"))
}

export type SessionInfoView = {
  readonly id: string
  readonly parentID?: string
  readonly title: string
  readonly projectID?: string
  readonly directory?: string
  readonly workspaceID?: string
  readonly agent?: string
  readonly model?: ModelRefView
  readonly modelLabel?: string
  readonly updatedAt: number
  readonly activeAt?: number
  readonly archived: boolean
  readonly pinnedAt?: number
  /** Absent when the connection cannot report active sessions. */
  readonly running?: boolean
  readonly attention?: boolean
  readonly failed?: boolean
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
  readonly startedAt?: number
  readonly question?: { readonly id: string; readonly text: string }
  readonly cacheHitRatio?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly contextTotal?: number
  readonly contextLimit?: number
  readonly cost?: number
  readonly tokens?: number
}

type TeamView = {
  readonly rootID: string
  readonly status: "loading" | "ready" | "unsupported" | "error"
  readonly tasks: readonly TeamTaskView[]
  readonly total?: number
  readonly activeTotal?: number
  readonly economicsUnsupported?: boolean
  readonly economicsLoading?: boolean
  readonly next?: string
  readonly pageLoading: boolean
  readonly refreshing?: boolean
  readonly shells: readonly { readonly id: string; readonly ownerID: string; readonly command: string; readonly status: "running" | "exited" | "timeout" | "memory-limit" | "killed"; readonly startedAt: number; readonly completedAt?: number }[]
  readonly shellTruncated?: boolean
  readonly shellStatus: "loading" | "ready" | "unsupported" | "error"
  readonly sideChats: readonly { readonly id: string; readonly title: string; readonly updatedAt: number }[]
  readonly sideChatStatus: "loading" | "ready" | "unsupported" | "error"
  readonly sideChatNext?: string
  readonly sideChatLoading: boolean
}

function emptyTeam(rootID: string, status: TeamView["status"]): TeamView {
  return { rootID, status, tasks: [], pageLoading: false, shells: [], shellStatus: "loading", sideChats: [], sideChatStatus: "loading", sideChatLoading: false }
}

export type PendingMutation = {
  readonly id: string
  readonly kind: "prompt" | "command" | "compact" | "skill" | "model" | "agent" | "interrupt" | "permission" | "guardrail" | "form" | "autonomy" | "goal"
  readonly label: string
  readonly state: "sending" | "unknown" | "failed"
  readonly phase?: "preparing" | "admitting"
  readonly detail?: string
  readonly sessionID: string
  readonly operation: RemoteOperation
  readonly input: Readonly<Record<string, unknown>>
  readonly created?: number
}

export type MutationToast = { readonly id: string; readonly label: string; readonly state: "failed" | "unknown"; readonly detail?: string; readonly sessionID: string }

type SessionCreation = {
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
  readonly carouselSessions?: readonly (SessionInfoView & { readonly workspaceName: string })[]
  readonly carouselStatus?: "idle" | "loading" | "ready" | "error"
  readonly sessionStatus?: { readonly running: ReadonlySet<string>; readonly attention: ReadonlySet<string>; readonly outstanding: ReadonlySet<string>; readonly failed: ReadonlySet<string> }
  readonly catalogs: Readonly<Record<string, CatalogView>>
  readonly sessionGroups: readonly RemoteWorkspaceInfo[]
  readonly selectedWorkspaceID?: string
  readonly sessionQuery: string
  readonly sessionFilter: "all" | "running" | "idle"
  readonly sessionListStatus: "idle" | "loading" | "ready" | "error"
  readonly sessionRowsStale?: boolean
  readonly sessionPageLoading: boolean
  readonly sessionHasNext: boolean
  readonly sessionHasPrevious: boolean
  readonly selectedSessionInfo?: SessionInfoView
  readonly drafts: Readonly<Record<string, string>>
  /** Bumps whenever the device connection is replaced or ended; read resources are keyed by device and generation. */
  readonly generation: number
  readonly sessionCreation?: SessionCreation
  readonly activeSessionID?: string
  readonly view?: SessionView
  readonly history?: { readonly status: "idle" | "loading" | "error"; readonly before?: string; readonly error?: string }
  readonly todos?: readonly TodoView[]
  readonly team?: TeamView
  readonly familyActivity?: { readonly rootID: string; readonly status: "loading" | "ready" | "unsupported" | "error"; readonly members: readonly RemoteFamilyActivity[] }
  readonly teamCues: readonly TeamCue[]
  readonly transport: RemoteTransportStatus
  readonly latencySync: "idle" | "saving" | "saved" | "waiting" | "unsupported" | "unknown" | "failed"
  readonly lastRelayDrop?: { readonly code: number; readonly reason: string }
  readonly mutations: readonly PendingMutation[]
  readonly mutationToasts?: readonly MutationToast[]
  readonly notice?: string
  readonly upload?: { readonly sessionID: string; readonly name: string; readonly percent: number }
  readonly uploadError?: string
  readonly notifications: readonly RemoteNotificationView[]
  readonly noticeSync: NoticeSyncState
  readonly unhandledEvents: number
}

export type NoticeSyncState = {
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly total: number
  readonly loaded: number
  readonly hidden: number
  readonly loadingMore: boolean
  readonly message: string | undefined
}

export type RemoteStoreOptions = {
  readonly http: RemoteHttp
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>
  readonly createTransport: (deviceID: string, handlers: RemoteTransportHandlers) => RemoteTransport
  readonly schedule?: (callback: () => void, ms: number) => () => void
  readonly now?: () => number
  readonly monotonicNow?: () => number
  /** Holds the remembered machine; defaults to browser storage. */
  readonly storage?: StorageLike
  /** Coalesces stream deltas into one state notification. */
  readonly batchMs?: number
  readonly latencyUploadIntervalMs?: number
  readonly createMessageID?: () => string
  readonly createSessionID?: () => string
  readonly deviceName?: (deviceID: string) => string
  /** Alerts for live events; the default reads stored preferences and the browser notification API. */
  readonly notificationDelivery?: NotificationDelivery
  /** Owns the connection-scoped read resources; a private client serves stores built without one. */
  readonly queryClient?: QueryClient
}

export type RemoteStore = {
  readonly container: Store<RemoteStoreState>
  readonly latency: ReturnType<typeof createLatencyDiagnostics>
  readonly queryClient: QueryClient
  readonly link: RemoteLink
  readonly state: () => RemoteStoreState
  readonly subscribe: (listener: () => void) => () => void
  readonly readStoredLatency: (before?: string) => Promise<
    | { readonly status: "ok"; readonly data: readonly { readonly receivedAt: number; readonly sample: RemoteLatencySample }[]; readonly next?: string }
    | { readonly status: "unavailable" | "unsupported" | "unknown" | "failed" }
  >
  readonly signInURL: (provider: SignInProvider, redirectAfter?: string) => string
  readonly load: () => Promise<void>
  readonly logout: () => Promise<void>
  readonly createEnrollment: () => Promise<RemoteHttpResult<CreateEnrollmentResponse>>
  readonly revokeDevice: (deviceID: string) => Promise<RemoteHttpResult<void>>
  readonly connect: (deviceID: string) => void
  readonly disconnect: () => void
  readonly selectSession: (sessionID: string) => Promise<void>
  readonly watchTeam: (enabled: boolean) => void
  readonly watchFamilyActivity: (enabled: boolean) => void
  readonly loadMoreTeam: () => Promise<void>
  readonly loadTeamControls: () => Promise<void>
  readonly loadSelectedSubagentEconomics: () => Promise<void>
  readonly loadMoreSideChats: () => Promise<void>
  readonly cancelSubagent: (childID: string) => Promise<{ readonly status: "ok" | "failed" | "unknown"; readonly message: string }>
  readonly answerSubagent: (childID: string, questionID: string, text: string) => Promise<{ readonly status: "ok" | "failed" | "unknown"; readonly message: string }>
  readonly killTeamShell: (shellID: string) => Promise<{ readonly status: "ok" | "failed" | "unknown"; readonly message: string }>
  readonly teamShellOutput: (ownerID: string, shellID: string, cursor?: number) => Promise<{ readonly text: string; readonly cursor: number; readonly size: number; readonly truncated: boolean }>
  readonly createSideChat: () => Promise<{ readonly status: "ok"; readonly sessionID: string } | { readonly status: "failed" | "unknown"; readonly message: string }>
  readonly selectWorkspace: (workspaceID: string) => void
  readonly searchSessions: (query: string, filter?: "all" | "running" | "idle") => void
  readonly nextSessionsPage: () => Promise<void>
  readonly previousSessionsPage: () => Promise<void>
  readonly setDraft: (sessionID: string, text: string) => void
  readonly loadCatalog: (target: CatalogTarget, options?: { readonly refresh?: boolean }) => Promise<void>
  readonly findFiles: (target: CatalogTarget, query: string, limit?: number) => Promise<FileFindResult>
  readonly createSession: (input: { readonly workspaceID: string; readonly agent?: string; readonly model?: ModelRefView; readonly prompt?: SessionCreation["prompt"] }) => Promise<string | undefined>
  readonly retrySessionCreation: () => Promise<string | undefined>
  readonly dismissSessionCreation: () => void
  readonly reloadMessages: () => Promise<void>
  readonly loadOlderMessages: () => Promise<void>
  readonly loadOversizedMessage: (messageID: string) => Promise<void>
  readonly loadImageSource: (input: { readonly deviceID: string; readonly sessionID: string; readonly digest: string; readonly mime: string }) => Promise<string>
  readonly loadShellOutputPage: (shellID: string) => Promise<void>
  readonly sendPrompt: (input: { readonly text: string; readonly delivery: "steer" | "queue"; readonly files?: readonly FileAttachmentInput[]; readonly agents?: readonly AgentAttachmentInput[]; readonly skills?: readonly string[]; readonly agent?: string; readonly model?: ModelRefView }) => Promise<boolean>
  readonly runCommand: (input: { readonly command: string; readonly arguments?: string; readonly delivery: "steer" | "queue"; readonly files?: readonly FileAttachmentInput[]; readonly agents?: readonly AgentAttachmentInput[]; readonly agent?: string; readonly model?: ModelRefView }) => Promise<boolean>
  readonly activateSkill: (skill: string) => Promise<boolean>
  readonly compactSession: () => Promise<boolean>
  readonly cancelUpload: () => void
  readonly switchModel: (model: ModelRefView) => Promise<boolean>
  readonly switchAgent: (agent: string) => Promise<boolean>
  readonly retryMutation: (id: string) => Promise<void>
  readonly dismissMutation: (id: string) => void
  readonly dismissMutationToast: (id: string) => void
  readonly readNotification: (id: string) => Promise<void>
  readonly readAllNotifications: () => Promise<void>
  readonly loadMoreNotifications: () => Promise<void>
  readonly reloadNotifications: () => Promise<void>
  readonly interrupt: () => Promise<void>
  readonly replyPermission: (id: string, reply: "once" | "always" | "reject") => Promise<void>
  readonly replyGuardrail: (id: string, reply: "once" | "always" | "reject") => Promise<void>
  readonly replyForm: (formID: string, answer: Readonly<Record<string, string | number | boolean | readonly string[]>>) => Promise<void>
  readonly cancelForm: (formID: string) => Promise<void>
  readonly setYolo: (level: 0 | 1 | 2 | 3) => Promise<boolean>
  readonly setGoal: (text: string) => Promise<boolean>
  readonly stopGoal: () => Promise<void>
  readonly setAutonomy: (autonomy: SessionAutonomyView) => void
  readonly dispose: () => void
}

const defaultBatchMs = 24
const sessionPageSize = 25
const carouselLimit = 10
const retainedSessionPages = 3
const historyPageSize = 100
const noticeTitleReads = 8
const noticeUnavailableMessage = "Some notifications could not be saved. Stored unread notifications remain available."
const noticeUnreadableMessage = "Notifications could not be read from the relay."

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
  readonly streamed: ReadonlyMap<string, string>
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
  const fetchContent = options.fetch ?? fetch
  const schedule = options.schedule ?? ((callback, ms) => {
    const handle = setTimeout(callback, ms)
    return () => clearTimeout(handle)
  })
  const now = options.now ?? (() => Date.now())
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const latency = createLatencyDiagnostics(now)
  const storage = options.storage ?? browserStorage()
  const batchMs = options.batchMs ?? defaultBatchMs
  const createMessageID = options.createMessageID ?? defaultMessageID
  const deviceName = options.deviceName ?? ((deviceID: string) => deviceID)
  const delivery = options.notificationDelivery ?? createNotificationDelivery()
  const queryClient = options.queryClient ?? createRemoteQueryClient()
  const notificationTitles = new Map<string, string | undefined>()
  const activeNoticeTitleReads = new Set<string>()
  let noticeFault = false

  const container = new Store<RemoteStoreState>({
    connection: { kind: "loading" },
    devices: [],
    advertised: [],
    sessions: [],
    carouselSessions: [],
    carouselStatus: "idle",
    catalogs: {},
    sessionGroups: [],
    sessionQuery: "",
    sessionFilter: "all",
    sessionListStatus: "idle",
    sessionRowsStale: false,
    sessionPageLoading: false,
    sessionHasNext: false,
    sessionHasPrevious: false,
    drafts: {},
    generation: 0,
    mutations: [],
    mutationToasts: [],
    teamCues: [],
    notifications: [],
    noticeSync: { status: "idle", total: 0, loaded: 0, hidden: 0, loadingMore: false, message: undefined },
    transport: { kind: "idle" },
    latencySync: "idle",
    unhandledEvents: 0,
  })
  let transport: RemoteTransport | undefined
  const pendingLatency: RemoteLatencySample[] = []
  let cancelLatencyUpload: (() => void) | undefined
  let latencyUpload: { readonly owner: RemoteTransport; readonly deviceID: string } | undefined
  let latencyUnsupported = false
  let olderMessageIDs = new Set<string>()
  const oversizedReads = new Map<string, AbortController>()
  const imageSources = new Map<string, { readonly mime: string; readonly controller: AbortController; readonly promise: Promise<string> }>()
  let imageScope: { readonly deviceID: string; readonly sessionID: string } | undefined
  const clearImageSources = () => {
    imageSources.forEach((entry) => entry.controller.abort())
    imageSources.clear()
    imageScope = undefined
  }
  let activeUpload: AbortController | undefined
  let selectionToken = 0
  const goalsInFlight = new Set<string>()
  let selectionReadyToken: number | undefined
  let selectionFailedToken: number | undefined
  let teamWatching = false
  const childAnswers = new Set<string>()
  let teamWatchToken = 0
  let teamShellRead = 0
  let activityWatching = false
  let activityWatchToken = 0
  let teamRead: { readonly owner: RemoteTransport; readonly token: number; readonly rootID: string; readonly watchToken: number } | undefined
  let pendingTeamRead: { readonly owner: RemoteTransport; readonly token: number; readonly rootID: string; readonly watchToken: number; readonly refresh: boolean } | undefined
  let cancelFamilyRefresh: (() => void) | undefined
  let familyReading = false
  let selectedEconomicsRead: { readonly owner: RemoteTransport; readonly token: number; readonly rootID: string; readonly childID: string } | undefined
  /**
   * Generation of the backend Session-list context. A list read may publish only
   * while it still describes the generation it was issued for, and every
   * connection change or Session invalidation starts a new generation.
   */
  let sessionsToken = 0
  let sessionPages: { readonly rows: readonly SessionInfoView[]; readonly previous?: string; readonly next?: string }[] = []
  let openRootInfo: SessionInfoView | undefined
  let loadingPageToken: number | undefined
  let statusReadOwner: RemoteTransport | undefined
  let statusReadPending = false
  let catalogGeneration = 0
  let recoveries = 0
  const recoveryWaiters = new Set<{ readonly scope: QueryScope; readonly settle: (recovered: boolean) => void }>()
  const catalogReads = new Map<string, Promise<void>>()
  const fileReads = new Map<string, Promise<FileFindResult>>()
  const fileTokens = new Map<string, number>()
  let statusFrameRevision = 0
  let statusBaseline = false
  let statusReloading = false
  let statusReloadLocal = false
  let carouselRefreshPending = false
  let carouselRevision = 0
  let lastStatusReload = -Infinity
  let lastCarouselReload = -Infinity
  let cancelStatusReload: (() => void) | undefined
  let cancelSearch: (() => void) | undefined
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
  let pendingRead: { readonly sessionID: string; readonly token: number; readonly promoted: Set<string> } | undefined
  let resyncRead: Promise<void> | undefined
  let resyncTarget: { readonly owner: RemoteTransport; readonly sessionID: string; readonly token: number } | undefined
  let resyncAgain = false
  /**
   * Live file changes that arrive while a ledger read is pending. The read describes
   * the device's ledger at one instant; a record this client applied after the read was
   * issued is newer, so it is re-applied over the read instead of being replaced by it.
   */
  let capturedRead: { readonly sessionID: string; readonly owner: RemoteTransport; readonly token: number } | undefined
  let cancelCapturedRefresh: (() => void) | undefined
  let lastCapturedRead = -Infinity
  let capturedUnsupported = false
  let todoRead: { readonly sessionID: string; live?: readonly TodoView[] } | undefined
  let compactionRead: { readonly token: number; readonly live: { readonly event: unknown; readonly at: number }[] } | undefined
  let compactionAttemptedToken: number | undefined
  const requestReads = new Set<{ readonly sessionID: string; readonly live: { readonly event: unknown; readonly at: number }[] }>()
  let cancelBatch: (() => void) | undefined
  let queued: { readonly sessionID: string; readonly event: unknown }[] = []
  let lastStatusKind: RemoteTransportStatus["kind"] = "idle"
  let connectionOpened = false
  let offlineDeviceID: string | undefined
  const subscriptions = new Set<{ readonly unsubscribe: () => void }>()

  const setState = (patch: Partial<RemoteStoreState>) => {
    if (Object.hasOwn(patch, "view") && (patch.view === undefined || patch.view?.id !== container.state.view?.id)) sealed = undefined
    container.setState((previous) => ({ ...previous, ...patch }))
  }

  const clearPendingLatency = () => {
    cancelLatencyUpload?.()
    cancelLatencyUpload = undefined
    pendingLatency.length = 0
    latencyUpload = undefined
    latencyUnsupported = false
    setState({ latencySync: "idle" })
  }

  const scheduleLatencyUpload = () => {
    const owner = transport
    if (owner === undefined || container.state.transport.kind !== "open" || pendingLatency.length === 0 ||
      cancelLatencyUpload !== undefined || latencyUpload !== undefined || latencyUnsupported) return
    cancelLatencyUpload = schedule(() => {
      cancelLatencyUpload = undefined
      void flushLatency(owner)
    }, options.latencyUploadIntervalMs ?? 10_000)
  }

  const flushLatency = async (owner: RemoteTransport) => {
    if (transport !== owner || container.state.transport.kind !== "open" || latencyUpload !== undefined || pendingLatency.length === 0) return
    const deviceID = container.state.activeDeviceID
    if (deviceID === undefined) return
    const flight = { owner, deviceID }
    latencyUpload = flight
    const samples = pendingLatency.splice(0, RemoteLimits.maxLatencyBatch)
    setState({ latencySync: "saving" })
    const outcome = await owner.request("machine.latency.append", { input: { samples } })
    if (latencyUpload !== flight) return
    latencyUpload = undefined
    if (transport !== owner || container.state.activeDeviceID !== deviceID) return
    if (outcome.status === "unavailable") {
      pendingLatency.unshift(...samples)
      pendingLatency.splice(60)
      setState({ latencySync: "waiting" })
      scheduleLatencyUpload()
      return
    }
    if (outcome.status === "failed") {
      pendingLatency.unshift(...samples)
      pendingLatency.splice(60)
      latencyUnsupported = true
      setState({ latencySync: outcome.error.code === "unknown_operation" ? "unsupported" : "failed" })
      return
    }
    if (outcome.status === "unknown") {
      setState({ latencySync: "unknown" })
      scheduleLatencyUpload()
      return
    }
    const accepted = typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "accepted") : undefined
    setState({ latencySync: accepted === samples.length ? "saved" : "failed" })
    if (accepted !== samples.length) latencyUnsupported = true
    scheduleLatencyUpload()
  }

  latency.subscribe((sample) => {
    if (sample === undefined) {
      cancelLatencyUpload?.()
      cancelLatencyUpload = undefined
      pendingLatency.length = 0
      if (latencyUpload === undefined) setState({ latencySync: "idle" })
      return
    }
    if (container.state.activeDeviceID === undefined || !isRemoteLatencySample(sample)) return
    pendingLatency.push(sample)
    if (pendingLatency.length > 60) pendingLatency.shift()
    scheduleLatencyUpload()
  })

  const clearCatalogs = () => {
    catalogGeneration += 1
    catalogReads.clear()
    fileReads.clear()
    fileTokens.clear()
    setState({ catalogs: {} })
  }

  const currentScope = (): QueryScope | undefined =>
    container.state.activeDeviceID === undefined ? undefined : { deviceID: container.state.activeDeviceID, generation: container.state.generation }

  const inScope = (scope: QueryScope) => container.state.activeDeviceID === scope.deviceID && container.state.generation === scope.generation

  const link: RemoteLink = {
    request: async (scope, operation, request) => {
      const owner = transport
      if (owner === undefined || container.state.transport.kind !== "open" || container.state.connection.kind === "offline")
        return { status: "unavailable", reason: "not-connected" }
      return owner.request(operation, request)
    },
    recoveries: () => recoveries,
    recovered: (scope, since) => {
      if (!inScope(scope)) return Promise.resolve(false)
      if (recoveries !== since) return Promise.resolve(true)
      return new Promise((resolve) => {
        const waiter = { scope, settle: (recovered: boolean) => { recoveryWaiters.delete(waiter); resolve(recovered) } }
        recoveryWaiters.add(waiter)
      })
    },
  }

  const signalRecovery = () => {
    recoveries += 1
    for (const waiter of recoveryWaiters) waiter.settle(true)
  }

  const endQueries = (ended: QueryScope | undefined) => {
    for (const waiter of recoveryWaiters) waiter.settle(false)
    if (ended !== undefined) queryClient.removeQueries({ queryKey: remoteKeys.scope(ended) })
  }

  /** Publishes the patch with the next generation, then discards the read resources of the connection it ends. */
  const endScope = (patch: Partial<RemoteStoreState>) => {
    const ended = currentScope()
    sends.forEach((progress) => { if (progress.deviceID === ended?.deviceID && progress.files?.some((file) => file.uri.startsWith("data:"))) progress.uploadsReady = false })
    const mutations = (patch.mutations ?? container.state.mutations).filter((mutation) => !sends.has(mutation.id) || sends.get(mutation.id)?.deviceID === patch.activeDeviceID)
    setState({ ...patch, generation: container.state.generation + 1,
      mutations: [...mutations, ...[...sends.values()].filter((progress) => progress.deviceID === patch.activeDeviceID && !mutations.some((mutation) => mutation.id === progress.mutation.id)).map((progress) => progress.mutation)],
      mutationToasts: (patch.mutationToasts ?? container.state.mutationToasts)?.filter((toast) => !sends.has(toast.id) || sends.get(toast.id)?.deviceID === patch.activeDeviceID) })
    endQueries(ended)
  }

  const invalidateReads = () => {
    const scope = currentScope()
    if (scope === undefined) return
    void queryClient.invalidateQueries({ queryKey: remoteKeys.usage(scope) }, { cancelRefetch: false })
    void queryClient.invalidateQueries({ queryKey: remoteKeys.keepAwake(scope) }, { cancelRefetch: false })
  }

  const endAlerts = (retainMachineOffline = false, closeSystemAlerts = true) => {
    delivery.dispose(retainMachineOffline, closeSystemAlerts)
    noticeFault = false
    if (!retainMachineOffline) notificationTitles.clear()
    activeNoticeTitleReads.clear()
    setState({ notifications: delivery.entries(), noticeSync: { ...container.state.noticeSync, status: "idle", total: 0, loaded: 0, hidden: 0, loadingMore: false, message: undefined } })
  }

  const notifySession = (category: NotificationCategory, sessionID: string) => {
    delivery.deliver(category, { sessionID, ...titleOf(sessionID) })
    resolveNoticeTitles()
  }

  const titleOf = (sessionID: string) => {
    const title = notificationSessionTitle(container.state, sessionID) ?? notificationTitles.get(sessionID)
    if (title !== undefined) notificationTitles.set(sessionID, title)
    return title === undefined ? {} : { sessionTitle: title }
  }

  const resolveNoticeTitles = () => {
    const owner = transport
    const unresolved = [...new Set(delivery.entries().flatMap((entry) =>
      entry.sessionID === undefined || entry.sessionTitle !== undefined ? [] : [entry.sessionID]))]
    const resident = unresolved.filter((sessionID) => {
      const title = titleOf(sessionID).sessionTitle
      return title !== undefined && delivery.setSessionTitle(sessionID, title)
    })
    if (resident.length > 0) setState({ notifications: delivery.entries() })
    if (owner === undefined || !isCurrentConnection(owner)) return
    for (const sessionID of unresolved.filter((id) => !resident.includes(id) && !notificationTitles.has(id)).slice(0, Math.max(0, noticeTitleReads - activeNoticeTitleReads.size))) {
      notificationTitles.set(sessionID, undefined)
      activeNoticeTitleReads.add(sessionID)
      void owner.request("session.get", { sessionID, timeoutMs: 5_000 }).then((outcome) => {
        if (!isCurrentConnection(owner)) return
        activeNoticeTitleReads.delete(sessionID)
        if (outcome.status !== "ok") { resolveNoticeTitles(); return }
        const data = typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
        const resolved = readSessionInfo(data)
        if (resolved?.id === sessionID) {
          notificationTitles.set(sessionID, resolved.title)
          if (delivery.setSessionTitle(sessionID, resolved.title)) setState({ notifications: delivery.entries() })
        }
        resolveNoticeTitles()
      }, () => {
        if (!isCurrentConnection(owner)) return
        activeNoticeTitleReads.delete(sessionID)
        resolveNoticeTitles()
      })
    }
  }

  const publishNotices = (patch: Partial<NoticeSyncState> = {}) => {
    setState({ notifications: delivery.entries(),
      noticeSync: { ...container.state.noticeSync, loaded: delivery.syncedLoaded(), hidden: delivery.syncedHidden(), ...patch } })
  }

  const failNoticeSync = (message: string) => {
    publishNotices({ status: "error", loadingMore: false, message })
    setState({ notice: message })
  }

  const withTitle = (notice: RemoteNotice) => ({ id: notice.id, category: notice.category, at: notice.createdAt, sessionID: notice.sessionID, ...titleOf(notice.sessionID) })

  const readNoticePage = (outcome: RemoteRequestOutcome): { readonly page: RemoteNoticePage } | { readonly message: string } | { readonly lost: true } => {
    if (outcome.status === "unknown" || (outcome.status === "unavailable" && outcome.reason === "not-connected")) return { lost: true }
    if (outcome.status !== "ok") return { message: describeOutcome(outcome, "Notifications") }
    const parsed = parseNoticePage(outcome.value)
    return parsed.ok ? { page: parsed.value } : { message: noticeUnreadableMessage }
  }

  const noticeStatus = () => noticeFault ? "error" : "ready"

  const applyNotices = (owner: RemoteTransport, frame: RemoteNoticeFrame, ownerDeviceID: string) => {
    if (frame.type === "notice.present" && ownerDeviceID === container.state.activeDeviceID) {
      delivery.present(frame.items, ownerDeviceID)
      return
    }
    if (!isCurrentConnection(owner)) return
    if (frame.type === "notice.unavailable") {
      noticeFault = true
      failNoticeSync(noticeUnavailableMessage)
      return
    }
    if (frame.type === "notice.offline") {
      if (container.state.activeDeviceID === undefined) return
      offlineDeviceID = container.state.activeDeviceID
      delivery.offline(container.state.activeDeviceID, frame.at)
      setState({ notifications: delivery.entries() })
      return
    }
    if (frame.type === "notice.present") return
    if (frame.type === "notice.cleared") {
      delivery.clearSynced()
      noticeFault = false
      publishNotices({ total: 0, status: container.state.noticeSync.status === "loading" ? "loading" : "ready", message: undefined })
      return
    }
    const deviceID = container.state.activeDeviceID
    if (frame.type === "notice.removed") delivery.remove(frame.ids)
    else if (deviceID !== undefined) for (const notice of frame.notices) delivery.receive(withTitle(notice), deviceID)
    publishNotices({ total: frame.total })
    if (frame.type === "notice.added") resolveNoticeTitles()
  }

  const loadNotices = async (owner: RemoteTransport) => {
    publishNotices({ status: "loading", loadingMore: false, message: undefined })
    const outcome = await owner.request("notice.subscribe")
    if (!isCurrentConnection(owner)) return
    const read = readNoticePage(outcome)
    if ("lost" in read) {
      publishNotices({ status: "idle", loadingMore: false })
      return
    }
    if ("message" in read) {
      failNoticeSync(read.message)
      return
    }
    noticeFault = read.page.unavailable
    delivery.replaceSynced(read.page.notices.map(withTitle))
    if (noticeFault) setState({ notice: noticeUnavailableMessage })
    publishNotices({ total: read.page.total, status: noticeStatus(), message: noticeFault ? noticeUnavailableMessage : undefined })
    resolveNoticeTitles()
  }

  const loadMoreNotices = async () => {
    const owner = transport
    const before = delivery.oldestSynced()
    if (owner === undefined || before === undefined || container.state.noticeSync.loadingMore || container.state.noticeSync.status === "loading") return
    publishNotices({ loadingMore: true })
    const outcome = await owner.request("notice.list", { input: { before } })
    if (!isCurrentConnection(owner)) return
    const read = readNoticePage(outcome)
    if ("lost" in read) {
      publishNotices({ loadingMore: false })
      return
    }
    if ("message" in read) {
      failNoticeSync(read.message)
      return
    }
    if (delivery.oldestSynced() !== before) {
      publishNotices({ loadingMore: false })
      return
    }
    noticeFault = read.page.unavailable || noticeFault
    delivery.appendSynced(read.page.notices.map(withTitle))
    publishNotices({ total: read.page.total, loadingMore: false, status: noticeStatus(), message: noticeFault ? noticeUnavailableMessage : undefined })
    resolveNoticeTitles()
  }

  const readNotices = async (operation: "notice.read" | "notice.readAll", input?: { readonly ids: readonly string[] }) => {
    const owner = transport
    if (owner === undefined) return
    const outcome = await owner.request(operation, input === undefined ? {} : { input })
    if (outcome.status !== "ok" && isCurrentConnection(owner)) setState({ notice: describeOutcome(outcome, "Notifications") })
  }

  const reportMachineOffline = () => {
    if (container.state.activeDeviceID !== undefined) offlineDeviceID = container.state.activeDeviceID
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
    const items = queued
    queued = []
    if (items.length === 0) return
    let view = container.state.view
    let unhandled = container.state.unhandledEvents
    let teamCues = container.state.teamCues
    let todos = container.state.todos
    let refreshTeam = false
    let refreshShells = false
    let gap = false
    const activity = new Map<string, { readonly at: number; readonly ended: boolean }>()
    const oversizedIDs = new Set<string>()
    batch(() => {
    for (const item of items) {
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
      const type = typeof item.event === "object" && item.event !== null ? Reflect.get(item.event, "type") : undefined
      if (type === "session.remote.oversized") {
        const data = typeof item.event === "object" && item.event !== null ? Reflect.get(item.event, "data") : undefined
        const candidate = data && typeof data === "object" && Reflect.get(data, "sessionID") === view.id ? Reflect.get(data, "messageID") : undefined
        const messageID = typeof candidate === "string" && /^msg_[A-Za-z0-9_-]+$/.test(candidate) && candidate.length <= 128 ? candidate : undefined
        if (messageID === undefined) gap = true
        if (messageID !== undefined) {
          const previous = view.messages.find((message) => message.id === messageID)
          const marker: RemoteMessageView = { kind: "oversized", id: messageID, projected: previous?.kind === "oversized" ? previous.projected : previous !== undefined && (previous.kind !== "user" || previous.state !== "pending"), state: "loading" }
          view = { ...view, messages: view.messages.some((message) => message.id === messageID)
            ? view.messages.map((message) => message.id === messageID ? marker : message)
            : [...view.messages, marker] }
          oversizedIDs.add(messageID)
        }
        if (sequence.seq !== undefined) view = { ...view, watermark: sequence.seq }
        continue
      }
      if (type === "session.input.promoted") {
        const data = typeof item.event === "object" && item.event !== null ? Reflect.get(item.event, "data") : undefined
        const inputID = data && typeof data === "object" ? Reflect.get(data, "inputID") : undefined
        if (typeof inputID === "string" && pendingRead?.sessionID === item.sessionID) pendingRead.promoted.add(inputID)
        if (typeof inputID === "string" && view.messages.some((message) => message.kind === "oversized" && message.id === inputID)) {
          view = { ...view, messages: view.messages.map((message) => message.kind === "oversized" && message.id === inputID ? { ...message, projected: true, state: "loading" } : message) }
          oversizedIDs.add(inputID)
        }
      }
      if (teamWatching && hydration === undefined && container.state.activeSessionID === item.sessionID && subscribedSessionID === item.sessionID &&
        container.state.team?.rootID === item.sessionID) {
        const cue = readTeamCue(item.event)
        if (cue !== undefined && !teamCues.some((entry) => entry.id === cue.id)) {
          teamCues = [...teamCues, cue].slice(-8)
          refreshTeam = true
        }
      }
      // Alerts follow the events that reach the projection: a dropped duplicate
      // raises nothing, and the snapshot paths below never call this loop.
      const category = notificationCategory(item.event)
      if (category !== undefined) notifySession(category, item.sessionID)
      const at = now()
      const next = applySessionEvent(view, item.event, at)
      const ended = type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted"
      const eventData = typeof item.event === "object" && item.event !== null ? Reflect.get(item.event, "data") : undefined
      if (type === "session.input.admitted" || type === "session.input.promoted") {
        const inputID = eventData && typeof eventData === "object" ? Reflect.get(eventData, "inputID") : undefined
        if (typeof inputID === "string" && confirmSend(inputID))
          setState({ mutations: container.state.mutations.filter((mutation) => mutation.id !== inputID),
            mutationToasts: container.state.mutationToasts?.filter((toast) => toast.id !== inputID) })
      }
      const structured = eventData && typeof eventData === "object" ? Reflect.get(eventData, "structured") : undefined
      const metadata = eventData && typeof eventData === "object" ? Reflect.get(eventData, "metadata") : undefined
      if (ended || type === "session.tool.success" && structured && typeof structured === "object" && typeof Reflect.get(structured, "shellID") === "string" ||
        type === "session.synthetic" && metadata && typeof metadata === "object" && Reflect.get(metadata, "source") === "shell") refreshShells = true
      if (next.activeAt !== undefined && (next.activeAt !== view.activeAt || ended))
        activity.set(item.sessionID, { at: next.activeAt, ended })
      if (typeof item.event === "object" && item.event !== null && Reflect.get(item.event, "type") === "session.compaction.ended") recordCovered(view, next)
      if (type === "session.compaction.ended" || type === "session.compaction.failed") {
        const jobID = eventData && typeof eventData === "object" ? Reflect.get(eventData, "jobID") : undefined
        const failure = eventData && typeof eventData === "object" ? Reflect.get(eventData, "error") : undefined
        const failureMessage = failure && typeof failure === "object" ? Reflect.get(failure, "message") : undefined
        if (typeof jobID === "string" && compactionWaiters.has(jobID))
          settleCompaction(jobID, type === "session.compaction.ended" ? "completed" : "failed", typeof failureMessage === "string" ? failureMessage : undefined)
      }
      unhandled += next.unhandledEvents - view.unhandledEvents
      view = sequence.seq === undefined ? next : { ...next, watermark: sequence.seq }
      if (compactionRead?.token === selectionToken && typeof type === "string" && type.startsWith("session.compaction.") &&
        (type === "session.compaction.admitted" || type === "session.compaction.started" || type === "session.compaction.ended" || type === "session.compaction.failed"))
        compactionRead.live.push({ event: item.event, at })
      const eventTodoList = eventTodos(item.event, item.sessionID)
      if (eventTodoList !== undefined) {
        todos = reuseTodos(todos, eventTodoList)
        if (todoRead?.sessionID === item.sessionID) todoRead.live = todos
      }
      if (type === "permission.asked" || type === "permission.replied" ||
        type === "guardrail.asked" || type === "guardrail.replied" ||
        type === "form.created" || type === "form.replied" || type === "form.cancelled") {
        for (const read of requestReads) {
          if (read.sessionID === item.sessionID) read.live.push({ event: item.event, at })
        }
      }
      if (hydration !== undefined && hydration.sessionID === item.sessionID && key !== undefined) {
        hydration.events.push(item.event)
        hydration.replayed.add(key)
      }
    }
    let listed: Partial<RemoteStoreState> = {}
    if (activity.size > 0) {
      const update = <T extends SessionInfoView>(row: T): T => {
        const terminal = activity.get(row.id)
        return terminal === undefined ? row : { ...row, activeAt: terminal.at,
          ...(container.state.sessionStatus === undefined ? terminal.ended ? { running: false } : {} : { running: container.state.sessionStatus.running.has(row.id) }) }
      }
      sessionPages = sessionPages.map((page) => ({ ...page, rows: page.rows.map(update) }))
      if (openRootInfo) openRootInfo = update(openRootInfo)
      listed = { sessions: withOpenRoot(sortSessions(sessionPages.flatMap((page) => page.rows))),
        carouselSessions: sortSessions(container.state.carouselSessions?.map(update) ?? []) }
    }
    container.setState((previous) => ({
      ...previous,
      ...listed,
      todos,
      view: view && container.state.sessionStatus?.running.has(view.id) ? reconcileSessionStatus(view, container.state.sessionStatus,
        container.state.selectedSessionInfo?.id === view.id ? container.state.selectedSessionInfo.parentID : undefined) : view,
      selectedSessionInfo: view !== undefined && container.state.selectedSessionInfo?.id === view.id
        ? { ...container.state.selectedSessionInfo, agent: view.agent ?? container.state.selectedSessionInfo.agent,
          model: view.model ?? container.state.selectedSessionInfo.model, modelLabel: modelLabel(view.model ?? container.state.selectedSessionInfo.model) ?? container.state.selectedSessionInfo.modelLabel }
        : container.state.selectedSessionInfo,
      unhandledEvents: unhandled,
      notifications: delivery.entries(),
      teamCues,
    }))
    })
    if (items.some((item) => {
      if (item.sessionID !== container.state.activeSessionID || typeof item.event !== "object" || item.event === null) return false
      const type = Reflect.get(item.event, "type")
      if (type === "session.step.ended" || type === "session.compaction.ended") return true
      const cue = readTeamCue(item.event)
      return cue?.kind === "reported" && cue.outcome === "completed"
    })) scheduleCapturedRefresh()
    if (items.some((item) => typeof item.event === "object" && item.event !== null && Reflect.get(item.event, "type") === "session.compaction.started") &&
      container.state.activeSessionID !== undefined) void loadCompactionHistory(container.state.activeSessionID, selectionToken)
    if (gap) void resyncSelected()
    if (transport !== undefined && container.state.activeSessionID !== undefined && items.some((item) => item.sessionID === container.state.activeSessionID && isGoalSteerAdmission(item.event)) &&
      goalRequests(container.state.activeSessionID).some((mutation) => mutation.state !== "failed")) void refreshAutonomy(transport, container.state.activeSessionID, selectionToken)
    oversizedIDs.forEach((id) => {
      oversizedReads.get(id)?.abort()
      oversizedReads.delete(id)
      void loadOversizedMessage(id)
    })
    if (refreshTeam && container.state.team?.status !== "unsupported" && container.state.team !== undefined && transport !== undefined)
      void loadTeam(transport, selectionToken, container.state.team.rootID, undefined, true)
    if (refreshShells && teamWatching && container.state.team?.shellStatus !== "unsupported" && container.state.team !== undefined && transport !== undefined)
      void loadTeamShells(transport, selectionToken, container.state.team.rootID)
  }

  const queueEvent = (sessionID: string, event: unknown) => {
    queued.push({ sessionID, event })
    cancelBatch ??= schedule(flush, batchMs)
  }

  const loadFamilyActivity = async (owner: RemoteTransport, rootID: string) => {
    cancelFamilyRefresh?.()
    cancelFamilyRefresh = undefined
    if (!activityWatching || !teamWatching || familyReading || !isCurrentConnection(owner) || container.state.transport.kind !== "open" || container.state.team?.rootID !== rootID ||
      container.state.team.status !== "ready" || container.state.familyActivity?.status === "unsupported" || (typeof document !== "undefined" && document.hidden)) return
    const watchToken = activityWatchToken
    const sessionIDs = container.state.team.tasks.filter((task) => task.parentID === rootID)
      .toSorted((a, b) => a.sessionID.localeCompare(b.sessionID))
      .toSorted((a, b) => Number(b.sessionID === container.state.activeSessionID) - Number(a.sessionID === container.state.activeSessionID))
      .slice(0, RemoteLimits.maxFamilyMembers - 1).map((task) => task.sessionID)
    familyReading = true
    const outcome = await owner.request("session.family.activity", { sessionID: rootID, input: { sessionIDs }, timeoutMs: 5_000 })
    familyReading = false
    if (!activityWatching || watchToken !== activityWatchToken || !isCurrentConnection(owner) || container.state.transport.kind !== "open" || container.state.team?.rootID !== rootID ||
      (typeof document !== "undefined" && document.hidden)) {
      if (activityWatching && container.state.team?.status === "ready" && container.state.transport.kind === "open" && transport !== undefined &&
        (typeof document === "undefined" || !document.hidden)) void loadFamilyActivity(transport, container.state.team.rootID)
      return
    }
    if (outcome.status !== "ok") {
      const unsupported = outcome.status === "unknown" || outcome.status === "failed" && outcome.error.code === "unknown_operation"
      setState({ familyActivity: { rootID, status: unsupported ? "unsupported" : "error", members: [] } })
      if (!unsupported) cancelFamilyRefresh = schedule(() => { void loadFamilyActivity(owner, rootID) }, 3_000)
      return
    }
    const data = typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
    const expected = [rootID, ...sessionIDs]
    const valid = Array.isArray(data) && data.length === expected.length && data.every((member, index) => {
      if (typeof member !== "object" || member === null || Reflect.get(member, "sessionID") !== expected[index] || typeof Reflect.get(member, "executing") !== "boolean") return false
      const activity = Reflect.get(member, "activity")
      const text = typeof activity === "object" && activity !== null ? Reflect.get(activity, "text") : undefined
      return activity === undefined || typeof activity === "object" && activity !== null &&
        ["tool", "thinking", "replying"].includes(Reflect.get(activity, "kind")) &&
        ["research", "qa", "meeting", "developer", "hold"].includes(Reflect.get(activity, "room")) &&
        typeof text === "string" && Array.from(text).length <= 80
    })
    setState({ familyActivity: { rootID, status: valid ? "ready" : "error", members: valid ? data as readonly RemoteFamilyActivity[] : [] } })
    if (activityWatching) cancelFamilyRefresh = schedule(() => { void loadFamilyActivity(owner, rootID) }, 3_000)
  }

  const officeVisibility = () => {
    cancelFamilyRefresh?.()
    cancelFamilyRefresh = undefined
    if (activityWatching && typeof document !== "undefined" && !document.hidden && transport !== undefined && container.state.team?.status === "ready")
      void loadFamilyActivity(transport, container.state.team.rootID)
  }

  const loadTeam = async (owner: RemoteTransport, token: number, rootID: string, cursor?: string, refresh = false) => {
    if (!teamWatching) return
    const watchToken = teamWatchToken
    if (teamRead !== undefined) {
      if (cursor === undefined && (refresh || teamRead.owner !== owner || teamRead.token !== token ||
        teamRead.rootID !== rootID || teamRead.watchToken !== watchToken)) pendingTeamRead = { owner, token, rootID, watchToken, refresh }
      return
    }
    if (token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== rootID || container.state.transport.kind !== "open") return
    const read = { owner, token, rootID, watchToken }
    teamRead = read
    setState({ team: { ...container.state.team, rootID, status: cursor === undefined && !(refresh && container.state.team.status === "ready") ? "loading" : container.state.team.status,
      pageLoading: cursor !== undefined, refreshing: refresh && cursor === undefined } })
    const outcome = await owner.request("session.subagent.list", { sessionID: rootID,
      ...(cursor === undefined ? {} : { input: { cursor } }) })
    if (teamRead === read) teamRead = undefined
    const currentTeam = container.state.team
    if (teamWatching && watchToken === teamWatchToken && token === selectionToken && isCurrentConnection(owner) &&
      currentTeam?.rootID === rootID && container.state.transport.kind === "open") {
      if (refresh && currentTeam.status === "ready" && outcome.status !== "ok") {
        setState({ team: { ...currentTeam, pageLoading: false, refreshing: false } })
      } else if (outcome.status === "failed" && outcome.error.code === "unknown_operation") {
        setState({ team: { ...currentTeam, status: "unsupported", tasks: [], pageLoading: false, refreshing: false } })
      } else if (outcome.status !== "ok") {
        setState({ team: { ...currentTeam, status: "error", pageLoading: false, refreshing: false } })
      } else {
        const value = outcome.value
        const data = typeof value === "object" && value !== null ? Reflect.get(value, "data") : undefined
        const summary = typeof value === "object" && value !== null ? Reflect.get(value, "summary") : undefined
        const cursors = typeof value === "object" && value !== null ? Reflect.get(value, "cursor") : undefined
        if (!Array.isArray(data) || typeof cursors !== "object" || cursors === null) {
          setState({ team: { ...currentTeam, status: "error", pageLoading: false, refreshing: false } })
        } else {
          const rows = data.flatMap((item: unknown) => {
            const task = readTeamTask(item)
            return task?.parentID === rootID ? [task] : []
          })
          const next = Reflect.get(cursors, "next")
          const total = typeof summary === "object" && summary !== null ? Reflect.get(summary, "total") : undefined
          const active = typeof summary === "object" && summary !== null ? Reflect.get(summary, "active") : undefined
          const tasks = cursor === undefined ? rows : [...currentTeam.tasks.filter((item) => !rows.some((row) => row.sessionID === item.sessionID)), ...rows]
          setState({ team: { ...currentTeam, rootID, status: "ready", tasks: tasks.map((item) => ({ ...item,
            ...retainedEconomics(currentTeam.tasks.find((old) => old.sessionID === item.sessionID)) })),
            ...(typeof total === "number" && Number.isInteger(total) && total >= 0 ? { total } : {}),
            ...(typeof active === "number" && Number.isInteger(active) && active >= 0 ? { activeTotal: active } : {}),
            ...(typeof next === "string" && next.length > 0 ? { next } : {}), pageLoading: false, refreshing: false } })
          if (activityWatching && container.state.familyActivity?.status !== "unsupported") void loadFamilyActivity(owner, rootID)
          if (currentTeam.shellStatus === "loading" || refresh && currentTeam.shellStatus !== "unsupported") void loadTeamShells(owner, token, rootID)
        }
      }
    }
    const pending = pendingTeamRead
    pendingTeamRead = undefined
    if (teamWatching && pending !== undefined && teamRead === undefined && pending.watchToken === teamWatchToken && pending.token === selectionToken &&
      isCurrentConnection(pending.owner) && container.state.transport.kind === "open" && container.state.team?.rootID === pending.rootID && container.state.team.status !== "unsupported")
      void loadTeam(pending.owner, pending.token, pending.rootID, undefined, pending.refresh)
  }

  let economicsReads = 0
  const loadTeamEconomics = async (owner: RemoteTransport, token: number, rootID: string, sessionIDs: readonly string[]) => {
    economicsReads += 1
    if (container.state.team?.rootID === rootID) setState({ team: { ...container.state.team, economicsLoading: true } })
    try {
      await readTeamEconomicsRows(owner, token, rootID, sessionIDs)
    } finally {
      economicsReads -= 1
      if (economicsReads === 0 && container.state.team?.economicsLoading === true) setState({ team: { ...container.state.team, economicsLoading: false } })
    }
  }

  const readTeamEconomicsRows = async (owner: RemoteTransport, token: number, rootID: string, sessionIDs: readonly string[]) => {
    const outcome = await owner.request("session.team.economics", { sessionID: rootID, input: { sessionIDs }, timeoutMs: 5_000 })
    if (!teamWatching || token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== rootID) return
    if (outcome.status !== "ok") {
      if (outcome.status === "unknown" || outcome.status === "failed" && outcome.error.code === "unknown_operation") setState({ team: { ...container.state.team, economicsUnsupported: true } })
      return
    }
    const data = typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
    if (!Array.isArray(data)) return
    const rows = new Map(data.flatMap((item: unknown) => {
      const economy = readTeamEconomics(item)
      return economy && sessionIDs.includes(economy.sessionID) ? [[economy.sessionID, economy] as const] : []
    }))
    setState({ team: { ...container.state.team, tasks: container.state.team.tasks.map((task) => ({ ...task, ...rows.get(task.sessionID) })) } })
  }

  const loadTeamShells = async (owner: RemoteTransport, token: number, rootID: string) => {
    const revision = ++teamShellRead
    const outcome = await owner.request("session.team.shell.list", { sessionID: rootID, timeoutMs: 5_000 })
    if (!teamWatching || revision !== teamShellRead || token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== rootID) return
      const data = outcome.status === "ok" && typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
      const truncated = outcome.status === "ok" && typeof outcome.value === "object" && outcome.value !== null && Reflect.get(outcome.value, "truncated") === true
    setState({ team: { ...container.state.team, shells: Array.isArray(data) ? data.flatMap((item: unknown) => {
      const shell = readTeamShell(item)
      return shell ? [shell] : []
    }) : container.state.team.shells, shellTruncated: truncated, shellStatus: outcome.status === "failed" && outcome.error.code === "unknown_operation" || outcome.status === "unknown" ? "unsupported" : Array.isArray(data) ? "ready" : "error" } })
  }

  const loadSideChats = async (owner: RemoteTransport, token: number, rootID: string, cursor?: string) => {
    const outcome = await owner.request("session.side-chat.list", { sessionID: rootID, ...(cursor === undefined ? {} : { input: { cursor } }), timeoutMs: 5_000 })
    if (!teamWatching || token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== rootID) return
    const value = outcome.status === "ok" && typeof outcome.value === "object" && outcome.value !== null ? outcome.value : undefined
    const data = value === undefined ? undefined : Reflect.get(value, "data")
    const page = value === undefined ? undefined : Reflect.get(value, "cursor")
    const next = typeof page === "object" && page !== null ? Reflect.get(page, "next") : undefined
    const chats = Array.isArray(data) ? data.flatMap((item: unknown) => {
      const chat = readTeamSideChat(item)
      return chat ? [chat] : []
    }) : undefined
    setState({ team: { ...container.state.team, sideChatStatus: outcome.status === "failed" && outcome.error.code === "unknown_operation" || outcome.status === "unknown" ? "unsupported" : chats === undefined ? "error" : "ready",
      sideChats: chats === undefined ? container.state.team.sideChats : cursor === undefined ? chats : [...container.state.team.sideChats.filter((old) => !chats.some((item) => item.id === old.id)), ...chats],
      sideChatLoading: false, sideChatNext: typeof next === "string" && next.length > 0 ? next : undefined } })
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
    return deviceConnection(container.state.devices.length)
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
    if (!owner || container.state.transport.kind !== "open" || activeUpload) {
      setState({ uploadError: activeUpload ? "Wait for the current attachment upload to finish." : "Connect to the machine before uploading attachments." })
      return undefined
    }
    const controller = new AbortController()
    activeUpload = controller
    setState({ upload: { sessionID, name: files.find((file) => file.uri.startsWith("data:"))?.name ?? "Attachment", percent: 0 }, uploadError: undefined })
    try {
      const uploaded = await uploadAttachments({ sessionID, files, request: owner.request, signal: controller.signal,
        onProgress: (name, percent) => { if (activeUpload === controller) setState({ upload: { sessionID, name, percent } }) } })
      if (controller.signal.aborted || !isCurrentConnection(owner) || token !== selectionToken || container.state.activeSessionID !== sessionID)
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
    const opened = status.kind === "open" && lastStatusKind !== "open"
    const reopened = opened && connectionOpened
    if (status.kind === "open") connectionOpened = true
    if (status.kind === "closed" || status.kind === "reconnecting") {
      cancelUpload("Attachment upload lost its machine connection. Files were not sent.")
      sends.forEach((progress) => {
        if (progress.files?.some((file) => file.uri.startsWith("data:"))) progress.uploadsReady = false
      })
    }
    if (opened) {
      cancelStatusReload?.()
      cancelStatusReload = undefined
      statusReloadLocal = false
      carouselRefreshPending = false
      carouselRevision += 1
      lastStatusReload = -Infinity
      lastCarouselReload = -Infinity
      statusReadOwner = undefined
      statusReadPending = false
      statusFrameRevision += 1
      statusBaseline = false
      setState({ sessionStatus: undefined, carouselSessions: [], carouselStatus: "loading" })
      if (reopened) clearCatalogs()
    }
    const rejected = status.kind === "closed" && (status.code === 4401 || status.code === 4403)
    lastStatusKind = status.kind
    if (status.kind === "closed") subscribedSessionID = undefined
    if (status.kind === "closed") {
      cancelFamilyRefresh?.()
      cancelFamilyRefresh = undefined
      setState({ teamCues: [], familyActivity: container.state.familyActivity === undefined ? undefined : { ...container.state.familyActivity, status: "loading" },
        ...(container.state.team === undefined ? {} : { team: { ...container.state.team, status: "loading", pageLoading: false, refreshing: false,
          shellStatus: "loading", sideChatStatus: "loading", sideChatLoading: false, economicsUnsupported: false } }) })
    }
    if (rejected && status.kind === "closed") {
      clearPendingLatency()
      latency.clear()
      goalsInFlight.clear()
      clearImageSources()
      clearCatalogs()
      cancelFamilyRefresh?.()
      cancelFamilyRefresh = undefined
      sessionPages = []
      openRootInfo = undefined
      // Relay authorization can reject one revoked device while the browser account
      // remains valid. Tear down only that device, then let the authoritative account
      // answer decide whether the browser is truly signed out.
      sessionsToken += 1
      endScope({
        transport: status,
        connection: deviceConnection(container.state.devices.filter((device) => device.status === "active" && device.online).length),
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
        team: undefined, familyActivity: undefined,
        teamCues: [],
        drafts: {},
        mutations: container.state.mutations.filter((mutation) => mutation.operation !== "session.goal.set"),
        mutationToasts: (container.state.mutationToasts ?? []).filter((toast) => !container.state.mutations.some((mutation) => mutation.operation === "session.goal.set" && mutation.id === toast.id)),
        sessionCreation: undefined,
        activeSessionID: undefined,
        view: undefined,
        notice: status.reason,
      })
      endAlerts()
      void api.load()
      return
    }
    setState({ transport: status, connection: connectionFor(status, container.state.activeDeviceID), notifications: delivery.entries(),
      ...(status.kind === "closed" ? { lastRelayDrop: { code: status.code, reason: status.reason } } : {}) })
    if (reopened) latencyUnsupported = false
    if (status.kind === "open") scheduleLatencyUpload()
    if (opened) void loadNotices(owner)
    if (status.kind === "open" && container.state.activeSessionID !== undefined) void readSessionStatus(owner)
    if (reopened) {
      signalRecovery()
      invalidateReads()
    }
  }

  const request = async (
    mutation: PendingMutation,
    options: { readonly sessionID?: string; readonly operation?: RemoteOperation; readonly input?: Readonly<Record<string, unknown>>; readonly retain?: boolean } = {},
  ): Promise<RemoteRequestOutcome> => {
    const active = transport
    if (!active) {
      finishMutation(mutation.id, "failed", "The relay connection is not open")
      return { status: "unavailable", reason: "not-connected" }
    }
    const progress = sends.get(mutation.id)
    if (progress !== undefined) progress.mutation = mutation
    setState({ mutations: [...container.state.mutations.filter((entry) => entry.id !== mutation.id), mutation] })
    const jobID = mutation.kind === "compact" && typeof mutation.input.id === "string" ? mutation.input.id : undefined
    const jobSettled = jobID === undefined ? undefined : new Promise<RemoteRequestOutcome>((resolve) => compactionWaiters.set(jobID, resolve))
    const answered = active.request(options.operation ?? mutation.operation, { sessionID: options.sessionID, input: options.input ?? mutation.input,
      ...((mutation.operation === "session.goal.set" || mutation.operation === "session.autonomy.set" && typeof mutation.input.goal === "string")
        ? { timeoutMs: RemoteLimits.goalSetTimeoutMs } : mutation.operation === "session.compact"
          ? { timeoutMs: RemoteLimits.compactionTimeoutMs } : {}) })
    const outcome = await (jobSettled === undefined ? answered : Promise.race([answered, jobSettled]))
    if (outcome.status === "ok") {
      if (jobID !== undefined) compactionWaiters.delete(jobID)
      setState({ ...(options.retain ? {} : { mutations: container.state.mutations.filter((entry) => entry.id !== mutation.id) }),
        mutationToasts: (container.state.mutationToasts ?? []).filter((entry) => entry.id !== mutation.id) })
      if (!options.retain) sends.delete(mutation.id)
      return outcome
    }
    if (jobID !== undefined && jobSettled !== undefined && compactionWaiters.has(jobID)) {
      const job = compactionJob(mutation)
      if (job?.status === "completed") return settleCompaction(jobID, "completed")
      if (job?.status === "failed") return settleCompaction(jobID, "failed", `Compaction failed: ${job.failureCode ?? "unknown failure"}`)
      if (job !== undefined) return jobSettled
      compactionWaiters.delete(jobID)
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

  /**
   * A compaction's durable job outlives its request: the connector answers only
   * after the job settles, so a slow job can outrun the request timeout while the
   * transcript already shows it running. The job's events settle the mutation.
   */
  const compactionWaiters = new Map<string, (outcome: RemoteRequestOutcome) => void>()

  const compactionJob = (mutation: PendingMutation) => {
    if (container.state.activeSessionID !== mutation.sessionID) return undefined
    const job = container.state.view?.messages.find((message) => message.kind === "compaction" && message.jobID === mutation.input.id)
    return job?.kind === "compaction" ? job : undefined
  }

  const settleCompaction = (jobID: string, status: "completed" | "failed" | "unknown", detail?: string): RemoteRequestOutcome => {
    const mutation = container.state.mutations.find((entry) => entry.kind === "compact" && entry.input.id === jobID && entry.state === "sending")
    const waiter = compactionWaiters.get(jobID)
    compactionWaiters.delete(jobID)
    const message = detail ?? (status === "failed" ? "Compaction failed" : "The connection closed before the compaction settled")
    const outcome: RemoteRequestOutcome = status === "completed" ? { status: "ok", value: undefined }
      : status === "failed" ? { status: "failed", error: { code: "internal_error", message } }
      : { status: "unknown", error: { code: "outcome_unknown", message } }
    if (mutation !== undefined && status === "completed")
      setState({ mutations: container.state.mutations.filter((entry) => entry.id !== mutation.id),
        mutationToasts: (container.state.mutationToasts ?? []).filter((entry) => entry.id !== mutation.id) })
    if (mutation !== undefined && status !== "completed")
      finishMutation(mutation.id, status, status === "failed" ? message : `Outcome unknown: ${message}. Retry only if you want to send it again.`)
    waiter?.(outcome)
    return outcome
  }

  const finishMutation = (id: string, mutationState: PendingMutation["state"], detail: string) => {
    const progress = sends.get(id)
    const mutation = container.state.mutations.find((entry) => entry.id === id) ?? progress?.mutation
    if (mutation === undefined) return
    if (progress !== undefined) progress.mutation = { ...mutation, state: mutationState, detail }
    if (progress !== undefined && progress.deviceID !== container.state.activeDeviceID) return
    setState({
      mutations: container.state.mutations.map((entry) => (entry.id === id ? { ...entry, state: mutationState, detail } : entry)),
      mutationToasts: [...(container.state.mutationToasts ?? []).filter((entry) => entry.id !== id), { id, label: mutation.label, state: mutationState === "unknown" ? "unknown" as const : "failed" as const, detail, sessionID: mutation.sessionID }].slice(-3),
    })
  }

  const reconcileSessionStatus = (view: SessionView, status: NonNullable<RemoteStoreState["sessionStatus"]>, parentID?: string): SessionView => {
    if (parentID !== undefined && !container.state.sessions.some((row) => row.id === parentID) &&
      !container.state.carouselSessions?.some((row) => row.id === parentID)) return view
    if (view.status === "failed" || view.status === "interrupted") return view
    if (parentID === undefined && status.running.has(view.id)) return view.status === "running" ? view : { ...view, status: "running" }
    if (status.running.has(parentID ?? view.id)) return view
    if (view.status !== "running" && view.executionStarted === undefined) return view
    return { ...clearAssistantRetry(view), status: "idle", executionStarted: undefined }
  }

  /**
   * Applies a canonical snapshot. A body that is not a session projection, or a
   * snapshot below the projection's durable watermark, is refused so the visible
   * transcript is never erased or rewound.
   */
  const applySnapshot = (sessionID: string, payload: unknown, base: SessionView | undefined, streamed: ReadonlyMap<string, string>): { readonly view: SessionView; readonly sealedKeys: readonly string[]; readonly before?: string; readonly coveredAssistantIDs: readonly string[]; readonly parentID?: string } | "invalid" | "stale" => {
    const snapshot = readSnapshot(payload)
    if (snapshot === undefined || snapshot.watermark === undefined) return "invalid"
    if (base?.watermark !== undefined && snapshot.watermark !== undefined && snapshot.watermark < base.watermark) {
      return "stale"
    }
    const combined = base === undefined ? snapshot.messages : [
      ...base.messages.filter((message) => (olderMessageIDs.has(message.id) || message.kind === "oversized" && message.state === "pending" || message.kind === "user" && message.state === "pending" || message.kind === "synthetic" && message.pending === true) && !snapshot.messages.some((fresh) => fresh.id === message.id)),
      ...snapshot.messages,
    ]
    const projected: SessionView = {
      ...(base ?? createSessionView(sessionID)),
      id: sessionID,
      messages: visibleTranscript(combined),
      generationSpeed: snapshot.generationSpeed,
      contextWindow: snapshot.contextWindow,
      ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
      ...(snapshot.agent === undefined ? {} : { agent: snapshot.agent }),
      ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
      ...(snapshot.archived === undefined ? {} : { archived: snapshot.archived }),
      watermark: snapshot.watermark,
      ...(snapshot.sourceEpoch === undefined ? {} : { sourceEpoch: snapshot.sourceEpoch }),
    }
    const unsynced = container.state.mutations.flatMap((mutation): RemoteMessageView[] => {
      if (mutation.kind !== "prompt" && mutation.kind !== "command" || mutation.sessionID !== sessionID || projected.messages.some((message) => message.id === mutation.id)) return []
      const text = mutationText(mutation)
      if (typeof text !== "string") return []
      return [{ kind: "user", id: mutation.id, text,
        delivery: mutation.input.delivery === "queue" ? "queue" : "steer", state: "pending", created: mutation.created ?? now() }]
    })
    const resident = unsynced.length === 0 ? projected : { ...projected, messages: visibleTranscript([...projected.messages, ...unsynced]) }
    const view = container.state.sessionStatus === undefined ? resident : reconcileSessionStatus(resident, container.state.sessionStatus,
      snapshot.parentID ?? (container.state.selectedSessionInfo?.id === sessionID ? container.state.selectedSessionInfo.parentID : undefined))
    return { view: { ...view, messages: carryStreamedText(view.messages, streamed) }, sealedKeys: sealedPartKeys(view.messages), before: snapshot.before, coveredAssistantIDs: [...new Set([
      ...snapshot.coveredAssistantIDs,
      ...combined.flatMap((message) => message.kind === "assistant" && !view.messages.some((retained) => retained.id === message.id) ? [message.id] : []),
    ])], parentID: snapshot.parentID }
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
    try {
      const outcome = await owner.request("session.todo.list", { sessionID, timeoutMs: 5_000 }).catch(() => undefined)
      if (token !== selectionToken || !isCurrentConnection(owner) || container.state.activeSessionID !== sessionID || todoRead !== read) return
      const loaded = outcome?.status === "ok" ? readTodos(typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined) : undefined
      setState({ todos: read.live ?? (loaded === undefined ? container.state.todos : reuseTodos(container.state.todos, loaded)) })
    } finally { if (todoRead === read) todoRead = undefined }
  }

  const loadPendingInputs = async (owner: RemoteTransport, sessionID: string, token: number) => {
    const read = { sessionID, token, promoted: new Set<string>() }
    pendingRead = read
    try {
      const outcome = await owner.request("session.pending.list", { sessionID })
      if (token !== selectionToken || !isCurrentConnection(owner) || container.state.activeSessionID !== sessionID || pendingRead !== read || !container.state.view) return
      if (outcome.status === "failed") {
        setState({ notice: outcome.error.code === "unknown_operation"
          ? "Update the connected device to restore pending prompts."
          : describeOutcome(outcome, "Pending prompts") })
        return
      }
      const pending = outcome.status === "ok" ? readPendingInputs(outcome.value, sessionID) : undefined
      if (pending === undefined) return
      const retained = new Set(container.state.mutations.filter((mutation) => mutation.sessionID === sessionID && (mutation.kind === "prompt" || mutation.kind === "command")).map((mutation) => mutation.id))
      const confirmed = new Set([...pending.map((entry) => entry.id),
        ...container.state.view.messages.flatMap((message) => message.kind === "user" && message.state !== "pending" || message.kind === "synthetic" && !message.pending ? [message.id] : [])])
      const resolved = container.state.mutations.filter((mutation) => (mutation.kind === "prompt" || mutation.kind === "command") && mutation.sessionID === sessionID && confirmed.has(mutation.id) &&
        (!sends.has(mutation.id) || confirmSend(mutation.id)))
      setState({ view: reconcilePendingInputs(container.state.view, pending.filter((entry) => !read.promoted.has(entry.id)), retained),
        mutations: container.state.mutations.filter((mutation) => !resolved.includes(mutation)),
        mutationToasts: container.state.mutationToasts?.filter((toast) => !resolved.some((mutation) => mutation.id === toast.id)) })
    } finally { if (pendingRead === read) pendingRead = undefined }
  }

  const loadSessionReads = async (sessionID: string, token: number, notice?: string) => {
    const active = transport
    if (!active) return
    const requestsDuringRead = { sessionID, live: [] as { readonly event: unknown; readonly at: number }[] }
    requestReads.add(requestsDuringRead)
    void loadTodos(active, sessionID, token)
    try {
      const [autonomy, permissions, guardrails, forms] = await Promise.all([
        active.request("session.autonomy.get", { sessionID }),
        active.request("session.permission.list", { sessionID }),
        active.request("session.guardrail.request.list", { sessionID }),
        active.request("session.form.list", { sessionID }),
      ])
      if (token !== selectionToken || container.state.activeSessionID !== sessionID) return
      const view = container.state.view
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
      const failure = [autonomy, permissions, guardrails, forms].find(
        (outcome) => outcome.status !== "ok",
      )
      setState({
        view:
          autonomy.status === "ok"
            ? { ...withRequests, autonomy: readAutonomy(autonomy.value) ?? withRequests.autonomy }
            : withRequests,
        ...(notice === undefined
          ? failure === undefined
            ? {}
            : { notice: describeOutcome(failure, "Session state") }
          : { notice }),
      })
    } finally {
      requestReads.delete(requestsDuringRead)
    }
  }

  const loadCapturedChanges = async (owner: RemoteTransport, sessionID: string, token: number) => {
    if (capturedUnsupported) return
    const read = { owner, sessionID, token }
    capturedRead = read
    lastCapturedRead = now()
    const groups = [] as NonNullable<SessionView["capturedChanges"]>[number][]
    const seen = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const outcome = await owner.request("session.capturedChanges.list", { sessionID, ...(cursor === undefined ? {} : { input: { cursor } }) })
      if (capturedRead !== read || token !== selectionToken || !isCurrentConnection(owner) || container.state.activeSessionID !== sessionID) return
      if (outcome.status === "failed" && outcome.error.code === "unknown_operation") capturedUnsupported = true
      const page = outcome.status === "ok" ? readCapturedChangesPage(outcome.value) : undefined
      if (page === undefined) {
        setState({ view: container.state.view?.id === sessionID ? { ...container.state.view, capturedChanges: undefined } : container.state.view })
        if (capturedRead === read) capturedRead = undefined
        return
      }
      groups.push(...page.data)
      cursor = page.cursor?.next
      if (cursor === undefined || seen.has(cursor)) break
      seen.add(cursor)
    }
    if (capturedRead === read) capturedRead = undefined
    if (cursor !== undefined || container.state.view?.id !== sessionID) return
    setState({ view: { ...container.state.view, capturedChanges: groups } })
  }

  const scheduleCapturedRefresh = () => {
    if (capturedUnsupported || cancelCapturedRefresh || transport === undefined || container.state.activeSessionID === undefined) return
    const owner = transport
    const sessionID = container.state.activeSessionID
    const token = selectionToken
    cancelCapturedRefresh = schedule(() => {
      cancelCapturedRefresh = undefined
      if (isCurrentConnection(owner) && token === selectionToken && container.state.activeSessionID === sessionID) void loadCapturedChanges(owner, sessionID, token)
    }, Math.max(0, 10_000 - (now() - lastCapturedRead)))
  }

  /**
   * Reads one explicit page of a shell's captured output for the session that owns it.
   * One user request reads one page: there is no automatic paging loop, so a running
   * command whose tail is an incomplete character is reported as stalled for the user to
   * retry rather than polled. A page is applied only while the selection that opened the
   * read still owns the view, so a late page cannot land on another session or connection.
   */
  const loadShellOutputPage = async (shellID: string) => {
    const sessionID = container.state.activeSessionID
    const view = container.state.view
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
    if (token !== selectionToken || container.state.activeSessionID !== sessionID) return
    const current = container.state.view
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
  const readSnapshotPayload = async (sessionID: string, before?: string): Promise<RemoteRequestOutcome | undefined> => {
    const active = transport
    if (!active) return undefined
    return active.request("session.snapshot", { sessionID, input: { limit: historyPageSize, ...(before === undefined ? {} : { before }) } })
  }

  const loadCompactionHistory = async (sessionID: string, token: number) => {
    const owner = transport
    if (!owner || token !== selectionToken || container.state.activeSessionID !== sessionID || compactionAttemptedToken === token ||
      !container.state.view?.messages.some((message) => message.kind === "compaction" && message.jobID && message.status !== "pending")) return
    compactionAttemptedToken = token
    const read = { token, live: [] as { readonly event: unknown; readonly at: number }[] }
    compactionRead = read
    try {
      const outcome = await owner.request("session.compaction.list", { sessionID, timeoutMs: 5_000 }).catch(() => undefined)
      if (token !== selectionToken || compactionRead !== read || container.state.activeSessionID !== sessionID || outcome?.status !== "ok" || container.state.view === undefined) return
      const loaded = readCompactionHistory(outcome.value)
      if (loaded === undefined) return
      const current = read.live.reduce<SessionView>((view, item) => applySessionEvent(view, item.event, item.at),
        { ...createSessionView(sessionID), compactionHistory: loaded })
      setState({ view: { ...container.state.view, compactionHistory: current.compactionHistory } })
    } finally { if (compactionRead === read) compactionRead = undefined }
  }

  const historyFailure = (outcome: Exclude<RemoteRequestOutcome, { status: "ok" }>) =>
    outcome.status === "failed" && (outcome.error.code === "invalid_message" || outcome.error.code === "unknown_operation")
      ? "Update the connected device to read windowed Session history."
      : outcome.status === "failed" && outcome.error.code === "message_too_large"
        ? `This history page contains a message too large to load. ${outcome.error.message}`
        : describeOutcome(outcome, "Session history")

  const loadOlderMessages = async () => {
    const sessionID = container.state.activeSessionID
    const before = container.state.history?.before
    const owner = transport
    if (!sessionID || !before || !owner || container.state.history?.status === "loading") return
    if (hasCompactionCheckpoint(container.state.view?.messages ?? [])) {
      setState({ history: { status: "idle" } })
      return
    }
    const token = selectionToken
    setState({ history: { status: "loading", before } })
    const outcome = await readSnapshotPayload(sessionID, before)
    if (token !== selectionToken || !isCurrentConnection(owner) || container.state.activeSessionID !== sessionID || container.state.history?.before !== before) return
    if (outcome === undefined || outcome.status !== "ok") {
      setState({ history: { status: "error", before, error: outcome === undefined ? notConnectedPage : historyFailure(outcome) } })
      return
    }
    const page = readSnapshot(outcome.value)
    if (page === undefined || page.watermark === undefined) {
      setState({ history: { status: "error", before, error: "The older history page was not readable." } })
      return
    }
    const view = container.state.view
    if (view === undefined) return
    olderMessageIDs = new Set([...olderMessageIDs, ...page.messages.map((message) => message.id)])
    const existing = new Set(page.messages.map((message) => message.id))
    const messages = visibleTranscript([...page.messages, ...view.messages.filter((message) => !existing.has(message.id))])
    setState({ view: { ...view, messages },
      history: { status: "idle", ...(hasCompactionCheckpoint(messages) || page.before === undefined ? {} : { before: page.before }) } })
    void loadCompactionHistory(sessionID, token)
  }

  const loadOversizedMessage = async (messageID: string) => {
    const sessionID = container.state.activeSessionID
    const deviceID = container.state.activeDeviceID
    const owner = transport
    const token = selectionToken
    if (!sessionID || !deviceID || !owner || oversizedReads.has(messageID) ||
      !container.state.view?.messages.some((message) => message.kind === "oversized" && message.id === messageID)) return
    const controller = new AbortController()
    oversizedReads.set(messageID, controller)
    setState({ view: { ...container.state.view, messages: container.state.view.messages.map((message) => message.kind === "oversized" && message.id === messageID ? { ...message, state: "loading" } : message) } })
    try {
      const response = await fetchContent(`/api/remote/devices/${encodeURIComponent(deviceID)}/sessions/${encodeURIComponent(sessionID)}/messages/${encodeURIComponent(messageID)}`,
        { credentials: "same-origin", signal: controller.signal })
      if (response.status === 404 && token === selectionToken && isCurrentConnection(owner) && container.state.activeSessionID === sessionID && container.state.view) {
        const current = container.state.view.messages.find((entry) => entry.id === messageID)
        if (current?.kind === "oversized" && !current.projected) {
          setState({ view: { ...container.state.view, messages: container.state.view.messages.map((entry) => entry.id === messageID && entry.kind === "oversized" ? { ...entry, state: "pending" } : entry) } })
          return
        }
      }
      if (response.status === 503) {
        const payload: unknown = await response.json().catch(() => undefined)
        const error = payload && typeof payload === "object" ? Reflect.get(payload, "error") : undefined
        if (error && typeof error === "object" && Reflect.get(error, "code") === "unknown_operation" &&
          token === selectionToken && isCurrentConnection(owner) && container.state.activeSessionID === sessionID)
          setState({ notice: "Update the connected device to read full Session content." })
      }
      if (!response.ok) throw new Error("Projected message unavailable")
      const message = readProjectedMessage(await response.json())
      if (message === undefined || message.id !== messageID) throw new Error("Invalid projected message")
      if (token !== selectionToken || !isCurrentConnection(owner) || container.state.activeSessionID !== sessionID || controller.signal.aborted || !container.state.view) return
      setState({ view: { ...container.state.view, messages: container.state.view.messages.some((entry) => entry.id === messageID)
        ? container.state.view.messages.map((entry) => entry.id === messageID ? message : entry)
        : [...container.state.view.messages, message] } })
    } catch {
      if (token === selectionToken && isCurrentConnection(owner) && container.state.activeSessionID === sessionID && !controller.signal.aborted && container.state.view)
        setState({ view: { ...container.state.view, messages: container.state.view.messages.map((entry) => entry.kind === "oversized" && entry.id === messageID ? { ...entry, state: "error" } : entry) } })
    } finally {
      if (oversizedReads.get(messageID) === controller) oversizedReads.delete(messageID)
    }
  }

  const reloadSnapshot = async (
    sessionID: string | undefined,
    token: number,
  ): Promise<"applied" | "refused" | "unavailable"> => {
    if (sessionID === undefined || container.state.activeSessionID !== sessionID) return "unavailable"
    const owned: HydrationWindow = { sessionID, events: [], replayed: new Set(), streamed: streamedPartText(container.state.view?.id === sessionID ? container.state.view.messages : []) }
    hydration = owned
    try {
      const outcome = await readSnapshotPayload(sessionID)
      if (token !== selectionToken || container.state.activeSessionID !== sessionID || outcome === undefined) {
        return "unavailable"
      }
      if (outcome.status !== "ok") {
        setState({ notice: historyFailure(outcome) })
        return "unavailable"
      }
      const applied = applySnapshot(sessionID, outcome.value, container.state.view, owned.streamed)
      if (applied === "invalid") {
        setState({ notice: "The session snapshot was not readable, so the current history is kept." })
        return "refused"
      }
      if (applied === "stale") {
        setState({ notice: "An older session snapshot arrived and was ignored." })
        return "refused"
      }
      sealed = { sessionID, parts: new Set(applied.sealedKeys), covered: new Set(applied.coveredAssistantIDs) }
      let view = applied.view
      for (const event of owned.events) view = applyEvent(view, event, true)
      owned.replayed.forEach((key) => sealed?.parts.delete(key))
      setState({ view, history: { status: "idle", ...(hasCompactionCheckpoint(view.messages) || applied.before === undefined ? {} : { before: applied.before }) } })
      void loadCompactionHistory(sessionID, token)
      view.messages.filter((message) => message.kind === "oversized" && message.state === "pending").forEach((message) => { void loadOversizedMessage(message.id) })
      const owner = transport
      if (teamWatching && owner !== undefined && container.state.team !== undefined) void loadTeam(owner, token, container.state.team.rootID, undefined, true)
      return "applied"
    } finally {
      if (hydration === owned) hydration = undefined
    }
  }

  const listFailure = (outcome: Exclude<RemoteRequestOutcome, { status: "ok" }>, label: string): Pick<RemoteStoreState, "connection"> => {
    if (outcome.status === "failed" && outcome.error.code === "agent_unavailable") {
      reportMachineOffline()
      return { connection: { kind: "offline", deviceName: deviceName(container.state.activeDeviceID ?? "device") } }
    }
    return { connection: { kind: "error", message: describeOutcome(outcome, label) } }
  }

  const recoveredConnection = (owner: RemoteTransport): Partial<Pick<RemoteStoreState, "connection">> => {
    if (owner.status().kind === "open") offlineDeviceID = undefined
    return container.state.connection.kind === "offline" || container.state.connection.kind === "error"
      ? { connection: connectionFor(owner.status(), container.state.activeDeviceID) }
      : {}
  }

  const sortSessions = <T extends SessionInfoView>(rows: readonly T[]) => [...new Map(rows.map((row) => [row.id, row])).values()].sort((left, right) => {
    if (!!left.running !== !!right.running) return left.running ? -1 : 1
    const activity = (right.activeAt ?? right.updatedAt) - (left.activeAt ?? left.updatedAt)
    return activity || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  })

  const withOpenRoot = (rows: readonly SessionInfoView[]) => {
    if (container.state.sessionQuery.trim() !== "" || container.state.sessionFilter !== "all") return rows
    const root = openRootInfo
    const workspace = container.state.sessionGroups.find((group) => group.id === container.state.selectedWorkspaceID)
    if (!root || !workspace || root.archived || root.projectID !== workspace.projectID || root.directory !== workspace.directory || root.workspaceID !== workspace.workspaceID || rows.some((row) => row.id === root.id)) return rows
    return sortSessions([{ ...root, ...(container.state.sessionStatus ? rowStatus(container.state.sessionStatus, root.id) : {}) }, ...rows])
  }

  const rowStatus = (status: NonNullable<RemoteStoreState["sessionStatus"]>, id: string) => ({
    running: status.running.has(id), attention: status.attention.has(id) && !status.failed.has(id), failed: status.failed.has(id),
  })

  const publishSessionStatus = (status: NonNullable<RemoteStoreState["sessionStatus"]>) => {
    const rows = sessionPages.map((page) => ({ ...page, rows: page.rows.map((row) => ({ ...row, ...rowStatus(status, row.id) })) }))
    sessionPages = rows
    setState({ sessionStatus: status, sessions: withOpenRoot(sortSessions(rows.flatMap((page) => page.rows))),
      ...(container.state.view === undefined ? {} : { view: reconcileSessionStatus(container.state.view, status,
        container.state.selectedSessionInfo?.id === container.state.view.id ? container.state.selectedSessionInfo.parentID : undefined) }),
      carouselSessions: sortSessions(container.state.carouselSessions?.map((row) => ({ ...row, running: status.running.has(row.id) })) ?? []) })
  }

  const readSessionStatus = async (owner: RemoteTransport) => {
    if (statusReadOwner === owner) return
    statusReadOwner = owner
    statusReadPending = true
    const revision = statusFrameRevision
    let outcome: RemoteRequestOutcome | undefined
    try {
      outcome = await owner.request("session.status")
    } catch {
      console.error("Session status read failed")
    } finally {
      if (statusReadOwner === owner) statusReadPending = false
    }
    if (!isCurrentConnection(owner)) return
    if (revision !== statusFrameRevision || (statusBaseline && container.state.sessionStatus !== undefined)) {
      if (statusReloadLocal || carouselRefreshPending) void reloadStatusFirstPage(owner)
      return
    }
    const status = outcome?.status === "ok" ? parseSessionStatus(outcome.value) : undefined
    if (status !== undefined) {
      statusBaseline = true
      publishSessionStatus(status)
    }
    carouselRevision += 1
    carouselRefreshPending = true
    void reloadStatusFirstPage(owner)
  }

  const applyStatusFrame = (owner: RemoteTransport, frame: { readonly running: readonly string[]; readonly attention: readonly string[]; readonly outstanding?: readonly string[]; readonly failed?: readonly string[] }) => {
    if (!isCurrentConnection(owner)) return
    signalRecovery()
    statusFrameRevision += 1
    const status = { running: new Set(frame.running), attention: new Set(frame.attention), outstanding: new Set(frame.outstanding ?? []), failed: new Set(frame.failed ?? []) }
    const previous = container.state.sessionStatus
    const runningChanged = previous === undefined || previous.running.size !== status.running.size ||
      [...status.running].some((id) => !previous.running.has(id))
    const changed = previous === undefined || previous.running.size !== status.running.size || previous.attention.size !== status.attention.size ||
      previous.outstanding.size !== status.outstanding.size || [...status.outstanding].some((id) => !previous.outstanding.has(id)) ||
      [...status.running].some((id) => !previous.running.has(id)) || [...status.attention].some((id) => !previous.attention.has(id))
    statusBaseline = true
    publishSessionStatus(status)
    if (runningChanged) {
      carouselRevision += 1
      carouselRefreshPending = true
      if (teamWatching && container.state.team !== undefined && container.state.team.shellStatus !== "unsupported") void loadTeamShells(owner, selectionToken, container.state.team.rootID)
    }
    if (changed && [...status.running, ...status.attention, ...status.outstanding].some((id) => !container.state.sessions.some((row) => row.id === id))) statusReloadLocal = true
    if (statusReloadLocal || carouselRefreshPending) void reloadStatusFirstPage(owner)
  }

  const reloadStatusFirstPage = async (owner: RemoteTransport) => {
    if (!isCurrentConnection(owner) || (!statusReloadLocal && !carouselRefreshPending)) return
    if (container.state.selectedWorkspaceID === undefined && !carouselRefreshPending) return
    if (statusReloading) return
    const now = monotonicNow()
    const loadLocal = statusReloadLocal && container.state.selectedWorkspaceID !== undefined && loadingPageToken !== sessionsToken && now - lastStatusReload >= 5_000
    const waitingForStatus = statusReadOwner === owner && statusReadPending && !statusBaseline
    if (waitingForStatus && !statusReloadLocal) return
    const loadCarousel = carouselRefreshPending && !waitingForStatus && now - lastCarouselReload >= 5_000
    if (!loadLocal && !loadCarousel) {
      const localDelay = statusReloadLocal ? loadingPageToken === sessionsToken ? 50 : Math.max(1, Math.ceil(5_000 - (now - lastStatusReload))) : Infinity
      const carouselDelay = carouselRefreshPending && !waitingForStatus ? Math.max(1, Math.ceil(5_000 - (now - lastCarouselReload))) : Infinity
      cancelStatusReload?.()
      cancelStatusReload = schedule(() => {
        cancelStatusReload = undefined
        if (isCurrentConnection(owner)) void reloadStatusFirstPage(owner)
      }, Math.min(localDelay, carouselDelay))
      return
    }
    statusReloading = true
    if (loadLocal) { statusReloadLocal = false; lastStatusReload = now }
    if (loadCarousel) { carouselRefreshPending = false; lastCarouselReload = now }
    try {
      await Promise.all([
        ...(loadLocal ? [loadSessions(sessionsToken)] : []),
        ...(loadCarousel ? [loadCarouselSessions(owner, carouselRevision)] : []),
      ])
    } finally {
      statusReloading = false
      if (statusReloadLocal || carouselRefreshPending) void reloadStatusFirstPage(owner)
    }
  }

  const loadCarouselSessions = async (owner: RemoteTransport, revision: number) => {
    if (container.state.carouselSessions?.length === 0 && container.state.carouselStatus !== "loading" && container.state.carouselStatus !== "ready") setState({ carouselStatus: "loading" })
    const rows = (value: unknown, running: boolean) => readSessionInfoList(value).flatMap((entry) => {
      const session = readSessionInfo(entry)
      return session !== undefined && session.parentID === undefined ? [{ ...session, running }] : []
    })
    const withWorkspaceNames = (sessions: readonly (SessionInfoView & { readonly running: boolean })[]) => sessions.map((row) => ({ ...row,
      workspaceName: container.state.sessionGroups.find((group) => group.projectID === row.projectID && group.directory === row.directory && group.workspaceID === row.workspaceID)?.name
        ?? row.directory?.split("/").filter(Boolean).at(-1) ?? row.projectID ?? "Workspace" }))
    const current = await owner.request("session.list", { input: { limit: carouselLimit, order: "active", status: "running", parentID: null } })
    if (!isCurrentConnection(owner) || revision !== carouselRevision) return
    if (current.status !== "ok") {
      setState({ notice: describeOutcome(current, "Running Sessions"), carouselStatus: "error" })
      return
    }
    const running = sortSessions(rows(current.value, true)).slice(0, carouselLimit)
    const recent = running.length === carouselLimit ? undefined : await owner.request("session.list", { input: { limit: carouselLimit, order: "active", status: "idle", parentID: null } })
    if (!isCurrentConnection(owner) || revision !== carouselRevision) return
    if (recent !== undefined && recent.status !== "ok") {
      setState({ notice: describeOutcome(recent, "Recent Sessions"), carouselSessions: withWorkspaceNames(running), carouselStatus: "error" })
      return
    }
    const combined = sortSessions([...running, ...(recent === undefined ? [] : rows(recent.value, false))]).slice(0, carouselLimit)
    setState({ carouselSessions: withWorkspaceNames(combined), carouselStatus: "ready" })
  }

  const loadSessions = async (token: number, cursor?: string, direction: "next" | "previous" = "next") => {
    const active = transport
    const workspace = container.state.selectedWorkspaceID
    if (!active || workspace === undefined || loadingPageToken === token) return
    loadingPageToken = token
    setState({ sessionPageLoading: cursor !== undefined, ...(cursor === undefined ? { sessionListStatus: "loading" as const } : {}) })
    const listed = await active.request("session.list", { input: {
        workspace,
        limit: sessionPageSize,
        order: "active",
        parentID: null,
        searchFields: "summary",
        ...(container.state.sessionQuery.trim() === "" ? {} : { search: container.state.sessionQuery.trim() }),
        ...(container.state.sessionFilter === "all" ? {} : { status: container.state.sessionFilter }),
        ...(cursor === undefined ? {} : { cursor }),
      } })
    if (loadingPageToken === token) loadingPageToken = undefined
    if (token !== sessionsToken || !isCurrentConnection(active) || workspace !== container.state.selectedWorkspaceID) return
    if (listed.status !== "ok") {
      setState({ ...listFailure(listed, "Session list"), sessionListStatus: "error", sessionPageLoading: false })
      return
    }
    const rows = readSessionInfoList(listed.value).flatMap((entry) => {
      const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined
      const info = readSessionInfo(entry,
        container.state.sessionStatus === undefined || typeof id !== "string" ? {} : rowStatus(container.state.sessionStatus, id))
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
    const sessions = withOpenRoot(sortSessions(sessionPages.flatMap((item) => item.rows))).map((item) => {
      const previous = container.state.sessions.find((row) => row.id === item.id)
      return previous !== undefined && JSON.stringify(previous) === JSON.stringify(item) ? previous : item
    })
    setState({
      ...recoveredConnection(active),
      sessions,
      advertised: sessions.map((session) => session.id),
      selectedSessionInfo: sessions.find((session) => session.id === container.state.activeSessionID) ?? container.state.selectedSessionInfo,
      sessionListStatus: "ready",
      sessionRowsStale: false,
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
    const selectedWorkspaceID = groups.some((group) => group.id === container.state.selectedWorkspaceID)
      ? container.state.selectedWorkspaceID : groups[0]?.id
    const sameWorkspace = selectedWorkspaceID === container.state.selectedWorkspaceID
    if (!sameWorkspace) sessionPages = []
    setState({ ...recoveredConnection(owner), sessionGroups: groups, selectedWorkspaceID,
      carouselSessions: container.state.carouselSessions?.map((row) => ({ ...row, workspaceName: groups.find((group) =>
        group.projectID === row.projectID && group.directory === row.directory && group.workspaceID === row.workspaceID)?.name ?? row.workspaceName })),
      ...(sameWorkspace ? {} : { sessions: [], advertised: [], sessionRowsStale: false, sessionHasNext: false, sessionHasPrevious: false }),
      sessionListStatus: selectedWorkspaceID === undefined ? "ready" : "loading" })
    if (selectedWorkspaceID !== undefined) await loadSessions(token)
    if (statusReloadLocal || carouselRefreshPending) void reloadStatusFirstPage(owner)
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

  const selectSession = async (sessionID: string, verified?: SessionInfoView) => {
    cancelCapturedRefresh?.()
    cancelCapturedRefresh = undefined
    capturedRead = undefined
    lastCapturedRead = -Infinity
    if (container.state.activeSessionID !== sessionID) clearImageSources()
    oversizedReads.forEach((controller) => controller.abort())
    oversizedReads.clear()
    if (activeUpload) cancelUpload("Attachment upload was cancelled by Session selection. Files were not sent.")
    const active = transport
    // One selection owns the view; a superseded selection never writes state again.
    const token = ++selectionToken
    olderMessageIDs = new Set()
    const resetSessionList = container.state.sessionQuery.trim() !== "" || container.state.sessionFilter !== "all"
    if (resetSessionList) {
      cancelSearch?.()
      cancelSearch = undefined
      sessionsToken += 1
      sessionPages = []
      setState({ sessionQuery: "", sessionFilter: "all", sessions: [], advertised: [], sessionListStatus: "loading", sessionRowsStale: false, sessionHasNext: false, sessionHasPrevious: false })
    }
    selectionReadyToken = undefined
    selectionFailedToken = undefined
    const previousRootID = container.state.team?.rootID
    const known = verified ?? container.state.sessions.find((session) => session.id === sessionID) ?? container.state.carouselSessions?.find((session) => session.id === sessionID) ??
      (container.state.selectedSessionInfo?.id === sessionID ? container.state.selectedSessionInfo : undefined)
    const rootHint = container.state.team?.tasks.find((task) => task.sessionID === sessionID)?.parentID ?? (sessionID === previousRootID ? previousRootID : undefined)
    const info = known ?? { id: sessionID, title: sessionID, updatedAt: 0, archived: false, ...(rootHint === undefined ? {} : { parentID: rootHint }) }
    const rootID = info.parentID ?? sessionID
    if (openRootInfo?.id !== rootID) openRootInfo = (rootID === sessionID ? known : container.state.sessions.find((item) => item.id === rootID) ?? container.state.carouselSessions?.find((item) => item.id === rootID))
    const sameFamily = previousRootID === rootID && container.state.team?.status === "ready"
    const retainedTeam = teamWatching ? sameFamily ? container.state.team : emptyTeam(rootID, "loading") : undefined
    setState({ activeSessionID: sessionID, selectedSessionInfo: info,
      view: createSessionView(sessionID), team: retainedTeam,
      familyActivity: activityWatching ? sameFamily ? container.state.familyActivity : { rootID, status: "loading", members: [] } : undefined,
      teamCues: sameFamily ? container.state.teamCues : [], todos: undefined, history: undefined, notice: undefined })
    if (!active) {
      selectionFailedToken = token
      if (teamWatching) setState({ team: emptyTeam(rootID, "error") })
      return
    }
    if (known === undefined) {
      const lookedUp = await active.request("session.get", { sessionID, timeoutMs: 5_000 })
      if (token !== selectionToken || !isCurrentConnection(active)) return
      const value = lookedUp.status === "ok" && typeof lookedUp.value === "object" && lookedUp.value !== null ? Reflect.get(lookedUp.value, "data") : undefined
      const resolved = readSessionInfo(value)
      if (resolved?.id === sessionID) {
        setState({ selectedSessionInfo: resolved })
        if (resolved.parentID === undefined) openRootInfo = resolved
      }
    }
    const selectedInfo = container.state.selectedSessionInfo
    const selectedRootID = selectedInfo?.parentID ?? sessionID
    if (selectedRootID !== sessionID && openRootInfo?.id !== selectedRootID) {
      const parent = await active.request("session.get", { sessionID: selectedRootID, timeoutMs: 5_000 })
      if (token !== selectionToken || !isCurrentConnection(active)) return
      const value = parent.status === "ok" && typeof parent.value === "object" && parent.value !== null ? Reflect.get(parent.value, "data") : undefined
      const resolved = readSessionInfo(value)
      if (resolved?.id === selectedRootID && resolved.parentID === undefined) openRootInfo = resolved
    }
    const rootInfo = openRootInfo?.id === selectedRootID ? openRootInfo : selectedInfo
    const group = container.state.sessionGroups.find((candidate) => candidate.projectID === rootInfo?.projectID && candidate.directory === rootInfo.directory && candidate.workspaceID === rootInfo.workspaceID)
    const workspaceChanged = group !== undefined && group.id !== container.state.selectedWorkspaceID
    const refreshList = resetSessionList || container.state.sessionListStatus === "loading" && sessionPages.length === 0 && loadingPageToken === undefined
    if (workspaceChanged || refreshList && container.state.selectedWorkspaceID !== undefined) {
      if (workspaceChanged && !resetSessionList) sessionsToken += 1
      sessionPages = []
      setState({ ...(workspaceChanged ? { selectedWorkspaceID: group.id } : {}), sessions: [], advertised: [], sessionListStatus: "loading", sessionHasNext: false, sessionHasPrevious: false })
      void loadSessions(sessionsToken)
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
      if (token !== selectionToken || container.state.activeSessionID !== sessionID) return
      selectionFailedToken = token
      setState({ notice: "This session is not available from the connected device.",
        ...(teamWatching ? { team: emptyTeam(rootID, "error") } : {}) })
      return
    }
    if (token !== selectionToken || container.state.activeSessionID !== sessionID) {
      // A superseded selection registered a subscription this store no longer shows.
      releaseSubscription(active, sessionID)
      return
    }
    const previous = subscribedSessionID
    subscribedSessionID = sessionID
    if (previous !== undefined && previous !== sessionID) releaseSubscription(active, previous)
    const owned: HydrationWindow = { sessionID, events: [], replayed: new Set(), streamed: streamedPartText(container.state.view?.id === sessionID ? container.state.view.messages : []) }
    hydration = owned
    const continueWithoutHistory = async (notice: string) => {
      if (hydration === owned) hydration = undefined
      selectionReadyToken = token
      setState({ notice, ...(teamWatching && !sameFamily ? { team: emptyTeam(rootID, "loading") } : {}) })
      if (teamWatching && !sameFamily) void loadTeam(active, token, rootID)
      if (sameFamily && activityWatching) void loadFamilyActivity(active, rootID)
      void loadCapturedChanges(active, sessionID, token)
      await Promise.all([loadSessionReads(sessionID, token), loadPendingInputs(active, sessionID, token)])
    }
    try {
      const outcome = await readSnapshotPayload(sessionID)
      if (token !== selectionToken || container.state.activeSessionID !== sessionID || outcome === undefined) return
      if (outcome.status !== "ok") {
        return await continueWithoutHistory(historyFailure(outcome))
      }
      const applied = applySnapshot(sessionID, outcome.value, container.state.view, owned.streamed)
      if (applied === "invalid") {
        return await continueWithoutHistory("The session snapshot was not readable, so the current history is kept.")
      }
      if (applied === "stale") {
        return await continueWithoutHistory("An older session snapshot arrived and was ignored.")
      }
      sealed = { sessionID, parts: new Set(applied.sealedKeys), covered: new Set(applied.coveredAssistantIDs) }
      let view = applied.view
      for (const event of owned.events) view = applyEvent(view, event, true)
      owned.replayed.forEach((key) => sealed?.parts.delete(key))
      selectionReadyToken = token
      const teamRootID = applied.parentID ?? container.state.selectedSessionInfo?.parentID ?? sessionID
      const retained = sameFamily && teamRootID === container.state.team?.rootID
      setState({ view, history: { status: "idle", ...(hasCompactionCheckpoint(view.messages) || applied.before === undefined ? {} : { before: applied.before }) }, team: teamWatching ? retained ? container.state.team : emptyTeam(teamRootID, "loading") : undefined,
        familyActivity: activityWatching ? retained ? container.state.familyActivity : { rootID: teamRootID, status: "loading", members: [] } : undefined,
        teamCues: retained ? container.state.teamCues : [],
        selectedSessionInfo: container.state.selectedSessionInfo?.id === sessionID
        ? { ...container.state.selectedSessionInfo, title: view.title ?? container.state.selectedSessionInfo.title, agent: view.agent ?? container.state.selectedSessionInfo.agent,
            model: view.model ?? container.state.selectedSessionInfo.model, modelLabel: modelLabel(view.model) ?? container.state.selectedSessionInfo.modelLabel,
            ...(applied.parentID === undefined ? {} : { parentID: applied.parentID }) }
        : container.state.selectedSessionInfo })
      void loadCompactionHistory(sessionID, token)
      void loadCapturedChanges(active, sessionID, token)
      if (teamWatching && !retained) void loadTeam(active, token, teamRootID)
      if (retained && activityWatching) void loadFamilyActivity(active, teamRootID)
    } finally {
      if (hydration === owned) hydration = undefined
    }
    await Promise.all([loadSessionReads(sessionID, token), loadPendingInputs(active, sessionID, token)])
  }

  const resyncSelected = (): Promise<void> => {
    const owner = transport
    const sessionID = container.state.activeSessionID
    const token = selectionToken
    if (!owner || !sessionID || subscribedSessionID !== sessionID || selectionReadyToken !== token) return Promise.resolve()
    if (resyncRead) {
      if (resyncTarget?.owner === owner && resyncTarget.sessionID === sessionID && resyncTarget.token === token) {
        resyncAgain = true
        return resyncRead
      }
      return resyncRead.then(() => resyncSelected())
    }
    const run = (async () => {
      do {
        resyncAgain = false
        await reloadSnapshot(sessionID, token)
        if (token !== selectionToken || !isCurrentConnection(owner) || container.state.activeSessionID !== sessionID) return
        await Promise.all([loadSessionReads(sessionID, token), loadPendingInputs(owner, sessionID, token)])
      } while (resyncAgain && token === selectionToken && isCurrentConnection(owner))
    })()
    resyncRead = run
    resyncTarget = { owner, sessionID, token }
    void run.then(() => { if (resyncRead === run) { resyncRead = undefined; resyncTarget = undefined } }, () => { if (resyncRead === run) { resyncRead = undefined; resyncTarget = undefined } })
    return run
  }

  const reloadMessages = async () => {
    await resyncSelected()
  }

  const createSession = async (attempt: SessionCreation, reconcile: boolean) => {
    const active = transport
    if (active === undefined || container.state.transport.kind !== "open" || container.state.connection.kind === "offline" || container.state.activeDeviceID !== attempt.deviceID) {
      setState({ sessionCreation: { ...attempt, status: attempt.status === "unknown" ? "unknown" : "failed", message: "Connect to the same machine before creating this session." } })
      return undefined
    }
    setState({ sessionCreation: { ...attempt, status: "creating", message: undefined } })
    const owns = () => isCurrentConnection(active) && container.state.sessionCreation?.id === attempt.id
    const accept = async (value: unknown) => {
      const data = typeof value === "object" && value !== null ? Reflect.get(value, "data") : undefined
      const session = readSessionInfo(data)
      const parentID = typeof data === "object" && data !== null ? Reflect.get(data, "parentID") : undefined
      if (!session || session.id !== attempt.id || session.directory !== attempt.workspace.directory || session.projectID !== attempt.workspace.projectID || parentID !== undefined) {
        setState({ sessionCreation: { ...attempt, status: "unknown", message: "The returned session does not match this workspace. Check Sessions before retrying." } })
        return undefined
      }
      openRootInfo = session
      if (!container.state.sessionGroups.some((group) => group.id === attempt.workspace.id)) setState({ sessionGroups: [...container.state.sessionGroups, attempt.workspace] })
      if (container.state.selectedWorkspaceID !== attempt.workspace.id) {
        sessionsToken += 1
        sessionPages = []
        setState({ selectedWorkspaceID: attempt.workspace.id, sessions: [session], advertised: [session.id], sessionListStatus: "ready", sessionHasNext: false, sessionHasPrevious: false,
          selectedSessionInfo: session })
      }
      await api.selectSession(session.id)
      if (!owns() || container.state.activeSessionID !== session.id) return undefined
      if (attempt.prompt !== undefined) {
        const sent = "command" in attempt.prompt
          ? await api.runCommand({ ...attempt.prompt, delivery: "steer" })
          : await api.sendPrompt({ ...attempt.prompt, delivery: "steer" })
        if (!sent) {
          setState({ sessionCreation: { ...attempt, status: "failed", message: container.state.uploadError ?? "The first message could not be sent. Retry to submit it to this Session." } })
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

  type SendProgress = {
    mutation: PendingMutation
    readonly deviceID: string
    readonly files?: readonly FileAttachmentInput[]
    readonly prerequisites: readonly { readonly operation: RemoteOperation; readonly input: Readonly<Record<string, unknown>>; completed: boolean; attempted: boolean }[]
    uploaded?: readonly FileAttachmentInput[]
    uploadedAt?: number
    uploadsReady: boolean
    running?: Promise<void>
  }
  const sends = new Map<string, SendProgress>()
  const sendPreparation = new Map<string, Promise<void>>()

  const confirmSend = (id: string) => {
    const progress = sends.get(id)
    if (!progress || progress.deviceID !== container.state.activeDeviceID || progress.mutation.kind !== "prompt" && progress.mutation.kind !== "command" ||
      !progress.prerequisites.every((step) => step.completed) || container.state.mutations.find((mutation) => mutation.id === id)?.phase === "preparing") return false
    sends.delete(id)
    return true
  }

  const progressSend = (progress: SendProgress): Promise<void> => {
    if (progress.running) return progress.running
    const sessionID = progress.mutation.sessionID
    const token = selectionToken
    const key = JSON.stringify([progress.deviceID, sessionID])
    const previous = sendPreparation.get(key)
    const prepared = Promise.withResolvers<void>()
    sendPreparation.set(key, prepared.promise)
    const owns = () => sends.get(progress.mutation.id) === progress && progress.deviceID === container.state.activeDeviceID &&
      token === selectionToken && container.state.activeSessionID === sessionID && container.state.transport.kind === "open"
    const run = (async () => {
      try {
        await previous
        if (!owns()) {
          finishMutation(progress.mutation.id, "failed", "Select this Session on the same connected machine before retrying the send.")
          return
        }
        setState({ mutations: container.state.mutations.map((entry) => entry.id === progress.mutation.id ? { ...entry, state: "sending", detail: undefined } : entry) })
        if (progress.uploadedAt !== undefined && now() - progress.uploadedAt >= RemoteLimits.attachmentTtlMs && progress.files?.some((file) => file.uri.startsWith("data:"))) progress.uploadsReady = false
        if (!progress.uploadsReady) {
          progress.uploaded = await prepareUploads(sessionID, progress.files, token)
          if (progress.files !== undefined && progress.uploaded === undefined) {
            finishMutation(progress.mutation.id, "failed", container.state.uploadError ?? "Attachments were not sent.")
            return
          }
          progress.uploadsReady = true
          progress.uploadedAt = now()
        }
        for (const prerequisite of progress.prerequisites) {
          if (!owns()) {
            finishMutation(progress.mutation.id, "failed", "The selected Session or machine changed before the send was admitted.")
            return
          }
          const view = container.state.view
          const model = readModelRef(prerequisite.input.model)
          if ((prerequisite.completed || !prerequisite.attempted) &&
            (prerequisite.operation === "session.switchAgent" && prerequisite.input.agent === view?.agent ||
              prerequisite.operation === "session.switchModel" && model !== undefined && model.id === view?.model?.id &&
              model.providerID === view.model.providerID && model.variant === view.model.variant)) {
            prerequisite.completed = true
            continue
          }
          prerequisite.completed = false
          prerequisite.attempted = true
          const outcome = await request({ ...progress.mutation, state: "sending", phase: "preparing" }, { sessionID, operation: prerequisite.operation, input: prerequisite.input, retain: true })
          if (outcome.status !== "ok") return
          prerequisite.completed = true
          if (owns() && container.state.view) {
            if (prerequisite.operation === "session.switchModel" && model !== undefined) setState({ view: { ...container.state.view, model } })
            if (prerequisite.operation === "session.switchAgent" && typeof prerequisite.input.agent === "string") setState({ view: { ...container.state.view, agent: prerequisite.input.agent } })
          }
        }
        if (!owns()) {
          finishMutation(progress.mutation.id, "failed", "The selected Session or machine changed before the send was admitted.")
          return
        }
        const input = { ...progress.mutation.input, ...(progress.files === undefined ? {} : { files: progress.uploaded }) }
        if (progress.prerequisites.length === 0 && progress.mutation.kind !== "skill") prepared.resolve()
        await request({ ...progress.mutation, state: "sending", phase: "admitting" }, { sessionID, input })
      } catch (cause) {
        finishMutation(progress.mutation.id, "failed", cause instanceof Error ? cause.message : "The send failed.")
      } finally {
        prepared.resolve()
        if (sendPreparation.get(key) === prepared.promise) sendPreparation.delete(key)
      }
    })()
    progress.running = run
    void run.then(() => { progress.running = undefined })
    return run
  }

  const acceptSend = (mutation: PendingMutation, input: { readonly files?: readonly FileAttachmentInput[]; readonly agent?: string; readonly model?: ModelRefView }) => {
    const view = container.state.view ?? createSessionView(mutation.sessionID)
    const progress: SendProgress = {
      mutation,
      deviceID: container.state.activeDeviceID!,
      files: input.files,
      prerequisites: [
        ...(input.agent !== undefined ? [{ operation: "session.switchAgent" as const, input: { agent: input.agent } }] : []),
        ...(input.model !== undefined
          ? [{ operation: "session.switchModel" as const, input: { model: input.model } }] : []),
      ].map((step) => ({ ...step, completed: false, attempted: false })),
      uploadsReady: input.files === undefined,
    }
    sends.set(mutation.id, progress)
    setState({
      mutations: [...container.state.mutations, mutation],
      ...(mutation.kind !== "prompt" && mutation.kind !== "command" ? {} : { view: { ...view, messages: [...view.messages, {
        kind: "user" as const, id: mutation.id, text: mutationText(mutation)!,
        delivery: mutation.input.delivery === "queue" ? "queue" as const : "steer" as const,
        state: "pending" as const, created: mutation.created ?? now(),
      }] } }),
    })
    void progressSend(progress)
    return true
  }

  const disconnectDevice = (retainMachineOffline = false) => {
    clearPendingLatency()
    latency.clear()
    goalsInFlight.clear()
    if (!retainMachineOffline) offlineDeviceID = undefined
    clearImageSources()
    cancelFamilyRefresh?.()
    cancelFamilyRefresh = undefined
    cancelUpload("Attachment upload was cancelled by disconnection. Files were not sent.")
    accountToken += 1
    clearCatalogs()
    cancelStatusReload?.()
    cancelStatusReload = undefined
    statusReloadLocal = false
    carouselRefreshPending = false
    carouselRevision += 1
    const active = transport
    transport = undefined
    lastStatusKind = "idle"
    connectionOpened = false
    active?.close(1000, "disconnected")
    cancelSearch?.()
    sessionPages = []
    openRootInfo = undefined
    subscribedSessionID = undefined
    queued = []
    sessionsToken += 1
    for (const jobID of Array.from(compactionWaiters.keys())) settleCompaction(jobID, "unknown")
    endScope({
      activeDeviceID: undefined,
      transport: { kind: "idle" },
      advertised: [],
      sessions: [],
      carouselSessions: [],
      carouselStatus: "idle",
      sessionRowsStale: false,
      sessionGroups: [],
      selectedWorkspaceID: undefined,
      selectedSessionInfo: undefined,
      sessionListStatus: "idle",
      sessionPageLoading: false,
      sessionHasNext: false,
      sessionHasPrevious: false,
      drafts: {},
      mutations: container.state.mutations.filter((mutation) => mutation.operation !== "session.goal.set"),
      mutationToasts: [],
      sessionCreation: undefined,
      activeSessionID: undefined,
      view: undefined,
      team: undefined, familyActivity: undefined, todos: undefined,
      teamCues: [],
      lastRelayDrop: undefined,
      connection: container.state.owner === undefined ? { kind: "signed-out" } : deviceConnection(container.state.devices.length),
    })
    endAlerts(retainMachineOffline)
  }

  const api: RemoteStore = {
    container,
    latency,
    queryClient,
    link,
    state: () => container.state,
    subscribe: (listener) => {
      const subscription = container.subscribe(() => listener())
      subscriptions.add(subscription)
      return () => {
        subscriptions.delete(subscription)
        subscription.unsubscribe()
      }
    },
    readStoredLatency: async (before) => {
      const owner = transport
      const deviceID = container.state.activeDeviceID
      const generation = container.state.generation
      if (owner === undefined || deviceID === undefined || container.state.transport.kind !== "open") return { status: "unavailable" }
      const outcome = await owner.request("machine.latency.list", before === undefined ? {} : { input: { before } })
      if (transport !== owner || container.state.activeDeviceID !== deviceID || container.state.generation !== generation) return { status: "unavailable" }
      if (outcome.status === "unavailable") return { status: "unavailable" }
      if (outcome.status === "unknown") return { status: "unknown" }
      if (outcome.status === "failed") return { status: outcome.error.code === "unknown_operation" ? "unsupported" : "failed" }
      const value = outcome.value
      if (typeof value !== "object" || value === null || Array.isArray(value)) return { status: "failed" }
      const data = Reflect.get(value, "data")
      const cursor = Reflect.get(value, "cursor")
      if (!Array.isArray(data) || data.length > RemoteLimits.maxLatencyPage || typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return { status: "failed" }
      const next = Reflect.get(cursor, "next")
      if (next !== undefined && (typeof next !== "string" || next.length < 1 || next.length > 256)) return { status: "failed" }
      const rows = data.flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "receivedAt" && key !== "sample")) return []
        const receivedAt = Reflect.get(entry, "receivedAt")
        const sample = Reflect.get(entry, "sample")
        return typeof receivedAt === "number" && Number.isSafeInteger(receivedAt) && receivedAt >= 0 && isRemoteLatencySample(sample)
          ? [{ receivedAt, sample }] : []
      })
      if (rows.length !== data.length) return { status: "failed" }
      return { status: "ok", data: rows, ...(next === undefined ? {} : { next }) }
    },
    signInURL: (provider, redirectAfter = "/remote/") => signInURL(provider, redirectAfter),
    load: async () => {
      const token = ++accountToken
      const startedAt = monotonicNow()
      const me = await options.http.me()
      // A read that settles after sign-out, a rejected credential, a deliberate
      // disconnect, or a newer read describes an account this store no longer shows.
      if (token !== accountToken) return
      const elapsed = Math.max(0, Math.round(monotonicNow() - startedAt))
      latency.recordRequest({ operation: "account.read", outcome: me.ok ? "ok" : "failed", queueMs: 0, settlementMs: elapsed, totalMs: elapsed })
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
          container.state.connection.kind === "loading"
            ? { connection: { kind: "error", message: me.message }, notice: me.message }
            : { notice: me.message },
        )
        return
      }
      const devices = me.value.devices
      const selected = devices.find((device) => device.id === container.state.activeDeviceID)
      if (selected?.status === "active" && !selected.online) {
        const alreadyOffline = offlineDeviceID === selected.id || container.state.connection.kind === "offline"
        // The disconnect clears the list, so the selected device's last list is restored read-only.
        const sessions = container.state.sessions
        const sessionGroups = container.state.sessionGroups
        const selectedWorkspaceID = container.state.selectedWorkspaceID
        const drafts = container.state.drafts
        const creation = container.state.sessionCreation
        setState({ owner: { id: me.value.user.id, expiresAt: me.value.session.expiresAt }, devices })
        disconnectDevice(alreadyOffline)
        offlineDeviceID = selected.id
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
          notifications: delivery.entries(),
        })
        return
      }
      const activeDevices = devices.filter((device) => device.status === "active" && device.online)
      const first = activeDevices[0]
      const stillPresent = activeDevices.some((device) => device.id === container.state.activeDeviceID)
      const remembered = activeDevices.find((device) => device.id === readRememberedMachine(storage))
      const adopted = stillPresent ? undefined : remembered ?? (activeDevices.length === 1 ? first : undefined)
      setState({
        owner: { id: me.value.user.id, expiresAt: me.value.session.expiresAt },
        devices,
        connection: stillPresent
          ? container.state.connection
          : adopted
            ? { kind: "connecting" }
            : deviceConnection(devices.filter((device) => device.status === "active").length),
      })
      if (adopted !== undefined) api.connect(adopted.id)
      else if (!stillPresent && container.state.activeDeviceID !== undefined) api.disconnect()
    },
    logout: async () => {
      // The account answer this browser held is replaced by an explicit sign-out, so a
      // read that is still in flight must not restore it afterwards.
      accountToken += 1
      const discarded = new Set(sends.keys())
      sends.clear()
      setState({ mutations: container.state.mutations.filter((mutation) => !discarded.has(mutation.id)),
        mutationToasts: container.state.mutationToasts?.filter((toast) => !discarded.has(toast.id)) })
      clearCatalogs()
      endQueries(currentScope())
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
      writeRememberedMachine(storage, deviceID)
      goalsInFlight.clear()
      capturedUnsupported = false
      cancelCapturedRefresh?.()
      cancelCapturedRefresh = undefined
      capturedRead = undefined
      lastCapturedRead = -Infinity
      const switching = container.state.activeDeviceID !== deviceID
      if (switching && container.state.activeDeviceID !== undefined) {
        clearPendingLatency()
        latency.clear()
      } else {
        cancelLatencyUpload?.()
        cancelLatencyUpload = undefined
        latencyUpload = undefined
        latencyUnsupported = false
      }
      if (switching) offlineDeviceID = undefined
      clearImageSources()
      cancelFamilyRefresh?.()
      cancelFamilyRefresh = undefined
      const drafts = container.state.activeDeviceID === deviceID ? container.state.drafts : {}
      const creation = container.state.sessionCreation?.deviceID === deviceID ? container.state.sessionCreation : undefined
      const previous = transport
      transport = undefined
      lastStatusKind = "idle"
      connectionOpened = false
      previous?.close(1000, "switching device")
      cancelSearch?.()
      sessionPages = []
      openRootInfo = undefined
      clearCatalogs()
      cancelStatusReload?.()
      cancelStatusReload = undefined
      statusReadOwner = undefined
      statusReadPending = false
      statusBaseline = false
      statusReloading = false
      statusReloadLocal = false
      carouselRefreshPending = false
      carouselRevision += 1
      lastStatusReload = -Infinity
      lastCarouselReload = -Infinity
      // The new socket starts with no subscriptions, no alerts, and no list of its own.
      subscribedSessionID = undefined
      queued = []
      sessionsToken += 1
      endScope({ activeDeviceID: deviceID, transport: { kind: "idle" }, sessions: [], carouselSessions: [], carouselStatus: "loading", sessionStatus: undefined, advertised: [], activeSessionID: undefined, view: undefined, notice: undefined, drafts,
        mutations: container.state.mutations.filter((mutation) => mutation.operation !== "session.goal.set"),
        mutationToasts: [],
        lastRelayDrop: container.state.activeDeviceID === deviceID ? container.state.lastRelayDrop : undefined,
        team: undefined, familyActivity: undefined, teamCues: [], todos: undefined,
        sessionGroups: [], selectedWorkspaceID: undefined, selectedSessionInfo: undefined, sessionQuery: "", sessionFilter: "all",
        sessionListStatus: "idle", sessionRowsStale: false, sessionPageLoading: false, sessionHasNext: false, sessionHasPrevious: false,
        sessionCreation: creation?.status === "creating" ? { ...creation, status: "unknown", message: "The connection changed before creation settled. Check or retry this session explicitly." } : creation,
      })
      endAlerts(false, switching)
      const created = options.createTransport(deviceID, {
        onRequestTiming: (sample) => {
          if (isCurrentConnection(created)) latency.recordRequest(sample)
        },
        onStatus: (status) => handleStatus(created, status),
        onSessionStatus: (status) => applyStatusFrame(created, status),
        onNotices: (frame) => applyNotices(created, frame, deviceID),
        onSessions: () => {
          if (!isCurrentConnection(created)) return
          scheduleCapturedRefresh()
          signalRecovery()
          if (container.state.sessionListStatus === "ready" || (container.state.carouselSessions?.length ?? 0) > 0) {
            carouselRevision += 1
            carouselRefreshPending = true
          }
          cancelSearch?.()
          cancelSearch = undefined
          sessionsToken += 1
          setState({ sessionListStatus: "loading" })
          void refreshSessionGroups(created)
          if (selectionReadyToken === selectionToken && subscribedSessionID === container.state.activeSessionID) void resyncSelected()
        },
        onEvents: (sessionID, events) => {
          if (!isCurrentConnection(created)) return
          for (const event of events) queueEvent(sessionID, event)
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
      writeRememberedMachine(storage, "")
      disconnectDevice()
    },
    selectSession,
    watchTeam: (enabled) => {
      if (teamWatching === enabled) return
      teamWatching = enabled
      teamWatchToken += 1
      pendingTeamRead = undefined
      if (!enabled) {
        activityWatching = false
        activityWatchToken += 1
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", officeVisibility)
        cancelFamilyRefresh?.()
        cancelFamilyRefresh = undefined
        setState({ team: undefined, familyActivity: undefined, teamCues: [] })
        return
      }
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined) return
      const rootID = container.state.selectedSessionInfo?.parentID ?? sessionID
      setState({ team: emptyTeam(rootID, selectionFailedToken === selectionToken ? "error" : "loading"), teamCues: [] })
      if (selectionReadyToken === selectionToken && transport !== undefined) {
        void loadTeam(transport, selectionToken, rootID)
      }
    },
    watchFamilyActivity: (enabled) => {
      if (activityWatching === enabled) return
      activityWatching = enabled
      activityWatchToken += 1
      cancelFamilyRefresh?.()
      cancelFamilyRefresh = undefined
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", officeVisibility)
        if (enabled) document.addEventListener("visibilitychange", officeVisibility)
      }
      if (!enabled) {
        setState({ familyActivity: undefined })
        return
      }
      const rootID = container.state.team?.rootID
      if (rootID !== undefined) {
        setState({ familyActivity: { rootID, status: "loading", members: [] } })
        if (transport !== undefined) void loadFamilyActivity(transport, rootID)
      }
    },
    loadMoreTeam: async () => {
      const owner = transport
      const team = container.state.team
      if (!teamWatching || owner === undefined || team?.status !== "ready" || team.next === undefined || team.pageLoading || container.state.transport.kind !== "open") return
      await loadTeam(owner, selectionToken, team.rootID, team.next)
    },
    loadTeamControls: async () => {
      const owner = transport
      const team = container.state.team
      if (!teamWatching || owner === undefined || team?.status !== "ready" || container.state.transport.kind !== "open") return
      const token = selectionToken
      await Promise.all([
        ...(team.shellStatus === "loading" ? [loadTeamShells(owner, token, team.rootID)] : []),
        ...(team.sideChatStatus === "loading" ? [loadSideChats(owner, token, team.rootID)] : []),
        ...(!team.economicsUnsupported && team.tasks.some((task) => task.tokens === undefined) ? [loadTeamEconomics(owner, token, team.rootID,
          team.tasks.filter((task) => task.tokens === undefined).slice(0, 15).map((task) => task.sessionID))] : []),
      ])
    },
    loadSelectedSubagentEconomics: async () => {
      const owner = transport
      const team = container.state.team
      const childID = container.state.selectedSessionInfo?.id
      if (!teamWatching || owner === undefined || team?.status !== "ready" || container.state.selectedSessionInfo?.parentID !== team.rootID ||
        !team.tasks.some((task) => task.sessionID === childID) || childID === undefined || team.economicsUnsupported) return
      const token = selectionToken
      if (selectedEconomicsRead?.owner === owner && selectedEconomicsRead.token === token && selectedEconomicsRead.rootID === team.rootID && selectedEconomicsRead.childID === childID) return
      selectedEconomicsRead = { owner, token, rootID: team.rootID, childID }
      await loadTeamEconomics(owner, token, team.rootID, [childID])
    },
    loadMoreSideChats: async () => {
      const owner = transport
      const team = container.state.team
      if (!teamWatching || owner === undefined || team?.sideChatStatus !== "ready" || team.sideChatNext === undefined || team.sideChatLoading || container.state.transport.kind !== "open") return
      setState({ team: { ...team, sideChatLoading: true } })
      await loadSideChats(owner, selectionToken, team.rootID, team.sideChatNext)
    },
    cancelSubagent: async (childID) => {
      const owner = transport
      const team = container.state.team
      if (!teamWatching || owner === undefined || team?.status !== "ready" || !team.tasks.some((task) => task.sessionID === childID && ["starting", "running", "waiting"].includes(task.state)))
        return { status: "failed", message: "Subagent is not available for cancellation." }
      const rootID = team.rootID
      const token = selectionToken
      const outcome = await owner.request("session.subagent.cancel", { sessionID: rootID, input: { childID }, timeoutMs: 10_000 })
      if (token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== rootID) return { status: "unknown", message: "The family changed; check this subagent before retrying." }
      if (outcome.status !== "ok") return teamActionFailure(outcome, "Cancel subagent")
      const data = typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
      const task = readTeamTask(data)
      if (task?.parentID !== rootID || task.sessionID !== childID) return { status: "unknown", message: "The device returned an unreadable cancellation; check the subagent before retrying." }
      setState({ team: { ...container.state.team, tasks: container.state.team.tasks.map((item) => item.sessionID === childID ? { ...item, ...task, question: task.question } : item) } })
      return { status: "ok", message: "" }
    },
    answerSubagent: async (childID, questionID, text) => {
      const owner = transport
      const team = container.state.team
      if (!teamWatching || owner === undefined || team?.status !== "ready" || !team.tasks.some((task) => task.sessionID === childID && task.state === "waiting" && task.question?.id === questionID))
        return { status: "failed", message: "This subagent question is no longer pending." }
      const rootID = team.rootID
      const token = selectionToken
      const answerKey = `${rootID}:${childID}:${questionID}`
      if (childAnswers.has(answerKey)) return { status: "failed", message: "An answer to this subagent question is already being sent." }
      childAnswers.add(answerKey)
      const outcome = await owner.request("session.subagent.answer", { sessionID: rootID, input: { childID, questionID, text }, timeoutMs: 10_000 }).finally(() => childAnswers.delete(answerKey))
      if (token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== rootID) return { status: "unknown", message: "The family changed; check the question before retrying." }
      if (outcome.status !== "ok") return teamActionFailure(outcome, "Answer subagent")
      const data = typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
      const task = readTeamTask(data)
      if (task?.parentID !== rootID || task.sessionID !== childID) return { status: "unknown", message: "The device returned an unreadable answer; check the subagent before retrying." }
      setState({ team: { ...container.state.team, tasks: container.state.team.tasks.map((item) => item.sessionID === childID ? { ...item, ...task, question: task.question } : item) } })
      return { status: "ok", message: "" }
    },
    killTeamShell: async (shellID) => {
      const owner = transport
      const team = container.state.team
      if (!teamWatching || owner === undefined || team?.shellStatus !== "ready" || !team.shells.some((shell) => shell.id === shellID && shell.status === "running"))
        return { status: "failed", message: "Shell is not running in this family." }
      const rootID = team.rootID
      const token = selectionToken
      const outcome = await owner.request("session.team.shell.kill", { sessionID: rootID, input: { shellID }, timeoutMs: 10_000 })
      if (token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== rootID) return { status: "unknown", message: "The family changed; check this shell before retrying." }
      if (outcome.status !== "ok") return teamActionFailure(outcome, "Kill shell")
      setState({ team: { ...container.state.team, shells: container.state.team.shells.map((shell) => shell.id === shellID ? { ...shell, status: "killed" as const, completedAt: now() } : shell) } })
      return { status: "ok", message: "" }
    },
    teamShellOutput: async (ownerID, shellID, cursor) => {
      const owner = transport
      const team = container.state.team
      if (!teamWatching || owner === undefined || team?.shellStatus !== "ready" || !team.shells.some((shell) => shell.id === shellID && shell.ownerID === ownerID)) throw new Error("Shell is not in this family.")
      const token = selectionToken
      const outcome = await owner.request("session.shell.output", { sessionID: ownerID, input: { shellID, cursor: cursor ?? 0, limit: shellOutputPageLimit }, timeoutMs: 5_000 })
      if (token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== team.rootID) throw new Error("The family changed during the output read.")
      if (outcome.status !== "ok") throw new Error(singlePageFailure(outcome))
      const page = readShellOutputPage(outcome.value)
      if (!page) throw new Error(unreadablePage)
      return page
    },
    createSideChat: async () => {
      const owner = transport
      const team = container.state.team
      if (!teamWatching || owner === undefined || team?.sideChatStatus !== "ready") return { status: "failed", message: "Side chats are unavailable." }
      const rootID = team.rootID
      const token = selectionToken
      const id = options.createSessionID?.() ?? `ses_${crypto.randomUUID().replaceAll("-", "")}`
      const outcome = await owner.request("session.side-chat.create", { sessionID: rootID, input: { id }, timeoutMs: 10_000 })
      if (token !== selectionToken || !isCurrentConnection(owner) || container.state.team?.rootID !== rootID) return { status: "unknown", message: "The family changed; check the side-chat list before retrying." }
      if (outcome.status !== "ok") return teamActionFailure(outcome, "Create side chat")
      const data = typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
      const info = readSessionInfo(data)
      if (info?.id !== id || info.parentID !== rootID || info.agent !== "btw") return { status: "unknown", message: "The device returned an unreadable side chat; check the list before retrying." }
      setState({ team: { ...container.state.team, sideChats: [{ id, title: info.title, updatedAt: info.updatedAt }, ...container.state.team.sideChats] } })
      return { status: "ok", sessionID: id }
    },
    selectWorkspace: (workspaceID) => {
      if (container.state.transport.kind !== "open" || container.state.connection.kind === "offline") return
      if (!container.state.sessionGroups.some((group) => group.id === workspaceID) || container.state.selectedWorkspaceID === workspaceID) return
      cancelSearch?.()
      sessionsToken += 1
      sessionPages = []
      setState({ selectedWorkspaceID: workspaceID, sessions: [], advertised: [], sessionListStatus: "loading", sessionRowsStale: false, sessionHasNext: false, sessionHasPrevious: false })
      void loadSessions(sessionsToken)
    },
    searchSessions: (query, filter = container.state.sessionFilter) => {
      if (container.state.transport.kind !== "open" || container.state.connection.kind === "offline") return
      if (container.state.sessionQuery === query && container.state.sessionFilter === filter) return
      cancelSearch?.()
      sessionsToken += 1
      setState({ sessionQuery: query, sessionFilter: filter, sessionListStatus: "loading", sessionRowsStale: container.state.sessions.length > 0, sessionHasNext: false, sessionHasPrevious: false })
      cancelSearch = schedule(() => {
        cancelSearch = undefined
        void loadSessions(sessionsToken)
      }, 250)
    },
    nextSessionsPage: async () => {
      const cursor = sessionPages.at(-1)?.next
      if (cursor !== undefined && container.state.sessionListStatus === "ready" && container.state.transport.kind === "open") await loadSessions(sessionsToken, cursor)
    },
    previousSessionsPage: async () => {
      const cursor = sessionPages[0]?.previous
      if (cursor !== undefined && container.state.sessionListStatus === "ready" && container.state.transport.kind === "open") await loadSessions(sessionsToken, cursor, "previous")
    },
    setDraft: (sessionID, text) => {
      if (sessionID !== container.state.activeSessionID) return
      setState({ drafts: { ...container.state.drafts, [sessionID]: text } })
    },
    loadCatalog: async (target, options = {}) => {
      const owner = transport
      if (owner === undefined || container.state.transport.kind !== "open") return
      const key = catalogKey(target)
      // A failed read is not a verdict: keeping it cached leaves the model and agent pickers
      // disabled for the rest of the connection, so only a usable entry short-circuits.
      const cached = container.state.catalogs[key]
      if (!options.refresh && cached !== undefined && cached.status !== "error") {
        await catalogReads.get(key)
        return
      }
      if (catalogReads.has(key)) {
        await catalogReads.get(key)
        if (!options.refresh) return
      }
      if (!isCurrentConnection(owner) || container.state.transport.kind !== "open") return
      const generation = catalogGeneration
      setState({ catalogs: { ...container.state.catalogs, [key]: { status: "loading", agents: [], models: [], commands: [], skills: [], references: [], resources: [] } } })
      const read = (async () => {
        const outcome = await owner.request("sessionID" in target ? "session.catalog" : "workspace.catalog",
          "sessionID" in target ? { sessionID: target.sessionID } : { input: { workspace: target.workspaceID } })
        if (generation !== catalogGeneration || !isCurrentConnection(owner)) return
        const value = outcome.status === "ok" ? readCatalog(outcome.value) : undefined
        const previous = container.state.catalogs[key]
        if (previous?.status !== "loading") return
        setState({ catalogs: { ...container.state.catalogs, [key]: value ?? { ...previous,
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
      if (owner === undefined || container.state.transport.kind !== "open") return { status: "failed", message: notConnectedPage }
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
      if (container.state.sessionCreation?.status === "creating" || container.state.sessionCreation?.status === "unknown") return undefined
      const scope = currentScope()
      const listed = scope === undefined ? undefined : queryClient.getQueryState<readonly RemoteWorkspaceInfo[]>(remoteKeys.workspaces(scope))
      const workspace = listed?.status === "success" && listed.fetchStatus === "idle" ? listed.data?.find((item) => item.id === input.workspaceID) : undefined
      const deviceID = container.state.activeDeviceID
      if (!workspace || !deviceID) {
        setState({ notice: "Select an available workspace from the connected machine." })
        return undefined
      }
      return createSession({ id: options.createSessionID?.() ?? `ses_${crypto.randomUUID().replaceAll("-", "")}`, deviceID, workspace, status: "creating",
        ...(input.agent === undefined ? {} : { agent: input.agent }), ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }) }, false)
    },
    retrySessionCreation: async () => {
      const attempt = container.state.sessionCreation
      if (!attempt || attempt.status === "creating") return undefined
      return createSession(attempt, true)
    },
    dismissSessionCreation: () => {
      if (container.state.sessionCreation?.status !== "creating") setState({ sessionCreation: undefined })
    },
    reloadMessages,
    loadOlderMessages,
    loadOversizedMessage,
    loadImageSource: (input) => {
      if (imageScope?.deviceID !== input.deviceID || imageScope.sessionID !== input.sessionID) {
        clearImageSources()
        imageScope = { deviceID: input.deviceID, sessionID: input.sessionID }
      }
      if (!/^[0-9a-f]{64}$/.test(input.digest) || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(input.mime))
        return Promise.reject(new Error("Invalid attachment"))
      const cached = imageSources.get(input.digest)
      if (cached !== undefined) return cached.mime === input.mime ? cached.promise : Promise.reject(new Error("Invalid attachment"))
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 120_000)
      const promise = (async () => {
        const response = await (options.fetch ?? fetch)(`/api/remote/devices/${encodeURIComponent(input.deviceID)}/sessions/${encodeURIComponent(input.sessionID)}/attachments/${input.digest}`,
          { credentials: "same-origin", signal: controller.signal })
        if (!response.ok) throw new Error("Attachment unavailable")
        const payload: unknown = await response.json()
        if (typeof payload !== "object" || payload === null || !("mime" in payload) || !("data" in payload) || !("bytes" in payload) ||
          payload.mime !== input.mime || typeof payload.bytes !== "number" || !Number.isSafeInteger(payload.bytes) || payload.bytes < 0 || payload.bytes > 10 * 1024 * 1024 ||
          typeof payload.data !== "string" || payload.data.length > 14 * 1024 * 1024 ||
          !isWellFormedBase64(payload.data) || controller.signal.aborted)
          throw new Error("Invalid attachment")
        return `data:${input.mime};base64,${payload.data}`
      })().catch((error: unknown) => {
        if (imageSources.get(input.digest)?.promise === promise) imageSources.delete(input.digest)
        throw error
      }).finally(() => clearTimeout(timeout))
      imageSources.set(input.digest, { mime: input.mime, controller, promise })
      return promise
    },
    loadShellOutputPage,
    switchModel: async (model) => {
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined) return false
      const outcome = await request({ id: `model_${now()}_${createMessageID()}`, kind: "model", label: "Switch model", state: "sending",
        sessionID, operation: "session.switchModel", input: { model } }, { sessionID })
      return outcome.status === "ok"
    },
    switchAgent: async (agent) => {
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined) return false
      const outcome = await request({ id: `agent_${now()}_${createMessageID()}`, kind: "agent", label: "Switch agent", state: "sending",
        sessionID, operation: "session.switchAgent", input: { agent } }, { sessionID })
      return outcome.status === "ok"
    },
    activateSkill: async (skill) => {
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined || !skill.trim() || container.state.transport.kind !== "open" || container.state.connection.kind === "offline") return false
      const id = createMessageID()
      return acceptSend({ id, kind: "skill", label: `Load ${skill}`, state: "sending", phase: "admitting", sessionID,
        operation: "session.skill", input: { id, skill } }, {})
    },
    sendPrompt: async (input) => {
      const sessionID = container.state.activeSessionID
      const text = input.text.trim()
      if (sessionID === undefined) {
        setState({ notice: "Select a session before sending a prompt." })
        return false
      }
      if (container.state.transport.kind !== "open" || container.state.connection.kind === "offline") return false
      if (text.length === 0 && !input.files?.length && !input.agents?.length && !input.skills?.length) return false
      if (input.skills !== undefined && (input.skills.length > RemoteLimits.maxPromptSkills || input.skills.some((id) => !id.trim() || id.length > 128))) return false
      if (!requestFits("session.prompt", sessionID, { text, delivery: input.delivery, agents: input.agents, skills: input.skills }, input.files)) return false
      const messageID = createMessageID()
      return acceptSend({ id: messageID, kind: "prompt", label: input.delivery === "queue" ? "Queued prompt" : "Prompt", state: "sending", phase: "preparing",
        created: now(), sessionID, operation: "session.prompt", input: { id: messageID, text, delivery: input.delivery,
          ...(input.files === undefined ? {} : { files: input.files }), ...(input.agents === undefined ? {} : { agents: input.agents }),
          ...(input.skills?.length ? { skills: input.skills } : {}) } }, input)
    },
    runCommand: async (input) => {
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined || !input.command.trim() || container.state.transport.kind !== "open" || container.state.connection.kind === "offline") return false
      if (!requestFits("session.command", sessionID, { command: input.command, arguments: input.arguments, delivery: input.delivery, agents: input.agents }, input.files)) return false
      const id = createMessageID()
      return acceptSend({ id, kind: "command", label: `/${input.command}`, state: "sending", phase: "preparing", created: now(), sessionID, operation: "session.command",
        input: { id, command: input.command, delivery: input.delivery,
          ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
          ...(input.files === undefined ? {} : { files: input.files }), ...(input.agents === undefined ? {} : { agents: input.agents }) },
      }, input)
    },
    cancelUpload: () => cancelUpload(),
    compactSession: async () => {
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined || container.state.transport.kind !== "open" || container.state.connection.kind === "offline") return false
      if (container.state.mutations.some((entry) => entry.operation === "session.compact" && entry.sessionID === sessionID && entry.state === "sending")) return false
      const id = `cmp_${crypto.randomUUID().replaceAll("-", "")}`
      const outcome = await request({ id, kind: "compact", label: "Compact context", state: "sending", sessionID,
        operation: "session.compact", input: { id } }, { sessionID })
      return outcome.status === "ok"
    },
    retryMutation: async (id) => {
      const progress = sends.get(id)
      if (progress) {
        if (progress.deviceID !== container.state.activeDeviceID || progress.mutation.sessionID !== container.state.activeSessionID || container.state.transport.kind !== "open") return
        await progressSend(progress)
        return
      }
      const mutation = container.state.mutations.find((entry) => entry.id === id)
      if (!mutation) return
      await request({ ...mutation, state: "sending", detail: undefined }, { sessionID: mutation.sessionID })
    },
    dismissMutation: (id) => {
      const progress = sends.get(id)
      sends.delete(id)
      setState({ mutations: container.state.mutations.filter((entry) => entry.id !== id),
        ...(progress === undefined || progress.deviceID !== container.state.activeDeviceID || container.state.view?.id !== progress.mutation.sessionID ? {} : { view: { ...container.state.view,
          messages: container.state.view.messages.filter((message) => message.id !== id || message.kind !== "user" || message.state !== "pending") } }) })
    },
    dismissMutationToast: (id) => {
      setState({ mutationToasts: (container.state.mutationToasts ?? []).filter((entry) => entry.id !== id) })
    },
    readNotification: async (id) => {
      const entry = delivery.entries().find((item) => item.id === id)
      if (entry !== undefined && !entry.synced) {
        delivery.remove([id])
        publishNotices()
        return
      }
      if (entry === undefined && noticeSequence(id) === undefined) return
      await readNotices("notice.read", { ids: [id] })
    },
    readAllNotifications: async () => {
      delivery.remove(delivery.entries().filter((entry) => !entry.synced).map((entry) => entry.id))
      publishNotices()
      await readNotices("notice.readAll")
    },
    loadMoreNotifications: loadMoreNotices,
    reloadNotifications: async () => {
      const owner = transport
      if (owner !== undefined) await loadNotices(owner)
    },
    interrupt: async () => {
      const sessionID = container.state.activeSessionID
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
      const sessionID = container.state.activeSessionID
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
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined) return
      const pending = container.state.view?.id === sessionID ? container.state.view.requests.find((entry) => entry.kind === "guardrail" && entry.id === id) : undefined
      if (pending?.kind !== "guardrail" || !canReplyToRequest(pending, sessionID)) {
        setState({ notice: "This review is no longer pending in the selected Session's family. Reload before replying." })
        return
      }
      if (pending.hardReview && reply === "always") {
        setState({ notice: "This human-only review accepts Approve once or Reject, never Always." })
        return
      }
      if (reply !== "reject" && !guardrailContextAvailable(pending)) {
        setState({ notice: "This review has no concrete targets or command to inspect. Reject it or reload before approving." })
        return
      }
      if (container.state.mutations.some((entry) => entry.kind === "guardrail" && entry.input.requestID === id && entry.state === "sending")) return
      const token = selectionToken
      const owner = transport
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
      if (token === selectionToken && container.state.activeSessionID === sessionID && owner !== undefined && isCurrentConnection(owner)) settleRequest(id, outcome)
    },
    replyForm: async (formID, answer) => {
      const sessionID = container.state.activeSessionID
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
      if (token === selectionToken && container.state.activeSessionID === sessionID) settleRequest(formID, outcome)
    },
    cancelForm: async (formID) => {
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined || !ownsPendingForm(formID, sessionID)) return
      const token = selectionToken
      const outcome = await request({ id: `form_cancel_${formID}_${now()}`, kind: "form", label: "Cancel form", state: "sending", sessionID, operation: "session.form.cancel", input: { formID } }, { sessionID })
      if (token === selectionToken && container.state.activeSessionID === sessionID) settleRequest(formID, outcome)
    },
    setYolo: async (level) => {
      const sessionID = container.state.activeSessionID
      const token = selectionToken
      if (sessionID === undefined) return false
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
      return outcome.status === "ok" && token === selectionToken && container.state.activeSessionID === sessionID
    },
    setGoal: async (text) => {
      const sessionID = container.state.activeSessionID
      if (sessionID === undefined) return false
      if (goalsInFlight.has(sessionID)) {
        setState({ notice: "A goal is already being set for this Session." })
        return false
      }
      goalsInFlight.add(sessionID)
      void applyGoal(sessionID, text).finally(() => goalsInFlight.delete(sessionID))
      return true
    },
    stopGoal: async () => {
      const sessionID = container.state.activeSessionID
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
      const view = container.state.view
      if (!view) return
      setState({ view: { ...view, autonomy } })
    },
    dispose: () => {
      clearPendingLatency()
      latency.dispose()
      goalsInFlight.clear()
      const abandoned = new Set(sends.keys())
      sends.clear()
      clearImageSources()
      oversizedReads.forEach((controller) => controller.abort())
      oversizedReads.clear()
      cancelUpload("Attachment upload was cancelled by workspace disposal. Files were not sent.")
      clearCatalogs()
      endQueries(currentScope())
      teamWatching = false
      teamWatchToken += 1
      activityWatching = false
      activityWatchToken += 1
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", officeVisibility)
      cancelFamilyRefresh?.()
      cancelFamilyRefresh = undefined
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
      setState({ drafts: {}, sessionCreation: undefined,
        mutations: container.state.mutations.filter((mutation) => mutation.operation !== "session.goal.set" && !abandoned.has(mutation.id)),
        mutationToasts: (container.state.mutationToasts ?? []).filter((toast) => !abandoned.has(toast.id) && !container.state.mutations.some((mutation) => mutation.operation === "session.goal.set" && mutation.id === toast.id)),
        team: undefined, familyActivity: undefined, teamCues: [] })
      endAlerts(false, false)
      subscriptions.forEach((subscription) => subscription.unsubscribe())
      subscriptions.clear()
    },
  }

  /**
   * Drops a request row once its reply settled. The agent also publishes a reply
   * event; removing locally keeps the row from accepting a second answer while
   * that event is in flight.
   */
  const ownsPendingForm = (formID: string, sessionID: string) => {
    if (container.state.view?.id === sessionID && container.state.view.requests.some((request) => request.kind === "form" && request.id === formID && request.form.sessionID === sessionID)) return true
    setState({ notice: "This form is no longer pending or belongs to another session." })
    return false
  }

  const settleRequest = (requestID: string, outcome: RemoteRequestOutcome) => {
    if (outcome.status !== "ok") return
    const view = container.state.view
    if (view === undefined) return
    setState({ view: replaceRequests(view, view.requests.filter((request) => request.id !== requestID)) })
  }

  const applyAutonomyResponse = (outcome: RemoteRequestOutcome, sessionID: string) => {
    if (outcome.status !== "ok") return
    const autonomy = readAutonomyFromResponse(outcome.value)
    if (autonomy === undefined) return
    const view = container.state.view
    // The response belongs to the session that asked. A selection that replaced it
    // owns the view now and must not take this autonomy.
    if (view === undefined || view.id !== sessionID) return
    setState({ view: { ...view, autonomy }, notice: undefined })
  }

  const goalRequests = (sessionID: string) => container.state.mutations.filter((mutation) =>
    mutation.kind === "goal" && mutation.operation === "session.goal.set" && mutation.sessionID === sessionID)

  const refreshAutonomy = async (owner: RemoteTransport, sessionID: string, token: number) => {
    const read = await owner.request("session.autonomy.get", { sessionID })
    if (token !== selectionToken || container.state.activeSessionID !== sessionID || !isCurrentConnection(owner) || read.status !== "ok") return
    applyAutonomyResponse(read, sessionID)
  }

  const applyGoal = async (sessionID: string, text: string) => {
    const token = selectionToken
    const owner = transport
    const deviceID = container.state.activeDeviceID
    const id = `goal_${now()}`
    setState({ mutations: container.state.mutations.filter((mutation) => !goalRequests(sessionID).includes(mutation)) })
    const outcome = await request(
      {
        id,
        kind: "goal",
        label: "Set goal",
        state: "sending",
        sessionID,
        operation: "session.goal.set",
        input: { goal: text },
      },
      { sessionID },
    )
    if (owner !== transport || container.state.activeDeviceID !== deviceID) return
    applyAutonomyResponse(outcome, sessionID)
    if (outcome.status === "unknown" || outcome.status === "failed" && outcome.error.code === "outcome_unknown") {
      if (outcome.status === "failed") finishMutation(id, "unknown", outcome.error.message)
      if (owner !== undefined) await refreshAutonomy(owner, sessionID, token)
      if (owner !== undefined && token === selectionToken && container.state.activeSessionID === sessionID && isCurrentConnection(owner) && container.state.mutations.some((mutation) => mutation.id === id))
        finishMutation(id, "unknown", "The goal request was not confirmed. Check the Session goal before retrying.")
    }
    if (owner !== transport || container.state.activeDeviceID !== deviceID) return
    const unconfirmed = outcome.status !== "ok" && container.state.mutations.some((mutation) => mutation.id === id)
    if (!unconfirmed || (container.state.drafts[sessionID] ?? "") !== "") return
    setState({ drafts: { ...container.state.drafts, [sessionID]: `/goal ${text}` } })
  }

  return api

  async function reloadAfterReconnect(owner: RemoteTransport) {
    const token = selectionToken
    // A device switch during the reload leaves a different connection owning the
    // store, so this one must not resubscribe, reload, or report again.
    if (!isCurrentConnection(owner)) return
    capturedUnsupported = false
    const sessionID = container.state.activeSessionID
    if (sessionID === undefined) {
      setState({ notice: "Reconnected." })
      return
    }
    const resubscribed = await owner.request("session.subscribe", { sessionID })
    if (!isCurrentConnection(owner)) return
    if (container.state.activeSessionID !== sessionID) {
      // A superseded reload registered a subscription this store no longer shows, so
      // release exactly what this connection just registered.
      if (resubscribed.status === "ok") releaseSubscription(owner, sessionID)
      return
    }
    // A new socket starts unsubscribed, so ownership follows this response and only
    // while the same selection still owns the view.
    subscribedSessionID = resubscribed.status === "ok" ? sessionID : undefined
    compactionAttemptedToken = undefined
    const reloaded = await reloadSnapshot(sessionID, token)
    if (!isCurrentConnection(owner)) return
    await Promise.all([loadSessionReads(sessionID, token), loadPendingInputs(owner, sessionID, token)])
    if (isCurrentConnection(owner)) void loadCapturedChanges(owner, sessionID, token)
    if (!isCurrentConnection(owner)) return
    if (reloaded === "applied") {
      setState({ notice: "Reconnected. Session history reloaded read-only." })
      return
    }
    const remaining = container.state.notice
    setState({
      notice:
        remaining === undefined
          ? "Reconnected. The connection is live again."
          : `Reconnected. ${remaining}`,
    })
  }

}

export function notificationSessionTitle(state: {
  readonly sessions: readonly { readonly id: string; readonly title: string }[]
  readonly carouselSessions?: readonly { readonly id: string; readonly title: string }[]
  readonly selectedSessionInfo?: { readonly id: string; readonly title: string }
}, sessionID: string): string | undefined {
  return state.sessions.find((row) => row.id === sessionID)?.title ?? state.carouselSessions?.find((row) => row.id === sessionID)?.title ??
    (state.selectedSessionInfo?.id === sessionID ? state.selectedSessionInfo.title : undefined)
}

export function readSessionInfo(value: unknown, options: { readonly running?: boolean; readonly attention?: boolean; readonly failed?: boolean } = {}): SessionInfoView | undefined {
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
    ...(typeof location.workspaceID === "string" && location.workspaceID.length > 0 ? { workspaceID: location.workspaceID } : {}),
    ...(typeof record.agent === "string" ? { agent: record.agent } : {}),
    ...(model === undefined ? {} : { model, modelLabel: modelLabel(model) }),
    updatedAt: typeof time.updated === "number" ? time.updated : 0,
    ...(typeof time.active === "number" && Number.isFinite(time.active) ? { activeAt: time.active } : {}),
    archived: typeof time.archived === "number",
    ...(typeof time.pinned === "number" ? { pinnedAt: time.pinned } : {}),
    ...(options.running === undefined ? {} : { running: options.running }),
    ...(options.attention === undefined ? {} : { attention: options.attention }),
    ...(options.failed === undefined ? {} : { failed: options.failed }),
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
  const question = Reflect.get(value, "question")
  const questionID = typeof question === "object" && question !== null ? Reflect.get(question, "id") : undefined
  const questionText = typeof question === "object" && question !== null ? Reflect.get(question, "text") : undefined
  const startedAt = typeof time === "object" && time !== null ? Reflect.get(time, "created") : undefined
  const updatedAt = typeof time === "object" && time !== null ? Reflect.get(time, "updated") : undefined
  if (typeof sessionID !== "string" || sessionID.length === 0 || typeof parentID !== "string" || parentID.length === 0 ||
    typeof description !== "string" || (agent !== undefined && typeof agent !== "string") ||
    (state !== "starting" && state !== "running" && state !== "waiting" && state !== "cancelling" &&
      state !== "cancelled" && state !== "completed" && state !== "failed" && state !== "lost") ||
    typeof revision !== "number" || !Number.isInteger(revision) || revision < 0 ||
    typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined
  const model = readModelRef(Reflect.get(value, "model"))
  return { sessionID, parentID, description, ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { modelLabel: modelLabel(model) }), state, revision, updatedAt,
    ...(typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(typeof questionID === "string" && typeof questionText === "string" && state === "waiting" ? { question: { id: questionID, text: questionText } } : {}) }
}

function readTeamEconomics(value: unknown): (Pick<TeamTaskView, "sessionID" | "cacheHitRatio" | "cacheRead" | "cacheWrite" | "contextTotal" | "contextLimit" | "cost" | "tokens">) | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const sessionID = Reflect.get(value, "sessionID")
  if (typeof sessionID !== "string") return undefined
  const cacheHitRatio = Reflect.get(value, "cacheHitRatio")
  const cacheRead = Reflect.get(value, "cacheRead")
  const cacheWrite = Reflect.get(value, "cacheWrite")
  const contextTotal = Reflect.get(value, "contextTotal")
  const contextLimit = Reflect.get(value, "contextLimit")
  const cost = Reflect.get(value, "cost")
  const tokenUsage = Reflect.get(value, "tokens")
  const cache = typeof tokenUsage === "object" && tokenUsage !== null ? Reflect.get(tokenUsage, "cache") : undefined
  const tokens = typeof tokenUsage === "object" && tokenUsage !== null && typeof cache === "object" && cache !== null
    ? ["input", "output", "reasoning"].map((key) => Reflect.get(tokenUsage, key)).concat([Reflect.get(cache, "read"), Reflect.get(cache, "write")]) : []
  return { sessionID,
    ...(typeof cacheHitRatio === "number" && cacheHitRatio >= 0 && cacheHitRatio <= 1 ? { cacheHitRatio } : {}),
    ...(typeof cacheRead === "number" && cacheRead >= 0 ? { cacheRead } : {}),
    ...(typeof cacheWrite === "number" && cacheWrite >= 0 ? { cacheWrite } : {}),
    ...(typeof contextTotal === "number" && contextTotal >= 0 ? { contextTotal } : {}),
    ...(typeof contextLimit === "number" && contextLimit >= 0 ? { contextLimit } : {}),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    ...(tokens.length === 5 && tokens.every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0) ? { tokens: tokens.reduce((total, count) => total + count, 0) } : {}),
  }
}

function retainedEconomics(task: TeamTaskView | undefined): Pick<TeamTaskView, "cacheHitRatio" | "cacheRead" | "cacheWrite" | "contextTotal" | "contextLimit" | "cost" | "tokens"> {
  if (task === undefined) return {}
  return {
    ...(task.cacheHitRatio === undefined ? {} : { cacheHitRatio: task.cacheHitRatio }),
    ...(task.cacheRead === undefined ? {} : { cacheRead: task.cacheRead }),
    ...(task.cacheWrite === undefined ? {} : { cacheWrite: task.cacheWrite }),
    ...(task.contextTotal === undefined ? {} : { contextTotal: task.contextTotal }),
    ...(task.contextLimit === undefined ? {} : { contextLimit: task.contextLimit }),
    ...(task.cost === undefined ? {} : { cost: task.cost }),
    ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
  }
}

function readTeamShell(value: unknown): TeamView["shells"][number] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const id = Reflect.get(value, "id")
  const ownerID = Reflect.get(value, "ownerID")
  const command = Reflect.get(value, "command")
  const status = Reflect.get(value, "status")
  const startedAt = Reflect.get(value, "startedAt")
  const completedAt = Reflect.get(value, "completedAt")
  if (typeof id !== "string" || typeof ownerID !== "string" || typeof command !== "string" ||
    !["running", "exited", "timeout", "memory-limit", "killed"].includes(status) || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined
  return { id, ownerID, command, status,
    startedAt, ...(typeof completedAt === "number" && Number.isFinite(completedAt) ? { completedAt } : {}) } as TeamView["shells"][number]
}

function readTeamSideChat(value: unknown): TeamView["sideChats"][number] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const id = Reflect.get(value, "id")
  const title = Reflect.get(value, "title")
  const updatedAt = Reflect.get(value, "updatedAt")
  if (typeof id !== "string" || typeof title !== "string" || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined
  return { id, title, updatedAt }
}

export function parseSessionStatus(payload: unknown): RemoteStoreState["sessionStatus"] {
  if (typeof payload !== "object" || payload === null) return undefined
  const body = Reflect.get(payload, "data") ?? payload
  if (typeof body !== "object" || body === null) return undefined
  const running = Reflect.get(body, "running")
  const attention = Reflect.get(body, "attention")
  const outstanding = Reflect.get(body, "outstanding")
  const failed = Reflect.get(body, "failed")
  if (!Array.isArray(running) || !running.every((id) => typeof id === "string" && id.startsWith("ses_")) ||
    !Array.isArray(attention) || !attention.every((id) => typeof id === "string" && id.startsWith("ses_")) ||
    (outstanding !== undefined && (!Array.isArray(outstanding) || !outstanding.every((id) => typeof id === "string" && id.startsWith("ses_")))) ||
    (failed !== undefined && (!Array.isArray(failed) || !failed.every((id) => typeof id === "string" && id.startsWith("ses_"))))) return undefined
  return { running: new Set(running), attention: new Set(attention), outstanding: new Set(outstanding ?? []), failed: new Set(failed ?? []) }
}

function readAutonomyFromResponse(value: unknown): SessionAutonomyView | undefined {
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

function teamActionFailure(outcome: Exclude<RemoteRequestOutcome, { status: "ok" }>, label: string): { readonly status: "failed" | "unknown"; readonly message: string } {
  if (outcome.status === "failed" && outcome.error.code === "unknown_operation") return { status: "failed", message: "Update YCoding on this machine to use Team controls." }
  return { status: outcome.status === "unknown" ? "unknown" : "failed", message: describeOutcome(outcome, label) }
}

function defaultMessageID(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`
}

function mutationText(mutation: PendingMutation) {
  if (mutation.kind !== "command") return typeof mutation.input.text === "string" ? mutation.input.text : undefined
  if (typeof mutation.input.command !== "string") return undefined
  return `/${mutation.input.command}${typeof mutation.input.arguments === "string" && mutation.input.arguments ? ` ${mutation.input.arguments}` : ""}`
}
