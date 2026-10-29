import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createCcaRpcSession } from "../src/remote-control/cca-executor-rpc"
import { createCcaRpcAdapter, type CcaRpcAdapterOptions } from "../src/remote-control/cca-executor-adapter"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import { fixedScopeFor } from "./fixture/cca-scope"

function rootedAdapter({ roots, authorize, ...options }: Omit<CcaRpcAdapterOptions, "scopeFor"> & {
  readonly roots: readonly string[]
  readonly authorize: Parameters<typeof fixedScopeFor>[1]
}) {
  return createCcaRpcAdapter({ ...options, scopeFor: fixedScopeFor(roots, authorize) })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch {
      // ignore
    }
  }
})

async function makeTestRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cca-adapter-test-")))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function encodeFrame(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg))
}

function decodeFrames(frames: readonly Uint8Array[]): any[] {
  return frames.map((f) => JSON.parse(new TextDecoder().decode(f)))
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err.code === "EPERM"
  }
}

describe("CCA Executor Adapter End-to-End Integration", () => {
  test("nullable start options execute echo and nullable filesystem options match omission", async () => {
    const root = await makeTestRoot()
    const grants: Array<{ releases: number }> = []
    const adapter = rootedAdapter({
      roots: [root],
      authorize: async () => {
        const grant = { releases: 0 }
        grants.push(grant)
        return { release: async () => { grant.releases++ } }
      },
    })
    cleanups.push(() => adapter.close())
    const session = createCcaRpcSession({ environmentInfo: adapter.environmentInfo, handler: adapter.handler })
    cleanups.push(() => session.close())
    let requestID = 0
    const request = async (method: string, params?: unknown) => {
      const id = ++requestID
      const responses = decodeFrames(await session.receive(encodeFrame({ id, method, params })))
      expect(responses).toHaveLength(1)
      expect(responses[0].id).toBe(id)
      expect(responses[0].error).toBeUndefined()
      return responses[0].result
    }
    await request("initialize", { clientName: "nullable-adapter", resumeSessionId: null })
    await session.receive(encodeFrame({ method: "initialized" }))
    const started = await request("process/start", {
      processId: "nullable-echo",
      argv: ["/bin/echo", "nullable-adapter-echo"],
      cwd: CcaPolicy.toPathUri(root),
      env: {},
      tty: false,
      pipeStdin: false,
      enforceManagedNetwork: false,
      arg0: null,
      metadata: null,
      envPolicy: { inherit: "all", ignoreDefaultExcludes: false, exclude: [], includeOnly: [], set: {} },
      shellSnapshot: null,
      sandbox: null,
      managedNetwork: null,
      networkProxy: null,
    })
    expect(started).toEqual({ processId: "nullable-echo", sandboxType: "none" })
    let output = ""
    let exited = false
    let exitCode: number | null | undefined
    let afterSeq: number | null = null
    for (let attempt = 0; attempt < 10 && !exited; attempt++) {
      const result = await request("process/read", { processId: "nullable-echo", afterSeq, waitMs: 500, maxBytes: null })
      output += result.chunks
        .filter((chunk: { stream: string }) => chunk.stream === "stdout")
        .map((chunk: { chunk: string }) => Buffer.from(chunk.chunk, "base64").toString("utf8"))
        .join("")
      afterSeq = result.nextSeq - 1
      exited = result.exited
      exitCode = result.exitCode
    }
    expect(exited).toBe(true)
    expect(exitCode).toBe(0)
    expect(output).toBe("nullable-adapter-echo\n")

    const target = CcaPolicy.toPathUri(path.join(root, "nullable", "content.txt"))
    const content = Buffer.from("nullable-filesystem-content").toString("base64")
    expect(await request("fs/writeFile", { path: target, dataBase64: content, followSymlinks: null, sandbox: null })).toEqual({})
    const omittedRead = await request("fs/readFile", { path: target })
    const nullableRead = await request("fs/readFile", { path: target, followSymlinks: null, sandbox: null })
    expect(nullableRead).toEqual(omittedRead)
    expect(nullableRead.dataBase64).toBe(content)
    const omittedMetadata = await request("fs/getMetadata", { path: target })
    const nullableMetadata = await request("fs/getMetadata", { path: target, followSymlinks: null, sandbox: null })
    expect(nullableMetadata).toEqual(omittedMetadata)
    expect(nullableMetadata.isFile).toBe(true)
    expect(nullableMetadata.size).toBe(Buffer.byteLength("nullable-filesystem-content"))
    await adapter.close()
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.every((grant) => grant.releases === 1)).toBe(true)
  })

  test("missing filesystem targets answer the upstream not-found code and a missing process cwd fails like an upstream spawn", async () => {
    const root = await makeTestRoot()
    const adapter = rootedAdapter({ roots: [root], authorize: async () => ({ release: async () => {} }) })
    cleanups.push(() => adapter.close())
    const session = createCcaRpcSession({ environmentInfo: adapter.environmentInfo, handler: adapter.handler })
    cleanups.push(() => session.close())
    let requestID = 0
    const request = async (method: string, params?: unknown) => {
      const id = ++requestID
      const responses = decodeFrames(await session.receive(encodeFrame({ id, method, params })))
      expect(responses).toHaveLength(1)
      return responses[0]
    }
    await request("initialize", { clientName: "not-found-adapter" })
    await session.receive(encodeFrame({ method: "initialized" }))
    const missing = CcaPolicy.toPathUri(path.join(root, "missing", "AGENTS.override.md"))
    for (const method of ["fs/getMetadata", "fs/readFile", "fs/readDirectory", "fs/canonicalize"]) {
      expect((await request(method, { path: missing, sandbox: null })).error).toEqual({ code: -32004, message: "No such file or directory (os error 2)" })
    }
    const missingCwd = await request("process/start", {
      processId: "missing-cwd", argv: ["/bin/echo", "never"], cwd: CcaPolicy.toPathUri(path.join(root, "missing-cwd")), env: {},
    })
    expect(missingCwd.error).toEqual({ code: -32603, message: "Failed to start process" })
    const unknownRead = await request("process/read", { processId: "never-started" })
    expect(unknownRead.error).toEqual({ code: -32600, message: "unknown process id never-started" })
  })

  test("unsupported non-null policies and denied nullable requests have no process or filesystem effects", async () => {
    const root = await makeTestRoot()
    let deny = false
    let spawnCalls = 0
    let authorizeCalls = 0
    let releases = 0
    const adapter = rootedAdapter({
      roots: [root],
      spawnImpl: () => {
        spawnCalls++
        throw new Error("unexpected process spawn")
      },
      authorize: async () => {
        authorizeCalls++
        if (deny) throw new Error("synthetic authorization denial")
        return { release: async () => { releases++ } }
      },
    })
    cleanups.push(() => adapter.close())
    const session = createCcaRpcSession({ environmentInfo: adapter.environmentInfo, handler: adapter.handler })
    cleanups.push(() => session.close())
    let requestID = 0
    const request = async (method: string, params?: unknown) => {
      const id = ++requestID
      const responses = decodeFrames(await session.receive(encodeFrame({ id, method, params })))
      expect(responses).toHaveLength(1)
      expect(responses[0].id).toBe(id)
      return responses[0]
    }
    expect((await request("initialize", { clientName: "denied-nullable-adapter" })).error).toBeUndefined()
    await session.receive(encodeFrame({ method: "initialized" }))
    const marker = path.join(root, "process.marker")
    const start = {
      processId: "policy-denied",
      argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      cwd: CcaPolicy.toPathUri(root),
      env: {},
      tty: false,
      pipeStdin: false,
      enforceManagedNetwork: false,
      arg0: null,
    }
    for (const policy of [
      { sandbox: {} },
      { shellSnapshot: {} },
      { managedNetwork: {} },
      { networkProxy: {} },
    ]) {
      const response = await request("process/start", { ...start, ...policy })
      expect(response.error.code).toBe(-32602)
      expect(response.result).toBeUndefined()
      expect(authorizeCalls).toBe(0)
      expect(spawnCalls).toBe(0)
    }
    const policyParent = path.join(root, "policy-denied")
    const policyTarget = path.join(policyParent, "file.txt")
    const policyWrite = await request("fs/writeFile", {
      path: CcaPolicy.toPathUri(policyTarget),
      dataBase64: Buffer.from("must not be written").toString("base64"),
      followSymlinks: null,
      sandbox: {},
    })
    expect(policyWrite.error.code).toBe(-32602)
    expect(policyWrite.result).toBeUndefined()
    expect(authorizeCalls).toBe(0)
    await expect(stat(policyTarget)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(policyParent)).rejects.toMatchObject({ code: "ENOENT" })

    const malformedPolicy = await request("process/start", {
      ...start,
      envPolicy: { inherit: "unsupported", ignoreDefaultExcludes: false, exclude: [], includeOnly: [], set: {} },
    })
    expect(malformedPolicy.error.code).toBe(-32602)
    expect(malformedPolicy.result).toBeUndefined()
    expect(authorizeCalls).toBe(0)
    expect(releases).toBe(0)
    expect(spawnCalls).toBe(0)

    deny = true
    const deniedStart = await request("process/start", { ...start, processId: "authorization-denied", sandbox: null, envPolicy: null })
    expect(deniedStart.error).toEqual({ code: -32001, message: "Permission denied" })
    expect(deniedStart.result).toBeUndefined()
    expect(spawnCalls).toBe(0)
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    const managedNetworkAlone = await request("process/start", { ...start, processId: "managed-network-alone", enforceManagedNetwork: true })
    expect(managedNetworkAlone.error).toEqual({ code: -32001, message: "Permission denied" })
    expect(authorizeCalls).toBe(2)
    expect(spawnCalls).toBe(0)
    const deniedParent = path.join(root, "authorization-denied")
    const deniedTarget = path.join(deniedParent, "file.txt")
    const deniedWrite = await request("fs/writeFile", {
      path: CcaPolicy.toPathUri(deniedTarget),
      dataBase64: Buffer.from("must not be written").toString("base64"),
      followSymlinks: null,
      sandbox: null,
    })
    expect(deniedWrite.error).toEqual({ code: -32001, message: "Permission denied" })
    expect(deniedWrite.result).toBeUndefined()
    expect(authorizeCalls).toBe(3)
    expect(releases).toBe(0)
    expect(spawnCalls).toBe(0)
    await expect(stat(deniedTarget)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(deniedParent)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("end-to-end integration: initialize, capabilities shape, process echo, fs roundtrip, outside roots, auth denial, close kills sleep", async () => {
    const root = await makeTestRoot()

    const adapter = rootedAdapter({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })
    cleanups.push(() => adapter.close())

    const session = createCcaRpcSession({
      environmentInfo: adapter.environmentInfo,
      handler: adapter.handler,
    })
    cleanups.push(() => session.close())

    // 1. initialize
    const initFrames = await session.receive(
      encodeFrame({
        id: "init-1",
        method: "initialize",
        params: { clientName: "adapter-e2e-client" },
      }),
    )
    const initRes = decodeFrames(initFrames)
    expect(initRes).toHaveLength(1)
    expect(initRes[0].id).toBe("init-1")
    expect(initRes[0].jsonrpc).toBeUndefined()
    expect(typeof initRes[0].result.sessionId).toBe("string")

    const envInfo = initRes[0].result.environmentInfo
    expect(envInfo).toBeDefined()
    expect(envInfo.cwd).toBe(CcaPolicy.toPathUri(homedir()))

    const caps = envInfo.capabilities
    expect(caps).toEqual({
      networkProxyLaunch: true,
      networkProxyReviewDomains: true,
      capabilityDiscoverySandbox: true,
      capabilityDiscoveryV2: true,
      environmentConfigRead: true,
      httpHeaderEnvVars: true,
      sandboxedFileStreaming: true,
      fileWriteStreaming: true,
      shellSnapshotV2: true,
      windowsMxc: false,
    })
    expect("credentialMasking" in caps).toBe(false)
    expect("credentialMaskingCustomProviders" in caps).toBe(false)
    expect("fsWatchMissing" in caps).toBe(false)
    expect("linuxRootWritePreservesDevices" in caps).toBe(false)
    expect("linuxApprovedRootWritePreservesRestrictions" in caps).toBe(false)

    // 2. initialized notification
    const initializedFrames = await session.receive(encodeFrame({ method: "initialized" }))
    expect(decodeFrames(initializedFrames)).toHaveLength(0)

    // 3. process/start: node echo
    const echoScript = 'process.stdout.write("adapter-echo-ok\\n"); process.exit(0);'
    const startFrames = await session.receive(
      encodeFrame({
        id: 2,
        method: "process/start",
        params: {
          processId: "echo-p",
          argv: [process.execPath, "-e", echoScript],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
      }),
    )
    const startRes = decodeFrames(startFrames)
    expect(startRes[0].result).toEqual({ processId: "echo-p", sandboxType: "none" })

    // 4. process/read: poll to exited
    let readRes: any
    const chunks: any[] = []
    let seq = 0
    for (let attempt = 0; attempt < 10; attempt++) {
      const readFrames = await session.receive(
        encodeFrame({
          id: 3,
          method: "process/read",
          params: { processId: "echo-p", afterSeq: seq, waitMs: 500 },
        }),
      )
      readRes = decodeFrames(readFrames)[0].result
      if (readRes.chunks.length > 0) {
        chunks.push(...readRes.chunks)
        seq = readRes.nextSeq - 1
      }
      if (readRes.exited) break
    }
    expect(readRes.exited).toBe(true)
    expect(readRes.exitCode).toBe(0)
    const fullText = chunks
      .map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
      .join("")
    expect(fullText).toContain("adapter-echo-ok\n")

    // 5. fs/writeFile + fs/readFile roundtrip
    const targetUri = CcaPolicy.toPathUri(path.join(root, "nested", "doc.txt"))
    const expectedBase64 = Buffer.from("hello adapter").toString("base64")

    const writeFrames = await session.receive(
      encodeFrame({
        id: 4,
        method: "fs/writeFile",
        params: { path: targetUri, dataBase64: expectedBase64 },
      }),
    )
    expect(decodeFrames(writeFrames)[0].result).toEqual({})

    const readFsFrames = await session.receive(
      encodeFrame({
        id: 5,
        method: "fs/readFile",
        params: { path: targetUri },
      }),
    )
    expect(decodeFrames(readFsFrames)[0].result.dataBase64).toBe(expectedBase64)

    // 6. outside-root read -> -32600 Operation not permitted on wire
    const outsideUri = CcaPolicy.toPathUri("/etc/passwd")
    const outsideFrames = await session.receive(
      encodeFrame({
        id: 6,
        method: "fs/readFile",
        params: { path: outsideUri },
      }),
    )
    const outsideRes = decodeFrames(outsideFrames)
    expect(outsideRes[0].error).toEqual({ code: -32600, message: "Operation not permitted (os error 1)" })

    // 7. authorize-denied adapter -> -32001 on wire
    const deniedAdapter = rootedAdapter({
      roots: [root],
      authorize: async () => {
        throw new Error("unauthorized action")
      },
    })
    cleanups.push(() => deniedAdapter.close())

    const deniedSession = createCcaRpcSession({
      environmentInfo: deniedAdapter.environmentInfo,
      handler: deniedAdapter.handler,
    })
    cleanups.push(() => deniedSession.close())

    await deniedSession.receive(
      encodeFrame({ id: "init-denied", method: "initialize", params: { clientName: "denied" } }),
    )
    await deniedSession.receive(encodeFrame({ method: "initialized" }))

    const deniedFrames = await deniedSession.receive(
      encodeFrame({
        id: 7,
        method: "process/start",
        params: {
          processId: "denied-p",
          argv: [process.execPath, "-v"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
      }),
    )
    const deniedRes = decodeFrames(deniedFrames)
    expect(deniedRes[0].error.code).toBe(-32001)
    expect(deniedRes[0].error.message).toBe("Permission denied")

    // 8. close kills sleep child (pidfile assert)
    const pidFile = path.join(root, "sleep.pid")
    const sleepScript = `
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 10000);
    `

    await session.receive(
      encodeFrame({
        id: 8,
        method: "process/start",
        params: {
          processId: "sleep-p",
          argv: [process.execPath, "-e", sleepScript],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
      }),
    )

    // Poll until pidfile is written
    let childPid = 0
    for (let i = 0; i < 30; i++) {
      try {
        const text = await readFile(pidFile, "utf8")
        childPid = Number(text.trim())
        if (childPid > 0) break
      } catch {
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    expect(childPid).toBeGreaterThan(0)
    expect(isPidAlive(childPid)).toBe(true)

    // Close adapter -> child process killed
    await adapter.close()

    // Wait until dead
    let dead = false
    for (let i = 0; i < 30; i++) {
      if (!isPidAlive(childPid)) {
        dead = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(dead).toBe(true)
  })
})

describe("CCA executor adapter answers match the official exec-server golden shapes", () => {
  async function adapterSession(root: string, extra: Partial<Omit<CcaRpcAdapterOptions, "scopeFor">> = {}) {
    const adapter = rootedAdapter({ roots: [root], authorize: async () => ({ release: async () => {} }), ...extra })
    cleanups.push(() => adapter.close())
    const session = createCcaRpcSession({ environmentInfo: adapter.environmentInfo, handler: adapter.handler })
    cleanups.push(() => session.close())
    let requestID = 0
    const request = async (method: string, params?: unknown) => decodeFrames(await session.receive(encodeFrame({ id: ++requestID, method, params })))[0]
    const initialized = await request("initialize", { clientName: "codex-environment", resumeSessionId: null })
    await session.receive(encodeFrame({ method: "initialized", params: {} }))
    return { request, initialized }
  }

  test("initialize environmentInfo carries the official fields in the official order", async () => {
    const root = await makeTestRoot()
    const pathDir = path.join(root, "codex-path")
    await mkdir(pathDir)
    const { initialized } = await adapterSession(root, {
      environmentInfo: {
        userHomeDir: root,
        executorVersion: "0.165.0-alpha.1.2",
        providerId: "sha256:6c00ea8010dd56f75443a655293fd43e86b65f038786b1a257324d4a6028d4cf",
        prependPathDirs: [pathDir, path.join(root, "missing-path-dir")],
        tempDir: root,
        shell: { name: "zsh", path: "/bin/zsh" },
      },
      networkProxyCaDirectory: path.join(root, "proxy-ca"),
    })
    const info = initialized.result.environmentInfo
    expect(Object.keys(info)).toEqual(["shell", "executorVersion", "providerId", "cwd", "userHomeDir", "platformOs", "prependPathDirs", "temporaryDirectories", "tempDir", "capabilities"])
    expect(info.executorVersion).toBe("0.165.0-alpha.1.2")
    expect(info.providerId).toBe("sha256:6c00ea8010dd56f75443a655293fd43e86b65f038786b1a257324d4a6028d4cf")
    expect(info.cwd).toBe(CcaPolicy.toPathUri(root))
    expect(info.userHomeDir).toBe(CcaPolicy.toPathUri(root))
    expect(info.prependPathDirs).toEqual([CcaPolicy.toPathUri(pathDir)])
    expect(info.tempDir).toBe(CcaPolicy.toPathUri(root))
    expect(Object.keys(info.shell)).toEqual(["name", "path"])
    expect(Object.entries(info.capabilities)).toEqual([
      ["networkProxyLaunch", true],
      ["networkProxyReviewDomains", true],
      ["credentialMasking", true],
      ["credentialMaskingCustomProviders", true],
      ["capabilityDiscoverySandbox", true],
      ["capabilityDiscoveryV2", true],
      ["environmentConfigRead", true],
      ["httpHeaderEnvVars", true],
      ["sandboxedFileStreaming", true],
      ["fileWriteStreaming", true],
      ["shellSnapshotV2", true],
      ["windowsMxc", false],
    ])
    const bare = await adapterSession(root)
    expect("providerId" in bare.initialized.result.environmentInfo).toBe(false)
    expect("prependPathDirs" in bare.initialized.result.environmentInfo).toBe(false)
  })

  test("capabilities/discoverV2 answers the official skill shape and passes decode errors through, and closes with the connection", async () => {
    const root = await makeTestRoot()
    const home = path.join(root, "home")
    const workspace = path.join(root, "w")
    await mkdir(path.join(home, ".agents", "skills", "demo"), { recursive: true })
    await mkdir(path.join(home, ".codex"))
    await mkdir(workspace)
    await writeFile(path.join(home, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Synthetic demo skill\n---\nBody\n")
    const options = { environmentInfo: { userHomeDir: home }, environmentConfig: { codexHomeEnv: path.join(home, ".codex") } }
    const { request } = await adapterSession(root, options)
    expect((await request("capabilities/discoverV2", { cwd: CcaPolicy.toPathUri(workspace) })).result).toEqual({
      plugins: [],
      skills: [{
        name: "demo",
        description: "Synthetic demo skill",
        shortDescription: null,
        path: CcaPolicy.toPathUri(path.join(home, ".agents", "skills", "demo", "SKILL.md")),
        discoveryRoot: { id: "user-agent-skills", path: CcaPolicy.toPathUri(path.join(home, ".agents", "skills")) },
        dependencies: null,
        policy: null,
      }],
      warnings: [],
    })
    expect((await request("capabilities/discoverV2", {})).error).toEqual({ code: -32602, message: "missing field `cwd`" })
    expect((await request("capabilities/discoverV2", { cwd: "relative" })).error).toEqual({ code: -32602, message: "invalid URI: relative URL without a base" })

    const adapter = rootedAdapter({ roots: [root], authorize: async () => ({ release: async () => {} }), ...options })
    cleanups.push(() => adapter.close())
    const connection = adapter.handler.openRpcConnection!()
    await connection.close()
    const ctx = { signal: new AbortController().signal, sessionId: "synthetic-session", notify: async () => {} }
    await expect(connection.methods["capabilities/discoverV2"]({ cwd: CcaPolicy.toPathUri(workspace) }, ctx)).rejects.toMatchObject({ code: -32603, message: "capability discovery closed" })
  })

  test("fs/getMetadata on a missing path answers -32004 with the OS message inside and outside the roots", async () => {
    const root = await makeTestRoot()
    const outside = await makeTestRoot()
    const { request } = await adapterSession(root)
    for (const missing of [path.join(root, ".git"), path.join(outside, "codex-task", ".git"), path.join(root, "AGENTS.override.md")])
      expect((await request("fs/getMetadata", { path: CcaPolicy.toPathUri(missing), sandbox: null })).error).toEqual({ code: -32004, message: "No such file or directory (os error 2)" })
    await writeFile(path.join(root, "afile"), "")
    expect((await request("fs/getMetadata", { path: CcaPolicy.toPathUri(path.join(root, "afile", "x")) })).error).toEqual({ code: -32603, message: "Not a directory (os error 20)" })
    await writeFile(path.join(outside, "present"), "")
    expect((await request("fs/getMetadata", { path: CcaPolicy.toPathUri(path.join(outside, "present")) })).error.code).not.toBe(-32004)
    expect((await request("process/terminate", { processId: "never-started" })).result).toEqual({ running: false })
  })

  test("capabilityRoots/discoverV1 returns skills, plugin files, and root errors in the official shape", async () => {
    const root = await makeTestRoot()
    const skills = path.join(root, "skills")
    const plugin = path.join(root, "plug")
    const write = async (file: string, contents: string) => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, contents)
    }
    await write(path.join(skills, "alpha", "SKILL.md"), "---\nname: alpha\n---\nAlpha body\n")
    await write(path.join(skills, "alpha", "agents", "openai.yaml"), "interface:\n  display_name: Alpha\n")
    await write(path.join(skills, "beta", "SKILL.md"), "Beta\n")
    await write(path.join(skills, "nested", "deep", "gamma", "SKILL.md"), "Gamma\n")
    await write(path.join(skills, "README.md"), "not a skill\n")
    await write(path.join(plugin, ".codex-plugin", "plugin.json"), '{"name":"plug","mcpServers":"./mcp.json"}')
    await write(path.join(plugin, "mcp.json"), '{"mcpServers":{}}')
    await write(path.join(plugin, "skills", "p1", "SKILL.md"), "P1\n")
    await write(path.join(root, "afile"), "")
    const uri = (...parts: string[]) => CcaPolicy.toPathUri(path.join(root, ...parts))
    const { request } = await adapterSession(root)
    const response = await request("capabilityRoots/discoverV1", {
      roots: [
        { id: "r1", path: uri("skills"), sandbox: null },
        { id: "r2", path: uri("missing") },
        { id: "r3", path: uri("afile") },
        { id: "r4", path: uri("plug") },
      ],
    })
    const manifest = { path: uri("plug", ".codex-plugin", "plugin.json"), contents: '{"name":"plug","mcpServers":"./mcp.json"}' }
    expect(response.result).toEqual({
      roots: [
        {
          id: "r1",
          path: uri("skills"),
          plugin: null,
          skills: [
            { instructions: { path: uri("skills", "alpha", "SKILL.md"), contents: "---\nname: alpha\n---\nAlpha body\n" }, metadata: { path: uri("skills", "alpha", "agents", "openai.yaml"), contents: "interface:\n  display_name: Alpha\n" } },
            { instructions: { path: uri("skills", "beta", "SKILL.md"), contents: "Beta\n" }, metadata: null },
            { instructions: { path: uri("skills", "nested", "deep", "gamma", "SKILL.md"), contents: "Gamma\n" }, metadata: null },
          ],
          namespaceManifests: [],
          warnings: [],
          error: null,
        },
        { id: "r2", path: uri("missing"), plugin: null, skills: [], namespaceManifests: [], warnings: [], error: `failed to inspect capability root ${uri("missing")}: No such file or directory (os error 2)` },
        { id: "r3", path: uri("afile"), plugin: null, skills: [], namespaceManifests: [], warnings: [], error: `capability root ${uri("afile")} is not a directory` },
        {
          id: "r4",
          path: uri("plug"),
          plugin: { manifest, mcpConfig: { path: uri("plug", "mcp.json"), contents: '{"mcpServers":{}}' }, appsConfig: null },
          skills: [{ instructions: { path: uri("plug", "skills", "p1", "SKILL.md"), contents: "P1\n" }, metadata: null }],
          namespaceManifests: [manifest],
          warnings: [],
          error: null,
        },
      ],
    })
    expect(Object.keys(response.result.roots[0])).toEqual(["id", "path", "plugin", "skills", "namespaceManifests", "warnings", "error"])
    expect((await request("capabilityRoots/discoverV1", { roots: [] })).result).toEqual({ roots: [] })
  })

  test("environmentConfig/read answers the official result shape through the adapter", async () => {
    const root = await makeTestRoot()
    await mkdir(path.join(root, ".codex"))
    await writeFile(path.join(root, ".codex", "config.toml"), "[mcp_servers.synthetic]\ncommand = \"/synthetic/bin/server\"\n")
    const { request } = await adapterSession(root, {
      environmentInfo: { userHomeDir: root },
      environmentConfig: {
        codexHomeEnv: "",
        systemConfigPath: path.join(root, "etc", "config.toml"),
        systemRequirementsPath: path.join(root, "etc", "requirements.toml"),
        managedConfigPath: path.join(root, "etc", "managed_config.toml"),
        hostname: () => "synthetic",
      },
    })
    const response = await request("environmentConfig/read", { cwd: "file:///tmp/codex-task.synthetic", configPaths: [["mcp_servers"]], requirementsPaths: [["mcp_servers"]] })
    expect(response.result).toEqual({
      userHomeDir: CcaPolicy.toPathUri(root),
      codexHomeDir: CcaPolicy.toPathUri(path.join(root, ".codex")),
      hostname: "synthetic",
      config: {
        layers: [{ source: `user (${path.join(root, ".codex", "config.toml")})`, baseDir: CcaPolicy.toPathUri(path.join(root, ".codex")), toml: '[mcp_servers.synthetic]\ncommand = "/synthetic/bin/server"\n' }],
        cloudInsertionIndex: 0,
      },
      requirements: { layers: [], cloudInsertionIndex: 0 },
    })
  })
})

describe("CCA executor adapter translates the cloud task workspace and authorizes discovery per root", () => {
  type Call = { readonly action: string; readonly resources: readonly string[]; readonly metadata?: Readonly<Record<string, string>> }

  async function recordingSession(root: string, deny: (call: Call) => boolean = () => false) {
    const calls: Call[] = []
    const adapter = rootedAdapter({
      roots: [root],
      authorize: async (input) => {
        calls.push(input)
        if (deny(input)) throw new Error("synthetic denial")
        return { release: async () => {} }
      },
    })
    cleanups.push(() => adapter.close())
    const session = createCcaRpcSession({ environmentInfo: adapter.environmentInfo, handler: adapter.handler })
    cleanups.push(() => session.close())
    let requestID = 0
    const request = async (method: string, params?: unknown) => decodeFrames(await session.receive(encodeFrame({ id: ++requestID, method, params })))[0]
    const initialized = await request("initialize", { clientName: "codex-environment", resumeSessionId: null })
    await session.receive(encodeFrame({ method: "initialized", params: {} }))
    return { request, calls, initialized }
  }

  async function taskWorkspace() {
    const dir = await mkdtemp(path.join("/tmp", "codex-task."))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    return dir
  }

  const special = (kind: string, access: string, subpath?: string) => ({
    path: { type: "special", value: { kind, ...(subpath === undefined ? {} : { subpath }) } },
    access,
    ...(subpath === undefined ? {} : { missing_path_behavior: "skip" }),
  })

  const recordedSandbox = (workspace: string) => ({
    permissions: {
      type: "managed",
      file_system: {
        type: "restricted",
        entries: [
          special("root", "read"),
          special("project_roots", "write"),
          special("slash_tmp", "write"),
          special("tmpdir", "write"),
          special("project_roots", "read", ".git"),
          special("project_roots", "read", ".agents"),
          special("project_roots", "read", ".codex"),
          special("project_roots", "read", ".aws"),
        ],
      },
      network: "restricted",
    },
    cwd: CcaPolicy.toPathUri(workspace),
    workspaceRoots: [CcaPolicy.toPathUri(workspace)],
    windowsSandboxLevel: "disabled",
    windowsSandboxProxySettingsMode: "reconcile",
    useLegacyLandlock: false,
  })

  const recordedStart = (workspace: string, processId: string) => ({
    processId,
    metadata: { threadId: "01a18624-4070-71da-b2a5-13529d28901d", toolCallId: "exec-synthetic" },
    argv: ["/bin/sh", "-c", "printf 'cca-proof-ok\\n'"],
    cwd: CcaPolicy.toPathUri(workspace),
    envPolicy: { inherit: "all", ignoreDefaultExcludes: true, exclude: ["CODEX_PERMISSION_PROFILE"], set: {}, includeOnly: [] },
    env: { LC_ALL: "C.UTF-8", NO_COLOR: "1" },
    tty: false,
    pipeStdin: false,
    arg0: null,
    sandbox: recordedSandbox(workspace),
    enforceManagedNetwork: false,
    managedNetwork: null,
  })

  async function drain(request: (method: string, params?: unknown) => Promise<any>, processId: string) {
    let stdout = ""
    let stderr = ""
    let afterSeq = 0
    for (;;) {
      const read = await request("process/read", { processId, afterSeq, waitMs: 1_000 })
      for (const chunk of read.result.chunks) {
        const text = Buffer.from(chunk.chunk, "base64").toString("utf8")
        if (chunk.stream === "stderr") stderr += text
        else stdout += text
      }
      afterSeq = read.result.nextSeq - 1
      if (read.result.closed) return { stdout, stderr, exitCode: read.result.exitCode, sandboxDenied: read.result.sandboxDenied }
    }
  }

  test("the recorded process/start runs in a /tmp/codex-task workspace after an external-directory approval", async () => {
    const root = await makeTestRoot()
    const workspace = await taskWorkspace()
    const canonical = await realpath(workspace)
    const { request, calls } = await recordingSession(root)
    const started = await request("process/start", recordedStart(workspace, "workspace-run"))
    expect(started.result).toEqual({ processId: "workspace-run", sandboxType: "none" })
    expect(calls.map((call) => call.action)).toEqual(["external_directory", "shell"])
    expect(await drain(request, "workspace-run")).toEqual({ stdout: "cca-proof-ok\n", stderr: "", exitCode: 0, sandboxDenied: false })
    expect(calls[0]).toMatchObject({ resources: [`${canonical}/*`], metadata: { filepath: canonical, parentDir: canonical } })
    expect(Object.keys(calls[0]!.metadata ?? {}).sort()).toEqual(["filepath", "parentDir"])
    expect(calls[1]!.metadata).toMatchObject({ cwd: canonical, workdir: canonical })
    expect(Object.keys(calls[1]!.metadata ?? {}).filter((key) => key.startsWith("sandbox") || key === "processId")).toEqual([])

    await writeFile(path.join(workspace, "note.txt"), "synthetic")
    const sandboxed = await request("fs/readFile", { path: CcaPolicy.toPathUri(path.join(workspace, "note.txt")), sandbox: recordedSandbox(workspace) })
    expect(sandboxed.result).toEqual({ dataBase64: Buffer.from("synthetic").toString("base64") })
    const unsandboxed = await request("fs/readFile", { path: CcaPolicy.toPathUri(path.join(workspace, "note.txt")) })
    expect(unsandboxed.error).toEqual({ code: -32600, message: "Operation not permitted (os error 1)" })
  })

  test("a denied external-directory Permission yields the upstream sandbox denial", async () => {
    const root = await makeTestRoot()
    const workspace = await taskWorkspace()
    const { request, calls } = await recordingSession(root, (call) => call.action === "external_directory")
    const started = await request("process/start", recordedStart(workspace, "workspace-denied"))
    expect(started.result).toEqual({ processId: "workspace-denied", sandboxType: "none" })
    expect(calls.map((call) => call.action)).toEqual(["external_directory"])
    const outcome = await drain(request, "workspace-denied")
    expect(outcome).toMatchObject({ stdout: "", exitCode: 1, sandboxDenied: true })
    expect(outcome.stderr).toContain("sandbox denied")
    await writeFile(path.join(workspace, "note.txt"), "synthetic")
    const read = await request("fs/readFile", { path: CcaPolicy.toPathUri(path.join(workspace, "note.txt")), sandbox: recordedSandbox(workspace) })
    expect(read.error).toEqual({ code: -32600, message: "Permission denied" })
  })

  test("discovery holds one read grant per root and returns the same results", async () => {
    const root = await makeTestRoot()
    const skills = path.join(root, "skills")
    for (const name of ["alpha", "beta", "gamma"]) {
      await mkdir(path.join(skills, name, "agents"), { recursive: true })
      await writeFile(path.join(skills, name, "SKILL.md"), `${name}\n`)
      await writeFile(path.join(skills, name, "agents", "openai.yaml"), `name: ${name}\n`)
    }
    const { request, calls } = await recordingSession(root)
    const response = await request("capabilityRoots/discoverV1", { roots: [{ id: "codex-home-skills", path: CcaPolicy.toPathUri(skills), sandbox: null }] })
    expect(response.result.roots[0].skills.map((skill: any) => [skill.instructions.contents, skill.metadata.contents])).toEqual([
      ["alpha\n", "name: alpha\n"],
      ["beta\n", "name: beta\n"],
      ["gamma\n", "name: gamma\n"],
    ])
    expect(response.result.roots[0].warnings).toEqual([])
    expect(calls).toEqual([{ action: "read", resources: [skills] }])
  })

  test("sandboxed discoverV1 roots apply the sandbox like the official executor", async () => {
    const root = await makeTestRoot()
    const skills = path.join(root, "skills")
    for (const name of ["alpha", "beta"]) {
      await mkdir(path.join(skills, name), { recursive: true })
      await writeFile(path.join(skills, name, "SKILL.md"), `${name}\n`)
    }
    const uri = (...parts: string[]) => CcaPolicy.toPathUri(path.join(root, ...parts))
    const context = (permissions: unknown) => ({ permissions, cwd: uri(), workspaceRoots: [uri()], windowsSandboxLevel: "disabled", windowsSandboxProxySettingsMode: "reconcile", useLegacyLandlock: false })
    const restricted = (entries: unknown[]) => context({ type: "managed", file_system: { type: "restricted", entries }, network: "restricted" })
    const { request, initialized } = await recordingSession(root)
    expect(initialized.result.environmentInfo.capabilities.capabilityDiscoverySandbox).toBe(true)
    expect(initialized.result.environmentInfo.capabilities.capabilityDiscoveryV2).toBe(true)
    const discover = async (sandbox: unknown) => (await request("capabilityRoots/discoverV1", { roots: [{ id: "r1", path: uri("skills"), sandbox }] })).result.roots[0]
    const skill = (name: string) => ({ instructions: { path: uri("skills", name, "SKILL.md"), contents: `${name}\n` }, metadata: null })
    const empty = { id: "r1", path: uri("skills"), plugin: null, namespaceManifests: [], error: null }
    expect(await discover(restricted([{ path: { type: "path", path: uri("skills", "alpha") }, access: "read" }]))).toEqual({
      ...empty,
      skills: [],
      warnings: [`failed to scan capability path ${uri("skills")}: Operation not permitted (os error 1)`],
    })
    expect(
      await discover(restricted([
        { path: { type: "path", path: uri("skills") }, access: "read" },
        { path: { type: "path", path: uri("skills", "beta") }, access: "deny" },
      ])),
    ).toEqual({ ...empty, skills: [skill("alpha")], warnings: [`failed to scan capability path ${uri("skills", "beta")}: Operation not permitted (os error 1)`] })
    expect(await discover(context({ type: "disabled" }))).toEqual({ ...empty, skills: [skill("alpha"), skill("beta")], warnings: [] })
  })
})
