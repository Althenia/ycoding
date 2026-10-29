import { describe, expect, test } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Global } from "@ycoding-ai/core/global"
import { Integration } from "@ycoding-ai/core/integration"
import { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { Context, Effect, Layer, Scope } from "effect"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createCcaRpcAdapter } from "../src/remote-control/cca-executor-adapter"
import { createCcaRpcSession } from "../src/remote-control/cca-executor-rpc"
import { fixedScopeFor } from "./fixture/cca-scope"
import {
  createCcaTaskRuntime,
  CcaTaskRuntimeCloseError,
} from "../src/remote-control/cca-task-runtime"

const profile = "synthetic-profile"
const accountID = "synthetic-account"

function globalPaths(home: string): Global.Interface {
  return {
    home,
    data: path.join(home, "data"),
    cache: path.join(home, "cache"),
    config: path.join(home, "config"),
    state: path.join(home, "state"),
    tmp: path.join(home, "tmp"),
    bin: path.join(home, "bin"),
    log: path.join(home, "log"),
    repos: path.join(home, "repos"),
  }
}

async function seedCredential(paths: Global.Interface, databasePath: string) {
  const services = AppNodeBuilder.build(LayerNode.group([Credential.node]), [
    [Global.node, Global.layerWith(paths)],
    [Database.node, Database.configured({ path: databasePath })],
  ])
  const program = Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const context = yield* Layer.buildWithScope(services, scope)
      const credentials = Context.get(context, Credential.Service)
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        label: profile,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-headless"),
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 3_600_000,
          metadata: { accountID },
        }),
      })
      const resolved = yield* RemoteControlCredential.resolveStored(credentials, profile)
      if (resolved === undefined) return yield* Effect.die(new Error("synthetic credential did not resolve"))
      return resolved
    }),
  ).pipe(Effect.provide(NodeServices.layer))
  return Effect.runPromise(program)
}

