import { createRootRoute, createRoute, createRouter, createHashHistory, Link, Outlet, RouterProvider, useLocation, useNavigate } from "@tanstack/solid-router"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import type { YCodingEvent } from "@ycoding-ai/client"
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { ConnectionState, FormAnswer, FormRequest, Messages, PendingRequests, PermissionRequest, ComposerCatalog, PromptAgent, PromptFile, RequestReply, SessionItem, ModelSelection, ShellOutput, UsageRange, RevertInput, SetAutonomyInput, SettingsMutationInput, ProjectMutationInput, WorkspaceMutationInput, PinRequest } from "./contract"
import { desktop as api } from "./bridge"
import type { DesktopAPI, DesktopSource, IntegrationMutationInput, IntegrationAttempt, McpMutationInput, SessionManageInput, SystemManageInput, DisplayValue, Selection, UpdateCheckResult } from "./contract"
import { schemeStylesheet } from "../../../apps/web/src/theme/schemes"
import { Icon as WebIcon, type IconName as WebIconName } from "../../../apps/web/src/ui/icon"
import { Markdown } from "../../../apps/web/src/remote/ui/markdown"
import { WORKSPACE_DESTINATIONS, SharedWorkspaceFrame, SharedCompanionSurface, SharedConversationHeader, SharedMessageTurn, SharedComposerSurface, SharedContextRingButton, SharedContextBreakdownPanel, SharedTurnHead, SharedRadioGroup, SharedToolDisclosure, SharedReasoningDisclosure, SharedCompactionDivider, SharedEditedFilesCard, SharedActivitySurface, SharedChangesSurface, SharedPageSurface, SharedProjectsSurface, SharedSessionsSurface, SharedWorkspacesSurface, SharedUsageSurface, SharedSettingsSurface, SharedLoadingSkeleton } from "../../../apps/web/src/remote/ui/shared-workspace"
import { DESKTOP_THEMES, isDesktopThemeID, resolveDesktopTheme, DESKTOP_BUILT_IN_SLASH_COMMANDS, desktopSlashCommand, validateFolderSegment, formatSessionExportMarkdown, parsePromptStashes, pushPromptStash, formatQuotaProviders, formatCount, formatCompactCount, formatDurationMs, formatUsd, type DesktopThemeID, activeFields, appendPage, buildAnswer, chooseModel, chooseProfile, choiceFor, choiceProblem, composerTrigger, initialValues, insertCompletion, invalidIndexes, mentionPayload, modelLabel, pagedItems, pagingFor, problemOf, profileLabel, railGroups, restoresFocus, sameSelection, samePaging, searchTerm, selectionFor, slashAction, valueFor, variantsFor, visibleModels, withValue, workspaceBase, classifyDesktopSynthetic, visibleDesktopMessages, turnEditPlacements, groupAssistantParts, toolDisplaySummary, effortStopsFor, effortStopIndex, effortStopFraction, insertTextAtSelection, isEditableKeyboardTarget, isStandardEditShortcut, type Activity, type Field, type FocusAt, type MentionPick, type ModelChoice, type SlashAction, type Paging, type Value } from "./form-rules"
import { JumpControls, PromptRail, followState, jumpBehavior, navigationTargets, pillClearance, promptTicks, promptsInView, sameSet, type PromptTick } from "../../../apps/web/src/remote/ui/transcript-rail"
import "../../../apps/web/src/styles/tokens.css"
import "../../../apps/web/src/styles/workspace-shell.css"
import "./style.css"

type SessionRow = SessionItem
const extraIconPaths = { arc: ["M12 3a9 9 0 0 1 9 9"], more: ["M5 12a1 1 0 1 0 2 0 1 1 0 0 0-2 0", "M11 12a1 1 0 1 0 2 0 1 1 0 0 0-2 0", "M17 12a1 1 0 1 0 2 0 1 1 0 0 0-2 0"], clip: ["M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"] } as const
type DesktopIconName = WebIconName | keyof typeof extraIconPaths
type PaletteAction = { readonly id: string; readonly group: "Session" | "Model & Agent" | "Workspace & Git" | "Providers & MCP" | "Navigation" | "Customize" | "Settings" | "System"; readonly label: string; readonly detail?: string; readonly shortcut?: string; readonly icon: DesktopIconName; readonly keywords: string; readonly run: () => void }

const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } })
const noActivity: Activity = { busy: new Set(), waiting: new Map() }
const [connection, setConnection] = createSignal<ConnectionState>({ generation: 0, status: "idle" })
const connectionStatusLabel = () => connection().status === "connected" ? "Connected" : connection().status === "reconnecting" ? "Reconnecting" : connection().status === "error" ? "Backend error" : "Connecting"
const connectionOwnership = () => `${connectionStatusLabel()} · ${connection().mode === "own" ? "Private backend" : "Shared backend"}`
const [preferencesError, setPreferencesError] = createSignal<string>()
const [savedSelection, setSavedSelection] = createSignal<Selection>({ mode: "shared" })
const [savedSharedEndpoint, setSavedSharedEndpoint] = createSignal("")
const [updateTriggerTick, setUpdateTriggerTick] = createSignal(0)
const [reconnectingBackend, setReconnectingBackend] = createSignal(false)
const [backendActionError, setBackendActionError] = createSignal<string>()
let handledUpdateTick = 0
const [lastSessionID, setLastSessionID] = createSignal<string>()
const [activity, setActivity] = createSignal(noActivity)
const [failedSessions, setFailedSessions] = createSignal<ReadonlySet<string>>(new Set())
const [paletteOpen, setPaletteOpen] = createSignal(false)
type ThemePreference = DesktopThemeID
const [themePreference, setThemePreference] = createSignal<ThemePreference>("system")
const [desktopNotice, setDesktopNotice] = createSignal<string>()
const paintTheme = () => {
  const resolvedTheme = resolveDesktopTheme(themePreference(), window.matchMedia("(prefers-color-scheme: dark)").matches)
  const resolved = resolvedTheme.theme
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  if (resolvedTheme.scheme) document.documentElement.dataset.scheme = resolvedTheme.scheme
  else delete document.documentElement.dataset.scheme
}
const applyThemePreference = (preference: ThemePreference) => { setThemePreference(preference); paintTheme(); try { localStorage.setItem("ycoding.desktop.theme", preference) } catch { setDesktopNotice("Theme changed for this window; the preference could not be saved.") } }
const [animationsEnabled, setAnimationsEnabled] = createSignal(true)
const applyAnimationsPreference = (enabled: boolean) => { setAnimationsEnabled(enabled); if (typeof document !== "undefined") document.documentElement.dataset.animations = enabled ? "on" : "off" }
const [railOpen, setRailOpen] = createSignal(false)
const [railQuery, setRailQuery] = createSignal("")
const [newDirectory, setNewDirectory] = createSignal("")
const [newText, setNewText] = createSignal("")
const [openedDirectories, setOpenedDirectories] = createSignal<ReadonlySet<string>>(new Set())
const [thinkingExpanded, setThinkingExpanded] = createSignal(false)
const [newPending, setNewPending] = createSignal<{ directory: string; sessionID: string; promptID: string; text: string; files?: PromptFile[]; agents?: PromptAgent[]; command?: { name: string; arguments?: string }; created: boolean; model?: ModelSelection; modelRevision?: number; switchAttempted?: boolean; switched?: boolean; autonomy?: "manual" | "auto" | "yolo"; autonomyRevision?: number; autonomyAttempted?: boolean; autonomyApplied?: boolean }>()
const [newUnconfirmed, setNewUnconfirmed] = createSignal(false)
const unconfirmed = new Set<string>()
const drafts = new Map<string, string>()
const pendings = new Map<string, { promptID: string; text: string; files?: PromptFile[]; agents?: PromptAgent[] }>()
const scope = () => [connection().generation, connection().revision ?? 0] as const
const reading = () => connection().status === "connected"
const failure = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback
const sessionsQuery = (search = "") => ({ queryKey: ["sessions", ...scope(), search] as const, queryFn: () => api.sessions(search ? { search } : {}), enabled: reading() })
const refresh = (queryKey: readonly unknown[]) => void queries.invalidateQueries({ queryKey }, { cancelRefetch: false })
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const costLabel = (cost: number | undefined) => cost === undefined ? "Cost unknown" : formatUsd(cost)
const [railCollapsed, setRailCollapsed] = createSignal(false)
const [companionOpen, setCompanionOpen] = createSignal(false)
const [companionTab, setCompanionTab] = createSignal<"Activity" | "Changes" | "Context">("Context")
const connectBackend = async (selection: Selection) => {
  setBackendActionError(undefined)
  setReconnectingBackend(true)
  try {
    await api.connect(selection)
    setSavedSelection(selection)
    if (selection.mode === "shared") setSavedSharedEndpoint(selection.server ?? "")
    setPreferencesError(undefined)
  } catch (cause) { setBackendActionError(failure(cause, "The backend could not connect.")) }
  finally { setReconnectingBackend(false) }
}
const retryBackendConnection = () => connectBackend(savedSelection())
async function copyTextToClipboard(text: string) {
  try { if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return } } catch {}
  await api.writeClipboard({ text })
}
function pastedFilesOf(data: DataTransfer | null): PromptFile[] {
  if (!data) return []
  const found = new Map<string, PromptFile>()
  const add = (path: string | undefined, name: string) => { if (path && path.startsWith("/") && !found.has(`file://${path}`)) found.set(`file://${path}`, { uri: `file://${path}`, name: name || (path.split("/").at(-1) ?? path) }) }
  const nativePath = (file: File) => (file as File & { path?: string }).path
  for (const file of Array.from(data.files ?? [])) add(nativePath(file), file.name)
  for (const item of Array.from(data.items ?? [])) { const file = item.kind === "file" ? item.getAsFile() : null; if (file) add(nativePath(file), file.name) }
  for (const line of (data.getData("text/uri-list") ?? "").split(/\r?\n/)) if (line.startsWith("file://")) found.set(line, { uri: line, name: line.split("/").at(-1) || line })
  return [...found.values()]
}
const autonomyChoices = ["", "manual", "auto", "yolo"] as const
const decisionModes = [{ value: "manual", label: "Manual" }, { value: "auto", label: "Auto" }, { value: "yolo", label: "YOLO" }] as const
const cycleTheme = () => { const index = DESKTOP_THEMES.findIndex((theme) => theme.id === themePreference()); applyThemePreference(DESKTOP_THEMES[(index + 1) % DESKTOP_THEMES.length]!.id) }
const applyThemeSlash = (args: string) => { if (isDesktopThemeID(args)) applyThemePreference(args); else cycleTheme() }
const stagedAutonomyLabels = { "": "Server default", manual: "Manual", auto: "Auto", yolo: "YOLO" } as const
function Icon(props: { name: DesktopIconName }) { if (props.name === "arc" || props.name === "more" || props.name === "clip") return <svg class="rl-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><For each={[...extraIconPaths[props.name]]}>{(d) => <path d={d} />}</For></svg>; return <WebIcon name={props.name as WebIconName} class="rl-ico" /> }
function Brand(props: { wordmark?: boolean }) { return <span class="rl-brand" data-wordmark={props.wordmark ? "true" : undefined}><svg class="rl-brand-mark" viewBox="0 0 256 256" fill="none" role="img" aria-label="YCoding"><rect width="256" height="256" rx="48" fill="var(--yc-brand-tile)" /><rect x="1" y="1" width="254" height="254" rx="47" stroke="var(--yc-brand-rule)" stroke-width="2" /><g transform="translate(128 128) scale(0.9) translate(-128 -128)"><path d="M40 40h40l48 64-24 32z" fill="var(--yc-brand-trace)" /><path d="M176 40h40l-64 96-24-32z" fill="var(--yc-brand-frost)" /><path d="M104 112h48v104h-48z" fill="var(--yc-brand-frost)" /><rect x="116" y="104" width="24" height="24" transform="rotate(45 128 116)" fill="var(--yc-brand-attention)" /></g></svg><Show when={props.wordmark}><span class="rl-wordmark" aria-hidden="true">YCoding</span></Show></span> }
const asked = new Set(["permission.asked", "question.asked", "guardrail.asked", "form.created"])
const settled = new Set(["permission.replied", "permission.cancelled", "question.replied", "question.rejected", "question.timed_out", "guardrail.replied", "guardrail.cancelled", "session.guardrail.decided", "form.replied", "form.cancelled", "form.timed_out"])
const requestEvents = /^(permission|form|question|guardrail)\.|^session\.(review|guardrail)\./
const stopped = new Set(["session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

function observe<T>(options: () => { queryKey: readonly unknown[]; queryFn: () => Promise<T>; enabled: boolean; refetchOnMount?: "always" }) {
  const observer = new QueryObserver<T>(queries, options())
  const [result, setResult] = createSignal(observer.getCurrentResult())
  const unsubscribe = observer.subscribe((value) => setResult(() => value))
  createEffect(() => observer.setOptions(options()))
  onCleanup(() => { unsubscribe(); observer.destroy() })
  return { result, refetch: () => void observer.refetch() }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

function word(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function payload(event: YCodingEvent): unknown {
  return "data" in event ? event.data : undefined
}

function eventSession(event: YCodingEvent) {
  const data = payload(event)
  return word(field(data, "sessionID")) ?? word(field(field(data, "form"), "sessionID"))
}

function eventRequest(event: YCodingEvent) {
  const data = payload(event)
  return word(field(data, "requestID")) ?? word(field(data, "id")) ?? word(field(field(data, "form"), "id"))
}

function withBusy(current: Activity, sessionID: string, busy: boolean): Activity {
  if (current.busy.has(sessionID) === busy) return current
  const next = new Set(current.busy)
  if (busy) next.add(sessionID); else next.delete(sessionID)
  return { ...current, busy: next }
}

function withRequest(current: Activity, sessionID: string, requestID: string, open: boolean): Activity {
  if (open) {
    if (current.waiting.get(sessionID)?.has(requestID)) return current
    return { ...current, waiting: new Map(current.waiting).set(sessionID, new Set(current.waiting.get(sessionID)).add(requestID)) }
  }
  if (![...current.waiting.values()].some((requests) => requests.has(requestID))) return current
  return { ...current, waiting: new Map([...current.waiting].flatMap(([id, requests]) => {
    const rest = new Set([...requests].filter((item) => item !== requestID))
    return rest.size ? [[id, rest] as const] : []
  })) }
}

function track(current: Activity, event: YCodingEvent): Activity {
  const type: string = event.type
  const sessionID = eventSession(event)
  if (!sessionID) return current
  if (type === "session.deleted") return withBusy({ ...current, waiting: new Map([...current.waiting].filter(([id]) => id !== sessionID)) }, sessionID, false)
  const status = word(field(field(payload(event), "status"), "type"))
  if (type === "session.execution.started" || (type === "session.status" && (status === "busy" || status === "retry"))) return withBusy(current, sessionID, true)
  if (stopped.has(type) || (type === "session.status" && status === "idle")) return withBusy(current, sessionID, false)
  const request = eventRequest(event)
  if (!request) return current
  if (asked.has(type)) return withRequest(current, sessionID, request, true)
  if (settled.has(type)) return withRequest(current, sessionID, request, false)
  return current
}

function descends(rows: ReadonlyMap<string, SessionRow>, row: SessionRow, ancestorID: string) {
  let current = row
  for (let hops = 0; current.parentID !== undefined && hops < 16; hops++) {
    if (current.parentID === ancestorID) return true
    const parent = rows.get(current.parentID)
    if (!parent) return false
    current = parent
  }
  return false
}

export function companionChildren(rows: readonly SessionRow[], sessionID: string, current: Activity) {
  const byID = new Map(rows.map((row) => [row.id, row] as const))
  return rows.filter((row) => descends(byID, row, sessionID)).map((row) => ({ row, status: (current.waiting.get(row.id)?.size ?? 0) > 0 ? "Waiting for you" : current.busy.has(row.id) ? "Running" : "Status unknown" }))
}

export function effortChoice(choice: ModelChoice, variants: readonly string[], variant: string, disabled: boolean): ModelChoice {
  return !disabled && variants.includes(variant) ? { ...choice, variant } : choice
}

export function desktopDestinations(path: string) {
  return WORKSPACE_DESTINATIONS.map((item) => ({ ...item, route: item.desktopRoute, current: path === item.desktopRoute || (item.id === "sessions" && path.startsWith("/sessions/")) }))
}

export function currentSnapshot<T extends { revision: number; sessionID?: string }>(value: T | undefined, revision: number | undefined, sessionID?: string): T | undefined {
  return value && value.revision === revision && (sessionID === undefined || value.sessionID === sessionID) ? value : undefined
}

export const surfaceNotices = {
  activity: (data: { subagents: readonly unknown[]; total: number; activeTotal: number; subagentNext?: string; unattributedShellCount: number }) => [
    ...(data.subagentNext !== undefined || data.total > data.subagents.length ? [`Showing ${data.subagents.length} of ${data.total} subagents (${data.activeTotal} active)`] : []),
    ...(data.unattributedShellCount ? [`${data.unattributedShellCount} repository shell(s) without Session attribution omitted`] : []),
  ],
  projects: (data: { repositories: readonly unknown[]; repositoriesNext?: string }) => data.repositoriesNext === undefined ? undefined : `Showing first ${data.repositories.length} repositories; narrow search or use CLI for full inventory`,
  usage: (data: { hasMoreModels: boolean; report: { rows: readonly unknown[]; rowCount: number } }) => data.hasMoreModels ? `Showing top ${data.report.rows.length} of ${data.report.rowCount} model rows` : undefined,
  changes: (items: readonly { additions: number; deletions: number }[]) => `${items.length} files · +${items.reduce((sum, item) => sum + item.additions, 0)} / -${items.reduce((sum, item) => sum + item.deletions, 0)}`,
}

function focusHeading(heading: HTMLElement) {
  queueMicrotask(() => heading.focus({ preventScroll: true }))
}

function resetDrafts() {
  setOpenedDirectories(new Set<string>())
  setFolderDialog(undefined)
  setUtilityDialog(undefined)
  setStashDialog(undefined)
  for (const [sessionID, pending] of pendings) {
    if (!drafts.has(sessionID)) drafts.set(sessionID, pending.text)
    unconfirmed.add(sessionID)
  }
  pendings.clear()
  if (newPending()) setNewUnconfirmed(true)
  setNewDirectory("")
  setNewPending(undefined)
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  createEffect(() => { if (location().pathname === "/") void navigate({ to: "/sessions" }) })
  onMount(() => {
    const theme = window.matchMedia("(prefers-color-scheme: dark)")
    try { const saved = localStorage.getItem("ycoding.desktop.theme"); if (isDesktopThemeID(saved)) setThemePreference(saved) } catch { setDesktopNotice("The saved theme could not be read.") }
    paintTheme()
    theme.addEventListener("change", paintTheme)
    const apply = (state: ConnectionState) => {
      if (state.generation < connection().generation) return
      if (state.generation !== connection().generation) resetDrafts()
      if (state.generation !== connection().generation || state.revision !== connection().revision) { queries.clear(); setActivity(noActivity); setFailedSessions(new Set<string>()); setLastSessionID(undefined) }
      setConnection(state)
    }
    let observed = false
    const states = api.onState((state) => { observed = true; apply(state) })
    void Promise.all([api.state(), api.preferences()]).then(([state, preferences]) => {
      if (!observed) apply(state)
      setSavedSelection(preferences.selection ?? { mode: "shared" })
      setSavedSharedEndpoint(preferences.sharedEndpoint ?? "")
      setPreferencesError(preferences.error)
      if (preferences.error) return
      if (connection().status === "idle") {
        const generation = connection().generation
        void api.connect(preferences.selection ?? { mode: "shared" }).catch((cause: unknown) => {
          if (connection().generation === generation && connection().status !== "error") apply({ generation, status: "error", error: failure(cause, "The backend could not connect.") })
        })
      }
    }, (cause: unknown) => { if (!observed || connection().status === "idle") apply({ generation: connection().generation, status: "error", error: failure(cause, "The native client state or preferences could not be read. Restart the app.") }) })
    const events = api.onEvent((event) => {
      setActivity((current) => track(current, event))
      const type: string = event.type
      if (type.startsWith("session.") && !/\.(delta|progress)$/.test(type)) refresh(["sessions"])
      const sessionID = eventSession(event)
      if (sessionID && (type === "session.deleted" || /^session\.execution\.(started|succeeded|failed|interrupted)$/.test(type))) setFailedSessions((current) => { const next = new Set(current); if (type === "session.execution.failed") next.add(sessionID); else next.delete(sessionID); return next })
      if (sessionID && type.startsWith("session.") && !/\.(delta|progress)$/.test(type)) refresh(["session", ...scope(), sessionID])
      if (sessionID) { refresh(["messages", ...scope(), sessionID]); refresh(["fileChanges", ...scope(), sessionID]) }
      if (sessionID && (type.startsWith("session.autonomy.") || type.startsWith("session.goal."))) refresh(["autonomy", ...scope(), sessionID])
      if (sessionID && (requestEvents.test(type) || type === "session.idle")) refresh(["requests", ...scope(), sessionID])
    })
    const resync = api.onResync(() => { setActivity(noActivity); setFailedSessions(new Set<string>()); void queries.invalidateQueries(undefined, { cancelRefetch: false }) })
    const menu = typeof api.onMenuAction === "function" ? api.onMenuAction((action) => {
      if (action === "new-chat") void navigate({ to: "/chat" })
      else if (action === "open-settings") void navigate({ to: "/settings" })
      else if (action === "check-for-updates") { setUpdateTriggerTick((tick) => tick + 1); void navigate({ to: "/settings" }) }
    }) : () => {}
    const shortcut = (event: KeyboardEvent) => {
      if (isStandardEditShortcut(event)) return
      if (event.altKey || event.isComposing) return
      const key = event.key.toLowerCase()
      const command = (event.metaKey || event.ctrlKey) && !event.shiftKey
      if (key === "k" && command) { event.preventDefault(); setPaletteOpen((open) => !open); return }
      if (key === "p" && event.ctrlKey && !event.metaKey && !event.shiftKey && !isEditableKeyboardTarget(event.target)) { event.preventDefault(); setPaletteOpen(true); return }
      if (paletteOpen()) return
      if (key === "n" && command) { event.preventDefault(); void navigate({ to: "/chat" }); return }
      if (key === "," && command) { event.preventDefault(); void navigate({ to: "/settings" }); return }
      if (key === "escape" && railOpen()) setRailOpen(false)
    }
    window.addEventListener("keydown", shortcut)
    onCleanup(() => { theme.removeEventListener("change", paintTheme); window.removeEventListener("keydown", shortcut); states(); events(); resync(); menu(); queries.clear() })
  })
  return <div class="desktop rl rl-ledger desktop--workspace">
    <style id="desktop-schemes">{schemeStylesheet()}</style>
    <Outlet />
    <Show when={desktopNotice()}>{(notice) => <p role="status" class="desktop__notice">{notice()}<button type="button" class="rl-btn" onClick={() => setDesktopNotice(undefined)}>Dismiss</button></p>}</Show>
    <Show when={paletteOpen()}><Palette /></Show><ConfirmDialog />
    <Show when={folderDialog()} keyed>{(options) => <FolderExplorerDialog options={options} />}</Show>
    <Show when={utilityDialog()} keyed>{(options) => <UtilityDialog options={options} />}</Show>
    <Show when={stashDialog()} keyed>{(options) => <StashDialog options={options} />}</Show>
  </div>
}

type FolderOptions = { readonly mode: "directory" | "create-directory" | "file"; readonly title: string; readonly initialDirectory?: string; readonly onPick: (path: string) => void | Promise<void> }
const [folderDialog, setFolderDialog] = createSignal<FolderOptions>()
const openFolderPicker = (options: FolderOptions) => setFolderDialog(options)

export async function pickDesktopPath(options: FolderOptions, path: string, bridge: Pick<DesktopAPI, "openDirectory"> = api, current: () => boolean = () => true) {
  if (options.mode === "file") { if (current()) await options.onPick(path); return }
  const opened = await bridge.openDirectory({ directory: path })
  if (!current()) throw new Error("The connection changed while opening the folder. Choose it again on the current backend.")
  setOpenedDirectories((previous) => new Set(previous).add(opened.directory))
  refresh(["workspaces"]); refresh(["projects"])
  await options.onPick(opened.directory)
}

let dialogIDs = 0
function DesktopDialog(props: { title: string; onClose: () => void; children: JSX.Element }) {
  const titleID = `desktop-dialog-${++dialogIDs}`
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  let dialog: HTMLDialogElement | undefined
  onMount(() => dialog?.showModal())
  onCleanup(() => { dialog?.close(); if (opener?.isConnected) opener.focus() })
  return <dialog ref={dialog} class="desktop-dialog" aria-labelledby={titleID} onCancel={(event) => { event.preventDefault(); props.onClose() }}><header class="desktop-dialog__head"><h2 id={titleID}>{props.title}</h2><button type="button" class="rl-icon" aria-label={`Close ${props.title}`} onClick={props.onClose}><Icon name="close" /></button></header><div class="desktop-dialog__body">{props.children}</div></dialog>
}

function FolderExplorerDialog(props: { options: FolderOptions }) {
  const [directory, setDirectory] = createSignal(props.options.initialDirectory)
  const [showHidden, setShowHidden] = createSignal(false)
  const [filter, setFilter] = createSignal("")
  const [name, setName] = createSignal("")
  const [creating, setCreating] = createSignal(props.options.mode === "create-directory")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const generation = connection().generation
  const revision = connection().revision
  const current = () => connection().generation === generation && connection().revision === revision && folderDialog() === props.options
  const listing = observe(() => ({ queryKey: ["folder-browser", ...scope(), directory(), showHidden()] as const, queryFn: () => api.browseDirectory({ directory: directory(), showHidden: showHidden() }), enabled: reading() && current() }))
  const workspaces = observe(() => ({ queryKey: ["workspaces", ...scope()] as const, queryFn: () => api.workspaces(), enabled: reading() && current() }))
  const data = () => listing.result().isError ? undefined : listing.result().data
  const currentDir = () => data()?.directory ?? directory()
  const navigate = (path: string) => { setDirectory(path); setFilter("") }
  const breadcrumbs = () => { const path = currentDir() ?? "/"; return [{ name: "/", path: "/" }, ...path.split("/").filter(Boolean).map((name, index, parts) => ({ name, path: `/${parts.slice(0, index + 1).join("/")}` }))] }
  const perform = async (run: () => Promise<void>) => {
    if (busy() || !current() || !reading()) return
    setBusy(true); setError(undefined)
    try { await run() } catch (cause) { if (current()) setError(failure(cause, "The folder action was not confirmed. Refresh before retrying.")) } finally { setBusy(false) }
  }
  const choose = async (path: string) => { await pickDesktopPath(props.options, path, api, current); if (current()) setFolderDialog(undefined) }
  const create = () => perform(async () => {
    if (listing.result().isFetching || !data()) return
    const valid = validateFolderSegment(name())
    if (!valid.valid) { setError(valid.error); return }
    const parentDirectory = currentDir()
    if (!parentDirectory) return
    const opened = await api.createDirectory({ parentDirectory, name: valid.name })
    if (!current()) return
    setOpenedDirectories((previous) => new Set(previous).add(opened.directory))
    refresh(["workspaces"]); refresh(["projects"]); listing.refetch()
    navigate(opened.directory); setName(""); setCreating(false)
  })
  return <DesktopDialog title={props.options.title} onClose={() => setFolderDialog(undefined)}>
    <div class="desktop-dialog__toolbar"><button type="button" class="rl-btn" disabled={busy() || !data()?.parent} onClick={() => { const parent = data()?.parent; if (parent) navigate(parent) }}><Icon name="arrow-up" />Up</button><button type="button" class="rl-btn" disabled={busy() || !data()?.home} onClick={() => { const home = data()?.home; if (home) navigate(home) }}>Home</button><button type="button" class="rl-btn" disabled={busy()} onClick={listing.refetch}>Refresh</button><label class="rl-field"><input type="checkbox" role="switch" checked={showHidden()} onChange={(event) => setShowHidden(event.currentTarget.checked)} />Show hidden</label></div>
    <nav class="desktop-dialog__breadcrumbs" aria-label="Folder path"><For each={breadcrumbs()}>{(part) => <button type="button" class="rl-btn" disabled={busy()} onClick={() => navigate(part.path)}>{part.name}</button>}</For></nav>
    <div class="desktop-dialog__quick" role="group" aria-label="Workspace folders"><For each={workspaces.result().data ?? []}>{(workspace) => <button type="button" class="rl-chip" disabled={busy()} onClick={() => navigate(workspace.directory)}>{workspace.name ?? workspaceBase(workspace.directory)}</button>}</For></div>
    <label class="rl-field"><span>Filter entries</span><input type="search" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} /></label>
    <Show when={listing.result().isFetching}><p role="status">Loading folder…</p></Show><Show when={listing.result().isError}><p role="alert">{failure(listing.result().error, "Folder could not be read.")}</p></Show>
    <ul class="desktop-dialog__entries"><For each={(data()?.entries ?? []).filter((entry) => entry.name.toLowerCase().includes(filter().toLowerCase()))} fallback={<li>No entries match.</li>}>{(entry) => <li><button type="button" class="rl-option" disabled={busy() || (entry.kind === "file" && props.options.mode !== "file")} onClick={() => entry.kind === "directory" ? navigate(entry.path) : void perform(() => choose(entry.path))}><Icon name={entry.kind === "directory" ? "folder" : "file"} /><span>{entry.name}</span></button></li>}</For></ul>
    <Show when={data()?.truncated}><p role="status">Showing the first {data()?.entries.length} entries. Filter or navigate to narrow the listing.</p></Show>
    <button type="button" class="rl-btn" disabled={busy()} onClick={() => setCreating(!creating())}><Icon name="folder-plus" />New folder</button>
    <Show when={creating()}><form class="desktop-dialog__new-folder" onSubmit={(event) => { event.preventDefault(); void create() }}><label class="rl-field"><span>New folder name</span><input value={name()} disabled={busy()} onInput={(event) => setName(event.currentTarget.value)} /></label><button type="submit" class="rl-btn" disabled={busy() || !currentDir()}>Create folder</button></form></Show>
    <Show when={error()}><p role="alert" class="desktop__error">{error()}</p></Show>
    <footer class="desktop-dialog__actions"><button type="button" class="rl-btn" disabled={busy()} onClick={() => void perform(async () => { const picked = await api.pickDirectory({ startingFolder: currentDir() }); if (!current() || !picked.directory) return; if (props.options.mode === "file") navigate(picked.directory); else await choose(picked.directory) })}>Choose in Finder…</button><button type="button" class="rl-btn" onClick={() => setFolderDialog(undefined)}>Cancel</button><Show when={props.options.mode !== "file"}><button type="button" class="rl-btn" data-tone="go" disabled={busy() || !data() || listing.result().isFetching} onClick={() => { const path = currentDir(); if (path) void perform(() => choose(path)) }}>Choose folder</button></Show></footer>
  </DesktopDialog>
}

type UtilityKind = "connect" | "mcp" | "diff" | "status" | "debug" | "agents" | "skills" | "browser" | "pair" | "remote" | "artifacts" | "plugins" | "dots" | "help"
type UtilityOptions = { readonly kind: UtilityKind; readonly source?: DesktopSource; readonly sessionID?: string; readonly directory?: string; readonly diffMode?: "git" | "branch"; readonly insert?: (value: string) => void }
const [utilityDialog, setUtilityDialog] = createSignal<UtilityOptions>()
const utilityKinds: readonly string[] = ["connect", "mcp", "diff", "status", "debug", "agents", "skills", "browser", "pair", "remote", "artifacts", "plugins", "dots", "help"]
const [commandOwner, setCommandOwner] = createSignal<{ sessionID?: string; run: (name: string, args: string) => Promise<boolean> }>()
const sessionCommands = new Set(["compact", "autonomous", "goal", "daybreak", "rename", "fork", "move", "undo", "redo", "terminals", "variants", "find", "timeline", "stash", "copy", "export"])
type StashOptions = { readonly text: () => string; readonly update: (text: string) => void; readonly directory?: string }
const [stashDialog, setStashDialog] = createSignal<StashOptions>()

function StashDialog(props: { options: StashOptions }) {
  const [entries, setEntries] = createSignal<ReturnType<typeof parsePromptStashes>>([])
  const [error, setError] = createSignal<string>()
  const key = "ycoding.desktop.prompt-stashes"
  onMount(() => { try { setEntries(parsePromptStashes(localStorage.getItem(key))) } catch { setError("Saved drafts could not be read.") } })
  const save = (next: ReturnType<typeof parsePromptStashes>) => { localStorage.setItem(key, JSON.stringify(next)); setEntries(next) }
  return <DesktopDialog title="Prompt stashes" onClose={() => setStashDialog(undefined)}><p>Drafts are saved on this Mac. File attachments are not included.</p><button type="button" class="rl-btn" disabled={!props.options.text().trim()} onClick={() => { try { save(pushPromptStash(parsePromptStashes(localStorage.getItem(key)), { id: crypto.randomUUID(), text: props.options.text(), directory: props.options.directory, createdAt: Date.now() })); props.options.update("") } catch { setError("The draft was not saved; it remains in the composer.") } }}>Stash current draft</button><ul class="desktop-dialog__entries"><For each={entries()} fallback={<li>No saved drafts.</li>}>{(entry) => <li><p>{entry.text}</p><small>{entry.directory ?? "Standalone"} · {new Date(entry.createdAt).toLocaleString()}</small><button type="button" class="rl-btn" onClick={() => { void (async () => { if (props.options.text().trim() && !(await confirmInPage("Replace the current composer draft with this saved draft?"))) return; try { save(parsePromptStashes(localStorage.getItem(key)).filter((item) => item.id !== entry.id)); props.options.update(entry.text); setStashDialog(undefined) } catch { setError("The saved draft could not be restored.") } })() }}>Pop and restore</button></li>}</For></ul><Show when={error()}><p role="alert">{error()}</p></Show></DesktopDialog>
}

export function transcriptText(message: Messages[number]) {
  return message.type === "assistant" ? groupAssistantParts(message.content).flatMap((group) => group.kind === "text" ? [group.text] : []).join("\n\n") : message.type === "user" || message.type === "system" || message.type === "synthetic" ? message.text : message.type === "shell" ? `${message.command}\n${message.output?.output ?? ""}` : ""
}

export function latestAssistantText(messages: readonly Messages[number][]) {
  const message = visibleDesktopMessages(messages).findLast((message) => message.type === "assistant" && !!transcriptText(message).trim())
  return message ? transcriptText(message) : undefined
}

export function composerSlash(text: string, backend: readonly string[]): SlashAction {
  const parsed = desktopSlashCommand(text, backend)
  if (!parsed) return slashAction(text, ["sleep", "wake"], backend)
  if (parsed.kind === "backend") return { kind: "backend", name: parsed.command, args: parsed.arguments }
  return { kind: "local", name: parsed.kind === "themes" ? "theme" : parsed.kind, args: "argument" in parsed ? parsed.argument ?? "" : text.replace(/^\/\S+\s*/, "") }
}

async function commonCommand(name: string, args: string, options: Omit<UtilityOptions, "kind">, go: (path: "/chat" | "/sessions" | "/workspaces" | "/projects" | "/usage" | "/settings") => void) {
  if (["new", "sessions", "workspaces", "projects", "usage", "settings"].includes(name)) { go(name === "new" ? "/chat" : name === "sessions" ? "/sessions" : name === "workspaces" ? "/workspaces" : name === "projects" ? "/projects" : name === "usage" ? "/usage" : "/settings"); return true }
  if (name === "theme" || name === "themes") { applyThemeSlash(args); return true }
  if (name === "toggle-thinking") { setThinkingExpanded(!thinkingExpanded()); return true }
  if (name === "branch-diff") { setUtilityDialog({ ...options, kind: "diff", diffMode: "branch" }); return true }
  if (utilityKinds.includes(name)) { setUtilityDialog({ ...options, kind: name as UtilityKind }); return true }
  if (name === "keep-awake") {
    const starting = scope().join(":")
    const settings = await api.settings()
    const enabled = settings.keepAwake.state !== "on"
    if (!(await confirmInPage(`${enabled ? "Enable" : "Disable"} keep awake?`))) return false
    if (scope().join(":") !== starting || settings.revision !== connection().revision) throw new Error("The connection changed. Read settings again.")
    await api.changeSettings({ kind: "keep-awake", revision: settings.revision, enabled }); refresh(["settings"])
    setDesktopNotice(`Keep awake ${enabled ? "enabled" : "disabled"}.`); return true
  }
  return false
}

function UtilityDialog(props: { options: UtilityOptions }) {
  return props.options.kind === "connect" ? <ProvidersDialog options={props.options} /> : props.options.kind === "mcp" ? <McpDialog options={props.options} /> : props.options.kind === "diff" ? <DiffDialog options={props.options} /> : props.options.kind === "help" ? <DesktopDialog title="Commands and shortcuts" onClose={() => setUtilityDialog(undefined)}><p>⌘K / Ctrl+K: commands · Ctrl+P: commands outside text fields · ⌘N / Ctrl+N: new chat · ⌘F / Ctrl+F: find in conversation · Enter: send · Shift+Enter: newline · Escape: close dialog</p><ul><For each={DESKTOP_BUILT_IN_SLASH_COMMANDS}>{(command) => <li><code>/{command.name}</code> {command.description}{command.aliases?.length ? ` · ${command.aliases.map((alias) => `/${alias}`).join(", ")}` : ""}</li>}</For></ul></DesktopDialog> : <SystemDialog options={props.options} />
}

function dialogActions() {
  const [busy, setBusy] = createSignal(false)
  const [uncertain, setUncertain] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const starting = scope().join(":")
  const owned = utilityDialog()
  const current = () => scope().join(":") === starting && utilityDialog() === owned && reading()
  const run = async <T,>(action: () => Promise<T>, prompt?: string): Promise<T | undefined> => {
    if (busy() || uncertain() || !current()) return
    setBusy(true); setError(undefined)
    try {
      if (prompt && !(await confirmInPage(prompt))) return
      if (!current()) throw new Error("The connection changed. Reopen this dialog.")
      const result = await action()
      if (!current()) throw new Error("The connection changed. Refresh before continuing.")
      return result
    } catch (cause) { setUncertain(true); setError(failure(cause, "The action was not confirmed. Refresh before continuing.")); return undefined }
    finally { setBusy(false) }
  }
  return { busy, error, blocked: () => busy() || uncertain() || !current(), run, reset: () => { if (!busy()) { setUncertain(false); setError(undefined) } } }
}

function ProvidersDialog(props: { options: UtilityOptions }) {
  const catalog = observe(() => ({ queryKey: ["integrations", ...scope(), props.options.source] as const, queryFn: () => api.integrations(props.options.source), enabled: reading() }))
  const data = () => catalog.result().isError ? undefined : currentSnapshot(catalog.result().data, connection().revision)
  const [search, setSearch] = createSignal("")
  const [key, setKey] = createSignal<Readonly<Record<string, string>>>({})
  const [label, setLabel] = createSignal("")
  const [url, setURL] = createSignal("")
  const [code, setCode] = createSignal("")
  const [inputs, setInputs] = createSignal<Record<string, string>>({})
  const [attempt, setAttempt] = createSignal<{ integrationID: string; value: IntegrationAttempt }>()
  const actions = dialogActions()
  const refreshCatalog = () => { actions.reset(); catalog.refetch(); refresh(["models"]); refresh(["new-chat-models"]) }
  const change = (input: IntegrationMutationInput) => actions.run(async () => {
    const result = await api.manageIntegration(input)
    if (result.attempt && "integrationID" in input) setAttempt({ integrationID: input.integrationID, value: result.attempt })
    if (input.kind === "oauth-cancel" || input.kind === "command-cancel") setAttempt(undefined)
    refresh(["models"]); refresh(["new-chat-models"]); catalog.refetch()
    return result
  }, input.kind === "credential-remove" ? "Remove this provider credential?" : input.kind === "command-start" ? "Run this provider's configured sign-in command?" : undefined)
  const base = () => ({ revision: data()!.revision, source: props.options.source })
  return <DesktopDialog title="Connect providers" onClose={() => { setKey({}); setCode(""); setUtilityDialog(undefined) }}>
    <label class="rl-field"><span>Search providers</span><input type="search" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} /></label><button type="button" class="rl-btn" onClick={refreshCatalog} disabled={actions.busy()}>Refresh providers</button>
    <Show when={catalog.result().isPending}><p role="status">Loading providers…</p></Show><Show when={catalog.result().isError}><p role="alert">{failure(catalog.result().error, "Providers could not be read.")}</p></Show>
    <label class="rl-field"><span>Credential label / new name</span><input value={label()} onInput={(event) => setLabel(event.currentTarget.value)} /></label>
    <For each={(data()?.items ?? []).filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(search().toLowerCase()))}>{(item) => <section class="st-section"><h3>{item.name}</h3><For each={item.methods}>{(method) => method.type === "key" ? <form onSubmit={(event) => { event.preventDefault(); const secret = key()[item.id] ?? ""; setKey((previous) => ({ ...previous, [item.id]: "" })); if (secret && data()) void change({ ...base(), kind: "connect-key", integrationID: item.id, key: secret, ...(label().trim() ? { label: label().trim() } : {}) }) }}><label class="rl-field"><span>{method.label ?? "API key"}</span><input type="password" autocomplete="off" value={key()[item.id] ?? ""} disabled={actions.blocked()} onInput={(event) => setKey((previous) => ({ ...previous, [item.id]: event.currentTarget.value }))} /></label><button type="submit" class="rl-btn" disabled={actions.blocked() || !key()[item.id] || !data()}>Connect API key</button></form> : method.type === "env" ? <p>Environment: {method.names.join(", ")}</p> : <div class="st-stack"><Show when={method.type === "oauth" ? method.prompts : undefined}>{(prompts) => <For each={prompts().filter((prompt) => !prompt.when || (prompt.when.op === "eq" ? inputs()[prompt.when.key] === prompt.when.value : inputs()[prompt.when.key] !== prompt.when.value))}>{(prompt) => <label class="rl-field"><span>{prompt.message}</span>{prompt.type === "select" ? <DesktopSelect label={prompt.message} value={inputs()[prompt.key] ?? ""} options={prompt.options} onChange={(value) => setInputs((previous) => ({ ...previous, [prompt.key]: value }))} /> : <input value={inputs()[prompt.key] ?? ""} placeholder={prompt.placeholder} onInput={(event) => setInputs((previous) => ({ ...previous, [prompt.key]: event.currentTarget.value }))} />}</label>}</For>}</Show><button type="button" class="rl-btn" disabled={actions.blocked() || !data() || attempt()?.value.status === "pending"} onClick={() => { if (data()) void change(method.type === "oauth" ? { ...base(), kind: "oauth-start", integrationID: item.id, methodID: method.id, inputs: inputs(), ...(label().trim() ? { label: label().trim() } : {}) } : { ...base(), kind: "command-start", integrationID: item.id, methodID: method.id, ...(label().trim() ? { label: label().trim() } : {}) }) }}>{method.label}</button></div>}</For>
      <ul class="st-rows"><For each={item.connections.filter((credential) => credential.type === "credential")}>{(credential) => <li class="st-row"><span>{word(field(credential, "label")) ?? credential.id} · {String(field(credential, "active") ?? "")}</span><button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: "credential-activate", credentialID: credential.id })}>Activate</button><button type="button" class="rl-btn" disabled={actions.blocked() || !label().trim() || !data()} onClick={() => void change({ ...base(), kind: "credential-rename", credentialID: credential.id, label: label().trim() })}>Rename</button><button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: "credential-remove", credentialID: credential.id })}>Remove</button></li>}</For></ul>
    </section>}</For>
    <Show when={attempt()}>{(active) => <section class="st-section"><h3>Authorization · {active().value.status}</h3><p>{active().value.instructions}</p><p>{active().value.message}</p><p>Expires {new Date(active().value.time.expires).toLocaleString()}</p><Show when={active().value.url}>{(link) => <><code>{link()}</code><button type="button" class="rl-btn" disabled={actions.blocked()} onClick={() => void actions.run(() => api.openExternalUrl({ url: link() }))}>Open in browser</button></>}</Show><button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: active().value.kind === "oauth" ? "oauth-status" : "command-status", integrationID: active().integrationID, attemptID: active().value.attemptID })}>Check status</button><Show when={active().value.kind === "oauth" && (active().value.manualCode || active().value.mode === "code")}><form onSubmit={(event) => { event.preventDefault(); const authorizationCode = code(); setCode(""); if (data()) void change({ ...base(), kind: "oauth-complete", integrationID: active().integrationID, attemptID: active().value.attemptID, code: authorizationCode }) }}><label class="rl-field"><span>Authorization code</span><input autocomplete="off" value={code()} onInput={(event) => setCode(event.currentTarget.value)} /></label><button type="submit" class="rl-btn" disabled={actions.blocked() || !code() || !data()}>Complete authorization</button></form></Show><button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: active().value.kind === "oauth" ? "oauth-cancel" : "command-cancel", integrationID: active().integrationID, attemptID: active().value.attemptID })}>Cancel</button></section>}</Show>
    <form onSubmit={(event) => { event.preventDefault(); if (data()) void change({ ...base(), kind: "wellknown-add", url: url() }) }}><label class="rl-field"><span>Well-known provider URL</span><input type="url" value={url()} onInput={(event) => setURL(event.currentTarget.value)} /></label><button type="submit" class="rl-btn" disabled={actions.blocked() || !data() || !url()}>Add provider</button></form><Show when={actions.error()}><p role="alert">{actions.error()}</p></Show>
  </DesktopDialog>
}

