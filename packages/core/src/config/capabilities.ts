export * as ConfigCapabilities from "./capabilities"

import { Schema } from "effect"
import { Wildcard } from "../util/wildcard"

export const BuiltinInstruction = Schema.Literals([
  "environment",
  "date",
  "subagent-reuse",
  "shell-memory",
  "project-artifact-authoring",
  "git-worktree",
  "git-attribution",
  "human-input",
  "decision-use",
  "task-completion",
  "memory",
])
export type BuiltinInstruction = typeof BuiltinInstruction.Type

const selection = <S extends Schema.Top>(item: S, subject: string) =>
  Schema.Struct({
    enabled: Schema.optional(Schema.Boolean).annotate({
      description: `Set false to turn off every ${subject} (default: true).`,
    }),
    allow: Schema.optional(Schema.Array(item)).annotate({
      description: `When set, only ${subject} matching one of these names stay available.`,
    }),
    deny: Schema.optional(Schema.Array(item)).annotate({
      description: `${subject} matching one of these names are unavailable; deny wins over allow.`,
    }),
  })

export const Selection = selection(Schema.String, "matching item")
export type Selection = typeof Selection.Type

export class Info extends Schema.Class<Info>("Config.Capabilities")({
  instructions: Schema.optional(
    Schema.Struct({
      global: Schema.optional(Schema.Boolean).annotate({
        description: "Load AGENTS.md from the global YCoding config directory (default: true).",
      }),
      project: Schema.optional(Schema.Boolean).annotate({
        description:
          "Load project AGENTS.md files, both upward discovery and nested files injected after reads (default: true).",
      }),
      exclude: Schema.optional(Schema.Array(Schema.String)).annotate({
        description: "Wildcard patterns matched against absolute AGENTS.md paths; matching files are never loaded.",
      }),
    }),
  ).annotate({ description: "Ambient AGENTS.md instruction discovery" }),
  builtin_instructions: Schema.optional(selection(BuiltinInstruction, "built-in instruction blocks")).annotate({
    description: "Built-in instruction blocks by name",
  }),
  skills: Schema.optional(selection(Schema.String, "skills")).annotate({
    description: "Skills by ID from every discovery source",
  }),
  tools: Schema.optional(selection(Schema.String, "tools")).annotate({
    description: "Tools by registered name",
  }),
  mcp: Schema.optional(selection(Schema.String, "MCP servers")).annotate({
    description: "MCP servers by configured name",
  }),
  plugins: Schema.optional(selection(Schema.String, "external plugins")).annotate({
    description: "External plugins by plugin ID",
  }),
  project_artifacts: Schema.optional(Schema.Boolean).annotate({
    description: "Apply managed project artifacts and expose the project_artifact tool (default: true).",
  }),
  home_roots: Schema.optional(Schema.Boolean).annotate({
    description: "Discover ~/.agents and ~/.claude ecosystem roots (default: true).",
  }),
  websearch_provider: Schema.optional(Schema.Literals(["exa", "parallel"])).annotate({
    description: "Pin the websearch tool provider instead of environment or Session-derived selection.",
  }),
}) {}

export type Resolved = {
  readonly instructions?: Info["instructions"]
  readonly builtin_instructions?: Info["builtin_instructions"]
  readonly skills?: Selection
  readonly tools?: Selection
  readonly mcp?: Selection
  readonly plugins?: Selection
  readonly project_artifacts?: boolean
  readonly home_roots?: boolean
  readonly websearch_provider?: Info["websearch_provider"]
}

/** Merges layers from lowest to highest priority: each leaf field is last-wins and lists replace. */
export function resolve(infos: ReadonlyArray<Info | undefined>): Resolved {
  return infos.reduce<Record<string, unknown>>((merged, info) => {
    if (!info) return merged
    return Object.fromEntries([
      ...Object.entries(merged),
      ...Object.entries(info).flatMap(([key, value]) => {
        if (value === undefined) return []
        if (typeof value !== "object" || Array.isArray(value)) return [[key, value]]
        const previous = merged[key]
        return [[key, { ...(typeof previous === "object" ? previous : {}), ...defined(value) }]]
      }),
    ])
  }, {}) as Resolved
}

export function allows(selection: Selection | undefined, name: string) {
  if (!selection) return true
  if (selection.enabled === false) return false
  if (selection.deny?.some((pattern) => Wildcard.match(name, pattern))) return false
  return selection.allow === undefined || selection.allow.some((pattern) => Wildcard.match(name, pattern))
}

export function allowsTool(capabilities: Resolved, name: string) {
  if (name === "skill" && capabilities.skills?.enabled === false) return false
  if (name === "project_artifact" && capabilities.project_artifacts === false) return false
  // CodeMode's `execute` wrapper follows the tools it carries; only `enabled: false` or a deny hides it.
  if (name === "execute") return allows(capabilities.tools && { ...capabilities.tools, allow: undefined }, name)
  return allows(capabilities.tools, name)
}

export function allowsInstruction(capabilities: Resolved, path: string, source: "global" | "project") {
  if (capabilities.instructions?.[source] === false) return false
  return !capabilities.instructions?.exclude?.some((pattern) => Wildcard.match(path, pattern))
}

function defined(value: object) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
