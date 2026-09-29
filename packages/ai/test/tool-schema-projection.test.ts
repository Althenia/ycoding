import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src"
import { AnthropicMessages, Gemini, OpenAIChat, OpenAIResponses } from "../src/protocols"
import { ToolSchemaProjection } from "../src/protocols/utils/tool-schema"
import { AmazonBedrock } from "../src/providers"
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
const providerRoutes = [
  {
    name: "anthropic",
    model: AnthropicMessages.route
      .with({ endpoint: { baseURL }, auth: Auth.header("x-api-key", "test") })
      .model({ id: "claude-opus-5-5" }),
    schema: (body: unknown) => at(body, "tools", 0, "input_schema"),
  },
  {
    name: "openai chat",
    model: OpenAIChat.route.with({ endpoint: { baseURL }, auth: Auth.bearer("test") }).model({ id: "gpt-4.1-mini" }),
    schema: (body: unknown) => at(body, "tools", 0, "function", "parameters"),
  },
  {
    name: "openai responses",
    model: OpenAIResponses.route
      .with({ endpoint: { baseURL }, auth: Auth.bearer("test") })
      .model({ id: "gpt-4.1-mini" }),
    schema: (body: unknown) => at(body, "tools", 0, "parameters"),
  },
  {
    name: "gemini",
    model: Gemini.route
      .with({ endpoint: { baseURL }, auth: Auth.header("x-goog-api-key", "test") })
      .model({ id: "gemini-2.5-flash" }),
    schema: (body: unknown) => at(body, "tools", 0, "functionDeclarations", 0, "parameters"),
  },
  {
    name: "moonshot on openai chat",
    model: OpenAIChat.route
      .with({ endpoint: { baseURL }, auth: Auth.bearer("test") })
      .model({ id: "kimi-k2", compatibility: { toolSchema: "moonshot" } }),
    schema: (body: unknown) => at(body, "tools", 0, "function", "parameters"),
  },
  {
    name: "moonshot on anthropic",
    model: AnthropicMessages.route
      .with({ endpoint: { baseURL }, auth: Auth.header("x-api-key", "test") })
      .model({ id: "claude-opus-5-5", compatibility: { toolSchema: "moonshot" } }),
    schema: (body: unknown) => at(body, "tools", 0, "input_schema"),
  },
  {
    name: "default bedrock converse",
    model: AmazonBedrock.configure({ baseURL: "https://bedrock-runtime.test", apiKey: "test-bearer" }).model(
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
    ),
    schema: (body: unknown) => at(body, "toolConfig", "tools", 0, "toolSpec", "inputSchema", "json"),
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
      $ref: "#/$defs/__ycoding_root",
      $defs: {
        __ycoding_root: { type: "object", ...union },
      },
    })
    expect(ToolSchemaProjection.anthropic({ type: "string", enum: ["value"] })).toEqual({
      type: "string",
      enum: ["value"],
    })
  })

  test("anthropic declares each union-root parameter type at the top level in stable order", () => {
    const projected = ToolSchemaProjection.anthropic(typedUnion)

    expect(projected).toEqual({
      type: "object",
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
      $ref: "#/$defs/__ycoding_root",
      $defs: {
        Rules: typedUnion.$defs.Rules,
        __ycoding_root: { type: "object", anyOf: typedUnion.anyOf },
      },
    })
    expect(Object.keys(projected)).toEqual(["type", "properties", "required", "$ref", "$defs"])
    const properties = at(projected, "properties")
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

    expect(at(projected, "properties", "id")).toEqual({ anyOf: [{ type: "integer" }, { type: "string" }] })
  })

  test("object root keeps the union and adds an object type with top-level properties", () => {
    const projected = ToolSchemaProjection.objectRoot(typedUnion)

    expect(projected).toEqual({
      $defs: typedUnion.$defs,
      anyOf: typedUnion.anyOf,
      type: "object",
      properties: {
        action: {
          anyOf: [
            { type: "string", enum: ["list"] },
            { type: "string", enum: ["search"] },
          ],
        },
        limit: {
          anyOf: [
            { type: "integer", maximum: 100 },
            { type: "integer", maximum: 50 },
          ],
        },
        ratio: { type: "number" },
        dryRun: { type: "boolean" },
        modifiers: { type: "array", items: { type: "string" } },
        options: { type: "object", properties: { depth: { type: "integer" } } },
        rules: { anyOf: [{ not: {} }, { $ref: "#/$defs/Rules" }] },
      },
      required: ["action"],
    })
    const object = { type: "object", properties: { path: { type: "string" } } }
    expect(ToolSchemaProjection.objectRoot(object)).toEqual(object)
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

        expect(at(schema, "type")).toBe("object")
        expect(at(schema, "required")).toEqual(["action"])
        for (const [name, type] of Object.entries(typedParameters))
          expect(declaredTypes(schema, at(schema, "properties", name))).toEqual([type])
      }),
    )
  }

  it.effect("anthropic routes declare the type on each top-level property itself", () =>
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

        for (const [name, type] of Object.entries(typedParameters))
          expect(at(schema, "properties", name, "type")).toBe(type)
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
