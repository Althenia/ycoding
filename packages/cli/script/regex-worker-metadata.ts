import { createHash } from "node:crypto"
import { regexProcessSource } from "../../codemode/src/internal/regex-process"

export function metadata() {
  return {
    sha256: createHash("sha256").update(regexProcessSource).digest("hex"),
    byteLength: Buffer.byteLength(regexProcessSource),
  }
}

if (import.meta.main) {
  const recipe = metadata()
  process.stdout.write(`${recipe.sha256}\n${recipe.byteLength}\n`)
}
