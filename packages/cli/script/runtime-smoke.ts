#!/usr/bin/env bun

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { YCoding } from "@ycoding-ai/client/promise"
import { BUN_BINARY, platformBinary } from "../src/binary"

const KEY = "runtime-smoke-openrouter-key"
const PASSWORD = "runtime-smoke-password"
const MODEL_ID = "smoke-model"
const PROVIDER_ID = "openrouter"
const OPENAI_MODEL_ID = "gpt-5.6"
const OPENAI_PROVIDER_ID = "openai"
const MCP_SERVER = "runtime-catalog"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function assertClose(actual: number | undefined, expected: number, label: string) {
  if (actual === undefined || Math.abs(actual - expected) > 1e-12)
    throw new Error(`${label}: expected ${expected}, got ${actual ?? "unavailable"}`)
}

async function eventually<T>(fn: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw new Error("Timed out waiting for runtime smoke condition", { cause: lastError })
}

type ProviderBody = Record<string, unknown> & {
  readonly model?: unknown
  readonly max_tokens?: unknown
  readonly messages?: unknown
  readonly input?: unknown
  readonly store?: unknown
  readonly previous_response_id?: unknown
  readonly tools?: unknown
}

function eventStream(...events: ReadonlyArray<Record<string, unknown>>) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
}

function streamResponse(input: {
  index: number
  content: string
  cached?: number
  cacheWrite?: number
  prompt?: number
}) {
  const cached = input.cached ?? (input.index === 1 ? 0 : 900)
  const cacheWrite = input.cacheWrite ?? (input.index === 1 ? 100 : 0)
  const prompt = input.prompt ?? (input.index === 1 ? 1000 : 1200)
  const id = `runtime-smoke-${input.index}`
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      provider: "Smoke",
      choices: [
        { index: 0, delta: { role: "assistant", content: input.content }, finish_reason: null, native_finish_reason: null },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      provider: "Smoke",
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop", native_finish_reason: "stop" }],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: 10,
        total_tokens: prompt + 10,
        cost: 0.001,
        prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
  ]
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
}

function toolCallResponse(input: {
  index: number
  callID: string
  name: string
  arguments: Record<string, unknown>
  prompt: number
  cached: number
  cacheWrite: number
}) {
  const id = `runtime-smoke-${input.index}`
  return eventStream(
    {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      provider: "Smoke",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: input.callID,
                type: "function",
                function: { name: input.name, arguments: JSON.stringify(input.arguments) },
              },
            ],
          },
          finish_reason: null,
          native_finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      provider: "Smoke",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: "tool_calls",
          native_finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: input.prompt,
        completion_tokens: 10,
        total_tokens: input.prompt + 10,
        cost: 0.001,
        prompt_tokens_details: { cached_tokens: input.cached, cache_write_tokens: input.cacheWrite },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
  ) + "data: [DONE]\n\n"
}

function responsesToolCall(responseID: string) {
  const item = {
    type: "function_call",
    id: "fc_runtime_smoke",
    call_id: "call_runtime_smoke_openai",
    name: "read",
    arguments: JSON.stringify({ path: "tool-one.txt" }),
  }
  return eventStream(
    { type: "response.output_item.added", item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: responseID,
        usage: {
          input_tokens: 1_000,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 1_010,
        },
      },
    },
  )
}

