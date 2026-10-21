import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { DecisionJudgment } from "@ycoding-ai/core/decision-judgment"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { createSession, providerConfig, startProviderStandIn, startServer, auth, type IsolatedServer } from "./remote-harness"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deadline<A>(promise: Promise<A>, message: string, ms = 30_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const refusal = (name: string) =>
  DecisionJudgment.encode({
    decisions: {
      version: 1,
      answers: [{ name, type: "refusal", text: null, answer: null, choice: null, score: null, confidence: 0 }],
    },
  })

async function startHelper(hold?: Promise<void>) {
  const calls: string[] = []
  const first = gate()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/responses")) return new Response("not found", { status: 404 })
      calls.push(JSON.stringify(await request.json()))
      first.open()
      if (hold) await hold
      const frames = [
        { type: "response.output_text.delta", item_id: "msg_helper", delta: refusal("q0") },
        {
          type: "response.completed",
          response: { id: `resp_${calls.length}`, output: [], usage: { input_tokens: 20, output_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } },
        },
      ]
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    },
  })
  cleanups.push(async () => {
    await server.stop(true)
  })
  return { url: `http://127.0.0.1:${server.port}`, calls, firstCall: first.promise }
}

interface StreamedEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

async function collectEvents(server: IsolatedServer) {
  const events: StreamedEvent[] = []
  const waiters: Array<{ readonly match: (event: StreamedEvent) => boolean; readonly resolve: (event: StreamedEvent) => void }> = []
  const abort = new AbortController()
  const response = await fetch(`${server.base}/api/event`, { headers: { authorization: auth }, signal: abort.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    let buffer = ""
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("")
        if (!data) continue
        const parsed: unknown = JSON.parse(data)
        if (typeof parsed !== "object" || parsed === null || typeof Reflect.get(parsed, "type") !== "string") continue
        const event: StreamedEvent = { type: Reflect.get(parsed, "type"), data: (Reflect.get(parsed, "data") ?? {}) as Record<string, unknown> }
        events.push(event)
        for (const waiter of waiters.splice(0)) {
          if (waiter.match(event)) waiter.resolve(event)
          else waiters.push(waiter)
        }
      }
    }
  })()
  cleanups.push(async () => {
    abort.abort()
  })
  return {
    events,
    of: (type: string) => events.filter((event) => event.type === type),
    next(description: string, match: (event: StreamedEvent) => boolean) {
      const seen = events.find(match)
      if (seen) return Promise.resolve(seen)
      return deadline(new Promise<StreamedEvent>((resolve) => waiters.push({ match, resolve })), `event never arrived: ${description}`)
    },
  }
}

const directive = "Local-only now: cancel the transfer and finish the local report."
const json = { "content-type": "application/json" }

async function boot(options: { readonly hold?: Promise<void> } = {}) {
  const scratch = join(import.meta.dir, "../../../.cache/tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, "yolo-continuation-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const helper = await startHelper(options.hold)
  const mainRequests: unknown[] = []
  const second = gate()
  const standIn = await startProviderStandIn({
    text: "Local report finished.",
    reply: (request) => {
      mainRequests.push(request)
      if (mainRequests.length === 2) second.open()
      if (JSON.stringify(request).includes(directive)) return [deltaChunk({ role: "assistant", content: "Local report finished." }), finishChunk("stop")]
      return [
        toolCallChunk(
          "call_reservation",
          "question",
          JSON.stringify({ questions: [{ header: "Reservation", question: "Which upload reservation ID should the transfer use?", options: [] }] }),
        ),
        finishChunk("tool_calls"),
      ]
    },
  })
  cleanups.push(() => standIn.close())
  const server = await startServer(directory, {
    config: {
      ...JSON.parse(providerConfig(standIn)),
      providers: {
        ...JSON.parse(providerConfig(standIn)).providers,
        "strict-helper": {
          package: "@ycoding-ai/ai/providers/openai",
          name: "Strict helper",
          settings: { baseURL: `${helper.url}/v1`, apiKey: "strict-helper-key" },
          models: { "strict-model": { name: "Strict helper", limit: { context: 128_000, output: 8_192 } } },
        },
      },
      default_agent: "transfer",
      agents: {
        transfer: {
          description: "Asks for missing inputs.",
          mode: "primary",
          permissions: [{ action: "question", resource: "*", effect: "allow" }],
        },
      },
      efficiency: { helper_models: { decision: "strict-helper/strict-model" } },
    },
  })
  cleanups.push(() => server.close())
  const sessionID = "ses_yolo_continuation"
  await createSession(server, sessionID, directory, { providerID: standIn.providerID, id: standIn.modelID })
  const events = await collectEvents(server)
  const autonomy = await server.request(`/api/session/${sessionID}/autonomy`, { method: "PUT", headers: json, body: JSON.stringify({ yolo: true }) })
  expect(autonomy.status, await autonomy.clone().text()).toBe(200)
  const send = async (id: string, text: string, delivery?: "queue" | "steer") => {
    const response = await server.request(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ id, text, ...(delivery === undefined ? {} : { delivery }) }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
  }
  const forms = async () => {
    const response = await server.request(`/api/session/${sessionID}/form`)
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: Array<Record<string, unknown>> }).data
  }
  const message = async (id: string) => {
    const response = await server.request(`/api/session/${sessionID}/message/${id}`)
    expect(response.status, await response.clone().text()).toBe(200)
    return ((await response.json()) as { data: { metadata?: Record<string, unknown> } }).data
  }
  return { directory, server, helper, events, mainRequests, secondRequest: second.promise, send, forms, message }
}

