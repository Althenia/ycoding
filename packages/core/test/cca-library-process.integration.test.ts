import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createCcaExecutor } from "../src/cca/executor"
import { CcaPolicy } from "../src/cca/policy"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

test("a real CCA child receives a private Library route without caller account authority or credential output", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-child-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owners: unknown[] = []
  let closes = 0
  const executor = createCcaExecutor({ scopeFor: async () => ({
    sessionID: "ses_actual_owner", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) },
    close: async () => {},
    library: { open: async (owner) => {
      owners.push(owner)
      return { check: async () => {}, tools: [{ name: "ycoding_library.prepare_uploads", inputSchema: { type: "object", properties: {} } }],
        call: async () => ({ uploads: [{ id: "file-synthetic" }] }), close: async () => { closes++ } }
    } },
  }) })
  cleanup.push(() => executor.close())
  const initialized = await executor.initialize({ clientName: "synthetic-child" }, { signal: new AbortController().signal })
  const context = { sessionId: initialized.sessionId, signal: new AbortController().signal }
  const script = `
    const response=await fetch(process.env.CODEX_APPS_MCP_URL,{method:'POST',headers:{authorization:process.env.CODEX_APPS_AUTHORIZATION,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
    const body=await response.json();
    console.log(JSON.stringify({tools:body.result.tools.map(tool=>tool.name),accountAbsent:process.env.CODEX_APPS_ACCOUNT_ID===undefined,owner:process.env.YCODING_SESSION_ID}));
    process.stdout.write(process.env.CODEX_APPS_AUTHORIZATION.slice(0,20));
    process.stdout.write(process.env.CODEX_APPS_AUTHORIZATION.slice(20));
  `
  await executor.startProcess({ processId: "process-real", argv: [process.execPath, "-e", script], cwd: CcaPolicy.toPathUri(root), env: {
    CODEX_APPS_MCP_URL: "ycoding-library://process", CODEX_APPS_AUTHORIZATION: "foreign", CODEX_APPS_ACCOUNT_ID: "foreign", YCODING_SESSION_ID: "ses_foreign",
  } }, context)
  let output = ""
  let cursor = 0
  for (;;) {
    const result = await executor.readProcess({ processId: "process-real", afterSeq: cursor, waitMs: 2000 }, context)
    output += result.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString()).join("")
    cursor = result.nextSeq - 1
    if (result.exited) { expect(result.exitCode).toBe(0); break }
  }
  expect(output).toContain('"tools":["ycoding_library.prepare_uploads"]')
  expect(output).toContain('"accountAbsent":true')
  expect(output).toContain('"owner":"ses_actual_owner"')
  expect(output).not.toMatch(/Bearer [a-f0-9]{64}/)
  expect(owners).toEqual([{ processID: "process-real", cwd: root, readFile: expect.any(Function) }])
  await executor.close()
  expect(closes).toBe(1)
})

test.each([
  { name: "a selected channel without a factory", url: "ycoding-library://process", code: -32603 },
  { name: "an unsupported private marker", url: "ycoding-library://foreign", code: -32602 },
])("%s fails before process spawn without hosted fallback", async ({ url, code }) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-unavailable-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const executor = createCcaExecutor({ scopeFor: async () => ({ sessionID: "ses_actual_owner", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {} }) })
  cleanup.push(() => executor.close())
  const initialized = await executor.initialize({ clientName: "synthetic-library-process" }, { signal: new AbortController().signal })
  await expect(executor.startProcess({ processId: "selected", argv: [process.execPath, "-e", "process.exit(0)"], cwd: CcaPolicy.toPathUri(root), env: { CODEX_APPS_MCP_URL: url } },
    { sessionId: initialized.sessionId, signal: new AbortController().signal })).rejects.toMatchObject({ code })
})

