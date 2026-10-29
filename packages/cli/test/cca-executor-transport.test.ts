import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  ccaExecServerUserAgent,
  ccaKeepaliveIntervalMs,
  ccaPongTimeoutMs,
  ccaRegistrationRetryDelay,
  ccaRegistryRequestTimeoutMs,
  ccaWriteTimeoutMs,
  CcaRegistryHttpError,
  registerExecutorEnvironment,
  registerExecutorEnvironmentWithRetry,
  startCcaExecutorTransport,
  validateHarnessKey,
  validateRegistryBaseURL,
  validateWssEndpoint,
  type CcaChannel,
  type CcaExecutorCredential,
  type CcaNoiseIdentity,
  type CcaNoisePublicKey,
  type CcaNoiseTransport,
} from "../src/remote-control/cca-executor-transport"
import { encodeRelayMessageFrame } from "../src/remote-control/cca-relay"

const syntheticCredential: CcaExecutorCredential = {
  accessToken: "synthetic_access_token_secret_12345",
  accountID: "synthetic_account_id_67890",
}

const mockPublicKey: CcaNoisePublicKey = {
  suite: "noise_hybrid_ik_v1",
  x25519_public_key: "synthetic_x25519_key_b64",
  mlkem768_public_key: "synthetic_mlkem768_key_b64",
}

const mockIdentity: CcaNoiseIdentity = {
  publicKey: mockPublicKey,
}

const testEnvId = "env_test_12345"
const testStreamId = "550e8400-e29b-41d4-a716-446655440000"
const execServerUserAgentShape = /^codex_cli_rs\/0\.165\.0-alpha\.1\.2 \((Mac OS|Windows|Linux) [^;()]+; [^;()]+\) unknown$/

class CloseTestSocket extends EventEmitter {
  readyState = 1
  closeCalls = 0

  constructor(readonly behavior: "deferred" | "synchronous" | "throws" = "deferred") {
    super()
  }

  send(_data: Uint8Array | string) {}

  close() {
    this.closeCalls++
    if (this.behavior === "throws") throw new Error("private-close-detail")
    this.readyState = 2
    if (this.behavior === "synchronous") this.finish()
  }

  finish() {
    this.readyState = 3
    this.emit("close")
  }
}

function startCloseTest(socket: import("../src/remote-control/cca-executor-transport").WebSocketLike) {
  return startCcaExecutorTransport({
    environmentID: testEnvId,
    credential: syntheticCredential,
    identity: mockIdentity,
    fetch: async () => Response.json({
      environment_id: testEnvId,
      executor_registration_id: "synthetic-close-registration",
      security_profile: "noise_hybrid_ik_v1",
      url: "wss://rendezvous.chatgpt.com/synthetic-close",
    }),
    connectWebSocket: () => socket,
    onChannel() {},
  })
}

describe("transport socket close ownership", () => {
  test("concurrent close calls share one promise that waits for actual closure", async () => {
    const socket = new CloseTestSocket()
    const transport = await startCloseTest(socket)
    const first = transport.close()
    expect(transport.close()).toBe(first)
    let settled = false
    void first.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(socket.closeCalls).toBe(1)
    expect(socket.readyState).toBe(2)
    socket.finish()
    await first
    expect(transport.close()).toBe(first)
    expect(socket.closeCalls).toBe(1)
    for (const event of ["message", "error", "close", "pong"]) expect(socket.listenerCount(event)).toBe(0)
  })

  test("synchronous close events cannot be missed", async () => {
    const socket = new CloseTestSocket("synchronous")
    const transport = await startCloseTest(socket)
    await transport.close()
    expect(socket.readyState).toBe(3)
    expect(socket.closeCalls).toBe(1)
    expect(socket.listenerCount("error")).toBe(0)
  })

  test("remote closure before explicit close does not request another socket close", async () => {
    const socket = new CloseTestSocket()
    const transport = await startCloseTest(socket)
    socket.finish()
    const closed = transport.close()
    await closed
    expect(transport.close()).toBe(closed)
    expect(socket.closeCalls).toBe(0)
  })

  test("an already CLOSED socket is settled without another close request", async () => {
    const socket = new CloseTestSocket()
    socket.readyState = 3
    const transport = await startCloseTest(socket)
    await transport.close()
    expect(socket.closeCalls).toBe(0)
    expect(socket.listenerCount("close")).toBe(0)
  })

  test("errors while CONNECTING or closing do not certify closure or become unhandled", async () => {
    const socket = new CloseTestSocket()
    socket.readyState = 0
    const transport = await startCloseTest(socket)
    const closing = transport.close()
    let settled = false
    void closing.then(() => { settled = true })
    expect(() => socket.emit("error", new Error("private-connection-detail"))).not.toThrow()
    expect(() => socket.emit("error", new Error("private-closing-detail"))).not.toThrow()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(socket.closeCalls).toBe(1)
    socket.finish()
    await closing
    expect(socket.listenerCount("error")).toBe(0)
  })

  test("an error starts teardown but close waits for the later close event", async () => {
    const socket = new CloseTestSocket()
    const transport = await startCloseTest(socket)
    socket.emit("error", new Error("private-socket-detail"))
    const closing = transport.close()
    let settled = false
    void closing.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(socket.closeCalls).toBe(1)
    socket.finish()
    await closing
  })

  test("EventTarget sockets wait for close and remove their listeners", async () => {
    const target = new EventTarget()
    const listeners = new Set<string>()
    const socket = {
      readyState: 1,
      closeCalls: 0,
      send(_data: Uint8Array | string) {},
      close() {
        this.closeCalls++
        this.readyState = 2
      },
      addEventListener(event: string, listener: EventListener) {
        listeners.add(event)
        target.addEventListener(event, listener)
      },
      removeEventListener(event: string, listener: EventListener) {
        listeners.delete(event)
        target.removeEventListener(event, listener)
      },
    }
    const transport = await startCloseTest(socket)
    const closing = transport.close()
    let settled = false
    void closing.then(() => { settled = true })
    target.dispatchEvent(new Event("error"))
    await Promise.resolve()
    expect(settled).toBe(false)
    socket.readyState = 3
    target.dispatchEvent(new Event("close"))
    await closing
    expect(socket.closeCalls).toBe(1)
    expect(listeners.size).toBe(0)
  })

  test("a missing close observer rejects with one fixed sanitized failure", async () => {
    let closeCalls = 0
    const socket = { send() {}, close() { closeCalls++ } }
    const transport = await startCloseTest(socket)
    const closing = transport.close()
    await expect(closing).rejects.toThrow(/^CCA executor transport cleanup failed$/)
    expect(transport.close()).toBe(closing)
    expect(closeCalls).toBe(1)
  })

  test("an already CLOSED socket needs no event observer", async () => {
    let closeCalls = 0
    const transport = await startCloseTest({ readyState: 3, send() {}, close() { closeCalls++ } })
    await transport.close()
    expect(closeCalls).toBe(0)
  })

  test("a thrown close request rejects without leaking details and keeps errors handled until closure", async () => {
    const socket = new CloseTestSocket("throws")
    const transport = await startCloseTest(socket)
    const closing = transport.close()
    await expect(closing).rejects.toThrow(/^CCA executor transport cleanup failed$/)
    expect(transport.close()).toBe(closing)
    expect(socket.closeCalls).toBe(1)
    expect(() => socket.emit("error", new Error("private-late-error"))).not.toThrow()
    socket.finish()
    expect(socket.listenerCount("error")).toBe(0)
  })
})

