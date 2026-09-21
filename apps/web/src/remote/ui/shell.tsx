import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Link } from "../../router/router"
import { Chip } from "../../ui/chip"
import { Icon, type IconName } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { ThemeToggle } from "../../ui/site"
import { useRemote } from "../context"
import {
  modelLabel,
  type ActivityItem,
  type PendingRequestView,
  type RemoteMessageView,
  type SessionView,
} from "../projection"
import type { SessionInfoView } from "../store"
import type { RemoteTransportStatus } from "../transport"
import {
  accountReadState,
  connectionBanner,
  deviceAvailabilityView,
  sessionStateChips,
  summarizeConnection,
  type ConnectionTone,
  type RemoteConnectionState,
  type RemoteSessionStatus,
  type RemoteSessionSummary,
  type SessionChip,
} from "../view-model"
import { Composer } from "./composer"
import { AccountSettings, AppearanceSettings, AutonomySettings, DeviceSettings, NotificationSettings } from "./settings"
import { ActivityRow, MessageRow, RequestCard } from "./conversation"

const views = ["/remote", "/remote/sessions", "/remote/activity", "/remote/settings"] as const

export type RemoteView = (typeof views)[number]

const sessionsSupport = "Every session the connected device advertises to this workspace."
const settingsSupport = "Account, devices, appearance, autonomy, and notifications for this workspace."

export function RemoteShell(props: { readonly path: string }): JSX.Element {
  const remote = useRemote()
  const [navOpen, setNavOpen] = createSignal(false)
  const [activityOpen, setActivityOpen] = createSignal(false)

  const state = () => remote.state()
  const view: RemoteView = views.find((entry) => entry === props.path) ?? "/remote"
  const activeSession = () => state().sessions.find((session) => session.id === state().activeSessionID)
  const activeChips = (): readonly SessionChip[] => {
    const session = activeSession()
    return session === undefined ? [] : sessionChips(session, state().view)
  }
  const sessionRow = () => (showsSessionRow(view, activeSession() !== undefined) ? activeSession()?.title : undefined)

  return (
    <div class="app">
      <RemoteHeader
        navOpen={navOpen()}
        activityOpen={activityOpen()}
        onOpenNav={() => setNavOpen(true)}
        onOpenActivity={() => setActivityOpen(true)}
        sessionTitle={sessionRow()}
        chips={activeChips()}
      />

      <ConnectionStrip />

      <div class="workspace">
        <aside class="workspace__rail" aria-label="Sessions">
          <SessionPanel />
        </aside>

        <div class="workspace__main">
          <div class="workspace__scroll">
            <Notices />
            <Show when={view === "/remote"}>
              <ConversationView title={activeSession()?.title ?? noSessionTitle} chips={activeChips()} />
            </Show>
            <Show when={view === "/remote/sessions"}>
              <SessionsPage />
            </Show>
            <Show when={view === "/remote/activity"}>
              <ActivityPage />
            </Show>
            <Show when={view === "/remote/settings"}>
              <SettingsPage />
            </Show>
          </div>
          <Show when={view === "/remote"}>
            <Composer
              sessionID={state().activeSessionID}
              running={state().view?.status === "running"}
              canSend={state().transport.kind === "open" && state().activeSessionID !== undefined}
            />
          </Show>
        </div>

        <aside class="workspace__activity" aria-label="Activity and requests">
          <ActivityPanel />
        </aside>
      </div>

      <BottomNav view={view} />

      <Show when={navOpen()}>
        <Modal class="overlay--slideover" label="Sessions" onClose={() => setNavOpen(false)}>
          <SessionPanel onNavigate={() => setNavOpen(false)} />
        </Modal>
      </Show>

      <Show when={activityOpen()}>
        <Modal class="overlay--slideover" label="Activity" onClose={() => setActivityOpen(false)}>
          <ActivityPanel onNavigate={() => setActivityOpen(false)} />
        </Modal>
      </Show>
    </div>
  )
}

/**
 * A selected session keeps its own row under the bar row on the surfaces that carry the
 * workspace, so the session title and its state chips never compete with the device
 * control for one line. Settings names itself with the page head alone, and a surface
 * without a selected session renders the bar row alone.
 */
