export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { isDeepStrictEqual } from "node:util"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Fiber, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect"
import { Permission } from "@ycoding-ai/schema/permission"
import { Event } from "@ycoding-ai/schema/config"
import { Integration } from "@ycoding-ai/schema/integration"
import { Credential } from "./credential"
import { EventV2 } from "./event"
import { Watcher } from "./filesystem/watcher"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { MAX_INSTRUCTION_MAX_BYTES } from "./instruction-content"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath, PositiveInt } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigGuardrail } from "./config/guardrail"
import { ConfigLSP } from "./config/lsp"
import { ConfigMCP } from "./config/mcp"
import { ConfigModel } from "./config/model"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigVariable } from "./config/variable"
import { ConfigWatcher } from "./config/watcher"
import { WellKnown } from "./wellknown"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  shell_sandbox: Schema.Literals(["disabled", "optional", "required"]).pipe(Schema.optional).annotate({
    description:
      "Shell isolation policy. disabled preserves host execution; optional uses an enforceable backend when available and warns otherwise; required rejects before approval or spawn when unavailable.",
  }),
  model: ConfigModel.Selection.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(Schema.optional).annotate({
    description: "Control whether sessions may be shared manually, automatically, or not at all",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Enterprise sharing service configuration",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  guardrails: ConfigGuardrail.Info.pipe(Schema.optional).annotate({
    description: "Session-wide guardrail enablement and runtime caps",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  instruction_max_bytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_INSTRUCTION_MAX_BYTES))
    .pipe(Schema.optional)
    .annotate({
      description: "Maximum UTF-8 bytes inlined from each ambient instruction source (default: 51200, max: 1048576)",
    }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered plugin enablement directives and external package declarations",
  }),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
  experimental: ConfigExperimental.Info.pipe(Schema.optional),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export class File extends Schema.Class<File>("Config.File")({
  type: Schema.Literal("file"),
  path: AbsolutePath,
}) {}

export class AgentsDirectory extends Schema.Class<AgentsDirectory>("Config.AgentsDirectory")({
  type: Schema.Literal("agents"),
  path: AbsolutePath,
}) {}

