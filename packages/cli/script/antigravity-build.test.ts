import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { nodeExecArgv, nodeTarget } from "../src/node/target"
import { antigravityBuildDefinitions } from "./antigravity-build-env"

const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-antigravity-build-"))
const require = createRequire(import.meta.url)
const variables = ["YCODING_ANTIGRAVITY_CLIENT_ID", "YCODING_ANTIGRAVITY_CLIENT_SECRET"] as const
const originalEnvironment = variables.map((name) => ({
  name,
  present: Object.hasOwn(process.env, name),
  value: process.env[name],
}))

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
const embedded = {
  YCODING_ANTIGRAVITY_CLIENT_ID: 'synthetic-id-"\\\n雪',
  YCODING_ANTIGRAVITY_CLIENT_SECRET: "synthetic-secret-'\"\\\n${literal}&=雪",
}
const runtime = {
  YCODING_ANTIGRAVITY_CLIENT_ID: "synthetic-runtime-id",
  YCODING_ANTIGRAVITY_CLIENT_SECRET: "synthetic-runtime-secret",
}
const runtimeEnvironments = [
  {},
  runtime,
  { YCODING_ANTIGRAVITY_CLIENT_ID: runtime.YCODING_ANTIGRAVITY_CLIENT_ID },
  { YCODING_ANTIGRAVITY_CLIENT_SECRET: runtime.YCODING_ANTIGRAVITY_CLIENT_SECRET },
  { ...runtime, YCODING_ANTIGRAVITY_CLIENT_ID: "" },
  { ...runtime, YCODING_ANTIGRAVITY_CLIENT_SECRET: "" },
  { YCODING_ANTIGRAVITY_CLIENT_ID: "", YCODING_ANTIGRAVITY_CLIENT_SECRET: "" },
]
const digest = (env: typeof embedded) =>
  createHash("sha256")
    .update(JSON.stringify([env.YCODING_ANTIGRAVITY_CLIENT_ID, env.YCODING_ANTIGRAVITY_CLIENT_SECRET]))
    .digest("hex")

test("keeps OAuth inputs synthetic while the fixture is active", () => {
  for (const variable of variables) expect(process.env[variable] === undefined).toBe(true)
})

async function bundle(kind: "bun" | "node", env: Record<string, string | undefined>, name: string) {
  for (const variable of variables) delete process.env[variable]
  Object.assign(process.env, env)
  const config = mainConfig({
    version: "synthetic",
    channel: "synthetic",
    models: "undefined",
    assetHash: "synthetic",
    target: nodeTarget(process.platform, process.arch),
  })
  for (const variable of variables) delete process.env[variable]
  const entry = path.join(directory, `${name}.ts`)
  await Bun.write(
    entry,
    `
    import { createHash } from "node:crypto"
    import { Effect } from ${JSON.stringify(require.resolve("effect"))}
    import { HttpClient, HttpClientResponse } from ${JSON.stringify(require.resolve("effect/unstable/http"))}
    import { antigravityOAuth, exchangeAntigravityCode } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../core/src/plugin/provider/antigravity.ts"))}
    const requests = []
    const http = HttpClient.make(request => Effect.sync(() => {
      if (request.url !== "https://oauth2.googleapis.com/token") throw new Error("Unexpected HTTP target")
      if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded body")
      const form = new URLSearchParams(new TextDecoder().decode(request.body.body))
      requests.push({
        grant: form.get("grant_type"),
        code: form.get("code"),
        verifier: form.get("code_verifier"),
        redirect: form.get("redirect_uri"),
        refresh: form.get("refresh_token"),
        digest: createHash("sha256").update(JSON.stringify([form.get("client_id"), form.get("client_secret")])).digest("hex"),
      })
      return HttpClientResponse.fromWeb(request, Response.json(
        process.argv.includes("--token-error") ? { error: "invalid_client" } :
        form.get("grant_type") === "authorization_code"
          ? { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 }
          : { access_token: "synthetic-refreshed-access", expires_in: 3600 }
      ))
    }))
    if (process.argv.includes("--import-only")) {
      console.log(JSON.stringify({ imported: true, requests }))
    } else {
      const results = []
      for (const operation of [
        exchangeAntigravityCode(http, "synthetic-code", "synthetic-verifier"),
        antigravityOAuth(http).refresh({ type: "oauth", methodID: "google", access: "synthetic-access", refresh: "synthetic-stored-refresh", expires: 0, metadata: { projectID: "synthetic-project" } }),
      ]) {
        results.push(await Effect.runPromise(operation.pipe(Effect.match({
          onFailure: error => ({ ok: false, error: error.message }),
          onSuccess: credential => ({
            ok: true,
            access: credential.access,
            refresh: credential.refresh,
            methodID: credential.methodID,
            expiresValid: credential.expires > Date.now(),
            metadata: credential.metadata ?? null,
          }),
        }))))
      }
      console.log(JSON.stringify({ results, requests }))
    }
  `,
  )
  const output = path.join(directory, kind === "bun" ? name : `${name}.mjs`)
  if (kind === "bun") {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      define: antigravityBuildDefinitions(env),
      minify: true,
      compile: { outfile: output, autoloadDotenv: false, autoloadBunfig: false },
    })
    expect(result.success, result.logs.map(String).join("\n")).toBe(true)
    return [output]
  }
  const productionOutput = config.build?.rollupOptions?.output
  if (!productionOutput || Array.isArray(productionOutput)) throw new Error("Expected one Node output configuration")
  await build({
    ...config,
    configFile: false,
    envFile: false,
    logLevel: "silent",
    build: {
      ...config.build,
      ssr: entry,
      target: "node24",
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: { output: { ...productionOutput, entryFileNames: path.basename(output) } },
    },
  })
  return ["node", ...nodeExecArgv.filter((argument) => argument.startsWith("--disable-warning=")), output]
}

