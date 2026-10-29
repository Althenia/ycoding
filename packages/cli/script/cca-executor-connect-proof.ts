import { NodeServices } from "@effect/platform-node"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Global } from "@ycoding-ai/core/global"
import { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { Context, Effect, Layer, Scope } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import { WebSocket } from "ws"
import { runCcaConnectProof } from "../src/remote-control/cca-connect-proof"
import {
  loadCcaExperimentState,
  type CcaExperimentState,
} from "../src/remote-control/cca-executor-registration"
import { defaultWsMaxPayload } from "../src/remote-control/cca-executor-transport"
import { acceptCcaNoiseHandshake, createCcaNoiseIdentity } from "../src/remote-control/cca-noise"
import { CcaConnectProofError } from "../src/remote-control/cca-proof-common"
import { selectProofCredential, type ProofCredentialSource } from "../src/remote-control/client-enrollment"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function required(name: string, value: string | undefined, guidance: string): string {
  if (value !== undefined && value.length > 0) return value
  console.error(`Missing ${name}. ${guidance}`)
  process.exit(2)
}

function parseTimeoutMs(): number {
  const raw = argument("--timeout-ms")
  if (raw === undefined) return 120_000
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 600_000) {
    console.error("Invalid --timeout-ms. Use an integer between 1000 and 600000.")
    process.exit(2)
  }
  return value
}

async function withProofCredentialSource<A>(use: (source: ProofCredentialSource) => Promise<A>): Promise<A> {
  const services = AppNodeBuilder.build(LayerNode.group([Config.globalNode, Credential.node]), [
    [Global.node, Global.layerWith(process.env.YCODING_CONFIG_DIR ? { config: process.env.YCODING_CONFIG_DIR } : {})],
    [Database.node, Database.configured({ path: process.env.YCODING_DB })],
  ])
  const program = Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const context = yield* Layer.buildWithScope(services, scope)
      const config = Context.get(context, Config.GlobalService)
      const credentials = Context.get(context, Credential.Service)
      const source: ProofCredentialSource = {
        dotsProfile: () =>
          Effect.runPromise(
            config.snapshot().pipe(
              Effect.map((documents) => {
                if (documents.diagnostics.length) return undefined
                const dots = Config.dots(documents.entries)
                return dots.enabled ? dots.profile : undefined
              }),
            ),
          ),
        resolveStored: (profile) => Effect.runPromise(RemoteControlCredential.resolveStored(credentials, profile)),
      }
      return yield* Effect.promise(() => use(source))
    }),
  ).pipe(Effect.provide(NodeServices.layer))
  return Effect.runPromise(program)
}

function sanitizedFailure(error: unknown): { readonly message: string; readonly exitCode: number } {
  if (error instanceof CcaConnectProofError) {
    if (error.code === "channel_required") return { message: error.message, exitCode: 3 }
    if (error.code === "aborted") return { message: error.message, exitCode: 0 }
    if (error.code === "transport_failed") return { message: error.message, exitCode: 1 }
    return { message: error.message, exitCode: 2 }
  }
  if (
    error instanceof Error &&
    (error.message.includes("No Dots profile") || error.message.includes("stored ChatGPT credential"))
  ) {
    return { message: error.message, exitCode: 2 }
  }
  return { message: "CCA executor proof failed", exitCode: 1 }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: bun run script/cca-executor-connect-proof.ts --state <path> [--profile <name>] [--timeout-ms <1000-600000>] [--require-channel]",
    )
    return
  }
  const stateFile = required(
    "--state <path>",
    argument("--state"),
    "Pass the CCA executor registration state file written by the register proof.",
  )
  const timeoutMs = parseTimeoutMs()
  const requestedProfile = argument("--profile")
  const requireChannel = process.argv.includes("--require-channel")

  const databaseFile = Database.filename({ path: process.env.YCODING_DB })
  if (databaseFile !== ":memory:" && !existsSync(databaseFile)) {
    console.error(
      `No stored YCoding sign-in database (${path.basename(databaseFile)}) exists for this build's channel yet; ` +
        "sign in to OpenAI with this YCoding build first. This proof never creates an empty credential store.",
    )
    process.exit(2)
  }

  const loadedState = await loadCcaExperimentState(stateFile).catch(() => undefined)
  if (loadedState === undefined) {
    console.error("Could not load CCA executor registration state from the requested state path.")
    process.exit(2)
  }
  const state: CcaExperimentState = loadedState

  const controller = new AbortController()
  let signalCount = 0
  const onSignal = () => {
    signalCount++
    if (signalCount > 1) process.exit(130)
    controller.abort()
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  try {
    await withProofCredentialSource(async (source) => {
      const { resolved } = await selectProofCredential(source, requestedProfile)
      const identity = await createCcaNoiseIdentity()
      const result = await runCcaConnectProof({
        state,
        credential: { accessToken: resolved.access, accountID: resolved.accountID },
        identity,
        acceptHandshake: (input) => acceptCcaNoiseHandshake(input),
        connectWebSocket: (url, headers) => new WebSocket(url, { headers, maxPayload: defaultWsMaxPayload }),
        signal: controller.signal,
        requireChannel,
        onStatus: (line) => console.log(line),
      })
      console.log(
        `cca-connect-proof: channels=${result.channels} messages=${result.messages} bytes=${result.bytes}`,
      )
    })
  } finally {
    clearTimeout(timer)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
}

await main().catch((error: unknown) => {
  const failure = sanitizedFailure(error)
  if (failure.exitCode !== 0) console.error(failure.message)
  process.exit(failure.exitCode)
})
