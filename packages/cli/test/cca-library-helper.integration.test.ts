import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createCcaExecutor } from "@ycoding-ai/core/cca/executor"
import { CcaExecutorError } from "@ycoding-ai/core/cca/errors"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import { AccountConnectors } from "@ycoding-ai/core/account-connectors"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import type { Integration } from "@ycoding-ai/core/integration"
import { Effect } from "effect"
import { createCcaRpcSession } from "../src/remote-control/cca-executor-rpc"

function fakeLibraryUpstream() {
  const requests: Array<{ method: string; path: string; bytes: Uint8Array }> = []
  let nextID = 0
  let fault: "create" | "completion" | undefined
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url)
    const bytes = new Uint8Array(await request.arrayBuffer())
    requests.push({ method: request.method, path: url.pathname, bytes })
    if (request.method === "POST" && url.pathname === "/files") {
      const id = `file_synthetic_${++nextID}`
      if (fault === "create") return new Response("invalid synthetic create response", { status: 200 })
      return Response.json({ file_id: id, upload_url: `https://synthetic.blob.core.windows.net/${id}?sig=synthetic`,
        upload_headers: { "x-ms-blob-type": "BlockBlob" } })
    }
    if (request.method === "PUT" && url.pathname.startsWith("/file_synthetic_")) return new Response(null, { status: 201 })
    if (request.method === "POST" && url.pathname === "/files/process_upload_stream") {
      if (fault === "completion") return new Response("invalid synthetic completion response", { status: 200 })
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as { file_id: string; file_name: string }
      return new Response([
        JSON.stringify({ event: "file.indexing.completed", file_id: payload.file_id,
          extra: { metadata_object_id: `library_${payload.file_id}`, library_file_name: payload.file_name } }),
        JSON.stringify({ event: "file.processing.completed", file_id: payload.file_id }),
      ].join("\n"))
    }
    return new Response("unexpected synthetic route", { status: 404 })
  } })
  const fetcher: NonNullable<Parameters<typeof AccountConnectors.make>[0]["fetch"]> = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const route = url.pathname.startsWith("/backend-api/") ? url.pathname.slice("/backend-api".length) : url.pathname
    return fetch(new URL(route + url.search, server.url), { method: request.method, headers: request.headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }) })
  }
  return { requests, fetch: fetcher, fault: (next: typeof fault) => { fault = next }, close: () => server.stop(true) }
}

