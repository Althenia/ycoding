export * as DecisionTool from "./decision"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { encode } from "@toon-format/toon"
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
      description: "Evaluate bounded questions with provider agent, openai, or typesafe. Agent uses the configured hidden decision helper and selected model: send JSON state and ordered named predicate/choice/score questions; choices use value/description and levels use label/description. Agent returns validated TOON judgments with uncalibrated confidence estimates, not native probabilities. OpenAI uses gpt-6-luna, input, and ordered native questions; TypeSafe uses model, state, and named noul/choice/score questions. Native APIs return their native JSON answers and probabilities. Automatic agent policies require explicit min_confidence; native policies use min_probability. These are judgments, never permission approval or completion proof. Only send evidence authorized for the selected model or external provider.",
      input: Input,
      output: Output,
      toModelOutput: ({ output }) => [{ type: "text", text: output.provider === "agent" ? encode(output) : JSON.stringify(output) }],
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
