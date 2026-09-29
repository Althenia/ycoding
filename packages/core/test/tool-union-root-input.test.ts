import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM } from "@ycoding-ai/ai"
import { AnthropicMessages, Gemini, OpenAIChat, OpenAIResponses } from "@ycoding-ai/ai/protocols"
import { AmazonBedrock } from "@ycoding-ai/ai/providers"
import { Auth, LLMClient } from "@ycoding-ai/ai/route"
import { BrowserTool } from "@ycoding-ai/core/tool/browser"
import { ComputerTool } from "@ycoding-ai/core/tool/computer"
import { MemoryTool } from "@ycoding-ai/core/tool/memory"
import { ProjectArtifactTool } from "@ycoding-ai/core/tool/project-artifact"
import { SubagentControlTool } from "@ycoding-ai/core/tool/subagent-control"
import { SubagentReportTool } from "@ycoding-ai/core/tool/subagent-report"
import { Tool } from "@ycoding-ai/core/tool/tool"

const calculator = { platform: "macos", bundle_id: "com.apple.calculator", pid: 42, window_id: 7, expected_revision: "r1" }
const chrome = { platform: "macos", bundle_id: "com.google.Chrome", window_id: "w1", expected_revision: "r1" }
const browserAction = {
  operation: "action",
  mode: "owned",
  tabID: "btab_1",
  generation: 1,
  documentGeneration: 2,
  observationRevision: 0,
  action: { type: "capture" },
}

