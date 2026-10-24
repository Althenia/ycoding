import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { DecisionJudgment } from "@ycoding-ai/core/decision-judgment"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { createSession, providerConfig, startProviderStandIn, startServer, auth, type IsolatedServer } from "./remote-harness"

type Scores = Readonly<Record<string, number>>

type StrictReply =
  | { readonly grades: Scores }
  | { readonly raw: string }
  | { readonly hold: Promise<void>; readonly then: StrictReply }

interface StrictCall {
  readonly index: number
  readonly question: string
  readonly body: string
}

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

function questionName(body: string) {
  return ["guardrail_match", "guardrail", "permission"].find((name) => body.includes(`name\\":\\"${name}\\"`)) ?? "unknown"
}

function encodedAnswer(question: string, scores: Scores) {
  return DecisionJudgment.encode({
    decisions: {
      version: 1,
      answers: [
        {
          name: question,
          type: "choice",
          answer: null,
          choice: null,
          score: null,
          confidence: 0,
          grades: ["allow", "deny", "escalate"].map((choice) => ({
            choice,
            confidence: scores[choice] ?? 0,
            evidence: "Bounded synthetic assessment evidence",
          })),
        },
      ],
    },
  })
}

async function startStrictHelper(respond: (call: StrictCall) => StrictReply | Promise<StrictReply>) {
  const calls: StrictCall[] = []
  const first = gate()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/responses")) return new Response("not found", { status: 404 })
      const body = JSON.stringify(await request.json())
      const call: StrictCall = { index: calls.length, question: questionName(body), body }
      calls.push(call)
      first.open()
      let reply = await respond(call)
      while ("hold" in reply) {
        await reply.hold
        reply = reply.then
      }
      const text = "raw" in reply ? reply.raw : encodedAnswer(call.question, reply.grades)
      const frames = [
        { type: "response.output_text.delta", item_id: "msg_strict", delta: text },
        {
          type: "response.completed",
          response: { id: `resp_${call.index}`, output: [], usage: { input_tokens: 20, output_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } },
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

interface Scenario {
  readonly command: string
  readonly strict: (call: StrictCall) => StrictReply | Promise<StrictReply>
  readonly permissions?: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }>
  readonly yolo?: boolean
  readonly baseline?: boolean
  readonly pinUnsupported?: boolean
  readonly pinDecision?: boolean
  readonly omitHelper?: boolean
}

async function boot(scenario: Scenario) {
  const scratch = join(import.meta.dir, "../../../.cache/tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, "decision-recovery-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const strict = await startStrictHelper(scenario.strict)
  const second = gate()
  const mainRequests: unknown[] = []
  const standIn = await startProviderStandIn({
    text: "Finished.",
    reply: (request) => {
      mainRequests.push(request)
      const messages = typeof request === "object" && request !== null ? Reflect.get(request, "messages") : undefined
      const returned = Array.isArray(messages) && messages.some((message) => message?.role === "tool")
      if (returned) {
        second.open()
        return [deltaChunk({ role: "assistant", content: "Finished." }), finishChunk("stop")]
      }
      return [toolCallChunk("call_recovery_shell", "shell", JSON.stringify({ command: scenario.command, description: "Synthetic recovery check" })), finishChunk("tool_calls")]
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
          settings: { baseURL: `${strict.url}/v1`, apiKey: "strict-helper-key" },
          models: { "strict-model": { name: "Strict helper", limit: { context: 128_000, output: 8_192 } } },
        },
      },
      default_agent: "recovery-gate",
      agents: {
        "recovery-gate": {
          description: "Every shell call asks.",
          mode: "primary",
          permissions: [{ action: "shell", resource: "*", effect: "ask" }, ...(scenario.permissions ?? [])],
        },
        ...(scenario.pinUnsupported === false ? {} : { "yolo-permission": { model: `${standIn.providerID}/${standIn.modelID}` } }),
        ...(scenario.pinDecision === true ? { decision: { model: `${standIn.providerID}/${standIn.modelID}` } } : {}),
      },
      guardrails: { decide_reviews: scenario.baseline === true },
      ...(scenario.omitHelper === true ? {} : { efficiency: { helper_models: { decision: "strict-helper/strict-model" } } }),
    },
  })
  cleanups.push(() => server.close())
  const sessionID = "ses_decision_recovery"
  await createSession(server, sessionID, directory, { providerID: standIn.providerID, id: standIn.modelID })
  const events = await collectEvents(server)
  const json = { "content-type": "application/json" }
  if (scenario.yolo !== false) {
    const response = await server.request(`/api/session/${sessionID}/autonomy`, { method: "PUT", headers: json, body: JSON.stringify({ permissions: "yolo", guardrails: "yolo", answers: "yolo" }) })
    expect(response.status, await response.clone().text()).toBe(200)
  }
  return {
    directory,
    server,
    strict,
    events,
    sessionID,
    mainRequests,
    toolReturned: second.promise,
    setYolo: async (yolo: boolean) => {
      const response = await server.request(`/api/session/${sessionID}/autonomy`, { method: "PUT", headers: json, body: JSON.stringify(yolo ? { permissions: "yolo", guardrails: "yolo", answers: "yolo" } : { permissions: "manual", guardrails: "manual", answers: "manual" }) })
      expect(response.status, await response.clone().text()).toBe(200)
    },
    prompt: async () => {
      const response = await server.request(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ id: "msg_decision_recovery", text: "Run the synthetic check." }),
      })
      expect(response.status, await response.clone().text()).toBe(200)
    },
    permissions: async () => {
      const response = await server.request(`/api/session/${sessionID}/permission`)
      expect(response.status).toBe(200)
      return ((await response.json()) as { data: Array<Record<string, any>> }).data
    },
    guardrails: async () => {
      const response = await server.request(`/api/session/${sessionID}/guardrail/request`)
      expect(response.status).toBe(200)
      return ((await response.json()) as { data: Array<Record<string, any>> }).data
    },
    rejectPermission: async (requestID: string) => {
      const response = await server.request(`/api/session/${sessionID}/permission/${requestID}/reject`, { method: "POST", headers: json, body: "{}" })
      expect(response.status, await response.clone().text()).toBeLessThan(300)
    },
    rejectGuardrail: async (requestID: string) => {
      const response = await server.request(`/api/session/${sessionID}/guardrail/request/${requestID}/reply`, { method: "POST", headers: json, body: JSON.stringify({ reply: "reject" }) })
      expect(response.status, await response.clone().text()).toBeLessThan(300)
    },
  }
}