describe("cca task runtime isolated graph", () => {
  test(
    "creates a durable Session and authorizes a real executor file read inside the root",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "cca-task-home-"))
      const root = await mkdtemp(path.join(os.tmpdir(), "cca-task-root-"))
      const paths = globalPaths(home)
      await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })))
      const databasePath = path.join(paths.data, "cca-runtime.sqlite")
      const target = path.join(root, "synthetic.txt")
      await writeFile(target, "synthetic-runtime-content", "utf8")

      let runtime: Awaited<ReturnType<typeof createCcaTaskRuntime>> | undefined
      const phases: string[] = []
      try {
        const resolved = await seedCredential(paths, databasePath)
        runtime = await createCcaTaskRuntime({
          root,
          global: paths,
          databasePath,
          credentialPin: {
            profile,
            accountID,
            accountHash: createHash("sha256").update(accountID).digest("hex"),
            credentialID: resolved.credentialID,
            accountGeneration: resolved.accountGeneration,
            key: resolved.key,
          },
          timeoutMs: 500,
          onPhase: (record) => {
            phases.push(`${record.phase}:${record.event}`)
          },
        })
        expect(runtime.sessionID).toStartWith("ses_")
        expect(runtime.location.directory).toBe(AbsolutePath.make(root))

        const adapter = createCcaRpcAdapter({ scopeFor: fixedScopeFor([root], runtime.authorization.authorize) })
        const session = createCcaRpcSession({ environmentInfo: adapter.environmentInfo, handler: adapter.handler })
        let requestID = 0
        const request = async (method: string, params?: unknown) => {
          const id = ++requestID
          const frames = await session.receive(new TextEncoder().encode(JSON.stringify({ id, method, params })))
          expect(frames).toHaveLength(1)
          const response = JSON.parse(new TextDecoder().decode(frames[0]))
          expect(response.id).toBe(id)
          return response
        }
        try {
          const initialized = await request("initialize", { clientName: "synthetic-runtime", resumeSessionId: null })
          expect(initialized.error).toBeUndefined()
          expect(typeof initialized.result.sessionId).toBe("string")
          await session.receive(new TextEncoder().encode(JSON.stringify({ method: "initialized" })))
          const result = await request("fs/readFile", { path: pathToFileURL(target).href, followSymlinks: null, sandbox: null })
          expect(result.error).toBeUndefined()
          expect(Buffer.from(result.result.dataBase64, "base64").toString("utf8")).toBe("synthetic-runtime-content")

          const startResponse = await request(
            "process/start",
            {
              processId: "synthetic-process",
              argv: ["/bin/echo", "synthetic-process-output"],
              cwd: pathToFileURL(root).href,
              env: {},
              tty: false,
              pipeStdin: false,
              enforceManagedNetwork: false,
              arg0: null,
              envPolicy: { inherit: "all", ignoreDefaultExcludes: false, exclude: [], includeOnly: [], set: {} },
              sandbox: null,
            },
          )
          expect(startResponse.error).toBeUndefined()
          expect(startResponse.result).toEqual({ processId: "synthetic-process", sandboxType: "none" })
          let processOutput = ""
          let exited = false
          let afterSeq: number | null = null
          for (let attempt = 0; attempt < 20 && !exited; attempt++) {
            const response = await request(
              "process/read",
              { processId: "synthetic-process", afterSeq, maxBytes: null, waitMs: 50 },
            )
            expect(response.error).toBeUndefined()
            const read = response.result
            processOutput += read.chunks
              .filter((chunk: { stream: string }) => chunk.stream === "stdout")
              .map((chunk: { chunk: string }) => Buffer.from(chunk.chunk, "base64").toString("utf8"))
              .join("")
            afterSeq = read.nextSeq - 1
            exited = read.exited
            if (exited) expect(read.exitCode).toBe(0)
          }
          expect(exited).toBe(true)
          expect(processOutput).toContain("synthetic-process-output")
          expect(processOutput).toBe("synthetic-process-output\n")

          const envTarget = path.join(root, ".env")
          await writeFile(envTarget, "SYNTHETIC=fixture", "utf8")
          const started = Date.now()
          const denied = await request("fs/readFile", { path: pathToFileURL(envTarget).href, followSymlinks: null, sandbox: null })
          const elapsedMs = Date.now() - started
          expect(denied.error.code).toBe(-32001)
          expect(denied.result).toBeUndefined()
          expect(elapsedMs).toBeGreaterThanOrEqual(400)
          expect(elapsedMs).toBeLessThan(2_000)

          const afterTimeout = await request("fs/readFile", { path: pathToFileURL(target).href, followSymlinks: null, sandbox: null })
          expect(afterTimeout.error).toBeUndefined()
          expect(Buffer.from(afterTimeout.result.dataBase64, "base64").toString("utf8")).toBe(
            "synthetic-runtime-content",
          )
        } finally {
          try {
            await session.close()
          } finally {
            await adapter.close()
          }
        }
        expect(await readFile(target, "utf8")).toBe("synthetic-runtime-content")
        await runtime.close()
        runtime = undefined
        expect(phases).toEqual([
          "authorization-release:started",
          "authorization-release:completed",
          "runtime-graph-close:started",
          "runtime-graph-close:completed",
        ])
      } finally {
        await runtime?.close().catch(() => {})
        await rm(home, { recursive: true, force: true })
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test(
    "runtime close finishes authorization and graph teardown when its observer throws",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "cca-task-home-"))
      const root = await mkdtemp(path.join(os.tmpdir(), "cca-task-root-"))
      const paths = globalPaths(home)
      await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })))
      const databasePath = path.join(paths.data, "cca-runtime-observer.sqlite")

      let runtime: Awaited<ReturnType<typeof createCcaTaskRuntime>> | undefined
      const phases: string[] = []
      try {
        const resolved = await seedCredential(paths, databasePath)
        runtime = await createCcaTaskRuntime({
          root,
          global: paths,
          databasePath,
          credentialPin: {
            profile,
            accountID,
            accountHash: createHash("sha256").update(accountID).digest("hex"),
            credentialID: resolved.credentialID,
            accountGeneration: resolved.accountGeneration,
            key: resolved.key,
          },
          timeoutMs: 500,
          onPhase: (record) => {
            phases.push(`${record.phase}:${record.event}`)
            if (record.phase === "authorization-release" && record.event === "started") {
              throw new Error("runtime-observer-secret")
            }
          },
        })

        const error = await runtime.close().catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(CcaTaskRuntimeCloseError)
        expect((error as Error).message).not.toContain("runtime-observer-secret")
        expect(phases).toEqual([
          "authorization-release:started",
          "authorization-release:completed",
          "runtime-graph-close:started",
          "runtime-graph-close:completed",
        ])
        const secondError = await runtime.close().catch((caught: unknown) => caught)
        expect(secondError).toBeInstanceOf(CcaTaskRuntimeCloseError)
        expect(phases).toHaveLength(4)
        runtime = undefined
      } finally {
        await runtime?.close().catch(() => {})
        await rm(home, { recursive: true, force: true })
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
