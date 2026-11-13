import { execFile } from "node:child_process"
import { lstatSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { bundledBackend } from "./resources"

export type Command = readonly [string, ...string[]]
export type OwnedRoot = { readonly path: string }
export type EndpointGrant = { readonly port: number }
export type Backend = Awaited<ReturnType<typeof bundledGrant>>
export const sandbox = "/usr/bin/sandbox-exec"
export const systemReads = ["/usr/lib", "/System/Library", "/System/Cryptexes/OS", "/System/Volumes/Preboot/Cryptexes/OS"]
export const devices = ["/dev/null", "/dev/random", "/dev/urandom"]
export const credentialName = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE|SOCK/

export function inside(child: string, parent: string) {
  const relative = path.relative(parent, child)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function quoted(value: string) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || /["\\\p{Cc}]/u.test(value)) throw new Error("Unsupported confinement path.")
  return `"${value}"`
}

function ancestors(target: string) {
  const list: string[] = []
  for (let current = path.dirname(target); ; current = path.dirname(current)) {
    list.push(current)
    if (current === path.dirname(current)) return list
  }
}

export async function bundledGrant(resources: string, home: string) {
  const root = await fs.realpath(resources)
  const binary = await bundledBackend(root)
  const directory = path.join(root, "backend")
  const manifest = path.join(root, "backend.json")
  const info = await fs.lstat(manifest)
  if (await fs.realpath(directory) !== directory || binary.executable !== path.join(directory, "ycoding") || !info.isFile() || inside(home, root))
    throw new Error("The bundled backend must be a canonical, digest-verified directory that does not contain HOME.")
  return { resources: root, directory, manifest, executable: binary.executable, version: binary.version }
}

export function profile(input: { readonly owned: string; readonly cwd: string; readonly backend: Backend; readonly connect: readonly number[]; readonly tools?: readonly string[] }) {
  for (const port of input.connect) if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Unsupported confinement port.")
  const tools = input.tools ?? []
  const executables = [input.backend.executable, ...tools]
  const subpaths = [...systemReads, input.backend.directory, input.cwd]
  const literals = [input.backend.manifest, ...devices, ...tools, "/usr/share/icu/icudt78l.dat"]
  const metadata = [...new Set([...subpaths, ...literals, input.owned].flatMap(ancestors))]
  const list = (kind: string, items: readonly string[]) => items.map((item) => `(${kind} ${quoted(item)})`).join(" ")
  return [
    "(version 1)", "(deny default)", '(import "dyld-support.sb")', "(allow process-fork)",
    `(allow process-exec ${list("literal", executables)})`,
    "(allow signal (target same-sandbox))", "(allow process-info* (target same-sandbox))", "(allow sysctl-read)", "(allow dynamic-code-generation)",
    `(allow file-read-metadata ${list("literal", metadata)})`,
    `(allow file-read* ${list("subpath", subpaths)} ${list("literal", literals)})`,
    `(allow file-map-executable ${list("subpath", systemReads)} ${list("literal", executables)})`,
    `(allow file-read* file-write* ${list("subpath", [input.owned])})`,
    `(allow file-write-data ${list("literal", ["/dev/null"])})`,
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    ...input.connect.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
  ].join("\n")
}

export async function syntheticEnvironment(root: string, provider: string, environment: Readonly<NodeJS.ProcessEnv>) {
  if (!environment.HOME || !environment.PATH) throw new Error("Synthetic backends require the actual HOME and PATH.")
  const env: Record<string, string> = { HOME: environment.HOME, PATH: environment.PATH }
  for (const key of ["LANG", "USER", "LOGNAME"]) if (environment[key] !== undefined) env[key] = environment[key]!
  await Promise.all([fs.mkdir(path.join(root, "tmp")), fs.mkdir(path.join(root, "home"))])
  return {
    ...env, TMPDIR: path.join(root, "tmp"), YCODING_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"),
    YCODING_DB: path.join(root, "runtime.db"), YCODING_DISABLE_MODELS_FETCH: "1", YCODING_DISABLE_AUTOUPDATE: "1", YCODING_DISABLE_PROJECT_CONFIG: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", BUN_ENABLE_CRASH_REPORTING: "0",
    YCODING_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", capabilities: { home_roots: false }, model: "desktop-fake/echo",
      providers: { "desktop-fake": { name: "Desktop synthetic", package: "@ycoding-ai/ai/providers/openai-compatible", settings: { baseURL: provider, apiKey: "synthetic-key" }, models: { echo: { name: "Synthetic echo" }, hold: { name: "Synthetic hold" } } } },
    }),
  }
}