describe("cca-executor-transport registry client", () => {
  test("registerExecutorEnvironment posts exact URL, headers, body and sets redirect error", async () => {
    let observedUrl = ""
    let observedInit: RequestInit | undefined

    const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      observedUrl = url
      observedInit = init
      return new Response(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/cloud-agent/ws?role=environment&sig=signed123",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "exec-reg-001",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    const reg = await registerExecutorEnvironment({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetch,
    })

    expect(observedUrl).toBe(`https://codex-cloud-environments.chatgpt.com/api/cloud/environment/${testEnvId}/register`)
    expect(observedInit?.method).toBe("POST")
    expect(observedInit?.redirect).toBe("error")
    expect(observedInit?.headers).toEqual({
      authorization: `Bearer ${syntheticCredential.accessToken}`,
      "chatgpt-account-id": syntheticCredential.accountID,
      originator: "codex_cli_rs",
      "User-Agent": ccaExecServerUserAgent(),
      "content-type": "application/json",
    })
    expect(ccaExecServerUserAgent()).toMatch(execServerUserAgentShape)
    expect(JSON.parse(String(observedInit?.body))).toEqual({
      security_profile: "noise_hybrid_ik_v1",
      executor_public_key: mockPublicKey,
    })

    expect(reg.environmentID).toBe(testEnvId)
    expect(reg.executorRegistrationID).toBe("exec-reg-001")
    expect(reg.url).toBe("wss://rendezvous.chatgpt.com/cloud-agent/ws?role=environment&sig=signed123")
    expect(reg.securityProfile).toBe("noise_hybrid_ik_v1")
  })

  test("registerExecutorEnvironment URL-encodes special characters in environmentID", async () => {
    let observedUrl = ""
    const mockFetch = async (url: string): Promise<Response> => {
      observedUrl = url
      return new Response(
        JSON.stringify({
          environment_id: "env/with/slash",
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "reg-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    await registerExecutorEnvironment({
      environmentID: "env/with/slash",
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetch,
    })

    expect(observedUrl).toContain("/environment/env%2Fwith%2Fslash/register")
  })

  test("registerExecutorEnvironment rejects mismatched environment_id", async () => {
    const mockFetch = async (url: string): Promise<Response> =>
      url.includes("/validate")
        ? new Response(JSON.stringify({ valid: true }), { status: 200 })
        : new Response(
        JSON.stringify({
          environment_id: "different-env-id",
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "reg-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )

    await expect(
      registerExecutorEnvironment({
        environmentID: testEnvId,
        credential: syntheticCredential,
        identity: mockIdentity,
        fetch: mockFetch,
      }),
    ).rejects.toThrow(/environment id/i)
  })

  test("registerExecutorEnvironment rejects unsupported security_profile", async () => {
    const mockFetch = async (url: string): Promise<Response> =>
      url.includes("/validate")
        ? new Response(JSON.stringify({ valid: true }), { status: 200 })
        : new Response(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "unsupported_profile",
          executor_registration_id: "reg-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )

    await expect(
      registerExecutorEnvironment({
        environmentID: testEnvId,
        credential: syntheticCredential,
        identity: mockIdentity,
        fetch: mockFetch,
      }),
    ).rejects.toThrow(/security profile/i)
  })

  test("registerExecutorEnvironment rejects empty executor_registration_id or missing url", async () => {
    const mockFetchEmptyId = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "   ",
        }),
        { status: 200 },
      )

    await expect(
      registerExecutorEnvironment({
        environmentID: testEnvId,
        credential: syntheticCredential,
        identity: mockIdentity,
        fetch: mockFetchEmptyId,
      }),
    ).rejects.toThrow(/executor_registration_id/i)

    const mockFetchNoUrl = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          environment_id: testEnvId,
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "reg-1",
        }),
        { status: 200 },
      )

    await expect(
      registerExecutorEnvironment({
        environmentID: testEnvId,
        credential: syntheticCredential,
        identity: mockIdentity,
        fetch: mockFetchNoUrl,
      }),
    ).rejects.toThrow(/url/i)
  })

  test("registerExecutorEnvironment sanitizes error and does not leak credentials or raw body", async () => {
    const mockFetchFail = async (): Promise<Response> =>
      new Response(JSON.stringify({ secret_server_leak: "raw_internal_details_should_not_leak" }), {
        status: 401,
        statusText: "Unauthorized",
      })

    const rejection = await registerExecutorEnvironment({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetchFail,
    }).catch((err) => err)

    expect(rejection).toBeInstanceOf(Error)
    const msg = rejection.message
    expect(msg).toContain("401")
    expect(msg).not.toContain(syntheticCredential.accessToken)
    expect(msg).not.toContain(syntheticCredential.accountID)
    expect(msg).not.toContain("raw_internal_details_should_not_leak")
  })

  test("registerExecutorEnvironment aborts immediately if signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      registerExecutorEnvironment({
        environmentID: testEnvId,
        credential: syntheticCredential,
        identity: mockIdentity,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted|timed out/i)
  })

  test("registerExecutorEnvironment throws on HTTP redirect response", async () => {
    const mockFetchRedirect = async (): Promise<Response> =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.com/redirect" },
      })

    await expect(
      registerExecutorEnvironment({
        environmentID: testEnvId,
        credential: syntheticCredential,
        identity: mockIdentity,
        fetch: mockFetchRedirect,
      }),
    ).rejects.toThrow(/status 302/i)
  })
})

