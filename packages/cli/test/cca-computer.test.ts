import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { RemoteLimits } from "@ycoding-ai/remote"
import { defaultTimeoutMs } from "../src/remote-control/cca-executor-registration"
import { ccaComputerCacheMs, ccaComputerProblems, createCcaComputerControl, type CcaComputerProblem, type CcaComputerStatus } from "../src/remote-control/cca-computer"
import { createCcaDotConversation } from "../src/remote-control/cca-dot-conversation"
import type { CcaDurableClient, CcaDurableReply, CcaDurableServerRequest } from "../src/remote-control/cca-durable-host"

const base = "https://chatgpt.com/backend-api"
const access = "synthetic-access-token-computer-0001"
const accountID = "synthetic-account-computer-0001"
const executorID = "ccarenv_b64_synthetic/executor+0001"
const dotID = "tbo_synthetic_dot_0001"
const threadID = "thr_synthetic_root_0001"
const listURL = `${base}/tbo/${dotID}/computers?expected_thread_id=${threadID}`
const attachURL = `${base}/tbo/${dotID}/computers/${encodeURIComponent(executorID)}/connect-and-replace?expected_thread_id=${threadID}`
const registry = "https://codex-cloud-environments.chatgpt.com/api"
const readinessURL = `${registry}/cloud/environment/${encodeURIComponent(executorID)}/status`
const environmentURL = `${base}/tbo/${dotID}/environment/status?thread_id=${threadID}`
const detachURL = `${base}/tbo/${dotID}/computers/${encodeURIComponent(executorID)}/disconnect?expected_thread_id=${threadID}`
const removeURL = `${base}/computers/${encodeURIComponent(executorID)}`
const plainAttachURL = `${base}/tbo/${dotID}/computers/${encodeURIComponent(executorID)}/connect?expected_thread_id=${threadID}`

const configuration: NativeDots.Configuration = {
  enabled: true, accessRevision: 1, profile: "dots", credentialID: "credential-1", accountID, accountGeneration: 1,
}
const resolved = { access, accountID, key: "key", profile: "dots", credentialID: "credential-1", accountGeneration: 1 }
const completed = {
  installationID: "synthetic-installation", accountHash: createHash("sha256").update(accountID).digest("hex"), status: "completed",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", executorID,
}

type Reply = Response | Error | (() => Response | Error | Promise<Response | Error>)
type Seen = { readonly method: string; readonly url: string; readonly headers: Record<string, string>; readonly body: unknown; readonly signal: AbortSignal | null | undefined }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const row = (fields: Record<string, unknown> = {}) => ({
  kind: "user", environment_id: executorID, status: "online", is_attached: false, can_connect: true, can_disconnect: true, ...fields,
})
const computers = (rows: unknown[], fields: Record<string, unknown> = {}) =>
  json(200, { thread_id: threadID, computers: rows, local_computer_access_disabled_by_admin: false, ...fields })