export function confinement(backend: Backend, cwd: string) {
  const roots = new Set<OwnedRoot>()
  const live = new Map<number, EndpointGrant>()
  const root = (directory: string) => {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("A private owned fixture root is required.")
    const owned: OwnedRoot = Object.freeze({ path: directory })
    roots.add(owned)
    return owned
  }
  const issue = (port: number) => {
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || live.has(port)) throw new Error("A unique live loopback endpoint is required.")
    const endpoint: EndpointGrant = Object.freeze({ port })
    live.set(port, endpoint)
    return { endpoint, revoke: () => { if (live.get(port) === endpoint) live.delete(port) } }
  }
  const confine = (owned: OwnedRoot, endpoints: readonly EndpointGrant[], command: Command): Command => {
    if (!roots.has(owned)) throw new Error("Confined backends require a registered fixture root.")
    const info = lstatSync(owned.path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("The owned fixture root changed.")
    if (endpoints.some((endpoint) => live.get(endpoint.port) !== endpoint)) throw new Error("Confined backends require live issued endpoints.")
    return [sandbox, "-p", profile({ owned: owned.path, cwd, backend, connect: endpoints.map((endpoint) => endpoint.port) }), ...command]
  }
  return { root, issue, confine, release: (owned: OwnedRoot) => { if (!roots.delete(owned)) throw new Error("Only a registered fixture root can be released.") } }
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
      pid = parsed; state = "pid"
    } else if (line[0] === "R" && state === "pid") {
      const parsed = decimal(value)
      if (parsed === undefined) return undefined
      records.push({ pid, ppid: parsed }); state = "parent"
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
      pid = parsed; state = "pid"
    } else if (line[0] === "R" && state === "pid") {
      const parsed = decimal(value)
      if (parsed === undefined) return undefined
      ppid = parsed; state = "parent"
    } else if (line[0] === "n" && state === "parent" && value) exe ??= value
    else if (!(line[0] === "f" && state === "parent" && value === "txt")) return undefined
  }
  return state === "parent" ? { pid, ppid, exe } : undefined
}
export function ownsListener(listeners: readonly Listener[] | undefined, listener: ProcessRecord | undefined, parent: ProcessRecord | undefined, executable: string, owner: number) {
  const [only] = listeners ?? []
  if (listeners?.length !== 1 || !only || !listener || listener.pid !== only.pid || listener.ppid !== only.ppid || listener.exe !== executable) return false
  if (listener.ppid === owner) return true
  return parent !== undefined && parent.pid === only.ppid && parent.exe === executable && parent.ppid === owner
}

export async function ownedListener(port: number, executable: string, environment: NodeJS.ProcessEnv, owner = process.pid) {
  const read = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile("/usr/sbin/lsof", ["-nP", "-R", "-a", ...args], { env: environment, timeout: 2_000, maxBuffer: 65_536 }, (error, stdout) => {
      if (error) reject(new Error("Synthetic backend listener ownership could not be verified."))
      else resolve(stdout)
    })
  })
  const listeners = parseListeners(await read([`-iTCP:${port}`, "-sTCP:LISTEN", "-FpR"]))
  const [only] = listeners ?? []
  if (listeners?.length !== 1 || !only) return undefined
  const listener = parseProcess(await read(["-p", String(only.pid), "-d", "txt", "-FpRn"]))
  const parent = listener?.ppid === owner ? undefined : parseProcess(await read(["-p", String(only.ppid), "-d", "txt", "-FpRn"]))
  return ownsListener(listeners, listener, parent, executable, owner) ? listener : undefined
}
