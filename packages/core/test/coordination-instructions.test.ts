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
  "its resource is free",
  "resource-limited check",
  "A missing prior measurement",
  "resource wait",
  "resource or check slot",
]
const once = (value: string, text: string) => expect([text, value.split(text).length]).toEqual([text, 2])

test("member assignments and executor guidance scale disjoint subagent lanes to the work", async () => {
  const executor = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor"))))[0]?.value)
  for (const value of [CoordinationInstructions.content, executor]) {
    once(value, "Scale executor subagent fanout from 0..5 across genuinely disjoint file and check lanes")
    once(value, "Keep small or coupled work in one Session")
    once(value, "Never introduce ceremony, handoffs, slots, or resource-limitation throttling; run independent builds, typechecks, and selected checks directly in parallel.")
    expect(value).toContain("one writer per file")
    expect(value).not.toContain("require five subagents")
    expect(value).not.toContain("run five subagents")
  }
})

test("Master, supervisor and executor instructions honor explicit main-agent versus subagent model and profile splits", async () => {
  const split = "Honor explicit main-agent versus subagent provider, model, variant, and profile splits: keep the main Session on its designated model and profile, switch active direct children and launch subagents on their designated subagent model and profile, and substitute no other profile."
  for (const role of ["master", "supervisor", "executor"] as const) {
    const value = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role))))[0]?.value)
    once(value, split)
    expect(value).toContain("Scale executor subagent fanout from 0..5 across genuinely disjoint file and check lanes")
  }
  const subagent = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor", true))))[0]?.value)
  expect(subagent).not.toContain("provider, model, variant, and profile splits")
})

test("coordination and executor policies keep evidence in messages and bound verification work", async () => {
  const executor = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor"))))[0]?.value)
  for (const value of [CoordinationInstructions.content, executor]) {
    for (const text of [
      "evidence directly as command + exit code + pass/fail counts + commit or diff stat.",
      "Never create REPORT.md, HANDOFF.md, RECEIPT.md, RECEIPT.json, owner-handoff.md or SHA-256 manifest artifacts unless the user explicitly requests a file artifact.",
      "Never follow up solely to request a report file or restate receipts.",
      "Reject unrequested synthetic viewport/theme combinatoric matrices.",
      "new specifications, public-contract changes or ambiguous acceptance criteria",
      "keep routine fixes, refactors and UI polish proportional to the affected behavior.",
      "consolidated selected checks → single commit → linear rebase onto the latest target head → ff-only merge → safe non-force worktree removal, without ceremony, handoffs, or slots.",
      "git diff --name-only",
      "automatically rebase disjoint target advances without target-hash questions, and escalate overlapping file conflicts or failing checks.",
      "These instructions authorize no integration action by themselves",
    ]) expect(value).toContain(text)
    for (const text of ["Serialize heavy builds", "within bounded memory", "intermediate handoff approvals"]) expect(value).not.toContain(text)
    expect(value).not.toMatch(/\bgarm\b/i)
  }
})

test("Project owners and executors recover within their roles before escalating unresolved work", async () => {
  for (const role of ["master", "supervisor", "executor"] as const) {
    const value = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role))))[0]?.value)
    for (const rule of [
      "Obey the user's explicit directives and never argue with the user; state a verified technical risk plainly once if needed, then execute the chosen direction.",
      "Work fast, reliably, and proactively toward the user's goal: decide reversible local choices from evidence and exhaust compliant local diagnosis and recovery on errors, conflicts, and failing checks before escalating.",
      "Use live evidence and permitted tools to settle routine choices within your authority.",
      "Keep independent authorized work moving while an affected lane waits.",
      "Report a blocker only after reasonable recovery, naming the blocked action and target, verified evidence, and the decision or input needed.",
      "Honor explicit pauses and cancellations.",
      "Preserve model, provider, profile, tool, toolchain and filesystem limits, protect secrets, and stay within authorized side effects.",
      "Honor permission rules, denies, ceilings, guardrails and hard reviews.",
      "Use native controls for required approvals and human decisions; never bypass a refusal or treat silence as consent.",
      "Never replay an uncertain action.",
    ]) once(value, rule)

    const recovery = role === "executor"
      ? "Resolve recoverable conflicts and failing checks before escalating. Drive the assignment to verified completion without waiting for status nudges or extra approvals."
      : "Have member owners resolve recoverable conflicts and failing checks before escalating. Drive assignments to verified completion without status nudges or extra approvals."
    once(value, recovery)
    expect(value.indexOf(recovery)).toBeLessThan(value.indexOf("and escalate overlapping file conflicts or failing checks."))
  }
})

