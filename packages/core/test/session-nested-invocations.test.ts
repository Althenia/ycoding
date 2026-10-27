import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { LLMEvent } from "@ycoding-ai/ai"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Image } from "@ycoding-ai/core/image"
import { Location } from "@ycoding-ai/core/location"
import { LocationMutation } from "@ycoding-ai/core/location-mutation"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Permission } from "@ycoding-ai/core/permission"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { ProjectArtifactSource } from "@ycoding-ai/core/project-artifact/source"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionCapturedChanges } from "@ycoding-ai/core/session/captured-changes"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionHistoryPruning } from "@ycoding-ai/core/session/history-pruning"
import { createLLMEventPublisher } from "@ycoding-ai/core/session/runner/publish-llm-event"
import { SessionFileChangeTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Skill } from "@ycoding-ai/core/skill"
import { ReadToolFileSystem } from "@ycoding-ai/core/tool/read-filesystem"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { SkillTool } from "@ycoding-ai/core/tool/skill"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin } from "./lib/tool"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node])),
)
const sessionID = Session.ID.make("ses_nested_durable")
const model = { id: CatalogModel.ID.make("fixture"), providerID: Provider.ID.make("fixture") }
const skillPlugin = makeLocationNode({
  name: "test/nested-skill-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [
    ToolRegistry.toolsNode,
    Config.node,
    FSUtil.node,
    Skill.node,
    MCP.node,
    Permission.node,
    PluginRuntime.node,
    ProjectArtifactSource.node,
    LocationMutation.node,
    ReadToolFileSystem.node,
  ],
})

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Nested durable facts" })
    .run()
})

it.effect("a real nested skill load permits the next resource read before execute settles", () =>
  Effect.gen(function* () {
    yield* seed
    const store = yield* SessionStore.Service
    const events = yield* EventRuntime.Service
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "SKILL.md"), "# Fixture"))
    yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "reference.md"), "resource available"))
    const info: Skill.Info = {
      id: Skill.ID.make("fixture"),
      name: Skill.Name.make("Fixture"),
      description: "Fixture",
      content: "# Fixture",
      location: AbsolutePath.make(path.join(tmp.path, "SKILL.md")),
    }
    const publisher = createLLMEventPublisher(events, {
      sessionID,
      agent: Agent.defaultID,
      model,
      providerMetadataKey: "fixture",
    })
    yield* publisher.publish(LLMEvent.toolInputStart({ id: "outer", name: "execute" }))
    yield* publisher.publish(LLMEvent.toolCall({ id: "outer", name: "execute", input: {} }))
    const assistantMessageID = yield* publisher.assistantMessageID("outer")
    const runtimeLayer = Layer.effect(
      PluginRuntime.Service,
      Effect.gen(function* () {
        const runtime = yield* PluginRuntime.Service
        return PluginRuntime.Service.of({
          ...runtime,
          session: {
            ...runtime.session,
            messages: ({ sessionID: id, order }) =>
              store.context(id).pipe(
                Effect.orDie,
                Effect.map((messages) => (order === "desc" ? messages.toReversed() : messages)),
              ),
          },
        })
      }),
    ).pipe(Layer.provide(PluginRuntime.layerWithCell(PluginRuntime.makeCell())))
    const registryLayer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, skillPlugin]), [
      [Permission.node, Layer.mock(Permission.Service, { assert: () => Effect.void })],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [Skill.node, Layer.mock(Skill.Service, { list: () => Effect.succeed([info]), mcp: () => Effect.succeed([]) })],
      [MCP.node, Layer.mock(MCP.Service, {})],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
      ],
      [
        ProjectArtifactSource.node,
        Layer.mock(ProjectArtifactSource.Service, {
          refresh: () => Effect.void,
          provenance: () => Effect.succeed(undefined),
          activate: () => Effect.void,
        }),
      ],
      [PluginRuntime.node, runtimeLayer],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ])
    const settled = yield* Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.materialize()
      return yield* tools.settle({
        call: {
          type: "tool-call",
          id: "outer",
          name: "execute",
          input: {
            code: 'await tools.skill({id:"fixture"}); return await tools.skill({id:"fixture",resource:"reference.md"})',
          },
        },
        sessionID,
        messageID: assistantMessageID,
        agent: Agent.defaultID,
        progress: ({ structured, content }) =>
          publisher.progress({ assistantMessageID, callID: "outer", structured: { ...structured }, content }),
      })
    }).pipe(Effect.provide(registryLayer))
    expect(settled.error).toBeUndefined()
    expect(JSON.stringify(settled.result)).toContain("resource available")
    expect(settled.output?.structured).not.toHaveProperty("error")
    expect((yield* store.skills(sessionID)).map((entry) => entry.state)).toEqual(["active"])
  }),
)

