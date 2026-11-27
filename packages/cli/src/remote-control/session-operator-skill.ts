/// <reference path="../../../core/src/markdown.d.ts" />

import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { FrontendPaths } from "../paths"
import sessionOperatorContent from "./session-operator.md" with { type: "text" }

export const sessionOperatorSkill = sessionOperatorContent

export function ycodingDotsSkillsRoot(dataDirectory: string = FrontendPaths.Path.data) {
  return path.join(dataDirectory, "dots", "skills")
}

const replacedDirectory = "ycoding-operator"

async function removeReplacedSkill(root: string) {
  await rm(path.join(root, replacedDirectory, "SKILL.md"), { force: true })
  await rmdir(path.join(root, replacedDirectory)).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) return
    throw error
  })
}

export async function ensureSessionOperatorSkill(dataDirectory: string = FrontendPaths.Path.data) {
  const root = ycodingDotsSkillsRoot(dataDirectory)
  const file = path.join(root, "session-operator", "SKILL.md")
  const current = await readFile(file, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  await removeReplacedSkill(root)
  if (current === sessionOperatorSkill) return
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, sessionOperatorSkill, "utf8")
}
