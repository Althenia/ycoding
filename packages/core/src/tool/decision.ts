export * as DecisionTool from "./decision"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Decision } from "../decision"
import { Permission } from "../permission"
import { Tool } from "./tool"

export const name = "decision"
export const Input = Decision.Input
export const Output = Decision.Output

export const Plugin = {
  id: "ycoding.tool.decision",
  effect: Effect.fn("DecisionTool.Plugin")(function* (ctx: PluginContext) {
    const decisions = yield* Decision.Service
    const permission = yield* Permission.Service
    yield* ctx.tool.transform((draft) => draft.add(name, Tool.make({
      description: "Evaluate bounded questions with OpenAI Decisions or TypeSafe Jev. Send provider and its native request: OpenAI uses gpt-6-luna, input, and an ordered questions array of predicate, choice, or score; TypeSafe uses model, state, and named questions of noul, choice, or score. Return native answers, probabilities, confidence, refusals, and reported token usage. These are judgments, never permission approval or verification that a goal is complete. Only send information authorized for the selected external provider.",
      input: Input,
      output: Output,
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
      execute: (input, context) => permission.assert({
        action: name, resources: [input.provider], save: [input.provider],
        sessionID: context.sessionID, agent: context.agent,
        source: { type: "tool", messageID: context.messageID, callID: context.callID },
      }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: "Decision request is not permitted", error })),
        Effect.andThen(decisions.evaluate(input, { sessionID: context.sessionID, agent: context.agent }).pipe(
          Effect.mapError((error) => new ToolFailure({ message: error.message })),
        )),
      ),
    }), { codemode: false }))
  }),
}
