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
import { watchKeyboardChrome } from "../../ui/visual-viewport"
import { CustomSelect } from "../../ui/custom-select"
import { BrandMark, ThemeToggle } from "../../ui/site"
import { isAlertDeviceID, readSessionSearch, sessionSearch } from "../alert"
import { useRemote } from "../context"
import { preloadKeepAwake, preloadWorkspaces } from "../preload"
import { createRemoteQuery } from "../query"
import { SIGN_IN_PROVIDERS } from "../http"
import { createInviteHttp } from "../http"
import { normalizeAccessKey } from "../invite"
import {
  generationSpeedDisplay,
  contextWindowDisplay,
} from "../projection"
import type { SessionInfoView } from "../store"
import {
  boundPlacement,
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
  telemetryConsentNoticeView,
  type DeviceAvailabilityView,
} from "../view-model"
import { officeInputFromRemote } from "../office/adapter"
import { projectOffice } from "../office/model"
import { OfficeWorkspace } from "../office/OfficeWorkspace"
import { createOfficeSettings, type OfficeSettingsStore, type WorkspacePresentation } from "../office/storage"
import { Composer } from "./composer"
import { CommandPalette, focusComposerField, type PaletteHandlers } from "./command-palette"
import type { PaletteModelBinding } from "./command-palette-model"
import { modelSelectionKey } from "./composer-logic"
import { NewSessionButton, NewSessionComposer } from "./new-session"
import { ProviderConnect } from "./provider-connect"
import { DotsConnection } from "./dots-connection"
import type { CatalogTarget } from "../catalog"
import { ProjectsPage, ProjectsRail, ProjectPanel, ProjectsDialogs, ProjectStatus, ProjectFreshness, createProjectsData } from "./projects"
import { projectOf } from "../coordination"
import { UsagePage } from "./usage"
import {
  AccountSettings,
  AppSettings,
  LatencySettings,
  AppearanceSettings,
  DeviceSettings,
  ExternalNotificationSettings,
  MachineSettings,
  NotificationSettings,
  PermissionSettings,
  OfficeSettings,
  moveRadio,
} from "./settings"
import { RequestCard } from "./conversation"
import { FileChangeCard } from "./file-change-card"
import { ReviewBox } from "./review-box"
import { PresenceList } from "./presence-list"
import { KeepAwakeIndicator } from "./keep-awake-indicator"
import { TranscriptNavigation, type TranscriptPosition } from "./transcript-nav"
import { JumpControls, jumpBehavior } from "./transcript-rail"
import { NotificationCenter, ToastLayer } from "./notifications"
import { TodoPanel } from "./todo-panel"
import { RunningSessions } from "./running-sessions"
import { LoadingPlaceholder } from "./loading"
import { SubagentBar, TeamAnswerForm } from "./subagent-bar"
import { createRowVirtualizer, sameKeys, scrollParent } from "./virtual-rows"
import { RunningExecution, TeamView } from "./team-view"
import { SharedCompanionSurface, SharedContextBreakdownPanel, SharedContextRingButton, SharedConversationHeader, SharedWorkspaceFrame, WORKSPACE_DESTINATIONS } from "./shared-workspace"
import { requestAutonomousDialog } from "./autonomous-dialog"
import { SessionStatusDetails } from "./status-bar"
import { isManagedSubagent, siblingTargets, teamActiveCount, teamActivityLabel } from "./team-model"
import {
  remoteSurfaceComposition,
  connectionStripView,
  sessionChips,
  sessionNeedsAttention,
  prioritizePanelSessions,
  groupRailSessions,
  sessionFilterCounts,
  sessionFilters,
  sessionRowSignal,
  transcriptContextMessages,
  sessionCompanionSummary,
  summarizeSession,
  views,
  type RemoteView,
} from "./shell-model"

