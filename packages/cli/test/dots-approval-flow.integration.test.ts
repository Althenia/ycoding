import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { channel, uri } from "../../core/test/fixture/dots-executor"
import {
  dotsApprovalEnvironmentID,
  startDotsApprovalServer,
  type DotsApprovalServer,
} from "./fixture/dots-approval"

type Channel = Awaited<ReturnType<typeof channel>>
type Scope = Awaited<ReturnType<DotsApprovalServer["host"]["threadScope"]>>

interface Attempt {
  readonly elapsedMs: number
  readonly timedOut: boolean
  readonly exitCode?: number | null
  readonly sandboxDenied?: boolean
  readonly stdout: string
  readonly stderr: string
  readonly error?: { readonly code?: unknown; readonly message: string }
}

interface ReviewItem {
  readonly itemID: string
  readonly sessionID: string
  readonly kind: string
  readonly payload: {
    readonly type: string
    readonly action?: string
    readonly resources?: readonly string[]
    readonly hardReview?: boolean
  }
}

interface DecisionItem {
  readonly kind: string
  readonly sessionID: string
  readonly id: string
  readonly decide: readonly { readonly label: string; readonly argv: readonly string[] }[]
}

let server: DotsApprovalServer

beforeAll(async () => {
  server = await startDotsApprovalServer()
}, 60_000)

afterAll(async () => {
  await server?.close()
}, 60_000)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const sandboxFor = () => ({
  permissions: {
    type: "managed",
    file_system: {
      type: "restricted",
      entries: [{ path: { type: "path", path: uri(server.workspace) }, access: "write" }],
    },
    network: "restricted",
  },
  cwd: uri(server.workspace),
  workspaceRoots: [uri(server.workspace)],
  useLegacyLandlock: false,
})

async function setup(threadID: string) {
  const scope = await server.host.threadScope({
    environmentID: dotsApprovalEnvironmentID,
    threadID,
    cwd: server.workspace,
  })
  const opened = await channel(server.host)
  return { scope, opened, sessionID: scope.sessionID, threadID }
}

async function teardown(opened: Channel, scope: Scope) {
  const quiet = async (run: () => Promise<unknown>) => {
    await Promise.race([run().catch(() => undefined), sleep(2_000)])
  }
  await quiet(() => opened.executor.close())
  await quiet(() => scope.close())
}

async function attemptProcess(
  opened: Channel,
  input: { readonly processId: string; readonly script: string; readonly threadID: string; readonly sandbox?: unknown },
): Promise<Attempt> {
  const startedAt = performance.now()
  const starting = opened.executor.startProcess(
    {
      processId: input.processId,
      argv: ["/bin/sh", "-lc", input.script],
      cwd: uri(server.workspace),
      env: {},
      metadata: { threadId: input.threadID, toolCallId: `call-${input.processId}` },
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    },
    opened.ctx,
  )
  starting.catch(() => undefined)
  const started = await Promise.race([
    starting.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    sleep(4_000).then(() => undefined),
  ])
  if (started === undefined)
    return { elapsedMs: performance.now() - startedAt, timedOut: true, stdout: "", stderr: "" }
  if (!started.ok)
    return {
      elapsedMs: performance.now() - startedAt,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: asError(started.error),
    }
  let stdout = ""
  let stderr = ""
  let afterSeq = 0
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await opened.executor.readProcess({ processId: input.processId, afterSeq, waitMs: 250 }, opened.ctx)
    for (const chunk of result.chunks) {
      const text = Buffer.from(chunk.chunk, "base64").toString("utf8")
      if (chunk.stream === "stderr") stderr += text
      else stdout += text
    }
    afterSeq = result.nextSeq - 1
    if (result.closed)
      return {
        elapsedMs: performance.now() - startedAt,
        timedOut: false,
        exitCode: result.exitCode,
        sandboxDenied: result.sandboxDenied,
        stdout,
        stderr,
      }
  }
  return { elapsedMs: performance.now() - startedAt, timedOut: true, stdout, stderr }
}

