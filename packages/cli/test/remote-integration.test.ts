import { expect, test } from "bun:test"
import { parseAgentMessage, parseChunkedValue, type RemoteResponse } from "@ycoding-ai/remote"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Schema } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RemoteAgent, type ConnectionInput, type RelayConnection } from "../src/remote-bridge"
import { createLocalServer } from "../src/remote-local"
import { createSession, password, startServer, type IsolatedServer } from "./remote-harness"

// End-to-end verification of the relay bridge against a real isolated YCoding
// server: real SessionStore, real Protocol routes, real SSE event feed, and the
// real local adapter. Nothing here touches the user's runtime or database.

type SentValue = { readonly type: string; readonly [key: string]: unknown }

type Relay = {
  readonly input: () => ConnectionInput
  readonly sent: () => readonly SentValue[]
  readonly responses: () => readonly RemoteResponse[]
  readonly events: () => readonly { readonly sessionID: string; readonly event: unknown }[]
  readonly deliver: (frame: unknown) => void
  readonly createConnection: (input: ConnectionInput) => RelayConnection
}

function createRelay(): Relay {
  const values: SentValue[] = []
  let handler: ((frame: unknown) => void) | undefined
  let connection: ConnectionInput | undefined
  return {
    input: () => {
      if (connection === undefined) throw new Error("the bridge has not connected")
      return connection
    },
    sent: () => values,
    responses: () => values.filter((value) => value.type === "response") as unknown as readonly RemoteResponse[],
    events: () =>
      values.filter((value) => value.type === "event") as unknown as readonly {
        sessionID: string
        event: unknown
      }[],
    deliver: (frame) => handler?.(frame),
    createConnection: (next) => {
      connection = next
      return {
        connect: async () => next.onOpen(),
        send: async (value: string) => {
          const parsed = parseAgentMessage(value)
          if (!parsed.ok) throw new Error(`bridge sent an invalid frame: ${parsed.error.code}`)
          values.push(parsed.value as unknown as SentValue)
        },
        onMessage: (next) => {
          handler = next
        },
        disconnect: async () => undefined,
      }
    },
  }
}

async function waitFor<Value>(check: () => Value | undefined, timeout = 15_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}

function request(id: string, operation: string, sessionID?: string, input?: Record<string, unknown>) {
  return {
    type: "request",
    id,
    operation,
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(input === undefined ? {} : { input }),
  }
}

async function answer(relay: Relay, id: string) {
  return waitFor(() => {
    const frames = relay.responses().filter((frame) => frame.id === id)
    if (frames.length === 0) return undefined
    const chunked = frames.filter((frame) => frame.ok && frame.chunk !== undefined)
    if (chunked.length === 0) return frames[0]
    if (!chunked.some((frame) => frame.ok && frame.chunk?.last)) return undefined
    const parts = chunked
      .map((frame) => (frame.ok ? { index: frame.chunk!.index, value: frame.value as string } : undefined))
      .filter((part): part is { index: number; value: string } => part !== undefined)
      .sort((left, right) => left.index - right.index)
      .map((part) => part.value)
    const reassembled = parseChunkedValue(parts)
    if (!reassembled.ok) throw new Error("failed to reassemble a chunked response")
    return { ...frames[0], value: reassembled.value } as RemoteResponse
  })
}

function valueOf(frame: RemoteResponse | undefined) {
  expect(frame?.ok).toBe(true)
  if (frame === undefined || !frame.ok) throw new Error("expected a successful response")
  return frame.value
}

function errorOf(frame: RemoteResponse | undefined) {
  expect(frame?.ok).toBe(false)
  if (frame === undefined || frame.ok) throw new Error("expected a failed response")
  return frame.error
}

