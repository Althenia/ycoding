import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@ycoding-ai/schema/session"
import { ListAnchor } from "@ycoding-ai/schema/session-orchestration"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { testEffect } from "./lib/effect"

const cell = PluginRuntime.makeCell()
const it = testEffect(PluginRuntime.layerWithCell(cell))

describe("PluginRuntime", () => {
  it.effect("forwards bounded orchestration pages through its cell", () =>
    Effect.gen(function* () {
      const unavailable = () => Effect.die(new Error("unused"))
      const expected = {
        data: [],
        summary: { total: 11, active: 4, running: 2, waiting: 1 },
        cursor: {
          next: ListAnchor.make({
            rank: 4,
            updated: 1,
            sessionID: Session.ID.make("ses_child"),
            direction: "next",
          }),
        },
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
          page: () => Effect.succeed(expected),
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
      expect(yield* runtime.orchestration.page({ parentID: Session.ID.make("ses_parent") })).toBe(expected)
    }),
  )
})
