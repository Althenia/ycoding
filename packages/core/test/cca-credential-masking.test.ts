import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import tls from "node:tls"
import forge from "node-forge"
import { CCA_BROKERED_CREDENTIALS_ENV_KEY, CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY, createCcaCredentialBrokerCache } from "../src/cca/credential-broker"
import { CCA_CUSTOM_CA_ENV_KEYS } from "../src/cca/mitm-ca"
import {
  CCA_CREDENTIAL_MASKING_UNAVAILABLE_WARNING,
  ccaCredentialMasking,
  ccaNetworkProxyCapabilities,
  startCcaNetworkProxy,
  type CcaNetworkProxyCommand,
  type CcaRemoteNetworkProxyConfig,
} from "../src/cca/network-proxy"
import { ccaShellSnapshotStdio, createCcaShellSnapshotCache } from "../src/cca/shell-snapshot"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const VENDOR_REAL = "vendor_abcdefgh"
const VENDOR_PATTERN = "vendor_[a-z]{8}"
const OPENAI_REAL = `sk-proj-${"A1b2C3d4".repeat(8)}`
const GITHUB_REAL = `ghp_${"Z9y8X7w6".repeat(5)}`

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cca-masking-")))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface TestPki {
  readonly caPem: string
  readonly issue: (host: string) => { readonly key: string; readonly cert: string }
}

function testPki(commonName: string): TestPki {
  const caKeys = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const caPrivate = forge.pki.privateKeyFromPem(caKeys.privateKey.export({ type: "pkcs1", format: "pem" }).toString())
  const ca = forge.pki.createCertificate()
  ca.publicKey = forge.pki.publicKeyFromPem(caKeys.publicKey.export({ type: "spki", format: "pem" }).toString())
  ca.serialNumber = "01"
  ca.validity.notBefore = new Date(Date.now() - 3_600_000)
  ca.validity.notAfter = new Date(Date.now() + 86_400_000)
  ca.setSubject([{ name: "commonName", value: commonName }])
  ca.setIssuer([{ name: "commonName", value: commonName }])
  ca.setExtensions([{ name: "basicConstraints", cA: true, critical: true }, { name: "keyUsage", keyCertSign: true, critical: true }])
  ca.sign(caPrivate, forge.md.sha256.create())
  return {
    caPem: forge.pki.certificateToPem(ca),
    issue: (host) => {
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
      const leaf = forge.pki.createCertificate()
      leaf.publicKey = forge.pki.publicKeyFromPem(keys.publicKey.export({ type: "spki", format: "pem" }).toString())
      leaf.serialNumber = "02"
      leaf.validity.notBefore = new Date(Date.now() - 3_600_000)
      leaf.validity.notAfter = new Date(Date.now() + 86_400_000)
      leaf.setSubject([{ name: "commonName", value: host }])
      leaf.setIssuer(ca.subject.attributes)
      leaf.setExtensions([{ name: "extKeyUsage", serverAuth: true }, { name: "subjectAltName", altNames: [{ type: 7, ip: host }] }])
      leaf.sign(caPrivate, forge.md.sha256.create())
      return { key: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert: forge.pki.certificateToPem(leaf) }
    },
  }
}

interface Recorded {
  readonly method: string
  readonly url: string
  readonly authorization?: string
  readonly vendorHeader?: string
}

async function tlsUpstream(pki: TestPki): Promise<{ readonly port: number; readonly requests: Recorded[] }> {
  const requests: Recorded[] = []
  const server = https.createServer(pki.issue("127.0.0.1"), (req, res) => {
    req.resume()
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        vendorHeader: typeof req.headers["x-vendor-key"] === "string" ? req.headers["x-vendor-key"] : undefined,
      })
      res.end("ok")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address !== "object") throw new Error("no address")
  return { port: address.port, requests }
}

