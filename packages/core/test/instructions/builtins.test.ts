import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Location } from "@ycoding-ai/core/location"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { InstructionBuiltIns } from "@ycoding-ai/core/instructions/builtins"
import { Instructions } from "@ycoding-ai/core/instructions/index"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { ProjectArtifactInstructions } from "../../src/project-artifact/instructions"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { readInitial, readUpdate } from "../lib/instructions"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const sessionID = SessionSchema.ID.make("ses_builtin_test")
const otherSessionID = SessionSchema.ID.make("ses_builtin_other")
const localDate = (time: number) => new Date(time).toDateString()
const gitAttribution =
  "When creating commits, use the user's existing Git author and committer identity and write messages without Co-authored-by trailers or AI, model, agent, or provider attribution. Do not set `user.name`, `user.email`, or `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, or pass `--author` or `--reset-author`, as part of committing. If Git reports a missing identity, report it and ask the user to configure their own identity; never invent one."
const taskCompletion =
  "Call task_complete once after all accepted work is finished and verified, immediately before your final reply. Do not call it for ordinary replies, idle, partial results, blockers, or unfinished pending, subagent, or background work. In goal mode, first complete the achieved goal with the goal tool; goal completion alone is not work-completion evidence. If new input or unfinished work intervenes, finish and verify it before declaring completion again."
const humanInput =
  "When progress requires user input, a decision, or review, call question with the blocker and the minimum actionable request; do not end with a prose-only request for the user to act. Use options for decisions and an empty options array for free-text input. Continue after the reply; do not call task_complete while blocked. Keep permission and guardrail approvals on their native request paths. Do not ask for routine progress, optional acknowledgement, or information you can obtain yourself. Preserve autonomy and permission rules; if question is unavailable or denied, report that blocker without bypassing it. An item already in the review box awaits a human decision whether awake or asleep; do not ask it again, guess its answer, retry its action, or count it as a goal no-progress attempt. Continue independent work; when only deferred items remain, state what is waiting and stop. Review decisions arrive as user messages without waking the family."
const decisionUse =
  'Use decision for bounded typed judgments from the hidden helper. Confidence is self-reported and uncalibrated. Prefer tests, grep, typechecks, and inventory for facts. Supply authorized evidence, neutral questions, observable criteria, distinct choices including keep-current, and adjacent score levels. Batch independent questions; separate dependent judgments. Grade mode returns every typed choice once with confidence in [0,1] and nonempty evidence of at most 500 characters, without a pick. Example: {"provider":"agent","request":{"state":{},"questions":[{"type":"choice","name":"route","instructions":"Grade both routes","grade":true,"choices":[{"value":"keep-current"},{"value":"change"}]}]}} Treat refusal, invalid responses, unavailable routes, low confidence, and conflicting evidence as uncertainty. Set thresholds by mistake cost; preserve owner choices, guardrails, and permission ceilings. Reuse unchanged judgments. Explicit judgments never grant authority or prove completion. Baseline permission and guardrail assessment uses allow/deny/escalate; guardrails.decide_reviews defaults on and respects explicit false. Independent /auto-permission, /auto-guardrail, and /auto-answer flags apply rule automation. Boolean YOLO enables separate hidden agentic evaluation, not unrestricted approval. Explicit denies cannot be overridden; actual hard-policy matches require human approval. Unsettled requests ask humans awake or defer asleep; child questions go to parent controls. Never retry pending human reviews or change security settings.'
const allTools = new Set(["subagent", "shell", "project_artifact", "question", "decision", "task_complete", "memory"])
const input = (id: SessionSchema.ID, overrides: Partial<Omit<InstructionBuiltIns.Input, "sessionID">> = {}) => ({
  sessionID: id,
  capabilities: {},
  tools: allTools,
  ...overrides,
})
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const it = testEffect(
  AppNodeBuilder.build(InstructionBuiltIns.node, [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ data: "/data", config: "/global" })],
  ]),
)