test("an unselected custom HostedApps endpoint keeps its environment and never opens Library", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-unselected-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let opened = 0
  const executor = createCcaExecutor({ scopeFor: async () => ({ sessionID: "ses_actual_owner", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
    library: { open: async () => { opened++; throw new Error("unexpected private route") } },
  }) })
  cleanup.push(() => executor.close())
  const initialized = await executor.initialize({ clientName: "synthetic-library-process" }, { signal: new AbortController().signal })
  const context = { sessionId: initialized.sessionId, signal: new AbortController().signal }
  await executor.startProcess({ processId: "custom", argv: [process.execPath, "-e", "console.log(JSON.stringify([process.env.CODEX_APPS_MCP_URL,process.env.CODEX_APPS_AUTHORIZATION,process.env.CODEX_APPS_ACCOUNT_ID]))"], cwd: CcaPolicy.toPathUri(root), env: {
    CODEX_APPS_MCP_URL: "http://127.0.0.1:1/custom", CODEX_APPS_AUTHORIZATION: "synthetic-custom", CODEX_APPS_ACCOUNT_ID: "synthetic-account",
  } }, context)
  let output = ""
  let cursor = 0
  for (;;) {
    const result = await executor.readProcess({ processId: "custom", afterSeq: cursor, waitMs: 2000 }, context)
    output += result.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString()).join("")
    cursor = result.nextSeq - 1
    if (result.exited) break
  }
  expect(JSON.parse(output.trim())).toEqual(["http://127.0.0.1:1/custom", "synthetic-custom", "synthetic-account"])
  expect(opened).toBe(0)
})

test.each(["private", "unselected"] as const)("the %s process proxy consumer exempts only the selected endpoint and preserves prior exclusions", async (channel) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-proxy-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let opened = 0
  const executor = createCcaExecutor({ scopeFor: async () => ({
    sessionID: "ses_proxy_boundary", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
    library: { open: async () => { opened++; return { tools: [], check: async () => {}, call: async () => ({}), close: async () => {} } } },
  }) })
  cleanup.push(() => executor.close())
  const initialized = await executor.initialize({ clientName: "synthetic-library-proxy" }, { signal: new AbortController().signal })
  const context = { sessionId: initialized.sessionId, signal: new AbortController().signal }
  await executor.startProcess({ processId: "proxy-boundary", cwd: CcaPolicy.toPathUri(root), env: {
    CODEX_APPS_MCP_URL: channel === "private" ? "ycoding-library://process" : "http://127.0.0.1:1/custom",
    NO_PROXY: "kept.invalid:91", HTTP_PROXY: "http://127.0.0.1:1",
  }, argv: [process.env.YCODING_TEST_PYTHON ?? "python3", "-c", `
import json, os, urllib.parse, urllib.request
endpoint = urllib.parse.urlsplit(os.environ['CODEX_APPS_MCP_URL'])
other = endpoint.port + 1 if endpoint.port < 65535 else endpoint.port - 1
print(json.dumps({
  'endpoint': urllib.request.proxy_bypass(endpoint.netloc),
  'other127': urllib.request.proxy_bypass('127.0.0.1:' + str(other)),
  'otherLocalhost': urllib.request.proxy_bypass('localhost:' + str(other)),
  'bare127': urllib.request.proxy_bypass('127.0.0.1'),
  'existing': urllib.request.proxy_bypass('kept.invalid:91'),
  'noProxy': os.environ['NO_PROXY']
}))
  `] }, context)
  let output = ""
  let cursor = 0
  for (;;) {
    const result = await executor.readProcess({ processId: "proxy-boundary", afterSeq: cursor, waitMs: 2000 }, context)
    output += result.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString()).join("")
    cursor = result.nextSeq - 1
    if (result.exited) break
  }
  const result = JSON.parse(output.trim())
  expect(result).toMatchObject({ endpoint: channel === "private", other127: false, otherLocalhost: false, bare127: false, existing: true })
  if (channel === "unselected") expect(result.noProxy).toBe("kept.invalid:91")
  expect(opened).toBe(channel === "private" ? 1 : 0)
})

