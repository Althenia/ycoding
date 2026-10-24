import { spawn } from "bun"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createSession, password, startServer } from "../../../../packages/cli/test/remote-harness"
import { createLocalServer } from "../../../../packages/cli/src/remote-local"
import { RemoteAgent } from "../../../../packages/cli/src/remote-bridge"
import { CloudflareRemoteTransport } from "../../../../packages/cli/src/remote-transport"
import { createRemoteMcpHost } from "../../../../packages/cli/src/remote-mcp-host"
import { RemoteLimits, RemoteWebSocketPath, mcpResource } from "../../../../packages/remote/src/index"
import { enroll, generateDeviceKey, Identity, RemoteCredentials } from "../../../../packages/cli/src/remote-credentials"
import { createRemoteHttp } from "../../../../apps/web/src/remote/http"
import { createRemoteTransport } from "../../../../apps/web/src/remote/transport"
import { deltaChunk, finishChunk, toolCallChunk } from "../../../../packages/ai/test/lib/openai-chunks"
import { Global } from "../../../../packages/core/src/global"
import {
  configPath,
  cookieHeader,
  cookieValue,
  d1Rows,
  decisionSubmission,
  expect,
  isRecord,
  markerRowCount,
  parseForms,
  pkce,
  repositoryRoot,
  rsaIdentity,
  run,
  setCookiePair,
  sha256Hex,
  signedIdToken,
  waitFor,
  wranglerBin,
} from "./mcp-flow-support"

const workerPort = 8808
const workerOrigin = `http://127.0.0.1:${workerPort}`
const socketOrigin = `ws://127.0.0.1:${workerPort}`
const ownerEmail = "mcp-flow-owner@example.invalid"
const siblingEmail = "mcp-flow-sibling@example.invalid"
const strangerEmail = "mcp-flow-stranger@example.invalid"
const providerID = "mcp-flow-local"
const providerModel = "mcp-flow-model"
const mcpClientRedirect = "http://127.0.0.1:19999/callback"
const marker = `MCP-FLOW-MARKER-${crypto.randomUUID()}`
const protocolMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "mcp-flow", version: "1" },
}
const expectedTools = [
  "provider_auth_list", "provider_auth_key", "provider_auth_begin", "provider_auth_status", "provider_auth_complete", "provider_auth_cancel",
  "workspace_list", "workspace_catalog", "workspace_file_find", "session_list", "session_active", "session_get", "session_delete", "session_messages",
  "session_captured_changes_list", "session_compaction_list", "session_compact", "session_snapshot", "session_pending_list",
  "session_attachment_read", "session_todo_list", "session_subagent_list", "session_pin", "session_unpin", "session_subagent_cancel",
  "session_subagent_answer", "session_team_economics", "session_team_shell_list", "session_team_shell_kill", "session_side_chat_list",
  "session_side_chat_create", "session_family_activity", "session_log", "session_prompt", "session_interrupt", "session_prediction",
  "session_prompt_generate", "session_permission_list", "session_permission_reply", "session_guardrail_status",
  "session_guardrail_request_list", "session_guardrail_reply", "session_review_list", "session_review_decide", "session_form_list",
  "session_form_reply", "session_form_cancel", "session_shell_output", "session_autonomy_get", "session_autonomy_set", "session_goal_set",
  "session_goal_stop", "session_create", "session_status", "session_catalog", "session_file_find", "session_switch_model",
  "session_switch_agent", "session_command", "session_skill", "usage_providers", "usage_summary", "usage_report", "session_usage_report",
  "session_prompt_costs", "session_task_costs", "usage_forecast", "incident_report", "incident_recent", "incident_guidance",
  "incident_guidance_clear", "machine_keep_awake_get", "machine_keep_awake_set", "artifact_demo_preview", "artifact_demo_export",
  "coordination_settings", "coordination_list", "coordination_create", "coordination_get", "coordination_update", "coordination_delete",
  "local_app_register", "local_app_list", "local_app_revoke", "local_app_open", "local_app_status", "local_app_http", "session_create_in_directory",
]

type McpClient = {
  connect: (transport: unknown) => Promise<void>
  listTools: () => Promise<{ tools: { name: string }[] }>
  callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<{
    isError?: boolean
    structuredContent?: unknown
    content?: { type: string; text?: string }[]
  }>
  close: () => Promise<void>
}
type McpSdk = {
  Client: new (info: { name: string; version: string }, options: unknown) => McpClient
  StreamableHTTPClientTransport: new (url: URL, options: unknown) => unknown
}
type OAuthClient = { readonly id: string; readonly name: string; readonly redirectUri: string }
type TokenSet = { readonly access: string; readonly refresh: string; readonly expiresIn: number }
type FlowIdentity = { readonly subject: string; readonly email: string }

const checks: string[] = []
const notExercised: string[] = []
const diagnostics: string[] = []
const disposals: (() => Promise<void>)[] = []
let wrangler: { kill: (signal?: NodeJS.Signals) => unknown; exited: Promise<number> } | undefined
let google: { stop: (closeActive?: boolean) => unknown } | undefined
let agent: RemoteAgent | undefined
let home: string | undefined

