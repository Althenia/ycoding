import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CcaPolicy } from "../src/cca/policy"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function thrown(fn: () => unknown): CcaPolicy.PolicyError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(CcaPolicy.PolicyError)
    return error as CcaPolicy.PolicyError
  }
  throw new Error("expected throw")
}

async function rejected(promise: Promise<unknown>): Promise<CcaPolicy.PolicyError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CcaPolicy.PolicyError)
    return error as CcaPolicy.PolicyError
  }
  throw new Error("expected rejection")
}

describe("parsePathUri/toPathUri", () => {
  test("round-trips spaces, unicode, and reserved characters in file names", () => {
    for (const abs of ["/tmp/a b/c#d?.txt", "/tmp/日本語/100%.txt", "/a/b/", "/"]) {
      expect(CcaPolicy.parsePathUri(CcaPolicy.toPathUri(abs))).toBe(abs)
    }
    expect(CcaPolicy.toPathUri("/tmp/a b/c#d?.txt")).toBe("file:///tmp/a%20b/c%23d%3F.txt")
  })

  test("accepts empty and localhost authority only", () => {
    expect(CcaPolicy.parsePathUri("file:///tmp/x")).toBe("/tmp/x")
    expect(CcaPolicy.parsePathUri("file://localhost/tmp/x")).toBe("/tmp/x")
    expect(thrown(() => CcaPolicy.parsePathUri("file://evil.example/tmp/x")).code).toBe("invalid_path")
  })

  test("maps a Windows drive URI structurally and back", () => {
    expect(CcaPolicy.parsePathUri("file:///C:/Users/a%20b")).toBe("C:\\Users\\a b")
    expect(CcaPolicy.toPathUri("C:\\Users\\a b")).toBe("file:///C:/Users/a%20b")
  })

  test("rejects non-file schemes, native, relative, and empty input", () => {
    for (const bad of ["https://x/y", "/etc/passwd", "relative/path", "", "file:/tmp/x", "file://localhost"]) {
      expect(thrown(() => CcaPolicy.parsePathUri(bad)).code).toBe("invalid_path")
    }
  })

  test("rejects raw query/fragment, bad percent-encoding, NUL/control, dot segments, and backslashes", () => {
    for (const bad of [
      "file:///tmp/a?x=1",
      "file:///tmp/a#frag",
      "file:///tmp/a%2G",
      "file:///tmp/a%FF",
      "file:///tmp/a%00b",
      "file:///tmp/a/../b",
      "file:///tmp/./b",
      "file:///tmp/a\\b",
      "file:///tmp/a%5Cb",
      "file:///tmp//a",
    ]) {
      expect(thrown(() => CcaPolicy.parsePathUri(bad)).code).toBe("invalid_path")
    }
  })

  test("toPathUri rejects relative input and dot segments", () => {
    expect(thrown(() => CcaPolicy.toPathUri("relative/x")).code).toBe("invalid_path")
    expect(thrown(() => CcaPolicy.toPathUri("/a/../b")).code).toBe("invalid_path")
    expect(thrown(() => CcaPolicy.toPathUri("")).code).toBe("invalid_path")
  })
})