function McpDialog(props: { options: UtilityOptions }) {
  const servers = observe(() => ({ queryKey: ["mcp", ...scope(), props.options.source] as const, queryFn: () => api.mcpServers(props.options.source), enabled: reading() }))
  const data = () => servers.result().isError ? undefined : currentSnapshot(servers.result().data, connection().revision)
  const [name, setName] = createSignal("")
  const [type, setType] = createSignal("local")
  const [command, setCommand] = createSignal("")
  const [cwd, setCwd] = createSignal("")
  const [url, setURL] = createSignal("")
  const [error, setError] = createSignal<string>()
  const actions = dialogActions()
  const change = (input: McpMutationInput) => actions.run(async () => { await api.manageMcp(input); servers.refetch() }, `${input.kind === "remove" ? "Remove" : input.kind === "add" ? "Add" : input.kind === "connect" ? "Connect" : "Disconnect"} MCP server ${input.name}?`)
  const add = () => {
    const value = data(); if (!value || !name().trim()) return
    if (type() === "remote") { void change({ revision: value.revision, source: props.options.source, kind: "add", name: name().trim(), config: { type: "remote", url: url() } }); return }
    try {
      const argv: unknown = JSON.parse(command())
      if (!Array.isArray(argv) || !argv.length || !argv.every((part): part is string => typeof part === "string" && part.length > 0)) { setError("Enter a JSON array of command arguments."); return }
      setError(undefined); void change({ revision: value.revision, source: props.options.source, kind: "add", name: name().trim(), config: { type: "local", command: argv, ...(cwd().trim() ? { cwd: cwd().trim() } : {}) } })
    } catch { setError('Enter a JSON array such as ["node", "server.js"].') }
  }
  return <DesktopDialog title="MCP servers" onClose={() => setUtilityDialog(undefined)}><button type="button" class="rl-btn" disabled={actions.busy()} onClick={() => { actions.reset(); servers.refetch() }}>Refresh servers</button><Show when={servers.result().isPending}><p role="status">Loading MCP servers…</p></Show><Show when={servers.result().isError}><p role="alert">{failure(servers.result().error, "MCP servers could not be read.")}</p></Show><For each={data()?.items ?? []}>{(server) => <section class="st-section"><h3>{server.name} <span class="rl-badge" data-status={server.status}>{server.status}</span></h3><Show when={server.error}><p role="alert">{server.error}</p></Show><For each={["connect", "disconnect", "remove"] as const}>{(kind) => <button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ revision: data()!.revision, source: props.options.source, name: server.name, kind })}>{kind === "connect" ? "Connect" : kind === "disconnect" ? "Disconnect" : "Remove"}</button>}</For><ul><For each={server.resources}>{(resource) => <li><strong>{resource.name}</strong><code>{resource.uri ?? resource.uriTemplate}</code><p>{resource.description}</p></li>}</For></ul></section>}</For><Show when={data()?.resourcesNotice}><p role="status">{data()?.resourcesNotice}</p></Show><form class="st-form" onSubmit={(event) => { event.preventDefault(); add() }}><h3>Add MCP server</h3><label class="rl-field"><span>Name</span><input value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label><DesktopSelect label="Server type" value={type()} options={[{ value: "local", label: "Local command" }, { value: "remote", label: "Remote URL" }]} onChange={setType} /><Show when={type() === "local"} fallback={<label class="rl-field"><span>Remote URL</span><input type="url" value={url()} onInput={(event) => setURL(event.currentTarget.value)} /></label>}><label class="rl-field"><span>Command (JSON argument array)</span><input value={command()} placeholder={'["node", "server.js"]'} onInput={(event) => setCommand(event.currentTarget.value)} /></label><label class="rl-field"><span>Working directory (optional)</span><input value={cwd()} onInput={(event) => setCwd(event.currentTarget.value)} /></label></Show><button type="submit" class="rl-btn" disabled={actions.blocked() || !data() || !name().trim()}>Add server</button></form><Show when={error() ?? actions.error()}><p role="alert">{error() ?? actions.error()}</p></Show></DesktopDialog>
}

function DiffDialog(props: { options: UtilityOptions }) {
  const [mode, setMode] = createSignal<"git" | "branch">(props.options.diffMode ?? "git")
  const diff = observe(() => ({ queryKey: ["vcs-diff", ...scope(), props.options.source, mode()] as const, queryFn: () => api.vcsDiff({ source: props.options.source, mode: mode() }), enabled: reading() }))
  const data = () => diff.result().isError ? undefined : currentSnapshot(diff.result().data, connection().revision)
  return <DesktopDialog title="Git diff" onClose={() => setUtilityDialog(undefined)}><SharedRadioGroup label="Diff scope" value={mode()} options={[{ value: "git", label: "Working tree (git)" }, { value: "branch", label: "Branch" }]} onChange={(value) => setMode(value === "branch" ? "branch" : "git")} /><Show when={diff.result().isFetching}><p role="status">Loading diff…</p></Show><Show when={diff.result().isError}><p role="alert">{failure(diff.result().error, "Diff could not be read.")}</p><button type="button" class="rl-btn" onClick={diff.refetch}>Retry read</button></Show><Show when={data()}>{(value) => <><p>Branch: {value().branch.current ?? "unknown"} · {value().files.length} files</p><SharedChangesSurface files={value().files.map((file) => ({ path: file.file, patch: file.patch, additions: file.additions, deletions: file.deletions }))} scopeLabel={mode() === "git" ? "Working tree" : "Branch diff"} onRefresh={diff.refetch} refreshing={diff.result().isFetching} /></>}</Show></DesktopDialog>
}

function DisplaySnapshot(props: { value: DisplayValue | undefined }) {
  return <pre class="rl-output"><code>{props.value === undefined ? "Not reported" : JSON.stringify(props.value, null, 2)}</code></pre>
}

export function artifactMutationOf(value: unknown): Extract<SystemManageInput, { kind: "artifact-enable" | "artifact-disable" }>["artifact"] | undefined {
  const scope = field(value, "scope"), kind = field(value, "kind"), id = word(field(value, "id")), revision = field(value, "revision"), version = word(field(value, "currentVersionID")), digest = word(field(value, "currentDigest"))
  if ((scope !== "project" && scope !== "global") || (kind !== "skill" && kind !== "command" && kind !== "agent" && kind !== "plugin") || !id || typeof revision !== "number" || !version || !digest) return undefined
  return { scope, kind, id, expectedRevision: revision, expectedVersionID: version, expectedDigest: digest }
}

function SystemDialog(props: { options: UtilityOptions }) {
  const tabs = ["Status & Debug", "Agents & Skills", "Browser", "Remote & Pairing", "Artifacts & Plugins", "Dots"] as const
  const initial = props.options.kind === "agents" || props.options.kind === "skills" ? tabs[1] : props.options.kind === "browser" ? tabs[2] : props.options.kind === "remote" || props.options.kind === "pair" ? tabs[3] : props.options.kind === "artifacts" || props.options.kind === "plugins" ? tabs[4] : props.options.kind === "dots" ? tabs[5] : tabs[0]
  const [tab, setTab] = createSignal<(typeof tabs)[number]>(initial)
  const input = () => ({ sessionID: props.options.sessionID, directory: props.options.directory })
  const snapshot = observe(() => ({ queryKey: ["system", ...scope(), input()] as const, queryFn: () => api.systemSnapshot(input()), enabled: reading() }))
  const catalog = observe(() => ({ queryKey: ["composer-catalog", ...scope(), props.options.source] as const, queryFn: () => api.composerCatalog(props.options.source), enabled: reading() }))
  const [changed, setChanged] = createSignal<Awaited<ReturnType<typeof api.manageSystem>>>()
  const data = () => currentSnapshot(changed(), connection().revision) ?? (snapshot.result().isError ? undefined : currentSnapshot(snapshot.result().data, connection().revision))
  const [url, setURL] = createSignal("https://example.com")
  const [filter, setFilter] = createSignal("")
  const actions = dialogActions()
  const manage = (request: SystemManageInput) => actions.run(async () => { const result = await api.manageSystem(request); setChanged(result); return result }, `${request.kind === "remote-set" ? request.enabled ? "Enable remote access to every Session on this backend" : "Disable remote access" : request.kind}?`)
  const base = () => ({ ...input(), revision: data()!.revision })
  const insert = (value: string) => { if (props.options.insert) { props.options.insert(value); setUtilityDialog(undefined) } else { setDesktopNotice("Open a chat to insert an agent or skill.") } }
  const rows = (value: DisplayValue | undefined) => Array.isArray(value) ? value : []
  const skillConflicts = (value: unknown) => { const conflicts = field(field(value, "conflicts"), "skills"); return Array.isArray(conflicts) ? conflicts.filter((id): id is string => typeof id === "string") : [] }
  return <DesktopDialog title="System and Session tools" onClose={() => setUtilityDialog(undefined)}><div class="desktop-dialog__tabs" role="tablist" aria-label="System tools"><For each={tabs}>{(label, index) => <button type="button" role="tab" aria-selected={tab() === label} tabindex={tab() === label ? 0 : -1} onClick={() => setTab(label)} onKeyDown={(event) => { const next = event.key === "ArrowRight" ? (index() + 1) % tabs.length : event.key === "ArrowLeft" ? (index() + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined; if (next !== undefined) { event.preventDefault(); setTab(tabs[next]!); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[next]?.focus() } }}>{label}</button>}</For></div><button type="button" class="rl-btn" disabled={actions.busy()} onClick={() => { actions.reset(); setChanged(undefined); snapshot.refetch(); catalog.refetch() }}>Refresh status</button><Show when={snapshot.result().isPending}><p role="status">Reading status…</p></Show><Show when={snapshot.result().isError}><p role="alert">{failure(snapshot.result().error, "Status could not be read.")}</p></Show><Show when={actions.error()}><p role="alert">{actions.error()}</p></Show><For each={Object.values(data()?.notices ?? {})}>{(notice) => <p role="status">{notice}</p>}</For>
    <section role="tabpanel" aria-label={tab()}><Show when={tab() === "Status & Debug"}><dl class="rl-meta"><For each={Object.entries(data()?.connection ?? connection())}>{([name, value]) => <><dt>{name}</dt><dd>{String(value)}</dd></>}</For><dt>Session</dt><dd>{props.options.sessionID ?? "No Session"}</dd><dt>Directory</dt><dd>{data()?.directory ?? props.options.directory ?? "Standalone"}</dd></dl><For each={data()?.server?.urls ?? []}>{(url) => <p><code>{url}</code></p>}</For></Show>
    <Show when={tab() === "Agents & Skills"}><label class="rl-field"><span>Search agents and skills</span><input type="search" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} /></label><Show when={catalog.result().isError}><p role="alert">Catalog could not be read.</p></Show><For each={Object.values(catalog.result().data?.errors ?? {})}>{(error) => <p role="alert">{error}</p>}</For><h3>Agents</h3><For each={(catalog.result().data?.agents ?? []).filter((item) => item.name.toLowerCase().includes(filter().toLowerCase()))}>{(agent) => <button type="button" class="rl-option" onClick={() => insert(`@${agent.name} `)}><strong>@{agent.name}</strong><span>{agent.description}</span></button>}</For><h3>Skills</h3><For each={(catalog.result().data?.skills ?? []).filter((item) => item.name.toLowerCase().includes(filter().toLowerCase()))}>{(skill) => <button type="button" class="rl-option" onClick={() => insert(`$${skill.name} `)}><strong>${skill.name}</strong><span>{skill.description}</span></button>}</For><For each={rows(data()?.sessionSkills)}>{(skill) => <section class="st-section"><p>{word(field(skill, "name")) ?? word(field(skill, "id"))} · {word(field(skill, "state"))} · {word(field(skill, "inactiveReason"))}</p><For each={skillConflicts(skill)}>{(loser) => <button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void actions.run(async () => { await api.manageSession({ kind: "resolve-skill-conflict", revision: data()!.revision, sessionID: props.options.sessionID!, winner: word(field(skill, "id"))!, loser }); snapshot.refetch() }, `Prefer ${word(field(skill, "id"))} over ${loser}?`)}>Prefer this skill over {loser}</button>}</For></section>}</For></Show>
    <Show when={tab() === "Browser"}><h3>Paired browser</h3><DisplaySnapshot value={data()?.browser} /><DisplaySnapshot value={data()?.browserTabs} /><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "browser-start" })}>Start pairing</button><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "browser-forget" })}>Forget browser</button><h3>Isolated browser</h3><DisplaySnapshot value={data()?.isolatedBrowser} /><DisplaySnapshot value={data()?.isolatedBrowserTabs} /><label class="rl-field"><span>Start URL</span><input type="url" value={url()} onInput={(event) => setURL(event.currentTarget.value)} /></label><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "isolated-browser-start", url: url() })}>Start isolated browser</button><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "isolated-browser-stop" })}>Stop isolated browser</button></Show>
    <Show when={tab() === "Remote & Pairing"}><h3>Pairing</h3><Show when={data()?.pairing} fallback={<p>No pairing secret has been issued in this dialog.</p>}>{(pairing) => <><code>{pairing().secret}</code><p>Expires {new Date(pairing().expiresAt).toLocaleString()}</p></>}</Show><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "browser-start" })}>Pair browser</button><h3>Remote relay</h3><DisplaySnapshot value={data()?.remote} /><For each={[true, false]}>{(enabled) => <button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void manage({ ...base(), kind: "remote-set", enabled })}>{enabled ? "Enable remote access" : "Disable remote access"}</button>}</For></Show>
    <Show when={tab() === "Artifacts & Plugins"}><h3>Project artifacts</h3><For each={rows(data()?.artifacts)}>{(artifact) => <section class="st-section"><p>{word(field(artifact, "name")) ?? word(field(artifact, "id"))} · {word(field(artifact, "kind"))} · {word(field(artifact, "stage"))}</p><For each={["artifact-enable", "artifact-disable"] as const}>{(kind) => <button type="button" class="rl-btn" disabled={actions.blocked() || !data() || !artifactMutationOf(artifact)} onClick={() => { const payload = artifactMutationOf(artifact); if (payload) void manage({ ...base(), kind, artifact: payload }) }}>{kind === "artifact-enable" ? "Enable" : "Disable"}</button>}</For></section>}</For><h3>Plugins</h3><DisplaySnapshot value={data()?.plugins} /><p>Plugin discovery is read-only. Configure plugin changes in ycoding.json and restart the backend.</p></Show><Show when={tab() === "Dots"}><h3>Activity dots</h3><DisplaySnapshot value={data()?.dots} /></Show></section>
  </DesktopDialog>
}

function rank(action: PaletteAction, needle: string) {
  if (!needle) return 0
  const label = action.label.toLowerCase()
  if (label.startsWith(needle)) return 0
  if (label.split(/\s+/).some((part) => part.startsWith(needle))) return 1
  if (label.includes(needle)) return 2
  return `${action.detail ?? ""} ${action.keywords}`.toLowerCase().includes(needle) ? 3 : undefined
}

