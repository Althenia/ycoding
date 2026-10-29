import { afterEach, describe, expect, test } from "bun:test"
import http from "node:http"
import net from "node:net"
import type { CcaAuthorizationInput } from "../src/cca/executor"
import {
  CcaNetworkProxyError,
  ccaCredentialMasking,
  ccaNetworkProxyCapabilities,
  compileDomainPatterns,
  createCcaHostPolicy,
  isNonPublicIp,
  normalizeHost,
  startCcaNetworkProxy,
  type CcaNetworkDecision,
  type CcaNetworkPolicyAuditEvent,
  type CcaNetworkPolicyRequest,
  type CcaRemoteNetworkProxyConfig,
  type CcaRemoteNetworkProxyLaunchConfig,
} from "../src/cca/network-proxy"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function proxyConfig(overrides: Partial<CcaRemoteNetworkProxyConfig> = {}): CcaRemoteNetworkProxyConfig {
  return {
    enabled: true,
    credentialMasking: false,
    credentialProviders: {},
    enableSocks5: false,
    enableSocks5Udp: false,
    allowUpstreamProxy: false,
    dangerouslyAllowAllUnixSockets: false,
    mode: "full",
    reviewDomains: [],
    allowLocalBinding: false,
    ...overrides,
  }
}

function launch(overrides: Partial<CcaRemoteNetworkProxyConfig> = {}): CcaRemoteNetworkProxyLaunchConfig {
  return { proxy: proxyConfig(overrides), auditMetadata: {} }
}

interface AuthorizationRecorder {
  readonly calls: CcaAuthorizationInput[]
  readonly released: number[]
  readonly authorize: (input: CcaAuthorizationInput) => Promise<{ release(): Promise<void> }>
}

function recorder(deny = false): AuthorizationRecorder {
  const calls: CcaAuthorizationInput[] = []
  const released: number[] = []
  return {
    calls,
    released,
    authorize: async (input) => {
      calls.push(input)
      if (deny) throw new Error("denied")
      const index = calls.length - 1
      return { release: async () => void released.push(index) }
    },
  }
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address !== "object") throw new Error("listener has no TCP address")
  return address.port
}

async function upstreamHttp(): Promise<{ port: number; requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> }> {
  const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body })
      res.setHeader("content-type", "text/plain")
      res.end(`upstream:${req.method}:${req.url}`)
    })
  })
  server.keepAliveTimeout = 1
  return { port: await listen(server), requests }
}

async function echoServer(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])))
    socket.on("error", () => {})
  })
  return listen(server)
}

