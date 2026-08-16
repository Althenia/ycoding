import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { Session } from "@ycoding-ai/schema/session"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { testEffect } from "./lib/effect"

const cell = PluginRuntime.makeCell()
const it = testEffect(PluginRuntime.layerWithCell(cell))

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
          cancel: unavailable,
        },
        orchestration: {
          managed: unavailable,
          get: unavailable,
          launch: unavailable,
          list: unavailable,
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
          recover: unavailable(),
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
})
