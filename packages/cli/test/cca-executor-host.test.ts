import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import {
  ccaExecutorHostDiagnostics,
  ccaReconnectDelay,
  ccaReconnectInitialMs,
  ccaReconnectMaxMs,
  ccaStableConnectionMs,
  createCcaExecutorHost,
  type CcaExecutorHostDeps,
} from "../src/remote-control/cca-executor-host"
import { ccaExecutorCapabilityRoots, ccaExecutorRegistrationURL } from "../src/remote-control/cca-executor-registration"
import { ccaExecServerUserAgent } from "../src/remote-control/cca-executor-transport"
import { defaultDotsLabel } from "../src/remote-control/label"
import { unexpectedExecutorHost } from "./fixture/cca-scope"

const access = "synthetic-access-token-host-0001"
const accountID = "synthetic-account-host-0001"
const executorID = "ccarenv_b64_synthetic-executor-host-0001"
const registrationID = "synthetic-registration-host-0001"
const signedURL = "wss://rendezvous.chatgpt.com/cloud-agent/ws?sig=synthetic-signed-host-0001"
const installationID = "synthetic-installation-host-0001"
const registerURL = `https://codex-cloud-environments.chatgpt.com/api/cloud/environment/${encodeURIComponent(executorID)}/register`
const accountDigest = createHash("sha256").update(accountID).digest("hex")

function enabled(accessRevision = 1): NativeDots.Configuration {
  return { enabled: true, accessRevision, profile: "dots", credentialID: "credential-1", accountID, accountGeneration: 1 }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

class FakeSocket extends EventEmitter {
  readyState = 1
  constructor(readonly url: string, readonly headers: Record<string, string>, private readonly onClosed: () => void, onServed: () => void, rejectStatus?: number) {
    super()
    this.on("newListener", (event) => { if (event === "message") queueMicrotask(onServed) })
    if (rejectStatus === undefined) return
    this.readyState = 0
    setTimeout(() => this.emit("unexpected-response", {}, { statusCode: rejectStatus }), 0)
  }
  send() {}
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => {
      this.onClosed()
      this.emit("close")
    })
  }
  drop() {
    this.close()
  }
}

