import fs from "node:fs/promises"
import { BackendController } from "../src/backend-controller"
import { env, launch, revision, syntheticBundle } from "./synthetic-backend"
import { createEventStream, createFetch } from "../../tui/test/fixture/tui-client"

export type SyntheticCall = { method: string; route: string; query: URLSearchParams; body: Record<string, unknown> }

export type PopulatedTranscriptKind = "multiagent" | "tool-heavy" | "thought-heavy"
export const populatedLongLine = '  const nextCursor = encodeCursor({ ordering: "updated-descending", retainedBoundary: "' + "pagination-boundary-".repeat(18) + '" });'
export const populatedToolError = "The retained page cannot be reconciled with this cursor. Keep the visible messages and retry the read with the current connection revision."
export const populatedDraft = {
  text: "Summarize the cursor boundary review and keep the keyboard and streaming findings separate.",
  files: ["cursor-pagination-reconciliation-and-retained-history-observations.txt", "keyboard-focus-and-reduced-motion-accessibility-review.txt", "streaming-attachment-and-layout-stability-verification.txt"].map(name => ({ uri: `file:///synthetic/repo/reports/${name}`, name })),
  agents: [{ name: "reviewer" }],
}

export function populatedTranscript(kind: PopulatedTranscriptKind, tail: string, streaming: boolean) {
  const topics = [
    ["Trace the cursor boundary", "The first page and its retained predecessor must use the same ordering. A later read must not replace the visible history while an older page is arriving."],
    ["Reconcile retained history", "Keep the message identities stable when older rows arrive. The reader's chosen message stays in place; a detached reader must not be pulled to the newest response."],
    ["Inspect tool evidence", "The file read and search agree on the cursor owner. The unsuccessful check is still evidence: show the returned error and the exact command instead of presenting the operation as successful."],
    ["Review keyboard paths", "Commands, attachment removal and disclosure controls need names and visible focus. Opening details must not submit a draft or move focus to another conversation."],
    ["Compare responsive behavior", "The same technical content must remain available on a narrow screen. Preserve indentation and diff signs while reflowing long paths inside their own available track."],
    ["Consolidate the findings", "Cursor ownership and retained message identities are consistent. The remaining layout and motion findings belong to the renderer; no backend or model change is needed."],
  ]
  return topics.flatMap(([topic, explanation], index) => {
    const agent = kind === "multiagent" ? ["planner", "planner", "build", "build", "reviewer", "reviewer"][index]! : kind === "thought-heavy" ? "reviewer" : "build"
    const reasoning = `${explanation}\n\n${topics.map(([name, detail]) => `- ${name}: ${detail}`).join("\n")}\n\nReasoning provenance: retained synthetic review ${index + 1}; no hidden provider state is implied.`
    const tools = [
      { id: `r7_read_${index}`, type: "tool", name: "read", state: { status: "completed", input: { path: "src/session/cursor-pagination-and-retained-message-boundaries.ts", offset: 120, limit: 40 }, content: [{ type: "text", text: `export function reconcilePage(previous, incoming) {\n${populatedLongLine}\n  return preserveVisibleMessage(previous, incoming, nextCursor);\n}\nRead provenance: synthetic source fixture, lines 120–160.` }], structured: {} }, time: { created: 1000 + index * 100, completed: 1020 + index * 100 } },
      { id: `r7_grep_${index}`, type: "tool", name: "grep", state: { status: "completed", input: { path: "src/session", pattern: "retainedBoundary|connectionRevision|visibleMessageID" }, content: [{ type: "text", text: "src/session/pagination.ts:128: retainedBoundary = cursor.boundary\nsrc/session/reconcile.ts:42: visibleMessageID = previous.visibleMessageID\nSearch provenance: 2 matches in the synthetic repository." }], structured: {} }, time: { created: 1021 + index * 100, completed: 1040 + index * 100 } },
      { id: `r7_check_${index}`, type: "tool", name: "shell", state: { status: "error", input: { command: "bun test ./test/cursor-pagination-retained-boundary.test.ts --test-name-pattern 'retains the detached reader across a cursor refresh'" }, content: [{ type: "text", text: "Selected cursor check: 1 passed, 1 failed. The failing case retained its full diagnostic output." }], structured: {}, error: { type: "SyntheticCursorConflict", message: populatedToolError } }, time: { created: 1041 + index * 100, completed: 1080 + index * 100 } },
    ]
    const original = [
      { id: `r7_prompt_${index}`, type: "user", text: `${topic}. ${explanation}\n\nKeep the response substantive and preserve the underlying evidence.`, files: index === 5 ? [{ content: { type: "managed", digest: "a".repeat(64), bytes: 4, path: `attachments/sha256/aa/${"a".repeat(64)}` }, mime: "text/plain", name: populatedDraft.files[0]!.name }] : [], time: { created: 900 + index * 100 } },
      { id: index === 5 ? "msg_response" : `r7_response_${index}`, type: "assistant", agent, model: { id: "synthetic", providerID: "synthetic", variant: "high" }, content: [
        { type: "reasoning", text: kind === "thought-heavy" ? `${reasoning}\n\n${reasoning}` : reasoning, time: { created: 1000 + index * 100, completed: 1010 + index * 100 } },
        ...(kind === "tool-heavy" || index === 5 ? tools : tools.slice(0, 1)),
        { type: "text", text: `## ${topic}\n\n${explanation}\n\n${index === 5 ? "**Final result:** The retained boundary and the visible reader are separate concerns. Keep successful checks, unsuccessful checks and unverified native behavior distinct.\n\n" : ""}The implementation keeps the full technical record available for review, including the source path, selected check and returned diagnostic.\n\n\`\`\`ts\nexport function retainVisibleMessage(previous, incoming) {\n${populatedLongLine}\n  return { ...incoming, visibleMessageID: previous.visibleMessageID, nextCursor };\n}\n\`\`\`\n\n\`\`\`diff\n-  const boundary = incoming.firstMessage;\n+  const boundary = previous.visibleMessageID;\n+${populatedLongLine}\n\`\`\`\n\n${index === 5 ? tail : "Next: verify the observable result before changing the cursor owner."}`, time: { created: 1081 + index * 100 } },
      ], time: { created: 1000 + index * 100, ...(index === 5 && streaming ? {} : { completed: 1090 + index * 100 }) } },
    ]
    if (index !== 0) return original
    const changedAgent = agent === "reviewer" ? "planner" : "reviewer"
    const intermediate = ([
      [agent, "synthetic", "reasoning"],
      [agent, "synthetic", "tool"],
      [changedAgent, "synthetic", "reasoning"],
      [changedAgent, "synthetic-review", "tool"],
      [changedAgent, "synthetic-review", "reasoning"],
      [agent, "synthetic", "tool"],
      [agent, "synthetic", "reasoning"],
    ] as const).map(([stepAgent, modelID, type], step) => {
      const created = step < 5 ? 910 + step * 10 : 1091 + (step - 5) * 3
      return { id: `r7_intermediate_${step}`, type: "assistant", agent: stepAgent, model: { id: modelID, providerID: "synthetic", variant: "high" }, content: type === "reasoning" ? [{ type: "reasoning", text: `Intermediate reasoning provenance ${step + 1}: inspect the retained cursor without presenting a substantive answer.`, time: { created, completed: created + 1 } }] : [{ ...tools[0]!, id: `r7_intermediate_read_${step}`, state: { ...tools[0]!.state, content: [{ type: "text", text: `Intermediate read provenance ${step + 1}: retained cursor source inspected without changing files.` }] }, time: { created, completed: created + 1 } }], time: { created, completed: created + 2 } }
    })
    return [original[0]!, ...intermediate.slice(0, 5), original[1]!, ...intermediate.slice(5)]
  })
}

