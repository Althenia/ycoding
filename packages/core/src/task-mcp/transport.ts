export * as TaskMCPTransport from "./transport"

import { createMcpHandler, Server, type Tool } from "@modelcontextprotocol/server"
import { z } from "zod"
import { TaskMCPTasks } from "./tasks"

const identifier = z.string().min(1).max(128)
const schemas = {
  list_tasks: z.object({ cursor: identifier.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  start_task: z
    .object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), prompt: z.string().min(1).max(65536) })
    .strict(),
  get_status: z.object({ taskId: identifier }).strict(),
  get_result: z.object({ taskId: identifier }).strict(),
  cancel_task: z.object({ taskId: identifier }).strict(),
}
const descriptions = {
  list_tasks: "List only tasks created through this gateway, with bounded pagination.",
  start_task:
    "Start a coding task in a separate Git worktree and durable Session. Reuse requestId only for an identical retry. Local permissions and human reviews still apply.",
  get_status: "Get task execution status. Waiting or cancelling may require attention in the local YCoding interface.",
  get_result:
    "Get task status and a bounded latest assistant-text excerpt. Partial results are explicitly marked; tool logs and reasoning are excluded.",
  cancel_task:
    "Request cancellation of this task's active Session. Preserves the worktree and history. Cancelling is not terminal and may require local attention for retained queued input.",
}
export const tools: Tool[] = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  inputSchema: z.toJSONSchema(schema) as Tool["inputSchema"],
  annotations: {
    readOnlyHint: name !== "start_task" && name !== "cancel_task",
    destructiveHint: name === "start_task" || name === "cancel_task",
    idempotentHint: true,
    openWorldHint: name === "start_task",
  },
}))

export function create(options: {
  tasks: TaskMCPTasks.Interface
  resource: string
  localOrigin: string
  auth: { authorize(request: Request): Promise<Response | undefined>; metadata(): Response }
}) {
  const resource = new URL(options.resource)
  const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`
  const handler = createMcpHandler(
    () => {
      const server = new Server({ name: "ycoding-tasks", version: "1.0.0" }, { capabilities: { tools: {} } })
      server.setRequestHandler("tools/list", async () => ({ tools }))
      server.setRequestHandler("tools/call", async (request) => {
        const name = request.params.name
        const args = request.params.arguments ?? {}
        try {
          const result =
            name === "list_tasks"
              ? await options.tasks.list(schemas.list_tasks.parse(args))
              : name === "start_task"
                ? await options.tasks.start(schemas.start_task.parse(args))
                : name === "get_status"
                  ? await options.tasks.get(schemas.get_status.parse(args).taskId)
                  : name === "get_result"
                    ? await options.tasks.result(schemas.get_result.parse(args).taskId)
                    : name === "cancel_task"
                      ? await options.tasks.cancel(schemas.cancel_task.parse(args).taskId)
                      : undefined
          if (result === undefined) return { isError: true, content: [{ type: "text", text: "Unknown tool" }] }
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  error instanceof z.ZodError
                    ? "Invalid tool arguments"
                    : error instanceof TaskMCPTasks.TaskError
                      ? error.message
                      : "Task operation failed. Inspect the local YCoding Session before retrying.",
              },
            ],
          }
        }
      })
      return server
    },
    { maxRequestBodySize: 128 * 1024 },
  )
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      // The tunnel terminates TLS; its authenticated localhost hop may retain the public Host over HTTP.
      if (url.host !== resource.host && url.origin !== options.localOrigin) return new Response(null, { status: 403 })
      const origin = request.headers.get("origin")
      if (origin !== null && origin !== resource.origin) return new Response(null, { status: 403 })
      if (url.pathname === metadataPath && request.method === "GET") return options.auth.metadata()
      if (url.pathname !== resource.pathname || url.search) return new Response(null, { status: 404 })
      const denied = await options.auth.authorize(request)
      if (denied) return denied
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
      const response = await handler.fetch(request)
      response.headers.set("cache-control", "no-store")
      return response
    },
    close: () => handler.close(),
  }
}