describe("resolveContained", () => {
  async function fixture() {
    const base = await mkdtemp(path.join(tmpdir(), "cca-policy-"))
    cleanups.push(() => rm(base, { recursive: true, force: true }))
    const root = path.join(base, "root")
    const sibling = path.join(base, "root2")
    const outside = path.join(base, "outside")
    await mkdir(root)
    await mkdir(sibling)
    await mkdir(outside)
    await writeFile(path.join(root, "file.txt"), "x")
    await writeFile(path.join(sibling, "file.txt"), "x")
    await writeFile(path.join(outside, "secret.txt"), "x")
    return { base, outside, root, sibling }
  }

  test("accepts an existing file under a canonicalized root", async () => {
    const { root } = await fixture()
    const expected = await realpath(path.join(root, "file.txt"))
    expect(await CcaPolicy.resolveContained(path.join(root, "file.txt"), [root])).toBe(expected)
    expect(await CcaPolicy.resolveContained(root, [root])).toBe(await realpath(root))
  })

  test("rejects a sibling whose name shares the root prefix", async () => {
    const { root, sibling } = await fixture()
    expect((await rejected(CcaPolicy.resolveContained(path.join(sibling, "file.txt"), [root]))).code).toBe(
      "outside_roots",
    )
  })

  test("rejects a symlink inside the root that escapes it", async () => {
    const { outside, root } = await fixture()
    await symlink(outside, path.join(root, "link"))
    expect(
      (await rejected(CcaPolicy.resolveContained(path.join(root, "link", "secret.txt"), [root]))).code,
    ).toBe("outside_roots")
  })

  test("missing final component resolves against the nearest existing ancestor only when allowed", async () => {
    const { root } = await fixture()
    const target = path.join(root, "new.txt")
    expect((await rejected(CcaPolicy.resolveContained(target, [root]))).code).toBe("invalid_path")
    const expected = path.join(await realpath(root), "new.txt")
    expect(await CcaPolicy.resolveContained(target, [root], { allowMissingFinal: true })).toBe(expected)
  })

  test("missing write target under a symlinked ancestor still rejects escape", async () => {
    const { outside, root } = await fixture()
    await symlink(outside, path.join(root, "link"))
    expect(
      (
        await rejected(
          CcaPolicy.resolveContained(path.join(root, "link", "new.txt"), [root], { allowMissingFinal: true }),
        )
      ).code,
    ).toBe("outside_roots")
  })

  test("rejects dot segments and empty roots", async () => {
    const { root } = await fixture()
    expect((await rejected(CcaPolicy.resolveContained(`${root}/../outside`, [root]))).code).toBe("invalid_path")
    expect((await rejected(CcaPolicy.resolveContained(path.join(root, "file.txt"), []))).code).toBe("invalid_path")
  })
})

