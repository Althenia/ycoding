import { expect, test } from "bun:test"
import type { JSX } from "solid-js"
import { renderToString } from "solid-js/web"
import { RemoteProvider } from "../context"
import { createRemoteHttp } from "../http"
import { createSessionView, type PendingRequestView, type RemoteMessageView } from "../projection"
import { createRemoteStore } from "../store"
import { MessageRow, RequestCard, TranscriptActivityRow } from "./conversation"

function render(view: () => JSX.Element, running = false): string {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "" } } })
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport: () => { throw new Error("Transcript rendering must not connect") } })
  try {
    store.container.setState((current) => ({ ...current, activeSessionID: "ses_a", view: { ...createSessionView("ses_a"), status: running ? "running" : "idle" }, connection: { kind: "connected", deviceName: "Fixture" }, transport: { kind: "open" } }))
    return renderToString(() => <RemoteProvider createStore={() => ({ ...store, load: async () => {} })}>{view()}</RemoteProvider>)
  } finally {
    store.dispose()
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

const user: RemoteMessageView = { kind: "user", id: "msg_user", text: "Review the change", state: "consumed", delivery: "queue", created: 1 }
const assistant: RemoteMessageView = { kind: "assistant", id: "msg_agent", created: 2, completed: 5, agent: "build", parts: [{ kind: "text", ordinal: 0, text: "Done" }] }
const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1])

test("transient activity renders a polite three-dot live state and no markup at idle", () => {
  const active = render(() => <TranscriptActivityRow />, true)
  expect(active).toContain('class="transcript-activity" role="status" aria-live="polite" aria-atomic="true"')
  expect(active).toContain("Thinking")
  expect(active).toContain('class="transcript-activity__typing" aria-hidden="true"><span></span><span></span><span></span>')
  expect(render(() => <TranscriptActivityRow />)).not.toContain("transcript-activity")
})

test("an assistant turn opens with a mark and one metadata line and never a section ordinal", () => {
  const html = render(() => <MessageRow message={() => assistant} />)
  expect(html).toContain("transcript-message__head")
  expect(html).toMatch(/<img class="transcript-message__mark" src="\/brand\/ycoding-mark.svg" alt[ =>]/)
  expect(html).toContain("transcript-message__footer")
  expect(html).not.toContain("§")
  expect(html).not.toContain("transcript-message__ordinal")
  expect(html).not.toContain("transcript-message__role")
  expect(html).not.toContain("Execution")
})

test("a user prompt is a capsule followed by a static status receipt and carries no head", () => {
  const html = render(() => <MessageRow message={() => user} />)
  expect(html).not.toContain("transcript-message__head")
  expect(html).not.toContain("§")
  expect(html).not.toContain("Directive")
  expect(html).toContain('class="transcript-message__bubble"')
  expect(html).toContain('role="status" aria-label="Read by YCoding"')
  expect(html.indexOf("transcript-message__bubble")).toBeLessThan(html.indexOf("transcript-message__receipt"))
  expect(labels(html)).toContain("Read by YCoding")
})

test("a continued assistant segment carries no second head, and the turn keeps one metadata line", () => {
  const first = render(() => <MessageRow message={() => assistant} continued head />)
  const later = render(() => <MessageRow message={() => assistant} continued head={false} />)
  expect(first.match(/transcript-message__head/g)).toHaveLength(1)
  expect(first.match(/transcript-message__footer/g)).toHaveLength(1)
  expect(later).not.toContain("transcript-message__head")
  expect(later).not.toContain("transcript-message__footer")
})

test("a tool-only or thought-only reply keeps its head but names no agent heading", () => {
  const tool: RemoteMessageView = { kind: "assistant", id: "msg_tool", created: 2, completed: 5, agent: "build", parts: [{ kind: "reasoning", ordinal: 0, text: "thinking", started: 2, completed: 3 }] }
  const html = render(() => <MessageRow message={() => tool} />)
  expect(html).toContain("transcript-message__footer")
  expect(html).not.toContain("transcript-message__agent")
})

test("per-message cost never renders in a turn head", () => {
  const html = render(() => <MessageRow message={() => assistant} />)
  expect(html).not.toMatch(/\$\d|Cost|cost/)
})

test("a hard review keeps its danger class while other requests render as floating planes", () => {
  const request = (hardReview: boolean): PendingRequestView => ({ kind: "guardrail", id: `guard_${hardReview}`, sessionID: "ses_a", action: "shell", resources: ["rm -rf build"], reason: "outside the project", hardReview, askedAt: 1 })
  const hard = render(() => <RequestCard request={() => request(true)} activeSessionID="ses_a" />)
  const soft = render(() => <RequestCard request={() => request(false)} activeSessionID="ses_a" />)
  expect(hard).toContain("request--hard")
  expect(hard).toContain("Hard review")
  expect(soft).not.toContain("request--hard")
  expect(soft).toContain("request request--guardrail")
})

