import type { RemoteDeviceInfo } from "@ycoding-ai/remote"

export type RemoteScenarioName = "conversation-workspace" | "session-list" | "conversation-tool-terminal-output" | "activity-pending-decisions" | "permission-guardrail-hard-review-form-requests" | "empty-backend" | "selected-machine-offline" | "signed-out" | "devices-enrollment" | "autonomy-goal-notification-settings"
export type RemoteScenarioViewport = 1440 | 768 | 390
export type RemoteScenarioView = "chat" | "sessions" | "activity" | "settings"

type WireSession = {
  readonly id: string
  readonly title: string
  readonly projectID?: string
  readonly location?: { readonly directory: string }
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
  readonly running?: boolean
}

type WireMessage = Readonly<Record<string, unknown>>
type WirePermission = Readonly<Record<string, unknown>> & { readonly id: string }
type WireGuardrail = Readonly<Record<string, unknown>> & { readonly id: string; readonly hardReview: boolean }
type WireForm = {
  readonly id: string
  readonly sessionID: string
  readonly title: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly fields: readonly (Readonly<Record<string, unknown>> & { readonly type: string })[]
}

export type RemoteScenario = {
  readonly id: string
  readonly name: RemoteScenarioName
  readonly viewport: RemoteScenarioViewport
  readonly view: RemoteScenarioView
  readonly theme: "dark" | "light"
  readonly account: "ok" | "signedout"
  readonly accountID: string
  readonly connection: "open" | "offline"
  readonly emptyBackend: boolean
  readonly devices: readonly RemoteDeviceInfo[]
  readonly sessions: readonly WireSession[]
  readonly messages: readonly WireMessage[]
  readonly permissions: readonly WirePermission[]
  readonly guardrails: readonly WireGuardrail[]
  readonly forms: readonly WireForm[]
  readonly autonomy: Readonly<Record<string, unknown>>
  readonly openControl?: "device" | "enrollment"
  readonly expectedText: readonly string[]
}

const sessionID = "ses_fixture"
const model = { providerID: "openai", id: "gpt-6" } as const
const now = Date.now()
const time = (secondsAgo: number, archived = false) => ({
  created: now - 3_600_000,
  updated: now - secondsAgo * 1_000,
  ...(archived ? { archived: now - secondsAgo * 1_000 } : {}),
})

const studio = (online = true): RemoteDeviceInfo => ({
  id: "dev_studio",
  name: "Studio Mac",
  createdAt: 1,
  lastSeenAt: now - 20_000,
  status: "active",
  online,
})

const devLinux: RemoteDeviceInfo = {
  id: "dev_linux",
  name: "Dev Linux",
  createdAt: 2,
  lastSeenAt: now - 40_000,
  status: "active",
  online: true,
}

const workstation: RemoteDeviceInfo = {
  id: "dev_workstation",
  name: "Workstation-Box",
  createdAt: 2,
  lastSeenAt: now - 3 * 86_400_000,
  status: "active",
  online: false,
}

const legacy: RemoteDeviceInfo = {
  id: "dev_legacy",
  name: "Legacy-MacBook",
  createdAt: 3,
  lastSeenAt: now - 14 * 86_400_000,
  status: "revoked",
  online: false,
  revokedAt: now - 14 * 86_400_000,
}

const baseSession = (patch: Partial<WireSession> = {}): WireSession => ({
  id: sessionID,
  title: "Token expiry refactor",
  projectID: "project-auth",
  location: { directory: "/workspace/ycoding-engine/auth" },
  agent: "YCoding Agent",
  model,
  time: time(24),
  running: false,
  ...patch,
})

