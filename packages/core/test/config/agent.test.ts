import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigAgentPlugin } from "@ycoding-ai/core/config/plugin/agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AgentV2.node, FSUtil.node, Global.node])))
const decode = Schema.decodeUnknownSync(Config.Info)
const defaultPermissions = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
] satisfies PermissionV2.Ruleset

describe("ConfigAgentPlugin.Plugin", () => {
  it.effect("matches POSIX paths against home-relative permissions", () =>
    Effect.gen(function* () {
      const permissions = yield* loadHomePermissions("/home/test")
      expect(PermissionV2.evaluate("external_directory", "/home/test/p/ycoding/src/*", permissions).effect).toBe(
        "allow",
      )
      expect(PermissionV2.evaluate("external_directory", "/home/test/cache/files/*", permissions).effect).toBe("deny")
      expect(PermissionV2.evaluate("external_directory", "/some/~/path", permissions).effect).toBe("deny")
      expect(PermissionV2.evaluate("external_directory", "$HOMELESS/private/*", permissions).effect).toBe("deny")
      expect(permissions).toContainEqual({ action: "shell", resource: "$HOME/private/**", effect: "deny" })
      expect(permissions).not.toContainEqual({ action: "shell", resource: "/home/test/private/**", effect: "deny" })
      expect(PermissionV2.evaluate("shell", "$HOME/private/key", permissions).effect).toBe("deny")
    }),
  )

  it.effect("matches Windows paths against home-relative permissions", () =>
    Effect.gen(function* () {
      const permissions = yield* loadHomePermissions("C:\\Users\\test")
      expect(
        PermissionV2.evaluate("external_directory", "C:\\Users\\test\\p\\ycoding\\src\\*", permissions).effect,
      ).toBe("allow")
      expect(PermissionV2.evaluate("external_directory", "C:\\Users\\test\\cache\\files\\*", permissions).effect).toBe(
        "deny",
      )
    }),
  )

  it.effect("applies all global permissions before agent-specific permissions", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      yield* agents.transform((editor) =>
        editor.update(build, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "bash", resource: "*", effect: "allow" })
        }),
      )

      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                permissions: [{ action: "bash", resource: "*", effect: "ask" }],
                agents: {
                  build: {
                    permissions: [{ action: "bash", resource: "git *", effect: "allow" }],
                  },
                  reviewer: {
                    model: "openrouter/openai/gpt-5",
                    description: "Review changes",
                    mode: "subagent",
                    permissions: [
                      { action: "edit", resource: "*", effect: "deny" },
                      { action: "read", resource: "*", effect: "deny" },
                    ],
                  },
                  removed: { description: "Removed later" },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                permissions: [{ action: "read", resource: "*", effect: "allow" }],
                agents: {
                  reviewer: { model: "openrouter/openai/gpt-5#high", hidden: true },
                  removed: { disabled: true },
                  late: {
                    permissions: [{ action: "edit", resource: "*", effect: "allow" }],
                  },
                },
              }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Config.Service, config),
      )

      const buildAgent = yield* agents.get(build)
      if (!buildAgent) throw new Error("expected configured build agent")
      expect(buildAgent.permissions).toEqual([
        ...defaultPermissions,
        { action: "bash", resource: "*", effect: "allow" },
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "bash", resource: "git *", effect: "allow" },
      ])
      expect(PermissionV2.evaluate("bash", "git status", buildAgent.permissions).effect).toBe("allow")
      expect(PermissionV2.evaluate("bash", "bun test", buildAgent.permissions).effect).toBe("ask")

      const reviewer = yield* agents.get(AgentV2.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        description: "Review changes",
        mode: "subagent",
        hidden: true,
        model: { providerID: "openrouter", id: "openai/gpt-5", variant: "high" },
      })
      expect(reviewer.permissions).toEqual([
        ...defaultPermissions,
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "deny" },
      ])
      expect(PermissionV2.evaluate("read", "README.md", reviewer.permissions).effect).toBe("deny")
      expect((yield* agents.get(AgentV2.ID.make("late")))?.permissions).toEqual([
        ...defaultPermissions,
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
      ])
      expect(yield* agents.get(AgentV2.ID.make("removed"))).toBeUndefined()
    }),
  )

  it.effect("maps configured agent fields and preserves an unspecified model variant", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                agents: {
                  reviewer: {
                    model: "anthropic/claude-sonnet",
                    system: "Review carefully.",
                    description: "Reviews changes",
                    mode: "subagent",
                    hidden: true,
                    color: "warning",
                    steps: 12,
                    request: {
                      headers: { first: "one", shared: "first" },
                      body: { enabled: true, profile: "review", effort: "medium" },
                    },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                agents: {
                  reviewer: {
                    request: {
                      headers: { shared: "last", second: "two" },
                      body: { retries: 2, effort: "high" },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Config.Service, config),
      )

      const reviewer = yield* agents.get(AgentV2.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        system: "Review carefully.",
        description: "Reviews changes",
        mode: "subagent",
        hidden: true,
        color: "warning",
        steps: 12,
        model: { providerID: "anthropic", id: "claude-sonnet" },
      })
      expect(reviewer.request).toEqual({
        settings: {},
        headers: { first: "one", shared: "last", second: "two" },
        body: { enabled: true, profile: "review", retries: 2, effort: "high" },
      })
    }),
  )

  it.effect("removes a built-in agent disabled by configuration", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      yield* agents.transform((editor) => editor.update(build, () => {}))

      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({ agents: { build: { disabled: true } } }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Config.Service, config),
      )

      expect(yield* agents.get(build)).toBeUndefined()
    }),
  )

  it.live("loads current file-based agents from config directories", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "agents", "team"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "agents", "reviewer.md"),
              `---
model:
  providerID: openrouter
  model: openai/gpt-5
description: Markdown description
request:
  body:
    temperature: 0.5
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
Review carefully.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "team", "helper.md"), "Help the team.")
            await fs.writeFile(
              path.join(tmp.path, "agents", "native.md"),
              `---
