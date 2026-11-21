import { expect, test } from "bun:test"
import { ensure, stop } from "@ycoding-ai/client/service"
import { YCoding } from "@ycoding-ai/client/v5"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"
import { TaskMCPAuth } from "../src/task-mcp/auth"
import { TaskMCPTasks } from "../src/task-mcp/tasks"
import { TaskMCPTransport } from "../src/task-mcp/transport"
import { makeTaskMcpBackend } from "../src/task-mcp-backend"

const resource = "https://tasks.example.test/mcp"
const issuer = "https://identity.example.test"

test("task MCP tools start a worktree task on the Rust runtime and reject only the selected permission", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ycoding-task-mcp-")))
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    YCODING_CONFIG_DIR: path.join(root, "config/ycoding"),
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_CONFIG_PROJECT_DISABLE: "1",
    YCODING_RUNTIME_EXECUTABLE: path.resolve(
      import.meta.dirname,
      "../../../rust/target/debug",
      process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime",
    ),
  }
  await mkdir(environment.YCODING_CONFIG_DIR, { recursive: true })
  await writeFile(
    path.join(environment.YCODING_CONFIG_DIR, "ycoding.json"),
    JSON.stringify({ permissions: [{ action: "task_mcp_probe", resource: "*", effect: "ask" }] }),
  )
  const repository = path.join(root, "repository")
  await mkdir(repository)
  for (const command of [
    ["init", "-q", "-b", "main"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "fixture",
    ],
  ])
    expect(Bun.spawnSync(["git", ...command], { cwd: repository }).exitCode).toBe(0)
  const cli = path.resolve(import.meta.dirname, "../src/index.ts")
  const options = {
    file: path.join(root, "state/ycoding", ServiceConfig.filename("local")),
    command: [
      process.execPath,
      "-e",
      `Object.assign(process.env, ${JSON.stringify(environment)}); process.argv = [process.execPath, ${JSON.stringify(cli)}, "serve", "--service", "--port", "0"]; await import(${JSON.stringify(cli)});`,
    ],
    version: "local",
    startupErrorFile: path.join(root, "startup-error"),
  }
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const token = () => {
    const input = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "owner" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          iss: issuer,
          aud: resource,
          sub: "owner",
          exp: Date.now() / 1000 + 600,
          scope: "ycoding:tasks",
        }),
      ).toString("base64url"),
    ].join(".")
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`
  }
  const endpoint = await ensure(options)
  const client = YCoding.make({ endpoint })
  try {
    const tasks = await TaskMCPTasks.open({
      directory: path.join(root, "registry"),
      workspaceRoot: path.join(root, "worktrees"),
      identity: "integration",
      backend: makeTaskMcpBackend(client, repository),
    })
    const transport = TaskMCPTransport.create({
      tasks,
      resource,
      localOrigin: "http://127.0.0.1:4097",
      auth: TaskMCPAuth.create(
        { issuer, jwksURL: `${issuer}/keys`, resource, subject: "owner" },
        { fetch: async () => Response.json({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "owner" }] }) },
      ),
    })
    const call = async (name: string, input: object) => {
      const response = await transport.fetch(
        new Request("http://127.0.0.1:4097/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token()}`,
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": name,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name,
              arguments: input,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "integration", version: "1" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        result: { isError?: boolean; structuredContent?: unknown; content: unknown }
      }
      expect(body.result.isError, JSON.stringify(body.result.content)).toBeUndefined()
      return body.result.structuredContent as { [key: string]: unknown }
    }

    const started = await call("start_task", { requestId: "integration", prompt: "Report the repository status" })
    await tasks.settleAdmissions()
    const taskId = String(started.taskId)
    const workspace = path.join(await realpath(path.join(root, "worktrees")), taskId)
    expect(started.workspace).toBe(workspace)
    expect((await stat(path.join(workspace, ".git"))).isFile()).toBe(true)
    const session = await client.session.get({ sessionID: taskId })
    expect(await realpath(session.location.directory)).toBe(workspace)

    const asked = await Promise.all(
      ["first", "second"].map((target) =>
        client.permission.create(
          { sessionID: taskId, action: "task_mcp_probe", resources: [target] },
          { headers: { "x-ycoding-directory": encodeURIComponent(workspace) } },
        ),
      ),
    )
    expect(asked.map((item) => item.effect)).toEqual(["ask", "ask"])
    const listed = (await call("list_interactions", { taskId })) as {
      items: { interactionId: string; revision: string; kind: string; actionable: boolean }[]
    }
    const permissions = listed.items.filter((item) => item.kind === "permission")
    expect(permissions.map((item) => item.interactionId).sort()).toEqual(
      asked.map((item) => `permission:${item.id}`).sort(),
    )
    const rejected = permissions.find((item) => item.interactionId === `permission:${asked[0]!.id}`)!
    expect(
      await call("respond_interaction", {
        taskId,
        interactionId: rejected.interactionId,
        revision: rejected.revision,
        response: { action: "reject" },
      }),
    ).toEqual({
      taskId,
      interactionId: rejected.interactionId,
      submitted: true,
    })
    expect(
      (
        await client.permission.list(
          { sessionID: taskId },
          { headers: { "x-ycoding-directory": encodeURIComponent(workspace) } },
        )
      ).map((item) => item.id),
    ).toEqual([asked[1]!.id])
    await client.permission.reply(
      { sessionID: taskId, requestID: asked[1]!.id, reply: "reject" },
      { headers: { "x-ycoding-directory": encodeURIComponent(workspace) } },
    )
    expect(await call("get_status", { taskId })).toMatchObject({ taskId, workspace })
  } finally {
    client.transport.close()
    await stop({ file: options.file })
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
