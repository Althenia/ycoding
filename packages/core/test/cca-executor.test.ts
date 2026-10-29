import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile as fsWriteFile, mkdir, realpath, chmod, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { CcaExecutorError, ccaRefusalText, CCA_BUSY_TEXT, type CcaAuthorizationInput, type CcaPendingDecision } from "../src/cca/errors"
import { CcaAuthorizationDeniedError } from "../src/cca/authorization"
import { createCcaExecutor, type CcaExecutorHandler, type CcaExecutorOptions, type CcaExecutorScope, ccaEnvironmentInfo } from "../src/cca/executor"
import { CcaPolicy } from "../src/cca/policy"
import { SessionGuardrailMatch } from "../src/session/guardrail-match"
import { Platform } from "../src/util/platform"

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

type FixedExecutorOptions = Omit<CcaExecutorOptions, "scopeFor"> & {
  readonly roots: readonly string[]
  readonly authorize: CcaExecutorScope["authorization"]["authorize"]
}

function createFixedExecutor({ roots, authorize, ...options }: FixedExecutorOptions) {
  return createCcaExecutor({ ...options, scopeFor: async () => ({ sessionID: "ses_cca_executor_test", roots, authorization: { authorize }, close: async () => {} }) })
}

async function makeTestRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cca-exec-test-")))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe("CcaExecutor Service", () => {
  test("maxBytes truncation returns nextSeq after the last returned chunk", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({ roots: [root], authorize: async () => ({ release: async () => {} }) })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "paging-test" }, { signal: new AbortController().signal })
    const ctx = { signal: new AbortController().signal, sessionId: initRes.sessionId }
    const script = `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        for (const part of ["aaaa", "bbbb", "cccc"]) { process.stdout.write(part); await sleep(150); }
      })();
    `
    await executor.startProcess({ processId: "paging", argv: [process.execPath, "-e", script], cwd: CcaPolicy.toPathUri(root), env: {} }, ctx)

    const decode = (chunks: ReadonlyArray<{ chunk: string }>) =>
      chunks.map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
    let full = await executor.readProcess({ processId: "paging", afterSeq: 0, waitMs: 2000 }, ctx)
    const all = [...full.chunks]
    while (!full.exited) {
      full = await executor.readProcess({ processId: "paging", afterSeq: full.nextSeq - 1, waitMs: 2000 }, ctx)
      all.push(...full.chunks)
    }
    expect(decode(all)).toEqual(["aaaa", "bbbb", "cccc"])
    const seqs = all.map((c) => c.seq)

    const unbounded = await executor.readProcess({ processId: "paging", afterSeq: 0 }, ctx)
    expect(unbounded.nextSeq).toBe(full.nextSeq)
    expect(unbounded.chunks.map((c) => c.seq)).toEqual(seqs)

    const first = await executor.readProcess({ processId: "paging", afterSeq: 0, maxBytes: 8 }, ctx)
    expect(decode(first.chunks)).toEqual(["aaaa", "bbbb"])
    expect(first.nextSeq).toBe(seqs[1]! + 1)

    const rest = await executor.readProcess({ processId: "paging", afterSeq: first.nextSeq - 1 }, ctx)
    expect(decode(rest.chunks)).toEqual(["cccc"])
    expect(rest.chunks[0]!.seq).toBe(seqs[2]!)
    expect(rest.nextSeq).toBe(full.nextSeq)
  })

  test("explicit host inheritance reaches the real child only after authorization and releases its grant", async () => {
    const root = await makeTestRoot()
    const key = "YCODING_CCA_TEST_INHERIT_SENTINEL"
    const secret = "YCODING_CCA_TEST_SECRET_SENTINEL"
    const previous = process.env[key]
    const previousSecret = process.env[secret]
    process.env[key] = "synthetic-host"
    process.env[secret] = "synthetic-secret"
    let deny = true
    const grants: Array<{ action: string; releases: number }> = []
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async ({ action }) => {
        if (deny) throw new Error("synthetic denial")
        const grant = { action, releases: 0 }
        grants.push(grant)
        return { release: async () => { grant.releases++ } }
      },
    })
    try {
      const initialized = await executor.initialize({ clientName: "inheritance-test" }, { signal: new AbortController().signal })
      const ctx = { signal: new AbortController().signal, sessionId: initialized.sessionId }
      const params = {
        processId: "host-environment",
        argv: [process.execPath, "-e", `process.stdout.write(JSON.stringify({inherited:process.env[${JSON.stringify(key)}]==='synthetic-host',secretAbsent:process.env[${JSON.stringify(secret)}]===undefined}))`],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
        tty: false,
        pipeStdin: false,
        enforceManagedNetwork: false,
        envPolicy: { inherit: "all", ignoreDefaultExcludes: true, exclude: [], set: {}, includeOnly: [] },
      }
      await expect(executor.startProcess(params, ctx)).rejects.toMatchObject({ code: -32001 })
      expect(grants).toHaveLength(0)
      deny = false
      expect(await executor.startProcess(params, ctx)).toEqual({ processId: params.processId, sandboxType: "none" })
      let afterSeq = 0
      let output = ""
      let exited = false
      for (let attempt = 0; attempt < 10 && !exited; attempt++) {
        const result = await executor.readProcess({ processId: params.processId, afterSeq, waitMs: 500 }, ctx)
        output += result.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8")).join("")
        afterSeq = result.nextSeq - 1
        exited = result.exited
        if (exited) expect(result.exitCode).toBe(0)
      }
      expect(exited).toBe(true)
      expect(JSON.parse(output)).toEqual({ inherited: true, secretAbsent: true })
      await executor.close()
      expect(grants.filter((grant) => grant.action === "shell")).toHaveLength(1)
      expect(grants.every((grant) => grant.releases === 1)).toBe(true)
      expect(process.env[key]).toBe("synthetic-host")
      expect(process.env[secret]).toBe("synthetic-secret")
    } finally {
      await executor.close()
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
      if (previousSecret === undefined) delete process.env[secret]
      else process.env[secret] = previousSecret
    }
  })

  test("happy path process: start, chunk seq/base64, read afterSeq and waitMs", async () => {
    const root = await makeTestRoot()
    const notifications: Array<{ method: string; params: unknown }> = []

    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })
    cleanups.push(() => executor.close())

    const initCtx = {
      signal: new AbortController().signal,
      notify: (method: string, params: unknown) => {
        notifications.push({ method, params })
      },
    }
    const initRes = await executor.initialize({ clientName: "test-client" }, initCtx)
    expect(initRes.sessionId).toBeDefined()

    const handlerCtx = {
      signal: new AbortController().signal,
      sessionId: initRes.sessionId,
    }

    const script = `
      process.stdout.write("hello stdout\\n");
      process.stderr.write("hello stderr\\n");
      process.exit(0);
    `

    const startRes = await executor.startProcess(
      {
        processId: "p1",
        argv: [process.execPath, "-e", script],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    expect(startRes.processId).toBe("p1")
    expect(startRes.sandboxType).toBe("none")

    // Read until exit
    let readRes = await executor.readProcess(
      {
        processId: "p1",
        afterSeq: 0,
        waitMs: 2000,
      },
      handlerCtx,
    )
    const chunks = [...readRes.chunks]

    while (!readRes.exited) {
      readRes = await executor.readProcess(
        {
          processId: "p1",
          afterSeq: readRes.nextSeq - 1,
          waitMs: 2000,
        },
        handlerCtx,
      )
      chunks.push(...readRes.chunks)
    }

    expect(readRes.exited).toBe(true)
    expect(readRes.exitCode).toBe(0)

    const allDecoded = chunks
      .map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
      .join("")
    expect(allDecoded).toContain("hello stdout\n")
    expect(allDecoded).toContain("hello stderr\n")

    // Notifications check
    expect(notifications.some((n) => n.method === "process/output")).toBe(true)
    expect(notifications.some((n) => n.method === "process/exited")).toBe(true)
  })

  test("writeProcess: stdin echo, idempotency with identical hash, different hash throws -32602", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })
    cleanups.push(() => executor.close())

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    // Node script that echoes stdin to stdout line by line until stdin closes
    const script = `
      process.stdin.on('data', (d) => process.stdout.write(d));
      process.stdin.on('end', () => process.exit(0));
    `

    await executor.startProcess(
      {
        processId: "cat-p",
        argv: [process.execPath, "-e", script],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
        pipeStdin: true,
      },
      handlerCtx,
    )

    const chunk1 = Buffer.from("line1\n").toString("base64")
    const writeRes1 = await executor.writeProcess(
      { processId: "cat-p", chunk: chunk1, writeId: "w1" },
      handlerCtx,
    )
    expect(writeRes1.status).toBe("accepted")

    // Replay with identical writeId + chunk -> accepted without rewriting
    const writeResReplay = await executor.writeProcess(
      { processId: "cat-p", chunk: chunk1, writeId: "w1" },
      handlerCtx,
    )
    expect(writeResReplay.status).toBe("accepted")

    // Replay with same writeId but DIFFERENT chunk -> -32602
    const chunkDiff = Buffer.from("line2\n").toString("base64")
    await expect(
      executor.writeProcess(
        { processId: "cat-p", chunk: chunkDiff, writeId: "w1" },
        handlerCtx,
      ),
    ).rejects.toThrow()

    // Read back echoed output
    const readRes = await executor.readProcess(
      { processId: "cat-p", afterSeq: 0, waitMs: 1000 },
      handlerCtx,
    )
    const text = readRes.chunks
      .map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
      .join("")
    expect(text).toBe("line1\n")
  })

  test("signalProcess: interrupt exits", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })
    cleanups.push(() => executor.close())

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    const script = `
      process.on('SIGINT', () => { process.exit(130); });
      setInterval(() => {}, 1000);
    `

    await executor.startProcess(
      {
        processId: "sig-p",
        argv: [process.execPath, "-e", script],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    const sigRes = await executor.signalProcess(
      { processId: "sig-p", signal: "interrupt" },
      handlerCtx,
    )
    expect(sigRes).toEqual({})

    // Read until exit
    const readRes = await executor.readProcess(
      { processId: "sig-p", afterSeq: 0, waitMs: 2000 },
      handlerCtx,
    )
    expect(readRes.exited).toBe(true)
  })

  test("terminateProcess: kills running process and reports running true then false", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })
    cleanups.push(() => executor.close())

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "term-p",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    const term1 = await executor.terminateProcess({ processId: "term-p" }, handlerCtx)
    expect(term1.running).toBe(true)

    // Second terminate on already killed process -> running false
    const term2 = await executor.terminateProcess({ processId: "term-p" }, handlerCtx)
    expect(term2.running).toBe(false)
  })

  test("timeout: terminates process when exceeding processTimeoutMs", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
      processTimeoutMs: 150,
    })
    cleanups.push(() => executor.close())

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "timeout-p",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    const readRes = await executor.readProcess(
      { processId: "timeout-p", afterSeq: 0, waitMs: 1000 },
      handlerCtx,
    )
    expect(readRes.exited).toBe(true)
  })

  test("close() kills all active processes", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "close-p",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    await executor.close()

    // Subsequent operation fails
    await expect(
      executor.startProcess(
        {
          processId: "after-close",
          argv: [process.execPath, "-v"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
        handlerCtx,
      ),
    ).rejects.toThrow()
  })

  test("authorization: denial blocks process spawn and fs write with -32001", async () => {
    const root = await makeTestRoot()
    let deny = false
    const authorizedCalls: Array<{ action: string; resources: readonly string[] }> = []

    const executor = createFixedExecutor({
      roots: [root],
      authorize: async (input) => {
        authorizedCalls.push(input)
        if (deny) throw new Error("Blocked by user permission")
        return { release: async () => {} }
      },
    })
    cleanups.push(() => executor.close())

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    deny = true
    try {
      await executor.startProcess(
        {
          processId: "denied-p",
          argv: [process.execPath, "-v"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
        handlerCtx,
      )
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect(err.code).toBe(-32001)
      expect(err.message).toBe("Permission denied")
      expect(err.message).not.toContain("Blocked by user")
    }

    try {
      await executor.writeFile(
        {
          path: CcaPolicy.toPathUri(path.join(root, "denied.txt")),
          dataBase64: Buffer.from("hello").toString("base64"),
        },
        handlerCtx,
      )
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect(err.code).toBe(-32001)
      expect(err.message).toBe("Permission denied")
    }
  })

  test("outside-roots and symlink escape rejected with -32600 Operation not permitted", async () => {
    const root = await makeTestRoot()
    const outside = await makeTestRoot()

    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })
    cleanups.push(() => executor.close())

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }
    await fsWriteFile(path.join(outside, "secret.txt"), "secret")
    await fsWriteFile(path.join(outside, "file.txt"), "secret")

    // Direct outside root
    try {
      await executor.readFile(
        { path: CcaPolicy.toPathUri(path.join(outside, "secret.txt")) },
        handlerCtx,
      )
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect({ code: err.code, message: err.message }).toEqual({ code: -32600, message: "Operation not permitted (os error 1)" })
    }

    // Symlink escape
    const linkPath = path.join(root, "escape-link")
    await symlink(outside, linkPath)

    try {
      await executor.readFile(
        { path: CcaPolicy.toPathUri(path.join(linkPath, "file.txt")) },
        handlerCtx,
      )
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect({ code: err.code, message: err.message }).toEqual({ code: -32600, message: "Operation not permitted (os error 1)" })
    }
  })

  test("createDirectory creates an authorized, root-confined directory once and never reuses an existing path", async () => {
    const root = await makeTestRoot()
    const outside = await makeTestRoot()
    let deny = false
    const authorized: string[] = []
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async (input) => {
        authorized.push(`${input.action}:${input.resources.join(",")}`)
        if (deny) throw new Error("synthetic denial")
        return { release: async () => {} }
      },
    })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    const nested = path.join(root, "Documents", "YCoding", "2026-10-29", "task")
    expect(await executor.createDirectory({ path: CcaPolicy.toPathUri(nested) }, handlerCtx)).toEqual({ created: true, path: CcaPolicy.toPathUri(nested) })
    expect((await stat(nested)).isDirectory()).toBe(true)
    expect(authorized).toEqual([`edit:${nested}`])
    expect(await executor.createDirectory({ path: CcaPolicy.toPathUri(nested) }, handlerCtx)).toEqual({ created: false })

    const linked = path.join(root, "linked")
    await symlink(outside, linked)
    expect(await executor.createDirectory({ path: CcaPolicy.toPathUri(linked) }, handlerCtx)).toEqual({ created: false })
    await expect(executor.createDirectory({ path: CcaPolicy.toPathUri(path.join(linked, "escape")) }, handlerCtx)).rejects.toMatchObject({ code: -32600, message: "Operation not permitted (os error 1)" })
    await expect(executor.createDirectory({ path: CcaPolicy.toPathUri(path.join(outside, "escape")) }, handlerCtx)).rejects.toMatchObject({ code: -32600, message: "Operation not permitted (os error 1)" })
    await expect(stat(path.join(outside, "escape"))).rejects.toMatchObject({ code: "ENOENT" })

    deny = true
    const denied = path.join(root, "denied", "task")
    await expect(executor.createDirectory({ path: CcaPolicy.toPathUri(denied) }, handlerCtx)).rejects.toMatchObject({ code: -32001 })
    await expect(stat(path.join(root, "denied"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("fs operations roundtrip: writeFile, readFile, getMetadata, readDirectory, canonicalize", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })
    cleanups.push(() => executor.close())

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    const targetUri = CcaPolicy.toPathUri(path.join(root, "sub", "test.txt"))
    const content = Buffer.from("hello world 12345")
    const b64 = content.toString("base64")

    // writeFile
    const writeRes = await executor.writeFile({ path: targetUri, dataBase64: b64 }, handlerCtx)
    expect(writeRes).toEqual({})

    // readFile
    const readRes = await executor.readFile({ path: targetUri }, handlerCtx)
    expect(readRes.dataBase64).toBe(b64)

    // getMetadata
    const metaRes = await executor.getMetadata({ path: targetUri }, handlerCtx)
    expect(metaRes.isFile).toBe(true)
    expect(metaRes.isDirectory).toBe(false)
    expect(metaRes.isSymlink).toBe(false)
    expect(metaRes.size).toBe(content.length)

    // readDirectory
    const dirRes = await executor.readDirectory(
      { path: CcaPolicy.toPathUri(path.join(root, "sub")) },
      handlerCtx,
    )
    expect(dirRes.entries.some((e) => e.fileName === "test.txt" && e.isFile)).toBe(true)

    // canonicalize
    const canonRes = await executor.canonicalize({ path: targetUri }, handlerCtx)
    expect(canonRes.path).toBe(targetUri)
  })

  test("unknown process error matrix and duplicate processId", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
    })
    cleanups.push(() => executor.close())

    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal, notify: () => {} })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await expect(executor.readProcess({ processId: "nonexistent" }, handlerCtx)).rejects.toMatchObject({
      code: -32600,
      message: "unknown process id nonexistent",
    })

    // write unknown process -> { status: "unknownProcess" }
    const writeRes = await executor.writeProcess(
      { processId: "nonexistent", chunk: "aGVsbG8=", writeId: "w1" },
      handlerCtx,
    )
    expect(writeRes.status).toBe("unknownProcess")

    // signal unknown process -> {}
    const sigRes = await executor.signalProcess(
      { processId: "nonexistent", signal: "interrupt" },
      handlerCtx,
    )
    expect(sigRes).toEqual({})

    // terminate unknown process -> { running: false }
    const termRes = await executor.terminateProcess(
      { processId: "nonexistent" },
      handlerCtx,
    )
    expect(termRes.running).toBe(false)

    // duplicate active processId -> throws -32602
    await executor.startProcess(
      {
        processId: "dup-p",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    try {
      await executor.startProcess(
        {
          processId: "dup-p",
          argv: [process.execPath, "-e", "process.exit(0)"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
        handlerCtx,
      )
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect(err.code).toBe(-32600)
      expect(err.message).toBe("process dup-p already exists")
    }
  })

  test("Platform.upstreamOs: maps Node platforms to upstream operating-system names", () => {
    expect(Platform.upstreamOs("darwin")).toBe("macos")
    expect(Platform.upstreamOs("win32")).toBe("windows")
    expect(Platform.upstreamOs("linux")).toBe("linux")
    expect(Platform.upstreamOs("freebsd")).toBe("freebsd")
    expect(Platform.upstreamOs()).toBe(Platform.upstreamOs(process.platform))
    expect(["darwin", "win32"]).not.toContain(ccaEnvironmentInfo({ cwd: "/tmp" }).platformOs)
  })

  test("ccaEnvironmentInfo: builder defaults, URI encoding, capabilities exact keys and omitted keys", () => {
    const cwd = "/tmp/test space"
    const info = ccaEnvironmentInfo({ cwd })

    expect(info.cwd).toBe("file:///tmp/test%20space")
    expect(info.executorVersion).toBe("0.0.0")
    expect(info.platformOs).toBe(Platform.upstreamOs())
    expect(info.shell).toBeDefined()
    expect(typeof info.shell.name).toBe("string")
    expect(typeof info.shell.path).toBe("string")

    // Undefined optionals omitted (not null, not undefined keys)
    expect("userHomeDir" in info).toBe(false)
    expect("tempDir" in info).toBe(false)
    expect("providerId" in info).toBe(false)
    expect("prependPathDirs" in info).toBe(false)

    // Capabilities: exact 9 keys serialized false
    const caps = info.capabilities
    expect(caps).toEqual({
      networkProxyLaunch: false,
      capabilityDiscoverySandbox: false,
      capabilityDiscoveryV2: false,
      environmentConfigRead: false,
      httpHeaderEnvVars: false,
      sandboxedFileStreaming: false,
      fileWriteStreaming: false,
      shellSnapshotV2: false,
      windowsMxc: false,
    })

    // Skip-if-false keys strictly OMITTED from capabilities object
    expect("networkProxyReviewDomains" in caps).toBe(false)
    expect("credentialMasking" in caps).toBe(false)
    expect("credentialMaskingCustomProviders" in caps).toBe(false)
    expect("fsWatchMissing" in caps).toBe(false)
    expect("linuxRootWritePreservesDevices" in caps).toBe(false)
    expect("linuxApprovedRootWritePreservesRestrictions" in caps).toBe(false)
  })

  test("ccaEnvironmentInfo: temporaryDirectories reports the executor TMPDIR like the upstream executor", () => {
    if (process.platform === "win32") return
    const previous = process.env.TMPDIR
    try {
      process.env.TMPDIR = "/tmp/synthetic tmp/"
      expect(ccaEnvironmentInfo({ cwd: "/tmp" }).temporaryDirectories).toEqual(["file:///tmp/synthetic%20tmp"])
      process.env.TMPDIR = ""
      expect(ccaEnvironmentInfo({ cwd: "/tmp" }).temporaryDirectories).toEqual([])
      delete process.env.TMPDIR
      expect(ccaEnvironmentInfo({ cwd: "/tmp" }).temporaryDirectories).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  test("ccaEnvironmentInfo: explicit overrides roundtrip", () => {
    const info = ccaEnvironmentInfo({
      cwd: "/workspace/my project",
      shell: { name: "custom-zsh", path: "/opt/bin/zsh" },
      executorVersion: "2.3.4",
      userHomeDir: "/Users/dev user",
      tempDir: "/tmp/custom temp",
      temporaryDirectories: ["/tmp/custom temp", "/var/tmp"],
    })

    expect(info).toEqual({
      shell: { name: "custom-zsh", path: "/opt/bin/zsh" },
      executorVersion: "2.3.4",
      platformOs: Platform.upstreamOs(),
      cwd: "file:///workspace/my%20project",
      userHomeDir: "file:///Users/dev%20user",
      tempDir: "file:///tmp/custom%20temp",
      temporaryDirectories: ["file:///tmp/custom%20temp", "file:///var/tmp"],
      capabilities: {
        networkProxyLaunch: false,
        capabilityDiscoverySandbox: false,
        capabilityDiscoveryV2: false,
        environmentConfigRead: false,
        httpHeaderEnvVars: false,
        sandboxedFileStreaming: false,
        fileWriteStreaming: false,
        shellSnapshotV2: false,
        windowsMxc: false,
      },
    })
  })

  test("item 1: write to exited process resolves stdinClosed and does not record writeId", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({ roots: [root], authorize: async () => ({ release: async () => {} }) })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "fast-exit",
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
        pipeStdin: true,
      },
      handlerCtx,
    )

    let readRes = await executor.readProcess({ processId: "fast-exit", waitMs: 1000 }, handlerCtx)
    while (!readRes.exited) {
      readRes = await executor.readProcess(
        { processId: "fast-exit", afterSeq: readRes.nextSeq - 1, waitMs: 1000 },
        handlerCtx,
      )
    }

    const res = await executor.writeProcess(
      { processId: "fast-exit", chunk: Buffer.from("hi").toString("base64"), writeId: "w-fail" },
      handlerCtx,
    )
    expect(res.status).toBe("stdinClosed")

    const retry = await executor.writeProcess(
      { processId: "fast-exit", chunk: Buffer.from("hi").toString("base64"), writeId: "w-fail" },
      handlerCtx,
    )
    expect(retry.status).toBe("stdinClosed")
  })

  test("item 2: synchronous placeholder registration prevents race and terminate during start kills child", async () => {
    const root = await makeTestRoot()
    let releaseAuth!: () => void
    const authPromise = new Promise<void>((r) => {
      releaseAuth = r
    })
    let callCount = 0

    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => {
        callCount++
        if (callCount === 1) await authPromise
        return { release: async () => {} }
      },
    })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    const p1 = executor.startProcess(
      {
        processId: "race-p",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    await expect(
      executor.startProcess(
        {
          processId: "race-p",
          argv: [process.execPath, "-v"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
        handlerCtx,
      ),
    ).rejects.toThrow()

    const termPromise = executor.terminateProcess({ processId: "race-p" }, handlerCtx)
    releaseAuth()

    const startRes1 = await p1
    expect(startRes1.processId).toBe("race-p")
    const termRes = await termPromise
    expect(termRes.running).toBe(true)

    let raceRead = await executor.readProcess({ processId: "race-p", waitMs: 2000 }, handlerCtx)
    while (!raceRead.exited) {
      raceRead = await executor.readProcess(
        { processId: "race-p", afterSeq: raceRead.nextSeq - 1, waitMs: 2000 },
        handlerCtx,
      )
    }
    expect(raceRead.exited).toBe(true)
  })

  test("item 3: writeProcess authorizes with writeId, bytes, preview metadata", async () => {
    const root = await makeTestRoot()
    const authCalls: any[] = []
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async (input) => {
        authCalls.push(input)
        return { release: async () => {} }
      },
    })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "auth-meta-p",
        argv: [process.execPath, "-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
        pipeStdin: true,
      },
      handlerCtx,
    )

    authCalls.length = 0
    const chunk = Buffer.from("hello world").toString("base64")
    await executor.writeProcess({ processId: "auth-meta-p", chunk, writeId: "w-meta-1" }, handlerCtx)

    expect(authCalls).toHaveLength(1)
    expect(authCalls[0].action).toBe("shell")
    expect(authCalls[0].resources).toEqual(["auth-meta-p", "hello world"])
    expect(authCalls[0].metadata).toBeDefined()
    expect(authCalls[0].metadata.writeId).toBe("w-meta-1")
    expect(authCalls[0].metadata.bytes).toBe("11")
    expect(authCalls[0].metadata.preview).toContain("hello world")
  })

  test("item 4: spawn failure throws fixed -32603 and removes placeholder", async () => {
    const root = await makeTestRoot()
    let authorizeCalls = 0
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => {
        authorizeCalls++
        return { release: async () => {} }
      },
    })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    try {
      await executor.startProcess(
        {
          processId: "bad-spawn",
          argv: ["/nonexistent/binary/path/that/cannot/exist"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
        handlerCtx,
      )
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect(err.code).toBe(-32603)
      expect(err.message).toBe("Failed to start process")
      expect(authorizeCalls).toBeGreaterThan(0)
    }

    await expect(executor.readProcess({ processId: "bad-spawn" }, handlerCtx)).rejects.toMatchObject({ code: -32600 })

    await expect(executor.startProcess(
      { processId: "missing-cwd", argv: ["/bin/echo"], cwd: CcaPolicy.toPathUri(path.join(root, "missing-cwd")), env: {} },
      handlerCtx,
    )).rejects.toMatchObject({ code: -32603, message: "Failed to start process" })
    await expect(executor.startProcess(
      { processId: "outside-cwd", argv: ["/bin/echo"], cwd: CcaPolicy.toPathUri(path.join(path.dirname(root), "outside-missing-cwd")), env: {} },
      handlerCtx,
    )).rejects.toMatchObject({ code: -32600, message: "Operation not permitted (os error 1)" })
    await expect(executor.startProcess(
      { processId: "outside-existing-cwd", argv: ["/bin/echo"], cwd: CcaPolicy.toPathUri(path.dirname(root)), env: {} },
      handlerCtx,
    )).rejects.toMatchObject({ code: -32600, message: "Operation not permitted (os error 1)" })
  })

  test("item 5: fs error mapping uses the upstream messages", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({ roots: [root], authorize: async () => ({ release: async () => {} }) })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    const missing = CcaPolicy.toPathUri(path.join(root, "missing.txt"))
    for (const operation of [
      () => executor.readFile({ path: missing }, handlerCtx),
      () => executor.getMetadata({ path: missing }, handlerCtx),
      () => executor.readDirectory({ path: missing }, handlerCtx),
      () => executor.canonicalize({ path: missing }, handlerCtx),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: -32004, message: "No such file or directory (os error 2)" })
    }

    await expect(executor.readFile({ path: CcaPolicy.toPathUri(root) }, handlerCtx)).rejects.toMatchObject({
      code: -32600,
      message: "Path is not a file",
    })

    const file = path.join(root, "plain.txt")
    await fsWriteFile(file, "x")
    const directory = path.join(root, "directory")
    await mkdir(directory)
    await expect(executor.readDirectory({ path: CcaPolicy.toPathUri(file) }, handlerCtx)).rejects.toMatchObject({
      code: -32603,
      message: "Not a directory (os error 20)",
    })
    await expect(executor.writeFile({ path: CcaPolicy.toPathUri(directory), dataBase64: "eA==" }, handlerCtx)).rejects.toMatchObject({
      code: -32603,
      message: "Filesystem error",
    })
    const readOnly = path.join(root, "read-only")
    await mkdir(readOnly)
    await chmod(readOnly, 0o500)
    cleanups.push(() => chmod(readOnly, 0o700))
    await expect(executor.writeFile({ path: CcaPolicy.toPathUri(path.join(readOnly, "new.txt")), dataBase64: "eA==" }, handlerCtx)).rejects.toMatchObject({
      code: -32600,
      message: "Permission denied",
    })
  })

  test("item 6: maxLiveProcesses caps concurrent live processes with -32602", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({ release: async () => {} }),
      maxLiveProcesses: 2,
    })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "p-cap-1",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    await executor.startProcess(
      {
        processId: "p-cap-2",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    try {
      await executor.startProcess(
        {
          processId: "p-cap-3",
          argv: [process.execPath, "-v"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
        handlerCtx,
      )
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err.code).toBe(-32602)
      expect(err.message).toBe("Too many processes")
    }
  })

  test("item 7: seq semantics buffer exit until stdio close so chunk seq < exited seq", async () => {
    const root = await makeTestRoot()
    const notifications: Array<{ method: string; params: any }> = []
    const executor = createFixedExecutor({ roots: [root], authorize: async () => ({ release: async () => {} }) })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize(
      { clientName: "test" },
      {
        signal: new AbortController().signal,
        notify: (method, params) => {
          notifications.push({ method, params })
        },
      },
    )
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "fast-seq-p",
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('first\\n'); process.stdout.write('second\\n'); process.exit(0);",
        ],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )

    let readRes = await executor.readProcess({ processId: "fast-seq-p", waitMs: 1000 }, handlerCtx)
    while (!readRes.closed) {
      readRes = await executor.readProcess(
        { processId: "fast-seq-p", afterSeq: readRes.nextSeq - 1, waitMs: 1000 },
        handlerCtx,
      )
    }

    const outputNotifs = notifications.filter((n) => n.method === "process/output")
    const exitedNotif = notifications.find((n) => n.method === "process/exited")
    const closedNotif = notifications.find((n) => n.method === "process/closed")

    expect(outputNotifs.length).toBeGreaterThan(0)
    expect(exitedNotif).toBeDefined()
    expect(closedNotif).toBeDefined()

    for (const out of outputNotifs) {
      expect(out.params.seq).toBeLessThan(exitedNotif!.params.seq)
    }
    expect(exitedNotif!.params.seq).toBeLessThan(closedNotif!.params.seq)
  })

  test("item 13: readProcess authorizes and notify routes per session", async () => {
    const root = await makeTestRoot()
    const authCalls: any[] = []
    const notifsA: any[] = []
    const notifsB: any[] = []

    const executor = createFixedExecutor({
      roots: [root],
      authorize: async (input) => {
        authCalls.push(input)
        return { release: async () => {} }
      },
    })
    cleanups.push(() => executor.close())

    const initA = await executor.initialize(
      { clientName: "client-A" },
      { signal: new AbortController().signal, notify: (m, p) => { notifsA.push({ m, p }) } },
    )
    const initB = await executor.initialize(
      { clientName: "client-B" },
      { signal: new AbortController().signal, notify: (m, p) => { notifsB.push({ m, p }) } },
    )

    const ctxA = { signal: new AbortController().signal, sessionId: initA.sessionId }

    await executor.startProcess(
      {
        processId: "session-a-proc",
        argv: [process.execPath, "-e", "process.stdout.write('A\\n'); process.exit(0);"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      ctxA,
    )

    authCalls.length = 0
    await executor.readProcess({ processId: "session-a-proc", waitMs: 1000 }, ctxA)
    expect(authCalls.some((c) => c.action === "read" && c.resources[0] === "session-a-proc")).toBe(true)

    expect(notifsA.some((n) => n.m === "process/output")).toBe(true)
    expect(notifsB).toHaveLength(0)
  })


  function makeGrantTracker() {
    const grants: Array<{ action: string; resources: readonly string[]; releases: number }> = []
    const authorize = async (input: {
      action: string
      resources: readonly string[]
      metadata?: Readonly<Record<string, string>>
    }) => {
      const record = { action: input.action, resources: input.resources, releases: 0 }
      grants.push(record)
      return {
        release: async () => {
          record.releases++
        },
      }
    }
    return { grants, authorize }
  }

  const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  test("grant: fs success and post-authorize fs failure each release exactly once", async () => {
    const root = await makeTestRoot()
    const { grants, authorize } = makeGrantTracker()
    const executor = createFixedExecutor({ roots: [root], authorize })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.writeFile(
      {
        path: CcaPolicy.toPathUri(path.join(root, "g.txt")),
        dataBase64: Buffer.from("x").toString("base64"),
      },
      handlerCtx,
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]!.releases).toBe(1)

    await expect(executor.readFile({ path: CcaPolicy.toPathUri(root) }, handlerCtx)).rejects.toThrow()
    expect(grants).toHaveLength(2)
    expect(grants[1]!.releases).toBe(1)
  })

  test("grant: readProcess holds grant while waiting, releases once when read returns", async () => {
    const root = await makeTestRoot()
    const { grants, authorize } = makeGrantTracker()
    const executor = createFixedExecutor({ roots: [root], authorize })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "g-read-p",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )
    const startGrant = grants[0]!
    expect(startGrant.releases).toBe(0)

    const readPromise = executor.readProcess({ processId: "g-read-p", waitMs: 5000 }, handlerCtx)
    await flushAsync()
    const readGrant = grants.find((g) => g.action === "read")!
    expect(readGrant).toBeDefined()
    expect(readGrant.releases).toBe(0)

    await executor.terminateProcess({ processId: "g-read-p" }, handlerCtx)
    const readRes = await readPromise
    expect(readRes).toBeDefined()
    expect(readGrant.releases).toBe(1)

    for (let i = 0; i < 50 && startGrant.releases === 0; i++) {
      await executor.readProcess({ processId: "g-read-p", waitMs: 100 }, handlerCtx).catch(() => undefined)
      await flushAsync()
    }
    expect(startGrant.releases).toBe(1)
  })

  test("grant: write grant releases after write while start grant still held; exit releases start grant once", async () => {
    const root = await makeTestRoot()
    const { grants, authorize } = makeGrantTracker()
    const executor = createFixedExecutor({ roots: [root], authorize })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await executor.startProcess(
      {
        processId: "g-write-p",
        argv: [
          process.execPath,
          "-e",
          "process.stdin.on('data',(d)=>process.stdout.write(d)); process.stdin.on('end',()=>process.exit(0));",
        ],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
        pipeStdin: true,
      },
      handlerCtx,
    )
    const startGrant = grants[0]!

    const fullText = "echo this full stdin text"
    await executor.writeProcess(
      { processId: "g-write-p", chunk: Buffer.from(fullText).toString("base64"), writeId: "g-w1" },
      handlerCtx,
    )
    const writeGrant = grants[1]!
    expect(writeGrant.resources).toEqual(["g-write-p", fullText])
    expect(writeGrant.releases).toBe(1)
    expect(startGrant.releases).toBe(0)

    await executor.terminateProcess({ processId: "g-write-p" }, handlerCtx)
    for (let i = 0; i < 50 && startGrant.releases === 0; i++) {
      await executor.readProcess({ processId: "g-write-p", waitMs: 100 }, handlerCtx).catch(() => undefined)
      await flushAsync()
    }
    expect(startGrant.releases).toBe(1)
  })

  test("grant: spawn failure and post-authorize prep failure release start grant once", async () => {
    const root = await makeTestRoot()
    const { grants, authorize } = makeGrantTracker()
    const executor = createFixedExecutor({ roots: [root], authorize })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    await expect(
      executor.startProcess(
        {
          processId: "g-bad-spawn",
          argv: ["/nonexistent/binary/path/that/cannot/exist"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
        handlerCtx,
      ),
    ).rejects.toThrow()
    expect(grants).toHaveLength(1)
    expect(grants[0]!.releases).toBe(1)

    await expect(
      executor.startProcess(
        {
          processId: "g-bad-env",
          argv: [process.execPath, "-v"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
          envPolicy: { inherit: true },
        },
        handlerCtx,
      ),
    ).rejects.toThrow()
    expect(grants).toHaveLength(2)
    expect(grants[1]!.releases).toBe(1)
  })

  test("grant: close() during pending start releases once and close awaits teardown of running process", async () => {
    const root = await makeTestRoot()
    let releaseAuth!: () => void
    const authGate = new Promise<void>((r) => {
      releaseAuth = r
    })
    const records: Array<{ releases: number }> = []
    let callCount = 0
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => {
        callCount++
        if (callCount === 1) await authGate
        const record = { releases: 0 }
        records.push(record)
        return {
          release: async () => {
            record.releases++
          },
        }
      },
    })
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    const startPromise = executor.startProcess(
      {
        processId: "g-midstart",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )
    const closePromise = executor.close()
    releaseAuth()
    await expect(startPromise).rejects.toThrow()
    await closePromise
    expect(records).toHaveLength(1)
    expect(records[0]!.releases).toBe(1)

    const root2 = await makeTestRoot()
    const { grants, authorize } = makeGrantTracker()
    const executor2 = createFixedExecutor({ roots: [root2], authorize })
    const init2 = await executor2.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const ctx2 = { signal: new AbortController().signal, sessionId: init2.sessionId }
    await executor2.startProcess(
      {
        processId: "g-close-running",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: CcaPolicy.toPathUri(root2),
        env: {},
      },
      ctx2,
    )
    expect(grants[0]!.releases).toBe(0)
    await executor2.close()
    expect(grants[0]!.releases).toBe(1)
  })

  test("grant: release failure after successful fs op surfaces sanitized, never raw", async () => {
    const root = await makeTestRoot()
    let releaseThrows = false
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => ({
        release: async () => {
          if (releaseThrows) throw new Error("release-boom-raw-detail")
        },
      }),
    })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    const target = CcaPolicy.toPathUri(path.join(root, "g2.txt"))
    await executor.writeFile({ path: target, dataBase64: Buffer.from("y").toString("base64") }, handlerCtx)

    releaseThrows = true
    try {
      await executor.readFile({ path: target }, handlerCtx)
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect(err.code).toBe(-32603)
      expect(err.message).not.toContain("release-boom")
    }
  })

  test("grant: authorizer returning no grant is denied, not silently allowed", async () => {
    const root = await makeTestRoot()
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async () => undefined as never,
    })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    try {
      await executor.writeFile(
        {
          path: CcaPolicy.toPathUri(path.join(root, "never.txt")),
          dataBase64: Buffer.from("z").toString("base64"),
        },
        handlerCtx,
      )
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect(err.code).toBe(-32001)
    }
  })

  test("start authorize resource carries the full untruncated argv", async () => {
    const root = await makeTestRoot()
    const { grants, authorize } = makeGrantTracker()
    const executor = createFixedExecutor({ roots: [root], authorize })
    cleanups.push(() => executor.close())
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    const longArg = `${"a".repeat(5000)}TAILMARKER`
    await executor.startProcess(
      {
        processId: "g-long-argv",
        argv: [process.execPath, "-e", "process.exit(0)", longArg],
        cwd: CcaPolicy.toPathUri(root),
        env: {},
      },
      handlerCtx,
    )
    expect(grants[0]!.resources[0]!.length).toBeGreaterThan(4096)
    expect(grants[0]!.resources[0]).toContain("TAILMARKER")
  })

  test("grant: release failure on entries evicted by retention pruning still surfaces at close()", async () => {
    const root = await makeTestRoot()
    let startGrantCount = 0
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async (input) => {
        const isStart = input.metadata?.cwd !== undefined
        const failRelease = isStart && ++startGrantCount <= 3
        return {
          release: async () => {
            if (failRelease) throw new Error("evicted-release-failure-raw")
          },
        }
      },
    })
    const initRes = await executor.initialize({ clientName: "test" }, { signal: new AbortController().signal })
    const handlerCtx = { signal: new AbortController().signal, sessionId: initRes.sessionId }

    for (let i = 0; i < 30; i++) {
      const processId = `evict-p-${i}`
      await executor.startProcess(
        {
          processId,
          argv: [process.execPath, "-e", "process.exit(0)"],
          cwd: CcaPolicy.toPathUri(root),
          env: {},
        },
        handlerCtx,
      )
      let readRes = await executor.readProcess({ processId, waitMs: 1000 }, handlerCtx)
      for (let j = 0; j < 20 && !readRes.closed; j++) {
        readRes = await executor.readProcess(
          { processId, afterSeq: readRes.nextSeq - 1, waitMs: 1000 },
          handlerCtx,
        )
      }
      expect(readRes.closed).toBe(true)
      await flushAsync()
    }

    try {
      await executor.close()
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err).toBeInstanceOf(CcaExecutorError)
      expect(err.code).toBe(-32603)
      expect(err.message).not.toContain("evicted-release-failure")
    }
  })
})
describe("CcaExecutor upstream sandbox requests", () => {
  const uri = (native: string) => CcaPolicy.toPathUri(native)
  const pathEntry = (native: string, access: string) => ({ path: { type: "path", path: uri(native) }, access })
  const managed = (entries: unknown[], network = "restricted") => ({
    type: "managed",
    file_system: { type: "restricted", entries },
    network,
  })
  const sandboxFor = (cwd: string, permissions: unknown, extra: Record<string, unknown> = {}) => ({
    permissions,
    cwd: uri(cwd),
    workspaceRoots: [uri(cwd)],
    useLegacyLandlock: false,
    ...extra,
  })

  async function setup(decide: (input: CcaAuthorizationInput) => boolean = () => true) {
    const root = await makeTestRoot()
    const calls: CcaAuthorizationInput[] = []
    const notifications: Array<{ method: string; params: any }> = []
    let spawns = 0
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async (input) => {
        calls.push(input)
        if (!decide(input)) throw new Error("synthetic denial")
        return { release: async () => {} }
      },
      spawnImpl: ((...args: Parameters<typeof spawn>) => {
        spawns++
        return spawn(...args)
      }) as typeof spawn,
    })
    cleanups.push(() => executor.close())
    const init = await executor.initialize(
      { clientName: "sandbox" },
      { signal: new AbortController().signal, notify: (method, params) => void notifications.push({ method, params }) },
    )
    const ctx = { signal: new AbortController().signal, sessionId: init.sessionId }
    return { root, executor, ctx, calls, notifications, spawns: () => spawns }
  }

  async function drain(executor: CcaExecutorHandler, ctx: { signal: AbortSignal; sessionId: string }, processId: string) {
    let afterSeq = 0
    let text = ""
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await executor.readProcess({ processId, afterSeq, waitMs: 500 }, ctx)
      text += result.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8")).join("")
      afterSeq = result.nextSeq - 1
      if (result.closed) return { ...result, text }
    }
    throw new Error("process did not close")
  }

  const printf = (root: string, processId: string) => ({
    processId,
    argv: [process.execPath, "-e", "process.stdout.write('hello')"],
    cwd: uri(root),
    env: {},
    tty: false,
    pipeStdin: false,
  })

  test("a sandboxed start that YCoding policy allows runs and reports the requested restrictions to authorization", async () => {
    const { root, executor, ctx, calls } = await setup()
    const result = await executor.startProcess(
      { ...printf(root, "sandboxed"), sandbox: sandboxFor(root, managed([pathEntry(root, "write")])), enforceManagedNetwork: true },
      ctx,
    )
    expect(result).toEqual({ processId: "sandboxed", sandboxType: "none" })
    const finished = await drain(executor, ctx, "sandboxed")
    expect(finished.text).toBe("hello")
    expect(finished.exitCode).toBe(0)
    expect(finished.sandboxDenied).toBe(false)
    const shell = calls.find((call) => call.action === "shell")!
    expect(shell.resources).toEqual([`${process.execPath} -e process.stdout.write('hello')`])
    expect(shell.metadata).toEqual({ cwd: root, workdir: root })
  })

  test("a YCoding denial of a sandboxed start answers with upstream sandbox-denial semantics", async () => {
    const { root, executor, ctx, calls, notifications, spawns } = await setup((input) => input.action !== "shell" || input.metadata?.cwd === undefined)
    const result = await executor.startProcess(
      { ...printf(root, "denied"), sandbox: sandboxFor(root, managed([pathEntry(root, "write")])) },
      ctx,
    )
    expect(result).toEqual({ processId: "denied", sandboxType: "none" })
    expect(calls.map((call) => call.action)).toEqual(["shell"])
    expect(calls[0]!.metadata).toEqual({ cwd: root, workdir: root })
    expect(spawns()).toBe(0)

    const read = await executor.readProcess({ processId: "denied", afterSeq: 0 }, ctx)
    expect(read).toMatchObject({ nextSeq: 4, exited: true, exitCode: 1, closed: true, failure: null, sandboxDenied: true })
    expect(read.chunks).toHaveLength(1)
    expect(read.chunks[0]).toMatchObject({ seq: 1, stream: "stderr" })
    const stderr = Buffer.from(read.chunks[0]!.chunk, "base64").toString("utf8").toLowerCase()
    expect(stderr).toContain("sandbox")
    expect(stderr).toContain("permission denied")

    await new Promise((resolve) => setTimeout(resolve, 20))
    const events = notifications.filter((event) => event.params?.processId === "denied")
    expect(events.map((event) => [event.method, event.params.seq])).toEqual([
      ["process/output", 1],
      ["process/exited", 2],
      ["process/closed", 3],
    ])
    expect(events[0]!.params.stream).toBe("stderr")
    expect(events[1]!.params).toEqual({ processId: "denied", seq: 2, exitCode: 1, sandboxDenied: true })

    expect(await executor.writeProcess({ processId: "denied", chunk: "", writeId: "w" }, ctx)).toEqual({ status: "stdinClosed" })
    expect(await executor.terminateProcess({ processId: "denied" }, ctx)).toEqual({ running: false })
    expect(await executor.signalProcess({ processId: "denied", signal: "interrupt" }, ctx)).toEqual({})
  })

  test("a cwd the requested profile cannot read is a sandbox denial before authorization", async () => {
    const { root, executor, ctx, calls, spawns } = await setup()
    const allowed = path.join(root, "allowed")
    await mkdir(allowed)
    await executor.startProcess(
      { ...printf(root, "cwd-denied"), sandbox: sandboxFor(allowed, managed([pathEntry(allowed, "write")])) },
      ctx,
    )
    const finished = await drain(executor, ctx, "cwd-denied")
    expect(finished.sandboxDenied).toBe(true)
    expect(finished.exitCode).toBe(1)
    expect(calls.filter((call) => call.action === "shell")).toHaveLength(0)
    expect(spawns()).toBe(0)
  })

  test("a sandbox workspace outside the Location roots becomes the start's root behind an external-directory approval", async () => {
    const { executor, ctx, calls } = await setup()
    const outside = await makeTestRoot()
    const elsewhere = await makeTestRoot()
    const sandbox = sandboxFor(outside, managed([pathEntry(outside, "write")]))
    await executor.startProcess({ ...printf(outside, "outside-sandboxed"), sandbox }, ctx)
    expect((await drain(executor, ctx, "outside-sandboxed")).sandboxDenied).toBe(false)
    expect(calls.slice(0, 2).map((call) => call.action)).toEqual(["external_directory", "shell"])
    expect(calls[0]).toMatchObject({ resources: [`${outside}/*`], metadata: { filepath: outside, parentDir: outside } })
    expect(calls[0]!.metadata).not.toHaveProperty("sandboxProfile")
    await executor.startProcess({ ...printf(elsewhere, "elsewhere-sandboxed"), sandbox }, ctx)
    expect((await drain(executor, ctx, "elsewhere-sandboxed")).sandboxDenied).toBe(true)
    await expect(executor.startProcess(printf(outside, "outside-plain"), ctx)).rejects.toMatchObject({ code: -32600, message: "Operation not permitted (os error 1)" })
    expect(calls.filter((call) => call.action === "shell")).toHaveLength(1)
  })

  test("a denied external-directory approval for a sandbox workspace is a sandbox denial", async () => {
    const { executor, ctx, calls } = await setup((input) => input.action !== "external_directory")
    const outside = await makeTestRoot()
    const sandbox = sandboxFor(outside, managed([pathEntry(outside, "write")]))
    await executor.startProcess({ ...printf(outside, "outside-denied"), sandbox }, ctx)
    expect(calls.map((call) => call.action)).toEqual(["external_directory"])
    expect((await drain(executor, ctx, "outside-denied")).sandboxDenied).toBe(true)
  })

  test("a shellSnapshot for an unsupported shell and a disabled network proxy launch are -32602 and spawn nothing", async () => {
    const { root, executor, ctx, spawns } = await setup()
    await expect(executor.startProcess({
      ...printf(root, "fish-snapshot"),
      argv: ["/usr/bin/fish", "-lc", "true"],
      shellSnapshot: { scopeId: "synthetic-scope", shell: { name: "fish", path: "/usr/bin/fish" } },
    }, ctx)).rejects.toMatchObject({ code: -32602, message: "shell snapshots are unsupported for shell `fish`" })
    await expect(executor.startProcess({
      ...printf(root, "disabled-proxy"),
      networkProxy: {
        proxy: {
          enabled: false,
          credentialMasking: false,
          credentialProviders: {},
          enableSocks5: false,
          enableSocks5Udp: false,
          allowUpstreamProxy: false,
          dangerouslyAllowAllUnixSockets: false,
          mode: "limited",
          reviewDomains: [],
          allowLocalBinding: false,
        },
        auditMetadata: {},
      },
    }, ctx)).rejects.toMatchObject({ code: -32602, message: "invalid network proxy config: executor-local network proxy launch requires an enabled proxy" })
    expect(spawns()).toBe(0)
  })

  test("unsandboxed and bypass escalations keep the local -32001 authorization denial", async () => {
    const { root, executor, ctx, calls } = await setup((input) => input.action !== "shell")
    await expect(executor.startProcess(printf(root, "plain"), ctx)).rejects.toMatchObject({ code: -32001 })
    const disabled = sandboxFor(root, { type: "disabled" })
    await expect(executor.startProcess({ ...printf(root, "disabled"), sandbox: disabled }, ctx)).rejects.toMatchObject({ code: -32001 })
    const bypass = sandboxFor(root, managed([]), { sandboxOverride: "bypassSandboxFirstAttempt" })
    await expect(executor.startProcess({ ...printf(root, "bypass"), sandbox: bypass }, ctx)).rejects.toMatchObject({ code: -32001 })
    expect(calls.at(-1)?.metadata).toEqual({ cwd: root, workdir: root })
  })

  test("malformed sandbox, managed-network, or proxy shapes are -32602 before authorization", async () => {
    const { root, executor, ctx, calls } = await setup()
    for (const intent of [{ sandbox: {} }, { managedNetwork: {} }]) {
      await expect(executor.startProcess({ ...printf(root, "malformed"), ...intent }, ctx)).rejects.toMatchObject({ code: -32602 })
      await expect(executor.readFile({ path: uri(root), sandbox: (intent as any).sandbox ?? {} }, ctx)).rejects.toMatchObject({ code: -32602 })
    }
    expect(calls).toHaveLength(0)
  })

  test("filesystem calls enforce the requested profile exactly and report denials as upstream permission errors", async () => {
    const { root, executor, ctx, calls } = await setup((input) => !input.resources.some((resource) => resource.endsWith("guarded.txt")))
    const readOnly = path.join(root, "read-only")
    const writable = path.join(root, "writable")
    await mkdir(readOnly)
    await mkdir(writable)
    await fsWriteFile(path.join(readOnly, "a.txt"), "a")
    await fsWriteFile(path.join(readOnly, "prod.env"), "secret")
    const sandbox = sandboxFor(root, managed([
      pathEntry(readOnly, "read"),
      pathEntry(writable, "write"),
      { path: { type: "glob_pattern", pattern: "**/*.env" }, access: "deny" },
    ]))
    const data = Buffer.from("x").toString("base64")

    expect(await executor.readFile({ path: uri(path.join(readOnly, "a.txt")), sandbox }, ctx)).toEqual({
      dataBase64: Buffer.from("a").toString("base64"),
    })
    expect(await executor.writeFile({ path: uri(path.join(writable, "new.txt")), dataBase64: data, sandbox }, ctx)).toEqual({})

    const before = calls.length
    for (const denied of [
      () => executor.writeFile({ path: uri(path.join(readOnly, "b.txt")), dataBase64: data, sandbox }, ctx),
      () => executor.readFile({ path: uri(path.join(readOnly, "prod.env")), sandbox }, ctx),
      () => executor.readDirectory({ path: uri(root), sandbox }, ctx),
    ]) {
      await expect(denied()).rejects.toMatchObject({ code: -32600, message: "Permission denied" })
    }
    expect(calls.length).toBe(before)
    await expect(stat(path.join(readOnly, "b.txt"))).rejects.toMatchObject({ code: "ENOENT" })

    await expect(
      executor.writeFile({ path: uri(path.join(writable, "guarded.txt")), dataBase64: data, sandbox }, ctx),
    ).rejects.toMatchObject({ code: -32600, message: "Permission denied" })
    await expect(executor.writeFile({ path: uri(path.join(writable, "guarded.txt")), dataBase64: data }, ctx)).rejects.toMatchObject({
      code: -32001,
    })

    const outside = await makeTestRoot()
    await expect(executor.getMetadata({ path: uri(outside), sandbox }, ctx)).rejects.toMatchObject({
      code: -32600,
      message: "Permission denied",
    })
    await expect(executor.getMetadata({ path: uri(path.join(writable, "missing.txt")), sandbox }, ctx)).rejects.toMatchObject({
      code: -32004,
    })
    expect(calls.find((call) => call.action === "edit")?.metadata).toBeUndefined()
  })

  test("filesystem sandboxes with project roots require a policy cwd", async () => {
    const { root, executor, ctx } = await setup()
    const sandbox = { permissions: managed([{ path: { type: "special", value: { kind: "project_roots" } }, access: "read" }]) }
    await expect(executor.getMetadata({ path: uri(root), sandbox }, ctx)).rejects.toMatchObject({
      code: -32602,
      message: "file system sandbox context with dynamic permissions requires cwd",
    })
  })
})