export class ClaudeDirectory extends Schema.Class<ClaudeDirectory>("Config.ClaudeDirectory")({
  type: Schema.Literal("claude"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory | File | AgentsDirectory | ClaudeDirectory

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and discovery sources from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  file: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Config") {}

export const layer = (options?: Options) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const watcher = yield* Watcher.Service
    const events = yield* EventV2.Service
    const credentials = yield* Credential.Service
    const wellknown = yield* WellKnown.Service
    const names = ["ycoding.json", "ycoding.jsonc"]
    const reloadLock = Semaphore.makeUnsafe(1)
    const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
    const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
    const removedKeys = new Set([
      "logLevel",
      "server",
      "command",
      "reference",
      "snapshot",
      "plugin",
      "autoshare",
      "disabled_providers",
      "enabled_providers",
      "small_model",
      "mode",
      "agent",
      "provider",
      "permission",
      "tools",
      "attachment",
      "layout",
    ])

    const removedConfigKeys = (input: unknown) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return []
      const record = input as Record<string, unknown>
      const keys = Object.keys(record).filter((key) => removedKeys.has(key))
      const mcp = record.mcp
      if (
        typeof mcp === "object" &&
        mcp !== null &&
        !Array.isArray(mcp) &&
        !("servers" in mcp) &&
        Object.values(mcp).some((server) => typeof server === "object" && server !== null && "type" in server)
      )
        keys.push("mcp")
      return keys
    }

    const parseInfo = Effect.fnUntraced(function* (text: string, target: string) {
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return
      const removed = removedConfigKeys(input)
      if (removed.length) {
        yield* Effect.logWarning("ignored config file with removed keys", { target, keys: removed })
        return
      }
      return Option.getOrUndefined(decodeInfo(input))
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return
      const substituted = yield* ConfigVariable.substitute({ type: "path", path: filepath, text })
      const info = yield* parseInfo(substituted, filepath)
      if (!info) return
      return new Document({ type: "document", path: filepath, info })
    })

    const loadWellknown = Effect.fn("Config.loadWellknown")(function* () {
      const entries = yield* wellknown
        .entries()
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to discover wellknown config", { error }).pipe(Effect.as([] as const)),
          ),
        )
      return yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const auth = entry.manifest.auth
          if (!auth) return []
          const credential = (yield* credentials.list(entry.integrationID)).findLast(
            (credential) => credential.value.type === "key",
          )
          if (!credential || credential.value.type !== "key") return []
          const variables = { [auth.env]: credential.value.key }
          const configs = yield* wellknown.resolve(entry, variables).pipe(Effect.orDie)
          return yield* Effect.forEach(configs, (config) =>
            ConfigVariable.substitute({
              type: "virtual",
              source: entry.origin,
              dir: entry.origin,
              text: JSON.stringify(config),
              env: variables,
            }).pipe(
              Effect.flatMap((text) => parseInfo(text, entry.origin)),
              Effect.map((info) => (info ? new Document({ type: "document", info }) : undefined)),
            ),
          ).pipe(Effect.map((documents) => documents.filter((document) => document !== undefined)))
        }),
      ).pipe(Effect.map((documents) => documents.flat()))
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const discover = Effect.fn("Config.discover")(function* () {
      const globalDirectory = AbsolutePath.make(global.config)
      const globalAgentsDirectory = AbsolutePath.make(path.join(global.home, ".agents"))
      const globalClaudeDirectory = AbsolutePath.make(path.join(global.home, ".claude"))
      const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
      const discovered = locationIsGlobal || options?.project === false
        ? []
        : yield* fs
            .up({
              targets: [".ycoding", ".claude", ".agents", ...names.toReversed()],
              start: location.directory,
            })
            .pipe(Effect.orDie)

      // We load certain files from a few other folders in the ecosystem
      const claude = [
        ...((yield* fs.isDir(globalClaudeDirectory))
          ? [new ClaudeDirectory({ type: "claude", path: globalClaudeDirectory })]
          : []),
        ...discovered
          .filter((item) => path.basename(item) === ".claude")
          .map((directory) => new ClaudeDirectory({ type: "claude", path: AbsolutePath.make(directory) })),
      ]
      const agents = [
        ...((yield* fs.isDir(globalAgentsDirectory))
          ? [new AgentsDirectory({ type: "agents", path: globalAgentsDirectory })]
          : []),
        ...discovered
          .filter((item) => path.basename(item) === ".agents")
          .map((directory) => new AgentsDirectory({ type: "agents", path: AbsolutePath.make(directory) })),
      ]

      const directories = [
        globalDirectory,
        ...discovered
          .filter((item) => path.basename(item) === ".ycoding")
          .toReversed()
          .map((directory) => AbsolutePath.make(directory)),
      ]
      const directPaths = discovered
        .filter((item) => ![".agents", ".claude", ".ycoding"].includes(path.basename(item)))
        .toReversed()
      const direct = yield* Effect.forEach(directPaths, (filepath) =>
        loadFile(filepath).pipe(
          Effect.map((config) => [
            ...(config ? [config] : []),
            new File({ type: "file", path: AbsolutePath.make(filepath) }),
          ]),
        ),
      ).pipe(
        Effect.orDie,
        Effect.map((entries) => entries.flat()),
      )

      const file = options?.file
      const explicit = file
        ? yield* loadFile(path.resolve(file)).pipe(
            Effect.map((config) => [
              ...(config ? [config] : []),
              new File({ type: "file", path: AbsolutePath.make(path.resolve(file)) }),
            ]),
            Effect.orDie,
          )
        : []
      const content = options?.content
        ? yield* ConfigVariable.substitute({
            type: "virtual",
            source: "YCODING_CONFIG_CONTENT",
            dir: location.directory,
            text: options.content,
          }).pipe(
            Effect.flatMap((text) => parseInfo(text, "YCODING_CONFIG_CONTENT")),
            Effect.map((info) => (info ? [new Document({ type: "document", info })] : [])),
            Effect.orDie,
          )
        : []

      const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
      return [
        ...claude,
        ...agents,
        ...(supplementary[0] ?? []),
        ...explicit,
        ...direct,
        ...supplementary.slice(1).flat(),
        ...(yield* loadWellknown().pipe(Effect.orDie)),
        ...content,
      ]
    })

    const loadPolicies = (entries: readonly Entry[]) =>
      policy.load(
        entries
          .filter((entry): entry is Document => entry.type === "document")
          .toReversed()
          .flatMap((entry) => entry.info.experimental?.policies ?? []),
      )

    const initial = yield* discover()
    yield* loadPolicies(initial)
    let configs = initial
    const updates = yield* PubSub.unbounded<Watcher.Update>()
    const subscriptions = new Map<string, Effect.Effect<unknown>>()
    const reconcile = Effect.fn("Config.reconcileWatches")(function* (entries: readonly Entry[]) {
      const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
      const files = entries.flatMap((entry) => (entry.type === "file" ? [entry.path] : []))
      const targets = [
        ...directories.map((path) => ({ path, type: "directory" as const })),
        ...files
          .filter((file) => !directories.some((directory) => FSUtil.contains(directory, file)))
          .map((path) => ({ path, type: "file" as const })),
      ]
      const next = new Map(targets.map((target) => [JSON.stringify(target), target]))
      for (const [key, stop] of subscriptions) {
        if (next.has(key)) continue
        yield* stop
        subscriptions.delete(key)
      }
      for (const [key, target] of next) {
        if (subscriptions.has(key)) continue
        const fiber = yield* watcher.subscribe(target).pipe(
          Stream.runForEach((update) => PubSub.publish(updates, update)),
          Effect.forkScoped({ startImmediately: true }),
        )
        subscriptions.set(key, Fiber.interrupt(fiber))
      }
    })

    // `notify` covers filesystem activity inside watched config directories. Agents, commands
    // and skills are markdown files in those directories rather than config entries, so their
    // creation, edit or deletion leaves `discover()` identical and must still reach consumers.
    const reload = Effect.fn("Config.reload")((options?: { readonly notify?: boolean }) =>
      reloadLock.withPermit(
        Effect.gen(function* () {
          const next = yield* discover()
          const changed = !isDeepStrictEqual(configs, next)
          if (changed) {
            configs = next
            yield* loadPolicies(next)
            yield* reconcile(next)
          }
          if (!changed && !options?.notify) return
          yield* events.publish(Event.Updated, {})
        }),
      ),
    )

    yield* Stream.fromPubSub(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach((update) =>
        reload({ notify: true }).pipe(
          Effect.catchCause((cause) => Effect.logError("failed to reload config", { path: update.path, cause })),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filterEffect((event) =>
        wellknown.entries().pipe(
          Effect.map((entries) => entries.some((entry) => entry.integrationID === event.data.integrationID)),
          Effect.catch(() => Effect.succeed(false)),
        ),
      ),
      Stream.runForEach(() =>
        reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown config", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* events.subscribe(WellKnown.Event.Updated).pipe(
      Stream.runForEach(() =>
        reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown sources", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.sleep("10 minutes").pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (!wellknown.snapshot().length) return Effect.void
          return Effect.gen(function* () {
            const changed = yield* wellknown.refresh().pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to refresh wellknown manifests", { error }).pipe(Effect.as(false)),
              ),
            )
            if (!changed) yield* reload()
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to refresh wellknown config", { cause })))
        }),
      ),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* reconcile(initial)

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
    })
  }),
)

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      Watcher.node,
      EventV2.node,
      FSUtil.node,
      Global.node,
      Location.node,
      Policy.node,
      Credential.node,
      WellKnown.node,
    ],
  })
}

export const node = configured()
