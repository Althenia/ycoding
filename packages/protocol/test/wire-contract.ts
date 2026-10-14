import { Schema, SchemaAST } from "effect"
import type { HttpApiEndpoint } from "effect/unstable/httpapi"
import type { HttpApiSchema } from "effect/unstable/httpapi"

export type WireField = {
  name: string
  type: string
  presence: "required" | "optional" | "repeated" | "oneof"
  constraints: readonly Schema.Annotations.Filter[]
  ast?: SchemaAST.AST
  source?: string
  countMin?: number
}
export type WireMessage = { fields: WireField[]; oneof: boolean }
const identifier = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "_")

export function wireContract(
  endpoints: readonly {
    group: string
    endpoint: Pick<
      HttpApiEndpoint.Top,
      "identifier" | "method" | "params" | "query" | "payload" | "success" | "error"
    > &
      Partial<Pick<HttpApiEndpoint.Top, "headers">>
  }[],
  ids: Readonly<Record<string, number>>,
  sourceIdentity: (ast: SchemaAST.AST, hint: string) => string,
  middlewareErrors: readonly Schema.Top[],
  resultNames: Readonly<Record<string, string>> = {},
  declarations: readonly Schema.Top[] = [],
) {
  const messages = new Map<string, WireMessage>()
  const enums = new Map<string, readonly (string | number | boolean)[]>()
  const flattenCheck = (check: SchemaAST.Check<unknown>): readonly Schema.Annotations.Filter[] =>
    check._tag === "Filter" ? [check.annotations ?? {}] : check.checks.flatMap(flattenCheck)
  const checks = (ast: SchemaAST.AST): readonly Schema.Annotations.Filter[] => {
    const own = (ast.checks ?? []).flatMap(flattenCheck)
    if (isUtcDeclaration(ast)) return [...own, ...(Schema.Finite.ast.checks ?? []).flatMap(flattenCheck)]
    if (ast._tag !== "Union") return own
    const types = ast.types.filter((type) => type._tag !== "Undefined")
    return types.length === 1 ? [...own, ...checks(types[0])] : own
  }
  const build = (input: SchemaAST.AST, hint: string): string => {
    const ast = Schema.toType(Schema.make(input)).ast
    const name = identifier(typeof ast.annotations?.identifier === "string" ? ast.annotations.identifier : hint)
    if (ast._tag === "String") return "LosslessString"
    if (ast._tag === "Boolean") return "bool"
    if (ast._tag === "Number") {
      const document = Schema.toJsonSchemaDocument(Schema.make(ast))
      const encoded = JSON.stringify(document)
      return encoded.includes('"integer"')
        ? /"(?:exclusiveMinimum|minimum)":0/.test(encoded)
          ? "uint64"
          : "int64"
        : "double"
    }
    if (ast._tag === "Literal") {
      if (typeof ast.literal === "boolean") return "bool"
      if (typeof ast.literal === "number") return "double"
      if (typeof ast.literal !== "string") throw new Error(`${name}: unsupported literal`)
      enums.set(name, [ast.literal])
      return name
    }
    if (ast._tag === "Undefined" || ast._tag === "Null" || ast._tag === "Void") return "Empty"
    if (ast._tag === "Unknown" || ast._tag === "Any") return "Value"
    if (ast._tag === "Declaration") {
      if (ast.typeParameters.length === 1) return build(ast.typeParameters[0], name)
      const constructor = ast.annotations?.typeConstructor
      if (
        typeof constructor === "object" &&
        constructor !== null &&
        "_tag" in constructor &&
        constructor._tag === "effect/Json"
      )
        return "Value"
      if (isUtcDeclaration(ast)) return "double"
      throw new Error(`${hint}: unsupported declaration ${JSON.stringify(ast.annotations)}`)
    }
    if (ast._tag === "Union") {
      const types = ast.context?.isOptional ? ast.types.filter((type) => type._tag !== "Undefined") : ast.types
      if (types.length === 1) return build(types[0], name)
      if (types.every((type) => type._tag === "Literal" && typeof type.literal === "string")) {
        enums.set(
          name,
          types.flatMap((type) => (type._tag === "Literal" && typeof type.literal === "string" ? [type.literal] : [])),
        )
        return name
      }
      if (messages.has(name)) return name
      messages.set(name, { fields: [], oneof: true })
      const fields = types.map((type, index) => ({
        name: type._tag === "Null" ? "clear" : type._tag === "Undefined" ? "none" : `value_${index + 1}`,
        type: build(type, `${name}Value${index + 1}`),
        presence: "oneof" as const,
        constraints: checks(type),
        ast: type,
        source: checks(type).length ? sourceIdentity(type, name) : undefined,
      }))
      messages.set(name, { fields, oneof: true })
      return name
    }
    if (messages.has(name)) return name
    messages.set(name, { fields: [], oneof: false })
    if (ast._tag === "Arrays") {
      if (ast.rest.length !== 1 || ast.elements.some((element) => element !== ast.rest[0]))
        throw new Error(`${name}: unsupported tuple`)
      messages.set(name, {
        fields: [
          {
            name: "items",
            type: build(ast.rest[0], `${name}Item`),
            presence: "repeated",
            constraints: [
              ...checks(ast),
              ...checks(ast.rest[0]),
              ...(ast.elements.length
                ? [
                    {
                      "~structural": true as const,
                      meta: { _tag: "isMinLength" as const, minLength: ast.elements.length },
                    },
                  ]
                : []),
            ],
            ast: ast.rest[0],
            source: checks(ast).length || checks(ast.rest[0]).length ? sourceIdentity(ast, name) : undefined,
          },
        ],
        oneof: false,
      })
      return name
    }
    if (ast._tag === "Objects") {
      if (ast.indexSignatures.length) {
        if (ast.propertySignatures.length || ast.indexSignatures.length !== 1) throw new Error(`${name}: mixed record`)
        const entry = `${name}Entry`
        messages.set(entry, {
          fields: [
            {
              name: "key",
              type: build(ast.indexSignatures[0].parameter, `${entry}Key`),
              presence: "required",
              constraints: checks(ast.indexSignatures[0].parameter),
              ast: ast.indexSignatures[0].parameter,
              source: checks(ast.indexSignatures[0].parameter).length
                ? sourceIdentity(ast.indexSignatures[0].parameter, name)
                : undefined,
            },
            {
              name: "value",
              type: build(ast.indexSignatures[0].type, `${entry}Value`),
              presence: "required",
              constraints: checks(ast.indexSignatures[0].type),
              ast: ast.indexSignatures[0].type,
              source: checks(ast.indexSignatures[0].type).length
                ? sourceIdentity(ast.indexSignatures[0].type, name)
                : undefined,
            },
          ],
          oneof: false,
        })
        messages.set(name, {
          fields: [
            {
              name: "entries",
              type: entry,
              presence: "repeated",
              constraints: checks(ast),
              ast,
              source: checks(ast).length ? sourceIdentity(ast, name) : undefined,
            },
          ],
          oneof: false,
        })
        return name
      }
      messages.set(name, {
        fields: ast.propertySignatures
          .filter(
            (property) =>
              !(
                property.type.context?.isOptional &&
                property.type._tag === "Union" &&
                property.type.types.every((type) => type._tag === "Never" || type._tag === "Undefined")
              ),
          )
          .map((property) => ({
            name: identifier(String(property.name)),
            type: build(property.type, `${name}_${String(property.name)}`),
            presence: property.type.context?.isOptional ? "optional" : "required",
            constraints: checks(property.type),
            ast: property.type,
            source:
              checks(property.type).length ||
              (property.type._tag === "Literal" && typeof property.type.literal !== "string")
                ? sourceIdentity(property.type, name)
                : undefined,
          })),
        oneof: false,
      })
      return name
    }
    throw new Error(`${hint}: unsupported AST ${ast._tag}`)
  }
  const operations = endpoints.map(({ group, endpoint }) => {
    const name = identifier(endpoint.identifier)
    const request = `${name}_Request`
    const requestFields = [
      endpoint.params && { name: "params", schema: endpoint.params },
      endpoint.query && { name: "query", schema: endpoint.query },
      endpoint.headers && { name: "headers", schema: endpoint.headers },
      ...Array.from(endpoint.payload.values()).flatMap((payload) =>
        payload.schemas.map((schema) => ({ name: "payload", schema })),
      ),
    ]
      .filter((value): value is NonNullable<typeof value> => !!value)
      .map((value) => ({
        name: value.name,
        type: build(value.schema.ast, `${request}_${value.name}`),
        presence: "required" as const,
        constraints: checks(value.schema.ast),
        ast: value.schema.ast,
        source: checks(value.schema.ast).length ? sourceIdentity(value.schema.ast, request) : undefined,
      }))
    messages.set(request, { fields: requestFields, oneof: false })
    const result = resultNames[endpoint.identifier] ?? `${name}_Result`
    const success = Array.from(endpoint.success)
    if (success.length !== 1) throw new Error(`${name}: expected one success schema`)
    const resultType = build(success[0].ast, result)
    if (resultType !== result)
      messages.set(result, {
        fields: [
          {
            name: "data",
            type: resultType,
            presence: "required",
            constraints: checks(success[0].ast),
            ast: success[0].ast,
            source: checks(success[0].ast).length ? sourceIdentity(success[0].ast, result) : undefined,
          },
        ],
        oneof: false,
      })
    return {
      id: ids[endpoint.identifier],
      name: endpoint.identifier,
      rpc: name,
      group,
      request,
      result,
      errors: Array.from(
        new Set([...endpoint.error, ...middlewareErrors].map((error) => build(error.ast, `${name}_Error`))),
      ),
      method: endpoint.method,
    }
  })
  declarations.forEach((schema) => {
    const name = schema.ast.annotations?.identifier
    if (typeof name !== "string") throw new Error("additional declaration requires a source identifier")
    build(schema.ast, name)
  })
  return { messages, enums, operations }
}

