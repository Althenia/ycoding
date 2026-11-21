export * as PluginLoader from "./loader"

import { createHash, randomUUID } from "node:crypto"
import { access, lstat, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { hostname } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { PluginHost } from "./host"
import { PluginSDK } from "./sdk"

function lockToken(text: string): unknown {
  const meta: unknown = JSON.parse(text)
  return meta !== null && typeof meta === "object" ? (meta as { readonly token?: unknown }).token : undefined
}

declare const YCODING_PLUGIN_SDK_ASSET: string
declare const YCODING_PLUGIN_SDK_SHA256: string

let loading: Promise<void> | undefined
const modules: typeof import("node:module") = createRequire(import.meta.url)("node:module")

// Loads a configured plugin target. Native configuration resolves relative paths and file URLs,
// so a target is either an absolute module path or an npm package specification.
export async function load(launch: PluginHost.Launch) {
  loading ??= (async () => {
    const asset =
      typeof YCODING_PLUGIN_SDK_ASSET === "string"
        ? {
            path: (await import(YCODING_PLUGIN_SDK_ASSET, { with: { type: "file" } })).default as string,
            digest: typeof YCODING_PLUGIN_SDK_SHA256 === "string" ? YCODING_PLUGIN_SDK_SHA256 : "",
          }
        : await (async () => {
            const builder = new URL("../../script/plugin-sdk.ts", import.meta.url)
            const { PluginSDKAsset } = await import(builder.href)
            return PluginSDKAsset.build(
              path.resolve(import.meta.dirname, "../../../.."),
              path.join(launch.cache, "sdk-build"),
            ) as Promise<{ path: string; digest: string }>
          })()
    const bytes = await readFile(asset.path)
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== asset.digest) throw new Error("Plugin SDK asset does not match its embedded digest")
    const directory = path.join(launch.cache, "sdk", digest)
    const filename = path.join(directory, "sdk.mjs")
    const existing = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing) {
      if (
        !existing.isFile() ||
        createHash("sha256")
          .update(await readFile(filename))
          .digest("hex") !== digest
      )
        throw new Error("Materialized plugin SDK does not match its embedded digest")
    } else {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = path.join(directory, randomUUID())
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
        await rename(temporary, filename)
      } finally {
        await rm(temporary, { force: true })
      }
    }
    const url = pathToFileURL(filename).href
    const namespace: PluginSDK.Namespace = await import(url)
    PluginSDK.register(namespace, url)
  })()
  await loading
  if (launch.modelPackage) {
    return {
      id: "ycoding.model-package",
      setup: async (context: {
        aisdk: {
          hook: (
            name: string,
            callback: (event: { package: string; options: Record<string, unknown>; sdk?: unknown }) => Promise<void>,
          ) => Promise<unknown>
        }
      }) => {
        await context.aisdk.hook("sdk", async (event) => {
          if (event.package !== launch.target) return
          const url = launch.target.startsWith("file://")
            ? launch.target
            : pathToFileURL(
                path.isAbsolute(launch.target)
                  ? launch.target
                  : await install(launch.target.replace(/^aisdk:/, ""), launch.cache, false),
              ).href
          const module: Record<string, unknown> = await import(url)
          const factory = Object.entries(module).find(
            ([name, value]) => name.startsWith("create") && typeof value === "function",
          )
          if (!factory) throw new Error(`Model package ${launch.target} has no provider factory export`)
          const create = factory[1] as (options: Record<string, unknown>) => unknown
          event.sdk = await create(event.options)
        })
      },
    }
  }
  const entrypoint = path.isAbsolute(launch.target) ? launch.target : await install(launch.target, launch.cache)
  const module = (await import(pathToFileURL(entrypoint).href)) as { default?: unknown }
  return module.default
}

export async function install(specification: string, cache: string, server = true) {
  const { default: npa } = await import("npm-package-arg")
  const parsed = npa(specification)
  const name = parsed.name ?? specification
  const directory = path.join(cache, "packages", sanitize(specification))
  const installed = path.join(directory, "node_modules", name)
  const exists = await access(path.join(installed, "package.json")).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
  if (!exists) {
    await mkdir(directory, { recursive: true })
    const { Arborist } = await import("@npmcli/arborist")
    const configuration = await npmConfiguration(directory)
    const options = {
      ...configuration,
      cache: path.join(cache, "npm"),
      binLinks: false,
      progress: false,
      savePrefix: "",
      ignoreScripts: true,
      audit: false,
      fund: false,
    }
    const tree = await withInstallLock(cache, directory, () =>
      new Arborist({ ...options, path: directory }).reify({
        ...options,
        add: [specification],
        save: true,
        saveType: "prod",
      }),
    )
    const first = tree.target.edgesOut.values().next().value?.to
    return entrypoint(first?.name ?? name, first?.path ?? installed, server)
  }
  return entrypoint(name, installed, server)
}