describe("InstructionBuiltIns", () => {
  it.effect("teaches compact explicit judgments with valid batched examples and no removed policies", () => Effect.gen(function* () {
    const builtins = yield* InstructionBuiltIns.Service
    const source = (yield* builtins.load(input(sessionID))).find((item) => item.key === "core/decision-use")!
    const value = yield* source.read
    const text = typeof value === "string" ? value : ""
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(220)
    for (const phrase of ["hidden helper", "uncalibrated", "tests", "grep", "typecheck", "inventory", "neutral", "observable", "adjacent", "dependent", "cost", "owner", "guardrails", "refusal", "keep-current"]) expect(text).toContain(phrase)
    for (const phrase of ["defaults on", "explicit false", "allow/deny/escalate", "Boolean YOLO", "Independent /auto-permission", "hard-policy matches require human approval"])
      expect(text).toContain(phrase)
    expect(text).not.toMatch(/YOLO [0123]|decide_reviews \(default false\)/)
    expect(text).not.toMatch(/advisory|automatic polic|scope tool|Use scope|native API/i)
    const example = text.match(/Example: (\{.*\})/)
    expect(example).not.toBeNull()
    const { Decision } = yield* Effect.promise(() => import("../../src/decision"))
    const { Schema } = yield* Effect.promise(() => import("effect"))
    expect(Schema.is(Decision.Input)(JSON.parse(example![1]))).toBe(true)
  }))
  test("guides reusable artifact learning without recording one-off failures", () => {
    expect(ProjectArtifactInstructions.content).toBe(
      "At a safe boundary after the primary task is complete and validated, create or update at most one Project Artifact for each newly learned reusable insight. The insight must be repeated, durable, repository-specific, and useful in future work. When correcting the immediate task, identify any validated repeated mistake, failed approach, or repository gotcha and the safer reusable rule it establishes; do not treat artifacts as punishment or record one-off failures. Never persist transient task state, current todos, user preferences, prompts, logs, secrets, credentials, private paths or URLs, customer data, or speculation. Search existing artifacts first and update the owned project version rather than duplicating it. Prefer a skill; use a command only for an invokable instruction-only template; use a least-privilege agent only for a genuine reusable role. Workflows are not a first-class artifact. Never create or enable a plugin automatically. Do not interrupt the primary task to author an artifact.",
    )
  })

  it.effect("loads location-scoped environment and host-local date instructions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load(input(sessionID)))

      expect(initialized.text).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
          "",
          "Before launching a subagent, inspect the current direct child TeamView. Reuse a relevant direct terminal child with subagent_control send when its agent, domain, model, and retained context fit; send only incremental context. Launch a new child when role, model, location, permission, or task context does not fit. Use resume only for durable pending work.",
          "",
          "Shell commands accept memory_limit_mb to constrain memory used by the command process tree. A finite limit supplies matching Go and Node runtime hints and terminates the process tree if sampled aggregate resident memory still exceeds the limit. Use it for commands likely to consume large amounts of memory, including builds, typechecks, test suites, bundlers, and large data processing. Leave ordinary commands uncapped unless the project or user supplies a default. If a command reaches the limit, inspect its workload before increasing the cap; never remove the limit only to force completion.",
          "",
          "At a safe boundary after the primary task is complete and validated, create or update at most one Project Artifact for each newly learned reusable insight. The insight must be repeated, durable, repository-specific, and useful in future work. Never persist transient task state, current todos, user preferences, prompts, logs, secrets, credentials, private paths/URLs, customer data, or speculation. Search existing artifacts first and update the owned project version rather than duplicating it. Prefer a skill; use a command only for an invokable instruction-only template; use a least-privilege agent only for a genuine reusable role. Workflows are not a first-class artifact. Never create or enable a plugin automatically. Do not interrupt the primary task to author an artifact.",
          "",
          "When working with a Git worktree, create it at `<main repository root>/.worktrees/<name>`, creating the `.worktrees` directory first if it does not exist. Give every worktree a named branch identical to its worktree name, for example `git worktree add -b <name> .worktrees/<name>`; never create a detached HEAD worktree. Keep history linear when integrating a worktree branch: if the target branch has moved, rebase the worktree branch onto it, then from the target branch checkout run `git merge --ff-only --autostash <name>`; never create a merge commit.",
          "",
          gitAttribution,
          "",
          humanInput,
          "",
          decisionUse,
          "",
          taskCompletion,
        ].join("\n"),
      )
    }),
  )

  it.effect("keeps model-visible environment instructions stable across sessions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const first = yield* readInitial(yield* context.load(input(sessionID)))
      const second = yield* readInitial(yield* context.load(input(otherSessionID)))

      expect(second.text).toBe(first.text)
      expect(first.text).not.toContain(sessionID)
      expect(first.text).not.toContain(otherSessionID)
    }),
  )

  it.effect("appends one stable explicit work-completion directive for every Session", () =>
    Effect.gen(function* () {
      const builtins = yield* InstructionBuiltIns.Service
      const first = yield* builtins.load(input(sessionID))
      const second = yield* builtins.load(input(otherSessionID))
      expect(first.at(-1)?.key).toBe(Instructions.Key.make("core/task-completion"))
      const source = first.at(-1)!
      const value = yield* source.read
      expect(value).toBe(taskCompletion)
      expect(source.initial(taskCompletion)).toBe(taskCompletion)
      expect(source.changed(taskCompletion, taskCompletion)).toBe(taskCompletion)
      expect(yield* second.at(-1)!.read).toBe(value)
    }),
  )

  it.effect("routes required human input and review through question for every Session", () =>
    Effect.gen(function* () {
      const builtins = yield* InstructionBuiltIns.Service
      const first = (yield* builtins.load(input(sessionID))).find((source) => source.key === "core/human-input")
      const second = (yield* builtins.load(input(otherSessionID))).find((source) => source.key === "core/human-input")
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(yield* first!.read).toBe(humanInput)
      expect(first!.initial(humanInput)).toBe(humanInput)
      expect(first!.changed(humanInput, humanInput)).toBe(humanInput)
      expect(yield* second!.read).toBe(humanInput)
    }),
  )

  it.effect("updates the date without repeating unchanged environment instructions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load(input(sessionID)))

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* readUpdate(yield* context.load(input(sessionID)), initialized)

      expect(refreshed.text).toBe(`Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`)
    }),
  )

  it.effect("admits decision-use guidance once into an existing Session's model-visible instructions", () =>
    Effect.gen(function* () {
      const builtins = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* builtins.load(input(sessionID)))
      expect(initialized.values["core/decision-use"]).toBe(decisionUse)
      const previous = {
        values: Object.fromEntries(Object.entries(initialized.values).filter(([key]) => key !== "core/decision-use")),
      }
      const updated = yield* readUpdate(yield* builtins.load(input(sessionID)), previous)
      expect(updated.changed).toBe(true)
      expect(updated.text).toBe(decisionUse)
      expect((yield* readUpdate(yield* builtins.load(input(sessionID)), updated)).changed).toBe(false)
    }),
  )

  it.effect("omits built-in blocks disabled by capabilities by stable name", () =>
    Effect.gen(function* () {
      const builtins = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(
        yield* builtins.load(
          input(sessionID, {
            capabilities: { builtin_instructions: { deny: ["environment", "date", "decision-use", "git-worktree"] } },
          }),
        ),
      )
      expect(Object.keys(initialized.values)).toEqual([
        "core/subagent-reuse",
        "core/shell-memory",
        "core/project-artifact-authoring",
        "core/git-attribution",
        "core/human-input",
        "core/task-completion",
      ])
      expect(initialized.text).not.toContain("<env>")
      expect(initialized.text).not.toContain("Today's date")
      expect(initialized.text).not.toContain(decisionUse)

      const only = yield* readInitial(
        yield* builtins.load(input(sessionID, { capabilities: { builtin_instructions: { allow: ["date"] } } })),
      )
      expect(Object.keys(only.values)).toEqual(["core/date"])
      const none = yield* readInitial(
        yield* builtins.load(input(sessionID, { capabilities: { builtin_instructions: { enabled: false } } })),
      )
      expect(none.values).toEqual({})
      expect(none.text).toBe("")
    }),
  )

  it.effect("omits blocks that describe tools the agent cannot call", () =>
    Effect.gen(function* () {
      const builtins = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* builtins.load(input(sessionID, { tools: new Set(["shell"]) })))
      expect(Object.keys(initialized.values)).toEqual([
        "core/environment",
        "core/date",
        "core/shell-memory",
        "core/git-worktree",
        "core/git-attribution",
      ])
      expect(initialized.text).not.toContain(humanInput)
      expect(initialized.text).not.toContain(decisionUse)
      expect(initialized.text).not.toContain(taskCompletion)
    }),
  )

  it.effect("removes a block from an existing Session when its capability is turned off", () =>
    Effect.gen(function* () {
      const builtins = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* builtins.load(input(sessionID)))
      const updated = yield* readUpdate(
        yield* builtins.load(input(sessionID, { capabilities: { builtin_instructions: { deny: ["decision-use"] } } })),
        initialized,
      )
      expect(updated.changed).toBe(true)
      expect(updated.values["core/decision-use"]).toBeUndefined()
      expect(updated.text).toBe("")
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load(input(sessionID)))

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect((yield* readUpdate(yield* context.load(input(sessionID)), initialized)).changed).toBe(false)
    }),
  )
})
