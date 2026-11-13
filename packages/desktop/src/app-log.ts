import fs from "node:fs/promises"
import path from "node:path"

const secretText = /(password|token|authorization|secret)(["']?\s*[:=]\s*["']?)[^\s"',}]+|(Basic|Bearer)\s+\S+/gi

export function redactSecrets(text: string): string {
  return text.replace(secretText, (_, key, separator, scheme) => scheme ? `${scheme} [REDACTED]` : `${key}${separator}[REDACTED]`)
}

export function describeError(error: unknown): string {
  const parts: string[] = []
  for (let current = error, depth = 0; depth < 4 && current !== undefined && current !== null; depth++, current = current instanceof Error ? current.cause : undefined)
    parts.push(current instanceof Error ? current.message : String(current))
  return redactSecrets(parts.join(": "))
}

export async function appendAppLog(file: string, line: string, limit = 262_144): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const size = await fs.stat(file).then((stat) => stat.size, () => 0)
    if (size > limit) await fs.rename(file, file + ".1")
    await fs.appendFile(file, `${new Date().toISOString()} ${line.replace(/\r?\n/g, " ")}\n`, { mode: 0o600 })
  } catch { return }
}
