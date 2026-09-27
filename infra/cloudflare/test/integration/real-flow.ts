/**
 * Composed real-flow proof.
 *
 * Joins the real components instead of one faked side:
 *
 * - real isolated YCoding server (`ServerProcess`, in-memory DB, private config)
 * - real CLI local adapter (`createLocalServer`) and the real `RemoteAgent` bridge,
 *   dialing out with the production transport and a `Bearer` device credential
 * - real browser client: `apps/web` `createRemoteStore` + `createRemoteHttp` +
 *   `createRemoteTransport` pointed at the loopback relay
 * - real relay: `wrangler dev` with real D1, the real `DeviceRelay` Durable Object,
 *   the built static assets, and a local Google OIDC stand-in
 *
 * The model boundary is a stand-in: an OpenAI-compatible SSE endpoint on localhost
 * (fixed text, plus a hold mode used for the interrupt proof). Provider identity,
 * quotas, retries, and real vendor payloads are not exercised. The exact-id
 * admission proof deliberately admits with `resume: false` so admission semantics
 * are isolated from execution; the execution proof runs real SessionRunner steps,
 * including provider-emitted shell and question tool calls. No deployment, no real
 * credentials, no network beyond 127.0.0.1.
 *
 * Usage: bun infra/cloudflare/test/integration/real-flow.ts
 */

import { spawn } from "bun"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { crc32 } from "node:zlib"
import { createSession, password, startServer } from "../../../../packages/cli/test/remote-harness"
import { createLocalServer } from "../../../../packages/cli/src/remote-local"
import { RemoteAgent } from "../../../../packages/cli/src/remote-bridge"
import { RemoteLimits, RemoteWebSocketPath } from "../../../../packages/remote/src/index"
import {
  enroll,
  generateDeviceKey,
  Identity,
  RemoteCredentials,
} from "../../../../packages/cli/src/remote-credentials"
import { createRemoteHttp } from "../../../../apps/web/src/remote/http"
import { createPushHttp } from "../../../../apps/web/src/remote/http"
import { generateVapidKeys } from "../../script/vapid-keys"
import { createRemoteStore } from "../../../../apps/web/src/remote/store"
import { createRemoteTransport, type RemoteTransportStatus } from "../../../../apps/web/src/remote/transport"
import { base64UrlEncode } from "../../src/auth/crypto"
import { deltaChunk, finishChunk, toolCallChunk } from "../../../../packages/ai/test/lib/openai-chunks"
import { Global } from "../../../../packages/core/src/global"

const repositoryRoot = new URL("../../../../", import.meta.url).pathname
const wranglerBin = `${repositoryRoot}node_modules/.bin/wrangler`
const configPath = "infra/cloudflare/wrangler.jsonc"
const workerPort = 8807
const workerOrigin = `http://127.0.0.1:${workerPort}`
const socketOrigin = `ws://127.0.0.1:${workerPort}`
const allowedEmail = "flow@example.invalid"
const sessionID = "ses_real_flow_shared"
const hiddenSessionID = "ses_real_flow_hidden"
const promptID = "msg_real_flow_prompt"
const otherPromptID = "msg_real_flow_other"
const executionPromptID = "msg_real_flow_execute"
const providerID = "flow-local"
const providerModel = "flow-model"
const providerText = "Local stand-in reply: the composed flow executes."
const guardSessionID = "ses_real_flow_guard"

const checks: string[] = []
const diagnostics: string[] = []
let wrangler: { kill: (signal?: NodeJS.Signals) => unknown; exited: Promise<number> } | undefined
let google: { stop: (closeActive?: boolean) => unknown } | undefined
let agent: RemoteAgent | undefined
let disposals: (() => Promise<void>)[] = []
let home: string | undefined