describe("resolveSandbox", () => {
  const uri = (native: string) => CcaPolicy.toPathUri(native)
  const pathEntry = (native: string, access: string, extra: Record<string, unknown> = {}) => ({
    path: { type: "path", path: uri(native) },
    access,
    ...extra,
  })
  const special = (value: Record<string, unknown>, access: string) => ({ path: { type: "special", value }, access })
  const glob = (pattern: string, access: string) => ({ path: { type: "glob_pattern", pattern }, access })
  const managed = (entries: unknown[], network = "restricted", extra: Record<string, unknown> = {}) => ({
    type: "managed",
    file_system: { type: "restricted", entries, ...extra },
    network,
  })
  const context = (cwd: string, permissions: unknown, extra: Record<string, unknown> = {}) => ({
    permissions,
    cwd: uri(cwd),
    workspaceRoots: [uri(cwd)],
    useLegacyLandlock: false,
    ...extra,
  })

  async function workspace() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cca-sandbox-")))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(path.join(root, "project", ".codex"), { recursive: true })
    await mkdir(path.join(root, "project", "src"), { recursive: true })
    await mkdir(path.join(root, "other"), { recursive: true })
    return { root, project: path.join(root, "project") }
  }

  test("is absent without sandbox, managed-network, or proxy intent", async () => {
    expect(await CcaPolicy.resolveSandbox({})).toBeUndefined()
    expect(
      await CcaPolicy.resolveSandbox({ sandbox: null, enforceManagedNetwork: false, managedNetwork: null, networkProxy: null }),
    ).toBeUndefined()
  })

  test("rejects malformed upstream shapes as invalid_sandbox", async () => {
    const cwd = uri("/tmp")
    for (const input of [
      { sandbox: {} },
      { sandbox: { permissions: "managed" } },
      { sandbox: { permissions: { type: "bogus" }, cwd } },
      { sandbox: { permissions: { type: "managed", file_system: { type: "restricted", entries: [] } }, cwd } },
      { sandbox: { permissions: { type: "managed", file_system: { type: "restricted", entries: {} }, network: "restricted" }, cwd } },
      { sandbox: { permissions: managed([{ path: { type: "path", path: cwd }, access: "bogus" }]), cwd } },
      { sandbox: { permissions: managed([{ path: { type: "path", path: "/tmp" }, access: "read" }]), cwd } },
      { sandbox: { permissions: managed([{ path: { type: "nope" }, access: "read" }]), cwd } },
      { sandbox: { permissions: managed([], "open"), cwd } },
      { sandbox: { permissions: { type: "external", network: "nope" }, cwd } },
      { sandbox: { permissions: { type: "disabled" }, cwd, sandboxOverride: "always" } },
      { sandbox: { permissions: { type: "disabled" }, cwd, workspaceRoots: "file:///tmp" } },
      { sandbox: { permissions: { type: "disabled" }, cwd: 3 } },
      { managedNetwork: {} },
      { managedNetwork: { loopbackPorts: [-1], allowLocalBinding: false } },
      { networkProxy: {} },
    ]) {
      expect((await rejected(CcaPolicy.resolveSandbox(input))).code).toBe("invalid_sandbox")
    }
  })

  test("accepts the upstream read-only profile with every optional context field", async () => {
    const { project } = await workspace()
    const policy = await CcaPolicy.resolveSandbox({
      sandbox: context(
        project,
        managed(
          [
            pathEntry(project, "read"),
            pathEntry(path.join(project, ".git"), "read", { missing_path_behavior: "skip" }),
            { ...special({ kind: "project_roots", subpath: ".codex" }, "read"), missing_path_behavior: "skip" },
          ],
          "restricted",
          { glob_scan_max_depth: 2 },
        ),
        {
          userHomeDir: uri(project),
          temporaryDirectories: null,
          windowsSandboxLevel: "mxc",
          windowsSandboxProxySettingsMode: "preserve",
          sandboxOverride: "noOverride",
        },
      ),
    })
    expect(policy?.sandboxed).toBe(true)
    expect(policy?.access(path.join(project, "src"))).toBe("read")
    expect(policy?.metadata).toMatchObject({
      sandboxProfile: "managed",
      sandboxFileSystem: "restricted",
      sandboxNetwork: "restricted",
      sandboxWritableRoots: "[]",
    })
    expect(policy?.metadata.sandboxOverride).toBeUndefined()
  })

  test("disabled, external, and unrestricted profiles impose no filesystem restriction", async () => {
    const { project } = await workspace()
    const disabled = await CcaPolicy.resolveSandbox({ sandbox: context(project, { type: "disabled" }) })
    expect(disabled?.sandboxed).toBe(false)
    expect(disabled?.access("/anywhere")).toBe("write")
    expect(disabled?.metadata).toMatchObject({ sandboxProfile: "disabled", sandboxFileSystem: "unrestricted", sandboxNetwork: "enabled" })

    const external = await CcaPolicy.resolveSandbox({ sandbox: context(project, { type: "external", network: "restricted" }) })
    expect(external?.sandboxed).toBe(false)
    expect(external?.access("/anywhere")).toBe("write")
    expect(external?.metadata).toMatchObject({ sandboxProfile: "external", sandboxNetwork: "restricted" })

    const unrestricted = await CcaPolicy.resolveSandbox({
      sandbox: context(project, { type: "managed", file_system: { type: "unrestricted" }, network: "restricted" }),
    })
    expect(unrestricted?.sandboxed).toBe(true)
    expect(unrestricted?.access("/anywhere")).toBe("write")
    expect(unrestricted?.metadata).toMatchObject({ sandboxFileSystem: "unrestricted", sandboxNetwork: "restricted" })

    const open = await CcaPolicy.resolveSandbox({
      sandbox: context(project, { type: "managed", file_system: { type: "unrestricted" }, network: "enabled" }),
    })
    expect(open?.sandboxed).toBe(false)
  })

  test("the most specific grant wins and deny entries always win", async () => {
    const { root, project } = await workspace()
    const policy = await CcaPolicy.resolveSandbox({
      sandbox: context(
        project,
        managed([
          special({ kind: "project_roots" }, "write"),
          special({ kind: "project_roots", subpath: ".codex" }, "read"),
          pathEntry(path.join(project, "src", "secret"), "deny"),
          glob("**/*.env", "deny"),
          glob("*.lock", "deny"),
        ]),
      ),
    })
    expect(policy?.access(path.join(project, "src", "a.ts"))).toBe("write")
    expect(policy?.access(path.join(project, "new", "missing.txt"))).toBe("write")
    expect(policy?.access(path.join(project, ".codex", "config.toml"))).toBe("read")
    expect(policy?.access(path.join(project, "src", "secret"))).toBe("none")
    expect(policy?.access(path.join(project, "src", "secret", "key.pem"))).toBe("none")
    expect(policy?.access(path.join(project, "deep", "prod.env"))).toBe("none")
    expect(policy?.access(path.join(project, "deep", "prod.env", "inner"))).toBe("none")
    expect(policy?.access(path.join(project, "bun.lock"))).toBe("none")
    expect(policy?.access(path.join(project, "deep", "bun.lock"))).toBe("write")
    expect(policy?.access(path.join(root, "other"))).toBe("none")
    expect(JSON.parse(policy!.metadata.sandboxWritableRoots!)).toEqual([project])
  })

  test("root, tmpdir, and slash_tmp special paths resolve on the executor host", async () => {
    const { root, project } = await workspace()
    const temp = path.join(root, "other")
    const policy = await CcaPolicy.resolveSandbox(
      {
        sandbox: context(
          project,
          managed([special({ kind: "root" }, "read"), special({ kind: "tmpdir" }, "write"), special({ kind: "minimal" }, "read")]),
        ),
      },
      { temporaryDirectories: [temp] },
    )
    expect(policy?.access("/usr/bin/env")).toBe("read")
    expect(policy?.access(path.join(temp, "scratch"))).toBe("write")
    if (process.platform !== "win32") {
      const slash = await CcaPolicy.resolveSandbox({ sandbox: context(project, managed([special({ kind: "slash_tmp" }, "write")])) })
      expect(slash?.access(path.join(await realpath("/tmp"), "x"))).toBe("write")
    }
  })

  test("entry paths are canonicalized so symlinked grants match canonical targets", async () => {
    const { root, project } = await workspace()
    const link = path.join(root, "link")
    await symlink(project, link)
    const policy = await CcaPolicy.resolveSandbox({ sandbox: context(project, managed([pathEntry(link, "write")])) })
    expect(policy?.access(path.join(project, "src"))).toBe("write")
  })

  test("explicit policyContext paths take precedence over legacy cwd and workspaceRoots", async () => {
    const { root, project } = await workspace()
    const other = path.join(root, "other")
    const policy = await CcaPolicy.resolveSandbox({
      sandbox: {
        permissions: managed([special({ kind: "project_roots" }, "write")]),
        cwd: uri(other),
        workspaceRoots: [uri(other)],
        policyContext: { cwd: uri(project), workspaceRoots: [uri(project)] },
      },
    })
    expect(policy?.access(path.join(project, "src"))).toBe("write")
    expect(policy?.access(other)).toBe("none")
  })

  test("dynamic permissions without a policy cwd use the process cwd, or are rejected when none exists", async () => {
    const { project } = await workspace()
    const sandbox = { permissions: managed([special({ kind: "project_roots" }, "write")]) }
    const legacy = await CcaPolicy.resolveSandbox({ sandbox }, { cwd: project })
    expect(legacy?.access(path.join(project, "src"))).toBe("write")
    const error = await rejected(CcaPolicy.resolveSandbox({ sandbox: { ...sandbox, cwd: null } }))
    expect(error.code).toBe("invalid_sandbox")
    expect(error.message).toBe("file system sandbox context with dynamic permissions requires cwd")
    const fixed = await CcaPolicy.resolveSandbox({ sandbox: { permissions: managed([pathEntry(project, "read")]) } })
    expect(fixed?.access(project)).toBe("read")
  })

  test("a process policy cwd is always readable, as upstream adds it to the readable roots", async () => {
    const { project } = await workspace()
    const policy = await CcaPolicy.resolveSandbox(
      { sandbox: context(project, managed([])) },
      { readablePolicyCwd: true },
    )
    expect(policy?.access(project)).toBe("read")
    const fs = await CcaPolicy.resolveSandbox({ sandbox: context(project, managed([])) })
    expect(fs?.access(project)).toBe("none")
  })

  test("escalation overrides are recorded; bypassSandboxFirstAttempt lifts filesystem confinement", async () => {
    const { project } = await workspace()
    const escalated = await CcaPolicy.resolveSandbox({
      sandbox: context(project, managed([pathEntry(project, "read")]), { sandboxOverride: "escalatedSandboxWithRestrictions" }),
    })
    expect(escalated?.sandboxed).toBe(true)
    expect(escalated?.access(project)).toBe("read")
    expect(escalated?.metadata.sandboxOverride).toBe("escalatedSandboxWithRestrictions")
    const bypass = await CcaPolicy.resolveSandbox({
      sandbox: context(project, managed([pathEntry(project, "read")]), { sandboxOverride: "bypassSandboxFirstAttempt" }),
    })
    expect(bypass?.sandboxed).toBe(false)
    expect(bypass?.access(path.join(project, "x"))).toBe("write")
    expect(bypass?.metadata.sandboxOverride).toBe("bypassSandboxFirstAttempt")
  })

  test("an unknown special path never grants access and fails closed as a deny", async () => {
    const { project } = await workspace()
    const grant = await CcaPolicy.resolveSandbox({
      sandbox: context(project, managed([special({ kind: "unknown", path: ":future" }, "write"), pathEntry(project, "read")])),
    })
    expect(grant?.access(path.join(project, "src"))).toBe("read")
    const deny = await CcaPolicy.resolveSandbox({
      sandbox: context(project, managed([pathEntry(project, "write"), special({ kind: "future_kind" }, "deny")])),
    })
    expect(deny?.access(path.join(project, "src"))).toBe("none")
  })

  test("managed-network and proxy intent without a filesystem sandbox is accepted and recorded", async () => {
    const enforced = await CcaPolicy.resolveSandbox({ enforceManagedNetwork: true })
    expect(enforced?.sandboxed).toBe(false)
    expect(enforced?.access("/anywhere")).toBe("write")
    expect(enforced?.metadata).toEqual({ sandboxManagedNetwork: "enforced" })
    const context = await CcaPolicy.resolveSandbox({
      managedNetwork: { loopbackPorts: [43123], allowLocalBinding: true },
      networkProxy: { proxy: { enabled: true }, auditMetadata: { conversationId: "c" }, environmentId: "e", executionId: "x" },
    })
    expect(context?.metadata).toEqual({ sandboxManagedNetwork: "requested", sandboxNetworkProxy: "requested" })
    const full = await CcaPolicy.resolveSandbox({
      managedNetwork: { loopbackPorts: [1, 2], allowLocalBinding: false, allowUnixSockets: ["/tmp/a.sock"], dangerouslyAllowAllUnixSockets: true },
    })
    expect(full?.metadata).toEqual({ sandboxManagedNetwork: "requested" })
  })

  test.skipIf(process.platform === "win32")("a foreign Windows permission path is rejected on a POSIX host", async () => {
    const error = await rejected(
      CcaPolicy.resolveSandbox({
        sandbox: { permissions: managed([{ path: { type: "path", path: "file:///C:/a%20b" }, access: "read" }]), cwd: uri("/tmp") },
      }),
    )
    expect(error.code).toBe("invalid_sandbox")
  })
})

