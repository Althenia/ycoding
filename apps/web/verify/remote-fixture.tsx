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
import { RemoteProvider } from "../src/remote/context"
import { RemoteShell } from "../src/remote/ui/shell"
import { createRemoteStore, type RemoteStore } from "../src/remote/store"
import type { RemoteHttp, RemoteHttpResult } from "../src/remote/http"
import type {
  RemoteRequestOutcome,
  RemoteTransport,
  RemoteTransportHandlers,
  RemoteTransportStatus,
} from "../src/remote/transport"
import type { RemoteDeviceInfo, RemoteOperation } from "@ycoding-ai/remote"
import { stitchRemoteScenario } from "./stitch-remote-data"
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
const stitchScenario = stitchRemoteScenario(accountParams)
/** `?account=pending|signedout|unavailable` plus `?accountDelay=<ms>` for a slow answer. */
const accountMode = stitchScenario?.account ?? accountParams.get("account") ?? "ok"
const accountDelayMs = Number(accountParams.get("accountDelay") ?? 0)
/** `?connection=offline` selects a signed-in device whose open relay has no local agent. */
const connectionMode = stitchScenario?.connection ?? accountParams.get("connection") ?? "open"
/** `?form=all` adds every native field kind for browser verification. */
const formMode = accountParams.get("form") ?? "question"
/** Delays native Form settlement so the browser can observe disabled duplicate controls. */
const formDelayMs = Number(accountParams.get("formDelay") ?? 0)
/** `?formOutcome=unknown` leaves the native Form mutation unresolved without replay. */
const formOutcome = accountParams.get("formOutcome")
const promptOutcome = accountParams.get("promptOutcome")
const deviceMode = accountParams.get("devices")
const emptyBackend = stitchScenario?.emptyBackend ?? accountParams.get("sessions") === "empty"
if (stitchScenario !== undefined) localStorage.setItem("ycoding.theme", stitchScenario.theme)
if (stitchScenario !== undefined) devices = stitchScenario.devices
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
    return ok({ user: { id: stitchScenario?.accountID ?? "user_fixture" }, session: { expiresAt: Date.now() + 86_400_000 }, devices })
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
  { id: sessionID, title: "Stream remote output safely", projectID: "prj_stitch", location: { directory: "/workspace/ycoding" }, agent: "god", model, time: { created: ago(42), updated: ago(1) }, running: true },
  { id: "ses_archived", title: "Archived: release notes", time: { created: ago(300), updated: ago(280), archived: ago(280) } },
  { id: "ses_child", title: "Child: fix flaky suite", parentID: sessionID, time: { created: ago(30), updated: ago(4) } },
]
const sessions = stitchScenario?.sessions ?? defaultSessions

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
const messages = stitchScenario?.messages ?? defaultMessages

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
const permissions = stitchScenario?.permissions ?? [permission]
const guardrails = stitchScenario?.guardrails ?? [guardrail]
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

type Fixture = {
  readonly store: RemoteStore
  readonly drop: () => void
  readonly stream: () => void
  readonly formRequests: () => readonly { readonly operation: string; readonly input: Readonly<Record<string, unknown>> | undefined }[]
  readonly mutationRequests: () => readonly { readonly operation: string; readonly input: Readonly<Record<string, unknown>> | undefined }[]
}

