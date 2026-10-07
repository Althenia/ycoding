import { expect, test } from "bun:test"
import { encodeLines } from "@toon-format/toon"
import { Result, Schema } from "effect"
import { DecisionJudgment } from "../src/decision-judgment"

const request = {
  state: "A task",
  questions: [{ type: "score", name: "effort", instructions: "Rate", levels: [{ label: "low" }, { label: "high" }] }],
} satisfies typeof DecisionJudgment.Request.Type

test("rejects a judgment score outside the requested rubric", () => {
  const text = Array.from(
    encodeLines({
      decisions: {
        version: 1,
        answers: [{ name: "effort", type: "score", answer: null, choice: null, score: 2, confidence: 0.8 }],
      },
    }),
  ).join("\n")
  const result = DecisionJudgment.parse(text, request)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(DecisionJudgment.InvalidToonError)
})

test("supports the complete routing candidate set plus keep-current without dropping options", () => {
  const choices = [
    { value: "keep-current" },
    ...Array.from({ length: 254 }, (_, index) => ({ value: `route-${index}` })),
  ]
  const request = { state: "Route the first input", questions: [
    { type: "choice", name: "route", instructions: "Choose one route", choices },
  ] } as const
  const document = { decisions: { version: 1, answers: [
    { name: "route", type: "choice", answer: null, choice: "route-253", score: null, confidence: 0.9 },
  ] } } satisfies typeof DecisionJudgment.Document.Type
  expect(DecisionJudgment.parse(DecisionJudgment.encode(document), request)).toEqual(Result.succeed(document))
  expect(Result.isFailure(Schema.decodeUnknownResult(DecisionJudgment.Request)({
    ...request, questions: [{ ...request.questions[0], choices: [...choices, { value: "overflow" }] }],
  }))).toBe(true)
})

const questions = [
  { type: "predicate", name: "safe", instructions: "Is the task safe?" },
  {
    type: "choice",
    name: "方式",
    instructions: "Select a typed choice",
    choices: [{ value: false }, { value: "false" }, { value: "0" }],
  },
  { type: "score", name: "effort", instructions: "Rate effort", levels: [{ label: "low" }, { label: "high" }] },
  { type: "predicate", name: "unknown", instructions: "Judge unsupported evidence" },
] as const satisfies typeof DecisionJudgment.Request.Type.questions
const input = {
  state: { task: "Unicode 日本語", pending: [false, 0] },
  questions,
} satisfies typeof DecisionJudgment.Request.Type
const document = {
  decisions: {
    version: 1,
    answers: [
      { name: "safe", type: "predicate", answer: false, choice: null, score: null, confidence: 0.9 },
      { name: "方式", type: "choice", answer: null, choice: false, score: null, confidence: 1 },
      { name: "effort", type: "score", answer: null, choice: null, score: 0, confidence: 0 },
      { name: "unknown", type: "refusal", answer: null, choice: null, score: null, confidence: 0 },
    ],
  },
} satisfies typeof DecisionJudgment.Document.Type
const wire = `decisions:
  version: 1
  answers[4]{name,type,answer,choice,score,confidence}:
    safe,predicate,false,null,null,0.9
    方式,choice,null,false,null,1
    effort,score,null,null,0,0
    unknown,refusal,null,null,null,0`
const toon = (value: unknown) => Array.from(encodeLines(value)).join("\n")

test("parses literal TOON with Unicode, false, zero score, and explicit refusal", () => {
  const result = DecisionJudgment.parse(wire, input)
  expect(result).toEqual(Result.succeed(document))
  expect(DecisionJudgment.encode(document)).toBe(wire)
})

test("normalizes shuffled answer IDs to caller order without altering judgments", () => {
  const result = DecisionJudgment.parse(
    toon({ decisions: { version: 1, answers: [...document.decisions.answers].reverse() } }),
    input,
  )
  expect(result).toEqual(Result.succeed(document))
})

