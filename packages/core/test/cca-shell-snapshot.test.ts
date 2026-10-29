import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CcaAuthorizationInput } from "../src/cca/executor"
import {
  CCA_SHELL_SNAPSHOT_FD,
  CcaShellSnapshotCaptureError,
  CcaShellSnapshotError,
  ccaShellSnapshotStdio,
  createCcaShellSnapshotCache,
  parseCcaShellSnapshot,
  type CcaShellSnapshotLaunch,
  type CcaShellSnapshotPrepareInput,
} from "../src/cca/shell-snapshot"

const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_FILE_SNAPSHOT_BYTES = 4 * 1024 * 1024

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function home(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cca-snapshot-")))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function bytes(text: string): Uint8Array {
  return Buffer.from(text, "latin1")
}

function reasonOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    if (error instanceof CcaShellSnapshotCaptureError) return error.reason
    throw error
  }
}

describe("snapshot parsing", () => {
  test("size limit counts state and environment before filtering", () => {
    const half = "x".repeat(MAX_SNAPSHOT_BYTES / 2)
    const output = bytes(`# Snapshot file\n# ${half}\n\0\0\0FILTERED=${half}\0`)
    const policy = { inherit: "all", ignoreDefaultExcludes: false, exclude: ["FILTERED"], set: {}, includeOnly: [] }
    expect(reasonOf(() => parseCcaShellSnapshot("bash", output, policy, "environment"))).toBe("state_too_large")
  })

  test("filters profile exports after capture", () => {
    const policy = {
      inherit: "all",
      ignoreDefaultExcludes: false,
      exclude: ["PROFILE_DENIED"],
      set: { PROFILE_ALLOWED: "override", CODEX_THREAD_ID: "policy-thread", CODEX_TOOL_CALL_ID: "policy-call" },
      includeOnly: ["PROFILE_*", "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID"],
    }
    const output = Buffer.concat([
      Buffer.from("profile "),
      Buffer.from([0xff]),
      Buffer.from(" noise\n# Snapshot file\nfunction profile_helper() { :; }\n\0alias profile_alias='profile_helper'\n\0\0"),
      Buffer.from("PROFILE_ALLOWED=profile\0PROFILE_DENIED=denied\0PROFILE_SECRET=secret\0PWD=/tmp\0NON_UTF8="),
      Buffer.from([0xff]),
      Buffer.from("\0CODEX_THREAD_ID=capture-thread\0CODEX_TOOL_CALL_ID=profile-call\0"),
    ])
    const snapshot = parseCcaShellSnapshot("bash", output, policy, "environment")
    expect(snapshot.environment).toEqual({ PROFILE_ALLOWED: "override" })
    expect(snapshot.state).toBe("# Snapshot file\nfunction profile_helper() { :; }\nalias profile_alias='profile_helper'\n")
    expect(snapshot.fileSource).toBe(false)
  })

  test("preserves profile exports with restrictive inheritance", () => {
    for (const inherit of ["none", "core"]) {
      const policy = { inherit, ignoreDefaultExcludes: false, exclude: ["PROFILE_DENIED"], set: {}, includeOnly: [] }
      const snapshot = parseCcaShellSnapshot(
        "bash",
        bytes("# Snapshot file\n\0\0\0PROFILE_ALLOWED=profile\0SDKROOT=/sdk\0PROFILE_SECRET=secret\0PROFILE_DENIED=denied\0"),
        policy,
        "environment",
      )
      expect(snapshot.environment).toEqual({ PROFILE_ALLOWED: "profile", SDKROOT: "/sdk" })
    }
  })

  test("caches only unmanaged proxy state", () => {
    const cases: Array<[string, Record<string, string>]> = [
      [
        "PROFILE_ALLOWED=profile\0HTTP_PROXY=http://127.0.0.1:4321\0CODEX_NETWORK_PROXY_ACTIVE=1\0CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE=1\0",
        { PROFILE_ALLOWED: "profile" },
      ],
      [
        "PROFILE_ALLOWED=profile\0HTTP_PROXY=http://user-proxy.example\0",
        { PROFILE_ALLOWED: "profile", HTTP_PROXY: "http://user-proxy.example" },
      ],
    ]
    for (const [exports, expected] of cases) {
      const output = bytes(`# Snapshot file\n\0\0\0${exports}CODEX_THREAD_ID=capture-thread\0CODEX_TOOL_CALL_ID=profile-call\0OLDPWD=/old\0`)
      expect(parseCcaShellSnapshot("bash", output, undefined, "environment").environment).toEqual(expected)
    }
  })

  test("replay size limits", () => {
    const cases: Array<["file" | "environment", number, number, string | undefined]> = [
      ["file", 1024 * 1024, 0, undefined],
      ["environment", 1024 * 1024, 0, "state_too_large"],
      ["file", MAX_FILE_SNAPSHOT_BYTES, 0, "state_too_large"],
      ["file", 0, MAX_SNAPSHOT_BYTES, "environment_too_large"],
    ]
    for (const [replay, stateBytes, environmentBytes, expected] of cases) {
      const output = bytes(`# Snapshot file\n# ${"x".repeat(stateBytes)}\n\0\0\0PADDING=${"x".repeat(environmentBytes)}\0`)
      expect([replay, stateBytes, environmentBytes, reasonOf(() => parseCcaShellSnapshot("bash", output, undefined, replay))]).toEqual([
        replay,
        stateBytes,
        environmentBytes,
        expected,
      ])
    }
  })

  test("rejects captures without a snapshot header", () => {
    expect(reasonOf(() => parseCcaShellSnapshot("bash", bytes("no header\0\0\0"), undefined, "environment"))).toBe("invalid_capture")
  })
})

