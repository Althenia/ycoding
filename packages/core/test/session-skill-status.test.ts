import { describe, expect, test } from "bun:test"
import { DateTime, Option, Schema } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { SessionSkillStatus } from "@ycoding-ai/core/session/skill-status"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { Instructions } from "@ycoding-ai/core/instructions"

const created = DateTime.makeUnsafe(0)
const model = ModelV2.Ref.make({ id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") })
const messageID = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const skillID = (value: string) => SkillV2.ID.make(value)

const reference = (
  id: string,
  skill: string,
  name: string,
  content: string,
  conflicts: SkillV2.Conflicts = { skills: [], instructions: [] },
) =>
  SessionMessage.Skill.make({
    id: messageID(id),
    type: "skill",
    skill: skillID(skill),
    name: SkillV2.Name.make(name),
    text: content,
    conflicts,
    time: { created },
  })

const assistant = (id: string, state: SessionMessage.ToolState) =>
  SessionMessage.Assistant.make({
    id: messageID(id),
    type: "assistant",
    agent: AgentV2.defaultID,
    model,
    content: [
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: `call_${id}`,
        name: "skill",
        state,
        time: { created, completed: created },
      }),
    ],
    time: { created, completed: created },
  })

const toolCompleted = (
  id: string,
  skill: string,
  name: string,
  content: string,
  conflicts: SkillV2.Conflicts = { skills: [], instructions: [] },
) =>
  assistant(
    id,
    SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: { id: skill },
      content: [],
      structured: { name, directory: "/skills", output: content, conflicts },
    }),
  )

