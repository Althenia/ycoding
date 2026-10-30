import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { CliOutput, Command, type HelpDoc } from "effect/unstable/cli"
import { OpenApi } from "effect/unstable/httpapi"
import { Config } from "@ycoding-ai/core/config"
import { ConfigSkillPlugin } from "@ycoding-ai/core/config/plugin/skill"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Skill } from "@ycoding-ai/core/skill"
import { SkillDiscovery } from "@ycoding-ai/core/skill/discovery"
import { ClientApi } from "@ycoding-ai/protocol/client"
import { ycodingDotsSkillsRoot } from "../src/remote-control/ycoding-operator-skill"
import { Commands } from "../src/commands/commands"
import { TuiCommand } from "../src/commands/tui"
import type { Spec } from "../src/framework/spec"
import { emptyMcpLayer } from "../../core/test/fixture/mcp"
import { location } from "../../core/test/fixture/location"
import { host } from "../../core/test/plugin/host"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("the default Dots skill root uses Global data, outside the agents skill tree", () => {
  expect(ycodingDotsSkillsRoot()).toBe(path.join(Global.Path.data, "dots", "skills"))
  expect(path.relative(path.join(Global.Path.home, ".agents", "skills"), ycodingDotsSkillsRoot()).startsWith("..")).toBe(true)
})

test("operator instructions retain refusal, delegation, pending-answer and stop boundaries", async () => {
  const { ycodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
  for (const text of [
    "YCODING_SESSION_ID", "~/.local/bin/ycoding", "folder of its first command",
    "YCoding did not run this: it needs the user's decision.", "action and risk", "retry the identical action",
    "Treat “the user rejected” as final", "Never rephrase or work around a refused command",
    "ycoding decision list --json", "free-text answers for open questions", "the review box is full",
    "only when they authorized that in this chat; quote that instruction", "require an explicit yes for that item",
    "--permissions manual --guardrails auto --answers manual", "--session <session-id>",
    "Pressing Stop in Dots does not stop commands on V", "pgrep -fl", "pkill -f",
    "Dots callers have no direct access", "Never print or echo secret values",
  ]) expect(ycodingOperatorSkill).toContain(text)
  expect(ycodingOperatorSkill.indexOf("pgrep -fl")).toBeLessThan(ycodingOperatorSkill.indexOf("pkill -f"))
})

test("operator watch instructions never treat a settled execution as finished work", async () => {
  const { ycodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
  for (const text of [
    "work.state", "completed only when a current accepted completion receipt", "Every other state is unfinished",
    "Watch the next transition", "never answers, approves, resumes or retries", "descendants' work and decisions",
    "cannot wake an idle Dots conversation",
  ]) expect(ycodingOperatorSkill).toContain(text)
})

test("operator Library instructions select only the private process channel and preserve its gates", async () => {
  const { ycodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
  for (const text of [
    "/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process python3 <helper-path> < /approved/library-upload.json",
    "beginning of the exec_command cmd, before launch", "a shell export inside an already running process does not select the channel", "account connectors enabled",
    "exact Dots principal", "default model account", "chatgpt_library_upload", "mcp_execute",
    "one create_library_file", "20 MiB", "process sandbox", "signed URLs or OAuth values",
    "default or custom HostedApps endpoints", "never fall back", "runtime build implementing the private marker",
    "python3 <helper-path> < /approved/library-upload.json", "not inline image display",
  ]) expect(ycodingOperatorSkill).toContain(text)
  expect(ycodingOperatorSkill).not.toContain('{"env":{"CODEX_APPS_MCP_URL":"ycoding-library://process"}}')
  const example = ycodingOperatorSkill.match(/\{"uploads":\[\{"local_path":"\/approved\/output.png"[^\n]+/)
  expect(example).not.toBeNull()
  expect(JSON.parse(example![0])).toEqual({ uploads: [{ local_path: "/approved/output.png", purpose: "create_library_file" }] })
})

test("operator API operation ids and example bodies match the current Protocol", async () => {
  const { ycodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
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
  const mentions = [...ycodingOperatorSkill.matchAll(/(?:ycoding api |`)([\w.-]+\.[\w.-]+)(?=[\s`/])/g)]
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
    "credential.update", "credential.activate", "credential.remove", "provider.integrations", "provider.refresh",
    "artifact.list", "artifact.get", "artifact.create", "artifact.update", "coordination.settings", "coordination.list", "coordination.get", "coordination.create", "coordination.update", "coordination.delete",
    "shell.remove", "pty.create", "pty.update", "pty.remove", "pty.control", "pty.connect.token", "pty.connect",
    "dots.get", "dots.set", "dots.attach", "remote.get", "remote.set", "telemetry.list", "telemetry.consent.get", "telemetry.consent.set",
    "session.prediction", "session.promptGenerate", "session.compact", "session.compaction.list", "server.session.session.todo.list",
  ]) expect(mentioned.has(required)).toBe(true)
  for (const operation of mentioned) expect(operationIDs.has(operation)).toBe(true)
  const examples = [...ycodingOperatorSkill.matchAll(/ycoding api ([\w.-]+)[^\n`]*? -d '([^'\n]+)'/g)]
  expect(examples.length).toBeGreaterThanOrEqual(7)
  for (const example of examples) {
    const endpoint = operations.get(example[1]!)!
    const schema = endpoint.payload.values().next().value?.schemas[0]
    expect(schema).toBeDefined()
    expect(Schema.decodeUnknownSync(schema!)(JSON.parse(example[2]!))).toEqual(JSON.parse(example[2]!))
  }
})

test("operator discovery and conversation instructions preserve cross-project search and interactive decisions", async () => {
  const { ycodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
  for (const text of [
    "without directory/project filters", "--param parentID=null", "punctuation-free", "curly", "straight",
    "cursor.next", "broaden", "stored Session location", "streams assistant output", "waits for execution",
    "automatically rejects permissions, questions and guardrail requests", "cancels forms",
    "pending decisions survive", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
    "No local API", "browser-local", "captured-change card", "side-chat",
  ]) expect(ycodingOperatorSkill).toContain(text)
})

test("every operator CLI command and flag is advertised by both entrypoint specs", async () => {
  const { ycodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
  const snippets = [
    ...ycodingOperatorSkill.matchAll(/^ycoding(?: .*|)$/gm),
    ...ycodingOperatorSkill.matchAll(/`(ycoding(?: [^`\n]+)?)`/g),
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
  const { ensureYcodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-operator-isolation-"))
  directories.push(root)
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  const data = path.join(root, "data")
  await ensureYcodingOperatorSkill(data)
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
  const services = AppNodeBuilder.build(Skill.node, [
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
  const awaitableSkillFile = await readFile(path.join(data, "dots", "skills", "ycoding-operator", "SKILL.md"), "utf8")
  expect(awaitableSkillFile).toContain("name: ycoding-operator")
})
