import { isSessionID } from "@ycoding-ai/remote"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type JSX } from "solid-js"
import { Link, useRouter } from "../../router/router"
import { Chip } from "../../ui/chip"
import { Icon, type IconName } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { BrandMark, ThemeToggle } from "../../ui/site"
import { CustomSelect } from "../../ui/custom-select"
import { useRemote } from "../context"
import { SIGN_IN_PROVIDERS } from "../http"
import {
  modelLabel,
  type ActivityItem,
  type PendingRequestView,
  type RemoteMessageView,
  type SessionView,
} from "../projection"
import type { NotificationCategory } from "../preferences"
import type { SessionInfoView } from "../store"
import type { RemoteTransportStatus } from "../transport"
import {
  accountReadState,
  cachedSessionsView,
  connectionBanner,
  deviceAvailabilityView,
  devicePickerNote,
  remoteEntryView,
  sessionAvailabilityView,
  sessionProjectLabel,
  sessionStateChips,
  summarizeConnection,
  workspaceLabels,
  type ConnectionTone,
  type DeviceAvailabilityView,
  type RemoteConnectionState,
  type RemoteSessionStatus,
  type RemoteSessionSummary,
  type SessionChip,
} from "../view-model"
import { officeInputFromRemote } from "../office/adapter"
import { projectOffice } from "../office/model"
import { OfficeWorkspace } from "../office/OfficeWorkspace"
import { createOfficeSettings, type OfficeSettingsStore, type WorkspacePresentation } from "../office/storage"
import { Composer } from "./composer"
import { NewSessionButton, NewSessionComposer } from "./new-session"
import { UsagePage } from "./usage"
import {
  AccountSettings,
  AppearanceSettings,
  AutonomySettings,
  DeviceSettings,
  NotificationSettings,
  OfficeSettings,
  moveRadio,
} from "./settings"
import { ActivityRow, MessageRow, RequestCard } from "./conversation"
import { SessionStatusBar } from "./status-bar"

const views = ["/remote", "/remote/sessions", "/remote/activity", "/remote/usage", "/remote/settings"] as const

const newSessionHash = "new-session"
const sessionHashPrefix = "session="

export type RemoteView = (typeof views)[number]

const settingsSupport = "Account, devices, appearance, office view, autonomy, and notifications for this workspace."