function Palette() {
  const navigate = useNavigate()
  const location = useLocation()
  const sessions = observe(sessionsQuery)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  let dialog: HTMLDialogElement | undefined
  let input: HTMLInputElement | undefined
  const actions = (): readonly PaletteAction[] => [
    { id: "new-chat", group: "Session", label: "New chat", shortcut: mac ? "⌘N" : "Ctrl N", icon: "plus", keywords: "create start conversation", run: () => void navigate({ to: "/chat" }) },
    { id: "refresh", group: "Session", label: "Refresh Sessions", icon: "refresh", keywords: "reload update list", run: () => refresh(["sessions"]) },
    ...desktopDestinations(location().pathname).filter((item) => !item.current).map((item): PaletteAction => ({
      id: `go-${item.id}`, group: "Navigation", label: `Go to ${item.label}`, icon: item.id === "projects" ? "team" : item.id === "sessions" ? "sessions" : item.id === "workspaces" ? "folder" : item.id === "usage" ? "usage" : "settings",
      detail: item.id === "projects" ? "Master and member Sessions" : item.id === "sessions" ? "Browse and filter Sessions" : item.id === "workspaces" ? "Folders and project copies" : item.id === "usage" ? "Requests, tokens and quotas" : "Machine and notification settings",
      keywords: `go to open page destination ${item.label.toLowerCase()}${item.id === "projects" ? " master member project" : ""}`,
      run: () => void navigate({ to: item.route }) })),
    ...railGroups(sessions.result().data?.items ?? [], activity()).groups.flatMap((group) => group.rows.map((row): PaletteAction => ({
      id: `open-${row.id}`, group: "Navigation", label: `Open ${row.title}`, detail: workspaceBase(row.location.directory), icon: row.time.pinned !== undefined ? "pin" : "sparkles", keywords: `${row.id} ${group.label} ${row.location.directory}`,
      run: () => void navigate({ to: "/sessions/$sessionID", params: { sessionID: row.id } }) }))),
    ...DESKTOP_THEMES.filter((theme) => theme.id !== themePreference()).map((theme): PaletteAction => ({
      id: `theme-${theme.id}`, group: "Customize", label: `Theme: ${theme.label}`, icon: theme.mode === "light" ? "sun" : theme.mode === "dark" ? "moon" : "monitor",
      detail: theme.description, keywords: "appearance color scheme dark light toggle theme customize",
      run: () => applyThemePreference(theme.id) })),
    ...DESKTOP_BUILT_IN_SLASH_COMMANDS.filter((command) => command.name !== "new" && (!sessionCommands.has(command.name) || !!commandOwner()?.sessionID) && (command.name !== "models" || !!commandOwner())).map((command): PaletteAction => ({
      id: `command-${command.name}`, group: ["models", "variants", "agents", "skills"].includes(command.name) ? "Model & Agent" : ["diff", "workspaces", "move"].includes(command.name) ? "Workspace & Git" : ["connect", "mcp"].includes(command.name) ? "Providers & MCP" : ["settings", "keep-awake"].includes(command.name) ? "Settings" : sessionCommands.has(command.name) ? "Session" : "System",
      label: command.name === "connect" ? "Connect providers" : command.name === "diff" ? "Git working-tree diff" : command.description, detail: `/${command.name}`, icon: command.name === "mcp" ? "server" : command.name === "diff" ? "file" : command.name === "connect" ? "plug" : command.name === "models" || command.name === "variants" ? "cpu" : command.name === "agents" ? "user" : command.name === "skills" || command.name === "compact" || command.name === "toggle-thinking" ? "sparkles" : command.name === "autonomous" ? "shield" : command.name === "goal" ? "target" : command.name === "daybreak" ? "sun" : command.name === "timeline" ? "list" : command.name === "rename" ? "chat" : command.name === "fork" ? "git-fork" : command.name === "undo" ? "undo" : command.name === "redo" ? "redo" : command.name === "stash" ? "bookmark" : command.name === "find" ? "search" : command.name === "copy" ? "copy" : command.name === "export" ? "download" : command.name === "workspaces" || command.name === "move" ? "folder" : command.name === "projects" ? "team" : command.name === "sessions" ? "sessions" : command.name === "usage" || command.name === "status" ? "usage" : command.name === "settings" ? "settings" : command.name === "keep-awake" ? "zap" : command.name === "themes" ? "sun" : command.name === "browser" || command.name === "remote" ? "globe" : command.name === "artifacts" || command.name === "plugins" ? "package" : command.name === "pair" ? "devices" : command.name === "help" ? "help" : "terminal", keywords: `${command.name} ${command.aliases?.join(" ") ?? ""}`,
      run: () => { const owner = commandOwner(); void (owner ? owner.run(command.name === "themes" ? "theme" : command.name, "") : commonCommand(command.name, "", {}, (to) => void navigate({ to }))).catch((cause) => setDesktopNotice(failure(cause, "The command was not confirmed."))) } })),
    { id: "branch-diff", group: "Workspace & Git", label: "Branch diff", icon: "git-branch", keywords: "git branch changes compare", run: () => { const owner = commandOwner(); void (owner ? owner.run("branch-diff", "") : commonCommand("branch-diff", "", {}, (to) => void navigate({ to }))).catch((cause) => setDesktopNotice(failure(cause, "Diff could not be opened."))) } },
    ...(commandOwner()?.sessionID ? (["archive", "unarchive", "delete"] as const).map((kind): PaletteAction => ({ id: `session-${kind}`, group: "Session", label: kind === "archive" ? "Archive Session" : kind === "unarchive" ? "Unarchive Session" : "Delete Session", icon: "sessions", keywords: kind, run: () => { void commandOwner()?.run(kind, "").catch((cause) => setDesktopNotice(failure(cause, "The Session change was not confirmed."))) } })) : []),
    { id: "toggle-animations", group: "Customize", label: animationsEnabled() ? "Animations: Turn off" : "Animations: Turn on", detail: "Motion in this window", icon: "sparkles", keywords: "motion animation reduced customize", run: () => applyAnimationsPreference(!animationsEnabled()) },
    { id: "toggle-rail", group: "Customize", label: "Toggle navigation rail", detail: railCollapsed() ? "Expand the rail" : "Collapse the rail", icon: "panel-left", keywords: "sidebar collapse expand navigation customize", run: () => setRailCollapsed(!railCollapsed()) },
    { id: "toggle-companion", group: "Customize", label: "Toggle Session companion", detail: companionOpen() ? "Close the companion" : "Open the companion", icon: "team", keywords: "companion activity changes context customize", run: () => setCompanionOpen(!companionOpen()) },
    { id: "machine-backend", group: "Settings", label: "Switch backend", detail: "Machine & Backend", icon: "devices", keywords: "switch backend machine server endpoint connection mode reconnect", run: () => void navigate({ to: "/settings" }) },
    { id: "check-for-updates", group: "System", label: "Check for updates", detail: "Check GitHub releases for a newer YCoding Desktop build", icon: "refresh", keywords: "update upgrade version release self-update", run: () => { setUpdateTriggerTick((tick) => tick + 1); void navigate({ to: "/settings" }) } },
  ]
  const sections = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const ranked = actions().flatMap((action) => { const score = rank(action, needle); return score === undefined ? [] : [{ action, score }] })
    if (needle) return ranked.length ? [{ label: "Results", items: ranked.sort((a, b) => a.score - b.score).map((entry) => entry.action) }] : []
    return (["Session", "Model & Agent", "Workspace & Git", "Providers & MCP", "Navigation", "Customize", "Settings", "System"] as const).flatMap((label) => {
      const items = ranked.flatMap((entry) => entry.action.group === label ? [entry.action] : [])
      return items.length ? [{ label, items }] : []
    })
  })
  const flat = () => sections().flatMap((section) => section.items)
  const close = () => setPaletteOpen(false)
  const choose = (action: PaletteAction | undefined) => { if (!action) return; close(); action.run() }
  onMount(() => { dialog?.showModal(); input?.focus() })
  onCleanup(() => { if (dialog?.open) dialog.close(); if (opener?.isConnected) opener.focus() })
  createEffect(() => { void query(); setActive(0) })
  createEffect(() => document.getElementById(`palette-option-${active()}`)?.scrollIntoView({ block: "nearest" }))
  const move = (event: KeyboardEvent) => {
    const count = flat().length
    if (event.key === "Enter") { event.preventDefault(); choose(flat()[active()]); return }
    if (!count) return
    const target = event.key === "ArrowDown" ? (active() + 1) % count : event.key === "ArrowUp" ? (active() + count - 1) % count : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : undefined
    if (target === undefined) return
    event.preventDefault()
    setActive(target)
  }
  return <dialog ref={dialog} class="palette rl-sheet" aria-labelledby="palette-title" data-query-empty={query().trim() === "" ? "true" : undefined} onCancel={(event) => { event.preventDefault(); close() }} onClick={(event) => { if (event.target === dialog) close() }}>
    <h2 id="palette-title" class="desktop__sr">Commands</h2>
    <div class="palette__search"><Icon name="search" /><input ref={input} type="text" role="combobox" class="palette__input" aria-label="Search commands and Sessions" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-activedescendant={flat().length ? `palette-option-${active()}` : undefined}
      placeholder="Search commands, Sessions, themes, workspaces…" autocomplete="off" spellcheck={false} value={query()} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={move} /><kbd>Esc</kbd><button type="button" class="rl-icon-button" aria-label="Close commands" onClick={close}><Icon name="close" /></button></div>
    <ul id="palette-list" role="listbox" aria-label="Commands and Sessions" class="palette__list">
      <For each={sections()}>{(section) => <li role="presentation"><ul role="group" aria-label={section.label}>
        <li role="presentation" class="palette__group" aria-hidden="true">{section.label}</li>
        <For each={section.items}>{(action) => { const index = () => flat().indexOf(action)
          return <li id={`palette-option-${index()}`} role="option" class="palette__option" data-group={action.group} aria-selected={index() === active()} onPointerMove={() => setActive(index())} onClick={() => choose(action)}><span class="palette__option-icon"><Icon name={action.icon} /></span><span class="palette__option-text"><span>{action.label}</span><Show when={action.detail}>{(detail) => <span class="desktop__metadata">{detail()}</span>}</Show></span><Show when={action.shortcut}>{(hint) => <kbd>{hint()}</kbd>}</Show></li> }}</For>
      </ul></li>}</For>
    </ul>
    <Show when={!flat().length}><p role="status" class="palette__empty">No matching commands or Sessions.</p></Show>
    <p class="desktop__muted palette__hint">Searches the most recent Sessions only; use the rail search for older ones. Arrow keys move, Enter selects, Escape closes.</p>
  </dialog>
}

function Workspace() {
  const navigate = useNavigate()
  const location = useLocation()
  const term = () => searchTerm(railQuery())
  const [applied, setApplied] = createSignal(term().value)
  createEffect(() => {
    const next = term()
    if (next.error) return
    const timer = setTimeout(() => setApplied(next.value), 250)
    onCleanup(() => clearTimeout(timer))
  })
  const sessions = observe(() => sessionsQuery(applied()))
  const [paging, setPaging] = createSignal<Paging>()
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [pagingNote, setPagingNote] = createSignal<string>()
  const [pinning, setPinning] = createSignal<string>()
  const [pinNote, setPinNote] = createSignal<{ readonly text: string; readonly failed: boolean }>()
  createEffect(() => { void scope(); void applied(); setPaging(undefined); setPagingNote(undefined) })
  const selected = () => /^\/sessions\/([^/]+)$/.exec(location().pathname)?.[1]
  const state = () => { const first = sessions.result().data; return first ? pagingFor(first, applied(), paging()) : undefined }
  const items = createMemo(() => { const first = sessions.result().data; const current = state(); return first && current ? pagedItems(first, current) : [] })
  const grouped = createMemo(() => railGroups(items(), activity()))
  const [railFilter, setRailFilter] = createSignal<RailFilter>("all")
  const railRows = createMemo(() => grouped().groups.flatMap((group) => group.rows.map((session) => ({ session, state: railStateOf(group.key, session.id) }))))
  const railCount = (filter: RailFilter) => railRows().filter((row) => railMatches(filter, row.state)).length
  const railWorkspaces = createMemo(() => {
    const byWorkspace = new Map<string, { session: SessionRow; state: RailState }[]>()
    for (const { session, state } of railRows()) if (railMatches(railFilter(), state)) { const name = workspaceBase(session.location.directory); byWorkspace.set(name, [...(byWorkspace.get(name) ?? []), { session, state }]) }
    return [...byWorkspace].map(([name, rows]) => ({ name, rows }))
  })
  const loadMore = async () => {
    const current = state()
    const cursor = current?.next
    if (!current || cursor === undefined || loadingMore() || !reading()) return
    const generation = connection().generation
    setLoadingMore(true)
    setPagingNote(undefined)
    try {
      const page = await api.sessions({ revision: current.revision, cursor })
      if (connection().generation !== generation || !samePaging(state(), current)) return
      const merged = appendPage(current, page)
      if (merged) setPaging(merged)
      else { setPaging(undefined); setPagingNote("The Session list changed, so it was reloaded."); sessions.refetch() }
    } catch (cause) {
      if (connection().generation === generation && samePaging(state(), current)) { setPaging(undefined); setPagingNote(failure(cause, "More Sessions could not be read. The list was reloaded.")); sessions.refetch() }
    } finally { setLoadingMore(false) }
  }
  const togglePin = async (row: SessionRow) => {
    const first = sessions.result().data
    if (!first || pinning() !== undefined || !reading()) return
    const pinned = row.time.pinned === undefined
    const generation = connection().generation
    setPinning(row.id)
    setPinNote(undefined)
    try {
      await api.pin({ sessionID: row.id, revision: first.revision, pinned })
      if (connection().generation === generation) setPinNote({ text: `${pinned ? "Pinned" : "Unpinned"} ${row.title}.`, failed: false })
    } catch (cause) { if (connection().generation === generation) setPinNote({ text: failure(cause, "The pin change was not confirmed. Check the list."), failed: true }) }
    finally {
      setPinning(undefined)
      if (connection().generation === generation) { setPaging(undefined); refresh(["sessions"]) }
    }
  }
  const narrow = window.matchMedia("(max-width: 700px)")
  const [drawer, setDrawer] = createSignal(narrow.matches)
  const sizing = () => setDrawer(narrow.matches)
  narrow.addEventListener("change", sizing)
  onCleanup(() => narrow.removeEventListener("change", sizing))
  let main: HTMLElement | undefined
  createEffect(() => main?.toggleAttribute("inert", railOpen() && drawer()))
  let opened = false
  createEffect(() => { void location().pathname; setRailOpen(false) })
  createEffect(() => {
    const rail = document.getElementById("session-rail")
    if (railOpen()) { opened = true; rail?.querySelector<HTMLElement>(".workspace__back")?.focus() }
    else if (opened && rail?.contains(document.activeElement)) document.querySelector<HTMLElement>(".desktop__rail-toggle")?.focus()
  })
  let companionWasOpen = false
  createEffect(() => {
    const open = companionOpen()
    if (companionWasOpen && !open && (!document.activeElement || document.activeElement === document.body)) {
      const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((item) => item.getClientRects().length)
      const opener = visible(".rl-companion-toggle") ?? visible(".rl-context-ring")
      opener?.focus()
    }
    companionWasOpen = open
  })
  return <div class="rl-shell"><div class="workspace rl-app" data-companion-open={companionOpen() ? "true" : undefined} data-collapsed={railCollapsed() ? "true" : undefined} data-mobile-open={railOpen() ? "true" : undefined}>
    <SharedWorkspaceFrame railClass="workspace__rail rl-nav" railLabel="Sessions"
      railHeader={<header class="rl-nav-brand"><Brand wordmark={!railCollapsed()} /><button type="button" class="rl-icon rl-rail-collapse" aria-label={railCollapsed() ? "Expand navigation" : "Collapse navigation"} onClick={() => setRailCollapsed(!railCollapsed())}><Icon name="panel-left" /></button><button type="button" class="workspace__back rl-drawer-close" onClick={() => setRailOpen(false)}>Back to chat</button></header>}
      newChat={<button type="button" class="rl-new-chat" aria-label="New chat" aria-keyshortcuts="Meta+N Control+N" onClick={() => { setRailOpen(false); void navigate({ to: "/chat" }) }}><Icon name="plus" /><span>New chat</span></button>}
      railBody={<>
      <div class="rl-session-switcher"><label class="workspace__search rl-nav-search"><Icon name="search" /><input type="search" aria-label="Search sessions" value={railQuery()} placeholder="Search sessions" aria-invalid={term().error ? "true" : undefined} aria-describedby={term().error ? "rail-search-error" : undefined} onInput={(event) => setRailQuery(event.currentTarget.value)} /></label>
      <Show when={term().error}>{(message) => <p id="rail-search-error" role="alert" class="desktop__error">{message()}</p>}</Show>
      <div class="rl-rail-filters" role="group" aria-label="Filter Sessions by status"><For each={railFilters}>{(filter) => <button type="button" class="rl-rail-filter" aria-pressed={railFilter() === filter.value} onClick={() => setRailFilter(filter.value)}>{filter.label} <span>{railCount(filter.value)}</span></button>}</For><button type="button" class="rl-icon-button rl-rail-refresh" aria-label="Refresh Sessions" onClick={sessions.refetch} disabled={sessions.result().isFetching || !reading()}><Icon name="refresh" /></button></div>
      <div class="rl-nav-scroll"><Show when={!sessions.result().isPending} fallback={<SharedLoadingSkeleton kind="list" label="Loading Sessions…" />}><Show when={!sessions.result().isError} fallback={<p role="alert" class="desktop__error">Sessions could not be read. Check the connection and refresh.</p>}>
        <Show when={items().length > 0} fallback={<p role="status">{applied() ? "No Sessions match your search." : "No Sessions in this backend."}</p>}>
          <Show when={railWorkspaces().length} fallback={<p role="status">{railFilter() === "all" ? "No Sessions to show." : "No Sessions match this filter."}</p>}>
            <For each={railWorkspaces()}>{(workspace) => <section class="workspace__group rl-nav-group" aria-label={workspace.name}>
              <p class="rl-nav-group-label">{workspace.name}</p>
              <ul class="desktop__sessions"><For each={workspace.rows}>{(row) =>
                <li class="workspace__row"><Link to="/sessions/$sessionID" params={{ sessionID: row.session.id }} class="workspace__session rl-session-row" data-state={row.state} data-pinned={row.session.time.pinned !== undefined ? "true" : undefined} aria-label={row.state === "running" || row.state === "failed" ? `${row.session.title}, ${railStatusLabels[row.state]}` : undefined} aria-current={selected() === row.session.id ? "page" : undefined}><RailStatusIcon state={row.state} /><span class="rl-session-row-title">{row.session.title}</span><Show when={row.state === "waiting"}><span class="workspace__status" data-state="needs">{railStatusLabels.waiting}</span></Show></Link>
                  <button type="button" class="workspace__pin rl-icon-button" data-pinned={row.session.time.pinned !== undefined ? "true" : undefined} disabled={!reading() || pinning() !== undefined} aria-label={`${row.session.time.pinned === undefined ? "Pin" : "Unpin"} ${row.session.title}`} onClick={() => void togglePin(row.session)}><Icon name="pin" /></button></li>}</For></ul>
            </section>}</For>
          </Show>
          <Show when={grouped().archived}><p class="desktop__muted">{grouped().archived} archived {grouped().archived === 1 ? "Session is" : "Sessions are"} hidden.</p></Show>
        </Show>
      </Show></Show>
      <Show when={state()?.next !== undefined}><div class="workspace__list-foot"><span class="desktop__muted">{items().length} loaded · more</span><button type="button" class="workspace__more" disabled={loadingMore() || !reading()} onClick={() => void loadMore()}>{loadingMore() ? "Loading…" : "Load more"}</button></div></Show>
      <Show when={pagingNote()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
      <Show when={pinNote()}>{(result) => <p role={result().failed ? "alert" : "status"} class={result().failed ? "desktop__error" : "desktop__muted"}>{result().text}</p>}</Show>
      <p class="desktop__sr">Running, Waiting and Failed come from live events seen since this window connected. Earlier status is unavailable, so a Session can be running or waiting without appearing that way.</p></div></div></>}
      railNavigation={<div class="rl-nav-items"><For each={desktopDestinations(location().pathname)}>{(item) => <Link class="rl-nav-item" to={item.route} aria-label={item.label} data-destination={item.id} aria-current={item.current ? "page" : undefined}><Icon name={item.id === "projects" ? "folder" : item.id === "sessions" ? "chat" : item.id === "workspaces" ? "monitor" : item.id === "usage" ? "usage" : "settings"} /><span>{item.label}</span></Link>}</For></div>}
      workspaceClass="rl-content" mainClass="workspace__main rl-main" mainRef={(element) => { main = element }}>
      <Show when={connection().status === "error" ? (connection().error ?? "The backend could not connect.") : preferencesError()}>{(message) =>
        <div role="alert" class="rl-connection-banner">
          <span class="rl-connection-banner__text"><Icon name="shield" /><span>{message()}</span><Show when={connection().status === "error" && connection().mode === "own"}><span>The private backend is not running. Start it again to continue; unsent drafts are kept.</span></Show></span>
          <span class="rl-connection-banner__actions">
            <button type="button" class="rl-btn" data-tone="go" disabled={reconnectingBackend()} onClick={() => void retryBackendConnection()}>Retry</button>
            <button type="button" class="rl-btn" onClick={() => void navigate({ to: "/settings" })}>Open Settings</button>
          </span>
        </div>
      }</Show>
      <Outlet />
    </SharedWorkspaceFrame>
  </div></div>
}

type RailState = "waiting" | "running" | "failed" | "idle"
const railFilters = [{ value: "all", label: "All" }, { value: "waiting", label: "Waiting" }, { value: "running", label: "Running" }, { value: "idle", label: "Idle" }] as const
type RailFilter = (typeof railFilters)[number]["value"]
const railStatusLabels = { waiting: "Waiting", running: "Running", failed: "Failed", idle: "Idle" } as const
const railStateOf = (key: string, sessionID: string): RailState => key === "needs" ? "waiting" : key === "running" ? "running" : failedSessions().has(sessionID) ? "failed" : "idle"
const railMatches = (filter: RailFilter, state: RailState) => filter === "all" || (filter === "idle" ? state === "idle" || state === "failed" : filter === state)
function RailStatusIcon(props: { state: RailState }) { return <span class="rl-rail-status" data-state={props.state} aria-hidden="true"><Show when={props.state !== "idle"} fallback={<i />}><Icon name={props.state === "running" ? "arc" : props.state === "waiting" ? "hand" : "alert"} /></Show></span> }

let selectIDs = 0
function DesktopSelect(props: { label: string; value: string; options: readonly { readonly value: string; readonly label: string; readonly description?: string }[]; disabled?: boolean; onChange: (value: string) => void }) {
  const id = `desktop-select-${++selectIDs}`
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const [flip, setFlip] = createSignal(false)
  const [alignEnd, setAlignEnd] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  let buffer = ""
  let typedAt = 0
  const selectedIndex = () => Math.max(0, props.options.findIndex((option) => option.value === props.value))
  const selected = () => props.options.find((option) => option.value === props.value)
  createEffect(() => { if (open()) document.getElementById(`${id}-${active()}`)?.scrollIntoView({ block: "nearest" }) })
  const show = () => { if (props.disabled) return; const rect = trigger?.getBoundingClientRect(); setFlip(!!rect && rect.bottom > window.innerHeight - 280); setAlignEnd(!!rect && rect.left + 288 > window.innerWidth - 12); setActive(selectedIndex()); setOpen(true) }
  const close = () => { setOpen(false); trigger?.focus() }
  const choose = (index: number) => { const option = props.options[index]; if (!option) return; props.onChange(option.value); close() }
  const move = (event: KeyboardEvent) => {
    if (props.disabled) return
    const count = props.options.length
    if (!count) return
    if (!open()) { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show() } return }
    if (event.key === "Escape") { event.preventDefault(); close(); return }
    if (event.key === "Tab") { setOpen(false); return }
    const target = event.key === "ArrowDown" ? (active() + 1) % count : event.key === "ArrowUp" ? (active() + count - 1) % count : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : undefined
    if (target !== undefined) { event.preventDefault(); setActive(target); return }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active()); return }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now()
      buffer = now - typedAt > 700 ? event.key : buffer + event.key
      typedAt = now
      const found = props.options.findIndex((option) => option.label.toLowerCase().startsWith(buffer.toLowerCase()))
      if (found >= 0) setActive(found)
    }
  }
  return <span class="desktop-select" data-flip={flip() ? "true" : undefined} data-align={alignEnd() ? "end" : undefined} onFocusOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
    <button ref={trigger} type="button" class="desktop-select__trigger" role="combobox" aria-haspopup="listbox" aria-expanded={open()} aria-controls={open() ? id : undefined} aria-activedescendant={open() ? `${id}-${active()}` : undefined} aria-label={props.label} disabled={props.disabled} onClick={() => open() ? setOpen(false) : show()} onKeyDown={move}><span>{selected()?.label ?? props.value}</span><Icon name="chevron-down" /></button>
    <Show when={open()}><span class="desktop-select__list" role="listbox" id={id} aria-label={props.label}><For each={props.options}>{(option, index) => <span id={`${id}-${index()}`} role="option" class="desktop-select__option" aria-selected={option.value === props.value} data-active={index() === active() ? "true" : undefined} onPointerMove={() => setActive(index())} onPointerDown={(event) => { event.preventDefault(); choose(index()) }}><span>{option.label}</span><Show when={option.value === props.value}><Icon name="check" /></Show><Show when={option.description}>{(text) => <small>{text()}</small>}</Show></span>}</For></span></Show>
  </span>
}

const localSlash = [...DESKTOP_BUILT_IN_SLASH_COMMANDS.flatMap((command) => [{ name: command.name, description: command.description }, ...(command.aliases ?? []).map((name) => ({ name, description: command.description }))]), { name: "sleep", description: "Put autonomy decisions to sleep" }, { name: "wake", description: "Wake autonomy decisions" }]

type Suggestion = { readonly id: string; readonly icon: DesktopIconName; readonly label: string; readonly description?: string; readonly insert: string; readonly keepOpen?: boolean; readonly pick?: MentionPick }

let fieldIDs = 0
function ComposerField(props: { label: string; value: string; locked: boolean; onAttachFiles?: (added: readonly PromptFile[]) => void; source: string | { directory?: string } | undefined; directory: string; localCommands: readonly { readonly name: string; readonly description: string }[]; picks: readonly MentionPick[]; onPicks: (picks: MentionPick[]) => void; onInput: (value: string) => void; onSubmit: () => void }) {
  const listID = `composer-suggestions-${++fieldIDs}`
  const [caret, setCaret] = createSignal(0)
  const [wanted, setWanted] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const [dismissed, setDismissed] = createSignal<string>()
  const [entries, setEntries] = createSignal<readonly { readonly path: string; readonly type: "file" | "directory" }[]>([])
  const [filesError, setFilesError] = createSignal(false)
  let area: HTMLTextAreaElement | undefined
  let fileRequest = 0
  let fileTimer: ReturnType<typeof setTimeout> | undefined
  const sourceKey = () => typeof props.source === "string" ? props.source : props.source?.directory ?? ""
  const catalog = observe(() => ({ queryKey: ["composer-catalog", ...scope(), sourceKey()] as const, queryFn: () => api.composerCatalog(props.source), enabled: reading() && wanted() && typeof api.composerCatalog === "function" }))
  const catalogData = () => { const value = catalog.result().isError ? undefined : catalog.result().data; return value && value.revision === connection().revision ? value : undefined }
  const trigger = createMemo(() => props.locked ? undefined : composerTrigger(props.value, caret()))
  const token = () => { const current = trigger(); return current ? `${current.kind}:${current.start}` : "" }
  const open = () => !!trigger() && dismissed() !== token()
  createEffect(() => {
    const current = trigger()
    setActive(0)
    if (!current) return
    setWanted(true)
    if (current.kind !== "mention" || !props.directory || typeof api.findFiles !== "function") return
    const request = ++fileRequest
    clearTimeout(fileTimer)
    fileTimer = setTimeout(() => { void (async () => {
      try { const found = await api.findFiles({ source: props.source, query: current.query }); if (request === fileRequest && found.revision === connection().revision) { setEntries(found.entries); setFilesError(false) } }
      catch { if (request === fileRequest) setFilesError(true) }
    })() }, 150)
  })
  const matches = (query: string, name: string, description?: string) => !query || name.toLowerCase().includes(query.toLowerCase()) || (description?.toLowerCase().includes(query.toLowerCase()) ?? false)
  const items = createMemo<readonly Suggestion[]>(() => {
    const current = trigger()
    if (!current) return []
    const data = catalogData()
    if (current.kind === "command") {
      const local = props.localCommands.filter((command) => matches(current.query, command.name, command.description)).map((command) => ({ id: `local:${command.name}`, icon: "terminal" as const, label: `/${command.name}`, description: command.description, insert: `/${command.name} ` }))
      const backend = (data?.commands ?? []).filter((command) => !props.localCommands.some((item) => item.name === command.name) && matches(current.query, command.name, command.description)).map((command) => ({ id: `backend:${command.name}`, icon: "terminal" as const, label: `/${command.name}`, description: command.description, insert: `/${command.name} ` }))
      return [...local, ...backend].slice(0, 12)
    }
    if (current.kind === "skill") return (data?.skills ?? []).filter((skill) => matches(current.query, skill.name, skill.description) || matches(current.query, skill.id)).slice(0, 12).map((skill) => ({ id: `skill:${skill.id}`, icon: "sparkles" as const, label: `$${skill.name}`, description: skill.description, insert: `$${skill.name} ` }))
    const root = props.directory.replace(/\/+$/, "")
    const files: Suggestion[] = props.directory ? entries().map((entry) => ({ id: `file:${entry.path}`, icon: entry.type === "directory" ? "folder" as const : "file" as const, label: `@${entry.path}`, insert: entry.type === "directory" ? `@${entry.path}/` : `@${entry.path} `, keepOpen: entry.type === "directory", pick: entry.type === "file" ? { kind: "file" as const, display: `@${entry.path}`, uri: `file://${root}/${entry.path}` } : undefined })) : []
    const agents: Suggestion[] = (data?.agents ?? []).filter((agent) => matches(current.query, agent.name, agent.description)).map((agent) => ({ id: `agent:${agent.name}`, icon: "user" as const, label: `@${agent.name}`, description: agent.description, insert: `@${agent.name} `, pick: { kind: "agent" as const, display: `@${agent.name}`, name: agent.name } }))
    return [...files, ...agents].slice(0, 14)
  })
  const status = () => {
    const current = trigger()
    if (!current || !open() || items().length) return undefined
    if (typeof api.composerCatalog !== "function" || catalog.result().isError) return "Suggestions unavailable — plain text still sends."
    const data = catalogData()
    if (current.kind === "skill" && data?.errors.skills) return "Suggestions unavailable — plain text still sends."
    if (current.kind === "mention" && filesError() && !data?.agents.length) return "Suggestions unavailable — plain text still sends."
    if (!data && current.kind !== "command") return "Loading suggestions…"
    return "No matches"
  }
  createEffect(() => { if (open()) document.getElementById(`${listID}-${active()}`)?.scrollIntoView({ block: "nearest" }) })
  const choose = (item: Suggestion | undefined) => {
    const current = trigger()
    if (!item || !current) return
    const next = insertCompletion(props.value, current.start, caret(), item.insert)
    if (item.pick) props.onPicks([...props.picks, item.pick])
    props.onInput(next.text)
    setCaret(next.caret)
    if (!item.keepOpen) setDismissed(token())
    queueMicrotask(() => { area?.focus(); area?.setSelectionRange(next.caret, next.caret) })
  }
  const at = (event: { currentTarget: HTMLTextAreaElement }) => setCaret(event.currentTarget.selectionStart ?? props.value.length)
  const insertPasted = (pasted: string, start: number, end: number) => {
    const next = insertTextAtSelection(props.value, start, end, pasted)
    props.onInput(next.text)
    setCaret(next.caret)
    queueMicrotask(() => { area?.focus(); area?.setSelectionRange(next.caret, next.caret) })
  }
  const paste = (event: ClipboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    if (props.locked) { event.preventDefault(); return }
    const data = event.clipboardData
    const attached = pastedFilesOf(data)
    if (attached.length) props.onAttachFiles?.(attached)
    const pasted = data?.getData("text/plain") ?? ""
    const target = event.currentTarget
    if (pasted.length > 0) { event.preventDefault(); insertPasted(pasted, target.selectionStart ?? caret(), target.selectionEnd ?? caret()); return }
    if (attached.length) { event.preventDefault(); return }
    event.preventDefault()
    void (async () => {
      if (typeof api.readClipboard !== "function") return
      try {
        const snapshot = await api.readClipboard()
        if (snapshot.text) { const start = area?.selectionStart ?? caret(); insertPasted(snapshot.text, start, area?.selectionEnd ?? start) }
      } catch {}
    })()
  }
  return <div class="composer-field"><label class="desktop__field"><span class="desktop__sr">{props.label}</span><textarea ref={area} rows={1} value={props.value} readOnly={props.locked} role="combobox" aria-expanded={open()} aria-controls={open() ? listID : undefined} aria-activedescendant={open() && items()[active()] ? `${listID}-${active()}` : undefined} aria-autocomplete="list" aria-describedby="message-hint" placeholder="Message YCoding" onInput={(event) => { props.onInput(event.currentTarget.value); at(event) }} onKeyUp={at} onClick={at} onPaste={paste}
    onKeyDown={(event) => {
      if (isStandardEditShortcut(event)) return
      if (open() && items().length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setActive((index) => (index + (event.key === "ArrowDown" ? 1 : items().length - 1)) % items().length); return }
      if (open() && items()[active()] && (event.key === "Enter" || event.key === "Tab") && !event.isComposing) { event.preventDefault(); choose(items()[active()]); return }
      if (event.key === "Enter" && open() && !event.isComposing) { event.preventDefault(); setDismissed(token()); return }
      if (event.key === "Escape" && open()) { event.preventDefault(); setDismissed(token()); return }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !props.locked) { event.preventDefault(); props.onSubmit() }
    }} />
    <span id="message-hint" class="desktop__sr">Enter sends. Shift+Enter adds a line. {mac ? "⌘K" : "Ctrl K"} opens commands. Slash, dollar and at-sign open suggestions.</span></label>
    <Show when={open()}><div class="composer-suggestions" role="listbox" id={listID} aria-label="Composer suggestions"><For each={items()}>{(item, index) => <div id={`${listID}-${index()}`} role="option" class="composer-suggestion" aria-selected={index() === active()} onPointerMove={() => setActive(index())} onPointerDown={(event) => { event.preventDefault(); choose(item) }}><Icon name={item.icon} /><span class="composer-suggestion__label">{item.label}</span><Show when={item.description}>{(text) => <span class="composer-suggestion__desc">{text()}</span>}</Show></div>}</For><Show when={status()}>{(text) => <p class="composer-suggestions__status" role="status">{text()}</p>}</Show></div></Show></div>
}

