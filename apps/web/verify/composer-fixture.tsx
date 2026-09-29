import { render } from "solid-js/web"
import { createSignal, For, Show } from "solid-js"
import { RemoteProvider } from "../src/remote/context"
import { Composer } from "../src/remote/ui/composer"
import { MessageRow } from "../src/remote/ui/conversation"
import { NewSessionComposer } from "../src/remote/ui/new-session"
import { ToastLayer } from "../src/remote/ui/notifications"
import { catalogKey, type CatalogView } from "../src/remote/catalog"
import type { RemoteStore, RemoteStoreState } from "../src/remote/store"
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
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", variants: ["high", "max"], defaultVariant: "high" },
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-opus-5-5-fast", name: "Claude Opus 5.5 Fast", variants: ["medium", "high"], defaultVariant: "medium" },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-sol", name: "GPT-6 Sol", variants: ["low", "medium", "high"], defaultVariant: "high" },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-sol-fast", name: "GPT-6 Sol Fast", variants: ["low", "high"], defaultVariant: "low" },
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", variants: ["low", "high"], defaultVariant: "high" },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-lite", name: "GPT-6 Lite", variants: [] },
    { providerID: "openai", providerName: "OpenAI", id: "glm-fast-latest", name: "GLM Fast Latest", variants: [] },
    { providerID: "openai", providerName: "OpenAI", id: "quant-fp8-fast", name: "Quant FP8 Fast", variants: [] },
    { providerID: "openai", providerName: "OpenAI", id: "effort-spectrum", name: "Effort Spectrum", variants: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "custom"], defaultVariant: "medium" },
  ],
  commands: [{ name: "plan", description: "Plan work" }],
  skills: [{ id: "frontend-workflow", name: "Frontend workflow", slash: true }, { id: "gpt-subgent-routing", name: "GPT subagent routing", slash: false }, { id: "audit", name: "Audit", slash: false }, ...Array.from({ length: 63 }, (_, index) => ({ id: `skill-${String(index).padStart(2, "0")}`, name: `Skill ${index}`, slash: false }))],
  references: [{ name: "design-system", uri: "file:///workspace/design-system" }],
  resources: [{ name: "Runbook", uri: "mcp://docs/runbook" }],
}
const requests: { operation: string; input: unknown }[] = []
const workspace = { id: "work_one", projectID: "project_hash", directory: "/workspace/ycoding", name: "YCoding" }
const other = { id: "work_two", projectID: "other_hash", directory: "/workspace/other", name: "Other repository" }
const [state, setState] = createSignal<RemoteStoreState>({
  connection: { kind: "connected", deviceName: "Fixture" }, transport: { kind: "open" }, workspaceStatus: "ready", workspaces: [workspace, other],
  selectedSessionInfo: { id: "ses_fixture", title: "Fixture", agent: "gsd", model: new URLSearchParams(location.search).get("model") === "spectrum" ? { providerID: "openai", id: "effort-spectrum", variant: "medium" } : { providerID: "openai", id: new URLSearchParams(location.search).get("model") === "fast" ? "gpt-6-sol-fast" : "gpt-6-sol", variant: "high" }, updatedAt: 1, archived: false },
  activeSessionID: "ses_fixture", drafts: {}, mutations: [], mutationToasts: [], catalogs: { [catalogKey({ sessionID: "ses_fixture" })]: catalog, [catalogKey({ workspaceID: "work_one" })]: catalog, [catalogKey({ workspaceID: "work_two" })]: catalog },
  view: { ...createSessionView("ses_fixture"), autonomy: { mode: "normal", yolo: 0 } },
  devices: [], advertised: [], sessions: [], sessionGroups: [], sessionQuery: "", sessionFilter: "all", sessionListStatus: "ready", sessionPageLoading: false, sessionHasNext: false, sessionHasPrevious: false,
  teamCues: [], notifications: [], noticeSync: { status: "ready", total: 0, loaded: 0, hidden: 0, loadingMore: false, message: undefined }, unhandledEvents: 0,
  usage: { providers: { status: "idle" }, summary: { status: "idle" }, reports: {} },
})
const listeners = new Set<() => void>()
const update = (next: RemoteStoreState) => { setState(next); listeners.forEach((listener) => listener()) }
const store: RemoteStore = {
  state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  load: async () => {}, dispose: () => {}, loadCatalog: async () => {}, loadWorkspaces: async () => {}, loadUsage: async () => {}, loadUsageReport: async () => {},
  findFiles: async (_target, query) => {
    if (query === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { status: "ok", files: [{ path: "slow.txt", uri: "file:///workspace/ycoding/slow.txt", kind: "file" as const }] }
    }
    if (query === "fail") return { status: "failed", message: "File search is unavailable" }
    return { status: "ok", files: [{ path: "apps/web/src/remote/ui/composer.tsx", uri: "file:///workspace/ycoding/apps/web/src/remote/ui/composer.tsx", kind: "file" as const }].filter((item) => item.path.includes(query)) }
  },
  setDraft: (sessionID: string, text: string) => update({ ...state(), drafts: { ...state().drafts, [sessionID]: text } }),
  sendPrompt: async (input: { readonly skills?: readonly string[] }) => { for (const skill of input.skills ?? []) requests.push({ operation: "session.skill", input: { skill, resume: false } }); requests.push({ operation: "session.prompt", input }) },
  activateSkill: async (skill: string) => { requests.push({ operation: "session.skill", input: { skill } }); return true },
  runCommand: async (input: unknown) => { requests.push({ operation: "session.command", input }) },
  cancelUpload: () => { requests.push({ operation: "upload.cancel", input: {} }); update({ ...state(), upload: undefined, uploadError: "Attachment upload cancelled. Files were not sent." }) },
  interrupt: async () => { requests.push({ operation: "session.interrupt", input: {} }) },
  createSession: async (input: unknown) => { requests.push({ operation: "session.create", input }); return "ses_created" },
  retrySessionCreation: async () => "ses_created", dismissSessionCreation: () => {},
  signInURL: () => "", logout: async () => {}, createEnrollment: async () => ({ ok: false, status: 503, kind: "http", message: "Unavailable" }), revokeDevice: async () => ({ ok: false, status: 503, kind: "http", message: "Unavailable" }),
  connect: () => {}, disconnect: () => {}, selectSession: async () => {}, loadOlderMessages: async () => {}, loadOversizedMessage: async () => {}, watchTeam: () => {}, watchFamilyActivity: () => {}, loadMoreTeam: async () => {}, loadTeamControls: async () => {}, loadSelectedSubagentEconomics: async () => {}, loadMoreSideChats: async () => {},
  cancelSubagent: async () => ({ status: "failed", message: "Team is not available in this fixture." }), answerSubagent: async () => ({ status: "failed", message: "Team is not available in this fixture." }), killTeamShell: async () => ({ status: "failed", message: "Team is not available in this fixture." }),
  teamShellOutput: async () => { throw new Error("Team is not available in this fixture.") }, createSideChat: async () => ({ status: "failed", message: "Team is not available in this fixture." }),
  selectWorkspace: () => {}, searchSessions: () => {}, nextSessionsPage: async () => {}, previousSessionsPage: async () => {},
  reloadMessages: async () => {}, loadImageSource: async () => { throw new Error("Composer fixture does not load images") }, loadShellOutputPage: async () => {}, switchModel: async () => true, switchAgent: async () => true, retryMutation: async (id) => { requests.push({ operation: "retry", input: { id } }) }, dismissMutation: (id) => update({ ...state(), mutations: state().mutations.filter((item) => item.id !== id) }), dismissMutationToast: (id) => update({ ...state(), mutationToasts: state().mutationToasts?.filter((item) => item.id !== id) }), readNotification: async () => {}, readAllNotifications: async () => {}, loadMoreNotifications: async () => {}, reloadNotifications: async () => {},
  replyPermission: async () => {}, replyGuardrail: async () => {}, replyForm: async () => {}, cancelForm: async () => {},
  setYolo: async (level) => { requests.push({ operation: "session.autonomy.set", input: { yolo: level } }); update({ ...state(), view: { ...state().view!, autonomy: { ...state().view!.autonomy!, mode: level ? "yolo" : "normal", yolo: level } } }); return true },
  setGoal: async (goal) => { requests.push({ operation: "session.goal.set", input: { goal } }); update({ ...state(), view: { ...state().view!, autonomy: { mode: "goal", yolo: state().view?.autonomy?.yolo ?? 0, goal: { text: goal, status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } } } }); return true },
  stopGoal: async () => { requests.push({ operation: "session.goal.stop", input: { goal: null } }); update({ ...state(), view: { ...state().view!, autonomy: { mode: "normal", yolo: state().view?.autonomy?.yolo ?? 0 } } }) }, setAutonomy: () => {},
}
Object.assign(window, { composerRequests: () => requests, composerState: () => state(), composerSetMutation: (status: "sending" | "unknown" | "failed" | "sent" | null) => update({ ...state(), mutations: status === null || status === "sent" ? [] : [{ id: "msg_fixture", kind: "prompt", label: "Prompt", state: status, sessionID: "ses_fixture", operation: "session.prompt", input: { text: "Review" }, detail: status === "failed" ? "Send failed" : status === "unknown" ? "The outcome is unknown" : undefined }], mutationToasts: status === null || status === "sending" ? [] : [{ id: "msg_fixture", label: "Prompt", state: status, sessionID: "ses_fixture", ...(status === "sent" ? {} : { detail: status === "failed" ? "Send failed" : "The outcome is unknown" }) }] }), composerSetPending: (delivery: "steer" | "queue") => update({ ...state(), view: { ...state().view!, messages: [{ kind: "user", id: "msg_fixture", text: "Review", delivery, state: "pending", created: 1 }] } }), composerSetUpload: (percent: number) => update({ ...state(), upload: { sessionID: "ses_fixture", name: "capture.png", percent } }), composerSetStatus: (status: "idle" | "running" | "tool" | "tool-yolo" | "family-yolo" | "waiting" | "goal" | "goal-yolo" | "yolo") => update({ ...state(), view: { ...state().view!, status: status === "running" || status === "tool" || status === "tool-yolo" || status === "waiting" ? "running" : "idle", executionStarted: status === "running" ? Date.now() - 6000 : undefined, messages: status === "tool" || status === "tool-yolo" ? [{ kind: "assistant", id: "msg_tool", created: Date.now(), parts: [{ kind: "tool", callID: "call_tool", name: "shell", status: "running", content: [], started: Date.now() }] }] : [], requests: status === "waiting" ? [{ kind: "permission", id: "p", action: "read", resources: [], askedAt: Date.now() }] : [], autonomy: status === "goal" || status === "goal-yolo" ? { mode: "goal", yolo: status === "goal-yolo" ? 2 : 0, goal: { text: "Finish task", status: "active", iteration: 2, noProgress: 0, maxNoProgress: 3 } } : { mode: status === "yolo" || status === "tool-yolo" || status === "family-yolo" ? "yolo" : "normal", yolo: status === "yolo" ? 2 : status === "tool-yolo" || status === "family-yolo" ? 3 : 0 } }, sessionStatus: status === "family-yolo" ? { running: new Set(["ses_fixture"]), attention: new Set<string>(), outstanding: new Set<string>(), failed: new Set<string>() } : undefined }) })
Object.assign(window, { composerSwitchSession: () => update({ ...state(), activeSessionID: "ses_other", view: createSessionView("ses_other") }) })
Object.assign(window, { composerClearAutonomy: () => update({ ...state(), view: { ...state().view!, autonomy: undefined } }) })
Object.assign(window, { composerSetWorkspaceLoading: (loading: boolean) => update({ ...state(), workspaceStatus: loading ? "loading" : "ready" }) })
Object.assign(window, { composerSetGoalStatus: (status: "active" | "completed" | "stopped" | "exhausted" | null) => update({ ...state(), view: { ...state().view!, autonomy: { mode: status === "active" ? "goal" : "normal", yolo: 3, ...(status ? { goal: { text: "Finish task", status, iteration: 2, noProgress: 0, maxNoProgress: 3 } } : {}) } } }) })
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
Object.assign(window, { composerSetDiagnostics: (status: "known" | "unknown" | "mismatch") => {
  const selected = state().selectedSessionInfo?.model
  const model = status === "mismatch" ? { providerID: "anthropic", id: "claude-opus-5-5" } : selected
  const first = model && { model, tokens: 3, durationNs: 1_000_000, tokensPerSecond: 3_000 }
  const latest = model && { model, tokens: 12, durationNs: 2_000_000, tokensPerSecond: 6_000 }
  update({ ...state(), view: { ...state().view!, generationSpeed: status === "unknown" || !first || !latest ? undefined : { latest, recent: [first, latest] },
    contextWindow: status === "unknown" || !model ? undefined : { model, used: 74_000, limit: 258_000 } } })
} })

function Fixture() {
  const [created, setCreated] = createSignal("")
  const [running, setRunning] = createSignal(false)
  return <RemoteProvider createStore={() => store}>
    <main class="composer-fixture" style={{ "max-width": "900px", margin: "auto", padding: "16px" }}>
      <button type="button" onClick={() => setRunning(!running())}>Toggle running</button>
      <Composer sessionID="ses_fixture" running={running()} canSend />
      <ToastLayer sessionID="ses_fixture" onOpenSession={() => {}} />
      <div class="transcript" aria-label="Fixture transcript"><For each={state().view?.messages ?? []}>{(message) => <MessageRow message={() => message} />}</For></div>
      <NewSessionComposer onCreated={setCreated} />
      <Show when={created()}><output>Created {created()}</output></Show>
    </main>
  </RemoteProvider>
}
render(() => <Fixture />, document.getElementById("app")!)