export function RemoteShell(props: { readonly path: string }): JSX.Element {
  const remote = useRemote()
  const router = useRouter()
  const [navOpen, setNavOpen] = createSignal(false)
  const [railCollapsed, setRailCollapsed] = createSignal(false)
  const [activityOpen, setActivityOpen] = createSignal(false)
  const tabletQuery = window.matchMedia("(min-width: 768px) and (max-width: 1023px)")
  const [tabletLayout, setTabletLayout] = createSignal(tabletQuery.matches)
  const updateTabletLayout = (event: MediaQueryListEvent) => setTabletLayout(event.matches)
  tabletQuery.addEventListener("change", updateTabletLayout)
  onCleanup(() => tabletQuery.removeEventListener("change", updateTabletLayout))

  const office = createOfficeSettings()
  const state = () => remote.state()
  const view: RemoteView = views.find((entry) => entry === props.path) ?? "/remote"
  const officeShown = () => view === "/remote" && office.presentation() === "office"
  const activeSession = () => state().selectedSessionInfo ?? state().sessions.find((session) => session.id === state().activeSessionID)
  const selected = () => activeSession() !== undefined
  const composition = () => remoteSurfaceComposition(view, selected())
  const viewClass = view === "/remote" ? "conversation" : view.slice("/remote/".length)
  const entry = () => remoteEntryView(accountReadState({ connection: state().connection, owner: state().owner }))
  const tabletRailToggle = () => tabletLayout() && composition().showSessionRail
  const navExpanded = () => tabletRailToggle() ? !railCollapsed() : navOpen()
  const navLabel = () => tabletRailToggle() ? railCollapsed() ? "Show sessions sidebar" : "Hide sessions sidebar" : "Open sessions"
  const canCreateSession = () => state().connection.kind === "connected" && state().transport.kind === "open"
  const openSessionsNavigation = () => {
    if (tabletRailToggle()) {
      setRailCollapsed((collapsed) => !collapsed)
      return
    }
    setNavOpen(true)
  }
  const newSessionOpen = () => view === "/remote" && router.hash() === newSessionHash
  const openNewSession = () => {
    if (!canCreateSession()) return
    setNavOpen(false)
    router.navigate(`/remote#${newSessionHash}`)
  }
  const closeNewSession = () => router.navigate("/remote", { replace: true })
  const openSession = (sessionID: string) => {
    setNavOpen(false)
    void remote.store.selectSession(sessionID)
    router.navigate("/remote", { replace: view === "/remote" && router.hash().length > 0 })
  }
  const requestedSession = () => {
    const hash = router.hash()
    const sessionID = hash.startsWith(sessionHashPrefix) ? hash.slice(sessionHashPrefix.length) : undefined
    return view === "/remote" && sessionID !== undefined && isSessionID(sessionID) ? sessionID : undefined
  }
  createEffect(() => {
    const sessionID = requestedSession()
    if (sessionID === undefined || state().transport.kind !== "open" || state().connection.kind !== "connected") return
    untrack(() => openSession(sessionID))
  })
  const openFromAlert = (sessionID: unknown) => {
    if (typeof sessionID === "string" && isSessionID(sessionID)) router.navigate(`/remote#${sessionHashPrefix}${sessionID}`)
  }
  const alertEvent = (event: Event) => openFromAlert(event instanceof CustomEvent ? Reflect.get(Object(event.detail), "sessionID") : undefined)
  const workerMessage = (event: MessageEvent) => {
    if (Reflect.get(Object(event.data), "type") === "ycoding:open-session") openFromAlert(Reflect.get(Object(event.data), "sessionID"))
  }
  window.addEventListener("ycoding:open-session", alertEvent)
  navigator.serviceWorker?.addEventListener("message", workerMessage)
  onCleanup(() => {
    window.removeEventListener("ycoding:open-session", alertEvent)
    navigator.serviceWorker?.removeEventListener("message", workerMessage)
  })

  return (
    <Show when={entry() === "workspace"} fallback={<SignInScreen />}>
      <div class={`app app--${viewClass}${selected() ? " app--selected" : view === "/remote" ? " app--empty" : ""}${railCollapsed() ? " app--rail-collapsed" : ""}${officeShown() ? " app--office" : ""}`}>
        <a class="skip-link" href="#remote-main">Skip to content</a>
        <RemoteHeader
          navExpanded={navExpanded()}
          navLabel={navLabel()}
          navControls={tabletRailToggle() ? "session-rail" : undefined}
          activityOpen={activityOpen()}
          onOpenNav={openSessionsNavigation}
          onOpenActivity={() => setActivityOpen(true)}
          onOpenSession={openSession}
          view={view}
        />

        <ConnectionStrip />

        <div class="workspace">
          <Show when={composition().showSessionRail}>
            <aside id="session-rail" class="workspace__rail" aria-label="Sessions">
              <SessionPanel canCreateSession={canCreateSession()} onNewSession={openNewSession} />
            </aside>
          </Show>

          <main id="remote-main" tabindex="-1" class="workspace__main">
            <div class="workspace__scroll">
              <Notices />
              <Show when={view === "/remote"}>
                <Show
                  when={newSessionOpen() && canCreateSession()}
                  fallback={
                    <>
                      <Show when={selected()}>
                        <PresentationSwitch
                          value={office.presentation()}
                          attention={(state().view?.requests.length ?? 0) > 0}
                          onChange={office.present}
                        />
                      </Show>
                      <Show
                        when={officeShown() && selected()}
                        fallback={
                          <ConversationView
                            title={activeSession()?.title ?? noSessionTitle}
                            canCreateSession={canCreateSession()}
                            onNewSession={openNewSession}
                            onCreated={openSession}
                          />
                        }
                      >
                        <OfficePresentation office={office} />
                      </Show>
                    </>
                  }
                >
                  <NewSessionComposer onClose={closeNewSession} onCreated={openSession} />
                </Show>
              </Show>
              <Show when={view === "/remote/sessions"}>
                <SessionsPage
                  canCreateSession={canCreateSession()}
                  onNewSession={openNewSession}
                  onSelectSession={openSession}
                />
              </Show>
              <Show when={view === "/remote/activity"}>
                <ActivityPage />
              </Show>
              <Show when={view === "/remote/usage"}>
                <UsagePage />
              </Show>
              <Show when={view === "/remote/settings"}>
                <SettingsPage office={office} />
              </Show>
            </div>
            <Show when={composition().showComposer && !officeShown() && !newSessionOpen()}>
              <SessionStatusBar />
              <Composer
                sessionID={state().activeSessionID}
                running={state().view?.status === "running"}
                canSend={
                  state().transport.kind === "open" &&
                  state().connection.kind !== "offline" &&
                  state().activeSessionID !== undefined
                }
              />
            </Show>
          </main>

        </div>

        <BottomNav view={view} />

        <Show when={navOpen()}>
          <Modal class="overlay--slideover" label="Sessions" onClose={() => setNavOpen(false)}>
            <SessionPanel
              canCreateSession={canCreateSession()}
              onNewSession={openNewSession}
              onSelectSession={openSession}
              onNavigate={() => setNavOpen(false)}
            />
          </Modal>
        </Show>

        <Show when={activityOpen()}>
          <Modal class="overlay--slideover" label="Activity" onClose={() => setActivityOpen(false)}>
            <ActivityPanel onNavigate={() => setActivityOpen(false)} />
          </Modal>
        </Show>
      </div>
    </Show>
  )
}

/**
 * A signed-out browser sees one task: choose an OAuth provider. The workspace chrome is
 * absent because nothing in it can load before the account is known.
 */
function SignInScreen(): JSX.Element {
  const remote = useRemote()
  return (
    <main id="remote-main" class="sign-in">
      <div class="sign-in__panel">
        <div class="sign-in__top">
          <Link href="/" class="brand" title="YCoding home">
            <BrandMark compact />
          </Link>
          <ThemeToggle />
        </div>
        <div class="sign-in__head">
          <h1 class="sign-in__title">Sign in to your workspace</h1>
          <p class="sign-in__lede">
            Continue the sessions running on your machines. The workspace reaches only the machines enrolled to
            the account you sign in with.
          </p>
        </div>
        <Show when={remote.authError}>
          {(error) => (
            <p class="sign-in__error" role="alert">
              <Icon name="alert" size={16} />
              <span>{error()}</span>
            </p>
          )}
        </Show>
        <div class="sign-in__providers">
          <For each={SIGN_IN_PROVIDERS}>
            {(provider, index) => (
              <button
                type="button"
                class={`button ${index() === 0 ? "button--primary" : "button--secondary"} sign-in__provider`}
                onClick={() => remote.signIn(provider.id)}
              >
                {provider.label}
              </button>
            )}
          </For>
        </div>
        <p class="sign-in__note">
          <Link href="/docs/usage/remote" class="text-link">How remote access works</Link>
        </p>
      </div>
    </main>
  )
}