describe("validateWssEndpoint", () => {
  test("accepts valid wss url on chatgpt.com or its subdomains without userinfo", () => {
    expect(() =>
      validateWssEndpoint("wss://rendezvous.chatgpt.com/cloud-agent/ws?role=environment&sig=abc"),
    ).not.toThrow()

    expect(() =>
      validateWssEndpoint("wss://chatgpt.com/ws"),
    ).not.toThrow()
  })

  test("rejects non-wss schemes (https, ws, http)", () => {
    expect(() => validateWssEndpoint("https://rendezvous.chatgpt.com/ws")).toThrow(/scheme/i)
    expect(() => validateWssEndpoint("ws://rendezvous.chatgpt.com/ws")).toThrow(/scheme/i)
    expect(() => validateWssEndpoint("http://rendezvous.chatgpt.com/ws")).toThrow(/scheme/i)
  })

  test("rejects userinfo in url", () => {
    expect(() =>
      validateWssEndpoint("wss://user:pass@rendezvous.chatgpt.com/ws"),
    ).toThrow(/userinfo/i)
  })

  test("rejects untrusted domains outside chatgpt.com", () => {
    expect(() => validateWssEndpoint("wss://attacker.com/ws")).toThrow(/origin|host/i)
    expect(() => validateWssEndpoint("wss://evilchatgpt.com/ws")).toThrow(/origin|host/i)
    expect(() => validateWssEndpoint("wss://chatgpt.com.attacker.com/ws")).toThrow(/origin|host/i)
  })

  test("sanitizes errors and does not leak signed url query string", () => {
    const signedUrl = "wss://attacker.com/ws?sig=super_secret_leak_123"
    let thrownError: any = null
    try {
      validateWssEndpoint(signedUrl)
    } catch (err) {
      thrownError = err
    }
    expect(thrownError).not.toBeNull()
    expect(thrownError.message).not.toContain("super_secret_leak_123")
  })
})

describe("validateHarnessKey", () => {
  test("posts exact URL, headers, body and accepts 200 with { valid: true }", async () => {
    let observedUrl = ""
    let observedInit: RequestInit | undefined

    const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      observedUrl = url
      observedInit = init
      return new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    await validateHarnessKey({
      environmentID: testEnvId,
      executorRegistrationID: "reg-123",
      credential: syntheticCredential,
      harnessPublicKey: mockPublicKey,
      harnessKeyAuthorization: "harness_auth_token_value",
      streamID: testStreamId,
      fetch: mockFetch,
    })

    expect(observedUrl).toBe(`https://codex-cloud-environments.chatgpt.com/api/cloud/environment/${testEnvId}/validate`)
    expect(observedInit?.method).toBe("POST")
    expect(observedInit?.redirect).toBe("error")
    expect(observedInit?.headers).toEqual({
      authorization: `Bearer ${syntheticCredential.accessToken}`,
      "chatgpt-account-id": syntheticCredential.accountID,
      originator: "codex_cli_rs",
      "User-Agent": ccaExecServerUserAgent(),
      "content-type": "application/json",
      "x-codex-noise-stream-id": testStreamId,
    })
    expect(JSON.parse(String(observedInit?.body))).toEqual({
      executor_registration_id: "reg-123",
      harness_public_key: mockPublicKey,
      harness_key_authorization: "harness_auth_token_value",
    })
  })

  test("rejects if response valid is false or non-2xx", async () => {
    const mockFetchFalse = async (): Promise<Response> =>
      new Response(JSON.stringify({ valid: false }), { status: 200 })

    await expect(
      validateHarnessKey({
        environmentID: testEnvId,
        executorRegistrationID: "reg-123",
        credential: syntheticCredential,
        harnessPublicKey: mockPublicKey,
        harnessKeyAuthorization: "auth",
        streamID: testStreamId,
        fetch: mockFetchFalse,
      }),
    ).rejects.toThrow(/rejected|invalid/i)

    const mockFetch403 = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })

    await expect(
      validateHarnessKey({
        environmentID: testEnvId,
        executorRegistrationID: "reg-123",
        credential: syntheticCredential,
        harnessPublicKey: mockPublicKey,
        harnessKeyAuthorization: "auth",
        streamID: testStreamId,
        fetch: mockFetch403,
      }),
    ).rejects.toThrow(/403/i)
  })

  test("sanitizes errors and does not leak credentials or authorization string", async () => {
    const mockFetch500 = async (): Promise<Response> =>
      new Response("internal server error with secret leak", { status: 500 })

    const rejection = await validateHarnessKey({
      environmentID: testEnvId,
      executorRegistrationID: "reg-123",
      credential: syntheticCredential,
      harnessPublicKey: mockPublicKey,
      harnessKeyAuthorization: "sensitive-harness-key-auth-string",
      streamID: testStreamId,
      fetch: mockFetch500,
    }).catch((err) => err)

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection.message).not.toContain(syntheticCredential.accessToken)
    expect(rejection.message).not.toContain(syntheticCredential.accountID)
    expect(rejection.message).not.toContain("sensitive-harness-key-auth-string")
    expect(rejection.message).not.toContain("internal server error with secret leak")
  })

  test("validateHarnessKey aborts immediately if signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      validateHarnessKey({
        environmentID: testEnvId,
        executorRegistrationID: "reg-123",
        credential: syntheticCredential,
        harnessPublicKey: mockPublicKey,
        harnessKeyAuthorization: "auth",
        streamID: testStreamId,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted|timed out/i)
  })
})

