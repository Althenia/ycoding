import { createCcaExecutor } from "@ycoding-ai/core/cca/executor"
import { createHash } from "node:crypto"
import { WebSocket, type NodeWebSocket } from "ws"
import { runCcaTaskProof } from "../../src/remote-control/cca-task-proof"
import { fixedScopeFor } from "./cca-scope"

async function main() {
  const port = Number(process.argv[2])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid fixture port")
  const controller = new AbortController()
  const accountID = "synthetic-account"
  const registryURL = "wss://rendezvous.chatgpt.com/synthetic-close-boundary"
  const publicKey = {
    suite: "noise_hybrid_ik_v1",
    x25519_public_key: "synthetic-x",
    mlkem768_public_key: "synthetic-m",
  }
  const executor = createCcaExecutor({
    scopeFor: fixedScopeFor([process.cwd()], async () => {
      throw new Error("Unexpected fixture authorization")
    }),
  })
  let socket: NodeWebSocket | undefined
  const running = runCcaTaskProof({
    state: {
      installationID: "synthetic-installation",
      accountHash: createHash("sha256").update(accountID).digest("hex"),
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      executorID: "synthetic-environment",
    },
    credential: { accessToken: "synthetic-access", accountID },
    identity: { publicKey },
    acceptHandshake: async (input) => {
      await input.authorize(publicKey, "synthetic-authorization")
      return {
        response: new Uint8Array([1]),
        transport: { encrypt: async (bytes) => bytes, decrypt: async (bytes) => bytes },
      }
    },
    handler: executor,
    environmentInfo: { shell: { name: "synthetic", path: "/synthetic-shell" }, capabilities: {} },
    fetch: async (url) => {
      if (url.endsWith("/register")) {
        return Response.json({
          environment_id: "synthetic-environment",
          executor_registration_id: "synthetic-registration",
          security_profile: "noise_hybrid_ik_v1",
          url: registryURL,
        })
      }
      if (url.endsWith("/validate")) return Response.json({ valid: true })
      throw new Error("Unexpected fixture registry operation")
    },
    connectWebSocket: async (url) => {
      if (url !== registryURL) throw new Error("Unexpected fixture socket destination")
      const client = new WebSocket(`ws://127.0.0.1:${port}`, { closeTimeout: 100 })
      socket = client
      client.once("close", () => console.log(JSON.stringify({ event: "socket-closed" })))
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown) => reject(error)
        client.once("error", onError)
        client.once("open", () => {
          client.off("error", onError)
          resolve()
        })
      })
      return client
    },
    signal: controller.signal,
    requireChannel: true,
    onStatus: () => {},
    onPhase: (record) => {
      if (record.phase === "transport-start" && record.event === "completed") {
        console.log(JSON.stringify({ event: "transport-ready" }))
      }
    },
  })
  try {
    const closing = (async () => {
      let command = ""
      for await (const chunk of process.stdin) command += String(chunk)
      if (command !== "close\n") throw new Error("Unexpected fixture command")
      controller.abort()
    })()
    const [result] = await Promise.all([running, closing])
    console.log(JSON.stringify({
      event: "cleanup-resolved",
      socketClosed: socket?.readyState === WebSocket.CLOSED,
      ...result,
    }))
  } catch (error) {
    controller.abort()
    socket?.terminate()
    await running.catch(() => {})
    throw error
  }
}

await main().catch(() => {
  console.error("CCA transport close fixture failed")
  process.exitCode = 1
})
