import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { ConfigAgent } from "@ycoding-ai/core/config/agent"
import { ConfigCommand } from "@ycoding-ai/core/config/command"
import { ConfigMarkdown } from "@ycoding-ai/core/config/markdown"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { ProjectArtifactAdapterRegistry } from "@ycoding-ai/core/project-artifact/adapter/index"
import { managedDefaults } from "@ycoding-ai/core/project-artifact/adapter/agent"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { SkillDiscovery } from "@ycoding-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const provenance: ProjectArtifact.Provenance = { source: "agent" }
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SkillV2.node, AgentV2.node, EventV2.node, FSUtil.node]),
    [[SkillDiscovery.node, discovery]],
  ),
)

describe("ProjectArtifactAdapterRegistry", () => {
  test("uses a fixed registry and rejects plugin activation", () => {
    expect(ProjectArtifactAdapterRegistry.list().map((adapter) => adapter.kind)).toEqual([
      "skill",
      "command",
      "agent",
      "plugin",
    ])
    expect(ProjectArtifactAdapterRegistry.get("plugin").phase).toBe("unsupported")
  })

  test("round-trips managed agent permission rules", () => {
    const definition = Schema.decodeUnknownSync(ProjectArtifact.AgentDefinition)({
      kind: "agent",
      name: "Builder",
      description: "Runs focused verification",
      system: "Run the requested task.",
      mode: "subagent",
      permissions: [
        { action: "shell", resource: "bun test*", effect: "allow" },
        { action: "shell", resource: "*", effect: "ask" },
      ],
    })
    const adapter = ProjectArtifactAdapterRegistry.get("agent")
    expect(adapter.parse(adapter.render(definition, provenance))).toEqual(definition)
  })

  test("round-trips standard skill markdown and paths", () => {
    const adapter = ProjectArtifactAdapterRegistry.get("skill")
    const definition: ProjectArtifact.SkillDefinition = {
      kind: "skill",
      name: "Core review",
      description: "Review Core changes",
      content: "Run focused Core checks.",
    }
    expect(adapter.parse(adapter.render(definition, provenance))).toEqual(definition)
    expect(adapter.projectPath("/scope", "core-review")).toBe(path.join("/scope", "active", "skills", "core-review", "SKILL.md"))
    expect(adapter.globalPath({ home: "/home", config: "/config" }, "core-review")).toBe(
      path.join("/home", ".agents", "skills", "core-review", "SKILL.md"),
    )
  })

  test("preserves supported body whitespace through every declarative adapter", () => {
    const definitions = [
      {
        kind: "skill" as const,
        name: "Skill name",
        description: "Skill description",
        content: "  Keep skill indentation.\n\n",
      },
      {
        kind: "command" as const,
        name: "Command name",
        description: "Command description",
        template: "  Keep command indentation.\n\n",
        subtask: false as const,
      },
      {
        kind: "agent" as const,
        name: "Agent name",
        description: "Agent description",
        system: "  Keep agent indentation.\n\n",
        mode: "subagent" as const,
        permissions: [] as [],
      },
    ] satisfies ProjectArtifact.Definition[]
    for (const definition of definitions) {
      expect(ProjectArtifactAdapterRegistry.parse(definition.kind, ProjectArtifactAdapterRegistry.render(definition, provenance))).toEqual(
        definition,
      )
    }
  })

  test("renders command without agent/model and least-privilege subagent", () => {
    const command = ProjectArtifactAdapterRegistry.get("command").render(
      {
        kind: "command",
        name: "Review",
        description: "Review current changes",
        template: "Review current changes.",
        subtask: false,
      },
      provenance,
    )
    expect(command).toContain("subtask: false")
    expect(command).not.toMatch(/^(agent|model):/m)

    const agent = ProjectArtifactAdapterRegistry.get("agent").render(
      {
        kind: "agent",
        name: "Reviewer",
        description: "Reviews changes",
        system: "Review without modifying files.",
        mode: "subagent",
        permissions: [],
      },
      provenance,
    )
    expect(agent).toContain("mode: subagent")
    expect(agent).toContain("permissions: []")
    expect(agent).not.toMatch(/^(model|request):/m)
  })

  test("diagnoses collisions and permits only an exact confirmed global shadow", () => {
    expect(
      ProjectArtifactAdapterRegistry.collision({ kind: "skill", id: "review", existing: [{ scope: "project", versionID: "explicit" }] }),
    ).toEqual(expect.objectContaining({ type: "existing-source" }))
    expect(
      ProjectArtifactAdapterRegistry.collision({
        kind: "skill",
        id: "review",
        existing: [{ scope: "global", scopeID: "pas_global", versionID: "pav_global" }],
        shadow: { scopeID: "pas_global", versionID: "pav_global" },
      }),
    ).toEqual(expect.objectContaining({ type: "project-over-global-shadow", allowed: true }))
  })


  test.each([
    {
      kind: "command" as const,
      definition: {
        kind: "command" as const,
        name: "Command display name",
        description: "Command description differs",
        template: "Review the current change.",
        subtask: false as const,
      },
    },
    {
      kind: "agent" as const,
      definition: {
        kind: "agent" as const,
        name: "Agent display name",
        description: "Agent description differs",
        system: "Review the current change without modifying files.",
        mode: "subagent" as const,
        permissions: [] as [],
      },
    },
  ])("round-trips exact $kind name and description from authoritative bytes", ({ kind, definition }) => {
    const rendered = ProjectArtifactAdapterRegistry.render(definition, provenance)
    expect(ProjectArtifactAdapterRegistry.parse(kind, rendered)).toEqual(definition)
  })

  it.live("loads adapter bytes through SkillV2 and the standard Command and Agent markdown decoders", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-adapter-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const skillDefinition: ProjectArtifact.SkillDefinition = {
            kind: "skill",
            name: "Core review skill",
            description: "Discovers a rendered skill",
            content: "Run focused Core checks.",
          }
          const commandDefinition: ProjectArtifact.CommandDefinition = {
            kind: "command",
            name: "Command display name",
            description: "Discovers a rendered command",
            template: "Review the current change.",
            subtask: false,
          }
          const agentDefinition: ProjectArtifact.AgentDefinition = {
            kind: "agent",
            name: "Agent display name",
            description: "Discovers a rendered agent",
            system: "Review without modifying files.",
            mode: "subagent",
            permissions: [],
          }
          const definitions = [
            { id: "core-review", definition: skillDefinition },
            { id: "review", definition: commandDefinition },
            { id: "reviewer", definition: agentDefinition },
          ] as const
          yield* Effect.promise(async () => {
            for (const item of definitions) {
              const file = ProjectArtifactAdapterRegistry.get(item.definition.kind).projectPath(tmp.path, item.id)
              await fs.mkdir(path.dirname(file), { recursive: true })
              await fs.writeFile(file, ProjectArtifactAdapterRegistry.render(item.definition, provenance))
            }
          })

          const skills = yield* SkillV2.Service
          const skillPath = ProjectArtifactAdapterRegistry.get("skill").projectPath(tmp.path, "core-review")
          yield* skills.transform((draft) =>
            ProjectArtifactAdapterRegistry.get("skill").activate(version("core-review", skillPath, skillDefinition), {
              skill: draft,
            }),
          )
          expect(yield* skills.list()).toContainEqual(
            expect.objectContaining({
              id: SkillV2.ID.make("core-review"),
              name: SkillV2.Name.make("Core review skill"),
              description: "Discovers a rendered skill",
              content: "Run focused Core checks.",
            }),
          )

          const commandMarkdown = ConfigMarkdown.parse(
            ProjectArtifactAdapterRegistry.render(commandDefinition, provenance),
          )
          const discoveredCommand = Schema.decodeUnknownSync(ConfigCommand.Info)({
            ...commandMarkdown.data,
            template: commandMarkdown.content.trim(),
          })
          expect(discoveredCommand).toMatchObject({
            description: commandDefinition.description,
            template: commandDefinition.template,
            subtask: false,
          })
          expect(discoveredCommand?.agent).toBeUndefined()
          expect(discoveredCommand?.model).toBeUndefined()

          const agentMarkdown = ConfigMarkdown.parse(ProjectArtifactAdapterRegistry.render(agentDefinition, provenance))
          const discoveredAgent = Schema.decodeUnknownSync(ConfigAgent.Info)({
            ...agentMarkdown.data,
            system: agentMarkdown.content.trim(),
          })
          expect(discoveredAgent).toMatchObject({
            description: agentDefinition.description,
            system: agentDefinition.system,
            mode: "subagent",
          })
          expect(discoveredAgent?.model).toBeUndefined()
          expect(discoveredAgent?.permissions).toEqual([])

          const agents = yield* AgentV2.Service
          yield* agents.transform((draft) =>
            ProjectArtifactAdapterRegistry.get("agent").activate(
              version(
                "reviewer",
                ProjectArtifactAdapterRegistry.get("agent").projectPath(tmp.path, "reviewer"),
                ProjectArtifactAdapterRegistry.parse("agent", ProjectArtifactAdapterRegistry.render(agentDefinition, provenance)),
              ),
              { agent: draft },
            ),
          )
          expect(yield* agents.get(AgentV2.ID.make("reviewer"))).toMatchObject({
            name: AgentV2.Name.make(agentDefinition.name),
            permissions: managedDefaults,
            model: undefined,
            request: { settings: {}, headers: {}, body: {} },
          })
        }),
      ),
    ),
  )

})

function version(id: string, contentPath: string, definition: ProjectArtifact.Definition) {
  return {
    scopeID: ProjectArtifact.ScopeID.make("pas_test"),
    versionID: ProjectArtifact.VersionID.make("pav_test"),
    id: ProjectArtifact.ID.make(id),
    contentPath,
    definition,
  }
}
