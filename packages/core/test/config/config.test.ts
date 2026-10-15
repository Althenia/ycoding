import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Duration, Effect, Fiber, Layer, Logger, PubSub, Schema, Stream } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { ConfigShell } from "@ycoding-ai/core/config/shell"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { ConfigQuestionTimeout } from "@ycoding-ai/core/config/question-timeout"
import { ConfigEfficiency } from "@ycoding-ai/core/config/efficiency"
import { ConfigModel } from "@ycoding-ai/core/config/model"
import { Config as ConfigSchema } from "@ycoding-ai/schema/config"
import { ConfigProvider } from "@ycoding-ai/core/config/provider"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Credential } from "@ycoding-ai/core/credential"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Watcher } from "@ycoding-ai/core/filesystem/watcher"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { Permission } from "@ycoding-ai/core/permission"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { WellKnown } from "@ycoding-ai/core/wellknown"
import { Integration } from "@ycoding-ai/schema/integration"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const selection = Schema.decodeUnknownSync(ConfigModel.Selection)

const emptyCredentialNode = makeGlobalNode({
  service: Credential.Service,
  layer: Layer.succeed(
    Credential.Service,
    Credential.Service.of({
      all: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      refresh: () => Effect.die("unused Credential.refresh"),
      create: () => Effect.die("unused Credential.create"),
      update: () => Effect.die("unused Credential.update"),
      activate: () => Effect.die("unused Credential.activate"),
      remove: () => Effect.die("unused Credential.remove"),
    }),
  ),
  deps: [],
})

const emptyWellknownNode = makeGlobalNode({
  service: WellKnown.Service,
  layer: Layer.succeed(
    WellKnown.Service,
    WellKnown.Service.of({
      entries: () => Effect.succeed([]),
      snapshot: () => [],
      refresh: () => Effect.succeed(false),
      add: () => Effect.die("unused Wellknown.add"),
      remove: () => Effect.die("unused Wellknown.remove"),
      resolve: () => Effect.die("unused Wellknown.resolve"),
    }),
  ),
  deps: [],
})

function testLayer(
  directory: string,
  globalDirectory = path.join(directory, "global"),
  projectDirectory = directory,
  vcs?: Project.Vcs,
  watcher?: Layer.Layer<Watcher.Service>,
  credentialNode = emptyCredentialNode,
  wellknownNode = emptyWellknownNode,
  options?: Config.Options,
) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(projectDirectory), vcs },
      ),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, EventRuntime.node]), [
    [Config.node, Config.configured(options)],
    [Location.node, locationLayer],
    [
      Global.node,
      Global.layerWith({
        data: path.join(globalDirectory, "data"),
        config: globalDirectory,
        home: path.join(globalDirectory, "home"),
      }),
    ],
    [Credential.node, credentialNode],
    [WellKnown.node, wellknownNode],
    ...(watcher ? ([[Watcher.node, watcher]] as const) : []),
  ])
}

const provider = {
  package: "native",
  settings: {},
  headers: {},
  body: {},
  models: {},
}

