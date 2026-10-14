export * as InstructionBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { ConfigCapabilities } from "../config/capabilities"
import { Location } from "../location"
import { SessionSchema } from "../session/schema"
import { Instructions } from "./index"

export interface Input {
  readonly sessionID: SessionSchema.ID
  readonly capabilities: ConfigCapabilities.Resolved
  /** Tool names the selected agent can call; a block describing an absent tool is omitted. */
  readonly tools: ReadonlySet<string>
}

export interface Interface {
  readonly load: (input: Input) => Effect.Effect<Instructions.Instructions>
}

const requiredTool: Partial<Record<ConfigCapabilities.BuiltinInstruction, string>> = {
  "subagent-reuse": "subagent",
  "shell-memory": "shell",
  "project-artifact-authoring": "project_artifact",
  "human-input": "question",
  "decision-use": "decision",
  "task-completion": "task_complete",
  memory: "memory",
}

export function enabled(name: ConfigCapabilities.BuiltinInstruction, input: Omit<Input, "sessionID">) {
  const tool = requiredTool[name]
  return (
    ConfigCapabilities.allows(input.capabilities.builtin_instructions, name) &&
    (tool === undefined || input.tools.has(tool))
  )
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/InstructionBuiltIns") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const decodeName = Schema.decodeUnknownSync(ConfigCapabilities.BuiltinInstruction)
    return Service.of({
      load: (input) =>
        Effect.succeed(
          Instructions.combine([
            Instructions.make({
              key: Instructions.Key.make("core/environment"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.sync(() =>
                [
                  "<env>",
                  `  Working directory: ${location.directory}`,
                  `  Workspace root folder: ${location.project.directory}`,
                  `  Is directory a git repo: ${location.vcs?.type === "git" ? "yes" : "no"}`,
                  `  Platform: ${process.platform}`,
                  "</env>",
                ].join("\n"),
              ),
              render: {
                initial: (environment) =>
                  ["Here is some useful information about the environment you are running in:", environment].join("\n"),
                changed: (_previous, environment) =>
                  ["The environment you are running in is now:", environment].join("\n"),
              },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/date"),
              codec: Schema.toCodecJson(Schema.String),
              read: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
              render: {
                initial: (date) => `Today's date: ${date}`,
                changed: (_previous, date) => `Today's date is now: ${date}`,
              },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/subagent-reuse"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                "Before launching a subagent, inspect the current direct child TeamView. Reuse a relevant direct terminal child with subagent_control send when its agent, domain, model, and retained context fit; send only incremental context. Launch a new child when role, model, location, permission, or task context does not fit. Use resume only for durable pending work.",
              ),
              render: {
                initial: (instruction) => instruction,
                changed: (_previous, instruction) => instruction,
              },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/shell-memory"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                "Shell commands accept memory_limit_mb to constrain memory used by the command process tree. A finite limit supplies matching Go and Node runtime hints and terminates the process tree if sampled aggregate resident memory still exceeds the limit. Use it for commands likely to consume large amounts of memory, including builds, typechecks, test suites, bundlers, and large data processing. Leave ordinary commands uncapped unless the project or user supplies a default. If a command reaches the limit, inspect its workload before increasing the cap; never remove the limit only to force completion.",
              ),
              render: {
                initial: (instruction) => instruction,
                changed: (_previous, instruction) => instruction,
              },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/project-artifact-authoring"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                "At a safe boundary after the primary task is complete and validated, create or update at most one Project Artifact for each newly learned reusable insight. The insight must be repeated, durable, repository-specific, and useful in future work. Never persist transient task state, current todos, user preferences, prompts, logs, secrets, credentials, private paths/URLs, customer data, or speculation. Search existing artifacts first and update the owned project version rather than duplicating it. Prefer a skill; use a command only for an invokable instruction-only template; use a least-privilege agent only for a genuine reusable role. Workflows are not a first-class artifact. Never create or enable a plugin automatically. Do not interrupt the primary task to author an artifact.",
              ),
              render: { initial: (instruction) => instruction, changed: (_previous, instruction) => instruction },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/git-worktree"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                "When working with a Git worktree, create it at `<main repository root>/.worktrees/<name>`, creating the `.worktrees` directory first if it does not exist. Give every worktree a named branch identical to its worktree name, for example `git worktree add -b <name> .worktrees/<name>`; never create a detached HEAD worktree. Keep history linear when integrating a worktree branch: if the target branch has moved, rebase the worktree branch onto it, then from the target branch checkout run `git merge --ff-only --autostash <name>`; never create a merge commit.",
              ),
              render: { initial: (instruction) => instruction, changed: (_previous, instruction) => instruction },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/git-attribution"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                "When creating commits, use the user's existing Git author and committer identity and write messages without Co-authored-by trailers or AI, model, agent, or provider attribution. Do not set `user.name`, `user.email`, or `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, or pass `--author` or `--reset-author`, as part of committing. If Git reports a missing identity, report it and ask the user to configure their own identity; never invent one.",
              ),
              render: { initial: (instruction) => instruction, changed: (_previous, instruction) => instruction },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/human-input"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                "When progress requires user input, a decision, or review, call question with the blocker and the minimum actionable request; do not end with a prose-only request for the user to act. Use options for decisions and an empty options array for free-text input. Continue after the reply; do not call task_complete while blocked. Keep permission and guardrail approvals on their native request paths. Do not ask for routine progress, optional acknowledgement, or information you can obtain yourself. Preserve autonomy and permission rules; if question is unavailable or denied, report that blocker without bypassing it.",
              ),
              render: { initial: (instruction) => instruction, changed: (_previous, instruction) => instruction },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/decision-use"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                'Use decision for a bounded typed judgment from a hidden helper model; confidence is self-reported and uncalibrated. Use it to choose a subagent model/variant among verified candidates, choose concrete options, classify risk, grade candidates or findings against a rubric, settle predicates tests cannot settle, or recommend an option before question. Use tests, grep, typecheck, and inventory for verifiable facts. Skip trivial or low-impact choices, unchanged judgments, and routine per-step classification. Supply self-contained authorized evidence and observable criteria; use neutral wording, distinct options with keep-current/other fallback, and distinct adjacent score levels. Batch independent questions; separate dependent ones. Example: {"provider":"agent","request":{"state":{"alternatives":"Two approaches have comparable cost; requirements are incomplete"},"questions":[{"type":"choice","name":"route","instructions":"Choose the better-supported approach","choices":[{"value":"keep-current","description":"Retain current approach"},{"value":"change","description":"Use the alternative"}]},{"type":"predicate","name":"ready","instructions":"Does the evidence support starting now?"}]}} Set the bar by the cost of being wrong. Treat refusal (including insufficient evidence), errors, low or close confidence, and disagreement with evidence as uncertainty; gather missing evidence, decide from evidence, or ask the user. Reuse settled judgments until evidence changes. Never treat judgments as permission, approval, the user’s answer, or completion proof. Preserve explicit owner choices and guardrails; report unavailable or denied evaluation without repeated probes.',
              ),
              render: { initial: (instruction) => instruction, changed: (_previous, instruction) => instruction },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/task-completion"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                "Call task_complete once after all accepted work is finished and verified, immediately before your final reply. Do not call it for ordinary replies, idle, partial results, blockers, or unfinished pending, subagent, or background work. In goal mode, first complete the achieved goal with the goal tool; goal completion alone is not work-completion evidence. If new input or unfinished work intervenes, finish and verify it before declaring completion again.",
              ),
              render: { initial: (instruction) => instruction, changed: (_previous, instruction) => instruction },
            }),
          ]).flatMap((source) =>
            Instructions.when(enabled(decodeName(source.key.slice("core/".length)), input), [source]),
          ),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
