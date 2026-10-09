import { isSessionID, noticeSequence } from "@ycoding-ai/remote"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { createThrottler } from "@tanstack/solid-pacer"
import { useLocation, useNavigate } from "@tanstack/solid-router"
import { Link } from "../../ui/link"
import { browserStorage, readStored, writeStored } from "../../lib/storage"
import { Chip } from "../../ui/chip"
import { Icon, type IconName } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { CustomSelect } from "../../ui/custom-select"
import { BrandMark, ThemeToggle } from "../../ui/site"
import { isAlertDeviceID, readSessionSearch, sessionSearch } from "../alert"
import { useRemote } from "../context"
import { preloadKeepAwake, preloadUsage, preloadWorkspaces } from "../preload"
import { SIGN_IN_PROVIDERS } from "../http"
import { createInviteHttp } from "../http"
import { normalizeAccessKey } from "../invite"
import {
  type PendingRequestView,
} from "../projection"
import type { SessionInfoView } from "../store"
import {
  accountReadState,
  cachedSessionsView,
  connectionLabel,
  deviceAvailabilityView,
  hasWaitingSession,
  remoteEntryView,
  sessionAvailabilityView,
  sessionProjectLabel,
  summarizeConnection,
  workspaceLabels,
  workspaceDestination,
  type DeviceAvailabilityView,
} from "../view-model"
import { officeInputFromRemote } from "../office/adapter"
import { projectOffice } from "../office/model"
import { OfficeWorkspace } from "../office/OfficeWorkspace"
import { createOfficeSettings, type OfficeSettingsStore, type WorkspacePresentation } from "../office/storage"
import { Composer } from "./composer"
import { CommandPalette, focusComposerField, type PaletteHandlers } from "./command-palette"
import { NewSessionButton, NewSessionComposer } from "./new-session"
import { ProviderConnect } from "./provider-connect"
import type { CatalogTarget } from "../catalog"
import { UsagePage } from "./usage"
import {
  AccountSettings,
  AppSettings,
  LatencySettings,
  AppearanceSettings,
  DeviceSettings,
  MachineSettings,
  NotificationSettings,
  OfficeSettings,
  moveRadio,
} from "./settings"
import { RequestCard } from "./conversation"
import { JumpControls, TranscriptNavigation, jumpBehavior, type TranscriptPosition } from "./transcript-nav"
import { NotificationCenter, ToastLayer } from "./notifications"
import { TodoPanel } from "./todo-panel"
import { RunningSessions } from "./running-sessions"
import { LoadingPlaceholder } from "./loading"
import { SubagentBar, TeamAnswerForm } from "./subagent-bar"
import { createRowVirtualizer, sameKeys, scrollParent } from "./virtual-rows"
import { TeamHeading, TeamView } from "./team-view"
import { isManagedSubagent, siblingTargets, teamActiveCount, teamActivityLabel } from "./team-model"
import {
  remoteSurfaceComposition,
  connectionStripView,
  sessionChips,
  sessionNeedsAttention,
  summarizeSession,
  views,
  type RemoteView,
} from "./shell-model"

const sessionRailKey = "ycoding.remote.desktopRailCollapsed"

const settingsSupport = "Machine, account, devices, app, appearance, office view, and notifications for this workspace."

