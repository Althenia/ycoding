/**
 * Verification fixture for the remote workspace.
 *
 * It is built only when `YCODING_WEB_VERIFY=1`, never in a production build, and
 * it is visibly labelled in the page. The store, projection, and components are
 * the real ones; only the relay transport and the account HTTP client are
 * synthetic, so browser checks of layout, streaming, requests, and reconnect can
 * run without a hosted relay or credentials.
 */
import { render } from "solid-js/web"
import { onMount } from "solid-js"
import { ThemeProvider } from "../src/theme/theme-store"
import { App } from "../src/app"
import { pwaInstall } from "../src/pwa/install"
import { createRemoteStore, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { OFFICE_PREFERENCES_KEY, WORKSPACE_PRESENTATION_KEY } from "../src/remote/office/storage"
import type { RemoteHttp, RemoteHttpResult } from "../src/remote/http"
import type {
  RemoteRequestOutcome,
  RemoteTransport,
  RemoteTransportHandlers,
  RemoteTransportStatus,
} from "../src/remote/transport"
import { RemoteLimits, isRemoteLatencySample, noticePageValue, noticeSequence, type RemoteCapturedChangesPage, type RemoteDeviceInfo, type RemoteLatencySample, type RemoteNotice, type RemoteNoticeOperation, type RemoteOperation } from "@ycoding-ai/remote"
import { remoteScenario } from "./remote-scenarios"
import { createProviderAuthFixture } from "./provider-auth-fixture"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/site.css"
import "../src/styles/docs.css"
import "../src/styles/remote.css"
import "./remote-fixture.css"

const model = { id: "gpt-6", providerID: "openai" } as const
const sessionID = "ses_fixture"
/** Recent timestamps keep fixture screenshots readable. */
const ago = (minutes: number) => Date.now() - minutes * 60_000

function ok<T>(value: T): RemoteHttpResult<T> {
  return { ok: true, value }
}

let devices: readonly RemoteDeviceInfo[] = [
  { id: "dev_studio", name: "Studio Mac", createdAt: 1, lastSeenAt: Date.now() - 60_000, status: "active", online: true as const },
  { id: "dev_laptop", name: "Laptop", createdAt: 2, status: "active", online: true as const },
]

const accountParams = new URLSearchParams(window.location.search)
const requestLatencyMs = Number(accountParams.get("latency") ?? 0)
const requestLog: { readonly at: number; readonly operation: string; readonly input?: unknown }[] = []
Object.assign(window, { requestLog })
const deviceRequests: { readonly deviceID: string; readonly operation: string; readonly sessionID?: string }[] = []
Object.assign(window, { remoteDeviceRequests: deviceRequests })
const attachmentGate = Promise.withResolvers<void>()
Object.assign(window, { remoteReleaseAttachments: () => attachmentGate.resolve() })
let inventoryHeld = accountParams.get("inventoryGate") === "1"
const inventoryWaiters: (() => void)[] = []
Object.assign(window, { remoteReleaseInventory: () => { inventoryHeld = false; inventoryWaiters.splice(0).forEach((release) => release()) } })
if (accountParams.get("presentation") !== "keep") {
  window.localStorage.setItem(WORKSPACE_PRESENTATION_KEY, accountParams.get("presentation") === "office" ? "office" : "conversation")
  window.localStorage.removeItem(OFFICE_PREFERENCES_KEY)
}
const relayURL = accountParams.get("relay")
const relayAddress = relayURL === null ? undefined : new URL(relayURL)
if (relayAddress !== undefined && (relayAddress.protocol !== "ws:" || relayAddress.hostname !== "127.0.0.1")) throw new Error("Verification relay must be loopback")
const remoteScenarioData = remoteScenario(accountParams)
/** `?account=pending|signedout|unavailable` plus `?accountDelay=<ms>` for a slow answer. */
const accountMode = remoteScenarioData?.account ?? accountParams.get("account") ?? "ok"
const accountDelayMs = Number(accountParams.get("accountDelay") ?? 0)
/** `?connection=offline` selects a signed-in device whose open relay has no local agent. */
const connectionMode = remoteScenarioData?.connection ?? accountParams.get("connection") ?? "open"
/** `?form=all` adds every native field kind for browser verification. */
const formMode = accountParams.get("form") ?? "question"
/** Delays native Form settlement so the browser can observe disabled duplicate controls. */
const formDelayMs = Number(accountParams.get("formDelay") ?? 0)
const pushDelivered = accountParams.get("push") === "delivered"
/** `?formOutcome=unknown` leaves the native Form mutation unresolved without replay. */
const formOutcome = accountParams.get("formOutcome")
const promptOutcome = accountParams.get("promptOutcome")
const goalGate = accountParams.get("goalGate") === "1"
let releaseGoal: ((result: "ok" | "failed" | "unknown") => void) | undefined
;(window as typeof window & { remoteReleaseGoal?: (result: "ok" | "failed" | "unknown") => void }).remoteReleaseGoal = (result) => releaseGoal?.(result)
const heldPrompts: ((result: "ok" | "failed" | "unknown") => void)[] = []
const heldSessionLists: (() => void)[] = []
let sessionListsHeld = true
Object.assign(window, { remotePendingSessionLists: () => heldSessionLists.length, remoteHoldSessionLists: () => { sessionListsHeld = true }, remoteReleaseSessionList: () => { sessionListsHeld = false; heldSessionLists.splice(0).forEach((release) => release()) } })
;(window as typeof window & { remoteReleasePrompt?: (result?: "ok" | "failed" | "unknown") => void }).remoteReleasePrompt = (result = "ok") => heldPrompts.shift()?.(result)
const deviceMode = accountParams.get("devices")
const emptyBackend = remoteScenarioData?.emptyBackend ?? accountParams.get("sessions") === "empty"
const fixtureTheme = accountParams.get("theme") ?? remoteScenarioData?.theme
if (fixtureTheme !== undefined) localStorage.setItem("ycoding.theme", fixtureTheme)
if (remoteScenarioData !== undefined) devices = remoteScenarioData.devices
const machineName = accountParams.get("machineName")
if (machineName !== null) devices = devices.map((device, index) => index === 0 ? { ...device, name: machineName } : device)
if (deviceMode === "none") devices = []
if (deviceMode === "offline") devices = devices.map((device) => ({ ...device, online: false }))
if (deviceMode === "revoked") devices = devices.map((device) => ({ ...device, status: "revoked", online: false }))
if (accountParams.get("deviceCleanup") === "two") devices = [...devices, {
  id: "dev_backup", name: "Backup Mac", createdAt: 4, status: "revoked", online: false, revokedAt: Date.now() - 86_400_000,
}]

const cleanupRequests: string[] = []
let cleanupFailed = false
const originalFetch = window.fetch.bind(window)
window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const pathname = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname
  if (init?.method === "DELETE" && pathname.startsWith("/api/devices/")) {
    const id = pathname.slice("/api/devices/".length)
    cleanupRequests.push(id === "revoked" ? "all" : id)
    if (accountParams.get("deviceCleanupFailure") === "once" && !cleanupFailed) {
      cleanupFailed = true
      return Response.json({ error: { message: "Device cleanup is unavailable" } }, { status: 503 })
    }
    devices = devices.filter((device) => device.status !== "revoked" || id !== "revoked" && device.id !== id)
    return new Response(null, { status: 204 })
  }
  return originalFetch(input, init)
}, { preconnect: () => {} })
Object.assign(window, { remoteCleanupReport: () => cleanupRequests })

const syntheticHttp: RemoteHttp = {
  me: async () => {
    if (accountDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, accountDelayMs))
    if (accountMode === "pending") return new Promise<never>(() => {})
    if (accountMode === "signedout") return { ok: false, status: 401, message: "unauthorized", kind: "http" }
    if (accountMode === "unavailable")
      return { ok: false, status: 200, message: "The response was not an API document", kind: "unexpected-body" }
    return ok({ user: { id: remoteScenarioData?.accountID ?? "user_fixture" }, session: { expiresAt: Date.now() + 86_400_000 }, devices })
  },
  devices: async () => ok(devices),
  createEnrollment: async () =>
    ok({ enrollmentID: "enr_fixture", code: "AAAA-BBBB-CCCC-DDDD-EEEE", expiresAt: Date.now() + 600_000 }),
  revokeDevice: async (deviceID) => {
    devices = devices.map((device) =>
      device.id === deviceID ? { ...device, status: "revoked", revokedAt: Date.now() } : device,
    )
    return ok(undefined)
  },
  removeRevokedDevices: async () => ok(undefined),
  logout: async () => ok(undefined),
}

const defaultSessions = [
  { id: sessionID, title: "Stream remote output safely", projectID: "prj_remote", location: { directory: "/workspace/ycoding" }, agent: "god", model, time: { created: ago(42), updated: ago(1) }, running: true },
  { id: "ses_archived", title: "Archived: release notes", time: { created: ago(300), updated: ago(280), archived: ago(280) } },
  { id: "ses_child", title: "Child: fix flaky suite", parentID: sessionID, time: { created: ago(30), updated: ago(4) } },
  ...(accountParams.get("team") === "two" ? [{ id: "ses_second", title: "Child: inspect source", parentID: sessionID, time: { created: ago(20), updated: ago(2) } }] : []),
  ...(accountParams.get("team") === "two" ? [{ id: "ses_btw", title: "Side question", parentID: sessionID, agent: "btw", time: { created: ago(19), updated: ago(2) } }] : []),
]
const sessions = [...(remoteScenarioData?.sessions ?? defaultSessions), ...(accountParams.has("carouselFamily") ? [{
  id: "ses_postgres_child", title: "Inspect Postgres indexes", parentID: "ses_postgres", projectID: "project-auth",
  location: { directory: "/workspace/db-pruner" }, time: { created: ago(15), updated: ago(2) }, running: true,
}] : [])]
const inventoryCount = Math.min(15_000, Math.max(0, Number(accountParams.get("inventoryCount") ?? 0) || 0))
const inventoryPageRows = Math.min(400, Math.max(0, Number(accountParams.get("pageRows") ?? 0) || 0))
const sessionListDelayMs = Number(accountParams.get("sessionListDelay") ?? 0)
let statusRunning = new Set(inventoryCount > 0 ? ["ses_inventory_14000"] : sessions.filter((session) => session.running).map((session) =>
  "parentID" in session && typeof session.parentID === "string" ? session.parentID : session.id))

