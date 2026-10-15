import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { randomToken, sha256Hex } from "../../../../infra/cloudflare/src/auth/crypto"

export async function command(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: "ignore" | Blob } = {},
) {
  const child = Bun.spawn(args, { ...options, stdout: "pipe", stderr: "pipe", timeout: 120_000 })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Command failed (${code}): ${args[0]}\n${stdout}\n${stderr}`)
  return { code, stdout, stderr }
}

export async function updateSource(root: string, releases: { version: string; directory: string }[]) {
  await mkdir(root, { recursive: true })
  await writeFile(
    path.join(root, "openssl.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=github.com\n[ext]\nsubjectAltName=DNS:github.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n",
  )
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-config",
    path.join(root, "openssl.cnf"),
    "-keyout",
    path.join(root, "key.pem"),
    "-out",
    path.join(root, "ca.pem"),
  ])
  const files = new Map<string, string>()
  for (const release of releases) {
    const archive = `ycoding-${release.version}-darwin-arm64.tar.gz`
    const directory = path.join(root, release.version)
    await mkdir(directory)
    await command(
      [
        "/usr/bin/tar",
        "-czf",
        path.join(directory, archive),
        "-C",
        release.directory,
        "ycoding",
        "YCoding Computer Use.app",
        "ycoding-chrome-extension",
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    )
    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path.join(directory, archive)).arrayBuffer())
      .digest("hex")
    const checksums = `ycoding-${release.version}-checksums.txt`
    await writeFile(path.join(directory, checksums), `${digest}  ${archive}\n`)
    for (const name of [archive, checksums])
      files.set(`/Althenia/ycoding/releases/download/v${release.version}/${name}`, path.join(directory, name))
  }
  const requests: string[] = []
  const rejected: string[] = []
  const ready = Promise.withResolvers<number>()
  const proxy = Bun.spawn(
    ["node", path.join(import.meta.dirname, "update-proxy.mjs"), root, JSON.stringify([...files])],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const errors = new Response(proxy.stderr).text()
  const output = (async () => {
    const decode = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          port: Schema.optional(Schema.Number),
          request: Schema.optional(Schema.String),
          rejected: Schema.optional(Schema.String),
        }),
      ),
    )
    const reader = proxy.stdout.getReader()
    let pending = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      pending += new TextDecoder().decode(chunk.value)
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n")
        const event = decode(pending.slice(0, end))
        pending = pending.slice(end + 1)
        if (event.port) ready.resolve(event.port)
        if (event.request) requests.push(event.request)
        if (event.rejected) rejected.push(event.rejected)
      }
    }
    ready.reject(new Error(`Update proxy exited: ${await errors}`))
  })()
  const timeout = setTimeout(() => proxy.kill(), 10_000)
  const port = await ready.promise.finally(() => clearTimeout(timeout))
  return {
    environment: {
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: path.join(root, "ca.pem"),
    },
    requests,
    rejected,
    async close() {
      await proxy.stdin.end()
      const timeout = setTimeout(() => proxy.kill(), 10_000)
      const code = await proxy.exited
      clearTimeout(timeout)
      await output
      if (code !== 0) throw new Error(`Update proxy failed (${code}): ${await errors}`)
    },
  }
}

export async function localRelay(scratch: string) {
  const repository = path.resolve(import.meta.dirname, "../../../..")
  const configPath = path.join(scratch, "wrangler.json")
  const persist = path.join(scratch, "state")
  const wrangler = path.join(repository, "node_modules/.bin/wrangler")
  await mkdir(path.join(scratch, "assets"), { recursive: true })
  await writeFile(path.join(scratch, "assets/index.html"), "<!doctype html><title>Local packaged relay</title>")
  const config = await Bun.file(path.join(repository, "infra/cloudflare/wrangler.jsonc")).json()
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      main: path.join(repository, "infra/cloudflare/src/index.ts"),
      routes: [],
      assets: { ...config.assets, directory: path.join(scratch, "assets") },
      d1_databases: config.d1_databases.map(
        (database: { binding: string; database_name: string; database_id: string }) => ({
          ...database,
          migrations_dir: path.join(repository, "infra/cloudflare/migrations"),
        }),
      ),
    }),
  )
  const args = ["--local", "--config", configPath, "--persist-to", persist]
  const environment = { ...process.env, WRANGLER_SEND_METRICS: "false" }
  await command([wrangler, "d1", "migrations", "apply", "ycoding-prod-db", ...args], {
    cwd: repository,
    env: environment,
  })
  const cookie = `yc_session=${randomToken(32)}`
  const now = Date.now()
  await command(
    [
      wrangler,
      "d1",
      "execute",
      "ycoding-prod-db",
      ...args,
      "--command",
      `INSERT INTO "user" VALUES ('usr_packaged', ${now}); INSERT INTO browser_session (id,user_id,created_at,expires_at) VALUES ('${await sha256Hex(cookie.slice("yc_session=".length))}','usr_packaged',${now},${now + 600_000});`,
    ],
    { cwd: repository, env: environment },
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const origin = `http://127.0.0.1:${reservation.port}`
  await reservation.stop(true)
  const worker = Bun.spawn(
    [
      wrangler,
      "dev",
      ...args,
      "--port",
      new URL(origin).port,
      "--inspector-port",
      "0",
      "--var",
      "GOOGLE_CLIENT_ID:local-packaged",
      "--var",
      "GOOGLE_CLIENT_SECRET:synthetic",
      "--var",
      "GOOGLE_ALLOWED_EMAILS:packaged@example.invalid",
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe", env: environment },
  )
  const output = new Response(worker.stdout).text()
  const errors = new Response(worker.stderr).text()
  const close = async () => {
    worker.kill("SIGTERM")
    const timeout = setTimeout(() => worker.kill("SIGKILL"), 10_000)
    await worker.exited
    clearTimeout(timeout)
    await Promise.all([output, errors])
  }
  try {
    await until(
      async () =>
        (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.status === 200,
      "workerd readiness",
      90_000,
    )
    return {
      origin,
      cookie,
      async json(route: string, body?: unknown) {
        const response = await fetch(`${origin}${route}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`Local relay ${route}: ${response.status}`)
        return response.json()
      },
      close,
    }
  } catch (error) {
    await close()
    throw new Error(`Local relay startup failed\n${await output}\n${await errors}`, { cause: error })
  }
}

export async function until(predicate: () => Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(100)
  }
}
