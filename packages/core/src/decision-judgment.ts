export * as DecisionJudgment from "./decision-judgment"

import { decode, encodeLines } from "@toon-format/toon"
import { Result, Schema } from "effect"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192))
const ChoiceValue = Schema.Union([Schema.String, Schema.Boolean])

export const Request = Schema.Struct({
  state: Schema.Json,
  questions: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("predicate"), name: Name, instructions: Text }),
      Schema.Struct({
        type: Schema.Literal("choice"),
        name: Name,
        instructions: Text,
        choices: Schema.Array(Schema.Struct({ value: ChoiceValue, description: Schema.optional(Text) })).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(255),
          Schema.makeFilter((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length),
        ),
      }),
      Schema.Struct({
        type: Schema.Literal("score"),
        name: Name,
        instructions: Text,
        levels: Schema.Array(Schema.Struct({ label: Text, description: Schema.optional(Text) })).check(
          Schema.isMinLength(2),
          Schema.isMaxLength(10),
        ),
      }),
    ]),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
    Schema.makeFilter((questions) => new Set(questions.map((question) => question.name)).size === questions.length),
  ),
})

export const Document = Schema.Struct({
  decisions: Schema.Struct({
    version: Schema.Literal(1),
    answers: Schema.Array(
      Schema.Struct({
        name: Name,
        type: Schema.Literals(["predicate", "choice", "score", "refusal"]),
        answer: Schema.NullOr(Schema.Boolean),
        choice: Schema.NullOr(ChoiceValue),
        score: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        confidence: Schema.Number.check(
          Schema.makeFilter(Number.isFinite),
          Schema.isBetween({ minimum: 0, maximum: 1 }),
        ),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  }),
})

export class InvalidToonError extends Schema.TaggedErrorClass<InvalidToonError>()(
  "DecisionJudgment.InvalidToonError",
  {},
) {
  override get message() {
    return "Invalid decision judgment TOON document"
  }
}

export function parse(
  text: string,
  request: typeof Request.Type,
): Result.Result<typeof Document.Type, InvalidToonError> {
  if (Buffer.byteLength(text, "utf8") > 1_048_576) return Result.fail(new InvalidToonError({}))
  const input = Schema.decodeUnknownResult(Request)(request, { onExcessProperty: "error" })
  if (Result.isFailure(input)) return Result.fail(new InvalidToonError({}))
  const decoded = Result.try({ try: () => decode(text, { strict: true }), catch: () => new InvalidToonError({}) })
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  const document = Schema.decodeUnknownResult(Document)(decoded.success, { onExcessProperty: "error" }).pipe(
    Result.mapError(() => new InvalidToonError({})),
  )
  if (Result.isFailure(document)) return document
  const answers = new Map(document.success.decisions.answers.map((answer) => [answer.name, answer]))
  if (answers.size !== document.success.decisions.answers.length || answers.size !== input.success.questions.length)
    return Result.fail(new InvalidToonError({}))
  const ordered = input.success.questions.map((question) => answers.get(question.name))
  if (!ordered.every((answer, index) => matchesQuestion(answer, input.success.questions[index])))
    return Result.fail(new InvalidToonError({}))
  return Result.succeed({ decisions: { version: 1, answers: ordered.filter((answer) => answer !== undefined) } })
}

export function encode(document: typeof Document.Type): string {
  return Array.from(
    encodeLines({
      decisions: {
        version: document.decisions.version,
        answers: document.decisions.answers.map((answer) => ({
          name: answer.name,
          type: answer.type,
          answer: answer.answer,
          choice: answer.choice,
          score: answer.score,
          confidence: answer.confidence,
        })),
      },
    }),
  ).join("\n")
}

export function template(request: typeof Request.Type): string {
  return encode({
    decisions: {
      version: 1,
      answers: request.questions.map((question) => ({
        name: question.name,
        type: "refusal",
        answer: null,
        choice: null,
        score: null,
        confidence: 0,
      })),
    },
  })
}

function matchesQuestion(
  answer: (typeof Document.Type.decisions.answers)[number] | undefined,
  question: (typeof Request.Type.questions)[number],
) {
  if (!answer) return false
  if (answer.type === "refusal")
    return answer.answer === null && answer.choice === null && answer.score === null && answer.confidence === 0
  if (answer.type !== question.type) return false
  if (question.type === "predicate") return answer.answer !== null && answer.choice === null && answer.score === null
  if (question.type === "choice")
    return (
      answer.answer === null &&
      answer.score === null &&
      answer.choice !== null &&
      question.choices.some((choice) => choice.value === answer.choice)
    )
  return (
    answer.answer === null && answer.choice === null && answer.score !== null && answer.score < question.levels.length
  )
}
