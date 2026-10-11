import { expect, test } from "bun:test"
import type { SessionPendingUser, YCodingEvent } from "@ycoding-ai/client"
import { createPromptSubmissions, type PromptSubmissionPayload } from "../../src/prompt/submission"
import { retainSessionSubmission } from "../../src/util/session-autonomy"
import { emptyPrompt } from "../../src/prompt/history"
import { createApi, createFetch, json, type FetchHandler } from "../fixture/tui-client"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

async function until(predicate: () => boolean) {
  for (let count = 0; count < 1000; count++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Expected submission transition did not occur")
}

function submission(sessionID = "ses_submission", text = "$review check", skills = true) {
  const payload: PromptSubmissionPayload = {
    inputText: text,
    mode: "normal",
    agentID: "build",
    model: { providerID: "openai", id: "fixture" },
    modelSelectionPending: false,
    files: [],
    agents: [],
    metadata: skills ? { skills: [{ id: "review", name: "Review" }] } : undefined,
    history: { ...emptyPrompt(), text },
    cursor: text.length,
  }
  return retainSessionSubmission(undefined, text, 0, payload, sessionID)
}

function pending(item: ReturnType<typeof submission>): SessionPendingUser {
  return {
    id: item.promptID,
    sessionID: item.sessionID,
    admittedSeq: 1,
    timeCreated: 1,
    type: "user",
    data: { text: item.payload.inputText },
    delivery: "steer",
  }
}

function admitted(item: ReturnType<typeof submission>): YCodingEvent {
  return {
    id: "evt_admission",
    type: "session.input.admitted",
    created: 1,
    durable: { aggregateID: item.sessionID, seq: 1, version: 1 },
    data: {
      sessionID: item.sessionID,
      inputID: item.promptID,
      input: { type: "user", data: { text: item.payload.inputText }, delivery: "steer" },
    },
  }
}

function fixture(route: FetchHandler, promptAdmitted?: (durationMs: number) => void) {
  const requests: Array<{ path: string; body: { id?: string; resume?: boolean; skill?: string } }> = []
  const calls = createFetch(async (url, request) => {
    const body = request.method === "POST" ? ((await request.clone().json()) as { id?: string; resume?: boolean }) : {}
    requests.push({ path: url.pathname, body })
    const response = await route(url, request)
    if (response) return response
    if (/\/api\/session\/[^/]+$/.test(url.pathname))
      return json({ data: { agent: "build", model: { providerID: "openai", id: "fixture" } } })
    if (url.pathname.endsWith("/skill")) return new Response(null, { status: 204 })
    return undefined
  })
  const receipts: SessionPendingUser[] = []
  const manager = createPromptSubmissions({
    api: () => createApi(calls.fetch),
    promptAdmitted,
    admitted: (receipt) => {
      if (receipt.type === "user") receipts.push(receipt)
    },
  })
  const dispatch = (item: ReturnType<typeof submission>) =>
    manager.dispatch(item, { location: { directory: "/tmp/ycoding/submission" }, cleanup: async () => {} })
  return { requests, receipts, manager, dispatch }
}

test("prompt admission timing is emitted only after the durable admission response", async () => {
  const item = submission("ses_admission_timing", "measure admission", false)
  const gate = deferred<void>()
  const started = deferred<void>()
  const durations: number[] = []
  const flow = fixture(async (url, request) => {
    if (!url.pathname.endsWith("/prompt")) return
    const body = (await request.json()) as { resume?: boolean }
    if (!body.resume) {
      started.resolve()
      await gate.promise
    }
    return json({ data: pending(item) })
  }, (durationMs) => durations.push(durationMs))
  try {
    flow.dispatch(item)
    await started.promise
    expect(durations).toEqual([])
    gate.resolve()
    await until(() => flow.manager.list().length === 0)
    expect(durations).toHaveLength(1)
    expect(durations[0]).toBeGreaterThanOrEqual(0)
  } finally {
    gate.resolve()
    flow.manager.dispose()
  }
})

test("a correlated admission event settles the owned request before its HTTP response without skill RPCs", async () => {
  const item = submission()
  const skill = deferred<void>()
  const started = deferred<void>()
  const flow = fixture(async (url) => {
    if (url.pathname.endsWith("/prompt")) {
      if (flow.requests.at(-1)?.body.resume) return json({ data: pending(item) })
      started.resolve()
      await skill.promise
      return json({ data: pending(item) })
    }
    if (url.pathname.endsWith("/prompt")) return json({ data: pending(item) })
  })
  try {
    flow.dispatch(item)
    await started.promise
    expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1)
    flow.manager.observe(admitted(submission("ses_unrelated")))
    expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1)
    flow.manager.observe(admitted(item))
    await until(() => flow.manager.list().length === 0)
    expect(flow.requests.filter((request) => request.path.endsWith("/skill"))).toHaveLength(0)
    expect(
      flow.requests.filter((request) => request.path.endsWith("/prompt")).map((request) => request.body.resume),
    ).toEqual([false, true])
  } finally {
    skill.resolve()
    flow.manager.dispose()
  }
})