function ModelPopover(props: { chipLabel: string; effortLabel?: string; disabled?: boolean; busy?: boolean; models: readonly import("./contract").ModelOption[]; choice: ModelChoice; openTick?: number; onPick: (choice: ModelChoice) => void; onRefresh: () => void; refreshing: boolean; children?: JSX.Element }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  let chip: HTMLButtonElement | undefined
  let wasTick = props.openTick ?? 0
  createEffect(() => { const tick = props.openTick ?? 0; if (tick !== wasTick) { wasTick = tick; setOpen(true) } })
  createEffect(() => { if (paletteOpen()) setOpen(false) })
  const selectedModel = () => props.models[props.choice.model]
  const variants = () => variantsFor(selectedModel(), props.choice.profile)
  const stops = () => effortStopsFor(variants())
  const [drag, setDrag] = createSignal<{ pointerID: number; fraction: number }>()
  let slider: HTMLDivElement | undefined
  const selectedIdx = () => effortStopIndex(stops(), props.choice.variant)
  const dragIndex = () => { const current = drag(); return current ? Math.round(current.fraction * Math.max(0, stops().length - 1)) : undefined }
  const activeTone = () => stops()[dragIndex() ?? selectedIdx()]?.tone ?? "unselected"
  const fraction = () => drag()?.fraction ?? effortStopFraction(selectedIdx(), stops().length)
  const glow = () => props.choice.variant === "" && !drag() ? 0 : (drag()?.fraction ?? (stops().length ? (selectedIdx() + 1) / stops().length : 0))
  const trackFraction = (clientX: number) => { const rect = slider!.getBoundingClientRect(); const inset = 14; return Math.max(0, Math.min(1, (clientX - rect.left - inset) / Math.max(1, rect.width - inset * 2))) }
  let stopDrag: (() => void) | undefined
  const startDrag = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (props.busy || event.button !== 0 && event.pointerType === "mouse") return
    event.preventDefault(); event.stopPropagation()
    stopDrag?.()
    slider?.focus({ preventScroll: true })
    const pointerID = event.pointerId
    const target = event.currentTarget
    try { target.setPointerCapture(pointerID) } catch {}
    setDrag({ pointerID, fraction: trackFraction(event.clientX) })
    const move = (next: PointerEvent) => { if (next.pointerId === pointerID) setDrag({ pointerID, fraction: trackFraction(next.clientX) }) }
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", abandon); try { target.releasePointerCapture(pointerID) } catch {}; stopDrag = undefined; setDrag(undefined) }
    const release = (next: PointerEvent) => { if (next.pointerId !== pointerID) return; const index = Math.round(trackFraction(next.clientX) * Math.max(0, stops().length - 1)); end(); applyStop(index) }
    const abandon = (next: PointerEvent) => { if (next.pointerId === pointerID) end() }
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", release); window.addEventListener("pointercancel", abandon)
    stopDrag = end
  }
  onCleanup(() => stopDrag?.())
  const applyStop = (index: number) => { const stop = stops()[index]; if (!stop || props.busy) return; props.onPick({ ...props.choice, variant: stop.value }) }
  const effortSparkles = [{ x: 6, y: 34, delay: 0, size: 2 }, { x: 13, y: 66, delay: 0.7, size: 1.5 }, { x: 21, y: 28, delay: 1.3, size: 2.5 }, { x: 29, y: 58, delay: 0.4, size: 1.5 }, { x: 37, y: 40, delay: 1.9, size: 2 }, { x: 44, y: 70, delay: 1.1, size: 1.5 }, { x: 52, y: 30, delay: 0.2, size: 2.5 }, { x: 60, y: 62, delay: 1.6, size: 2 }, { x: 68, y: 44, delay: 0.9, size: 1.5 }, { x: 76, y: 26, delay: 1.4, size: 2 }, { x: 83, y: 64, delay: 0.5, size: 2.5 }, { x: 91, y: 38, delay: 1.8, size: 1.5 }] as const
  const filtered = () => props.models.map((model, index) => ({ model, index })).filter(({ model }) => !query() || modelLabel(model).toLowerCase().includes(query().toLowerCase()))
  const close = () => { setOpen(false); chip?.focus() }
  const pick = (choice: ModelChoice) => { props.onPick(choice); setOpen(false); chip?.focus() }
  return <div class="composer-anchor" onFocusOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }} onKeyDown={(event) => {
    if (event.key === "Escape" && open()) { event.preventDefault(); close(); return }
    if (open() && (event.key === "ArrowDown" || event.key === "ArrowUp")) { const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".model-popover__option:not(:disabled)")]; if (options.length) { event.preventDefault(); const index = options.indexOf(document.activeElement as HTMLButtonElement); options[(index + (event.key === "ArrowDown" ? 1 : options.length - 1) + options.length) % options.length]?.focus() } }
  }}>
    <button ref={chip} type="button" class="composer-chip composer-chip--model" aria-haspopup="dialog" aria-expanded={open()} disabled={props.disabled} onClick={() => setOpen(!open())}><span>{props.chipLabel}</span><Icon name="chevron-down" /></button><Show when={props.effortLabel}>{(effort) => <button type="button" class="composer-chip composer-chip--effort" aria-haspopup="dialog" aria-expanded={open()} disabled={props.disabled} onClick={() => setOpen(!open())}><span class="composer-chip__key">effort</span><span class="composer-chip__effort">{effort()}</span></button>}</Show>
    <Show when={open()}><div class="desktop-popover model-popover" role="dialog" aria-label="Model and reasoning effort" data-level={activeTone()}>
      <Show when={props.models.length > 8}><label class="desktop__field model-popover__search"><span class="desktop__sr">Search models</span><input type="search" value={query()} placeholder="Search models" onInput={(event) => setQuery(event.currentTarget.value)} /></label></Show>
      <div class="model-popover__list" role="listbox" aria-label="Model">
        <For each={filtered()}>{({ model, index }) => <button type="button" role="option" class="model-popover__option" aria-selected={props.choice.model === index} disabled={props.busy} onClick={() => pick(chooseModel([...props.models], index))}><span>{modelLabel(model)}</span><Show when={props.choice.model === index}><Icon name="check" /></Show></button>}</For>
        <Show when={!filtered().length}><p role="status" class="desktop__muted">No models match.</p></Show>
      </div>
      <Show when={selectedModel()?.profiles.length || props.choice.profile !== ""}><p class="model-popover__label">Profile</p><SharedRadioGroup label="Profile" options={[{ value: "", label: "No profile", disabled: !selectedModel()?.enabled }, ...(selectedModel()?.profiles ?? []).map((profile) => ({ value: profile.name, label: profileLabel(profile) }))]} value={props.choice.profile} disabled={props.busy} onChange={(value) => pick(chooseProfile([...props.models], props.choice, value))} /></Show>
      <Show when={stops().length > 1 || props.choice.variant !== ""}><div class="model-slider__head"><p class="model-popover__label">Reasoning effort</p><strong class="model-slider__badge">{stops()[dragIndex() ?? selectedIdx()]?.label ?? "Default"}</strong><button type="button" class="rl-icon-button model-slider__reset" aria-label="Reset reasoning effort" disabled={props.choice.variant === "" || props.busy} onPointerDown={(event) => event.preventDefault()} onClick={() => { slider?.focus(); props.onPick({ ...props.choice, variant: "" }) }}><Icon name="reset" /></button></div><div class="model-slider" classList={{ "model-slider--dragging": !!drag() }} ref={(element) => { slider = element }} role="slider" tabindex="0" aria-label="Reasoning effort" aria-valuemin={0} aria-valuemax={stops().length - 1} aria-valuenow={selectedIdx()} aria-valuetext={stops()[selectedIdx()]?.label ?? "Default"} aria-disabled={props.busy} onKeyDown={(event) => { const next = event.key === "Home" ? 0 : event.key === "End" ? stops().length - 1 : event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? Math.min(stops().length - 1, selectedIdx() + 1) : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? Math.max(0, selectedIdx() - 1) : undefined; if (next === undefined) return; event.preventDefault(); event.stopPropagation(); applyStop(next) }} onPointerDown={startDrag}><div class="model-slider__track" style={{ "--composer-effort-fraction": String(fraction()), "--composer-effort-glow": String(glow()) }}><span class="model-slider__ticks" aria-hidden="true"><For each={stops()}>{(_, index) => <i style={{ left: `calc(14px + ${effortStopFraction(index(), stops().length)} * (100% - 28px))` }} />}</For></span><div class="model-slider__fill" style={{ width: `calc(28px + ${fraction()} * (100% - 28px))` }}><span class="model-slider__flow" aria-hidden="true" /><For each={[props.choice.variant]}>{() => <div class="model-slider__sparkles" aria-hidden="true"><For each={[...effortSparkles.map((sparkle) => ({ ...sparkle, x: sparkle.x / 2 })), ...effortSparkles.map((sparkle) => ({ ...sparkle, x: 50 + sparkle.x / 2 }))]}>{(sparkle) => <i style={{ left: `${sparkle.x}%`, top: `${sparkle.y}%`, "--composer-sparkle-delay": `${-sparkle.delay}s`, "--composer-sparkle-size": `${sparkle.size}px` }} />}</For></div>}</For></div><span class="model-slider__thumb" style={{ left: `calc(14px + ${fraction()} * (100% - 28px))` }} /></div></div><div class="model-slider__labels"><For each={stops()}>{(stop, index) => <button type="button" class="model-slider__label" data-edge={index() === 0 ? "start" : index() === stops().length - 1 ? "end" : undefined} style={index() === 0 ? { left: "0px" } : index() === stops().length - 1 ? { right: "0px" } : { left: `calc(14px + ${effortStopFraction(index(), stops().length)} * (100% - 28px))` }} disabled={props.busy} onPointerDown={(event) => event.preventDefault()} onClick={() => { slider?.focus(); applyStop(index()) }} data-active={selectedIdx() === index() ? "true" : undefined}>{stop.label}</button>}</For></div></Show>
      {props.children}
      <div class="model-popover__foot"><button type="button" class="rl-btn" disabled={props.refreshing} onClick={props.onRefresh}>Refresh models</button></div>
    </div></Show>
  </div>
}

export function promptFilesFor(attached: readonly PromptFile[], mentioned: readonly PromptFile[]) {
  return [...attached.filter((file) => !mentioned.some((mention) => mention.uri === file.uri)), ...mentioned]
}

function AttachButton(props: { directory?: string; files?: readonly PromptFile[]; onChange?: (files: PromptFile[]) => void; locked?: boolean }) {
  return <><button type="button" class="rl-attach" aria-label="Attach files" disabled={props.locked || !props.onChange || !reading()} onClick={() => openFolderPicker({ title: "Attach workspace file", mode: "file", initialDirectory: props.directory, onPick: (path) => { const name = path.split("/").at(-1) ?? path; props.onChange?.(promptFilesFor(props.files ?? [], [{ uri: `file://${path}`, name }])) } })}><Icon name="clip" /></button><Show when={props.files?.length}><div class="composer-attachments" aria-label="Attached workspace files"><For each={props.files}>{(file) => <span class="composer-attachments__chip"><Icon name="file" /><span>{file.name ?? file.uri}</span><button type="button" class="rl-icon" aria-label={`Remove ${file.name ?? file.uri}`} disabled={props.locked} onClick={() => props.onChange?.((props.files ?? []).filter((item) => item.uri !== file.uri))}><Icon name="close" /></button></span>}</For></div></Show></>
}
function NewChat() {
  const navigate = useNavigate()
  const workspaces = observe(() => ({ queryKey: ["workspaces", ...scope()] as const, queryFn: () => api.workspaces(), enabled: reading() }))
  const catalog = observe(() => ({ queryKey: ["new-chat-models", ...scope(), newDirectory().trim()] as const, queryFn: () => api.models({ directory: newDirectory().trim() }), enabled: reading() }))
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = createSignal(false)
  const [newPicks, setNewPicks] = createSignal<MentionPick[]>([])
  const [files, setFiles] = createSignal<PromptFile[]>(newPending()?.files ?? [])
  const [newModelTick, setNewModelTick] = createSignal(0)
  const newSlash = localSlash.filter((command) => { const parsed = desktopSlashCommand(`/${command.name}`, []); return parsed && (!sessionCommands.has(parsed.kind) || parsed.kind === "stash") })
  const [newAutonomy, setNewAutonomy] = createSignal<"" | "manual" | "auto" | "yolo">("")
  const [autonomyMenuOpen, setAutonomyMenuOpen] = createSignal(false)
  const [chosen, setChosen] = createSignal<ModelChoice>()
  createEffect(() => { void newDirectory(); void scope(); setChosen(undefined) })
  const data = () => { const value = catalog.result().isError ? undefined : catalog.result().data; return value && !("sessionID" in value.source) && (value.source.directory ?? "") === newDirectory().trim() && value.revision === connection().revision ? value : undefined }
  const list = () => visibleModels(data()?.models ?? [], data()?.default)
  const choice = () => chosen() ?? choiceFor(list(), data()?.default)
  const selected = () => list()[choice().model]
  const picked = () => data() ? selectionFor(list(), choice()) : undefined
  const selectedWorkspaceName = () => available().find((item) => item.directory === newDirectory())?.name ?? newDirectory()
  const setDirectory = (directory: string) => { if (!newPending()) { setNewDirectory(directory); setWorkspaceMenuOpen(false) } }
  const pickFolder = (mode: "directory" | "create-directory") => { setWorkspaceMenuOpen(false); openFolderPicker({ title: mode === "directory" ? "Open workspace folder" : "Create new workspace folder", mode, initialDirectory: newDirectory() || undefined, onPick: setDirectory }) }
  const runCommand = async (name: string, args: string) => {
    if (newPending()) return false
    if (name === "models") { setNewModelTick((tick) => tick + 1); return true }
    if (name === "stash") { setStashDialog({ text: () => newText(), update: setNewText, directory: newDirectory() || undefined }); return true }
    return commonCommand(name, args, { source: newDirectory() ? { directory: newDirectory() } : undefined, directory: newDirectory() || undefined, insert: (value) => setNewText((text) => text + value) }, (to) => void navigate({ to }))
  }
  onMount(() => { const owner = { run: runCommand }; setCommandOwner(owner); onCleanup(() => { if (commandOwner() === owner) setCommandOwner(undefined) }) })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const available = () => workspaces.result().data ?? []
  const ready = () => !!newPending() || ((!newDirectory() || available().some((item) => item.directory === newDirectory()) || openedDirectories().has(newDirectory())) && !!newText().trim())
  const start = async () => {
    if (busy() || !reading() || !ready()) return
    let pendingCommand: { name: string; arguments?: string } | undefined
    if (!newPending() && /^\/[A-Za-z0-9]/.test(newText())) {
      const catalogKey = ["composer-catalog", ...scope(), newDirectory().trim()] as const
      let cached = queries.getQueryData<ComposerCatalog>(catalogKey)
      if ((!cached || cached.revision !== connection().revision) && typeof api.composerCatalog === "function") {
        setBusy(true)
        try { const fresh = await api.composerCatalog(newDirectory().trim() ? { directory: newDirectory().trim() } : undefined); if (fresh.revision === connection().revision) { queries.setQueryData(catalogKey, fresh); cached = fresh } }
        catch { cached = undefined }
        finally { setBusy(false) }
      }
      const action = composerSlash(newText(), (cached?.commands ?? []).map((command) => command.name))
      if (action.kind === "backend") pendingCommand = { name: action.name, ...(action.args ? { arguments: action.args } : {}) }
      else if (action.kind === "local") {
        try { if (!(await runCommand(action.name, action.args))) { setError("Open a Session to use this command."); return } }
        catch (cause) { setError(failure(cause, "The command was not confirmed.")); return }
        setNewText(""); setNewPicks([])
        return
      }
    }
    const mentioned = newPending() ? undefined : mentionPayload(newText(), newPicks())
    const payload = mentioned ? { ...mentioned, files: promptFilesFor(files(), mentioned.files) } : undefined
    const draft = newPending() ?? { directory: newDirectory(), sessionID: `ses_${crypto.randomUUID()}`, promptID: `msg_${crypto.randomUUID()}`, text: newText(), ...(pendingCommand ? { command: pendingCommand } : { ...(payload?.files.length ? { files: payload.files } : {}), ...(payload?.agents.length ? { agents: payload.agents } : {}) }), created: false, ...(chosen() && picked() && !sameSelection(picked(), data()?.default) ? { model: picked(), modelRevision: data()?.revision } : {}), ...(newAutonomy() ? { autonomy: newAutonomy() as "manual" | "auto" | "yolo", autonomyRevision: connection().revision } : {}) }
    const generation = connection().generation
    setNewPending(draft)
    setNewUnconfirmed(false)
    setBusy(true)
    setError(undefined)
    try {
      if (chosen() && !picked()) throw new Error("Select a valid model before starting the chat.")
      if (!draft.created) {
        await api.createSession(draft.directory ? { directory: draft.directory, sessionID: draft.sessionID } : { sessionID: draft.sessionID })
        if (connection().generation !== generation) return
        setNewPending({ ...draft, created: true })
        refresh(["sessions"])
      }
      if (draft.model && !draft.switched) {
        const revision = connection().revision
        if (revision === undefined || draft.modelRevision !== revision) throw new Error("The model catalog changed. Open the Session and review its model before sending.")
        if (draft.switchAttempted) {
          const current = await api.models(draft.sessionID)
          if (connection().generation !== generation) return
          if (!("current" in current) || current.revision !== connection().revision || !sameSelection(current.current, draft.model)) throw new Error("The model switch was not confirmed. Open the Session and review its model before sending.")
        } else {
          setNewPending({ ...newPending()!, created: true, switchAttempted: true })
          await api.switchModel({ sessionID: draft.sessionID, revision, model: draft.model })
          if (connection().generation !== generation) return
        }
        setNewPending({ ...newPending()!, created: true, switchAttempted: true, switched: true })
      }
      if (draft.autonomy && !draft.autonomyApplied) {
        const revision = connection().revision
        if (revision === undefined || revision !== draft.autonomyRevision || typeof api.setAutonomy !== "function" || typeof api.autonomy !== "function") throw new Error("Autonomy settings are unavailable. Open the Session and review its state before sending.")
        if (draft.autonomyAttempted) {
          const current = await api.autonomy(draft.sessionID)
          if (connection().generation !== generation) return
          if (current.revision !== revision || current.sessionID !== draft.sessionID || current.autonomy.permissions !== draft.autonomy || current.autonomy.guardrails !== draft.autonomy || current.autonomy.answers !== draft.autonomy) throw new Error("Autonomy was not confirmed. Open the Session and review its state before sending.")
        } else {
          if (!(await confirmInPage(`Set permissions, guardrails and answers to ${draft.autonomy} before sending?`))) return
          setNewPending({ ...newPending()!, created: true, autonomyAttempted: true })
          const changed = await api.setAutonomy({ sessionID: draft.sessionID, revision, payload: { permissions: draft.autonomy, guardrails: draft.autonomy, answers: draft.autonomy } })
          if (connection().generation !== generation || connection().revision !== revision) return
          if (changed.revision !== revision || changed.sessionID !== draft.sessionID || changed.autonomy.permissions !== draft.autonomy || changed.autonomy.guardrails !== draft.autonomy || changed.autonomy.answers !== draft.autonomy) throw new Error("Autonomy was not confirmed. Open the Session and review its state before sending.")
        }
        setNewPending({ ...newPending()!, created: true, autonomyAttempted: true, autonomyApplied: true })
      }
      if (draft.command) await api.command({ sessionID: draft.sessionID, promptID: draft.promptID, command: draft.command.name, ...(draft.command.arguments ? { arguments: draft.command.arguments } : {}) })
      else await api.prompt({ sessionID: draft.sessionID, promptID: draft.promptID, text: draft.text, ...(draft.files ? { files: draft.files } : {}), ...(draft.agents ? { agents: draft.agents } : {}) })
      if (connection().generation !== generation) return
      setNewPending(undefined)
      setNewPicks([])
      setFiles([])
      setNewText("")
      await navigate({ to: "/sessions/$sessionID", params: { sessionID: draft.sessionID } })
    } catch (cause) { if (connection().generation === generation) setError(failure(cause, "The chat was not confirmed. Check Recent Sessions, then retry.")) }
    finally { setBusy(false) }
  }
  return <section class="conversation" data-new-chat aria-labelledby="new-chat-title"><SharedConversationHeader class="rl-top" actions={<div class="rl-top-actions"><SharedContextRingButton class="rl-context-ring" ariaLabel="Open Session context" expanded={companionOpen() && companionTab() === "Context"} label={<><strong>Unknown</strong><small>—</small></>} onClick={() => { setCompanionTab("Context"); setCompanionOpen(true) }} /><button type="button" class="rl-icon rl-companion-toggle" aria-label={companionOpen() ? "Close Session companion" : "Open Session companion"} aria-expanded={companionOpen()} onClick={() => setCompanionOpen(!companionOpen())}><Icon name="team" /></button><button type="button" class="rl-icon desktop__palette" aria-label={`Commands ${mac ? "⌘K" : "Ctrl K"}`} aria-keyshortcuts={mac ? "Meta+K" : "Control+K"} onClick={() => setPaletteOpen(true)}><Icon name="more" /></button></div>}><button type="button" class="desktop__rail-toggle rl-mobile-menu" aria-label="Open navigation" aria-expanded={railOpen()} aria-controls="session-rail" onClick={() => setRailOpen(true)}><Icon name="menu" /></button><span class="rl-mobile-brand"><Brand /></span><div class="rl-ident"><h1 id="new-chat-title" class="rl-title" tabindex="-1" ref={focusHeading}>New chat</h1><p class="rl-presence" data-tone="idle"><span>This Mac · {newDirectory() || "No workspace selected"} · {connectionOwnership()}</span></p></div></SharedConversationHeader><div class="rl-scroll"><div class="rl-col rl-thread"><div class="rl-intro"><Brand /><p class="rl-eyebrow">A LITTLE CONTEXT. A CLEAR NEXT STEP.</p><p class="rl-intro-title">Start with a conversation.</p>
    <p class="desktop__muted">No Project or filesystem Workspace is required. Start standalone, or explicitly add a workspace for context.</p><Show when={!available().length}><div class="desktop__actions"><button type="button" class="rl-btn" disabled={!!newPending() || busy()} onClick={() => pickFolder("directory")}><Icon name="folder" />Open folder…</button><button type="button" class="rl-btn" disabled={!!newPending() || busy()} onClick={() => pickFolder("create-directory")}><Icon name="folder-plus" />New folder…</button></div></Show><div class="rl-menu-anchor" onKeyDown={(event) => { if (event.key === "Escape") { setWorkspaceMenuOpen(false); event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus() } else if (event.key === "ArrowDown" || event.key === "ArrowUp") { const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]; if (items.length) { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length]?.focus() } } }}><button type="button" class="rl-btn" aria-haspopup="menu" aria-expanded={workspaceMenuOpen()} disabled={!!newPending()} onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen())}><Icon name="folder" />{newDirectory().trim() ? `Context · ${selectedWorkspaceName()}` : "Context · No workspace"}</button><Show when={workspaceMenuOpen()}><div class="rl-owned-menu" role="menu"><button type="button" role="menuitem" onClick={() => pickFolder("directory")}><Icon name="folder" />Open folder…</button><button type="button" role="menuitem" onClick={() => pickFolder("create-directory")}><Icon name="folder-plus" />New folder…</button><button type="button" role="menuitem" onClick={() => setDirectory("")}><span><strong>Standalone · no filesystem context</strong><small>Start without a repository</small></span></button><For each={available()}>{(item) => <button type="button" role="menuitem" onClick={() => setDirectory(item.directory)}><span><strong>{item.name && item.name !== item.directory ? item.name : workspaceBase(item.directory)}</strong><small>{item.directory}</small></span></button>}</For><button type="button" role="menuitem" class="rl-textlink" onClick={workspaces.refetch} disabled={workspaces.result().isFetching || !reading()}>Refresh repositories</button></div></Show></div><p class="rl-prototype-note">{newDirectory().trim() ? `Selected workspace · ${selectedWorkspaceName() === newDirectory() ? newDirectory() : `${selectedWorkspaceName()} (${newDirectory()})`}.` : "No filesystem workspace is selected unless you choose one. Server-default placement applies until you pick a repository."}</p></div></div></div>
    <div class="rl-dock"><div class="rl-col"><SharedComposerSurface formClass="composer" busy={busy()} onSubmit={(event) => { event.preventDefault(); void start() }} field={<div class="rl-capsule"><ComposerField label="First message" value={newPending()?.text ?? newText()} locked={!!newPending()} source={newDirectory().trim() ? { directory: newDirectory().trim() } : undefined} directory={newDirectory().trim()} localCommands={newSlash} picks={newPicks()} onPicks={setNewPicks} onInput={setNewText} onSubmit={() => void start()} onAttachFiles={(added) => setFiles((current) => promptFilesFor(current, added))} /><div class="composer-bar"><AttachButton directory={newDirectory() || undefined} files={files()} onChange={setFiles} locked={!!newPending() || busy()} /><Show when={data()} fallback={<button type="button" class="composer-chip" disabled><span>{picked()?.id ?? "Model"}</span></button>}><ModelPopover chipLabel={selected()?.name ?? picked()?.id ?? data()?.default?.id ?? "Choose a model"} effortLabel={choice().variant || undefined} busy={!!newPending() || !reading()} models={list()} choice={choice()} openTick={newModelTick()} onPick={setChosen} onRefresh={catalog.refetch} refreshing={catalog.result().isFetching}><Show when={choiceProblem(list(), choice())}>{(problem) => <p role="status" class="desktop__muted">{problem()}</p>}</Show></ModelPopover></Show><div class="rl-menu-anchor rl-autonomy" onFocusOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAutonomyMenuOpen(false) }} onKeyDown={(event) => { if (event.key === "Escape" && autonomyMenuOpen()) { setAutonomyMenuOpen(false); event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus() } else if (event.key === "ArrowDown" || event.key === "ArrowUp") { const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]; if (items.length) { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length]?.focus() } } }}><button type="button" class="composer-chip" aria-haspopup="menu" aria-expanded={autonomyMenuOpen()} disabled={!!newPending() || typeof api.setAutonomy !== "function"} onClick={(event) => { const anchor = event.currentTarget.parentElement; const opening = !autonomyMenuOpen(); setAutonomyMenuOpen(opening); if (opening) queueMicrotask(() => anchor?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()) }}><span>Autonomous {stagedAutonomyLabels[newAutonomy()]}</span></button><Show when={autonomyMenuOpen()}><div class="rl-owned-menu" role="menu" aria-label="Staged autonomy"><For each={autonomyChoices}>{(mode) => <button type="button" role="menuitemradio" aria-checked={newAutonomy() === mode} onClick={(event) => { const trigger = event.currentTarget.closest(".rl-autonomy")?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]'); setNewAutonomy(mode); setAutonomyMenuOpen(false); trigger?.focus() }}><span>{stagedAutonomyLabels[mode]}</span></button>}</For></div></Show></div><span class="composer-bar__spacer" /><Show when={catalog.result().isError}><span role="alert" class="desktop__error composer-bar__note">{failure(catalog.result().error, "Model catalog could not be read. Refresh models to retry.")}</span></Show><button type="submit" class="rl-send desktop__primary" aria-label={busy() ? "Starting the chat" : newPending() ? "Retry starting the chat" : "Send prompt"} disabled={busy() || !reading() || !ready()}><Icon name="arrow-up" /></button></div></div>} /><Show when={newUnconfirmed()}><p role="status">The previous attempt was not confirmed before the connection changed. Check Sessions before sending again.</p></Show>
      <div class="desktop__feedback">
        <Show when={workspaces.result().isPending && reading()}><SharedLoadingSkeleton kind="list" label="Loading previously opened repositories…" /></Show>
        <Show when={workspaces.result().isError}><p role="alert" class="desktop__error">Previously opened repositories could not be read. Refresh to retry.</p></Show>
        <Show when={workspaces.result().isSuccess && !available().length}><p role="status">No previously opened folders are available. Choose Open folder or New folder to add workspace context.</p></Show>
      </div>
      <div class="desktop__feedback"><Show when={error()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show><Show when={busy()}><p role="status">Starting the chat…</p></Show></div>
      <div class="desktop__actions"><Show when={newPending() && !busy()}><button type="button" onClick={() => { setNewText(newPending()?.text ?? ""); setNewPending(undefined); setError(undefined) }}>Edit draft</button></Show></div></div></div>
    <Show when={companionOpen()}><aside class="rl-companion"><SharedCompanionSurface active={companionTab().toLowerCase() as "activity" | "changes" | "context"} onSelect={(tab) => setCompanionTab(tab === "activity" ? "Activity" : tab === "changes" ? "Changes" : "Context")} headerActions={<button type="button" class="rl-icon" aria-label="Close companion" onClick={() => setCompanionOpen(false)}><Icon name="close" /></button>} activityContent={<p class="rl-pane-body">Activity is available after a Session starts.</p>} changesContent={<p class="rl-pane-body">No Session changes are available yet.</p>} contextContent={<p class="rl-pane-body">Context is not reported until a response is available.</p>} /></aside></Show>
  </section>
}

export function autonomyLabels(view: { readonly goal?: { readonly text: string; readonly status: string } | null; readonly effective: { readonly permissions: string; readonly guardrails: string; readonly answers: string; readonly asleep: boolean } } | undefined) {
  if (!view) return { goal: "Goal · Unknown", autonomy: "Autonomy · Unknown" }
  const mode = view.effective
  const label = mode.asleep ? "Asleep" : mode.permissions !== mode.guardrails || mode.guardrails !== mode.answers ? "Mixed" : mode.permissions === "manual" ? "Manual" : mode.permissions === "auto" ? "Auto" : "YOLO"
  return { goal: view.goal ? `Goal · ${view.goal.status === "active" ? "Active" : view.goal.status}` : "Goal · Off", autonomy: `Autonomy · ${label}` }
}

export function autonomyMatches(view: { readonly permissions: string; readonly guardrails: string; readonly answers: string; readonly goal?: { readonly text: string; readonly status?: string; readonly maxNoProgress?: number } | null; readonly sleep?: object | null }, payload: SetAutonomyInput["payload"]) {
  if (payload.permissions != null && view.permissions !== payload.permissions) return false
  if (payload.guardrails != null && view.guardrails !== payload.guardrails) return false
  if (payload.answers != null && view.answers !== payload.answers) return false
  if ((typeof payload.goal === "string" || payload.goal === true) && (!view.goal?.text.trim() || view.goal.status !== "active")) return false
  if ("goal" in payload && payload.goal === null && view.goal != null && view.goal.status !== "stopped") return false
  if (payload.maxNoProgress != null && view.goal?.maxNoProgress !== payload.maxNoProgress) return false
  if (typeof payload.sleep === "boolean" && Boolean(view.sleep) !== payload.sleep) return false
  return true
}

export function shellOwner(shells: readonly { readonly id: string; readonly ownerSessionID: string }[], shellID: string, fallback: string) {
  return shells.find((shell) => shell.id === shellID)?.ownerSessionID ?? fallback
}

export const workspaceKeyOf = (entry: { readonly projectID: string; readonly directory: string }) => `${entry.projectID}:${entry.directory}`

export function selectedWorkspaceOf<T extends { readonly projectID: string; readonly directory: string }>(items: readonly T[], selectedID: string | undefined) {
  return selectedID === undefined ? items[0] : items.find((item) => workspaceKeyOf(item) === selectedID)
}

export function lastOpenedSessionOf<T extends { readonly id: string }>(items: readonly T[], sessionID: string | undefined) {
  return sessionID ? items.find((item) => item.id === sessionID) : undefined
}

type ConfirmRequest = { readonly prompt: string; readonly resolve: (value: boolean) => void }
let confirmOpener: ((prompt: string) => Promise<boolean>) | undefined
export function confirmInPage(prompt: string): Promise<boolean> {
  return confirmOpener ? confirmOpener(prompt) : Promise.resolve(false)
}

function ConfirmDialog() {
  const [request, setRequest] = createSignal<ConfirmRequest>()
  let dialog: HTMLDialogElement | undefined
  confirmOpener = (prompt) => new Promise<boolean>((resolve) => {
    if (request() || !dialog) { resolve(false); return }
    setRequest({ prompt, resolve })
    dialog.showModal()
  })
  const finish = (value: boolean) => {
    const current = request()
    if (!current) return
    setRequest(undefined)
    dialog?.close()
    current.resolve(value)
  }
  return <dialog ref={dialog} class="confirm" aria-labelledby="confirm-title" onClose={() => finish(false)} onCancel={(event) => { event.preventDefault(); finish(false) }}>
    <h2 id="confirm-title">Confirm</h2>
    <p>{request()?.prompt}</p>
    <div class="confirm__actions"><button type="button" class="rl-btn" onClick={() => finish(false)}>Cancel</button><button type="button" class="rl-btn" data-primary="true" onClick={() => finish(true)}>Confirm</button></div>
  </dialog>
}

export function createActionGuard<T, R>(confirm: (prompt: string) => boolean | Promise<boolean>, scope: () => string, dispatch: (request: T) => Promise<R>) {
  let uncertain = false, busy = false
  return {
    async run(request: T, prompt: string): Promise<{ status: "cancelled" | "blocked" | "unconfirmed"; error?: unknown } | { status: "completed"; value: R }> {
      if (uncertain || busy) return { status: "blocked" }
      if (!(await confirm(prompt))) return { status: "cancelled" }
      const starting = scope(); busy = true
      try { const value = await dispatch(request); if (scope() !== starting) { uncertain = true; return { status: "unconfirmed" } } return { status: "completed", value } }
      catch (error) { uncertain = true; return { status: "unconfirmed", error } }
      finally { busy = false }
    },
    reset() { if (!busy) uncertain = false },
  }
}

type StagedRevert = { readonly messageID: string; readonly files?: readonly unknown[] }

export function activeRevertOf(item: { readonly revert?: StagedRevert } | undefined, local: StagedRevert | undefined) {
  return item?.revert ?? local
}

export function createPromptGuard<T>(options: { scope: () => string; read: (sessionID: string) => Promise<{ revision: number; item: { id: string; revert?: StagedRevert } }>; confirm: (prompt: string) => boolean | Promise<boolean>; observe: (revert: StagedRevert) => void; dispatch: (draft: T) => Promise<unknown> }) {
  let uncertain = false, busy = false
  return {
    reset: () => { uncertain = false },
    async run(sessionID: string, revision: number, local: StagedRevert | undefined, draft: T): Promise<{ status: "blocked" | "declined" | "completed" | "unconfirmed"; error?: unknown }> {
      if (uncertain || busy) return { status: "blocked" }
      busy = true
      const starting = options.scope()
      try {
        const latest = await options.read(sessionID)
        if (options.scope() !== starting || latest.revision !== revision || latest.item.id !== sessionID) throw new Error("The Session or connection changed during the pre-send check.")
        const pending = activeRevertOf(latest.item, local)
        if (pending) {
          options.observe(pending)
          if (!(await options.confirm(`A revert to message ${pending.messageID} is staged. Sending this message will permanently commit the revert and remove later turns. Send and commit revert?`))) return { status: "declined" }
        }
        if (options.scope() !== starting) throw new Error("The connection changed before sending.")
        await options.dispatch(draft)
        if (options.scope() !== starting) throw new Error("The connection changed while sending.")
        return { status: "completed" }
      } catch (error) { uncertain = true; return { status: "unconfirmed", error } }
      finally { busy = false }
    },
  }
}

export function toolSteps(parts: readonly Extract<Extract<Messages[number], { type: "assistant" }>["content"][number], { type: "tool" }>[]) {
  return parts.map((part) => ({ id: part.id, name: part.name, status: part.state.status === "error" ? "failed" as const : part.state.status, summary: toolDisplaySummary(part.name, part.state.input), markdown: part.name === "subagent" || part.name === "question", inputText: (typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input, null, 2)).slice(0, 8192), ...(part.state.status === "streaming" ? {} : { outputText: part.state.content.flatMap((entry) => entry.type === "text" ? [entry.text] : []).join("\n").slice(0, 8192) }), ...(part.state.status === "error" ? { errorText: part.state.error.message.slice(0, 8192) } : {}) }))
}

export function retainedMessages(messages: readonly Messages[number][]) {
  return messages.map((message) => ({ id: message.id, role: message.type, summary: message.type === "user" || message.type === "system" || message.type === "synthetic" ? message.text.slice(0, 160) : message.type === "shell" ? message.command.slice(0, 160) : message.type }))
}

function CompactionView(props: { message: Extract<Messages[number], { type: "compaction" }> }) {
  const metrics = () => "metrics" in props.message ? props.message.metrics : undefined
  const summary = () => "summary" in props.message ? props.message.summary ?? "" : ""
  const hasMetrics = () => props.message.status === "completed" && !!metrics()?.inputTokens
  const reduction = () => hasMetrics() ? Math.round(100 * (metrics()!.inputTokens - metrics()!.retainedTokens) / metrics()!.inputTokens) : 0
  return <SharedCompactionDivider completed={hasMetrics()} status={props.message.status} label={`Compaction · ${props.message.status}`} total={hasMetrics() ? `${formatCompactCount(metrics()!.inputTokens)} -> ${formatCompactCount(metrics()!.retainedTokens)} tokens` : "Session compaction"} reduction={reduction()} number={metrics() ? `${formatCount(metrics()!.retainedTokens)} retained tokens (${reduction()}% reduced)` : props.message.status === "completed" ? "Context compacted" : ""} items={summary()} />
}

export function desktopPromptTicks(messages: readonly Messages[number][]): readonly PromptTick[] {
  return promptTicks(messages, (message) => message.type === "user" ? { id: message.id, text: message.text } : undefined)
}

function TurnView(props: { message: Messages[number] }) {
  const duration = (start: number, end?: number) => end === undefined ? undefined : `${Math.max(0, Math.round((end - start) / 1000))}s`
  const role = () => props.message.type
  const syntheticCard = () => props.message.type === "synthetic" ? classifyDesktopSynthetic(props.message) : undefined
  const layout = () => {
    const type = role()
    if (type === "user") return "end"
    if (type === "model-switched" || type === "agent-switched" || type === "skill") return "pill"
    const card = syntheticCard()
    return card && (card.kind === "completion" || card.kind === "note") ? "pill" : "block"
  }
  return <li id={`turn-${props.message.id}`} class={`transcript__turn ${role() === "user" ? "rl-me" : role() === "assistant" ? "rl-them" : "rl-sys"}`} data-speaker={role()} data-layout={layout()} tabindex={role() === "user" ? -1 : undefined}>
    <Show when={props.message.type === "user" ? props.message : undefined}>{(message) => <><span class="desktop__sr">You: </span><SharedMessageTurn kind="user" markdownText={message().text} attachments={<For each={message().files}>{(file) => <span class="conversation__chip">{file.name ?? "Attachment"}</span>}</For>} receipt={new Date(message().time.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} receiptLabel="Message created" /></>}</Show>
    <Show when={props.message.type === "assistant" ? props.message : undefined}>{(message) => { const groups = () => groupAssistantParts(message().content); return <SharedMessageTurn kind="assistant" head={<SharedTurnHead class="transcript-message__head" mark={<span class="rl-avatar transcript-message__mark"><Icon name="sparkles" /></span>}>{message().agent} · {message().model.providerID}/{message().model.id}{message().model.variant ? ` · ${message().model.variant}` : ""}{duration(message().time.created, message().time.completed) ? ` · ${duration(message().time.created, message().time.completed)}` : ""}</SharedTurnHead>} body={<><For each={groups()}>{(group) => group.kind === "reasoning" ? <For each={[thinkingExpanded()]}>{() => <SharedReasoningDisclosure defaultOpen={thinkingExpanded()} text={group.text} streaming={!message().time.completed} durationLabel={group.created !== undefined ? duration(group.created, group.completed) : undefined} />}</For> : group.kind === "text" ? <div class="transcript-message__text rl-bubble"><Markdown text={group.text} /></div> : <SharedToolDisclosure tools={toolSteps(group.parts)} lastSummary={group.parts.at(-1) ? toolDisplaySummary(group.parts.at(-1)!.name, group.parts.at(-1)!.state.input) : undefined} streaming={group.parts.some((part) => part.state.status === "running" || part.state.status === "streaming")} durationLabel={duration(message().time.created, message().time.completed)} />}</For><Show when={groups().length === 0 && !message().error && message().time.completed !== undefined}><p class="transcript__notice">{message().content.some((part) => part.type === "reasoning") ? "Reasoning is not shown for this response." : "No visible content in this response."}</p></Show></>} error={<Show when={message().error}>{(error) => <p role="alert" class="desktop__error">{error().message}</p>}</Show>} /> } }</Show>
    <Show when={props.message.type === "shell" ? props.message : undefined}>{(message) => <SharedMessageTurn kind="shell" shellHeader={<><code class="ws-card-title">$ {message().command}</code> · {message().status}{message().exit === undefined ? "" : ` · exit ${message().exit}`}</>} shellOutput={<div class="ws-shell"><pre class="ws-out"><code>{message().output?.output ?? ""}</code></pre><Show when={message().output?.truncated}><p>Shell output is truncated.</p></Show></div>} />}</Show>
    <Show when={props.message.type === "compaction" ? props.message : undefined}>{(message) => <SharedMessageTurn kind="compaction" compaction={<CompactionView message={message()} />} />}</Show>
    <Show when={props.message.type === "system" ? props.message : undefined}>{(message) => <SharedMessageTurn kind="system" content={<><span class="transcript__speaker">System</span><div class="transcript-system-card"><Markdown text={message().text} /></div></>} />}</Show>
    <Show when={syntheticCard()}>{(card) => card().kind === "subagent" ? <Show when={card().kind === "subagent" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "subagent" }> : undefined}>{(entry) => <details class="transcript-notice-card" data-status={entry().status}><summary><Icon name={entry().status === "failed" ? "alert" : entry().status === "completed" ? "check" : "team"} /><strong>Subagent · {entry().label}</strong><span class="transcript-notice-card__status">{entry().status}</span><span class="rl-disclosure-chev"><Icon name="chevron-right" /></span></summary><Show when={entry().excerpt}>{(excerpt) => <div class="rl-disclosure-card"><Markdown text={excerpt()} /></div>}</Show></details>}</Show>
      : card().kind === "member" ? <Show when={card().kind === "member" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "member" }> : undefined}>{(entry) => <article class="transcript-notice-card" data-kind="member"><header class="transcript-notice-card__head"><Icon name="team" /><strong>{entry().label}</strong><span class="transcript-notice-card__status">{entry().event}</span><Link to="/sessions/$sessionID" params={{ sessionID: entry().memberSessionID }} class="rl-btn transcript-notice-card__open">Open</Link></header><Show when={entry().escalatedBy}>{(by) => <p class="transcript-notice-card__meta">Escalated by {by()}</p>}</Show><Show when={entry().excerpt}>{(excerpt) => <div class="rl-disclosure-card"><Markdown text={excerpt()} /></div>}</Show></article>}</Show>
      : card().kind === "goal" ? <Show when={card().kind === "goal" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "goal" }> : undefined}>{(entry) => <article class="transcript-notice-card" data-kind="goal"><header class="transcript-notice-card__head"><Icon name="target" /><strong>Goal · steer</strong></header><div class="rl-disclosure-card"><Markdown text={entry().text} /></div></article>}</Show>
      : card().kind === "parent-answer" ? <Show when={card().kind === "parent-answer" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "parent-answer" }> : undefined}>{(entry) => <article class="transcript-notice-card" data-kind="parent-answer"><header class="transcript-notice-card__head"><Icon name="chat" /><strong>Parent answer</strong></header><div class="rl-disclosure-card"><Markdown text={entry().text} /></div></article>}</Show>
      : card().kind === "completion" ? <Show when={card().kind === "completion" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "completion" }> : undefined}>{(entry) => <p class="transcript-notice-pill" data-status={entry().status}><Icon name={entry().status === "failed" ? "alert" : "check"} /><span>{entry().label} · {entry().status} — {entry().description}</span></p>}</Show>
      : <Show when={card().kind === "note" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "note" }> : undefined}>{(entry) => <p class="transcript-notice-pill"><Icon name="bell" /><span>{entry().text}</span></p>}</Show>}</Show>
    <Show when={props.message.type === "model-switched" ? props.message : undefined}>{(message) => <p class="transcript-notice-pill transcript-notice-pill--center"><Icon name="cpu" /><span>Model: {message().model.providerID}/{message().model.id}{message().model.variant ? ` · ${message().model.variant}` : ""}</span></p>}</Show>
    <Show when={props.message.type === "agent-switched" ? props.message : undefined}>{(message) => <p class="transcript-notice-pill transcript-notice-pill--center"><Icon name="user" /><span>Agent: {message().agent}</span></p>}</Show>
    <Show when={props.message.type === "skill" ? props.message : undefined}>{(message) => <p class="transcript-notice-pill transcript-notice-pill--center"><Icon name="sparkles" /><span>Skill: {message().name}</span></p>}</Show>
    <Show when={!["user", "assistant", "shell", "compaction", "system", "synthetic", "model-switched", "agent-switched", "skill"].includes(role())}><p>Unsupported message: {role()}</p></Show>
  </li>
}