export function RemoteShell(props: { readonly path: () => string }): JSX.Element {
  const remote = useRemote()
  const navigate = useNavigate()
  const search = useLocation({ select: (location): Readonly<Record<string, unknown>> => location.search })
  const originWorkspaceID = () => {
    const workspaceID = search().workspace_id
    return typeof workspaceID === "string" ? workspaceID : undefined
  }
  const [navOpen, setNavOpen] = createSignal(false)
  const [navClosing, setNavClosing] = createSignal(false)
  const [navGeneration, setNavGeneration] = createSignal(1)
  const [newSessionWorkspaceID, setNewSessionWorkspaceID] = createSignal<string>()
  const [providerConnect, setProviderConnect] = createSignal<{ readonly target: CatalogTarget; readonly returnFocus: HTMLElement; readonly deviceID: string | undefined; readonly generation: number }>()
  let closeSessionsSheet: (() => void) | undefined
  let navTrigger: HTMLButtonElement | undefined
  const closeNav = () => {
    if (!navOpen()) return
    if (closeSessionsSheet) closeSessionsSheet()
    else setNavOpen(false)
  }
  const storage = browserStorage()
  const [railCollapsed, setRailCollapsed] = createSignal(readStored(storage, sessionRailKey, (value) => value === "true") ?? false)
  const toggleRail = () => {
    setRailCollapsed((collapsed) => {
      writeStored(storage, sessionRailKey, String(!collapsed))
      return !collapsed
    })
  }
  let rail: HTMLDivElement | undefined
  let railExpand: HTMLButtonElement | undefined
  let railCollapse: HTMLButtonElement | undefined
  let railTop = 0
  const collapseRail = () => {
    railTop = rail?.scrollTop ?? 0
    toggleRail()
    queueMicrotask(() => railExpand?.focus({ preventScroll: true }))
  }
  const expandRail = () => {
    toggleRail()
    queueMicrotask(() => {
      if (rail) {
        rail.scrollTop = railTop
        rail.dispatchEvent(new Event("scroll"))
      }
      railCollapse?.focus({ preventScroll: true })
    })
  }
  const [teamOpen, setTeamOpen] = createSignal(false)
  const [teamVisible, setTeamVisible] = createSignal(false)
  const [teamEntering, setTeamEntering] = createSignal(false)
  const [teamClosing, setTeamClosing] = createSignal(false)
  const [teamGeneration, setTeamGeneration] = createSignal(1)
  let closeTeamSheet: (() => void) | undefined
  let teamTrigger: HTMLButtonElement | undefined
  let teamLayer: HTMLElement | undefined
  let teamTimer: ReturnType<typeof setTimeout> | undefined
  let teamFrame: number | undefined
  onCleanup(() => {
    if (teamTimer !== undefined) clearTimeout(teamTimer)
    if (teamFrame !== undefined) cancelAnimationFrame(teamFrame)
  })
  let loadedControlsRoot: string | undefined
  const readPhoneLayout = () => getComputedStyle(document.documentElement).getPropertyValue("--yc-phone-layout").trim() === "1"
  const [phoneLayout, setPhoneLayout] = createSignal(readPhoneLayout())
  const updatePhoneLayout = createThrottler(() => setPhoneLayout(readPhoneLayout()), { wait: 50 })
  window.addEventListener("resize", updatePhoneLayout.maybeExecute)
  onCleanup(() => window.removeEventListener("resize", updatePhoneLayout.maybeExecute))

  const office = createOfficeSettings()
  const state = () => remote.state()
  const view = (): RemoteView => views.find((entry) => entry === props.path()) ?? "/remote"
  let scrollHost: HTMLDivElement | undefined
  let jumpSlot: HTMLDivElement | undefined
  const anchors = new Map<string, TranscriptPosition>()
  const [pendingAnchor, setPendingAnchor] = createSignal<{ readonly sessionID: string; readonly position: TranscriptPosition }>()
  let lastScroll = { top: 0, distance: 0 }
  const scrollTo = (top: number) => {
    if (!scrollHost) return
    scrollHost.scrollTop = top
    scrollHost.dispatchEvent(new Event("scroll"))
  }
  let previousScrollContext = { route: view(), sessionID: state().activeSessionID }
  createEffect(() => {
    const route = view()
    const sessionID = state().activeSessionID
    if (route === previousScrollContext.route && sessionID === previousScrollContext.sessionID) return
    const routeChanged = previousScrollContext.route !== route
    previousScrollContext = { route, sessionID }
    setPendingAnchor(undefined)
    if (routeChanged && route !== "/remote/session" && scrollHost) queueMicrotask(() => { if (view() === route) scrollTo(0) })
    if (routeChanged || route !== "/remote/session" || sessionID === undefined || !anchors.has(sessionID)) return
    setPendingAnchor({ sessionID, position: anchors.get(sessionID)! })
  })
  const officeShown = () => view() === "/remote/session" && ownsSessionDevice() && !phoneLayout() && office.presentation() === "office"
  const activeSession = () => state().selectedSessionInfo ?? state().sessions.find((session) => session.id === state().activeSessionID)
  const selected = () => activeSession() !== undefined
  const selectedLoading = () => selected() && state().history === undefined && state().notice === undefined &&
    state().connection.kind === "connected" && state().transport.kind === "open"
  const managedChild = () => isManagedSubagent(activeSession())
  const warmable = remote.select((current) => current.transport.kind === "open" && current.connection.kind === "connected" && current.sessionListStatus === "ready" ? current.generation : undefined)
  let warmup: { readonly generation: number; readonly timer: ReturnType<typeof setTimeout> } | undefined
  createEffect(() => {
    const generation = warmable()
    if (generation === undefined || selectedLoading() || warmup?.generation === generation) return
    clearTimeout(warmup?.timer)
    // Once the workspace settles, read what the other pages open with so their first visit paints at once.
    warmup = { generation, timer: setTimeout(() => {
      if (state().generation !== generation) return
      preloadUsage(remote)
      preloadKeepAwake(remote)
      preloadWorkspaces(remote)
    }, 1_500) }
  })
  onCleanup(() => clearTimeout(warmup?.timer))
  const childParentID = () => activeSession()?.parentID
  const composerSessionID = () => managedChild() ? childParentID() : state().activeSessionID
  const siblingTasks = () => state().team?.rootID === childParentID() ? state().team?.tasks ?? [] : []
  const currentTask = () => siblingTasks().find((task) => task.sessionID === activeSession()?.id)
  const siblingNavigation = () => siblingTargets(siblingTasks(), activeSession()?.id ?? "")
  const composition = () => remoteSurfaceComposition(view(), selected() && ownsSessionDevice())
  const viewClass = () => view() === "/remote" || view() === "/remote/session" ? "conversation" : view().slice("/remote/".length)
  const entry = () => remoteEntryView(accountReadState({ connection: state().connection, owner: state().owner }))
  const canCreateSession = () => state().connection.kind === "connected" && state().transport.kind === "open"
  const [listedGeneration, setListedGeneration] = createSignal<number>()
  createEffect(() => {
    if (state().sessionListStatus === "ready" || state().sessionListStatus === "error") setListedGeneration(state().generation)
  })
  const [newSessionVisited, setNewSessionVisited] = createSignal(false)
  const openSessionsNavigation = (trigger: HTMLButtonElement) => {
    navTrigger = trigger
    if (navClosing()) {
      setNavGeneration((generation) => generation + 1)
      setNavClosing(false)
    }
    setNavOpen(true)
  }
  const newSessionOpen = () => view() === "/remote"
  const firstInventoryLoading = () => state().sessionListStatus === "loading" && listedGeneration() !== state().generation
  const showNewSession = () => newSessionOpen() && !firstInventoryLoading()
  createEffect(() => { if (newSessionOpen()) setNewSessionVisited(true) })
  const conversationHidden = () => view() !== "/remote/session" || !ownsSessionRoute() || routeError() !== undefined || (officeShown() && selected())
  const openNewSession = (source?: "sessions" | "sidebar") => {
    if (!canCreateSession()) return
    closeNav()
    navigate({ to: "/remote", search: { ...(source === undefined ? {} : { ...(state().selectedWorkspaceID === undefined ? {} : { workspace_id: state().selectedWorkspaceID }), source }), device_id: state().activeDeviceID } })
  }
  let focusAfterSelection: string | undefined
  const openSession = (sessionID: string) => {
    const current = state().activeSessionID
    if (current !== undefined && !conversationHidden() && state().history !== undefined) {
      if (lastScroll.distance <= 1) anchors.delete(current)
      else {
        const bounds = scrollHost?.getBoundingClientRect()
        const row = bounds ? [...scrollHost!.querySelectorAll<HTMLElement>("[data-message-id]")].find((row) => row.getBoundingClientRect().top >= bounds.top && row.getBoundingClientRect().top < bounds.bottom) : undefined
        anchors.set(current, { top: lastScroll.top, ...(row && bounds ? { key: row.dataset.messageId, offset: row.getBoundingClientRect().top - bounds.top } : {}) })
      }
    }
    focusAfterSelection = view() !== "/remote/session" ? sessionID : undefined
    closeNav()
    if (current !== sessionID) void remote.store.selectSession(sessionID)
    navigate({ to: "/remote/session", search: sessionSearch(sessionID, state().activeDeviceID), replace: newSessionOpen() })
  }
  createEffect(() => {
    const route = view()
    const activeSessionID = state().activeSessionID
    const loading = selectedLoading()
    const opening = newSessionOpen()
    if (focusAfterSelection !== undefined && route !== "/remote/session" && route !== "/remote" && !loading) { focusAfterSelection = undefined; return }
    if (focusAfterSelection === undefined || focusAfterSelection !== activeSessionID || loading || opening) return
    const sessionID = focusAfterSelection
    queueMicrotask(() => {
      if (focusAfterSelection !== sessionID || state().activeSessionID !== sessionID || newSessionOpen()) return
      const target = document.querySelector<HTMLElement>(".workspace__topbar:not([inert]) .conversation-breadcrumb")
      target?.focus({ preventScroll: true })
      if (document.activeElement === target) focusAfterSelection = undefined
    })
  })
  const openFromTeam = (sessionID: string) => { closeTeam(); openSession(sessionID) }
  const openCreatedSession = (sessionID: string) => { setNewSessionVisited(false); openSession(sessionID) }
  const requested = () => view() === "/remote/session" ? readSessionSearch(search()) : undefined
  const ownsSessionRoute = () => {
    const target = requested()
    return target === undefined ? state().activeSessionID === undefined : target.sessionID === state().activeSessionID &&
      (target.deviceID === undefined || target.deviceID === state().activeDeviceID)
  }
  const [routeError, setRouteError] = createSignal<string>()
  const ownsSessionDevice = () => {
    const deviceID = requested()?.deviceID
    return routeError() === undefined && (deviceID === undefined || deviceID === state().activeDeviceID)
  }
  let readAlert: string | undefined
  createEffect(() => {
    const target = requested()
    setRouteError(undefined)
    if (target === undefined) {
      if (view() === "/remote/session" && search().session_id !== undefined) setRouteError("The Session link is invalid. Select a Session from Sessions.")
      return
    }
    if (state().owner === undefined) return
    if (target.deviceID !== undefined) {
      const device = state().devices.find((item) => item.id === target.deviceID)
      if (device === undefined || device.status !== "active") { setRouteError("The machine for this Session is unavailable to this account."); return }
      if (!device.online) { setRouteError("The machine for this Session is offline. Reconnect that machine to open its Session."); return }
      if (target.deviceID !== state().activeDeviceID) { untrack(() => remote.store.connect(target.deviceID!)); return }
    }
    if (state().transport.kind !== "open" || state().connection.kind !== "connected") return
    if (target.noticeID !== undefined && target.deviceID === state().activeDeviceID && readAlert !== `${target.deviceID}:${target.noticeID}`) {
      readAlert = `${target.deviceID}:${target.noticeID}`
      untrack(() => { void remote.store.readNotification(target.noticeID!) })
    }
    if (state().activeSessionID !== target.sessionID) untrack(() => { void remote.store.selectSession(target.sessionID) })
  })
  createEffect(() => {
    if (managedChild() && state().team?.status === "ready" && currentTask()?.tokens === undefined) void remote.store.loadSelectedSubagentEconomics()
  })
  createEffect(() => remote.store.watchTeam(view() === "/remote/session" && state().activeSessionID !== undefined))
  onCleanup(() => remote.store.watchTeam(false))
  createEffect(() => {
    const team = state().team
    if (!teamOpen() || team?.status !== "ready") { loadedControlsRoot = undefined; return }
    if (loadedControlsRoot === team.rootID) return
    loadedControlsRoot = team.rootID
    void remote.store.loadTeamControls()
  })
  const closeTeam = () => {
    if (!teamOpen()) return
    if (phoneLayout()) { closeTeamSheet?.(); return }
    setTeamOpen(false)
    document.querySelector<HTMLButtonElement>('[aria-label="Open Team"]')?.focus()
    teamTimer = setTimeout(() => setTeamVisible(false), 220)
  }
  const openTeam = () => {
    if (office.presentation() === "office") office.present("conversation")
    if (phoneLayout()) {
      document.querySelector<HTMLButtonElement>('[aria-label="Open Team"]')?.focus()
      if (teamClosing()) {
        setTeamClosing(false)
        setTeamGeneration((generation) => generation + 1)
      }
      setTeamOpen(true)
      return
    }
    if (teamTimer !== undefined) clearTimeout(teamTimer)
    setTeamEntering(true)
    setTeamVisible(true)
    setTeamOpen(true)
    teamLayer?.getBoundingClientRect()
    teamFrame = requestAnimationFrame(() => setTeamEntering(false))
  }
  const openFromAlert = (value: unknown) => {
    const sessionID = Reflect.get(Object(value), "sessionID")
    const deviceID = Reflect.get(Object(value), "deviceID")
    const noticeID = Reflect.get(Object(value), "noticeID")
    if (typeof sessionID !== "string" || !isSessionID(sessionID)) return
    navigate({ to: "/remote/session", search: sessionSearch(sessionID, isAlertDeviceID(deviceID) ? deviceID : undefined, typeof noticeID === "string" && noticeSequence(noticeID) !== undefined ? noticeID : undefined) })
  }
  const alertEvent = (event: Event) => openFromAlert(event instanceof CustomEvent ? event.detail : undefined)
  const workerMessage = (event: MessageEvent) => {
    if (Reflect.get(Object(event.data), "type") === "ycoding:open-session") openFromAlert(event.data)
  }
  window.addEventListener("ycoding:open-session", alertEvent)
  navigator.serviceWorker?.addEventListener("message", workerMessage)
  onCleanup(() => {
    window.removeEventListener("ycoding:open-session", alertEvent)
    navigator.serviceWorker?.removeEventListener("message", workerMessage)
  })
  const prefillComposer = (text: string) => {
    const sessionID = composerSessionID()
    if (sessionID === undefined) return
    const draft = state().drafts[sessionID] ?? ""
    remote.store.setDraft(sessionID, draft.startsWith(text) ? draft : `${text}${draft}`)
    if (office.presentation() === "office") office.present("conversation")
    if (view() !== "/remote/session") navigate({ to: "/remote/session", search: sessionSearch(sessionID, state().activeDeviceID) })
    focusComposerField()
  }
  const paletteHandlers: Omit<PaletteHandlers, "openTeam"> = {
    go: (target) => {
      if (target === "new") { openNewSession(); return }
      if (target === "session") {
        const sessionID = state().activeSessionID
        if (sessionID !== undefined) navigate({ to: "/remote/session", search: sessionSearch(sessionID, state().activeDeviceID) })
        return
      }
      navigate({ to: `/remote/${target}` })
    },
    openSession,
    draft: prefillComposer,
    selectModel: () => {
      if (office.presentation() === "office") office.present("conversation")
      const scope = view() === "/remote" ? ".new-session-composer" : ".composer-resident"
      const trigger = [...document.querySelectorAll<HTMLButtonElement>(`${scope} .model-control__trigger, ${scope} .composer__mobile-trigger`)]
        .find((button) => !button.disabled && !button.closest("[inert]") && button.getClientRects().length > 0)
      trigger?.focus({ preventScroll: true })
      trigger?.click()
    },
    connectProvider: (target, returnFocus) => setProviderConnect({ target, returnFocus, deviceID: state().activeDeviceID, generation: state().generation }),
  }
  createEffect(() => {
    const current = providerConnect()
    if (current && (current.deviceID !== state().activeDeviceID || current.generation !== state().generation)) setProviderConnect(undefined)
  })
  const paletteSessionSelected = () => selected() && (view() !== "/remote/session" || (ownsSessionDevice() && ownsSessionRoute()))
  const teamContent = () => <TeamView
    data={() => state().team!} currentSessionID={state().activeSessionID ?? ""} now={Date.now} sheet={phoneLayout()}
    onClose={closeTeam} onOpen={openFromTeam} onCancel={remote.store.cancelSubagent} onAnswer={remote.store.answerSubagent}
    onLoadOlder={remote.store.loadMoreTeam} onViewShell={remote.store.teamShellOutput} onKillShell={remote.store.killTeamShell}
    onOpenSideChat={openFromTeam} onCreateSideChat={remote.store.createSideChat} onLoadOlderSideChats={remote.store.loadMoreSideChats} />

  return (
    <Show when={entry() === "workspace"} fallback={<SignInScreen />}>
      <div class={`app app--${viewClass()}${view() === "/remote/session" && selected() && ownsSessionDevice() ? " app--selected" : view() === "/remote" ? " app--empty" : ""}${view() === "/remote/session" && managedChild() ? " app--managed-child" : ""}${view() === "/remote/session" && selectedLoading() ? " app--selected-loading" : ""}${railCollapsed() ? " app--rail-collapsed" : ""}${officeShown() ? " app--office" : ""}${showNewSession() ? " app--new-session" : ""}`}>
        <a class="skip-link" href="#remote-main">Skip to content</a>
        <aside id="session-rail" class="workspace__rail" aria-label="Workspace navigation">
          <div class="workspace__rail-head">
            <Link to="/" class="brand" title="YCoding home"><BrandMark compact /></Link>
            <Show when={railCollapsed()} fallback={<button ref={railCollapse} type="button" class="session-panel__collapse" aria-label="Hide workspace sidebar" aria-expanded="true" aria-controls="session-rail" onClick={collapseRail}><Icon name="panel-left" /></button>}>
              <button ref={railExpand} type="button" class="session-panel__collapse workspace__rail-expand" aria-label="Show workspace sidebar" aria-expanded="false" aria-controls="session-rail" onClick={expandRail}><Icon name="panel-left" /></button>
            </Show>
          </div>
          <div class="workspace__rail-navigation">
            <PrimaryNav view={view()} />
            <div class="workspace-new-session"><NewSessionButton labeled disabled={!canCreateSession()} onClick={() => openNewSession()} /></div>
            <ResumeSession view={view()} />
          </div>
          <div ref={rail} class="workspace__rail-body" inert={railCollapsed()}>
            <Show when={composition().showSessionRail}>
              <SessionPanel canCreateSession={canCreateSession()} onNewSession={() => openNewSession("sidebar")} onSelectSession={openSession} />
            </Show>
            <Show when={view() === "/remote/sessions"}><WorkspaceNav /></Show>
          </div>
          <div class="workspace__rail-footer"><span class="workspace-select__label">Selected machine</span><strong>{state().devices.find((device) => device.id === state().activeDeviceID)?.name ?? summarizeConnection(state().connection).label}</strong><Link to="/remote/settings" class="text-link">Manage connection</Link></div>
        </aside>
        <RemoteHeader
          navExpanded={navOpen() && !navClosing()}
          onOpenNav={openSessionsNavigation}
          onOpenSession={openSession}
          palette={{ canCreateSession: canCreateSession(), sessionSelected: paletteSessionSelected(), managedChild: managedChild(), workspaceID: newSessionWorkspaceID(), handlers: paletteHandlers }}
          team={view() === "/remote/session" && selected() && ownsSessionDevice() ? {
            count: state().team === undefined ? undefined : teamActiveCount(state().team!),
            activity: state().team === undefined ? "Activity unreported" : teamActivityLabel(state().team!),
            expanded: teamOpen() && !teamClosing(),
            loading: selectedLoading(),
            ref: (element) => { teamTrigger = element },
            onOpen: openTeam,
          } : undefined}
          view={view()}
        />

        <ConnectionStrip />

        <div class="workspace">
          <main id="remote-main" tabindex="-1" class="workspace__main">
            <Show when={view() === "/remote/session" && selected() && ownsSessionDevice()}>
              <div class="workspace__topbar" data-toast-clearance aria-hidden={selectedLoading() ? "true" : undefined} inert={selectedLoading()}>
                <div class="workspace__heading">
                  <div class="conversation-breadcrumb" tabindex="-1" aria-label="Selected workspace and session">
                    <Link to="/remote/sessions" class="conversation-back button button--ghost button--icon" ariaLabel="Back to Sessions" title="Back to Sessions"><Icon name="arrow-left" /></Link>
                    <div class="conversation-breadcrumb__identity"><span class="conversation-breadcrumb__project" title={activeSession()?.directory}>{sessionProjectLabel(activeSession() ?? {})}</span><h1><strong title={activeSession()?.title}>{activeSession()?.title ?? noSessionTitle}</strong></h1></div>
                  </div>
                  <Show when={!phoneLayout()}><PresentationSwitch
                    value={office.presentation()}
                    attention={(state().view?.requests.length ?? 0) > 0}
                    onChange={office.present}
                  /></Show>
                </div>
              </div>
            </Show>
            <div class="workspace__scroll" ref={scrollHost} onScroll={() => {
              if (scrollHost) lastScroll = { top: scrollHost.scrollTop, distance: scrollHost.scrollHeight - scrollHost.clientHeight - scrollHost.scrollTop }
            }}>
              <Notices />
              <Show when={state().activeSessionID === undefined && !selected() && state().sessions.length === 0 &&
                (state().connection.kind === "loading" || state().connection.kind === "connecting")}
                fallback={<>
                  <RoutePanel active={!conversationHidden()} preserve class="remote-conversation-view">
                    <Show when={!selectedLoading()} fallback={<LoadingPlaceholder kind="screen" label="Loading session…" />}>
                      <ConversationView active={!conversationHidden()} position={pendingAnchor()?.sessionID === state().activeSessionID ? pendingAnchor()?.position : undefined} onPositioned={() => setPendingAnchor(undefined)} canCreateSession={canCreateSession()} onNewSession={openNewSession} />
                    </Show>
                  </RoutePanel>
                  <RoutePanel active={view() === "/remote" && firstInventoryLoading()}><LoadingPlaceholder kind="screen" label="Loading sessions…" /></RoutePanel>
                  <RoutePanel active={view() === "/remote" && showNewSession()} preserve={newSessionVisited()} onInteract={() => setNewSessionVisited(true)}><For each={showNewSession() || newSessionVisited() ? [state().activeDeviceID] : []}>{() => <NewSessionComposer workspaceID={originWorkspaceID()} onCreated={openCreatedSession} onWorkspaceChange={setNewSessionWorkspaceID} />}</For></RoutePanel>
                  <RoutePanel active={view() === "/remote/session" && routeError() !== undefined}><p class="notice-strip" role="alert">{routeError()}</p></RoutePanel>
                  <RoutePanel active={view() === "/remote/session" && officeShown() && selected()}><OfficePresentation office={office} onSelectSession={openSession} /></RoutePanel>
                  <RoutePanel active={view() === "/remote/sessions"}>
                    <SessionsPage
                      canCreateSession={canCreateSession()}
                      onNewSession={() => openNewSession()}
                      onNewWorkspaceSession={() => openNewSession("sessions")}
                      onSelectSession={openSession}
                    />
                  </RoutePanel>
                  <RoutePanel active={view() === "/remote/usage"}><UsagePage /></RoutePanel>
                  <RoutePanel active={view() === "/remote/settings"}><SettingsPage office={office} phoneLayout={phoneLayout()} /></RoutePanel>
                </>}>
                <LoadingPlaceholder kind="screen" label="Checking account and connecting to machine…" />
                <Show when={view() === "/remote/settings"}>
                  <div class="pane settings"><AccountSettings /></div>
                </Show>
              </Show>
            </div>
            <div class="conversation-jump-slot" ref={jumpSlot} />
            <Show when={view() === "/remote/sessions" && jumpSlot}>{(slot) => <SessionsTopAnchor slot={slot()} scroll={() => scrollHost} />}</Show>
            <Show when={composition().showComposer && !officeShown() && !newSessionOpen()}>
              <TodoPanel todos={state().todos} />
            </Show>
            <Show when={selected()}>
                <RoutePanel active={!managedChild() && (view() !== "/remote/session" || ownsSessionRoute())} preserve class="composer-resident"><Composer
                  sessionID={composerSessionID()}
                  running={state().view?.status === "running"}
                  canSend={
                    !managedChild() && state().transport.kind === "open" &&
                    state().connection.kind !== "offline" &&
                    state().activeSessionID !== undefined
                  }
                /></RoutePanel>
                <RoutePanel active={managedChild()} class="subagent-resident">
                  <SubagentBar
                    sessionID={state().activeSessionID ?? ""}
                    parentTitle={state().sessions.find((item) => item.id === childParentID())?.title ?? "Main session"}
                    agent={activeSession()?.agent ?? currentTask()?.agent} description={currentTask()?.description ?? activeSession()?.title}
                    status={currentTask()?.state} modelLabel={activeSession()?.modelLabel ?? currentTask()?.modelLabel}
                    economics={currentTask() === undefined ? undefined : { tokens: currentTask()?.tokens, cost: currentTask()?.cost, cacheHitRatio: currentTask()?.cacheHitRatio,
                      cacheRead: currentTask()?.cacheRead, cacheWrite: currentTask()?.cacheWrite, contextTotal: currentTask()?.contextTotal, contextLimit: currentTask()?.contextLimit }}
                    question={currentTask()?.question}
                    onAnswer={(questionID, text) => remote.store.answerSubagent(activeSession()?.id ?? "", questionID, text)}
                    previousID={siblingNavigation().previous} nextID={siblingNavigation().next}
                    onMain={() => { if (childParentID()) openSession(childParentID()!) }}
                  onPrevious={() => { if (siblingNavigation().previous) openSession(siblingNavigation().previous!) }}
                  onNext={() => { if (siblingNavigation().next) openSession(siblingNavigation().next!) }} />
                </RoutePanel>
            </Show>
          </main>

        </div>

        <Show when={providerConnect()}>{(connection) => <ProviderConnect target={connection().target} returnFocus={connection().returnFocus} onClose={() => setProviderConnect(undefined)} onConnected={() => { void remote.store.loadCatalog(connection().target, { refresh: true }) }} />}</Show>
        <Show when={(phoneLayout() ? teamOpen() : teamVisible()) && view() === "/remote/session" && state().team !== undefined && selected()}>
          <aside ref={teamLayer} class={`${phoneLayout() ? "team-control__phone" : "team-control__panel"}${teamEntering() ? " team-control--entering" : ""}${!teamOpen() ? " team-control--exiting" : ""}`} aria-label="Team controls" aria-hidden={!teamOpen() || teamClosing() ? "true" : undefined} inert={!teamOpen() || teamClosing()}
            onClick={(event) => { if (phoneLayout() && event.target === teamLayer?.querySelector("dialog.team-view__sheet")) closeTeam() }}>
            {phoneLayout() ? <Show when={teamGeneration()} keyed>{(generation) => <Modal class="overlay--sheet team-view__sheet" label="Team" header={<TeamHeading data={() => state().team!} />} returnFocus={teamTrigger!} requestClose={(close) => { closeTeamSheet = close }}
              onDismiss={() => setTeamClosing(true)} onClose={() => {
                if (teamGeneration() !== generation) return
                closeTeamSheet = undefined
                setTeamOpen(false)
                setTeamClosing(false)
              }}>{teamContent()}</Modal>}</Show> : teamContent()}
          </aside>
        </Show>

        <BottomNav view={view()} />

        <ToastLayer sessionID={composerSessionID()} onOpenSession={openSession} />

        <Show when={navOpen() ? navGeneration() : undefined} keyed>
          {(generation) => <Modal class="overlay--slideover overlay--sessions-sheet" label="Sessions" returnFocus={navTrigger!} requestClose={(close) => { closeSessionsSheet = close }} onDismiss={() => setNavClosing(true)} onClose={() => {
            if (navGeneration() !== generation) return
            closeSessionsSheet = undefined
            setNavClosing(false)
            setNavOpen(false)
          }}>
            <SessionPanel
              canCreateSession={canCreateSession()}
              onNewSession={() => openNewSession("sidebar")}
              onSelectSession={openSession}
              onNavigate={closeNav}
            />
          </Modal>}
        </Show>

      </div>
    </Show>
  )
}