test("a failed standalone skill remains owned and retries its stable ID without admitting a prompt", async () => {
  const item = submission()
  item.skillIDs = ["msg_standalone"]
  let failed = true
  const flow = fixture(async (url) => {
    if (url.pathname.endsWith("/skill") && failed) return json({ message: "unknown outcome" }, { status: 500 })
    if (url.pathname.endsWith("/prompt")) return json({ data: pending(item) })
  })
  try {
    flow.manager.dispatch(item, {
      location: { directory: "/tmp/ycoding/submission" },
      skillOnly: "review",
      cleanup: async () => {},
    })
    await until(() => flow.manager.list()[0]?.state === "attention")
    expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(0)
    failed = false
    flow.manager.retry(item.sessionID, item.promptID)
    await until(() => flow.manager.list().length === 0)
    expect(
      flow.requests.filter((request) => request.path.endsWith("/skill")).map((request) => request.body.id),
    ).toEqual([item.skillIDs[0], item.skillIDs[0]])
    expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(0)
  } finally {
    flow.manager.dispose()
  }
})

test.each([
  [
    409,
    { _tag: "ConflictError", message: "Prompt message ID conflicts with an existing durable record" },
    "Prompt ID conflict · Retry send",
  ],
  [
    400,
    { _tag: "InvalidRequestError", field: "files", message: "Attachment exceeds the 20 MiB limit" },
    "Attachment rejected · Retry send",
  ],
  [503, { _tag: "ServiceUnavailableError", message: "upstream unavailable" }, "Sending prompt unresolved · Retry send"],
] as const)("admission status %i preserves a distinct recovery outcome", async (status, body, phase) => {
  const item = submission()
  const flow = fixture(async (url) => (url.pathname.endsWith("/prompt") ? json(body, { status }) : undefined))
  try {
    flow.dispatch(item)
    await until(() => flow.manager.list()[0]?.state === "attention")
    expect(flow.manager.list()[0]?.phase).toBe(phase)
    expect(flow.manager.list()[0]?.error).toBe(status === 503 ? "UnexpectedStatus" : body.message)
    expect(flow.manager.list()[0]?.input.promptID).toBe(item.promptID)
    expect(flow.manager.list()[0]?.input.payload.inputText).toBe(item.payload.inputText)
    expect(flow.receipts).toHaveLength(0)
    expect(
      flow.requests.filter((request) => request.path.endsWith("/prompt")).map((request) => request.body.resume),
    ).toEqual([false])
  } finally {
    flow.manager.dispose()
  }
})

