import { createRootRoute, createRoute, createRouter, createHashHistory, Link, Outlet, RouterProvider, useLocation, useNavigate } from "@tanstack/solid-router"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { customEndpointChoice, providerChoices, type YCodingEvent } from "@ycoding-ai/client"
import { dotsPeerLabel } from "@ycoding-ai/client/dots-peer"
import { browserScriptPermission } from "@ycoding-ai/client/tool-display"
import { batch, createContext, createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, useContext, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { ComposerToolbar, revealComposerControls } from "../../../apps/web/src/remote/ui/composer-toolbar"
import type { ConnectionState, FormAnswer, FormRequest, Messages, PendingRequests, PermissionRequest, ComposerCatalog, PromptAgent, PromptFile, RequestReply, SessionItem, ModelSelection, ShellOutput, UsageRange, RevertInput, SetAutonomyInput, SettingsMutationInput, ProjectMutationInput, WorkspaceMutationInput, PinRequest } from "./contract"
import { desktop as api } from "./bridge"
import { createEventRefresh, eventSessionID } from "./event-refresh"
import { createPromptVisibility } from "./prompt-visibility"
import { createClientTelemetry } from "./client-telemetry"
import { createDesktopAttention, createDesktopAudio } from "./attention"
import { ActiveQuestionCard } from "./active-questions"
import { DesktopDiffView } from "./diff-view"
import { IntelligentUiTurnCards } from "./intelligent-ui"
import { Keyed } from "./keyed"
import { KEYBOARD_ACTIONS, desktopShortcut, keyboardBindings, parseKeyboardOverrides, shortcutLabel, type KeyboardOverrides } from "./keyboard"
import { KeyboardSettings } from "./keyboard-settings"
import { COMPANION_DOCKED_QUERY, DEFAULT_PRESENTATION, PRESENTATION_STORAGE_KEY, parsePresentationSettings, startupCompanionOpen, toolDisclosures, withCompanion, withThinking, withToolGrouping, type PresentationSettings } from "./presentation-settings"
import { acceptsHistoryEvent, reconcileSessionHistory } from "./session-history"
import { DesktopProjectMembers, DesktopProjectRoster, newDirectoryProjectConfirmation } from "./project-members"
import { DesktopProjectsSurface } from "./projects-surface"
import { DesktopStateIndicator } from "./state-indicator"
import { TerminalInspector } from "./terminal-inspector"
import { createEditorContext, EditorContextControl, type EditorAdmission } from "./editor-context"
import { PASTE_STORAGE_KEY, expandPastedPrompt, expandPastedText, livePasted, parsePasteMode, placePaste, type PasteMode } from "./paste"
import { composerByteLimit, composerFileLimit, hasTransferFiles, inlineFileSize, transferredFiles } from "./composer-files"
import type { DesktopAPI, DesktopSource, IntegrationMutationInput, IntegrationAttempt, McpMutationInput, SessionManageInput, SystemManageInput, DisplayValue, Selection, UpdateCheckResult, SessionSnapshot, MemoryScope } from "./contract"
import { schemeStylesheet } from "../../../apps/web/src/theme/schemes"
import { Icon as WebIcon, type IconName as WebIconName } from "../../../apps/web/src/ui/icon"
import { PendingPreview } from "../../../apps/web/src/remote/ui/pending-preview"
import { MessageDelete } from "../../../apps/web/src/remote/ui/message-delete"
import { ordinarySession } from "./sessions"
import { Markdown, MarkdownClipboard } from "../../../apps/web/src/remote/ui/markdown"
import { LifecycleEntryView, RecallEntryView } from "../../../apps/web/src/remote/ui/recall-entry"
import { recordPlacements, transcriptRecords, type TranscriptRecord } from "./recall"
import { foldRecallEvents } from "@ycoding-ai/client/cue-recall"
import { foldLifecycleEvents } from "@ycoding-ai/client/lifecycle"
import { createInteractionControl, interactionControlVisible, interactionEventGeneration, readInteractionStatus, type InteractionView } from "../../../apps/web/src/remote/interaction-control"
import { InteractionControl, InteractionPreview } from "../../../apps/web/src/remote/ui/interaction-control"
import { McpApp } from "../../../apps/web/src/remote/ui/mcp-app"
import { McpAppResult, type OpenMcpApp } from "../../../apps/web/src/remote/ui/mcp-app-result"
import { SwarmBoard, swarmBoardView } from "../../../apps/web/src/remote/ui/swarm-board"
import { boardUpdateGroup } from "../../../apps/web/src/remote/coordination"
import { railGroupPartitions } from "./form-rules"
import { chromeInteractionURL } from "./interaction-request"
import { WORKSPACE_DESTINATIONS, SharedActivityBar, SharedTrace, SharedListColumn, SharedSessionGroups, clampListWidth, type SharedActivityItem, type SharedSessionGroup, SharedCompanionSurface, SharedCompanionTabs, SharedConversationHeader, SharedMessageTurn, SharedContextRingButton, SharedContextBreakdownPanel, SharedTurnHead, SharedRadioGroup, SharedCompactionDivider, SharedEditedFilesCard, SharedActivitySurface, SharedPageSurface, SharedSessionsSurface, SharedWorkspacesSurface, SharedUsageSurface, SharedSettingsSurface, SharedLoadingSkeleton } from "../../../apps/web/src/remote/ui/shared-workspace"
import { DESKTOP_THEMES, isDesktopThemeID, resolveDesktopTheme, DESKTOP_BUILT_IN_SLASH_COMMANDS, desktopSlashCommand, userDeliveryStates, userPendingInputs, assistantReplyText, validateFolderSegment, parsePromptStashes, pushPromptStash, formatQuotaProviders, formatCount, formatCompactCount, formatDurationMs, formatUsd, type DesktopThemeID, activeFields, appendPage, buildAnswer, chooseModel, chooseProfile, choiceFor, choiceProblem, composerTrigger, initialValues, insertCompletion, invalidIndexes, restoredPrompt, modelLabel, pagedItems, pagingFor, problemOf, profileLabel, railGroups, restoresFocus, sameSelection, samePaging, searchTerm, selectionFor, composerSlash, valueFor, variantsFor, visibleModels, withValue, workspaceBase, classifyDesktopSynthetic, dotSteerDisplay, visibleDesktopMessages, turnEditPlacements, groupAssistantParts, toolDisplaySummary, effortStopsFor, effortStopIndex, effortStopFraction, insertTextAtSelection, isEditableKeyboardTarget, isStandardEditShortcut, sessionState, type PastedText, type StashedPrompt, type Activity, type Field, type FocusAt, type MentionPick, type ModelChoice, type SlashAction, type Paging, type Value, railGroupLabels, railGroupOrder } from "./form-rules"
import { JumpControls, PromptRail, followState, jumpBehavior, navigationTargets, pillClearance, promptTicks, type PromptTick } from "../../../apps/web/src/remote/ui/transcript-rail"
import { orderedModelOptions } from "../../../apps/web/src/remote/ui/composer-logic"
import { readRecentModels, rememberRecentModel } from "../../../apps/web/src/remote/preferences"
import openaiMark from "../../../apps/web/src/assets/providers/openai.svg"
import { guardrailClosedNotice, guardrailWaiting } from "../../../apps/web/src/remote/guardrail-wait"
import "../../../apps/web/src/styles/tokens.css"
import "../../../apps/web/src/styles/workspace-shell.css"
import "./tokens.css"
import "./style.css"
import "./intelligent-ui.css"
import "./compact.css"
import { containDialogFocus, ResponsiveLayer, swipeDismiss, watchDesktopViewport } from "./responsive-layer"

function DesktopCompanion(props: Pick<Parameters<typeof SharedCompanionSurface>[0], "active" | "onSelect" | "headerActions" | "policyActions" | "onRefresh" | "activityContent" | "runningContent" | "changesContent" | "contextContent" | "contextActions">): JSX.Element {
  return <section class="companion" aria-label="Session companion">
    <header class="companion__header desktop-companion-head"><SharedCompanionTabs class="companion__tabs" active={props.active} running={props.runningContent !== undefined} onSelect={props.onSelect} /><div class="desktop-companion-actions">{props.headerActions}</div></header>
    <div id="companion-activity" class="motion-enter" role="tabpanel" hidden={props.active !== "activity"}><div class="companion__activity-heading"><h2>Activity</h2><Show when={props.onRefresh}><button type="button" class="rl-btn" onClick={props.onRefresh}><Icon name="refresh" /> Refresh</button></Show></div>{props.activityContent}</div>
    <Show when={props.runningContent !== undefined}><div id="companion-running" class="motion-enter" role="tabpanel" aria-label="Running" hidden={props.active !== "running"}>{props.runningContent}</div></Show>
    <div id="companion-changes" class="motion-enter" role="tabpanel" hidden={props.active !== "changes"}>{props.changesContent}</div>
    <div id="companion-context" class="motion-enter" role="tabpanel" hidden={props.active !== "context"}>{props.contextContent}{props.contextActions}</div>
    <Show when={props.policyActions}><footer class="desktop-companion-policy">{props.policyActions}</footer></Show>
  </section>
}

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
const [executionStates, setExecutionStates] = createSignal<ReadonlyMap<string, "idle" | "failed">>(new Map())
const [paletteOpen, setPaletteOpen] = createSignal(false)
type ThemePreference = DesktopThemeID
const [themePreference, setThemePreference] = createSignal<ThemePreference>("system")
const [desktopNotice, setDesktopNotice] = createSignal<string>()
const [attentionEnabled, setAttentionEnabled] = createSignal(false)
const [attentionNotifications, setAttentionNotifications] = createSignal(true)
const [attentionSound, setAttentionSound] = createSignal(true)
const [attentionVolume, setAttentionVolume] = createSignal(0.5)
const [keyboardOverrides, setKeyboardOverrides] = createSignal<KeyboardOverrides>({})
const saveKeyboardOverrides = (value: KeyboardOverrides) => {
  setKeyboardOverrides(value)
  try { localStorage.setItem("ycoding.desktop.keybindings", JSON.stringify(value)) } catch { setDesktopNotice("Shortcuts apply to this window but could not be saved.") }
}
const [presentation, setPresentation] = createSignal(DEFAULT_PRESENTATION)
const savePresentation = (value: PresentationSettings) => {
  setPresentation(value)
  try { localStorage.setItem(PRESENTATION_STORAGE_KEY, JSON.stringify(value)) } catch { setDesktopNotice("The display preference applies to this window but could not be saved.") }
}
const keyboardHint = (action: string) => keyboardBindings(keyboardOverrides()).filter((entry) => entry.action === action).map((entry) => shortcutLabel(entry.binding, mac)).join(", ") || undefined
const keyboardAria = (action: string) => keyboardBindings(keyboardOverrides()).filter((entry) => entry.action === action).map(({ binding }) => `${binding.modifier === "control" || !mac ? "Control" : "Meta"}+${binding.modifier === "primary-shift" ? "Shift+" : ""}${binding.key}`).join(" ") || undefined
function CommandMenuButton() {
  return <button type="button" class="rl-icon desktop__palette" aria-label={keyboardHint("palette") ? `Commands ${keyboardHint("palette")}` : "Commands"} aria-keyshortcuts={keyboardAria("palette")} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setPaletteOpen(true) }}><Icon name="more" /></button>
}
const setAttentionPreference = (name: "attention" | "notifications" | "notification-sound", enabled: boolean) => {
  if (name === "attention") setAttentionEnabled(enabled); else if (name === "notifications") setAttentionNotifications(enabled); else setAttentionSound(enabled)
  try { localStorage.setItem(`ycoding.desktop.${name}`, String(enabled)) } catch { setDesktopNotice("The attention preference could not be saved. It applies only to this window.") }
}
const changeAttentionVolume = (value: number) => {
  if (!Number.isFinite(value) || value < 0 || value > 100) return
  setAttentionVolume(value / 100)
  try { localStorage.setItem("ycoding.desktop.notification-volume", String(value / 100)) } catch { setDesktopNotice("The sound volume could not be saved. It applies only to this window.") }
}

function AttentionSettings() {
  return <div class="st-stack">
    <label class="desktop-attention-row"><span>Enable attention</span><input type="checkbox" role="switch" checked={attentionEnabled()} onChange={(event) => setAttentionPreference("attention", event.currentTarget.checked)} /></label>
    <label class="desktop-attention-row"><span>Native attention notifications</span><input type="checkbox" role="switch" checked={attentionNotifications()} disabled={!attentionEnabled()} onChange={(event) => setAttentionPreference("notifications", event.currentTarget.checked)} /></label>
    <label class="desktop-attention-row"><span>Attention sound</span><input type="checkbox" role="switch" checked={attentionSound()} disabled={!attentionEnabled()} onChange={(event) => setAttentionPreference("notification-sound", event.currentTarget.checked)} /></label>
    <div class="desktop-attention-volume"><label><span>Sound volume (%)</span><input type="range" aria-label="Sound volume (%)" min="0" max="100" step="5" value={Math.round(attentionVolume() * 100)} disabled={!attentionEnabled() || !attentionSound()} onInput={(event) => changeAttentionVolume(event.currentTarget.valueAsNumber)} onChange={(event) => changeAttentionVolume(event.currentTarget.valueAsNumber)} /></label><output aria-label="Sound volume">{Math.round(attentionVolume() * 100)}%</output></div>
    <p class="st-muted">Requests, completion and failures use the bundled attention sounds. Native notifications appear only while this window is unfocused and contain no Session text. macOS controls notification access; the browser may require a click in this window before it plays sound.</p>
    <For each={[...activity().waiting.entries()]} fallback={<p class="st-muted">No pending attention is reported.</p>}>{([id, requests]) => <p class="st-muted">{id} · {requests.size} pending requests</p>}</For>
  </div>
}
function PresentationControls() {
  return <div class="st-stack">
    <div class="desktop-presentation-row"><div><h4>Reasoning</h4><p class="st-muted">Show model reasoning expanded or collapsed.</p></div><SharedRadioGroup label="Reasoning" value={presentation().thinking} options={[{ value: "show", label: "Expanded" }, { value: "hide", label: "Collapsed" }]} onChange={(value) => setThinkingExpanded(value === "show")} /></div>
    <div class="desktop-presentation-row"><div><h4>Tool calls</h4><p class="st-muted">Group consecutive tool calls or show each call separately.</p></div><SharedRadioGroup label="Tool calls" value={presentation().grouping} options={[{ value: "auto", label: "Group consecutive calls" }, { value: "none", label: "Show each call separately" }]} onChange={(value) => savePresentation(withToolGrouping(presentation(), value === "none" ? "none" : "auto"))} /></div>
    <div class="desktop-presentation-row"><div><h4>Session companion at launch</h4><p class="st-muted">Opening or closing the companion also updates the launch choice.</p></div><SharedRadioGroup label="Session companion at launch" value={presentation().companion} options={[{ value: "auto", label: "Open when the window is wide enough to dock it" }, { value: "hide", label: "Closed" }]} onChange={(value) => savePresentation({ ...presentation(), companion: value === "auto" ? "auto" : "hide" })} /></div>
    <div class="desktop-presentation-row"><div><h4>Large pastes</h4><p class="st-muted">Pastes of three or more lines, or over 150 characters, show as a placeholder in the composer. The full text is sent, stashed and copied.</p></div><SharedRadioGroup label="Large pastes" value={pasteMode()} options={[{ value: "compact", label: "Compact placeholder" }, { value: "full", label: "Full text" }]} onChange={(value) => savePasteMode(value === "full" ? "full" : "compact")} /></div>
  </div>
}
const TelemetryContext = createContext<ReturnType<typeof createClientTelemetry>>()
const useDesktopTelemetry = () => { const value = useContext(TelemetryContext); if (!value) throw new Error("Desktop telemetry context is missing."); return value }
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
const applyAnimationsPreference = (enabled: boolean) => { setAnimationsEnabled(enabled); if (typeof document !== "undefined") document.documentElement.dataset.animations = enabled ? "on" : "off"; try { localStorage.setItem("ycoding.desktop.animations", String(enabled)) } catch { setDesktopNotice("Motion changed for this window; the preference could not be saved.") } }
const [railQuery, setRailQuery] = createSignal("")
const [newDirectory, setNewDirectory] = createSignal("")
const [newText, setNewText] = createSignal("")
const [newPasted, setNewPasted] = createSignal<readonly PastedText[]>([])
const [pasteMode, setPasteMode] = createSignal<PasteMode>("compact")
const savePasteMode = (mode: PasteMode) => {
  setPasteMode(mode)
  try { localStorage.setItem(PASTE_STORAGE_KEY, mode) } catch { setDesktopNotice("The paste preference applies to this window but could not be saved.") }
}
const [openedDirectories, setOpenedDirectories] = createSignal<ReadonlySet<string>>(new Set())
const thinkingExpanded = () => presentation().thinking === "show"
const setThinkingExpanded = (expanded: boolean) => savePresentation(withThinking(presentation(), expanded))
const [newPending, setNewPending] = createSignal<{ directory: string; sessionID: string; promptID: string; text: string; agent?: string; files?: PromptFile[]; agents?: PromptAgent[]; editor?: EditorAdmission; command?: { name: string; arguments?: string }; created: boolean; model?: ModelSelection; modelRevision?: number; switchAttempted?: boolean; switched?: boolean; autonomy?: "manual" | "auto" | "yolo"; autonomyRevision?: number; autonomyAttempted?: boolean; autonomyApplied?: boolean }>()
const [newUnconfirmed, setNewUnconfirmed] = createSignal(false)
const unconfirmed = new Set<string>()
const drafts = new Map<string, string>()
const pastedDrafts = new Map<string, readonly PastedText[]>()
type PendingDraft = { owner: string; revision: number; promptID: string; text: string; files?: PromptFile[]; agents?: PromptAgent[]; editor?: EditorAdmission; delivery?: "queue" | "steer"; steerNow?: true; model?: ModelSelection }
const pendings = new Map<string, PendingDraft>()
const scope = () => [connection().generation, connection().revision ?? 0] as const
const reading = () => connection().status === "connected"
const failure = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback
const sessionsQuery = (search = "") => ({ queryKey: ["sessions", ...scope(), search] as const, queryFn: () => api.sessions(search ? { search } : {}), enabled: reading() })
const refresh = (queryKey: readonly unknown[]) => void queries.invalidateQueries({ queryKey }, { cancelRefetch: false })
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const costLabel = (cost: number | undefined) => cost === undefined ? "Cost unknown" : formatUsd(cost)
const LIST_COLLAPSED_KEY = "ycoding.desktop.list-collapsed"
const [railCollapsed, showRail] = createSignal((() => { try { return localStorage.getItem(LIST_COLLAPSED_KEY) === "true" } catch { return false } })())
const setRailCollapsed = (collapsed: boolean) => {
  showRail(collapsed)
  try { localStorage.setItem(LIST_COLLAPSED_KEY, String(collapsed)) } catch { setDesktopNotice("The Session list state applies to this window but could not be saved.") }
}
const [teamOpen, setTeamOpen] = createSignal(false)
let teamRequested = false
type SessionGauge = { readonly sessionID: string; readonly children: number }
const [sessionGauge, setSessionGauge] = createSignal<SessionGauge>()
const [lastSession, setLastSession] = createSignal<string>()
const LIST_WIDTH_KEY = "ycoding.desktop.list-width"
const [listWidth, setListWidth] = createSignal<number>()
const [companionOpen, showCompanion] = createSignal(false)
const setCompanionOpen = (open: boolean) => { showCompanion(open); savePresentation(withCompanion(presentation(), open)) }
const [companionTab, setCompanionTab] = createSignal<"Activity" | "Running" | "Changes" | "Context">("Context")
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
  await api.writeClipboard({ text })
}
const autonomyChoices = ["", "manual", "auto", "yolo"] as const
const decisionModes = [{ value: "manual", label: "Manual" }, { value: "auto", label: "Auto" }, { value: "yolo", label: "YOLO" }] as const
const stagedAutonomyLabels = { "": "Server default", manual: "Manual", auto: "Auto", yolo: "YOLO" } as const
function Icon(props: { name: DesktopIconName }) { if (props.name === "arc" || props.name === "more" || props.name === "clip") return <svg class="rl-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><For each={[...extraIconPaths[props.name]]}>{(d) => <path d={d} />}</For></svg>; return <WebIcon name={props.name as WebIconName} class="rl-ico" /> }
function Brand(props: { wordmark?: boolean }) { return <span class="rl-brand" data-wordmark={props.wordmark ? "true" : undefined}><svg class="rl-brand-mark" viewBox="0 0 256 256" fill="none" role="img" aria-label="YCoding"><rect width="256" height="256" rx="48" fill="var(--yc-brand-tile)" /><rect x="1" y="1" width="254" height="254" rx="47" stroke="var(--yc-brand-rule)" stroke-width="2" /><g transform="translate(128 128) scale(0.9) translate(-128 -128)"><path d="M40 40h40l48 64-24 32z" fill="var(--yc-brand-trace)" /><path d="M176 40h40l-64 96-24-32z" fill="var(--yc-brand-frost)" /><path d="M104 112h48v104h-48z" fill="var(--yc-brand-frost)" /><rect x="116" y="104" width="24" height="24" transform="rotate(45 128 116)" fill="var(--yc-brand-attention)" /></g></svg><Show when={props.wordmark}><span class="rl-wordmark" aria-hidden="true">YCoding</span></Show></span> }
const asked = new Set(["permission.asked", "question.asked", "guardrail.asked", "form.created"])
const settled = new Set(["permission.replied", "permission.cancelled", "question.replied", "question.rejected", "question.timed_out", "guardrail.replied", "guardrail.cancelled", "session.guardrail.decided", "form.replied", "form.cancelled", "form.timed_out"])
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

export function visibleDesktopQuotas<T extends { readonly status: string }>(quotas: readonly T[]): readonly T[] {
  return quotas.filter(quota => quota.status !== "unsupported")
}

export function desktopTransientActivity(input: { readonly active: boolean; readonly sending: boolean; readonly messages: readonly Messages[number][]; readonly shells: readonly { readonly status: string; readonly command: string }[] }): string | undefined {
  if (input.sending) return "Sending"
  if (!input.active) return undefined
  const last = input.messages.findLast(message => message.type === "assistant")
  if (last?.type === "assistant" && last.time.completed === undefined) {
    const part = last.content.at(-1)
    if (part?.type === "tool" && (part.state.status === "running" || part.state.status === "streaming")) return `Tool · ${part.name}`
    if (part?.type === "reasoning") return "Thinking"
    if (part?.type === "text" && part.text.trim()) return "Writing"
  }
  const shell = input.shells.find(shell => shell.status === "running")
  return shell ? `Shell · ${shell.command}` : "Working"
}

function NativeActivityRow(props: { readonly label: string; readonly children: JSX.Element; readonly identity?: string; readonly time?: number; readonly active?: boolean }) {
  const [identityOpen, setIdentityOpen] = createSignal(false)
  const identityID = createUniqueId()
  const badge = () => <span class="desktop-native-badge"><Icon name={props.active ? "arc" : "devices"} />{props.label}</span>
  return <div class="desktop-native-activity-row" data-channel={props.label} data-active={props.active || undefined} data-dots-message={props.identity ? true : undefined}>
    <Show when={props.identity} fallback={badge()}>{identity => <button type="button" class="desktop-peer-attribution" aria-label={`External peer details: ${identity()}`} aria-expanded={identityOpen()} aria-controls={identityID} onClick={() => setIdentityOpen(!identityOpen())} onKeyDown={event => { if (event.key === "Escape") setIdentityOpen(false) }}>{badge()}<Icon name="chevron-down" /></button>}</Show>
    <div class="desktop-native-activity-content">{props.children}</div>
    <Show when={props.time !== undefined}><time dateTime={new Date(props.time!).toISOString()}>{new Date(props.time!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></Show>
    <Show when={props.identity}>{identity => <p id={identityID} class="desktop-native-peer-identity" hidden={!identityOpen()}>{identity()}</p>}</Show>
  </div>
}

function GuardrailHistory(props: { readonly value?: DisplayValue; readonly rootSessionID?: string }) {
  const rows = () => Array.isArray(props.value) ? props.value : []
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  return <section class="desktop-guardrail-history" aria-label="Guardrail decisions"><header><h3>Guardrail decisions</h3><small>{props.value === undefined ? "History not reported" : `${formatCount(rows().length)} recorded events`}</small></header><Show when={props.rootSessionID}><p class="st-muted">Family root: {props.rootSessionID}</p></Show><Show when={props.value !== undefined} fallback={<p role="status">Decision history is not reported.</p>}><For each={rows()} fallback={<p>No recorded guardrail decisions.</p>}>{row => {
    const reply = () => word(field(row, "reply"))
    const created = () => field(row, "created")
    const rules = () => strings(field(row, "ruleIDs"))
    const resources = () => strings(field(row, "resources"))
    const confidence = () => field(row, "confidence")
    const grades = () => { const value = field(row, "grades"); return Array.isArray(value) ? value : [] }
    return <article data-decision={reply()}><header><time>{typeof created() === "number" && Number.isFinite(created()) ? new Date(created() as number).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Time unrecorded"}</time><strong>{field(row, "reason") === "expired" ? "Expired · did not run" : field(row, "reason") === "cancelled" ? "Cancelled · did not run" : reply() === "once" ? "Allowed once" : reply() === "always" ? "Always allowed" : reply() === "reject" ? "Rejected" : "Decision unrecorded"}</strong></header><p>{word(field(row, "action")) || "Action unrecorded"}</p><dl><dt>Rule</dt><dd>{rules().join(", ") || "Rule unrecorded"}</dd><dt>Scope</dt><dd>{word(field(row, "scope")) || "Scope unrecorded"}</dd><dt>Resources</dt><dd>{resources().join(", ") || "Resources unrecorded"}</dd></dl><details><summary>Decision details</summary><dl><dt>Session</dt><dd>{word(field(row, "sessionID")) || "Unrecorded"}</dd><dt>Request</dt><dd>{word(field(row, "requestID")) || "Unrecorded"}</dd><dt>Authority</dt><dd>{word(field(row, "authority")) || "Unrecorded"}</dd><dt>Confidence</dt><dd>{typeof confidence() === "number" && Number.isFinite(confidence()) ? `${formatCount(Math.round((confidence() as number) * 100))}%` : "Unrecorded"}</dd><dt>Source message</dt><dd>{word(field(field(row, "source"), "messageID")) || "Unrecorded"}</dd><dt>Tool call</dt><dd>{word(field(field(row, "source"), "callID")) || "Unrecorded"}</dd></dl><For each={grades()}>{grade => <p>{word(field(grade, "choice"))} · {word(field(grade, "evidence"))}</p>}</For></details></article>
  }}</For></Show></section>
}

function ChannelActivity(props: { readonly sessionID: string; readonly enabled: boolean }) {
  const snapshot = observe(() => ({ queryKey: ["system", ...scope(), { sessionID: props.sessionID }] as const, queryFn: () => api.systemSnapshot({ sessionID: props.sessionID }), enabled: reading() && props.enabled }))
  const data = () => snapshot.result().isError ? undefined : currentSnapshot(snapshot.result().data, connection().revision)
  return <section class="desktop-channel-activity" aria-label="Channel bridges"><header><h3>Bridge activity</h3><button type="button" class="rl-btn" disabled={snapshot.result().isFetching || !reading()} onClick={snapshot.refetch}>Refresh bridges</button></header><Show when={snapshot.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading bridge status…" /></Show><Show when={snapshot.result().isError}><p role="alert">{failure(snapshot.result().error, "Bridge status could not be read.")}</p></Show><Show when={data()}>{value => <><dl><dt>Dots connection</dt><dd data-state={word(field(field(value().dots, "connection"), "state"))}>{word(field(field(value().dots, "connection"), "state")) ?? "Not reported"}</dd><dt>Computer attachment</dt><dd data-state={word(field(field(value().dots, "computer"), "state"))}>{word(field(field(value().dots, "computer"), "state")) ?? "Not reported"}</dd><dt>Remote Session relay</dt><dd data-state={word(field(value().remote, "state"))}>{word(field(value().remote, "state")) ?? "Not reported"}</dd></dl><For each={[value().notices.Dots, value().notices.Remote, word(field(field(value().dots, "connection"), "message")), word(field(value().remote, "message"))].filter((notice): notice is string => !!notice)}>{notice => <p role="status">{notice}</p>}</For><h3>Execution runtime</h3><p>{connectionOwnership()}{connection().backendPID ? ` · PID ${formatCount(connection().backendPID!)}` : ""}</p></>}</Show></section>
}

type DirectTask = import("./contract").SessionActivity["subagents"][number]

function StateBadge(props: { state: string; label?: string }) {
  return <span class="desktop-state-badge" data-state={props.state}><span aria-hidden="true"><DesktopStateIndicator state={props.state} /></span>{props.label ?? props.state.charAt(0).toUpperCase() + props.state.slice(1)}</span>
}

function TeamView(props: { readonly viewRef: (view: HTMLDivElement) => void; readonly sessionID: string; readonly data?: import("./contract").SessionActivity; readonly loading: boolean; readonly error?: string; readonly busy: boolean; readonly onAnswer: (task: DirectTask, text: string) => Promise<boolean>; readonly onOpen: (id: string) => void; readonly onRefresh: () => void; readonly onMore: () => void; readonly moreBusy: boolean; readonly moreError?: string }) {
  const [selectedID, setSelectedID] = createSignal<string>()
  const [answer, setAnswer] = createSignal("")
  const [view, setView] = createSignal<"Table" | "Grid">("Table")
  const tasks = () => props.data?.subagents.filter(task => task.parentID === props.sessionID) ?? []
  const selected = () => tasks().find(task => task.sessionID === selectedID()) ?? tasks()[0]
  const ids = () => tasks().map(task => task.sessionID).toSorted()
  const costs = observe(() => ({ queryKey: ["sessionInsights", ...scope(), props.sessionID, ids()] as const, queryFn: () => api.sessionInsights({ sessionID: props.sessionID, taskSessionIDs: ids() }), enabled: reading() && ids().length > 0 }))
  const costData = () => costs.result().isError ? undefined : currentSnapshot(costs.result().data, connection().revision, props.sessionID)
  const tokensFor = (id: string) => {
    const values = field(costData()?.taskCosts, "tasks")
    const row = Array.isArray(values) ? values.find(item => field(item, "sessionID") === id) : undefined
    const tokens = field(field(row, "total"), "tokens")
    const valuesFor = [field(tokens, "input"), field(tokens, "output"), field(tokens, "reasoning"), field(field(tokens, "cache"), "read"), field(field(tokens, "cache"), "write")]
    return valuesFor.every((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0) ? `${formatCompactCount(valuesFor.reduce((total, value) => total + value, 0))} tokens` : "Tokens unreported"
  }
  const [now, setNow] = createSignal(Date.now())
  onMount(() => { const timer = setInterval(() => setNow(Date.now()), 1000); onCleanup(() => clearInterval(timer)) })
  createEffect(() => { void selected()?.sessionID; void selected()?.question?.id; setAnswer("") })
  const inspect = (id: string, focusAnswer = false) => {
    setSelectedID(id)
    if (focusAnswer) queueMicrotask(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Selected child"] textarea')?.focus())
  }
  const elapsed = (task: DirectTask) => formatDurationMs(Math.max(0, (["completed", "failed", "cancelled", "lost"].includes(task.state) ? task.time.updated : now()) - task.time.created))
  const modelDetails = (task: DirectTask) => [task.model.variant, task.model.profile].filter(Boolean).join(" · ") || "Default effort / profile"
  const blockers = () => tasks().filter(task => task.state === "waiting" || task.state === "failed" || task.state === "lost")
  return <div class="desktop-team" data-team-view ref={props.viewRef}>
    <div class="desktop-team-main">
      <header class="desktop-surface-heading"><div><h2>Master-Session Team View</h2><p>{formatCount(tasks().length)} loaded{props.data ? ` of ${formatCount(props.data.total)} reported direct subagents · ${formatCount(props.data.activeTotal)} active` : " · Direct subagent total unreported · Active count unreported"}</p></div><div class="desktop-team-tools">
        <div class="desktop-team-mode" role="group" aria-label="Team view mode"><For each={["Table", "Grid"] as const}>{mode => <button type="button" class="rl-btn" aria-pressed={view() === mode} onClick={() => setView(mode)}>{mode}</button>}</For></div>
        <button type="button" class="rl-btn" onClick={props.onRefresh}>Refresh Team</button>
      </div></header>
      <Show when={props.loading}><SharedLoadingSkeleton kind="list" label="Reading direct subagents…" /></Show><Show when={props.error}><p role="alert">{props.error}</p></Show>
      <Show when={props.data}>
        <details aria-label="Blockers & escalations" class="desktop-blockers"><summary>Blockers &amp; Escalations <span>{formatCount(blockers().length)}</span></summary><For each={blockers()} fallback={<p>No waiting or failed direct subagents in the loaded results.</p>}>{task => <article data-state={task.state}><div><strong>{task.agent}</strong> <StateBadge state={task.state} /><p>{task.question?.text ?? task.progress?.text ?? task.description}</p></div><div class="desktop__actions"><Show when={task.state === "waiting" && task.question}><button type="button" class="rl-btn" onClick={() => inspect(task.sessionID, true)}>Answer</button></Show><button type="button" class="rl-btn" onClick={() => props.onOpen(task.sessionID)}>Open session</button></div></article>}</For></details>
        <Show when={view() === "Table"} fallback={<ul class="desktop-team-grid" aria-label="Direct subagents"><For each={tasks()}>{task => <li class="desktop-team-card" data-selected={selected()?.sessionID === task.sessionID || undefined} onClick={event => { if (event.target instanceof Element && !event.target.closest("button")) inspect(task.sessionID) }}>
          <button type="button" class="desktop-team-card__select" aria-label={`Inspect ${task.agent}: ${task.description}`} aria-pressed={selected()?.sessionID === task.sessionID} onClick={() => inspect(task.sessionID)}><strong>{task.agent}</strong><StateBadge state={task.state} /><span>{task.description}</span><small>{task.model.providerID}/{task.model.id} · {modelDetails(task)}</small><small>{elapsed(task)} · {tokensFor(task.sessionID)}</small></button>
          <button type="button" class="rl-btn" onClick={() => props.onOpen(task.sessionID)}>Open</button>
        </li>}</For></ul>}>
          <div class="desktop-table-scroll"><table class="desktop-coordination-table" aria-label="Direct subagents"><thead><tr><th>State &amp; Agent</th><th>Assignment</th><th>Model / Effort</th><th>Elapsed / Tokens</th><th>Action</th></tr></thead><tbody><For each={tasks()}>{task => <tr aria-selected={selected()?.sessionID === task.sessionID} onClick={event => { if (event.target instanceof Element && !event.target.closest("button")) inspect(task.sessionID) }}>
            <td><button type="button" class="desktop-row-select" aria-label={`Inspect ${task.agent}: ${task.description}`} aria-pressed={selected()?.sessionID === task.sessionID} onClick={() => inspect(task.sessionID)}><strong>{task.agent}</strong><StateBadge state={task.state} /></button></td>
            <td>{task.description}</td><td><span>{task.model.providerID}/{task.model.id}</span><small>{modelDetails(task)}</small></td><td><span>{elapsed(task)}</span><small>{tokensFor(task.sessionID)}</small></td><td><button type="button" class="rl-btn" onClick={() => props.onOpen(task.sessionID)}>Open</button></td>
          </tr>}</For></tbody></table></div>
        </Show>
        <Show when={!tasks().length}><p>No direct subagents reported.</p></Show><Show when={props.data?.subagentNext}><button type="button" class="rl-btn" disabled={props.moreBusy} onClick={props.onMore}>{props.moreBusy ? "Reading…" : "Load more subagents"}</button></Show><Show when={props.moreError}><p role="alert">{props.moreError}</p></Show><Show when={costs.result().isError}><p role="status">Child token costs could not be read. <button type="button" class="rl-btn" onClick={costs.refetch}>Refresh costs</button></p></Show><For each={Object.values(costData()?.notices ?? {})}>{notice => <p role="status">{notice}</p>}</For>
      </Show>
    </div>
    <aside class="desktop-selected-inspector" aria-label="Selected child">
      <Show when={selected()} fallback={<p>Select a reported direct child to inspect it.</p>}>{task => <>
        <section class="desktop-inspector-card"><small>Master {props.sessionID} › Child {task().sessionID}</small><h2>{task().agent}</h2><StateBadge state={task().state} /></section>
        <section class="desktop-inspector-card"><h3>Assignment Scope</h3><p>{task().description}</p></section>
        <section class="desktop-inspector-card"><h3>Model / Effort</h3><p>{task().model.providerID}/{task().model.id}</p><p>{modelDetails(task())}</p><p>{elapsed(task())} · {tokensFor(task().sessionID)}</p></section>
        <section class="desktop-inspector-card"><h3>Last Progress Line</h3><p class="desktop-child-progress">{task().progress?.text ?? "Progress not reported"}</p></section>
        <section class="desktop-inspector-card"><h3>Pending requests</h3><Show when={task().state === "waiting" ? task().question : undefined} fallback={<p>{task().state === "waiting" ? "Waiting; no question was reported for this child." : "No pending question reported."}</p>}>{question => <form onSubmit={event => { event.preventDefault(); const text = answer().trim(); if (text) void props.onAnswer(task(), text) }}><label class="rl-field"><span>{question().text}</span><textarea value={answer()} disabled={props.busy || !reading()} onInput={event => setAnswer(event.currentTarget.value)} /></label><button type="submit" class="rl-btn" disabled={!answer().trim() || props.busy || !reading()}>Send answer</button></form>}</Show></section>
        <button type="button" class="rl-btn desktop-child-open" onClick={() => props.onOpen(task().sessionID)}><Icon name="arrow-up-right" />Open Dedicated Child Session</button>
      </>}</Show>
    </aside>
  </div>
}

function ProjectCoordination(props: { readonly group: import("./contract").ProjectsSnapshot["groups"][number]; readonly sessions: readonly SessionItem[]; readonly repositories: import("./contract").ProjectsSnapshot["repositories"]; readonly onOpen: (id: string) => void }) {
  const [selectedID, setSelectedID] = createSignal<string>()
  const members = () => props.group.members
  const selected = () => members().find(member => member.sessionID === selectedID()) ?? members()[0]
  const record = (id: string) => props.sessions.find(item => item.id === id)
  const model = (id: string) => { const value = record(id)?.model; return value ? `${value.providerID}/${value.id}` : "Model not reported" }
  const canonical = (directory: string) => props.repositories.find(repository => repository.directory === directory)?.projectWorktree ?? "Canonical path not reported"
  return <div class="desktop-coordination" data-project-coordination><div class="desktop-coordination-main"><details class="desktop-project-ownership" aria-label="Ownership & drivers"><summary>Ownership &amp; Driver Representation <span>{formatCount(members().length)} members</span></summary><p>Master Session · {props.group.master.title} · {props.group.master.sessionID}</p><ul class="desktop-ownership"><For each={members()}>{member => <li><strong>{member.title}</strong><span>Owner: {member.owner ? `${member.owner.title} · ${member.owner.sessionID}` : "Not reported"}</span><span>Driven by: {member.drivenBy ? `${member.drivenBy.title} · ${member.drivenBy.sessionID}` : "Not reported"}</span></li>}</For></ul></details><div class="desktop-table-scroll"><table aria-label="Member Sessions" class="desktop-coordination-table"><thead><tr><th>Member Title &amp; ID</th><th>State</th><th>Location</th><th>Model</th><th>Pending</th><th>Actions</th></tr></thead><tbody><For each={members()}>{member => <tr aria-selected={selected()?.sessionID === member.sessionID}><td><button type="button" class="desktop-row-select" onClick={() => setSelectedID(member.sessionID)}><strong>{member.title}</strong><small>{member.sessionID}</small></button></td><td>{member.state}</td><td><code>{member.location.directory}</code><small>Canonical: {canonical(member.location.directory)}</small></td><td>{model(member.sessionID)}</td><td>{formatCount(member.pending.length)}</td><td><button type="button" class="rl-btn" onClick={() => props.onOpen(member.sessionID)}>Open</button></td></tr>}</For></tbody></table></div><Show when={!members().length}><p>No member Sessions reported.</p></Show><details aria-label="Pending requests & escalations" class="desktop-blockers"><summary>Pending Requests &amp; Escalations <span>{formatCount(members().reduce((total, member) => total + member.pending.length, 0))}</span></summary><For each={members().flatMap(member => member.pending.map(request => ({ member, request })))} fallback={<p>No pending requests reported by this Project.</p>}>{entry => <article><div><strong>{entry.member.title} · {entry.request.kind}</strong><p>{entry.request.summary}</p><small>{entry.request.requestID}</small></div><button type="button" class="rl-btn" onClick={() => props.onOpen(entry.member.sessionID)}>Review in Session</button></article>}</For></details></div><aside class="desktop-selected-inspector" aria-label="Selected member"><Show when={selected()} fallback={<p>Select a member Session to inspect it.</p>}>{member => <><h2>{member().title}</h2><p>{member().sessionID} · {member().state}</p><dl><dt>Owner</dt><dd>{member().owner?.title ?? "Not reported"}</dd><dt>Driver</dt><dd>{member().drivenBy?.title ?? "Not reported"}</dd><dt>Working folder</dt><dd>{member().location.directory}</dd><dt>Canonical path</dt><dd>{canonical(member().location.directory)}</dd><dt>Model</dt><dd>{model(member().sessionID)}</dd><dt>Pending requests</dt><dd>{formatCount(member().pending.length)}</dd><dt>Last activity</dt><dd>{new Date(member().lastActivity).toLocaleString()}</dd></dl><button type="button" class="rl-btn" onClick={() => props.onOpen(member().sessionID)}>Open member Session</button><button type="button" class="rl-btn" onClick={() => props.onOpen(props.group.master.sessionID)}>Open Master</button></>}</Show></aside></div>
}

function DesktopSwarmBoard(props: { readonly groupID: string; readonly masterSessionID: string; readonly onOpen: (id: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const board = observe(() => {
    const revision = connection().revision
    return {
      queryKey: ["swarm-board", ...scope(), props.groupID, props.masterSessionID] as const,
      queryFn: () => revision === undefined ? Promise.reject(new Error("Choose the current Project."))
        : api.swarmBoard({ groupID: props.groupID, masterSessionID: props.masterSessionID, revision }),
      enabled: reading() && revision !== undefined && open(),
    }
  })
  onCleanup(api.onEvent((event) => {
    if (open() && reading() && boardUpdateGroup(event, props.masterSessionID) === props.groupID) board.refetch()
  }))
  return <details class="st-section" aria-label="Swarm Board" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Swarm Board</summary>
    <Show when={open()}>
      <Show when={board.result().isPending}><p role="status">Reading Swarm Board…</p></Show>
      <Show when={board.result().isError}><p role="alert">{failure(board.result().error, "Swarm Board could not be read.")}</p><button type="button" class="rl-btn" onClick={board.refetch}>Refresh Board</button></Show>
      <Show when={reading() && !board.result().isError ? board.result().data : undefined}>{(value) => <SwarmBoard view={() => swarmBoardView(value())} onOpenSession={props.onOpen} />}</Show>
    </Show>
  </details>
}

function WorkspaceTargetPicker(props: { readonly directory: string; readonly locked: boolean; readonly onApply: (directory: string) => void; readonly onBrowse: () => void; readonly onClose: () => void }) {
  onMount(() => document.querySelector<HTMLButtonElement>('.desktop-target-picker > header button')?.focus())
  const projects = observe(() => ({ queryKey: ["projects", ...scope()] as const, queryFn: () => api.projects(), enabled: reading() }))
  const data = () => projects.result().isError ? undefined : currentSnapshot(projects.result().data, connection().revision)
  const repositories = () => (data()?.repositories ?? []).filter((item, index, items) => items.findIndex(candidate => candidate.projectID === item.projectID && candidate.projectWorktree === item.projectWorktree) === index)
  const [repositoryID, setRepositoryID] = createSignal<string>()
  const repository = () => repositories().find(item => `${item.projectID}:${item.projectWorktree}` === repositoryID()) ?? repositories().find(item => item.directory === props.directory || item.projectWorktree === props.directory) ?? repositories()[0]
  const [selected, setSelected] = createSignal(props.directory)
  const directories = observe(() => ({ queryKey: ["workspace-directories", ...scope(), repository()?.projectID, repository()?.projectWorktree] as const, queryFn: () => api.workspaceDirectories({ projectID: repository()!.projectID, directory: repository()!.projectWorktree }), enabled: reading() && !!repository() }))
  const directoryData = () => directories.result().isError ? undefined : currentSnapshot(directories.result().data, connection().revision)
  const entries = () => directoryData()?.projectID === repository()?.projectID ? directoryData()?.directories ?? [] : []
  const [createOpen, setCreateOpen] = createSignal(false)
  const [parent, setParent] = createSignal("")
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [uncertain, setUncertain] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()
  const identity = () => `${scope().join(":")}:${repository()?.projectID}:${repository()?.projectWorktree}`
  const guard = createActionGuard<WorkspaceMutationInput, Awaited<ReturnType<typeof api.changeWorkspace>>>((message) => confirmInPage(message), identity, input => api.changeWorkspace(input))
  createEffect(on(scope, props.onClose, { defer: true }))
  const apply = () => { if (!props.locked && !busy() && !uncertain() && (selected() === "" || entries().some(item => item.directory === selected()))) props.onApply(selected()) }
  const create = async () => {
    const current = repository(), revision = connection().revision
    if (!current || revision === undefined || !reading() || props.locked || busy() || uncertain()) return
    const valid = name().trim() ? validateFolderSegment(name().trim()) : undefined
    if (valid && !valid.valid) { setNotice(valid.error); return }
    if (!parent().startsWith("/")) { setNotice("Choose an absolute parent directory for the new worktree."); return }
    const owner = identity()
    setBusy(true); setNotice(undefined)
    try {
      const result = await guard.run({ kind: "create-copy", revision, projectID: current.projectID, sourceDirectory: current.projectWorktree, directory: parent(), strategy: "git_worktree", ...(valid?.valid ? { name: valid.name } : {}) }, `Create a Git worktree inside ${parent()}${name().trim() ? ` named ${name().trim()}` : " with a generated folder name"}? The current bridge creates a detached worktree; its folder name is not a branch name.`)
      if (identity() !== owner) { setUncertain(true); setNotice("Worktree creation was not confirmed after the target repository changed. Review the directory list before creating another worktree."); return }
      if (result.status === "completed" && result.value?.revision === revision && result.value.projectID === current.projectID) { setCreateOpen(false); setNotice("Worktree created. Refreshing the reported list; select its directory explicitly."); directories.refetch(); projects.refetch(); refresh(["workspaces"]) }
      else if (result.status === "completed") { setUncertain(true); setNotice("Worktree creation returned no matching directory result. Refresh and review the list before creating another worktree.") }
      if (result.status === "unconfirmed") { setUncertain(true); setNotice(failure(result.error, "Worktree creation was not confirmed. Review the directory list before trying again.")) }
    } finally { setBusy(false) }
  }
  return <ResponsiveLayer class="desktop-target-picker" label="Target Workspace / Worktree" onClose={props.onClose} onKeyDown={event => {
    if (event.key === "Escape" && !busy()) { event.preventDefault(); event.stopPropagation(); props.onClose() }
    else if (event.key === "Enter" && !createOpen() && (event.target === event.currentTarget || event.target instanceof HTMLElement && !!event.target.closest('[data-target-directory]'))) { event.preventDefault(); event.stopPropagation(); apply() }
  }}>
    <header><h2>Target Workspace / Worktree</h2><button type="button" class="rl-btn" disabled={busy()} onClick={props.onClose}>Close · Esc</button></header>
    <Show when={projects.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading registered repositories…" /></Show>
    <Show when={projects.result().isError}><p role="alert">{failure(projects.result().error, "Repositories could not be read.")}</p><button type="button" class="rl-btn" onClick={projects.refetch}>Refresh repositories</button></Show>
    <Show when={data()?.repositoriesNext}><p class="st-muted">More registered repositories are available in Workspaces.</p></Show>
    <div class="desktop-target-columns">
      <section aria-label="Repositories"><h3>Repositories</h3>
        <For each={repositories()} fallback={<Show when={projects.result().isSuccess && data()}><p>No registered repositories.</p></Show>}>{item => <button type="button" class="desktop-target-option" aria-pressed={repository()?.projectID === item.projectID && repository()?.projectWorktree === item.projectWorktree} onClick={() => { setRepositoryID(`${item.projectID}:${item.projectWorktree}`); setSelected("") }}><strong>{item.projectName ?? workspaceBase(item.projectWorktree)}</strong><small>{item.projectWorktree}</small></button>}</For>
        <button type="button" class="rl-btn" onClick={props.onBrowse}>Browse folders…</button>
      </section>
      <section aria-label="Worktrees"><h3>Worktrees</h3>
        <Show when={directories.result().isPending && repository()}><SharedLoadingSkeleton kind="list" label="Reading worktrees…" /></Show>
        <Show when={directories.result().isError}><p role="alert">{failure(directories.result().error, "Worktrees could not be read.")}</p><button type="button" class="rl-btn" onClick={directories.refetch}>Refresh worktrees</button></Show>
        <For each={entries()}>{item => <button type="button" class="desktop-target-option" data-target-directory aria-pressed={selected() === item.directory} disabled={item.available === false} onClick={event => { setSelected(item.directory); event.currentTarget.focus() }}><strong>{item.name ?? workspaceBase(item.directory)}</strong><small>{item.directory} · {item.kind ?? "Registered folder"}</small></button>}</For>
        <button type="button" class="rl-btn" disabled={!repository() || props.locked || uncertain()} onClick={() => { setCreateOpen(!createOpen()); setParent(repository()?.projectWorktree ?? "") }}>New worktree…</button>
      </section>
    </div>
    <Show when={createOpen()}><div class="desktop-target-create"><label class="rl-field"><span>Parent directory</span><input value={parent()} disabled={busy() || uncertain()} onInput={event => setParent(event.currentTarget.value)} /></label><label class="rl-field"><span>Folder name (optional)</span><input value={name()} disabled={busy() || uncertain()} onInput={event => setName(event.currentTarget.value)} /></label><p class="st-muted">Creates a detached Git worktree. Select the reported result before starting a Session.</p><button type="button" class="rl-btn" disabled={busy() || uncertain() || !reading()} onClick={() => void create()}>{busy() ? "Creating…" : "Create worktree"}</button></div></Show>
    <Show when={notice()}><p role={uncertain() ? "alert" : "status"}>{notice()}</p></Show>
    <footer><button type="button" class="rl-btn" onClick={() => { setSelected(""); props.onApply("") }} disabled={props.locked || busy()}>Standalone · no workspace</button><span>{selected() || "No filesystem context"}</span><button type="button" class="rl-btn" disabled={props.locked || busy() || uncertain() || !selected() || !entries().some(item => item.directory === selected())} onClick={apply}>Apply · Enter</button></footer>
  </ResponsiveLayer>
}

function payload(event: YCodingEvent): unknown {
  return "data" in event ? event.data : undefined
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
  const sessionID = eventSessionID(event)
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
  setPromptEditor(undefined)
  setPendingAssistance(undefined)
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
  const consent = observe(() => ({ queryKey: ["telemetry-consent", ...scope()] as const, queryFn: () => api.telemetryConsent(), enabled: reading() }))
  const telemetryEnabled = () => reading() && !consent.result().isError && currentSnapshot(consent.result().data, connection().revision)?.state.consent?.enabled === true
  const telemetry = createClientTelemetry({ enabled: telemetryEnabled, append: (batch) => api.appendTelemetry(batch), error: (cause) => { setDesktopNotice(failure(cause, "Latency diagnostics were not recorded.")); consent.refetch() } })
  const audio = createDesktopAudio()
  const attention = createDesktopAttention({ enabled: attentionEnabled, notifications: attentionNotifications, sound: attentionSound, volume: attentionVolume, play: audio.play, focused: () => document.hasFocus(), notify: (input) => api.notify(input), error: () => setDesktopNotice("Attention could not be delivered. Review notification access or click this window to enable sound.") })
  const attentionScope = createMemo(() => scope().join(":"))
  createEffect(on(attentionScope, () => { attention.reset(); audio.stop() }))
  createEffect(() => { if (!attentionEnabled() || !attentionSound()) audio.stop() })
  onCleanup(audio.stop)
  const telemetryScope = createMemo(() => `${scope().join(":")}:${telemetryEnabled()}`)
  createEffect(on(telemetryScope, () => telemetry.reset()))
  createEffect(() => { if (consent.result().isError) setDesktopNotice(failure(consent.result().error, "Latency consent could not be read. No measurements will be recorded.")) })
  const telemetryInterval = setInterval(() => void telemetry.flush(), 10_000)
  onCleanup(() => { clearInterval(telemetryInterval); telemetry.reset() })
  createEffect(() => { if (location().pathname === "/") void navigate({ to: "/sessions" }) })
  onMount(() => {
    const theme = window.matchMedia("(prefers-color-scheme: dark)")
    try { const saved = localStorage.getItem("ycoding.desktop.theme"); if (isDesktopThemeID(saved)) setThemePreference(saved) } catch { setDesktopNotice("The saved theme could not be read.") }
    paintTheme()
    try {
      setKeyboardOverrides(parseKeyboardOverrides(localStorage.getItem("ycoding.desktop.keybindings")))
      setAttentionEnabled(localStorage.getItem("ycoding.desktop.attention") === "true")
      setAttentionNotifications(localStorage.getItem("ycoding.desktop.notifications") !== "false")
      setAttentionSound(localStorage.getItem("ycoding.desktop.notification-sound") !== "false")
      const storedVolume = localStorage.getItem("ycoding.desktop.notification-volume")
      const volume = storedVolume === null ? 0.5 : Number(storedVolume)
      if (Number.isFinite(volume) && volume >= 0 && volume <= 1) setAttentionVolume(volume)
    } catch { setDesktopNotice("Saved attention preferences could not be read. Attention is off.") }
    try { setPasteMode(parsePasteMode(localStorage.getItem(PASTE_STORAGE_KEY))) } catch { setDesktopNotice("The saved paste preference could not be read.") }
    try { const saved = parsePresentationSettings(localStorage.getItem(PRESENTATION_STORAGE_KEY)); setPresentation(saved); showCompanion(startupCompanionOpen(saved, window.matchMedia(COMPANION_DOCKED_QUERY).matches)) } catch { setDesktopNotice("The saved display preferences could not be read.") }
    try { const saved = localStorage.getItem("ycoding.desktop.animations"); if (saved === "true" || saved === "false") applyAnimationsPreference(saved === "true") } catch { setDesktopNotice("The saved motion preference could not be read.") }
    theme.addEventListener("change", paintTheme)
    const apply = (state: ConnectionState) => {
      if (state.generation < connection().generation) return
      if (state.generation !== connection().generation) resetDrafts()
      if (state.generation !== connection().generation || state.revision !== connection().revision) { queries.clear(); setActivity(noActivity); setExecutionStates(new Map()); setLastSessionID(undefined) }
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
    const events = createEventRefresh({ queries, source: api, scope, accept: (event) => { const sessionID = eventSessionID(event); return acceptsHistoryEvent(sessionID ? queries.getQueryData<SessionSnapshot>(["messages", ...scope(), sessionID]) : undefined, event) }, event: (event) => {
      attention.event(event)
      setActivity((current) => track(current, event))
      const type: string = event.type
      if (event.type === "session.text.delta" || event.type === "session.reasoning.delta" || event.type === "session.tool.input.delta") telemetry.record("stream.delay", Date.now() - event.created)
      const sessionID = eventSessionID(event)
      if (sessionID && event.type === "session.input.deleted") {
        queries.setQueryData<SessionSnapshot>(["messages", ...scope(), sessionID], (current) => current && {
          ...current, messages: current.messages.filter((message) => message.id !== event.data.inputID),
        })
      }
      if (sessionID && (stopped.has(type) || type === "session.execution.started" || type === "session.deleted")) setExecutionStates((current) => {
        if (type === "session.idle" && current.get(sessionID) === "failed") return current
        const next = new Map(current)
        if (type === "session.execution.failed") next.set(sessionID, "failed")
        else if (stopped.has(type)) next.set(sessionID, "idle")
        else next.delete(sessionID)
        return next
      })
    }, resync: () => { setActivity(noActivity); setExecutionStates(new Map()) } })
    const menu = typeof api.onMenuAction === "function" ? api.onMenuAction((action) => {
      if (action === "new-chat") void navigate({ to: "/chat" })
      else if (action === "open-settings") void navigate({ to: "/settings" })
      else if (action === "check-for-updates") { setUpdateTriggerTick((tick) => tick + 1); void navigate({ to: "/settings" }) }
    }) : () => {}
    const shortcut = (event: KeyboardEvent) => {
      if (isStandardEditShortcut(event)) return
      const action = desktopShortcut(event, { editable: isEditableKeyboardTarget(event.target), modal: !!document.querySelector("dialog[open]"), palette: paletteOpen() }, keyboardOverrides())
      if (!action) return
      if (action === "palette") { event.preventDefault(); setPaletteOpen((open) => !open); return }
      if (action === "new" || action === "settings") { event.preventDefault(); void navigate({ to: action === "new" ? "/chat" : "/settings" }); return }
      if (action === "sidebar") { event.preventDefault(); setRailCollapsed(!railCollapsed()); return }
      if (action === "companion") { event.preventDefault(); setCompanionOpen(!companionOpen()); return }
      const owner = commandOwner()
      event.preventDefault()
      void (owner ? owner.run(action, "") : commonCommand(action, "", {}, (to) => { void navigate({ to }) })).then((handled) => { if (!handled) setDesktopNotice("Open a Session to use this command.") }).catch((cause: unknown) => setDesktopNotice(failure(cause, "The command was not confirmed.")))
    }
    const preventFileNavigation = (event: DragEvent) => { if (hasTransferFiles(event.dataTransfer)) event.preventDefault() }
    window.addEventListener("keydown", shortcut)
    window.addEventListener("dragover", preventFileNavigation)
    window.addEventListener("drop", preventFileNavigation)
    onCleanup(() => { theme.removeEventListener("change", paintTheme); window.removeEventListener("keydown", shortcut); window.removeEventListener("dragover", preventFileNavigation); window.removeEventListener("drop", preventFileNavigation); states(); events.dispose(); menu(); queries.clear() })
  })
  return <TelemetryContext.Provider value={telemetry}><div class="desktop rl rl-ledger desktop--workspace">
    <style id="desktop-schemes">{schemeStylesheet()}</style>
    <Outlet />
    <Show when={desktopNotice()}>{(notice) => <p role="status" class="desktop__notice">{notice()}<button type="button" class="rl-btn" onClick={() => setDesktopNotice(undefined)}>Dismiss</button></p>}</Show>
    <Show when={paletteOpen()}><Palette /></Show><ConfirmDialog />
    <Show when={folderDialog()} keyed>{(options) => <FolderExplorerDialog options={options} />}</Show>
    <Show when={utilityDialog()} keyed>{(options) => <UtilityDialog options={options} />}</Show>
    <Show when={stashDialog()} keyed>{(options) => <StashDialog options={options} />}</Show>
    <Show when={promptEditor()} keyed>{(options) => <PromptEditorDialog options={options} />}</Show>
  </div></TelemetryContext.Provider>
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
function DesktopDialog(props: { title: string; kind?: "folder" | "providers" | "diff" | "system" | "agents" | "browser" | "session" | "stash" | "editor" | "export" | "appearance" | "mcp" | "image"; navigation?: JSX.Element; headerActions?: JSX.Element; footer?: JSX.Element; onClose: () => void; children: JSX.Element }) {
  const titleID = `desktop-dialog-${++dialogIDs}`
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  let dialog: HTMLDialogElement | undefined
  onMount(() => dialog?.showModal())
  onCleanup(() => { dialog?.close(); if (opener?.isConnected) opener.focus() })
  const swipe = swipeDismiss(props.onClose)
  let backdropDown = false
  const outside = (event: PointerEvent) => { const rect = dialog!.getBoundingClientRect(); return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom }
  return <dialog ref={dialog} class="desktop-dialog" data-kind={props.kind} aria-labelledby={titleID} onPointerDown={event => { backdropDown = event.target === dialog && outside(event) }} onPointerUp={event => { if (backdropDown && event.target === dialog && outside(event)) props.onClose(); backdropDown = false }} onKeyDown={event => {
    if (event.defaultPrevented || event.target instanceof Element && event.target.closest("dialog[open]") !== event.currentTarget) return
    if (event.key === "Escape" && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); props.onClose(); return }
    containDialogFocus(event, event.currentTarget)
  }} onCancel={(event) => { event.preventDefault(); props.onClose() }}><button type="button" class="compact-layer__handle" aria-label={`Dismiss ${props.title}`} onClick={props.onClose} {...swipe}><span aria-hidden="true" /></button><header class="desktop-dialog__head"><h2 id={titleID}>{props.title}</h2>{props.navigation}{props.headerActions}<button type="button" class="rl-icon-button desktop-dialog__close" aria-label={`Close ${props.title}`} onClick={props.onClose}><Icon name="close" /></button></header><div class="desktop-dialog__body">{props.children}</div>{props.footer}</dialog>
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
  return <DesktopDialog title={props.options.title} kind="folder" onClose={() => setFolderDialog(undefined)}>
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

type UtilityKind = "connect" | "mcp" | "diff" | "status" | "debug" | "agents" | "skills" | "browser" | "pair" | "remote" | "plugins" | "dots" | "help" | "themes"
type UtilityOptions = { readonly kind: UtilityKind; readonly source?: DesktopSource; readonly sessionID?: string; readonly directory?: string; readonly diffMode?: "git" | "branch"; readonly insert?: (value: string) => void; readonly chooseAgent?: (agent: { readonly id: string; readonly name: string }) => void }
const [utilityDialog, setUtilityDialog] = createSignal<UtilityOptions>()
const utilityKinds: readonly string[] = ["connect", "mcp", "diff", "status", "debug", "agents", "skills", "browser", "pair", "remote", "plugins", "dots", "help"]
const [commandOwner, setCommandOwner] = createSignal<{ sessionID?: string; canSendToParent?: () => boolean; interactionActions?: () => readonly PaletteAction[]; run: (name: string, args: string) => Promise<boolean> }>()
const sessionCommands = new Set(["compact", "autonomous", "goal", "daybreak", "rename", "fork", "move", "undo", "redo", "terminals", "session-actions", "processes", "background", "variants", "find", "timeline", "copy", "export", "archive", "unarchive", "delete", "share", "unshare", "parent", "next-child", "previous-child", "btw", "btw-send", "suggest", "cd", "sleep", "wake"])
type StashOptions = { readonly draft: () => StashedPrompt; readonly update: (draft: StashedPrompt) => void; readonly directory?: string }
const [stashDialog, setStashDialog] = createSignal<StashOptions>()
const [promptEditor, setPromptEditor] = createSignal<StashOptions>()
async function editPrompt(options: StashOptions, current: () => boolean) {
  const original = options.draft()
  const result = options.directory ? await api.editDraft({ text: original.text, directory: options.directory }) : { kind: "fallback" as const }
  if (!current()) return
  if (result.kind === "edited") { options.update({ ...original, text: result.text, pasted: [] }); return }
  if ("notice" in result && result.notice) setDesktopNotice(result.notice)
  setPromptEditor({ ...options, draft: () => original })
}
const [pendingAssistance, setPendingAssistance] = createSignal<{ readonly sessionID: string; readonly text: string }>()

function PromptEditorDialog(props: { options: StashOptions }) {
  const original = props.options.draft()
  const [text, setText] = createSignal(original.text)
  return <DesktopDialog title="Edit prompt" kind="editor" onClose={() => setPromptEditor(undefined)}>
    <label class="rl-field"><span>Prompt draft</span><textarea rows={16} value={text()} onInput={(event) => setText(event.currentTarget.value)} /></label>
    <p>Saving updates the composer without sending it. File and agent attachments stay attached.</p>
    <div class="desktop-dialog__actions"><button type="button" class="rl-btn" onClick={() => setPromptEditor(undefined)}>Cancel</button><button type="button" class="rl-btn" onClick={() => { props.options.update({ ...original, text: text() }); setPromptEditor(undefined) }}>Save draft</button></div>
  </DesktopDialog>
}

function StashDialog(props: { options: StashOptions }) {
  const [entries, setEntries] = createSignal<ReturnType<typeof parsePromptStashes>>([])
  const [error, setError] = createSignal<string>()
  const key = "ycoding.desktop.prompt-stashes"
  let alive = true
  onCleanup(() => { alive = false })
  onMount(() => { try { setEntries(parsePromptStashes(localStorage.getItem(key))) } catch { setError("Saved drafts could not be read.") } })
  const save = (next: ReturnType<typeof parsePromptStashes>) => { localStorage.setItem(key, JSON.stringify(next)); setEntries(next) }
  const occupied = () => { const draft = props.options.draft(); return !!(draft.text.trim() || draft.files?.length || draft.agents?.length || draft.picks?.length) }
  return <DesktopDialog title="Prompt stashes" kind="stash" onClose={() => setStashDialog(undefined)}>
    <p>Drafts and their file and agent attachments are saved on this Mac.</p>
    <button type="button" class="rl-btn" disabled={!occupied()} onClick={() => {
      try {
        save(pushPromptStash(parsePromptStashes(localStorage.getItem(key)), { ...props.options.draft(), id: crypto.randomUUID(), directory: props.options.directory, createdAt: Date.now() }))
        props.options.update({ text: "" })
      } catch { setError("The draft was not saved; it remains in the composer.") }
    }}>Stash current draft</button>
    <ul class="desktop-dialog__entries"><For each={entries()} fallback={<li>No saved drafts.</li>}>{(entry) => <li>
      <p>{entry.text}</p><small>{entry.directory ?? "Standalone"} · {new Date(entry.createdAt).toLocaleString()} · {formatCount((entry.files?.length ?? 0) + (entry.agents?.length ?? 0) + (entry.picks?.length ?? 0))} attachments</small>
      <button type="button" class="rl-btn" onClick={() => { void (async () => {
        if (occupied() && !(await confirmInPage("Replace the current composer draft and attachments with this saved draft?"))) return
        if (!alive) return
        try {
          save(parsePromptStashes(localStorage.getItem(key)).filter((item) => item.id !== entry.id))
          props.options.update(entry)
          setStashDialog(undefined)
        } catch { setError("The saved draft could not be restored.") }
      })() }}>Pop and restore</button>
      <button type="button" class="rl-btn" onClick={() => { void (async () => {
        if (!(await confirmInPage("Delete this saved draft and its attachments?")) || !alive) return
        try { save(parsePromptStashes(localStorage.getItem(key)).filter((item) => item.id !== entry.id)) } catch { setError("The saved draft could not be deleted.") }
      })() }}>Delete saved draft</button>
    </li>}</For></ul>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </DesktopDialog>
}

export function transcriptText(message: Messages[number]) {
  if (message.type === "assistant") return groupAssistantParts(message.content).flatMap((group) => group.kind === "text" ? [group.text] : []).join("\n\n")
  if (message.type === "synthetic") return dotSteerDisplay(message)?.text ?? message.text
  if (message.type === "user" || message.type === "system") return message.text
  if (message.type === "shell") return `${message.command}\n${message.output?.output ?? ""}`
  return ""
}

let restartingBackend = false
async function commonCommand(name: string, args: string, options: Omit<UtilityOptions, "kind">, go: (path: "/chat" | "/sessions" | "/workspaces" | "/projects" | "/usage" | "/settings") => void) {
  if (name === "restart") {
    if (!reading() || connection().revision === undefined) throw new Error("Connect to a backend before restarting it.")
    if (restartingBackend) return true
    restartingBackend = true
    const starting = scope().join(":")
    try {
      if (!(await confirmInPage(connection().mode === "own" ? "Restart this window's private backend? Running work will disconnect while the backend restarts." : "Restart the connected registered local service? All clients of that service will disconnect while it restarts."))) return true
      if (scope().join(":") !== starting || connection().revision === undefined) throw new Error("The backend changed before restart. Review the current connection.")
      const result = await api.restartBackend({ revision: connection().revision! })
      if (result.status !== "connected") throw new Error(result.error ?? "The backend restart was not confirmed.")
      setDesktopNotice("The backend restarted.")
      return true
    } finally { restartingBackend = false }
  }
  if (name === "docs") {
    const result = await api.openExternalUrl({ url: "https://ycoding.althenia.app/docs" })
    if (!result.opened) throw new Error("The documentation could not be opened in the browser.")
    return true
  }
  if (name === "exit") {
    if (!(await confirmInPage("Quit YCoding Desktop? A shared backend keeps running; a private backend stops with this window."))) return false
    await api.quit()
    return true
  }
  if (["new", "sessions", "workspaces", "projects", "usage", "settings"].includes(name)) { go(name === "new" ? "/chat" : name === "sessions" ? "/sessions" : name === "workspaces" ? "/workspaces" : name === "projects" ? "/projects" : name === "usage" ? "/usage" : "/settings"); return true }
  if (name === "theme" || name === "themes") { if (!args) setUtilityDialog({ ...options, kind: "themes" }); else if (isDesktopThemeID(args)) applyThemePreference(args); else throw new Error("Choose a listed theme from Appearance."); return true }
  if (name === "sidebar") { setRailCollapsed(!railCollapsed()); return true }
  if (name === "companion") { setCompanionOpen(!companionOpen()); return true }
  if (name === "share" || name === "unshare") { setDesktopNotice("Session sharing is unavailable in the current backend and terminal client. No sharing change was sent."); return true }
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

function AppearanceDialog() {
  return <DesktopDialog title="Appearance" kind="appearance" onClose={() => setUtilityDialog(undefined)}>
    <SharedRadioGroup label="Desktop theme" value={themePreference()} options={DESKTOP_THEMES.map((theme) => ({ value: theme.id, label: theme.label }))} onChange={(value) => { if (isDesktopThemeID(value)) applyThemePreference(value) }} />
    <p>{DESKTOP_THEMES.find((theme) => theme.id === themePreference())?.description}</p>
    <button type="button" class="rl-btn" aria-pressed={animationsEnabled()} onClick={() => applyAnimationsPreference(!animationsEnabled())}>Animations {animationsEnabled() ? "on" : "off"}</button>
  </DesktopDialog>
}

function UtilityDialog(props: { options: UtilityOptions }) {
  return props.options.kind === "themes" ? <AppearanceDialog /> : props.options.kind === "connect" ? <ProvidersDialog options={props.options} /> : props.options.kind === "mcp" ? <McpDialog options={props.options} /> : props.options.kind === "diff" ? <DiffDialog options={props.options} /> : props.options.kind === "help" ? <DesktopDialog title="Commands and shortcuts" onClose={() => setUtilityDialog(undefined)}><dl class="rl-meta"><For each={keyboardBindings(keyboardOverrides())}>{(entry) => <><dt>{KEYBOARD_ACTIONS.find((action) => action.id === entry.action)?.label ?? entry.action}</dt><dd><kbd>{shortcutLabel(entry.binding, mac)}</kbd> · {entry.context === "page" ? "outside text fields" : entry.context === "session" ? "current Session" : "global"}</dd></>}</For></dl><p>Edit command shortcuts in Settings. Enter sends; Shift+Enter inserts a newline. Escape closes the active menu or dialog. Editing shortcuts stay with the focused field. Reasoning changes made during a running turn are staged until it stops. Steer waits for a step boundary; Send and steer now interrupts the running turn first.</p><ul><For each={DESKTOP_BUILT_IN_SLASH_COMMANDS}>{(command) => <li><code>/{command.name}</code> {command.description}{command.aliases?.length ? ` · ${command.aliases.map((alias) => `/${alias}`).join(", ")}` : ""}</li>}</For></ul></DesktopDialog> : <SystemDialog options={props.options} />
}

function SessionExportDialog(props: { sessionID: string; onClose: () => void }) {
  const [format, setFormat] = createSignal<"markdown" | "json">("markdown")
  const [thinking, setThinking] = createSignal(thinkingExpanded())
  const [debug, setDebug] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [outcome, setOutcome] = createSignal<string>()
  const starting = scope().join(":")
  let alive = true
  const current = () => alive && starting === scope().join(":") && reading()
  onCleanup(() => { alive = false })
  const run = async (action: "copy" | "save") => {
    if (busy() || !current()) return
    setBusy(true); setError(undefined); setOutcome(undefined)
    try {
      const input = { sessionID: props.sessionID, format: format(), thinking: thinking(), ...(format() === "json" && debug() ? { debug: true } : {}) }
      if (action === "copy") {
        const exported = await api.exportSession(input)
        if (!current() || exported.revision !== connection().revision) throw new Error("The connection changed. Open export again.")
        await copyTextToClipboard(exported.content)
        if (current()) setOutcome("Transcript copied to the clipboard.")
      } else {
        const saved = await api.saveExportSession(input)
        if (current()) setOutcome(saved.saved ? `Saved to ${saved.path}` : "Export cancelled. No file was written.")
      }
    } catch (cause) { if (current()) setError(failure(cause, "The export was not confirmed. Review the destination before retrying.")) }
    finally { if (alive) setBusy(false) }
  }
  return <DesktopDialog title="Export Session" kind="export" onClose={props.onClose}>
    <SharedRadioGroup label="Export format" value={format()} disabled={busy()} options={[{ value: "markdown", label: "Markdown" }, { value: "json", label: "JSON" }]} onChange={setFormat} />
    <Show when={format() === "markdown"}><label class="rl-field"><input type="checkbox" checked={thinking()} disabled={busy()} onChange={(event) => setThinking(event.currentTarget.checked)} />Include reasoning</label></Show>
    <Show when={format() === "json"}><label class="rl-field"><input type="checkbox" checked={debug()} disabled={busy()} onChange={(event) => setDebug(event.currentTarget.checked)} />Include durable debug events</label></Show>
    <p>Export reads the full canonical transcript. Saving opens the Mac folder picker and does not overwrite an existing file.</p>
    <div class="desktop-dialog__actions"><button type="button" class="rl-btn" disabled={busy() || !current()} onClick={() => void run("copy")}>Copy transcript</button><button type="button" class="rl-btn" disabled={busy() || !current()} onClick={() => void run("save")}>Save transcript…</button></div>
    <Show when={busy()}><p role="status">Preparing transcript…</p></Show><Show when={outcome()}><p role="status">{outcome()}</p></Show><Show when={error()}><p role="alert">{error()}</p></Show>
  </DesktopDialog>
}

function dialogActions(owner: () => boolean = () => true) {
  const [busy, setBusy] = createSignal(false)
  const [uncertain, setUncertain] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const starting = scope().join(":")
  const owned = utilityDialog()
  const current = () => owner() && scope().join(":") === starting && utilityDialog() === owned && reading()
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
  const [providerID, setProviderID] = createSignal<string>()
  const [custom, setCustom] = createSignal(false)
  const choices = createMemo(() => providerChoices(data()?.items ?? []))
  const select = (id?: string) => { setKey({}); setInputs({}); setProviderID(id) }
  const matches = (item: { id: string; name: string }) => `${item.name} ${item.id}`.toLowerCase().includes(search().toLowerCase())
  const [key, setKey] = createSignal<Readonly<Record<string, string>>>({})
  const customMatches = () => matches(customEndpointChoice) || choices().custom.some(matches)
  const [label, setLabel] = createSignal("")
  const [code, setCode] = createSignal("")
  const [inputs, setInputs] = createSignal<Record<string, string>>({})
  const [attempt, setAttempt] = createSignal<{ integrationID: string; value: IntegrationAttempt }>()
  const actions = dialogActions()
  const refreshCatalog = () => { actions.reset(); catalog.refetch(); refresh(["models"]); refresh(["new-chat-models"]) }
  const change = (input: IntegrationMutationInput) => actions.run(async () => {
    const result = await api.manageIntegration(input)
    if (result.refresh?.status === "failed") throw new Error(result.refresh.message)
    if (result.refresh?.status === "refreshed") setDesktopNotice(`Credential refreshed. Expires ${new Date(result.refresh.expires).toLocaleString()}.`)
    if (result.attempt && "integrationID" in input) setAttempt({ integrationID: input.integrationID, value: result.attempt })
    if (input.kind === "oauth-cancel" || input.kind === "command-cancel") setAttempt(undefined)
    refresh(["models"]); refresh(["new-chat-models"]); catalog.refetch()
    return result
  }, input.kind === "credential-remove" ? "Remove this provider credential?" : input.kind === "command-start" ? "Run this provider's configured sign-in command?" : undefined)
  const base = () => ({ revision: data()!.revision, source: props.options.source })
  return <DesktopDialog title="Connect providers" kind="providers" onClose={() => { setKey({}); setCode(""); setUtilityDialog(undefined) }}>
    <div class="desktop-provider-tools"><label class="rl-field"><span>Search providers</span><input type="search" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} /></label><button type="button" class="rl-btn" onClick={refreshCatalog} disabled={actions.busy()}>Refresh providers</button></div>
    <Show when={catalog.result().isPending}><p role="status">Loading providers…</p></Show><Show when={catalog.result().isError}><p role="alert">{failure(catalog.result().error, "Providers could not be read.")}</p></Show>
    <div class="desktop-provider-layout"><section class="desktop-provider-list" aria-label="Provider list">
      <div class="provider-picker" aria-label="Providers">
        <For each={choices().builtIn.filter(matches)}>{(item) => <button type="button" class="rl-option" aria-pressed={!custom() && providerID() === item.id} onClick={() => { setCustom(false); select(item.id) }}><strong>{item.name}</strong><span>{item.id}</span></button>}</For>
        <Show when={data() && customMatches()}><button type="button" class="rl-option" aria-pressed={custom()} onClick={() => { setCustom(true); select() }}><strong>{customEndpointChoice.name}</strong></button></Show>
        <Show when={data() && !choices().builtIn.some(matches) && !customMatches()}><p class="desktop__muted">No providers match this search.</p></Show>
      </div>
    </section><section class="desktop-provider-detail" aria-label="Provider connection">
    <Show when={custom()}>
      <p>Add an endpoint with the terminal’s <code>/connect</code> command or in YCoding configuration on the backend machine. Refresh providers to manage its profiles here.</p>
      <For each={choices().custom.filter((item) => matches(customEndpointChoice) || matches(item))}>{(item) => <button type="button" class="rl-option" aria-pressed={providerID() === item.id} onClick={() => select(item.id)}>{item.name}</button>}</For>
    </Show>
    <Show when={providerID()}><label class="rl-field"><span>Credential label / new name</span><input value={label()} onInput={(event) => setLabel(event.currentTarget.value)} /></label></Show>
    <Show when={!providerID() && !custom()}><p>Choose a provider to view connection methods.</p></Show><For each={(custom() ? choices().custom : choices().builtIn).filter((item) => item.id === providerID())}>{(item) => <section class="st-section"><h3>{item.name}</h3><For each={item.methods}>{(method) => method.type === "key" ? <form onSubmit={(event) => { event.preventDefault(); const secret = key()[item.id] ?? ""; setKey((previous) => ({ ...previous, [item.id]: "" })); if (secret && data()) void change({ ...base(), kind: "connect-key", integrationID: item.id, key: secret, ...(label().trim() ? { label: label().trim() } : {}) }) }}><label class="rl-field"><span>{method.label ?? "API key"}</span><input type="password" autocomplete="off" value={key()[item.id] ?? ""} disabled={actions.blocked()} onInput={(event) => setKey((previous) => ({ ...previous, [item.id]: event.currentTarget.value }))} /></label><button type="submit" class="rl-btn" disabled={actions.blocked() || !key()[item.id] || !data()}>Connect API key</button></form> : method.type === "env" ? <p>Environment: {method.names.join(", ")}</p> : <div class="st-stack"><Show when={method.type === "oauth" ? method.prompts : undefined}>{(prompts) => <For each={prompts().filter((prompt) => !prompt.when || (prompt.when.op === "eq" ? inputs()[prompt.when.key] === prompt.when.value : inputs()[prompt.when.key] !== prompt.when.value))}>{(prompt) => <label class="rl-field"><span>{prompt.message}</span>{prompt.type === "select" ? <DesktopSelect label={prompt.message} value={inputs()[prompt.key] ?? ""} options={prompt.options} onChange={(value) => setInputs((previous) => ({ ...previous, [prompt.key]: value }))} /> : <input value={inputs()[prompt.key] ?? ""} placeholder={prompt.placeholder} onInput={(event) => setInputs((previous) => ({ ...previous, [prompt.key]: event.currentTarget.value }))} />}</label>}</For>}</Show><button type="button" class="rl-btn" disabled={actions.blocked() || !data() || attempt()?.value.status === "pending"} onClick={() => { if (data()) void change(method.type === "oauth" ? { ...base(), kind: "oauth-start", integrationID: item.id, methodID: method.id, inputs: inputs(), ...(label().trim() ? { label: label().trim() } : {}) } : { ...base(), kind: "command-start", integrationID: item.id, methodID: method.id, ...(label().trim() ? { label: label().trim() } : {}) }) }}>{method.label}</button></div>}</For>
      <ul class="st-rows desktop-credential-list" aria-label="Provider profiles"><For each={item.connections.filter((credential) => credential.type === "credential")}>{(credential) => {
        const active = () => field(credential, "active")
        return <li class="st-row desktop-credential-card"><header><strong>{word(field(credential, "label")) ?? "Provider credential"}</strong><StateBadge state={active() === true ? "completed" : active() === false ? "idle" : "unknown"} label={active() === true ? "Default" : active() === false ? "Not default" : "Default status not reported"} /></header>
          <div class="desktop__actions">
            <Show when={active() !== true}><button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: "credential-activate", credentialID: credential.id })}>Set default</button></Show>
            <button type="button" class="rl-btn" disabled={actions.blocked() || !label().trim() || !data()} onClick={() => void change({ ...base(), kind: "credential-rename", credentialID: credential.id, label: label().trim() })}>Rename</button>
            <Show when={credential.kind === "oauth"}><button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: "credential-refresh", credentialID: credential.id })}>Refresh credential</button></Show>
            <button type="button" class="rl-btn desktop-danger-action" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: "credential-remove", credentialID: credential.id })}>Remove</button>
          </div>
        </li>
      }}</For></ul>
    </section>}</For>
    <Show when={attempt()}>{(active) => <section class="st-section"><h3>Authorization · {active().value.status}</h3><p>{active().value.instructions}</p><p>{active().value.message}</p><p>Expires {new Date(active().value.time.expires).toLocaleString()}</p><Show when={active().value.url}>{(link) => <><code>{link()}</code><button type="button" class="rl-btn" disabled={actions.blocked()} onClick={() => void actions.run(() => api.openExternalUrl({ url: link() }))}>Open in browser</button></>}</Show><button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: active().value.kind === "oauth" ? "oauth-status" : "command-status", integrationID: active().integrationID, attemptID: active().value.attemptID })}>Check status</button><Show when={active().value.kind === "oauth" && (active().value.manualCode || active().value.mode === "code")}><form onSubmit={(event) => { event.preventDefault(); const authorizationCode = code(); setCode(""); if (data()) void change({ ...base(), kind: "oauth-complete", integrationID: active().integrationID, attemptID: active().value.attemptID, code: authorizationCode }) }}><label class="rl-field"><span>Authorization code</span><input autocomplete="off" value={code()} onInput={(event) => setCode(event.currentTarget.value)} /></label><button type="submit" class="rl-btn" disabled={actions.blocked() || !code() || !data()}>Complete authorization</button></form></Show><button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ ...base(), kind: active().value.kind === "oauth" ? "oauth-cancel" : "command-cancel", integrationID: active().integrationID, attemptID: active().value.attemptID })}>Cancel</button></section>}</Show>
    <Show when={actions.error()}><p role="alert">{actions.error()}</p></Show>
    </section></div>
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
  const statuses = {
    connected: { state: "completed", label: "Connected" }, pending: { state: "waiting", label: "Pending" },
    disabled: { state: "idle", label: "Disabled" }, failed: { state: "failed", label: "Failed" },
    needs_auth: { state: "waiting", label: "Needs authentication" }, needs_client_registration: { state: "waiting", label: "Needs client registration" },
  } as const
  return <DesktopDialog title="MCP servers" kind="mcp" onClose={() => setUtilityDialog(undefined)} headerActions={<button type="button" class="rl-icon-button" aria-label="Refresh servers" data-tooltip="Refresh servers" disabled={actions.busy() || servers.result().isFetching} onClick={() => { actions.reset(); servers.refetch() }}><Icon name="refresh" /></button>}>
    <Show when={servers.result().isPending}><p role="status">Loading MCP servers…</p></Show>
    <Show when={servers.result().isError}><p role="alert">{failure(servers.result().error, "MCP servers could not be read.")}</p></Show>
    <section class="desktop-mcp-servers" aria-label="MCP servers"><For each={data()?.items ?? []}>{(server) => <article class="desktop-mcp-server">
      <header><div class="desktop-mcp-server__identity"><h3>{server.name}</h3><StateBadge {...statuses[server.status]} /></div><div class="desktop-mcp-server__actions"><For each={["connect", "disconnect", "remove"] as const}>{(kind) => <button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void change({ revision: data()!.revision, source: props.options.source, name: server.name, kind })}>{kind === "connect" ? "Connect" : kind === "disconnect" ? "Disconnect" : "Remove"}</button>}</For></div></header>
      <Show when={server.error}><p class="desktop__error" role="alert">{server.error}</p></Show>
      <Show when={server.resources.length}><ul aria-label="Server resources"><For each={server.resources}>{(resource) => <li><strong>{resource.name}</strong><code>{resource.uri ?? resource.uriTemplate}</code><p>{resource.description}</p></li>}</For></ul></Show>
    </article>}</For></section>
    <Show when={data()?.resourcesNotice}><p role="status">{data()?.resourcesNotice}</p></Show>
    <form class="st-form" onSubmit={(event) => { event.preventDefault(); add() }}><h3>Add MCP server</h3><label class="rl-field"><span>Name</span><input value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label><DesktopSelect label="Server type" value={type()} options={[{ value: "local", label: "Local command" }, { value: "remote", label: "Remote URL" }]} onChange={setType} /><Show when={type() === "local"} fallback={<label class="rl-field"><span>Remote URL</span><input type="url" value={url()} onInput={(event) => setURL(event.currentTarget.value)} /></label>}><label class="rl-field"><span>Command (JSON argument array)</span><input value={command()} placeholder={'["node", "server.js"]'} onInput={(event) => setCommand(event.currentTarget.value)} /></label><label class="rl-field"><span>Working directory (optional)</span><input value={cwd()} onInput={(event) => setCwd(event.currentTarget.value)} /></label></Show><button type="submit" class="rl-btn" disabled={actions.blocked() || !data() || !name().trim()}>Add server</button></form>
    <Show when={error() ?? actions.error()}><p role="alert">{error() ?? actions.error()}</p></Show>
  </DesktopDialog>
}

function DiffDialog(props: { options: UtilityOptions }) {
  const [mode, setMode] = createSignal<"git" | "branch">(props.options.diffMode ?? "git")
  const diff = observe(() => ({ queryKey: ["vcs-diff", ...scope(), props.options.source, mode()] as const, queryFn: () => api.vcsDiff({ source: props.options.source, mode: mode() }), enabled: reading() }))
  const data = () => diff.result().isError ? undefined : currentSnapshot(diff.result().data, connection().revision)
  const [selectedPath, setSelectedPath] = createSignal<string>()
  createEffect(on(() => [mode(), data()] as const, () => setSelectedPath(undefined)))
  const selected = () => data()?.files.find((file) => file.file === selectedPath())?.file ?? data()?.files[0]?.file
  const [copyBusy, setCopyBusy] = createSignal(false)
  const [copiedPath, setCopiedPath] = createSignal<string>()
  const [copyError, setCopyError] = createSignal<string>()
  createEffect(on(selected, () => { setCopiedPath(undefined); setCopyError(undefined) }))
  const copyPath = async () => {
    const path = selected()
    if (!path || copyBusy() || diff.result().isFetching) return
    setCopyBusy(true); setCopiedPath(undefined); setCopyError(undefined)
    try { await copyTextToClipboard(path); setCopiedPath(path) }
    catch (cause) { setCopyError(failure(cause, "The file path could not be copied.")) }
    finally { setCopyBusy(false) }
  }
  return <DesktopDialog title="Git diff" kind="diff" onClose={() => setUtilityDialog(undefined)} navigation={<div class="desktop-diff-toolbar">
    <SharedRadioGroup label="Diff scope" value={mode()} options={[{ value: "git", label: "Working tree (git)" }, { value: "branch", label: "Branch" }]} onChange={(value) => setMode(value === "branch" ? "branch" : "git")} />
    <Show when={data()}>{(value) => <output class="desktop-diff-total" aria-label="Diff totals"><span>{formatCount(value().files.length)} files</span><span class="ws-add">+{formatCount(value().files.reduce((total, file) => total + file.additions, 0))}</span><span class="ws-del">−{formatCount(value().files.reduce((total, file) => total + file.deletions, 0))}</span></output>}</Show>
    <button type="button" class="rl-icon-button" aria-label="Refresh diff" data-tooltip="Refresh diff" disabled={!reading() || diff.result().isFetching} onClick={diff.refetch}><Icon name="refresh" /><span class="desktop__sr">Refresh</span></button>
    <Show when={diff.result().isFetching}><span role="status">Loading diff…</span></Show>
  </div>} footer={<footer class="desktop-dialog__foot"><span class="st-muted">Read-only · {mode() === "git" ? "Working tree" : "Branch diff"} · Branch: {data()?.branch.current ?? "unknown"}</span><Show when={copiedPath() === selected() && copiedPath()}><span role="status">Copied path</span></Show><Show when={copyError()}><span role="alert">{copyError()}</span></Show><div class="desktop-dialog__foot-actions"><button type="button" class="rl-btn" disabled={!selected() || copyBusy() || diff.result().isFetching} onClick={() => void copyPath()}>Copy path</button><button type="button" class="rl-btn" data-tone="go" onClick={() => setUtilityDialog(undefined)}>Done</button></div></footer>}><Show when={diff.result().isError}><div class="desktop-diff-read-error"><p role="alert">{failure(diff.result().error, "Diff could not be read.")}</p><button type="button" class="rl-btn" onClick={diff.refetch}>Retry read</button></div></Show><Show when={data()}>{(value) => <DesktopDiffView variant="git" files={value().files.map((file) => ({ path: file.file, patch: file.patch, additions: file.additions, deletions: file.deletions }))} selectedPath={selected()} onSelectFile={setSelectedPath} scopeLabel={`${mode() === "git" ? "Working tree" : "Branch diff"} · Branch: ${value().branch.current ?? "unknown"}`} />}</Show></DesktopDialog>
}

function DisplaySnapshot(props: { value: DisplayValue | undefined; name?: string }): JSX.Element {
  const bool = () => typeof props.value === "boolean" ? props.value : undefined
  const boolLabel = () => props.name === "enabled" ? bool() ? "Enabled" : "Disabled" : props.name === "ready" ? bool() ? "Ready" : "Not ready" : bool() ? "Yes" : "No"
  const status = () => {
    if ((props.name !== "state" && props.name !== "status") || typeof props.value !== "string") return undefined
    const label = props.value
    if (["on", "ready", "connected", "attached", "active"].includes(label)) return { tone: "completed", label }
    if (["starting", "connecting", "reconnecting", "pending", "waiting", "paused"].includes(label)) return { tone: "waiting", label }
    if (["off", "stopped", "disconnected", "detached", "unavailable"].includes(label)) return { tone: "idle", label }
    if (label === "error" || label === "failed") return { tone: "failed", label }
    return undefined
  }
  return <Show when={props.value !== undefined} fallback={<p class="st-muted">Not reported</p>}>
    <Show when={Array.isArray(props.value) ? props.value : undefined} fallback={
      <Show when={typeof props.value === "object" && props.value !== null ? Object.entries(props.value) : undefined} fallback={<Show when={status()} fallback={<Show when={bool() !== undefined} fallback={<span class="desktop-snapshot-value">{props.value === null ? "None" : String(props.value) || "Empty value"}</span>}><StateBadge state={bool() ? "completed" : "idle"} label={boolLabel()} /></Show>}>{state => <StateBadge state={state().tone} label={state().label} />}</Show>}>{entries =>
        <dl class="desktop-snapshot"><For each={entries()} fallback={<><dt>Fields</dt><dd>No fields reported.</dd></>}>{([name, value]) => <div class="desktop-snapshot__field" data-nested={value !== null && typeof value === "object" || undefined}><dt>{name.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, first => first.toUpperCase())}</dt><dd><DisplaySnapshot value={value} name={name} /></dd></div>}</For></dl>
      }</Show>
    }>{values => <ol class="desktop-snapshot-list"><For each={values()} fallback={<li class="st-muted">No entries reported.</li>}>{value => <li><DisplaySnapshot value={value} /></li>}</For></ol>}</Show>
  </Show>
}

function ContextDetails(props: { label: string; icon: WebIconName; value: DisplayValue | undefined }) {
  return <details class="desktop-context-details"><summary><Icon name={props.icon} /><span>{props.label}</span><span class="rl-disclosure-chev" aria-hidden="true"><Icon name="chevron-right" /></span></summary><DisplaySnapshot value={props.value} /></details>
}

function GlobalRequests(props: { directory?: string; workspace?: string }) {
  const location = () => props.directory ? { scope: "global" as const, directory: props.directory, ...(props.workspace ? { workspace: props.workspace } : {}) } : undefined
  const requests = observe(() => ({ queryKey: ["requests", ...scope(), "global", location()] as const, queryFn: () => api.requests(location()!), enabled: reading() && !!location() }))
  const data = () => requests.result().isError ? undefined : currentSnapshot(requests.result().data, connection().revision, "global")
  return <>
    <Show when={requests.result().isError}><p role="alert">{failure(requests.result().error, "Global MCP forms could not be read.")}</p><button type="button" class="rl-btn" onClick={requests.refetch}>Refresh global forms</button></Show>
    <Show when={data()?.forms.length ? data() : undefined}>{(value) => <section class="st-section" aria-label="Global MCP forms"><h3>Global MCP forms</h3><Requests data={value()} updatedAt={requests.result().dataUpdatedAt} refetch={requests.refetch} /></section>}</Show>
  </>
}

function UsageTools() {
  const [open, setOpen] = createSignal(false)
  const [provider, setProvider] = createSignal("")
  const [model, setModel] = createSignal("")
  const [agent, setAgent] = createSignal("")
  const [group, setGroup] = createSignal<"model" | "agent">("model")
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const [offset, setOffset] = createSignal(0)
  const [rangeError, setRangeError] = createSignal<string>()
  const [request, setRequest] = createSignal<Parameters<typeof api.incidents>[0]>()
  const dashboard = observe(() => ({ queryKey: ["usage-dashboard", ...scope()] as const, queryFn: () => api.usageDashboard(), enabled: reading() && open() }))
  const incidents = observe(() => ({ queryKey: ["incidents", ...scope(), request()] as const, queryFn: () => api.incidents(request()!), enabled: reading() && open() && !!request() }))
  const dashboardData = () => dashboard.result().isError ? undefined : currentSnapshot(dashboard.result().data, connection().revision)
  const incidentData = () => incidents.result().isError ? undefined : currentSnapshot(incidents.result().data, connection().revision)
  const reportRows = (): readonly unknown[] | undefined => { const value = field(incidentData()?.data, "rows"); return Array.isArray(value) ? value : undefined }
  const incidentCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? formatCount(value) : "Not reported"
  const incidentTime = (value: unknown) => { const time = typeof value === "number" ? new Date(value) : undefined; return time && Number.isFinite(time.getTime()) ? time.toLocaleString() : "Not reported" }
  const actions = dialogActions(() => open())
  const range = () => ({ ...(from() ? { from: Date.parse(from()) } : {}), ...(to() ? { to: Date.parse(to()) } : {}) })
  const report = (page = 0) => {
    const period = range()
    if (period.from !== undefined && !Number.isFinite(period.from) || period.to !== undefined && !Number.isFinite(period.to) || period.from !== undefined && period.to !== undefined && period.from >= period.to) { setRangeError("Enter valid UTC timestamps with From before Through."); return }
    setRangeError(undefined); setOffset(page); setRequest({ kind: "report", group: group(), ...period, offset: page, limit: 50 })
  }
  const guidanceCurrent = () => { const selected = request(); return selected?.kind === "guidance" && selected.provider === provider().trim() && selected.model === model().trim() }
  const clearGuidance = async () => {
    const current = incidentData()
    const selected = request()
    if (!current || current.kind !== "guidance" || selected?.kind !== "guidance" || !guidanceCurrent()) return
    await actions.run(async () => { await api.manageIncident({ revision: current.revision, kind: "guidance-clear", provider: selected.provider, model: selected.model }); incidents.refetch() }, `Clear incident guidance for ${selected.provider} / ${selected.model}?`)
  }
  return <section class="st-section" aria-label="Usage dashboard and incidents">
    <button type="button" class="rl-btn" aria-expanded={open()} onClick={() => setOpen(!open())}>Usage dashboard and incidents</button>
    <Show when={open()}>
      <Show when={dashboard.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading usage dashboard…" /></Show>
      <Show when={dashboard.result().isError}><p role="alert">{failure(dashboard.result().error, "The usage dashboard could not be read.")}</p></Show>
      <button type="button" class="rl-btn" disabled={!reading() || dashboard.result().isFetching} onClick={dashboard.refetch}>Refresh dashboard</button>
      <DisplaySnapshot value={dashboardData()?.dashboard} />
      <h3>Incident report</h3>
      <div class="desktop-incident-filters"><div><h4>Group by</h4><SharedRadioGroup label="Incident grouping" value={group()} options={[{ value: "model", label: "Model" }, { value: "agent", label: "Agent" }]} onChange={setGroup} /></div>
      <label class="rl-field"><span>From (UTC timestamp)</span><input placeholder="2026-11-15T00:00:00Z" value={from()} onInput={(event) => setFrom(event.currentTarget.value)} /></label>
      <label class="rl-field"><span>Through (UTC timestamp)</span><input placeholder="2026-11-16T00:00:00Z" value={to()} onInput={(event) => setTo(event.currentTarget.value)} /></label>
      </div>
      <Show when={rangeError()}><p role="alert">{rangeError()}</p></Show>
      <div class="desktop-incident-actions">
      <button type="button" class="rl-btn" disabled={!reading()} onClick={() => report()}>Read incident report</button>
      <button type="button" class="rl-btn" disabled={!reading() || request()?.kind !== "report" || offset() === 0} onClick={() => report(Math.max(0, offset() - 50))}>Previous incident page</button>
      <button type="button" class="rl-btn" disabled={!reading() || request()?.kind !== "report"} onClick={() => report(offset() + 50)}>Next incident page</button>
      </div><div class="desktop-incident-filters">
      <label class="rl-field"><span>Provider ID</span><input value={provider()} onInput={(event) => setProvider(event.currentTarget.value)} /></label>
      <label class="rl-field"><span>Model ID</span><input value={model()} onInput={(event) => setModel(event.currentTarget.value)} /></label>
      <label class="rl-field"><span>Agent filter</span><input value={agent()} onInput={(event) => setAgent(event.currentTarget.value)} /></label>
      </div><div class="desktop-incident-actions">
      <button type="button" class="rl-btn" disabled={!reading() || !provider().trim() || !model().trim()} onClick={() => setRequest({ kind: "recent", provider: provider().trim(), model: model().trim(), ...(agent().trim() ? { agent: agent().trim() } : {}), limit: 50 })}>Read recent incidents</button>
      <button type="button" class="rl-btn" disabled={!reading() || !provider().trim() || !model().trim()} onClick={() => setRequest({ kind: "guidance", provider: provider().trim(), model: model().trim() })}>Read incident guidance</button>
      <button type="button" class="rl-btn" disabled={actions.blocked() || incidentData()?.kind !== "guidance" || !guidanceCurrent()} onClick={() => void clearGuidance()}>Clear incident guidance</button>
      </div>
      <Show when={incidents.result().isFetching}><SharedLoadingSkeleton kind="list" label="Reading incidents…" /></Show>
      <Show when={incidents.result().isError}><p role="alert">{failure(incidents.result().error, "Incidents could not be read.")}</p><button type="button" class="rl-btn" onClick={incidents.refetch}>Refresh incidents</button></Show>
      <Show when={incidentData()}>{(data) => <Show when={data().kind === "report" && reportRows()} fallback={<DisplaySnapshot value={data().data} />}>{items => <div class="desktop-table-scroll"><table class="desktop-incident-report" aria-label="Incident report"><thead><tr><th>Provider ID</th><th>Model ID</th><th>Agent</th><th>Fallbacks</th><th>Escalated</th><th>Rejected</th><th>Last</th></tr></thead><tbody><For each={items()} fallback={<tr><td colspan={7}>No incidents reported for this range.</td></tr>}>{row => <tr><td>{word(field(row, "providerID")) ?? "Not reported"}</td><td>{word(field(row, "modelID")) ?? "Not reported"}</td><td>{word(field(row, "agent")) ?? "—"}</td><td>{incidentCount(field(row, "fallbacks"))}</td><td>{incidentCount(field(row, "escalated"))}</td><td>{incidentCount(field(row, "rejected"))}</td><td>{incidentTime(field(row, "last"))}</td></tr>}</For></tbody></table></div>}</Show>}</Show>
      <Show when={actions.error()}><p role="alert">{actions.error()}</p></Show>
    </Show>
  </section>
}

function SystemDialog(props: { options: UtilityOptions }) {
  const tabs = ["Status & Debug", "Agents & Skills", "Browser", "Remote & Pairing", "Plugins", "Dots"] as const
  const initial = props.options.kind === "agents" || props.options.kind === "skills" ? tabs[1] : props.options.kind === "browser" ? tabs[2] : props.options.kind === "remote" || props.options.kind === "pair" ? tabs[3] : props.options.kind === "plugins" ? tabs[4] : props.options.kind === "dots" ? tabs[5] : tabs[0]
  const [tab, setTab] = createSignal<(typeof tabs)[number]>(initial)
  const [actionTab, setActionTab] = createSignal<(typeof tabs)[number]>()
  const noticeTabs: Record<string, (typeof tabs)[number]> = {
    Skills: tabs[1], "Session skills": tabs[1],
    Browser: tabs[2], "Browser tabs": tabs[2], "Isolated browser": tabs[2], "Isolated browser tabs": tabs[2],
    Remote: tabs[3], Plugins: tabs[4], Dots: tabs[5],
  }
  const input = () => ({ sessionID: props.options.sessionID, directory: props.options.directory })
  const snapshot = observe(() => ({ queryKey: ["system", ...scope(), input()] as const, queryFn: () => api.systemSnapshot(input()), enabled: reading() }))
  const catalog = observe(() => ({ queryKey: ["composer-catalog", ...scope(), props.options.source] as const, queryFn: () => api.composerCatalog(props.options.source), enabled: reading() }))
  const catalogData = () => catalog.result().isError ? undefined : currentSnapshot(catalog.result().data, connection().revision)
  const [changed, setChanged] = createSignal<Awaited<ReturnType<typeof api.manageSystem>>>()
  const data = () => currentSnapshot(changed(), connection().revision) ?? (snapshot.result().isError ? undefined : currentSnapshot(snapshot.result().data, connection().revision))
  const [filter, setFilter] = createSignal("")
  const [url, setURL] = createSignal("https://example.com")
  const [catalogSelection, setCatalogSelection] = createSignal<{ readonly kind: "agent" | "skill"; readonly id: string }>()
  const inspectedCatalogItem = () => {
    const current = catalogData()
    const selected = catalogSelection() ?? (current?.skills[0] ? { kind: "skill", id: current.skills[0].id } : current?.agents[0] ? { kind: "agent", id: current.agents[0].id } : undefined)
    if (selected?.kind === "agent") { const agent = current?.agents.find(item => item.id === selected.id); return agent ? { kind: "agent" as const, ...agent } : undefined }
    const skill = current?.skills.find(item => item.id === selected?.id)
    return skill ? { kind: "skill" as const, ...skill } : undefined
  }
  const [pairingRevealed, setPairingRevealed] = createSignal(false)
  const [pairingCopy, setPairingCopy] = createSignal<string>()
  const [pairingCopyError, setPairingCopyError] = createSignal<string>()
  const [replaceAttachments, setReplaceAttachments] = createSignal(false)
  const dotsRevision = () => { const revision = field(field(data()?.dots, "access"), "revision"); return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined }
  const dotsTarget = () => { const target = field(field(data()?.dots, "computer"), "target"); const dotID = word(field(target, "dotID")), threadID = word(field(target, "threadID")), environmentID = word(field(target, "environmentID")), revision = word(field(target, "revision")); return dotID && threadID && environmentID && revision ? { dotID, threadID, environmentID, revision } : undefined }
  const actions = dialogActions()
  const manage = (request: SystemManageInput) => {
    if (actions.blocked()) return
    setActionTab(tab())
    return actions.run(async () => { const result = await api.manageSystem(request); setChanged(result); return result }, `${request.kind === "remote-set" ? request.enabled ? "Enable remote access to every Session on this backend" : "Disable remote access" : request.kind}?`)
  }
  const base = () => ({ ...input(), revision: data()!.revision })
  const insert = (value: string) => { if (props.options.insert) { props.options.insert(value); setUtilityDialog(undefined) } else { setDesktopNotice("Open a chat to insert an agent or skill.") } }
  const selectAgent = async (agent: ComposerCatalog["agents"][number]) => {
    const current = catalogData()
    if (!current || actions.blocked() || agent.mode === "subagent" || agent.id === "btw") return
    if (props.options.chooseAgent) { props.options.chooseAgent(agent); setUtilityDialog(undefined); return }
    const sessionID = props.options.sessionID
    if (!sessionID) return
    setActionTab(tab())
    const changed = await actions.run(async () => { await api.switchAgent({ sessionID, revision: current.revision, agent: agent.id }); refresh(["session", ...scope(), sessionID]); refresh(["models"]); refresh(["messages", ...scope(), sessionID]); return true }, `Use ${agent.name} as the active agent for this Session?`)
    if (changed) { setDesktopNotice(`Active agent changed to ${agent.name}.`); setUtilityDialog(undefined) }
  }
  const activateSkill = async (skill: ComposerCatalog["skills"][number]) => {
    const current = catalogData(), sessionID = props.options.sessionID
    if (!current || !sessionID || actions.blocked()) return
    setActionTab(tab())
    const changed = await actions.run(async () => { await api.activateSkill({ sessionID, revision: current.revision, skill: skill.id, promptID: `msg_${crypto.randomUUID()}` }); snapshot.refetch(); refresh(["messages", ...scope(), sessionID]); return true }, `Load ${skill.name} into this Session?`)
    if (changed) setDesktopNotice(`Skill activation requested: ${skill.name}.`)
  }
  const rows = (value: DisplayValue | undefined) => Array.isArray(value) ? value : []
  const skillConflicts = (value: unknown) => { const conflicts = field(value, "conflicts"); return Array.isArray(conflicts) ? conflicts.flatMap((conflict) => field(conflict, "type") === "skill" && word(field(conflict, "id")) ? [word(field(conflict, "id"))!] : []) : [] }
  return <DesktopDialog title="System and Session tools" kind={tab() === "Agents & Skills" ? "agents" : tab() === "Browser" ? "browser" : "system"} navigation={<div class="desktop-dialog__tabs" role="tablist" aria-label="System tools"><For each={tabs}>{(label, index) => <button type="button" role="tab" aria-selected={tab() === label} tabindex={tab() === label ? 0 : -1} onClick={() => setTab(label)} onKeyDown={(event) => { const next = event.key === "ArrowRight" ? (index() + 1) % tabs.length : event.key === "ArrowLeft" ? (index() + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined; if (next !== undefined) { event.preventDefault(); setTab(tabs[next]!); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[next]?.focus() } }}>{label}</button>}</For></div>} onClose={() => setUtilityDialog(undefined)}>
    <div class="desktop-dialog__toolbar"><button type="button" class="rl-btn" disabled={actions.busy()} onClick={() => { actions.reset(); setChanged(undefined); snapshot.refetch(); if (tab() === tabs[1]) catalog.refetch() }}><Icon name="refresh" />Refresh status</button></div>
    <Show when={tab() !== tabs[1] && snapshot.result().isPending}><p role="status">Reading status…</p></Show><Show when={tab() !== tabs[1] && snapshot.result().isError}><p role="alert">{failure(snapshot.result().error, "Status could not be read.")}</p></Show><Show when={actionTab() === tab() && actions.error()}><p role="alert">{actions.error()}</p></Show>
    <For each={Object.entries(data()?.notices ?? {}).filter(([name]) => (noticeTabs[name] ?? tabs[0]) === tab())}>{([, notice]) => <p role="status">{notice}</p>}</For>
    <section role="tabpanel" aria-label={tab()}><Show when={tab() === "Status & Debug"}><section class="st-section" aria-label="Backend connection"><h3>Backend connection</h3><dl class="rl-meta"><For each={Object.entries(data()?.connection ?? connection())}>{([name, value]) => <><dt>{name}</dt><dd>{String(value)}</dd></>}</For><dt>Session</dt><dd>{props.options.sessionID ?? "No Session"}</dd><dt>Directory</dt><dd>{data()?.directory ?? props.options.directory ?? "Standalone"}</dd></dl><For each={data()?.server?.urls ?? []}>{(url) => <p><code>{url}</code></p>}</For></section></Show>
    <Show when={tab() === "Status & Debug"}><section class="st-section"><h3>Configuration diagnostics</h3><DisplaySnapshot value={data()?.configDiagnostics} /></section><section class="st-section"><h3>Configured providers</h3><DisplaySnapshot value={data()?.providers} /></section><section class="st-section"><h3>References</h3><DisplaySnapshot value={data()?.references} /></section></Show>
    <Show when={tab() === "Agents & Skills"}>
      <label class="rl-field"><span>Search agents and skills</span><input type="search" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} /></label>
      <Show when={catalog.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading agents and skills…" /></Show>
      <Show when={catalog.result().isError}><p role="alert">Catalog could not be read.</p></Show>
      <For each={Object.values(catalogData()?.errors ?? {})}>{(error) => <p role="alert">{error}</p>}</For>
      <div class="desktop-agent-browser"><div class="desktop-agent-list"><h3>Agents</h3>
      <For each={(catalogData()?.agents ?? []).filter((item) => item.name.toLowerCase().includes(filter().toLowerCase()))}>{(agent) => <section class="st-section" data-selected={inspectedCatalogItem()?.kind === "agent" && inspectedCatalogItem()?.id === agent.id ? "true" : undefined}>
        <h4>{agent.name}</h4><p>{agent.description}</p>
        <button type="button" class="rl-btn" aria-pressed={inspectedCatalogItem()?.kind === "agent" && inspectedCatalogItem()?.id === agent.id} onClick={() => setCatalogSelection({ kind: "agent", id: agent.id })}>Inspect agent</button>
        <Show when={agent.mode !== "subagent" && agent.id !== "btw"}><button type="button" class="rl-btn" disabled={actions.blocked() || !catalogData() || !props.options.sessionID && !props.options.chooseAgent} onClick={() => void selectAgent(agent)}>{props.options.sessionID ? "Use as active agent" : "Use for new chat"}</button></Show>
        <button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.insert} onClick={() => insert(`@${agent.name} `)}>Mention @{agent.name}</button>
      </section>}</For>
      </div><div class="desktop-skill-list"><h3>Skills</h3>
      <For each={(catalogData()?.skills ?? []).filter((item) => item.name.toLowerCase().includes(filter().toLowerCase()))}>{(skill) => <section class="st-section" data-selected={inspectedCatalogItem()?.kind === "skill" && inspectedCatalogItem()?.id === skill.id ? "true" : undefined}>
        <h4>{skill.name}</h4><p>{skill.description}</p>
        <button type="button" class="rl-btn" aria-pressed={inspectedCatalogItem()?.kind === "skill" && inspectedCatalogItem()?.id === skill.id} onClick={() => setCatalogSelection({ kind: "skill", id: skill.id })}>Inspect skill</button>
        <Show when={props.options.sessionID}><button type="button" class="rl-btn" disabled={actions.blocked() || !catalogData()} onClick={() => void activateSkill(skill)}>Load skill</button></Show>
        <button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.insert} onClick={() => insert(`$${skill.name} `)}>Mention ${skill.name}</button>
      </section>}</For>
      <For each={rows(data()?.sessionSkills)}>{(skill) => <section class="st-section"><p>{word(field(skill, "name")) ?? word(field(skill, "id"))} · {word(field(skill, "state"))} · {word(field(skill, "inactiveReason"))}</p><For each={skillConflicts(skill)}>{(loser) => <button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void actions.run(async () => { await api.manageSession({ kind: "resolve-skill-conflict", revision: data()!.revision, sessionID: props.options.sessionID!, winner: word(field(skill, "id"))!, loser }); snapshot.refetch() }, `Prefer ${word(field(skill, "id"))} over ${loser}?`)}>Prefer this skill over {loser}</button>}</For></section>}</For></div>
      <section class="desktop-agent-inspector" aria-label="Catalog item details"><h3>Inspection</h3><Show when={inspectedCatalogItem()} fallback={<p>Select an agent or skill to inspect its reported details.</p>}>{item => <><h4>{item().name}</h4><p>{item().description ?? "No description reported."}</p><dl class="rl-meta"><dt>Kind</dt><dd>{item().kind}</dd><dt>ID</dt><dd>{item().id}</dd><Show when={item().kind === "agent"}><dt>Mode</dt><dd>{word(field(item(), "mode"))}</dd></Show></dl><Show when={item().kind === "skill"}><h4>Session state</h4><For each={rows(data()?.sessionSkills).filter(skill => field(skill, "id") === item().id)} fallback={<p class="st-muted">No Session state reported for this skill.</p>}>{skill => <DisplaySnapshot value={skill} />}</For></Show></>}</Show></section></div>
    </Show>
    <Show when={tab() === "Browser"}><div class="desktop-system-grid">
      <section class="st-section" aria-label="Paired browser"><h3>Paired browser</h3><DisplaySnapshot value={data()?.browser} /><h4>Tabs</h4><DisplaySnapshot value={data()?.browserTabs} /><div class="ws-row"><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "browser-start" })}>Start pairing</button><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "browser-forget" })}>Forget browser</button></div></section>
      <section class="st-section" aria-label="Isolated browser"><h3>Isolated browser</h3><DisplaySnapshot value={data()?.isolatedBrowser} /><h4>Tabs</h4><DisplaySnapshot value={data()?.isolatedBrowserTabs} /><label class="rl-field"><span>Start URL</span><input type="url" value={url()} onInput={(event) => setURL(event.currentTarget.value)} /></label><div class="ws-row"><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "isolated-browser-start", url: url() })}>Start isolated browser</button><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => void manage({ ...base(), kind: "isolated-browser-stop" })}>Stop isolated browser</button></div></section>
    </div></Show>
    <Show when={tab() === "Remote & Pairing"}><section class="st-section" aria-label="Browser pairing"><h3>Pairing</h3><Show when={data()?.pairing} fallback={<p>No pairing secret has been issued in this dialog.</p>}>{(pairing) => <><code aria-label="Pairing secret">{pairingRevealed() ? pairing().secret : "••••••••••••••••"}</code><p>Expires {new Date(pairing().expiresAt).toLocaleString()}</p><div class="desktop-dialog__toolbar"><button type="button" class="rl-btn" aria-pressed={pairingRevealed()} onClick={() => setPairingRevealed(!pairingRevealed())}>{pairingRevealed() ? "Hide pairing secret" : "Reveal pairing secret"}</button><button type="button" class="rl-btn" onClick={() => { setPairingCopy(undefined); setPairingCopyError(undefined); void copyTextToClipboard(pairing().secret).then(() => setPairingCopy("Pairing secret copied"), cause => setPairingCopyError(failure(cause, "The pairing secret could not be copied."))) }}>Copy pairing secret</button></div><Show when={pairingCopy()}><p role="status">{pairingCopy()}</p></Show><Show when={pairingCopyError()}><p role="alert">{pairingCopyError()}</p></Show></>}</Show><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data()} onClick={() => { setPairingRevealed(false); setPairingCopy(undefined); setPairingCopyError(undefined); void manage({ ...base(), kind: "browser-start" }) }}>Pair browser</button></section><section class="st-section" aria-label="Remote Session relay"><h3>Remote relay</h3><DisplaySnapshot value={data()?.remote} /><div class="desktop-dialog__toolbar"><For each={[true, false]}>{(enabled) => <button type="button" class="rl-btn" disabled={actions.blocked() || !data()} onClick={() => void manage({ ...base(), kind: "remote-set", enabled })}>{enabled ? "Enable remote access" : "Disable remote access"}</button>}</For></div></section></Show>
    <Show when={tab() === "Plugins"}><section class="st-section" aria-label="Plugins"><h3>Plugins</h3><DisplaySnapshot value={data()?.plugins} /><p>Plugin discovery is read-only. Configure plugin changes in ycoding.json and restart the backend.</p></section></Show>
    <Show when={tab() === "Browser"}><div class="desktop-dialog__actions"><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data() || field(data()?.isolatedBrowser, "state") !== "ready"} onClick={() => void manage({ ...base(), kind: "isolated-browser-pause" })}>Pause isolated browser</button><button type="button" class="rl-btn" disabled={actions.blocked() || !props.options.sessionID || !data() || field(data()?.isolatedBrowser, "state") !== "paused"} onClick={() => void manage({ ...base(), kind: "isolated-browser-resume" })}>Resume isolated browser</button></div></Show>
    <Show when={tab() === "Dots"}>
      <section class="st-section" aria-label="Dots computer access"><h3>Dots computer access</h3><DisplaySnapshot value={data()?.dots} />
      <p>Dots access and computer attachment are separate from the remote Session relay.</p>
      <button type="button" class="rl-btn" disabled={actions.blocked() || !data() || dotsRevision() === undefined || typeof field(field(data()?.dots, "access"), "enabled") !== "boolean"} onClick={() => void manage({ ...base(), kind: "dots-set", enabled: !field(field(data()?.dots, "access"), "enabled"), expectedRevision: dotsRevision()! })}>{field(field(data()?.dots, "access"), "enabled") ? "Disable Dots access" : "Enable Dots access"}</button>
      <label class="rl-field"><span>Replace other computer attachments</span><input type="checkbox" checked={replaceAttachments()} disabled={actions.blocked()} onChange={(event) => setReplaceAttachments(event.currentTarget.checked)} /></label>
      <button type="button" class="rl-btn" disabled={actions.blocked() || !data() || !field(field(data()?.dots, "access"), "enabled") || field(field(data()?.dots, "computer"), "state") !== "detached" || (field(field(data()?.dots, "computer"), "target") !== undefined && !dotsTarget())} onClick={() => void manage({ ...base(), kind: "dots-attach", replaceOthers: replaceAttachments(), ...(dotsTarget() ? { expectedTarget: dotsTarget()! } : {}) })}>Attach this computer</button>
      <button type="button" class="rl-btn" disabled={actions.blocked() || !data() || !field(field(data()?.dots, "access"), "enabled") || field(field(data()?.dots, "computer"), "state") !== "attached" || (field(field(data()?.dots, "computer"), "target") !== undefined && !dotsTarget())} onClick={() => void manage({ ...base(), kind: "dots-detach", ...(dotsTarget() ? { expectedTarget: dotsTarget()! } : {}) })}>Detach this computer</button>
      </section>
    </Show></section>
  </DesktopDialog>
}

type SessionTool = "shell" | "editor" | "sidechat" | "steer-parent" | "assist" | "terminals"

function SessionToolsDialog(props: { sessionID: string; parentID?: string; editorContext: ReturnType<typeof createEditorContext>; initial: SessionTool; initialText?: string; initialAssist?: "prediction" | "generation"; running: boolean; hasRevert: boolean; text: () => string; update: (text: string) => void; onOpen: (id: string) => void; onClose: () => void }) {
  const sessionID = props.sessionID
  let alive = true
  onCleanup(() => { alive = false })
  const actions = dialogActions(() => alive && props.sessionID === sessionID)
  const [tab, setTab] = createSignal<SessionTool>(props.initial)
  const [text, setText] = createSignal(props.initialText ?? (props.initial === "assist" ? props.text() : ""))
  const [notice, setNotice] = createSignal<string>()
  const [generated, setGenerated] = createSignal<{ readonly text: string; readonly goal: boolean }>()
  const [mode, setMode] = createSignal<"start" | "steer" | "queue" | "goal">("start")
  const [memory, setMemory] = createSignal<readonly MemoryScope[]>([])
  const [sideChoice, setSideChoice] = createSignal<ModelChoice>()
  const [sideID] = createSignal(`ses_${crypto.randomUUID()}`)
  const [sidePromptID] = createSignal(`msg_${crypto.randomUUID()}`)
  const [ptyID, setPtyID] = createSignal<string>()
  const models = observe(() => ({ queryKey: ["models", ...scope(), sessionID] as const, queryFn: () => api.models(sessionID), enabled: reading() && tab() === "sidechat" }))
  const modelData = () => { const value = models.result().isError ? undefined : currentSnapshot(models.result().data, connection().revision); return value && "current" in value && value.source.sessionID === sessionID ? value : undefined }
  const modelList = () => visibleModels(modelData()?.models ?? [], modelData()?.current ?? modelData()?.default)
  const choice = () => sideChoice() ?? choiceFor(modelList(), modelData()?.current ?? modelData()?.default)
  const sideModel = () => selectionFor(modelList(), choice())
  createEffect(on(() => JSON.stringify([scope(), modelData()?.current]), () => setSideChoice(undefined)))
  const terminals = observe(() => ({ queryKey: ["terminals", ...scope(), sessionID] as const, queryFn: () => api.terminals({ sessionID }), enabled: reading() && tab() === "terminals" }))
  const terminalData = () => terminals.result().isError ? undefined : currentSnapshot(terminals.result().data, connection().revision, sessionID)
  const terminal = observe(() => ({ queryKey: ["terminal", ...scope(), sessionID, ptyID()] as const, queryFn: () => api.terminal({ sessionID, ptyID: ptyID()! }), enabled: reading() && tab() === "terminals" && !!ptyID() }))
  const pty = () => terminal.result().isError ? undefined : currentSnapshot(terminal.result().data, connection().revision, sessionID)?.item
  const request = () => {
    const revision = connection().revision
    if (revision === undefined || actions.blocked() || props.hasRevert) return undefined
    return { sessionID, revision }
  }
  const refreshTools = () => { actions.reset(); if (tab() === "terminals") { terminals.refetch(); if (ptyID()) terminal.refetch() } else if (tab() === "sidechat") models.refetch(); refresh(["messages", ...scope(), sessionID]); refresh(["pendingInputs", ...scope(), sessionID]) }
  const submit = async () => {
    const base = request(), value = text(), tool = tab()
    if (!base || tool !== "sidechat" && !value.trim() || tool === "shell" && props.running) return
    const outcome = await actions.run(async () => {
      if (tool === "shell") { await api.runShell({ ...base, command: value }); return "Shell command requested. Check Activity for its outcome." }
      if (tool === "editor") { const admitted = await api.sendEditorContext({ ...base, promptID: `msg_${crypto.randomUUID()}`, text: value }); if (admitted.type === "compaction") throw new Error("The editor-context admission did not match the submitted input."); return `Editor context admitted for ${admitted.delivery}.` }
      if (tool === "steer-parent") { const admitted = await api.steerParent({ ...base, promptID: `msg_${crypto.randomUUID()}`, text: value }); if (admitted.type === "compaction") throw new Error("The parent-message admission did not match the submitted input."); return `Parent message admitted for ${admitted.delivery}.` }
      if (tool === "sidechat") {
        if (sideChoice() && !sideModel()) throw new Error("Choose a valid side-chat model.")
        const child = await api.openSideChat({ parentID: sessionID, sessionID: sideID(), revision: base.revision, ...(sideChoice() ? { model: sideModel()! } : {}), ...(value.trim() ? { text: value, promptID: sidePromptID() } : {}) })
        return child
      }
      throw new Error("Choose a submission action.")
    }, tool === "shell" ? `Run this shell command in the Session workspace?\n${value}` : tool === "editor" ? "Send this editor context to the Session?" : tool === "steer-parent" ? `Send this message to parent Session ${props.parentID}?` : "Open a side chat with the selected model and send its optional message?")
    if (!outcome) return
    refresh(["messages", ...scope(), sessionID]); refresh(["pendingInputs", ...scope(), sessionID]); refresh(["activity"]); refresh(["sessions"])
    if (typeof outcome === "string") { setNotice(outcome); setText("") }
    else { props.onClose(); props.onOpen(outcome.item.id) }
  }
  const generate = async (prediction: boolean) => {
    if (actions.blocked()) return
    const value = text(), selectedMode = mode()
    const result = await actions.run(async () => {
      if (prediction) { const result = await api.prediction({ sessionID, memory: memory(), ...(value.trim() ? { hint: value } : {}) }); return result.result }
      const result = await api.promptGenerate({ sessionID, mode: selectedMode, memory: memory(), intent: value })
      return result.result
    }, `${prediction ? "Predict a next prompt" : "Generate a prompt draft"} using this Session and ${memory().length ? memory().join(" and ") + " memory" : "no memory sources"}?`)
    if (!result) return
    if (result.status === "unavailable") { setNotice("No suggestion is available."); return }
    setGenerated({ text: result.text, goal: !prediction && selectedMode === "goal" }); setNotice(undefined)
  }
  const useGenerated = async () => {
    const value = generated()
    if (!value) return
    const changed = await actions.run(async () => { props.update(value.goal ? `/goal ${value.text}` : value.text); return true }, props.text().trim() ? "Replace the current composer draft with this generated text?" : undefined)
    if (changed) props.onClose()
  }
  const tabs: readonly { readonly value: SessionTool; readonly label: string }[] = [{ value: "shell", label: "Shell" }, { value: "editor", label: "Editor context" }, { value: "sidechat", label: "Side chat" }, ...(props.parentID ? [{ value: "steer-parent" as const, label: "Message parent" }] : []), { value: "assist", label: "Prompt assistance" }, { value: "terminals", label: "Terminals" }]
  return <DesktopDialog title="Session actions" kind="session" onClose={props.onClose}>
    <SharedRadioGroup label="Session action" value={tab()} options={tabs} disabled={actions.busy()} onChange={(value) => { if (!tabs.some((item) => item.value === value)) return; setTab(value as SessionTool); setText(""); setGenerated(undefined); setNotice(undefined) }} />
    <button type="button" class="rl-btn" disabled={actions.busy() || !reading()} onClick={refreshTools}>Refresh Session state</button>
    <Show when={props.hasRevert}><p role="alert">Resolve the staged revert before submitting new Session work.</p></Show>
    <Show when={actions.error()}><p role="alert">{actions.error()} The action may have completed; inspect Session history and Activity before submitting it again.</p></Show>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={tab() === "editor"}>
      <Show when={props.editorContext.notice()}>{(message) => <p role="status">{message()}</p>}</Show>
      <Show when={props.editorContext.selection()} fallback={<Show when={!props.editorContext.notice()}><p role="status">No IDE selection is reported.</p></Show>}>{(selection) => <section class="st-section" aria-label="Reported IDE selection"><h3>IDE selection</h3><p><code>{selection().filePath}</code></p><For each={selection().ranges}>{(range) => <pre class="rl-output"><code>{range.text}</code></pre>}</For><p class="st-muted">The composer controls whether this selection is included. Text entered below is sent separately.</p></section>}</Show>
    </Show>
    <Show when={tab() === "steer-parent"}><p>Target parent Session: <code>{props.parentID}</code></p></Show>
    <Show when={tab() !== "terminals"}>
      <label class="rl-field"><span>{tab() === "shell" ? "Shell command" : tab() === "editor" ? "Editor context" : tab() === "steer-parent" ? "Message for parent" : tab() === "sidechat" ? "Side-chat message (optional)" : "Prompt intent or prediction hint"}</span><textarea rows={6} value={text()} disabled={actions.busy()} onInput={(event) => setText(event.currentTarget.value)} /></label>
      <Show when={tab() === "sidechat"}>
        <p>The side chat uses the parent's model and profile unless a different listed selection is chosen.</p>
        <Show when={models.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading side-chat models…" /></Show>
        <Show when={modelData()}><ModelPopover chipLabel={sideChoice() ? sideModel()?.id ?? "Choose model" : "Inherit parent model"} models={modelList()} choice={choice()} onPick={setSideChoice} busy={actions.blocked()} onRefresh={models.refetch} refreshing={models.result().isFetching} /></Show>
        <Show when={models.result().isError}><p role="alert">{failure(models.result().error, "Side-chat models could not be read.")}</p></Show>
      </Show>
      <Show when={tab() !== "assist"}>
        <Show when={tab() === "shell" && props.running}><p role="status">Stop the running response before starting a shell command.</p></Show>
        <button type="button" class="rl-btn" disabled={actions.blocked() || props.hasRevert || tab() !== "sidechat" && !text().trim() || tab() === "shell" && props.running || tab() === "sidechat" && !!sideChoice() && !sideModel()} onClick={() => void submit()}>{tab() === "shell" ? "Run shell command" : tab() === "editor" ? "Send editor context" : tab() === "steer-parent" ? "Send to parent" : "Open side chat"}</button>
      </Show>
    </Show>
    <Show when={tab() === "assist"}>
      <Show when={props.initialAssist}><p>{props.initialAssist === "prediction" ? "Choose memory sources, then predict the next prompt." : "Choose the draft purpose and memory sources, then generate a prompt."}</p></Show>
      <SharedRadioGroup label="Generated prompt purpose" value={mode()} options={[{ value: "start", label: "Start" }, { value: "steer", label: "Steer" }, { value: "queue", label: "Queue" }, { value: "goal", label: "Goal" }]} disabled={actions.busy()} onChange={(value) => { if (value === "start" || value === "steer" || value === "queue" || value === "goal") setMode(value) }} />
      <fieldset><legend>Memory sources</legend><For each={["repository", "knowledge"] as const}>{(value) => <label class="request__choice"><input type="checkbox" checked={memory().includes(value)} disabled={actions.busy()} onChange={(event) => setMemory(event.currentTarget.checked ? [...memory(), value] : memory().filter((item) => item !== value))} /><span>{value === "repository" ? "Repository memory" : "Shared knowledge"}</span></label>}</For></fieldset>
      <div class="desktop-dialog__actions"><button type="button" class="rl-btn" disabled={actions.blocked()} onClick={() => void generate(true)}>Predict next prompt</button><button type="button" class="rl-btn" disabled={actions.blocked() || !text().trim()} onClick={() => void generate(false)}>Generate prompt draft</button></div>
      <Show when={generated()}>{(value) => <section class="st-section"><h3>Generated draft</h3><Markdown text={value().text} /><p>Using this draft does not send it or change the goal.</p><button type="button" class="rl-btn" disabled={actions.blocked()} onClick={() => void useGenerated()}>Use draft in composer</button></section>}</Show>
    </Show>
    <Show when={tab() === "terminals"}>
      <Show when={terminals.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading Session terminals…" /></Show>
      <Show when={terminals.result().isError}><p role="alert">{failure(terminals.result().error, "Session terminals could not be read.")}</p></Show>
      <Show when={terminalData()}>{(data) => <For each={data().items} fallback={<p>No terminals are attached to this Session.</p>}>{(item) => <button type="button" class="rl-option" aria-pressed={ptyID() === item.id} onClick={() => setPtyID(item.id)}><strong>{item.title || item.command}</strong><span>{item.status} · {item.cwd}</span></button>}</For>}</Show>
      <Show when={ptyID()}><Show when={terminal.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading terminal details…" /></Show><Show when={terminal.result().isError}><p role="alert">{failure(terminal.result().error, "Terminal details could not be read.")}</p></Show><Show when={pty()}>{(item) => <dl class="rl-meta"><dt>Command</dt><dd>{item().command} {item().args.join(" ")}</dd><dt>Directory</dt><dd>{item().cwd}</dd><dt>Status</dt><dd>{item().status}</dd><dt>Process</dt><dd>{item().pid}</dd><dt>Size</dt><dd>{item().size.cols} × {item().size.rows}</dd><Show when={item().exitCode !== undefined}><dt>Exit code</dt><dd>{item().exitCode}</dd></Show></dl>}</Show></Show>
      <Show when={ptyID()} keyed>{(id) => <Show when={pty()?.id === id ? pty() : undefined}>{(item) => <TerminalInspector api={api} info={item()} copy={copyTextToClipboard} />}</Show>}</Show>
    </Show>
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
    { id: "new-chat", group: "Session", label: "New chat", shortcut: keyboardHint("new"), icon: "plus", keywords: "create start conversation", run: () => void navigate({ to: "/chat" }) },
    { id: "refresh", group: "Session", label: "Refresh Sessions", icon: "refresh", keywords: "reload update list", run: () => refresh(["sessions"]) },
    ...desktopDestinations(location().pathname).filter((item) => !item.current).map((item): PaletteAction => ({
      id: `go-${item.id}`, group: "Navigation", label: `Go to ${item.label}`, icon: item.id === "projects" ? "team" : item.id === "sessions" ? "sessions" : item.id === "workspaces" ? "folder" : item.id === "usage" ? "usage" : "settings",
      detail: item.id === "projects" ? "Master and member Sessions" : item.id === "sessions" ? "Browse and filter Sessions" : item.id === "workspaces" ? "Folders and project copies" : item.id === "usage" ? "Requests, tokens and quotas" : "Machine and notification settings",
      keywords: `go to open page destination ${item.label.toLowerCase()}${item.id === "projects" ? " master member project" : ""}`,
      run: () => void navigate({ to: item.route }) })),
    ...railGroups(sessions.result().data?.items ?? [], activity(), currentSnapshot(sessions.result().data, connection().revision), executionStates()).groups.flatMap((group) => group.rows.map((row): PaletteAction => ({
      id: `open-${row.id}`, group: "Navigation", label: `Open ${row.title}`, detail: workspaceBase(row.location.directory), icon: row.time.pinned !== undefined ? "pin" : "sparkles", keywords: `${row.id} ${group.label} ${row.location.directory}`,
      run: () => void navigate({ to: "/sessions/$sessionID", params: { sessionID: row.id } }) }))),
    ...DESKTOP_THEMES.filter((theme) => theme.id !== themePreference()).map((theme): PaletteAction => ({
      id: `theme-${theme.id}`, group: "Customize", label: `Theme: ${theme.label}`, icon: theme.mode === "light" ? "sun" : theme.mode === "dark" ? "moon" : "monitor",
      detail: theme.description, keywords: "appearance color scheme dark light toggle theme customize",
      run: () => applyThemePreference(theme.id) })),
    ...DESKTOP_BUILT_IN_SLASH_COMMANDS.filter((command) => command.name !== "new" && (!sessionCommands.has(command.name) || !!commandOwner()?.sessionID) && (!["models", "editor", "prompt", "stash"].includes(command.name) || !!commandOwner()) && (command.name !== "btw-send" || commandOwner()?.canSendToParent?.())).map((command): PaletteAction => ({
      id: `command-${command.name}`, group: ["models", "variants", "agents", "skills"].includes(command.name) ? "Model & Agent" : ["diff", "workspaces", "move"].includes(command.name) ? "Workspace & Git" : ["connect", "mcp"].includes(command.name) ? "Providers & MCP" : ["settings", "keep-awake"].includes(command.name) ? "Settings" : sessionCommands.has(command.name) ? "Session" : "System",
      label: command.name === "connect" ? "Connect providers" : command.name === "diff" ? "Git working-tree diff" : command.description, detail: `/${command.name}`, icon: command.name === "mcp" ? "server" : command.name === "diff" ? "file" : command.name === "connect" ? "plug" : command.name === "models" || command.name === "variants" ? "cpu" : command.name === "agents" ? "user" : command.name === "skills" || command.name === "compact" || command.name === "toggle-thinking" ? "sparkles" : command.name === "autonomous" ? "shield" : command.name === "goal" ? "target" : command.name === "daybreak" ? "sun" : command.name === "timeline" ? "list" : command.name === "rename" ? "chat" : command.name === "fork" ? "git-fork" : command.name === "undo" ? "undo" : command.name === "redo" ? "redo" : command.name === "stash" ? "bookmark" : command.name === "find" ? "search" : command.name === "copy" ? "copy" : command.name === "export" ? "download" : command.name === "workspaces" || command.name === "move" ? "folder" : command.name === "projects" ? "team" : command.name === "sessions" ? "sessions" : command.name === "usage" || command.name === "status" ? "usage" : command.name === "settings" ? "settings" : command.name === "keep-awake" ? "zap" : command.name === "themes" ? "sun" : command.name === "browser" || command.name === "remote" ? "globe" : command.name === "plugins" ? "package" : command.name === "pair" ? "devices" : command.name === "help" ? "help" : "terminal", keywords: `${command.name} ${command.aliases?.join(" ") ?? ""}`,
      run: () => { const owner = commandOwner(); void (owner ? owner.run(command.name === "themes" ? "theme" : command.name, "") : commonCommand(command.name, "", {}, (to) => void navigate({ to }))).catch((cause) => setDesktopNotice(failure(cause, "The command was not confirmed."))) } })),
    { id: "branch-diff", group: "Workspace & Git", label: "Branch diff", icon: "git-branch", keywords: "git branch changes compare", run: () => { const owner = commandOwner(); void (owner ? owner.run("branch-diff", "") : commonCommand("branch-diff", "", {}, (to) => void navigate({ to }))).catch((cause) => setDesktopNotice(failure(cause, "Diff could not be opened."))) } },
    ...(commandOwner()?.sessionID ? (["archive", "unarchive", "delete"] as const).map((kind): PaletteAction => ({ id: `session-${kind}`, group: "Session", label: kind === "archive" ? "Archive Session" : kind === "unarchive" ? "Unarchive Session" : "Delete Session", icon: "sessions", keywords: kind, run: () => { void commandOwner()?.run(kind, "").catch((cause) => setDesktopNotice(failure(cause, "The Session change was not confirmed."))) } })) : []),
    ...(commandOwner()?.interactionActions?.() ?? []),
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
  onMount(watchDesktopViewport)
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
  const statusSnapshot = () => currentSnapshot(sessions.result().data, connection().revision)
  const grouped = createMemo(() => railGroups(items(), activity(), statusSnapshot(), executionStates()))
  const railProjects = observe(() => ({ queryKey: ["projects", ...scope()] as const, queryFn: () => api.projects(), enabled: reading() && items().length > 0 && typeof api.projects === "function" }))
  const railMembership = createMemo(() => {
    const result = railProjects.result().data
    if (!result || result.revision !== connection().revision) return new Map()
    return new Map(result.groups.flatMap((group) => [group.master, ...group.members].map((entry) => [entry.sessionID, group] as const)))
  })
  const [railFilter, setRailFilter] = createSignal<RailFilter>("all")
  const railRows = createMemo(() => grouped().groups.flatMap((group) => group.rows.map((session) => ({ session, state: railStateOf(group.key, session.id, statusSnapshot()) }))))
  const railCount = (filter: RailFilter) => railRows().filter((row) => railMatches(filter, row.state)).length
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
  const narrowWindow = window.matchMedia("(max-width: 1180px)")
  const [narrow, setNarrow] = createSignal(narrowWindow.matches)
  const sizing = () => setNarrow(narrowWindow.matches)
  narrowWindow.addEventListener("change", sizing)
  onCleanup(() => narrowWindow.removeEventListener("change", sizing))
  onMount(() => { try { const saved = Number(localStorage.getItem(LIST_WIDTH_KEY)); if (Number.isFinite(saved) && saved > 0) setListWidth(clampListWidth(saved, LIST_MIN_WIDTH, LIST_MAX_WIDTH)) } catch { setDesktopNotice("The Session list width could not be read.") } })
  const saveListWidth = (width: number) => { setListWidth(width); try { localStorage.setItem(LIST_WIDTH_KEY, String(width)) } catch { setDesktopNotice("The Session list width applies to this window but could not be saved.") } }
  const groupRows = (key: string) => grouped().groups.find((group) => group.key === key)?.rows.length ?? 0
  const railEntries = createMemo(() => new Map(railRows().map((row) => [row.session.id, row] as const)))
  const visibleGroups = createMemo<readonly SharedSessionGroup<string>[]>(() => railGroupPartitions(grouped().groups, scope(), (id) => railMembership().get(id)).map((group) => ({
    id: group.id, label: group.label, icon: railGroupIcons[group.key], hue: railGroupHues[group.key],
    items: group.rows.flatMap((session) => { const entry = railEntries().get(session.id); return entry && railMatches(railFilter(), entry.state) ? [session.id] : [] }),
  })))
  const conversationRoute = () => { const path = location().pathname; return path === "/chat" || path === "/sessions" || path.startsWith("/sessions/") }
  const activeSession = () => selected() ?? lastSession()
  const needsCount = () => groupRows("needs")
  const childCount = () => sessionGauge()?.children ?? 0
  const pathname = () => location().pathname
  const activityItems: readonly SharedActivityItem[] = [
    { id: "chat", label: "Chat", icon: "chat", get href() { const session = activeSession(); return session ? `#/sessions/${session}` : "#/chat" }, get current() { return conversationRoute() && !(selected() && teamOpen()) }, get badge() { const needs = needsCount(); return { count: needs, hue: "amber" as const, label: `${needs} ${needs === 1 ? "Session needs" : "Sessions need"} action` } } },
    { id: "team", label: "Team", icon: "team", get href() { const session = activeSession(); return session ? `#/sessions/${session}` : "#/sessions" }, get current() { return !!selected() && teamOpen() }, get description() { return activeSession() ? undefined : "Open a Session to see its Team" }, get badge() { const children = childCount(); return { count: children, hue: "mint" as const, label: `${children} active ${children === 1 ? "subagent" : "subagents"}` } } },
    { id: "projects", label: "Projects", icon: "folder", href: "#/projects", get current() { return pathname() === "/projects" } },
    { id: "workspaces", label: "Workspaces", icon: "monitor", href: "#/workspaces", get current() { return pathname() === "/workspaces" } },
    { id: "usage", label: "Usage", icon: "usage", href: "#/usage", get current() { return pathname() === "/usage" } },
    { id: "settings", label: "Settings", icon: "settings", href: "#/settings", get current() { return pathname() === "/settings" }, placement: "end" },
  ]
  const openDestination = (item: SharedActivityItem) => {
    const session = selected() ?? lastSession()
    if (item.id === "team") {
      if (!session) { void navigate({ to: "/sessions" }); return }
      setCompanionOpen(false)
      if (selected() === session) { setTeamOpen(true); return }
      teamRequested = true
      void navigate({ to: "/sessions/$sessionID", params: { sessionID: session } })
      return
    }
    if (item.id === "chat") {
      setTeamOpen(false)
      void (session ? navigate({ to: "/sessions/$sessionID", params: { sessionID: session } }) : navigate({ to: "/chat" }))
      return
    }
    const route = Object.entries({ projects: "/projects", workspaces: "/workspaces", usage: "/usage", settings: "/settings" } as const).find(([id]) => id === item.id)?.[1]
    if (route) void navigate({ to: route })
  }
  return <div class="rl-shell"><div class="workspace rl-app" data-companion-open={companionOpen() ? "true" : undefined} data-collapsed={railCollapsed() ? "true" : undefined}>
    <SharedActivityBar label="Destinations" brand={<Brand />} items={activityItems} onNavigate={openDestination} />
    <Show when={!railCollapsed()}><SharedListColumn id="session-rail" class="list-column rl-nav" label="Sessions" resize={{ width: listWidth() ?? (narrow() ? 256 : 280), min: LIST_MIN_WIDTH, max: LIST_MAX_WIDTH, label: "Resize Session list", onWidth: saveListWidth }}
      head={<div class="rl-list-head"><button type="button" class="rl-new-chat" aria-label="New chat" aria-keyshortcuts={keyboardAria("new")} onClick={() => void navigate({ to: "/chat" })}><Icon name="plus" /><span>New chat</span></button><Link to="/sessions" class="rl-icon-button" aria-label="Open Sessions overview" data-tooltip="Sessions overview"><Icon name="sessions" /></Link></div>}
      tools={<div class="rl-session-switcher"><label class="workspace__search rl-nav-search"><Icon name="search" /><input type="search" aria-label="Search sessions" value={railQuery()} placeholder="Search sessions" aria-invalid={term().error ? "true" : undefined} aria-describedby={term().error ? "rail-search-error" : undefined} onInput={(event) => setRailQuery(event.currentTarget.value)} /></label>
      <Show when={term().error}>{(message) => <p id="rail-search-error" role="alert" class="desktop__error">{message()}</p>}</Show>
      <div class="rl-rail-filters" role="group" aria-label="Filter Sessions by status"><For each={railFilters}>{(filter) => <button type="button" class="rl-rail-filter" aria-pressed={railFilter() === filter.value} aria-label={`${filter.label} ${railCount(filter.value)}`} onClick={() => setRailFilter(filter.value)}>{filter.shortLabel} <span>{railCount(filter.value)}</span></button>}</For><button type="button" class="rl-icon-button rl-rail-refresh" aria-label="Refresh Sessions" onClick={sessions.refetch} disabled={sessions.result().isFetching || !reading()}><Icon name="refresh" /></button></div></div>}
      foot={<Show when={state()?.next !== undefined || pagingNote() || pinNote()}><Show when={state()?.next !== undefined}><div class="workspace__list-foot"><span class="desktop__muted">{railRows().length} loaded · more</span><button type="button" class="workspace__more" disabled={loadingMore() || !reading()} onClick={() => void loadMore()}>{loadingMore() ? "Loading…" : "Load more"}</button></div></Show>
      <Show when={pagingNote()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
      <Show when={pinNote()}>{(result) => <p role={result().failed ? "alert" : "status"} class={result().failed ? "desktop__error" : "desktop__muted"}>{result().text}</p>}</Show></Show>}>
      <div class="rl-nav-scroll"><Show when={!sessions.result().isPending} fallback={<SharedLoadingSkeleton kind="list" label="Loading Sessions…" />}><Show when={!sessions.result().isError} fallback={<p role="alert" class="desktop__error">Sessions could not be read. Check the connection and refresh.</p>}>
        <Show when={railRows().length > 0 || grouped().archived > 0} fallback={<p role="status">{applied() ? "No Sessions match your search." : "No Sessions in this backend."}</p>}>
          <Show when={visibleGroups().some((group) => group.items.length)} fallback={<p role="status">{railFilter() === "all" ? "No Sessions to show." : "No Sessions match this filter."}</p>}>
            <SharedSessionGroups label="Sessions by state" idPrefix="rail-group" groups={visibleGroups()} row={(id) => <Show when={railEntries().get(id)}>{(row) => <div class="workspace__row"><Link to="/sessions/$sessionID" params={{ sessionID: row().session.id }} class="workspace__session rl-session-row" data-state={row().state} data-pinned={row().session.time.pinned !== undefined ? "true" : undefined} aria-label={`${row().session.title}, ${workspaceBase(row().session.location.directory)}, ${railStatusLabels[row().state]}`} aria-current={selected() === row().session.id ? "page" : undefined}><RailStatusIcon state={row().state} /><span class="rl-session-row-text"><span class="rl-session-row-title">{row().session.title}</span><span class="rl-session-row-meta">{workspaceBase(row().session.location.directory)}</span></span></Link>
              <button type="button" class="workspace__pin rl-icon-button" data-pinned={row().session.time.pinned !== undefined ? "true" : undefined} disabled={!reading() || pinning() !== undefined} aria-label={`${row().session.time.pinned === undefined ? "Pin" : "Unpin"} ${row().session.title}`} onClick={() => void togglePin(row().session)}><Icon name="pin" /></button></div>}</Show>} />
          </Show>
          <Show when={grouped().archived}><p class="desktop__muted">{grouped().archived} archived {grouped().archived === 1 ? "Session is" : "Sessions are"} hidden.</p></Show>
        </Show>
      </Show></Show>
      <p class="desktop__sr">Running and Waiting include confirmed backend family status and current live events. Unavailable earlier status remains unknown.</p></div>
    </SharedListColumn></Show>
    <div class="rl-content"><main id="remote-main" tabindex="-1" class="workspace__main rl-main">
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
    </main></div>
  </div></div>
}

const LIST_MIN_WIDTH = 232
const LIST_MAX_WIDTH = 360
const railGroupIcons = { needs: "hand", running: "zap", pinned: "pin", recent: "sessions" } as const
const railGroupHues = { needs: "amber", running: "mint", pinned: "green", recent: undefined } as const

type RailState = "waiting" | "running" | "failed" | "idle" | "unknown"
const railFilters = [{ value: "all", label: "All", shortLabel: "All" }, { value: "waiting", label: "Waiting", shortLabel: "Wait" }, { value: "running", label: "Running", shortLabel: "Run" }, { value: "idle", label: "Idle", shortLabel: "Idle" }] as const
type RailFilter = (typeof railFilters)[number]["value"]
const railStatusLabels = { waiting: "Waiting", running: "Running", failed: "Failed", idle: "Idle", unknown: "Status unknown" } as const
const railStateOf = (key: string, sessionID: string, snapshot?: Parameters<typeof sessionState>[2]): RailState => key === "needs" ? "waiting" : key === "running" ? "running" : sessionState(sessionID, activity(), snapshot, executionStates())
const railMatches = (filter: RailFilter, state: RailState) => filter === "all" || (filter === "idle" ? state === "idle" || state === "failed" : filter === state)
function ListToggle() {
  return <button type="button" class="rl-icon-button rl-list-toggle" aria-label={railCollapsed() ? "Show session list" : "Hide session list"} data-tooltip={railCollapsed() ? "Show session list" : "Hide session list"} aria-expanded={!railCollapsed()} aria-controls="session-rail" onClick={() => setRailCollapsed(!railCollapsed())}><Icon name="panel-left" /></button>
}
function RailStatusIcon(props: { state: RailState }) { return <span class="rl-rail-status" data-state={props.state} aria-hidden="true"><DesktopStateIndicator state={props.state} /></span> }

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
    if (event.key === "Tab") { if (!trigger?.parentElement?.querySelector(":modal")) setOpen(false); return }
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
  return <span class="desktop-select" data-flip={flip() ? "true" : undefined} data-align={alignEnd() ? "end" : undefined} onFocusOut={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button ref={trigger} type="button" class="desktop-select__trigger" role="combobox" aria-haspopup="listbox" aria-expanded={open()} aria-controls={open() ? id : undefined} aria-activedescendant={open() ? `${id}-${active()}` : undefined} aria-label={props.label} data-tooltip={props.label} disabled={props.disabled} onClick={() => open() ? setOpen(false) : show()} onKeyDown={move}><Show when={props.label === "Send mode"}><Icon name={props.value === "queue" ? "queue" : props.value === "steer" ? "steer" : "send"} /></Show><span>{selected()?.label ?? props.value}</span><Icon name="chevron-down" /></button>
    <Show when={open()}><ResponsiveLayer class="desktop-select__list" label={props.label} onClose={close}><div role="listbox" id={id} aria-label={props.label} tabindex="0" aria-activedescendant={`${id}-${active()}`} onKeyDown={event => { move(event); if (event.key !== "Tab") event.stopPropagation() }}><For each={props.options}>{(option, index) => <span id={`${id}-${index()}`} role="option" class="desktop-select__option" aria-selected={option.value === props.value} data-active={index() === active() ? "true" : undefined} onPointerMove={() => setActive(index())} onPointerDown={(event) => { event.preventDefault(); choose(index()) }}><span>{option.label}</span><Show when={option.value === props.value}><Icon name="check" /></Show><Show when={option.description}>{(text) => <small>{text()}</small>}</Show></span>}</For></div></ResponsiveLayer></Show>
  </span>
}

const localSlash = DESKTOP_BUILT_IN_SLASH_COMMANDS.flatMap((command) => [{ name: command.name, description: command.description }, ...(command.aliases ?? []).map((name) => ({ name, description: command.description }))])

type Suggestion = { readonly id: string; readonly icon: DesktopIconName; readonly label: string; readonly description?: string; readonly insert: string; readonly keepOpen?: boolean; readonly pick?: MentionPick }

let fieldIDs = 0
function ComposerField(props: { label: string; value: string; locked: boolean; onAttachFiles?: (added: readonly PromptFile[]) => void; source: string | { directory?: string } | undefined; directory: string; localCommands: readonly { readonly name: string; readonly description: string }[]; picks: readonly MentionPick[]; onPicks: (picks: MentionPick[]) => void; pasted: readonly PastedText[]; onPasted: (pasted: readonly PastedText[]) => void; onInput: (value: string) => void; onSubmit: () => void }) {
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
    const request = ++fileRequest
    const owner = scope().join(":")
    const source = props.source
    const directory = props.directory
    clearTimeout(fileTimer)
    setEntries([])
    setFilesError(false)
    setActive(0)
    if (!current) return
    setWanted(true)
    if (current.kind !== "mention" || !directory || !open() || !reading() || typeof api.findFiles !== "function") return
    fileTimer = setTimeout(() => { void (async () => {
      try { const found = await api.findFiles({ source, query: current.query }); if (request === fileRequest && scope().join(":") === owner && found.revision === connection().revision) { setEntries(found.entries); setFilesError(false) } }
      catch { if (request === fileRequest && scope().join(":") === owner) setFilesError(true) }
    })() }, 150)
  })
  onCleanup(() => { ++fileRequest; clearTimeout(fileTimer) })
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
    const next = placePaste({ text: props.value, pasted: props.pasted, start, end, clipboard: pasted, mode: pasteMode() })
    props.onPasted(next.pasted)
    props.onInput(next.text)
    setCaret(next.caret)
    queueMicrotask(() => { area?.focus(); area?.setSelectionRange(next.caret, next.caret) })
  }
  const [dropTarget, setDropTarget] = createSignal(false)
  const [transferProblem, setTransferProblem] = createSignal<string>()
  let transferEpoch = 0
  const editable = () => !props.locked && reading()
  createEffect(on(() => [props.locked, connection().revision, typeof props.source === "string" ? props.source : props.source?.directory], () => {
    transferEpoch++
    setDropTarget(false)
    setTransferProblem(undefined)
  }, { defer: true }))
  onCleanup(() => { transferEpoch++ })
  const attach = async (files: Promise<PromptFile[]>, epoch: number) => {
    setTransferProblem(undefined)
    try {
      const added = await files
      if (epoch === transferEpoch && editable() && area?.isConnected) {
        if (!added.length) throw new Error("No readable files were supplied.")
        props.onAttachFiles?.(added)
      }
    } catch (cause) {
      if (epoch === transferEpoch && editable()) setTransferProblem(failure(cause, "The attachments could not be read. Try again."))
    }
  }
  const paste = (event: ClipboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    event.preventDefault()
    if (!editable()) return
    const data = event.clipboardData
    const text = data?.getData("text/plain") ?? ""
    const hasFiles = data !== null && hasTransferFiles(data)
    const epoch = transferEpoch
    const target = event.currentTarget
    const start = target.selectionStart, end = target.selectionEnd, value = target.value
    if (text) insertPasted(text, start, end)
    if (hasFiles) void attach(transferredFiles(data), epoch)
    if (text || hasFiles || typeof api.readClipboard !== "function") return
    void api.readClipboard().then(snapshot => {
      if (epoch !== transferEpoch || !editable() || document.activeElement !== target || target.value !== value || target.selectionStart !== start || target.selectionEnd !== end) return
      if (snapshot.text) insertPasted(snapshot.text, start, end)
      if (snapshot.imageBase64) {
        const uri = `data:image/png;base64,${snapshot.imageBase64}`
        const bytes = inlineFileSize(uri)
        if (bytes === undefined || bytes > composerByteLimit) { setTransferProblem("The clipboard image is invalid or exceeds 20 MiB."); return }
        void attach(Promise.resolve([{ uri, name: "Clipboard image.png" }]), epoch)
      }
    }).catch(cause => { if (epoch === transferEpoch && editable()) setTransferProblem(failure(cause, "The clipboard could not be read. Try again.")) })
  }
  onMount(() => {
    const target = area?.closest(".rl-capsule")
    if (!target) return
    const drag = (event: Event) => {
      if (!(event instanceof DragEvent) || !hasTransferFiles(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = editable() ? "copy" : "none"
      setDropTarget(editable())
    }
    const leave = (event: Event) => {
      if (!(event instanceof DragEvent) || event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return
      setDropTarget(false)
    }
    const drop = (event: Event) => {
      setDropTarget(false)
      if (!(event instanceof DragEvent) || !event.dataTransfer || !hasTransferFiles(event.dataTransfer)) return
      event.preventDefault()
      if (editable()) void attach(transferredFiles(event.dataTransfer), transferEpoch)
    }
    target.addEventListener("dragenter", drag)
    target.addEventListener("dragover", drag)
    target.addEventListener("dragleave", leave)
    target.addEventListener("drop", drop)
    onCleanup(() => {
      target.removeEventListener("dragenter", drag)
      target.removeEventListener("dragover", drag)
      target.removeEventListener("dragleave", leave)
      target.removeEventListener("drop", drop)
    })
  })
  const copy = (event: ClipboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    const target = event.currentTarget
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? start
    const selected = props.value.slice(start, end)
    const expanded = expandPastedText(selected, props.pasted)
    if (expanded === selected || !event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData("text/plain", expanded)
    if (event.type !== "cut" || props.locked) return
    const next = insertTextAtSelection(props.value, start, end, "")
    props.onPasted(livePasted(next.text, props.pasted))
    props.onInput(next.text)
    setCaret(next.caret)
    queueMicrotask(() => { area?.focus(); area?.setSelectionRange(next.caret, next.caret) })
  }
  return <div class="composer-field" onFocusOut={(event) => {
    const next = event.relatedTarget
    if (open() && (!(next instanceof Node) || !event.currentTarget.contains(next))) setDismissed(token())
  }}><label class="desktop__field"><span class="desktop__sr">{props.label}</span><textarea ref={area} rows={1} wrap="off" value={props.value} readOnly={props.locked} role="combobox" aria-expanded={open()} aria-controls={open() ? listID : undefined} aria-activedescendant={open() && items()[active()] ? `${listID}-${active()}` : undefined} aria-autocomplete="list" aria-describedby="message-hint" placeholder="Message YCoding" onInput={(event) => { const value = event.currentTarget.value; if (props.pasted.length) props.onPasted(livePasted(value, props.pasted)); props.onInput(value); at(event) }} onKeyUp={at} onClick={at} onPaste={paste} onCopy={copy} onCut={copy}
    onKeyDown={(event) => {
      if (isStandardEditShortcut(event)) return
      if (open() && items().length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setActive((index) => (index + (event.key === "ArrowDown" ? 1 : items().length - 1)) % items().length); return }
      if (open() && items()[active()] && (event.key === "Enter" || event.key === "Tab") && !event.isComposing) { event.preventDefault(); choose(items()[active()]); return }
      if (event.key === "Enter" && open() && !event.isComposing) { event.preventDefault(); setDismissed(token()); return }
      if (event.key === "Escape" && open()) { event.preventDefault(); setDismissed(token()); return }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !props.locked) { event.preventDefault(); props.onSubmit() }
    }} />
    <span id="message-hint" class="desktop__sr">Enter sends. Shift+Enter adds a line. {keyboardHint("palette") ? `${keyboardHint("palette")} opens commands.` : "Use the Commands button to open commands."} Slash, dollar and at-sign open suggestions.</span></label>
    <Show when={dropTarget()}><div class="composer-drop-target" role="status"><Icon name="clip" />Drop files to attach</div></Show>
    <Show when={transferProblem()}>{problem => <p role="alert" class="desktop__error composer-transfer-error">{problem()}</p>}</Show>
    <Show when={open()}><div class="composer-suggestions" role="listbox" id={listID} aria-label="Composer suggestions"><For each={items()}>{(item, index) => <div id={`${listID}-${index()}`} role="option" class="composer-suggestion" aria-selected={index() === active()} onPointerMove={() => setActive(index())} onPointerDown={(event) => { event.preventDefault(); choose(item) }}><Icon name={item.icon} /><span class="composer-suggestion__label">{item.label}</span><Show when={item.description}>{(text) => <span class="composer-suggestion__desc">{text()}</span>}</Show></div>}</For><Show when={status()}>{(text) => <p class="composer-suggestions__status" role="status">{text()}</p>}</Show></div></Show></div>
}

function ModelPopover(props: { chipLabel: string; effortLabel?: string; disabled?: boolean; busy?: boolean; modelBusy?: boolean; models: readonly import("./contract").ModelOption[]; choice: ModelChoice; openTick?: number; onPick: (choice: ModelChoice) => void; onRefresh: () => void; refreshing: boolean; children?: JSX.Element }) {
  const [open, setOpen] = createSignal(false)
  const [recent, setRecent] = createSignal(readRecentModels())
  const [query, setQuery] = createSignal("")
  let chip: HTMLButtonElement | undefined
  let opener: HTMLButtonElement | undefined
  let wasTick = props.openTick ?? 0
  const show = (trigger?: HTMLButtonElement) => { revealComposerControls(trigger ?? chip); opener = trigger; setQuery(""); setOpen(true); queueMicrotask(() => { chip?.parentElement?.querySelector<HTMLInputElement>('.model-popover input[type="search"]')?.focus({ preventScroll: true }) }) }
  createEffect(() => { const tick = props.openTick ?? 0; if (tick !== wasTick) { wasTick = tick; show(chip) } })
  createEffect(() => { if (paletteOpen()) setOpen(false) })
  createEffect(() => {
    if (!open()) return
    const anchor = chip?.parentElement
    if (!anchor) return
    const measure = () => anchor.style.setProperty("--rl-model-anchor-top", `${anchor.getBoundingClientRect().top}px`)
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    const composer = anchor.closest(".rl-capsule")
    if (composer) observer.observe(composer)
    window.addEventListener("resize", measure)
    measure()
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
      anchor.style.removeProperty("--rl-model-anchor-top")
    })
  })
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
  const key = (model: ModelSelection) => `${model.providerID}\0${model.id}`
  const modelIndexes = createMemo(() => {
    const indexes = new Map<string, number>()
    props.models.forEach((model, index) => { const id = key(model); if (!indexes.has(id)) indexes.set(id, index) })
    return indexes
  })
  const ordered = createMemo(() => orderedModelOptions(props.models, recent(), selectionFor(props.models, props.choice)).flatMap((item) => {
    const index = modelIndexes().get(key(item))
    if (index === undefined) return []
    const label = modelLabel(props.models[index]!)
    const saved = item.recentSelection
    const selection = saved ? { model: index, profile: saved.profile ?? "", variant: saved.variant ?? "" } : chooseModel(props.models, index)
    return [{ index, label, searchLabel: label.toLowerCase(), recent: saved !== undefined, providerID: item.providerID, selection }]
  }))
  const filtered = createMemo(() => {
    const search = query().toLowerCase()
    let previous: { recent: boolean; providerID: string } | undefined
    return ordered().flatMap((row) => {
      if (!row.searchLabel.includes(search)) return []
      const groupHeading = !previous || previous.recent !== row.recent || !row.recent && previous.providerID !== row.providerID ? row.recent ? "Recent" : row.providerID : undefined
      previous = row
      return [{ ...row, groupHeading }]
    })
  })
  const close = () => { setOpen(false); (opener?.isConnected ? opener : chip)?.focus({ preventScroll: true }) }
  const toggle = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => { if (open()) close(); else show(event.currentTarget) }
  const pick = (choice: ModelChoice) => { const model = selectionFor(props.models, choice); if (model) setRecent(rememberRecentModel(undefined, model)); props.onPick(choice); close() }
  return <div class="composer-anchor" onFocusOut={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={(event) => {
    if (event.key === "Escape" && open()) { event.preventDefault(); close(); return }
    if (open() && (event.key === "ArrowDown" || event.key === "ArrowUp")) { const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".model-popover__option:not(:disabled)")]; if (options.length) { event.preventDefault(); const index = options.indexOf(document.activeElement as HTMLButtonElement); options[(index + (event.key === "ArrowDown" ? 1 : options.length - 1) + options.length) % options.length]?.focus() } }
  }}>
    <button ref={chip} type="button" class="composer-chip composer-chip--model" aria-label={props.chipLabel} data-tooltip={`Model · ${props.chipLabel}`} aria-haspopup="dialog" aria-expanded={open()} disabled={props.disabled} onClick={toggle}><Icon name="cpu" /><span>{props.chipLabel}</span><Icon name="chevron-down" /></button><Show when={props.effortLabel}>{(effort) => <button type="button" class="composer-chip composer-chip--effort" data-level={stops()[selectedIdx()]?.tone} aria-label={`Reasoning effort · ${effort()}`} data-tooltip={`Reasoning effort · ${effort()}`} aria-haspopup="dialog" aria-expanded={open()} disabled={props.disabled} onClick={toggle}><Icon name="sparkles" /><span class="composer-chip__effort">{effort().charAt(0).toUpperCase() + effort().slice(1)}</span></button>}</Show>
    <Show when={open()}><ResponsiveLayer class="desktop-popover model-popover" role="dialog" label="Model and reasoning effort" level={activeTone()} onClose={close}><div class="model-popover__heading"><strong>{selectedModel()?.name ?? "Choose model"}</strong><button type="button" class="rl-icon" aria-label="Close model settings" onClick={close}><Icon name="close" /></button></div>
      <label class="desktop__field model-popover__search"><span class="desktop__sr">Search models</span><input type="search" value={query()} placeholder="Search models" onInput={(event) => setQuery(event.currentTarget.value)} /></label>
      <div class="model-popover__list" role="listbox" aria-label="Model">
        <For each={filtered()}>{({ index, label, recent, selection, groupHeading }) => <><Show when={groupHeading}><h3 class="model-popover__group">{groupHeading}</h3></Show><button type="button" role="option" class="model-popover__option" aria-selected={props.choice.model === index && (!recent || props.choice.profile === selection.profile)} disabled={props.modelBusy ?? props.busy} onClick={() => pick(selection)}><span>{label}</span><Show when={props.choice.model === index}><Icon name="check" /></Show></button></>}</For>
        <Show when={!filtered().length}><p role="status" class="desktop__muted">No models match.</p></Show>
      </div>
      <Show when={selectedModel()?.profiles.length || props.choice.profile !== ""}><p class="model-popover__label">Profile</p><SharedRadioGroup label="Profile" options={[{ value: "", label: "No profile", disabled: !selectedModel()?.enabled }, ...(selectedModel()?.profiles ?? []).map((profile) => ({ value: profile.name, label: profileLabel(profile) }))]} value={props.choice.profile} disabled={props.modelBusy ?? props.busy} onChange={(value) => pick(chooseProfile(props.models, props.choice, value))} /></Show>
      <Show when={stops().length > 1 || props.choice.variant !== ""}><div class="model-slider__head"><p class="model-popover__label">Reasoning effort</p><strong class="model-slider__badge">{stops()[dragIndex() ?? selectedIdx()]?.label ?? "Default"}</strong><button type="button" class="rl-icon-button model-slider__reset" aria-label="Reset reasoning effort" disabled={props.choice.variant === "" || props.busy} onPointerDown={(event) => event.preventDefault()} onClick={() => { slider?.focus(); props.onPick({ ...props.choice, variant: "" }) }}><Icon name="reset" /></button></div><div class="model-slider" classList={{ "model-slider--dragging": !!drag() }} ref={(element) => { slider = element }} role="slider" tabindex="0" aria-label="Reasoning effort" aria-valuemin={0} aria-valuemax={stops().length - 1} aria-valuenow={selectedIdx()} aria-valuetext={stops()[selectedIdx()]?.label ?? "Default"} aria-disabled={props.busy} onKeyDown={(event) => { const next = event.key === "Home" ? 0 : event.key === "End" ? stops().length - 1 : event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? Math.min(stops().length - 1, selectedIdx() + 1) : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? Math.max(0, selectedIdx() - 1) : undefined; if (next === undefined) return; event.preventDefault(); event.stopPropagation(); applyStop(next) }} onPointerDown={startDrag}><div class="model-slider__track" style={{ "--composer-effort-fraction": String(fraction()), "--composer-effort-glow": String(glow()) }}><span class="model-slider__ticks" aria-hidden="true"><For each={stops()}>{(_, index) => <i style={{ left: `calc(14px + ${effortStopFraction(index(), stops().length)} * (100% - 28px))` }} />}</For></span><div class="model-slider__fill" style={{ width: `calc(28px + ${fraction()} * (100% - 28px))` }}><span class="model-slider__flow" aria-hidden="true" /><For each={[props.choice.variant]}>{() => <div class="model-slider__sparkles" aria-hidden="true"><For each={[...effortSparkles.map((sparkle) => ({ ...sparkle, x: sparkle.x / 2 })), ...effortSparkles.map((sparkle) => ({ ...sparkle, x: 50 + sparkle.x / 2 }))]}>{(sparkle) => <i style={{ left: `${sparkle.x}%`, top: `${sparkle.y}%`, "--composer-sparkle-delay": `${-sparkle.delay}s`, "--composer-sparkle-size": `${sparkle.size}px` }} />}</For></div>}</For></div><span class="model-slider__thumb" style={{ left: `calc(14px + ${fraction()} * (100% - 28px))` }} /></div></div><div class="model-slider__labels"><For each={stops()}>{(stop, index) => <button type="button" class="model-slider__label" data-edge={index() === 0 ? "start" : index() === stops().length - 1 ? "end" : undefined} style={index() === 0 ? { left: "0px" } : index() === stops().length - 1 ? { right: "0px" } : { left: `calc(14px + ${effortStopFraction(index(), stops().length)} * (100% - 28px))` }} disabled={props.busy} onPointerDown={(event) => event.preventDefault()} onClick={() => { slider?.focus(); applyStop(index()) }} data-active={selectedIdx() === index() ? "true" : undefined}>{stop.label}</button>}</For></div></Show>
      {props.children}
      <div class="model-popover__foot"><button type="button" class="rl-btn" disabled={props.refreshing} onClick={props.onRefresh}>Refresh models</button></div>
    </ResponsiveLayer></Show>
  </div>
}

export function promptFilesFor(attached: readonly PromptFile[], mentioned: readonly PromptFile[]) {
  return [...attached.filter((file) => !mentioned.some((mention) => mention.uri === file.uri)), ...mentioned]
}

function mergeTransferredFiles(current: readonly PromptFile[], added: readonly PromptFile[]) {
  const files = [...current, ...added.filter(file => !current.some(existing => existing.uri === file.uri && existing.name === file.name))]
  if (files.length > composerFileLimit || files.reduce((total, file) => total + (inlineFileSize(file.uri) ?? 0), 0) > composerByteLimit)
    throw new Error("A message can contain at most 20 files and 20 MiB of file data.")
  return files
}

const imageName = /\.(png|jpe?g|webp|gif)$/i
const isImageFile = (file: PromptFile) => /^data:image\//i.test(file.uri) || imageName.test(file.name ?? file.uri)

function AttachmentTile(props: { file: PromptFile; locked?: boolean; onRemove: () => void }) {
  const [broken, setBroken] = createSignal(false)
  const label = () => props.file.name ?? props.file.uri
  const remove = () => <button type="button" class="rl-icon" aria-label={`Remove ${label()}`} disabled={props.locked} onClick={props.onRemove}><Icon name="close" /></button>
  return <Show when={isImageFile(props.file) && !broken()} fallback={<span class="composer-attachments__chip"><Icon name="file" /><span>{label()}</span>{remove()}</span>}>
    <span class="composer-attachments__thumb"><img src={props.file.uri} alt={label()} title={label()} draggable={false} onError={() => setBroken(true)} />{remove()}</span>
  </Show>
}

function AttachButton(props: { directory?: string; files?: readonly PromptFile[]; onChange?: (files: PromptFile[]) => void; locked?: boolean }) {
  return <button type="button" class="rl-attach" aria-label="Attach files" disabled={props.locked || !props.onChange || !reading()} onClick={() => openFolderPicker({ title: "Attach workspace file", mode: "file", initialDirectory: props.directory, onPick: (path) => { const name = path.split("/").at(-1) ?? path; props.onChange?.(promptFilesFor(props.files ?? [], [{ uri: `file://${path}`, name }])) } })}><Icon name="clip" /></button>
}

function ComposerAttachments(props: { files: readonly PromptFile[]; onChange: (files: PromptFile[]) => void; locked: boolean }) {
  return <Show when={props.files.length}><div class="composer-attachments" aria-label="Attached workspace files"><For each={props.files}>{(file) => <AttachmentTile file={file} locked={props.locked} onRemove={() => props.onChange(props.files.filter(item => item !== file))} />}</For></div></Show>
}
function NewChat() {
  const telemetry = useDesktopTelemetry()
  const navigate = useNavigate()
  const [targetPickerOpen, setTargetPickerOpen] = createSignal(false)
  const workspaces = observe(() => ({ queryKey: ["workspaces", ...scope()] as const, queryFn: () => api.workspaces(), enabled: reading() }))
  const catalog = observe(() => ({ queryKey: ["new-chat-models", ...scope(), newDirectory().trim()] as const, queryFn: () => api.models({ directory: newDirectory().trim() }), enabled: reading() }))
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = createSignal(false)
  const [newPicks, setNewPicks] = createSignal<MentionPick[]>([])
  const [newRestoredAgents, setNewRestoredAgents] = createSignal<PromptAgent[]>([])
  const [files, setFiles] = createSignal<PromptFile[]>(newPending()?.files ?? [])
  const editorContext = createEditorContext({ api, directory: () => newDirectory().trim() || undefined, revision: () => connection().revision, enabled: reading })
  const [newModelTick, setNewModelTick] = createSignal(0)
  const newSlash = localSlash.filter((command) => { const parsed = desktopSlashCommand(`/${command.name}`, []); return parsed && (!sessionCommands.has(parsed.kind) || parsed.kind === "stash") })
  const [newAutonomy, setNewAutonomy] = createSignal<"" | "manual" | "auto" | "yolo">("")
  const [autonomyMenuOpen, setAutonomyMenuOpen] = createSignal(false)
  const [chosen, setChosen] = createSignal<ModelChoice>()
  const [newAgent, setNewAgent] = createSignal<{ readonly id: string; readonly name: string }>()
  createEffect(() => { void newDirectory(); void scope(); setChosen(undefined); setNewAgent(undefined) })
  const data = () => { const value = catalog.result().isError ? undefined : catalog.result().data; return value && !("sessionID" in value.source) && (value.source.directory ?? "") === newDirectory().trim() && value.revision === connection().revision ? value : undefined }
  const list = createMemo(() => visibleModels(data()?.models ?? [], data()?.default))
  const choice = () => chosen() ?? choiceFor(list(), data()?.default)
  const selected = () => list()[choice().model]
  const picked = () => data() ? selectionFor(list(), choice()) : undefined
  const selectedWorkspaceName = () => available().find((item) => item.directory === newDirectory())?.name ?? newDirectory()
  const setDirectory = (directory: string) => { if (!newPending()) { setNewDirectory(directory); setWorkspaceMenuOpen(false) } }
  const pickFolder = (mode: "directory" | "create-directory") => { setWorkspaceMenuOpen(false); openFolderPicker({ title: mode === "directory" ? "Open workspace folder" : "Create new workspace folder", mode, initialDirectory: newDirectory() || undefined, onPick: setDirectory }) }
  const runCommand = async (name: string, args: string) => {
    if (newPending()) return false
    if (name === "editor") { const owner = scope().join(":"), directory = newDirectory(); await editPrompt({ directory: directory || undefined, draft: () => ({ text: /^\/editor\s*$/.test(newText()) ? "" : expandPastedText(newText(), newPasted()), files: files(), agents: newRestoredAgents(), picks: newPicks() }), update: (draft) => { setNewText(draft.text); setNewPasted([...(draft.pasted ?? [])]); setFiles([...(draft.files ?? [])]); setNewRestoredAgents([...(draft.agents ?? [])]); setNewPicks([...(draft.picks ?? [])]) } }, () => scope().join(":") === owner && newDirectory() === directory && !newPending()); return true }
    if (name === "prompt") {
      if (!reading() || !(await confirmInPage("Create a Session to generate a prompt draft? No prompt is sent until you review and submit it."))) return false
      const owner = scope().join(":"), id = `ses_${crypto.randomUUID()}`
      await api.createSession({ sessionID: id, ...(newDirectory() ? { directory: newDirectory() } : {}) })
      if (scope().join(":") !== owner) throw new Error("The connection changed while creating the Session. Check Sessions before trying again.")
      setPendingAssistance({ sessionID: id, text: args })
      refresh(["sessions"])
      await navigate({ to: "/sessions/$sessionID", params: { sessionID: id } })
      return true
    }
    if (name === "models") { setNewModelTick((tick) => tick + 1); return true }
    if (name === "stash") { setStashDialog({ draft: () => ({ text: newText(), files: files(), agents: newRestoredAgents(), picks: newPicks(), pasted: livePasted(newText(), newPasted()) }), update: (draft) => { setNewText(draft.text); setNewPasted([...(draft.pasted ?? [])]); setFiles([...(draft.files ?? [])]); setNewRestoredAgents([...(draft.agents ?? [])]); setNewPicks([...(draft.picks ?? [])]) }, directory: newDirectory() || undefined }); return true }
    return commonCommand(name, args, { source: newDirectory() ? { directory: newDirectory() } : undefined, directory: newDirectory() || undefined, insert: (value) => setNewText((text) => text + value), chooseAgent: (agent) => { if (!newPending() && !busy()) setNewAgent(agent) } }, (to) => void navigate({ to }))
  }
  onMount(() => { const owner = { run: runCommand }; setCommandOwner(owner); onCleanup(() => { if (commandOwner() === owner) setCommandOwner(undefined) }) })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const available = () => workspaces.result().data ?? []
  const ready = () => !!newPending() || ((!newDirectory() || available().some((item) => item.directory === newDirectory()) || openedDirectories().has(newDirectory())) && !!newText().trim())
  const start = async () => {
    if (busy() || !reading() || !ready()) return
    let pendingCommand: { name: string; arguments?: string } | undefined
    const expanded = expandPastedPrompt(newText(), newPicks(), newPasted())
    if (!newPending() && /^\/[A-Za-z0-9]/.test(expanded.text)) {
      const catalogKey = ["composer-catalog", ...scope(), newDirectory().trim()] as const
      let cached = queries.getQueryData<ComposerCatalog>(catalogKey)
      if ((!cached || cached.revision !== connection().revision) && typeof api.composerCatalog === "function") {
        setBusy(true)
        try { const fresh = await api.composerCatalog(newDirectory().trim() ? { directory: newDirectory().trim() } : undefined); if (fresh.revision === connection().revision) { queries.setQueryData(catalogKey, fresh); cached = fresh } }
        catch { cached = undefined }
        finally { setBusy(false) }
      }
      const action = composerSlash(expanded.text, (cached?.commands ?? []).map((command) => command.name))
      if (action.kind === "backend") pendingCommand = { name: action.name, ...(action.args ? { arguments: action.args } : {}) }
      else if (action.kind === "local") {
        try { if (!(await runCommand(action.name, action.args))) { setError("Open a Session to use this command."); return } }
        catch (cause) { setError(failure(cause, "The command was not confirmed.")); return }
        if (action.name !== "editor") { setNewText(""); setNewPicks([]); setNewPasted([]) }
        return
      }
    }
    const mentioned = newPending() ? undefined : { files: expanded.files, agents: expanded.agents }
    const payload = mentioned ? { ...mentioned, files: promptFilesFor(files(), mentioned.files), agents: [...newRestoredAgents(), ...mentioned.agents] } : undefined
    const editor = !newPending() && !pendingCommand ? editorContext.capture() : undefined
    const draft = newPending() ?? { directory: newDirectory(), sessionID: `ses_${crypto.randomUUID()}`, promptID: `msg_${crypto.randomUUID()}`, text: expanded.text, ...(newAgent() ? { agent: newAgent()!.id } : {}), ...(pendingCommand ? { command: pendingCommand } : {}), ...(payload?.files.length ? { files: payload.files } : {}), ...(payload?.agents.length ? { agents: payload.agents } : {}), created: false, ...(chosen() && picked() && !sameSelection(picked(), data()?.default) ? { model: picked(), modelRevision: data()?.revision } : {}), ...(newAutonomy() ? { autonomy: newAutonomy() as "manual" | "auto" | "yolo", autonomyRevision: connection().revision } : {}) }
    const generation = connection().generation
    const captured = { ...draft, ...(editor ? { editor } : {}) }
    setNewPending(captured)
    setNewUnconfirmed(false)
    setBusy(true)
    setError(undefined)
    try {
      if (chosen() && !picked()) throw new Error("Select a valid model before starting the chat.")
      if (!draft.created) {
        await api.createSession({ sessionID: draft.sessionID, ...(draft.directory ? { directory: draft.directory } : {}), ...(draft.agent ? { agent: draft.agent } : {}) })
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
          if (!(await confirmInPage(autonomyPrompt({ permissions: draft.autonomy, guardrails: draft.autonomy, answers: draft.autonomy }, `Set permissions, guardrails and answers to ${draft.autonomy} before sending?`)))) return
          setNewPending({ ...newPending()!, created: true, autonomyAttempted: true })
          const changed = await api.setAutonomy({ sessionID: draft.sessionID, revision, payload: { permissions: draft.autonomy, guardrails: draft.autonomy, answers: draft.autonomy } })
          if (connection().generation !== generation || connection().revision !== revision) return
          if (changed.revision !== revision || changed.sessionID !== draft.sessionID || changed.autonomy.permissions !== draft.autonomy || changed.autonomy.guardrails !== draft.autonomy || changed.autonomy.answers !== draft.autonomy) throw new Error("Autonomy was not confirmed. Open the Session and review its state before sending.")
        }
        setNewPending({ ...newPending()!, created: true, autonomyAttempted: true, autonomyApplied: true })
      }
      const admittedAt = performance.now(), admissionOwner = scope().join(":")
      const context = newPending()?.editor
      if (context) {
        await api.sendEditorContext({ sessionID: draft.sessionID, revision: connection().revision!, promptID: context.promptID, text: context.text })
        if (connection().generation !== generation) return
        editorContext.markSent(context.key)
      }
      if (draft.command) await api.command({ sessionID: draft.sessionID, promptID: draft.promptID, command: draft.command.name, ...(draft.command.arguments ? { arguments: draft.command.arguments } : {}), ...(draft.agent ? { agent: draft.agent } : {}), ...(draft.model ? { model: draft.model } : {}), ...(draft.files?.length ? { files: draft.files } : {}), ...(draft.agents?.length ? { agents: draft.agents } : {}) })
      else await api.prompt({ sessionID: draft.sessionID, promptID: draft.promptID, text: draft.text, ...(draft.files ? { files: draft.files } : {}), ...(draft.agents ? { agents: draft.agents } : {}) })
      if (admissionOwner === scope().join(":")) telemetry.record("prompt.admit", performance.now() - admittedAt)
      if (connection().generation !== generation) return
      setNewPending(undefined)
      setNewPicks([])
      setNewPasted([])
      setNewRestoredAgents([])
      setFiles([])
      setNewText("")
      await navigate({ to: "/sessions/$sessionID", params: { sessionID: draft.sessionID } })
    } catch (cause) { if (connection().generation === generation) setError(failure(cause, "The chat was not confirmed. Check Recent Sessions, then retry.")) }
    finally { setBusy(false) }
  }
  return <section class="conversation" data-new-chat aria-labelledby="new-chat-title"><SharedConversationHeader class="rl-top" menu={<ListToggle />} actions={<div class="rl-top-actions"><SharedContextRingButton class="rl-context-ring" ariaLabel="Open Session context" expanded={companionOpen() && companionTab() === "Context"} label={<><strong>Unknown</strong><small>—</small></>} onClick={() => { setCompanionTab("Context"); setCompanionOpen(true) }} /><button type="button" class="rl-icon rl-companion-toggle" aria-label={companionOpen() ? "Close Session companion" : "Open Session companion"} aria-expanded={companionOpen()} onClick={() => setCompanionOpen(!companionOpen())}><Icon name="team" /></button><CommandMenuButton /></div>}><div class="rl-ident"><h1 id="new-chat-title" class="rl-title" tabindex="-1" ref={focusHeading}>New chat</h1><p class="rl-presence" data-tone="idle"><span>This Mac · {newDirectory() || "No workspace selected"} · {connectionOwnership()}</span></p></div></SharedConversationHeader><div class="rl-scroll"><div class="rl-col rl-thread"><div class="rl-intro"><Brand /><p class="rl-intro-title">Start a conversation.</p>
    <div class="rl-starter-commands" aria-label="Starter commands"><For each={newSlash.filter(command => ["help", "connect", "mcp"].includes(command.name))}>{command => <button type="button" class="rl-btn" aria-label={`Draft /${command.name}`} disabled={!!newPending() || busy() || !!newText()} onClick={() => { setNewText(`/${command.name} `); document.querySelector<HTMLTextAreaElement>('[data-new-chat] .rl-capsule textarea')?.focus() }}>/{command.name}</button>}</For></div>
    <p class="desktop__muted">No Project or filesystem Workspace is required. Start standalone, or explicitly add a workspace for context.</p><Show when={!available().length}><div class="desktop__actions"><button type="button" class="rl-btn" disabled={!!newPending() || busy()} onClick={() => pickFolder("directory")}><Icon name="folder" />Open folder…</button><button type="button" class="rl-btn" disabled={!!newPending() || busy()} onClick={() => pickFolder("create-directory")}><Icon name="folder-plus" />New folder…</button></div></Show><div class="rl-menu-anchor" onKeyDown={(event) => { if (event.key === "Escape") { setWorkspaceMenuOpen(false); event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus() } else if (event.key === "ArrowDown" || event.key === "ArrowUp") { const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]; if (items.length) { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length]?.focus() } } }}><button type="button" class="rl-btn" aria-haspopup="menu" aria-expanded={workspaceMenuOpen()} disabled={!!newPending()} onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen())}><Icon name="folder" />{newDirectory().trim() ? `Context · ${selectedWorkspaceName()}` : "Context · No workspace"}</button><Show when={workspaceMenuOpen()}><ResponsiveLayer class="rl-owned-menu" role="menu" label="Workspace context" onClose={() => setWorkspaceMenuOpen(false)}><button type="button" role="menuitem" onClick={() => pickFolder("directory")}><Icon name="folder" />Open folder…</button><button type="button" role="menuitem" onClick={() => pickFolder("create-directory")}><Icon name="folder-plus" />New folder…</button><button type="button" role="menuitem" onClick={() => setDirectory("")}><span><strong>Standalone · no filesystem context</strong><small>Start without a repository</small></span></button><For each={available()}>{(item) => <button type="button" role="menuitem" onClick={() => setDirectory(item.directory)}><span><strong>{item.name && item.name !== item.directory ? item.name : workspaceBase(item.directory)}</strong><small>{item.directory}</small></span></button>}</For><button type="button" role="menuitem" class="rl-textlink" onClick={workspaces.refetch} disabled={workspaces.result().isFetching || !reading()}>Refresh repositories</button></ResponsiveLayer></Show></div><p class="rl-prototype-note">{newDirectory().trim() ? `Selected workspace · ${selectedWorkspaceName() === newDirectory() ? newDirectory() : `${selectedWorkspaceName()} (${newDirectory()})`}.` : "No filesystem workspace is selected unless you choose one. Server-default placement applies until you pick a repository."}</p></div></div></div>
    <div class="rl-dock"><div class="rl-col"><DesktopComposerSurface formClass="composer" busy={busy()} onSubmit={(event) => { event.preventDefault(); void start() }} feedback={null} field={<div class="rl-capsule" data-composer-frame>
      <div class="desktop-target-anchor"><button type="button" class="desktop-target-trigger" disabled={!!newPending() || busy() || !reading()} aria-haspopup="dialog" aria-expanded={targetPickerOpen()} onClick={() => { setWorkspaceMenuOpen(false); setTargetPickerOpen(!targetPickerOpen()) }}><Icon name="folder" /><span>Target Workspace / Worktree</span><Icon name="chevron-down" /></button>
      <Show when={targetPickerOpen()}><WorkspaceTargetPicker directory={newDirectory()} locked={!!newPending() || busy()} onApply={directory => { if (directory) setOpenedDirectories(previous => new Set(previous).add(directory)); setDirectory(directory); setTargetPickerOpen(false); document.querySelector<HTMLButtonElement>('.desktop-target-anchor > button')?.focus() }} onBrowse={() => { setTargetPickerOpen(false); document.querySelector<HTMLButtonElement>('.desktop-target-anchor > button')?.focus(); pickFolder("directory") }} onClose={() => { setTargetPickerOpen(false); document.querySelector<HTMLButtonElement>('.desktop-target-anchor > button')?.focus() }} /></Show></div>
      <ComposerField label="First message" value={newPending()?.text ?? newText()} locked={!!newPending() || busy()} source={newDirectory().trim() ? { directory: newDirectory().trim() } : undefined} directory={newDirectory().trim()} localCommands={newSlash} picks={newPicks()} onPicks={setNewPicks} pasted={newPasted()} onPasted={setNewPasted} onInput={setNewText} onSubmit={() => void start()} onAttachFiles={(added) => setFiles((current) => mergeTransferredFiles(current, added))} />
      <ComposerAttachments files={files()} onChange={setFiles} locked={!!newPending() || busy()} />
      <Show when={catalog.result().isError}><span role="alert" class="desktop__error">{failure(catalog.result().error, "Model catalog could not be read. Refresh models to retry.")}</span></Show>
      <ComposerToolbar class="composer-bar" leading={<AttachButton directory={newDirectory() || undefined} files={files()} onChange={setFiles} locked={!!newPending() || busy()} />} trailing={<button type="submit" class="rl-send desktop__primary" aria-label={busy() ? "Starting the chat" : newPending() ? "Retry starting the chat" : "Send prompt"} disabled={busy() || !reading() || !ready()}><Icon name="arrow-up" /></button>}>
        <Show when={data()} fallback={<button type="button" class="composer-chip" disabled><span>{picked()?.id ?? "Model"}</span></button>}><ModelPopover chipLabel={selected()?.name ?? picked()?.id ?? data()?.default?.id ?? "Choose a model"} effortLabel={choice().variant || undefined} busy={!!newPending() || !reading()} models={list()} choice={choice()} openTick={newModelTick()} onPick={setChosen} onRefresh={catalog.refetch} refreshing={catalog.result().isFetching}><Show when={choiceProblem(list(), choice())}>{(problem) => <p role="status" class="desktop__muted">{problem()}</p>}</Show></ModelPopover></Show>
        <div class="rl-menu-anchor rl-autonomy" onFocusOut={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setAutonomyMenuOpen(false) }} onKeyDown={(event) => { if (event.key === "Escape" && autonomyMenuOpen()) { setAutonomyMenuOpen(false); event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus() } else if (event.key === "ArrowDown" || event.key === "ArrowUp") { const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]; if (items.length) { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length]?.focus() } } }}><button type="button" class="composer-chip" aria-haspopup="menu" aria-expanded={autonomyMenuOpen()} disabled={!!newPending() || typeof api.setAutonomy !== "function"} onClick={(event) => { const anchor = event.currentTarget.parentElement; const opening = !autonomyMenuOpen(); setAutonomyMenuOpen(opening); if (opening) queueMicrotask(() => anchor?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()) }}><span>Autonomous {stagedAutonomyLabels[newAutonomy()]}</span></button><Show when={autonomyMenuOpen()}><ResponsiveLayer class="rl-owned-menu" label="Staged autonomy" role="menu" onClose={() => setAutonomyMenuOpen(false)}><For each={autonomyChoices}>{(mode) => <button type="button" role="menuitemradio" aria-checked={newAutonomy() === mode} onClick={(event) => { const trigger = event.currentTarget.closest(".rl-autonomy")?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]'); setNewAutonomy(mode); setAutonomyMenuOpen(false); trigger?.focus() }}><span>{stagedAutonomyLabels[mode]}</span></button>}</For></ResponsiveLayer></Show></div>
      </ComposerToolbar></div>} /><Show when={newUnconfirmed()}><p role="status">The previous attempt was not confirmed before the connection changed. Check Sessions before sending again.</p></Show>
      <div class="desktop__feedback">
        <Show when={newPending()?.agent ?? newAgent()?.name}>{(agent) => <p role="status">Active agent for new chat: {agent()}</p>}</Show>
        <GlobalRequests directory={newDirectory().trim() || undefined} />
        <EditorContextControl context={editorContext} disabled={!!newPending() || busy()} />
        <Show when={newRestoredAgents().length}><div class="composer-attachments" aria-label="Restored agent attachments"><For each={newRestoredAgents()}>{(agent) => <span class="composer-attachments__chip"><Icon name="user" /><span>{agent.name}</span><button type="button" class="rl-icon" aria-label={`Remove agent ${agent.name}`} disabled={!!newPending() || busy()} onClick={() => setNewRestoredAgents((agents) => agents.filter((item) => item !== agent))}><Icon name="close" /></button></span>}</For></div></Show>
        <Show when={workspaces.result().isPending && reading()}><SharedLoadingSkeleton kind="list" label="Loading previously opened repositories…" /></Show>
        <Show when={workspaces.result().isError}><p role="alert" class="desktop__error">Previously opened repositories could not be read. Refresh to retry.</p></Show>
        <Show when={workspaces.result().isSuccess && !available().length}><p role="status">No previously opened folders are available. Choose Open folder or New folder to add workspace context.</p></Show>
      </div>
      <div class="desktop__feedback"><Show when={error()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show><Show when={busy()}><p role="status">Starting the chat…</p></Show></div>
      <div class="desktop__actions"><Show when={newPending() && !busy()}><button type="button" onClick={() => { setNewText(newPending()?.text ?? ""); setNewPasted([]); setNewPending(undefined); setError(undefined) }}>Edit draft</button></Show></div></div></div>
    <Show when={companionOpen()}><aside class="rl-companion" aria-label="Session companion"><DesktopCompanion active={companionTab().toLowerCase() as "activity" | "running" | "changes" | "context"} onSelect={(tab) => setCompanionTab(tab === "activity" ? "Activity" : tab === "running" ? "Running" : tab === "changes" ? "Changes" : "Context")} headerActions={<button type="button" class="rl-icon" aria-label="Close companion" onClick={() => setCompanionOpen(false)}><Icon name="close" /></button>} activityContent={<p class="rl-pane-body">Activity is available after a Session starts.</p>} changesContent={<p class="rl-pane-body">No Session changes are available yet.</p>} contextContent={<p class="rl-pane-body">Context is not reported until a response is available.</p>} /></aside></Show>
  </section>
}

export function autonomyPrompt(payload: SetAutonomyInput["payload"], prompt: string) {
  if (![payload.permissions, payload.guardrails, payload.answers].includes("yolo")) return prompt
  return `${prompt} YOLO approves every request in each selected YOLO category, bypassing permission limits, hard policies and custom rules. Answers settle automatically. Actions can modify or delete data, send messages, spend money or affect real systems. You accept all resulting risks and assume full responsibility. Accept these risks and enable YOLO?`
}

export function autonomyLabels(view: { readonly goal?: { readonly text: string; readonly status: string } | null; readonly effective: { readonly permissions: string; readonly guardrails: string; readonly answers: string; readonly deferred: boolean } } | undefined) {
  if (!view) return { goal: "Goal · Unknown", autonomy: "Autonomy · Unknown" }
  const mode = view.effective
  const label = mode.permissions !== mode.guardrails || mode.guardrails !== mode.answers ? "Mixed" : mode.permissions === "manual" ? "Manual" : mode.permissions === "auto" ? "Auto" : "YOLO"
  return { goal: view.goal ? `Goal · ${view.goal.status === "active" ? "Active" : view.goal.status}` : "Goal · Off", autonomy: `Autonomy · ${label} · Defer ${mode.deferred ? "on" : "off"}` }
}

export function autonomyMatches(view: { readonly permissions: string; readonly guardrails: string; readonly answers: string; readonly goal?: { readonly text: string; readonly status?: string; readonly maxNoProgress?: number } | null; readonly defer?: object | null }, payload: SetAutonomyInput["payload"]) {
  if (payload.permissions != null && view.permissions !== payload.permissions) return false
  if (payload.guardrails != null && view.guardrails !== payload.guardrails) return false
  if (payload.answers != null && view.answers !== payload.answers) return false
  if ((typeof payload.goal === "string" || payload.goal === true) && (!view.goal?.text.trim() || view.goal.status !== "active")) return false
  if ("goal" in payload && payload.goal === null && view.goal != null && view.goal.status !== "stopped") return false
  if (payload.maxNoProgress != null && view.goal?.maxNoProgress !== payload.maxNoProgress) return false
  if (typeof payload.defer === "boolean" && Boolean(view.defer) !== payload.defer) return false
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
  return parts.map((part) => ({
    id: part.id,
    name: part.name,
    status: part.state.status === "error" ? "failed" as const : part.state.status,
    summary: toolDisplaySummary(part.name, part.state.input),
    markdown: part.name === "subagent" || part.name === "question",
    inputText: typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input, null, 2),
    duration: part.time.completed === undefined ? undefined : formatDurationMs(Math.max(0, part.time.completed - part.time.created)),
    ...(part.state.status === "streaming" ? {} : { outputText: part.state.content.flatMap((entry) => entry.type === "text" ? [entry.text] : []).join("\n") }),
    ...(part.state.status === "error" ? { errorText: part.state.error.message } : {}),
  }))
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
  return promptTicks(messages, (message) => {
    if (message.type === "user") return { id: message.id, text: message.text }
    const steer = dotSteerDisplay(message)
    return steer === undefined ? undefined : { id: message.id, text: steer.text }
  })
}

function DesktopComposerSurface(props: { readonly formClass: string; readonly busy: boolean; readonly hasFeedback?: boolean; readonly onSubmit: (event: SubmitEvent) => void; readonly field: JSX.Element; readonly feedback: JSX.Element }) {
  return <form class={props.formClass} aria-busy={props.busy} onSubmit={props.onSubmit}><Show when={props.hasFeedback}><div class="composer__feedback">{props.feedback}</div></Show>{props.field}</form>
}

function PendingTray(props: { readonly items: readonly { readonly id: string; readonly text: string; readonly delivery: "steer" | "queue" }[]; readonly busy?: string; readonly note?: string; readonly onRemove: (id: string) => void; readonly onSteer: (id: string) => void }) {
  const [expanded, setExpanded] = createSignal(false)
  return <Show when={props.items.length}><section class="pending-tray" aria-label="Pending messages" data-expanded={expanded() ? "true" : undefined}>
    <button type="button" class="pending-tray__toggle" aria-expanded={expanded()} aria-controls="pending-tray-list" onClick={() => setExpanded(!expanded())}><Icon name="queue" /><strong>{props.items.length} pending</strong><Show when={!expanded()}><PendingPreview class="pending-tray__preview" text={props.items[0]!.text} /></Show><Icon name={expanded() ? "chevron-down" : "chevron-up"} /></button>
    <Show when={expanded()}><ol id="pending-tray-list" class="pending-tray__list"><Keyed each={props.items} by={item => item.id}>{(item) => <li class="pending-tray__item"><PendingPreview class="pending-tray__text" text={item().text} />
      <button type="button" class="rl-icon-button" aria-label="Steer now" data-tooltip="Steer now" disabled={props.busy !== undefined || item().delivery === "steer"} onClick={() => props.onSteer(item().id)}><Icon name="steer" /></button>
      <button type="button" class="rl-icon-button pending-tray__delete" aria-label="Delete" data-tooltip="Delete" disabled={props.busy !== undefined} onClick={() => props.onRemove(item().id)}><WebIcon name="trash" size={16} /></button></li>}</Keyed></ol></Show>
    <Show when={props.note}>{(note) => <p role="status" class="pending-tray__note">{note()}</p>}</Show>
  </section></Show>
}

function desktopContentMotion(element: HTMLElement, closing = false) {
  if (!animationsEnabled() || matchMedia("(prefers-reduced-motion: reduce)").matches) return
  const styles = getComputedStyle(element)
  const duration = styles.getPropertyValue(closing ? "--yc-dur-quick" : "--yc-motion-spatial-dur").trim()
  const milliseconds = parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000)
  if (!milliseconds) return
  const easing = styles.getPropertyValue(closing ? "--yc-ease-exit" : "--yc-ease-entrance").trim()
  const distance = styles.getPropertyValue("--yc-space-1").trim()
  const animation = element.animate(closing ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${distance})` }] : [{ opacity: 0, transform: `translateY(${distance})` }, { opacity: 1, transform: "none" }], { duration: milliseconds, easing })
  const preference = matchMedia("(prefers-reduced-motion: reduce)")
  const changed = () => { if (preference.matches) animation.finish() }
  const cleanup = () => preference.removeEventListener("change", changed)
  preference.addEventListener("change", changed)
  void animation.finished.then(cleanup, cleanup)
  return animation
}

function createDesktopDisclosure(initiallyOpen: boolean) {
  const [expanded, setExpanded] = createSignal(initiallyOpen)
  const [present, setPresent] = createSignal(initiallyOpen)
  let body: HTMLDivElement | undefined
  let motion: Animation | undefined
  const settle = () => { motion?.cancel(); motion = undefined; setPresent(expanded()) }
  const toggle = (trigger: HTMLElement) => {
    motion?.cancel()
    motion = undefined
    const opening = !expanded()
    if (!opening && body?.contains(document.activeElement)) trigger.focus({ preventScroll: true })
    setExpanded(opening)
    if (opening) setPresent(true)
    const run = () => {
      if (!body || expanded() !== opening) return
      body.inert = !opening
      const animation = desktopContentMotion(body, !opening)
      motion = animation
      if (!animation) { setPresent(opening); return }
      void animation.finished.then(() => { if (motion === animation) { motion = undefined; setPresent(expanded()) } }, () => {})
    }
    if (opening) queueMicrotask(run)
    else run()
  }
  onMount(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)")
    const changed = () => { if (preference.matches) settle() }
    preference.addEventListener("change", changed)
    onCleanup(() => { preference.removeEventListener("change", changed); motion?.cancel() })
  })
  createEffect(() => { if (!animationsEnabled()) settle() })
  return { expanded, present, toggle, ref: (element: HTMLDivElement) => { body = element } }
}

function DesktopToolEvidence(props: { readonly label: string; readonly text: string; readonly markdown?: boolean }) {
  const [notice, setNotice] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const copy = async () => {
    setNotice(undefined); setError(undefined)
    try { await copyTextToClipboard(props.text); setNotice(`${props.label} copied`) }
    catch (cause) { setError(failure(cause, `${props.label} could not be copied.`)) }
  }
  return <section class="desktop-tool-evidence"><header><strong>{props.label}</strong><button type="button" class="rl-icon-button" aria-label={`Copy ${props.label.toLowerCase()}`} data-tooltip={`Copy ${props.label.toLowerCase()}`} onClick={() => void copy()}><Icon name="copy" /></button></header><Show when={props.markdown} fallback={<pre><code>{props.text}</code></pre>}><Markdown text={props.text} /></Show><Show when={notice()}>{text => <p role="status">{text()}</p>}</Show><Show when={error()}>{text => <p role="alert">{text()}</p>}</Show></section>
}

function DesktopToolDisclosure(props: { readonly tools: ReturnType<typeof toolSteps>; readonly lastSummary?: string; readonly streaming: boolean; readonly durationLabel?: string; readonly app?: (callID: string, text: string) => JSX.Element }) {
  const disclosure = createDesktopDisclosure(false)
  const id = `desktop-tools-${createUniqueId()}`
  const failed = () => props.tools.filter(tool => tool.status === "failed").length
  return <section class="transcript-tools rl-tools" data-desktop-activity="tools"><button type="button" class="transcript-tools__button rl-disclosure-head" aria-expanded={disclosure.expanded()} aria-controls={id} onClick={event => disclosure.toggle(event.currentTarget)}><span class="rl-disclosure-icon"><Icon name="terminal" /></span><span class="rl-disclosure-label">{props.streaming ? "Running" : "Ran"} {formatCount(props.tools.length)} tool{props.tools.length === 1 ? "" : "s"}<Show when={failed()}> · {formatCount(failed())} failed</Show></span><span class="rl-disclosure-summary">{props.lastSummary}</span><span class="rl-disclosure-time">{props.durationLabel}</span><span class="rl-disclosure-chev"><Icon name="chevron-right" /></span></button><Show when={disclosure.present()}><div id={id} ref={disclosure.ref} class="rl-disclosure-body" inert={!disclosure.expanded()} aria-hidden={!disclosure.expanded()}><div class="rl-tools-card"><Keyed each={props.tools} by={tool => tool.id}>{tool => <article class="rl-step-card" data-status={tool().status}><header class="rl-step-head"><span class="rl-step-icon"><DesktopStateIndicator state={tool().status === "completed" ? "idle" : tool().status === "failed" ? "failed" : "running"} /></span><strong>{tool().name}</strong><span class="rl-step-summary">{tool().summary}</span><span class="rl-step-meta">{tool().status}{tool().duration ? ` · ${tool().duration}` : ""}</span></header><Show when={tool().inputText}>{text => <DesktopToolEvidence label="Input" text={text()} />}</Show><Show when={tool().outputText}>{text => <DesktopToolEvidence label="Output" text={text()} markdown={tool().markdown} />}</Show>
    <Show when={tool().status === "completed" && disclosure.expanded()}>{props.app?.(tool().id, tool().outputText ?? "")}</Show>
    <Show when={tool().errorText}>{text => <div class="rl-step-error" role="alert"><DesktopToolEvidence label="Error" text={text()} /></div>}</Show></article>}</Keyed></div></div></Show></section>
}

function DesktopReasoningDisclosure(props: { readonly defaultOpen: boolean; readonly text: string; readonly streaming: boolean; readonly durationLabel?: string }) {
  const disclosure = createDesktopDisclosure(props.defaultOpen)
  const id = `desktop-reasoning-${createUniqueId()}`
  return <details class="transcript-reasoning rl-reason" data-desktop-activity="reasoning" open={disclosure.present()}><summary class="rl-disclosure-head" aria-expanded={disclosure.expanded()} aria-controls={id} onClick={event => { event.preventDefault(); disclosure.toggle(event.currentTarget) }}><span class="rl-disclosure-icon"><Icon name="sparkles" /></span><span class="rl-disclosure-label">{props.streaming ? "Thinking" : "Thought"}</span><span class="rl-disclosure-time">{props.durationLabel}</span><span class="rl-disclosure-chev"><Icon name="chevron-right" /></span></summary><Show when={disclosure.present()}><div id={id} ref={disclosure.ref} class="transcript-reasoning__body rl-disclosure-body" inert={!disclosure.expanded()} aria-hidden={!disclosure.expanded()}><Markdown text={props.text} /></div></Show></details>
}

async function copyMessage(text: string) {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try { await navigator.clipboard.writeText(text); return } catch { /* the native clipboard below handles denied page access */ }
  }
  await copyTextToClipboard(text)
}

function CopyMessageButton(props: { readonly text: string }) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const copy = async () => {
    try { await copyMessage(props.text) } catch { setDesktopNotice("The message could not be copied."); return }
    setCopied(true)
    clearTimeout(timer)
    timer = setTimeout(() => setCopied(false), 1500)
  }
  return <button type="button" class="rl-icon-button transcript-message__copy" aria-label="Copy message" data-copied={copied() ? "true" : undefined} data-tooltip={copied() ? "Copied" : "Copy message"} onClick={() => void copy()}><Icon name={copied() ? "check" : "copy"} /><span class="desktop__sr" role="status">{copied() ? "Copied" : ""}</span></button>
}

const deliveryLabels = { sending: "Sending", sent: "Sent", read: "Read by YCoding" } as const

function DeliveryStatus(props: { readonly state: keyof typeof deliveryLabels; readonly time: number }) {
  const time = () => new Date(props.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return <span class="transcript-message__delivery" role="img" data-state={props.state} aria-label={deliveryLabels[props.state]} title={`${deliveryLabels[props.state]} · ${time()}`}>
    <Show when={props.state === "sending"}><span class="delivery-dots" aria-hidden="true"><i /><i /><i /></span></Show>
    <Show when={props.state === "sent"}><Icon name="check" /></Show>
    <Show when={props.state === "read"}><Icon name="check-all" /></Show>
  </span>
}

function SentImage(props: { readonly sessionID: string; readonly file: { readonly name?: string; readonly content: { readonly digest: string } } }) {
  const attachment = observe(() => ({ queryKey: ["attachment", ...scope(), props.sessionID, props.file.content.digest] as const, queryFn: () => api.sessionAttachment({ sessionID: props.sessionID, digest: props.file.content.digest }), enabled: reading() }))
  const source = () => { const file = attachment.result().data; return file ? `data:${file.mime};base64,${file.data}` : undefined }
  const name = () => props.file.name ?? "Image attachment"
  const [open, setOpen] = createSignal(false)
  return <Show when={source()} fallback={<span class="conversation__chip">{name()}</span>}>{(url) => <>
    <button type="button" class="transcript-message__image-button" aria-label={`Open image ${name()}`} aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setOpen(true) }}><img class="transcript-message__image" src={url()} alt={name()} draggable={false} /></button>
    <Show when={open()}><DesktopDialog title={`Image: ${name()}`} kind="image" onClose={() => setOpen(false)}><img class="desktop-image-preview" src={url()} alt={name()} draggable={false} /></DesktopDialog></Show>
  </>}</Show>
}

function DotOrigin(props: { readonly steer: boolean }) {
  return <><span class="transcript-message__origin" role="img" aria-label="ChatGPT" title="Sent via ChatGPT" style={{ "--origin-mark": `url("${openaiMark}")` }} /><Show when={props.steer}><span class="transcript-message__steer">Steer</span></Show></>
}

function dotsDelivery(metadata: unknown) {
  const input = field(metadata, "dotsInput")
  const delivery = field(input, "delivery")
  return field(input, "origin") === "dots-native" && (delivery === "steer" || delivery === "queue") ? delivery : undefined
}

function intermediateAssistant(message: Messages[number] | undefined): message is Extract<Messages[number], { type: "assistant" }> {
  if (message?.type !== "assistant" || message.error || message.retry || message.content.length === 0) return false
  if (message.finish === "stop" || message.finish === "length" || message.finish === "content-filter" || message.finish === "error") return false
  return !message.content.some(part => part.type === "text" && part.text.length > 0)
}

function RecallTurn(props: { record: TranscriptRecord }) {
  const view = () => { const record = props.record; return record.kind === "recall" ? <RecallEntryView entry={record.entry} /> : <LifecycleEntryView entry={record.entry} /> }
  return <li class="transcript__turn rl-sys" data-speaker="recall" data-layout="block"><SharedMessageTurn kind="recall" recall={view()} /></li>
}

function TurnView(props: { sessionID: string; message: Messages[number]; continuation?: boolean; delivery?: keyof typeof deliveryLabels; onDelete: (id: string) => Promise<string | undefined>; onOpenApp?: (app: OpenMcpApp) => void }) {
  const duration = (start: number, end?: number) => end === undefined ? undefined : `${Math.max(0, Math.round((end - start) / 1000))}s`
  const role = () => props.message.type
  const externalPeer = () => dotsPeerLabel(props.message.metadata)
  const peerInput = () => externalPeer() && (props.message.type === "user" || props.message.type === "synthetic") ? props.message : undefined
  const syntheticCard = () => props.message.type === "synthetic" && !peerInput() ? classifyDesktopSynthetic(props.message) : undefined
  const steer = () => { const card = syntheticCard(); return card?.kind === "dot-steer" ? card : undefined }
  const layout = () => {
    if (peerInput()) return "activity"
    const type = role()
    if (type === "model-switched" || type === "agent-switched" || type === "skill") return "pill"
    const card = syntheticCard()
    return card && (card.kind === "completion" || card.kind === "note") ? "pill" : "block"
  }
  return <li id={`turn-${props.message.id}`} class={`transcript__turn ${role() === "user" || steer() !== undefined ? "rl-me" : role() === "assistant" ? "rl-them" : "rl-sys"}`} data-speaker={role()} data-layout={layout()} tabindex={role() === "user" || steer() !== undefined ? -1 : undefined}>
    <Show when={peerInput()}>{message => {
      const files = () => { const input = message(); return input.type === "user" ? input.files : undefined }
      return <><span class="transcript-message__author desktop__sr">External peer</span><NativeActivityRow label={dotsPeerLabel({ dots: field(props.message.metadata, "dots") }) ? "Dots" : "Remote MCP"} identity={externalPeer()} time={message().time.created}><Markdown text={message().text} /><For each={files()}>{file => <span class="conversation__chip">{file.name ?? "Attachment"}</span>}</For></NativeActivityRow></>
    }}</Show>
    <Show when={!peerInput() && externalPeer()}>{value => <NativeActivityRow label="External peer" identity={value()}>{value()}</NativeActivityRow>}</Show>
    <Show when={props.message.type === "user" && !peerInput() ? props.message : undefined}>{(message) => {
      const images = () => message().files?.filter((file) => file.mime.startsWith("image/")) ?? []
      const dots = () => dotsDelivery(message().metadata)
      return <SharedMessageTurn kind="user" markdownText={message().text} bubbleAttachments={images().length || dots() ? <><Show when={dots()}>{(delivery) => <DotOrigin steer={delivery() === "steer"} />}</Show><Show when={images().length}><div class="transcript-message__images"><For each={images()}>{(file) => <SentImage sessionID={props.sessionID} file={file} />}</For></div></Show></> : undefined} attachments={<>
        <For each={message().files?.filter((file) => !file.mime.startsWith("image/"))}>{(file) => <span class="conversation__chip">{file.name ?? "Attachment"}</span>}</For>
        <div class="transcript-message__meta"><Show when={message().metadata?.inputOrigin === "direct"}><MessageDelete eligible={message().time.consumed === undefined && props.delivery !== "sending"} onDelete={() => props.onDelete(message().id)} /></Show><CopyMessageButton text={message().text} /><DeliveryStatus state={props.delivery ?? "sent"} time={message().time.created} /></div>
      </>} />
    }}</Show>
    <Show when={steer()}>{(entry) => <SharedMessageTurn kind="synthetic" content={<div class="transcript-message--user" aria-label="Dot steer prompt"><div class="transcript-message__bubble" data-origin="chatgpt"><DotOrigin steer /><div class="transcript-message__bubble-text"><Markdown text={entry().text} /></div></div><div class="transcript-message__meta"><CopyMessageButton text={entry().text} /></div></div>} />}</Show>
    <Show when={props.message.type === "assistant" ? props.message : undefined}>{(message) => {
      const groups = createMemo(() => groupAssistantParts(message().content))
      const identity = () => <SharedTurnHead class="transcript-message__head" mark={<span class="rl-avatar transcript-message__mark"><Icon name="sparkles" /></span>}>{message().agent} · {message().model.providerID}/{message().model.id}{message().model.variant ? ` · ${message().model.variant}` : ""}{message().model.profile === undefined ? "" : ` · Profile ${message().model.profile}`}{duration(message().time.created, message().time.completed) ? ` · ${duration(message().time.created, message().time.completed)}` : ""}</SharedTurnHead>
      return <SharedMessageTurn kind="assistant" head={<Show when={props.continuation} fallback={identity()}><details class="desktop-step-provenance" aria-label="Step provenance"><summary>Step provenance</summary>{identity()}<dl><dt>Message</dt><dd>{message().id}</dd><dt>Created</dt><dd>{new Date(message().time.created).toLocaleString()}</dd><Show when={message().time.completed}>{completed => <><dt>Completed</dt><dd>{new Date(completed()).toLocaleString()}</dd></>}</Show><Show when={message().finish}>{finish => <><dt>Finish</dt><dd>{finish()}</dd></>}</Show></dl></details></Show>} body={<>
        <Keyed each={groups()} by={(group) => group.key}>{(group) => {
          const reasoning = () => { const value = group(); return value.kind === "reasoning" ? value : undefined }
          const text = () => { const value = group(); return value.kind === "text" ? value : undefined }
          const tools = () => { const value = group(); return value.kind === "tools" ? toolDisclosures(value.parts, presentation().grouping) : [] }
          return <>
            <Show when={reasoning()}>{(value) => <For each={[thinkingExpanded()]}>{() => <DesktopReasoningDisclosure defaultOpen={thinkingExpanded()} text={value().text} streaming={!message().time.completed} durationLabel={value().created !== undefined ? duration(value().created!, value().completed) : undefined} />}</For>}</Show>
            <Show when={text()}>{(value) => <div class="transcript-message__text rl-bubble"><Markdown text={value().text} /></div>}</Show>
            <Keyed each={tools()} by={(parts) => parts[0]!.id}>{(parts) => <><DesktopToolDisclosure tools={toolSteps(parts())} lastSummary={parts().at(-1) ? toolDisplaySummary(parts().at(-1)!.name, parts().at(-1)!.state.input) : undefined} streaming={parts().some((part) => part.state.status === "running" || part.state.status === "streaming")} durationLabel={presentation().grouping === "auto" ? duration(message().time.created, message().time.completed) : undefined}
              app={(callID, text) => <Show when={reading() && props.onOpenApp}><McpAppResult scope={JSON.stringify([connection().revision, props.sessionID])} text={text}
                  load={async () => {
                    const revision = connection().revision
                    return revision === undefined ? undefined : api.mcpAppView({ revision, sessionID: props.sessionID, messageID: message().id, callID })
                  }}
                onOpen={(app) => props.onOpenApp?.(app)} /></Show>} /><IntelligentUiTurnCards parts={parts()} /></>}</Keyed>
          </>
        }}</Keyed>
        <Show when={message().time.completed !== undefined ? assistantReplyText(message().content) : undefined}>{(reply) => <div class="transcript-message__meta"><CopyMessageButton text={reply()} /></div>}</Show>
        <Show when={groups().length === 0 && !message().error && message().time.completed !== undefined}><p class="transcript__notice">{message().content.some((part) => part.type === "reasoning") ? "Reasoning is not shown for this response." : "No visible content in this response."}</p></Show>
      </>} error={<Show when={message().error}>{(error) => <p role="alert" class="desktop__error">{error().message}</p>}</Show>} />
    }}</Show>
    <Show when={props.message.type === "shell" ? props.message : undefined}>{(message) => <SharedMessageTurn kind="shell" shellHeader={<><code class="ws-card-title">$ {message().command}</code> · {message().status}{message().exit === undefined ? "" : ` · exit ${message().exit}`}</>} shellOutput={<div class="ws-shell"><pre class="ws-out"><code>{message().output?.output ?? ""}</code></pre><Show when={message().output?.truncated}><p>Shell output is truncated.</p></Show></div>} />}</Show>
    <Show when={props.message.type === "compaction" ? props.message : undefined}>{(message) => <SharedMessageTurn kind="compaction" compaction={<CompactionView message={message()} />} />}</Show>
    <Show when={props.message.type === "system" ? props.message : undefined}>{(message) => <SharedMessageTurn kind="system" content={<><span class="transcript__speaker">System</span><div class="transcript-system-card"><Markdown text={message().text} /></div></>} />}</Show>
    <Show when={syntheticCard() && syntheticCard()!.kind !== "dot-steer" ? syntheticCard() : undefined}>{(card) => card().kind === "member" ? <Show when={card().kind === "member" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "member" }> : undefined}>{(entry) => <article class="transcript-notice-card" data-kind="member" data-status={entry().event}><header class="transcript-notice-card__head"><Icon name={entry().event === "failed" ? "alert" : "team"} /><strong>{entry().label}</strong><span class="transcript-notice-card__status">{entry().event}</span><Link to="/sessions/$sessionID" params={{ sessionID: entry().memberSessionID }} class="rl-btn transcript-notice-card__open">Open</Link></header><Show when={entry().escalatedBy}>{(by) => <p class="transcript-notice-card__meta">Escalated by {by()}</p>}</Show><Show when={entry().excerpt}>{(excerpt) => <Markdown text={excerpt()} />}</Show></article>}</Show>
      : card().kind === "goal" ? <Show when={card().kind === "goal" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "goal" }> : undefined}>{(entry) => <article class="transcript-notice-card" data-kind="goal"><header class="transcript-notice-card__head"><Icon name="target" /><strong>Goal · steer</strong></header><Markdown text={entry().text} /></article>}</Show>
      : card().kind === "parent-answer" ? <Show when={card().kind === "parent-answer" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "parent-answer" }> : undefined}>{(entry) => <article class="transcript-notice-card" data-kind="parent-answer"><header class="transcript-notice-card__head"><Icon name="chat" /><strong>Parent answer</strong></header><Markdown text={entry().text} /></article>}</Show>
      : card().kind === "completion" ? <Show when={card().kind === "completion" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "completion" }> : undefined}>{(entry) => <div class="transcript-notice-pill" data-status={entry().status}><Icon name={entry().status === "failed" ? "alert" : "check"} /><div class="transcript-notice__body"><strong>{entry().label} · {entry().status}</strong><Markdown text={entry().description} /></div></div>}</Show>
      : <Show when={card().kind === "note" ? card() as Extract<ReturnType<typeof classifyDesktopSynthetic>, { kind: "note" }> : undefined}>{(entry) => <div class="transcript-notice-pill"><Icon name="bell" /><Markdown text={entry().text} /></div>}</Show>}</Show>
    <Show when={props.message.type === "model-switched" ? props.message : undefined}>{(message) => <p class="transcript-notice-pill transcript-notice-pill--center"><Icon name="cpu" /><span>Model: {message().model.providerID}/{message().model.id}{message().model.variant ? ` · ${message().model.variant}` : ""}</span></p>}</Show>
    <Show when={props.message.type === "agent-switched" ? props.message : undefined}>{(message) => <p class="transcript-notice-pill transcript-notice-pill--center"><Icon name="user" /><span>Agent: {message().agent}</span></p>}</Show>
    <Show when={props.message.type === "skill" ? props.message : undefined}>{(message) => <p class="transcript-notice-pill transcript-notice-pill--center"><Icon name="sparkles" /><span>Skill: {message().name}</span></p>}</Show>
    <Show when={!["user", "assistant", "shell", "compaction", "system", "synthetic", "model-switched", "agent-switched", "skill"].includes(role())}><p>Unsupported message: {role()}</p></Show>
  </li>
}

function usage(session: SessionRow) {
  const input = session.tokens.input + session.tokens.cache.read + session.tokens.cache.write
  const output = session.tokens.output + session.tokens.reasoning
  return <><span class="composer-metric" data-kind="input" data-tooltip="Input tokens, including cache"><Icon name="arrow-down" /><strong>{formatCompactCount(input)}</strong><span class="desktop__sr"> in</span></span><span class="composer-metric" data-kind="output" data-tooltip="Output and reasoning tokens"><Icon name="arrow-up" /><strong>{formatCompactCount(output)}</strong><span class="desktop__sr"> out</span></span><Show when={session.cost > 0}><span class="composer-metric" data-kind="cost" data-tooltip="Cumulative Session cost"><Icon name="usage" /><strong>{formatUsd(session.cost)}</strong></span></Show></>
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
  const segments = () => {
    const report = current()?.breakdown
    if (!report) return []
    const total = breakdownLabels.reduce((sum, [key]) => sum + report[key], 0)
    if (total <= 0) return []
    let offset = 0
    return breakdownLabels.map(([key]) => { const share = report[key] / total * 100; const segment = { key, share, offset }; offset += share; return segment })
  }
  return <div class="desktop-context" classList={{ "desktop-context--ring": segments().length > 0 }}><Show when={segments().length > 0}><div class="desktop-context-ring"><svg viewBox="0 0 104 104" role="img" aria-label="Estimated input token categories"><circle cx="52" cy="52" r="40" pathLength="100" fill="none" stroke="var(--yc-line-subtle)" stroke-width="8" /><g transform="rotate(-90 52 52)"><For each={segments()}>{segment => <circle cx="52" cy="52" r="40" pathLength="100" fill="none" stroke-width="8" data-category={segment.key} stroke-dasharray={`${segment.share} ${100 - segment.share}`} stroke-dashoffset={-segment.offset} />}</For></g></svg><div class="desktop-context-ring__total"><strong>{formatCompactCount(contextBreakdown(current()?.breakdown).reduce((sum, item) => sum + item.tokens, 0))}</strong><small>estimated</small></div></div></Show><SharedContextBreakdownPanel used={current() ? formatCompactCount(current()!.used) : undefined} capacity={current() ? formatCompactCount(current()!.limit) : undefined} label={current() ? `${percent(current()!.used, current()!.limit)}% used · latest response` : undefined} remaining={current() ? Math.max(0, current()!.limit - current()!.used) : undefined} breakdown={contextBreakdown(current()?.breakdown).length ? current()?.breakdown : undefined} fallbackText={context()?.stale ? `Context unknown: ${context()?.stale} the last report` : "Context unknown"} providerLabel={latestModel()} stepDiagnostics={diagnostics()} onOpenUsage={() => void navigate({ to: "/usage" })} contextMessagesLabel="Retained transcript messages" contextMessages={retainedMessages(props.messages)} staleReason="Context may differ after a model change." /></div>
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
    <Show when={is(props.field, "boolean")}><label class="request__choice"><input type="checkbox" aria-invalid={props.invalid} aria-describedby={described()} checked={props.value === true} onChange={(event) => props.onChange(event.currentTarget.checked)} /><span>Yes</span></label></Show>
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
    <p class="desktop__muted">{props.form.sessionID === "global" ? "An MCP server asks for your answer." : "This Session asks for your answer."} Nothing is sent until you choose Send answer.</p>
    <form ref={form} onSubmit={(event) => { event.preventDefault(); submit() }}>
      <For each={visible()}>{(item) => <fieldset class="request__field" disabled={props.locked} onFocusOut={(event) => { const next = event.relatedTarget; if (!(next instanceof Node) || !event.currentTarget.contains(next)) touch(props.form.fields.indexOf(item)) }}><legend>{item.title ?? item.key}{item.type === "external" || item.required ? " (required)" : ""}</legend>
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
    <Show when={props.request.action === "browser_script"}><For each={browserScriptPermission(props.request.metadata).lines}>{(line) => <p class="desktop__muted">{line}</p>}</For></Show>
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

export function pendingRequestIDs(data: { readonly permissions: readonly { readonly id: string }[]; readonly forms: readonly { readonly id: string }[]; readonly questions?: readonly { readonly id: string }[]; readonly guardrails?: readonly { readonly id: string }[]; readonly reviews?: readonly { readonly itemID: string }[] }) {
  return [...data.permissions.map((item) => item.id), ...data.forms.map((item) => item.id), ...(data.questions ?? []).map((item) => item.id), ...(data.guardrails ?? []).map((item) => item.id), ...(data.reviews ?? []).map((item) => item.itemID)]
}

function GuardrailCard(props: { item: NonNullable<PendingRequests["guardrails"]>[number]; locked: boolean; notice?: string; onReply: (reply: "once" | "reject") => void; onRecover: (action: "cancel" | "retry") => void }) {
  const [clock, setClock] = createSignal(Date.now())
  const ticker = setInterval(() => setClock(Date.now()), 15_000)
  onCleanup(() => clearInterval(ticker))
  const waiting = () => guardrailWaiting(props.item.created, clock())
  return <article class="request rl-decision-card" data-guardrail-request={props.item.id}><div class="request__head"><Icon name="shield" /><h2>Guardrail · {props.item.hardReview ? "Hard review" : props.item.standard ? "Standard" : "Custom"}</h2></div><h3>{props.item.action}</h3><Show when={waiting()}>{(age) => <p class="request__waiting"><span data-guardrail-age>{age().label}</span><Show when={age().stale}><span class="request__badge" data-tone="stale" data-guardrail-stale>Stale</span></Show></p>}</Show><p>{props.item.reason}</p><ul class="request__resources"><For each={props.item.resources}>{(pattern) => <li><code>{pattern}</code></li>}</For></ul><p>Rules: {props.item.ruleIDs.join(", ")}</p><dl class="request__ids"><dt>Owning Session</dt><dd><code>{props.item.sessionID}</code></dd><dt>Request</dt><dd><code>{props.item.id}</code></dd></dl><Show when={props.notice}><p role="alert">{props.notice}</p></Show><div class="request__footer"><div class="request__recovery" role="group" aria-label="Review recovery"><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onRecover("cancel")}>Cancel</button><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onRecover("retry")}>Retry</button></div><div class="desktop__actions"><button type="button" class="rl-btn" data-tone="go" disabled={props.locked} onClick={() => props.onReply("once")}>Approve</button><button type="button" class="rl-btn" data-tone="danger" disabled={props.locked} onClick={() => props.onReply("reject")}>Deny</button></div></div></article>
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
  const reviewedField = (item: Field) => props.item.payload.type === "form" ? props.item.payload.fields.indexOf(item) : -1
  const reviewedProblem = (item: Field) => error() ? problemOf(item, valueFor(values(), item.key)) : undefined
  return <article class="request rl-decision-card"><div class="request__head"><Icon name="shield" /><h2>Review · {props.item.kind}</h2></div><h3>{props.item.sessionTitle}</h3><p>{props.item.reason}</p>
    <Show when={props.item.payload.type === "guardrail" || props.item.payload.type === "permission" ? props.item.payload : undefined}>{(payload) => <><h3>{payload().action}</h3><ul><For each={payload().resources}>{(pattern) => <li><code>{pattern}</code></li>}</For></ul><Show when={payload().type === "guardrail" ? (payload() as Extract<ReviewItem["payload"], { type: "guardrail" }>).reason : undefined}>{(summary) => <p>{summary()}</p>}</Show><div class="desktop__actions"><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision(props.item.kind === "guardrail" ? { kind: "guardrail", reply: "once" } : { kind: "permission", reply: "once" })}>Approve</button><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision(props.item.kind === "guardrail" ? { kind: "guardrail", reply: "reject" } : { kind: "permission", reply: "reject" })}>Deny</button></div></>}</Show>
    <Show when={props.item.payload.type === "recovery" ? props.item.payload : undefined}>{(payload) => <><ul><For each={payload().tools}>{(tool) => <li>{tool.name} · {tool.messageID}</li>}</For></ul><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision({ kind: "recovery", choice: "continue" })}>Continue</button><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision({ kind: "recovery", choice: "stop" })}>Stop</button></>}</Show>
    <Show when={props.item.kind === "question" || props.item.kind === "subagent_question"}><form onSubmit={(event) => { event.preventDefault(); submit() }}><Show when={props.item.payload.type === "form" ? props.item.payload : undefined}>{(payload) => <><h3>{payload().title}</h3><For each={activeFields(payload().fields, values())}>{(item) => <fieldset class="request__field" disabled={props.locked}><legend>{item.title ?? item.key}</legend><FieldInput scope={props.item.itemID} index={reviewedField(item)} field={item} value={valueFor(values(), item.key)} invalid={!!reviewedProblem(item)} onChange={(value) => setValues((previous) => withValue(previous, item.key, value))} /><Show when={reviewedProblem(item)}>{(problem) => <p role="alert" id={errorId(props.item.itemID, reviewedField(item))}>{problem()}</p>}</Show></fieldset>}</For></>}</Show><Show when={props.item.payload.type === "question" ? props.item.payload : undefined}>{(payload) => <For each={payload().questions}>{(question, index) => <fieldset class="request__field"><legend>{question.header}</legend><p>{question.question}</p><For each={question.options}>{(option) => <label class="request__choice"><input type={question.multiple ? "checkbox" : "radio"} name={`${props.item.itemID}-${index()}`} checked={answers()[index()]?.includes(option.label) ?? false} disabled={props.locked} onChange={(event) => { const checked = event.currentTarget.checked; setAnswers((previous) => ({ ...previous, [index()]: question.multiple ? checked ? [...previous[index()] ?? [], option.label] : (previous[index()] ?? []).filter((entry) => entry !== option.label) : [option.label] })); if (!question.multiple) setCustom((previous) => ({ ...previous, [index()]: "" })) }} /><span>{option.label} · {option.description}</span></label>}</For><Show when={question.custom !== false}><label class="rl-field"><span>Custom answer</span><input value={custom()[index()] ?? ""} disabled={props.locked} onInput={(event) => { const value = event.currentTarget.value; setCustom((previous) => ({ ...previous, [index()]: value })); if (!question.multiple) setAnswers((previous) => ({ ...previous, [index()]: [] })) }} /></label></Show></fieldset>}</For>}</Show><Show when={props.item.payload.type === "subagent_question" ? props.item.payload : undefined}>{(payload) => <label class="rl-field"><span>{payload().text}</span><textarea value={text()} disabled={props.locked} onInput={(event) => setText(event.currentTarget.value)} /></label>}</Show><button type="submit" class="rl-btn" disabled={props.locked}>Send answer</button><button type="button" class="rl-btn" disabled={props.locked} onClick={() => props.onDecision(props.item.kind === "subagent_question" ? { kind: "subagent_question", dismissed: true } : { kind: "question", dismissed: true })}>Dismiss</button></form></Show>
    <Show when={error() ?? props.notice}><p role="alert">{error() ?? props.notice}</p></Show>
  </article>
}

function Requests(props: { data: PendingRequests; updatedAt: number; refetch: () => void }) {
  const [working, setWorking] = createSignal(false)
  const [held, setHeld] = createSignal<ReadonlyMap<string, { readonly message?: string; readonly at: number }>>(new Map())
  const [lost, setLost] = createSignal<string>()
  const [closed, setClosed] = createSignal<string>()
  let section: HTMLElement | undefined
  let answered: { id: string; card?: Element } | undefined
  let shownGuardrails = new Set<string>()
  createEffect(() => {
    const current = new Set((props.data.guardrails ?? []).map((item) => item.id))
    const gone = new Set([...shownGuardrails].filter((id) => !current.has(id)))
    shownGuardrails = current
    const decisions = Array.isArray(props.data.guardrailDecisions) ? props.data.guardrailDecisions : []
    const ended = decisions.filter((row) => gone.has(word(field(row, "requestID")) ?? "") && field(row, "reason") !== undefined).at(-1)
    if (ended !== undefined) setClosed(guardrailClosedNotice(field(ended, "reason")))
  })
  const waiting = (id: string) => props.updatedAt <= (held().get(id)?.at ?? -1)
  const locked = (id: string) => working() || waiting(id)
  const notice = (id: string) => {
    const message = held().get(id)?.message
    return message === undefined ? undefined : waiting(id) ? `${message} Refreshing requests…` : `${message} The request is still pending. Review your answer and try again.`
  }
  createEffect(() => {
    const pending = new Set(pendingRequestIDs(props.data))
    const settled = answered
    if (settled === undefined || pending.has(settled.id)) return
    answered = undefined
    const { id, card } = settled
    if (held().get(id)?.message !== undefined) setLost("A reply was not confirmed and that request is no longer pending. Check the transcript to see whether it was applied.")
    setHeld((current) => new Map([...current].filter(([key]) => key !== id)))
    if (card) queueMicrotask(() => {
      const active = document.activeElement
      if (active === document.body || card.contains(active)) document.getElementById("conversation-title")?.focus({ preventScroll: true })
    })
  })
  const answer = async (id: string, input: RequestReply) => {
    if (working()) return
    const generation = connection().generation
    const card = document.activeElement?.closest(".request")
    answered = { id, card: card && section?.contains(card) ? card : undefined }
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
  return <section ref={section} class="requests" aria-label="Requests waiting for you">
    <Show when={lost()}>{(message) => <p role="status" class="desktop__error">{message()}</p>}</Show>
    <For each={props.data.permissions}>{(request) => <PermissionCard request={request} locked={locked(request.id)} notice={notice(request.id)}
      onReply={(reply, message) => void answer(request.id, { kind: "permission", sessionID: props.data.sessionID, revision: props.data.revision, requestID: request.id, reply, ...(message === undefined ? {} : { message }) })} />}</For>
    <For each={props.data.forms}>{(form) => <FormCard form={form} locked={locked(form.id)} notice={notice(form.id)}
      onSubmit={(value) => void answer(form.id, { kind: "form", sessionID: props.data.sessionID, revision: props.data.revision, formID: form.id, answer: value, ...(props.data.location ? { location: props.data.location } : {}) })}
      onCancel={() => void answer(form.id, { kind: "form-cancel", sessionID: props.data.sessionID, revision: props.data.revision, formID: form.id, ...(props.data.location ? { location: props.data.location } : {}) })} />}</For>
    <For each={props.data.questions}>{(request) => <ActiveQuestionCard request={request} locked={locked(request.id)} notice={notice(request.id)}
      onAnswer={(answers) => void answer(request.id, { kind: "question", sessionID: props.data.sessionID, revision: props.data.revision, requestID: request.id, answers })}
      onReject={() => void answer(request.id, { kind: "question-reject", sessionID: props.data.sessionID, revision: props.data.revision, requestID: request.id })} />}</For>
    <Show when={closed()}>{(message) => <p role="status" class="request__closed" data-guardrail-closed>{message()}</p>}</Show>
    <For each={props.data.guardrails}>{(item) => <GuardrailCard item={item} locked={locked(item.id)} notice={notice(item.id)} onReply={(reply) => void answer(item.id, { kind: "guardrail", sessionID: props.data.sessionID, revision: props.data.revision, requestID: item.id, reply })}
      onRecover={(action) => void answer(item.id, { kind: "guardrail-recovery", sessionID: props.data.sessionID, revision: props.data.revision, requestID: item.id, action })} />}</For>
    <For each={props.data.reviews}>{(item) => <ReviewCard item={item} locked={locked(item.itemID)} notice={notice(item.itemID)} onDecision={(decision) => void answer(item.itemID, { kind: "review", sessionID: props.data.sessionID, revision: props.data.revision, itemID: item.itemID, decision })} />}</For>
  </section>
}

function ModelPicker(props: { sessionID: string; model?: ModelId; running: boolean; agent?: string; autonomyLabel: string; onAutonomy: () => void; onStageModel: (model: ModelSelection | undefined) => void; openTick?: number; cycleTick?: number }) {
  const catalog = observe(() => ({ queryKey: ["models", ...scope(), props.sessionID] as const, queryFn: () => api.models(props.sessionID), enabled: reading(), refetchOnMount: "always" as const }))
  const data = () => { const found = catalog.result().isError ? undefined : catalog.result().data; return found && "current" in found && found.source.sessionID === props.sessionID && found.revision === connection().revision ? found : undefined }
  const [switching, setSwitching] = createSignal(false)
  const [pendingChoice, setPendingChoice] = createSignal<ModelChoice>()
  const [outcome, setOutcome] = createSignal<{ readonly text: string; readonly failed: boolean }>()
  let outcomeTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => { void props.sessionID; void connection().generation; clearTimeout(outcomeTimer); setSwitching(false); setPendingChoice(undefined); props.onStageModel(undefined); setOutcome(undefined) })
  const selectionIdentity = createMemo(() => JSON.stringify([connection().revision, data()?.current, data()?.models]))
  createEffect(() => { void selectionIdentity(); setPendingChoice(undefined); props.onStageModel(undefined) })
  onCleanup(() => clearTimeout(outcomeTimer))
  const list = createMemo(() => visibleModels(data()?.models ?? [], data()?.current))
  const choice = () => choiceFor(list(), data()?.current)
  const blocked = () => props.running || data()?.running === true
  const staged = () => !!pendingChoice() && !switching()
  const pickChoice = (next: ModelChoice) => {
    if (!blocked()) { void switchTo(next); return }
    if (!reading() || switching() || next.model !== choice().model || next.profile !== choice().profile || !selectionFor(list(), next)) return
    setPendingChoice(next)
    props.onStageModel(selectionFor(list(), next))
  }
  const switchTo = async (next: ModelChoice) => {
    const found = data()
    if (!found || switching() || blocked() || !reading()) return
    const model = selectionFor(list(), next)
    if (!model) return
    if (sameSelection(model, found.current)) { setPendingChoice(undefined); return }
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
  createEffect(on(() => props.cycleTick, (tick) => {
    if (!tick || switching() || !reading()) return
    const current = pendingChoice() ?? choice()
    const model = list()[current.model]
    const stops = effortStopsFor(variantsFor(model, current.profile))
    if (!stops.length) { setDesktopNotice("This model has no reasoning effort variants."); return }
    pickChoice({ ...current, variant: stops[(effortStopIndex(stops, current.variant) + 1) % stops.length]!.value })
  }, { defer: true }))
  const currentName = () => { const current = data()?.current; const option = current ? list().find((item) => item.id === current.id && item.providerID === current.providerID) : undefined; return option?.name ?? current?.id ?? props.model?.id }
  return <>
    <Show when={data()} fallback={<button type="button" class="composer-chip" disabled><span>{props.agent ? `${props.agent} · ` : ""}{currentName() ?? "Model not set"}</span></button>}>
      <ModelPopover chipLabel={currentName() ?? "Choose a model"} effortLabel={staged() ? `${pendingChoice()!.variant || "Default"} · pending` : data()?.current?.variant || undefined} busy={switching() || !reading()} modelBusy={blocked() || switching() || !reading()} models={list()} choice={pendingChoice() ?? choice()} openTick={props.openTick} onPick={pickChoice} onRefresh={catalog.refetch} refreshing={catalog.result().isFetching}>
        <Show when={blocked()}><p role="status" class="desktop__muted">Model and profile changes require an idle chat. Effort can be staged locally.</p></Show>
        <Show when={staged()}><p role="status" class="desktop__muted">Effort staged locally; not applied to the Session or queued prompts.</p></Show>
        <Show when={!blocked() ? choiceProblem(list(), choice()) : undefined}>{(problem) => <p role="status" class="desktop__muted">{problem()}</p>}</Show>
        <Show when={switching()}><p role="status" class="desktop__muted">Switching…</p></Show>
        <Show when={outcome()?.failed ? outcome() : undefined}>{(result) => <p role="alert" class="desktop__error model-popover__status">{result().text}</p>}</Show>
      </ModelPopover>
    </Show>
    <button type="button" class="composer-chip composer-policy-chip" aria-label={props.autonomyLabel.replace("Autonomy · ", "Autonomous ")} data-tooltip={props.autonomyLabel} aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); props.onAutonomy() }}><Icon name="shield" /><span>{props.autonomyLabel.replace("Autonomy · ", "")}</span></button>
    <Show when={catalog.result().isPending && reading()}><span role="status" class="desktop__sr">Loading models…</span></Show>
    <Show when={catalog.result().isError}><span role="alert" class="desktop__error composer-bar__note">{failure(catalog.result().error, "Models could not be read. Refresh to retry.")}<button type="button" class="rl-btn" onClick={catalog.refetch} disabled={!reading()}>Refresh models</button></span></Show>
    <Show when={outcome()}>{(result) => <span role={result().failed ? "alert" : "status"} class={result().failed ? "desktop__error composer-bar__note" : "desktop__muted composer-bar__note"}>{result().text}</span>}</Show>
  </>
}

function RunningActivity(props: { sessionID: string; data?: import("./contract").SessionActivity; loading: boolean; error?: string; moreError?: string; onRefresh: () => void; onMore: () => void; loadingMore: boolean; onOpen: (id: string) => void; onShell: (id: string) => void }) {
  const tasks = () => props.data?.subagents.filter((task) => task.state === "running") ?? []
  const shells = () => props.data?.shells.filter((shell) => shell.status === "running") ?? []
  const row = (icon: WebIconName, onOpen: () => void, content: JSX.Element) => <button type="button" class="rl-activity-row" data-state="active" onClick={onOpen}><span class="rl-activity-row__icon" aria-hidden="true"><Icon name={icon} /></span><span class="rl-activity-row__body">{content}</span><span class="rl-activity-row__chevron" aria-hidden="true"><Icon name="chevron-right" /></span></button>
  return <div class="rl-pane-body rl-running">
    <div class="desktop__actions"><h2>Running work</h2><button type="button" class="rl-btn" onClick={props.onRefresh}>Refresh</button></div>
    <Show when={props.loading}><p role="status">Reading running work…</p></Show>
    <Show when={props.error}>{(error) => <p role="alert">{error()}</p>}</Show>
    <Show when={props.moreError}>{(error) => <p role="alert">{error()}</p>}</Show>
    <Show when={props.data}>
      <h3>Subagents</h3><For each={tasks()} fallback={<p>No running subagents in the loaded results.</p>}>{(task) => row("team", () => props.onOpen(task.sessionID), <><strong>{task.description}</strong><small>{task.agent} · Running</small><Show when={task.progress}>{(progress) => <small>{progress().text}</small>}</Show></>)}</For>
      <h3>Shells</h3><For each={shells()} fallback={<p>No running shells in the loaded results.</p>}>{(shell) => row("terminal", () => props.onShell(shell.id), <><strong>{shell.command}</strong><small>Running</small></>)}</For>
      <Show when={props.data?.subagentNext}><p>More subagents and their shells may be running beyond these loaded results.</p><button type="button" class="rl-btn" disabled={props.loadingMore} onClick={props.onMore}>{props.loadingMore ? "Loading…" : "Load more subagents"}</button></Show>
      <Show when={props.data?.unattributedShellCount}><p>Shells without Session attribution are not included.</p></Show>
    </Show>
    <ChannelActivity sessionID={props.sessionID} enabled={companionOpen() && companionTab() === "Running"} />
  </div>
}

function Conversation(props: { sessionID: string }) {
  const telemetry = useDesktopTelemetry()
  const [interactionView, setInteractionView] = createSignal<InteractionView>()
  const [chromeProposalOpen, setChromeProposalOpen] = createSignal(false)
  const interaction = createInteractionControl(setInteractionView)
  const interactionMedia = window.matchMedia(COMPANION_DOCKED_QUERY)
  const [interactionDocked, setInteractionDocked] = createSignal(interactionMedia.matches)
  const moveInteractionPreview = () => { interaction.reveal(false); setInteractionDocked(interactionMedia.matches) }
  interactionMedia.addEventListener("change", moveInteractionPreview)
  onCleanup(() => { interactionMedia.removeEventListener("change", moveInteractionPreview); interaction.setSource() })
  const localInteraction = () => {
    const selection = savedSelection()
    return selection.mode === "own" || selection.server === undefined ||
      URL.canParse(selection.server) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(selection.server).hostname)
  }
  createEffect(on([() => props.sessionID, () => connection().revision, reading, teamOpen], ([sessionID, revision, connected, team]) => {
    setChromeProposalOpen(false)
    if (!connected || revision === undefined || team) { interaction.setSource(); return }
    const owner = { sessionID, revision }
    interaction.setSource({
      status: async () => readInteractionStatus(await api.interactionStatus(owner)) ?? "error",
      preview: (generation) => api.interactionPreview({ ...owner, generation }),
      stop: (generation) => api.interactionStop({ ...owner, generation }),
      resume: (generation) => api.interactionResume({ ...owner, generation }),
      request: (payload) => api.interactionRequest({ ...owner, payload }),
    })
  }))
  onCleanup(api.onEvent((event) => {
    const generation = interactionEventGeneration(event, props.sessionID)
    if (generation !== undefined) interaction.change(generation)
  }))
  createEffect(() => {
    if (interactionDocked() && (!companionOpen() || companionTab() !== "Activity")) interaction.reveal(false)
  })
  const revealInteraction = (revealed: boolean) => {
    if (revealed && interactionDocked()) { setCompanionTab("Activity"); showCompanion(true) }
    interaction.reveal(revealed)
  }
  createEffect(on(() => [props.sessionID, ...scope()], () => { setTeamOpen(teamRequested); teamRequested = false }))
  createEffect(() => setLastSession(props.sessionID))
  onCleanup(() => setSessionGauge(undefined))
  const [sessionDialog, setSessionDialog] = createSignal<"rename" | "daybreak" | "timeline" | "activity">()
  const [subagentAnswers, setSubagentAnswers] = createSignal<Readonly<Record<string, string>>>({})
  let ownsConversation = true
  onCleanup(() => { ownsConversation = false })
  createEffect(() => { setLastSessionID(props.sessionID) })
  const sessions = observe(sessionsQuery)
  const sessionRead = observe(() => ({ queryKey: ["session", ...scope(), props.sessionID] as const, queryFn: () => api.session({ sessionID: props.sessionID }), enabled: reading(), refetchOnMount: "always" as const }))
  const historyKey = () => ["messages", ...scope(), props.sessionID] as const
  const messages = observe(() => ({ queryKey: historyKey(), queryFn: async () => { const key = historyKey(), started = performance.now(), owner = scope().join(":"); const next = await api.sessionSnapshot({ sessionID: props.sessionID }); if (owner === scope().join(":")) telemetry.record("transcript.load", performance.now() - started); return reconcileSessionHistory(queries.getQueryData<SessionSnapshot>(key), next, "refresh") }, enabled: reading(), refetchOnMount: "always" as const }))
  const history = () => messages.result().isError ? undefined : currentSnapshot(messages.result().data, connection().revision, props.sessionID)
  const deleteMessage = async (messageID: string) => {
    const current = history()
    if (!current) return "Refresh the Session before deleting a message."
    const key = historyKey()
    try {
      await api.deleteMessage({ sessionID: props.sessionID, messageID, revision: current.revision })
      queries.setQueryData<SessionSnapshot>(key, (snapshot) => snapshot && { ...snapshot, messages: snapshot.messages.filter((message) => message.id !== messageID) })
      return undefined
    } catch (cause) {
      return failure(cause, "The backend did not confirm deletion. Refresh before trying again.")
    }
  }
  const pendingRead = observe(() => ({ queryKey: ["pendingInputs", ...scope(), props.sessionID] as const, queryFn: () => api.pendingInputs(props.sessionID), enabled: reading() }))
  const pendingInputs = () => pendingRead.result().isError ? undefined : currentSnapshot(pendingRead.result().data, connection().revision, props.sessionID)
  const [historyBusy, setHistoryBusy] = createSignal(false)
  const [historyError, setHistoryError] = createSignal<string>()
  const requests = observe(() => ({ queryKey: ["requests", ...scope(), props.sessionID] as const, queryFn: () => api.requests(props.sessionID), enabled: reading() }))
  const changes = observe(() => ({ queryKey: ["fileChanges", ...scope(), props.sessionID] as const, queryFn: () => api.fileChanges(props.sessionID), enabled: reading() }))
  const activityRead = observe(() => ({ queryKey: ["activity", ...scope(), props.sessionID] as const, queryFn: () => api.activity(props.sessionID), enabled: reading() }))
  const activityData = () => activityRead.result().isError ? undefined : currentSnapshot(activityRead.result().data, connection().revision, props.sessionID)
  const changeData = () => changes.result().isError ? undefined : currentSnapshot(changes.result().data, connection().revision, props.sessionID)
  const autonomyRead = observe(() => ({ queryKey: ["autonomy", ...scope(), props.sessionID] as const, queryFn: () => api.autonomy!(props.sessionID), enabled: reading() && typeof api.autonomy === "function" }))
  const autonomy = () => autonomyRead.result().isError ? undefined : currentSnapshot(autonomyRead.result().data, connection().revision, props.sessionID)?.autonomy
  const policyLabels = () => autonomyLabels(autonomy())
  const [policyOpen, setPolicyOpen] = createSignal(false)
  const [policyBusy, setPolicyBusy] = createSignal(false)
  const [policyUncertain, setPolicyUncertain] = createSignal(false)
  const [policyError, setPolicyError] = createSignal<string>()
  const [policyGoal, setPolicyGoal] = createSignal("")
  let policyOpener: HTMLElement | undefined
  createEffect(() => { void scope(); setPolicyOpen(false) })
  const [permissions, setPermissions] = createSignal<"manual" | "auto" | "yolo">("manual")
  const [guardrails, setGuardrails] = createSignal<"manual" | "auto" | "yolo">("manual")
  const [answers, setAnswers] = createSignal<"manual" | "auto" | "yolo">("manual")
  const openPolicy = () => { policyOpener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; const value = autonomy(); setPolicyGoal(value?.goal?.text ?? ""); if (value) { setPermissions(value.effective.permissions); setGuardrails(value.effective.guardrails); setAnswers(value.effective.answers) } setPolicyOpen(true); queueMicrotask(() => document.querySelector<HTMLElement>('.rl-policy-panel button, .rl-policy-panel input, .rl-policy-panel textarea')?.focus({ preventScroll: true })) }
  const closePolicy = (restoreFocus = false) => { setPolicyOpen(false); if (restoreFocus) queueMicrotask(() => { const target = policyOpener?.isConnected ? policyOpener : document.querySelector<HTMLElement>('.composer-policy-chip'); target?.focus({ preventScroll: true }) }) }
  const policyGuard = createActionGuard<SetAutonomyInput, Awaited<ReturnType<typeof api.setAutonomy>>>((prompt) => confirmInPage(prompt), () => scope().join(":"), (input) => api.setAutonomy(input))
  const setPolicy = async (payload: SetAutonomyInput["payload"], prompt: string) => {
    const revision = connection().revision
    if (revision === undefined || !autonomy() || !reading() || policyBusy() || policyUncertain() || typeof api.setAutonomy !== "function") return
    setPolicyBusy(true); setPolicyError(undefined)
    const result = await policyGuard.run({ sessionID: props.sessionID, revision, payload }, autonomyPrompt(payload, prompt))
    if (result.status === "completed" && result.value?.revision === revision && result.value?.sessionID === props.sessionID && autonomyMatches(result.value.autonomy, payload)) { setPolicyGoal(result.value.autonomy.goal?.text ?? ""); autonomyRead.refetch() }
    else if (result.status === "completed") { setPolicyUncertain(true); setPolicyError("The autonomy response did not match the requested change. Reopen the Session and review its state."); autonomyRead.refetch() }
    else if (result.status === "unconfirmed") { setPolicyUncertain(true); setPolicyError(failure(result.error, "The autonomy change was not confirmed. Reopen the Session and review its state.")); autonomyRead.refetch() }
    setPolicyBusy(false)
  }
  const policyButtons = () => <><button type="button" onClick={openPolicy}>{policyLabels().goal}</button><button type="button" onClick={openPolicy}>{policyLabels().autonomy}</button></>
  const [selectedTurn, setSelectedTurn] = createSignal<string>()
  const [linkNote, setLinkNote] = createSignal<string>()
  const copyTranscriptLink = (event: MouseEvent) => { const anchor = event.target instanceof Element ? event.target.closest(".transcript-md a[href]") : undefined; if (!(anchor instanceof HTMLAnchorElement)) return; event.preventDefault(); const href = anchor.href; void copyTextToClipboard(href).then(() => setLinkNote("Copied link"), () => setLinkNote("Link could not be copied")) }
  const [fullChangesOpen, setFullChangesOpen] = createSignal(false)
  const [stagedRevert, setStagedRevert] = createSignal<StagedRevert>()
  const activeRevert = () => activeRevertOf(session(), stagedRevert())
  const [revertNotice, setRevertNotice] = createSignal<string>()
  const [revertBusy, setRevertBusy] = createSignal(false)
  const [revertError, setRevertError] = createSignal<string>()
  const [revertUncertain, setRevertUncertain] = createSignal(false)
  let revertScope = scope().join(":")
  createEffect(() => { const next = scope().join(":"); if (next !== revertScope && (activeRevert() || revertBusy())) { setRevertUncertain(true); setRevertError("Connection changed. Review the staged revert before proceeding.") } revertScope = next })
  const revertGuard = createActionGuard<RevertInput, Awaited<ReturnType<typeof api.revert>>>((prompt) => confirmInPage(prompt), () => `${scope().join(":")}:${props.sessionID}:${ownsConversation}`, (input) => api.revert(input))
  const doRevert = async (action: "stage" | "commit" | "clear", messageID = selectedTurn(), fromCommand = false) => {
    const revision = connection().revision
    const known = messageID && (history()?.messages.some((message) => message.id === messageID && message.type === "user") || changeData()?.turns?.some((turn) => turn.id === messageID))
    if (revision === undefined || !reading() || revertBusy() || sending() && !fromCommand || revertUncertain() || running() || !api.revert || (action === "stage" && !known)) return false
    const prompt = action === "stage" ? "Stage this revert? This immediately restores captured files and may overwrite working-tree changes." : action === "clear" ? "Cancel this revert? Restoring the original files may overwrite changes made since staging." : "Confirm this revert? Session messages after the selected boundary will be removed and the file restoration kept."
    const generation = connection().generation
    setRevertBusy(true); setRevertError(undefined)
    const result = await revertGuard.run(action === "stage" ? { action, sessionID: props.sessionID, revision, messageID: messageID!, files: true } : { action, sessionID: props.sessionID, revision }, prompt)
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
    return result.status === "completed" && connection().generation === generation && connection().revision === revision
  }
  const revert = () => (selectedTurn() || activeRevert()) && typeof api.revert === "function" ? { staged: !!activeRevert(), busy: revertBusy() || sending() || revertUncertain() || !reading() || running(), summary: activeRevert() ? `Revert to ${activeRevert()!.messageID} · ${activeRevert()!.files?.length ?? 0} files reported` : undefined, error: revertError(), onStage: () => void doRevert("stage"), onCommit: () => void doRevert("commit"), onClear: () => void doRevert("clear") } : undefined
  const [activityPages, setActivityPages] = createSignal<NonNullable<ReturnType<typeof activityData>>>()
  const [activityMoreBusy, setActivityMoreBusy] = createSignal(false)
  const [activityMoreError, setActivityMoreError] = createSignal<string>()
  createEffect(() => { void activityRead.result().data; setActivityPages(undefined); setActivityMoreError(undefined) })
  const activityView = () => activityRead.result().isError ? undefined : currentSnapshot(activityPages(), connection().revision, props.sessionID) ?? activityData()
  const reportedTaskIDs = () => [...new Set(activityView()?.subagents.map(task => task.sessionID) ?? [])].toSorted()
  const childSessionsRead = observe(() => {
    const owner = activityView()
    const loaded = new Set(currentSnapshot(sessions.result().data, connection().revision)?.items.map(row => row.id) ?? [])
    const ids = reportedTaskIDs().filter(id => !loaded.has(id))
    const scopeKey = scope()
    return { queryKey: ["childSessions", ...scopeKey, props.sessionID, ids] as const, enabled: reading() && !!owner && !sessions.result().isPending && ids.length > 0, queryFn: async () => {
      const records = await Promise.all(ids.map(sessionID => queries.query({ queryKey: ["session", ...scopeKey, sessionID], queryFn: () => api.session({ sessionID }) })))
      if (!owner || records.some(record => record.revision !== owner.revision || record.item.parentID !== owner.sessionID)) throw new Error("Child Session metadata does not match the reported family. Refresh to retry.")
      return { revision: owner.revision, sessionID: owner.sessionID, items: records.map(record => record.item) }
    } }
  })
  const familyRows = createMemo(() => [...new Map([
    ...(currentSnapshot(sessions.result().data, connection().revision)?.items ?? []),
    ...(childSessionsRead.result().isError ? [] : currentSnapshot(childSessionsRead.result().data, connection().revision, props.sessionID)?.items ?? []),
  ].map(row => [row.id, row])).values()])
  const children = () => companionChildren(familyRows(), props.sessionID, activity())
  const taskSessionIDs = () => [...new Set([...companionChildren(familyRows(), props.sessionID, noActivity).map(entry => entry.row.id), ...reportedTaskIDs()])].toSorted()
  const insightsRead = observe(() => ({ queryKey: ["sessionInsights", ...scope(), props.sessionID, taskSessionIDs()] as const, queryFn: () => api.sessionInsights({ sessionID: props.sessionID, taskSessionIDs: taskSessionIDs() }), enabled: reading() && companionOpen() && companionTab() === "Context" }))
  const insights = () => insightsRead.result().isError ? undefined : currentSnapshot(insightsRead.result().data, connection().revision, props.sessionID)
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
  const appScope = createMemo(() => reading() ? JSON.stringify([connection().revision, props.sessionID]) : undefined)
  const [companionApp, setCompanionApp] = createSignal<OpenMcpApp>()
  createEffect(() => { void appScope(); setCompanionApp(undefined) })
  const openCompanionApp = (app: OpenMcpApp) => {
    if (app.scope !== appScope()) return
    setCompanionApp(app)
    setCompanionTab("Activity")
    setCompanionOpen(true)
  }
  const pendingRequests = () => { const data = requests.result().data; return data?.sessionID === props.sessionID && data.revision === connection().revision ? data : undefined }
  const requestCount = () => { const data = pendingRequests(); return data ? pendingRequestIDs(data).length : 0 }
  const unanswerable = () => {
    const data = pendingRequests()
    const known = new Set(data ? pendingRequestIDs(data) : [])
    return !!pendingRequests() && [...(activity().waiting.get(props.sessionID) ?? [])].some((id) => !known.has(id))
  }
  const subagentsWaiting = () => children().filter((entry) => entry.status === "Waiting for you").map((entry) => entry.row)
  const [stopping, setStopping] = createSignal(false)
  const [stopNote, setStopNote] = createSignal<string>()
  const session = () => { const data = sessionRead.result().data; return data && data.revision === connection().revision && data.item.id === props.sessionID ? data.item : undefined }
  const context = () => contextOf(history()?.messages ?? [], session()?.model)
  const [findOpen, setFindOpen] = createSignal(false)
  const [findQuery, setFindQuery] = createSignal("")
  const editPlacements = createMemo(() => turnEditPlacements(visibleDesktopMessages(history()?.messages ?? []), changeData()?.turns))
  const visibleHistory = () => visibleDesktopMessages(history()?.messages ?? []).filter((message) => !activeRevert() || message.id < activeRevert()!.messageID)
  const turns = () => visibleHistory().filter((message) => !findQuery().trim() || transcriptText(message).toLowerCase().includes(findQuery().trim().toLowerCase()))
  const recallRead = observe(() => ({ queryKey: ["sessionRecall", ...scope(), props.sessionID] as const, queryFn: () => api.sessionRecall(props.sessionID), enabled: reading() }))
  const recalls = () => { const data = recallRead.result().isError ? undefined : currentSnapshot(recallRead.result().data, connection().revision, props.sessionID); return data ? transcriptRecords(foldRecallEvents(data.events).entries, foldLifecycleEvents(data.events).entries) : [] }
  const recallRows = createMemo(() => recordPlacements(turns(), findQuery().trim() ? [] : recalls()))
  const continuations = createMemo(() => {
    const ids = new Set<string>()
    let previous: Messages[number] | undefined
    for (const message of visibleHistory()) {
      if (intermediateAssistant(message) && intermediateAssistant(previous) && message.agent === previous.agent && message.model.providerID === previous.model.providerID && message.model.id === previous.model.id && message.model.variant === previous.model.variant && message.model.profile === previous.model.profile) ids.add(message.id)
      previous = message
    }
    return ids
  })
  const [announcement, setAnnouncement] = createSignal<{ readonly id: string; readonly text: string }>()
  let baselined = false
  let announced: string | undefined
  createEffect(() => {
    const result = messages.result()
    if (!result.isSuccess || !result.isFetchedAfterMount) return
    const finished = result.data.messages.findLast((message) => message.type === "assistant" && message.time.completed)
    if (!baselined) { baselined = true; announced = finished?.id; return }
    if (finished?.type === "assistant" && finished.id !== announced) { announced = finished.id; setAnnouncement({ id: finished.id, text: `${finished.agent} finished a response.` }) }
  })
  const running = () => activity().busy.has(props.sessionID) || responding(history()?.messages ?? [])
  const runningChildren = () => children().filter((entry) => entry.status === "Running").length
  createEffect(() => setSessionGauge({ sessionID: props.sessionID, children: runningChildren() }))
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
  const [pasted, showPasted] = createSignal<readonly PastedText[]>(pastedDrafts.get(props.sessionID) ?? [])
  const setPasted = (value: readonly PastedText[]) => { showPasted(value); if (value.length) pastedDrafts.set(props.sessionID, value); else pastedDrafts.delete(props.sessionID) }
  const [pending, setPending] = createSignal(pendings.get(props.sessionID))
  const editorContext = createEditorContext({ api, directory: () => session()?.location.directory, revision: () => connection().revision, enabled: reading })
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [following, setFollowing] = createSignal(true)
  const [unsure, setUnsure] = createSignal(unconfirmed.has(props.sessionID))
  const [scrollTop, setScrollTop] = createSignal(0)
  const [inView, setInView] = createSignal<ReadonlySet<string>>(new Set())
  const [clearance, setClearance] = createSignal(0)
  let scroller: HTMLDivElement | undefined
  let teamView: HTMLDivElement | undefined
  let jumpSlot: HTMLDivElement | undefined
  let dock: HTMLDivElement | undefined
  let jumping = false
  let measureFrame: number | undefined
  let visibility: ReturnType<typeof createPromptVisibility> | undefined
  const ticks = createMemo(() => desktopPromptTicks(turns()))
  const syncVisibility = () => { if (scroller) visibility?.sync([...scroller.querySelectorAll<HTMLElement>('.transcript__turn.rl-me[id]')].map((node) => ({ id: node.id.slice(5), node }))) }
  createEffect(on(() => ticks().map((tick) => tick.id).join("\0"), () => queueMicrotask(syncVisibility)))
  const targets = () => navigationTargets(scrollTop(), following())
  const toEnd = () => { if (scroller) scroller.scrollTop = scroller.scrollHeight }
  let previousScrollTop = 0
  let navigationMotion: Animation | undefined
  createEffect(on(() => props.sessionID, id => queueMicrotask(() => {
    if (props.sessionID !== id || !scroller?.isConnected) return
    navigationMotion?.cancel()
    navigationMotion = desktopContentMotion(scroller)
  }), { defer: true }))
  createEffect(() => { if (!animationsEnabled()) navigationMotion?.finish() })
  onCleanup(() => navigationMotion?.cancel())
  const scrollDistance = () => scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : 0
  const measure = () => {
    if (!scroller) return
    const controls = jumpSlot?.querySelector<HTMLElement>(".transcript-navigation__controls")
    if (!jumpSlot || !controls) return
    const bounds = jumpSlot.getBoundingClientRect()
    const bottom = bounds.top + controls.offsetTop + controls.offsetHeight + clearance()
    const gap = Number.parseFloat(getComputedStyle(controls).bottom)
    setClearance(pillClearance({ left: bounds.left + controls.offsetLeft, width: controls.offsetWidth, bottom, height: controls.offsetHeight, gap }, [...scroller.querySelectorAll<HTMLElement>(".request :is(button, input, textarea, select)")].filter((element) => getComputedStyle(element).visibility === "visible").map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0)))
  }
  const scheduleMeasure = () => {
    if (measureFrame !== undefined) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined
      if (following() && !jumping) toEnd()
      measure()
    })
  }
  const onScroll = () => {
    if (!scroller) return
    const movedUp = scroller.scrollTop < previousScrollTop - 1
    previousScrollTop = scroller.scrollTop
    setScrollTop(scroller.scrollTop)
    scheduleMeasure()
    if (jumping && scrollDistance() > 48) return
    if (scrollDistance() <= 48) jumping = false
    if (movedUp || scrollDistance() <= 48) setFollowing(followState(following(), { kind: "scroll", distance: scrollDistance() }))
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
  const loadOlder = async () => {
    const current = history()
    if (!current?.before || historyBusy() || !reading()) return
    const key = historyKey(), owner = key.join(":"), height = scroller?.scrollHeight ?? 0, top = scroller?.scrollTop ?? 0
    setHistoryBusy(true); setHistoryError(undefined); setFollowing(false)
    try {
      const page = await api.sessionSnapshot({ sessionID: props.sessionID, revision: current.revision, sourceEpoch: current.sourceEpoch, before: current.before })
      const latest = history()
      if (historyKey().join(":") !== owner || !latest || latest.sourceEpoch !== current.sourceEpoch || latest.before !== current.before) return
      queries.setQueryData(key, reconcileSessionHistory(latest, page, "older"))
      queueMicrotask(() => { if (historyKey().join(":") === owner && scroller?.isConnected && !following()) scroller.scrollTop = top + scroller.scrollHeight - height })
    } catch (cause) { if (historyKey().join(":") === owner) setHistoryError(failure(cause, "Older history could not be read. Refresh the transcript before retrying.")) }
    finally { if (historyKey().join(":") === owner) setHistoryBusy(false) }
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
    visibility = createPromptVisibility({ root: scroller, change: setInView })
    syncVisibility()
    dock = scroller.parentElement?.querySelector<HTMLDivElement>(".rl-dock") ?? undefined
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(scroller)
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild)
    const anchorDock = () => {
      if (!scroller || !dock) return
      const top = scroller.scrollTop
      scroller.scrollTop = following() ? scroller.scrollHeight : top
      scheduleMeasure()
    }
    const dockObserver = new ResizeObserver(anchorDock)
    if (dock) dockObserver.observe(dock)
    anchorDock()
    onCleanup(() => { visibility?.dispose(); visibility = undefined; observer.disconnect(); dockObserver.disconnect(); if (measureFrame !== undefined) cancelAnimationFrame(measureFrame) })
  })
  const update = (value: string) => { setText(value); setPasted(livePasted(value, pasted())); if (value) drafts.set(props.sessionID, value); else drafts.delete(props.sessionID) }
  const hold = (value: PendingDraft | undefined) => { setPending(value); if (value) pendings.set(props.sessionID, value); else pendings.delete(props.sessionID) }
  const [sendMode, setSendMode] = createSignal<"auto" | "queue" | "steer">("auto")
  const [stagedModel, setStagedModel] = createSignal<ModelSelection>()
  const [restoredAgents, setRestoredAgents] = createSignal<PromptAgent[]>([])
  const [picks, setPicks] = createSignal<MentionPick[]>([])
  const [files, setFiles] = createSignal<PromptFile[]>([])
  const [modelTick, setModelTick] = createSignal(0)
  const [variantTick, setVariantTick] = createSignal(0)
  const [slashNote, setSlashNote] = createSignal<string>()
  const [exportOpen, setExportOpen] = createSignal(false)
  const [sessionTool, setSessionTool] = createSignal<SessionTool>()
  const [sessionToolText, setSessionToolText] = createSignal<string>()
  const [sessionAssist, setSessionAssist] = createSignal<"prediction" | "generation">()
  onMount(() => { const pending = pendingAssistance(); if (pending?.sessionID !== props.sessionID) return; setSessionToolText(pending.text); setSessionAssist("generation"); setSessionTool("assist"); setPendingAssistance(undefined) })
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [manageBusy, setManageBusy] = createSignal(false)
  const [manageUncertain, setManageUncertain] = createSignal(false)
  const management = createActionGuard<SessionManageInput, Awaited<ReturnType<typeof api.manageSession>>>((prompt) => confirmInPage(prompt), () => `${scope().join(":")}:${props.sessionID}:${ownsConversation}`, (input) => api.manageSession(input))
  const recoveryGuard = createActionGuard<RequestReply, void>((prompt) => confirmInPage(prompt), () => `${scope().join(":")}:${props.sessionID}:${ownsConversation}`, (input) => api.reply(input))
  const resumeStopped = async (sessionID: string, itemID: string) => {
    const revision = connection().revision
    if (revision === undefined || !reading() || manageBusy() || manageUncertain()) return
    setManageBusy(true)
    try {
      const result = await recoveryGuard.run({ kind: "review", sessionID, revision, itemID, decision: { kind: "recovery", choice: "continue" } }, "Continue this stopped subagent through its recovery review?")
      if (result.status === "unconfirmed") { setManageUncertain(true); setSlashNote(failure(result.error, "Recovery was not confirmed. Refresh and review the subagent before trying again.")) }
      if (result.status === "completed") { activityRead.refetch(); requests.refetch() }
    } finally { setManageBusy(false) }
  }
  type SessionAction<T = SessionManageInput> = T extends SessionManageInput ? Omit<T, "revision" | "sessionID"> : never
  const manage = async (input: SessionAction, ownerSessionID = props.sessionID) => {
    const revision = connection().revision
    if (!reading() || revision === undefined || manageBusy() || manageUncertain()) return false
    setManageBusy(true)
    try {
      const result = await management.run({ ...input, revision, sessionID: ownerSessionID }, `${input.kind === "delete" ? "Permanently delete this Session and its descendants" : input.kind === "fork" ? "Fork this Session" : input.kind === "rename" ? `Rename this Session to ${input.title}` : input.kind === "move" ? `Move this Session to ${input.directory}` : input.kind}?`)
      if (result.status === "unconfirmed") { setManageUncertain(true); setSlashNote(failure(result.error, "The Session action was not confirmed. Reopen the Session before retrying.")); return false }
      if (result.status !== "completed") return false
      sessionRead.refetch(); sessions.refetch(); activityRead.refetch(); if (reportedTaskIDs().length) childSessionsRead.refetch(); refresh(["projects"]); refresh(["workspaces"])
      setSessionDialog(undefined)
      if (input.kind === "fork" && result.value.item) void navigate({ to: "/sessions/$sessionID", params: { sessionID: result.value.item.id } })
      if (input.kind === "delete") void navigate({ to: "/sessions" })
      return true
    } finally { setManageBusy(false) }
  }
  const jumpToTurn = (id: string) => { setFindQuery(""); setFollowing(false); setSessionDialog(undefined); queueMicrotask(() => { const turn = document.getElementById(`turn-${id}`); turn?.focus({ preventScroll: true }); turn?.scrollIntoView({ block: "start" }) }) }
  const navigateSibling = async (direction: 1 | -1) => {
    const parentID = session()?.parentID ?? props.sessionID
    const owner = scope().join(":")
    let page = await api.activity({ sessionID: parentID })
    const ids = new Set(page.subagents.map((task) => task.sessionID))
    for (let count = 0; page.subagentNext && count < 50; count++) {
      if (scope().join(":") !== owner || !reading()) return false
      page = await api.activity({ sessionID: parentID, revision: page.revision, cursor: page.subagentNext })
      for (const task of page.subagents) ids.add(task.sessionID)
    }
    if (scope().join(":") !== owner || !reading() || page.revision !== connection().revision) return false
    if (page.subagentNext) throw new Error("The subagent list is incomplete. Open Activity to select a Session.")
    const siblings = [...ids].sort()
    const index = siblings.indexOf(props.sessionID)
    const target = siblings.length ? siblings[index < 0 ? direction === 1 ? 0 : siblings.length - 1 : (index + direction + siblings.length) % siblings.length] : undefined
    if (!target) { setSlashNote("No subagent Sessions are available."); return true }
    await navigate({ to: "/sessions/$sessionID", params: { sessionID: target } })
    return true
  }
  const executeSlash = async (action: Exclude<SlashAction, { kind: "prompt" }>): Promise<boolean> => {
    if (action.kind === "backend") {
      if (activeRevert()) { setSlashNote("Resolve the staged revert before running commands."); return false }
      try {
        const mentioned = expandPastedPrompt(text(), picks(), pasted())
        const attached = promptFilesFor(files(), mentioned.files)
        const agents = [...restoredAgents(), ...mentioned.agents]
        await api.command({ sessionID: props.sessionID, promptID: `msg_${crypto.randomUUID()}`, command: action.name, ...(action.args ? { arguments: action.args } : {}), ...(attached.length ? { files: attached } : {}), ...(agents.length ? { agents } : {}), ...(sendMode() !== "auto" ? { delivery: sendMode() as "queue" | "steer" } : {}), ...(stagedModel() ? { model: stagedModel()! } : {}) })
        setFiles([]); setRestoredAgents([]); setStagedModel(undefined)
        sessionRead.refetch(); refresh(["messages", ...scope(), props.sessionID])
        return true
      } catch (cause) { setError(failure(cause, "The command was not confirmed. Check the Session before running it again.")); return false }
    }
    if (await commonCommand(action.name, action.args, { source: props.sessionID, sessionID: props.sessionID, directory: session()?.location.directory, insert: (value) => update(text() + value) }, (to) => void navigate({ to }))) return true
    switch (action.name) {
      case "models": setModelTick((tick) => tick + 1); return true
      case "rename": if (action.args.trim()) return manage({ kind: "rename", title: action.args.trim() }); setSessionTitle(session()?.title ?? ""); setSessionDialog("rename"); return true
      case "fork": return manage({ kind: "fork" })
      case "archive": return manage({ kind: "archive" })
      case "unarchive": return manage({ kind: "unarchive" })
      case "delete": return manage({ kind: "delete" })
      case "move": openFolderPicker({ title: "Move Session to folder", mode: "directory", initialDirectory: session()?.location.directory, onPick: async (directory) => { await manage({ kind: "move", directory }) } }); return true
      case "cd": if (!action.args.trim()) { setSlashNote("Add an absolute working directory after /cd."); return false } return manage({ kind: "move", directory: action.args.trim() })
      case "editor": { const owner = scope().join(":"); await editPrompt({ directory: session()?.location.directory, draft: () => ({ text: /^\/editor\s*$/.test(text()) ? "" : expandPastedText(text(), pasted()), files: files(), agents: restoredAgents(), picks: picks() }), update: (draft) => { update(draft.text); setPasted([...(draft.pasted ?? [])]); setFiles([...(draft.files ?? [])]); setRestoredAgents([...(draft.agents ?? [])]); setPicks([...(draft.picks ?? [])]) } }, () => ownsConversation && owner === scope().join(":") && !pending()); return true }
      case "btw": setSessionToolText(action.args); setSessionTool("sidechat"); return true
      case "btw-send": if (session()?.agent !== "btw" || !session()?.parentID) { setSlashNote("Send to main chat is available only in a BTW side chat."); return false } setSessionToolText(action.args); setSessionTool("steer-parent"); return true
      case "suggest": case "prompt": setSessionToolText(action.args); setSessionAssist(action.name === "suggest" ? "prediction" : "generation"); setSessionTool("assist"); return true
      case "daybreak": if (["blue", "red", "off"].includes(action.args)) return manage({ kind: "daybreak", daybreak: action.args === "blue" ? "daybreak_blue" : action.args === "red" ? "daybreak_red" : null }); setSessionDialog("daybreak"); return true
      case "undo": {
        const previous = () => history()?.messages.findLast((message) => message.type === "user" && message.text.trim() && (!activeRevert() || message.id < activeRevert()!.messageID))
        let message = previous()
        for (let count = 0; !message && history()?.before && count < 50; count++) { const before = history()?.before; await loadOlder(); if (before === history()?.before) break; message = previous() }
        if (message?.type !== "user") { setSlashNote("No earlier user message is available to undo."); return true }
        setSelectedTurn(message.id)
        if (!(await doRevert("stage", message.id, true))) return false
        const draft = restoredPrompt(message)
        update(draft.text)
        setPasted([])
        setFiles(draft.files)
        setRestoredAgents(draft.agents)
        setPicks(draft.picks)
        return true
      }
      case "redo": if (activeRevert()) return doRevert("clear"); setSlashNote("No revert is staged."); return true
      case "terminals": setSessionToolText(undefined); setSessionAssist(undefined); setSessionTool("terminals"); return true
      case "session-actions": setSessionToolText(undefined); setSessionAssist(undefined); setSessionTool("assist"); return true
      case "processes": setSessionDialog("activity"); return true
      case "background": if (!running()) { setSlashNote("This Session is not running."); return false } return manage({ kind: "background" })
      case "variants": {
        const owner = scope().join(":")
        const catalog = await queries.ensureQueryData({ queryKey: ["models", ...scope(), props.sessionID], queryFn: () => api.models(props.sessionID) })
        if (!ownsConversation || !reading() || scope().join(":") !== owner || catalog.revision !== connection().revision) return false
        setVariantTick((tick) => tick + 1); setModelTick((tick) => tick + 1); return true
      }
      case "parent": if (session()?.parentID) await navigate({ to: "/sessions/$sessionID", params: { sessionID: session()!.parentID! } }); else setSlashNote("This Session has no parent."); return true
      case "next-child": return navigateSibling(1)
      case "previous-child": return navigateSibling(-1)
      case "find": setFindOpen(true); setFindQuery(action.args); queueMicrotask(() => document.querySelector<HTMLInputElement>(".conversation__find input")?.focus()); return true
      case "timeline": setSessionDialog("timeline"); return true
      case "stash": setStashDialog({ draft: () => ({ text: text(), files: files(), agents: restoredAgents(), picks: picks(), pasted: livePasted(text(), pasted()) }), update: (draft) => { update(draft.text); setPasted([...(draft.pasted ?? [])]); setFiles([...(draft.files ?? [])]); setRestoredAgents([...(draft.agents ?? [])]); setPicks([...(draft.picks ?? [])]) }, directory: session()?.location.directory }); return true
      case "copy": {
        const starting = scope().join(":")
        const exported = await api.exportSession({ sessionID: props.sessionID, format: "markdown", thinking: thinkingExpanded() })
        if (scope().join(":") !== starting || exported.revision !== connection().revision || !reading()) throw new Error("The connection changed before the transcript was copied. Try again on the current backend.")
        await copyTextToClipboard(exported.content)
        setSlashNote("Copied the full transcript."); return true
      }
      case "export": setExportOpen(true); return true
      case "autonomous": {
        const mode = action.args
        if (mode === "manual" || mode === "auto" || mode === "yolo") await setPolicy({ permissions: mode, guardrails: mode, answers: mode }, `Change autonomy decisions to ${mode}/${mode}/${mode}?`)
        else openPolicy()
        return true
      }
      case "defer": {
        if (action.args && action.args !== "on" && action.args !== "off") { setSlashNote("Use /defer, /defer on or /defer off."); return false }
        const enabled = action.args === "on" || action.args !== "off" && !autonomy()?.effective.deferred
        await setPolicy({ defer: enabled }, enabled ? "Enable persistent deferral of unresolved decisions?" : "Disable deferral of unresolved decisions?")
        return true
      }
      case "goal": {
        if (action.args === "stop") await setPolicy({ goal: null }, "Stop the Session goal? Its text will be retained.")
        else if (action.args) await setPolicy({ goal: action.args }, "Replace the Session goal with this text?")
        else openPolicy()
        return true
      }
      case "compact": {
        if (activeRevert()) { setSlashNote("Resolve the staged revert before compacting."); return false }
        const owner = scope().join(":"), revision = connection().revision
        if (!(await confirmInPage("Compact this Session now? Earlier messages are replaced by a summary."))) return false
        if (!ownsConversation || !reading() || scope().join(":") !== owner || revision === undefined) return false
        try { await api.compact({ sessionID: props.sessionID, revision, compactionID: `cmp_${crypto.randomUUID()}` }); setSlashNote("Compaction requested."); refresh(["messages", ...scope(), props.sessionID]); return true }
        catch (cause) { setError(failure(cause, "Compaction was not confirmed. Check the Session before retrying.")); return false }
      }
    }
    return false
  }
  onMount(() => {
    const owner = {
      sessionID: props.sessionID,
      canSendToParent: () => session()?.agent === "btw" && !!session()?.parentID,
      interactionActions: () => {
        const view = interactionView()
        if (!view) return []
        const state = typeof view.status === "string" ? view.status : view.status.state
        const actions: PaletteAction[] = []
        if (state === "error") actions.push({ id: "interaction-refresh", group: "Session", label: "Refresh interaction status", icon: "refresh", keywords: "interaction browser macos chrome refresh status", run: () => interaction.refresh() })
        if (localInteraction() && (state === "unavailable" || state === "stopped") && view.busy === undefined) {
          actions.push({ id: "interaction-chrome", group: "Session", label: "Request Chrome control", icon: "globe", keywords: "interaction browser chrome control request", run: () => setChromeProposalOpen(true) })
          actions.push({ id: "interaction-macos", group: "Session", label: "Request macOS control", icon: "monitor", keywords: "interaction desktop macos control request", run: () => interaction.request({ platform: "macos" }) })
        }
        return actions
      },
      run: (name: string, args: string) => executeSlash({ kind: "local", name, args }),
    }
    setCommandOwner(owner)
    onCleanup(() => { if (commandOwner() === owner) setCommandOwner(undefined) })
  })
  createEffect(() => { void turns(); void requestCount(); scheduleMeasure() })
  const promptGuard = createPromptGuard<PendingDraft>({
    scope: () => `${scope().join(":")}:${props.sessionID}:${connection().status}:${ownsConversation}`,
    read: (sessionID) => api.session({ sessionID }),
    confirm: (prompt) => confirmInPage(prompt),
    observe: (revert) => { setStagedRevert(revert); sessionRead.refetch() },
    dispatch: async ({ owner, revision, steerNow, model, editor, ...draft }) => {
      if (!ownsConversation || owner !== scope().join(":") || revision !== connection().revision) throw new Error("The backend changed after this draft was captured. Check the original Session before sending again.")
      if (model) {
        const catalog = await api.models(props.sessionID)
        if (!ownsConversation || owner !== scope().join(":") || revision !== catalog.revision || !reading()) throw new Error("The backend changed before the staged model could be applied.")
        if (!("current" in catalog) || catalog.running) throw new Error("Stop the running turn before applying the staged reasoning effort.")
        if (!sameSelection(model, catalog.current)) await api.switchModel({ sessionID: props.sessionID, revision, model })
        if (!ownsConversation || owner !== scope().join(":") || revision !== connection().revision) throw new Error("The backend changed before the message was sent.")
        setStagedModel(undefined)
        refresh(["models", ...scope(), props.sessionID])
      }
      const admittedAt = performance.now()
      if (editor) {
        await api.sendEditorContext({ sessionID: props.sessionID, revision, promptID: editor.promptID, text: editor.text })
        if (!ownsConversation || owner !== scope().join(":") || revision !== connection().revision) throw new Error("The backend changed before the message was sent.")
        editorContext.markSent(editor.key)
      }
      await (steerNow ? api.prompt({ sessionID: props.sessionID, ...draft, steerNow: true, revision }) : api.prompt({ sessionID: props.sessionID, ...draft }))
      if (owner === scope().join(":")) telemetry.record("prompt.admit", performance.now() - admittedAt)
    },
  })
  const send = async (steerNow = false) => {
    const revision = connection().revision
    if (sending() || !reading() || revision === undefined || unsure() || revertBusy() || revertUncertain()) return
    if (pending() && (pending()!.owner !== scope().join(":") || pending()!.revision !== revision)) { setUnsure(true); setError("The backend changed after this draft was captured. Check the original Session before sending again."); return }
    if (steerNow && (!running() || pending())) return
    if (running() && (pending()?.model || stagedModel())) { setError("Stop the running turn before applying the staged reasoning effort."); return }
    const expanded = expandPastedPrompt(text(), picks(), pasted())
    if (!pending() && text().trim()) {
      const catalogKey = ["composer-catalog", ...scope(), props.sessionID] as const
      let action = composerSlash(expanded.text, (queries.getQueryData<ComposerCatalog>(catalogKey)?.commands ?? []).map((command) => command.name))
      if (action.kind === "prompt" && /^\/[A-Za-z0-9]/.test(expanded.text) && typeof api.composerCatalog === "function") {
        const cached = queries.getQueryData<ComposerCatalog>(catalogKey)
        if (!cached || cached.revision !== connection().revision) {
          setSending(true)
          try { const fresh = await api.composerCatalog(props.sessionID); if (fresh.revision === connection().revision) { queries.setQueryData(catalogKey, fresh); action = composerSlash(expanded.text, fresh.commands.map((command) => command.name)) } }
          catch (cause) { setError(failure(cause, "Commands could not be read. Retry after refreshing.")); return }
          finally { setSending(false) }
        }
      }
      if (action.kind !== "prompt") {
        setSending(true); setError(undefined); setSlashNote(undefined)
        try { if (await executeSlash(action) && action.name !== "undo" && action.name !== "editor") { update(""); setPicks([]) } } catch (cause) { setError(failure(cause, "The command was not confirmed.")) } finally { setSending(false) }
        return
      }
    }
    const mentioned = pending() ? undefined : { files: expanded.files, agents: expanded.agents }
    const payload = mentioned ? { ...mentioned, agents: [...restoredAgents(), ...mentioned.agents], files: promptFilesFor(files(), mentioned.files) } : undefined
    const delivery = steerNow ? "steer" : sendMode()
    const editor = pending() ? undefined : editorContext.capture()
    const draft = pending() ?? (text().trim() ? { owner: scope().join(":"), revision, promptID: `msg_${crypto.randomUUID()}`, text: expanded.text, ...(stagedModel() ? { model: stagedModel()! } : {}), ...(delivery === "auto" ? {} : { delivery }), ...(steerNow ? { steerNow: true as const } : {}), ...(payload?.files.length ? { files: payload.files } : {}), ...(payload?.agents.length ? { agents: payload.agents } : {}) } : undefined)
    if (!draft) return
    const captured = { ...draft, ...(editor ? { editor } : {}) }
    hold(captured)
    setSending(true)
    setError(undefined)
    setRevertNotice(undefined)
    const result = await promptGuard.run(props.sessionID, revision, activeRevert(), captured)
    if (result.status === "completed") {
      batch(() => {
        hold(undefined)
        setPicks([])
        setFiles([])
        setRestoredAgents([])
        update("")
        setStagedRevert(undefined)
        setFollowing(true)
      })
      sessionRead.refetch()
      refresh(["messages", ...scope(), props.sessionID])
      queueMicrotask(() => { if (!document.activeElement || document.activeElement === document.body || document.activeElement.closest(".rl-send")) document.querySelector<HTMLTextAreaElement>(".rl-capsule textarea")?.focus() })
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
  const deliveries = createMemo(() => userDeliveryStates(history()?.messages ?? [], sending() ? pending()?.promptID : undefined))
  const [pendingBusy, setPendingBusy] = createSignal<string>()
  const [pendingNote, setPendingNote] = createSignal<string>()
  const actOnPending = async (kind: "remove" | "steer", messageID: string) => {
    if (pendingBusy() || !reading()) return
    setPendingBusy(messageID)
    setPendingNote(undefined)
    try { await (kind === "remove" ? api.removePending({ sessionID: props.sessionID, messageID }) : api.steerPending({ sessionID: props.sessionID, messageID })) }
    catch (cause) { setPendingNote(failure(cause, "The pending message could not be changed. The list was refreshed.")) }
    finally { setPendingBusy(undefined); pendingRead.refetch() }
  }
  const feedbackVisible = () => !!(error() || slashNote() || revertUncertain() || !reading() || (stagedModel() && running()) || (unsure() && !sending()) || (pending() && !sending() && !unsure()) || stopNote())
  const transientActivity = () => desktopTransientActivity({ active: reading() && !executionStates().has(props.sessionID) && running(), sending: sending(), messages: history()?.messages ?? [], shells: activityView()?.shells.filter(shell => shell.ownerSessionID === props.sessionID) ?? [] })
  return <section class="conversation" aria-labelledby="conversation-title" data-team-open={teamOpen()}>
    <Show when={exportOpen()}><SessionExportDialog sessionID={props.sessionID} onClose={() => setExportOpen(false)} /></Show>
    <Show when={sessionTool()}>{(tool) => <SessionToolsDialog sessionID={props.sessionID} parentID={session()?.agent === "btw" ? session()?.parentID : undefined} editorContext={editorContext} initial={tool()} initialText={sessionToolText()} initialAssist={sessionAssist()} running={running()} hasRevert={!!activeRevert()} text={text} update={update} onClose={() => setSessionTool(undefined)} onOpen={(id) => void navigate({ to: "/sessions/$sessionID", params: { sessionID: id } })} />}</Show>
    <Show when={sessionDialog()}>{(kind) => <DesktopDialog title={kind() === "timeline" ? "Session timeline" : kind() === "activity" ? "Session processes" : kind() === "daybreak" ? "Daybreak schedule" : "Rename Session"} onClose={() => setSessionDialog(undefined)}>
      <Show when={kind() === "rename"}><form onSubmit={(event) => { event.preventDefault(); if (sessionTitle().trim()) void manage({ kind: "rename", title: sessionTitle().trim() }) }}><label class="rl-field"><span>Session title</span><input value={sessionTitle()} onInput={(event) => setSessionTitle(event.currentTarget.value)} /></label><button type="submit" class="rl-btn" disabled={manageBusy() || manageUncertain() || !sessionTitle().trim()}>Rename</button></form></Show>
      <Show when={kind() === "daybreak"}><For each={["blue", "red", "off"] as const}>{(mode) => <button type="button" class="rl-btn" disabled={manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "daybreak", daybreak: mode === "blue" ? "daybreak_blue" : mode === "red" ? "daybreak_red" : null })}>{mode === "off" ? "Turn off" : `${mode} daybreak`}</button>}</For></Show>
      <Show when={kind() === "timeline"}><p>Only loaded history is listed.</p><ul class="desktop-dialog__entries"><For each={visibleDesktopMessages(history()?.messages ?? [])}>{(message) => <li><p>{message.type} · {transcriptText(message).slice(0, 180)}</p><button type="button" class="rl-btn" onClick={() => jumpToTurn(message.id)}>Jump to turn</button><button type="button" class="rl-btn" disabled={manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "fork", messageID: message.id })}>Fork from this message</button></li>}</For></ul></Show>
      <Show when={kind() === "activity"}>
        <Show when={activityRead.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading Session processes…" /></Show>
        <Show when={activityRead.result().isError}><p role="alert">Activity could not be read.</p></Show>
        <button type="button" class="rl-btn" onClick={activityRead.refetch}>Refresh activity</button>
        <button type="button" class="rl-btn" disabled={!running() || manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "background" })}>Run in background</button>
        <h3>Shells</h3><For each={activityView()?.shells ?? []} fallback={<p>No attributed shells.</p>}>{(shell) => <div class="st-row"><span>{shell.command} · {shell.status}</span><button type="button" class="rl-btn" disabled={shell.status !== "running" || manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "kill-shell", shellID: shell.id }, shell.ownerSessionID)}>Kill shell</button></div>}</For>
        <h3>Subagents</h3><For each={activityView()?.subagents ?? []} fallback={<p>No subagents.</p>}>{(task) => <section class="st-section"><p>{task.description} · {task.state}</p><button type="button" class="rl-btn" onClick={() => void navigate({ to: "/sessions/$sessionID", params: { sessionID: task.sessionID } })}>Open subagent Session</button><button type="button" class="rl-btn" disabled={!["running", "waiting"].includes(task.state) || manageBusy() || manageUncertain()} onClick={() => void manage({ kind: "cancel-subagent", childSessionID: task.sessionID })}>Cancel subagent</button>
          <Show when={task.stoppedRecovery}>{(recovery) => <button type="button" class="rl-btn" disabled={manageBusy() || manageUncertain()} onClick={() => void resumeStopped(task.sessionID, recovery().itemID)}>Continue stopped subagent</button>}</Show>
          <Show when={task.state === "waiting" ? task.question : undefined}>{(question) => {
            const key = () => `${task.sessionID}:${question().id}`
            return <form onSubmit={(event) => { event.preventDefault(); const text = subagentAnswers()[key()]?.trim(); if (text) void manage({ kind: "answer-subagent", childSessionID: task.sessionID, questionID: question().id, text }) }}><label class="rl-field"><span>{question().text}</span><textarea value={subagentAnswers()[key()] ?? ""} disabled={manageBusy() || manageUncertain()} onInput={(event) => { const value = event.currentTarget.value; setSubagentAnswers((previous) => ({ ...previous, [key()]: value })) }} /></label><button type="submit" class="rl-btn" disabled={manageBusy() || manageUncertain() || !subagentAnswers()[key()]?.trim()}>Answer subagent</button></form>
          }}</Show>
        </section>}</For>
        <Show when={activityView()?.subagentNext}><button type="button" class="rl-btn" disabled={activityMoreBusy()} onClick={() => void loadMoreSubagents()}>Load more subagents</button></Show>
        <Show when={activityMoreError()}><p role="alert">{activityMoreError()}</p></Show>
      </Show><Show when={slashNote()}><p role="status">{slashNote()}</p></Show>
    </DesktopDialog>}</Show>
    <SharedConversationHeader class="conversation__head rl-top" menu={<ListToggle />} actions={<div class="rl-top-actions"><button type="button" class="rl-icon-button" aria-label={teamOpen() ? "Show conversation" : "Show Team"} data-tooltip={teamOpen() ? "Show conversation" : "Show Team"} aria-pressed={teamOpen()} onClick={() => { setTeamOpen(!teamOpen()); setCompanionOpen(false) }}><Icon name="team" /><span class="desktop__sr">{teamOpen() ? "Conversation" : "Team"}</span></button><SharedContextRingButton class="rl-context-ring" ariaLabel="Toggle session context" expanded={companionOpen() && companionTab() === "Context"} fraction={!context() || context()?.stale ? 0 : context()!.used / context()!.limit} label={<Show when={context()?.stale ? undefined : context()} fallback="Unknown">{(value) => <><strong>{formatCompactCount(value().used)}</strong><small>{percent(value().used, value().limit)}%</small></>}</Show>} onClick={() => { const closing = companionOpen() && companionTab() === "Context"; setTeamOpen(false); setCompanionTab("Context"); setCompanionOpen(!closing) }} /><button type="button" class="rl-icon rl-companion-toggle" aria-label={companionOpen() ? "Close Session companion" : "Open Session companion"} aria-expanded={companionOpen()} onClick={() => { setTeamOpen(false); setCompanionOpen(!companionOpen()) }}><Icon name="panel-left" /></button><CommandMenuButton /></div>}><SharedTrace running={running()} branch={runningChildren() > 0} /><div class="rl-ident">
      <h1 id="conversation-title" class="rl-title" tabindex="-1" ref={focusHeading}>{session()?.title ?? "Session"}</h1>
      <Show when={sessionRead.result().isError}><div role="alert" class="desktop__error"><p>{failure(sessionRead.result().error, "The Session could not be read. Refresh to retry.")}</p><button type="button" onClick={sessionRead.refetch} disabled={!reading()}>Refresh Session</button></div></Show>
      <Show when={session()}>{(item) => <>
        <p class="rl-presence" data-tone={running() ? "busy" : "idle"}><span>{workspaceBase(item().location.directory)} · {connectionOwnership()}</span></p>
      </>}</Show>
      </div></SharedConversationHeader><div class="rl-notices">
      <Show when={interactionControlVisible(interactionView()) ? interactionView() : undefined}>{(view) => <InteractionControl view={view()} inlinePreview={!interactionDocked()} onReveal={revealInteraction} onStop={interaction.stop} onResume={interaction.resume} onRefresh={interaction.refresh} onRequest={localInteraction() ? (platform) => {
        if (platform === "chrome") setChromeProposalOpen(true)
        if (platform === "macos") interaction.request({ platform })
      } : undefined} />}</Show>
      <Show when={chromeProposalOpen() && localInteraction()}>
        <ChromeInteractionProposal onClose={() => setChromeProposalOpen(false)} onRequest={(payload) => { setChromeProposalOpen(false); interaction.request(payload) }} />
      </Show>
      <Show when={findOpen()}><div class="conversation__find"><label class="rl-field"><span class="desktop__sr">Find in transcript</span><span class="rl-input-icon"><Icon name="search" /><input type="search" placeholder="Find in transcript…" value={findQuery()} onInput={(event) => setFindQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { setFindQuery(""); setFindOpen(false) } }} /></span></label><small role="status">{turns().length} matching turns</small><button type="button" class="rl-btn" onClick={() => setFindQuery("")}>Clear</button><button type="button" class="rl-icon-button" aria-label="Close find" onClick={() => { setFindQuery(""); setFindOpen(false) }}><Icon name="close" /></button></div></Show>
      <Show when={unsure()}><p role="status" class="conversation__notice">The pre-send check or message was not confirmed. Review the transcript and staged revert before continuing.</p></Show><Show when={activeRevert()}>{(value) => <p role="status" class="conversation__notice">A revert to message {value().messageID} is staged. Sending a message will commit the revert and remove later turns.</p>}</Show><Show when={revertNotice()}>{(notice) => <p role="status" class="conversation__notice">{notice()}</p>}</Show>
      <Show when={requestCount() > 0}><p role="status" class="conversation__notice" data-state="needs">This Session is waiting for you: {requestCount()} {requestCount() === 1 ? "request is" : "requests are"} below the transcript.</p></Show>
      <Show when={unanswerable()}><p role="status" class="conversation__notice" data-state="needs">This Session also has a guardrail review or question that the desktop app cannot answer yet. Answer it in the terminal or the web app.</p></Show>
      <Show when={linkNote()}>{(note) => <p role="status" class="conversation__notice">{note()}</p>}</Show><Show when={subagentsWaiting().length}><p role="status" class="conversation__notice" data-state="needs">A subagent Session of this chat is waiting for you. Its request belongs to that Session and is answered there:{" "}
        <For each={subagentsWaiting()}>{(row) => <Link to="/sessions/$sessionID" params={{ sessionID: row.id }} class="conversation__link">{row.title}</Link>}</For></p></Show>
    </div>

    <p class="desktop__sr" role="status"><Show when={announcement()} keyed>{(entry) => <span>{entry.text}</span>}</Show></p>
    <Show when={teamOpen()}><TeamView viewRef={view => { teamView = view }} sessionID={props.sessionID} data={activityView()} loading={activityRead.result().isPending} error={activityRead.result().isError ? failure(activityRead.result().error, "Team activity could not be read.") : undefined} busy={manageBusy() || manageUncertain()} onAnswer={(task, text) => task.question ? manage({ kind: "answer-subagent", childSessionID: task.sessionID, questionID: task.question.id, text }) : Promise.resolve(false)} onOpen={id => void navigate({ to: "/sessions/$sessionID", params: { sessionID: id } })} onRefresh={activityRead.refetch} onMore={() => void loadMoreSubagents()} moreBusy={activityMoreBusy()} moreError={activityMoreError()} /></Show>
    <div class="conversation__scroll rl-scroll" ref={scroller} onClick={copyTranscriptLink} onScroll={onScroll} onWheel={() => { jumping = false }} onTouchStart={() => { jumping = false }} onPointerDown={() => { jumping = false }}><PromptRail prompts={ticks()} visible={inView()} onSelect={selectPrompt} /><div class="rl-col conversation__column"><div class="rl-thread">
      <Show when={history()?.before}><button type="button" class="rl-btn" disabled={historyBusy() || !reading()} onClick={() => void loadOlder()}>{historyBusy() ? "Reading older history…" : "Load older messages"}</button></Show>
      <Show when={historyError()}><p role="alert">{historyError()}</p></Show>
      <Show when={!messages.result().isPending} fallback={<SharedLoadingSkeleton kind="conversation" label="Loading the transcript…" />}><Show when={!messages.result().isError} fallback={<div role="alert" class="desktop__error"><p>{failure(messages.result().error, "The transcript could not be read. Check the connection and refresh.")}</p><button type="button" onClick={messages.refetch} disabled={!reading()}>Refresh transcript</button></div>}>
        <Show when={turns().length} fallback={<div class="desktop-empty-transcript" role="status" aria-label="Empty transcript"><Icon name="chat" /><p>No messages in this Session yet.</p></div>}><ol class="transcript rl-thread" aria-label="Transcript"><Keyed each={turns()} by={(item) => item.id}>{(item) => <>
          <For each={recallRows().before.get(item().id) ?? []}>{(record) => <RecallTurn record={record} />}</For>
          <TurnView sessionID={props.sessionID} message={item()} continuation={!findQuery().trim() && continuations().has(item().id)} delivery={deliveries().get(item().id)} onDelete={deleteMessage} onOpenApp={openCompanionApp} />
          <Show when={editPlacements().get(item().id)}>{(edit) => <li class="transcript__turn transcript__edits"><SharedEditedFilesCard files={edit().files} onViewChanges={(path) => { setSelectedTurn(edit().turnID); openChanges(path) }} onUndo={() => { setSelectedTurn(edit().turnID); openChanges(); void doRevert("stage") }} undoDisabled={revertBusy() || revertUncertain() || running()} footerNote={activeRevert() ? "Staged revert · preview and confirmation required" : undefined} /></li>}</Show></>}</Keyed><For each={recallRows().tail}>{(record) => <RecallTurn record={record} />}</For></ol></Show>
      </Show></Show>
      <Show when={requests.result().isError}><div role="alert" class="desktop__error"><p>Pending requests could not be read. Refresh to retry.</p><button type="button" onClick={requests.refetch} disabled={!reading()}>Refresh requests</button></div></Show>
      <Show when={requests.result().data && !pendingRequests()}><p role="status">Refreshing requests after a connection change…</p></Show>
      <Show when={pendingRead.result().isPending && reading()}><SharedLoadingSkeleton kind="list" label="Reading pending inputs…" /></Show>
      <Show when={pendingRead.result().isError}><p role="alert">{failure(pendingRead.result().error, "Pending inputs could not be read.")}<button type="button" class="rl-btn" disabled={!reading()} onClick={pendingRead.refetch}>Refresh pending inputs</button></p></Show>
      <Show when={pendingRequests()}>{(data) => <Requests data={data()} updatedAt={requests.result().dataUpdatedAt} refetch={requests.refetch} />}</Show>
      <GlobalRequests directory={session()?.location.directory} workspace={session()?.location.workspaceID} />
      <Show when={transientActivity()}>{label => <div class="desktop-transient-activity" role="status" aria-label="Current activity"><NativeActivityRow label="YCoding" active>{label()}</NativeActivityRow></div>}</Show>
    </div></div></div>
    <div class="rl-dock"><div class="conversation__jump-slot" ref={jumpSlot}><JumpControls clearance={clearance()} onTop={!teamOpen() && targets().top ? jumpToTop : undefined} onBottom={!teamOpen() && targets().bottom ? jumpToLatest : undefined} /></div><div class="rl-col"><Show when={teamOpen()}><div class="desktop-master-composer"><span>Master Session Direct Prompting · Target: {props.sessionID}</span><button type="button" class="rl-icon-button" aria-label="Scroll Team to top" data-tooltip="Scroll Team to top" onClick={() => { const position = { top: 0, behavior: jumpBehavior() }; teamView?.scrollTo(position); teamView?.querySelector(".desktop-team-main")?.scrollTo(position) }}><Icon name="arrow-up" /></button></div></Show>
    <PendingTray items={userPendingInputs(pendingInputs()?.items ?? [])} busy={pendingBusy()} note={pendingNote()} onRemove={(id) => void actOnPending("remove", id)} onSteer={(id) => void actOnPending("steer", id)} />
    <DesktopComposerSurface formClass="composer" busy={sending()} hasFeedback={feedbackVisible()} onSubmit={(event) => { event.preventDefault(); void send() }} field={<div class="rl-capsule" data-composer-frame>
      <ComposerField label="Message" value={pending()?.text ?? text()} locked={!!pending() || sending()} source={props.sessionID} directory={session()?.location.directory ?? ""} localCommands={localSlash} picks={picks()} onPicks={setPicks} pasted={pasted()} onPasted={setPasted} onInput={update} onSubmit={() => void send()} onAttachFiles={(added) => setFiles((current) => mergeTransferredFiles(current, added))} />
      <EditorContextControl context={editorContext} disabled={!!pending() || sending()} />
      <Show when={restoredAgents().length}><div class="composer-attachments" aria-label="Restored agent attachments"><For each={restoredAgents()}>{(agent) => <span class="composer-attachments__chip"><Icon name="user" /><span>{agent.name}</span><button type="button" class="rl-icon" aria-label={`Remove agent ${agent.name}`} disabled={!!pending() || sending()} onClick={() => setRestoredAgents((agents) => agents.filter((item) => item !== agent))}><Icon name="close" /></button></span>}</For></div></Show>
      <ComposerAttachments files={files()} onChange={setFiles} locked={!!pending() || sending()} />
      <ComposerToolbar class="composer-bar" leading={<AttachButton directory={session()?.location.directory} files={files()} onChange={setFiles} locked={!!pending() || sending()} />} trailing={<>
          <DesktopSelect label="Send mode" value={pending() ? pending()!.delivery ?? "auto" : sendMode()} disabled={sending() || !!pending() || !reading()} options={[{ value: "auto", label: "Auto", description: "Use the backend delivery policy" }, { value: "queue", label: "Queue", description: "Wait behind pending messages" }, { value: "steer", label: "Steer", description: "Continue at the next step boundary" }]} onChange={(value) => { if (value === "auto" || value === "queue" || value === "steer") setSendMode(value) }} />
          <button type={running() ? "button" : "submit"} class="rl-send desktop__primary" data-stopping={running() ? "true" : undefined} aria-label={running() ? stopping() ? "Stopping generation" : "Stop generation" : sending() ? "Sending" : pending() ? "Retry sending" : "Send prompt"} disabled={running() ? stopping() || !reading() : sending() || !reading() || unsure() || revertBusy() || revertUncertain() || (!pending() && !text().trim())} onClick={(event) => { if (running()) { event.preventDefault(); void stop() } }}><Icon name={running() ? "stop" : "arrow-up"} /></button>
        </>}>
        <Show when={session()}>{(item) => <ModelPicker sessionID={props.sessionID} model={item().model} running={running()} agent={item().agent} autonomyLabel={policyLabels().autonomy} onAutonomy={() => policyOpen() ? closePolicy(true) : openPolicy()} onStageModel={setStagedModel} openTick={modelTick()} cycleTick={variantTick()} />}</Show>
        <span class="composer-live-action" data-visible={running() ? "true" : undefined}><Show when={running()}><button type="button" class="rl-btn" aria-label="Send and steer now" disabled={sending() || !!pending() || !reading() || unsure() || revertBusy() || revertUncertain() || !!stagedModel() || !text().trim()} onClick={() => void send(true)}>Steer now</button></Show></span>
        <Show when={session()}>{item => <span class="composer-metrics"><span class="desktop__sr">Session tokens, cumulative across the whole Session and not the context window: </span>{usage(item())}</span>}</Show>
      </ComposerToolbar></div>} feedback={<>
      <Show when={stagedModel() && running()}><p role="status">Stop the running turn before applying the staged reasoning effort to the next message.</p></Show>
      <Show when={error()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show><Show when={slashNote()}>{(note) => <p role="status">{note()}</p>}</Show><Show when={revertUncertain()}><p role="status">Review the Session and staged revert before continuing.</p></Show><Show when={!reading()}><p role="status">Reconnecting. Sending resumes when the backend is connected.</p></Show>
      <Show when={(unsure() && !sending()) || (pending() && !sending() && !unsure()) || stopNote()}><div class="desktop__actions">
        <Show when={unsure() && !sending()}><button type="button" onClick={() => { update(pending()?.text ?? text()); hold(undefined); promptGuard.reset(); unconfirmed.delete(props.sessionID); setUnsure(false); setRevertUncertain(false); setError(undefined); sessionRead.refetch() }}>I reviewed the Session</button></Show><Show when={pending() && !sending() && !unsure()}><button type="button" onClick={() => { update(pending()?.text ?? ""); hold(undefined); setError(undefined) }}>Edit as a new message</button></Show>
        <Show when={stopNote()}>{(note) => <span role="status" class="desktop__muted">{note()}</span>}</Show></div></Show></>} />
    <Show when={policyOpen()}><ResponsiveLayer class="desktop-popover rl-policy-panel" role="dialog" label="Goal and autonomy" onClose={() => closePolicy(true)} onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); closePolicy(true) } }}><div class="rl-pane-section-heading"><strong>Goal and autonomy</strong><button type="button" class="rl-btn" onClick={() => closePolicy(true)}>Close</button></div><Show when={!autonomy()}><p role="status">Goal and autonomy are unavailable until the Session state is read.</p><Show when={autonomyRead.result().isError}><button type="button" class="rl-btn" onClick={autonomyRead.refetch}>Refresh</button></Show></Show><Show when={autonomy()}><p class="model-popover__label">Permissions</p><SharedRadioGroup label="Permissions" options={decisionModes} value={permissions()} disabled={policyBusy() || policyUncertain()} onChange={(value) => setPermissions(value as "manual" | "auto" | "yolo")} /><p class="model-popover__label">Guardrails</p><SharedRadioGroup label="Guardrails" options={decisionModes} value={guardrails()} disabled={policyBusy() || policyUncertain()} onChange={(value) => setGuardrails(value as "manual" | "auto" | "yolo")} /><p class="model-popover__label">Answers</p><SharedRadioGroup label="Answers" options={decisionModes} value={answers()} disabled={policyBusy() || policyUncertain()} onChange={(value) => setAnswers(value as "manual" | "auto" | "yolo")} /><div class="rl-policy-actions"><button type="button" class="rl-btn" disabled={policyBusy() || policyUncertain() || !reading()} onClick={() => void setPolicy({ permissions: permissions(), guardrails: guardrails(), answers: answers() }, `Change autonomy decisions to ${permissions()}/${guardrails()}/${answers()}?`)}>Apply autonomy</button><button type="button" class="rl-btn" disabled={policyBusy() || policyUncertain() || !reading()} aria-pressed={!!autonomy()?.effective.deferred} onClick={() => void setPolicy({ defer: !autonomy()?.effective.deferred }, autonomy()?.effective.deferred ? "Disable deferral of unresolved decisions?" : "Enable persistent deferral of unresolved decisions?")}>{autonomy()?.effective.deferred ? "Defer on" : "Defer off"}</button></div><label class="desktop__field">Goal<textarea value={policyGoal()} disabled={policyBusy() || policyUncertain()} onInput={(event) => setPolicyGoal(event.currentTarget.value)} /></label><div class="rl-policy-actions"><button type="button" class="rl-btn" disabled={policyBusy() || policyUncertain() || !reading() || !policyGoal().trim()} onClick={() => void setPolicy({ goal: policyGoal().trim() }, "Replace the Session goal with this text?")}>Set goal</button><button type="button" class="rl-btn" disabled={policyBusy() || policyUncertain() || !reading() || (!autonomy()?.goal || autonomy()?.goal?.status === "stopped")} onClick={() => void setPolicy({ goal: null }, "Stop the Session goal? Its text will be retained.")}>Stop goal</button></div></Show><Show when={policyError()}>{(error) => <p role="alert">{error()}</p>}</Show></ResponsiveLayer></Show></div></div>
    <Show when={companionOpen()}><aside class="rl-companion" aria-label="Session companion" data-full={fullChangesOpen() && companionTab() === "Changes" ? "true" : undefined}>
      <DesktopCompanion
        runningContent={<RunningActivity sessionID={props.sessionID} data={activityView()} loading={activityRead.result().isPending} error={activityRead.result().isError ? failure(activityRead.result().error, "Running work could not be read.") : undefined} onRefresh={activityRead.refetch} onMore={() => void loadMoreSubagents()} loadingMore={activityMoreBusy()} moreError={activityMoreError()} onOpen={(id) => void navigate({ to: "/sessions/$sessionID", params: { sessionID: id } })} onShell={(id) => { setCompanionTab("Activity"); selectShell(id) }} />}
        policyActions={policyButtons()} active={companionTab().toLowerCase() as "activity" | "running" | "changes" | "context"}
        onSelect={(tab) => setCompanionTab(tab === "activity" ? "Activity" : tab === "running" ? "Running" : tab === "changes" ? "Changes" : "Context")}
        headerActions={<button type="button" class="rl-icon" aria-label="Close companion" onClick={() => setCompanionOpen(false)}><Icon name="close" /></button>}
        onRefresh={() => { if (reading()) { activityRead.refetch(); sessions.refetch(); if (reportedTaskIDs().length) childSessionsRead.refetch(); messages.refetch(); requests.refetch(); pendingRead.refetch(); insightsRead.refetch() } }}
        activityContent={<div class="rl-pane-body">
          <Show when={companionApp()?.scope === appScope() ? companionApp() : undefined}>{(app) => <section aria-label="MCP App in companion"><button type="button" class="rl-btn" onClick={() => setCompanionApp(undefined)}>Close App</button><McpApp view={app().view} fallback={<pre><code>{app().text}</code></pre>} /></section>}</Show>
          <Show when={interactionDocked() && companionTab() === "Activity" && interactionView()?.revealed ? interactionView() : undefined}>{(view) => <InteractionPreview view={view()} />}</Show>
          <Show when={activityRead.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading activity…" /></Show>
          <Show when={activityRead.result().isError}><p role="alert">{failure(activityRead.result().error, "Activity could not be read. Refresh to retry.")}</p></Show>
          <Show when={shellPage()?.shell}>{(shell) => <section class="st-section" aria-label="Selected shell details"><h3>Shell details</h3><dl class="rl-meta"><dt>Command</dt><dd><code>{shell().command}</code></dd><dt>Directory</dt><dd><code>{shell().cwd}</code></dd><dt>Status</dt><dd>{shell().status}</dd><dt>PID</dt><dd>{shell().pid ?? "Not reported"}</dd><dt>Exit code</dt><dd>{shell().exit ?? "Not reported"}</dd><dt>Started</dt><dd>{new Date(shell().time.started).toLocaleString()}</dd><Show when={shell().time.completed}>{(completed) => <><dt>Completed</dt><dd>{new Date(completed()).toLocaleString()}</dd></>}</Show></dl></section>}</Show>
          <Show when={activityView()}>{(data) => <SharedActivitySurface shells={data().shells} onSelectShell={selectShell} shellOutput={shellOutput()} subagentNext={data().subagentNext} loadingMoreSubagents={activityMoreBusy()} onLoadMoreSubagents={() => void loadMoreSubagents()}
            subagents={data().subagents.map((task) => ({ sessionID: task.sessionID, agent: task.agent, description: task.description, state: task.state, model: task.model.id, progressText: task.progress?.text, questionText: task.question?.text, onOpen: () => void navigate({ to: "/sessions/$sessionID", params: { sessionID: task.sessionID } }) }))}
            childSessions={children().map((entry) => ({ id: entry.row.id, title: entry.row.title, status: entry.status, onOpen: () => void navigate({ to: "/sessions/$sessionID", params: { sessionID: entry.row.id } }) }))}
            notices={[...surfaceNotices.activity(data()), ...(activityMoreError() ? [activityMoreError()!] : [])]}
            changesSummary={changeData()?.items.length ? { additions: changeData()!.items.reduce((sum, file) => sum + file.additions, 0), deletions: changeData()!.items.reduce((sum, file) => sum + file.deletions, 0), onOpenChanges: () => openChanges() } : undefined} capabilityNote="Only loaded Sessions and live status since connection are shown." />}</Show>
          <Show when={childSessionsRead.result().isError}><p role="alert">Child Sessions could not be read. Refresh to retry.</p><button type="button" class="rl-btn" onClick={childSessionsRead.refetch}>Refresh child Sessions</button></Show>
          <Show when={sessions.result().isError}><p role="alert">Loaded child Sessions could not be read. Refresh to retry.</p></Show>
          <ChannelActivity sessionID={props.sessionID} enabled={companionOpen() && companionTab() === "Activity"} />
        </div>}
        changesContent={<div class="rl-pane-body">
          <Show when={changes.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading captured changes…" /></Show>
          <Show when={changes.result().isError}><p role="alert">{failure(changes.result().error, "Changes could not be read. Refresh to retry.")}</p><button type="button" class="rl-btn" onClick={changes.refetch} disabled={!reading()}>Refresh</button></Show>
          <Show when={changeData()}>{(data) => <DesktopDiffView files={data().items} turnsNotice={data().turnsNotice} onOpenFullChanges={() => setFullChangesOpen((value) => !value)} fullChangesLabel={fullChangesOpen() ? "Compact changes view" : "Open full changes page"} turns={data().turns?.map((turn) => ({ ...turn, label: `${turn.type} · ${turn.id}` }))} selectedTurnID={selectedTurn()} onSelectTurn={(id) => { if (!activeRevert() && !revertUncertain()) setSelectedTurn(id) }} revert={revert()} selectedPath={selectedFile()} onSelectFile={setSelectedFile} onRefresh={changes.refetch} refreshing={changes.result().isFetching || !reading()} scopeTruth="Captured changes belong to this Session. Turn filters show only loaded captured inputs." />}</Show>
        </div>}
        contextContent={<div class="rl-pane-body">
          <GuardrailHistory value={pendingRequests()?.guardrailDecisions} rootSessionID={pendingRequests()?.rootSessionID} />
          <Show when={sessions.result().isError || activityRead.result().isError}><p role="alert">Child task activity could not be read. Costs for unavailable children are not reported.</p><button type="button" class="rl-btn" disabled={!reading()} onClick={() => { sessions.refetch(); activityRead.refetch() }}>Refresh child activity</button></Show>
          <Show when={activityView()?.subagentNext}><p role="status">Child task costs include loaded subagents only.</p><button type="button" class="rl-btn" disabled={activityMoreBusy() || !reading()} onClick={() => void loadMoreSubagents()}>Load older subagents</button></Show>
          <Show when={activityMoreError()}>{error => <p role="alert">{error()}</p>}</Show>
          <Show when={messages.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading context…" /></Show>
          <Show when={messages.result().isError}><p role="alert">Context could not be read. Refresh to retry.</p><button type="button" class="rl-btn" onClick={messages.refetch} disabled={!reading()}>Refresh</button></Show>
          <Show when={history()}><Context messages={history()?.messages ?? []} model={session()?.model} /></Show>
          <Show when={insightsRead.result().isPending}><SharedLoadingSkeleton kind="list" label="Reading Session diagnostics and costs…" /></Show>
          <Show when={insightsRead.result().isError}><p role="alert">{failure(insightsRead.result().error, "Session insights could not be read.")}</p><button type="button" class="rl-btn" disabled={!reading()} onClick={insightsRead.refetch}>Refresh insights</button></Show>
          <Show when={insights()}>{(data) => <>
            <For each={Object.values(data().notices)}>{(notice) => <p role="status">{notice}</p>}</For>
            <section class="desktop-context-insight"><h3><Icon name="usage" />Session usage</h3><DisplaySnapshot value={data().usage} /></section>
            <Show when={data().todos}>{(todos) => <section class="desktop-context-insight"><h3><Icon name="list" />Session tasks</h3><ul><For each={todos()} fallback={<li>No Session tasks.</li>}>{(todo) => <li>{todo.content} · {todo.status} · {todo.priority}</li>}</For></ul></section>}</Show>
            <ContextDetails icon="terminal" label="Diagnostics" value={data().diagnostics} />
            <ContextDetails icon="team" label="Loaded child task costs" value={data().taskCosts} />
            <ContextDetails icon="archive" label="Compaction history" value={data().compactions} />
          </>}</Show>
        </div>}
      />
    </aside></Show>
  </section>
}

function ChromeInteractionProposal(props: {
  readonly onClose: () => void
  readonly onRequest: (payload: Parameters<DesktopAPI["interactionRequest"]>[0]["payload"]) => void
}) {
  const [mode, setMode] = createSignal<"tab" | "owned" | "isolated">("tab")
  const [url, setURL] = createSignal("")
  const [invalid, setInvalid] = createSignal(false)
  const errorID = createUniqueId()
  return <DesktopDialog title="Request Chrome control" onClose={props.onClose}>
    <form noValidate onSubmit={(event) => {
      event.preventDefault()
      const selection = mode()
      if (selection === "tab") { props.onRequest({ platform: "chrome", mode: selection }); return }
      const target = chromeInteractionURL(url().trim())
      if (!target) { setInvalid(true); return }
      props.onRequest({ platform: "chrome", mode: selection, url: target })
    }}>
      <p>{mode() === "isolated" ? "Approve the target in the macOS system prompt." : "Approve the target in Chrome."} This request does not start control.</p>
      <SharedRadioGroup label="Chrome target" value={mode()} options={[{ value: "tab", label: "Existing tab" }, { value: "owned", label: "Owned tab" }, { value: "isolated", label: "Isolated Chrome" }]} onChange={(selection) => {
        if (selection === "tab" || selection === "owned" || selection === "isolated") { setMode(selection); setInvalid(false) }
      }} />
      <Show when={mode() !== "tab"}>
        <label class="rl-field"><span>Starting URL</span><input type="url" value={url()} maxLength={2048} required aria-invalid={invalid()} aria-describedby={invalid() ? errorID : undefined} onInput={(event) => { setURL(event.currentTarget.value); setInvalid(false) }} /></label>
        <Show when={invalid()}><p id={errorID} class="desktop__error" role="alert">Use a credential-free HTTP or HTTPS URL.</p></Show>
      </Show>
      <div class="desktop__actions"><button type="submit" class="rl-btn">Request approval</button><button type="button" class="rl-btn" onClick={props.onClose}>Cancel</button></div>
    </form>
  </DesktopDialog>
}

const root = createRootRoute({ component: App })
const workspaceRoute = createRoute({ getParentRoute: () => root, id: "_workspace", component: Workspace })
const indexRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/", component: () => null })
const newChatRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/chat", component: NewChat })
function DesktopSessionsSurface(props: Omit<Parameters<typeof SharedSessionsSurface>[0], "items"> & { readonly items: readonly { readonly id: string; readonly title: string; readonly directory: string; readonly workspace: string; readonly state: string; readonly meta: string; readonly pinned: boolean }[] }) {
  const select = (event: KeyboardEvent, id: string) => {
    if (event.target !== event.currentTarget || event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onSelect(id)
  }
  return <div class="desktop-session-directory ws-stack">
    <div class="desktop-session-toolbar"><label class="rl-field"><span class="desktop__sr">Search Sessions</span><span class="rl-input-icon"><Icon name="search" /><input type="search" value={props.search} placeholder="Search Sessions…" aria-invalid={!!props.searchError} onInput={event => props.onSearch(event.currentTarget.value)} /></span></label><div class="ws-chips"><SharedRadioGroup label="Filter by status" value={props.filter} options={props.filters.map(item => ({ value: item.value, label: `${item.label} ${formatCount(item.count)}` }))} onChange={props.onFilter} /></div><button type="button" class="rl-btn" data-action-id="ws-list-pins" aria-pressed={props.pinning} onClick={props.onTogglePinMode}><Icon name="pin" /><span class="desktop__sr">{props.pinning ? "Finish editing pins" : "Edit pins"}</span></button><button type="button" class="rl-btn" data-tone="go" onClick={props.onNewSession}>New Session</button></div>
    <Show when={props.searchError}><p role="alert">{props.searchError}</p></Show>
    <p class="ws-line"><strong>{formatCount(props.totalLoaded)}</strong> Sessions loaded · {formatCount(props.pinnedCount)} pinned{props.statusNote ? ` · ${props.statusNote}` : ""}</p>
    <div class="desktop-session-table"><div class="desktop-session-columns" aria-hidden="true"><span>Title &amp; path</span><span>Workspace</span><span>State</span><span>Last active</span><span>Session ID</span><span>Actions</span></div><div role="listbox" aria-label="Sessions"><For each={props.items} fallback={<p role="status" class="ws-hint">No Sessions match.</p>}>{item => <div class="desktop-session-row" role="option" tabindex="0" aria-selected={props.selectedID === item.id} onClick={event => { if (!(event.target instanceof Element) || !event.target.closest("button")) props.onSelect(item.id) }} onKeyDown={event => select(event, item.id)}><span class="desktop-session-title"><strong>{item.title}</strong><small>{item.directory}</small></span><span><span class="rl-badge">{item.workspace}</span></span><span class="desktop-session-state"><DesktopStateIndicator state={item.state.toLowerCase()} /><span>{item.state}</span></span><span class="desktop-session-meta">{item.meta}</span><span class="desktop-session-meta">{item.id}</span><span class="desktop-session-actions"><button type="button" class="rl-icon-button" aria-label={`${item.pinned ? "Unpin" : "Pin"} ${item.title}`} aria-pressed={item.pinned} onClick={() => props.onTogglePin?.(item.id, !item.pinned)}><Icon name="pin" /></button><button type="button" class="rl-icon-button" aria-label={`${props.pinning ? item.pinned ? "Unpin" : "Pin" : "Open"} ${item.title}`} data-tooltip={props.pinning ? item.pinned ? "Unpin" : "Pin" : "Open Session"} onClick={() => props.onSelect(item.id)}><Icon name={props.pinning ? "pin" : "chevron-right"} /><span class="desktop__sr">{props.pinning ? item.pinned ? "Unpin" : "Pin" : "Open"}</span></button></span></div>}</For></div></div>
    <Show when={props.hasMore}><button type="button" class="rl-btn" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? "Loading…" : "Load more"}</button></Show>
  </div>
}

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
  const sessionRows = () => { const first = sessions.result().data; const current = page(); return first && current ? pagedItems(first, current).filter(ordinarySession) : [] }
  const familyGroups = createMemo(() => { const first = sessions.result().data; const current = page(); return railGroups(first && current ? pagedItems(first, current) : [], activity(), currentSnapshot(first, connection().revision), executionStates()) })
  const statusFor = (id: string) => {
    const group = familyGroups().groups.find(group => group.rows.some(row => row.id === id))
    return ({ waiting: "Waiting", running: "Running", idle: "Idle", failed: "Failed", unknown: "Unknown" })[railStateOf(group?.key ?? "", id, currentSnapshot(sessions.result().data, connection().revision))]
  }
  const visibleRows = () => sessionRows().filter((row) => filter() === "All" || statusFor(row.id) === filter())
  const loadMore = async () => {
    const current = page(); if (!current?.next || loadingMore() || !reading()) return
    const generation = connection().generation; setLoadingMore(true); setPageError(undefined)
    try { const result = await api.sessions({ revision: current.revision, cursor: current.next }); if (connection().generation === generation && samePaging(page(), current)) { const next = appendPage(current, result); if (next) setPaging(next); else { setPaging(undefined); sessions.refetch() } } }
    catch (cause) { if (connection().generation === generation && samePaging(page(), current)) { setPageError(failure(cause, "More Sessions could not be read.")); setPaging(undefined); sessions.refetch() } }
    finally { setLoadingMore(false) }
  }
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
  const [selectedProject, selectProject] = createSignal<string>()
  let projectMotion: Animation | undefined
  const setSelectedProject = (id: string) => {
    projectMotion?.cancel()
    selectProject(id)
    queueMicrotask(() => {
      if (selectedProject() !== id) return
      projectMotion?.cancel()
      const detail = document.querySelector<HTMLElement>(".desktop-project-detail")
      if (detail) projectMotion = desktopContentMotion(detail)
    })
  }
  createEffect(() => { if (!animationsEnabled()) projectMotion?.finish() })
  onCleanup(() => projectMotion?.cancel())
  const [coordinationOpen, setCoordinationOpen] = createSignal(false)
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
  const [settingsSection, setSettingsSection] = createSignal("Machine & Backend")
  const openSettingsDialog = (label: string, kind: "themes" | "connect" | "mcp", opener: HTMLButtonElement) => {
    setSettingsSection(label)
    opener.focus({ preventScroll: true })
    setUtilityDialog({ kind })
  }
  const settingsRead = observe(() => ({ queryKey: ["settings", ...scope()] as const, queryFn: () => api.settings(), enabled: reading() && props.name === "Settings" }))
  const settingsData = () => settingsRead.result().isError ? undefined : currentSnapshot(settingsRead.result().data, connection().revision)
  const projectGuard = createActionGuard<ProjectMutationInput, Awaited<ReturnType<typeof api.changeProject>>>((message) => confirmInPage(message), () => `${scope().join(":")}:${connection().status}`, async (input) => { const result = await api.changeProject(input); if (result.revision !== input.revision) throw new Error("The project change was not confirmed."); return result })
  const workspaceGuard = createActionGuard<WorkspaceMutationInput, Awaited<ReturnType<typeof api.changeWorkspace>>>((message) => confirmInPage(message), () => `${scope().join(":")}:${connection().status}`, async (input) => { const result = await api.changeWorkspace(input); if (result && (result.revision !== input.revision || result.projectID !== input.projectID)) throw new Error("The workspace change was not confirmed."); return result })
  const settingsGuard = createActionGuard<SettingsMutationInput, Awaited<ReturnType<typeof api.changeSettings>>>((message) => confirmInPage(message), () => `${scope().join(":")}:${connection().status}`, async (input) => { const result = await api.changeSettings(input); if (result.revision !== input.revision) throw new Error("The settings change was not confirmed."); if (input.kind === "telemetry-consent") refresh(["telemetry-consent"]); return result })
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
  const explorerData = () => reading() && explorerRead.result().isSuccess && !explorerRead.result().isFetching ? explorerRead.result().data : undefined
  createEffect(() => { const workspace = selectedWorkspace(); if (workspace && expandedProject() !== workspaceKeyOf(workspace)) setExpandedProject(workspaceKeyOf(workspace)) })
  const selectedGroup = () => projectView()?.groups.find((group) => group.id === selectedProject()) ?? projectView()?.groups[0]
  createEffect(() => { const group = selectedGroup(); if (group && selectedProject() !== group.id) selectProject(group.id) })
  const directories = observe(() => ({ queryKey: ["workspace-directories", ...scope(), expandedProject(), selectedWorkspace()?.directory] as const, queryFn: () => api.workspaceDirectories!({ projectID: selectedWorkspace()!.projectID, directory: selectedWorkspace()!.directory }), enabled: reading() && !!selectedWorkspace() && !!api.workspaceDirectories }))

  const start = (directory: string) => { setNewDirectory(directory); void navigate({ to: "/chat" }) }
  const activeSessionRead = observe(() => ({ queryKey: ["session", ...scope(), lastSessionID()] as const, queryFn: () => api.session({ sessionID: lastSessionID()! }), enabled: reading() && !!lastSessionID() && (props.name === "Sessions" || props.name === "Workspaces") }))
  const currentSessionRow = () => lastOpenedSessionOf(sessionRows(), lastSessionID()) ?? (activeSessionRead.result().data?.revision === connection().revision && activeSessionRead.result().data?.item.id === lastSessionID() ? activeSessionRead.result().data?.item : undefined)
  const name = props.name
  const rangeOptions = [{ label: "Today", value: "today" }, { label: "7 days", value: "7d" }, { label: "30 days", value: "30d" }, { label: "All time", value: "all" }] as const
  const subtitle = name === "Projects" ? "One master Session coordinating member Sessions" : name === "Usage" ? "Requests, tokens and provider quota windows" : name === "Settings" ? "Machine and notification settings for this Mac" : "On this Mac"
  const performProject = (input: ProjectMutationInput, message: string) => void perform(projectGuard, input, message, () => { setCreating(false); setMembers([]); setProjectName(""); projects.refetch() })
  const performWorkspace = (input: WorkspaceMutationInput, message: string) => void perform(workspaceGuard, input, message, () => { setCopyFormOpen(false); setCopyDirectory(""); projects.refetch(); directories.refetch() })
  const performSettings = (input: SettingsMutationInput, message: string) => void perform(settingsGuard, input, message, settingsRead.refetch)
  return <SharedPageSurface title={name} sub={`${subtitle} · ${connectionOwnership()}`} onBack={() => window.history.back()} actions={name === "Sessions" ? <><button type="button" class="rl-icon-button" aria-label="Open Workspaces" data-tooltip="Open Workspaces" onClick={() => void navigate({ to: "/workspaces" })}><Icon name="monitor" /><span class="desktop__sr">Workspaces</span></button><Show when={currentSessionRow()}>{(row) => <button type="button" class="rl-icon-button" aria-label="Manage this Session" data-tooltip="Manage this Session" data-action-id="ws-list-manage" onClick={() => void navigate({ to: "/sessions/$sessionID", params: { sessionID: row().id } })}><Icon name="more" /><span class="desktop__sr">Manage this Session</span></button>}</Show></> : undefined}>
    <Show when={actionNotice()}>{(notice) => <p role="alert" class="desktop__error">{notice()}</p>}</Show>
    <Show when={projectError()}>{(error) => <p role="alert" class="desktop__error">{error()}</p>}</Show>
      <Show when={name === "Projects" && projectView()}><div class="desktop-coordination-switch"><button type="button" class="rl-btn" aria-pressed={coordinationOpen()} onClick={() => setCoordinationOpen(!coordinationOpen())}>{coordinationOpen() ? "Project settings" : "Coordination"}</button></div></Show>
      <Show when={name === "Projects" && coordinationOpen()}>
        <Show when={projects.result().isPending}><SharedLoadingSkeleton kind="page" label="Reading Project coordination…" /></Show>
        <Show when={projects.result().isError}><p role="alert">{failure(projects.result().error, "Project coordination could not be read.")}</p><button type="button" class="rl-btn" onClick={projects.refetch}>Refresh coordination</button></Show>
        <Show when={selectedGroup()}>{group => <>
          <ProjectCoordination group={group()} sessions={sessionRows()} repositories={projectView()?.repositories ?? []} onOpen={id => void navigate({ to: "/sessions/$sessionID", params: { sessionID: id } })} />
          <DesktopSwarmBoard groupID={group().id} masterSessionID={group().master.sessionID} onOpen={id => void navigate({ to: "/sessions/$sessionID", params: { sessionID: id } })} />
          <details class="st-section"><summary>Manage members</summary><DesktopProjectMembers group={group()} revision={projectView()!.revision} sessions={sessionRows()} disabled={!reading() || actionBusy() || actionUncertain() || projects.result().isFetching} onChange={performProject} onBrowseFolder={(initialDirectory, choose) => openFolderPicker({ title: "Choose folder for new member Session", mode: "directory", initialDirectory, onPick: choose })} /></details>
        </>}</Show>
      </Show>
      <Show when={name === "Projects" && !coordinationOpen()}><div class="desktop-project-settings">
      <Show when={projects.result().isPending}><SharedLoadingSkeleton kind="page" label="Loading projects…" /></Show>
      <Show when={projects.result().isError}><p role="alert" class="desktop__error">Projects could not be read. Refresh to retry.</p></Show>
      <Show when={projectView()}>{(data) => <DesktopProjectsSurface
        directories={workspaces.result().data ?? []}
        onBrowseFolder={(curr, choose) => openFolderPicker({ title: "Choose folder for new Master Session", mode: "directory", initialDirectory: curr || undefined, onPick: choose })}
        onCreateProject={(input) => performProject({ kind: "create", revision: data().revision, name: input.name, masterSessionID: input.masterSessionID, memberSessionIDs: input.memberSessionIDs }, `Create project ${input.name} with ${input.masterSessionID} as its master Session?`)}
        onCreateProjectInDirectory={(input) => performProject({ kind: "create-in-directory", revision: data().revision, name: input.name, directory: input.directory, ...(input.masterTitle ? { masterTitle: input.masterTitle } : {}), memberSessionIDs: input.memberSessionIDs }, newDirectoryProjectConfirmation(input.name, input.directory))}
        projects={data().groups.map((group) => ({ id: group.id, name: group.name, masterTitle: group.master.title, active: group.active, statusText: group.active ? "Active" : "Paused", revision: group.revision, master: group.master, members: group.members, delegatedText: group.settings.delegatedDecisions ? [group.settings.delegatedDecisions.categories.join(", "), ...(group.settings.delegatedDecisions.actions?.length ? [`actions: ${group.settings.delegatedDecisions.actions.join(", ")}`] : []), ...(group.settings.delegatedDecisions.resources?.length ? [`resources: ${group.settings.delegatedDecisions.resources.join(", ")}`] : []), ...(group.settings.delegatedDecisions.expiresAt ? [`expires ${new Date(group.settings.delegatedDecisions.expiresAt).toLocaleString()}`] : [])].join(" · ") : "None reported", concurrency: group.settings.concurrency == null ? "none" : String(group.settings.concurrency), openNote: "Open the master Session" }))}
        selectedID={selectedGroup()?.id} refreshing={projects.result().isFetching} busy={actionBusy() || actionUncertain()} notice={surfaceNotices.projects(data())}
        creating={creating()} name={projectName()} candidates={sessionRows().map((row) => ({ id: row.id, title: row.title, selected: members().includes(row.id) }))}
        onRefresh={projects.refetch} onOpenCreate={() => setCreating(true)} onName={setProjectName} onToggleMember={(id) => setMembers((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
        onCancelCreate={() => setCreating(false)} onSelect={setSelectedProject}
        onChangeConcurrency={(value) => { const group = selectedGroup(); if (group) performProject({ kind: "update", revision: data().revision, groupID: group.id, groupRevision: group.revision, concurrency: value === "none" ? null : Number(value) }, `Change ${group.name} concurrency to ${value}?`) }}
        concurrencyControl={(project) => <DesktopSelect label="Members running at once" value={project.concurrency ?? "none"} disabled={actionBusy() || actionUncertain()} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "4", label: "4" }, { value: "none", label: "No limit" }]} onChange={(value) => performProject({ kind: "update", revision: data().revision, groupID: project.id, groupRevision: project.revision, concurrency: value === "none" ? null : Number(value) }, `Change ${project.name} concurrency to ${value}?`)} />}
        roster={<Show when={selectedGroup()}>{group => <DesktopProjectRoster group={group()} revision={data().revision} disabled={!reading() || actionBusy() || actionUncertain() || projects.result().isFetching} onChange={performProject} onOpen={sessionID => void navigate({ to: "/sessions/$sessionID", params: { sessionID } })} />}</Show>}
        onOpenMaster={(sessionID) => void navigate({ to: "/sessions/$sessionID", params: { sessionID } })}
        onDeleteProject={(groupID) => performProject({ kind: "delete", revision: data().revision, groupID }, "Delete this project? Sessions remain available.")}
      />}</Show>
      <Show when={selectedGroup()}>{(group) => <aside class="desktop-project-inspector relay-settings" aria-label="Project member inspector"><DesktopProjectMembers group={group()} revision={projectView()!.revision} sessions={sessionRows()} disabled={!reading() || actionBusy() || actionUncertain() || projects.result().isFetching} onChange={performProject} onBrowseFolder={(initialDirectory, choose) => openFolderPicker({ title: "Choose folder for new member Session", mode: "directory", initialDirectory, onPick: choose })} /></aside>}</Show>
    </div></Show>
    <Show when={name === "Sessions"}>
      <Show when={sessions.result().isError}><p role="alert" class="desktop__error">Sessions could not be read. Refresh to retry.</p><button type="button" class="rl-btn" onClick={sessions.refetch}>Refresh</button></Show>
      <DesktopSessionsSurface
        search={search()} searchError={term().error}
        filters={(["All", "Waiting", "Running", "Unknown"] as const).map((value) => ({ value, label: value, count: sessionRows().filter((row) => value === "All" || statusFor(row.id) === value).length }))}
        filter={filter()} pinning={pinMode()}
        items={visibleRows().map((row) => ({ id: row.id, title: row.title, directory: row.location.directory, workspace: workspaceBase(row.location.directory), state: statusFor(row.id) === "Unknown" ? "Status unknown" : statusFor(row.id), meta: new Date(row.time.updated).toLocaleString(), pinned: row.time.pinned !== undefined }))}
        totalLoaded={sessionRows().length} pinnedCount={sessionRows().filter((row) => row.time.pinned !== undefined).length}
        statusNote={sessions.result().data?.running !== undefined && sessions.result().data?.waiting !== undefined ? "Server-reported status and current live events" : "Some status reads are unavailable; live events fill known states"}
        hasMore={page()?.next !== undefined} loadingMore={loadingMore()} selectedID={currentSessionRow()?.id}
        onNewSession={() => void navigate({ to: "/chat" })} onSearch={setSearch}
        onFilter={(value) => { if (value === "All" || value === "Waiting" || value === "Running" || value === "Unknown") setFilter(value) }}
        onTogglePinMode={() => setPinMode(!pinMode())}
        onTogglePin={(id, pinned) => { const revision = sessions.result().data?.revision; if (revision !== undefined) void perform(pinGuard, { sessionID: id, revision, pinned }, `${pinned ? "Pin" : "Unpin"} this Session?`, () => { setPaging(undefined); sessions.refetch() }) }}
        onSelect={(sessionID) => { const row = sessionRows().find((item) => item.id === sessionID); const revision = sessions.result().data?.revision; if (pinMode() && row && revision !== undefined) void perform(pinGuard, { sessionID, revision, pinned: row.time.pinned === undefined }, `${row.time.pinned === undefined ? "Pin" : "Unpin"} this Session?`, () => { setPaging(undefined); sessions.refetch() }); else if (!pinMode()) void navigate({ to: "/sessions/$sessionID", params: { sessionID } }) }}
        onLoadMore={() => void loadMore()}
      />
      <Show when={pageError()}>{(error) => <p role="alert" class="desktop__error">{error()}</p>}</Show>
    </Show>
    <Show when={name === "Workspaces"}>
      <Show when={projects.result().isError}><p role="alert" class="desktop__error">Workspaces could not be read.</p></Show>
      <Show when={selectedWorkspace() && !explorerData()}><section class="st-section" aria-label="Workspace files"><h3>Workspace files</h3><p><code>{explorerDir() ?? selectedWorkspace()?.directory}</code></p><Show when={explorerRead.result().isError} fallback={<p role="status">Reading folder…</p>}><p role="alert">{failure(explorerRead.result().error, "Folder could not be read.")}</p><button type="button" class="rl-btn" disabled={!reading() || explorerRead.result().isFetching} onClick={explorerRead.refetch}>Retry folder read</button></Show></section></Show>
      <Show when={projectView()}>{(data) => <><SharedWorkspacesSurface onOpenFolder={() => openFolderPicker({ title: "Open workspace folder", mode: "directory", onPick: (dir) => { projects.refetch(); workspaces.refetch(); start(dir) } })} onCreateFolder={() => openFolderPicker({ title: "Create new workspace folder", mode: "create-directory", initialDirectory: selectedWorkspace()?.directory, onPick: (dir) => { projects.refetch(); workspaces.refetch(); start(dir) } })} explorer={explorerData() && selectedWorkspace() ? {
        directory: explorerData()!.directory, rootDirectory: selectedWorkspace()!.directory, parent: explorerData()!.parent, entries: explorerData()!.entries, truncated: explorerData()!.truncated, showHidden: explorerHidden(), onNavigate: setExplorerDir, onToggleHidden: () => setExplorerHidden(!explorerHidden()), onCreateFolder: (parent) => openFolderPicker({ title: "New folder", mode: "create-directory", initialDirectory: parent, onPick: (dir) => { setExplorerDir(dir); explorerRead.refetch() } }), onStartChatInFolder: (dir) => { const starting = scope().join(":"); void api.openDirectory({ directory: dir }).then((opened) => { if (scope().join(":") !== starting) return; setOpenedDirectories((previous) => new Set(previous).add(opened.directory)); workspaces.refetch(); projects.refetch(); start(opened.directory) }, (cause) => setActionNotice(failure(cause, "Folder could not be opened."))) }
      } : undefined} workspaces={[...data().repositories].sort((a, b) => (b.sessions > 0 ? 1 : 0) - (a.sessions > 0 ? 1 : 0) || (a.projectName ?? workspaceBase(a.directory)).localeCompare(b.projectName ?? workspaceBase(b.directory))).map((repository) => ({ key: workspaceKeyOf(repository), projectID: repository.projectID, name: repository.projectName ?? workspaceBase(repository.directory), directory: repository.directory, sessions: repository.sessions, topLevelSummary: "Not reported", childSummary: "Not reported", copies: selectedWorkspace() && workspaceKeyOf(selectedWorkspace()!) === workspaceKeyOf(repository) ? (currentSnapshot(directories.result().data, connection().revision)?.projectID === repository.projectID ? directories.result().data!.directories : []).map((item) => ({ name: item.name ?? workspaceBase(item.directory), directory: item.directory, label: item.available === false ? "Unavailable" : item.kind })) : [] }))} selectedID={selectedWorkspace() ? workspaceKeyOf(selectedWorkspace()!) : undefined} currentSession={currentSessionRow() ? { title: currentSessionRow()!.title, directory: currentSessionRow()!.location.directory, workspace: workspaceBase(currentSessionRow()!.location.directory) } : undefined} copiesBusy={directories.result().isFetching || actionBusy()} copiesStatus={directories.result().isError ? "Copies could not be read." : undefined} onSelect={setExpandedProject} onRefreshCopies={(workspace) => performWorkspace({ kind: "refresh-copies", revision: data().revision, projectID: workspace.projectID, directory: workspace.directory }, `Refresh copies for ${workspace.name}?`)} onOpenCreateCopy={() => setCopyFormOpen(true)} onStartChat={start} onForgetWorkspace={(workspace) => performWorkspace({ kind: "forget", revision: data().revision, projectID: workspace.projectID, directory: workspace.directory }, `Forget workspace ${workspace.directory}? This permanently removes Sessions in that directory and their descendant Sessions, including descendants in other directories.`)} copyForm={copyFormOpen() ? <div class="st-form"><label class="rl-field"><span>Copy directory</span><input value={copyDirectory()} onInput={(event) => setCopyDirectory(event.currentTarget.value)} /></label><div class="st-form-actions"><button type="button" class="rl-btn" disabled={!copyDirectory().trim() || actionBusy() || actionUncertain()} onClick={() => { const workspace = selectedWorkspace(); const target = copyDirectory().trim().replace(/\/+$/, ""); const cut = target.lastIndexOf("/"); if (workspace) performWorkspace({ kind: "create-copy", revision: data().revision, projectID: workspace.projectID, sourceDirectory: workspace.directory, directory: cut > 0 ? target.slice(0, cut) : target, ...(cut > 0 ? { name: target.slice(cut + 1) } : {}) }, `Create a copy at ${target}?`) }}>Create copy</button><button type="button" class="rl-btn" onClick={() => setCopyFormOpen(false)}>Cancel</button></div></div> : undefined} /><Show when={data().repositoriesNext}><button type="button" class="rl-btn" disabled={projectBusy()} onClick={() => void loadMoreProjects()}>Load more repositories</button></Show></>}</Show>
    </Show>
        <Show when={name === "Settings"}><nav class="st-settings-nav" aria-label="Settings sections"><For each={["Machine & Backend", "Updates", "Appearance", "Session display", "Keyboard shortcuts", "Permissions", "Models & Providers", "MCP"]}>{label => <button type="button" class="rl-btn" aria-current={settingsSection() === label ? "location" : undefined} onClick={event => {
          const tool = label === "Appearance" ? "themes" : label === "Models & Providers" ? "connect" : label === "MCP" ? "mcp" : undefined
          if (tool) { openSettingsDialog(label, tool, event.currentTarget); return }
          setSettingsSection(label)
          const section = [...document.querySelectorAll<HTMLElement>('main[data-surface="settings"] .st-section')].find(section => section.getAttribute("aria-label") === label || section.querySelector("h3")?.textContent?.trim() === label)
          if (!section) { setActionNotice(`${label} is unavailable until Settings finishes loading.`); return }
          section.scrollIntoView({ block: "start" })
          const heading = section.querySelector<HTMLElement>("h3")
          if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
        }}><Icon name={label === "Machine & Backend" ? "monitor" : label === "Updates" ? "refresh" : label === "Appearance" ? "sun" : label === "Session display" ? "chat" : label === "Keyboard shortcuts" ? "key" : label === "Permissions" ? "shield" : label === "Models & Providers" ? "cpu" : "plug"} /><span>{label}</span></button>}</For></nav></Show>
        <Show when={name === "Usage"}><UsageTools /></Show>
    <Show when={name === "Usage"}><Show when={usageData()} fallback={<Show when={usageRead.result().isError} fallback={<SharedLoadingSkeleton kind="page" label="Loading usage…" />}><p role="alert" class="desktop__error">Usage could not be read.</p><button type="button" class="rl-btn" onClick={usageRead.refetch}>Refresh</button></Show>}>
      {(data) => <SharedUsageSurface phase="ready" statusText="Updated · retained analytics, not a bill" ranges={rangeOptions} range={range()} rangeLabel={rangeOptions.find((item) => item.value === range())?.label ?? range()} requests={formatCount(data().report.total.logical)} inputTokens={formatCompactCount(data().report.total.tokens.input)} outputTokens={formatCompactCount(data().report.total.tokens.output)} estimatedCost={costLabel(data().report.total.cost)} detailLine={`Cache read ${formatCompactCount(data().report.total.tokens.cache.read)} · Cache write ${formatCompactCount(data().report.total.tokens.cache.write)} · Helpers ${formatCount(data().report.total.helpers)} · Fallbacks ${formatCount(data().report.total.fallback)}`} refreshing={usageRead.result().isFetching} quotas={formatQuotaProviders(visibleDesktopQuotas(data().quotas ?? []), Date.now())} models={data().report.rows.map((row) => ({ name: row.model ? `${row.model.providerID} / ${row.model.id}` : row.label, detail: `${formatCount(row.logical)} ${row.logical === 1 ? "request" : "requests"} · ${formatCompactCount(row.tokens.input)} in · ${formatCompactCount(row.tokens.output)} out${row.tokens.cache.read > 0 ? ` · ${formatCompactCount(row.tokens.cache.read)} cache` : ""}`, value: costLabel(row.cost) }))} modelsNote={data().quotasNotice ?? surfaceNotices.usage(data())} onRange={(value) => { if (value === "today" || value === "7d" || value === "30d" || value === "all") setRange(value) }} onRefresh={usageRead.refetch} />}
    </Show></Show>
    <Show when={name === "Settings"}><div class="st-ledger"><MachineBackendSection keepAwake={<Show when={settingsData()}>{(data) => <KeepAwakeRow checked={data().keepAwake.state === "on"} unsupported={data().keepAwake.state === "unsupported" || data().keepAwake.state === "error"} disabled={actionBusy() || actionUncertain()} detail={data().keepAwake.message ?? data().keepAwake.state} onToggle={(enabled) => performSettings({ kind: "keep-awake", revision: data().revision, enabled }, `${enabled ? "Enable" : "Disable"} keep awake?`)} />}</Show>} /><UpdatesSection triggerTick={updateTriggerTick()} /><section class="st-section" aria-label="Keyboard shortcuts"><header class="st-section-head"><h3>Keyboard shortcuts</h3></header><KeyboardSettings value={keyboardOverrides()} onChange={saveKeyboardOverrides} /></section><section class="st-section" aria-label="Session display"><header class="st-section-head"><h3>Session display</h3></header><PresentationControls /></section>
      <For each={[
        { label: "Models & Providers", icon: "cpu", kind: "connect", detail: "Connect providers and manage credential profiles.", action: "Connect providers" },
        { label: "MCP", icon: "plug", kind: "mcp", detail: "Inspect servers, connections, and exposed resources.", action: "Manage MCP servers" },
      ] as const}>{card => <section class="st-section" aria-label={card.label}>
        <header class="st-section-head"><h3><Icon name={card.icon} />{card.label}</h3></header><p class="st-muted">{card.detail}</p>
        <div class="st-actions"><button type="button" class="rl-btn st-pill" onClick={event => openSettingsDialog(card.label, card.kind, event.currentTarget)}>{card.action}</button></div>
      </section>}</For>
      <Show when={settingsData()} fallback={<Show when={settingsRead.result().isError} fallback={<SharedLoadingSkeleton kind="page" label="Loading settings…" />}><section class="st-section"><p role="alert" class="desktop__error">Settings could not be read.</p><button type="button" class="rl-btn" onClick={settingsRead.refetch}>Refresh</button></section></Show>}>
      {(data) => <SharedSettingsSurface colorSchemeControl={<DesktopSelect label="Color scheme" value={themePreference()} options={DESKTOP_THEMES.map((theme) => ({ value: theme.id, label: theme.label, description: theme.description }))} onChange={(value) => { if (isDesktopThemeID(value)) applyThemePreference(value) }} />} hideKeepAwakeSection notificationsOpen={notificationsOpen()} savedPermissionsOpen={permissionsOpen()} closeAppOpen={closeOpen()} animations={animationsEnabled()} keepAwakeStatus={data().keepAwake.state === "unsupported" || data().keepAwake.state === "error" ? "unsupported" : "supported"} keepAwakeChecked={data().keepAwake.state === "on"} keepAwakeDisabled={actionBusy() || actionUncertain() || (data().keepAwake.state === "unsupported" || data().keepAwake.state === "error")} keepAwakeDetail={data().keepAwake.message ?? data().keepAwake.state} telemetryConsent={data().telemetryConsent.consent ? data().telemetryConsent.consent!.enabled ? "enabled" : "disabled" : "undecided"} telemetryNote={data().telemetryNotice ?? (data().telemetryConsent.consent ? `Decided ${new Date(data().telemetryConsent.consent!.decidedAt).toLocaleString()}` : "Not decided yet")} telemetryBusy={actionBusy() || actionUncertain()} latencySamples={data().telemetrySamples.map((entry) => ({ label: entry.sample.kind, detail: Number.isNaN(Date.parse(entry.sample.at)) ? entry.sample.at : new Date(entry.sample.at).toLocaleString(), value: "durationMs" in entry.sample ? formatDurationMs(entry.sample.durationMs) : "Reported" }))} onToggleAnimations={applyAnimationsPreference} onToggleKeepAwake={(enabled) => performSettings({ kind: "keep-awake", revision: data().revision, enabled }, `${enabled ? "Enable" : "Disable"} keep awake?`)} onDecideTelemetry={(enabled) => performSettings({ kind: "telemetry-consent", revision: data().revision, enabled, noticeVersion: 1 }, `${enabled ? "Share" : "Do not share"} latency diagnostics?`)} onToggleNotifications={() => setNotificationsOpen(!notificationsOpen())} onToggleSavedPermissions={() => setPermissionsOpen(!permissionsOpen())} onToggleCloseApp={() => setCloseOpen(!closeOpen())} notificationsContent={notificationsOpen() ? <AttentionSettings /> : undefined} savedPermissionsContent={permissionsOpen() ? <div class="st-stack"><Show when={data().savedPermissions.length} fallback={<p class="st-muted">No saved permissions.</p>}><ul class="st-rows"><For each={data().savedPermissions}>{(rule) => <li class="st-row"><span class="st-row-main"><span>{rule.action} · {rule.resource}</span></span><button type="button" class="rl-btn" disabled={actionBusy() || actionUncertain()} onClick={() => performSettings({ kind: "remove-saved-permission", revision: data().revision, id: rule.id }, `Remove the saved permission for ${rule.action} on ${rule.resource}?`)}>Remove</button></li>}</For></ul></Show></div> : undefined} closeAppContent={closeOpen() ? <div class="st-stack"><p class="st-muted">{connection().mode === "own" ? "Closing this window stops its private backend." : "Closing this window leaves the shared backend running."}</p><p class="st-muted">{connection().mode ?? "Unknown mode"} · {connection().status} · PID {connection().backendPID ?? "unknown"}</p><button type="button" class="rl-btn" onClick={() => { const section = document.querySelector<HTMLElement>('[aria-label="Machine & Backend"]'); section?.scrollIntoView({ block: "start" }); section?.querySelector<HTMLElement>("button")?.focus() }}>Open Machine & Backend</button></div> : undefined} />}</Show></div></Show>
  </SharedPageSurface>
}

function KeepAwakeRow(props: { checked: boolean; unsupported: boolean; disabled: boolean; detail: string; onToggle: (enabled: boolean) => void }) {
  return <div class="st-awake" data-part="st-keep-awake">
    <div class="st-awake__row"><span id="st-awake-label" class="st-awake__label">Keep machine awake</span><span class="st-awake__state" aria-hidden="true">{props.checked ? "On" : "Off"}</span><button type="button" role="switch" class="st-switch" aria-checked={props.checked} aria-labelledby="st-awake-label" aria-describedby={props.unsupported || !["on", "off"].includes(props.detail) ? "st-keep-awake-state st-awake-note" : "st-awake-note"} disabled={props.disabled || props.unsupported} onClick={() => props.onToggle(!props.checked)}><i /></button></div>
    <Show when={props.unsupported || !["on", "off"].includes(props.detail)}><p class="st-muted" id="st-keep-awake-state" data-part="st-keep-awake-state">{props.unsupported ? "Keep awake is unsupported on this machine." : props.detail}</p></Show>
    <p class="st-awake__note" id="st-awake-note">On battery or with the lid closed, keeping the machine awake drains the battery and can heat the laptop.</p>
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
    <header class="st-section-head"><h3><Icon name="monitor" />Machine</h3><button type="button" class="rl-btn st-pill" aria-expanded={backendFormOpen()} aria-controls="st-backend-form" onClick={() => setSwitchOpen(!switchOpen())}>Switch backend</button></header>
    <div class="st-machine__id"><Icon name="devices" /><strong>This Mac</strong><span class="st-machine__status" data-status={connection().status}>{connectionOwnership()}<Show when={connection().status === "connected"}><Icon name="check" /></Show></span><span class="st-machine__version">{connection().version ? `v${connection().version}` : "Not connected"}{connection().backendPID ? ` · PID ${connection().backendPID}` : ""}</span></div>
    <p class="st-muted">{closeOwnership()}</p>
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
  render(() => <MarkdownClipboard.Provider value={copyTextToClipboard}><RouterProvider router={router} /></MarkdownClipboard.Provider>, element)
}