test("genuine Dot-originated steer prompts render as user-styled bubbles with cleaned steer text and non-human provenance", () => {
  const steer: RemoteMessageView = {
    kind: "synthetic",
    id: "msg_v_0120_dot_steer",
    description: "Install and verify the pinned official Argo CD MCP in Work project config",
    text: "<shared-context>\nUser evidence:\nprior turn\n</shared-context>\n\n<system-update>{\"autonomy\":{\"mode\":\"normal\"}}</system-update>\nInstall and verify the pinned official Argo CD MCP by checking Work project config first.\n<!-- hidden:trace -->",
    created: 3,
  }
  const html = render(() => <MessageRow message={() => steer} />)
  expect(html).toContain("transcript-message--synthetic")
  expect(html).toContain("transcript-message--user")
  expect(html).toContain('aria-label="Dot steer prompt"')
  expect(html).toContain('class="transcript-message__bubble"')
  expect(html).toContain("Install and verify the pinned official Argo CD MCP by checking Work project config first.")
  expect(html).not.toContain("<shared-context>")
  expect(html).not.toContain("<system-update>")
  expect(html).not.toContain("hidden:trace")
  expect(html).not.toContain("transcript-message__system")
  expect(html.replace(/aria-label="[^"]*"/g, "")).not.toContain("Dot steer")
  expect(html).toContain('class="transcript-message__origin" role="img" aria-label="ChatGPT" title="Sent via ChatGPT"')
  expect(html).not.toContain("transcript-message__receipt")
  expect(html).not.toContain("Read by YCoding")

  const pendingSteer: RemoteMessageView = {
    kind: "synthetic",
    id: "msg_v_pending_steer",
    description: "Pending steer title",
    text: "Run the targeted suite now.",
    pending: true,
    created: 4,
  }
  const pendingHtml = render(() => <MessageRow message={() => pendingSteer} />)
  expect(pendingHtml).toContain('class="transcript-message__bubble"')
  expect(pendingHtml).toContain("Run the targeted suite now.")
  expect(pendingHtml).toContain('aria-label="Sent"')
  expect(pendingHtml).toContain('data-state="processing"')
  expect(pendingHtml.replace(/aria-label="[^"]*"/g, "")).not.toContain("Dot steer")
  expect(pendingHtml).not.toContain("Read by YCoding")

  const emptySteer: RemoteMessageView = {
    kind: "synthetic",
    id: "msg_v_empty_steer",
    description: "Title that must not become fake user text",
    text: "<system-update>{\"autonomy\":{}}</system-update>",
    created: 5,
  }
  const emptyHtml = render(() => <MessageRow message={() => emptySteer} />)
  expect(emptyHtml).not.toContain('class="transcript-message__bubble"')
  expect(emptyHtml).not.toContain("Title that must not become fake user text")
})

test("non-steer synthetic notices keep their notice or system rendering", () => {
  const notices: readonly RemoteMessageView[] = [
    { kind: "synthetic", id: "msg_peer", description: "Peer", text: "Hello from room", metadata: { dots: { origin: "dots-peer", profile: "synthetic", dotID: "dot-1", threadID: "thread-1", itemID: "item-1" } }, created: 1 },
    { kind: "synthetic", id: "msg_audit", description: "Read 12 bytes from config.ts", text: "Read 12 bytes from config.ts", metadata: { dots: { operation: "read", path: "config.ts", bytes: 12 } }, created: 2 },
    { kind: "synthetic", id: "msg_goal", description: "Goal · steer", text: "Continue the goal", metadata: { autonomy: { goal: true } }, created: 3 },
    { kind: "synthetic", id: "msg_project", description: "Project notification", text: "Project notification", metadata: { source: "project_notification", event: "started", memberSessionID: "ses_member", title: "Worker" }, created: 4 },
    { kind: "synthetic", id: "msg_subagent", description: "Subagent notification", text: "Subagent notification", metadata: { source: "subagent_notification", type: "completed", childID: "ses_child" }, created: 5 },
    { kind: "synthetic", id: "msg_parent_msg", description: "Parent subagent message", text: "Parent message", metadata: { source: "subagent_parent", kind: "message" }, created: 6 },
    { kind: "synthetic", id: "msg_snapshot", description: "Parent session history snapshot", text: "Recent parent session history:\nUser: Hi", created: 7 },
  ]
  for (const notice of notices) {
    const html = render(() => <MessageRow message={() => notice} />)
    expect(html).not.toContain('class="transcript-message__bubble"')
    expect(html).not.toContain('aria-label="Dot steer prompt"')
  }
})
