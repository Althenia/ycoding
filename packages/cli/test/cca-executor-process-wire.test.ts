import { describe, expect, test } from "bun:test"
import type { CcaNetworkDecision } from "@ycoding-ai/core/cca/network-proxy"
import { CcaRpcError } from "../src/remote-control/cca-executor-rpc"
import {
  CCA_NETWORK_POLICY_DECISION_METHOD,
  CCA_NETWORK_POLICY_REQUEST_METHOD,
  createCcaNetworkPolicyDecider,
  decodeCcaProcessStartExtensions,
  encodeCcaNetworkPolicyDecisionNotification,
  encodeCcaNetworkPolicyRequest,
} from "../src/remote-control/cca-executor-process-wire"

function wireProxy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    enableSocks5: false,
    enableSocks5Udp: false,
    allowUpstreamProxy: false,
    dangerouslyAllowAllUnixSockets: true,
    mode: "limited",
    domains: { "blocked.example.com": "deny", "example.com": "allow" },
    reviewDomains: ["review.example.com"],
    unixSockets: { "/var/run/example.sock": "allow" },
    allowLocalBinding: true,
    ...overrides,
  }
}

function invalidParams(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (!(error instanceof CcaRpcError)) throw error
    expect(error.code).toBe(-32602)
    return error.message
  }
  throw new Error("expected invalid params")
}

