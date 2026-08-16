import { describe, expect, test } from "bun:test"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { ConversationCompactTool } from "@ycoding-ai/core/tool/conversation-compact"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { Effect, Exit } from "effect"

const context = {
  sessionID: SessionSchema.ID.make("ses_conversation_compact"),
  agent: AgentV2.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_conversation_compact"),
  callID: "call-conversation-compact",
  progress: () => Effect.void,
}

const enabled = ConfigCompaction.resolve([
  new ConfigCompaction.Info({ advisory: { consider_percent: 65, strongly_advised_percent: 85 } }),
])

const settle = (tool: Tool.AnyTool, input: unknown) => Tool.settle(tool, { input }, context)

describe("conversation_compact", () => {
  test("advertises a JSON object input schema", () => {
    const definition = Tool.definition(
      "conversation_compact",
      ConversationCompactTool.make({
        policy: enabled,
        pressure: () => undefined,
        compact: () => Effect.die("must not run"),
      }),
    )
    expect(definition.inputSchema.type).toBe("object")
    expect(definition.inputSchema.anyOf).toBeUndefined()
  })

  test("rejects the removed boundary_message_id input", async () => {
    const exit = await Effect.runPromiseExit(
      settle(
        ConversationCompactTool.make({
          policy: enabled,
          pressure: () => "consider",
          compact: () => Effect.die("must not admit invalid input"),
        }),
        { boundary_message_id: "msg_old_boundary" },
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("conversation_compact accepts no input fields")
  })

  test("returns disabled before reading pressure or admitting work when advisory is false", async () => {
    let admitted = 0
    const result = await Effect.runPromise(
      settle(
        ConversationCompactTool.make({
          policy: ConfigCompaction.resolve([new ConfigCompaction.Info({ advisory: false })]),
          pressure: () => {
            throw new Error("pressure must not be read")
          },
          compact: () =>
            Effect.sync(() => {
              admitted += 1
              return { id: SessionCompaction.ID.make("cmp_disabled") }
            }),
        }),
        {},
      ),
    )

    expect(result.structured).toEqual({ status: "disabled" })
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ status: "disabled" }) }])
    expect(admitted).toBe(0)
  })

  for (const trigger of ["consider", "advised"] as const) {
    test(`admits the current ${trigger} trigger and returns without waiting`, async () => {
      const calls: Array<{ readonly sessionID: SessionSchema.ID; readonly trigger: typeof trigger }> = []
      let backgroundFinished = false
      const jobID = SessionCompaction.ID.make(`cmp_${trigger}`)
      const result = await Effect.runPromise(
        settle(
          ConversationCompactTool.make({
            policy: enabled,
            pressure: () => trigger,
            compact: (input) =>
              Effect.gen(function* () {
                calls.push(input)
                yield* Effect.never.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      backgroundFinished = true
                    }),
                  ),
                  Effect.forkChild,
                )
                return { id: jobID }
              }),
          }),
          {},
        ),
      )

      expect(calls).toEqual([{ sessionID: context.sessionID, trigger }])
      expect(result.structured).toEqual({ jobID, status: "scheduled" })
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ jobID, status: "scheduled" }) }])
      expect(backgroundFinished).toBe(false)
    })
  }

  test("returns disabled when no current soft-pressure advisor exists", async () => {
    const result = await Effect.runPromise(
      settle(
        ConversationCompactTool.make({
          policy: enabled,
          pressure: () => "mandatory",
          compact: () => Effect.die("must not admit mandatory work from the advisory tool"),
        }),
        {},
      ),
    )

    expect(result.structured).toEqual({ status: "disabled" })
  })
})
