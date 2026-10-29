import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createCcaExecutor } from "@ycoding-ai/core/cca/executor"
import { NativeDots } from "@ycoding-ai/core/dots/native"
import {
  answerCcaTaskWorkspace,
  ccaTaskWorkspaceFailure,
  type CcaTaskWorkspaceHost,
} from "../src/remote-control/cca-task-workspace"
import { fixedScopeFor } from "./fixture/cca-scope"

const environmentID = "ccarenv_b64_synthetic-task-workspace-0001"
const threadID = "0199a8f2-1111-7222-8333-944455556666"
const projectRoot = "/synthetic/projects/alpha"
const unknownProject = new NativeDots.Error({ code: "not_found", message: "The project is not in the catalog" })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

type Call = { readonly method: string; readonly input: unknown }

function fakeHost(overrides: Partial<CcaTaskWorkspaceHost> = {}) {
  const calls: Call[] = []
  const host: CcaTaskWorkspaceHost = {
    projectCatalog: async (input) => {
      calls.push({ method: "projectCatalog", input })
      return { environmentId: input.environmentID, projects: [{ projectId: "project-alpha", name: "Alpha", rootPaths: [projectRoot] }] }
    },
    assignProject: async (input) => {
      calls.push({ method: "assignProject", input })
      return { environmentId: input.environmentID, projectId: input.projectID, threadId: input.threadID }
    },
    prepareWorkspace: async (input) => {
      calls.push({ method: "prepareWorkspace", input })
      if (input.cwd !== null && input.cwd.startsWith(projectRoot))
        return { cwd: input.cwd, runtimeWorkspaceRoots: [projectRoot], ...(input.projectID === undefined ? {} : { projectId: input.projectID }) }
      return {
        cwd: input.cwd ?? "/synthetic/home/YCoding/task",
        runtimeWorkspaceRoots: ["/synthetic/home/YCoding/task"],
        ...(input.projectID === undefined ? {} : { projectId: input.projectID }),
      }
    },
    ...overrides,
  }
  return { host, calls }
}

function argv(request: unknown) {
  const encoded = Buffer.from(typeof request === "string" ? request : JSON.stringify(request)).toString("base64")
  return ["/bin/sh", "-c", "exec \"$1\" \"$@\"", "task-workspace", "synthetic-node-client", encoded, "true"]
}

const prepare = (params: Record<string, unknown>, id: string | number = "synthetic-request") => ({ id, jsonrpc: "2.0", method: "taskWorkspace/prepare", params: { environmentId: environmentID, ...params } })
const list = (params: Record<string, unknown> = {}) => ({ id: 7, jsonrpc: "2.0", method: "taskProject/list", params: { environmentId: environmentID, ...params } })
const assign = (params: Record<string, unknown> = {}) => ({ id: "assign-1", jsonrpc: "2.0", method: "taskProject/assign", params: { environmentId: environmentID, projectId: "project-alpha", threadId: threadID, ...params } })

function answer(request: unknown, host: CcaTaskWorkspaceHost, options: { readonly threadID?: string; readonly argv?: readonly string[] } = {}) {
  return answerCcaTaskWorkspace({
    argv: options.argv ?? argv(request),
    environmentID,
    ...(options.threadID === undefined ? {} : { threadID: options.threadID }),
    host,
  })
}

const success = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 })

