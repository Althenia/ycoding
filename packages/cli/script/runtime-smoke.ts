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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-smoke-"))
  const home = path.join(root, "home")
  const config = path.join(root, "config")
  const data = path.join(root, "data")
  const cache = path.join(root, "cache")
  const state = path.join(root, "state")
  const project = path.join(root, "project")
  await Promise.all([home, config, data, cache, state, project].map((dir) => mkdir(dir, { recursive: true })))

  const requests: Array<{
    authorization: string | null
    model?: unknown
    text: string
    maxTokens?: number
  }> = []
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json().catch(() => undefined)) as
        | { model?: unknown; max_tokens?: unknown }
        | undefined
      const text = JSON.stringify(body ?? {})
      const maxTokens = typeof body?.max_tokens === "number" ? body.max_tokens : undefined
      requests.push({ authorization: request.headers.get("authorization"), model: body?.model, text, maxTokens })
      const continuation = text.includes("Continue autonomously toward the active user goal.")
      const goalStart = text.includes("Begin autonomous goal") && (maxTokens === undefined || maxTokens > 100)
      if (text.includes("runtime-smoke-subagent-block")) await sleep(5_000)
      const content = continuation
        ? "Goal verified and complete. <goal-complete/>"
        : goalStart
          ? "Which database should I use?"
          : requests.length === 1
            ? "First"
            : "Second"
      return new Response(
        streamResponse({
          index: requests.length,
          content,
          ...(continuation || goalStart ? { cached: 0, cacheWrite: 0, prompt: 200 } : {}),
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })

  const providerUrl = `http://127.0.0.1:${provider.port}/api/v1`
  await writeFile(
    path.join(project, "ycoding.json"),
    JSON.stringify({
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
    YCODING_DISABLE_AUTOUPDATE: "1",
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
      return result.data.some((integration) => integration.id === PROVIDER_ID) ? true : undefined
    })
    phase = "credential storage"
    await client.integration.connect.key({ integrationID: PROVIDER_ID, location: { directory: project }, key: KEY })
    phase = "model readiness"
    await eventually(async () => {
      const result = await client.model.list({ location: { directory: project } })
      return result.data.some((model) => model.providerID === PROVIDER_ID && model.id === MODEL_ID) ? true : undefined
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

    phase = "yolo autonomy API"
    const yoloSession = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    const yoloSet = await client.session.autonomy.set({ sessionID: yoloSession.id, payload: { mode: "yolo" } })
    if (yoloSet.mode !== "yolo") throw new Error(`YOLO mode was not persisted: ${yoloSet.mode}`)
    const yoloRead = await client.session.autonomy.get({ sessionID: yoloSession.id })
    if (yoloRead.mode !== "yolo") throw new Error(`YOLO mode did not round-trip: ${yoloRead.mode}`)
    const normal = await client.session.autonomy.set({ sessionID: yoloSession.id, payload: { mode: "normal" } })
    if (normal.mode !== "normal") throw new Error(`Normal mode was not restored: ${normal.mode}`)

    phase = "goal autonomous continuation"
    const goalSession = await client.session.create({
      model: { providerID: PROVIDER_ID, id: MODEL_ID },
      location: { directory: project },
    })
    const goalText = "Choose the safest database default and finish the task"
    const goalSet = await client.session.autonomy.set({
      sessionID: goalSession.id,
      payload: { mode: "goal", goal: goalText, maxNoProgress: 2 },
    })
    if (goalSet.mode !== "goal" || goalSet.goal?.status !== "active")
      throw new Error("Goal mode was not activated")
    const canonicalGoal = goalSet.goal.text
    await client.session.prompt({ sessionID: goalSession.id, text: "Begin autonomous goal" })
    const completedGoal = await eventually(async () => {
      const value = await client.session.autonomy.get({ sessionID: goalSession.id })
      return value.goal?.status === "completed" ? value : undefined
    }, 30_000)
    if (completedGoal.mode !== "normal") throw new Error(`Completed Goal did not return to normal mode: ${completedGoal.mode}`)
    if (completedGoal.goal?.iteration !== 2)
      throw new Error(`Expected two Goal iterations, got ${completedGoal.goal?.iteration ?? "missing"}`)
    const continuation = requests.find((request) =>
      request.text.includes("Continue autonomously toward the active user goal."),
    )
    if (!continuation) throw new Error("Goal mode did not issue a synthetic continuation request")
    if (!continuation.text.includes(`Goal: ${canonicalGoal}`))
      throw new Error("Goal continuation omitted the canonical durable goal text")
    if (!continuation.text.includes("The assistant is waiting for user input."))
      throw new Error("Goal continuation did not recognize the assistant question")
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
    if ((await client.session.subagent.list({ parentID: subagentParent.id })).length !== 0)
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
      const task = (await client.session.subagent.list({ parentID: subagentParent.id })).find(
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
      const task = (await client.session.subagent.list({ parentID: subagentParent.id })).find(
        (item) => item.sessionID === launchedSubagent.sessionID,
      )
      return task?.state === "cancelled" ? task : undefined
    })

    for (const request of requests) {
      if (request.authorization !== `Bearer ${KEY}`) throw new Error("OpenRouter request did not contain stored bearer credential")
    }

    console.log(
      `Runtime smoke passed: auth, yolo=round-trip, goal=${completedGoal.goal?.status}, subagent=${persistedSubagent.state}, cache-hit=${diagnostics.cache.hitRatio}`,
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