describe("SessionSkillStatus.list", () => {
  test("records reference and completed tool activations from their snapshots", () => {
    expect(
      SessionSkillStatus.list(
        [
          reference("reference", "review", "Review", "reference content"),
          toolCompleted("tool", "effect", "Effect", "tool content"),
        ],
        [],
      ),
    ).toEqual([
      expect.objectContaining({
        id: skillID("review"),
        name: SkillV2.Name.make("Review"),
        state: "active",
        activatedBy: "reference",
        activationMessageID: messageID("reference"),
        content: "reference content",
        declarations: { skills: [], instructions: [] },
      }),
      expect.objectContaining({
        id: skillID("effect"),
        name: SkillV2.Name.make("Effect"),
        state: "active",
        activatedBy: "tool",
        activationMessageID: messageID("tool"),
        content: "tool content",
        declarations: { skills: [], instructions: [] },
      }),
    ])
  })

  test("excludes prose and incomplete or failed tool calls and compactions", () => {
    const incomplete = assistant(
      "running",
      SessionMessage.ToolStateRunning.make({ status: "running", input: { id: "running" }, content: [], structured: {} }),
    )
    const failed = assistant(
      "failed",
      SessionMessage.ToolStateError.make({
        status: "error",
        input: { id: "failed" },
        content: [],
        structured: {},
        error: { type: "unknown", message: "Denied" },
      }),
    )
    const streaming = assistant(
      "streaming",
      SessionMessage.ToolStateStreaming.make({ status: "streaming", input: '{"id":"streaming"}' }),
    )

    expect(
      SessionSkillStatus.list(
        [
          SessionMessage.User.make({ id: messageID("prose"), type: "user", text: "use $skill review", files: [], agents: [], time: { created } }),
          incomplete,
          failed,
          streaming,
          SessionMessage.CompactionRunning.make({
            id: messageID("compacting"),
            type: "compaction",
            status: "running",
            reason: "auto",
            summary: "",
            recent: "",
            time: { created },
          }),
          SessionMessage.CompactionFailed.make({
            id: messageID("failed-compaction"),
            type: "compaction",
            status: "failed",
            reason: "auto",
            error: { type: "unknown", message: "Failed" },
            time: { created },
          }),
        ],
        [],
      ),
    ).toEqual([])
  })

  test("uses the latest boundary and latest reload for each skill", () => {
    expect(
      SessionSkillStatus.list(
        [
          reference("first", "review", "Review", "first"),
          SessionMessage.CompactionCompleted.make({
            id: messageID("compacted"),
            type: "compaction",
            status: "completed",
            reason: "auto",
            summary: "",
            recent: "",
            time: { created },
          }),
          reference("reloaded", "review", "Review updated", "second"),
          SessionMessage.AgentSelected.make({
            id: messageID("switched"),
            type: "agent-switched",
            agent: AgentV2.defaultID,
            time: { created },
          }),
        ],
        [],
      ),
    ).toEqual([
      expect.objectContaining({
        id: skillID("review"),
        name: SkillV2.Name.make("Review updated"),
        content: "second",
        state: "inactive",
        inactiveReason: "agent_switched",
      }),
    ])
  })

  test("retains the original activation after a completed duplicate tool call", () => {
    const activation = reference("reference", "effect", "Effect", "original content")
    const duplicate = assistant(
      "duplicate",
      SessionMessage.ToolStateCompleted.make({
        status: "completed",
        input: { id: "effect" },
        content: [],
        structured: {
          name: "Effect",
          directory: "",
          output: "Skill Effect is already active for this session.",
          alreadyActive: true,
        },
      }),
    )

    expect(SessionSkillStatus.list([activation, duplicate], [])).toEqual([
      expect.objectContaining({
        id: skillID("effect"),
        activatedBy: "reference",
        activationMessageID: messageID("reference"),
        content: "original content",
      }),
    ])
  })

  test("uses the most recent consecutive boundary as the inactive reason", () => {
    const activation = reference("activation", "review", "Review", "content")
    const compaction = SessionMessage.CompactionCompleted.make({
      id: messageID("compacted"),
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "",
      recent: "",
      time: { created },
    })
    const switched = SessionMessage.AgentSelected.make({
      id: messageID("switched"),
      type: "agent-switched",
      agent: AgentV2.defaultID,
      time: { created },
    })

    expect(SessionSkillStatus.list([activation, compaction, switched], [])).toEqual([
      expect.objectContaining({ state: "inactive", inactiveReason: "agent_switched" }),
    ])
    expect(SessionSkillStatus.list([activation, switched, compaction], [])).toEqual([
      expect.objectContaining({ state: "inactive", inactiveReason: "compacted" }),
    ])
  })

  test("decodes persisted boundaries for both original inactive reasons", () => {
    const decode = Schema.decodeUnknownSync(SessionMessage.Info)
    const activation = Schema.encodeSync(SessionMessage.Info)(reference("activation", "review", "Review", "content"))
    const switched = Schema.encodeSync(SessionMessage.Info)(
      SessionMessage.AgentSelected.make({
        id: messageID("switched"),
        type: "agent-switched",
        agent: AgentV2.defaultID,
        time: { created },
      }),
    )
    const compacted = Schema.encodeSync(SessionMessage.Info)(
      SessionMessage.CompactionCompleted.make({
        id: messageID("compacted"),
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "",
        recent: "",
        time: { created },
      }),
    )

    expect(SessionSkillStatus.list([decode(activation), decode(switched)], [])).toEqual([
      expect.objectContaining({ state: "inactive", inactiveReason: "agent_switched" }),
    ])
    expect(SessionSkillStatus.list([decode(activation), decode(compacted)], [])).toEqual([
      expect.objectContaining({ state: "inactive", inactiveReason: "compacted" }),
    ])
  })

  test("rejects invalid state and inactive-reason combinations", () => {
    const base = {
      id: skillID("review"),
      name: SkillV2.Name.make("Review"),
      activatedBy: "reference",
      activationMessageID: messageID("activation"),
      content: "content",
      conflicts: [],
      declarations: { skills: [], instructions: [] },
    }

    expect(Option.isNone(Schema.decodeUnknownOption(SessionSkillStatus.Info)({ ...base, state: "active", inactiveReason: "compacted" }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(SessionSkillStatus.Info)({ ...base, state: "inactive" }))).toBe(true)
  })

  test("resolves symmetric active skill conflicts and active instruction conflicts", () => {
    expect(
      SessionSkillStatus.list(
        [
          reference("review", "review", "Review", "review", {
            skills: [skillID("effect")],
            instructions: [Instructions.Key.make("core/instructions")],
          }),
          reference("effect", "effect", "Effect", "effect"),
        ],
        [Instructions.Key.make("core/instructions")],
      ),
    ).toEqual([
      expect.objectContaining({
        id: skillID("review"),
        conflicts: [
          { type: "skill", id: skillID("effect"), name: SkillV2.Name.make("Effect") },
          { type: "instruction", id: Instructions.Key.make("core/instructions"), name: "core/instructions" },
        ],
      }),
      expect.objectContaining({
        id: skillID("effect"),
        conflicts: [{ type: "skill", id: skillID("review"), name: SkillV2.Name.make("Review") }],
      }),
    ])
  })

  test("retains missing declarations without reporting inactive or missing targets as conflicts", () => {
    expect(
      SessionSkillStatus.list(
        [
          reference("active", "active", "Active", "active", {
            skills: [skillID("missing"), skillID("inactive")],
            instructions: [Instructions.Key.make("missing/instruction")],
          }),
          reference("inactive", "inactive", "Inactive", "inactive"),
          SessionMessage.CompactionCompleted.make({
            id: messageID("boundary"),
            type: "compaction",
            status: "completed",
            reason: "auto",
            summary: "",
            recent: "",
            time: { created },
          }),
          reference("active-reloaded", "active", "Active", "active", {
            skills: [skillID("missing"), skillID("inactive")],
            instructions: [Instructions.Key.make("missing/instruction")],
          }),
        ],
        [],
      ),
    ).toEqual([
      expect.objectContaining({
        id: skillID("active"),
        state: "active",
        conflicts: [],
        declarations: {
          skills: [skillID("missing"), skillID("inactive")],
          instructions: [Instructions.Key.make("missing/instruction")],
        },
      }),
      expect.objectContaining({ id: skillID("inactive"), state: "inactive", conflicts: [] }),
    ])
  })
})
