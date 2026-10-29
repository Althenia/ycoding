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
import {
  buildStepUpAuthorizeURL,
  buildStepUpTokenRequest,
  createClientProofStateStore,
  createStepUpCallbackServer,
  decodeStepUpTokenResponse,
  generateStepUpMaterial,
  runEnrollmentProof,
  runRefreshProof,
  selectProofCredential,
  type ProofCredentialSource,
} from "../src/remote-control/client-enrollment"

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function required(name: string, value: string | undefined, guidance: string) {
  if (value !== undefined && value.length > 0) return value
  console.error(`Missing ${name}. ${guidance}`)
  process.exit(2)
}

async function stepUpToken(input: {
  readonly accountID: string
  readonly accountUserId: string
  readonly field: "access_token" | "id_token"
}) {
  const flowStartedAt = Date.now()
  const material = generateStepUpMaterial()
  const callback = await createStepUpCallbackServer({ state: material.state })
  try {
    const url = buildStepUpAuthorizeURL({
      accountID: input.accountID,
      redirectUri: callback.redirectUri,
      state: material.state,
      codeChallenge: material.challenge,
    })
    console.log("Open this step-up authorization URL in your signed-in browser:")
    console.log(url)
    console.log(`Waiting for the loopback callback at ${callback.redirectUri} ...`)
    const code = await callback.waitForCode()
    const exchange = buildStepUpTokenRequest({ code, redirectUri: callback.redirectUri, verifier: material.verifier })
    const response = await fetch(exchange.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "error",
      body: exchange.body,
    })
    if (!response.ok) throw new Error(`Step-up token exchange failed with status ${response.status}`)
    const decoded = decodeStepUpTokenResponse((await response.json()) as unknown, {
      field: input.field,
      accountUserId: input.accountUserId,
      accountID: input.accountID,
      flowStartedAt,
    })
    console.log(
      `Step-up token validated: scope field ${decoded.scopeVerified ? "present and exact" : "absent (unverified)"}, ` +
        `auth_time ${decoded.authTimeMs === undefined ? "absent (unverified)" : "fresh"}, claims: ${decoded.claimNames.join(", ")}`,
    )
    return decoded.stepUpToken
  } finally {
    await callback.close()
  }
}

async function withProofCredentialSource<A>(use: (source: ProofCredentialSource) => Promise<A>) {
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

async function main() {
  const command = process.argv[2]
  if (command !== "enroll" && command !== "refresh") {
    console.error("Usage: bun run script/remote-control-client-enroll-proof.ts enroll|refresh --state <path> [options]")
    process.exit(2)
  }
  const stateFile = required("--state <path>", argument("--state"), "Choose a path outside any repository; it will hold a private key at mode 0600.")
  const databaseFile = Database.filename({ path: process.env.YCODING_DB })
  if (databaseFile !== ":memory:" && !existsSync(databaseFile)) {
    console.error(
      `No stored YCoding sign-in database (${path.basename(databaseFile)}) exists for this build's channel yet; ` +
        "sign in to OpenAI with this YCoding build first. This proof never creates an empty credential store.",
    )
    process.exit(2)
  }
  const store = createClientProofStateStore(stateFile)

  await withProofCredentialSource(async (source) => {
    const { resolved, selection } = await selectProofCredential(source, argument("--profile"))
    console.log(`Stored ChatGPT credential resolved from the ${selection} Dots profile (account generation ${resolved.accountGeneration}).`)
    const credential = { access: resolved.access, accountID: resolved.accountID }

    if (command === "enroll") {
      if ((await store.load()) !== undefined) {
        console.error(`A client proof state already exists at ${stateFile}; remove it yourself before enrolling again.`)
        process.exit(2)
      }
      const fieldValue = argument("--step-up-token-field") ?? "access_token"
      if (fieldValue !== "access_token" && fieldValue !== "id_token") {
        console.error("--step-up-token-field must be access_token or id_token")
        process.exit(2)
      }
      const keyId = argument("--key-id") ?? process.env.REMOTE_CONTROL_CLIENT_KEY_ID
      const result = await runEnrollmentProof({
        credential,
        ...(keyId === undefined ? {} : { keyId }),
        stepUpToken: (context) => stepUpToken({ accountID: resolved.accountID, accountUserId: context.accountUserId, field: fieldValue }),
      })
      await store.save(result.state)
      console.log(`Enrolled client_id ${result.state.clientId}; token scope ${JSON.stringify(result.scope)}; response fields: ${result.fieldNames.join(", ")}`)
      console.log("remote_control_token received in memory only; it was not printed or stored.")
      console.log(`Device key state saved at ${stateFile} (mode 0600, contains the private key).`)
      return
    }

    const refreshPayloadType = required(
      "--refresh-payload-type <type>",
      argument("--refresh-payload-type") ?? process.env.REMOTE_CONTROL_CLIENT_REFRESH_PAYLOAD_TYPE,
      "The refresh signed-payload type is not defined by the current typed contract, so this proof cannot invent one.",
    )
    const state = await store.load()
    if (state === undefined) {
      console.error(`No client proof state at ${stateFile}; run enroll first.`)
      process.exit(2)
    }
    const refreshPurpose = argument("--refresh-purpose") ?? process.env.REMOTE_CONTROL_CLIENT_REFRESH_PURPOSE
    const result = await runRefreshProof({
      credential,
      state,
      refreshPayloadType,
      ...(refreshPurpose === undefined ? {} : { refreshPurpose }),
    })
    console.log(
      `Refreshed client_id ${state.clientId}; challenge purpose/audience: ${result.challengePurpose}; token scope ${JSON.stringify(result.scope)}; response fields: ${result.fieldNames.join(", ")}`,
    )
    console.log("remote_control_token received in memory only; it was not printed or stored.")
  })
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Client enrollment proof failed")
  process.exit(1)
})