function createFixtureStore(): Fixture {
  let handlers: RemoteTransportHandlers | undefined
  let open = true
  let streamed = false
  let liveReads = 0
  const formRequests: { operation: string; input: Readonly<Record<string, unknown>> | undefined }[] = []
  const mutationRequests: { operation: string; input: Readonly<Record<string, unknown>> | undefined }[] = []
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
  ): RemoteRequestOutcome | Promise<RemoteRequestOutcome> => {
    if (operation === "session.prompt" || operation === "session.autonomy.set") {
      mutationRequests.push({ operation, input })
    }
    if (connectionMode === "offline" && (operation === "session.list" || operation === "session.active")) {
      return { status: "failed", error: { code: "agent_unavailable", message: "No local agent is connected" } }
    }
    if (operation === "session.list") return { status: "ok", value: { data: emptyBackend ? [] : sessions } }
    if (operation === "session.active") return { status: "ok", value: { data: { [sessionID]: { type: "running" } } } }
    if (operation === "session.snapshot") {
      return {
        status: "ok",
        value: {
          sourceEpoch: "epoch_fixture",
          session: sessions[0],
          messages,
          watermark: { type: "log.synced", aggregateID: sessionID, seq: 42 },
        },
      }
    }
    if (operation === "session.autonomy.get") {
      return {
        status: "ok",
        value: {
          data: stitchScenario?.autonomy ?? {
            mode: "normal",
            yolo: 2,
            goal: { text: "Ship the remote workspace", status: "active", iteration: 3, noProgress: 0, maxNoProgress: 5 },
          },
        },
      }
    }
    if (operation === "session.permission.list") return { status: "ok", value: { data: unreplied(permissions) } }
    if (operation === "session.guardrail.request.list") return { status: "ok", value: { data: unreplied(guardrails) } }
    if (operation === "session.form.list") return {
      status: "ok",
      value: stitchScenario === undefined
        ? formMode === "constraints" ? unreplied([constraintsForm]) : unreplied(formMode === "all" ? [form, allForm] : [form])
        : unreplied(stitchScenario.forms),
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
      return outcome(operation, request?.input)
    },
  }

  const store = createRemoteStore({
    http: syntheticHttp,
    createTransport: (_deviceID, transportHandlers) => {
      handlers = transportHandlers
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
      { type: "session.step.started", durable: { aggregateID: sessionID, seq: 43, version: 1 }, data: { assistantMessageID: "msg_live", agent: "god", model } },
      { type: "session.text.started", durable: { aggregateID: sessionID, seq: 44, version: 1 }, data: { assistantMessageID: "msg_live", ordinal: 0 } },
      { type: "session.text.delta", data: { assistantMessageID: "msg_live", ordinal: 0, delta: "Streaming " } },
      { type: "session.text.delta", data: { assistantMessageID: "msg_live", ordinal: 0, delta: "through " } },
      { type: "session.text.delta", data: { assistantMessageID: "msg_live", ordinal: 0, delta: "the relay." } },
      {
        type: "session.tool.success",
        durable: { aggregateID: sessionID, seq: 45, version: 1 },
        data: { assistantMessageID: "msg_live", callID: "call_live", content: [{ type: "text", text: "bound output kept locally scrollable" }] },
      },
      {
        type: "session.text.ended",
        durable: { aggregateID: sessionID, seq: 46, version: 1 },
        data: { assistantMessageID: "msg_live", ordinal: 0, text: "Streaming through the relay with bounded tool output." },
      },
    ]
    for (const [index, event] of steps.entries()) {
      setTimeout(() => handlers?.onEvent?.(sessionID, event), index * 60)
    }
  }

  return { store, drop, stream, formRequests: () => formRequests, mutationRequests: () => mutationRequests }
}

const fixture = createFixtureStore()

/** Picks the device and session a user would pick, so the fixture opens on a live workspace. */
async function openFixtureWorkspace(store: RemoteStore) {
  await store.load()
  store.connect("dev_studio")
  for (let attempt = 0; attempt < 40 && store.state().sessions.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await store.selectSession(sessionID)
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
  return [...document.querySelectorAll(".shell__output")].map((element) => {
    const container = element.closest(".shell, .tool")
    return {
      container: container?.classList.contains("shell") === true ? "shell" : "tool",
      command:
        container?.querySelector(".shell__header code")?.textContent ??
        container?.querySelector(".tool__name")?.textContent ??
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

const fixtureView = stitchScenario?.view ?? new URLSearchParams(window.location.search).get("view") ?? "chat"
const fixturePath = fixtureView === "chat" ? "/remote" : `/remote/${fixtureView}`

function FixturePage() {
  onMount(() => {
    if (stitchScenario?.openControl === undefined) return
    let attempts = 0
    const open = () => {
      attempts += 1
      if (stitchScenario.openControl === "device") {
        const button = document.querySelector<HTMLButtonElement>('[aria-label="Device"]')
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
        Synthetic fixture build — transport and account calls are local stubs. Not a real session, account, or relay.
      </p>
      <div class="fixture__controls">
        <button type="button" class="button button--secondary button--small" onClick={() => fixture.stream()}>
          Simulate streaming step
        </button>
        <button type="button" class="button button--secondary button--small" onClick={() => fixture.drop()}>
          Simulate disconnect and reconnect
        </button>
      </div>
      <RemoteShell path={fixturePath} />
    </div>
  )
}

const root = document.getElementById("app")
if (!root) throw new Error("Missing fixture root")
render(
  () => (
    <RouterProvider>
      <ThemeProvider>
        <RemoteProvider createStore={() => fixture.store}>
          <FixturePage />
        </RemoteProvider>
      </ThemeProvider>
    </RouterProvider>
  ),
  root,
)