test("model switch failure pauses only its Session and prevents accidental admission or wake", async () => {
  const first = submission("ses_model", "model first", false)
  first.payload.modelSelectionPending = true
  first.payload.model.id = "selected"
  const second = submission("ses_model", "model second", false)
  const independent = submission("ses_independent", "independent", false)
  let failed = true
  const flow = fixture(async (url, request) => {
    if (url.pathname.endsWith("/model"))
      return failed ? json({ message: "blocked" }, { status: 409 }) : new Response(null, { status: 204 })
    if (url.pathname.endsWith("/prompt")) {
      const body = (await request.json()) as { id: string }
      return json({ data: pending([first, second, independent].find((item) => item.promptID === body.id)!) })
    }
  })
  try {
    flow.dispatch(first)
    flow.dispatch(second)
    flow.dispatch(independent)
    await until(
      () =>
        flow.manager.list(first.sessionID)[0]?.state === "attention" &&
        flow.manager.list(independent.sessionID).length === 0,
    )
    expect(flow.requests.filter((request) => request.path === `/api/session/${first.sessionID}/prompt`)).toHaveLength(0)
    expect(flow.manager.list(first.sessionID).map((entry) => entry.input.promptID)).toEqual([
      first.promptID,
      second.promptID,
    ])
    failed = false
    flow.manager.retry(first.sessionID, first.promptID)
    await until(() => flow.manager.list().length === 0)
    expect(
      flow.requests
        .filter((request) => request.path === `/api/session/${first.sessionID}/prompt`)
        .map((request) => request.body.id),
    ).toEqual([first.promptID, first.promptID, second.promptID, second.promptID])
  } finally {
    flow.manager.dispose()
  }
})

test("explicitly reselecting the same named profile rebinds it before prompt admission", async () => {
  const item = submission("ses_profile_rebind", "reselect profile", false)
  item.payload.modelSelectionPending = true
  item.payload.model = { providerID: "openai", id: "fixture", profile: "Work" }
  const switches: Array<{ sessionID: string; model: { providerID: string; id: string; variant?: string; profile?: string } }> = []
  const flow = fixture(async (url, request) => {
    if (url.pathname === `/api/session/${item.sessionID}/model`) {
      const body = await request.json() as { model: { providerID: string; id: string; variant?: string; profile?: string } }
      switches.push({ sessionID: item.sessionID, model: body.model })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === `/api/session/${item.sessionID}`)
      return json({ data: { agent: "build", model: { providerID: "openai", id: "fixture", profile: "Work" } } })
    if (url.pathname.endsWith("/prompt")) return json({ data: pending(item) })
  })
  try {
    flow.dispatch(item)
    await until(() => flow.manager.list().length === 0)
    expect(switches).toEqual([{ sessionID: item.sessionID, model: { providerID: "openai", id: "fixture", profile: "Work" } }])
    expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(2)
    expect(flow.requests.findIndex((request) => request.path === `/api/session/${item.sessionID}/model`))
      .toBeLessThan(flow.requests.findIndex((request) => request.path.endsWith("/prompt")))
  } finally {
    flow.manager.dispose()
  }
})

test("late admission reconciles an unknown response, and retry after failed wake never reactivates or readmits", async () => {
  const item = submission()
  let failWake = true
  const flow = fixture(async (url, request) => {
    if (!url.pathname.endsWith("/prompt")) return
    const body = (await request.json()) as { resume: boolean }
    if (!body.resume || failWake) return json({ message: "lost outcome" }, { status: 500 })
    return json({ data: pending(item) })
  })
  try {
    flow.dispatch(item)
    await until(() => flow.manager.list()[0]?.state === "attention")
    flow.manager.observe(admitted(item))
    await until(
      () =>
        flow.requests.filter((request) => request.path.endsWith("/prompt")).length === 2 &&
        flow.manager.list()[0]?.state === "attention",
    )
    flow.manager.reconcile(item.sessionID, [], [pending(item)])
    expect(flow.manager.list()[0]?.state).toBe("attention")
    expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(2)
    failWake = false
    flow.manager.retry(item.sessionID, item.promptID)
    await until(() => flow.manager.list().length === 0)
    expect(flow.requests.filter((request) => request.path.endsWith("/skill"))).toHaveLength(0)
    expect(
      flow.requests.filter((request) => request.path.endsWith("/prompt")).map((request) => request.body.resume),
    ).toEqual([false, true, true])
    expect(
      new Set(flow.requests.filter((request) => request.path.endsWith("/prompt")).map((request) => request.body.id))
        .size,
    ).toBe(1)
  } finally {
    flow.manager.dispose()
  }
})

