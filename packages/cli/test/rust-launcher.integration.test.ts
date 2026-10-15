import { expect, test } from "bun:test"
import { ensure, stop } from "@ycoding-ai/client/service"
import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/v5"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { streamResponse } from "../script/runtime-smoke"
import { ServiceConfig } from "../src/services/service-config"

const packaged = process.env.YCODING_TEST_PACKAGED_CLI
const version = process.env.YCODING_TEST_PACKAGED_VERSION ?? "local"
const channel = process.env.YCODING_TEST_PACKAGED_CHANNEL ?? "local"
const namespace = channel === "beta" ? "ycoding-beta" : "ycoding"

test("CLI managed launch discovers Rust identity, reuses it and preserves the restart password", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-rust-cli-"))
  const file = path.join(root, "state", namespace, ServiceConfig.filename(channel))
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    YCODING_CONFIG_DIR: path.join(root, "config/ycoding"),
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_CONFIG_PROJECT_DISABLE: "1",
    YCODING_RUNTIME_EXECUTABLE: path.resolve(
      import.meta.dirname,
      "../../../rust/target/debug",
      process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime",
    ),
  }
  await mkdir(environment.YCODING_CONFIG_DIR, { recursive: true })
  const cli = path.resolve(import.meta.dirname, "../src/index.ts")
  const command = packaged
    ? [
        "/usr/bin/env",
        "-i",
        `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
        ...Object.entries(environment)
          .filter(([key]) => key !== "YCODING_RUNTIME_EXECUTABLE")
          .map(([key, value]) => `${key}=${value}`),
        packaged,
        "serve",
        "--service",
        "--port",
        "0",
      ]
    : [
        process.execPath,
        "-e",
        `Object.assign(process.env, ${JSON.stringify(environment)}); process.argv = [process.execPath, ${JSON.stringify(cli)}, "serve", "--service", "--port", "0"]; await import(${JSON.stringify(cli)});`,
      ]
  const options = { file, command, version, startupErrorFile: path.join(root, "startup-error") }
  const clients: ReturnType<typeof YCoding.make>[] = []
  try {
    const endpoint = await ensure(options)
    const first = await Schema.decodeUnknownPromise(Schema.fromJsonString(Service.Info))(await readFile(file, "utf8"))
    expect(first.pid).not.toBe(process.pid)
    const client = YCoding.make({ endpoint })
    clients.push(client)
    expect(await client.health.get()).toMatchObject({ healthy: true, pid: first.pid, version })
    expect(await ensure(options)).toEqual(endpoint)
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject(first)
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    await stop({ file })
    const restarted = await ensure(options)
    expect(restarted.auth?.password).toBe(first.password)
    expect(JSON.parse(await readFile(file, "utf8"))).not.toMatchObject({ id: first.id })
  } finally {
    clients.forEach((client) => client.transport.close())
    await stop({ file })
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!packaged)(
  "fresh packaged CLI executes root and child prompts, preserves crash writes, and records shutdown interruption",
  async () => {
    if (!packaged) throw new Error("YCODING_TEST_PACKAGED_CLI is required")
    const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-packaged-flow-"))
    const project = path.join(root, "project")
    const config = path.join(root, "config/ycoding")
    await mkdir(project, { recursive: true })
    await mkdir(config, { recursive: true })
    const requests: string[] = []
    const held = Promise.withResolvers<void>()
    const crashHeld = Promise.withResolvers<void>()
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text()
        requests.push(body)
        if (body.includes("Hold package shutdown")) {
          held.resolve()
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
        }
        if (body.includes("Hold package crash")) {
          crashHeld.resolve()
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
        }
        return new Response(streamResponse({ index: requests.length, content: "Packaged execution settled" }), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    await writeFile(
      path.join(config, "ycoding.json"),
      JSON.stringify({
        agents: {
          reviewer: { description: "Local package acceptance", mode: "subagent", model: "openrouter/pack-model" },
        },
        providers: {
          openrouter: {
            name: "OpenRouter",
            package: "aisdk:@openrouter/ai-sdk-provider",
            settings: { baseURL: `http://127.0.0.1:${provider.port}/api/v1` },
            models: {
              "pack-model": {
                name: "Pack",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: 100000, output: 4096 },
              },
            },
          },
        },
      }),
    )
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "data"),
      YCODING_CONFIG_DIR: config,
      YCODING_CONFIG_PROJECT_DISABLE: "1",
      YCODING_DISABLE_MODELS_FETCH: "1",
    }
    const file = path.join(root, "state", namespace, ServiceConfig.filename(channel))
    const command = [
      "/usr/bin/env",
      "-i",
      `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
      ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      packaged,
      "serve",
      "--service",
      "--port",
      "0",
    ]
    const options = { file, command, version, startupErrorFile: path.join(root, "startup-error") }
    const clients: ReturnType<typeof YCoding.make>[] = []
    try {
      const client = YCoding.make({ endpoint: await ensure(options), location: { directory: project } })
      clients.push(client)
      await client.integration.connect.key({
        integrationID: "openrouter",
        key: "packaged-synthetic-key",
        location: { directory: project },
      })
      const session = await client.session.create({
        model: { providerID: "openrouter", id: "pack-model" },
        location: { directory: project },
      })
      await client.session.prompt({ sessionID: session.id, id: "msg_package_root", text: "Settle the local root" })
      await client.session.wait({ sessionID: session.id })
      expect(requests.length).toBeGreaterThan(0)
      expect(JSON.stringify(await client.message.list({ sessionID: session.id }))).toContain(
        "Packaged execution settled",
      )
      const promptable = await client.session.create({
        parentID: session.id,
        model: { providerID: "openrouter", id: "pack-model" },
        location: { directory: project },
      })
      for (const target of [undefined, promptable.id]) {
        const command = Bun.spawn(
          [
            packaged,
            "run",
            "--format",
            "json",
            "--model",
            "openrouter/pack-model",
            ...(target ? ["--session", target] : []),
            "Settle the packaged command",
          ],
          {
            cwd: project,
            env: { PATH: process.env.PATH, ...environment, PWD: project },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: 30_000,
          },
        )
        const [code, stdout, stderr] = await Promise.all([
          command.exited,
          new Response(command.stdout).text(),
          new Response(command.stderr).text(),
        ])
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
        expect(stdout).toContain("Packaged execution settled")
      }
      expect((await client.session.get({ sessionID: promptable.id })).parentID).toBe(session.id)
      const child = await client.session.subagent.launch({
        parentID: session.id,
        parentAssistantMessageID: "msg_package_parent",
        toolCallID: "call_package_child",
        agent: "reviewer",
        description: "Check the package",
        prompt: "Settle the local child",
        background: true,
      })
      await client.session.wait({ sessionID: child.sessionID })
      expect((await client.session.get({ sessionID: child.sessionID })).parentID).toBe(session.id)
      expect(JSON.stringify(await client.message.list({ sessionID: child.sessionID }))).toContain(
        "Packaged execution settled",
      )
      await client.session.rename({ sessionID: session.id, title: "Acknowledged package write" })
      const prior = await Schema.decodeUnknownPromise(Schema.fromJsonString(Service.Info))(await readFile(file, "utf8"))
      process.kill(prior.pid, "SIGKILL")
      client.transport.close()
      const restarted = YCoding.make({ endpoint: await ensure(options), location: { directory: project } })
      clients.push(restarted)
      expect((await restarted.session.get({ sessionID: session.id })).title).toBe("Acknowledged package write")
      expect((await restarted.session.get({ sessionID: child.sessionID })).parentID).toBe(session.id)
      expect(JSON.stringify(await restarted.message.list({ sessionID: session.id }))).toContain(
        "Packaged execution settled",
      )
      expect(JSON.parse(await readFile(file, "utf8")).id).not.toBe(prior.id)
      const blocked = await restarted.session.create({
        model: { providerID: "openrouter", id: "pack-model" },
        location: { directory: project },
      })
      await restarted.session.prompt({ sessionID: blocked.id, text: "Hold package shutdown" })
      await held.promise
      expect((await restarted.session.outstanding()).running).toContain(blocked.id)
      await stop({ file })
      restarted.transport.close()
      const recovered = YCoding.make({ endpoint: await ensure(options), location: { directory: project } })
      clients.push(recovered)
      const reasons: string[] = []
      for await (const event of recovered.session.log({ sessionID: blocked.id, follow: false })) {
        if (event.type === "session.execution.interrupted") reasons.push(event.data.reason)
      }
      expect(reasons).toEqual(["shutdown"])
      expect((await recovered.session.outstanding()).running).not.toContain(blocked.id)
      expect(requests.filter((body) => body.includes("Hold package shutdown"))).toHaveLength(1)
      const crashed = await recovered.session.create({
        model: { providerID: "openrouter", id: "pack-model" },
        location: { directory: project },
      })
      await recovered.session.prompt({ sessionID: crashed.id, text: "Hold package crash" })
      await crashHeld.promise
      const active = await Schema.decodeUnknownPromise(Schema.fromJsonString(Service.Info))(
        await readFile(file, "utf8"),
      )
      process.kill(active.pid, "SIGKILL")
      recovered.transport.close()
      const reconciled = YCoding.make({ endpoint: await ensure(options), location: { directory: project } })
      clients.push(reconciled)
      const failures: string[] = []
      for await (const event of reconciled.session.log({ sessionID: crashed.id, follow: false })) {
        if (event.type === "session.step.failed" || event.type === "session.execution.failed")
          failures.push(`${event.type}:${event.data.error.type}`)
      }
      expect(failures).toEqual(["session.step.failed:interrupted", "session.execution.failed:interrupted"])
      expect((await reconciled.session.outstanding()).running).not.toContain(crashed.id)
      expect(requests.filter((body) => body.includes("Hold package crash"))).toHaveLength(1)
    } finally {
      clients.forEach((client) => client.transport.close())
      await stop({ file })
      await provider.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
