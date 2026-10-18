import { expect, test } from "bun:test"
import type { WebSocketOptions } from "bun"
import { YCoding } from "@ycoding-ai/client/v5"
import { RemoteWebSocketPath } from "@ycoding-ai/remote"
import { Schema } from "effect"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import { localRelay, until } from "./fixture/packaged-update"
import {
  createRemoteQueries,
  createRemoteQueryClient,
  type QueryScope,
  type RemoteLink,
} from "../../../apps/web/src/remote/queries"
import {
  createRemoteTransport,
  type RemoteRequestTiming,
  type RemoteTransportStatus,
} from "../../../apps/web/src/remote/transport"
import { usageReportInputs } from "../../../apps/web/src/remote/ui/usage-model"

const rows = 200_000
const locations = 2_500
const unpricedLocations = 100
const day = 86_400_000
const budget = { first: 10_000, warm: 2_000 }
const rates = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
const providers = ["openai", "anthropic", "google", "xai"]
const repository = path.resolve(import.meta.dirname, "../../..")
const target = process.env.CARGO_TARGET_DIR ?? path.join(repository, "rust/target")
const runtimeExecutable = process.env.YCODING_RUNTIME_EXECUTABLE ?? path.join(target, "release/ycoding-runtime")
const seedExecutable = path.join(target, "release/examples/usage_performance_seed")
const NativeSocket = WebSocket as typeof WebSocket & { new (url: string, options: WebSocketOptions): WebSocket }

type Model = { readonly providerID: string; readonly id: string; readonly variant?: string; readonly profile?: string }

type Population = {
  readonly model: Model
  requests: number
  recorded: number
  recordedCost: number
  decisionUnpriced: number
  catalogPriced: number
  catalogTokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
}

const Seeded = Schema.Struct({
  rows: Schema.Number,
  locations: Schema.Number,
  unpricedDirectories: Schema.Array(Schema.String),
  oldest: Schema.Number,
  newest: Schema.Number,
  populations: Schema.Array(
    Schema.Struct({
      model: Schema.Struct({
        providerID: Schema.String,
        id: Schema.String,
        variant: Schema.optional(Schema.String),
        profile: Schema.optional(Schema.String),
      }),
      requests: Schema.Number,
      recorded: Schema.Number,
      recordedCost: Schema.Number,
      decisionUnpriced: Schema.Number,
      catalogPriced: Schema.Number,
      catalogTokens: Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        reasoning: Schema.Number,
        cacheRead: Schema.Number,
        cacheWrite: Schema.Number,
      }),
    }),
  ),
})

const modelKey = (model: Model) =>
  JSON.stringify([model.providerID, model.id, model.variant ?? null, model.profile ?? null])

const round = (value: number) => Math.round(value * 10) / 10

const near = (actual: number | undefined, expected: number) =>
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThan(1e-4)

function catalogCost(tokens: Population["catalogTokens"]) {
  return (
    (tokens.input * rates.input +
      (tokens.output + tokens.reasoning) * rates.output +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite * rates.cacheWrite) /
    1_000_000
  )
}

function recipe(locationRoot: string, now: number) {
  const populations = new Map<string, Population>()
  const unpriced = new Set<string>()
  const directories = new Set<string>()
  let oldest = Number.POSITIVE_INFINITY
  let newest = Number.NEGATIVE_INFINITY
  for (let index = 0; index < rows; index++) {
    const location = index % locations
    const family = Math.floor(index / 7) % 12
    const priced = location >= unpricedLocations
    const model: Model = priced
      ? {
          providerID: providers[family % 4]!,
          id: `model-${String(family).padStart(2, "0")}`,
          ...(family % 3 === 0 ? { variant: "high" } : {}),
          ...(family % 5 === 0 ? { profile: "work" } : {}),
        }
      : { providerID: "local", id: `local-${index % 3}` }
    const source = index % 41 === 0 ? "title" : index % 97 === 0 ? "decision" : "step"
    const directory = `${locationRoot}/location-${String(location).padStart(4, "0")}`
    const time = now - Math.trunc((index * (30 * day - 1)) / rows)
    directories.add(directory)
    oldest = Math.min(oldest, time)
    newest = Math.max(newest, time)
    const key = modelKey(model)
    const population = populations.get(key) ?? {
      model,
      requests: 0,
      recorded: 0,
      recordedCost: 0,
      decisionUnpriced: 0,
      catalogPriced: 0,
      catalogTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    }
    populations.set(key, population)
    population.requests++
    if (priced) {
      population.recorded++
      population.recordedCost += (index % 17) * 0.0001
      continue
    }
    unpriced.add(directory)
    if (source === "decision") {
      population.decisionUnpriced++
      continue
    }
    population.catalogPriced++
    population.catalogTokens.input += 1_000 + (index % 9_000)
    population.catalogTokens.output += 100 + (index % 900)
    population.catalogTokens.reasoning += index % 300
    population.catalogTokens.cacheRead += index % 5_000
    population.catalogTokens.cacheWrite += index % 700
  }
  const all = [...populations.values()]
  const decisionUnpriced = all.reduce((sum, population) => sum + population.decisionUnpriced, 0)
  const recordedCost = all.reduce((sum, population) => sum + population.recordedCost, 0)
  const estimatedCost = all.reduce((sum, population) => sum + catalogCost(population.catalogTokens), 0)
  return {
    populations,
    directories: directories.size,
    unpricedDirectories: [...unpriced].sort(),
    oldest,
    newest,
    recordedRequests: all.reduce((sum, population) => sum + population.recorded, 0),
    recordedCost,
    catalogPricedRequests: all.reduce((sum, population) => sum + population.catalogPriced, 0),
    catalogCost: estimatedCost,
    decisionUnpriced,
    expected: {
      logical: rows,
      costCoverage: { pricedRequests: rows - decisionUnpriced, unpricedRequests: decisionUnpriced },
      cost: recordedCost + estimatedCost,
    },
  }
}