const dots = (items: unknown[], cursor: string | null = null) => json(200, { items, cursor })
const activeDot = { id: dotID, status: "active" }
const target = { dotID, threadID, environmentID: executorID, revision: expect.stringMatching(/^[a-f0-9]{64}$/) }

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function fixture(options: {
  readonly routes: Record<string, Reply[]>
  readonly stored?: unknown
  readonly configuration?: NativeDots.Configuration
  readonly credential?: typeof resolved | undefined
  readonly observeMs?: number
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-cca-computer-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, "cca-executor.json")
  const stored = "stored" in options ? options.stored : completed
  if (stored !== undefined) await writeFile(statePath, typeof stored === "string" ? stored : JSON.stringify(stored), { mode: 0o600 })
  const seen: Seen[] = []
  const extras: Seen[] = []
  const diagnostics: string[] = []
  let clock = 1_000_000
  let current = options.configuration ?? configuration
  const control = createCcaComputerControl({
    onDiagnostic: (message) => diagnostics.push(message),
    native: {
      configuration: async () => current,
      credential: async () => ("credential" in options ? options.credential : resolved),
    },
    statePath,
    now: () => clock,
    ...(options.observeMs === undefined ? {} : { observeMs: options.observeMs }),
    fetch: async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const entry = { method: init?.method ?? "GET", url, headers, body: init?.body, signal: init?.signal }
      if (/\/cloud\/environment\/[^/]+\/status$/.test(url) || url.startsWith(`${base}/tbo/${dotID}/environment/status`)) extras.push(entry)
      else seen.push(entry)
      expect(init?.redirect).toBe("error")
      init?.signal?.throwIfAborted()
      const queue = options.routes[`${init?.method ?? "GET"} ${url}`]
      const next = queue?.shift()
      if (next === undefined) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`)
      const aborted = () => new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
      const reply = typeof next === "function" ? await Promise.race([Promise.resolve(next()), aborted()]) : next
      if (reply instanceof Error) throw reply
      return reply
    },
  })
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    while (!(await predicate())) await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return {
    control, seen, extras, until, diagnostics, statePath,
    advance: (ms: number) => { clock += ms },
    reconfigure: (next: NativeDots.Configuration) => { current = next },
  }
}

const read = (rows: Reply[] = [computers([row()])]) => ({
  [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [dots([activeDot])],
  [`GET ${base}/tbo/${dotID}/root-thread`]: [json(200, { root_thread_id: threadID })],
  [`GET ${listURL}`]: rows,
})

function merge(...routes: Record<string, Reply[]>[]) {
  const merged: Record<string, Reply[]> = {}
  for (const route of routes) for (const [key, value] of Object.entries(route)) merged[key] = [...(merged[key] ?? []), ...value]
  return merged
}

describe("computer status", () => {
  test("reads the active Dot, its root thread and the executor row with the CCA headers", async () => {
    const { control, seen } = await fixture({ routes: read([computers([row({ environment_id: "other" }), row({ is_attached: true })])]) })
    expect(await control.computer()).toEqual({ state: "attached", target })
    expect(seen.map((item) => `${item.method} ${item.url}`)).toEqual([
      `GET ${base}/tbo?limit=25&include_room_preview=false`,
      `GET ${base}/tbo/${dotID}/root-thread`,
      `GET ${listURL}`,
    ])
    for (const item of seen) {
      expect(item.headers.authorization).toBe(`Bearer ${access}`)
      expect(item.headers["chatgpt-account-id"]).toBe(accountID)
      expect(item.headers.originator).toBe("Codex Desktop")
      expect(item.headers["user-agent"]).toStartWith("Codex Desktop/")
      expect(item.body).toBeUndefined()
    }
  })

  test("reports a listed detached executor as detached", async () => {
    const { control } = await fixture({ routes: read() })
    expect(await control.computer()).toEqual({ state: "detached", target })
  })

  test("follows Dot list cursors and ignores inactive Dots", async () => {
    const { control } = await fixture({
      routes: {
        [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [dots([{ id: "tbo_old", status: "archived" }], "next/page")],
        [`GET ${base}/tbo?cursor=next%2Fpage&limit=25&include_room_preview=false`]: [dots([activeDot])],
        [`GET ${base}/tbo/${dotID}/root-thread`]: [json(200, { root_thread_id: threadID })],
        [`GET ${listURL}`]: [computers([row({ is_attached: true })])],
      },
    })
    expect(await control.computer()).toEqual({ state: "attached", target })
  })

  test("selects the primary Dot when several are active", async () => {
    const { control } = await fixture({
      routes: {
        [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [dots([{ id: "tbo_other", status: "active" }, activeDot])],
        [`GET ${base}/tbo/primary`]: [json(200, { profile: { id: dotID, status: "active" }, selection: null })],
        [`GET ${base}/tbo/${dotID}/root-thread`]: [json(200, { root_thread_id: threadID })],
        [`GET ${listURL}`]: [computers([row({ is_attached: true })])],
      },
    })
    expect(await control.computer()).toEqual({ state: "attached", target })
  })

  test("fails with a fixed category when no single Dot can be chosen", async () => {
    const cases: Record<string, Reply[]>[] = [
      { [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [dots([{ id: "tbo_old", status: "archived" }])] },
      {
        [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [dots([{ id: "tbo_a", status: "active" }, { id: "tbo_b", status: "active" }])],
        [`GET ${base}/tbo/primary`]: [json(200, { profile: { id: "tbo_elsewhere" } })],
      },
      {
        [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [dots([{ id: "tbo_a", status: "active" }, { id: "tbo_b", status: "active" }])],
        [`GET ${base}/tbo/primary`]: [json(200, { profile: null, selection: null })],
      },
      {
        [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [dots([activeDot])],
        [`GET ${base}/tbo/${dotID}/root-thread`]: [json(200, { root_thread_id: null })],
      },
      {
        [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [dots([activeDot])],
        [`GET ${base}/tbo/${dotID}/root-thread`]: [json(200, { root_thread_id: threadID })],
        [`GET ${listURL}`]: [json(200, { thread_id: "thr_changed", computers: [row({ is_attached: true })] })],
      },
    ]
    for (const routes of cases) {
      const { control } = await fixture({ routes })
      expect(await control.computer()).toEqual({ state: "unavailable", problem: "dot-unavailable" })
    }
  })

  test("reports an unlisted executor and admin or connect restrictions", async () => {
    expect(await (await fixture({ routes: read([computers([row({ environment_id: "other" })])]) })).control.computer())
      .toEqual({ state: "unavailable", problem: "not-listed" })
    expect(await (await fixture({ routes: read([computers([row()], { local_computer_access_disabled_by_admin: true })]) })).control.computer())
      .toEqual({ state: "detached", problem: "admin-disabled", target })
    expect(await (await fixture({ routes: read([computers([row({ can_connect: false })])]) })).control.computer())
      .toEqual({ state: "detached", problem: "not-connectable", target })
  })

  test("never calls ChatGPT without enabled access, a pinned credential and a completed enrollment for the account", async () => {
    const cases: { readonly options: Partial<Parameters<typeof fixture>[0]>; readonly problem: CcaComputerProblem }[] = [
      { options: { configuration: { enabled: false } }, problem: "configuration" },
      { options: { credential: undefined }, problem: "authentication" },
      { options: { credential: { ...resolved, accountGeneration: 2 } }, problem: "authentication" },
      { options: { stored: undefined }, problem: "enrollment" },
      { options: { stored: { ...completed, status: "uncertain" } }, problem: "enrollment" },
      { options: { stored: { ...completed, accountHash: "0".repeat(64) } }, problem: "enrollment" },
      { options: { stored: { ...completed, executorID: " " } }, problem: "enrollment" },
      { options: { stored: "{not json" }, problem: "enrollment" },
    ]
    for (const item of cases) {
      const { control, seen } = await fixture({ routes: {}, ...item.options })
      expect(await control.computer()).toEqual({ state: "unavailable", problem: item.problem })
      expect(seen).toEqual([])
    }
  })

  test("maps HTTP, network and payload failures to fixed categories", async () => {
    const cases: { readonly reply: Reply; readonly problem: CcaComputerProblem }[] = [
      { reply: json(401, { detail: "secret detail" }), problem: "authentication" },
      { reply: json(403, {}), problem: "authentication" },
      { reply: json(500, {}), problem: "connection" },
      { reply: new Error("socket hang up"), problem: "connection" },
      { reply: new Response("not json", { status: 200 }), problem: "connection" },
      { reply: json(200, { thread_id: threadID, computers: "nope" }), problem: "connection" },
    ]
    for (const item of cases) {
      const { control } = await fixture({ routes: read([item.reply]) })
      const status = await control.computer()
      expect(status).toEqual({ state: "unavailable", problem: item.problem })
      expect(JSON.stringify(status)).not.toContain("secret")
    }
  })

  test("reuses one remote read for the cache window and shares a concurrent first read", async () => {
    const { control, seen, advance } = await fixture({ routes: read([computers([row()])]) })
    const [first, concurrent] = await Promise.all([control.computer(), control.computer()])
    expect(first).toEqual({ state: "detached", target })
    expect(concurrent).toEqual({ state: "detached", target })
    advance(ccaComputerCacheMs - 1)
    expect(await control.computer()).toEqual({ state: "detached", target })
    expect(seen.length).toBe(3)
  })

  test("a stale cache answers immediately and starts one background refresh shared by concurrent reads", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { control, seen, advance, until } = await fixture({
      routes: merge(read([computers([row()])]), read([async () => { await gate; return computers([row({ is_attached: true })]) }])),
    })
    expect(await control.computer()).toEqual({ state: "detached", target })
    advance(ccaComputerCacheMs)
    expect(await control.computer()).toEqual({ state: "detached", target })
    expect(await control.computer()).toEqual({ state: "detached", target })
    await until(() => seen.length === 6)
    expect(await control.computer()).toEqual({ state: "detached", target })
    release()
    await until(async () => (await control.computer()).state === "attached")
    expect(seen.length).toBe(6)
  })

  test("a failed refresh keeps the last value, reports a fixed reason and waits a full window before retrying", async () => {
    const { control, seen, advance, until, diagnostics } = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), read([json(502, { detail: "secret detail" })]), read([computers([row()])])),
    })
    expect(await control.computer()).toEqual({ state: "attached", target })
    advance(ccaComputerCacheMs)
    expect(await control.computer()).toEqual({ state: "attached", target })
    await until(() => diagnostics.length === 1)
    expect(diagnostics).toEqual(["CCA computer refresh-failed problem=connection"])
    expect(await control.computer()).toEqual({ state: "attached", target })
    expect(seen.length).toBe(6)
    advance(ccaComputerCacheMs)
    expect(await control.computer()).toEqual({ state: "attached", target })
    await until(async () => (await control.computer()).state === "detached")
    expect(seen.length).toBe(9)
  })

  test("a configuration or executor change drops the old cache and awaits a fresh read", async () => {
    const other = "ccarenv_b64_synthetic-other-executor"
    const { control, seen, reconfigure, statePath } = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), read([computers([row()])]), read([computers([row(), row({ environment_id: other, is_attached: true })])])),
    })
    expect(await control.computer()).toEqual({ state: "attached", target })
    reconfigure({ ...configuration, accessRevision: 2 })
    expect(await control.computer()).toEqual({ state: "detached", target })
    expect(seen.length).toBe(6)
    await writeFile(statePath, JSON.stringify({ ...completed, executorID: other }), { mode: 0o600 })
    expect(await control.computer()).toEqual({ state: "attached", target: { ...target, environmentID: other } })
    expect(seen.length).toBe(9)
  })

  test("lists not-listed only when the persisted executor is absent from the selected Dot's computers", async () => {
    const absent = await fixture({ routes: read([computers([row({ environment_id: "other", is_attached: true }), row({ environment_id: `${executorID}-suffix`, is_attached: true })])]) })
    expect(await absent.control.computer()).toEqual({ state: "unavailable", problem: "not-listed" })
    const present = await fixture({ routes: read([computers([row({ environment_id: "other", is_attached: true }), row()])]) })
    expect(await present.control.computer()).toEqual({ state: "detached", target })
    const empty = await fixture({ routes: read([computers([])]) })
    expect(await empty.control.computer()).toEqual({ state: "unavailable", problem: "not-listed" })
  })

  test("exposes only the closed problem set", () => {
    expect([...ccaComputerProblems]).toEqual([
      "configuration", "authentication", "enrollment", "dot-unavailable", "not-listed",
      "admin-disabled", "not-connectable", "rejected", "unconfirmed", "connection", "target-changed",
      "not-disconnectable", "not-deletable",
    ])
  })
})

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const slow = (ms: number, reply: Response) => async () => { await pause(ms); return reply }
const stalled = () => new Promise<Response>(() => {})
const budgetMs = 70

describe("observation deadline", () => {
  test("a chain of slow successful reads that exceeds the overall budget settles as connection and cancels the rest", async () => {
    const { control, seen } = await fixture({
      observeMs: budgetMs,
      routes: {
        [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [slow(40, dots([activeDot]))],
        [`GET ${base}/tbo/${dotID}/root-thread`]: [slow(40, json(200, { root_thread_id: threadID }))],
        [`GET ${listURL}`]: [slow(40, computers([row({ is_attached: true })]))],
      },
    })
    const started = performance.now()
    expect(await control.computer()).toEqual({ state: "unavailable", problem: "connection" })
    expect(performance.now() - started).toBeLessThan(120)
    expect(seen.map((item) => item.url)).toEqual([`${base}/tbo?limit=25&include_room_preview=false`, `${base}/tbo/${dotID}/root-thread`])
    expect(seen[1]?.signal?.aborted).toBe(true)
  })

  test("a stalled read settles inside the budget and aborts the pending request", async () => {
    const { control, seen } = await fixture({ observeMs: budgetMs, routes: read([stalled]) })
    const started = performance.now()
    expect(await control.computer()).toEqual({ state: "unavailable", problem: "connection" })
    expect(performance.now() - started).toBeLessThan(500)
    expect(seen.at(-1)?.url).toBe(listURL)
    expect(seen.at(-1)?.signal?.aborted).toBe(true)
  })

  test("a stalled attach pre-read settles inside the budget without posting", async () => {
    const { control, seen } = await fixture({ observeMs: budgetMs, routes: read([stalled]) })
    expect(await control.attach({ replaceOthers: false })).toEqual({ state: "unavailable", problem: "connection" })
    expect(seen.filter((item) => item.method === "POST")).toEqual([])
  })

  test("a cold deadline expiry is replaced by the next successful read after the cache window", async () => {
    const { control, advance, until } = await fixture({
      observeMs: budgetMs,
      routes: merge(read([stalled]), read([computers([row({ is_attached: true })])])),
    })
    expect(await control.computer()).toEqual({ state: "unavailable", problem: "connection" })
    advance(ccaComputerCacheMs)
    expect(await control.computer()).toEqual({ state: "unavailable", problem: "connection" })
    await until(async () => (await control.computer()).state === "attached")
    expect(await control.computer()).toEqual({ state: "attached", target })
  })

  test("a deadline expiry after a successful read keeps the prior state and the next success replaces it", async () => {
    const { control, advance, until, diagnostics } = await fixture({
      observeMs: budgetMs,
      routes: merge(read([computers([row({ is_attached: true })])]), read([stalled]), read([computers([row()])])),
    })
    expect(await control.computer()).toEqual({ state: "attached", target })
    advance(ccaComputerCacheMs)
    expect(await control.computer()).toEqual({ state: "attached", target })
    await until(() => diagnostics.length === 1)
    expect(await control.computer()).toEqual({ state: "attached", target })
    advance(ccaComputerCacheMs)
    await control.computer()
    await until(async () => (await control.computer()).state === "detached")
    expect(await control.computer()).toEqual({ state: "detached", target })
  })

  test("the default observation deadline is the shared limit, outlasts one request and fits the browser status budget", () => {
    expect(defaultTimeoutMs).toBe(RemoteLimits.dotsConnectMs)
    expect(RemoteLimits.dotsComputerObserveMs).toBeGreaterThan(defaultTimeoutMs)
    expect(RemoteLimits.dotsComputerObserveMs).toBeLessThan(RemoteLimits.dotsStatusMs)
    expect(2 * RemoteLimits.dotsComputerObserveMs + RemoteLimits.dotsConnectMs).toBeLessThan(RemoteLimits.dotsAttachMs)
  })
})

describe("attach", () => {
  test("posts connect-and-replace once without a body and returns the re-read state", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [new Response(null, { status: 204 })] }, read([computers([row({ is_attached: true })])])),
    })
    expect(await control.attach({ replaceOthers: true })).toEqual({ state: "attached", target })
    const posts = seen.filter((item) => item.method === "POST")
    expect(posts.map((item) => item.url)).toEqual([attachURL])
    expect(posts[0]!.body).toBeUndefined()
    expect(posts[0]!.headers.authorization).toBe(`Bearer ${access}`)
    expect(posts[0]!.headers.originator).toBe("Codex Desktop")
    expect(seen.map((item) => item.method)).toEqual(["GET", "GET", "GET", "POST", "GET", "GET", "GET"])
    expect(await control.computer()).toEqual({ state: "attached", target })
    expect(seen.length).toBe(7)
  })

  test("non-replacing attach posts connect once and leaves attached peers listed", async () => {
    const { control, seen } = await fixture({
      routes: merge(
        read([computers([row({ environment_id: "other", display_name: "Shared desk", is_attached: true }), row({ display_name: "Shared desk" })])]),
        { [`POST ${plainAttachURL}`]: [new Response(null, { status: 204 })] },
        read([computers([row({ environment_id: "other", display_name: "Shared desk", is_attached: true }), row({ display_name: "Shared desk", is_attached: true })])]),
      ),
    })
    const status = await control.attach({ replaceOthers: false })
    expect(status).toEqual({ state: "attached", name: "Shared desk", target })
    const posts = seen.filter((item) => item.method === "POST")
    expect(posts.map((item) => item.url)).toEqual([plainAttachURL])
    expect(posts[0]!.body).toBeUndefined()
    expect(posts[0]!.headers.authorization).toBe(`Bearer ${access}`)
    expect(posts[0]!.headers.originator).toBe("Codex Desktop")
    expect(seen.map((item) => item.method)).toEqual(["GET", "GET", "GET", "POST", "GET", "GET", "GET"])
  })

  test("replacing and non-replacing attaches with the same target post separately", async () => {
    const { control, seen } = await fixture({
      routes: merge(
        read([computers([row()])]),
        read([computers([row()])]),
        { [`POST ${plainAttachURL}`]: [new Response(null, { status: 204 })] },
        { [`POST ${attachURL}`]: [new Response(null, { status: 204 })] },
        read([computers([row({ is_attached: true })])]),
        read([computers([row({ is_attached: true })])]),
      ),
    })
    const [first, second] = await Promise.all([control.attach({ replaceOthers: false }), control.attach({ replaceOthers: true })])
    expect(first).toEqual({ state: "attached", target })
    expect(second).toEqual({ state: "attached", target })
    expect(seen.filter((item) => item.method === "POST").map((item) => item.url).sort()).toEqual([attachURL, plainAttachURL].sort())
  })

  test("reads fresh state before posting even when a cached read exists", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row()])]), read([computers([row({ is_attached: true })])])),
    })
    expect(await control.computer()).toEqual({ state: "detached", target })
    expect(await control.attach({ replaceOthers: false })).toEqual({ state: "attached", target })
    expect(seen.filter((item) => item.method === "POST")).toEqual([])
  })

  test("does not post when the executor is already attached, restricted, unlisted or unreadable", async () => {
    const cases: { readonly rows: Reply; readonly expected: CcaComputerStatus }[] = [
      { rows: computers([row({ is_attached: true })]), expected: { state: "attached" } },
      { rows: computers([row()], { local_computer_access_disabled_by_admin: true }), expected: { state: "detached", problem: "admin-disabled" } },
      { rows: computers([row({ can_connect: false })]), expected: { state: "detached", problem: "not-connectable" } },
      { rows: computers([]), expected: { state: "unavailable", problem: "not-listed" } },
      { rows: json(503, {}), expected: { state: "unavailable", problem: "connection" } },
    ]
    for (const item of cases) {
      const { control, seen } = await fixture({ routes: read([item.rows]) })
      expect(await control.attach({ replaceOthers: false })).toEqual({ ...item.expected, ...(item.expected.state === "unavailable" ? {} : { target }) })
      expect(seen.filter((entry) => entry.method === "POST")).toEqual([])
    }
  })

  test("never posts without enabled access", async () => {
    const { control, seen } = await fixture({ routes: {}, configuration: { enabled: false } })
    expect(await control.attach({ replaceOthers: false })).toEqual({ state: "unavailable", problem: "configuration" })
    expect(seen).toEqual([])
  })

  test("does not retry a refused attach and reports the re-read state", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [json(409, { detail: "secret detail" })] }, read([computers([row()])])),
    })
    const status = await control.attach({ replaceOthers: true })
    expect(status).toEqual({ state: "detached", problem: "rejected", target })
    expect(JSON.stringify(status)).not.toContain("secret")
    expect(seen.filter((item) => item.method === "POST").length).toBe(1)
  })

  test("a refused non-replacing attach posts once to connect and never falls back to replacement", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${plainAttachURL}`]: [json(409, { detail: "secret detail" })] }, read([computers([row()])])),
    })
    const status = await control.attach({ replaceOthers: false })
    expect(status).toEqual({ state: "detached", problem: "rejected", target })
    expect(JSON.stringify(status)).not.toContain("secret")
    const posts = seen.filter((item) => item.method === "POST")
    expect(posts).toHaveLength(1)
    expect(posts.map((item) => item.url)).toEqual([plainAttachURL])
  })

  test("trusts only the re-read after an uncertain or unconfirmed attach", async () => {
    const network = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [new Error("reset")] }, read([computers([row({ is_attached: true })])])),
    })
    expect(await network.control.attach({ replaceOthers: true })).toEqual({ state: "attached", target })
    expect(network.seen.filter((item) => item.method === "POST").length).toBe(1)

    const server = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [json(502, {})] }, read([computers([row()])])),
    })
    expect(await server.control.attach({ replaceOthers: true })).toEqual({ state: "detached", problem: "unconfirmed", target })
    expect(server.seen.filter((item) => item.method === "POST").length).toBe(1)

    const accepted = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [new Response(null, { status: 204 })] }, read([computers([row()])])),
    })
    expect(await accepted.control.attach({ replaceOthers: true })).toEqual({ state: "detached", problem: "unconfirmed", target })

    const unreadable = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [new Response(null, { status: 204 })] }, read([json(500, {})])),
    })
    expect(await unreadable.control.attach({ replaceOthers: true })).toEqual({ state: "unavailable", problem: "unconfirmed" })
  })

  test("joins concurrent attach calls into one post", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { control, seen, until } = await fixture({
      routes: merge(
        read([computers([row()])]),
        { [`POST ${attachURL}`]: [async () => { await gate; return new Response(null, { status: 204 }) }] },
        read([computers([row({ is_attached: true })])]),
      ),
    })
    const first = control.attach({ replaceOthers: true })
    await until(() => seen.some((item) => item.method === "POST"))
    const second = control.attach({ replaceOthers: true })
    release()
    expect(await Promise.all([first, second])).toEqual([{ state: "attached", target }, { state: "attached", target }])
    expect(seen.filter((item) => item.method === "POST").length).toBe(1)
  })

  test("a status read that started before the attach cannot replace the post-attach state", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { control, seen, until } = await fixture({
      routes: merge(
        read([async () => { await gate; return computers([row()]) }]),
        read([computers([row()])]),
        { [`POST ${attachURL}`]: [new Response(null, { status: 204 })] },
        read([computers([row({ is_attached: true })])]),
      ),
    })
    const stale = control.computer()
    await until(() => seen.some((item) => item.url === listURL))
    expect(await control.attach({ replaceOthers: true })).toEqual({ state: "attached", target })
    release()
    expect(await stale).toEqual({ state: "detached", target })
    expect(await control.computer()).toEqual({ state: "attached", target })
  })
})

