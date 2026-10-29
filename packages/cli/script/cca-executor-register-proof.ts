import { NodeServices } from "@effect/platform-node"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Global } from "@ycoding-ai/core/global"
import { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { Context, Effect, Layer, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCcaRegistration, safeExecutorSummary } from "../src/remote-control/cca-executor-registration"
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

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.startsWith("CCA executor registration failed with status ")) {
      return error.message
    }
    if (error.message === "CCA executor registration timed out or was aborted") {
      return error.message
    }
    if (error.message === "CCA executor registration returned an unparseable response") {
      return error.message
    }
    if (error.message === "CCA executor registration returned an invalid payload") {
      return error.message
    }
    if (error.message.includes("EEXIST") || error.message.includes("already exists")) {
      return "State reservation failed: state file already exists"
    }
    if (error.message.includes("No Dots profile") || error.message.includes("stored ChatGPT credential")) {
      return error.message
    }
  }
  return "CCA executor registration proof failed"
}

async function main() {
  const stateFile = required(
    "--state <path>",
    argument("--state"),
    "Choose a new file path; it will hold experiment state at mode 0600.",
  )

  const databaseFile = Database.filename({ path: process.env.YCODING_DB })
  if (databaseFile !== ":memory:" && !existsSync(databaseFile)) {
    console.error(
      `No stored YCoding sign-in database (${path.basename(databaseFile)}) exists for this build's channel yet; ` +
        "sign in to OpenAI with this YCoding build first. This proof never creates an empty credential store.",
    )
    process.exit(2)
  }

  const requestedProfile = argument("--profile")
  const installationID = argument("--installation-id") ?? randomUUID()
  const displayName = argument("--display-name") ?? os.hostname()

  await withProofCredentialSource(async (source) => {
    const { resolved, selection } = await selectProofCredential(source, requestedProfile)
    console.log(`Stored ChatGPT credential resolved from ${selection} profile.`)

    const { result, state } = await runCcaRegistration({
      credential: {
        access: resolved.access,
        accountID: resolved.accountID,
      },
      installationID,
      displayName,
      statePath: stateFile,
    })

    const summary = safeExecutorSummary(result.executorID)
    console.log(
      `CCA executor registered successfully: prefix ${summary.prefix}, sha256 ${summary.sha256}, length ${summary.length}`,
    )
    console.log(`Experiment state recorded at the requested state path (mode 0600, status: ${state.status}).`)
  })
}

await main().catch((error: unknown) => {
  console.error(sanitizeErrorMessage(error))
  process.exit(1)
})
