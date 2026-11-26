import { spawn } from "node:child_process"
import path from "node:path"
import { Effect, Schema } from "effect"
import { sourceRuntimeExecutable } from "../../../script/ycoding-runtime-source"

const limit = 16 * 1024 * 1024
const repository = path.resolve(import.meta.dirname, "../../..")
let executable: Promise<string> | undefined

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), code: Schema.String }),
])
const decode = Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Reply)))

export function nativeResource(input: Record<string, unknown>) {
  return Effect.tryPromise({
    try: async (signal) => {
      const request = Buffer.from(JSON.stringify(input))
      if (request.byteLength > limit) return { ok: false as const, code: "TooLarge" }
      const command = await (executable ??= sourceRuntimeExecutable(repository).catch((error: unknown) => {
        executable = undefined
        throw error
      }))
      signal.throwIfAborted()
      const child = spawn(command, ["--ycoding-internal-resources-v1"], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
        stdio: ["pipe", "pipe", "ignore"],
        env: {},
        windowsHide: true,
      })
      const status = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") child.kill()
      })
      child.stdin.end(request)
      const output = async () => {
        let size = 0
        const chunks: Buffer[] = []
        for await (const chunk of child.stdout) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          size += bytes.byteLength
          if (size > limit) {
            child.kill()
            throw new Error("Native resource response exceeds its byte limit")
          }
          chunks.push(bytes)
        }
        return Buffer.concat(chunks, size).toString("utf8")
      }
      const [code, result] = await Promise.all([status, output()])
      if (code !== 0) throw new Error("Native resource request did not complete")
      return decode(result)
    },
    catch: (cause) => new Error("Native resource runtime is unavailable", { cause }),
  })
}
