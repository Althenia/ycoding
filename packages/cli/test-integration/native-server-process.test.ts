import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { watch } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { InstallationChannel, InstallationVersion } from "../src/version"
import type { NativeReport } from "./fixture/native-process-child"
import type { Input, OwnerReport } from "./fixture/native-process-owner"

const owner = path.join(import.meta.dirname, "fixture/native-process-owner.ts")
let artifacts = ""
let executable = ""
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex")

beforeAll(async () => {
  artifacts = await mkdtemp(path.join(tmpdir(), "ycoding-native-boundary-artifact-"))
  executable = path.join(artifacts, process.platform === "win32" ? "native runtime; literal.exe" : "native runtime; literal")
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dirname, "fixture/native-process-child.ts")],
    compile: { outfile: executable },
  })
  if (!result.success) throw new Error(result.logs.map(String).join("\n"))
}, 30_000)

afterAll(async () => {
  if (artifacts) await rm(artifacts, { recursive: true, force: true })
})

function observe<T>(file: string) {
  let changed = Promise.withResolvers<void>()
  const watcher = watch(path.dirname(file), (_event, name) => {
    if (String(name) !== path.basename(file)) return
    changed.resolve()
    changed = Promise.withResolvers<void>()
  })
  return {
    async until(predicate: (value: T) => boolean): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No expected ${path.basename(file)} boundary event`)), 10_000)
      })
      try {
        for (;;) {
          const next = changed.promise
          const value = await readFile(file, "utf8").then(
            (text) => JSON.parse(text) as T,
            (error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
              throw error
            },
          )
          if (value !== undefined && predicate(value)) return value
          await Promise.race([next, deadline])
        }
      } finally {
        clearTimeout(timer)
      }
    },
    close: () => watcher.close(),
  }
}

function bounded(value: string) {
  const text = value.replace(/\b(Bearer|Basic)\s+[^\s"'\\]+/gi, "$1 [redacted]")
  return text.length > 4096 ? text.slice(0, 2048) + "\n[output omitted]\n" + text.slice(-2048) : text
}

function capture(stream: ReadableStream<Uint8Array>) {
  let text = ""
  const finished = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })
    text += decoder.decode()
    return text
  })()
  return { finished, snapshot: () => bounded(text) }
}

async function start(input: Input, overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-native-process-case-"))
  const inputFile = path.join(root, "input.json")
  const nativeFile = path.join(root, "native.json")
  const ownerFile = path.join(root, "owner.json")
  const cancel = path.join(root, "cancel")
  const cleanup = path.join(root, "native-cleanup")
  await Promise.all([
    writeFile(inputFile, JSON.stringify(input), { mode: 0o600 }),
    writeFile(cancel, ""),
    writeFile(cleanup, ""),
  ])
  const native = observe<NativeReport>(nativeFile)
  const wrapper = observe<OwnerReport>(ownerFile)
  const child = Bun.spawn([process.execPath, "--conditions=browser", owner, inputFile], {
    cwd: root,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:YCODING_|OTEL_)/.test(key))),
      HOME: root,
      USERPROFILE: root,
      APPDATA: path.join(root, "config"),
      LOCALAPPDATA: path.join(root, "data"),
      YCODING_TEST_HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      YCODING_CONFIG_DIR: path.join(root, "config", "ycoding"),
      YCODING_CONFIG_CONTENT: "{}",
      YCODING_CONFIG_PROJECT_DISABLE: "1",
      YCODING_DISABLE_MODELS_FETCH: "1",
      YCODING_DISABLE_FILEWATCHER: "1",
      YCODING_DISABLE_FFF: "1",
      YCODING_VERSION: "synthetic-inherited-version",
      YCODING_CHANNEL: "synthetic-inherited-channel",
      YCODING_PASSWORD: "synthetic-inherited-password",
      YCODING_SERVER_PASSWORD: "synthetic-inherited-legacy-password",
      YCODING_RUNTIME_EXECUTABLE: executable,
      YCODING_SERVICE_STARTUP_ERROR_FILE: path.join(root, "startup-error"),
      YCODING_TEST_NATIVE_REPORT: nativeFile,
      YCODING_TEST_NATIVE_CLEANUP: cleanup,
      YCODING_TEST_NATIVE_OWNER_INPUT: inputFile,
      YCODING_TEST_NATIVE_OWNER_REPORT: ownerFile,
      YCODING_TEST_NATIVE_CANCEL: cancel,
      ...overrides,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const forceExit = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL") }, 20_000)
  void child.exited.then(() => clearTimeout(forceExit))
  const output = capture(child.stdout)
  const errors = capture(child.stderr)
  const stdout = output.finished
  const stderr = errors.finished
  async function failure(cause: unknown) {
    const reports = await Promise.all([ownerFile, nativeFile, path.join(root, "startup-error")].map(async (file) => ({
      file: path.basename(file),
      content: await readFile(file, "utf8").then(bounded, (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ENOENT" ? "<absent>" : bounded(String(error))),
    })))
    return new Error("Native boundary evidence: " + JSON.stringify({
      ownerPid: child.pid, exitCode: child.exitCode, signal: child.signalCode,
      stdout: output.snapshot(), stderr: errors.snapshot(), reports,
    }), { cause })
  }
  return {
    root, child, native, wrapper, nativeFile, stdout, stderr, failure,
    cancel: () => writeFile(cancel, "cancel"),
    async close() {
      try {
        await writeFile(cancel, "cancel")
        if (child.exitCode === null) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const settled = await Promise.race([
              child.exited.then(() => true),
              new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5_000) }),
            ])
            if (!settled) child.kill("SIGKILL")
          } finally {
            clearTimeout(timer)
          }
        }
        await child.exited
        await writeFile(cleanup, "cleanup")
        if (await Bun.file(nativeFile).exists()) await native.until((report) => report.stopped)
        await Promise.all([stdout, stderr])
      } catch (error) {
        throw await failure(error)
      } finally {
        native.close()
        wrapper.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

const forwardCases: Input[] = [
  { action: "public", mode: "default" },
  { action: "public", mode: "service", port: 0 },
  { action: "public", mode: "stdio", hostname: "::1", port: 0 },
  { action: "public", mode: "default", hostname: "127.0.0.1", port: 65535 },
]
for (const input of forwardCases) {
  test(`C01 ${input.mode} forwards explicit and absent native options without shell parsing (${input.port ?? "absent"})`, async () => {
    const run = await start(input)
    try {
      const report = await run.native.until(() => true)
      const argument = (flag: string) => {
        const index = report.args.indexOf(flag)
        return index < 0 ? undefined : report.args[index + 1]
      }
      expect(report.pid).not.toBe(run.child.pid)
      expect(report.args.includes("--service")).toBe(input.mode === "service")
      expect(report.args.includes("--stdio")).toBe(input.mode === "stdio")
      expect(argument("--hostname")).toBe(input.hostname)
      expect(argument("--port")).toBe(input.port === undefined ? undefined : String(input.port))
      expect(argument("--frontend-executable")).toBe(process.execPath)
      expect(JSON.parse(argument("--frontend-arguments") ?? "null")).toEqual([owner])
      expect(report.version).toBe(InstallationVersion)
      expect(report.channel).toBe(InstallationChannel)
      if (input.mode !== "service") expect(report.passwordFingerprint).toBe(fingerprint("synthetic-inherited-password"))
      expect(report.args.some((value) => value.includes("synthetic-inherited-password"))).toBe(false)
      await run.cancel()
      expect(await run.child.exited, await run.stderr).toBe(0)
      const reason = (await run.native.until((value) => value.stopped)).reason
      if (typeof reason !== "string") throw new Error("Stopped native process omitted its reason")
      expect(["eof", "SIGTERM", "SIGINT"]).toContain(reason)
    } catch (error) {
      throw await run.failure(error)
    } finally {
      await run.close()
    }
  }, 30_000)
}

test("C01 serve meeting reaches the native meeting flag without a JavaScript meeting backend", async () => {
  const run = await start({ action: "serve", stdio: true, port: 0, meeting: true })
  try {
    expect((await run.native.until(() => true)).args).toContain("--meeting")
    await run.cancel()
    expect(await run.child.exited, await run.stderr).toBe(0)
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test("C02 conflicting serve modes fail before the selected native process starts", async () => {
  const run = await start({ action: "serve", service: true, stdio: true, port: 0 })
  try {
    expect(await run.child.exited).not.toBe(0)
    expect(await run.stderr).toContain("--service and --stdio cannot be combined")
    expect(await Bun.file(run.nativeFile).exists()).toBe(false)
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test("C02 missing managed executable records the startup failure without readiness", async () => {
  const run = await start({ action: "serve", service: true, port: 0 }, {
    YCODING_RUNTIME_EXECUTABLE: path.join(artifacts, "missing-native-executable"),
  })
  try {
    expect(await run.child.exited).not.toBe(0)
    expect(await run.stdout).not.toContain("server listening on")
    const file = path.join(run.root, "startup-error")
    expect(await Bun.file(file).exists()).toBe(true)
    expect((await readFile(file, "utf8")).length).toBeGreaterThan(0)
    expect(await Bun.file(run.nativeFile).exists()).toBe(false)
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test("C02 managed native failure preserves the native diagnostic and fails the wrapper", async () => {
  const run = await start({ action: "serve", service: true, port: 0 }, { YCODING_TEST_NATIVE_FAIL: "1" })
  try {
    expect(await run.child.exited).not.toBe(0)
    expect(await run.stdout).not.toContain("server listening on")
    expect(await readFile(path.join(run.root, "startup-error"), "utf8")).toBe("synthetic native startup failure")
    expect((await run.native.until((value) => value.stopped)).reason).toBe("startup-failure")
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test("C03 stdio forwards one readiness record and closes the native lease on stdin EOF", async () => {
  const run = await start({ action: "public", mode: "stdio", port: 0 })
  try {
    const report = await run.native.until(() => true)
    run.child.stdin.end()
    expect(await run.child.exited, await run.stderr).toBe(0)
    expect(JSON.parse((await run.stdout).trim())).toEqual({ url: "http://127.0.0.1:42617" })
    expect((await run.native.until((value) => value.stopped)).reason).toBe("eof")
    expect(() => process.kill(report.pid, 0)).toThrow()
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test.each(["default", "service"] as const)("C03 %s remains running after wrapper stdin EOF", async (mode) => {
  const run = await start({ action: "public", mode, port: 0 })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await run.native.until(() => true)
    run.child.stdin.end()
    const outcome = await Promise.race([
      run.child.exited.then(() => "exited"),
      new Promise<"running">((resolve) => { timer = setTimeout(() => resolve("running"), 5_000) }),
    ])
    expect(outcome).toBe("running")
    await run.cancel()
    expect(await run.child.exited, await run.stderr).toBe(0)
    const reason = (await run.native.until((value) => value.stopped)).reason
    if (typeof reason !== "string") throw new Error("Stopped native process omitted its reason")
    expect(["eof", "SIGTERM", "SIGINT"]).toContain(reason)
  } catch (error) {
    throw await run.failure(error)
  } finally {
    clearTimeout(timer)
    await run.close()
  }
}, 30_000)

test("C03 scope cancellation before readiness reaps the selected native process", async () => {
  const run = await start({ action: "private" }, { YCODING_TEST_NATIVE_HOLD: "1" })
  try {
    const report = await run.native.until(() => true)
    await run.cancel()
    expect(await run.child.exited, await run.stderr).toBe(0)
    const reason = (await run.native.until((value) => value.stopped)).reason
    if (typeof reason !== "string") throw new Error("Stopped native process omitted its reason")
    expect(["eof", "SIGTERM", "SIGINT"]).toContain(reason)
    expect(() => process.kill(report.pid, 0)).toThrow()
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test("C04 default private startup selects the native process and preserves its PID and frontend identity", async () => {
  const run = await start({ action: "private" })
  try {
    const endpoint = await run.wrapper.until((value) => value.ready === true)
    expect(await Bun.file(run.nativeFile).exists()).toBe(true)
    const report = await run.native.until(() => true)
    expect(endpoint.nativePid).toBe(report.pid)
    expect(endpoint.nativePid).not.toBe(endpoint.pid)
    expect(endpoint.url).toBe("http://127.0.0.1:42617")
    expect(report.args).toContain("--frontend-executable")
    expect(report.version).toBe(InstallationVersion)
    expect(report.channel).toBe(InstallationChannel)
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test("C04 private leases replace inherited and explicit password overrides and keep draining stdout", async () => {
  const run = await start({
    action: "private", command: [executable], env: { YCODING_PASSWORD: "synthetic-explicit-password" },
  }, { YCODING_TEST_NATIVE_FLOOD: "1" })
  try {
    const endpoint = await run.wrapper.until((value) => value.ready === true)
    const report = await run.native.until((value) => value.outputFlushed === true)
    expect(endpoint.passwordFingerprint).toBe(report.passwordFingerprint)
    for (const password of ["synthetic-explicit-password", "synthetic-inherited-password"])
      expect(report.passwordFingerprint).not.toBe(fingerprint(password))
    expect(report.passwordFingerprint).not.toBe(fingerprint(""))
    await run.cancel()
    expect(await run.child.exited, await run.stderr).toBe(0)
    const reason = (await run.native.until((value) => value.stopped)).reason
    if (typeof reason !== "string") throw new Error("Stopped native process omitted its reason")
    expect(["eof", "SIGTERM", "SIGINT"]).toContain(reason)
    expect(await run.stdout).toBe("")
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test("C04 malformed private readiness fails and reaps its child", async () => {
  const run = await start({ action: "private", command: [executable] }, { YCODING_TEST_NATIVE_MALFORMED: "1" })
  try {
    expect(await run.child.exited).not.toBe(0)
    const reason = (await run.native.until((value) => value.stopped)).reason
    if (typeof reason !== "string") throw new Error("Stopped native process omitted its reason")
    expect(["eof", "SIGTERM", "SIGINT"]).toContain(reason)
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)

test("C04 loss of the private owner closes its OS lease without Effect finalizers", async () => {
  const run = await start({ action: "private", command: [executable] })
  try {
    await run.wrapper.until((value) => value.ready === true)
    run.child.kill("SIGKILL")
    await run.child.exited
    const report = await run.native.until((value) => value.stopped)
    expect(report.reason).toBe("eof")
  } catch (error) {
    throw await run.failure(error)
  } finally {
    await run.close()
  }
}, 30_000)
