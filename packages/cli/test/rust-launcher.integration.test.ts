import { expect, test } from "bun:test"
import { ensure, stop } from "@ycoding-ai/client/service"
import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/v5"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"

test("CLI managed launch discovers Rust identity, reuses it and preserves the restart password", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-rust-cli-"))
  const file = path.join(root, "state/ycoding/service-local.json")
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
  const command = [
    process.execPath,
    "-e",
    `Object.assign(process.env, ${JSON.stringify(environment)}); process.argv = [process.execPath, ${JSON.stringify(cli)}, "serve", "--service", "--port", "0"]; await import(${JSON.stringify(cli)});`,
  ]
  const options = { file, command, version: "local", startupErrorFile: path.join(root, "startup-error") }
  const clients: ReturnType<typeof YCoding.make>[] = []
  try {
    const endpoint = await ensure(options)
    const first = await Schema.decodeUnknownPromise(Schema.fromJsonString(Service.Info))(await readFile(file, "utf8"))
    expect(first.pid).not.toBe(process.pid)
    const client = YCoding.make({ endpoint })
    clients.push(client)
    expect(await client.health.get()).toMatchObject({ healthy: true, pid: first.pid, version: "local" })
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