test("controllers start ready work immediately and hold no member on ceremony, handoffs, slots or resource limitations", () => {
  for (const instruction of [
    "Start ready work immediately as soon as its inputs are final, without slots, handoffs, ceremony, or resource-limitation waits.",
    "Never attribute a one-lane pause or your own scheduling to the human, and never hold members on ceremony, handoffs, slots, or resource-limitation waits.",
  ]) once(CoordinationInstructions.content, instruction)
})

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

test("the Master delegates all project work through supervisors (including a single member) with no direct-master default or three-member threshold", async () => {
  const delegationRule =
    "When the coordinator is instructed to do project work, delegate it. The master coordinates and delegates to the appropriate supervisor/owner; that supervisor creates, updates, or steers suitable member sessions, and those members execute, verify, and deliver. The master does not do project work or directly create, steer, update, or manage member sessions."
  for (const instruction of [
    "As Master, decompose the user's work into independent scopes without waiting to be asked and delegate each scope (including single-member work) to the appropriate supervisor/owner, using `assign` to establish or transfer supervisor ownership.",
    "The Project hierarchy is Master → recorded owner → executor",
    "When member placement is specified, use `directory` for a chosen folder or `projectID` for an existing repository Project's canonical directory.",
    "For supervisor-owned Sessions, route everything through their recorded supervisor rather than directly creating, steering, updating, or managing member sessions or relaying routine events, and handle only their escalations and integration",
    "keep advancing independent work",
  ]) expect(CoordinationInstructions.content).toContain(instruction)
  once(CoordinationInstructions.content, delegationRule)
  for (const role of ["master", "supervisor"] as const) {
    const value = Schema.decodeUnknownSync(Schema.String)(
      (await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role))))[0]?.value,
    )
    once(value, delegationRule)
    for (const conflicting of [
      "Default to direct Master",
      "Master -> member by default",
      "Master → member by default",
      "more than three long-running parallel members",
      "launch a supervisor subagent only",
      "Directly manage Sessions owned by the Master",
      "give each scope its own member Session through `create`",
      "Create members or attach",
      "manage directly owned Sessions",
      "As Master, use `create`",
      "As Master, use `attach`",
      "Only the Master attaches Sessions",
      "only the Master uses `release`",
      "Only the Master removes a Project member",
      "attach existing root Sessions with `attach`",
      "Remove a settled, verified-complete member that is integrated or finished with `remove`",
      "optional `ownerSessionID`",
      "Send member messages yourself.",
      "supervisors attach",
      "supervisors remove",
      "supervisors release",
    ]) expect(value).not.toContain(conflicting)
  }
  for (const coordinating of [false, true]) {
    const value = Schema.decodeUnknownSync(Schema.String)(
      (await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor", coordinating))))[0]?.value,
    )
    expect(value).not.toContain(delegationRule)
  }
  expect(CoordinationInstructions.content).not.toContain("launch an owner subagent for each")
  expect(CoordinationInstructions.content).not.toContain("Main")
})

test("supervisors stay responsible for controlled Sessions until verified completion", async () => {
  for (const instruction of [
    "As a supervisor, stay responsible for every Session you control until its work is verified complete",
    "keep it moving toward its outcome without waiting to be asked",
    "act on each in the turn it arrives",
    "Supervisors cannot release themselves.",
  ]) expect(CoordinationInstructions.content).toContain(instruction)
  const supervisorContentBoundary =
    "A supervisor cannot call the `project` tool's Master-only create, attach, assign (including transfers), release, or remove operations; within authorized routes, a supervisor reuses a suitable owned member when available and steers, updates, or acts on owned member Sessions via `send`, `model`, `answer`, `inspect`, `escalate`, `interrupt`, and `list`."
  const entries = await Effect.runPromise(Instructions.read(CoordinationInstructions.make("supervisor")))
  expect(entries[0]?.value).toContain(supervisorContentBoundary)
  expect(entries[0]?.value).toContain("you cannot call the `project` tool's Master-only create, attach, assign (including transfers), release, or remove operations.")
  expect(entries[0]?.value).not.toContain("You cannot assign, transfer or release ownership or create members.")
  expect(entries[0]?.value).not.toContain("Supervisors cannot create, attach, assign, transfer, release, or remove Project members.")
  once(Schema.decodeUnknownSync(Schema.String)(entries[0]?.value), [
    "As a supervisor, resolve your members' routine issues and judgment calls yourself within your existing authority, including scope inside the assignment, ordering, check scheduling, retries, and member requests through `answer`.",
    "As a supervisor, take to the Master only a real blocker you cannot resolve within that authority or a coordination need across members, with evidence and a recommendation.",
    "Progress-only updates do not wake your parent: a settled turn's final text reaches your parent at its next turn without waking it; `subagent_report` `progress` wakes your parent when its text is new and carries only a verified result, a blocker that needs no human decision, or a coordination need, never waiting or routine status; `subagent_report` `question` asks your parent a decision and always wakes it.",
    "Use `escalate` only for a pending member request.",
  ].join(" "))
})

