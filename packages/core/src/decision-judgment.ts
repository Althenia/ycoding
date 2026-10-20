export * as DecisionJudgment from "./decision-judgment"

import { Result, Schema } from "effect"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192))
const ChoiceValue = Schema.Union([Schema.String.check(Schema.isPattern(/\S/)), Schema.Boolean])
export const TextMaxLength = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 }))
export const DefaultTextMaxLength = 8192

export const Request = Schema.Struct({
  state: Schema.Json,
  questions: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("predicate"), name: Name, instructions: Text }),
      Schema.Struct({
        type: Schema.Literal("choice"),
        name: Name,
        instructions: Text,
        grade: Schema.Boolean.pipe(Schema.optional),
        choices: Schema.Array(Schema.Struct({ value: ChoiceValue, description: Schema.optional(Text) })).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(255),
          Schema.makeFilter((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length, { expected: "unique string or Boolean choice values" }),
        ),
      }),
      Schema.Struct({
        type: Schema.Literal("score"),
        name: Name,
        instructions: Text,
        levels: Schema.Array(Schema.Struct({ label: Text, description: Schema.optional(Text) })).check(
          Schema.isMinLength(2),
          Schema.isMaxLength(10),
          Schema.makeFilter((levels) => new Set(levels.map((level) => level.label)).size === levels.length, { expected: "unique score level labels" }),
        ),
      }),
      Schema.Struct({
        type: Schema.Literal("text"),
        name: Name,
        instructions: Text,
        maxLength: TextMaxLength.pipe(Schema.optional),
      }),
    ]),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
    Schema.makeFilter((questions) => new Set(questions.map((question) => question.name)).size === questions.length, { expected: "unique question names" }),
  ),
})