describe("task-workspace detection", () => {
  test("ignores every process/start that is not the desktop task-workspace command", async () => {
    const { host, calls } = fakeHost()
    for (const command of [
      ["/bin/sh", "-c", "printf null"],
      ["/bin/sh", "-c", "printf null", "other", "client", Buffer.from(JSON.stringify(list())).toString("base64")],
      ["/bin/sh", "-lc", "printf null", "task-workspace", "client", Buffer.from(JSON.stringify(list())).toString("base64")],
      ["/bin/sh", "-c", "printf null", "task-workspace", "client"],
    ])
      expect(await answerCcaTaskWorkspace({ argv: command, environmentID, host })).toBeUndefined()
    expect(calls).toEqual([])
  })

  test.each([
    ["not base64 JSON", "%%%"],
    ["a JSON array", "[]"],
    ["a JSON string", "\"taskProject/list\""],
  ])("answers an undecodable request (%s) with the desktop failure", async (_name, raw) => {
    const { host, calls } = fakeHost()
    expect(await answer(raw, host)).toEqual(ccaTaskWorkspaceFailure)
    expect(calls).toEqual([])
  })

  test("the desktop failure is empty stdout, the fixed stderr line, and exit 1", () => {
    expect(ccaTaskWorkspaceFailure).toEqual({ stdout: "", stderr: "Desktop task request failed\n", exitCode: 1 })
  })
})

describe("taskProject/list", () => {
  test("prints the catalog for this executor", async () => {
    const { host, calls } = fakeHost()
    expect(await answer(list(), host)).toEqual(success({
      environmentId: environmentID,
      projects: [{ projectId: "project-alpha", name: "Alpha", rootPaths: [projectRoot] }],
    }))
    expect(calls).toEqual([{ method: "projectCatalog", input: { environmentID } }])
  })

  test("keeps only the desktop catalog fields", async () => {
    const project = { projectId: "p", name: "N", rootPaths: ["/r"], extra: "dropped" }
    const catalog = { environmentId: environmentID, projects: [project], extra: "dropped" }
    const { host } = fakeHost({ projectCatalog: async () => catalog })
    expect(await answer(list(), host)).toEqual(success({ environmentId: environmentID, projects: [{ projectId: "p", name: "N", rootPaths: ["/r"] }] }))
  })

  test("a catalog response frame above 1 MiB fails while one just below it succeeds", async () => {
    const frame = (catalog: unknown) => Buffer.byteLength(JSON.stringify({
      id: 7,
      jsonrpc: "2.0",
      result: {
        payload: JSON.stringify({ domain: "codex.taskProject.list.v1", request: { environmentId: environmentID, nonce: "0".repeat(64) }, catalog }),
        signature: "A".repeat(86) + "==",
      },
    }))
    const catalog = (length: number) => ({ environmentId: environmentID, projects: [{ projectId: "p", name: "n".repeat(length), rootPaths: ["/r"] }] })
    const base = frame(catalog(0))
    const fits = catalog(1_048_576 - base)
    const over = catalog(1_048_576 - base + 1)
    expect(frame(fits)).toBe(1_048_576)
    expect(await answer(list(), fakeHost({ projectCatalog: async () => fits }).host)).toEqual(success(fits))
    expect(await answer(list(), fakeHost({ projectCatalog: async () => over }).host)).toEqual(ccaTaskWorkspaceFailure)
  })

  test("a catalog larger than 64 KiB is still answered", async () => {
    const large = { environmentId: environmentID, projects: [{ projectId: "p", name: "n".repeat(200_000), rootPaths: ["/r"] }] }
    expect(await answer(list(), fakeHost({ projectCatalog: async () => large }).host)).toEqual(success(large))
  })

  test.each([
    ["an extra param", list({ extra: true })],
    ["another environment", list({ environmentId: "ccarenv_b64_synthetic-other" })],
    ["an empty environment", list({ environmentId: "" })],
    ["a missing jsonrpc", { id: 7, method: "taskProject/list", params: { environmentId: environmentID } }],
    ["a jsonrpc other than 2.0", { ...list(), jsonrpc: "1.0" }],
    ["a missing id", { jsonrpc: "2.0", method: "taskProject/list", params: { environmentId: environmentID } }],
    ["a null id", { ...list(), id: null }],
    ["a boolean id", { ...list(), id: true }],
    ["missing params", { id: 7, jsonrpc: "2.0", method: "taskProject/list" }],
  ])("rejects %s", async (_name, request) => {
    const { host, calls } = fakeHost()
    expect(await answer(request, host)).toEqual(ccaTaskWorkspaceFailure)
    expect(calls).toEqual([])
  })
})

