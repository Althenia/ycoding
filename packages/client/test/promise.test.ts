import { expect, test } from "bun:test"
import { SessionCompaction } from "@ycoding-ai/schema"
import { isSessionNotFoundError, isUnauthorizedError, YCoding } from "../src/promise/index"

test("exposes every standard HTTP API group", () => {
  const client = YCoding.make({ baseUrl: "http://localhost:3000" })

  expect(Object.keys(client)).toEqual([
    "health",
    "server",
    "location",
    "agent",
    "plugin",
    "session",
    "guardrail",
    "message",
    "model",
    "generate",
    "provider",
    "providerUsage",
    "integration",
    "mcp",
    "credential",
    "project",
    "form",
    "permission",
    "file",
    "command",
    "skill",
    "event",
    "pty",
    "shell",
    "question",
    "reference",
    "projectCopy",
    "vcs",
    "projectArtifact",
    "debug",
    "browser",
    "isolatedBrowser",
  ])
  expect(Object.keys(client.debug)).toEqual(["location"])
  expect(Object.keys(client.debug.location)).toEqual(["list", "evict"])
  expect(Object.keys(client.message)).toEqual(["list"])
  expect(Object.keys(client.integration)).toEqual(["list", "get", "wellknown", "connect", "oauth", "command"])
  expect(Object.keys(client.integration.wellknown)).toEqual(["add"])
  expect(Object.keys(client.integration.connect)).toEqual(["key"])
  expect(Object.keys(client.integration.oauth)).toEqual(["connect", "status", "complete", "cancel"])
  expect(Object.keys(client.integration.command)).toEqual(["connect", "status", "cancel"])
  expect(Object.keys(client.file)).toEqual(["read", "list", "find"])
  expect(Object.keys(client.vcs)).toEqual(["status", "branch", "diff"])
  expect(Object.keys(client.pty)).toEqual(["list", "create", "get", "update", "remove", "control", "connect"])
  expect(Object.keys(client.pty.connect)).toEqual(["token"])
  expect(Object.keys(client.shell)).toEqual(["list", "create", "get", "timeout", "output", "remove"])
  expect(Object.keys(client.project)).toEqual(["list", "current", "directories"])
  expect(Object.keys(client.session.subagent)).toEqual(["list", "launch", "message", "answer", "cancel", "resume"])
  expect(Object.keys(client.guardrail)).toEqual(["status", "request"])
  expect(Object.keys(client.guardrail.request)).toEqual(["list", "reply"])
  expect(Object.keys(client.providerUsage)).toEqual(["list", "get"])
  expect(Object.keys(client.browser)).toEqual([
    "status",
    "tabs",
    "start",
    "observe",
    "action",
    "control",
    "stop",
    "forget",
  ])
  expect(Object.keys(client.isolatedBrowser)).toEqual([
    "status",
    "start",
    "tabs",
    "observe",
    "action",
    "control",
    "stop",
  ])
})

test("VCS branch uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return Response.json({
        location: { directory: "/workspace", project: { id: "global", directory: "/workspace" } },
        data: { current: "feature", default: "main" },
      })
    },
  })

  expect(await client.vcs.branch()).toEqual(expect.objectContaining({ data: { current: "feature", default: "main" } }))
  expect(request && new URL(request.url).pathname).toBe("/api/vcs/branch")
})

test("provider usage methods use the public HTTP contract", async () => {
  const requests: Request[] = []
  const snapshot = {
    providerID: "openai",
    label: "Codex",
    status: "available" as const,
    source: "provider_internal_api" as const,
    stability: "best_effort" as const,
    updatedAt: 100,
    windows: [{ id: "codex-primary", label: "5-hour", unit: "percent" as const, used: 25 }],
  }
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return Response.json({
        location: { directory: "/workspace", project: { id: "global", directory: "/workspace" } },
        data: request.url.includes("/openai/") ? snapshot : [snapshot],
      })
    },
  })

  expect(await client.providerUsage.list({ refresh: true })).toEqual(expect.objectContaining({ data: [snapshot] }))
  expect(await client.providerUsage.get({ providerID: "openai", refresh: false })).toEqual(
    expect.objectContaining({ data: snapshot }),
  )
  expect(requests.map((request) => `${new URL(request.url).pathname}?${new URL(request.url).searchParams}`)).toEqual([
    "/api/provider/usage?refresh=true",
    "/api/provider/openai/usage?refresh=false",
  ])
})

