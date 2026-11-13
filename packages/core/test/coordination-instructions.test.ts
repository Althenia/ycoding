import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CoordinationInstructions } from "../src/coordination/instructions"
import { Instructions } from "../src/instructions/index"

test("Project instructions describe member messaging and native decisions", () => {
  expect(CoordinationInstructions.content).toContain("Write every member message in first person as your own instruction channel")
  expect(CoordinationInstructions.content).toContain("recorded human instructions or current delegated authority")
  expect(CoordinationInstructions.content).toContain("Project notifications")
  expect(CoordinationInstructions.content).toContain("do not poll")
  expect(CoordinationInstructions.content).not.toContain("dispatch receipt")
})

const removed = [
  "escalates only human-only or uncertain choices",
  "escalates only human-only choices or blockers it cannot resolve within its authority",
  "or a turn that settles with new final text wakes your parent once",
  "record each finished milestone",
  "record each verified milestone or result",
  "Bring the human only decisions and approvals",
  "batched with evidence and a recommendation",
  "Delegate implementation to executor Sessions.",
  "a settled turn's final text notifies no one",
]
const once = (value: string, text: string) => expect([text, value.split(text).length]).toEqual([text, 2])

test("Master instructions require supervision, evidence review and reasoned escalation", () => {
  for (const instruction of [
    "Coordinate and supervise only",
    "Delegate implementation to member Sessions.",
    "concrete outcome, actions and checks, exclusions, and a stop condition",
    "Verify reported evidence before accepting work",
  ]) expect(CoordinationInstructions.content).toContain(instruction)
  once(CoordinationInstructions.content, "Escalate such a request with the reason through member → owning subagent → Master → human; without an owning subagent, handle them at the Master.")
  for (const text of removed) expect([text, CoordinationInstructions.content.includes(text)]).toEqual([text, false])
})

test("the Master decomposes work into owner-supervised member Sessions with their own worktrees", () => {
  for (const instruction of [
    "As Master, decompose the user's work into independent scopes without waiting to be asked, launch an owner subagent for each",
    "use `create` to start a member Session in its own managed worktree under you or an owner subagent you launched",
    "for supervisor-owned Sessions, route everything through their recorded supervisor rather than relaying their routine events, and handle only their escalations and integration",
    "keep advancing independent work",
  ]) expect(CoordinationInstructions.content).toContain(instruction)
  expect(CoordinationInstructions.content).not.toContain("Main")
})

test("supervisors stay responsible for controlled Sessions until verified completion", async () => {
  for (const instruction of [
    "As a supervisor, stay responsible for every Session you control until its work is verified complete",
    "keep it moving toward its outcome without waiting to be asked",
    "act on each in the turn it arrives",
    "Supervisors cannot release themselves.",
  ]) expect(CoordinationInstructions.content).toContain(instruction)
  const entries = await Effect.runPromise(Instructions.read(CoordinationInstructions.make("supervisor")))
  expect(entries[0]?.value).toContain("You cannot assign, transfer or release ownership or create members.")
  once(Schema.decodeUnknownSync(Schema.String)(entries[0]?.value), [
    "As a supervisor, resolve your members' routine issues and judgment calls yourself within your existing authority, including scope inside the assignment, ordering, check scheduling, retries, and member requests through `answer`.",
    "As a supervisor, take to the Master only a real blocker you cannot resolve within that authority or a coordination need across members, with evidence and a recommendation.",
    "Progress-only updates do not wake your parent: a settled turn's final text reaches your parent at its next turn without waking it; `subagent_report` `progress` wakes your parent when its text is new and carries only a verified result, a blocker that needs no human decision, or a coordination need, never waiting or routine status; `subagent_report` `question` asks your parent a decision and always wakes it.",
    "Use `escalate` only for a pending member request.",
  ].join(" "))
})