function RoutePanel(props: { readonly active: boolean; readonly preserve?: boolean; readonly class?: string; readonly onInteract?: () => void; readonly children: JSX.Element }): JSX.Element {
  const [mounted, setMounted] = createSignal(props.preserve === true || props.active)
  const [phase, setPhase] = createSignal<"active" | "entering" | "exiting" | "idle">(props.active ? "active" : "idle")
  let host: HTMLDivElement | undefined
  let prior = props.active
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  let entranceFrame: number | undefined
  createEffect(() => {
    const active = props.active
    if (active === prior) return
    prior = active
    if (exitTimer !== undefined) clearTimeout(exitTimer)
    if (entranceFrame !== undefined) cancelAnimationFrame(entranceFrame)
    if (active) {
      setMounted(true)
      setPhase("entering")
      host?.getBoundingClientRect()
      entranceFrame = requestAnimationFrame(() => setPhase("active"))
      return
    }
    if (!mounted()) return
    if (host?.contains(document.activeElement)) [...document.querySelectorAll<HTMLElement>('.remote-nav__link[aria-current="page"], .bottom-nav__item[aria-current="page"]')].find((link) => link.getClientRects().length > 0)?.focus({ preventScroll: true })
    setPhase("exiting")
    exitTimer = setTimeout(() => {
      if (!props.preserve) setMounted(false)
      setPhase("idle")
    }, document.documentElement.dataset.motion === "on" ? 140 : 0)
  })
  onCleanup(() => {
    if (exitTimer !== undefined) clearTimeout(exitTimer)
    if (entranceFrame !== undefined) cancelAnimationFrame(entranceFrame)
  })
  return <Show when={mounted()}><div ref={host} onFocusIn={props.onInteract} onPointerDown={props.onInteract} onInput={props.onInteract} onDrop={props.onInteract} class={`route-panel route-panel--${phase()}${props.class ? ` ${props.class}` : ""}`} aria-hidden={props.active ? undefined : "true"} inert={!props.active}>{props.children}</div></Show>
}

