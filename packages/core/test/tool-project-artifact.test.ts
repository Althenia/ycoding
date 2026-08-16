import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Image } from "@ycoding-ai/core/image"
import { Location } from "@ycoding-ai/core/location"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { ProjectArtifactSource } from "@ycoding-ai/core/project-artifact/source"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ProjectArtifactTool } from "@ycoding-ai/core/tool/project-artifact"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Project } from "@ycoding-ai/schema/project"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin, settleTool, toolDefinitions } from "./lib/tool"
import { testEffect } from "./lib/effect"

const decode = Schema.decodeUnknownOption(ProjectArtifactTool.Input)
const sessionID = SessionV2.ID.make("ses_project_artifact_tool")
const agentID = AgentV2.ID.make("build")
const messageID = SessionMessage.ID.make("msg_project_artifact_tool")
const projectID = Project.ID.make("project-artifact-tool")
const location = {
  directory: AbsolutePath.make("/workspace/project"),
  project: { id: projectID, directory: AbsolutePath.make("/workspace/project") },
}
const writes: ProjectArtifactStore.AutomaticWriteInput[] = []
const order: string[] = []
let permissionDecision: "ask" | "allow" | "deny" = "allow"
let refreshes = 0
let storeFailure: ProjectArtifactStore.StoreError | undefined

const result: ProjectArtifactStore.WriteResult = {
  result: "created",
  scopeID: ProjectArtifact.ScopeID.make("pas_tool"),
  kind: "skill",
  id: ProjectArtifact.ID.make("review"),
  versionID: ProjectArtifact.VersionID.make("pav_tool"),
  contentDigest: ProjectArtifact.Digest.make("a".repeat(64)),
  stage: "trial",
  remaining: { session: 2, projectDaily: 9, projectArtifacts: 31, versions: 15, bytes: 8_000_000 },
}

const store = Layer.mock(ProjectArtifactStore.Service, {
  writeAutomatic: (input) => {
    writes.push(input)
    order.push("store")
    return storeFailure ? Effect.fail(storeFailure) : Effect.succeed(result)
  },
})
const source = Layer.mock(ProjectArtifactSource.Service, {
  refresh: () =>
    Effect.sync(() => {
      refreshes++
      order.push("refresh")
    }),
  provenance: () => Effect.succeed(undefined),
  activate: () => Effect.void,
})
const permission = Layer.mock(PermissionV2.Service, {
  evaluateEffective: () => Effect.sync(() => permissionDecision),
  ask: () => Effect.die("project_artifact must not publish permission asks"),
})
const guardrail = Layer.mock(SessionGuardrail.Service, {
  assert: () => Effect.succeed({ release: Effect.void }),
})
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location))
const projectArtifactToolNode = makeLocationNode({
  name: "test/project-artifact-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ProjectArtifactTool.Plugin)),
  deps: [
    ToolRegistry.toolsNode,
    Location.node,
    PermissionV2.node,
    SessionGuardrail.node,
    ProjectArtifactStore.node,
    ProjectArtifactSource.node,
  ],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, projectArtifactToolNode]),
    [
      [Location.node, locationLayer],
      [PermissionV2.node, permission],
      [SessionGuardrail.node, guardrail],
      [ProjectArtifactStore.node, store],
      [ProjectArtifactSource.node, source],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  ),
)

const skillInput = {
  kind: "skill" as const,
  id: "review",
  insight_key: "focused-review",
  name: "Review",
  description: "Reusable review guidance",
  content: "Run focused checks.",
}

const call = (input: unknown, id = "call-project-artifact") => ({
  sessionID,
  agent: agentID,
  messageID,
  call: { type: "tool-call" as const, id, name: ProjectArtifactTool.name, input },
})

function reset() {
  writes.length = 0
  order.length = 0
  permissionDecision = "allow"
  refreshes = 0
  storeFailure = undefined
  location.project.id = projectID
}

