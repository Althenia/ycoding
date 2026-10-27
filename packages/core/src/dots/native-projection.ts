import { Schema } from "effect"
export * as Projection from "./native-projection"
import { Form } from "../form"
import { Question } from "@ycoding-ai/schema/question"
import type { Answers } from "./native"

export interface InputQuestion {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly isOther: boolean
  readonly isSecret: boolean
  readonly options: readonly { readonly label: string; readonly description: string }[] | null
}
export type Result<A> = { readonly type: "next"; readonly stage: Stage<A> } | { readonly type: "answer"; readonly value: A } | { readonly type: "cancel" }
export interface Stage<A> {
  readonly questions: readonly InputQuestion[]
  readonly read: (answers: Answers) => Result<A>
}
const invalid = () => new Error("The answer does not match the pending native request")
const option = (label: string, description = label) => ({ label, description })
const input = (id: string, header: string, question: string, options: InputQuestion["options"] = null): InputQuestion => ({ id, header, question, options, isOther: options === null, isSecret: false })
const control = (actions: readonly string[]) => input("action", "Action", "Continue, skip an optional field, or cancel this request.", [...actions, "Cancel request"].map((label) => option(label)))
function exactText<A>(header: string, finish: (value: string) => Result<A>): Stage<A> {
  const questions = [input("value", header, "Encode whitespace as \\s (space), \\t, \\n, \\r, or \\uXXXX; encode a backslash as \\\\. Do not enter literal whitespace."), control(["Continue"])]
  return { questions, read: (answers) => {
    if (action(answers, questions) === "Cancel request") return { type: "cancel" }
    const encoded = values(answers, questions).value!
    if (/\s/.test(encoded)) throw invalid()
    let result = ""
    for (let index = 0; index < encoded.length; index++) {
      const value = encoded[index]!
      if (value !== "\\") { result += value; continue }
      const escape = encoded[++index]
      if (escape === "u") {
        const hex = encoded.slice(index + 1, index + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw invalid()
        result += String.fromCharCode(Number.parseInt(hex, 16))
        index += 4
      } else if (escape === "s") result += " "
      else if (escape === "t") result += "\t"
      else if (escape === "n") result += "\n"
      else if (escape === "r") result += "\r"
      else if (escape === "\\") result += "\\"
      else throw invalid()
    }
    return finish(result)
  } }
}
function values(answers: Answers, questions: readonly InputQuestion[], partial = false) {
  if (Object.keys(answers).some((key) => !questions.some((question) => question.id === key))) throw invalid()
  const result: Record<string, string> = {}
  for (const question of questions) {
    const value = answers[question.id]?.answers
    if (value === undefined && partial) continue
    if (!value || value.length !== 1 || typeof value[0] !== "string") throw invalid()
    if (question.options && !question.options.some((option) => option.label === value[0])) throw invalid()
    result[question.id] = value[0]
  }
  return result
}
function action(answers: Answers, questions: readonly InputQuestion[]) {
  return values(answers, questions, true).action
}
export function map<A, B>(stage: Stage<A>, convert: (value: A) => B): Stage<B> {
  return { questions: stage.questions, read: (answers) => {
    const result = stage.read(answers)
    if (result.type === "next") return { type: "next", stage: map(result.stage, convert) }
    if (result.type === "cancel") return result
    return { type: "answer", value: convert(result.value) }
  } }
}

export function form(title: string, fields: Form.Fields): Stage<Form.Answer> {
  const advance = (index: number, answer: Form.Answer): Result<Form.Answer> => {
    for (let cursor = index; cursor < fields.length; cursor++) {
      const field = fields[cursor]!
      if (field.type !== "external" && !Form.isActive(field, answer)) continue
      return { type: "next", stage: fieldStage(field, (value) => advance(cursor + 1, value === undefined ? answer : { ...answer, [field.key]: value })) }
    }
    const error = Form.validateAnswer({ fields }, answer)
    if (error) throw new Error(error)
    return { type: "answer", value: answer }
  }
  const fieldStage = (field: Form.Field, done: (value: Form.Answer[string] | undefined) => Result<Form.Answer>): Stage<Form.Answer> => {
    const optional = field.type !== "external" && !field.required
    const actions = ["Continue", ...(optional ? ["Skip field"] : [])]
    const custom = (field.type === "string" && field.options !== undefined || field.type === "multiselect") && field.custom === true
    if (custom) actions.push("Custom answer")
    if (field.type === "string" && (!field.options || field.custom)) actions.push("Exact text")
    if (field.type === "string" && !Form.validateField(field, "")) actions.push("Empty value")
    const description = [field.description, field.type === "external" ? field.url : `Type: ${field.type}`,
      "minimum" in field && field.minimum !== undefined ? `Minimum: ${field.minimum}` : undefined,
      "maximum" in field && field.maximum !== undefined ? `Maximum: ${field.maximum}` : undefined,
      "minItems" in field && field.minItems !== undefined ? `Minimum selections: ${field.minItems}` : undefined,
      "maxItems" in field && field.maxItems !== undefined ? `Maximum selections: ${field.maxItems}` : undefined,
      "minLength" in field && field.minLength !== undefined ? `Minimum length: ${field.minLength}` : undefined,
      "maxLength" in field && field.maxLength !== undefined ? `Maximum length: ${field.maxLength}` : undefined,
      "format" in field && field.format ? `Format: ${field.format}` : undefined,
      "pattern" in field && field.pattern ? `Pattern: ${field.pattern}` : undefined,
    ].filter((value) => value !== undefined).join("\n")
    const header = field.title ?? field.key
    const finish = (value: Form.Answer[string]) => {
      if (field.type !== "external") {
        const error = Form.validateField(field, value)
        if (error) throw new Error(error)
      }
      return done(value)
    }
    const customStage = (selected?: readonly string[]): Stage<Form.Answer> => {
      const empty = field.type === "multiselect" || field.type === "string" && !Form.validateField(field, "")
      const questions = [input("value", header, `${title}\n${description}\nEnter one custom value. The controller trims free text; use Exact text to retain whitespace.`), control([...(selected ? ["Add value", "Finish"] : ["Continue"]), "Exact text", ...(empty ? ["Empty value"] : [])])]
      const add = (value: string): Result<Form.Answer> => {
        if (selected) {
          if (selected.includes(value)) throw invalid()
          return { type: "next", stage: customStage([...selected, value]) }
        }
        return finish(value)
      }
      return { questions, read: (answers) => {
        const choice = action(answers, questions)
        if (choice === "Cancel request") return { type: "cancel" }
        if (selected && choice === "Finish") return finish(selected)
        if (choice === "Exact text") return { type: "next", stage: exactText(header, add) }
        if (choice === "Empty value" && empty) return add("")
        return add(values(answers, questions).value!)
      } }
    }
    const labels = field.type === "string" ? field.options?.map((entry, index) => `${index + 1}. ${entry.label.trim()}`) : undefined
    const questions = field.type === "multiselect"
      ? [...field.options.map((entry, index) => input(`option:${index}`, header, `${title}\n${entry.label}\n${entry.description ?? ""}`, [option("Select"), option("Do not select")])), control(actions)]
      : [input("value", header, `${title}\n${description}`, field.type === "boolean" ? [option("True"), option("False")]
        : field.type === "external" ? [option("Acknowledged")]
        : field.type === "string" && field.options ? field.options.map((entry, index) => option(labels![index]!, entry.description ?? entry.label)) : null), control(actions)]
    return { questions, read: (answers) => {
      const choice = action(answers, questions)
      if (choice === "Cancel request") return { type: "cancel" }
      if (choice === "Skip field" && optional) return done(undefined)
      if (field.type === "string" && choice === "Exact text" && (!field.options || field.custom)) return { type: "next", stage: exactText(header, finish) }
      if (field.type === "string" && choice === "Empty value" && !Form.validateField(field, "")) return finish("")
      if (choice === "Custom answer" && custom && field.type === "string") return { type: "next", stage: customStage() }
      const value = values(answers, questions)
      if (field.type === "multiselect") {
        const selected = field.options.filter((_, index) => value[`option:${index}`] === "Select").map((entry) => entry.value)
        if (choice === "Custom answer" && custom) return { type: "next", stage: customStage(selected) }
        return finish(selected)
      }
      if (choice !== "Continue") throw invalid()
      if (field.type === "external") return finish(true)
      if (field.type === "boolean") return finish(value.value === "True")
      if (field.type === "string") return finish(field.options ? field.options[labels!.indexOf(value.value!)]!.value : value.value!)
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.value!)) throw invalid()
      return finish(Number(value.value))
    } }
  }
  const first = advance(0, {})
  if (first.type === "next") return first.stage
  const questions = [control(["Continue"])]
  return { questions, read: (answers) => values(answers, questions).action === "Continue" ? first : { type: "cancel" } }
}