/**
 * A signed-out browser sees one task: choose an OAuth provider. The workspace chrome is
 * absent because nothing in it can load before the account is known.
 */
function SignInScreen(): JSX.Element {
  const remote = useRemote()
  const [accessKey, setAccessKey] = createSignal("")
  const [keyBusy, setKeyBusy] = createSignal(false)
  const [keyError, setKeyError] = createSignal("")
  const signInWithKey = async (event: SubmitEvent) => {
    event.preventDefault()
    if (keyBusy()) return
    setKeyBusy(true)
    setKeyError("")
    const result = await createInviteHttp().signIn(normalizeAccessKey(accessKey()) ?? accessKey())
    setKeyBusy(false)
    if (result.ok) {
      setAccessKey("")
      await remote.store.load()
      return
    }
    setKeyError(result.status === 401 ? "That access key isn't valid." : result.status === 429 ? "Too many attempts. Try again later."
      : "Sign-in could not connect. Try again.")
  }
  return (
    <main id="remote-main" class="sign-in">
      <div class="sign-in__panel">
        <div class="sign-in__top">
          <Link to="/" class="brand" title="YCoding home">
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
        <form class="field" onSubmit={(event) => void signInWithKey(event)}>
          <label class="field__label" for="remote-access-key">Access key</label>
          <input id="remote-access-key" class="input" value={accessKey()} onInput={(event) => setAccessKey(event.currentTarget.value)}
            autocomplete="off" spellcheck={false} autocapitalize="characters" aria-invalid={keyError() ? "true" : undefined} />
          <Show when={keyError()}><p class="field__error" role="alert">{keyError()}</p></Show>
          <button type="submit" class="button button--secondary sign-in__provider" disabled={keyBusy()}>{keyBusy() ? "Signing in…" : "Sign in"}</button>
        </form>
        <p class="sign-in__note">
          <Link to="/docs/usage/remote" class="text-link">How remote access works</Link>
        </p>
      </div>
    </main>
  )
}

