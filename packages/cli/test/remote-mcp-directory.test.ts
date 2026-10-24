import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { LocalFailure, type LocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteDirectorySession, executeRemoteOperation } from "../src/remote-operations"
import { createRemoteMcp } from "../src/remote-mcp"

const resource = "https://relay.example.com/api/mcp/devices/dev_1"
const context = { requestID: "request_fixture", epoch: "epoch_1", principal: { ownerID: "own_1", deviceID: "dev_1", clientID: "client_1" } }
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
}

let base: string
let home: string
let outside: string
let project: string

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "ycoding-mcp-directory-")))
  home = join(base, "home")
  outside = join(base, "outside")
  project = join(home, "projects", "app")
  await mkdir(project, { recursive: true })
  await mkdir(join(outside, "inner"), { recursive: true })
  await writeFile(join(home, "file.txt"), "not a directory")
  await symlink(outside, join(home, "link-out"))
  await symlink(project, join(home, "link-in"))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

async function fixture(options: { projectID?: string } = {}) {
  const sessions: SessionInfo[] = []
  const results: Partial<Record<keyof LocalServer, unknown>> = {
    listPage: async () => ({ data: sessions }),
    getSession: async (sessionID: string) => sessions.find((info) => info.id === sessionID),
    outstandingSessions: { data: [], running: [], failed: [], lost: [] },
    projectCurrent: async (location: { directory: string }) => ({ id: options.projectID ?? "prj_dir", directory: location.directory }),
    createSession: async (id: string, location: { directory: string }) => {
      const created = {
        id, projectID: options.projectID ?? "prj_dir", model: { providerID: "test", id: "model" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 }, title: id, location: { directory: location.directory, workspaceID: undefined },
      } as unknown as SessionInfo
      sessions.push(created)
      return created
    },
  }
  const calls: { method: string; args: readonly unknown[] }[] = []
  const local = new Proxy({} as LocalServer, {
    get: (_target, property: PropertyKey) => (...args: unknown[]) => {
      calls.push({ method: String(property), args })
      const result = results[property as keyof LocalServer]
      if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
      if (result instanceof Error) return Promise.reject(result)
      return Promise.resolve(result)
    },
  })
  const registry = createSessionRegistry({ local })
  await registry.refresh()
  calls.length = 0
  const subscriptions = createSubscriptions()
  const mcp = createRemoteMcp({ local, sessions: registry, subscriptions, home, resource, allowed: () => true })
  const run = async (name: string, args: Record<string, unknown>) => {
    const response = await mcp.fetch(
      new Request(resource, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": name,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: meta } }),
      }),
      context,
    )
    return ((await response.json()) as { result: { isError?: boolean; structuredContent: unknown } }).result
  }
  const create = (id: string, directory: string, extra: Record<string, unknown> = {}) =>
    run("session_create_in_directory", { input: { id, directory, ...extra } })
  return { calls, results, registry, subscriptions, local, mcp, run, create, sessions }
}

const created = (calls: { method: string; args: readonly unknown[] }[]) => calls.filter((call) => call.method === "createSession")

