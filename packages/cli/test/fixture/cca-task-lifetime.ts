import { createCcaExecutor } from "@ycoding-ai/core/cca/executor"
import type { CcaTaskRuntime } from "../../src/remote-control/cca-task-runtime"
import { createHash } from "node:crypto"
import { closeSync, writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { WebSocket, type NodeWebSocket } from "ws"
import { acceptCcaNoiseHandshake, createCcaNoiseIdentity } from "../../src/remote-control/cca-noise"
import { ccaProofResourceSnapshot } from "../../src/remote-control/cca-proof-lifecycle"
import { runCcaTaskProof } from "../../src/remote-control/cca-task-proof"
import { fixedScopeFor } from "./cca-scope"

const accountID = "synthetic-lifetime-account"
const profile = "synthetic-lifetime-profile"

function record(event: string, fields: Record<string, unknown> = {}) {
  const bytes = Buffer.from(JSON.stringify({ event, ...fields }) + "\n")
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(4, bytes, offset)
    if (written < 1) throw new Error("Lifetime diagnostic pipe did not accept bytes")
    offset += written
  }
}

async function isolatedRuntime(root: string, home: string): Promise<CcaTaskRuntime> {
  const [platform, credential, database, builder, layerNode, global, integration, remoteCredential, effect, taskRuntime] =
    await Promise.all([
      import("@effect/platform-node"),
      import("@ycoding-ai/core/credential"),
      import("@ycoding-ai/core/database/database"),
      import("@ycoding-ai/core/effect/app-node-builder"),
      import("@ycoding-ai/core/effect/layer-node"),
      import("@ycoding-ai/core/global"),
      import("@ycoding-ai/core/integration"),
      import("@ycoding-ai/core/remote-control/credential"),
      import("effect"),
      import("../../src/remote-control/cca-task-runtime"),
    ])
  const paths = {
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
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })))
  const databasePath = path.join(paths.data, "synthetic.sqlite")
  const services = builder.AppNodeBuilder.build(layerNode.LayerNode.group([credential.Credential.node]), [
    [global.Global.node, global.Global.layerWith(paths)],
    [database.Database.node, database.Database.configured({ path: databasePath })],
  ])
  const resolved = await effect.Effect.runPromise(effect.Effect.scoped(effect.Effect.gen(function* () {
    const scope = yield* effect.Scope.Scope
    const context = yield* effect.Layer.buildWithScope(services, scope)
    const credentials = effect.Context.get(context, credential.Credential.Service)
    yield* credentials.create({
      integrationID: integration.Integration.ID.make("openai"),
      label: profile,
      value: credential.Credential.OAuth.make({
        type: "oauth",
        methodID: integration.Integration.MethodID.make("chatgpt-headless"),
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 3_600_000,
        metadata: { accountID },
      }),
    })
    const value = yield* remoteCredential.RemoteControlCredential.resolveStored(credentials, profile)
    if (value === undefined) return yield* effect.Effect.die(new Error("Synthetic credential unavailable"))
    return value
  })).pipe(effect.Effect.provide(platform.NodeServices.layer)))
  return taskRuntime.createCcaTaskRuntime({
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
  })
}

async function main() {
  const [mode, portText, root, home] = process.argv.slice(2)
  const port = Number(portText)
  if ((mode !== "crypto" && mode !== "runtime") || !root || !home || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid lifetime fixture arguments")
  }
  const runtime = mode === "runtime" ? await isolatedRuntime(root, home) : undefined
  let acquired = 0
  let released = 0
  const executor = createCcaExecutor({
    baseEnv: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home },
    scopeFor: fixedScopeFor([root], async (input) => {
      const grant = runtime ? await runtime.authorization.authorize(input) : { release: async () => {} }
      acquired++
      return { release: async () => { await grant.release(); released++ } }
    }),
  })
  let close = () => executor.close()
  if (runtime) {
    const { composeCcaTaskCleanup } = await import("../../src/remote-control/cca-task-runtime")
    close = composeCcaTaskCleanup({ closeExecutor: () => executor.close(), runtime })
  }
  const controller = new AbortController()
  let socket: NodeWebSocket | undefined
  let running: ReturnType<typeof runCcaTaskProof> | undefined
  try {
    const identity = await createCcaNoiseIdentity()
    const identityBytes = Buffer.from(JSON.stringify(identity.publicKey) + "\n")
    let offset = 0
    while (offset < identityBytes.length) {
      const written = writeSync(3, identityBytes, offset)
      if (written < 1) throw new Error("Synthetic identity pipe did not accept bytes")
      offset += written
    }
    closeSync(3)
    const registryURL = "wss://rendezvous.chatgpt.com/synthetic-lifetime"
    running = runCcaTaskProof({
      state: {
        installationID: "synthetic-installation",
        accountHash: createHash("sha256").update(accountID).digest("hex"),
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        executorID: "synthetic-lifetime-environment",
      },
      credential: { accessToken: "synthetic-access", accountID },
      identity,
      acceptHandshake: acceptCcaNoiseHandshake,
      handler: { ...executor, close },
      environmentInfo: { shell: { name: "synthetic", path: "/bin/sh" }, capabilities: {} },
      fetch: async (url) => {
        if (url.endsWith("/register")) return Response.json({
          environment_id: "synthetic-lifetime-environment",
          executor_registration_id: "synthetic-lifetime-registration",
          security_profile: "noise_hybrid_ik_v1",
          url: registryURL,
        })
        if (url.endsWith("/validate")) return Response.json({ valid: true })
        throw new Error("Unexpected lifetime registry operation")
      },
      connectWebSocket: async (url) => {
        if (url !== registryURL) throw new Error("Unexpected lifetime socket destination")
        const client = new WebSocket(`ws://127.0.0.1:${port}`, { closeTimeout: 100 })
        socket = client
        client.once("close", () => record("socket-closed"))
        await new Promise<void>((resolve, reject) => {
          const onError = (error: unknown) => reject(error)
          client.once("error", onError)
          client.once("open", () => { client.off("error", onError); resolve() })
        })
        return client
      },
      signal: controller.signal,
      requireChannel: true,
      onStatus: () => {},
      onPhase: (phase) => {
        if (phase.phase === "transport-start" && phase.event === "completed") record("transport-ready")
      },
    })
    const work = (async () => {
      let command = ""
      for await (const chunk of process.stdin) command += String(chunk)
      if (command !== "close\n") throw new Error("Unexpected lifetime control command")
      record("work-completed")
      controller.abort()
    })()
    const [result] = await Promise.all([running, work])
    record("cleanup-completed", { ...result, acquired, released, socketClosed: socket?.readyState === WebSocket.CLOSED })
  } catch (error) {
    controller.abort()
    socket?.terminate()
    await running?.catch(() => {})
    await close().catch(() => {})
    throw error
  }
}

process.once("beforeExit", () => {
  try {
    record("before-exit", ccaProofResourceSnapshot(process))
  } finally {
    closeSync(4)
  }
})
await main().then(
  () => record("main-returned", ccaProofResourceSnapshot(process)),
  () => { console.error("CCA task lifetime fixture failed"); process.exitCode = 1 },
)
