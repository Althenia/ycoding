import { createEffect, createRoot, createSignal } from "solid-js"
import { Store } from "@tanstack/solid-store"
import { create, encodeStrict, ConnectorNoticePageSchema, ResultSchema, TypedPayloadSchema } from "@ycoding-ai/remote"
import { render } from "solid-js/web"
import { TranscriptNavigation } from "../src/remote/ui/transcript-nav"
import { TodoPanel } from "../src/remote/ui/todo-panel"
import { RemoteProvider } from "../src/remote/context"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteTransport } from "../src/remote/transport"
import { BinarySocket, fixtureSnapshot, fixtureSession } from "../test/wire-peer"
import {
  applySessionEvent,
  createSessionView,
  readMessageList,
  readSnapshot,
  type RemoteMessageView,
  type SessionView,
} from "../src/remote/projection"
import { accountedTask } from "../test/usage-fixture"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"
import "../src/remote/ui/transcript-fixture.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"

const initial: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_user", text: "A long prompt ".repeat(14), state: "pending", delivery: "queue", created: 1 },
  {
    kind: "assistant",
    id: "msg_agent",
    agent: "god",
    parts: [
      {
        kind: "reasoning",
        ordinal: 0,
        text: "**Important** idea <img src=x onerror=alert(1)>",
        started: 100,
        completed: 2_100,
      },
      { kind: "reasoning", ordinal: 1, text: "More `code` and *emphasis*", started: 2_200, completed: 2_400 },
      { kind: "reasoning", ordinal: 2, text: "   " },
      {
        kind: "tool",
        callID: "call_1",
        name: "shell",
        status: "completed",
        input: { command: "bun test ./src" },
        content: [{ kind: "text", text: "23 pass · 0 fail" }],
        started: 2_200,
        ran: 2_300,
        completed: 2_437,
      },
      {
        kind: "tool",
        callID: "call_2",
        name: "read",
        status: "failed",
        input: { path: "src/long-file.ts" },
        content: [],
        error: "A very long JSON error ".repeat(3),
        started: 2_500,
        completed: 2_600,
      },
      {
        kind: "text",
        ordinal: 0,
        text: "# Final answer\n\n**Important** changes and ~~old plan~~:\n- First item with `inline code`\n- Nested:\n  - Sub item\n1. Ordered item\n2. Another item\n- [x] Verified task\n\n> A quoted detail\n\n---\n\n| Item | Result |\n| --- | --- |\n| Build | pass |\n\n```ts\nconst answer = 42\n```\n\n[Safe](https://example.com) [Unsafe](javascript:alert(1)) ![No image](https://example.com/image.png) <script>alert(1)</script>",
      },
    ],
    model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
    created: 2,
    completed: 5_000,
  },
  {
    kind: "synthetic",
    id: "msg_state",
    text: 'Authoritative current Session state (JSON):\n{"autonomy":{"mode":"goal","yolo":2},"todos":[{}]}',
    source: "session-state",
    created: 5_100,
  },
]
const synthetic = new URLSearchParams(location.search).get("synthetic")
const toolOutput = new URLSearchParams(location.search).has("tool-output")
const navigation = new URLSearchParams(location.search).has("navigation")
const runningStep = new URLSearchParams(location.search).has("running")
const notification = new URLSearchParams(location.search).has("notification")
const visibility = new URLSearchParams(location.search).has("visibility")
const historyMode = new URLSearchParams(location.search).has("history")
const imagesMode = new URLSearchParams(location.search).has("images")
const longMode = new URLSearchParams(location.search).has("long")
const bulkMode = new URLSearchParams(location.search).has("bulk")
const bulkText = "日本語 🌍 complete binary transcript\n".repeat(4_000)
Object.assign(window, { bulkText })
const compactionMode = new URLSearchParams(location.search).get("compaction")
const fileChangesMode = new URLSearchParams(location.search).get("file-changes")
const costsMode = new URLSearchParams(location.search).has("costs")
const costUnit = (inputID: string, partial: boolean) => {
  const task = accountedTask("ses_a", 0.25, 20)
  const cost = partial
    ? { known: 0.25, pricedRequests: 1, unpricedRequests: 1, provenance: "recorded" as const }
    : task.total.cost
  return {
    anchor: { sessionID: "ses_a", inputID },
    status: partial ? ("so-far" as const) : ("settled" as const),
    attribution: partial ? ("partial" as const) : ("complete" as const),
    history: "retained" as const,
    total: { ...task.total, cost },
    main: task.main,
    children: partial ? { ...task.total, cost: { pricedRequests: 0, unpricedRequests: 1 } } : task.children,
    helpers: partial
      ? [{ ...task.total, source: "decision" as const, cost: { pricedRequests: 0, unpricedRequests: 1 } }]
      : [],
  }
}
const costMessages: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_cost_known", text: "Known cost", state: "consumed", created: 1 },
  { kind: "user", id: "msg_cost_partial", text: "Partial cost", state: "consumed", created: 2 },
  { kind: "user", id: "msg_cost_unreported", text: "Unreported cost", state: "promoted", created: 3 },
  { kind: "user", id: "msg_cost_pending", text: "Queued prompt", state: "pending", delivery: "queue", created: 4 },
]
const [fileChangeStatus, setFileChangeStatus] = createSignal<SessionView["status"]>(
  new URLSearchParams(location.search).get("status") === "running" ? "running" : "idle",
)
const fileChanges = [
  {
    path: "apps/web/src/remote/ui/conversation.tsx",
    patch:
      fileChangesMode === "unavailable"
        ? "Binary files a/a.png and b/a.png differ"
        : "@@ -1,2 +1,3 @@\n-old value\n+new value\n+extra line\n tail",
    additions: 30,
    deletions: 5,
  },
  {
    path: "apps/web/src/remote/ui/long.ts",
    patch: `@@ -0,0 +1 @@\n+${"long line ".repeat(100)}`,
    additions: 1,
    deletions: 0,
  },
  {
    path: "packages/core/src/session.ts",
    patch: "@@ -1 +1 @@\n-return false\n+return true",
    additions: 1,
    deletions: 1,
  },
  { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after", additions: 1, deletions: 1 },
]
const capturedFiles = fileChanges.map((file, index) => {
  const unavailable = fileChangesMode === "unavailable" && index === 0
  const additions = unavailable ? 0 : index === 0 ? 2 : 1
  const deletions = unavailable ? 0 : index === 1 ? 0 : 1
  return {
    placementMessageID: "msg_latest",
    path: file.path,
    additions,
    deletions,
    status: "modified" as const,
    files: [
      {
        path: file.path,
        diff: unavailable ? "" : file.patch,
        additions,
        deletions,
        status: "modified" as const,
        ...(unavailable ? { unavailable: true } : {}),
      },
    ],
  }
})
const capturedChanges =
  fileChangesMode === "no-edits"
    ? []
    : fileChangesMode === "segments"
      ? [{ ...capturedFiles[2]!, placementMessageID: "msg_first_reply" }, ...capturedFiles.slice(0, 2)]
      : fileChangesMode === "child-only"
        ? capturedFiles.slice(0, 1)
        : fileChangesMode === "repeated"
          ? [
              {
                ...capturedFiles[0]!,
                additions: 3,
                deletions: 2,
                files: [
                  ...capturedFiles[0]!.files,
                  {
                    path: capturedFiles[0]!.path,
                    diff: "@@ -2 +2 @@\n-before second\n+after second",
                    additions: 1,
                    deletions: 1,
                    status: "modified" as const,
                  },
                ],
              },
            ]
          : capturedFiles
const fileChangeMessages: readonly RemoteMessageView[] =
  fileChangesMode === "segments"
    ? [
        { kind: "user", id: "msg_first_request", state: "consumed", text: "Make the first edit", created: 1 },
        {
          kind: "assistant",
          id: "msg_first_reply",
          parts: [{ kind: "text", ordinal: 0, text: "The first edit is done." }],
          created: 2,
          completed: 3,
        },
        { kind: "user", id: "msg_file_request", state: "consumed", text: "Make the second edit", created: 4 },
        {
          kind: "assistant",
          id: "msg_latest",
          parts: [{ kind: "text", ordinal: 0, text: "The second edit is done." }],
          created: 5,
          completed: 6,
        },
      ]
    : [
        { kind: "user", id: "msg_file_request", state: "consumed", text: "Edit the files", created: 1 },
        {
          kind: "assistant",
          id: "msg_tool_steps",
          parts: [
            {
              kind: "tool",
              callID: "call_edit",
              name: "edit",
              status: "completed",
              input: { path: "src/a.ts" },
              content: [],
              started: 2,
              completed: 3,
            },
            {
              kind: "tool",
              callID: "call_patch",
              name: "patch",
              status: "completed",
              input: { path: "src/b.ts" },
              content: [],
              started: 4,
              completed: 5,
            },
          ],
          created: 2,
          completed: 5,
        },
        {
          kind: "assistant",
          id: "msg_earlier",
          parts: [{ kind: "text", ordinal: 0, text: "Starting the edits." }],
          created: 2,
          completed: 3,
        },
        {
          kind: "assistant",
          id: "msg_latest",
          parts: [{ kind: "text", ordinal: 0, text: "The files are updated." }],
          created: 4,
          completed: 5,
        },
      ]
const raw =
  "first line\n" +
  "x".repeat(20_000) +
  "\n... output truncated; full content saved to /private/fixture/tool-output.txt ..."
const outputMessages: readonly RemoteMessageView[] = [
  {
    kind: "assistant",
    id: "msg_tool",
    created: 1,
    parts: [
      {
        kind: "tool",
        callID: "call_store",
        name: "read",
        status: "completed",
        content: [
          {
            kind: "text",
            text: raw.replace(
              /\.\.\. output truncated; full content saved to [^\r\n]*/g,
              "[full output retained on the device]",
            ),
            sourceTruncated: true,
          },
        ],
        structured: { truncated: true },
      },
      {
        kind: "tool",
        callID: "call_shell",
        name: "shell",
        status: "completed",
        content: [{ kind: "text", text: "shell result\n[full output retained on the device]", sourceTruncated: true }],
      },
    ],
  },
]
const navigationMessages: readonly RemoteMessageView[] = Array.from(
  { length: 12 },
  (_, index): readonly RemoteMessageView[] => [
    {
      kind: "user",
      id: `prompt_${index}`,
      text: `Prompt ${index + 1}: ${"inspect the current work ".repeat(4)}`,
      state: "consumed",
      created: index * 2,
    },
    {
      kind: "assistant",
      id: `answer_${index}`,
      agent: "god",
      parts: [
        { kind: "text", ordinal: 0, text: `Response ${index + 1}\n\n${"A detailed paragraph of work. ".repeat(12)}` },
      ],
      created: index * 2 + 1,
      ...(index === 11 ? {} : { completed: index * 2 + 2 }),
    },
  ],
).flat()
const runningMessages: readonly RemoteMessageView[] = [
  {
    kind: "assistant",
    id: "running_step",
    agent: "god",
    created: 1,
    parts: [
      {
        kind: "tool",
        callID: "running_tool",
        name: "shell",
        status: "running",
        input: { command: "bun test" },
        content: [],
        started: 2,
      },
    ],
  },
]
const notificationMetadata = {
  source: "subagent_notification",
  childID: "ses_child",
  type: "completed",
  revision: 3,
  excerpt: "Tests pass and the repair is verified.",
}
const notificationMessages: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_ordinary", text: "Check the repair", state: "consumed", created: 1 },
  {
    kind: "synthetic",
    id: "msg_notification",
    text: `Subagent notification:\n${JSON.stringify(notificationMetadata)}`,
    description: "Subagent notification",
    metadata: notificationMetadata,
    created: 2,
  },
]
const visibilityMessages: readonly RemoteMessageView[] = [
  notificationMessages[0]!,
  {
    kind: "system",
    id: "msg_internal_state",
    text: 'Authoritative current Session state (JSON):\n{"autonomy":{"mode":"normal","yolo":0},"todos":[]}',
    source: "session-state",
    created: 2,
  },
  {
    kind: "synthetic",
    id: "msg_internal_team",
    text: 'Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n{"children":[{"state":"running"}]}',
    description: "TeamView update",
    source: "team-view",
    created: 3,
  },
  { kind: "synthetic", id: "msg_empty_synthetic", text: "Internal", description: " ", created: 4 },
  notificationMessages[1]!,
]
const plot = document.createElement("canvas")
plot.width = 320
plot.height = 180
const plotContext = plot.getContext("2d")
if (!plotContext) throw new Error("Image fixture requires a canvas")
plotContext.fillStyle = "#122b25"
plotContext.fillRect(0, 0, 320, 180)
plotContext.fillStyle = "#43c292"
plotContext.fillRect(30, 90, 50, 60)
plotContext.fillRect(105, 60, 50, 90)
plotContext.fillRect(180, 25, 50, 125)
const tall = document.createElement("canvas")
tall.width = 390
tall.height = 1800
const tallContext = tall.getContext("2d")
if (!tallContext) throw new Error("Image fixture requires a canvas")
tallContext.fillStyle = "#122b25"
tallContext.fillRect(0, 0, 390, 1800)
tallContext.fillStyle = "#43c292"
for (let row = 0; row < 12; row++) tallContext.fillRect(30, 60 + row * 150, 330, 60)
const imageMessages: readonly RemoteMessageView[] = [
  {
    kind: "user",
    id: "msg_image",
    text: "Review these files",
    state: "consumed",
    created: 1,
    attachments: [
      { name: "screen.png", mime: "image/png", bytes: 4_096, digest: "a".repeat(64) },
      { name: "report.pdf", mime: "application/pdf", bytes: 1_024, digest: "b".repeat(64) },
      { name: "broken.png", mime: "image/png", bytes: 2_048, digest: "c".repeat(64) },
    ],
  },
  {
    kind: "user",
    id: "msg_image_only",
    text: "",
    state: "consumed",
    created: 1,
    attachments: [{ name: "screen.png", mime: "image/png", bytes: 4_096, digest: "a".repeat(64) }],
  },
  {
    kind: "assistant",
    id: "msg_tool_image",
    created: 2,
    parts: [
      {
        kind: "tool",
        callID: "call_image",
        name: "read",
        status: "completed",
        content: [
          { kind: "image", uri: plot.toDataURL("image/png"), mime: "image/png", name: "plot.png" },
          { kind: "image", uri: tall.toDataURL("image/png"), mime: "image/png", name: "tall.png" },
        ],
      },
    ],
  },
]
const compressionMetrics = { excludedMessages: 11, excludedParts: 1, inputTokens: 1_000, retainedTokens: 400 }
const compactionMessages: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_before", text: "Before compression", state: "consumed", created: 1 },
  { kind: "compaction", id: "cmp_live", jobID: "cmp_live", status: "running", created: 3 },
  { kind: "user", id: "msg_after", text: "Neighbouring row remains in place", state: "consumed", created: 4 },
]
const longMessages = (prefix: string, count: number): readonly RemoteMessageView[] =>
  Array.from({ length: count }, (_, index): readonly RemoteMessageView[] => [
    {
      kind: "user",
      id: `${prefix}_user_${index}`,
      text: `Prompt ${index}: ${"inspect the current work ".repeat(1 + (index % 4))}`,
      state: "consumed",
      created: index * 2,
    },
    {
      kind: "assistant",
      id: `${prefix}_answer_${index}`,
      agent: "god",
      parts: [
        {
          kind: "text",
          ordinal: 0,
          text: `Response ${index}\n\n${Array.from({ length: 1 + (index % 5) }, () => "A detailed paragraph of work. ".repeat(6)).join("\n\n")}`,
        },
      ],
      created: index * 2 + 1,
      completed: index * 2 + 2,
    },
  ]).flat()