try {
  await mkdir(join(repositoryRoot, ".cache/tmp"), { recursive: true })
  home = await mkdtemp(join(repositoryRoot, ".cache/tmp/ycoding-real-flow-"))
  const workspace = join(home, "workspace")
  const openedWorkspace = join(home, "opened-only")
  const serverConfig = join(home, "server-config")
  const persist = join(home, "wrangler-state")
  await run("mkdir", ["-p", workspace, serverConfig, openedWorkspace])
  await Bun.write(join(openedWorkspace, "find-this.txt"), "Catalog file search")

  /* -------------------------------------- deterministic local provider stand-in */

  // The model boundary is a stand-in: an OpenAI-compatible SSE endpoint on
  // localhost. Everything else in this flow is production code.
  const providerRequests: unknown[] = []
  let providerMode: "instant" | "hold" = "instant"
  let releaseStream: (() => void) | undefined
  // One scripted tool call per prompt, then plain text for the follow-up turn.
  let providerTurn: {
    readonly tool?: { readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
    readonly text: string
  } = {
    text: providerText,
  }
  const providerShellCalls: { readonly id: string; readonly command: string }[] = []
  let providerFollowUpText = providerText
  const stub = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      providerRequests.push(await request.json())
      const encoder = new TextEncoder()
      const turn = providerTurn
      providerTurn = { text: providerFollowUpText }
      const frames = turn.tool === undefined
        ? [deltaChunk({ role: "assistant" }), deltaChunk({ content: turn.text }), finishChunk("stop")]
        : (() => {
            if (turn.tool.name === "shell" && typeof turn.tool.input.command === "string")
              providerShellCalls.push({ id: turn.tool.id, command: turn.tool.input.command })
            return [
              toolCallChunk(turn.tool.id, turn.tool.name, JSON.stringify(turn.tool.input)),
              finishChunk("tool_calls"),
            ]
          })()
      const hold = providerMode === "hold" && turn.tool === undefined
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

  // The isolated server reads its provider document from an isolated global config
  // directory, so no user configuration or credential participates.
  process.env.YCODING_CONFIG_DIR = serverConfig
  await Bun.write(
    join(serverConfig, "ycoding.json"),
    JSON.stringify({
      model: `${providerID}/${providerModel}`,
      default_agent: "flow-approval",
      agents: {
        "flow-approval": {
          description: "Composed-flow approval agent: every shell call asks.",
          mode: "primary",
          permissions: [{ action: "shell", resource: "*", effect: "ask" }],
        },
        "flow-guard": {
          // Tool permission is granted here so the guardrail review is the only
          // gate under test; guardrails are independent of tool permissions.
          description: "Composed-flow guardrail agent: shell allowed, guardrail rules decide.",
          mode: "primary",
          permissions: [{ action: "shell", resource: "*", effect: "allow" }],
        },
        "flow-child": {
          description: "Composed-flow managed child for Team controls.",
          mode: "subagent",
        },
      },
      providers: {
        [providerID]: {
          package: "aisdk:@ai-sdk/openai-compatible",
          name: "Flow Local Stand-in",
          settings: { baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: "flow-stand-in-key" },
          models: { [providerModel]: { name: "Flow Model" } },
        },
      },
    }),
  )

  /* ---------------------------------------------------- real local server */

  // Custom guardrail rules: an ordinary review for one harmless command and a
  // hard review for another. Every command below is a harmless `touch` inside the
  // temporary workspace; nothing destructive is ever executed.
  await run("mkdir", ["-p", join(serverConfig, "guardrails")])
  await Bun.write(
    join(serverConfig, "guardrails", "flow-ordinary.md"),
    [
      "---",
      "id: flow.guard.ordinary",
      "decision: ask",
      "actions: [shell]",
      'resources: ["*ordinary-allowed*"]',
      "reason: Composed-flow ordinary review",
      "priority: 10",
      "---",
      "",
      "Composed-flow ordinary guardrail rule.",
      "",
    ].join("\n"),
  )
  await Bun.write(
    join(serverConfig, "guardrails", "flow-hard.md"),
    [
      "---",
      "id: flow.guard.hard",
      "decision: hard_review",
      "actions: [shell]",
      'resources: ["*hard-*"]',
      "reason: Composed-flow hard review",
      "priority: 20",
      "---",
      "",
      "Composed-flow hard guardrail rule.",
      "",
    ].join("\n"),
  )

  const server = await startServer(serverConfig)
  disposals.push(() => server.close())
  // The shared session runs under the approval agent, so a shell tool call raises a
  // real pending permission request instead of running unprompted.
  const sharedSession = await server.request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: sessionID,
      location: { directory: workspace },
      model: { providerID, id: providerModel },
      agent: "flow-approval",
    }),
  })
  expect(sharedSession.status === 200, `approval session create returned ${sharedSession.status}`)
  await createSession(server, hiddenSessionID, workspace, { providerID, id: providerModel })
  const guardSession = await server.request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: guardSessionID,
      location: { directory: workspace },
      model: { providerID, id: providerModel },
      agent: "flow-guard",
    }),
  })
  expect(guardSession.status === 200, `guardrail session create returned ${guardSession.status}`)
  checks.push("real isolated YCoding server created two durable sessions")

  const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
  const opened = await server.request("/api/location", {
    headers: { "x-ycoding-directory": encodeURIComponent(openedWorkspace) },
  })
  expect(opened.status === 200, `opening a workspace returned ${opened.status}`)
  const localSessions = await local.listPage({ limit: 50 })
  expect(!localSessions.data.some((info) => info.location.directory === openedWorkspace), "opening a directory created a Session")
  expect(
    localSessions.data.some((info) => info.id === sessionID),
    "the real server did not return the created session to the CLI adapter",
  )

  /* ---------------------------------------------------------- relay + google */

  const identityKey = await rsaIdentity()
  const idTokenHolder: { value: string } = { value: "" }
  google = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/token") return Response.json({ id_token: idTokenHolder.value, access_token: "access-token" })
      if (url.pathname === "/certs") return Response.json({ keys: [identityKey.jwk] })
      return new Response("not found", { status: 404 })
    },
  })
  const googleOrigin = `http://127.0.0.1:${google.port}`
  const vapid = await generateVapidKeys()

  await run(wranglerBin, ["d1", "migrations", "apply", "ycoding-prod-db", "--local", "--config", configPath, "--persist-to", persist])
  // Refuse to silently reuse a stale dev server on this port: the proof must run
  // against the worker started by this process.
  const occupied = await fetch(`${workerOrigin}/health`).then(
    () => true,
    () => false,
  )
  expect(!occupied, `port ${workerPort} already serves the relay; stop the other dev server first`)
  wrangler = spawn(
    [
      wranglerBin,
      "dev",
      "--config",
      configPath,
      "--persist-to",
      persist,
      "--port",
      String(workerPort),
      "--var",
      "GOOGLE_CLIENT_ID:flow-client",
      "--var",
      "GOOGLE_CLIENT_SECRET:flow-secret",
      "--var",
      `GOOGLE_ALLOWED_EMAILS:${allowedEmail}`,
      "--var",
      "CLEANUP_INTERVAL_MS:86400000",
      "--var",
      `GOOGLE_ISSUER:${googleOrigin}`,
      "--var",
      `GOOGLE_AUTHORIZATION_ENDPOINT:${googleOrigin}/authorize`,
      "--var",
      `GOOGLE_TOKEN_ENDPOINT:${googleOrigin}/token`,
      "--var",
      `GOOGLE_JWKS_URI:${googleOrigin}/certs`,
      "--var", `VAPID_PUBLIC_KEY:${vapid.VAPID_PUBLIC_KEY}`,
      "--var", `VAPID_PRIVATE_KEY:${vapid.VAPID_PRIVATE_KEY}`,
      "--var", "VAPID_SUBJECT:mailto:push@example.invalid",
    ],
    { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" },
  )
  await waitForWorker()

  /* --------------------------------------------------- browser sign-in (real) */

  let cookie = ""
  const browserFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    if (cookie !== "") headers.set("cookie", cookie)
    headers.set("origin", workerOrigin)
    headers.set("sec-fetch-site", "same-origin")
    return fetch(input, { ...init, headers })
  }

  const started = await fetch(`${workerOrigin}/api/auth/google/start?redirect_after=/remote/`, { redirect: "manual" })
  const oauthCookie = setCookiePair(started, "yc_oauth")
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const nonce = await readNonce(await sha256Hex(cookieValue(oauthCookie)), persist)
  expect(nonce.length > 0, "OAuth transaction was not found in the isolated local D1 state")
  const issuedAt = Math.floor(Date.now() / 1000)
  idTokenHolder.value = await signedIdToken(identityKey.pair, {
    iss: googleOrigin,
    aud: "flow-client",
    sub: `flow-subject-${crypto.randomUUID()}`,
    iat: issuedAt,
    exp: issuedAt + 3600,
    nonce,
    email: allowedEmail,
    email_verified: true,
  })
  const callback = await fetch(`${workerOrigin}/api/auth/google/callback?code=flow-code&state=${state}`, {
    headers: { cookie: oauthCookie },
    redirect: "manual",
  })
  expect(
    callback.headers.get("location") === "/remote/",
    "Google callback refused sign-in",
  )
  cookie = cookiePair(callback, "yc_session")
  expect(cookie.includes("yc_session="), "Google sign-in did not issue a browser session")
  checks.push("browser signed in through the real relay with a Google stand-in")

  const pushHttp = createPushHttp({ baseURL: workerOrigin, fetch: browserFetch })
  const pushKey = await pushHttp.key()
  expect(pushKey.ok && pushKey.value.publicKey === vapid.VAPID_PUBLIC_KEY, "the authenticated push key route did not return this deployment's public key")
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!(receiver instanceof Object) || !("publicKey" in receiver)) throw new Error("ECDH pair unavailable")
  const endpoint = "https://fcm.googleapis.com/fcm/send/flow-local-only"
  const registeredPush = await pushHttp.subscribe({ endpoint, keys: {
    p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  } })
  expect(registeredPush.ok, `the authenticated push subscription was not stored in local D1: ${JSON.stringify(registeredPush)}`)
  expect((await pushHttp.remove(endpoint)).ok, "the authenticated push subscription was not removed")
  checks.push("push key, subscription, and removal reached the real Worker and local D1")

  /* --------------------------------------------------- real browser store */

  const http = createRemoteHttp({ baseURL: workerOrigin, fetch: browserFetch })
  const events: unknown[] = []
  const clientSockets: WebSocket[] = []
  const browserStatuses: RemoteTransportStatus[] = []
  const store = createRemoteStore({
    http,
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({
        url: `${socketOrigin}${RemoteWebSocketPath.client}?device=${deviceID}`,
        handlers: {
          ...handlers,
          onStatus: (status) => {
            browserStatuses.push(status)
            handlers.onStatus?.(status)
          },
          onEvent: (eventSessionID, event) => {
            events.push({ sessionID: eventSessionID, event })
            handlers.onEvent?.(eventSessionID, event)
          },
        },
        createSocket: (url) => {
          const socket = new WebSocket(url, { headers: { cookie, origin: workerOrigin } })
          clientSockets.push(socket)
          return socket
        },
      }),
    now: () => Date.now(),
  })
  disposals.push(async () => store.dispose())

  await store.load()
  // No devices are enrolled yet, so the store reports no live connection; the
  // signed-in signal is the owner the relay returned for the browser session.
  expect(store.state().owner?.id.startsWith("usr_") === true, "the store is not signed in after the OAuth flow")
  expect(store.state().devices.length === 0, "a fresh owner already had devices")


  const enrollment = await store.createEnrollment()
  expect(enrollment.ok, "the browser store could not mint an enrollment code")
  if (!enrollment.ok) throw new Error(enrollment.message)
  checks.push("browser store minted a one-use enrollment code through the relay")

  /* ----------------------------------------------------- real CLI enrollment */

  const device = await generateDeviceKey()
  const enrolled = await enroll({
    relayURL: workerOrigin,
    enrollmentID: enrollment.value.enrollmentID,
    code: enrollment.value.code,
    name: "Composed Flow Device",
    privateKey: device.privateKey,
    publicKey: device.publicKey,
  })
  const identity = Identity.make({
    deviceID: enrolled.deviceID,
    name: "Composed Flow Device",
    relayURL: workerOrigin,
    publicKey: device.publicKey,
    privateKey: device.privateKey,
    enrolledAt: Date.now(),
  })
  expect(identity.relayURL === workerOrigin, "the CLI identity was not bound to the relay origin")
  checks.push("real CLI credential module enrolled the device against the real relay")

  // The credential orchestrator is an Effect that persists through Global and
  // FileSystem. Those modules are reached through `createRequire` anchored to the
  // CLI package (the repo's existing pattern), so the harness runs the real
  // challenge/refresh/persistence path without adding a dependency.
  const cliRequire = createRequire(join(repositoryRoot, "packages/cli/package.json"))
  const effectModule = (await import(cliRequire.resolve("effect"))) as {
    readonly Effect: {
      readonly runPromise: (value: unknown) => Promise<never>
      readonly provide: (layer: unknown) => (self: unknown) => unknown
    }
    readonly Layer: { readonly mergeAll: (layers: readonly unknown[]) => unknown }
  }
  const platformModule = (await import(cliRequire.resolve("@effect/platform-node"))) as {
    readonly NodeFileSystem: { readonly layer: unknown }
  }
  const cliState = join(home, "cli-state")
  await run("mkdir", ["-p", cliState])
  const credentialLayer = effectModule.Layer.mergeAll(
    Global.layerWith({ state: cliState, config: serverConfig, home }),
    platformModule.NodeFileSystem.layer,
  )
  const runEffect = (effect: unknown): Promise<unknown> =>
    effectModule.Effect.runPromise(effectModule.Effect.provide(credentialLayer)(effect))
  await runEffect(RemoteCredentials.create(identity))
  expect(existsSync(join(cliState, RemoteCredentials.filename)), "the CLI identity file was not written")

  const credentials = async (): Promise<{ accessToken: string; accessExpiresAt: number }> => {
    const stored = (await runEffect(RemoteCredentials.read())) as
      | { readonly deviceID: string }
      | undefined
    if (stored === undefined) throw new Error("the stored device identity disappeared")
    const rotated = (await runEffect(RemoteCredentials.credentials(stored))) as {
      readonly accessToken: string
      readonly accessExpiresAt: number
    }
    return rotated
  }

  agent = new RemoteAgent({
    relayURL: workerOrigin,
    local,
    credentials,
    refreshIntervalMs: 3_600_000,
    onDiagnostic: (message) => diagnostics.push(message),
    onTerminal: (message) => diagnostics.push(`terminal: ${message}`),
  })
  disposals.push(async () => agent?.close())
  await agent.connect()
  await waitFor(() => (agent?.currentState === "live" ? true : undefined), 20_000, "the agent never went live")
  checks.push("real CLI RemoteAgent connected to the relay with a signed device credential")

  /* ------------------------------------------ browser device + Session discovery */

  await store.load()
  expect(
    store.state().devices.some((info) => info.id === enrolled.deviceID && info.online),
    "the connected enrolled device is not online in the browser device list",
  )
  store.connect(enrolled.deviceID)
  const sharedWorkspace = await waitFor(() => store.state().sessionGroups.find((group) => group.directory === workspace), 20_000,
    "the browser did not list the shared Session workspace")
  store.selectWorkspace(sharedWorkspace.id)
  await waitFor(
    () => (store.state().advertised.includes(sessionID) ? true : undefined),
    20_000,
    () => `the browser never loaded the backend Session inventory: ${JSON.stringify({ connection: store.state().connection, transport: store.state().transport, list: store.state().sessionListStatus, selectedWorkspace: store.state().selectedWorkspaceID, groups: store.state().sessionGroups.map((group) => group.directory), advertised: store.state().advertised, sessions: store.state().sessions.map((session) => session.id), notice: store.state().notice, statuses: browserStatuses.slice(-5), diagnostics: diagnostics.slice(-5), agent: agent?.currentState })}`,
  )
  expect(
    [sessionID, hiddenSessionID, guardSessionID].every((id) => store.state().advertised.includes(id)),
    `Session inventory was incomplete: ${store.state().advertised.join(",")}`,
  )

  await waitFor(
    () => (store.state().sessions.length > 0 ? true : undefined),
    20_000,
    "the browser never listed sessions",
  )
  const listed = store.state().sessions.map((info) => info.id)
  expect(
    listed.includes(sessionID) && listed.includes(guardSessionID) && listed.includes(hiddenSessionID),
    `Session discovery failed: ${listed.join(",")}`,
  )
  checks.push("all backend Sessions are listed to the authenticated device owner")

  const futureSessionID = "ses_real_flow_future"
  await createSession(server, futureSessionID, workspace, { providerID, id: providerModel })
  await waitFor(
    () => (store.state().sessions.some((info) => info.id === futureSessionID) ? true : undefined),
    20_000,
    "a Session created while connected never appeared",
  )
  checks.push("a Session created while connected invalidated and refreshed the complete list")

  /* ------------------------------------------- protocol-level client (same cookie) */

  let probeInvalidated = false
  const probeStatuses: RemoteTransportStatus[] = []
  const probe = createRemoteTransport({
    url: `${socketOrigin}${RemoteWebSocketPath.client}?device=${enrolled.deviceID}`,
    handlers: {
      onSessions: () => (probeInvalidated = true),
      onStatus: (status) => probeStatuses.push(status),
    },
    createSocket: (url) => new WebSocket(url, { headers: { cookie, origin: workerOrigin } }),
  })
  disposals.push(async () => probe.close(1000, "flow complete"))
  probe.connect()

  /**
   * The browser transport reconnects on unexpected socket drops. A request that
   * never left the client (`unavailable`/`not-connected`) is safe to retry; a
   * request that was sent and left unsettled is never retried.
   */
  const probeRequest = async (
    operation: Parameters<typeof probe.request>[0],
    request?: Parameters<typeof probe.request>[1],
  ) => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const outcome = await probe.request(operation, request)
      if (outcome.status !== "unavailable" || outcome.reason !== "not-connected") return outcome
      if (Date.now() >= deadline) return outcome
      await Bun.sleep(100)
    }
  }

  await waitFor(() => (probeInvalidated ? true : undefined), 20_000, "probe client never received a Session invalidation")
  const hidden = await probeRequest("session.get", { sessionID: hiddenSessionID })
  expect(hidden.status === "ok", `backend Session read failed: ${JSON.stringify(hidden)}`)
  checks.push("a backend Session needs no per-Session allow operation")

  await store.loadWorkspaces()
  const candidate = store.state().workspaces.find((item) => item.directory === openedWorkspace)
  if (!candidate) throw new Error("the previously opened directory with no Sessions was not listed")
  await Bun.sleep(RemoteLimits.clientRateWindowMs + 1)
  const familyStatus = await probeRequest("session.status")
  expect(familyStatus.status === "ok" && isRecord(familyStatus.value) && Array.isArray(familyStatus.value.running) && Array.isArray(familyStatus.value.attention),
    `family status failed: ${JSON.stringify(familyStatus)}`)
  const memberActivity = await probeRequest("session.family.activity", { sessionID, input: { sessionIDs: [] } })
  expect(memberActivity.status === "ok" && isRecord(memberActivity.value) && Array.isArray(memberActivity.value.data) &&
    memberActivity.value.data.length === 1 && isRecord(memberActivity.value.data[0]) &&
    memberActivity.value.data[0].sessionID === sessionID && memberActivity.value.data[0].executing === false,
  `family activity failed: ${JSON.stringify(memberActivity)}`)
  const sideChatID = "ses_real_flow_btw"
  const sideChat = await probeRequest("session.side-chat.create", { sessionID, input: { id: sideChatID } })
  expect(sideChat.status === "ok" && isRecord(sideChat.value) && isRecord(sideChat.value.data) && sideChat.value.data.parentID === sessionID && sideChat.value.data.agent === "btw",
    `remote side chat creation failed: ${JSON.stringify(sideChat)}`)
  const sideChats = await probeRequest("session.side-chat.list", { sessionID })
  expect(sideChats.status === "ok" && isRecord(sideChats.value) && Array.isArray(sideChats.value.data) && sideChats.value.data.some((item) => isRecord(item) && item.id === sideChatID),
    `remote side chat listing failed: ${JSON.stringify(sideChats)}`)
  const btwPrompt = await probeRequest("session.prompt", { sessionID: sideChatID, input: { id: "msg_real_flow_btw_prompt", text: "Ask a side question", resume: false } })
  expect(btwPrompt.status === "ok", `BTW prompt was rejected: ${JSON.stringify(btwPrompt)}`)
  const shellStarted = await server.request("/api/shell", { method: "POST", headers: { "content-type": "application/json", "x-ycoding-directory": workspace },
    body: JSON.stringify({ command: "sleep 120", timeout: 120_000, metadata: { sessionID } }) })
  expect(shellStarted.ok, `family shell did not start: ${shellStarted.status}`)
  const shellBody: unknown = await shellStarted.json()
  const shellID = isRecord(shellBody) && isRecord(shellBody.data) ? shellBody.data.id : undefined
  expect(typeof shellID === "string", `family shell ID missing: ${JSON.stringify(shellBody)}`)
  const shellPage = await probeRequest("session.team.shell.list", { sessionID })
  expect(shellPage.status === "ok" && isRecord(shellPage.value) && Array.isArray(shellPage.value.data) &&
    shellPage.value.data.some((item) => isRecord(item) && item.id === shellID && item.ownerID === sessionID), `family shell was not listed: ${JSON.stringify(shellPage)}`)
  const shellKilled = await probeRequest("session.team.shell.kill", { sessionID, input: { shellID } })
  expect(shellKilled.status === "ok", `family shell kill failed: ${JSON.stringify(shellKilled)}`)
  checks.push("BTW side chat creation, listing, and prompt plus family-owned shell listing and kill crossed the real relay")
  const selectedCatalog = await probeRequest("workspace.catalog", { input: { workspace: candidate.id } })
  expect(selectedCatalog.status === "ok" && isRecord(selectedCatalog.value) && Array.isArray(selectedCatalog.value.agents) &&
    Array.isArray(selectedCatalog.value.models) && !("defaultAgent" in selectedCatalog.value),
    `workspace catalog failed: ${JSON.stringify(selectedCatalog)}`)
  const found = await probeRequest("workspace.file.find", { input: { workspace: candidate.id, query: "find-this", limit: 5 } })
  expect(found.status === "ok" && isRecord(found.value) && Array.isArray(found.value.files) &&
    found.value.files.some((file) => isRecord(file) && file.path === "find-this.txt" && file.kind === "file"),
    `workspace file search failed: ${JSON.stringify(found)}`)
  checks.push("family status, location catalog, and bounded file search crossed the real relay")
  const quotas = await probeRequest("usage.providers")
  expect(quotas.status === "ok" && isRecord(quotas.value) && Array.isArray(quotas.value.data) && !("location" in quotas.value),
    `normalized provider usage leaked placement or failed: ${JSON.stringify(quotas)}`)
  const summary = await probeRequest("usage.summary")
  expect(summary.status === "ok" && isRecord(summary.value) && isRecord(summary.value.data),
    `backend usage summary failed: ${JSON.stringify(summary)}`)
  const report = await probeRequest("usage.report", { input: { group: "model", limit: 2 } })
  expect(report.status === "ok" && isRecord(report.value) && isRecord(report.value.data) && report.value.data.group === "model",
    `backend usage report failed: ${JSON.stringify(report)}`)
  checks.push("normalized provider quotas, retained summary, and grouped report crossed the real relay")
  const beforeCreate = providerRequests.length
  const createdID = await store.createSession({ workspaceID: candidate.id })
  if (!createdID) throw new Error(`remote creation failed: ${JSON.stringify(store.state().sessionCreation)}`)
  const created = await local.getSession(createdID, { directory: openedWorkspace })
  expect(created.parentID === undefined && created.projectID === candidate.projectID, "remote creation did not make a root in the selected project")
  expect(providerRequests.length === beforeCreate, "session creation unexpectedly called the model")
  const adopted = await probeRequest("session.create", { input: { id: createdID, workspace: candidate.id } })
  expect(adopted.status === "ok", `idempotent creation failed: ${JSON.stringify(adopted)}`)
  expect((await local.listPage({ limit: 50 })).data.filter((info) => info.id === createdID).length === 1, "exact creation retry duplicated the Session")
  await store.selectSession(createdID)
  expect(store.state().view?.messages.length === 0, "the new Session was not an empty conversation")
  providerFollowUpText = "Reply in the remotely created Session."
  providerTurn = { text: providerFollowUpText }
  await store.sendPrompt({ text: "Start in the previously opened workspace", delivery: "steer" })
  await waitFor(async () => {
    const messages = await local.messages(createdID, { directory: openedWorkspace })
    return JSON.stringify(messages).includes(providerFollowUpText) ? true : undefined
  }, 30_000, "the remotely created Session did not execute and persist its first prompt")
  await waitFor(() => JSON.stringify(store.state().view?.messages).includes(providerFollowUpText) ? true : undefined,
    20_000, "the new Session reply did not reach the browser store")
  checks.push("previously opened workspace without Sessions created an idle root, adopted an exact retry, and executed its first chat prompt")

  await Bun.sleep(RemoteLimits.clientRateWindowMs + 1)
  for (const level of [1, 2, 3, 0] as const) {
    await store.setYolo(level)
    const autonomy = await local.autonomyGet(createdID, { directory: openedWorkspace })
    expect(isRecord(autonomy) && autonomy.yolo === level, `YOLO ${level} did not persist on the selected Session`)
    expect(store.state().view?.autonomy.yolo === level, `YOLO ${level} did not reach the browser store`)
  }
  await store.setYolo(2)
  providerFollowUpText = "Reply after the YOLO-approved shell call."
  providerTurn = { tool: { id: "call_flow_yolo", name: "shell", input: { command: "touch yolo-approved.txt" } }, text: "" }
  await store.sendPrompt({ text: "Run the harmless YOLO approval check", delivery: "steer" })
  await waitFor(() => existsSync(join(openedWorkspace, "yolo-approved.txt")) ? true : undefined,
    30_000, "YOLO 2 did not automatically approve the ask-permission shell call")
  await waitFor(async () => JSON.stringify(await local.messages(createdID, { directory: openedWorkspace })).includes(providerFollowUpText) ? true : undefined,
    30_000, "the YOLO-approved step did not settle")
  await store.setYolo(0)
  await store.setGoal("Finish the remote lifecycle verification")
  expect(store.state().view?.autonomy.mode === "goal" && store.state().view?.autonomy.goal?.status === "active", "goal start did not reach the browser store")
  await store.stopGoal()
  const stoppedGoal = await local.autonomyGet(createdID, { directory: openedWorkspace })
  expect(isRecord(stoppedGoal) && isRecord(stoppedGoal.goal) && stoppedGoal.goal.status === "stopped",
    `goal stop did not persist: ${JSON.stringify({ autonomy: stoppedGoal, mutations: store.state().mutations, statuses: browserStatuses.slice(-5) })}`)
  await waitFor(async () => {
    const active = await local.activeSessions()
    return isRecord(active) && !(createdID in active) ? true : undefined
  }, 30_000, "the stopped goal Session did not become idle")
  checks.push("YOLO 0–3 persisted through the remote store, YOLO 2 approved a real tool call, and goal start/stop reached durable runtime state")
  await Bun.sleep(RemoteLimits.clientRateWindowMs + 1)
  providerFollowUpText = providerText
  providerTurn = { text: providerText }

  await store.selectSession(sessionID)
  await waitFor(
    () => (store.state().view?.id === sessionID ? true : undefined),
    20_000,
    "the store never selected the shared session",
  )
  const initialTodos = [{ content: "Inspect the remote workspace", status: "pending", priority: "high" }]
  const savedTodos = await server.request(`/api/session/${sessionID}/todo`, {
    method: "PUT", headers: { "content-type": "application/json", "x-ycoding-directory": workspace },
    body: JSON.stringify({ todos: initialTodos }),
  })
  expect(savedTodos.ok, `the isolated Session todo update failed: ${savedTodos.status}`)
  const remoteTodos = await probeRequest("session.todo.list", { sessionID })
  expect(remoteTodos.status === "ok" && JSON.stringify(remoteTodos.value) === JSON.stringify({ data: initialTodos }),
    `the scoped remote todo read did not return the Protocol list: ${JSON.stringify(remoteTodos)}`)
  const liveTodos = [{ content: "Check live todo delivery", status: "in_progress", priority: "medium" }]
  const liveUpdate = await server.request(`/api/session/${sessionID}/todo`, {
    method: "PUT", headers: { "content-type": "application/json", "x-ycoding-directory": workspace },
    body: JSON.stringify({ todos: liveTodos }),
  })
  expect(liveUpdate.ok, `the isolated live todo update failed: ${liveUpdate.status}`)
  await waitFor(() => JSON.stringify(store.state().todos) === JSON.stringify(liveTodos) ? true : undefined,
    20_000, "the selected remote Session did not receive its todo.updated event")
  checks.push("verified-Session todo read and subscribed todo.updated event crossed the real relay")

  /* --------------------------------- durable exact-id admission (no duplicate) */

  const first = await probeRequest("session.prompt", {
    sessionID,
    input: { id: promptID, text: "composed flow prompt", resume: false },
  })
  expect(first.status === "ok", `first admission failed: ${JSON.stringify(first)}`)
  const second = await probeRequest("session.prompt", {
    sessionID,
    input: { id: promptID, text: "composed flow prompt", resume: false },
  })
  expect(second.status === "ok", `exact retry failed: ${JSON.stringify(second)}`)
  const other = await probeRequest("session.prompt", {
    sessionID,
    input: { id: otherPromptID, text: "second distinct prompt", resume: false },
  })
  expect(other.status === "ok", `distinct admission failed: ${JSON.stringify(other)}`)

  const pending = await pendingIDs(server)
  expect(
    pending.filter((id) => id === promptID).length === 1,
    `exact retry admitted ${pending.filter((id) => id === promptID).length} copies`,
  )
  expect(pending.includes(otherPromptID), "the distinct prompt was not admitted")
  checks.push("same real Session admitted one row per prompt message id, exact retry reconciled")

  /* --------------------------- real local execution through the SessionRunner */

  const executed = await probeRequest("session.prompt", {
    sessionID,
    input: { id: executionPromptID, text: "answer with the stand-in text" },
  })
  expect(executed.status === "ok", `execution prompt failed: ${JSON.stringify(executed)}`)
  await waitFor(
    () => (providerRequests.length > 0 ? true : undefined),
    30_000,
    "the real runner never called the provider",
  )
  await waitFor(
    () => (JSON.stringify(events).includes(providerText) ? true : undefined),
    30_000,
    "the streamed assistant text never reached the browser through the relay",
  )
  const canonical = await waitFor(
    async () => {
      const read = await probeRequest("session.messages", { sessionID })
      return read.status === "ok" && JSON.stringify(read.value).includes(providerText) ? read : undefined
    },
    30_000,
    "the final assistant content was not persisted canonically",
  )
  expect(canonical.status === "ok", "canonical read failed")
  expect(
    JSON.stringify(canonical.value).includes(executionPromptID),
    "the canonical transcript does not carry the executed user message",
  )
  checks.push("one real SessionRunner prompt executed against the local provider stand-in and persisted")

  /* ---------------- provider question tool -> native Form -> remote browser reply */

  const questionFinalText = "Stand-in reply after the native Form answer."
  providerFollowUpText = questionFinalText
  providerTurn = {
    tool: {
      id: "call_flow_question",
      name: "question",
      input: {
        questions: [
          {
            question: "Proceed with the remote flow?",
            header: "Proceed",
            options: [{ label: "Yes", description: "Continue the composed flow" }],
          },
        ],
      },
    },
    text: "",
  }
  await store.sendPrompt({ text: "Ask the composed-flow question", delivery: "steer" })
  const pendingForm = await waitFor(
    () => {
      const request = store.state().view?.requests.find((entry) => entry.kind === "form")
      return request?.kind === "form" && request.form.metadata?.kind === "question" ? request.form : undefined
    },
    30_000,
    "the provider-emitted question tool never became a native pending Form in the remote store",
  )
  expect(pendingForm.sessionID === sessionID, "the pending Form was not owned by the selected Session")
  await store.selectSession(sessionID)
  expect(
    store.state().view?.requests.some((entry) => entry.kind === "form" && entry.id === pendingForm.id),
    "reloading the selected Session lost its pending native Form",
  )
  await store.replyForm(pendingForm.id, { q0: "Yes" })
  await waitFor(
    async () => {
      const read = await probeRequest("session.messages", { sessionID })
      return read.status === "ok" && JSON.stringify(read.value).includes(questionFinalText) ? true : undefined
    },
    30_000,
    "the SessionRunner did not continue to final text after the remote Form reply",
  )
  expect(
    store.state().view?.requests.some((entry) => entry.id === pendingForm.id) === false,
    "the settled native Form remained pending in the remote store",
  )
  checks.push("provider question tool created a native Form, remote store replied, and SessionRunner reached final text")

  /* ---------------------------------------------- streamed event to the client */

  const rename = await server.request(`/api/session/${sessionID}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Renamed by composed flow" }),
  })
  expect(rename.status === 204, `rename returned ${rename.status}`)
  await waitFor(
    () => (events.some((entry) => JSON.stringify(entry).includes("Renamed by composed flow")) ? true : undefined),
    20_000,
    "no rename event reached the browser client through the relay",
  )
  checks.push("a real durable session event streamed through the agent and relay to the browser")

  /* ------------------------------------------------- reconnect: read, no replay */

  const beforeReconnect = await pendingIDs(server)
  const eventCountBefore = events.length
  const dropped = clientSockets.at(-1)
  expect(dropped !== undefined, "no browser socket was captured for the reconnect proof")
  dropped?.close(1001, "simulated network drop")
  await waitFor(
    () => (store.state().transport.kind === "reconnecting" ? true : undefined),
    20_000,
    "the browser transport did not report a reconnect",
  )
  await waitFor(
    () => (store.state().transport.kind === "open" ? true : undefined),
    20_000,
    "the browser transport never came back",
  )
  await waitFor(
    () => (store.state().view?.id === sessionID ? true : undefined),
    20_000,
    "the store did not re-read the selected session after reconnect",
  )
  const afterReconnect = await pendingIDs(server)
  expect(
    afterReconnect.join(",") === beforeReconnect.join(","),
    `reconnect changed durable admissions: ${beforeReconnect.join(",")} -> ${afterReconnect.join(",")}`,
  )
  const requestsBefore = providerRequests.length
  const replayed = await probeRequest("session.messages", { sessionID })
  expect(replayed.status === "ok", "post-reconnect canonical read failed")
  expect(
    JSON.stringify(replayed.value).includes(providerText) &&
      JSON.stringify(replayed.value).match(new RegExp(providerText.slice(0, 24), "g"))?.length === 1,
    "the assistant content was duplicated after reconnect",
  )
  expect(providerRequests.length === requestsBefore, "reconnect started another provider request")
  expect(events.length >= eventCountBefore, "reconnect dropped buffered events")
  checks.push("reconnect re-read state without replaying a mutation")

  /* --------------------------- approval: deny, allow, and unauthorized replies */

  // Settle detection reads the local server directly: the relay read is asserted
  // where the relay path is the point, not for timing.
  const localMessages = () => local.messages(sessionID, { directory: workspace })
  const assistantCount = async () => (await localMessages()).filter((entry) => entry.type === "assistant").length

  /** Read-only snapshot used only when the approval wait times out. */
  const approvalDiagnostic = async () => {
    const [listed, guardrails, messages] = await Promise.all([
      probe.request("session.permission.list", { sessionID }),
      probe.request("session.guardrail.request.list", { sessionID }),
      localMessages(),
    ])
    return JSON.stringify({
      probeStatus: probe.status(),
      providerRequests: providerRequests.length,
      shellCalls: providerShellCalls,
      deniedFile: existsSync(join(workspace, "denied.txt")),
      allowedFile: existsSync(join(workspace, "allowed.txt")),
      permissions: listed.status === "ok" ? listed.value : listed,
      guardrails: guardrails.status === "ok" ? guardrails.value : guardrails,
      canonicalTail: messages.slice(-6).map((entry) => ({ type: entry.type })),
    }).slice(0, 1200)
  }

  const raiseApproval = async (command: string, label: string, followUp: string) => {
    providerFollowUpText = followUp
    providerTurn = { tool: { id: `call_flow_${label}`, name: "shell", input: { command } }, text: "" }
    const prompted = await probeRequest("session.prompt", {
      sessionID,
      input: { id: `msg_approval_${label}`, text: `run ${command}` },
    })
    expect(prompted.status === "ok", `approval prompt (${label}) failed: ${JSON.stringify(prompted)}`)

    const deadline = Date.now() + 30_000
    for (;;) {
      const listed = await probeRequest("session.permission.list", { sessionID })
      if (listed.status === "ok" && isRecord(listed.value) && Array.isArray(listed.value.data)) {
        const ids = listed.value.data.flatMap((row) =>
          isRecord(row) && row.action === "shell" && typeof row.id === "string" ? [row.id] : [],
        )
        if (ids.length > 0) return ids.at(-1)
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Real-flow check failed: no pending approval was raised (${label}); observed ${await approvalDiagnostic()}`,
        )
      await Bun.sleep(200)
    }
  }

  const deniedRequest = await raiseApproval("touch denied.txt", "deny", "Stand-in reply after denial.")
  const otherSessionReply = await probeRequest("session.permission.reply", {
    sessionID: hiddenSessionID,
    input: { requestID: deniedRequest, reply: "once" },
  })
  expect(
    otherSessionReply.status === "failed",
    `a reply through the wrong Session was accepted: ${JSON.stringify(otherSessionReply)}`,
  )
  const unknownReply = await probeRequest("session.permission.reply", {
    sessionID,
    input: { requestID: "per_flow_unknown", reply: "once" },
  })
  expect(unknownReply.status === "failed", `an unknown request id was accepted: ${JSON.stringify(unknownReply)}`)
  const stillPending = await probeRequest("session.permission.list", { sessionID })
  expect(
    JSON.stringify(stillPending.value).includes(deniedRequest),
    "an unauthorized reply decided the pending approval",
  )
  const rejected = await probeRequest("session.permission.reply", {
    sessionID,
    input: { requestID: deniedRequest, reply: "reject" },
  })
  expect(rejected.status === "ok", `authorized reject failed: ${JSON.stringify(rejected)}`)
  // The request is consumed and the denied command must never run.
  await waitFor(
    async () => {
      const listed = await probeRequest("session.permission.list", { sessionID })
      if (listed.status !== "ok" || !isRecord(listed.value) || !Array.isArray(listed.value.data)) return undefined
      return listed.value.data.some((row) => isRecord(row) && row.id === deniedRequest) ? undefined : true
    },
    20_000,
    "the rejected request stayed pending",
  )
  await waitFor(
    async () => {
      const active = await probeRequest("session.active")
      if (active.status !== "ok" || !isRecord(active.value) || !isRecord(active.value.data)) return undefined
      return sessionID in active.value.data ? undefined : true
    },
    30_000,
    "the session stayed active after the rejection",
  )
  expect(!existsSync(join(workspace, "denied.txt")), "the rejected shell command still executed")
  checks.push("remote reject denied the tool call, left other replies unauthorized, and completed the step")

  const allowedRequest = await raiseApproval("touch allowed.txt", "allow", "Stand-in reply after approval.")
  const assistantsBeforeApprove = await assistantCount()
  const approved = await probeRequest("session.permission.reply", {
    sessionID,
    input: { requestID: allowedRequest, reply: "once" },
  })
  expect(approved.status === "ok", `authorized approve failed: ${JSON.stringify(approved)}`)
  await waitFor(
    () => (existsSync(join(workspace, "allowed.txt")) ? true : undefined),
    30_000,
    "the approved shell command did not execute",
  )
  await waitFor(
    async () => ((await assistantCount()) > assistantsBeforeApprove ? true : undefined),
    30_000,
    "the approved step never settled",
  )
  const canonicalAfterTool = await waitFor(
    async () => {
      const read = await probeRequest("session.messages", { sessionID })
      return read.status === "ok" && JSON.stringify(read.value).includes("allowed.txt") ? read : undefined
    },
    30_000,
    "the approved tool result was not persisted canonically",
  )
  expect(canonicalAfterTool.status === "ok", "canonical read after approval failed")
  checks.push("remote approve ran the tool call and its result persisted canonically")

  /* --------------------- guardrail reviews: ordinary and hard, via the relay */

  // The composed flow deliberately performs more than one connection's request
  // budget across independent scenarios. Start the guardrail phase in a fresh
  // rate window instead of treating the relay's policy close as a transport retry.
  await Bun.sleep(RemoteLimits.clientRateWindowMs + 1)

  const guardrailReviewFor = async (command: string, label: string) => {
    providerFollowUpText = `Stand-in reply after guardrail ${label}.`
    providerTurn = { tool: { id: `call_guard_${label}`, name: "shell", input: { command } }, text: "" }
    const prompted = await probeRequest("session.prompt", {
      sessionID: guardSessionID,
      input: { id: `msg_guard_${label}`, text: `run ${command}` },
    })
    expect(
      prompted.status === "ok",
      `guardrail prompt (${label}) failed: ${JSON.stringify({
        prompted,
        agent: agent?.currentState,
        agentDiagnostics: diagnostics.slice(-4),
        browserStatuses: browserStatuses.slice(-6),
        probeStatuses: probeStatuses.slice(-6),
        largestEventChars: Math.max(0, ...events.map((event) => JSON.stringify(event).length)),
      })}`,
    )
    await waitFor(async () => {
      const localList = await local.guardrailRequestList(guardSessionID, { directory: workspace })
      return Array.isArray(localList) && localList.some(
        (row) => isRecord(row) && JSON.stringify(row.resources ?? []).includes(command),
      ) ? true : undefined
    }, 30_000, `no guardrail review was raised (${label})`)
    const listed = await probeRequest("session.guardrail.request.list", { sessionID: guardSessionID })
    if (listed.status !== "ok" || !isRecord(listed.value) || !Array.isArray(listed.value.data))
      throw new Error(`Real-flow check failed: guardrail review list (${label}): ${JSON.stringify(listed)}`)
    const matching = listed.value.data.filter(
      (row): row is Record<string, unknown> =>
        isRecord(row) && typeof row.id === "string" && JSON.stringify(row.resources ?? []).includes(command),
    )
    const review = matching.at(-1)
    if (!review) throw new Error(`Real-flow check failed: guardrail review (${label}) was absent from the relay list`)
    return review
  }

  const replyGuardrail = (requestID: string, reply: "once" | "always" | "reject") =>
    probe.request("session.guardrail.reply", { sessionID: guardSessionID, input: { requestID, reply } })

  /**
   * Sends a guardrail decision, reconciling an indeterminate outcome: when the
   * review is still pending nothing was applied, so a fresh reply is a new
   * decision rather than a replay of an applied mutation.
   */
  const decideGuardrail = async (requestID: string, reply: "once" | "always" | "reject") => {
    const first = await replyGuardrail(requestID, reply)
    if (first.status === "ok") return first
    if (await guardrailPending(requestID)) return replyGuardrail(requestID, reply)
    return first
  }

  const guardSessionIdle = async () => {
    const active = await local.activeSessions()
    return isRecord(active) && !(guardSessionID in active)
  }

  const guardrailPending = async (requestID: string) => {
    const listed = await local.guardrailRequestList(guardSessionID, { directory: workspace })
    if (!Array.isArray(listed)) return undefined
    return listed.some((row) => isRecord(row) && row.id === requestID)
  }

  const status = await probeRequest("session.guardrail.status", { sessionID: guardSessionID })
  expect(status.status === "ok", `guardrail status failed: ${JSON.stringify(status)}`)
  expect(
    status.status === "ok" && isRecord(status.value) && isRecord(status.value.data) && typeof status.value.data.profile === "string",
    `guardrail status did not report a profile: ${JSON.stringify(status)}`,
  )

  // Ordinary review: a once reply resolves it and the harmless command runs.
  const ordinary = await guardrailReviewFor("touch ordinary-allowed.txt", "ordinary")
  expect(ordinary.hardReview !== true, `the ordinary rule was reported as hard: ${JSON.stringify(ordinary)}`)
  expect(
    JSON.stringify(ordinary.ruleIDs ?? []).includes("flow.guard.ordinary"),
    `the custom ordinary rule did not fire: ${JSON.stringify(ordinary)}`,
  )
  const ordinaryReply = await decideGuardrail(String(ordinary.id), "once")
  expect(ordinaryReply.status === "ok", `ordinary once reply failed: ${JSON.stringify(ordinaryReply)}`)
  await waitFor(
    async () => ((await guardrailPending(String(ordinary.id))) === false ? true : undefined),
    20_000,
    "the ordinary review stayed pending after a once reply",
  )
  await waitFor(
    () => (existsSync(join(workspace, "ordinary-allowed.txt")) ? true : undefined),
    30_000,
    "the ordinarily approved command did not run",
  )
  await waitFor(guardSessionIdle, 30_000, "the guard session stayed active after the ordinary review")
  checks.push("ordinary guardrail review listed through the relay resolved with a once reply")

  // Hard review: `always` is accepted and coerced to a rejection. It must consume
  // the review, never approve the action, and never become reusable.
  const hardAlways = await guardrailReviewFor("touch hard-always.txt", "hard-always")
  expect(hardAlways.hardReview === true, `the hard rule was not reported as hard: ${JSON.stringify(hardAlways)}`)
  const alwaysReply = await decideGuardrail(String(hardAlways.id), "always")
  expect(alwaysReply.status === "ok", `the hard always reply was not accepted: ${JSON.stringify(alwaysReply)}`)
  await waitFor(
    async () => ((await guardrailPending(String(hardAlways.id))) === false ? true : undefined),
    20_000,
    "the hard review was not consumed by the always reply",
  )
  await waitFor(guardSessionIdle, 30_000, "the guard session stayed active after the coerced rejection")
  expect(!existsSync(join(workspace, "hard-always.txt")), "the hard-always command ran")
  const hardRepeat = await guardrailReviewFor("touch hard-always.txt", "hard-repeat")
  expect(
    hardRepeat.id !== hardAlways.id,
    "a hard review was reusably approved: the repeat action reused the earlier decision",
  )
  expect(hardRepeat.hardReview === true, `the repeat review was not hard: ${JSON.stringify(hardRepeat)}`)
  const repeatRejected = await decideGuardrail(String(hardRepeat.id), "reject")
  expect(repeatRejected.status === "ok", `hard repeat reject failed: ${JSON.stringify(repeatRejected)}`)
  await waitFor(
    async () => ((await guardrailPending(String(hardRepeat.id))) === false ? true : undefined),
    20_000,
    "the repeated hard review was not consumed by the reject",
  )
  await waitFor(guardSessionIdle, 30_000, "the guard session stayed active after the repeat rejection")
  expect(!existsSync(join(workspace, "hard-always.txt")), "the repeated hard command ran after a reject")
  checks.push("hard review always reply was accepted, consumed, and never became reusable")

  // Hard review: explicit once runs the harmless command; reject prohibits it.
  const hardOnce = await guardrailReviewFor("touch hard-allowed.txt", "hard-once")
  expect(hardOnce.hardReview === true, `hard-once was not a hard review: ${JSON.stringify(hardOnce)}`)
  const onceReply = await decideGuardrail(String(hardOnce.id), "once")
  expect(onceReply.status === "ok", `hard once reply failed: ${JSON.stringify(onceReply)}`)
  await waitFor(
    async () => ((await guardrailPending(String(hardOnce.id))) === false ? true : undefined),
    20_000,
    "the hard review was not consumed by the once reply",
  )
  // The observable effect is the command's file; the session may briefly leave the
  // active set before the tool runs, so wait for the effect and then for idle.
  await waitFor(
    () => (existsSync(join(workspace, "hard-allowed.txt")) ? true : undefined),
    30_000,
    "the hard-approved command did not run",
  )
  await waitFor(guardSessionIdle, 30_000, "the guard session stayed active after the approved hard review")
  const hardReject = await guardrailReviewFor("touch hard-denied.txt", "hard-reject")
  expect(hardReject.hardReview === true, `hard-reject was not a hard review: ${JSON.stringify(hardReject)}`)
  const rejectReply = await decideGuardrail(String(hardReject.id), "reject")
  expect(rejectReply.status === "ok", `hard reject reply failed: ${JSON.stringify(rejectReply)}`)
  await waitFor(
    async () => ((await guardrailPending(String(hardReject.id))) === false ? true : undefined),
    20_000,
    "the hard review was not consumed by the reject",
  )
  await waitFor(guardSessionIdle, 30_000, "the guard session stayed active after the rejected hard review")
  expect(!existsSync(join(workspace, "hard-denied.txt")), "the rejected hard command ran")
  checks.push("hard review once ran the command and reject prohibited it")

  /* --------------------------------------- interrupt through the real service */

  providerMode = "hold"
  const executing = await probeRequest("session.prompt", {
    sessionID,
    input: { id: "msg_real_flow_interrupt", text: "hold the stream open" },
  })
  expect(executing.status === "ok", `interrupt prompt failed: ${JSON.stringify({ executing, probeStatuses: probeStatuses.slice(-6) })}`)
  await waitFor(
    () => (events.filter((entry) => JSON.stringify(entry).includes(providerText)).length >= 2 ? true : undefined),
    30_000,
    "the held step never streamed content before the interrupt",
  )
  const interrupted = await probeRequest("session.interrupt", { sessionID })
  expect(interrupted.status === "ok", `interrupt failed: ${JSON.stringify(interrupted)}`)
  releaseStream?.()
  await waitFor(
    async () => {
      const active = await probeRequest("session.active")
      if (active.status !== "ok") return undefined
      const running = isRecord(active.value) && isRecord(active.value.data) ? active.value.data : undefined
      return running !== undefined && !(sessionID in running) ? true : undefined
    },
    30_000,
    "the interrupted session stayed active",
  )
  checks.push("interrupt stopped the running step through the real local service")

  await Bun.sleep(RemoteLimits.clientRateWindowMs + 1)
  providerMode = "normal"
  providerTurn = { tool: { id: "call_real_flow_child_question", name: "subagent_report", input: { action: "question", text: "Which environment should I verify?" } }, text: "" }
  const launchedQuestion = await server.request(`/api/session/${sessionID}/subagent`, { method: "POST",
    headers: { "content-type": "application/json", "x-ycoding-directory": workspace },
    body: JSON.stringify({ parentAssistantMessageID: "msg_real_flow_team_parent", toolCallID: "call_real_flow_team_question", agent: "flow-child",
      description: "Verify the selected environment", prompt: "Ask which environment to verify", background: true }) })
  const questionLaunchText = await launchedQuestion.text()
  expect(launchedQuestion.ok, `managed child launch failed: ${launchedQuestion.status} ${questionLaunchText}`)
  const questionBody: unknown = JSON.parse(questionLaunchText)
  const questionChildID = isRecord(questionBody) && isRecord(questionBody.data) ? questionBody.data.sessionID : undefined
  expect(typeof questionChildID === "string", `managed child ID missing: ${JSON.stringify(questionBody)}`)
  const waitingChild = await waitFor(async () => {
    const page = await probeRequest("session.subagent.list", { sessionID })
    const data = page.status === "ok" && isRecord(page.value) ? page.value.data : undefined
    return Array.isArray(data) ? data.find((item) => isRecord(item) && item.sessionID === questionChildID && item.state === "waiting" && isRecord(item.question)) : undefined
  }, 30_000, "the real managed child never raised a parent question")
  expect(isRecord(waitingChild) && isRecord(waitingChild.question) && typeof waitingChild.question.id === "string", "managed child question ID missing")
  const answer = await probeRequest("session.subagent.answer", { sessionID, input: { childID: questionChildID, questionID: waitingChild.question.id, text: "staging" } })
  expect(answer.status === "ok" && isRecord(answer.value) && isRecord(answer.value.data) && answer.value.data.sessionID === questionChildID,
    `managed child answer did not reach the real runner: ${JSON.stringify(answer)}`)
  const economics = await probeRequest("session.team.economics", { sessionID, input: { sessionIDs: [questionChildID] } })
  expect(economics.status === "ok" && isRecord(economics.value) && Array.isArray(economics.value.data) &&
    economics.value.data.some((item) => isRecord(item) && item.sessionID === questionChildID && isRecord(item.tokens) && typeof item.cost === "number"),
    `bounded child economics failed: ${JSON.stringify(economics)}`)
  const foreignEconomics = await probeRequest("session.team.economics", { sessionID, input: { sessionIDs: [hiddenSessionID] } })
  expect(foreignEconomics.status === "failed" && foreignEconomics.error.code === "forbidden", "unrelated Session economics escaped root-family authority")
  checks.push("managed child question/answer and bounded economics crossed the real relay; unrelated economics was refused")

  providerMode = "hold"
  providerTurn = { text: "Child held until cancellation." }
  const launchedCancel = await server.request(`/api/session/${sessionID}/subagent`, { method: "POST",
    headers: { "content-type": "application/json", "x-ycoding-directory": workspace },
    body: JSON.stringify({ parentAssistantMessageID: "msg_real_flow_team_parent", toolCallID: "call_real_flow_team_cancel", agent: "flow-child",
      description: "Stop a held child", prompt: "Wait for the parent to cancel", background: true }) })
  const cancelLaunchText = await launchedCancel.text()
  expect(launchedCancel.ok, `cancellable child launch failed: ${launchedCancel.status} ${cancelLaunchText}`)
  const cancelBody: unknown = JSON.parse(cancelLaunchText)
  const cancelChildID = isRecord(cancelBody) && isRecord(cancelBody.data) ? cancelBody.data.sessionID : undefined
  expect(typeof cancelChildID === "string", `cancellable child ID missing: ${JSON.stringify(cancelBody)}`)
  const cancelled = await probeRequest("session.subagent.cancel", { sessionID, input: { childID: cancelChildID } })
  expect(cancelled.status === "ok" && isRecord(cancelled.value) && isRecord(cancelled.value.data) && cancelled.value.data.sessionID === cancelChildID,
    `managed child cancellation failed: ${JSON.stringify(cancelled)}`)
  releaseStream?.()
  providerMode = "normal"
  checks.push("managed child cancellation reached the real Session orchestration through the relay")

  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  const annotation = Buffer.from(`Comment\0${"A".repeat(102_400)}`)
  const chunkLength = Buffer.alloc(4)
  chunkLength.writeUInt32BE(annotation.length)
  const chunkType = Buffer.from("tEXt")
  const chunkCRC = Buffer.alloc(4)
  chunkCRC.writeUInt32BE(crc32(Buffer.concat([chunkType, annotation])))
  const png = Buffer.concat([pixel.subarray(0, pixel.length - 12), chunkLength, chunkType, annotation, chunkCRC, pixel.subarray(pixel.length - 12)])
  await store.selectSession(sessionID)
  const imageSent = await store.sendPrompt({ text: "Inspect uploaded PNG", delivery: "steer", files: [{ uri: `data:image/png;base64,${png.toString("base64")}`, name: "capture.png" }] })
  expect(imageSent === true, `browser image upload failed: ${store.state().uploadError ?? "unknown"}`)
  const imageMessage = await waitFor(async () => (await local.messages(sessionID, { directory: workspace })).find((message) => message.type === "user" && message.text === "Inspect uploaded PNG"),
    30_000, "the uploaded image was not admitted into the local Session")
  if (imageMessage.type !== "user") throw new Error("the uploaded image was not a user message")
  const imageFile = imageMessage.files?.[0]
  expect(imageFile !== undefined && imageFile.mime === "image/png" && imageFile.name === "capture.png" && imageFile.content.bytes === png.length &&
    imageFile.content.digest === createHash("sha256").update(png).digest("hex"), "the local admitted image did not retain the source bytes and MIME")
  checks.push("100 KiB PNG crossed browser upload chunks, relay, agent, and local attachment materialization")

  if (!imageFile) throw new Error("the uploaded image has no managed reference")
  const imageRead = await probeRequest("session.attachment.read", { sessionID, input: { digest: imageFile.content.digest } })
  if (imageRead.status !== "ok" || !isRecord(imageRead.value) || typeof imageRead.value.data !== "string")
    throw new Error(`managed image read failed: ${JSON.stringify(imageRead)}`)
  expect(imageRead.value.mime === "image/png" && imageRead.value.bytes === png.length &&
    createHash("sha256").update(Buffer.from(imageRead.value.data, "base64")).digest("hex") === imageFile.content.digest,
  "the relay attachment read changed the managed image bytes")
  const hostedImage = await browserFetch(`${workerOrigin}/api/remote/devices/${enrolled.deviceID}/sessions/${sessionID}/attachments/${imageFile.content.digest}`)
  const hostedImageValue: unknown = await hostedImage.json()
  expect(hostedImage.status === 200 && isRecord(hostedImageValue) && typeof hostedImageValue.data === "string" &&
    createHash("sha256").update(Buffer.from(hostedImageValue.data, "base64")).digest("hex") === imageFile.content.digest,
  "same-origin attachment stream changed or refused the managed image")
  const unreferenced = await probeRequest("session.attachment.read", { sessionID, input: { digest: "f".repeat(64) } })
  expect(unreferenced.status === "failed" && unreferenced.error.code === "not_found", "an unreferenced managed digest was readable")
  checks.push("a Session-scoped managed PNG read returned exact bytes and refused an unreferenced digest")

  const windowIDs: string[] = []
  let before: string | undefined
  let reachedOldest = false
  for (let page = 0; page < 100; page++) {
    const outcome = await probeRequest("session.snapshot", { sessionID, input: { limit: 1, ...(before === undefined ? {} : { before }) } })
    if (outcome.status !== "ok" || !isRecord(outcome.value) || !Array.isArray(outcome.value.messages))
      throw new Error(`windowed snapshot page failed: ${JSON.stringify(outcome)}`)
    const messages = outcome.value.messages
    if (messages.length !== 1 || !isRecord(messages[0]) || typeof messages[0].id !== "string")
      throw new Error("windowed snapshot omitted its message")
    windowIDs.push(messages[0].id)
    if (typeof outcome.value.before !== "string") { reachedOldest = true; break }
    before = outcome.value.before
  }
  expect(reachedOldest && windowIDs.length >= 3 && new Set(windowIDs).size === windowIDs.length && windowIDs.includes(imageMessage.id),
    "windowed first/middle/last pages lost, duplicated, or skipped the admitted image")
  checks.push("windowed snapshot pages chained from newest to oldest through the real relay")

  const messageRead = await browserFetch(`${workerOrigin}/api/remote/devices/${enrolled.deviceID}/sessions/${sessionID}/messages/${imageMessage.id}`)
  expect(messageRead.status === 200, `scoped message stream returned ${messageRead.status}`)
  const recovered: unknown = await messageRead.json()
  expect(isRecord(recovered) && recovered.id === imageMessage.id && Array.isArray(recovered.files) &&
    isRecord(recovered.files[0]) && isRecord(recovered.files[0].content) && recovered.files[0].content.digest === imageFile.content.digest,
  "the real relay message read did not preserve the managed image reference")
  checks.push("same-origin indexed message stream returned the full projected item through the real relay")

  const pacedBytes = Buffer.alloc(1_100_000, 42)
  const pacedStart = performance.now()
  const statusCount = browserStatuses.length
  const pacing = store.sendPrompt({ text: "Review paced binary", delivery: "steer", files: [{ uri: `data:application/octet-stream;base64,${pacedBytes.toString("base64")}`, name: "paced.bin" }] })
  await waitFor(() => store.state().upload?.percent ? true : undefined, 20_000, "the paced attachment never started uploading")
  await store.loadWorkspaces()
  expect(store.state().workspaceStatus === "ready" && store.state().upload !== undefined, "a concurrent store read stalled behind the paced upload")
  const pacedSent = await pacing
  const pacedDurationMs = Math.round(performance.now() - pacedStart)
  expect(pacedSent === true, `paced upload failed: ${store.state().uploadError ?? "unknown"}`)
  expect(store.state().transport.kind === "open" && !browserStatuses.slice(statusCount).some((status) => status.kind === "closed" && status.code === 1008),
    "the paced upload tripped the relay request window")
  console.log(`upload-1mib-ms: ${pacedDurationMs}`)
  checks.push("1 MiB upload stayed paced across the real relay window while another store read settled")

  const refusedUpload = await probeRequest("session.prompt", { sessionID: hiddenSessionID,
    input: { id: "msg_unknown_upload", text: "Unresolved attachment", files: [{ uri: "ycoding-upload://4ab94d33-6e6b-41a3-a638-f0a6596854a9" }], resume: false } })
  expect(refusedUpload.status === "failed" && refusedUpload.error.code === "invalid_message", "an unresolved upload reference was admitted")
  const hiddenPending = await server.request(`/api/session/${hiddenSessionID}/pending`)
  expect(hiddenPending.ok && !JSON.stringify(await hiddenPending.json()).includes("msg_unknown_upload"), "the invalid upload reached the local Session")
  checks.push("an unresolved attachment reference failed before local prompt admission")

  const largeText = "Oversized event stream proof ".repeat(80_000)
  const largeID = "msg_real_flow_oversized"
  const largePrompt = await server.request(`/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ycoding-directory": encodeURIComponent(workspace) },
    body: JSON.stringify({ id: largeID, text: largeText }),
  })
  expect(largePrompt.status === 200, `local oversized prompt admission returned ${largePrompt.status}`)
  const oversizedMarker = await waitFor(() => events.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.event) || entry.event.type !== "session.remote.oversized" || !isRecord(entry.event.data) || entry.event.data.messageID !== largeID) return []
    return [entry.event]
  }).at(-1), 30_000, "the subscribed client did not receive an oversized-event marker")
  expect(isRecord(oversizedMarker.durable) && typeof oversizedMarker.durable.seq === "number" &&
    isRecord(oversizedMarker.data) && oversizedMarker.data.truncated === true &&
    typeof oversizedMarker.data.omittedChars === "number" && oversizedMarker.data.omittedChars > RemoteLimits.maxAgentMessageChars,
  "oversized marker lost its durable sequence or omitted-size metadata")
  expect(store.state().transport.kind === "open" && probe.status().kind === "open", "oversized event recycled an active relay connection")
  checks.push("an oversized subscribed event retained its durable sequence and omitted size without disconnecting clients")
  await waitFor(async () => (await local.messages(sessionID, { directory: workspace })).some((message) => message.type === "user" && message.id === largeID) ? true : undefined,
    30_000, "the oversized user message was not projected")
  const streamed = await browserFetch(`${workerOrigin}/api/remote/devices/${enrolled.deviceID}/sessions/${sessionID}/messages/${largeID}`)
  expect(streamed.status === 200, `oversized message stream returned ${streamed.status}`)
  const streamedMessage: unknown = await streamed.json()
  expect(isRecord(streamedMessage) && streamedMessage.id === largeID && streamedMessage.text === largeText,
    "the full oversized message did not survive the authenticated HTTP stream")
  expect(probe.status().kind === "open", "the oversized message stream disconnected the relay client")
  checks.push("a >2 MiB projected message streamed fully through authenticated HTTP without exhausting the WebSocket request window")

  const absentMessage = await browserFetch(`${workerOrigin}/api/remote/devices/${enrolled.deviceID}/sessions/${sessionID}/messages/msg_not_found`)
  expect(absentMessage.status === 404, `an unknown indexed message returned ${absentMessage.status}`)
  if (!agent) throw new Error("the local connector was not running")
  await agent.close()
  await waitFor(async () => (await browserFetch(`${workerOrigin}/api/remote/devices/${enrolled.deviceID}/sessions/${sessionID}/messages/${imageMessage.id}`)).status === 503 ? true : undefined,
    20_000, "the offline agent did not return 503 for a message stream")
  checks.push("authenticated HTTP streams return 404 for missing messages and 503 when the local agent is offline")

  /* ------------------------------------------------------- logout closes client */
  const logout = await http.logout()
  expect(logout.ok, `logout failed: ${JSON.stringify(logout)}`)
  await waitFor(() => (probe.status().kind === "closed" ? true : undefined), 20_000, "the client socket stayed open after logout")
  const afterLogout = await probeRequest("session.list")
  expect(
    afterLogout.status !== "ok",
    `a signed-out browser still reached the relay: ${JSON.stringify(afterLogout)}`,
  )
  checks.push("logout closed the browser relay socket and blocked further commands")

  for (const line of checks) console.log(`ok - ${line}`)
  console.log("Composed real-flow proof passed")
} catch (cause) {
  console.error(`Last completed check: ${checks.at(-1) ?? "none"}`)
  console.error(cause)
  throw cause
} finally {
  for (const dispose of disposals.reverse()) await dispose().catch(() => undefined)
  wrangler?.kill("SIGTERM")
  if (wrangler) await wrangler.exited
  google?.stop(true)
  if (home) await rm(home, { recursive: true, force: true })
  if (diagnostics.length > 0) console.log(`agent diagnostics: ${diagnostics.slice(-4).join(" | ")}`)
}

/* ------------------------------------------------------------------ helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Real-flow check failed: ${message}`)
}

