import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { foldRecallEvents } from "../../../../../packages/client/src/cue-recall"
import { foldLifecycleEvents } from "../../../../../packages/client/src/lifecycle"
import { LifecycleBody, LifecycleEntryView, RecallBody, RecallEntryView } from "./recall-entry"

const injected = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: "memory",
  id,
  stage: "injected",
  method: "rrf",
  scores: { bm25: 1.5, semantic: 0.25, rrf: 0.03, rank: 0 },
  reason: "matched cue",
  source: { id: `memory:repository/${id}`, revision: "sha256:abc" },
  okf: { type: "Decision", trust: "trusted", freshness: "fresh", lifecycle: "active" },
  ...extra,
})
const entry = foldRecallEvents([
  { type: "session.cue.detected", id: "evt_c", created: 15, data: { sessionID: "ses_a", cueID: "c1", kind: "command", subject: "cargo build" } },
  { type: "session.recall.recorded", id: "recall_1", created: 20, data: { sessionID: "ses_a", key: "k1", trigger: "cue", cueID: "c1", methods: ["cue", "rrf"], outcome: "injected", elapsedMs: 18, injectedTokens: 340, items: [injected("build/linker"), injected("old/note", { stage: "rejected", rejection: "stale" })] } },
]).entries[0]!

test("collapsed entry exposes the summary, elapsed time and injected tokens in one disclosure button", () => {
  const html = renderToString(() => <RecallEntryView entry={entry} />)
  expect(html).toContain('aria-label="Recalled 1 memory · 18 ms · ~340 tokens"')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain("18 ms · ~340 tokens")
  expect(html).not.toContain("matched cue terms")
  expect(html).toContain('aria-hidden="true"')
})

test("expanded body lists cue, method, relevance, provenance, trust, freshness and lifecycle; rejections stay folded", () => {
  const html = renderToString(() => <RecallBody entry={entry} onInspect={() => undefined} />)
  for (const text of ["command · cargo build", "cue, rrf", "bm25 1.5 · semantic 0.25 · rrf 0.03 · rank 1", "memory:repository/build/linker @ sha256:abc", "trusted", "fresh", "active", "Inspect"]) expect(html).toContain(text)
  expect(html).toContain("1 not injected · 2 candidates · 1 selected · 1 injected")
  expect(html).toContain('aria-expanded="false"')
})

const lifecycle = foldLifecycleEvents([{ type: "session.lifecycle.recorded", id: "lc_1", created: 5, data: { sessionID: "ses_a", step: 3, decision: "recover", basis: "silent", recovery: true, recalled: false } }]).entries[0]!

test("lifecycle entry renders collapsed from the record and lists its details", () => {
  const html = renderToString(() => <LifecycleEntryView entry={lifecycle} />)
  expect(html).toContain('aria-label="Retried for a reply · step 3 · no reply"')
  expect(html).toContain('aria-expanded="false"')
  const body = renderToString(() => <LifecycleBody entry={lifecycle} />)
  for (const text of ["recovery step", "no reply", "recover"]) expect(body).toContain(text)
})
