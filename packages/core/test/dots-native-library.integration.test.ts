import { expect } from "bun:test"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { Effect } from "effect"
import { createCcaExecutor } from "../src/cca/executor"
import { CcaPolicy } from "../src/cca/policy"
import { dotsExecutorHostWith } from "./fixture/dots-executor"
import { reviewLayer } from "./fixture/review"
import { testEffect } from "./lib/effect"

const it = testEffect(reviewLayer())

for (const retirement of ["off", "scope-close", "process-exit"] as const) it.live(`a prepared private process reservation is revoked on actual ${retirement}`, () => Effect.gen(function* () {
  const ready = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let reserved = false
  let nativeWrites = 0
  let releases = 0
  const f = yield* dotsExecutorHostWith({ library: (owner) => Effect.succeed({ open: async () => {
    let grant: Awaited<ReturnType<typeof owner.authorize>> | undefined
    return {
      tools: ["ycoding_library.prepare_uploads", "ycoding_library.finalize_uploads"].map((name) => ({ name, inputSchema: { type: "object" as const, properties: {} } })),
      check: owner.current,
      call: async (name) => {
        if (name === "ycoding_library.prepare_uploads") {
          grant = await owner.authorize({ action: "chatgpt_library_upload", guardrailAction: "mcp_execute", resources: ["connector_openai_library"] }).catch((error: unknown) => { ready.reject(error); throw error })
          reserved = true
          return { plan_id: "synthetic-plan" }
        }
        nativeWrites++
        return { uploaded: true }
      },
      close: async () => { reserved = false; await grant?.release(); releases++; released.resolve() },
    }
  } }) })
  const scope = yield* Effect.promise(() => f.host.threadScope({ environmentID: "environment", threadID: `composed-${retirement}`, cwd: f.home }))
  let child: ChildProcess | undefined
  let capability: NodeJS.ProcessEnv | undefined
  const executor = createCcaExecutor({ scopeFor: async () => scope, spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
    capability = options.env
    child = spawn(command, args, options)
    child.stdout?.on("data", (data: Buffer) => { if (data.toString().includes("prepared")) ready.resolve() })
    child.once("exit", () => ready.reject(new Error("Synthetic Library child exited before preparation")))
    return child
  }) as typeof spawn })
  yield* Effect.addFinalizer(() => Effect.promise(() => executor.close()))
  const initialized = yield* Effect.promise(() => executor.initialize({ clientName: "synthetic-native-library" }, { signal: new AbortController().signal }))
  yield* Effect.promise(() => executor.startProcess({ processId: "same-process-label", pipeStdin: true, cwd: CcaPolicy.toPathUri(scope.directory), env: { CODEX_APPS_MCP_URL: "ycoding-library://process" }, argv: [process.execPath, "-e", `
    const response=await fetch(process.env.CODEX_APPS_MCP_URL,{method:'POST',headers:{authorization:process.env.CODEX_APPS_AUTHORIZATION,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ycoding_library.prepare_uploads',arguments:{}}})});
    const result=await response.json(); if(!result.result?.structuredContent?.plan_id) throw new Error('synthetic preparation refused');
    console.log('prepared'); process.stdin.resume();
  `] }, { sessionId: initialized.sessionId, signal: new AbortController().signal }))
  yield* Effect.promise(() => ready.promise).pipe(Effect.timeout("5 seconds"))
  expect(reserved).toBe(true)
  if (retirement === "off") yield* f.access.set({ enabled: false, expectedRevision: 1 })
  if (retirement === "scope-close") yield* Effect.promise(() => scope.close())
  if (retirement === "process-exit") child!.stdin!.end()
  yield* Effect.promise(() => released.promise).pipe(Effect.timeout("5 seconds"))
  expect(reserved).toBe(false)
  const rejected = yield* Effect.promise(() => fetch(capability!.CODEX_APPS_MCP_URL!, { method: "POST", headers: { authorization: capability!.CODEX_APPS_AUTHORIZATION!, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ycoding_library.finalize_uploads", arguments: { plan_id: "synthetic-plan" } } }) }))
  expect(rejected.status).toBe(401)
  expect(nativeWrites).toBe(0)
  expect(releases).toBe(1)
  if (retirement !== "process-exit") { expect(child!.exitCode).toBeNull(); child!.stdin!.end() }
  yield* Effect.promise(() => scope.close())
}).pipe(Effect.scoped))