describe("process/start extension decoding", () => {
  test("absent and null extensions decode to undefined", () => {
    expect(decodeCcaProcessStartExtensions({ processId: "p" })).toEqual({})
    expect(decodeCcaProcessStartExtensions({ processId: "p", networkProxy: null, shellSnapshot: null })).toEqual({})
  })

  test("decodes shell snapshot requests and ignores unknown fields", () => {
    expect(
      decodeCcaProcessStartExtensions({
        processId: "p",
        shellSnapshot: { scopeId: "attachment-1", shell: { name: "zsh", path: "/bin/zsh", extra: 1 }, extra: true },
      }),
    ).toEqual({ shellSnapshot: { scopeId: "attachment-1", shell: { name: "zsh", path: "/bin/zsh" } } })
  })

  test("rejects malformed shell snapshot requests", () => {
    for (const shellSnapshot of [
      "attachment",
      [],
      {},
      { scopeId: 1, shell: { name: "zsh", path: "/bin/zsh" } },
      { scopeId: "a" },
      { scopeId: "a", shell: null },
      { scopeId: "a", shell: { name: "zsh" } },
      { scopeId: "a", shell: { name: "zsh", path: 3 } },
    ]) {
      expect(invalidParams(() => decodeCcaProcessStartExtensions({ processId: "p", shellSnapshot }))).toStartWith("Invalid params: ")
    }
  })

  test("decodes the network proxy launch config with defaults", () => {
    const decoded = decodeCcaProcessStartExtensions({
      processId: "p",
      networkProxy: { proxy: wireProxy({ reviewDomains: undefined, domains: null, unixSockets: undefined, futureField: 1 }) },
    })
    expect(decoded.networkProxy).toEqual({
      proxy: {
        enabled: true,
        credentialMasking: false,
        credentialProviders: {},
        enableSocks5: false,
        enableSocks5Udp: false,
        allowUpstreamProxy: false,
        dangerouslyAllowAllUnixSockets: true,
        mode: "limited",
        reviewDomains: [],
        allowLocalBinding: true,
      },
      auditMetadata: {},
    })
  })

  test("decodes every supported launch field", () => {
    const decoded = decodeCcaProcessStartExtensions({
      processId: "p",
      networkProxy: {
        proxy: wireProxy({
          credentialMasking: true,
          credentialProviders: {
            vendor: { env: ["VENDOR_TOKEN"], patterns: ["vendor_[a-z]{8}"], url_prefix_from_env: "VENDOR_BASE_URL", auth: ["bearer", "basic"] },
          },
        }),
        auditMetadata: { conversationId: "conversation-1", model: "model-1", unknownKey: "ignored" },
        environmentId: "remote",
        executionId: "execution-1",
        policyDecisionTimeoutMs: 900_000,
      },
    })
    expect(decoded.networkProxy).toEqual({
      proxy: {
        enabled: true,
        credentialMasking: true,
        credentialProviders: {
          vendor: {
            env: ["VENDOR_TOKEN"],
            patterns: ["vendor_[a-z]{8}"],
            url_prefixes: [],
            url_prefix_from_env: "VENDOR_BASE_URL",
            auth: ["bearer", "basic"],
          },
        },
        enableSocks5: false,
        enableSocks5Udp: false,
        allowUpstreamProxy: false,
        dangerouslyAllowAllUnixSockets: true,
        mode: "limited",
        domains: { "blocked.example.com": "deny", "example.com": "allow" },
        reviewDomains: ["review.example.com"],
        unixSockets: { "/var/run/example.sock": "allow" },
        allowLocalBinding: true,
      },
      auditMetadata: { conversationId: "conversation-1", model: "model-1" },
      environmentId: "remote",
      executionId: "execution-1",
      policyDecisionTimeoutMs: 900_000,
    })
  })

  test("discards provider rules when masking is omitted or disabled", () => {
    const providers = { vendor: { env: ["VENDOR_TOKEN"], auth: ["bearer"] } }
    for (const credentialMasking of [undefined, false]) {
      const decoded = decodeCcaProcessStartExtensions({
        processId: "p",
        networkProxy: { proxy: wireProxy({ credentialMasking, credentialProviders: providers }) },
      })
      expect(decoded.networkProxy!.proxy.credentialMasking).toBe(false)
      expect(decoded.networkProxy!.proxy.credentialProviders).toEqual({})
    }
  })

  test("rejects malformed network proxy launch configs", () => {
    const cases: unknown[] = [
      "proxy",
      {},
      { proxy: null },
      { proxy: wireProxy({ enabled: "yes" }) },
      { proxy: wireProxy({ allowLocalBinding: undefined }) },
      { proxy: wireProxy({ enableSocks5: undefined }) },
      { proxy: wireProxy({ mode: "open" }) },
      { proxy: wireProxy({ domains: { "example.com": "maybe" } }) },
      { proxy: wireProxy({ domains: ["example.com"] }) },
      { proxy: wireProxy({ reviewDomains: [1] }) },
      { proxy: wireProxy({ unixSockets: { "/tmp/a.sock": "none" } }) },
      { proxy: wireProxy({ credentialMasking: "true" }) },
      { proxy: wireProxy({ credentialMasking: true, credentialProviders: { vendor: { env: ["A"], unknown: 1 } } }) },
      { proxy: wireProxy({ credentialMasking: true, credentialProviders: { vendor: { auth: ["oauth"] } } }) },
      { proxy: wireProxy({ credentialMasking: true, credentialProviders: { vendor: { header: 1 } } }) },
      { proxy: wireProxy(), auditMetadata: { model: 1 } },
      { proxy: wireProxy(), environmentId: 1 },
      { proxy: wireProxy(), executionId: false },
      { proxy: wireProxy(), policyDecisionTimeoutMs: -1 },
      { proxy: wireProxy(), policyDecisionTimeoutMs: 1.5 },
      { proxy: wireProxy(), policyDecisionTimeoutMs: "900" },
    ]
    for (const networkProxy of cases) {
      expect(invalidParams(() => decodeCcaProcessStartExtensions({ processId: "p", networkProxy }))).toStartWith("Invalid params: ")
    }
  })

  test("validates the policy decision callback timeout and process id", () => {
    expect(
      invalidParams(() =>
        decodeCcaProcessStartExtensions({ processId: "p", networkProxy: { proxy: wireProxy(), policyDecisionTimeoutMs: 0 } }),
      ),
    ).toBe("Invalid params: network policy decision callback timeout must be nonzero")
    for (const processId of ["", "é".repeat(129)]) {
      expect(
        invalidParams(() =>
          decodeCcaProcessStartExtensions({ processId, networkProxy: { proxy: wireProxy(), policyDecisionTimeoutMs: 1 } }),
        ),
      ).toBe("Invalid params: callback-enabled process ID must be non-empty and at most 256 bytes")
    }
    expect(
      decodeCcaProcessStartExtensions({ processId: "p".repeat(256), networkProxy: { proxy: wireProxy(), policyDecisionTimeoutMs: 1 } })
        .networkProxy!.policyDecisionTimeoutMs,
    ).toBe(1)
  })
})

describe("network policy wire shapes", () => {
  test("policy request params use stable JSON", () => {
    expect(CCA_NETWORK_POLICY_REQUEST_METHOD).toBe("network/policyRequest")
    expect(encodeCcaNetworkPolicyRequest("process-1", { protocol: "https_connect", host: "example.com", port: 443 })).toEqual({
      processId: "process-1",
      request: { protocol: "https_connect", host: "example.com", port: 443 },
    })
  })

  test("decision notification uses stable JSON", () => {
    expect(CCA_NETWORK_POLICY_DECISION_METHOD).toBe("network/policyDecision")
    expect(
      encodeCcaNetworkPolicyDecisionNotification("process-1", {
        timestamp: "2026-08-11T12:34:56.789Z",
        scope: "domain",
        decision: "deny",
        source: "baseline_policy",
        reason: "not_allowed",
        protocol: "https_connect",
        host: "example.com",
        port: 443,
        method: "CONNECT",
        client: "127.0.0.1",
        policyOverride: false,
      }),
    ).toEqual({
      processId: "process-1",
      timestamp: "2026-08-11T12:34:56.789Z",
      scope: "domain",
      decision: "deny",
      source: "baseline_policy",
      reason: "not_allowed",
      protocol: "https_connect",
      host: "example.com",
      port: 443,
      method: "CONNECT",
      client: "127.0.0.1",
      policyOverride: false,
    })
    expect(
      encodeCcaNetworkPolicyDecisionNotification("process-1", {
        timestamp: "t",
        scope: "domain",
        decision: "allow",
        source: "baseline_policy",
        reason: "allow",
        protocol: "http",
        host: "example.com",
        port: 80,
        policyOverride: false,
      }),
    ).toEqual({
      processId: "process-1",
      timestamp: "t",
      scope: "domain",
      decision: "allow",
      source: "baseline_policy",
      reason: "allow",
      protocol: "http",
      host: "example.com",
      port: 80,
      policyOverride: false,
    })
  })
})