const sessionRailKey = "ycoding.remote.desktopRailCollapsed"

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
  const [dotsConnection, setDotsConnection] = createSignal<HTMLElement>()
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
  const [companionTab, setCompanionTab] = createSignal<"activity" | "running" | "changes" | "context">("activity")
  const [paletteModels, setPaletteModels] = createSignal<ReadonlyMap<string, PaletteModelBinding>>(new Map())
  const registerPaletteModel = (binding: PaletteModelBinding) => {
    setPaletteModels((current) => new Map(current).set(binding.key, binding))
    return () => setPaletteModels((current) => {
      if (current.get(binding.key) !== binding) return current
      const next = new Map(current)
      next.delete(binding.key)
      return next
    })
  }
  const paletteModel = () => {
    const target = view() === "/remote" ? newSessionWorkspaceID() ? { workspaceID: newSessionWorkspaceID()! } : undefined : view() === "/remote/session" && state().activeSessionID ? { sessionID: state().activeSessionID! } : undefined
    const key = modelSelectionKey(target, state().activeDeviceID, state().generation)
    return key ? paletteModels().get(key) : undefined
  }
  const [teamVisible, setTeamVisible] = createSignal(false)
  const [teamEntering, setTeamEntering] = createSignal(false)
  const [teamClosing, setTeamClosing] = createSignal(false)
  const [teamGeneration, setTeamGeneration] = createSignal(1)
  let closeTeamSheet: (() => void) | undefined
  let teamTrigger: HTMLButtonElement | undefined
  let companionTrigger: HTMLElement | undefined
  let teamLayer: HTMLElement | undefined
  let teamFrame: number | undefined
  onCleanup(() => {
    if (teamFrame !== undefined) cancelAnimationFrame(teamFrame)
  })
  let loadedControlsRoot: string | undefined
  const readPhoneLayout = () => getComputedStyle(document.documentElement).getPropertyValue("--yc-phone-layout").trim() === "1"
  const [phoneLayout, setPhoneLayout] = createSignal(readPhoneLayout())
  const updatePhoneLayout = createThrottler(() => setPhoneLayout(readPhoneLayout()), { wait: 50 })
  window.addEventListener("resize", updatePhoneLayout.maybeExecute)
  onCleanup(() => window.removeEventListener("resize", updatePhoneLayout.maybeExecute))
  let releaseKeyboardChrome: (() => void) | undefined
  const bindKeyboardChrome = (element: HTMLDivElement) => {
    releaseKeyboardChrome?.()
    releaseKeyboardChrome = watchKeyboardChrome(element)
  }
  onCleanup(() => releaseKeyboardChrome?.())

  const office = createOfficeSettings()
  const state = () => remote.state()
  const activeDeviceName = () => {
    const device = state().devices.find((entry) => entry.id === state().activeDeviceID)
    return device === undefined ? summarizeConnection(state().connection).label : remote.deviceName(device)
  }
  const view = (): RemoteView => views.find((entry) => entry === props.path()) ?? "/remote"
  let scrollHost: HTMLDivElement | undefined
  const [composerMetadataMount, setComposerMetadataMount] = createSignal<HTMLDivElement>()
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
    // Once the workspace settles, read the cheap pages' data so their first visit paints at once; Usage reads when its page opens.
    warmup = { generation, timer: setTimeout(() => {
      if (state().generation !== generation) return
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
  const openNewSession = (source?: "sessions") => {
    if (!canCreateSession()) return
    closeNav()
    void navigate({ to: "/remote", search: { ...(source === undefined ? {} : { ...(state().selectedWorkspaceID === undefined ? {} : { workspace_id: state().selectedWorkspaceID }), source }), device_id: state().activeDeviceID } })
  }
  const newChatShortcut = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing) return
    if (event.key.toLowerCase() !== "n") return
    if (!canCreateSession()) return
    event.preventDefault()
    openNewSession()
  }
  document.addEventListener("keydown", newChatShortcut)
  onCleanup(() => document.removeEventListener("keydown", newChatShortcut))
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
    void navigate({ to: "/remote/session", search: sessionSearch(sessionID, state().activeDeviceID), replace: newSessionOpen() })
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
  const projects = createProjectsData(() => view() === "/remote/projects" || view() === "/remote/session", openSession)
  const sessionProject = (id: string) => {
    const project = projects.ready() ? projectOf(projects.groups(), id) : undefined
    return project === undefined ? undefined : { role: project.role, name: project.detail.name }
  }
  const projectContext = () => view() === "/remote/session" ? projects.membership() : undefined
  const [projectSheet, setProjectSheet] = createSignal(false)
  let projectTrigger: HTMLButtonElement | undefined
  const newProject = () => { projects.setCreating(true); void navigate({ to: "/remote/projects" }) }
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
  let reread: string | undefined
  const usageDevice = () => { const deviceID = search().device_id; return view() === "/remote/usage" && typeof deviceID === "string" ? deviceID : undefined }
  const [usageLanded, setUsageLanded] = createSignal<string>()
  const [activation, setActivation] = createSignal(0)
  const ownsUsageRoute = () => usageDevice() === undefined || usageDevice() === usageLanded()
  const landOnMachine = (deviceID: string, landing: string, copy: { readonly unavailable: string; readonly offline: string }) => {
    const device = state().devices.find((item) => item.id === deviceID)
    if ((device?.status !== "active" || !device.online) && deviceID !== state().activeDeviceID && reread !== landing) {
      reread = landing
      untrack(() => { void remote.store.load() })
      return false
    }
    if (device === undefined || device.status !== "active") { setRouteError(copy.unavailable); return false }
    if (!device.online) { setRouteError(copy.offline); return false }
    if (deviceID !== state().activeDeviceID) { untrack(() => remote.store.connect(deviceID)); return false }
    return true
  }
  createEffect(() => {
    const target = requested()
    const usage = usageDevice()
    const attempt = activation()
    setRouteError(undefined)
    if (usage !== undefined) {
      if (state().owner === undefined || usage === usageLanded()) return
      const copy = { unavailable: "The machine for this Usage link is unavailable to this account.", offline: "The machine for this Usage link is offline. Reconnect that machine to open its Usage." }
      if (!isAlertDeviceID(usage)) setRouteError(copy.unavailable)
      else if (landOnMachine(usage, JSON.stringify([usage, attempt]), copy)) setUsageLanded(usage)
      return
    }
    setUsageLanded(undefined)
    if (target === undefined) {
      if (view() === "/remote/session" && search().session_id !== undefined) setRouteError("The Session link is invalid. Select a Session from Sessions.")
      return
    }
    if (state().owner === undefined) return
    if (target.deviceID !== undefined &&
      !landOnMachine(target.deviceID, JSON.stringify([target.deviceID, target.sessionID, target.noticeID, attempt]), {
        unavailable: "The machine for this Session is unavailable to this account.", offline: "The machine for this Session is offline. Reconnect that machine to open its Session." })) return
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
    companionTrigger?.focus({ preventScroll: true })
    const layer = teamLayer
    requestAnimationFrame(() => void Promise.allSettled(layer?.getAnimations().map((animation) => animation.finished) ?? []).then(() => { if (!teamOpen()) setTeamVisible(false) }))
  }
  const openTeam = () => {
    if (!teamOpen()) companionTrigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : teamTrigger
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
    setTeamEntering(true)
    setTeamVisible(true)
    setTeamOpen(true)
    teamLayer?.getBoundingClientRect()
    teamFrame = requestAnimationFrame(() => setTeamEntering(false))
    queueMicrotask(() => teamLayer?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }))
  }
  const openCompanion = (event: Event) => {
    if (!(event instanceof CustomEvent) || !["activity", "running", "changes", "context"].includes(event.detail)) return
    setCompanionTab(event.detail)
    openTeam()
  }
  window.addEventListener("ycoding:open-companion", openCompanion)
  onCleanup(() => window.removeEventListener("ycoding:open-companion", openCompanion))
  const dismissTeam = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !teamOpen() || phoneLayout()) return
    event.preventDefault()
    closeTeam()
  }
  document.addEventListener("keydown", dismissTeam)
  onCleanup(() => document.removeEventListener("keydown", dismissTeam))
  const openFromAlert = (value: unknown) => {
    const sessionID = Reflect.get(Object(value), "sessionID")
    const deviceID = Reflect.get(Object(value), "deviceID")
    const noticeID = Reflect.get(Object(value), "noticeID")
    if (typeof sessionID !== "string" || !isSessionID(sessionID)) return
    setActivation((count) => count + 1)
    void navigate({ to: "/remote/session", search: sessionSearch(sessionID, isAlertDeviceID(deviceID) ? deviceID : undefined, typeof noticeID === "string" && noticeSequence(noticeID) !== undefined ? noticeID : undefined) })
  }
  const openUsage = (deviceID: string) => {
    setActivation((count) => count + 1)
    void navigate({ to: "/remote/usage", search: { device_id: deviceID } })
  }
  const alertEvent = (event: Event) => openFromAlert(event instanceof CustomEvent ? event.detail : undefined)
  const workerMessage = (event: MessageEvent) => {
    const type = Reflect.get(Object(event.data), "type")
    if (type === "ycoding:open-session") openFromAlert(event.data)
    if (type === "ycoding:open-usage") {
      const deviceID = Reflect.get(Object(event.data), "deviceID")
      if (isAlertDeviceID(deviceID)) openUsage(deviceID)
    }
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
    window.dispatchEvent(new Event("ycoding:composer-expand"))
    if (office.presentation() === "office") office.present("conversation")
    if (view() !== "/remote/session") void navigate({ to: "/remote/session", search: sessionSearch(sessionID, state().activeDeviceID) })
    focusComposerField()
  }
  const paletteHandlers: Omit<PaletteHandlers, "openTeam"> = {
    go: (target) => {
      if (target === "new") { openNewSession(); return }
      if (target === "session") {
        const sessionID = state().activeSessionID
        if (sessionID !== undefined) void navigate({ to: "/remote/session", search: sessionSearch(sessionID, state().activeDeviceID) })
        return
      }
      void navigate({ to: `/remote/${target}` })
    },
    openSession,
    draft: prefillComposer,
    connectProvider: (target, returnFocus) => setProviderConnect({ target, returnFocus, deviceID: state().activeDeviceID, generation: state().generation }),
    dotsConnection: setDotsConnection,
  }
  createEffect(() => {
    const current = providerConnect()
    if (current && (current.deviceID !== state().activeDeviceID || current.generation !== state().generation)) setProviderConnect(undefined)
  })
  const paletteSessionSelected = () => selected() && (view() !== "/remote/session" || (ownsSessionDevice() && ownsSessionRoute()))
  const teamView = () => <TeamView
    data={() => state().team!} currentSessionID={state().activeSessionID ?? ""} now={Date.now} sheet={true}
    onClose={closeTeam} onOpen={openFromTeam} onCancel={remote.store.cancelSubagent} onAnswer={remote.store.answerSubagent} onPin={remote.store.pinSubagent} onContinueRecovery={remote.store.continueRecovery}
    onLoadOlder={remote.store.loadMoreTeam} onViewShell={remote.store.teamShellOutput} onKillShell={remote.store.killTeamShell}
    onOpenSideChat={openFromTeam} onCreateSideChat={remote.store.createSideChat} onLoadOlderSideChats={remote.store.loadMoreSideChats} />
  const contextWindow = () => state().view?.contextWindow
  const companionSummary = () => sessionCompanionSummary(state().view, activeSession()?.model)
  const goalLabel = () => state().view?.autonomy === undefined ? "Unreported" : state().view?.autonomy?.goal?.status === "active" ? "Active" : state().view?.autonomy?.goal ? "Stopped" : "Off"
  const teamContent = () => <SharedCompanionSurface
    runningContent={<RunningExecution data={() => state().team!} onOpen={openSession} />}
    active={companionTab()} onSelect={setCompanionTab} headerActions={<><button type="button" class="companion__pill" onClick={() => { closeTeam(); prefillComposer("/goal ") }}>Goal · {goalLabel()}</button><button type="button" class="companion__pill" onClick={requestAutonomousDialog}>{companionSummary()?.autonomyLabel ?? "Autonomy unreported"}</button><Show when={!phoneLayout()}><button type="button" class="companion__close" aria-label="Close Session companion" onClick={closeTeam}><Icon name="close" size={16} /></button></Show></>} beforeTabs={<><SessionStatusDetails /><Show when={phoneLayout()}><button type="button" class="button button--secondary companion__back" onClick={closeTeam}>Back to chat</button></Show></>} activitySubtitle={<>{state().view?.status ?? "Status unreported"} · {activeDeviceName()} · {activeSession()?.directory ? sessionProjectLabel(activeSession() ?? {}) : "No workspace selected"}</>} onRefresh={() => void remote.store.loadTeamControls()} activityContent={<>{teamView()}<Show when={state().view?.capturedChanges?.length}><button type="button" class="button button--secondary button--small" onClick={() => setCompanionTab("changes")}>Changes</button></Show></>} changesContent={<><Show when={state().view?.capturedChanges?.length} fallback={<p>No captured changes reported for this Session.</p>}><FileChangeCard inCompanion files={() => state().view?.capturedChanges ?? []} /></Show><p>Machine-local Git changes are managed on the enrolled machine.</p></>} contextContent={<SharedContextBreakdownPanel used={companionSummary()?.contextUsed} capacity={companionSummary()?.contextCapacity} label={companionSummary()?.contextLabel} fraction={companionSummary()?.contextFraction} remaining={contextWindow() ? Math.max(0, contextWindow()!.limit - contextWindow()!.used) : undefined} stepDiagnostics={contextWindow()?.stepDiagnostics} modelLabel={contextWindow() ? `${contextWindow()!.model.providerID} · ${contextWindow()!.model.id}` : undefined} nearLimit={contextWindow() ? contextWindow()!.used / contextWindow()!.limit >= 0.88 : false} breakdown={contextWindow()?.breakdown} contextMessagesLabel="Loaded transcript messages" contextMessages={state().view === undefined ? undefined : transcriptContextMessages(state().view!.messages)} onOpenUsage={() => { const deviceID = state().activeDeviceID; if (deviceID) openUsage(deviceID); else void navigate({ to: "/remote/usage" }) }} onCompact={() => void remote.store.compactSession()} compactDisabled={!canCreateSession() || managedChild()} />} />

  const teamPanel = () => <Show when={(phoneLayout() ? teamOpen() : teamVisible()) && view() === "/remote/session" && state().team !== undefined && selected()}>
    <aside id="session-companion-panel" ref={teamLayer} class={`${phoneLayout() ? "team-control__phone" : "team-control__panel"}${teamEntering() ? " team-control--entering" : ""}${!teamOpen() ? " team-control--exiting" : ""}`} aria-label="Session companion" aria-hidden={!teamOpen() || teamClosing() ? "true" : undefined} inert={!teamOpen() || teamClosing()}
      onClick={(event) => { if (phoneLayout() && event.target === teamLayer?.querySelector("dialog.team-view__sheet")) closeTeam() }}>
      {phoneLayout() ? <Show when={teamGeneration()} keyed>{(generation) => <Modal class="overlay--sheet team-view__sheet" label="Team" header={<span>Session companion</span>} returnFocus={companionTrigger ?? teamTrigger!} requestClose={(close) => { closeTeamSheet = close }}
        onDismiss={() => setTeamClosing(true)} onClose={() => {
          if (teamGeneration() !== generation) return
          closeTeamSheet = undefined
          setTeamOpen(false)
          setTeamClosing(false)
        }}>{teamContent()}</Modal>}</Show> : teamContent()}
    </aside>
  </Show>

  return (
    <Show when={entry() === "workspace"} fallback={<SignInScreen />}>
      <div ref={bindKeyboardChrome} class={`app app--${viewClass()}${view() === "/remote/session" && selected() && ownsSessionDevice() ? " app--selected" : view() === "/remote" ? " app--empty" : ""}${view() === "/remote/session" && managedChild() ? " app--managed-child" : ""}${view() === "/remote/session" && selectedLoading() ? " app--selected-loading" : ""}${railCollapsed() ? " app--rail-collapsed" : ""}${officeShown() ? " app--office" : ""}${showNewSession() ? " app--new-session" : ""}${teamVisible() && !phoneLayout() && view() === "/remote/session" && selected() ? " app--team-open" : ""}`}>
        <a class="skip-link" href="#remote-main">Skip to content</a>
        <SharedWorkspaceFrame railHeader={<Link to="/" class="brand"><BrandMark compact /></Link>} newChat={<div class="workspace__rail-actions">
            <button type="button" class="workspace__new-chat" aria-keyshortcuts="Meta+N Control+N" disabled={!canCreateSession()} onClick={() => openNewSession()}><Icon name="plus" size={14} /><span>New chat</span></button>
            <Show when={railCollapsed()} fallback={<button ref={railCollapse} type="button" class="session-panel__collapse" aria-label="Hide workspace sidebar" aria-expanded="true" aria-controls="session-rail" onClick={collapseRail}><Icon name="panel-left" size={16} /></button>}>
              <button ref={railExpand} type="button" class="session-panel__collapse workspace__rail-expand" aria-label="Show workspace sidebar" aria-expanded="false" aria-controls="session-rail" onClick={expandRail}><Icon name="panel-left" size={16} /></button>
            </Show>
          </div>} railBodyRef={(element) => { rail = element }} railBodyInert={railCollapsed()} railBody={<>
            <Show when={view() === "/remote/projects" || projectContext()}>
              <ProjectsRail data={projects} onNew={newProject} />
            </Show>
            <Show when={(composition().showSessionRail || view() === "/remote") && !projectContext()}>
              <SessionPanel onSelectSession={openSession} />
            </Show>
            <Show when={view() === "/remote/sessions"}><WorkspaceNav /></Show>
          </>} railNavigation={<><PrimaryNav view={view()} /><ResumeSession view={view()} /></>} topHeader={<Show when={view() !== "/remote/session"}><RemoteHeader
          navExpanded={navOpen() && !navClosing()}
          onOpenNav={openSessionsNavigation}
          onOpenSession={openSession}
          onOpenUsage={openUsage}
          onNewChat={() => openNewSession()}
          palette={{ canCreateSession: canCreateSession(), sessionSelected: paletteSessionSelected(), managedChild: managedChild(), workspaceID: newSessionWorkspaceID(), modelBinding: paletteModel(), handlers: paletteHandlers }}
          team={view() === "/remote/session" && selected() && ownsSessionDevice() ? {
            count: state().team === undefined ? undefined : teamActiveCount(state().team!),
            activity: state().team === undefined ? "Activity unreported" : teamActivityLabel(state().team!),
            expanded: teamOpen() && !teamClosing(),
            loading: selectedLoading(),
            ref: (element) => { teamTrigger = element },
            onOpen: openTeam,
          } : undefined}
          view={view()}
        /></Show>} connectionStrip={<ConnectionStrip />} workspaceClass={`workspace${projectContext() ? " workspace--project" : ""}`} workspaceAside={<Show when={projectContext()}>{(context) => <aside class="project-desktop"><ProjectPanel data={projects} project={context().detail} /></aside>}</Show>} companion={teamPanel()}>
            <Show when={view() === "/remote/session" && selected() && ownsSessionDevice()}>
              <SharedConversationHeader class={`workspace__topbar${projectContext() ? " project-topbar" : ""}`} hidden={selectedLoading()} title={<strong>{activeSession()?.title ?? noSessionTitle}</strong>} subtitle={<>{activeSession()?.directory ? sessionProjectLabel(activeSession() ?? {}) : "No workspace selected"} · {activeDeviceName()}</>} breadcrumb={<Link to="/remote/sessions" class="conversation-back button button--ghost button--icon" ariaLabel="Back to Sessions"><Icon name="arrow-left" /></Link>} middle={<><Show when={!phoneLayout() && office.presentation() === "office"}><PresentationSwitch value={office.presentation()} attention={(state().view?.requests.length ?? 0) > 0} onChange={office.present} /></Show><KeepAwakeIndicator /></>} menu={<button type="button" class="button button--ghost button--icon app-header__menu" aria-label="Open sessions" aria-expanded={navOpen() && !navClosing()} onClick={(event) => openSessionsNavigation(event.currentTarget)}><Icon name="menu" /></button>} actions={<><Show when={!projectContext()}><SharedContextRingButton class="companion-context-trigger" ariaLabel="Open Session context" ariaDescription={contextWindowDisplay(state().view, activeSession()?.model)?.tokens} ariaControls="session-companion-panel" expanded={teamOpen() && companionTab() === "context"} fraction={contextWindowDisplay(state().view, activeSession()?.model)?.fraction} label={contextWindowDisplay(state().view, activeSession()?.model) ? `${Math.round(contextWindowDisplay(state().view, activeSession()?.model)!.fraction * 100)}%` : "—"} onClick={() => { setCompanionTab("context"); openTeam() }} /></Show><span class="remote-connection"><span class={`status-dot status-dot--${summarizeConnection(state().connection).tone}`} aria-hidden="true" /><span class="remote-connection-label">{connectionLabel(state().connection, state().transport)}</span></span><NewSessionButton newChat disabled={!canCreateSession()} onClick={() => openNewSession()} /><button ref={teamTrigger} type="button" class="button button--ghost button--icon app-header__team" aria-label="Open Team" aria-controls="session-companion-panel" aria-expanded={teamOpen() && !teamClosing()} onClick={openTeam}><Icon name="team" /></button><CommandPalette view={view()} canCreateSession={canCreateSession()} sessionSelected={paletteSessionSelected()} managedChild={managedChild()} workspaceID={newSessionWorkspaceID()} modelBinding={paletteModel()} hasTeam={true} handlers={{ ...paletteHandlers, openTeam }} /><NotificationCenter onOpenSession={openSession} onOpenUsage={openUsage} /></>}>
                {projectContext() ? <Show when={projectContext()}>{(context) => <>
                  <div class="project-heading"><div><Link to="/remote/projects" class="text-link">Projects</Link><h1>{context().role === "master" ? context().detail.name : activeSession()?.title}</h1><div class="project-actions"><ProjectStatus project={context().detail} /><span class="project-meta">Master: {context().detail.master.title}</span></div></div><div class="project-actions"><ProjectFreshness data={projects} /><button class="button button--ghost button--small" disabled={projects.query().isFetching} onClick={projects.refresh}>Refresh</button><button ref={projectTrigger} class="button button--secondary button--small project-phone" aria-haspopup="dialog" onClick={() => setProjectSheet(true)}>Sessions {context().detail.members.length + 1}</button></div></div>
                  <div class="project-context"><span class={`project-badge${context().role === "master" ? " project-badge--master" : ""}`}>{context().role === "master" ? "Master" : "Member"}</span><strong>{context().role === "master" ? "Master" : "Member"} of {context().detail.name}</strong><Show when={context().role === "member"}><span>· master {context().detail.master.title}</span><button class="text-link" onClick={() => openSession(context().detail.master.sessionID)}>Back to project chat</button></Show><Show when={!context().detail.active}><span class="project-meta">Send a message in the Master chat to resume.</span></Show></div>
                </>}</Show> : undefined}
              </SharedConversationHeader>
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
                      <ConversationView active={!conversationHidden()} position={pendingAnchor()?.sessionID === state().activeSessionID ? pendingAnchor()?.position : undefined} onPositioned={() => setPendingAnchor(undefined)} canCreateSession={canCreateSession()} onNewSession={openNewSession} onOpenSession={openSession} />
                    </Show>
                  </RoutePanel>
                  <RoutePanel active={view() === "/remote" && firstInventoryLoading()}><LoadingPlaceholder kind="screen" label="Loading sessions…" /></RoutePanel>
                  <RoutePanel active={view() === "/remote" && showNewSession()} preserve={newSessionVisited()} onInteract={() => setNewSessionVisited(true)}><For each={showNewSession() || newSessionVisited() ? [state().activeDeviceID] : []}>{() => <NewSessionComposer registerPaletteModel={registerPaletteModel} workspaceID={originWorkspaceID()} onCreated={openCreatedSession} onWorkspaceChange={setNewSessionWorkspaceID} />}</For></RoutePanel>
                  <RoutePanel active={view() === "/remote/session" && routeError() !== undefined}><p class="notice-strip" role="alert">{routeError()}</p></RoutePanel>
                  <RoutePanel active={view() === "/remote/session" && officeShown() && selected()}><OfficePresentation office={office} onSelectSession={openSession} /></RoutePanel>
                  <RoutePanel active={view() === "/remote/sessions"}>
                    <SessionsPage
                      project={sessionProject}
                      canCreateSession={canCreateSession()}
                      onNewSession={() => openNewSession()}
                      onNewWorkspaceSession={() => openNewSession("sessions")}
                      onSelectSession={openSession}
                    />
                  </RoutePanel>
                  <RoutePanel active={view() === "/remote/projects"}><ProjectsPage data={projects} /></RoutePanel>
                  <RoutePanel active={view() === "/remote/workspaces"}><WorkspacesPage /></RoutePanel>
                  <RoutePanel active={view() === "/remote/usage" && routeError() !== undefined}><p class="notice-strip" role="alert">{routeError()}</p></RoutePanel>
                  <RoutePanel active={view() === "/remote/usage" && routeError() === undefined && ownsUsageRoute()}><UsagePage /></RoutePanel>
                  <RoutePanel active={view() === "/remote/settings"}><SettingsPage office={office} phoneLayout={phoneLayout()} /></RoutePanel>
                </>}>
                <LoadingPlaceholder kind="screen" label="Checking account and connecting to machine…" />
                <Show when={view() === "/remote/settings"}>
                  <div class="pane settings"><AccountSettings /></div>
                </Show>
              </Show>
              <div class="conversation-metadata" ref={setComposerMetadataMount} />
            </div>
            <div class="conversation-jump-slot" ref={jumpSlot} />
            <Show when={view() === "/remote/sessions" && jumpSlot}>{(slot) => <SessionsTopAnchor slot={slot()} scroll={() => scrollHost} />}</Show>
            <Show when={composition().showComposer && !officeShown() && !newSessionOpen()}>
              <TodoPanel todos={state().todos} />
            </Show>
            <Show when={selected()}>
                <RoutePanel active={!managedChild() && (view() !== "/remote/session" || ownsSessionRoute())} preserve class="composer-resident"><Composer
                  registerPaletteModel={registerPaletteModel}
                  sessionID={composerSessionID()}
                  companionContextOpen={teamOpen() && companionTab() === "context"}
                  onOpenContext={() => { setCompanionTab("context"); openTeam() }}
                  metadataMount={!conversationHidden() && !managedChild() && !selectedLoading() ? composerMetadataMount() : undefined}
                  running={state().view?.status === "running"}
                  sendDisabled={!boundPlacement(state().selectedSessionInfo?.scope, state().view?.scope)}
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
                    economics={{ speed: generationSpeedDisplay(state().view, state().view?.model), accounting: currentTask()?.accounting, accountingUnavailable: currentTask()?.accountingUnavailable, accountingUnsupported: state().team?.accountingUnsupported, tokens: currentTask()?.tokens, cost: currentTask()?.cost, cacheHitRatio: currentTask()?.cacheHitRatio,
                      cacheRead: currentTask()?.cacheRead, cacheWrite: currentTask()?.cacheWrite, contextTotal: currentTask()?.contextTotal, contextLimit: currentTask()?.contextLimit }}
                    question={currentTask()?.question?.deferred === true ? undefined : currentTask()?.question}
                    onAnswer={(questionID, text) => remote.store.answerSubagent(activeSession()?.id ?? "", questionID, text)}
                    previousID={siblingNavigation().previous} nextID={siblingNavigation().next}
                    onMain={() => { if (childParentID()) openSession(childParentID()!) }}
                  onPrevious={() => { if (siblingNavigation().previous) openSession(siblingNavigation().previous!) }}
                  onNext={() => { if (siblingNavigation().next) openSession(siblingNavigation().next!) }} />
                </RoutePanel>
            </Show>
        </SharedWorkspaceFrame>
        <Show when={projectSheet() && projectContext()}>{(context) => <Modal class="overlay--sheet project-sheet" label={context().detail.name} returnFocus={projectTrigger!} onClose={() => setProjectSheet(false)}><ProjectPanel data={projects} project={context().detail} onManage={() => {
          setProjectSheet(false)
          return projectTrigger
        }} /></Modal>}</Show>
        <ProjectsDialogs data={projects} />

        <Show when={providerConnect()}>{(connection) => <ProviderConnect target={connection().target} returnFocus={connection().returnFocus} onClose={() => setProviderConnect(undefined)} onConnected={() => { void remote.store.loadCatalog(connection().target, { refresh: true }) }} />}</Show>
        <Show when={dotsConnection()}>{(returnFocus) => <DotsConnection returnFocus={returnFocus()} onClose={() => setDotsConnection(undefined)} />}</Show>
        <BottomNav view={view()} />

        <ToastLayer sessionID={composerSessionID()} onOpenSession={openSession} />

        <Show when={navOpen() ? navGeneration() : undefined} keyed>
          {(generation) => <Modal class="overlay--slideover overlay--sessions-sheet" label="Sessions" returnFocus={navTrigger!} requestClose={(close) => { closeSessionsSheet = close }} onDismiss={() => setNavClosing(true)} onClose={() => {
            if (navGeneration() !== generation) return
            closeSessionsSheet = undefined
            setNavClosing(false)
            setNavOpen(false)
          }}>
            <SessionPanel onSelectSession={openSession} onNavigate={closeNav} />
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
      <header class="sign-in__bar">
        <Link to="/" class="brand" title="YCoding home">
          <BrandMark compact />
        </Link>
        <ThemeToggle />
      </header>
      <div class="sign-in__panel">
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
        <div class="sign-in__or" aria-hidden="true"><span>or</span></div>
        <form class="field" onSubmit={(event) => void signInWithKey(event)}>
          <label class="field__label" for="remote-access-key">Access key</label>
          <input id="remote-access-key" class="input" value={accessKey()} onInput={(event) => setAccessKey(event.currentTarget.value)}
            autocomplete="off" spellcheck={false} autocapitalize="characters" aria-invalid={keyError() ? "true" : undefined} />
          <Show when={keyError()}><p class="sign-in__error" role="alert"><Icon name="alert" size={16} /><span>{keyError()}</span></p></Show>
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
  readonly onOpenUsage: (deviceID: string) => void
  readonly onNewChat: () => void
  readonly palette: {
    readonly canCreateSession: boolean
    readonly sessionSelected: boolean
    readonly managedChild: boolean
    readonly workspaceID?: string
    readonly modelBinding?: PaletteModelBinding
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
          <button type="button" class="button button--ghost button--icon app-header__new-chat" aria-label="New chat" title="New chat" disabled={!props.palette.canCreateSession} onClick={props.onNewChat}><Icon name="plus" /></button>
          <CommandPalette
            view={props.view}
            canCreateSession={props.palette.canCreateSession}
            sessionSelected={props.palette.sessionSelected}
            managedChild={props.palette.managedChild}
            workspaceID={props.palette.workspaceID}
            modelBinding={props.palette.modelBinding}
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
              aria-controls="session-companion-panel"
              aria-hidden={team().loading ? "true" : undefined}
              inert={team().loading}
              onClick={team().onOpen}
            >
              <Icon name="team" />
              <span class="app-header__team-count">{team().activity.startsWith("At least") ? "≥" : ""}{team().count ?? "—"}</span>
            </button>
          )}</Show>
          <NotificationCenter onOpenSession={props.onOpenSession} onOpenUsage={props.onOpenUsage} />
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
      <Show when={telemetryConsentNoticeView(state().telemetryConsent, state().transport.kind === "open" && state().connection.kind === "connected")}>
        <section class="telemetry-consent" aria-labelledby="telemetry-consent-title">
          <Icon name="usage" size={18} />
          <div class="telemetry-consent__body"><h2 id="telemetry-consent-title">Help improve YCoding</h2>
            <p>Save usage, speed, and latency for each provider, model, and profile on this machine only. Nothing leaves your machine. You can change this anytime in Settings → Diagnostics.</p></div>
          <div class="telemetry-consent__actions">
            <button type="button" class="button button--primary button--small" onClick={() => void remote.store.setTelemetryConsent(true)}>Agree</button>
            <button type="button" class="button button--secondary button--small" onClick={() => void remote.store.setTelemetryConsent(false)}>Not now</button>
          </div>
        </section>
      </Show>
      <Show when={state().telemetryConsent.error}>
        {(error) => <p class="notice-strip notice-strip--warning" role="alert"><Icon name="alert" size={16} /><span class="notice-strip__body">{error()}</span></p>}
      </Show>
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
  readonly onSelectSession: (sessionID: string) => void
  readonly onNavigate?: () => void
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  let feed: HTMLDivElement | undefined
  let feedRows: ReturnType<typeof createRowVirtualizer> | undefined
  let detachFeed = () => {}
  onMount(() => { if (feed) detachFeed = attachSessionFeed(feed, remote.store, () => feedRows) })
  onCleanup(() => detachFeed())
  const cached = () => cachedSessionsView(state().connection, state().sessions.length)
  const counts = () => sessionFilterCounts(state().sessions, state().view, state().sessionFilter)
  return (
    <div class="pane session-panel" ref={feed}>
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
                  <SessionRailList sessions={state().sessions} readOnly onSelectSession={props.onSelectSession} onVirtualizer={(rows) => { feedRows = rows }} />
                </>
              )}
            </Show>
          </>
        }
      >
        <Show when={state().sessionGroups.length > 0 || state().sessionListStatus === "loading"} fallback={<NoSessionsState />}>
          <label class="field session-search">
            <Icon name="search" size={14} class="session-search__icon" />
            <input
              class="input"
              type="search"
              aria-label="Search sessions"
              placeholder="Search sessions"
              value={state().sessionQuery}
              disabled={state().transport.kind !== "open" || cached() !== undefined}
              onInput={(event) => remote.store.searchSessions(event.currentTarget.value)}
            />
          </label>
          <div class="session-filters" role="group" aria-label="Session status">
            <For each={sessionFilters}>{(value) => {
              const label = `${value[0]?.toUpperCase()}${value.slice(1)}`
              return <button type="button" class={`session-filters__option${state().sessionFilter === value ? " session-filters__option--active" : ""}`} aria-label={counts()[value] === undefined ? undefined : `${label} ${counts()[value]}`} aria-pressed={state().sessionFilter === value} disabled={state().transport.kind !== "open" || cached() !== undefined} onClick={() => remote.store.searchSessions(state().sessionQuery, value)}>{label}<Show when={counts()[value] !== undefined}><span class="session-filters__count">{counts()[value]}</span></Show></button>
            }}</For>
          </div>
          <Show when={state().sessionListNotice}>{(notice) => <p class="panel__note" role="status" aria-label="Session list status">{notice()}</p>}</Show>
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
              onVirtualizer={(rows) => { feedRows = rows }}
              sessions={state().sessionFilter === "all" ? prioritizePanelSessions(state().sessions, state().view) : state().sessions}
              readOnly={state().sessionRowsStale === true}
              busy={state().sessionRowsStale === true}
              onSelectSession={props.onSelectSession}
              onNavigate={props.onNavigate}
            />
          </Show>
          <Show when={state().sessionPaginationLoading}><LoadingPlaceholder kind="session" label="Loading more sessions…" /></Show>
        </Show>
      </Show>
    </div>
  )
}