const ready = { environment_id: executorID, status: "connected" }
const environment = { environmentId: "env_cloud_1", status: "offline", capabilities: [{ type: "remote_desktop", status: "ready" }] }
const withExtras = (readiness: Reply | undefined, env: Reply | undefined) => ({
  ...(readiness === undefined ? {} : { [`GET ${readinessURL}`]: [readiness] }),
  ...(env === undefined ? {} : { [`GET ${environmentURL}`]: [env] }),
})

describe("supplementary status reads", () => {
  test("reads cloud readiness, task usability and the Dot environment for the listed row with the CCA headers", async () => {
    const { control, extras, seen } = await fixture({
      routes: merge(read([computers([row({ is_attached: true, can_use_for_tasks: true })])]), withExtras(json(200, ready), json(200, environment))),
    })
    expect(await control.computer()).toEqual({
      state: "attached", target, readiness: "connected", usableForTasks: true,
      dotEnvironment: { status: "offline", capabilities: [{ type: "remote_desktop", status: "ready" }] },
    })
    expect(extras.map((item) => `${item.method} ${item.url}`).sort()).toEqual([`GET ${environmentURL}`, `GET ${readinessURL}`].sort())
    for (const item of extras) {
      expect(item.headers.authorization).toBe(`Bearer ${access}`)
      expect(item.headers["chatgpt-account-id"]).toBe(accountID)
      expect(item.body).toBeUndefined()
    }
    expect(seen.map((item) => item.url)).toEqual([`${base}/tbo?limit=25&include_room_preview=false`, `${base}/tbo/${dotID}/root-thread`, listURL])
  })

  test("reports false task usability and an unattached environment id of null", async () => {
    const { control } = await fixture({
      routes: merge(read([computers([row({ can_use_for_tasks: false })])]), withExtras(json(200, { ...ready, status: "offline" }), json(200, { environmentId: null, status: "unknown", capabilities: [] }))),
    })
    expect(await control.computer()).toEqual({ state: "detached", target, readiness: "offline", usableForTasks: false, dotEnvironment: { status: "unknown", capabilities: [] } })
  })

  test("omits readiness unless the response names this executor with a known status", async () => {
    const cases: (Reply | undefined)[] = [
      json(200, { ...ready, environment_id: "other" }), json(200, { ...ready, status: "ready" }), json(200, { status: "connected" }),
      json(200, { environment_id: executorID }), json(200, []), new Response("not json", { status: 200 }), json(500, {}), json(401, {}), new Error("reset"), undefined,
    ]
    for (const reply of cases) {
      const { control, diagnostics } = await fixture({ routes: merge(read([computers([row()])]), withExtras(reply, undefined)) })
      expect(await control.computer()).toEqual({ state: "detached", target })
      expect(diagnostics).toEqual([])
    }
  })

  test("omits task usability unless can_use_for_tasks is a boolean", async () => {
    for (const value of ["true", 1, null]) {
      const { control } = await fixture({ routes: read([computers([row({ can_use_for_tasks: value })])]) })
      expect(await control.computer()).toEqual({ state: "detached", target })
    }
  })

  test("omits the Dot environment unless it decodes strictly", async () => {
    const cases: Reply[] = [
      json(200, { ...environment, status: 1 }), json(200, { ...environment, status: "Off Line" }), json(200, { ...environment, environmentId: 7 }),
      json(200, { environmentId: null, status: "offline" }), json(200, { ...environment, capabilities: "none" }),
      json(200, { ...environment, capabilities: [{ type: "remote_desktop" }] }), json(200, { ...environment, capabilities: [{ type: "", status: "ready" }] }),
      json(200, { ...environment, capabilities: [null] }), json(200, { ...environment, capabilities: Array.from({ length: 17 }, () => ({ type: "a", status: "ready" })) }),
      json(404, {}), json(500, {}), new Error("reset"), new Response("not json", { status: 200 }),
    ]
    for (const reply of cases) {
      const { control } = await fixture({ routes: merge(read([computers([row()])]), withExtras(undefined, reply)) })
      expect(await control.computer()).toEqual({ state: "detached", target })
    }
  })

  test("does not read supplementary status for an unlisted executor or a failed list", async () => {
    for (const rows of [computers([]), json(503, {})]) {
      const { control, extras } = await fixture({ routes: merge(read([rows]), withExtras(json(200, ready), json(200, environment))) })
      expect((await control.computer()).state).toBe("unavailable")
      expect(extras).toEqual([])
    }
  })
})