try {
  await mkdir(join(repositoryRoot, ".cache/tmp"), { recursive: true })
  home = await mkdtemp(join(repositoryRoot, ".cache/tmp/ycoding-mcp-flow-"))
  const workspace = join(home, "workspace")
  const serverConfig = join(home, "server-config")
  const persist = join(home, "wrangler-state")
  const mcpHome = join(home, "mcp-home")
  const outside = join(home, "outside")
  const approvedDirectory = join(mcpHome, "projects", "app")
  await mkdir(workspace, { recursive: true })
  await mkdir(serverConfig, { recursive: true })
  await mkdir(approvedDirectory, { recursive: true })
  await mkdir(join(outside, "inner"), { recursive: true })
  await writeFile(join(mcpHome, "file.txt"), "not a directory")
  await symlink(outside, join(mcpHome, "link-out"))


  const providerRequests: unknown[] = []
  let providerMode: "instant" | "hold" = "instant"
  let releaseStream: (() => void) | undefined
  let providerFollowUpText = "Local stand-in reply."
  let providerTurn: {
    readonly tool?: { readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
    readonly text: string
    readonly prompt?: string
  } = { text: providerFollowUpText }
  const stub = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body: unknown = await request.json()
      providerRequests.push(body)
      const encoder = new TextEncoder()
      const prompt = providerTurn.prompt
      const selected = prompt === undefined || (isRecord(body) && Array.isArray(body.messages) && body.messages.some((message) =>
        isRecord(message) && message.role === "user" && typeof message.content === "string" && message.content.startsWith(prompt)))
      const turn = selected ? providerTurn : { text: providerFollowUpText }
      if (selected) providerTurn = { text: providerFollowUpText }
      const frames = turn.tool === undefined
        ? [deltaChunk({ role: "assistant" }), deltaChunk({ content: turn.text }), finishChunk("stop")]
        : [toolCallChunk(turn.tool.id, turn.tool.name, JSON.stringify(turn.tool.input)), finishChunk("tool_calls")]
      const hold = providerMode === "hold" && selected && turn.tool === undefined
      const stream = new ReadableStream({
        async start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          if (hold) await new Promise<void>((resolve) => (releaseStream = resolve))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  disposals.push(async () => stub.stop(true))

  process.env.YCODING_CONFIG_DIR = serverConfig
  await Bun.write(
    join(serverConfig, "ycoding.json"),
    JSON.stringify({
      model: `${providerID}/${providerModel}`,
      default_agent: "flow-approval",
      agents: {
        "flow-approval": {
          description: "MCP-flow approval agent: every shell call asks.",
          mode: "primary",
          permissions: [{ action: "shell", resource: "*", effect: "ask" }],
        },
        "flow-guard": {
          description: "MCP-flow guardrail agent: shell allowed, guardrail rules decide.",
          mode: "primary",
          permissions: [{ action: "shell", resource: "*", effect: "allow" }],
        },
      },
      providers: {
        [providerID]: {
          package: "aisdk:@ai-sdk/openai-compatible",
          name: "MCP Flow Local Stand-in",
          settings: { baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: "flow-stand-in-key" },
          models: { [providerModel]: { name: "MCP Flow Model" } },
        },
      },
    }),
  )
  await mkdir(join(serverConfig, "guardrails"), { recursive: true })
  await Bun.write(
    join(serverConfig, "guardrails", "flow-ordinary.md"),
    [
      "---",
      "id: flow.guard.ordinary",
      "decision: ask",
      "actions: [shell]",
      'resources: ["*ordinary-allowed*"]',
      "reason: MCP-flow ordinary review",
      "priority: 10",
      "---",
      "",
      "MCP-flow ordinary guardrail rule.",
      "",
    ].join("\n"),
  )


  const server = await startServer(serverConfig)
  disposals.push(() => server.close())
  await createSession(server, "ses_mcp_seed", workspace, { providerID, id: providerModel })
  const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
  const location = { directory: workspace }
  expect((await local.listPage({ limit: 50 })).data.some((info) => info.id === "ses_mcp_seed"), "the CLI adapter could not read the seeded Session")
  checks.push("real isolated YCoding server and CLI adapter are running with a recorded workspace")


  const ownerSubject = `mcp-owner-${crypto.randomUUID()}`
  const siblingSubject = `mcp-sibling-${crypto.randomUUID()}`
  const identityKey = await rsaIdentity()
  const idTokenHolder: { value: string } = { value: "" }
  const googleHits: string[] = []
  const googleServer = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      googleHits.push(url.pathname)
      if (url.pathname === "/token") return Response.json({ id_token: idTokenHolder.value, access_token: "access-token" })
      if (url.pathname === "/certs") return Response.json({ keys: [identityKey.jwk] })
      return new Response("not found", { status: 404 })
    },
  })
  google = googleServer
  const googleOrigin = `http://127.0.0.1:${googleServer.port}`

  await run(wranglerBin, ["d1", "migrations", "apply", "ycoding-prod-db", "--local", "--config", configPath, "--persist-to", persist])
  const occupied = await fetch(`${workerOrigin}/health`).then(() => true, () => false)
  expect(!occupied, `port ${workerPort} already serves a relay; stop the other dev server first`)
  wrangler = spawn(
    [
      wranglerBin, "dev", "--config", configPath, "--persist-to", persist, "--port", String(workerPort),
      "--local-upstream", `127.0.0.1:${workerPort}`,
      "--var", "GOOGLE_CLIENT_ID:mcp-flow-client",
      "--var", "GOOGLE_CLIENT_SECRET:mcp-flow-secret",
      "--var", `GOOGLE_ALLOWED_EMAILS:${ownerEmail},${siblingEmail}`,
      "--var", "CLEANUP_INTERVAL_MS:86400000",
      "--var", `GOOGLE_ISSUER:${googleOrigin}`,
      "--var", `GOOGLE_AUTHORIZATION_ENDPOINT:${googleOrigin}/authorize`,
      "--var", `GOOGLE_TOKEN_ENDPOINT:${googleOrigin}/token`,
      "--var", `GOOGLE_JWKS_URI:${googleOrigin}/certs`,
    ],
    { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" },
  )
  await waitForWorker()


  const signIn = async (identity: FlowIdentity) => {
    const started = await fetch(`${workerOrigin}/api/auth/google/start?redirect_after=/remote/`, { redirect: "manual" })
    const oauthCookie = setCookiePair(started, "yc_oauth")
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? ""
    const rows = await d1Rows(persist, `SELECT nonce FROM oauth_transaction WHERE id = '${await sha256Hex(cookieValue(oauthCookie))}'`)
    const nonce = typeof rows[0]?.nonce === "string" ? rows[0].nonce : ""
    expect(nonce.length > 0, "the OAuth transaction was not found in the isolated local D1 state")
    const issuedAt = Math.floor(Date.now() / 1000)
    idTokenHolder.value = await signedIdToken(identityKey, { iss: googleOrigin, aud: "mcp-flow-client", sub: identity.subject,
      iat: issuedAt, exp: issuedAt + 3600, nonce, email: identity.email, email_verified: true })
    const callback = await fetch(`${workerOrigin}/api/auth/google/callback?code=flow-code&state=${state}`, { headers: { cookie: oauthCookie }, redirect: "manual" })
    expect(callback.headers.get("location") === "/remote/", "the browser Google callback refused sign-in")
    return setCookiePair(callback, "yc_session")
  }
  const ownerCookie = await signIn({ subject: ownerSubject, email: ownerEmail })
  const browserFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("cookie", ownerCookie)
    headers.set("origin", workerOrigin)
    headers.set("sec-fetch-site", "same-origin")
    return fetch(input, { ...init, headers })
  }
  const http = createRemoteHttp({ baseURL: workerOrigin, fetch: browserFetch })
  const enrollDevice = async (name: string) => {
    const enrollment = await http.createEnrollment()
    if (!enrollment.ok) throw new Error(`MCP-flow check failed: enrollment code was not minted (${JSON.stringify(enrollment)})`)
    const key = await generateDeviceKey()
    const enrolled = await enroll({ relayURL: workerOrigin, enrollmentID: enrollment.value.enrollmentID, code: enrollment.value.code,
      name, privateKey: key.privateKey, publicKey: key.publicKey })
    return { deviceID: enrolled.deviceID, key }
  }
  const primary = await enrollDevice("MCP Flow Device")
  const secondary = await enrollDevice("MCP Flow Second Device")
  const deviceID = primary.deviceID
  const resource = mcpResource(workerOrigin, deviceID)
  const otherResource = mcpResource(workerOrigin, secondary.deviceID)
  checks.push("Google-allowlisted owner enrolled two devices through the real relay")

  const cliRequire = createRequire(join(repositoryRoot, "packages/cli/package.json"))
  const effectModule = (await import(cliRequire.resolve("effect"))) as {
    readonly Effect: { readonly runPromise: (value: unknown) => Promise<never>; readonly provide: (layer: unknown) => (self: unknown) => unknown }
    readonly Layer: { readonly mergeAll: (layers: readonly unknown[]) => unknown }
  }
  const platformModule = (await import(cliRequire.resolve("@effect/platform-node"))) as { readonly NodeFileSystem: { readonly layer: unknown } }
  const cliState = join(home, "cli-state")
  await mkdir(cliState, { recursive: true })
  const runEffect = (effect: unknown): Promise<unknown> =>
    effectModule.Effect.runPromise(effectModule.Effect.provide(
      effectModule.Layer.mergeAll(Global.layerWith({ state: cliState, config: serverConfig, home }), platformModule.NodeFileSystem.layer),
    )(effect))
  await runEffect(RemoteCredentials.create(Identity.make({
    deviceID, name: "MCP Flow Device", relayURL: workerOrigin, publicKey: primary.key.publicKey, privateKey: primary.key.privateKey, enrolledAt: Date.now(),
  })))
  const credentials = async (): Promise<{ accessToken: string; accessExpiresAt: number }> => {
    const stored = (await runEffect(RemoteCredentials.read())) as { readonly deviceID: string } | undefined
    if (stored === undefined) throw new Error("the stored device identity disappeared")
    return (await runEffect(RemoteCredentials.credentials(stored))) as { accessToken: string; accessExpiresAt: number }
  }


  const host = await createRemoteMcpHost({ file: join(home, "state", "remote-mcp.json"), remote: () => "on" })
  let mcpFrames = 0
  const startAgent = async () => {
    const created = new RemoteAgent({
      relayURL: workerOrigin,
      local,
      credentials,
      refreshIntervalMs: 3_600_000,
      mcp: { host, resource, deviceID, home: mcpHome },
      createConnection: (input) => {
        const transport = new CloudflareRemoteTransport({ url: input.url, headers: { authorization: `Bearer ${input.accessToken}` },
          onOpen: input.onOpen, onClose: ({ code, reason }) => input.onClose(code, reason) })
        transport.onMessage((frame) => { if (isRecord(frame) && frame.type === "request" && frame.operation === "mcp.request") mcpFrames++ })
        return transport
      },
      onDiagnostic: (message) => diagnostics.push(message),
      onTerminal: (message) => diagnostics.push(`terminal: ${message}`),
    })
    agent = created
    await created.connect()
    await waitFor(() => (created.currentState === "live" ? true : undefined), 20_000, "the agent never went live")
    return created
  }
  disposals.push(async () => agent?.close())
  await startAgent()
  const deviceRow = async () => (await d1Rows(persist, `SELECT enabled, enable_epoch FROM mcp_device WHERE device_id = '${deviceID}'`))[0]
  await waitFor(async () => {
    const row = await deviceRow()
    return row !== undefined && row.enabled === 0 && row.enable_epoch === host.advertisement().epoch ? true : undefined
  }, 20_000, "the RemoteAgent did not advertise its disabled MCP state and receive the relay acknowledgement")
  expect(host.status().state === "off", `the host reported ${JSON.stringify(host.status())} after the disabled acknowledgement`)
  const disabledEpoch = host.advertisement().epoch
  checks.push("RemoteAgent advertised its MCP state on connect and the relay acknowledged it into local D1")


  const windows: Record<"auth" | "token" | "register", number[]> = { auth: [], token: [], register: [] }
  const paced = async (group: keyof typeof windows, url: string, init: RequestInit = {}) => {
    const hits = windows[group]
    for (;;) {
      const now = Date.now()
      while (hits.length > 0 && now - hits[0]! >= 61_000) hits.shift()
      if (hits.length < 24) break
      await Bun.sleep(Math.max(50, hits[0]! + 61_000 - now))
    }
    hits.push(Date.now())
    return fetch(`${workerOrigin}${url}`, { redirect: "manual", ...init })
  }
  const formInit = (fields: Record<string, string>, cookie?: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: workerOrigin, "sec-fetch-site": "same-origin", ...(cookie === undefined ? {} : { cookie }) },
    body: new URLSearchParams(fields).toString(),
  })

  const register = async (name: string, redirectUris: string[] = [mcpClientRedirect]): Promise<OAuthClient> => {
    const response = await paced("register", "/api/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    })
    const body: unknown = await response.json()
    expect((response.status === 200 || response.status === 201) && isRecord(body) && typeof body.client_id === "string",
      `dynamic client registration failed: ${response.status} ${JSON.stringify(body)}`)
    if (!isRecord(body) || typeof body.client_id !== "string") throw new Error("unreachable")
    expect(body.client_secret === undefined && body.token_endpoint_auth_method === "none", "registration returned a client secret or a non-public method")
    expect(response.headers.get("cache-control")?.includes("no-store") === true, "registration was cacheable")
    return { id: body.client_id, name, redirectUri: redirectUris[0] ?? mcpClientRedirect }
  }

  const authorizeRequest = (client: OAuthClient, challenge: string, state: string, overrides: Record<string, string | undefined> = {}) => {
    const parameters: Record<string, string | undefined> = { response_type: "code", client_id: client.id, redirect_uri: client.redirectUri,
      resource, scope: "ycoding:remote", state, code_challenge: challenge, code_challenge_method: "S256", ...overrides }
    const query = new URLSearchParams(Object.entries(parameters).flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const])))
    return paced("auth", `/api/mcp/oauth/authorize?${query}`)
  }

  const hasForm = async (response: Response, action: string) => {
    if (response.status !== 200) return false
    return parseForms(await response.clone().text()).some((form) => form.action.includes(action))
  }

  const authorize = async (client: OAuthClient, input: { decision?: "allow" | "deny"; identity?: FlowIdentity; race?: boolean } = {}) => {
    const { verifier, challenge } = pkce()
    const state = crypto.randomUUID()
    const notice = await authorizeRequest(client, challenge, state)
    expect(notice.status === 200 && notice.headers.get("cache-control")?.includes("no-store") === true, `authorization notice returned ${notice.status}`)
    const noticeHtml = await notice.clone().text()
    const login = parseForms(noticeHtml).find((form) => form.action.includes("/api/mcp/oauth/login"))
    expect(login !== undefined && Object.keys(login.fields).length > 0, "the notice page offered no CSRF-protected Continue form")
    const googleBefore = googleHits.length
    const cookie = cookieHeader([notice])
    expect(cookie.length > 0, "the notice response set no transaction cookie")
    const continued = await paced("auth", login!.action, formInit(login!.fields, cookie))
    expect(continued.status >= 300 && continued.status < 400, `Continue returned ${continued.status}`)
    const target = new URL(continued.headers.get("location") ?? "")
    expect(target.origin === googleOrigin && googleHits.length === googleBefore, "Continue did not hand off to the Google authorization endpoint without contacting it")
    const nonce = target.searchParams.get("nonce") ?? ""
    const googleState = target.searchParams.get("state") ?? ""
    const callbackUri = new URL(target.searchParams.get("redirect_uri") ?? "")
    expect(nonce.length > 0 && googleState.length > 0 && callbackUri.pathname === "/api/mcp/oauth/google/callback", "the Google handoff carried no state, nonce, or MCP callback")
    const who = input.identity ?? { subject: ownerSubject, email: ownerEmail }
    const issuedAt = Math.floor(Date.now() / 1000)
    idTokenHolder.value = await signedIdToken(identityKey, { iss: googleOrigin, aud: "mcp-flow-client", sub: who.subject,
      iat: issuedAt, exp: issuedAt + 3600, nonce, email: who.email, email_verified: true })
    const callback = await paced("auth", `${callbackUri.pathname}?code=mcp-google-code&state=${encodeURIComponent(googleState)}`,
      { headers: { cookie: cookieHeader([notice, continued]) } })
    const consentCookie = cookieHeader([notice, continued, callback])
    if (!(await hasForm(callback, "/api/mcp/oauth/consent"))) return { kind: "refused" as const, status: callback.status, verifier, state, noticeHtml }
    const consentHtml = await callback.clone().text()
    const consent = decisionSubmission(parseForms(consentHtml), "/api/mcp/oauth/consent", input.decision ?? "allow")
    const submit = () => paced("auth", consent.form.action, formInit({ ...consent.form.fields, ...consent.extra }, consentCookie))
    if (input.race === true) return { kind: "raced" as const, results: await Promise.all([submit(), submit()]), verifier, state }
    const decided = await submit()
    expect(decided.status >= 300 && decided.status < 400, `consent decision returned ${decided.status}`)
    const redirect = new URL(decided.headers.get("location") ?? "")
    return { kind: "decided" as const, redirect, verifier, state, noticeHtml, consentHtml, consentCookie }
  }

  const tokenRequest = async (fields: Record<string, string>) => {
    const response = await paced("token", "/api/mcp/oauth/token", formInit(fields))
    const body: unknown = await response.json().catch(() => undefined)
    return { status: response.status, body, response }
  }
  const exchange = (client: OAuthClient, code: string, verifier: string, overrides: Record<string, string> = {}) =>
    tokenRequest({ grant_type: "authorization_code", code, redirect_uri: client.redirectUri, client_id: client.id, code_verifier: verifier, resource, ...overrides })
  const tokensOf = (result: { status: number; body: unknown }): TokenSet => {
    const body = result.body
    expect(result.status === 200 && isRecord(body) && typeof body.access_token === "string" && typeof body.refresh_token === "string" &&
      typeof body.expires_in === "number", `token endpoint returned ${result.status} ${JSON.stringify(body)}`)
    if (!isRecord(body) || typeof body.access_token !== "string" || typeof body.refresh_token !== "string" || typeof body.expires_in !== "number") throw new Error("unreachable")
    return { access: body.access_token, refresh: body.refresh_token, expiresIn: body.expires_in }
  }
  const obtainTokens = async (client: OAuthClient) => {
    const outcome = await authorize(client)
    expect(outcome.kind === "decided" && outcome.redirect.searchParams.has("code"), "the full authorization flow did not issue a code")
    if (outcome.kind !== "decided") throw new Error("unreachable")
    return tokensOf(await exchange(client, outcome.redirect.searchParams.get("code") ?? "", outcome.verifier))
  }
  const errorOf = (body: unknown) => (isRecord(body) && typeof body.error === "string" ? body.error : undefined)
  const countOf = async (sql: string) => {
    const value = Object.values((await d1Rows(persist, sql))[0] ?? {})[0]
    if (typeof value !== "number") throw new Error(`MCP-flow check failed: ${sql} returned no count`)
    return value
  }
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`
  const orphanedCredentials = () =>
    countOf("SELECT (SELECT count(*) FROM mcp_token WHERE grant_id NOT IN (SELECT id FROM mcp_grant)) + (SELECT count(*) FROM mcp_code WHERE grant_id NOT IN (SELECT id FROM mcp_grant)) AS orphans")


  const mcpPost = (token: string | undefined, method: string, params: Record<string, unknown>, extra: Record<string, string> = {}, target = resource) =>
    fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28",
        "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: protocolMeta } }),
    })
  const loaded: unknown = await import(pathToFileURL(createRequire(join(repositoryRoot, "packages/core/package.json")).resolve("@modelcontextprotocol/client")).href)
  const sdk = (isRecord(loaded) && isRecord(loaded.default) && typeof loaded.Client !== "function" ? loaded.default : loaded) as McpSdk
  const connectClient = async (token: string) => {
    const client = new sdk.Client({ name: "ycoding-mcp-flow", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
    await client.connect(new sdk.StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    disposals.push(() => client.close())
    return client
  }
  const toolOf = (client: McpClient) => async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return { isError: result.isError === true, value: result.structuredContent, text: result.content?.[0]?.text ?? "" }
  }
  const dataOf = (value: unknown): unknown => (isRecord(value) ? value.data : undefined)
  const errorCodeOf = (value: unknown) => (isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : undefined)


  const challenge = `Bearer resource_metadata="${workerOrigin}/.well-known/oauth-protected-resource/api/mcp/devices/${deviceID}", scope="ycoding:remote"`
  const anonymous = await mcpPost(undefined, "tools/list", {})
  expect(anonymous.status === 401 && anonymous.headers.get("www-authenticate") === challenge && anonymous.headers.get("cache-control")?.includes("no-store") === true,
    `an unauthenticated MCP request returned ${anonymous.status} ${anonymous.headers.get("www-authenticate")}`)
  const garbage = await mcpPost("not-a-real-token", "tools/list", {})
  expect(garbage.status === 401 && garbage.headers.get("www-authenticate")?.startsWith("Bearer resource_metadata=") === true, "an unknown bearer was not challenged")
  const resourceMetadata = await fetch(`${workerOrigin}/.well-known/oauth-protected-resource/api/mcp/devices/${deviceID}`)
  const resourceBody: unknown = await resourceMetadata.json()
  expect(resourceMetadata.status === 200 && isRecord(resourceBody) && resourceBody.resource === resource &&
    JSON.stringify(resourceBody.authorization_servers) === JSON.stringify([workerOrigin]) &&
    JSON.stringify(resourceBody.scopes_supported) === JSON.stringify(["ycoding:remote"]) &&
    JSON.stringify(resourceBody.bearer_methods_supported) === JSON.stringify(["header"]), `protected-resource metadata was wrong: ${JSON.stringify(resourceBody)}`)
  const serverMetadata = await fetch(`${workerOrigin}/.well-known/oauth-authorization-server`)
  const serverBody: unknown = await serverMetadata.json()
  expect(serverMetadata.status === 200 && isRecord(serverBody) && serverBody.issuer === workerOrigin &&
    JSON.stringify(serverBody.code_challenge_methods_supported) === JSON.stringify(["S256"]) &&
    JSON.stringify(serverBody.token_endpoint_auth_methods_supported) === JSON.stringify(["none"]) &&
    JSON.stringify(serverBody.response_types_supported) === JSON.stringify(["code"]) &&
    serverBody.client_id_metadata_document_supported === true && serverBody.authorization_response_iss_parameter_supported === true,
  `authorization-server metadata was wrong: ${JSON.stringify(serverBody)}`)
  const getResource = await fetch(resource, { method: "GET" })
  expect(getResource.status === 405 || getResource.status === 401, `GET on the MCP resource returned ${getResource.status}`)
  const unknownPath = await fetch(`${workerOrigin}/api/mcp/unknown`, { headers: { accept: "text/html" } })
  expect(unknownPath.status === 404 && (unknownPath.headers.get("content-type") ?? "").includes("json"), "an unknown MCP path did not return JSON 404")
  checks.push("missing and unknown bearers receive the 401 challenge with protected-resource metadata; authorization-server metadata advertises S256, public clients, issuer response; unknown MCP paths return JSON 404")


  const rejectedRegistrations = await Promise.all([
    paced("register", "/api/mcp/oauth/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Secret", redirect_uris: [mcpClientRedirect], token_endpoint_auth_method: "client_secret_basic" }) }),
    paced("register", "/api/mcp/oauth/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Wildcard", redirect_uris: ["https://client.example/*"], token_endpoint_auth_method: "none" }) }),
    paced("register", "/api/mcp/oauth/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Fragment", redirect_uris: ["https://client.example/cb#x"], token_endpoint_auth_method: "none" }) }),
  ])
  expect(rejectedRegistrations.every((response) => response.status >= 400 && response.status < 500), "registration accepted a secret method, wildcard, or fragment redirect")
  const clientName = `Flow <b>Client</b> & "Co"`
  const clientA = await register(clientName)
  const clientB = await register("Second Flow Client")
  checks.push("DCR registered public clients with exact redirect URIs and refused secret methods, wildcard redirects, and fragments")
  const cimdStub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ client_id: "unused" }) })
  disposals.push(async () => cimdStub.stop(true))
  const cimdAttempt = await authorizeRequest(
    { id: `https://127.0.0.1:${cimdStub.port}/client.json`, name: "cimd", redirectUri: mcpClientRedirect }, pkce().challenge, "cimd-state")
  expect(cimdAttempt.status >= 400 && !(await hasForm(cimdAttempt, "/api/mcp/oauth/login")), "a loopback CIMD client ID was accepted")
  notExercised.push("CIMD success path: the Worker refuses local/IP/non-HTTPS metadata hosts and the sandbox has no public HTTPS host, so only the refusal of a loopback CIMD client ID is exercised here (parser/policy coverage lives in infra/cloudflare/test/mcp-client.test.ts)")


  const whileOff = await authorizeRequest(clientA, pkce().challenge, "off-state")
  expect(!(await hasForm(whileOff, "/api/mcp/oauth/login")), "an authorization request for a device with MCP off reached the consent notice")
  checks.push("authorization is refused for a device whose MCP switch is off")


  const enabled = await host.set(true)
  expect(enabled.state === "on" && enabled.url === resource, `enabling MCP reported ${JSON.stringify(enabled)}`)
  const onRow = await deviceRow()
  expect(onRow?.enabled === 1 && onRow.enable_epoch === host.advertisement().epoch, "the relay did not record the enabled state and epoch")
  expect(onRow?.enable_epoch !== disabledEpoch, "enabling MCP kept the disabled epoch")
  checks.push("host.set(true) persisted the preference, was acknowledged by the relay, and reported the stable MCP URL")


  const main = await authorize(clientA)
  expect(main.kind === "decided", "the allowlisted owner could not reach consent")
  if (main.kind !== "decided") throw new Error("unreachable")
  expect(main.noticeHtml.includes("Flow &lt;b&gt;Client&lt;/b&gt; &amp; &quot;Co&quot;") && !main.noticeHtml.includes("<b>Client</b>"),
    "the pre-Google notice did not escape the client name")
  expect(main.noticeHtml.includes("127.0.0.1:19999") && main.noticeHtml.includes("Local address"), "the notice omitted the redirect host or the loopback warning")
  expect(main.consentHtml.includes("MCP Flow Device") && main.consentHtml.includes("Flow &lt;b&gt;Client&lt;/b&gt;"),
    "the final consent page omitted the device name or the escaped client name")
  expect(main.redirect.searchParams.get("state") === main.state && main.redirect.searchParams.get("iss") === workerOrigin && main.redirect.origin + main.redirect.pathname === mcpClientRedirect,
    `the consent redirect was ${main.redirect.toString()}`)
  const mainCode = main.redirect.searchParams.get("code") ?? ""
  const tokensA = tokensOf(await exchange(clientA, mainCode, main.verifier))
  expect(tokensA.expiresIn > 0 && tokensA.expiresIn <= 300, `the access lifetime was ${tokensA.expiresIn}s`)
  checks.push("pre-Google notice and final consent rendered escaped client data, the code redirect carried state and issuer, and S256 exchange with the exact resource issued a five-minute bearer")

  const denied = await authorize(clientB, { decision: "deny" })
  expect(denied.kind === "decided" && denied.redirect.searchParams.get("error") === "access_denied" && denied.redirect.searchParams.get("state") === denied.state &&
    denied.redirect.searchParams.get("iss") === workerOrigin && !denied.redirect.searchParams.has("code"), "denial did not return access_denied with state and issuer")
  const stranger = await authorize(clientB, { identity: { subject: `mcp-stranger-${crypto.randomUUID()}`, email: strangerEmail } })
  expect(stranger.kind === "refused", "a non-allowlisted Google identity reached consent")
  const sibling = await authorize(clientB, { identity: { subject: siblingSubject, email: siblingEmail } })
  expect(sibling.kind === "refused", "an allowlisted identity that does not own the device reached consent")
  const wrongRedirect = await authorizeRequest(clientA, pkce().challenge, "x", { redirect_uri: "http://127.0.0.1:19999/other" })
  expect(wrongRedirect.status >= 400 && wrongRedirect.headers.get("location") === null, "an unregistered redirect URI was accepted or redirected to")
  const plain = await authorizeRequest(clientA, pkce().challenge, "x", { code_challenge_method: "plain" })
  expect(plain.status >= 300 && (plain.headers.get("location") ?? "").includes("error="), "a plain PKCE method was accepted")
  const noChallenge = await authorizeRequest(clientA, "", "x", { code_challenge: undefined, code_challenge_method: undefined })
  expect(!(await hasForm(noChallenge, "/api/mcp/oauth/login")), "a request without PKCE reached the notice")
  const foreignDevice = await authorizeRequest(clientA, pkce().challenge, "x", { resource: otherResource })
  expect(!(await hasForm(foreignDevice, "/api/mcp/oauth/login")), "authorization for a device with MCP off or another resource reached the notice")
  checks.push("denial, non-allowlisted Google identity, non-owner identity, unregistered redirect, plain PKCE, missing PKCE, and a second device's resource were all refused")

  const verifierCase = await authorize(clientA)
  expect(verifierCase.kind === "decided", "the verifier case did not reach a code")
  if (verifierCase.kind !== "decided") throw new Error("unreachable")
  const caseCode = verifierCase.redirect.searchParams.get("code") ?? ""
  const wrongVerifier = await exchange(clientA, caseCode, pkce().verifier)
  const wrongRedirectExchange = await exchange(clientA, caseCode, verifierCase.verifier, { redirect_uri: "http://127.0.0.1:19999/other" })
  const wrongClient = await exchange(clientA, caseCode, verifierCase.verifier, { client_id: clientB.id })
  const wrongResource = await exchange(clientA, caseCode, verifierCase.verifier, { resource: `${workerOrigin}/api/mcp/devices/other` })
  const crossDevice = await exchange(clientA, caseCode, verifierCase.verifier, { resource: otherResource })
  expect([wrongVerifier, wrongRedirectExchange, wrongClient].every((result) => result.status === 400 && errorOf(result.body) === "invalid_grant"),
    "a wrong verifier, redirect, or client did not return invalid_grant")
  expect([wrongResource, crossDevice].every((result) => result.status === 400 && errorOf(result.body) !== undefined), "a wrong or cross-device resource was accepted")
  const raced = await Promise.all([exchange(clientA, caseCode, verifierCase.verifier), exchange(clientA, caseCode, verifierCase.verifier)])
  expect(raced.filter((result) => result.status === 200).length === 1 && raced.filter((result) => result.status === 400 && errorOf(result.body) === "invalid_grant").length === 1,
    `simultaneous exchanges produced ${raced.map((result) => result.status).join(",")}`)
  const racedTokens = tokensOf(raced.find((result) => result.status === 200)!)
  const replay = await exchange(clientA, caseCode, verifierCase.verifier)
  expect(replay.status === 400 && errorOf(replay.body) === "invalid_grant", "a replayed code was accepted")
  checks.push("wrong verifier, redirect, client, resource, and cross-device resource failed without consuming the code; two simultaneous exchanges produced exactly one token pair; replay failed")

  const consentRace = await authorize(clientB, { race: true })
  expect(consentRace.kind === "raced", "the consent race did not reach the consent page")
  if (consentRace.kind !== "raced") throw new Error("unreachable")
  const issued = consentRace.results.flatMap((result) => {
    const target = result.headers.get("location")
    return target !== null && new URL(target).searchParams.has("code") ? [new URL(target)] : []
  })
  expect(issued.length === 1, `simultaneous consent submissions issued ${issued.length} codes`)
  expect(await countOf(`SELECT count(*) AS n FROM mcp_grant WHERE client_id = ${quoted(clientB.id)}`) === 1, "simultaneous consent submissions created more than one grant")
  expect(await countOf(`SELECT count(*) AS n FROM mcp_code WHERE grant_id IN (SELECT id FROM mcp_grant WHERE client_id = ${quoted(clientB.id)})`) === 1,
    "simultaneous consent submissions created more than one code")
  const tokensB = tokensOf(await exchange(clientB, issued[0]!.searchParams.get("code") ?? "", consentRace.verifier))
  const refreshRace = await Promise.all([1, 2].map(() => tokenRequest({ grant_type: "refresh_token", refresh_token: tokensB.refresh, client_id: clientB.id, resource })))
  expect(refreshRace.filter((result) => result.status === 200).length === 1 && refreshRace.filter((result) => result.status === 400 && errorOf(result.body) === "invalid_grant").length === 1,
    `simultaneous refreshes produced ${refreshRace.map((result) => result.status).join(",")}`)
  const winner = tokensOf(refreshRace.find((result) => result.status === 200)!)
  expect((await mcpPost(winner.access, "tools/list", {})).status === 401, "the family stayed usable after a concurrent refresh reuse")
  const afterRace = await tokenRequest({ grant_type: "refresh_token", refresh_token: winner.refresh, client_id: clientB.id, resource })
  expect(afterRace.status === 400 && errorOf(afterRace.body) === "invalid_grant", "the winning refresh token survived the reuse revocation")
  checks.push("two simultaneous consent submissions issued one code and one grant; two simultaneous refreshes rotated once and the reuse revoked the whole family")

  const expiring = await authorize(clientA)
  if (expiring.kind !== "decided") throw new Error("MCP-flow check failed: the expiry case did not reach a code")
  await d1Rows(persist, "UPDATE mcp_code SET expires_at = 1 WHERE consumed_at IS NULL")
  const expired = await exchange(clientA, expiring.redirect.searchParams.get("code") ?? "", expiring.verifier)
  expect(expired.status === 400 && errorOf(expired.body) === "invalid_grant", "an expired code was accepted")
  checks.push("a code aged past its one-minute lifetime in local D1 was refused")

  await d1Rows(persist, `UPDATE mcp_token SET expires_at = 1 WHERE token_hash = '${await sha256Hex(racedTokens.access)}'`)
  const expiredAccess = await mcpPost(racedTokens.access, "tools/list", {})
  expect(expiredAccess.status === 401, `an expired access token returned ${expiredAccess.status}`)
  const rotated = tokensOf(await tokenRequest({ grant_type: "refresh_token", refresh_token: racedTokens.refresh, client_id: clientA.id, resource }))
  expect(rotated.refresh !== racedTokens.refresh && rotated.access !== racedTokens.access, "refresh did not rotate both credentials")
  expect((await mcpPost(rotated.access, "tools/list", {})).status === 200, "the rotated access token was refused")
  const reuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: racedTokens.refresh, client_id: clientA.id, resource })
  expect(reuse.status === 400 && errorOf(reuse.body) === "invalid_grant", "a reused refresh token was accepted")
  expect((await mcpPost(rotated.access, "tools/list", {})).status === 401, "reusing a refresh token did not revoke the family")
  const wrongAudience = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokensA.refresh, client_id: clientA.id, resource: otherResource })
  expect(wrongAudience.status === 400, "a refresh with another resource was accepted")
  checks.push("expired access refused with 401; refresh rotated both credentials; reuse of the old refresh token was refused and revoked the family; refresh with a foreign resource was refused")

  const wrongDevice = await mcpPost(tokensA.access, "tools/list", {}, {}, otherResource)
  expect(wrongDevice.status === 401 || wrongDevice.status === 403, `a bearer for one device was accepted at another device's resource (${wrongDevice.status})`)


  const probesBeforeWire = mcpFrames
  const client = await connectClient(tokensA.access)
  const call = toolOf(client)
  const listed = await client.listTools()
  expect(JSON.stringify(listed.tools.map((tool) => tool.name)) === JSON.stringify(expectedTools), `tool inventory differed: ${listed.tools.map((tool) => tool.name).join(",")}`)
  expect(new Set(expectedTools).size === 88, "the expected inventory is not 88 distinct names")
  expect(mcpFrames > probesBeforeWire, "discovery and listing never reached the agent")
  const noMeta = await fetch(resource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", authorization: `Bearer ${tokensA.access}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })
  expect(noMeta.status === 400, `a request without metadata returned ${noMeta.status}`)
  const mismatchedMethod = await mcpPost(tokensA.access, "tools/list", {}, { "mcp-method": "tools/call" })
  expect(mismatchedMethod.status === 400, `a mismatched method header returned ${mismatchedMethod.status}`)
  const oldVersion = await mcpPost(tokensA.access, "tools/list", {}, { "mcp-protocol-version": "2025-06-18" })
  expect(oldVersion.status === 400, `an unsupported protocol version returned ${oldVersion.status}`)
  const schemaFailure = await call("session_get", { sessionID: "ses_mcp_seed", extra: true })
  expect(schemaFailure.isError, "an input with an unknown property was accepted")
  checks.push("the real SDK client discovered and listed exactly the 88 tools; missing metadata, a mismatched method header, and an unsupported version returned 400; schema failures were tool errors")

  const workspaces = dataOf((await call("workspace_list")).value)
  const recorded = Array.isArray(workspaces) ? workspaces.find((item) => isRecord(item) && item.directory === workspace) : undefined
  expect(isRecord(recorded) && typeof recorded.id === "string", `the recorded workspace was not listed: ${JSON.stringify(workspaces)}`)
  if (!isRecord(recorded) || typeof recorded.id !== "string") throw new Error("unreachable")
  const createdID = "ses_mcp_created"
  const created = await call("session_create", { input: { id: createdID, workspace: recorded.id } })
  expect(!created.isError && isRecord(dataOf(created.value)) && (dataOf(created.value) as Record<string, unknown>).id === createdID, `recorded-workspace create failed: ${created.text}`)
  const retried = await call("session_create", { input: { id: createdID, workspace: recorded.id } })
  expect(!retried.isError, `an exact create retry failed: ${retried.text}`)
  expect((await call("session_create", { input: { id: "ses_mcp_missing", workspace: "wsp_missing" } })).isError, "a create for an unknown workspace succeeded")
  expect((await call("session_create", { input: { workspace: recorded.id } })).isError, "a create without a client id succeeded")
  expect((await local.listPage({ limit: 100 })).data.filter((info) => info.id === createdID).length === 1, "an idempotent create made a second Session")

  providerFollowUpText = `MCP prompt reply ${crypto.randomUUID()}`
  providerTurn = { text: providerFollowUpText }
  const promptID = "msg_mcp_prompt"
  const promptInput = { id: promptID, text: `Plain MCP prompt ${marker}` }
  expect((await call("session_prompt", { sessionID: createdID, input: promptInput })).isError === false, "the prompt was refused")
  await waitFor(async () => JSON.stringify(await local.messages(createdID, location)).includes(providerFollowUpText) ? true : undefined, 30_000,
    "the prompted Session never produced the stand-in reply")
  expect((await call("session_prompt", { sessionID: createdID, input: promptInput })).isError === false, "an exact prompt retry was refused")
  expect((await local.messages(createdID, location)).filter((message) => message.id === promptID).length === 1, "the prompt retry created a second user message")
  expect((await call("session_prompt", { sessionID: createdID, input: { text: "no client id" } })).isError, "a prompt without a client id was accepted")
  const snapshot = await call("session_snapshot", { sessionID: createdID, input: { limit: 50 } })
  expect(!snapshot.isError && JSON.stringify(snapshot.value).includes(providerFollowUpText), "the snapshot omitted the settled reply")
  checks.push("recorded-workspace create, exact create and prompt retries, client-id requirements, and a settled snapshot all ran through the relay")

  const runShell = async (id: string, command: string, followUp: string) => {
    providerFollowUpText = followUp
    providerTurn = { tool: { id: `call_${id}`, name: "shell", input: { command } }, text: "", prompt: `run ${id}` }
    const sent = await call("session_prompt", { sessionID: createdID, input: { id: `msg_${id}`, text: `run ${id}` } })
    expect(!sent.isError, `the ${id} prompt was refused: ${sent.text}`)
  }
  const pendingPermission = async () => {
    const listedPermissions = dataOf((await call("session_permission_list", { sessionID: createdID })).value)
    const row = Array.isArray(listedPermissions) ? listedPermissions.find((item) => isRecord(item) && item.action === "shell" && typeof item.id === "string") : undefined
    return isRecord(row) && typeof row.id === "string" ? row.id : undefined
  }
  const settled = (text: string) => async () => JSON.stringify(await local.messages(createdID, location)).includes(text) ? true : undefined

  for (const permissions of ["yolo", "manual"]) {
    const result = await call("session_autonomy_set", { sessionID: createdID, input: { permissions } })
    expect(!result.isError, `Permissions mode ${permissions} was refused: ${result.text}`)
  }
  for (const input of [{ permissions: true }, { permissions: 2 }, { yolo: true }, { autoPermission: true }, { permissions: "auto", sleep: true }])
    expect((await call("session_autonomy_set", { sessionID: createdID, input })).isError === true,
      `invalid autonomy input was accepted: ${JSON.stringify(input)}`)
  const permissionSet = await call("session_autonomy_set", { sessionID: createdID, input: { permissions: "auto" } })
  expect(!permissionSet.isError, `Auto permissions were refused: ${permissionSet.text}`)
  const autonomy = dataOf((await call("session_autonomy_get", { sessionID: createdID })).value)
  expect(isRecord(autonomy) && autonomy.permissions === "auto" && autonomy.guardrails === "manual" && autonomy.answers === "manual",
    "auto permissions changed the independent guardrails or answers mode")
  await runShell("auto_permission", "touch mcp-auto-permission.txt", "Reply after the rule-approved shell call.")
  await waitFor(() => (existsSync(join(workspace, "mcp-auto-permission.txt")) ? true : undefined), 30_000,
    "auto-permission did not approve the ask-permission shell call")
  await waitFor(settled("Reply after the rule-approved shell call."), 30_000, "the rule-approved step did not settle")
  expect((await call("session_autonomy_set", { sessionID: createdID, input: { permissions: "manual" } })).isError === false,
    "auto permissions could not be reset to manual")
  checks.push("auto-permission set through MCP approved an ask-permission shell call independently of guardrails and answers")

  await runShell("always_one", "touch mcp-always.txt", "Reply after Always approval one.")
  const alwaysRequest = await waitFor(pendingPermission, 30_000, "no shell permission request was raised for the Always case")
  expect(!existsSync(join(workspace, "mcp-always.txt")), "the shell command ran before it was approved")
  expect(!(await call("session_permission_reply", { sessionID: createdID, input: { requestID: alwaysRequest, reply: "always" } })).isError, "the Always reply was refused")
  await waitFor(() => (existsSync(join(workspace, "mcp-always.txt")) ? true : undefined), 30_000, "the Always-approved command did not run")
  await waitFor(settled("Reply after Always approval one."), 30_000, "the Always-approved step did not settle")
  await runShell("always_two", "touch mcp-always.txt", "Reply after Always approval two.")
  let askedAgain = false
  await waitFor(async () => {
    if ((await pendingPermission()) !== undefined) askedAgain = true
    return (await settled("Reply after Always approval two.")()) === true ? true : undefined
  }, 30_000, "the repeated command did not settle after an Always approval")
  expect(!askedAgain, "the persistent Always approval did not cover the repeated command")
  checks.push("permission Always replied through MCP persisted: the repeated command raised no second request")

  const guardID = "ses_mcp_guard"
  expect(!(await call("session_create", { input: { id: guardID, workspace: recorded.id, agent: "flow-guard" } })).isError, "the guardrail Session was not created")
  providerFollowUpText = "Reply after the guardrail review."
  providerTurn = { tool: { id: "call_guard", name: "shell", input: { command: "touch ordinary-allowed.txt" } }, text: "", prompt: "run guard" }
  expect(!(await call("session_prompt", { sessionID: guardID, input: { id: "msg_guard", text: "run guard" } })).isError, "the guardrail prompt was refused")
  const review = await waitFor(async () => {
    const reviews = dataOf((await call("session_guardrail_request_list", { sessionID: guardID })).value)
    const row = Array.isArray(reviews) ? reviews.find((item) => isRecord(item) && typeof item.id === "string" && JSON.stringify(item.resources ?? []).includes("ordinary-allowed")) : undefined
    return isRecord(row) && typeof row.id === "string" ? row.id : undefined
  }, 30_000, "no guardrail review was raised through MCP")
  expect(!existsSync(join(workspace, "ordinary-allowed.txt")), "the reviewed command ran before the reply")
  expect(!(await call("session_guardrail_reply", { sessionID: guardID, input: { requestID: review, reply: "once" } })).isError, "the guardrail reply was refused")
  await waitFor(() => (existsSync(join(workspace, "ordinary-allowed.txt")) ? true : undefined), 30_000, "the approved guardrail command did not run")
  checks.push("guardrail review listed and answered once through MCP ran the reviewed command")

  providerMode = "hold"
  providerTurn = { text: "Held until interrupted.", prompt: "hold the stream open" }
  expect(!(await call("session_prompt", { sessionID: createdID, input: { id: "msg_mcp_hold", text: "hold the stream open" } })).isError, "the hold prompt was refused")
  await waitFor(() => (releaseStream !== undefined ? true : undefined), 30_000, "the held step never reached the provider")
  expect(!(await call("session_interrupt", { sessionID: createdID })).isError, "the interrupt was refused")
  releaseStream?.()
  releaseStream = undefined
  await waitFor(async () => {
    const active = await local.activeSessions()
    return isRecord(active) && !(createdID in active) ? true : undefined
  }, 30_000, "the interrupted Session stayed active")
  providerMode = "instant"
  checks.push("interrupt through MCP stopped the running step on the real server")


  const sessionIDs = async () => new Set((await local.listPage({ limit: 200 })).data.map((info) => info.id))
  const folderOk = await call("session_create_in_directory", { input: { id: "ses_mcp_folder", directory: approvedDirectory } })
  expect(!folderOk.isError && JSON.stringify(folderOk.value).includes(approvedDirectory), `a directory below home was refused: ${folderOk.text}`)
  expect(!(await call("session_create_in_directory", { input: { id: "ses_mcp_folder", directory: approvedDirectory } })).isError, "an exact folder-create retry failed")
  const before = await sessionIDs()
  const refusals: [string, string][] = [
    ["ses_mcp_home", mcpHome], ["ses_mcp_missing_dir", join(mcpHome, "missing")], ["ses_mcp_outside", outside],
    ["ses_mcp_traversal", `${mcpHome}/projects/../../outside`], ["ses_mcp_symlink", join(mcpHome, "link-out")],
    ["ses_mcp_symlink_inner", join(mcpHome, "link-out", "inner")], ["ses_mcp_file", join(mcpHome, "file.txt")],
  ]
  for (const [id, directory] of refusals)
    expect((await call("session_create_in_directory", { input: { id, directory } })).isError, `${directory} was accepted as a directory below home`)
  const after = await sessionIDs()
  expect(refusals.every(([id]) => !after.has(id)) && after.size === before.size, "a refused directory created a Session")
  expect(!existsSync(join(mcpHome, "missing")), "a refused directory was created")
  expect((await call("session_create", { input: { id: "ses_mcp_browser_rule", workspace: approvedDirectory } })).isError, "the recorded-workspace create accepted an arbitrary directory")
  checks.push("a directory below home was accepted (idempotently); home, missing, outside, traversal, escaping symlinks, and a file were refused without creating a Session or directory; the recorded-workspace create still refuses arbitrary directories")


  const probeStatuses: string[] = []
  const probe = createRemoteTransport({
    url: `${socketOrigin}${RemoteWebSocketPath.client}?device=${deviceID}`,
    handlers: { onStatus: (status) => probeStatuses.push(JSON.stringify(status)) },
    createSocket: (url) => new WebSocket(url, { headers: { cookie: ownerCookie, origin: workerOrigin } }),
  })
  disposals.push(async () => probe.close(1000, "flow complete"))
  probe.connect()
  const probeRequest = async (operation: Parameters<typeof probe.request>[0], request?: Parameters<typeof probe.request>[1]) => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const outcome = await probe.request(operation, request)
      if (outcome.status !== "unavailable" || outcome.reason !== "not-connected" || Date.now() >= deadline) return outcome
      await Bun.sleep(100)
    }
  }
  expect((await probeRequest("session.list", { input: { limit: 5 } })).status === "ok", "the browser probe could not list Sessions before the pending MCP request")
  providerMode = "hold"
  providerTurn = { text: "Draft held by the stand-in." }
  const requestsBefore = providerRequests.length
  let pendingSettled = false
  const pendingCall = call("session_prompt_generate", { sessionID: createdID, input: { mode: "start", intent: "Draft a harmless greeting", memory: [] } })
    .finally(() => { pendingSettled = true })
  await waitFor(() => (providerRequests.length > requestsBefore && releaseStream !== undefined ? true : undefined), 30_000,
    "the pending MCP operation never reached the model; choose another long-running operation for this check")
  const browserList = await Promise.race([probeRequest("session.list", { input: { limit: 5 } }), Bun.sleep(10_000).then(() => "timeout" as const)])
  expect(browserList !== "timeout" && browserList.status === "ok" && !pendingSettled, "the browser Session list did not complete while the MCP request was pending")
  releaseStream?.()
  releaseStream = undefined
  providerMode = "instant"
  await pendingCall
  checks.push("a browser Session list completed while an MCP operation was pending at the model")


  const largeID = "ses_mcp_large"
  await createSession(server, largeID, workspace, { providerID, id: providerModel })
  const bulk = (index: number) => local.prompt(largeID, location, { id: `msg_mcp_large_${index}`, text: `${marker} ${"x".repeat(32_000)}`, resume: false })
  for (let index = 0; index < 12; index++) await bulk(index)
  const large = await call("session_pending_list", { sessionID: largeID })
  const largeData = dataOf(large.value)
  expect(!large.isError && Array.isArray(largeData) && largeData.length === 12 && large.text.length > RemoteLimits.maxAgentMessageChars,
    `a multi-frame result did not arrive complete: ${large.isError ? large.text : large.text.length}`)
  for (let index = 12; index < 72; index++) await bulk(index)
  const tooLarge = await call("session_pending_list", { sessionID: largeID })
  expect(tooLarge.isError && errorCodeOf(tooLarge.value) === "message_too_large", `an oversized result did not fail explicitly: ${tooLarge.text.slice(0, 200)}`)
  checks.push("a result spanning several relay chunks arrived complete; an oversized result failed explicitly with message_too_large")


  const probesBeforeOff = mcpFrames
  const disabled = await host.set(false)
  expect(disabled.state === "off", `disabling MCP reported ${JSON.stringify(disabled)}`)
  const offRow = await deviceRow()
  expect(offRow?.enabled === 0 && offRow.enable_epoch === host.advertisement().epoch, "the relay did not record the retired epoch")
  const probesAfterOff = mcpFrames
  expect(offRow?.enable_epoch !== onRow?.enable_epoch, "turning MCP off did not retire the enable epoch")
  expect(await countOf(`SELECT count(*) AS n FROM mcp_grant WHERE device_id = ${quoted(deviceID)}`) === 0, "turning MCP off left grants for the device")
  expect(await orphanedCredentials() === 0, "turning MCP off left codes or tokens without a grant")
  const refusedOff = await mcpPost(tokensA.access, "tools/list", {})
  expect([401, 403, 503].includes(refusedOff.status), `a bearer was served while MCP was off (${refusedOff.status})`)
  const refreshOff = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokensA.refresh, client_id: clientA.id, resource })
  expect(refreshOff.status === 400 && errorOf(refreshOff.body) === "invalid_grant", "a refresh succeeded after MCP was turned off")
  const authorizeOff = await authorizeRequest(clientA, pkce().challenge, "off-again")
  expect(!(await hasForm(authorizeOff, "/api/mcp/oauth/login")), "authorization succeeded while MCP was off")
  expect(mcpFrames === probesAfterOff && probesAfterOff >= probesBeforeOff, "a refused request reached the agent while MCP was off")
  const reenabled = await host.set(true)
  expect(reenabled.state === "on", `re-enabling MCP reported ${JSON.stringify(reenabled)}`)
  const reenabledRow = await deviceRow()
  expect(reenabledRow?.enabled === 1 && reenabledRow.enable_epoch === host.advertisement().epoch && reenabledRow.enable_epoch !== offRow?.enable_epoch,
    "re-enabling MCP did not open a new epoch")
  const stillRefused = await mcpPost(tokensA.access, "tools/list", {})
  expect(stillRefused.status === 401, `a pre-off bearer was accepted after re-enabling (${stillRefused.status})`)
  const refreshedAfter = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokensA.refresh, client_id: clientA.id, resource })
  expect(refreshedAfter.status === 400, "a pre-off refresh token was accepted after re-enabling")
  const tokensC = await obtainTokens(clientA)
  expect((await mcpPost(tokensC.access, "tools/list", {})).status === 200, "a fresh consent after off/on did not issue a working bearer")
  checks.push("turning MCP off removed grants (access and refresh refused, no agent frames); turning it on again required fresh consent")


  await agent?.close()
  const probesAtClose = mcpFrames
  const disconnected = await mcpPost(tokensC.access, "tools/list", {})
  expect(disconnected.status >= 500 && disconnected.status < 600, `a request to a disconnected device returned ${disconnected.status}`)
  expect(mcpFrames === probesAtClose, "a request reached the agent after it disconnected")
  await startAgent()
  await waitFor(() => (host.status().state === "on" ? true : undefined), 20_000, "the host did not report on after reconnecting")
  await waitFor(async () => ((await mcpPost(tokensC.access, "tools/list", {})).status === 200 ? true : undefined), 20_000,
    "the grant did not survive an ordinary reconnect with the same epoch")
  checks.push("a disconnected device was refused without reaching the agent; an ordinary reconnect with the same epoch preserved the grant")

  const revoked = await paced("token", "/api/mcp/oauth/revoke", formInit({ token: tokensC.refresh, client_id: clientA.id }))
  expect(revoked.status === 200, `revocation returned ${revoked.status}`)
  expect((await mcpPost(tokensC.access, "tools/list", {})).status === 401, "a revoked grant's access token was accepted")
  const unknownRevoke = await paced("token", "/api/mcp/oauth/revoke", formInit({ token: "unknown-token", client_id: clientA.id }))
  expect(unknownRevoke.status === 200, `revoking an unknown token returned ${unknownRevoke.status}`)
  checks.push("revocation invalidated the grant; an unknown credential revoked with success")


  const tokensD = await obtainTokens(clientA)
  expect((await mcpPost(tokensD.access, "tools/list", {})).status === 200, "a fresh grant was not usable before device revocation")
  expect(await countOf(`SELECT count(*) AS n FROM mcp_grant WHERE device_id = ${quoted(deviceID)}`) > 0, "no grant existed before device revocation")
  expect((await http.revokeDevice(deviceID)).ok, "the primary device could not be revoked")
  expect([401, 403, 503].includes((await mcpPost(tokensD.access, "tools/list", {})).status), "a bearer survived device revocation")
  const afterRevoke = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokensD.refresh, client_id: clientA.id, resource })
  expect(afterRevoke.status === 400, "a refresh succeeded after device revocation")
  expect(await countOf(`SELECT count(*) AS n FROM mcp_grant WHERE device_id = ${quoted(deviceID)}`) === 0, "device revocation left grants")
  expect((await http.removeRevokedDevices(deviceID)).ok, "the revoked device could not be removed")
  for (const table of ["mcp_device", "mcp_grant", "mcp_authorization"])
    expect(await countOf(`SELECT count(*) AS n FROM ${table} WHERE device_id = ${quoted(deviceID)}`) === 0, `${table} kept rows for a removed device`)
  expect(await orphanedCredentials() === 0, "removing the device left codes or tokens without a grant")
  checks.push("device revocation removed grants and rejected the bearer; removing the device cascaded through mcp_device, mcp_grant, mcp_authorization, codes, and tokens")


  const scan = await markerRowCount(persist, marker)
  expect(scan.scanned > 0 && scan.matches === 0, `the synthetic prompt marker was found in local D1: ${scan.locations.join(", ")} (scanned ${scan.scanned} text columns)`)
  expect(JSON.stringify(await local.messages(createdID, location)).includes(marker), "the synthetic marker never reached the local Session")
  checks.push(`every D1 text column (${scan.scanned}) held zero rows containing the synthetic prompt marker`)
  notExercised.push("Durable Object storage is not queried by the D1 scan; Worker request logs are not scanned")
  notExercised.push("Real Google consent, deployment, production D1 migration, rendered consent pixels, and a ChatGPT connection round trip are out of scope")

  console.log(`MCP flow passed ${checks.length} checks:\n- ${checks.join("\n- ")}`)
  if (notExercised.length > 0) console.log(`Not exercised:\n- ${notExercised.join("\n- ")}`)
} catch (cause) {
  console.error(cause)
  console.error(`Checks passed before the failure:\n- ${checks.join("\n- ")}`)
  process.exitCode = 1
} finally {
  for (const dispose of disposals.reverse()) await dispose().catch(() => undefined)
  wrangler?.kill("SIGTERM")
  if (wrangler) await wrangler.exited
  google?.stop(true)
  if (home) await rm(home, { recursive: true, force: true })
  if (diagnostics.length > 0) console.log(`agent diagnostics: ${diagnostics.slice(-6).join(" | ")}`)
}

async function waitForWorker(): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${workerOrigin}/health`)).status === 200) return
    } catch {
      await Bun.sleep(500)
      continue
    }
    await Bun.sleep(500)
  }
  throw new Error("wrangler dev did not become ready")
}
