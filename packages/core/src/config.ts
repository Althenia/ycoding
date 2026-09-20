export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { randomUUID } from "node:crypto"
import { Context, Effect, Fiber, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect"
import { Permission } from "@ycoding-ai/schema/permission"
import { Change, Commit, Event, Patch, Preview, Read, REDACTED, Source, WriteScope } from "@ycoding-ai/schema/config"
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
import { ConfigEfficiency } from "./config/efficiency"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigGuardrail } from "./config/guardrail"
import { ConfigImageAnalyzer } from "./config/image-analyzer"
import { ConfigLSP } from "./config/lsp"
import { ConfigMCP } from "./config/mcp"
import { ConfigModel } from "./config/model"
import { ConfigMemory } from "./config/memory"
import { ConfigNtfy } from "./config/ntfy"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigProviderUsage } from "./config/provider-usage"
import { ConfigReference } from "./config/reference"
import { ConfigShell } from "./config/shell"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigVariable } from "./config/variable"
import { ConfigWatcher } from "./config/watcher"
import { ConfigError } from "./config/error"
import { Hash } from "./util/hash"
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
  shell_memory_limit_mb: ConfigShell.MemoryLimitMb.pipe(Schema.optional).annotate({
    description:
      "Default resident-memory limit in MiB for shell command process trees. Zero or omission means unlimited; a command may override it.",
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
  memory: ConfigMemory.Info.pipe(Schema.optional).annotate({
    description: "On-demand workspace knowledge and offline graph configuration",
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
  ntfy: ConfigNtfy.Info.pipe(Schema.optional).annotate({
    description: "Optional ntfy attention-notification configuration",
  }),
  provider_usage: ConfigProviderUsage.Info.pipe(Schema.optional).annotate({
    description: "Read-only provider quota sources and optional local client bridges",
  }),
  efficiency: ConfigEfficiency.Info.pipe(Schema.optional).annotate({
    description: "Provider request, helper-model, prompt-cache, and continuation efficiency policy",
  }),
  image_analyzer: ConfigImageAnalyzer.Info.pipe(Schema.optional).annotate({
    description: "Image analysis fallback for text-only models: vision provider/model, prompt, and thresholds",
  }),
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

/** The highest-priority document that defines `key`, scanning lowest priority first. */
export function document(entries: readonly Entry[], key: keyof Info) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)
}

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return document(entries, key)?.info[key]
}

const PROJECT_CONFIG_NAMES = new Set(["ycoding.json", "ycoding.jsonc"])
const PROJECT_CONFIG_DIRECTORIES = new Set([".ycoding", ".agents", ".claude"])

/**
 * Classify a document path by where discovery found it. `global` is the platform configuration
 * directory, `project` is any discovered project document, and a document without a path is virtual.
 */
export function scopeOf(filepath: string | undefined, globalDirectory: string) {
  if (filepath === undefined) return "virtual" as const
  if (FSUtil.contains(globalDirectory, filepath)) return "global" as const
  return "project" as const
}

/** Whether `filepath` is a discoverable project configuration document the runtime may write. */
export function writable(filepath: string, globalDirectory: string) {
  const directory = path.dirname(filepath)
  const name = path.basename(filepath)
  return (
    scopeOf(filepath, globalDirectory) === "global" ||
    PROJECT_CONFIG_DIRECTORIES.has(path.basename(directory)) ||
    PROJECT_CONFIG_NAMES.has(name)
  )
}

/**
 * Replace secret-bearing leaves with `Config.REDACTED` so reads never return resolved
 * credentials. Whole records are replaced when the record itself is secret by contract
 * (provider `headers`, MCP `environment`); individual leaves are replaced for credential
 * field names such as `apiKey` and `client_secret`. Keys stay visible so clients can report
 * which values are configured without receiving them.
 */
export function redact(values: Record<string, unknown>): Record<string, unknown> {
  const secretRecords = new Set(["headers", "environment"])
  const secretKeys = new Set([
    "apiKey",
    "api_key",
    "apikey",
    "authorization",
    "access_token",
    "refresh_token",
    "client_secret",
    "clientSecret",
    "password",
    "token",
  ])
  const scrub = (input: unknown, key?: string): unknown => {
    if (key !== undefined && secretRecords.has(key) && typeof input === "object" && input !== null)
      return Object.fromEntries(Object.keys(input).map((name) => [name, REDACTED]))
    if (key !== undefined && secretKeys.has(key)) return REDACTED
    if (Array.isArray(input)) return input.map((item) => scrub(item))
    if (typeof input !== "object" || input === null) return input
    return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, scrub(value, name)]))
  }
  return scrub(values) as Record<string, unknown>
}

