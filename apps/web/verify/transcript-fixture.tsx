import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { TranscriptNavigation } from "../src/remote/ui/transcript-nav"
import { TodoPanel } from "../src/remote/ui/todo-panel"
import { RemoteProvider } from "../src/remote/context"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteHttp } from "../src/remote/http"
import { applySessionEvent, createSessionView, readMessageList, readSnapshot, type RemoteMessageView } from "../src/remote/projection"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"
import "../src/remote/ui/transcript-fixture.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"

const initial: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_user", text: "A long prompt ".repeat(14), state: "pending", delivery: "queue", created: 1 },
  { kind: "assistant", id: "msg_agent", agent: "god", parts: [
    { kind: "reasoning", ordinal: 0, text: "**Important** idea <img src=x onerror=alert(1)>", started: 100, completed: 2_100 },
    { kind: "reasoning", ordinal: 1, text: "More `code` and *emphasis*", started: 2_200, completed: 2_400 },
    { kind: "reasoning", ordinal: 2, text: "   " },
    { kind: "tool", callID: "call_1", name: "shell", status: "completed", input: { command: "bun test ./src" }, content: [{ kind: "text", text: "23 pass · 0 fail" }], started: 2_200, ran: 2_300, completed: 2_437 },
    { kind: "tool", callID: "call_2", name: "read", status: "failed", input: { path: "src/long-file.ts" }, content: [], error: "A very long JSON error ".repeat(3), started: 2_500, completed: 2_600 },
    { kind: "text", ordinal: 0, text: "# Final answer\n\n**Important** changes and ~~old plan~~:\n- First item with `inline code`\n- Nested:\n  - Sub item\n1. Ordered item\n2. Another item\n- [x] Verified task\n\n> A quoted detail\n\n---\n\n| Item | Result |\n| --- | --- |\n| Build | pass |\n\n```ts\nconst answer = 42\n```\n\n[Safe](https://example.com) [Unsafe](javascript:alert(1)) ![No image](https://example.com/image.png) <script>alert(1)</script>" },
  ], model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }, created: 2, completed: 5_000 },
  { kind: "synthetic", id: "msg_state", text: 'Authoritative current Session state (JSON):\n{"autonomy":{"mode":"goal","yolo":2},"todos":[{}]}', source: "session-state", created: 5_100 },
]
const synthetic = new URLSearchParams(location.search).get("synthetic")
const toolOutput = new URLSearchParams(location.search).has("tool-output")
const navigation = new URLSearchParams(location.search).has("navigation")
const runningStep = new URLSearchParams(location.search).has("running")
const notification = new URLSearchParams(location.search).has("notification")
const visibility = new URLSearchParams(location.search).has("visibility")
const historyMode = new URLSearchParams(location.search).has("history")
const imagesMode = new URLSearchParams(location.search).has("images")
const oversizedMode = new URLSearchParams(location.search).has("oversized")
const pendingOversized = new URLSearchParams(location.search).get("oversized") === "pending"
const compactionMode = new URLSearchParams(location.search).get("compaction")
const raw = "first line\n" + "x".repeat(20_000) + "\n... output truncated; full content saved to /private/fixture/tool-output.txt ..."
const outputMessages: readonly RemoteMessageView[] = [{ kind: "assistant", id: "msg_tool", created: 1, parts: [
  { kind: "tool", callID: "call_store", name: "read", status: "completed", content: [{ kind: "text", text: raw.replace(/\.\.\. output truncated; full content saved to [^\r\n]*/g, "[full output retained on the device]"), sourceTruncated: true }], structured: { truncated: true } },
  { kind: "tool", callID: "call_shell", name: "shell", status: "completed", content: [{ kind: "text", text: "shell result\n[full output retained on the device]", sourceTruncated: true }] },
] }]
const navigationMessages: readonly RemoteMessageView[] = Array.from({ length: 12 }, (_, index): readonly RemoteMessageView[] => [
  { kind: "user", id: `prompt_${index}`, text: `Prompt ${index + 1}: ${"inspect the current work ".repeat(4)}`, state: "consumed", created: index * 2 },
  { kind: "assistant", id: `answer_${index}`, agent: "god", parts: [{ kind: "text", ordinal: 0, text: `Response ${index + 1}\n\n${"A detailed paragraph of work. ".repeat(12)}` }], created: index * 2 + 1, ...(index === 11 ? {} : { completed: index * 2 + 2 }) },
]).flat()
const runningMessages: readonly RemoteMessageView[] = [{ kind: "assistant", id: "running_step", agent: "god", created: 1, parts: [{ kind: "tool", callID: "running_tool", name: "shell", status: "running", input: { command: "bun test" }, content: [], started: 2 }] }]
const notificationMetadata = { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 3, excerpt: "Tests pass and the repair is verified." }
const notificationMessages: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_ordinary", text: "Check the repair", state: "consumed", created: 1 },
  { kind: "synthetic", id: "msg_notification", text: `Subagent notification:\n${JSON.stringify(notificationMetadata)}`, description: "Subagent notification", metadata: notificationMetadata, created: 2 },
]
const visibilityMessages: readonly RemoteMessageView[] = [
  notificationMessages[0]!,
  { kind: "system", id: "msg_internal_state", text: 'Authoritative current Session state (JSON):\n{"autonomy":{"mode":"normal","yolo":0},"todos":[]}', source: "session-state", created: 2 },
  { kind: "synthetic", id: "msg_internal_team", text: 'Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n{"children":[{"state":"running"}]}', description: "TeamView update", source: "team-view", created: 3 },
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
const imageMessages: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_image", text: "Review these files", state: "consumed", created: 1, attachments: [
    { name: "screen.png", mime: "image/png", bytes: 4_096, digest: "a".repeat(64) },
    { name: "report.pdf", mime: "application/pdf", bytes: 1_024, digest: "b".repeat(64) },
    { name: "broken.png", mime: "image/png", bytes: 2_048, digest: "c".repeat(64) },
  ] },
  { kind: "assistant", id: "msg_tool_image", created: 2, parts: [{ kind: "tool", callID: "call_image", name: "read", status: "completed", content: [
    { kind: "image", uri: plot.toDataURL("image/png"), mime: "image/png", name: "plot.png" },
  ] }] },
]
const compressionMetrics = { excludedMessages: 11, excludedParts: 1, inputTokens: 1_000, retainedTokens: 400 }
const compactionMessages: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_before", text: "Before compression", state: "consumed", created: 1 },
  { kind: "compaction", id: "cmp_live", jobID: "cmp_live", status: "running", created: 3 },
  { kind: "user", id: "msg_after", text: "Neighbouring row remains in place", state: "consumed", created: 4 },
]
let imageFetches = 0
if (imagesMode) {
  const originalFetch = window.fetch.bind(window)
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    if (url.endsWith(`/attachments/${"a".repeat(64)}`)) {
      imageFetches += 1
      await new Promise((resolve) => setTimeout(resolve, 35))
      return new Response(JSON.stringify({ mime: "image/png", bytes: 4_096, data: plot.toDataURL("image/png").split(",")[1] }), { headers: { "content-type": "application/json" } })
    }
    if (url.endsWith(`/attachments/${"c".repeat(64)}`)) return new Response(null, { status: 404 })
    return originalFetch(input, init)
  }, { preconnect: window.fetch.preconnect })
}
let streamedImageText = ""
const imageSnapshot = () => readSnapshot({ sourceEpoch: "epoch_1", session: { id: "ses_a" }, watermark: { type: "log.synced", aggregateID: "ses_a", seq: 12 }, messages: [
  { id: "msg_image", type: "user", text: "Review these files", time: { created: 1, consumed: 2 }, files: [
    { name: "screen.png", mime: "image/png", content: { type: "managed", bytes: 4_096, digest: "a".repeat(64) } },
    { name: "report.pdf", mime: "application/pdf", content: { type: "managed", bytes: 1_024, digest: "b".repeat(64) } },
    { name: "broken.png", mime: "image/png", content: { type: "managed", bytes: 2_048, digest: "c".repeat(64) } },
  ] },
  { id: "msg_tool_image", type: "assistant", time: { created: 2 }, content: [
    { type: "tool", id: "call_image", name: "read", state: { status: "completed", content: [{ type: "file", uri: plot.toDataURL("image/png"), mime: "image/png", name: "plot.png" }] } },
    ...(streamedImageText ? [{ type: "text", text: streamedImageText }] : []),
  ] },
] })?.messages ?? imageMessages
const [messages, setMessages] = createSignal(synthetic ? syntheticMessages(synthetic === "compacted") : toolOutput ? outputMessages : historyMode ? navigationMessages.slice(12) : imagesMode ? imageMessages : oversizedMode ? [{ kind: "oversized", id: "msg_big", projected: !pendingOversized, state: pendingOversized ? "pending" : "loading" }] as const : navigation ? navigationMessages : runningStep ? runningMessages : visibility ? visibilityMessages : notification ? notificationMessages : compactionMode ? compactionMessages : initial)
const [compactionHistory, setCompactionHistory] = createSignal(compactionMode && compactionMode !== "old" ? {
  data: [{ jobID: "cmp_old", trigger: "auto", status: "completed" as const, metrics: { ...compressionMetrics, inputTokens: 500, retainedTokens: 200 }, created: 2 }, { jobID: "cmp_live", trigger: "manual", status: "running" as const, created: 3 }],
  truncated: compactionMode === "truncated", completedBefore: compactionMode === "truncated" ? 2 : 0, completedCount: compactionMode === "truncated" ? 3 : 1, totalSavedTokens: compactionMode === "truncated" ? 900 : 300,
} : undefined)
const [history, setHistory] = createSignal<{ readonly status: "idle"; readonly before?: string }>(historyMode ? { status: "idle", before: "older" } : { status: "idle" })

