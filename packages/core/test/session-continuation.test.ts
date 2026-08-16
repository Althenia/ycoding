import { expect } from "bun:test"
import { Effect } from "effect"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { SessionContinuation } from "@ycoding-ai/core/session/runner/continuation"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_continuation")
const fingerprint: SessionContinuation.Fingerprint = {
  sessionID,
  execution: 1,
  routeID: "openai-responses",
  model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("openai"), id: ModelV2.ID.make("gpt-5.6") }),
  promptCacheKey: "cache-key",
  systemDigest: "system-digest",
  toolDigest: "tool-digest",
  optionsDigest: "options-digest",
}

it.effect("selects only stored OpenAI Responses state in an enabled mode", () =>
  Effect.gen(function* () {
    const continuation = yield* SessionContinuation.Service
    const state = { ...fingerprint, responseID: "resp_1", representedMessages: 3 }
    yield* continuation.remember(state)

    expect(yield* continuation.select({ ...fingerprint, mode: "auto", store: true })).toEqual(state)
    expect(yield* continuation.select({ ...fingerprint, mode: "on", store: true })).toEqual(state)
    expect(yield* continuation.select({ ...fingerprint, mode: "off", store: true })).toBeUndefined()

    yield* continuation.remember(state)
    expect(yield* continuation.select({ ...fingerprint, mode: "auto", store: false })).toBeUndefined()

    yield* continuation.remember(state)
    expect(
      yield* continuation.select({ ...fingerprint, routeID: "openai-chat", mode: "on", store: true }),
    ).toBeUndefined()
  }).pipe(Effect.provide(SessionContinuation.layer())),
)

it.effect("keeps Responses continuation available on the ChatGPT Codex backend", () =>
  Effect.gen(function* () {
    const continuation = yield* SessionContinuation.Service
    const codex = {
      ...fingerprint,
      routeID: "openai-codex-responses",
      responseID: "resp_codex",
      representedMessages: 3,
    }
    yield* continuation.remember(codex)

    expect(yield* continuation.select({ ...codex, mode: "auto", store: true })).toEqual(codex)
  }).pipe(Effect.provide(SessionContinuation.layer())),
)

it.effect("clears state after any request fingerprint mismatch", () =>
  Effect.gen(function* () {
    const continuation = yield* SessionContinuation.Service
    const state = { ...fingerprint, responseID: "resp_1", representedMessages: 3 }
    const mismatches: ReadonlyArray<SessionContinuation.Fingerprint> = [
      { ...fingerprint, execution: 2 },
      { ...fingerprint, routeID: "openai-responses-websocket" },
      {
        ...fingerprint,
        model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("openai"), id: ModelV2.ID.make("gpt-5.5") }),
      },
      { ...fingerprint, promptCacheKey: "other-cache" },
      { ...fingerprint, systemDigest: "other-system" },
      { ...fingerprint, toolDigest: "other-tools" },
      { ...fingerprint, optionsDigest: "other-options" },
    ]

    for (const mismatch of mismatches) {
      yield* continuation.remember(state)
      expect(yield* continuation.select({ ...mismatch, mode: "on", store: true })).toBeUndefined()
      expect(yield* continuation.select({ ...fingerprint, mode: "on", store: true })).toBeUndefined()
    }
  }).pipe(Effect.provide(SessionContinuation.layer())),
)

it.effect("clear removes only the selected Session continuation", () =>
  Effect.gen(function* () {
    const continuation = yield* SessionContinuation.Service
    const otherSessionID = SessionSchema.ID.make("ses_continuation_other")
    const first = { ...fingerprint, responseID: "resp_1", representedMessages: 3 }
    const second = {
      ...fingerprint,
      sessionID: otherSessionID,
      responseID: "resp_2",
      representedMessages: 4,
    }
    yield* continuation.remember(first)
    yield* continuation.remember(second)
    yield* continuation.clear(sessionID)

    expect(yield* continuation.select({ ...fingerprint, mode: "on", store: true })).toBeUndefined()
    expect(
      yield* continuation.select({ ...fingerprint, sessionID: otherSessionID, mode: "on", store: true }),
    ).toEqual(second)
  }).pipe(Effect.provide(SessionContinuation.layer())),
)