describe("CcaExecutor shell-wrapper authorization", () => {
  async function denyingExecutor(roots: string[]) {
    const calls: CcaAuthorizationInput[] = []
    let spawns = 0
    const executor = createFixedExecutor({
      roots,
      authorize: async (input) => {
        calls.push(input)
        throw new Error("synthetic denial")
      },
      spawnImpl: ((...args: Parameters<typeof spawn>) => {
        spawns++
        return spawn(...args)
      }) as typeof spawn,
    })
    cleanups.push(() => executor.close())
    const init = await executor.initialize({ clientName: "wrapper" }, { signal: new AbortController().signal })
    const ctx = { signal: new AbortController().signal, sessionId: init.sessionId }
    const start = async (processId: string, argv: string[], cwd: string) => {
      await expect(executor.startProcess({ processId, argv, cwd: CcaPolicy.toPathUri(cwd), env: {} }, ctx)).rejects.toMatchObject({ code: -32001 })
      const shell = calls.filter((call) => call.action === "shell").at(-1)
      if (shell === undefined) throw new Error("no shell authorization")
      return shell
    }
    return { start, spawns: () => spawns }
  }

  const review = (input: { readonly action: string; readonly resources: readonly string[]; readonly metadata?: Readonly<Record<string, string>> }, project: string, home: string) =>
    SessionGuardrailMatch.evaluate({
      action: input.action,
      resources: input.resources,
      paths: {
        workdir: typeof input.metadata?.workdir === "string" ? input.metadata.workdir : project,
        project,
        home,
        tmpdir: process.env.TMPDIR,
      },
    })

  test("a /bin/zsh -lc, bash -c, or sh -ic wrapper is authorized as its script and reaches the same Guardrail review as the direct shell command", async () => {
    const project = await makeTestRoot()
    const home = await makeTestRoot()
    await mkdir(path.join(home, "child"))
    await fsWriteFile(path.join(home, "child", "keep.txt"), "synthetic")
    const { start, spawns } = await denyingExecutor([project, home])
    const cases = [
      { argv: ["/bin/zsh", "-lc", `rm -rf ${path.join(home, "child")}`], cwd: project },
      { argv: ["/bin/bash", "-c", "rm -rf child"], cwd: home },
      { argv: ["/bin/sh", "-ic", `echo synthetic && rm -rf ${path.join(home, "child")}`], cwd: project },
    ]
    for (const [index, { argv, cwd }] of cases.entries()) {
      const recorded = await start(`wrapper-${index}`, argv, cwd)
      expect(recorded.resources).toEqual([argv[2]])
      expect(recorded.metadata).toMatchObject({ argv: JSON.stringify(argv), workdir: cwd, cwd })
      const direct = review({ action: "shell", resources: [argv[2]], metadata: { workdir: cwd } }, project, home)
      expect(direct).toMatchObject({ decision: "ask", ruleIDs: ["standard.review.home-child"], hardReview: true })
      expect(review(recorded, project, home)).toEqual(direct)
    }
    expect(spawns()).toBe(0)
    expect(await stat(path.join(home, "child", "keep.txt"))).toBeTruthy()
  })

  test("argv that is not a recognized shell wrapper is authorized as its joined argv, as before", async () => {
    const project = await makeTestRoot()
    const { start } = await denyingExecutor([project])
    for (const [index, argv] of [
      [process.execPath, "-e", "process.stdout.write('synthetic')"],
      ["/bin/zsh", "-lc", "echo synthetic", "extra"],
      ["/bin/zsh", "-x", "echo synthetic"],
      ["/usr/local/bin/fish", "-c", "echo synthetic"],
      ["/bin/bash"],
    ].entries()) {
      const recorded = await start(`plain-${index}`, argv, project)
      expect(recorded.resources).toEqual([argv.join(" ")])
      expect(recorded.metadata?.argv).toBeUndefined()
    }
  })
})

