import type { AssistantPart, RemoteMessageView } from "./projection"

export function questionHistory(part: Extract<AssistantPart, { kind: "tool" }>) {
  if (part.name === "subagent_report" && part.input?.action === "question" && typeof part.input.text === "string")
    return [{ title: "Question for parent", text: part.input.text, answer: undefined }]
  if (part.name !== "question" || !Array.isArray(part.input?.questions)) return []
  const answers = part.structured?.answers
  return part.input.questions.flatMap((question: unknown, index) => {
    if (!question || typeof question !== "object" || !("question" in question) || typeof question.question !== "string") return []
    const answer: unknown = Array.isArray(answers) ? answers[index] : undefined
    return [{ title: "header" in question && typeof question.header === "string" ? question.header : "Question", text: question.question,
      answer: Array.isArray(answer) && answer.every((value): value is string => typeof value === "string") ? answer.length ? answer.join(", ") : "Unanswered" : undefined }]
  })
}

export function questionAnswerState(part: Extract<AssistantPart, { kind: "tool" }>): string {
  if (part.error === "The user dismissed this question") return "Question cancelled"
  if (part.status === "failed") return "Question failed"
  if (part.status !== "completed") return "Awaiting answer"
  if (part.name === "subagent_report") return "Question recorded"
  return "Answer not reported"
}

export function parentAnswer(message: RemoteMessageView): string | undefined {
  if (message.kind !== "synthetic" || message.metadata?.source !== "subagent_parent" || message.metadata.kind !== "answer" || !message.text.startsWith("Parent answer:\n")) return undefined
  const text = message.text.slice("Parent answer:\n".length)
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || !("questionID" in value) || typeof value.questionID !== "string" || value.questionID !== message.metadata.questionID) return undefined
    const answer = ["text" in value && typeof value.text === "string" ? value.text : undefined,
      "data" in value && value.data !== undefined ? `\`\`\`json\n${JSON.stringify(value.data, null, 2)}\n\`\`\`` : undefined].filter((part) => part !== undefined)
    return answer.length ? answer.join("\n\n") : undefined
  } catch {
    return undefined
  }
}
