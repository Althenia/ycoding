import assert from "node:assert/strict"
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { base64UrlEncode, sha256Hex } from "../../src/auth/crypto"

const repository = resolve(import.meta.dirname, "../../../..")
const cloudflare = join(repository, "infra/cloudflare")
const wrangler = join(repository, "node_modules/.bin/wrangler")
const accounts = ["owner", "other"] as const

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isolatedEnvironment(root: string) {
  return {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
  }
}

export async function startWorker(root: string, assetsDirectory?: string) {
  await mkdir(root, { recursive: true })
  const persist = join(root, "state")
  const config = join(root, "wrangler.json")
  const source: unknown = Bun.JSONC.parse(await readFile(join(cloudflare, "wrangler.jsonc"), "utf8"))
  assert.ok(record(source) && typeof source.main === "string" && typeof source.compatibility_date === "string")
  assert.ok(record(source.assets) && typeof source.assets.directory === "string")
  const directory = assetsDirectory ?? resolve(cloudflare, source.assets.directory)
  await access(join(directory, "index.html"))
  const generated = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )
  assert.ok("publicKey" in generated && "privateKey" in generated)
  const key = generated
  const jwk = { ...(await crypto.subtle.exportKey("jwk", key.publicKey)), kid: "local-test", alg: "RS256", use: "sig" }
  let idToken: string | undefined
  const oidc = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/certs":
          return Response.json({ keys: [jwk] })
        case "/token":
          return idToken
            ? Response.json({ id_token: idToken, access_token: "local-test" })
            : new Response(null, { status: 400 })
        default:
          return new Response(null, { status: 404 })
      }
    },
  })
  const issuer = oidc.url.origin
  const env = { ...isolatedEnvironment(root), WRANGLER_SEND_METRICS: "false", WRANGLER_HIDE_BANNER: "true", CI: "1" }
  const database = "relay-acceptance"
  const d1 = async (...args: string[]) => {
    const child = Bun.spawn(
      [wrangler, "d1", "execute", database, "--local", "--config", config, "--persist-to", persist, "--json", ...args],
      {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    assert.equal(code, 0, `local fixture D1 command failed: ${stderr}\n${stdout}`)
    const result: unknown = JSON.parse(stdout)
    assert.ok(Array.isArray(result) && result.every(record))
    return result
  }
  let worker: ReturnType<typeof Bun.spawn> | undefined
  const close = async () => {
    await oidc.stop(true)
    if (!worker) return
    worker.kill("SIGTERM")
    const timer = setTimeout(() => worker?.kill("SIGKILL"), 5000)
    try {
      await worker.exited
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await writeFile(
      config,
      JSON.stringify({
        name: "ycoding-relay-acceptance",
        main: resolve(cloudflare, source.main),
        compatibility_date: source.compatibility_date,
        assets: { ...source.assets, directory },
        durable_objects: source.durable_objects,
        exports: source.exports,
        d1_databases: [{ binding: "DB", database_name: database, database_id: crypto.randomUUID() }],
        vars: {
          GOOGLE_CLIENT_ID: "local-test",
          GOOGLE_CLIENT_SECRET: "local-test",
          GOOGLE_ALLOWED_EMAILS: accounts.map((account) => `${account}@example.invalid`).join(","),
          GOOGLE_ISSUER: issuer,
          GOOGLE_AUTHORIZATION_ENDPOINT: `${issuer}/authorize`,
          GOOGLE_TOKEN_ENDPOINT: `${issuer}/token`,
          GOOGLE_JWKS_URI: `${issuer}/certs`,
        },
      }),
    )
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const port = listener.port
    listener.stop(true)
    const origin = `http://127.0.0.1:${port}`
    worker = Bun.spawn(
      [
        wrangler,
        "dev",
        "--local",
        "--config",
        config,
        "--persist-to",
        persist,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        "0",
      ],
      {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    await eventually("local workerd readiness", async () => {
      assert.equal(worker?.exitCode, null, "Wrangler exited during startup")
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined)
      return response?.status === 200 ? true : undefined
    })
    return {
      origin,
      assetsDirectory: directory,
      close,
      async initializeDatabase() {
        const ddl = join(cloudflare, "migrations")
        for (const file of (await readdir(ddl)).filter((name) => name.endsWith(".sql")).sort())
          await d1("--file", join(ddl, file))
      },
      async signIn(account: (typeof accounts)[number], returnPath = "/remote/") {
        const startURL = new URL("/api/auth/google/start", origin)
        startURL.searchParams.set("redirect_after", returnPath)
        const start = await fetch(startURL, { redirect: "manual" })
        assert.equal(start.status, 302, "OAuth start")
        const oauth = cookie(start, "yc_oauth")
        const state = new URL(start.headers.get("location") ?? "").searchParams.get("state")
        assert.ok(state)
        const transaction = await sha256Hex(oauth.slice("yc_oauth=".length))
        const [query] = await d1("--command", `SELECT nonce FROM oauth_transaction WHERE id = '${transaction}'`)
        const rows = query?.results
        const row: unknown = Array.isArray(rows) ? rows[0] : undefined
        const nonce = record(row) ? row.nonce : undefined
        assert.ok(typeof nonce === "string" && nonce, "OAuth start must persist a nonce in local D1")
        const now = Math.floor(Date.now() / 1000)
        const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
        const unsigned = `${encode({ alg: "RS256", kid: jwk.kid, typ: "JWT" })}.${encode({
          iss: issuer,
          aud: "local-test",
          sub: account,
          iat: now,
          exp: now + 3600,
          nonce,
          email: `${account}@example.invalid`,
          email_verified: true,
        })}`
        const signature = await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          key.privateKey,
          new TextEncoder().encode(unsigned),
        )
        idToken = `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`
        try {
          const callback = await fetch(`${origin}/api/auth/google/callback?code=local-test&state=${state}`, {
            headers: { cookie: oauth },
            redirect: "manual",
          })
          assert.equal(callback.status, 302, "OAuth callback")
          assert.equal(
            callback.headers.get("location"),
            returnPath,
            "OAuth callback must preserve the edition return path",
          )
          return cookie(callback, "yc_session")
        } finally {
          idToken = undefined
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

export async function eventually<T>(
  label: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeout = 20_000,
): Promise<T> {
  const end = performance.now() + timeout
  for (;;) {
    const result = await read()
    if (result !== undefined) return result
    assert.ok(performance.now() < end, `${label} timed out`)
    await Bun.sleep(50)
  }
}

function cookie(response: Response, name: string) {
  const value = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${name}=`))
    ?.split(";")[0]
  assert.ok(value, `OAuth response did not set ${name}`)
  return value
}