test("session diagnostics expose only bounded provider-request telemetry", async () => {
  let request: Request | undefined
  const diagnostics = {
    model: { providerID: "openai", id: "gpt-5.6" },
    context: { total: 32_600 },
    tokens: { uncachedInput: 12_000, output: 900, reasoning: 300, cacheRead: 18_200, cacheWrite: 1_200 },
    cache: {
      eligible: 31_400,
      mechanism: "openai-prefix-cache" as const,
      readReported: true,
      writeReported: true,
    },
    requests: {
      logical: 6,
      physical: 7,
      helpers: 1,
      continued: 3,
      fallback: 1,
      tokens: { input: 12_000, output: 900, reasoning: 300, cache: { read: 18_200, write: 1_200 } },
      latestInvalidation: "tool-prefix-changed" as const,
      latestNamespace: "a1b2c3d4",
    },
  }
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return Response.json({ data: diagnostics })
    },
  })

  const result = await client.session.diagnostics({ sessionID: "ses_test" })

  expect(result).toEqual(diagnostics)
  expect(result?.requests?.latestNamespace).toBe("a1b2c3d4")
  expect(JSON.stringify(result)).not.toContain("promptCacheKey")
  expect(request && new URL(request.url).pathname).toBe("/api/session/ses_test/diagnostics")
})

test("guardrail methods use the public HTTP contract", async () => {
  const requests: Request[] = []
  const status = {
    rootSessionID: "ses_parent",
    profile: "standard",
    customRules: 1,
    approvals: 2,
    blocked: 3,
    counters: [{ id: "shells", current: 1, limit: 8, scope: "family" as const }],
    invalidFiles: [],
  }
  const review = {
    id: "grq_1",
    rootSessionID: "ses_parent",
    sessionID: "ses_child",
    action: "shell",
    resources: ["git reset --hard"],
    ruleIDs: ["standard.review.git-destructive"],
    reason: "Destructive Git operation",
    standard: true,
  }
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (request.method === "POST") return new Response(null, { status: 204 })
      return Response.json({ data: request.url.endsWith("/request") ? [review] : status })
    },
  })

  expect(await client.guardrail.status({ sessionID: "ses_child" })).toEqual(status)
  expect(await client.guardrail.request.list({ sessionID: "ses_parent" })).toEqual([review])
  await client.guardrail.request.reply({ sessionID: "ses_parent", requestID: "grq_1", reply: "once" })

  expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    "GET /api/session/ses_child/guardrail",
    "GET /api/session/ses_parent/guardrail/request",
    "POST /api/session/ses_parent/guardrail/request/grq_1/reply",
  ])
  expect(await requests[2]?.json()).toEqual({ reply: "once" })
})

test("session subagent launch uses the public HTTP contract", async () => {
  let request: Request | undefined
  const task = {
    sessionID: "ses_child",
    parentID: "ses_parent",
    description: "Review",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    background: true,
    state: "running",
    revision: 1,
    time: { created: 1, updated: 2 },
  }
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return Response.json({ data: task })
    },
  })

  expect(
    await client.session.subagent.launch({
      parentID: "ses_parent",
      parentAssistantMessageID: "msg_parent",
      toolCallID: "call_1",
      agent: "reviewer",
      description: "Review",
      prompt: "Review this",
      background: true,
      model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    }),
  ).toEqual(task)
  expect(request?.method).toBe("POST")
  expect(request?.url).toBe("http://localhost:3000/api/session/ses_parent/subagent")
  expect(await request?.json()).toEqual({
    parentAssistantMessageID: "msg_parent",
    toolCallID: "call_1",
    agent: "reviewer",
    description: "Review",
    prompt: "Review this",
    background: true,
    model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
  })
})

