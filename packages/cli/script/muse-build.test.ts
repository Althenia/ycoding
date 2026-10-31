import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { nodeExecArgv, nodeTarget } from "../src/node/target"
import { museBuildDefinitions } from "./muse-build-env"

const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-muse-build-"))
const require = createRequire(import.meta.url)
const variables = ["YCODING_MUSE_CLIENT_ID", "YCODING_MUSE_CLIENT_SECRET"] as const
const originalEnvironment = variables.map((name) => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }))
afterAll(async () => {
  try {
    await rm(directory, { recursive: true, force: true })
  } finally {
    for (const original of originalEnvironment) {
      if (original.present) {
        process.env[original.name] = original.value
        continue
      }
      delete process.env[original.name]
    }
  }
})
for (const variable of variables) delete process.env[variable]
const { mainConfig } = await import("../vite.node.config")
const embedded = { YCODING_MUSE_CLIENT_ID: 'synthetic-id-"\\\n雪', YCODING_MUSE_CLIENT_SECRET: "synthetic-secret-'\"\\\n${literal}&=雪" }
const runtime = { YCODING_MUSE_CLIENT_ID: "synthetic-runtime-id", YCODING_MUSE_CLIENT_SECRET: "synthetic-runtime-secret" }
const runtimeEnvironments = [{}, runtime, { YCODING_MUSE_CLIENT_ID: runtime.YCODING_MUSE_CLIENT_ID }, { YCODING_MUSE_CLIENT_SECRET: runtime.YCODING_MUSE_CLIENT_SECRET }, { ...runtime, YCODING_MUSE_CLIENT_ID: "" }, { ...runtime, YCODING_MUSE_CLIENT_SECRET: "" }, { YCODING_MUSE_CLIENT_ID: "", YCODING_MUSE_CLIENT_SECRET: "" }]
const digest = (id: string, secret: string | null) => createHash("sha256").update(JSON.stringify([id, secret])).digest("hex")

test("keeps OAuth inputs synthetic while the fixture is active", () => {
  for (const variable of variables) expect(process.env[variable] === undefined).toBe(true)
})

async function bundle(kind: "bun" | "node", env: Record<string, string | undefined>, name: string) {
  for (const variable of variables) delete process.env[variable]
  Object.assign(process.env, env)
  const config = mainConfig({ version: "synthetic", channel: "synthetic", models: "undefined", assetHash: "synthetic", target: nodeTarget(process.platform, process.arch) })
  for (const variable of variables) delete process.env[variable]
  const entry = path.join(directory, `${name}.ts`)
  await Bun.write(entry, `
    import { createHash } from "node:crypto"
    import { Effect } from ${JSON.stringify(require.resolve("effect"))}
    import { HttpClient, HttpClientResponse } from ${JSON.stringify(require.resolve("effect/unstable/http"))}
    import { museOAuth } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../core/src/plugin/provider/muse.ts"))}
    const requests = []
    const http = HttpClient.make(request => Effect.sync(() => {
      if (request.method !== "POST") throw new Error("Unexpected HTTP method")
      if (!["https://auth.meta.com/oidc/device/authorization/", "https://auth.meta.com/oidc/device/token/"].includes(request.url)) throw new Error("Unexpected HTTP target")
      if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded body")
      const form = new URLSearchParams(new TextDecoder().decode(request.body.body))
      requests.push({ url: request.url, digest: createHash("sha256").update(JSON.stringify([form.get("client_id"), form.get("client_secret")])).digest("hex") })
      const device = request.url.endsWith("authorization/")
      const error = !device && process.argv.includes("--token-error")
      return HttpClientResponse.fromWeb(request, Response.json(device
        ? { device_code: "synthetic-device", user_code: "CODE", verification_uri: "https://auth.meta.com/device", expires_in: 60, interval: 1 }
        : error ? { error: "invalid_client" } : { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 }, { status: error ? 400 : 200 }))
    }))
    if (process.argv.includes("--import-only")) {
      console.log(JSON.stringify({ imported: true, requests }))
    } else {
      const result = await Effect.runPromise(museOAuth(http).authorize({}).pipe(
        Effect.flatMap(authorization => authorization.callback),
        Effect.match({ onFailure: error => ({ ok: false, error: error.message }), onSuccess: credential => ({ ok: true, access: credential.access, refresh: credential.refresh }) })
      ))
      console.log(JSON.stringify({ result, requests }))
    }
  `)
  const output = path.join(directory, kind === "bun" ? name : `${name}.mjs`)
  if (kind === "bun") {
    const result = await Bun.build({ entrypoints: [entry], target: "bun", define: museBuildDefinitions(env), minify: true, compile: { outfile: output, autoloadDotenv: false, autoloadBunfig: false } })
    expect(result.success, result.logs.map(String).join("\n")).toBe(true)
    return [output]
  }
  const productionOutput = config.build?.rollupOptions?.output
  if (!productionOutput || Array.isArray(productionOutput)) throw new Error("Expected one Node output configuration")
  await build({ ...config, configFile: false, envFile: false, logLevel: "silent", build: { ...config.build, ssr: entry, target: "node24", outDir: directory, emptyOutDir: false, rollupOptions: { output: { ...productionOutput, entryFileNames: path.basename(output) } } } })
  return ["node", ...nodeExecArgv.filter((argument) => argument.startsWith("--disable-warning=")), output]
}