async function createForm(server: IsolatedServer, directory: string, sessionID: string, formID: string) {
  const response = await server.request(`/api/session/${encodeURIComponent(sessionID)}/form`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ycoding-directory": encodeURIComponent(directory) },
    body: JSON.stringify({
      id: formID,
      title: "Approve the remote action",
      metadata: { kind: "question" },
      fields: [{ key: "approved", type: "boolean", title: "Approve?", required: true }],
    }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return ((await response.json()) as { data: { id: string; sessionID: string } }).data
}

/** Create one real shell at the shared Location, owned by the supplied Session. */
async function createShell(
  server: IsolatedServer,
  directory: string,
  input: { readonly command: string; readonly metadata: Record<string, unknown> },
) {
  const response = await server.request("/api/shell", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ycoding-directory": encodeURIComponent(directory) },
    body: JSON.stringify({ command: input.command, timeout: 0, metadata: input.metadata }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const body = (await response.json()) as { data: { id: string; metadata: Record<string, unknown> } }
  return body.data
}

async function waitForShellExit(server: IsolatedServer, directory: string, shellID: string) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const response = await server.request(`/api/shell/${encodeURIComponent(shellID)}`, {
      headers: { "x-ycoding-directory": encodeURIComponent(directory) },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { status: string } }
    if (body.data.status !== "running") return
    if (Date.now() >= deadline) throw new Error("the shell command did not exit")
    await Bun.sleep(25)
  }
}

/** Reads the projected shell message for a direct Session shell once it settles. */
async function waitForSessionShell(server: IsolatedServer, directory: string, sessionID: string) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const response = await server.request(`/api/session/${encodeURIComponent(sessionID)}/snapshot`, {
      headers: { "x-ycoding-directory": encodeURIComponent(directory) },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      messages?: readonly { type?: string; shellID?: string; status?: string }[]
    }
    const shell = (body.messages ?? []).find((message) => message.type === "shell" && message.status !== "running")
    if (shell?.shellID !== undefined) return shell.shellID
    if (Date.now() >= deadline) throw new Error("the direct Session shell did not settle")
    await Bun.sleep(25)
  }
}

/** Reads one page of a real capture through the Protocol shell output route. */
async function readShellPage(
  server: IsolatedServer,
  directory: string,
  shellID: string,
  input: { readonly cursor: number; readonly limit?: number },
) {
  const query = new URLSearchParams({ cursor: String(input.cursor) })
  if (input.limit !== undefined) query.set("limit", String(input.limit))
  const response = await server.request(`/api/shell/${encodeURIComponent(shellID)}/output?${query}`, {
    headers: { "x-ycoding-directory": encodeURIComponent(directory) },
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const body = (await response.json()) as { readonly data: ShellPage }
  return body.data
}

type ShellPage = {
  readonly output: string
  readonly cursor: number
  readonly size: number
  readonly truncated: boolean
}

/**
 * Pages real captured output from `start` to the reported end. Fails when a page does
 * not advance, so a stalled or looping read shows up instead of hanging the suite.
 */
async function pageShell(
  server: IsolatedServer,
  directory: string,
  shellID: string,
  input: { readonly limit?: number; readonly start?: number } = {},
) {
  const pages: ShellPage[] = []
  let cursor = input.start ?? 0
  for (;;) {
    const page = await readShellPage(server, directory, shellID, { cursor, limit: input.limit })
    pages.push(page)
    expect(page.cursor).toBeLessThanOrEqual(page.size)
    if (page.cursor >= page.size) return pages
    if (page.cursor <= cursor) throw new Error(`page did not advance: cursor ${page.cursor} size ${page.size}`)
    if (pages.length >= 8_192) throw new Error("shell output paging did not terminate")
    cursor = page.cursor
  }
}

const joinedPages = (pages: readonly ShellPage[]) => pages.map((page) => page.output).join("")

/** Reports the first divergence instead of printing a whole capture. */
function expectSameOutput(actual: string, expected: string, label: string) {
  if (actual === expected) return
  const shortest = Math.min(actual.length, expected.length)
  let at = 0
  while (at < shortest && actual[at] === expected[at]) at += 1
  throw new Error(
    `${label} differs at character ${at} of ${expected.length}: ` +
      `${JSON.stringify(actual.slice(at, at + 12))} instead of ${JSON.stringify(expected.slice(at, at + 12))}`,
  )
}

/** A valid 2/3/4-byte character with `phase` of its bytes before the 65536-byte page end. */
function straddlingText(width: 2 | 3 | 4, phase: number) {
  const character = width === 2 ? "é" : width === 3 ? "€" : "😀"
  expect(Buffer.byteLength(character)).toBe(width)
  return Buffer.from("a".repeat(65_536 - phase) + character + character.repeat(50) + "\n", "utf8")
}

/**
 * Bytes a page can end inside: valid 2/3/4-byte characters, ill-formed sequences in every
 * position, and a three-byte character split across two parts.
 */
function boundaryBytes() {
  return Buffer.concat([
    Buffer.from("Aé€😀B\n"),
    // A 3-byte lead whose continuation is ASCII. Trusting the lead width consumes the
    // following valid 2-byte character, corrupting both it and the ASCII byte.
    Buffer.from([0xe2, 0x41, 0xc3, 0xa9]),
    Buffer.from("z"),
    Buffer.from([0xe2, 0x82]),
    Buffer.from([0xac]),
    Buffer.from([0xf0, 0x9f, 0x41, 0xf0, 0x90, 0x80, 0x80]),
    Buffer.from([0x80, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xf5, 0x80, 0x80, 0x80, 0x80]),
    Buffer.from([0xe0, 0x80, 0xaf, 0xc1, 0xbf, 0xef, 0xbf, 0xbd]),
    Buffer.from("done\n"),
  ])
}

function pseudoRandomBytes(length: number) {
  const bytes = Buffer.alloc(length)
  let state = 0x9e3779b9
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

/** Writes fixture bytes into the Location directory and returns the command reading them. */
async function captureCommand(directory: string, name: string, bytes: Buffer) {
  await writeFile(join(directory, name), bytes)
  return `cat ${name}`
}

const goalRequest = "keep the remote bridge honest"
// The synthesized goal text comes from the loopback stand-in, not from the request,
// so a projected goal text is proof that the model boundary ran.
const synthesizedGoal = "Keep the remote bridge honest across reconnects and restarts."

test("bridges authorized session operations against an isolated server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-remote-bridge-"))
  const server = await startServer(directory, { provider: { text: synthesizedGoal, holdAfter: 2 } })
  const provider = server.provider
  if (provider === undefined) throw new Error("the isolated server must expose its provider stand-in")
  const sessionID = "ses_remote_bridge_integration"
  const hiddenSessionID = "ses_remote_bridge_hidden"
  const relay = createRelay()
  const diagnostics: string[] = []
  const bridge = new RemoteAgent({
    relayURL: "https://relay.example",
    local: createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } }),
    credentials: async () => ({ accessToken: "integration-token", accessExpiresAt: Date.now() + 600_000 }),
    createConnection: relay.createConnection,
    refreshIntervalMs: 3_600_000,
    onDiagnostic: (message) => diagnostics.push(message),
    onTerminal: (message) => diagnostics.push(`terminal: ${message}`),
  })

  try {
    await createSession(server, sessionID, directory, { providerID: provider.providerID, id: provider.modelID })
    await createSession(server, hiddenSessionID, directory)
    await bridge.connect()

    const invalidation = await waitFor(() => {
      const frame = relay.sent().find((value) => value.type === "sessions")
      return frame
    })
    expect(invalidation).toEqual({ type: "sessions" })

    // Reads return the local Protocol body verbatim.
    relay.deliver(request("list_1", "session.list"))
    const listed = valueOf(await answer(relay, "list_1")) as { data: readonly { id: string }[] }
    expect(listed.data.map((session) => session.id).sort()).toEqual([hiddenSessionID, sessionID].sort())

    relay.deliver(request("snapshot_1", "session.snapshot", sessionID))
    const snapshot = valueOf(await answer(relay, "snapshot_1")) as {
      sourceEpoch: string
      session: { id: string; model: unknown }
      messages: readonly unknown[]
      watermark: unknown
    }
    expect(snapshot.session.id).toBe(sessionID)
    // The contract's Model.Ref shape survives the bridge as an object, not a string.
    expect(typeof snapshot.session.model).toBe("object")
    expect(snapshot.session.model).toMatchObject({ providerID: provider.providerID, id: provider.modelID })
    expect(typeof snapshot.sourceEpoch).toBe("string")
    expect(Array.isArray(snapshot.messages)).toBe(true)
    expect(snapshot.watermark).toBeDefined()

    relay.deliver(request("autonomy_1", "session.autonomy.get", sessionID))
    const autonomy = valueOf(await answer(relay, "autonomy_1")) as { data: { mode: string } }
    expect(autonomy.data.mode).toBe("normal")

    relay.deliver(request("autonomy_2", "session.autonomy.set", sessionID, { yolo: 2 }))
    valueOf(await answer(relay, "autonomy_2"))
    relay.deliver(request("autonomy_3", "session.autonomy.get", sessionID))
    expect((valueOf(await answer(relay, "autonomy_3")) as { data: { yolo?: number } }).data.yolo).toBe(2)
    relay.deliver(request("autonomy_4", "session.autonomy.set", sessionID, { yolo: 0 }))
    valueOf(await answer(relay, "autonomy_4"))

    // Goal set and stop against the real server, with the model boundary served by
    // an opt-in loopback stand-in. Goal activation admits the autonomous
    // continuation by contract, so the assertions below are: the projected goal
    // text came from the model, the status moves active -> stopped, and the
    // distinct contract failures stay fail-closed.
    relay.deliver(request("log_goal_before", "session.log", sessionID, { after: 0 }))
    const beforeGoal = valueOf(await answer(relay, "log_goal_before")) as {
      data: readonly { type: string; data: { inputID?: string } }[]
    }
    expect(beforeGoal.data.filter((item) => item.type === "session.input.admitted")).toHaveLength(0)

    relay.deliver(request("goal_set", "session.goal.set", sessionID, { goal: goalRequest }))
    const goalSet = valueOf(await answer(relay, "goal_set")) as {
      data: { mode: string; yolo?: number; goal?: { text?: string; status?: string; iteration?: number } }
    }
    // The model boundary is the loopback stand-in: it received the synthesis
    // request carrying the user's goal text, and the projected goal text is the
    // stand-in's completion rather than an echo of the request.
    expect(provider.requests().length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(provider.requests()[0])).toContain(goalRequest)
    expect(JSON.stringify(provider.requests()[1])).toContain(`Active goal: ${synthesizedGoal}`)
    expect(JSON.stringify(provider.requests()[1])).toContain("Phase: start")
    expect(goalSet.data.mode).toBe("normal")
    expect(goalSet.data.goal?.status).toBe("active")
    expect(goalSet.data.goal?.text).toBe(synthesizedGoal)
    expect(goalSet.data.goal?.text).not.toBe(goalRequest)
    expect(goalSet.data.goal?.iteration).toBe(0)

    relay.deliver(request("goal_get_active", "session.autonomy.get", sessionID))
    const activeGoal = valueOf(await answer(relay, "goal_get_active")) as {
      data: { goal?: { text?: string; status?: string } }
    }
    expect(activeGoal.data.goal?.status).toBe("active")
    expect(activeGoal.data.goal?.text).toBe(synthesizedGoal)

    // Activation admits one synthetic goal continuation; that admission is the
    // intended effect and is asserted directly rather than as absence.
    relay.deliver(request("log_goal_active", "session.log", sessionID, { after: 0 }))
    const afterSet = valueOf(await answer(relay, "log_goal_active")) as {
      data: readonly { type: string; data: { inputID?: string } }[]
    }
    expect(
      afterSet.data.filter(
        (item) => item.type === "session.input.admitted" && item.data.inputID?.startsWith("msg_goal_"),
      ),
    ).toHaveLength(1)

    // Distinct fail-closed contract checks: resume is outside the relay surface and
    // blank goal text never reaches the server.
    relay.deliver(request("goal_resume", "session.goal.set", sessionID, { goal: true }))
    expect(errorOf(await answer(relay, "goal_resume")).code).toBe("invalid_message")
    relay.deliver(request("goal_blank", "session.goal.set", sessionID, { goal: "" }))
    expect(errorOf(await answer(relay, "goal_blank")).code).toBe("invalid_message")

    relay.deliver(request("goal_stop", "session.goal.stop", sessionID, {}))
    const stoppedGoal = valueOf(await answer(relay, "goal_stop")) as {
      data: { mode: string; goal?: { text?: string; status?: string } }
    }
    expect(stoppedGoal.data.mode).toBe("normal")
    expect(stoppedGoal.data.goal?.status).toBe("stopped")
    expect(stoppedGoal.data.goal?.text).toBe(synthesizedGoal)

    relay.deliver(request("goal_get_stopped", "session.autonomy.get", sessionID))
    const stoppedRead = valueOf(await answer(relay, "goal_get_stopped")) as {
      data: { goal?: { text?: string; status?: string } }
    }
    expect(stoppedRead.data.goal?.status).toBe("stopped")
    expect(stoppedRead.data.goal?.text).toBe(synthesizedGoal)

    // Stopping again is idempotent and never discards the retained goal.
    relay.deliver(request("goal_stop_again", "session.goal.stop", sessionID, {}))
    const stoppedAgain = valueOf(await answer(relay, "goal_stop_again")) as { data: { goal?: { status?: string } } }
    expect(stoppedAgain.data.goal?.status).toBe("stopped")

    relay.deliver(request("files_1", "session.fileChange.list", sessionID))
    expect(valueOf(await answer(relay, "files_1"))).toEqual({ data: [] })

    relay.deliver(request("guardrail_1", "session.guardrail.status", sessionID))
    const status = valueOf(await answer(relay, "guardrail_1")) as { data: { rootSessionID: string } }
    expect(status.data.rootSessionID).toBe(sessionID)

    relay.deliver(request("reviews_1", "session.guardrail.request.list", sessionID))
    expect(valueOf(await answer(relay, "reviews_1"))).toEqual({ data: [] })

    // The session-scoped permission list is the exact local body; it is never the
    // location-wrapped shape of the process-wide route.
    relay.deliver(request("permissions_1", "session.permission.list", sessionID))
    const permissions = valueOf(await answer(relay, "permissions_1")) as { data: unknown }
    expect(permissions).toEqual({ data: [] })
    expect(Object.keys(permissions)).toEqual(["data"])

    const replyForm = await createForm(server, directory, sessionID, "frm_remote_reply")
    const cancelForm = await createForm(server, directory, sessionID, "frm_remote_cancel")
    const crossSessionForm = await createForm(server, directory, hiddenSessionID, "frm_remote_cross")
    relay.deliver(request("forms_1", "session.form.list", sessionID, {}))
    const forms = valueOf(await answer(relay, "forms_1")) as readonly { id: string; sessionID: string }[]
    expect(Array.isArray(forms)).toBe(true)
    expect(forms.map((form) => form.id).sort()).toEqual([cancelForm.id, replyForm.id])
    expect(forms.every((form) => form.sessionID === sessionID)).toBe(true)

    relay.deliver(request("form_reply_1", "session.form.reply", sessionID, { formID: replyForm.id, answer: { approved: true } }))
    expect(valueOf(await answer(relay, "form_reply_1"))).toBeNull()
    relay.deliver(request("form_cancel_1", "session.form.cancel", sessionID, { formID: cancelForm.id }))
    expect(valueOf(await answer(relay, "form_cancel_1"))).toBeNull()
    relay.deliver(request("form_cross_1", "session.form.cancel", sessionID, { formID: crossSessionForm.id }))
    expect(errorOf(await answer(relay, "form_cross_1")).code).toBe("invalid_message")
    relay.deliver(request("forms_2", "session.form.list", sessionID, {}))
    expect(valueOf(await answer(relay, "forms_2"))).toEqual([])

    // Running status is process-wide and includes every backend Session.
    await server.request(`/api/session/${hiddenSessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hidden session work" }),
    })
    relay.deliver(request("active_1", "session.active"))
    const active = valueOf(await answer(relay, "active_1")) as { data: Record<string, { type: string }> }
    expect(Object.keys(active.data)).toContain(hiddenSessionID)
    for (const [id, status] of Object.entries(active.data)) {
      expect([sessionID, hiddenSessionID]).toContain(id)
      expect(status.type).toBe("running")
    }

    // Durable admission of one prompt, reconciled on an exact retry with the same ID.
    const messageID = "msg_remote_bridge_integration"
    relay.deliver(request("prompt_1", "session.prompt", sessionID, { id: messageID, text: "integration prompt" }))
    const admitted = valueOf(await answer(relay, "prompt_1")) as { data: { id: string; admittedSeq: number } }
    expect(admitted.data.id).toBe(messageID)
    expect(typeof admitted.data.admittedSeq).toBe("number")

    relay.deliver(request("prompt_2", "session.prompt", sessionID, { id: messageID, text: "integration prompt" }))
    const retried = valueOf(await answer(relay, "prompt_2")) as { data: { id: string } }
    expect(retried.data.id).toBe(messageID)

    relay.deliver(request("log_1", "session.log", sessionID, { after: 0 }))
    const log = valueOf(await answer(relay, "log_1")) as {
      data: readonly { type: string; data: { inputID?: string } }[]
    }
    expect(log.data.filter((item) => item.type === "session.input.admitted" && item.data.inputID === messageID)).toHaveLength(1)

    // Every backend Session is addressable to the authenticated device owner.
    relay.deliver(request("hidden_1", "session.messages", hiddenSessionID))
    expect(valueOf(await answer(relay, "hidden_1"))).toMatchObject({ data: expect.any(Array) })

    // Idle interruption is a no-op locally and still succeeds over the relay.
    relay.deliver(request("interrupt_1", "session.interrupt", sessionID))
    expect(valueOf(await answer(relay, "interrupt_1"))).toBeNull()

    // Reviews that are not pending are refused by the ownership gate.
    relay.deliver(request("review_reply_1", "session.guardrail.reply", sessionID, { requestID: "grq_missing", reply: "once" }))
    expect(errorOf(await answer(relay, "review_reply_1")).code).toBe("invalid_message")
    relay.deliver(request("permission_reply_1", "session.permission.reply", sessionID, { requestID: "per_missing", reply: "once" }))
    expect(errorOf(await answer(relay, "permission_reply_1")).code).toBe("invalid_message")
    relay.deliver(request("form_reply_missing", "session.form.reply", sessionID, { formID: "frm_missing", answer: {} }))
    expect(errorOf(await answer(relay, "form_reply_missing")).code).toBe("invalid_message")

    // Live local events reach the relay only for subscribed Sessions.
    relay.deliver(request("subscribe_1", "session.subscribe", sessionID))
    valueOf(await answer(relay, "subscribe_1"))
    relay.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: [sessionID] })
    relay.deliver(request("prompt_3", "session.prompt", sessionID, { id: "msg_remote_bridge_event", text: "event prompt" }))
    valueOf(await answer(relay, "prompt_3"))
    const forwarded = await waitFor(() => {
      const events = relay.events().filter((event) => event.sessionID === sessionID)
      return events.length > 0 ? events : undefined
    })
    expect(forwarded[0].event).toMatchObject({ type: expect.any(String) })

    relay.deliver(request("unsubscribe_1", "session.unsubscribe", sessionID))
    valueOf(await answer(relay, "unsubscribe_1"))
    relay.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: [] })
  } finally {
    await bridge.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("replies to real ordinary and hard guardrail reviews through the root Session relay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-remote-guardrail-"))
  const hardCommand = "echo guarded hard review"
  await mkdir(join(directory, "guardrails"))
  await writeFile(join(directory, "guardrails", "relay-hard.md"), `---
id: relay-hard-review
decision: hard_review
actions: [shell]
resources: ["${hardCommand}"]
reason: Test-only hard review of a harmless command
priority: 0
---
Require a fresh human decision in this isolated test.
`)
  const server = await startServer(directory)
  const rootID = "ses_remote_guardrail_root"
  const childID = "ses_remote_guardrail_child"
  const unrelatedID = "ses_remote_guardrail_unrelated"
  const relay = createRelay()
  const bridge = new RemoteAgent({
    relayURL: "https://relay.example",
    local: createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } }),
    credentials: async () => ({ accessToken: "guardrail-token", accessExpiresAt: Date.now() + 600_000 }),
    createConnection: relay.createConnection,
    refreshIntervalMs: 3_600_000,
  })
  let reads = 0
  const reviews = async (sessionID: string) => {
    const id = `reviews_${++reads}`
    relay.deliver(request(id, "session.guardrail.request.list", sessionID))
    return Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Guardrail.Request) }))(valueOf(await answer(relay, id))).data
  }
  const pendingReview = async () => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const pending = await reviews(rootID)
      if (pending.length > 0) return pending[0]
      if (Date.now() >= deadline) throw new Error("the real server did not create a guardrail review")
      await Bun.sleep(20)
    }
  }
  const startShell = (command: string) => server.request(`/api/session/${childID}/shell`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ycoding-directory": encodeURIComponent(directory) },
    body: JSON.stringify({ command }),
  })

  try {
    await createSession(server, rootID, directory)
    const child = await server.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: childID, parentID: rootID }),
    })
    expect(child.status, await child.clone().text()).toBe(200)
    await createSession(server, unrelatedID, directory)
    await bridge.connect()

    // The harmless echo matches the standard destructive-Git review, but cannot reset a repository.
    const ordinaryCommand = "echo git reset --hard HEAD~1"
    const ordinaryShell = startShell(ordinaryCommand)
    const ordinary = await pendingReview()
    expect(ordinary).toMatchObject({
      rootSessionID: rootID,
      sessionID: childID,
      resources: [ordinaryCommand],
      ruleIDs: ["standard.review.git-destructive"],
    })
    expect(ordinary.hardReview).not.toBe(true)
    expect(await reviews(childID)).toEqual([ordinary])
    expect(await reviews(unrelatedID)).toEqual([])

    relay.deliver(request("ordinary_cross", "session.guardrail.reply", unrelatedID, { requestID: ordinary.id, reply: "once" }))
    expect(errorOf(await answer(relay, "ordinary_cross")).code).toBe("invalid_message")
    expect(await reviews(rootID)).toEqual([ordinary])

    relay.deliver(request("ordinary_once", "session.guardrail.reply", rootID, { requestID: ordinary.id, reply: "once" }))
    expect(valueOf(await answer(relay, "ordinary_once"))).toBeNull()
    const ordinaryResult = await ordinaryShell
    expect(ordinaryResult.status, await ordinaryResult.clone().text()).toBe(204)
    expect(await reviews(rootID)).toEqual([])

    const hardShell = startShell(hardCommand)
    const hard = await pendingReview()
    expect(hard).toMatchObject({
      rootSessionID: rootID,
      sessionID: childID,
      resources: [hardCommand],
      ruleIDs: ["relay-hard-review"],
      hardReview: true,
    })
    relay.deliver(request("hard_always", "session.guardrail.reply", rootID, { requestID: hard.id, reply: "always" }))
    expect(valueOf(await answer(relay, "hard_always"))).toBeNull()
    const hardResult = await hardShell
    expect(hardResult.ok).toBe(false)
    expect(await hardResult.text()).toContain("Session guardrail review was rejected")
    expect(await reviews(rootID)).toEqual([])

    // Always on a hard review is treated as rejection; it neither executes nor grants reuse.
    const repeatedShell = startShell(hardCommand)
    const repeated = await pendingReview()
    expect(repeated).toMatchObject({ rootSessionID: rootID, sessionID: childID, hardReview: true })
    expect(repeated.id).not.toBe(hard.id)
    relay.deliver(request("hard_reject", "session.guardrail.reply", childID, { requestID: repeated.id, reply: "reject" }))
    expect(valueOf(await answer(relay, "hard_reject"))).toBeNull()
    const repeatedResult = await repeatedShell
    expect(repeatedResult.ok).toBe(false)
    expect(await repeatedResult.text()).toContain("Session guardrail review was rejected")
    expect(await reviews(rootID)).toEqual([])

    const snapshot = await server.request(`/api/session/${childID}/snapshot`, {
      headers: { "x-ycoding-directory": encodeURIComponent(directory) },
    })
    expect(snapshot.status, await snapshot.clone().text()).toBe(200)
    const body = Schema.decodeUnknownSync(Schema.Struct({
      messages: Schema.Array(Schema.Struct({ type: Schema.String, command: Schema.String.pipe(Schema.optional) })),
    }))(await snapshot.json())
    expect(body.messages.filter((message) => message.type === "shell").map((message) => message.command)).toEqual([ordinaryCommand])
  } finally {
    await bridge.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("pages real shell output over the relay for the owning Session only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-remote-shell-"))
  const server = await startServer(directory)
  const ownerSessionID = "ses_remote_shell_owner"
  const otherSessionID = "ses_remote_shell_other"
  const hiddenSessionID = "ses_remote_shell_hidden"
  const relay = createRelay()
  const bridge = new RemoteAgent({
    relayURL: "https://relay.example",
    local: createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } }),
    credentials: async () => ({ accessToken: "shell-token", accessExpiresAt: Date.now() + 600_000 }),
    createConnection: relay.createConnection,
    refreshIntervalMs: 3_600_000,
  })

  try {
    await createSession(server, ownerSessionID, directory)
    await createSession(server, otherSessionID, directory)
    await createSession(server, hiddenSessionID, directory)
    await bridge.connect()

    // A real captured output above 1 MiB, owned by exactly one Session.
    const stored = "a\n".repeat(650_000)
    expect(stored.length).toBe(1_300_000)
    const shell = await createShell(server, directory, {
      command: "yes a | head -c 1300000",
      metadata: { sessionID: ownerSessionID },
    })
    expect(shell.metadata.sessionID).toBe(ownerSessionID)
    await waitForShellExit(server, directory, shell.id)

    // Another advertised Session must not read it: refused before any output read.
    relay.deliver(request("shell_other", "session.shell.output", otherSessionID, { shellID: shell.id }))
    const otherRead = await answer(relay, "shell_other")
    expect(errorOf(otherRead).code).toBe("forbidden")
    // The refused frame carries an error only: no page, so no captured byte reached the relay.
    expect(otherRead !== undefined && "value" in otherRead).toBe(false)

    // Another Session still cannot read this shell because shell ownership is exact.
    relay.deliver(request("shell_hidden", "session.shell.output", hiddenSessionID, { shellID: shell.id }))
    expect(errorOf(await answer(relay, "shell_hidden")).code).toBe("forbidden")

    // Page inputs and unknown fields are rejected before any local call.
    relay.deliver(request("shell_bad_page", "session.shell.output", ownerSessionID, { shellID: shell.id, limit: 0 }))
    expect(errorOf(await answer(relay, "shell_bad_page")).code).toBe("invalid_message")
    relay.deliver(request("shell_bad_limit", "session.shell.output", ownerSessionID, { shellID: shell.id, limit: 65_537 }))
    expect(errorOf(await answer(relay, "shell_bad_limit")).code).toBe("invalid_message")
    relay.deliver(
      request("shell_bad_path", "session.shell.output", ownerSessionID, { shellID: shell.id, path: "/etc/passwd" }),
    )
    expect(errorOf(await answer(relay, "shell_bad_path")).code).toBe("invalid_message")

    // An unknown shell fails closed instead of reading anything.
    relay.deliver(request("shell_missing", "session.shell.output", ownerSessionID, { shellID: "sh_missing" }))
    expect(errorOf(await answer(relay, "shell_missing")).code).toBe("invalid_message")

    // The direct Session shell path records its owner too, so its captured output is
    // reachable through the same relay read without any test-supplied metadata.
    const sessionShell = await server.request(`/api/session/${ownerSessionID}/shell`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ycoding-directory": encodeURIComponent(directory) },
      body: JSON.stringify({ command: "echo relay-owned" }),
    })
    expect(sessionShell.status, await sessionShell.clone().text()).toBe(204)
    const sessionShellID = await waitForSessionShell(server, directory, ownerSessionID)
    relay.deliver(request("shell_session", "session.shell.output", ownerSessionID, { shellID: sessionShellID }))
    const sessionPage = valueOf(await answer(relay, "shell_session")) as { data: { output: string; cursor: number } }
    expect(sessionPage.data.output).toContain("relay-owned")
    expect(sessionPage.data.cursor).toBeGreaterThan(0)

    // The owning Session pages the actual stored output; nothing is dropped or duplicated.
    const chunks: string[] = []
    let cursor: number | undefined
    let pages = 0
    for (;;) {
      const id = `shell_page_${pages}`
      relay.deliver(
        request(id, "session.shell.output", ownerSessionID, {
          shellID: shell.id,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      )
      const page = valueOf(await answer(relay, id)) as {
        data: { output: string; cursor: number; size: number; truncated: boolean }
      }
      expect(page.data.size).toBe(stored.length)
      expect(page.data.truncated).toBe(false)
      chunks.push(page.data.output)
      pages += 1
      if (page.data.cursor >= page.data.size) break
      expect(page.data.cursor).toBeGreaterThan(cursor ?? 0)
      cursor = page.data.cursor
      if (pages > 40) throw new Error("shell output paging did not terminate")
    }
    expect(pages).toBeGreaterThanOrEqual(20)
    expect(chunks.join("")).toBe(stored)
  } finally {
    await bridge.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("joins real captured pages to the bytes the shell wrote at every budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-shell-paging-"))
  const server = await startServer(directory)
  try {
    const small = boundaryBytes()
    const smallShell = await createShell(server, directory, {
      command: await captureCommand(directory, "boundary.bin", small),
      metadata: {},
    })
    await waitForShellExit(server, directory, smallShell.id)
    for (const limit of [65_536, 1, 2, 3, 4, 5, 11, 12, 13]) {
      const pages = await pageShell(server, directory, smallShell.id, { limit })
      expect(pages.at(-1)?.size).toBe(small.length)
      expectSameOutput(joinedPages(pages), small.toString("utf8"), `limit=${limit}`)
    }
    // The ASCII byte and the 2-byte character after a malformed 3-byte lead survive a page
    // that ends inside it: a decoder trusting the lead width consumes them instead.
    expect(joinedPages(await pageShell(server, directory, smallShell.id, { limit: 11 }))).toContain("Aéz")

    for (const width of [2, 3, 4] as const) {
      for (let phase = 1; phase < width; phase += 1) {
        const bytes = straddlingText(width, phase)
        const shell = await createShell(server, directory, {
          command: await captureCommand(directory, `straddle-${width}-${phase}.bin`, bytes),
          metadata: {},
        })
        await waitForShellExit(server, directory, shell.id)
        const pages = await pageShell(server, directory, shell.id)
        expect(pages.at(-1)?.size).toBe(bytes.length)
        // The page ends where the straddling character completes, inside the three-byte
        // completion allowance past the requested 65536-byte limit.
        expect(pages[0]?.cursor).toBe(65_536 + (width - phase))
        expectSameOutput(joinedPages(pages), bytes.toString("utf8"), `width=${width} phase=${phase}`)
      }
    }

    const bulk = Buffer.concat([
      Buffer.from("é€😀x".repeat(4_000), "utf8"),
      boundaryBytes(),
      pseudoRandomBytes(24_000),
    ])
    const bulkShell = await createShell(server, directory, {
      command: await captureCommand(directory, "bulk.bin", bulk),
      metadata: {},
    })
    await waitForShellExit(server, directory, bulkShell.id)
    for (const limit of [65_536, 4_096]) {
      const pages = await pageShell(server, directory, bulkShell.id, { limit })
      expect(pages.at(-1)?.size).toBe(bulk.length)
      expectSameOutput(joinedPages(pages), bulk.toString("utf8"), `bulk limit=${limit}`)
    }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)

test("holds a live incomplete shell output character until the appended bytes arrive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-shell-paging-live-"))
  const server = await startServer(directory)
  try {
    const first = Buffer.concat([Buffer.from("live-"), Buffer.from([0xc3])])
    const second = Buffer.concat([Buffer.from([0xa9]), Buffer.from("-done\n")])
    await writeFile(join(directory, "live-first.bin"), first)
    await writeFile(join(directory, "live-second.bin"), second)
    const shell = await createShell(server, directory, {
      command: "cat live-first.bin; sleep 2; cat live-second.bin",
      metadata: {},
    })

    const deadline = Date.now() + 15_000
    let page: ShellPage | undefined
    while (page === undefined) {
      const info = await server.request(`/api/shell/${encodeURIComponent(shell.id)}`, {
        headers: { "x-ycoding-directory": encodeURIComponent(directory) },
      })
      const status = ((await info.json()) as { data: { status: string } }).data.status
      const candidate = await readShellPage(server, directory, shell.id, { cursor: 0 })
      if (candidate.size === first.length && candidate.output === "live-") page = candidate
      else if (status !== "running") throw new Error("the live capture settled before its held page was read")
      else if (Date.now() >= deadline) throw new Error("the live capture never served its held page")
      else await Bun.sleep(20)
    }

    // The trailing lead byte is held back, so the page ends on the last complete character
    // and a repeated read neither advances nor invents a replacement character.
    expect(page).toEqual({ output: "live-", cursor: 5, size: 6, truncated: false })
    expect(await readShellPage(server, directory, shell.id, { cursor: page.cursor })).toEqual({
      output: "",
      cursor: 5,
      size: 6,
      truncated: false,
    })

    await waitForShellExit(server, directory, shell.id)
    const rest = await pageShell(server, directory, shell.id, { start: page.cursor })
    expect([page, ...rest].map((item) => item.output).join("")).toBe("live-é-done\n")
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)

test("settles incomplete trailing shell output bytes, clamps cursors, and reads nothing for a zero limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-shell-paging-settled-"))
  const server = await startServer(directory)
  try {
    const tails = [
      Buffer.concat([Buffer.from("ok\n"), Buffer.from([0xc3])]),
      Buffer.concat([Buffer.from("ok\n"), Buffer.from([0xf0, 0x9f, 0x98])]),
      Buffer.from([0x80]),
    ]
    for (const [index, bytes] of tails.entries()) {
      const shell = await createShell(server, directory, {
        command: await captureCommand(directory, `tail-${index}.bin`, bytes),
        metadata: {},
      })
      await waitForShellExit(server, directory, shell.id)
      const pages = await pageShell(server, directory, shell.id, { limit: 8 })
      expect(pages.at(-1)?.cursor).toBe(bytes.length)
      expect({ index, output: joinedPages(pages) }).toEqual({ index, output: bytes.toString("utf8") })
    }

    const text = Buffer.from("€x€")
    const shell = await createShell(server, directory, {
      command: await captureCommand(directory, "cursor.bin", text),
      metadata: {},
    })
    await waitForShellExit(server, directory, shell.id)

    // A zero budget reads nothing and leaves the cursor in place.
    expect(await readShellPage(server, directory, shell.id, { cursor: 0, limit: 0 })).toEqual({
      output: "",
      cursor: 0,
      size: text.length,
      truncated: false,
    })
    expect(await readShellPage(server, directory, shell.id, { cursor: 1, limit: 0 })).toEqual({
      output: "",
      cursor: 1,
      size: text.length,
      truncated: false,
    })

    // A cursor inside a character decodes its orphaned continuation bytes as replacement
    // characters while still advancing to the captured end.
    const mid = await readShellPage(server, directory, shell.id, { cursor: 1 })
    expect(mid.size).toBe(text.length)
    expect(mid.cursor).toBeGreaterThan(1)
    const pages = await pageShell(server, directory, shell.id, { start: mid.cursor, limit: 1 })
    expect(pages.at(-1)?.cursor).toBe(text.length)

    for (const cursor of [text.length, text.length + 10]) {
      expect(await readShellPage(server, directory, shell.id, { cursor })).toEqual({
        output: "",
        cursor: text.length,
        size: text.length,
        truncated: false,
      })
    }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)

test("pages real Unicode shell output over the relay without corrupting split characters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-remote-shell-unicode-"))
  const server = await startServer(directory)
  const sessionID = "ses_remote_shell_unicode"
  const relay = createRelay()
  const bridge = new RemoteAgent({
    relayURL: "https://relay.example",
    local: createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } }),
    credentials: async () => ({ accessToken: "unicode-token", accessExpiresAt: Date.now() + 600_000 }),
    createConnection: relay.createConnection,
    refreshIntervalMs: 3_600_000,
  })

  try {
    await createSession(server, sessionID, directory)
    await bridge.connect()

    const text = "é€😀-ok\n".repeat(90_000)
    expect(Buffer.byteLength(text)).toBeGreaterThan(1_048_576)
    const shell = await createShell(server, directory, {
      command: await captureCommand(directory, "unicode.txt", Buffer.from(text)),
      metadata: { sessionID },
    })
    await waitForShellExit(server, directory, shell.id)

    // Every page crosses the relay's 65536-byte page limit, so most pages end inside a
    // character; the joined pages must still be the exact captured text.
    const chunks: string[] = []
    let cursor: number | undefined
    for (let count = 0; ; count += 1) {
      const id = `shell_unicode_${count}`
      relay.deliver(
        request(id, "session.shell.output", sessionID, {
          shellID: shell.id,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      )
      const result = valueOf(await answer(relay, id)) as { data: ShellPage }
      expect(result.data.size).toBe(Buffer.byteLength(text))
      expect(result.data.truncated).toBe(false)
      chunks.push(result.data.output)
      if (result.data.cursor >= result.data.size) break
      expect(result.data.cursor).toBeGreaterThan(cursor ?? 0)
      cursor = result.data.cursor
      if (count >= 64) throw new Error("relay shell output paging did not terminate")
    }
    expect(chunks.length).toBeGreaterThan(16)
    expectSameOutput(chunks.join(""), text, "relay page join")
  } finally {
    await bridge.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
