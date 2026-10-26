export * as QuestionTool from "./question"

import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { ToolFailure } from "@ycoding-ai/ai"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { Effect, Schema } from "effect"
import { Form } from "../form"
import { Permission } from "../permission"
import { Hash } from "../util/hash"
import { Question } from "../question"
import { Tool } from "./tool"

export const name = "question"

export const description = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

When progress requires user input, a decision, or review, call this tool instead of ending with a prose-only request. Include the blocker and the minimum actionable question, then continue after the reply. Do not use task_complete while blocked. Keep permission and guardrail approvals on their native request paths.

Usage notes:
- For required free-text input, use an empty options array
- When \`custom\` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set \`multiple: true\` to allow selecting more than one
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
- Recommend the option that best matches the user's stated requirements and expectations; do not introduce new solutions or problems in the recommendation
- Make each question and option description self-contained`

export const Input = Schema.Struct({
  questions: Schema.NonEmptyArray(Question.Prompt).annotate({ description: "Questions to ask" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(Question.Answer),
  automatic: Schema.Literal(true).pipe(Schema.optional),
  via: Schema.Literals(["auto-answer", "yolo"]).pipe(Schema.optional),
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.optional),
  assessment: Form.Assessment.pipe(Schema.optional),
  source: Form.ReplySource.pipe(Schema.optional),
  timedOutAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
  deferredItemID: SessionReview.ID.pipe(Schema.optional),
  reviewFull: Schema.Literal(true).pipe(Schema.optional),
})
export type Output = typeof Output.Type

export class CancelledError extends Schema.TaggedErrorClass<CancelledError>()("QuestionTool.CancelledError", {}) {
  override get message() {
    return "This question was dismissed or superseded without an answer"
  }
}

export const toModelOutput = (
  questions: ReadonlyArray<Question.Prompt>,
  answers: ReadonlyArray<Question.Answer>,
  timedOutAfterSeconds?: number,
  deferredItemID?: string,
  reviewFull?: boolean,
  automatic?: true,
  source?: typeof Form.ReplySource.Encoded,
) => {
  if (reviewFull)
    return "The user's review box is full, so this question was not recorded. Do not guess an answer; continue independent work and stop when only blocked work remains."
  if (deferredItemID !== undefined)
    return `The user is asleep. These questions were added to the user's review box as item ${deferredItemID}; the answer will arrive later as a user message. Do not guess the answer or act as if it were given. Continue with work that does not depend on it; if nothing else remains, summarize what waits on the user and stop.`
  if (timedOutAfterSeconds !== undefined)
    return "These questions closed without an answer. Obtain the required answer before continuing dependent work."
  const formatted = questions.map((question, index) =>
    `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
  ).join(", ")
  if (source?.kind === "dots-delegation")
    return `The delegated external client answered these questions under a native-approved Dots delegation, not the user: ${formatted}. These answers grant no permission, consent, or human-only approval.`
  if (source?.kind === "coordinator")
    return `The native coordinator answered these questions${source.via === "yolo" ? " through the Answers YOLO evaluator" : source.via === "auto-answer" ? " using deterministic Auto rules" : ""}, not the user: ${formatted}. These answers grant no permission, consent, or human-only approval.`
  if (automatic)
    return `Answers were selected automatically, not provided or approved by the user: ${formatted}. Continue independent work within the authorized scope and follow the active goal when one exists. Do not reopen routine choices or treat an automatic selection to wait as a new user instruction or authorization constraint. Permissions, guardrails, and explicit human-only approvals still apply.`
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export const Plugin = {
  id: "ycoding.tool.question",
  effect: Effect.fn("QuestionTool.Plugin")(function* (ctx: PluginContext) {
    const forms = yield* Form.Service
    const permission = yield* Permission.Service
    yield* ctx.tool.transform((draft) => draft.add(name, Tool.make({
      description,
      input: Input,
      output: Output,
      toModelOutput: ({ input, output }) => [{ type: "text", text: toModelOutput(input.questions, output.answers, output.timedOutAfterSeconds, output.deferredItemID, output.reviewFull, output.automatic, output.source) }],
      execute: (input, context) => permission.assert({
        action: "question", resources: ["*"], sessionID: context.sessionID, agent: context.agent,
        metadata: { operationDigest: Hash.json(input) },
        source: { type: "tool", messageID: context.messageID, callID: context.callID },
      }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })),
        Effect.andThen(forms.ask({
          sessionID: context.sessionID,
          title: "Questions",
          metadata: { kind: "question", tool: { messageID: context.messageID, callID: context.callID } },
          fields: [toField(input.questions[0], 0), ...input.questions.slice(1).map((question, index) => toField(question, index + 1))],
        }).pipe(
          Effect.catchTag("SessionReview.FullError", () =>
            Effect.succeed({ status: "full" as const }),
          ),
          Effect.orDie,
          Effect.flatMap((state): Effect.Effect<Output> => {
            if (state.status === "full")
              return Effect.succeed({ answers: input.questions.map((): Question.Answer => []), reviewFull: true as const })
            if (state.status === "deferred")
              return Effect.succeed({ answers: input.questions.map((): Question.Answer => []), deferredItemID: state.itemID, ...(state.assessment === undefined ? {} : { assessment: state.assessment }) })
            if (state.status === "cancelled" || state.status === "timed_out") return Effect.die(new CancelledError())
            return Effect.succeed({ answers: input.questions.map((_, index): Question.Answer => {
              const value = state.answer[`q${index}`]
              if (value === undefined) return []
              if (typeof value === "object") return Array.from(value)
              return [String(value)]
            }), ...(state.automatic ? { automatic: true as const } : {}), ...(state.automatic && state.via ? { via: state.via } : {}), ...(state.automatic && state.confidence !== undefined ? { confidence: state.confidence } : {}), ...(state.assessment === undefined ? {} : { assessment: state.assessment }), ...(state.source === undefined ? {} : { source: state.source }) })
          }),
        )),
      ),
    }), { codemode: false })).pipe(Effect.orDie)
  }),
}

function toField(question: Question.Prompt, index: number): Form.Field {
  return {
    key: `q${index}`, title: question.header, description: question.question,
    type: question.multiple === true ? "multiselect" : "string",
    options: question.options.map((option) => ({ value: option.label, label: option.label, description: option.description })),
    custom: question.custom ?? true,
    ...(question.options.length === 0 ? { required: true } : {}),
  }
}
