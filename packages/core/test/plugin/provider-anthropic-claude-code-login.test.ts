import { describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  authorizeClaudeCodeProfile,
  claudeCodeProfileDirectory,
  claudeCodeProfileKeychainService,
  createManagedClaudeCodeCredentialSource,
} from "@ycoding-ai/core/plugin/provider/anthropic-claude-code-login"

const fixture = join(import.meta.dir, "../fixture/claude-login.ts")
const credentials = { accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3600_000, subscriptionType: "max" }

describe("managed Claude CLI profile boundary", () => {
  test("UUID paths cannot escape the absolute managed root and macOS service hashes NFC path", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    try {
      const id = randomUUID()
      const directory = claudeCodeProfileDirectory(base, id)
      expect(directory).toBe(join(base, id))
      for (const invalid of ["file", "../" + id, id + "/../other", "00000000-0000-0000-0000-000000000000"]) {
        expect(() => claudeCodeProfileDirectory(base, invalid)).toThrow()
      }
      expect(() => claudeCodeProfileDirectory("relative", id)).toThrow()
      expect(claudeCodeProfileKeychainService(directory)).toBe(
        "Claude Code-credentials-" + createHash("sha256").update(directory.normalize("NFC")).digest("hex").slice(0, 8),
      )
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("lists only UUID-owned profiles, preserves credential blob metadata and 0600 permissions", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    try {
      const id = randomUUID()
      const directory = claudeCodeProfileDirectory(base, id)
      await mkdir(directory, { mode: 0o700 })
      await mkdir(join(base, "other"))
      const file = join(directory, ".credentials.json")
      await writeFile(file, JSON.stringify({ claudeAiOauth: credentials, other: { keep: true } }), { mode: 0o600 })
      const source = createManagedClaudeCodeCredentialSource({ directory: base, platform: "linux" })
      expect((await source.list()).map((account) => account.source)).toEqual([id])
      expect(await source.read("file")).toBeNull()
      expect(await source.write("../other", credentials)).toBe(false)
      expect(await source.write(id, { ...credentials, accessToken: "rotated" })).toBe(true)
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        claudeAiOauth: { ...credentials, accessToken: "rotated" }, other: { keep: true },
      })
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("macOS reads only exact service and falls back to its own file only when missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    try {
      const id = randomUUID()
      const directory = claudeCodeProfileDirectory(base, id)
      await mkdir(directory)
      await writeFile(join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: credentials }))
      const services: string[] = []
      const source = createManagedClaudeCodeCredentialSource({ directory: base, platform: "darwin", keychain: {
        read: async (service) => { services.push(service); return null },
        write: async () => true,
      } })
      expect(await source.read(id)).toEqual(credentials)
      expect(services).toEqual([claudeCodeProfileKeychainService(directory)])
      const broken = createManagedClaudeCodeCredentialSource({ directory: base, platform: "darwin", keychain: {
        read: async () => "invalid",
        write: async () => true,
      } })
      expect(await broken.read(id)).toBeNull()
      const writes: Array<{ service: string; raw: string }> = []
      const keychain = createManagedClaudeCodeCredentialSource({ directory: base, platform: "darwin", keychain: {
        read: async () => JSON.stringify({ claudeAiOauth: credentials, other: { keep: true } }),
        write: async (service, raw) => { writes.push({ service, raw }); return true },
      } })
      expect(await keychain.write(id, { ...credentials, accessToken: "rotated" })).toBe(true)
      expect(writes.map((entry) => entry.service)).toEqual([claudeCodeProfileKeychainService(directory)])
      expect(JSON.parse(writes[0].raw)).toEqual({
        claudeAiOauth: { ...credentials, accessToken: "rotated" }, other: { keep: true },
      })
      expect(JSON.parse(await readFile(join(directory, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("token")
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("real child isolates environment and completes only after fresh selected credentials", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    const directory = join(base, "first-run", "profiles")
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const auth = yield* authorizeClaudeCodeProfile({ directory, credentialSource: createManagedClaudeCodeCredentialSource({ directory, platform: "linux" }), command: [process.execPath, fixture, "automatic"] })
        expect(auth.url).toBe("https://claude.com/cai/oauth/authorize?state=fixture")
        return yield* auth.callback
      })))
      expect(result).toMatchObject({ accessToken: "token", refreshToken: "refresh", subscriptionType: "max" })
      expect(result.expiresAt).toBeGreaterThan(Date.now())
      if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("manual code submission rejects injection and reaches the same completion", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const auth = yield* authorizeClaudeCodeProfile({ directory: base, credentialSource: createManagedClaudeCodeCredentialSource({ directory: base, platform: "linux" }), command: [process.execPath, fixture, "manual"] })
        expect((yield* Effect.exit(auth.submitCode("bad\ncode")))._tag).toBe("Failure")
        yield* auth.submitCode("code#state")
        return yield* auth.callback
      })))
      expect(result).toMatchObject({ accessToken: "token", refreshToken: "refresh", subscriptionType: "max" })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("reads the CLI authorization target from an OSC 8 hyperlink rather than its styled label", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const auth = yield* authorizeClaudeCodeProfile({ directory: base, credentialSource: createManagedClaudeCodeCredentialSource({ directory: base, platform: "linux" }), command: [process.execPath, fixture, "hyperlink"] })
        expect(auth.url).toBe("https://claude.com/cai/oauth/authorize?state=fixture")
        expect((yield* auth.callback).accessToken).toBe("token")
      })))
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("zero exit with empty store and nonzero exit both fail without raw CLI diagnostics", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    try {
      for (const mode of ["empty", "failure"]) {
        const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const auth = yield* authorizeClaudeCodeProfile({ directory: base, credentialSource: createManagedClaudeCodeCredentialSource({ directory: base, platform: "linux" }), command: [process.execPath, fixture, mode] })
          return yield* Effect.exit(auth.callback)
        })))
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).not.toContain("private-identity")
      }
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("rejects a foreign manual authorization URL even when a credential file appears", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    try {
      const exit = await Effect.runPromise(Effect.scoped(Effect.exit(authorizeClaudeCodeProfile({
        directory: base,
        credentialSource: createManagedClaudeCodeCredentialSource({ directory: base, platform: "linux" }),
        command: [process.execPath, fixture, "foreign"],
      }))))
      expect(exit._tag).toBe("Failure")
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("scope cancellation terminates the interactive child", async () => {
    const base = await mkdtemp(join(tmpdir(), "ycoding-claude-"))
    try {
      const pid = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const auth = yield* authorizeClaudeCodeProfile({ directory: base, credentialSource: createManagedClaudeCodeCredentialSource({ directory: base, platform: "linux" }), command: [process.execPath, fixture, "wait"] })
        return Number(yield* Effect.promise(() => readFile(join(base, auth.source, "pid"), "utf8")))
      })))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