async function run(command: string[], env: Record<string, string | undefined> = {}, args: string[] = []) {
  const child = Bun.spawn([...command, ...args], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  expect(stderr).toBe("")
  return JSON.parse(stdout)
}

for (const kind of ["bun", "node"] as const) {
  describe(`${kind} packaged Antigravity OAuth`, () => {
    test("exchange and refresh use only the embedded pair and ignore every runtime credential shape", async () => {
      const command = await bundle(kind, embedded, `${kind}-embedded`)
      for (const env of runtimeEnvironments) {
        expect(await run(command, env)).toEqual({
          results: [
            {
              ok: true,
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              methodID: "google",
              expiresValid: true,
              metadata: null,
            },
            {
              ok: true,
              access: "synthetic-refreshed-access",
              refresh: "synthetic-stored-refresh",
              methodID: "google",
              expiresValid: true,
              metadata: { projectID: "synthetic-project" },
            },
          ],
          requests: [
            {
              grant: "authorization_code",
              digest: digest(embedded),
              code: "synthetic-code",
              verifier: "synthetic-verifier",
              redirect: "http://localhost:51121/oauth-callback",
              refresh: null,
            },
            {
              grant: "refresh_token",
              digest: digest(embedded),
              code: null,
              verifier: null,
              redirect: null,
              refresh: "synthetic-stored-refresh",
            },
          ],
        })
      }
      const rejected = await run(command, runtime, ["--token-error"])
      expect(rejected.results).toEqual([
        { ok: false, error: "Google authorization failed: invalid_client" },
        { ok: false, error: "Google authorization failed: invalid_client" },
      ])
      expect(rejected.requests).toHaveLength(2)
      for (const request of rejected.requests) expect(request.digest).toBe(digest(embedded))
    }, 120_000)

    test("an unconfigured bundle imports successfully and rejects connections without HTTP requests", async () => {
      const command = await bundle(kind, {}, `${kind}-unconfigured`)
      expect(await run(command, {}, ["--import-only"])).toEqual({ imported: true, requests: [] })
      for (const env of [{}, runtime]) await rejectsConnection(command, env)
    }, 120_000)

    test("partial and empty embedded pairs fail without HTTP requests or credential diagnostics", async () => {
      for (const [index, env] of [
        { YCODING_ANTIGRAVITY_CLIENT_ID: embedded.YCODING_ANTIGRAVITY_CLIENT_ID },
        { YCODING_ANTIGRAVITY_CLIENT_SECRET: embedded.YCODING_ANTIGRAVITY_CLIENT_SECRET },
        { ...embedded, YCODING_ANTIGRAVITY_CLIENT_ID: "" },
        { ...embedded, YCODING_ANTIGRAVITY_CLIENT_SECRET: "" },
        { YCODING_ANTIGRAVITY_CLIENT_ID: "", YCODING_ANTIGRAVITY_CLIENT_SECRET: "" },
      ].entries()) {
        const command = await bundle(kind, env, `${kind}-invalid-${index}`)
        expect(await run(command, runtime, ["--import-only"])).toEqual({ imported: true, requests: [] })
        for (const runtimeEnv of [{}, runtime]) await rejectsConnection(command, runtimeEnv)
      }
    }, 120_000)
  })
}

async function rejectsConnection(command: string[], env: Record<string, string | undefined> = {}) {
  const result = await run(command, env)
  expect(result.requests).toEqual([])
  expect(result.results).toHaveLength(2)
  for (const item of result.results) {
    expect(item.ok).toBe(false)
    for (const variable of variables) expect(item.error).toContain(variable)
    expect(item.error).not.toContain("synthetic-")
  }
}
