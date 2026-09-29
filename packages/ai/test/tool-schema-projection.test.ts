import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src"
import { AnthropicMessages, OpenAIChat, OpenAIResponses } from "../src/protocols"
import { ToolSchemaProjection } from "../src/protocols/utils/tool-schema"
import { Auth, LLMClient } from "../src/route"
import { isRecord } from "../src/utils/record"
import { it } from "./lib/effect"

const typedUnion = {
  $defs: { Rules: { type: "array", items: { type: "string" } } },
  anyOf: [
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list"] },
        limit: { type: "integer", maximum: 100 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search"] },
        limit: { type: "integer", maximum: 50 },
        ratio: { type: "number" },
        dryRun: { type: "boolean" },
        modifiers: { type: "array", items: { type: "string" } },
        options: { type: "object", properties: { depth: { type: "integer" } } },
        rules: { anyOf: [{ not: {} }, { $ref: "#/$defs/Rules" }] },
      },
      required: ["action"],
      additionalProperties: false,
    },
  ],
}

const typedParameters = {
  limit: "integer",
  ratio: "number",
  dryRun: "boolean",
  modifiers: "array",
  options: "object",
  rules: "array",
} as const

const at = (value: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce((current, key) => (isRecord(current) || Array.isArray(current) ? Reflect.get(current, key) : undefined), value)

const declaredTypes = (root: unknown, property: unknown): ReadonlyArray<string> => {
  if (!isRecord(property)) return []
  if (typeof property.type === "string") return [property.type]
  if (typeof property.$ref === "string") return declaredTypes(root, at(root, "$defs", property.$ref.replace("#/$defs/", "")))
  if (Array.isArray(property.anyOf)) return [...new Set(property.anyOf.flatMap((option) => declaredTypes(root, option)))]
  return []
}

const baseURL = "https://provider.test/v1/"
const anthropicRoot = (schema: unknown) => at(schema, "$defs", "__ycoding_root")
const providerRoutes = [
  {
    name: "anthropic",
    model: AnthropicMessages.route
      .with({ endpoint: { baseURL }, auth: Auth.header("x-api-key", "test") })
      .model({ id: "claude-opus-5-5" }),
    schema: (body: unknown) => at(body, "tools", 0, "input_schema"),
    typed: anthropicRoot,
  },
  {
    name: "openai chat",
    model: OpenAIChat.route.with({ endpoint: { baseURL }, auth: Auth.bearer("test") }).model({ id: "gpt-4.1-mini" }),
    schema: (body: unknown) => at(body, "tools", 0, "function", "parameters"),
    typed: (schema: unknown) => schema,
  },
  {
    name: "openai responses",
    model: OpenAIResponses.route
      .with({ endpoint: { baseURL }, auth: Auth.bearer("test") })
      .model({ id: "gpt-4.1-mini" }),
    schema: (body: unknown) => at(body, "tools", 0, "parameters"),
    typed: (schema: unknown) => schema,
  },
  {
    name: "moonshot on openai chat",
    model: OpenAIChat.route
      .with({ endpoint: { baseURL }, auth: Auth.bearer("test") })
      .model({ id: "kimi-k2", compatibility: { toolSchema: "moonshot" } }),
    schema: (body: unknown) => at(body, "tools", 0, "function", "parameters"),
    typed: (schema: unknown) => schema,
  },
  {
    name: "moonshot on anthropic",
    model: AnthropicMessages.route
      .with({ endpoint: { baseURL }, auth: Auth.header("x-api-key", "test") })
      .model({ id: "claude-opus-5-5", compatibility: { toolSchema: "moonshot" } }),
    schema: (body: unknown) => at(body, "tools", 0, "input_schema"),
    typed: anthropicRoot,
  },
]

describe("tool schema projections", () => {
  test("moonshot strips $ref siblings and converts tuple arrays to a schema object", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          linked: { $ref: "#/$defs/Linked", description: "drop me" },
          tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
          prefixTuple: { type: "array", prefixItems: [{ type: "boolean" }, { type: "string" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        linked: { $ref: "#/$defs/Linked" },
        tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        prefixTuple: { type: "array", items: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
      },
    })
  })

  test("gemini handles numeric enums, dangling required fields, untyped arrays, and scalar object keys", () => {
    expect(
      ToolSchemaProjection.gemini({
        type: "object",
        required: ["status", "missing"],
        properties: {
          status: { type: "integer", enum: [1, 2] },
          tags: { type: "array" },
          name: { type: "string", properties: { ignored: { type: "string" } }, required: ["ignored"] },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["1", "2"] },
        tags: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
    })
  })

  test("anthropic preserves discriminated unions while requiring an object root", () => {
    const union = {
      anyOf: [
        {
          type: "object",
          properties: { action: { type: "string", enum: ["list"] } },
          required: ["action"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["send"] },
            text: { type: "string" },
          },
          required: ["action", "text"],
          additionalProperties: false,
        },
      ],
    }

    expect(ToolSchemaProjection.anthropic(union)).toEqual({
      type: "object",
      $ref: "#/$defs/__ycoding_root",
      $defs: {
        __ycoding_root: {
          type: "object",
          ...union,
          properties: {
            action: {
              type: "string",
              anyOf: [
                { type: "string", enum: ["list"] },
                { type: "string", enum: ["send"] },
              ],
            },
            text: { type: "string" },
          },
          required: ["action"],
        },
      },
    })
    expect(ToolSchemaProjection.anthropic({ type: "string", enum: ["value"] })).toEqual({
      type: "string",
      enum: ["value"],
    })
  })

  test("anthropic declares each union-root parameter type in the referenced root in stable order", () => {
    const projected = ToolSchemaProjection.anthropic(typedUnion)

    expect(projected).toEqual({
      type: "object",
      $ref: "#/$defs/__ycoding_root",
      $defs: {
        Rules: typedUnion.$defs.Rules,
        __ycoding_root: {
          type: "object",
          anyOf: typedUnion.anyOf,
          properties: {
            action: {
              type: "string",
              anyOf: [
                { type: "string", enum: ["list"] },
                { type: "string", enum: ["search"] },
              ],
            },
            limit: {
              type: "integer",
              anyOf: [
                { type: "integer", maximum: 100 },
                { type: "integer", maximum: 50 },
              ],
            },
            ratio: { type: "number" },
            dryRun: { type: "boolean" },
            modifiers: { type: "array", items: { type: "string" } },
            options: { type: "object", properties: { depth: { type: "integer" } } },
            rules: { type: "array", anyOf: [{ not: {} }, { $ref: "#/$defs/Rules" }] },
          },
          required: ["action"],
        },
      },
    })
    expect(Object.keys(projected)).toEqual(["type", "$ref", "$defs"])
    const root = anthropicRoot(projected)
    expect(isRecord(root) ? Object.keys(root) : []).toEqual(["anyOf", "type", "properties", "required"])
    const properties = at(root, "properties")
    expect(isRecord(properties) ? Object.keys(properties) : []).toEqual([
      "action",
      "limit",
      "ratio",
      "dryRun",
      "modifiers",
      "options",
      "rules",
    ])
    expect(JSON.stringify(ToolSchemaProjection.anthropic(typedUnion))).toBe(JSON.stringify(projected))
  })

  test("anthropic keeps mixed-type alternatives unhoisted", () => {
    const projected = ToolSchemaProjection.anthropic({
      anyOf: [
        {
          type: "object",
          properties: { id: { anyOf: [{ type: "integer" }, { type: "string" }] } },
          required: ["id"],
        },
      ],
    })

    expect(at(anthropicRoot(projected), "properties", "id")).toEqual({ anyOf: [{ type: "integer" }, { type: "string" }] })
  })

  test("anthropic projects a union over a self-referential definition without recursing forever", () => {
    const recursive = (json: unknown) =>
      ToolSchemaProjection.anthropic({
        anyOf: [{ type: "object", properties: { value: { $ref: "#/$defs/Json" } }, required: ["value"] }],
        $defs: { Json: json },
      })

    expect(
      at(anthropicRoot(recursive({ anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/Json" } }] })), "properties", "value"),
    ).toEqual({ $ref: "#/$defs/Json" })
    expect(at(anthropicRoot(recursive({ anyOf: [{ $ref: "#/$defs/Json" }] })), "properties", "value")).toEqual({
      $ref: "#/$defs/Json",
    })
    expect(at(anthropicRoot(recursive({ anyOf: [{ type: "string" }, { $ref: "#/$defs/Json" }] })), "properties", "value")).toEqual({
      type: "string",
      $ref: "#/$defs/Json",
    })
  })

  test("anthropic keeps the root's own properties and required fields beside union alternatives", () => {
    const root = anthropicRoot(
      ToolSchemaProjection.anthropic({
        type: "object",
        properties: { name: { type: "string" }, count: { type: "number" } },
        required: ["name"],
        anyOf: [{ required: ["name"] }, { required: ["count"] }],
      }),
    )

    expect(at(root, "properties")).toEqual({ name: { type: "string" }, count: { type: "number" } })
    expect(at(root, "required")).toEqual(["name"])
  })

  test("anthropic merges the root's own properties and required fields with the alternatives'", () => {
    const root = anthropicRoot(
      ToolSchemaProjection.anthropic({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        anyOf: [
          { type: "object", properties: { mode: { type: "string", enum: ["a"] }, size: { type: "integer" } }, required: ["mode"] },
          { type: "object", properties: { mode: { type: "string", enum: ["b"] } }, required: ["mode"] },
        ],
      }),
    )

    expect(at(root, "properties")).toEqual({
      mode: { type: "string", anyOf: [{ type: "string", enum: ["a"] }, { type: "string", enum: ["b"] }] },
      size: { type: "integer" },
      name: { type: "string" },
    })
    expect(at(root, "required")).toEqual(["name", "mode"])
  })

  test("anthropic keeps root properties when every alternative is a reference", () => {
    const root = anthropicRoot(
      ToolSchemaProjection.anthropic({
        type: "object",
        properties: { name: { type: "string" } },
        anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
        $defs: { A: { required: ["name"] }, B: { required: ["other"] } },
      }),
    )

    expect(at(root, "properties")).toEqual({ name: { type: "string" } })
  })

  test("anthropic leaves a property untyped when an alternative is array-typed, untyped, or unresolvable", () => {
    const property = (alternative: unknown) =>
      at(
        anthropicRoot(
          ToolSchemaProjection.anthropic({
            anyOf: [
              { type: "object", properties: { value: { type: "string" } } },
              { type: "object", properties: { value: alternative } },
            ],
          }),
        ),
        "properties",
        "value",
      )

    expect(property({ type: ["integer", "null"] })).toEqual({ anyOf: [{ type: "string" }, { type: ["integer", "null"] }] })
    expect(property({})).toEqual({ anyOf: [{ type: "string" }, {}] })
    expect(property({ enum: [1, 2] })).toEqual({ anyOf: [{ type: "string" }, { enum: [1, 2] }] })
    expect(property({ $ref: "#/definitions/Missing" })).toEqual({
      anyOf: [{ type: "string" }, { $ref: "#/definitions/Missing" }],
    })
  })

  for (const provider of providerRoutes) {
    it.effect(`${provider.name} exposes every union-root parameter type at the top level`, () =>
      Effect.gen(function* () {
        const prepared = yield* LLMClient.prepare(
          LLM.request({
            model: provider.model,
            prompt: "Use the tool.",
            tools: [{ name: "typed", description: "Typed union tool.", inputSchema: typedUnion }],
          }),
        )
        const schema = provider.schema(prepared.body)
        const typed = provider.typed(schema)

        expect(at(typed, "type")).toBe("object")
        expect(at(typed, "required")).toEqual(["action"])
        for (const [name, type] of Object.entries(typedParameters))
          expect(declaredTypes(schema, at(typed, "properties", name))).toEqual([type])
      }),
    )
  }

  it.effect("anthropic routes declare the type on each property of the referenced root and none beside the reference", () =>
    Effect.gen(function* () {
      for (const provider of providerRoutes.filter((route) => route.name.includes("anthropic"))) {
        const prepared = yield* LLMClient.prepare(
          LLM.request({
            model: provider.model,
            prompt: "Use the tool.",
            tools: [{ name: "typed", description: "Typed union tool.", inputSchema: typedUnion }],
          }),
        )
        const schema = provider.schema(prepared.body)

        expect(Object.keys(isRecord(schema) ? schema : {})).toEqual(["type", "$ref", "$defs"])
        for (const [name, type] of Object.entries(typedParameters))
          expect(at(provider.typed(schema), "properties", name, "type")).toBe(type)
      }
    }),
  )

  test("anthropic keeps existing definitions when choosing its internal root name", () => {
    const schema = {
      $defs: {
        Existing: { type: "object", properties: { value: { type: "string" } } },
        __ycoding_root: { type: "string" },
      },
      oneOf: [
        {
          type: "object",
          properties: { nested: { $ref: "#/$defs/Existing" } },
          required: ["nested"],
          additionalProperties: false,
        },
      ],
    }

    expect(ToolSchemaProjection.anthropic(schema)).toEqual({
      type: "object",
      $ref: "#/$defs/__ycoding_root_1",
      $defs: {
        ...schema.$defs,
        __ycoding_root_1: { type: "object", oneOf: schema.oneOf },
      },
    })
  })

  test("openai keeps one flat object top-level schema", () => {
    expect(
      ToolSchemaProjection.openAI({
        anyOf: [
          {
            type: "object",
            properties: {
              path: { type: "string" },
              maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          { type: "object", properties: { resource: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        maybe: { type: "string" },
        resource: { type: "string" },
      },
      additionalProperties: false,
    })
  })

  test("openai preserves property alternatives and common requirements when flattening object unions", () => {
    expect(
      ToolSchemaProjection.openAI({
        anyOf: [
          {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list"] },
              scope: { type: "string", enum: ["repository", "knowledge"] },
              limit: { type: "integer", maximum: 100 },
            },
            required: ["action"],
          },
          {
            type: "object",
            properties: {
              action: { type: "string", enum: ["search"] },
              scope: { type: "string", enum: ["repository", "knowledge"] },
              limit: { type: "integer", maximum: 50 },
              query: { type: "string" },
            },
            required: ["action", "query"],
          },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        action: {
          anyOf: [
            { type: "string", enum: ["list"] },
            { type: "string", enum: ["search"] },
          ],
        },
        scope: { type: "string", enum: ["repository", "knowledge"] },
        limit: {
          anyOf: [
            { type: "integer", maximum: 100 },
            { type: "integer", maximum: 50 },
          ],
        },
        query: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    })
  })

  it.effect("applies model compatibility before protocol projection", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "kimi-k2", compatibility: { toolSchema: "moonshot" } })
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "Use the tool.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
                      linked: { $ref: "#/$defs/Linked", description: "drop me" },
                    },
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools?.[0]?.function.parameters).toEqual({
        type: "object",
        properties: {
          tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
          linked: { $ref: "#/$defs/Linked" },
        },
        additionalProperties: false,
      })
    }),
  )
})
