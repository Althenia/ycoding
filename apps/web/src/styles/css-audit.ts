export type CssAuditFinding = {
  readonly level: "error" | "warning" | "info"
  readonly code: string
  readonly file: string
  readonly line: number
  readonly message: string
}

export type RawCssAudit = {
  readonly files: number
  readonly error: number
  readonly warning: number
  readonly info: number
  readonly findings: readonly CssAuditFinding[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function validateRawCssAudit(value: unknown): asserts value is RawCssAudit {
  if (!isRecord(value) || !Array.isArray(value.findings)) throw new Error("Invalid CSS audit result")
  const counts = { error: 0, warning: 0, info: 0 }
  for (const candidate of value.findings) {
    const finding: unknown = candidate
    if (!isRecord(finding) || !(finding.level === "error" || finding.level === "warning" || finding.level === "info") || typeof finding.code !== "string" || typeof finding.file !== "string" || typeof finding.line !== "number" || !Number.isInteger(finding.line) || typeof finding.message !== "string") throw new Error("Invalid CSS audit finding")
    counts[finding.level] += 1
  }
  if (!("files" in value) || !Number.isInteger(value.files) || Number(value.files) < 0) throw new Error("Invalid CSS audit file count")
  for (const level of ["error", "warning", "info"] as const) {
    if (value[level] !== counts[level]) throw new Error(`CSS audit ${level} count does not match findings`)
  }
}

export function cssAuditExitCode(raw: RawCssAudit): 0 | 1 {
  validateRawCssAudit(raw)
  return raw.error === 0 && raw.warning === 0 ? 0 : 1
}
