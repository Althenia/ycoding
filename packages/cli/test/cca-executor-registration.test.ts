import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildCcaHeaders,
  buildCcaRegistrationBody,
  ccaDesktopUserAgent,
  ccaExecutorCapabilityRoots,
  ccaExecutorRegistrationURL,
  CcaRegistrationError,
  decodeCcaRegistrationResponse,
  loadCcaExperimentState,
  reregisterCcaExecutor,
  runCcaRegistration,
  safeExecutorSummary,
  type CcaCredential,
  type CcaExperimentState,
  type CcaFetch,
} from "../src/remote-control/cca-executor-registration"

const credential: CcaCredential = {
  access: "synthetic-token-secret-12345",
  accountID: "synthetic-acct-67890",
}
const refreshedCredential: CcaCredential = {
  access: "synthetic-refreshed-token-67890",
  accountID: "synthetic-acct-67890",
}
const experimentInstallationID = "independent-exp-inst-123"

const cleanupDirs: string[] = []

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cca-test-"))
  cleanupDirs.push(dir)
  return dir
}

type Posted = { readonly url: string; readonly headers: Record<string, string>; readonly body: unknown }

function scriptedFetch(responses: ReadonlyArray<() => Response | Promise<Response>>) {
  const posts: Posted[] = []
  const fetch: CcaFetch = async (url, init) => {
    posts.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) })
    const next = responses[posts.length - 1]
    if (next === undefined) throw new Error("unexpected registration request")
    return next()
  }
  return { posts, fetch }
}

const ok = (executorID = "ccarenv_b64_registered_1") => () =>
  new Response(JSON.stringify({ executor_id: executorID, custom_display_name: null }), { status: 200 })
const status = (code: number, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify({ error: "leaked-secret-body" }), { status: code, headers })

async function register(fetch: CcaFetch, extra: Partial<Parameters<typeof runCcaRegistration>[0]> = {}) {
  const statePath = path.join(await createTempDir(), "experiment.json")
  const outcome = await runCcaRegistration({
    credential,
    installationID: experimentInstallationID,
    displayName: "my-mac",
    statePath,
    fetch,
    ...extra,
  }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )
  const stored = await readFile(statePath, "utf8").then((text) => JSON.parse(text) as CcaExperimentState, () => undefined)
  return { ...outcome, statePath, stored }
}

const storedState = {
  installationID: experimentInstallationID,
  accountHash: "synthetic-account-hash",
  status: "completed" as const,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  executorID: "ccarenv_b64_existing",
  customDisplayName: null,
  selectedCapabilityRoots: [{ id: "ycoding-skills", path: "/synthetic/home/.agents/skills" }],
}

async function writeStored() {
  const statePath = path.join(await createTempDir(), "experiment.json")
  const before = JSON.stringify(storedState)
  await writeFile(statePath, before, { mode: 0o600 })
  return { statePath, before }
}