describe("CcaExecutor thread scopes", () => {
  const scopeHarness = async () => {
    const threadRoot = await makeTestRoot()
    const unattributedRoot = await makeTestRoot()
    const outside = await makeTestRoot()
    const calls: Array<{ readonly scope: string; readonly input: CcaAuthorizationInput }> = []
    const requested: unknown[] = []
    const closed: string[] = []
    const scope = (name: string, roots: readonly string[]): CcaExecutorScope => ({
      sessionID: `ses_${name}`,
      roots,
      authorization: { authorize: async (input) => { calls.push({ scope: name, input }); return { release: async () => {} } } },
      close: async () => { closed.push(name) },
    })
    const executor = createCcaExecutor({
      scopeFor: async (attribution, ctx) => {
        requested.push({ attribution, sessionId: ctx.sessionId })
        return attribution?.threadId === "thread-a" ? scope("thread-a", [threadRoot]) : scope("unattributed", [unattributedRoot])
      },
      answerProcess: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })
    cleanups.push(() => executor.close())
    const initialized = await executor.initialize({ clientName: "scope-test" }, { signal: new AbortController().signal })
    const ctx = { signal: new AbortController().signal, sessionId: initialized.sessionId }
    await fsWriteFile(path.join(threadRoot, "inside.txt"), "synthetic")
    await fsWriteFile(path.join(outside, "outside.txt"), "synthetic")
    const bind = () => executor.startProcess({
      processId: "bind", argv: ["/bin/sh", "-lc", "true"], cwd: CcaPolicy.toPathUri(threadRoot), env: {},
      metadata: { threadId: "thread-a", toolCallId: "call-1" },
    }, ctx)
    return { executor, ctx, threadRoot, outside, calls, requested, closed, bind }
  }

  test("roots follow the scope bound to the exec-server session", async () => {
    const h = await scopeHarness()
    const inside = CcaPolicy.toPathUri(path.join(h.threadRoot, "inside.txt"))
    await expect(h.executor.readFile({ path: inside }, h.ctx)).rejects.toMatchObject({ code: -32600, message: "Operation not permitted (os error 1)" })
    expect(h.calls).toEqual([])
    await h.bind()
    await h.executor.readFile({ path: inside }, h.ctx)
    expect(h.calls.map((call) => [call.scope, call.input.action])).toEqual([["thread-a", "shell"], ["thread-a", "read"]])
    expect(h.requested).toEqual([
      { attribution: undefined, sessionId: h.ctx.sessionId },
      { attribution: { threadId: "thread-a", toolCallId: "call-1" }, sessionId: h.ctx.sessionId },
    ])
    await h.executor.close()
    expect(h.closed.sort()).toEqual(["thread-a", "unattributed"])
  })

  test("an outside path asks external_directory against the thread scope", async () => {
    const h = await scopeHarness()
    await h.bind()
    h.calls.length = 0
    const sandbox = {
      permissions: { type: "managed", file_system: { type: "restricted", entries: [{ path: { type: "path", path: CcaPolicy.toPathUri(h.outside) }, access: "read" }] }, network: "restricted" },
      cwd: CcaPolicy.toPathUri(h.outside),
      workspaceRoots: [CcaPolicy.toPathUri(h.outside)],
      useLegacyLandlock: false,
    }
    await h.executor.readFile({ path: CcaPolicy.toPathUri(path.join(h.outside, "outside.txt")), sandbox }, h.ctx)
    expect(h.calls.map((call) => [call.scope, call.input.action, call.input.resources])).toEqual([
      ["thread-a", "external_directory", [path.join(h.outside, "*")]],
      ["thread-a", "read", [path.join(h.outside, "outside.txt")]],
    ])
  })
})

