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
import { RouterProvider } from "../src/router/router"
import { ThemeProvider } from "../src/theme/theme-store"
import { App } from "../src/app"
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
import type { RemoteDeviceInfo, RemoteOperation } from "@ycoding-ai/remote"
import { remoteScenario } from "./remote-scenarios"
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
/** `?formOutcome=unknown` leaves the native Form mutation unresolved without replay. */
const formOutcome = accountParams.get("formOutcome")
const promptOutcome = accountParams.get("promptOutcome")
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
  logout: async () => ok(undefined),
}

const defaultSessions = [
  { id: sessionID, title: "Stream remote output safely", projectID: "prj_remote", location: { directory: "/workspace/ycoding" }, agent: "god", model, time: { created: ago(42), updated: ago(1) }, running: true },
  { id: "ses_archived", title: "Archived: release notes", time: { created: ago(300), updated: ago(280), archived: ago(280) } },
  { id: "ses_child", title: "Child: fix flaky suite", parentID: sessionID, time: { created: ago(30), updated: ago(4) } },
]
const sessions = remoteScenarioData?.sessions ?? defaultSessions
const inventoryCount = Math.min(15_000, Math.max(0, Number(accountParams.get("inventoryCount") ?? 0) || 0))

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
const messages = remoteScenarioData?.messages ?? defaultMessages

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
  metadata: { kind: "question" },
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
    { providerID: "anthropic", providerName: "Anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", variants: ["high", "max"], defaultVariant: "high" },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-sol", name: "GPT-6 Sol", variants: ["low", "medium", "high", "xhigh"], defaultVariant: "medium" },
    { providerID: "openai", providerName: "OpenAI", id: "gpt-6-luna", name: "GPT-6 Luna", variants: ["none", "low", "medium", "high"], defaultVariant: "medium" },
    { providerID: "openrouter", providerName: "OpenRouter", id: "perceptron/perceptron-mk1.5", name: "Perceptron Mk1.5", variants: [] },
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
  const rows = group === "day"
    ? Array.from({ length: 30 }, (_, index) => {
      const key = new Date(from + index * usageDay).toISOString().slice(0, 10)
      return { key, label: key, ...usageMetrics(1 + (index % 5), index % 7 === 0 ? undefined : 0.35 * (1 + (index % 5))) }
    })
    : [
      { key: `${group}_a`, label: group === "model" ? "openai/gpt-6-sol" : group === "agent" ? "GSD" : group === "project" ? "ycoding" : "Stream remote output safely", ...usageMetrics(6, 18.4) },
      { key: `${group}_b`, label: group === "model" ? "anthropic/claude-opus-5.5" : group === "agent" ? "explore" : group === "project" ? "db-pruner" : "Async Auth Token Revocation Migration", ...usageMetrics(3, 7.9) },
      { key: `${group}_c`, label: group === "model" ? "openrouter/deepseek/deepseek-v4" : group === "agent" ? "compaction" : group === "project" ? "mesh" : "Archived: release notes", ...usageMetrics(1) },
    ]
  return { data: { group, rows, total: usageMetrics(10, 26.3), rowCount: rows.length } }
}

type Fixture = {
  readonly store: RemoteStore
  readonly drop: () => void
  readonly stream: () => void
  readonly team: () => void
  readonly status: (running: readonly string[], attention: readonly string[]) => void
  readonly formRequests: () => readonly { readonly operation: string; readonly input: Readonly<Record<string, unknown>> | undefined }[]
  readonly mutationRequests: () => readonly { readonly operation: string; readonly input: Readonly<Record<string, unknown>> | undefined }[]
  readonly inventoryRequests: () => number
  readonly operationReport: () => { readonly transports: number; readonly operations: Readonly<Record<string, number>> }
}