export const Document = Schema.Struct({
  decisions: Schema.Struct({
    version: Schema.Literal(1),
    answers: Schema.Array(
      Schema.Struct({
        name: Name,
        type: Schema.Literals(["predicate", "choice", "score", "text", "refusal"]),
        answer: Schema.NullOr(Schema.Boolean),
        choice: Schema.NullOr(ChoiceValue),
        score: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        text: Schema.NullOr(Schema.String).pipe(Schema.optional),
        confidence: Schema.Number.check(
          Schema.makeFilter(Number.isFinite),
          Schema.isBetween({ minimum: 0, maximum: 1 }),
        ),
        grades: Schema.Array(Schema.Struct({
          choice: ChoiceValue,
          confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
          evidence: Schema.String.check(Schema.isMaxLength(500), Schema.isPattern(/\S/)),
        })).check(Schema.isMinLength(1), Schema.isMaxLength(255)).pipe(Schema.optional),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  }),
})

export class InvalidResponseError extends Schema.TaggedErrorClass<InvalidResponseError>()(
  "DecisionJudgment.InvalidResponseError",
  {},
) {
  override get message() {
    return "Invalid decision judgment JSON document"
  }
}

export function parse(
  text: string,
  request: typeof Request.Type,
): Result.Result<typeof Document.Type, InvalidResponseError> {
  if (Buffer.byteLength(text, "utf8") > 1_048_576) return Result.fail(new InvalidResponseError({}))
  const decoded = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(text)
  if (Result.isFailure(decoded)) return Result.fail(new InvalidResponseError({}))
  return validate(decoded.success, request)
}

export function validate(
  value: unknown,
  request: typeof Request.Type,
): Result.Result<typeof Document.Type, InvalidResponseError> {
  const input = Schema.decodeUnknownResult(Request)(request, { onExcessProperty: "error" })
  if (Result.isFailure(input)) return Result.fail(new InvalidResponseError({}))
  const document = Schema.decodeUnknownResult(Document)(value, { onExcessProperty: "error" }).pipe(
    Result.mapError(() => new InvalidResponseError({})),
  )
  if (Result.isFailure(document)) return document
  const answers = new Map(document.success.decisions.answers.map((answer) => [answer.name, answer]))
  if (answers.size !== document.success.decisions.answers.length || answers.size !== input.success.questions.length)
    return Result.fail(new InvalidResponseError({}))
  const ordered = input.success.questions.map((question) => answers.get(question.name))
  if (!ordered.every((answer, index) => matchesQuestion(answer, input.success.questions[index])))
    return Result.fail(new InvalidResponseError({}))
  return Result.succeed({ decisions: { version: 1, answers: ordered.filter((answer) => answer !== undefined) } })
}

export function encode(document: typeof Document.Type): string {
  return JSON.stringify({
    decisions: {
      version: document.decisions.version,
      answers: document.decisions.answers.map((answer) => ({
        name: answer.name,
        type: answer.type,
        answer: answer.answer,
        choice: answer.choice,
        score: answer.score,
        ...(answer.text === undefined ? {} : { text: answer.text }),
        confidence: answer.confidence,
        ...(answer.grades === undefined ? {} : { grades: answer.grades }),
      })),
    },
  })
}

export function responseSchema(request: typeof Request.Type): Record<string, unknown> {
  return objectSchema({
    decisions: objectSchema({
      version: { type: "integer", enum: [1] },
      answers: {
        type: "array",
        minItems: 1,
        items: { anyOf: request.questions.flatMap((question) => [answerBranch(question), refusalBranch(question)]) },
      },
    }),
  })
}

type Question = (typeof Request.Type.questions)[number]

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false }
}

function answerBranch(question: Question): Record<string, unknown> {
  if (question.type === "predicate")
    return objectSchema({
      name: { type: "string", enum: [question.name] },
      type: { type: "string", enum: ["predicate"] },
      answer: { type: "boolean" },
      choice: { type: "null" },
      score: { type: "null" },
      text: { type: "null" },
      confidence: { type: "number" },
    })
  if (question.type === "text")
    return objectSchema({
      name: { type: "string", enum: [question.name] },
      type: { type: "string", enum: ["text"] },
      answer: { type: "null" },
      choice: { type: "null" },
      score: { type: "null" },
      text: { type: "string" },
      confidence: { type: "number" },
    })
  if (question.type === "score")
    return objectSchema({
      name: { type: "string", enum: [question.name] },
      type: { type: "string", enum: ["score"] },
      answer: { type: "null" },
      choice: { type: "null" },
      score: { type: "integer" },
      text: { type: "null" },
      confidence: { type: "number" },
    })
  if (question.grade === true)
    return objectSchema({
      name: { type: "string", enum: [question.name] },
      type: { type: "string", enum: ["choice"] },
      answer: { type: "null" },
      choice: { type: "null" },
      score: { type: "null" },
      text: { type: "null" },
      confidence: { type: "number", enum: [0] },
      grades: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          choice: { enum: question.choices.map((choice) => choice.value) },
          confidence: { type: "number" },
          evidence: { type: "string" },
        }),
      },
    })
  return objectSchema({
    name: { type: "string", enum: [question.name] },
    type: { type: "string", enum: ["choice"] },
    answer: { type: "null" },
    choice: { enum: question.choices.map((choice) => choice.value) },
    score: { type: "null" },
    text: { type: "null" },
    confidence: { type: "number" },
  })
}

function refusalBranch(question: Question): Record<string, unknown> {
  return objectSchema({
    name: { type: "string", enum: [question.name] },
    type: { type: "string", enum: ["refusal"] },
    answer: { type: "null" },
    choice: { type: "null" },
    score: { type: "null" },
    text: { type: "null" },
    confidence: { type: "number", enum: [0] },
  })
}

function matchesQuestion(
  answer: (typeof Document.Type.decisions.answers)[number] | undefined,
  question: (typeof Request.Type.questions)[number],
) {
  if (!answer) return false
  if (answer.type === "refusal")
    return answer.answer === null && answer.choice === null && answer.score === null && (answer.text === undefined || answer.text === null) && answer.confidence === 0 && answer.grades === undefined
  if (answer.type !== question.type) return false
  if (question.type === "text")
    return answer.answer === null && answer.choice === null && answer.score === null && answer.grades === undefined &&
      typeof answer.text === "string" && answer.text.trim().length > 0 && answer.text.length <= (question.maxLength ?? DefaultTextMaxLength)
  if (answer.text !== undefined && answer.text !== null) return false
  if (question.type === "choice" && question.grade === true)
    return answer.answer === null && answer.choice === null && answer.score === null && answer.confidence === 0 &&
      answer.grades !== undefined && answer.grades.length === question.choices.length &&
      new Set(answer.grades.map((grade) => grade.choice)).size === question.choices.length &&
      answer.grades.every((grade) => question.choices.some((choice) => choice.value === grade.choice))
  if (answer.grades !== undefined) return false
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
