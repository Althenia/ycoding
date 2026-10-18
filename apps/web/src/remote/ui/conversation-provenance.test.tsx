import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { RemoteProvider } from "../context"
import { createRemoteHttp } from "../http"
import { applySessionEvent, createSessionView, type PendingRequestView } from "../projection"
import { createRemoteStore } from "../store"
import { MessageRow, RequestCard } from "./conversation"

test.each([
  ["unsupported-output", "Decision unavailable · the selected route does not support strict structured decisions"],
  ["refused", "Decision unavailable · the provider or model refused the decision request"],
  ["escalated", "Decision model escalated this guardrail review · choice escalate · confidence 0.934567"],
])("pending %s reviews and their chronological notices display the same diagnostic", (reason, label) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "" } } })
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: () => {
      throw new Error("Provenance rendering must not connect")
    },
  })
  try {
    const escalation = {
      reason,
      ...(reason === "escalated"
        ? {
            choice: "escalate",
            confidence: 0.934567,
            grades: [{ choice: "escalate", confidence: 0.934567, evidence: "A human must confirm the target." }],
          }
        : {}),
    }
    const request = {
      kind: "guardrail",
      id: "grq_failure",
      sessionID: "ses_a",
      rootSessionID: "ses_a",
      action: "write",
      resources: ["fixture.txt"],
      reason: "Write outside the repository",
      hardReview: false,
      escalation,
      askedAt: 1,
    } as PendingRequestView
    const view = applySessionEvent(
      { ...createSessionView("ses_a"), requests: [request] },
      {
        id: "evt_failure",
        type: "session.guardrail.escalated",
        created: 2,
        data: { sessionID: "ses_a", ...escalation },
      },
      2,
    )
    store.container.setState((current) => ({ ...current, activeSessionID: "ses_a", view }))
    const html = renderToString(() => (
      <RemoteProvider createStore={() => ({ ...store, load: async () => {} })}>
        <RequestCard request={() => request} activeSessionID="ses_a" />
        <MessageRow message={() => view.messages[0]!} />
      </RemoteProvider>
    ))
    expect(html.split(label)).toHaveLength(3)
    expect(html).toContain("Write outside the repository")
    expect(html).toContain("Approve once")
    expect(html).toContain("Reject")
    expect(html).not.toContain("unreported")
    if (reason === "escalated") {
      expect(html).toContain("Selected")
      expect(html).toContain("A human must confirm the target.")
    }
    if (reason !== "escalated") {
      expect(html).not.toContain("model escalated")
      expect(html).not.toContain("model choice")
      expect(html).not.toContain("confidence")
      expect(html).not.toContain("decision-grades")
    }
  } finally {
    store.dispose()
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
