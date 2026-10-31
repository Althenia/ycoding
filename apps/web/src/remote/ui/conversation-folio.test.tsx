import { expect, test } from "bun:test"
import type { JSX } from "solid-js"
import { renderToString } from "solid-js/web"
import { RemoteProvider } from "../context"
import { createRemoteHttp } from "../http"
import { createSessionView, type PendingRequestView, type RemoteMessageView } from "../projection"
import { createRemoteStore } from "../store"
import { MessageRow, RequestCard } from "./conversation"

function render(view: () => JSX.Element): string {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "" } } })
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport: () => { throw new Error("Transcript rendering must not connect") } })
  try {
    store.container.setState((current) => ({ ...current, activeSessionID: "ses_a", view: createSessionView("ses_a") }))
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