test("session subagent controls use their public HTTP contracts", async () => {
  const requests: Request[] = []
  const task = {
    sessionID: "ses_child",
    parentID: "ses_parent",
    description: "Review",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6" },
    background: true,
    state: "running",
    revision: 2,
    time: { created: 1, updated: 2 },
  }
  const page = {
    data: [task],
    summary: { total: 1, active: 1, running: 1, waiting: 0 },
    cursor: {},
  }
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return Response.json(request.method === "GET" ? page : { data: task })
    },
  })

  expect(await client.session.subagent.list({ parentID: "ses_parent" })).toEqual(page)
  expect(
    await client.session.subagent.answer({
      parentID: "ses_parent",
      childID: "ses_child",
      questionID: "qst_1",
      text: "Proceed",
    }),
  ).toEqual(task)
  expect(await client.session.subagent.cancel({ parentID: "ses_parent", childID: "ses_child" })).toEqual(task)
  expect(await client.session.subagent.resume({ parentID: "ses_parent", childID: "ses_child" })).toEqual(task)
  expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    "GET /api/session/ses_parent/subagent",
    "POST /api/session/ses_parent/subagent/ses_child/question/qst_1/answer",
    "POST /api/session/ses_parent/subagent/ses_child/cancel",
    "POST /api/session/ses_parent/subagent/ses_child/resume",
  ])
})

test("server.get uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({ urls: ["http://192.168.1.10:4096"] })
    },
  })

  expect(await client.server.get()).toEqual({ urls: ["http://192.168.1.10:4096"] })
  expect(request?.method).toBe("GET")
  expect(request?.url).toBe("http://localhost:3000/api/server")
})

test("experimental wellknown integration add uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return new Response(null, { status: 204 })
    },
  })

  await client.integration.wellknown.add({
    url: "https://example.com",
    location: { directory: "/tmp/project" },
  })

  expect(request?.method).toBe("POST")
  expect(request?.url).toBe(
    "http://localhost:3000/api/experimental/integration/wellknown?location%5Bdirectory%5D=%2Ftmp%2Fproject",
  )
  expect(await request?.json()).toEqual({ url: "https://example.com" })
})

test("health.stop sends exact replacement identity", async () => {
  let request: Request | undefined
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return Response.json({ accepted: true })
    },
  })

  expect(await client.health.stop({ instanceID: "instance" })).toEqual({ accepted: true })
  expect(request?.method).toBe("POST")
  expect(request?.url).toBe("http://localhost:3000/api/service/stop")
  expect(await request?.json()).toEqual({ instanceID: "instance" })
})

test("MCP resource catalog uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({
        location: { directory: "/tmp/project", project: { id: "proj_test", directory: "/tmp/project" } },
        data: {
          resources: [{ server: "docs", name: "Readme", uri: "docs://readme" }],
          templates: [{ server: "docs", name: "File", uriTemplate: "docs://{path}" }],
        },
      })
    },
  })

  const result = await client.mcp.resource.catalog({ location: { directory: "/tmp/project" } })

  expect(result.data.resources[0]?.uri).toBe("docs://readme")
  expect(request?.method).toBe("GET")
  expect(request?.url).toBe("http://localhost:3000/api/mcp/resource?location%5Bdirectory%5D=%2Ftmp%2Fproject")
})

test("file.read returns binary content from the public HTTP contract", async () => {
  let request: Request | undefined
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      request = input instanceof Request ? input : new Request(input)
      return new Response(new Uint8Array([104, 105]))
    },
  })

  const content = await client.file.read({
    path: "src/a b#c.ts",
    location: { directory: "/tmp/project" },
  })

  expect(Array.from(content)).toEqual([104, 105])
  expect(request?.url).toBe(
    "http://localhost:3000/api/fs/read/src/a%20b%23c.ts?location%5Bdirectory%5D=%2Ftmp%2Fproject",
  )
})

test("project methods use the public HTTP contract", async () => {
  const requests: string[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push(url)
      if (url.includes("/directories")) return Response.json([])
      return Response.json({ id: "proj_test", directory: "/tmp/project" })
    },
  })

  const current = await client.project.current({ location: { workspace: "wrk_test" } })
  const directories = await client.project.directories({
    projectID: current.id,
    location: { directory: current.directory },
  })

  expect(current).toEqual({ id: "proj_test", directory: "/tmp/project" })
  expect(directories).toEqual([])
  expect(requests).toEqual([
    "http://localhost:3000/api/project/current?location%5Bworkspace%5D=wrk_test",
    "http://localhost:3000/api/project/proj_test/directories?location%5Bdirectory%5D=%2Ftmp%2Fproject",
  ])
})