/** A validated patch with the exact bytes that would be written. */
interface Plan {
  readonly scope: WriteScope
  readonly path: string
  readonly current: string
  readonly keys: string[]
  readonly changes: Change[]
  readonly settled: string
}

export interface Interface {
  /** Returns location config documents and discovery sources from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
  /** Returns effective values with per-document provenance and secret-bearing values redacted. */
  readonly read: () => Effect.Effect<Read>
  /** Validates a patch and reports the changes and resulting revision without writing. */
  readonly preview: (patch: Patch) => Effect.Effect<Preview, ConfigError.InvalidErrorType>
  /**
   * Re-reads the target document, rejects a stale `expectedRevision`, applies the validated
   * patch with a comment- and formatting-preserving JSONC edit, writes atomically, and returns
   * the settled readback.
   */
  readonly commit: (patch: Patch) => Effect.Effect<Commit, ConfigError.InvalidErrorType>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  file: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Config") {}

export const layer = (options?: Options) =>
  Layer.effect(
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
        const discovered =
          locationIsGlobal || options?.project === false
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
              const changed = yield* wellknown
                .refresh()
                .pipe(
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

      const globalDirectory = AbsolutePath.make(global.config)

      const sources = (entries: readonly Entry[]): Effect.Effect<Source[], never, never> =>
        Effect.gen(function* () {
          return yield* Effect.forEach(
            entries.filter((entry): entry is Document => entry.type === "document"),
            (entry) =>
              Effect.gen(function* () {
                const text = entry.path ? yield* fs.readFileStringSafe(entry.path).pipe(Effect.orDie) : undefined
                const keys = Object.keys(entry.info).filter(
                  (key) => (entry.info as Record<string, unknown>)[key] !== undefined,
                )
                return new Source({
                  path: entry.path ?? "",
                  scope: scopeOf(entry.path, globalDirectory),
                  keys,
                  // A virtual or unreadable document still needs a stable identity so clients can
                  // report provenance; the decoded value set is the only available revision.
                  revision: Hash.sha256(text ?? JSON.stringify(entry.info)),
                })
              }),
          )
        })

      const readEntries = (entries: readonly Entry[]): Effect.Effect<Read, never, never> =>
        Effect.gen(function* () {
          const values = Object.fromEntries(
            Object.keys(Info.fields).flatMap((key) => {
              const value = latest(entries, key as keyof Info)
              return value === undefined ? [] : [[key, value]]
            }),
          )
          return new Read({ values: redact(values), sources: yield* sources(entries) })
        })

      /** The project document a write targets, or the global document when none is project-scoped. */
      const targetOf = (entries: readonly Entry[], scope: WriteScope) => {
        const documents = entries.filter(
          (entry): entry is Document => entry.type === "document" && entry.path !== undefined,
        )
        return documents.findLast((entry) => scopeOf(entry.path, globalDirectory) === scope)
      }

      const requireDocument = (entries: readonly Entry[], input: Patch) => {
        const target = targetOf(entries, input.scope)
        if (!target?.path) return undefined
        if (!writable(target.path, globalDirectory)) return undefined
        return target
      }

      const validate = (info: Info) =>
        Schema.decodeUnknownResult(Schema.Struct(Info.fields), {
          errors: "all",
          onExcessProperty: "error",
        })(info)

      /** Validate a patch against the target document and compute the settled file text. */
      const plan = (patch: Patch): Effect.Effect<Plan, ConfigError.InvalidErrorType> =>
        Effect.gen(function* () {
          const entries = configs
          const target = requireDocument(entries, patch)
          const targetPath = target?.path
          if (!targetPath) {
            return yield* Effect.fail(
              new ConfigError.InvalidError({
                path: "",
                message: `no ${patch.scope} configuration document is available to write`,
              }),
            )
          }
          const text = (yield* fs.readFileStringSafe(targetPath).pipe(Effect.orDie)) ?? "{}"
          const current = Hash.sha256(text)
          if (patch.expectedRevision !== undefined && patch.expectedRevision !== current) {
            return yield* Effect.fail(
              new ConfigError.InvalidError({
                path: targetPath,
                message: "configuration changed since it was read; re-read before writing",
              }),
            )
          }

          const keys = Object.keys(patch.patch)
          const removed = keys.filter((key) => removedConfigKeys({ [key]: patch.patch[key] }).length > 0)
          if (removed.length) {
            return yield* Effect.fail(
              new ConfigError.InvalidError({
                path: targetPath,
                message: `removed configuration keys: ${removed.join(", ")}`,
              }),
            )
          }

          const next = Object.fromEntries(
            Object.entries({ ...(target.info as Record<string, unknown>) }).filter(([key]) => key !== "$schema"),
          )
          for (const key of keys) {
            const value = patch.patch[key]
            if (value === null) delete next[key]
            else next[key] = value
          }
          const decoded = validate(next)
          if (decoded._tag === "Failure") {
            const fields = keys.filter((key) => Object.hasOwn(Info.fields, key))
            return yield* Effect.fail(
              new ConfigError.InvalidError({
                path: targetPath,
                message: fields.length
                  ? `invalid configuration values for ${fields.join(", ")}; check the configuration schema`
                  : "invalid configuration keys or values; check the configuration schema",
              }),
            )
          }

          const visible = redact(patch.patch)
          const changes = keys.map(
            (key) =>
              new Change({
                key,
                value: patch.patch[key] === null ? undefined : visible[key],
              }),
          )
          const edits = keys.reduce(
            (accumulated, key) =>
              applyEdits(
                accumulated,
                modify(accumulated, [key], patch.patch[key] === null ? undefined : patch.patch[key], {
                  formattingOptions: { tabSize: 2, insertSpaces: true },
                }),
              ),
            text,
          )
          return {
            scope: patch.scope,
            path: targetPath,
            current,
            keys,
            changes,
            settled: edits.endsWith("\n") ? edits : edits + "\n",
          }
        })

      const preview = (input: Patch): Effect.Effect<Preview, ConfigError.InvalidErrorType> =>
        Effect.gen(function* () {
          const planned = yield* plan(input)
          return new Preview({
            scope: planned.scope,
            path: planned.path,
            // Preview validates against the current bytes and reports the revision the caller must
            // pass back to commit, so a concurrent edit is still detected at write time.
            revision: planned.current,
            result: Hash.sha256(planned.settled),
            changes: planned.changes,
          })
        })

      const commit = (input: Patch): Effect.Effect<Commit, ConfigError.InvalidErrorType> =>
        Effect.gen(function* () {
          const planned = yield* plan(input)

          // Preserve an existing restrictive mode instead of widening a config file's permissions.
          const mode = yield* fs.stat(planned.path).pipe(
            Effect.map((info) => info.mode & 0o777),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          const temp = `${planned.path}.${randomUUID()}.tmp`
          yield* fs.writeFileString(temp, planned.settled, mode === undefined ? undefined : { mode }).pipe(Effect.orDie)
          yield* fs.rename(temp, planned.path).pipe(Effect.orDie)

          // The write target is always a document discovery already found, so its watch exists;
          // only the decoded values and the derived policies need to be refreshed here.
          // `ConfigVariable.substitute` reaches for `FSUtil` from context, so satisfy it with the
          // service this layer already holds instead of widening the public requirement.
          const reloaded = yield* discover().pipe(Effect.provideService(FSUtil.Service, fs))
          configs = reloaded
          yield* loadPolicies(reloaded)
          yield* events.publish(Event.Updated, {})

          return new Commit({
            scope: planned.scope,
            path: planned.path,
            revision: Hash.sha256(planned.settled),
            changes: planned.changes,
            unsettled: planned.keys.filter((key) => document(reloaded, key as keyof Info)?.path !== planned.path),
            read: yield* readEntries(reloaded),
          })
        })

      return Service.of({
        entries: Effect.fn("Config.entries")(function* () {
          return configs
        }),
        read: Effect.fn("Config.read")(function* () {
          return yield* readEntries(configs)
        }),
        preview,
        commit,
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