function httpsThroughProxy(
  proxyPort: number,
  port: number,
  ca: string,
  request: string,
): Promise<{ readonly response: string; readonly issuer: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`))
    let head = ""
    const timer = setTimeout(() => reject(new Error(`timed out: ${head}`)), 10_000)
    const onHead = (data: Buffer) => {
      head += data.toString("latin1")
      if (!head.includes("\r\n\r\n")) return
      socket.off("data", onHead)
      if (!head.startsWith("HTTP/1.1 200")) {
        clearTimeout(timer)
        socket.destroy()
        resolve({ response: head, issuer: "" })
        return
      }
      const secure = tls.connect({ socket, ca }, () => {
        const issuer = String(secure.getPeerCertificate().issuer?.CN ?? "")
        let response = ""
        secure.on("data", (chunk: Buffer) => (response += chunk.toString()))
        secure.on("close", () => {
          clearTimeout(timer)
          resolve({ response, issuer })
        })
        secure.write(request)
      })
      secure.on("error", (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
    }
    socket.on("data", onHead)
    socket.on("error", reject)
  })
}

function proxyConfig(overrides: Partial<CcaRemoteNetworkProxyConfig>): CcaRemoteNetworkProxyConfig {
  return {
    enabled: true,
    credentialMasking: true,
    credentialProviders: {},
    enableSocks5: false,
    enableSocks5Udp: false,
    allowUpstreamProxy: false,
    dangerouslyAllowAllUnixSockets: false,
    mode: "full",
    domains: { "127.0.0.1": "allow" },
    reviewDomains: [],
    allowLocalBinding: false,
    ...overrides,
  }
}

const vendorProvider = (port: number) => ({
  vendor: { env: ["VENDOR_TOKEN"], patterns: [VENDOR_PATTERN], url_prefixes: [`https://127.0.0.1:${port}`], auth: ["bearer" as const] },
})

const bashCommand: CcaNetworkProxyCommand = { argv: ["/bin/bash", "-c", "true"] }

async function start(input: {
  readonly proxy: Partial<CcaRemoteNetworkProxyConfig>
  readonly env: Record<string, string>
  readonly caPath?: string
  readonly command?: CcaNetworkProxyCommand
  readonly caDirectory?: string
}) {
  const caDirectory = input.caDirectory ?? path.join(await scratch(), "proxy")
  const handle = await startCcaNetworkProxy({
    processId: "proc-1",
    launch: { proxy: proxyConfig(input.proxy), auditMetadata: { conversationId: "conversation-1" } },
    env: input.env,
    authorize: async () => ({ release: async () => {} }),
    credentialBrokers: createCcaCredentialBrokerCache(),
    caDirectory,
    startupEnv: input.caPath ? { SSL_CERT_FILE: input.caPath } : {},
    command: input.command ?? bashCommand,
    platform: "linux",
  })
  cleanups.push(() => handle.close())
  return { handle, caDirectory, port: Number(new URL(handle.env.HTTP_PROXY).port) }
}

async function upstreamCaFile(pki: TestPki): Promise<string> {
  const file = path.join(await scratch(), "upstream-ca.pem")
  await writeFile(file, pki.caPem)
  return file
}

function runChild(command: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", (data) => (output += data))
    child.on("error", reject)
    child.on("close", () => resolve(output))
  })
}

describe("credential masking capabilities", () => {
  test("advertise masking exactly for Linux and macOS bash or zsh executors", () => {
    const cases: Array<[NodeJS.Platform, string, boolean]> = [
      ["darwin", "zsh", true],
      ["darwin", "/bin/zsh", true],
      ["linux", "bash", true],
      ["linux", "/usr/bin/bash", true],
      ["linux", "sh", false],
      ["darwin", "fish", false],
      ["win32", "bash", false],
      ["win32", "powershell", false],
    ]
    for (const [platform, shell, expected] of cases) {
      const capabilities = ccaNetworkProxyCapabilities({ platform, shell })
      expect([platform, shell, capabilities.credentialMasking, capabilities.credentialMaskingCustomProviders]).toEqual([platform, shell, expected, expected])
      expect(capabilities.networkProxyLaunch && capabilities.networkProxyReviewDomains).toBe(true)
    }
    expect(ccaCredentialMasking(ccaNetworkProxyCapabilities({ platform: "darwin", shell: "zsh" }))).toBe("withConfiguredProviders")
    expect(ccaCredentialMasking(ccaNetworkProxyCapabilities({ platform: "linux", shell: "sh" }))).toBe("disabled")
  })
})