async function executable(file: string, build: string) {
  await access(file, constants.X_OK).catch(() => {
    throw new Error(`${file} is not built; run ${build}`)
  })
}

async function seed(store: string, locationRoot: string, now: number) {
  const child = Bun.spawn(
    [seedExecutable, store, locationRoot, String(now), String(rows), String(locations), String(unpricedLocations)],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Usage seed failed (${code}): ${stderr}`)
  return Schema.decodeUnknownSync(Schema.fromJsonString(Seeded))(stdout.trim())
}

async function startRuntime(root: string, workspace: string, config: string, store: string) {
  const password = crypto.randomUUID()
  await mkdir(path.join(root, "home"), { recursive: true })
  const child = Bun.spawn([runtimeExecutable, "--stdio", "--port", "0"], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "data"),
      YCODING_CONFIG_DIR: config,
      YCODING_CONFIG_PROJECT_DISABLE: "1",
      YCODING_DISABLE_MODELS_FETCH: "1",
      YCODING_MODELS_PATH: path.join(config, "models.json"),
      YCODING_DB: store,
      YCODING_VERSION: "local",
      YCODING_PASSWORD: password,
      YCODING_PRINT_LOGS: "1",
      YCODING_LOG_LEVEL: process.env.YCODING_LOG_LEVEL ?? "INFO",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const errors = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000)
  let output = ""
  try {
    while (!output.includes("\n")) {
      const next = await reader.read()
      if (next.done) throw new Error(`Rust runtime exited before readiness: ${await errors}`)
      output += new TextDecoder().decode(next.value)
    }
  } catch (error) {
    child.kill("SIGTERM")
    await child.exited
    throw error
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
  const ready = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ url: Schema.String })))(
    output.split("\n")[0],
  )
  const client = YCoding.make({
    endpoint: { url: ready.url, auth: { type: "basic", username: "ycoding", password } },
    location: { directory: workspace },
  })
  await client.transport.ready()
  return {
    client,
    logs: errors,
    async close() {
      client.transport.close()
      await child.stdin.end()
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
      await child.exited
      clearTimeout(timeout)
      const stderr = await errors
      if (child.exitCode !== 0) throw new Error(`Rust runtime shutdown failed: ${stderr}`)
    },
  }
}

type Read = { readonly label: string; readonly ms: number; readonly status: string }

test(
  "six simultaneous dashboard Usage reads settle through the native runtime, its connector, and a local relay within the first-read and warm budgets",
  async () => {
    await executable(
      seedExecutable,
      "cargo build --locked --release --manifest-path rust/Cargo.toml -p ycoding-core --example usage_performance_seed",
    )
    await executable(
      runtimeExecutable,
      "cargo build --locked --release --manifest-path rust/Cargo.toml -p ycoding-runtime --bin ycoding-runtime",
    )
    const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-usage-dashboard-"))
    const disposals: (() => Promise<unknown>)[] = []
    const failures: unknown[] = []
    const evidence: Record<string, unknown> = { rows, locations, unpricedLocations }
    let runtimeLogs: Promise<string> | undefined
    let relayLogs: (() => Promise<{ stdout: string; stderr: string }>) | undefined
    try {
      const locationRoot = path.join(root, "locations")
      const workspace = path.join(root, "workspace")
      const config = path.join(root, "config/ycoding")
      const store = path.join(root, "data/usage-performance.redb")
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(config, { recursive: true }),
        mkdir(path.dirname(store), { recursive: true }),
        ...Array.from({ length: unpricedLocations }, (_, index) =>
          mkdir(path.join(locationRoot, `location-${String(index).padStart(4, "0")}`), { recursive: true }),
        ),
      ])
      await writeFile(path.join(config, "models.json"), "{}")
      await writeFile(
        path.join(config, "ycoding.json"),
        JSON.stringify({
          providers: {
            local: {
              package: "aisdk:@ai-sdk/openai-compatible",
              name: "Local synthetic",
              settings: { baseURL: "http://127.0.0.1:9/v1", apiKey: "synthetic" },
              models: Object.fromEntries(
                [0, 1, 2].map((index) => [
                  `local-${index}`,
                  {
                    name: `Local ${index}`,
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    limit: { context: 100_000, output: 4_096 },
                    cost: {
                      input: rates.input,
                      output: rates.output,
                      cache: { read: rates.cacheRead, write: rates.cacheWrite },
                    },
                  },
                ]),
              ),
            },
          },
          analytics_retention: { usage_days: 31 },
        }),
      )

      const now = Date.now()
      const expected = recipe(locationRoot, now)
      const seedStarted = performance.now()
      const seeded = await seed(store, locationRoot, now)
      evidence.seedMs = round(performance.now() - seedStarted)
      expect({ rows: seeded.rows, locations: seeded.locations, oldest: seeded.oldest, newest: seeded.newest }).toEqual({
        rows,
        locations: expected.directories,
        oldest: expected.oldest,
        newest: expected.newest,
      })
      expect(expected.directories).toBe(locations)
      expect(seeded.unpricedDirectories).toEqual(expected.unpricedDirectories)
      expect(seeded.unpricedDirectories).toHaveLength(unpricedLocations)
      expect(seeded.newest - seeded.oldest).toBeGreaterThan(29 * day)
      expect(seeded.newest - seeded.oldest).toBeLessThan(30 * day)
      expect(expected.catalogPricedRequests).toBeGreaterThan(0)
      expect(expected.catalogCost).toBeGreaterThan(0)
      expect(expected.decisionUnpriced).toBeGreaterThan(0)
      expect(seeded.populations.map((population) => modelKey(population.model)).sort()).toEqual(
        [...expected.populations.keys()].sort(),
      )
      for (const population of seeded.populations) {
        const recipePopulation = expected.populations.get(modelKey(population.model))!
        expect({
          model: population.model,
          requests: population.requests,
          recorded: population.recorded,
          decisionUnpriced: population.decisionUnpriced,
          catalogPriced: population.catalogPriced,
          catalogTokens: population.catalogTokens,
        }).toEqual({
          model: recipePopulation.model,
          requests: recipePopulation.requests,
          recorded: recipePopulation.recorded,
          decisionUnpriced: recipePopulation.decisionUnpriced,
          catalogPriced: recipePopulation.catalogPriced,
          catalogTokens: recipePopulation.catalogTokens,
        })
        near(population.recordedCost, recipePopulation.recordedCost)
      }

      const serverStarted = performance.now()
      const runtime = await startRuntime(path.join(root, "runtime"), workspace, config, store)
      disposals.push(() => runtime.close())
      runtimeLogs = runtime.logs
      evidence.serverStartMs = round(performance.now() - serverStarted)
      const local = runtime.client

      const relay = await localRelay(path.join(root, "relay"))
      relayLogs = relay.logs
      disposals.push(() => relay.close())
      const enrollment = Schema.decodeUnknownSync(Schema.Struct({ enrollmentID: Schema.String, code: Schema.String }))(
        await relay.json("/api/devices/enrollments", {}),
      )
      const enrolled = await local.remote.enroll({
        relayOrigin: relay.origin,
        enrollmentID: enrollment.enrollmentID,
        code: enrollment.code,
        name: "Usage performance fixture",
      })
      await local.remote.set({ enabled: true })
      disposals.push(() => local.remote.set({ enabled: false }))
      await until(async () => {
        const state = await local.remote.get()
        return state.state === "on" && state.device?.credentialState === "valid"
      }, "native connector live")
      await until(async () => {
        const listing = Schema.decodeUnknownSync(
          Schema.Struct({ devices: Schema.Array(Schema.Struct({ id: Schema.String, online: Schema.Boolean })) }),
        )(await relay.json("/api/devices"))
        return listing.devices.some((device) => device.id === enrolled.deviceID && device.online)
      }, "relay device online")

      const timings: RemoteRequestTiming[] = []
      const statuses: { at: number; status: RemoteTransportStatus }[] = []
      evidence.transportStatuses = statuses
      const transport = createRemoteTransport({
        url: `${relay.origin.replace("http", "ws")}${RemoteWebSocketPath.client}?device=${enrolled.deviceID}`,
        handlers: {
          onRequestTiming: (timing) => timings.push(timing),
          onStatus: (status) => statuses.push({ at: round(performance.now()), status }),
        },
        createSocket: (url) => new NativeSocket(url, { headers: { cookie: relay.cookie, origin: relay.origin } }),
      })
      disposals.push(async () => transport.close())
      transport.connect()
      await until(async () => transport.status().kind === "open", "browser transport open")

      const scope: QueryScope = { deviceID: enrolled.deviceID, generation: 1 }
      const outcomes: string[] = []
      const details: { at: number; operation: string; outcome: unknown }[] = []
      evidence.outcomeDetails = details
      const link: RemoteLink = {
        request: async (_, operation, request) => {
          const outcome = await transport.request(operation, request)
          outcomes.push(`${operation}:${outcome.status}`)
          if (outcome.status !== "ok") details.push({ at: round(performance.now()), operation, outcome })
          return outcome
        },
        recoveries: () => 0,
        recovered: async () => false,
      }

      const readRound = async () => {
        timings.length = 0
        outcomes.length = 0
        const client = createRemoteQueryClient()
        const queries = createRemoteQueries(link, client)
        const inputs = usageReportInputs(Date.now(), undefined)
        const read = async (label: string, run: () => Promise<{ readonly status: string }>): Promise<Read> => {
          const begin = performance.now()
          const status = await run().then(
            (value) => value.status,
            (error: unknown) => `error:${error instanceof Error ? error.message : String(error)}`,
          )
          return { label, ms: round(performance.now() - begin), status }
        }
        const started = performance.now()
        const reads = await Promise.all([
          read("usage.providers", () => client.fetchQuery(queries.usageProviders(scope, true))),
          read("usage.summary", () => client.fetchQuery(queries.usageSummary(scope, true))),
          read("usage.forecast", () => client.fetchQuery(queries.usageForecast(scope, true))),
          read("usage.report:30", () => client.fetchQuery(queries.usageReport(scope, true, inputs.daily))),
          read("usage.report:200", () => client.fetchQuery(queries.usageReport(scope, true, inputs.monthly))),
          read("usage.report:25", () => client.fetchQuery(queries.usageReport(scope, true, inputs.breakdown))),
        ])
        const wallMs = round(performance.now() - started)
        client.clear()
        return {
          wallMs,
          reads,
          transport: timings.map((timing) => ({
            operation: timing.operation,
            outcome: timing.outcome,
            queueMs: timing.queueMs,
            settlementMs: timing.settlementMs,
            totalMs: timing.totalMs,
          })),
          outcomes: [...outcomes],
        }
      }

      const first = await readRound()
      evidence.first = first
      const warm1 = await readRound()
      evidence.warm1 = warm1
      const warm2 = await readRound()
      evidence.warm2 = warm2
      const inputs = usageReportInputs(Date.now(), undefined)
      const directReads = [
        ["usage.providers", () => local.providerUsage.list()],
        ["usage.summary", () => local.usage.get()],
        ["usage.forecast", () => local.providerUsage.forecast({ localScope: "backend" })],
        ["usage.report:30", () => local.usage.report(inputs.daily)],
        ["usage.report:200", () => local.usage.report(inputs.monthly)],
        ["usage.report:25", () => local.usage.report(inputs.breakdown)],
      ] satisfies [string, () => Promise<unknown>][]
      const settle = async ([label, run]: (typeof directReads)[number]) => {
        const begin = performance.now()
        const outcome = await run().then(
          () => "ok",
          (error: unknown) => `error:${error instanceof Error ? error.message : JSON.stringify(error)}`,
        )
        return { label, ms: round(performance.now() - begin), outcome }
      }
      const direct = await Promise.all(directReads.map(settle))
      evidence.runtimeDirectWarm = direct
      const sequential: Awaited<ReturnType<typeof settle>>[] = []
      for (const read of directReads) sequential.push(await settle(read))
      evidence.runtimeDirectSequential = sequential
      expect({ direct: direct.filter((read) => read.outcome !== "ok") }).toEqual({ direct: [] })
      expect({ sequential: sequential.filter((read) => read.outcome !== "ok") }).toEqual({ sequential: [] })
      const everything = await local.usage.report({
        group: "model",
        offset: 0,
        limit: 200,
        sort: "cost",
        order: "desc",
      })
      const summary = await local.usage.get()
      evidence.pricing = {
        recordedRequests: expected.recordedRequests,
        recordedCost: expected.recordedCost,
        catalogPricedRequests: expected.catalogPricedRequests,
        catalogCost: expected.catalogCost,
        decisionUnpriced: expected.decisionUnpriced,
        expected: expected.expected,
        observed: {
          logical: everything.total.logical,
          costCoverage: everything.total.costCoverage,
          cost: everything.total.cost,
          costProvenance: everything.total.costProvenance,
          summaryCost: summary.cost,
        },
      }

      expect({
        logical: everything.total.logical,
        costCoverage: everything.total.costCoverage,
        costProvenance: everything.total.costProvenance,
        rowCount: everything.rowCount,
      }).toEqual({
        logical: expected.expected.logical,
        costCoverage: expected.expected.costCoverage,
        costProvenance: "current_catalog",
        rowCount: expected.populations.size,
      })
      near(everything.total.cost, expected.expected.cost)
      for (const row of everything.rows) {
        const population = expected.populations.get(modelKey(row.model!))!
        const estimated = population.catalogPriced > 0
        expect({
          model: row.model,
          logical: row.logical,
          costCoverage: row.costCoverage,
          costProvenance: row.costProvenance,
        }).toEqual({
          model: population.model,
          logical: population.requests,
          costCoverage: {
            pricedRequests: population.requests - population.decisionUnpriced,
            unpricedRequests: population.decisionUnpriced,
          },
          costProvenance: estimated ? "current_catalog" : "recorded",
        })
        near(row.cost, population.recordedCost + catalogCost(population.catalogTokens))
      }
      expect(summary.logical).toBe(expected.expected.logical)
      near(summary.cost, expected.expected.cost)
      expect((summary.models ?? []).map((spend) => modelKey(spend.model)).sort()).toEqual(
        [...expected.populations.keys()].sort(),
      )
      for (const spend of summary.models ?? []) {
        const population = expected.populations.get(modelKey(spend.model))!
        expect({ requests: spend.requests, costProvenance: spend.costProvenance }).toEqual({
          requests: population.requests,
          costProvenance: population.catalogPriced > 0 ? "current_catalog" : "recorded",
        })
        near(spend.cost, population.recordedCost + catalogCost(population.catalogTokens))
      }
      for (const [name, value, limit] of [
        ["first", first, budget.first],
        ["warm1", warm1, budget.warm],
        ["warm2", warm2, budget.warm],
      ] as const) {
        expect({ name, statuses: value.reads.map((read) => `${read.label}:${read.status}`) }).toEqual({
          name,
          statuses: [
            "usage.providers",
            "usage.summary",
            "usage.forecast",
            "usage.report:30",
            "usage.report:200",
            "usage.report:25",
          ].map((label) => `${label}:ready`),
        })
        expect({ name, outcomes: [...value.outcomes].sort() }).toEqual({
          name,
          outcomes: [
            "providerUsage.forecast:ok",
            "providerUsage.list:ok",
            "usage.get:ok",
            "usage.report:ok",
            "usage.report:ok",
            "usage.report:ok",
          ].sort(),
        })
        expect({
          name,
          over: value.reads.filter((read) => read.ms > limit).map((read) => `${read.label}=${read.ms}ms`),
        }).toEqual({
          name,
          over: [],
        })
      }
    } catch (error) {
      failures.push(error)
    }
    for (const dispose of disposals.reverse()) await dispose().catch((error: unknown) => failures.push(error))
    const logs = (await runtimeLogs) ?? ""
    const directory = path.join(import.meta.dirname, "..", "tmp")
    await mkdir(directory, { recursive: true })
    await Bun.write(path.join(directory, "usage-dashboard-performance.json"), JSON.stringify(evidence, null, 2))
    await Bun.write(path.join(directory, "usage-dashboard-runtime.log"), logs)
    if (relayLogs) {
      const relay = await relayLogs()
      await Bun.write(path.join(directory, "usage-dashboard-relay.log"), `${relay.stdout}\n${relay.stderr}`)
    }
    console.log(`usage-dashboard-performance ${JSON.stringify(evidence)}`)
    if (failures.length > 0) console.error(`runtime log tail:\n${logs.split("\n").slice(-200).join("\n")}`)
    await rm(root, { recursive: true, force: true })
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Usage dashboard performance check failed")
  },
  { timeout: 900_000 },
)
