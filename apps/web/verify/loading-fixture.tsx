import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { TeamView } from "../src/remote/ui/team-view"
import type { TeamPanelData } from "../src/remote/ui/team-model"
import { OfficeWorkspace } from "../src/remote/office/OfficeWorkspace"
import { defaultOfficePreferences } from "../src/remote/office/preferences"
import type { OfficeSnapshot } from "../src/remote/office/types"
import { UserImage } from "../src/remote/ui/image"
import { RemoteProvider } from "../src/remote/context"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteHttp } from "../src/remote/http"
import { TranscriptNavigation } from "../src/remote/ui/transcript-nav"
import type { RemoteMessageView } from "../src/remote/projection"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"
const [loaded, setLoaded] = createSignal(false)
const [pageLoading, setPageLoading] = createSignal(false)
const [olderLoaded, setOlderLoaded] = createSignal(false)
const [officeTeamLoaded, setOfficeTeamLoaded] = createSignal(false)
let finishOutput: ((value: { readonly text: string; readonly cursor: number; readonly size: number; readonly truncated: boolean }) => void) | undefined
let finishImage: ((src: string) => void) | undefined
const imageStore = createRemoteStore({ http: createRemoteHttp({ fetch: Object.assign(async () => new Response(null, { status: 401 }), { preconnect: () => {} }) }), createTransport: () => { throw new Error("Loading fixture transport must not connect") } })
Object.defineProperty(imageStore, "loadImageSource", { value: () => new Promise<string>((resolve) => { finishImage = resolve }) })
const historyStore = createRemoteStore({ http: createRemoteHttp({ fetch: Object.assign(async () => new Response(null, { status: 401 }), { preconnect: () => {} }) }), createTransport: () => { throw new Error("History fixture transport must not connect") } })
const [history, setHistory] = createSignal<{ readonly status: "idle" | "loading"; readonly before?: string }>({ status: "idle", before: "older" })
const [shellReady, setShellReady] = createSignal(false)
const historyListeners = new Set<() => void>()
const historyState = { ...historyStore.state(), activeSessionID: "ses_root" }
Object.defineProperty(historyStore, "state", { value: () => ({ ...historyState, history: history() }) })
Object.defineProperty(historyStore, "subscribe", { value: (listener: () => void) => { historyListeners.add(listener); return () => historyListeners.delete(listener) } })
const transcript = (): readonly RemoteMessageView[] => [{ kind: "user", id: "prompt_1", text: "Check the session", state: "consumed", created: 1 }, { kind: "shell", id: "shell_1", shellID: "sh_1", command: "bun test", status: "running", created: 2, outputFetch: shellReady() ? { state: "idle" } : { state: "loading" }, ...(shellReady() ? { output: { text: "Tests passed", cursor: 12, size: 12, truncated: false } } : {}) }]
const data = (): TeamPanelData => ({
  rootID: "ses_root",
  status: loaded() ? "ready" : "loading",
  tasks: loaded() ? [{ sessionID: "ses_child", parentID: "ses_root", description: "Review task", agent: "reviewer", state: "running", revision: 1, updatedAt: 1 }, ...(olderLoaded() ? [{ sessionID: "ses_old", parentID: "ses_root", description: "Older task", agent: "reviewer", state: "completed" as const, revision: 1, updatedAt: 1 }] : [])] : [],
  total: 2,
  next: olderLoaded() ? undefined : "older",
  pageLoading: pageLoading(),
  shells: [{ id: "sh_1", ownerID: "ses_root", command: "bun test", status: "running", startedAt: 1 }],
  shellStatus: "ready",
  sideChats: [],
  sideChatStatus: "ready",
  sideChatLoading: false,
})
const office = (): OfficeSnapshot => ({ scope: "loading-fixture", connection: "ready", actors: [], totalSessions: 0, activityStatus: "ready", overflow: 0, team: { status: officeTeamLoaded() ? "ready" : "loading", total: 0, shown: 0, more: false }, cues: [] })
Object.assign(window, { finishLoading: () => setLoaded(true), startLoading: () => setLoaded(false), finishPage: () => { setPageLoading(false); setOlderLoaded(true) }, finishOutput: () => finishOutput?.({ text: "Tests passed", cursor: 12, size: 12, truncated: false }), finishOfficeTeam: () => setOfficeTeamLoaded(true), finishImage: () => finishImage?.(`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#27d17f"/></svg>')}`), startHistory: () => { setHistory({ status: "loading", before: "older" }); historyListeners.forEach((listener) => listener()) }, finishHistory: () => { setHistory({ status: "idle", before: "older" }); historyListeners.forEach((listener) => listener()) }, finishShellOutput: () => setShellReady(true) })
const root = document.getElementById("app")
if (!root) throw new Error("Loading fixture root missing")
render(() => <main style={{ width: "min(100%, 1400px)", margin: "auto", padding: "24px", display: "grid", gap: "24px" }}><section style={{ width: "min(100%, 420px)", "min-height": "360px" }}><TeamView data={data} currentSessionID="ses_root" now={() => 1} sheet={false} onClose={() => {}} onOpen={() => {}} onCancel={async () => ({ status: "ok" })} onAnswer={async () => ({ status: "ok" })} onLoadOlder={async () => { setPageLoading(true) }} onViewShell={() => new Promise((resolve) => { finishOutput = resolve })} onKillShell={async () => ({ status: "ok" })} onOpenSideChat={() => {}} onCreateSideChat={async () => ({ status: "ok", sessionID: "ses_new" })} onLoadOlderSideChats={async () => {}} /></section><section style={{ height: "480px" }}><OfficeWorkspace snapshot={office()} preferences={defaultOfficePreferences} renderKey="loading-fixture" requestCount={0} onSelectSession={() => {}} onNormalView={() => {}} onShowRequests={() => {}} onLoadMoreTeam={() => {}} /></section><section><RemoteProvider createStore={() => imageStore}><UserImage deviceID="dev_1" sessionID="ses_root" digest={"a".repeat(64)} mime="image/png" name="Preview" /></RemoteProvider></section><section class="workspace__main"><div class="workspace__scroll" style={{ height: "160px", overflow: "auto" }}><RemoteProvider createStore={() => historyStore}><TranscriptNavigation messages={transcript} /></RemoteProvider></div></section></main>, root)