describe("Config", () => {
  for (const example of [
    {
      name: "unknown top-level key",
      input: { shell: "/bin/zsh", unknown_setting: true },
      expected: { shell: "/bin/zsh" },
      paths: ["$.unknown_setting"],
    },
    {
      name: "invalid named MCP server",
      input: { mcp: { servers: { bad: { type: "local", command: 42 }, good: { type: "local", command: ["server"] } } } },
      expected: { mcp: { servers: { good: { type: "local", command: ["server"] } } } },
      paths: ["$.mcp.servers.bad"],
    },
    {
      name: "invalid deep agent field",
      input: { agents: { god: { description: "Kept", request: { headers: { bad: 42, good: "yes" } } }, helper: { system: "Kept too" } } },
      expected: { agents: { god: { description: "Kept", request: { headers: { good: "yes" } } }, helper: { system: "Kept too" } } },
      paths: ["$.agents.god.request.headers.bad"],
    },
    {
      name: "invalid named provider command and reference",
      input: { providers: { bad: { package: 42 }, good: { package: "native" } }, commands: { bad: { description: "No template" }, good: { template: "Run" } }, references: { bad: { path: 42 }, good: "/tmp" } },
      expected: { providers: { good: { package: "native" } }, commands: { good: { template: "Run" } }, references: { good: "/tmp" } },
      paths: ["$.providers.bad", "$.commands.bad", "$.references.bad"],
    },
    {
      name: "removed key and invalid array item",
      input: { snapshot: false, skills: ["kept", 42, "also-kept"], shell: "/bin/zsh" },
      expected: { skills: ["kept", "also-kept"], shell: "/bin/zsh" },
      paths: ["$.snapshot", "$.skills[1]"],
    },
    {
      name: "unknown nested key",
      input: { mcp: { servers: { good: { type: "local", command: ["server"], old_option: true } } } },
      expected: { mcp: { servers: { good: { type: "local", command: ["server"] } } } },
      paths: ["$.mcp.servers.good.old_option"],
    },
    {
      name: "unknown key in a non-tagged union",
      input: { references: { good: { path: "/tmp", typo: true } } },
      expected: { references: { good: { path: "/tmp" } } },
      paths: ["$.references.good.typo"],
    },
    {
      name: "multiple invalid array items with original JSON indices",
      input: { instructions: [42, "kept", false, "also-kept"] },
      expected: { instructions: ["kept", "also-kept"] },
      paths: ["$.instructions[0]", "$.instructions[2]"],
    },
    {
      name: "names requiring bracket JSON paths",
      input: { mcp: { servers: { "bad.server": { type: "remote", url: 42 }, good: { type: "remote", url: "https://example.com/mcp" } } } },
      expected: { mcp: { servers: { good: { type: "remote", url: "https://example.com/mcp" } } } },
      paths: ['$.mcp.servers["bad.server"]'],
    },
    {
      name: "valid config unchanged",
      input: { shell: "/bin/zsh", guardrails: { enabled: false }, permissions: [{ action: "read", resource: "*", effect: "allow" }], agents: { god: { steps: 4 } } },
      expected: { shell: "/bin/zsh", guardrails: { enabled: false }, permissions: [{ action: "read", resource: "*", effect: "allow" }], agents: { god: { steps: 4 } } },
      paths: [],
    },
  ]) {
    it.live(`recovers ${example.name} through real config loading`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.gen(function* () {
          const target = path.join(tmp.path, "ycoding.jsonc")
          yield* Effect.promise(() => fs.writeFile(target, JSON.stringify(example.input)))
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")
            expect(documents).toHaveLength(1)
            expect(JSON.parse(JSON.stringify(documents[0]?.info))).toEqual(example.expected)
            const diagnostics = yield* config.diagnostics()
            expect(diagnostics.map((item) => item.jsonPath ?? "").toSorted((a, b) => a.localeCompare(b))).toEqual(example.paths.toSorted((a, b) => a.localeCompare(b)))
            expect(diagnostics.every((item) => item.path === target)).toBe(true)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  for (const example of [
    { name: "readable action", rules: [{ action: "shell", resource: 42, effect: "allow" }, { action: "*", resource: "*", effect: "allow" }], action: "shell", path: "$.permissions[0]" },
    { name: "unreadable action", rules: [{ action: 42, resource: "*", effect: "deny" }, { action: "*", resource: "*", effect: "allow" }], action: "*", path: "$.permissions[0]" },
    { name: "non-array ruleset", rules: { action: "shell", effect: "deny" }, action: "*", path: "$.permissions" },
    { name: "unknown rule key", rules: [{ action: "shell", resource: "*", effect: "allow", typo: true }], action: "shell", path: "$.permissions[0]" },
  ]) {
    it.live(`fails closed for ${example.name} permissions in global and agent scopes`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "ycoding.json"), JSON.stringify({
            shell: "/bin/zsh", permissions: example.rules,
            agents: { god: { description: "Kept", steps: -1, permissions: example.rules } },
          })))
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            const global = Config.latest(entries, "permissions") ?? []
            const agent = Config.latest(entries, "agents")?.god
            expect(global.at(-1)).toEqual({ action: example.action, resource: "*", effect: "deny" })
            expect(agent?.permissions?.at(-1)).toEqual({ action: example.action, resource: "*", effect: "deny" })
            expect(agent?.description).toBe("Kept")
            expect(Config.latest(entries, "shell")).toBe("/bin/zsh")
            expect(Permission.evaluate("shell", "anything", global).effect).toBe("deny")
            expect(Permission.evaluate("shell", "anything", agent?.permissions ?? []).effect).toBe("deny")
            if (example.action === "*") expect(Permission.evaluate("read", "anything", global).effect).toBe("deny")
            const diagnostics = yield* config.diagnostics()
            for (const jsonPath of [example.path, example.path.replace("$.permissions", "$.agents.god.permissions")]) {
              expect(diagnostics).toContainEqual(expect.objectContaining({ jsonPath, failClosed: true, message: expect.stringContaining("fails closed") }))
            }
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  for (const guardrails of [false, { enabled: false, max_concurrent_shells: 0 }, { enabled: "off" }, { enabled: false, typo: true }]) {
    it.live(`fails closed for invalid guardrails ${JSON.stringify(guardrails)}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "global"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "global/ycoding.json"), JSON.stringify({ guardrails: { enabled: false, max_concurrent_shells: 100 } })))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "ycoding.json"), JSON.stringify({ shell: "/bin/zsh", guardrails })))
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            expect(Config.latest(yield* config.entries(), "guardrails")).toEqual({ enabled: true })
            expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/zsh")
            expect(yield* config.diagnostics()).toEqual([expect.objectContaining({ jsonPath: "$.guardrails", failClosed: true, message: expect.stringContaining("fails closed") })])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }
  it.effect("decodes provider efficiency policy without changing omitted defaults", () =>
    Effect.sync(() => {
      const decoded = Schema.decodeUnknownSync(Config.Info)({
        efficiency: {
          title: "local",
          helper_models: {
            title: "openai/gpt-5-mini#low",
            goal: "session",
            compaction: { main: "session", subagent: "openai/gpt-5-mini#low" },
          },
          prompt_cache: {
            anthropic_ttl: "adaptive",
            openai_mode: "explicit",
            openai_extended_retention: true,
          },
          openai_responses_continuation: "auto",
          openai_responses_state: "stateless",
        },
      })
      expect(decoded.efficiency).toEqual({
        title: "local",
        helper_models: {
          title: selection("openai/gpt-5-mini#low"),
          goal: "session",
          compaction: { main: "session", subagent: selection("openai/gpt-5-mini#low") },
        },
        prompt_cache: {
          anthropic_ttl: "adaptive",
          openai_mode: "explicit",
          openai_extended_retention: true,
        },
        openai_responses_continuation: "auto",
        openai_responses_state: "stateless",
      })
      expect(ConfigEfficiency.openAIResponsesState()).toBe("stored")
      expect(ConfigEfficiency.openAIResponsesState(decoded.efficiency)).toBe("stateless")
      expect(Schema.decodeUnknownSync(Config.Info)({}).efficiency).toBeUndefined()
      expect(() =>
        Schema.decodeUnknownSync(Config.Info)({ efficiency: { prompt_cache: { anthropic_ttl: "forever" } } }),
      ).toThrow()
    }),
  )

  it.effect("decodes and resolves selective compaction policy", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(Config.Info)
      const lower = decode({
        compaction: {
          keep_recent_messages: 3,
          max_manifest_bytes: 32_768,
          advisory: { consider_percent: 60, strongly_advised_percent: 80 },
        },
      }).compaction!
      const higher = decode({
        compaction: {
          reserved_output_tokens: 1_024,
          context_safety_margin_tokens: 8_192,
          advisory: false,
        },
      }).compaction!

      expect(ConfigCompaction.resolve([])).toEqual({
        keepRecentMessages: 20,
        reservedOutputTokens: 0,
        contextSafetyMarginTokens: 4_096,
        timeoutSeconds: 60,
        maxOutputTokens: 0,
        maxManifestBytes: 65_536,
        maxInternalPasses: 8,
        advisory: { considerPercent: 70, stronglyAdvisedPercent: 90 },
      })
      expect(ConfigCompaction.resolve([lower, higher])).toEqual({
        keepRecentMessages: 3,
        reservedOutputTokens: 1_024,
        contextSafetyMarginTokens: 8_192,
        timeoutSeconds: 60,
        maxOutputTokens: 0,
        maxManifestBytes: 32_768,
        maxInternalPasses: 8,
        advisory: false,
      })
      expect(decode({ compaction: { max_summary_bytes: 1, max_manifest_bytes: 2 } }).compaction).toEqual({
        max_manifest_bytes: 2,
      })
      expect(() => decode({ compaction: { advisory: { consider_percent: 0, strongly_advised_percent: 90 } } })).toThrow()
      expect(() => decode({ compaction: { advisory: { consider_percent: 70, strongly_advised_percent: 100 } } })).toThrow()
      expect(() => decode({ compaction: { advisory: { consider_percent: 80, strongly_advised_percent: 80 } } })).toThrow()
      expect(() => decode({ compaction: { advisory: { consider_percent: 90, strongly_advised_percent: 80 } } })).toThrow()
    }),
  )

  it.effect("decodes and bounds question_timeout_seconds with a 5 minute default and 0 disabling", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(Config.Info)
      expect(decode({}).question_timeout_seconds).toBeUndefined()
      expect(decode({ question_timeout_seconds: 30 }).question_timeout_seconds).toBe(30)
      expect(decode({ question_timeout_seconds: 0 }).question_timeout_seconds).toBe(0)
      expect(decode({ question_timeout_seconds: 86_400 }).question_timeout_seconds).toBe(86_400)
      for (const invalid of [-1, 86_401, 1.5, "300"]) expect(() => decode({ question_timeout_seconds: invalid })).toThrow()

      expect(ConfigQuestionTimeout.seconds(undefined)).toBe(300)
      expect(ConfigQuestionTimeout.duration(undefined)).toEqual(Duration.seconds(300))
      expect(ConfigQuestionTimeout.duration(45)).toEqual(Duration.seconds(45))
      expect(ConfigQuestionTimeout.duration(0)).toBeUndefined()
    }),
  )

  it.effect("derives deterministic versioned compaction admission digests", () =>
    Effect.sync(() => {
      const resolved = ConfigCompaction.resolve([])
      const digest = ConfigCompaction.admissionDigest(resolved)

      expect(digest).toBe(ConfigCompaction.admissionDigest(ConfigCompaction.resolve([])))
      expect(digest).toBe(ConfigCompaction.admissionDigest(resolved, 4))
      expect(digest).not.toBe(ConfigCompaction.admissionDigest(resolved, 3))
      expect(digest).not.toBe(ConfigCompaction.admissionDigest(resolved, 2))
      expect(digest).not.toBe(ConfigCompaction.admissionDigest(resolved, 1))
      expect(digest).not.toBe(
        ConfigCompaction.admissionDigest({ ...resolved, timeoutSeconds: resolved.timeoutSeconds + 1 }),
      )
    }),
  )

  it.effect("ignores retired self-improvement settings without discarding unrelated settings", () =>
    Effect.sync(() => {
      const info = Schema.decodeUnknownSync(Config.Info)({
        experimental: { self_improvement: { automatic: true } },
        mcp: { servers: { memory: { type: "local", command: ["memory"] } } },
        providers: {
          openai: {
            models: {
              custom: {
                capabilities: { input: ["text"], output: ["text"] },
                limit: { context: 400_000 },
              },
            },
          },
        },
      })

      expect(info.experimental).toEqual({})
      expect(info.mcp?.servers?.memory).toBeDefined()
      expect(info.providers?.openai?.models?.custom?.limit?.context).toBe(400_000)
    }),
  )

  it.live("loads explicit file and content overrides in priority order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const explicit = path.join(tmp.path, "custom.json")
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "ycoding.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(explicit, JSON.stringify({ shell: "explicit" }))
          await fs.writeFile(path.join(project, "ycoding.json"), JSON.stringify({ shell: "project" }))
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const entries = yield* config.entries()
              expect(
                entries.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
              ).toEqual(["global", "explicit", "project", "content"])
              expect(Config.latest(entries, "shell")).toBe("content")
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  file: explicit,
                  content: JSON.stringify({ shell: "content" }),
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("skips project configuration when project discovery is disabled", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "ycoding.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(path.join(project, "ycoding.json"), JSON.stringify({ shell: "project" }))
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBe("global")
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  project: false,
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("reloads external config and publishes directory updates", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "ycoding.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(file, JSON.stringify({ shell: "first" }))
          })
          const updates = yield* PubSub.unbounded<Watcher.Update>({ replay: 8 })
          const watcher = Layer.succeed(
            Watcher.Service,
            Watcher.Service.of({
              subscribe: () => Stream.fromPubSub(updates),
            }),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const events = yield* EventRuntime.Service
            const changed = yield* events
              .subscribe(ConfigSchema.Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))

            yield* PubSub.publish(updates, {
              type: "update",
              path: path.join(global, "commands", "review.md"),
            } satisfies Watcher.Update)
            yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ shell: "second" })))
            yield* PubSub.publish(updates, { type: "update", path: file } satisfies Watcher.Update)

            expect(yield* Fiber.join(changed)).toHaveLength(1)
            expect(Config.latest(yield* config.entries(), "shell")).toBe("second")
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, watcher)))
        }),
      ),
    ),
  )

  it.live("publishes updates when watched directory contents change without changing entries", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const command = path.join(global, "command", "review.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(global, "command"), { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(command, "review")
          })
          const updates = yield* PubSub.unbounded<Watcher.Update>({ replay: 8 })
          const watcher = Layer.succeed(
            Watcher.Service,
            Watcher.Service.of({
              subscribe: () => Stream.fromPubSub(updates),
            }),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const events = yield* EventRuntime.Service
            yield* config.entries()
            const changed = yield* events
              .subscribe(ConfigSchema.Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))

            // Agents, commands and skills live inside watched config directories but are not
            // config entries, so deleting one leaves the discovered entry list untouched.
            yield* Effect.promise(() => fs.rm(command))
            yield* PubSub.publish(updates, { type: "delete", path: command } satisfies Watcher.Update)

            expect(yield* Fiber.join(changed).pipe(Effect.timeout("2 seconds"))).toHaveLength(1)
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, watcher)))
        }),
      ),
    ),
  )

  it.live("reload discovers unwatched project config and publishes an update on every request", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(path.join(global, "ycoding.json"), JSON.stringify({ shell: "global" }))
          })
          const watcher = Layer.succeed(Watcher.Service, Watcher.Service.of({ subscribe: () => Stream.never }))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const events = yield* EventRuntime.Service
            expect(Config.latest(yield* config.entries(), "shell")).toBe("global")
            const changed = yield* events
              .subscribe(ConfigSchema.Event.Updated)
              .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))

            yield* Effect.promise(() =>
              fs.writeFile(path.join(project, "ycoding.json"), JSON.stringify({ shell: "project" })),
            )
            yield* config.reload()
            expect(Config.latest(yield* config.entries(), "shell")).toBe("project")
            yield* config.reload()

            expect(yield* Fiber.join(changed).pipe(Effect.timeout("2 seconds"))).toHaveLength(2)
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, watcher)))
        }),
      ),
    ),
  )

  it.effect("returns the latest defined scalar from priority-ordered documents", () =>
    Effect.sync(() => {
      const entries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({ model: selection("openrouter/openai/gpt-5") }),
        }),
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/skills") }),
        new Config.AgentsDirectory({ type: "agents", path: AbsolutePath.make("/agents") }),
        new Config.Document({ type: "document", info: new Config.Info({}) }),
        new Config.Document({
          type: "document",
          info: new Config.Info({ model: selection("openrouter/openai/gpt-5.5") }),
        }),
      ]

      expect(Config.latest(entries, "model")).toEqual(selection("openrouter/openai/gpt-5.5"))
      expect(Config.latest(entries, "default_agent")).toBeUndefined()
    }),
  )

  it.live("loads authenticated wellknown config at highest priority", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(path.join(global, "ycoding.json"), JSON.stringify({ shell: "global" }))
            await fs.writeFile(path.join(project, "ycoding.json"), JSON.stringify({ shell: "project" }))
          })

          const integrationID = Integration.ID.make("https://example.com")
          let key = "secret"
          const credentialNode = makeGlobalNode({
            service: Credential.Service,
            layer: Layer.succeed(
              Credential.Service,
              Credential.Service.of({
                all: () => Effect.die("unused Credential.all"),
                list: () =>
                  Effect.succeed([
                    new Credential.Info({
                      id: Credential.ID.create(),
                      integrationID,
                      label: "default",
                      value: Credential.Key.make({ type: "key", key }),
                      active: true,
                    }),
                  ]),
                get: () => Effect.die("unused Credential.get"),
                refresh: () => Effect.die("unused Credential.refresh"),
                create: () => Effect.die("unused Credential.create"),
                update: () => Effect.die("unused Credential.update"),
                activate: () => Effect.die("unused Credential.activate"),
                remove: () => Effect.die("unused Credential.remove"),
              }),
            ),
            deps: [],
          })
          const entry: WellKnown.Entry = {
            origin: "https://example.com",
            integrationID,
            manifest: { auth: { command: ["login"], env: "TOKEN" } },
          }
          const wellknownNode = makeGlobalNode({
            service: WellKnown.Service,
            layer: Layer.succeed(
              WellKnown.Service,
              WellKnown.Service.of({
                entries: () => Effect.succeed([entry]),
                snapshot: () => [entry],
                refresh: () => Effect.succeed(false),
                add: () => Effect.die("unused Wellknown.add"),
                remove: () => Effect.die("unused Wellknown.remove"),
                resolve: (_entry, variables) => Effect.succeed([{ shell: variables.TOKEN }]),
              }),
            ),
            deps: [],
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const events = yield* EventRuntime.Service
            expect(Config.latest(yield* config.entries(), "shell")).toBe("secret")
            const updated = yield* events
              .subscribe(ConfigSchema.Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.yieldNow
            key = "next"
            yield* events.publish(Integration.Event.ConnectionUpdated, { integrationID })
            expect(yield* Fiber.join(updated)).toHaveLength(1)
            expect(Config.latest(yield* config.entries(), "shell")).toBe("next")
          }).pipe(
            Effect.provide(testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode)),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.effect("bounds current instruction and shell resource settings", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(Config.Info)
      expect(decode({ instruction_max_bytes: 1 }).instruction_max_bytes).toBe(1)
      expect(decode({ instruction_max_bytes: 1_048_576 }).instruction_max_bytes).toBe(1_048_576)
      expect(() => decode({ instruction_max_bytes: 0 })).toThrow()
      expect(() => decode({ instruction_max_bytes: 1_048_577 })).toThrow()
      expect(decode({ shell_memory_limit_mb: 0 }).shell_memory_limit_mb).toBe(0)
      expect(decode({ shell_memory_limit_mb: 1_048_576 }).shell_memory_limit_mb).toBe(1_048_576)
      expect(() => decode({ shell_memory_limit_mb: -1 })).toThrow()
      expect(() => decode({ shell_memory_limit_mb: 1.5 })).toThrow()
      expect(() => decode({ shell_memory_limit_mb: 1_048_577 })).toThrow()
      for (const mode of ["disabled", "optional", "required"] as const) {
        expect(decode({ shell_sandbox: mode }).shell_sandbox).toBe(mode)
      }
      expect(() => decode({ shell_sandbox: "pretend" })).toThrow()
      const queue = decode({
        shell_queue: { max_running: 64, max_running_per_session: 1, max_queued_per_session: 1_000, memory_reserve_mb: 0, max_load: 0.5 },
      }).shell_queue
      expect(queue).toEqual({ max_running: 64, max_running_per_session: 1, max_queued_per_session: 1_000, memory_reserve_mb: 0, max_load: 0.5 })
      expect(ConfigShell.queueLimits(undefined)).toEqual({
        max_running: 2,
        max_running_per_session: 1,
        max_queued_per_session: 16,
        memory_reserve_mb: 2_048,
        max_load: 1,
      })
      expect(ConfigShell.queueLimits({ max_running: 4 })).toMatchObject({ max_running: 4, max_running_per_session: 1 })
      for (const shell_queue of [
        { max_running: 0 },
        { max_running: 65 },
        { max_running: 1.5 },
        { max_running_per_session: 0 },
        { max_queued_per_session: 1_001 },
        { memory_reserve_mb: -1 },
        { memory_reserve_mb: 1_048_577 },
        { max_load: 0 },
        { max_load: 65 },
      ])
        expect(() => decode({ shell_queue })).toThrow()
    }),
  )

  it.live("ignores an unknown ntfy key while loading other valid config fields", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "ycoding.jsonc"),
            JSON.stringify({ ntfy: { enabled: true, topic: "old-topic" }, shell: "/bin/zsh" })))
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const document = (yield* config.entries()).find((entry) => entry.type === "document")
            expect(document?.info.shell).toBe("/bin/zsh")
            expect(document?.info).not.toHaveProperty("ntfy")
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("returns an empty configuration when directory files do not exist", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = yield* config.entries()

          expect(entries).toEqual([
            new Config.Directory({ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")) }),
          ])
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )

  it.live("does not watch ecosystem config roots", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(tmp.path, ".claude", "skills"), { recursive: true }),
              fs.mkdir(path.join(tmp.path, ".agents"), { recursive: true }),
            ]),
          )
          const targets: Watcher.WatchInput[] = []
          const watcher = Layer.succeed(
            Watcher.Service,
            Watcher.Service.of({
              subscribe: (input) => {
                targets.push(input)
                return Stream.never
              },
            }),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            yield* config.entries()

            expect(targets).toEqual([{ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")) }])
          }).pipe(Effect.provide(testLayer(tmp.path, undefined, undefined, undefined, watcher)))
        }),
      ),
    ),
  )

  it.live("loads ycoding JSON and JSONC files from lowest to highest priority", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(tmp.path, "ycoding.json"),
                JSON.stringify({ $schema: "base", providers: { base: provider } }),
              ),
              fs.writeFile(
                path.join(tmp.path, "ycoding.jsonc"),
                `{
                  // Later global files override scalar fields while retaining providers.
                  "$schema": "last",
                  "providers": { "last": ${JSON.stringify(provider)} },
                }`,
              ),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(2)
            expect(documents.map((document) => document.type)).toEqual(["document", "document"])
            expect(documents.map((document) => document.info.$schema)).toEqual(["base", "last"])
            expect(documents[0]).toBeInstanceOf(Config.Document)
            expect(documents[0]?.path).toBe(path.join(tmp.path, "ycoding.json"))
            expect(documents[1]?.info.providers?.last).toBeInstanceOf(ConfigProvider.Info)

            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "ycoding.jsonc"), JSON.stringify({ $schema: "changed" })),
            )
            expect(
              (yield* config.entries())
                .filter((entry) => entry.type === "document")
                .map((document) => document.info.$schema),
            ).toEqual(["base", "last"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("substitutes environment variables and relative file contents", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          token: process.env.YCODING_TEST_MCP_TOKEN,
          missing: process.env.YCODING_TEST_MISSING,
        }
        process.env.YCODING_TEST_MCP_TOKEN = "secret"
        delete process.env.YCODING_TEST_MISSING
        return previous
      }),
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                Promise.all([
                  fs.writeFile(path.join(tmp.path, "token.txt"), 'file\n"token"\n'),
                  fs.writeFile(
                    path.join(tmp.path, "ycoding.jsonc"),
                    `{
                      // Ignored reference: {file:missing.txt}
                      "username": "user-{env:YCODING_TEST_MISSING}",
                      "mcp": {
                        "servers": {
                          "remote": {
                            "type": "remote",
                            "url": "https://example.com/mcp",
                            "headers": {
                              "Authorization": "Bearer {env:YCODING_TEST_MCP_TOKEN}",
                              "X-Token": "{file:token.txt}"
                            }
                          }
                        }
                      }
                    }`,
                  ),
                ]),
              )

              return yield* Effect.gen(function* () {
                const config = yield* Config.Service
                const document = (yield* config.entries()).find((entry) => entry.type === "document")
                expect(document?.info.username).toBe("user-")
                const remote = document?.info.mcp?.servers?.remote
                expect(remote?.type).toBe("remote")
                if (remote?.type !== "remote") return
                expect(remote.headers).toEqual({
                  Authorization: "Bearer secret",
                  "X-Token": 'file\n"token"',
                })
              }).pipe(Effect.provide(testLayer(tmp.path)))
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
      (previous) =>
        Effect.sync(() => {
          if (previous.token === undefined) delete process.env.YCODING_TEST_MCP_TOKEN
          else process.env.YCODING_TEST_MCP_TOKEN = previous.token
          if (previous.missing === undefined) delete process.env.YCODING_TEST_MISSING
          else process.env.YCODING_TEST_MISSING = previous.missing
        }),
    ),
  )

  it.live("does not load legacy config.json files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "config.json"), JSON.stringify({ $schema: "legacy" })),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("accepts $schema metadata without writing it into config files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "ycoding.json")
          const contents = JSON.stringify({
            shell: "/bin/zsh",
            providers: { local: provider },
          })
          yield* Effect.promise(() => fs.writeFile(file, contents))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents[0]?.info.$schema).toBeUndefined()
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(contents)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads supported scalar and resource configuration", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "ycoding.json"),
              JSON.stringify({
                shell: "/bin/bash",
                model: "anthropic/claude",
                default_agent: "reviewer",
                autoupdate: "notify",
                share: "disabled",
                enterprise: { url: "https://share.example.com" },
                username: "test-user",
                permissions: [
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "bash", resource: "git status", effect: "allow" },
                ],
                agents: {
                  reviewer: {
                    model: "openrouter/openai/gpt-5#high",
                    request: {
                      headers: { "x-agent": "reviewer" },
                      body: { reasoningEffort: "high" },
                    },
                    description: "Review changes for correctness",
                    system: "Find regressions.",
                    mode: "subagent",
                    hidden: false,
                    color: "warning",
                    steps: 12,
                    disabled: false,
                    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
                  },
                },
                snapshots: false,
                watcher: { ignore: ["node_modules/**", "dist/**", ".git"] },
                formatter: {
                  prettier: { disabled: true },
                  custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
                },
                lsp: { typescript: { disabled: true }, custom: { command: ["custom-lsp"], extensions: [".foo"] } },
                attachments: {
                  image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
                },
                tool_output: { max_lines: 1000, max_bytes: 32768 },
                mcp: {
                  timeout: { startup: 5000, catalog: 60000, execution: 43200000 },
                  servers: {
                    local: {
                      type: "local",
                      command: ["node", "./mcp/server.js"],
                      environment: { API_KEY: "secret" },
                      disabled: false,
                      codemode: false,
                      timeout: { catalog: 10000 },
                    },
                    remote: {
                      type: "remote",
                      url: "https://mcp.example.com/mcp",
                      headers: { Authorization: "Bearer token" },
                      oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                      disabled: true,
                      codemode: false,
                      timeout: { startup: 15000 },
                    },
                  },
                },
                compaction: {
                  keep_recent_messages: 20,
                  reserved_output_tokens: 2000,
                  context_safety_margin_tokens: 4096,
                  timeout_seconds: 30,
                  max_output_tokens: 4000,
                  max_manifest_bytes: 65536,
                  max_internal_passes: 8,
                },
                skills: ["./skills", "~/shared-skills", "https://example.com/.well-known/skills/"],
                instructions: ["CONTRIBUTING.md", ".cursor/rules/*.md", "https://example.com/shared-rules.md"],
                references: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
                plugins: [
                  "ycoding-helicone-session",
                  { package: "@my-org/audit-plugin", options: { endpoint: "https://audit.example.com" } },
                ],
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.shell).toBe("/bin/bash")
            expect(documents[0]?.info.model).toEqual(selection("anthropic/claude"))
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.autoupdate).toBe("notify")
            expect(documents[0]?.info.share).toBe("disabled")
            expect(documents[0]?.info.enterprise).toEqual({ url: "https://share.example.com" })
            expect(documents[0]?.info.username).toBe("test-user")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "bash", resource: "git status", effect: "allow" },
            ])
            const reviewer = documents[0]?.info.agents?.reviewer
            expect(reviewer?.model).toEqual(selection("openrouter/openai/gpt-5#high"))
            expect(reviewer?.request).toEqual({
              headers: { "x-agent": "reviewer" },
              body: { reasoningEffort: "high" },
            })
            expect(reviewer?.description).toBe("Review changes for correctness")
            expect(reviewer?.system).toBe("Find regressions.")
            expect(reviewer?.mode).toBe("subagent")
            expect(reviewer?.hidden).toBe(false)
            expect(reviewer?.color).toBe("warning")
            expect(reviewer?.steps).toBe(12)
            expect(reviewer?.disabled).toBe(false)
            expect(reviewer?.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.watcher).toEqual({ ignore: ["node_modules/**", "dist/**", ".git"] })
            expect(documents[0]?.info.formatter).toEqual({
              prettier: { disabled: true },
              custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.lsp).toEqual({
              typescript: { disabled: true },
              custom: { command: ["custom-lsp"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.attachments).toEqual({
              image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
            })
            expect(documents[0]?.info.tool_output).toEqual({ max_lines: 1000, max_bytes: 32768 })
            expect(documents[0]?.info.mcp).toEqual({
              timeout: { startup: 5000, catalog: 60000, execution: 43200000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "./mcp/server.js"],
                  environment: { API_KEY: "secret" },
                  disabled: false,
                  codemode: false,
                  timeout: { catalog: 10000 },
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com/mcp",
                  headers: { Authorization: "Bearer token" },
                  oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                  disabled: true,
                  codemode: false,
                  timeout: { startup: 15000 },
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              keep_recent_messages: 20,
              reserved_output_tokens: 2000,
              context_safety_margin_tokens: 4096,
              timeout_seconds: 30,
              max_output_tokens: 4000,
              max_manifest_bytes: 65536,
              max_internal_passes: 8,
            })
            expect(documents[0]?.info.skills).toEqual([
              "./skills",
              "~/shared-skills",
              "https://example.com/.well-known/skills/",
            ])
            expect(documents[0]?.info.instructions).toEqual([
              "CONTRIBUTING.md",
              ".cursor/rules/*.md",
              "https://example.com/shared-rules.md",
            ])
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
            expect(documents[0]?.info.plugins).toEqual([
              "ycoding-helicone-session",
              { package: "@my-org/audit-plugin", options: { endpoint: "https://audit.example.com" } },
            ])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("drops removed configuration keys without rejecting the document", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "ycoding.json"), JSON.stringify({ snapshot: false })),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            expect((yield* config.entries()).filter((entry) => entry.type === "document").map((entry) => entry.info)).toEqual([{}])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("drops retired decisions config with one ordinary warning and diagnostic", () => {
    const warnings: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (Array.isArray(entry.message) && entry.message[0] === "recovered config item") warnings.push(entry.message[1])
    })
    return Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        const target = path.join(tmp.path, "ycoding.jsonc")
        yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({
          decisions: {}, shell: "/bin/zsh",
          mcp: { servers: { good: { type: "local", command: ["server"] } } },
          guardrails: { enabled: false },
        })))
        yield* Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = yield* config.entries()
          const document = entries.find((entry) => entry.type === "document")
          expect(document?.info).not.toHaveProperty("decisions")
          expect(Config.latest(entries, "shell")).toBe("/bin/zsh")
          expect(Config.latest(entries, "mcp")?.servers).toHaveProperty("good")
          expect(Config.latest(entries, "guardrails")?.enabled).toBe(false)
          expect(yield* config.diagnostics()).toEqual([{
            path: target, jsonPath: "$.decisions", reason: "removed-keys", message: "Removed or unknown configuration key",
          }])
          expect<unknown>(warnings).toEqual(yield* config.diagnostics())
        }).pipe(Effect.provide(testLayer(tmp.path)))
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live("warns once for each removed configuration key", () => {
    const warnings: { path: string; jsonPath: string; reason: string; message: string }[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "recovered config item") return
      const details: unknown = entry.message[1]
      if (typeof details !== "object" || details === null) return
      if (!("path" in details) || !("jsonPath" in details) || !("reason" in details) || !("message" in details)) return
      warnings.push({
        path: String(details.path), jsonPath: String(details.jsonPath), reason: String(details.reason), message: String(details.message),
      })
    })
    return Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const target = path.join(tmp.path, "ycoding.json")
          yield* Effect.promise(() =>
            fs.writeFile(target, JSON.stringify({ permission: { bash: "deny" }, permissions: [] })),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            expect(Config.latest(yield* config.entries(), "permissions")).toEqual([])
            expect(warnings).toEqual([{ path: target, jsonPath: "$.permission", reason: "removed-keys", message: "Removed or unknown configuration key" }])
            expect<unknown>(warnings).toEqual(yield* config.diagnostics())
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
      Effect.provide(Logger.layer([logger])),
    )
  })

  it.live("reports each invalid value while retaining the document", () => {
    const warnings: { path: string; jsonPath: string; reason: string; message: string }[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "recovered config item") return
      const details: unknown = entry.message[1]
      if (typeof details !== "object" || details === null) return
      if (!("path" in details) || !("jsonPath" in details) || !("reason" in details) || !("message" in details)) return
      warnings.push({ path: String(details.path), jsonPath: String(details.jsonPath), reason: String(details.reason), message: String(details.message) })
    })
    return Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const target = path.join(tmp.path, "ycoding.json")
          yield* Effect.promise(() =>
            fs.writeFile(
              target,
              JSON.stringify({
                mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
                agents: { god: { description: "Kept", steps: -1, color: "invalid" } },
              }),
            ),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            expect(Config.latest(yield* config.entries(), "mcp")?.servers).toHaveProperty("docs")
            expect(Config.latest(yield* config.entries(), "agents")?.god.description).toBe("Kept")
            expect(warnings).toHaveLength(2)
            expect(warnings.map((item) => item.jsonPath).toSorted((a, b) => a.localeCompare(b))).toEqual(["$.agents.god.color", "$.agents.god.steps"])
            expect(warnings.every((item) => item.path === target && item.reason === "invalid-values" && item.message.length > 0)).toBe(true)
            expect<unknown>(warnings).toEqual(yield* config.diagnostics())
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
      Effect.provide(Logger.layer([logger])),
    )
  })

  it.live("reports unparsable documents and removed keys as diagnostics and clears them on reload", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const json = path.join(tmp.path, "ycoding.json")
          const jsonc = path.join(tmp.path, "ycoding.jsonc")
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(json, JSON.stringify({ snapshot: false })),
              fs.writeFile(jsonc, "{ invalid"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            expect((yield* config.entries()).filter((entry) => entry.type === "document").map((entry) => entry.path)).toEqual([json])
            expect(yield* config.diagnostics()).toEqual([
              { path: json, jsonPath: "$.snapshot", reason: "removed-keys", message: "Removed or unknown configuration key" },
              { path: jsonc, reason: "invalid-json", message: expect.stringContaining("offset") },
            ])
            yield* Effect.promise(() => fs.writeFile(jsonc, JSON.stringify({ $schema: "fixed" })))
            yield* config.reload()
            expect(yield* config.diagnostics()).toEqual([{ path: json, jsonPath: "$.snapshot", reason: "removed-keys", message: "Removed or unknown configuration key" }])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("ignores an invalid file while loading valid config values", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "ycoding.json"), JSON.stringify({ $schema: "base" })),
              fs.writeFile(path.join(tmp.path, "ycoding.jsonc"), "{ invalid"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents.map((document) => document.info.$schema)).toEqual(["base"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("merges capability fields across layers and drops home ecosystem roots when disabled", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(global, "home")
        const root = path.join(home, "repo")
        const directory = path.join(root, "app")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true })
            await fs.mkdir(path.join(home, ".claude", "skills"), { recursive: true })
            await fs.mkdir(path.join(root, ".agents"), { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(
              path.join(global, "ycoding.json"),
              JSON.stringify({ capabilities: { home_roots: false, tools: { deny: ["shell"] }, skills: { enabled: false } } }),
            )
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            expect(entries.filter((entry) => entry.type === "agents").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(path.join(root, ".agents")),
            ])
            expect(entries.filter((entry) => entry.type === "claude")).toEqual([])
            expect(Config.capabilities(entries)).toEqual({
              home_roots: false,
              tools: { deny: ["shell"], allow: ["read"] },
              skills: { enabled: true },
            })
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                content: JSON.stringify({ capabilities: { tools: { allow: ["read"] }, skills: { enabled: true } } }),
              }),
            ),
          )
        })
      }),
    ),
  )

  it.live("loads global and ancestor configuration across the project boundary", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const parent = path.join(root, "packages")
        const directory = path.join(parent, "app")
        const globalAgents = path.join(global, "home", ".agents")
        const globalClaude = path.join(global, "home", ".claude")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(globalAgents, { recursive: true })
            await fs.mkdir(globalClaude, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(root, ".agents"), { recursive: true })
            await fs.mkdir(path.join(root, ".claude"), { recursive: true })
            await fs.mkdir(path.join(root, ".ycoding"), { recursive: true })
            await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
            await fs.mkdir(path.join(directory, ".claude"), { recursive: true })
            await fs.mkdir(path.join(directory, ".ycoding"), { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(tmp.path, "ycoding.json"), JSON.stringify({ $schema: "outside" })),
              fs.writeFile(path.join(global, "ycoding.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(path.join(root, "ycoding.json"), JSON.stringify({ $schema: "root" })),
              fs.writeFile(path.join(parent, "ycoding.jsonc"), JSON.stringify({ $schema: "parent" })),
              fs.writeFile(path.join(directory, "ycoding.json"), JSON.stringify({ $schema: "directory" })),
              fs.writeFile(path.join(root, ".ycoding", "ycoding.json"), JSON.stringify({ $schema: "root-dot" })),
              fs.writeFile(
                path.join(directory, ".ycoding", "ycoding.jsonc"),
                JSON.stringify({ $schema: "directory-dot" }),
              ),
            ])
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            const documents = entries.filter((entry) => entry.type === "document")

            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(global),
              AbsolutePath.make(path.join(root, ".ycoding")),
              AbsolutePath.make(path.join(directory, ".ycoding")),
            ])
            expect(entries.filter((entry) => entry.type === "agents").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(globalAgents),
              AbsolutePath.make(path.join(directory, ".agents")),
              AbsolutePath.make(path.join(root, ".agents")),
            ])
            expect(entries.filter((entry) => entry.type === "claude").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(globalClaude),
              AbsolutePath.make(path.join(directory, ".claude")),
              AbsolutePath.make(path.join(root, ".claude")),
            ])
            expect(documents.map((document) => document.info.$schema)).toEqual([
              "global",
              "outside",
              "root",
              "parent",
              "directory",
              "root-dot",
              "directory-dot",
            ])
            expect(entries.map((entry) => (entry.type === "document" ? entry.info.$schema : entry.path))).toEqual([
              AbsolutePath.make(globalClaude),
              AbsolutePath.make(path.join(directory, ".claude")),
              AbsolutePath.make(path.join(root, ".claude")),
              AbsolutePath.make(globalAgents),
              AbsolutePath.make(path.join(directory, ".agents")),
              AbsolutePath.make(path.join(root, ".agents")),
              "global",
              AbsolutePath.make(global),
              "outside",
              AbsolutePath.make(path.join(tmp.path, "ycoding.json")),
              "root",
              AbsolutePath.make(path.join(root, "ycoding.json")),
              "parent",
              AbsolutePath.make(path.join(parent, "ycoding.jsonc")),
              "directory",
              AbsolutePath.make(path.join(directory, "ycoding.json")),
              "root-dot",
              AbsolutePath.make(path.join(root, ".ycoding")),
              "directory-dot",
              AbsolutePath.make(path.join(directory, ".ycoding")),
            ])
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, {
                type: "git",
                store: AbsolutePath.make(path.join(root, ".git")),
              }),
            ),
          )
        })
      }),
    ),
  )
})
