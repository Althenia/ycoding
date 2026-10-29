import { NodeServices } from "@effect/platform-node"
import { ccaEnvironmentInfo, createCcaExecutor } from "@ycoding-ai/core/cca/executor"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Global } from "@ycoding-ai/core/global"
import { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { Context, Effect, Layer, Scope } from "effect"
import { existsSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { WebSocket } from "ws"
import {
  loadCcaExperimentState,
  type CcaExperimentState,
} from "../src/remote-control/cca-executor-registration"
import { defaultWsMaxPayload } from "../src/remote-control/cca-executor-transport"
import { acceptCcaNoiseHandshake, createCcaNoiseIdentity } from "../src/remote-control/cca-noise"
import { CcaConnectProofError } from "../src/remote-control/cca-proof-common"
import {
  createCcaProofJournal,
  CcaProofJournalError,
  type CcaProofJournal,
  type CcaProofJournalPhase,
} from "../src/remote-control/cca-proof-journal"
import { runCcaProofLifecycle, type CcaProofLifecycle } from "../src/remote-control/cca-proof-lifecycle"
import { runCcaTaskProof } from "../src/remote-control/cca-task-proof"
import {
  composeCcaTaskCleanup,
  createCcaTaskRuntime,
  CcaTaskRuntimeCloseError,
  CcaTaskRuntimeUnavailableError,
} from "../src/remote-control/cca-task-runtime"
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

function resolveRoot(raw: string): string {
  if (!path.isAbsolute(raw)) {
    console.error("Invalid --root. Use an absolute directory path.")
    process.exit(2)
  }
  let resolved: string
  try {
    resolved = realpathSync(raw)
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory")
  } catch {
    console.error("Invalid --root. The directory must exist.")
    process.exit(2)
  }
  return resolved
}

function openStatusJournal(statusFile: string | undefined): CcaProofJournal | undefined {
  if (statusFile === undefined) return undefined
  try {
    return createCcaProofJournal(statusFile)
  } catch {
    console.error("cca-task-proof: status file unavailable")
    process.exit(2)
  }
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

class CcaTaskProofScriptError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode: number) {
    super(message)
    this.name = "CcaTaskProofScriptError"
    this.exitCode = exitCode
  }
}

function sanitizedFailure(error: unknown): { readonly message: string; readonly exitCode: number } {
  if (error instanceof CcaTaskProofScriptError) {
    return { message: error.message, exitCode: error.exitCode }
  }
  if (error instanceof CcaProofJournalError) {
    return { message: error.message, exitCode: 1 }
  }
  if (error instanceof CcaTaskRuntimeUnavailableError || error instanceof CcaTaskRuntimeCloseError) {
    return { message: error.message, exitCode: 1 }
  }
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

async function main(lifecycle: CcaProofLifecycle) {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: bun run script/cca-executor-task-proof.ts --state <path> --root <absolute-dir> [--profile <name>] [--timeout-ms <1000-600000>] [--require-channel] [--status-file <absolute-new-file>]",
    )
    return
  }
  const stateFile = required(
    "--state <path>",
    argument("--state"),
    "Pass the CCA executor registration state file written by the register proof.",
  )
  const resolvedRoot = resolveRoot(
    required(
      "--root <absolute-dir>",
      argument("--root"),
      "Pass the absolute local directory the executor may operate in for this proof.",
    ),
  )
  const timeoutMs = parseTimeoutMs()
  const requestedProfile = argument("--profile")
  const requireChannel = process.argv.includes("--require-channel")
  const statusFile = process.argv.includes("--status-file")
    ? required(
        "--status-file <absolute-new-file>",
        argument("--status-file"),
        "Pass an absolute path to a new status file.",
      )
    : undefined
  const journal = openStatusJournal(statusFile)
  if (journal !== undefined) lifecycle.attach(journal)
  journal?.record({ phase: "script", event: "started" })
  const observeStage = async <A>(phase: CcaProofJournalPhase, run: () => Promise<A>) => {
    journal?.record({ phase, event: "started" })
    try {
      const value = await run()
      journal?.record({ phase, event: "completed" })
      return value
    } catch (error) {
      journal?.record({ phase, event: "failed" })
      throw error
    }
  }
  const controller = new AbortController()
  let signalCount = 0
  const onSignal = () => {
    signalCount++
    if (signalCount > 1) process.exit(130)
    controller.abort()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let resultSummary: string | undefined
  try {
    await observeStage("preflight", async () => {
      const databaseFile = Database.filename({ path: process.env.YCODING_DB })
      if (databaseFile !== ":memory:" && !existsSync(databaseFile)) {
        throw new CcaTaskProofScriptError(
          `No stored YCoding sign-in database (${path.basename(databaseFile)}) exists for this build's channel yet; ` +
            "sign in to OpenAI with this YCoding build first. This proof never creates an empty credential store.",
          2,
        )
      }
    })
    const state: CcaExperimentState = await observeStage("state-load", async () => {
      const loadedState = await loadCcaExperimentState(stateFile).catch(() => undefined)
      if (loadedState === undefined) {
        throw new CcaTaskProofScriptError(
          "Could not load CCA executor registration state from the requested state path.",
          2,
        )
      }
      return loadedState
    })
    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)
    timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const resolved = await observeStage("credential-selection", () =>
      withProofCredentialSource(
        async (source) => (await selectProofCredential(source, requestedProfile)).resolved,
      ),
    )
    const identity = await observeStage("identity-creation", () => createCcaNoiseIdentity())
    const runtime = await observeStage("runtime-startup", () =>
      createCcaTaskRuntime({
        root: resolvedRoot,
        credentialPin: {
          profile: resolved.profile,
          accountID: resolved.accountID,
          accountHash: state.accountHash,
          credentialID: resolved.credentialID,
          accountGeneration: resolved.accountGeneration,
          key: resolved.key,
        },
        ...(journal === undefined ? {} : { onPhase: journal.record }),
      }),
    )
    let executor: ReturnType<typeof createCcaExecutor> | undefined
    const closeAll = composeCcaTaskCleanup({
      closeExecutor: async () => {
        if (executor !== undefined) await executor.close()
      },
      runtime,
      ...(journal === undefined ? {} : { onPhase: journal.record }),
    })
    const settled = await (async () => {
      const scope = { sessionID: runtime.sessionID, roots: [resolvedRoot], authorization: runtime.authorization, close: async () => {} }
      executor = createCcaExecutor({ scopeFor: async () => scope })
      const handler = { ...executor, close: closeAll }
      return runCcaTaskProof({
        state,
        credential: { accessToken: resolved.access, accountID: resolved.accountID },
        identity,
        acceptHandshake: (input) => acceptCcaNoiseHandshake(input),
        handler,
        environmentInfo: ccaEnvironmentInfo({ cwd: resolvedRoot }),
        connectWebSocket: (url, headers) => new WebSocket(url, { headers, maxPayload: defaultWsMaxPayload }),
        signal: controller.signal,
        requireChannel,
        onStatus: (line) => console.log(line),
        ...(journal === undefined ? {} : { onPhase: journal.record }),
      })
    })().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let closeError: unknown
    try {
      await closeAll()
    } catch (error) {
      closeError = error
    }
    if (!settled.ok) throw settled.error
    if (closeError !== undefined) throw closeError
    journal?.record({
      phase: "script-completion",
      event: "completed",
      channels: settled.value.channels,
      requests: settled.value.requests,
      responses: settled.value.responses,
      notifications: settled.value.notifications,
    })
    resultSummary =
      `cca-task-proof: channels=${settled.value.channels} requests=${settled.value.requests} responses=${settled.value.responses} notifications=${settled.value.notifications}`
  } catch (error) {
    journal?.record({ phase: "script-completion", event: "failed" })
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
  if (journal?.failed) throw new CcaProofJournalError()
  if (resultSummary !== undefined) console.log(resultSummary)
}

await runCcaProofLifecycle({ main, classify: sanitizedFailure })
