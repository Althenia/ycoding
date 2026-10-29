import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { WebSocket, WebSocketServer, type NodeWebSocket } from "ws"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { createCcaExecutorHost } from "../src/remote-control/cca-executor-host"
import { ccaExecServerPrependPathDir } from "../src/remote-control/cca-executor-transport"
import { unexpectedExecutorHost, unrecordedTranscript } from "./fixture/cca-scope"
import type { CcaNoisePublicKey, CcaNoiseTransport } from "../src/remote-control/cca-executor-transport"
import {
  decodeRelayMessageFrame,
  encodeRelayMessageFrame,
  frameMessage,
  MessageDecoder,
  type RelayMessageFrame,
} from "../src/remote-control/cca-relay"

const access = "synthetic-access-token-golden-replay"
const accountID = "synthetic-account-golden-replay"
const executorID = "ccarenv_b64_synthetic-executor-golden-replay"
const streamID = "550e8400-e29b-41d4-a716-446655440000"
const harnessKey: CcaNoisePublicKey = {
  suite: "noise_hybrid_ik_v1",
  x25519_public_key: "synthetic_x25519_golden_replay",
  mlkem768_public_key: "synthetic_mlkem768_golden_replay",
}
const traceparent = "00-00000000000000000000000000000001-0000000000000002-00"
const missingPathError = { code: -32004, message: "No such file or directory (os error 2)" }
const requestTimeoutMs = 10_000

const fakeCipher: CcaNoiseTransport = {
  async encrypt(bytes) {
    const ciphertext = new Uint8Array(bytes.length + 1)
    ciphertext[0] = 0x6d
    ciphertext.set(bytes, 1)
    return ciphertext
  },
  async decrypt(bytes) {
    if (bytes[0] !== 0x6d) throw new Error("Synthetic cipher rejected the record")
    return bytes.subarray(1)
  },
}

const keysOf = (value: object) => Object.keys(value).sort()
const paths = (...dotted: string[]) => dotted.map((entry) => entry.split("."))

const configPaths = paths(
  "allow_login_shell",
  "shell_environment_policy.inherit",
  "shell_environment_policy.ignore_default_excludes",
  "shell_environment_policy.exclude",
  "shell_environment_policy.include_only",
  "shell_environment_policy.filters",
  "shell_environment_policy.set",
  "default_permissions",
  "permissions",
  "sandbox_mode",
  "sandbox_workspace_write.writable_roots",
  "sandbox_workspace_write.network_access",
  "sandbox_workspace_write.exclude_tmpdir_env_var",
  "sandbox_workspace_write.exclude_slash_tmp",
  "features.elevated_windows_sandbox",
  "features.experimental_windows_sandbox",
  "features.enable_experimental_windows_sandbox",
  "features.prefer_mxc",
  "windows.sandbox",
  "windows.allow_mxc",
  "features.use_legacy_landlock",
  "features.network_proxy.enabled",
  "features.network_proxy.domains",
  "features.network_proxy.unix_sockets",
  "features.network_proxy.allow_upstream_proxy",
  "features.network_proxy.dangerously_allow_all_unix_sockets",
  "features.network_proxy.allow_local_binding",
)

const requirementsPaths = paths(
  "hooks",
  "allow_login_shell",
  "rules.prefix_rules",
  "allowed_permission_profiles",
  "default_permissions",
  "permissions",
  ...["network_proxy", "experimental_network"].flatMap((table) => [
    `${table}.enabled`,
    `${table}.allow_upstream_proxy`,
    `${table}.dangerously_allow_all_unix_sockets`,
    `${table}.domains`,
    `${table}.allowed_domains`,
    `${table}.review_domains`,
    `${table}.managed_allowed_domains_only`,
    `${table}.denied_domains`,
    `${table}.unix_sockets`,
    `${table}.allow_unix_sockets`,
    `${table}.allow_local_binding`,
  ]),
  "features.elevated_windows_sandbox",
  "features.experimental_windows_sandbox",
  "features.enable_experimental_windows_sandbox",
  "features.prefer_mxc",
  "feature_requirements.elevated_windows_sandbox",
  "feature_requirements.experimental_windows_sandbox",
  "feature_requirements.prefer_mxc",
  "feature_requirements.enable_experimental_windows_sandbox",
  "windows.allowed_sandbox_implementations",
  "windows.allow_mxc",
  "windows.require_mxc",
  "mcp_servers",
  "plugins",
  "allowed_sandbox_modes",
  "remote_sandbox_config",
  "features.use_legacy_landlock",
  "features.network_proxy",
  "feature_requirements.use_legacy_landlock",
  "feature_requirements.network_proxy",
)