function rawExchange(port: number, payload: string | Buffer, until: (received: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1")
    let received = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out; received ${received.toString("latin1")}`))
    }, 5_000)
    socket.on("connect", () => socket.write(payload))
    socket.on("data", (data) => {
      received = Buffer.concat([received, data])
      if (until(received)) {
        clearTimeout(timer)
        socket.destroy()
        resolve(received)
      }
    })
    socket.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on("close", () => {
      clearTimeout(timer)
      resolve(received)
    })
  })
}

function responseText(received: Buffer): string {
  return received.toString("utf8")
}

describe("domain patterns", () => {
  test("match exact hosts, scoped wildcards, and UTF-8 bytes", () => {
    const cases: Array<[string, string, boolean]> = [
      ["api?.com", "api1.com", true],
      ["api??.com", "apié.com", true],
      ["api????.com", "api😀.com", true],
      ["api?*.com", "apié.com", true],
      ["*.例???.com", "a.例子.com", true],
      ["*.例???.com", "例子.com", false],
      ["**.例???.com", "例子.com", true],
      ["bücher.de", "xn--bcher-kva.de", false],
      ["xn--*.de", "xn--bcher-kva.de", true],
      ["É.com", "é.com", false],
      ["É.COM", "É.com", true],
      ["example.com", "example.com", true],
      ["example.com", "api.example.com", false],
      ["*.example.com", "api.example.com", true],
      ["*.example.com", "example.com", false],
      ["**.example.com", "example.com", true],
      ["**.example.com", "a.b.example.com", true],
    ]
    for (const [pattern, host, expected] of cases) {
      for (const globalWildcard of ["allow", "reject"] as const) {
        expect([pattern, host, compileDomainPatterns([pattern], { globalWildcard }).isMatch(normalizeHost(host))]).toEqual([
          pattern,
          host,
          expected,
        ])
      }
    }
  })

  test("reject unsupported syntax instead of dropping rules", () => {
    for (const pattern of ["", " ", "*.", "**.", "**", "a**b.com", "[ab].com", "a[bc].com", "a{b,c}.com", "a/b.com", "a\\b.com", "a b.com"]) {
      expect(() => compileDomainPatterns([pattern], { globalWildcard: "allow" })).toThrow()
    }
  })

  test("global wildcard is allowed only for allowlists", () => {
    expect(compileDomainPatterns(["*"], { globalWildcard: "allow" }).isMatch("anything.example")).toBe(true)
    expect(() => compileDomainPatterns(["*"], { globalWildcard: "reject" })).toThrow("unsupported global wildcard")
  })

  test("normalize hosts for policy matching", () => {
    expect(normalizeHost("  Example.COM. ")).toBe("example.com")
    expect(normalizeHost("example.com:443")).toBe("example.com")
    expect(normalizeHost("[::1]:443")).toBe("::1")
    expect(normalizeHost("fe80::1%25en0")).toBe("fe80::1%en0")
    expect(normalizeHost("::1")).toBe("::1")
  })

  test("classify non-public IP literals", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "240.0.0.1", "255.255.255.255", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1"]) {
      expect([ip, isNonPublicIp(ip)]).toEqual([ip, true])
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect([ip, isNonPublicIp(ip)]).toEqual([ip, false])
    }
  })
})

describe("host policy", () => {
  const noLookup = async () => {
    throw new Error("unexpected DNS lookup")
  }

  test("explicit deny wins over allow", async () => {
    const policy = createCcaHostPolicy(proxyConfig({ domains: { "**.example.com": "allow", "blocked.example.com": "deny" } }), {
      lookup: async () => ["93.184.216.34"],
    })
    expect(await policy.hostBlocked("blocked.example.com", 443)).toBe("denied")
    expect(await policy.hostBlocked("api.example.com", 443)).toBe("allowed")
    expect(await policy.hostBlocked("other.test", 443)).toBe("not_allowed")
  })

  test("duplicate patterns resolve with deny precedence", async () => {
    const policy = createCcaHostPolicy(proxyConfig({ domains: { "example.com": "allow", "EXAMPLE.com": "deny" } }), { lookup: noLookup })
    expect(await policy.hostBlocked("example.com", 443)).toBe("denied")
  })

  test("local literals require an explicit exact allow entry", async () => {
    const wildcard = createCcaHostPolicy(proxyConfig({ domains: { "*": "allow" } }), { lookup: noLookup })
    expect(await wildcard.hostBlocked("127.0.0.1", 80)).toBe("not_allowed_local")
    expect(await wildcard.hostBlocked("localhost", 80)).toBe("not_allowed_local")
    const explicit = createCcaHostPolicy(proxyConfig({ domains: { "127.0.0.1": "allow" } }), { lookup: noLookup })
    expect(await explicit.hostBlocked("127.0.0.1", 80)).toBe("allowed")
    const binding = createCcaHostPolicy(proxyConfig({ domains: { "*": "allow" }, allowLocalBinding: true }), { lookup: noLookup })
    expect(await binding.hostBlocked("127.0.0.1", 80)).toBe("allowed")
  })

  test("allowlisted hostnames resolving to private addresses are blocked", async () => {
    const policy = createCcaHostPolicy(proxyConfig({ domains: { "internal.example": "allow", "public.example": "allow", "broken.example": "allow" } }), {
      lookup: async (host) => {
        if (host === "internal.example") return ["93.184.216.34", "10.0.0.5"]
        if (host === "public.example") return ["93.184.216.34"]
        throw new Error("lookup failed")
      },
    })
    expect(await policy.hostBlocked("internal.example", 443)).toBe("not_allowed_local")
    expect(await policy.hostBlocked("public.example", 443)).toBe("allowed")
    expect(await policy.hostBlocked("broken.example", 443)).toBe("not_allowed_local")
  })

  test("review domains precede ordinary allow rules", async () => {
    const policy = createCcaHostPolicy(
      proxyConfig({ domains: { "**.example.com": "allow" }, reviewDomains: ["review.example.com"] }),
      { lookup: async () => ["93.184.216.34"] },
    )
    expect(await policy.hostBlocked("review.example.com", 443)).toBe("not_allowed")
    expect(await policy.hostBlocked("review.example.com", 443, true)).toBe("allowed")
    expect(await policy.hostBlocked("api.example.com", 443)).toBe("allowed")
  })

  test("decider is consulted only for not_allowed and cannot bypass baseline denials", async () => {
    const policy = createCcaHostPolicy(
      proxyConfig({ domains: { "denied.example": "deny", "allowed.example": "allow" } }),
      { lookup: async (host) => (host === "private.example" ? ["192.168.0.10"] : ["93.184.216.34"]) },
    )
    const asked: CcaNetworkPolicyRequest[] = []
    const decider = async (request: CcaNetworkPolicyRequest): Promise<CcaNetworkDecision> => {
      asked.push(request)
      return { type: "allow" }
    }
    const request = (host: string) => ({ protocol: "http" as const, host, port: 80 })

    const allowed = await policy.evaluate(request("allowed.example"), { decider })
    expect(allowed.decision).toEqual({ type: "allow" })
    expect(allowed.event).toMatchObject({ scope: "domain", decision: "allow", source: "baseline_policy", reason: "allow", policyOverride: false })

    const denied = await policy.evaluate(request("denied.example"), { decider })
    expect(denied.decision).toEqual({ type: "deny", reason: "denied" })
    expect(denied.event).toMatchObject({ decision: "deny", source: "baseline_policy", reason: "denied" })

    const overridden = await policy.evaluate(request("unknown.example"), { decider, method: "GET", client: "127.0.0.1" })
    expect(overridden.decision).toEqual({ type: "allow" })
    expect(overridden.event).toMatchObject({
      decision: "allow",
      source: "decider",
      reason: "not_allowed",
      policyOverride: true,
      method: "GET",
      client: "127.0.0.1",
      protocol: "http",
      host: "unknown.example",
      port: 80,
    })
    expect(overridden.event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const privateHost = await policy.evaluate(request("private.example"), { decider })
    expect(privateHost.decision).toEqual({ type: "deny", reason: "not_allowed_local" })
    expect(privateHost.event).toMatchObject({ decision: "deny", source: "baseline_policy", reason: "not_allowed_local", policyOverride: false })
    expect(asked.map((entry) => entry.host)).toEqual(["unknown.example", "private.example"])

    const asking = await policy.evaluate(request("unknown.example"), { decider: async () => ({ type: "ask", reason: "needs review" }) })
    expect(asking.decision).toEqual({ type: "ask", reason: "needs review" })
    expect(asking.event).toMatchObject({ decision: "ask", source: "decider", reason: "needs review" })

    const empty = await policy.evaluate(request("unknown.example"), { decider: async () => ({ type: "deny", reason: "" }) })
    expect(empty.decision).toEqual({ type: "deny", reason: "policy_denied" })

    const withoutDecider = await policy.evaluate(request("unknown.example"))
    expect(withoutDecider.decision).toEqual({ type: "deny", reason: "not_allowed" })
    expect(withoutDecider.event).toMatchObject({ source: "baseline_policy", reason: "not_allowed" })
  })
})

describe("credential masking capability", () => {
  test("maps capabilities to masking modes", () => {
    expect(ccaCredentialMasking({})).toBe("disabled")
    expect(ccaCredentialMasking({ credentialMasking: false, credentialMaskingCustomProviders: true })).toBe("disabled")
    expect(ccaCredentialMasking({ credentialMasking: true })).toBe("builtInOnly")
    expect(ccaCredentialMasking({ credentialMasking: true, credentialMaskingCustomProviders: true })).toBe("withConfiguredProviders")
  })

  test("advertises launch, review domains, and unix shell snapshots", () => {
    expect(ccaNetworkProxyCapabilities({ platform: "darwin", shell: "sh" })).toEqual({
      networkProxyLaunch: true,
      networkProxyReviewDomains: true,
      credentialMasking: false,
      credentialMaskingCustomProviders: false,
      shellSnapshotV2: true,
    })
    expect(ccaNetworkProxyCapabilities({ platform: "win32", shell: "bash" }).shellSnapshotV2).toBe(false)
  })
})

describe("executor-local proxy", () => {
  async function start(
    overrides: Partial<CcaRemoteNetworkProxyConfig>,
    options: {
      readonly env?: Record<string, string>
      readonly deny?: boolean
      readonly decider?: (request: CcaNetworkPolicyRequest) => Promise<CcaNetworkDecision>
    } = {},
  ) {
    const auth = recorder(options.deny)
    const events: CcaNetworkPolicyAuditEvent[] = []
    const handle = await startCcaNetworkProxy({
      processId: "proc-1",
      launch: launch(overrides),
      env: options.env ?? { PATH: "/usr/bin:/bin" },
      authorize: auth.authorize,
      decider: options.decider,
      onPolicyDecision: (event) => events.push(event),
      lookup: async () => ["93.184.216.34"],
      platform: "linux",
    })
    cleanups.push(() => handle.close())
    const port = Number(new URL(handle.env.HTTP_PROXY).port)
    return { handle, auth, events, port }
  }

  test("applies proxy environment overrides and the managed sandbox context", async () => {
    const { handle, port } = await start({ unixSockets: { "/tmp/allowed.sock": "allow", "relative.sock": "deny" } })
    const url = `http://127.0.0.1:${port}`
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "WS_PROXY", "WSS_PROXY", "ws_proxy", "wss_proxy", "npm_config_proxy", "NPM_CONFIG_HTTPS_PROXY", "YARN_HTTP_PROXY", "BUNDLE_HTTPS_PROXY", "PIP_PROXY", "DOCKER_HTTP_PROXY", "ALL_PROXY", "all_proxy", "FTP_PROXY", "ftp_proxy"]) {
      expect([key, handle.env[key]]).toEqual([key, url])
    }
    for (const key of ["NO_PROXY", "no_proxy", "npm_config_noproxy", "NPM_CONFIG_NOPROXY", "BUNDLE_NO_PROXY"]) {
      expect([key, handle.env[key]]).toEqual([key, ""])
    }
    expect(handle.env.CODEX_NETWORK_PROXY_ACTIVE).toBe("1")
    expect(handle.env.CODEX_NETWORK_ALLOW_LOCAL_BINDING).toBe("0")
    expect(handle.env.ELECTRON_GET_USE_PROXY).toBe("true")
    expect(handle.env.NODE_USE_ENV_PROXY).toBe("1")
    expect(handle.env.PATH).toBe("/usr/bin:/bin")
    expect(handle.managedNetwork).toEqual({
      loopbackPorts: [port],
      allowLocalBinding: false,
      allowUnixSockets: ["/tmp/allowed.sock"],
      dangerouslyAllowAllUnixSockets: false,
    })
    expect(handle.credentialMasking).toBe("disabled")
  })

  test("local binding keeps default local destinations direct", async () => {
    const { handle } = await start({ allowLocalBinding: true })
    expect(handle.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")
    expect(handle.env.CODEX_NETWORK_ALLOW_LOCAL_BINDING).toBe("1")
    expect(handle.managedNetwork.allowLocalBinding).toBe(true)
  })

  test("rejects invalid launch configuration with invalid params", async () => {
    const cases: Array<Partial<CcaRemoteNetworkProxyConfig>> = [
      { enabled: false },
      { domains: { "*": "deny" } },
      { domains: { "a{b}.com": "allow" } },
      { reviewDomains: ["**"] },
      { unixSockets: { "relative.sock": "allow" } },
      { unixSockets: { "/tmp/a\0b": "allow" } },
    ]
    for (const overrides of cases) {
      const error = await startCcaNetworkProxy({
        processId: "proc-1",
        launch: launch(overrides),
        env: {},
        authorize: recorder().authorize,
        platform: "linux",
      }).catch((caught: unknown) => caught)
      if (!(error instanceof CcaNetworkProxyError)) throw error
      expect(error.code).toBe(-32602)
      expect(error.message).toStartWith("invalid network proxy config: ")
    }
  })

  test("forwards allowlisted plain HTTP and authorizes the destination", async () => {
    const upstream = await upstreamHttp()
    const { port, auth, events } = await start({ domains: { "127.0.0.1": "allow" } })
    const received = await rawExchange(
      port,
      `POST http://127.0.0.1:${upstream.port}/hello?x=1 HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nProxy-Connection: keep-alive\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody`,
      (bytes) => responseText(bytes).includes(`upstream:POST:/hello?x=1`),
    )
    expect(responseText(received)).toStartWith("HTTP/1.1 200")
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0].body).toBe("body")
    expect(upstream.requests[0].headers["proxy-connection"]).toBeUndefined()
    expect(auth.calls).toEqual([
      {
        action: "webfetch",
        resources: [`http://127.0.0.1:${upstream.port}/hello?x=1`],
        metadata: { processId: "proc-1", networkProtocol: "http", networkMethod: "POST" },
      },
    ])
    await Bun.sleep(50)
    expect(auth.released).toEqual([0])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ decision: "allow", source: "baseline_policy", protocol: "http", host: "127.0.0.1", port: upstream.port, method: "POST" })
  })

  test("blocks hosts outside the allowlist without authorizing them", async () => {
    const { port, auth, events } = await start({ domains: { "allowed.example": "allow" } })
    const received = await rawExchange(port, "GET http://blocked.example/ HTTP/1.1\r\nHost: blocked.example\r\nConnection: close\r\n\r\n", () => false)
    const text = responseText(received)
    expect(text).toStartWith("HTTP/1.1 403")
    expect(text.toLowerCase()).toContain("x-proxy-error: blocked-by-allowlist")
    expect(text).toContain("Domain not in allowlist.")
    expect(auth.calls).toEqual([])
    expect(events[0]).toMatchObject({ decision: "deny", source: "baseline_policy", reason: "not_allowed", host: "blocked.example", port: 80 })
  })

  test("limited mode allows only safe methods and blocks HTTPS tunnels", async () => {
    const upstream = await upstreamHttp()
    const echo = await echoServer()
    const { port } = await start({ mode: "limited", domains: { "127.0.0.1": "allow" } })
    const post = responseText(
      await rawExchange(port, `POST http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, () => false),
    )
    expect(post).toStartWith("HTTP/1.1 403")
    expect(post.toLowerCase()).toContain("x-proxy-error: blocked-by-method-policy")
    const get = responseText(
      await rawExchange(port, `GET http://127.0.0.1:${upstream.port}/ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, (bytes) =>
        responseText(bytes).includes("upstream:GET:/ok"),
      ),
    )
    expect(get).toStartWith("HTTP/1.1 200")
    const connect = responseText(await rawExchange(port, `CONNECT 127.0.0.1:${echo} HTTP/1.1\r\nHost: 127.0.0.1:${echo}\r\n\r\n`, () => false))
    expect(connect).toStartWith("HTTP/1.1 403")
    expect(connect.toLowerCase()).toContain("x-proxy-error: blocked-by-mitm-required")
    expect(upstream.requests.map((request) => request.method)).toEqual(["GET"])
  })

  test("tunnels CONNECT in full mode and releases the grant on close", async () => {
    const echo = await echoServer()
    const { port, auth } = await start({ domains: { "127.0.0.1": "allow" } })
    let sent = false
    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT 127.0.0.1:${echo} HTTP/1.1\r\nHost: 127.0.0.1:${echo}\r\n\r\n`))
      let text = ""
      socket.on("data", (data) => {
        text += data.toString()
        if (!sent && text.includes("\r\n\r\n")) {
          sent = true
          socket.write("ping")
        }
        if (text.includes("echo:ping")) {
          socket.end()
          resolve(text)
        }
      })
      socket.on("error", reject)
    })
    expect(received).toStartWith("HTTP/1.1 200")
    expect(auth.calls).toEqual([
      {
        action: "webfetch",
        resources: [`https://127.0.0.1:${echo}`],
        metadata: { processId: "proc-1", networkProtocol: "https_connect", networkMethod: "CONNECT" },
      },
    ])
    await Bun.sleep(100)
    expect(auth.released).toEqual([0])
  })

  test("YCoding authorization denial blocks an allowed destination", async () => {
    const upstream = await upstreamHttp()
    const { port, events } = await start({ domains: { "127.0.0.1": "allow" } }, { deny: true })
    const text = responseText(
      await rawExchange(port, `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, () => false),
    )
    expect(text).toStartWith("HTTP/1.1 403")
    expect(text.toLowerCase()).toContain("x-proxy-error: blocked-by-policy")
    expect(upstream.requests).toEqual([])
    expect(events[0]).toMatchObject({ decision: "deny", source: "proxy_state", reason: "policy_denied" })
  })

  test("review domains route through the controller decider", async () => {
    const upstream = await upstreamHttp()
    const asked: CcaNetworkPolicyRequest[] = []
    const { port, events } = await start(
      { domains: { "127.0.0.1": "allow" }, reviewDomains: ["127.0.0.1"] },
      {
        decider: async (request) => {
          asked.push(request)
          return asked.length === 1 ? { type: "allow" } : { type: "ask", reason: "awaiting review" }
        },
      },
    )
    const allowed = responseText(
      await rawExchange(port, `GET http://127.0.0.1:${upstream.port}/a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, (bytes) =>
        responseText(bytes).includes("upstream:GET:/a"),
      ),
    )
    expect(allowed).toStartWith("HTTP/1.1 200")
    const asking = responseText(
      await rawExchange(port, `GET http://127.0.0.1:${upstream.port}/b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, () => false),
    )
    expect(asking).toStartWith("HTTP/1.1 403")
    expect(asked).toEqual([
      { protocol: "http", host: "127.0.0.1", port: upstream.port },
      { protocol: "http", host: "127.0.0.1", port: upstream.port },
    ])
    expect(events.map((event) => [event.decision, event.source, event.policyOverride])).toEqual([
      ["allow", "decider", true],
      ["ask", "decider", false],
    ])
  })

  test("SOCKS5 CONNECT is policy checked when enabled", async () => {
    const echo = await echoServer()
    const { handle, auth } = await start({ enableSocks5: true, domains: { "127.0.0.1": "allow" } })
    const socksUrl = handle.env.ALL_PROXY
    expect(socksUrl).toStartWith("socks5h://127.0.0.1:")
    expect(handle.env.FTP_PROXY).toBe(socksUrl)
    expect(handle.env.HTTP_PROXY).toStartWith("http://127.0.0.1:")
    const socksPort = Number(new URL(socksUrl).port)
    expect(handle.managedNetwork.loopbackPorts.toSorted((a, b) => a - b)).toEqual(
      [Number(new URL(handle.env.HTTP_PROXY).port), socksPort].toSorted((a, b) => a - b),
    )
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket = net.connect(socksPort, "127.0.0.1", () => socket.write(Buffer.from([5, 1, 0])))
      let stage = 0
      let buffer = Buffer.alloc(0)
      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data])
        if (stage === 0 && buffer.length >= 2) {
          expect([...buffer.subarray(0, 2)]).toEqual([5, 0])
          buffer = buffer.subarray(2)
          stage = 1
          const host = Buffer.from("127.0.0.1")
          const portBytes = Buffer.alloc(2)
          portBytes.writeUInt16BE(echo)
          socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, portBytes]))
        }
        if (stage === 1 && buffer.length >= 10) {
          expect(buffer[1]).toBe(0)
          buffer = buffer.subarray(10)
          stage = 2
          socket.write("ping")
        }
        if (stage === 2 && buffer.toString().includes("echo:ping")) {
          socket.end()
          resolve(buffer)
        }
      })
      socket.on("error", reject)
    })
    expect(reply.toString()).toBe("echo:ping")
    expect(auth.calls[0]).toEqual({
      action: "webfetch",
      resources: [`socks5h://127.0.0.1:${echo}`],
      metadata: { processId: "proc-1", networkProtocol: "socks5_tcp", networkMethod: "CONNECT" },
    })

    const blocked = await rawExchange(
      socksPort,
      Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 3, 15]), Buffer.from("blocked.example"), Buffer.from([0, 80])]),
      (bytes) => bytes.length >= 12,
    )
    expect([...blocked.subarray(0, 2)]).toEqual([5, 0])
    expect(blocked[3]).toBe(2)
  })

  test("credential masking requests keep credentials unmasked and report unavailability", async () => {
    const { handle } = await start(
      { credentialMasking: true, credentialProviders: { vendor: { env: ["VENDOR_TOKEN"], patterns: [], url_prefixes: ["https://vendor.example"], auth: ["bearer"] } } },
      { env: { OPENAI_API_KEY: "sk-test-synthetic", VENDOR_TOKEN: "vendor-synthetic" } },
    )
    expect(handle.credentialMasking).toBe("unavailable")
    expect(handle.env.OPENAI_API_KEY).toBe("sk-test-synthetic")
    expect(handle.env.VENDOR_TOKEN).toBe("vendor-synthetic")
    expect(handle.env.CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE).toBeUndefined()
  })

  test("close stops listeners and is idempotent", async () => {
    const { handle, port } = await start({ domains: { "127.0.0.1": "allow" } })
    await handle.close()
    await handle.close()
    const error = await new Promise<unknown>((resolve) => {
      const socket = net.connect(port, "127.0.0.1")
      socket.on("connect", () => {
        socket.destroy()
        resolve(undefined)
      })
      socket.on("error", resolve)
    })
    expect(error).toBeDefined()
  })
})