test.each([false, true])("the unchanged HostedAppsClient selects its catalog inside a CCA process (private=%s)", async (privateChannel) => {
  const helper = process.env.YCODING_LIBRARY_HELPER_PATH
  if (!helper) throw new Error("YCODING_LIBRARY_HELPER_PATH must name the supplied library_upload.py")
  const python = process.env.YCODING_TEST_PYTHON
  if (!python) throw new Error("YCODING_TEST_PYTHON must name a Python 3.10+ executable")
  await stat(helper)
  await stat(path.join(path.dirname(helper), "library_hosted_apps.py"))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-helper-")))
  const methods: string[] = []
  let nativeWrites = 0
  const catalog = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as { id: number; method: string }
    methods.push(body.method)
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })
  } })
  const library = {
    open: async () => ({
      check: async () => {},
      tools: [
        { name: "ycoding_library.prepare_uploads", inputSchema: { type: "object" as const }, _meta: { connector_id: "connector_openai_library", connector_name: "YCoding Library bridge" } },
        { name: "ycoding_library.finalize_uploads", inputSchema: { type: "object" as const }, _meta: { connector_id: "connector_openai_library", connector_name: "YCoding Library bridge" } },
      ],
      call: async () => { nativeWrites++; return {} },
      close: async () => {},
    }),
  }
  const executor = createCcaExecutor({
    baseEnv: { HOME: root, CODEX_APPS_MCP_URL: catalog.url.toString(), CODEX_APPS_AUTHORIZATION: "Bearer synthetic-test" },
    scopeFor: async () => ({ sessionID: "ses_synthetic_library", roots: [root], library,
      authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {} }),
  })
  const signal = new AbortController().signal
  try {
    const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
    const script = [
      "import json, pathlib, sys",
      "sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))",
      "from library_hosted_apps import HostedAppsClient, HostedAppsError",
      "client = HostedAppsClient()",
      "results = {}",
      "for name in ('prepare_uploads', 'finalize_uploads'):",
      "  try: results[name] = client._tool('connector_openai_library', name, deadline=None).name",
      "  except HostedAppsError as error: results[name] = str(error)",
      "print(json.dumps(results))",
    ].join("\n")
    await executor.startProcess({ processId: "proc_synthetic_helper", argv: [python, "-c", script, helper], cwd: CcaPolicy.toPathUri(root),
      env: privateChannel ? { CODEX_APPS_MCP_URL: "ycoding-library://process" } : {} }, { sessionId: session.sessionId, signal })
    let afterSeq = 0
    let output = ""
    let stderr = ""
    let closed = false
    for (let count = 0; count < 20 && !closed; count++) {
      const result = await executor.readProcess({ processId: "proc_synthetic_helper", afterSeq, waitMs: 1000 }, { sessionId: session.sessionId, signal })
      output += result.chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => Buffer.from(chunk.chunk, "base64").toString()).join("")
      stderr += result.chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => Buffer.from(chunk.chunk, "base64").toString()).join("")
      afterSeq = result.nextSeq - 1
      closed = result.closed
    }
    expect(closed).toBe(true)
    expect(nativeWrites).toBe(0)
    expect(stderr).toBe("")
    const observed = JSON.parse(output)
    if (privateChannel) {
      expect(observed).toEqual({ prepare_uploads: "ycoding_library.prepare_uploads", finalize_uploads: "ycoding_library.finalize_uploads" })
      expect(methods).toEqual([])
    } else {
      expect(observed).toEqual({ prepare_uploads: "Library prepare_uploads is not available", finalize_uploads: "Library finalize_uploads is not available" })
      expect(methods).toEqual(["tools/list", "tools/list"])
    }
  } finally {
    try { await executor.close() } finally {
      await catalog.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }
})

test.each([
  'printf "%s\\n" "CODEX_APPS_MCP_URL=ycoding-library://process"',
  'export CODEX_APPS_MCP_URL=ycoding-library://process; printf "%s\\n" late',
  '/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process-lookalike /usr/bin/printf "%s\\n" ordinary',
])("command text outside the exact leading selector does not open the private bridge: %s", async (script) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-command-negative-")))
  let opened = 0
  const executor = createCcaExecutor({ scopeFor: async () => ({
    sessionID: "ses_synthetic_library", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) },
    close: async () => {}, library: { open: async () => { opened++; throw new Error("unexpected private channel") } },
  }) })
  try {
    const signal = new AbortController().signal
    const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
    await executor.startProcess({ processId: "negative", argv: ["/bin/sh", "-c", script], cwd: CcaPolicy.toPathUri(root), env: {} },
      { sessionId: session.sessionId, signal })
    let afterSeq = 0
    for (;;) {
      const result = await executor.readProcess({ processId: "negative", afterSeq, waitMs: 1000 }, { sessionId: session.sessionId, signal })
      afterSeq = result.nextSeq - 1
      if (result.closed) { expect(result.exitCode).toBe(0); break }
    }
    expect(opened).toBe(0)
  } finally {
    await executor.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("a leading private selector without a scope factory fails before process spawn", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-command-missing-")))
  const executor = createCcaExecutor({ scopeFor: async () => ({
    sessionID: "ses_synthetic_library", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
  }) })
  try {
    const signal = new AbortController().signal
    const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
    await expect(executor.startProcess({ processId: "missing", argv: ["/bin/sh", "-c", '/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process /usr/bin/true'],
      cwd: CcaPolicy.toPathUri(root), env: {} }, { sessionId: session.sessionId, signal })).rejects.toThrow()
  } finally {
    await executor.close()
    await rm(root, { recursive: true, force: true })
  }
})