const longOutput = Array.from({ length: 60 }, (_, index) => `line ${index + 1}: bun test test/remote-sync.test.ts --filter case-${index}`).join("\n")

/**
 * Device-side capture for the paging check: three byte pages, the second one carrying
 * multi-byte characters so the client must keep byte cursors rather than character
 * offsets. The fixture server below serves exactly one page per request, like the device.
 */
const pagedCapturePages = [
  `${Array.from({ length: 30 }, (_, index) => `line ${index + 1}: compiled module ${index}.ts`).join("\n")}\n`,
  "λ unicode · page two arrived from the device\n",
  "final line\n",
]
const pagedCaptureCursors = pagedCapturePages.reduce(
  (cursors, page) => [...cursors, cursors[cursors.length - 1]! + new TextEncoder().encode(page).length],
  [0],
)
const liveCapture = "ready\n"
const backgroundCapture = "watching for changes…\n"
const byteLength = (text: string) => new TextEncoder().encode(text).length

/**
 * The production 320px case: one token with no space, hyphen, or slash, so the browser
 * finds no break opportunity in a command, its output, or a tool input.
 */
const unbrokenCommand = `printf REMOTE_DENIAL_MUST_NOT_RUN_${"0123456789abcdef".repeat(8)}`

const defaultMessages = [
  { id: "msg_user", type: "user", text: "Refactor the session sync and run the targeted tests.", time: { created: ago(40), consumed: ago(39) } },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "god",
    model,
    content: [
      { type: "text", text: "I will protect finalized text against delayed fragments, then run the tests." },
      { type: "reasoning", text: "Snapshot history is durable; only started/ended boundaries are projected." },
      {
        type: "tool",
        id: "call_read",
        name: "read",
        executed: true,
        state: { status: "completed", input: { path: "src/remote/store.ts" }, content: [{ type: "text", text: "export function createRemoteStore(…)" }] },
        time: { created: ago(38), ran: ago(38), completed: ago(37) },
      },
      {
        type: "tool",
        id: "call_shell",
        name: "shell",
        executed: true,
        state: { status: "completed", input: { command: "bun test test/remote-sync.test.ts" }, content: [], time: { created: ago(36), ran: ago(36), completed: ago(6) } },
      },
      {
        type: "tool",
        id: "call_watch",
        name: "shell",
        executed: true,
        state: {
          status: "completed",
          input: { command: "bun test --watch", background: true },
          content: [{ type: "text", text: "The command was moved to the background." }],
          structured: { shellID: "sh_bg", truncated: false, status: "running" },
          time: { created: ago(35), ran: ago(35), completed: ago(34) },
        },
      },
    ],
    time: { created: ago(38), completed: ago(5) },
  },
  {
    id: "msg_assistant_2",
    type: "assistant",
    agent: "god",
    model,
    content: [{ type: "text", text: "Fifteen sync cases pass. Awaiting your decision on the approval requests." }],
    time: { created: ago(5), completed: ago(4) },
  },
  {
    id: "msg_assistant_denial",
    type: "assistant",
    agent: "god",
    model,
    content: [
      {
        type: "text",
        text: "The denial probe must not run, so I recorded the unbroken command instead of executing it.",
      },
      {
        type: "tool",
        id: "call_denial",
        name: "shell",
        executed: true,
        state: {
          status: "completed",
          input: { command: unbrokenCommand },
          content: [{ type: "text", text: unbrokenCommand }],
          time: { created: ago(3), ran: ago(3), completed: ago(3) },
        },
      },
    ],
    time: { created: ago(3), completed: ago(2) },
  },
  {
    id: "msg_shell",
    type: "shell",
    shellID: "sh_fixture",
    command: "bun test test/remote-sync.test.ts",
    status: "exited",
    exit: 0,
    output: { output: longOutput, cursor: longOutput.length, size: longOutput.length },
    time: { created: ago(36), completed: ago(6) },
  },
  {
    id: "msg_shell_paged",
    type: "shell",
    shellID: "sh_paged",
    command: "bun test --verbose",
    status: "exited",
    exit: 0,
    output: {
      output: pagedCapturePages[0],
      cursor: pagedCaptureCursors[1],
      size: pagedCaptureCursors[3],
      truncated: false,
    },
    time: { created: ago(30), completed: ago(20) },
  },
  {
    id: "msg_shell_live",
    type: "shell",
    shellID: "sh_live",
    command: "bun run dev",
    status: "running",
    time: { created: ago(1) },
  },
  {
    id: "msg_shell_error",
    type: "shell",
    shellID: "sh_error",
    command: "git push --force",
    status: "exited",
    exit: 1,
    output: { output: "rejected\n", cursor: 9, size: 40, truncated: false },
    time: { created: ago(4), completed: ago(3) },
  },
  {
    id: "msg_shell_denial",
    type: "shell",
    shellID: "sh_denial",
    command: unbrokenCommand,
    status: "exited",
    exit: 1,
    output: { output: unbrokenCommand, cursor: unbrokenCommand.length, size: unbrokenCommand.length },
    time: { created: ago(2), completed: ago(1) },
  },
  {
    id: "msg_system_denial",
    type: "system",
    text: `Guardrail review rejected: ${unbrokenCommand}`,
    time: { created: ago(2) },
  },
  {
    id: "msg_reasoning_denial",
    type: "assistant",
    agent: "god",
    model,
    content: [{ type: "reasoning", text: `The review rejected ${unbrokenCommand}, so nothing runs.` }],
    time: { created: ago(2), completed: ago(2) },
  },
  {
    id: "msg_assistant_error_denial",
    type: "assistant",
    agent: "god",
    model,
    error: { message: `Denied: ${unbrokenCommand}` },
    content: [],
    time: { created: ago(2), completed: ago(2) },
  },
  {
    id: "msg_assistant_tool_error_denial",
    type: "assistant",
    agent: "god",
    model,
    content: [
      {
        type: "tool",
        id: "call_denied",
        name: "shell",
        executed: false,
        state: {
          status: "error",
          input: { command: unbrokenCommand },
          content: [{ type: "image", mimeType: unbrokenCommand }],
          error: { message: `Denied by review: ${unbrokenCommand}` },
          time: { created: ago(2), ran: ago(2), completed: ago(2) },
        },
      },
    ],
    time: { created: ago(2), completed: ago(2) },
  },
]
const transcriptProbe = accountParams.get("transcriptProbe") === "1"
const responseProbe = accountParams.get("responseProbe") === "1"
const childQuestion = accountParams.get("childQuestion") === "1"
const questionFlow = accountParams.get("questionFlow") === "1"
let childQuestionAnswered = false
let releaseChildAnswer: (() => void) | undefined
Object.assign(window, { remoteReleaseChildAnswer: () => releaseChildAnswer?.() })
let probeText = "## Stable heading\n\nParagraph before streaming.\n\n```ts\nconst pending = 1"
let messages: readonly unknown[] = transcriptProbe ? [...Array.from({ length: 12 }, (_, index) => [
    { id: `probe_prompt_${index}`, type: "user", text: `Investigate part ${index}`, time: { created: index * 2 + 1, consumed: index * 2 + 2 } },
    { id: `probe_reply_${index}`, type: "assistant", agent: "god", model, content: [{ type: "text", text: `## Part ${index}\n\n${"Verified content remains in place. ".repeat(8)}` }], time: { created: index * 2 + 2, completed: index * 2 + 3 } },
  ]).flat(),
    { id: "probe_tool_only", type: "assistant", agent: "god", model, content: [{ type: "tool", id: "call_heading", name: "read", state: { status: "completed", content: [] } }], time: { created: 25, completed: 26 } },
    { id: "probe_thought_only", type: "assistant", agent: "god", model, content: [{ type: "reasoning", text: "A private planning note" }], time: { created: 27, completed: 28 } },
    { id: "probe_mixed_reply", type: "assistant", agent: "god", model, content: [{ type: "reasoning", text: "Planning" }, { type: "text", text: "A real assistant reply" }], time: { created: 29, completed: 30 } },
  ] : responseProbe ? [] : remoteScenarioData?.messages ?? defaultMessages

const permission = { id: "per_fixture", sessionID, action: "shell", resources: ["bun test *"], metadata: {} }
const guardrail = {
  id: "grq_fixture",
  sessionID,
  rootSessionID: sessionID,
  action: "rm -rf build",
  resources: ["build"],
  ruleIDs: ["standard-broad-deletion"],
  reason: "Recursive deletion needs a human decision",
  standard: true,
  hardReview: true,
}
const permissions = remoteScenarioData?.permissions ?? [permission]
const guardrails = remoteScenarioData?.guardrails ?? [guardrail]
const form = {
  id: "frm_fixture",
  sessionID,
  title: "Questions",
  metadata: { kind: "question", ...(questionFlow ? { tool: { messageID: "msg_question_flow", callID: "call_question_flow" } } : {}) },
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Scope",
      description: "Which sessions should the workspace reload after reconnect?",
      options: [
        { value: "Active only", label: "Active only", description: "Reload just the session you are watching" },
        { value: "All advertised", label: "All advertised", description: "Reload every session in the advertisement" },
      ],
      custom: true,
    },
  ],
}
if (questionFlow) messages = [{ id: "msg_question_flow", type: "assistant", content: [{ type: "tool", id: "call_question_flow", name: "question", state: { status: "running", input: { questions: [{ header: "Scope", question: "Which sessions should the workspace reload after reconnect?", options: [{ label: "Active only", description: "Reload just the session you are watching" }, { label: "All advertised", description: "Reload every session in the advertisement" }] }] }, content: [] } }], time: { created: ago(1) } }]
const allForm = {
  id: "frm_all_fixture",
  sessionID,
  title: "Native Form field coverage",
  metadata: { kind: "form" },
  fields: [
    {
      key: "choice",
      type: "string",
      title: "String choice",
      required: true,
      options: [{ value: "show", label: "Show follow-up" }, { value: "hide", label: "Hide follow-up" }],
      custom: true,
    },
    { key: "tags", type: "multiselect", title: "Tags", required: true, options: [{ value: "alpha", label: "Alpha" }, { value: "beta", label: "Beta" }], custom: true, default: ["alpha"], minItems: 1, maxItems: 3 },
    { key: "amount", type: "number", title: "Amount", required: true, minimum: 0, maximum: 10 },
    { key: "count", type: "integer", title: "Count", required: true, minimum: 2, maximum: 5, default: 3 },
    { key: "confirm", type: "boolean", title: "Confirm", default: false },
    { key: "followup", type: "string", title: "Chained follow-up", required: true, when: [{ key: "choice", op: "eq", value: "show" }, { key: "confirm", op: "eq", value: true }] },
    { key: "downstream", type: "string", title: "Transitive follow-up", required: true, when: [{ key: "followup", op: "eq", value: "continue" }] },
    { key: "external", type: "external", title: "External step", url: "https://example.com/forms-fixture" },
    { key: "unsafe", type: "external", title: "Unsafe step", url: "javascript:alert(1)" },
  ],
}

