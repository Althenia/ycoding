import { afterEach, describe, expect, test } from "bun:test"
import { YCoding } from "@ycoding-ai/client/promise"
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
        return response instanceof Response ? response : Response.json(response)
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

  test.each(["permission", "form", "guardrail/request", "review"])(
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
})
