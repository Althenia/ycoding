/**
 * Composed real-flow proof.
 *
 * Joins the real components instead of one faked side:
 *
 * - real isolated Rust runtime with private config and storage
 * - real backend-owned connector, dialing out over binary v5 with a device credential
 * - real browser client: `apps/web` `createRemoteStore` + `createRemoteHttp` +
 *   `createRemoteTransport` pointed at the loopback relay
 * - real relay: `wrangler dev` with real D1, the real `DeviceRelay` Durable Object,
 *   the built static assets, and a local Google OIDC stand-in
 *
 * The model boundary is a stand-in: an OpenAI-compatible SSE endpoint on localhost
 * (fixed text, plus a hold mode used for the interrupt proof). Provider identity,
 * quotas, retries, and real vendor payloads are not exercised. The exact-id
 * admission proof deliberately admits with `resume: false` so admission semantics
 * are isolated from execution; the execution proof runs real Rust Session steps,
 * including provider-emitted shell and question tool calls. No deployment, no real
 * credentials. Chrome push additionally reaches its real push service.
 *
 * Usage: bun infra/cloudflare/test/integration/real-flow.ts
 */

import { spawn, type WebSocketOptions } from "bun"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { crc32 } from "node:zlib"
import {
  RemoteLimits,
  RemoteWebSocketPath,
  parsePushTestResponse,
  decodeStrict,
  FrameSchema,
  LedgerClass,
} from "../../../../packages/remote/src/index"
import { operations } from "../../../../packages/protocol/src/v5"
import { startRustRuntime, readRelayContent } from "./rust-runtime"
import { createRemoteHttp } from "../../../../apps/web/src/remote/http"
import { createPushHttp } from "../../../../apps/web/src/remote/http"
import { generateVapidKeys } from "../../script/vapid-keys"
import { deriveWebPushKeys } from "../../src/push/crypto"
import { createRemoteStore } from "../../../../apps/web/src/remote/store"
import { loadWorkspaces } from "../../../../apps/web/test/remote-queries"
import { openChromePush } from "./chrome-push"
import { parsePushDiagnostic, type PushDiagnostic } from "./push-diagnostic"
import { createRemoteTransport, type RemoteTransportStatus } from "../../../../apps/web/src/remote/transport"
import { base64UrlEncode } from "../../src/auth/crypto"
import { deltaChunk, finishChunk, toolCallChunk } from "../../../../packages/ai/test/lib/openai-chunks"

const repositoryRoot = new URL("../../../../", import.meta.url).pathname
const wranglerBin = `${repositoryRoot}node_modules/.bin/wrangler`
const configPath = "infra/cloudflare/wrangler.jsonc"
const workerPort = 8807
const workerOrigin = `http://127.0.0.1:${workerPort}`
const socketOrigin = `ws://127.0.0.1:${workerPort}`
const allowedEmail = "flow@example.invalid"
const sessionID = "ses_real_flow_shared"
const hiddenSessionID = "ses_real_flow_hidden"
const sideChatID = "ses_real_flow_btw"
const sideChatPromptID = "msg_real_flow_btw_prompt"
const promptID = "msg_real_flow_prompt"
const otherPromptID = "msg_real_flow_other"
const executionPromptID = "msg_real_flow_execute"
const providerID = "flow-local"
const providerModel = "flow-model"
const providerText = "Local stand-in reply: the composed flow executes."
const guardSessionID = "ses_real_flow_guard"

const checks: string[] = []
const failures: unknown[] = []
const NativeSocket = WebSocket as typeof WebSocket & { new (url: string, options: WebSocketOptions): WebSocket }
let heldReply: { socket: WebSocket; callbacks: (() => void)[]; observed: () => void } | undefined
class ReplyGateSocket extends NativeSocket {
  override addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: WebSocket, event: WebSocketEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type !== "message" || listener === null) {
      super.addEventListener(type, listener, options)
      return
    }
    super.addEventListener(
      type,
      (event) => {
        const deliver = () =>
          typeof listener === "function" ? listener.call(this, event) : listener.handleEvent(event)
        const gate = heldReply
        if (gate?.socket !== this) {
          deliver()
          return
        }
        const frame = decodeStrict(FrameSchema, new Uint8Array((event as MessageEvent<ArrayBuffer>).data))
        if (frame.ledger === LedgerClass.TINY || frame.ledger === 0) {
          deliver()
          return
        }
        expect(gate.callbacks.length < 64, "Held native browser delivery exceeded its fixture bound")
        gate.callbacks.push(deliver)
        if (
          frame.body.case === "result" &&
          frame.body.value.operationId ===
            operations.find((operation) => operation.diagnosticName === "session.prompt")!.operationId
        )
          gate.observed()
      },
      options,
    )
  }
}
const diagnostics: string[] = []
let wrangler: { kill: (signal?: NodeJS.Signals) => unknown; exited: Promise<number> } | undefined
let google: ReturnType<typeof Bun.serve> | undefined
let connectorState = "off"
let disposals: (() => Promise<void>)[] = []
let home: string | undefined

