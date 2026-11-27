/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "@ycoding-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { Skill } from "../skill"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { ConfigMarkdown } from "../config/markdown"
import { Config } from "../config"
import { Location } from "../location"
import { FSUtil } from "../fs-util"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import ycodingContent from "./skill/ycoding/SKILL.md" with { type: "text" }
import reportContent from "./skill/report/SKILL.md" with { type: "text" }
import chatgptConnectorsContent from "./skill/chatgpt-connectors/SKILL.md" with { type: "text" }
import browserUseContent from "./skill/browser-use/SKILL.md" with { type: "text" }
import computerUseContent from "./skill/computer-use/SKILL.md" with { type: "text" }

const documents = [ycodingContent, chatgptConnectorsContent, browserUseContent, computerUseContent, reportContent].map((source) => {
  const { data, content } = ConfigMarkdown.parse(source)
  if (typeof data.name !== "string" || typeof data.description !== "string" || typeof data.metadata?.["display-name"] !== "string") {
    throw new Error("Invalid bundled skill document")
  }
  return Skill.Info.make({
    id: Skill.ID.make(data.name),
    name: Skill.Name.make(data.metadata["display-name"]),
    description: data.description,
    ...(data.metadata["slash"] === "true" ? { slash: true } : {}),
    location: AbsolutePath.make(`/builtin/${data.name}/SKILL.md`),
    content,
  })
})

export const [YCodingContent, ChatGPTConnectorsContent, BrowserUseContent, ComputerUseContent, ReportContent] = documents.map((skill) => skill.content)
export const YCodingDescription = documents[0]!.description!

export const Plugin = define({
  id: "ycoding.skill",
  effect: Effect.fn(function* (ctx) {
    const content = yield* reportContentWithDiagnostics()
    yield* ctx.skill.transform((draft) => {
      for (const skill of documents) {
        draft.source(Skill.EmbeddedSource.make({ type: "embedded", skill: skill.id === "report" ? { ...skill, content } : skill }))
      }
    })
  }),
})

const reportContentWithDiagnostics = Effect.fn("SkillPlugin.reportContentWithDiagnostics")(function* () {
  const plugins = yield* configuredPlugins().pipe(Effect.orElseSucceed(() => ["Unavailable: failed to inspect config"]))
  return [
    ReportContent,
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before publishing.",
    "",
    `- ycoding version: ${InstallationVersion}`,
    `- install/channel: ${InstallationChannel}`,
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    `- Terminal: ${terminal()}`,
    `- Shell: ${shell()}`,
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

const configuredPlugins = Effect.fn("SkillPlugin.configuredPlugins")(function* () {
  const config = yield* Config.Service
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  return yield* Effect.forEach(yield* config.entries(), (entry) => {
    if (entry.type === "document") {
      const directory = entry.path ? path.dirname(entry.path) : location.directory
      return Effect.succeed(
        (entry.info.plugins ?? []).map((item) => {
          const ref = typeof item === "string" ? { package: item } : item
          if (ref.package.startsWith("file://")) return fileURLToPath(ref.package)
          if (ref.package.startsWith("./") || ref.package.startsWith("../")) return path.resolve(directory, ref.package)
          return ref.package
        }),
      )
    }
    if (entry.type !== "directory") return Effect.succeed([])
    return fs
      .scan("{plugin,plugins}/*.{ts,js}", {
        cwd: entry.path,
        absolute: true,
        include: "file",
        dot: true,
        symlink: true,
      })
      .pipe(Effect.orElseSucceed(() => []))
  }).pipe(Effect.map((items) => items.flat().toSorted()))
})

function terminal() {
  return (
    [
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
