import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { CliOutput, Command, type HelpDoc } from "effect/unstable/cli"
import { OpenApi } from "effect/unstable/httpapi"
import { Config } from "@ycoding-ai/core/config"
import { ConfigSkillPlugin } from "@ycoding-ai/core/config/plugin/skill"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Skill } from "@ycoding-ai/core/skill"
import { SkillDiscovery } from "@ycoding-ai/core/skill/discovery"
import { ClientApi } from "@ycoding-ai/protocol/client"
import { ycodingDotsSkillsRoot } from "../src/remote-control/session-operator-skill"
import { Commands } from "../src/commands/commands"
import { TuiCommand } from "../src/commands/tui"
import type { Spec } from "../src/framework/spec"
import { emptyMcpLayer } from "../../core/test/fixture/mcp"
import { location } from "../../core/test/fixture/location"
import { host } from "../../core/test/plugin/host"

const permissionTest = process.platform === "win32" ? test.skip : test

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("the default Dots skill root uses Global data, outside the agents skill tree", () => {
  expect(ycodingDotsSkillsRoot()).toBe(path.join(Global.Path.data, "dots", "skills"))
  expect(path.relative(path.join(Global.Path.home, ".agents", "skills"), ycodingDotsSkillsRoot()).startsWith("..")).toBe(true)
})

test("operator instructions retain refusal, delegation, pending-answer and stop boundaries", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  for (const text of [
    "YCODING_SESSION_ID", "~/.local/bin/ycoding", "first command selects its project root or working directory",
    "action and risk", "retry the identical action only when the refusal confirms it did not run",
    "Treat “the user rejected” as final", "Never rephrase or work around a refused command",
    "ycoding decision list --json", "free-text answers for open questions", "the review box is full",
    "only when they authorized that in this chat; quote that instruction", "require an explicit yes for that item",
    "--permissions manual --guardrails auto --answers manual", "--session <session-id>",
    "Pressing Stop in Dots does not stop commands on V", "pgrep -fl", "pkill -f",
    "Dots callers have no direct access", "Never print or echo secret values",
  ]) expect(sessionOperatorSkill).toContain(text)
  expect(sessionOperatorSkill.indexOf("pgrep -fl")).toBeLessThan(sessionOperatorSkill.indexOf("pkill -f"))
})

test("operator instructions document the native Dots access and Remote recovery boundaries", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  for (const text of [
    "host-user execution", "explicit OpenAI OAuth `dots.profile`", "Remove `dots.fullAccessExecutor`",
    "Do not rely on a sandbox, Location roots, environment filtering, or Session Permissions or Guardrails",
    "Turn Dots access Off to revoke new native access", "Do not assume a native executor process has a runtime deadline",
    "Do not select Antigravity or Muse", "On a failed state read, leave the setting unchanged",
    "Do not reenroll automatically", "production composition failed:",
  ]) expect(sessionOperatorSkill).toContain(text)
})

test("operator watch instructions never treat a settled execution as finished work", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  for (const text of [
    "work.state", "completed only when a current accepted completion receipt", "Every other state is unfinished",
    "Watch the next transition", "never answer, approve, resume or retry work", "descendants' work and decisions",
    "native v5 one-shot watch", 'assessment: "unavailable"', "HTTP/SSE watch endpoints", "family `--checkpoint`",
  ]) expect(sessionOperatorSkill).toContain(text)
})

test("operator watch instructions describe push delivery to the Dot thread without approval authority", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  for (const text of [
    "ycoding decision watch <root-session-id> --family --follow --state <private-dir>/state.json --deliver dot",
    "`dot` resolves to the Dot's current root thread on every delivery pass", "A pushed message approves nothing",
    "Without a running follow watch nothing is pushed",
  ]) expect(sessionOperatorSkill).toContain(text)
  expect(sessionOperatorSkill).not.toContain("cannot wake an idle Dots conversation")
})

