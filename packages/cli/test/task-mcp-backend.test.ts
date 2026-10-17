import { afterEach, describe, expect, test } from "bun:test"
import { YCoding } from "@ycoding-ai/client/promise"
import { TaskMCPTasks } from "@ycoding-ai/core/task-mcp/tasks"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { makeTaskMcpBackend } from "../src/task-mcp-backend"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "ycoding-task-backend-")))
  roots.push(directory)
  const workspace = path.join(directory, "ses_mcp_task")
  await mkdir(workspace)
  const sessionID = "ses_mcp_task"
  const session = { id: sessionID, location: { directory: workspace } }
  const responses = new Map<string, unknown>([
    ["/api/project/current", { id: "project", directory }],
    ["/experimental/project/project/copy", { directory: workspace }],
    ["/api/session", { data: session }],
    [`/api/session/${sessionID}`, { data: session }],
    [`/api/session/${sessionID}/snapshot`, { session, messages: [] }],
    ["/api/session/active", { data: {} }],
    ["/api/session/outstanding", { data: [], running: [], failed: [], lost: [] }],
    [`/api/session/${sessionID}/pending`, { data: [] }],
    [`/api/session/${sessionID}/permission`, { data: [] }],
    [`/api/session/${sessionID}/form`, { data: [] }],
    [`/api/session/${sessionID}/question`, { data: [] }],
    [`/api/session/${sessionID}/guardrail/request`, { data: [] }],
    [`/api/session/${sessionID}/review`, { data: [] }],
  ])
  const events: { type: string; durable: { aggregateID: string; seq: number }; data: unknown }[] = []
  const hooks = new Map<string, () => void>()
  const requests: { method: string; url: URL; body: unknown; headers: Headers }[] = []
  const client = YCoding.make({
    baseUrl: "http://ycoding.test",
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          url,
          body: request.method === "GET" ? undefined : await request.json().catch(() => undefined),
          headers: request.headers,
        })
        hooks.get(url.pathname)?.()
        if (url.pathname === `/api/experimental/session/${sessionID}/log`) {
          const after = Number(url.searchParams.get("after") ?? -1)
          return new Response(
            events
              .filter((event) => event.durable.seq > after)
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          )
        }
        if (url.pathname === `/api/session/${sessionID}/prompt`) return Response.json({ data: {} })
        if (url.pathname === `/api/session/${sessionID}/interrupt`) return new Response(null, { status: 204 })
        if (!responses.has(url.pathname)) throw new Error(`Unexpected request: ${request.method} ${url.pathname}`)
        const response = responses.get(url.pathname)
        return response instanceof Response ? response.clone() : Response.json(response)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const event = (type: string, data: object = {}) =>
    events.push({ type, durable: { aggregateID: sessionID, seq: events.length }, data: { sessionID, ...data } })
  return {
    directory,
    workspace,
    sessionID,
    session,
    responses,
    requests,
    hooks,
    event,
    client,
    backend: makeTaskMcpBackend(client, directory),
  }
}

