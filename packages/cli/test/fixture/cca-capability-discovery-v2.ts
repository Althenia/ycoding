import { chmod, mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"

export interface DiscoveryV2Tree {
  readonly root: string
  readonly home: string
  readonly codexHome: string
  readonly project: string
}

export async function write(root: string, relative: string, contents: string) {
  const file = path.join(root, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents)
}

async function tree(root: string): Promise<DiscoveryV2Tree> {
  for (const directory of ["home", "codex", "project"]) await mkdir(path.join(root, directory), { recursive: true })
  return { root, home: path.join(root, "home"), codexHome: path.join(root, "codex"), project: path.join(root, "project") }
}

const SKILL = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nPRIVATE_INSTRUCTION_BODY_SENTINEL\n`

export const ALPHA_METADATA = `interface:
  display_name: Alpha
dependencies:
  tools:
    - type: " env_var "
      value: " ALPHA_TOKEN "
      description: "  Token   for alpha "
    - type: mcp
      value: alpha-mcp
      transport: streamable_http
      url: https://example.invalid/mcp
      oauth:
        callbackPort: 4567
    - type: mcp
      value: deploy
      command: deploy-mcp
      oauth: {callback_port: 3118}
    - value: missing-type
    - type: mcp
      value: " "
policy:
  allow_implicit_invocation: false
  products: [codex, CHATGPT]
`

export async function writeInventoryTree(root: string): Promise<DiscoveryV2Tree> {
  const t = await tree(root)
  const w = (relative: string, contents: string) => write(root, relative, contents)
  await w("codex/config.toml", "invalid TOML [")
  await w("home/.agents/skills/user-one/SKILL.md", SKILL("user-one", "User skill"))
  await w("codex/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: \"  Alpha   skill  \"\nmetadata:\n  short-description: Short   alpha\n---\nPRIVATE_INSTRUCTION_BODY_SENTINEL\n")
  await w("codex/skills/alpha/agents/openai.yaml", ALPHA_METADATA)
  await w("codex/skills/colon/SKILL.md", "---\ndescription: Build for AWS: ECS # trailing note\nmetadata:\n  short-description: Nested: colon\n---\n")
  await w("codex/skills/scalars/SKILL.md", "---\nname: 123\ndescription: 1.0\n---\n")
  await w("codex/skills/booleans/SKILL.md", "---\nname: yes\ndescription: true\nmetadata:\n  short-description: ~\n---\n")
  await w("codex/skills/block/SKILL.md", "---\nname: block\ndescription: >\n  Folded\n  description\n---\n")
  await w("codex/skills/broken/SKILL.md", "no frontmatter here\n")
  await w("codex/skills/badmeta/SKILL.md", SKILL("badmeta", "Bad metadata"))
  await w("codex/skills/badmeta/agents/openai.yaml", "interface: [invalid]\n")
  await w("codex/skills/badproduct/SKILL.md", SKILL("badproduct", "Bad product"))
  await w("codex/skills/badproduct/agents/openai.yaml", "policy:\n  products: [unknown]\n")
  await w("codex/skills/ns/.codex-plugin/plugin.json", '{"name":"team"}')
  await w("codex/skills/ns/skills/inner/SKILL.md", SKILL("inner", "Namespaced"))
  await w("codex/skills/spaced  dir/SKILL.md", "---\ndescription: Default name\n---\n")

  const cache = "codex/plugins/cache"
  for (const version of ["1.9.0", "1.10.0", "1.10.0-beta.1"])
    await w(`${cache}/market/mail/${version}/.codex-plugin/plugin.json`, '{"name":"mail","interface":{"displayName":" Mail "}}')
  await w(`${cache}/market/mail/1.10.0/skills/search/SKILL.md`, SKILL("search", "Search mail"))
  await w(`${cache}/market/mail/1.10.0/.mcp.json`, '{"mcpServers":{"zeta":{"command":"z"},"alpha":{"command":"a"}}}')
  await w(`${cache}/market/mail/1.9.0/skills/old/SKILL.md`, SKILL("old", "Old mail"))

  await w(`${cache}/market/cal/local/.codex-plugin/plugin.json`, '{"name":" ","mcpServers":{"zeta":{"url":"https://example.invalid/z"},"alpha":{"command":"a","args":["x"]}}}')
  await w(`${cache}/market/cal/local/.mcp.json`, '{"wrong":{"command":"wrong"}}')
  await w(`${cache}/market/cal/9.0.0/.codex-plugin/plugin.json`, '{"name":"cal"}')

  for (const version of ["abc", "1.0.0", "2.0.0"]) await w(`${cache}/market/odd/${version}/.codex-plugin/plugin.json`, '{"name":"odd"}')

  await w(`${cache}/market/remote/1.0.0/.codex-plugin/plugin.json`, '{"name":"remote","apps":"./missing.app.json"}')
  await w(`${cache}/market/remote/.codex-remote-plugin-install.json`, '{"schema_version":1,"remote_plugin_id":"  plugins~remote  "}')

  await w(`${cache}/market/badremote/1.0.0/.codex-plugin/plugin.json`, '{"name":"badremote"}')
  await w(`${cache}/market/badremote/.codex-remote-plugin-install.json`, '{"schema_version":2,"remote_plugin_id":"plugins~bad"}')

  await w(`${cache}/market/nomanifest/1.0.0/README.md`, "no manifest\n")
  await w(`${cache}/market/invalidmanifest/1.0.0/.codex-plugin/plugin.json`, '{"name":5}')
  await mkdir(path.join(root, cache, "market", "empty"), { recursive: true })
  await w(`${cache}/market/badversion/bad version!/.codex-plugin/plugin.json`, '{"name":"badversion"}')
  await w(`${cache}/bad market!/thing/1.0.0/.codex-plugin/plugin.json`, '{"name":"thing"}')
  await w(`${cache}/market/file-not-dir`, "")
  return t
}

export async function writeLockedCacheTree(root: string): Promise<DiscoveryV2Tree> {
  const t = await tree(root)
  await write(root, "codex/skills/demo/SKILL.md", SKILL("demo", "Demo"))
  await write(root, "codex/plugins/cache/locked/demo/1.0.0/.codex-plugin/plugin.json", '{"name":"demo"}')
  await chmod(path.join(root, "codex/plugins/cache/locked"), 0o000)
  return t
}

export async function unlockCacheTree(root: string) {
  await chmod(path.join(root, "codex/plugins/cache/locked"), 0o755).catch(() => {})
}

export const LIMIT_PLUGINS = 513
export const LIMIT_SKILLS_PER_PLUGIN = 4

export async function writeLimitTree(root: string): Promise<DiscoveryV2Tree> {
  const t = await tree(root)
  for (let index = 0; index < LIMIT_PLUGINS; index++) {
    const name = `p${String(index).padStart(3, "0")}`
    const base = `codex/plugins/cache/market/${name}/1.0.0`
    await write(root, `${base}/.codex-plugin/plugin.json`, `{"name":"${name}"}`)
    for (let skill = 0; skill < LIMIT_SKILLS_PER_PLUGIN; skill++) await write(root, `${base}/skills/s${skill}/SKILL.md`, SKILL(`s${skill}`, "Limit skill"))
  }
  await write(root, "codex/skills/standalone/SKILL.md", SKILL("standalone", "Standalone"))
  return t
}

export function restrictedSandbox(readable: readonly string[], cwd: string) {
  return {
    permissions: {
      type: "managed",
      file_system: {
        type: "restricted",
        entries: readable.map((directory) => ({ path: { type: "path", path: CcaPolicy.toPathUri(directory) }, access: "read" })),
      },
      network: "restricted",
    },
    cwd: CcaPolicy.toPathUri(cwd),
    windowsSandboxLevel: "disabled",
  }
}

export async function normalizer(root: string) {
  const real = await realpath(root)
  const replacements = [
    [CcaPolicy.toPathUri(real), "file://{{REAL}}"],
    [CcaPolicy.toPathUri(root), "file://{{RAW}}"],
    [real, "{{REAL}}"],
    [root, "{{RAW}}"],
  ] as const
  return (value: unknown): unknown =>
    JSON.parse(
      replacements.reduce((text, [from, to]) => text.split(from).join(to), JSON.stringify(value)),
    )
}

export const ABSENT_PARAMS = Symbol("absent params")

const restricted = { type: "managed", file_system: { type: "restricted", entries: [] }, network: "restricted" }
const sandboxed = (extra: Record<string, unknown>) => ({
  cwd: "file:///tmp/p",
  sandbox: { permissions: { type: "disabled" }, cwd: "file:///tmp/p", windowsSandboxLevel: "disabled", ...extra },
})

export const PARAM_CASES: Readonly<Record<string, unknown>> = {
  "absent params": ABSENT_PARAMS,
  "null params": null,
  "string params": "x",
  "numeric params": 5,
  "empty seq": [],
  "seq cwd only": ["file:///tmp/p"],
  "seq cwd and null sandbox": ["file:///tmp/p", null],
  "seq three": ["file:///tmp/p", null, 1],
  "seq numeric": [5],
  "missing cwd": {},
  "numeric cwd": { cwd: 5 },
  "float cwd": { cwd: 1.5 },
  "boolean cwd": { cwd: true },
  "null cwd": { cwd: null },
  "map cwd": { cwd: {} },
  "seq cwd": { cwd: [] },
  "relative cwd": { cwd: "relative/path" },
  "empty cwd": { cwd: "" },
  "colon cwd": { cwd: ":x" },
  "https cwd": { cwd: "https://example.invalid/project" },
  "file relative": { cwd: "file:relative" },
  "file host": { cwd: "file://host/x" },
  "file empty path": { cwd: "file://" },
  "file only": { cwd: "file:" },
  "file percent": { cwd: "file:///tmp/a%2Fb" },
  "file backslash": { cwd: "file:///tmp\\p" },
  "file dots": { cwd: "file:///tmp/../p" },
  "uppercase scheme": { cwd: "FILE:///tmp/p" },
  "file query": { cwd: "file:///tmp/p?x=1" },
  "file empty query": { cwd: "file:///tmp/p?" },
  "file fragment": { cwd: "file:///tmp/p#x" },
  "unknown field": { cwd: "file:///tmp/p", extra: 1 },
  "sandbox before missing cwd": { sandbox: 5 },
  "null sandbox": { cwd: "file:///tmp/p", sandbox: null },
  "string sandbox": { cwd: "file:///tmp/p", sandbox: "restricted" },
  "boolean sandbox": { cwd: "file:///tmp/p", sandbox: true },
  "negative sandbox": { cwd: "file:///tmp/p", sandbox: -1 },
  "empty seq sandbox": { cwd: "file:///tmp/p", sandbox: [] },
  "empty sandbox": { cwd: "file:///tmp/p", sandbox: {} },
  "sandbox missing cwd": { cwd: "file:///tmp/p", sandbox: { permissions: restricted } },
  "sandbox missing level": { cwd: "file:///tmp/p", sandbox: { permissions: restricted, cwd: "file:///tmp/p" } },
  "sandbox relative cwd": sandboxed({ cwd: "relative" }),
  "sandbox numeric permissions": sandboxed({ permissions: 5 }),
  "sandbox string permissions": sandboxed({ permissions: "x" }),
  "sandbox empty permissions": sandboxed({ permissions: {} }),
  "sandbox seq permissions": sandboxed({ permissions: [] }),
  "sandbox unknown permissions": sandboxed({ permissions: { type: "bogus" } }),
  "sandbox unknown level": sandboxed({ windowsSandboxLevel: "nope" }),
  "sandbox numeric level": sandboxed({ windowsSandboxLevel: 5 }),
  "sandbox null level": sandboxed({ windowsSandboxLevel: null }),
  "sandbox numeric roots": sandboxed({ workspaceRoots: 5 }),
  "sandbox string landlock": sandboxed({ useLegacyLandlock: "x" }),
  "sandbox unknown field": sandboxed({ zzz: 1 }),
  "sandbox full access": sandboxed({}),
}