test("reconnect pending snapshot resolves admission without replay; consumed snapshot requires no wake", async () => {
  const item = submission("ses_reconnect", "recover", false)
  const flow = fixture(async (url) =>
    url.pathname.endsWith("/prompt") ? json({ message: "lost outcome" }, { status: 500 }) : undefined,
  )
  try {
    flow.dispatch(item)
    await until(() => flow.manager.list()[0]?.state === "attention")
    flow.manager.reconcile(item.sessionID, [], [pending(item)])
    await until(
      () =>
        flow.requests.filter((request) => request.path.endsWith("/prompt")).length === 2 &&
        flow.manager.list()[0]?.state === "attention",
    )
    flow.manager.reconcile(
      item.sessionID,
      [{ id: item.promptID, type: "user", text: item.payload.inputText, time: { created: 1, consumed: 2 } }],
      [],
    )
    await until(() => flow.manager.list().length === 0)
    expect(flow.manager.list()).toHaveLength(0)
    expect(
      flow.requests.filter((request) => request.path.endsWith("/prompt")).map((request) => request.body.resume),
    ).toEqual([false, true])
  } finally {
    flow.manager.dispose()
  }
})

test("agent reselection on retry preserves prompt identity without client skill activation", async () => {
  const item = submission()
  let agent = "build"
  let reject = true
  const flow = fixture(async (url, request) => {
    if (/\/api\/session\/[^/]+$/.test(url.pathname)) return json({ data: { agent } })
    if (url.pathname.endsWith("/agent")) {
      agent = "build"
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith("/prompt"))
      return reject ? json({ message: "lost outcome" }, { status: 500 }) : json({ data: pending(item) })
    return undefined
  })
  try {
    flow.dispatch(item)
    await until(() => flow.manager.list()[0]?.state === "attention")
    agent = "other"
    reject = false
    flow.manager.retry(item.sessionID, item.promptID)
    await until(() => flow.manager.list().length === 0)
    const skillIDs = flow.requests
      .filter((request) => request.path.endsWith("/skill"))
      .map((request) => request.body.id)
    expect(skillIDs).toHaveLength(0)
    expect(
      new Set(flow.requests.filter((request) => request.path.endsWith("/prompt")).map((request) => request.body.id))
        .size,
    ).toBe(1)
    expect(flow.requests.map((request) => request.path.split("/").at(-1))).toEqual([
      item.sessionID,
      "prompt",
      item.sessionID,
      "agent",
      "prompt",
      "prompt",
    ])
  } finally {
    flow.manager.dispose()
  }
})

test("managed attachments survive a failed wake without replaying admission or repeating cleanup", async () => {
  const item = submission("ses_attachments", "attached", false)
  item.payload.files = [{ uri: "file:///tmp/ycoding/clipboard.png", name: "clipboard.png" }]
  const digest = "a".repeat(64)
  const receipt: SessionPendingUser = {
    ...pending(item),
    data: {
      text: item.payload.inputText,
      files: [
        {
          mime: "image/png",
          name: "clipboard.png",
          content: { type: "managed", digest, bytes: 1, path: `attachments/sha256/aa/${digest}` },
        },
      ],
    },
  }
  let failed = true
  let cleanups = 0
  const requests: Array<{ id: string; files: Array<{ uri: string }>; resume: boolean }> = []
  const flow = fixture(async (url, request) => {
    if (!url.pathname.endsWith("/prompt")) return undefined
    const body = (await request.json()) as { id: string; files: Array<{ uri: string }>; resume: boolean }
    requests.push(body)
    if (body.resume && failed) return json({ message: "lost wake" }, { status: 500 })
    return json({ data: receipt })
  })
  try {
    flow.manager.dispatch(item, {
      location: { directory: "/tmp/ycoding/submission" },
      cleanup: async () => {
        cleanups++
      },
    })
    await until(() => flow.manager.list()[0]?.state === "attention")
    expect(cleanups).toBe(1)
    expect(requests[0].files[0].uri).toBe("file:///tmp/ycoding/clipboard.png")
    expect(requests[1].files[0].uri).toBe(`ycoding-attachment://sha256/${digest}`)
    failed = false
    flow.manager.retry(item.sessionID, item.promptID)
    await until(() => flow.manager.list().length === 0)
    expect(cleanups).toBe(1)
    expect(requests.map((request) => request.resume)).toEqual([false, true, true])
    expect(requests[2].files[0].uri).toBe(`ycoding-attachment://sha256/${digest}`)
    expect(new Set(requests.map((request) => request.id)).size).toBe(1)
  } finally {
    flow.manager.dispose()
  }
})