let imageFetches = 0
const imageBytes = imagesMode
  ? new Promise<Uint8Array>((resolve, reject) =>
      plot.toBlob(
        async (blob) =>
          blob ? resolve(new Uint8Array(await blob.arrayBuffer())) : reject(new Error("Fixture PNG encoding failed")),
        "image/png",
      ),
    )
  : undefined
let streamedImageText = ""
const imageSnapshot = () =>
  readSnapshot({
    sourceEpoch: "epoch_1",
    session: { id: "ses_a" },
    watermark: { type: "log.synced", aggregateID: "ses_a", seq: 12 },
    messages: [
      {
        id: "msg_image",
        type: "user",
        text: "Review these files",
        time: { created: 1, consumed: 2 },
        files: [
          { name: "screen.png", mime: "image/png", content: { type: "managed", bytes: 4_096, digest: "a".repeat(64) } },
          {
            name: "report.pdf",
            mime: "application/pdf",
            content: { type: "managed", bytes: 1_024, digest: "b".repeat(64) },
          },
          { name: "broken.png", mime: "image/png", content: { type: "managed", bytes: 2_048, digest: "c".repeat(64) } },
        ],
      },
      {
        id: "msg_image_only",
        type: "user",
        text: "",
        time: { created: 1, consumed: 2 },
        files: [
          { name: "screen.png", mime: "image/png", content: { type: "managed", bytes: 4_096, digest: "a".repeat(64) } },
        ],
      },
      {
        id: "msg_tool_image",
        type: "assistant",
        time: { created: 2 },
        content: [
          {
            type: "tool",
            id: "call_image",
            name: "read",
            state: {
              status: "completed",
              content: [
                { type: "file", uri: plot.toDataURL("image/png"), mime: "image/png", name: "plot.png" },
                { type: "file", uri: tall.toDataURL("image/png"), mime: "image/png", name: "tall.png" },
              ],
            },
          },
          ...(streamedImageText ? [{ type: "text", text: streamedImageText }] : []),
        ],
      },
    ],
  })?.messages ?? imageMessages
