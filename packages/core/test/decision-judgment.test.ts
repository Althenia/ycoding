import { expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { DecisionJudgment } from "../src/decision-judgment"

const request = {
  state: "A task",
  questions: [{ type: "score", name: "effort", instructions: "Rate", levels: [{ label: "low" }, { label: "high" }] }],
} satisfies typeof DecisionJudgment.Request.Type

test("rejects a judgment score outside the requested rubric", () => {
  const text = JSON.stringify({
    decisions: {
      version: 1,
      answers: [{ name: "effort", type: "score", answer: null, choice: null, score: 2, confidence: 0.8 }],
    },
  })
  const result = DecisionJudgment.parse(text, request)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(DecisionJudgment.InvalidResponseError)
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
const wire =
  `{"decisions":{"version":1,"answers":[` +
  `{"name":"safe","type":"predicate","answer":false,"choice":null,"score":null,"confidence":0.9},` +
  `{"name":"方式","type":"choice","answer":null,"choice":false,"score":null,"confidence":1},` +
  `{"name":"effort","type":"score","answer":null,"choice":null,"score":0,"confidence":0},` +
  `{"name":"unknown","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}` +
  `]}}`
const toonWire = `decisions:
  version: 1
  answers[4]{name,type,answer,choice,score,confidence}:
    safe,predicate,false,null,null,0.9
    方式,choice,null,false,null,1
    effort,score,null,null,0,0
    unknown,refusal,null,null,null,0`
const json = (value: unknown) => JSON.stringify(value)

test("graded choices require exactly one bounded evidence grade per typed choice and no pick", () => {
  const question = { type: "choice", name: "grade", instructions: "Grade each alternative", grade: true,
    choices: [{ value: false }, { value: "false" }] } as const
  const request = { state: null, questions: [question] }
  const grades = [{ choice: false, confidence: 0, evidence: "Unsupported" }, { choice: "false", confidence: 1, evidence: "e".repeat(500) }]
  const answer = { name: "grade", type: "choice", answer: null, choice: null, score: null, confidence: 0, grades } as const
  const document = { decisions: { version: 1, answers: [answer] } } as const
  expect(DecisionJudgment.parse(json(document), request)).toEqual(Result.succeed(document))
  expect(DecisionJudgment.validate(document, request)).toEqual(Result.succeed(document))
  for (const invalid of [
    { ...answer, choice: false }, { ...answer, confidence: 0.8 }, { ...answer, grades: undefined },
    { ...answer, grades: grades.slice(1) }, { ...answer, grades: [grades[0], grades[0]] },
    { ...answer, grades: [...grades, { choice: "extra", confidence: 0.9, evidence: "Extra" }] },
    ...[-0.01, 1.01].map(confidence => ({ ...answer, grades: [{ ...grades[0], confidence }, grades[1]] })),
    ...["", " ", "e".repeat(501)].map(evidence => ({ ...answer, grades: [{ ...grades[0], evidence }, grades[1]] })),
  ]) {
    expect(Result.isFailure(DecisionJudgment.parse(json({ decisions: { version: 1, answers: [invalid] } }), request))).toBe(true)
    expect(Result.isFailure(DecisionJudgment.validate({ decisions: { version: 1, answers: [invalid] } }, request))).toBe(true)
  }
  for (const confidence of [NaN, Infinity, -Infinity]) {
    const invalid = { ...answer, grades: [{ ...grades[0], confidence }, grades[1]] }
    expect(Result.isFailure(DecisionJudgment.validate({ decisions: { version: 1, answers: [invalid] } }, request))).toBe(true)
  }
  expect(Result.isFailure(DecisionJudgment.parse(json(document), { ...request, questions: [{ ...question, grade: false }] }))).toBe(true)
  const refusal = { decisions: { version: 1, answers: [
    { name: "grade", type: "refusal", answer: null, choice: null, score: null, confidence: 0 },
  ] } } as const
  expect(DecisionJudgment.parse(json(refusal), request)).toEqual(Result.succeed(refusal))
})

test("grade choice IDs are never coerced between string and boolean", () => {
  const question = { type: "choice", name: "grade", instructions: "Grade each alternative", grade: true,
    choices: [{ value: false }, { value: "false" }, { value: "0" }] } as const
  const graded = { state: null, questions: [question] }
  const grades = [
    { choice: false, confidence: 0.5, evidence: "Boolean false" },
    { choice: "false", confidence: 0.5, evidence: "String false" },
    { choice: "0", confidence: 0.5, evidence: "String zero" },
  ]
  const answer = { name: "grade", type: "choice", answer: null, choice: null, score: null, confidence: 0, grades }
  expect(Result.isSuccess(DecisionJudgment.validate({ decisions: { version: 1, answers: [answer] } }, graded))).toBe(true)
  for (const invalid of [
    { ...answer, grades: [{ ...grades[0], choice: "false" }, grades[1], grades[2]] },
    { ...answer, grades: [grades[0], { ...grades[1], choice: false }, grades[2]] },
    { ...answer, grades: [grades[0], grades[1], { ...grades[2], choice: 0 }] },
    { ...answer, grades: [grades[0], grades[1], { ...grades[2], choice: true }] },
  ]) {
    expect(Result.isFailure(DecisionJudgment.validate({ decisions: { version: 1, answers: [invalid] } }, graded))).toBe(true)
    expect(Result.isFailure(DecisionJudgment.parse(json({ decisions: { version: 1, answers: [invalid] } }), graded))).toBe(true)
  }
  const pick = { state: null, questions: [{ ...question, grade: false }] }
  const picked = { name: "grade", type: "choice", answer: null, choice: false, score: null, confidence: 0.5 }
  expect(Result.isSuccess(DecisionJudgment.validate({ decisions: { version: 1, answers: [picked] } }, pick))).toBe(true)
  expect(Result.isSuccess(DecisionJudgment.validate(
    { decisions: { version: 1, answers: [{ ...picked, choice: "false" }] } }, pick,
  ))).toBe(true)
  const booleanOnly = { state: null, questions: [{ type: "choice", name: "grade", instructions: "Pick", choices: [{ value: false }] }] } as const
  expect(Result.isFailure(DecisionJudgment.validate(
    { decisions: { version: 1, answers: [{ ...picked, choice: "false" }] } }, booleanOnly,
  ))).toBe(true)
  const stringOnly = { state: null, questions: [{ type: "choice", name: "grade", instructions: "Pick", choices: [{ value: "false" }] }] } as const
  expect(Result.isFailure(DecisionJudgment.validate(
    { decisions: { version: 1, answers: [picked] } }, stringOnly,
  ))).toBe(true)
})

test("parses literal JSON with Unicode, false, zero score, and explicit refusal", () => {
  const result = DecisionJudgment.parse(wire, input)
  expect(result).toEqual(Result.succeed(document))
  expect(DecisionJudgment.encode(document)).toBe(wire)
  expect(DecisionJudgment.validate(document, input)).toEqual(Result.succeed(document))
  expect(DecisionJudgment.validate(JSON.parse(wire), input)).toEqual(Result.succeed(document))
})

test("validate rejects non-document values and non-finite confidence without a text round trip", () => {
  for (const value of [null, [], "text", 1, true, undefined])
    expect(Result.isFailure(DecisionJudgment.validate(value, input))).toBe(true)
  for (const confidence of [NaN, Infinity, -Infinity]) {
    const invalid = {
      decisions: {
        version: 1,
        answers: document.decisions.answers.map((answer) =>
          answer.name === "safe" ? { ...answer, confidence } : answer),
      },
    }
    const result = DecisionJudgment.validate(invalid, input)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(DecisionJudgment.InvalidResponseError)
  }
})

test("normalizes shuffled answer IDs to caller order without altering judgments", () => {
  const result = DecisionJudgment.parse(
    json({ decisions: { version: 1, answers: [...document.decisions.answers].reverse() } }),
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

test("parses the canonical all-refusal JSON shape in caller order", () => {
  const refusal = {
    decisions: {
      version: 1,
      answers: questions.map((question) => ({
        name: question.name,
        type: "refusal",
        answer: null,
        choice: null,
        score: null,
        confidence: 0,
      })),
    },
  } satisfies typeof DecisionJudgment.Document.Type
  expect(DecisionJudgment.parse(json(refusal), input)).toEqual(Result.succeed(refusal))
  expect(DecisionJudgment.encode(refusal)).toBe(json(refusal))
  expect(DecisionJudgment.validate(refusal, input)).toEqual(Result.succeed(refusal))
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
  ["refusal grades", changed("unknown", { grades: [{ choice: false, confidence: 1, evidence: "x" }] })],
  ["extra probability", changed("safe", { probability: 0.9 })],
  ["extra confidence provenance", changed("safe", { confidence_kind: "native-probability" })],
  ["extra root field", { ...document, metadata: "private" }],
  ["extra document field", { decisions: { ...document.decisions, explanation: "private" } }],
  ["wrong version", { decisions: { ...document.decisions, version: 2 } }],
] as const) {
  test(`rejects judgment ${name} with a sanitized error`, () => {
    const result = DecisionJudgment.parse(json(value), input)
    expect(Result.isFailure(result)).toBe(true)
    expect(Result.isFailure(DecisionJudgment.validate(value, input))).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(DecisionJudgment.InvalidResponseError)
      expect(result.failure.message).toBe("Invalid decision judgment JSON document")
      expect(Object.keys(result.failure)).not.toContain("cause")
    }
  })
}

for (const [name, text] of [
  ["markdown fence", `\`\`\`json\n${wire}\n\`\`\``],
  ["leading prose", `Here is my decision:\n${wire}`],
  ["trailing prose", `${wire}\nThe task is safe.`],
  ["TOON document", toonWire],
  ["wrong root", wire.replace(`"decisions"`, `"judgments"`)],
  ["duplicate document", `${wire}\n${wire}`],
  ["truncated document", wire.slice(0, -1)],
  ["truncated array", wire.slice(0, Math.floor(wire.length / 2))],
  ["trailing comma", wire.replace(`"confidence":0.9}`, `"confidence":0.9,}`)],
  ["single-quoted strings", wire.replaceAll(`"`, `'`)],
  ["NaN confidence", wire.replace(`"confidence":0.9`, `"confidence":NaN`)],
  ["infinite confidence", wire.replace(`"confidence":0.9`, `"confidence":Infinity`)],
  ["empty output", ""],
] as const) {
  test(`rejects ${name} without fallback or exposed parse causes`, () => {
    const result = DecisionJudgment.parse(text, input)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toBe("Invalid decision judgment JSON document")
  })
}

test("bounds output by UTF-8 bytes rather than character count", () => {
  const choice = "é".repeat(524288)
  const request = {
    state: null,
    questions: [{ type: "choice", name: "selection", instructions: "Select", choices: [{ value: choice }] }],
  } satisfies typeof DecisionJudgment.Request.Type
  const text = json({
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
    expect(Result.isFailure(DecisionJudgment.validate(document, Object.assign({ ...input }, invalid)))).toBe(true)
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
  const refusal = {
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
  } satisfies typeof DecisionJudgment.Document.Type
  const result = DecisionJudgment.parse(DecisionJudgment.encode(refusal), request)
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) expect(result.success.decisions.answers).toHaveLength(32)
})

type JsonRecord = Record<string, unknown>
const record = (value: unknown): JsonRecord => value as JsonRecord
const records = (value: unknown): JsonRecord[] => value as JsonRecord[]
const strings = (value: unknown): string[] => value as string[]
const branchesOf = (schema: JsonRecord): JsonRecord[] => {
  const decisions = record(record(schema.properties).decisions)
  const answers = record(record(decisions.properties).answers)
  return records(record(answers.items).anyOf)
}
const branchOf = (schema: JsonRecord, name: string, type: string): JsonRecord => {
  const branch = branchesOf(schema).find((candidate) => {
    const properties = record(candidate.properties)
    return (record(properties.name).enum as unknown[])[0] === name && (record(properties.type).enum as unknown[])[0] === type
  })
  if (!branch) throw new Error(`Missing ${name}/${type} branch`)
  return branch
}

test("responseSchema is a strict object schema discriminating predicate from refusal", () => {
  const schema = DecisionJudgment.responseSchema({
    state: null,
    questions: [{ type: "predicate", name: "safe", instructions: "Is it safe?" }],
  })
  expect(schema).toEqual({
    type: "object",
    properties: {
      decisions: {
        type: "object",
        properties: {
          version: { type: "integer", enum: [1] },
          answers: {
            type: "array",
            minItems: 1,
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    name: { type: "string", enum: ["safe"] },
                    type: { type: "string", enum: ["predicate"] },
                    answer: { type: "boolean" },
                    choice: { type: "null" },
                    score: { type: "null" },
                    text: { type: "null" },
                    confidence: { type: "number" },
                  },
                  required: ["name", "type", "answer", "choice", "score", "text", "confidence"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    name: { type: "string", enum: ["safe"] },
                    type: { type: "string", enum: ["refusal"] },
                    answer: { type: "null" },
                    choice: { type: "null" },
                    score: { type: "null" },
                    text: { type: "null" },
                    confidence: { type: "number", enum: [0] },
                  },
                  required: ["name", "type", "answer", "choice", "score", "text", "confidence"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        required: ["version", "answers"],
        additionalProperties: false,
      },
    },
    required: ["decisions"],
    additionalProperties: false,
  })
})

test("responseSchema discriminates choice, graded choice, and score with exact typed choice enums", () => {
  const schema = DecisionJudgment.responseSchema(input)
  expect(branchesOf(schema)).toHaveLength(8)
  const choice = record(record(branchOf(schema, "方式", "choice").properties).choice)
  expect(choice.enum).toEqual([false, "false", "0"])
  expect(typeof (choice.enum as unknown[])[0]).toBe("boolean")
  expect(typeof (choice.enum as unknown[])[1]).toBe("string")
  const choiceProperties = record(branchOf(schema, "方式", "choice").properties)
  expect(choiceProperties.answer).toEqual({ type: "null" })
  expect(choiceProperties.score).toEqual({ type: "null" })
  expect(choiceProperties.grades).toBeUndefined()
  const scoreProperties = record(branchOf(schema, "effort", "score").properties)
  expect(scoreProperties.score).toEqual({ type: "integer" })
  expect(scoreProperties.answer).toEqual({ type: "null" })
  expect(scoreProperties.choice).toEqual({ type: "null" })
  for (const question of questions) {
    const refusal = record(branchOf(schema, question.name, "refusal").properties)
    expect(refusal.answer).toEqual({ type: "null" })
    expect(refusal.choice).toEqual({ type: "null" })
    expect(refusal.score).toEqual({ type: "null" })
    expect(refusal.confidence).toEqual({ type: "number", enum: [0] })
    expect(refusal.grades).toBeUndefined()
  }
  const graded = DecisionJudgment.responseSchema({
    state: null,
    questions: [{ type: "choice", name: "route", instructions: "Grade", grade: true,
      choices: [{ value: false }, { value: "false" }] }],
  })
  const gradedBranch = branchOf(graded, "route", "choice")
  const gradedProperties = record(gradedBranch.properties)
  expect(strings(gradedBranch.required)).toEqual(["name", "type", "answer", "choice", "score", "text", "confidence", "grades"])
  expect(gradedProperties.answer).toEqual({ type: "null" })
  expect(gradedProperties.choice).toEqual({ type: "null" })
  expect(gradedProperties.score).toEqual({ type: "null" })
  expect(gradedProperties.confidence).toEqual({ type: "number", enum: [0] })
  const grades = record(gradedProperties.grades)
  expect(grades.type).toBe("array")
  expect(grades.minItems).toBe(1)
  const grade = record(grades.items)
  expect(grade.additionalProperties).toBe(false)
  expect(strings(grade.required)).toEqual(["choice", "confidence", "evidence"])
  const gradeProperties = record(grade.properties)
  expect(record(gradeProperties.choice).enum).toEqual([false, "false"])
  expect(gradeProperties.confidence).toEqual({ type: "number" })
  expect(gradeProperties.evidence).toEqual({ type: "string" })
})

test("responseSchema carries no provider-unenforced bounds and requires every object property", () => {
  const schema = DecisionJudgment.responseSchema({
    state: null,
    questions: [
      ...input.questions,
      { type: "choice", name: "route", instructions: "Grade", grade: true, choices: [{ value: "a" }, { value: "b" }] },
    ],
  })
  const forbidden = [
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "maxItems", "uniqueItems", "minContains", "maxContains",
    "minProperties", "maxProperties",
  ]
  const seen: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    const node = record(value)
    seen.push(...Object.keys(node).filter((key) => forbidden.includes(key)))
    if (typeof node.minItems === "number") expect(node.minItems).toBeLessThanOrEqual(1)
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false)
      expect([...strings(node.required)].sort()).toEqual(Object.keys(record(node.properties)).sort())
    }
    Object.values(node).forEach(visit)
  }
  visit(schema)
  expect(seen).toEqual([])
})

const textRequest = {
  state: { task: "Name the release" },
  questions: [{ type: "text", name: "release", instructions: "Give the release name", maxLength: 12 }],
} satisfies typeof DecisionJudgment.Request.Type
const textAnswer = (patch: Record<string, unknown>) =>
  JSON.stringify({
    decisions: {
      version: 1,
      answers: [{ name: "release", type: "text", answer: null, choice: null, score: null, text: "release-42", confidence: 0.9, ...patch }],
    },
  })

test("text questions accept only bounded non-whitespace text answers", () => {
  const ok = DecisionJudgment.parse(textAnswer({}), textRequest)
  expect(Result.isSuccess(ok)).toBe(true)
  if (Result.isSuccess(ok)) expect(ok.success.decisions.answers[0]?.text).toBe("release-42")
  for (const patch of [{ text: "   " }, { text: "" }, { text: "x".repeat(13) }, { text: null }, { answer: false }, { choice: "x" }, { score: 0 }])
    expect(Result.isFailure(DecisionJudgment.parse(textAnswer(patch), textRequest))).toBe(true)
  const refusal = DecisionJudgment.parse(
    JSON.stringify({ decisions: { version: 1, answers: [{ name: "release", type: "refusal", answer: null, choice: null, score: null, text: null, confidence: 0 }] } }),
    textRequest,
  )
  expect(Result.isSuccess(refusal)).toBe(true)
})

test("text answers do not leak into other question types and old answers stay valid", () => {
  const leaked = textAnswer({}).replace('"type":"text"', '"type":"predicate"').replace('"answer":null', '"answer":false')
  const predicateRequest = { state: null, questions: [{ type: "predicate", name: "release", instructions: "Ready?" }] } satisfies typeof DecisionJudgment.Request.Type
  expect(Result.isFailure(DecisionJudgment.parse(leaked, predicateRequest))).toBe(true)
  expect(Result.isSuccess(DecisionJudgment.parse(wire, input))).toBe(true)
})

test("requests reject duplicate score labels and empty choice values", () => {
  expect(Schema.is(DecisionJudgment.Request)({
    state: null,
    questions: [{ type: "score", name: "s", instructions: "Rate", levels: [{ label: "low" }, { label: "low" }] }],
  })).toBe(false)
  expect(Schema.is(DecisionJudgment.Request)({
    state: null,
    questions: [{ type: "choice", name: "c", instructions: "Pick", choices: [{ value: "" }, { value: "x" }] }],
  })).toBe(false)
  expect(Schema.is(DecisionJudgment.Request)({
    state: null,
    questions: [{ type: "choice", name: "c", instructions: "Pick", choices: [{ value: false }, { value: "false" }] }],
  })).toBe(true)
})