describe("credential masking modes", () => {
  const credentials = { OPENAI_API_KEY: OPENAI_REAL, GH_TOKEN: GITHUB_REAL, VENDOR_TOKEN: VENDOR_REAL }

  test("disabled launches leave credentials and trust settings untouched", async () => {
    const { handle, caDirectory } = await start({ proxy: { credentialMasking: false, credentialProviders: vendorProvider(443) }, env: credentials })
    expect(handle.credentialMasking).toBe("disabled")
    expect(handle.env.OPENAI_API_KEY).toBe(OPENAI_REAL)
    expect(handle.env.VENDOR_TOKEN).toBe(credentials.VENDOR_TOKEN)
    expect(handle.env[CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY]).toBeUndefined()
    expect(handle.env.SSL_CERT_FILE).toBeUndefined()
    expect(existsSync(caDirectory)).toBe(false)
  })

  test("built-in-only launches mask built-in providers and leave unconfigured credentials", async () => {
    const { handle } = await start({ proxy: { credentialProviders: {} }, env: credentials })
    expect(handle.credentialMasking).toBe("enabled")
    expect(handle.env.OPENAI_API_KEY).toStartWith("sk-proj-masked")
    expect(handle.env.OPENAI_API_KEY.length).toBe(OPENAI_REAL.length)
    expect(handle.env.GH_TOKEN).toStartWith("ghp_masked")
    expect(handle.env.VENDOR_TOKEN).toBe(credentials.VENDOR_TOKEN)
    expect(JSON.parse(handle.env[CCA_BROKERED_CREDENTIALS_ENV_KEY])).toEqual([
      ["GH_TOKEN", handle.env.GH_TOKEN],
      ["OPENAI_API_KEY", handle.env.OPENAI_API_KEY],
    ])
    expect(handle.env[CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY]).toBe("1")
  })

  test("configured-provider launches also mask configured credentials", async () => {
    const { handle } = await start({ proxy: { credentialProviders: vendorProvider(443) }, env: credentials })
    expect(handle.env.VENDOR_TOKEN).toMatch(/^vendor_[a-z]{8}$/)
    expect(handle.env.VENDOR_TOKEN).not.toBe(credentials.VENDOR_TOKEN)
    expect(handle.env.OPENAI_API_KEY).toStartWith("sk-proj-masked")
    const serialized = JSON.stringify(handle)
    for (const real of Object.values(credentials)) expect(serialized).not.toContain(real)
  })

  test("invalid configured providers are ignored instead of failing the launch", async () => {
    const { handle } = await start({
      proxy: { credentialProviders: { broken: { env: ["VENDOR_TOKEN"], patterns: ["(?=x)"], url_prefixes: ["https://vendor.example"], auth: [] } } },
      env: credentials,
    })
    expect(handle.env.VENDOR_TOKEN).toBe(credentials.VENDOR_TOKEN)
    expect(handle.env.OPENAI_API_KEY).toStartWith("sk-proj-masked")
  })

  test("unsupported shell startups run with unmasked credentials and a warning", async () => {
    for (const command of [
      { argv: ["/bin/bash", "-lc", "true"] },
      { argv: ["/bin/zsh", "-lc", "true"] },
      { argv: ["/bin/bash", "-c", "true"], arg0: "custom" },
      { argv: ["/usr/bin/env", "true"] },
    ]) {
      const { handle } = await start({ proxy: {}, env: credentials, command })
      expect(handle.credentialMasking).toBe("unavailable")
      expect(handle.env.OPENAI_API_KEY).toBe(OPENAI_REAL)
      expect(handle.env[CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY]).toBeUndefined()
      expect(handle.warnings).toEqual([CCA_CREDENTIAL_MASKING_UNAVAILABLE_WARNING])
    }
    const bashEnv = await start({ proxy: {}, env: { ...credentials, BASH_ENV: "/tmp/rc" } })
    expect(bashEnv.handle.credentialMasking).toBe("unavailable")
  })

  test("copies of masked credentials are masked and unrecognized raw credentials are reported", async () => {
    const { handle } = await start({
      proxy: {},
      env: { OPENAI_API_KEY: OPENAI_REAL, COPIED: `prefix ${OPENAI_REAL}`, STRAY: `sk-${"q".repeat(60)}` },
    })
    expect(handle.env.COPIED).toBe(`prefix ${handle.env.OPENAI_API_KEY}`)
    expect(handle.env.STRAY).toBe(`sk-${"q".repeat(60)}`)
    expect(handle.warnings).toEqual(["Credential masking could not protect some environment credentials; continuing with those values unmasked."])
  })
})

