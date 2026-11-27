export * as InstructionBuiltIns from "./builtins"

import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { ConfigCapabilities } from "../config/capabilities"
import { Global } from "../global"
import { Location } from "../location"
import { SessionSchema } from "../session/schema"
import type { SessionScope } from "@ycoding-ai/schema/session-scope"
import { Instructions } from "./index"

export interface Input {
  readonly sessionID: SessionSchema.ID
  readonly capabilities: ConfigCapabilities.Resolved
  /** Tool names the selected agent can call; a block describing an absent tool is omitted. */
  readonly tools: ReadonlySet<string>
  readonly scope?: SessionScope
}

export interface Interface {
  readonly load: (input: Input) => Effect.Effect<Instructions.Instructions>
}

const requiredTool: Partial<Record<ConfigCapabilities.BuiltinInstruction, string>> = {
  "subagent-reuse": "subagent",
  "shell-memory": "shell",
  "decision-input": "question",
  "decision-use": "decision",
  "task-completion": "task_complete",
  memory: "memory",
}

export function enabled(name: ConfigCapabilities.BuiltinInstruction, input: Omit<Input, "sessionID">) {
  if (input.scope === "standalone" && (name === "environment" || name === "git-worktree" || name === "git-attribution" || name === "shell-memory")) return false
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
    const worktrees = path.join(Global.Path.data, "worktrees")
    const scratch = `Put new ad-hoc agent scratch files, logs, snapshots and patches in a unique per-task directory \`${path.join(Global.Path.data, "tasks")}/<unique-task-name>\`, never in a repository \`.cache\` directory. Leave existing repository and tool-managed caches in place and never move or delete them automatically. Built-in agents need no outside-directory confirmation under \`${Global.Path.data}\`; your agent's permissions, explicit denies, permission ceilings and guardrail reviews still apply.`
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
                  scratch,
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
                "Shell commands accept memory_limit_mb to constrain memory used by the command process tree. A finite limit supplies matching Go and Node runtime hints and terminates the process tree if sampled aggregate resident memory still exceeds the limit. Leave commands uncapped unless the project or user explicitly configures a limit; never impose unrequested resource limits.",
              ),
              render: {
                initial: (instruction) => instruction,
                changed: (_previous, instruction) => instruction,
              },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/git-worktree"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                `When working with a Git worktree, create it at \`${worktrees}/<repo-key>/<name>\`, where \`<repo-key>\` is \`repo_\` followed by the SHA-256 hex digest of the real path of the repository's Git common directory. Give every worktree a named branch identical to its worktree name, for example \`git worktree add -b <name> ${worktrees}/<repo-key>/<name>\`; never create a detached HEAD worktree. During authorized integration, use \`git diff --name-only\` between the previous and latest target heads to compare intermediate target changes against lane files. Automatically rebase linearly onto the latest target head when files are disjoint; ask only for overlapping file conflicts or failing checks. Complete consolidated checks, a single commit, linear rebase onto the latest target head, \`git merge --ff-only --autostash <name>\` from the target branch checkout, and safe non-force worktree removal in one continuous pass without ceremony, handoffs, or slots. Preserve unrelated work, existing Git identity, and permission boundaries; never create a merge commit. Prune stale registrations after verified worktree removal. Never stage, commit, integrate, or remove a worktree without authorization; this policy grants none.`,
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
              key: Instructions.Key.make("core/decision-input"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                "Resolve routine choices, minor ambiguities, and recoverable obstacles yourself from evidence first; call question only when progress genuinely needs underivable user input. Offer concise choices with a recommended default for decisions and empty options for free text, and continue immediately after its answer. Keep permission and guardrail approvals on their native paths. Answers YOLO handles every question, including explicit-decision and open questions, with a valid automatic answer or deterministic valid fallback instead of asking or deferring. Outside YOLO, unresolved requests wait for the user or defer to the review box while defer is active. Do not re-ask, retry or guess deferred manual decisions. /defer remains active across prompts until explicitly toggled off; review decisions do not change it. Call task_complete only after all work is verified.",
              ),
              render: { initial: (instruction) => instruction, changed: (_previous, instruction) => instruction },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/decision-use"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                'Use decision for bounded judgments from the hidden helper. Confidence is self-reported and uncalibrated. Prefer tests, grep, typechecks and inventory for facts. Supply authorized evidence, neutral questions, observable criteria, distinct choices including keep-current, and adjacent score levels. Batch independent questions; separate dependent judgments. Grade mode (`grade: true`) returns every choice once with confidence in [0,1] and bounded evidence, without a pick. Example: {"provider":"agent","request":{"state":{},"questions":[{"type":"choice","name":"route","instructions":"Grade both routes","grade":true,"choices":[{"value":"keep-current"},{"value":"change"}]}]}} Treat refusal, invalid output and conflicting evidence as uncertainty. Set thresholds by mistake cost; preserve owner choices and applicable guardrails. Reuse unchanged judgments. Judgments grant no authority or completion proof. /autonomous controls independent categories: Manual requires an explicit decision; Auto applies deterministic rules with no model fallback; YOLO removes every blocker in its category, including hard, catastrophic and destructive guardrails, permission denies and ceilings, and all questions. Answers YOLO uses a deterministic valid fallback when evaluation fails. Project coordinator separation remains enforced. Enabling YOLO in controls requires explicit risk acceptance. /defer persists across prompts and moves unresolved manual decisions to the review box.',
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
