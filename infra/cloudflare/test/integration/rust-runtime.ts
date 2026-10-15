import { YCoding } from "../../../../packages/client/src/v5/index"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { TestPeer } from "../../../../packages/remote/test/peer"
import {
  PeerRole,
  WireLimit,
  decodeRemoteResult,
  httpBulkQuery,
  readHttpBulk,
} from "../../../../packages/remote/src/index"
import { prepareRemoteRequest, readWireMessage } from "../../../../apps/web/src/remote/wire"

export async function startRustRuntime(root: string, directory: string, config: string) {
  const password = crypto.randomUUID()
  await mkdir(join(root, "home"), { recursive: true })
  const child = Bun.spawn(
    [new URL("../../../../rust/target/debug/ycoding-runtime", import.meta.url).pathname, "--stdio", "--port", "0"],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
        YCODING_CONFIG_DIR: config,
        YCODING_CONFIG_PROJECT_DISABLE: "1",
        YCODING_DISABLE_MODELS_FETCH: "1",
        YCODING_MODELS_PATH: join(config, "models.json"),
        YCODING_VERSION: "local",
        YCODING_PASSWORD: password,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const errors = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000)
  let output = ""
  try {
    while (!output.includes("\n")) {
      const next = await reader.read()
      if (next.done) throw new Error(`Rust runtime exited before readiness: ${await errors}`)
      output += new TextDecoder().decode(next.value)
    }
  } catch (error) {
    child.kill("SIGTERM")
    await child.exited
    throw error
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
  const ready: unknown = JSON.parse(output.split("\n")[0])
  if (typeof ready !== "object" || ready === null || !("url" in ready) || typeof ready.url !== "string")
    throw new Error("Invalid Rust runtime readiness")
  const client = YCoding.make({
    endpoint: { url: ready.url, auth: { type: "basic", username: "ycoding", password } },
    location: { directory },
  })
  await client.transport.ready()
  return {
    client,
    state: join(root, "state", "ycoding"),
    async close() {
      client.transport.close()
      await child.stdin.end()
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000)
      await child.exited
      clearTimeout(timeout)
      const stderr = await errors
      if (child.exitCode !== 0) throw new Error(`Rust runtime shutdown failed: ${stderr}`)
    },
  }
}

export async function readRelayContent(input: {
  origin: string
  cookie: string
  deviceID: string
  sessionID: string
  kind: "messages" | "attachments"
  id: string
}) {
  const peer = new TestPeer(
    `${input.origin.replace("http", "ws")}/ws/v5/client?device=${input.deviceID}`,
    { cookie: input.cookie, origin: input.origin },
    PeerRole.REMOTE_CLIENT,
  )
  try {
    await peer.ready
    const operation = input.kind === "messages" ? "session.message" : "session.attachment.read"
    const prepared = prepareRemoteRequest(operation, {
      sessionID: input.sessionID,
      input: input.kind === "messages" ? { messageID: input.id } : { digest: input.id },
    })
    const id = peer.request(operation, prepared.scope, prepared.payload)
    peer.connection.expectHttpBulk(id)
    await peer.wait(() =>
      peer.queue.some((item) => item.decision.type === "httpBulkStart" || item.decision.type === "settled"),
    )
    if (!peer.queue.some((item) => item.decision.type === "httpBulkStart")) {
      const settled = await peer.next("settled", id)
      const payload = settled.payload
      if (settled.status === "success" && payload)
        return {
          status: "ok" as const,
          delivery: "inline" as const,
          value: readWireMessage(prepared.codec.result.schema, decodeRemoteResult(operation, payload)),
        }
      const codec = payload && prepared.codec.errors.get(payload.typeName)
      if (settled.status !== "rejected" || !codec || !payload)
        throw new Error(`Content admission did not settle: ${settled.status}`)
      return { status: "failed" as const, error: readWireMessage(codec.schema, codec.decode(payload.payload)) }
    }
    const declaration = await peer.next("httpBulkStart")
    const response = await fetch(
      `${input.origin}/api/remote/devices/${input.deviceID}/sessions/${input.sessionID}/${input.kind}/${input.id}?${httpBulkQuery(peer.connection, declaration)}`,
      {
        headers: { cookie: input.cookie, origin: input.origin, "sec-fetch-site": "same-origin" },
        signal: AbortSignal.timeout(30_000),
      },
    )
    await readHttpBulk(peer.connection, declaration, response, {
      now: () => performance.now(),
      apply(decisions) {
        peer.queue.push(...decisions.map((decision) => ({ decision })))
        peer.flush()
      },
    })
    await peer
      .wait(() => peer.queue.some((item) => item.decision.type === "bulkComplete"), WireLimit.DELIVERY_TIMEOUT_MS)
      .catch((cause: unknown) => {
        throw new Error(
          `HTTP terminal evidence: ${JSON.stringify({
            state: peer.connection.state,
            bytes: declaration.start.byteCount.toString(),
            queued: peer.queue.map((item) => ({
              type: item.decision.type,
              ...(item.decision.type === "settled"
                ? { status: item.decision.status, typeName: item.decision.payload?.typeName }
                : {}),
            })),
            frames: peer.raw.slice(-12).map((frame) => frame.body.case),
          })}`,
          { cause },
        )
      })
    const completed = await peer.next("bulkComplete")
    const settled = await peer.next("settled", id)
    if (settled.status !== "success" || !settled.payload) throw new Error(`Content read failed: ${settled.status}`)
    const value =
      input.kind === "messages"
        ? readWireMessage(prepared.codec.result.schema, decodeRemoteResult(operation, settled.payload))
        : completed.data
    peer.connection.releaseBulk(completed.transferID)
    return { status: "ok" as const, delivery: "http" as const, httpStatus: response.status, value }
  } finally {
    peer.stop()
    await peer.closed
  }
}