test.each(["allowed", "sandbox", "permission", "oversized"] as const)("Library source reads respect the actual process %s boundary before native writes", async (boundary) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-read-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "source.txt")
  await writeFile(source, boundary === "oversized" ? Buffer.alloc(20 * 1024 * 1024 + 1) : "abc")
  let nativeWrites = 0
  const executor = createCcaExecutor({ scopeFor: async () => ({
    sessionID: "ses_process_reader", roots: [root],
    authorization: { authorize: async (input) => {
      if (boundary === "permission" && input.action === "read" && input.resources.includes(source)) throw new Error("synthetic denied read")
      return { release: async () => {} }
    } }, close: async () => {},
    library: { open: async (owner) => ({
      tools: [{ name: "ycoding_library.prepare_uploads", inputSchema: { type: "object", properties: {} } }], check: async () => {},
      call: async () => { const data = await owner.readFile(source); nativeWrites++; return { canonical: data.canonical, bytes: data.bytes.length } },
      close: async () => {},
    }) },
  }) })
  cleanup.push(() => executor.close())
  const initialized = await executor.initialize({ clientName: "synthetic-library-process" }, { signal: new AbortController().signal })
  const context = { sessionId: initialized.sessionId, signal: new AbortController().signal }
  const sandbox = { permissions: { type: "managed", file_system: { type: "restricted", entries: [
    { path: { type: "path", path: CcaPolicy.toPathUri(root) }, access: "read" },
    ...(boundary === "sandbox" ? [{ path: { type: "path", path: CcaPolicy.toPathUri(source) }, access: "deny" }] : []),
  ] }, network: "enabled" }, cwd: CcaPolicy.toPathUri(root), workspaceRoots: [CcaPolicy.toPathUri(root)], useLegacyLandlock: false }
  await executor.startProcess({ processId: "reader", cwd: CcaPolicy.toPathUri(root), sandbox, env: { CODEX_APPS_MCP_URL: "ycoding-library://process" }, argv: [process.execPath, "-e", `
    const response=await fetch(process.env.CODEX_APPS_MCP_URL,{method:'POST',headers:{authorization:process.env.CODEX_APPS_AUTHORIZATION,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ycoding_library.prepare_uploads',arguments:{}}})});
    console.log(JSON.stringify((await response.json()).result));
  `] }, context)
  let output = ""
  let cursor = 0
  for (;;) {
    const result = await executor.readProcess({ processId: "reader", afterSeq: cursor, waitMs: 2000 }, context)
    output += result.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString()).join("")
    cursor = result.nextSeq - 1
    if (result.exited) break
  }
  if (boundary === "allowed") {
    expect(JSON.parse(output.trim())).toMatchObject({ structuredContent: { canonical: source, bytes: 3 } })
    expect(nativeWrites).toBe(1)
    return
  }
  expect(JSON.parse(output.trim())).toMatchObject({ isError: true })
  expect(nativeWrites).toBe(0)
})

test("a process policy that disallows private loopback cannot mount Library or fall back", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-network-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let opened = 0
  const executor = createCcaExecutor({ scopeFor: async () => ({
    sessionID: "ses_process_network", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
    library: { open: async () => { opened++; throw new Error("must not mount") } },
  }) })
  cleanup.push(() => executor.close())
  const initialized = await executor.initialize({ clientName: "synthetic-library-process" }, { signal: new AbortController().signal })
  await expect(executor.startProcess({ processId: "network-denied", argv: [process.execPath, "-e", "process.exit(0)"], cwd: CcaPolicy.toPathUri(root), env: { CODEX_APPS_MCP_URL: "ycoding-library://process" },
    enforceManagedNetwork: true, managedNetwork: { loopbackPorts: [], allowLocalBinding: false },
  }, { sessionId: initialized.sessionId, signal: new AbortController().signal })).rejects.toMatchObject({ code: -32001 })
  expect(opened).toBe(0)
})
