import { mock } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { nodeTarget } from "../../src/node/target"

const mode = process.argv[2]
let calls = 0
await mock.module("../../script/antigravity-build-env", () => ({ antigravityBuildDefinitions: () => ({}) }))
await mock.module("../../src/native-process", () => ({
  NativeProcess: {
    run: () =>
      Effect.sync(() => {
        calls++
      }),
  },
}))
await mock.module("../../src/services/meeting", () => ({
  connectControl: async () => async (input: { action: string }) => {
    if (input.action === "status") return { meeting: { status: "ready" } }
    return { url: "http://127.0.0.1:42617/synthetic" }
  },
}))
const { mainConfig } = await import("../../vite.node.config")
const config = mainConfig({
  version: "synthetic",
  channel: "local",
  models: "{}",
  assetHash: "synthetic",
  target: nodeTarget(process.platform, process.arch),
})
const filename = path.resolve(
  import.meta.dirname,
  "../../src/commands/handlers",
  mode === "meeting" ? "meeting.ts" : "serve-shared.ts",
)
let code = await readFile(filename, "utf8")
for (const plugin of config.plugins ?? []) {
  if (
    !plugin ||
    typeof plugin !== "object" ||
    !("name" in plugin) ||
    plugin.name !== "ycoding:native-only-meeting" ||
    !("transform" in plugin)
  )
    continue
  const hook = typeof plugin.transform === "function" ? plugin.transform : plugin.transform?.handler
  if (!hook) throw new Error("Node Meeting build binding has no transform")
  const transformed: unknown = await Reflect.apply(
    hook,
    {
      error: (message: string) => {
        throw new Error(message)
      },
    },
    [code, filename, {}],
  )
  if (typeof transformed === "string") code = transformed
  else if (
    transformed &&
    typeof transformed === "object" &&
    "code" in transformed &&
    typeof transformed.code === "string"
  )
    code = transformed.code
}
code = code.replace(
  /((?:from\s*|import\s*(?:\(\s*)?)["'])([^"']+)(["'])/g,
  (_match, before: string, specifier: string, after: string) => {
    const resolved = specifier.startsWith(".")
      ? pathToFileURL(path.resolve(path.dirname(filename), specifier + (path.extname(specifier) ? "" : ".ts"))).href
      : import.meta.resolve(specifier)
    return before + resolved + after
  },
)
const directory = await mkdtemp(path.join(tmpdir(), "ycoding-node-meeting-"))
try {
  const module = path.join(directory, "handler.mjs")
  await writeFile(module, new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(code))
  const handler:
    | typeof import("../../src/commands/handlers/meeting")
    | typeof import("../../src/commands/handlers/serve-shared") = await import(pathToFileURL(module).href)
  const operation =
    "default" in handler
      ? handler.default({
          directory: Option.none(),
          open: false,
          meet: Option.none(),
          title: Option.none(),
          speechProvider: Option.none(),
          speechModel: Option.none(),
          openaiProfile: Option.none(),
          status: false,
          catchup: false,
          ask: Option.none(),
          summarizeKnowledge: false,
          approveProposal: Option.none(),
          rejectProposal: Option.none(),
          confirm: false,
        })
      : handler.runServe({ meeting: true, service: false, stdio: true, hostname: Option.none(), port: Option.none() })
  const exit = await Effect.runPromiseExit(Effect.scoped(operation))
  console.log(
    JSON.stringify({
      failed: Exit.isFailure(exit),
      message: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
      calls,
    }),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
