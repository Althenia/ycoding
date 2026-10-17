import { afterEach, describe, expect, test } from "bun:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TaskMCPAuth } from "../src/task-mcp/auth"
import { TaskMCPTasks } from "../src/task-mcp/tasks"
import { TaskMCPTransport } from "../src/task-mcp/transport"

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
const localOrigin = "http://127.0.0.1:4096"
const config = {
  issuer: "https://identity.example.com",
  jwksURL: "https://identity.example.com/keys",
  resource: "https://ycoding.example.com/mcp",
  subject: "owner-123",
}

function taskID(result: { structuredContent?: unknown }) {
  const content = result.structuredContent
  if (typeof content !== "object" || content === null || !("taskId" in content) || typeof content.taskId !== "string")
    throw new Error("Expected a task ID in the tool result")
  return content.taskId
}
const resources: Array<{
  directory: string
  tasks: TaskMCPTasks.Interface
  handler: ReturnType<typeof TaskMCPTransport.create>
  clients: Client[]
}> = []

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await Promise.all(resource.clients.map((client) => client.close()))
    await resource.tasks.settleAdmissions()
    await resource.handler.close()
    await rm(resource.directory, { recursive: true, force: true })
  }
})

async function fixture(resource = config.resource) {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-mcp-transport-"))
  const state = {
    keyFetches: 0,
    starts: 0,
    cancelled: false,
    fail: false,
    interactionReads: 0,
    truncated: false,
    pending: [] as TaskMCPTasks.Interaction[],
    replies: [] as Array<{ sessionID: string; workspace: string; input: TaskMCPTasks.InteractionReply }>,
  }
  const tasks = await TaskMCPTasks.open({
    directory,
    workspaceRoot: path.join(directory, "workspaces"),
    identity: "transport-test",
    backend: {
      prepare: async () => undefined,
      start: async () => {
        state.starts += 1
      },
      inspect: async () => {
        if (state.fail) throw new Error("private upstream credential must not escape")
        return { state: state.cancelled ? "interrupted" : "running", text: "Visible assistant output", truncated: true }
      },
      cancel: async () => {
        state.cancelled = true
      },
      interactions: async () => {
        state.interactionReads += 1
        if (state.fail) throw new Error("private upstream credential must not escape")
        return { items: state.pending, truncated: state.truncated }
      },
      respond: async (sessionID, workspace, input) => {
        if (state.fail) throw new Error("private upstream credential must not escape")
        state.replies.push({ sessionID, workspace, input })
      },
    },
  })
  const auth = TaskMCPAuth.create(
    { ...config, resource },
    {
      fetch: async () => {
        state.keyFetches += 1
        return Response.json({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "owner" }] })
      },
    },
  )
  const handler = TaskMCPTransport.create({ tasks, resource, localOrigin, auth })
  const clients: Client[] = []
  resources.push({ directory, tasks, handler, clients })
  const token = (scope = "ycoding:tasks") => {
    const input = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "owner" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ iss: config.issuer, aud: resource, sub: config.subject, exp: Date.now() / 1000 + 600, scope }),
      ).toString("base64url"),
    ].join(".")
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`
  }
  const post = (
    body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    headers: Record<string, string> = {},
  ) =>
    new Request(`${localOrigin}${new URL(resource).pathname}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token()}`,
        ...headers,
      },
      body,
    })
  const connect = async (era: "legacy" | "modern") => {
    const seen: string[] = []
    const client = new Client(
      { name: "ycoding-test", version: "1.0.0" },
      {
        versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } },
      },
    )
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${localOrigin}${new URL(resource).pathname}`), {
        requestInit: { headers: { authorization: `Bearer ${token()}` } },
        fetch: async (url, init) => {
          const request = new Request(url instanceof URL ? url.href : url, init)
          if (request.method === "POST") {
            const body: unknown = await request.clone().json()
            if (typeof body === "object" && body !== null && "method" in body && typeof body.method === "string")
              seen.push(body.method)
          }
          return handler.fetch(request)
        },
      }),
    )
    return { client, seen }
  }
  const pending = (sessionID: string, input: Partial<TaskMCPTasks.Interaction> = {}) => {
    const item: TaskMCPTasks.Interaction = {
      interactionId: "permission:one",
      sessionID,
      kind: "permission",
      revision: "a".repeat(64),
      details: { permission: "write", targets: ["src/example.ts"] },
      allowedResponses: ["once", "reject"],
      actionable: true,
      ...input,
    }
    state.pending.push(item)
    return item
  }
  return { handler, auth, tasks, state, token, post, connect, pending }
}

