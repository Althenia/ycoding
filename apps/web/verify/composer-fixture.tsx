import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { RemoteProvider } from "../src/remote/context"
import { Composer } from "../src/remote/ui/composer"
import { NewSessionComposer } from "../src/remote/ui/new-session"
import { catalogKey, type CatalogView } from "../src/remote/catalog"
import type { RemoteStore, RemoteStoreState } from "../src/remote/store"
import { createSessionView } from "../src/remote/projection"
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
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-sol", name: "GPT-6 Sol", variants: ["low", "medium", "high"], defaultVariant: "high" },
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", variants: ["low", "high"], defaultVariant: "high" },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-lite", name: "GPT-6 Lite", variants: [] },
  ],
  commands: [{ name: "plan", description: "Plan work" }],
  skills: [{ id: "frontend-workflow", name: "Frontend workflow", slash: true }, { id: "audit", name: "Audit", slash: false }, ...Array.from({ length: 63 }, (_, index) => ({ id: `skill-${String(index).padStart(2, "0")}`, name: `Skill ${index}`, slash: false }))],
  references: [{ name: "design-system", uri: "file:///workspace/design-system" }],
  resources: [{ name: "Runbook", uri: "mcp://docs/runbook" }],
}
const requests: { operation: string; input: unknown }[] = []
const workspace = { id: "work_one", projectID: "project_hash", directory: "/workspace/ycoding", name: "YCoding" }
const other = { id: "work_two", projectID: "other_hash", directory: "/workspace/other", name: "Other repository" }
const [state, setState] = createSignal<RemoteStoreState>({
  connection: { kind: "connected", deviceName: "Fixture" }, transport: { kind: "open" }, workspaceStatus: "ready", workspaces: [workspace, other],
  selectedSessionInfo: { id: "ses_fixture", title: "Fixture", agent: "gsd", model: { providerID: "openai", id: "gpt-6-sol", variant: "high" }, updatedAt: 1, archived: false },
  activeSessionID: "ses_fixture", drafts: {}, mutations: [], catalogs: { [catalogKey({ sessionID: "ses_fixture" })]: catalog, [catalogKey({ workspaceID: "work_one" })]: catalog, [catalogKey({ workspaceID: "work_two" })]: catalog },
  view: createSessionView("ses_fixture"),
  devices: [], advertised: [], sessions: [], sessionGroups: [], sessionQuery: "", sessionFilter: "all", sessionListStatus: "ready", sessionPageLoading: false, sessionHasNext: false, sessionHasPrevious: false,
  teamCues: [], notifications: [], unhandledEvents: 0,
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
    return { status: "ok", files: [{ path: "apps/web/src/remote/ui/composer.tsx", uri: "file:///workspace/ycoding/apps/web/src/remote/ui/composer.tsx", kind: "file" as const }].filter((item) => item.path.includes(query)) }
  },
  setDraft: (sessionID: string, text: string) => update({ ...state(), drafts: { ...state().drafts, [sessionID]: text } }),
  sendPrompt: async (input: unknown) => { requests.push({ operation: "session.prompt", input }) },
  runCommand: async (input: unknown) => { requests.push({ operation: "session.command", input }) },
  cancelUpload: () => { requests.push({ operation: "upload.cancel", input: {} }); update({ ...state(), upload: undefined, uploadError: "Attachment upload cancelled. Files were not sent." }) },
  interrupt: async () => { requests.push({ operation: "session.interrupt", input: {} }) },
  createSession: async (input: unknown) => { requests.push({ operation: "session.create", input }); return "ses_created" },
  retrySessionCreation: async () => "ses_created", dismissSessionCreation: () => {},
  signInURL: () => "", logout: async () => {}, createEnrollment: async () => ({ ok: false, status: 503, kind: "http", message: "Unavailable" }), revokeDevice: async () => ({ ok: false, status: 503, kind: "http", message: "Unavailable" }),
  connect: () => {}, disconnect: () => {}, selectSession: async () => {}, watchTeam: () => {}, loadMoreTeam: async () => {}, selectWorkspace: () => {}, searchSessions: () => {}, nextSessionsPage: async () => {}, previousSessionsPage: async () => {},
  reloadMessages: async () => {}, loadShellOutputPage: async () => {}, switchModel: async () => true, switchAgent: async () => true, retryMutation: async () => {}, dismissMutation: () => {}, dismissNotification: () => {}, markNotificationsRead: () => {}, clearNotifications: () => {},
  replyPermission: async () => {}, replyGuardrail: async () => {}, replyForm: async () => {}, cancelForm: async () => {}, setYolo: async () => {}, setGoal: async () => {}, stopGoal: async () => { requests.push({ operation: "session.goal.stop", input: {} }) }, setAutonomy: () => {},
}
Object.assign(window, { composerRequests: () => requests, composerState: () => state(), composerSetUpload: (percent: number) => update({ ...state(), upload: { sessionID: "ses_fixture", name: "capture.png", percent } }), composerSetStatus: (status: "idle" | "running" | "waiting" | "goal" | "goal-yolo" | "yolo") => update({ ...state(), view: { ...state().view!, status: status === "running" || status === "waiting" ? "running" : "idle", executionStarted: status === "running" ? Date.now() - 6000 : undefined, requests: status === "waiting" ? [{ kind: "permission", id: "p", action: "read", resources: [], askedAt: Date.now() }] : [], autonomy: status === "goal" || status === "goal-yolo" ? { mode: "goal", yolo: status === "goal-yolo" ? 2 : 0, goal: { text: "Finish task", status: "active", iteration: 2, noProgress: 0, maxNoProgress: 3 } } : { mode: status === "yolo" ? "yolo" : "normal", yolo: status === "yolo" ? 2 : 0 } } }) })

function Fixture() {
  const [created, setCreated] = createSignal("")
  const [running, setRunning] = createSignal(false)
  return <RemoteProvider createStore={() => store}>
    <main class="composer-fixture" style={{ "max-width": "900px", margin: "auto", padding: "16px" }}>
      <button type="button" onClick={() => setRunning(!running())}>Toggle running</button>
      <Composer sessionID="ses_fixture" running={running()} canSend />
      <NewSessionComposer onCreated={setCreated} />
      <Show when={created()}><output>Created {created()}</output></Show>
    </main>
  </RemoteProvider>
}
render(() => <Fixture />, document.getElementById("app")!)
