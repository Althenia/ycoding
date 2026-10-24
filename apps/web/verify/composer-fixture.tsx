import { render } from "solid-js/web"
import { createSignal, For, Show } from "solid-js"
import { useStore } from "@tanstack/solid-store"
import { RemoteProvider } from "../src/remote/context"
import { Composer } from "../src/remote/ui/composer"
import { MessageRow } from "../src/remote/ui/conversation"
import { NewSessionComposer } from "../src/remote/ui/new-session"
import { ToastLayer } from "../src/remote/ui/notifications"
import { catalogKey, type CatalogView } from "../src/remote/catalog"
import { createRemoteHttp } from "../src/remote/http"
import { remoteKeys, type RemoteLink } from "../src/remote/queries"
import { createRemoteStore, type RemoteStore, type RemoteStoreState } from "../src/remote/store"
import type { AutonomyModes, EffectiveAutonomyView } from "../src/remote/autonomy"
import { applySessionEvent, createSessionView } from "../src/remote/projection"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const catalog: CatalogView = {
  status: "ready", defaultModel: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
  agents: [
    { id: "gsd", name: "GSD", mode: "primary", hidden: false },
    { id: "architect", name: "architect", mode: "primary", hidden: false },
    { id: "reviewer", name: "Reviewer", mode: "subagent", hidden: false },
    { id: "btw", name: "BTW", mode: "subagent", hidden: false },
  ],
  models: [
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", variants: ["high", "max"] },
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-opus-5-5-fast", name: "Claude Opus 5.5 Fast", variants: ["medium", "high"] },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-sol", name: "GPT-6 Sol", variants: ["low", "medium", "high"] },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-sol-fast", name: "GPT-6 Sol Fast", variants: ["low", "high"] },
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", variants: ["low", "high"] },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-lite", name: "GPT-6 Lite", variants: [] },
    { providerID: "openai", providerName: "OpenAI", id: "glm-fast-latest", name: "GLM Fast Latest", variants: [] },
    { providerID: "openai", providerName: "OpenAI", id: "quant-fp8-fast", name: "Quant FP8 Fast", variants: [] },
    { providerID: "openai", providerName: "OpenAI", id: "effort-spectrum", name: "Effort Spectrum", variants: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "custom"] },
  ],
  commands: [{ name: "plan", description: "Plan work" }],
  skills: [{ id: "frontend-workflow", name: "Frontend workflow", slash: true }, { id: "gpt-subgent-routing", name: "GPT subagent routing", slash: false }, { id: "audit", name: "Audit", slash: false }, ...Array.from({ length: 63 }, (_, index) => ({ id: `skill-${String(index).padStart(2, "0")}`, name: `Skill ${index}`, slash: false }))],
  references: [{ name: "design-system", uri: "file:///workspace/design-system" }],
  resources: [{ name: "Runbook", description: "Operational reference", uri: "mcp://docs/runbook" }],
}
const modesManual: AutonomyModes = { permissions: "manual", guardrails: "manual", answers: "manual" }
const fixtureEffective = (modes: AutonomyModes, inherited: EffectiveAutonomyView["inherited"] = {}) => ({ ...modes, inherited, asleep: false, guardrailsEnabled: true })
const fixtureAutonomy = (modes: AutonomyModes, goal?: NonNullable<NonNullable<RemoteStoreState["view"]>["autonomy"]>["goal"]) => ({ mode: "normal" as const, ...modes, effective: fixtureEffective(modes), ...(goal ? { goal } : {}) })
const requests: { operation: string; input: unknown }[] = []
let resolveCompact: ((accepted: boolean) => void) | undefined
const workspace = { id: "work_one", projectID: "project_hash", directory: "/workspace/ycoding", name: "YCoding" }
const other = { id: "work_two", projectID: "other_hash", directory: "/workspace/other", name: "Other repository" }
const base = createRemoteStore({ http: createRemoteHttp(), createTransport: () => { throw new Error("Composer fixture does not connect") } })
const seed: RemoteStoreState = {
  ...base.state(),
  connection: { kind: "connected", deviceName: "Fixture" }, transport: { kind: "open" }, activeDeviceID: "dev_fixture",
  selectedSessionInfo: { id: "ses_fixture", title: "Fixture", agent: "gsd", model: new URLSearchParams(location.search).get("model") === "spectrum" ? { providerID: "openai", id: "effort-spectrum", variant: "medium" } : { providerID: "openai", id: new URLSearchParams(location.search).get("model") === "fast" ? "gpt-6-sol-fast" : "gpt-6-sol", variant: "high" }, updatedAt: 1, archived: false },
  activeSessionID: "ses_fixture", drafts: {}, mutations: [], mutationToasts: [], catalogs: { [catalogKey({ sessionID: "ses_fixture" })]: catalog, [catalogKey({ workspaceID: "work_one" })]: catalog, [catalogKey({ workspaceID: "work_two" })]: catalog },
  view: { ...createSessionView("ses_fixture"), autonomy: fixtureAutonomy(modesManual) },
  devices: [], advertised: [], sessions: [], sessionGroups: [], sessionQuery: "", sessionFilter: "all", sessionListStatus: "ready", sessionPageLoading: false, sessionHasNext: false, sessionHasPrevious: false,
  teamCues: [], notifications: [], noticeSync: { status: "ready", total: 0, loaded: 0, hidden: 0, loadingMore: false, message: undefined }, unhandledEvents: 0,
}
base.container.setState(() => seed)
Object.assign(window, { composerPrediction: (text = "Run the focused tests", sourceMessageID?: string) => base.container.setState(state => ({
  ...state, view: { ...state.view!, status: "idle", messages: [{ kind: "assistant", id: `msg_${text}`, created: 1, completed: 2, parts: [{ kind: "text", ordinal: 0, text: "The build is fixed." }] }],
    prediction: { sessionID: "ses_fixture", sourceMessageID: sourceMessageID ?? `msg_${text}`, text } },
})) })
const state = () => base.container.state
const update = (next: RemoteStoreState) => base.container.setState(() => next)
const setModes = (change: Partial<AutonomyModes>) => {
  const current = state().view!.autonomy!
  const modes = { permissions: current.permissions, guardrails: current.guardrails, answers: current.answers, ...change }
  const inherited = current.effective?.inherited ?? {}
  const inEffect = { permissions: inherited.permissions === undefined ? modes.permissions : current.effective!.permissions, guardrails: inherited.guardrails === undefined ? modes.guardrails : current.effective!.guardrails, answers: inherited.answers === undefined ? modes.answers : current.effective!.answers }
  update({ ...state(), view: { ...state().view!, autonomy: { ...current, ...modes, effective: { ...fixtureEffective(inEffect, inherited), asleep: current.effective?.asleep === true } } } })
}
Object.assign(window, {
  composerPredictionReply: (sourceMessageID: string) => update({ ...state(), view: { ...state().view!, status: "idle", prediction: undefined, messages: [{ kind: "assistant", id: sourceMessageID, created: 1, completed: 2, parts: [{ kind: "text", ordinal: 0, text: "The build is fixed." }] }] } }),
  composerPredictionEvent: (text: string, sourceMessageID: string) => update({ ...state(), view: applySessionEvent(state().view!, { type: "session.prediction.updated", data: { sessionID: state().view!.id, sourceMessageID, text } }, 3) }),
  composerPredictionTransport: (open: boolean) => update({ ...state(), transport: open ? { kind: "open" } : { kind: "closed", code: 1000, reason: "Fixture disconnected", retryable: false } }),
  composerPredictionConnection: (deviceID = state().activeDeviceID) => update({ ...state(), activeDeviceID: deviceID, generation: state().generation + 1, view: { ...state().view!, prediction: undefined } }),
  composerPredictionSession: (sessionID: string) => update({ ...state(), activeSessionID: sessionID, selectedSessionInfo: { ...state().selectedSessionInfo!, id: sessionID }, view: { ...createSessionView(sessionID), autonomy: fixtureAutonomy(modesManual) } }),
})
let workspaceGate: Promise<void> | undefined
let releaseWorkspaces: (() => void) | undefined
const link: RemoteLink = {
  request: async (_scope, operation) => {
    if (operation !== "workspace.list") return { status: "unavailable", reason: "not-connected" }
    await workspaceGate
    return { status: "ok", value: { data: [workspace, other] } }
  },
  recoveries: () => 0,
  recovered: async () => false,
}
const store: RemoteStore = {
  ...base, link,
  load: async () => {}, dispose: () => {}, loadCatalog: async (target, options) => { await Promise.resolve(); if (options?.refresh) requests.push({ operation: "catalog.refresh", input: target }); if (options?.refresh || state().catalogs[catalogKey(target)] === undefined) update({ ...state(), catalogs: { ...state().catalogs, [catalogKey(target)]: catalog } }) },
  findFiles: async (_target, query) => {
    if (query === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { status: "ok", files: [{ path: "slow.txt", uri: "file:///workspace/ycoding/slow.txt", kind: "file" as const }] }
    }
    if (query === "fail") return { status: "failed", message: "File search is unavailable" }
    if (query === "agent.ts") return { status: "ok", files: ["packages/core/src/config/plugin/agent.ts", "packages/core/src/plugin/agent.ts", "packages/core/src/project-artifact/adapter/agent.ts"].map((path) => ({ path, uri: `file:///workspace/ycoding/${path}`, kind: "file" as const })) }
    return { status: "ok", files: [{ path: "apps/web/src/remote/ui/composer.tsx", uri: "file:///workspace/ycoding/apps/web/src/remote/ui/composer.tsx", kind: "file" as const }].filter((item) => item.path.includes(query)) }
  },
  setDraft: (sessionID: string, text: string) => update({ ...state(), drafts: { ...state().drafts, [sessionID]: text } }),
  sendPrompt: async (input: { readonly skills?: readonly string[] }) => { requests.push({ operation: "session.prompt", input }); return true },
  activateSkill: async (skill: string) => { requests.push({ operation: "session.skill", input: { skill } }); return true },
  runCommand: async (input: unknown) => { requests.push({ operation: "session.command", input }); return true },
  compactSession: async () => {
    requests.push({ operation: "session.compact", input: { id: "cmp_fixture" } })
    return new URLSearchParams(location.search).get("compactGate") === "1"
      ? new Promise<boolean>((resolve) => { resolveCompact = resolve }) : true
  },
  cancelUpload: () => { requests.push({ operation: "upload.cancel", input: {} }); update({ ...state(), upload: undefined, uploadError: "Attachment upload cancelled. Files were not sent." }) },
  interrupt: async () => { requests.push({ operation: "session.interrupt", input: {} }) },
  requestPrediction: async (input) => { requests.push({ operation: "session.prediction", input }); return true },
  requestPromptGenerate: async (input) => { requests.push({ operation: "session.promptGenerate", input }); return true },
  createSession: async (input: unknown) => { requests.push({ operation: "session.create", input }); return "ses_created" },
  retrySessionCreation: async () => "ses_created", dismissSessionCreation: () => {},
  signInURL: () => "", logout: async () => {}, createEnrollment: async () => ({ ok: false, status: 503, kind: "http", message: "Unavailable" }), revokeDevice: async () => ({ ok: false, status: 503, kind: "http", message: "Unavailable" }),
  setDeviceAlias: async () => ({ ok: false, status: 503, kind: "http", message: "Unavailable" }),
  connect: () => {}, disconnect: () => {}, selectSession: async () => {}, loadOlderMessages: async () => {}, loadOversizedMessage: async () => {}, watchTeam: () => {}, watchFamilyActivity: () => {}, loadMoreTeam: async () => {}, loadTeamControls: async () => {}, loadSelectedSubagentEconomics: async () => {}, loadMoreSideChats: async () => {},
  cancelSubagent: async () => ({ status: "failed", message: "Team is not available in this fixture." }), answerSubagent: async () => ({ status: "failed", message: "Team is not available in this fixture." }), killTeamShell: async () => ({ status: "failed", message: "Team is not available in this fixture." }),
  teamShellOutput: async () => { throw new Error("Team is not available in this fixture.") }, createSideChat: async () => ({ status: "failed", message: "Team is not available in this fixture." }),
  selectWorkspace: () => {}, searchSessions: () => {}, nextSessionsPage: async () => {}, previousSessionsPage: async () => {},
  reloadMessages: async () => {}, loadImageSource: async () => { throw new Error("Composer fixture does not load images") }, loadShellOutputPage: async () => {}, switchModel: async () => true, switchAgent: async () => true, retryMutation: async (id) => { requests.push({ operation: "retry", input: { id } }) }, dismissMutation: (id) => update({ ...state(), mutations: state().mutations.filter((item) => item.id !== id) }), dismissMutationToast: (id) => update({ ...state(), mutationToasts: state().mutationToasts?.filter((item) => item.id !== id) }), readNotification: async () => {}, readAllNotifications: async () => {}, loadMoreNotifications: async () => {}, reloadNotifications: async () => {},
  replyPermission: async () => {}, replyGuardrail: async () => {}, replyForm: async () => {}, cancelForm: async () => {},
  setAutonomous: async (change) => { requests.push({ operation: "session.autonomy.set", input: change }); setModes(change); return true },
  setGoal: async (goal) => { requests.push({ operation: "session.goal.set", input: { goal } }); update({ ...state(), view: { ...state().view!, autonomy: { ...state().view!.autonomy!, goal: { text: goal, status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } } } }); return true },
  stopGoal: async () => { requests.push({ operation: "session.goal.stop", input: { goal: null } }); update({ ...state(), view: { ...state().view!, autonomy: { ...state().view!.autonomy!, mode: "normal", goal: undefined } } }) }, setAutonomy: () => {},
}
Object.assign(window, { composerUseCommandMutation: () => update({ ...state(), mutations: state().mutations.map((mutation) => ({ ...mutation, kind: "command", operation: "session.command", input: { id: mutation.id, command: "review" } })) }) })
Object.assign(window, { composerRequests: () => requests, composerState: () => state(), composerSetMutation: (status: "sending" | "unknown" | "failed" | "sent" | null, sessionID = "ses_fixture") => update({ ...state(), mutations: status === null || status === "sent" ? [] : [{ id: "msg_fixture", kind: "prompt", label: "Prompt", state: status, sessionID, operation: "session.prompt", input: { text: "Review" }, detail: status === "failed" ? "Send failed" : status === "unknown" ? "The outcome is unknown" : undefined }], mutationToasts: status === "failed" || status === "unknown" ? [{ id: "msg_fixture", label: "Prompt", state: status, sessionID: "ses_fixture", detail: status === "failed" ? "Send failed" : "The outcome is unknown" }] : [] }), composerSetPending: (delivery: "steer" | "queue", text = "Review") => update({ ...state(), view: { ...state().view!, messages: [{ kind: "user", id: "msg_fixture", text, delivery, state: "pending", created: 1 }] } }), composerSetUpload: (percent: number) => update({ ...state(), upload: { sessionID: "ses_fixture", name: "capture.png", percent } }), composerSetStatus: (status: "idle" | "running" | "tool" | "tool-auto" | "family-auto" | "waiting" | "goal" | "goal-auto" | "auto") => update({ ...state(), view: { ...state().view!, status: status === "running" || status === "tool" || status === "tool-auto" || status === "waiting" ? "running" : "idle", executionStarted: status === "running" ? Date.now() - 6000 : undefined, messages: status === "tool" || status === "tool-auto" ? [{ kind: "assistant", id: "msg_tool", created: Date.now(), parts: [{ kind: "tool", callID: "call_tool", name: "shell", status: "running", content: [], started: Date.now() }] }] : [], requests: status === "waiting" ? [{ kind: "permission", id: "p", action: "read", resources: [], askedAt: Date.now() }] : [], autonomy: fixtureAutonomy(status === "goal-auto" || status === "auto" || status === "tool-auto" || status === "family-auto" ? { permissions: "auto", guardrails: "auto", answers: "manual" } as const : modesManual, status === "goal" || status === "goal-auto" ? { text: "Finish task", status: "active", iteration: 2, noProgress: 0, maxNoProgress: 3 } : undefined) }, sessionStatus: status === "family-auto" ? { running: new Set(["ses_fixture"]), attention: new Set<string>(), outstanding: new Set<string>(), failed: new Set<string>(), lost: new Set<string>() } : undefined }) })
Object.assign(window, { composerClearCatalogs: () => update({ ...state(), catalogs: {} }) })
Object.assign(window, { composerFailCatalogs: () => update({ ...state(), catalogs: Object.fromEntries(Object.keys(state().catalogs).map((key) => [key, { ...catalog, status: "error", message: "Catalog could not be loaded" }])) }) })
Object.assign(window, { composerSwitchSession: () => update({ ...state(), activeSessionID: "ses_other", view: createSessionView("ses_other") }) })
Object.assign(window, { composerResolveCompact: (accepted = true) => resolveCompact?.(accepted), composerSetDraft: store.setDraft })
Object.assign(window, { composerSetEffective: (change: Record<string, unknown>) => update({ ...state(), view: { ...state().view!, autonomy: { ...state().view!.autonomy!, effective: { ...state().view!.autonomy!.effective!, ...change } } } }) })
Object.assign(window, { composerClearAutonomy: () => update({ ...state(), view: { ...state().view!, autonomy: undefined } }) })
Object.assign(window, { composerSetModes: (modes: AutonomyModes, inherited: EffectiveAutonomyView["inherited"] = {}, effective: AutonomyModes = modes) => update({ ...state(), view: { ...state().view!, autonomy: { ...state().view!.autonomy!, ...modes, effective: fixtureEffective(effective, inherited) } } }) })
Object.assign(window, { composerSetAutonomyMutation: (status: "sending" | "unknown" | "failed") => update({ ...state(), mutations: [{ id: "autonomy_modes_fixture", kind: "autonomy", label: "Autonomous", state: status, sessionID: "ses_fixture", operation: "session.autonomy.set", input: { permissions: "auto" },
  ...(status === "sending" ? {} : { detail: status === "unknown" ? "Outcome unknown: Request timed out. Retry only if you want to send it again." : "Denied by policy" }) }] }) })