describe("cca-executor-registration", () => {
  test("sends the desktop identity: Codex Desktop originator and the 26.1023.50603 User-Agent for this platform", () => {
    expect(ccaExecutorRegistrationURL).toBe("https://chatgpt.com/backend-api/flora/cca/executor")
    expect(ccaDesktopUserAgent("darwin", "arm64")).toBe("Codex Desktop/26.1023.50603 (Mac OS; arm64)")
    expect(ccaDesktopUserAgent("linux", "x64")).toBe("Codex Desktop/26.1023.50603 (X11; Linux; x64)")
    expect(ccaDesktopUserAgent("win32", "x64")).toBe("Codex Desktop/26.1023.50603 (Windows NT 10.0; x64)")
    expect(ccaDesktopUserAgent("freebsd", "arm64")).toBe("Codex Desktop/26.1023.50603 (freebsd; arm64)")
    expect(buildCcaHeaders(credential)).toEqual({
      authorization: "Bearer synthetic-token-secret-12345",
      "chatgpt-account-id": "synthetic-acct-67890",
      originator: "Codex Desktop",
      "User-Agent": ccaDesktopUserAgent(process.platform, process.arch),
      "content-type": "application/json",
    })
    expect(JSON.parse(buildCcaRegistrationBody({ displayName: "test-machine", installationID: experimentInstallationID }))).toEqual({
      displayName: "test-machine",
      installation_id: experimentInstallationID,
      selected_capability_roots: [],
    })
  })

  test("the executor capability roots advertise global skills and isolated Dots operator skills", () => {
    const roots = ccaExecutorCapabilityRoots("/synthetic/home", "/synthetic/data")
    expect(roots).toEqual([
      { id: "codex-home-skills", path: "/synthetic/home/.agents/skills" },
      { id: "ycoding-dots-skills", path: "/synthetic/data/dots/skills" },
    ])
    expect(JSON.parse(buildCcaRegistrationBody({ displayName: "test-machine", installationID: experimentInstallationID, roots }))).toEqual({
      displayName: "test-machine",
      installation_id: experimentInstallationID,
      selected_capability_roots: roots,
    })
  })

  test("installs the exact bundled operator skill and writes only changed content", async () => {
    const { ensureYcodingOperatorSkill, ycodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
    const data = await createTempDir()
    const file = path.join(data, "dots", "skills", "ycoding-operator", "SKILL.md")
    await ensureYcodingOperatorSkill(data)
    expect(await readFile(file, "utf8")).toBe(ycodingOperatorSkill)
    await utimes(file, new Date(0), new Date(0))
    const before = await stat(file)
    await ensureYcodingOperatorSkill(data)
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
    await writeFile(file, "outdated bundled instructions")
    await utimes(file, new Date(0), new Date(0))
    await ensureYcodingOperatorSkill(data)
    expect(await readFile(file, "utf8")).toBe(ycodingOperatorSkill)
    expect((await stat(file)).mtimeMs).not.toBe(before.mtimeMs)
  })

  test("propagates operator skill installation errors instead of advertising unavailable instructions", async () => {
    const { ensureYcodingOperatorSkill } = await import("../src/remote-control/ycoding-operator-skill")
    const data = await createTempDir()
    await mkdir(path.join(data, "dots", "skills", "ycoding-operator", "SKILL.md"), { recursive: true })
    await expect(ensureYcodingOperatorSkill(data)).rejects.toThrow()
  })

  test("a registration with roots records them in the executor state", async () => {
    const roots = ccaExecutorCapabilityRoots("/synthetic/home")
    const scripted = scriptedFetch([ok("ccarenv_b64_with_roots")])
    const { value, stored } = await register(scripted.fetch, { roots })
    expect(scripted.posts[0]!.body).toMatchObject({ selected_capability_roots: roots })
    expect(value!.state.selectedCapabilityRoots).toEqual(roots)
    expect(stored!.selectedCapabilityRoots).toEqual(roots)
  })

  test("runs successful registration with exact request shape and token-free state", async () => {
    let observedInit: RequestInit | undefined
    let observedUrl = ""
    const { value, statePath } = await register(async (url, init) => {
      observedUrl = url
      observedInit = init
      return ok()()
    })
    expect(observedUrl).toBe("https://chatgpt.com/backend-api/flora/cca/executor")
    expect(observedInit?.method).toBe("POST")
    expect(observedInit?.redirect).toBe("error")
    expect(observedInit?.headers).toEqual(buildCcaHeaders(credential))
    expect(JSON.parse(String(observedInit?.body))).toEqual({ displayName: "my-mac", installation_id: experimentInstallationID, selected_capability_roots: [] })
    expect(value!.result).toEqual({ executorID: "ccarenv_b64_registered_1", customDisplayName: null })
    expect(value!.state).toMatchObject({
      status: "completed",
      installationID: experimentInstallationID,
      executorID: "ccarenv_b64_registered_1",
      accountHash: createHash("sha256").update("synthetic-acct-67890").digest("hex"),
    })
    const fileContent = await readFile(statePath, "utf8")
    expect(fileContent).not.toContain(credential.access)
    expect(fileContent).not.toContain(credential.accountID)
    if (process.platform !== "win32") expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  })

  test("a 401 refreshes the credential once and retries with the refreshed bearer", async () => {
    const refreshed: CcaCredential[] = []
    const scripted = scriptedFetch([status(401), ok()])
    const { value, stored } = await register(scripted.fetch, {
      refreshCredential: async (rejected) => {
        refreshed.push(rejected)
        return refreshedCredential
      },
    })
    expect(refreshed).toEqual([credential])
    expect(scripted.posts.map((post) => post.headers.authorization)).toEqual([
      "Bearer synthetic-token-secret-12345",
      "Bearer synthetic-refreshed-token-67890",
    ])
    expect(scripted.posts[1]!.body).toEqual(scripted.posts[0]!.body)
    expect(value!.state.status).toBe("completed")
    expect(JSON.stringify(stored)).not.toContain(refreshedCredential.access)
  })

  test.each([
    { name: "a second 401 after refresh", responses: [status(401), status(401)], refresh: async () => refreshedCredential, posts: 2 },
    { name: "a 401 when the refresh yields no credential", responses: [status(401)], refresh: async () => undefined, posts: 1 },
    { name: "a 401 when the refresh fails", responses: [status(401)], refresh: async () => { throw new Error("synthetic refresh failure") }, posts: 1 },
    { name: "a 401 when the refresh changes account", responses: [status(401)], refresh: async () => ({ access: "synthetic-other", accountID: "synthetic-other-account" }), posts: 1 },
    { name: "a 401 without a refresher", responses: [status(401)], refresh: undefined, posts: 1 },
  ])("$name is retryable and leaves no registration state behind", async ({ responses, refresh, posts }) => {
    const scripted = scriptedFetch(responses)
    const { error, stored } = await register(scripted.fetch, refresh === undefined ? {} : { refreshCredential: refresh })
    expect(error).toBeInstanceOf(CcaRegistrationError)
    expect((error as CcaRegistrationError).retryable).toBe(true)
    expect(scripted.posts).toHaveLength(posts)
    expect(stored).toBeUndefined()
  })

  test.each([408, 429, 500, 502, 503])("HTTP %d is retryable, sent once, and leaves no registration state behind", async (code) => {
    const scripted = scriptedFetch([status(code)])
    const { error, stored } = await register(scripted.fetch)
    expect(error).toBeInstanceOf(CcaRegistrationError)
    expect((error as CcaRegistrationError).retryable).toBe(true)
    expect((error as Error).message).toContain(`status ${code}`)
    expect(scripted.posts).toHaveLength(1)
    expect(stored).toBeUndefined()
  })

  test.each([
    { name: "HTTP 400", response: status(400) },
    { name: "HTTP 403", response: status(403) },
    { name: "HTTP 404", response: status(404) },
    { name: "a Cloudflare challenge on 403", response: status(403, { "cf-mitigated": "challenge" }) },
    { name: "a Cloudflare challenge on 503", response: status(503, { "cf-mitigated": "Challenge" }) },
    { name: "an unparseable response", response: () => new Response("not-valid-json", { status: 200 }) },
    { name: "a payload missing executor_id", response: () => new Response(JSON.stringify({ unexpected: 123 }), { status: 200 }) },
  ])("$name is not retryable and records the registration as failed without leaking", async ({ response }) => {
    const scripted = scriptedFetch([response])
    const { error, stored, statePath } = await register(scripted.fetch)
    expect(error).toBeInstanceOf(CcaRegistrationError)
    expect((error as CcaRegistrationError).retryable).toBe(false)
    expect(scripted.posts).toHaveLength(1)
    expect(stored).toMatchObject({ status: "failed", errorClassification: "failed" })
    expect(stored!.executorID).toBeUndefined()
    const fileContent = await readFile(statePath, "utf8")
    for (const value of ["leaked-secret-body", credential.access, credential.accountID]) expect(fileContent).not.toContain(value)
    expect((error as Error).message).not.toContain(credential.access)
  })

  test("a timeout aborts the request once, is retryable, and leaves no registration state behind", async () => {
    let calls = 0
    const { error, stored } = await register(async (_url, init) => {
      calls++
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const aborted = new Error("aborted")
          aborted.name = "AbortError"
          reject(aborted)
        })
      })
    }, { timeoutMs: 20 })
    expect(calls).toBe(1)
    expect((error as Error).message).toMatch(/timed out or was aborted/)
    expect((error as CcaRegistrationError).retryable).toBe(true)
    expect(stored).toBeUndefined()
  })

  test("a network failure is retryable and leaves no registration state behind", async () => {
    const { error, stored } = await register(async () => { throw new Error("synthetic network failure") })
    expect((error as Error).message).toBe("CCA executor registration request failed")
    expect((error as CcaRegistrationError).retryable).toBe(true)
    expect(stored).toBeUndefined()
  })

  test.each([
    { name: "keeps the executor", returned: "ccarenv_b64_existing", changed: false },
    { name: "reports a changed executor", returned: "ccarenv_b64_replacement", changed: true },
  ])("re-registration with the stored installation $name and records the codex-home-skills roots", async ({ returned, changed }) => {
    const { statePath } = await writeStored()
    const roots = ccaExecutorCapabilityRoots("/synthetic/home")
    const scripted = scriptedFetch([ok(returned)])
    const result = await reregisterCcaExecutor({ credential, state: storedState, displayName: "my-mac", statePath, roots, fetch: scripted.fetch })
    expect(scripted.posts).toEqual([{
      url: ccaExecutorRegistrationURL,
      body: { displayName: "my-mac", installation_id: experimentInstallationID, selected_capability_roots: roots },
      headers: buildCcaHeaders(credential),
    }])
    expect(result.executorChanged).toBe(changed)
    expect(result.state).toMatchObject({ ...storedState, executorID: returned, selectedCapabilityRoots: roots, updatedAt: expect.any(String) })
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ status: "completed", executorID: returned, selectedCapabilityRoots: roots })
    if (process.platform !== "win32") expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  })

  test("re-registration retries a retryable failure once after 1 s", async () => {
    const { statePath } = await writeStored()
    const waits: number[] = []
    const scripted = scriptedFetch([status(503), ok()])
    const result = await reregisterCcaExecutor({
      credential,
      state: storedState,
      statePath,
      roots: ccaExecutorCapabilityRoots("/synthetic/home"),
      fetch: scripted.fetch,
      wait: async (ms) => { waits.push(ms) },
    })
    expect(waits).toEqual([1_000])
    expect(scripted.posts).toHaveLength(2)
    expect(result.state.selectedCapabilityRoots).toEqual(ccaExecutorCapabilityRoots("/synthetic/home"))
  })

  test("re-registration refreshes the credential on 401 within one attempt", async () => {
    const { statePath } = await writeStored()
    const waits: number[] = []
    const scripted = scriptedFetch([status(401), ok()])
    await reregisterCcaExecutor({
      credential,
      state: storedState,
      statePath,
      roots: ccaExecutorCapabilityRoots("/synthetic/home"),
      fetch: scripted.fetch,
      refreshCredential: async () => refreshedCredential,
      wait: async (ms) => { waits.push(ms) },
    })
    expect(waits).toEqual([])
    expect(scripted.posts.map((post) => post.headers.authorization)).toEqual([
      "Bearer synthetic-token-secret-12345",
      "Bearer synthetic-refreshed-token-67890",
    ])
  })

  test.each([
    { name: "two retryable failures", responses: [status(503), status(500)], posts: 2, waits: [1_000] },
    { name: "a network failure twice", responses: [() => { throw new Error("synthetic network failure") }, () => { throw new Error("synthetic network failure") }], posts: 2, waits: [1_000] },
    { name: "a non-retryable failure", responses: [status(403)], posts: 1, waits: [] },
    { name: "a Cloudflare challenge", responses: [status(503, { "cf-mitigated": "challenge" })], posts: 1, waits: [] },
    { name: "an invalid response", responses: [() => new Response("{not json", { status: 200 })], posts: 1, waits: [] },
  ])("re-registration gives up after $name and keeps the stored registration unchanged without leaking", async ({ responses, posts, waits }) => {
    const { statePath, before } = await writeStored()
    const observed: number[] = []
    const scripted = scriptedFetch(responses)
    const error = await reregisterCcaExecutor({
      credential,
      state: storedState,
      statePath,
      roots: ccaExecutorCapabilityRoots("/synthetic/home"),
      fetch: scripted.fetch,
      wait: async (ms) => { observed.push(ms) },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaRegistrationError)
    expect((error as Error).message).not.toContain(credential.access)
    expect(scripted.posts).toHaveLength(posts)
    expect(observed).toEqual([...waits])
    expect(await readFile(statePath, "utf8")).toBe(before)
  })

  test("clamps display name to at most 100 characters and requires installation ID", () => {
    const body = JSON.parse(buildCcaRegistrationBody({ displayName: "x".repeat(150), installationID: experimentInstallationID }))
    expect(body.displayName).toBe("x".repeat(100))
    expect(() => buildCcaRegistrationBody({ displayName: "test", installationID: "" })).toThrow()
  })

  test("decodes valid executor registration responses", () => {
    expect(decodeCcaRegistrationResponse({ executor_id: "ccarenv_b64_sample_executor_123", custom_display_name: "Custom Name" })).toEqual({
      executorID: "ccarenv_b64_sample_executor_123",
      customDisplayName: "Custom Name",
    })
    expect(decodeCcaRegistrationResponse({ executor_id: "  trimmed_id  ", custom_display_name: null })).toEqual({ executorID: "trimmed_id", customDisplayName: null })
    expect(decodeCcaRegistrationResponse({ executor_id: "exec-1" })).toEqual({ executorID: "exec-1", customDisplayName: undefined })
  })

  test("rejects malformed, missing, or empty executor ID", () => {
    expect(() => decodeCcaRegistrationResponse(null)).toThrow()
    expect(() => decodeCcaRegistrationResponse({})).toThrow()
    expect(() => decodeCcaRegistrationResponse({ executor_id: "" })).toThrow()
    expect(() => decodeCcaRegistrationResponse({ executor_id: "   " })).toThrow()
    expect(() => decodeCcaRegistrationResponse({ executor_id: 12345 })).toThrow()
    expect(() => decodeCcaRegistrationResponse({ executor_id: "valid", custom_display_name: 999 })).toThrow()
  })

  test("safeExecutorSummary classifies prefix via fixed vocabulary and computes sha256 and length", () => {
    const ccarB64 = safeExecutorSummary("ccarenv_b64_sample123")
    expect(ccarB64.prefix).toBe("ccarenv_b64_")
    expect(ccarB64.length).toBe(21)
    expect(ccarB64.sha256).toBe(createHash("sha256").update("ccarenv_b64_sample123").digest("hex"))
    expect(safeExecutorSummary("ccarenv_legacy_456").prefix).toBe("ccarenv_")
    expect(safeExecutorSummary("env_e_remote789").prefix).toBe("env_e_")
    expect(safeExecutorSummary("other_id_000").prefix).toBe("unknown")
  })

  test("validates request inputs before state reservation so invalid inputs do not strand state", async () => {
    const statePath = path.join(await createTempDir(), "experiment.json")
    await expect(runCcaRegistration({ credential, installationID: "", statePath })).rejects.toThrow()
    expect(await readFile(statePath, "utf8").catch(() => null)).toBeNull()
  })

  test("state reservation refuses existing state without making network calls", async () => {
    const statePath = path.join(await createTempDir(), "experiment.json")
    const scripted = scriptedFetch([ok("never")])
    await writeFile(statePath, JSON.stringify({ existing: true }), { flag: "wx" })
    await expect(runCcaRegistration({ credential, installationID: experimentInstallationID, statePath, fetch: scripted.fetch })).rejects.toThrow()
    expect(scripted.posts).toHaveLength(0)
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ existing: true })
  })

  test("loadCcaExperimentState throws on corrupt state file", async () => {
    const statePath = path.join(await createTempDir(), "corrupt.json")
    await writeFile(statePath, "{ broken json", "utf8")
    await expect(loadCcaExperimentState(statePath)).rejects.toThrow()
    await writeFile(statePath, JSON.stringify({ notAnExperimentState: 1 }), "utf8")
    await expect(loadCcaExperimentState(statePath)).rejects.toThrow(/missing required fields/)
  })
})
