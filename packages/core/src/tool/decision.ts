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
      description: "Get bounded judgments from provider agent, openai, or typesafe. Use it to choose a sufficient model and exact verified variant from finite candidates, guide task direction, choose the narrowest available tool from its actual description and schema, classify, grade candidates against a rubric, check a predicate you cannot verify deterministically, or recommend an option before asking the user. Send self-contained evidence and constraints, batch independent questions in one request, reuse settled judgments until evidence changes, and do not classify every model step. Advice never changes an owner's explicit model/agent choice or executes a tool. Agent uses the configured hidden decision helper and selected model: send JSON state and ordered named predicate/choice/score questions; choices use value/description and levels use label/description. Agent returns validated TOON judgments whose confidence is an uncalibrated model estimate, not a native probability. OpenAI uses gpt-6-luna, input, and ordered native questions; TypeSafe uses model, state, and named noul/choice/score questions; both return native JSON answers with probabilities. Treat refusals, low or close scores, and errors as uncertainty. Automatic agent policies require explicit min_confidence; native policies use min_probability. These are judgments, never permission approval, the user's answer, or completion proof. Only send evidence authorized for the selected model or external provider.",
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
