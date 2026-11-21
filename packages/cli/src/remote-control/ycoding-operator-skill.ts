/// <reference path="../../../core/src/markdown.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { FrontendPaths } from "../paths"
import ycodingOperatorContent from "./ycoding-operator.md" with { type: "text" }

export const ycodingOperatorSkill = ycodingOperatorContent

export function ycodingDotsSkillsRoot(dataDirectory: string = FrontendPaths.Path.data) {
  return path.join(dataDirectory, "dots", "skills")
}

export async function ensureYcodingOperatorSkill(dataDirectory: string = FrontendPaths.Path.data) {
  const file = path.join(ycodingDotsSkillsRoot(dataDirectory), "ycoding-operator", "SKILL.md")
  const current = await readFile(file, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (current === ycodingOperatorSkill) return
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, ycodingOperatorSkill, "utf8")
}
