import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { bundleIdentifier, validSmokeIdentifier } from "../script/build-preflight"
import { runDesktopWorker } from "../src/worker"
import { isolation, syntheticEnv } from "./isolation"
import { windowChannel, type AppChannel, type ChannelOptions, type Wait } from "./window-channel"

export type Confinement = Pick<Awaited<ReturnType<typeof isolation>>, "backend" | "provider" | "root" | "release" | "launch" | "shared" | "close">
export type WindowLaunch = (input: {
  readonly application: string
  readonly env: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}) => Promise<AppChannel>
export type WindowSmokeOptions = {
  readonly application: string
  readonly mode: "own" | "shared"
  readonly launch: WindowLaunch
}
export type SmokeFailure = "launch-failed" | "launch-unsettled" | "worker-failed" | "worker-unsettled" | "shared-unsettled"
export type Limits = {
  readonly launchMs: number
  readonly abortMs: number
  readonly workerMs: number
  readonly stopMs: number
}
export type WindowSmokeDeps = {
  readonly isolate: (resources: string) => Promise<Confinement>
  readonly environment: (root: string, provider: string) => Promise<Record<string, string>>
  readonly worker: (options: Parameters<typeof runDesktopWorker>[0]) => Promise<void>
  readonly canonical: (application: string, resources: string) => Promise<void>
  readonly provenance: (application: string) => Promise<void>
  readonly channel: Omit<ChannelOptions, "resources">
  readonly limits: Limits
}

export function resourcesFor(application: string) {
  const parts = application.split(path.sep)
  const [name, host, contents, bundle] = [parts.at(-1), parts.at(-2), parts.at(-3), parts.at(-4)]
  if (!path.isAbsolute(application) || path.normalize(application) !== application || parts.length < 5 || !name || host !== "MacOS" || contents !== "Contents" || !bundle || !bundle.endsWith(".app") || bundle.length <= 4)
    throw new Error("The application must be <name>.app/Contents/MacOS/<executable> as a normalized absolute path.")
  return path.join(path.dirname(path.dirname(application)), "Resources")
}

async function inspectApplication(application: string, resources: string) {
  const executable = await fs.stat(application)
  if (await fs.realpath(application) !== application || !executable.isFile() || (executable.mode & 0o111) === 0)
    throw new Error("The application must be a canonical regular executable.")
  if (await fs.realpath(resources) !== resources || !(await fs.stat(resources)).isDirectory())
    throw new Error("The application Resources must be a canonical directory.")
}

export function receiptFor(application: string) {
  resourcesFor(application)
  const bundle = path.dirname(path.dirname(path.dirname(application)))
  return path.join(path.dirname(bundle), "build-receipt.json")
}