const constraintsForm = {
  id: "frm_constraints",
  sessionID,
  title: "Native constraint semantics",
  fields: [
    { key: "pattern", type: "string", pattern: "a", default: "ba", required: true },
    { key: "integer", type: "integer", minimum: 0.5, default: 1, required: true },
    { key: "email", type: "string", format: "email", default: "δοκιμή@example.com", required: true },
  ],
}

const catalog = {
  agents: [
    { id: "GSD", name: "GSD", description: "All-round agent", mode: "primary", hidden: false },
    { id: "architect", name: "architect", description: "Plans cross-package changes", mode: "primary", hidden: false, model: { providerID: "openai", id: "gpt-6-sol", variant: "medium" } },
    { id: "reviewer", name: "reviewer", description: "Reviews a diff and reports findings", mode: "subagent", hidden: false },
    { id: "btw", name: "btw", description: "Side question", mode: "subagent", hidden: false },
    { id: "compaction", name: "compaction", mode: "primary", hidden: true },
  ],
  models: [
    { providerID: "openai", providerName: "OpenAI", id: model.id, name: "Gpt 6", variants: ["low", "medium", "high"] },
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", variants: ["high", "max"] },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-sol", name: "GPT-6 Sol", variants: ["low", "medium", "high", "xhigh"] },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-luna", name: "GPT-6 Luna", variants: ["none", "low", "medium", "high"] },
    { providerID: "openrouter", providerName: "OpenRouter", id: "perceptron/perceptron-mk1.5", name: "Perceptron Mk1.5", variants: [] },
    ...(accountParams.get("largeCatalog") === "1" ? Array.from({ length: 548 }, (_, index) => ({ providerID: "test", providerName: "Catalog test", id: `model-${index + 5}`, name: `Catalog model ${index + 5}`, variants: [] })) : []),
  ],
  defaultModel: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
  commands: [
    { name: "plan", description: "Draft an implementation plan" },
    { name: "review", description: "Review the working tree" },
  ],
  skills: [
    { id: "frontend-workflow", name: "frontend-workflow", description: "Implement or review existing frontend UI", slash: true },
    { id: "git-commit-message", name: "git-commit-message", description: "Write commit messages from inspected changes", slash: false },
  ],
  references: [{ name: "design-system", uri: "file:///workspace/design-system", description: "/workspace/design-system" }],
  resources: [{ name: "Runbook", uri: "mcp://docs/runbook", description: "Operations runbook" }],
}

const fixtureFiles = [
  { path: "apps/web/src/remote/store.ts", kind: "file" },
  { path: "apps/web/src/remote/ui/composer.tsx", kind: "file" },
  { path: "apps/web/src/remote", kind: "directory" },
  { path: "packages/remote/src/index.ts", kind: "file" },
  { path: "docs/runtime.md", kind: "file" },
  { path: "README.md", kind: "file" },
].map((file) => ({ ...file, uri: `file:///workspace/ycoding/${file.path}` }))

const usageDay = 86_400_000
const usageTokens = (scale: number) => ({ input: 42_000 * scale, output: 9_800 * scale, reasoning: 3_100 * scale, cache: { read: 18_400 * scale, write: 900 * scale } })
const usageMetrics = (scale: number, cost?: number) => ({
  logical: 12 * scale, physical: 13 * scale, helpers: scale, continued: 0, fallback: 0, tokens: usageTokens(scale), cacheReadReported: true,
  ...(cost === undefined ? {} : { cost, costProvenance: "recorded" as const }),
})
const fixtureUsageProviders = (now: number) => [
  { providerID: "openai", label: "Codex", profile: "Pro", status: "available", source: "provider_internal_api", stability: "best_effort", updatedAt: now - 60_000, windows: [
    { id: "session", label: "Session", unit: "percent", used: 38, resetAt: now + 2 * 3_600_000, periodSeconds: 18_000 },
    { id: "weekly", label: "Weekly", unit: "percent", used: 72, resetAt: now + 3 * usageDay, periodSeconds: 604_800 },
  ] },
  { providerID: "openrouter", label: "OpenRouter · Pay as you go", status: "available", source: "provider_api", stability: "stable", updatedAt: now - 30_000, windows: [
    { id: "daily", label: "Today", unit: "usd", used: 1.84 },
    { id: "weekly", label: "This Week", unit: "usd", used: 8.21 },
    { id: "monthly", label: "This Month", unit: "usd", used: 27.65 },
    { id: "credits", label: "Credits", unit: "usd", used: 61.58, limit: 100, remaining: 38.42 },
    { id: "balance", label: "Balance", unit: "usd", remaining: 38.42 },
  ] },
  { providerID: "github-copilot", label: "GitHub Copilot", profile: "Pro", status: "available", source: "provider_internal_api", stability: "best_effort", updatedAt: now - 120_000, windows: [
    { id: "credits", label: "AI credits", unit: "percent", used: 41, resetAt: now + 12 * usageDay },
  ] },
]
const fixtureUsageReport = (input: Readonly<Record<string, unknown>> | undefined) => {
  const group = typeof input?.group === "string" ? input.group : "model"
  const from = typeof input?.from === "number" ? input.from : Date.now() - 29 * usageDay
  const today = new Date()
  if (group === "model" && from === Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)) {
    const month = [
      { key: "openai/gpt-6-sol", label: "openai/gpt-6-sol", ...usageMetrics(6, 18.4) },
      { key: "openrouter/deepseek-v4", label: "openrouter/deepseek-v4", ...usageMetrics(3, 5.2) },
      { key: "github-copilot/gpt-4o", label: "github-copilot/gpt-4o", ...usageMetrics(1, 2.7) },
    ]
    return { data: { group, rows: month, total: usageMetrics(10, 26.3), rowCount: month.length } }
  }
  const rows = group === "day"
    ? Array.from({ length: 30 }, (_, index) => {
      const key = new Date(from + index * usageDay).toISOString().slice(0, 10)
      return { key, label: key, ...usageMetrics(1 + (index % 5), index % 7 === 0 ? undefined : 0.35 * (1 + (index % 5))) }
    })
    : [
      { key: group === "model" ? "openai/gpt-6-sol" : `${group}_a`, label: group === "model" ? "openai/gpt-6-sol" : group === "agent" ? "GSD" : group === "project" ? "ycoding" : "Stream remote output safely", ...usageMetrics(6, 18.4) },
      { key: group === "model" ? "anthropic/claude-opus-5.5" : `${group}_b`, label: group === "model" ? "anthropic/claude-opus-5.5" : group === "agent" ? "explore" : group === "project" ? "db-pruner" : "Async Auth Token Revocation Migration", ...usageMetrics(3, 7.9) },
      { key: group === "model" ? "openrouter/deepseek%2Fdeepseek-v4" : `${group}_c`, label: group === "model" ? "openrouter/deepseek/deepseek-v4" : group === "agent" ? "compaction" : group === "project" ? "mesh" : "Archived: release notes", ...usageMetrics(1) },
    ]
  return { data: { group, rows, total: usageMetrics(10, 26.3), rowCount: rows.length } }
}

type Fixture = {
  readonly store: RemoteStore
  readonly drop: () => void
  readonly stream: () => void
  readonly team: () => void
  readonly teamCancelled: () => void
  readonly teamPrompt: (id: string) => Promise<string>
  readonly createdSideChatID: () => string | undefined
  readonly status: (running: readonly string[], attention: readonly string[], failed?: readonly string[]) => void
  readonly invalidateSessions: () => void
  readonly missTerminal: () => void
  readonly formRequests: () => readonly { readonly operation: string; readonly input: Readonly<Record<string, unknown>> | undefined }[]
  readonly mutationRequests: () => readonly { readonly operation: string; readonly input: Readonly<Record<string, unknown>> | undefined }[]
  readonly inventoryRequests: () => number
  readonly inventoryInputs: () => readonly Readonly<Record<string, unknown>>[]
  readonly operationReport: () => { readonly transports: number; readonly operations: Readonly<Record<string, number>> }
  readonly transcriptDelta: (delta: string) => void
  readonly transcriptRefresh: () => Promise<void>
  readonly readingTail: (kind: "progress" | "decisions" | "settle" | "epoch") => Promise<void>
  readonly responseSnapshot: (messages: readonly unknown[], captured: RemoteCapturedChangesPage["data"], running: boolean) => Promise<void>
}