function usage(session: SessionRow) {
  const input = session.tokens.input + session.tokens.cache.read + session.tokens.cache.write
  const output = session.tokens.output + session.tokens.reasoning
  return `${formatCompactCount(input)} in · ${formatCompactCount(output)} out${session.cost > 0 ? ` · ${formatUsd(session.cost)}` : ""}`
}

const percent = (part: number, whole: number) => whole > 0 ? Math.round(part / whole * 100) : 0
const breakdownLabels = [["system", "System"], ["tools", "Tools"], ["user", "User"], ["assistant", "Assistant"], ["reasoning", "Reasoning"], ["toolCalls", "Tool calls"], ["other", "Other"]] as const

export function contextBreakdown(breakdown: Readonly<Record<(typeof breakdownLabels)[number][0], number>> | undefined) {
  if (!breakdown) return []
  const total = breakdownLabels.reduce((sum, [key]) => sum + breakdown[key], 0)
  return total > 0 ? breakdownLabels.map(([key, label]) => ({ label, tokens: breakdown[key], percent: percent(breakdown[key], total) })) : []
}

type ModelId = { readonly id: string; readonly providerID: string }

function contextOf(list: Messages, current?: ModelId) {
  const later: Messages = []
  for (const message of list.toReversed()) {
    const limit = message.type === "assistant" ? message.diagnostics?.contextLimit : undefined
    if (message.type === "assistant" && message.tokens && limit && limit > 0) {
      const used = message.tokens.input + message.tokens.output + message.tokens.reasoning + message.tokens.cache.read + message.tokens.cache.write
      if (used > 0) {
        const differs = (model: ModelId) => model.id !== message.model.id || model.providerID !== message.model.providerID
        const stale = later.some((entry) => entry.type === "compaction") ? "the conversation was compacted after"
          : later.some((entry) => entry.type === "assistant" && differs(entry.model)) || (current !== undefined && differs(current)) ? "the model changed after"
          : undefined
        return { used, limit, stale, breakdown: message.diagnostics?.contextBreakdown }
      }
    }
    later.push(message)
  }
  return undefined
}

function responding(list: Messages) {
  const last = list.findLast((message) => message.type === "assistant")
  return last?.type === "assistant" && last.time.completed === undefined
}

function Context(props: { messages: Messages; model?: ModelId }) {
  const navigate = useNavigate()
  const context = () => contextOf(props.messages, props.model)
  const current = () => context()?.stale ? undefined : context()
  const latest = () => props.messages.findLast((message) => message.type === "assistant" && message.tokens)
  const latestModel = () => { const message = latest(); return message?.type === "assistant" ? `${message.model.providerID}/${message.model.id}` : undefined }
  const diagnostics = () => {
    const message = latest()
    if (message?.type !== "assistant" || !message.tokens) return undefined
    const tokens = message.tokens
    const eligible = tokens.input + tokens.cache.read + tokens.cache.write
    const reported = message.diagnostics?.providerCache?.readReported ?? tokens.cache.read > 0
    return { uncachedInput: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write, ...(reported && eligible > 0 ? { hitRatio: tokens.cache.read / eligible } : {}) }
  }
  return <SharedContextBreakdownPanel used={current() ? formatCompactCount(current()!.used) : undefined} capacity={current() ? formatCompactCount(current()!.limit) : undefined} label={current() ? `${percent(current()!.used, current()!.limit)}% used · latest response` : undefined} remaining={current() ? Math.max(0, current()!.limit - current()!.used) : undefined} breakdown={contextBreakdown(current()?.breakdown).length ? current()?.breakdown : undefined} fallbackText={context()?.stale ? `Context unknown: ${context()?.stale} the last report` : "Context unknown"} providerLabel={latestModel()} stepDiagnostics={diagnostics()} onOpenUsage={() => void navigate({ to: "/usage" })} contextMessagesLabel="Retained transcript messages" contextMessages={retainedMessages(props.messages)} staleReason="Context may differ after a model change." />
}

function is<T extends Field["type"]>(item: Field, type: T): item is Extract<Field, { type: T }> {
  return item.type === type
}

const errorId = (scope: string, index: number) => `${scope}-${index}-error`

function FieldInput(props: { scope: string; index: number; field: Field; value: Value | undefined; invalid: boolean; onChange: (value: Value) => void }) {
  const text = () => typeof props.value === "string" ? props.value : ""
  const picks = () => Array.isArray(props.value) ? props.value : []
  const label = () => props.field.title ?? props.field.key
  const described = () => props.invalid ? errorId(props.scope, props.index) : undefined
  const [extra, setExtra] = createSignal("")
  return <>
    <Show when={is(props.field, "string") ? props.field : undefined}>{(item) => <Show when={item().options} fallback={<input type={item().format === "email" ? "email" : item().format === "uri" ? "url" : item().format === "date" ? "date" : "text"} aria-label={label()} aria-invalid={props.invalid} aria-describedby={described()} value={text()} placeholder={item().placeholder} onInput={(event) => props.onChange(event.currentTarget.value)} />}>{(options) => <>
      <For each={options()}>{(option) => <label class="request__choice"><input type="radio" name={`${props.scope}-${props.index}`} aria-invalid={props.invalid} aria-describedby={described()} checked={text() === option.value} onChange={() => props.onChange(option.value)} /><span><strong>{option.label}</strong><Show when={option.description}> — {option.description}</Show></span></label>}</For>
      <Show when={item().custom}><label class="request__choice">Other<input type="text" aria-label={`Other: ${label()}`} aria-invalid={props.invalid} aria-describedby={described()} value={options().some((option) => option.value === text()) ? "" : text()} onInput={(event) => props.onChange(event.currentTarget.value)} /></label></Show>
    </>}</Show>}</Show>
    <Show when={is(props.field, "number") || is(props.field, "integer") ? props.field : undefined}>{(item) => <input type="number" aria-label={label()} aria-invalid={props.invalid} aria-describedby={described()} inputmode="decimal" step={item().type === "integer" ? 1 : "any"} min={item().minimum} max={item().maximum} value={text()} onInput={(event) => props.onChange(event.currentTarget.value)} />}</Show>
    <Show when={is(props.field, "boolean")}><label class="request__choice"><input type="checkbox" checked={props.value === true} onChange={(event) => props.onChange(event.currentTarget.checked)} /><span>Yes</span></label></Show>
    <Show when={is(props.field, "multiselect") ? props.field : undefined}>{(item) => <>
      <For each={item().options}>{(option) => <label class="request__choice"><input type="checkbox" aria-invalid={props.invalid} aria-describedby={described()} checked={picks().includes(option.value)} onChange={(event) => props.onChange(event.currentTarget.checked ? [...picks(), option.value] : picks().filter((entry) => entry !== option.value))} /><span><strong>{option.label}</strong><Show when={option.description}> — {option.description}</Show></span></label>}</For>
      <Show when={picks().filter((entry) => !item().options.some((option) => option.value === entry)).length}><p class="desktop__metadata">Added: {picks().filter((entry) => !item().options.some((option) => option.value === entry)).join(", ")}</p></Show>
      <Show when={item().custom}><span class="request__add"><input type="text" aria-label={`Another choice: ${label()}`} aria-invalid={props.invalid} aria-describedby={described()} value={extra()} onInput={(event) => setExtra(event.currentTarget.value)} /><button type="button" disabled={!extra().trim() || picks().includes(extra().trim())} onClick={() => { props.onChange([...picks(), extra().trim()]); setExtra("") }}>Add choice</button></span></Show>
    </>}</Show>
    <Show when={is(props.field, "external") ? props.field : undefined}>{(item) => <><p class="desktop__metadata">{item().url}</p><p class="desktop__muted">Open this link in your browser; the desktop app does not open links. Then confirm below.</p>
      <label class="request__choice"><input type="checkbox" aria-invalid={props.invalid} aria-describedby={described()} checked={props.value === true} onChange={(event) => props.onChange(event.currentTarget.checked)} /><span>I have completed this step</span></label></>}</Show>
  </>
}

function unlockFocus(locked: () => boolean, card: () => HTMLElement | undefined, heading: () => HTMLElement | undefined) {
  let was = locked()
  createEffect(() => {
    const now = locked()
    const active = document.activeElement
    const at: FocusAt = !active || active === document.body ? "body" : active === card() ? "card" : card()?.contains(active) ? "control" : "elsewhere"
    if (restoresFocus(was, now, at)) heading()?.focus({ preventScroll: true })
    was = now
  })
}

function FormCard(props: { form: FormRequest; locked: boolean; notice?: string; onSubmit: (answer: FormAnswer) => void; onCancel: () => void }) {
  const [values, setValues] = createSignal(initialValues(props.form.fields))
  const visible = () => activeFields(props.form.fields, values())
  const issues = () => visible().flatMap((item) => problemOf(item, valueFor(values(), item.key)) ?? [])
  const [touched, setTouched] = createSignal<ReadonlySet<number>>(new Set())
  const touch = (index: number) => setTouched((current) => current.has(index) ? current : new Set(current).add(index))
  const shownProblem = (item: Field) => touched().has(props.form.fields.indexOf(item)) ? problemOf(item, valueFor(values(), item.key)) : undefined
  let card: HTMLElement | undefined
  let heading: HTMLHeadingElement | undefined
  let form: HTMLFormElement | undefined
  unlockFocus(() => props.locked, () => card, () => heading)
  const submit = () => {
    if (props.locked) return
    if (invalidIndexes(props.form.fields, values()).length) {
      setTouched((current) => new Set([...current, ...visible().map((item) => props.form.fields.indexOf(item))]))
      queueMicrotask(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    props.onSubmit(buildAnswer(props.form.fields, values()))
  }
  return <article class="request rl-decision-card" ref={card} aria-labelledby={`form-${props.form.id}`}>
    <div class="request__head"><span class="request__head-icon"><Icon name="chat" /></span><h2 id={`form-${props.form.id}`} tabindex="-1" ref={heading}>{props.form.title}</h2></div>
    <p class="desktop__muted">This Session asks for your answer. Nothing is sent until you choose Send answer.</p>
    <form ref={form} onSubmit={(event) => { event.preventDefault(); submit() }}>
      <For each={visible()}>{(item) => <fieldset class="request__field" onFocusOut={(event) => { const next = event.relatedTarget; if (!(next instanceof Node) || !event.currentTarget.contains(next)) touch(props.form.fields.indexOf(item)) }}><legend>{item.title ?? item.key}{item.type === "external" || item.required ? " (required)" : ""}</legend>
        <Show when={item.description}><p class="desktop__muted">{item.description}</p></Show>
        <FieldInput scope={props.form.id} index={props.form.fields.indexOf(item)} field={item} value={valueFor(values(), item.key)} invalid={!!shownProblem(item)} onChange={(value) => { touch(props.form.fields.indexOf(item)); setValues((current) => withValue(current, item.key, value)) }} />
        <Show when={shownProblem(item)}>{(text) => <p id={errorId(props.form.id, props.form.fields.indexOf(item))} role="alert" class="desktop__error">{text()}</p>}</Show></fieldset>}</For>
      <Show when={issues().length}><p class="desktop__muted">{issues().length === 1 ? "One field needs attention" : `${issues().length} fields need attention`} before the answer can be sent. Choose Send answer to see what to fix.</p></Show>
      <Show when={props.notice}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
      <div class="desktop__actions"><button type="submit" class="rl-btn" data-tone="go" disabled={props.locked}>Send answer</button>
        <button type="button" class="rl-btn" disabled={props.locked} onClick={props.onCancel}>Cancel form</button></div>
    </form>
  </article>
}

function PermissionCard(props: { request: PermissionRequest; locked: boolean; notice?: string; onReply: (reply: "once" | "always" | "reject", message?: string) => void }) {
  const [reason, setReason] = createSignal("")
  let card: HTMLElement | undefined
  let heading: HTMLHeadingElement | undefined
  unlockFocus(() => props.locked, () => card, () => heading)
  return <article class="request rl-decision-card" ref={card} aria-labelledby={`permission-${props.request.id}`}>
    <div class="request__head"><span class="request__head-icon"><Icon name="shield" /></span><h2 id={`permission-${props.request.id}`} tabindex="-1" ref={heading}>Permission requested: {props.request.action}</h2></div>
    <ul class="request__resources"><For each={props.request.resources}>{(resource) => <li class="desktop__metadata">{resource}</li>}</For></ul>
    <Show when={props.request.save?.length} fallback={<p class="desktop__muted">This request has no rule to save, so only Allow once and Reject are offered.</p>}><p class="desktop__muted">Always allow saves a permission rule for: {props.request.save?.join(", ")}.</p></Show>
    <label class="desktop__field">Reason (optional, sent with Reject)<input type="text" maxlength="4096" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></label>
    <Show when={props.notice}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
    <div class="desktop__actions">
      <button type="button" class="rl-btn" data-tone="danger" disabled={props.locked} onClick={() => props.onReply("reject", reason().trim() || undefined)}>Reject</button>
      <button type="button" class="rl-btn" data-tone="go" disabled={props.locked} onClick={() => props.onReply("once")}>Allow once</button>
      <Show when={props.request.save?.length}><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onReply("always")}>Always allow</button></Show>
    </div>
  </article>
}

type ReviewItem = NonNullable<PendingRequests["reviews"]>[number]
type ReviewDecision = Extract<RequestReply, { kind: "review" }>["decision"]

export function pendingRequestIDs(data: { readonly permissions: readonly { readonly id: string }[]; readonly forms: readonly { readonly id: string }[]; readonly guardrails?: readonly { readonly id: string }[]; readonly reviews?: readonly { readonly itemID: string }[] }) {
  return [...data.permissions.map((item) => item.id), ...data.forms.map((item) => item.id), ...(data.guardrails ?? []).map((item) => item.id), ...(data.reviews ?? []).map((item) => item.itemID)]
}

function GuardrailCard(props: { item: NonNullable<PendingRequests["guardrails"]>[number]; locked: boolean; notice?: string; onReply: (reply: "once" | "reject") => void }) {
  return <article class="request rl-decision-card"><div class="request__head"><Icon name="shield" /><h2>Guardrail · {props.item.hardReview ? "Hard review" : props.item.standard ? "Standard" : "Custom"}</h2></div><h3>{props.item.action}</h3><p>{props.item.reason}</p><ul class="request__resources"><For each={props.item.resources}>{(pattern) => <li><code>{pattern}</code></li>}</For></ul><p>Rules: {props.item.ruleIDs.join(", ")}</p><Show when={props.notice}><p role="alert">{props.notice}</p></Show><div class="desktop__actions"><button type="button" class="rl-btn" data-tone="go" disabled={props.locked} onClick={() => props.onReply("once")}>Approve</button><button type="button" class="rl-btn" data-tone="danger" disabled={props.locked} onClick={() => props.onReply("reject")}>Deny</button></div></article>
}

function ReviewCard(props: { item: ReviewItem; locked: boolean; notice?: string; onDecision: (decision: ReviewDecision) => void }) {
  const [text, setText] = createSignal("")
  const [values, setValues] = createSignal(initialValues(props.item.payload.type === "form" ? props.item.payload.fields : []))
  const [answers, setAnswers] = createSignal<Readonly<Record<number, readonly string[]>>>({})
  const [custom, setCustom] = createSignal<Readonly<Record<number, string>>>({})
  const [error, setError] = createSignal<string>()
  const questionAnswers = () => props.item.payload.type === "question" ? props.item.payload.questions.map((_, index) => [...(answers()[index] ?? []), ...(custom()[index]?.trim() ? [custom()[index]!.trim()] : [])]) : []
  const submit = () => {
    const payload = props.item.payload
    if (props.locked) return
    if (payload.type === "form") {
      if (invalidIndexes(payload.fields, values()).length) { setError("Complete the required fields before sending."); return }
      props.onDecision({ kind: "question", answers: buildAnswer(payload.fields, values()) }); return
    }
    if (payload.type === "question") {
      const selected = questionAnswers()
      if (selected.some((answer) => !answer.length)) { setError("Answer each question before sending."); return }
      props.onDecision({ kind: "question", answers: selected }); return
    }
    if (payload.type === "subagent_question" && text().trim()) props.onDecision({ kind: "subagent_question", text: text().trim() })
  }
  return <article class="request rl-decision-card"><div class="request__head"><Icon name="shield" /><h2>Review · {props.item.kind}</h2></div><h3>{props.item.sessionTitle}</h3><p>{props.item.reason}</p>
    <Show when={props.item.payload.type === "guardrail" || props.item.payload.type === "permission" ? props.item.payload : undefined}>{(payload) => <><h3>{payload().action}</h3><ul><For each={payload().resources}>{(pattern) => <li><code>{pattern}</code></li>}</For></ul><Show when={payload().type === "guardrail" ? (payload() as Extract<ReviewItem["payload"], { type: "guardrail" }>).reason : undefined}>{(summary) => <p>{summary()}</p>}</Show><div class="desktop__actions"><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision(props.item.kind === "guardrail" ? { kind: "guardrail", reply: "once" } : { kind: "permission", reply: "once" })}>Approve</button><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision(props.item.kind === "guardrail" ? { kind: "guardrail", reply: "reject" } : { kind: "permission", reply: "reject" })}>Deny</button></div></>}</Show>
    <Show when={props.item.payload.type === "recovery" ? props.item.payload : undefined}>{(payload) => <><ul><For each={payload().tools}>{(tool) => <li>{tool.name} · {tool.messageID}</li>}</For></ul><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision({ kind: "recovery", choice: "continue" })}>Continue</button><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision({ kind: "recovery", choice: "stop" })}>Stop</button></>}</Show>
    <Show when={props.item.kind === "question" || props.item.kind === "subagent_question"}><form onSubmit={(event) => { event.preventDefault(); submit() }}><Show when={props.item.payload.type === "form" ? props.item.payload : undefined}>{(payload) => <><h3>{payload().title}</h3><For each={activeFields(payload().fields, values())}>{(item, index) => <fieldset class="request__field"><legend>{item.title ?? item.key}</legend><FieldInput scope={props.item.itemID} index={index()} field={item} value={valueFor(values(), item.key)} invalid={!!error() && !!problemOf(item, valueFor(values(), item.key))} onChange={(value) => setValues((previous) => withValue(previous, item.key, value))} /></fieldset>}</For></>}</Show><Show when={props.item.payload.type === "question" ? props.item.payload : undefined}>{(payload) => <For each={payload().questions}>{(question, index) => <fieldset class="request__field"><legend>{question.header}</legend><p>{question.question}</p><For each={question.options}>{(option) => <label class="request__choice"><input type={question.multiple ? "checkbox" : "radio"} name={`${props.item.itemID}-${index()}`} checked={answers()[index()]?.includes(option.label) ?? false} disabled={props.locked} onChange={(event) => { const checked = event.currentTarget.checked; setAnswers((previous) => ({ ...previous, [index()]: question.multiple ? checked ? [...previous[index()] ?? [], option.label] : (previous[index()] ?? []).filter((entry) => entry !== option.label) : [option.label] })); if (!question.multiple) setCustom((previous) => ({ ...previous, [index()]: "" })) }} /><span>{option.label} · {option.description}</span></label>}</For><Show when={question.custom !== false}><label class="rl-field"><span>Custom answer</span><input value={custom()[index()] ?? ""} disabled={props.locked} onInput={(event) => { const value = event.currentTarget.value; setCustom((previous) => ({ ...previous, [index()]: value })); if (!question.multiple) setAnswers((previous) => ({ ...previous, [index()]: [] })) }} /></label></Show></fieldset>}</For>}</Show><Show when={props.item.payload.type === "subagent_question" ? props.item.payload : undefined}>{(payload) => <label class="rl-field"><span>{payload().text}</span><textarea value={text()} disabled={props.locked} onInput={(event) => setText(event.currentTarget.value)} /></label>}</Show><button type="submit" class="rl-btn" disabled={props.locked}>Send answer</button><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision(props.item.kind === "subagent_question" ? { kind: "subagent_question", dismissed: true } : { kind: "question", dismissed: true })}>Dismiss</button></form></Show>
    <Show when={error() ?? props.notice}><p role="alert">{error() ?? props.notice}</p></Show>
  </article>
}