try {
  await run("cargo", [
    "build",
    "--locked",
    "--manifest-path",
    "rust/Cargo.toml",
    "--target-dir",
    join(repositoryRoot, "rust/target"),
    "--jobs",
    "3",
    "-p",
    "ycoding-runtime",
    "--bin",
    "ycoding-runtime",
  ])
  await mkdir(join(repositoryRoot, ".cache/tmp"), { recursive: true })
  const root = await mkdtemp(join(repositoryRoot, ".cache/tmp/ycoding-real-flow-"))
  home = root
  const workspace = join(root, "workspace")
  const openedWorkspace = join(root, "opened-only")
  const serverConfig = join(root, "server-config")
  const persist = join(root, "wrangler-state")
  await run("mkdir", ["-p", workspace, serverConfig, openedWorkspace])
  await Bun.write(join(openedWorkspace, "find-this.txt"), "Catalog file search")
  await mkdir(join(serverConfig, "skills", "flow-explicit"), { recursive: true })
  const skillInstructions = "Composed-flow explicit skill instructions must be present before the first reply."
  await Bun.write(
    join(serverConfig, "skills", "flow-explicit", "SKILL.md"),
    `---\nname: Flow explicit\nmetadata:\n  ycoding/autoinvoke: false\n---\n${skillInstructions}\n`,
  )

  /* -------------------------------------- deterministic local provider stand-in */

  // The model boundary is a stand-in: an OpenAI-compatible SSE endpoint on
  // localhost. Everything else in this flow is production code.
  const providerRequests: unknown[] = []
  let providerMode: "instant" | "hold" = "instant"
  let releaseStream: (() => void) | undefined
  const releaseHeldStream = () => releaseStream?.()
  // One scripted tool call per prompt, then plain text for the follow-up turn.
  let providerTurn: {
    readonly tool?: { readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
    readonly text: string
    readonly prompt?: string
  } = {
    text: providerText,
  }
  const providerShellCalls: { readonly id: string; readonly command: string }[] = []
  let providerFollowUpText = providerText
  const stub = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body: unknown = await request.json()
      providerRequests.push(body)
      const encoder = new TextEncoder()
      const prompt = providerTurn.prompt
      const selected =
        prompt === undefined ||
        (isRecord(body) &&
          Array.isArray(body.messages) &&
          body.messages.some(
            (message) =>
              isRecord(message) &&
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.startsWith(prompt),
          ))
      const turn = selected ? providerTurn : { text: providerFollowUpText }
      if (selected) providerTurn = { text: providerFollowUpText }
      const frames =
        turn.tool === undefined
          ? [deltaChunk({ role: "assistant" }), deltaChunk({ content: turn.text }), finishChunk("stop")]
          : (() => {
              if (turn.tool.name === "shell" && typeof turn.tool.input.command === "string")
                providerShellCalls.push({ id: turn.tool.id, command: turn.tool.input.command })
              return [
                toolCallChunk(turn.tool.id, turn.tool.name, JSON.stringify(turn.tool.input)),
                finishChunk("tool_calls"),
              ]
            })()
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

  // The isolated server reads its provider document from an isolated global config
  // directory, so no user configuration or credential participates.
  await Bun.write(
    join(serverConfig, "models.json"),
    JSON.stringify({
      [providerID]: {
        id: providerID,
        name: "Flow Local Stand-in",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          [providerModel]: {
            id: providerModel,
            name: "Flow Model",
            release_date: "2026-01-01",
            attachment: true,
            reasoning: false,
            tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128_000, output: 8192 },
            cost: { input: 1, output: 1 },
          },
        },
      },
    }),
  )
  await Bun.write(
    join(serverConfig, "ycoding.json"),
    JSON.stringify({
      model: { providerID, model: providerModel },
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
          name: "Flow Local Stand-in",
          package: "@ycoding-ai/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: "flow-stand-in-key" },
          models: {
            [providerModel]: {
              name: "Flow Model",
              capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
              limit: { context: 128_000, output: 8192 },
            },
          },
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

  await Bun.write(
    join(serverConfig, "models.json"),
    JSON.stringify({
      [providerID]: {
        id: providerID,
        name: "Flow Local Stand-in",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          [providerModel]: {
            id: providerModel,
            name: "Flow Model",
            release_date: "2026-01-01",
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128_000, output: 8192 },
          },
        },
      },
    }),
  )
  const server = await startRustRuntime(join(root, "runtime"), workspace, serverConfig)
  disposals.push(() => server.close())
  // The shared session runs under the approval agent, so a shell tool call raises a
  // real pending permission request instead of running unprompted.
  const local = server.client
  const sharedSession = await local.session.create({
    id: sessionID,
    location: { directory: workspace },
    model: { providerID, id: providerModel },
    agent: "flow-approval",
  })
  expect(sharedSession.id === sessionID, "approval session was not created")
  await local.session.create({
    id: hiddenSessionID,
    location: { directory: workspace },
    model: { providerID, id: providerModel },
  })
  const guardSession = await local.session.create({
    id: guardSessionID,
    location: { directory: workspace },
    model: { providerID, id: providerModel },
    agent: "flow-guard",
  })
  expect(guardSession.id === guardSessionID, "guardrail session was not created")
  checks.push("real isolated Rust runtime created the approval, hidden, and guardrail Sessions")

  const opened = await local.location.get({ location: { directory: openedWorkspace } })
  expect(opened.directory === openedWorkspace, "opening a workspace returned another directory")
  const localSessions = await local.session.list({ limit: 50 })
  expect(
    !localSessions.data.some((info) => info.location.directory === openedWorkspace),
    "opening a directory created a Session",
  )
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
      if (url.pathname === "/token")
        return Response.json({ id_token: idTokenHolder.value, access_token: "access-token" })
      if (url.pathname === "/certs") return Response.json({ keys: [identityKey.jwk] })
      return new Response("not found", { status: 404 })
    },
  })
  const googleOrigin = `http://127.0.0.1:${google.port}`
  const vapid = await generateVapidKeys()
  const adminKey = "A".repeat(48)
  const servedPublicKeyHash = await sha256Hex(vapid.VAPID_PUBLIC_KEY)
  let chromeEndpointHash: string | undefined
  const pushDiagnostics: PushDiagnostic[] = []
  const pushRequests: { method: string; ttl: string | null; body: Uint8Array }[] = []
  const pushStub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/relay-settled") return new Response(null, { status: 201 })
      if (new URL(request.url).pathname === "/push-diagnostic") {
        const evidence = parsePushDiagnostic(await request.json().catch(() => undefined))
        if (evidence === undefined) return new Response("Invalid push diagnostic", { status: 400 })
        pushDiagnostics.push(evidence)
        console.log(
          JSON.stringify({
            component: "push-diagnostic",
            ...evidence,
            endpointMatchesChrome:
              chromeEndpointHash === undefined ? "unreported" : evidence.endpointHash === chromeEndpointHash,
          }),
        )
        return new Response(null, { status: 201 })
      }
      pushRequests.push({
        method: request.method,
        ttl: request.headers.get("ttl"),
        body: new Uint8Array(await request.arrayBuffer()),
      })
      return new Response(null, { status: 201 })
    },
  })
  disposals.push(async () => pushStub.stop(true))

  await run(wranglerBin, [
    "d1",
    "migrations",
    "apply",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
    "--persist-to",
    persist,
  ])
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
      "infra/cloudflare/test/integration/push-stub-worker.ts",
      "--config",
      configPath,
      "--define",
      `PUSH_STUB_PORT:${pushStub.port}`,
      "--define",
      `PUSH_SERVED_PUBLIC_KEY_HASH:${JSON.stringify(servedPublicKeyHash)}`,
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
      "--var",
      `VAPID_PUBLIC_KEY:${vapid.VAPID_PUBLIC_KEY}`,
      "--var",
      `VAPID_PRIVATE_KEY:${vapid.VAPID_PRIVATE_KEY}`,
      "--var",
      "VAPID_SUBJECT:mailto:push@example.invalid",
      "--var",
      `ADMIN_API_KEY:${adminKey}`,
    ],
    { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" },
  )
  await waitForWorker()

  /* --------------------------------------------------- browser sign-in (real) */

  let cookie = ""
  const browserFetch: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers)
      if (cookie !== "") headers.set("cookie", cookie)
      headers.set("origin", workerOrigin)
      headers.set("sec-fetch-site", "same-origin")
      return fetch(input, { ...init, headers })
    },
    { preconnect: fetch.preconnect },
  )

  const signInInput = {
    pair: identityKey.pair,
    token: idTokenHolder,
    issuer: googleOrigin,
    subject: `flow-subject-${crypto.randomUUID()}`,
    persist,
  }
  const receiverIdentity = await signInBrowser(signInInput)
  cookie = receiverIdentity.cookie
  checks.push("browser signed in through the real relay with a Google stand-in")

  const pushHttp = createPushHttp({ baseURL: workerOrigin, fetch: browserFetch })
  const pushKey = await pushHttp.key()
  expect(
    pushKey.ok && pushKey.value.publicKey === vapid.VAPID_PUBLIC_KEY,
    "the authenticated push key route did not return this deployment's public key",
  )
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!(receiver instanceof Object) || !("publicKey" in receiver)) throw new Error("ECDH pair unavailable")
  const pushAuth = crypto.getRandomValues(new Uint8Array(16))
  const pushReceiver = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))
  const endpoint = "https://fcm.googleapis.com/fcm/send/flow-local-only"
  const pushKeys = { p256dh: base64UrlEncode(pushReceiver), auth: base64UrlEncode(pushAuth) }
  const registeredPush = await pushHttp.subscribe({
    endpoint,
    keys: pushKeys,
    categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true, "quota-pace": true },
  })
  const decryptPush = async (request: { readonly body: Uint8Array }): Promise<Record<string, unknown>> => {
    const sender = request.body.slice(21, 86)
    const publicSender = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: publicSender }, receiver.privateKey, 256),
    )
    const { cek, nonce } = await deriveWebPushKeys(shared, pushAuth, pushReceiver, sender, request.body.slice(0, 16))
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
    const clear = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, request.body.slice(86)),
    )
    const payload: unknown = JSON.parse(new TextDecoder().decode(clear.slice(0, -1)))
    if (!isRecord(payload)) throw new Error("the push payload was not an object")
    return payload
  }
  expect(
    registeredPush.ok,
    `the authenticated push subscription was not stored in local D1: ${JSON.stringify(registeredPush)}`,
  )
  checks.push("push key and subscription reached the real Worker and local D1")

  /* --------------------------------------------------- real browser store */

  const http = createRemoteHttp({ baseURL: workerOrigin, fetch: browserFetch })
  const events: unknown[] = []
  const clientSockets: WebSocket[] = []
  const browserStatuses: RemoteTransportStatus[] = []
  const sessionStatuses: unknown[] = []
  const settlements: { operation: string; status: string }[] = []
  const store = createRemoteStore({
    http,
    createTransport: (deviceID, handlers) => {
      const remote = createRemoteTransport({
        url: `${socketOrigin}${RemoteWebSocketPath.client}?device=${deviceID}`,
        handlers: {
          ...handlers,
          onStatus: (status) => {
            browserStatuses.push(status)
            handlers.onStatus?.(status)
          },
          onSessionStatus: (status) => {
            sessionStatuses.push(status)
            handlers.onSessionStatus?.(status)
          },
          onEvents: (eventSessionID, batch) => {
            for (const event of batch) events.push({ sessionID: eventSessionID, event })
            handlers.onEvents?.(eventSessionID, batch)
          },
        },
        createSocket: (url) => {
          const socket = new ReplyGateSocket(url, { headers: { cookie, origin: workerOrigin } })
          socket.addEventListener("message", (event) => {
            const frame = decodeStrict(FrameSchema, new Uint8Array(event.data))
            if (frame.body.case === "control" && frame.body.value.kind.case === "resyncRequired")
              events.push({ resync: frame.body.value.kind.value })
          })
          clientSockets.push(socket)
          return socket
        },
      })
      return {
        ...remote,
        request: async (operation, request) => {
          const outcome = await remote.request(operation, request)
          settlements.push({ operation, status: outcome.status })
          if (outcome.status !== "ok") diagnostics.push(JSON.stringify({ operation, request, outcome }))
          return outcome
        },
      }
    },
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
  checks.push("browser store minted a one-use enrollment code through the relay")

  /* ----------------------------------------------------- real CLI enrollment */

  const enrolled = await local.remote.enroll({
    relayOrigin: workerOrigin,
    enrollmentID: enrollment.value.enrollmentID,
    code: enrollment.value.code,
    name: "Composed Flow Device",
  })
  expect(enrolled.relayOrigin === workerOrigin, "the Rust identity was not bound to the relay origin")
  checks.push("real Rust credential module enrolled the device against the real relay")

  const retiredEnrollment = await http.createEnrollment()
  expect(retiredEnrollment.ok, "the relay could not create a second enrollment for cleanup")
  const retiredRuntime = await startRustRuntime(join(root, "retired-runtime"), workspace, serverConfig)
  disposals.push(() => retiredRuntime.close())
  const retired = await retiredRuntime.client.remote.enroll({
    relayOrigin: workerOrigin,
    enrollmentID: retiredEnrollment.value.enrollmentID,
    code: retiredEnrollment.value.code,
    name: "Retired Flow Device",
  })
  expect((await http.revokeDevice(retired.deviceID)).ok, "the retired device could not be revoked")
  expect((await http.removeRevokedDevices(retired.deviceID)).ok, "the revoked device could not be removed")
  expect((await http.removeRevokedDevices(retired.deviceID)).ok, "removing the same revoked device was not idempotent")
  expect((await http.removeRevokedDevices()).ok, "removing all remaining revoked devices failed")
  const afterRemoval = await http.devices()
  expect(
    afterRemoval.ok &&
      afterRemoval.value.some((entry) => entry.id === enrolled.deviceID) &&
      !afterRemoval.value.some((entry) => entry.id === retired.deviceID),
    "cleanup changed an enrolled device or kept a revoked device",
  )
  checks.push("same-origin owner removed a revoked device idempotently without deleting the enrolled device")

  await local.remote.set({ enabled: true })
  expect(existsSync(join(server.state, "remote-device.json")), "the Rust identity file was not written")
  disposals.push(async () => {
    await local.remote.set({ enabled: false })
  })
  await waitFor(
    async () => {
      const state = await local.remote.get()
      connectorState = state.state
      return state.state === "on" && state.device?.credentialState === "valid" ? true : undefined
    },
    20_000,
    "the Rust connector never authenticated and went live",
  )
  checks.push("real Rust connector persisted its device identity and connected with a signed device credential")

  /* ------------------------------------------ browser device + Session discovery */

  await waitFor(
    async () => {
      await store.load()
      return store.state().devices.some((info) => info.id === enrolled.deviceID && info.online) ? true : undefined
    },
    20_000,
    "the connected enrolled device is not online in the browser device list",
  )
  store.connect(enrolled.deviceID)
  const sharedWorkspace = await waitFor(
    () => store.state().sessionGroups.find((group) => group.directory === workspace),
    20_000,
    "the browser did not list the shared Session workspace",
  )
  store.selectWorkspace(sharedWorkspace.id)
  await waitFor(
    () => (store.state().advertised.includes(sessionID) ? true : undefined),
    20_000,
    () =>
      `the browser never loaded the backend Session inventory: ${JSON.stringify({ connection: store.state().connection, transport: store.state().transport, list: store.state().sessionListStatus, selectedWorkspace: store.state().selectedWorkspaceID, groups: store.state().sessionGroups.map((group) => group.directory), advertised: store.state().advertised, sessions: store.state().sessions.map((session) => session.id), notice: store.state().notice, statuses: browserStatuses.slice(-5), connectorState })}`,
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
  await local.session.create({
    id: futureSessionID,
    location: { directory: workspace },
    model: { providerID, id: providerModel },
  })
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
    createSocket: (url) => new NativeSocket(url, { headers: { cookie, origin: workerOrigin } }),
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

  // The v5 connector broadcasts InventoryInvalidated on establishment and on
  // Session creation/update/deletion; it does not replay it to later-joining
  // clients, so prove delivery with a real creation while the probe is connected.
  await local.session.create({
    id: "ses_real_flow_probe",
    location: { directory: workspace },
    model: { providerID, id: providerModel },
  })
  await waitFor(
    () => (probeInvalidated ? true : undefined),
    20_000,
    "probe client never received a Session invalidation",
  )
  const hidden = await probeRequest("session.get", { sessionID: hiddenSessionID })
  expect(hidden.status === "ok", `backend Session read failed: ${JSON.stringify(hidden)}`)
  checks.push("a backend Session needs no per-Session allow operation")

  const content = (kind: "messages" | "attachments", id: string) =>
    readRelayContent({ origin: workerOrigin, cookie, deviceID: enrolled.deviceID, sessionID, kind, id })

  const verifyLifecycle = async () => {
    const candidate = (await loadWorkspaces(store)).find((item) => item.directory === openedWorkspace)
    if (!candidate) throw new Error("the previously opened directory with no Sessions was not listed")
    const familyStatus = await probeRequest("session.status")
    expect(
      familyStatus.status === "ok" &&
        isRecord(familyStatus.value) &&
        Array.isArray(familyStatus.value.running) &&
        Array.isArray(familyStatus.value.attention),
      `family status failed: ${JSON.stringify(familyStatus)}`,
    )
    const latencySample = {
      kind: "request",
      at: new Date().toISOString(),
      operation: "session.list",
      outcome: "ok",
      queueMs: 431,
      settlementMs: 17,
      totalMs: 448,
    }
    const consentUndecided = await probeRequest("telemetry.consent.get")
    expect(
      consentUndecided.status === "ok" &&
        isRecord(consentUndecided.value) &&
        isRecord(consentUndecided.value.data) &&
        consentUndecided.value.data.noticeVersion === 1 &&
        consentUndecided.value.data.consent === undefined,
      `machine telemetry consent was not undecided through the relay: ${JSON.stringify(consentUndecided)}`,
    )
    const latencyRefused = await probeRequest("telemetry.append", { input: { samples: [latencySample] } })
    expect(
      latencyRefused.status === "failed" && latencyRefused.error.code === "telemetry_disabled",
      `machine latency was saved without consent: ${JSON.stringify(latencyRefused)}`,
    )
    const consentGranted = await probeRequest("telemetry.consent.set", { input: { enabled: true, noticeVersion: 1 } })
    expect(
      consentGranted.status === "ok" &&
        isRecord(consentGranted.value) &&
        isRecord(consentGranted.value.data) &&
        consentGranted.value.data.enabled === true,
      `machine telemetry consent was not saved through the relay: ${JSON.stringify(consentGranted)}`,
    )
    const latencySaved = await probeRequest("telemetry.append", { input: { samples: [latencySample] } })
    expect(
      latencySaved.status === "ok" && isRecord(latencySaved.value) && latencySaved.value.accepted === 1,
      `machine latency was not saved through the relay: ${JSON.stringify(latencySaved)}`,
    )
    const latencyListed = await probeRequest("telemetry.list", { input: { limit: 60 } })
    expect(
      latencyListed.status === "ok" &&
        isRecord(latencyListed.value) &&
        isRecord(latencyListed.value.data) &&
        Array.isArray(latencyListed.value.data.data) &&
        latencyListed.value.data.data.some(
          (row) =>
            isRecord(row) &&
            isRecord(row.sample) &&
            row.sample.queueMs === 431 &&
            row.sample.totalMs === 448 &&
            typeof row.receivedAt === "number",
        ),
      `saved machine latency was not readable through the relay: ${JSON.stringify(latencyListed)}`,
    )
    const localLatencyBody = await local.server.telemetry.list({ limit: 60 })
    expect(
      Array.isArray(localLatencyBody.data) &&
        localLatencyBody.data.some(
          (row) => row.sample.kind === "request" && row.sample.queueMs === 431 && row.sample.totalMs === 448,
        ),
      "relay latency did not persist in the connected local Server's SQLite",
    )
    checks.push(
      "machine telemetry consent was read and granted through the relay; anonymous Web latency was refused without consent, then traversed the authenticated hosted relay and connector into local SQLite and remained readable without relay storage",
    )
    const memberActivity = await probeRequest("session.family.activity", { sessionID, input: { sessionIDs: [] } })
    expect(
      memberActivity.status === "ok" &&
        isRecord(memberActivity.value) &&
        Array.isArray(memberActivity.value.data) &&
        memberActivity.value.data.length === 1 &&
        isRecord(memberActivity.value.data[0]) &&
        memberActivity.value.data[0].sessionID === sessionID &&
        memberActivity.value.data[0].executing === false,
      `family activity failed: ${JSON.stringify(memberActivity)}`,
    )
    const sideChat = await probeRequest("session.side-chat.create", { sessionID, input: { id: sideChatID } })
    expect(
      sideChat.status === "ok" &&
        isRecord(sideChat.value) &&
        isRecord(sideChat.value.data) &&
        sideChat.value.data.parentID === sessionID &&
        sideChat.value.data.agent === "btw",
      `remote side chat creation failed: ${JSON.stringify(sideChat)}`,
    )
    const sideChats = await probeRequest("session.side-chat.list", { sessionID })
    expect(
      sideChats.status === "ok" &&
        isRecord(sideChats.value) &&
        Array.isArray(sideChats.value.data) &&
        sideChats.value.data.some((item) => isRecord(item) && item.id === sideChatID),
      `remote side chat listing failed: ${JSON.stringify(sideChats)}`,
    )
    const btwPrompt = await probeRequest("session.prompt", {
      sessionID: sideChatID,
      input: { id: sideChatPromptID, text: "Ask a side question", resume: false },
    })
    expect(btwPrompt.status === "ok", `BTW prompt was rejected: ${JSON.stringify(btwPrompt)}`)
    const shellBody = await local.shell.create({
      command: "sleep 120",
      timeout: 120_000,
      metadata: { sessionID },
      location: { directory: workspace },
    })
    const shellID = shellBody.data.id
    expect(typeof shellID === "string", `family shell ID missing: ${JSON.stringify(shellBody)}`)
    const shellPage = await probeRequest("session.team.shell.list", { sessionID })
    expect(
      shellPage.status === "ok" &&
        isRecord(shellPage.value) &&
        Array.isArray(shellPage.value.data) &&
        shellPage.value.data.some((item) => isRecord(item) && item.id === shellID && item.ownerID === sessionID),
      `family shell was not listed: ${JSON.stringify(shellPage)}`,
    )
    const shellKilled = await probeRequest("session.team.shell.kill", { sessionID, input: { shellID } })
    expect(shellKilled.status === "ok", `family shell kill failed: ${JSON.stringify(shellKilled)}`)
    checks.push(
      "BTW side chat creation, listing, and prompt plus family-owned shell listing and kill crossed the real relay",
    )
    const selectedCatalog = await probeRequest("catalog.get", { workspaceID: candidate.id })
    expect(
      selectedCatalog.status === "ok" &&
        isRecord(selectedCatalog.value) &&
        isRecord(selectedCatalog.value.data) &&
        Array.isArray(selectedCatalog.value.data.agents) &&
        Array.isArray(selectedCatalog.value.data.models) &&
        !("defaultAgent" in selectedCatalog.value.data),
      `workspace catalog failed: ${JSON.stringify(selectedCatalog)}`,
    )
    const found = await waitFor(
      async () => {
        const result = await probeRequest("fs.find", {
          workspaceID: candidate.id,
          input: { query: "find-this", limit: 5 },
        })
        return result.status === "ok" &&
          isRecord(result.value) &&
          !("location" in result.value) &&
          Array.isArray(result.value.data) &&
          result.value.data.some(
            (file) =>
              isRecord(file) &&
              file.path === "find-this.txt" &&
              file.type === "file" &&
              typeof file.uri === "string" &&
              file.uri.length > 0,
          )
          ? result
          : undefined
      },
      20_000,
      "workspace file search never returned the indexed file",
    )
    expect(found.status === "ok", `workspace file search failed: ${JSON.stringify(found)}`)
    checks.push("family status, location catalog, and bounded file search crossed the real relay")
    const quotas = await probeRequest("providerUsage.list")
    const quotaKeys: string[] = []
    const collectKeys = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collectKeys)
      if (!isRecord(value)) return
      for (const [key, entry] of Object.entries(value)) {
        quotaKeys.push(key)
        collectKeys(entry)
      }
    }
    if (quotas.status === "ok") collectKeys(quotas.value)
    expect(
      quotas.status === "ok" &&
        isRecord(quotas.value) &&
        isRecord(quotas.value.location) &&
        quotas.value.location.directory === workspace &&
        Array.isArray(quotas.value.data) &&
        quotas.value.data.every(
          (snapshot) =>
            isRecord(snapshot) &&
            typeof snapshot.source === "string" &&
            typeof snapshot.stability === "string" &&
            Array.isArray(snapshot.windows),
        ) &&
        !quotaKeys.some((key) => /credential|apiKey|email|raw/i.test(key)),
      `normalized provider usage lacked the backend-resolved location, labels, or leaked secrets: ${JSON.stringify(quotas)}`,
    )
    const summary = await probeRequest("usage.get")
    expect(
      summary.status === "ok" && isRecord(summary.value) && isRecord(summary.value.data),
      `backend usage summary failed: ${JSON.stringify(summary)}`,
    )
    const report = await probeRequest("usage.report", { input: { group: "model", limit: 2 } })
    expect(
      report.status === "ok" &&
        isRecord(report.value) &&
        isRecord(report.value.data) &&
        report.value.data.group === "model",
      `backend usage report failed: ${JSON.stringify(report)}`,
    )
    const localReport = await probeRequest("usage.report", {
      input: { group: "day", timeZone: "Asia/Kathmandu", limit: 2 },
    })
    expect(
      localReport.status === "ok" &&
        isRecord(localReport.value) &&
        isRecord(localReport.value.data) &&
        localReport.value.data.group === "day",
      `local-time usage report failed: ${JSON.stringify(localReport)}`,
    )
    checks.push("normalized provider quotas, retained summary, and grouped report crossed the real relay")
    const beforeCreate = providerRequests.length
    const createdID = await store.createSession({ workspaceID: candidate.id })
    if (!createdID) throw new Error(`remote creation failed: ${JSON.stringify(store.state().sessionCreation)}`)
    const created = await local.session.get({ sessionID: createdID })
    expect(
      created.parentID === undefined && created.projectID === candidate.projectID,
      "remote creation did not make a root in the selected project",
    )
    expect(providerRequests.length === beforeCreate, "session creation unexpectedly called the model")
    const adopted = await probeRequest("session.create", { workspaceID: candidate.id, input: { id: createdID } })
    expect(
      adopted.status === "ok",
      `idempotent creation failed: ${JSON.stringify({
        adopted,
        probeStatuses: probeStatuses.slice(-8),
        browserStatuses: browserStatuses.slice(-8),
        canonical: await local.session.get({ sessionID: createdID }),
      })}`,
    )
    expect(
      (await local.session.list({ limit: 50 })).data.filter((info) => info.id === createdID).length === 1,
      "exact creation retry duplicated the Session",
    )
    await store.selectSession(createdID)
    expect(store.state().view?.messages.length === 0, "the new Session was not an empty conversation")
    providerFollowUpText = "Reply in the remotely created Session."
    providerTurn = { text: providerFollowUpText }
    await store.sendPrompt({
      text: "Start in the previously opened workspace",
      delivery: "steer",
      skills: ["flow-explicit"],
    })
    await waitFor(
      async () => {
        const messages = await local.message.list({ sessionID: createdID })
        return JSON.stringify(messages).includes(providerFollowUpText) ? true : undefined
      },
      30_000,
      "the remotely created Session did not execute and persist its first prompt",
    )
    await waitFor(
      () => (JSON.stringify(store.state().view?.messages).includes(providerFollowUpText) ? true : undefined),
      20_000,
      "the new Session reply did not reach the browser store",
    )
    checks.push(
      "previously opened workspace without Sessions created an idle root, adopted an exact retry, and executed its first chat prompt",
    )
    const firstPromptRequest = providerRequests
      .slice(beforeCreate)
      .find((body) => JSON.stringify(body).includes("Start in the previously opened workspace"))
    expect(
      firstPromptRequest !== undefined && JSON.stringify(firstPromptRequest).includes(skillInstructions),
      "explicit remote skill content was absent from the first provider request",
    )
    expect(
      (await local.message.list({ sessionID: createdID })).filter(
        (message) => message.type === "skill" && message.skill === "flow-explicit",
      ).length === 1,
      "explicit remote skill did not produce exactly one durable activation",
    )
    checks.push(
      "explicit skill selection crossed the browser, relay, and connector into the first provider request without a model tool decision",
    )

    for (const level of [1, 2, 0] as const) {
      await store.setYolo(level)
      const autonomy = await local.session.autonomy.get({ sessionID: createdID })
      expect(isRecord(autonomy) && autonomy.yolo === level, `YOLO ${level} did not persist on the selected Session`)
      expect(store.state().view?.autonomy?.yolo === level, `YOLO ${level} did not reach the browser store`)
    }
    for (const enabled of [true, false]) {
      expect(await store.setAutoAnswer(enabled), "Session auto-answer update failed")
      const autonomy = await local.session.autonomy.get({ sessionID: createdID })
      expect(isRecord(autonomy) && autonomy.autoAnswer === enabled, "Session auto-answer did not persist")
      expect(
        store.state().view?.autonomy?.autoAnswer === enabled,
        "Session auto-answer did not reach the browser store",
      )
      const unrelated = await local.session.autonomy.get({ sessionID })
      expect(isRecord(unrelated) && unrelated.autoAnswer !== true, "Session auto-answer propagated to another Session")
    }
    checks.push(
      "approval levels 0–2 and Session-local auto-answer round-trip through the relay without changing another Session",
    )
    await store.setYolo(2)
    providerFollowUpText = "Reply after the YOLO-approved shell call."
    providerTurn = {
      tool: { id: "call_flow_yolo", name: "shell", input: { command: "touch yolo-approved.txt" } },
      text: "",
      prompt: "Run the harmless YOLO approval check",
    }
    await store.sendPrompt({ text: "Run the harmless YOLO approval check", delivery: "steer" })
    await waitFor(
      () => (existsSync(join(openedWorkspace, "yolo-approved.txt")) ? true : undefined),
      30_000,
      "YOLO 2 did not automatically approve the ask-permission shell call",
    )
    await waitFor(
      async () =>
        JSON.stringify(await local.message.list({ sessionID: createdID })).includes(providerFollowUpText)
          ? true
          : undefined,
      30_000,
      "the YOLO-approved step did not settle",
    )
    await store.setYolo(0)
    await store.setGoal("Finish the remote lifecycle verification")
    await waitFor(
      () =>
        store.state().view?.autonomy?.mode === "goal" && store.state().view?.autonomy?.goal?.status === "active"
          ? true
          : undefined,
      30_000,
      "goal start did not reach the browser store",
    )
    await store.stopGoal()
    const stoppedGoal = await local.session.autonomy.get({ sessionID: createdID })
    expect(
      isRecord(stoppedGoal) && isRecord(stoppedGoal.goal) && stoppedGoal.goal.status === "stopped",
      `goal stop did not persist: ${JSON.stringify({ autonomy: stoppedGoal, mutations: store.state().mutations, statuses: browserStatuses.slice(-5) })}`,
    )
    await waitFor(
      async () => {
        const active = await local.session.active()
        return isRecord(active) && !(createdID in active) ? true : undefined
      },
      30_000,
      "the stopped goal Session did not become idle",
    )
    checks.push("approval level 2 approved a real tool call, and goal start/stop reached durable runtime state")
    providerFollowUpText = providerText
    providerTurn = { text: providerText }

    await store.selectSession(sessionID)
    await waitFor(
      () => (store.state().view?.id === sessionID ? true : undefined),
      20_000,
      "the store never selected the shared session",
    )
    const initialTodos = [{ content: "Inspect the remote workspace", status: "pending", priority: "high" }] as const
    const savedTodos = await local.session.todo.update({ sessionID, todos: initialTodos })
    expect(JSON.stringify(savedTodos) === JSON.stringify(initialTodos), "the isolated Session todo update failed")
    const remoteTodos = await probeRequest("session.todo.list", { sessionID })
    expect(
      remoteTodos.status === "ok" && JSON.stringify(remoteTodos.value) === JSON.stringify({ data: initialTodos }),
      `the scoped remote todo read did not return the Protocol list: ${JSON.stringify(remoteTodos)}`,
    )
    const liveTodos = [{ content: "Check live todo delivery", status: "in_progress", priority: "medium" }] as const
    const liveUpdate = await local.session.todo.update({ sessionID, todos: liveTodos })
    expect(JSON.stringify(liveUpdate) === JSON.stringify(liveTodos), "the isolated live todo update failed")
    await waitFor(
      () => (JSON.stringify(store.state().todos) === JSON.stringify(liveTodos) ? true : undefined),
      20_000,
      "the selected remote Session did not receive its todo.updated event",
    )
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

    const pending = (await local.session.pending.list({ sessionID })).map((input) => input.id)
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
    checks.push("one real Rust Session prompt executed against the local provider stand-in and persisted")

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
      prompt: "Ask the composed-flow question",
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
    checks.push(
      "provider question tool created a native Form, remote store replied, and the Rust runner reached final text",
    )

    /* ---------------------------------------------- streamed event to the client */

    await local.session.rename({ sessionID, title: "Renamed by composed flow" })
    await waitFor(
      () => (events.some((entry) => JSON.stringify(entry).includes("Renamed by composed flow")) ? true : undefined),
      20_000,
      "no rename event reached the browser client through the relay",
    )
    checks.push("a real durable session event streamed through the agent and relay to the browser")

    /* ------------------------------------------------- reconnect: read, no replay */

    const beforeReconnect = (await local.session.pending.list({ sessionID })).map((input) => input.id)
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
    const afterReconnect = (await local.session.pending.list({ sessionID })).map((input) => input.id)
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
  }

  /* --------------------------- approval: deny, allow, and unauthorized replies */

  // Settle detection reads the local server directly: the relay read is asserted
  // where the relay path is the point, not for timing.
  const verifyPermissions = async () => {
    const localMessages = () => local.message.list({ sessionID })
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
      providerTurn = {
        tool: { id: `call_flow_${label}`, name: "shell", input: { command } },
        text: "",
        prompt: `run ${command}`,
      }
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
          if (ids.length > 0) return ids[ids.length - 1]
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
    expect(stillPending.status === "ok", `pending permission read failed: ${JSON.stringify(stillPending)}`)
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
  }

  /* --------------------- guardrail reviews: ordinary and hard, via the relay */

  const verifyGuardrails = async () => {
    const guardrailReviewFor = async (command: string, label: string) => {
      providerFollowUpText = `Stand-in reply after guardrail ${label}.`
      providerTurn = {
        tool: { id: `call_guard_${label}`, name: "shell", input: { command } },
        text: "",
        prompt: `run ${command}`,
      }
      const prompted = await probeRequest("session.prompt", {
        sessionID: guardSessionID,
        input: { id: `msg_guard_${label}`, text: `run ${command}` },
      })
      expect(
        prompted.status === "ok",
        `guardrail prompt (${label}) failed: ${JSON.stringify({
          prompted,
          connectorState,
          agentDiagnostics: diagnostics.slice(-4),
          browserStatuses: browserStatuses.slice(-6),
          probeStatuses: probeStatuses.slice(-6),
          largestEventChars: Math.max(0, ...events.map((event) => JSON.stringify(event).length)),
        })}`,
      )
      await waitFor(
        async () => {
          const localList = await local.guardrail.request.list({ sessionID: guardSessionID })
          return Array.isArray(localList) &&
            localList.some((row) => isRecord(row) && JSON.stringify(row.resources ?? []).includes(command))
            ? true
            : undefined
        },
        30_000,
        `no guardrail review was raised (${label})`,
      )
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
      probe.request("session.guardrail.request.reply", { sessionID: guardSessionID, input: { requestID, reply } })

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
      const active = await local.session.active()
      return isRecord(active) && !(guardSessionID in active) ? true : undefined
    }

    const guardrailPending = async (requestID: string) => {
      const listed = await local.guardrail.request.list({ sessionID: guardSessionID })
      if (!Array.isArray(listed)) return undefined
      return listed.some((row) => isRecord(row) && row.id === requestID)
    }

    const status = await probeRequest("session.guardrail.status", { sessionID: guardSessionID })
    expect(status.status === "ok", `guardrail status failed: ${JSON.stringify(status)}`)
    expect(
      status.status === "ok" &&
        isRecord(status.value) &&
        isRecord(status.value.data) &&
        typeof status.value.data.profile === "string",
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
    expect(
      (await Promise.all(pushRequests.map(decryptPush))).every((payload) => payload.category !== "agent-completed"),
      "an ordinary reply without an explicit completion declaration produced a finished-work push",
    )
    checks.push("hard review once ran the command and reject prohibited it")
  }

  /* --------------------------------------- interrupt through the real service */

  const verifyCompletion = async () => {
    const chromeIdentity = await signInBrowser(signInInput)
    expect(
      chromeIdentity.userID === receiverIdentity.userID,
      "Chrome and synthetic receiver signed into different accounts",
    )
    expect(
      (await sha256Hex(cookieValue(chromeIdentity.cookie))) !== (await sha256Hex(cookieValue(receiverIdentity.cookie))),
      "Chrome and synthetic receiver did not receive independent verified browser sessions",
    )
    const chrome = await openChromePush({ home: root, origin: workerOrigin, cookie: chromeIdentity.cookie })
    chromeEndpointHash = chrome.endpointHash
    disposals.push(() => chrome.close())
    expect(chrome.servedPublicKeyHash === servedPublicKeyHash, "Chrome read a different test VAPID public key")
    if (!process.argv.includes("--page-alert")) await chrome.leavePage()
    providerMode = "hold"
    releaseStream = undefined
    providerTurn = {
      tool: { id: "call_real_flow_complete", name: "task_complete", input: {} },
      text: "",
      prompt: "finish after the review",
    }
    const finishing = await probeRequest("session.prompt", {
      sessionID: guardSessionID,
      input: { id: "msg_real_flow_finish", text: "finish after the review" },
    })
    expect(finishing.status === "ok", `completion prompt failed: ${JSON.stringify(finishing)}`)
    await waitFor(
      () => (store.state().sessionStatus?.running.has(guardSessionID) ? true : undefined),
      30_000,
      "the finishing Session did not publish its running status",
    ).catch(async (cause: unknown) => {
      const messages = await local.message.list({ sessionID: guardSessionID })
      throw new Error(
        `Completion status evidence: ${JSON.stringify({
          localActive: await local.session.active(),
          heldResponse: releaseStream !== undefined,
          recentFrames: sessionStatuses.slice(-8),
          transport: store.state().transport,
          running: [...(store.state().sessionStatus?.running ?? [])],
          tail: messages.slice(-4).map((message) => ({
            type: message.type,
            ...(message.type === "assistant"
              ? {
                  finish: message.finish,
                  error: message.error,
                  content: message.content.map((part) => ({
                    type: part.type,
                    ...(part.type === "tool" ? { name: part.name, state: part.state } : {}),
                  })),
                }
              : {}),
          })),
        })}`,
        { cause },
      )
    })
    const finishStream = await waitFor(
      () => releaseStream,
      30_000,
      "the declared completion did not reach its final response",
    )
    const pushesBeforeFinish = pushRequests.length
    const diagnosticsBeforeFinish = pushDiagnostics.length
    finishStream()
    await waitFor(
      () =>
        store.state().sessionStatus?.running.has(guardSessionID) === false &&
        store.state().sessionStatus?.outstanding.has(guardSessionID) === false
          ? true
          : undefined,
      30_000,
      "the completed Session did not publish its finished status",
    )
    const finishedPush = await waitFor(
      async () => {
        const payloads = await Promise.all(
          pushRequests.slice(pushesBeforeFinish).map(async (request) => ({
            method: request.method,
            ttl: request.ttl,
            payload: await decryptPush(request),
          })),
        )
        return payloads.find(
          (item) =>
            item.method === "POST" &&
            item.ttl === "3600" &&
            item.payload.category === "agent-completed" &&
            item.payload.sessionID === guardSessionID &&
            item.payload.deviceID === enrolled.deviceID &&
            typeof item.payload.noticeID === "string",
        )
      },
      30_000,
      "the hibernatable Durable Object did not complete the declared Session's encrypted push POST with its notice id",
    )
    const finishedTag = `ycoding-${enrolled.deviceID}-${String(finishedPush?.payload.noticeID)}`
    const evidence = await waitFor(
      () => pushDiagnostics.slice(diagnosticsBeforeFinish).find((item) => item.endpointHash === chrome.endpointHash),
      30_000,
      "the Chrome push sending boundary did not report sanitized diagnostic evidence",
    )
    expect(
      evidence.publicKeyMatchesServed && evidence.jwtVerified && evidence.audienceMatches,
      "the Chrome push VAPID key, signature, or audience did not match the served test key and endpoint",
    )
    if (process.argv.includes("--page-alert")) {
      await waitFor(
        async () => {
          const tags = await chrome.pageAlerts()
          return Array.isArray(tags) && tags.includes(finishedTag) ? true : undefined
        },
        30_000,
        "the open workspace did not invoke the page-level service worker notification on completion",
      ).catch(async (cause: unknown) => {
        throw new Error(
          `Open-page notification evidence: ${JSON.stringify({
            pageAlerts: await chrome.pageAlerts(),
            notifications: await chrome.notifications(),
            finishedTag,
          })}`,
          { cause },
        )
      })
      checks.push("an open Chrome workspace invoked the page-level desktop notifier on a real family completion")
    } else {
      const notifications = await waitFor(
        async () => {
          const shown = await chrome.notifications()
          return Array.isArray(shown) &&
            shown.some((item) => isRecord(item) && item.title === "YCoding — work finished" && item.tag === finishedTag)
            ? shown
            : undefined
        },
        90_000,
        () => `headed Chrome did not show a decrypted Web Push notification from FCM (${JSON.stringify(evidence)})`,
      )
      expect(notifications.length > 0, "headed Chrome received no notification")
      checks.push(
        "headed Chrome received the FCM push through the built service worker and showed the finished-work notification",
      )
    }
    checks.push(
      "ordinary replies produced no completion push; explicit completion and final settlement produced an encrypted push with its stored notice id",
    )
  }

  const verifyInterrupt = async () => {
    const sideChats = await probeRequest("session.side-chat.list", { sessionID })
    expect(
      sideChats.status === "ok" && isRecord(sideChats.value) && Array.isArray(sideChats.value.data),
      `interrupt precondition could not list BTW children: ${JSON.stringify(sideChats)}`,
    )
    if (!sideChats.value.data.some((entry) => isRecord(entry) && entry.id === sideChatID)) {
      const created = await probeRequest("session.side-chat.create", { sessionID, input: { id: sideChatID } })
      expect(
        created.status === "ok",
        `interrupt precondition could not create its BTW child: ${JSON.stringify(created)}`,
      )
    }
    const sideChat = await local.session.get({ sessionID: sideChatID })
    expect(
      sideChat.parentID === sessionID && sideChat.agent === "btw",
      "interrupt precondition has the wrong BTW parent or agent",
    )
    const admitted = await probeRequest("session.prompt", {
      sessionID: sideChatID,
      input: { id: sideChatPromptID, text: "Ask a side question", resume: false },
    })
    expect(
      admitted.status === "ok",
      `interrupt precondition could not admit its BTW input: ${JSON.stringify(admitted)}`,
    )
    expect(
      (await local.session.pending.list({ sessionID: sideChatID })).some((input) => input.id === sideChatPromptID),
      "the admit-only BTW input did not remain pending before the interrupt",
    )
    const before = await local.session.outstanding()
    expect(
      before.data.includes(sideChatID) && !before.running.includes(sideChatID),
      `the BTW input did not establish non-running outstanding work: ${JSON.stringify(before)}`,
    )
    await waitFor(
      () => (store.state().sessionStatus?.outstanding.has(sessionID) ? true : undefined),
      20_000,
      "the BTW pending input was not projected to the shared root's outstanding status",
    )
    providerMode = "hold"
    releaseStream = undefined
    const heldEventStart = events.length
    providerTurn = { text: providerText, prompt: "hold the stream open" }
    const executing = await probeRequest("session.prompt", {
      sessionID,
      input: { id: "msg_real_flow_interrupt", text: "hold the stream open" },
    })
    expect(
      executing.status === "ok",
      `interrupt prompt failed: ${JSON.stringify({ executing, probeStatuses: probeStatuses.slice(-6) })}`,
    )
    await waitFor(
      () =>
        events
          .slice(heldEventStart)
          .some(
            (entry) =>
              isRecord(entry) &&
              entry.sessionID === sessionID &&
              isRecord(entry.event) &&
              entry.event.type === "session.text.delta" &&
              isRecord(entry.event.data) &&
              entry.event.data.delta === providerText,
          )
          ? true
          : undefined,
      30_000,
      "the held step never streamed content before the interrupt",
    )
    await waitFor(
      () => (store.state().sessionStatus?.running.has(sessionID) ? true : undefined),
      30_000,
      "the held step did not publish a running status baseline",
    )
    const interrupted = await probeRequest("session.interrupt", { sessionID })
    expect(interrupted.status === "ok", `interrupt failed: ${JSON.stringify(interrupted)}`)
    releaseHeldStream()
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
    await waitFor(
      () =>
        store.state().sessionStatus?.running.has(sessionID) === false &&
        store.state().sessionStatus?.outstanding.has(sessionID) === true
          ? true
          : undefined,
      30_000,
      "the interrupted Session lost its admitted outstanding work",
    ).catch(async (cause: unknown) => {
      throw new Error(
        `Interrupted-work evidence: ${JSON.stringify({
          localOutstanding: await local.session.outstanding({ failures: true }),
          pending: await local.session.pending.list({ sessionID }),
          recentFrames: sessionStatuses.slice(-8),
          running: [...(store.state().sessionStatus?.running ?? [])],
          outstanding: [...(store.state().sessionStatus?.outstanding ?? [])],
        })}`,
        { cause },
      )
    })
    const after = await local.session.outstanding()
    expect(
      after.data.includes(sideChatID) && !after.running.includes(sessionID),
      `interrupt did not preserve the original BTW obligation as non-running work: ${JSON.stringify(after)}`,
    )
    expect((await pushHttp.remove(endpoint)).ok, "the authenticated push subscription was not removed")
    checks.push("interrupt stopped the running step while the real local service retained admitted outstanding work")
  }

  const verifyChildren = async () => {
    providerMode = "instant"
    providerTurn = {
      tool: {
        id: "call_real_flow_child_question",
        name: "subagent_report",
        input: { action: "question", text: "Which environment should I verify?" },
      },
      text: "",
      prompt: "Ask which environment to verify",
    }
    const beforeCompetitor = providerRequests.length
    const competingPrompt = await local.session.prompt({
      sessionID: hiddenSessionID,
      id: "msg_real_flow_competing",
      text: "Answer the unrelated hidden Session",
    })
    expect(competingPrompt.id === "msg_real_flow_competing", "competing Session prompt was not admitted")
    const competingRequest = await waitFor(
      () =>
        providerRequests
          .slice(beforeCompetitor)
          .find(
            (body) =>
              isRecord(body) &&
              Array.isArray(body.messages) &&
              body.messages.some(
                (message) =>
                  isRecord(message) &&
                  message.role === "user" &&
                  typeof message.content === "string" &&
                  message.content.startsWith("Answer the unrelated hidden Session"),
              ),
          ),
      30_000,
      "the unrelated Session never reached the provider",
    )
    expect(
      isRecord(competingRequest) &&
        Array.isArray(competingRequest.messages) &&
        !JSON.stringify(competingRequest.tools ?? []).includes("subagent_report"),
      "the competing provider request was not an unrelated root request",
    )
    await waitFor(
      async () =>
        (await local.message.list({ sessionID: hiddenSessionID })).some(
          (message) => message.type === "assistant" && JSON.stringify(message).includes(providerFollowUpText),
        )
          ? true
          : undefined,
      30_000,
      "the unrelated Session did not receive the follow-up text",
    )
    const launchedQuestion = await local.session.subagent.launch({
      parentID: sessionID,
      parentAssistantMessageID: "msg_real_flow_team_parent",
      toolCallID: "call_real_flow_team_question",
      agent: "flow-child",
      description: "Verify the selected environment",
      prompt: "Ask which environment to verify",
      background: true,
    })
    const questionChildID = launchedQuestion.sessionID
    expect(typeof questionChildID === "string", `managed child ID missing: ${JSON.stringify(launchedQuestion)}`)
    const waitingChild = await waitFor(
      async () => {
        const page = await probeRequest("session.subagent.list", { sessionID })
        const data =
          page.status === "ok" && isRecord(page.value) && isRecord(page.value.data) ? page.value.data.data : undefined
        return Array.isArray(data)
          ? data.find(
              (item) =>
                isRecord(item) &&
                item.sessionID === questionChildID &&
                item.state === "waiting" &&
                isRecord(item.question),
            )
          : undefined
      },
      30_000,
      "the real managed child never raised a parent question",
    )
    expect(
      isRecord(waitingChild) && isRecord(waitingChild.question) && typeof waitingChild.question.id === "string",
      "managed child question ID missing",
    )
    if (!isRecord(waitingChild) || !isRecord(waitingChild.question)) throw new Error("managed child question missing")
    const answer = await probeRequest("session.subagent.answer", {
      sessionID,
      input: { childID: questionChildID, questionID: waitingChild.question.id, text: "staging" },
    })
    expect(
      answer.status === "ok" &&
        isRecord(answer.value) &&
        isRecord(answer.value.data) &&
        answer.value.data.sessionID === questionChildID,
      `managed child answer did not reach the real runner: ${JSON.stringify(answer)}`,
    )
    const economics = await probeRequest("session.team.economics", {
      sessionID,
      input: { sessionIDs: [questionChildID] },
    })
    expect(
      economics.status === "ok" &&
        isRecord(economics.value) &&
        Array.isArray(economics.value.data) &&
        economics.value.data.some(
          (item) =>
            isRecord(item) &&
            item.sessionID === questionChildID &&
            isRecord(item.tokens) &&
            typeof item.cost === "number",
        ),
      `bounded child economics failed: ${JSON.stringify(economics)}`,
    )
    const foreignEconomics = await probeRequest("session.team.economics", {
      sessionID,
      input: { sessionIDs: [hiddenSessionID] },
    })
    expect(
      foreignEconomics.status === "failed" && foreignEconomics.error.code === "forbidden",
      "unrelated Session economics escaped root-family authority",
    )
    checks.push(
      "managed child question/answer and bounded economics crossed the real relay; unrelated economics was refused",
    )

    providerMode = "hold"
    releaseStream = undefined
    providerTurn = { text: "Child held until cancellation.", prompt: "Wait for the parent to cancel" }
    const launchedCancel = await local.session.subagent.launch({
      parentID: sessionID,
      parentAssistantMessageID: "msg_real_flow_team_parent",
      toolCallID: "call_real_flow_team_cancel",
      agent: "flow-child",
      description: "Stop a held child",
      prompt: "Wait for the parent to cancel",
      background: true,
    })
    const cancelChildID = launchedCancel.sessionID
    expect(typeof cancelChildID === "string", `cancellable child ID missing: ${JSON.stringify(launchedCancel)}`)
    await waitFor(() => releaseStream, 30_000, "the cancellable child never reached its held provider response")
    const cancelled = await probeRequest("session.subagent.cancel", { sessionID, input: { childID: cancelChildID } })
    expect(
      cancelled.status === "ok" &&
        isRecord(cancelled.value) &&
        isRecord(cancelled.value.data) &&
        cancelled.value.data.sessionID === cancelChildID,
      `managed child cancellation failed: ${JSON.stringify(cancelled)}`,
    )
    releaseHeldStream()
    providerMode = "instant"
    checks.push("managed child cancellation reached the real Session orchestration through the relay")
  }

  const verifyAttachments = async () => {
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )
    const annotation = Buffer.from(`Comment\0${"A".repeat(102_400)}`)
    const chunkLength = Buffer.alloc(4)
    chunkLength.writeUInt32BE(annotation.length)
    const chunkType = Buffer.from("tEXt")
    const chunkCRC = Buffer.alloc(4)
    chunkCRC.writeUInt32BE(crc32(Buffer.concat([chunkType, annotation])))
    const png = Buffer.concat([
      pixel.subarray(0, pixel.length - 12),
      chunkLength,
      chunkType,
      annotation,
      chunkCRC,
      pixel.subarray(pixel.length - 12),
    ])
    await store.selectSession(sessionID)
    const imageSent = await store.sendPrompt({
      text: "Inspect uploaded PNG",
      delivery: "steer",
      files: [{ uri: `data:image/png;base64,${png.toString("base64")}`, name: "capture.png" }],
    })
    expect(imageSent, `browser image upload failed: ${store.state().uploadError ?? "unknown"}`)
    const imageMessage = await waitFor(
      async () =>
        (await local.message.list({ sessionID })).find(
          (message) => message.type === "user" && message.text === "Inspect uploaded PNG",
        ),
      30_000,
      "the uploaded image was not admitted into the local Session",
    )
    if (imageMessage.type !== "user") throw new Error("the uploaded image was not a user message")
    const imageFile = imageMessage.files?.[0]
    expect(
      imageFile !== undefined &&
        imageFile.mime === "image/png" &&
        imageFile.name === "capture.png" &&
        imageFile.content.bytes === png.length &&
        imageFile.content.digest === createHash("sha256").update(png).digest("hex"),
      "the local admitted image did not retain the source bytes and MIME",
    )
    checks.push("100 KiB PNG crossed browser upload chunks, relay, agent, and local attachment materialization")

    if (!imageFile) throw new Error("the uploaded image has no managed reference")
    const imageRead = await probeRequest("session.attachment.read", {
      sessionID,
      input: { digest: imageFile.content.digest },
    })
    if (imageRead.status !== "ok" || !isRecord(imageRead.value) || !(imageRead.value.data instanceof Uint8Array))
      throw new Error(`managed image read failed: ${JSON.stringify(imageRead)}`)
    expect(
      imageRead.value.mime === "image/png" &&
        imageRead.value.data.length === png.length &&
        createHash("sha256").update(imageRead.value.data).digest("hex") === imageFile.content.digest,
      "the relay attachment read changed the managed image bytes",
    )
    if (typeof imageRead.value.release === "function") imageRead.value.release()
    const hostedImage = await content("attachments", imageFile.content.digest)
    expect(
      hostedImage.status === "ok" &&
        hostedImage.delivery === "http" &&
        hostedImage.httpStatus === 200 &&
        hostedImage.value instanceof Uint8Array &&
        createHash("sha256").update(hostedImage.value).digest("hex") === imageFile.content.digest,
      "same-origin attachment stream changed or refused the managed image",
    )
    const unreferenced = await probeRequest("session.attachment.read", { sessionID, input: { digest: "f".repeat(64) } })
    expect(
      unreferenced.status === "failed" && unreferenced.error.code === "not_found",
      "an unreferenced managed digest was readable",
    )
    checks.push("a Session-scoped managed PNG read returned exact bytes and refused an unreferenced digest")

    const windowIDs: string[] = []
    let before: string | undefined
    let reachedOldest = false
    for (let page = 0; page < 100; page++) {
      const outcome = await probeRequest("session.snapshot", {
        sessionID,
        input: { limit: 1, ...(before === undefined ? {} : { before }) },
      })
      if (
        outcome.status !== "ok" ||
        !isRecord(outcome.value) ||
        !isRecord(outcome.value.data) ||
        !Array.isArray(outcome.value.data.messages)
      )
        throw new Error(`windowed snapshot page failed: ${JSON.stringify(outcome)}`)
      const messages = outcome.value.data.messages
      if (messages.length !== 1 || !isRecord(messages[0]) || typeof messages[0].id !== "string")
        throw new Error("windowed snapshot omitted its message")
      windowIDs.push(messages[0].id)
      if (typeof outcome.value.data.before !== "string") {
        reachedOldest = true
        break
      }
      before = outcome.value.data.before
    }
    expect(
      reachedOldest &&
        windowIDs.length >= 3 &&
        new Set(windowIDs).size === windowIDs.length &&
        windowIDs.includes(imageMessage.id),
      "windowed first/middle/last pages lost, duplicated, or skipped the admitted image",
    )
    checks.push("windowed snapshot pages chained from newest to oldest through the real relay")

    const messageRead = await content("messages", imageMessage.id)
    expect(messageRead.status === "ok", `scoped message stream failed: ${JSON.stringify(messageRead)}`)
    const recovered = messageRead.status === "ok" && isRecord(messageRead.value) ? messageRead.value.data : undefined
    expect(
      isRecord(recovered) &&
        recovered.id === imageMessage.id &&
        Array.isArray(recovered.files) &&
        isRecord(recovered.files[0]) &&
        isRecord(recovered.files[0].content) &&
        recovered.files[0].content.digest === imageFile.content.digest,
      "the real relay message read did not preserve the managed image reference",
    )
    checks.push("the indexed v5 message read returned the full projected item through the authenticated real relay")

    const pacedBytes = Buffer.alloc(1_100_000, 42)
    const pacedStart = performance.now()
    const statusCount = browserStatuses.length
    const pacing = store.sendPrompt({
      text: "Review paced binary",
      delivery: "steer",
      files: [{ uri: `data:application/octet-stream;base64,${pacedBytes.toString("base64")}`, name: "paced.bin" }],
    })
    await waitFor(
      () => (store.state().upload?.percent ? true : undefined),
      20_000,
      "the paced attachment never started uploading",
    )
    const concurrentWorkspaces = await loadWorkspaces(store)
    expect(
      concurrentWorkspaces.length > 0 && store.state().upload !== undefined,
      "a concurrent store read stalled behind the paced upload",
    )
    const pacedSent = await pacing
    expect(pacedSent, `paced upload was not accepted: ${store.state().uploadError ?? "unknown"}`)
    const pacedMessage = await waitFor(
      async () =>
        (await local.message.list({ sessionID })).find(
          (message) => message.type === "user" && message.text === "Review paced binary",
        ),
      60_000,
      "the paced upload was accepted but never admitted into the local Session",
    )
    expect(
      pacedMessage.type === "user" &&
        pacedMessage.files?.[0]?.content.bytes === pacedBytes.length &&
        pacedMessage.files[0].content.digest === createHash("sha256").update(pacedBytes).digest("hex"),
      "the paced upload did not preserve its admitted bytes",
    )
    const pacedDurationMs = Math.round(performance.now() - pacedStart)
    expect(
      store.state().transport.kind === "open" &&
        !browserStatuses.slice(statusCount).some((status) => status.kind === "closed" && status.code === 1008),
      "the paced upload tripped the relay request window",
    )
    console.log(`upload-1mib-ms: ${pacedDurationMs}`)
    checks.push("1 MiB upload stayed paced across the real relay window while another store read settled")

    const refusedUpload = await probeRequest("session.prompt", {
      sessionID: hiddenSessionID,
      input: {
        id: "msg_unknown_upload",
        text: "Unresolved attachment",
        files: [{ uri: "ycoding-upload://4ab94d33-6e6b-41a3-a638-f0a6596854a9" }],
        resume: false,
      },
    })
    expect(
      refusedUpload.status === "failed" && refusedUpload.error.code === "invalid_message",
      "an unresolved upload reference was admitted",
    )
    const hiddenPending = await local.session.pending.list({ sessionID: hiddenSessionID })
    expect(
      !JSON.stringify(hiddenPending).includes("msg_unknown_upload"),
      "the invalid upload reached the local Session",
    )
    checks.push("an unresolved attachment reference failed before local prompt admission")
  }

  const verifyOversized = async () => {
    providerMode = "instant"
    const largeText = "Oversized event stream proof ".repeat(80_000)
    const oversizedStart = events.length
    const socketsBeforeOversized = clientSockets.length
    providerFollowUpText = largeText
    providerTurn = { text: largeText, prompt: "Produce the oversized reply" }
    const largePrompt = await local.session.prompt({
      sessionID,
      id: "msg_real_flow_oversized",
      text: "Produce the oversized reply",
    })
    expect(largePrompt.id === "msg_real_flow_oversized", "local oversized-reply prompt was not admitted")
    const oversizedMarker = await waitFor(
      () =>
        events
          .slice(oversizedStart)
          .flatMap((entry) => {
            if (
              !isRecord(entry) ||
              !isRecord(entry.resync) ||
              !isRecord(entry.resync.scope) ||
              !isRecord(entry.resync.scope.target) ||
              entry.resync.scope.target.value !== sessionID
            )
              return []
            return [entry.resync]
          })
          .at(-1),
      30_000,
      "the subscribed client did not receive explicit v5 resync for the oversized event",
    ).catch(async (cause: unknown) => {
      const messages = await local.message.list({ sessionID })
      throw new Error(
        `Oversized recovery evidence: ${JSON.stringify({
          transport: store.state().transport,
          sockets: clientSockets.length - socketsBeforeOversized,
          statuses: browserStatuses.slice(-8),
          scriptPrompt: providerTurn.prompt,
          providerRequests: providerRequests.length,
          tail: messages.slice(-4).map((message) => ({
            id: message.id,
            type: message.type,
            ...(message.type === "assistant"
              ? {
                  error: message.error,
                  content: message.content.map((part) => ({
                    type: part.type,
                    ...(part.type === "text" ? { length: part.text.length } : {}),
                  })),
                }
              : {}),
          })),
          signals: events
            .slice(oversizedStart)
            .slice(-12)
            .map((entry) =>
              isRecord(entry) ? (entry.resync ?? (isRecord(entry.event) ? entry.event.type : undefined)) : undefined,
            ),
        })}`,
        { cause },
      )
    })
    expect(
      typeof oversizedMarker.sourceEpoch === "string" && oversizedMarker.sourceEpoch.length > 0,
      "resync lost its source epoch",
    )
    expect(
      store.state().transport.kind === "open" && probe.status().kind === "open",
      "oversized event recycled an active relay connection",
    )
    checks.push("an oversized subscribed event emitted explicit v5 resync without disconnecting clients")
    const largeMessage = await waitFor(
      async () =>
        (await local.message.list({ sessionID })).find(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "text" && part.text === largeText),
        ),
      30_000,
      "the oversized assistant message was not projected intact",
    )
    const largeID = largeMessage.id
    providerFollowUpText = providerText
    providerTurn = { text: providerText }
    const streamed = await content("messages", largeID)
    expect(
      streamed.status === "ok" && streamed.delivery === "http" && streamed.httpStatus === 200,
      `oversized message stream failed: ${JSON.stringify(streamed)}`,
    )
    const streamedMessage = streamed.status === "ok" && isRecord(streamed.value) ? streamed.value.data : undefined
    expect(
      isRecord(streamedMessage) &&
        streamedMessage.id === largeID &&
        Array.isArray(streamedMessage.content) &&
        streamedMessage.content.some((part) => isRecord(part) && part.type === "text" && part.text === largeText),
      "the full oversized message did not survive the authenticated HTTP stream",
    )
    expect(probe.status().kind === "open", "the oversized message stream disconnected the relay client")
    await waitFor(
      () =>
        store
          .state()
          .view?.messages.some(
            (message) =>
              message.kind === "assistant" &&
              message.id === largeID &&
              message.parts.some((part) => part.kind === "text" && part.text === largeText),
          )
          ? true
          : undefined,
      30_000,
      "the web store did not recover the oversized message after v5 resync",
    )
    expect(clientSockets.length === socketsBeforeOversized, "oversized recovery recycled the web transport")
    checks.push(
      "a >2 MiB projected message streamed fully through authenticated HTTP without exhausting the WebSocket request window",
    )
  }

  const verifyAdmin = async () => {
    const absentMessage = await content("messages", "msg_not_found")
    expect(
      absentMessage.status === "failed" &&
        isRecord(absentMessage.error) &&
        absentMessage.error._tag === "MessageNotFoundError",
      `an unknown indexed message was not refused: ${JSON.stringify(absentMessage)}`,
    )
    const offlineOnly = { "agent-completed": false, "approval-requested": false, "machine-offline": true, "quota-pace": false }
    expect(
      (await pushHttp.subscribe({ endpoint, keys: pushKeys, categories: offlineOnly })).ok,
      "the push subscription could not store this device's System choices",
    )
    const pushesBeforeTest = pushRequests.length
    const testPush = () =>
      fetch(`${workerOrigin}/api/admin/push/test`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
        body: JSON.stringify({ accountID: receiverIdentity.userID, endpoint }),
      })
    const testedResponse = await testPush()
    const tested = parsePushTestResponse(await testedResponse.json())
    expect(
      testedResponse.ok && tested.ok && tested.value.outcome === "accepted" && tested.value.status === 201,
      "the admin test alert was not accepted",
    )
    const testRequests = pushRequests.slice(pushesBeforeTest)
    expect(
      testRequests.length === 1 &&
        JSON.stringify(await decryptPush(testRequests[0] as { body: Uint8Array })) ===
          JSON.stringify({ category: "test" }),
      "the test alert did not reach exactly the registered subscription with a test payload",
    )
    const limitedTest = await testPush()
    expect(!limitedTest.ok && limitedTest.status === 429, "a second admin test alert inside the window was not refused")
    checks.push(
      "an admin-authenticated test alert reached only the registered receiver through the real Worker and reported push-service acceptance",
    )
  }

  const verifyOffline = async () => {
    const offlineMessage = await local.session.prompt({
      sessionID,
      id: "msg_real_flow_offline_read",
      text: "Prepare the offline content read",
    })
    await waitFor(
      async () =>
        (await local.message.list({ sessionID })).some((message) => message.id === offlineMessage.id)
          ? true
          : undefined,
      30_000,
      "the offline content baseline was not projected",
    )
    expect(
      (
        await pushHttp.subscribe({
          endpoint,
          keys: pushKeys,
          categories: { "agent-completed": false, "approval-requested": false, "machine-offline": true, "quota-pace": false },
        })
      ).ok,
      "the offline receiver preferences were not saved",
    )

    const offlinePushes = async (from: number) =>
      (await Promise.all(pushRequests.slice(from).map(decryptPush))).filter(
        (payload) => payload.category === "machine-offline",
      )
    const pushesBeforeRestart = pushRequests.length
    const restartAt = Date.now()
    await local.remote.set({ enabled: false })
    await local.remote.set({ enabled: true })
    await waitFor(
      async () => ((await local.remote.get()).state === "on" ? true : undefined),
      20_000,
      "the reconnecting agent never went live",
    )
    const pageOffline = () => store.state().notifications.filter((entry) => entry.category === "machine-offline")
    await waitFor(
      async () => {
        expect(
          (await offlinePushes(pushesBeforeRestart)).length === 0 && pageOffline().length === 0,
          `a reconnect inside the confirmation window raised a Machine offline alert: ${JSON.stringify(pageOffline())}`,
        )
        return Date.now() >= restartAt + RemoteLimits.agentOfflineConfirmMs + 5_000 ? true : undefined
      },
      RemoteLimits.agentOfflineConfirmMs + 10_000,
      "the reconnect confirmation window did not elapse",
    )
    checks.push(
      "an agent that reconnected inside the confirmation window raised no Machine offline push after the durable alarm",
    )

    const pushesBeforeOffline = pushRequests.length
    await local.remote.set({ enabled: false })
    const offlinePayloads = await waitFor(
      async () => {
        const found = await offlinePushes(pushesBeforeOffline)
        return found.length > 0 ? found : undefined
      },
      RemoteLimits.agentOfflineConfirmMs + 30_000,
      "an agent that stayed away did not raise a Machine offline push",
    )
    const offlineAt = offlinePayloads[0]?.offlineAt
    expect(
      offlinePayloads.length === 1 &&
        typeof offlineAt === "number" &&
        JSON.stringify(offlinePayloads[0]) ===
          JSON.stringify({ category: "machine-offline", deviceID: enrolled.deviceID, offlineAt }),
      `the Machine offline push was not one device-only payload: ${JSON.stringify(offlinePayloads)}`,
    )
    await waitFor(
      () => (pageOffline().length === 1 ? true : undefined),
      10_000,
      "the open workspace did not raise the confirmed Machine offline alert",
    )
    expect(
      pageOffline()[0]?.id === `offline_${enrolled.deviceID}_${offlineAt}` && pageOffline()[0]?.at === offlineAt,
      `the open workspace alert did not carry the push's outage identity: ${JSON.stringify(pageOffline())}`,
    )
    expect((await pushHttp.remove(endpoint)).ok, "the authenticated push subscription was not removed")
    checks.push(
      "an agent that stayed away past the confirmation window raised one Machine offline push and one open-workspace alert with the same outage identity from the durable Durable Object alarm",
    )
    const offlineStatuses = probeStatuses.length
    const offlineRead = await probeRequest("session.message", { sessionID, input: { messageID: offlineMessage.id } })
    expect(
      offlineRead.status === "unknown" &&
        offlineRead.error.code === "outcome_unknown" &&
        probeStatuses.slice(offlineStatuses).some((status) => status.kind === "closed" && status.code === 1012),
      `offline content admission was not refused: ${JSON.stringify(offlineRead)}`,
    )
    checks.push("authenticated v5 content reads refuse missing messages and an offline local agent")

    await local.remote.set({ enabled: true })
    await waitFor(
      async () => {
        await store.load()
        return store.state().devices.some((device) => device.id === enrolled.deviceID && device.online)
          ? true
          : undefined
      },
      20_000,
      "the connector did not return after the offline proof",
    )
    await waitFor(
      () => (probe.status().kind === "open" ? true : undefined),
      20_000,
      "the probe did not reconnect after the offline proof",
    )
    expect(
      (
        await pushHttp.subscribe({
          endpoint,
          keys: pushKeys,
          categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true, "quota-pace": true },
        })
      ).ok,
      "the completion receiver could not be restored after the offline proof",
    )
    store.connect(enrolled.deviceID)
    await waitFor(
      () => (store.state().transport.kind === "open" ? true : undefined),
      20_000,
      "the workspace transport did not reconnect after the offline proof",
    )
    await store.selectSession(sessionID)
  }

  /* ------------------------------------------------------- logout closes client */
  const verifyLogout = async () => {
    const logout = await http.logout()
    expect(logout.ok, `logout failed: ${JSON.stringify(logout)}`)
    await waitFor(
      () => (probe.status().kind === "closed" ? true : undefined),
      20_000,
      "the client socket stayed open after logout",
    )
    const afterLogout = await probeRequest("session.list")
    expect(afterLogout.status !== "ok", `a signed-out browser still reached the relay: ${JSON.stringify(afterLogout)}`)
    checks.push("logout closed the browser relay socket and blocked further commands")
  }

  const verifyHeldCommit = async () => {
    await store.selectSession(sessionID)
    await store.setYolo(2)
    const socket = clientSockets.at(-1)
    expect(
      socket?.readyState === 1,
      `Held-commit test requires the selected native browser socket: ${JSON.stringify({ sockets: clientSockets.map((socket) => socket.readyState), transport: store.state().transport, connection: store.state().connection.kind, statuses: browserStatuses.slice(-6) })}`,
    )
    const text = "Hold the admission acknowledgement while preserving a newer draft"
    const newer = "A newer draft must survive old acknowledgement callbacks"
    const result = Promise.withResolvers<void>()
    const gate = { socket, callbacks: [] as (() => void)[], observed: result.resolve }
    const before = settlements.length
    const requestsBefore = providerRequests.length
    const toolsBefore = providerShellCalls.length
    providerMode = "hold"
    releaseStream = undefined
    providerTurn = {
      tool: {
        id: "call_held_commit",
        name: "shell",
        input: { command: "printf held-effect >> held-commit-effect.txt" },
      },
      text: "",
      prompt: text,
    }
    heldReply = gate
    try {
      store.setDraft(sessionID, text)
      expect(await store.sendPrompt({ text, delivery: "steer" }), "Real browser send was not admitted locally")
      const mutation = store.state().mutations.find((entry) => entry.kind === "prompt" && entry.sessionID === sessionID)
      expect(mutation !== undefined, "Real browser send has no durable identity to reconcile")
      const deadline = setTimeout(
        () => result.reject(new Error("Committed prompt Result never reached the held native boundary")),
        20_000,
      )
      try {
        await result.promise
      } finally {
        clearTimeout(deadline)
      }
      const canonical = await local.message.list({ sessionID })
      const pending = await local.session.pending.list({ sessionID })
      expect(
        canonical.filter((message) => message.id === mutation.id).length +
          pending.filter((input) => input.id === mutation.id).length ===
          1,
        "Held reply did not follow one real durable admission",
      )
      await waitFor(
        () => (releaseStream ? true : undefined),
        20_000,
        "Held admission did not reach its real provider request",
      )
      expect(
        gate.callbacks.length > 0 && !settlements.slice(before).some((entry) => entry.operation === "session.prompt"),
        "Committed prompt acknowledgement escaped the native delivery gate",
      )
      store.setDraft(sessionID, newer)
      socket.close(1001, "held-commit-network-loss")
      await waitFor(
        () =>
          settlements.slice(before).some((entry) => entry.operation === "session.prompt" && entry.status === "unknown")
            ? true
            : undefined,
        20_000,
        "Sent browser mutation was not uncertain after acknowledgement loss",
      )
      heldReply = undefined
      for (const deliver of gate.callbacks.splice(0)) deliver()
      expect(store.state().drafts[sessionID] === newer, "Late native callbacks overwrote the newer draft")
      await waitFor(
        () => (store.state().transport.kind === "open" && store.state().view?.id === sessionID ? true : undefined),
        20_000,
        "Held-commit browser did not reconnect to the original Session",
      )
      await store.selectSession(sessionID)
      const recovered = await local.message.list({ sessionID })
      const remaining = await local.session.pending.list({ sessionID })
      expect(
        recovered.filter((message) => message.id === mutation.id).length +
          remaining.filter((input) => input.id === mutation.id).length ===
          1,
        "Reconnect replayed the committed prompt identity",
      )
      expect(
        providerRequests.length === requestsBefore + 2,
        "Acknowledgement loss or reconnect duplicated provider execution",
      )
      expect(
        providerShellCalls.length === toolsBefore + 1 &&
          (await Bun.file(join(workspace, "held-commit-effect.txt")).text()) === "held-effect",
        "Acknowledgement loss or reconnect duplicated the real shell effect",
      )
      await waitFor(
        () => (!store.state().mutations.some((entry) => entry.id === mutation.id) ? true : undefined),
        20_000,
        "Canonical reconciliation retained the already-admitted prompt mutation",
      )
      expect(store.state().drafts[sessionID] === newer, "Canonical reconciliation overwrote the newer draft")
      checks.push(
        "a real Rust prompt committed before its held browser acknowledgement; loss settled unknown, late callbacks preserved the newer draft, and reconnect did not replay admission, provider steps or the shell effect",
      )
    } finally {
      heldReply = undefined
      for (const deliver of gate.callbacks.splice(0)) deliver()
      await local.session.interrupt({ sessionID })
      releaseHeldStream()
      await waitFor(
        async () => {
          const active = await local.session.active()
          return sessionID in active ? undefined : true
        },
        20_000,
        "Held-commit cleanup left the Session executing",
      )
      releaseStream = undefined
      providerMode = "instant"
      await store.setYolo(0)
    }
  }

  const scenarios = {
    heldCommit: verifyHeldCommit,
    lifecycle: verifyLifecycle,
    permissions: verifyPermissions,
    guardrails: verifyGuardrails,
    children: verifyChildren,
    attachments: verifyAttachments,
    admin: verifyAdmin,
    offline: verifyOffline,
    completion: verifyCompletion,
    interrupt: verifyInterrupt,
    oversized: verifyOversized,
    logout: verifyLogout,
  }
  const selected = process.argv
    .find((argument) => argument.startsWith("--group="))
    ?.slice("--group=".length)
    .split(",")
  if (selected?.some((name) => !Object.hasOwn(scenarios, name))) throw new Error("Unknown real-flow group")
  for (const [name, verify] of Object.entries(scenarios)) {
    if (selected && !selected.includes(name)) continue
    await store.selectSession(sessionID)
    await verify()
    console.log(`group passed: ${name}`)
  }
} catch (cause) {
  for (const line of checks) console.log(`ok - ${line}`)
  console.error(`Last completed check: ${checks.at(-1) ?? "none"}`)
  console.error(cause)
  failures.push(cause)
} finally {
  for (const dispose of disposals.reverse())
    await dispose().catch((error: unknown) => {
      failures.push(error)
    })
  wrangler?.kill("SIGTERM")
  if (wrangler) await wrangler.exited
  await google?.stop(true)
  if (home) await rm(home, { recursive: true, force: true })
  if (diagnostics.length > 0) console.log(`agent diagnostics: ${diagnostics.slice(-4).join(" | ")}`)
}