async function attemptWriteFile(
  opened: Channel,
  input: { readonly target: string; readonly sandbox?: unknown },
) {
  const startedAt = performance.now()
  const writing = opened.executor.writeFile(
    {
      path: uri(input.target),
      dataBase64: Buffer.from("synthetic\n").toString("base64"),
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    },
    opened.ctx,
  )
  writing.catch(() => undefined)
  const settled = await Promise.race([
    writing.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    sleep(4_000).then(() => undefined),
  ])
  if (settled === undefined) return { elapsedMs: performance.now() - startedAt, timedOut: true }
  if (!settled.ok) return { elapsedMs: performance.now() - startedAt, timedOut: false, error: asError(settled.error) }
  return { elapsedMs: performance.now() - startedAt, timedOut: false }
}

function asError(error: unknown): { readonly code?: unknown; readonly message: string } {
  if (error !== null && typeof error === "object") {
    const record = error as { readonly code?: unknown; readonly message?: unknown }
    return { code: record.code, message: typeof record.message === "string" ? record.message : String(error) }
  }
  return { message: String(error) }
}

function decideArgv(sessionID: string, itemID: string, kind: string, reply: string) {
  return `ycoding api session.review.decide --param sessionID=${sessionID} --param itemID=${itemID} -d '{"decision":{"kind":"${kind}","reply":"${reply}"}}'`
}

function openText(input: {
  readonly itemID: string
  readonly sessionID: string
  readonly kind: string
  readonly action: string
  readonly resource: string
  readonly hard?: boolean
}) {
  return [
    "YCoding did not run this: it needs the user's decision.",
    `Review item ${input.itemID} in Session ${input.sessionID}: ${input.kind} ${input.action} ${input.resource}.`,
    "Ask the user in this chat, record the answer, then retry the identical action.",
    ` approve once:   ${decideArgv(input.sessionID, input.itemID, input.kind, "once")}`,
    ...(input.hard ? [] : [` approve always: ${decideArgv(input.sessionID, input.itemID, input.kind, "always")}`]),
    ` reject:         ${decideArgv(input.sessionID, input.itemID, input.kind, "reject")}`,
  ].join("\n")
}

function extractItemID(text: string) {
  return /Review item (\S+) in Session \S+:/.exec(text)?.[1]
}

async function jsonData<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { readonly data: T }
  return body.data
}

async function reviewItems(sessionID: string): Promise<ReviewItem[]> {
  const response = await server.request(`/api/session/${sessionID}/review`)
  const text = await response.clone().text()
  expect(response.status, text).toBe(200)
  return jsonData<ReviewItem[]>(response)
}

