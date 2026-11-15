import type { QuestionRequest } from "./contract"

export function questionAnswerError(questions: QuestionRequest["questions"], answers: readonly (readonly string[])[]) {
  if (questions.length !== answers.length) return "Answer every question."
  for (const [index, question] of questions.entries()) {
    const choices = answers[index] ?? []
    if (!choices.length || choices.some((choice) => !choice.trim())) return `Answer ${question.header}.`
    if (!question.multiple && choices.length !== 1) return `Choose one answer for ${question.header}.`
    if (new Set(choices).size !== choices.length) return `Choose each answer once for ${question.header}.`
    if (question.custom === false && choices.some((choice) => !question.options.some((option) => option.label === choice))) return `Choose an available answer for ${question.header}.`
  }
  return undefined
}
