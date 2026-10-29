import { describe, expect, test } from "bun:test"
import {
  awaitWebSocketOpen,
  CcaConnectProofError,
  runCcaConnectProof,
  type CcaConnectProofErrorCode,
} from "../src/remote-control/cca-connect-proof"
import type { CcaExperimentState } from "../src/remote-control/cca-executor-registration"
import type {
  CcaChannel,
  CcaNoiseIdentity,
  CcaNoiseTransport,
  StartCcaExecutorTransportOptions,
  WebSocketLike,
} from "../src/remote-control/cca-executor-transport"

const syntheticAccountID = "abc"
const syntheticAccountHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
const syntheticExecutorID = "ccarenv_b64_synthetic"
const syntheticAccessToken = "synthetic_access_token_secret"

const completedState: CcaExperimentState = {
  installationID: "synthetic-installation",
  accountHash: syntheticAccountHash,
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  executorID: syntheticExecutorID,
}

const publicKey = {
  suite: "noise_hybrid_ik_v1",
  x25519_public_key: "synthetic_x25519",
  mlkem768_public_key: "synthetic_mlkem768",
}
type FullIdentity = CcaNoiseIdentity & { readonly _private: { readonly marker: string } }
const fullIdentity: FullIdentity = { publicKey, _private: { marker: "synthetic-private" } }

const fakeNoiseTransport: CcaNoiseTransport = {
  encrypt: async (bytes) => bytes,
  decrypt: async (bytes) => bytes,
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController()
  const statuses: string[] = []
  return {
    controller,
    statuses,
    input: {
      state: completedState,
      credential: { accessToken: syntheticAccessToken, accountID: syntheticAccountID },
      identity: fullIdentity,
      acceptHandshake: async () => ({ response: new Uint8Array([1]), transport: fakeNoiseTransport }),
      signal: controller.signal,
      requireChannel: false,
      onStatus: (line: string) => statuses.push(line),
      ...overrides,
    },
  }
}

function fakeChannel(payloads: readonly Uint8Array[], options: { failAfter?: boolean } = {}) {
  let sendCalls = 0
  const channel: CcaChannel = {
    streamID: "synthetic-stream-id-must-not-be-logged",
    signal: new AbortController().signal,
    send: async () => {
      sendCalls++
    },
    messages: (async function* () {
      for (const payload of payloads) yield payload
      if (options.failAfter) throw new Error("synthetic channel failure secret-url")
    })(),
  }
  return { channel, sendCalls: () => sendCalls }
}