export async function syntheticDesktop(handle: (call: SyntheticCall) => unknown = () => undefined, options: NonNullable<ConstructorParameters<typeof BackendController>[1]> = {}) {
  const resources = await syntheticBundle()
  const calls: SyntheticCall[] = []
  const events = createEventStream({ sourceEpoch: "synthetic" })
  const fixture = createFetch(async (url, request) => {
    if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "synthetic", pid: 101, sourceEpoch: "synthetic" })
    if (url.pathname === "/api/event") return events.connect()
    const body: unknown = request.body ? await request.json() : {}
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Synthetic request body must be an object")
    const call = { method: request.method, route: url.pathname, query: url.searchParams, body: { ...body } }
    calls.push(call)
    const value = await handle(call)
    if (value instanceof Response) return value
    if (value !== undefined) return Response.json(value)
    if (url.pathname === "/api/coordination") return Response.json({ data: [] })
    if (url.pathname === "/api/coordination/settings") return Response.json({ data: { enabled: false, categories: [] } })
    if (url.pathname === "/api/project/inventory") return Response.json({ data: [], cursor: {} })
    return new Response(null, { status: 204 })
  }, events)
  const controller = new BackendController(resources, { editor: { read: async () => ({ status: "disabled" }), close: () => {} }, ...options, env, launch, cwd: resources, fetch: fixture.fetch, socket: fixture.fetch.socket })
  try {
    const connected = await controller.connect({ mode: "shared", server: "http://synthetic.invalid" })
    return { controller, calls, resources, revision: revision(connected), async close() { await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }) } }
  } catch (error) { await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }); throw error }
}
