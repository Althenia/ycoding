import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Session } from "@ycoding-ai/schema/session"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { CoordinationAccessResolver } from "../src/coordination/access"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { SessionMessageTable, SessionPendingTable, SessionTable } from "../src/session/sql"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const worker = Session.ID.make("ses_access_worker")
const child = Session.ID.make("ses_access_child")
const coordinator = Session.ID.make("ses_access_coordinator")
const coordinatorChild = Session.ID.make("ses_access_coordinator_child")
const assigned = SessionMessage.ID.make("msg_access_assigned")
const membership = Coordination.RoleAccess.make({ groupID: Coordination.GroupID.make("cgrp_access"), revision: Coordination.Revision.make(1), status: "armed", role: "worker", allowedTools: ["read", "edit"], resourceScopes: ["src/*"], fencingGeneration: 1 })
const selection = { agent: Agent.ID.make("occam"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture-model"), variant: Model.VariantID.make("medium") }), reason: "Small, single-owner edit with a settled implementation" }

const row = (message: typeof SessionMessage.Info.Type, sessionID: Session.ID, seq: number) => {
  const { id: _, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
  return { id: message.id, session_id: sessionID, seq, type, data }
}
const userMessage = (id: SessionMessage.ID, text: string, created: number) =>
  SessionMessage.User.make({ id, type: "user", text, files: [], agents: [], time: { created: DateTime.makeUnsafe(created) } })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
  yield* db.insert(SessionTable).values([
    { id: worker, project_id: Project.ID.global, directory: "/project", title: "Worker" },
    { id: child, parent_id: worker, project_id: Project.ID.global, directory: "/project", title: "Worker child" },
    { id: coordinator, project_id: Project.ID.global, directory: "/project", title: "Coordinator" },
    { id: coordinatorChild, parent_id: coordinator, project_id: Project.ID.global, directory: "/project", title: "Coordinator child" },
  ]).run()
  return db
})

describe("coordination enforcement source", () => {
  it.effect("uses promoted user identity, ignores pending and synthetic rows, and intersects independent resource restrictions", () => Effect.gen(function* () {
    const db = yield* setup
    yield* db.insert(SessionMessageTable).values([
      row(userMessage(assigned, "Inspect", 1), worker, 1),
      row(SessionMessage.Synthetic.make({ id: SessionMessage.ID.make("msg_access_observation"), type: "synthetic", text: "Observe", time: { created: DateTime.makeUnsafe(2) } }), worker, 2),
    ]).run()
    yield* db.insert(SessionPendingTable).values({ id: SessionMessage.ID.make("msg_access_pending"), session_id: worker, type: "user", delivery: "queue", admitted_seq: 3, data: { text: "Future" } }).run()
    const seen: string[] = []
    const resolver = CoordinationAccessResolver.make({ db, coordination: {
      standingRoles: (id) => Effect.succeed(id === worker ? [membership] : []),
      accessForInput: (input) => Effect.sync(() => {
        seen.push(input.messageID)
        return input.messageID === assigned ? { ...membership, role: "worker" as const, dispatchID: Coordination.DispatchID.make("cdsp_access"), coordinatorSessionID: coordinator, generation: 1, allowedTools: ["read"], assignmentResourceScope: "src/one/*", selection } : undefined
      }),
    } })
    const access = yield* resolver.forSession(worker)
    expect(seen).toEqual([assigned])
    expect(access.map((entry) => entry.resourceScopes)).toEqual([["src/*"], ["src/*"], ["src/one/*"]])
    expect(access.at(-1)?.allowedTools).toEqual(["read"])
    expect(access.find((entry) => entry.selection)?.selection).toEqual(selection)
    expect((yield* resolver.forSession(child)).map((entry) => entry.resourceScopes)).toEqual([["src/*"], ["src/*"], ["src/one/*"]])
    expect((yield* resolver.forSession(child)).some((entry) => entry.selection !== undefined)).toBe(false)
  }))

  it.effect("does not impose a coordinator's implementation ban on its worker subagents", () => Effect.gen(function* () {
    const db = yield* setup
    const resolver = CoordinationAccessResolver.make({ db, coordination: {
      standingRoles: (id) => Effect.succeed(id === coordinator ? [{ ...membership, role: "coordinator" as const }] : []),
      accessForInput: () => Effect.succeed(undefined),
    } })
    expect((yield* resolver.forSession(coordinator))[0]?.role).toBe("coordinator")
    expect(yield* resolver.forSession(coordinatorChild)).toEqual([])
  }))

  it.effect("ends the execution override when a later human input is promoted", () => Effect.gen(function* () {
    const db = yield* setup
    yield* db.insert(SessionMessageTable).values([
      row(userMessage(assigned, "Inspect", 1), worker, 1),
      row(userMessage(SessionMessage.ID.make("msg_access_human"), "New work", 2), worker, 2),
    ]).run()
    const resolver = CoordinationAccessResolver.make({ db, coordination: {
      standingRoles: () => Effect.succeed([membership]),
      accessForInput: (input) => Effect.succeed(input.messageID === assigned ? { ...membership, role: "worker" as const, dispatchID: Coordination.DispatchID.make("cdsp_access"), coordinatorSessionID: coordinator, generation: 1, selection } : undefined),
    } })
    expect((yield* resolver.forSession(worker)).some((entry) => entry.selection !== undefined)).toBe(false)
  }))
})