describe("CcaExecutor refusals", () => {
  const uri = (native: string) => CcaPolicy.toPathUri(native)
  const open: CcaPendingDecision = {
    kind: "permission", sessionID: "ses_synthetic", itemID: "rvw_synthetic", action: "shell", resources: ["echo synthetic"], hardReview: false, state: "open",
  }
  const decide = (kind: string, reply: string) =>
    `ycoding api session.review.decide --param sessionID=ses_synthetic --param itemID=rvw_synthetic -d '{"decision":{"kind":"${kind}","reply":"${reply}"}}'`
  const openText = [
    "YCoding did not run this: it needs the user's decision.",
    "Review item rvw_synthetic in Session ses_synthetic: permission shell echo synthetic.",
    "Ask the user in this chat, record the answer, then retry the identical action.",
    ` approve once:   ${decide("permission", "once")}`,
    ` approve always: ${decide("permission", "always")}`,
    ` reject:         ${decide("permission", "reject")}`,
  ].join("\n")

  const refusingExecutor = async (refuse: (input: CcaAuthorizationInput) => CcaAuthorizationDeniedError | undefined) => {
    const root = await makeTestRoot()
    const calls: CcaAuthorizationInput[] = []
    const spawned: string[] = []
    const executor = createFixedExecutor({
      roots: [root],
      authorize: async (input) => {
        calls.push(input)
        const refusal = refuse(input)
        if (refusal) throw refusal
        return { release: async () => {} }
      },
      spawnImpl: ((command: string, args: readonly string[], options: object) => {
        spawned.push(command)
        return spawn(command, args, options)
      }) as typeof spawn,
    })
    cleanups.push(() => executor.close())
    const notifications: Array<{ method: string; params: unknown }> = []
    const initialized = await executor.initialize({ clientName: "refusal-test" }, {
      signal: new AbortController().signal,
      notify: (method, params) => { notifications.push({ method, params }) },
    })
    return { root, executor, calls, spawned, notifications, ctx: { signal: new AbortController().signal, sessionId: initialized.sessionId } }
  }

  test("refusal texts are exact for open, hard-review, rejected, full and busy", () => {
    expect(ccaRefusalText({ pending: [open] })).toBe(openText)
    expect(ccaRefusalText({ pending: [{ ...open, kind: "guardrail", hardReview: true }] })).toBe([
      "YCoding did not run this: it needs the user's decision.",
      "Review item rvw_synthetic in Session ses_synthetic: guardrail shell echo synthetic.",
      "Ask the user in this chat, record the answer, then retry the identical action.",
      ` approve once:   ${decide("guardrail", "once")}`,
      ` reject:         ${decide("guardrail", "reject")}`,
    ].join("\n"))
    const guardrailOnce = [
      "YCoding did not run this: it needs the user's decision.",
      "Review item rvw_synthetic in Session ses_synthetic: guardrail shell echo synthetic.",
      "Ask the user in this chat, record the answer, then retry the identical action.",
      ` approve once:   ${decide("guardrail", "once")}`,
      ` reject:         ${decide("guardrail", "reject")}`,
    ].join("\n")
    expect(ccaRefusalText({ pending: [{ ...open, kind: "guardrail" }] })).toBe(guardrailOnce)
    expect(ccaRefusalText({ pending: [{ ...open, kind: "guardrail", directories: [] }] })).toBe(guardrailOnce)
    expect(ccaRefusalText({ pending: [{ ...open, kind: "guardrail", directories: ["/synthetic/outside"] }] })).toBe([
      "YCoding did not run this: it needs the user's decision.",
      "Review item rvw_synthetic in Session ses_synthetic: guardrail shell echo synthetic.",
      "Ask the user in this chat, record the answer, then retry the identical action.",
      ` approve once:   ${decide("guardrail", "once")}`,
      ` approve always: ${decide("guardrail", "always")}`,
      ` reject:         ${decide("guardrail", "reject")}`,
    ].join("\n"))
    expect(ccaRefusalText({ pending: [{ ...open, kind: "guardrail", hardReview: true, directories: ["/synthetic/outside"] }] })).toBe(guardrailOnce)
    expect(ccaRefusalText({ pending: [{ ...open, state: "rejected" }] })).toBe("YCoding did not run this: the user rejected review item rvw_synthetic. Do not retry it.")
    const { itemID: _, ...full } = open
    expect(ccaRefusalText({ pending: [{ ...full, state: "full" }] })).toBe("YCoding did not run this: the review box is full. Run ycoding decision list and decide or clear items first.")
    const guardrail = { ...open, kind: "guardrail" as const, itemID: "rvw_guardrail", hardReview: true }
    const decideGuardrail = (reply: string) =>
      `ycoding api session.review.decide --param sessionID=ses_synthetic --param itemID=rvw_guardrail -d '{"decision":{"kind":"guardrail","reply":"${reply}"}}'`
    expect(ccaRefusalText({ pending: [open, guardrail] })).toBe([
      "YCoding did not run this: it needs the user's decision.",
      "Review item rvw_synthetic in Session ses_synthetic: permission shell echo synthetic.",
      "Review item rvw_guardrail in Session ses_synthetic: guardrail shell echo synthetic.",
      "Ask the user in this chat, record the answer, then retry the identical action.",
      ` approve once:   ${decide("permission", "once")}`,
      ` approve always: ${decide("permission", "always")}`,
      ` reject:         ${decide("permission", "reject")}`,
      ` approve once:   ${decideGuardrail("once")}`,
      ` reject:         ${decideGuardrail("reject")}`,
    ].join("\n"))
    expect(ccaRefusalText({ pending: [open, { ...guardrail, state: "rejected" }] }))
      .toBe("YCoding did not run this: the user rejected review item rvw_guardrail. Do not retry it.")
    expect(ccaRefusalText({ busy: true })).toBe(CCA_BUSY_TEXT)
    expect(CCA_BUSY_TEXT).toContain("YCoding is busy; retry")
    expect(ccaRefusalText({})).toBeUndefined()
  })

  test("a refused process/start completes without spawning: stderr text, exit 1, not a sandbox denial", async () => {
    const h = await refusingExecutor((input) => input.action === "shell" ? new CcaAuthorizationDeniedError([], { pending: [open] }) : undefined)
    expect(await h.executor.startProcess({ processId: "refused", argv: ["/bin/sh", "-lc", "echo synthetic"], cwd: uri(h.root), env: {} }, h.ctx))
      .toEqual({ processId: "refused", sandboxType: "none" })
    expect(h.spawned).toEqual([])
    const read = await h.executor.readProcess({ processId: "refused" }, h.ctx)
    expect(read).toMatchObject({ exited: true, exitCode: 1, closed: true, sandboxDenied: false })
    expect(read.chunks.map((chunk) => [chunk.stream, Buffer.from(chunk.chunk, "base64").toString("utf8")])).toEqual([["stderr", `${openText}\n`]])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.notifications.map((item) => item.method)).toEqual(["process/output", "process/exited", "process/closed"])
    expect(h.notifications[1]?.params).toEqual({ processId: "refused", seq: 2, exitCode: 1, sandboxDenied: false })
  })

  test("a busy refusal of process/start reports the retry text", async () => {
    const h = await refusingExecutor((input) => input.action === "shell" ? new CcaAuthorizationDeniedError([], { busy: true }) : undefined)
    await h.executor.startProcess({ processId: "busy", argv: ["/bin/sh", "-lc", "true"], cwd: uri(h.root), env: {} }, h.ctx)
    const read = await h.executor.readProcess({ processId: "busy" }, h.ctx)
    expect(read.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8"))).toEqual([`${CCA_BUSY_TEXT}\n`])
    expect(h.spawned).toEqual([])
  })

  test("refused fs and http calls answer -32600 with the full refusal text", async () => {
    const h = await refusingExecutor(() => new CcaAuthorizationDeniedError([], { pending: [open] }))
    await fsWriteFile(path.join(h.root, "file.txt"), "synthetic")
    const message = `Permission denied: ${openText}`
    expect(message.length).toBeGreaterThan(512)
    await expect(h.executor.readFile({ path: uri(path.join(h.root, "file.txt")) }, h.ctx)).rejects.toMatchObject({ code: -32600, message })
    await expect(h.executor.writeFile({ path: uri(path.join(h.root, "new.txt")), dataBase64: "" }, h.ctx)).rejects.toMatchObject({ code: -32600, message })
    const connection = h.executor.openConnection()
    cleanups.push(() => connection.close())
    await expect(connection.fs.open({ handleId: "h1", path: uri(path.join(h.root, "file.txt")), mode: "read" }, h.ctx)).rejects.toMatchObject({ code: -32600, message })
    await expect(connection.http.request({
      method: "GET", url: "http://127.0.0.1:9/synthetic", headers: [], redirectPolicy: "follow", requestId: "r1", streamResponse: false,
    }, { signal: new AbortController().signal, emit: () => {}, sessionId: h.ctx.sessionId })).rejects.toMatchObject({ code: -32600, message })
  })

  test("a plain denial keeps -32001 Permission denied", async () => {
    const h = await refusingExecutor(() => new CcaAuthorizationDeniedError())
    await fsWriteFile(path.join(h.root, "file.txt"), "synthetic")
    await expect(h.executor.readFile({ path: uri(path.join(h.root, "file.txt")) }, h.ctx)).rejects.toMatchObject({ code: -32001, message: "Permission denied" })
    await expect(h.executor.startProcess({ processId: "denied", argv: ["/bin/sh", "-lc", "true"], cwd: uri(h.root), env: {} }, h.ctx))
      .rejects.toMatchObject({ code: -32001 })
  })

  test("every child process receives YCODING_SESSION_ID and authorization metadata carries only cwd, workdir and argv", async () => {
    const h = await refusingExecutor(() => undefined)
    const sandbox = {
      permissions: { type: "managed", file_system: { type: "restricted", entries: [{ path: { type: "path", path: uri(h.root) }, access: "write" }] }, network: "restricted" },
      cwd: uri(h.root), workspaceRoots: [uri(h.root)], useLegacyLandlock: false,
    }
    await h.executor.startProcess({
      processId: "env", argv: [process.execPath, "-e", "process.stdout.write(process.env.YCODING_SESSION_ID ?? 'missing')"],
      cwd: uri(h.root), env: { YCODING_SESSION_ID: "ses_spoofed" }, sandbox,
    }, h.ctx)
    let output = ""
    let afterSeq = 0
    for (let attempt = 0; attempt < 20; attempt++) {
      const read = await h.executor.readProcess({ processId: "env", afterSeq, waitMs: 250 }, h.ctx)
      output += read.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8")).join("")
      afterSeq = read.nextSeq - 1
      if (read.closed) break
    }
    expect(output).toBe("ses_cca_executor_test")
    await h.executor.startProcess({ processId: "wrapped", argv: ["/bin/sh", "-lc", "true"], cwd: uri(h.root), env: {}, sandbox }, h.ctx)
    await fsWriteFile(path.join(h.root, "file.txt"), "synthetic")
    await h.executor.readFile({ path: uri(path.join(h.root, "file.txt")), sandbox }, h.ctx)
    const shells = h.calls.filter((call) => call.action === "shell")
    expect(shells.map((call) => Object.keys(call.metadata ?? {}).sort())).toEqual([["cwd", "workdir"], ["argv", "cwd", "workdir"]])
    expect(h.calls.find((call) => call.action === "read")?.metadata).toBeUndefined()
  })
})