test("retains quoted string choice values separately from booleans and numbers", () => {
  for (const choice of ["false", "0"]) {
    const expected = {
      decisions: {
        version: 1,
        answers: document.decisions.answers.map((answer) => (answer.name === "方式" ? { ...answer, choice } : answer)),
      },
    } satisfies typeof DecisionJudgment.Document.Type
    const result = DecisionJudgment.parse(DecisionJudgment.encode(expected), input)
    expect(result).toEqual(Result.succeed(expected))
  }
})

test("template supplies only canonical all-refusal shape in caller order", () => {
  const expected = `decisions:
  version: 1
  answers[4]{name,type,answer,choice,score,confidence}:
    safe,refusal,null,null,null,0
    方式,refusal,null,null,null,0
    effort,refusal,null,null,null,0
    unknown,refusal,null,null,null,0`
  expect(DecisionJudgment.template(input)).toBe(expected)
  const result = DecisionJudgment.parse(expected, input)
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result))
    expect(result.success.decisions.answers).toEqual(
      questions.map((question) => ({
        name: question.name,
        type: "refusal",
        answer: null,
        choice: null,
        score: null,
        confidence: 0,
      })),
    )
})

const changed = (name: string, fields: Record<string, unknown>) => ({
  decisions: {
    version: 1,
    answers: document.decisions.answers.map((answer) => (answer.name === name ? { ...answer, ...fields } : answer)),
  },
})

for (const [name, value] of [
  ["wrong ID", changed("safe", { name: "other" })],
  ["duplicate ID", changed("unknown", { name: "safe" })],
  ["wrong question type", changed("safe", { type: "choice", answer: null, choice: "false" })],
  ["null predicate", changed("safe", { answer: null })],
  ["multiple populated fields", changed("safe", { choice: false })],
  ["unexpected choice", changed("方式", { choice: true })],
  ["fractional score", changed("effort", { score: 0.5 })],
  ["negative score", changed("effort", { score: -1 })],
  ["missing field", changed("safe", { confidence: undefined })],
  ["missing record", { decisions: { version: 1, answers: document.decisions.answers.slice(1) } }],
  [
    "extra record",
    {
      decisions: {
        version: 1,
        answers: [...document.decisions.answers, { ...document.decisions.answers[3], name: "extra" }],
      },
    },
  ],
  ["confidence lower bound", changed("safe", { confidence: -0.1 })],
  ["confidence upper bound", changed("safe", { confidence: 1.1 })],
  ["refusal confidence", changed("unknown", { confidence: 0.1 })],
  ["refusal value", changed("unknown", { answer: false })],
  ["extra probability", changed("safe", { probability: 0.9 })],
  ["extra confidence provenance", changed("safe", { confidence_kind: "native-probability" })],
  ["extra root field", { ...document, metadata: "private" }],
  ["extra document field", { decisions: { ...document.decisions, explanation: "private" } }],
  ["wrong version", { decisions: { ...document.decisions, version: 2 } }],
] as const) {
  test(`rejects judgment ${name} with a sanitized error`, () => {
    const result = DecisionJudgment.parse(toon(value), input)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(DecisionJudgment.InvalidToonError)
      expect(result.failure.message).toBe("Invalid decision judgment TOON document")
      expect(Object.keys(result.failure)).not.toContain("cause")
    }
  })
}

for (const [name, text] of [
  ["markdown fence", `\`\`\`toon\n${wire}\n\`\`\``],
  ["leading prose", `Here is my decision:\n${wire}`],
  ["trailing prose", `${wire}\nThe task is safe.`],
  ["JSON document", JSON.stringify(document)],
  ["wrong root", wire.replace("decisions:", "judgments:")],
  ["duplicate root", `${wire}\n${wire}`],
  ["truncated array", wire.split("\n").slice(0, -1).join("\n")],
  ["NaN confidence", wire.replace("null,null,0.9", "null,null,NaN")],
  ["infinite confidence", wire.replace("null,null,0.9", "null,null,Infinity")],
  ["empty output", ""],
] as const) {
  test(`rejects ${name} without fallback or exposed parse causes`, () => {
    const result = DecisionJudgment.parse(text, input)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toBe("Invalid decision judgment TOON document")
  })
}