describe("startCcaExecutorTransport", () => {
  test("connects websocket with only x-request-id header and no credentials", async () => {
    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("/register")) {
        return new Response(
          JSON.stringify({
            environment_id: testEnvId,
            url: "wss://rendezvous.chatgpt.com/cloud-agent/ws?role=environment&sig=abc",
            security_profile: "noise_hybrid_ik_v1",
            executor_registration_id: "reg-001",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404 })
    }

    let connectedWsUrl = ""
    let connectedWsHeaders: Record<string, string> = {}
    const mockWs = new CloseTestSocket("synchronous")

    const mockConnectWs = async (url: string, headers: Record<string, string>) => {
      connectedWsUrl = url
      connectedWsHeaders = headers
      return mockWs
    }

    const transportHandle = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetch,
      connectWebSocket: mockConnectWs,
      onChannel() {},
    })

    expect(connectedWsUrl).toBe("wss://rendezvous.chatgpt.com/cloud-agent/ws?role=environment&sig=abc")
    expect(connectedWsHeaders["authorization"]).toBeUndefined()
    expect(connectedWsHeaders["chatgpt-account-id"]).toBeUndefined()
    expect(connectedWsHeaders["sec-websocket-protocol"]).toBeUndefined()
    expect(connectedWsHeaders["x-request-id"]).toMatch(/^req_[0-9a-f]{32}$/)
    expect(Object.keys(connectedWsHeaders)).toEqual(["x-request-id"])

    await transportHandle.close()
  })

  test("runs end-to-end handshake, channel dispatch, send, receive, and close", async () => {
    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("/register")) {
        return new Response(
          JSON.stringify({
            environment_id: testEnvId,
            url: "wss://rendezvous.chatgpt.com/cloud-agent/ws?role=environment&sig=abc",
            security_profile: "noise_hybrid_ik_v1",
            executor_registration_id: "reg-001",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      if (url.includes("/validate")) {
        return new Response(JSON.stringify({ valid: true }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }

    const wsEventListeners: Record<string, ((...args: any[]) => void)[]> = {}
    const wsSentData: Uint8Array[] = []
    let wsClosed = false

    const mockWs = {
      send(data: Uint8Array) {
        wsSentData.push(data)
      },
      close() {
        wsClosed = true
        for (const cb of wsEventListeners["close"] ?? []) {
          cb()
        }
      },
      on(event: string, listener: (...args: any[]) => void) {
        if (!wsEventListeners[event]) wsEventListeners[event] = []
        wsEventListeners[event].push(listener)
      },
    }

    let dispatchedChannel: any = null
    const mockTransport: CcaNoiseTransport = {
      async encrypt(b) {
        return new Uint8Array([0xdd, ...b])
      },
      async decrypt(b) {
        return b.subarray(1)
      },
    }

    const transportHandle = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetch,
      connectWebSocket: async () => mockWs,
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth_token")
        return {
          response: new Uint8Array([0x55]),
          transport: mockTransport,
        }
      },
      onChannel(ch) {
        dispatchedChannel = ch
      },
    })

    const handshakeWire = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([1, 2, 3]) } },
    })

    for (const cb of wsEventListeners["message"] ?? []) {
      cb({ data: handshakeWire })
    }

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(dispatchedChannel).not.toBeNull()
    expect(dispatchedChannel.streamID).toBe(testStreamId)

    await dispatchedChannel.send(new TextEncoder().encode("hello from executor"))

    const receivedFromChannel: Uint8Array[] = []
    const messagePromise = (async () => {
      for await (const msg of dispatchedChannel.messages) {
        receivedFromChannel.push(msg)
        break
      }
    })()

    const appMsg = new TextEncoder().encode("hello from harness")
    const lenPrefix = new Uint8Array([0, 0, 0, appMsg.length])
    const plaintext = new Uint8Array([...lenPrefix, ...appMsg])
    const ciphertext = new Uint8Array([0xdd, ...plaintext])

    const dataWire = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: {
        kind: "data",
        data: {
          seq: 0,
          segment_index: 0,
          segment_count: 1,
          payload: ciphertext,
        },
      },
    })

    for (const cb of wsEventListeners["message"] ?? []) {
      cb({ data: dataWire })
    }

    await messagePromise
    expect(new TextDecoder().decode(receivedFromChannel[0])).toBe("hello from harness")

    await transportHandle.close()
    expect(wsClosed).toBe(true)
    expect(dispatchedChannel.signal.aborted).toBe(true)
  })

  test("sends websocket ping at configured keepalive interval and closes carrier on pong timeout", async () => {
    const mockFetch = async (url: string): Promise<Response> =>
      url.includes("/validate")
        ? new Response(JSON.stringify({ valid: true }), { status: 200 })
        : new Response(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "reg-001",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )

    let pingCalls = 0
    let closed = false
    const listeners: Record<string, ((...args: any[]) => void)[]> = {}

    const mockWs = {
      send() {},
      ping(_data?: unknown, _mask?: boolean, written?: () => void) {
        pingCalls++
        written?.()
      },
      close() {
        closed = true
        for (const cb of listeners["close"] ?? []) cb()
      },
      on(event: string, cb: (...args: any[]) => void) {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
      },
    }

    const transport = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetch,
      connectWebSocket: async () => mockWs,
      onChannel() {},
      keepaliveIntervalMs: 20,
      pongTimeoutMs: 20,
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(pingCalls).toBeGreaterThanOrEqual(1)

    await new Promise((r) => setTimeout(r, 30))
    expect(closed).toBe(true)

    await transport.close()
  })

  test("keeps connection open when pongs are received within watchdog timeout", async () => {
    const mockFetch = async (url: string): Promise<Response> =>
      url.includes("/validate")
        ? new Response(JSON.stringify({ valid: true }), { status: 200 })
        : new Response(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "reg-001",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )

    let pingCalls = 0
    let closed = false
    const listeners: Record<string, ((...args: any[]) => void)[]> = {}

    const mockWs = {
      send() {},
      ping(_data?: unknown, _mask?: boolean, written?: () => void) {
        pingCalls++
        written?.()
        for (const cb of listeners["pong"] ?? []) cb()
      },
      close() {
        closed = true
        for (const cb of listeners["close"] ?? []) cb()
      },
      on(event: string, cb: (...args: any[]) => void) {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
      },
    }

    const transport = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetch,
      connectWebSocket: async () => mockWs,
      onChannel() {},
      keepaliveIntervalMs: 15,
      pongTimeoutMs: 30,
    })

    await new Promise((r) => setTimeout(r, 60))
    expect(pingCalls).toBeGreaterThanOrEqual(2)
    expect(closed).toBe(false)

    await transport.close()
    expect(closed).toBe(true)
  })

  test("exports defaultWsMaxPayload equal to 256 KiB (262144 bytes)", async () => {
    const { defaultWsMaxPayload } = await import("../src/remote-control/cca-executor-transport")
    expect(defaultWsMaxPayload).toBe(256 * 1024)
  })

  test("validateRegistryBaseURL enforces https for chatgpt domains and permits loopback http", async () => {
    const { validateRegistryBaseURL } = await import("../src/remote-control/cca-executor-transport")

    expect(() => validateRegistryBaseURL("https://codex-cloud-environments.chatgpt.com/api")).not.toThrow()
    expect(() => validateRegistryBaseURL("https://chatgpt.com/api")).not.toThrow()
    expect(() => validateRegistryBaseURL("http://localhost:8080")).not.toThrow()
    expect(() => validateRegistryBaseURL("http://127.0.0.1:8080")).not.toThrow()
    expect(() => validateRegistryBaseURL("http://[::1]:8080")).not.toThrow()
    expect(() => validateRegistryBaseURL("https://localhost:8080")).not.toThrow()

    expect(() => validateRegistryBaseURL("http://chatgpt.com/api")).toThrow(/https required/i)
    expect(() => validateRegistryBaseURL("http://attacker.com/api")).toThrow(/https required/i)

    expect(() => validateRegistryBaseURL("https://attacker.com/api")).toThrow(/untrusted/i)
    expect(() => validateRegistryBaseURL("https://chatgpt.com.attacker.com/api")).toThrow(/untrusted/i)
  })

  test("registerExecutorEnvironment rejects untrusted registryBaseURL before making network fetch", async () => {
    let fetchCalled = false
    const mockFetch = async (): Promise<Response> => {
      fetchCalled = true
      return new Response(JSON.stringify({}), { status: 200 })
    }

    await expect(
      registerExecutorEnvironment({
        environmentID: testEnvId,
        credential: syntheticCredential,
        identity: mockIdentity,
        registryBaseURL: "https://evil-attacker.com/api",
        fetch: mockFetch,
      }),
    ).rejects.toThrow(/untrusted/i)

    expect(fetchCalled).toBe(false)
  })

  test("validateHarnessKey rejects untrusted registryBaseURL before making network fetch", async () => {
    let fetchCalled = false
    const mockFetch = async (): Promise<Response> => {
      fetchCalled = true
      return new Response(JSON.stringify({}), { status: 200 })
    }

    await expect(
      validateHarnessKey({
        environmentID: testEnvId,
        executorRegistrationID: "reg-123",
        credential: syntheticCredential,
        harnessPublicKey: mockPublicKey,
        harnessKeyAuthorization: "auth",
        streamID: testStreamId,
        registryBaseURL: "http://attacker.com/api",
        fetch: mockFetch,
      }),
    ).rejects.toThrow(/https required/i)

    expect(fetchCalled).toBe(false)
  })

  test("socket error via .on style triggers carrier teardown without throwing or leaking error details", async () => {
    const mockFetch = async (url: string): Promise<Response> =>
      url.includes("/validate")
        ? new Response(JSON.stringify({ valid: true }), { status: 200 })
        : new Response(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "reg-err-01",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )

    const listeners: Record<string, ((...args: any[]) => void)[]> = {}
    const mockWs = {
      send() {},
      close() {
        for (const cb of listeners["close"] ?? []) cb()
      },
      on(event: string, cb: (...args: any[]) => void) {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
      },
    }

    let channel: CcaChannel | undefined
    const transport = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetch,
      connectWebSocket: async () => mockWs,
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
      onChannel(ch) {
        channel = ch
      },
    })

    const hsBytes = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
    })
    for (const cb of listeners["message"] ?? []) cb({ data: hsBytes })
    await new Promise((r) => setTimeout(r, 10))

    expect(channel).toBeDefined()
    expect(channel!.signal.aborted).toBe(false)

    expect(listeners["error"]).toBeDefined()
    expect(listeners["error"]!.length).toBeGreaterThanOrEqual(1)

    expect(() => {
      for (const cb of listeners["error"] ?? []) {
        cb(new Error("socket connection error embedding wss://secret-token-leak"))
      }
    }).not.toThrow()

    expect(channel!.signal.aborted).toBe(true)

    await expect(transport.close()).resolves.toBeUndefined()
  })

  test("socket error via .addEventListener style triggers carrier teardown without throwing", async () => {
    const mockFetch = async (url: string): Promise<Response> =>
      url.includes("/validate")
        ? new Response(JSON.stringify({ valid: true }), { status: 200 })
        : new Response(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "reg-err-02",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )

    const listeners: Record<string, ((...args: any[]) => void)[]> = {}
    const mockWs = {
      send() {},
      close() {
        for (const cb of listeners["close"] ?? []) cb()
      },
      addEventListener(event: string, cb: (...args: any[]) => void) {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
      },
    }

    let channel: CcaChannel | undefined
    const transport = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      fetch: mockFetch,
      connectWebSocket: async () => mockWs,
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
      onChannel(ch) {
        channel = ch
      },
    })

    const hsBytes = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
    })
    for (const cb of listeners["message"] ?? []) cb({ data: hsBytes })
    await new Promise((r) => setTimeout(r, 10))

    expect(channel).toBeDefined()
    expect(channel!.signal.aborted).toBe(false)

    expect(listeners["error"]).toBeDefined()
    expect(listeners["error"]!.length).toBeGreaterThanOrEqual(1)

    expect(() => {
      for (const cb of listeners["error"] ?? []) {
        cb(new Error("socket failure"))
      }
    }).not.toThrow()

    expect(channel!.signal.aborted).toBe(true)
    await expect(transport.close()).resolves.toBeUndefined()
  })

  test("Finding 9: error messages use fixed string templates without reflecting unvalidated values", async () => {
    const mockFetchBadProfile = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "<script>alert('bad-profile')</script>",
          executor_registration_id: "reg-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )

    await expect(
      registerExecutorEnvironment({
        environmentID: testEnvId,
        credential: syntheticCredential,
        identity: mockIdentity,
        fetch: mockFetchBadProfile,
      }),
    ).rejects.toThrow(/^Environment registry returned unsupported security profile$/)

    expect(() => validateWssEndpoint("wss://malicious-host.com/ws")).toThrow(
      /^Untrusted rendezvous origin host$/,
    )
    expect(() => validateRegistryBaseURL("https://malicious-host.com/api")).toThrow(
      /^Untrusted registry base URL host$/,
    )
  })

  test("Finding 10: validateRegistryBaseURL rejects URLs containing userinfo", () => {
    expect(() => validateRegistryBaseURL("http://user:pass@localhost:8080")).toThrow(
      /userinfo/i,
    )
    expect(() => validateRegistryBaseURL("https://user:pass@chatgpt.com/api")).toThrow(
      /userinfo/i,
    )
  })

  test("Finding 13: validateHarnessKey rejects authorization whose UTF-8 byte length exceeds 4096 bytes", async () => {
    let fetchCalled = false
    const mockFetch = async (): Promise<Response> => {
      fetchCalled = true
      return new Response(JSON.stringify({ valid: true }), { status: 200 })
    }

    const multiByteString = "ж".repeat(2050)
    expect(multiByteString.length).toBe(2050)
    expect(new TextEncoder().encode(multiByteString).length).toBe(4100)

    await expect(
      validateHarnessKey({
        environmentID: testEnvId,
        executorRegistrationID: "reg-123",
        credential: syntheticCredential,
        harnessPublicKey: mockPublicKey,
        harnessKeyAuthorization: multiByteString,
        streamID: testStreamId,
        fetch: mockFetch,
      }),
    ).rejects.toThrow(/authorization.*length/i)

    expect(fetchCalled).toBe(false)
  })
})