if (failures.length > 0) throw new AggregateError(failures, "Composed real-flow proof failed")
for (const line of checks) console.log(`ok - ${line}`)
console.log(
  process.argv.some((argument) => argument.startsWith("--group="))
    ? "Selected composed real-flow groups passed"
    : "Composed real-flow proof passed",
)

/* ------------------------------------------------------------------ helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Real-flow check failed: ${message}`)
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function signInBrowser(input: {
  readonly pair: CryptoKeyPair
  readonly token: { value: string }
  readonly issuer: string
  readonly subject: string
  readonly persist: string
}) {
  const started = await fetch(`${workerOrigin}/api/auth/google/start?redirect_after=/remote/`, { redirect: "manual" })
  const oauthCookie = setCookiePair(started, "yc_oauth")
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const nonce = await readNonce(await sha256Hex(cookieValue(oauthCookie)), input.persist)
  expect(nonce.length > 0, "OAuth transaction was not found in the isolated local D1 state")
  const issuedAt = Math.floor(Date.now() / 1000)
  input.token.value = await signedIdToken(input.pair, {
    iss: input.issuer,
    aud: "flow-client",
    sub: input.subject,
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
  expect(callback.headers.get("location") === "/remote/", "Google callback refused sign-in")
  const cookie = cookiePair(callback, "yc_session")
  const response = await fetch(`${workerOrigin}/api/me`, { headers: { cookie } })
  const account: unknown = await response.json()
  if (response.status !== 200 || !isRecord(account) || !isRecord(account.user) || typeof account.user.id !== "string")
    throw new Error("Google sign-in could not read its verified account")
  return { cookie, userID: account.user.id }
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
    for (const row of batch.results) if (isRecord(row) && typeof row.nonce === "string") return row.nonce
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
