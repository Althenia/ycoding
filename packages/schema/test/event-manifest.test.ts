import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import {
  AbsolutePath,
  Agent,
  Config,
  FileSystem,
  Form,
  Integration,
  Location,
  Permission,
  Project,
  Reference,
  Session,
  SessionCompaction,
  Workspace,
} from "../src/index.js"
import { EventManifest } from "../src/event-manifest.js"
import { IdeEvent } from "../src/ide-event.js"
import { McpEvent } from "../src/mcp-event.js"
import { Plugin } from "../src/plugin.js"
import { SessionEvent } from "../src/session-event.js"
import { SessionID } from "../src/session-id.js"
import { SessionMessage } from "../src/session-message.js"
import { WorkspaceEvent } from "../src/workspace-event.js"

describe("public event manifest", () => {
  test("owns the complete current public event surface", () => {
    expect(EventManifest.ServerDefinitions).toContain(Agent.Event.Updated)
    expect(EventManifest.Definitions).toContain(Agent.Event.Updated)
    expect(EventManifest.Definitions.filter((definition) => definition.type === "agent.updated")).toEqual([
      Agent.Event.Updated,
    ])
    expect(Array.from(EventManifest.Latest.keys())).toEqual(
      Array.from(new Set(EventManifest.Definitions.map((definition) => definition.type))),
    )
    expect(EventManifest.Latest.get("agent.updated")).toBe(Agent.Event.Updated)
    expect(EventManifest.Latest.get("plugin.updated")).toBe(Plugin.Event.Updated)
    expect(EventManifest.Server.get("mcp.status.changed")).toBe(McpEvent.StatusChanged)
    expect(EventManifest.Server.get("mcp.resources.changed")).toBe(McpEvent.ResourcesChanged)
    expect(EventManifest.Server.get("session.deleted")).toBe(SessionEvent.Deleted)
    expect(EventManifest.Server.has("todo.updated")).toBe(true)
    expect(EventManifest.Server.has("mcp.tools.changed")).toBe(false)
    expect(Agent.Event.Updated.durable).toBeUndefined()
    expect(EventManifest.Durable.has("agent.updated")).toBe(false)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.created")).toBe(SessionEvent.Created)
    expect(EventManifest.Latest.get("session.input.consumed")).toBe(SessionEvent.InputConsumed)
    expect(EventManifest.Latest.get("session.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("agent.updated")).toBe(Agent.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Agent.Event.Definitions).toEqual([Agent.Event.Updated])
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(Config.Event.Definitions).toEqual([Config.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Changed])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Form.Event.Definitions).toEqual([Form.Event.Created, Form.Event.Replied, Form.Event.Cancelled])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(Plugin.Event.Definitions).toEqual([Plugin.Event.Added, Plugin.Event.Updated])
    expect(McpEvent.Definitions).toEqual([McpEvent.ToolsChanged, McpEvent.ResourcesChanged, McpEvent.StatusChanged])
    expect(EventManifest.Latest.has("mcp.browser.open.failed")).toBe(false)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Durable.get("session.step.ended.1")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Durable.has("session.step.ended.2")).toBe(false)
  })

  test("defines public compaction jobs without provider-private state", () => {
    const admission = Schema.decodeUnknownSync(SessionCompaction.Admission)({
      id: "cmp_01",
      sessionID: "ses_01",
      trigger: "manual",
      admissionMode: "background",
      status: "pending",
      requestedThrough: { messageID: "msg_01", seq: 7 },
      timeCreated: 1,
    })

    expect(String(admission.id)).toBe("cmp_01")
    expect(admission).not.toHaveProperty("admissionMode")
    const historicalMessage = Schema.decodeUnknownSync(SessionMessage.CompactionPending)({
      id: "msg_compaction_historical",
      type: "compaction",
      jobID: "cmp_01",
      trigger: "manual",
      admissionMode: "background",
      status: "pending",
      time: { created: 1 },
    })
    expect(historicalMessage).not.toHaveProperty("admissionMode")
    expect(() => Schema.decodeUnknownSync(SessionCompaction.ID)("compaction_01")).toThrow()
    expect(SessionEvent.Compaction.Started.durable?.version).toBe(2)
    expect(EventManifest.Latest.get("session.compaction.started")).toBe(SessionEvent.Compaction.Started)
    expect(EventManifest.Durable.has("session.compaction.started.1")).toBeTrue()
    expect(EventManifest.Durable.has("session.compaction.started.2")).toBeTrue()
    expect(
      Schema.decodeUnknownSync(SessionEvent.Compaction.StartedV1.data)({
        sessionID: "ses_01",
        reason: "manual",
        recent: "legacy context",
      }),
    ).toMatchObject({ reason: "manual", recent: "legacy context" })
    expect(
      Schema.decodeUnknownSync(SessionEvent.Compaction.Ended.data)({
        sessionID: "ses_01",
        jobID: "cmp_01",
        revision: 2,
        boundary: { messageID: "msg_01", seq: 7 },
        metrics: { excludedMessages: 1, excludedParts: 2, inputTokens: 3, retainedTokens: 4 },
        providerState: { secret: "must-not-be-public" },
      }),
    ).not.toHaveProperty("providerState")
  })

  test("excludes removed v1 event types", () => {
    for (const type of [
      "session.updated",
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.removed",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "session.error",
      "file.edited",
    ]) {
      expect(EventManifest.Latest.has(type)).toBe(false)
      expect(EventManifest.Server.has(type)).toBe(false)
    }
  })

  test("derives durable definitions from current explicit durability", () => {
    expect(Array.from(EventManifest.Durable.keys()).toSorted()).toEqual(
      [
        "session.created.2",
        "session.deleted.2",
        "session.archived.2",
        "session.unarchived.2",
        "session.agent.selected.1",
        "session.model.selected.1",
        "session.project-artifacts-ended.1",
        "session.moved.1",
        "session.renamed.1",
        "session.usage.recorded.1",
        "session.provider.request.recorded.1",
        "session.forked.2",
        "session.input.promoted.1",
        "session.input.admitted.1",
        "session.input.consumed.1",
        "session.execution.started.1",
        "session.execution.succeeded.1",
        "session.execution.failed.1",
        "session.execution.interrupted.1",
        "session.file-change.recorded.1",
        "session.instructions.updated.2",
        "session.context.observed.1",
        "session.synthetic.1",
        "session.task.updated.1",
        "session.skill.activated.1",
        "session.skill.deactivated.1",
        "session.shell.started.1",
        "session.shell.ended.1",
        "session.step.started.1",
        "session.step.ended.1",
        "session.step.failed.1",
        "session.text.started.1",
        "session.text.ended.1",
        "session.tool.input.started.1",
        "session.tool.input.ended.1",
        "session.tool.called.1",
        "session.tool.progress.1",
        "session.tool.success.1",
        "session.tool.failed.1",
        "session.reasoning.started.1",
        "session.reasoning.ended.1",
        "session.retry.scheduled.1",
        "session.compaction.admitted.1",
        "session.compaction.admitted.2",
        "session.compaction.started.1",
        "session.compaction.started.2",
        "session.compaction.ended.1",
        "session.compaction.ended.2",
        "session.compaction.replaced.1",
        "session.compaction.failed.1",
        "session.compaction.failed.2",
        "session.revert.staged.1",
        "session.revert.cleared.1",
        "session.revert.committed.1",
      ].toSorted(),
    )
    expect(SessionEvent.PublicDurableDefinitions).toEqual(
      SessionEvent.Definitions.filter((definition) => definition.durability === "durable"),
    )
    expect(SessionEvent.PublicDurableDefinitions).not.toContain(SessionEvent.UsageRecorded)
    expect(SessionEvent.PublicDurableDefinitions).not.toContain(SessionEvent.ProviderRequestRecorded)
    expect(SessionEvent.DurableDefinitions).toEqual([
      ...SessionEvent.PublicDurableDefinitions,
      ...SessionEvent.Compaction.LegacyDurableDefinitions,
      SessionEvent.UsageRecorded,
      SessionEvent.ProviderRequestRecorded,
    ])
    expect(SessionEvent.UsageRecorded.durability).toBe("durable")
    expect(SessionEvent.ProviderRequestRecorded.durability).toBe("durable")
    expect(EventManifest.Durable.get("session.usage.recorded.1")).toBe(SessionEvent.UsageRecorded)
    expect(EventManifest.Durable.get("session.provider.request.recorded.1")).toBe(SessionEvent.ProviderRequestRecorded)
    expect(EventManifest.Durable.get("session.task.updated.1")).toBe(SessionEvent.Task.Updated)
    expect(SessionEvent.Definitions).not.toContain(SessionEvent.UsageRecorded)
    expect(SessionEvent.Definitions).not.toContain(SessionEvent.ProviderRequestRecorded)
    expect(EventManifest.Definitions).not.toContain(SessionEvent.UsageRecorded)
    expect(EventManifest.Definitions).not.toContain(SessionEvent.ProviderRequestRecorded)
    expect(EventManifest.ServerDefinitions).not.toContain(SessionEvent.UsageRecorded)
    expect(EventManifest.ServerDefinitions).not.toContain(SessionEvent.ProviderRequestRecorded)
    expect(EventManifest.Latest.has("session.usage.recorded")).toBe(false)
    expect(EventManifest.Latest.has("session.provider.request.recorded")).toBe(false)
    expect(SessionEvent.UsageUpdated.durability).toBe("ephemeral")
    expect(SessionEvent.DiagnosticsUpdated.durability).toBe("ephemeral")
    expect(SessionEvent.Compaction.Delta.durability).toBe("ephemeral")
    expect(EventManifest.Durable.has("session.compaction.delta.1")).toBe(false)
    expect(EventManifest.ServerDefinitions).toContain(SessionEvent.UsageUpdated)
    expect(EventManifest.ServerDefinitions).toContain(SessionEvent.DiagnosticsUpdated)
    expect(EventManifest.Definitions.every((definition) => definition.durability !== undefined)).toBe(true)
  })

  test("uses the current Session creation event as durable version 2", () => {
    const data = SessionEvent.Created.data.make({
      sessionID: Session.ID.make("ses_current"),
      projectID: Project.ID.make("project"),
      location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
      title: "Current session",
      created: 1,
    })

    expect(SessionEvent.Created.durable?.version).toBe(2)
    expect(EventManifest.Durable.get("session.created.2")).toBe(SessionEvent.Created)
    expect(data).not.toHaveProperty("slug")
    expect(data).not.toHaveProperty("version")
    expect(data).not.toHaveProperty("metadata")
  })

  test("keeps the current Session skill event as durable version 1", () => {
    expect(EventManifest.Durable.get("session.skill.activated.1")).toBe(SessionEvent.Skill.Activated)
    expect(EventManifest.Latest.get("session.skill.activated")).toBe(SessionEvent.Skill.Activated)
  })

  test("keeps simplified session fragment and tool payloads on durable version 1", () => {
    const sessionID = SessionID.make("ses_test")
    const assistantMessageID = SessionMessage.ID.make("msg_test")
    const text = SessionEvent.Text.Started.data.make({ sessionID, assistantMessageID, ordinal: 0 })
    const reasoning = SessionEvent.Reasoning.Ended.data.make({
      sessionID,
      assistantMessageID,
      ordinal: 0,
      text: "thought",
      state: { signature: "sig" },
    })
    const tool = SessionEvent.Tool.Called.data.make({
      sessionID,
      assistantMessageID,
      callID: "call_test",
      input: {},
      executed: true,
      state: { itemId: "item_test" },
    })

    expect(text).not.toHaveProperty("textID")
    expect(reasoning).not.toHaveProperty("reasoningID")
    expect(reasoning).not.toHaveProperty("providerMetadata")
    expect(tool).not.toHaveProperty("tool")
    expect(tool).not.toHaveProperty("provider")
    expect(SessionEvent.Text.Started.durable?.version).toBe(1)
    expect(SessionEvent.Tool.Called.durable?.version).toBe(1)
  })

  test("keeps current session deletion minimal", () => {
    const sessionID = SessionID.make("ses_test")

    expect(SessionEvent.Deleted.data.make({ sessionID })).toEqual({ sessionID })
    expect(SessionEvent.Deleted.durable?.version).toBe(2)
  })

  test("decodes exact consumed input IDs and keeps historical user messages compatible", () => {
    const sessionID = SessionID.make("ses_receipt")
    const inputIDs = [SessionMessage.ID.make("msg_first"), SessionMessage.ID.make("msg_second")] as const

    expect(
      Schema.decodeUnknownSync(SessionEvent.InputConsumed.data)({
        sessionID,
        inputIDs,
      }),
    ).toEqual({ sessionID, inputIDs })

    const historical = Schema.decodeUnknownSync(SessionMessage.User)({
      id: "msg_historical",
      type: "user",
      text: "Historical prompt",
      time: { created: 1 },
    })
    const consumed = Schema.decodeUnknownSync(SessionMessage.User)({
      id: "msg_consumed",
      type: "user",
      text: "Consumed prompt",
      time: { created: 1, consumed: 2 },
    })

    expect(historical.time.consumed).toBeUndefined()
    expect(DateTime.toEpochMillis(consumed.time.consumed!)).toBe(2)
  })
})
