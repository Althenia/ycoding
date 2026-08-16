#!/usr/bin/env bun

import path from "node:path"
import { classifyLegacyReference, type LegacyDisposition } from "./ycoding-rebrand"

export type BrandFile = {
  path: string
  content: string
}

export type BrandResidual = {
  path: string
  line: number
  value: string
  disposition: LegacyDisposition
}

const valuePatterns = [
  /@opencode-ai\/[A-Za-z0-9._/-]+/i,
  /\bOPENCODE_[A-Z0-9_]+\b/,
  /x-opencode-[a-z0-9-]+/i,
  /\.opencode(?:\/[A-Za-z0-9._/-]+)?/i,
  /\bopencode\.jsonc?\b/i,
  /\bOpenCode(?:\s+[A-Z][A-Za-z0-9.-]*)*/,
  /\bopencode\b/i,
]

export function scanBrandResiduals(files: BrandFile[]): BrandResidual[] {
  const findings: BrandResidual[] = []

  for (const file of files) {
    if (/opencode/i.test(file.path)) {
      const disposition = classifyLegacyReference(file.path, file.path) ?? "replace"
      if (disposition === "replace") findings.push({ path: file.path, line: 0, value: file.path, disposition })
    }

    const lines = file.content.split("\n")
    lines.forEach((line, index) => {
      if (!/opencode/i.test(line)) return
      const disposition = classifyLegacyReference(file.path, line) ?? "replace"
      if (disposition !== "replace") return
      const value = valuePatterns.map((pattern) => pattern.exec(line)?.[0]).find(Boolean) ?? line.trim()
      findings.push({ path: file.path, line: index + 1, value, disposition })
    })
  }

  return findings
}

async function trackedTextFiles(root: string): Promise<BrandFile[]> {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || "git ls-files failed")
  const paths = result.stdout.toString().split("\0").filter(Boolean)
  const files: BrandFile[] = []

  for (const relative of paths) {
    const file = Bun.file(path.join(root, relative))
    const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer())
    if (bytes.includes(0)) continue
    files.push({ path: relative, content: await file.text() })
  }
  return files
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  const findings = scanBrandResiduals(await trackedTextFiles(root))
  if (!findings.length) {
    console.log("YCoding brand residual check passed")
    return
  }

  console.error(`Found ${findings.length} unapproved OpenCode references:`)
  for (const finding of findings.slice(0, 200)) console.error(`${finding.path}:${finding.line}: ${finding.value}`)
  if (findings.length > 200) console.error(`… ${findings.length - 200} more`)
  process.exit(1)
}

if (import.meta.main) await main()