function createFixtureStore(): Fixture {
  const providerAuth = createProviderAuthFixture()
  Object.assign(window, { providerAuthFixture: providerAuth })
  let handlers: RemoteTransportHandlers | undefined
  let open = true
  let streamed = false
  let nextSeq = 43
  let snapshotWatermark = 42
  let sourceEpoch = "epoch_fixture"
  let probeStarted = false
  let probeClock = 0
  let probeCaptured = "after"
  let readingDecision = false
  const readingForm = { ...form, id: "frm_reading", fields: [{ key: "q0", type: "string", title: "Decision", description: "Keep the reader's position?", options: [] }] }
  let responseCaptured: RemoteCapturedChangesPage["data"] = []
  let teamReported = false
  let teamCancelState: "running" | "cancelling" | "cancelled" = "running"
  let teamShellKilled = false
  let createdSideChatID: string | undefined
  let liveReads = 0
  const formRequests: { operation: string; input: Readonly<Record<string, unknown>> | undefined }[] = []
  const mutationRequests: { operation: string; input: Readonly<Record<string, unknown>> | undefined }[] = []
  const inventoryInputs: Readonly<Record<string, unknown>>[] = []
  let transportsCreated = 0
  let currentYolo = remoteScenarioData?.autonomy.yolo ?? 2
  const operationCounts = new Map<string, number>()
  const workspaces = [
    { id: "workspace_fixture", projectID: "prj_remote", directory: "/workspace/ycoding", name: "YCoding" },
    { id: "workspace_other", projectID: "prj_other", directory: "/workspace/other", name: "Other repository" },
  ]
  const createdSessions = new Map<string, {
    id: string
    title: string
    projectID: string
    location: { directory: string }
    time: { created: number; updated: number }
    agent?: string
    model?: unknown
  }>()
  const groupOf = (value: unknown) => {
    const record = value as { readonly projectID?: string; readonly location?: { readonly directory?: string } }
    const projectID = record.projectID ?? "prj_remote"
    const directory = record.location?.directory ?? "/workspace/ycoding"
    return { id: workspaces.find((workspace) => workspace.projectID === projectID && workspace.directory === directory)?.id
      ?? `wsp_${projectID}_${directory.replaceAll("/", "_")}`,
      projectID, directory, name: directory.split("/").at(-1) ?? projectID }
  }
  /** Requests this synthetic agent has already answered; a later list read omits them. */
  const answered = new Set<string>()
  const unreplied = <T extends { readonly id: string }>(requests: readonly T[]) => requests.filter((request) => !answered.has(request.id))

  /**
   * One page per request from the fixture device, with absolute byte cursors. The live
   * shell's first read meets a command whose remaining bytes are an incomplete character,
   * which the device reports as an empty page at the unchanged cursor.
   */
  const shellOutputPage = async (input?: Readonly<Record<string, unknown>>): Promise<RemoteRequestOutcome> => {
    const shellID = typeof input?.shellID === "string" ? input.shellID : ""
    const cursor = typeof input?.cursor === "number" ? input.cursor : 0
    if (shellID === "sh_bg") {
      return {
        status: "ok",
        value: { data: { output: backgroundCapture, cursor: byteLength(backgroundCapture), size: byteLength(backgroundCapture), truncated: false } },
      }
    }
    if (shellID === "sh_live") {
      liveReads += 1
      if (liveReads === 1) {
        // Slow enough that a browser check can observe the in-flight state before it settles.
        await new Promise((resolve) => setTimeout(resolve, 2_500))
        return { status: "ok", value: { data: { output: "", cursor: 0, size: byteLength(liveCapture), truncated: false } } }
      }
      return {
        status: "ok",
        value: { data: { output: liveCapture, cursor: byteLength(liveCapture), size: byteLength(liveCapture), truncated: false } },
      }
    }
    if (shellID === "sh_paged") {
      const size = pagedCaptureCursors[pagedCaptureCursors.length - 1]!
      const index = pagedCaptureCursors.indexOf(cursor)
      const page = index < 0 ? undefined : pagedCapturePages[index]
      if (page === undefined) return { status: "ok", value: { data: { output: "", cursor: size, size, truncated: false } } }
      return {
        status: "ok",
        value: { data: { output: page, cursor: pagedCaptureCursors[index + 1], size, truncated: false } },
      }
    }
    return { status: "failed", error: { code: "unknown_operation", message: "unsupported operation" } }
  }

  let fixtureNotices: readonly RemoteNotice[] = []
  let previousStatus = { running: new Set(statusRunning), attention: new Set<string>() }
  let noticeSerial = 0

  const storedLatency: { receivedAt: number; sample: RemoteLatencySample }[] = [{ receivedAt: Date.now(), sample: {
    kind: "request", at: new Date().toISOString(), operation: "session.list", outcome: "ok", queueMs: 0, settlementMs: 8, totalMs: 8,
  } }]
  if (accountParams.get("latencyPages") === "1") for (let index = 1; index <= 60; index += 1)
    storedLatency.push({ receivedAt: Date.now() - index, sample: {
      kind: "request", at: new Date().toISOString(), operation: "session.list", outcome: "ok", queueMs: index, settlementMs: 8, totalMs: index + 8,
    } })

  const outcome = (
    operation: RemoteOperation | RemoteNoticeOperation,
    input?: Readonly<Record<string, unknown>>,
    targetSessionID = sessionID,
  ): RemoteRequestOutcome | Promise<RemoteRequestOutcome> => {
    if (operation.startsWith("provider.auth.")) return providerAuth.request(operation, input)
    if (inventoryHeld && (operation === "session.list" || operation === "workspace.list" && input?.sessionsOnly === true))
      return new Promise<void>((resolve) => inventoryWaiters.push(resolve)).then(() => outcome(operation, input, targetSessionID))
    if (operation === "notice.subscribe" || operation === "notice.list") {
      const before = operation === "notice.list" && typeof input?.before === "string" ? noticeSequence(input.before) ?? Infinity : Infinity
      const older = [...fixtureNotices].reverse().filter((notice) => (noticeSequence(notice.id) ?? 0) < before)
      const notices = older.slice(0, RemoteLimits.noticePageSize)
      const last = notices.at(-1)
      return { status: "ok", value: noticePageValue({ notices, ...(older.length > notices.length && last !== undefined ? { next: last.id } : {}), total: fixtureNotices.length, unavailable: false }) }
    }
    if (operation === "notice.read" || operation === "notice.readAll") {
      const ids = operation === "notice.readAll" ? fixtureNotices.map((notice) => notice.id) : Array.isArray(input?.ids) ? input.ids.filter((id): id is string => typeof id === "string") : []
      const removed = fixtureNotices.filter((notice) => ids.includes(notice.id)).map((notice) => notice.id)
      fixtureNotices = fixtureNotices.filter((notice) => !ids.includes(notice.id))
      if (operation === "notice.readAll") handlers?.onNotices?.({ type: "notice.cleared" })
      else if (removed.length > 0) handlers?.onNotices?.({ type: "notice.removed", ids: removed, total: fixtureNotices.length })
      return { status: "ok", value: null }
    }
    operationCounts.set(operation, (operationCounts.get(operation) ?? 0) + 1)
    if (operation === "session.attachment.upload") {
      const uploaded: RemoteRequestOutcome = { status: "ok", value: input?.last ? { uri: `ycoding-upload://${String(input.uploadID)}` } : {} }
      return accountParams.get("attachmentGate") === "1" ? attachmentGate.promise.then(() => uploaded) : uploaded
    }
    if (operation === "machine.latency.list") {
      const offset = typeof input?.before === "string" ? Number(atob(input.before)) : 0
      const limit = typeof input?.limit === "number" ? input.limit : 60
      const next = offset + limit < storedLatency.length ? btoa(String(offset + limit)) : undefined
      return { status: "ok", value: { data: storedLatency.slice(offset, offset + limit), cursor: next === undefined ? {} : { next } } }
    }
    if (operation === "machine.latency.append") {
      const samples = Array.isArray(input?.samples) ? input.samples.filter(isRemoteLatencySample) : []
      storedLatency.unshift(...samples.map((sample) => ({ receivedAt: Date.now(), sample })))
      return { status: "ok", value: { accepted: samples.length } }
    }
    if (responseProbe && operation === "session.capturedChanges.list") return { status: "ok", value: { data: structuredClone(responseCaptured) } }
    if (transcriptProbe && operation === "session.todo.list") return { status: "ok", value: { data: [{ content: "Verify stable transcript", status: "in_progress", priority: "high" }] } }
    if (transcriptProbe && operation === "session.capturedChanges.list") return { status: "ok", value: { data: [{ placementMessageID: "probe_reply_4", path: "src/probe.ts", additions: 1, deletions: 1, status: "modified", files: [{ path: "src/probe.ts", diff: `@@ -1 +1 @@\n-before\n+${probeCaptured}`, additions: 1, deletions: 1, status: "modified" }] }] } }
    if (connectionMode === "offline") return { status: "failed", error: { code: "agent_unavailable", message: "No local agent is connected" } }
    if (accountParams.get("teamControls") === "unsupported" && ["session.team.economics", "session.team.shell.list", "session.team.shell.kill", "session.side-chat.list", "session.side-chat.create", "session.subagent.cancel", "session.subagent.answer"].includes(operation))
      return { status: "failed", error: { code: "unknown_operation", message: "Update YCoding on this machine" } }
    if ([
      "session.prompt", "session.autonomy.set", "session.goal.set", "session.goal.stop", "session.guardrail.reply", "session.create",
      "session.command", "session.skill", "session.switchModel", "session.switchAgent",
      "session.subagent.cancel", "session.subagent.answer", "session.team.shell.kill", "session.side-chat.create",
    ].includes(operation)) {
      mutationRequests.push({ operation, input })
    }
    if (operation === "session.catalog" || operation === "workspace.catalog") return { status: "ok", value: catalog }
    if (operation === "session.file.find" || operation === "workspace.file.find") {
      const query = typeof input?.query === "string" ? input.query.toLowerCase() : ""
      const limit = typeof input?.limit === "number" ? input.limit : 20
      return { status: "ok", value: { files: fixtureFiles.filter((file) => file.path.toLowerCase().includes(query)).slice(0, limit) } }
    }
    if (operation === "session.status") return { status: "ok", value: {
      running: emptyBackend ? [] : [...statusRunning],
      attention: unreplied(permissions).length + unreplied(guardrails).length > 0 ? [sessionID] : [],
    } }
    if (operation === "usage.providers") return { status: "ok", value: { data: fixtureUsageProviders(Date.now()) } }
    if (operation === "usage.summary") return { status: "ok", value: { data: usageMetrics(10, 26.3) } }
    if (operation === "usage.report") return { status: "ok", value: fixtureUsageReport(input) }
    if (operation === "session.command") return { status: "ok", value: { data: { ...input, admittedSeq: 44 } } }
    if (operation === "session.skill" || operation === "session.switchModel" || operation === "session.switchAgent") return { status: "ok", value: null }
    if (operation === "workspace.list") {
      if (accountParams.get("workspaces") === "overflow") return { status: "ok", value: { data: [
        ...workspaces,
        ...Array.from({ length: 20 }, (_, index) => ({ id: `workspace_more_${index}`, projectID: `project_more_${index}`, directory: `/workspace/example-${index}`, name: `Example ${index + 1}` })),
      ] } }
      if (accountParams.get("workspaces") === "many") return { status: "ok", value: { data: [
        { id: "workspace_fixture", projectID: "prj_remote", directory: "/workspace/ycoding", name: "ycoding" },
        { id: "workspace_agents", projectID: "12fd42415fd3fa9c65332dd8ad2128cc83499df6", directory: "/Users/me/.agents", name: ".agents" },
        { id: "workspace_worktree", projectID: "3e5803fe818b6335dfb7f71ec17671f3fa4cd538", directory: "/Users/me/Project/ycoding.worktrees/office", name: "office" },
        { id: "workspace_archive", projectID: "8139fb02d3972656a258b05074bf17af4f6a9a6a", directory: "/Users/me/Archive/ycoding", name: "ycoding" },
        { id: "workspace_proxy", projectID: "6c9b1273dcfa1c7614271448a568d2e27f6db3d3", directory: "/Users/me/Project/llama-cpp-proxy-with-a-long-repository-name", name: "llama-cpp-proxy-with-a-long-repository-name" },
      ] } }
      if (accountParams.get("workspaces") === "error" && input?.sessionsOnly !== true) return { status: "failed", error: { code: "internal_error", message: "Workspace inventory unavailable" } }
      if (input?.sessionsOnly === true && inventoryCount > 0) return { status: "ok", value: { data: workspaces } }
      if (input?.sessionsOnly === true) return { status: "ok", value: { data: [...new Map([...(emptyBackend ? [] : sessions), ...createdSessions.values()].map((session) => {
        const group = groupOf(session)
        return [group.id, group] as const
      })).values()] } }
      return { status: "ok", value: { data: accountParams.get("workspaces") === "empty" ? [] : workspaces } }
    }
    if (operation === "session.create") {
      const workspace = workspaces.find((item) => item.id === input?.workspace)
      if (!workspace || typeof input?.id !== "string") return { status: "failed", error: { code: "invalid_message", message: "Unknown workspace" } }
      if (accountParams.get("creation") === "failed") return { status: "failed", error: { code: "invalid_message", message: "Workspace directory is unavailable" } }
      const existing = createdSessions.get(input.id)
      const created = existing ?? { id: input.id, title: "New session", projectID: workspace.projectID, location: { directory: workspace.directory }, time: { created: Date.now(), updated: Date.now() },
        ...(typeof input.agent === "string" ? { agent: input.agent } : {}), ...(input.model === undefined ? {} : { model: input.model }) }
      createdSessions.set(created.id, created)
      if (existing === undefined) setTimeout(() => handlers?.onSessions?.(), 0)
      if (accountParams.get("creation") === "unknown") return { status: "unknown", error: { code: "outcome_unknown", message: "Connection closed before creation settled" } }
      const result: RemoteRequestOutcome = { status: "ok", value: { data: created } }
      const delay = Number(accountParams.get("creationDelay") ?? 0)
      return delay > 0 ? new Promise((resolve) => setTimeout(() => resolve(result), delay)) : result
    }
    if (operation === "session.get") {
      if (emptyBackend && !createdSessions.has(targetSessionID))
        return { status: "failed", error: { code: "session_not_allowed", message: "Session not found" } }
      const info = createdSessions.get(targetSessionID) ?? sessions.find((item) => item.id === targetSessionID)
      return info ? { status: "ok", value: { data: info } } : { status: "failed", error: { code: "session_not_allowed", message: "Session not found" } }
    }
    if (operation === "session.list") {
      inventoryInputs.push(input ?? {})
      if (inventoryCount > 0) {
        const offset = Number(input?.cursor ?? 0)
        const limit = inventoryPageRows > 0 ? inventoryPageRows : Math.min(50, Number(input?.limit ?? 50))
        const odd = input?.workspace === "workspace_other"
        const sought = typeof input?.search === "string" ? Number(input.search.match(/\d+$/)?.[0]) : NaN
        const ids = input?.status === "running" ? [14_000] : typeof input?.search === "string"
          ? Number.isInteger(sought) && sought >= 0 && sought < inventoryCount && (input.status !== "idle" || sought !== 14_000) ? [sought] : []
          : undefined
        const count = ids === undefined ? input?.workspace === undefined ? inventoryCount : odd ? Math.floor(inventoryCount / 2) : Math.ceil(inventoryCount / 2)
          : ids.filter((id) => id % 2 === Number(odd)).length
        const data = Array.from({ length: Math.min(limit, Math.max(0, count - offset)) }, (_, index) => {
          const number = ids === undefined ? input?.workspace === undefined ? offset + index : (offset + index) * 2 + Number(odd) : ids[offset + index]!
          const other = number % 2 === 1
          return { id: `ses_inventory_${number}`, title: `Inventory Session ${number}`, projectID: other ? "prj_other" : "prj_remote",
            location: { directory: other ? "/workspace/other" : "/workspace/ycoding" }, time: { created: number, updated: inventoryCount - number } }
        })
        const result = { status: "ok" as const, value: { data, cursor: { ...(offset > 0 ? { previous: String(Math.max(0, offset - limit)) } : {}),
          ...(offset + data.length < count ? { next: String(offset + data.length) } : {}) } } }
        if (input?.workspace !== undefined && accountParams.get("sessionListGate") === "1" && sessionListsHeld)
          return new Promise<RemoteRequestOutcome>((resolve) => heldSessionLists.push(() => resolve(result)))
        return input?.workspace !== undefined && sessionListDelayMs > 0
          ? new Promise<RemoteRequestOutcome>((resolve) => setTimeout(() => resolve(result), sessionListDelayMs)) : result
      }
      return { status: "ok", value: { data: [...createdSessions.values(), ...(emptyBackend ? [] : sessions)]
        .filter((session) => input?.workspace === undefined || groupOf(session).id === input.workspace)
        .filter((session) => input?.parentID !== null || (session as { readonly parentID?: string }).parentID === undefined)
        .filter((session) => input?.status === "running" ? statusRunning.has(session.id)
          : input?.status === "idle" ? !statusRunning.has(session.id) && Reflect.get(session.time, "archived") === undefined : true)
        .sort((left, right) => input?.order === "desc" ? right.time.updated - left.time.updated : 0)
        .slice(0, typeof input?.limit === "number" ? input.limit : undefined) } }
    }
    if (operation === "session.active") return { status: "ok", value: { data: { [sessionID]: { type: "running" } } } }
    if (operation === "session.subagent.list") {
      if (accountParams.get("team") === "unsupported") return { status: "failed", error: { code: "unknown_operation", message: "Unknown operation" } }
      const tasks = targetSessionID === sessionID && accountParams.get("team") !== "none" ? [{
        sessionID: "ses_child", parentID: sessionID, description: "Fix flaky suite", agent: "general", model, background: true,
        state: childQuestion && !childQuestionAnswered ? "waiting" : teamReported ? "completed" : teamCancelState, revision: teamReported ? 2 : teamCancelState === "running" ? 1 : 2,
        ...(childQuestion && !childQuestionAnswered ? { question: { id: "qst_fixture", text: "May I update the scoped tests?", time: ago(1) } } : {}),
        time: { created: ago(30), updated: ago(teamReported ? 0 : 4) },
      }, ...(accountParams.get("team") === "two" ? [{ sessionID: "ses_second", parentID: sessionID, description: "Inspect source", agent: "researcher", model, background: true,
        state: "running", revision: 1, time: { created: ago(20), updated: ago(2) } }] : [])] : []
      return { status: "ok", value: { data: tasks, summary: { total: tasks.length }, cursor: {} } }
    }
    if (operation === "session.team.economics") return { status: "ok", value: { data: Array.isArray(input?.sessionIDs) ? input.sessionIDs.map((id) => ({ sessionID: id, cost: 0.25, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } }, cacheHitRatio: 0.75, contextTotal: 800, contextLimit: 2_000, cacheRead: 3, cacheWrite: 0 })) : [] } }
    if (operation === "session.subagent.answer" && childQuestion) {
      if (targetSessionID !== sessionID || input?.childID !== "ses_child" || input.questionID !== "qst_fixture" || childQuestionAnswered)
        return { status: "failed", error: { code: "forbidden", message: "Question is not pending in this family" } }
      const answered = (): RemoteRequestOutcome => {
        childQuestionAnswered = true
        return { status: "ok", value: { data: { sessionID: "ses_child", parentID: sessionID, description: "Fix flaky suite", agent: "general", model, background: true, state: "running", revision: 3, time: { created: ago(30), updated: ago(0) } } } }
      }
      return accountParams.get("childAnswerGate") === "1" ? new Promise<void>((resolve) => { releaseChildAnswer = resolve }).then(answered) : answered()
    }
    if (operation === "session.subagent.cancel") {
      if (targetSessionID !== sessionID || input?.childID !== "ses_child") return { status: "failed", error: { code: "forbidden", message: "Not a managed child" } }
      teamCancelState = "cancelling"
      return { status: "ok", value: { data: { sessionID: "ses_child", parentID: sessionID, description: "Fix flaky suite", agent: "general", model, background: true, state: "cancelling", revision: 2, time: { created: ago(30), updated: ago(1) } } } }
    }
    if (operation === "session.team.shell.list") return { status: "ok", value: { data: [{ id: "sh_team", ownerID: "ses_child", command: "bun test", status: teamShellKilled ? "killed" : "running", startedAt: ago(10) }] } }
    if (operation === "session.team.shell.kill") {
      if (targetSessionID !== sessionID || input?.shellID !== "sh_team") return { status: "failed", error: { code: "forbidden", message: "Shell is outside this family" } }
      teamShellKilled = true
      return { status: "ok", value: null }
    }
    if (operation === "session.side-chat.list") return { status: "ok", value: { data: [{ id: "ses_btw", title: "Side question", updatedAt: ago(2) },
      ...(createdSideChatID ? [{ id: createdSideChatID, title: "New side chat", updatedAt: Date.now() }] : [])], cursor: {} } }
    if (operation === "session.side-chat.create") {
      if (targetSessionID !== sessionID || typeof input?.id !== "string") return { status: "failed", error: { code: "forbidden", message: "Side chat root is unavailable" } }
      createdSideChatID = input.id
      const created = { id: input.id, parentID: sessionID, agent: "btw", title: "New side chat", projectID: "prj_remote", location: { directory: "/workspace/ycoding" }, time: { created: Date.now(), updated: Date.now() } }
      createdSessions.set(created.id, created)
      handlers?.onSessions?.()
      return { status: "ok", value: { data: created } }
    }
    if (operation === "session.family.activity" && accountParams.get("familyActivity") === "unsupported") return { status: "failed", error: { code: "unknown_operation", message: "Update YCoding" } }
    if (operation === "session.family.activity") return { status: "ok", value: { data: [
      { sessionID, executing: accountParams.get("team") !== "two", ...(accountParams.get("team") === "two" ? {} : { activity: { kind: "tool", room: "developer", text: "Editing store.ts" } }) },
      ...(Array.isArray(input?.sessionIDs) ? input.sessionIDs.filter((id): id is string => typeof id === "string") : []).map((id) => ({ sessionID: id, executing: true, activity: id === "ses_second"
        ? { kind: "tool", room: "research", text: "Reading projection.ts" }
        : { kind: "tool", room: "qa", text: "Running bun test" } })),
    ] } }
    if (operation === "session.snapshot") {
      return {
        status: "ok",
        value: {
          sourceEpoch,
          session: createdSessions.get(targetSessionID) ?? sessions.find((item) => item.id === targetSessionID),
          messages: targetSessionID === sessionID ? structuredClone(messages) : targetSessionID === "ses_child" && accountParams.has("childTranscript") ? structuredClone(defaultMessages) : [],
          watermark: { type: "log.synced", aggregateID: targetSessionID, seq: targetSessionID === sessionID ? snapshotWatermark : 0 },
        },
      }
    }
    if (operation === "session.autonomy.get") {
      if (createdSessions.has(targetSessionID)) return { status: "ok", value: { data: { mode: "normal", yolo: 0 } } }
      return {
        status: "ok",
        value: {
          data: remoteScenarioData?.autonomy ?? {
            mode: "normal",
            yolo: 2,
            ...(accountParams.get("goal") === "none" ? {} : { goal: { text: "Ship the remote workspace", status: "active", iteration: 3, noProgress: 0, maxNoProgress: 5 } }),
          },
        },
      }
    }
    if (operation === "session.permission.list") return { status: "ok", value: { data: targetSessionID === sessionID && accountParams.get("team") !== "two" ? unreplied(permissions) : [] } }
    if (operation === "session.guardrail.request.list") return { status: "ok", value: { data: targetSessionID === sessionID && accountParams.get("team") !== "two" ? unreplied(guardrails) : [] } }
    if (operation === "session.form.list" && readingDecision && targetSessionID === sessionID) return { status: "ok", value: [readingForm] }
    if (operation === "session.form.list") return {
      status: "ok",
      value: targetSessionID !== sessionID || accountParams.get("team") === "two" ? [] : remoteScenarioData === undefined
        ? formMode === "constraints" ? unreplied([constraintsForm]) : unreplied(formMode === "all" ? [form, allForm] : [form])
        : unreplied(remoteScenarioData.forms),
    }
    if (
      operation === "session.permission.reply" ||
      operation === "session.guardrail.reply" ||
      operation === "session.form.reply" ||
      operation === "session.form.cancel"
    ) {
      const requestID = typeof input?.requestID === "string" ? input.requestID : undefined
      const formID = typeof input?.formID === "string" ? input.formID : undefined
      if (requestID !== undefined) answered.add(requestID)
      if (formID !== undefined) {
        formRequests.push({ operation, input })
      }
      if (formID !== undefined && formOutcome === "unknown") return { status: "unknown", error: { code: "outcome_unknown", message: "Synthetic unknown Form outcome" } }
      if (formID !== undefined) answered.add(formID)
      if (questionFlow && operation === "session.form.reply" && formID === form.id && typeof input?.answer === "object" && input.answer !== null && "q0" in input.answer && typeof input.answer.q0 === "string") {
        const structured = { answers: [[input.answer.q0]] }
        emitEvent(sessionID, { type: "session.tool.success", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { sessionID, assistantMessageID: "msg_question_flow", callID: "call_question_flow", structured, content: [] } })
        messages = messages.map((message) => typeof message === "object" && message !== null && Reflect.get(message, "id") === "msg_question_flow" ? { ...message, content: [{ type: "tool", id: "call_question_flow", name: "question", state: { status: "completed", input: { questions: [{ header: "Scope", question: form.fields[0]!.description, options: [] }] }, structured, content: [] } }] } : message)
        snapshotWatermark = nextSeq - 1
      }
      if (formID !== undefined && formDelayMs > 0) return new Promise((resolve) => setTimeout(() => resolve({ status: "ok", value: null }), formDelayMs))
      return { status: "ok", value: null }
    }
    if (operation === "session.prompt" && targetSessionID === "ses_child") return { status: "failed", error: { code: "subagent_read_only", message: "Managed subagents accept input only from their parent Session" } }
    if (operation === "session.prompt" && promptOutcome === "hold") {
      return new Promise((resolve) => {
        heldPrompts.push((result) => resolve(result === "ok" ? { status: "ok", value: { data: { ...input, admittedSeq: 43 } } } : result === "failed"
          ? { status: "failed", error: { code: "internal_error", message: "Synthetic failed prompt" } }
          : { status: "unknown", error: { code: "outcome_unknown", message: "Synthetic unknown prompt outcome" } }))
      })
    }
    if (operation === "session.prompt") return promptOutcome === "unknown"
      ? { status: "unknown", error: { code: "outcome_unknown", message: "Synthetic unknown prompt outcome" } }
      : { status: "ok", value: { data: { ...input, admittedSeq: 43 } } }
    if (operation === "session.shell.output") return shellOutputPage(input)
    if (operation === "session.autonomy.set") {
      if (typeof input?.yolo === "number") currentYolo = input.yolo
      return { status: "ok", value: { data: { mode: "normal", yolo: currentYolo } } }
    }
    if (operation === "session.goal.set") {
      if (typeof input?.goal !== "string") return { status: "failed", error: { code: "invalid_message", message: "Goal text is required" } }
      const active: RemoteRequestOutcome = { status: "ok", value: { data: { mode: "goal", yolo: currentYolo,
        goal: { text: input.goal, status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } } } }
      if (!goalGate) return active
      return new Promise((resolve) => {
        releaseGoal = (result) => resolve(result === "ok" ? active : result === "failed"
          ? { status: "failed", error: { code: "internal_error", message: "Goal calculation failed" } }
          : { status: "unknown", error: { code: "outcome_unknown", message: "Request timed out" } })
      })
    }
    if (operation === "session.goal.stop") return { status: "ok", value: { data: { mode: "normal", yolo: currentYolo } } }
    return { status: "ok", value: null }
  }

  const emitEvent = (sessionID: string, event: unknown) => handlers?.onEvents?.(sessionID, [event])

  const transport: RemoteTransport = {
    connect: () => {
      handlers?.onStatus?.({ kind: "open" })
      handlers?.onSessions?.()
    },
    close: () => {},
    setPriority: () => {},
    status: (): RemoteTransportStatus => ({ kind: open ? "open" : "closed", code: open ? 1000 : 1006, reason: "", retryable: false }),
    request: async (operation, request) => {
      if (!open) return { status: "unavailable", reason: "not-connected" }
      if (requestLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, requestLatencyMs))
      requestLog.push({ at: Math.round(performance.now()), operation, ...(request?.input === undefined ? {} : { input: operation.startsWith("provider.auth.") ? Object.fromEntries(Object.entries(request.input).filter(([key]) => key !== "key" && key !== "code" && key !== "inputs")) : request.input }) })
      return outcome(operation, request?.input, request?.sessionID)
    },
  }

  const store = createRemoteStore({
    http: syntheticHttp,
    ...(accountParams.has("latencyUploadMs") ? { latencyUploadIntervalMs: Number(accountParams.get("latencyUploadMs")) } : {}),
    ...(transcriptProbe || responseProbe ? { now: () => Date.now() + probeClock, schedule: (callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms >= 1_000 ? 1 : ms)
      return () => clearTimeout(timer)
    } } : {}),
    createTransport: (deviceID, transportHandlers) => {
      transportsCreated += 1
      handlers = transportHandlers
      if (relayAddress !== undefined) {
        const wire = createRemoteTransport({ url: relayAddress.href, handlers: transportHandlers })
        return {
          ...wire,
          request: async (operation, request) => {
            if (operation !== "session.guardrail.reply" && operation !== "session.shell.output") return outcome(operation, request?.input, request?.sessionID)
            const result = await wire.request(operation, request)
            if (result.status === "ok" && typeof request?.input?.requestID === "string") answered.add(request.input.requestID)
            return result
          },
        }
      }
      return { ...transport, request: (operation, request) => {
        deviceRequests.push({ deviceID, operation, ...(request?.sessionID === undefined ? {} : { sessionID: request.sessionID }) })
        return transport.request(operation, request)
      } }
    },
    deviceName: () => "Studio Mac",
  })

  const drop = () => {
    open = false
    handlers?.onStatus?.({ kind: "closed", code: 1006, reason: "synthetic disconnect", retryable: true })
    handlers?.onStatus?.({ kind: "connecting", attempt: 1 })
    setTimeout(() => {
      open = true
      handlers?.onStatus?.({ kind: "open" })
      handlers?.onReconnect?.()
    }, 400)
  }

  const stream = () => {
    if (streamed) return
    streamed = true
    const steps: readonly unknown[] = [
      { type: "session.status", data: { sessionID, status: { type: "busy" } } },
      { type: "session.step.started", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { assistantMessageID: "msg_live", agent: "god", model } },
      { type: "session.text.started", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { assistantMessageID: "msg_live", ordinal: 0 } },
      { type: "session.text.delta", data: { assistantMessageID: "msg_live", ordinal: 0, delta: "Streaming " } },
      { type: "session.text.delta", data: { assistantMessageID: "msg_live", ordinal: 0, delta: "through " } },
      { type: "session.text.delta", data: { assistantMessageID: "msg_live", ordinal: 0, delta: "the relay." } },
      {
        type: "session.tool.success",
        durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 },
        data: { assistantMessageID: "msg_live", callID: "call_live", content: [{ type: "text", text: "bound output kept locally scrollable" }] },
      },
      {
        type: "session.text.ended",
        durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 },
        data: { assistantMessageID: "msg_live", ordinal: 0, text: "Streaming through the relay with bounded tool output." },
      },
    ]
    for (const [index, event] of steps.entries()) {
      setTimeout(() => emitEvent(sessionID, event), index * 60)
    }
  }

  const team = () => {
    emitEvent(sessionID, {
      id: "evt_team_delegate",
      type: "session.tool.progress",
      durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 },
      data: { sessionID, assistantMessageID: "msg_team", callID: "call_subagent", structured: { sessionID: "ses_child", status: "running" } },
    })
    setTimeout(() => {
      teamReported = true
      emitEvent(sessionID, {
        id: "evt_team_report",
        type: "session.synthetic",
        durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 },
        data: {
          sessionID,
          messageID: "msg_team_report",
          text: "Subagent ses_child completed.",
          metadata: { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 2 },
        },
      })
    }, 400)
  }

  const status = (running: readonly string[], attention: readonly string[], failed?: readonly string[]) => {
    statusRunning = new Set(running)
    const next = { running: new Set(running), attention: new Set(attention) }
    const added = [
      ...attention.filter((id) => !previousStatus.attention.has(id)).map((sessionID) => ({ category: "approval-requested" as const, sessionID })),
      ...[...previousStatus.running].filter((id) => !next.running.has(id) && !next.attention.has(id)).map((sessionID) => ({ category: "agent-completed" as const, sessionID })),
    ].map((notice) => ({ ...notice, id: `ntc_${++noticeSerial}`, createdAt: Date.now() }))
    previousStatus = next
    handlers?.onSessionStatus?.({ running, attention, ...(failed === undefined ? {} : { failed }) })
    if (added.length === 0) return
    fixtureNotices = [...fixtureNotices, ...added]
    handlers?.onNotices?.({ type: "notice.added", notices: added, total: fixtureNotices.length })
    if (!pushDelivered) handlers?.onNotices?.({ type: "notice.present", items: added.map((notice) => ({ kind: "notice", notice })) })
  }

  return {
    store, drop, stream, team, invalidateSessions: () => handlers?.onSessions?.(), missTerminal: () => {
      emitEvent(sessionID, { type: "session.execution.started", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { sessionID } })
      statusRunning = new Set()
      snapshotWatermark = nextSeq++
    }, teamCancelled: () => {
      teamCancelState = "cancelled"
      emitEvent(sessionID, { id: "evt_team_cancelled", type: "session.synthetic", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 },
        data: { sessionID, messageID: "msg_team_cancelled", text: "Subagent cancelled", metadata: { source: "subagent_notification", childID: "ses_child", type: "cancelled", revision: 3 } } })
    }, teamPrompt: async (id) => {
      const result = await outcome("session.prompt", { id: "msg_team_probe", text: "Follow up", delivery: "steer" }, id)
      return result.status === "failed" || result.status === "unknown" ? result.error.code : result.status
    }, createdSideChatID: () => createdSideChatID,
    status, formRequests: () => formRequests, mutationRequests: () => mutationRequests, inventoryRequests: () => inventoryInputs.length, inventoryInputs: () => inventoryInputs,
    transcriptDelta: (delta) => {
      if (!probeStarted) {
        probeStarted = true
        emitEvent(sessionID, { type: "session.step.started", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { assistantMessageID: "probe_tail", agent: "god", model } })
        emitEvent(sessionID, { type: "session.text.started", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { assistantMessageID: "probe_tail", ordinal: 0 } })
        emitEvent(sessionID, { type: "session.text.delta", data: { assistantMessageID: "probe_tail", ordinal: 0, delta: probeText } })
        messages = [...messages, { id: "probe_tail", type: "assistant", agent: "god", model, content: [{ type: "text", text: probeText }], time: { created: 30 } }]
        snapshotWatermark = nextSeq - 1
      }
      probeText += delta
      messages = messages.map((message) => typeof message === "object" && message !== null && Reflect.get(message, "id") === "probe_tail"
        ? { ...message, content: [{ type: "text", text: probeText }] } : message)
      emitEvent(sessionID, { type: "session.text.delta", data: { assistantMessageID: "probe_tail", ordinal: 0, delta } })
    },
    transcriptRefresh: async () => {
      probeClock += 11_000
      probeCaptured = "fresh"
      handlers?.onSessions?.()
      await store.reloadMessages()
    },
    readingTail: async (kind) => {
      const data = { sessionID, assistantMessageID: "probe_tail", callID: "call_reading" }
      if (kind === "progress") {
        emitEvent(sessionID, { type: "session.tool.input.started", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { ...data, name: "shell" } })
        emitEvent(sessionID, { type: "session.tool.called", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { ...data, input: { command: "bun test scoped" }, executed: false } })
        emitEvent(sessionID, { type: "session.tool.progress", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { ...data, structured: {}, content: [{ type: "text", text: "Progress output ".repeat(100) }] } })
        messages = messages.map((message) => typeof message === "object" && message !== null && Reflect.get(message, "id") === "probe_tail" ? { ...message, content: [{ type: "text", text: probeText }, { type: "tool", id: "call_reading", name: "shell", state: { status: "running", input: { command: "bun test scoped" }, structured: {}, content: [{ type: "text", text: "Progress output ".repeat(100) }] } }] } : message)
      }
      if (kind === "decisions") {
        readingDecision = true
        emitEvent(sessionID, { type: "todo.updated", data: { sessionID, todos: Array.from({ length: 4 }, (_, index) => ({ content: `Reading task ${index}`, status: "in_progress", priority: "high" })) } })
        emitEvent(sessionID, { type: "form.created", data: { form: readingForm } })
      }
      if (kind === "settle") {
        probeClock += 11_000
        emitEvent(sessionID, { type: "session.tool.success", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { ...data, structured: {}, content: [{ type: "text", text: "Focused checks passed" }] } })
        emitEvent(sessionID, { type: "session.step.ended", durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 }, data: { sessionID, assistantMessageID: "probe_tail", finish: "stop", cost: 0, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } })
        messages = messages.map((message) => typeof message === "object" && message !== null && Reflect.get(message, "id") === "probe_tail" ? { ...message, content: [{ type: "text", text: probeText }, { type: "tool", id: "call_reading", name: "shell", state: { status: "completed", input: { command: "bun test scoped" }, structured: {}, content: [{ type: "text", text: "Focused checks passed" }] } }], time: { created: 30, completed: Date.now() + probeClock } } : message)
      }
      snapshotWatermark = nextSeq - 1
      if (kind === "epoch") { sourceEpoch = "epoch_reading"; await store.reloadMessages() }
    },
    responseSnapshot: async (projected, captured, running) => {
      messages = projected
      responseCaptured = captured
      snapshotWatermark = nextSeq++
      probeClock += 11_000
      emitEvent(sessionID, { type: running ? "session.execution.started" : "session.execution.succeeded", data: { sessionID } })
      status(running ? [sessionID] : [], [])
      handlers?.onSessions?.()
      await store.reloadMessages()
    },
    operationReport: () => ({ transports: transportsCreated, operations: Object.fromEntries(operationCounts) }),
  }
}

