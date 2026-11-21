import { PluginHost } from "./host"
import { PluginLoader } from "./loader"

// Frames own stdout. Plugin code that writes to stdout or the console is redirected to stderr,
// which the runtime drains and discards.
export async function run() {
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  process.stdout.write = stderr
  for (const method of ["log", "info", "debug", "warn"] as const)
    console[method] = (...values: unknown[]) => void stderr(`${values.map(String).join(" ")}\n`)
  const status = await PluginHost.serve(
    {
      input: process.stdin as AsyncIterable<Uint8Array>,
      write: (bytes) =>
        new Promise<void>((resolve, reject) => {
          stdout(bytes, (error) => (error ? reject(error) : resolve()))
        }),
    },
    PluginLoader.load,
  )
  process.exit(status)
}

if (import.meta.main) await run()