const allow = (confidence = 0.95): StrictReply => ({ grades: { allow: confidence } })

const timeout = 60_000

describe("decision recovery end to end through the real server, Permission, and a strict loopback helper", () => {
  test("an unsupported YOLO purpose pin recovers on the separately configured strict helper and approves without a user prompt", async () => {
    const run = await boot({ command: "touch approved.txt", strict: () => allow() })
    await run.prompt()
    await deadline(run.toolReturned, "the shell call never settled")
    expect(existsSync(join(run.directory, "approved.txt"))).toBe(true)
    expect(await run.permissions()).toEqual([])
    expect(run.events.of("permission.asked")).toEqual([])
    expect(run.strict.calls).toHaveLength(1)
    expect(run.strict.calls[0]!.question).toBe("permission")
    expect(run.strict.calls[0]!.body).toContain("allow")
    expect(run.strict.calls[0]!.body).toContain("escalate")
    const assessed = run.events.of("session.permission.assessed")
    expect(assessed.map((event) => event.data)).toEqual([expect.objectContaining({ outcome: "allow", via: "yolo", authority: "yolo", choice: "allow" })])
    expect(run.mainRequests.every((request) => Array.isArray(Reflect.get(request as object, "tools")))).toBe(true)
    const audited = run.events.of("session.decision.audited").map((event) => event.data)
    expect(audited).toEqual([
      expect.objectContaining({ purpose: "permission", authority: "yolo", agent: "yolo-permission", outcome: "succeeded", model: expect.objectContaining({ providerID: "strict-helper" }) }),
    ])
  }, timeout)

  test("a malformed first structured response is repaired once and the validated repair approves", async () => {
    const run = await boot({
      command: "touch repaired.txt",
      strict: (call) => (call.index === 0 ? { raw: "this is not the strict document {" } : allow()),
    })
    await run.prompt()
    await deadline(run.toolReturned, "the shell call never settled")
    expect(existsSync(join(run.directory, "repaired.txt"))).toBe(true)
    expect(run.strict.calls).toHaveLength(2)
    expect(run.strict.calls[0]!.body).not.toContain("not a valid JSON document")
    expect(run.strict.calls[1]!.body).toContain("not a valid JSON document")
    expect(await run.permissions()).toEqual([])
    expect(run.events.of("permission.asked")).toEqual([])
    expect(run.events.of("session.permission.assessed").map((event) => event.data)).toEqual([expect.objectContaining({ outcome: "allow", via: "yolo" })])
  }, timeout)

  test("bounded exhaustion of malformed responses leaves exactly one pending manual request with the typed reason", async () => {
    const run = await boot({ command: "touch exhausted.txt", strict: () => ({ raw: "never a valid document" }) })
    await run.prompt()
    const asked = await run.events.next("permission.asked", (event) => event.type === "permission.asked")
    expect(asked.data).toMatchObject({ sessionID: run.sessionID, action: "shell", escalation: { authority: "yolo", reason: "invalid-output" } })
    const pending = await run.permissions()
    expect(pending).toHaveLength(1)
    expect(run.strict.calls).toHaveLength(2)
    expect(existsSync(join(run.directory, "exhausted.txt"))).toBe(false)
    expect(run.mainRequests).toHaveLength(1)
    await run.rejectPermission(pending[0]!.id)
    await run.events.next("permission.replied", (event) => event.type === "permission.replied" && event.data.requestID === pending[0]!.id)
    expect(existsSync(join(run.directory, "exhausted.txt"))).toBe(false)
    expect(run.strict.calls).toHaveLength(2)
    expect(run.events.of("session.permission.assessed").map((event) => event.data)).toEqual([
      expect.objectContaining({ outcome: "escalate", via: "yolo", authority: "yolo", reason: "invalid-output" }),
    ])
  }, timeout)

  test("YOLO switched off and on again while the recovered assessment is held never turns its allow into a spontaneous approval", async () => {
    const release = gate()
    const run = await boot({ command: "touch revoked.txt", strict: () => ({ hold: release.promise, then: allow(0.99) }) })
    await run.prompt()
    await deadline(run.strict.firstCall, "the strict helper never received the held assessment")
    await run.setYolo(false)
    await run.setYolo(true)
    release.open()
    const asked = await run.events.next("permission.asked", (event) => event.type === "permission.asked")
    expect(asked.data).toMatchObject({ action: "shell", escalation: { authority: "yolo", reason: "escalated" } })
    expect(existsSync(join(run.directory, "revoked.txt"))).toBe(false)
    expect(run.mainRequests).toHaveLength(1)
    const pending = await run.permissions()
    expect(pending).toHaveLength(1)
    await run.rejectPermission(pending[0]!.id)
    await run.events.next("permission.replied", (event) => event.type === "permission.replied" && event.data.requestID === pending[0]!.id)
    expect(existsSync(join(run.directory, "revoked.txt"))).toBe(false)
    expect(run.events.of("session.permission.assessed").map((event) => event.data)).toEqual([
      expect.objectContaining({ outcome: "escalate", via: "yolo", authority: "yolo" }),
    ])
  }, timeout)

  test("a real hard review stays a mandatory human decision despite a high-confidence helper allow", async () => {
    const command = 'sqlite3 hard-target.db "DROP TABLE users"; touch hard-released.txt'
    const run = await boot({ command, strict: () => allow(0.99) })
    await run.prompt()
    const asked = await run.events.next("guardrail.asked", (event) => event.type === "guardrail.asked")
    expect(asked.data).toMatchObject({ sessionID: run.sessionID, hardReview: true, ruleIDs: ["standard.review.database-destructive"], escalation: { authority: "yolo", choice: "allow" } })
    expect(existsSync(join(run.directory, "hard-released.txt"))).toBe(false)
    expect(run.mainRequests).toHaveLength(1)
    const pending = await run.guardrails()
    expect(pending).toHaveLength(1)
    expect(run.strict.calls.map((call) => call.question)).toEqual(["permission", "guardrail"])
    expect(run.events.of("session.guardrail.decided")).toEqual([])
    await run.rejectGuardrail(pending[0]!.id)
    await deadline(run.toolReturned, "the rejected hard review never settled")
    expect(existsSync(join(run.directory, "hard-released.txt"))).toBe(false)
  }, timeout)

  test("an explicit deny rule is enforced before any helper call", async () => {
    const run = await boot({
      command: "touch denied.txt",
      strict: () => allow(0.99),
      permissions: [{ action: "shell", resource: "touch denied.txt", effect: "deny" }],
    })
    await run.prompt()
    await deadline(run.toolReturned, "the denied shell call never settled")
    expect(existsSync(join(run.directory, "denied.txt"))).toBe(false)
    expect(run.strict.calls).toEqual([])
    expect(await run.permissions()).toEqual([])
    expect(run.events.of("permission.asked")).toEqual([])
    expect(run.events.of("session.permission.assessed")).toEqual([])
  }, timeout)

  test("with YOLO and baseline assessment both off a permission ask goes to the human without any helper request", async () => {
    const run = await boot({ command: "touch manual.txt", strict: () => allow(0.99), yolo: false })
    await run.prompt()
    const asked = await run.events.next("permission.asked", (event) => event.type === "permission.asked")
    expect(asked.data).toMatchObject({ sessionID: run.sessionID, action: "shell" })
    expect(asked.data).not.toHaveProperty("escalation")
    expect(run.strict.calls).toEqual([])
    expect(existsSync(join(run.directory, "manual.txt"))).toBe(false)
    expect(run.events.of("session.permission.assessed")).toEqual([])
    expect(run.events.of("session.decision.audited")).toEqual([])
    const pending = await run.permissions()
    expect(pending).toHaveLength(1)
    await run.rejectPermission(pending[0]!.id)
    await run.events.next("permission.replied", (event) => event.type === "permission.replied" && event.data.requestID === pending[0]!.id)
    expect(existsSync(join(run.directory, "manual.txt"))).toBe(false)
  }, timeout)

  for (const scenario of [
    { name: "a pinned decision helper", file: "manual-pinned.txt", pinDecision: true },
    { name: "an approving strict helper", file: "manual-approving.txt", pinDecision: false },
  ]) {
    test(`with guardrails.decide_reviews on and Manual permissions, ${scenario.name} is never called and the ask goes to the human`, async () => {
      const run = await boot({ command: `touch ${scenario.file}`, strict: () => allow(0.99), yolo: false, baseline: true, pinUnsupported: false, pinDecision: scenario.pinDecision })
      await run.prompt()
      const asked = await run.events.next("permission.asked", (event) => event.type === "permission.asked")
      expect(asked.data).toMatchObject({ sessionID: run.sessionID, action: "shell" })
      expect(asked.data).not.toHaveProperty("escalation")
      expect(run.strict.calls).toEqual([])
      expect(run.events.of("session.permission.assessed")).toEqual([])
      expect(run.events.of("session.decision.audited")).toEqual([])
      expect(existsSync(join(run.directory, scenario.file))).toBe(false)
      const pending = await run.permissions()
      expect(pending).toHaveLength(1)
      await run.rejectPermission(pending[0]!.id)
      await run.events.next("permission.replied", (event) => event.type === "permission.replied" && event.data.requestID === pending[0]!.id)
      expect(existsSync(join(run.directory, scenario.file))).toBe(false)
    }, timeout)
  }

  test("without a configured decision helper the helper inherits the unsupported Session model and escalates without any provider attempt", async () => {
    const run = await boot({ command: "touch inherited.txt", strict: () => allow(0.99), pinUnsupported: false, omitHelper: true })
    await run.prompt()
    const asked = await run.events.next("permission.asked", (event) => event.type === "permission.asked")
    expect(asked.data).toMatchObject({ action: "shell", escalation: { authority: "yolo", reason: "unsupported-output" } })
    expect(run.strict.calls).toEqual([])
    expect(existsSync(join(run.directory, "inherited.txt"))).toBe(false)
    expect(run.mainRequests).toHaveLength(1)
    expect(run.events.of("session.permission.assessed").map((event) => event.data)).toEqual([
      expect.objectContaining({ outcome: "escalate", via: "yolo", authority: "yolo", reason: "unsupported-output" }),
    ])
    expect(run.events.of("session.decision.audited").map((event) => event.data)).toEqual([
      expect.objectContaining({ purpose: "permission", authority: "yolo", outcome: "failed", reason: "unsupported-output", attempts: 0 }),
    ])
    const pending = await run.permissions()
    expect(pending).toHaveLength(1)
    await run.rejectPermission(pending[0]!.id)
    await run.events.next("permission.replied", (event) => event.type === "permission.replied" && event.data.requestID === pending[0]!.id)
    expect(existsSync(join(run.directory, "inherited.txt"))).toBe(false)
    expect(run.strict.calls).toEqual([])
  }, timeout)
})