describe("taskProject/assign", () => {
  test("records the assignment and prints the record", async () => {
    const { host, calls } = fakeHost()
    expect(await answer(assign(), host)).toEqual(success({ environmentId: environmentID, projectId: "project-alpha", threadId: threadID }))
    expect(calls).toEqual([{ method: "assignProject", input: { environmentID, threadID, projectID: "project-alpha" } }])
  })

  test.each([
    ["an extra param", assign({ extra: 1 })],
    ["a whitespace-padded projectId", assign({ projectId: " project-alpha " })],
    ["a blank projectId", assign({ projectId: "   " })],
    ["an empty threadId", assign({ threadId: "" })],
    ["a missing threadId", { id: 1, jsonrpc: "2.0", method: "taskProject/assign", params: { environmentId: environmentID, projectId: "p" } }],
  ])("rejects %s without assigning", async (_name, request) => {
    const { host, calls } = fakeHost()
    expect(await answer(request, host)).toEqual(ccaTaskWorkspaceFailure)
    expect(calls).toEqual([])
  })

  test("an unknown project on assignment answers the desktop failure", async () => {
    const { host } = fakeHost({ assignProject: async () => { throw unknownProject } })
    expect(await answer(assign(), host)).toEqual(ccaTaskWorkspaceFailure)
  })
})