type Recorded = { readonly url: string; readonly headers: Record<string, string>; readonly body: any }

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function fixture(options: {
  readonly configuration?: NativeDots.Configuration
  readonly stored?: unknown
  readonly flora?: readonly Response[]
  readonly register?: readonly (number | { readonly status: number; readonly code: string })[]
  readonly dial?: readonly number[]
  readonly hostname?: string
  readonly credential?: (configuration: NativeDots.Configuration, rejected?: string) => Awaited<ReturnType<NativeDots.Host["credential"]>>
  readonly realWait?: boolean
  readonly storedRoots?: "current" | "absent" | readonly unknown[]
  readonly name?: string
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-cca-host-"))
  const statePath = path.join(directory, "cca-executor.json")
  const roots = ccaExecutorCapabilityRoots(directory, directory)
  if (options.stored !== undefined) {
    const stored = typeof options.stored === "object" && options.stored !== null && options.storedRoots !== "absent"
      ? { ...options.stored, selectedCapabilityRoots: options.storedRoots === undefined || options.storedRoots === "current" ? roots : options.storedRoots }
      : options.stored
    await writeFile(statePath, typeof stored === "string" ? stored : JSON.stringify(stored), { mode: 0o600 })
  }
  let configuration = options.configuration ?? { enabled: false }
  const name = options.name
  const listeners = new Set<() => void>()
  const events: string[] = []
  const waiters: { readonly event: string; readonly count: number; readonly resolve: () => void }[] = []
  const record = (event: string) => {
    events.push(event)
    for (const waiter of [...waiters]) {
      if (events.filter((item) => item === waiter.event).length < waiter.count) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }
  const until = (event: string, count = 1) =>
    events.filter((item) => item === event).length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => { waiters.push({ event, count, resolve }) })
  const flora: Recorded[] = []
  const registrations: Recorded[] = []
  const floraResponses = [...(options.flora ?? [])]
  const registerStatuses = [...(options.register ?? [])]
  const dialStatuses = [...(options.dial ?? [])]
  const sockets: FakeSocket[] = []
  const opened: string[] = []
  const waits: number[] = []
  const diagnostics: string[] = []
  let clock = 0
  const fetchFn = async (url: string, init?: RequestInit) => {
    const entry = { url, headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) }
    if (url === ccaExecutorRegistrationURL) {
      flora.push(entry)
      record("flora")
      return floraResponses.shift() ?? json(200, { executor_id: executorID, custom_display_name: null })
    }
    if (url === registerURL) {
      registrations.push(entry)
      record("register")
      const next = registerStatuses.shift() ?? 200
      if (typeof next === "object") return json(next.status, { error: { code: next.code } })
      if (next !== 200) return json(next, { error: "synthetic" })
      return json(200, { environment_id: executorID, security_profile: "noise_hybrid_ik_v1", executor_registration_id: registrationID, url: signedURL })
    }
    throw new Error("Unexpected request")
  }
  const native: CcaExecutorHostDeps["native"] = {
    configuration: async () => configuration,
    credential: async (profile, rejected) => {
      if (options.credential) return options.credential(configuration, rejected)
      return configuration.enabled && profile === configuration.profile
        ? { access, accountID, key: "credential-key-1", profile, credentialID: "credential-1", accountGeneration: 1 }
        : undefined
    },
    subscribeConfiguration: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    name: async () => name,
    ...unexpectedExecutorHost,
  }
  const deps: CcaExecutorHostDeps = {
    native,
    statePath,
    installationID: async () => installationID,
    homeDirectory: directory,
    dataDirectory: directory,
    hostname: () => options.hostname ?? "synthetic-host",
    fetch: fetchFn,
    connectWebSocket: (url, headers) => {
      opened.push(url)
      const status = dialStatuses.shift()
      const socket = new FakeSocket(url, headers, () => record("socket-closed"), () => record("served"), status === undefined || status === 101 ? undefined : status)
      sockets.push(socket)
      record("socket")
      return socket
    },
    now: () => clock,
    random: () => 0,
    onDiagnostic: (message) => {
      diagnostics.push(message)
      record(message)
    },
    ...(options.realWait ? {} : {
      wait: async (ms: number) => {
        waits.push(ms)
        record("wait")
      },
    }),
  }
  const create = () => {
    const host = createCcaExecutorHost(deps)
    cleanups.push(() => host.stop())
    return host
  }
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return {
    statePath, events, until, flora, registrations, sockets, opened, waits, diagnostics, listeners, create, roots,
    set: (next: NativeDots.Configuration) => {
      configuration = next
      for (const listener of [...listeners]) listener()
    },
    advance: (ms: number) => { clock += ms },
  }
}

const completed = (overrides: Record<string, unknown> = {}) => ({
  installationID: "synthetic-proof-installation",
  accountHash: accountDigest,
  status: "completed",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  executorID,
  ...overrides,
})

describe("CCA executor reconnect delay (remote/reconnect_backoff.rs)", () => {
  test("waits a jittered delay between half and all of the current backoff", () => {
    expect([1_000, 2_000, 30_000].map((backoff) => ccaReconnectDelay(backoff, () => 0))).toEqual([500, 1_000, 15_000])
    expect([1_000, 2_000, 30_000].map((backoff) => ccaReconnectDelay(backoff, () => 0.99999999))).toEqual([1_000, 2_000, 30_000])
    expect([ccaReconnectInitialMs, ccaReconnectMaxMs, ccaStableConnectionMs]).toEqual([1_000, 30_000, 120_000])
  })
})

