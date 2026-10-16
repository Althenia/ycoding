export * as DecisionTool from "./decision"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Option, Schema, SchemaIssue } from "effect"
import { encode } from "@toon-format/toon"
import { Decision } from "../decision"
import { Permission } from "../permission"
import { Hash } from "../util/hash"
import { Tool } from "./tool"

const example = '{"provider":"agent","request":{"state":{},"questions":[{"type":"choice","name":"route","instructions":"Grade each route","grade":true,"choices":[{"value":"keep","description":"Keep current"},{"value":"change","description":"Use the alternative"}]}]}}'

function invalidInput(issue: SchemaIssue.Issue, value: unknown) {
  const request = value !== null && typeof value === "object" && "request" in value ? value.request : undefined
  const questions = request !== null && typeof request === "object" && "questions" in request ? request.questions : undefined
  if (Array.isArray(questions) && questions.length === 0)
    return "questions: expected at least one question; received []. Add one bounded question, or skip the decision tool if no judgment is needed."
  const index = Array.isArray(questions) ? questions.findIndex((question) =>
    question !== null && typeof question === "object" && "type" in question && !Schema.is(Schema.Literals(["predicate", "choice", "score"]))(question.type),
  ) : -1
  if (index >= 0)
    return `questions[${index}].type: expected "predicate", "choice", or "score"; received an unsupported value (redacted). Minimal valid request: ${example}`
  const failures = inputIssues(issue)
  return failures.map((failure) => {
    const path = failure.path.map((key) => {
      if (typeof key === "number") return `[${key}]`
      return ["provider", "request", "state", "questions", "type", "name", "instructions", "grade", "choices", "value", "description", "levels", "label"].includes(String(key)) ? `.${String(key)}` : ".<unknown-key>"
    }).join("").replace(/^\./, "") || "input"
    return `${path}: ${failure.message}`
  }).join("; ") + `. Minimal valid request: ${example}`
}

function inputIssues(issue: SchemaIssue.Issue, path: readonly PropertyKey[] = []): { path: readonly PropertyKey[]; message: string }[] {
  if (issue._tag === "Pointer") return inputIssues(issue.issue, [...path, ...issue.path])
  if (issue._tag === "Encoding") return inputIssues(issue.issue, path)
  if (issue._tag === "Composite") return issue.issues.flatMap((child) => inputIssues(child, path))
  if (issue._tag === "AnyOf" && issue.issues.length) return issue.issues.flatMap((child) => inputIssues(child, path))
  if (issue._tag === "Filter") return [{ path, message: `Expected ${issue.filter.annotations?.expected ?? "a value satisfying the declared constraint"}` }]
  if (issue._tag === "InvalidType" || issue._tag === "AnyOf" || issue._tag === "OneOf")
    return [{ path, message: SchemaIssue.defaultLeafHook(new SchemaIssue.InvalidType(issue.ast, Option.none())).replace(", got no value provided", "; received an invalid value (redacted)") }]
  return [{ path, message: issue._tag === "MissingKey" ? "Expected a required field" : issue._tag === "UnexpectedKey" ? "Expected only declared fields" : "Expected a value matching the declared schema" }]
}

export const name = "decision"
export const Input = Decision.Input
export const Output = Decision.Output

export const Plugin = {
  id: "ycoding.tool.decision",
  effect: Effect.fn("DecisionTool.Plugin")(function* (ctx: PluginContext) {
    const decisions = yield* Decision.Service
    const permission = yield* Permission.Service
    const inputSchema = Schema.toJsonSchemaDocument(Input)
    const outputSchema = Schema.toJsonSchemaDocument(Output)
    yield* ctx.tool.transform((draft) => draft.add(name, Tool.make({
      description: `Get bounded typed judgments from the configured hidden decision helper and selected model. Send provider: agent and request: { state, questions } with named predicate, choice, or score questions; choices use value/description and levels use label/description. Choice grade defaults to false for a single pick. Set grade: true to receive grades: [{ choice, confidence, evidence }] for every listed choice exactly once, with no pick; evidence is nonempty and at most 500 characters and confidence is in [0,1]. Example: ${example} Choose among verified candidates, classify risk, grade against a rubric, settle predicates tests cannot verify, or recommend an option before asking the user. Batch independent questions and reuse unchanged judgments. Confidence is self-reported and uncalibrated. Treat refusal, errors, low or close confidence, and disagreement with evidence as uncertainty. Judgments never grant permission or approval, replace the user's answer, prove completion, override owner choices or guardrails, or execute a tool. Send only evidence authorized for the helper model route.`,
      jsonSchema: { ...inputSchema.schema, $defs: inputSchema.definitions },
      outputSchema: { ...outputSchema.schema, $defs: outputSchema.definitions },
      execute: (value, context) => Schema.decodeUnknownEffect(Input)(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: invalidInput(error.issue, value) })),
        Effect.flatMap((input) => permission.assert({
        action: name, resources: [input.provider], save: [input.provider],
        metadata: { operationDigest: Hash.json(input) },
        sessionID: context.sessionID, agent: context.agent,
        source: { type: "tool", messageID: context.messageID, callID: context.callID },
      }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: "Decision request is not permitted", error })),
        Effect.andThen(decisions.evaluate(input, { sessionID: context.sessionID, agent: context.agent }).pipe(
          Effect.mapError((error) => new ToolFailure({ message: error.message })),
          Effect.flatMap((output) => Schema.encodeEffect(Output)(output).pipe(
            Effect.mapError(() => new ToolFailure({ message: "Decision helper returned an invalid result envelope. Treat this as uncertainty; verify the requested schema or decide from evidence." })),
          )),
          Effect.map((output) => ({ structured: output, content: [{ type: "text" as const, text: encode(output) },
            ...(output.response.answers.some((answer) => answer.type === "refusal") ? [{ type: "text" as const, text: "The helper refused at least one judgment. Treat refusal as uncertainty; supply missing bounded evidence or decide from evidence or ask the user. Do not retry an unchanged judgment." }] : []),
          ] })),
        )),
      ))),
    }), { codemode: false }))
  }),
}