describe("CcaExecutor outside-roots reach for deferring scopes", () => {
  const outsideHarness = async (defers: boolean) => {
    const root = await makeTestRoot()
    const outside = await makeTestRoot()
    const calls: CcaAuthorizationInput[] = []
    const executor = createCcaExecutor({
      scopeFor: async () => ({
        sessionID: "ses_outside",
        roots: [root],
        authorization: { defers, authorize: async (input) => { calls.push(input); return { release: async () => {} } } },
        close: async () => {},
      }),
    })
    cleanups.push(() => executor.close())
    const initialized = await executor.initialize({ clientName: "outside-test" }, { signal: new AbortController().signal })
    await fsWriteFile(path.join(outside, "file.txt"), "synthetic")
    return { root, outside, calls, executor, ctx: { signal: new AbortController().signal, sessionId: initialized.sessionId } }
  }
  const uri = (native: string) => CcaPolicy.toPathUri(native)

  test("a deferring scope asks external_directory for the resolved directory of every outside target", async () => {
    const h = await outsideHarness(true)
    await h.executor.readFile({ path: uri(path.join(h.outside, "file.txt")) }, h.ctx)
    await h.executor.createDirectory({ path: uri(path.join(h.outside, "made")) }, h.ctx)
    const connection = h.executor.openConnection()
    cleanups.push(() => connection.close())
    await connection.fs.open({ handleId: "h1", path: uri(path.join(h.outside, "file.txt")), mode: "read" }, h.ctx)
    await connection.fs.close({ handleId: "h1" }, h.ctx)
    await connection.fs.copy({ sourcePath: uri(path.join(h.outside, "file.txt")), destinationPath: uri(path.join(h.root, "copied.txt")), recursive: false }, h.ctx)
    await symlink(h.outside, path.join(h.root, "linked"))
    await h.executor.getMetadata({ path: uri(path.join(h.root, "linked", "file.txt")) }, h.ctx)
    expect(h.calls.filter((call) => call.action === "external_directory").map((call) => call.resources)).toEqual([
      [path.join(h.outside, "*")],
      [path.join(h.outside, "*")],
      [path.join(h.outside, "*")],
      [path.join(h.outside, "*")],
      [path.join(h.outside, "*")],
    ])
    expect(await stat(path.join(h.outside, "made"))).toBeDefined()
    expect(await stat(path.join(h.root, "copied.txt"))).toBeDefined()
  })

  test("a scope that does not defer keeps the hard outside-roots refusal", async () => {
    const h = await outsideHarness(false)
    await expect(h.executor.readFile({ path: uri(path.join(h.outside, "file.txt")) }, h.ctx))
      .rejects.toMatchObject({ code: -32600, message: "Operation not permitted (os error 1)" })
    await expect(h.executor.startProcess({ processId: "outside", argv: ["/bin/sh", "-lc", "true"], cwd: uri(h.outside), env: {} }, h.ctx))
      .rejects.toMatchObject({ code: -32600 })
    expect(h.calls.filter((call) => call.action === "external_directory")).toEqual([])
  })
})