describe("session_create_in_directory", () => {
  test("creates a root Session in an existing directory below home at its canonical path and registers it", async () => {
    const { create, calls, run } = await fixture()
    const result = await create("ses_dir_1", project, { agent: "build", model: { providerID: "test", id: "model" }, title: "Release review" })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ data: { id: "ses_dir_1", projectID: "prj_dir", location: { directory: project } } })
    expect(created(calls).map((call) => call.args)).toEqual([["ses_dir_1", { directory: project }, "build", { providerID: "test", id: "model" }, "Release review"]])
    expect((await run("session_get", { sessionID: "ses_dir_1" })).structuredContent).toMatchObject({ data: { id: "ses_dir_1" } })
  })

  test("follows a symlink that stays below home and records the canonical directory", async () => {
    const { create, calls } = await fixture()
    const result = await create("ses_dir_link", join(home, "link-in"))
    expect(result.isError).toBeUndefined()
    expect(created(calls).map((call) => call.args)).toEqual([["ses_dir_link", { directory: project }]])
  })

  test("is not limited by the web workspace inventory rules: global projects and temporary locations are allowed", async () => {
    const { create, calls } = await fixture({ projectID: "global" })
    const result = await create("ses_dir_global", project)
    expect(result.structuredContent).toMatchObject({ data: { projectID: "global", location: { directory: project } } })
    expect(created(calls)).toHaveLength(1)
  })

  test("reconciles a retry with the same id and placement without creating again", async () => {
    const { create, calls } = await fixture()
    const first = await create("ses_dir_retry", project)
    const second = await create("ses_dir_retry", project)
    expect(second.isError).toBeUndefined()
    expect(second.structuredContent).toEqual(first.structuredContent)
    expect(created(calls)).toHaveLength(1)
  })

  test("refuses an id that already belongs to a different placement", async () => {
    const { create, calls } = await fixture()
    await create("ses_dir_taken", project)
    const other = join(home, "projects")
    const result = await create("ses_dir_taken", other)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_message" } })
    expect(created(calls)).toHaveLength(1)
  })

  test.each([
    ["the home directory itself", () => home],
    ["a missing path", () => join(home, "missing")],
    ["a file", () => join(home, "file.txt")],
    ["a directory outside home", () => outside],
    ["a traversal that escapes home", () => `${home}/projects/../../outside`],
    ["a symlink that escapes home", () => join(home, "link-out")],
    ["a directory reached through an escaping symlink", () => join(home, "link-out", "inner")],
    ["a relative path", () => "projects/app"],
    ["a tilde path", () => "~/projects/app"],
    ["an environment-variable path", () => "$HOME/projects/app"],
  ])("refuses %s before creating a Session or a directory", async (_label, directory) => {
    const { create, calls } = await fixture()
    const result = await create("ses_dir_refused", directory())
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_message" } })
    expect(calls.map((call) => call.method)).not.toContain("createSession")
    expect(calls.map((call) => call.method)).not.toContain("projectCurrent")
    expect(existsSync(join(home, "missing"))).toBe(false)
  })

  test("requires the client id and rejects unknown fields at the published schema", async () => {
    const { run, calls } = await fixture()
    expect((await run("session_create_in_directory", { input: { directory: project } })).isError).toBe(true)
    expect((await run("session_create_in_directory", { input: { id: "ses_x", directory: project, workspace: "wsp" } })).isError).toBe(true)
    for (const title of ["", " Leading", "Trailing ", "Tab\tinside", "x".repeat(121)])
      expect((await run("session_create_in_directory", { input: { id: "ses_x", directory: project, title } })).isError).toBe(true)
    expect(calls.every((call) => call.method === "mcpEventsStatus")).toBe(true)
  })

  test("reports an unconfirmed create as outcome_unknown and does not replay it", async () => {
    const { create, calls, results } = await fixture()
    results.createSession = new LocalFailure("transport", "no response")
    const result = await create("ses_dir_unknown", project)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: "outcome_unknown" } })
    expect(created(calls)).toHaveLength(1)
  })
})

describe("entry separation", () => {
  test("validates fields itself when called directly", async () => {
    const { local, registry, subscriptions } = await fixture()
    const direct = (input: Record<string, unknown>) => executeRemoteDirectorySession({ id: "req_1", home, input, local, sessions: registry, subscriptions })
    for (const input of [
      { id: "ses_a", directory: project, extra: 1 },
      { id: "bad id", directory: project },
      { id: "ses_a", directory: 1 },
      { id: "ses_a", directory: project, model: { providerID: "test" } },
      { id: "ses_a", directory: project, title: "" },
      { id: "ses_a", directory: project, title: "Trailing " },
      { id: "ses_a", directory: project, title: "x".repeat(121) },
      { id: "ses_a", directory: project, title: "Bidi\u2066flip" },
    ]) {
      const frames = await direct(input)
      expect(frames[0]).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    }
    expect((await direct({ id: "ses_ok", directory: project }))[0]).toMatchObject({ ok: true })
  })

  test("the browser session.create envelope cannot select a directory", async () => {
    const { local, registry, subscriptions, calls } = await fixture()
    const frames = await executeRemoteOperation({
      request: { type: "request", id: "req_1", operation: "session.create", input: { id: "ses_browser", workspace: "wsp_1", directory: project } },
      local, sessions: registry, subscriptions,
    })
    expect(frames[0]).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    expect(created(calls)).toHaveLength(0)
  })
})