const messageTime = (minutesAgo: number) => ({ created: now - minutesAgo * 60_000, completed: now - minutesAgo * 60_000 + 1_000 })
const user = (id: string, text: string, minutesAgo: number): WireMessage => ({
  id,
  type: "user",
  text,
  time: { created: now - minutesAgo * 60_000, consumed: now - minutesAgo * 60_000 + 500 },
})
const assistant = (id: string, content: readonly Readonly<Record<string, unknown>>[], minutesAgo: number): WireMessage => ({
  id,
  type: "assistant",
  agent: "YCoding Agent",
  model,
  content,
  time: messageTime(minutesAgo),
})
const text = (value: string) => ({ type: "text", text: value })
const tool = (id: string, name: string, input: Readonly<Record<string, unknown>>, output: string, minutesAgo: number) => ({
  type: "tool",
  id,
  name,
  executed: true,
  state: {
    status: "completed",
    input,
    content: [{ type: "text", text: output }],
    time: { created: now - minutesAgo * 60_000, ran: now - minutesAgo * 60_000 + 200, completed: now - minutesAgo * 60_000 + 800 },
  },
  time: { created: now - minutesAgo * 60_000, ran: now - minutesAgo * 60_000 + 200, completed: now - minutesAgo * 60_000 + 800 },
})

const permission = (id: string, action: string, resources: readonly string[] = []): WirePermission => ({
  id,
  sessionID,
  action,
  resources,
  metadata: {},
})

const guardrail = (id: string, action: string, reason: string, hardReview: boolean): WireGuardrail => ({
  id,
  sessionID,
  rootSessionID: sessionID,
  action,
  resources: [],
  ruleIDs: [hardReview ? "hard-destructive-action" : "ordinary-review"],
  reason,
  standard: true,
  hardReview,
})

const form = (
  id: string,
  title: string,
  fields: WireForm["fields"],
  kind: "question" | "form" = "question",
): WireForm => ({ id, sessionID, title, metadata: { kind }, fields })

const conversationWorkspaceSessions = [
  baseSession(),
  baseSession({ id: "ses_indexer", title: "Query batch indexer", projectID: "project-indexer", location: { directory: "/workspace/ycoding-engine/indexer" }, running: true, time: time(120) }),
  baseSession({ id: "ses_mesh", title: "Mesh peer sync daemon", projectID: "project-mesh", location: { directory: "/workspace/ycoding-engine/mesh" }, time: time(600) }),
]

const sessionListSessions = [
  baseSession({ title: "Async Auth Token Revocation Migration", location: { directory: "/workspace/auth-gate" }, running: true, time: time(24) }),
  baseSession({ id: "ses_telemetry", title: "Telemetry Event Buffer Flush Daemon", location: { directory: "/workspace/telemetry-daemon" }, running: true, time: time(120) }),
  baseSession({ id: "ses_redis", title: "Redis Cache Cluster Rebalancing Spec", location: { directory: "/workspace/cache-redis" }, time: time(1_080) }),
  baseSession({ id: "ses_postgres", title: "Postgres Partition Pruning Worker", location: { directory: "/workspace/db-pruner" }, time: time(3_600) }),
]

function conversationWorkspaceMessages(viewport: RemoteScenarioViewport): readonly WireMessage[] {
  if (viewport === 1440) return [
    assistant("msg_assistant", [text("I've examined the token expiry check in auth_guard.go. Would you like me to update the lock retention duration and dispatch tests on Studio Mac?")], 19),
    user("msg_user", "Proceed with non-blocking lock retention and verify auth expiration tests.", 18),
  ]
  if (viewport === 768) return [
    assistant("msg_assistant", [text("Connected to Studio Mac. Updated lock retention parameters are ready for execution.")], 19),
    user("msg_user", "Run test suite against auth services.", 18),
  ]
  return [
    assistant("msg_assistant", [text("Session bound to Studio Mac in auth. Ready for prompt execution.")], 19),
    user("msg_user", "Verify non-blocking lock on expiration.", 18),
  ]
}