function Requests(props: { data: PendingRequests; updatedAt: number; refetch: () => void }) {
  const [working, setWorking] = createSignal(false)
  const [held, setHeld] = createSignal<ReadonlyMap<string, { readonly message?: string; readonly at: number }>>(new Map())
  const [lost, setLost] = createSignal<string>()
  let answered: string | undefined
  const waiting = (id: string) => props.updatedAt <= (held().get(id)?.at ?? -1)
  const locked = (id: string) => working() || waiting(id)
  const notice = (id: string) => {
    const message = held().get(id)?.message
    return message === undefined ? undefined : waiting(id) ? `${message} Refreshing requests…` : `${message} The request is still pending. Review your answer and try again.`
  }
  createEffect(() => {
    const pending = new Set(pendingRequestIDs(props.data))
    const id = answered
    if (id === undefined || pending.has(id)) return
    answered = undefined
    if (held().get(id)?.message !== undefined) setLost("A reply was not confirmed and that request is no longer pending. Check the transcript to see whether it was applied.")
    setHeld((current) => new Map([...current].filter(([key]) => key !== id)))
    queueMicrotask(() => document.getElementById("conversation-title")?.focus({ preventScroll: true }))
  })
  const answer = async (id: string, input: RequestReply) => {
    if (working()) return
    const generation = connection().generation
    answered = id
    setLost(undefined)
    setHeld((current) => new Map([...current].filter(([key]) => key !== id)))
    setWorking(true)
    let message: string | undefined
    try { await api.reply(input) }
    catch (cause) { message = failure(cause, "The answer was not confirmed.") }
    finally {
      setWorking(false)
      if (connection().generation === generation) {
        setHeld((current) => new Map(current).set(id, message === undefined ? { at: Date.now() } : { message, at: Date.now() }))
        props.refetch()
      }
    }
  }
  return <section class="requests" aria-label="Requests waiting for you">
    <Show when={lost()}>{(message) => <p role="status" class="desktop__error">{message()}</p>}</Show>
    <For each={props.data.permissions}>{(request) => <PermissionCard request={request} locked={locked(request.id)} notice={notice(request.id)}
      onReply={(reply, message) => void answer(request.id, { kind: "permission", sessionID: props.data.sessionID, revision: props.data.revision, requestID: request.id, reply, ...(message === undefined ? {} : { message }) })} />}</For>
    <For each={props.data.forms}>{(form) => <FormCard form={form} locked={locked(form.id)} notice={notice(form.id)}
      onSubmit={(value) => void answer(form.id, { kind: "form", sessionID: props.data.sessionID, revision: props.data.revision, formID: form.id, answer: value })}
      onCancel={() => void answer(form.id, { kind: "form-cancel", sessionID: props.data.sessionID, revision: props.data.revision, formID: form.id })} />}</For>
    <For each={props.data.guardrails}>{(item) => <GuardrailCard item={item} locked={locked(item.id)} notice={notice(item.id)} onReply={(reply) => void answer(item.id, { kind: "guardrail", sessionID: props.data.sessionID, revision: props.data.revision, requestID: item.id, reply })} />}</For>
    <For each={props.data.reviews}>{(item) => <ReviewCard item={item} locked={locked(item.itemID)} notice={notice(item.itemID)} onDecision={(decision) => void answer(item.itemID, { kind: "review", sessionID: props.data.sessionID, revision: props.data.revision, itemID: item.itemID, decision })} />}</For>
  </section>
}

function ModelPicker(props: { sessionID: string; model?: ModelId; running: boolean; agent?: string; sessionUsage: string; autonomyLabel: string; onAutonomy: () => void; openTick?: number }) {
  const catalog = observe(() => ({ queryKey: ["models", ...scope(), props.sessionID] as const, queryFn: () => api.models(props.sessionID), enabled: reading(), refetchOnMount: "always" as const }))
  const data = () => { const found = catalog.result().isError ? undefined : catalog.result().data; return found && "current" in found && found.source.sessionID === props.sessionID && found.revision === connection().revision ? found : undefined }
  const [switching, setSwitching] = createSignal(false)
  const [pendingChoice, setPendingChoice] = createSignal<ModelChoice>()
  const [outcome, setOutcome] = createSignal<{ readonly text: string; readonly failed: boolean }>()
  let outcomeTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => { void props.sessionID; void connection().generation; clearTimeout(outcomeTimer); setSwitching(false); setPendingChoice(undefined); setOutcome(undefined) })
  onCleanup(() => clearTimeout(outcomeTimer))
  const list = createMemo(() => visibleModels(data()?.models ?? [], data()?.current))
  const choice = () => choiceFor(list(), data()?.current)
  const blocked = () => props.running || data()?.running === true
  const switchTo = async (next: ModelChoice) => {
    const found = data()
    if (!found || switching() || blocked() || !reading()) return
    const model = selectionFor(list(), next)
    if (!model || sameSelection(model, found.current)) return
    const generation = connection().generation
    let timer: ReturnType<typeof setTimeout> | undefined
    setSwitching(true)
    setPendingChoice(next)
    clearTimeout(outcomeTimer)
    setOutcome(undefined)
    try {
      await Promise.race([api.switchModel({ sessionID: props.sessionID, revision: found.revision, model }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Switching timed out (a compaction or backend check may still be running). Refresh models to confirm.")), 12_000) })])
      if (connection().generation === generation) {
        queries.setQueryData(["models", ...scope(), props.sessionID], { ...found, current: model })
        setOutcome({ text: "Switched.", failed: false })
        outcomeTimer = setTimeout(() => { if (!outcome()?.failed) setOutcome(undefined) }, 2500)
      }
    } catch (cause) { if (connection().generation === generation) setOutcome({ text: failure(cause, "The model switch was not confirmed. Refresh models to see whether it changed."), failed: true }) }
    finally {
      clearTimeout(timer)
      setSwitching(false)
      setPendingChoice(undefined)
      if (connection().generation === generation) { catalog.refetch(); refresh(["sessions"]); refresh(["session", ...scope(), props.sessionID]) }
    }
  }
  const currentName = () => { const current = data()?.current; const option = current ? list().find((item) => item.id === current.id && item.providerID === current.providerID) : undefined; return option?.name ?? current?.id ?? props.model?.id }
  return <>
    <Show when={data()} fallback={<button type="button" class="composer-chip" disabled><span>{props.agent ? `${props.agent} · ` : ""}{currentName() ?? "Model not set"}</span></button>}>
      <ModelPopover chipLabel={`${props.agent ? `${props.agent} · ` : ""}${currentName() ?? "Choose a model"}`} effortLabel={data()?.current?.variant || undefined} busy={blocked() || switching() || !reading()} models={list()} choice={pendingChoice() ?? choice()} openTick={props.openTick} onPick={(next) => void switchTo(next)} onRefresh={catalog.refetch} refreshing={catalog.result().isFetching}>
        <Show when={blocked()}><p role="status" class="desktop__muted">Stop the running chat before switching models.</p></Show>
        <Show when={!blocked() ? choiceProblem(list(), choice()) : undefined}>{(problem) => <p role="status" class="desktop__muted">{problem()}</p>}</Show>
        <Show when={switching()}><p role="status" class="desktop__muted">Switching…</p></Show>
        <Show when={outcome()?.failed ? outcome() : undefined}>{(result) => <p role="alert" class="desktop__error model-popover__status">{result().text}</p>}</Show>
      </ModelPopover>
    </Show>
    <button type="button" class="composer-chip" aria-haspopup="dialog" onClick={props.onAutonomy}><span>{props.autonomyLabel.replace("Autonomy · ", "Autonomous ")}</span></button>
    <span class="composer-bar__spacer" />
    <span class="composer-metrics"><span class="desktop__sr">Session tokens, cumulative across the whole Session and not the context window: </span>{props.sessionUsage}</span>
    <Show when={catalog.result().isPending && reading()}><span role="status" class="desktop__sr">Loading models…</span></Show>
    <Show when={catalog.result().isError}><span role="alert" class="desktop__error composer-bar__note">{failure(catalog.result().error, "Models could not be read. Refresh to retry.")}<button type="button" class="rl-btn" onClick={catalog.refetch} disabled={!reading()}>Refresh models</button></span></Show>
    <Show when={outcome()}>{(result) => <span role={result().failed ? "alert" : "status"} class={result().failed ? "desktop__error composer-bar__note" : "desktop__muted composer-bar__note"}>{result().text}</span>}</Show>
  </>
}

function Conversation(props: { sessionID: string }) {
  createEffect(() => { setLastSessionID(props.sessionID) })
  const sessions = observe(sessionsQuery)
  const sessionRead = observe(() => ({ queryKey: ["session", ...scope(), props.sessionID] as const, queryFn: () => api.session({ sessionID: props.sessionID }), enabled: reading(), refetchOnMount: "always" as const }))
  const messages = observe(() => ({ queryKey: ["messages", ...scope(), props.sessionID] as const, queryFn: () => api.messages(props.sessionID), enabled: reading(), refetchOnMount: "always" as const }))
  const requests = observe(() => ({ queryKey: ["requests", ...scope(), props.sessionID] as const, queryFn: () => api.requests(props.sessionID), enabled: reading() }))
  const changes = observe(() => ({ queryKey: ["fileChanges", ...scope(), props.sessionID] as const, queryFn: () => api.fileChanges(props.sessionID), enabled: reading() }))
  const activityRead = observe(() => ({ queryKey: ["activity", ...scope(), props.sessionID] as const, queryFn: () => api.activity(props.sessionID), enabled: reading() && companionOpen() && companionTab() === "Activity" }))
  const changeData = () => changes.result().isError ? undefined : currentSnapshot(changes.result().data, connection().revision, props.sessionID)
  const autonomyRead = observe(() => ({ queryKey: ["autonomy", ...scope(), props.sessionID] as const, queryFn: () => api.autonomy!(props.sessionID), enabled: reading() && typeof api.autonomy === "function" }))
  const autonomy = () => autonomyRead.result().isError ? undefined : currentSnapshot(autonomyRead.result().data, connection().revision, props.sessionID)?.autonomy
  const policyLabels = () => autonomyLabels(autonomy())
  const [policyOpen, setPolicyOpen] = createSignal(false)
  const [policyBusy, setPolicyBusy] = createSignal(false)
  const [policyUncertain, setPolicyUncertain] = createSignal(false)
  const [policyError, setPolicyError] = createSignal<string>()
  const [policyGoal, setPolicyGoal] = createSignal("")
  createEffect(() => { void scope(); setPolicyOpen(false) })
  const [permissions, setPermissions] = createSignal<"manual" | "auto" | "yolo">("manual")
  const [guardrails, setGuardrails] = createSignal<"manual" | "auto" | "yolo">("manual")
  const [answers, setAnswers] = createSignal<"manual" | "auto" | "yolo">("manual")
  const openPolicy = () => { const value = autonomy(); setPolicyGoal(value?.goal?.text ?? ""); if (value) { setPermissions(value.effective.permissions); setGuardrails(value.effective.guardrails); setAnswers(value.effective.answers) } setPolicyOpen(true) }
  const policyGuard = createActionGuard<SetAutonomyInput, Awaited<ReturnType<typeof api.setAutonomy>>>((prompt) => confirmInPage(prompt), () => scope().join(":"), (input) => api.setAutonomy(input))
  const setPolicy = async (payload: SetAutonomyInput["payload"], prompt: string) => {
    const revision = connection().revision
    if (revision === undefined || !autonomy() || !reading() || policyBusy() || policyUncertain() || typeof api.setAutonomy !== "function") return
    setPolicyBusy(true); setPolicyError(undefined)
    const result = await policyGuard.run({ sessionID: props.sessionID, revision, payload }, prompt)
    if (result.status === "completed" && result.value?.revision === revision && result.value?.sessionID === props.sessionID && autonomyMatches(result.value.autonomy, payload)) { setPolicyGoal(result.value.autonomy.goal?.text ?? ""); autonomyRead.refetch() }
    else if (result.status === "completed") { setPolicyUncertain(true); setPolicyError("The autonomy response did not match the requested change. Reopen the Session and review its state."); autonomyRead.refetch() }
    else if (result.status === "unconfirmed") { setPolicyUncertain(true); setPolicyError(failure(result.error, "The autonomy change was not confirmed. Reopen the Session and review its state.")); autonomyRead.refetch() }
    setPolicyBusy(false)
  }
  const policyButtons = () => <><button type="button" onClick={openPolicy}>{policyLabels().goal}</button><button type="button" onClick={openPolicy}>{policyLabels().autonomy}</button></>
  const [selectedTurn, setSelectedTurn] = createSignal<string>()
  const [linkNote, setLinkNote] = createSignal<string>()
  const copyTranscriptLink = (event: MouseEvent) => { const anchor = (event.target as Element | null)?.closest?.("a[href]"); if (!(anchor instanceof HTMLAnchorElement)) return; event.preventDefault(); const href = anchor.href; void copyTextToClipboard(href).then(() => setLinkNote("Copied link"), () => setLinkNote("Link could not be copied")) }
  const [fullChangesOpen, setFullChangesOpen] = createSignal(false)
  const [stagedRevert, setStagedRevert] = createSignal<StagedRevert>()
  const activeRevert = () => activeRevertOf(session(), stagedRevert())
  const [revertNotice, setRevertNotice] = createSignal<string>()
  const [revertBusy, setRevertBusy] = createSignal(false)
  const [revertError, setRevertError] = createSignal<string>()
  const [revertUncertain, setRevertUncertain] = createSignal(false)
  let revertScope = scope().join(":")
  createEffect(() => { const next = scope().join(":"); if (next !== revertScope && (activeRevert() || revertBusy())) { setRevertUncertain(true); setRevertError("Connection changed. Review the staged revert before proceeding.") } revertScope = next })
  const revertGuard = createActionGuard<RevertInput, Awaited<ReturnType<typeof api.revert>>>((prompt) => confirmInPage(prompt), () => scope().join(":"), (input) => api.revert(input))
  const doRevert = async (action: "stage" | "commit" | "clear") => {
    const revision = connection().revision
    if (revision === undefined || !reading() || revertBusy() || sending() || revertUncertain() || running() || !api.revert || (action === "stage" && !changeData()?.turns?.some((turn) => turn.id === selectedTurn()))) return
    const prompt = action === "stage" ? "Stage this revert? This immediately restores captured files and may overwrite working-tree changes." : action === "clear" ? "Cancel this revert? Restoring the original files may overwrite changes made since staging." : "Confirm this revert? Session messages after the selected boundary will be removed and the file restoration kept."
    const generation = connection().generation
    setRevertBusy(true); setRevertError(undefined)
    const result = await revertGuard.run(action === "stage" ? { action, sessionID: props.sessionID, revision, messageID: selectedTurn()!, files: true } : { action, sessionID: props.sessionID, revision }, prompt)
    if (result.status === "completed") {
      setStagedRevert(action === "stage" && result.value ? result.value : undefined)
      sessionRead.refetch()
      if (action !== "stage") { changes.refetch(); messages.refetch() }
    } else if (result.status === "unconfirmed") {
      setRevertError(failure(result.error, "The revert was not confirmed. Review the Session before proceeding."))
      setRevertUncertain(true)
    }
    if (connection().generation !== generation || connection().revision !== revision) { setRevertUncertain(true); setRevertError("The revert was not confirmed after the connection changed. Review the Session before proceeding.") }
    setRevertBusy(false)
  }
  const revert = () => (selectedTurn() || activeRevert()) && typeof api.revert === "function" ? { staged: !!activeRevert(), busy: revertBusy() || sending() || revertUncertain() || !reading() || running(), summary: activeRevert() ? `Revert to ${activeRevert()!.messageID} · ${activeRevert()!.files?.length ?? 0} files reported` : undefined, error: revertError(), onStage: () => void doRevert("stage"), onCommit: () => void doRevert("commit"), onClear: () => void doRevert("clear") } : undefined
  const [activityPages, setActivityPages] = createSignal<NonNullable<ReturnType<typeof activityData>>>()
  const [activityMoreBusy, setActivityMoreBusy] = createSignal(false)
  const [activityMoreError, setActivityMoreError] = createSignal<string>()
  createEffect(() => { void activityRead.result().data; setActivityPages(undefined); setActivityMoreError(undefined) })
  const activityView = () => activityRead.result().isError ? undefined : currentSnapshot(activityPages(), connection().revision, props.sessionID) ?? activityData()
  const loadMoreSubagents = async () => {
    const current = activityView(); if (!current?.subagentNext || activityMoreBusy() || !reading()) return
    const generation = connection().generation; setActivityMoreBusy(true); setActivityMoreError(undefined)
    try { const next = await api.activity({ sessionID: props.sessionID, cursor: current.subagentNext, revision: current.revision }); if (connection().generation !== generation || activityView() !== current || next.revision !== current.revision || next.sessionID !== props.sessionID) return; const seen = new Set(current.subagents.map((item) => item.sessionID)); const shells = new Set(current.shells.map((item) => item.id)); setActivityPages({ ...next, subagents: [...current.subagents, ...next.subagents.filter((item) => !seen.has(item.sessionID))], shells: [...current.shells, ...next.shells.filter((item) => !shells.has(item.id))] }) }
    catch (cause) { if (connection().generation === generation && activityView() === current) setActivityMoreError(failure(cause, "More subagents could not be read.")) }
    finally { setActivityMoreBusy(false) }
  }
  const [shellID, setShellID] = createSignal<string>()
  const [shellPage, setShellPage] = createSignal<ShellOutput>()
  const [shellLoading, setShellLoading] = createSignal(false)
  const [shellError, setShellError] = createSignal<string>()
  let shellRequest = 0
  createEffect(() => { void scope(); ++shellRequest; setShellID(undefined); setShellPage(undefined); setShellLoading(false); setShellError(undefined) })
  const readShell = async (id: string, cursor?: number) => {
    if (!reading() || !api.shellOutput || shellLoading()) return
    const generation = connection().generation, revision = connection().revision, request = ++shellRequest
    const ownerSessionID = shellOwner(activityView()?.shells ?? [], id, props.sessionID)
    setShellLoading(true); setShellError(undefined)
    try { const page = await api.shellOutput({ sessionID: ownerSessionID, shellID: id, ...(cursor === undefined ? {} : { cursor }) }); if (request !== shellRequest || connection().generation !== generation || connection().revision !== revision || shellID() !== id || shellOwner(activityView()?.shells ?? [], id, props.sessionID) !== ownerSessionID || page.revision !== revision || page.sessionID !== ownerSessionID || page.shellID !== id) return; setShellPage((previous) => cursor !== undefined && previous?.shellID === id && previous.cursor === cursor ? { ...page, output: previous.output + page.output } : page) }
    catch (cause) { if (request === shellRequest && connection().generation === generation && shellID() === id) setShellError(failure(cause, "Shell output could not be read.")) }
    finally { if (request === shellRequest) setShellLoading(false) }
  }
  const selectShell = (id?: string) => { ++shellRequest; setShellLoading(false); setShellID(id); setShellPage(undefined); setShellError(undefined); if (id) void readShell(id) }
  const shellOutput = () => shellID() ? { shellID: shellID()!, output: shellPage()?.output ?? "", truncated: shellPage()?.truncated, loading: shellLoading(), error: shellError(), ...(shellPage() && shellPage()!.cursor < shellPage()!.size ? { nextCursor: shellPage()!.cursor, onLoadMore: () => void readShell(shellID()!, shellPage()!.cursor) } : {}) } : undefined
  const [selectedFile, setSelectedFile] = createSignal<string>()
  const navigate = useNavigate()
  const openChanges = (path?: string) => { setSelectedFile(path); setCompanionTab("Changes"); setCompanionOpen(true) }
  const activityData = () => activityRead.result().isError ? undefined : currentSnapshot(activityRead.result().data, connection().revision, props.sessionID)
  const pendingRequests = () => { const data = requests.result().data; return data?.sessionID === props.sessionID && data.revision === connection().revision ? data : undefined }
  const requestCount = () => { const data = pendingRequests(); return data ? pendingRequestIDs(data).length : 0 }
  const unanswerable = () => {
    const data = pendingRequests()
    const known = new Set(data ? pendingRequestIDs(data) : [])
    return !!pendingRequests() && [...(activity().waiting.get(props.sessionID) ?? [])].some((id) => !known.has(id))
  }
  const children = () => companionChildren(sessions.result().data?.items ?? [], props.sessionID, activity())
  const subagentsWaiting = () => children().filter((entry) => entry.status === "Waiting for you").map((entry) => entry.row)
  const [stopping, setStopping] = createSignal(false)
  const [stopNote, setStopNote] = createSignal<string>()
  const session = () => { const data = sessionRead.result().data; return data && data.revision === connection().revision && data.item.id === props.sessionID ? data.item : undefined }
  const context = () => contextOf(messages.result().data ?? [], session()?.model)
  const [findOpen, setFindOpen] = createSignal(false)
  const [findQuery, setFindQuery] = createSignal("")
  const editPlacements = createMemo(() => turnEditPlacements(visibleDesktopMessages(messages.result().data ?? []), changeData()?.turns))
  const turns = () => visibleDesktopMessages(messages.result().data ?? []).filter((message) => !findQuery().trim() || transcriptText(message).toLowerCase().includes(findQuery().trim().toLowerCase()))
  const [announcement, setAnnouncement] = createSignal<{ readonly id: string; readonly text: string }>()
  let baselined = false
  let announced: string | undefined
  createEffect(() => {
    const result = messages.result()
    if (!result.isSuccess || !result.isFetchedAfterMount) return
    const finished = result.data.findLast((message) => message.type === "assistant" && message.time.completed)
    if (!baselined) { baselined = true; announced = finished?.id; return }
    if (finished?.type === "assistant" && finished.id !== announced) { announced = finished.id; setAnnouncement({ id: finished.id, text: `${finished.agent} finished a response.` }) }
  })
  const running = () => activity().busy.has(props.sessionID) || responding(messages.result().data ?? [])
  const stop = async () => {
    if (stopping() || !reading()) return
    const generation = connection().generation
    setStopping(true)
    setStopNote(undefined)
    try {
      await api.interrupt(props.sessionID)
      if (connection().generation === generation) { setStopNote("Stop requested. Check the transcript to confirm the response ended."); refresh(["messages", ...scope(), props.sessionID]) }
    } catch (cause) { if (connection().generation === generation) setStopNote(failure(cause, "Stopping was not confirmed. Check the Session before retrying.")) }
    finally { setStopping(false) }
  }
  const [text, setText] = createSignal(drafts.get(props.sessionID) ?? "")
  const [pending, setPending] = createSignal(pendings.get(props.sessionID))
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [following, setFollowing] = createSignal(true)
  const [unsure, setUnsure] = createSignal(unconfirmed.has(props.sessionID))
  const [scrollTop, setScrollTop] = createSignal(0)
  const [inView, setInView] = createSignal<ReadonlySet<string>>(new Set())
  const [clearance, setClearance] = createSignal(0)
  let scroller: HTMLDivElement | undefined
  let jumpSlot: HTMLDivElement | undefined
  let jumping = false
  let measureTimer: number | undefined
  let measureQueued = false
  const ticks = createMemo(() => desktopPromptTicks(turns()))
  const targets = () => navigationTargets(scrollTop(), following())
  const toEnd = () => { if (scroller) scroller.scrollTop = scroller.scrollHeight }
  const scrollDistance = () => scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : 0
  const measure = () => {
    if (!scroller) return
    const viewport = scroller.getBoundingClientRect()
    const next = promptsInView(viewport, ticks().flatMap((tick) => {
      const row = document.getElementById(`turn-${tick.id}`)
      if (!row) return []
      const bounds = row.getBoundingClientRect()
      return [{ id: tick.id, top: bounds.top, bottom: bounds.bottom }]
    }))
    setInView((previous) => sameSet(previous, next) ? previous : next)
    const controls = jumpSlot?.querySelector<HTMLElement>(".transcript-navigation__controls")
    if (!jumpSlot || !controls) return
    const bounds = jumpSlot.getBoundingClientRect()
    const bottom = bounds.top + controls.offsetTop + controls.offsetHeight + clearance()
    const gap = Number.parseFloat(getComputedStyle(controls).bottom)
    setClearance(pillClearance({ left: bounds.left + controls.offsetLeft, width: controls.offsetWidth, bottom, height: controls.offsetHeight, gap }, [...scroller.querySelectorAll<HTMLElement>(".request button")].map((button) => button.getBoundingClientRect())))
  }
  const scheduleMeasure = () => {
    if (measureTimer !== undefined) { measureQueued = true; return }
    measure()
    measureTimer = window.setTimeout(() => { measureTimer = undefined; if (measureQueued) { measureQueued = false; scheduleMeasure() } }, 100)
  }
  const onScroll = () => {
    if (!scroller) return
    setScrollTop(scroller.scrollTop)
    scheduleMeasure()
    if (jumping && scrollDistance() > 48) return
    if (scrollDistance() <= 48) jumping = false
    setFollowing(followState(following(), { kind: "scroll", distance: scrollDistance() }))
  }
  const jumpToLatest = () => {
    if (!scroller) return
    jumping = scrollDistance() > 0
    setFollowing(followState(following(), { kind: "jump", distance: scrollDistance() }))
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: jumpBehavior() })
  }
  const jumpToTop = () => {
    if (!scroller) return
    jumping = false
    setFollowing(followState(following(), { kind: "top", distance: scrollDistance() }))
    scroller.scrollTo({ top: 0, behavior: jumpBehavior() })
  }
  const selectPrompt = (id: string) => {
    const row = document.getElementById(`turn-${id}`)
    if (!row) return
    jumping = false
    setFollowing(false)
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: "start", behavior: jumpBehavior() })
  }
  onMount(() => {
    if (!scroller) return
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(scroller)
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild)
    onCleanup(() => { observer.disconnect(); window.clearTimeout(measureTimer) })
  })
  const update = (value: string) => { setText(value); if (value) drafts.set(props.sessionID, value); else drafts.delete(props.sessionID) }
  const hold = (value: { promptID: string; text: string; files?: PromptFile[]; agents?: PromptAgent[] } | undefined) => { setPending(value); if (value) pendings.set(props.sessionID, value); else pendings.delete(props.sessionID) }
  const [picks, setPicks] = createSignal<MentionPick[]>([])
  const [files, setFiles] = createSignal<PromptFile[]>([])
  const [modelTick, setModelTick] = createSignal(0)
  const [slashNote, setSlashNote] = createSignal<string>()
  const [sessionDialog, setSessionDialog] = createSignal<"rename" | "daybreak" | "timeline" | "activity">()
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [manageBusy, setManageBusy] = createSignal(false)
  const [manageUncertain, setManageUncertain] = createSignal(false)
  const management = createActionGuard<SessionManageInput, Awaited<ReturnType<typeof api.manageSession>>>((prompt) => confirmInPage(prompt), () => `${scope().join(":")}:${props.sessionID}`, (input) => api.manageSession(input))
  type SessionAction<T = SessionManageInput> = T extends SessionManageInput ? Omit<T, "revision" | "sessionID"> : never
  const manage = async (input: SessionAction, ownerSessionID = props.sessionID) => {
    const revision = connection().revision
    if (!reading() || revision === undefined || manageBusy() || manageUncertain()) return false
    setManageBusy(true)
    try {
      const result = await management.run({ ...input, revision, sessionID: ownerSessionID }, `${input.kind === "delete" ? "Permanently delete this Session and its descendants" : input.kind === "fork" ? "Fork this Session" : input.kind === "rename" ? `Rename this Session to ${input.title}` : input.kind === "move" ? `Move this Session to ${input.directory}` : input.kind}?`)
      if (result.status === "unconfirmed") { setManageUncertain(true); setSlashNote(failure(result.error, "The Session action was not confirmed. Reopen the Session before retrying.")); return false }
      if (result.status !== "completed") return false
      sessionRead.refetch(); sessions.refetch(); activityRead.refetch(); refresh(["projects"]); refresh(["workspaces"])
      setSessionDialog(undefined)
      if (input.kind === "fork" && result.value.item) void navigate({ to: "/sessions/$sessionID", params: { sessionID: result.value.item.id } })
      if (input.kind === "delete") void navigate({ to: "/sessions" })
      return true
    } finally { setManageBusy(false) }
  }
  const jumpToTurn = (id: string) => { setFindQuery(""); setFollowing(false); setSessionDialog(undefined); queueMicrotask(() => document.getElementById(`turn-${id}`)?.scrollIntoView({ block: "start" })) }
  const executeSlash = async (action: Exclude<SlashAction, { kind: "prompt" }>): Promise<boolean> => {
    if (action.kind === "backend") {
      if (activeRevert()) { setSlashNote("Resolve the staged revert before running commands."); return false }
      try {
        await api.command({ sessionID: props.sessionID, promptID: `msg_${crypto.randomUUID()}`, command: action.name, ...(action.args ? { arguments: action.args } : {}) })
        sessionRead.refetch(); refresh(["messages", ...scope(), props.sessionID])
        return true
      } catch (cause) { setError(failure(cause, "The command was not confirmed. Check the Session before running it again.")); return false }
    }
    if (await commonCommand(action.name, action.args, { source: props.sessionID, sessionID: props.sessionID, directory: session()?.location.directory, insert: (value) => update(text() + value) }, (to) => void navigate({ to }))) return true
    switch (action.name) {
      case "models": setModelTick((tick) => tick + 1); return true
      case "rename": if (action.args.trim()) return manage({ kind: "rename", title: action.args.trim() }); setSessionTitle(session()?.title ?? ""); setSessionDialog("rename"); return true
      case "fork": return manage({ kind: "fork" })
      case "move": openFolderPicker({ title: "Move Session to folder", mode: "directory", initialDirectory: session()?.location.directory, onPick: async (directory) => { await manage({ kind: "move", directory }) } }); return true
      case "archive": return manage({ kind: "archive" })
      case "unarchive": return manage({ kind: "unarchive" })
      case "delete": return manage({ kind: "delete" })
      case "daybreak": if (["blue", "red", "off"].includes(action.args)) return manage({ kind: "daybreak", daybreak: action.args === "blue" ? "daybreak_blue" : action.args === "red" ? "daybreak_red" : null }); setSessionDialog("daybreak"); return true
      case "undo": { const last = changeData()?.turns?.at(-1); openChanges(); if (last) { setSelectedTurn(last.id); await doRevert("stage") } else setSlashNote("No captured turn is available to revert."); return true }
      case "redo": if (activeRevert()) await doRevert("clear"); else setSlashNote("No revert is staged."); return true
      case "terminals": setCompanionTab("Activity"); setCompanionOpen(true); setSessionDialog("activity"); return true
      case "variants": {
        if (running()) { setSlashNote("Stop the running chat before changing reasoning effort."); return false }
        const catalog = await api.models(props.sessionID)
        if (!("current" in catalog) || !catalog.current || catalog.running || catalog.revision !== connection().revision) return false
        const model = catalog.models.find((model) => model.id === catalog.current!.id && model.providerID === catalog.current!.providerID)
        const stops = effortStopsFor(variantsFor(model, catalog.current.profile ?? ""))
        if (!stops.length) { setSlashNote("This model has no reasoning effort variants."); return true }
        const next = stops[(effortStopIndex(stops, catalog.current.variant ?? "") + 1) % stops.length]!
        await api.switchModel({ sessionID: props.sessionID, revision: catalog.revision, model: { ...catalog.current, variant: next.value } }); refresh(["models"]); return true
      }
      case "find": setFindOpen(true); setFindQuery(action.args); queueMicrotask(() => document.querySelector<HTMLInputElement>(".conversation__find input")?.focus()); return true
      case "timeline": setSessionDialog("timeline"); return true
      case "stash": setStashDialog({ text, update, directory: session()?.location.directory }); return true
      case "copy": { const response = latestAssistantText(messages.result().data ?? []); if (!response) { setSlashNote("No assistant response is available to copy."); return true } await copyTextToClipboard(response); setSlashNote("Copied latest assistant response."); return true }
      case "export": await copyTextToClipboard(formatSessionExportMarkdown({ title: session()?.title ?? "Session", sessionID: props.sessionID, directory: session()?.location.directory ?? "", updatedAt: session()?.time.updated, messages: messages.result().data ?? [] })); setSlashNote("Transcript exported as Markdown to the clipboard."); return true
      case "autonomous": {
        const mode = action.args
        if (mode === "manual" || mode === "auto" || mode === "yolo") await setPolicy({ permissions: mode, guardrails: mode, answers: mode }, `Change autonomy decisions to ${mode}/${mode}/${mode}?`)
        else openPolicy()
        return true
      }
      case "sleep": await setPolicy({ sleep: true }, "Put autonomy decisions to sleep?"); return true
      case "wake": await setPolicy({ sleep: false }, "Wake autonomy decisions?"); return true
      case "goal": {
        if (action.args === "stop") await setPolicy({ goal: null }, "Stop the Session goal? Its text will be retained.")
        else if (action.args) await setPolicy({ goal: action.args }, "Replace the Session goal with this text?")
        else openPolicy()
        return true
      }
      case "compact": {
        if (activeRevert()) { setSlashNote("Resolve the staged revert before compacting."); return false }
        if (!(await confirmInPage("Compact this Session now? Earlier messages are replaced by a summary."))) return false
        try { await api.compact({ sessionID: props.sessionID, promptID: `msg_${crypto.randomUUID()}` }); setSlashNote("Compaction requested."); refresh(["messages", ...scope(), props.sessionID]); return true }
        catch (cause) { setError(failure(cause, "Compaction was not confirmed. Check the Session before retrying.")); return false }
      }
    }
    return false
  }
  onMount(() => {
    const owner = { sessionID: props.sessionID, run: (name: string, args: string) => executeSlash({ kind: "local", name, args }) }
    setCommandOwner(owner)
    const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f" && !document.querySelector("dialog[open]")) { event.preventDefault(); setFindOpen(!findOpen()); if (!findOpen()) setFindQuery(""); else queueMicrotask(() => document.querySelector<HTMLInputElement>(".conversation__find input")?.focus()) } }
    window.addEventListener("keydown", shortcut)
    onCleanup(() => { window.removeEventListener("keydown", shortcut); if (commandOwner() === owner) setCommandOwner(undefined) })
  })
  createEffect(() => { void turns(); void requestCount(); if (following()) toEnd(); queueMicrotask(scheduleMeasure) })
  const promptGuard = createPromptGuard<{ promptID: string; text: string; files?: PromptFile[]; agents?: PromptAgent[] }>({
    scope: () => `${scope().join(":")}:${connection().status}`,
    read: (sessionID) => api.session({ sessionID }),
    confirm: (prompt) => confirmInPage(prompt),
    observe: (revert) => { setStagedRevert(revert); sessionRead.refetch() },
    dispatch: (draft) => api.prompt({ sessionID: props.sessionID, ...draft }),
  })
  const send = async () => {
    const revision = connection().revision
    if (sending() || !reading() || revision === undefined || unsure() || revertBusy() || revertUncertain()) return
    if (!pending() && text().trim()) {
      const catalogKey = ["composer-catalog", ...scope(), props.sessionID] as const
      let action = composerSlash(text(), (queries.getQueryData<ComposerCatalog>(catalogKey)?.commands ?? []).map((command) => command.name))
      if (action.kind === "prompt" && /^\/[A-Za-z0-9]/.test(text()) && typeof api.composerCatalog === "function") {
        const cached = queries.getQueryData<ComposerCatalog>(catalogKey)
        if (!cached || cached.revision !== connection().revision) {
          setSending(true)
          try { const fresh = await api.composerCatalog(props.sessionID); if (fresh.revision === connection().revision) { queries.setQueryData(catalogKey, fresh); action = composerSlash(text(), fresh.commands.map((command) => command.name)) } }
          catch (cause) { setError(failure(cause, "Commands could not be read. Retry after refreshing.")); return }
          finally { setSending(false) }
        }
      }
      if (action.kind !== "prompt") {
        setSending(true); setError(undefined); setSlashNote(undefined)
        try { if (await executeSlash(action)) { update(""); setPicks([]) } } catch (cause) { setError(failure(cause, "The command was not confirmed.")) } finally { setSending(false) }
        return
      }
    }
    const mentioned = pending() ? undefined : mentionPayload(text(), picks())
    const payload = mentioned ? { ...mentioned, files: promptFilesFor(files(), mentioned.files) } : undefined
    const draft = pending() ?? (text().trim() ? { promptID: `msg_${crypto.randomUUID()}`, text: text(), ...(payload?.files.length ? { files: payload.files } : {}), ...(payload?.agents.length ? { agents: payload.agents } : {}) } : undefined)
    if (!draft) return
    hold(draft)
    setSending(true)
    setError(undefined)
    setRevertNotice(undefined)
    const result = await promptGuard.run(props.sessionID, revision, activeRevert(), draft)
    if (result.status === "completed") {
      hold(undefined)
      setPicks([])
      setFiles([])
      update("")
      setStagedRevert(undefined)
      sessionRead.refetch()
      setFollowing(true)
      refresh(["messages", ...scope(), props.sessionID])
    } else if (result.status === "declined") {
      hold(undefined)
      setRevertNotice("Message not sent. Review or restore the staged revert in Changes.")
    } else if (result.status === "unconfirmed") {
      unconfirmed.add(props.sessionID)
      setUnsure(true)
      setRevertUncertain(true)
      setError(failure(result.error, "The pre-send check or message was not confirmed. Review the Session before continuing."))
      sessionRead.refetch()
    }
    setSending(false)
  }
  return <section class="conversation" aria-labelledby="conversation-title">
    <Show when={sessionDialog()}>{(kind) => <DesktopDialog title={kind() === "timeline" ? "Session timeline" : kind() === "activity" ? "Session processes" : kind() === "daybreak" ? "Daybreak schedule" : "Rename Session"} onClose={() => setSessionDialog(undefined)}>
      <Show when={kind() === "rename"}><form onSubmit={(event) => { event.preventDefault(); if (sessionTitle().trim()) void manage({ kind: "rename", title: sessionTitle().trim() }) }}><label class="rl-field"><span>Session title</span><input value={sessionTitle()} onInput={(event) => setSessionTitle(event.currentTarget.value)} /></label><button type="submit" class="rl-btn" disabled={manageBusy() || manageUncertain() || !sessionTitle().trim()}>Rename</button></form></Show>
      <Show when={kind() === "daybreak"}><For each={["blue", "red", "off"] as const}>{(mode) => <button type="button" class="rl-btn" disabled={manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "daybreak", daybreak: mode === "blue" ? "daybreak_blue" : mode === "red" ? "daybreak_red" : null })}>{mode === "off" ? "Turn off" : `${mode} daybreak`}</button>}</For></Show>
      <Show when={kind() === "timeline"}><ul class="desktop-dialog__entries"><For each={visibleDesktopMessages(messages.result().data ?? [])}>{(message) => <li><p>{message.type} · {transcriptText(message).slice(0, 180)}</p><button type="button" class="rl-btn" onClick={() => jumpToTurn(message.id)}>Jump to turn</button><button type="button" class="rl-btn" disabled={manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "fork", messageID: message.id })}>Fork from this message</button></li>}</For></ul></Show>
      <Show when={kind() === "activity"}><Show when={activityRead.result().isError}><p role="alert">Activity could not be read.</p></Show><button type="button" class="rl-btn" onClick={activityRead.refetch}>Refresh activity</button><h3>Shells</h3><For each={activityView()?.shells ?? []} fallback={<p>No attributed shells.</p>}>{(shell) => <div class="st-row"><span>{shell.command} · {shell.status}</span><button type="button" class="rl-btn" disabled={manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "kill-shell", shellID: shell.id }, shell.ownerSessionID)}>Kill shell</button></div>}</For><h3>Subagents</h3><For each={activityView()?.subagents ?? []} fallback={<p>No subagents.</p>}>{(task) => <div class="st-row"><span>{task.description} · {task.state}</span><button type="button" class="rl-btn" disabled={manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "cancel-subagent", childSessionID: task.sessionID })}>Cancel subagent</button></div>}</For></Show><Show when={slashNote()}><p role="status">{slashNote()}</p></Show>
    </DesktopDialog>}</Show>
    <SharedConversationHeader class="conversation__head rl-top" actions={<div class="rl-top-actions"><SharedContextRingButton class="rl-context-ring" ariaLabel="Toggle session context" expanded={companionOpen() && companionTab() === "Context"} fraction={!context() || context()?.stale ? 0 : context()!.used / context()!.limit} label={<Show when={context()?.stale ? undefined : context()} fallback="Unknown">{(value) => <><strong>{formatCompactCount(value().used)}</strong><small>{percent(value().used, value().limit)}%</small></>}</Show>} onClick={() => { const closing = companionOpen() && companionTab() === "Context"; setCompanionTab("Context"); setCompanionOpen(!closing) }} /><button type="button" class="rl-icon rl-companion-toggle" aria-label={companionOpen() ? "Close Session companion" : "Open Session companion"} aria-expanded={companionOpen()} onClick={() => setCompanionOpen(!companionOpen())}><Icon name="team" /></button><button type="button" class="rl-icon desktop__palette" aria-label={`Commands ${mac ? "⌘K" : "Ctrl K"}`} aria-keyshortcuts={mac ? "Meta+K" : "Control+K"} onClick={() => setPaletteOpen(true)}><Icon name="more" /></button></div>}><button type="button" class="desktop__rail-toggle rl-mobile-menu" aria-label="Open navigation" aria-expanded={railOpen()} aria-controls="session-rail" onClick={() => setRailOpen(true)}><Icon name="menu" /></button><span class="rl-mobile-brand"><Brand /></span><div class="rl-ident">
      <h1 id="conversation-title" class="rl-title" tabindex="-1" ref={focusHeading}>{session()?.title ?? "Session"}</h1>
      <Show when={sessionRead.result().isError}><div role="alert" class="desktop__error"><p>{failure(sessionRead.result().error, "The Session could not be read. Refresh to retry.")}</p><button type="button" onClick={sessionRead.refetch} disabled={!reading()}>Refresh Session</button></div></Show>
      <Show when={session()}>{(item) => <>
        <p class="rl-presence" data-tone={running() ? "busy" : "idle"}><span>{workspaceBase(item().location.directory)} · {connectionOwnership()}</span></p>
      </>}</Show>
      </div></SharedConversationHeader><div class="rl-notices">
      <Show when={findOpen()}><div class="conversation__find"><label class="rl-field"><span class="desktop__sr">Find in transcript</span><span class="rl-input-icon"><Icon name="search" /><input type="search" placeholder="Find in transcript…" value={findQuery()} onInput={(event) => setFindQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { setFindQuery(""); setFindOpen(false) } }} /></span></label><small role="status">{turns().length} matching turns</small><button type="button" class="rl-btn" onClick={() => setFindQuery("")}>Clear</button><button type="button" class="rl-icon-button" aria-label="Close find" onClick={() => { setFindQuery(""); setFindOpen(false) }}><Icon name="close" /></button></div></Show>
      <Show when={unsure()}><p role="status" class="conversation__notice">The pre-send check or message was not confirmed. Review the transcript and staged revert before continuing.</p></Show><Show when={activeRevert()}>{(value) => <p role="status" class="conversation__notice">A revert to message {value().messageID} is staged. Sending a message will commit the revert and remove later turns.</p>}</Show><Show when={revertNotice()}>{(notice) => <p role="status" class="conversation__notice">{notice()}</p>}</Show>
      <Show when={requestCount() > 0}><p role="status" class="conversation__notice" data-state="needs">This Session is waiting for you: {requestCount()} {requestCount() === 1 ? "request is" : "requests are"} below the transcript.</p></Show>
      <Show when={unanswerable()}><p role="status" class="conversation__notice" data-state="needs">This Session also has a guardrail review or question that the desktop app cannot answer yet. Answer it in the terminal or the web app.</p></Show>
      <Show when={linkNote()}>{(note) => <p role="status" class="conversation__notice">{note()}</p>}</Show><Show when={subagentsWaiting().length}><p role="status" class="conversation__notice" data-state="needs">A subagent Session of this chat is waiting for you. Its request belongs to that Session and is answered there:{" "}
        <For each={subagentsWaiting()}>{(row) => <Link to="/sessions/$sessionID" params={{ sessionID: row.id }} class="conversation__link">{row.title}</Link>}</For></p></Show>
    </div>

    <p class="desktop__sr" role="status"><Show when={announcement()} keyed>{(entry) => <span>{entry.text}</span>}</Show></p>
    <div class="conversation__scroll rl-scroll" ref={scroller} onClick={copyTranscriptLink} onScroll={onScroll} onWheel={() => { jumping = false }} onTouchStart={() => { jumping = false }} onPointerDown={() => { jumping = false }}><div class="rl-col conversation__column"><PromptRail prompts={ticks()} visible={inView()} onSelect={selectPrompt} /><div class="rl-thread">
      <Show when={!messages.result().isPending} fallback={<SharedLoadingSkeleton kind="conversation" label="Loading the transcript…" />}><Show when={!messages.result().isError} fallback={<div role="alert" class="desktop__error"><p>The transcript could not be read. Check the connection and refresh.</p><button type="button" onClick={messages.refetch} disabled={!reading()}>Refresh transcript</button></div>}>
        <Show when={turns().length} fallback={<p>No messages in this Session yet.</p>}><ol class="transcript rl-thread" aria-label="Transcript"><Index each={turns()}>{(item) => <>
          <TurnView message={item()} />
          <Show when={editPlacements().get(item().id)}>{(edit) => <li class="transcript__turn transcript__edits"><SharedEditedFilesCard files={edit().files} onViewChanges={(path) => { setSelectedTurn(edit().turnID); openChanges(path) }} onUndo={() => { setSelectedTurn(edit().turnID); openChanges(); void doRevert("stage") }} undoDisabled={revertBusy() || revertUncertain() || running()} footerNote={activeRevert() ? "Staged revert · preview and confirmation required" : undefined} /></li>}</Show></>}</Index></ol></Show>
      </Show></Show>
      <Show when={requests.result().isError}><div role="alert" class="desktop__error"><p>Pending requests could not be read. Refresh to retry.</p><button type="button" onClick={requests.refetch} disabled={!reading()}>Refresh requests</button></div></Show>
      <Show when={requests.result().data && !pendingRequests()}><p role="status">Refreshing requests after a connection change…</p></Show>
      <Show when={pendingRequests()}>{(data) => <Requests data={data()} updatedAt={requests.result().dataUpdatedAt} refetch={requests.refetch} />}</Show>
    </div></div></div>
    <div class="rl-dock"><div class="rl-col"><div class="conversation__jump-slot" ref={jumpSlot}><JumpControls clearance={clearance()} onTop={targets().top ? jumpToTop : undefined} onBottom={targets().bottom ? jumpToLatest : undefined} /></div><SharedComposerSurface formClass="composer" busy={sending()} onSubmit={(event) => { event.preventDefault(); void send() }} field={<div class="rl-capsule"><ComposerField label="Message" value={pending()?.text ?? text()} locked={!!pending()} source={props.sessionID} directory={session()?.location.directory ?? ""} localCommands={localSlash} picks={picks()} onPicks={setPicks} onInput={update} onSubmit={() => void send()} onAttachFiles={(added) => setFiles((current) => promptFilesFor(current, added))} /><div class="composer-bar"><AttachButton directory={session()?.location.directory} files={files()} onChange={setFiles} locked={!!pending() || sending()} /><Show when={session()} fallback={<span class="composer-bar__spacer" />}>{(item) => <ModelPicker sessionID={props.sessionID} model={item().model} running={running()} agent={item().agent} sessionUsage={usage(item())} autonomyLabel={policyLabels().autonomy} onAutonomy={() => policyOpen() ? setPolicyOpen(false) : openPolicy()} openTick={modelTick()} />}</Show><button type="submit" class="rl-send desktop__primary" aria-label={sending() ? "Sending" : pending() ? "Retry sending" : "Send prompt"} disabled={sending() || !reading() || unsure() || revertBusy() || revertUncertain() || (!pending() && !text().trim())}><Icon name="arrow-up" /></button><Show when={running()}><button type="button" class="rl-stop" aria-label="Stop" disabled={stopping() || !reading()} onClick={() => void stop()}><Icon name="stop" /></button></Show></div></div>} feedback={<>
      <div class="desktop__feedback"><Show when={error()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show><Show when={sending()}><p role="status">Sending…</p></Show><Show when={slashNote()}>{(note) => <p role="status">{note()}</p>}</Show><Show when={revertUncertain()}><p role="status">Review the Session and staged revert before continuing.</p></Show><Show when={!reading()}><p role="status">Reconnecting. Sending resumes when the backend is connected.</p></Show></div>
      <div class="desktop__actions">
        <Show when={unsure() && !sending()}><button type="button" onClick={() => { update(pending()?.text ?? text()); hold(undefined); promptGuard.reset(); unconfirmed.delete(props.sessionID); setUnsure(false); setRevertUncertain(false); setError(undefined); sessionRead.refetch() }}>I reviewed the Session</button></Show><Show when={pending() && !sending() && !unsure()}><button type="button" onClick={() => { update(pending()?.text ?? ""); hold(undefined); setError(undefined) }}>Edit as a new message</button></Show>
        <Show when={stopNote()}>{(note) => <span role="status" class="desktop__muted">{note()}</span>}</Show></div></>} />
    <Show when={policyOpen()}><section class="desktop-popover rl-policy-panel" aria-label="Goal and autonomy"><div class="rl-pane-section-heading"><strong>Goal and autonomy</strong><button type="button" class="rl-btn" onClick={() => setPolicyOpen(false)}>Close</button></div><Show when={!autonomy()}><p role="status">Goal and autonomy are unavailable until the Session state is read.</p><Show when={autonomyRead.result().isError}><button type="button" class="rl-btn" onClick={autonomyRead.refetch}>Refresh</button></Show></Show><Show when={autonomy()}><p class="model-popover__label">Permissions</p><SharedRadioGroup label="Permissions" options={decisionModes} value={permissions()} disabled={policyBusy() || policyUncertain()} onChange={(value) => setPermissions(value as "manual" | "auto" | "yolo")} /><p class="model-popover__label">Guardrails</p><SharedRadioGroup label="Guardrails" options={decisionModes} value={guardrails()} disabled={policyBusy() || policyUncertain()} onChange={(value) => setGuardrails(value as "manual" | "auto" | "yolo")} /><p class="model-popover__label">Answers</p><SharedRadioGroup label="Answers" options={decisionModes} value={answers()} disabled={policyBusy() || policyUncertain()} onChange={(value) => setAnswers(value as "manual" | "auto" | "yolo")} /><div class="rl-policy-actions"><button type="button" class="rl-btn" disabled={policyBusy() || policyUncertain() || !reading()} onClick={() => void setPolicy({ permissions: permissions(), guardrails: guardrails(), answers: answers() }, `Change autonomy decisions to ${permissions()}/${guardrails()}/${answers()}?`)}>Apply autonomy</button><button type="button" class="rl-btn" disabled={policyBusy() || policyUncertain() || !reading()} onClick={() => void setPolicy({ sleep: !autonomy()?.effective.asleep }, autonomy()?.effective.asleep ? "Wake autonomy decisions?" : "Put autonomy decisions to sleep?")}>{autonomy()?.effective.asleep ? "Wake" : "Sleep"}</button></div><label class="desktop__field">Goal<textarea value={policyGoal()} disabled={policyBusy() || policyUncertain()} onInput={(event) => setPolicyGoal(event.currentTarget.value)} /></label><div class="rl-policy-actions"><button type="button" class="rl-btn" disabled={policyBusy() || policyUncertain() || !reading() || !policyGoal().trim()} onClick={() => void setPolicy({ goal: policyGoal().trim() }, "Replace the Session goal with this text?")}>Set goal</button><button type="button" class="rl-btn" disabled={policyBusy() || policyUncertain() || !reading() || (!autonomy()?.goal || autonomy()?.goal?.status === "stopped")} onClick={() => void setPolicy({ goal: null }, "Stop the Session goal? Its text will be retained.")}>Stop goal</button></div></Show><Show when={policyError()}>{(error) => <p role="alert">{error()}</p>}</Show></section></Show><div class="rl-whisper" classList={{ desktop__sr: !running() }}>{running() ? "Working" : "Ready"}</div></div></div>
    <Show when={companionOpen()}><aside class="rl-companion" data-full={fullChangesOpen() && companionTab() === "Changes" ? "true" : undefined}><SharedCompanionSurface policyActions={policyButtons()} active={companionTab().toLowerCase() as "activity" | "changes" | "context"} onSelect={(tab) => setCompanionTab(tab === "activity" ? "Activity" : tab === "changes" ? "Changes" : "Context")} headerActions={<button type="button" class="rl-icon" aria-label="Close companion" onClick={() => setCompanionOpen(false)}><Icon name="close" /></button>} onRefresh={() => { if (reading()) { activityRead.refetch(); sessions.refetch(); messages.refetch(); requests.refetch() } }} activityContent={<div class="rl-pane-body"><Show when={activityRead.result().isPending}><p role="status">Loading activity…</p></Show><Show when={activityRead.result().isError}><p role="alert">{failure(activityRead.result().error, "Activity could not be read. Refresh to retry.")}</p></Show><Show when={activityView()}>{(data) => <SharedActivitySurface shells={data().shells} onSelectShell={selectShell} shellOutput={shellOutput()} subagentNext={data().subagentNext} loadingMoreSubagents={activityMoreBusy()} onLoadMoreSubagents={() => void loadMoreSubagents()} subagents={data().subagents.map((task) => ({ sessionID: task.sessionID, agent: task.agent, description: task.description, state: task.state, model: task.model.id, progressText: task.progress?.text, questionText: task.question?.text, onOpen: () => void navigate({ to: "/sessions/$sessionID", params: { sessionID: task.sessionID } }) }))} childSessions={children().map((entry) => ({ id: entry.row.id, title: entry.row.title, status: entry.status, onOpen: () => void navigate({ to: "/sessions/$sessionID", params: { sessionID: entry.row.id } }) }))} notices={[...surfaceNotices.activity(data()), ...(activityMoreError() ? [activityMoreError()!] : [])]} changesSummary={changeData()?.items.length ? { additions: changeData()!.items.reduce((sum, file) => sum + file.additions, 0), deletions: changeData()!.items.reduce((sum, file) => sum + file.deletions, 0), onOpenChanges: () => openChanges() } : undefined} capabilityNote="Only loaded Sessions and live status since connection are shown." />}</Show><Show when={sessions.result().isError}><p role="alert">Child Sessions could not be read. Refresh to retry.</p></Show></div>} changesContent={<div class="rl-pane-body"><Show when={changes.result().isPending}><p role="status">Loading changes…</p></Show><Show when={changes.result().isError}><p role="alert">{failure(changes.result().error, "Changes could not be read. Refresh to retry.")}</p><button type="button" class="rl-btn" onClick={changes.refetch} disabled={!reading()}>Refresh</button></Show><Show when={changeData()}>{(data) => <SharedChangesSurface files={data().items} turnsNotice={data().turnsNotice} onOpenFullChanges={() => setFullChangesOpen((value) => !value)} fullChangesLabel={fullChangesOpen() ? "Compact changes view" : "Open full changes page"} turns={data().turns?.map((turn) => ({ ...turn, label: `${turn.type} · ${turn.id}` }))} selectedTurnID={selectedTurn()} onSelectTurn={(id) => { if (!activeRevert() && !revertUncertain()) setSelectedTurn(id) }} revert={revert()} selectedPath={selectedFile()} onSelectFile={setSelectedFile} onRefresh={changes.refetch} refreshing={changes.result().isFetching || !reading()} scopeTruth="Captured changes belong to this Session. Turn filters show only loaded captured inputs." />}</Show></div>} contextContent={<div class="rl-pane-body"><Show when={messages.result().isPending}><p role="status">Loading context…</p></Show><Show when={messages.result().isError}><p role="alert">Context could not be read. Refresh to retry.</p><button type="button" class="rl-btn" onClick={messages.refetch} disabled={!reading()}>Refresh</button></Show><Show when={!messages.result().isPending && !messages.result().isError}><Context messages={messages.result().data ?? []} model={session()?.model} /></Show></div>} /></aside></Show>
  </section>
}