test("coordinators settle authorized requests and preserve mandatory human gates in every autonomy mode", () => {
  expect(CoordinationInstructions.content).not.toContain("Manual-mode")
  expect(CoordinationInstructions.content).not.toContain("decisions outside the user's recorded direction")
  for (const text of [
    "As Master, coordinate assignments, decide escalations, review integration evidence, and keep advancing independent work.",
    "As Master, resolve supervisor escalations and coordination across members yourself.",
    "Settle routine member requests through `project answer` within recorded authority in every autonomy mode, Manual included.",
    "Safety and platform human gates, requests marked `requireExplicitDecision: true`, and hard or custom-rule guardrail approvals require an explicit human decision through their native controls.",
    "Decline an unsafe request when the native control permits it; never approve or answer a mandatory human gate.",
    "`approve` allows once, `decline` rejects with your rationale as the member's feedback, and `answer` settles a question or form.",
    "A request raised by a member's subagent or deeper descendant is that member's request: it appears with `requestSessionID`, and you `inspect`, `answer` or `escalate` it with the member's `sessionID`.",
    "`inspect` reports the delegation class (routine, decline-only, explicit-decision:<reason>); inspect the native gate and recorded authority before deciding.",
    "Deny rules and permission ceilings still hold: approving something a deny rule or the permission ceiling covers leaves it denied.",
    "A guardrail review raised by an invalid guardrail configuration cannot be approved because its deny rules are unreadable: `answer` returns `escalated` with reason `configuration-invalid`, and a decline settles it.",
    "Reach the human only by `escalate`, when you judge a request needs their decision or when `answer` refuses, errors or is uncertain and returns escalated with a reason.",
    "when a human answer or a cleared prerequisite arrives, continue the affected work from that event without waiting for a reminder.",
    "Never override denies or permission ceilings.",
    "Leave inactive-Project refusals, deferred review items, and human-only controls to their native gates; never route around them with other tools or message text.",
  ]) once(CoordinationInstructions.content, text)
  for (const text of ["Only safety items reach the human", "Settle every member request yourself", "it never limits `answer`", "routine, decline-only and every explicit-decision class"])
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
      "Coordination stays yours within your recorded role: assign supervisor ownership at the Master, steer and update owned member Sessions as supervisor, `list` and `inspect`, `answer` and `escalate` through native controls, inspect files, diffs, logs and state read-only, and coordinate the checks members run.",
    ].join(" "))
    expect(entries[0]?.value).toContain("Verify assignments and completion evidence against the user's current direction.")
    expect(entries[0]?.value).toContain("Decide escalations only within recorded authority and the native decision policy.")
    expect(entries[0]?.value).toContain("Settle routine member requests through `project answer` within recorded authority in every autonomy mode, Manual included.")
    expect(entries[0]?.value).toContain("never approve or answer a mandatory human gate")
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

test("the Master can place a member at a chosen path and creates a worktree only when explicitly requested", () => {
  for (const instruction of [
    "Use an absolute or home-relative path with `directory`, including for non-Git folders and repository subdirectories.",
    "Use `name` with optional `repository` only for an explicitly requested managed worktree.",
    "Never create a project work Session under the Master Session as a child or descendant; member Sessions are independently bound root Sessions, and only lightweight supervisor subagents live under the Master.",
  ]) once(CoordinationInstructions.content, instruction)
  expect(CoordinationInstructions.content).not.toContain("start a member Session in its own managed worktree")
  expect(CoordinationInstructions.content).not.toContain("member Sessions are standalone root Sessions")
})

