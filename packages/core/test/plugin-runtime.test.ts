import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { Session } from "@ycoding-ai/schema/session"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { testEffect } from "./lib/effect"

const cell = PluginRuntime.makeCell()
const it = testEffect(PluginRuntime.layerWithCell(cell))
const unboundIt = testEffect(PluginRuntime.layerWithCell(PluginRuntime.makeCell()))

describe("PluginRuntime", () => {
  it.effect("forwards an advisor compaction admission through its cell", () =>
    Effect.gen(function* () {
      const unavailable = () => Effect.die(new Error("unused"))
      const expected = {
        id: SessionCompaction.ID.make("cmp_plugin_runtime"),
        sessionID: Session.ID.make("ses_parent"),
        trigger: "advised" as const,
        status: "pending" as const,
        requestedThrough: { messageID: SessionMessage.ID.make("msg_boundary"), seq: 1 },
        timeCreated: DateTime.makeUnsafe(0),
      }
      cell.runtime = {
        session: {
          get: unavailable,
          create: unavailable,
          messages: unavailable,
          prompt: unavailable,
          generate: unavailable,
          command: unavailable,
          resume: unavailable,
          interrupt: unavailable,
          synthetic: unavailable,
          compact: (() => Effect.succeed(expected)) as unknown as PluginRuntime.Interface["session"]["compact"],
        },
        job: {
          start: unavailable,
          wait: unavailable,
          block: unavailable,
          background: unavailable,
          noticeAdmitted: unavailable,
          cancel: unavailable,
        },
        orchestration: {
          managed: unavailable,
          get: unavailable,
          launch: unavailable,
          switchModel: unavailable,
          list: unavailable,
          questionSnapshots: unavailable,
          reconsiderQuestion: unavailable,
          page: unavailable,
          send: unavailable,
          answer: unavailable,
          cancel: unavailable,
          resume: unavailable,
          progress: unavailable,
          question: unavailable,
          settle: unavailable,
          background: unavailable,
          teamView: unavailable,
          notice: unavailable,
          recover: unavailable(),
          resolveRecovery: unavailable,
        },
        location: { agent: { list: unavailable } },
      }

      const runtime = yield* PluginRuntime.Service
      expect(
        yield* runtime.session.compact({
          sessionID: Session.ID.make("ses_parent"),
          trigger: "advised",
        }),
      ).toBe(expected)
    }),
  )

  unboundIt.effect("denies restart recovery decisions without reaching the runtime", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.Service
      const error = yield* runtime.orchestration
        .resolveRecovery({
          childID: Session.ID.make("ses_child"),
          itemID: SessionReview.ID.create(),
          choice: "stop",
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionOrchestration.ConflictError)
    }),
  )

  unboundIt.effect("denies private decision snapshots without reaching the runtime", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.Service
      const result = yield* runtime.orchestration.questionSnapshots(Session.ID.make("ses_parent")).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.cause.toString()).toContain("Question snapshots require an authenticated device operation")
    }),
  )

  unboundIt.effect("denies native question reconsideration without reaching the runtime", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.Service
      const result = yield* runtime.orchestration
        .reconsiderQuestion({
          parentID: Session.ID.make("ses_parent"),
          childID: Session.ID.make("ses_child"),
          questionID: QuestionID.make("qst_pending"),
          fingerprint: "f".repeat(64),
          actor: "coordinator",
          source: { coordinatorSessionID: Session.ID.make("ses_parent"), rationale: "Synthetic routine answer." },
          validate: () => Effect.succeed(true),
        })
        .pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.cause.toString()).toContain("Question reconsideration requires the native goal decision loop")
    }),
  )

  unboundIt.effect("denies caller-supplied Dots decision capabilities without reaching the runtime", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.Service
      const error = yield* runtime.orchestration.answer({
        parentID: Session.ID.make("ses_parent"), childID: Session.ID.make("ses_child"),
        questionID: QuestionID.make("qst_pending"), text: "Continue",
        dots: {
          explicitDecision: true, fingerprint: "f".repeat(64), validate: () => Effect.succeed(true),
          source: { kind: "dots-client", anchorSessionID: Session.ID.make("ses_parent"), bindingID: "binding",
            delegationID: "grant", revision: 1, exchangeID: "exchange",
            principal: { ownerID: "owner", deviceID: "device", clientID: "client", grantID: "oauth-grant", epoch: "epoch" } },
        },
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionOrchestration.ConflictError)
    }),
  )
})
