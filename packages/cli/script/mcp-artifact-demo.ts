import { parseArgs } from "node:util"
import { RemoteMCPTransport } from "@ycoding-ai/core/remote-mcp/transport"
import { RemoteMcpDemo } from "../src/remote-mcp-demo"

export const demoPNG = RemoteMcpDemo.demoPNG

export async function createArtifactDemo(options: {
  resource: string
  localOrigin: string
  now?: () => number
  auth: { authorize(request: Request): Promise<Response | undefined>; metadata(): Response }
}) {
  const resource = new URL(options.resource)
  const demo = RemoteMcpDemo.create(options.now)
  const transport = RemoteMCPTransport.create({
    name: "ycoding-artifact-client-demo",
    version: "1.0.0",
    tools: RemoteMcpDemo.tools,
    call: async (call) => {
      call.signal.throwIfAborted()
      const operation = call.name === "artifact_demo_preview" ? "artifact.demo.preview" : "artifact.demo.export"
      try {
        return { content: demo.content(operation), structuredContent: demo.data(operation) }
      } catch (error) {
        if (error instanceof RemoteMcpDemo.ExpiredError)
          return { isError: true, content: [{ type: "text", text: "Resource unavailable" }] }
        throw error
      }
    },
    resources: {
      list: async () => demo.list(),
      read: async (input) => {
        input.signal.throwIfAborted()
        return demo.read(input.uri)
      },
    },
  })
  return {
    async fetch(request: Request) {
      const url = new URL(request.url)
      if (url.host !== resource.host && url.origin !== options.localOrigin) return new Response(null, { status: 403 })
      const origin = request.headers.get("origin")
      if (origin !== null && origin !== resource.origin) return new Response(null, { status: 403 })
      if (
        url.pathname === `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}` &&
        request.method === "GET"
      )
        return options.auth.metadata()
      if (url.pathname !== resource.pathname || url.search) return new Response(null, { status: 404 })
      const denied = await options.auth.authorize(request)
      if (denied) return denied
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
      const response = await transport.fetch(request)
      response.headers.set("cache-control", "no-store")
      return response
    },
    close: () => transport.close(),
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      resource: { type: "string" },
      issuer: { type: "string" },
      "jwks-url": { type: "string" },
      subject: { type: "string" },
      port: { type: "string", default: "4098" },
    },
  })
  if (!values.resource || !values.issuer || !values["jwks-url"] || !values.subject)
    throw new Error(
      "Supply --resource, --issuer, --jwks-url, and --subject for the existing OAuth resource. No authorization configuration is changed.",
    )
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port")
  const { TaskMCPAuth } = await import("@ycoding-ai/core/task-mcp/auth")
  const { Effect } = await import("effect")
  const { NodeRuntime } = await import("@effect/platform-node")
  const { serveTaskMcp } = await import("../src/task-mcp-http")
  const demo = await createArtifactDemo({
    resource: values.resource,
    localOrigin: `http://127.0.0.1:${port}`,
    auth: TaskMCPAuth.create({
      resource: values.resource,
      issuer: values.issuer,
      jwksURL: values["jwks-url"],
      subject: values.subject,
    }),
  })
  NodeRuntime.runMain(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.promise(() => demo.close()))
        yield* serveTaskMcp(port, (request) => demo.fetch(request))
        console.log(`Artifact client demo listening on 127.0.0.1:${port}; no shared runtime connected`)
        yield* Effect.never
      }),
    ),
  )
}