export function questions(items: readonly Question.Info[]): Stage<readonly Question.Answer[]> {
  const fields = items.map((item, index): Form.Field => ({ key: `question:${index}`, title: item.header, description: item.question,
    ...(item.multiple ? { type: "multiselect", options: item.options.map((entry) => ({ ...entry, value: entry.label })), custom: item.custom !== false }
      : { type: "string", ...(item.options.length || item.custom === false ? { options: item.options.map((entry) => ({ ...entry, value: entry.label })) } : {}), custom: item.custom !== false }),
  }))
  const [first, ...rest] = fields
  if (!first) {
    const pending = [control(["Continue"])]
    return { questions: pending, read: (answers) => values(answers, pending).action === "Continue" ? { type: "answer", value: [] } : { type: "cancel" } }
  }
  return map(form("Question", [first, ...rest]), (answer) => items.map((_, index) => {
    const value = answer[`question:${index}`]
    return value === undefined ? [] : typeof value === "string" ? [value] : Schema.decodeUnknownSync(Question.Answer)(value)
  }))
}

export function child(text: string): Stage<{ readonly text?: string; readonly data?: Schema.Json }> {
  const finish = (value: { readonly text?: string; readonly data?: Schema.Json }): Result<typeof value> => {
    if (value.text === undefined && value.data === undefined) throw invalid()
    return { type: "answer", value }
  }
  const data = (text?: string): Stage<{ readonly text?: string; readonly data?: Schema.Json }> => {
    const questions = [input("value", "Structured answer", "Enter the JSON-valued answer data."), control(["Continue", "Skip field"])]
    return { questions, read: (answers) => {
      const choice = action(answers, questions)
      if (choice === "Cancel request") return { type: "cancel" }
      if (choice === "Skip field") return finish({ text })
      const parsed: unknown = JSON.parse(values(answers, questions).value!)
      return finish({ ...(text === undefined ? {} : { text }), data: Schema.decodeUnknownSync(Schema.Json)(parsed) })
    } }
  }
  const pending = [input("value", "Child question", text), control(["Continue", "Exact text", "Skip field"])]
  return { questions: pending, read: (answers) => {
    const choice = action(answers, pending)
    if (choice === "Cancel request") return { type: "cancel" }
    if (choice === "Skip field") return { type: "next", stage: data() }
    if (choice === "Exact text") return { type: "next", stage: exactText("Child question", (value) => ({ type: "next", stage: data(value) })) }
    const text = values(answers, pending).value!
    if (!text.trim()) throw invalid()
    return { type: "next", stage: data(text) }
  } }
}
