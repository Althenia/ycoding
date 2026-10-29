import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { ccaComputerCacheMs, ccaComputerProblems, createCcaComputerControl, type CcaComputerProblem, type CcaComputerStatus } from "../src/remote-control/cca-computer"

const base = "https://chatgpt.com/backend-api"
const access = "synthetic-access-token-computer-0001"
const accountID = "synthetic-account-computer-0001"
const executorID = "ccarenv_b64_synthetic/executor+0001"
const dotID = "tbo_synthetic_dot_0001"
const threadID = "thr_synthetic_root_0001"
const listURL = `${base}/tbo/${dotID}/computers?expected_thread_id=${threadID}`
const attachURL = `${base}/tbo/${dotID}/computers/${encodeURIComponent(executorID)}/connect-and-replace?expected_thread_id=${threadID}`

const configuration: NativeDots.Configuration = {
  enabled: true, accessRevision: 1, profile: "dots", credentialID: "credential-1", accountID, accountGeneration: 1,
}
const resolved = { access, accountID, key: "key", profile: "dots", credentialID: "credential-1", accountGeneration: 1 }
const completed = {
  installationID: "synthetic-installation", accountHash: createHash("sha256").update(accountID).digest("hex"), status: "completed",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", executorID,
}

type Reply = Response | Error | (() => Response | Error | Promise<Response | Error>)
type Seen = { readonly method: string; readonly url: string; readonly headers: Record<string, string>; readonly body: unknown }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const row = (fields: Record<string, unknown> = {}) => ({
  kind: "user", environment_id: executorID, status: "online", is_attached: false, can_connect: true, can_use_for_tasks: false, ...fields,
})
const computers = (rows: unknown[], fields: Record<string, unknown> = {}) =>
  json(200, { thread_id: threadID, computers: rows, local_computer_access_disabled_by_admin: false, ...fields })
