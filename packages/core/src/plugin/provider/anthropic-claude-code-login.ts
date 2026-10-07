export * as ClaudeCodeLogin from "./anthropic-claude-code-login"

import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { Effect, Scope } from "effect"
import {
  buildClaudeCodeKeychainUpdate,
  buildClaudeCodeAccountLabels,
  parseClaudeCodeCredentials,
  type ClaudeCodeCredentialSource,
  type ClaudeCodeCredentials,
} from "./anthropic-claude-code-account"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function claudeCodeProfileDirectory(baseDir: string, source: string): string {
  if (!isAbsolute(baseDir) || !uuid.test(source) || source === "00000000-0000-0000-0000-000000000000")
    throw new Error("A managed Claude profile requires an absolute root and UUID source")
  return join(resolve(baseDir), source)
}

export function claudeCodeProfileKeychainService(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("A managed Claude profile requires an absolute directory")
  return `Claude Code-credentials-${createHash("sha256").update(directory.normalize("NFC")).digest("hex").slice(0, 8)}`
}

type Keychain = {
  readonly read: (service: string) => Promise<string | null>
  readonly write: (service: string, raw: string) => Promise<boolean>
}

const systemKeychain: Keychain = {
  read: async (service) => {
    try {
      return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
        timeout: 2_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 44) return null
      return Promise.reject(new Error("Managed Claude Keychain read failed"))
    }
  },
  write: async (service, raw) => {
    try {
      const entry = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service], {
        timeout: 2_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      })
      const account = /"acct"<blob>="([^"]*)"/.exec(entry)?.[1]
      if (!account) return false
      const update = buildClaudeCodeKeychainUpdate(service, account, raw)
      execFileSync(update.command, update.args, {
        input: update.input, timeout: 2_000, stdio: ["pipe", "ignore", "ignore"],
      })
      return true
    } catch {
      return false
    }
  },
}

async function profileFile(directory: string): Promise<string | null> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw new Error("Managed Claude profile access failed")
  })
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return null
  const file = join(directory, ".credentials.json")
  const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw new Error("Managed Claude credential access failed")
  })
  if (!entry || !entry.isFile() || entry.isSymbolicLink()) return null
  return file
}

async function readProfileFile(directory: string) {
  const file = await profileFile(directory)
  if (!file) return null
  try {
    const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW))
    try {
      return await handle.readFile("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    throw new Error("Managed Claude credential read failed")
  }
}

function replaceCredentials(raw: string, credentials: ClaudeCodeCredentials): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!record(parsed)) return null
  const target = record(parsed.claudeAiOauth) ? parsed.claudeAiOauth : parsed
  if (!parseClaudeCodeCredentials(raw)) return null
  target.accessToken = credentials.accessToken
  target.refreshToken = credentials.refreshToken
  target.expiresAt = credentials.expiresAt
  return JSON.stringify(parsed)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createManagedClaudeCodeCredentialSource(input: {
  readonly directory: string
  readonly platform?: NodeJS.Platform
  readonly keychain?: Keychain
}): ClaudeCodeCredentialSource {
  if (!isAbsolute(input.directory)) throw new Error("Managed Claude root must be absolute")
  const root = resolve(input.directory)
  const platform = input.platform ?? process.platform
  const keychain = input.keychain ?? systemKeychain
  const location = (source: string) => claudeCodeProfileDirectory(root, source)
  const raw = async (source: string) => {
    const directory = location(source)
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw new Error("Managed Claude profile access failed")
    })
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return null
    if (platform !== "darwin") return readProfileFile(directory)
    const value = await keychain.read(claudeCodeProfileKeychainService(directory))
    return value === null ? readProfileFile(directory) : value
  }
  const read = async (source: string) => {
    if (!uuid.test(source)) return null
    return parseClaudeCodeCredentials((await raw(source)) ?? "")
  }
  return {
    list: async () => {
      const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw new Error("Managed Claude profile listing failed")
      })
      const found = await Promise.all(entries.filter((entry) => entry.isDirectory() && uuid.test(entry.name))
        .map(async (entry) => ({ source: entry.name, credentials: await read(entry.name) })))
      const accounts = found.filter((entry): entry is { source: string; credentials: ClaudeCodeCredentials } => entry.credentials !== null)
      const labels = buildClaudeCodeAccountLabels(accounts.map((entry) => entry.credentials))
      return accounts.map((entry, index) => ({ ...entry, label: labels[index] ?? "Claude" }))
    },
    read,
    write: async (source, credentials) => {
      if (!uuid.test(source)) return false
      const directory = location(source)
      const previous = await raw(source)
      if (!previous) return false
      const updated = replaceCredentials(previous, credentials)
      if (!updated) return false
      if (platform === "darwin") {
        const service = claudeCodeProfileKeychainService(directory)
        const keychainRaw = await keychain.read(service)
        if (keychainRaw !== null) return keychain.write(service, updated)
      }
      const file = await profileFile(directory)
      if (!file) return false
      try {
        const handle = await open(file, constants.O_WRONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW))
        try {
          await handle.truncate(0)
          await handle.writeFile(updated, "utf8")
          if (platform !== "win32") await handle.chmod(0o600)
        } finally {
          await handle.close()
        }
        return true
      } catch {
        return false
      }
    },
  }
}

