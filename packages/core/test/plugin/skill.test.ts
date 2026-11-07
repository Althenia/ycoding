import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { AccountConnectorLibrary } from "@ycoding-ai/core/account-connectors/library"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Config } from "@ycoding-ai/core/config"
import { ConfigAccountConnectors } from "@ycoding-ai/core/config/account-connectors"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Location } from "@ycoding-ai/core/location"
import { Effect } from "effect"
import { SkillPlugin } from "@ycoding-ai/core/plugin/skill"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Skill } from "@ycoding-ai/core/skill"
import { emptyMcpLayer } from "../fixture/mcp"
import { location, tempLocationLayer } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(Skill.node, [[MCP.node, emptyMcpLayer], [Location.node, tempLocationLayer]]))

const registeredSkills = Effect.fn("registeredSkills")(function* () {
  const skill = yield* Skill.Service
  yield* SkillPlugin.Plugin.effect(
    host({
      skill: {
        list: () => Effect.die("unused skill.list"),
        transform: skill.transform,
        reload: skill.reload,
      },
    }),
  ).pipe(
    Effect.provideService(
      Config.Service,
      Config.Service.of({ diagnostics: () => Effect.succeed([]), reload: () => Effect.void, entries: () => Effect.succeed([]) }),
    ),
    Effect.provideService(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
    ),
    Effect.provide(AppNodeBuilder.build(FSUtil.node)),
    Effect.provide(NodeFileSystem.layer),
  )
  return yield* skill.list()
})

const libraryPaths = () => {
  const registration = AccountConnectorLibrary.make({
    attachments: AttachmentStore.make(mkdtempSync(path.join(os.tmpdir(), "ycoding-skill-library-"))),
    current: () => Effect.void,
    permission: { assert: () => Effect.void },
    guardrail: { assert: () => Effect.succeed({ release: Effect.void }) },
    request: () => Effect.die("The skill content test makes no Library request"),
  })
  return Object.values(registration.options.paths).map((value) => `tools.${value}`)
}

describe("SkillPlugin.Plugin", () => {
  it.effect("registers built-in skills", () =>
    Effect.gen(function* () {
      const skills = yield* registeredSkills()
      const report = skills.find((item) => item.id === "report")

      expect(skills).toContainEqual(
        expect.objectContaining({
          id: "ycoding",
          name: "YCoding",
          description: expect.stringContaining("questions about YCoding behavior"),
        }),
      )
      expect(skills).toContainEqual(
        expect.objectContaining({
          id: "report",
          name: "Report",
          description: expect.stringContaining("YCoding issue"),
        }),
      )
      expect(skills).toContainEqual(
        expect.objectContaining({
          id: "chatgpt-connectors",
          name: "ChatGPT connectors",
          location: "/builtin/chatgpt-connectors.md",
          description: expect.stringContaining("tools.chatgpt"),
        }),
      )
      expect(report?.slash).toBe(true)
      expect(report?.content).toContain(`- ycoding version: ${InstallationVersion}`)
    }),
  )

  it.effect("the ChatGPT connectors skill names only real Library operations and configuration keys", () =>
    Effect.gen(function* () {
      const skill = (yield* registeredSkills()).find((item) => item.id === "chatgpt-connectors")
      const content = skill?.content ?? ""

      const mentionedOperations = [...new Set(content.match(/tools\.chatgpt\.library\.[A-Za-z_]+/g) ?? [])].toSorted()
      expect(mentionedOperations).toEqual(libraryPaths().toSorted())

      const mentionedKeys = [...new Set([...content.matchAll(/account_connectors\.chatgpt\.([A-Za-z_]+)/g)].map((match) => match[1]))]
      expect(mentionedKeys.length).toBeGreaterThan(0)
      for (const key of mentionedKeys) expect(Object.keys(ConfigAccountConnectors.ChatGPT.fields)).toContain(key)

      expect(content).toContain("search({ query:")
      expect(content).toContain("tools.chatgpt.<connector>.<operation>")
      expect(content).toContain("`chatgpt_*`")
    }),
  )
})