test("shell list and remove use the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string }> = []
  const shell = {
    id: "sh_test",
    status: "running",
    command: "pwd",
    cwd: "/tmp/project",
    shell: "/bin/zsh",
    file: "/tmp/ycoding-shell",
    metadata: { sessionID: "ses_test" },
    time: { started: 1_717_171_717_000 },
  }
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({ method: request.method, url: request.url })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return Response.json({
        location: { directory: "/tmp/project", project: { id: "proj_test", directory: "/tmp/project" } },
        data: [shell],
      })
    },
  })

  const result = await client.shell.list({ location: { directory: "/tmp/project" } })
  await client.shell.remove({ id: shell.id })

  expect(result.data).toEqual([shell])
  expect(requests).toEqual([
    { method: "GET", url: "http://localhost:3000/api/shell?location%5Bdirectory%5D=%2Ftmp%2Fproject" },
    { method: "DELETE", url: "http://localhost:3000/api/shell/sh_test" },
  ])
})

test("session.get returns the wire projection", async () => {
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe(
        "http://localhost:3000/api/session/ses_test",
      )
      return Response.json(session)
    },
  })

  const result = await client.session.get({ sessionID: "ses_test" })

  expect(result.time.created).toBe(1_717_171_717_000)
})

test("project artifact list uses the public HTTP contract", async () => {
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe(
        "http://localhost:3000/api/artifact?location%5Bdirectory%5D=%2Ftmp%2Fproject&scope=project",
      )
      return Response.json({ data: [] })
    },
  })

  const result = await client.projectArtifact.artifact.list({
    location: { directory: "/tmp/project" },
    scope: "project",
  })

  expect(result).toEqual([])
})

test("session instructions methods use the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown }> = []
  const instructions = [{ key: "review-notes", value: { text: "Check the diff", priority: 1 } }]
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({
        method: request.method,
        url: request.url,
        body: request.method === "PUT" ? await request.json() : undefined,
      })
      if (request.method === "GET") return Response.json({ data: instructions })
      return new Response(null, { status: 204 })
    },
  })

  const result = await client.session.instructions.entry.list({ sessionID: "ses_test" })
  await client.session.instructions.entry.put({
    sessionID: "ses_test",
    key: "review-notes",
    value: instructions[0].value,
  })
  await client.session.instructions.entry.remove({ sessionID: "ses_test", key: "review-notes" })

  expect(result).toEqual(instructions)
  expect(requests).toEqual([
    {
      method: "GET",
      url: "http://localhost:3000/api/session/ses_test/instructions/entries",
      body: undefined,
    },
    {
      method: "PUT",
      url: "http://localhost:3000/api/session/ses_test/instructions/entries/review-notes",
      body: { value: { text: "Check the diff", priority: 1 } },
    },
    {
      method: "DELETE",
      url: "http://localhost:3000/api/session/ses_test/instructions/entries/review-notes",
      body: undefined,
    },
  ])
})

test("session.pending.list uses the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string }> = []
  const pending = [
    {
      admittedSeq: 3,
      id: "msg_pending",
      sessionID: "ses_test",
      timeCreated: 1_717_171_717_000,
      type: "user",
      data: { text: "Fix the failing tests" },
      delivery: "steer",
    },
  ]
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({ method: request.method, url: request.url })
      return Response.json({ data: pending })
    },
  })

  const result = await client.session.pending.list({ sessionID: "ses_test" })

  expect(result).toEqual(pending)
  expect(requests).toEqual([{ method: "GET", url: "http://localhost:3000/api/session/ses_test/pending" }])
})

test("session todo methods use the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown }> = []
  const todos = [{ content: "Run tests", status: "in_progress" as const, priority: "high" as const }]
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({
        method: request.method,
        url: request.url,
        body: request.method === "PUT" ? await request.json() : undefined,
      })
      return Response.json({ data: todos })
    },
  })

  expect(await client.session.todo.list({ sessionID: "ses_test" })).toEqual(todos)
  expect(await client.session.todo.update({ sessionID: "ses_test", todos })).toEqual(todos)
  expect(requests).toEqual([
    { method: "GET", url: "http://localhost:3000/api/session/ses_test/todo", body: undefined },
    { method: "PUT", url: "http://localhost:3000/api/session/ses_test/todo", body: { todos } },
  ])
})