test("operator guidance specifies parallel member lanes and durable two-target watch delivery", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  for (const text of [
    "Scale direct subagents from zero to five across independent file and check lanes",
    "one writer per file", "leave edits, builds and delivery to member Sessions",
    "--deliver dot --deliver <task-thread-id>",
    "`dot` resolves to the Dot's current root thread on every delivery pass",
    "Use the same `--state` when adding targets: existing deliveries stay queued and new targets receive only new events",
    "Do not remove a target with undelivered events",
    "`dot` sends through the Dot's messaging room, while an auto-archived task thread is unarchived automatically before sending.",
  ]) expect(sessionOperatorSkill.split(text)).toHaveLength(2)
})

test("operator guidance honors explicit main-agent versus subagent provider, model, variant and profile splits", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const rule = "Honor explicit main-agent versus subagent provider, model, variant and profile splits: keep the main Session on its designated model and profile, switch active children and launch subagents on their designated subagent model and profile, and never substitute another profile."
  expect(sessionOperatorSkill.split(rule)).toHaveLength(2)
  const delegation = sessionOperatorSkill.indexOf("Scale direct subagents from zero to five")
  expect(delegation).toBeGreaterThan(-1)
  expect(sessionOperatorSkill.indexOf(rule)).toBeGreaterThan(delegation)
  expect(sessionOperatorSkill.indexOf(rule)).toBeLessThan(sessionOperatorSkill.indexOf("Launch requires an actual parent assistant-message ID"))
})

test("operator instructions create a YCoding coordination thread with computer V selected", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  expect(sessionOperatorSkill).toContain("When creating a YCoding coordination thread, create it with computer V selected.")
})

test("operator reconciles proceedable idle work and defers only exact human gates without empty nudges", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  for (const text of [
    "open root todos", "attached Project members and their recorded owners", "progressing children/shells", "latest receipts/messages",
    "Never interrupt progressing work, duplicate active execution or invent wake mechanisms",
    'Never send content-free "continue" or "status" nudges',
    "next specific concrete authorized action", "exact target, evidence and expected deliverable",
    "Whether the user is present or unavailable", "Defer only genuinely user-dependent steps",
    "keep the pending request open or in the review box", "exact pending question/review ID, decide command and resume condition",
    "Never treat silence as approval", "Continue independent authorized work",
    "completed (task complete), open-questions, recovery-needed and unfinished-idle", "not an exhaustive model",
  ]) expect(sessionOperatorSkill).toContain(text)
})

test("operator Library instructions select only the private process channel and preserve its gates", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  for (const text of [
    "/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process python3 <helper-path> < /approved/library-upload.json",
    "beginning of the exec_command cmd, before launch", "a shell export inside an already running process does not select the channel", "account connectors enabled",
    "exact Dots principal", "default model account", "chatgpt_library_upload", "mcp_execute",
    "one create_library_file", "20 MiB", "process sandbox", "signed URLs or OAuth values",
    "default or custom HostedApps endpoints", "never fall back", "runtime build implementing the private marker",
    "python3 <helper-path> < /approved/library-upload.json", "not inline image display",
  ]) expect(sessionOperatorSkill).toContain(text)
  expect(sessionOperatorSkill).not.toContain('{"env":{"CODEX_APPS_MCP_URL":"ycoding-library://process"}}')
  const example = sessionOperatorSkill.match(/\{"uploads":\[\{"local_path":"\/approved\/output.png"[^\n]+/)
  expect(example).not.toBeNull()
  expect(JSON.parse(example![0])).toEqual({ uploads: [{ local_path: "/approved/output.png", purpose: "create_library_file" }] })
})

test("the exported operator skill equals the pinned shared Markdown bytes", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const markdown = await readFile(path.join(import.meta.dir, "..", "src", "remote-control", "session-operator.md"), "utf8")
  expect(sessionOperatorSkill).toBe(markdown)
  const bytes = new TextEncoder().encode(sessionOperatorSkill)
  expect(bytes.byteLength).toBe(30_366)
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("241dae490283dd37951d7e415d290d2876bf3cf45b55004f4489b455ab2383b9")
  expect(sessionOperatorSkill.endsWith("\n")).toBe(true)
  const source = await readFile(path.join(import.meta.dir, "..", "src", "remote-control", "session-operator-skill.ts"), "utf8")
  expect(source).toContain('from "./session-operator.md" with { type: "text" }')
  expect(source).not.toContain("# YCoding Operator")
})

test("ensure writes an absent operator skill under the Dots root", async () => {
  const { ensureSessionOperatorSkill, sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "session-operator-absent-"))
  directories.push(root)
  const data = path.join(root, "data")
  await ensureSessionOperatorSkill(data)
  expect(await readFile(path.join(data, "dots", "skills", "session-operator", "SKILL.md"), "utf8")).toBe(sessionOperatorSkill)
})

