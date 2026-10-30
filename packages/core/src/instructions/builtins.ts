export * as InstructionBuiltIns from "./builtins"

import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { ConfigCapabilities } from "../config/capabilities"
import { Global } from "../global"
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
  "decision-input": "question",
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
                `When working with a Git worktree, create it at \`${worktrees}/<repo-key>/<name>\`, where \`<repo-key>\` is \`repo_\` followed by the SHA-256 hex digest of the real path of the repository's Git common directory. Give every worktree a named branch identical to its worktree name, for example \`git worktree add -b <name> ${worktrees}/<repo-key>/<name>\`; never create a detached HEAD worktree. Keep history linear when integrating a worktree branch: if the target branch has moved, rebase the worktree branch onto it, then from the target branch checkout run \`git merge --ff-only --autostash <name>\`; never create a merge commit.`,
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
                "When progress requires user input, a decision, or review, call question with the blocker and the minimum actionable request; do not end with a prose-only request for the user to act. Use options for decisions and an empty options array for free-text input. Continue after the reply; do not call task_complete while blocked. Keep permission and guardrail approvals on their native request paths. Do not ask for routine progress, optional acknowledgement, or information you can obtain yourself. Preserve autonomy and permission rules; if question is unavailable or denied, report that blocker without bypassing it. An item already in the review box awaits an explicit decision whether awake or asleep; do not ask it again, guess its answer, retry its action, or count it as a goal no-progress attempt. Continue independent work; when only deferred items remain, state what is waiting and stop. Review decisions arrive as user messages without waking the family.",
              ),
              render: { initial: (instruction) => instruction, changed: (_previous, instruction) => instruction },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/decision-use"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.succeed(
                'Use decision for bounded typed judgments from the hidden helper. Confidence is self-reported and uncalibrated. Prefer tests, grep, typechecks, and inventory for facts. Supply authorized evidence, neutral questions, observable criteria, distinct choices including keep-current, and adjacent score levels. Batch independent questions; separate dependent judgments. Grade mode (`grade: true`) returns every typed choice once with confidence in [0,1] and nonempty evidence of at most 500 characters, without a pick. Example: {"provider":"agent","request":{"state":{},"questions":[{"type":"choice","name":"route","instructions":"Grade both routes","grade":true,"choices":[{"value":"keep-current"},{"value":"change"}]}]}} Treat refusal, invalid responses, unavailable routes, low confidence, and conflicting evidence as uncertainty. Set thresholds by mistake cost; preserve owner choices, guardrails, and permission ceilings. Reuse unchanged judgments. Explicit judgments never grant authority or prove completion. Permissions, guardrails, and answers each use a Manual, Auto, or YOLO decision mode set through /autonomous: Manual requires an explicit decision and makes no helper call, Auto applies deterministic rules with no model fallback, and YOLO enables a separate hidden evaluator for that category with allow/deny/escalate, not unrestricted approval. Explicit denies cannot be overridden; hard-policy and custom-rule reviews require explicit client approval. Unsettled requests ask the user awake or defer asleep; child questions go to parent controls. Never retry pending reviews or change security settings.',
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
