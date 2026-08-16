export * as ProjectArtifactValidation from "./validation"

import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"

const encoder = new TextEncoder()
const idPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const windowsReserved = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
const absolutePath = /(?:^|[\s=("'`:])(\/(?!\/)[^\s)]+)/gm
const jsxImportSourcePragma = /^`\/\*\*[ \t]+@jsxImportSource[ \t]+(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*[ \t]+\*\/`/
const unsafe = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|password|passwd|credential|secret)\s*[:=]/i,
  /\bclientSecret\s*[:=]/,
  /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bsk_[A-Za-z0-9_-]{8,}\b/,
  /\b(?:ghp_|github_pat_|npm_|hf_|sk-ant-api\d*-)[A-Za-z0-9_-]{16,}\b/i,
  /\b(?:glpat-|xox[baprs]-|pypi-)[A-Za-z0-9_-]{16,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIzaSy[A-Za-z0-9_-]{30,}\b/,
  /(?:https?|file):/i,
  /(?:^|[\s=("'`:])\\\\[^\s]+/m,
  /(?:^|[\s=("'`:])[A-Za-z]:[\\/][^\s]+/m,
  /(?:^|[\s=("'`:])~(?:[\\/]|\b)/m,
  /(?:^|[\s=:("'`\\/])\.\.(?:[\\/]|$)/m,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /<!--[\s\S]*?-->|<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*?)?\s*\/?>/i,
  /!?\[[^\]]*\]\([^)]*\)/,
  /<\|(?:system|developer|assistant|user)\|>/i,
  /\b(?:system|developer)\s+(?:message|prompt|instructions?)\b/i,
  /\b(?:override|bypass|ignore|disable)\b[^\n]{0,80}\b(?:permission|policy|prompt|instruction|safety)\b/i,
  /\bimport\s*\(/i,
  /^\s*import\s+(?:["']|[\w$*{},\s]+\s+from\s+|[\w.]+(?:\s+as\s+\w+)?\s*$|[\w$]+\s*=\s*require\s*\()/im,
  /^\s*from\s+[\w.]+\s+import\s+/im,
  /^\s*export\s+[^\n]+\s+from\s+["']/im,
  /\brequire\s*\(/i,
  /^\s*#!/m,
  /^\s*(?:bun|npm|pnpm|yarn)\s+(?:add|install)\b/im,
  /^\s*(?:pip\s+install|cargo\s+add|go\s+get)\b/im,
  /^\s*(?:scripts|dependencies|devDependencies|peerDependencies|optionalDependencies)\s*:/im,
  /\bcurl\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i,
  /\bchmod\s+\+x\b/i,
  /\b(?:package\.json|bun\.lock|package-lock\.json|pnpm-lock|yarn\.lock|postinstall|preinstall|github\/workflows|gitlab-ci|dockerfile)\b/i,
]

export interface Input {
  readonly id: unknown
  readonly definition: unknown
  readonly existingIDs?: ReadonlyArray<string>
}

export function validateAutomatic(input: Input): ProjectArtifact.ValidationError[] {
  if (typeof input.definition !== "object" || input.definition === null || !("kind" in input.definition)) {
    return [error("InvalidArtifact", "definition")]
  }
  const kind = input.definition.kind
  if (kind === "plugin" || kind === "workflow") return [error("UnsupportedKind", "kind")]
  if (kind !== "skill" && kind !== "command" && kind !== "agent") return [error("UnsupportedKind", "kind")]

  const errors = validateID(input.id, input.existingIDs)
  if (kind === "skill") return [...errors, ...validateSkill(input.definition)]
  if (kind === "command") return [...errors, ...validateCommand(input.definition)]
  return [...errors, ...validateAgent(input.definition)]
}

export function validateID(id: unknown, existingIDs: ReadonlyArray<string> = []): ProjectArtifact.ValidationError[] {
  if (typeof id !== "string" || !idPattern.test(id) || windowsReserved.test(id)) return [error("InvalidArtifact", "id")]
  if (existingIDs.some((item) => item.normalize("NFKC").toLowerCase() === id.normalize("NFKC").toLowerCase())) {
    return [error("ArtifactCollision", "id")]
  }
  return []
}

export function validateText(value: unknown, field: string, maximumBytes: number) {
  if (typeof value !== "string" || value.length === 0) return [error("InvalidArtifact", field)]
  if (encoder.encode(value).byteLength > maximumBytes) return [error("ContentTooLarge", field)]
  if (hasInvalidCharacters(value) || hasAbsolutePath(value) || unsafe.some((pattern) => pattern.test(value))) {
    return [error("UnsafeContent", field)]
  }
  return []
}

export function validateRendered(content: string): ProjectArtifact.ValidationError[] {
  if (encoder.encode(content).byteLength > 32 * 1_024) return [error("ContentTooLarge", "renderedContent")]
  return []
}

function validateSkill(value: Record<string, unknown>) {
  if (Object.keys(value).some((key) => !["kind", "name", "description", "content"].includes(key))) {
    return [error("InvalidArtifact", "definition")]
  }
  return [
    ...validateBoundedText(value.name, "name", 128, 512),
    ...validateBoundedText(value.description, "description", 512, 2_048),
    ...validateText(value.content, "content", 24 * 1_024),
  ]
}

function validateCommand(value: Record<string, unknown>) {
  if (
    value.subtask !== false ||
    Object.keys(value).some((key) => !["kind", "name", "description", "template", "subtask"].includes(key))
  ) {
    return [error("InvalidArtifact", "definition")]
  }
  return [
    ...validateBoundedText(value.name, "name", 128, 512),
    ...validateBoundedText(value.description, "description", 512, 2_048),
    ...validateText(value.template, "template", 16 * 1_024),
  ]
}

function validateAgent(value: Record<string, unknown>) {
  if (
    value.mode !== "subagent" ||
    !Array.isArray(value.permissions) ||
    Object.keys(value).some((key) => !["kind", "name", "description", "system", "mode", "permissions"].includes(key))
  ) {
    return [error("InvalidArtifact", "definition")]
  }
  return [
    ...validateBoundedText(value.name, "name", 128, 512),
    ...validateBoundedText(value.description, "description", 512, 2_048),
    ...validateText(value.system, "system", 16 * 1_024),
  ]
}

function validateBoundedText(value: unknown, field: string, maximumScalars: number, maximumBytes: number) {
  const errors = validateText(value, field, maximumBytes)
  if (errors.length > 0 || typeof value !== "string") return errors
  if ([...value].length > maximumScalars) return [error("ContentTooLarge", field)]
  return []
}

function hasInvalidCharacters(value: string) {
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0
    if (
      (code < 32 && code !== 9 && code !== 10) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return true
  }
  return false
}

function hasAbsolutePath(value: string) {
  return [...value.matchAll(absolutePath)].some((match) => {
    const path = match[1] ?? ""
    const start = (match.index ?? 0) + match[0].lastIndexOf(path)
    // Exempt only the complete safe pragma, not every /* opener: skipping all openers lets /*/Users/... bypass this scan.
    return start === 0 || !jsxImportSourcePragma.test(value.slice(start - 1))
  })
}

function error(code: ProjectArtifact.ErrorCode, field: string): ProjectArtifact.ValidationError {
  return { code, field, message: "Project Artifact input was rejected" }
}