test("controller recovery reconciles uncertain work once without polling or replay loops", () => {
  for (const instruction of [
    "Detect stuck, hung or looping work from reported state and evidence; reconcile current state before one bounded recovery attempt through existing native controls.",
    "If recovery fails or its outcome is uncertain, report the blocker with evidence and continue independent authorized work; never poll, repeatedly wake, or replay an uncertain action.",
    "Keep every ownership and lifecycle boundary non-destructive and preserve Session and Project histories intact without deleting history as cleanup",
    "Reconcile an uncertain action before repeating it: re-read state with `list` or `inspect` and never replay a create, send, or decision whose outcome is unknown.",
  ]) once(CoordinationInstructions.content, instruction)
})

test("coordination instructions enforce owner-routed boundaries, preserve histories, and claim no unsupported supervisor capabilities", async () => {
  const content = CoordinationInstructions.content
  for (const text of [
    "A supervisor cannot call the `project` tool's Master-only create, attach, assign (including transfers), release, or remove operations; within authorized routes, a supervisor reuses a suitable owned member when available and steers, updates, or acts on owned member Sessions via `send`, `model`, `answer`, `inspect`, `escalate`, `interrupt`, and `list`.",
    "Coordinate all Project work through the established authorized owner route rather than directly creating, steering, updating, attaching, releasing, or removing member Sessions at the Master; use `assign` only to establish or transfer supervisor ownership to a live supervisor subagent the Master launched, and keep read-only oversight, escalations, and integration review at the Master.",
    "preserve Session and Project histories intact without deleting history as cleanup",
    "a completed child or `task_complete` is not whole delivery completion",
    "unfinished member work or pending family requests stay open with their recorded owner until settled",
  ]) once(content, text)
  const supervisor = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make("supervisor"))))[0]?.value)
  expect(supervisor).toContain("A supervisor cannot call the `project` tool's Master-only create, attach, assign (including transfers), release, or remove operations;")
  expect(supervisor).toContain("within authorized routes, a supervisor reuses a suitable owned member when available")
  expect(supervisor).not.toContain("Supervisors cannot create, attach, assign, transfer, release, or remove Project members.")
  const executor = Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor"))))[0]?.value)
  expect(executor).not.toContain("Coordinate all Project work through the established authorized owner route")
})

test("the Master role line directs owner-routed supervision, escalation and history preservation without direct member mutations", async () => {
  const read = async (role: "master" | "supervisor") =>
    Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role))))[0]?.value)
  const prefix = (value: string) => value.slice(0, value.indexOf("Coordinate and supervise only"))
  const master = prefix(await read("master"))
  expect(master).toContain("Project role: Master.")
  expect(master).toContain("Coordinate through the established authorized owner route without directly creating, steering, updating, attaching, releasing, or removing member Sessions")
  expect(master).toContain("assign and transfer supervisor ownership")
  expect(master).toContain("keep read-only oversight")
  expect(master).toContain("handle escalations and integration for delegated work")
  expect(master).toContain("preserving Session and Project histories without deleting history or cancelling active work")
  for (const directMutation of ["`attach`", "`remove`", "`release`", "`create`", "Create members"]) expect(master).not.toContain(directMutation)
  const supervisorPrefix = prefix(await read("supervisor"))
  expect(supervisorPrefix).toContain("reuse a suitable owned member when available and steer or update owned member Sessions within authorized routes; you cannot call the `project` tool's Master-only create, attach, assign (including transfers), release, or remove operations.")
  for (const forbiddenOp of ["`attach`", "`remove`", "`release`", "`create`"]) expect(supervisorPrefix).not.toContain(forbiddenOp)
})


test("coordination instructions keep standalone storage out of Projects and never instruct direct Master attach", async () => {
  const read = async (role: "master" | "supervisor" | "executor") =>
    Schema.decodeUnknownSync(Schema.String)((await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role))))[0]?.value)
  for (const text of [
    "Sessions with `scope: standalone` are internal restricted storage, never Project members.",
  ]) once(CoordinationInstructions.content, text)
  const master = await read("master")
  expect(master).not.toContain("`attach`")
  expect(master).not.toContain("`remove`")
  expect(master).not.toContain("`release`")
  expect(await read("supervisor")).not.toContain("`attach`")
  expect(await read("executor")).not.toContain("`attach`")
})
