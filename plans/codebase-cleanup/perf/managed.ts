import { access, mkdtemp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

type Registration = { readonly id: string; readonly url: string; readonly pid: number; readonly password: string }
type Sample = { readonly registrationMs: number; readonly healthMs: number; readonly readyRssMiB: number }

function option(args: Map<string, string>, name: string, fallback: number, minimum: number, maximum: number) {
  const value = args.has(name) ? Number(args.get(name)) : fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`Invalid --${name}: expected ${minimum}..${maximum}`)
  return value
}

function distribution(values: readonly number[]) {
  if (values.length === 0) throw new Error("No completed managed boot samples")
  const sorted = values.toSorted((left, right) => left - right)
  return { n: sorted.length, median: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
}

async function deadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Could not reserve a loopback port")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function rssMiB(pid: number) {
  const probe = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
  try {
    const output = await deadline(new Response(probe.stdout).text(), 3_000, "RSS probe")
    if (await probe.exited !== 0) throw new Error("RSS probe failed")
    const kib = Number(output.trim())
    if (!Number.isFinite(kib) || kib <= 0) throw new Error("RSS probe returned no live process")
    return kib / 1024
  } finally {
    if (probe.exitCode === null) probe.kill("SIGTERM")
    await probe.exited
  }
}

async function waitForRegistration(root: string, child: ReturnType<typeof Bun.spawn>, stopAt: number) {
  const directory = join(root, "state", "ycoding")
  for (;;) {
    if (child.exitCode !== null) throw new Error("Compiled managed service exited before registration")
    const files = (await readdir(directory).catch(() => [])).filter((name) => name === "service.json" || /^service-[^.]+\.json$/.test(name))
    if (files.length > 1) throw new Error("Multiple private service registrations appeared")
    if (files.length === 1) {
      const path = join(directory, files[0])
      const value: unknown = JSON.parse(await readFile(path, "utf8"))
      if (typeof value !== "object" || value === null) throw new Error("Managed registration was not an object")
      const id = Reflect.get(value, "id")
      const url = Reflect.get(value, "url")
      const pid = Reflect.get(value, "pid")
      const password = Reflect.get(value, "password")
      if (typeof id !== "string" || id.length === 0 || typeof url !== "string" || pid !== child.pid ||
        typeof password !== "string" || password.length === 0) throw new Error("Managed registration did not match the spawned process")
      return { path, info: { id, url, pid, password } satisfies Registration }
    }
    if (Date.now() >= stopAt) throw new Error("Managed registration did not appear before deadline")
    await Bun.sleep(25)
  }
}

async function waitForReady(info: Registration, child: ReturnType<typeof Bun.spawn>, stopAt: number) {
  const authorization = `Basic ${Buffer.from(`ycoding:${info.password}`).toString("base64")}`
  for (;;) {
    if (child.exitCode !== null) throw new Error("Compiled managed service exited before readiness")
    const response = await fetch(new URL("/api/health", info.url), {
      headers: { authorization }, signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined)
    if (response?.status === 200) {
      const body: unknown = await response.json()
      if (typeof body !== "object" || body === null || Reflect.get(body, "healthy") !== true ||
        Reflect.get(body, "pid") !== child.pid || Reflect.get(body, "sourceEpoch") !== info.id)
        throw new Error("Authenticated health did not match the registered service instance")
      return authorization
    }
    if (response && response.status !== 503) throw new Error(`Managed health returned ${response.status}`)
    if (Date.now() >= stopAt) throw new Error("Managed service did not become ready before deadline")
    await Bun.sleep(25)
  }
}

async function stopManaged(info: Registration, authorization: string, registration: string, child: ReturnType<typeof Bun.spawn>) {
  const response = await fetch(new URL("/api/service/stop", info.url), {
    method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ instanceID: info.id }), signal: AbortSignal.timeout(5_000),
  })
  const body: unknown = await response.json()
  if (response.status !== 200 || typeof body !== "object" || body === null || Reflect.get(body, "accepted") !== true)
    throw new Error("Managed service rejected exact-instance stop")
  if (await deadline(child.exited, 10_000, "Managed service exit") !== 0) throw new Error("Managed service exited unsuccessfully")
  for (let index = 0; index < 200 && await Bun.file(registration).exists(); index++) await Bun.sleep(25)
  if (await Bun.file(registration).exists()) throw new Error("Managed service registration remained after stop")
}