const dots = (items: unknown[], cursor: string | null = null) => json(200, { items, cursor })
const activeDot = { id: dotID, status: "active" }

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function fixture(options: {
  readonly routes: Record<string, Reply[]>
  readonly stored?: unknown
  readonly configuration?: NativeDots.Configuration
  readonly credential?: typeof resolved | undefined
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-cca-computer-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, "cca-executor.json")
  const stored = "stored" in options ? options.stored : completed
  if (stored !== undefined) await writeFile(statePath, typeof stored === "string" ? stored : JSON.stringify(stored), { mode: 0o600 })
  const seen: Seen[] = []
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
    fetch: async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      seen.push({ method: init?.method ?? "GET", url, headers, body: init?.body })
      expect(init?.redirect).toBe("error")
      const queue = options.routes[`${init?.method ?? "GET"} ${url}`]
      const next = queue?.shift()
      if (next === undefined) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`)
      const reply = typeof next === "function" ? await next() : next
      if (reply instanceof Error) throw reply
      return reply
    },
  })
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    while (!(await predicate())) await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return {
    control, seen, until, diagnostics, statePath,
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
    expect(await control.computer()).toEqual({ state: "attached" })
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
    expect(await control.computer()).toEqual({ state: "detached" })
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
    expect(await control.computer()).toEqual({ state: "attached" })
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
    expect(await control.computer()).toEqual({ state: "attached" })
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
      .toEqual({ state: "detached", problem: "admin-disabled" })
    expect(await (await fixture({ routes: read([computers([row({ can_connect: false })])]) })).control.computer())
      .toEqual({ state: "detached", problem: "not-connectable" })
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
    expect(first).toEqual({ state: "detached" })
    expect(concurrent).toEqual({ state: "detached" })
    advance(ccaComputerCacheMs - 1)
    expect(await control.computer()).toEqual({ state: "detached" })
    expect(seen.length).toBe(3)
  })

  test("a stale cache answers immediately and starts one background refresh shared by concurrent reads", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { control, seen, advance, until } = await fixture({
      routes: merge(read([computers([row()])]), read([async () => { await gate; return computers([row({ is_attached: true })]) }])),
    })
    expect(await control.computer()).toEqual({ state: "detached" })
    advance(ccaComputerCacheMs)
    expect(await control.computer()).toEqual({ state: "detached" })
    expect(await control.computer()).toEqual({ state: "detached" })
    await until(() => seen.length === 6)
    expect(await control.computer()).toEqual({ state: "detached" })
    release()
    await until(async () => (await control.computer()).state === "attached")
    expect(seen.length).toBe(6)
  })

  test("a failed refresh keeps the last value, reports a fixed reason and waits a full window before retrying", async () => {
    const { control, seen, advance, until, diagnostics } = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), read([json(502, { detail: "secret detail" })]), read([computers([row()])])),
    })
    expect(await control.computer()).toEqual({ state: "attached" })
    advance(ccaComputerCacheMs)
    expect(await control.computer()).toEqual({ state: "attached" })
    await until(() => diagnostics.length === 1)
    expect(diagnostics).toEqual(["CCA computer refresh-failed problem=connection"])
    expect(await control.computer()).toEqual({ state: "attached" })
    expect(seen.length).toBe(6)
    advance(ccaComputerCacheMs)
    expect(await control.computer()).toEqual({ state: "attached" })
    await until(async () => (await control.computer()).state === "detached")
    expect(seen.length).toBe(9)
  })

  test("a configuration or executor change drops the old cache and awaits a fresh read", async () => {
    const other = "ccarenv_b64_synthetic-other-executor"
    const { control, seen, reconfigure, statePath } = await fixture({
      routes: merge(read([computers([row({ is_attached: true })])]), read([computers([row()])]), read([computers([row(), row({ environment_id: other, is_attached: true })])])),
    })
    expect(await control.computer()).toEqual({ state: "attached" })
    reconfigure({ ...configuration, accessRevision: 2 })
    expect(await control.computer()).toEqual({ state: "detached" })
    expect(seen.length).toBe(6)
    await writeFile(statePath, JSON.stringify({ ...completed, executorID: other }), { mode: 0o600 })
    expect(await control.computer()).toEqual({ state: "attached" })
    expect(seen.length).toBe(9)
  })

  test("exposes only the closed problem set", () => {
    expect([...ccaComputerProblems]).toEqual([
      "configuration", "authentication", "enrollment", "dot-unavailable", "not-listed",
      "admin-disabled", "not-connectable", "rejected", "unconfirmed", "connection",
    ])
  })
})

describe("attach", () => {
  test("posts connect-and-replace once without a body and returns the re-read state", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [new Response(null, { status: 204 })] }, read([computers([row({ is_attached: true })])])),
    })
    expect(await control.attach()).toEqual({ state: "attached" })
    const posts = seen.filter((item) => item.method === "POST")
    expect(posts.map((item) => item.url)).toEqual([attachURL])
    expect(posts[0]!.body).toBeUndefined()
    expect(posts[0]!.headers.authorization).toBe(`Bearer ${access}`)
    expect(posts[0]!.headers.originator).toBe("Codex Desktop")
    expect(seen.map((item) => item.method)).toEqual(["GET", "GET", "GET", "POST", "GET", "GET", "GET"])
    expect(await control.computer()).toEqual({ state: "attached" })
    expect(seen.length).toBe(7)
  })

  test("reads fresh state before posting even when a cached read exists", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row()])]), read([computers([row({ is_attached: true })])])),
    })
    expect(await control.computer()).toEqual({ state: "detached" })
    expect(await control.attach()).toEqual({ state: "attached" })
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
      expect(await control.attach()).toEqual(item.expected)
      expect(seen.filter((entry) => entry.method === "POST")).toEqual([])
    }
  })

  test("never posts without enabled access", async () => {
    const { control, seen } = await fixture({ routes: {}, configuration: { enabled: false } })
    expect(await control.attach()).toEqual({ state: "unavailable", problem: "configuration" })
    expect(seen).toEqual([])
  })

  test("does not retry a refused attach and reports the re-read state", async () => {
    const { control, seen } = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [json(409, { detail: "secret detail" })] }, read([computers([row()])])),
    })
    const status = await control.attach()
    expect(status).toEqual({ state: "detached", problem: "rejected" })
    expect(JSON.stringify(status)).not.toContain("secret")
    expect(seen.filter((item) => item.method === "POST").length).toBe(1)
  })

  test("trusts only the re-read after an uncertain or unconfirmed attach", async () => {
    const network = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [new Error("reset")] }, read([computers([row({ is_attached: true })])])),
    })
    expect(await network.control.attach()).toEqual({ state: "attached" })
    expect(network.seen.filter((item) => item.method === "POST").length).toBe(1)

    const server = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [json(502, {})] }, read([computers([row()])])),
    })
    expect(await server.control.attach()).toEqual({ state: "detached", problem: "unconfirmed" })
    expect(server.seen.filter((item) => item.method === "POST").length).toBe(1)

    const accepted = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [new Response(null, { status: 204 })] }, read([computers([row()])])),
    })
    expect(await accepted.control.attach()).toEqual({ state: "detached", problem: "unconfirmed" })

    const unreadable = await fixture({
      routes: merge(read([computers([row()])]), { [`POST ${attachURL}`]: [new Response(null, { status: 204 })] }, read([json(500, {})])),
    })
    expect(await unreadable.control.attach()).toEqual({ state: "unavailable", problem: "connection" })
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
    const first = control.attach()
    await until(() => seen.some((item) => item.method === "POST"))
    const second = control.attach()
    release()
    expect(await Promise.all([first, second])).toEqual([{ state: "attached" }, { state: "attached" }])
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
    expect(await control.attach()).toEqual({ state: "attached" })
    release()
    expect(await stale).toEqual({ state: "detached" })
    expect(await control.computer()).toEqual({ state: "attached" })
  })
})