async function npmConfiguration(directory: string): Promise<Record<string, unknown>> {
  // @ts-expect-error npm does not publish types for this internal config API.
  const { default: Config } = await import("@npmcli/config")
  // @ts-expect-error npm does not publish types for this internal config API.
  const { definitions, flatten, nerfDarts, shorthands } = await import("@npmcli/config/lib/definitions/index.js")
  const config = new Config({
    npmPath: fileURLToPath(new URL("..", import.meta.url)),
    cwd: directory,
    env: { ...process.env },
    argv: [process.execPath, process.execPath],
    execPath: process.execPath,
    platform: process.platform,
    definitions,
    flatten,
    nerfDarts,
    shorthands,
    warn: false,
  })
  await config.load()
  return config.flat
}

const lockStaleMs = 60_000
const lockTimeoutMs = 5 * 60_000

async function withInstallLock<A>(cache: string, directory: string, body: () => Promise<A>) {
  const locks = path.join(cache, "locks")
  const lock = path.join(locks, `${createHash("sha256").update(`npm-install:${directory}`).digest("hex")}.lock`)
  await mkdir(locks, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const deadline = Date.now() + lockTimeoutMs
  for (let attempt = 0; !(await claimLock(lock, token)); attempt++) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the plugin install lock on ${directory}`)
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 100 * 1.7 ** attempt) * (0.5 + Math.random())))
  }
  const heartbeat = setInterval(
    () => void utimes(path.join(lock, "heartbeat"), new Date(), new Date()).catch(() => {}),
    lockStaleMs / 3,
  )
  try {
    return await body()
  } finally {
    clearInterval(heartbeat)
    const owner = await readFile(path.join(lock, "meta.json"), "utf8").then(
      lockToken,
      () => undefined,
    )
    if (owner === token) await rm(lock, { recursive: true, force: true })
  }
}

async function claimLock(lock: string, token: string) {
  const created = await mkdir(lock, { mode: 0o700 }).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false
      throw error
    },
  )
  if (!created) {
    if (await staleLock(lock)) await breakLock(lock)
    return false
  }
  try {
    await writeFile(path.join(lock, "heartbeat"), "", { flag: "wx", mode: 0o600 })
    await writeFile(
      path.join(lock, "meta.json"),
      JSON.stringify({ token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    )
  } catch (error) {
    await rm(lock, { recursive: true, force: true })
    throw error
  }
  return true
}

async function staleLock(lock: string) {
  for (const file of [path.join(lock, "heartbeat"), path.join(lock, "meta.json"), lock]) {
    const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (info) return Date.now() - info.mtimeMs > lockStaleMs
  }
  return false
}

async function breakLock(lock: string) {
  const breaker = `${lock}.breaker`
  const claimed = await mkdir(breaker, { mode: 0o700 }).then(
    () => true,
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      if (await staleLock(breaker)) await rm(breaker, { recursive: true, force: true })
      return false
    },
  )
  if (!claimed) return
  try {
    if (await staleLock(lock)) await rm(lock, { recursive: true, force: true })
  } finally {
    await rm(breaker, { recursive: true, force: true })
  }
}

function entrypoint(name: string, directory: string, server: boolean) {
  for (const subpath of server ? ["server", ""] : [""]) {
    const specifier = subpath ? `${name}/${subpath}` : name
    const resolved = (() => {
      try {
        if (typeof Bun !== "undefined") return Bun.resolveSync(specifier, directory)
        createRequire(import.meta.url)(path.join(directory, "package.json"))
        const hook = modules.registerHooks({
          resolve(target, context, next) {
            return next(
              target,
              target === specifier && context.parentURL === import.meta.url
                ? { ...context, parentURL: pathToFileURL(path.join(directory, "package.json")).href }
                : context,
            )
          },
        })
        try {
          return fileURLToPath(import.meta.resolve(specifier))
        } finally {
          hook.deregister()
        }
      } catch {
        return undefined
      }
    })()
    if (resolved) return resolved
  }
  throw new Error(`Plugin package ${name} has no import entrypoint`)
}

function sanitize(specification: string) {
  return Array.from(specification, (char) => (/[<>:"|?*\\/]/.test(char) || char.charCodeAt(0) < 32 ? "_" : char)).join(
    "",
  )
}