async function run(command: string[], env: Record<string, string | undefined> = {}, args: string[] = []) {
  const child = Bun.spawn([...command, ...args], { cwd: directory, env: { PATH: process.env.PATH, HOME: directory, ...env }, stdout: "pipe", stderr: "pipe", timeout: 20_000 })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(code, stderr).toBe(0)
  expect(stderr).toBe("")
  return JSON.parse(stdout)
}

for (const kind of ["bun", "node"] as const) {
  describe(`${kind} packaged Muse OAuth`, () => {
    test("embedded credentials are used for both requests regardless of runtime values", async () => {
      for (const [index, env] of [embedded, { YCODING_MUSE_CLIENT_ID: embedded.YCODING_MUSE_CLIENT_ID }, { YCODING_MUSE_CLIENT_ID: embedded.YCODING_MUSE_CLIENT_ID, YCODING_MUSE_CLIENT_SECRET: "" }].entries()) {
        const command = await bundle(kind, env, `${kind}-embedded-${index}`)
        const expectedDigest = digest(env.YCODING_MUSE_CLIENT_ID, "YCODING_MUSE_CLIENT_SECRET" in env && env.YCODING_MUSE_CLIENT_SECRET ? env.YCODING_MUSE_CLIENT_SECRET : null)
        const requests = ["authorization", "token"].map((endpoint) => ({ url: `https://auth.meta.com/oidc/device/${endpoint}/`, digest: expectedDigest }))
        for (const runtimeEnv of runtimeEnvironments) expect(await run(command, runtimeEnv)).toEqual({ result: { ok: true, access: "synthetic-access", refresh: "synthetic-refresh" }, requests })
        const rejected = await run(command, runtime, ["--token-error"])
        expect(rejected.result.ok).toBe(false)
        expect(rejected.result.error).toContain("invalid_client")
        expect(rejected.requests).toEqual(requests)
      }
    }, 120_000)

    test("missing and empty embedded IDs import and reject authorization without HTTP", async () => {
      for (const [index, env] of [{}, { YCODING_MUSE_CLIENT_SECRET: "synthetic-secret" }, { YCODING_MUSE_CLIENT_ID: "", YCODING_MUSE_CLIENT_SECRET: "synthetic-secret" }].entries()) {
        const command = await bundle(kind, env, `${kind}-invalid-${index}`)
        expect(await run(command, {}, ["--import-only"])).toEqual({ imported: true, requests: [] })
        for (const runtimeEnv of [{}, runtime]) {
          const result = await run(command, runtimeEnv)
          expect(result.requests).toEqual([])
          expect(result.result.ok).toBe(false)
          expect(result.result.error).toContain("YCODING_MUSE_CLIENT_ID")
          expect(result.result.error).not.toContain("synthetic-")
        }
      }
    }, 120_000)
  })
}
