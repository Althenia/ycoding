import { expect } from "bun:test"
import { YCoding } from "@ycoding-ai/client/v5"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deltaChunk, finishChunk } from "../../ai/test/lib/openai-chunks"

export const password = "test-password"

export type IsolatedServer = Awaited<ReturnType<typeof startServer>>

export type ProviderFixture = {
  /** The assistant text the stand-in returns. */
  readonly text: string
  /**
   * Leaves requests after the specified count open, allowing goal synthesis and
   * its initial steer to settle before inspecting the admitted autonomous work.
   */
  readonly holdAfter?: number
  readonly settleDelayMs?: number
  readonly reply?: (request: unknown) => readonly ReturnType<typeof deltaChunk>[]
}

type ProviderStandIn = {
  readonly providerID: string
  readonly modelID: string
  readonly url: string
  /** Chat-completion request bodies the stand-in received, in order. */
  readonly requests: () => readonly unknown[]
  /** Releases every held completion so the caller can shut down cleanly. */
  readonly releaseAll: () => void
}

export type IsolatedServerOptions = { readonly provider?: ProviderFixture }

export async function startServer(directory: string, options: IsolatedServerOptions = {}) {
  const standIn = options.provider === undefined ? undefined : await startProviderStandIn(options.provider)
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-cli-runtime-"))
  await mkdir(path.join(root, "home"))
  if (standIn)
    await Bun.write(
      path.join(root, "models.json"),
      JSON.stringify({
        [providerID]: {
          id: providerID,
          name: "Isolated stand-in",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            [modelID]: {
              id: modelID,
              name: "Isolated Model",
              release_date: "2026-01-01",
              attachment: false,
              reasoning: false,
              tool_call: true,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 128_000, output: 8192 },
              cost: { input: 1, output: 1 },
            },
          },
        },
      }),
    )
  const logs: string[] = []
  const executable = path.resolve(
    import.meta.dirname,
    "../../../rust/target/debug",
    process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime",
  )
  const child = Bun.spawn([executable, "--stdio", "--port", "0"], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "data"),
      YCODING_CONFIG_DIR: directory,
      YCODING_CONFIG_PROJECT_DISABLE: "1",
      YCODING_DISABLE_MODELS_FETCH: "1",
      YCODING_VERSION: "local",
      YCODING_PASSWORD: password,
      ...(standIn
        ? { YCODING_CONFIG_CONTENT: providerConfig(standIn), YCODING_MODELS_PATH: path.join(root, "models.json") }
        : {}),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text().then((text) => {
    logs.push(text)
    return text
  })
  const reader = child.stdout.getReader()
  let output = ""
  const deadline = setTimeout(() => child.kill("SIGTERM"), 15_000)
  try {
    while (!output.includes("\n")) {
      const next = await reader.read()
      if (next.done) throw new Error(`Rust test runtime exited before readiness: ${await stderr}`)
      output += new TextDecoder().decode(next.value)
    }
  } catch (error) {
    child.kill("SIGTERM")
    await child.exited
    await standIn?.close()
    await rm(root, { recursive: true, force: true })
    throw error
  } finally {
    clearTimeout(deadline)
    reader.releaseLock()
  }
  const ready: unknown = JSON.parse(output.split("\n")[0])
  if (typeof ready !== "object" || ready === null || !("url" in ready) || typeof ready.url !== "string")
    throw new Error("Invalid Rust readiness")
  const base = ready.url
  const client = YCoding.make({
    endpoint: { url: base, auth: { type: "basic", username: "ycoding", password } },
    location: { directory },
  })
  await client.transport.ready()
  let closed = false
  return {
    base,
    client,
    endpoint: { url: base, auth: { type: "basic" as const, username: "ycoding", password } },
    logs,
    ...(standIn === undefined
      ? {}
      : {
          provider: {
            providerID: standIn.providerID,
            modelID: standIn.modelID,
            url: standIn.url,
            requests: standIn.requests,
            releaseAll: standIn.releaseAll,
          } satisfies ProviderStandIn,
        }),
    async close() {
      if (closed) return
      closed = true
      client.transport.close()
      await child.stdin.end()
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000)
      await child.exited
      clearTimeout(timeout)
      await standIn?.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const providerID = "isolated-stand-in"
const modelID = "isolated-model"

/** Declares the loopback provider in the isolated config document, never in user config. */
function providerConfig(standIn: { readonly url: string }) {
  return JSON.stringify({
    providers: {
      [providerID]: {
        name: "Isolated stand-in",
        settings: { baseURL: `${standIn.url}/v1`, apiKey: "isolated-stand-in-key" },
        models: {
          [modelID]: {
            name: "Isolated Model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 8192 },
          },
        },
      },
    },
  })
}

async function startProviderStandIn(fixture: ProviderFixture) {
  const requests: unknown[] = []
  const held: Array<() => void> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      const body = await request.json()
      requests.push(body)
      const heldRequest = fixture.holdAfter !== undefined && requests.length > fixture.holdAfter
      const encoder = new TextEncoder()
      const frames = fixture.reply?.(body) ?? [
        deltaChunk({ role: "assistant" }),
        deltaChunk({ content: fixture.text }),
        finishChunk("stop"),
      ]
      const stream = new ReadableStream({
        async start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          for (let remaining = fixture.settleDelayMs ?? 0; remaining > 0; remaining -= 4_000) {
            await Bun.sleep(Math.min(remaining, 4_000))
            controller.enqueue(encoder.encode(": keep-alive\n\n"))
          }
          if (heldRequest)
            await new Promise<void>((resolve) => {
              held.push(resolve)
            })
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    providerID,
    modelID,
    url: `http://127.0.0.1:${server.port}`,
    requests: () => requests,
    releaseAll: () => {
      for (const release of held.splice(0)) release()
    },
    close: async () => {
      for (const release of held.splice(0)) release()
      await server.stop(true)
    },
  }
}

export async function createSession(
  server: IsolatedServer,
  sessionID: string,
  directory: string,
  model?: { readonly providerID: string; readonly id: string },
) {
  const created = await server.client.session.create({ id: sessionID, location: { directory }, model })
  expect(created.id).toBe(sessionID)
}