describe("credential masking egress", () => {
  test("the child sees placeholders while the masked upstream receives real values", async () => {
    const pki = testPki("synthetic upstream CA")
    const upstream = await tlsUpstream(pki)
    const caPath = await upstreamCaFile(pki)
    const { handle, port, caDirectory } = await start({
      proxy: { credentialProviders: vendorProvider(upstream.port) },
      env: { PATH: "/usr/bin:/bin", VENDOR_TOKEN: "vendor_abcdefgh", OPENAI_API_KEY: OPENAI_REAL, OPENAI_BASE_URL: `https://127.0.0.1:${upstream.port}/v1` },
      caPath,
    })
    const childView = await runChild('printf "%s|%s" "$VENDOR_TOKEN" "$OPENAI_API_KEY"', handle.env)
    const [vendorDummy, openaiDummy] = childView.split("|")
    expect(vendorDummy).toMatch(/^vendor_[a-z]{8}$/)
    expect(vendorDummy).not.toBe("vendor_abcdefgh")
    expect(openaiDummy).toStartWith("sk-proj-masked")

    const files = (await readdir(caDirectory)).toSorted()
    expect(files).toHaveLength(2)
    const certificates = files.filter((file) => /^ca-[0-9a-f]{64}\.pem$/.test(file))
    const bundles = files.filter((file) => /^ca-bundle-[0-9a-f]{64}\.pem$/.test(file))
    expect([certificates.length, bundles.length]).toEqual([1, 1])
    const bundlePath = path.join(caDirectory, bundles[0])
    for (const key of CCA_CUSTOM_CA_ENV_KEYS) expect([key, handle.env[key]]).toEqual([key, bundlePath])
    expect((await stat(caDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(bundlePath)).mode & 0o777).toBe(0o644)
    const bundle = await readFile(bundlePath, "utf8")
    expect(bundle.includes(pki.caPem.replace(/\r\n/g, "\n").trim())).toBe(true)
    for (const file of files) expect((await readFile(path.join(caDirectory, file), "utf8")).includes("PRIVATE KEY")).toBe(false)

    const vendor = await httpsThroughProxy(
      port,
      upstream.port,
      bundle,
      `GET /vendor HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nAuthorization: Bearer ${vendorDummy}\r\nConnection: close\r\n\r\n`,
    )
    expect(vendor.issuer).toBe("network_proxy MITM CA")
    expect(vendor.response).toStartWith("HTTP/1.1 200")
    const openai = await httpsThroughProxy(
      port,
      upstream.port,
      bundle,
      `POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nAuthorization: Bearer ${openaiDummy}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    )
    expect(openai.response).toStartWith("HTTP/1.1 200")
    expect(upstream.requests).toEqual([
      { method: "GET", url: "/vendor", authorization: "Bearer vendor_abcdefgh", vendorHeader: undefined },
      { method: "POST", url: "/v1/responses", authorization: `Bearer ${OPENAI_REAL}`, vendorHeader: undefined },
    ])
  })

  test("hosts without masked credentials pass through untouched", async () => {
    const pki = testPki("synthetic passthrough CA")
    const masked = await tlsUpstream(pki)
    const plain = await tlsUpstream(pki)
    const caPath = await upstreamCaFile(pki)
    const { handle, port } = await start({
      proxy: { credentialProviders: vendorProvider(masked.port) },
      env: { VENDOR_TOKEN: "vendor_abcdefgh" },
      caPath,
    })
    const dummy = handle.env.VENDOR_TOKEN
    const result = await httpsThroughProxy(
      port,
      plain.port,
      pki.caPem,
      `GET /plain HTTP/1.1\r\nHost: 127.0.0.1:${plain.port}\r\nAuthorization: Bearer ${dummy}\r\nConnection: close\r\n\r\n`,
    )
    expect(result.issuer).toBe("synthetic passthrough CA")
    expect(result.response).toStartWith("HTTP/1.1 200")
    expect(plain.requests).toEqual([{ method: "GET", url: "/plain", authorization: `Bearer ${dummy}`, vendorHeader: undefined }])
  })

  test("header providers substitute only the configured header on plain HTTP loopback destinations", async () => {
    const received: Array<Record<string, string | string[] | undefined>> = []
    const http = await import("node:http")
    const server = http.createServer((req, res) => {
      received.push(req.headers)
      res.end("ok")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address !== "object") throw new Error("no address")
    const { handle, port } = await start({
      proxy: {
        credentialProviders: {
          vendor: {
            env: ["VENDOR_TOKEN"],
            patterns: [VENDOR_PATTERN],
            url_prefixes: [`http://127.0.0.1:${address.port}/api`],
            auth: ["header"],
            header: "X-Vendor-Key",
            prefix: "Key ",
          },
        },
      },
      env: { VENDOR_TOKEN: "vendor_abcdefgh" },
    })
    const dummy = handle.env.VENDOR_TOKEN
    const send = (target: string) =>
      new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () =>
          socket.write(`GET http://127.0.0.1:${address.port}${target} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nX-Vendor-Key: Key ${dummy}\r\nAuthorization: Bearer ${dummy}\r\nConnection: close\r\n\r\n`),
        )
        socket.on("data", () => {})
        socket.on("close", () => resolve())
        socket.on("error", reject)
      })
    await send("/api/items")
    await send("/other")
    expect(received.map((headers) => [headers["x-vendor-key"], headers.authorization])).toEqual([
      ["Key vendor_abcdefgh", `Bearer ${dummy}`],
      [`Key ${dummy}`, `Bearer ${dummy}`],
    ])
  })

  test("limited mode intercepts HTTPS to enforce the method policy", async () => {
    const pki = testPki("synthetic limited CA")
    const upstream = await tlsUpstream(pki)
    const caPath = await upstreamCaFile(pki)
    const { port, caDirectory } = await start({ proxy: { mode: "limited" }, env: {}, caPath })
    const bundleName = (await readdir(caDirectory)).find((file) => file.startsWith("ca-bundle-"))!
    const bundle = await readFile(path.join(caDirectory, bundleName), "utf8")
    const get = await httpsThroughProxy(port, upstream.port, bundle, `GET /read HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nConnection: close\r\n\r\n`)
    expect(get.issuer).toBe("network_proxy MITM CA")
    expect(get.response).toStartWith("HTTP/1.1 200")
    const post = await httpsThroughProxy(
      port,
      upstream.port,
      bundle,
      `POST /write HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    )
    expect(post.response).toStartWith("HTTP/1.1 403")
    expect(post.response.toLowerCase()).toContain("x-proxy-error: blocked-by-method-policy")
    const mismatch = await httpsThroughProxy(port, upstream.port, bundle, `GET / HTTP/1.1\r\nHost: other.example\r\nConnection: close\r\n\r\n`)
    expect(mismatch.response).toStartWith("HTTP/1.1 400")
    expect(upstream.requests.map((request) => request.url)).toEqual(["/read"])
  })

  test.skipIf(!existsSync("/bin/zsh"))("zsh login snapshots replay placeholders captured from trusted profiles", async () => {
    const home = await scratch()
    await writeFile(path.join(home, ".zshrc"), `export PROFILE_TOKEN_COPY="$OPENAI_API_KEY"\nshow_key() { printf '%s' '${OPENAI_REAL}'; }\n`)
    const command: CcaNetworkProxyCommand = {
      argv: ["/bin/zsh", "-lc", 'printf "%s|%s|" "$OPENAI_API_KEY" "$PROFILE_TOKEN_COPY"; show_key'],
      shellSnapshot: { shell: { name: "zsh", path: "/bin/zsh" } },
    }
    const { handle } = await start({
      proxy: {},
      env: { HOME: home, PATH: "/usr/bin:/bin", OPENAI_API_KEY: OPENAI_REAL },
      command,
    })
    expect(handle.credentialMasking).toBe("snapshot")
    expect(handle.env.OPENAI_API_KEY).toBe(OPENAI_REAL)
    const cache = createCcaShellSnapshotCache({ authorize: async () => ({ release: async () => {} }) })
    cleanups.push(() => cache.close())
    const launch = await cache.prepare({
      sessionId: "session-1",
      processId: "proc-1",
      request: { scopeId: "attachment-1", shell: { name: "zsh", path: "/bin/zsh" } },
      argv: command.argv,
      cwd: home,
      env: handle.env,
      requestEnv: {},
      credentialBroker: handle.credentialBroker,
    })
    expect(launch).toBeDefined()
    expect(JSON.stringify(launch!.env)).not.toContain(OPENAI_REAL)
    expect(launch!.argv.join(" ")).not.toContain(OPENAI_REAL)
    const child = spawn(launch!.argv[0], launch!.argv.slice(1), { cwd: home, env: launch!.env, stdio: ccaShellSnapshotStdio(["ignore", "pipe", "pipe"], launch!) })
    launch!.release()
    let output = ""
    child.stdout!.on("data", (data) => (output += data))
    await new Promise((resolve) => child.on("close", resolve))
    const [key, copy, shown] = output.split("|")
    expect(key).toStartWith("sk-proj-masked")
    expect(copy).toBe(key)
    expect(shown).toBe(key)
    expect(output).not.toContain(OPENAI_REAL)
  })
})