describe("detach", () => {
  test("posts disconnect once without a body and returns the re-read detached state", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), { [`POST ${detachURL}`]: [new Response(null, { status: 204 })] }, read([computers([row()])])),
    })
    expect(await control.detach({})).toEqual({ state: "detached", target })
    const posts = seen.filter((item) => item.method === "POST")
    expect(posts.map((item) => item.url)).toEqual([detachURL])
    expect(posts[0].body).toBeUndefined()
    expect(posts[0].headers.authorization).toBe(`Bearer ${access}`)
    expect(posts[0].headers["chatgpt-account-id"]).toBe(accountID)
    expect(posts[0].headers.originator).toBe("Codex Desktop")
    expect(seen.map((item) => item.method)).toEqual(["GET", "GET", "GET", "POST", "GET", "GET", "GET"])
    expect(await control.computer()).toEqual({ state: "detached", target })
    expect(seen.length).toBe(7)
  })

  test("reports an attached row that cannot be disconnected without posting", async () => {
    const attached = computers([row({ is_attached: true, can_disconnect: false })])
    const status = await (await fixture({ routes: read([attached]) })).control.computer()
    expect(status).toEqual({ state: "attached", problem: "not-disconnectable", target })
    const { control, seen } = await fixture({ routes: read([computers([row({ is_attached: true, can_disconnect: false })])]) })
    expect(await control.detach({})).toEqual({ state: "attached", problem: "not-disconnectable", target })
    expect(seen.filter((item) => item.method === "POST")).toEqual([])
    const missing = await fixture({ routes: read([computers([row({ is_attached: true, can_disconnect: undefined })])]) })
    expect(await missing.control.detach({})).toEqual({ state: "attached", problem: "not-disconnectable", target })
  })

  test("does not post when the executor is already detached, unlisted or unreadable", async () => {
    const cases: { readonly rows: Reply; readonly expected: CcaComputerStatus }[] = [
      { rows: computers([row()]), expected: { state: "detached", target } },
      { rows: computers([]), expected: { state: "unavailable", problem: "not-listed" } },
      { rows: json(503, {}), expected: { state: "unavailable", problem: "connection" } },
    ]
    for (const item of cases) {
      const { control, seen } = await fixture({ routes: read([item.rows]) })
      expect(await control.detach({})).toEqual(item.expected)
      expect(seen.filter((entry) => entry.method === "POST")).toEqual([])
    }
  })

  test("never calls ChatGPT without enabled access", async () => {
    const { control, seen } = await fixture({ routes: {}, configuration: { enabled: false } })
    expect(await control.detach({})).toEqual({ state: "unavailable", problem: "configuration" })
    expect(seen).toEqual([])
  })

  test("a stale target receipt reports target-changed without posting", async () => {
    const { control, seen } = await fixture({ routes: read([computers([row({ is_attached: true })])]) })
    expect(await control.detach({ expectedTarget: { ...target, revision: "b".repeat(64) } })).toEqual({ state: "unavailable", problem: "target-changed" })
    expect(seen.filter((item) => item.method === "POST")).toEqual([])
  })

  test("accepts the exact observed target receipt", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), read([computers([row({ is_attached: true })])]), { [`POST ${detachURL}`]: [new Response(null, { status: 204 })] }, read([computers([row()])])),
    })
    const receipt = (await control.computer()).target!
    expect(await control.detach({ expectedTarget: receipt })).toEqual({ state: "detached", target })
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(1)
  })

  test("does not retry a refused detach and reports the re-read state", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), { [`POST ${detachURL}`]: [json(409, { detail: "secret detail" })] }, read([computers([row({ is_attached: true })])])),
    })
    const status = await control.detach({})
    expect(status).toEqual({ state: "attached", problem: "rejected", target })
    expect(JSON.stringify(status)).not.toContain("secret")
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(1)
  })

  test("trusts only the re-read after an uncertain or unconfirmed detach", async () => {
    for (const reply of [new Error("reset"), json(500, {}), json(408, {}), json(429, {}), new Response(null, { status: 204 })]) {
      const { control, seen } = await fixture({
        routes: merge(read([computers([row({ is_attached: true })])]), { [`POST ${detachURL}`]: [reply] }, read([computers([row({ is_attached: true })])])),
      })
      expect(await control.detach({})).toEqual({ state: "attached", problem: "unconfirmed", target })
      expect(seen.filter((item) => item.method === "POST")).toHaveLength(1)
    }
    const landed = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), { [`POST ${detachURL}`]: [new Error("reset")] }, read([computers([row()])])),
    })
    expect(await landed.control.detach({})).toEqual({ state: "detached", target })
    const unreadable = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), { [`POST ${detachURL}`]: [new Response(null, { status: 204 })] }, read([json(503, {})])),
    })
    expect(await unreadable.control.detach({})).toEqual({ state: "unavailable", problem: "unconfirmed" })
  })

  test("concurrent detaches for the same binding and target share one post", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), { [`POST ${detachURL}`]: [new Response(null, { status: 204 })] }, read([computers([row()])])),
    })
    const [first, second] = await Promise.all([control.detach({}), control.detach({})])
    expect(first).toEqual({ state: "detached", target })
    expect(second).toEqual(first)
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(1)
  })

  test("detaches with different target receipts do not share an attempt", async () => {
    const { control, seen } = await fixture({
      routes: merge(
        read([computers([row({ is_attached: true })])]), read([computers([row({ is_attached: true })])]),
        { [`POST ${detachURL}`]: [new Response(null, { status: 204 }), new Response(null, { status: 204 })] },
        read([computers([row()])]), read([computers([row()])]),
      ),
    })
    const receipt = (await (await fixture({ routes: read([computers([row({ is_attached: true })])]) })).control.computer()).target!
    const [first, second] = await Promise.all([control.detach({}), control.detach({ expectedTarget: receipt })])
    expect(first.state).toBe("detached")
    expect(second.state).toBe("detached")
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(2)
  })

  test("attach and detach never share an attempt", async () => {
    const { control, seen } = await fixture({
      routes: merge(
        read([computers([row({ is_attached: true })])]), read([computers([row({ is_attached: true })])]),
        { [`POST ${detachURL}`]: [new Response(null, { status: 204 })] },
        read([computers([row()])]),
      ),
    })
    const [attached, detached] = await Promise.all([control.attach({ replaceOthers: false }), control.detach({})])
    expect(attached).toEqual({ state: "attached", target })
    expect(detached).toEqual({ state: "detached", target })
    expect(seen.filter((item) => item.method === "POST").map((item) => item.url)).toEqual([detachURL])
  })
})