test("ensure leaves an equal operator skill untouched", async () => {
  const { ensureSessionOperatorSkill, sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "session-operator-equal-"))
  directories.push(root)
  const file = path.join(root, "data", "dots", "skills", "session-operator", "SKILL.md")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, sessionOperatorSkill, "utf8")
  const modified = new Date(1_000_000_000_000)
  await utimes(file, modified, modified)
  await ensureSessionOperatorSkill(path.join(root, "data"))
  expect(await readFile(file, "utf8")).toBe(sessionOperatorSkill)
  expect((await stat(file)).mtimeMs).toBe(modified.getTime())
})

test("ensure replaces stale operator skill bytes", async () => {
  const { ensureSessionOperatorSkill, sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "session-operator-stale-"))
  directories.push(root)
  const file = path.join(root, "data", "dots", "skills", "session-operator", "SKILL.md")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, "synthetic stale operator skill\n", "utf8")
  await ensureSessionOperatorSkill(path.join(root, "data"))
  expect(await readFile(file, "utf8")).toBe(sessionOperatorSkill)
})

test("ensure propagates a non-missing read failure", async () => {
  const { ensureSessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "session-operator-read-error-"))
  directories.push(root)
  const file = path.join(root, "data", "dots", "skills", "session-operator", "SKILL.md")
  await mkdir(file, { recursive: true })
  const read = await readFile(file, "utf8").then(() => undefined, (error: unknown) => error)
  const failure = await ensureSessionOperatorSkill(path.join(root, "data")).then(() => undefined, (error: unknown) => error)
  expect(read).toBeDefined()
  expect((failure as { code?: string }).code).toBe((read as { code?: string }).code)
  expect((failure as { code?: string }).code).not.toBe("ENOENT")
})

test("ensure propagates a blocked-ancestor read failure without reaching directory creation", async () => {
  const { ensureSessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "session-operator-blocked-ancestor-"))
  directories.push(root)
  const blockedRoot = path.join(root, "blocked-root")
  await writeFile(blockedRoot, "synthetic file in place of the data directory\n", "utf8")
  const file = path.join(blockedRoot, "dots", "skills", "session-operator", "SKILL.md")
  const read = await readFile(file, "utf8").then(() => undefined, (error: unknown) => error)
  const failure = await ensureSessionOperatorSkill(blockedRoot).then(() => undefined, (error: unknown) => error)
  expect(read).toBeDefined()
  expect((failure as { code?: string }).code).toBe((read as { code?: string }).code)
  expect((failure as { code?: string }).code).not.toBe("ENOENT")
})

