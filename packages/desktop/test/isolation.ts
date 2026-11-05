import { headers } from "@ycoding-ai/client/service"
import dgram from "node:dgram"
import { constants, lstatSync } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { bundledBackend } from "../src/resources"

export type FakeRequest = { readonly method: string; readonly path: string; readonly model?: string }
export type Command = readonly [string, ...string[]]
type OwnedRoot = { readonly path: string }
type Endpoint = { readonly port: number }
type Backend = Awaited<ReturnType<typeof bundledGrant>>

const sandbox = "/usr/bin/sandbox-exec"
const systemReads = ["/usr/lib", "/System/Library", "/System/Cryptexes/OS", "/System/Volumes/Preboot/Cryptexes/OS"]
const devices = ["/dev/null", "/dev/random", "/dev/urandom"]
const probeTools = ["/bin/bash", "/bin/cat", "/bin/ls", "/usr/bin/nc"]
const credentialName = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE|SOCK/
const denied = "Operation not permitted"

export async function syntheticEnv(root: string, provider: string) {
  const home = process.env.HOME
  if (!home) throw new Error("HOME must be set.")
  const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }
  for (const key of ["LANG", "USER", "LOGNAME"]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  const tmp = path.join(root, "tmp")
  const testHome = path.join(root, "home")
  await Promise.all([fs.mkdir(tmp), fs.mkdir(testHome)])
  return {
    ...env,
    TMPDIR: tmp,
    YCODING_TEST_HOME: testHome,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    YCODING_DB: path.join(root, "runtime.db"),
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_DISABLE_AUTOUPDATE: "1",
    YCODING_DISABLE_PROJECT_CONFIG: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    YCODING_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      share: "disabled",
      capabilities: { home_roots: false },
      model: "desktop-fake/echo",
      providers: {
        "desktop-fake": {
          name: "Desktop synthetic",
          package: "@ycoding-ai/ai/providers/openai-compatible",
          settings: { baseURL: provider, apiKey: "synthetic-key" },
          models: { echo: { name: "Synthetic echo" } },
        },
      },
    }),
  }
}

function inside(child: string, parent: string) {
  const relative = path.relative(parent, child)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function quoted(value: string) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || /["\\\p{Cc}]/u.test(value)) throw new Error(`Unsupported confinement path: ${JSON.stringify(value)}`)
  return `"${value}"`
}

function ancestors(target: string) {
  const list: string[] = []
  for (let current = path.dirname(target); ; current = path.dirname(current)) {
    list.push(current)
    if (current === path.dirname(current)) return list
  }
}

async function ownedDirectory(parent: string, home: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(parent, "f-")))
  const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || inside(home, directory) || inside(directory, home))
    throw new Error("Each owned fixture root must be a new private directory outside HOME.")
  return directory
}

async function bundledGrant(resources: string, home: string) {
  const root = await fs.realpath(resources)
  const binary = await bundledBackend(root)
  const directory = path.join(root, "backend")
  const manifest = path.join(root, "backend.json")
  const info = await fs.lstat(manifest)
  if (await fs.realpath(directory) !== directory || binary.executable !== path.join(directory, "ycoding") || !info.isFile() || inside(home, root))
    throw new Error("The bundled backend must be a canonical, digest-verified directory that does not contain HOME.")
  return { resources: root, directory, manifest, executable: binary.executable, version: binary.version }
}