/** The rail and composer belong only to an active conversation, never every remote screen. */
export function remoteSurfaceComposition(path: RemoteView, hasSession: boolean) {
  const selectedConversation = path === "/remote" && hasSession
  return { showSessionRail: selectedConversation, showComposer: selectedConversation }
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
    ...(session.pinnedAt === undefined ? {} : { pinned: true }),
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

export function sessionNeedsAttention(session: SessionInfoView, view: SessionView | undefined): boolean {
  if (session.attention === true) return true
  return view !== undefined && view.id === session.id && view.requests.length > 0
}

/**
 * The chips one session row and the selected session's header row show: the status the
 * device reported, plus the fact that the loaded view is holding an unanswered approval.
 */
export function sessionChips(session: SessionInfoView, view: SessionView | undefined): readonly SessionChip[] {
  const chips = sessionStateChips(summarizeSession(session, view))
  if (awaitsApproval(view, session.id)) return [{ label: "Waiting for approval", tone: "attention" }, ...chips]
  if (sessionNeedsAttention(session, view)) return [{ label: "Waiting for you", tone: "attention" }, ...chips]
  return chips
}

/**
 * The client-side session filter. It reads the sessions the workspace already holds and
 * issues no request, so an empty result means the filter matched nothing rather than that
 * the device advertises nothing. Pinned sessions come first, in pin order.
 */
export type SessionFilter = "all" | "running" | "idle"

export function filterSessions(
  sessions: readonly SessionInfoView[],
  query: string,
  filter: SessionFilter = "all",
): readonly SessionInfoView[] {
  const needle = query.trim().toLowerCase()
  const pinned = sessions
    .filter((session) => session.pinnedAt !== undefined)
    .toSorted((left, right) => left.pinnedAt! - right.pinnedAt!)
  return [...pinned, ...sessions.filter((session) => session.pinnedAt === undefined)].filter((session) => {
    if (filter === "running" && session.running !== true) return false
    if (filter === "idle" && (session.running === true || session.archived)) return false
    if (needle.length === 0) return true
    return [session.title, session.agent ?? "", session.modelLabel ?? ""].some((value) => value.toLowerCase().includes(needle))
  })
}

export type QueueRowView = {
  readonly id: string
  readonly icon: IconName
  readonly kind: string
  readonly title: string
  readonly detail: string
  /** A hard review needs a human answer at every autonomy level and is drawn apart. */
  readonly hard: boolean
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
    return { id: request.id, icon: "shield", kind: "Permission", title: target, detail: "waits for a decision", hard: false }
  }
  if (request.kind === "guardrail") {
    return {
      id: request.id,
      icon: "alert",
      kind: request.hardReview ? "Guardrail review (human decision required)" : "Guardrail review",
      title: request.action,
      detail: request.reason,
      hard: request.hardReview,
    }
  }
  return {
    id: request.id,
    icon: "chat",
    kind: request.form.metadata?.kind === "question" ? "Question" : "Form",
    title: request.form.title,
    detail: "waits for your answer",
    hard: false,
  }
}

const noSessionTitle = "No session selected"