permissionTest("ensure propagates a directory-creation failure after a missing read", async () => {
  const { ensureSessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "session-operator-mkdir-error-"))
  directories.push(root)
  const data = path.join(root, "data")
  await mkdir(data)
  const file = path.join(data, "dots", "skills", "session-operator", "SKILL.md")
  const read = await readFile(file, "utf8").then(() => undefined, (error: unknown) => error)
  expect((read as { code?: string }).code).toBe("ENOENT")
  await chmod(data, 0o555)
  try {
    const probe = await mkdir(path.join(data, "probe")).then(() => undefined, (error: unknown) => error)
    expect((probe as { code?: string }).code).toBe("EACCES")
    const failure = await ensureSessionOperatorSkill(data).then(() => undefined, (error: unknown) => error)
    expect((failure as { code?: string }).code).toBe("EACCES")
  } finally {
    await chmod(data, 0o755)
  }
})

permissionTest("ensure propagates a write failure and keeps the stale bytes", async () => {
  const { ensureSessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "session-operator-write-error-"))
  directories.push(root)
  const file = path.join(root, "data", "dots", "skills", "session-operator", "SKILL.md")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, "synthetic stale operator skill\n", "utf8")
  await chmod(file, 0o444)
  try {
    const failure = await ensureSessionOperatorSkill(path.join(root, "data")).then(() => undefined, (error: unknown) => error)
    expect((failure as { code?: string }).code).toBe("EACCES")
    expect(await readFile(file, "utf8")).toBe("synthetic stale operator skill\n")
  } finally {
    await chmod(file, 0o644)
  }
})

test("operator API operation ids and example bodies match the current Protocol", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const spec = OpenApi.fromApi(ClientApi)
  const endpoints = Object.values(ClientApi.groups).flatMap((group) => Object.values(group.endpoints))
  const operations = new Map(Object.entries(spec.paths).flatMap(([route, methods]) => Object.entries(methods).flatMap(([method, operation]) => {
    if (typeof operation !== "object" || operation === null || !("operationId" in operation)) return []
    const endpoint = endpoints.find((endpoint) => endpoint.method.toLowerCase() === method && endpoint.path.replaceAll(/:([\w]+)/g, "{$1}") === route)
    return endpoint === undefined ? [] : [[operation.operationId, endpoint] as const]
  })))
  const operationIDs = new Set(Object.values(spec.paths).flatMap((item) => Object.values(item).flatMap((operation) =>
    typeof operation === "object" && operation !== null && "operationId" in operation ? [operation.operationId] : [],
  )))
  const mentions = [...sessionOperatorSkill.matchAll(/(?:ycoding api |`)([\w.-]+\.[\w.-]+)(?=[\s`/])/g)]
  const mentioned = new Set(mentions.map((mention) => mention[1]))
  for (const required of [
    "session.review.decide", "session.autonomy.get", "session.autonomy.set", "keepAwake.get", "keepAwake.set",
    "session.list", "session.get", "command.list", "skill.list", "session.command", "session.skill", "session.prompt", "session.create",
    "message.list", "session.message", "session.interrupt", "session.fork", "session.archive",
    "agent.list", "model.list", "model.default", "provider.list", "provider.get", "session.switchModel", "session.switchAgent",
    "session.subagent.list", "session.subagent.launch", "session.subagent.message", "session.subagent.cancel", "session.subagent.resume", "session.subagent.switchModel",
    "mcp.list", "mcp.connect", "mcp.disconnect", "mcp.resource.catalog", "shell.list", "shell.get", "shell.output", "pty.list", "pty.get", "fs.find",
    "browser.start", "browser.tabs", "browser.open", "browser.observe", "browser.action", "browser.close",
    "isolatedBrowser.start", "isolatedBrowser.tabs", "isolatedBrowser.observe", "isolatedBrowser.action", "isolatedBrowser.stop",
    "project.list", "project.inventory", "project.current", "project.directories", "project.forget",
    "session.snapshot", "session.pending.list", "session.active", "session.outstanding", "session.wait", "session.log",
    "session.rename", "session.unarchive", "session.remove", "session.pin", "session.unpin", "session.synthetic",
    "session.file-change.list", "message.capturedInputs", "vcs.status", "vcs.diff", "session.diagnostics",
    "session.usage", "session.usageReport", "session.promptCosts", "session.taskCosts", "usage.get", "usage.report", "usage.dashboard",
    "providerUsage.list", "providerUsage.forecast", "incident.report", "incident.recent", "incident.guidance.get", "incident.guidance.clear",
    "config.diagnostics", "integration.list", "integration.get", "integration.connect.key", "integration.oauth.connect", "integration.oauth.status", "integration.oauth.complete", "integration.oauth.cancel",
    "credential.refresh", "credential.update", "credential.activate", "credential.remove", "provider.integrations", "provider.refresh",
    "artifact.list", "artifact.get", "artifact.create", "artifact.update", "coordination.settings", "coordination.list", "coordination.get", "coordination.board", "coordination.create", "coordination.update", "coordination.delete", "coordination.attach", "coordination.detach",
    "shell.remove", "pty.create", "pty.update", "pty.remove", "pty.control", "pty.connect.token", "pty.connect",
    "dots.get", "dots.set", "dots.attach", "dots.detach", "dots.remove", "remote.get", "remote.set", "telemetry.list", "telemetry.consent.get", "telemetry.consent.set",
    "session.prediction", "session.promptGenerate", "session.compact", "session.compaction.list", "server.session.session.todo.list",
  ]) expect(mentioned.has(required)).toBe(true)
  for (const [, operation] of sessionOperatorSkill.matchAll(/ycoding api ([\w.-]+)(?=[\s`])/g)) {
    expect(operationIDs.has(operation), operation).toBe(true)
  }
  const examples = [...sessionOperatorSkill.matchAll(/ycoding api ([\w.-]+)[^\n`]*? -d '([^'\n]+)'/g)]
  expect(examples.length).toBeGreaterThanOrEqual(7)
  for (const example of examples) {
    const endpoint = operations.get(example[1]!)!
    const schema = endpoint.payload.values().next().value?.schemas[0]
    expect(schema).toBeDefined()
    expect(Schema.decodeUnknownSync(schema!)(JSON.parse(example[2]!))).toEqual(JSON.parse(example[2]!))
  }
})