async function pendingIDs(server: { request: (path: string, init?: RequestInit) => Promise<Response> }) {
  const response = await server.request(`/api/session/${sessionID}/pending`)
  if (response.status !== 200) throw new Error(`pending list returned ${response.status}`)
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.data)) return []
  return body.data.flatMap((row) => (isRecord(row) ? [String(row.id)] : []))
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function run(command: string, args: string[]): Promise<string> {
  const process = spawn([command, ...args], { cwd: repositoryRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`)
  return stdout
}

async function waitForWorker(): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${workerOrigin}/health`)).status === 200) return
    } catch {
      // Wrangler is still starting.
    }
    await Bun.sleep(500)
  }
  throw new Error("wrangler dev did not become ready")
}

async function waitFor<Value>(
  check: () => Value | undefined | Promise<Value | undefined>,
  timeoutMs: number,
  message: string | (() => string),
): Promise<Value> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await Promise.resolve(check())
    if (value !== undefined) return value
    if (Date.now() >= deadline)
      throw new Error(`Real-flow check failed: ${typeof message === "function" ? message() : message}`)
    await Bun.sleep(50)
  }
}

/** Full `name=value` pair from the response's Set-Cookie list. */
function cookiePair(response: Response, name: string): string {
  return setCookiePair(response, name)
}