describe("task MCP backend", () => {
  test("prepares a named worktree and fixed Session configuration, then admits the fixed prompt ID", async () => {
    const input = await fixture()
    const model = { providerID: "provider", id: "model" }
    const backend = makeTaskMcpBackend(input.client, input.directory, "build", model)
    await backend.prepare(input)
    await backend.start({ ...input, promptID: "msg_task", prompt: "Implement the change" })
    expect(input.requests.find((request) => request.url.pathname.endsWith("/copy"))?.body).toEqual({
      strategy: "git_worktree",
      directory: input.directory,
      name: "ses_mcp_task",
    })
    expect(input.requests.find((request) => request.url.pathname === "/api/session")?.body).toEqual({
      id: input.sessionID,
      location: { directory: input.workspace },
      agent: "build",
      model,
    })
    expect(input.requests.find((request) => request.url.pathname.endsWith("/prompt"))?.body).toMatchObject({
      id: "msg_task",
      text: "Implement the change",
    })
    expect(
      input.requests.find((request) => request.url.pathname.endsWith("/prompt"))?.headers.get("x-ycoding-directory"),
    ).toBe(encodeURIComponent(input.workspace))
  })

  test("rejects a renamed worktree destination without creating a Session", async () => {
    const input = await fixture()
    input.responses.set("/experimental/project/project/copy", { directory: input.directory })
    await expect(input.backend.prepare(input)).rejects.toThrow("workspace")
    expect(input.requests.some((request) => request.url.pathname === "/api/session")).toBe(false)
  })

  test.each([
    ["session.execution.succeeded", {}, "completed"],
    ["session.execution.failed", { error: { type: "unknown", message: "failed" } }, "failed"],
    ["session.execution.failed", { error: { type: "interrupted", message: "server stopped" } }, "interrupted"],
    ["session.execution.interrupted", { reason: "user" }, "interrupted"],
  ] as const)("reads durable terminal state %s", async (type, data, expected) => {
    const input = await fixture()
    input.event("session.execution.started")
    input.event(type, data)
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe(expected)
    expect(
      input.requests.find((request) => request.url.pathname.endsWith("/log"))?.url.searchParams.get("follow"),
    ).toBe("false")
    expect(
      input.requests.find((request) => request.url.pathname.endsWith("/snapshot"))?.url.searchParams.get("limit"),
    ).toBe("20")
  })

  test("never considers empty idle or an unterminated execution successful", async () => {
    const input = await fixture()
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("interrupted")
    input.event("session.execution.started")
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("interrupted")
  })

  test("uses the latest execution rather than an earlier successful run", async () => {
    const input = await fixture()
    input.event("session.execution.succeeded")
    input.event("session.execution.started")
    input.event("session.execution.failed", { error: { type: "unknown", message: "failed" } })
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("failed")
  })

  test("reconciles a completion between log and active reads before taking the result snapshot", async () => {
    const input = await fixture()
    input.event("session.execution.started")
    input.hooks.set("/api/session/active", () => {
      input.event("session.execution.succeeded")
      input.responses.set(`/api/session/${input.sessionID}/snapshot`, {
        session: input.session,
        messages: [{ type: "assistant", content: [{ type: "text", text: "Finished" }] }],
      })
    })
    expect(await input.backend.inspect(input.sessionID, input.workspace)).toEqual({
      state: "completed",
      text: "Finished",
      truncated: false,
    })
    const reads = input.requests.filter((request) => request.url.pathname.endsWith("/log"))
    expect(reads).toHaveLength(2)
    expect(reads[1].url.searchParams.get("after")).toBe("0")
  })

  test.each(["permission", "form", "question", "guardrail/request", "review"])(
    "reports waiting for %s even after execution succeeded",
    async (kind) => {
      const input = await fixture()
      input.event("session.execution.succeeded")
      input.responses.set(`/api/session/${input.sessionID}/${kind}`, { data: [{ sessionID: input.sessionID }] })
      expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("waiting")
    },
  )

  test("distinguishes active execution, retained pending input, and outstanding child work", async () => {
    const input = await fixture()
    input.event("session.execution.succeeded")
    input.responses.set("/api/session/active", { data: { [input.sessionID]: { type: "running" } } })
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("running")
    input.responses.set("/api/session/active", { data: {} })
    input.responses.set(`/api/session/${input.sessionID}/pending`, { data: [{ id: "msg_pending" }] })
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("queued")
    input.responses.set(`/api/session/${input.sessionID}/pending`, { data: [] })
    input.responses.set("/api/session/outstanding", { data: [input.sessionID], running: [], failed: [], lost: [] })
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("running")
  })

  test("returns only the latest assistant text with a valid 32 KiB UTF-8 bound", async () => {
    const input = await fixture()
    input.event("session.execution.succeeded")
    input.responses.set(`/api/session/${input.sessionID}/snapshot`, {
      session: input.session,
      messages: [
        { type: "assistant", content: [{ type: "text", text: "old output" }] },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "private reasoning" },
            { type: "tool", name: "bash", state: { output: "tool output" } },
            { type: "text", text: "界".repeat(12000) },
          ],
        },
      ],
    })
    const result = await input.backend.inspect(input.sessionID, input.workspace)
    expect(result.text).toBe("界".repeat(10922))
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32768)
    expect(result.truncated).toBe(true)
  })

  test("interrupts the intended Session but preserves pending-work truth", async () => {
    const input = await fixture()
    input.event("session.execution.interrupted", { reason: "user" })
    input.responses.set(`/api/session/${input.sessionID}/pending`, { data: [{ id: "msg_pending" }] })
    await input.backend.cancel(input.sessionID, input.workspace)
    expect(input.requests.filter((request) => request.url.pathname.endsWith("/interrupt"))).toHaveLength(1)
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("queued")
  })

  test("rejects Sessions moved out of the owned workspace before reading, prompting, or interrupting", async () => {
    const input = await fixture()
    input.responses.set(`/api/session/${input.sessionID}`, {
      data: { ...input.session, location: { directory: input.directory } },
    })
    await expect(input.backend.inspect(input.sessionID, input.workspace)).rejects.toThrow("workspace")
    await expect(input.backend.start({ ...input, promptID: "msg_task", prompt: "Run" })).rejects.toThrow("workspace")
    await expect(input.backend.cancel(input.sessionID, input.workspace)).rejects.toThrow("workspace")
    expect(input.requests.every((request) => request.url.pathname === `/api/session/${input.sessionID}`)).toBe(true)
  })

  test("rejects a Session moved during inspection instead of returning its transcript", async () => {
    const input = await fixture()
    input.responses.set(`/api/session/${input.sessionID}/snapshot`, {
      session: { ...input.session, location: { directory: input.directory } },
      messages: [],
    })
    await expect(input.backend.inspect(input.sessionID, input.workspace)).rejects.toThrow("workspace")
  })

  test("treats a missing Session as interrupted and propagates backend failures", async () => {
    const input = await fixture()
    input.responses.set(
      `/api/session/${input.sessionID}`,
      Response.json(
        { _tag: "SessionNotFoundError", sessionID: input.sessionID, message: "Session not found" },
        { status: 404 },
      ),
    )
    expect((await input.backend.inspect(input.sessionID, input.workspace)).state).toBe("interrupted")
    input.responses.set(`/api/session/${input.sessionID}`, new Response("unavailable", { status: 503 }))
    await expect(input.backend.inspect(input.sessionID, input.workspace)).rejects.toThrow()
  })

  test("lists exact question, Form, permission, and guardrail details without blanket approval", async () => {
    const input = await fixture()
    const question = {
      id: "que_1",
      sessionID: input.sessionID,
      questions: [
        {
          header: "Choice",
          question: "Which branch?",
          options: [{ label: "Main", description: "Use main" }],
          custom: false,
        },
      ],
    }
    const form = {
      id: "form_1",
      sessionID: input.sessionID,
      title: "Input",
      fields: [{ key: "name", type: "string", required: true }],
      metadata: { source: "question tool" },
    }
    const permission = {
      id: "per_1",
      sessionID: input.sessionID,
      action: "bash",
      resources: ["git status"],
      save: ["git *"],
      metadata: { command: "git status" },
    }
    const guardrail = {
      id: "grd_1",
      rootSessionID: input.sessionID,
      sessionID: input.sessionID,
      action: "bash",
      resources: ["git reset"],
      ruleIDs: ["hard-review"],
      reason: "Review destructive Git",
      standard: true,
      hardReview: true,
    }
    input.responses.set(`/api/session/${input.sessionID}/question`, { data: [question] })
    input.responses.set(`/api/session/${input.sessionID}/form`, { data: [form] })
    input.responses.set(`/api/session/${input.sessionID}/permission`, { data: [permission] })
    input.responses.set(`/api/session/${input.sessionID}/guardrail/request`, { data: [guardrail] })
    const result = await input.backend.interactions(input.sessionID, input.workspace)
    expect(result.truncated).toBe(false)
    expect(result.items).toHaveLength(4)
    expect(result.items.find((item) => item.kind === "question")).toMatchObject({
      interactionId: "question:que_1",
      details: question,
      allowedResponses: ["question", "cancel"],
      actionable: true,
    })
    expect(result.items.find((item) => item.kind === "form")).toMatchObject({
      details: form,
      allowedResponses: ["form", "cancel"],
    })
    expect(result.items.find((item) => item.kind === "permission")).toMatchObject({
      details: permission,
      allowedResponses: ["once", "reject"],
    })
    expect(result.items.find((item) => item.kind === "guardrail")).toMatchObject({
      details: guardrail,
      allowedResponses: ["once", "reject"],
    })
    expect(result.items.every((item) => /^[a-f0-9]{64}$/.test(item.revision))).toBe(true)
    expect(await input.backend.interactions(input.sessionID, input.workspace)).toEqual(result)
  })

  test("answers an exact pending question and rejects stale and duplicate replies", async () => {
    const input = await fixture()
    const pending = `/api/session/${input.sessionID}/question`
    const reply = `${pending}/que_1/reply`
    input.responses.set(pending, {
      data: [
        {
          id: "que_1",
          sessionID: input.sessionID,
          questions: [
            { header: "Choice", question: "Which?", options: [{ label: "A", description: "First" }], custom: false },
          ],
        },
      ],
    })
    input.responses.set(reply, new Response(null, { status: 204 }))
    input.hooks.set(reply, () => input.responses.set(pending, { data: [] }))
    const item = (await input.backend.interactions(input.sessionID, input.workspace)).items[0]
    const response = {
      interactionId: item.interactionId,
      revision: item.revision,
      response: { action: "question" as const, answers: [["A"]] },
    }
    const results = await Promise.allSettled([
      input.backend.respond(input.sessionID, input.workspace, response),
      input.backend.respond(input.sessionID, input.workspace, response),
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
    expect(input.requests.filter((request) => request.url.pathname === reply)).toHaveLength(1)
    expect(input.requests.find((request) => request.url.pathname === reply)?.body).toEqual({ answers: [["A"]] })
  })

  test("requires the current request revision and valid exact answer selections before any reply", async () => {
    const input = await fixture()
    const pending = `/api/session/${input.sessionID}/question`
    const question = {
      id: "que_1",
      sessionID: input.sessionID,
      questions: [
        { header: "Choice", question: "Which?", options: [{ label: "A", description: "First" }], custom: false },
      ],
    }
    input.responses.set(pending, { data: [question] })
    const item = (await input.backend.interactions(input.sessionID, input.workspace)).items[0]
    for (const answers of [[], [["B"]], [["A", "A"]]]) {
      await expect(
        input.backend.respond(input.sessionID, input.workspace, {
          interactionId: item.interactionId,
          revision: item.revision,
          response: { action: "question", answers },
        }),
      ).rejects.toThrow()
    }
    input.responses.set(pending, {
      data: [{ ...question, questions: [{ ...question.questions[0], question: "Changed question" }] }],
    })
    await expect(
      input.backend.respond(input.sessionID, input.workspace, {
        interactionId: item.interactionId,
        revision: item.revision,
        response: { action: "question", answers: [["A"]] },
      }),
    ).rejects.toThrow("changed")
    expect(input.requests.every((request) => request.method === "GET")).toBe(true)
  })

  test("exposes other-family-session requests only as non-actionable notices and rejects moved Sessions", async () => {
    const input = await fixture()
    input.responses.set(`/api/session/${input.sessionID}/permission`, {
      data: [{ id: "per_foreign", sessionID: "ses_foreign", action: "bash", resources: ["foreign secret"] }],
    })
    input.responses.set(`/api/session/${input.sessionID}/guardrail/request`, {
      data: [
        {
          id: "grd_child",
          rootSessionID: input.sessionID,
          sessionID: "ses_child",
          action: "bash",
          resources: ["child secret"],
          ruleIDs: [],
          reason: "review",
          standard: true,
        },
      ],
    })
    const result = await input.backend.interactions(input.sessionID, input.workspace)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ actionable: false, allowedResponses: [], sessionID: "ses_child" })
    expect(JSON.stringify(result)).not.toContain("secret")
    await expect(
      input.backend.respond(input.sessionID, input.workspace, {
        interactionId: result.items[0].interactionId,
        revision: result.items[0].revision,
        response: { action: "once" },
      }),
    ).rejects.toThrow()
    input.responses.set(`/api/session/${input.sessionID}`, {
      data: { ...input.session, location: { directory: input.directory } },
    })
    await expect(input.backend.interactions(input.sessionID, input.workspace)).rejects.toThrow("workspace")
  })

  test("rejects only the exact permission through the request-scoped endpoint despite a new pending request", async () => {
    const input = await fixture()
    const permission = { id: "per_1", sessionID: input.sessionID, action: "bash", resources: ["git status"] }
    const pending = `/api/session/${input.sessionID}/permission`
    input.responses.set(pending, { data: [permission] })
    const previous = (await input.backend.interactions(input.sessionID, input.workspace)).items[0]
    input.responses.set(pending, { data: [permission, { ...permission, id: "per_2" }] })
    const endpoint = `${pending}/per_1/reject`
    input.responses.set(endpoint, new Response(null, { status: 204 }))
    input.hooks.set(endpoint, () => input.responses.set(pending, { data: [{ ...permission, id: "per_2" }] }))
    await input.backend.respond(input.sessionID, input.workspace, {
      interactionId: previous.interactionId,
      revision: previous.revision,
      response: { action: "reject" },
    })
    expect(
      (await input.backend.interactions(input.sessionID, input.workspace)).items.map((item) => item.interactionId),
    ).toEqual(["permission:per_2"])
    expect(
      input.requests.filter((request) => request.method === "POST").map((request) => request.url.pathname),
    ).toEqual([endpoint])
  })

  test("never falls back to reject-all when an older runtime lacks request-scoped rejection", async () => {
    const input = await fixture()
    const pending = `/api/session/${input.sessionID}/permission`
    input.responses.set(pending, {
      data: [{ id: "per_1", sessionID: input.sessionID, action: "bash", resources: ["git status"] }],
    })
    const endpoint = `${pending}/per_1/reject`
    input.responses.set(endpoint, Response.json({ message: "Route not found" }, { status: 404 }))
    const interaction = (await input.backend.interactions(input.sessionID, input.workspace)).items[0]
    const failure = await input.backend
      .respond(input.sessionID, input.workspace, {
        interactionId: interaction.interactionId,
        revision: interaction.revision,
        response: { action: "reject" },
      })
      .catch((error: unknown) => error)
    expect(failure).toBeDefined()
    expect(failure).not.toBeInstanceOf(TaskMCPTasks.InteractionRejected)
    expect(
      input.requests.filter((request) => request.method === "POST").map((request) => request.url.pathname),
    ).toEqual([endpoint])
  })

  test("keeps oversized details non-actionable and bounds each interaction page", async () => {
    const input = await fixture()
    input.responses.set(`/api/session/${input.sessionID}/permission`, {
      data: Array.from({ length: 51 }, (_, index) => ({
        id: `per_${String(index).padStart(3, "0")}`,
        sessionID: input.sessionID,
        action: "bash",
        resources: ["x".repeat(index === 0 ? 20_000 : 2000)],
      })),
    })
    const result = await input.backend.interactions(input.sessionID, input.workspace)
    expect(result.truncated).toBe(true)
    expect(result.items.length).toBeLessThanOrEqual(50)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536)
    expect(result.items[0]).toMatchObject({ actionable: false, allowedResponses: [] })
  })

  test.each([
    {
      kind: "form",
      id: "form_1",
      path: "form",
      suffix: "reply",
      value: { title: "Input", fields: [{ key: "name", type: "string", required: true }] },
      response: { action: "form", answer: { name: "Ada" } },
      body: { answer: { name: "Ada" } },
    },
    {
      kind: "form",
      id: "form_1",
      path: "form",
      suffix: "cancel",
      value: { title: "Input", fields: [{ key: "name", type: "string" }] },
      response: { action: "cancel" },
      body: undefined,
    },
    {
      kind: "question",
      id: "que_1",
      path: "question",
      suffix: "reject",
      value: { questions: [] },
      response: { action: "cancel" },
      body: undefined,
    },
    {
      kind: "permission",
      id: "per_1",
      path: "permission",
      suffix: "reply",
      value: { action: "bash", resources: ["git status"] },
      response: { action: "once" },
      body: { reply: "once" },
    },
    {
      kind: "guardrail",
      id: "grd_1",
      path: "guardrail/request",
      suffix: "reply",
      value: {
        action: "bash",
        resources: ["git reset"],
        reason: "Review",
        ruleIDs: ["review"],
        standard: true,
        hardReview: true,
      },
      response: { action: "reject" },
      body: { reply: "reject" },
    },
  ] as const)("maps $kind $response.action to its exact owned runtime operation", async (item) => {
    const input = await fixture()
    input.responses.set(`/api/session/${input.sessionID}/${item.path}`, {
      data: [{ ...item.value, id: item.id, sessionID: input.sessionID, rootSessionID: input.sessionID }],
    })
    const endpoint = `/api/session/${input.sessionID}/${item.path}/${item.id}/${item.suffix}`
    input.responses.set(endpoint, new Response(null, { status: 204 }))
    const interaction = (await input.backend.interactions(input.sessionID, input.workspace)).items[0]
    await input.backend.respond(input.sessionID, input.workspace, {
      interactionId: interaction.interactionId,
      revision: interaction.revision,
      response: item.response,
    })
    expect(input.requests.filter((request) => request.method === "POST")).toHaveLength(1)
    expect(input.requests.find((request) => request.url.pathname === endpoint)?.body).toEqual(item.body)
  })

  test.each([
    {
      kind: "question",
      payload: { type: "form", title: "Input", fields: [{ key: "name", type: "string", required: true }] },
      response: { action: "form", answer: { name: "Ada" } },
      decision: { kind: "question", answers: { name: "Ada" } },
    },
    {
      kind: "question",
      payload: { type: "question", questions: [{ header: "Input", question: "What next?", options: [] }] },
      response: { action: "question", answers: [["Check tests"]] },
      decision: { kind: "question", answers: [["Check tests"]] },
    },
    {
      kind: "question",
      payload: { type: "question", questions: [] },
      response: { action: "cancel" },
      decision: { kind: "question", dismissed: true },
    },
    {
      kind: "permission",
      payload: {
        type: "permission",
        action: "bash",
        resources: ["git status"],
        fingerprint: "fingerprint",
        requestID: "per_1",
      },
      response: { action: "reject" },
      decision: { kind: "permission", reply: "reject" },
    },
    {
      kind: "guardrail",
      payload: {
        type: "guardrail",
        action: "bash",
        resources: ["git reset"],
        ruleIDs: ["review"],
        reason: "Review",
        hardReview: true,
        directories: [],
        fingerprint: "fingerprint",
        requestID: "grd_1",
      },
      response: { action: "once" },
      decision: { kind: "guardrail", reply: "once" },
    },
  ] satisfies Array<{ kind: string; payload: unknown; response: TaskMCPTasks.InteractionResponse; decision: unknown }>)(
    "responds to root deferred $kind reviews without broad approval",
    async (item) => {
      const input = await fixture()
      input.responses.set(`/api/session/${input.sessionID}/review`, {
        data: [
          {
            kind: item.kind,
            payload: item.payload,
            itemID: "rev_1",
            sessionID: input.sessionID,
            rootSessionID: input.sessionID,
            sessionTitle: "Task",
            created: 1,
            reason: "sleep_entry",
            origin: { requestID: "req_1" },
          },
        ],
      })
      const endpoint = `/api/session/${input.sessionID}/review/rev_1/decide`
      input.responses.set(endpoint, new Response(null, { status: 204 }))
      const interaction = (await input.backend.interactions(input.sessionID, input.workspace)).items[0]
      await input.backend.respond(input.sessionID, input.workspace, {
        interactionId: interaction.interactionId,
        revision: interaction.revision,
        response: item.response,
      })
      expect(input.requests.find((request) => request.url.pathname === endpoint)?.body).toEqual({
        decision: item.decision,
      })
    },
  )

  test.each(["form", "review"] as const)(
    "allows corrected answers after a confirmed invalid $type answer, but preserves transport errors",
    async (kind) => {
      const input = await fixture()
      const form = { title: "Input", fields: [{ key: "name", type: "string", required: true }] }
      const value =
        kind === "form"
          ? { ...form, id: "form_1", sessionID: input.sessionID }
          : {
              itemID: "rev_1",
              kind: "question",
              payload: { ...form, type: "form" },
              sessionID: input.sessionID,
              rootSessionID: input.sessionID,
            }
      input.responses.set(`/api/session/${input.sessionID}/${kind}`, { data: [value] })
      const endpoint =
        kind === "form"
          ? `/api/session/${input.sessionID}/form/form_1/reply`
          : `/api/session/${input.sessionID}/review/rev_1/decide`
      input.responses.set(
        endpoint,
        Response.json(
          {
            _tag: kind === "form" ? "FormInvalidAnswerError" : "InvalidRequestError",
            message: "Missing name",
            id: "form_1",
          },
          { status: 400 },
        ),
      )
      const interaction = (await input.backend.interactions(input.sessionID, input.workspace)).items[0]
      const request = { interactionId: interaction.interactionId, revision: interaction.revision }
      await expect(
        input.backend.respond(input.sessionID, input.workspace, {
          ...request,
          response: { action: "form", answer: {} },
        }),
      ).rejects.toBeInstanceOf(TaskMCPTasks.InteractionRejected)
      input.responses.set(endpoint, new Response(null, { status: 204 }))
      await input.backend.respond(input.sessionID, input.workspace, {
        ...request,
        response: { action: "form", answer: { name: "Ada" } },
      })
      input.responses.set(endpoint, new Response("Unavailable", { status: 503 }))
      const failure = await input.backend
        .respond(input.sessionID, input.workspace, {
          ...request,
          response: { action: "form", answer: { name: "Ada" } },
        })
        .catch((error: unknown) => error)
      expect(failure).not.toBeInstanceOf(TaskMCPTasks.InteractionRejected)
    },
  )

  test("does not expose recovery or subagent review decisions as gateway approvals", async () => {
    const input = await fixture()
    input.responses.set(`/api/session/${input.sessionID}/review`, {
      data: [
        {
          itemID: "rev_recovery",
          kind: "recovery",
          payload: { type: "recovery", tools: [] },
          sessionID: input.sessionID,
          rootSessionID: input.sessionID,
        },
        {
          itemID: "rev_child",
          kind: "subagent_question",
          payload: { text: "Help" },
          sessionID: input.sessionID,
          rootSessionID: input.sessionID,
        },
      ],
    })
    expect(
      (await input.backend.interactions(input.sessionID, input.workspace)).items.every(
        (item) => !item.actionable && item.allowedResponses.length === 0,
      ),
    ).toBe(true)
  })
})