describe("controller network policy decider", () => {
  interface Call {
    readonly method: string
    readonly params: unknown
    readonly signal: AbortSignal
  }

  function harness(respond: (call: Call) => Promise<unknown>, controllerTimeoutMs = 60_000, signal?: AbortSignal, transportMarginMs?: number) {
    const calls: Call[] = []
    const decider = createCcaNetworkPolicyDecider({
      processId: "process",
      controllerTimeoutMs,
      signal,
      transportMarginMs,
      call: (method, params, callSignal) => {
        const call = { method, params, signal: callSignal }
        calls.push(call)
        return respond(call)
      },
    })
    return { calls, decider }
  }

  test("returns the client policy decision", async () => {
    const { calls, decider } = harness(async () => ({ decision: { type: "allow" } }))
    expect(await decider({ protocol: "https_connect", host: "example.com", port: 443 })).toEqual({ type: "allow" })
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ["network/policyRequest", { processId: "process", request: { protocol: "https_connect", host: "example.com", port: 443 } }],
    ])
  })

  test("policy response reasons are bounded and fail closed", async () => {
    const boundary = "d".repeat(1024)
    const cases: Array<[unknown, CcaNetworkDecision]> = [
      [{ decision: { type: "deny", reason: boundary } }, { type: "deny", reason: boundary }],
      [{ decision: { type: "deny", reason: "d".repeat(1025) } }, { type: "deny", reason: "not_allowed" }],
      [{ decision: { type: "ask", reason: "ask permission" } }, { type: "ask", reason: "ask permission" }],
      [{ decision: { type: "ask", reason: "ask\npermission" } }, { type: "deny", reason: "not_allowed" }],
      [{ decision: { type: "deny" } }, { type: "deny", reason: "not_allowed" }],
      [{ decision: { type: "maybe" } }, { type: "deny", reason: "not_allowed" }],
      [{}, { type: "deny", reason: "not_allowed" }],
      [null, { type: "deny", reason: "not_allowed" }],
    ]
    for (const [response, expected] of cases) {
      const { decider } = harness(async () => response)
      expect(await decider({ protocol: "http", host: "example.com", port: 80 })).toEqual(expected)
    }
  })

  test("boundary host is relayed and invalid hosts fail closed before the reverse request", async () => {
    const { calls, decider } = harness(async () => ({ decision: { type: "allow" } }))
    expect(await decider({ protocol: "http", host: "h".repeat(253), port: 80 })).toEqual({ type: "allow" })
    for (const host of ["", "host name", "host\u0000name", "h".repeat(254), "tab\thost"]) {
      expect(await decider({ protocol: "http", host, port: 80 })).toEqual({ type: "deny", reason: "not_allowed" })
    }
    expect(calls).toHaveLength(1)
  })

  test("request failures fail closed", async () => {
    const { decider } = harness(async () => {
      throw new Error("transport closed")
    })
    expect(await decider({ protocol: "http", host: "example.com", port: 80 })).toEqual({ type: "deny", reason: "not_allowed" })
  })

  test("the configured decision timeout plus transport margin fails closed and aborts the request", async () => {
    const { calls, decider } = harness(() => new Promise(() => {}), 10, undefined, 20)
    const started = performance.now()
    const decision = await decider({ protocol: "http", host: "example.com", port: 80 })
    expect(decision).toEqual({ type: "deny", reason: "not_allowed" })
    expect(performance.now() - started).toBeGreaterThanOrEqual(25)
    expect(calls[0].signal.aborted).toBe(true)
  })

  test("process shutdown fails pending and later decisions closed", async () => {
    const shutdown = new AbortController()
    const { calls, decider } = harness(() => new Promise(() => {}), 60_000, shutdown.signal)
    const pending = decider({ protocol: "http", host: "example.com", port: 80 })
    await Bun.sleep(5)
    shutdown.abort()
    expect(await pending).toEqual({ type: "deny", reason: "not_allowed" })
    expect(calls[0].signal.aborted).toBe(true)
    expect(await decider({ protocol: "http", host: "example.com", port: 80 })).toEqual({ type: "deny", reason: "not_allowed" })
    expect(calls).toHaveLength(1)
  })
})