async function sample(binary: string, root: string, maxRssMiB: number): Promise<Sample> {
  const port = await availablePort()
  const started = performance.now()
  const child = Bun.spawn([binary, "serve", "--service", "--port", String(port)], {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: root, USERPROFILE: root, YCODING_TEST_HOME: root,
      XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
      TMPDIR: join(root, "tmp"), YCODING_DB: join(root, "data", "server.db"),
      YCODING_CONFIG_DIR: join(root, "config", "ycoding"), YCODING_CONFIG_PROJECT_DISABLE: "1",
      YCODING_DISABLE_MODELS_FETCH: "1", YCODING_FILEWATCHER_DISABLE: "1", YCODING_DISABLE_FFF: "1",
      YCODING_CONFIG_CONTENT: "{}", NO_COLOR: "1",
    },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  })
  const interrupt = () => { process.exitCode = 130; if (child.exitCode === null) child.kill("SIGTERM") }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    const registered = await waitForRegistration(root, child, Date.now() + 30_000)
    const registrationMs = performance.now() - started
    const url = new URL(registered.info.url)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== port || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw new Error("Managed registration did not identify the reserved loopback server")
    const authorization = await waitForReady(registered.info, child, Date.now() + Math.max(1, 30_000 - registrationMs))
    const healthMs = performance.now() - started
    const readyRssMiB = await rssMiB(child.pid)
    if (readyRssMiB > maxRssMiB) throw new Error("Managed server exceeded the RSS bound")
    await stopManaged(registered.info, authorization, registered.path, child)
    return { registrationMs, healthMs, readyRssMiB }
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    if (child.exitCode === null) child.kill("SIGTERM")
    try { await deadline(child.exited, 5_000, "Managed cleanup") }
    catch { child.kill("SIGKILL"); await deadline(child.exited, 5_000, "Forced managed cleanup") }
  }
}

async function run() {
  const args = new Map(process.argv.slice(2).map((item) => {
    const match = /^--([a-z-]+)=(.*)$/.exec(item)
    if (!match) throw new Error("Expected --name=value arguments")
    return [match[1], match[2]] as const
  }))
  const binary = args.get("binary")
  if (!binary || !isAbsolute(binary)) throw new Error("Supply --binary=/absolute/path/to/compiled/ycoding")
  await access(binary, constants.X_OK)
  if (!(await stat(binary)).isFile()) throw new Error("Compiled binary must be a regular executable file")
  const mode = args.get("mode") ?? "sanity"
  if (mode !== "sanity" && mode !== "benchmark") throw new Error("Invalid --mode")
  const samples = mode === "sanity" ? 1 : option(args, "samples", 30, 30, 100)
  const warmup = mode === "sanity" ? 0 : option(args, "warmup", 5, 3, 20)
  const maxRssMiB = option(args, "max-rss-mib", 8192, 128, 8192)
  const root = await mkdtemp(join(tmpdir(), "ycoding-perf-managed-"))
  const results: Sample[] = []
  try {
    for (let index = -warmup; index < samples; index++) {
      const isolated = join(root, `sample-${index}`)
      try {
        await Promise.all(["cache", "config", "data", "state", "tmp"].map((name) => mkdir(join(isolated, name), { recursive: true })))
        const result = await sample(binary, isolated, maxRssMiB)
        if (index >= 0) results.push(result)
      } finally { await rm(isolated, { recursive: true, force: true }) }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
  const registrationSamplesMs = results.map((item) => item.registrationMs)
  const healthSamplesMs = results.map((item) => item.healthMs)
  const readyRssSamplesMiB = results.map((item) => item.readyRssMiB)
  console.log(JSON.stringify({ mode, boundary: "compiled-managed-service", samples, warmup,
    readiness: "spawn compiled serve --service through private registration to authenticated health 200 matching PID and instance",
    registrationMs: distribution(registrationSamplesMs), registrationSamplesMs,
    healthMs: distribution(healthSamplesMs), healthSamplesMs,
    readyRssMiB: distribution(readyRssSamplesMiB), readyRssSamplesMiB }))
}

await run()
