import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Config } from "@ycoding-ai/core/config"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Location } from "@ycoding-ai/core/location"
import { Effect } from "effect"
import { SkillPlugin } from "@ycoding-ai/core/plugin/skill"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers built-in skills", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(
        host({
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: skill.transform,
            reload: skill.reload,
          },
        }),
      ).pipe(
        Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
        ),
        Effect.provide(AppNodeBuilder.build(FSUtil.node)),
        Effect.provide(NodeFileSystem.layer),
      )
      const skills = yield* skill.list()
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
      expect(report?.slash).toBe(true)
      expect(report?.content).toContain(`- ycoding version: ${InstallationVersion}`)
    }),
  )
})