const registeredBody = (overrides: Record<string, unknown> = {}) => ({
  environment_id: testEnvId,
  url: "wss://rendezvous.chatgpt.com/cloud-agent/ws?sig=synthetic-parity",
  security_profile: "noise_hybrid_ik_v1",
  executor_registration_id: "synthetic-parity-registration",
  ...overrides,
})

describe("exec-server registry parity (remote.rs, remote/auth.rs, remote/registration_retry.rs)", () => {
  test("the User-Agent follows default_client: originator/version (os_type os_version; arch) terminal", async () => {
    const os = await import("node:os")
    const { readFile } = await import("node:fs/promises")
    const agent = ccaExecServerUserAgent()
    expect(agent).toMatch(execServerUserAgentShape)
    expect(agent).toStartWith("codex_cli_rs/0.165.0-alpha.1.2 (")
    expect(agent).toEndWith(`; ${os.machine()}) unknown`)
    if (process.platform === "darwin") {
      const plist = await readFile("/System/Library/CoreServices/SystemVersion.plist", "utf8")
      const productVersion = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)![1]
      expect(agent).toBe(`codex_cli_rs/0.165.0-alpha.1.2 (Mac OS ${productVersion}; ${os.machine()}) unknown`)
    }
  })

  test("register and validate give up after the registry deadline", async () => {
    expect(ccaRegistryRequestTimeoutMs).toBe(10_000)
    const stalled = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
    })
    const started = performance.now()
    await expect(registerExecutorEnvironment({
      environmentID: testEnvId, credential: syntheticCredential, identity: mockIdentity, fetch: stalled, timeoutMs: 30,
    })).rejects.toThrow(/^Executor registration timed out or was aborted$/)
    await expect(validateHarnessKey({
      environmentID: testEnvId, executorRegistrationID: "reg-1", credential: syntheticCredential,
      harnessPublicKey: mockPublicKey, harnessKeyAuthorization: "auth", fetch: stalled, timeoutMs: 30,
    })).rejects.toThrow(/^Harness key validation timed out or was aborted$/)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("a 401 is retried once with a refreshed credential and never replayed otherwise", async () => {
    const refreshed: CcaExecutorCredential = { accessToken: "synthetic_refreshed_token", accountID: syntheticCredential.accountID }
    const seen: string[] = []
    const responses = [401, 200]
    const result = await registerExecutorEnvironment({
      environmentID: testEnvId, credential: syntheticCredential, identity: mockIdentity,
      fetch: async (_url, init) => {
        seen.push((init?.headers as Record<string, string>).authorization)
        return responses.shift() === 401 ? new Response("{}", { status: 401 }) : Response.json(registeredBody())
      },
      refreshCredential: async (rejected) => {
        expect(rejected).toEqual(syntheticCredential)
        return refreshed
      },
    })
    expect(result.executorRegistrationID).toBe("synthetic-parity-registration")
    expect(seen).toEqual([`Bearer ${syntheticCredential.accessToken}`, `Bearer ${refreshed.accessToken}`])

    for (const refresh of [async () => undefined, async () => syntheticCredential]) {
      let calls = 0
      const error = await registerExecutorEnvironment({
        environmentID: testEnvId, credential: syntheticCredential, identity: mockIdentity,
        fetch: async () => { calls++; return new Response("{}", { status: 401 }) },
        refreshCredential: refresh,
      }).catch((caught) => caught)
      expect(error).toBeInstanceOf(CcaRegistryHttpError)
      expect(error.status).toBe(401)
      expect(calls).toBe(1)
    }

    let twice = 0
    const repeated = await validateHarnessKey({
      environmentID: testEnvId, executorRegistrationID: "reg-1", credential: syntheticCredential,
      harnessPublicKey: mockPublicKey, harnessKeyAuthorization: "auth",
      fetch: async () => { twice++; return new Response("{}", { status: 401 }) },
      refreshCredential: async () => refreshed,
    }).catch((caught) => caught)
    expect(repeated.status).toBe(401)
    expect(twice).toBe(2)
  })

  test("registry errors carry status and the code from the error or detail envelope", async () => {
    const cases: { body: unknown; code: string | undefined }[] = [
      { body: { error: { code: "registration_conflict", message: "synthetic" } }, code: "registration_conflict" },
      { body: { detail: { code: "authentication_service_unavailable" } }, code: "authentication_service_unavailable" },
      { body: { error: { code: "from_error" }, detail: { code: "from_detail" } }, code: "from_error" },
      { body: { error: "synthetic" }, code: undefined },
      { body: "not json", code: undefined },
    ]
    for (const { body, code } of cases) {
      const error = await registerExecutorEnvironment({
        environmentID: testEnvId, credential: syntheticCredential, identity: mockIdentity,
        fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 503 }),
      }).catch((caught) => caught)
      expect(error).toBeInstanceOf(CcaRegistryHttpError)
      expect(error.message).toBe("Executor registration failed with status 503")
      expect({ status: error.status, code: error.code }).toEqual({ status: 503, code })
    }
  })

  test("registration retries only an uncommitted conflict or authentication outage, with capped jittered delays", async () => {
    const statuses: [number, string | undefined][] = [[503, "registration_conflict"], [502, "authentication_service_unavailable"], [503, "registration_conflict"]]
    const waits: number[] = []
    let calls = 0
    const result = await registerExecutorEnvironmentWithRetry({
      environmentID: testEnvId, credential: syntheticCredential, identity: mockIdentity,
      fetch: async () => {
        calls++
        const next = statuses.shift()
        return next === undefined ? Response.json(registeredBody()) : Response.json({ error: { code: next[1] } }, { status: next[0] })
      },
      wait: async (ms) => { waits.push(ms) },
      random: () => 0,
    })
    expect(result.url).toBe("wss://rendezvous.chatgpt.com/cloud-agent/ws?sig=synthetic-parity")
    expect(calls).toBe(4)
    expect(waits).toEqual([500, 1_000, 2_000])

    for (const [status, code] of [[503, undefined], [503, "other"], [502, "registration_conflict"], [500, "registration_conflict"], [429, undefined], [401, undefined]] as const) {
      let attempts = 0
      const error = await registerExecutorEnvironmentWithRetry({
        environmentID: testEnvId, credential: syntheticCredential, identity: mockIdentity,
        fetch: async () => { attempts++; return Response.json(code === undefined ? {} : { error: { code } }, { status }) },
        wait: async () => { throw new Error("must not wait") },
      }).catch((caught) => caught)
      expect(error.status).toBe(status)
      expect(attempts).toBe(1)
    }

    const controller = new AbortController()
    let aborted = 0
    await expect(registerExecutorEnvironmentWithRetry({
      environmentID: testEnvId, credential: syntheticCredential, identity: mockIdentity, signal: controller.signal,
      fetch: async () => { aborted++; return Response.json({ error: { code: "registration_conflict" } }, { status: 503 }) },
      wait: async () => { controller.abort() },
    })).rejects.toThrow()
    expect(aborted).toBe(1)
  })

  test("registration retry delay doubles from 500 ms to a 5 s cap and adds up to half again", () => {
    expect([0, 1, 2, 3, 4, 20].map((attempt) => ccaRegistrationRetryDelay(attempt, () => 0))).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000])
    expect(ccaRegistrationRetryDelay(0, () => 0.9999)).toBe(750)
    expect(ccaRegistrationRetryDelay(20, () => 0.9999)).toBe(7_500)
  })

  test("validation names the stream only when its id is a UUID, in hyphenated lowercase", async () => {
    const seen: (string | undefined)[] = []
    for (const streamID of [
      "550E8400-E29B-41D4-A716-446655440000",
      "550e8400e29b41d4a716446655440000",
      "{550e8400-e29b-41d4-a716-446655440000}",
      "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
      "synthetic-not-a-uuid",
    ]) {
      await validateHarnessKey({
        environmentID: testEnvId, executorRegistrationID: "reg-1", credential: syntheticCredential,
        harnessPublicKey: mockPublicKey, harnessKeyAuthorization: "auth", streamID,
        fetch: async (_url, init) => {
          seen.push((init?.headers as Record<string, string>)["x-codex-noise-stream-id"])
          return Response.json({ valid: true })
        },
      })
    }
    expect(seen).toEqual([testStreamId, testStreamId, testStreamId, testStreamId, undefined])
  })

  test("a supplied registration is dialled without registering again", async () => {
    const urls: string[] = []
    let dialled = ""
    const transport = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      registration: { environmentID: testEnvId, executorRegistrationID: "synthetic-reused", url: "wss://rendezvous.chatgpt.com/reused", securityProfile: "noise_hybrid_ik_v1" },
      fetch: async (url) => { urls.push(url); return Response.json({ valid: true }) },
      connectWebSocket: async (url) => { dialled = url; return new CloseTestSocket("synchronous") },
      onChannel() {},
    })
    expect(urls).toEqual([])
    expect(dialled).toBe("wss://rendezvous.chatgpt.com/reused")
    await transport.close()
  })
})

