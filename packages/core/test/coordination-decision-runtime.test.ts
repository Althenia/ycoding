import { expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Session } from "@ycoding-ai/schema/session"
import { Permission } from "../src/permission"
import { Form } from "../src/form"
import { SessionGuardrail } from "../src/session/guardrail"
import { SessionStore } from "../src/session/store"
import { CoordinationService } from "../src/coordination/index"
import { CoordinationSettings } from "../src/coordination-settings"
import { CoordinationDecisionRuntime } from "../src/coordination/decisions"
import { CoordinationDecisions } from "../src/session/coordination-decisions"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { makeGlobalNode } from "../src/effect/app-node"
import { LayerNode } from "../src/effect/layer-node"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { Money } from "@ycoding-ai/schema/money"
import { testEffect } from "./lib/effect"

const coordinatorSessionID = Session.ID.make("ses_route_coordinator")
const targetSessionID = Session.ID.make("ses_route_worker")
const groupID = Coordination.GroupID.make("cgrp_route")
const locations: string[] = []
const it = testEffect(AppNodeBuilder.build(LayerNode.group([CoordinationDecisionRuntime.node]), [
  [CoordinationSettings.node, Layer.succeed(CoordinationSettings.Service, { read: () => Effect.succeed({ enabled: true, categories: ["question", "permission", "review"] }) })],
  [CoordinationService.node, Layer.mock(CoordinationService.Service, { get: () => Effect.succeed(Coordination.Info.make({ id: groupID, name: "Scoped", revision: Coordination.Revision.make(1), status: "armed", fencingGeneration: 1, policy: { concurrency: 1, queueCapacity: 10 }, members: [
    { sessionID: coordinatorSessionID, role: "coordinator", location: { directory: AbsolutePath.make("/coordinator") } },
    { sessionID: targetSessionID, role: "worker", location: { directory: AbsolutePath.make("/target") } },
  ], time: { created: 1, updated: 1 } })) })],
  [SessionStore.node, Layer.mock(SessionStore.Service, { get: (id) => Effect.succeed(Session.Info.make({ id, projectID: Project.ID.global, title: "Target", location: { directory: AbsolutePath.make(id === targetSessionID ? "/target" : "/coordinator") }, cost: Money.USD.make(0), tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) } })) })],
  [CoordinationDecisionRuntime.node, makeGlobalNode({ service: CoordinationDecisions.Service, layer: CoordinationDecisionRuntime.layerWith((location) => {
    locations.push(location.directory)
    return Layer.mergeAll(
      Layer.mock(Permission.Service, { snapshots: (sessionID) => Effect.succeed([{ request: Permission.Request.make({ id: Permission.ID.make("per_target"), sessionID, action: "read", resources: ["src/a.ts"] }), fingerprint: "target-fingerprint" }]) }),
      Layer.mock(Form.Service, { snapshots: () => Effect.succeed([]) }),
      Layer.mock(SessionGuardrail.Service, { reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true }, requestSnapshots: () => Effect.succeed([]) }),
    )
  }), deps: [CoordinationService.node, CoordinationSettings.node, SessionStore.node] })],
]))

it.effect("pending coordination decisions resolve native services from the target's stored Location", () => Effect.gen(function* () {
  locations.length = 0
  const decisions = yield* CoordinationDecisions.Service
  const pending = yield* decisions.pending({ groupID, coordinatorSessionID, targetSessionID })
  expect(locations).toEqual(["/target"])
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ kind: "permission", fingerprint: "target-fingerprint", request: { sessionID: targetSessionID } })
}))
