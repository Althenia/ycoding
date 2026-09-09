import { expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@ycoding-ai/client"

const util = await import("../src/util/session")
const openBtwSessionCandidate: unknown = Reflect.get(util, "openBtwSession")
const steerBtwConclusionCandidate: unknown = Reflect.get(util, "steerBtwConclusion")

type SessionApi = {
  list(input: {
    parentID: string
    limit: number
    order: "desc"
    cursor?: string
  }): Promise<{ data: SessionInfo[]; cursor?: { next?: string | null } }>
  create(input: {
    parentID: string
    agent: string
    model: { providerID: string; id: string; variant?: string }
  }): Promise<SessionInfo>
  synthetic(input: {
    sessionID: string
    text: string
    description: string
    delivery: "steer"
    resume: false
  }): Promise<unknown>
  prompt(input: { id?: string; sessionID: string; text: string; delivery?: "steer" }): Promise<unknown>
}

type OpenBtwSession = (input: {
  api: SessionApi
  parentID: string
  messages: readonly SessionMessageInfo[]
  model: { providerID: string; id: string; variant?: string }
  text?: string
}) => Promise<SessionInfo>

type SteerBtwConclusion = (input: {
  api: Pick<SessionApi, "prompt">
  id: string
  parentID: string
  text: string
}) => Promise<void>

function session(id: string, parentID?: string, agent?: string): SessionInfo {
  return {
    id,
    parentID,
    agent,
    title: "Session",
    projectID: "project",
    location: { directory: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
}

const history: SessionMessageInfo[] = [
  {
    id: "msg_user",
    type: "user",
    text: "Investigate the failed build",
    files: [],
    agents: [],
    time: { created: 1 },
  },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content: [{ type: "text", text: "The typecheck fails in the TUI." }],
    time: { created: 2, completed: 3 },
  },
]

test("creates a distinct BTW child per command, seeds history, and admits with the selected model", async () => {
  expect(typeof openBtwSessionCandidate).toBe("function")
  if (typeof openBtwSessionCandidate !== "function") return
  const openBtwSession = openBtwSessionCandidate as OpenBtwSession
  const children: SessionInfo[] = []
  const created: SessionInfo[] = []
  const creates: Parameters<SessionApi["create"]>[0][] = []
  const synthetic: Parameters<SessionApi["synthetic"]>[0][] = []
  const prompts: Parameters<SessionApi["prompt"]>[0][] = []
  const api: SessionApi = {
    list: async () => ({ data: children }),
    create: async (input) => {
      creates.push(input)
      const child = session(`ses_btw_${created.length + 1}`, input.parentID, input.agent)
      created.push(child)
      children.push(child)
      return child
    },
    synthetic: async (input) => {
      synthetic.push(input)
    },
    prompt: async (input) => {
      prompts.push(input)
    },
  }

  const first = await openBtwSession({
    api,
    parentID: "ses_main",
    messages: history,
    model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    text: "What failed?",
  })
  const second = await openBtwSession({
    api,
    parentID: "ses_main",
    messages: history,
    model: { providerID: "anthropic", id: "claude-sonnet", variant: "default" },
    text: "Anything else?",
  })

  expect(first.id).toBe("ses_btw_1")
  expect(second.id).toBe("ses_btw_2")
  expect(created).toHaveLength(2)
  expect(synthetic).toHaveLength(2)
  expect(created.map((child) => child.id)).toEqual(["ses_btw_1", "ses_btw_2"])
  expect(creates.map((input) => input.model)).toEqual([
    { providerID: "openai", id: "gpt-5.6", variant: "high" },
    { providerID: "anthropic", id: "claude-sonnet", variant: "default" },
  ])
  expect(synthetic[0]).toMatchObject({
    sessionID: "ses_btw_1",
    description: "Parent session history snapshot",
    delivery: "steer",
    resume: false,
  })
  expect(synthetic[0]?.text).toContain("Investigate the failed build")
  expect(synthetic[0]?.text).toContain("The typecheck fails in the TUI.")
  expect(prompts).toEqual([
    { sessionID: "ses_btw_1", text: "What failed?" },
    { sessionID: "ses_btw_2", text: "Anything else?" },
  ])
})

test("opening BTW copies history without invoking the parent's generation API", async () => {
  const generated: unknown[] = []
  const snapshots: string[] = []
  const api = {
    create: async (input: { parentID: string; agent: string }) => session("ses_btw", input.parentID, input.agent),
    synthetic: async (input: { text: string }) => {
      snapshots.push(input.text)
    },
    prompt: async () => undefined,
    generate: async (input: unknown) => {
      generated.push(input)
      return { text: "Unexpected helper generation" }
    },
  }
  await util.openBtwSession({
    api,
    parentID: "ses_main",
    messages: history,
    model: { providerID: "test", id: "model" },
  })
  expect(generated).toEqual([])
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toContain("Investigate the failed build")
  expect(snapshots[0]).toContain("The typecheck fails in the TUI.")
})

test("side-chat activity leaves parent session state untouched", async () => {
  expect(typeof openBtwSessionCandidate).toBe("function")
  if (typeof openBtwSessionCandidate !== "function") return
  const openBtwSession = openBtwSessionCandidate as OpenBtwSession
  const parent = session("ses_main")
  const before = structuredClone({ parent, history })
  const api: SessionApi = {
    list: async () => ({ data: [] }),
    create: async (input) => session("ses_btw", input.parentID, input.agent),
    synthetic: async () => undefined,
    prompt: async () => undefined,
  }

  await openBtwSession({
    api,
    parentID: parent.id,
    messages: history,
    model: { providerID: "test", id: "model" },
    text: "Check this",
  })

  expect({ parent, history }).toEqual(before)
})

test("does not list or reuse an existing BTW child", async () => {
  expect(typeof openBtwSessionCandidate).toBe("function")
  if (typeof openBtwSessionCandidate !== "function") return
  const openBtwSession = openBtwSessionCandidate as OpenBtwSession
  const child = session("ses_btw", "ses_main", "btw")
  const pages: Array<string | undefined> = []
  const state = { creates: 0 }
  const api: SessionApi = {
    list: async (input) => {
      pages.push(input.cursor)
      if (!input.cursor) return { data: [], cursor: { next: "older" } }
      return { data: [child], cursor: {} }
    },
    create: async () => {
      state.creates += 1
      return session("ses_new", "ses_main", "btw")
    },
    synthetic: async () => undefined,
    prompt: async () => undefined,
  }

  const found = await openBtwSession({
    api,
    parentID: "ses_main",
    messages: history,
    model: { providerID: "test", id: "model" },
  })

  expect(found).not.toBe(child)
  expect(pages).toEqual([])
  expect(state.creates).toBe(1)
})

test("steers an explicit conclusion into the parent without interrupting it", async () => {
  expect(typeof steerBtwConclusionCandidate).toBe("function")
  if (typeof steerBtwConclusionCandidate !== "function") return
  const steerBtwConclusion = steerBtwConclusionCandidate as SteerBtwConclusion
  const calls: Array<{ type: "prompt" | "interrupt"; input: unknown }> = []
  const api = {
    prompt: async (input: Parameters<SessionApi["prompt"]>[0]) => {
      calls.push({ type: "prompt", input })
    },
    interrupt: async (input: { sessionID: string }) => {
      calls.push({ type: "interrupt", input })
    },
  }

  await steerBtwConclusion({ api, id: "msg_export", parentID: "ses_main", text: "Use the narrow fix." })

  expect(calls).toEqual([
    {
      type: "prompt",
      input: { id: "msg_export", sessionID: "ses_main", text: "Use the narrow fix.", delivery: "steer" },
    },
  ])
})

test("opens BTW only from explicit model-dialog completion and retains the draft on cancellation", async () => {
  const source = await Bun.file(new URL("../src/component/prompt/index.tsx", import.meta.url)).text()
  const start = source.indexOf('title: "Open BTW side chat"')
  const end = source.indexOf('title: "Send to main chat"', start)
  const command = source.slice(start, end)

  expect(source).toContain('slash: { name: "btw", arguments: true as const }')
  expect(source).toContain('slash: { name: "btw-send", arguments: true as const }')
  expect(command).toContain("onComplete={(result) => {")
  expect(command).toContain('if (result.type === "cancelled") return')
  expect(command).toContain("clearPrompt()")
  expect(command).toContain("openBtwSession({")
  expect(command).not.toContain("local.model.current()")
  expect(source).toContain(
    'if (slash.command.id !== "session.btw" && slash.command.id !== "session.btw.send") clearPrompt()',
  )
  expect(source).not.toContain("queueMicrotask")
  expect(source).toContain('enabled: data.session.get(props.sessionID ?? "")?.agent === "btw"')
})
