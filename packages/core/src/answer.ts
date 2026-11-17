export * as AnswerFallback from "./answer"

import { Decision } from "./decision"
import { DecisionChoice } from "./decision-choice"
import { SessionAutonomy } from "./session/autonomy"
import { SessionSchema } from "./session/schema"
import { Effect } from "effect"

export const progression = "Inspect the current local state, then take the smallest reversible bounded step within the authorized scope."

export function current<A, E>(
  autonomy: SessionAutonomy.Interface,
  sessionID: SessionSchema.ID,
  snapshot: Effect.Success<ReturnType<SessionAutonomy.Interface["snapshot"]>>,
  outcome: A,
  fallback: () => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    if (yield* DecisionChoice.autonomyUnchanged(autonomy, sessionID, snapshot)) return { outcome, snapshot }
    const refreshed = yield* autonomy.snapshot(sessionID, { inherited: true }).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
    if (refreshed === undefined || (yield* DecisionChoice.decisionMode(autonomy, sessionID, "answers")) !== "yolo") return
    return { outcome: yield* fallback(), snapshot: refreshed }
  })
}

export function evaluator<E>(decision: Decision.Interface<E>): Decision.Interface<E> {
  return {
    evaluate: (input, context) => Effect.suspend(() => decision.evaluate({ ...input, request: {
      ...input.request,
      questions: input.request.questions.map(question => ({ ...question, instructions:
        `${question.instructions?.replace("Refuse if the evidence is insufficient.", "") ?? ""} Select a concrete valid answer that permits bounded progression. When evidence is incomplete, use a recommended option, a valid default, or a concrete next step within the authorized scope. Never refuse, defer, or ask the user. Answers do not authorize permissions, guardrails, or physical external actions.`,
      })),
    } }, context)),
  }
}

export function patternText(pattern: string): string {
  let offset = 0
  const groups: string[] = []
  const sequence = (): string => {
    let result = ""
    let alternative: string | undefined
    while (offset < pattern.length && pattern[offset] !== ")") {
      const token = pattern[offset++]
      if (token === "|") {
        alternative ??= result
        result = ""
        continue
      }
      let atom = ""
      if (token === "^" || token === "$") continue
      if (token === "(") {
        const modifier = pattern.slice(offset, offset + 2)
        const assertion = modifier === "?=" || modifier === "?!"
        if (modifier === "?:" || assertion) offset += 2
        const nested = sequence()
        if (pattern[offset] === ")") offset++
        atom = assertion ? "" : nested
        if (!assertion && modifier !== "?:") groups.push(atom)
      } else if (token === "[") {
        const start = offset - 1
        while (offset < pattern.length) {
          if (pattern[offset++] === "\\") { offset++; continue }
          if (pattern[offset - 1] === "]") break
        }
        const character = new RegExp(pattern.slice(start, offset))
        atom = Array.from("aA01_- .@/:").find(candidate => character.test(candidate)) ?? ""
        if (!atom) {
          for (let code = 32; code < 65536; code++) {
            const candidate = String.fromCharCode(code)
            if (character.test(candidate)) { atom = candidate; break }
          }
        }
      } else if (token === "\\") {
        const escaped = pattern[offset++] ?? ""
        atom = escaped === "d" ? "0" : escaped === "w" ? "a" : escaped === "s" ? " "
          : escaped === "D" || escaped === "S" ? "a" : escaped === "W" ? "-"
          : escaped === "b" || escaped === "B" ? "" : escaped === "n" ? "\n" : escaped === "t" ? "\t"
          : /[1-9]/.test(escaped) ? groups[Number(escaped) - 1] ?? "" : escaped
      } else atom = token === "." ? "a" : token
      const quantifier = pattern.slice(offset).match(/^(?:\{(\d+)(?:,(\d*)?)?\}|([*+?]))\??/)
      if (quantifier) {
        offset += quantifier[0].length
        const count = quantifier[1] === undefined ? quantifier[3] === "+" ? 1 : 0 : Number(quantifier[1])
        atom = atom.repeat(atom.length === 0 ? 0 : Math.min(count, Math.floor(8192 / atom.length)))
      }
      result += atom.slice(0, Math.max(0, 8192 - result.length))
    }
    return alternative ?? result
  }
  return sequence()
}