const capabilityNames = [
  "networkProxyLaunch",
  "networkProxyReviewDomains",
  "credentialMasking",
  "credentialMaskingCustomProviders",
  "capabilityDiscoverySandbox",
  "capabilityDiscoveryV2",
  "environmentConfigRead",
  "httpHeaderEnvVars",
  "sandboxedFileStreaming",
  "fileWriteStreaming",
  "shellSnapshotV2",
  "windowsMxc",
]

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function within<T>(promise: Promise<T>, label: string, ms = requestTimeoutMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

class Channel {
  private readonly decoder = new MessageDecoder()
  private readonly responses = new Map<number, ReturnType<typeof deferred<any>>>()
  private readonly handshakeSeen = deferred()
  private readonly changed: (() => void)[] = []
  readonly notifications: any[] = []
  private chain = Promise.resolve()
  private seq = 0

  constructor(private readonly socket: NodeWebSocket) {
    socket.on("message", (data) => {
      const frame = decodeRelayMessageFrame(new Uint8Array(data as Buffer))
      this.chain = this.chain.then(() => this.receive(frame))
    })
  }

  private slot(id: number) {
    let existing = this.responses.get(id)
    if (existing === undefined) {
      existing = deferred()
      this.responses.set(id, existing)
    }
    return existing
  }

  private async receive(frame: RelayMessageFrame) {
    if (frame.stream_id !== streamID) return
    if (frame.body?.kind === "handshake") this.handshakeSeen.resolve()
    if (frame.body?.kind !== "data") return
    for (const bytes of this.decoder.push(await fakeCipher.decrypt(frame.body.data.payload))) {
      const message = JSON.parse(new TextDecoder().decode(bytes))
      if (typeof message.id === "number" && ("result" in message || "error" in message)) this.slot(message.id).resolve(message)
      else this.notifications.push(message)
    }
    for (const wake of this.changed.splice(0)) wake()
  }

  async handshake() {
    this.socket.send(encodeRelayMessageFrame({ version: 1, stream_id: streamID, body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } } }))
    await within(this.handshakeSeen.promise, "handshake")
  }

  async send(message: object) {
    const payload = await fakeCipher.encrypt(frameMessage(new TextEncoder().encode(JSON.stringify(message))))
    this.socket.send(encodeRelayMessageFrame({
      version: 1,
      stream_id: streamID,
      body: { kind: "data", data: { seq: this.seq++, segment_index: 0, segment_count: 1, payload } },
    }))
  }

  async request(id: number, method: string, params: unknown, trace: object | undefined = { traceparent }): Promise<any> {
    const response = this.slot(id)
    await this.send({ id, method, params, ...(trace === undefined ? {} : { trace }) })
    return within(response.promise, `response to ${method} #${id}`)
  }

  async until(predicate: () => boolean, label: string) {
    const settled = deferred()
    const timer = setTimeout(() => settled.reject(new Error(`Timed out waiting for ${label}`)), requestTimeoutMs)
    try {
      while (!predicate()) {
        const woke = deferred()
        this.changed.push(() => woke.resolve())
        await Promise.race([woke.promise, settled.promise])
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

const cleanups: (() => Promise<void> | void)[] = []
let home: string
let workspace: string
let channel: Channel
let savedCodexHome: string | undefined
let processId: string

const uri = (native: string) => CcaPolicy.toPathUri(native)
const codexHomeUri = () => uri(path.join(home, ".codex"))

const syntheticConfig = [
  "[mcp_servers.synthetic_server]",
  'command = "synthetic-mcp"',
  'args = ["--synthetic"]',
  "enabled = true",
  "",
].join("\n")

beforeAll(async () => {
  savedCodexHome = process.env.CODEX_HOME
  delete process.env.CODEX_HOME
  cleanups.push(() => {
    if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome
  })

  home = await mkdtemp(path.join(tmpdir(), "ycoding-cca-golden-home-"))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  workspace = await mkdtemp("/tmp/codex-task.")
  cleanups.push(() => rm(workspace, { recursive: true, force: true }))

  await mkdir(path.join(home, ".codex"), { recursive: true })
  await writeFile(path.join(home, ".codex", "config.toml"), syntheticConfig)
  const skillDirectory = path.join(home, ".agents", "skills", "synthetic-skill")
  await mkdir(path.join(skillDirectory, "agents"), { recursive: true })
  await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: synthetic-skill\ndescription: Synthetic skill for replay.\n---\n\n# Synthetic\n")
  await writeFile(path.join(skillDirectory, "agents", "openai.yaml"), 'interface:\n  display_name: "Synthetic Skill"\n')

  const statePath = path.join(home, "cca-executor.json")
  await writeFile(statePath, JSON.stringify({
    installationID: "synthetic-installation",
    accountHash: createHash("sha256").update(accountID).digest("hex"),
    status: "completed",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    executorID,
    selectedCapabilityRoots: [{ id: "codex-home-skills", path: path.join(home, ".agents", "skills") }],
  }), { mode: 0o600 })

  const registry = http.createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(request.url?.endsWith("/validate")
        ? { valid: true }
        : {
            environment_id: executorID,
            security_profile: "noise_hybrid_ik_v1",
            executor_registration_id: "synthetic-registration-1",
            url: "wss://rendezvous.chatgpt.com/cloud-agent/ws?sig=synthetic",
          }))
    })
  })
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", () => resolve()))
  cleanups.push(() => new Promise<void>((resolve) => registry.close(() => resolve())))

  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>((resolve) => server.on("listening", () => resolve()))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const connected = deferred<NodeWebSocket>()
  server.on("connection", (socket) => connected.resolve(socket))

  const configuration: NativeDots.Configuration = {
    enabled: true, accessRevision: 1, profile: "dots", credentialID: "credential-1", accountID, accountGeneration: 1,
  }
  const scope: NativeDots.ThreadScope = {
    sessionID: "synthetic-session-1",
    directory: home,
    roots: [home],
    transcript: unrecordedTranscript,
    authorization: {
      authorize: async () => ({ release: async () => {} }),
      close: async () => {},
    },
    close: async () => {},
  }
  const host = createCcaExecutorHost({
    native: {
      configuration: async () => configuration,
      credential: async (profile) => ({ access, accountID, key: "credential-key-1", profile, credentialID: "credential-1", accountGeneration: 1 }),
      subscribeConfiguration: () => () => {},
      threadScope: async () => scope,
      unattributedScope: async () => scope,
      projectCatalog: unexpectedExecutorHost.projectCatalog,
      assignProject: unexpectedExecutorHost.assignProject,
      prepareWorkspace: unexpectedExecutorHost.prepareWorkspace,
    },
    statePath,
    installationID: async () => "synthetic-installation",
    homeDirectory: home,
    registryBaseURL: `http://127.0.0.1:${(registry.address() as AddressInfo).port}`,
    fetch: (url, init) => {
      if (!url.startsWith("http://127.0.0.1:")) throw new Error("Unexpected non-loopback request")
      return fetch(url, init)
    },
    connectWebSocket: (_url, headers) => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, { headers }),
    acceptHandshake: async (input) => {
      await input.authorize(harnessKey, "synthetic-harness-authorization")
      return { response: new Uint8Array([0x42]), transport: fakeCipher }
    },
    wait: async () => {},
    detachedSessionTtlMs: 20,
  })
  cleanups.push(() => host.stop())
  await host.start()

  channel = new Channel(await within(connected.promise, "relay connection"))
  await channel.handshake()
}, 30_000)