const cases = [
  { tool: "memory", input: MemoryTool.Input, parameter: "limit", types: ["integer"], sample: { action: "search", query: "x", limit: 10 }, value: 10 },
  { tool: "memory", input: MemoryTool.Input, parameter: "offset", types: ["integer"], sample: { action: "list", offset: 5 }, value: 5 },
  { tool: "memory", input: MemoryTool.Input, parameter: "dryRun", types: ["boolean"], sample: { action: "vacuum", dryRun: false }, value: false },
  { tool: "browser", input: BrowserTool.Input, parameter: "generation", types: ["integer", "string"], sample: { operation: "open", mode: "owned", generation: 3, url: "https://example.test" }, value: 3 },
  { tool: "browser", input: BrowserTool.Input, parameter: "documentGeneration", types: ["integer", "string"], sample: browserAction, value: 2 },
  { tool: "browser", input: BrowserTool.Input, parameter: "observationRevision", types: ["integer", "string"], sample: browserAction, value: 0 },
  { tool: "browser", input: BrowserTool.Input, parameter: "action", types: ["object", "string"], sample: { ...browserAction, action: { type: "scroll", deltaY: 120 } }, value: { type: "scroll", deltaY: 120 } },
  { tool: "computer", input: ComputerTool.Input, parameter: "pid", types: ["integer", "string"], sample: { action: "desktop.inspect", ...calculator }, value: 42 },
  { tool: "computer", input: ComputerTool.Input, parameter: "window_id", types: ["integer", "string"], sample: { action: "desktop.inspect", ...calculator }, value: 7 },
  { tool: "computer", input: ComputerTool.Input, parameter: "tab_index", types: ["integer", "string"], sample: { action: "webbrowser.back", ...chrome, tab_index: 2 }, value: 2 },
  { tool: "computer", input: ComputerTool.Input, parameter: "x", types: ["integer", "string"], sample: { action: "desktop.click", ...calculator, x: 1, y: 2 }, value: 1 },
  { tool: "computer", input: ComputerTool.Input, parameter: "y", types: ["integer", "string"], sample: { action: "desktop.click", ...calculator, x: 1, y: 2 }, value: 2 },
  { tool: "computer", input: ComputerTool.Input, parameter: "count", types: ["integer", "string"], sample: { action: "desktop.click", ...calculator, x: 1, y: 2, count: 2 }, value: 2 },
  { tool: "computer", input: ComputerTool.Input, parameter: "delta_x", types: ["integer", "string"], sample: { action: "desktop.scroll", ...calculator, x: 1, y: 2, delta_x: -3, delta_y: 4 }, value: -3 },
  { tool: "computer", input: ComputerTool.Input, parameter: "delta_y", types: ["integer", "string"], sample: { action: "desktop.scroll", ...calculator, x: 1, y: 2, delta_x: -3, delta_y: 4 }, value: 4 },
  { tool: "computer", input: ComputerTool.Input, parameter: "from_x", types: ["integer", "string"], sample: { action: "desktop.drag", ...calculator, from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, value: 1 },
  { tool: "computer", input: ComputerTool.Input, parameter: "from_y", types: ["integer", "string"], sample: { action: "desktop.drag", ...calculator, from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, value: 2 },
  { tool: "computer", input: ComputerTool.Input, parameter: "to_x", types: ["integer", "string"], sample: { action: "desktop.drag", ...calculator, from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, value: 3 },
  { tool: "computer", input: ComputerTool.Input, parameter: "to_y", types: ["integer", "string"], sample: { action: "desktop.drag", ...calculator, from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, value: 4 },
  { tool: "computer", input: ComputerTool.Input, parameter: "element", types: ["array"], sample: { action: "desktop.click", ...calculator, element: [4, 0, 9] }, value: [4, 0, 9] },
  { tool: "computer", input: ComputerTool.Input, parameter: "modifiers", types: ["array"], sample: { action: "desktop.key", ...calculator, key: "a", modifiers: ["control", "command"] }, value: ["control", "command"] },
  { tool: "computer", input: ComputerTool.Input, parameter: "newline", types: ["boolean"], sample: { action: "iterm.send_text", platform: "macos", window_id: 1, tab_index: 1, session_id: "s", expected_revision: "r1", text: "ls", newline: true }, value: true },
  { tool: "computer", input: ComputerTool.Input, parameter: "remote_debugging", types: ["boolean"], sample: { action: "desktop.launch", platform: "macos", bundle_id: "com.apple.calculator", remote_debugging: true }, value: true },
  {
    tool: "project_artifact",
    input: ProjectArtifactTool.Input,
    parameter: "permissions",
    types: ["array"],
    sample: {
      kind: "agent",
      id: "reviewer",
      insight_key: "k",
      name: "Reviewer",
      description: "Reviews.",
      system: "Review.",
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    },
    value: [{ action: "read", resource: "*", effect: "allow" }],
  },
] as const

const definition = (tool: (typeof cases)[number]["tool"], input: (typeof cases)[number]["input"]) =>
  Tool.definition(tool, Tool.make({ description: tool, input, output: Schema.Unknown, execute: () => Effect.succeed(null) }))

const at = (value: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce(
    (current, key) => (typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined),
    value,
  )

const declaredTypes = (root: unknown, property: unknown): ReadonlyArray<string> => {
  if (typeof property !== "object" || property === null) return []
  const type = Reflect.get(property, "type")
  if (typeof type === "string") return [type]
  const reference = Reflect.get(property, "$ref")
  if (typeof reference === "string") return declaredTypes(root, at(root, "$defs", reference.replace("#/$defs/", "")))
  const options = Reflect.get(property, "anyOf")
  if (Array.isArray(options)) return [...new Set(options.flatMap((option) => declaredTypes(root, option)))]
  return []
}

const baseURL = "https://provider.test/v1/"
const providers = [
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

const answer = { choice: ["a", 1, true], nested: { depth: 2 } }
const jsonCases = [
  {
    tool: "subagent_control",
    input: SubagentControlTool.Input,
    sample: { action: "answer", sessionID: "ses_child", questionID: "qst_1", data: answer },
  },
  { tool: "subagent_report", input: SubagentReportTool.Input, sample: { action: "question", text: "Which?", data: answer } },
] as const

describe("union-root tool arguments", () => {
  for (const item of cases)
    test(`${item.tool}.${item.parameter} decodes to its typed value`, () => {
      const decoded = Schema.decodeUnknownSync(item.input)(item.sample)

      expect(at(decoded, item.parameter)).toEqual(item.value)
    })

  for (const item of jsonCases)
    test(`${item.tool}.data decodes an arbitrary JSON object without stringifying it`, () => {
      const decoded = Schema.decodeUnknownSync(item.input)(item.sample)

      expect(at(decoded, "data")).toEqual(answer)
    })

  for (const provider of providers)
    test(`${provider.name} declares every affected parameter's type at the top level`, async () => {
      for (const tool of new Set(cases.map((item) => item.tool))) {
        const item = cases.find((candidate) => candidate.tool === tool)
        if (item === undefined) throw new Error(`missing case for ${tool}`)
        const prepared = await Effect.runPromise(
          LLMClient.prepare(
            LLM.request({
              model: provider.model,
              prompt: "Use the tool.",
              tools: [definition(item.tool, item.input)],
            }),
          ),
        )
        const schema = provider.schema(prepared.body)

        expect(at(schema, "type")).toBe("object")
        for (const affected of cases.filter((candidate) => candidate.tool === tool))
          expect([...declaredTypes(schema, at(schema, "properties", affected.parameter))].sort()).toEqual([
            ...affected.types,
          ])
      }
    })
})
