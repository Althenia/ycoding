import { Effect, Option } from "effect"
import { YCoding } from "@ycoding-ai/client"
import { Service } from "@ycoding-ai/client/effect/service"
import { Global } from "@ycoding-ai/core/global"
import { ProcessLock } from "@ycoding-ai/core/util/process-lock"
import { TaskMCPAuth } from "@ycoding-ai/core/task-mcp/auth"
import { TaskMCPTasks } from "@ycoding-ai/core/task-mcp/tasks"
import { TaskMCPTransport } from "@ycoding-ai/core/task-mcp/transport"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { serveTaskMcp } from "../../../task-mcp-http"
import { makeTaskMcpBackend } from "../../../task-mcp-backend"
import { parseSessionTargetModel } from "../../../session-target"

export default Runtime.handler(
  Commands.commands.mcp.commands.serve,
  Effect.fn("cli.mcp.serve")(function* (input) {
    if (input.port < 1 || input.port > 65535) return yield* Effect.fail(new Error("Invalid MCP port"))
    const auth = yield* Effect.try(() =>
      TaskMCPAuth.create({
        issuer: input.issuer,
        jwksURL: input.jwksUrl,
        resource: input.resource,
        subject: input.subject,
      }),
    )
    if (new URL(input.resource).pathname !== "/mcp")
      return yield* Effect.fail(new Error("MCP resource URL must end in /mcp"))
    const directory = yield* Effect.tryPromise(() => realpath(input.directory))
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const model = yield* Effect.try(() => parseSessionTargetModel(Option.getOrUndefined(input.model)))
    const agent = Option.getOrUndefined(input.agent)
    const identity = createHash("sha256")
      .update(
        JSON.stringify({
          directory,
          issuer: input.issuer,
          subject: input.subject,
          resource: input.resource,
          agent,
          model,
        }),
      )
      .digest("hex")
    const global = yield* Global.Service
    const registry = path.join(global.state, "task-mcp", identity)
    yield* ProcessLock.acquire(`${registry}.lock`)
    const serviceOptions = yield* ServiceConfig.options()
    const endpoint = yield* Service.ensure(serviceOptions)
    const client = YCoding.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    })
    const tasks = yield* Effect.tryPromise(() =>
      TaskMCPTasks.open({
        directory: registry,
        workspaceRoot,
        identity,
        maxConcurrent: input.maxConcurrent,
        backend: makeTaskMcpBackend(client, directory, agent, model),
      }),
    )
    const transport = TaskMCPTransport.create({
      tasks,
      auth,
      resource: input.resource,
      localOrigin: `http://127.0.0.1:${input.port}`,
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await tasks.settleAdmissions()
        await transport.close()
      }),
    )
    yield* serveTaskMcp(input.port, (request) => transport.fetch(request))
    process.stdout.write(`YCoding task MCP listening on 127.0.0.1:${input.port}/mcp\n`)
    yield* Effect.never
  }),
)