export function showsSessionRow(path: string, hasSession: boolean): boolean {
  return hasSession && path !== "/remote/settings"
}

export type ConnectionStripView = {
  readonly tone: ConnectionTone
  readonly body: string
  readonly showReconnect: boolean
  readonly showSettings: boolean
}

/**
 * What the reserved connection strip states, and which controls it offers. The strip is
 * present at every width so a connection change replaces text inside one row instead of
 * inserting a banner that moves the composer.
 */
export function connectionStripView(input: {
  readonly connection: RemoteConnectionState
  readonly transportKind: RemoteTransportStatus["kind"]
  readonly activeDeviceID?: string
  readonly advertised: number
}): ConnectionStripView {
  const summary = summarizeConnection(input.connection)
  const banner = connectionBanner(input.connection)
  return {
    tone: summary.tone,
    body: banner === undefined ? `${summary.label} — ${summary.detail}` : `${banner.title} — ${banner.body}`,
    showReconnect:
      input.activeDeviceID !== undefined &&
      input.transportKind !== "open" &&
      ((banner?.showReconnect ?? false) || input.advertised > 0),
    showSettings: banner?.showSettings ?? false,
  }
}

/** One advertised session as the header chips and the session rows describe it. */
export function summarizeSession(session: SessionInfoView, view: SessionView | undefined): RemoteSessionSummary {
  const active = view !== undefined && view.id === session.id ? view : undefined
  const autonomy = active?.autonomy
  const model = modelLabel(active?.model) ?? session.modelLabel
  return {
    id: session.id,
    title: session.title,
    status: sessionStatus(session, active),
    agent: active?.agent ?? session.agent,
    model,
    autonomy: autonomy?.mode,
    yoloLevel: autonomy?.yolo,
    guardrailsEnforced: autonomy === undefined ? undefined : autonomy.mode !== "yolo" || autonomy.yolo < 3,
    updatedAt: session.updatedAt > 0 ? new Date(session.updatedAt).toISOString() : undefined,
  }
}

/**
 * Whether the loaded session view reports an unanswered approval. Only the selected
 * session has a loaded view, so a session this client has not loaded keeps the status the
 * device reported for it instead of being described as waiting.
 */
export function awaitsApproval(view: SessionView | undefined, sessionID: string): boolean {
  if (view === undefined || view.id !== sessionID) return false
  return view.requests.some((request) => request.kind === "permission" || request.kind === "guardrail")
}

/**
 * The chips one session row and the selected session's header row show: the status the
 * device reported, plus the fact that the loaded view is holding an unanswered approval.
 */
export function sessionChips(session: SessionInfoView, view: SessionView | undefined): readonly SessionChip[] {
  const chips = sessionStateChips(summarizeSession(session, view))
  if (!awaitsApproval(view, session.id)) return chips
  return [...chips, { label: "Waiting for approval", tone: "attention" }]
}

/**
 * The client-side session filter. It reads the sessions the workspace already holds and
 * issues no request, so an empty result means the filter matched nothing rather than that
 * the device advertises nothing.
 */
export function filterSessions(sessions: readonly SessionInfoView[], query: string): readonly SessionInfoView[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return sessions
  return sessions.filter((session) =>
    [session.title, session.agent ?? "", session.modelLabel ?? ""].some((value) => value.toLowerCase().includes(needle)),
  )
}

export type QueueRowView = {
  readonly id: string
  readonly icon: IconName
  readonly kind: string
  readonly title: string
  readonly detail: string
}

/**
 * The events the selected session reported, in the order they happened. The transcript's
 * tool calls and terminal commands are the durable record the client already holds, so the
 * reported list is built from them and reconciled with the live activity stream by event ID:
 * a live row keeps the status and time the device published, and a snapshot-loaded session
 * reports its events instead of an empty panel. The ledger keeps each path's latest patch
 * without a per-path time, so a ledger row takes the session's last update.
 */