function fakeStart(channels: readonly CcaChannel[] = []) {
  let calls = 0
  let closeCalls = 0
  let captured: StartCcaExecutorTransportOptions | undefined
  const startTransport = async (options: StartCcaExecutorTransportOptions) => {
    calls++
    captured = options
    for (const channel of channels) await options.onChannel(channel)
    return {
      close: async () => {
        closeCalls++
      },
    }
  }
  return { startTransport, calls: () => calls, closeCalls: () => closeCalls, captured: () => captured }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

async function expectCode(promise: Promise<unknown>, code: CcaConnectProofErrorCode) {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(CcaConnectProofError)
  expect((error as CcaConnectProofError).code).toBe(code)
  return error as CcaConnectProofError
}

describe("runCcaConnectProof preconditions", () => {
  test("rejects non-completed state before starting transport", async () => {
    const fake = fakeStart()
    const { input, statuses } = baseInput({
      state: { ...completedState, status: "pending" },
      startTransport: fake.startTransport,
    })
    await expectCode(runCcaConnectProof(input), "state_not_completed")
    expect(fake.calls()).toBe(0)
    expect(statuses).toEqual([])
  })

  test("rejects missing or blank executor before starting transport", async () => {
    for (const executorID of [undefined, "  "]) {
      const fake = fakeStart()
      const { input } = baseInput({
        state: { ...completedState, executorID },
        startTransport: fake.startTransport,
      })
      await expectCode(runCcaConnectProof(input), "state_missing_executor")
      expect(fake.calls()).toBe(0)
    }
  })

  test("rejects account mismatch against hardcoded sha256 fixture before starting transport", async () => {
    const fake = fakeStart()
    const { input } = baseInput({
      state: { ...completedState, accountHash: "0".repeat(64) },
      startTransport: fake.startTransport,
    })
    const error = await expectCode(runCcaConnectProof(input), "account_mismatch")
    expect(error.message).not.toContain(syntheticAccountID === "abc" ? syntheticAccessToken : "")
    expect(fake.calls()).toBe(0)
  })

  test("rejects an already-aborted signal before starting transport", async () => {
    const fake = fakeStart()
    const { input, controller } = baseInput({ startTransport: fake.startTransport })
    controller.abort()
    await expectCode(runCcaConnectProof(input), "aborted")
    expect(fake.calls()).toBe(0)
  })
})

describe("runCcaConnectProof lifecycle", () => {
  test("drains two channels by count only, binds full identity, and closes once on abort", async () => {
    const first = fakeChannel([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
    const second = fakeChannel([new Uint8Array([6, 7, 8, 9])])
    const fake = fakeStart([first.channel, second.channel])
    const handshakeIdentities: unknown[] = []
    const { input, controller, statuses } = baseInput({
      startTransport: fake.startTransport,
      requireChannel: true,
      acceptHandshake: async (handshake: { readonly identity: unknown }) => {
        handshakeIdentities.push(handshake.identity)
        return { response: new Uint8Array([1]), transport: fakeNoiseTransport }
      },
    })

    const running = runCcaConnectProof(input)
    await flush()
    const captured = fake.captured()
    expect(captured?.environmentID).toBe(syntheticExecutorID)
    expect(captured?.credential.accessToken).toBe(syntheticAccessToken)
    expect(captured?.identity).toBe(fullIdentity)
    await captured?.acceptHandshake?.({
      identity: { publicKey },
      environmentID: syntheticExecutorID,
      registrationID: "synthetic-registration",
      streamID: "synthetic-stream",
      request: new Uint8Array([9]),
      authorize: async () => undefined,
    })
    expect(handshakeIdentities).toEqual([fullIdentity])

    controller.abort()
    controller.abort()
    await expect(running).resolves.toEqual({ channels: 2, messages: 3, bytes: 9 })
    expect(fake.closeCalls()).toBe(1)
    expect(first.sendCalls() + second.sendCalls()).toBe(0)
    expect(statuses.some((line) => line.includes("state=completed executor_prefix=ccarenv_b64_"))).toBe(true)
    expect(statuses).toContain("cca-connect: credential=resolved")
    expect(statuses).toContain("cca-connect: identity=ready")
    expect(statuses).toContain("cca-connect: relay=registered")
    expect(statuses.some((line) => line.includes("socket=open"))).toBe(false)
    expect(statuses.at(-1)).toBe("cca-connect: shutdown=clean channels=2 messages=3 bytes=9")
    const joined = statuses.join("\n")
    expect(joined).not.toContain(syntheticExecutorID)
    expect(joined).not.toContain(syntheticAccessToken)
    expect(joined).not.toContain("synthetic-stream-id-must-not-be-logged")
  })

  test("channel iteration failure is counted and does not crash the proof", async () => {
    const failing = fakeChannel([new Uint8Array([1, 2])], { failAfter: true })
    const fake = fakeStart([failing.channel])
    const { input, controller, statuses } = baseInput({ startTransport: fake.startTransport })
    const running = runCcaConnectProof(input)
    await flush()
    controller.abort()
    await expect(running).resolves.toEqual({ channels: 1, messages: 1, bytes: 2 })
    expect(statuses.join("\n")).not.toContain("secret-url")
  })

  test("requireChannel fails after exactly one close when no channel arrives", async () => {
    const fake = fakeStart()
    const { input, controller } = baseInput({ startTransport: fake.startTransport, requireChannel: true })
    const running = runCcaConnectProof(input)
    await flush()
    controller.abort()
    await expectCode(running, "channel_required")
    expect(fake.closeCalls()).toBe(1)
  })

  test("transport start failure is sanitized", async () => {
    const { input, statuses } = baseInput({
      startTransport: async () => {
        throw new Error(`failed https://secret-url.example/?token=${syntheticAccessToken}`)
      },
    })
    const error = await expectCode(runCcaConnectProof(input), "transport_failed")
    expect(error.message).not.toContain("secret-url")
    expect(error.message).not.toContain(syntheticAccessToken)
    expect(statuses.join("\n")).not.toContain("secret-url")
    expect(statuses.join("\n")).not.toContain(syntheticAccessToken)
  })
})

class FakeSocket implements WebSocketLike {
  readyState = 0
  closeCalls = 0
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  send() {}
  close() {
    this.closeCalls++
    this.readyState = 3
  }
  on(event: string, listener: (...args: never[]) => void) {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener as (...args: unknown[]) => void)
    this.listeners.set(event, set)
  }
  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener)
  }
  emit(event: string, ...args: unknown[]) {
    if (event === "open") this.readyState = 1
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

describe("awaitWebSocketOpen", () => {
  test("resolves on open and passes url and headers through", async () => {
    const socket = new FakeSocket()
    const seen: unknown[] = []
    const opening = awaitWebSocketOpen(
      (url, headers) => {
        seen.push(url, headers)
        queueMicrotask(() => socket.emit("open"))
        return socket
      },
      "wss://synthetic.example/socket",
      { "x-request-id": "req_synthetic" },
      {},
    )
    await expect(opening).resolves.toBe(socket)
    expect(seen).toEqual(["wss://synthetic.example/socket", { "x-request-id": "req_synthetic" }])
    expect(socket.closeCalls).toBe(0)
  })

  test("resolves when the socket is already open", async () => {
    const socket = new FakeSocket()
    socket.readyState = 1
    await expect(awaitWebSocketOpen(() => socket, "wss://synthetic.example", {}, {})).resolves.toBe(socket)
  })

  test("error and close before open fail sanitized and close the socket", async () => {
    for (const event of ["error", "close"]) {
      const socket = new FakeSocket()
      const opening = awaitWebSocketOpen(
        () => {
          setTimeout(() => socket.emit(event, new Error("secret-url")), 0)
          return socket
        },
        "wss://synthetic.example",
        {},
        {},
      )
      const error = await expectCode(opening, "transport_failed")
      expect(error.message).not.toContain("secret-url")
      expect(socket.closeCalls).toBe(1)
    }
  })

  test("timeout fails and closes the socket", async () => {
    const socket = new FakeSocket()
    await expectCode(
      awaitWebSocketOpen(() => socket, "wss://synthetic.example", {}, { timeoutMs: 20 }),
      "transport_failed",
    )
    expect(socket.closeCalls).toBe(1)
  })

  test("abort fails with aborted and closes the socket", async () => {
    const socket = new FakeSocket()
    const controller = new AbortController()
    const opening = awaitWebSocketOpen(() => socket, "wss://synthetic.example", {}, { signal: controller.signal })
    controller.abort()
    await expectCode(opening, "aborted")
    expect(socket.closeCalls).toBe(1)
  })

  test("connect rejection is sanitized", async () => {
    const error = await expectCode(
      awaitWebSocketOpen(
        async () => {
          throw new Error("secret-url")
        },
        "wss://synthetic.example",
        {},
        {},
      ),
      "transport_failed",
    )
    expect(error.message).not.toContain("secret-url")
  })
})

describe("runCcaConnectProof socket-open reporting", () => {
  test("injected connectWebSocket reports socket=open only after open", async () => {
    const socket = new FakeSocket()
    let closeCalls = 0
    const { input, controller, statuses } = baseInput({
      connectWebSocket: () => {
        queueMicrotask(() => socket.emit("open"))
        return socket
      },
      startTransport: async (options: StartCcaExecutorTransportOptions) => {
        await options.connectWebSocket?.("wss://synthetic.example/relay", { "x-request-id": "req_synthetic" })
        return {
          close: async () => {
            closeCalls++
          },
        }
      },
    })
    const running = runCcaConnectProof(input)
    await flush()
    expect(statuses).toContain("cca-connect: relay=registered socket=open")
    controller.abort()
    await expect(running).resolves.toEqual({ channels: 0, messages: 0, bytes: 0 })
    expect(closeCalls).toBe(1)
  })

  test("injected socket error surfaces as sanitized transport failure without socket=open", async () => {
    const socket = new FakeSocket()
    const { input, statuses } = baseInput({
      connectWebSocket: () => {
        setTimeout(() => socket.emit("error", new Error("secret-url")), 0)
        return socket
      },
      startTransport: async (options: StartCcaExecutorTransportOptions) => {
        await options.connectWebSocket?.("wss://synthetic.example/relay", {})
        return { close: async () => undefined }
      },
    })
    const error = await expectCode(runCcaConnectProof(input), "transport_failed")
    expect(error.message).not.toContain("secret-url")
    expect(statuses.some((line) => line.includes("socket=open"))).toBe(false)
    expect(socket.closeCalls).toBe(1)
  })
})