afterAll(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!()
    } catch {}
  }
})

describe("golden replay of the official harness request sequence", () => {
  test("1. initialize and initialized", async () => {
    const response = await channel.request(1, "initialize", { clientName: "codex-environment", resumeSessionId: null }, {
      traceparent,
      tracestate: "synthetic=1",
    })
    if (response.result !== undefined) await channel.send({ method: "initialized", params: {} })
    expect(keysOf(response)).toEqual(["id", "result"])
    expect(response.id).toBe(1)
    expect(keysOf(response.result)).toEqual(["environmentInfo", "sessionId"])
    expect(typeof response.result.sessionId).toBe("string")

    const info = response.result.environmentInfo
    const infoKeys = ["capabilities", "cwd", "executorVersion", "platformOs", "providerId", "shell", "tempDir", "temporaryDirectories", "userHomeDir"]
    if (existsSync(ccaExecServerPrependPathDir)) infoKeys.push("prependPathDirs")
    expect(keysOf(info)).toEqual(infoKeys.sort())
    expect(keysOf(info.shell)).toEqual(["name", "path"])
    expect(info.cwd).toBe(uri(home))
    expect(info.userHomeDir).toBe(uri(home))
    expect(Array.isArray(info.temporaryDirectories)).toBe(true)
    expect(typeof info.tempDir).toBe("string")
    expect(keysOf(info.capabilities)).toEqual([...capabilityNames].sort())
    expect(Object.values(info.capabilities).every((enabled) => typeof enabled === "boolean")).toBe(true)
    expect(info.capabilities.environmentConfigRead).toBe(true)
  }, 20_000)

  test("2. environmentConfig/read with the full config and requirements path lists", async () => {
    const response = await channel.request(2, "environmentConfig/read", { cwd: uri(workspace), configPaths, requirementsPaths }, { traceparent, tracestate: "synthetic=1" })
    expect(response.error).toBeUndefined()
    expect(keysOf(response)).toEqual(["id", "result"])
    expect(keysOf(response.result)).toEqual(["codexHomeDir", "config", "hostname", "requirements", "userHomeDir"])
    expect(response.result.userHomeDir).toBe(uri(home))
    expect(response.result.codexHomeDir).toBe(codexHomeUri())
    expect(typeof response.result.hostname).toBe("string")
    expect(response.result.config).toEqual({ layers: [], cloudInsertionIndex: 0 })
    expect(response.result.requirements).toEqual({ layers: [], cloudInsertionIndex: 0 })
  }, 20_000)

  test("3. fs/getMetadata on missing paths reports -32004 with the official message", async () => {
    const probes = [
      [3, path.join(workspace, ".git")],
      [4, path.join(path.dirname(workspace), ".git")],
      [5, "/.git"],
    ] as const
    const upward = await Promise.all(probes.map(([id, target]) => channel.request(id, "fs/getMetadata", { path: uri(target), sandbox: null })))
    const local = [
      await channel.request(6, "fs/getMetadata", { path: uri(path.join(workspace, ".agents", "skills")), sandbox: null }),
      await channel.request(7, "fs/getMetadata", { path: uri(path.join(workspace, "AGENTS.override.md")), sandbox: null }),
      await channel.request(8, "fs/getMetadata", { path: uri(path.join(workspace, "AGENTS.md")), sandbox: null }),
    ]
    const ids = [3, 4, 5, 6, 7, 8]
    ;[...upward, ...local].forEach((response, index) => {
      expect(response).toEqual({ id: ids[index], error: missingPathError })
    })
  }, 20_000)

  test("4. environmentConfig/read for mcp_servers returns the user layer", async () => {
    const response = await channel.request(9, "environmentConfig/read", { cwd: uri(workspace), configPaths: [["mcp_servers"]], requirementsPaths: [["mcp_servers"]] })
    expect(response.error).toBeUndefined()
    expect(keysOf(response.result)).toEqual(["codexHomeDir", "config", "hostname", "requirements", "userHomeDir"])
    expect(response.result.requirements).toEqual({ layers: [], cloudInsertionIndex: 0 })
    expect(response.result.config).toEqual({
      layers: [{
        source: `user (${path.join(home, ".codex", "config.toml")})`,
        baseDir: codexHomeUri(),
        toml: syntheticConfig,
      }],
      cloudInsertionIndex: 0,
    })
  }, 20_000)

  test("5. capabilityRoots/discoverV1 discovers the synthetic skill", async () => {
    const root = path.join(home, ".agents", "skills")
    const skill = path.join(root, "synthetic-skill")
    const response = await channel.request(10, "capabilityRoots/discoverV1", { roots: [{ id: "codex-home-skills", path: uri(root), sandbox: null }] })
    expect(response.error).toBeUndefined()
    expect(keysOf(response)).toEqual(["id", "result"])
    expect(response.result).toEqual({
      roots: [{
        id: "codex-home-skills",
        path: uri(root),
        plugin: null,
        skills: [{
          instructions: {
            path: uri(path.join(skill, "SKILL.md")),
            contents: "---\nname: synthetic-skill\ndescription: Synthetic skill for replay.\n---\n\n# Synthetic\n",
          },
          metadata: {
            path: uri(path.join(skill, "agents", "openai.yaml")),
            contents: 'interface:\n  display_name: "Synthetic Skill"\n',
          },
        }],
        namespaceManifests: [],
        warnings: [],
        error: null,
      }],
    })
  }, 20_000)

  test("6. process/start in the task workspace returns a processId", async () => {
    processId = `${process.pid}-00000000-0000-4000-8000-000000000001`
    const project = { type: "special", value: { kind: "project_roots" } }
    const projectSubpath = (subpath: string) => ({
      path: { type: "special", value: { kind: "project_roots", subpath } },
      access: "read",
      missing_path_behavior: "skip",
    })
    const response = await channel.request(11, "process/start", {
      processId,
      metadata: { threadId: "00000000-0000-4000-8000-000000000002", toolCallId: "exec-synthetic-tool-call" },
      argv: ["/bin/zsh", "-c", "printf 'cca-proof-ok\\n'"],
      cwd: uri(workspace),
      envPolicy: {
        inherit: "all",
        ignoreDefaultExcludes: true,
        exclude: ["CODEX_PERMISSION_PROFILE", "CODEX_VERSION", "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS", "CODEX_PLUGIN_METRICS_OUTPUT"],
        set: {},
        includeOnly: [],
      },
      env: {
        LC_CTYPE: "C.UTF-8",
        CODEX_SANDBOX_NETWORK_DISABLED: "[redacted]",
        CODEX_PERMISSION_PROFILE: "[redacted]",
        GIT_PAGER: "cat",
        NO_COLOR: "1",
        CODEX_TOOL_CALL_ID: "[redacted]",
        CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: "[redacted]",
        CODEX_THREAD_ID: "[redacted]",
        LC_ALL: "C.UTF-8",
        CODEX_CI: "[redacted]",
        GH_PAGER: "cat",
        CODEX_VERSION: "[redacted]",
        COLORTERM: "",
        PAGER: "cat",
        LANG: "C.UTF-8",
        TERM: "dumb",
        CODEX_SESSION_ID: "[redacted]",
      },
      tty: false,
      pipeStdin: false,
      arg0: null,
      sandbox: {
        permissions: {
          type: "managed",
          file_system: {
            type: "restricted",
            entries: [
              { path: { type: "special", value: { kind: "root" } }, access: "read" },
              { path: project, access: "write" },
              { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
              { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
              projectSubpath(".git"),
              projectSubpath(".agents"),
              projectSubpath(".codex"),
              projectSubpath(".aws"),
            ],
          },
          network: "restricted",
        },
        cwd: uri(workspace),
        workspaceRoots: [uri(workspace)],
        windowsSandboxLevel: "disabled",
        windowsSandboxProxySettingsMode: "reconcile",
        useLegacyLandlock: false,
      },
      enforceManagedNetwork: false,
      managedNetwork: null,
    })
    expect(response.error).toBeUndefined()
    expect(keysOf(response)).toEqual(["id", "result"])
    expect(keysOf(response.result)).toEqual(["processId", "sandboxType"])
    expect(response.result.processId).toBe(processId)
  }, 20_000)

  test("7. process output, exit and close notifications arrive in order, then terminate reports not running", async () => {
    const own = () => channel.notifications.filter((message) => message.params?.processId === processId)
    await channel.until(() => own().some((message) => message.method === "process/closed"), "process/closed")
    const notifications = own()

    expect(notifications.map((message) => message.method)).toEqual(["process/output", "process/exited", "process/closed"])
    notifications.forEach((message) => expect(keysOf(message)).toEqual(["method", "params"]))
    expect(notifications.map((message) => message.params.seq)).toEqual([1, 2, 3])

    const [output, exited, closed] = notifications
    expect(keysOf(output.params)).toEqual(["chunk", "processId", "seq", "stream"])
    expect(output.params.stream).toBe("stdout")
    expect(Buffer.from(output.params.chunk, "base64").toString("utf8")).toBe("cca-proof-ok\n")
    expect(keysOf(exited.params)).toEqual(["exitCode", "processId", "sandboxDenied", "seq"])
    expect(exited.params.exitCode).toBe(0)
    expect(exited.params.sandboxDenied).toBe(false)
    expect(keysOf(closed.params)).toEqual(["processId", "seq"])

    const terminated = await channel.request(12, "process/terminate", { processId })
    expect(terminated).toEqual({ id: 12, result: { running: false } })
  }, 20_000)
})