function own(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

export function admitReceipt(application: string, text: string, digest: string, plist: string) {
  receiptFor(application)
  const bundle = path.dirname(path.dirname(path.dirname(application)))
  let receipt: unknown
  try { receipt = JSON.parse(text) } catch { throw new Error("The build receipt is not valid JSON.") }
  const executable = own(receipt, "executable")
  const features = own(receipt, "features")
  const sha256 = own(executable, "sha256")
  if (own(receipt, "application") !== bundle || own(executable, "path") !== application || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || sha256 !== digest ||
    !Array.isArray(features) || features.length !== 1 || features[0] !== "isolated-smoke")
    throw new Error("The build receipt does not admit this application as an isolated-smoke build.")
  const isolation = own(receipt, "isolation")
  const identifier = own(isolation, "identifier")
  if (!validSmokeIdentifier(identifier) || own(isolation, "incognito") !== true || bundleIdentifier(plist) !== identifier)
    throw new Error("The build receipt does not bind this application to an incognito window and its isolated-smoke bundle identifier.")
}

export type ProvenanceFiles = {
  info(target: string): Promise<{ readonly kind: "file" | "dir" | "symlink" | "other" } | undefined>
  real(target: string): Promise<string>
  text(target: string): Promise<string>
  digest(target: string): Promise<string>
}

const nodeProvenanceFiles: ProvenanceFiles = {
  info: async (target) => {
    try {
      const stat = await fs.lstat(target)
      return { kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other" }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  },
  real: (target) => fs.realpath(target),
  text: (target) => fs.readFile(target, "utf8"),
  digest: (target) => new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(target)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  }),
}

export async function verifyProvenance(application: string, files: ProvenanceFiles = nodeProvenanceFiles) {
  const receipt = receiptFor(application)
  if ((await files.info(receipt))?.kind !== "file") throw new Error("The sibling build receipt must be a regular file.")
  if (await files.real(receipt) !== receipt) throw new Error("The sibling build receipt must be a canonical path.")
  admitReceipt(application, await files.text(receipt), await files.digest(application), await files.text(path.join(path.dirname(path.dirname(application)), "Info.plist")))
}

export const windowSmokeDeps: WindowSmokeDeps = {
  isolate: isolation,
  environment: syntheticEnv,
  worker: runDesktopWorker,
  canonical: inspectApplication,
  provenance: verifyProvenance,
  channel: {},
  limits: { launchMs: 30_000, abortMs: 5_000, workerMs: 15_000, stopMs: 10_000 },
}

const defaultWait: Wait = (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() })
const timedOut = Symbol("timed out")

type Launched = { readonly app: AppChannel } | { readonly error: unknown }

export async function setupWindowSmoke(options: WindowSmokeOptions, deps: WindowSmokeDeps = windowSmokeDeps) {
  const home = process.env.HOME
  if (!home || !path.isAbsolute(home)) throw new Error("HOME must be an absolute path.")
  const resources = resourcesFor(options.application)
  await deps.canonical(options.application, resources)
  await deps.provenance(options.application)
  const wait = deps.channel.wait ?? defaultWait
  const { launchMs, abortMs, workerMs, stopMs } = deps.limits
  const bounded = async <T>(promise: Promise<T>, ms: number) => {
    const value = await Promise.race([promise, wait(ms).then((): typeof timedOut => timedOut)])
    return value === timedOut ? { settled: false as const } : { settled: true as const, value }
  }
  const confinement = await deps.isolate(resources)
  let owned: Awaited<ReturnType<typeof confinement.root>> | undefined
  let shared: Awaited<ReturnType<typeof confinement.shared>> | undefined
  let channel: ReturnType<typeof windowChannel> | undefined
  let abort: AbortController | undefined
  let launching: Promise<void> | undefined
  let running: Promise<void> | undefined
  let cleaning: Promise<void> | undefined
  let stopped = false
  let workerResolved = false
  let retained = false
  let failure: SmokeFailure | undefined

  const cleanup = () => {
    stopped = true
    abort?.abort()
    return cleaning ??= (async () => {
      await launching?.catch(() => undefined)
      await channel?.close()
      if (channel && channel.result().appExit === undefined) retained = true
      if (running && !(await bounded(running.catch(() => undefined), workerMs)).settled) {
        failure ??= "worker-unsettled"
        retained = true
      }
      if (shared) {
        const stopping = await bounded(shared.stop().then(() => true, () => false), stopMs)
        if (!stopping.settled || !stopping.value) {
          failure ??= "shared-unsettled"
          retained = true
        }
      }
      if (retained) return
      if (owned) await confinement.release(owned)
      await confinement.close()
    })()
  }

  try {
    owned = await confinement.root()
    const root = owned.path
    const env = await deps.environment(root, confinement.provider.url)
    const password = options.mode === "shared" ? crypto.randomUUID() : undefined
    if (password) {
      env.YCODING_PASSWORD = password
      shared = await confinement.shared(owned, env)
    }
    const grant = owned
    const endpoints = [confinement.provider.endpoint, ...(shared ? [shared.endpoint] : [])]
    const preferences = path.join(root, "preferences.json")
    const baseline = confinement.provider.requests.length
    const channelOptions: ChannelOptions = { ...deps.channel, resources, secrets: [...(deps.channel.secrets ?? []), "synthetic-key", ...(password ? [password] : [])] }

    const closeLate = async (app: AppChannel) => {
      const late = windowChannel(app, channelOptions)
      await late.close()
      if (late.result().appExit === undefined) {
        retained = true
        failure ??= "launch-failed"
      }
    }

    const launch = async () => {
      const controller = new AbortController()
      abort = controller
      const cancelled = new Promise<typeof timedOut>((resolve) => { controller.signal.addEventListener("abort", () => resolve(timedOut), { once: true }) })
      const started: Promise<Launched> = options.launch({ application: options.application, env: { HOME: home, PATH: "/usr/bin:/bin" }, signal: controller.signal })
        .then((app) => ({ app }), (error: unknown) => ({ error }))
      let outcome = await Promise.race([started, wait(launchMs).then((): typeof timedOut => timedOut), cancelled])
      if (outcome === timedOut) {
        controller.abort()
        outcome = await Promise.race([started, wait(abortMs).then((): typeof timedOut => timedOut)])
        if (outcome === timedOut) {
          failure ??= "launch-unsettled"
          retained = true
          void started.then((late) => "app" in late ? closeLate(late.app) : undefined)
          throw new Error("The application launch did not settle.")
        }
        if ("app" in outcome) await closeLate(outcome.app)
        failure ??= "launch-failed"
        throw new Error("The application launch was cancelled or timed out.")
      }
      if ("error" in outcome) {
        failure ??= "launch-failed"
        throw outcome.error
      }
      if (stopped) {
        await closeLate(outcome.app)
        return
      }
      const opened = windowChannel(outcome.app, channelOptions)
      channel = opened
      running = (async () => {
        try {
          await deps.worker({
            resources: confinement.backend.resources,
            preferences,
            controller: { env, launch: confinement.launch(grant, endpoints) },
            input: opened.input,
            output: opened.output,
          })
          workerResolved = true
        } catch (error) {
          failure ??= "worker-failed"
          throw error
        } finally {
          await opened.finish()
        }
      })()
    }

    return {
      sharedURL: shared?.url,
      run: (): Promise<void> => {
        if (launching || stopped) return Promise.reject(new Error(stopped ? "The window smoke was cleaned up." : "The window smoke already ran."))
        launching = launch()
        return launching.then(() => running)
      },
      counters: () => {
        const seen = channel?.result()
        const providerRequests = confinement.provider.requests.length - baseline
        const reported = seen?.failure ?? failure
        const quiet = seen !== undefined && reported === undefined && !seen.killed && seen.appExit === 0 && workerResolved && !retained && seen.prompts === 0 && providerRequests === 0
        return { operations: seen?.operations ?? {}, prompts: seen?.prompts ?? 0, providerRequests, failure: reported, appExit: seen?.appExit, killed: seen?.killed ?? false, workerResolved, retained, quiet }
      },
      close: () => channel?.close(),
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