const fixture = createFixtureStore()
Object.assign(window, { transcriptDelta: fixture.transcriptDelta, transcriptRefresh: fixture.transcriptRefresh, responseSnapshot: fixture.responseSnapshot, responseStatus: () => fixture.store.state().view?.status })
Object.assign(window, { remoteReadingTail: fixture.readingTail })
Object.assign(window, { providerAuthState: () => fixture.store.state() })
Object.assign(window, { remoteReloadMessages: fixture.store.reloadMessages })
Object.assign(window, { remoteInventoryReport: () => ({ requests: fixture.inventoryRequests(), rows: fixture.store.state().sessions.length,
  groups: fixture.store.state().sessionGroups.length, next: fixture.store.state().sessionHasNext,
  first: fixture.store.state().sessions[0]?.id, last: fixture.store.state().sessions.at(-1)?.id, inputs: fixture.inventoryInputs(),
  firstListed: fixture.store.state().sessions.find((session) => session.id.startsWith("ses_inventory_"))?.id,
  workspaceRequests: fixture.inventoryInputs().filter((input) => input.workspace !== undefined).length,
  listStatus: fixture.store.state().sessionListStatus }), remoteInvalidateSessions: fixture.invalidateSessions })

/** Picks the device and session a user would pick, so the fixture opens on a live workspace. */
async function openFixtureWorkspace(store: RemoteStore) {
  await store.load()
  const requestedDevice = accountParams.get("device_id") ?? "dev_studio"
  if (devices.some((device) => device.id === requestedDevice && device.status === "active" && device.online) && store.state().activeDeviceID !== requestedDevice) store.connect(requestedDevice)
  for (let attempt = 0; attempt < 40 && store.state().sessions.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!accountParams.has("noSelection") && !remoteScenarioData?.noSelection && !accountParams.has("session_id") && store.state().activeSessionID === undefined) await store.selectSession(sessionID)
  if (transcriptProbe) fixture.transcriptDelta("")
}

