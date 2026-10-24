export * as TemporaryPath from "./temporary-path"

import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export function canonical(input: string, depth = 0): string | undefined {
  if (!path.isAbsolute(input) || depth > 40) return undefined
  const suffix: string[] = []
  let ancestor = input
  for (;;) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        const target = readlinkSync(ancestor)
        const resolved = canonical(path.isAbsolute(target) ? target : `${path.dirname(ancestor)}${path.sep}${target}`, depth + 1)
        return resolved === undefined ? undefined : canonical(`${resolved}${path.sep}${suffix.join(path.sep)}`, depth + 1)
      }
      return path.resolve(realpathSync.native(ancestor), ...suffix)
    } catch (error) {
      if (!missing(error)) return undefined
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return undefined
    suffix.unshift(path.basename(ancestor))
    ancestor = parent
  }
}

export function contains(input: string, temporaryDirectory = process.env.TMPDIR ?? os.tmpdir()) {
  if (!lexicallyContains(input, temporaryDirectory)) return false
  const target = canonical(input)
  if (target === undefined) return false
  return roots(temporaryDirectory).some((root) => {
    const resolved = canonical(root)
    return resolved !== undefined && inside(resolved, target)
  })
}

export function lexicallyContains(input: string, temporaryDirectory = process.env.TMPDIR ?? os.tmpdir()) {
  return path.isAbsolute(input) && roots(temporaryDirectory).some((root) => inside(path.resolve(root), path.resolve(input)))
}

function roots(temporaryDirectory: string) {
  return [temporaryDirectory, "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"]
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function missing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