function responsesText(responseID: string, content: string) {
  return eventStream(
    { type: "response.output_text.delta", item_id: "msg_runtime_smoke", delta: content },
    {
      type: "response.completed",
      response: {
        id: responseID,
        usage: {
          input_tokens: 1_200,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 1_210,
        },
      },
    },
  )
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-smoke-"))
  const home = path.join(root, "home")
  const config = path.join(root, "config")
  const data = path.join(root, "data")
  const cache = path.join(root, "cache")
  const state = path.join(root, "state")
  const project = path.join(root, "project")
  await Promise.all([home, config, data, cache, state, project].map((dir) => mkdir(dir, { recursive: true })))

  const mcpCatalog = path.join(project, "mcp-catalog.json")
  const mcpScript = path.join(project, "mcp-server.mjs")
  await Promise.all([
    writeFile(path.join(project, "tool-one.txt"), "runtime smoke tool one\n"),
    writeFile(path.join(project, "tool-two.txt"), "runtime smoke tool two\n"),
    writeFile(
      mcpCatalog,
      JSON.stringify({
        tools: [
          {
            name: "catalog_alpha",
            description: "Runtime smoke catalog alpha",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }),
    ),
    writeFile(
      mcpScript,
      `import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
const catalogFile = process.env.CATALOG_FILE
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
createInterface({ input: process.stdin }).on("line", async (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === "notifications/initialized") return
  if (message.id === undefined) return
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "runtime-smoke", version: "1.0.0" },
    } })
    return
  }
  if (message.method === "tools/list") {
    const catalog = JSON.parse(await readFile(catalogFile, "utf8"))
    send({ jsonrpc: "2.0", id: message.id, result: { tools: catalog.tools } })
    return
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "runtime smoke" }] } })
    return
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} })
    return
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
})
`,
    ),
  ])

  const requests: Array<{
    authorization: string | null
    pathname: string
    body: ProviderBody
    model?: unknown
    text: string
    maxTokens?: number
  }> = []
  let rejectedOpenAIContinuation = false
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = ((await request.json().catch(() => undefined)) ?? {}) as ProviderBody
      const text = JSON.stringify(body)
      const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined
      requests.push({
        authorization: request.headers.get("authorization"),
        pathname: url.pathname,
        body,
        model: body.model,
        text,
        maxTokens,
      })
      const index = requests.length

      if (url.pathname.endsWith("/responses")) {
        const input = Array.isArray(body.input) ? body.input : []
        const serializedInput = JSON.stringify(input)
        const previousResponseID =
          typeof body.previous_response_id === "string" ? body.previous_response_id : undefined
        const hasToolOutput = serializedInput.includes('"function_call_output"')
        const hasPrompt = serializedInput.includes("runtime-smoke-openai-continuation")
        if (previousResponseID !== undefined) {
          rejectedOpenAIContinuation = true
          return Response.json(
            {
              error: {
                message: "Previous response state expired",
                type: "invalid_request_error",
                param: "previous_response_id",
                code: "previous_response_not_found",
              },
            },
            { status: 400 },
          )
        }
        if (hasPrompt && !hasToolOutput)
          return new Response(responsesToolCall("resp_runtime_smoke_1"), {
            headers: { "content-type": "text/event-stream" },
          })
        return new Response(responsesText("resp_runtime_smoke_2", "OpenAI fallback complete"), {
          headers: { "content-type": "text/event-stream" },
        })
      }

      const messages = Array.isArray(body.messages) ? body.messages : []
      const toolResults = messages.filter(
        (message) =>
          typeof message === "object" && message !== null && "role" in message && message.role === "tool",
      ).length
      if (text.includes("runtime-smoke-tool-chain")) {
        if (toolResults === 0)
          return new Response(
            toolCallResponse({
              index,
              callID: "call_runtime_smoke_read_1",
              name: "read",
              arguments: { path: "tool-one.txt" },
              prompt: 1_000,
              cached: 0,
              cacheWrite: 100,
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        if (toolResults === 1)
          return new Response(
            toolCallResponse({
              index,
              callID: "call_runtime_smoke_read_2",
              name: "read",
              arguments: { path: "tool-two.txt" },
              prompt: 1_200,
              cached: 900,
              cacheWrite: 0,
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        return new Response(
          streamResponse({ index, content: "Tool chain complete", prompt: 1_300, cached: 1_000, cacheWrite: 0 }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }

      const continuation = text.includes("Continue autonomously toward the active user goal.")
      const proxy = text.includes("The assistant is waiting for user input.")
      if (continuation && proxy && !text.includes("Goal completed:"))
        return new Response(
          toolCallResponse({
            index,
            callID: "call_runtime_smoke_goal_complete",
            name: "goal",
            arguments: { action: "complete" },
            prompt: 200,
            cached: 0,
            cacheWrite: 0,
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (text.includes("runtime-smoke-subagent-block")) await sleep(5_000)
      const content = continuation ? (proxy ? "Goal verified and complete." : "Which database should I use?") : index === 1 ? "First" : "Second"
      return new Response(
        streamResponse({
          index,
          content,
          ...(continuation ? { cached: 0, cacheWrite: 0, prompt: 200 } : {}),
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })

  const providerUrl = `http://127.0.0.1:${provider.port}/api/v1`
  const openAIProviderUrl = `http://127.0.0.1:${provider.port}/openai/v1`
  await writeFile(
    path.join(project, "ycoding.json"),
    JSON.stringify({
      efficiency: {
        title: "local",
        goal_synthesis: "local",
        openai_responses_continuation: "auto",
      },
      mcp: {
        servers: {
          [MCP_SERVER]: {
            type: "local",
            command: [process.execPath, mcpScript],
            cwd: project,
            environment: { CATALOG_FILE: mcpCatalog },
            codemode: true,
          },
        },
      },
      agents: {
        reviewer: {
          description: "Runtime smoke managed subagent",
          mode: "subagent",
          model: `${PROVIDER_ID}/${MODEL_ID}`,
          system: "Complete the delegated task and report the final result.",
        },
      },
      providers: {
        openrouter: {
          name: "OpenRouter",
          package: "aisdk:@openrouter/ai-sdk-provider",
          settings: { baseURL: providerUrl },
          models: {
            [MODEL_ID]: {
              name: "Runtime Smoke",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100_000, output: 4096 },
              cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
            },
          },
        },
        openai: {
          name: "OpenAI",
          package: "@ycoding-ai/ai/providers/openai",
          settings: {
            baseURL: openAIProviderUrl,
            providerOptions: { openai: { store: true } },
          },
          models: {
            [OPENAI_MODEL_ID]: {
              name: "Runtime Smoke OpenAI",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100_000, output: 4096 },
              cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
            },
          },
        },
      },
    }),
  )

  const dir = path.resolve(import.meta.dirname, "..")
  const outdir = path.resolve(
    dir,
    process.argv.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length) ?? "dist",
  )
  const platform = process.platform === "win32" ? "windows" : process.platform
  const binary = path.join(outdir, `tui-${platform}-${process.arch}`, "bin", platformBinary(BUN_BINARY))
  if (!(await Bun.file(binary).exists())) throw new Error(`TUI artifact not found: ${binary}`)

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    YCODING_PASSWORD: PASSWORD,
    YCODING_DISABLE_CHANNEL_DB: "1",
  }
  const server = Bun.spawn([binary, "serve", "--stdio", "--port", "0"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    cwd: project,
  })
  const reader = server.stdout.getReader()
  let readiness = ""
  while (!readiness.includes("\n")) {
    const next = await reader.read()
    if (next.done) break
    readiness += new TextDecoder().decode(next.value)
  }
  const line = readiness.split("\n").map((value) => value.trim()).find(Boolean)
  if (!line) throw new Error("Runtime smoke server produced no readiness line")
  const ready = JSON.parse(line) as { url?: unknown }
  if (typeof ready.url !== "string") throw new Error(`Invalid readiness payload: ${line}`)

  const clientHeaders = {
    authorization: `Basic ${Buffer.from(`ycoding:${PASSWORD}`).toString("base64")}`,
    "x-ycoding-directory": project,
  }
  const client = YCoding.make({ baseUrl: ready.url, headers: clientHeaders })

  let phase = "integration readiness"
  try {
    await eventually(async () => {
      const result = await client.integration.list({ location: { directory: project } })
      const ids = new Set(result.data.map((integration) => integration.id))
      return ids.has(PROVIDER_ID) && ids.has(OPENAI_PROVIDER_ID) ? true : undefined
    })
    phase = "credential storage"
    await Promise.all([
      client.integration.connect.key({ integrationID: PROVIDER_ID, location: { directory: project }, key: KEY }),
      client.integration.connect.key({
        integrationID: OPENAI_PROVIDER_ID,
        location: { directory: project },
        key: KEY,
      }),
    ])
    phase = "model readiness"
    await eventually(async () => {
      const result = await client.model.list({ location: { directory: project } })
      const refs = new Set(result.data.map((model) => `${model.providerID}/${model.id}`))
      return refs.has(`${PROVIDER_ID}/${MODEL_ID}`) && refs.has(`${OPENAI_PROVIDER_ID}/${OPENAI_MODEL_ID}`)
        ? true
        : undefined
    })
    phase = "MCP catalog readiness"
    await eventually(async () => {
      const result = await client.mcp.list({ location: { directory: project } })
      const server = result.data.find((item) => item.name === MCP_SERVER)
      return server?.status.status === "connected" ? true : undefined
    })

    phase = "session creation"
    const session = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    phase = "first prompt"
    await client.session.prompt({ sessionID: session.id, text: "First turn" })
    await eventually(async () => ((await client.session.diagnostics({ sessionID: session.id }))?.tokens ? true : undefined))
    phase = "second prompt"
    await client.session.prompt({ sessionID: session.id, text: "Second turn" })
    const diagnostics = await eventually(async () => {
      const value = await client.session.diagnostics({ sessionID: session.id })
      return value?.tokens.cacheRead === 900 ? value : undefined
    })

    if (requests.length < 2) throw new Error(`Expected at least two provider requests, got ${requests.length}`)
    if (diagnostics.tokens.uncachedInput !== 300) throw new Error(`Unexpected uncached input: ${diagnostics.tokens.uncachedInput}`)
    if (diagnostics.tokens.cacheRead !== 900) throw new Error(`Unexpected cache read: ${diagnostics.tokens.cacheRead}`)
    if (diagnostics.cache.eligible !== 1200) throw new Error(`Unexpected cache-eligible tokens: ${diagnostics.cache.eligible}`)
    if (diagnostics.cache.hitRatio !== 0.75) throw new Error(`Unexpected cache hit ratio: ${diagnostics.cache.hitRatio}`)
    const expectedContext =
      diagnostics.tokens.uncachedInput +
      diagnostics.tokens.output +
      diagnostics.tokens.reasoning +
      diagnostics.tokens.cacheRead +
      diagnostics.tokens.cacheWrite
    if (diagnostics.context.total !== expectedContext)
      throw new Error(`Context total does not match normalized tokens: ${diagnostics.context.total} != ${expectedContext}`)
    if (diagnostics.context.remaining !== 100_000 - expectedContext)
      throw new Error(`Unexpected context remaining: ${diagnostics.context.remaining}`)

    phase = "provider efficiency tool benchmark"
    const toolRequestsStart = requests.length
    const toolSession = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    await client.session.prompt({ sessionID: toolSession.id, text: "runtime-smoke-tool-chain" })
    const toolDiagnostics = await eventually(async () => {
      const value = await client.session.diagnostics({ sessionID: toolSession.id })
      return value?.requests?.logical === 3 ? value : undefined
    })
    const toolSummary = toolDiagnostics.requests
    if (!toolSummary) throw new Error("Tool benchmark omitted request diagnostics")
    if (requests.length - toolRequestsStart !== 3)
      throw new Error(`Expected three tool-chain provider requests, got ${requests.length - toolRequestsStart}`)
    if (toolSummary.physical !== 3) throw new Error(`Unexpected tool transport attempts: ${toolSummary.physical}`)
    if (toolSummary.helpers !== 0) throw new Error(`Unexpected tool helper requests: ${toolSummary.helpers}`)
    if (toolSummary.continued !== 0) throw new Error(`Unexpected tool continuations: ${toolSummary.continued}`)
    if (toolSummary.fallback !== 0) throw new Error(`Unexpected tool fallbacks: ${toolSummary.fallback}`)
    if (toolSummary.tokens.input !== 1_500) throw new Error(`Unexpected tool raw input: ${toolSummary.tokens.input}`)
    if (toolSummary.tokens.cache.read !== 1_900)
      throw new Error(`Unexpected tool raw cache read: ${toolSummary.tokens.cache.read}`)
    if (toolSummary.tokens.cache.write !== 100)
      throw new Error(`Unexpected tool raw cache write: ${toolSummary.tokens.cache.write}`)
    if (toolSummary.tokens.output !== 15) throw new Error(`Unexpected tool raw output: ${toolSummary.tokens.output}`)
    if (toolSummary.tokens.reasoning !== 15)
      throw new Error(`Unexpected tool raw reasoning: ${toolSummary.tokens.reasoning}`)
    assertClose(toolSummary.cost, 0.001875, "Tool benchmark estimated cost")
    if (toolSummary.latestNamespace?.length !== 8)
      throw new Error(`Unexpected tool namespace: ${toolSummary.latestNamespace ?? "missing"}`)
    const stableNamespace = toolSummary.latestNamespace

    phase = "cross-session stable prefix"
    const prefixBefore = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    await client.session.prompt({ sessionID: prefixBefore.id, text: "runtime-smoke-prefix-before-mcp" })
    const beforeDiagnostics = await eventually(async () => {
      const value = await client.session.diagnostics({ sessionID: prefixBefore.id })
      return value?.requests?.latestNamespace ? value : undefined
    })
    if (beforeDiagnostics.requests?.latestNamespace !== stableNamespace)
      throw new Error("Equivalent Sessions did not share the same prompt-cache namespace")

    phase = "MCP CodeMode catalog reload"
    await writeFile(
      mcpCatalog,
      JSON.stringify({
        tools: [
          {
            name: "catalog_beta",
            description: "Runtime smoke catalog beta changed at runtime",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
        ],
      }),
    )
    await client.mcp.disconnect({ server: MCP_SERVER, location: { directory: project } })
    await client.mcp.connect({ server: MCP_SERVER, location: { directory: project } })
    await eventually(async () => {
      const result = await client.mcp.list({ location: { directory: project } })
      const server = result.data.find((item) => item.name === MCP_SERVER)
      return server?.status.status === "connected" ? true : undefined
    })
    const prefixAfter = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    await client.session.prompt({ sessionID: prefixAfter.id, text: "runtime-smoke-prefix-after-mcp" })
    const afterDiagnostics = await eventually(async () => {
      const value = await client.session.diagnostics({ sessionID: prefixAfter.id })
      return value?.requests?.latestNamespace ? value : undefined
    })
    if (afterDiagnostics.requests?.latestNamespace !== stableNamespace)
      throw new Error("CodeMode MCP catalog churn changed the provider-visible prompt-cache namespace")

    phase = "OpenAI Responses continuation fallback"
    const openAIRequestsStart = requests.length
    const openAISession = await client.session.create({
      model: { providerID: OPENAI_PROVIDER_ID, id: OPENAI_MODEL_ID },
      location: { directory: project },
    })
    await client.session.prompt({
      sessionID: openAISession.id,
      text: "runtime-smoke-openai-continuation",
    })
    await client.session.wait({ sessionID: openAISession.id })
    const openAIDiagnostics = await client.session.diagnostics({ sessionID: openAISession.id })
    if (openAIDiagnostics?.requests?.fallback !== 1) {
      const observed = requests.slice(openAIRequestsStart).map((request) => ({
        pathname: request.pathname,
        store: request.body.store,
        previousResponseID: request.body.previous_response_id,
        input: request.body.input,
      }))
      throw new Error(
        `OpenAI continuation fallback was not recorded: diagnostics=${JSON.stringify(openAIDiagnostics?.requests)}, requests=${JSON.stringify(observed)}`,
      )
    }
    const openAISummary = openAIDiagnostics.requests
    if (!openAISummary) throw new Error("OpenAI benchmark omitted request diagnostics")
    const openAIRequests = requests
      .slice(openAIRequestsStart)
      .filter((request) => request.pathname.endsWith("/responses"))
    if (openAIRequests.length !== 3)
      throw new Error(`Expected three OpenAI physical attempts, got ${openAIRequests.length}`)
    if (!rejectedOpenAIContinuation) throw new Error("Fake OpenAI provider did not reject continued state")
    if (openAISummary.logical !== 2) throw new Error(`Unexpected OpenAI logical requests: ${openAISummary.logical}`)
    if (openAISummary.physical !== 3) throw new Error(`Unexpected OpenAI attempts: ${openAISummary.physical}`)
    if (openAISummary.continued !== 0)
      throw new Error(`Failed continuation was recorded as continued: ${openAISummary.continued}`)
    if (openAISummary.fallback !== 1) throw new Error(`Unexpected OpenAI fallbacks: ${openAISummary.fallback}`)
    if (openAISummary.tokens.input !== 1_200)
      throw new Error(`Unexpected OpenAI raw input: ${openAISummary.tokens.input}`)
    if (openAISummary.tokens.cache.read !== 900)
      throw new Error(`Unexpected OpenAI raw cache read: ${openAISummary.tokens.cache.read}`)
    if (openAISummary.tokens.cache.write !== 100)
      throw new Error(`Unexpected OpenAI raw cache write: ${openAISummary.tokens.cache.write}`)
    if (openAISummary.tokens.output !== 10)
      throw new Error(`Unexpected OpenAI raw output: ${openAISummary.tokens.output}`)
    if (openAISummary.tokens.reasoning !== 10)
      throw new Error(`Unexpected OpenAI raw reasoning: ${openAISummary.tokens.reasoning}`)
    assertClose(openAISummary.cost, 0.001455, "OpenAI benchmark estimated cost")
    if (openAIRequests[0]?.body.store !== true)
      throw new Error("OpenAI benchmark did not preserve explicitly configured storage")
    if (openAIRequests[0]?.body.previous_response_id !== undefined)
      throw new Error("First OpenAI request unexpectedly referenced previous response state")
    if (openAIRequests[1]?.body.previous_response_id !== "resp_runtime_smoke_1")
      throw new Error("Second OpenAI request omitted the previous response ID")
    const continuedInput = JSON.stringify(openAIRequests[1]?.body.input)
    if (!continuedInput.includes('"function_call_output"'))
      throw new Error("Continued OpenAI request omitted the new tool result")
    if (continuedInput.includes("runtime-smoke-openai-continuation"))
      throw new Error("Continued OpenAI request resent represented user history")
    if (!continuedInput.includes('"role":"system"'))
      throw new Error("Continued OpenAI request omitted current system instructions")
    if (openAIRequests[2]?.body.previous_response_id !== undefined)
      throw new Error("OpenAI fallback retained previous response state")
    const fallbackInput = JSON.stringify(openAIRequests[2]?.body.input)
    if (!fallbackInput.includes("runtime-smoke-openai-continuation") || !fallbackInput.includes('"function_call_output"'))
      throw new Error("OpenAI fallback did not restore full canonical history")

    phase = "yolo autonomy API"
    const yoloSession = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    const yoloSet = await client.session.autonomy.set({ sessionID: yoloSession.id, payload: { yolo: 2 } })
    if (yoloSet.yolo !== 2) throw new Error(`YOLO level was not persisted: ${yoloSet.yolo}`)
    const yoloRead = await client.session.autonomy.get({ sessionID: yoloSession.id })
    if (yoloRead.yolo !== 2) throw new Error(`YOLO level did not round-trip: ${yoloRead.yolo}`)
    const normal = await client.session.autonomy.set({ sessionID: yoloSession.id, payload: { yolo: 0 } })
    if (normal.yolo !== 0) throw new Error(`Normal level was not restored: ${normal.yolo}`)

    phase = "goal autonomous continuation"
    const goalSession = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    const goalText = "Choose the safest database default and finish the task"
    const goalSet = await client.session.autonomy.set({
      sessionID: goalSession.id,
      payload: { goal: goalText, maxNoProgress: 2 },
    })
    if (goalSet.goal?.status !== "active")
      throw new Error("Goal mode was not activated")
    const canonicalGoal = goalSet.goal.text
    const completedGoal = await eventually(async () => {
      const value = await client.session.autonomy.get({ sessionID: goalSession.id })
      return value.goal?.status === "completed" ? value : undefined
    }, 30_000)
    if (completedGoal.mode !== "normal") throw new Error(`Completed Goal did not return to normal mode: ${completedGoal.mode}`)
    if (completedGoal.goal?.iteration !== 1)
      throw new Error(`Expected one Goal continuation, got ${completedGoal.goal?.iteration ?? "missing"}`)
    const continuation = requests.find((request) =>
      request.text.includes("Continue autonomously toward the active user goal.") &&
      request.text.includes("The assistant is waiting for user input."),
    )
    if (!continuation) throw new Error("Goal mode did not issue a user-proxy continuation request")
    if (!continuation.text.includes(`Goal: ${canonicalGoal}`))
      throw new Error("Goal continuation omitted the canonical durable goal text")
    if (!continuation.text.includes("Answer it on the user's behalf"))
      throw new Error("Goal continuation did not include user-proxy instructions")

    phase = "durable subagent orchestration"
    const subagentParent = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    const oversizedSubagent = await fetch(new URL(`/api/session/${subagentParent.id}/subagent`, ready.url), {
      method: "POST",
      headers: { ...clientHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        parentAssistantMessageID: "msg_runtime_smoke_oversized",
        toolCallID: "call_runtime_smoke_oversized",
        agent: "reviewer",
        description: "d".repeat(4 * 1024 + 1),
        prompt: "must be rejected before persistence",
        background: true,
      }),
    })
    if (oversizedSubagent.status !== 400)
      throw new Error(`Oversized subagent payload returned ${oversizedSubagent.status}, expected 400`)
    if ((await client.session.subagent.list({ parentID: subagentParent.id })).data.length !== 0)
      throw new Error("Oversized subagent payload persisted a task")

    const launchedSubagent = await client.session.subagent.launch({
      parentID: subagentParent.id,
      parentAssistantMessageID: "msg_runtime_smoke_parent",
      toolCallID: "call_runtime_smoke_child",
      agent: "reviewer",
      description: "Runtime smoke child",
      prompt: "runtime-smoke-subagent-block",
      background: true,
    })
    await eventually(async () => {
      const task = (await client.session.subagent.list({ parentID: subagentParent.id })).data.find(
        (item) => item.sessionID === launchedSubagent.sessionID,
      )
      return task?.state === "running" ? task : undefined
    })
    const cancelledSubagent = await client.session.subagent.cancel({
      parentID: subagentParent.id,
      childID: launchedSubagent.sessionID,
    })
    if (cancelledSubagent.state !== "cancelled")
      throw new Error(`Subagent cancellation did not settle durably: ${cancelledSubagent.state}`)
    const persistedSubagent = await eventually(async () => {
      const task = (await client.session.subagent.list({ parentID: subagentParent.id })).data.find(
        (item) => item.sessionID === launchedSubagent.sessionID,
      )
      return task?.state === "cancelled" ? task : undefined
    })

    for (const request of requests) {
      if (request.authorization !== `Bearer ${KEY}`)
        throw new Error(`Provider request ${request.pathname} did not contain the stored bearer credential`)
    }

    console.log(
      `Runtime smoke passed: auth, yolo=round-trip, goal=${completedGoal.goal?.status}, subagent=${persistedSubagent.state}, cache-hit=${diagnostics.cache.hitRatio}, tool-requests=${toolSummary.logical}/${toolSummary.physical}, namespace=${stableNamespace}, openai-fallback=${openAISummary.fallback}`,
    )
  } catch (error) {
    throw new Error(`Runtime smoke failed during ${phase}`, { cause: error })
  } finally {
    provider.stop(true)
    server.kill()
    await server.exited.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

await main()