describe("ProjectArtifactTool input", () => {
  test("accepts exact declarative definitions", () => {
    expect(decode(skillInput).valueOrUndefined).toMatchObject({ kind: "skill", id: "review" })
    expect(
      decode({
        kind: "command",
        id: "review",
        insight_key: "review-command",
        name: "Review",
        description: "Reusable command",
        template: "Review changes.",
      }).valueOrUndefined,
    ).toMatchObject({ kind: "command", id: "review" })
    expect(
      decode({
        kind: "agent",
        id: "reviewer",
        insight_key: "review-agent",
        name: "Reviewer",
        description: "Reusable reviewer",
        system: "Review changes.",
        permissions: [{ action: "shell", resource: "bun test*", effect: "allow" }],
      }).valueOrUndefined,
    ).toMatchObject({
      kind: "agent",
      id: "reviewer",
      permissions: [{ action: "shell", resource: "bun test*", effect: "allow" }],
    })
  })

  test("rejects plugin, lifecycle, caller, and capability controls", () => {
    const rejected = [
      { ...skillInput, kind: "plugin", draft: "export default {}" },
      { ...skillInput, scope: "global" },
      { ...skillInput, global: true },
      { ...skillInput, promote: true },
      { ...skillInput, delete: true },
      { ...skillInput, disable: true },
      { ...skillInput, enable: true },
      { ...skillInput, revert: true },
      { ...skillInput, projectID: "caller" },
      { ...skillInput, sessionID: "caller" },
      { ...skillInput, agentID: "caller" },
      { ...skillInput, now: 1 },
      {
        kind: "command",
        id: "review",
        insight_key: "review-command",
        name: "Review",
        description: "Reusable command",
        template: "Review changes.",
        agent: "build",
      },
    ]
    expect(rejected.every((input) => decode(input).valueOrUndefined === undefined)).toBe(true)
  })
})

describe("ProjectArtifactTool runtime", () => {
  it.effect("registers one native project_artifact tool and settles one exact automatic write", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["project_artifact"])

      const settlement = yield* settleTool(registry, call(skillInput))

      expect(writes).toEqual([
        {
          projectID,
          sessionID,
          agentID,
          insightKey: "focused-review",
          id: "review",
          definition: {
            kind: "skill",
            name: "Review",
            description: "Reusable review guidance",
            content: "Run focused checks.",
          },
          baseVersionID: undefined,
        },
      ])
      expect(order).toEqual(["store", "refresh"])
      expect(settlement.output?.structured).toEqual({
        result: "created",
        kind: "skill",
        id: "review",
        versionID: "pav_tool",
        contentDigest: "a".repeat(64),
        stage: "trial",
        remaining: { session: 2, projectDaily: 9, projectArtifacts: 31, versions: 15, bytes: 8_000_000 },
      })
      const serialized = JSON.stringify(settlement)
      expect(serialized).not.toContain("focused-review")
      expect(serialized).not.toContain("Run focused checks")
    }),
  )

  it.effect("denies without Store or refresh and treats ask and allow as non-interactive permission", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      permissionDecision = "deny"
      expect((yield* settleTool(registry, call(skillInput, "call-deny"))).result).toEqual({
        type: "error",
        value: "Project artifact is denied",
      })
      expect(writes).toEqual([])
      expect(refreshes).toBe(0)

      for (const decision of ["ask", "allow"] as const) {
        permissionDecision = decision
        expect((yield* settleTool(registry, call(skillInput, `call-${decision}`))).result.type).toBe("text")
      }
      expect(writes).toHaveLength(2)
      expect(refreshes).toBe(2)
    }),
  )

  it.effect("rejects Project.ID.global before Store and bounds Store failures", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      location.project.id = Project.ID.global
      expect((yield* settleTool(registry, call(skillInput, "call-global"))).result).toEqual({
        type: "error",
        value: "Project artifact requires a stable project identity",
      })
      expect(writes).toEqual([])
      location.project.id = projectID
      storeFailure = new ProjectArtifactStore.StoreError({
        code: "StorageUnavailable",
        message: "secret input at /private/repository and https://private.invalid",
      })
      const failed = yield* settleTool(registry, call(skillInput, "call-store-failure"))
      expect(failed.result).toEqual({ type: "error", value: "Project artifact write was rejected" })
      expect(JSON.stringify(failed)).not.toContain("secret")
      expect(JSON.stringify(failed)).not.toContain("/private")
      expect(JSON.stringify(failed)).not.toContain("https://")
      expect(refreshes).toBe(0)
    }),
  )
})
