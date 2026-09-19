export * as MemoryTool from "./memory"

import type { Context } from "@ycoding-ai/plugin/effect/plugin"
import { ToolFailure } from "@ycoding-ai/ai"
import { Effect, Schema } from "effect"
import { Memory } from "../memory"
import { MemoryFormat } from "../memory/format"
import { PermissionV2 } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "./tool"

const Limit = Schema.Int.check(Schema.isGreaterThan(0))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Scope = Schema.optional(Schema.Literals(["repository", "knowledge"]))
const Read = [
  Schema.Struct({ action: Schema.Literal("status"), scope: Scope }),
  Schema.Struct({
    action: Schema.Literal("list"),
    scope: Scope,
    limit: Schema.optional(Limit.check(Schema.isLessThanOrEqualTo(100))),
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    action: Schema.Literal("search"),
    scope: Scope,
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    limit: Schema.optional(Limit.check(Schema.isLessThanOrEqualTo(50))),
    type: Schema.optional(Schema.String),
    tag: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("read"), scope: Scope, id: MemoryFormat.ID }),
  Schema.Struct({
    action: Schema.Literal("trash"),
    scope: Scope,
    limit: Schema.optional(Limit.check(Schema.isLessThanOrEqualTo(100))),
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({ action: Schema.Literal("vacuum"), scope: Scope, dryRun: Schema.optional(Schema.Boolean), expectedDigest: Schema.optional(Digest) }),
]
export const Input = Schema.Union([
  ...Read,
  Schema.Struct({ action: Schema.Literal("graph"), scope: Scope }),
  Schema.Struct({
    action: Schema.Literal("write"),
    scope: Scope,
    id: MemoryFormat.ID,
    content: Schema.String,
    expectedDigest: Schema.optional(Digest),
  }),
  Schema.Struct({ action: Schema.Literal("delete"), scope: Scope, id: MemoryFormat.ID, expectedDigest: Digest }),
  Schema.Struct({ action: Schema.Literal("restore"), scope: Scope, trashID: Schema.String, expectedDigest: Digest }),
  Schema.Struct({ action: Schema.Literal("purge"), scope: Scope, trashID: Schema.String, expectedDigest: Digest }),
])
const Warning = Schema.Struct({ id: Schema.String, code: Schema.String })
const Concept = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  digest: Schema.String,
})
const TrashEntry = Schema.Struct({ id: Schema.String, trashID: Schema.String, digest: Schema.String })
export const Output = Schema.Union([
  Schema.Struct({
    enabled: Schema.Boolean,
    scope: Schema.Literals(["repository", "knowledge"]),
    root: Schema.String,
    base: Schema.String,
    knowledgeRoot: Schema.String,
    repository: Schema.optional(
      Schema.Struct({
        id: Schema.String,
        directory: Schema.String,
        commonDirectory: Schema.String,
        worktrees: Schema.Array(Schema.String),
      }),
    ),
    limits: Schema.Struct({
      enabled: Schema.Boolean,
      path: Schema.optional(Schema.String),
      max_concept_bytes: Schema.Number,
      max_bundle_bytes: Schema.Number,
      max_concepts: Schema.Number,
    }),
  }),
  Schema.Struct({ concepts: Schema.Array(Concept), total: Schema.Number, warnings: Schema.Array(Warning) }),
  Schema.Struct({ hits: Schema.Array(Schema.Struct({ ...Concept.fields, score: Schema.Number, snippet: Schema.String })), warnings: Schema.Array(Warning) }),
  Schema.Struct({ id: Schema.String, content: Schema.String, digest: Schema.String }),
  Schema.Struct({ id: Schema.String, digest: Schema.String, created: Schema.Boolean, warnings: Schema.Array(Warning) }),
  Schema.Struct({ id: Schema.String, trashID: Schema.String, digest: Schema.String, warnings: Schema.Array(Warning) }),
  Schema.Struct({ id: Schema.String, digest: Schema.String, warnings: Schema.Array(Warning) }),
  Schema.Struct({ entries: Schema.Array(TrashEntry), total: Schema.Number, warnings: Schema.Array(Warning) }),
  Schema.Struct({ trashID: Schema.String, purged: Schema.Boolean, warnings: Schema.Array(Warning) }),
  Schema.Struct({ dryRun: Schema.Boolean, digest: Schema.String, removed: Schema.Array(Schema.String), warnings: Schema.Array(Warning) }),
  Schema.Struct({ path: Schema.String, digest: Schema.String, nodes: Schema.Number, edges: Schema.Number, warnings: Schema.Array(Warning) }),
])