test.each(["CODEX_APPS_AUTHORIZATION", "CODEX_APPS_CHATGPT_ACCOUNT_ID", "CODEX_APPS_MCP_URL"])(
  "a reserved assignment after the private selector is rejected before execution: %s", async (key) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-command-reserved-")))
    let opened = 0
    const executor = createCcaExecutor({ baseEnv: { HOME: root, CODEX_APPS_AUTHORIZATION: "Bearer synthetic-test" }, scopeFor: async () => ({
      sessionID: "ses_synthetic_library", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
      library: { open: async () => { opened++; throw new Error("unexpected channel") } },
    }) })
    try {
      const signal = new AbortController().signal
      const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
      await expect(executor.startProcess({ processId: "reserved", argv: ["/bin/sh", "-c", `/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process ${key}=synthetic-foreign /usr/bin/true`],
        cwd: CcaPolicy.toPathUri(root), env: {} }, { sessionId: session.sessionId, signal })).rejects.toThrow()
      expect(opened).toBe(0)
    } finally {
      await executor.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.each(["-i", "-u CODEX_APPS_AUTHORIZATION", "--unset=CODEX_APPS_AUTHORIZATION", "--ignore-environment", "-"])(
  "an env option after the private selector fails before process or factory: %s", async (option) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-command-option-")))
    let opened = 0
    const executor = createCcaExecutor({ baseEnv: { HOME: root, CODEX_APPS_AUTHORIZATION: "Bearer synthetic-test" }, scopeFor: async () => ({
      sessionID: "ses_synthetic_library", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
      library: { open: async () => { opened++; throw new Error("unexpected channel") } },
    }) })
    try {
      const signal = new AbortController().signal
      const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
      await expect(executor.startProcess({ processId: "option", argv: ["/bin/sh", "-c", `/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process ${option} /usr/bin/true`],
        cwd: CcaPolicy.toPathUri(root), env: {} }, { sessionId: session.sessionId, signal })).rejects.toBeInstanceOf(CcaExecutorError)
      expect(opened).toBe(0)
    } finally {
      await executor.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.each(["direct", "zsh"] as const)("private selector rejects option bypass before execution: %s", async (shape) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-option-boundary-")))
  const sentinel = path.join(root, "executed")
  let opened = 0
  const executor = createCcaExecutor({ baseEnv: { HOME: root, CODEX_APPS_AUTHORIZATION: "Bearer synthetic-test" }, scopeFor: async () => ({
    sessionID: "ses_synthetic_library", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
    library: { open: async () => { opened++; throw new Error("unexpected channel") } },
  }) })
  try {
    const signal = new AbortController().signal
    const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
    const argv = shape === "direct"
      ? ["/usr/bin/env", "CODEX_APPS_MCP_URL=ycoding-library://process", "--", "CODEX_APPS_AUTHORIZATION=foreign", "/usr/bin/touch", sentinel]
      : ["/bin/zsh", "-lc", `/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process -i /usr/bin/touch '${sentinel}'`]
    await expect(executor.startProcess({ processId: "option-boundary", argv, cwd: CcaPolicy.toPathUri(root), env: {} },
      { sessionId: session.sessionId, signal })).rejects.toBeInstanceOf(CcaExecutorError)
    expect(opened).toBe(0)
    expect(await stat(sentinel).then(() => true, () => false)).toBe(false)
  } finally {
    await executor.close()
    await rm(root, { recursive: true, force: true })
  }
})

test.each(["direct", "zsh"] as const)("private selector rejects a reserved assignment after a dotted environment name: %s", async (shape) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-dotted-assignment-")))
  const sentinel = path.join(root, "executed")
  let opened = 0
  const executor = createCcaExecutor({ baseEnv: { HOME: root, CODEX_APPS_AUTHORIZATION: "Bearer synthetic-test" }, scopeFor: async () => ({
    sessionID: "ses_synthetic_library", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
    library: { open: async () => { opened++; throw new Error("unexpected channel") } },
  }) })
  try {
    const signal = new AbortController().signal
    const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
    const argv = shape === "direct"
      ? ["/usr/bin/env", "CODEX_APPS_MCP_URL=ycoding-library://process", "fixture.name=x", "CODEX_APPS_AUTHORIZATION=foreign", "/usr/bin/touch", sentinel]
      : ["/bin/zsh", "-lc", `/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process fixture.name=x CODEX_APPS_AUTHORIZATION=foreign /usr/bin/touch '${sentinel}'`]
    await expect(executor.startProcess({ processId: "dotted-assignment", argv, cwd: CcaPolicy.toPathUri(root), env: {} },
      { sessionId: session.sessionId, signal })).rejects.toBeInstanceOf(CcaExecutorError)
    expect(opened).toBe(0)
    expect(await stat(sentinel).then(() => true, () => false)).toBe(false)
  } finally {
    await executor.close()
    await rm(root, { recursive: true, force: true })
  }
})

test.each([
  "FIXTURE=$(printf x)",
  "FIXTURE=`printf x`",
  "FIXTURE=foo\\\nbar",
  "FIXTURE=*",
  "FIXTURE={a,b}",
  "FIXTURE=~",
])("private selector rejects a dynamic initial shell word before the factory: %s", async (word) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-dynamic-word-")))
  const sentinel = path.join(root, "executed")
  let opened = 0
  const executor = createCcaExecutor({ baseEnv: { HOME: root, CODEX_APPS_AUTHORIZATION: "Bearer synthetic-test" }, scopeFor: async () => ({
    sessionID: "ses_synthetic_library", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
    library: { open: async () => { opened++; throw new Error("unexpected channel") } },
  }) })
  try {
    const signal = new AbortController().signal
    const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
    const cmd = `/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process ${word} /usr/bin/touch '${sentinel}'`
    await expect(executor.startProcess({ processId: "dynamic-word", argv: ["/bin/zsh", "-lc", cmd], cwd: CcaPolicy.toPathUri(root), env: {} },
      { sessionId: session.sessionId, signal })).rejects.toBeInstanceOf(CcaExecutorError)
    expect(opened).toBe(0)
    expect(await stat(sentinel).then(() => true, () => false)).toBe(false)
  } finally {
    await executor.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("a selected snapshot cannot replace private endpoint or capability", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-command-snapshot-")))
  await writeFile(path.join(root, ".bash_profile"), 'export CODEX_APPS_MCP_URL=http://127.0.0.1:1/foreign\nexport CODEX_APPS_AUTHORIZATION=synthetic-foreign\n')
  const executor = createCcaExecutor({ baseEnv: { HOME: root, CODEX_APPS_AUTHORIZATION: "Bearer synthetic-test" }, scopeFor: async () => ({
    sessionID: "ses_synthetic_library", roots: [root], authorization: { authorize: async () => ({ release: async () => {} }) }, close: async () => {},
    library: { open: async () => ({ check: async () => {}, tools: [], call: async () => ({}), close: async () => {} }) },
  }) })
  try {
    const signal = new AbortController().signal
    const session = await executor.initialize({ clientName: "synthetic" }, { signal, notify: () => {}, call: async () => ({}) })
    const cmd = "/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process /usr/bin/python3 -c 'import os; print(os.environ.get(\"CODEX_APPS_MCP_URL\",\"\").startswith(\"http://127.0.0.1:\") and os.environ.get(\"CODEX_APPS_MCP_URL\") != \"http://127.0.0.1:1/foreign\" and os.environ.get(\"CODEX_APPS_AUTHORIZATION\",\"\").startswith(\"Bearer \") and os.environ.get(\"CODEX_APPS_AUTHORIZATION\") != \"Bearer synthetic-test\")'"
    const started = await executor.startProcess({ processId: "snapshot", argv: ["/bin/bash", "-lc", cmd], cwd: CcaPolicy.toPathUri(root), env: {},
      shellSnapshot: { scopeId: "synthetic-snapshot", shell: { name: "bash", path: "/bin/bash" } } }, { sessionId: session.sessionId, signal }).then(() => true, () => false)
    if (started) {
      let output = ""
      let afterSeq = 0
      for (;;) {
        const result = await executor.readProcess({ processId: "snapshot", afterSeq, waitMs: 1000 }, { sessionId: session.sessionId, signal })
        output += result.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString()).join("")
        afterSeq = result.nextSeq - 1
        if (result.closed) { expect(result.exitCode).toBe(0); break }
      }
      expect(output.trim()).toBe("True")
    }
  } finally {
    await executor.close()
    await rm(root, { recursive: true, force: true })
  }
})

test.each(["env", "command", "command-snapshot", "command-zsh"] as const)("the unchanged Library upload helper transfers synthetic bytes through the private CCA bridge and returns the real upstream identities (%s fixture)", async (selection) => {
  const helper = process.env.YCODING_LIBRARY_HELPER_PATH
  const python = process.env.YCODING_TEST_PYTHON
  if (!helper || !python) throw new Error("YCODING_LIBRARY_HELPER_PATH and YCODING_TEST_PYTHON are required")
  await stat(helper)
  await stat(path.join(path.dirname(helper), "library_hosted_apps.py"))
  await stat(path.join(path.dirname(helper), "library_file_transfer.py"))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cca-library-upload-")))
  const upstream = fakeLibraryUpstream()
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=", "base64")
  const file = path.join(root, "synthetic.png")
  const requestFile = path.join(root, "request.json")
  if (selection === "command-zsh")
    await writeFile(path.join(root, ".zshenv"), 'export CODEX_APPS_MCP_URL=http://127.0.0.1:1/foreign\nexport CODEX_APPS_AUTHORIZATION=synthetic-foreign\n')
  await writeFile(file, png)
  await writeFile(requestFile, JSON.stringify({ uploads: [{ local_path: file, purpose: "create_library_file" }] }))
  const connection = { id: "cred_synthetic", type: "credential", label: "fixture-profile", active: true }
  let generation = 1
  let access = "synthetic-access"
  let enabled = true
  const integration = {
    get: () => Effect.succeed({ connections: [connection] }),
    connection: { snapshot: () => Effect.succeed({ credential: { accountGeneration: generation },
      value: { type: "oauth", methodID: "chatgpt-browser", access, metadata: { accountID: "fixture-account" } } }) },
  } as unknown as Pick<Integration.Interface, "get" | "connection">
  const actions: Array<{ action: string; guardrailAction?: string }> = []
  const service = AccountConnectors.make({
    integration, directory: root, attachments: AttachmentStore.make(path.join(root, "attachments")),
    settings: () => Effect.succeed({ enabled: true }),
    permission: { assert: () => Effect.void }, guardrail: { assert: () => Effect.succeed({ release: Effect.void }) },
    local: { resolve: (input) => Effect.succeed({ canonical: path.resolve(root, input.path), resource: input.path }) },
    fetch: upstream.fetch,
  })
  const scope = { sessionID: "ses_synthetic_library", roots: [root],
    principal: { profile: "fixture-profile", credentialID: "cred_synthetic", accountID: "fixture-account", accountGeneration: 1, accessRevision: 1 },
    current: async () => { if (!enabled) throw new Error("synthetic access retired") },
    authorize: async (input: { action: string; guardrailAction?: string }) => { actions.push(input); return { release: async () => {} } } }
  let executor: ReturnType<typeof createCcaExecutor> | undefined
  try {
    const library = await Effect.runPromise(service.libraryFactory(scope))
    executor = createCcaExecutor({ baseEnv: { HOME: root, CODEX_APPS_AUTHORIZATION: "Bearer synthetic-test" }, scopeFor: async () => ({ ...scope, library,
      authorization: { authorize: scope.authorize }, close: async () => {} }) })
    const signal = new AbortController().signal
    const rpc = createCcaRpcSession({ handler: executor, environmentInfo: () => ({ shell: { name: "sh", path: "/bin/sh" }, capabilities: {} }) })
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const frames = await rpc.receive(encode({ id: 1, method: "initialize", params: { clientName: "synthetic" } }))
    const session = JSON.parse(new TextDecoder().decode(frames[0]!)).result as { sessionId: string }
    await rpc.receive(encode({ method: "initialized" }))
    const runHelper = async (id: string, uploads: unknown[]) => {
      await writeFile(requestFile, JSON.stringify({ uploads }))
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      const command = `/usr/bin/env CODEX_APPS_MCP_URL=ycoding-library://process ${quote(python)} ${quote(helper)} < ${quote(requestFile)}`
      const execInput = { cmd: command, workdir: root, shell: selection === "command-zsh" ? "/bin/zsh" : selection === "command-snapshot" ? "/bin/bash" : "/bin/sh", login: selection === "command-snapshot" || selection === "command-zsh", tty: false,
        yield_time_ms: 1000, max_output_tokens: 4000, sandbox_permissions: "use_default", justification: "synthetic", prefix_rule: [] }
      const argv = selection === "env"
        ? ["/bin/sh", "-c", `exec ${quote(python)} ${quote(helper)} < ${quote(requestFile)}`]
        : [execInput.shell, execInput.login ? "-lc" : "-c", execInput.cmd]
      expect(argv).toHaveLength(3)
      expect(Object.hasOwn(execInput, "env")).toBe(false)
      const response = await rpc.receive(encode({ id, method: "process/start", params: {
        processId: id, argv,
        cwd: CcaPolicy.toPathUri(root), env: selection === "env" ? { CODEX_APPS_MCP_URL: "ycoding-library://process" } : {}, tty: false,
        ...(selection === "command-snapshot" ? { shellSnapshot: { scopeId: "synthetic-snapshot", shell: { name: "bash", path: "/bin/bash" } } } : {}),
      } }))
      expect(JSON.parse(new TextDecoder().decode(response[0]!))).toMatchObject({ id, result: { processId: id } })
      let afterSeq = 0
      let stdout = ""
      let stderr = ""
      let closed = false
      let exitCode: number | null | undefined
      for (let count = 0; count < 20 && !closed; count++) {
        const result = await executor!.readProcess({ processId: id, afterSeq, waitMs: 1000 }, { sessionId: session.sessionId, signal })
        for (const chunk of result.chunks) {
          const text = Buffer.from(chunk.chunk, "base64").toString()
          if (chunk.stream === "stdout") stdout += text
          if (chunk.stream === "stderr") stderr += text
        }
        afterSeq = result.nextSeq - 1
        closed = result.closed
        exitCode = result.exitCode
      }
      return { stdout, stderr, closed, exitCode }
    }
    const { stdout, stderr, closed, exitCode } = await runHelper("proc_upload", [{ local_path: file, purpose: "create_library_file" }])
    expect(closed).toBe(true)
    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 })
    expect(stdout + stderr).not.toContain("synthetic-foreign")
    expect(stdout + stderr).not.toMatch(/Bearer [a-f0-9]{64}/)
    expect(JSON.parse(stdout)).toMatchObject({ results: [{ local_path: file, purpose: "create_library_file", status: "succeeded",
      file_id: "file_synthetic_1", library_file_id: "library_file_synthetic_1", file_name: "synthetic.png", local_metadata_applied: true }] })
    const prefix = "__OPENAI_LIBRARY_FILE_WRITE_RECEIPT_V1__="
    const receipt = stderr.split("\n").find((line) => line.startsWith(prefix))
    expect(receipt).toBeDefined()
    expect(JSON.parse(receipt!.slice(prefix.length))).toEqual({ sandbox_path: file, file_id: "file_synthetic_1", library_file_id: "library_file_synthetic_1" })
    const xattr = Bun.spawn(["/usr/bin/xattr", "-px", "user.library-file-id", file], { stdout: "pipe", stderr: "pipe" })
    const [hex, xattrError, xattrExit] = await Promise.all([new Response(xattr.stdout).text(), new Response(xattr.stderr).text(), xattr.exited])
    expect(xattrExit).toBe(0)
    expect(xattrError).toBe("")
    expect(Buffer.from(hex.replaceAll(/\s/g, ""), "hex").toString()).toBe("library_file_synthetic_1")
    expect(upstream.requests.map((item) => [item.method, item.path])).toEqual([
      ["POST", "/files"], ["PUT", "/file_synthetic_1"], ["POST", "/files/process_upload_stream"],
    ])
    expect(JSON.parse(new TextDecoder().decode(upstream.requests[0].bytes))).toMatchObject({
      file_name: "synthetic.png", file_size: png.length, mime_type: "image/png", store_in_library: true,
    })
    expect(JSON.parse(new TextDecoder().decode(upstream.requests[2].bytes))).toMatchObject({
      file_id: "file_synthetic_1", file_name: "synthetic.png", mime_type: "image/png", index_for_retrieval: true,
    })
    expect(Buffer.from(upstream.requests[1].bytes).equals(png)).toBe(true)
    expect(actions.some((input) => input.action === "read")).toBe(true)
    expect(actions).toContainEqual(expect.objectContaining({ action: "chatgpt_library_upload", guardrailAction: "mcp_execute" }))
    const another = path.join(root, "second.png")
    await writeFile(another, png)
    const second = await runHelper("proc_upload_second", [{ local_path: another, purpose: "create_library_file" }])
    expect(second.closed).toBe(true)
    expect(second.exitCode).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({ results: [{ local_path: another, purpose: "create_library_file", status: "succeeded",
      file_id: "file_synthetic_2", library_file_id: "library_file_synthetic_2", file_name: "second.png" }] })
    expect(second.stderr).toContain(prefix)
    expect(upstream.requests.map((item) => [item.method, item.path])).toEqual([
      ["POST", "/files"], ["PUT", "/file_synthetic_1"], ["POST", "/files/process_upload_stream"],
      ["POST", "/files"], ["PUT", "/file_synthetic_2"], ["POST", "/files/process_upload_stream"],
    ])
    expect(Buffer.from(upstream.requests[4].bytes).equals(png)).toBe(true)
    const unsupported = [
      [{ local_path: file, purpose: "create_library_file" }, { local_path: another, purpose: "create_library_file" }],
      [{ local_path: another, purpose: "replace_library_file", library_file_id: "library_synthetic" }],
      [{ local_path: another, purpose: "replace_library_file", library_file_id: "library_synthetic", is_shared: true, expected_current_version: 1 }],
    ]
    for (const [index, uploads] of unsupported.entries()) {
      const result = await runHelper(`proc_unsupported_${index}`, uploads)
      expect(result.closed).toBe(true)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("library upload failed:")
      expect(upstream.requests).toHaveLength(6)
    }
    upstream.fault("create")
    const createUnknown = await runHelper("proc_create_unknown", [{ local_path: another, purpose: "create_library_file" }])
    expect(createUnknown.closed).toBe(true)
    expect(createUnknown.exitCode).not.toBe(0)
    expect(upstream.requests.slice(6).map((item) => [item.method, item.path])).toEqual([["POST", "/files"]])
    upstream.fault("completion")
    const finishUnknown = await runHelper("proc_finish_unknown", [{ local_path: another, purpose: "create_library_file" }])
    expect(finishUnknown.closed).toBe(true)
    expect(finishUnknown.exitCode).not.toBe(0)
    expect(upstream.requests.slice(7).map((item) => [item.method, item.path])).toEqual([
      ["POST", "/files"], ["PUT", "/file_synthetic_4"], ["POST", "/files/process_upload_stream"],
    ])
    upstream.fault(undefined)
    const third = path.join(root, "third.png")
    await writeFile(third, png)
    const readSource = async (requested: string) => {
      const canonical = await realpath(requested)
      return { canonical, bytes: await readFile(canonical) }
    }
    const firstProcess = await library.open({ processID: "proc_bound_a", cwd: root, readFile: readSource })
    const otherProcess = await library.open({ processID: "proc_bound_b", cwd: root, readFile: readSource })
    try {
      const prepared = await firstProcess.call("ycoding_library.prepare_uploads", { uploads: [{ file_name: "third.png",
        purpose: "create_library_file", file_size_bytes: png.length, workspace_path: third, mime_type: "image/png" }] }) as { uploads: Array<Record<string, unknown>> }
      expect(prepared.uploads).toHaveLength(1)
      expect(prepared.uploads[0]).toMatchObject({ file_id: "file_synthetic_5", workspace_path: third, purpose: "create_library_file" })
      const item = prepared.uploads[0]
      await expect(otherProcess.call("ycoding_library.finalize_uploads", { uploads: [item] })).rejects.toThrow()
      expect(upstream.requests.filter((request) => request.path === "/files/process_upload_stream")).toHaveLength(3)
      const finalized = await firstProcess.call("ycoding_library.finalize_uploads", { uploads: [item] })
      expect(finalized).toMatchObject({ results: [{ status: "succeeded", operation: "create_library_file",
        file_id: "file_synthetic_5", library_file_id: "library_file_synthetic_5" }] })
      const duplicate = await firstProcess.call("ycoding_library.finalize_uploads", { uploads: [item] }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      if ("value" in duplicate) expect(duplicate.value).toEqual(finalized)
      else expect(duplicate.error).toBeInstanceOf(Error)
      expect(upstream.requests.filter((request) => request.path === "/files/process_upload_stream")).toHaveLength(4)
      const guarded = await otherProcess.call("ycoding_library.prepare_uploads", { uploads: [{ file_name: "third.png",
        purpose: "create_library_file", file_size_bytes: png.length, workspace_path: third, mime_type: "image/png" }] }) as { uploads: Array<Record<string, unknown>> }
      const guardedItem = guarded.uploads[0]
      await expect(otherProcess.call("ycoding_library.finalize_uploads", { uploads: [{ ...guardedItem, workspace_path: another }] })).rejects.toThrow()
      await expect(otherProcess.call("ycoding_library.finalize_uploads", { uploads: [guardedItem] })).rejects.toThrow()
      expect(upstream.requests.filter((request) => request.path === "/files/process_upload_stream")).toHaveLength(4)
      const beforeDirectory = upstream.requests.length
      await expect(firstProcess.call("ycoding_library.prepare_uploads", { uploads: [{ file_name: "third.png",
        purpose: "create_library_file", file_size_bytes: png.length, workspace_path: third, mime_type: "image/png",
        directory_id: "dir_synthetic" }] })).rejects.toThrow()
      expect(upstream.requests).toHaveLength(beforeDirectory)
      access = "synthetic-refreshed"
      await firstProcess.check()
      generation = 2
      await expect(firstProcess.check()).rejects.toThrow()
      generation = 1
      enabled = false
      await expect(firstProcess.check()).rejects.toThrow()
      await expect(library.open({ processID: "proc_retired", cwd: root, readFile: readSource })).rejects.toThrow()
      expect(upstream.requests.filter((request) => request.path === "/files/process_upload_stream")).toHaveLength(4)
    } finally {
      await firstProcess.close()
      await otherProcess.close()
    }
    enabled = true
    const beforeDirectory = upstream.requests.length
    const directory = await runHelper("proc_directory", [{ local_path: another, purpose: "create_library_file", directory_id: "dir_synthetic" }])
    expect(directory.closed).toBe(true)
    expect(directory.exitCode).not.toBe(0)
    expect(directory.stderr).toContain("library upload failed:")
    expect(directory.stderr).not.toContain(prefix)
    expect(upstream.requests.slice(beforeDirectory).map((item) => [item.method, item.path])).toEqual([
      ["POST", "/files"], ["PUT", "/file_synthetic_7"],
    ])
  } finally {
    try { await executor?.close() } finally {
      await upstream.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}, 30_000)