describe("task MCP HTTP boundary", () => {
  test("serves protected-resource metadata without authentication", async () => {
    const { handler, auth, state } = await fixture()
    const response = await handler.fetch(new Request(`${localOrigin}${auth.metadataPath}`))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ resource: config.resource, authorization_servers: [config.issuer] })
    expect(state.keyFetches).toBe(0)
  })

  test("uses the RFC protected-resource metadata path for a root MCP endpoint", async () => {
    const { handler, auth } = await fixture("https://ycoding.example.com/")
    const response = await handler.fetch(new Request(`${localOrigin}${auth.metadataPath}`))
    expect(response.status).toBe(200)
  })

  test.each(["", "Bearer wrong-token"])(
    "rejects missing or invalid authorization before tools run",
    async (authorization) => {
      const { handler, post, state } = await fixture()
      const response = await handler.fetch(post(undefined, { authorization }))
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toContain('scope="ycoding:tasks"')
      expect(state.starts).toBe(0)
      expect(state.keyFetches).toBe(0)
    },
  )

  test("rejects a valid token without the task scope", async () => {
    const { handler, post, token, state } = await fixture()
    const response = await handler.fetch(post(undefined, { authorization: `Bearer ${token("profile")}` }))
    expect(response.status).toBe(403)
    expect(state.starts).toBe(0)
  })

  test.each(["https://attacker.example.com", "null", "http://127.0.0.1:4096"])(
    "rejects unapproved browser Origin: %s",
    async (origin) => {
      const { handler, post, state } = await fixture()
      expect((await handler.fetch(post(undefined, { origin }))).status).toBe(403)
      expect(state.keyFetches).toBe(0)
    },
  )

  test("permits the configured public Origin and rejects an unexpected request host", async () => {
    const { handler, post } = await fixture()
    expect((await handler.fetch(post(undefined, { origin: "https://ycoding.example.com" }))).status).toBe(200)
    const input = post()
    expect((await handler.fetch(new Request("http://attacker.example.com/mcp", input))).status).toBe(403)
  })

  test("accepts the public Host on an authenticated HTTP proxy hop without weakening Origin checks", async () => {
    const { handler, post } = await fixture()
    const forwarded = (headers: Record<string, string> = {}) =>
      new Request("http://ycoding.example.com/mcp", post(undefined, headers))
    expect((await handler.fetch(forwarded({ origin: "https://ycoding.example.com" }))).status).toBe(200)
    expect((await handler.fetch(forwarded({ authorization: "" }))).status).toBe(401)
    expect((await handler.fetch(forwarded({ origin: "http://ycoding.example.com" }))).status).toBe(403)
    expect((await handler.fetch(new Request("http://attacker.example.com/mcp", post()))).status).toBe(403)
  })

  test("does not expose unrelated runtime routes or accept URL credentials", async () => {
    const { handler, token } = await fixture()
    for (const route of ["/session", "/mcp?access_token=secret", "/.well-known/oauth-authorization-server"]) {
      expect(
        (
          await handler.fetch(
            new Request(`${localOrigin}${route}`, { headers: { authorization: `Bearer ${token()}` } }),
          )
        ).status,
      ).toBe(404)
    }
  })

  test.each(["GET", "DELETE", "PUT"])("rejects unsupported authenticated method %s", async (method) => {
    const { handler, token } = await fixture()
    const response = await handler.fetch(
      new Request(`${localOrigin}/mcp`, { method, headers: { authorization: `Bearer ${token()}` } }),
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
  })

  test("bounds request bytes, including streamed bodies without Content-Length", async () => {
    const { handler, post, token, state } = await fixture()
    expect((await handler.fetch(post(" ".repeat(128 * 1024 + 1)))).status).toBe(413)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_536))
        controller.enqueue(new Uint8Array(65_537))
        controller.close()
      },
    })
    const response = await handler.fetch(
      new Request(`${localOrigin}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
        body: stream,
      }),
    )
    expect(response.status).toBe(413)
    expect(state.starts).toBe(0)
  })

  test("rejects invalid JSON and media types through the SDK", async () => {
    const { handler, post } = await fixture()
    expect((await handler.fetch(post("{"))).status).toBe(400)
    expect((await handler.fetch(post(undefined, { "content-type": "text/plain" }))).status).toBe(415)
  })

  test("rejects modern request header/body mismatches before tool dispatch", async () => {
    const { handler, post, state } = await fixture()
    const response = await handler.fetch(
      post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "start_task",
            arguments: { requestId: "forged", prompt: "Do not run" },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "get_status" },
      ),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: -32020 } })
    expect(state.starts).toBe(0)
  })

  test.each(["legacy", "modern"] as const)(
    "supports SDK discovery and tool lifecycle in %s protocol mode",
    async (era) => {
      const { connect, tasks, state, pending } = await fixture()
      const { client, seen } = await connect(era)
      expect(seen).toContain(era === "legacy" ? "initialize" : "server/discover")
      const catalog = await client.listTools()
      expect(catalog.tools.map((tool) => tool.name)).toEqual([
        "list_tasks",
        "start_task",
        "get_status",
        "get_result",
        "cancel_task",
        "list_interactions",
        "respond_interaction",
      ])
      expect(catalog.tools.find((tool) => tool.name === "get_result")?.annotations?.readOnlyHint).toBe(true)
      expect(catalog.tools.find((tool) => tool.name === "list_interactions")?.annotations?.readOnlyHint).toBe(true)
      expect(catalog.tools.find((tool) => tool.name === "respond_interaction")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      })
      const started = await client.callTool({
        name: "start_task",
        arguments: { requestId: "task-one", prompt: "Fix the tests" },
      })
      expect(started.isError).not.toBe(true)
      const taskId = taskID(started)
      expect(typeof taskId).toBe("string")
      await tasks.settleAdmissions()
      const status = await client.callTool({ name: "get_status", arguments: { taskId } })
      expect(status.structuredContent).toMatchObject({ taskId, state: "running" })
      const result = await client.callTool({ name: "get_result", arguments: { taskId } })
      expect(result.structuredContent).toMatchObject({ text: "Visible assistant output", truncated: true })
      const listed = await client.callTool({ name: "list_tasks", arguments: { limit: 1 } })
      expect(listed.structuredContent).toMatchObject({ tasks: [{ taskId }] })
      const item = pending(taskId)
      const interactions = await client.callTool({ name: "list_interactions", arguments: { taskId } })
      expect(interactions.structuredContent).toEqual({ items: [item], truncated: false })
      expect(state.replies).toHaveLength(0)
      const decision = {
        taskId,
        interactionId: item.interactionId,
        revision: item.revision,
        response: { action: "once" },
      }
      expect((await client.callTool({ name: "respond_interaction", arguments: decision })).structuredContent).toEqual({
        taskId,
        interactionId: item.interactionId,
        submitted: true,
      })
      expect(state.replies).toHaveLength(1)
      expect(state.replies[0]).toMatchObject({ sessionID: taskId, input: { response: { action: "once" } } })
      expect((await client.callTool({ name: "respond_interaction", arguments: decision })).isError).toBe(true)
      expect(state.replies).toHaveLength(1)
      expect((await client.callTool({ name: "cancel_task", arguments: { taskId } })).structuredContent).toMatchObject({
        state: "cancelled",
      })
      expect(state.starts).toBe(1)
    },
  )

  test("rejects unknown tools and extraneous arguments without executing a task", async () => {
    const { connect, state } = await fixture()
    const { client } = await connect("modern")
    expect((await client.callTool({ name: "unknown", arguments: {} })).isError).toBe(true)
    const result = await client.callTool({
      name: "start_task",
      arguments: { requestId: "new", prompt: "Task", directory: "/etc" },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "Invalid tool arguments" }])
    expect(state.starts).toBe(0)
  })

  test.each([
    undefined,
    {},
    { action: "always" },
    { action: "once", persistent: true },
    { action: "form" },
    { action: "question", answers: "Approve" },
    { action: "form", answer: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [String(index), "x"])) },
    { action: "form", answer: { ["x".repeat(129)]: "x" } },
    { action: "form", answer: { text: "x".repeat(8193) } },
    { action: "form", answer: { choices: Array.from({ length: 33 }, () => "x") } },
    { action: "question", answers: Array.from({ length: 33 }, () => ["x"]) },
    { action: "question", answers: [Array.from({ length: 33 }, () => "x")] },
    { action: "question", answers: [["x".repeat(8193)]] },
    { action: "question", answers: [Array.from({ length: 9 }, () => "x".repeat(8192))] },
    { action: "form", answer: { first: "界".repeat(8192), second: "界".repeat(8192), third: "界".repeat(8192) } },
  ])("rejects missing or invalid interaction decisions without a default approval", async (response) => {
    const { connect, state } = await fixture()
    const { client } = await connect("modern")
    const result = await client.callTool({
      name: "respond_interaction",
      arguments: { taskId: "owned-task", interactionId: "pending-one", revision: "a".repeat(64), response },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "Invalid tool arguments" }])
    expect(state.interactionReads).toBe(0)
    expect(state.replies).toHaveLength(0)
  })

  test.each([
    { interactionId: "" },
    { interactionId: "x".repeat(257) },
    { revision: "" },
    { revision: "a".repeat(63) },
    { revision: "g".repeat(64) },
    { revision: undefined },
    { directory: "/another/workspace" },
    { sessionID: "another-session" },
  ])("rejects malformed interaction references and caller-supplied routing fields", async (overrides) => {
    const { connect, state } = await fixture()
    const { client } = await connect("modern")
    const result = await client.callTool({
      name: "respond_interaction",
      arguments: {
        taskId: "owned-task",
        interactionId: "permission:one",
        revision: "a".repeat(64),
        response: { action: "once" },
        ...overrides,
      },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "Invalid tool arguments" }])
    expect(state.interactionReads).toBe(0)
    expect(state.replies).toHaveLength(0)
  })

  test("rejects extra list-interaction arguments instead of expanding its task scope", async () => {
    const { connect, state } = await fixture()
    const { client } = await connect("modern")
    const result = await client.callTool({
      name: "list_interactions",
      arguments: { taskId: "owned-task", sessionID: "another-session" },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "Invalid tool arguments" }])
    expect(state.interactionReads).toBe(0)
  })

  test("accepts the Core interaction ID boundary of 256 characters", async () => {
    const { connect, tasks, state, pending } = await fixture()
    const { client } = await connect("modern")
    const task = await tasks.start({ requestId: "long-interaction", prompt: "Task" })
    await tasks.settleAdmissions()
    const item = pending(task.taskId, { interactionId: "x".repeat(256) })
    const result = await client.callTool({
      name: "respond_interaction",
      arguments: {
        taskId: task.taskId,
        interactionId: item.interactionId,
        revision: item.revision,
        response: { action: "once" },
      },
    })
    expect(result.isError).not.toBe(true)
    expect(state.replies).toHaveLength(1)
  })

  test.each([
    { action: "form", answer: { title: "Selected answer", count: 2, accepted: false, labels: ["one", "two"] } },
    { action: "question", answers: [["First option"], ["Second option", "Third option"]] },
    { action: "reject" },
    { action: "cancel" },
  ] satisfies TaskMCPTasks.InteractionResponse[])(
    "forwards only the explicit typed interaction response",
    async (response) => {
      const { connect, tasks, state, pending } = await fixture()
      const { client } = await connect("modern")
      const task = await tasks.start({ requestId: "interaction", prompt: "Task" })
      await tasks.settleAdmissions()
      const item = pending(task.taskId, {
        kind: response.action === "form" ? "form" : response.action === "question" ? "question" : "permission",
        allowedResponses: [response.action],
      })
      const input = { interactionId: item.interactionId, revision: item.revision, response }
      const result = await client.callTool({
        name: "respond_interaction",
        arguments: { taskId: task.taskId, ...input },
      })
      expect(result.isError).not.toBe(true)
      expect(state.replies).toEqual([{ sessionID: task.taskId, workspace: task.workspace, input }])
    },
  )

  test("keeps interaction reads and replies within an owned task", async () => {
    const { connect, tasks, state, pending } = await fixture()
    const { client } = await connect("modern")
    const task = await tasks.start({ requestId: "interaction", prompt: "Task" })
    await tasks.settleAdmissions()
    const item = pending(task.taskId)
    const input = { interactionId: item.interactionId, revision: item.revision, response: { action: "once" } }
    for (const name of ["list_interactions", "respond_interaction"]) {
      const result = await client.callTool({
        name,
        arguments: name === "list_interactions" ? { taskId: "foreign-task" } : { taskId: "foreign-task", ...input },
      })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: "text", text: "Unknown task" }])
    }
    expect(state.interactionReads).toBe(0)
    item.sessionID = "another-session"
    const result = await client.callTool({ name: "respond_interaction", arguments: { taskId: task.taskId, ...input } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "Interaction is stale or unavailable" }])
    expect(state.replies).toHaveLength(0)
  })

  test("rejects stale interaction IDs and revisions without submitting a response", async () => {
    const { connect, tasks, state, pending } = await fixture()
    const { client } = await connect("modern")
    const task = await tasks.start({ requestId: "interaction", prompt: "Task" })
    await tasks.settleAdmissions()
    const item = pending(task.taskId)
    for (const reference of [
      { interactionId: "missing", revision: item.revision },
      { interactionId: item.interactionId, revision: "b".repeat(64) },
    ]) {
      const result = await client.callTool({
        name: "respond_interaction",
        arguments: { taskId: task.taskId, ...reference, response: { action: "once" } },
      })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: "text", text: "Interaction is stale or unavailable" }])
    }
    expect(state.replies).toHaveLength(0)
  })

  test("preserves local-attention and truncation notices without allowing a reply", async () => {
    const { connect, tasks, state, pending } = await fixture()
    const { client } = await connect("modern")
    const task = await tasks.start({ requestId: "interaction", prompt: "Task" })
    await tasks.settleAdmissions()
    const item = pending(task.taskId, { actionable: false, allowedResponses: [], reason: "Resolve locally" })
    state.truncated = true
    const listed = await client.callTool({ name: "list_interactions", arguments: { taskId: task.taskId } })
    expect(listed.structuredContent).toEqual({ items: [item], truncated: true })
    const result = await client.callTool({
      name: "respond_interaction",
      arguments: {
        taskId: task.taskId,
        interactionId: item.interactionId,
        revision: item.revision,
        response: { action: "once" },
      },
    })
    expect(result.isError).toBe(true)
    expect(state.replies).toHaveLength(0)
  })

  test.each(["list_interactions", "respond_interaction"])("requires OAuth before %s dispatch", async (name) => {
    const { handler, post, state } = await fixture()
    const response = await handler.fetch(
      post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { taskId: "foreign-task" } },
        }),
        { authorization: "" },
      ),
    )
    expect(response.status).toBe(401)
    expect(state.interactionReads).toBe(0)
    expect(state.replies).toHaveLength(0)
  })

  test("sanitizes unexpected backend errors", async () => {
    const { connect, tasks, state } = await fixture()
    const { client } = await connect("modern")
    const started = await client.callTool({ name: "start_task", arguments: { requestId: "new", prompt: "Task" } })
    await tasks.settleAdmissions()
    state.fail = true
    const result = await client.callTool({
      name: "get_result",
      arguments: { taskId: taskID(started) },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain("credential")
    expect(result.content).toEqual([
      { type: "text", text: "Task operation failed. Inspect the local YCoding Session before retrying." },
    ])
  })
})