export function wireSharedSet(
  contract: ReturnType<typeof wireContract>,
  endpoints: Parameters<typeof wireContract>[0],
  errors: readonly Schema.Top[],
) {
  const names = new Set<string>()
  const seen = new Set<SchemaAST.AST>()
  const visit = (input: SchemaAST.AST) => {
    const ast = Schema.toType(Schema.make(input)).ast
    if (seen.has(ast)) return
    seen.add(ast)
    if (typeof ast.annotations?.identifier === "string") names.add(identifier(ast.annotations.identifier))
    if (ast._tag === "Declaration") ast.typeParameters.forEach(visit)
    if (ast._tag === "Objects") {
      ast.propertySignatures.forEach((property) => visit(property.type))
      ast.indexSignatures.forEach((signature) => {
        visit(signature.parameter)
        visit(signature.type)
      })
    }
    if (ast._tag === "Arrays") {
      ast.elements.forEach(visit)
      ast.rest.forEach(visit)
    }
    if (ast._tag === "Union") ast.types.forEach(visit)
    if (ast._tag === "Suspend") visit(ast.thunk())
  }
  endpoints.forEach(({ endpoint }) => {
    if (endpoint.params) visit(endpoint.params.ast)
    if (endpoint.query) visit(endpoint.query.ast)
    for (const payload of endpoint.payload.values()) payload.schemas.forEach((schema) => visit(schema.ast))
    endpoint.success.forEach((schema) => visit(isWireSse(schema) ? schema.events.ast : schema.ast))
    endpoint.error.forEach((schema) => visit(schema.ast))
  })
  errors.forEach((error) => visit(error.ast))
  const shared = new Set<string>()
  const include = (name: string) => {
    if (shared.has(name) || (!contract.messages.has(name) && !contract.enums.has(name))) return
    shared.add(name)
    contract.messages.get(name)?.fields.forEach((field) => include(field.type))
  }
  names.forEach(include)
  return shared
}

export function isWireSse(schema: Schema.Top): schema is Extract<HttpApiSchema.StreamSchema, { _tag: "StreamSse" }> {
  return "_tag" in schema && schema._tag === "StreamSse"
}

export function isUtcDeclaration(ast: SchemaAST.AST) {
  const constructor = ast.annotations?.typeConstructor
  return (
    ast._tag === "Declaration" &&
    typeof constructor === "object" &&
    constructor !== null &&
    "_tag" in constructor &&
    constructor._tag === "effect/DateTime.Utc"
  )
}