function syntheticMessages(compacted: boolean): readonly RemoteMessageView[] {
  const raw = Array.from({ length: 1_200 }, (_, index) => ({ id: `msg_${index}`, type: "assistant", agent: "god", content: [{ type: "reasoning", text: "**Check context** with `code` and *verify the next step*." }, { type: "text", text: `Answer ${index}` }], time: { created: index } }))
  if (!compacted) return readMessageList({ data: raw })
  const messages = [...raw.slice(0, 1_080), { id: "msg_compact", type: "compaction", jobID: "cmp_1", trigger: "manual", status: "completed", revision: 1, boundary: { messageID: "msg_1079", seq: 1_080 }, metrics: { excludedMessages: 1_080, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 }, time: { created: 1_080 } }, ...raw.slice(1_080)]
  return readSnapshot({ session: {}, messages })?.messages ?? []
}
const root = document.getElementById("app")
if (!root) throw new Error("Missing transcript root")
const store = createRemoteStore({ http: createRemoteHttp({ fetch: Object.assign(async () => new Response(null, { status: 401 }), { preconnect: () => {} }) }), createTransport: () => { throw new Error("Fixture transport must not connect") } })
const fixtureState = { ...store.state(), activeSessionID: "ses_a", activeDeviceID: "dev_1" }
const listeners = new Set<() => void>()
Object.defineProperty(store, "state", { value: () => ({ ...fixtureState, history: history(), view: compactionMode ? { ...createSessionView("ses_a"), compactionHistory: compactionHistory() } : fixtureState.view }) })
Object.defineProperty(store, "subscribe", { value: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } })
Object.defineProperty(store, "loadOlderMessages", { value: async () => {
  if (!history().before) return
  setMessages((current) => [...navigationMessages.slice(0, 12), ...current])
  setHistory({ status: "idle" })
  listeners.forEach((listener) => listener())
} })
Object.defineProperty(store, "loadOversizedMessage", { value: async () => setMessages([{ kind: "user", id: "msg_big", text: "Recovered full content", state: "consumed", created: 2 }]) })
if (compactionMode) Object.assign(window, { compactionUpdate: () => {
  setMessages((current) => current.map((message) => message.kind === "compaction" ? { ...message, id: "msg_compact", status: "completed", trigger: "manual", metrics: compressionMetrics } : message))
  if (compactionMode !== "old") setCompactionHistory({ data: [
    { jobID: "cmp_old", trigger: "auto", status: "completed", metrics: { ...compressionMetrics, inputTokens: 500, retainedTokens: 200 }, created: 2 },
    { jobID: "cmp_live", trigger: "manual", status: "completed", metrics: compressionMetrics, created: 3 },
  ], truncated: compactionMode === "truncated", completedBefore: compactionMode === "truncated" ? 2 : 0, completedCount: compactionMode === "truncated" ? 4 : 2, totalSavedTokens: compactionMode === "truncated" ? 1_500 : 900 })
  listeners.forEach((listener) => listener())
} })
if (compactionMode) Object.assign(window, { compactionFail: () => {
  setMessages((current) => current.map((message) => message.kind === "compaction" ? { ...message, status: "failed", failureCode: "cancelled" } : message))
} })
if (imagesMode) Object.assign(window, {
  imageFetchCount: () => imageFetches,
  imageUpdate: (kind: "stream" | "live" | "reconcile" | "prepend" | "reconnect" | "corrupt-tool" | "repair-tool") => {
    if (kind === "stream") {
      streamedImageText += "more "
      setMessages((current) => applySessionEvent({ ...createSessionView("ses_a"), messages: current }, { type: "session.text.delta", data: { sessionID: "ses_a", assistantMessageID: "msg_tool_image", ordinal: 1, delta: "more " } }, 10).messages)
    }
    if (kind === "live") setMessages((current) => applySessionEvent({ ...createSessionView("ses_a"), messages: current }, { type: "session.input.consumed", data: { sessionID: "ses_a", inputIDs: ["msg_image"] } }, 11).messages)
    if (kind === "reconcile" || kind === "reconnect") setMessages(imageSnapshot())
    if (kind === "prepend") setMessages((current) => [{ kind: "user", id: "msg_older", text: "An older prompt", state: "consumed", created: 0 }, ...current])
    if (kind === "corrupt-tool" || kind === "repair-tool") setMessages((current) => current.map((message) => message.kind === "assistant" && message.id === "msg_tool_image"
      ? { ...message, parts: message.parts.map((part) => part.kind === "tool"
        ? { ...part, content: part.content.map((block) => block.kind === "image" ? { ...block, uri: kind === "corrupt-tool" ? "data:image/png;base64,AAEC" : plot.toDataURL("image/png") } : block) }
        : part) }
      : message))
  },
})
render(() => <RemoteProvider createStore={() => store}><main class="transcript-fixture workspace__main"><div class="workspace__scroll"><div class="transcript-fixture__controls"><button id="admit" onClick={() => setMessages((current) => current.map((message) => message.kind === "user" ? { ...message, state: "promoted" } : message))}>Admit</button><button id="consume" onClick={() => setMessages((current) => applySessionEvent({ ...createSessionView("ses_a"), messages: current }, { type: "session.input.consumed", data: { sessionID: "ses_a", inputIDs: ["msg_user"] } }, 3).messages)}>Consume</button><button id="stream" onClick={() => setMessages((current) => applySessionEvent({ ...createSessionView("ses_a"), messages: current }, { type: "session.reasoning.delta", data: { sessionID: "ses_a", assistantMessageID: "msg_agent", ordinal: 2, delta: "Streamed detail" } }, 4).messages)}>Stream</button><button id="append" onClick={() => setMessages((current) => current.map((item) => item.kind === "assistant" && item.id === "answer_11" ? { ...item, parts: item.parts.map((part) => part.kind === "text" ? { ...part, text: `${part.text}\n${"Streaming detail expands this answer. ".repeat(12)}` } : part) } : item))}>Append</button><button id="prune" onClick={() => setMessages((current) => current.slice(-12))}>Prune</button>{oversizedMode && <button id="fail-oversized" onClick={() => setMessages([{ kind: "oversized", id: "msg_big", projected: true, state: "error" }])}>Fail content</button>}</div><TranscriptNavigation messages={messages} /></div><div class="conversation-jump-slot" /><TodoPanel todos={[{ content: "Review the transcript", status: "in_progress", priority: "medium" }]} /><div class="composer transcript-fixture__composer">Composer preview</div></main></RemoteProvider>, root)