const [messages, setMessages] = createSignal(
  longMode
    ? longMessages("long", 150)
    : synthetic
      ? syntheticMessages(synthetic === "compacted")
      : fileChangesMode
        ? fileChangeMessages
        : costsMode
          ? costMessages
          : toolOutput
          ? outputMessages
          : historyMode
            ? navigationMessages.slice(12)
            : imagesMode
              ? imageMessages
              : bulkMode
                ? []
                : navigation
                  ? navigationMessages
                  : runningStep
                    ? runningMessages
                    : visibility
                      ? visibilityMessages
                      : notification
                        ? notificationMessages
                        : compactionMode
                          ? compactionMessages
                          : initial,
)
const [compactionHistory, setCompactionHistory] = createSignal(
  compactionMode && compactionMode !== "old"
    ? {
        data: [
          {
            jobID: "cmp_old",
            trigger: "auto",
            status: "completed" as const,
            metrics: { ...compressionMetrics, inputTokens: 500, retainedTokens: 200 },
            created: 2,
          },
          { jobID: "cmp_live", trigger: "manual", status: "running" as const, created: 3 },
        ],
        truncated: compactionMode === "truncated",
        completedBefore: compactionMode === "truncated" ? 2 : 0,
        completedCount: compactionMode === "truncated" ? 3 : 1,
        totalSavedTokens: compactionMode === "truncated" ? 900 : 300,
      }
    : undefined,
)
const [history, setHistory] = createSignal<{ readonly status: "idle" | "loading"; readonly before?: string }>(
  historyMode || longMode ? { status: "idle", before: "older" } : { status: "idle" },
)

