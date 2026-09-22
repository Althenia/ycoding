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
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
let wrangler: { kill: () => unknown } | undefined
let google: { stop: (closeActive?: boolean) => unknown } | undefined
let agent: RemoteAgent | undefined
let disposals: (() => Promise<void>)[] = []

try {
  const home = await mkdtemp(join(tmpdir(), "ycoding-real-flow-"))
  const workspace = join(home, "workspace")
  const serverConfig = join(home, "server-config")
  await run("mkdir", ["-p", workspace, serverConfig])

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
  const localSessions = await local.listPage({ limit: 50 })
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

  await run(wranglerBin, ["d1", "migrations", "apply", "ycoding-prod-db", "--local", "--config", configPath])
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
  const nonce = await readNonce(await sha256Hex(cookieValue(oauthCookie)))
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
  cookie = cookiePair(callback, "yc_session")
  expect(cookie.includes("yc_session="), "Google sign-in did not issue a browser session")
  checks.push("browser signed in through the real relay with a Google stand-in")

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
  await waitFor(
    () => (store.state().advertised.includes(sessionID) ? true : undefined),
    20_000,
    "the browser never loaded the backend Session inventory",
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

  await store.selectSession(sessionID)
  await waitFor(
    () => (store.state().view?.id === sessionID ? true : undefined),
    20_000,
    "the store never selected the shared session",
  )

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
    const deadline = Date.now() + 30_000
    for (;;) {
      const listed = await probeRequest("session.guardrail.request.list", { sessionID: guardSessionID })
      if (listed.status === "ok" && isRecord(listed.value) && Array.isArray(listed.value.data)) {
        const matching = listed.value.data.filter(
          (row) => isRecord(row) && typeof row.id === "string" && JSON.stringify(row.resources ?? []).includes(command),
        )
        if (matching.length > 0) return matching.at(-1) as Record<string, unknown>
      }
      if (Date.now() >= deadline)
        throw new Error(`Real-flow check failed: no guardrail review was raised (${label})`)
      await Bun.sleep(200)
    }
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
    const active = await probeRequest("session.active")
    if (active.status !== "ok" || !isRecord(active.value) || !isRecord(active.value.data)) return false
    return !(guardSessionID in active.value.data)
  }

  const guardrailPending = async (requestID: string) => {
    const listed = await probeRequest("session.guardrail.request.list", { sessionID: guardSessionID })
    if (listed.status !== "ok" || !isRecord(listed.value) || !Array.isArray(listed.value.data)) return undefined
    return listed.value.data.some((row) => isRecord(row) && row.id === requestID)
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
  expect(executing.status === "ok", `interrupt prompt failed: ${JSON.stringify(executing)}`)
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
} finally {
  for (const dispose of disposals.reverse()) await dispose().catch(() => undefined)
  wrangler?.kill()
  google?.stop(true)
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
async function readNonce(transactionID: string): Promise<string> {
  const output = await run(wranglerBin, [
    "d1",
    "execute",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
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