/** Selects the fixture device and lets the real store settle its rejected list read. */
async function openFixtureUnavailableWorkspace(store: RemoteStore) {
  await store.load()
  if (store.state().activeDeviceID !== "dev_studio") store.connect("dev_studio")
}

/**
 * The fixture drives the workspace into a live session, but an account-state scenario owns
 * the account surfaces: forcing a connection after a rejected or unavailable account answer
 * would paint the very state the scenario exists to disprove.
 */
if (deviceMode !== null) void fixture.store.load()
else if (accountMode === "ok" && (connectionMode === "offline" || emptyBackend)) void openFixtureUnavailableWorkspace(fixture.store)
else if (accountMode === "ok") void openFixtureWorkspace(fixture.store)
else void fixture.store.load()

/**
 * Verification helper for the 320px transcript overflow. A page-level `scrollWidth`
 * above the viewport width means an unbroken token escaped its container, so a browser
 * check reads `window.remoteOverflowReport()` at each width instead of pasting a probe.
 */
function remoteOverflowReport() {
  const documentElement = document.documentElement
  const offenders = [...document.body.querySelectorAll("*")].flatMap((element) => {
    if (!escapesClipping(element)) return []
    const style = getComputedStyle(element)
    const contained = style.overflowX !== "visible" || style.overflowY !== "visible"
    const box = element.getBoundingClientRect()
    const protrudes = box.right > documentElement.clientWidth + 0.5
    const contentEscapes = box.left + element.scrollWidth > documentElement.clientWidth + 0.5
    if (!protrudes && !(contentEscapes && !contained)) return []
    const classes = (element.getAttribute("class") ?? "").split(" ").filter(Boolean).join(".")
    return [{ element: `${element.tagName.toLowerCase()}${classes.length === 0 ? "" : `.${classes}`}`, protrudes, textOverflow: !contained }]
  })
  const shellCommand = [...document.querySelectorAll(".shell__header code")].find((element) =>
    (element.textContent ?? "").includes("REMOTE_DENIAL"),
  )
  const shellOutput = [...document.querySelectorAll("pre.output")].find((element) =>
    (element.textContent ?? "").includes("REMOTE_DENIAL"),
  )
  const outputCode = shellOutput?.querySelector("code")
  return {
    width: window.innerWidth,
    documentScrollWidth: documentElement.scrollWidth,
    fits: documentElement.scrollWidth <= documentElement.clientWidth,
    offenders,
    inline: shellCommand === undefined ? undefined : {
      whiteSpace: getComputedStyle(shellCommand).whiteSpace,
      clipped: shellCommand.scrollWidth > shellCommand.clientWidth + 1,
      laidOut: shellCommand.scrollHeight <= shellCommand.clientHeight + 1,
    },
    preformatted: shellOutput === undefined || outputCode == null ? undefined : {
      overflowX: getComputedStyle(shellOutput).overflowX,
      codeWhiteSpace: getComputedStyle(outputCode).whiteSpace,
      scrolls: shellOutput.scrollWidth > shellOutput.clientWidth + 1,
    },
  }
}