async function decide(sessionID: string, itemID: string, kind: string, reply: string) {
  const response = await server.request(`/api/session/${sessionID}/review/${itemID}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: { kind, reply } }),
  })
  expect(response.status, await response.text()).toBe(204)
}

async function setAutonomy(sessionID: string, payload: Record<string, string>) {
  const response = await server.request(`/api/session/${sessionID}/autonomy`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(response.status, await response.text()).toBe(200)
}

async function messageIDs(sessionID: string): Promise<string[]> {
  const response = await server.request(`/api/session/${sessionID}/message`)
  const text = await response.clone().text()
  expect(response.status, text).toBe(200)
  const messages = await jsonData<readonly Record<string, unknown>[]>(response)
  return messages.map((message) => (typeof message.id === "string" ? message.id : JSON.stringify(message)))
}

function expectRefusal(
  attempt: Attempt,
  expected: { readonly sessionID: string; readonly kind: string; readonly action: string; readonly resource: string; readonly hard?: boolean },
) {
  expect(attempt.timedOut, "attempt did not settle within 4s (still waiting for a decision)").toBe(false)
  expect(attempt.elapsedMs).toBeLessThan(2_000)
  expect(attempt.error).toBeUndefined()
  expect(attempt.exitCode).toBe(1)
  expect(attempt.sandboxDenied).toBe(false)
  expect(attempt.stdout).toBe("")
  const itemID = extractItemID(attempt.stderr)
  expect(itemID, `no review item in stderr: ${attempt.stderr}`).toBeDefined()
  expect(attempt.stderr).toBe(`${openText({ ...expected, itemID: itemID! })}\n`)
  return itemID!
}

test("1. manual: process and fs are refused at once with the exact text, nothing runs, items stay open", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-manual")
  try {
    const marker = join(server.workspace, "dots-approval-marker-manual.txt")
    const script = `printf 'x' >> dots-approval-marker-manual.txt`
    const attempt = await attemptProcess(opened, {
      processId: "p-manual-1",
      script,
      threadID,
      sandbox: sandboxFor(),
    })
    const itemID = expectRefusal(attempt, { sessionID, kind: "permission", action: "shell", resource: script })
    expect(existsSync(marker)).toBe(false)
    const items = await reviewItems(sessionID)
    expect(items).toContainEqual(
      expect.objectContaining({
        itemID,
        sessionID,
        kind: "permission",
        payload: expect.objectContaining({ type: "permission", action: "shell", resources: [script] }),
      }),
    )

    const target = join(server.workspace, "dots-approval-marker-manual-fs.txt")
    const write = await attemptWriteFile(opened, { target, sandbox: sandboxFor() })
    expect(write.timedOut, "fs attempt did not settle within 4s (still waiting for a decision)").toBe(false)
    expect(write.elapsedMs).toBeLessThan(2_000)
    expect(write.error?.code).toBe(-32600)
    const fsItemID = extractItemID(write.error?.message ?? "")
    expect(fsItemID, `no review item in fs error: ${write.error?.message}`).toBeDefined()
    expect(write.error?.message).toBe(
      `Permission denied: ${openText({ itemID: fsItemID!, sessionID, kind: "permission", action: "edit", resource: target })}`,
    )
    expect(existsSync(target)).toBe(false)
    expect(await reviewItems(sessionID)).toContainEqual(
      expect.objectContaining({
        itemID: fsItemID,
        kind: "permission",
        payload: expect.objectContaining({ type: "permission", action: "edit", resources: [target] }),
      }),
    )
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

test("2. approve once: the identical retry runs once, a third attempt is refused again", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-once")
  try {
    const marker = join(server.workspace, "dots-approval-marker-once.txt")
    const script = `printf 'x' >> dots-approval-marker-once.txt`
    const first = await attemptProcess(opened, { processId: "p-once-1", script, threadID, sandbox: sandboxFor() })
    const itemID = expectRefusal(first, { sessionID, kind: "permission", action: "shell", resource: script })
    await decide(sessionID, itemID, "permission", "once")

    const retry = await attemptProcess(opened, { processId: "p-once-2", script, threadID })
    expect(retry.timedOut).toBe(false)
    expect(retry.error).toBeUndefined()
    expect(retry.exitCode).toBe(0)
    expect(await readFile(marker, "utf8")).toBe("x")

    const third = await attemptProcess(opened, { processId: "p-once-3", script, threadID })
    const thirdItemID = expectRefusal(third, { sessionID, kind: "permission", action: "shell", resource: script })
    expect(thirdItemID).not.toBe(itemID)
    expect(await readFile(marker, "utf8")).toBe("x")
    expect(await reviewItems(sessionID)).toContainEqual(expect.objectContaining({ itemID: thirdItemID }))
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

test("3. approve always: repeat identical attempts keep passing", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-always")
  try {
    const marker = join(server.workspace, "dots-approval-marker-always.txt")
    const script = `printf 'x' >> dots-approval-marker-always.txt`
    const first = await attemptProcess(opened, { processId: "p-always-1", script, threadID, sandbox: sandboxFor() })
    const itemID = expectRefusal(first, { sessionID, kind: "permission", action: "shell", resource: script })
    await decide(sessionID, itemID, "permission", "always")

    for (const processId of ["p-always-2", "p-always-3"]) {
      const retry = await attemptProcess(opened, { processId, script, threadID })
      expect(retry.timedOut).toBe(false)
      expect(retry.error).toBeUndefined()
      expect(retry.exitCode).toBe(0)
    }
    expect(await readFile(marker, "utf8")).toBe("xx")
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

test("4. reject: the retry stays refused with the rejected text and opens no new item", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-reject")
  try {
    const marker = join(server.workspace, "dots-approval-marker-reject.txt")
    const script = `printf 'x' >> dots-approval-marker-reject.txt`
    const first = await attemptProcess(opened, { processId: "p-reject-1", script, threadID, sandbox: sandboxFor() })
    const itemID = expectRefusal(first, { sessionID, kind: "permission", action: "shell", resource: script })
    await decide(sessionID, itemID, "permission", "reject")
    expect(await reviewItems(sessionID)).toEqual([])

    const retry = await attemptProcess(opened, { processId: "p-reject-2", script, threadID })
    expect(retry.timedOut).toBe(false)
    expect(retry.elapsedMs).toBeLessThan(2_000)
    expect(retry.error).toBeUndefined()
    expect(retry.exitCode).toBe(1)
    expect(retry.sandboxDenied).toBe(false)
    expect(retry.stderr).toBe(
      `YCoding did not run this: the user rejected review item ${itemID}. Do not retry it.\n`,
    )
    expect(existsSync(marker)).toBe(false)
    expect(await reviewItems(sessionID)).toEqual([])
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

test("5. auto mode: a permission ask passes by rule without an item", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-auto")
  try {
    await setAutonomy(sessionID, { permissions: "auto" })
    const marker = join(server.workspace, "dots-approval-marker-auto.txt")
    const script = `printf 'x' >> dots-approval-marker-auto.txt`
    const attempt = await attemptProcess(opened, { processId: "p-auto-1", script, threadID, sandbox: sandboxFor() })
    expect(attempt.timedOut).toBe(false)
    expect(attempt.error).toBeUndefined()
    expect(attempt.exitCode).toBe(0)
    expect(await readFile(marker, "utf8")).toBe("x")
    expect(await reviewItems(sessionID)).toEqual([])
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

test("6. auto mode: a hard guardrail review still refuses with an item and no approve-always line", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-hard")
  try {
    await setAutonomy(sessionID, { permissions: "auto", guardrails: "auto" })
    const script = "git reset --hard"
    const attempt = await attemptProcess(opened, { processId: "p-hard-1", script, threadID, sandbox: sandboxFor() })
    const itemID = expectRefusal(attempt, {
      sessionID,
      kind: "guardrail",
      action: "shell",
      resource: script,
      hard: true,
    })
    expect(attempt.stderr).not.toContain("approve always")
    expect(await reviewItems(sessionID)).toContainEqual(
      expect.objectContaining({
        itemID,
        kind: "guardrail",
        payload: expect.objectContaining({ type: "guardrail", action: "shell", hardReview: true }),
      }),
    )
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

test("7. deciding a Dots item adds no prompt or message to the task Session", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-quiet")
  try {
    const script = `printf 'x' >> dots-approval-marker-quiet.txt`
    const first = await attemptProcess(opened, { processId: "p-quiet-1", script, threadID, sandbox: sandboxFor() })
    const itemID = expectRefusal(first, { sessionID, kind: "permission", action: "shell", resource: script })
    await scope.transcript.flush()
    const before = await messageIDs(sessionID)
    await decide(sessionID, itemID, "permission", "once")
    await scope.transcript.flush()
    expect(await messageIDs(sessionID)).toEqual(before)
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

test("8. every child process receives YCODING_SESSION_ID for the task Session", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-env")
  try {
    const script = `printf '%s' "$YCODING_SESSION_ID"; printf 'x' >> dots-approval-marker-env.txt`
    const first = await attemptProcess(opened, { processId: "p-env-1", script, threadID, sandbox: sandboxFor() })
    const itemID = expectRefusal(first, { sessionID, kind: "permission", action: "shell", resource: script })
    await decide(sessionID, itemID, "permission", "once")

    const retry = await attemptProcess(opened, { processId: "p-env-2", script, threadID })
    expect(retry.timedOut).toBe(false)
    expect(retry.error).toBeUndefined()
    expect(retry.exitCode).toBe(0)
    expect(retry.stdout).toBe(sessionID)
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

test("9. decision.list shows the open item with its decide argv and replaying that argv decides it", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-decision")
  try {
    const marker = join(server.workspace, "dots-approval-marker-decision.txt")
    const script = `printf 'x' >> dots-approval-marker-decision.txt`
    const first = await attemptProcess(opened, { processId: "p-decision-1", script, threadID, sandbox: sandboxFor() })
    const itemID = expectRefusal(first, { sessionID, kind: "permission", action: "shell", resource: script })

    const response = await server.request(`/api/decision`)
    const text = await response.clone().text()
    expect(response.status, text).toBe(200)
    const items = await jsonData<DecisionItem[]>(response)
    const item = items.find((candidate) => candidate.kind === "review" && candidate.id === itemID)
    expect(item, `decision.list did not include review item ${itemID}: ${text}`).toBeDefined()
    expect(item!.sessionID).toBe(sessionID)
    const once = item!.decide.find((option) => option.label === "once")
    expect(once?.argv).toEqual([
      "ycoding",
      "api",
      "session.review.decide",
      "--param",
      `sessionID=${sessionID}`,
      "--param",
      `itemID=${itemID}`,
      "--data",
      JSON.stringify({ decision: { kind: "permission", reply: "once" } }),
    ])

    await replayDecideArgv(once!.argv)

    const retry = await attemptProcess(opened, { processId: "p-decision-2", script, threadID })
    expect(retry.timedOut).toBe(false)
    expect(retry.error).toBeUndefined()
    expect(retry.exitCode).toBe(0)
    expect(await readFile(marker, "utf8")).toBe("x")
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)

async function replayDecideArgv(argv: readonly string[]) {
  expect(argv.slice(0, 2)).toEqual(["ycoding", "api"])
  const operation = argv[2]
  expect(operation).toBe("session.review.decide")
  const params = new Map<string, string>()
  let data: string | undefined
  for (let index = 3; index < argv.length; index++) {
    const flag = argv[index]!
    const value = argv[++index]!
    if (flag === "--param") {
      const separator = value.indexOf("=")
      params.set(value.slice(0, separator), value.slice(separator + 1))
    } else if (flag === "--data" || flag === "-d") data = value
    else if (flag !== "--header" && flag !== "-H") throw new Error(`unsupported decide argv flag: ${flag}`)
  }
  const response = await server.request(
    `/api/session/${params.get("sessionID")}/review/${params.get("itemID")}/decide`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: data,
    },
  )
  expect(response.status, await response.text()).toBe(204)
}

test("10. outside home: a write outside every root is no longer refused outright and runs under the temporary-directory rule", async () => {
  const { scope, opened, sessionID, threadID } = await setup("thread-outside")
  try {
    await attemptProcess(opened, { processId: "p-outside-bind", script: "true", threadID })
    const target = join(server.outside, "note.txt")
    expect(scope.roots.some((root) => target.startsWith(`${root}/`))).toBe(false)
    const write = await attemptWriteFile(opened, { target })
    expect(write.timedOut).toBe(false)
    expect(write.error).toBeUndefined()
    expect(await readFile(target, "utf8")).toBe("synthetic\n")
    expect(await reviewItems(sessionID)).toEqual([])
  } finally {
    await teardown(opened, scope)
  }
}, 30_000)