test("operator discovery and conversation instructions preserve cross-project search and interactive decisions", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  for (const text of [
    "without directory/project filters", "--param parentID=null", "punctuation-free", "curly", "straight",
    "cursor.next", "broaden", "stored Session location", "streams assistant output", "waits for execution",
    "automatically rejects permissions, questions and guardrail requests", "cancels forms", "Admission is not completion",
    "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
    "No local API", "browser-local", "captured-change card", "side-chat",
  ]) expect(sessionOperatorSkill).toContain(text)
})

test("every operator CLI command and flag is advertised by both entrypoint specs", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const snippets = [
    ...sessionOperatorSkill.matchAll(/^ycoding(?: .*|)$/gm),
    ...sessionOperatorSkill.matchAll(/`(ycoding(?: [^`\n]+)?)`/g),
  ].map((match) => match[1] ?? match[0])
  expect(snippets.length).toBeGreaterThan(20)
  for (const root of [Commands, TuiCommand]) {
    const advertised = new Map<Spec.Any, Set<string>>()
    for (const snippet of snippets) {
      const tokens = snippet.split(/\s+/).slice(1)
      let node: Spec.Any = root
      while (tokens[0] !== undefined && tokens[0] in node.commands) node = node.commands[tokens.shift()!]!
      expect(node !== root || tokens.length === 0).toBe(true)
      if (Object.keys(node.commands).length > 0) expect(tokens.length).toBe(0)
      let flags = advertised.get(node)
      if (flags === undefined) {
        let doc: HelpDoc.HelpDoc | undefined
        const formatter = CliOutput.defaultFormatter()
        await Command.runWith(Command.withHandler(node.spec, () => Effect.die("unexpected command execution")), { version: "test" })(["--help"]).pipe(
          Effect.provide(CliOutput.layer({ ...formatter, formatHelpDoc: (value) => { doc = value; return "" } })),
          Effect.provide(NodeServices.layer),
          Effect.runPromise,
        )
        expect(doc).toBeDefined()
        flags = new Set(doc!.flags.flatMap((flag) => [`--${flag.name}`, ...flag.aliases.map((alias) => alias.startsWith("-") ? alias : `${alias.length === 1 ? "-" : "--"}${alias}`)]))
        advertised.set(node, flags)
      }
      for (const match of snippet.matchAll(/(?:^|\s)(--[\w-]+|-[A-Za-z])(?=\s|=|$)/g)) expect(flags.has(match[1]!)).toBe(true)
    }
  }
})

test("Core's configured skill listing excludes the Dots-only data root", async () => {
  const { ensureSessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "session-operator-isolation-"))
  directories.push(root)
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  const data = path.join(root, "data")
  await ensureSessionOperatorSkill(data)
  const normalRoot = path.join(home, ".agents", "skills", "visible-skill")
  await mkdir(normalRoot, { recursive: true })
  await writeFile(path.join(normalRoot, "SKILL.md"), "---\nname: visible-skill\ndescription: Synthetic visible skill.\n---\n# Visible\n")
  const entries = [
    new Config.AgentsDirectory({ type: "agents", path: AbsolutePath.make(path.join(home, ".agents")) }),
    new Config.ClaudeDirectory({ type: "claude", path: AbsolutePath.make(path.join(home, ".claude")) }),
    new Config.Directory({ type: "directory", path: AbsolutePath.make(path.join(home, ".config", "ycoding")) }),
    new Config.Directory({ type: "directory", path: AbsolutePath.make(path.join(project, ".ycoding")) }),
  ]
  const config = Layer.succeed(Config.Service, Config.Service.of({
    diagnostics: () => Effect.succeed([]), reload: () => Effect.void, entries: () => Effect.succeed(entries),
  }))
  const services = AppNodeBuilder.build(LayerNode.group([Skill.node, EventRuntime.node]), [
    [Config.node, config], [MCP.node, emptyMcpLayer],
    [SkillDiscovery.node, Layer.succeed(SkillDiscovery.Service, SkillDiscovery.Service.of({ pull: () => Effect.die("unexpected network skill") }))],
  ])
  await Effect.gen(function* () {
    const skill = yield* Skill.Service
    const currentLocation = yield* Location.Service
    yield* ConfigSkillPlugin.Plugin.effect(host({
      skill: {
        list: () => skill.list().pipe(Effect.map((data) => ({ location: new Location.Info(currentLocation), data }))),
        reload: skill.reload,
        transform: (callback) => skill.transform((draft) => callback({
          source: (source) => draft.source(Schema.decodeUnknownSync(Skill.Source)(source)),
          list: draft.list,
        })),
      },
    }))
    const sources = yield* skill.sources()
    expect(sources.length).toBe(6)
    for (const source of sources) {
      expect(source.type).toBe("directory")
      if (source.type === "directory") expect(path.relative(source.path, data).startsWith("..")).toBe(true)
    }
    expect((yield* skill.list()).map((item) => item.id)).toEqual([Skill.ID.make("visible-skill")])
  }).pipe(
    Effect.provide(services),
    Effect.provide(config),
    Effect.provideService(Global.Service, Global.Service.of(Global.make({ home, data }))),
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
    Effect.scoped,
    Effect.runPromise,
  )
  const awaitableSkillFile = await readFile(path.join(data, "dots", "skills", "session-operator", "SKILL.md"), "utf8")
  expect(awaitableSkillFile).toContain("name: session-operator")
})

test("operator instructions create project Sessions in the target project's path and never under the Master", async () => {
  const { sessionOperatorSkill } = await import("../src/remote-control/session-operator-skill")
  expect(sessionOperatorSkill).toContain("Create a project work Session in the target project's own directory or worktree, never the Master's or the task's path.")
  expect(sessionOperatorSkill).toContain("Never create a project work Session under the Master Session; it is a standalone root Session.")
})