const timeout = 60_000

describe("YOLO continuation through the real server", () => {
  test("a fresh steer releases a question the helper could not answer and the next model request carries the directive", async () => {
    const run = await boot()
    await run.send("msg_transfer", "Prepare the transfer upload with the reservation.")
    await run.events.next("form.created", (event) => event.type === "form.created")
    await deadline(run.helper.firstCall, "the answer helper was never consulted")
    expect(run.mainRequests).toHaveLength(1)

    await run.send("msg_local_only", directive)
    await run.events.next("form.cancelled", (event) => event.type === "form.cancelled")
    await deadline(run.secondRequest, "the model was never asked again after the steer")

    expect(JSON.stringify(run.mainRequests[1])).toContain(directive)
    expect(JSON.stringify(run.mainRequests[0])).not.toContain(directive)
    expect(await run.forms()).toEqual([])
    expect(run.events.of("form.replied")).toEqual([])
    const called = run.events.of("session.tool.called").map((event) => event.data.name ?? event.data.tool)
    expect(called.filter((name) => name !== "question")).toEqual([])
    expect(JSON.stringify(run.mainRequests[1])).not.toMatch(/"role":"tool"[^}]*(automatic|reservation-[0-9a-z]+)/)
    expect((await run.message("msg_local_only")).metadata).toMatchObject({ inputOrigin: "human" })
    expect((await run.message("msg_transfer")).metadata).toMatchObject({ inputOrigin: "human" })
  }, timeout)

  test("a fresh steer also releases a question whose answer helper is still running", async () => {
    const release = gate()
    const run = await boot({ hold: release.promise })
    cleanups.push(async () => release.open())
    await run.send("msg_transfer", "Prepare the transfer upload with the reservation.")
    await deadline(run.helper.firstCall, "the answer helper was never consulted")
    await run.events.next("form.created", (event) => event.type === "form.created")

    await run.send("msg_local_only", directive)
    await run.events.next("form.cancelled", (event) => event.type === "form.cancelled")
    await deadline(run.secondRequest, "the model was never asked again while the helper was held")

    expect(JSON.stringify(run.mainRequests[1])).toContain(directive)
    expect(run.events.of("form.replied")).toEqual([])
    release.open()
  }, timeout)

  test("a queued input leaves the question pending and the model is not asked again", async () => {
    const run = await boot()
    await run.send("msg_transfer", "Prepare the transfer upload with the reservation.")
    await run.events.next("form.created", (event) => event.type === "form.created")
    await deadline(run.helper.firstCall, "the answer helper was never consulted")

    await run.send("msg_queued", directive, "queue")
    await run.events.next("queued input admitted", (event) => event.type === "session.input.admitted" && event.data.inputID === "msg_queued")

    expect(await run.forms()).toHaveLength(1)
    expect(run.events.of("form.cancelled")).toEqual([])
    expect(run.mainRequests).toHaveLength(1)
  }, timeout)
})