describe("remove", () => {
  const removable = (fields: Record<string, unknown> = {}) => row({ can_delete: true, ...fields })

  async function stored(path: string) {
    const parsed: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"))
    return parsed
  }

  test("deletes only this executor once and marks the enrollment removed after the row disappears", async () => {
    const { control, seen, statePath } = await fixture({
      routes: merge(read([computers([removable({ is_attached: true }), removable({ environment_id: "other", can_delete: true })])]), { [`DELETE ${removeURL}`]: [new Response(null, { status: 204 })] }, read([computers([row({ environment_id: "other" })])])),
    })
    expect(await control.remove({})).toEqual({ state: "removed" })
    const deletes = seen.filter((item) => item.method === "DELETE")
    expect(deletes.map((item) => item.url)).toEqual([removeURL])
    expect(deletes[0].body).toBeUndefined()
    expect(deletes[0].headers.authorization).toBe(`Bearer ${access}`)
    expect(deletes[0].headers["chatgpt-account-id"]).toBe(accountID)
    expect(deletes[0].headers.originator).toBe("Codex Desktop")
    expect(seen.map((item) => item.method)).toEqual(["GET", "GET", "GET", "DELETE", "GET", "GET", "GET"])
    expect(seen.some((item) => item.url.includes("/flora/cca/executor"))).toBe(false)
    const state = await stored(statePath)
    expect(state).toMatchObject({ status: "removed", installationID: completed.installationID, accountHash: completed.accountHash })
    expect(state.executorID).toBeUndefined()
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    expect(await control.computer()).toEqual({ state: "unavailable", problem: "enrollment" })
  })

  test("removes a detached deletable row", async () => {
    const { control } = await fixture({
      routes: merge(read([computers([removable()])]), { [`DELETE ${removeURL}`]: [new Response(null, { status: 204 })] }, read([computers([])])),
    })
    expect(await control.remove({})).toEqual({ state: "removed" })
  })

  test("reports a row that is not deletable without sending a request or changing the enrollment", async () => {
    for (const fields of [{ can_delete: false }, { can_delete: "true" }, { can_delete: undefined }]) {
      for (const attached of [true, false]) {
        const { control, seen, statePath } = await fixture({ routes: read([computers([row({ ...fields, is_attached: attached })])]) })
        expect(await control.remove({})).toEqual({ state: attached ? "attached" : "detached", problem: "not-deletable", target })
        expect(seen.filter((item) => item.method === "DELETE")).toEqual([])
        expect(await stored(statePath)).toMatchObject({ status: "completed", executorID })
      }
    }
  })

  test("does not delete when unlisted, unreadable, without access or for a stale target receipt", async () => {
    for (const [rows, expected] of [
      [computers([]), { state: "unavailable", problem: "not-listed" }],
      [json(503, {}), { state: "unavailable", problem: "connection" }],
    ] as const) {
      const { control, seen } = await fixture({ routes: read([rows]) })
      expect(await control.remove({})).toEqual(expected)
      expect(seen.filter((item) => item.method === "DELETE")).toEqual([])
    }
    const off = await fixture({ routes: {}, configuration: { enabled: false } })
    expect(await off.control.remove({})).toEqual({ state: "unavailable", problem: "configuration" })
    expect(off.seen).toEqual([])
    const stale = await fixture({ routes: read([computers([removable()])]) })
    expect(await stale.control.remove({ expectedTarget: { ...target, revision: "b".repeat(64) } })).toEqual({ state: "unavailable", problem: "target-changed" })
    expect(stale.seen.filter((item) => item.method === "DELETE")).toEqual([])
  })

  test("does not retry a refused removal and keeps the enrollment when the row is still listed", async () => {
    const { control, seen, statePath } = await fixture({
      routes: merge(read([computers([removable({ is_attached: true })])]), { [`DELETE ${removeURL}`]: [json(409, { detail: "secret detail" })] }, read([computers([removable({ is_attached: true })])])),
    })
    const status = await control.remove({})
    expect(status).toEqual({ state: "attached", problem: "rejected", target })
    expect(JSON.stringify(status)).not.toContain("secret")
    expect(seen.filter((item) => item.method === "DELETE")).toHaveLength(1)
    expect(await stored(statePath)).toMatchObject({ status: "completed", executorID })
  })

  test("trusts only the re-read after an uncertain or unconfirmed removal", async () => {
    for (const reply of [new Error("reset"), json(500, {}), json(408, {}), json(429, {}), new Response(null, { status: 204 })]) {
      const { control, seen, statePath } = await fixture({
        routes: merge(read([computers([removable()])]), { [`DELETE ${removeURL}`]: [reply] }, read([computers([removable()])])),
      })
      expect(await control.remove({})).toEqual({ state: "detached", problem: "unconfirmed", target })
      expect(seen.filter((item) => item.method === "DELETE")).toHaveLength(1)
      expect(await stored(statePath)).toMatchObject({ status: "completed" })
    }
    const landed = await fixture({
      routes: merge(read([computers([removable()])]), { [`DELETE ${removeURL}`]: [new Error("reset")] }, read([computers([])])),
    })
    expect(await landed.control.remove({})).toEqual({ state: "removed" })
    expect(await stored(landed.statePath)).toMatchObject({ status: "removed" })
    const unreadable = await fixture({
      routes: merge(read([computers([removable()])]), { [`DELETE ${removeURL}`]: [new Response(null, { status: 204 })] }, read([json(503, {})])),
    })
    expect(await unreadable.control.remove({})).toEqual({ state: "unavailable", problem: "unconfirmed" })
    expect(await stored(unreadable.statePath)).toMatchObject({ status: "completed" })
  })

  test("concurrent removals for the same binding and target share one delete", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([removable()])]), { [`DELETE ${removeURL}`]: [new Response(null, { status: 204 })] }, read([computers([])])),
    })
    const [first, second] = await Promise.all([control.remove({}), control.remove({})])
    expect(first).toEqual({ state: "removed" })
    expect(second).toEqual(first)
    expect(seen.filter((item) => item.method === "DELETE")).toHaveLength(1)
  })
})

