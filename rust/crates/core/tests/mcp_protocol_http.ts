import {
  createMcpHandler,
  inputRequired,
  PROTOCOL_VERSION_META_KEY,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server"

const era = process.env.MCP_HTTP_ERA === "modern" ? "modern" : "legacy"
const received: unknown[] = []
const servers = new Set<Server>()
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
const renewal = { refuse: false, held: undefined as PromiseWithResolvers<void> | undefined }
const elicitations = {
  "empty-elicitation": {
    legacy: { mode: "form" as const, message: "Confirm", requestedSchema: { type: "object" as const, properties: {} } },
    modern: inputRequired.elicit({ message: "Confirm", requestedSchema: { type: "object", properties: {} } }),
  },
  "url-elicitation": {
    legacy: {
      mode: "url" as const,
      message: "Authorize access",
      url: "https://example.com/authorize",
      elicitationId: "elicitation-test",
    },
    modern: inputRequired.elicitUrl({ message: "Authorize access", url: "https://example.com/authorize" }),
  },
}

const build = (version: () => string | undefined) => {
  const server = new Server(
    { name: "protocol", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: { listChanged: true } } },
  )
  server.setRequestHandler("tools/list", () => ({
    tools: ["protocol", ...Object.keys(elicitations)].map((name) => ({
      name,
      inputSchema: { type: "object" as const, properties: {} },
    })),
  }))
  server.setRequestHandler("tools/call", async (request, ctx) => {
    if (era === "modern" && typeof request.params.arguments?.rounds === "number") {
      const state = ctx.mcpReq.requestState<string>()
      const round = state === undefined ? 0 : Number(state)
      if (round < request.params.arguments.rounds)
        return inputRequired({
          ...(request.params.arguments.stateOnly
            ? {}
            : { inputRequests: { elicitation: elicitations["empty-elicitation"].modern } }),
          requestState: String(round + 1),
        })
    }
    const elicitation = elicitations[request.params.name as keyof typeof elicitations]
    if (elicitation) {
      const answered = era === "modern" ? ctx.mcpReq.inputResponses?.elicitation : undefined
      if (era === "modern" && answered === undefined)
        return inputRequired({ inputRequests: { elicitation: elicitation.modern } })
      const result = answered ?? (await server.elicitInput(elicitation.legacy))
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result }
    }
    const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope
    const claimed = envelope?.[PROTOCOL_VERSION_META_KEY]
    return { content: [{ type: "text" as const, text: typeof claimed === "string" ? claimed : String(version()) }] }
  })
  server.setRequestHandler("prompts/list", () => ({ prompts: [{ name: "ask" }] }))
  server.setRequestHandler("prompts/get", (_request, ctx) => {
    if (era === "modern" && ctx.mcpReq.inputResponses?.elicitation === undefined)
      return inputRequired({
        inputRequests: { elicitation: elicitations["url-elicitation"].modern },
        requestState: "prompt-state",
      })
    return {
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: JSON.stringify(ctx.mcpReq.inputResponses?.elicitation) },
        },
      ],
    }
  })
  server.setRequestHandler("resources/list", (request) =>
    request.params?.cursor === "resources-2"
      ? { resources: [{ name: "Logo", uri: "docs://logo", mimeType: "image/png" }] }
      : {
          resources: [{ name: "Readme", uri: "docs://readme", description: "Project docs" }],
          nextCursor: "resources-2",
        },
  )
  server.setRequestHandler("resources/templates/list", (request) =>
    request.params?.cursor === "templates-2"
      ? { resourceTemplates: [{ name: "Issue", uriTemplate: "issue://{id}", description: "Issue" }] }
      : { resourceTemplates: [{ name: "File", uriTemplate: "docs://{path}" }], nextCursor: "templates-2" },
  )
  server.setRequestHandler("resources/read", (request, ctx) => {
    if (era === "modern" && request.params.uri === "docs://ask" && ctx.mcpReq.inputResponses?.elicitation === undefined)
      return inputRequired({ inputRequests: { elicitation: elicitations["empty-elicitation"].modern } })
    return {
      contents: [
        { uri: "docs://readme", text: "hello", mimeType: "text/plain" },
        { uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
      ],
    }
  })
  servers.add(server)
  return server
}

const modern = createMcpHandler(() => build(() => undefined), { legacy: "reject" })

const legacy = async (request: Request, method: string | undefined) => {
  const sessionID = request.headers.get("mcp-session-id")
  if (sessionID !== null) {
    const transport = sessions.get(sessionID)
    if (transport) return transport.handleRequest(request)
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
      { status: 404 },
    )
  }
  if (renewal.refuse) return new Response("unavailable", { status: 503 })
  if (method === "initialize") await renewal.held?.promise
  const server = build(() => server.getNegotiatedProtocolVersion())
  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, transport)
    },
  })
  await server.connect(transport)
  return transport.handleRequest(request)
}

const http = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/received") return Response.json(received)
    if (url.pathname === "/expire") {
      const options = (await request.json()) as { refuse?: boolean; holdUntilCancelled?: boolean }
      sessions.clear()
      renewal.refuse = options.refuse === true
      renewal.held = options.holdUntilCancelled ? Promise.withResolvers<void>() : undefined
      return Response.json({})
    }
    if (url.pathname === "/notify") {
      if (era === "modern") await modern.notify.resourcesChanged()
      if (era === "legacy")
        await Promise.all([...servers].map((server) => server.sendResourceListChanged().catch(() => {})))
      return Response.json({})
    }
    const body = (await request
      .clone()
      .json()
      .catch(() => undefined)) as { method?: string; params?: Record<string, unknown> } | undefined
    if (typeof body?.method === "string") {
      const meta = body.params?._meta as Record<string, unknown> | undefined
      received.push({
        method: body.method,
        header: request.headers.get("mcp-protocol-version"),
        mcpMethod: request.headers.get("mcp-method"),
        mcpName: request.headers.get("mcp-name"),
        envelope: meta?.[PROTOCOL_VERSION_META_KEY] ?? null,
        params: body.params ?? null,
      })
    }
    if (body?.method === "notifications/cancelled") renewal.held?.resolve()
    if (process.env.MCP_HTTP_ERA === "unsupported")
      return Response.json({
        jsonrpc: "2.0",
        id: (await request.clone().json()).id,
        error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2027-01-01"] } },
      })
    return era === "modern" ? modern.fetch(request) : legacy(request, body?.method)
  },
})

process.stdout.write(`${http.url.origin}/mcp\n`)