test("bounds output by UTF-8 bytes rather than character count", () => {
  const choice = "é".repeat(524288)
  const request = {
    state: null,
    questions: [{ type: "choice", name: "selection", instructions: "Select", choices: [{ value: choice }] }],
  } satisfies typeof DecisionJudgment.Request.Type
  const text = toon({
    decisions: {
      version: 1,
      answers: [{ name: "selection", type: "choice", answer: null, choice, score: null, confidence: 1 }],
    },
  })
  expect(text.length).toBeLessThan(1_048_576)
  expect(Buffer.byteLength(text)).toBeGreaterThan(1_048_576)
  expect(Result.isFailure(DecisionJudgment.parse(text, request))).toBe(true)
})

for (const [name, invalid] of [
  ["empty questions", { ...input, questions: [] }],
  ["duplicate names", { ...input, questions: [questions[0], questions[0]] }],
  [
    "too many questions",
    { ...input, questions: Array.from({ length: 33 }, (_, index) => ({ ...questions[0], name: `q${index}` })) },
  ],
  ["empty name", { ...input, questions: [{ ...questions[0], name: "" }] }],
  ["oversized name", { ...input, questions: [{ ...questions[0], name: "n".repeat(65) }] }],
  ["empty instructions", { ...input, questions: [{ ...questions[0], instructions: "" }] }],
  ["oversized instructions", { ...input, questions: [{ ...questions[0], instructions: "i".repeat(8193) }] }],
  ["empty choices", { ...input, questions: [{ ...questions[1], choices: [] }] }],
  [
    "duplicate typed choices",
    { ...input, questions: [{ ...questions[1], choices: [{ value: false }, { value: false }] }] },
  ],
  [
    "too many choices",
    {
      ...input,
      questions: [{ ...questions[1], choices: Array.from({ length: 256 }, (_, index) => ({ value: `c${index}` })) }],
    },
  ],
  ["too few levels", { ...input, questions: [{ ...questions[2], levels: [{ label: "one" }] }] }],
  [
    "too many levels",
    {
      ...input,
      questions: [{ ...questions[2], levels: Array.from({ length: 11 }, (_, index) => ({ label: `l${index}` })) }],
    },
  ],
  ["empty label", { ...input, questions: [{ ...questions[2], levels: [{ label: "" }, { label: "two" }] }] }],
  [
    "oversized label",
    { ...input, questions: [{ ...questions[2], levels: [{ label: "x".repeat(8193) }, { label: "two" }] }] },
  ],
  [
    "empty description",
    { ...input, questions: [{ ...questions[1], choices: [{ value: "option", description: "" }] }] },
  ],
  [
    "oversized description",
    { ...input, questions: [{ ...questions[1], choices: [{ value: "option", description: "d".repeat(8193) }] }] },
  ],
  ["non-JSON state", { ...input, state: { value: Infinity } }],
] as const) {
  test(`rejects request ${name}`, () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(DecisionJudgment.Request)(invalid))).toBe(true)
    expect(Result.isFailure(DecisionJudgment.parse(wire, Object.assign({ ...input }, invalid)))).toBe(true)
  })
}

test("request accepts exact bounds and keeps string/boolean choices distinct", () => {
  const request = {
    state: null,
    questions: [
      {
        type: "choice",
        name: "n".repeat(64),
        instructions: "i".repeat(8192),
        choices: [
          { value: false, description: "d".repeat(8192) },
          { value: "false" },
          ...Array.from({ length: 62 }, (_, index) => ({ value: `c${index}` })),
        ],
      },
      { ...questions[2], levels: Array.from({ length: 10 }, (_, index) => ({ label: `${index}`.padEnd(8192, "l") })) },
      ...Array.from({ length: 30 }, (_, index) => ({ ...questions[0], name: `q${index}` })),
    ],
  } satisfies typeof DecisionJudgment.Request.Type
  expect(Result.isSuccess(Schema.decodeUnknownResult(DecisionJudgment.Request)(request))).toBe(true)
  const result = DecisionJudgment.parse(DecisionJudgment.template(request), request)
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) expect(result.success.decisions.answers).toHaveLength(32)
})
