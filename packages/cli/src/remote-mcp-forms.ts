export * as RemoteMcpForms from "./remote-mcp-forms"

import { RemoteMCPTransport } from "@ycoding-ai/core/remote-mcp/transport"
import { Form } from "@ycoding-ai/schema/form"
import type { Dots } from "@ycoding-ai/schema/dots"
import { RemoteMcpSchemas } from "./remote-mcp-schemas"

type Property = RemoteMCPTransport.ElicitRequestFormParams["requestedSchema"]["properties"][string]
export type Evidence = "declared-object" | "implied-by-empty-object" | "absent" | "malformed"

export function capabilities(envelope: unknown) {
  const meta = RemoteMcpSchemas.recordOf(envelope)
  const declared = RemoteMcpSchemas.recordOf(meta?.["io.modelcontextprotocol/clientCapabilities"])
  const elicitation = RemoteMcpSchemas.recordOf(declared?.elicitation)
  const parent: Evidence = declared === undefined || !Object.hasOwn(declared, "elicitation") ? "absent" : elicitation === undefined ? "malformed" : "declared-object"
  const mode = (key: "form" | "url"): Evidence => {
    if (parent === "absent" || parent === "malformed") return parent
    if (key === "form" && Object.keys(elicitation ?? {}).length === 0) return "implied-by-empty-object"
    if (!Object.hasOwn(elicitation ?? {}, key)) return "absent"
    return RemoteMcpSchemas.recordOf(elicitation?.[key]) === undefined ? "malformed" : "declared-object"
  }
  return {
    ...(typeof meta?.["io.modelcontextprotocol/protocolVersion"] === "string" && meta["io.modelcontextprotocol/protocolVersion"].length <= 64 ? { protocolVersion: meta["io.modelcontextprotocol/protocolVersion"] } : {}),
    elicitation: parent,
    form: mode("form"),
    url: mode("url"),
  }
}

export function supported(evidence: Evidence) {
  return evidence === "declared-object" || evidence === "implied-by-empty-object"
}

export function create(candidate: Dots.DecisionCandidate) {
  if (candidate.target.kind === "permission" || candidate.target.kind === "guardrail")
    return build([{ key: "reply", type: "string", title: "Client decision", required: true, options: [{ value: "once", label: "Approve once" }, { value: "reject", label: "Reject" }] }], (values) => ({ reply: values.reply }))
  if (candidate.target.kind === "form") {
    if (candidate.fields === undefined) throw new Error("The native form fields are unavailable")
    return build(candidate.fields, (values) => ({ answers: values }))
  }
  if (!candidate.questions?.length) throw new Error("The native questions are unavailable")
  const fields: Form.Field[] = candidate.questions.map((question, index) => {
    if (question.multiple && question.custom !== false) throw new Error("Multiple custom question answers cannot be encoded as a standard form")
    const options = question.options.map((option) => ({ value: option.label, label: option.label }))
    if (question.multiple) return { key: `q${index}`, type: "multiselect", title: question.header, description: question.question, required: true, options }
    return { key: `q${index}`, type: "string", title: question.header, description: question.question, required: true, ...(options.length ? { options, custom: question.custom !== false } : {}) }
  })
  return build(fields, (values) => ({ answers: candidate.questions?.map((_question, index) => {
    const value = values[`q${index}`]
    return Array.isArray(value) ? value : [value]
  }) }))
}

function build(fields: readonly Form.Field[], choice: (values: Form.Answer) => Record<string, unknown>) {
  if (fields.length > 64) throw new Error("The native form exceeds the standard form field bound")
  const properties: Record<string, Property> = Object.create(null)
  const required: string[] = []
  const companions = new Map<string, string>()
  const keys = new Set(fields.map((field) => field.key))
  if (keys.size !== fields.length) throw new Error("The native form contains duplicate keys")
  for (const field of fields) {
    if (field.type === "external") throw new Error("External native forms require the native client")
    if (field.when?.length) throw new Error("Conditional native fields cannot be encoded as a standard form")
    if (field.type === "multiselect" && field.custom) throw new Error("Multiple custom selections cannot be encoded as a standard form")
    if ((field.type === "string" || field.type === "multiselect") && field.options?.length === 0 && !field.custom) throw new Error("A standard selection needs at least one native option")
    const title = field.title ?? field.key
    const base = { title, ...(field.description === undefined ? {} : { description: field.description }) }
    if (field.type === "string") {
      properties[field.key] = { ...base, type: "string", ...(field.minLength === undefined ? {} : { minLength: field.minLength }), maxLength: Math.min(field.maxLength ?? 8192, 8192),
        ...(field.format === undefined ? {} : { format: field.format }),
        ...(!field.options?.length ? {} : { oneOf: field.options.map((option) => ({ const: option.value, title: option.label ?? option.value })) }) }
      if (field.options?.length && field.custom) {
        const companion = `${field.key}__custom`
        if (keys.has(companion)) throw new Error("The native form collides with its standard custom-text key")
        properties[companion] = { ...base, title: `${title} (custom text)`, type: "string", minLength: Math.max(field.minLength ?? 1, 1), maxLength: Math.min(field.maxLength ?? 8192, 8192), ...(field.format === undefined ? {} : { format: field.format }) }
        companions.set(field.key, companion)
      }
    }
    if (field.type === "number" || field.type === "integer") properties[field.key] = { ...base, type: field.type, ...(field.minimum === undefined ? {} : { minimum: field.minimum }), ...(field.maximum === undefined ? {} : { maximum: field.maximum }) }
    if (field.type === "boolean") properties[field.key] = { ...base, type: "boolean" }
    if (field.type === "multiselect") properties[field.key] = { ...base, type: "array", items: { anyOf: field.options.map((option) => ({ const: option.value, title: option.label ?? option.value })) }, minItems: Math.max(field.minItems ?? 0, field.required ? 1 : 0), maxItems: Math.min(field.maxItems ?? 64, 64) }
    if (field.required && !companions.has(field.key)) required.push(field.key)
  }
  const requestedSchema = { type: "object" as const, properties, required }
  if (JSON.stringify(requestedSchema).length > 32768) throw new Error("The standard form schema exceeds its bound")
  const validator = new RemoteMCPTransport.AjvJsonSchemaValidator().getValidator<Form.Answer>({ ...requestedSchema, additionalProperties: false })
  return {
    requestedSchema,
    choice(content: unknown) {
      if (JSON.stringify(content)?.length > 32768) throw new Error("The client answer exceeds its bound")
      const checked = validator(content)
      if (!checked.valid) throw new Error("The client answer does not match the standard form schema")
      const values = { ...checked.data }
      for (const [key, companion] of companions) {
        if (values[key] !== undefined && values[companion] !== undefined) throw new Error("Choose either a listed option or custom text")
        if (values[companion] !== undefined) values[key] = values[companion]
        delete values[companion]
      }
      for (const field of fields) {
        if (field.type === "external") continue
        if (field.required && values[field.key] === undefined) throw new Error("A required native answer is absent")
      }
      return choice(values)
    },
  }
}