for (const terminal of ["success", "interrupted"] as const) {
  it.effect(`nested edits survive ${terminal} and canonical reload without duplicate file totals`, () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const events = yield* EventRuntime.Service
      const store = yield* SessionStore.Service
      yield* events.publish(SessionEvent.Execution.Started, { sessionID })
      const publisher = createLLMEventPublisher(events, {
        sessionID,
        agent: Agent.defaultID,
        model,
        providerMetadataKey: "fixture",
      })
      yield* publisher.publish(LLMEvent.toolInputStart({ id: "outer", name: "execute" }))
      yield* publisher.publish(LLMEvent.toolCall({ id: "outer", name: "execute", input: {} }))
      const assistantMessageID = yield* publisher.assistantMessageID("outer")
      const receipt = {
        id: "outer:0",
        index: 0,
        tool: "tools.edit",
        name: "edit",
        status: "completed",
        input: { path: "file.ts" },
        structured: { files: [{ file: "file.ts", patch: "+new", additions: 1, deletions: 0 }] },
      }
      const structured = { toolCalls: [receipt] }
      yield* publisher.progress({ assistantMessageID, callID: "outer", structured, content: [] })
      yield* publisher.progress({ assistantMessageID, callID: "outer", structured, content: [] })
      if (terminal === "success")
        yield* publisher.publish(
          LLMEvent.toolResult({
            id: "outer",
            name: "execute",
            result: { type: "text", value: "done" },
            output: { structured, content: [] },
          }),
        )
      else yield* publisher.failUnsettledTools({ type: "aborted", message: "Interrupted" })
      if (terminal === "success") yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
      else yield* events.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" })
      const reloaded = yield* store.context(sessionID)
      expect(reloaded).toMatchObject([
        {
          content: [{ name: "execute", state: { status: terminal === "success" ? "completed" : "error", structured } }],
        },
      ])
      const changes = yield* db
        .select()
        .from(SessionFileChangeTable)
        .where(eq(SessionFileChangeTable.session_id, sessionID))
        .all()
      expect(changes).toMatchObject([{ path: "file.ts", additions: 1, deletions: 0 }])
      const captured = yield* SessionCapturedChanges.page(db, { sessionID, limit: 10 })
      expect(captured.data[0]?.content).toMatchObject([
        { id: "outer:0", name: "edit", state: { structured: { files: [{ file: "file.ts", patch: "+new" }] } } },
      ])
      const facts = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(EventTable.seq)
        .all()
      expect(facts.filter((row) => row.type === "session.tool.invocation-settled.1")).toHaveLength(1)
      const settled = facts.find((row) => row.type === "session.tool.success.1")
      if (settled) expect(settled.data).toMatchObject({ structured: { toolCalls: [] } })
      const rebuilt = yield* Effect.gen(function* () {
        yield* seed
        const { db } = yield* Database.Service
        const events = yield* EventRuntime.Service
        for (const row of facts)
          yield* events.replay({
            id: row.id,
            type: row.type,
            aggregateID: row.aggregate_id,
            seq: row.seq,
            created: DateTime.makeUnsafe(row.created),
            data: row.data,
          })
        return {
          messages: yield* (yield* SessionStore.Service).context(sessionID),
          files: yield* db
            .select()
            .from(SessionFileChangeTable)
            .where(eq(SessionFileChangeTable.session_id, sessionID))
            .all(),
          captured: yield* SessionCapturedChanges.page(db, { sessionID, limit: 10 }),
        }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node]),
          ).pipe(Layer.fresh),
        ),
        Effect.scoped,
      )
      expect(rebuilt).toEqual({ messages: reloaded, files: changes, captured })
      yield* TestClock.adjust(SessionHistoryPruning.SETTLED_GRACE)
      yield* SessionHistoryPruning.make(db, Effect.succeed(new Set())).prune(sessionID)
      const retained = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
      expect(retained.filter((row) => row.type === "session.tool.invocation-settled.1")).toHaveLength(0)
      expect(yield* store.context(sessionID)).toEqual(reloaded)
    }),
  )
}