type SessionProjectLookup = (id: string) => { readonly role: "master" | "member"; readonly name: string } | undefined

function SessionRailList(props: {
  readonly sessions: readonly SessionInfoView[]
  readonly readOnly: boolean
  readonly busy?: boolean
  readonly onSelectSession: (sessionID: string) => void
  readonly onNavigate?: () => void
  readonly onVirtualizer: (rows: ReturnType<typeof createRowVirtualizer>) => void
}): JSX.Element {
  let list: HTMLDivElement | undefined
  let scroller: HTMLElement | undefined
  const groups = createMemo(() => groupRailSessions(props.sessions))
  const keys = createMemo(() => groups().flatMap((group) => [`section:${group.label}`, ...group.sessions.map((session) => session.id)]), [], { equals: sameKeys })
  const byID = createMemo(() => new Map(props.sessions.map((session) => [session.id, session])))
  const rows = createRowVirtualizer({
    list: () => list,
    scroller: () => scroller ??= list ? scrollParent(list) : undefined,
    keys,
    estimate: () => 36,
    typicalSize: true,
    overscan: 6,
    layout: () => keys().length > 0,
  })
  onMount(() => props.onVirtualizer(rows))
  return (
    <div ref={list} class="session-list" role="list" aria-busy={props.busy === true} style={{ "block-size": `${rows.virtualizer.getTotalSize()}px` }}>
      <For each={rows.rendered()}>
        {(id) => {
          const row = rows.row(id)
          return (
            <Show when={!id.startsWith("section:")} fallback={<div class="session-list__row session-list__group" role="presentation" data-index={row.index()} style={{ "inset-block-start": `${row.top()}px` }} ref={row.measure}>{id.slice(8)}</div>}>
              <div class="session-list__row" role="listitem" aria-posinset={keys().slice(0, row.index() + 1).filter((key) => !key.startsWith("section:")).length} aria-setsize={props.sessions.length} data-index={row.index()} style={{ "inset-block-start": `${row.top()}px` }} ref={row.measure}>
                <SessionRow session={byID().get(id)!} readOnly={props.readOnly} onSelectSession={props.onSelectSession} onNavigate={props.onNavigate} />
              </div>
            </Show>
          )
        }}
      </For>
    </div>
  )
}

