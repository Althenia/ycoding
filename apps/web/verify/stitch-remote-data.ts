import type { RemoteDeviceInfo } from "@ycoding-ai/remote"

export type StitchFamily = "r01" | "r02" | "r03" | "r04" | "r05" | "r06" | "r07" | "r08"
export type StitchSpecimen = 1440 | 768 | 390
export type StitchView = "chat" | "sessions" | "activity" | "settings"

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

export type StitchRemoteScenario = {
  readonly id: `${StitchFamily}-${StitchSpecimen}`
  readonly family: StitchFamily
  readonly specimen: StitchSpecimen
  readonly view: StitchView
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
  readonly exclusions: readonly string[]
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

const r01Sessions = [
  baseSession(),
  baseSession({ id: "ses_indexer", title: "Query batch indexer", projectID: "project-indexer", location: { directory: "/workspace/ycoding-engine/indexer" }, running: true, time: time(120) }),
  baseSession({ id: "ses_mesh", title: "Mesh peer sync daemon", projectID: "project-mesh", location: { directory: "/workspace/ycoding-engine/mesh" }, time: time(600) }),
]

const r02Sessions = [
  baseSession({ title: "Async Auth Token Revocation Migration", location: { directory: "/workspace/auth-gate" }, running: true, time: time(24) }),
  baseSession({ id: "ses_telemetry", title: "Telemetry Event Buffer Flush Daemon", location: { directory: "/workspace/telemetry-daemon" }, running: true, time: time(120) }),
  baseSession({ id: "ses_redis", title: "Redis Cache Cluster Rebalancing Spec", location: { directory: "/workspace/cache-redis" }, time: time(1_080) }),
  baseSession({ id: "ses_postgres", title: "Postgres Partition Pruning Worker", location: { directory: "/workspace/db-pruner" }, time: time(3_600) }),
]

function r01Messages(specimen: StitchSpecimen): readonly WireMessage[] {
  if (specimen === 1440) return [
    assistant("msg_assistant", [text("I've examined the token expiry check in auth_guard.go. Would you like me to update the lock retention duration and dispatch tests on Studio Mac?")], 19),
    user("msg_user", "Proceed with non-blocking lock retention and verify auth expiration tests.", 18),
  ]
  if (specimen === 768) return [
    assistant("msg_assistant", [text("Connected to Studio Mac. Updated lock retention parameters are ready for execution.")], 19),
    user("msg_user", "Run test suite against auth services.", 18),
  ]
  return [
    assistant("msg_assistant", [text("Session bound to Studio Mac in auth. Ready for prompt execution.")], 19),
    user("msg_user", "Verify non-blocking lock on expiration.", 18),
  ]
}

function r03Messages(specimen: StitchSpecimen): readonly WireMessage[] {
  if (specimen === 1440) return [
    user("msg_user", "Please check the session bus synchronization logic during agent cancellation and review the diff patch.", 18),
    assistant("msg_assistant", [
      tool("call_ast", "Tool Output AST Symbol Analysis", { path: "session_bus.rs" }, "// Evaluated session bus dispatch\npub async fn cancel_session(&self, id: SessionId) -> Result<(), DaemonError> {\n  let mut session = self.active_sessions.lock().await;\n}", 17),
      tool("call_tests", "Test Suite Execution Output", { command: "cargo test session_cancellation" }, "Running concurrency verification tests\ntest session_cancellation_flow ... ok\ntest mutex_guard_scope ... ok", 16),
      tool("call_diff", "Diff Preview: session_bus.rs", { path: "session_bus.rs" }, "184 - let mut session = self.active_sessions.lock().await;\n184 + { let mut session = self.active_sessions.lock().await; session.mark_cancelled(id); }", 15),
    ], 17),
  ]
  if (specimen === 768) return [
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

function r04Messages(specimen: StitchSpecimen): readonly WireMessage[] {
  const first = assistant("msg_phase", [tool("call_phase", "Agent Phase Transition", {}, "Syntax graph validation started for rewrite", 35)], 35)
  const second = assistant("msg_file", [tool("call_file", "File Updated", { path: "src/core/compiler/ast_transformer.rs" }, "Modified src/core/compiler/ast_transformer.rs", 34)], 34)
  if (specimen !== 1440) return [first, second]
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

function r05Forms(specimen: StitchSpecimen): readonly WireForm[] {
  if (specimen === 768) return [form("frm_endpoints", "Multi-Choice Question Prompt", [{
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
  if (specimen === 390) return [form("frm_cluster", "Select Target Cluster", [{
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

const baseExclusions = [
  "Source-only timestamps remain native browser dates rather than invented relative labels.",
  "Source icon glyph names and specimen labels are not application wire data.",
]

function scenario(family: StitchFamily, specimen: StitchSpecimen): StitchRemoteScenario {
  const common = {
    id: `${family}-${specimen}` as const,
    family,
    specimen,
    theme: specimen === 768 ? "light" as const : "dark" as const,
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
    exclusions: baseExclusions,
  }

  if (family === "r01") return {
    ...common,
    view: "chat",
    devices: [studio(), devLinux],
    sessions: r01Sessions,
    messages: r01Messages(specimen),
    ...(specimen === 1440 || specimen === 390 ? { openControl: "device" as const } : {}),
    expectedText: specimen === 390
      ? ["Session bound to Studio Mac in auth.", "Verify non-blocking lock on expiration.", "Select Active Device", "Studio Mac", "Dev Linux"]
      : ["Token expiry refactor", "Query batch indexer", "Mesh peer sync daemon", "auth", specimen === 768 ? "Run test suite against auth services." : "auth_guard.go"],
    exclusions: [
      ...baseExclusions,
      "The native project label presents the directory basename; the full source directory remains available as its tooltip.",
    ],
  }
  if (family === "r02") return {
    ...common,
    view: "sessions",
    sessions: r02Sessions,
    expectedText: ["Async Auth Token Revocation Migration", "auth-gate", "Telemetry Event Buffer Flush Daemon", "telemetry-daemon", "Redis Cache Cluster Rebalancing Spec", "cache-redis", "Postgres Partition Pruning Worker", "db-pruner"],
  }
  if (family === "r03") return {
    ...common,
    view: "chat",
    messages: r03Messages(specimen),
    expectedText: specimen === 1440
      ? ["session bus synchronization", "Test Suite Execution Output", "Diff Preview: session_bus.rs"]
      : specimen === 768
        ? ["Add defensive timeout handling", "write_file_patch", "5000ms handshake deadline"]
        : ["Run sanity checks on worker threads.", "Checked worker threads.", "pool_spin_ok"],
    exclusions: [...baseExclusions, "The source's Senior Engineer role label maps to the native user-message label."],
  }
  if (family === "r04") return {
    ...common,
    view: "activity",
    messages: r04Messages(specimen),
    permissions: [permission("per_lock", "Overwrite Cargo.lock revision?")],
    guardrails: [guardrail("grq_push", "Authorize branch push for feat/ast-cache", "Remote push requires a decision", false)],
    expectedText: ["Reported events", "Pending decisions", "Overwrite Cargo.lock revision?", "Authorize branch push for feat/ast-cache", "Agent Phase Transition", "File Updated", ...(specimen === 1440 ? ["Command Executed"] : [])],
    exclusions: [
      ...baseExclusions,
      "Source View in Session links map to native actionable decision cards.",
      "WRITE PERMISSION and REMOTE PUSH source badges are visual classifications without native request fields.",
    ],
  }
  if (family === "r05") return {
    ...common,
    view: "chat",
    permissions: specimen === 768 ? [] : [permission("per_socket", specimen === 390 ? "Network Socket Access" : "Write File Request", specimen === 390 ? ["bind 0.0.0.0:8080 (TCP / LISTEN)"] : ["/etc/systemd/system/ycoding-worker.service"])],
    guardrails: specimen === 1440
      ? [
          guardrail("grq_context", "High Context Consumption", "Refactoring involves 48 modules in src/compiler/*.", false),
          guardrail("grq_hard", "Destructive Database Alteration & Git Force Push", "A human decision is required, even at YOLO 3.", true),
        ]
      : [guardrail("grq_hard", specimen === 768 ? "git reset --hard HEAD~12 && git push -f" : "rm -rf /var/log/audit/*", "A human decision is required, even at YOLO 3.", true)],
    forms: r05Forms(specimen),
    expectedText: specimen === 390
      ? ["Network Socket Access", "Guardrail review (human decision required)", "Select Target Cluster"]
      : specimen === 768
        ? ["human decision is required", "git reset --hard HEAD~12 && git push -f", "Multi-Choice Question Prompt", "syslog daemon bridge", "opentelemetry otlp-grpc", "prometheus metrics scrape"]
        : ["Write File Request", "/etc/systemd/system/ycoding-worker.service", "High Context Consumption", "Destructive Database Alteration & Git Force Push", "Select Target Runtime Architecture", "Enable Optional Test Harnesses", "Clarify Disambiguation Query"],
    exclusions: [...baseExclusions, "Source badge codes and estimated token price are not fields in native permission or guardrail requests."],
  }
  if (family === "r06") {
    if (specimen === 1440) return {
      ...common,
      view: "chat",
      emptyBackend: true,
      sessions: [],
      expectedText: ["No sessions", "Start YCoding in your project folder on this machine."],
    }
    if (specimen === 768) return {
      ...common,
      view: "chat",
      connection: "offline",
      devices: [studio(false)],
      sessions: [],
      expectedText: ["Studio Mac is not reachable", "Reconnect"],
      exclusions: [...baseExclusions, "The native disconnected-state copy uses the product's consistent not-reachable wording."],
    }
    return {
      ...common,
      view: "settings",
      account: "signedout",
      devices: [],
      sessions: [],
      expectedText: ["Signed out", "Sign in with Google"],
      exclusions: [
        ...baseExclusions,
        "The source Sign in to YCoding heading maps to the native signed-out account state.",
        "The native sign-in action lives in the combined Settings route rather than a source-only standalone card.",
      ],
    }
  }
  if (family === "r07") return {
    ...common,
    view: "settings",
    accountID: "account_fixture",
    devices: [studio(), workstation, legacy],
    openControl: "enrollment",
    expectedText: ["Account", "Studio Mac", "Workstation-Box", "Legacy-MacBook", "Enrollment ID", "Enrollment code (shown once)"],
    exclusions: [
      ...baseExclusions,
      "The account contract exposes an identifier, not the source's display-name placeholder or account type.",
      "Source enrollment placeholders are replaced by schema-valid synthetic enrollment identifiers, code, and expiry.",
    ],
  }
  return {
    ...common,
    view: "settings",
    autonomy: {
      mode: "goal",
      yolo: specimen === 768 ? 1 : 2,
      goal: {
        text: specimen === 1440 ? "Refactor remote settings pane for responsive review board" : specimen === 768 ? "Refactor telemetry UI" : "Mobile refactor",
        status: "active",
        iteration: 1,
        noProgress: 0,
        maxNoProgress: 5,
      },
    },
    expectedText: [
      "Appearance",
      "Autonomy",
      specimen === 768 ? "YOLO 1" : "YOLO 2",
      specimen === 1440 ? "Refactor remote settings pane for responsive review board" : specimen === 768 ? "Refactor telemetry UI" : "Mobile refactor",
      "Notifications",
      "Agent completed",
      "Approval requested",
      "Guardrail block",
      "Error or failure",
      "Device disconnected",
    ],
    exclusions: [
      ...baseExclusions,
      "Saved, Tablet Mode, Agent Policy, and specimen-state labels are reference annotations, not runtime fields.",
      "The native Settings route retains Account and Devices above the source's appearance/autonomy/notifications specimen.",
    ],
  }
}

const families: readonly StitchFamily[] = ["r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08"]
const specimens: readonly StitchSpecimen[] = [1440, 768, 390]

export const STITCH_REMOTE_SCENARIOS = families.flatMap((family) => specimens.map((specimen) => scenario(family, specimen)))

export function stitchRemoteScenario(params: URLSearchParams): StitchRemoteScenario | undefined {
  const family = params.get("stitch")
  const specimen = Number(params.get("specimen"))
  return STITCH_REMOTE_SCENARIOS.find((candidate) => candidate.family === family && candidate.specimen === specimen)
}
