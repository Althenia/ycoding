import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { YCoding } from "@ycoding-ai/client/promise"
import { deltaChunk, finishChunk, toolCallChunk, usageChunk } from "../../../ai/test/lib/openai-chunks"
import { runNonInteractivePrompt } from "../../src/run/noninteractive"
import { auth, createSession, startServer } from "../remote-harness"

// A real in-process server answering from a loopback OpenAI-compatible stand-in: the JSON run
// summary is read back through the same Protocol reads the CLI uses against any server.

const permissions = [
  { action: "todowrite", resource: "*", effect: "allow" },
  { action: "subagent", resource: "*", effect: "allow" },
]

const usage = (prompt: number, completion: number, cached: number) =>
  usageChunk({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  })

const text = (value: string, tokens: ReturnType<typeof usage>) => [
  deltaChunk({ role: "assistant" }),
  deltaChunk({ content: value }),
  finishChunk("stop"),
  tokens,
]

type ChatRequest = {
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>
}

const offers = (request: unknown, tool: string) =>
  (request as ChatRequest).tools?.some((item) => item.function?.name === tool) === true
const hasToolResult = (request: unknown) => (request as ChatRequest).messages?.some((item) => item.role === "tool")
const mentions = (request: unknown, value: string) => JSON.stringify(request).includes(value)

async function scratch() {
  const parent = path.resolve(import.meta.dir, "../../../../.cache/tmp")
  await mkdir(parent, { recursive: true })
  return mkdtemp(path.join(parent, "run-metrics-"))
}

async function runJson(input: {
  base: string
  directory: string
  sessionID: string
  provider: { providerID: string; modelID: string }
  message: string
}) {
  const lines: string[] = []
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk))
    return true
  })
  const exitCode = process.exitCode
  try {
    await runNonInteractivePrompt({
      client: YCoding.make({ baseUrl: input.base, headers: { authorization: auth } }),
      sessionID: input.sessionID,
      location: { directory: input.directory },
      message: input.message,
      files: [],
      thinking: false,
      format: "json",
      attached: false,
      renderTool: () => Promise.resolve(),
      renderToolError: () => Promise.resolve(),
    })
    return lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } finally {
    process.exitCode = exitCode ?? 0
    write.mockRestore()
  }
}

afterEach(() => {
  process.exitCode = 0
})

test("a multi-step run reports step metadata and run totals read back from the provider ledger", async () => {
  const directory = await scratch()
  const server = await startServer(directory, {
    config: { permissions },
    provider: {
      text: "unused",
      reply: (request) =>
        offers(request, "todowrite") && !hasToolResult(request)
          ? [
              toolCallChunk(
                "call_todo",
                "todowrite",
                JSON.stringify({ todos: [{ content: "Check", status: "pending", priority: "low" }] }),
              ),
              finishChunk("tool_calls"),
              usage(100, 10, 40),
            ]
          : text("Done.", usage(150, 20, 100)),
    },
  })
  try {
    if (!server.provider) throw new Error("Missing isolated provider")
    await createSession(server, "ses_metrics_steps", directory, { providerID: server.provider.providerID, id: server.provider.modelID })
    const events = await runJson({
      base: server.base,
      directory,
      sessionID: "ses_metrics_steps",
      provider: server.provider,
      message: "Plan then finish.",
    })

    const finish = events.at(-1)
    const starts = events.filter((event) => event.type === "step_start")
    const steps = events.filter((event) => event.type === "step_finish")
    expect(events.filter((event) => event.type === "run_finish")).toHaveLength(1)
    expect(starts).toHaveLength(2)
    expect(starts[0].part.model).toEqual({ providerID: server.provider.providerID, id: server.provider.modelID })
    expect(typeof starts[0].part.agent).toBe("string")
    expect(steps.map((step) => step.part.tokens)).toEqual([
      { input: 60, output: 10, reasoning: 0, cache: { read: 40, write: 0 } },
      { input: 50, output: 20, reasoning: 0, cache: { read: 100, write: 0 } },
    ])
    expect(steps[0].part).toMatchObject({
      contextBreakdown: expect.any(Object),
      providerCache: { mechanism: "openai-prefix-cache", readReported: true, writeReported: false },
    })
    expect(finish).toMatchObject({
      type: "run_finish",
      sessionID: "ses_metrics_steps",
      status: "succeeded",
      steps: 2,
      tokens: { input: 110, output: 30, reasoning: 0, cache: { read: 140, write: 0 } },
      context: { peakInput: 150 },
      models: [{ providerID: server.provider.providerID, id: server.provider.modelID }],
      total: {
        tokens: { input: 110, output: 30, reasoning: 0, cache: { read: 140, write: 0 } },
        requests: { logical: 2, physical: 2, helpers: 0 },
      },
      children: [],
    })
    expect(finish.durationMs).toBeGreaterThan(0)
    expect(finish.total).not.toHaveProperty("cost")
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("a run that launches a subagent includes the child's usage in total and children", async () => {
  const directory = await scratch()
  const sessionID = "ses_metrics_subagent"
  const childPrompt = "Review the change"
  let childEnded: () => void = () => {}
  const childFinished = new Promise<void>((resolve) => {
    childEnded = resolve
  })
  const server = await startServer(directory, {
    config: { permissions, agents: { reviewer: { description: "Reviews a change", mode: "subagent" } } },
    provider: {
      text: "unused",
      reply: async (request) => {
        if (hasToolResult(request)) {
          await childFinished
          return text("Delegated.", usage(60, 8, 0))
        }
        if (mentions(request, childPrompt)) return text("Looks fine.", usage(30, 5, 0))
        if (offers(request, "subagent"))
          return [
            toolCallChunk(
              "call_child",
              "subagent",
              JSON.stringify({ agent: "reviewer", description: "Review", prompt: childPrompt }),
            ),
            finishChunk("tool_calls"),
            usage(100, 10, 0),
          ]
        return text("Fallback.", usage(1, 1, 0))
      },
    },
  })
  const watcher = new AbortController()
  const watching = YCoding.make({ baseUrl: server.base, headers: { authorization: auth } }).event.subscribe({
    signal: watcher.signal,
  })[Symbol.asyncIterator]()
  try {
    if (!server.provider) throw new Error("Missing isolated provider")
    await createSession(server, sessionID, directory, {
      providerID: server.provider.providerID,
      id: server.provider.modelID,
    })
    await watching.next()
    void (async () => {
      while (true) {
        const next = await watching.next().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        if (next.value.type === "session.step.ended" && next.value.data.sessionID !== sessionID) return childEnded()
      }
    })()
    const events = await runJson({
      base: server.base,
      directory,
      sessionID,
      provider: server.provider,
      message: "Delegate the review.",
    })

    const finish = events.at(-1)
    expect(events.filter((event) => event.type === "run_finish")).toHaveLength(1)
    expect(finish.status).toBe("succeeded")
    expect(finish.children).toHaveLength(1)
    const child = finish.children[0]
    expect(child).toMatchObject({
      kind: "subagent",
      agent: "reviewer",
      tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      requests: { logical: 1, physical: 1, helpers: 0 },
    })
    expect(child.sessionID).not.toBe(sessionID)
    expect(typeof child.status).toBe("string")
    expect(finish.total.tokens.input).toBe(finish.tokens.input + child.tokens.input)
    expect(finish.total.tokens.output).toBe(finish.tokens.output + child.tokens.output)
    expect(finish.total.requests.logical).toBe(finish.steps + child.requests.logical)
  } finally {
    watcher.abort()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