/** Walks up to the body: a scroll or hidden ancestor already contains the element. */
function escapesClipping(element: Element): boolean {
  let node = element.parentElement
  while (node !== null && node !== document.body) {
    if (getComputedStyle(node).overflowX !== "visible") return false
    node = node.parentElement
  }
  return true
}

/**
 * Verification helper for the paged terminal output. A browser check reads
 * `window.remoteShellOutputReport()` instead of pasting DOM queries, so the report
 * describes exactly what the real shell and tool components rendered: the text the client
 * holds, the device-limit notice, the page control, and the current request state.
 */
function remoteShellOutputReport() {
  return [...document.querySelectorAll(".transcript-shell-output")].map((element) => {
    const container = element.closest(".shell, .transcript-tool")
    return {
      container: container?.classList.contains("shell") === true ? "shell" : "tool",
      command:
        container?.querySelector(".shell__header code")?.textContent ??
        container?.querySelector(".transcript-tool__name")?.textContent ??
        "",
      output: element.querySelector("pre.output code")?.textContent ?? undefined,
      notices: [...element.querySelectorAll("p.shell__pending")].map((node) => node.textContent ?? ""),
      buttons: [...element.querySelectorAll("button")].map((node) => (node.textContent ?? "").trim()),
    }
  })
}

