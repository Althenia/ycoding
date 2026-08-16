#!/usr/bin/env bun

import path from "node:path"

export type LegacyDisposition = "replace" | "compatibility" | "upstream" | "external"

const legacyPattern =
  /@opencode-ai|\bOpenCode\b|\bOPENCODE_[A-Z0-9_]+\b|x-opencode-|\.opencode(?:\b|\/)|\bopencode(?:\.jsonc?|\b)/i

const upstreamPaths = [/^docs\/upstream-differences\.md$/, /^docs\/superpowers\/plans\//, /^patches\//]

const compatibilityPaths = [
  /^docs\/ycoding-migration\.md$/,
  /^script\/ycoding-(?:rebrand|residuals)(?:\.test)?\.ts$/,
]

const externalPaths = [
  /^packages\/core\/src\/plugin\/provider\/opencode\.ts$/,
  /^packages\/core\/test\/plugin\/provider-opencode\.test\.ts$/,
  /^packages\/cli\/script\/models-dev\.snapshot\.json$/,
  /^packages\/core\/test\/plugin\/fixtures\/models-dev(?:-reasoning)?\.json$/,
  /^packages\/ui\/src\/assets\/icons\/provider\/opencode(?:-go)?\.svg$/,
]

const externalLinePattern = new RegExp(
  [
    "opencode-go",
    "OpencodePlugin",
    "provider/opencode",
    "console\\.opencode\\.ai",
    "opencode\\.ai/zen",
    "opencode\\.ai/go",
    "OPENCODE_API_KEY",
    "OpenCode Console",
    "OpenCode Zen",
    "OpenCode Go",
    "ProviderV2\\.ID\\.opencode",
    'Integration\\.ID\\.make\\(\\"opencode\\"\\)',
    "integrationID\\s*[:=].*opencode",
    "providerID\\s*[:=].*opencode",
    "model\\s*:\\s*opencode/",
    'clientID\\s*=\\s*\\"opencode-cli\\"',
  ].join("|"),
)

const protectedUrls = [
  /https?:\/\/(?:www\.)?opencode\.ai[^\s)\]}>"']*/gi,
  /https?:\/\/console\.opencode\.ai[^\s)\]}>"']*/gi,
  /https?:\/\/github\.com\/anomalyco\/opencode[^\s)\]}>"']*/gi,
]

const pathExternal = [
  /^packages\/core\/src\/plugin\/provider\/opencode\.ts$/,
  /^packages\/core\/test\/plugin\/provider-opencode\.test\.ts$/,
  /^packages\/ui\/src\/assets\/icons\/provider\/opencode(?:-go)?\.svg$/,
]

export function classifyLegacyReference(file: string, value: string): LegacyDisposition | undefined {
  const normalized = normalize(file)
  if (compatibilityPaths.some((pattern) => pattern.test(normalized))) return "compatibility"
  if (upstreamPaths.some((pattern) => pattern.test(normalized))) return "upstream"
  if (externalPaths.some((pattern) => pattern.test(normalized))) return "external"
  if (externalLinePattern.test(value) || value.includes("YCODING_EXTERNAL_OPENCODE")) return "external"
  if (!legacyPattern.test(value) && !/opencode/i.test(normalized)) return undefined
  if (value.includes("YCODING_LEGACY_COMPAT")) return "compatibility"
  if (value.includes("YCODING_UPSTREAM")) return "upstream"
  if (pathExternal.some((pattern) => pattern.test(normalized)) && value === normalized) return "external"
  return "replace"
}

export function rewriteBrandText(file: string, input: string): string {
  return input
    .split("\n")
    .map((line) => rewriteLine(file, line))
    .join("\n")
}

function rewriteLine(file: string, line: string): string {
  const disposition = classifyLegacyReference(file, line)
  if (disposition === "compatibility" || disposition === "upstream" || disposition === "external") return line

  const saved: string[] = []
  let output = line
  for (const pattern of protectedUrls) {
    output = output.replace(pattern, (value) => {
      const index = saved.push(value) - 1
      return `__YCODING_PROTECTED_URL_${index}__`
    })
  }

  output = output
    .replaceAll("@opencode-ai", "@ycoding-ai")
    .replaceAll("x-opencode-", "x-ycoding-")
    .replace(/\bOPENCODE_([A-Z0-9_]+)\b/g, "YCODING_$1")
    .replaceAll(".opencode", ".ycoding")
    .replace(/\bopencode\.jsonc\b/g, "ycoding.jsonc")
    .replace(/\bopencode\.json\b/g, "ycoding.json")
    .replaceAll("OpenCode", "YCoding")
    .replace(/\bopencode\b/g, "ycoding")

  return output.replace(/__YCODING_PROTECTED_URL_(\d+)__/g, (_, index: string) => saved[Number(index)] ?? "")
}

export function rewriteBrandPath(file: string): string {
  const normalized = normalize(file)
  const disposition = classifyLegacyReference(normalized, normalized)
  if (disposition === "compatibility" || disposition === "upstream" || disposition === "external") return normalized
  return normalized
    .replace(/(^|\/)\.opencode(?=\/|$)/g, "$1.ycoding")
    .replace(/opencode/gi, (value) => matchCase(value, "ycoding"))
}

function matchCase(source: string, target: string) {
  if (source === source.toUpperCase()) return target.toUpperCase()
  if (source[0] === source[0]?.toUpperCase()) return target[0]!.toUpperCase() + target.slice(1)
  return target
}

function normalize(file: string) {
  return file.split(path.sep).join("/").replace(/^\.\//, "")
}

async function trackedFiles(root: string): Promise<string[]> {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || "git ls-files failed")
  return result.stdout.toString().split("\0").filter(Boolean)
}

async function isTextFile(file: string) {
  const bytes = new Uint8Array(await Bun.file(file).slice(0, 8192).arrayBuffer())
  return !bytes.includes(0)
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  const write = process.argv.includes("--write")
  const files = await trackedFiles(root)
  const edits: string[] = []
  const moves: Array<{ from: string; to: string }> = []

  for (const relative of files) {
    const absolute = path.join(root, relative)
    if (await isTextFile(absolute)) {
      const before = await Bun.file(absolute).text()
      const after = rewriteBrandText(relative, before)
      if (after !== before) {
        edits.push(relative)
        if (write) await Bun.write(absolute, after)
      }
    }
    const target = rewriteBrandPath(relative)
    if (target !== relative) moves.push({ from: relative, to: target })
  }

  if (write) {
    moves.sort((a, b) => b.from.length - a.from.length)
    for (const move of moves) {
      const parent = path.dirname(path.join(root, move.to))
      await Bun.$`mkdir -p ${parent}`.quiet()
      const result = Bun.spawnSync(["git", "mv", move.from, move.to], { cwd: root })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `git mv failed: ${move.from}`)
    }
  }

  console.log(`${write ? "Applied" : "Planned"} ${edits.length} text edits and ${moves.length} path moves`)
  if (!write) {
    for (const file of edits.slice(0, 50)) console.log(`edit ${file}`)
    for (const move of moves.slice(0, 50)) console.log(`move ${move.from} -> ${move.to}`)
    if (edits.length + moves.length > 100) console.log("…")
  }
}

if (import.meta.main) await main()