function conversationToolTerminalOutputMessages(viewport: RemoteScenarioViewport): readonly WireMessage[] {
  if (viewport === 1440) return [
    user("msg_user", "Please check the session bus synchronization logic during agent cancellation and review the diff patch.", 18),
    assistant("msg_assistant", [
      tool("call_ast", "Tool Output AST Symbol Analysis", { path: "session_bus.rs" }, "// Evaluated session bus dispatch\npub async fn cancel_session(&self, id: SessionId) -> Result<(), DaemonError> {\n  let mut session = self.active_sessions.lock().await;\n}", 17),
      tool("call_tests", "Test Suite Execution Output", { command: "cargo test session_cancellation" }, "Running concurrency verification tests\ntest session_cancellation_flow ... ok\ntest mutex_guard_scope ... ok", 16),
      tool("call_diff", "Diff Preview: session_bus.rs", { path: "session_bus.rs" }, "184 - let mut session = self.active_sessions.lock().await;\n184 + { let mut session = self.active_sessions.lock().await; session.mark_cancelled(id); }", 15),
    ], 17),
  ]
  if (viewport === 768) return [
    user("msg_user", "Add defensive timeout handling to the WebSocket connector in ws_adapter.rs.", 16),
    assistant("msg_assistant", [
      text("Updated connection logic with 5000ms handshake deadline."),
      tool("call_patch", "write_file_patch", { path: "ws_adapter.rs" }, "ws_adapter.rs (diff preview)\n- let socket = TcpStream::connect(&addr).await?;\n+ let socket = timeout(Duration::from_millis(5000), TcpStream::connect(&addr)).await??;", 15),
    ], 15),
  ]
  return [
    user("msg_user", "Run sanity checks on worker threads.", 12),
    assistant("msg_assistant", [
      text("Checked worker threads. All pools active without lock contention."),
      tool("call_pool", "Tool Output", { command: "pool_spin" }, "> pool_spin_ok ... ok", 11),
    ], 11),
  ]
}

function activityPendingDecisionsMessages(viewport: RemoteScenarioViewport): readonly WireMessage[] {
  const first = assistant("msg_phase", [tool("call_phase", "Agent Phase Transition", {}, "Syntax graph validation started for rewrite", 35)], 35)
  const second = assistant("msg_file", [tool("call_file", "File Updated", { path: "src/core/compiler/ast_transformer.rs" }, "Modified src/core/compiler/ast_transformer.rs", 34)], 34)
  if (viewport !== 1440) return [first, second]
  return [first, second, {
    id: "msg_command",
    type: "shell",
    shellID: "sh_command",
    command: "Command Executed",
    status: "exited",
    exit: 0,
    output: { output: "cargo check completed (0 warnings)", cursor: 34, size: 34 },
    time: messageTime(36),
  }]
}

function permissionGuardrailHardReviewFormRequestsForms(viewport: RemoteScenarioViewport): readonly WireForm[] {
  if (viewport === 768) return [form("frm_endpoints", "Multi-Choice Question Prompt", [{
    key: "endpoints",
    type: "multiselect",
    title: "Select telemetry endpoints to bridge for this remote session",
    required: true,
    default: ["syslog", "otel"],
    options: [
      { value: "syslog", label: "syslog daemon bridge (UDP 514)" },
      { value: "otel", label: "opentelemetry otlp-grpc (Port 4317)" },
      { value: "prometheus", label: "prometheus metrics scrape (/metrics)" },
    ],
  }], "form")]
  if (viewport === 390) return [form("frm_cluster", "Select Target Cluster", [{
    key: "cluster",
    type: "string",
    title: "Select Target Cluster",
    required: true,
    default: "production",
    options: [
      { value: "production", label: "Production Cluster (us-east)" },
      { value: "staging", label: "Staging Canary Cluster" },
    ],
  }])]
  return [
    form("frm_arch", "Select Target Runtime Architecture", [{
      key: "architecture",
      type: "string",
      title: "Select Target Runtime Architecture",
      required: true,
      default: "amd64",
      options: [
        { value: "amd64", label: "linux/amd64 (glibc-2.35)", description: "Default production Kubernetes cluster" },
        { value: "arm64", label: "linux/arm64 (musl)", description: "Edge IoT deployment gateway" },
      ],
    }]),
    form("frm_harness", "Enable Optional Test Harnesses", [{
      key: "harnesses",
      type: "multiselect",
      title: "Enable Optional Test Harnesses",
      default: ["browser", "audit"],
      options: [
        { value: "browser", label: "e2e-matrix-browser" },
        { value: "audit", label: "cargo-audit-vulnerabilities" },
      ],
    }], "form"),
    form("frm_custom", "Clarify Disambiguation Query", [{
      key: "directive",
      type: "string",
      title: "Clarify Disambiguation Query",
      description: "Specify override directive or path for conflicting module imports.",
      placeholder: "e.g. import { parseSessionPayload } from '@/v2/stream.ts'",
    }]),
  ]
}