/** Browser-only readout of the synthetic native Form transport and rendered inputs. */
function remoteFormReport() {
  return {
    requests: fixture.formRequests(),
    forms: [...document.querySelectorAll(".request form")].map((element) => ({
      title: element.querySelector(".request__header span")?.textContent ?? "",
      controls: [...element.querySelectorAll("input, textarea, button")].map((control) => ({
        type: control instanceof HTMLInputElement ? control.type : control instanceof HTMLTextAreaElement ? "textarea" : "button",
        name: control.getAttribute("name"),
        label: control.closest("label")?.textContent?.trim(),
        value: control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control.value : control.textContent?.trim(),
        checked: control instanceof HTMLInputElement ? control.checked : undefined,
        disabled: control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLButtonElement ? control.disabled : undefined,
      })),
    })),
  }
}

function remoteMutationReport() {
  return fixture.mutationRequests()
}

;(window as typeof window & { remoteShellOutputReport?: typeof remoteShellOutputReport }).remoteShellOutputReport =
  remoteShellOutputReport

;(window as typeof window & { remoteOverflowReport?: typeof remoteOverflowReport }).remoteOverflowReport =
  remoteOverflowReport

;(window as typeof window & { remoteFormReport?: typeof remoteFormReport }).remoteFormReport = remoteFormReport
;(window as typeof window & { remoteMutationReport?: typeof remoteMutationReport }).remoteMutationReport = remoteMutationReport
;(window as typeof window & { remoteOperationReport?: typeof fixture.operationReport }).remoteOperationReport = fixture.operationReport
;(window as typeof window & { remoteTeamControl?: { cancelled: typeof fixture.teamCancelled; prompt: typeof fixture.teamPrompt; createdID: typeof fixture.createdSideChatID } }).remoteTeamControl = {
  cancelled: fixture.teamCancelled, prompt: fixture.teamPrompt, createdID: fixture.createdSideChatID,
}
;(window as typeof window & { remoteStatus?: typeof fixture.status }).remoteStatus = fixture.status
;(window as typeof window & { remoteMissTerminal?: typeof fixture.missTerminal }).remoteMissTerminal = fixture.missTerminal

const fixtureView = remoteScenarioData?.view ?? new URLSearchParams(window.location.search).get("view") ?? "chat"
const fixtureSelection = fixtureView === "chat" && !accountParams.has("noSelection") && !remoteScenarioData?.noSelection && !emptyBackend
const fixturePath = fixtureView === "chat" ? fixtureSelection ? "/remote/session" : "/remote" : `/remote/${fixtureView}`
const fixtureSearch = new URLSearchParams(window.location.search)
if (fixtureSelection) {
  if (!fixtureSearch.has("session_id")) fixtureSearch.set("session_id", sessionID)
  if (!fixtureSearch.has("device_id")) fixtureSearch.set("device_id", "dev_studio")
}
window.history.replaceState(null, "", `${fixturePath}?${fixtureSearch}`)

function FixturePage() {
  onMount(() => {
    if (remoteScenarioData?.openControl === undefined || remoteScenarioData.openControl === "device") return
    let attempts = 0
    const open = () => {
      attempts += 1
      const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Create enrollment code"))
      if (button !== undefined) button.click()
      if (button !== undefined || attempts === 40) clearInterval(timer)
    }
    const timer = setInterval(open, 50)
    open()
  })
  return (
    <div class="fixture">
      <p class="fixture__banner" role="status">
        {relayAddress === undefined
          ? "Synthetic fixture build — transport and account calls are local stubs. Not a real session, account, or relay."
          : "Verification fixture — account and session reads are synthetic; guardrail replies and shell output use a loopback relay socket."}
      </p>
      <div class="fixture__controls">
        <button type="button" class="button button--secondary button--small" onClick={() => fixture.stream()}>
          Simulate streaming step
        </button>
        <button type="button" class="button button--secondary button--small" onClick={() => fixture.drop()}>
          Simulate disconnect and reconnect
        </button>
        <button type="button" class="button button--secondary button--small" onClick={() => fixture.team()}>
          Simulate subagent handoff
        </button>
        <button type="button" class="button button--secondary button--small" onClick={() => fixture.status([], [sessionID, "ses_archived"])}>
          Simulate status change
        </button>
      </div>
      <App createRemoteStore={() => fixture.store} />
    </div>
  )
}

const root = document.getElementById("app")
if (!root) throw new Error("Missing fixture root")
if (accountParams.has("inspectOffice")) {
  const { default: Phaser } = await import("phaser")
  const original: unknown = Reflect.get(Phaser.Game.prototype, "start")
  if (typeof original !== "function") throw new Error("Office game hook unavailable")
  Reflect.set(Phaser.Game.prototype, "start", function (this: Phaser.Game) {
    original.call(this)
    const mounts = Reflect.get(window, "__officeMounts")
    Object.assign(window, { __officeGame: this, __officeMounts: (typeof mounts === "number" ? mounts : 0) + 1 })
  })
}
pwaInstall.start()
render(
  () => (
    <ThemeProvider>
      <FixturePage />
    </ThemeProvider>
  ),
  root,
)
