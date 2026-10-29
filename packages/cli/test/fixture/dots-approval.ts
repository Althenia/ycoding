import { Credential } from "@ycoding-ai/core/credential"
import { CredentialTable } from "@ycoding-ai/core/credential/sql"
import { Database } from "@ycoding-ai/core/database/database"
import { Integration } from "@ycoding-ai/core/integration"
import { KVTable } from "@ycoding-ai/core/kv/sql"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Scope } from "effect"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const dotsApprovalPassword = "test-password"
export const dotsApprovalAuth = `Basic ${Buffer.from(`ycoding:${dotsApprovalPassword}`).toString("base64")}`
export const dotsApprovalEnvironmentID = "environment"

export interface DotsApprovalServer {
  readonly root: string
  readonly workspace: string
  readonly outside: string
  readonly base: string
  readonly host: NativeDots.Host
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly close: () => Promise<void>
}

export async function startDotsApprovalServer(): Promise<DotsApprovalServer> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ycoding-dots-approval-")))
  const workspace = join(root, "workspace")
  const outside = join(root, "outside-home")
  const configDirectory = join(root, "config")
  const databasePath = join(root, "ycoding.db")
  await mkdir(workspace, { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(configDirectory, { recursive: true })
  const git = Bun.spawn(["git", "init", "-q", workspace], { stdout: "pipe", stderr: "pipe" })
  if ((await git.exited) !== 0) throw new Error(`git init failed: ${await new Response(git.stderr).text()}`)
  await writeFile(
    join(configDirectory, "ycoding.json"),
    JSON.stringify({
      dots: { enabled: true, profile: "trusted" },
      permissions: [
        { action: "shell", resource: "*dots-approval-marker*", effect: "ask" },
        { action: "edit", resource: "*dots-approval-marker*", effect: "ask" },
        { action: "external_directory", resource: "*dots-approval-marker*", effect: "ask" },
      ],
    }),
  )
  await seedDotsAccess(databasePath)

  const scope = await Effect.runPromise(Scope.make())
  let host: NativeDots.Host | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(root, { recursive: true, force: true })
  }
  try {
    const port = await availablePort()
    const startingRaw = ServerProcess.start<never, never>(
      {
        hostname: "127.0.0.1",
        port,
        password: dotsApprovalPassword,
        database: { path: databasePath },
        config: {
          directory: configDirectory,
          project: false,
          content: "{}",
        },
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
      },
      undefined,
      undefined,
      [],
      async (native) => {
        host = native
        return async () => {}
      },
    ).pipe(Effect.provideService(Scope.Scope, scope))
    const starting = startingRaw as Effect.Effect<
      Effect.Success<typeof startingRaw>,
      Effect.Error<typeof startingRaw>
    >
    const started = await Effect.runPromise(starting)
    if (started === undefined) throw new Error("server stopped during startup")
    if (host === undefined) throw new Error("nativeFactory did not provide a NativeDots host")
    const native = host
    const configuration = await native.configuration()
    if (!configuration.enabled) throw new Error("Dots native access is not enabled for the seeded server")
    const base = `http://127.0.0.1:${port}`
    return {
      root,
      workspace,
      outside,
      base,
      host: native,
      request: (path, init = {}) => {
        const headers = new Headers(init.headers)
        headers.set("authorization", dotsApprovalAuth)
        headers.set("x-ycoding-directory", encodeURIComponent(workspace))
        return fetch(`${base}${path}`, { ...init, headers })
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

function seedDotsAccess(databasePath: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(CredentialTable)
        .values({
          id: Credential.ID.make("cred_dots_approval"),
          integration_id: Integration.ID.make("openai"),
          label: "trusted",
          value: {
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: 0,
            metadata: { accountID: "synthetic-account" },
          },
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(KVTable)
        .values({ key: "dots.native-access", value: { enabled: true, revision: 1 } })
        .run()
        .pipe(Effect.orDie)
    }).pipe(Effect.provide(Database.layer({ path: databasePath })), Effect.scoped),
  )
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve a test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