function createFixtureStore(): Fixture {
  let handlers: RemoteTransportHandlers | undefined
  let open = true
  let streamed = false
  let nextSeq = 43
  let teamReported = false
  let liveReads = 0
  const formRequests: { operation: string; input: Readonly<Record<string, unknown>> | undefined }[] = []
  const mutationRequests: { operation: string; input: Readonly<Record<string, unknown>> | undefined }[] = []
  let inventoryRequests = 0
  let transportsCreated = 0
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
    return { id: projectID === "prj_remote" && directory === "/workspace/ycoding"
      ? "workspace_fixture" : `wsp_${projectID}_${directory.replaceAll("/", "_")}`,
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

  const outcome = (
    operation: RemoteOperation,
    input?: Readonly<Record<string, unknown>>,
    targetSessionID = sessionID,
  ): RemoteRequestOutcome | Promise<RemoteRequestOutcome> => {
    operationCounts.set(operation, (operationCounts.get(operation) ?? 0) + 1)
    if (connectionMode === "offline") return { status: "failed", error: { code: "agent_unavailable", message: "No local agent is connected" } }
    if ([
      "session.prompt", "session.autonomy.set", "session.guardrail.reply", "session.create",
      "session.command", "session.skill", "session.switchModel", "session.switchAgent",
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
      running: emptyBackend ? [] : [sessionID],
      attention: unreplied(permissions).length + unreplied(guardrails).length > 0 ? [sessionID] : [],
    } }
    if (operation === "usage.providers") return { status: "ok", value: { data: fixtureUsageProviders(Date.now()) } }
    if (operation === "usage.summary") return { status: "ok", value: { data: usageMetrics(10, 26.3) } }
    if (operation === "usage.report") return { status: "ok", value: fixtureUsageReport(input) }
    if (operation === "session.command") return { status: "ok", value: { data: { ...input, admittedSeq: 44 } } }
    if (operation === "session.skill" || operation === "session.switchModel" || operation === "session.switchAgent") return { status: "ok", value: null }
    if (operation === "workspace.list") {
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
      const info = createdSessions.get(targetSessionID) ?? sessions.find((item) => item.id === targetSessionID)
      return info ? { status: "ok", value: { data: info } } : { status: "failed", error: { code: "session_not_allowed", message: "Session not found" } }
    }
    if (operation === "session.list") {
      inventoryRequests += 1
      if (inventoryCount > 0) {
        const offset = Number(input?.cursor ?? 0)
        const limit = Math.min(50, Number(input?.limit ?? 50))
        const odd = input?.workspace === "workspace_other"
        const sought = typeof input?.search === "string" ? Number(input.search.match(/\d+$/)?.[0]) : NaN
        const ids = input?.status === "running" ? [14_000] : typeof input?.search === "string"
          ? Number.isInteger(sought) && sought >= 0 && sought < inventoryCount && (input.status !== "idle" || sought !== 14_000) ? [sought] : []
          : undefined
        const count = ids === undefined ? odd ? Math.floor(inventoryCount / 2) : Math.ceil(inventoryCount / 2)
          : ids.filter((id) => id % 2 === Number(odd)).length
        const data = Array.from({ length: Math.min(limit, Math.max(0, count - offset)) }, (_, index) => {
          const number = ids === undefined ? (offset + index) * 2 + Number(odd) : ids[offset + index]!
          return { id: `ses_inventory_${number}`, title: `Inventory Session ${number}`, projectID: odd ? "prj_other" : "prj_remote",
            location: { directory: odd ? "/workspace/other" : "/workspace/ycoding" }, time: { created: number, updated: inventoryCount - number } }
        })
        return { status: "ok", value: { data, cursor: { ...(offset > 0 ? { previous: String(Math.max(0, offset - limit)) } : {}),
          ...(offset + data.length < count ? { next: String(offset + data.length) } : {}) } } }
      }
      return { status: "ok", value: { data: [...createdSessions.values(), ...(emptyBackend ? [] : sessions)]
        .filter((session) => input?.workspace === undefined || groupOf(session).id === input.workspace)
        .filter((session) => input?.parentID !== null || (session as { readonly parentID?: string }).parentID === undefined) } }
    }
    if (operation === "session.active") return { status: "ok", value: { data: { [sessionID]: { type: "running" } } } }
    if (operation === "session.subagent.list") {
      if (accountParams.get("team") === "unsupported") return { status: "failed", error: { code: "unknown_operation", message: "Unknown operation" } }
      const tasks = targetSessionID === sessionID && accountParams.get("team") !== "none" ? [{
        sessionID: "ses_child", parentID: sessionID, description: "Fix flaky suite", agent: "general", model, background: true,
        state: teamReported ? "completed" : "running", revision: teamReported ? 2 : 1,
        time: { created: ago(30), updated: ago(teamReported ? 0 : 4) },
      }] : []
      return { status: "ok", value: { data: tasks, summary: { total: tasks.length }, cursor: {} } }
    }
    if (operation === "session.snapshot") {
      return {
        status: "ok",
        value: {
          sourceEpoch: "epoch_fixture",
          session: createdSessions.get(targetSessionID) ?? sessions.find((item) => item.id === targetSessionID),
          messages: targetSessionID === sessionID ? messages : [],
          watermark: { type: "log.synced", aggregateID: targetSessionID, seq: targetSessionID === sessionID ? 42 : 0 },
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
            goal: { text: "Ship the remote workspace", status: "active", iteration: 3, noProgress: 0, maxNoProgress: 5 },
          },
        },
      }
    }
    if (operation === "session.permission.list") return { status: "ok", value: { data: targetSessionID === sessionID ? unreplied(permissions) : [] } }
    if (operation === "session.guardrail.request.list") return { status: "ok", value: { data: targetSessionID === sessionID ? unreplied(guardrails) : [] } }
    if (operation === "session.form.list") return {
      status: "ok",
      value: targetSessionID !== sessionID ? [] : remoteScenarioData === undefined
        ? formMode === "constraints" ? unreplied([constraintsForm]) : unreplied(formMode === "all" ? [form, allForm] : [form])
        : unreplied(remoteScenarioData.forms),
    }
    if (operation === "session.fileChange.list" && accountParams.get("files") === "recorded") return {
      status: "ok",
      value: { data: [{ path: "src/remote/store.ts", patch: `@@ -1 +1 @@\n-old\n+${"updated".repeat(80)}<img src=x onerror=alert(1)>`, additions: 1, deletions: 1 }] },
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
      if (formID !== undefined && formDelayMs > 0) return new Promise((resolve) => setTimeout(() => resolve({ status: "ok", value: null }), formDelayMs))
      return { status: "ok", value: null }
    }
    if (operation === "session.prompt") return promptOutcome === "unknown"
      ? { status: "unknown", error: { code: "outcome_unknown", message: "Synthetic unknown prompt outcome" } }
      : { status: "ok", value: { data: { ...input, admittedSeq: 43 } } }
    if (operation === "session.shell.output") return shellOutputPage(input)
    if (operation === "session.goal.set" || operation === "session.goal.stop" || operation === "session.autonomy.set") {
      return { status: "ok", value: { data: { mode: "normal", yolo: typeof input?.yolo === "number" ? input.yolo : 2 } } }
    }
    return { status: "ok", value: null }
  }

  const transport: RemoteTransport = {
    connect: () => {
      handlers?.onStatus?.({ kind: "open" })
      handlers?.onSessions?.()
    },
    close: () => {},
    status: (): RemoteTransportStatus => ({ kind: open ? "open" : "closed", code: open ? 1000 : 1006, reason: "", retryable: false }),
    request: async (operation, request) => {
      if (!open) return { status: "unavailable", reason: "not-connected" }
      return outcome(operation, request?.input, request?.sessionID)
    },
  }

  const store = createRemoteStore({
    http: syntheticHttp,
    createTransport: (_deviceID, transportHandlers) => {
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
      return transport
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
      setTimeout(() => handlers?.onEvent?.(sessionID, event), index * 60)
    }
  }

  const team = () => {
    handlers?.onEvent?.(sessionID, {
      id: "evt_team_delegate",
      type: "session.tool.progress",
      durable: { aggregateID: sessionID, seq: nextSeq++, version: 1 },
      data: { sessionID, assistantMessageID: "msg_team", callID: "call_subagent", structured: { sessionID: "ses_child", status: "running" } },
    })
    setTimeout(() => {
      teamReported = true
      handlers?.onEvent?.(sessionID, {
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

  const status = (running: readonly string[], attention: readonly string[]) => handlers?.onSessionStatus?.({ running, attention })

  return {
    store, drop, stream, team, status, formRequests: () => formRequests, mutationRequests: () => mutationRequests, inventoryRequests: () => inventoryRequests,
    operationReport: () => ({ transports: transportsCreated, operations: Object.fromEntries(operationCounts) }),
  }
}

const fixture = createFixtureStore()
Object.assign(window, { remoteInventoryReport: () => ({ requests: fixture.inventoryRequests(), rows: fixture.store.state().sessions.length,
  groups: fixture.store.state().sessionGroups.length, next: fixture.store.state().sessionHasNext,
  first: fixture.store.state().sessions[0]?.id, last: fixture.store.state().sessions.at(-1)?.id }) })

/** Picks the device and session a user would pick, so the fixture opens on a live workspace. */
async function openFixtureWorkspace(store: RemoteStore) {
  await store.load()
  store.connect("dev_studio")
  for (let attempt = 0; attempt < 40 && store.state().sessions.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (store.state().activeSessionID === undefined) await store.selectSession(sessionID)
}

/** Selects the fixture device and lets the real store settle its rejected list read. */
async function openFixtureUnavailableWorkspace(store: RemoteStore) {
  await store.load()
  store.connect("dev_studio")
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
;(window as typeof window & { remoteStatus?: typeof fixture.status }).remoteStatus = fixture.status

const fixtureView = remoteScenarioData?.view ?? new URLSearchParams(window.location.search).get("view") ?? "chat"
const fixturePath = fixtureView === "chat" ? "/remote" : `/remote/${fixtureView}`
window.history.replaceState(null, "", `${fixturePath}${window.location.search}`)

function FixturePage() {
  onMount(() => {
    if (remoteScenarioData?.openControl === undefined) return
    let attempts = 0
    const open = () => {
      attempts += 1
      if (remoteScenarioData.openControl === "device") {
        const button = document.querySelector<HTMLButtonElement>('[aria-label="Machine"]')
        if (button !== null && !button.disabled) button.click()
        if ((button !== null && !button.disabled) || attempts === 40) clearInterval(timer)
        return
      }
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
render(
  () => (
    <RouterProvider>
      <ThemeProvider>
        <FixturePage />
      </ThemeProvider>
    </RouterProvider>
  ),
  root,
)
