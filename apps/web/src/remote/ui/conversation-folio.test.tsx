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
const headings = (html: string) => [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((match) => match[1])

test("every turn opens with a folio head; the ordinal is decorative and only present when reported", () => {
  for (const message of [user, assistant]) {
    const withOrdinal = render(() => <MessageRow message={() => message} ordinal={7} />)
    expect(withOrdinal).toContain("transcript-message__head")
    expect(withOrdinal).toMatch(/<span class="transcript-message__ordinal" aria-hidden="true"[^>]*>§(<!--[^>]*-->)?07/)
    const without = render(() => <MessageRow message={() => message} />)
    expect(without).toContain("transcript-message__head")
    expect(without).toContain("transcript-message__role")
    expect(without).not.toContain("§")
    expect(without).not.toContain("transcript-message__ordinal")
  }
  expect(render(() => <MessageRow message={() => user} />)).toContain("Directive")
  expect(render(() => <MessageRow message={() => assistant} />)).toContain("Execution")
})

test("the ordinal changes no accessible name, heading or receipt text", () => {
  for (const message of [user, assistant]) {
    const withOrdinal = render(() => <MessageRow message={() => message} ordinal={12} />)
    const without = render(() => <MessageRow message={() => message} />)
    expect(labels(withOrdinal)).toEqual(labels(without))
    expect(headings(withOrdinal)).toEqual(headings(without))
    expect(withOrdinal.replace(/<span class="transcript-message__ordinal"[\s\S]*?<\/span>/, "").replace(/<!--[^>]*-->/g, "")).toBe(without.replace(/<!--[^>]*-->/g, ""))
  }
  const html = render(() => <MessageRow message={() => user} ordinal={3} />)
  expect(html).toContain('role="status" aria-label="Read by YCoding"')
})

test("a continued assistant segment carries no second head, and the turn keeps one metadata line", () => {
  const first = render(() => <MessageRow message={() => assistant} continued head ordinal={2} />)
  const later = render(() => <MessageRow message={() => assistant} continued head={false} />)
  expect(first.match(/transcript-message__head/g)).toHaveLength(1)
  expect(first.match(/transcript-message__footer/g)).toHaveLength(1)
  expect(later).not.toContain("transcript-message__head")
  expect(later).not.toContain("transcript-message__footer")
})

test("per-message cost never renders in a folio head", () => {
  const html = render(() => <MessageRow message={() => assistant} ordinal={2} />)
  expect(html).not.toMatch(/\$\d|Cost|cost/)
})

test("a hard review keeps its danger class while other requests render as plain ledger rows", () => {
  const request = (hardReview: boolean): PendingRequestView => ({ kind: "guardrail", id: `guard_${hardReview}`, sessionID: "ses_a", action: "shell", resources: ["rm -rf build"], reason: "outside the project", hardReview, askedAt: 1 })
  const hard = render(() => <RequestCard request={() => request(true)} activeSessionID="ses_a" />)
  const soft = render(() => <RequestCard request={() => request(false)} activeSessionID="ses_a" />)
  expect(hard).toContain("request--hard")
  expect(hard).toContain("Hard review")
  expect(soft).not.toContain("request--hard")
  expect(soft).toContain("request request--guardrail")
})