test("event.subscribe exposes the Promise event stream wire projection", async () => {
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        `: heartbeat\n\ndata: ${JSON.stringify({ id: "evt_connected", created: 0, type: "server.connected", data: {}, sourceEpoch: "source_test" })}\n\n` +
          `data: ${JSON.stringify({ ...modelSwitchedEvent, sourceEpoch: "source_test" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const events = []
  for await (const event of client.event.subscribe()) events.push(event)

  expect(events).toEqual([
    { id: "evt_connected", created: 0, type: "server.connected", data: {}, sourceEpoch: "source_test" },
    { ...modelSwitchedEvent, sourceEpoch: "source_test" },
  ])
  expect(events[1]?.type === "session.model.selected" && events[1].created).toBe(1_717_171_717_000)
})

test("event.subscribe terminates on malformed Promise SSE data", async () => {
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async () => new Response("data: {not-json}\n\n", { headers: { "content-type": "text/event-stream" } }),
  })

  await expect(client.event.subscribe()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ClientError",
    reason: "MalformedResponse",
  })
})

test("event.subscribe accepts a fragmented SSE event below the size limit", async () => {
  const event = { id: "evt_large", type: "test.large", data: { output: "x".repeat(12 * 1024 * 1024) } }
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < encoded.length; offset += 64 * 1024) {
              controller.enqueue(encoded.slice(offset, offset + 64 * 1024))
            }
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })

  await expect(client.event.subscribe()[Symbol.asyncIterator]().next()).resolves.toEqual({ done: false, value: event })
})

test("event.subscribe rejects an SSE event above the size limit", async () => {
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(`data: ${JSON.stringify({ output: "x".repeat(16 * 1024 * 1024) })}`, {
        headers: { "content-type": "text/event-stream" },
      }),
  })

  await expect(client.event.subscribe()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ClientError",
    reason: "SseEventTooLarge",
  })
})

test("session methods use the public HTTP contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.includes("/event")) {
        return new Response(`data: ${JSON.stringify(modelSwitchedEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.includes("/log")) {
        return new Response(
          `data: ${JSON.stringify({ ...modelSwitchedEvent, sourceEpoch: "source_test" })}\n\ndata: ${JSON.stringify({ ...synced, sourceEpoch: "source_test" })}\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      }
      if (url.includes("/prompt")) return Response.json(admission)
      if (url.includes("/generate")) return Response.json({ data: { text: "A transient answer" } })
      if (url.includes("/synthetic")) return Response.json(syntheticAdmission)
      if (url.endsWith("/compact")) return Response.json(compactionAdmission)
      if (url.includes("/context")) return Response.json({ data: [] })
      if (url.includes("/message/")) return Response.json({ data: modelSwitchedMessage })
      if (url.endsWith("/api/session/active")) return Response.json({ data: { ses_test: { type: "running" } } })
      if (init?.method === "POST" && url.endsWith("/api/session")) return Response.json(session)
      if (init?.method === "POST") return new Response(null, { status: 204 })
      return Response.json({ data: [session.data], cursor: { next: "next" } })
    },
  })

  const page = await client.session.list({ limit: 10, order: "desc", parentID: null })
  const active = await client.session.active()
  const created = await client.session.create({ location: { directory: "/tmp/project" } })
  await client.session.switchAgent({ sessionID: "ses_test", agent: "build" })
  await client.session.switchModel({
    sessionID: "ses_test",
    model: { id: "claude", providerID: "anthropic" },
  })
  const admitted = await client.session.prompt({
    sessionID: "ses_test",
    text: "Hello",
    resume: false,
  })
  const generated = await client.session.generate({ sessionID: "ses_test", prompt: "Summarize this session" })
  const synthetic = await client.session.synthetic({
    sessionID: "ses_test",
    text: "Completed",
    delivery: "queue",
    resume: false,
  })
  const compactionID = SessionCompaction.ID.make("cmp_compaction_request")
  const compacted = await client.session.compact({ sessionID: "ses_test", id: compactionID })
  await client.session.wait({ sessionID: "ses_test" })
  const context = await client.session.context({ sessionID: "ses_test" })
  const log = []
  for await (const item of client.session.log({ sessionID: "ses_test", after: 0 })) log.push(item)
  await client.session.interrupt({ sessionID: "ses_test" })
  const message = await client.session.message({ sessionID: "ses_test", messageID: "msg_model" })

  expect(page.cursor.next).toBe("next")
  expect(active).toEqual({ ses_test: { type: "running" } })
  expect(created.id).toBe("ses_test")
  expect(admitted.id).toBe("msg_test")
  expect(generated.text).toBe("A transient answer")
  expect(synthetic).toMatchObject({ type: "synthetic", data: { text: "Completed" }, delivery: "queue" })
  expect(compacted).toMatchObject({
    id: expect.stringMatching(/^cmp_/),
    sessionID: "ses_test",
    trigger: "manual",
    status: "ended",
  })
  expect(compacted).not.toHaveProperty("summary")
  expect(compacted).not.toHaveProperty("type")
  expect(context).toEqual([])
  expect(log).toEqual([
    { ...modelSwitchedEvent, sourceEpoch: "source_test" },
    { ...synced, sourceEpoch: "source_test" },
  ])
  expect(message).toEqual(modelSwitchedMessage)
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["GET", "http://localhost:3000/api/session?limit=10&order=desc&parentID=null"],
    ["GET", "http://localhost:3000/api/session/active"],
    ["POST", "http://localhost:3000/api/session"],
    ["POST", "http://localhost:3000/api/session/ses_test/agent"],
    ["POST", "http://localhost:3000/api/session/ses_test/model"],
    ["POST", "http://localhost:3000/api/session/ses_test/prompt"],
    ["POST", "http://localhost:3000/api/session/ses_test/generate"],
    ["POST", "http://localhost:3000/api/session/ses_test/synthetic"],
    ["POST", "http://localhost:3000/api/session/ses_test/compact"],
    ["POST", "http://localhost:3000/api/session/ses_test/wait"],
    ["GET", "http://localhost:3000/api/session/ses_test/context"],
    ["GET", "http://localhost:3000/api/experimental/session/ses_test/log?after=0"],
    ["POST", "http://localhost:3000/api/session/ses_test/interrupt"],
    ["GET", "http://localhost:3000/api/session/ses_test/message/msg_model"],
  ])
  const body = requests.find((request) => request.url.endsWith("/api/session/ses_test/prompt"))?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({
    text: "Hello",
    resume: false,
  })
  const syntheticBody = requests.find((request) => request.url.endsWith("/synthetic"))?.init?.body
  if (typeof syntheticBody !== "string") throw new Error("Expected JSON synthetic request body")
  expect(JSON.parse(syntheticBody)).toEqual({
    text: "Completed",
    delivery: "queue",
    resume: false,
  })
  const compactBody = requests.find((request) => request.url.endsWith("/compact"))?.init?.body
  if (typeof compactBody !== "string") throw new Error("Expected JSON compaction request body")
  expect(JSON.parse(compactBody)).toEqual({ id: compactionID })
})

test("middleware errors remain declared client errors", async () => {
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 }),
  })

  try {
    await client.session.create({})
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isUnauthorizedError(error)).toBe(true)
  }
})

test("session.log decodes SessionNotFoundError", async () => {
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json(
        { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" },
        { status: 404 },
      ),
  })

  try {
    await client.session.log({ sessionID: "ses_missing" })[Symbol.asyncIterator]().next()
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isSessionNotFoundError(error)).toBe(true)
  }
})

const session = {
  data: {
    id: "ses_test",
    projectID: "project",
    cost: 0,
    tokens: {
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    },
    time: {
      created: 1_717_171_717_000,
      updated: 1_717_171_717_000,
    },
    title: "Test",
    location: { directory: "/tmp/project" },
  },
}

const admission = {
  data: {
    admittedSeq: 0,
    id: "msg_test",
    sessionID: "ses_test",
    type: "user",
    data: { text: "Hello" },
    delivery: "steer",
    timeCreated: 1_717_171_717_000,
  },
}

const syntheticAdmission = {
  data: {
    admittedSeq: 1,
    id: "msg_synthetic",
    sessionID: "ses_test",
    type: "synthetic",
    data: { text: "Completed" },
    delivery: "queue",
    timeCreated: 1_717_171_717_000,
  },
}

const compactionAdmission = {
  data: {
    id: "cmp_compaction",
    sessionID: "ses_test",
    trigger: "manual",
    status: "ended",
    requestedThrough: { messageID: "msg_compaction_request", seq: 1 },
    timeCreated: 1_717_171_717_000,
  },
}

const modelSwitchedMessage = {
  id: "msg_model",
  type: "model-switched",
  time: { created: 1_717_171_717_000 },
  model: { id: "claude", providerID: "anthropic" },
}

const synced = { type: "log.synced", aggregateID: "ses_test", seq: 1 }

const modelSwitchedEvent = {
  id: "evt_model",
  created: 1_717_171_717_000,
  type: "session.model.selected",
  durable: { aggregateID: "ses_test", seq: 1, version: 1 },
  data: {
    sessionID: "ses_test",
    model: { id: "claude", providerID: "anthropic" },
  },
}