export function authorizeClaudeCodeProfile(input: {
  readonly directory: string
  readonly credentialSource?: ClaudeCodeCredentialSource
  readonly command?: readonly [string, ...string[]]
}): Effect.Effect<{
  source: string
  url: string
  instructions: string
  callback: Effect.Effect<ClaudeCodeCredentials, Error>
  submitCode: (code: string) => Effect.Effect<void, Error>
}, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const source = randomUUID()
    const directory = claudeCodeProfileDirectory(input.directory, source)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(input.directory, { recursive: true, mode: 0o700 })
        if (process.platform !== "win32") await chmod(input.directory, 0o700)
        await mkdir(directory, { recursive: false, mode: 0o700 })
        if (process.platform !== "win32") await chmod(directory, 0o700)
      },
      catch: () => new Error("Managed Claude profile directory creation failed"),
    })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !(
      /^(ANTHROPIC_|CLAUDE_CODE_|AWS_|GOOGLE_|AZURE_)/.test(key) ||
      key === "CLAUDE_SECURESTORAGE_CONFIG_DIR" ||
      /^(?:CLAUDE_PROFILE|CLAUDE_AUTH|CLAUDE_BEDROCK|CLAUDE_VERTEX|CLAUDE_FOUNDRY)/.test(key)
    )))
    env.CLAUDE_CONFIG_DIR = directory
    const [command, ...args] = input.command ?? ["claude"]
    const child = yield* Effect.try({
      try: () => Bun.spawn([command, ...args, "auth", "login", "--claudeai"], {
        cwd: directory, env, stdin: "pipe", stdout: "pipe", stderr: "ignore",
      }),
      catch: () => new Error("Managed Claude CLI could not start"),
    })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      clearTimeout(timeout)
      child.kill()
      await child.exited
    }))

    let url: string | undefined
    let notifyURL: (value: string) => void = () => undefined
    const urlReady = new Promise<string>((resolve) => { notifyURL = resolve })
    let outputTooLarge = false
    const output = (async () => {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let text = ""
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        text += decoder.decode(item.value, { stream: true })
        if (text.length > 16_384) { outputTooLarge = true; child.kill(); break }
        const match = /If the browser didn't open, visit:\s*(?:\x1b\]8;;)?(https:\/\/[^\s\x07\x1b]+)(?=\s|\x07|\x1b\\)/.exec(text)
        if (!match || url) continue
        try {
          const parsed = new URL(match[1])
          if (parsed.protocol !== "https:" || parsed.hostname !== "claude.com" ||
            parsed.username || parsed.password || parsed.port) continue
          url = parsed.href
          notifyURL(url)
        } catch {
          continue
        }
      }
    })()
    void output.catch(() => undefined)
    const code = yield* Effect.tryPromise({
      try: async () => {
        const result = await Promise.race([urlReady, child.exited.then(async () => {
          await output
          if (!url) throw new Error("Managed Claude CLI did not provide an authorization URL")
          return url
        })])
        return result
      },
      catch: () => new Error(timedOut
        ? "Managed Claude CLI authorization URL timed out"
        : "Managed Claude CLI did not provide a valid authorization URL"),
    })
    const credentials = input.credentialSource ?? createManagedClaudeCodeCredentialSource({ directory: input.directory })
    const completion = child.exited.then(async (exit) => {
        await output
        if (outputTooLarge) throw new Error("Managed Claude CLI output limit exceeded")
        if (timedOut) throw new Error("Managed Claude CLI authentication timed out")
        if (exit !== 0) throw new Error("Managed Claude CLI authentication failed")
        const stored = await credentials.read(source)
        if (!stored || stored.expiresAt <= Date.now() || !stored.accessToken.trim())
          throw new Error("Managed Claude CLI did not store fresh credentials in the selected profile")
        return stored
      })
    void completion.catch(() => undefined)
    const callback = Effect.tryPromise({
      try: () => completion,
      catch: (cause) => cause instanceof Error && cause.message.startsWith("Managed Claude CLI")
        ? cause : new Error("Managed Claude CLI authentication failed"),
    })
    return {
      source, url: code,
      instructions: "Complete authorization in your browser. If prompted by Claude Code, paste the authorization code here.",
      callback,
      submitCode: (value: string) => Effect.tryPromise({
        try: async () => {
          if (!/^[^\s\r\n\0]{1,2048}$/.test(value)) throw new Error("Invalid authorization code")
          if (child.exitCode !== null) throw new Error("Claude authentication is no longer pending")
          await child.stdin.write(new TextEncoder().encode(value + "\n"))
          await child.stdin.flush()
        },
        catch: () => new Error("Claude authorization code could not be submitted"),
      }),
    }
  })
}