request:
  headers:
    x-agent: native
  body:
    effort: high
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
Use current fields.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "disabled.md"), "---\ndisabled: true\n---\nDisabled")
          })
          const agents = yield* AgentV2.Service
          const config = Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode({ agents: { reviewer: { description: "JSON description" } } }),
                }),
                new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
              ]),
          })

          yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
            Effect.provideService(Config.Service, config),
          )

          expect(yield* agents.get(AgentV2.ID.make("reviewer"))).toMatchObject({
            model: { providerID: "openrouter", id: "openai/gpt-5" },
            system: "Review carefully.",
            description: "Markdown description",
            locations: [path.join(tmp.path, "agents", "reviewer.md")],
            request: { body: { temperature: 0.5 } },
            permissions: [...defaultPermissions, { action: "edit", resource: "*", effect: "deny" }],
          })
          expect(yield* agents.get(AgentV2.ID.make("team/helper"))).toMatchObject({
            system: "Help the team.",
            locations: [path.join(tmp.path, "agents", "team", "helper.md")],
          })
          expect(yield* agents.get(AgentV2.ID.make("native"))).toMatchObject({
            system: "Use current fields.",
            locations: [path.join(tmp.path, "agents", "native.md")],
            request: { headers: { "x-agent": "native" }, body: { effort: "high" } },
            permissions: [...defaultPermissions, { action: "edit", resource: "*", effect: "deny" }],
          })
          expect(yield* agents.get(AgentV2.ID.make("disabled"))).toBeUndefined()
        }),
      ),
    ),
  )
})

function loadHomePermissions(home: string) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const build = AgentV2.ID.make("build")
    yield* agents.transform((editor) => editor.update(build, () => {}))
    const config = Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: decode({
              permissions: [
                { action: "external_directory", resource: "~/p/**", effect: "allow" },
                { action: "external_directory", resource: "/some/~/path", effect: "deny" },
                { action: "external_directory", resource: "$HOMELESS/**", effect: "deny" },
                { action: "shell", resource: "$HOME/private/**", effect: "deny" },
              ],
              agents: {
                build: {
                  permissions: [
                    { action: "external_directory", resource: "$HOME/cache/**", effect: "deny" },
                  ],
                },
              },
            }),
          }),
        ]),
    })

    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provideService(Config.Service, config),
      Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home })),
    )

    const agent = yield* agents.get(build)
    if (!agent) throw new Error("expected configured build agent")
    return agent.permissions
  })
}