interface Recorded {
  readonly calls: CcaAuthorizationInput[]
  released: number
  readonly authorize: (input: CcaAuthorizationInput) => Promise<{ release(): Promise<void> }>
}

function recorder(deny = false): Recorded {
  const recorded: Recorded = {
    calls: [],
    released: 0,
    authorize: async (input) => {
      recorded.calls.push(input)
      if (deny) throw new Error("denied")
      return { release: async () => void recorded.released++ }
    },
  }
  return recorded
}

async function run(launch: CcaShellSnapshotLaunch, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(launch.argv[0], launch.argv.slice(1), {
    cwd,
    env: launch.env,
    stdio: ccaShellSnapshotStdio(["ignore", "pipe", "pipe"], launch),
  })
  launch.release()
  let stdout = ""
  let stderr = ""
  child.stdout!.on("data", (data) => (stdout += data))
  child.stderr!.on("data", (data) => (stderr += data))
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
  return { stdout, stderr, code }
}

function input(dir: string, overrides: Partial<CcaShellSnapshotPrepareInput> = {}): CcaShellSnapshotPrepareInput {
  const shell = overrides.request?.shell ?? { name: "bash", path: "/bin/bash" }
  return {
    sessionId: "session-1",
    processId: "proc-1",
    request: { scopeId: "attachment-1", shell },
    argv: [shell.path, "-lc", 'profile_helper; printf ":%s" "$PROFILE_VAR"'],
    cwd: dir,
    env: { HOME: dir, PATH: "/usr/bin:/bin" },
    requestEnv: {},
    ...overrides,
  }
}

const profile = (dir: string) => `printf x >> "${dir}/captures"\nexport PROFILE_VAR=profile\nprofile_helper() { printf restored; }\n`