const history = "https://codex-cloud-backend.chatgpt.com"
const taskThreadID = "thr_synthetic_task_0001"

function fakeDurable(options: { readonly connected?: boolean; readonly replies?: Record<string, CcaDurableReply[]>; readonly threads?: unknown[]; readonly pending?: CcaDurableServerRequest[] } = {}) {
  const requests: { readonly method: string; readonly params: any; readonly timeoutMs?: number }[] = []
  const watched: string[] = []
  const answers: unknown[][] = []
  const pending = [...(options.pending ?? [])]
  const client: CcaDurableClient = {
    connected: () => options.connected ?? true,
    request: async (method, params, timeoutMs) => {
      requests.push({ method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      if (method === "thread/list") return { kind: "result", result: { data: options.threads ?? [], nextCursor: null } }
      return options.replies?.[method]?.shift() ?? { kind: "result", result: {} }
    },
    watch: (threadID) => { watched.push(threadID) },
    pending: (threadID) => pending.filter((request) => request.threadID === threadID),
    answer: async (threadID, requestID, result) => {
      const index = pending.findIndex((request) => request.threadID === threadID && request.requestID === requestID)
      if (index < 0) return "stale"
      pending.splice(index, 1)
      answers.push([threadID, requestID, result])
      return "sent"
    },
    close: async () => {},
  }
  return { client, requests, watched, answers }
}

function conversationFixture(options: { readonly routes: Record<string, Reply[]>; readonly durable?: CcaDurableClient; readonly configuration?: NativeDots.Configuration; readonly credential?: typeof resolved }) {
  const seen: Seen[] = []
  const conversation = createCcaDotConversation({
    native: { configuration: async () => options.configuration ?? configuration, credential: async () => ("credential" in options ? options.credential : resolved) },
    durable: () => options.durable,
    fetch: async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      seen.push({ method: init?.method ?? "GET", url, headers, body: init?.body, signal: init?.signal })
      expect(init?.redirect).toBe("error")
      const next = options.routes[`${init?.method ?? "GET"} ${url}`]?.shift()
      if (next === undefined) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`)
      const reply = typeof next === "function" ? await next() : next
      if (reply instanceof Error) throw reply
      return reply
    },
  })
  return { conversation, seen }
}

const dotContext = (count = 1) => ({
  [`GET ${base}/tbo?limit=25&include_room_preview=false`]: Array.from({ length: count }, () => dots([activeDot])),
  [`GET ${base}/tbo/${dotID}/root-thread`]: Array.from({ length: count }, () => json(200, { root_thread_id: threadID })),
})
const membership = (count = 1) => merge(dotContext(count), {
  [`GET ${base}/tbo/${dotID}/threads?limit=100&include_hidden=false`]: Array.from({ length: count }, () => json(200, { items: [{ thread_id: threadID }, { thread_id: taskThreadID, extra: 1 }], cursor: null })),
})
const syntheticTask = { id: "task_1", title: "Ship release", description: null, status: "active", latest_update: "Tests green", emoji: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", extra: true }

describe("Dot conversation", () => {
  test("lists the root and attached threads with tasks and enriches them from the durable thread list", async () => {
    const durable = fakeDurable({ threads: [
      { id: threadID, name: "Daily\u0007 plan", status: { type: "active", activeFlags: ["waitingOnApproval"] }, updatedAt: 1_790_000_000.7, threadSource: "aeon" },
      { id: taskThreadID, preview: "Fix the build", status: { type: "idle" } },
    ] })
    const { conversation, seen } = conversationFixture({ durable: durable.client, routes: merge(membership(), { [`GET ${base}/tbo/${dotID}/tasks?limit=100`]: [json(200, { data: [syntheticTask], next_cursor: null })] }) })
    expect(await conversation.threads()).toEqual({ ok: true, value: {
      dotID, rootThreadID: threadID,
      threads: [
        { threadID, kind: "root", name: "Daily  plan", status: "waiting-approval", updatedAt: 1_790_000_000 },
        { threadID: taskThreadID, kind: "task", preview: "Fix the build", status: "idle" },
      ],
      tasks: [{ taskID: "task_1", title: "Ship release", status: "active", latestUpdate: "Tests green", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" }],
    } })
    expect(durable.requests).toEqual([{ method: "thread/list", params: { cursor: null, limit: 100, archived: false, useStateDbOnly: true } }])
    for (const item of seen) {
      expect(item.headers.authorization).toBe(`Bearer ${access}`)
      expect(item.headers["chatgpt-account-id"]).toBe(accountID)
      expect(item.headers.originator).toBe("Codex Desktop")
    }
  })

  test("lists threads without details when the durable connection is not ready and rejects malformed task rows", async () => {
    const offline = fakeDurable({ connected: false })
    const listed = conversationFixture({ durable: offline.client, routes: merge(membership(), { [`GET ${base}/tbo/${dotID}/tasks?limit=100`]: [json(200, { data: [], next_cursor: null })] }) })
    expect(await listed.conversation.threads()).toEqual({ ok: true, value: { dotID, rootThreadID: threadID, threads: [{ threadID, kind: "root" }, { threadID: taskThreadID, kind: "task" }], tasks: [] } })
    expect(offline.requests).toEqual([])
    const malformed = conversationFixture({ routes: merge(membership(), { [`GET ${base}/tbo/${dotID}/tasks?limit=100`]: [json(200, { data: [{ ...syntheticTask, created_at: 5 }], next_cursor: null })] }) })
    expect(await malformed.conversation.threads()).toEqual({ ok: false, problem: "malformed" })
  })

  test("reads one page of task updates for the task", async () => {
    const { conversation, seen } = conversationFixture({ routes: merge(dotContext(2), {
      [`GET ${base}/tbo/${dotID}/tasks/task_1/updates?cursor=c1&limit=10`]: [json(200, { data: [{ id: "u1", task_id: "task_1", text: "Started", created_at: "2026-11-01T00:00:00Z" }], next_cursor: "c2" })],
      [`GET ${base}/tbo/${dotID}/tasks/task_1/updates?limit=50`]: [json(200, { data: [{ id: "u1", task_id: "task_other", text: "x", created_at: "2026-11-01T00:00:00Z" }], next_cursor: null })],
    }) })
    expect(await conversation.taskUpdates("task_1", { cursor: "c1", limit: 10 })).toEqual({ ok: true, value: { taskID: "task_1", updates: [{ updateID: "u1", text: "Started", createdAt: "2026-11-01T00:00:00Z" }], nextCursor: "c2" } })
    expect(await conversation.taskUpdates("task_1", {})).toEqual({ ok: false, problem: "malformed" })
    expect(seen.filter((item) => item.url.includes("/updates"))).toHaveLength(2)
  })

  test("reads a Dot thread transcript from the durable history over HTTP and subscribes to the thread", async () => {
    const durable = fakeDurable()
    const turns = [
      { id: "turn-2", status: "inProgress", items: [{ type: "agentMessage", id: "i4", text: "x".repeat(70_000), phase: "final" }] },
      { id: "turn-1", status: "completed", unknown: true, items: [
        { type: "userMessage", id: "i1", content: [{ type: "text", text: "Run tests", text_elements: [] }, { type: "image", url: "https://synthetic.invalid/a.png" }] },
        { type: "commandExecution", id: "i2", command: "bun test", exitCode: 1, aggregatedOutput: "synthetic" },
        { type: "fileChange", id: "i3", changes: [{ path: "src/a.ts", kind: "update", diff: "synthetic" }] },
        { type: "reasoning", id: "i5", summary: ["hidden"] },
      ] },
    ]
    const { conversation, seen } = conversationFixture({ durable: durable.client, routes: merge(membership(), {
      [`GET ${history}/v1/threads/${taskThreadID}`]: [json(200, { thread: { id: taskThreadID, name: "Fix build", threadSource: "aeon_child" } })],
      [`GET ${history}/v2/threads/${taskThreadID}/turns?limit=20&sortDirection=desc&itemsView=full`]: [json(200, { data: turns, nextCursor: "older", backwardsCursor: null })],
    }) })
    const result = await conversation.read(taskThreadID, {})
    expect(result).toEqual({ ok: true, value: {
      thread: { threadID: taskThreadID, kind: "task", name: "Fix build" },
      nextCursor: "older",
      turns: [
        { turnID: "turn-1", status: "completed", items: [
          { type: "userMessage", itemID: "i1", text: "Run tests" },
          { type: "commandExecution", itemID: "i2", command: "bun test", exitCode: 1 },
          { type: "fileChange", itemID: "i3", paths: ["src/a.ts"] },
          { type: "other", itemID: "i5", itemType: "reasoning" },
        ] },
        { turnID: "turn-2", status: "inProgress", items: [{ type: "agentMessage", itemID: "i4", text: "x".repeat(65_536), truncated: true }] },
      ],
    } })
    const reads = seen.filter((item) => item.url.startsWith(history))
    expect(reads).toHaveLength(2)
    for (const item of reads) {
      expect(item.headers.authorization).toBe(`Bearer ${access}`)
      expect(item.headers["x-openai-product-sku"]).toBe("codex")
      expect(item.headers["chatgpt-account-id"]).toBe(accountID)
    }
    expect(durable.watched).toEqual([taskThreadID])
  })

  test("refuses threads outside the Dot and malformed history rows without guessing", async () => {
    const outside = conversationFixture({ routes: membership() })
    expect(await outside.conversation.read("thr_not_in_dot", {})).toEqual({ ok: false, problem: "thread-unavailable" })
    expect(outside.seen.some((item) => item.url.startsWith(history))).toBe(false)
    for (const bad of [{ type: "agentMessage", id: "i1" }, { type: "commandExecution", id: "i2", command: "x", exitCode: "0" }, { type: "fileChange", id: "i3", changes: [{}] }, { type: "agent message", id: "i4" }, { type: "userMessage", content: [] }]) {
      const malformed = conversationFixture({ routes: merge(membership(), {
        [`GET ${history}/v1/threads/${taskThreadID}`]: [json(200, { thread: { id: taskThreadID } })],
        [`GET ${history}/v2/threads/${taskThreadID}/turns?limit=20&sortDirection=desc&itemsView=full`]: [json(200, { data: [{ id: "turn-1", items: [bad] }], nextCursor: null })],
      }) })
      expect(await malformed.conversation.read(taskThreadID, {})).toEqual({ ok: false, problem: "malformed" })
    }
    const wrong = conversationFixture({ routes: merge(membership(), {
      [`GET ${history}/v1/threads/${taskThreadID}`]: [json(200, { thread: { id: "thr_other" } })],
      [`GET ${history}/v2/threads/${taskThreadID}/turns?limit=20&sortDirection=desc&itemsView=full`]: [json(200, { data: [], nextCursor: null })],
    }) })
    expect(await wrong.conversation.read(taskThreadID, {})).toEqual({ ok: false, problem: "malformed" })
  })

  test("sends one turn/addUserMessage with a fresh message group and maps the admission outcome", async () => {
    const durable = fakeDurable({ replies: { "turn/addUserMessage": [
      { kind: "result", result: { turn: { id: "turn-9" }, admissionOutcome: "started", clientUserMessageId: "client-1" } },
      { kind: "result", result: { turn: { id: "turn-9" }, admissionOutcome: "steered" } },
      { kind: "result", result: { turn: { id: "turn-9" }, admissionOutcome: "duplicate" } },
      { kind: "result", result: { turn: { id: "turn-10" }, admissionOutcome: "queued" } },
    ] } })
    const { conversation } = conversationFixture({ durable: durable.client, routes: membership(4) })
    expect(await conversation.send(taskThreadID, { text: "Run tests", clientMessageID: "client-1", mode: "send" })).toEqual({ ok: true, value: { admission: "started", turnID: "turn-9" } })
    expect(await conversation.send(taskThreadID, { text: "Also lint", clientMessageID: "client-2", mode: "send" })).toEqual({ ok: true, value: { admission: "steered", turnID: "turn-9" } })
    expect(await conversation.send(taskThreadID, { text: "Also lint", clientMessageID: "client-2", mode: "send" })).toEqual({ ok: true, value: { admission: "duplicate", turnID: "turn-9" } })
    expect(await conversation.send(taskThreadID, { text: "Then summarize", clientMessageID: "client-3", mode: "queue" })).toEqual({ ok: true, value: { admission: "unknown", turnID: "turn-10" } })
    const sends = durable.requests.filter((request) => request.method === "turn/addUserMessage")
    expect(sends.map((request) => request.timeoutMs)).toEqual([120_000, 120_000, 120_000, 120_000])
    expect(sends[0].params).toEqual({
      threadId: taskThreadID, input: [{ type: "text", text: "Run tests", text_elements: [] }], clientUserMessageId: "client-1", messageThreadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(sends[3].params).toMatchObject({ clientUserMessageId: "client-3", mode: "queue" })
    expect(new Set(sends.map((request) => request.params.messageThreadId)).size).toBe(4)
    expect(durable.watched).toEqual([taskThreadID, taskThreadID, taskThreadID, taskThreadID])
  })

  test("a send whose outcome is unknown is reported once and never replayed; refusals are typed and concurrent duplicates share one request", async () => {
    let release: (reply: CcaDurableReply) => void = () => {}
    const durable = fakeDurable({ replies: { "turn/addUserMessage": [{ kind: "unknown" }, { kind: "not-sent" }, { kind: "error", code: -32600, message: "synthetic private refusal" }] } })
    const { conversation } = conversationFixture({ durable: durable.client, routes: membership(3) })
    const message = { text: "Run tests", clientMessageID: "client-1", mode: "send" as const }
    expect(await conversation.send(taskThreadID, message)).toEqual({ ok: true, value: { admission: "unknown" } })
    expect(await conversation.send(taskThreadID, { ...message, clientMessageID: "client-2" })).toEqual({ ok: false, problem: "durable-unavailable" })
    expect(await conversation.send(taskThreadID, { ...message, clientMessageID: "client-3" })).toEqual({ ok: false, problem: "rejected" })
    expect(durable.requests.filter((request) => request.method === "turn/addUserMessage")).toHaveLength(3)
    const offline = fakeDurable({ connected: false })
    const disconnected = conversationFixture({ durable: offline.client, routes: membership() })
    expect(await disconnected.conversation.send(taskThreadID, message)).toEqual({ ok: false, problem: "durable-unavailable" })
    expect(offline.requests).toEqual([])
    const outside = fakeDurable()
    expect(await conversationFixture({ durable: outside.client, routes: membership() }).conversation.send("thr_not_in_dot", message)).toEqual({ ok: false, problem: "thread-unavailable" })
    expect(outside.requests).toEqual([])
    const slow = fakeDurable()
    const held = { ...slow.client, request: (method: string, params: unknown, timeoutMs?: number) => {
      slow.requests.push({ method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      return new Promise<CcaDurableReply>((resolve) => { release = resolve })
    } }
    const shared = conversationFixture({ durable: held, routes: membership(2) }).conversation
    const first = shared.send(taskThreadID, message)
    const second = shared.send(taskThreadID, message)
    while (!slow.requests.length) await new Promise((resolve) => setTimeout(resolve, 1))
    release({ kind: "result", result: { turn: { id: "turn-1" }, admissionOutcome: "started" } })
    expect(await first).toEqual(await second)
    expect(slow.requests).toHaveLength(1)
  })

  test("interrupt treats a missing active turn as interrupted and other refusals as rejected", async () => {
    const durable = fakeDurable({ replies: { "turn/interrupt": [
      { kind: "result", result: {} }, { kind: "error", code: -32600, message: "no active turn to interrupt" }, { kind: "error", code: -32600, message: "thread access denied" }, { kind: "unknown" },
    ] } })
    const { conversation } = conversationFixture({ durable: durable.client, routes: membership(4) })
    expect(await conversation.interrupt(taskThreadID, { turnID: "turn-1" })).toEqual({ ok: true, value: { outcome: "interrupted" } })
    expect(await conversation.interrupt(taskThreadID, { turnID: "turn-1" })).toEqual({ ok: true, value: { outcome: "interrupted" } })
    expect(await conversation.interrupt(taskThreadID, { turnID: "turn-1" })).toEqual({ ok: false, problem: "rejected" })
    expect(await conversation.interrupt(taskThreadID, { turnID: "turn-1" })).toEqual({ ok: true, value: { outcome: "unknown" } })
    expect(durable.requests.map((request) => request.params)).toEqual(Array.from({ length: 4 }, () => ({ threadId: taskThreadID, turnId: "turn-1" })))
  })

  test("resume posts once without a body and reports resumed, unconfirmed, unknown and refused outcomes", async () => {
    const resumeURL = `POST ${base}/tbo/${dotID}/runtime/resume`
    const { conversation, seen } = conversationFixture({ routes: merge(dotContext(5), { [resumeURL]: [
      json(200, { thread_id: threadID, status: "resumed" }), json(200, { thread_id: "thr_new_root", status: "unconfirmed" }), json(503, {}), new Error("synthetic network"), json(400, { detail: "synthetic private" }),
    ] }) })
    expect(await conversation.resume()).toEqual({ ok: true, value: { outcome: "resumed", threadID, rootChanged: false } })
    expect(await conversation.resume()).toEqual({ ok: true, value: { outcome: "unconfirmed", threadID: "thr_new_root", rootChanged: true } })
    expect(await conversation.resume()).toEqual({ ok: true, value: { outcome: "unknown" } })
    expect(await conversation.resume()).toEqual({ ok: true, value: { outcome: "unknown" } })
    expect(await conversation.resume()).toEqual({ ok: false, problem: "rejected" })
    const posts = seen.filter((item) => item.method === "POST")
    expect(posts).toHaveLength(5)
    for (const post of posts) {
      expect(post.body).toBeUndefined()
      expect(post.headers["chatgpt-account-id"]).toBe(accountID)
    }
  })

  test("lists pending durable requests for a Dot thread and answers each exactly once with the observed shapes", async () => {
    const request = (requestID: string, method: CcaDurableServerRequest["method"], params: Record<string, unknown>): CcaDurableServerRequest =>
      ({ requestID, rawID: requestID, method, threadID: taskThreadID, params: { threadId: taskThreadID, turnId: "turn-1", ...params } })
    const durable = fakeDurable({ pending: [
      request("req-cmd", "item/commandExecution/requestApproval", { command: "rm -rf build", cwd: "/work", reason: "Clean", itemId: "i" }),
      request("req-input", "item/tool/requestUserInput", { questions: [{ id: "q1", header: "Deploy", question: "Ship it?", options: [{ label: "Yes", description: "Deploy now" }, { label: "No" }] }] }),
      request("req-perm", "item/permissions/requestApproval", { reason: "Network" }),
      request("req-file", "item/fileChange/requestApproval", {}),
    ] })
    const { conversation } = conversationFixture({ durable: durable.client, routes: membership() })
    expect(await conversation.requests(taskThreadID)).toEqual({ ok: true, value: { threadID: taskThreadID, requests: [
      { requestID: "req-cmd", threadID: taskThreadID, turnID: "turn-1", kind: "command-approval", reason: "Clean", command: "rm -rf build", cwd: "/work" },
      { requestID: "req-input", threadID: taskThreadID, turnID: "turn-1", kind: "user-input", questions: [{ questionID: "q1", header: "Deploy", question: "Ship it?", options: [{ label: "Yes", description: "Deploy now" }, { label: "No" }] }] },
      { requestID: "req-perm", threadID: taskThreadID, turnID: "turn-1", kind: "permissions-approval", reason: "Network" },
      { requestID: "req-file", threadID: taskThreadID, turnID: "turn-1", kind: "file-change-approval" },
    ] } })
    expect(durable.watched).toEqual([taskThreadID])
    expect(await conversation.respond(taskThreadID, "req-cmd", { answers: { q1: ["Yes"] } })).toEqual({ ok: false, problem: "invalid-answer" })
    expect(await conversation.respond(taskThreadID, "req-cmd", { decision: "acceptForSession" })).toEqual({ ok: true, value: { outcome: "sent" } })
    expect(await conversation.respond(taskThreadID, "req-cmd", { decision: "accept" })).toEqual({ ok: false, problem: "stale" })
    expect(await conversation.respond(taskThreadID, "req-input", { decision: "accept" })).toEqual({ ok: false, problem: "invalid-answer" })
    expect(await conversation.respond(taskThreadID, "req-input", { answers: { q2: ["Yes"] } })).toEqual({ ok: false, problem: "invalid-answer" })
    expect(await conversation.respond(taskThreadID, "req-input", { answers: { q1: ["Yes"] } })).toEqual({ ok: true, value: { outcome: "sent" } })
    expect(await conversation.respond(taskThreadID, "req-perm", { decision: "accept" })).toEqual({ ok: false, problem: "unsupported" })
    expect(await conversation.respond(taskThreadID, "req-file", { decision: "cancel" })).toEqual({ ok: true, value: { outcome: "sent" } })
    expect(durable.answers).toEqual([
      [taskThreadID, "req-cmd", { decision: "acceptForSession" }],
      [taskThreadID, "req-input", { answers: { q1: { answers: ["Yes"] } } }],
      [taskThreadID, "req-file", { decision: "cancel" }],
    ])
    expect(await conversationFixture({ routes: {} }).conversation.respond(taskThreadID, "req-cmd", { decision: "accept" })).toEqual({ ok: false, problem: "stale" })
  })

  test("never calls ChatGPT without enabled access and a pinned credential for the configured account", async () => {
    const off = conversationFixture({ routes: {}, configuration: { enabled: false } })
    expect(await off.conversation.threads()).toEqual({ ok: false, problem: "configuration" })
    const other = conversationFixture({ routes: {}, credential: { ...resolved, accountID: "synthetic-other-account" } })
    expect(await other.conversation.resume()).toEqual({ ok: false, problem: "authentication" })
    expect([...off.seen, ...other.seen]).toEqual([])
    const denied = conversationFixture({ routes: { [`GET ${base}/tbo?limit=25&include_room_preview=false`]: [json(401, {})] } })
    expect(await denied.conversation.threads()).toEqual({ ok: false, problem: "authentication" })
  })
})
