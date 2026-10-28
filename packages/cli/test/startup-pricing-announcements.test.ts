import { afterAll, expect, test } from "bun:test"
import { Database } from "@ycoding-ai/core/database/database"
import { UsageStage } from "@ycoding-ai/core/usage-stage"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Logger, Scope } from "effect"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auth, availablePort, password } from "./remote-harness"

const folders = 6
const directories: string[] = []
afterAll(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))))

const announcement = (type: string) => type.endsWith(".updated") || type.startsWith("plugin.")

function seed(file: string, locations: readonly string[]) {
  const now = Date.now()
  const values = locations.flatMap((directory, location) =>
    Array.from({ length: 10 }, (_, index) => {
      const id = location * 10 + index
      return `('prq_announce_${id}', 'ses_announce_${location}', 'prj_announce', '${directory}', NULL, ${now}, 'build', 'step',
        json_object('providerID', 'local', 'id', 'local-0'), NULL, '[]', 1, 1, 'full', 'stable-hit', 'announcekey', 1,
        json_object('input', 1000, 'output', 100, 'reasoning', 0, 'cache', json_object('read', 0, 'write', 0)), NULL,
        json_object('firstOutputMs', 200, 'totalMs', 1000, 'generatedTokens', 100, 'generationDurationNs', 1000000000),
        ${now - id * 60_000})`
    }),
  )
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(`
      INSERT INTO usage_analytics_request
        (id, session_id, project_id, directory, workspace_id, session_updated, agent, source, model, usage_anchor, task_path,
          request, attempts, continuation, invalidation, prompt_cache_key, cache_read_reported, tokens, cost, timing, time_created)
      VALUES ${values.join(",\n")}
    `)
    yield* database.db.transaction(() => UsageStage.backfill(database.db))
  }).pipe(Effect.provide(Database.layer({ path: file })), Effect.scoped)
}

async function settleProducer(file: string) {
  const { Database } = await import("bun:sqlite")
  const connection = new Database(file, { readonly: true })
  const begin = performance.now()
  try {
    for (;;) {
      const state = connection
        .query<{ open: number; total: number }, []>(
          "SELECT count(*) FILTER (WHERE status IN ('pending', 'building')) AS open, count(*) AS total FROM usage_view_state",
        )
        .get()
      if (state !== null && state.total > 0 && state.open === 0) return
      if (performance.now() - begin > 60_000) throw new Error(`The startup producer did not settle: ${JSON.stringify(state)}`)
      await Bun.sleep(50)
    }
  } finally {
    connection.close()
  }
}

type Seen = { readonly type: string; readonly directory?: string }

async function watchEvents(port: number, seen: Seen[], abort: AbortController) {
  const response = await fetch(`http://127.0.0.1:${port}/api/event`, {
    headers: { authorization: auth },
    signal: abort.signal,
  })
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  void (async () => {
    let buffer = ""
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        buffer += chunk.value
        const frames = buffer.split("\n\n")
        buffer = frames.pop() ?? ""
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue
          const event = JSON.parse(frame.slice(6)) as { type: string; location?: { directory?: string } }
          seen.push({ type: event.type, directory: event.location?.directory })
        }
      }
    } catch {
      return
    }
  })()
}

test(
  "startup usage pricing over many folders announces nothing and discovers each provider endpoint once",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ycoding-startup-pricing-")))
    directories.push(root)
    const discovery: string[] = []
    const standIn = Bun.serve({
      port: 0,
      fetch(request) {
        discovery.push(new URL(request.url).pathname)
        return new Response("unavailable", { status: 503 })
      },
    })
    const configDirectory = join(root, "config")
    await mkdir(configDirectory)
    await writeFile(
      join(configDirectory, "ycoding.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local synthetic",
            package: "@ycoding-ai/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${standIn.port}/v1`, apiKey: "synthetic-key" },
            catalog: { source: "openai-models" },
            models: { "local-0": { name: "Local 0", cost: { input: 1, output: 2, cache: { read: 0, write: 0 } } } },
          },
        },
      }),
    )
    const locations = [
      configDirectory,
      ...(await Promise.all(
        Array.from({ length: folders - 1 }, async (_, index) => {
          const directory = join(root, `folder-${index}`)
          await mkdir(directory)
          return directory
        }),
      )),
    ]
    const file = join(root, "usage.db")
    await Effect.runPromise(seed(file, locations))

    const booted = new Set<string>()
    const logged: string[] = []
    const warnings: string[] = []
    const logger = Logger.make((options) => {
      const message = Array.isArray(options.message) ? options.message : [options.message]
      const text = message[0]
      const fields = message[1] as { readonly directory?: string; readonly event?: { readonly type?: string } } | undefined
      if (text === "location services booted" && fields?.directory) booted.add(fields.directory)
      if (text === "event" && fields?.event?.type) logged.push(fields.event.type)
      if (text === "OpenAI model discovery failed") warnings.push(text)
    })
    const port = await availablePort()
    const serverScope = await Effect.runPromise(Scope.make())
    const seen: Seen[] = []
    const abort = new AbortController()
    try {
      const startingRaw = ServerProcess.start<never, never>({
        hostname: "127.0.0.1",
        port,
        password,
        database: { path: file },
        config: { directory: configDirectory },
        models: { fetch: false },
        fs: { filewatcher: true, fff: false },
      }).pipe(
        Effect.provideService(Scope.Scope, serverScope),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      )
      await Effect.runPromise(startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>)
      await watchEvents(port, seen, abort)
      await settleProducer(file)
      await Bun.sleep(3_000)

      expect(locations.filter((directory) => !booted.has(directory))).toEqual([])
      expect(logged).toEqual([])
      expect(seen.filter((event) => announcement(event.type))).toEqual([])
      expect(discovery).toEqual(["/v1/models"])
      expect(warnings).toHaveLength(1)

      for (let index = 0; index < 3; index++) {
        const response = await fetch(`http://127.0.0.1:${port}/api/coordination/settings`, { headers: { authorization: auth } })
        expect(response.status).toBe(200)
      }
      await Bun.sleep(2_000)
      expect(logged).toEqual([])
      expect(seen.filter((event) => announcement(event.type))).toEqual([])
      expect(discovery).toEqual(["/v1/models"])
      expect(warnings).toHaveLength(1)
    } finally {
      abort.abort()
      await Effect.runPromise(Scope.close(serverScope, Exit.void))
      await standIn.stop(true)
    }
  },
  120_000,
)