export function reportedEvents(view: SessionView | undefined): readonly ActivityItem[] {
  if (view === undefined) return []
  const fromMessages: ActivityItem[] = view.messages.flatMap((message) => {
    if (message.kind === "shell") {
      return [
        {
          id: `shell-${message.shellID}`,
          kind: "terminal" as const,
          title: message.command,
          detail: message.status,
          status: message.status,
          at: message.created,
        },
      ]
    }
    if (message.kind !== "assistant") return [] as ActivityItem[]
    return message.parts.flatMap((part): ActivityItem[] =>
      part.kind === "tool"
        ? [
            {
              id: `tool-${part.callID}`,
              kind: "tool" as const,
              title: part.name,
              status: part.status,
              at: message.created,
            },
          ]
        : [],
    )
  })
  const fromLedger: ActivityItem[] = view.fileChanges.map((change) => ({
    id: `file-${change.path}`,
    kind: "file",
    title: change.path,
    detail: `+${change.additions} −${change.deletions}`,
    at: view.updatedAt ?? 0,
  }))
  const live = new Set(view.activity.map((item) => item.id))
  return [...fromMessages, ...fromLedger]
    .filter((item) => !live.has(item.id))
    .concat(view.activity)
    .sort((left, right) => left.at - right.at)
}

/** One waiting request summarised as a row, instead of repeating its whole card. */
export function queueRowView(request: PendingRequestView): QueueRowView {
  if (request.kind === "permission") {
    const target = request.resources.length === 0 ? request.action : `${request.action} on ${request.resources.join(", ")}`
    return { id: request.id, icon: "shield", kind: "Permission", title: target, detail: "waits for a decision" }
  }
  if (request.kind === "guardrail") {
    return {
      id: request.id,
      icon: "alert",
      kind: request.hardReview ? "Guardrail review (human decision required)" : "Guardrail review",
      title: request.action,
      detail: request.reason,
    }
  }
  return {
    id: request.id,
    icon: "chat",
    kind: "Question",
    title: request.questions[0]?.header ?? "Question",
    detail: "waits for your answer",
  }
}

const noSessionTitle = "No session selected"

function RemoteHeader(props: {
  readonly navOpen: boolean
  readonly activityOpen: boolean
  readonly onOpenNav: () => void
  readonly onOpenActivity: () => void
  readonly sessionTitle?: string
  readonly chips: readonly SessionChip[]
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const connection = () => summarizeConnection(state().connection)
  const devices = () =>
    deviceAvailabilityView(accountReadState({ connection: state().connection, owner: state().owner }), state().devices.length)
  return (
    <header class="app-header">
      <div class="app-header__inner">
        <button
          type="button"
          class="button button--ghost button--icon app-header__menu"
          aria-label="Open sessions"
          aria-expanded={props.navOpen}
          onClick={props.onOpenNav}
        >
          <Icon name="menu" />
        </button>
        <Link href="/" class="brand" title="YCoding home">
          <img class="brand__mark" src="/brand/ycoding-mark.svg" alt="YCoding" width={28} height={28} />
        </Link>
        <div class="remote-device">
          <label class="field">
            <span class="visually-hidden">Device</span>
            <select
              class="select"
              value={state().activeDeviceID ?? ""}
              disabled={!devices().selectable}
              onChange={(event) => {
                const deviceID = event.currentTarget.value
                if (deviceID.length > 0) remote.store.connect(deviceID)
              }}
            >
              <option value="">{devices().placeholder}</option>
              <For each={state().devices}>
                {(device) => (
                  <option value={device.id} disabled={device.status !== "active"}>
                    {device.name}
                    {device.status === "active" ? "" : " (revoked)"}
                  </option>
                )}
              </For>
            </select>
          </label>
          <span class="remote-connection">
            <span class={`status-dot status-dot--${connection().tone}`} aria-hidden="true" />
            <span class="remote-connection-label">{connection().label}</span>
          </span>
        </div>
        <div class="app-header__end">
          <button
            type="button"
            class="button button--ghost button--icon"
            aria-label="Open activity"
            aria-expanded={props.activityOpen}
            onClick={props.onOpenActivity}
          >
            <Icon name="activity" />
          </button>
          <span class="remote-header__theme">
            <ThemeToggle />
          </span>
          <Link
            href="/remote/settings"
            class="button button--ghost button--icon remote-header__settings"
            ariaLabel="Settings"
            title="Settings"
          >
            <Icon name="settings" />
          </Link>
        </div>
      </div>
      <Show when={props.sessionTitle !== undefined}>
        <div class="remote-title">
          <h1 class="remote-title__text">{props.sessionTitle}</h1>
          <Show when={props.chips.length > 0}>
            <div class="remote-title__chips">
              <For each={props.chips}>{(chip) => <Chip label={chip.label} tone={chip.tone} />}</For>
            </div>
          </Show>
        </div>
      </Show>
    </header>
  )
}

/**
 * What the workspace has to say beyond the connection row: the last read or reconnect
 * notice, and the standing warning for a command whose outcome never settled. Both are
 * content of the working column, so neither changes the height of a declared app row.
 */
function Notices(): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const unsettled = () => state().mutations.filter((mutation) => mutation.state === "unknown").length
  return (
    <>
      <Show when={state().notice}>
        {(notice) => (
          <p class="notice-strip" role="status">
            <Icon name="alert" size={16} />
            <span class="notice-strip__body">{notice()}</span>
          </p>
        )}
      </Show>
      <Show when={unsettled() > 0}>
        <p class="notice-strip notice-strip--warning" role="status">
          <Icon name="alert" size={16} />
          <span class="notice-strip__body">
            A command did not settle, so its outcome is unknown. Nothing was resent automatically.
          </span>
        </p>
      </Show>
    </>
  )
}