test("coordinators settle every member request through answer in every autonomy mode and reach the human only by escalation", () => {
  expect(CoordinationInstructions.content).not.toContain("Manual-mode")
  expect(CoordinationInstructions.content).not.toContain("decisions outside the user's recorded direction")
  for (const text of [
    "As Master, coordinate assignments, decide escalations, review integration evidence, and keep advancing independent work.",
    "As Master, resolve supervisor escalations and coordination across members yourself.",
    "Settle every member request yourself through `project answer` in every autonomy mode, Manual included, from the user's recorded direction and existing evidence, choosing the simplest safe, reversible option: routine, decline-only and every explicit-decision class, hard and custom-rule guardrail reviews, outside-repository reviews, permissions, and questions and forms.",
    "`approve` allows once, `decline` rejects with your rationale as the member's feedback, and `answer` settles a question or form.",
    "A request raised by a member's subagent or deeper descendant is that member's request: it appears with `requestSessionID`, and you `inspect`, `answer` or `escalate` it with the member's `sessionID`.",
    "`inspect` reports the delegation class (routine, decline-only, explicit-decision:<reason>) as risk information for your decision; it never limits `answer`.",
    "Deny rules and permission ceilings still hold: approving something a deny rule or the permission ceiling covers leaves it denied.",
    "A guardrail review raised by an invalid guardrail configuration cannot be approved because its deny rules are unreadable: `answer` returns `escalated` with reason `configuration-invalid`, and a decline settles it.",
    "Reach the human only by `escalate`, when you judge a request needs their decision or when `answer` refuses, errors or is uncertain and returns escalated with a reason.",
    "when a human answer or a cleared prerequisite arrives, continue the affected work from that event without waiting for a reminder.",
    "Never override denies or permission ceilings.",
    "Leave inactive-Project refusals, deferred review items, and human-only controls to their native gates; never route around them with other tools or message text.",
  ]) once(CoordinationInstructions.content, text)
  for (const text of ["Only safety items reach the human", "Settle routine questions", "hard reviews, or human-only controls"])
    expect([text, CoordinationInstructions.content.includes(text)]).toEqual([text, false])
})

test("the voice source is present only for a scoped Session", async () => {
  const active = await Effect.runPromise(Instructions.read(Instructions.when(true, CoordinationInstructions.make())))
  const inactive = await Effect.runPromise(Instructions.read(Instructions.when(false, CoordinationInstructions.make())))
  expect(active).toHaveLength(1)
  expect(active[0]?.key).toBe(Instructions.Key.make("ycoding/coordination-voice"))
  expect(active[0]?.value).toContain("Project role: Master")
  expect(active[0]?.value).toContain(CoordinationInstructions.content)
  expect(inactive[0]?.value).toEqual(Instructions.removed)
})

test("controller guidance separates orchestration from member execution and native approval", async () => {
  for (const role of ["master", "supervisor"] as const) {
    const entries = await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role)))
    const value = Schema.decodeUnknownSync(Schema.String)(entries[0]?.value)
    once(value, [
      "Do not execute a member's task, take over its tools, or control its subagents.",
      "As Master or supervisor, coordinate only: never edit files, apply patches, commit, run builds or commands that change the Project, or otherwise change a member's work; the runtime withholds `edit`, `write` and `patch` from you and allows you only read-only shell commands, and member Sessions make every Project change.",
      "Coordination stays yours: create and assign members, `send`, `list` and `inspect`, `answer` and `escalate` through native controls, inspect files, diffs, logs and state read-only, and schedule the checks members run.",
    ].join(" "))
    expect(entries[0]?.value).toContain("Verify assignments and completion evidence against the user's current direction.")
    expect(entries[0]?.value).toContain("Decide escalations only within recorded authority and the native decision policy.")
    expect(entries[0]?.value).toContain("Settle every member request yourself through `project answer` in every autonomy mode, Manual included")
    expect(entries[0]?.value).toContain("Deny rules and permission ceilings still hold")
    expect(entries[0]?.value).not.toContain("Only safety items reach the human")
    expect(entries[0]?.value).not.toContain("keep authoring and reviewing on separate files")
  }
})