Object.assign(window, { composerSetWorkspaceLoading: (loading: boolean) => {
  if (!loading) return releaseWorkspaces?.()
  workspaceGate = new Promise<void>((resolve) => { releaseWorkspaces = () => { workspaceGate = undefined; resolve() } })
  void base.queryClient.refetchQueries({ queryKey: remoteKeys.workspaces({ deviceID: "dev_fixture", generation: 0 }), type: "all" })
} })
Object.assign(window, { composerSetGoalStatus: (status: "active" | "completed" | "stopped" | "exhausted" | null) => update({ ...state(), view: { ...state().view!, autonomy: fixtureAutonomy({ permissions: "auto", guardrails: "auto", answers: "manual" }, status ? { text: "Finish task", status, iteration: 2, noProgress: 0, maxNoProgress: 3 } : undefined) } }) })
Object.assign(window, { composerSetGoalPending: (pending: boolean) => update({ ...state(), mutations: pending
  ? [{ id: "goal_fixture", kind: "goal", label: "Set goal", state: "sending", sessionID: "ses_fixture", operation: "session.goal.set", input: { goal: "Finish task" } }]
  : [] }) })
Object.assign(window, { composerSetRetryPhase: (phase: "countdown" | "retrying" | "progress" | "next" | "idle" | "failed") => {
  const now = Date.now()
  const event = (type: string, data: Record<string, unknown>) => ({ type, data })
  const started = applySessionEvent({ ...createSessionView("ses_fixture"), autonomy: state().view?.autonomy }, event("session.execution.started", { sessionID: "ses_fixture" }), now - 1_000)
  const step = applySessionEvent(started, event("session.step.started", { sessionID: "ses_fixture", assistantMessageID: "msg_retry" }), now - 900)
  const retry = applySessionEvent(step, event("session.retry.scheduled", { sessionID: "ses_fixture", assistantMessageID: "msg_retry", attempt: 2, at: phase === "countdown" ? now + 4_000 : now - 1, error: { code: "rate_limit", message: "Slow down" } }), now)
  const next = phase === "progress" ? applySessionEvent(retry, event("session.text.delta", { sessionID: "ses_fixture", assistantMessageID: "msg_retry", ordinal: 0, delta: "Recovered" }), now)
    : phase === "next" ? applySessionEvent(retry, event("session.step.started", { sessionID: "ses_fixture", assistantMessageID: "msg_next" }), now)
      : phase === "idle" ? applySessionEvent(retry, event("session.status", { sessionID: "ses_fixture", status: { type: "idle" } }), now)
        : phase === "failed" ? applySessionEvent(retry, event("session.execution.failed", { sessionID: "ses_fixture", error: { code: "provider_error", message: "Stopped" } }), now)
          : retry
  update({ ...state(), view: next })
} })
Object.assign(window, { composerSetDiagnostics: (status: "known" | "unknown" | "mismatch" | "estimated" | "unreported") => {
  const selected = state().selectedSessionInfo?.model
  const model = status === "mismatch" ? { providerID: "anthropic", id: "claude-opus-5-5" } : selected
  const first = model && { model, tokens: 3, durationNs: 1_000_000, tokensPerSecond: 3_000 }
  const latest = model && { model, tokens: 12, durationNs: 2_000_000, tokensPerSecond: 6_000, ...(status === "estimated" ? { estimated: true } : {}) }
  update({ ...state(), view: { ...state().view!, generationSpeed: status === "unknown" || !first || !latest ? undefined : status === "unreported"
    ? { model, recent: [first], unreportedReason: "No streamed output or usable provider measurement" } : { latest, recent: status === "estimated" ? [first] : [first, latest] },
    contextWindow: status === "unknown" || !model ? undefined : { model, used: 74_000, limit: 258_000 } } })
} })

function Fixture() {
  const current = useStore(base.container)
  const [created, setCreated] = createSignal("")
  const [running, setRunning] = createSignal(false)
  const [predictionEnabled, setPredictionEnabled] = createSignal(true)
  Object.assign(window, { composerPredictionEnabled: setPredictionEnabled })
  return <RemoteProvider createStore={() => store}>
    <main class="composer-fixture" style={{ "max-width": "900px", margin: "auto", padding: "16px" }}>
      <button type="button" onClick={() => setRunning(!running())}>Toggle running</button>
      <Composer sessionID={current().activeSessionID} running={running()} canSend={predictionEnabled()} />
      <ToastLayer sessionID="ses_fixture" onOpenSession={() => {}} />
      <div class="transcript" aria-label="Fixture transcript"><For each={current().view?.messages ?? []}>{(message) => <MessageRow message={() => message} />}</For></div>
      <NewSessionComposer onCreated={setCreated} />
      <Show when={created()}><output>Created {created()}</output></Show>
    </main>
  </RemoteProvider>
}
render(() => <Fixture />, document.getElementById("app")!)