const description = [
  "Use on-demand knowledge for the active workspace: status, list, lexical search, read, write linked Markdown, export an offline HTML graph, or maintain entries.",
  "scope defaults to the active Git repository and may be 'knowledge' for shared cross-repository concepts; outside Git only the knowledge scope is available.",
  "Never automatically save transcripts or inject memory. Read before replacing or deleting a concept and supply its digest.",
  "delete moves an entry to recoverable trash, trash lists it, restore returns it without overwriting, purge permanently removes one exact trash entry, and vacuum previews derived cleanup (dryRun defaults true).",
  "IDs are lowercase paths without extensions; index/log are reserved. Markdown requires YAML frontmatter type. The graph is a local file; it makes no network requests.",
].join("\n")

export const Plugin = {
  id: "ycoding.tool.memory",
  effect: Effect.fn("MemoryTool.Plugin")(function* (ctx: Context) {
    const memory = yield* Memory.Service
    const permission = yield* PermissionV2.Service
    const guardrail = yield* SessionGuardrail.Service
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          "memory",
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const scope = input.action === "status" ? input.scope ?? "repository" : input.scope
                const status = yield* memory.status(scope ?? "repository")
                if (!status.enabled && input.action !== "status")
                  return yield* new ToolFailure({ message: "Workspace memory is disabled." })
                const visibility = yield* permission.evaluateEffective({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  action: "memory",
                  resource: status.root,
                })
                if (visibility === "deny") return yield* new ToolFailure({ message: "Workspace memory is denied." })
                const applying = input.action === "vacuum" && input.dryRun === false
                const mutating = mutationActions.has(input.action) || applying
                const source = { type: "tool" as const, messageID: context.messageID, callID: context.callID }
                yield* permission.assert({
                  action: mutating ? "memory_write" : "memory_read",
                  resources: [status.root],
                  save: ["*"],
                  metadata: { operation: input.action, scope: status.scope },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                if (input.action === "status")
                  return {
                    enabled: status.enabled,
                    scope: status.scope,
                    root: status.root,
                    base: status.base,
                    knowledgeRoot: status.knowledgeRoot,
                    ...(status.repository === undefined ? {} : { repository: status.repository }),
                    limits: status.limits,
                  }
                if (input.action === "list") return yield* memory.list(input, status.root)
                if (input.action === "search") return yield* memory.search(input, status.root)
                if (input.action === "read") return yield* memory.read(input, status.root)
                if (input.action === "trash") return yield* memory.trash(input, status.root)
                // Vacuum preview is read-only: no storage creation, no lock files, no guardrail.
                if (input.action === "vacuum" && !applying) return yield* memory.vacuum(input, status.root)
                // A repository graph export includes shared knowledge, so it additionally requires
                // read authority for the knowledge root. Other operations never touch it.
                if (input.action === "graph" && status.scope === "repository")
                  yield* permission.assert({
                    action: "memory_read",
                    resources: [status.knowledgeRoot],
                    save: ["*"],
                    metadata: { operation: "graph", scope: "knowledge" },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                const reservation = yield* guardrail.assert({
                  sessionID: context.sessionID,
                  action: "file_mutation",
                  resources: [status.root],
                  metadata: {
                    operation: removalActions.has(input.action) ? "remove" : "write",
                    memoryAction: input.action,
                  },
                })
                const guarded = (effect: Effect.Effect<unknown, unknown>) =>
                  effect.pipe(Effect.ensuring(reservation.release))
                if (input.action === "write") return yield* guarded(memory.write(input, status.root))
                if (input.action === "delete") return yield* guarded(memory.delete(input, status.root))
                if (input.action === "restore") return yield* guarded(memory.restore(input, status.root))
                if (input.action === "purge") return yield* guarded(memory.purge(input, status.root))
                if (input.action === "vacuum") return yield* guarded(memory.vacuum(input, status.root))
                return yield* guarded(memory.graph({ scope: input.scope }, status.root))
              }).pipe(
                Effect.mapError((error) =>
                  new ToolFailure({
                    message:
                      error instanceof Memory.MemoryError || error instanceof ToolFailure
                        ? error.message
                        : "Workspace memory operation was denied or failed.",
                  }),
                ),
              ),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}

/** Actions that always mutate; vacuum applies only when `dryRun` is explicitly false. */
const mutationActions = new Set(["write", "delete", "restore", "purge", "graph"])
const removalActions = new Set(["delete", "purge", "vacuum"])