function syntheticMessages(compacted: boolean): readonly RemoteMessageView[] {
  const raw = Array.from({ length: 1_200 }, (_, index) => ({
    id: `msg_${index}`,
    type: "assistant",
    agent: "god",
    content: [
      { type: "reasoning", text: "**Check context** with `code` and *verify the next step*." },
      { type: "text", text: `Answer ${index}` },
    ],
    time: { created: index },
  }))
  if (!compacted) return readMessageList({ data: raw })
  const messages = [
    ...raw.slice(0, 1_080),
    {
      id: "msg_compact",
      type: "compaction",
      jobID: "cmp_1",
      trigger: "manual",
      status: "completed",
      revision: 1,
      boundary: { messageID: "msg_1079", seq: 1_080 },
      metrics: { excludedMessages: 1_080, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
      time: { created: 1_080 },
    },
    ...raw.slice(1_080),
  ]
  return readSnapshot({ session: {}, messages })?.messages ?? []
}
const root = document.getElementById("app")
if (!root) throw new Error("Missing transcript root")
const connected = Promise.withResolvers<void>()
const store = createRemoteStore({
  http: createRemoteHttp({
    fetch: Object.assign(async () => new Response(null, { status: 401 }), { preconnect: () => {} }),
  }),
  createTransport: (_deviceID, handlers) => {
    const peer = new BinarySocket(
      () => performance.now(),
      (request, dispatch) => {
        if (request.operation === "notice.subscribe") {
          peer.body({
            case: "result",
            value: create(ResultSchema, {
              requestId: dispatch.requestID,
              operationId: dispatch.operation.operationId,
              settlement: dispatch.operation.settlement,
              outcome: {
                case: "success",
                value: create(TypedPayloadSchema, {
                  typeName: ConnectorNoticePageSchema.typeName,
                  payload: encodeStrict(
                    ConnectorNoticePageSchema,
                    create(ConnectorNoticePageSchema, {
                      notice: { kind: { case: "added", value: { notices: [], total: 0n } } },
                      unavailable: false,
                    }),
                  ),
                }),
              },
            }),
          })
          return
        }
        if (request.operation === "session.attachment.read") {
          if (request.input?.digest === "c".repeat(64)) {
            peer.error(dispatch, "ycoding.v5.AttachmentNotFoundError", {
              _tag: "AttachmentNotFoundError",
              message: "Fixture attachment is unavailable",
            })
            return
          }
          if (request.input?.digest === "a".repeat(64)) imageFetches++
          void imageBytes!.then((data) => peer.asset(dispatch, data, "image/png"))
          return
        }
        if (request.operation === "event.subscribe") {
          peer.result(dispatch, { subscription_id: `fixture-${request.sessionID}` })
          return
        }
        if (request.operation === "session.snapshot") {
          peer.result(
            dispatch,
            bulkMode
              ? {
                  data: {
                    ...fixtureSnapshot(request.sessionID!).data,
                    messages: [{ id: "msg_bulk", type: "user", text: bulkText, time: { created: 1, consumed: 2 } }],
                  },
                }
              : fixtureSnapshot(request.sessionID!),
          )
          return
        }
        if (request.operation === "session.get") {
          peer.result(dispatch, { data: fixtureSession(request.sessionID!) })
          return
        }
        if (request.operation === "session.list") {
          peer.result(dispatch, { data: { data: [], cursor: {} } })
          return
        }
        if (request.operation === "session.status") {
          peer.result(dispatch, { running: [], attention: [] })
          return
        }
        if (request.operation === "telemetry.consent.get") {
          peer.result(dispatch, { data: { noticeVersion: 1 } })
          return
        }
        if (request.operation === "session.autonomy.get") {
          peer.result(dispatch, { data: { mode: "normal", yolo: 0 } })
          return
        }
        if (request.operation === "session.compaction.list") {
          peer.result(dispatch, {
            data: { data: [], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 },
          })
          return
        }
        peer.result(dispatch, { data: [] })
      },
    )
    const wire = createRemoteTransport({
      url: "ws://fixture.invalid/ws/v5/client",
      createSocket: () => peer as unknown as WebSocket,
      handlers: {
        ...handlers,
        onStatus: (status) => {
          handlers.onStatus?.(status)
          if (status.kind === "open") connected.resolve()
        },
      },
    })
    Object.assign(window, {
      transcriptWireState: () => ({
        status: wire.status(),
        requests: peer.requests(),
        failures: peer.failures.map(String),
        closes: peer.closes,
      }),
    })
    return {
      ...wire,
      connect: () => {
        wire.connect()
        peer.open()
      },
    }
  },
})
Object.defineProperty(store, "load", { value: async () => {} })
if (imagesMode || bulkMode) {
  store.connect("dev_1")
  await connected.promise
  await store.selectSession("ses_a")
  if (bulkMode) setMessages(store.state().view?.messages ?? [])
}
const fixtureState = { ...store.state(), activeSessionID: "ses_a", activeDeviceID: "dev_1" }
const fixtureStateSnapshot = () => ({
  ...fixtureState,
  history: history(),
  view: costsMode
    ? {
        ...createSessionView("ses_a"),
        messages: messages(),
        promptCosts: [costUnit("msg_cost_known", false), costUnit("msg_cost_partial", true)],
        promptCostState: "ready" as const,
      }
    : fileChangesMode
    ? { ...createSessionView("ses_a"), status: fileChangeStatus(), messages: messages(), capturedChanges }
    : compactionMode
      ? { ...createSessionView("ses_a"), compactionHistory: compactionHistory() }
      : fileChangeStatus() === "running"
        ? { ...createSessionView("ses_a"), status: fileChangeStatus(), messages: messages() }
        : fixtureState.view,
})
Object.defineProperty(store, "container", { value: new Store(fixtureStateSnapshot()) })
createRoot(() => createEffect(() => store.container.setState(() => fixtureStateSnapshot())))
Object.defineProperty(store, "loadOlderMessages", {
  value: async () => {
    if (!history().before) return
    if (longMode) {
      setHistory({ status: "loading", before: "older" })
      await new Promise((resolve) => setTimeout(resolve, 150))
      setMessages((current) => [...longMessages("older", 50), ...current])
      setHistory({ status: "idle" })
      return
    }
    setMessages((current) => [...navigationMessages.slice(0, 12), ...current])
    setHistory({ status: "idle" })
  },
})
if (fileChangesMode)
  Object.assign(window, {
    setFileChangeStatus: (status: SessionView["status"]) => {
      setFileChangeStatus(status)
    },
  })
if (compactionMode)
  Object.assign(window, {
    compactionUpdate: () => {
      setMessages((current) =>
        current.map((message) =>
          message.kind === "compaction"
            ? { ...message, id: "msg_compact", status: "completed", trigger: "manual", metrics: compressionMetrics }
            : message,
        ),
      )
      if (compactionMode !== "old")
        setCompactionHistory({
          data: [
            {
              jobID: "cmp_old",
              trigger: "auto",
              status: "completed",
              metrics: { ...compressionMetrics, inputTokens: 500, retainedTokens: 200 },
              created: 2,
            },
            { jobID: "cmp_live", trigger: "manual", status: "completed", metrics: compressionMetrics, created: 3 },
          ],
          truncated: compactionMode === "truncated",
          completedBefore: compactionMode === "truncated" ? 2 : 0,
          completedCount: compactionMode === "truncated" ? 4 : 2,
          totalSavedTokens: compactionMode === "truncated" ? 1_500 : 900,
        })
    },
  })
if (compactionMode)
  Object.assign(window, {
    compactionFail: () => {
      setMessages((current) =>
        current.map((message) =>
          message.kind === "compaction" ? { ...message, status: "failed", failureCode: "cancelled" } : message,
        ),
      )
    },
  })
if (longMode)
  Object.assign(window, {
    longDelta: (text: string) =>
      setMessages((current) =>
        current.map((item, index) =>
          item.kind === "assistant" && index === current.length - 1
            ? {
                ...item,
                parts: item.parts.map((part) =>
                  part.kind === "text" ? { ...part, text: `${part.text}${text}` } : part,
                ),
              }
            : item,
        ),
      ),
  })
if (imagesMode)
  Object.assign(window, {
    imageFetchCount: () => imageFetches,
    imageUpdate: (
      kind: "stream" | "live" | "reconcile" | "prepend" | "reconnect" | "corrupt-tool" | "repair-tool" | "evict",
    ) => {
      if (kind === "evict")
        return (async () => {
          for (let index = 0; index < 33; index++)
            (
              await store.loadImageSource({
                deviceID: "dev_1",
                sessionID: "ses_a",
                digest: index.toString(16).padStart(64, "0"),
                mime: "image/png",
              })
            ).release()
          ;(
            await store.loadImageSource({
              deviceID: "dev_1",
              sessionID: "ses_a",
              digest: "a".repeat(64),
              mime: "image/png",
            })
          ).release()
        })()
      if (kind === "stream") {
        streamedImageText += "more "
        setMessages(
          (current) =>
            applySessionEvent(
              { ...createSessionView("ses_a"), messages: current },
              {
                type: "session.text.delta",
                data: { sessionID: "ses_a", assistantMessageID: "msg_tool_image", ordinal: 1, delta: "more " },
              },
              10,
            ).messages,
        )
      }
      if (kind === "live")
        setMessages(
          (current) =>
            applySessionEvent(
              { ...createSessionView("ses_a"), messages: current },
              { type: "session.input.consumed", data: { sessionID: "ses_a", inputIDs: ["msg_image"] } },
              11,
            ).messages,
        )
      if (kind === "reconcile" || kind === "reconnect") setMessages(imageSnapshot())
      if (kind === "prepend")
        setMessages((current) => [
          { kind: "user", id: "msg_older", text: "An older prompt", state: "consumed", created: 0 },
          ...current,
        ])
      if (kind === "corrupt-tool" || kind === "repair-tool")
        setMessages((current) =>
          current.map((message) =>
            message.kind === "assistant" && message.id === "msg_tool_image"
              ? {
                  ...message,
                  parts: message.parts.map((part) =>
                    part.kind === "tool"
                      ? {
                          ...part,
                          content: part.content.map((block) =>
                            block.kind === "image"
                              ? {
                                  ...block,
                                  uri:
                                    kind === "corrupt-tool"
                                      ? "data:image/png;base64,AAEC"
                                      : plot.toDataURL("image/png"),
                                }
                              : block,
                          ),
                        }
                      : part,
                  ),
                }
              : message,
          ),
        )
    },
  })
render(
  () => (
    <RemoteProvider createStore={() => store}>
      <main class="transcript-fixture workspace__main">
        <div class="workspace__scroll">
          <div class="transcript-fixture__controls">
            <button
              id="admit"
              onClick={() =>
                setMessages((current) =>
                  current.map((message) => (message.kind === "user" ? { ...message, state: "promoted" } : message)),
                )
              }
            >
              Admit
            </button>
            <button
              id="consume"
              onClick={() =>
                setMessages(
                  (current) =>
                    applySessionEvent(
                      { ...createSessionView("ses_a"), messages: current },
                      { type: "session.input.consumed", data: { sessionID: "ses_a", inputIDs: ["msg_user"] } },
                      3,
                    ).messages,
                )
              }
            >
              Consume
            </button>
            <button
              id="stream"
              onClick={() =>
                setMessages(
                  (current) =>
                    applySessionEvent(
                      { ...createSessionView("ses_a"), messages: current },
                      {
                        type: "session.reasoning.delta",
                        data: {
                          sessionID: "ses_a",
                          assistantMessageID: "msg_agent",
                          ordinal: 2,
                          delta: "Streamed detail",
                        },
                      },
                      4,
                    ).messages,
                )
              }
            >
              Stream
            </button>
            <button
              id="append"
              onClick={() =>
                setMessages((current) =>
                  current.map((item) =>
                    item.kind === "assistant" && item.id === "answer_11"
                      ? {
                          ...item,
                          parts: item.parts.map((part) =>
                            part.kind === "text"
                              ? {
                                  ...part,
                                  text: `${part.text}\n${"Streaming detail expands this answer. ".repeat(12)}`,
                                }
                              : part,
                          ),
                        }
                      : item,
                  ),
                )
              }
            >
              Append
            </button>
            <button id="prune" onClick={() => setMessages((current) => current.slice(-12))}>
              Prune
            </button>
          </div>
          <TranscriptNavigation messages={messages} />
        </div>
        <div class="conversation-jump-slot" />
        <TodoPanel todos={[{ content: "Review the transcript", status: "in_progress", priority: "medium" }]} />
        <div class="composer transcript-fixture__composer">Composer preview</div>
      </main>
    </RemoteProvider>
  ),
  root,
)
