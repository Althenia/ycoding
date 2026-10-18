import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { RemoteProvider } from "../context"
import { createRemoteHttp } from "../http"
import { createSessionView, type ReviewItemView, type ReviewReason } from "../projection"
import { createRemoteStore } from "../store"
import { questionAnswers, ReviewBox } from "./review-box"

test("question decisions send one answer list per question in question order, empty when unanswered", () => {
  expect(questionAnswers(3, { q0: "main", q1: ["a", "b"] })).toEqual([["main"], ["a", "b"], []])
  expect(questionAnswers(1, { q0: "" })).toEqual([[]])
})

test.each([
  ["unavailable", "Decision unavailable · the decision model or its authenticated route is unavailable"],
  ["invalid-request", "Decision unavailable · the decision request is invalid"],
  ["provider-failed", "Decision unavailable · the provider request failed"],
  ["input-too-large", "Decision unavailable · the decision input exceeds the supported size"],
  ["invalid-output", "Decision unavailable · the decision response failed validation"],
  ["truncated-output", "Decision unavailable · the decision response was truncated or did not finish"],
  ["unsupported-output", "Decision unavailable · the selected route does not support strict structured decisions"],
  ["conflicting_grades", "Decision requires human review · conflicting approval and rejection grades"],
  ["refused", "The decision model declined to decide"],
  ["timeout", "The decision model timed out"],
  ["escalated", "The decision model handed this to you"],
  ["low_confidence", "The decision model was not confident"],
])("review markup preserves the %s explanation without inventing model provenance", (reason, label) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "" } } })
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport: () => { throw new Error("Review rendering must not connect") } })
  try {
    const item: ReviewItemView = {
      itemID: "rvw_failure", kind: "guardrail", reason: reason as ReviewReason,
      sessionID: "ses_a", rootSessionID: "ses_a", sessionTitle: "Fixture review", created: 1,
      action: "write", resources: ["fixture.txt"], ruleIDs: ["standard.review.outside-repository"],
      detail: "Write outside the repository", hardReview: false, directories: ["/fixture"],
    }
    store.container.setState((current) => ({ ...current, activeSessionID: "ses_a",
      view: { ...createSessionView("ses_a"), review: { status: "ready", items: [item] } },
    }))
    const html = renderToString(() => createComponent(RemoteProvider, {
      createStore: () => ({ ...store, load: async () => {} }),
      get children() { return createComponent(ReviewBox, { onOpenSession: () => {} }) },
    }))
    expect(html).toContain(label)
    expect(html).not.toContain("model choice")
    expect(html).not.toContain("confidence")
    expect(html).not.toContain("unreported")
    expect(html).not.toContain("decision-grades")
    expect(html).toContain("Write outside the repository")
    expect(html).toContain("Approve once")
    expect(html).toContain("Always")
    expect(html).toContain("Reject")
  } finally {
    store.dispose()
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