const root = createRootRoute({ component: App })
const workspaceRoute = createRoute({ getParentRoute: () => root, id: "_workspace", component: Workspace })
const indexRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/", component: () => null })
const newChatRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/chat", component: NewChat })
function Destination(props: { name: "Projects" | "Sessions" | "Workspaces" | "Usage" | "Settings" }) {
  const navigate = useNavigate()
  createEffect(() => { props.name; queueMicrotask(() => document.querySelector<HTMLElement>("[data-page-heading]")?.focus({ preventScroll: true })) })
  const [search, setSearch] = createSignal("")
  const [range, setRange] = createSignal<UsageRange>("all")
  const [filter, setFilter] = createSignal<"All" | "Waiting" | "Running" | "Unknown">("All")
  const term = () => searchTerm(search())
  const [applied, setApplied] = createSignal("")
  createEffect(() => { const next = term(); if (!next.error) { const timer = setTimeout(() => setApplied(next.value), 250); onCleanup(() => clearTimeout(timer)) } })
  const sessions = observe(() => ({ ...sessionsQuery(applied()), enabled: reading() && (props.name === "Sessions" || props.name === "Projects" || props.name === "Workspaces") }))
  const [paging, setPaging] = createSignal<Paging>()
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [pageError, setPageError] = createSignal<string>()
  createEffect(() => { void scope(); void applied(); setPaging(undefined) })
  const page = () => { const first = sessions.result().data; return first ? pagingFor(first, applied(), paging()) : undefined }
  const sessionRows = () => { const first = sessions.result().data; const current = page(); return first && current ? pagedItems(first, current) : [] }
  const visibleRows = () => sessionRows().filter((row) => filter() === "All" || (filter() === "Waiting" ? (activity().waiting.get(row.id)?.size ?? 0) > 0 : filter() === "Running" ? activity().busy.has(row.id) : !activity().busy.has(row.id) && !(activity().waiting.get(row.id)?.size)))
  const loadMore = async () => {
    const current = page(); if (!current?.next || loadingMore() || !reading()) return
    const generation = connection().generation; setLoadingMore(true); setPageError(undefined)
    try { const result = await api.sessions({ revision: current.revision, cursor: current.next }); if (connection().generation === generation && samePaging(page(), current)) { const next = appendPage(current, result); if (next) setPaging(next); else { setPaging(undefined); sessions.refetch() } } }
    catch (cause) { if (connection().generation === generation && samePaging(page(), current)) { setPageError(failure(cause, "More Sessions could not be read.")); setPaging(undefined); sessions.refetch() } }
    finally { setLoadingMore(false) }
  }
  const [pinning, setPinning] = createSignal<string>()

  const workspaces = observe(() => ({ queryKey: ["workspaces", ...scope()] as const, queryFn: () => api.workspaces(), enabled: reading() && (props.name === "Workspaces" || props.name === "Projects") }))
  const projects = observe(() => ({ queryKey: ["projects", ...scope()] as const, queryFn: () => api.projects(), enabled: reading() && (props.name === "Projects" || props.name === "Workspaces") }))
  const usageRead = observe(() => ({ queryKey: ["usage", ...scope(), range()] as const, queryFn: () => api.usage({ range: range() }), enabled: reading() && props.name === "Usage" }))
  const projectData = () => projects.result().isError ? undefined : currentSnapshot(projects.result().data, connection().revision)
  const usageData = () => usageRead.result().isError ? undefined : currentSnapshot(usageRead.result().data, connection().revision)
  const [projectPages, setProjectPages] = createSignal<NonNullable<ReturnType<typeof projectData>>>()
  const [projectBusy, setProjectBusy] = createSignal(false)
  const [projectError, setProjectError] = createSignal<string>()
  createEffect(() => { void projects.result().data; setProjectPages(undefined); setProjectError(undefined) })
  const projectView = () => projects.result().isError ? undefined : currentSnapshot(projectPages(), connection().revision) ?? projectData()
  const loadMoreProjects = async () => {
    const current = projectView(); if (!current?.repositoriesNext || projectBusy() || !reading()) return
    const generation = connection().generation; setProjectBusy(true); setProjectError(undefined)
    try { const page = await api.projects({ cursor: current.repositoriesNext, revision: current.revision }); if (connection().generation !== generation || projectView() !== current || page.revision !== current.revision) return; const seen = new Set(current.repositories.map((row) => row.directory)); setProjectPages({ ...page, repositories: [...current.repositories, ...page.repositories.filter((row) => !seen.has(row.directory))] }) }
    catch (cause) { if (connection().generation === generation && projectView() === current) setProjectError(failure(cause, "More repositories could not be read.")) }
    finally { setProjectBusy(false) }
  }
  const [expandedProject, setExpandedProject] = createSignal<string>()
  const [selectedProject, setSelectedProject] = createSignal<string>()
  const [pinMode, setPinMode] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [projectName, setProjectName] = createSignal("")
  const [members, setMembers] = createSignal<string[]>([])
  const [copyFormOpen, setCopyFormOpen] = createSignal(false)
  const [copyDirectory, setCopyDirectory] = createSignal("")
  const [actionBusy, setActionBusy] = createSignal(false)
  const [actionUncertain, setActionUncertain] = createSignal(false)
  const [actionNotice, setActionNotice] = createSignal<string>()
  const [notificationsOpen, setNotificationsOpen] = createSignal(false)
  const [permissionsOpen, setPermissionsOpen] = createSignal(false)
  const [closeOpen, setCloseOpen] = createSignal(false)
  const settingsRead = observe(() => ({ queryKey: ["settings", ...scope()] as const, queryFn: () => api.settings(), enabled: reading() && props.name === "Settings" }))
  const settingsData = () => settingsRead.result().isError ? undefined : currentSnapshot(settingsRead.result().data, connection().revision)
  const projectGuard = createActionGuard<ProjectMutationInput, Awaited<ReturnType<typeof api.changeProject>>>((message) => confirmInPage(message), () => `${scope().join(":")}:${connection().status}`, async (input) => { const result = await api.changeProject(input); if (result.revision !== input.revision) throw new Error("The project change was not confirmed."); return result })
  const workspaceGuard = createActionGuard<WorkspaceMutationInput, Awaited<ReturnType<typeof api.changeWorkspace>>>((message) => confirmInPage(message), () => `${scope().join(":")}:${connection().status}`, async (input) => { const result = await api.changeWorkspace(input); if (result && (result.revision !== input.revision || result.projectID !== input.projectID)) throw new Error("The workspace change was not confirmed."); return result })
  const settingsGuard = createActionGuard<SettingsMutationInput, Awaited<ReturnType<typeof api.changeSettings>>>((message) => confirmInPage(message), () => `${scope().join(":")}:${connection().status}`, async (input) => { const result = await api.changeSettings(input); if (result.revision !== input.revision) throw new Error("The settings change was not confirmed."); return result })
  const pinGuard = createActionGuard<PinRequest, void>((message) => confirmInPage(message), () => `${scope().join(":")}:${connection().status}`, (input) => api.pin(input))
  const perform = async <T, R>(guard: { run: (input: T, message: string) => Promise<{ status: "cancelled" | "blocked" | "unconfirmed"; error?: unknown } | { status: "completed"; value: R }> }, input: T, message: string, done: () => void) => {
    if (actionBusy() || actionUncertain() || !reading()) return
    setActionBusy(true); setActionNotice(undefined)
    const result = await guard.run(input, message)
    if (result.status === "completed") done()
    else if (result.status === "unconfirmed") { setActionUncertain(true); setActionNotice(failure(result.error, "The change was not confirmed. Reopen this page and review its state.")) }
    setActionBusy(false)
  }
  const selectedWorkspace = () => selectedWorkspaceOf(projectView()?.repositories ?? [], expandedProject())
  const [explorerDir, setExplorerDir] = createSignal<string>()
  const [explorerHidden, setExplorerHidden] = createSignal(false)
  createEffect(() => { void selectedWorkspace()?.directory; setExplorerDir(undefined) })
  const explorerRead = observe(() => ({ queryKey: ["workspace-explorer", ...scope(), explorerDir() ?? selectedWorkspace()?.directory, explorerHidden()] as const, queryFn: () => api.browseDirectory({ directory: explorerDir() ?? selectedWorkspace()?.directory, showHidden: explorerHidden() }), enabled: reading() && props.name === "Workspaces" && !!selectedWorkspace() }))
  createEffect(() => { const workspace = selectedWorkspace(); if (workspace && expandedProject() !== workspaceKeyOf(workspace)) setExpandedProject(workspaceKeyOf(workspace)) })
  const selectedGroup = () => projectView()?.groups.find((group) => group.id === selectedProject()) ?? projectView()?.groups[0]
  createEffect(() => { const group = selectedGroup(); if (group && selectedProject() !== group.id) setSelectedProject(group.id) })
  const directories = observe(() => ({ queryKey: ["workspace-directories", ...scope(), expandedProject(), selectedWorkspace()?.directory] as const, queryFn: () => api.workspaceDirectories!({ projectID: selectedWorkspace()!.projectID, directory: selectedWorkspace()!.directory }), enabled: reading() && !!selectedWorkspace() && !!api.workspaceDirectories }))

  const start = (directory: string) => { setNewDirectory(directory); void navigate({ to: "/chat" }) }
  const activeSessionRead = observe(() => ({ queryKey: ["session", ...scope(), lastSessionID()] as const, queryFn: () => api.session({ sessionID: lastSessionID()! }), enabled: reading() && !!lastSessionID() && (props.name === "Sessions" || props.name === "Workspaces") }))
  const currentSessionRow = () => lastOpenedSessionOf(sessionRows(), lastSessionID()) ?? (activeSessionRead.result().data?.revision === connection().revision && activeSessionRead.result().data?.item.id === lastSessionID() ? activeSessionRead.result().data?.item : undefined)
  const name = props.name
  const rangeOptions = [{ label: "Today", value: "today" }, { label: "7 days", value: "7d" }, { label: "30 days", value: "30d" }, { label: "All time", value: "all" }] as const
  const mobile = <button type="button" class="desktop__rail-toggle rl-mobile-menu" aria-label="Open navigation" aria-expanded={railOpen()} aria-controls="session-rail" onClick={() => setRailOpen(true)}><Icon name="menu" /></button>
  const subtitle = name === "Projects" ? "One master Session coordinating member Sessions" : name === "Usage" ? "Requests, tokens and provider quota windows" : name === "Settings" ? "Machine and notification settings for this Mac" : "On this Mac"
  const performProject = (input: ProjectMutationInput, message: string) => void perform(projectGuard, input, message, () => { setCreating(false); setMembers([]); setProjectName(""); projects.refetch() })
  const performWorkspace = (input: WorkspaceMutationInput, message: string) => void perform(workspaceGuard, input, message, () => { setCopyFormOpen(false); setCopyDirectory(""); projects.refetch(); directories.refetch() })
  const performSettings = (input: SettingsMutationInput, message: string) => void perform(settingsGuard, input, message, settingsRead.refetch)
  return <SharedPageSurface title={name} sub={`${subtitle} · ${connectionOwnership()}`} mobileMenu={mobile} onBack={() => window.history.back()} actions={name === "Sessions" ? <><button type="button" class="rl-btn" onClick={() => void navigate({ to: "/workspaces" })}>Workspaces</button><Show when={currentSessionRow()}>{(row) => <button type="button" class="rl-btn" data-action-id="ws-list-manage" onClick={() => void navigate({ to: "/sessions/$sessionID", params: { sessionID: row().id } })}>Manage this Session</button>}</Show></> : undefined}>
    <Show when={actionNotice()}>{(notice) => <p role="alert" class="desktop__error">{notice()}</p>}</Show>
    <Show when={name === "Projects"}>
      <Show when={projects.result().isError}><p role="alert" class="desktop__error">Projects could not be read. Refresh to retry.</p></Show>
      <Show when={projectView()}>{(data) => <SharedProjectsSurface directories={workspaces.result().data ?? []} onBrowseFolder={(curr, choose) => openFolderPicker({ title: "Choose folder for new Master Session", mode: "directory", initialDirectory: curr || undefined, onPick: choose })} onCreateProject={(input) => performProject({ kind: "create", revision: data().revision, name: input.name, masterSessionID: input.masterSessionID, memberSessionIDs: input.memberSessionIDs }, `Create project ${input.name} with ${input.masterSessionID} as its master Session?`)} onCreateProjectInDirectory={(input) => performProject({ kind: "create-in-directory", revision: data().revision, name: input.name, directory: input.directory, ...(input.masterTitle ? { masterTitle: input.masterTitle } : {}), memberSessionIDs: input.memberSessionIDs }, `Create project ${input.name} with a new Master Session in ${input.directory}?`)} projects={data().groups.map((group) => ({ id: group.id, name: group.name, masterTitle: group.master.title, active: group.active, statusText: group.active ? "Active" : "Paused", revision: group.revision, master: group.master, members: group.members, delegatedText: group.settings.delegatedDecisions ? [group.settings.delegatedDecisions.categories.join(", "), ...(group.settings.delegatedDecisions.actions?.length ? [`actions: ${group.settings.delegatedDecisions.actions.join(", ")}`] : []), ...(group.settings.delegatedDecisions.resources?.length ? [`resources: ${group.settings.delegatedDecisions.resources.join(", ")}`] : []), ...(group.settings.delegatedDecisions.expiresAt ? [`expires ${new Date(group.settings.delegatedDecisions.expiresAt).toLocaleString()}`] : [])].join(" · ") : "None reported", concurrency: group.settings.concurrency == null ? "none" : String(group.settings.concurrency), openNote: "Open the master Session" }))} selectedID={selectedGroup()?.id} refreshing={projects.result().isFetching} busy={actionBusy() || actionUncertain()} notice={surfaceNotices.projects(data())} creating={creating()} name={projectName()} candidates={sessionRows().map((row) => ({ id: row.id, title: row.title, selected: members().includes(row.id) }))} onRefresh={projects.refetch} onOpenCreate={() => setCreating(true)} onName={setProjectName} onToggleMember={(id) => setMembers((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} onCreate={() => { const masterSessionID = members()[0]; if (!projectName().trim() || !masterSessionID) { setActionNotice("Enter a project name and select a master Session first."); return } performProject({ kind: "create", revision: data().revision, name: projectName().trim(), masterSessionID, memberSessionIDs: members().slice(1) }, `Create project ${projectName().trim()} with ${masterSessionID} as its master Session?`) }} onCancelCreate={() => setCreating(false)} onSelect={setSelectedProject} onChangeConcurrency={(value) => { const group = selectedGroup(); if (group) performProject({ kind: "update", revision: data().revision, groupID: group.id, groupRevision: group.revision, concurrency: value === "none" ? null : Number(value) }, `Change ${group.name} concurrency to ${value}?`) }} concurrencyControl={(project) => <DesktopSelect label="Members running at once" value={project.concurrency ?? "none"} disabled={actionBusy() || actionUncertain()} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "4", label: "4" }, { value: "none", label: "No limit" }]} onChange={(value) => performProject({ kind: "update", revision: data().revision, groupID: project.id, groupRevision: project.revision, concurrency: value === "none" ? null : Number(value) }, `Change ${project.name} concurrency to ${value}?`)} />} onOpenMaster={(sessionID) => void navigate({ to: "/sessions/$sessionID", params: { sessionID } })} onDeleteProject={(groupID) => performProject({ kind: "delete", revision: data().revision, groupID }, "Delete this project? Sessions remain available.")} />}</Show>
    </Show>
    <Show when={name === "Sessions"}>
      <Show when={sessions.result().isError}><p role="alert" class="desktop__error">Sessions could not be read. Refresh to retry.</p><button type="button" class="rl-btn" onClick={sessions.refetch}>Refresh</button></Show>
      <SharedSessionsSurface search={search()} searchError={term().error} filters={(["All", "Waiting", "Running", "Unknown"] as const).map((value) => ({ value, label: value, count: sessionRows().filter((row) => value === "All" || (value === "Waiting" ? (activity().waiting.get(row.id)?.size ?? 0) > 0 : value === "Running" ? activity().busy.has(row.id) : !activity().busy.has(row.id) && !(activity().waiting.get(row.id)?.size))).length }))} filter={filter()} pinning={pinMode()} items={visibleRows().map((row) => ({ id: row.id, title: row.title, hint: `${workspaceBase(row.location.directory)} · ${(activity().waiting.get(row.id)?.size ?? 0) > 0 ? "Waiting" : activity().busy.has(row.id) ? "Running" : "Status unknown"}`, meta: new Date(row.time.updated).toLocaleString(), pinned: row.time.pinned !== undefined }))} totalLoaded={sessionRows().length} pinnedCount={sessionRows().filter((row) => row.time.pinned !== undefined).length} statusNote="Status is known only from live events since connection" hasMore={page()?.next !== undefined} loadingMore={loadingMore()} selectedID={currentSessionRow()?.id} onNewSession={() => void navigate({ to: "/chat" })} onSearch={setSearch} onFilter={(value) => { if (value === "All" || value === "Waiting" || value === "Running" || value === "Unknown") setFilter(value) }} onTogglePinMode={() => setPinMode(!pinMode())} onTogglePin={(id, pinned) => { const revision = sessions.result().data?.revision; if (revision !== undefined) void perform(pinGuard, { sessionID: id, revision, pinned }, `${pinned ? "Pin" : "Unpin"} this Session?`, () => { setPaging(undefined); sessions.refetch() }) }} onSelect={(sessionID) => { const row = sessionRows().find((item) => item.id === sessionID); const revision = sessions.result().data?.revision; if (pinMode() && row && revision !== undefined) void perform(pinGuard, { sessionID, revision, pinned: row.time.pinned === undefined }, `${row.time.pinned === undefined ? "Pin" : "Unpin"} this Session?`, () => { setPaging(undefined); sessions.refetch() }); else if (!pinMode()) void navigate({ to: "/sessions/$sessionID", params: { sessionID } }) }} onLoadMore={() => void loadMore()} />
      <Show when={pageError()}>{(error) => <p role="alert" class="desktop__error">{error()}</p>}</Show>
    </Show>
    <Show when={name === "Workspaces"}>
      <Show when={projects.result().isError}><p role="alert" class="desktop__error">Workspaces could not be read.</p></Show>
      <Show when={projectView()}>{(data) => <><SharedWorkspacesSurface onOpenFolder={() => openFolderPicker({ title: "Open workspace folder", mode: "directory", onPick: (dir) => { projects.refetch(); workspaces.refetch(); start(dir) } })} onCreateFolder={() => openFolderPicker({ title: "Create new workspace folder", mode: "create-directory", initialDirectory: selectedWorkspace()?.directory, onPick: (dir) => { projects.refetch(); workspaces.refetch(); start(dir) } })} explorer={selectedWorkspace() ? { directory: explorerRead.result().data?.directory ?? explorerDir() ?? selectedWorkspace()!.directory, rootDirectory: selectedWorkspace()!.directory, parent: explorerRead.result().data?.parent, entries: explorerRead.result().data?.entries ?? [], truncated: explorerRead.result().data?.truncated, loading: explorerRead.result().isFetching, error: explorerRead.result().isError ? failure(explorerRead.result().error, "Folder could not be read.") : undefined, showHidden: explorerHidden(), onNavigate: setExplorerDir, onToggleHidden: () => setExplorerHidden(!explorerHidden()), onCreateFolder: (parent) => openFolderPicker({ title: "New folder", mode: "create-directory", initialDirectory: parent, onPick: (dir) => { setExplorerDir(dir); explorerRead.refetch() } }), onStartChatInFolder: (dir) => { const starting = scope().join(":"); void api.openDirectory({ directory: dir }).then((opened) => { if (scope().join(":") !== starting) return; setOpenedDirectories((previous) => new Set(previous).add(opened.directory)); workspaces.refetch(); projects.refetch(); start(opened.directory) }, (cause) => setActionNotice(failure(cause, "Folder could not be opened."))) } } : undefined} workspaces={[...data().repositories].sort((a, b) => (b.sessions > 0 ? 1 : 0) - (a.sessions > 0 ? 1 : 0) || (a.projectName ?? workspaceBase(a.directory)).localeCompare(b.projectName ?? workspaceBase(b.directory))).map((repository) => ({ key: workspaceKeyOf(repository), projectID: repository.projectID, name: repository.projectName ?? workspaceBase(repository.directory), directory: repository.directory, sessions: repository.sessions, topLevelSummary: "Not reported", childSummary: "Not reported", copies: selectedWorkspace() && workspaceKeyOf(selectedWorkspace()!) === workspaceKeyOf(repository) ? (currentSnapshot(directories.result().data, connection().revision)?.projectID === repository.projectID ? directories.result().data!.directories : []).map((item) => ({ name: item.name ?? workspaceBase(item.directory), directory: item.directory, label: item.available === false ? "Unavailable" : item.kind })) : [] }))} selectedID={selectedWorkspace() ? workspaceKeyOf(selectedWorkspace()!) : undefined} currentSession={currentSessionRow() ? { title: currentSessionRow()!.title, directory: currentSessionRow()!.location.directory, workspace: workspaceBase(currentSessionRow()!.location.directory) } : undefined} copiesBusy={directories.result().isFetching || actionBusy()} copiesStatus={directories.result().isError ? "Copies could not be read." : undefined} onSelect={setExpandedProject} onRefreshCopies={(workspace) => performWorkspace({ kind: "refresh-copies", revision: data().revision, projectID: workspace.projectID, directory: workspace.directory }, `Refresh copies for ${workspace.name}?`)} onOpenCreateCopy={() => setCopyFormOpen(true)} onStartChat={start} onForgetWorkspace={(workspace) => performWorkspace({ kind: "forget", revision: data().revision, projectID: workspace.projectID, directory: workspace.directory }, `Forget workspace ${workspace.directory}? This permanently removes Sessions in that directory and their descendant Sessions, including descendants in other directories.`)} copyForm={copyFormOpen() ? <div class="st-form"><label class="rl-field"><span>Copy directory</span><input value={copyDirectory()} onInput={(event) => setCopyDirectory(event.currentTarget.value)} /></label><div class="st-form-actions"><button type="button" class="rl-btn" disabled={!copyDirectory().trim() || actionBusy() || actionUncertain()} onClick={() => { const workspace = selectedWorkspace(); const target = copyDirectory().trim().replace(/\/+$/, ""); const cut = target.lastIndexOf("/"); if (workspace) performWorkspace({ kind: "create-copy", revision: data().revision, projectID: workspace.projectID, sourceDirectory: workspace.directory, directory: cut > 0 ? target.slice(0, cut) : target, ...(cut > 0 ? { name: target.slice(cut + 1) } : {}) }, `Create a copy at ${target}?`) }}>Create copy</button><button type="button" class="rl-btn" onClick={() => setCopyFormOpen(false)}>Cancel</button></div></div> : undefined} /><Show when={data().repositoriesNext}><button type="button" class="rl-btn" disabled={projectBusy()} onClick={() => void loadMoreProjects()}>Load more repositories</button></Show></>}</Show>
    </Show>
    <Show when={name === "Usage"}><Show when={usageData()} fallback={<Show when={usageRead.result().isError} fallback={<SharedLoadingSkeleton kind="page" label="Loading usage…" />}><p role="alert" class="desktop__error">Usage could not be read.</p><button type="button" class="rl-btn" onClick={usageRead.refetch}>Refresh</button></Show>}>
      {(data) => <SharedUsageSurface phase="ready" statusText="Updated · retained analytics, not a bill" ranges={rangeOptions} range={range()} rangeLabel={rangeOptions.find((item) => item.value === range())?.label ?? range()} requests={formatCount(data().report.total.logical)} inputTokens={formatCompactCount(data().report.total.tokens.input)} outputTokens={formatCompactCount(data().report.total.tokens.output)} estimatedCost={costLabel(data().report.total.cost)} detailLine={`Cache read ${formatCompactCount(data().report.total.tokens.cache.read)} · Cache write ${formatCompactCount(data().report.total.tokens.cache.write)} · Helpers ${formatCount(data().report.total.helpers)} · Fallbacks ${formatCount(data().report.total.fallback)}`} refreshing={usageRead.result().isFetching} quotas={formatQuotaProviders(data().quotas ?? [], Date.now())} models={data().report.rows.map((row) => ({ name: row.model ? `${row.model.providerID} / ${row.model.id}` : row.label, detail: `${formatCount(row.logical)} ${row.logical === 1 ? "request" : "requests"} · ${formatCompactCount(row.tokens.input)} in · ${formatCompactCount(row.tokens.output)} out${row.tokens.cache.read > 0 ? ` · ${formatCompactCount(row.tokens.cache.read)} cache` : ""}`, value: costLabel(row.cost) }))} modelsNote={data().quotasNotice ?? surfaceNotices.usage(data())} onRange={(value) => { if (value === "today" || value === "7d" || value === "30d" || value === "all") setRange(value) }} onRefresh={usageRead.refetch} />}
    </Show></Show>
    <Show when={name === "Settings"}><div class="st-ledger"><MachineBackendSection keepAwake={<Show when={settingsData()}>{(data) => <KeepAwakeRow checked={data().keepAwake.state === "on"} unsupported={data().keepAwake.state === "unsupported" || data().keepAwake.state === "error"} disabled={actionBusy() || actionUncertain()} detail={data().keepAwake.message ?? data().keepAwake.state} onToggle={(enabled) => performSettings({ kind: "keep-awake", revision: data().revision, enabled }, `${enabled ? "Enable" : "Disable"} keep awake?`)} />}</Show>} /><UpdatesSection triggerTick={updateTriggerTick()} /><Show when={settingsData()} fallback={<Show when={settingsRead.result().isError} fallback={<SharedLoadingSkeleton kind="page" label="Loading settings…" />}><section class="st-section"><p role="alert" class="desktop__error">Settings could not be read.</p><button type="button" class="rl-btn" onClick={settingsRead.refetch}>Refresh</button></section></Show>}>
      {(data) => <SharedSettingsSurface colorSchemeControl={<DesktopSelect label="Color scheme" value={themePreference()} options={DESKTOP_THEMES.map((theme) => ({ value: theme.id, label: theme.label, description: theme.description }))} onChange={(value) => { if (isDesktopThemeID(value)) applyThemePreference(value) }} />} hideKeepAwakeSection notificationsOpen={notificationsOpen()} savedPermissionsOpen={permissionsOpen()} closeAppOpen={closeOpen()} animations={animationsEnabled()} keepAwakeStatus={data().keepAwake.state === "unsupported" || data().keepAwake.state === "error" ? "unsupported" : "supported"} keepAwakeChecked={data().keepAwake.state === "on"} keepAwakeDisabled={actionBusy() || actionUncertain() || (data().keepAwake.state === "unsupported" || data().keepAwake.state === "error")} keepAwakeDetail={data().keepAwake.message ?? data().keepAwake.state} telemetryConsent={data().telemetryConsent.consent ? data().telemetryConsent.consent!.enabled ? "enabled" : "disabled" : "undecided"} telemetryNote={data().telemetryNotice ?? (data().telemetryConsent.consent ? `Decided ${new Date(data().telemetryConsent.consent!.decidedAt).toLocaleString()}` : "Not decided yet")} telemetryBusy={actionBusy() || actionUncertain()} latencySamples={data().telemetrySamples.map((entry) => ({ label: entry.sample.kind, detail: Number.isNaN(Date.parse(entry.sample.at)) ? entry.sample.at : new Date(entry.sample.at).toLocaleString(), value: "durationMs" in entry.sample ? formatDurationMs(entry.sample.durationMs) : "Reported" }))} onToggleAnimations={applyAnimationsPreference} onToggleKeepAwake={(enabled) => performSettings({ kind: "keep-awake", revision: data().revision, enabled }, `${enabled ? "Enable" : "Disable"} keep awake?`)} onDecideTelemetry={(enabled) => performSettings({ kind: "telemetry-consent", revision: data().revision, enabled, noticeVersion: 1 }, `${enabled ? "Share" : "Do not share"} latency diagnostics?`)} onToggleNotifications={() => setNotificationsOpen(!notificationsOpen())} onToggleSavedPermissions={() => setPermissionsOpen(!permissionsOpen())} onToggleCloseApp={() => setCloseOpen(!closeOpen())} notificationsContent={notificationsOpen() ? <div class="st-stack"><p class="st-muted">Attention is reported in the terminal; notification center is a web feature.</p><For each={[...activity().waiting.entries()]} fallback={<p class="st-muted">No pending attention is reported.</p>}>{([id, requests]) => <p class="st-muted">{id} · {requests.size} pending requests</p>}</For></div> : undefined} savedPermissionsContent={permissionsOpen() ? <div class="st-stack"><Show when={data().savedPermissions.length} fallback={<p class="st-muted">No saved permissions.</p>}><ul class="st-rows"><For each={data().savedPermissions}>{(rule) => <li class="st-row"><span class="st-row-main"><span>{rule.action} · {rule.resource}</span></span><button type="button" class="rl-btn" disabled={actionBusy() || actionUncertain()} onClick={() => performSettings({ kind: "remove-saved-permission", revision: data().revision, id: rule.id }, `Remove the saved permission for ${rule.action} on ${rule.resource}?`)}>Remove</button></li>}</For></ul></Show></div> : undefined} closeAppContent={closeOpen() ? <div class="st-stack"><p class="st-muted">{connection().mode === "own" ? "Closing this window stops its private backend." : "Closing this window leaves the shared backend running."}</p><p class="st-muted">{connection().mode ?? "Unknown mode"} · {connection().status} · PID {connection().backendPID ?? "unknown"}</p><button type="button" class="rl-btn" onClick={() => { const section = document.querySelector<HTMLElement>('[aria-label="Machine & Backend"]'); section?.scrollIntoView({ block: "start" }); section?.querySelector<HTMLElement>("button")?.focus() }}>Open Machine & Backend</button></div> : undefined} />}</Show></div></Show>
  </SharedPageSurface>
}