function ConnectionStrip(): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const strip = () =>
    connectionStripView({
      connection: state().connection,
      transportKind: state().transport.kind,
      activeDeviceID: state().activeDeviceID,
      advertised: state().advertised.length,
    })
  const detail = () => {
    const sessions = state().sessions.length
    if (sessions === 0) return undefined
    const waiting = state().view?.requests.length ?? 0
    const count = `${sessions} ${sessions === 1 ? "session" : "sessions"}`
    return waiting === 0 ? count : `${count} · ${waiting} waiting for you`
  }
  return (
    <div class={`status-strip${strip().tone === "online" ? "" : ` status-strip--${strip().tone}`}`} role="status">
      <span class={`status-dot status-dot--${strip().tone}`} aria-hidden="true" />
      <span class="status-strip__body">{strip().body}</span>
      <span class="status-strip__spacer" />
      <Show when={strip().showReconnect}>
        <button
          type="button"
          class="button button--secondary button--small"
          onClick={() => {
            const deviceID = state().activeDeviceID
            if (deviceID !== undefined) remote.store.connect(deviceID)
          }}
        >
          <Icon name="refresh" size={16} />
          Reconnect
        </button>
      </Show>
      <Show when={strip().showSettings}>
        <Link href="/remote/settings" class="button button--secondary button--small">
          Open settings
        </Link>
      </Show>
      <Show when={detail()}>{(text) => <span class="status-strip__detail">{text()}</span>}</Show>
    </div>
  )
}

