import { createSignal, For } from "solid-js"
import { render } from "solid-js/web"
import { MessageRow } from "../src/remote/ui/conversation"
import { applySessionEvent, createSessionView, readMessageList, readSnapshot, type RemoteMessageView } from "../src/remote/projection"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const initial: readonly RemoteMessageView[] = [
  { kind: "user", id: "msg_user", text: "A long prompt ".repeat(14), state: "pending", delivery: "queue", created: 1 },
  { kind: "assistant", id: "msg_agent", agent: "god", parts: [
    { kind: "reasoning", ordinal: 0, text: "**Important** idea <img src=x onerror=alert(1)>" },
    { kind: "reasoning", ordinal: 1, text: "More `code` and *emphasis*" },
    { kind: "reasoning", ordinal: 2, text: "   " },
    { kind: "text", ordinal: 0, text: "Final answer" },
  ], created: 2 },
]
const synthetic = new URLSearchParams(location.search).get("synthetic")
const [messages, setMessages] = createSignal(synthetic ? syntheticMessages(synthetic === "compacted") : initial)

function syntheticMessages(compacted: boolean): readonly RemoteMessageView[] {
  const raw = Array.from({ length: 1_200 }, (_, index) => ({ id: `msg_${index}`, type: "assistant", agent: "god", content: [{ type: "reasoning", text: "**Check context** with `code` and *verify the next step*." }, { type: "text", text: `Answer ${index}` }], time: { created: index } }))
  if (!compacted) return readMessageList({ data: raw })
  const messages = [...raw.slice(0, 1_080), { id: "msg_compact", type: "compaction", jobID: "cmp_1", trigger: "manual", status: "completed", revision: 1, boundary: { messageID: "msg_1079", seq: 1_080 }, metrics: { excludedMessages: 1_080, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 }, time: { created: 1_080 } }, ...raw.slice(1_080)]
  return readSnapshot({ session: {}, messages })?.messages ?? []
}
const root = document.getElementById("app")
if (!root) throw new Error("Missing transcript root")
render(() => <main class="transcript-fixture"><button id="admit" onClick={() => setMessages((current) => current.map((message) => message.kind === "user" ? { ...message, state: "promoted" } : message))}>Admit</button><button id="consume" onClick={() => setMessages((current) => applySessionEvent({ ...createSessionView("ses_a"), messages: current }, { type: "session.input.consumed", data: { sessionID: "ses_a", inputIDs: ["msg_user"] } }, 3).messages)}>Consume</button><button id="stream" onClick={() => setMessages((current) => applySessionEvent({ ...createSessionView("ses_a"), messages: current }, { type: "session.reasoning.delta", data: { sessionID: "ses_a", assistantMessageID: "msg_agent", ordinal: 2, delta: "Streamed detail" } }, 4).messages)}>Stream</button><ol class="transcript"><For each={messages().map((message) => message.id)}>{(id) => <MessageRow message={() => messages().find((message) => message.id === id)!} />}</For></ol></main>, root)