test("consumed snapshot retires a still-pending admission despite a later failure and releases the next send", async () => {
  const first = submission("ses_consumed_race", "consumed first", false)
  const second = submission("ses_consumed_race", "queued second", false)
  const gate = deferred<void>()
  const started = deferred<void>()
  let cleanups = 0
  const flow = fixture(async (url, request) => {
    if (!url.pathname.endsWith("/prompt")) return undefined
    const body = (await request.json()) as { id: string; resume: boolean }
    if (body.id === first.promptID) {
      started.resolve()
      await gate.promise
      return json({ message: "late admission failure" }, { status: 500 })
    }
    return json({ data: pending(second) })
  })
  try {
    flow.manager.dispatch(first, {
      location: { directory: "/tmp/ycoding/submission" },
      cleanup: async () => {
        cleanups++
      },
    })
    flow.dispatch(second)
    await started.promise
    flow.manager.reconcile(
      first.sessionID,
      [{ id: first.promptID, type: "user", text: first.payload.inputText, time: { created: 1, consumed: 2 } }],
      [],
    )
    gate.resolve()
    await until(() => flow.manager.list().length === 0 || flow.manager.list()[0]?.state === "attention")
    expect(flow.manager.list()).toHaveLength(0)
    expect(cleanups).toBe(1)
    expect(flow.requests.filter((request) => request.path.endsWith("/prompt")).map((request) => request.body)).toEqual([
      expect.objectContaining({ id: first.promptID, resume: false }),
      expect.objectContaining({ id: second.promptID, resume: false }),
      expect.objectContaining({ id: second.promptID, resume: true }),
    ])
  } finally {
    gate.resolve()
    flow.manager.dispose()
  }
})

test.each([true, false])("pre-admission retry restores the chosen unprofiled model only when it drifted: %s", async (drifted) => {
  const item = submission("ses_model_drift", "selected model", false)
  item.payload.modelSelectionPending = true
  item.payload.editor = { key: "selection", text: "editor context" }
  let model = { providerID: "openai", id: "original" }
  let rejectEditor = true
  let switches = 0
  const flow = fixture(async (url) => {
    if (/\/api\/session\/[^/]+$/.test(url.pathname)) return json({ data: { agent: "build", model } })
    if (url.pathname.endsWith("/model")) {
      switches++
      model = item.payload.model
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith("/synthetic"))
      return rejectEditor
        ? json({ message: "editor rejected" }, { status: 500 })
        : json({ data: { id: item.syntheticID } })
    if (url.pathname.endsWith("/prompt")) {
      expect(model).toEqual(item.payload.model)
      return json({ data: pending(item) })
    }
    return undefined
  })
  try {
    flow.dispatch(item)
    await until(() => flow.manager.list()[0]?.state === "attention")
    expect(switches).toBe(1)
    rejectEditor = false
    if (drifted) model = { providerID: "openai", id: "outside-selection" }
    flow.manager.retry(item.sessionID, item.promptID)
    await until(() => flow.manager.list().length === 0 || flow.manager.list()[0]?.state === "attention")
    expect(flow.manager.list()).toHaveLength(0)
    expect(switches).toBe(drifted ? 2 : 1)
  } finally {
    flow.manager.dispose()
  }
})