function profile(input: { readonly owned: string; readonly cwd: string; readonly backend: Backend; readonly connect: readonly number[]; readonly tools?: readonly string[] }) {
  for (const port of input.connect)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Unsupported confinement port: ${port}`)
  const tools = input.tools ?? []
  const executables = [input.backend.executable, ...tools]
  const subpaths = [...systemReads, input.backend.directory, input.cwd]
  const literals = [input.backend.manifest, ...devices, ...tools]
  const metadata = [...new Set([...subpaths, ...literals, input.owned].flatMap(ancestors))]
  const list = (kind: string, items: readonly string[]) => items.map((item) => `(${kind} ${quoted(item)})`).join(" ")
  return [
    "(version 1)",
    "(deny default)",
    '(import "dyld-support.sb")',
    "(allow process-fork)",
    `(allow process-exec ${list("literal", executables)})`,
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow dynamic-code-generation)",
    `(allow file-read-metadata ${list("literal", metadata)})`,
    `(allow file-read* ${list("subpath", subpaths)} ${list("literal", literals)})`,
    `(allow file-map-executable ${list("subpath", systemReads)} ${list("literal", executables)})`,
    `(allow file-read* file-write* ${list("subpath", [input.owned])})`,
    `(allow file-write-data ${list("literal", ["/dev/null"])})`,
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    ...input.connect.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
  ].join("\n")
}

async function execute(command: Command, env: Record<string, string>) {
  const child = Bun.spawn([...command], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

function listener(options: net.ListenOptions) {
  let connections = 0
  const server = net.createServer((socket) => { connections++; socket.destroy() })
  return new Promise<{ readonly port: number; readonly connections: () => number; readonly close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options, () => {
      const address = server.address()
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        connections: () => connections,
        close: () => new Promise<void>((done) => { server.close(() => done()) }),
      })
    })
  })
}

function datagrams() {
  let received = 0
  const socket = dgram.createSocket("udp4")
  socket.on("message", () => { received++ })
  return new Promise<{ readonly port: number; readonly received: () => number; readonly close: () => Promise<void> }>((resolve, reject) => {
    socket.once("error", reject)
    socket.bind(0, "127.0.0.1", () => resolve({
      port: socket.address().port,
      received: () => received,
      close: () => new Promise<void>((done) => { socket.close(() => done()) }),
    }))
  })
}

async function freePort() {
  const reserved = await listener({ host: "127.0.0.1", port: 0 })
  await reserved.close()
  return reserved.port
}

async function homeProbeTarget(home: string, granted: readonly string[]) {
  const file = fileURLToPath(new URL("../../../LICENSE", import.meta.url))
  const info = await fs.lstat(file)
  const target = await fs.realpath(file)
  if (!info.isFile() || !inside(target, home) || granted.some((item) => inside(target, item)))
    throw new Error("The HOME read probe needs the repository LICENSE as a regular file inside HOME and outside every granted path.")
  return target
}

async function probe(run: string, home: string, cwd: string, backend: Backend) {
  const root = await ownedDirectory(run, home)
  const elsewhere = await ownedDirectory(run, home)
  const readable = path.join(root, "inside")
  const outside = path.join(elsewhere, "outside")
  const written = path.join(elsewhere, "written")
  await Promise.all([fs.writeFile(readable, "inside\n"), fs.writeFile(outside, "outside\n")])
  const manifest = fileURLToPath(new URL("../package.json", import.meta.url))
  const homeWrite = path.join(home, `.ycoding-desktop-isolation-probe-${crypto.randomUUID()}`)
  const exists = (file: string) => fs.lstat(file).then(() => true, () => false)
  const closers: (() => Promise<void>)[] = []
  const open = async <T extends { readonly close: () => Promise<void> }>(created: Promise<T>) => {
    const value = await created
    closers.push(value.close)
    return value
  }
  const verify = (name: string, passed: boolean, result: { readonly code: number; readonly stderr: string }) => {
    if (!passed) {
      const stderr = result.stderr.trim()
      const tail = stderr.slice(-1200)
      const lines = stderr.split("\n").filter((line) => line.startsWith("error:") || line.includes("Error")).map((line) => line.slice(0, 300)).filter((line) => !tail.includes(line)).slice(0, 8)
      throw new Error(`Backend confinement is not in force; no native backend was started. ${name}: exit ${result.code}; ${[...lines, tail].join("\n")}`)
    }
  }
  const refusedBy = (result: { readonly code: number; readonly stderr: string }) => result.code !== 0 && result.stderr.includes(denied)
  try {
    if (!(await fs.lstat(manifest)).isFile()) throw new Error("The desktop package manifest is missing.")
    const license = await homeProbeTarget(home, [root, elsewhere, cwd, backend.directory, backend.manifest, ...systemReads, ...devices, ...probeTools])
    const allowed = await open(listener({ host: "127.0.0.1", port: 0 }))
    const refused = await open(listener({ host: "127.0.0.1", port: 0 }))
    const refused6 = await open(listener({ host: "::1", port: 0 }))
    const udp = await open(datagrams())
    const socket = await open(listener({ path: path.join(root, "s") }))
    const env = await syntheticEnv(root, "http://127.0.0.1:9/v1")
    const observer = path.join(run, "unix-connect")
    const built = await execute(["/usr/bin/cc", "-O2", "-Wall", "-Werror", "-o", observer, fileURLToPath(new URL("./unix-connect.c", import.meta.url))], env)
    if (built.code !== 0) throw new Error(`The Unix-socket observer did not compile: exit ${built.code}; ${built.stderr.trim().slice(0, 300)}`)
    const confined = (command: Command): Command => [sandbox, "-p", profile({ owned: root, cwd, backend, connect: [allowed.port] }), ...command]
    const tools = (command: Command): Command => [sandbox, "-p", profile({ owned: root, cwd, backend, connect: [allowed.port], tools: probeTools }), ...command]
    const observed = (command: Command): Command => [sandbox, "-p", profile({ owned: root, cwd, backend, connect: [allowed.port], tools: [observer] }), ...command]
    const own = await execute(tools(["/bin/cat", readable]), env)
    verify("an owned file is readable", own.code === 0 && own.stdout === "inside\n", own)
    const sibling = await execute(tools(["/bin/cat", outside]), env)
    verify("reading a synthetic file outside the owned root is refused", refusedBy(sibling), sibling)
    const child = await execute(tools(["/bin/bash", "-c", '/bin/cat "$1"', "probe", outside]), env)
    verify("a descendant process stays confined", refusedBy(child), child)
    const write = await execute(tools(["/bin/bash", "-c", 'printf x > "$1"', "probe", written]), env)
    verify("writing outside the owned root is refused", refusedBy(write) && !(await exists(written)), write)
    for (const command of [["/usr/bin/true"], ["/bin/cat", readable]] as const) {
      const result = await execute(confined(command), env)
      verify(`the backend boundary refuses to execute ${command[0]}`, refusedBy(result), result)
    }
    for (const target of ["/private/etc/hosts", license, manifest]) {
      const result = await execute(tools(["/bin/cat", target]), env)
      verify(`reading ${target} is refused`, refusedBy(result), result)
    }
    const listing = await execute(tools(["/bin/ls", "-a", home]), env)
    verify("listing HOME is refused", refusedBy(listing) && listing.stdout === "", listing)
    const homeWritten = await execute(tools(["/bin/bash", "-c", 'set -C; printf x > "$1"', "probe", homeWrite]), env)
    const created = await exists(homeWrite)
    if (created) await fs.rm(homeWrite)
    verify("writing a new file into HOME is refused", refusedBy(homeWritten) && !created, homeWritten)
    const reached = await execute(tools(["/usr/bin/nc", "-z", "-G", "2", "127.0.0.1", String(allowed.port)]), env)
    for (const deadline = Date.now() + 2_000; allowed.connections() === 0 && Date.now() < deadline; await Bun.sleep(20));
    verify("the exact allowed loopback destination is reachable", reached.code === 0 && allowed.connections() === 1, reached)
    const other = await execute(tools(["/usr/bin/nc", "-v", "-n", "-z", "-G", "2", "127.0.0.1", String(refused.port)]), env)
    verify("another loopback port is refused", refusedBy(other) && refused.connections() === 0, other)
    const other6 = await execute(tools(["/usr/bin/nc", "-v", "-n", "-z", "-G", "2", "::1", String(refused6.port)]), env)
    verify("another IPv6 loopback port is refused", refusedBy(other6) && refused6.connections() === 0, other6)
    const datagram = await execute(tools(["/bin/bash", "-c", 'printf x | /usr/bin/nc -v -n -u -w 1 127.0.0.1 "$1"', "probe", String(udp.port)]), env)
    await Bun.sleep(200)
    verify("UDP to another loopback port is refused", refusedBy(datagram) && udp.received() === 0, datagram)
    const unix = await execute(observed([observer, path.join(root, "s")]), env)
    verify("a Unix socket inside the owned root is refused", refusedBy(unix) && socket.connections() === 0, unix)
    const remote = await execute(tools(["/usr/bin/nc", "-v", "-n", "-z", "-G", "2", "192.0.2.1", "9"]), env)
    verify("a remote address is refused", refusedBy(remote), remote)
    const version = await execute(confined([backend.executable, "--version"]), env)
    verify("the confined bundled backend starts", version.code === 0 && version.stdout.trim() === `ycoding v${backend.version}`, version)
  } finally {
    await Promise.all(closers.map((close) => close()))
    await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(elsewhere, { recursive: true, force: true })])
  }
}

export type ProcessRecord = { readonly pid: number; readonly ppid: number; readonly exe: string | undefined }
export type Listener = { readonly pid: number; readonly ppid: number }

const decimal = (value: string) => {
  const number = /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined
}

export function parseListeners(output: string): Listener[] | undefined {
  const records: Listener[] = []
  let state: "none" | "pid" | "parent" = "none"
  let pid = 0
  for (const line of output.split("\n")) {
    if (!line) continue
    const value = line.slice(1)
    if (line[0] === "p" && state !== "pid") {
      const parsed = decimal(value)
      if (parsed === undefined) return undefined
      pid = parsed
      state = "pid"
    } else if (line[0] === "R" && state === "pid") {
      const parsed = decimal(value)
      if (parsed === undefined) return undefined
      records.push({ pid, ppid: parsed })
      state = "parent"
    } else if (!(line[0] === "f" && state === "parent" && /^[0-9]+$/.test(value))) return undefined
  }
  return state === "pid" ? undefined : records
}

export function parseProcess(output: string): ProcessRecord | undefined {
  let state: "none" | "pid" | "parent" = "none"
  let pid = 0
  let ppid = 0
  let exe: string | undefined
  for (const line of output.split("\n")) {
    if (!line) continue
    const value = line.slice(1)
    if (line[0] === "p" && state === "none") {
      const parsed = decimal(value)
      if (parsed === undefined) return undefined
      pid = parsed
      state = "pid"
    } else if (line[0] === "R" && state === "pid") {
      const parsed = decimal(value)
      if (parsed === undefined) return undefined
      ppid = parsed
      state = "parent"
    } else if (line[0] === "n" && state === "parent" && value) {
      exe ??= value
    } else if (!(line[0] === "f" && state === "parent" && value === "txt")) return undefined
  }
  return state === "parent" ? { pid, ppid, exe } : undefined
}

export function ownsListener(listeners: readonly Listener[] | undefined, listener: ProcessRecord | undefined, parent: ProcessRecord | undefined, executable: string, harness: number) {
  const [only] = listeners ?? []
  if (listeners?.length !== 1 || !only || !listener || listener.pid !== only.pid || listener.ppid !== only.ppid || listener.exe !== executable) return false
  if (listener.ppid === harness) return true
  return parent !== undefined && parent.pid === only.ppid && parent.exe === executable && parent.ppid === harness
}

async function ownedListener(port: number, executable: string) {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }
  const listing = await execute(["/usr/sbin/lsof", "-nP", "-R", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpR"], env)
  const listeners = listing.code === 0 ? parseListeners(listing.stdout) : undefined
  const [only] = listeners ?? []
  if (listeners?.length !== 1 || !only) return false
  const inspect = async (pid: number) => {
    const result = await execute(["/usr/sbin/lsof", "-nP", "-R", "-a", "-p", String(pid), "-d", "txt", "-FpRn"], env)
    return result.code === 0 ? parseProcess(result.stdout) : undefined
  }
  return ownsListener(listeners, await inspect(only.pid), await inspect(only.ppid), executable, process.pid)
}

export async function isolation(resources: string) {
  const inherited = Object.keys(process.env).filter((key) => credentialName.test(key))
  if (inherited.length) throw new Error(`Run native desktop tests with the credential-free command in README.md; the harness inherited ${inherited.join(", ")}.`)
  await fs.access(sandbox, constants.X_OK)
  const declared = process.env.HOME
  if (!declared || !path.isAbsolute(declared)) throw new Error("HOME must be an absolute path.")
  const home = await fs.realpath(declared)
  const run = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ycd-")))
  const cwd = path.join(run, "cwd")
  let backend: Backend
  try {
    if (inside(run, home) || inside(home, run)) throw new Error("The native test temporary root must be outside HOME.")
    backend = await bundledGrant(resources, home)
    await fs.mkdir(cwd)
    process.chdir(cwd)
    await probe(run, home, cwd, backend)
  } catch (error) {
    await fs.rm(run, { recursive: true, force: true })
    throw error
  }

  const roots = new Set<OwnedRoot>()
  const live = new Map<number, Endpoint>()
  const issue = (port: number) => {
    if (live.has(port)) throw new Error(`Loopback port ${port} already has a live endpoint grant.`)
    const endpoint: Endpoint = Object.freeze({ port })
    live.set(port, endpoint)
    return { endpoint, revoke: () => { if (live.get(port) === endpoint) live.delete(port) } }
  }
  const original = globalThis.fetch
  const guarded = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const port = Number(url.port)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || !(live.has(port) || await ownedListener(port, backend.executable)))
      throw new TypeError("The trusted harness may contact only harness-issued endpoints and loopback listeners of the bundled backend.")
    return original(input, { ...init, redirect: "error" })
  }, original)
  globalThis.fetch = guarded
  const confine = (owned: OwnedRoot, endpoints: readonly Endpoint[], command: Command): Command => {
    if (!roots.has(owned)) throw new Error("Confined backends may use only a registered owned fixture root.")
    const info = lstatSync(owned.path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The owned fixture root changed.")
    if (endpoints.some((endpoint) => live.get(endpoint.port) !== endpoint)) throw new Error("Confined backends may reach only harness-issued live endpoints.")
    return [sandbox, "-p", profile({ owned: owned.path, cwd, backend, connect: endpoints.map((endpoint) => endpoint.port) }), ...command]
  }
  const serverEndpoint = (command: Command) => {
    const index = command.indexOf("--server")
    if (index < 0) return undefined
    const url = new URL(command[index + 1] ?? "")
    const endpoint = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/" && url.port ? live.get(Number(url.port)) : undefined
    if (!endpoint) throw new Error("Confined backends may reach only harness-issued live endpoints.")
    return endpoint
  }
  const serve = (handler: (request: Request) => Response | Promise<Response>) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
    const port = server.port
    if (!port) { void server.stop(true); throw new Error("A harness listener did not bind a loopback port.") }
    const { endpoint, revoke } = issue(port)
    const stop = async () => { revoke(); await server.stop(true) }
    return { url: server.url, endpoint, stop, [Symbol.dispose]: () => { void stop() } }
  }

  const requests: FakeRequest[] = []
  const chunk = (body: Record<string, unknown>) => `data: ${JSON.stringify({ id: "chatcmpl-synthetic", object: "chat.completion.chunk", created: 0, model: "echo", ...body })}\n\n`
  const fake = serve(async (request) => {
    const route = new URL(request.url).pathname
    const parsed: unknown = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
    const body = typeof parsed === "object" && parsed !== null ? parsed : {}
    const model = "model" in body && typeof body.model === "string" ? body.model : undefined
    requests.push({ method: request.method, path: route, ...(model ? { model } : {}) })
    if (route !== "/v1/chat/completions") return new Response("unavailable", { status: 503 })
    if (!("stream" in body) || body.stream !== true)
      return Response.json({ id: "chatcmpl-synthetic", object: "chat.completion", created: 0, model: "echo", choices: [{ index: 0, message: { role: "assistant", content: "Synthetic reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
    return new Response(
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic reply" }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) +
      "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  const provider = { url: `http://127.0.0.1:${fake.endpoint.port}/v1`, endpoint: fake.endpoint, requests }

  const shared = async (owned: OwnedRoot, env: Record<string, string>, requested = 0) => {
    const password = env.YCODING_PASSWORD
    if (!password) throw new Error("A shared synthetic backend needs a synthetic YCODING_PASSWORD.")
    const port = requested || await freePort()
    const spawnedAt = new Date().toISOString()
    const server = Bun.spawn([...confine(owned, [provider.endpoint], [backend.executable, "serve", "--stdio", "--port", String(port)])], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const first = Promise.withResolvers<string>()
    let tail = ""
    let pending = ""
    const errors: string[] = []
    const capture = (async () => {
      const decoder = new TextDecoder()
      for await (const piece of server.stderr) {
        const text = decoder.decode(piece, { stream: true })
        tail = (tail + text).slice(-4096)
        const lines = (pending + text).split("\n")
        pending = (lines.pop() ?? "").slice(0, 300)
        for (const line of lines)
          if (errors.length < 8 && (line.startsWith("error:") || line.includes("Error"))) errors.push(line.slice(0, 300))
      }
    })().catch((error) => { tail = (tail + "\nstderr read failed: " + String(error)).slice(-4096) })
    const drain = (async () => {
      const decoder = new TextDecoder()
      let buffer = ""
      for await (const piece of server.stdout) {
        buffer += decoder.decode(piece, { stream: true })
        const newline = buffer.indexOf("\n")
        if (newline >= 0) { first.resolve(buffer.slice(0, newline)); buffer = "" }
      }
      const endedAt = await Promise.race([Promise.all([server.exited, capture]).then(() => new Date().toISOString()), Bun.sleep(1_000).then(() => "running")])
      first.reject(new Error(`Shared synthetic fixture exited before readiness: pid ${server.pid}; spawned ${spawnedAt}; ended ${endedAt}; exit ${server.exitCode ?? "running"}; signal ${server.signalCode ?? "none"}; ${[...errors.filter((line) => !tail.includes(line)), tail.trim()].join("\n")}`))
    })()
    let revoke = () => {}
    void server.exited.then(() => revoke())
    let stopping: Promise<void> | undefined
    const stop = () => stopping ??= (async () => { revoke(); await server.stdin.end(); await server.exited; await drain })()
    try {
      const ready: unknown = JSON.parse(await Promise.race([first.promise, Bun.sleep(30_000).then(() => { throw new Error("Shared synthetic fixture readiness timed out") })]))
      const url = typeof ready === "object" && ready !== null && "url" in ready && typeof ready.url === "string" ? ready.url : ""
      const origin = new URL(url)
      if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || Number(origin.port) !== port)
        throw new Error("The shared synthetic backend did not bind the harness-chosen loopback port.")
      const response = await guarded(new URL("/api/health", origin), { headers: headers({ url, auth: { type: "basic", username: "ycoding", password } }), redirect: "error", signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw new Error(`The shared synthetic health check returned ${response.status}.`)
      const health: unknown = await response.json()
      if (typeof health !== "object" || health === null || !("pid" in health) || health.pid !== server.pid)
        throw new Error("The shared synthetic endpoint is not served by the confined backend the harness started.")
      const issued = issue(port)
      revoke = issued.revoke
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("The shared synthetic backend exited before its endpoint was granted.")
      return { url, pid: server.pid, endpoint: issued.endpoint, stop }
    } catch (error) {
      await stop()
      throw error
    }
  }

  return {
    backend,
    provider,
    fetch: guarded,
    root: async () => {
      const owned: OwnedRoot = Object.freeze({ path: await ownedDirectory(run, home) })
      roots.add(owned)
      return owned
    },
    release: async (owned: OwnedRoot) => {
      if (!roots.delete(owned)) throw new Error("Only a registered owned fixture root can be released.")
      await fs.rm(owned.path, { recursive: true, force: true })
    },
    confine,
    launch: (owned: OwnedRoot, endpoints: readonly Endpoint[]) => (command: Command) => {
      const server = serverEndpoint(command)
      return confine(owned, server ? [...endpoints, server] : endpoints, command)
    },
    serve,
    shared,
    close: async () => {
      await fake.stop()
      globalThis.fetch = original
      await fs.rm(run, { recursive: true, force: true })
    },
  }
}
