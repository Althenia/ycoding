import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { RemoteProvider } from "../context"
import { createRemoteHttp } from "../http"
import { createSessionView, type RemoteMessageView } from "../projection"
import { createRemoteStore } from "../store"
import { accountedTask } from "../../../test/usage-fixture"
import { MessageRow } from "./conversation"

test.each(["pending", "promoted", "consumed"] as const)("%s user messages keep their receipt without per-prompt accounting", (state) => {
  // The production provider reads the route during SSR; no browser DOM is needed.
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "" } } })
  try {
    for (const status of ["idle", "running"] as const) for (const promptCostState of [undefined, "loading", "unavailable", "ready"] as const) {
      const message: RemoteMessageView = { kind: "user", id: "msg_cost", text: "Review the change", state, delivery: "queue", created: 1,
        attachments: [{ name: "notes.md", mime: "text/markdown", digest: "fixture", bytes: 20 }] }
      const task = accountedTask("ses_a")
      const store = createRemoteStore({ http: createRemoteHttp(), createTransport: () => { throw new Error("Transcript rendering must not connect") } })
      store.container.setState((current) => ({ ...current, activeSessionID: "ses_a", view: { ...createSessionView("ses_a"), status, messages: [message],
        promptCostState, promptCosts: promptCostState === "ready" ? [{ ...task, anchor: { sessionID: "ses_a", inputID: message.id } }] : undefined } }))
      try {
        const html = renderToString(() => <RemoteProvider createStore={() => ({ ...store, load: async () => {} })}><MessageRow message={() => message} /></RemoteProvider>)
        expect(html).toContain("Review the change")
        expect(html).toContain("notes.md")
        expect(html).toContain("transcript-message__receipt")
        expect(html).toContain(state === "pending" ? "Queued" : status === "running" ? "Processing" : state === "consumed" ? "Read by YCoding" : "Sent, not yet read")
        expect(html).not.toContain("Prompt cost")
        expect(html).not.toContain("Cost breakdown")
        expect(html).not.toContain("usage-unit-cost")
        expect(html).not.toContain("$0.25")
      } finally { store.dispose() }
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