const noSessionTitle = "No session selected"

function RemoteHeader(props: {
  readonly navExpanded: boolean
  readonly onOpenNav: (trigger: HTMLButtonElement) => void
  readonly onOpenSession: (sessionID: string) => void
  readonly palette: {
    readonly canCreateSession: boolean
    readonly sessionSelected: boolean
    readonly managedChild: boolean
    readonly workspaceID?: string
    readonly handlers: Omit<PaletteHandlers, "openTeam">
  }
  readonly team?: {
    readonly count: number | undefined
    readonly activity: string
    readonly expanded: boolean
    readonly loading: boolean
    readonly ref: (element: HTMLButtonElement) => void
    readonly onOpen: () => void
  }
  readonly view: RemoteView
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const connection = () => summarizeConnection(state().connection)
  return (
    <header class="app-header" data-toast-clearance>
      <div class="app-header__inner">
        <button
          type="button"
          class="button button--ghost button--icon app-header__menu"
          aria-label="Open sessions"
          aria-expanded={props.navExpanded}
          onClick={(event) => props.onOpenNav(event.currentTarget)}
        >
          <Icon name="menu" />
        </button>
        <Link to="/" class={`brand${props.view !== "/remote/session" && state().activeSessionID !== undefined ? " brand--with-resume" : ""}`} title="YCoding home">
          <img class="brand__mark" src="/brand/ycoding-mark.svg" alt="YCoding" width={28} height={28} />
        </Link>
        <ResumeSession view={props.view} />
        <div class="remote-device">
          <span class="remote-connection">
            <span class={`status-dot status-dot--${connection().tone}`} aria-hidden="true" />
            <span class="remote-connection-label">{connectionLabel(state().connection, state().transport)}</span>
          </span>
        </div>
        <div class="app-header__end">
          <CommandPalette
            view={props.view}
            canCreateSession={props.palette.canCreateSession}
            sessionSelected={props.palette.sessionSelected}
            managedChild={props.palette.managedChild}
            workspaceID={props.palette.workspaceID}
            hasTeam={props.team !== undefined}
            handlers={{ ...props.palette.handlers, openTeam: () => props.team?.onOpen() }}
          />
          <Show when={props.team}>{(team) => (
            <button
              ref={team().ref}
              type="button"
              class="button button--ghost app-header__team"
              aria-label="Open Team"
              aria-description={team().activity}
              aria-expanded={team().expanded}
              aria-hidden={team().loading ? "true" : undefined}
              inert={team().loading}
              onClick={team().onOpen}
            >
              <Icon name="team" />
              <span class="app-header__team-count">{team().activity.startsWith("At least") ? "≥" : ""}{team().count ?? "—"}</span>
            </button>
          )}</Show>
          <NotificationCenter onOpenSession={props.onOpenSession} />
          <span class="remote-header__theme">
            <ThemeToggle />
          </span>
        </div>
      </div>
    </header>
  )
}

function useNavigationAttention() {
  const remote = useRemote()
  return () => ({
    conversation: (remote.state().view?.requests.length ?? 0) > 0,
    sessions: hasWaitingSession(remote.state().sessionStatus) || (remote.state().view?.requests.length ?? 0) > 0,
  })
}

function AttentionMark(props: { readonly show: boolean }): JSX.Element {
  return (
    <Show when={props.show}>
      <span class="attention-dot" aria-hidden="true" />
    </Show>
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
      lastRelayDrop: state().lastRelayDrop,
    })
  const detail = () => {
    const sessions = state().sessions.length
    if (sessions === 0) return undefined
    const waiting = state().view?.requests.length ?? 0
    const count = `${sessions} ${sessions === 1 ? "session" : "sessions"} loaded`
    return waiting === 0 ? count : `${count} · ${waiting} waiting for you`
  }
  return (
    <Show when={strip()}>
      {(view) => (
        <div class={`status-strip${view().tone === "online" ? "" : ` status-strip--${view().tone}`}`} role="status">
          <span class={`status-dot status-dot--${view().tone}`} aria-hidden="true" />
          <span class="status-strip__body">{view().body}</span>
          <span class="status-strip__spacer" />
          <Show when={view().showReconnect}>
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
          <Show when={view().showSettings}>
            <Link to="/remote/settings" class="button button--secondary button--small">
              Open settings
            </Link>
          </Show>
          <Show when={detail()}>{(text) => <span class="status-strip__detail">{text()}</span>}</Show>
        </div>
      )}
    </Show>
  )
}