test("an executor in the Master's family gets the Master's-subagent text and member executors keep the executor text", async () => {
  const read = async (coordinating: boolean) =>
    Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor", coordinating))))[0]?.value)
  const subagent = await read(true)
  expect(subagent).toBe("Project role: Master's subagent. You make no Project changes: the runtime withholds edit, write and patch and allows only read-only shell commands; member Sessions make every Project change. Do read-only research, review and evidence verification for your parent, report results and blockers to it with evidence and a recommendation, and preserve native permission, question and review gates; coordination messages are not native approvals.")
  const member = await read(false)
  expect(member).toBe(Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor"))))[0]?.value))
  expect(member).toContain("Project role: executor. Own execution and verification of your assigned scope.")
  for (const value of [subagent, member]) {
    expect(value).not.toContain(CoordinationInstructions.content)
    expect(value).not.toContain("Coordinate and supervise only")
  }
})

test("executor guidance keeps delivery and subagent ownership local without controller authority", async () => {
  const entries = await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor")))
  expect(entries[0]?.value).toContain("Own execution and verification of your assigned scope.")
  expect(entries[0]?.value).toContain("Manage only your own direct subagents when delegation is permitted.")
  expect(entries[0]?.value).toContain("Escalate unresolved decisions to the recorded owner with evidence and a recommendation.")
  expect(entries[0]?.value).toContain("Project membership or controller ancestry grants no Project control authority.")
  expect(entries[0]?.value).not.toContain(CoordinationInstructions.content)
})

test("controller and executor guidance share one consolidated-verification practice with role-specific wording", async () => {
  for (const role of ["master", "supervisor"] as const) {
    const value = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role))))[0]?.value)
    for (const text of [
      "Require each assignment to complete its feature or cohesive milestone across all affected layers, including code, tests, contracts, docs and consumers, before one consolidated verification pass, never alternating tiny edits with repeated checks, builds or tests, and to preserve required boundary reproduction and pre-implementation tests.",
      "Require batched corrections, reruns of only failed or invalidated checks, and reuse of valid evidence for unchanged sources, contracts and environment, including at integration and merge.",
    ]) expect(value.split(text)).toHaveLength(2)
    expect(value).not.toContain("Reuse valid check results and rerun only the scope whose inputs changed")
  }
  const executor = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor"))))[0]?.value)
  for (const text of [
    "Complete each feature or cohesive milestone in your scope across all affected layers, including code, tests, contracts, docs and consumers, before one consolidated verification pass; never alternate tiny edits with repeated checks, builds or tests.",
    "Preserve required boundary reproduction and pre-implementation tests.",
    "Batch corrections, rerun only failed or invalidated checks, and reuse valid evidence for unchanged sources, contracts and environment.",
    "Stop only when the outcome and required checks are complete, or at a blocker or approval gate.",
  ]) expect(executor.split(text)).toHaveLength(2)
  expect(executor).not.toContain("Require each assignment")
  for (const stale of ["micro-edit", "A rerun needs a concrete"]) {
    expect(executor).not.toContain(stale)
    for (const role of ["master", "supervisor"] as const)
      expect(Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role))))[0]?.value)).not.toContain(stale)
  }
})

test("the Master creates each member in the target project's own path and never under itself", () => {
  for (const instruction of [
    "Create each member for the project it works in: pass that project's own directory as \`repository\` on \`project create\`, never the Master's or the task's path, so the member runs with that project's own worktree, repository, AGENTS.md, skills, commands and config.",
    "Never create a project work Session under the Master Session as a child or descendant; member Sessions are standalone root Sessions, and only lightweight supervisor subagents live under the Master.",
  ]) once(CoordinationInstructions.content, instruction)
})