describe("buildProcessEnv", () => {
  const policy = (overrides: Partial<CcaPolicy.EnvPolicy> = {}): CcaPolicy.EnvPolicy => ({
    inherit: "all",
    ignoreDefaultExcludes: false,
    exclude: [],
    set: {},
    includeOnly: [],
    ...overrides,
  })

  test("never inherits process.env implicitly", () => {
    const previous = process.env.CCA_POLICY_SENTINEL
    process.env.CCA_POLICY_SENTINEL = "host"
    try {
      expect(CcaPolicy.buildProcessEnv({ base: { PATH: "/usr/bin" } })).toEqual({ PATH: "/usr/bin" })
      expect(CcaPolicy.buildProcessEnv({ envPolicy: policy() })).toEqual({})
    } finally {
      if (previous === undefined) delete process.env.CCA_POLICY_SENTINEL
      else process.env.CCA_POLICY_SENTINEL = previous
    }
  })

  test("ordering is base, then policy set, then env overlay wins", () => {
    expect(
      CcaPolicy.buildProcessEnv({
        base: { A: "base", B: "base" },
        env: { B: "overlay" },
        envPolicy: policy({ set: { A: "set", B: "set", C: "set" } }),
      }),
    ).toEqual({ A: "set", B: "overlay", C: "set" })
  })

  test("exclude precedes set reintroduction, includeOnly, and the final request overlay", () => {
    expect(
      CcaPolicy.buildProcessEnv({
        base: { DROP: "base", KEEP: "base", OMIT: "base" },
        env: { DROP: "overlay", OUTSIDE: "overlay" },
        envPolicy: policy({ exclude: ["dr*"], set: { DROP: "set", KEEP: "set" }, includeOnly: ["drop", "keep"] }),
      }),
    ).toEqual({ DROP: "overlay", KEEP: "set", OUTSIDE: "overlay" })
  })

  test("none, core, and all select only their candidate environment without mutating inputs", () => {
    const base = Object.freeze({ path: "/synthetic/bin", home: "/synthetic/home", LANG: "C", EXTRA: "host", API_TOKEN: "hidden" })
    const env = Object.freeze({ EXPLICIT: "request" })
    const set = Object.freeze({ SET: "policy" })
    const inputPolicy = Object.freeze(policy({ set }))
    expect(CcaPolicy.buildProcessEnv({ base, env, envPolicy: policy({ inherit: "none", set }), platform: "linux" })).toEqual({ SET: "policy", EXPLICIT: "request" })
    expect(CcaPolicy.buildProcessEnv({ base, envPolicy: policy({ inherit: "core" }), platform: "linux" })).toEqual({ path: "/synthetic/bin", home: "/synthetic/home", LANG: "C" })
    expect(CcaPolicy.buildProcessEnv({ base, env, envPolicy: inputPolicy, platform: "linux" })).toEqual({ path: "/synthetic/bin", home: "/synthetic/home", LANG: "C", EXTRA: "host", SET: "policy", EXPLICIT: "request" })
    expect(base.EXTRA).toBe("host")
    expect(set).toEqual({ SET: "policy" })
    expect(env).toEqual({ EXPLICIT: "request" })
    expect(inputPolicy).toEqual(policy({ set }))
    expect(CcaPolicy.buildProcessEnv({ base: { A: "1" }, envPolicy: null })).toEqual({ A: "1" })
  })

  test("core uses the pinned platform names and Windows overrides collapse case collisions", () => {
    const base = { Path: "old", HOME: "unix", SystemRoot: "windows", APPDATA: "app", OTHER: "excluded" }
    expect(CcaPolicy.buildProcessEnv({ base, envPolicy: policy({ inherit: "core" }), platform: "linux" })).toEqual({ Path: "old", HOME: "unix" })
    expect(CcaPolicy.buildProcessEnv({ base, envPolicy: policy({ inherit: "core", set: { PATH: "set" } }), env: { path: "request" }, platform: "win32" })).toEqual({ path: "request", SystemRoot: "windows", APPDATA: "app" })
    expect(CcaPolicy.buildProcessEnv({ base: { Path: "base" }, envPolicy: policy({ set: { PATH: "set" } }), platform: "linux" })).toEqual({ Path: "base", PATH: "set" })
  })

  test("wildcards are case-insensitive with only star and question mark special", () => {
    const base = { KEEP1: "1", keep2: "2", KEEP12: "12", "[literal]": "brackets", "A\\B": "backslash", "A/B": "slash", A: "bare", "A .*": "literal", "N💡": "unicode" }
    expect(CcaPolicy.buildProcessEnv({ base, envPolicy: policy({ includeOnly: ["keep?", "[literal]", "A\\B", "A .*", "n?"], exclude: ["KEEP2"] }) })).toEqual({ KEEP1: "1", "[literal]": "brackets", "A\\B": "backslash", "A .*": "literal", "N💡": "unicode" })
  })

  test("mandatory inherited secret filtering survives ignoreDefaultExcludes and custom denylists", () => {
    const base = { API_TOKEN: "hidden", PASSWORD: "hidden", CREDENTIAL: "hidden", MONKEY: "ordinary", DROP: "custom", KEEP: "kept" }
    expect(CcaPolicy.buildProcessEnv({ base, envPolicy: policy(), denylist: /DROP/g })).toEqual({ KEEP: "kept" })
    expect(CcaPolicy.buildProcessEnv({ base, envPolicy: policy({ ignoreDefaultExcludes: true }), denylist: /DROP/g })).toEqual({ MONKEY: "ordinary", KEEP: "kept" })
    expect(CcaPolicy.buildProcessEnv({ base, envPolicy: policy({ set: { API_TOKEN: "explicit-policy" } }), env: { PASSWORD: "explicit-request" } })).toEqual({ DROP: "custom", KEEP: "kept", API_TOKEN: "explicit-policy", PASSWORD: "explicit-request" })
  })

  test("restricted launch context cannot be restored by inherited or explicit values", () => {
    const restricted = ["CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN", "NODE_REPL_AUTH_TOKEN", "CODEX_GUARDIAN_DECISIONS_API_KEY", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT"]
    for (const key of restricted) {
      expect(CcaPolicy.buildProcessEnv({ base: { [key]: "host" }, envPolicy: policy({ set: { [key.toLowerCase()]: "set" } }), env: { [key]: "request" } })).toEqual({})
    }
    expect(CcaPolicy.buildProcessEnv({ env: { CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE: "1", CODEX_THREAD_ID: "caller" } })).toEqual({ CODEX_THREAD_ID: "caller" })
  })

  test("malformed policy members fail with invalid_env without copying input values", () => {
    const valid = policy()
    const invalid: unknown[] = [false, [], "policy", {}, ...Object.keys(valid).flatMap((key) => {
      const missing = { ...valid } as Record<string, unknown>
      delete missing[key]
      return [missing, { ...valid, [key]: null }]
    }), { ...valid, inherit: "ALL" }, { ...valid, inherit: true }, { ...valid, ignoreDefaultExcludes: "false" }, { ...valid, exclude: [1] }, { ...valid, exclude: Array(1) }, { ...valid, includeOnly: Array(1) }, { ...valid, includeOnly: "PATH" }, { ...valid, set: [] }]
    for (const envPolicy of invalid) {
      const error = thrown(() => CcaPolicy.buildProcessEnv({ envPolicy }))
      expect(error.code).toBe("invalid_env")
      expect(error.message).toBe("invalid environment policy")
    }
    expect(CcaPolicy.buildProcessEnv({ envPolicy: { ...valid, set: { GOOD: "ok", BAD: 1, "": "bad", NUL: "a\0b" } } })).toEqual({ GOOD: "ok" })
  })

  test("limits apply to the final filtered environment at exact entry and byte boundaries", () => {
    const base = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`K${index}`, "v"]))
    expect(Object.keys(CcaPolicy.buildProcessEnv({ base, envPolicy: policy({ includeOnly: ["K0"] }) }))).toEqual(["K0"])
    expect(Object.keys(CcaPolicy.buildProcessEnv({ base, envPolicy: policy({ exclude: ["K256"] }) }))).toHaveLength(256)
    expect(thrown(() => CcaPolicy.buildProcessEnv({ base, envPolicy: policy() })).code).toBe("invalid_env")
    expect(CcaPolicy.buildProcessEnv({ env: { A: "x".repeat(65_535) } }).A).toHaveLength(65_535)
    expect(thrown(() => CcaPolicy.buildProcessEnv({ env: { A: "x".repeat(65_536) } })).code).toBe("invalid_env")
  })

  test("secret-shaped keys are stripped from the local base but not from the harness overlay", () => {
    expect(
      CcaPolicy.buildProcessEnv({
        base: { API_TOKEN: "host-secret", MY_PASSWORD: "host-secret", PATH: "/usr/bin" },
        env: { HARNESS_TOKEN: "caller-data" },
      }),
    ).toEqual({ HARNESS_TOKEN: "caller-data", PATH: "/usr/bin" })
  })

  test("a caller-supplied global denylist regex strips every matching base key (no lastIndex state)", () => {
    expect(
      CcaPolicy.buildProcessEnv({
        base: { A_SECRET: "1", B_SECRET: "2", C_TOKEN: "3", D_TOKEN: "4", PATH: "/usr/bin" },
        denylist: /SECRET|TOKEN/gi,
      }),
    ).toEqual({ PATH: "/usr/bin" })
  })

  test("entries with empty, control, or '=' keys and NUL values are dropped", () => {
    expect(
      CcaPolicy.buildProcessEnv({
        base: { "": "x", "A=B": "x", "BAD\nKEY": "x", GOOD: "x", NULVAL: "a\0b" },
      }),
    ).toEqual({ GOOD: "x" })
  })

  test("entry count and total byte bounds throw invalid_env", () => {
    const many: Record<string, string> = {}
    for (let index = 0; index < 257; index++) many[`K${index}`] = "v"
    expect(thrown(() => CcaPolicy.buildProcessEnv({ env: many })).code).toBe("invalid_env")
    expect(thrown(() => CcaPolicy.buildProcessEnv({ env: { BIG: "x".repeat(65_537) } })).code).toBe("invalid_env")
  })
})

describe("assertArgv", () => {
  test("accepts a bounded argv including empty non-program arguments", () => {
    expect(() => CcaPolicy.assertArgv(["/bin/echo", "", "hello"])).not.toThrow()
  })

  test("rejects empty argv, empty program, too many args, oversized args, and NUL", () => {
    expect(thrown(() => CcaPolicy.assertArgv([])).code).toBe("invalid_argv")
    expect(thrown(() => CcaPolicy.assertArgv(["", "x"])).code).toBe("invalid_argv")
    expect(thrown(() => CcaPolicy.assertArgv(Array.from({ length: 513 }, () => "x"))).code).toBe("invalid_argv")
    expect(thrown(() => CcaPolicy.assertArgv(["prog", "x".repeat(32_769)])).code).toBe("invalid_argv")
    expect(thrown(() => CcaPolicy.assertArgv(["prog", "a\0b"])).code).toBe("invalid_argv")
  })
})