describe("snapshot cache", () => {
  test("captures once, replays through the inherited descriptor, and keeps request overrides", async () => {
    const dir = await home()
    await writeFile(path.join(dir, ".bashrc"), profile(dir))
    const auth = recorder()
    const cache = createCcaShellSnapshotCache({ authorize: auth.authorize })
    cleanups.push(() => cache.close())

    const launch = await cache.prepare(input(dir))
    expect(launch).toBeDefined()
    expect(launch!.fd).toBeNumber()
    expect(launch!.argv[0]).toBe("/bin/bash")
    expect(launch!.argv[1]).toBe("-pc")
    expect(launch!.argv[2]).toContain(`. /dev/fd/${CCA_SHELL_SNAPSHOT_FD}`)
    expect(launch!.argv[2]).toEndWith('profile_helper; printf ":%s" "$PROFILE_VAR"')
    expect(launch!.env.PROFILE_VAR).toBe("profile")
    expect(await run(launch!, dir)).toEqual({ stdout: "restored:profile", stderr: "", code: 0 })
    expect(await readFile(path.join(dir, "captures"), "utf8")).toBe("x")
    expect(auth.calls).toHaveLength(1)
    expect(auth.calls[0]).toMatchObject({ action: "shell", resources: ["/bin/bash -lc <shell snapshot capture>"] })
    expect(auth.calls[0].metadata).toEqual({ processId: "proc-1", cwd: dir, shellSnapshotScope: "attachment-1" })
    expect(auth.released).toBe(1)

    const closedCheck = await cache.prepare(input(dir, { argv: ["/bin/bash", "-lc", `if [ -e /dev/fd/${CCA_SHELL_SNAPSHOT_FD} ]; then exit 43; fi; profile_helper`] }))
    expect(await run(closedCheck!, dir)).toEqual({ stdout: "restored", stderr: "", code: 0 })

    const second = await cache.prepare(input(dir, { requestEnv: { PROFILE_VAR: "request" }, env: { HOME: dir, PATH: "/usr/bin:/bin", PROFILE_VAR: "request" } }))
    expect(await run(second!, dir)).toEqual({ stdout: "restored:request", stderr: "", code: 0 })
    expect(await readFile(path.join(dir, "captures"), "utf8")).toBe("x")

    const otherScope = await cache.prepare(input(dir, { request: { scopeId: "attachment-2", shell: { name: "bash", path: "/bin/bash" } } }))
    otherScope!.release()
    const otherSession = await cache.prepare(input(dir, { sessionId: "session-2" }))
    otherSession!.release()
    expect(await readFile(path.join(dir, "captures"), "utf8")).toBe("xxx")
  })

  test("replays through environment chunks for POSIX sh", async () => {
    const dir = await home()
    await writeFile(path.join(dir, ".shrc"), profile(dir))
    const cache = createCcaShellSnapshotCache({ authorize: recorder().authorize })
    cleanups.push(() => cache.close())
    const shell = { name: "sh", path: "/bin/sh" }
    const launch = await cache.prepare(
      input(dir, {
        request: { scopeId: "attachment-1", shell },
        argv: ["/bin/sh", "-lc", 'profile_helper; printf ":%s" "$PROFILE_VAR"'],
        env: { HOME: dir, PATH: "/usr/bin:/bin", ENV: path.join(dir, ".shrc") },
      }),
    )
    expect(launch).toBeDefined()
    expect(launch!.fd).toBeUndefined()
    expect(launch!.argv[1]).toBe("-c")
    expect(launch!.argv[2]).toContain('eval "unset __CODEX_SHELL_SNAPSHOT_STATE_0')
    expect(launch!.env.__CODEX_SHELL_SNAPSHOT_STATE_0).toContain("# Snapshot file")
    const result = await run(launch!, dir)
    expect(result).toEqual({ stdout: "restored:profile", stderr: "", code: 0 })
  })

  test.skipIf(!existsSync("/bin/zsh"))("restores zsh state through the inherited descriptor", async () => {
    const dir = await home()
    await writeFile(path.join(dir, ".zshrc"), profile(dir))
    const cache = createCcaShellSnapshotCache({ authorize: recorder().authorize })
    cleanups.push(() => cache.close())
    const shell = { name: "zsh", path: "/bin/zsh" }
    const launch = await cache.prepare(
      input(dir, { request: { scopeId: "attachment-1", shell }, argv: ["/bin/zsh", "-lc", 'profile_helper; printf ":%s" "$PROFILE_VAR"'] }),
    )
    expect(launch!.argv[1]).toBe("-fc")
    expect(launch!.fd).toBeNumber()
    expect(await run(launch!, dir)).toEqual({ stdout: "restored:profile", stderr: "", code: 0 })
  })

  test("failed captures fall back, are single-flight, and retry a bounded number of times after backoff", async () => {
    for (const recoveryAttempt of [1, 2, 3, 4]) {
      const dir = await home()
      const rc = path.join(dir, ".bashrc")
      await writeFile(rc, `printf x >> "${dir}/captures"\nexit 7\n`)
      let now = 0
      const cache = createCcaShellSnapshotCache({ authorize: recorder().authorize, now: () => now })
      cleanups.push(() => cache.close())
      const outcomes: string[] = []
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (attempt === recoveryAttempt) await writeFile(rc, profile(dir))
        const [first, second] = await Promise.all([cache.prepare(input(dir)), cache.prepare(input(dir))])
        first?.release()
        second?.release()
        outcomes.push(first && second ? "used" : !first && !second ? "fallback" : "mixed")
        const captures = await readFile(path.join(dir, "captures"), "utf8")
        expect([recoveryAttempt, attempt, captures.length]).toEqual([recoveryAttempt, attempt, Math.min(attempt, recoveryAttempt, 3)])
        now += 1_000
      }
      const expected = [1, 2, 3, 4, 5].map((attempt) => (attempt >= recoveryAttempt && recoveryAttempt <= 3 ? "used" : "fallback"))
      expect([recoveryAttempt, outcomes]).toEqual([recoveryAttempt, expected])
    }
  })

  test("failed captures wait for the retry backoff", async () => {
    const dir = await home()
    const rc = path.join(dir, ".bashrc")
    await writeFile(rc, `printf x >> "${dir}/captures"\nexit 7\n`)
    let now = 0
    const cache = createCcaShellSnapshotCache({ authorize: recorder().authorize, now: () => now })
    cleanups.push(() => cache.close())
    expect(await cache.prepare(input(dir))).toBeUndefined()
    await writeFile(rc, profile(dir))
    now = 999
    expect(await cache.prepare(input(dir))).toBeUndefined()
    now = 1_000
    const launch = await cache.prepare(input(dir))
    launch!.release()
    expect(await readFile(path.join(dir, "captures"), "utf8")).toBe("xx")
  })

  test("authorization denial falls back to normal startup", async () => {
    const dir = await home()
    await writeFile(path.join(dir, ".bashrc"), profile(dir))
    const auth = recorder(true)
    const cache = createCcaShellSnapshotCache({ authorize: auth.authorize })
    cleanups.push(() => cache.close())
    expect(await cache.prepare(input(dir))).toBeUndefined()
    expect(auth.calls).toHaveLength(1)
    expect(existsSync(path.join(dir, "captures"))).toBe(false)
  })

  test("commands that are not login shell invocations of the snapshot shell run normally", async () => {
    const dir = await home()
    const auth = recorder()
    const cache = createCcaShellSnapshotCache({ authorize: auth.authorize })
    cleanups.push(() => cache.close())
    for (const argv of [["/bin/bash", "-c", "true"], ["/usr/bin/env", "-lc", "true"], ["/bin/bash", "-lc"]]) {
      expect(await cache.prepare(input(dir, { argv }))).toBeUndefined()
    }
    expect(auth.calls).toEqual([])
  })

  test("invalid snapshot requests are invalid params", async () => {
    const dir = await home()
    const cache = createCcaShellSnapshotCache({ authorize: recorder().authorize })
    const windows = createCcaShellSnapshotCache({ authorize: recorder().authorize, platform: "win32" })
    cleanups.push(() => cache.close(), () => windows.close())
    const cases: Array<[ReturnType<typeof createCcaShellSnapshotCache>, CcaShellSnapshotPrepareInput, string]> = [
      [cache, input(dir, { request: { scopeId: "", shell: { name: "bash", path: "/bin/bash" } } }), "shell snapshot scope must be non-empty and at most 256 bytes"],
      [cache, input(dir, { request: { scopeId: "é".repeat(129), shell: { name: "bash", path: "/bin/bash" } } }), "shell snapshot scope must be non-empty and at most 256 bytes"],
      [
        cache,
        input(dir, { request: { scopeId: "a", shell: { name: "fish", path: "/usr/bin/fish" } }, argv: ["/usr/bin/fish", "-lc", "true"] }),
        "shell snapshots are unsupported for shell `fish`",
      ],
      [windows, input(dir), "shell snapshots are unsupported on this platform"],
    ]
    for (const [target, request, message] of cases) {
      const error = await target.prepare(request).catch((caught: unknown) => caught)
      if (!(error instanceof CcaShellSnapshotError)) throw error
      expect([error.code, error.message]).toEqual([-32602, message])
    }
  })

  test("stdio places the snapshot reader at the replay descriptor", () => {
    const launch: CcaShellSnapshotLaunch = { argv: ["/bin/bash"], env: {}, fd: 42, release: () => {} }
    expect(ccaShellSnapshotStdio(["pipe", "pipe", "pipe"], launch)).toEqual([
      "pipe", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 42,
    ])
    expect(ccaShellSnapshotStdio(["ignore", "pipe", "pipe"], { argv: [], env: {}, release: () => {} })).toEqual(["ignore", "pipe", "pipe"])
  })
})
