import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import { readCcaEnvironmentConfig, type CcaEnvironmentConfigOptions } from "../src/remote-control/cca-environment-config"

const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "cca-env-config-"))
  cleanups.push(dir)
  return dir
}

async function put(file: string, contents: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents)
}

function options(base: string, overrides: Partial<CcaEnvironmentConfigOptions> = {}): CcaEnvironmentConfigOptions {
  return {
    homeDirectory: path.join(base, "home"),
    systemConfigPath: path.join(base, "etc", "config.toml"),
    systemRequirementsPath: path.join(base, "etc", "requirements.toml"),
    managedConfigPath: path.join(base, "etc", "managed_config.toml"),
    hostname: () => "Synthetic-Host.",
    ...overrides,
  }
}

const read = (base: string, cwd: string, configPaths: string[][], requirementsPaths: string[][] = [], extra: Partial<CcaEnvironmentConfigOptions> = {}) =>
  readCcaEnvironmentConfig({ cwd: CcaPolicy.toPathUri(cwd), configPaths, requirementsPaths }, options(base, extra))

const failure = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as { code: number; message: string })

describe("environmentConfig/read executor-local layers (exec-server environment_config.rs)", () => {
  test("no config files answer empty stacks with the executor homes and hostname", async () => {
    const base = await scratch()
    const result = await read(base, path.join(base, "home"), [["sandbox_mode"]], [["mcp_servers"]])
    expect(result).toEqual({
      userHomeDir: CcaPolicy.toPathUri(path.join(base, "home")),
      codexHomeDir: CcaPolicy.toPathUri(path.join(base, "home", ".codex")),
      hostname: "synthetic-host",
      config: { layers: [], cloudInsertionIndex: 0 },
      requirements: { layers: [], cloudInsertionIndex: 0 },
    })
    expect(Object.keys(result)).toEqual(["userHomeDir", "codexHomeDir", "hostname", "config", "requirements"])
  })

  test("a user config layer keeps only the requested paths", async () => {
    const base = await scratch()
    const codexHome = path.join(base, "home", ".codex")
    await put(path.join(codexHome, "config.toml"), '[mcp_servers.synthetic]\ncommand = "/synthetic/bin/server"\nargs = []\n\n[shell_environment_policy]\ninherit = "all"\n')
    const result = await read(base, path.join(base, "home"), [["mcp_servers"]], [["mcp_servers"]])
    expect(result.config).toEqual({
      layers: [
        {
          source: `user (${path.join(codexHome, "config.toml")})`,
          baseDir: CcaPolicy.toPathUri(codexHome),
          toml: '[mcp_servers.synthetic]\ncommand = "/synthetic/bin/server"\nargs = []\n',
        },
      ],
      cloudInsertionIndex: 0,
    })
    expect((await read(base, path.join(base, "home"), [["absent"]])).config.layers).toEqual([])
  })

  test("trusted project layers load from the project root to cwd, sanitized; untrusted projects are skipped", async () => {
    const base = await scratch()
    const repo = path.join(base, "repo")
    const other = path.join(base, "other")
    const nomark = path.join(base, "nomark")
    const codexHome = path.join(base, "home", ".codex")
    await put(path.join(codexHome, "config.toml"), `sandbox_mode = "workspace-write"\n[projects."${repo}"]\ntrust_level = "trusted"\n[projects."${other}"]\ntrust_level = "untrusted"\n[projects."${nomark}"]\ntrust_level = "trusted"\n`)
    await put(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
    await put(path.join(repo, ".codex", "config.toml"), 'sandbox_mode = "read-only"\nmodel_provider = "x"\nopenai_base_url = "y"\n[features]\ncredential_masking = true\nkeep = 1\n')
    await put(path.join(repo, "pkg", ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n')
    await mkdir(path.join(repo, "pkg", "deep"), { recursive: true })
    await put(path.join(other, ".git", "HEAD"), "ref: x\n")
    await put(path.join(other, ".codex", "config.toml"), 'sandbox_mode = "read-only"\n')
    await put(path.join(nomark, ".codex", "config.toml"), 'sandbox_mode = "read-only"\n')
    const user = { source: `user (${path.join(codexHome, "config.toml")})`, baseDir: CcaPolicy.toPathUri(codexHome), toml: 'sandbox_mode = "workspace-write"\n' }

    const nested = await read(base, path.join(repo, "pkg", "deep"), [["sandbox_mode"], ["model_provider"], ["features"]], [["sandbox_mode"]])
    expect(nested.config).toEqual({
      layers: [
        user,
        { source: `project (${path.join(repo, ".codex")}/config.toml)`, baseDir: CcaPolicy.toPathUri(path.join(repo, ".codex")), toml: 'sandbox_mode = "read-only"\n\n[features]\nkeep = 1\n' },
        { source: `project (${path.join(repo, "pkg", ".codex")}/config.toml)`, baseDir: CcaPolicy.toPathUri(path.join(repo, "pkg", ".codex")), toml: 'sandbox_mode = "danger-full-access"\n' },
      ],
      cloudInsertionIndex: 0,
    })
    expect(nested.requirements).toEqual({ layers: [], cloudInsertionIndex: 0 })
    expect((await read(base, other, [["sandbox_mode"]])).config.layers).toEqual([user])
    expect((await read(base, nomark, [["sandbox_mode"]])).config.layers).toEqual([
      user,
      { source: `project (${path.join(nomark, ".codex")}/config.toml)`, baseDir: CcaPolicy.toPathUri(path.join(nomark, ".codex")), toml: 'sandbox_mode = "read-only"\n' },
    ])
    expect((await read(base, path.join(base, "missing", "dir"), [["sandbox_mode"]])).config.layers).toEqual([user])
  })

  test("system config and requirements layers set the cloud insertion index", async () => {
    const base = await scratch()
    await put(path.join(base, "etc", "config.toml"), 'sandbox_mode = "read-only"\n')
    await put(path.join(base, "etc", "requirements.toml"), 'allowed_sandbox_modes = ["read-only"]\n')
    await put(path.join(base, "home", ".codex", "config.toml"), 'sandbox_mode = "workspace-write"\n')
    const result = await read(base, path.join(base, "home"), [["sandbox_mode"]], [["allowed_sandbox_modes"]])
    expect(result.config.cloudInsertionIndex).toBe(1)
    expect(result.config.layers.map((layer) => layer.source)).toEqual([
      `system (${path.join(base, "etc", "config.toml")})`,
      `user (${path.join(base, "home", ".codex", "config.toml")})`,
    ])
    expect(result.requirements).toEqual({
      layers: [{ source: path.join(base, "etc", "requirements.toml"), baseDir: CcaPolicy.toPathUri(path.join(base, "etc")), toml: 'allowed_sandbox_modes = ["read-only"]\n' }],
      cloudInsertionIndex: 1,
    })
  })

  test("bad paths and unreadable configuration answer the upstream error codes", async () => {
    const base = await scratch()
    const home = path.join(base, "home")
    expect(await failure(read(base, home, [], []))).toMatchObject({ code: -32602, message: "at least one config or requirements path is required" })
    expect(await failure(read(base, home, [[]]))).toMatchObject({ code: -32602, message: "TOML paths must contain at least one key segment" })
    await put(path.join(home, ".codex", "config.toml"), "bad = = 1\n")
    const parse = await failure(read(base, home, [["bad"]]))
    expect(parse?.code).toBe(-32603)
    expect(parse?.message).toStartWith(`failed to load executor-local config: ${path.join(home, ".codex", "config.toml")}:1:7: `)
    const missingHome = await failure(read(base, home, [["a"]], [], { codexHomeEnv: path.join(base, "nope") }))
    expect(missingHome).toMatchObject({ code: -32603, message: `failed to find Codex home: CODEX_HOME points to ${JSON.stringify(path.join(base, "nope"))}, but that path does not exist` })
  })
})

describe("environmentConfig/read upstream loader parity (config/loader local.rs, mod.rs)", () => {
  const trusted = (...dirs: string[]) => dirs.map((dir) => `[projects."${dir}"]\ntrust_level = "trusted"\n`).join("")
  const brokerEnabled = '[features.network_proxy]\ncredential_broker = true\nenabled = true\n[features.network_proxy.credentials.custom]\nenv = ["CUSTOM_KEY"]\nurl_prefix_from_env = "CUSTOM_URL"\n'
  const projectShell = [
    "[shell_environment_policy]",
    "experimental_use_profile = true",
    'inherit = "all"',
    "[shell_environment_policy.set]",
    'BASH_ENV = "x"',
    'zdotdir = "y"',
    'GH_TOKEN = "z"',
    'CUSTOM_KEY = "w"',
    'CUSTOM_URL = "u"',
    'OPENAI_BASE_URL = "o"',
    'KEEP = "v"',
    "[tui.keymap.chat]",
    'previous_permission_mode = "a"',
    'next_permission_mode = "b"',
    'other = "c"',
    "",
  ].join("\n")
  const projectLayer = (dir: string, toml: string) => ({ source: `project (${path.join(dir, ".codex")}/config.toml)`, baseDir: CcaPolicy.toPathUri(path.join(dir, ".codex")), toml })

  test("managed_config.toml becomes a legacy requirements layer after the system requirements", async () => {
    const base = await scratch()
    const etc = path.join(base, "etc")
    await put(path.join(etc, "requirements.toml"), 'allowed_sandbox_modes = ["read-only"]\n')
    await put(path.join(etc, "managed_config.toml"), 'approval_policy = "on-failure"\napprovals_reviewer = "guardian_subagent"\nsandbox_mode = "workspace-write"\nmodel = "synthetic"\n')
    const requirementsPaths = [["allowed_approval_policies"], ["allowed_approvals_reviewers"], ["allowed_sandbox_modes"]]
    const result = await read(base, path.join(base, "home"), [["sandbox_mode"]], requirementsPaths)
    expect(result.requirements).toEqual({
      layers: [
        { source: path.join(etc, "requirements.toml"), baseDir: CcaPolicy.toPathUri(etc), toml: 'allowed_sandbox_modes = ["read-only"]\n' },
        {
          source: path.join(etc, "managed_config.toml"),
          baseDir: CcaPolicy.toPathUri(etc),
          toml: 'allowed_approval_policies = ["on-request"]\nallowed_approvals_reviewers = ["auto_review", "user"]\nallowed_sandbox_modes = ["read-only", "workspace-write"]\n',
        },
      ],
      cloudInsertionIndex: 1,
    })
    expect(result.config.layers).toEqual([
      { source: `legacy managed_config.toml (${path.join(etc, "managed_config.toml")})`, baseDir: CcaPolicy.toPathUri(etc), toml: 'sandbox_mode = "workspace-write"\n' },
    ])

    await rm(path.join(etc, "requirements.toml"))
    await put(path.join(etc, "managed_config.toml"), 'approval_policy = { granular = { sandbox_approval = true, rules = false, mcp_elicitations = true } }\nsandbox_mode = "read-only"\n')
    expect((await read(base, path.join(base, "home"), [["sandbox_mode"]], requirementsPaths)).requirements).toEqual({
      layers: [
        {
          source: path.join(etc, "managed_config.toml"),
          baseDir: CcaPolicy.toPathUri(etc),
          toml: 'allowed_sandbox_modes = ["read-only"]\n\n[[allowed_approval_policies]]\n\n[allowed_approval_policies.granular]\nsandbox_approval = true\nrules = false\nskill_approval = false\nrequest_permissions = false\nmcp_elicitations = true\n',
        },
      ],
      cloudInsertionIndex: 0,
    })

    await put(path.join(etc, "managed_config.toml"), 'approval_policy = "sometimes"\n')
    const invalid = await failure(read(base, path.join(base, "home"), [["sandbox_mode"]], requirementsPaths))
    expect(invalid?.code).toBe(-32603)
    expect(invalid?.message).toStartWith("failed to load executor-local config: Failed to parse config requirements as TOML: ")
  })

  test("trusted project config cannot inject a shell environment while the credential broker is enabled", async () => {
    const base = await scratch()
    const repo = path.join(base, "repo")
    await put(path.join(base, "home", ".codex", "config.toml"), brokerEnabled + trusted(repo))
    await put(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
    await put(path.join(repo, ".codex", "config.toml"), projectShell)
    const enabled = await read(base, repo, [["shell_environment_policy"], ["tui"]])
    expect(enabled.config.layers).toEqual([projectLayer(repo, '[shell_environment_policy]\ninherit = "all"\n\n[shell_environment_policy.set]\nKEEP = "v"\n\n[tui.keymap.chat]\nother = "c"\n')])

    await put(path.join(base, "home", ".codex", "config.toml"), trusted(repo))
    const unconfigured = await read(base, repo, [["shell_environment_policy"], ["tui"]])
    expect(unconfigured.config.layers).toEqual([
      projectLayer(
        repo,
        '[shell_environment_policy]\nexperimental_use_profile = true\ninherit = "all"\n\n[shell_environment_policy.set]\nBASH_ENV = "x"\nzdotdir = "y"\nGH_TOKEN = "z"\nCUSTOM_KEY = "w"\nCUSTOM_URL = "u"\nOPENAI_BASE_URL = "o"\nKEEP = "v"\n\n[tui.keymap.chat]\nother = "c"\n',
      ),
    ])
  })

  test("a boolean network_proxy feature merges with a later table when deciding the broker state", async () => {
    const base = await scratch()
    const repo = path.join(base, "repo")
    await put(path.join(base, "etc", "config.toml"), "[features]\nnetwork_proxy = true\n")
    await put(path.join(base, "home", ".codex", "config.toml"), "[features.network_proxy]\ncredential_broker = true\n" + trusted(repo))
    await put(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
    await put(path.join(repo, ".codex", "config.toml"), '[shell_environment_policy.set]\nBASH_ENV = "x"\nKEEP = "v"\n')
    const result = await read(base, repo, [["shell_environment_policy"]])
    expect(result.config.layers).toEqual([projectLayer(repo, '[shell_environment_policy.set]\nKEEP = "v"\n')])
  })

  test("linked worktrees take hooks from the matching root-checkout layer; forged worktree pointers gain no trust", async () => {
    const base = await realpath(await scratch())
    const main = path.join(base, "main")
    const wt = path.join(base, "wt")
    const forged = path.join(base, "forged")
    await put(path.join(base, "home", ".codex", "config.toml"), trusted(main))
    await put(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await put(path.join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/wt\n")
    await put(path.join(main, ".git", "worktrees", "wt", "commondir"), "../..\n")
    await put(path.join(main, ".git", "worktrees", "wt", "gitdir"), `${wt}/.git\n`)
    await put(path.join(wt, ".git"), `gitdir: ${main}/.git/worktrees/wt\n`)
    await put(path.join(main, ".codex", "config.toml"), 'sandbox_mode = "read-only"\n[hooks]\nmain = 1\n')
    await put(path.join(main, "sub", ".codex", "config.toml"), "[hooks]\nsub = 1\n")
    await put(path.join(wt, ".codex", "config.toml"), 'sandbox_mode = "workspace-write"\n[hooks]\nwt = 1\n')
    await mkdir(path.join(wt, "sub", ".codex"), { recursive: true })
    await mkdir(path.join(wt, "sub", "deep"), { recursive: true })
    const result = await read(base, path.join(wt, "sub", "deep"), [["sandbox_mode"], ["hooks"]])
    expect(result.config.layers).toEqual([
      projectLayer(wt, 'sandbox_mode = "workspace-write"\n'),
      projectLayer(main, "[hooks]\nmain = 1\n"),
      projectLayer(path.join(main, "sub"), "[hooks]\nsub = 1\n"),
    ])

    await put(path.join(forged, ".git"), `gitdir: ${main}/.git/worktrees/wt\n`)
    await put(path.join(forged, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n')
    expect((await read(base, forged, [["sandbox_mode"], ["hooks"]])).config.layers).toEqual([])
  })

  test("a .codex folder reached through a symlink loads as a project layer", async () => {
    const base = await scratch()
    const linked = path.join(base, "linked")
    await put(path.join(base, "home", ".codex", "config.toml"), trusted(linked))
    await put(path.join(linked, ".git", "HEAD"), "ref: x\n")
    await put(path.join(base, "real-codex", "config.toml"), 'sandbox_mode = "read-only"\n')
    await symlink(path.join(base, "real-codex"), path.join(linked, ".codex"))
    expect((await read(base, linked, [["sandbox_mode"]])).config.layers).toEqual([projectLayer(linked, 'sandbox_mode = "read-only"\n')])
  })

  test("untrusted project config is still read: read errors fail, parse errors are ignored", async () => {
    const base = await scratch()
    const untrusted = path.join(base, "untrusted")
    await put(path.join(base, "home", ".codex", "config.toml"), `[projects."${untrusted}"]\ntrust_level = "untrusted"\n`)
    await put(path.join(untrusted, ".git", "HEAD"), "ref: x\n")
    const file = path.join(untrusted, ".codex", "config.toml")
    await put(file, "sandbox_mode = 'read-only'\n")
    await chmod(file, 0o000)
    try {
      expect(await failure(read(base, untrusted, [["sandbox_mode"]]))).toMatchObject({
        code: -32603,
        message: `failed to load executor-local config: Failed to read project config file ${file}: Permission denied (os error 13)`,
      })
    } finally {
      await chmod(file, 0o644)
    }
    await put(file, "bad = = 1\n")
    expect((await read(base, untrusted, [["sandbox_mode"], ["bad"]])).config.layers).toEqual([])
  })
})

describe("environmentConfig/read credential-broker state from requirements (loader apply_credential_broker_requirements)", () => {
  const projectConfig = '[shell_environment_policy]\nexperimental_use_profile = true\n[shell_environment_policy.set]\nBASH_ENV = "x"\nKEEP = "v"\n[features]\nshell_snapshot = true\nnetwork_proxy = true\nkeep = 1\n'
  const stripped = '[shell_environment_policy.set]\nKEEP = "v"\n\n[features]\nkeep = 1\n'
  const untouched = '[shell_environment_policy]\nexperimental_use_profile = true\n\n[shell_environment_policy.set]\nBASH_ENV = "x"\nKEEP = "v"\n\n[features]\nshell_snapshot = true\nnetwork_proxy = true\nkeep = 1\n'
  const disabled = '[shell_environment_policy]\nexperimental_use_profile = true\n\n[shell_environment_policy.set]\nBASH_ENV = "x"\nKEEP = "v"\n\n[features]\nshell_snapshot = true\nkeep = 1\n'

  async function setup(user: string, requirements?: string) {
    const base = await scratch()
    const repo = path.join(base, "repo")
    await put(path.join(base, "home", ".codex", "config.toml"), `${user}[projects."${repo}"]\ntrust_level = "trusted"\n`)
    if (requirements !== undefined) await put(path.join(base, "etc", "requirements.toml"), requirements)
    await put(path.join(repo, ".git", "HEAD"), "ref: x\n")
    await put(path.join(repo, ".codex", "config.toml"), projectConfig)
    const projectToml = async () => {
      const result = await read(base, repo, [["shell_environment_policy"], ["features"]])
      return result.config.layers.filter((layer) => layer.source.startsWith("project ")).map((layer) => layer.toml)
    }
    return { base, repo, projectToml }
  }

  test("trusted credential_masking turns on the broker sanitizer without a configured broker", async () => {
    expect(await (await setup("[features]\ncredential_masking = true\n")).projectToml()).toEqual([stripped])
    expect(await (await setup("[features]\ncredential_masking = false\n")).projectToml()).toEqual([untouched])
  })

  test("requirements that enable credential masking turn on the broker sanitizer", async () => {
    expect(await (await setup("", "[features]\ncredential_masking = true\n")).projectToml()).toEqual([stripped])
    expect(await (await setup("", "[feature_requirements]\ncredential_masking = true\n")).projectToml()).toEqual([stripped])
    expect(await (await setup("[features]\ncredential_masking = true\n", "[features]\ncredential_masking = false\n")).projectToml()).toEqual([untouched])
  })

  test("requirements can disable the broker: network_proxy = false or experimental_network.enabled = false", async () => {
    const broker = "[features.network_proxy]\ncredential_broker = true\nenabled = true\n"
    expect(await (await setup(broker)).projectToml()).toEqual([stripped])
    expect(await (await setup(broker, "[features]\nnetwork_proxy = false\n")).projectToml()).toEqual([disabled])
    expect(await (await setup("", "[features]\ncredential_masking = true\n[experimental_network]\nenabled = false\n")).projectToml()).toEqual([disabled])
    expect(await (await setup("[features.network_proxy]\ncredential_broker = true\n", "[features]\nnetwork_proxy = true\n")).projectToml()).toEqual([stripped])
  })

  test("invalid broker requirements fail the read", async () => {
    for (const requirements of ['[features]\ncredential_masking = "yes"\n', "[features]\nnetwork_proxy = true\n[feature_requirements]\ncredential_masking = true\n", '[experimental_network]\nenabled = "no"\n']) {
      const { base, repo } = await setup("", requirements)
      const error = await failure(read(base, repo, [["features"]]))
      expect(error?.code).toBe(-32603)
      expect(error?.message).toStartWith(`failed to load executor-local config: failed to parse requirements layer ${path.join(base, "etc", "requirements.toml")}: `)
    }
  })
})