function SessionTableRows(props: {
  readonly project: SessionProjectLookup
  readonly sessions: readonly SessionInfoView[]
  readonly readOnly: boolean
  readonly onSelectSession: (sessionID: string) => void
  readonly onVirtualizer: (rows: ReturnType<typeof createRowVirtualizer>) => void
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
  onMount(() => props.onVirtualizer(rows))
  return (
    <div ref={body} class="sessions-table__body" role="rowgroup" style={{ "block-size": `${rows.virtualizer.getTotalSize()}px` }}>
      <For each={rows.rendered()}>
        {(id) => {
          const row = rows.row(id)
          return <SessionSummaryRow project={props.project} session={byID().get(id)!} readOnly={props.readOnly} onSelectSession={props.onSelectSession} rowIndex={row.index() + 2} top={row.top()} measure={row.measure} />
        }}
      </For>
    </div>
  )
}

function SessionPin(props: { readonly session: SessionInfoView; readonly disabled?: boolean }): JSX.Element {
  const remote = useRemote()
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const pinned = () => props.session.pinnedAt !== undefined
  const label = () => `${pinned() ? "Unpin" : "Pin"} ${props.session.title}`
  return <span class="session-pin">
    <button type="button" class="session-pin__button" aria-label={label()} title={label()} aria-pressed={pinned()} disabled={props.disabled || pending()} onClick={async () => {
      setPending(true)
      setError("")
      const result = await remote.store.pinSession(props.session.id, !pinned())
      if (result.status !== "ok") setError(result.message)
      setPending(false)
    }}><Icon name="pin" size={16} /></button>
    <Show when={error()}>{(message) => <span role="alert" class="session-pin__error">{message()}</span>}</Show>
  </span>
}

function SessionRow(props: {
  readonly session: SessionInfoView
  readonly readOnly?: boolean
  readonly onSelectSession: (sessionID: string) => void
  readonly onNavigate?: () => void
}): JSX.Element {
  const remote = useRemote()
  const active = () => remote.state().activeSessionID === props.session.id || remote.state().selectedSessionInfo?.parentID === props.session.id
  const signal = () => sessionRowSignal(props.session, remote.state().view)
  const signalGlyph = (): IconName | undefined => signal().kind === "failed" ? "alert" : signal().kind === "waiting" ? "hand" : undefined
  return (
    <button
      type="button"
      class={`session-row${active() ? " session-row--active" : ""}`}
      data-session-id={props.session.id}
      aria-pressed={active()}
      disabled={props.readOnly}
      onClick={() => {
        props.onSelectSession(props.session.id)
        props.onNavigate?.()
      }}
    >
      <span class="session-row__signal" data-signal={signal().kind}>
        <Show when={signalGlyph()} fallback={<span class="session-row__signal-mark" aria-hidden="true" />}>{(name) => <Icon name={name()} size={16} class="session-row__signal-mark" />}</Show>
        <Show when={signal().label}>{(label) => <span class="visually-hidden">{label()}</span>}</Show>
      </span>
      <span class="session-row__name">{props.session.title}</span>
      <Show when={signal().kind === "waiting"}><span class="session-row__state" aria-hidden="true">Waiting</span></Show>
    </button>
  )
}

function SessionSummaryRow(props: {
  readonly project: SessionProjectLookup
  readonly session: SessionInfoView
  readonly readOnly?: boolean
  readonly onSelectSession: (sessionID: string) => void
  readonly rowIndex: number
  readonly top: number
  readonly measure: (element: HTMLElement) => void
}): JSX.Element {
  const remote = useRemote()
  const summary = () => summarizeSession(props.session, remote.state().view, props.project(props.session.id))
  const chips = () => sessionChips(props.session, remote.state().view, props.project(props.session.id))
  return (
    <div class="sessions-table__row" role="row" aria-rowindex={props.rowIndex} data-session-id={props.session.id} data-index={props.rowIndex - 2} style={{ "inset-block-start": `${props.top}px` }} ref={props.measure}>
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
        <For each={chips().filter((chip, index) => index === 0 || chip.label.startsWith("review ") || chip.label.startsWith("Master · ") || chip.label.startsWith("Member · "))}>{(chip) => <Chip label={chip.label} tone={chip.tone} />}</For>
        <Show when={chips().length === 0}><Chip label="Idle" tone="neutral" /></Show>
        <SessionPin session={props.session} disabled={props.readOnly} />
      </span>
      <span class="sessions-table__updated" role="cell">
        {summary().updatedAt === undefined ? "Not reported" : new Date(props.session.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
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
        devices: remote.state().devices.map((device) => ({ ...device, name: remote.deviceName(device) })),
        activeDeviceID: remote.state().activeDeviceID,
        sessionCount: remote.state().sessions.length,
        unreachable: remote.state().connection.kind === "offline",
      },
    )
}

function NoSessionsState(): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const availability = () => sessionAvailabilityView(state().connection, state().sessions.length, state().sessionListStatus, {
    filtered: state().sessionQuery !== "" || state().sessionFilter !== "all",
    inventoryFailed: state().sessionGroups.length === 0 && state().carouselStatus === "error",
  })
  return (
    <div class="empty">
      <p class="empty__title">{availability()?.title ?? (state().sessionQuery || state().sessionFilter !== "all" ? "No matching sessions" : "No sessions")}</p>
      <p>{availability()?.body ?? (state().sessionQuery || state().sessionFilter !== "all" ? "No matching sessions in this workspace." : "Start YCoding in your project folder on this machine.")}</p>
      <Show when={availability()?.note}>{(note) => <p class="panel__note">{note()}</p>}</Show>
      <Show when={availability()?.retryable}><button type="button" class="button button--secondary" disabled={state().transport.kind !== "open"} onClick={() => remote.store.refreshSessions()}>Refresh sessions</button></Show>
    </div>
  )
}

function ConversationView(props: {
  readonly active: boolean
  readonly position?: TranscriptPosition
  readonly onPositioned: () => void
  readonly canCreateSession: boolean
  readonly onNewSession: () => void
  readonly onOpenSession: (sessionID: string) => void
}): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const view = () => state().view
  const requests = () => view()?.requests ?? []
  const messages = () => view()?.messages ?? []
  const childQuestions = () => state().team?.status === "ready" && state().team?.rootID === state().activeSessionID
    ? state().team?.tasks.filter((task) => task.parentID === state().activeSessionID && task.state === "waiting" && task.question !== undefined && task.question.deferred !== true) ?? [] : []
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
          <TranscriptNavigation messages={messages} decisions={view()?.guardrailDecisions} active={props.active} position={props.position} onPositioned={props.onPositioned} />
        </Show>
        <div id="pending-requests" class="requests" tabindex="-1" aria-label="Pending requests">
          <PresenceList items={requests()} keyOf={(request) => request.id}>{(request) => <RequestCard request={request} activeSessionID={state().activeSessionID} />}</PresenceList>
        </div>
        <div class="requests" aria-label="Pending child questions">
          <PresenceList items={childQuestions()} keyOf={(task) => `${task.sessionID}:${task.question?.id}`}>{(task) => <article class="request request--form" data-child-question={task().question?.id}>
            <header class="request__header"><Icon name="chat" size={16} /><span>Question from {task().agent ?? "Subagent"}</span></header>
            <p class="request__body">{task().description}</p>
            <TeamAnswerForm question={task().question!} onAnswer={(id, text) => remote.store.answerSubagent(task().sessionID, id, text)} />
          </article>}</PresenceList>
        </div>
        <ReviewBox onOpenSession={props.onOpenSession} />
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
  readonly project: SessionProjectLookup
  readonly canCreateSession: boolean
  readonly onNewSession: () => void
  readonly onNewWorkspaceSession: () => void
  readonly onSelectSession: (sessionID: string) => void
}): JSX.Element {
  const remote = useRemote()
  let feed: HTMLDivElement | undefined
  let feedRows: ReturnType<typeof createRowVirtualizer> | undefined
  let detachFeed = () => {}
  onMount(() => { if (feed) detachFeed = attachSessionFeed(feed, remote.store, () => feedRows) })
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
              <For each={["all", "waiting", "running", "idle"] as const}>
                {(value) => (
                  <button
                    type="button"
                    class={`session-filters__option${remote.state().sessionFilter === value ? " session-filters__option--active" : ""}`}
                    aria-pressed={remote.state().sessionFilter === value}
                    disabled={remote.state().transport.kind !== "open" || cached() !== undefined}
                    onClick={() => remote.store.searchSessions(remote.state().sessionQuery, value)}
                  >
                    {value[0]?.toUpperCase()}{value.slice(1)} ({value === "all" ? sessions().length : sessions().filter((session) => value === "waiting" ? sessionNeedsAttention(session, remote.state().view) : value === "running" ? !sessionNeedsAttention(session, remote.state().view) && session.running === true : !sessionNeedsAttention(session, remote.state().view) && session.running !== true).length})
                  </button>
                )}
              </For>
            </div>
            <p class="panel__note">Showing {sessions().length} loaded · {sessions().filter((session) => session.pinnedAt !== undefined).length} pinned</p>
            <Show when={remote.state().sessionHasNext}><button type="button" class="button button--secondary button--small" disabled={remote.state().sessionPaginationLoading} onClick={() => void remote.store.nextSessionsPage()}>Load older Sessions</button></Show>
            <Show when={remote.state().sessionListNotice}>{(notice) => <p class="panel__note" role="status" aria-label="Session list status">{notice()}</p>}</Show>
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
                    project={props.project}
                    onVirtualizer={(rows) => { feedRows = rows }}
                    sessions={sessions()}
                    readOnly={cached() !== undefined || remote.state().sessionRowsStale === true}
                    onSelectSession={props.onSelectSession}
                  />
                </div>
              </div>
            </Show>
            <Show when={remote.state().sessionPaginationLoading}><LoadingPlaceholder kind="session" label="Loading more sessions…" /></Show>
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

function WorkspacesPage(): JSX.Element {
  const remote = useRemote()
  const connected = () => remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"
  const query = createRemoteQuery(remote.store.queryClient, () => remote.queries.workspaces(remote.scope(), connected()))
  const workspaces = () => query().data ?? []
  const labels = () => workspaceLabels(workspaces())
  return <section class="sessions-page workspaces-page" aria-label="Workspaces"><h1>Workspaces</h1><p>Repositories previously opened on the connected machine.</p><Show when={connected()} fallback={<p role="status">Connect to a machine to see its workspaces.</p>}><Show when={!query().isFetching || workspaces().length > 0} fallback={<p role="status">Loading workspaces…</p>}><Show when={!query().isError} fallback={<div role="alert"><p>{query().error?.message ?? "Workspaces could not be loaded."}</p><button type="button" class="button button--secondary" onClick={() => void query().refetch()}>Retry</button></div>}><Show when={workspaces().length > 0} fallback={<p>No previously opened workspaces are available.</p>}><ul class="workspace-nav__list"><For each={workspaces()}>{(workspace) => <li class="workspace-nav__item"><Icon name="folder" size={16} /><span><strong>{labels().get(workspace.id) ?? workspace.directory}</strong><span class="project-meta"> {workspace.directory}</span></span></li>}</For></ul></Show></Show></Show></Show></section>
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

function attachSessionFeed(element: HTMLDivElement, store: ReturnType<typeof useRemote>["store"], virtualRows: () => ReturnType<typeof createRowVirtualizer> | undefined) {
  const root = element.closest<HTMLElement>(".workspace__scroll, .workspace__rail-body") ??
    (document.scrollingElement instanceof HTMLElement ? document.scrollingElement : undefined)
  if (!root) return () => {}
  let direction = 0
  let gesture = false
  let lastTop = root.scrollTop
  let position: { readonly id: string; readonly offset: number } | undefined
  let resident = store.state().sessions
  let restore: number | undefined
  let revealed: { readonly rows: ReturnType<typeof createRowVirtualizer>; readonly id: string } | undefined
  const cancelRestore = () => {
    if (restore !== undefined) cancelAnimationFrame(restore)
    restore = undefined
    revealed?.rows.release(revealed.id)
    revealed = undefined
  }
  let context = `${store.state().activeDeviceID}:${store.state().selectedWorkspaceID}:${store.state().sessionQuery}:${store.state().sessionFilter}`
  const unsubscribe = store.subscribe(() => {
    const next = `${store.state().activeDeviceID}:${store.state().selectedWorkspaceID}:${store.state().sessionQuery}:${store.state().sessionFilter}`
    if (next === context) {
      if (resident === store.state().sessions || position === undefined) return
      resident = store.state().sessions
      cancelRestore()
      restore = requestAnimationFrame(() => {
        restore = undefined
        const anchor = position
        const rows = virtualRows()
        const index = anchor === undefined ? undefined : rows?.indexByKey().get(anchor.id)
        if (!anchor || !rows || index === undefined) return
        gesture = false
        direction = 0
        rows.reveal(anchor.id)
        revealed = { rows, id: anchor.id }
        const offset = rows.virtualizer.getOffsetForIndex(index, "start")
        if (offset !== undefined) rows.write(root, offset[0] - anchor.offset)
        restore = requestAnimationFrame(() => {
          restore = undefined
          const row = [...element.querySelectorAll<HTMLElement>("[data-session-id]")].find((row) => row.dataset.sessionId === anchor.id)
          if (row) rows.write(root, root.scrollTop + row.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset)
          rows.release(anchor.id)
          revealed = undefined
        })
      })
      return
    }
    context = next
    cancelRestore()
    position = undefined
    store.setSessionListAnchor(undefined)
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
    const bounds = root.getBoundingClientRect()
    const row = [...element.querySelectorAll<HTMLElement>("[data-session-id]")].find((row) => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom)
    position = row?.dataset.sessionId === undefined ? undefined : { id: row.dataset.sessionId, offset: row.getBoundingClientRect().top - bounds.top }
    store.setSessionListAnchor(position?.id)
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
    cancelRestore()
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
        <h1 class="page-head__title">Settings</h1>
      </div>
      <div class="pane" style={{ "padding-inline": "0" }}>
        <div class="settings st-ledger-settings">
          <MachineSettings />
          <AppearanceSettings />
          <NotificationSettings />
          <PermissionSettings />
          <AppSettings />
          <LatencySettings />
          <AccountSettings />
          <DeviceSettings />
          <Show when={!props.phoneLayout}><OfficeSettings office={props.office} /></Show>
          <ExternalNotificationSettings />
        </div>
      </div>
    </>
  )
}

const primaryDestinations: readonly { readonly view: RemoteView; readonly label: string; readonly icon: IconName }[] = WORKSPACE_DESTINATIONS.filter((item) => item.id === "sessions" || item.id === "usage" || item.id === "settings").map((item) => ({ view: item.route, label: item.label, icon: item.icon }))

function PrimaryNav(props: { readonly view: RemoteView }): JSX.Element {
  const attention = useNavigationAttention()
  return <nav class="remote-nav" aria-label="Remote workspace"><For each={WORKSPACE_DESTINATIONS}>{(item) => <Link
    to={item.route} class={`remote-nav__link remote-nav__link--${item.id}${workspaceDestination(props.view) === item.route ? " remote-nav__link--active" : ""}`}
    ariaCurrent={workspaceDestination(props.view) === item.route ? "page" : undefined}
    ariaLabel={item.id === "sessions" && attention().sessions ? "Sessions, waiting for your decision" : item.label}>
    <Icon name={item.icon} size={16} /><span class="remote-nav__label">{item.label}</span><AttentionMark show={item.id === "sessions" && attention().sessions} />
  </Link>}</For></nav>
}

function ResumeSession(props: { readonly view: RemoteView }): JSX.Element {
  const remote = useRemote()
  const attention = useNavigationAttention()
  return <Show when={props.view !== "/remote/session" ? remote.state().activeSessionID : undefined}>{(sessionID) => <Link
    to="/remote/session" search={() => sessionSearch(sessionID(), remote.state().activeDeviceID)} class="workspace-resume button button--ghost"
    ariaLabel={attention().conversation ? "Resume session, waiting for your decision" : "Resume session"}>
    <Icon name="arrow-left" /><span>Resume session</span><AttentionMark show={attention().conversation} />
  </Link>}</Show>
}

function BottomNav(props: { readonly view: RemoteView }): JSX.Element {
  const attention = useNavigationAttention()
  const flagged = (view: RemoteView) => view === "/remote/sessions" && attention().sessions
  return (
    <nav class="bottom-nav" aria-label="Workspace">
      <Link to="/remote" class="bottom-nav__new" ariaLabel="New chat" title="New chat"><Icon name="plus" /></Link>
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