class KeepaliveSocket extends EventEmitter {
  readyState = 1
  pings = 0
  closed = false
  constructor(private readonly options: { readonly pong?: boolean; readonly completeWrites?: boolean } = {}) {
    super()
  }
  send(_data: Uint8Array | string, callback?: (error?: Error) => void) {
    if (this.options.completeWrites !== false) queueMicrotask(() => callback?.())
  }
  ping(_data?: unknown, _mask?: boolean, callback?: (error?: Error) => void) {
    this.pings++
    if (this.options.completeWrites !== false) queueMicrotask(() => callback?.())
    if (this.options.pong) queueMicrotask(() => this.emit("pong"))
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    queueMicrotask(() => this.emit("close"))
  }
}

describe("rendezvous keepalive parity (relay_writer.rs, websocket_pong_watchdog.rs)", () => {
  const start = (socket: KeepaliveSocket, overrides: Record<string, number>) => startCcaExecutorTransport({
    environmentID: testEnvId,
    credential: syntheticCredential,
    identity: mockIdentity,
    registration: { environmentID: testEnvId, executorRegistrationID: "synthetic-keepalive", url: "wss://rendezvous.chatgpt.com/keepalive", securityProfile: "noise_hybrid_ik_v1" },
    connectWebSocket: async () => socket,
    onChannel() {},
    ...overrides,
  })

  test("defaults are a 30 s ping interval, a 60 s pong deadline, and a 60 s write budget", () => {
    expect([ccaKeepaliveIntervalMs, ccaPongTimeoutMs, ccaWriteTimeoutMs]).toEqual([30_000, 60_000, 60_000])
  })

  test("no ping is sent while a pong is outstanding, and an overdue tick pings as soon as the pong arrives", async () => {
    const socket = new KeepaliveSocket()
    const transport = await start(socket, { keepaliveIntervalMs: 15, pongTimeoutMs: 1_000 })
    await new Promise((r) => setTimeout(r, 80))
    expect(socket.pings).toBe(1)
    socket.emit("pong")
    expect(socket.pings).toBe(2)
    expect(socket.closed).toBe(false)
    await transport.close()
  })

  test("a write that does not complete within the write budget tears the connection down", async () => {
    const socket = new KeepaliveSocket({ pong: true, completeWrites: false })
    await start(socket, { keepaliveIntervalMs: 10, pongTimeoutMs: 1_000, writeTimeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 120))
    expect(socket.pings).toBe(1)
    expect(socket.closed).toBe(true)
  })

  test("completed writes and answered pings keep the connection open", async () => {
    const socket = new KeepaliveSocket({ pong: true })
    const transport = await start(socket, { keepaliveIntervalMs: 10, pongTimeoutMs: 1_000, writeTimeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 120))
    expect(socket.pings).toBeGreaterThanOrEqual(3)
    expect(socket.closed).toBe(false)
    await transport.close()
  })
})