describe("taskWorkspace/prepare", () => {
  test("a projectId with a cwd inside its root keeps the cwd and the project root", async () => {
    const { host, calls } = fakeHost()
    const cwd = `${projectRoot}/src`
    expect(await answer(prepare({ cwd, projectId: "project-alpha" }), host, { threadID })).toEqual(success({ cwd, runtimeWorkspaceRoots: [projectRoot], projectId: "project-alpha" }))
    expect(calls).toEqual([{ method: "prepareWorkspace", input: { environmentID, threadID, cwd, projectID: "project-alpha" } }])
  })

  test("a projectId with a cwd outside its root keeps the cwd and gets a task folder root", async () => {
    const { host } = fakeHost()
    expect(await answer(prepare({ cwd: "/synthetic/elsewhere", projectId: "project-alpha" }), host, { threadID })).toEqual(success({
      cwd: "/synthetic/elsewhere",
      runtimeWorkspaceRoots: ["/synthetic/home/YCoding/task"],
      projectId: "project-alpha",
    }))
  })

  test("a cwd alone is forwarded without a project", async () => {
    const { host, calls } = fakeHost()
    expect(await answer(prepare({ cwd: `${projectRoot}/docs` }), host)).toEqual(success({ cwd: `${projectRoot}/docs`, runtimeWorkspaceRoots: [projectRoot] }))
    expect(calls).toEqual([{ method: "prepareWorkspace", input: { environmentID, cwd: `${projectRoot}/docs` } }])
  })

  test("neither cwd nor projectId prepares a new task folder", async () => {
    const { host, calls } = fakeHost()
    expect(await answer(prepare({ cwd: null }), host, { threadID })).toEqual(success({ cwd: "/synthetic/home/YCoding/task", runtimeWorkspaceRoots: ["/synthetic/home/YCoding/task"] }))
    expect(calls).toEqual([{ method: "prepareWorkspace", input: { environmentID, threadID, cwd: null } }])
  })

  test("modelDefaults is omitted even when requested or returned", async () => {
    const prepared = { cwd: "/synthetic/w", runtimeWorkspaceRoots: ["/synthetic/w"], modelDefaults: { model: "m", reasoningEffort: null } }
    const { host } = fakeHost({ prepareWorkspace: async () => prepared })
    const result = await answer(prepare({ cwd: null, includeModelDefaults: true }), host)
    expect(result).toEqual(success({ cwd: "/synthetic/w", runtimeWorkspaceRoots: ["/synthetic/w"] }))
    expect(result!.stdout).not.toContain("modelDefaults")
  })

  test("unknown prepare params are accepted as the desktop accepts them", async () => {
    const { host } = fakeHost()
    expect((await answer(prepare({ cwd: null, futureField: { nested: true } }), host))!.exitCode).toBe(0)
  })

  test("non-ASCII output is escaped as lowercase \\u sequences with no trailing newline", async () => {
    const cwd = "/synthetic/Été/\u007f/日本"
    const { host } = fakeHost({ prepareWorkspace: async () => ({ cwd, runtimeWorkspaceRoots: [cwd] }) })
    const result = await answer(prepare({ cwd: null }), host)
    expect(result!.stdout).toBe("{\"cwd\":\"/synthetic/\\u00c9t\\u00e9/\\u007f/\\u65e5\\u672c\",\"runtimeWorkspaceRoots\":[\"/synthetic/\\u00c9t\\u00e9/\\u007f/\\u65e5\\u672c\"]}")
    expect(JSON.parse(result!.stdout)).toEqual({ cwd, runtimeWorkspaceRoots: [cwd] })
  })

  test("a response frame above 64 KiB fails", async () => {
    const cwd = `/${"d".repeat(70_000)}`
    const { host } = fakeHost({ prepareWorkspace: async () => ({ cwd, runtimeWorkspaceRoots: [cwd] }) })
    expect(await answer(prepare({ cwd: null }), host)).toEqual(ccaTaskWorkspaceFailure)
  })

  test.each([
    ["a missing cwd", prepare({})],
    ["an empty cwd", prepare({ cwd: "" })],
    ["a numeric cwd", prepare({ cwd: 1 })],
    ["a non-boolean includeModelDefaults", prepare({ cwd: null, includeModelDefaults: "yes" })],
    ["a null includeModelDefaults", prepare({ cwd: null, includeModelDefaults: null })],
    ["a whitespace-padded projectId", prepare({ cwd: null, projectId: "project-alpha " })],
    ["an empty projectId", prepare({ cwd: null, projectId: "" })],
    ["another environment", prepare({ cwd: null, environmentId: "ccarenv_b64_synthetic-other" })],
  ])("rejects %s without preparing", async (_name, request) => {
    const { host, calls } = fakeHost()
    expect(await answer(request, host)).toEqual(ccaTaskWorkspaceFailure)
    expect(calls).toEqual([])
  })

  test("an unknown project on preparation answers the desktop failure", async () => {
    const { host } = fakeHost({ prepareWorkspace: async () => { throw unknownProject } })
    expect(await answer(prepare({ cwd: null, projectId: "missing" }), host)).toEqual(ccaTaskWorkspaceFailure)
  })
})

describe("unknown task methods", () => {
  test.each(["taskThread/read", "tools/list", "taskWorkspace/other"])("%s gets the desktop rejection", async (method) => {
    const { host, calls } = fakeHost()
    expect(await answer({ id: 1, jsonrpc: "2.0", method, params: { environmentId: environmentID, threadId: threadID } }, host)).toEqual(ccaTaskWorkspaceFailure)
    expect(calls).toEqual([])
  })
})