test.each([true, false])("named-profile retry does not rebind after success and rejects a changed Session model: %s", async (drifted) => {
  const item = submission("ses_profile_retry", "selected profile", false)
  item.payload.modelSelectionPending = true
  item.payload.model = { ...item.payload.model, profile: "Work" }
  item.payload.editor = { key: "selection", text: "editor context" }
  let model: { providerID: string; id: string; variant?: string; profile?: string } = { providerID: "openai", id: "original" }
  let rejectEditor = true
  let switches = 0
  const flow = fixture(async (url) => {
    if (/\/api\/session\/[^/]+$/.test(url.pathname)) return json({ data: { agent: "build", model } })
    if (url.pathname.endsWith("/model")) {
      switches++
      model = item.payload.model
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith("/synthetic"))
      return rejectEditor
        ? json({ message: "editor rejected" }, { status: 500 })
        : json({ data: { id: item.syntheticID } })
    if (url.pathname.endsWith("/prompt")) return json({ data: pending(item) })
    return undefined
  })
  try {
    flow.dispatch(item)
    await until(() => flow.manager.list()[0]?.state === "attention")
    expect(switches).toBe(1)
    rejectEditor = false
    if (drifted) model = { ...item.payload.model, profile: "Personal" }
    flow.manager.retry(item.sessionID, item.promptID)
    await until(() => flow.manager.list().length === 0 || flow.manager.list()[0]?.state === "attention")
    expect(switches).toBe(1)
    if (drifted) {
      expect(flow.manager.list()[0]?.state).toBe("attention")
      expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toEqual([])
    } else {
      expect(flow.manager.list()).toHaveLength(0)
      expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(2)
    }
  } finally {
    flow.manager.dispose()
  }
})

test("command failure retries the same admission ID and wake retry uses its canonical receipt without command reevaluation", async () => {
  const item = submission("ses_command", "/report argument\nnext line", false)
  item.payload.modelSelectionPending = true
  item.payload.model.id = "selected"
  let rejectCommand = true
  let rejectWake = true
  const canonical: SessionPendingUser = {
    ...pending(item),
    data: { text: "Resolved command text", metadata: { command: "report" }, files: [] },
  }
  const requests: Array<{
    endpoint: string
    id?: string
    text?: string
    resume?: boolean
    arguments?: string
    metadata?: unknown
  }> = []
  const flow = fixture(async (url, request) => {
    if (request.method === "POST")
      requests.push({ endpoint: url.pathname.split("/").at(-1)!, ...(await request.clone().json()) })
    if (url.pathname.endsWith("/model")) return new Response(null, { status: 204 })
    if (url.pathname.endsWith("/command"))
      return rejectCommand
        ? json({ _tag: "CommandEvaluationError", message: "rejected" }, { status: 500 })
        : json({ data: canonical })
    if (url.pathname.endsWith("/prompt"))
      return rejectWake ? json({ message: "wake unknown" }, { status: 500 }) : json({ data: canonical })
    return undefined
  })
  try {
    flow.manager.dispatch(item, {
      location: { directory: "/tmp/ycoding/submission" },
      command: { name: "report", arguments: "argument\nnext line" },
      cleanup: async () => {},
    })
    await until(() => flow.manager.list()[0]?.state === "attention")
    expect(requests.map((request) => request.endpoint)).toEqual(["model", "command"])
    rejectCommand = false
    flow.manager.retry(item.sessionID, item.promptID)
    await until(
      () => requests.some((request) => request.endpoint === "prompt") && flow.manager.list()[0]?.state === "attention",
    )
    rejectWake = false
    flow.manager.retry(item.sessionID, item.promptID)
    await until(() => flow.manager.list().length === 0)
    const commands = requests.filter((request) => request.endpoint === "command")
    expect(commands).toHaveLength(2)
    expect(commands.map((request) => request.id)).toEqual([item.promptID, item.promptID])
    expect(commands.map((request) => request.resume)).toEqual([false, false])
    expect(commands[1].arguments).toBe("argument\nnext line")
    const wakes = requests.filter((request) => request.endpoint === "prompt")
    expect(wakes.map((request) => request.id)).toEqual([item.promptID, item.promptID])
    expect(wakes.map((request) => request.text)).toEqual([canonical.data.text, canonical.data.text])
    expect(wakes.map((request) => request.metadata)).toEqual([canonical.data.metadata, canonical.data.metadata])
    expect(wakes.map((request) => request.resume)).toEqual([true, true])
  } finally {
    flow.manager.dispose()
  }
})