function SessionPanel(props: { readonly onNavigate?: () => void }): JSX.Element {
  const remote = useRemote()
  const [query, setQuery] = createSignal("")
  const state = () => remote.state()
  const deviceName = () => state().devices.find((device) => device.id === state().activeDeviceID)?.name
  const sessions = () => filterSessions(state().sessions, query())
  const advertised = () => {
    const total = state().sessions.length
    const name = deviceName()
    if (total === 0 || name === undefined) return undefined
    return `${total} ${total === 1 ? "session" : "sessions"} advertised by ${name}.`
  }
  return (
    <div class="pane">
      <div class="pane__head">
        <p class="pane__title">Sessions</p>
      </div>
      <Show
        when={state().devices.length > 0}
        fallback={<DeviceEmptyState onNavigate={props.onNavigate} />}
      >
        <Show
          when={state().activeDeviceID !== undefined}
          fallback={<DeviceEmptyState />}
        >
          <Show when={state().sessions.length > 0} fallback={<NoSessionsState />}>
            <label class="field">
              <span class="visually-hidden">Filter sessions</span>
              <input
                class="input"
                type="search"
                placeholder="Filter sessions"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <Show
              when={sessions().length > 0}
              fallback={
                <div class="empty">
                  <p class="empty__title">No session matches that filter</p>
                  <p>The device still advertises {advertisedCount(state().sessions.length)}; none matches “{query()}”.</p>
                </div>
              }
            >
              <div class="session-list">
                <For each={sessions()}>
                  {(session) => <SessionRow session={session} onNavigate={props.onNavigate} />}
                </For>
              </div>
            </Show>
            <Show when={advertised()}>{(note) => <p class="panel__note">{note()}</p>}</Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function SessionRow(props: { readonly session: SessionInfoView; readonly onNavigate?: () => void }): JSX.Element {
  const remote = useRemote()
  const active = () => remote.state().activeSessionID === props.session.id
  const chips = () => sessionChips(props.session, remote.state().view)
  return (
    <button
      type="button"
      class={`session-row${active() ? " session-row--active" : ""}`}
      aria-pressed={active()}
      onClick={() => {
        void remote.store.selectSession(props.session.id)
        props.onNavigate?.()
      }}
    >
      <span class="session-row__mark">
        <Icon name={active() ? "chat" : "sessions"} size={16} />
      </span>
      <span class="session-row__body">
        <span class="session-row__title">{props.session.title}</span>
        <span class="session-row__meta">
          <span class="session-row__status">
            <For each={chips()}>{(chip) => <Chip label={chip.label} tone={chip.tone} />}</For>
          </span>
          <Show when={props.session.agent}>
            <span>{props.session.agent}</span>
          </Show>
          <Show when={props.session.modelLabel}>
            <span>{props.session.modelLabel}</span>
          </Show>
          <Show when={props.session.updatedAt > 0}>
            <span>{new Date(props.session.updatedAt).toLocaleString()}</span>
          </Show>
        </span>
      </span>
    </button>
  )
}

/**
 * The device surfaces share one honest empty state: a browser whose account read has not
 * settled is never reported as signed out, and a signed-in account with no machine is
 * never reported as having no machines at all.
 */
function DeviceEmptyState(props: { readonly onNavigate?: () => void }): JSX.Element {
  const remote = useRemote()
  const devices = () =>
    deviceAvailabilityView(
      accountReadState({ connection: remote.state().connection, owner: remote.state().owner }),
      remote.state().devices.length,
    )
  return (
    <div class="empty">
      <p class="empty__title">{devices().title}</p>
      <p>{devices().body}</p>
      <Show when={devices().showSettings}>
        <Link href="/remote/settings" class="button button--secondary button--small" onClick={props.onNavigate}>
          Open settings
        </Link>
      </Show>
    </div>
  )
}

function NoSessionsState(): JSX.Element {
  return (
    <div class="empty">
      <p class="empty__title">No sessions advertised</p>
      <p>The connected device reports no sessions that can be controlled from here.</p>
    </div>
  )
}

function ConversationView(props: { readonly title: string; readonly chips: readonly SessionChip[] }): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const view = () => state().view
  const requests = () => view()?.requests ?? []
  const messages = () => view()?.messages ?? []
  return (
    <Show
      when={state().activeSessionID !== undefined}
      fallback={
        <>
          <div class="page-head">
            <div>
              <h1 class="page-head__title">{noSessionTitle}</h1>
              <p class="page-head__support">
                This workspace shows the conversation of a session running on your own machine. Nothing is simulated: without
                a signed-in account and a connected device there is nothing to display.
              </p>
            </div>
          </div>
          <div class="pane">
            <DeviceEmptyState />
            <Link href="/docs/usage/remote" class="button button--secondary button--small">
              How remote access works
            </Link>
          </div>
        </>
      }
    >
      <div class="page-head compact-head">
        <div>
          <h1 class="page-head__title">{props.title}</h1>
          <Show when={props.chips.length > 0}>
            <div class="remote-title__chips" style={{ "margin-block-start": "var(--yc-space-2)" }}>
              <For each={props.chips}>{(chip) => <Chip label={chip.label} tone={chip.tone} />}</For>
            </div>
          </Show>
        </div>
      </div>
      <div class="pane">
        <Show when={requests().length > 0}>
          <div class="requests">
            <RequestCards requests={requests} activeSessionID={state().activeSessionID} />
          </div>
        </Show>
        <Show
          when={messages().length > 0}
          fallback={
            <div class="empty">
              <p class="empty__title">No messages yet</p>
              <p>Send a prompt below to start work in this session.</p>
            </div>
          }
        >
          <Transcript messages={messages} />
        </Show>
      </div>
    </Show>
  )
}

/**
 * The transcript keyed by message ID. A projection update replaces the message object,
 * so the row identity comes from the message ID alone: that is what keeps an open tool
 * body, an expanded output page, and the focus of the control that opened it.
 */
function Transcript(props: { readonly messages: () => readonly RemoteMessageView[] }): JSX.Element {
  const ids = createMemo(() => props.messages().map((message) => message.id))
  // A live ID was produced by this same list, so it always resolves to a message.
  const message = (id: string) => props.messages().find((entry) => entry.id === id)!
  return (
    <ol class="transcript">
      <For each={ids()}>{(id) => <MessageRow message={() => message(id)} />}</For>
    </ol>
  )
}

/** Request cards keyed by request ID, so a reply draft survives a projection update. */
function RequestCards(props: {
  readonly requests: () => readonly PendingRequestView[]
  readonly activeSessionID?: string
}): JSX.Element {
  const ids = createMemo(() => props.requests().map((request) => request.id))
  const request = (id: string) => props.requests().find((entry) => entry.id === id)!
  return (
    <For each={ids()}>
      {(id) => <RequestCard request={() => request(id)} activeSessionID={props.activeSessionID} />}
    </For>
  )
}

function SessionsPage(): JSX.Element {
  const remote = useRemote()
  const [query, setQuery] = createSignal("")
  const sessions = () => filterSessions(remote.state().sessions, query())
  return (
    <div class="pane">
      <div class="page-head" style={{ padding: "0 0 var(--yc-space-4)" }}>
        <div>
          <h1 class="page-head__title">Sessions</h1>
          <p class="page-head__support">{sessionsSupport}</p>
        </div>
      </div>
      <Show
        when={remote.state().sessions.length > 0}
        fallback={
          <Show when={remote.state().activeDeviceID !== undefined} fallback={<DeviceEmptyState />}>
            <NoSessionsState />
          </Show>
        }
      >
        <div class="filter-bar" style={{ padding: "0" }}>
          <label class="field" style={{ flex: "1" }}>
            <span class="visually-hidden">Filter sessions</span>
            <input
              class="input"
              type="search"
              placeholder="Filter by title, agent, or model"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <span class="chip">{advertisedCount(sessions().length)}</span>
        </div>
        <Show
          when={sessions().length > 0}
          fallback={
            <div class="empty">
              <p class="empty__title">No session matches that filter</p>
              <p>The device still advertises {advertisedCount(remote.state().sessions.length)}; none matches “{query()}”.</p>
            </div>
          }
        >
          <div class="session-list">
            <For each={sessions()}>{(session) => <SessionRow session={session} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function ActivityPage(): JSX.Element {
  const remote = useRemote()
  const requests = () => remote.state().view?.requests ?? []
  return (
    <div class="pane">
      <div class="queue">
        <div class="queue__head">
          <h1 class="page-head__title" style={{ "font-size": "var(--yc-size-xl)" }}>
            Activity
          </h1>
          <Show when={requests().length > 0}>
            <span class="queue__count">{requestCount(requests().length)}</span>
          </Show>
        </div>
        <Show when={requests().length > 0}>
          <p class="pane__title">Waiting for you</p>
          <RequestCards requests={requests} activeSessionID={remote.state().activeSessionID} />
        </Show>
      </div>
      <h3 style={{ "font-size": "var(--yc-size-md)", "margin-block-start": "var(--yc-space-6)" }}>Reported events</h3>
      <ActivityList />
    </div>
  )
}

function SettingsPage(): JSX.Element {
  return (
    <>
      <div class="page-head">
        <div>
          <h1 class="page-head__title">Settings</h1>
          <p class="page-head__support">{settingsSupport}</p>
        </div>
      </div>
      <div class="pane" style={{ "padding-inline": "0" }}>
        <div class="settings">
          <AccountSettings />
          <DeviceSettings />
          <AppearanceSettings />
          <AutonomySettings />
          <NotificationSettings />
        </div>
      </div>
    </>
  )
}

/** The activity column: the waiting queue first, then the events the session reported. */
function ActivityPanel(props: { readonly onNavigate?: () => void }): JSX.Element {
  const remote = useRemote()
  const requests = () => remote.state().view?.requests ?? []
  return (
    <div class="pane">
      <div class="pane__head">
        <p class="pane__title">Activity</p>
      </div>
      <Show when={requests().length > 0}>
        <div class="queue">
          <div class="queue__head">
            <p class="pane__title">Waiting for you</p>
            <span class="queue__count">{requestCount(requests().length)}</span>
          </div>
          <For each={requests()}>{(request) => <QueueRow request={request} onNavigate={props.onNavigate} />}</For>
        </div>
      </Show>
      <ActivityList />
    </div>
  )
}

function QueueRow(props: { readonly request: PendingRequestView; readonly onNavigate?: () => void }): JSX.Element {
  const row = () => queueRowView(props.request)
  return (
    <div class="queue-row">
      <span class="queue-row__icon" aria-hidden="true">
        <Icon name={row().icon} size={16} />
      </span>
      <span class="queue-row__body">
        <span class="queue-row__title">{row().title}</span>
        <span class="queue-row__detail">
          {row().kind} · {row().detail}
        </span>
      </span>
      <Link href="/remote/activity" class="button button--secondary button--small" onClick={props.onNavigate}>
        Answer
      </Link>
    </div>
  )
}

function ActivityList(): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const activity = () => reportedEvents(state().view)
  return (
    <Show
      when={state().view !== undefined}
      fallback={
        <div class="empty">
          <p class="empty__title">{noSessionTitle}</p>
          <p>Tool calls, terminal commands, and file changes appear here once a session is selected.</p>
        </div>
      }
    >
      <Show
        when={activity().length > 0}
        fallback={
          <div class="empty">
            <p class="empty__title">No activity yet</p>
            <p>Tool calls, terminal commands, and file changes appear here as the session reports them.</p>
          </div>
        }
      >
        <ul class="activity">
          <For each={[...activity()].reverse()}>{(item) => <ActivityRow item={item} />}</For>
        </ul>
        <p class="panel__note">
          {state().unhandledEvents === 0
            ? "Every reported event is shown."
            : `${state().unhandledEvents} event(s) are not displayed by this client yet.`}
        </p>
      </Show>
    </Show>
  )
}

function BottomNav(props: { readonly view: RemoteView }): JSX.Element {
  const items: readonly { readonly view: RemoteView; readonly label: string; readonly icon: IconName }[] = [
    { view: "/remote", label: "Chat", icon: "chat" },
    { view: "/remote/activity", label: "Activity", icon: "activity" },
    { view: "/remote/sessions", label: "Sessions", icon: "sessions" },
    { view: "/remote/settings", label: "More", icon: "settings" },
  ]
  return (
    <nav class="bottom-nav" aria-label="Workspace">
      <For each={items}>
        {(item) => (
          <Link
            href={item.view}
            class={`bottom-nav__item${props.view === item.view ? " bottom-nav__item--active" : ""}`}
            ariaLabel={item.label}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </Link>
        )}
      </For>
    </nav>
  )
}

function sessionStatus(
  session: SessionInfoView,
  active: SessionView | undefined,
): RemoteSessionStatus {
  if (session.archived) return "archived"
  if (session.running === true) return "running"
  if (active !== undefined && active.status === "running") return "running"
  return "idle"
}

function advertisedCount(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`
}

function requestCount(count: number): string {
  return `${count} ${count === 1 ? "request" : "requests"}`
}