describe("CCA executor host lifecycle", () => {
  test("host start fails before subscribing or advertising when skill installation fails", async () => {
    const harness = await fixture({ configuration: enabled() })
    await mkdir(path.join(path.dirname(harness.statePath), "dots", "skills", "ycoding-operator", "SKILL.md"), { recursive: true })
    await expect(harness.create().start()).rejects.toThrow()
    expect(harness.listeners.size).toBe(0)
    expect(harness.flora).toEqual([])
  })

  test("host start installs the operator skill before advertising its root", async () => {
    const harness = await fixture({ configuration: enabled() })
    const file = path.join(path.dirname(harness.statePath), "dots", "skills", "ycoding-operator", "SKILL.md")
    const host = harness.create()
    await host.start()
    await harness.until("socket")
    const { ycodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
    expect(await readFile(file, "utf8")).toBe(ycodingOperatorSkill)
    expect(harness.flora[0]!.body.selected_capability_roots).toEqual(harness.roots)
    expect(harness.roots[1]).toEqual({ id: "ycoding-dots-skills", path: path.join(path.dirname(harness.statePath), "dots", "skills") })
  })

  test("stays idle while access is off and stops serving when access turns off", async () => {
    const harness = await fixture({ stored: completed() })
    const host = harness.create()
    await host.start()
    expect(harness.flora).toEqual([])
    expect(harness.registrations).toEqual([])
    expect(harness.sockets).toEqual([])

    harness.set(enabled())
    await harness.until("socket")
    expect(harness.registrations).toHaveLength(1)
    expect(harness.registrations[0]!.headers).toMatchObject({ authorization: `Bearer ${access}`, "chatgpt-account-id": accountID, originator: "codex_cli_rs", "User-Agent": ccaExecServerUserAgent() })
    expect(harness.registrations[0]!.body).toMatchObject({ security_profile: "noise_hybrid_ik_v1" })
    expect(Object.keys(harness.sockets[0]!.headers)).toEqual(["x-request-id"])

    harness.set({ enabled: false })
    await harness.until("socket-closed")
    await host.stop()
    expect(harness.registrations).toHaveLength(1)
    expect(harness.sockets).toHaveLength(1)
    expect(harness.listeners.size).toBe(0)
  })

  test.each([
    { name: "credential missing", credential: () => undefined },
    { name: "credential generation changed", credential: () => ({ access, accountID, key: "credential-key-1", profile: "dots", credentialID: "credential-1", accountGeneration: 2 }) },
  ])("does not connect when the pinned credential is unavailable: $name", async ({ credential }) => {
    const harness = await fixture({ stored: completed(), configuration: enabled(), credential })
    const host = harness.create()
    await host.start()
    await harness.until("CCA executor credential-unavailable")
    await host.stop()
    expect(harness.registrations).toEqual([])
    expect(harness.waits).toEqual([])
  })

  test("reuses a stored completed enrollment from another installation without a Flora request", async () => {
    const harness = await fixture({ stored: completed(), configuration: enabled() })
    await harness.create().start()
    await harness.until("socket")
    expect(harness.flora).toEqual([])
    expect(harness.registrations[0]!.url).toBe(registerURL)
    const sent = JSON.stringify([harness.registrations[0], harness.sockets[0]!.url, harness.sockets[0]!.headers])
    for (const installation of ["synthetic-proof-installation", installationID]) expect(sent).not.toContain(installation)
  })

  test("enrolls once with a bounded distinguishable default label and persists the enrollment for later hosts", async () => {
    const harness = await fixture({ configuration: enabled(), hostname: "h".repeat(150) })
    const first = harness.create()
    await first.start()
    await harness.until("socket")
    expect(harness.flora).toHaveLength(1)
    expect(harness.flora[0]!.headers).toMatchObject({ authorization: `Bearer ${access}`, "chatgpt-account-id": accountID })
    const label = defaultDotsLabel("h".repeat(150), installationID)
    expect(label.length).toBeLessThanOrEqual(100)
    expect(harness.flora[0]!.body).toEqual({ displayName: label, installation_id: installationID, selected_capability_roots: harness.roots })
    expect((await stat(harness.statePath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({ status: "completed", executorID, accountHash: accountDigest, installationID, displayName: label })
    await first.stop()

    await harness.create().start()
    await harness.until("socket", 2)
    expect(harness.flora).toHaveLength(1)
    expect(harness.registrations).toHaveLength(2)
  })

  test("a rejected Flora enrollment stops until the configuration changes, then enrolls again", async () => {
    const harness = await fixture({ configuration: enabled(), flora: [json(403, { error: "synthetic" })] })
    await harness.create().start()
    await harness.until("CCA executor enrollment-rejected")
    expect(harness.waits).toEqual([])
    expect(harness.registrations).toEqual([])

    harness.set(enabled(2))
    await harness.until("socket")
    expect(harness.flora).toHaveLength(2)
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({ status: "completed", executorID })
  })

  test.each([
    { name: "uncertain", stored: completed({ status: "uncertain", executorID: undefined }), diagnostic: "enrollment-uncertain" },
    { name: "pending", stored: completed({ status: "pending", executorID: undefined }), diagnostic: "enrollment-uncertain" },
    { name: "other account", stored: completed({ accountHash: "0".repeat(64) }), diagnostic: "enrollment-account-mismatch" },
    { name: "corrupt", stored: "{not json", diagnostic: "enrollment-unreadable" },
  ])("never enrolls again over a stored enrollment it cannot reuse: $name", async ({ stored, diagnostic }) => {
    const harness = await fixture({ configuration: enabled(), stored })
    const before = await readFile(harness.statePath, "utf8")
    await harness.create().start()
    await harness.until(`CCA executor ${diagnostic}`)
    harness.set(enabled(2))
    await harness.until(`CCA executor ${diagnostic}`, 2)
    expect(harness.flora).toEqual([])
    expect(harness.registrations).toEqual([])
    expect(harness.waits).toEqual([])
    expect(await readFile(harness.statePath, "utf8")).toBe(before)
  })

  test("a Flora 500 leaves no enrollment state and the host retries the enrollment after backoff", async () => {
    const harness = await fixture({ configuration: enabled(), flora: [json(500, { error: "synthetic" })] })
    await harness.create().start()
    await harness.until("CCA executor enrollment-failed")
    await harness.until("socket")
    expect(harness.flora).toHaveLength(2)
    expect(harness.waits).toEqual([500])
    expect(harness.events.indexOf("CCA executor enrollment-failed")).toBeLessThan(harness.events.lastIndexOf("flora"))
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({ status: "completed", executorID })
  })

  test("a 401 from Flora is retried once with the credential refreshed for the pinned account", async () => {
    const refreshed = "synthetic-access-token-host-0003"
    const rejectedTokens: (string | undefined)[] = []
    const harness = await fixture({
      configuration: enabled(),
      flora: [json(401, { error: "synthetic" })],
      credential: (configuration, rejected) => {
        rejectedTokens.push(rejected)
        return configuration.enabled
          ? { access: rejected === undefined ? access : refreshed, accountID, key: "credential-key-1", profile: "dots", credentialID: "credential-1", accountGeneration: 1 }
          : undefined
      },
    })
    await harness.create().start()
    await harness.until("CCA executor connected")
    expect(harness.flora.map((entry) => entry.headers.authorization)).toEqual([`Bearer ${access}`, `Bearer ${refreshed}`])
    expect(rejectedTokens).toContain(access)
    expect(harness.diagnostics).toEqual(["CCA executor connected"])
  })

  test("registry authentication rejection stops retries until the next configuration change", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed(), register: [401] })
    await harness.create().start()
    await harness.until("CCA executor registration-rejected")
    expect(harness.waits).toEqual([])
    expect(harness.sockets).toEqual([])

    harness.set(enabled(2))
    await harness.until("socket")
    expect(harness.registrations).toHaveLength(2)
  })

  test("reconnects after failures and drops with one key, a reused registration, and upstream backoff", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed(), register: [503, 503] })
    const host = harness.create()
    await host.start()
    await harness.until("served")
    harness.advance(120_000)
    harness.sockets[0]!.drop()
    await harness.until("served", 2)
    harness.sockets[1]!.drop()
    await harness.until("served", 3)
    await host.stop()

    expect(harness.waits).toEqual([500, 1_000, 500, 1_000])
    expect(harness.registrations).toHaveLength(3)
    const keys = harness.registrations.map((entry) => JSON.stringify(entry.body.executor_public_key))
    expect(new Set(keys).size).toBe(1)
    expect(harness.sockets.map((socket) => socket.url)).toEqual([signedURL, signedURL, signedURL])
    expect(new Set(harness.sockets.map((socket) => socket.headers["x-request-id"])).size).toBe(3)
    for (const socket of harness.sockets) expect(socket.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{32}$/)
    expect(harness.sockets.every((socket) => socket.readyState === 3)).toBe(true)
    expect(harness.diagnostics.filter((message) => message === "CCA executor connection-dropped")).toHaveLength(2)
  })

  test("backoff doubles to a 30 s cap while connections stay shorter than 120 s", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed() })
    const host = harness.create()
    await host.start()
    for (let index = 0; index < 7; index++) {
      await harness.until("served", index + 1)
      harness.advance(119_999)
      harness.sockets[index]!.drop()
    }
    await harness.until("served", 8)
    await host.stop()
    expect(harness.waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000])
    expect(harness.registrations).toHaveLength(1)
  })

  test("a rendezvous handshake 4xx registers again with the same key before redialling; other dial failures do not", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed(), dial: [403, 500] })
    const host = harness.create()
    await host.start()
    await harness.until("CCA executor connected")
    await host.stop()
    expect(harness.sockets).toHaveLength(3)
    expect(harness.registrations).toHaveLength(2)
    expect(harness.events.filter((event) => event === "register" || event === "socket")).toEqual(["register", "socket", "register", "socket", "socket"])
    expect(new Set(harness.registrations.map((entry) => JSON.stringify(entry.body.executor_public_key))).size).toBe(1)
    expect(harness.diagnostics).toEqual(["CCA executor connection-failed", "CCA executor connection-failed", "CCA executor connected"])
  })

  test("a registration conflict is retried inside the attempt and never reported as a failure", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed(), register: [{ status: 503, code: "registration_conflict" }, { status: 502, code: "authentication_service_unavailable" }] })
    const host = harness.create()
    await host.start()
    await harness.until("CCA executor connected")
    await host.stop()
    expect(harness.registrations).toHaveLength(3)
    expect(harness.waits).toEqual([500, 1_000])
    expect(harness.diagnostics).toEqual(["CCA executor connected"])
  })

  test("a 401 registration is retried once with the refreshed credential", async () => {
    const refreshed = "synthetic-access-token-host-0002"
    const rejectedTokens: (string | undefined)[] = []
    const harness = await fixture({
      configuration: enabled(),
      stored: completed(),
      register: [401],
      credential: (configuration, rejected) => {
        rejectedTokens.push(rejected)
        return configuration.enabled
          ? { access: rejected === undefined ? access : refreshed, accountID, key: "credential-key-1", profile: "dots", credentialID: "credential-1", accountGeneration: 1 }
          : undefined
      },
    })
    const host = harness.create()
    await host.start()
    await harness.until("CCA executor connected")
    await host.stop()
    expect(harness.registrations.map((entry) => entry.headers.authorization)).toEqual([`Bearer ${access}`, `Bearer ${refreshed}`])
    expect(rejectedTokens).toContain(access)
    expect(harness.diagnostics).toEqual(["CCA executor connected"])
  })

  test("stop during backoff cancels the delay and repeated stops settle", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed(), register: [503], realWait: true })
    const host = harness.create()
    await host.start()
    await harness.until("CCA executor connection-failed")
    const started = performance.now()
    await Promise.all([host.stop(), host.stop()])
    await host.stop()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(harness.registrations).toHaveLength(1)
    expect(harness.listeners.size).toBe(0)
  })

  test("stop closes an open connection once and is idempotent", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed() })
    const host = harness.create()
    await host.start()
    await harness.until("socket")
    await Promise.all([host.stop(), host.stop()])
    expect(harness.sockets[0]!.readyState).toBe(3)
    expect(harness.events.filter((event) => event === "socket-closed")).toHaveLength(1)
    await host.stop()
    expect(harness.registrations).toHaveLength(1)
  })

  test.each([
    { name: "missing", storedRoots: "absent" as const },
    { name: "different", storedRoots: [{ id: "ycoding-skills", path: "/synthetic/old/.agents/skills" }] },
  ])("re-registers once with the stored installation when the registered roots are $name", async ({ storedRoots }) => {
    const harness = await fixture({ stored: completed(), configuration: enabled(), storedRoots })
    await harness.create().start()
    await harness.until("socket")
    expect(harness.flora).toHaveLength(1)
    expect(harness.flora[0]!.body).toEqual({ displayName: "synthetic-host", installation_id: "synthetic-proof-installation", selected_capability_roots: harness.roots })
    expect(harness.events.indexOf("flora")).toBeLessThan(harness.events.indexOf("register"))
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({ installationID: "synthetic-proof-installation", executorID, selectedCapabilityRoots: harness.roots })
    expect(harness.diagnostics).not.toContain("CCA executor registration-executor-changed")
    harness.sockets[0]!.drop()
    await harness.until("socket", 2)
    expect(harness.flora).toHaveLength(1)
  })

  test("a re-registration that returns another executor updates the state and reports the change", async () => {
    const replacement = "ccarenv_b64_synthetic-replacement-host-0001"
    const harness = await fixture({ stored: completed(), configuration: enabled(), storedRoots: "absent", flora: [json(200, { executor_id: replacement, custom_display_name: null })] })
    await harness.create().start()
    await harness.until("CCA executor registration-executor-changed")
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({ installationID: "synthetic-proof-installation", executorID: replacement, selectedCapabilityRoots: harness.roots })
    for (const message of harness.diagnostics) expect(message).not.toContain(replacement)
  })

  test("a re-registration retries once after one second, then reports a fixed reason and connects with the existing registration", async () => {
    const harness = await fixture({ stored: completed(), configuration: enabled(), storedRoots: "absent", flora: [json(503, { error: "synthetic" }), json(503, { error: "synthetic" })] })
    await harness.create().start()
    await harness.until("socket")
    expect(harness.flora).toHaveLength(2)
    expect(harness.waits).toEqual([1_000])
    expect(harness.diagnostics).toContain("CCA executor registration-update-failed")
    expect(harness.registrations[0]!.url).toBe(registerURL)
    const stored = JSON.parse(await readFile(harness.statePath, "utf8"))
    expect(stored).toMatchObject({ installationID: "synthetic-proof-installation", executorID, status: "completed" })
    expect("selectedCapabilityRoots" in stored).toBe(false)
  })

  test("a fresh enrollment uses the configured Dots label and records it", async () => {
    const harness = await fixture({ configuration: enabled(), name: "Desk Mac" })
    await harness.create().start()
    await harness.until("socket")
    expect(harness.flora.map((post) => post.body)).toEqual([{ displayName: "Desk Mac", installation_id: installationID, selected_capability_roots: harness.roots }])
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({ status: "completed", executorID, installationID, displayName: "Desk Mac" })
  })

  test("a configured Dots label re-registers the stored installation once and keeps its executor, account and roots", async () => {
    const harness = await fixture({ stored: completed(), configuration: enabled(), name: "Desk Mac" })
    await harness.create().start()
    await harness.until("socket")
    expect(harness.flora.map((post) => post.body)).toEqual([{ displayName: "Desk Mac", installation_id: "synthetic-proof-installation", selected_capability_roots: harness.roots }])
    expect(harness.events.indexOf("flora")).toBeLessThan(harness.events.indexOf("register"))
    expect(harness.registrations[0]!.url).toBe(registerURL)
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toEqual({ ...completed(), selectedCapabilityRoots: harness.roots, customDisplayName: null, displayName: "Desk Mac", updatedAt: expect.any(String) })
    expect(harness.diagnostics).not.toContain("CCA executor registration-executor-changed")
    harness.sockets[0]!.drop()
    await harness.until("socket", 2)
    expect(harness.flora).toHaveLength(1)
  })

  test.each([
    { name: "no configured label keeps a recorded label", stored: completed({ displayName: "Recorded desk" }), label: undefined },
    { name: "the configured label is already recorded", stored: completed({ displayName: "Desk Mac" }), label: "Desk Mac" },
  ])("reuses the enrollment without a Flora request when $name", async ({ stored, label }) => {
    const harness = await fixture({ stored, configuration: enabled(), ...(label === undefined ? {} : { name: label }) })
    await harness.create().start()
    await harness.until("socket")
    expect(harness.flora).toEqual([])
  })

  test("a rename answered with another executor leaves the enrollment bytes unchanged, connects with the stored executor and is not retried in the run", async () => {
    const replacement = "ccarenv_b64_synthetic-rename-replacement-0001"
    const harness = await fixture({ stored: completed(), configuration: enabled(), name: "Desk Mac", flora: [json(200, { executor_id: replacement, custom_display_name: null })] })
    const before = await readFile(harness.statePath, "utf8")
    await harness.create().start()
    await harness.until("socket")
    expect(harness.diagnostics).toContain("CCA executor registration-rename-rejected")
    expect(harness.diagnostics).not.toContain("CCA executor registration-executor-changed")
    expect(await readFile(harness.statePath, "utf8")).toBe(before)
    expect(harness.registrations.map((entry) => entry.url)).toEqual([registerURL])
    harness.sockets[0]!.drop()
    await harness.until("socket", 2)
    expect(harness.flora).toHaveLength(1)
    expect(await readFile(harness.statePath, "utf8")).toBe(before)
    for (const message of harness.diagnostics) expect(message).not.toContain(replacement)
  })

  test("a failed rename keeps the enrollment bytes and connects with the stored executor", async () => {
    const harness = await fixture({ stored: completed(), configuration: enabled(), name: "Desk Mac", flora: [json(503, { error: "synthetic" }), json(503, { error: "synthetic" })] })
    const before = await readFile(harness.statePath, "utf8")
    await harness.create().start()
    await harness.until("socket")
    expect(harness.flora).toHaveLength(2)
    expect(harness.diagnostics).toContain("CCA executor registration-update-failed")
    expect(await readFile(harness.statePath, "utf8")).toBe(before)
    expect(harness.registrations[0]!.url).toBe(registerURL)
  })

  test("a roots change re-registers with the configured label and records it", async () => {
    const harness = await fixture({ stored: completed(), configuration: enabled(), storedRoots: "absent", name: "Desk Mac" })
    await harness.create().start()
    await harness.until("socket")
    expect(harness.flora.map((post) => post.body)).toEqual([{ displayName: "Desk Mac", installation_id: "synthetic-proof-installation", selected_capability_roots: harness.roots }])
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({ executorID, selectedCapabilityRoots: harness.roots, displayName: "Desk Mac" })
  })

  test("the host opens only the registered rendezvous socket and never codex-cloud-backend", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed() })
    await harness.create().start()
    await harness.until("served")
    harness.sockets[0]!.drop()
    await harness.until("served", 2)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(harness.opened).toEqual([signedURL, signedURL])
    for (const url of harness.opened) expect(url).not.toContain("codex-cloud-backend")
  })

  test("diagnostics are fixed categories without credentials, identifiers, URLs, or paths", async () => {
    const harness = await fixture({ configuration: enabled(), stored: completed(), register: [401, 503] })
    await harness.create().start()
    await harness.until("CCA executor registration-rejected")
    harness.set(enabled(2))
    await harness.until("served")
    harness.sockets[0]!.drop()
    await harness.until("CCA executor connected", 2)

    expect(harness.diagnostics).toEqual([
      "CCA executor registration-rejected",
      "CCA executor connection-failed",
      "CCA executor connected",
      "CCA executor connection-dropped",
      "CCA executor connected",
    ])
    const allowed = new Set(ccaExecutorHostDiagnostics.map((category) => `CCA executor ${category}`))
    for (const message of harness.diagnostics) {
      expect(allowed.has(message)).toBe(true)
      for (const secret of [access, accountID, executorID, registrationID, signedURL, "sig=", harness.statePath, installationID])
        expect(message).not.toContain(secret)
    }
  })
})
