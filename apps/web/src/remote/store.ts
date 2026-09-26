import type { CreateEnrollmentResponse, RemoteDeviceInfo, RemoteOperation } from "@ycoding-ai/remote"
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
  type ShellOutputFetch,
} from "./projection"
import type { ModelRefView } from "./projection"
import type {
  RemoteRequestOutcome,
  RemoteTransport,
  RemoteTransportHandlers,
  RemoteTransportStatus,
} from "./transport"
import type { RemoteConnectionState } from "./view-model"

export type SessionInfoView = {
  readonly id: string
  readonly title: string
  readonly projectID?: string
  readonly directory?: string
  readonly agent?: string
  readonly model?: ModelRefView
  readonly modelLabel?: string
  readonly updatedAt: number
  readonly archived: boolean
  /** Absent when the connection cannot report active sessions. */
  readonly running?: boolean
}

export type PendingMutation = {
  readonly id: string
  readonly kind: "prompt" | "interrupt" | "permission" | "guardrail" | "form" | "autonomy" | "goal"
  readonly label: string
  readonly state: "sending" | "unknown" | "failed"
  readonly detail?: string
  readonly sessionID: string
  readonly operation: RemoteOperation
  readonly input: Readonly<Record<string, unknown>>
}

export type RemoteStoreState = {
  readonly connection: RemoteConnectionState
  readonly owner?: { readonly id: string; readonly expiresAt: number }
  readonly devices: readonly RemoteDeviceInfo[]
  readonly activeDeviceID?: string
  readonly advertised: readonly string[]
  readonly sessions: readonly SessionInfoView[]
  readonly activeSessionID?: string
  readonly view?: SessionView
  readonly transport: RemoteTransportStatus
  readonly mutations: readonly PendingMutation[]
  readonly notice?: string
  /** In-app alerts for live events, newest per category. */
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
  readonly reloadMessages: () => Promise<void>
  readonly loadShellOutputPage: (shellID: string) => Promise<void>
  readonly sendPrompt: (input: { readonly text: string; readonly delivery: "steer" | "queue" }) => Promise<void>
  readonly retryMutation: (id: string) => Promise<void>
  readonly dismissMutation: (id: string) => void
  readonly dismissNotification: (id: string) => void
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
    mutations: [],
    notifications: [],
    transport: { kind: "idle" },
    unhandledEvents: 0,
  }
  let transport: RemoteTransport | undefined
  let selectionToken = 0
  /**
   * Generation of the backend Session-list context. A list read may publish only
   * while it still describes the generation it was issued for, and every
   * connection change or Session invalidation starts a new generation.
   */
  let sessionsToken = 0
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
  /** Snapshot-covered part keys that stale ephemeral fragments must not append to. */
  const sealed = new Map<string, Set<string>>()
  let hydration: HydrationWindow | undefined
  /**
   * Live file changes that arrive while a ledger read is pending. The read describes
   * the device's ledger at one instant; a record this client applied after the read was
   * issued is newer, so it is re-applied over the read instead of being replaced by it.
   */
  let fileChangeRead: { readonly sessionID: string; readonly live: FileChangeView[] } | undefined
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
    state = { ...state, ...patch }
    notify()
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

  const flush = () => {
    cancelBatch = undefined
    const batch = queued
    queued = []
    if (batch.length === 0) return
    let view = state.view
    let unhandled = state.unhandledEvents
    let gap = false
    for (const item of batch) {
      if (!view || item.sessionID !== view.id) continue
      const sequence = readEventSequence(item.event)
      const aggregate = readAggregateID(item.event)
      const opened = openedPartKey(item.event)
      if (opened !== undefined) sealed.get(view.id)?.delete(opened)
      const key = ephemeralPartKey(item.event)
      if (key !== undefined && isEphemeralEvent(item.event) && sealed.get(view.id)?.has(key) === true) continue
      if (aggregate !== undefined && aggregate !== view.id) continue
      if (sequence.seq !== undefined && view.watermark !== undefined) {
        // Duplicates below the watermark are dropped. The sequence is durable and
        // per aggregate, so a gap means a lost event and forces a re-read.
        if (sequence.seq <= view.watermark) continue
        if (sequence.seq > view.watermark + 1) gap = true
      }
      // Alerts follow the events that reach the projection: a dropped duplicate
      // raises nothing, and the snapshot paths below never call this loop.
      const category = notificationCategory(item.event)
      if (category !== undefined) delivery.deliver(category)
      const at = now()
      const next = applySessionEvent(view, item.event, at)
      unhandled += next.unhandledEvents - view.unhandledEvents
      view = sequence.seq === undefined ? next : { ...next, watermark: sequence.seq }
      const type = typeof item.event === "object" && item.event !== null ? Reflect.get(item.event, "type") : undefined
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
      unhandledEvents: unhandled,
      notifications: delivery.entries(),
    }
    notify()
    if (gap) void reloadSnapshot(state.activeSessionID, selectionToken, "Events were missed, so history was reloaded.")
  }

  const queueEvent = (sessionID: string, event: unknown) => {
    queued.push({ sessionID, event })
    cancelBatch ??= schedule(flush, batchMs)
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

  const handleStatus = (owner: RemoteTransport, status: RemoteTransportStatus) => {
    // A status from a replaced connection says nothing about the connection that
    // replaced it: it must not overwrite the live transport, clear the live
    // subscription, raise or end the live alerts, or report a rejected credential.
    if (!isCurrentConnection(owner)) return
    const rejected = status.kind === "closed" && (status.code === 4401 || status.code === 4403)
    // Only a connection that was live can drop: a deliberate close, an initial
    // failure, and a credential rejection are not a device that stopped reporting.
    if (status.kind === "closed" && status.retryable && lastStatusKind === "open") {
      delivery.deliver("device-disconnected")
    }
    lastStatusKind = status.kind
    if (status.kind === "closed") subscribedSessionID = undefined
    if (rejected && status.kind === "closed") {
      // Relay authorization can reject one revoked device while the browser account
      // remains valid. Tear down only that device, then let the authoritative account
      // answer decide whether the browser is truly signed out.
      sessionsToken += 1
      setState({
        transport: status,
        connection: deviceConnection(state.devices.filter((device) => device.status === "active" && device.online).length),
        activeDeviceID: undefined,
        advertised: [],
        sessions: [],
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
  const applySnapshot = (sessionID: string, payload: unknown, base?: SessionView): SessionView | "invalid" | "stale" => {
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
    return view
  }

  const applyEvent = (view: SessionView, event: unknown, replaying: boolean): SessionView => {
    const aggregate = readAggregateID(event)
    if (aggregate !== undefined && aggregate !== view.id) return view
    const opened = openedPartKey(event)
    if (opened !== undefined) sealed.get(view.id)?.delete(opened)
    const key = ephemeralPartKey(event)
    if (!replaying && key !== undefined && isEphemeralEvent(event) && sealed.get(view.id)?.has(key) === true) return view
    return applySessionEvent(view, event, now())
  }

  const loadSessionReads = async (sessionID: string, token: number, notice?: string) => {
    const active = transport
    if (!active) return
    const pending = { sessionID, live: [] as FileChangeView[] }
    const requestsDuringRead = { sessionID, live: [] as { readonly event: unknown; readonly at: number }[] }
    fileChangeRead = pending
    requestReads.add(requestsDuringRead)
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
      sealed.set(sessionID, new Set(sealedPartKeys(applied.messages)))
      let view = applied
      for (const event of owned.events) view = applyEvent(view, event, true)
      owned.replayed.forEach((key) => sealed.get(sessionID)?.delete(key))
      setState({ view, ...(notice === undefined ? {} : { notice }) })
      return "applied"
    } finally {
      if (hydration === owned) hydration = undefined
    }
  }

  const readAllSessions = async (owner: RemoteTransport): Promise<RemoteRequestOutcome> => {
    const data: unknown[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const page = await owner.request("session.list", {
        input: { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
      })
      if (page.status !== "ok") return page
      data.push(...readSessionInfoList(page.value))
      const value = typeof page.value === "object" && page.value !== null ? page.value : undefined
      const cursors = value === undefined ? undefined : Reflect.get(value, "cursor")
      const next = typeof cursors === "object" && cursors !== null ? Reflect.get(cursors, "next") : undefined
      if (typeof next !== "string" || next.length === 0) return { status: "ok", value: { data } }
      if (seen.has(next))
        return {
          status: "failed",
          error: { code: "invalid_message", message: "The device repeated a Session list cursor" },
        }
      seen.add(next)
      cursor = next
    }
  }

  /** Reads every authoritative backend page for the generation that requested it. */
  const loadSessions = async (token: number) => {
    const active = transport
    if (!active) return
    const [listed, activeStatus] = await Promise.all([
      readAllSessions(active),
      // Optional read: a connection that cannot answer it leaves `running` unknown.
      active.request("session.active"),
    ])
    // A read that settles after its connection was replaced, or after a newer
    // Session invalidation arrived, describes a list this store no longer shows.
    if (token !== sessionsToken || !isCurrentConnection(active)) return
    if (listed.status !== "ok") {
      // An open, authenticated browser relay reports this exact structured response
      // when its selected device has no local agent. Transport failures and every
      // other failed read remain connection errors, not a claim about device reachability.
      // The last list stays as the device's read-only record until it answers again.
      if (listed.status === "failed" && listed.error.code === "agent_unavailable") {
        setState({ connection: { kind: "offline", deviceName: deviceName(state.activeDeviceID ?? "device") } })
        return
      }
      setState({ connection: { kind: "error", message: describeOutcome(listed, "Session list") } })
      return
    }
    const running = activeStatus.status === "ok" ? readActiveSessions(activeStatus.value) : undefined
    const sessions = readSessionInfoList(listed.value).flatMap((entry) => {
      const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined
      const info = readSessionInfo(entry, {
        ...(running === undefined || typeof id !== "string" ? {} : { running: running.has(id) }),
      })
      return info ? [info] : []
    })
    setState({
      ...(state.connection.kind === "offline" || state.connection.kind === "error"
        ? { connection: connectionFor(active.status(), state.activeDeviceID) }
        : {}),
      sessions,
      advertised: sessions.map((session) => session.id),
    })
  }

  const selectSession = async (sessionID: string) => {
    const active = transport
    // One selection owns the view; a superseded selection never writes state again.
    const token = ++selectionToken
    setState({ activeSessionID: sessionID, view: createSessionView(sessionID), notice: undefined })
    if (!active) return
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
      setState({ notice: "This session is not available from the connected device." })
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
        setState({ notice: describeOutcome(outcome, "Session history") })
        return
      }
      const applied = applySnapshot(sessionID, outcome.value, state.view)
      if (applied === "invalid") {
        setState({ notice: "The session snapshot was not readable, so the current history is kept." })
        return
      }
      if (applied === "stale") {
        setState({ notice: "An older session snapshot arrived and was ignored." })
        return
      }
      sealed.set(sessionID, new Set(sealedPartKeys(applied.messages)))
      let view = applied
      for (const event of owned.events) view = applyEvent(view, event, true)
      owned.replayed.forEach((key) => sealed.get(sessionID)?.delete(key))
      setState({ view })
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
        setState({ owner: { id: me.value.user.id, expiresAt: me.value.session.expiresAt }, devices })
        api.disconnect()
        setState({
          activeDeviceID: selected.id,
          sessions,
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
      await options.http.logout()
      api.disconnect()
      setState({ owner: undefined, devices: [], sessions: [], advertised: [], activeSessionID: undefined, view: undefined, connection: { kind: "signed-out" }, notice: "Signed out." })
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
      transport?.close(1000, "switching device")
      // The new socket starts with no subscriptions, no alerts, and no list of its own.
      subscribedSessionID = undefined
      queued = []
      sessionsToken += 1
      setState({ activeDeviceID: deviceID, sessions: [], advertised: [], activeSessionID: undefined, view: undefined, notice: undefined })
      endAlerts()
      const created = options.createTransport(deviceID, {
        onStatus: (status) => handleStatus(created, status),
        onSessions: () => {
          if (!isCurrentConnection(created)) return
          sessionsToken += 1
          setState({ advertised: [] })
          void loadSessions(sessionsToken)
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
      // The device choice the account reads describe ends here, so a read that is
      // still in flight cannot reconnect a device the user has dropped.
      accountToken += 1
      transport?.close(1000, "disconnected")
      transport = undefined
      subscribedSessionID = undefined
      queued = []
      sessionsToken += 1
      setState({
        activeDeviceID: undefined,
        advertised: [],
        sessions: [],
        activeSessionID: undefined,
        view: undefined,
        connection: state.owner === undefined ? { kind: "signed-out" } : deviceConnection(state.devices.length),
      })
      endAlerts()
    },
    selectSession,
    reloadMessages,
    loadShellOutputPage,
    sendPrompt: async (input) => {
      const sessionID = state.activeSessionID
      const text = input.text.trim()
      if (sessionID === undefined) {
        setState({ notice: "Select a session before sending a prompt." })
        return
      }
      if (text.length === 0) return
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
            input: { id: messageID, text, delivery: input.delivery },
          },
        ],
      })
      await request(
        {
          id: messageID,
          kind: "prompt",
          label: input.delivery === "queue" ? "Queued prompt" : "Prompt",
          state: "sending",
          sessionID,
          operation: "session.prompt",
          input: { id: messageID, text, delivery: input.delivery },
        },
        { sessionID },
      )
    },
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
      cancelBatch?.()
      cancelBatch = undefined
      transport?.close(1000, "disposed")
      transport = undefined
      subscribedSessionID = undefined
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
    await loadSessions(sessionsToken)
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

export function readSessionInfo(value: unknown, options: { readonly running?: boolean } = {}): SessionInfoView | undefined {
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
    title: typeof record.title === "string" && record.title.length > 0 ? record.title : id,
    ...(typeof record.projectID === "string" && record.projectID.length > 0 ? { projectID: record.projectID } : {}),
    ...(typeof location.directory === "string" && location.directory.length > 0 ? { directory: location.directory } : {}),
    ...(typeof record.agent === "string" ? { agent: record.agent } : {}),
    ...(model === undefined ? {} : { model, modelLabel: modelLabel(model) }),
    updatedAt: typeof time.updated === "number" ? time.updated : 0,
    archived: typeof time.archived === "number",
    ...(options.running === undefined ? {} : { running: options.running }),
  }
}

/** Reads `GET /api/session/active`: `{ data: Record<SessionID, { type: "running" }> }`. */
export function readActiveSessions(payload: unknown): ReadonlySet<string> | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const data = (payload as { data?: unknown }).data
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
  return new Set(
    Object.entries(data as Record<string, unknown>)
      .filter(([, status]) => typeof status === "object" && status !== null && (status as { type?: unknown }).type === "running")
      .map(([sessionID]) => sessionID),
  )
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
