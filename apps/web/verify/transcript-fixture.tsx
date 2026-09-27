import { createSignal, For } from "solid-js"
import { render } from "solid-js/web"
import { MessageRow } from "../src/remote/ui/conversation"
import { SessionStatusBar } from "../src/remote/ui/status-bar"
import { RemoteProvider } from "../src/remote/context"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteHttp } from "../src/remote/http"
import { applySessionEvent, createSessionView, readMessageList, readSnapshot, type RemoteMessageView } from "../src/remote/projection"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"
import "../src/remote/ui/transcript-fixture.css"

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
const raw = "first line\n" + "x".repeat(20_000) + "\n... output truncated; full content saved to /private/fixture/tool-output.txt ..."
const outputMessages: readonly RemoteMessageView[] = [{ kind: "assistant", id: "msg_tool", created: 1, parts: [
  { kind: "tool", callID: "call_store", name: "read", status: "completed", content: [{ kind: "text", text: raw.replace(/\.\.\. output truncated; full content saved to [^\r\n]*/g, "[full output retained on the device]"), sourceTruncated: true }], structured: { truncated: true } },
  { kind: "tool", callID: "call_shell", name: "shell", status: "completed", content: [{ kind: "text", text: "shell result\n[full output retained on the device]", sourceTruncated: true }] },
] }]
const [messages, setMessages] = createSignal(synthetic ? syntheticMessages(synthetic === "compacted") : toolOutput ? outputMessages : initial)

function syntheticMessages(compacted: boolean): readonly RemoteMessageView[] {
  const raw = Array.from({ length: 1_200 }, (_, index) => ({ id: `msg_${index}`, type: "assistant", agent: "god", content: [{ type: "reasoning", text: "**Check context** with `code` and *verify the next step*." }, { type: "text", text: `Answer ${index}` }], time: { created: index } }))
  if (!compacted) return readMessageList({ data: raw })
  const messages = [...raw.slice(0, 1_080), { id: "msg_compact", type: "compaction", jobID: "cmp_1", trigger: "manual", status: "completed", revision: 1, boundary: { messageID: "msg_1079", seq: 1_080 }, metrics: { excludedMessages: 1_080, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 }, time: { created: 1_080 } }, ...raw.slice(1_080)]
  return readSnapshot({ session: {}, messages })?.messages ?? []
}
const root = document.getElementById("app")
if (!root) throw new Error("Missing transcript root")
const running = { ...createSessionView("ses_a"), status: "running" as const, executionStarted: Date.now() - 46_700, autonomy: { mode: "goal" as const, yolo: 2 as const, goal: { text: "Verify the transcript against the requested states", status: "active" as const, iteration: 3, noProgress: 1, maxNoProgress: 3 } } }
const store = createRemoteStore({ http: createRemoteHttp({ fetch: Object.assign(async () => new Response(null, { status: 401 }), { preconnect: () => {} }) }), createTransport: () => { throw new Error("Fixture transport must not connect") } })
const fixtureState = { ...store.state(), view: running, activeSessionID: "ses_a" }
Object.defineProperty(store, "state", { value: () => fixtureState })
render(() => <RemoteProvider createStore={() => store}><main class="transcript-fixture"><div class="transcript-fixture__controls"><button id="admit" onClick={() => setMessages((current) => current.map((message) => message.kind === "user" ? { ...message, state: "promoted" } : message))}>Admit</button><button id="consume" onClick={() => setMessages((current) => applySessionEvent({ ...createSessionView("ses_a"), messages: current }, { type: "session.input.consumed", data: { sessionID: "ses_a", inputIDs: ["msg_user"] } }, 3).messages)}>Consume</button><button id="stream" onClick={() => setMessages((current) => applySessionEvent({ ...createSessionView("ses_a"), messages: current }, { type: "session.reasoning.delta", data: { sessionID: "ses_a", assistantMessageID: "msg_agent", ordinal: 2, delta: "Streamed detail" } }, 4).messages)}>Stream</button></div><ol class="transcript"><For each={messages().map((message) => message.id)}>{(id) => <MessageRow message={() => messages().find((message) => message.id === id)!} />}</For></ol><SessionStatusBar /></main></RemoteProvider>, root)