function RemoteHeader(props: {
  readonly navExpanded: boolean
  readonly navLabel: string
  readonly navControls?: string
  readonly activityOpen: boolean
  readonly onOpenNav: () => void
  readonly onOpenActivity: () => void
  readonly onOpenSession: (sessionID: string) => void
  readonly view: RemoteView
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const connection = () => summarizeConnection(state().connection)
  const devices = useDeviceAvailability()
  const selectableDevices = () => state().devices.filter((device) => device.status === "active" && device.online)
  const pickerNote = () => devicePickerNote(state().devices)
  const attention = useNavigationAttention()
  return (
    <header class="app-header">
      <div class="app-header__inner">
        <button
          type="button"
          class="button button--ghost button--icon app-header__menu"
          aria-label={props.navLabel}
          aria-expanded={props.navExpanded}
          aria-controls={props.navControls}
          onClick={props.onOpenNav}
        >
          <Icon name="menu" />
        </button>
        <Link href="/" class="brand" title="YCoding home">
          <img class="brand__mark" src="/brand/ycoding-mark.svg" alt="YCoding" width={28} height={28} />
        </Link>
        <nav class="remote-nav" aria-label="Remote workspace">
          <Link
            href="/remote/sessions"
            class={`remote-nav__link${props.view === "/remote/sessions" ? " remote-nav__link--active" : ""}`}
            ariaCurrent={props.view === "/remote/sessions" ? "page" : undefined}
            ariaLabel={attention().sessions ? "Sessions, a session is waiting for your decision" : undefined}
          >
            Sessions
            <AttentionMark show={attention().sessions} />
          </Link>
          <Link
            href="/remote"
            class={`remote-nav__link${props.view === "/remote" ? " remote-nav__link--active" : ""}`}
            ariaCurrent={props.view === "/remote" ? "page" : undefined}
            ariaLabel={attention().conversation ? "Conversation, waiting for your decision" : undefined}
          >
            Conversation
            <AttentionMark show={attention().conversation} />
          </Link>
          <Link href="/remote/activity" class={`remote-nav__link${props.view === "/remote/activity" ? " remote-nav__link--active" : ""}`} ariaCurrent={props.view === "/remote/activity" ? "page" : undefined}>Activity</Link>
          <Link href="/remote/usage" class={`remote-nav__link${props.view === "/remote/usage" ? " remote-nav__link--active" : ""}`} ariaCurrent={props.view === "/remote/usage" ? "page" : undefined}>Usage</Link>
          <Link href="/remote/settings" class={`remote-nav__link${props.view === "/remote/settings" ? " remote-nav__link--active" : ""}`} ariaCurrent={props.view === "/remote/settings" ? "page" : undefined}>Settings</Link>
        </nav>
        <div class="remote-device">
          <CustomSelect
            class="remote-device__select"
            surfaceClass="remote-device__surface"
            label="Machine"
            sheetTitle="Select Active Machine"
            sheetSubtitle="Online machines you can connect to"
            value={state().activeDeviceID}
            placeholder={devices().placeholder}
            disabled={!devices().selectable}
            options={selectableDevices().map((device) => ({ value: device.id, label: device.name, badge: "Online" }))}
            onChange={(deviceID) => remote.store.connect(deviceID)}
            footer={pickerNote() === undefined ? undefined : <Link href="/remote/settings">{pickerNote()}</Link>}
          />
          <span class="remote-connection">
            <span class={`status-dot status-dot--${connection().tone}`} aria-hidden="true" />
            <span class="remote-connection-label">{connection().label}</span>
          </span>
        </div>
        <div class="app-header__end">
          <NotificationCenter onOpenSession={props.onOpenSession} />
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
    </header>
  )
}

function useNavigationAttention() {
  const remote = useRemote()
  return () => ({
    conversation: (remote.state().view?.requests.length ?? 0) > 0,
    sessions: (remote.state().sessionStatus?.attention.size ?? 0) > 0,
  })
}

function AttentionMark(props: { readonly show: boolean }): JSX.Element {
  return (
    <Show when={props.show}>
      <span class="attention-dot" aria-hidden="true" />
    </Show>
  )
}

const notificationKinds: Record<NotificationCategory, { readonly icon: IconName; readonly label: string }> = {
  "agent-completed": { icon: "check", label: "Stopped running" },
  "approval-requested": { icon: "shield", label: "Waiting for your decision" },
  "guardrail-blocked": { icon: "alert", label: "Guardrail review" },
  error: { icon: "alert", label: "Step failed" },
  "device-disconnected": { icon: "devices", label: "Machine disconnected" },
}

export function notificationAge(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return new Date(at).toLocaleDateString()
}

function NotificationCenter(props: { readonly onOpenSession: (sessionID: string) => void }): JSX.Element {
  const remote = useRemote()
  const [open, setOpen] = createSignal(false)
  const notifications = () => remote.state().notifications
  const unread = () => notifications().filter((notification) => !notification.read).length
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) trigger?.focus()
  }
  const toggle = () => {
    if (open()) return close(false)
    setOpen(true)
    remote.store.markNotificationsRead()
  }
  const pointer = (event: PointerEvent) => {
    if (open() && event.target instanceof Node && !root?.contains(event.target)) close(false)
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open()) close(true)
  }
  document.addEventListener("pointerdown", pointer)
  document.addEventListener("keydown", key)
  onCleanup(() => {
    document.removeEventListener("pointerdown", pointer)
    document.removeEventListener("keydown", key)
  })
  return (
    <div class="notification-center" ref={root}>
      <button
        ref={trigger}
        type="button"
        class={`button button--ghost button--icon notification-center__trigger${unread() > 0 ? " notification-center__trigger--unread" : ""}`}
        aria-label={unread() > 0 ? `Notifications, ${unread()} unread` : "Notifications"}
        aria-expanded={open()}
        aria-controls="notification-panel"
        onClick={toggle}
      >
        <Icon name="bell" />
        <Show when={unread() > 0}>
          <span class="notification-center__badge" aria-hidden="true">{unread() > 9 ? "9+" : unread()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <section id="notification-panel" class="notification-panel" aria-label="Notifications">
          <header class="notification-panel__head">
            <h2 class="notification-panel__title">Notifications</h2>
            <Show when={notifications().length > 0}>
              <button type="button" class="button button--ghost button--small" onClick={() => remote.store.clearNotifications()}>
                Clear all
              </button>
            </Show>
          </header>
          <Show
            when={notifications().length > 0}
            fallback={<p class="notification-panel__empty">Approvals, questions, finished work, and failures appear here.</p>}
          >
            <ul class="notification-panel__list">
              <For each={notifications()}>
                {(notification) => (
                  <li class={`notification-item notification-item--${notification.category}`}>
                    <button
                      type="button"
                      class="notification-item__open"
                      disabled={notification.sessionID === undefined}
                      onClick={() => {
                        const sessionID = notification.sessionID
                        if (sessionID === undefined) return
                        close(false)
                        props.onOpenSession(sessionID)
                      }}
                    >
                      <span class="notification-item__icon" aria-hidden="true">
                        <Icon name={notificationKinds[notification.category].icon} size={16} />
                      </span>
                      <span class="notification-item__body">
                        <span class="notification-item__title">{notificationKinds[notification.category].label}</span>
                        <span class="notification-item__detail">{notification.sessionTitle ?? notification.body}</span>
                      </span>
                      <time class="notification-item__time" datetime={new Date(notification.at).toISOString()}>
                        {notificationAge(notification.at, Date.now())}
                      </time>
                    </button>
                    <button
                      type="button"
                      class="button button--ghost button--icon notification-item__dismiss"
                      aria-label={`Dismiss ${notificationKinds[notification.category].label}`}
                      onClick={() => remote.store.dismissNotification(notification.id)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>
    </div>
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
  const unsettled = () => state().mutations.filter((mutation) =>
    mutation.state === "unknown" && mutation.sessionID === state().activeSessionID).length
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
    const count = `${sessions} ${sessions === 1 ? "session" : "sessions"} loaded`
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

function SessionPanel(props: {
  readonly canCreateSession: boolean
  readonly onNewSession: () => void
  readonly onSelectSession?: (sessionID: string) => void
  readonly onNavigate?: () => void
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  let feed: HTMLDivElement | undefined
  let detachFeed = () => {}
  onMount(() => { if (feed) detachFeed = attachSessionFeed(feed, remote.store) })
  onCleanup(() => detachFeed())
  const deviceName = () => state().devices.find((device) => device.id === state().activeDeviceID)?.name
  const cached = () => cachedSessionsView(state().connection, state().sessions.length)
  const advertised = () => {
    const total = state().sessions.length
    const name = deviceName()
    if (total === 0 || name === undefined) return undefined
    return `${total} ${total === 1 ? "session" : "sessions"} loaded from ${name}.`
  }
  return (
    <div class="pane" ref={feed}>
      <div class="pane__head pane__head--sessions">
        <p class="pane__title">Sessions</p>
        <NewSessionButton disabled={!props.canCreateSession} onClick={props.onNewSession} />
      </div>
      <Show
        when={
          state().activeDeviceID !== undefined &&
          (state().connection.kind === "connected" ||
            state().connection.kind === "connecting" ||
            state().connection.kind === "loading")
        }
        fallback={
          <>
            <DeviceEmptyState onNavigate={props.onNavigate} />
            <Show when={cached()}>
              {(view) => (
                <>
                  <p class="panel__note">{view().note}</p>
                  <div class="session-list">
                    <For each={state().sessions}>{(session) => <SessionRow session={session} readOnly />}</For>
                  </div>
                </>
              )}
            </Show>
          </>
        }
      >
        <WorkspaceSelector />
        <Show when={state().sessionGroups.length > 0 || state().sessionListStatus === "loading"} fallback={<NoSessionsState />}>
          <label class="field">
            <span class="visually-hidden">Filter sessions</span>
            <input
              class="input"
              type="search"
              placeholder="Filter sessions"
              value={state().sessionQuery}
              disabled={state().transport.kind !== "open" || cached() !== undefined}
              onInput={(event) => remote.store.searchSessions(event.currentTarget.value)}
            />
          </label>
          <Show when={state().sessions.length > 0} fallback={<NoSessionsState />}>
            <div class="session-list">
              <For each={state().sessions}>
                {(session) => (
                  <SessionRow
                    session={session}
                    onSelectSession={props.onSelectSession}
                    onNavigate={props.onNavigate}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={advertised()}>{(note) => <p class="panel__note">{note()}</p>}</Show>
          <Show when={state().sessionPageLoading}><p role="status">Loading more sessions…</p></Show>
        </Show>
      </Show>
    </div>
  )
}

function SessionRow(props: {
  readonly session: SessionInfoView
  readonly readOnly?: boolean
  readonly onSelectSession?: (sessionID: string) => void
  readonly onNavigate?: () => void
}): JSX.Element {
  const remote = useRemote()
  const active = () => remote.state().activeSessionID === props.session.id
  const chips = () => sessionChips(props.session, remote.state().view)
  return (
    <button
      type="button"
      class={`session-row${active() ? " session-row--active" : ""}`}
      aria-pressed={active()}
      disabled={props.readOnly}
      onClick={() => {
        if (props.onSelectSession) props.onSelectSession(props.session.id)
        else void remote.store.selectSession(props.session.id)
        props.onNavigate?.()
      }}
    >
      <span class="session-row__body">
        <span class="session-row__title">
          <Show when={props.session.running === true}>
            <span class="live-dot" aria-hidden="true" />
          </Show>
          <span class="session-row__name">{props.session.title}</span>
        </span>
        <span class="session-row__meta">
          <span title={props.session.directory}>{sessionProjectLabel(props.session)}</span>
          <span class="session-row__status">
            <For each={chips().slice(0, 1)}>{(chip) => <Chip label={chip.label} tone={chip.tone} />}</For>
          </span>
        </span>
      </span>
      <Show when={sessionNeedsAttention(props.session, remote.state().view)}>
        <span class="attention-dot session-row__attention" aria-hidden="true" />
      </Show>
    </button>
  )
}

function SessionSummaryRow(props: {
  readonly session: SessionInfoView
  readonly readOnly?: boolean
  readonly onSelectSession: (sessionID: string) => void
}): JSX.Element {
  const remote = useRemote()
  const summary = () => summarizeSession(props.session, remote.state().view)
  const chips = () => sessionChips(props.session, remote.state().view)
  return (
    <div class="sessions-table__row" role="row">
      <span class="sessions-table__title" role="cell">
        <button
          type="button"
          class="sessions-table__select"
          disabled={props.readOnly}
          onClick={() => props.onSelectSession(props.session.id)}
        >
          <Show when={props.session.running === true}>
            <span class="live-dot" aria-hidden="true" />
          </Show>
          <span class="sessions-table__name">{props.session.title}</span>
          <AttentionMark show={sessionNeedsAttention(props.session, remote.state().view)} />
        </button>
      </span>
      <span class="sessions-table__status" role="cell">
        <For each={chips().slice(0, 1)}>{(chip) => <Chip label={chip.label} tone={chip.tone} />}</For>
        <Show when={chips().length === 0}><Chip label="Idle" tone="neutral" /></Show>
      </span>
      <span class="sessions-table__updated" role="cell">
        {summary().updatedAt === undefined ? "Not reported" : new Date(props.session.updatedAt).toLocaleString()}
      </span>
    </div>
  )
}

/**
 * The device surfaces share one honest empty state: a browser whose account read has not
 * settled is never reported as signed out, and a signed-in account with no machine is
 * never reported as having no machines at all.
 */
function DeviceEmptyState(props: { readonly onNavigate?: () => void }): JSX.Element {
  const devices = useDeviceAvailability()
  return (
    <div class="empty">
      <p class="empty__title">{devices().title}</p>
      <p>{devices().body}</p>
      <DeviceActions view={devices} onNavigate={props.onNavigate} />
    </div>
  )
}

/** What the reader can do about the device state: run the connect command or open settings. */
function DeviceActions(props: { readonly view: () => DeviceAvailabilityView; readonly onNavigate?: () => void }): JSX.Element {
  return (
    <>
      <Show when={props.view().command}>
        {(command) => (
          <figure class="code-block">
            <figcaption class="code-block__head">
              <span class="code-block__label">On the machine running YCoding</span>
              <button
                type="button"
                class="button button--ghost button--small code-block__copy"
                onClick={() => void navigator.clipboard?.writeText(command())}
              >
                <Icon name="copy" size={16} />
                Copy command
              </button>
            </figcaption>
            <pre tabindex="0">
              <code>{command()}</code>
            </pre>
          </figure>
        )}
      </Show>
      <Show when={props.view().showSettings}>
        <Link href="/remote/settings" class="button button--secondary button--small" onClick={props.onNavigate}>
          Open settings
        </Link>
      </Show>
    </>
  )
}

function useDeviceAvailability() {
  const remote = useRemote()
  return () =>
    deviceAvailabilityView(
      accountReadState({ connection: remote.state().connection, owner: remote.state().owner }),
      remote.state().devices.length,
      {
        devices: remote.state().devices,
        activeDeviceID: remote.state().activeDeviceID,
        sessionCount: remote.state().sessions.length,
        unreachable: remote.state().connection.kind === "offline",
      },
    )
}

function NoSessionsState(): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const availability = () => sessionAvailabilityView(state().connection, state().sessions.length, state().sessionListStatus)
  return (
    <div class="empty">
      <p class="empty__title">{availability()?.title ?? (state().sessionQuery || state().sessionFilter !== "all" ? "No matching sessions" : "No sessions")}</p>
      <p>{availability()?.body ?? (state().sessionQuery || state().sessionFilter !== "all" ? "No matching sessions in this workspace." : "Start YCoding in your project folder on this machine.")}</p>
      <Show when={availability()?.note}>{(note) => <p class="panel__note">{note()}</p>}</Show>
    </div>
  )
}

function ConversationView(props: {
  readonly title: string
  readonly canCreateSession: boolean
  readonly onNewSession: () => void
  readonly onCreated: (sessionID: string) => void
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const view = () => state().view
  const requests = () => view()?.requests ?? []
  const messages = () => view()?.messages ?? []
  const selectedSession = () => state().selectedSessionInfo ?? state().sessions.find((session) => session.id === state().activeSessionID)
  const devices = useDeviceAvailability()
  // Without a reachable machine the device state is the page's one explanation.
  const blocked = () => state().activeDeviceID === undefined || state().connection.kind === "offline"
  const availability = () => blocked()
    ? devices()
    : sessionAvailabilityView(state().connection, state().sessions.length, state().sessionListStatus)
  return (
    <Show
      when={state().activeSessionID !== undefined}
      fallback={
        <Show
          when={props.canCreateSession && !blocked()}
          fallback={
            <>
              <div class="page-head">
                <div>
                  <h1 class="page-head__title">{availability()?.title ?? noSessionTitle}</h1>
                  <p class="page-head__support">
                    {availability()?.body ?? "Select a session to view its conversation."}
                  </p>
                </div>
              </div>
              <div class="pane">
                <Show when={blocked()}>
                  <DeviceActions view={devices} />
                </Show>
                <NewSessionButton disabled={!props.canCreateSession} onClick={props.onNewSession} />
                <Link href="/docs/usage/remote" class="button button--secondary button--small">
                  How remote access works
                </Link>
              </div>
            </>
          }
        >
          <NewSessionComposer onCreated={props.onCreated} />
        </Show>
      }
    >
      <div class="conversation-breadcrumb" aria-label="Selected workspace and session">
        <span title={selectedSession()?.directory}>{sessionProjectLabel(selectedSession() ?? {})}</span>
        <span aria-hidden="true">/</span>
        <strong>{props.title}</strong>
        <Show when={selectedSession()}>
          {(session) => (
            <span class="conversation-breadcrumb__status">
              <For each={sessionChips(session(), view()).slice(0, 1)}>
                {(chip) => <Chip label={chip.label} tone={chip.tone} />}
              </For>
            </span>
          )}
        </Show>
      </div>
      <div class="pane conversation-pane">
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
        <Show when={requests().length > 0}>
          <div id="pending-requests" class="requests" tabindex="-1" aria-label="Pending requests">
            <RequestCards requests={requests} activeSessionID={state().activeSessionID} />
          </div>
        </Show>
      </div>
    </Show>
  )
}

const presentations: readonly { readonly id: WorkspacePresentation; readonly label: string }[] = [
  { id: "conversation", label: "Conversation" },
  { id: "office", label: "Office" },
]

function PresentationSwitch(props: {
  readonly value: WorkspacePresentation
  readonly attention: boolean
  readonly onChange: (value: WorkspacePresentation) => void
}): JSX.Element {
  const flagged = (id: WorkspacePresentation) => props.attention && id === "conversation"
  return (
    <div class="presentation-switch filters" role="radiogroup" aria-label="Workspace view">
      <For each={presentations}>
        {(option, index) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === option.id}
            tabIndex={props.value === option.id ? 0 : -1}
            class={`filters__option${props.value === option.id ? " filters__option--active" : ""}${flagged(option.id) ? " filters__option--attention" : ""}`}
            aria-label={flagged(option.id) ? `${option.label}, waiting for your decision` : undefined}
            onClick={() => props.onChange(option.id)}
            onKeyDown={(event) => moveRadio(event, index(), presentations.length, (next) => {
              const selected = presentations[next]
              if (selected) props.onChange(selected.id)
            })}
          >
            {option.label}
            <AttentionMark show={flagged(option.id)} />
          </button>
        )}
      </For>
    </div>
  )
}

function OfficePresentation(props: { readonly office: OfficeSettingsStore }): JSX.Element {
  const remote = useRemote()
  onMount(() => remote.store.watchTeam(true))
  onCleanup(() => remote.store.watchTeam(false))
  const snapshot = createMemo(() => projectOffice(officeInputFromRemote(remote.state()), props.office.preferences()))
  const requestCount = () => {
    const state = remote.state()
    return state.view?.id === state.activeSessionID ? state.view?.requests.length ?? 0 : 0
  }
  const showRequests = () => {
    props.office.present("conversation")
    requestAnimationFrame(() => {
      const target = document.getElementById("pending-requests")
      target?.scrollIntoView({ block: "start" })
      target?.focus()
    })
  }
  return (
    <OfficeWorkspace
      snapshot={snapshot()}
      preferences={props.office.preferences()}
      renderKey={`${props.office.preferences().quality}:${props.office.generation()}`}
      requestCount={requestCount()}
      onSelectSession={(sessionID) => void remote.store.selectSession(sessionID)}
      onNormalView={() => props.office.present("conversation")}
      onShowRequests={showRequests}
      onLoadMoreTeam={() => void remote.store.loadMoreTeam()}
    />
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

function SessionsPage(props: {
  readonly canCreateSession: boolean
  readonly onNewSession: () => void
  readonly onSelectSession: (sessionID: string) => void
}): JSX.Element {
  const remote = useRemote()
  let feed: HTMLDivElement | undefined
  let detachFeed = () => {}
  onMount(() => { if (feed) detachFeed = attachSessionFeed(feed, remote.store) })
  onCleanup(() => detachFeed())
  const sessions = () => remote.state().sessions
  const cached = () => cachedSessionsView(remote.state().connection, remote.state().sessions.length)
  const workspaceTitle = () => {
    const selected = remote.state().selectedWorkspaceID
    return selected === undefined ? "Sessions" : workspaceLabels(remote.state().sessionGroups).get(selected) ?? "Sessions"
  }
  return (
    <div class="sessions-page" ref={feed}>
      <h1 class="visually-hidden">Sessions</h1>
      <Show
        when={remote.state().sessionGroups.length > 0 || remote.state().sessionListStatus === "loading"}
        fallback={
          <div class="pane sessions-page__empty">
            <div class="sessions-page__toolbar">
              <NewSessionButton disabled={!props.canCreateSession} onClick={props.onNewSession} />
            </div>
            <Show when={remote.state().activeDeviceID !== undefined} fallback={<DeviceEmptyState />}>
              <NoSessionsState />
            </Show>
          </div>
        }
      >
        <div class="sessions-page__layout">
          <WorkspaceNav />
          <section class="pane sessions-page__content" aria-labelledby="sessions-page-title">
            <div class="sessions-page__toolbar">
              <h2 id="sessions-page-title" class="sessions-page__title">{workspaceTitle()}</h2>
              <NewSessionButton disabled={!props.canCreateSession} onClick={props.onNewSession} />
            </div>
            <div class="sessions-page__workspace-select">
              <WorkspaceSelector />
            </div>
            <Show when={cached()}>{(view) => <p class="panel__note">{view().note}</p>}</Show>
            <div class="filter-bar">
              <label class="field" style={{ flex: "1" }}>
                <span class="visually-hidden">Filter sessions</span>
                <input
                  class="input"
                  type="search"
                  placeholder="Search sessions…"
                  value={remote.state().sessionQuery}
                  disabled={remote.state().transport.kind !== "open" || cached() !== undefined}
                  onInput={(event) => remote.store.searchSessions(event.currentTarget.value)}
                />
              </label>
              <span class="chip">{advertisedCount(sessions().length)} loaded</span>
            </div>
            <div class="session-filters" role="group" aria-label="Session status">
              <For each={["all", "running", "idle"] as const}>
                {(value) => (
                  <button
                    type="button"
                    class={`session-filters__option${remote.state().sessionFilter === value ? " session-filters__option--active" : ""}`}
                    aria-pressed={remote.state().sessionFilter === value}
                    disabled={remote.state().transport.kind !== "open" || cached() !== undefined}
                    onClick={() => remote.store.searchSessions(remote.state().sessionQuery, value)}
                  >
                    {value[0]?.toUpperCase()}{value.slice(1)}
                  </button>
                )}
              </For>
            </div>
            <Show when={sessions().length > 0} fallback={<NoSessionsState />}>
              <div class="sessions-results">
                <div class="sessions-table" role="table" aria-label="Sessions">
                  <div class="sessions-table__head" role="row">
                    <span role="columnheader">Title</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Updated</span>
                  </div>
                  <For each={sessions()}>
                    {(session) => (
                      <SessionSummaryRow
                        session={session}
                        readOnly={cached() !== undefined}
                        onSelectSession={props.onSelectSession}
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={remote.state().sessionPageLoading}><p role="status">Loading more sessions…</p></Show>
          </section>
        </div>
      </Show>
    </div>
  )
}

function WorkspaceSelector(): JSX.Element {
  const remote = useRemote()
  const labels = createMemo(() => workspaceLabels(remote.state().sessionGroups))
  return (
    <Show when={remote.state().sessionGroups.length > 0}>
      <div class="workspace-select">
        <span class="workspace-select__label">Workspace</span>
        <CustomSelect
          label="Workspace"
          sheetTitle="Select workspace"
          sheetSubtitle="Repositories with sessions on this machine"
          placeholder="Select a workspace"
          value={remote.state().selectedWorkspaceID}
          disabled={remote.state().transport.kind !== "open" || remote.state().connection.kind === "offline"}
          options={remote.state().sessionGroups.map((group) => ({ value: group.id, label: labels().get(group.id) ?? group.directory }))}
          onChange={(workspaceID) => remote.store.selectWorkspace(workspaceID)}
        />
      </div>
    </Show>
  )
}

function WorkspaceNav(): JSX.Element {
  const remote = useRemote()
  const labels = createMemo(() => workspaceLabels(remote.state().sessionGroups))
  const disabled = () => remote.state().transport.kind !== "open" || remote.state().connection.kind === "offline"
  return (
    <nav class="workspace-nav" aria-label="Workspaces">
      <p class="workspace-nav__title">Workspaces</p>
      <ul class="workspace-nav__list">
        <For each={remote.state().sessionGroups}>
          {(group) => (
            <li>
              <button
                type="button"
                class={`workspace-nav__item${remote.state().selectedWorkspaceID === group.id ? " workspace-nav__item--active" : ""}`}
                aria-current={remote.state().selectedWorkspaceID === group.id ? "true" : undefined}
                title={group.directory}
                disabled={disabled()}
                onClick={() => remote.store.selectWorkspace(group.id)}
              >
                <Icon name="folder" size={16} />
                <span class="workspace-nav__label">{labels().get(group.id)}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </nav>
  )
}

function attachSessionFeed(element: HTMLDivElement, store: ReturnType<typeof useRemote>["store"]) {
  const root = element.closest<HTMLElement>(".workspace__scroll, .workspace__rail") ??
    (document.scrollingElement instanceof HTMLElement ? document.scrollingElement : undefined)
  if (!root) return () => {}
  let direction = 0
  let gesture = false
  let lastTop = root.scrollTop
  let context = `${store.state().activeDeviceID}:${store.state().selectedWorkspaceID}:${store.state().sessionQuery}:${store.state().sessionFilter}`
  const unsubscribe = store.subscribe(() => {
    const next = `${store.state().activeDeviceID}:${store.state().selectedWorkspaceID}:${store.state().sessionQuery}:${store.state().sessionFilter}`
    if (next === context) return
    context = next
    gesture = false
    direction = 0
    lastTop = root.scrollTop
  })
  const check = () => {
    if (!gesture || direction === 0 || store.state().sessionPageLoading || store.state().sessionListStatus !== "ready") return
    if (direction > 0 && root.scrollHeight - root.scrollTop - root.clientHeight < 250 && store.state().sessionHasNext) {
      const before = store.state().sessions[0]?.id
      const removed = store.state().sessions.length >= 150
        ? [...element.querySelectorAll<HTMLElement>(".session-row, .sessions-table__row")].slice(0, 50).reduce((height, row) => height + row.offsetHeight, 0)
        : 0
      gesture = false
      direction = 0
      void store.nextSessionsPage().then(() => requestAnimationFrame(() => {
        if (removed > 0 && store.state().sessions[0]?.id !== before) root.scrollTop = Math.max(0, root.scrollTop - removed)
        lastTop = root.scrollTop
      }))
    }
    if (direction < 0 && root.scrollTop < 250 && store.state().sessionHasPrevious) {
      const before = store.state().sessions[0]?.id
      gesture = false
      direction = 0
      void store.previousSessionsPage().then(() => requestAnimationFrame(() => {
        if (store.state().sessions[0]?.id !== before) {
          const added = [...element.querySelectorAll<HTMLElement>(".session-row, .sessions-table__row")].slice(0, 50)
            .reduce((height, row) => height + row.offsetHeight, 0)
          root.scrollTop += added
        }
        lastTop = root.scrollTop
      }))
    }
  }
  const wheel = (event: WheelEvent) => { gesture = true; direction = Math.sign(event.deltaY); check() }
  let touchY = 0
  const touchStart = (event: TouchEvent) => { gesture = true; touchY = event.changedTouches[0]?.clientY ?? 0 }
  const touch = (event: TouchEvent) => { direction = Math.sign(touchY - (event.changedTouches[0]?.clientY ?? touchY)); check() }
  const pointer = () => { gesture = true }
  const key = (event: KeyboardEvent) => {
    if (!root.contains(document.activeElement) && document.activeElement !== document.body) return
    if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) direction = 1
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) direction = -1
    if (direction !== 0) gesture = true
  }
  const scroll = () => {
    if (gesture && root.scrollTop !== lastTop) direction = Math.sign(root.scrollTop - lastTop)
    lastTop = root.scrollTop
    check()
  }
  root.addEventListener("wheel", wheel, { passive: true })
  root.addEventListener("touchstart", touchStart, { passive: true })
  root.addEventListener("touchend", touch, { passive: true })
  root.addEventListener("pointerdown", pointer, { passive: true })
  document.addEventListener("keydown", key)
  root.addEventListener("scroll", scroll, { passive: true })
  return () => {
    unsubscribe()
    root.removeEventListener("wheel", wheel)
    root.removeEventListener("touchstart", touchStart)
    root.removeEventListener("touchend", touch)
    root.removeEventListener("pointerdown", pointer)
    document.removeEventListener("keydown", key)
    root.removeEventListener("scroll", scroll)
  }
}

function ActivityPage(): JSX.Element {
  const remote = useRemote()
  const requests = () => remote.state().view?.requests ?? []
  return (
    <div class="pane activity-page">
      <div class="activity-page__events">
        <div class="queue__head">
          <h1 class="page-head__title">Reported events</h1>
          <span class="panel__note">Chronological feed</span>
        </div>
        <ActivityList />
      </div>
      <div class="queue activity-page__decisions">
        <div class="queue__head">
          <h2 class="page-head__title">Pending decisions</h2>
          <Show when={requests().length > 0}>
            <span class="queue__count">{requestCount(requests().length)}</span>
          </Show>
        </div>
        <Show when={requests().length > 0} fallback={<p class="panel__note">Nothing is waiting for you.</p>}>
          <RequestCards requests={requests} activeSessionID={remote.state().activeSessionID} />
        </Show>
      </div>
    </div>
  )
}

function SettingsPage(props: { readonly office: OfficeSettingsStore }): JSX.Element {
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
          <OfficeSettings office={props.office} />
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
    <div class={`queue-row${row().hard ? " queue-row--hard" : ""}`}>
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
  const ids = createMemo(() => [...activity()].reverse().map((item) => item.id))
  const item = (id: string) => activity().find((entry) => entry.id === id)!
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
          <For each={ids()}>{(id) => <ActivityRow item={() => item(id)} fileChange={() => state().view?.fileChanges.find((change) => id === `file-${change.path}`)} />}</For>
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
  const attention = useNavigationAttention()
  const items: readonly { readonly view: RemoteView; readonly label: string; readonly icon: IconName }[] = [
    { view: "/remote/sessions", label: "Sessions", icon: "sessions" },
    { view: "/remote", label: "Conversation", icon: "chat" },
    { view: "/remote/activity", label: "Activity", icon: "activity" },
    { view: "/remote/usage", label: "Usage", icon: "usage" },
    { view: "/remote/settings", label: "Settings", icon: "settings" },
  ]
  const flagged = (view: RemoteView) =>
    (view === "/remote" && attention().conversation) || (view === "/remote/sessions" && attention().sessions)
  return (
    <nav class="bottom-nav" aria-label="Workspace">
      <For each={items}>
        {(item) => (
          <Link
            href={item.view}
            class={`bottom-nav__item${props.view === item.view ? " bottom-nav__item--active" : ""}`}
            ariaLabel={flagged(item.view) ? `${item.label}, waiting for your decision` : item.label}
            ariaCurrent={props.view === item.view ? "page" : undefined}
          >
            <span class="bottom-nav__icon">
              <Icon name={item.icon} size={20} />
              <Show when={flagged(item.view)}>
                <span class="attention-dot" aria-hidden="true" />
              </Show>
            </span>
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