function scenario(name: RemoteScenarioName, viewport: RemoteScenarioViewport): RemoteScenario {
  const common = {
    id: `${name}-${viewport}`,
    name,
    viewport,
    theme: viewport === 768 ? "light" as const : "dark" as const,
    account: "ok" as const,
    accountID: "user_fixture",
    connection: "open" as const,
    emptyBackend: false,
    devices: [studio()],
    sessions: [baseSession()],
    messages: [] as readonly WireMessage[],
    permissions: [] as readonly WirePermission[],
    guardrails: [] as readonly WireGuardrail[],
    forms: [] as readonly WireForm[],
    autonomy: { mode: "normal", yolo: 0 },
    expectedText: [] as readonly string[],
  }

  if (name === "conversation-workspace") return {
    ...common,
    view: "chat",
    devices: [studio(), devLinux],
    sessions: conversationWorkspaceSessions,
    messages: conversationWorkspaceMessages(viewport),
    ...(viewport === 1440 || viewport === 390 ? { openControl: "device" as const } : {}),
    expectedText: viewport === 390
      ? ["Session bound to Studio Mac in auth.", "Verify non-blocking lock on expiration.", "Select Active Machine", "Studio Mac", "Dev Linux"]
      : ["Token expiry refactor", "Query batch indexer", "Mesh peer sync daemon", "auth", viewport === 768 ? "Run test suite against auth services." : "auth_guard.go"],
  }
  if (name === "session-list") return {
    ...common,
    view: "sessions",
    sessions: sessionListSessions,
    expectedText: ["Async Auth Token Revocation Migration", "auth-gate", "Telemetry Event Buffer Flush Daemon", "telemetry-daemon", "Redis Cache Cluster Rebalancing Spec", "cache-redis", "Postgres Partition Pruning Worker", "db-pruner"],
  }
  if (name === "conversation-tool-terminal-output") return {
    ...common,
    view: "chat",
    messages: conversationToolTerminalOutputMessages(viewport),
    expectedText: viewport === 1440
      ? ["session bus synchronization", "Test Suite Execution Output", "Diff Preview: session_bus.rs"]
      : viewport === 768
        ? ["Add defensive timeout handling", "write_file_patch", "5000ms handshake deadline"]
        : ["Run sanity checks on worker threads.", "Checked worker threads.", "pool_spin_ok"],
  }
  if (name === "activity-pending-decisions") return {
    ...common,
    view: "activity",
    messages: activityPendingDecisionsMessages(viewport),
    permissions: [permission("per_lock", "Overwrite Cargo.lock revision?")],
    guardrails: [guardrail("grq_push", "Authorize branch push for feat/ast-cache", "Remote push requires a decision", false)],
    expectedText: ["Reported events", "Pending decisions", "Overwrite Cargo.lock revision?", "Authorize branch push for feat/ast-cache", "Agent Phase Transition", "File Updated", ...(viewport === 1440 ? ["Command Executed"] : [])],
  }
  if (name === "permission-guardrail-hard-review-form-requests") return {
    ...common,
    view: "chat",
    messages: [user("msg_user", "Review the planned refactor and answer the pending questions.", 18)],
    permissions: viewport === 768 ? [] : [permission("per_socket", viewport === 390 ? "Network Socket Access" : "Write File Request", viewport === 390 ? ["bind 0.0.0.0:8080 (TCP / LISTEN)"] : ["/etc/systemd/system/ycoding-worker.service"])],
    guardrails: viewport === 1440
      ? [
          guardrail("grq_context", "High Context Consumption", "Refactoring involves 48 modules in src/compiler/*.", false),
          guardrail("grq_hard", "Destructive Database Alteration & Git Force Push", "A human decision is required, even at YOLO 3.", true),
        ]
      : [guardrail("grq_hard", viewport === 768 ? "git reset --hard HEAD~12 && git push -f" : "rm -rf /var/log/audit/*", "A human decision is required, even at YOLO 3.", true)],
    forms: permissionGuardrailHardReviewFormRequestsForms(viewport),
    expectedText: viewport === 390
      ? ["Network Socket Access", "Guardrail review (human decision required)", "Select Target Cluster"]
      : viewport === 768
        ? ["human decision is required", "git reset --hard HEAD~12 && git push -f", "Multi-Choice Question Prompt", "syslog daemon bridge", "opentelemetry otlp-grpc", "prometheus metrics scrape"]
        : ["Write File Request", "/etc/systemd/system/ycoding-worker.service", "High Context Consumption", "Destructive Database Alteration & Git Force Push", "Select Target Runtime Architecture", "Enable Optional Test Harnesses", "Clarify Disambiguation Query"],
  }
  if (name === "empty-backend") return {
      ...common,
      view: "chat",
      emptyBackend: true,
      sessions: [],
      expectedText: ["No sessions", "Start YCoding in your project folder on this machine."],
    }
  if (name === "selected-machine-offline") return {
      ...common,
      view: "chat",
      connection: "offline",
      devices: [studio(false)],
      sessions: [],
      expectedText: ["Studio Mac is not reachable", "Reconnect"],
    }
  if (name === "signed-out") return {
      ...common,
      view: "settings",
      account: "signedout",
      devices: [],
      sessions: [],
      expectedText: ["Sign in to your workspace", "Continue with Google"],
    }
  if (name === "devices-enrollment") return {
    ...common,
    view: "settings",
    accountID: "account_fixture",
    devices: [studio(), workstation, legacy],
    openControl: "enrollment",
    expectedText: ["Account", "Studio Mac", "Workstation-Box", "Legacy-MacBook", "Enrollment ID", "Enrollment code (shown once)"],
  }
  return {
    ...common,
    view: "settings",
    autonomy: {
      mode: "goal",
      yolo: viewport === 768 ? 1 : 2,
      goal: {
        text: viewport === 1440 ? "Refactor remote settings pane for responsive review board" : viewport === 768 ? "Refactor telemetry UI" : "Mobile refactor",
        status: "active",
        iteration: 1,
        noProgress: 0,
        maxNoProgress: 5,
      },
    },
    expectedText: [
      "Appearance",
      "Autonomy",
      viewport === 768 ? "YOLO 1" : "YOLO 2",
      viewport === 1440 ? "Refactor remote settings pane for responsive review board" : viewport === 768 ? "Refactor telemetry UI" : "Mobile refactor",
      "Notifications",
      "Agent completed",
      "Approval requested",
      "Guardrail block",
      "Error or failure",
      "Device disconnected",
    ],
  }
}

const scenarioNames: readonly RemoteScenarioName[] = ["conversation-workspace", "session-list", "conversation-tool-terminal-output", "activity-pending-decisions", "permission-guardrail-hard-review-form-requests", "devices-enrollment", "autonomy-goal-notification-settings"]
const viewports: readonly RemoteScenarioViewport[] = [1440, 768, 390]

export const REMOTE_SCENARIOS = [
  ...scenarioNames.flatMap((name) => viewports.map((viewport) => scenario(name, viewport))),
  scenario("empty-backend", 1440),
  scenario("selected-machine-offline", 768),
  scenario("signed-out", 390),
]

export function remoteScenario(params: URLSearchParams): RemoteScenario | undefined {
  const id = params.get("scenario")
  return REMOTE_SCENARIOS.find((candidate) => candidate.id === id)
}
