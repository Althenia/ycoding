import { createHash } from "crypto"

export namespace Hash {
  export function fast(input: string | Buffer): string {
    return createHash("sha1").update(input).digest("hex")
  }

  export function sha256(input: string | Buffer): string {
    return createHash("sha256").update(input).digest("hex")
  }

  export function json(input: unknown): string {
    const text = JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value)
    if (text === undefined) throw new TypeError("Operation must be JSON serializable")
    return sha256(text)
  }
}