describe("task-workspace answers as an executor process", () => {
  async function executor(host: CcaTaskWorkspaceHost) {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "ycoding-cca-task-workspace-")))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const authorized: { readonly action: string; readonly resources: readonly string[] }[] = []
    const instance = createCcaExecutor({
      scopeFor: fixedScopeFor([home], async (input) => {
        authorized.push({ action: input.action, resources: input.resources })
        return { release: async () => {} }
      }),
      answerProcess: (params, context) => answerCcaTaskWorkspace({
        argv: params.argv,
        environmentID,
        ...(context.attribution?.threadId === undefined ? {} : { threadID: context.attribution.threadId }),
        host,
      }),
    })
    cleanups.push(() => instance.close())
    const notifications: { readonly method: string; readonly params: any }[] = []
    const { sessionId } = await instance.initialize({ clientName: "synthetic" }, {
      signal: new AbortController().signal,
      notify: (method, params) => { notifications.push({ method, params }) },
    })
    const ctx = { signal: new AbortController().signal, sessionId }
    const run = async (processId: string, command: readonly string[]) => {
      const started = await instance.startProcess({ processId, argv: command, cwd: pathToFileURL(home).href, env: {}, metadata: { threadId: threadID } }, ctx)
      let read = await instance.readProcess({ processId, waitMs: 2_000 }, ctx)
      const chunks = [...read.chunks]
      while (!read.closed) {
        read = await instance.readProcess({ processId, afterSeq: read.nextSeq - 1, waitMs: 2_000 }, ctx)
        chunks.push(...read.chunks)
      }
      for (let turn = 0; turn < 100 && !notifications.some((entry) => entry.method === "process/closed" && entry.params.processId === processId); turn++)
        await new Promise((resolve) => setImmediate(resolve))
      const sequence = notifications.filter((entry) => entry.params.processId === processId).map((entry) => [entry.method, entry.params.seq])
      const output = chunks.map((chunk) => ({ seq: chunk.seq, stream: chunk.stream, text: Buffer.from(chunk.chunk, "base64").toString("utf8") }))
      const { chunks: _last, ...status } = read
      return { started, status, output, sequence }
    }
    return { instance, ctx, run, authorized, home }
  }

  test("emits the notification sequence and read shape of a real process that printed the same output", async () => {
    const { host, calls } = fakeHost()
    const { instance, ctx, run, authorized } = await executor(host)
    const probe = argv(list())
    const answered = await run("task-workspace", probe)
    const expected = JSON.stringify({ environmentId: environmentID, projects: [{ projectId: "project-alpha", name: "Alpha", rootPaths: [projectRoot] }] })
    const real = await run("real", ["/bin/sh", "-c", `printf '%s' '${expected}'`])

    expect(answered.started).toEqual({ processId: "task-workspace", sandboxType: "none" })
    expect(answered.sequence).toEqual([["process/output", 1], ["process/exited", 2], ["process/closed", 3]])
    expect(answered.sequence).toEqual(real.sequence)
    expect(answered.output).toEqual(real.output)
    expect(answered.output).toEqual([{ seq: 1, stream: "stdout", text: expected }])
    expect(answered.status).toEqual(real.status)
    expect(answered.status).toMatchObject({ exited: true, exitCode: 0, closed: true })
    expect(await instance.writeProcess({ processId: "task-workspace", chunk: "", writeId: "w1" }, ctx)).toEqual(await instance.writeProcess({ processId: "real", chunk: "", writeId: "w1" }, ctx))
    expect(calls).toEqual([{ method: "projectCatalog", input: { environmentID } }])
    expect(authorized).toContainEqual({ action: "shell", resources: [probe.join(" ")] })
  })

  test("a rejected request finishes as a process with the desktop failure on stderr and exit 1", async () => {
    const { host, calls } = fakeHost()
    const { run } = await executor(host)
    const answered = await run("task-workspace", argv({ id: 1, jsonrpc: "2.0", method: "taskThread/read", params: { threadId: threadID } }))
    const real = await run("real", ["/bin/sh", "-c", "printf 'Desktop task request failed\\n' >&2; exit 1"])
    expect(answered.sequence).toEqual(real.sequence)
    expect(answered.output).toEqual([{ seq: 1, stream: "stderr", text: "Desktop task request failed\n" }])
    expect(answered.output).toEqual(real.output)
    expect(answered.status).toEqual(real.status)
    expect(answered.status).toMatchObject({ exitCode: 1, exited: true, closed: true })
    expect(calls).toEqual([])
  })

  test("prepare receives the thread from the process attribution", async () => {
    const { host, calls } = fakeHost()
    const { run } = await executor(host)
    await run("task-workspace", argv(prepare({ cwd: null })))
    expect(calls).toEqual([{ method: "prepareWorkspace", input: { environmentID, threadID, cwd: null } }])
  })
})