function setCookiePair(response: Response, name: string): string {
  for (const value of response.headers.getSetCookie())
    if (value.startsWith(`${name}=`)) return value.split(";")[0] ?? ""
  throw new Error(`response carried no ${name} cookie`)
}

function cookieValue(pair: string): string {
  const separator = pair.indexOf("=")
  return separator === -1 ? "" : pair.slice(separator + 1)
}

/** Reads the one-use OIDC nonce the worker stored, proving the real D1 write. */
async function readNonce(transactionID: string, persist: string): Promise<string> {
  const output = await run(wranglerBin, [
    "d1",
    "execute",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
    "--persist-to",
    persist,
    "--json",
    "--command",
    `SELECT nonce FROM oauth_transaction WHERE id = '${transactionID}'`,
  ])
  const parsed: unknown = JSON.parse(output)
  const batches = Array.isArray(parsed) ? parsed : [parsed]
  for (const batch of batches) {
    if (!isRecord(batch) || !Array.isArray(batch.results)) continue
    for (const row of batch.results)
      if (isRecord(row) && typeof row.nonce === "string") return row.nonce
  }
  return ""
}

async function rsaIdentity(kid = "flow-kid") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" }
  return { pair, jwk }
}

async function signedIdToken(pair: CryptoKeyPair, claims: Record<string, unknown>) {
  const header = { alg: "RS256", kid: "flow-kid", typ: "JWT" }
  const signingInput = `${base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))}`
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signingInput)),
  )
  return `${signingInput}.${base64UrlEncode(signature)}`
}