function SessionPanel(props: {
  readonly canCreateSession: boolean
  readonly onNewSession: () => void
  readonly onSelectSession: (sessionID: string) => void
  readonly onNavigate?: () => void
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const labels = createMemo(() => workspaceLabels(state().sessionGroups))
  const workspaceName = () => {
    const selected = state().activeSessionID === undefined ? undefined : state().selectedSessionInfo
    const group = selected?.projectID && selected.directory
      ? state().sessionGroups.find((entry) => entry.projectID === selected.projectID && entry.directory === selected.directory && entry.workspaceID === selected.workspaceID)
      : undefined
    const workspace = group ?? state().sessionGroups.find((entry) => entry.id === state().selectedWorkspaceID)
    return workspace === undefined ? "Sessions" : labels().get(workspace.id) ?? workspace.name ?? workspace.directory
  }
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
        <NewSessionButton workspace={labels().get(state().selectedWorkspaceID ?? "")} disabled={!props.canCreateSession} onClick={props.onNewSession} />
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
                  <SessionRailList sessions={state().sessions} readOnly onSelectSession={props.onSelectSession} />
                </>
              )}
            </Show>
          </>
        }
      >
        <div class="session-panel__workspace" aria-label="Workspace">
          <span class="workspace-select__label">Workspace</span>
          <h3>{workspaceName()}</h3>
        </div>
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
          <Show when={state().sessions.length > 0} fallback={
            <Show when={state().sessionListStatus === "loading"} fallback={<NoSessionsState />}>
              <div class="session-list" aria-busy="true">
                <LoadingPlaceholder kind="session" label="Loading sessions…" />
                <LoadingPlaceholder kind="session" label="Loading sessions…" announce={false} />
                <LoadingPlaceholder kind="session" label="Loading sessions…" announce={false} />
              </div>
            </Show>
          }>
            <SessionRailList
              sessions={state().sessions}
              readOnly={state().sessionRowsStale === true}
              busy={state().sessionRowsStale === true}
              onSelectSession={props.onSelectSession}
              onNavigate={props.onNavigate}
            />
          </Show>
          <Show when={advertised()}>{(note) => <p class="panel__note">{note()}</p>}</Show>
          <Show when={state().sessionPageLoading}><LoadingPlaceholder kind="session" label="Loading more sessions…" /></Show>
        </Show>
      </Show>
    </div>
  )
}

function SessionRailList(props: {
  readonly sessions: readonly SessionInfoView[]
  readonly readOnly: boolean
  readonly busy?: boolean
  readonly onSelectSession: (sessionID: string) => void
  readonly onNavigate?: () => void
}): JSX.Element {
  let list: HTMLDivElement | undefined
  let scroller: HTMLElement | undefined
  const keys = createMemo(() => props.sessions.map((session) => session.id), [], { equals: sameKeys })
  const byID = createMemo(() => new Map(props.sessions.map((session) => [session.id, session])))
  const rows = createRowVirtualizer({
    list: () => list,
    scroller: () => scroller ??= list ? scrollParent(list) : undefined,
    keys,
    estimate: () => 64,
    typicalSize: true,
    overscan: 6,
    layout: () => keys().length > 0,
  })
  return (
    <div ref={list} class="session-list" role="list" aria-busy={props.busy === true} style={{ "block-size": `${rows.virtualizer.getTotalSize()}px` }}>
      <For each={rows.rendered()}>
        {(id) => {
          const row = rows.row(id)
          return (
            <div class="session-list__row" role="listitem" aria-posinset={row.index() + 1} aria-setsize={keys().length} data-index={row.index()} style={{ "inset-block-start": `${row.top()}px` }} ref={row.measure}>
              <SessionRow session={byID().get(id)!} readOnly={props.readOnly} onSelectSession={props.onSelectSession} onNavigate={props.onNavigate} />
            </div>
          )
        }}
      </For>
    </div>
  )
}

function SessionTableRows(props: {
  readonly sessions: readonly SessionInfoView[]
  readonly readOnly: boolean
  readonly onSelectSession: (sessionID: string) => void
}): JSX.Element {
  let body: HTMLDivElement | undefined
  let scroller: HTMLElement | undefined
  const keys = createMemo(() => props.sessions.map((session) => session.id), [], { equals: sameKeys })
  const byID = createMemo(() => new Map(props.sessions.map((session) => [session.id, session])))
  const rows = createRowVirtualizer({
    list: () => body,
    scroller: () => scroller ??= body ? scrollParent(body) : undefined,
    keys,
    estimate: () => 64,
    typicalSize: true,
    overscan: 6,
    layout: () => keys().length > 0,
  })
  return (
    <div ref={body} class="sessions-table__body" role="rowgroup" style={{ "block-size": `${rows.virtualizer.getTotalSize()}px` }}>
      <For each={rows.rendered()}>
        {(id) => {
          const row = rows.row(id)
          return <SessionSummaryRow session={byID().get(id)!} readOnly={props.readOnly} onSelectSession={props.onSelectSession} rowIndex={row.index() + 2} top={row.top()} measure={row.measure} />
        }}
      </For>
    </div>
  )
}