function KeepAwakeRow(props: { checked: boolean; unsupported: boolean; disabled: boolean; detail: string; onToggle: (enabled: boolean) => void }) {
  return <div class="st-awake" data-part="st-keep-awake">
    <div class="st-awake__row"><span id="st-awake-label" class="st-awake__label">Keep machine awake</span><span class="st-awake__state" aria-hidden="true">{props.checked ? "On" : "Off"}</span><button type="button" role="switch" class="st-switch" aria-checked={props.checked} aria-labelledby="st-awake-label" aria-describedby="st-keep-awake-state" disabled={props.disabled || props.unsupported} onClick={() => props.onToggle(!props.checked)}><i /></button></div>
    <p class="st-muted" id="st-keep-awake-state" data-part="st-keep-awake-state">{props.unsupported ? "Keep awake is unsupported on this machine." : props.detail}</p>
    <p class="st-awake__note">On battery or with the lid closed, keeping the machine awake drains the battery and can heat the laptop.</p>
  </div>
}

function MachineBackendSection(props: { keepAwake?: JSX.Element }) {
  const [backendMode, setBackendMode] = createSignal<"own" | "shared">(savedSelection().mode)
  const [sharedServer, setSharedServer] = createSignal(savedSharedEndpoint())
  const [switchOpen, setSwitchOpen] = createSignal(false)
  createEffect(() => { setBackendMode(savedSelection().mode); setSharedServer(savedSharedEndpoint()) })
  const backendFormOpen = () => switchOpen() || connection().status === "error"
  const applyBackendSelection = () => {
    const server = sharedServer().trim()
    return connectBackend(backendMode() === "own" ? { mode: "own" } : server ? { mode: "shared", server } : { mode: "shared" })
  }
  const closeOwnership = () => (connection().mode ?? backendMode()) === "own" ? "Private backend stops when this window closes." : "Shared background server keeps running when this window closes."
  return <section class="st-section st-machine" aria-label="Machine & Backend">
    <header class="st-section-head"><h3><Icon name="monitor" />Machine</h3></header>
    <div class="st-machine__id"><Icon name="devices" /><strong>This Mac</strong><span class="st-machine__status" data-status={connection().status}>{connectionOwnership()}<Show when={connection().status === "connected"}><Icon name="check" /></Show></span></div>
    <p class="st-muted">{closeOwnership()}</p>
    <p class="st-machine__version">{connection().version ? `v${connection().version}` : "Not connected"}{connection().backendPID ? ` · PID ${connection().backendPID}` : ""}</p>
    <div class="st-actions"><button type="button" class="rl-btn st-pill" aria-expanded={backendFormOpen()} aria-controls="st-backend-form" onClick={() => setSwitchOpen(!switchOpen())}>Switch backend</button></div>
    <Show when={backendFormOpen()}><div class="st-backend-form" id="st-backend-form">
      <label class="rl-field"><span>Server mode</span><DesktopSelect label="Server mode" value={backendMode()} disabled={reconnectingBackend()} options={[{ value: "shared", label: "Shared background server" }, { value: "own", label: "Private backend" }]} onChange={(value) => setBackendMode(value === "own" ? "own" : "shared")} /></label>
      <Show when={backendMode() === "shared"}><label class="rl-field"><span>Shared endpoint</span><input type="url" value={sharedServer()} disabled={reconnectingBackend()} onInput={(event) => setSharedServer(event.currentTarget.value)} placeholder="http://127.0.0.1:port" /><small>Leave empty to automatically use or start the local ycoding server. Do not include credentials.</small></label></Show>
      <div class="st-actions"><button type="button" class="rl-btn st-pill" data-tone="go" disabled={reconnectingBackend()} onClick={() => void applyBackendSelection()}>{reconnectingBackend() ? "Connecting…" : "Apply & Reconnect"}</button></div>
    </div></Show>
    <Show when={backendActionError() ?? connection().error}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
    <Show when={connection().notice}>{(notice) => <p role="status">{notice()}</p>}</Show>
    {props.keepAwake}
  </section>
}

function UpdatesSection(props: { triggerTick: number }) {
  const [updateInfo, setUpdateInfo] = createSignal<UpdateCheckResult>()
  const [updateBusy, setUpdateBusy] = createSignal<"checking" | "installing">()
  const [updateError, setUpdateError] = createSignal<string>()
  const [installNote, setInstallNote] = createSignal<string>()
  const runCheckForUpdates = async () => {
    if (updateBusy()) return
    setUpdateBusy("checking"); setUpdateError(undefined); setInstallNote(undefined)
    try { setUpdateInfo(await api.checkForUpdates()) }
    catch (cause) { setUpdateError(failure(cause, "Updates could not be checked.")) }
    finally { setUpdateBusy(undefined) }
  }
  const runInstallUpdate = async (info: UpdateCheckResult) => {
    if (updateBusy()) return
    setUpdateBusy("installing"); setUpdateError(undefined); setInstallNote(undefined)
    try { const result = await api.installUpdate({ version: info.latestVersion }); setInstallNote(result.relaunching ? `Installed v${result.installedVersion}. Relaunching…` : `Installed v${result.installedVersion}. Restart to finish.`) }
    catch (cause) { setUpdateError(failure(cause, "The update could not be installed.")) }
    finally { setUpdateBusy(undefined) }
  }
  createEffect(on(() => props.triggerTick, (tick) => { if (tick > handledUpdateTick) { handledUpdateTick = tick; void runCheckForUpdates() } }))
  const status = () => { const info = updateInfo(); return !info ? "Not checked yet" : info.updateAvailable ? `Update available: v${info.latestVersion}` : "Up to date" }
  const notes = () => { const text = updateInfo()?.releaseNotes.trim() ?? ""; return text.length > 600 ? `${text.slice(0, 600)}…` : text }
  return <section class="st-section st-updates" aria-label="Updates">
    <header class="st-section-head"><h3><Icon name="refresh" />Updates</h3></header>
    <p class="st-updates__line"><span class="st-muted">Current version</span> <strong>{updateInfo()?.currentVersion ?? connection().version ?? "Bundled"}</strong> <span class="st-muted">·</span> <span>{status()}</span></p>
    <Show when={updateInfo()}>{(info) => <>
      <Show when={!info().canInstall && info().cannotInstallReason}>{(reason) => <p class="st-muted">{reason()}</p>}</Show>
      <Show when={notes()}>{(text) => <pre class="rl-output"><code>{text()}</code></pre>}</Show>
    </>}</Show>
    <div class="st-actions">
      <button type="button" class="rl-btn st-pill" disabled={!!updateBusy()} onClick={() => void runCheckForUpdates()}>Check for updates</button>
      <Show when={updateInfo()}>{(info) => <>
        <Show when={info().releaseUrl}><button type="button" class="rl-btn st-pill" onClick={() => void api.openExternalUrl({ url: info().releaseUrl }).catch((cause: unknown) => setUpdateError(failure(cause, "The release page could not be opened.")))}>Release notes</button></Show>
        <Show when={info().updateAvailable && info().canInstall}><button type="button" class="rl-btn st-pill" data-tone="go" disabled={!!updateBusy()} onClick={() => void runInstallUpdate(info())}>Update & Relaunch</button></Show>
      </>}</Show>
    </div>
    <Show when={updateBusy()}>{(busy) => <p role="status">{busy() === "checking" ? "Checking…" : "Installing update…"}</p>}</Show>
    <Show when={installNote()}>{(note) => <p role="status">{note()}</p>}</Show>
    <Show when={updateError()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
  </section>
}

const projectsRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/projects", component: () => <Destination name="Projects" /> })
const listRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/sessions", component: () => <Destination name="Sessions" /> })
const workspacesRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/workspaces", component: () => <Destination name="Workspaces" /> })
const usageRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/usage", component: () => <Destination name="Usage" /> })
const settingsRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/settings", component: () => <Destination name="Settings" /> })
const conversationRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/sessions/$sessionID", component: () => {
  const params = conversationRoute.useParams()
  return <Show when={params().sessionID} keyed>{(sessionID) => <Conversation sessionID={sessionID} />}</Show>
} })
if (typeof document !== "undefined") {
  const syncDocumentVisibility = () => { if (document.hidden) document.documentElement.dataset.hidden = "true"; else delete document.documentElement.dataset.hidden }
  syncDocumentVisibility()
  document.addEventListener("visibilitychange", syncDocumentVisibility)
  const router = createRouter({ routeTree: root.addChildren([workspaceRoute.addChildren([indexRoute, newChatRoute, projectsRoute, listRoute, workspacesRoute, usageRoute, settingsRoute, conversationRoute])]), history: createHashHistory() })
  const element = document.getElementById("app")
  if (!element) throw new Error("Missing desktop application root")
  render(() => <RouterProvider router={router} />, element)
}