function SessionRow(props: {
  readonly session: SessionInfoView
  readonly readOnly?: boolean
  readonly onSelectSession: (sessionID: string) => void
  readonly onNavigate?: () => void
}): JSX.Element {
  const remote = useRemote()
  const active = () => remote.state().activeSessionID === props.session.id || remote.state().selectedSessionInfo?.parentID === props.session.id
  const chips = () => sessionChips(props.session, remote.state().view)
  return (
    <button
      type="button"
      class={`session-row${active() ? " session-row--active" : ""}`}
      aria-pressed={active()}
      disabled={props.readOnly}
      onClick={() => {
        props.onSelectSession(props.session.id)
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
  readonly rowIndex: number
  readonly top: number
  readonly measure: (element: HTMLElement) => void
}): JSX.Element {
  const remote = useRemote()
  const summary = () => summarizeSession(props.session, remote.state().view)
  const chips = () => sessionChips(props.session, remote.state().view)
  return (
    <div class="sessions-table__row" role="row" aria-rowindex={props.rowIndex} data-index={props.rowIndex - 2} style={{ "inset-block-start": `${props.top}px` }} ref={props.measure}>
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
        <Link to="/remote/settings" class="button button--secondary button--small" onClick={props.onNavigate}>
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
  readonly active: boolean
  readonly position?: TranscriptPosition
  readonly onPositioned: () => void
  readonly canCreateSession: boolean
  readonly onNewSession: () => void
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const view = () => state().view
  const requests = () => view()?.requests ?? []
  const messages = () => view()?.messages ?? []
  const childQuestions = () => state().team?.status === "ready" && state().team?.rootID === state().activeSessionID
    ? state().team?.tasks.filter((task) => task.parentID === state().activeSessionID && task.state === "waiting" && task.question !== undefined) ?? [] : []
  const devices = useDeviceAvailability()
  // Without a reachable machine the device state is the page's one explanation.
  const blocked = () => state().activeDeviceID === undefined || state().connection.kind === "offline"
  const availability = () => blocked()
    ? devices()
    : sessionAvailabilityView(state().connection, state().sessions.length, state().sessionListStatus)
  // A connection's first session list decides whether a session opens, so the composer waits for it.
  return (
    <Show
      when={state().activeSessionID !== undefined}
      fallback={
        <Show
          when={props.canCreateSession && !blocked() && state().sessionListStatus === "loading"}
          fallback={
            <div class="empty-conversation">
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
                <Link to="/docs/usage/remote" class="button button--secondary button--small">
                  How remote access works
                </Link>
              </div>
            </div>
          }
        >
          <LoadingPlaceholder kind="screen" label="Loading sessions…" />
        </Show>
      }
    >
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
          <TranscriptNavigation messages={messages} active={props.active} position={props.position} onPositioned={props.onPositioned} />
        </Show>
        <Show when={requests().length > 0}>
          <div id="pending-requests" class="requests" tabindex="-1" aria-label="Pending requests">
            <RequestCards requests={requests} activeSessionID={state().activeSessionID} />
          </div>
        </Show>
        <Show when={childQuestions().length > 0}>
          <div class="requests" aria-label="Pending child questions">
            <For each={childQuestions().map((task) => task.sessionID)}>{(childID) => {
              const task = () => childQuestions().find((task) => task.sessionID === childID)!
              return <Show when={task().question?.id} keyed>{(questionID) => <article class="request request--form" data-child-question={questionID}>
                <header class="request__header"><Icon name="chat" size={16} /><span>Question from {task().agent ?? "Subagent"}</span></header>
                <p class="request__body">{task().description}</p>
                <TeamAnswerForm question={task().question!} onAnswer={(id, text) => remote.store.answerSubagent(childID, id, text)} />
              </article>}</Show>
            }}</For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

const presentations: readonly { readonly id: WorkspacePresentation; readonly label: string; readonly icon: IconName }[] = [
  { id: "conversation", label: "Conversation", icon: "chat" },
  { id: "office", label: "Office", icon: "office" },
]

function PresentationSwitch(props: {
  readonly value: WorkspacePresentation
  readonly attention: boolean
  readonly onChange: (value: WorkspacePresentation) => void
}): JSX.Element {
  const flagged = (id: WorkspacePresentation) => props.attention && id === "conversation"
  const [indicator, setIndicator] = createSignal({ left: 0, width: 0, ready: false })
  let switcher: HTMLDivElement | undefined
  const positionIndicator = () => {
    const selected = switcher?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
    if (selected) setIndicator({ left: selected.offsetLeft, width: selected.offsetWidth, ready: true })
  }
  const pacedIndicator = createThrottler(positionIndicator, { wait: 50 })
  createEffect(() => { props.value; queueMicrotask(positionIndicator) })
  onMount(() => {
    positionIndicator()
    const observer = new ResizeObserver(pacedIndicator.maybeExecute)
    if (switcher) {
      observer.observe(switcher)
      switcher.querySelectorAll('[role="radio"]').forEach((button) => observer.observe(button))
    }
    window.addEventListener("resize", pacedIndicator.maybeExecute)
    onCleanup(() => { observer.disconnect(); window.removeEventListener("resize", pacedIndicator.maybeExecute) })
  })
  return (
    <div ref={switcher} class="presentation-switch filters" role="radiogroup" aria-label="Workspace view"
      style={{ "--presentation-left": `${indicator().left}px`, "--presentation-width": `${indicator().width}px` }}>
      <span class="presentation-switch__indicator" classList={{ "presentation-switch__indicator--ready": indicator().ready }} aria-hidden="true" />
      <div class="presentation-switch__options">
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
            <Icon name={option.icon} size={16} />
            {option.label}
            <AttentionMark show={flagged(option.id)} />
          </button>
        )}
      </For>
      </div>
    </div>
  )
}

function OfficePresentation(props: { readonly office: OfficeSettingsStore; readonly onSelectSession: (sessionID: string) => void }): JSX.Element {
  const remote = useRemote()
  onMount(() => remote.store.watchFamilyActivity(true))
  onCleanup(() => remote.store.watchFamilyActivity(false))
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
      onSelectSession={props.onSelectSession}
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

function SessionsTopAnchor(props: { readonly slot: HTMLElement; readonly scroll: () => HTMLElement | undefined }): JSX.Element {
  const [scrolled, setScrolled] = createSignal(false)
  createEffect(() => {
    const root = props.scroll()
    if (!root) return
    const update = () => setScrolled(root.scrollTop > 8)
    update()
    root.addEventListener("scroll", update, { passive: true })
    onCleanup(() => root.removeEventListener("scroll", update))
  })
  return <Portal mount={props.slot}><JumpControls onTop={scrolled() ? () => props.scroll()?.scrollTo({ top: 0, behavior: jumpBehavior() }) : undefined} /></Portal>
}

function SessionsPage(props: {
  readonly canCreateSession: boolean
  readonly onNewSession: () => void
  readonly onNewWorkspaceSession: () => void
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
      <div class="page-head"><div><h1 class="page-head__title">Sessions</h1><p class="page-head__support">Pick up where you left off.</p></div><NewSessionButton labeled disabled={!props.canCreateSession} onClick={props.onNewSession} /></div>
      <RunningSessions sessions={remote.state().carouselSessions ?? []} loading={remote.state().carouselStatus === "loading"} onSelectSession={props.onSelectSession} />
      <Show
        when={remote.state().sessionGroups.length > 0 || remote.state().sessionListStatus === "loading"}
        fallback={
          <div class="pane sessions-page__empty">
            <Show when={remote.state().activeDeviceID !== undefined} fallback={<DeviceEmptyState />}>
              <NoSessionsState />
            </Show>
          </div>
        }
      >
        <div class="sessions-page__layout">
          <section class="pane sessions-page__content" aria-labelledby="sessions-page-title">
            <div class="sessions-page__toolbar">
              <div class="sessions-page__heading">
                <h2 id="sessions-page-title" class="sessions-page__title">{workspaceTitle()}</h2>
                <span class="chip sessions-page__count">{advertisedCount(sessions().length)} loaded</span>
              </div>
              <NewSessionButton workspace={remote.state().selectedWorkspaceID === undefined ? undefined : workspaceTitle()} disabled={!props.canCreateSession} onClick={props.onNewWorkspaceSession} />
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
            <Show when={sessions().length > 0} fallback={
              <Show when={remote.state().sessionListStatus === "loading"} fallback={<NoSessionsState />}>
                <div class="sessions-results" aria-busy="true">
                  <div class="sessions-table">
                    <LoadingPlaceholder kind="session" label="Loading sessions…" />
                    <LoadingPlaceholder kind="session" label="Loading sessions…" announce={false} />
                    <LoadingPlaceholder kind="session" label="Loading sessions…" announce={false} />
                  </div>
                </div>
              </Show>
            }>
              <div class="sessions-results" aria-busy={remote.state().sessionRowsStale === true}>
                <div class="sessions-table" role="table" aria-label="Sessions" aria-rowcount={sessions().length + 1}>
                  <div class="sessions-table__head" role="row" aria-rowindex={1}>
                    <span role="columnheader">Title</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Updated</span>
                  </div>
                  <SessionTableRows
                    sessions={sessions()}
                    readOnly={cached() !== undefined || remote.state().sessionRowsStale === true}
                    onSelectSession={props.onSelectSession}
                  />
                </div>
              </div>
            </Show>
            <Show when={remote.state().sessionPageLoading}><LoadingPlaceholder kind="session" label="Loading more sessions…" /></Show>
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
  let nav: HTMLElement | undefined
  let scrollport: HTMLElement | null = null
  const updateCue = () => {
    if (!nav) return
    const available = `${Math.max(0, Math.floor(Math.min(window.innerHeight, scrollport?.getBoundingClientRect().bottom ?? window.innerHeight) - nav.getBoundingClientRect().top))}px`
    if (nav.style.getPropertyValue("--workspace-nav-available") !== available) nav.style.setProperty("--workspace-nav-available", available)
    nav.toggleAttribute("data-more-below", nav.scrollHeight - nav.clientHeight - nav.scrollTop > 1)
  }
  const pacedCue = createThrottler(updateCue, { wait: 50 })
  onMount(() => {
    if (!nav) return
    scrollport = nav.closest(".workspace__rail-body")
    const observer = new ResizeObserver(pacedCue.maybeExecute)
    observer.observe(nav)
    const list = nav.querySelector(".workspace-nav__list")
    if (list) observer.observe(list)
    if (nav.parentElement) observer.observe(nav.parentElement)
    scrollport?.addEventListener("scroll", pacedCue.maybeExecute, { passive: true })
    window.addEventListener("resize", pacedCue.maybeExecute)
    updateCue()
    onCleanup(() => {
      observer.disconnect()
      scrollport?.removeEventListener("scroll", pacedCue.maybeExecute)
      window.removeEventListener("resize", pacedCue.maybeExecute)
    })
  })
  return (
    <nav ref={nav} class="workspace-nav" aria-label="Workspaces" onScroll={pacedCue.maybeExecute}>
      <p class="workspace-nav__title">Workspaces</p>
      <ul class="workspace-nav__list">
        <Show when={remote.state().sessionListStatus === "loading" && remote.state().sessionGroups.length === 0}><For each={[0, 1, 2]}>{(index) => <li><LoadingPlaceholder kind="session" label="Loading workspaces…" announce={index === 0} /></li>}</For></Show>
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
  const root = element.closest<HTMLElement>(".workspace__scroll, .workspace__rail-body") ??
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
      gesture = false
      direction = 0
      void store.nextSessionsPage().then(() => { lastTop = root.scrollTop })
    }
    if (direction < 0 && root.scrollTop < 250 && store.state().sessionHasPrevious) {
      gesture = false
      direction = 0
      void store.previousSessionsPage().then(() => { lastTop = root.scrollTop })
    }
  }
  const pacedCheck = createThrottler(check, { wait: 100 })
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
    pacedCheck.maybeExecute()
  }
  root.addEventListener("wheel", wheel, { passive: true })
  root.addEventListener("touchstart", touchStart, { passive: true })
  root.addEventListener("touchend", touch, { passive: true })
  root.addEventListener("pointerdown", pointer, { passive: true })
  document.addEventListener("keydown", key)
  root.addEventListener("scroll", scroll, { passive: true })
  return () => {
    unsubscribe()
    pacedCheck.cancel()
    root.removeEventListener("wheel", wheel)
    root.removeEventListener("touchstart", touchStart)
    root.removeEventListener("touchend", touch)
    root.removeEventListener("pointerdown", pointer)
    document.removeEventListener("keydown", key)
    root.removeEventListener("scroll", scroll)
  }
}

function SettingsPage(props: { readonly office: OfficeSettingsStore; readonly phoneLayout: boolean }): JSX.Element {
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
          <MachineSettings />
          <AccountSettings />
          <DeviceSettings />
          <AppSettings />
          <LatencySettings />
          <AppearanceSettings />
          <Show when={!props.phoneLayout}><OfficeSettings office={props.office} /></Show>
          <NotificationSettings />
        </div>
      </div>
    </>
  )
}

const primaryDestinations: readonly { readonly view: RemoteView; readonly label: string; readonly icon: IconName }[] = [
  { view: "/remote/sessions", label: "Sessions", icon: "sessions" },
  { view: "/remote/usage", label: "Usage", icon: "usage" },
  { view: "/remote/settings", label: "Settings", icon: "settings" },
]

function PrimaryNav(props: { readonly view: RemoteView }): JSX.Element {
  const attention = useNavigationAttention()
  return <nav class="remote-nav" aria-label="Remote workspace"><For each={primaryDestinations}>{(item) => <Link
    to={item.view} class={`remote-nav__link${workspaceDestination(props.view) === item.view ? " remote-nav__link--active" : ""}`}
    ariaCurrent={workspaceDestination(props.view) === item.view ? "page" : undefined}
    ariaLabel={item.view === "/remote/sessions" && attention().sessions ? "Sessions, waiting for your decision" : item.label} title={item.label}>
    <Icon name={item.icon} /><span class="remote-nav__label">{item.label}</span><AttentionMark show={item.view === "/remote/sessions" && attention().sessions} />
  </Link>}</For></nav>
}

function ResumeSession(props: { readonly view: RemoteView }): JSX.Element {
  const remote = useRemote()
  const attention = useNavigationAttention()
  return <Show when={props.view !== "/remote/session" ? remote.state().activeSessionID : undefined}>{(sessionID) => <Link
    to="/remote/session" search={() => sessionSearch(sessionID(), remote.state().activeDeviceID)} class="workspace-resume button button--ghost"
    ariaLabel={attention().conversation ? "Resume session, waiting for your decision" : "Resume session"} title={remote.state().selectedSessionInfo?.title ?? "Resume session"}>
    <Icon name="arrow-left" /><span>Resume session</span><AttentionMark show={attention().conversation} />
  </Link>}</Show>
}

function BottomNav(props: { readonly view: RemoteView }): JSX.Element {
  const attention = useNavigationAttention()
  const flagged = (view: RemoteView) => view === "/remote/sessions" && attention().sessions
  return (
    <nav class="bottom-nav" aria-label="Workspace">
      <For each={primaryDestinations}>
        {(item) => (
          <Link
            to={item.view}
            class={`bottom-nav__item${workspaceDestination(props.view) === item.view ? " bottom-nav__item--active" : ""}`}
            ariaLabel={flagged(item.view) ? `${item.label}, waiting for your decision` : item.label}
            ariaCurrent={workspaceDestination(props.view) === item.view ? "page" : undefined}
          >
            <span class="bottom-nav__icon">
              <Icon name={item.icon} size={20} />
              <Show when={flagged(item.view)}>
                <span class="attention-dot" aria-hidden="true" />
              </Show>
            </span>
            <span class="bottom-nav__label" aria-hidden="true">{item.label}</span>
          </Link>
        )}
      </For>
    </nav>
  )
}

function advertisedCount(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`
}
