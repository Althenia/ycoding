import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { createServer, type ViteDevServer } from "vite"
import type { Dots } from "../../schema/src/dots"
import type { Remote } from "../../schema/src/remote"
import { SessionID } from "../../schema/src/session-id"
import { launchBrowser, decodeArray, decodeBoolean, decodeDictionary, decodeNullable, decodeNumber, decodeRecord, decodeString, decodeUnion } from "../../../apps/web/verify/cdp"
import { createDesktopRPC } from "../src/rpc"
import { DesktopError, type DirectoryListing, type Messages } from "../src/contract"
import { populatedDraft, populatedLongLine, populatedToolError, populatedTranscript, syntheticDesktop, type PopulatedTranscriptKind, type SyntheticCall } from "./synthetic-desktop"

const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME to the repository-provisioned Chrome for Testing executable.")
const title = "Synthetic Session with a complete readable title ".repeat(4).trim()
const unbroken = "UnbrokenSyntheticSessionTitle".repeat(5)
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const clipboard: string[] = []
let clipboardFailure = false
let pastedClipboard: { text: string | null; imageBase64?: string; formats: readonly string[] } | undefined
const saved: { readonly filename: string; readonly content: string }[] = []
const notifications: unknown[] = []
let pinned = false
let pending = true
let replyText = "Initial synthetic response"
let running = false
let deferred = false
let autonomyModes = { permissions: "manual", guardrails: "manual", answers: "manual" }
let currentVariant: string | undefined
let sessionCost = 0
let stagedMessage: string | undefined
let archived = false
let familyEnabled = false
let failInterrupt = false
let directoryStatus = false
let telemetryConsent = false
let globalFormPending = false
let formReview = false
let processControls = false
let waitingTask = true
let stoppedTask = true
let presentationParts = false
let populatedKind: PopulatedTranscriptKind | undefined
let referenceScene = false
let providerScene = false
let captureScene = false
let sceneRead: ((call: SyntheticCall) => unknown) | undefined
let exportFailure = false
let ideEnabled = false
let ideFailure = false
let externalEdit: string | undefined
let questionPending = false
let decideGate: Promise<void> | undefined
let fileGate: { query: string; reached: () => void; wait: Promise<void> } | undefined
let browseListing: DirectoryListing | Error | undefined
let server: ViteDevServer | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let owned: Awaited<ReturnType<typeof syntheticDesktop>> | undefined
let origin = ""

const selection = () => ({ id: "synthetic", providerID: "synthetic", ...(currentVariant ? { variant: currentVariant } : {}) })
const session = (id: string) => ({ id, projectID: "global", title: populatedKind ? id === "ses_test" ? "Cursor pagination and retained history" : "Review CursorPaginationRetainedHistoryRevisionFenceAndDetachedReaderStabilityAcrossConnectionReplacements" : id === "ses_test" ? referenceScene ? "Refactor session pagination" : title : id.startsWith("ses_child_") ? id : unbroken, location: { directory: "/synthetic/repo" }, model: selection(), ...(captureScene && id === "ses_child" ? { agent: "btw" } : {}), ...(id === "ses_child" || id.startsWith("ses_child_") ? { parentID: "ses_test" } : {}), ...(id === "ses_test" && stagedMessage ? { revert: { messageID: stagedMessage, files: [] } } : {}), time: { created: 1, updated: 2, ...(id === "ses_test" && pinned ? { pinned: 3 } : {}), ...(id === "ses_test" && archived ? { archived: 4 } : {}) }, tokens, cost: sessionCost })
const model = { id: "synthetic", modelID: "synthetic", providerID: "synthetic", name: "Synthetic Model", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "low" }, { id: "high" }], profiles: [], time: { released: 1 }, cost: [], status: "active", enabled: true, limit: { context: 200000, output: 32000 } }
const location = { directory: "/synthetic/repo", project: { id: "global", directory: "/synthetic/repo" } }
const transcript = () => {
  if (populatedKind) return populatedTranscript(populatedKind, replyText, running)
  const messages = [
  ...Array.from({ length: 240 }, (_, index) => ({ id: `msg_prompt_${index}`, sessionID: "ses_test", type: "user", text: `Synthetic prompt ${index}. ${"Retained history ".repeat(16)}`, files: index === 239 ? [{ content: { type: "managed", digest: "a".repeat(64), bytes: 4, path: `attachments/sha256/aa/${"a".repeat(64)}` }, mime: "text/plain", name: "restored-notes.txt" }] : [], agents: index === 239 ? [{ name: "reviewer" }] : [], time: { created: index + 1 } })),
  { id: "msg_response", sessionID: "ses_test", type: "assistant", agent: "build", model: { id: "synthetic", providerID: "synthetic" }, content: [...(presentationParts ? [{ id: "part_reasoning", type: "reasoning", text: "Synthetic reasoning summary", time: { created: 500, completed: 500 } }, { id: "part_read", type: "tool", name: "read", state: { status: "completed", input: { path: "src/a.ts" }, content: [], structured: {} }, time: { created: 500 } }, { id: "part_grep", type: "tool", name: "grep", state: { status: "completed", input: { pattern: "synthetic" }, content: [], structured: {} }, time: { created: 500 } }] : []), { id: "part_response", type: "text", text: replyText, time: { created: 500 } }], time: { created: 500, ...(!running ? { completed: 501 } : {}) } },
  ]
  return referenceScene ? messages.slice(-2).map(message => message.type === "user" ? { ...message, text: "Please execute the virtual scroll test suite and verify that cursor pagination does not break reverse sorting when filter tags are updated. Then run the build step to confirm tree-shaking works." } : captureScene ? { ...message, tokens: { input: 4000, output: 600, reasoning: 200, cache: { read: 8000, write: 0 } }, diagnostics: { contextLimit: 200000, contextBreakdown: { system: 1000, tools: 1000, user: 2000, assistant: 600, reasoning: 200, toolCalls: 0, other: 0 } } } : message) : messages
}
const sceneMetrics = { logical: 12, physical: 14, helpers: 2, continued: 0, fallback: 0, tokens: { input: 4000, output: 600, reasoning: 200, cache: { read: 8000, write: 0 } } }
const sceneRepository = { projectID: "global", projectName: "Synthetic repository", projectWorktree: "/synthetic/repo", directory: "/synthetic/repo", sessions: 2, timeActive: 1, available: true }
const sceneParticipant = (sessionID: string) => ({ sessionID, title: sessionID === "ses_test" ? "Synthetic master" : "Synthetic member", location: { directory: "/synthetic/repo" }, state: "idle", lastActivity: 1, pending: [] })
const sceneGroup = { id: "cgrp_synthetic", name: "Synthetic project", revision: 1, active: true, master: sceneParticipant("ses_test"), members: [sceneParticipant("ses_other")], settings: { concurrency: 2 }, time: { created: 1, updated: 2 } }
const sceneAutonomy = { mode: "normal", permissions: "manual", guardrails: "auto", answers: "manual", goal: { text: "Verify the synthetic pagination change", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3, lastProgressDigest: null }, defer: null, effective: { permissions: "manual", guardrails: "auto", answers: "manual", inherited: {}, deferred: false, guardrailsEnabled: true } }
const scenePermission = { id: "per_scene", sessionID: "ses_test", action: "edit", resources: ["src/pagination.ts"], save: ["src/**"] }
const sceneGuardrail = { id: "grq_scene", rootSessionID: "ses_test", sessionID: "ses_test", action: "shell", resources: ["bun test test/pagination.test.ts"], ruleIDs: ["synthetic.review"], reason: "Review the synthetic verification command", standard: true, hardReview: true }
const scenePatch = { path: "src/pagination.ts", patch: "@@ -1 +1 @@\n-const pageSize = 10\n+const pageSize = 20", additions: 1, deletions: 1 }
const scenePty = { id: "pty_scene", title: "Synthetic terminal", command: "sh", args: [], cwd: "/synthetic/repo", sessionID: "ses_test", status: "running", pid: 101, generation: 1, size: { rows: 24, cols: 80 }, control: { owner: "user", fence: 1 }, output: { startOffset: 0, endOffset: 27, truncated: false }, limits: { maxRuntimeSeconds: 60, maxRetainedBytes: 1024, maxInputBytes: 1024 } }

function sceneResponse(call: SyntheticCall) {
  const overridden = sceneRead?.(call)
  if (overridden !== undefined) return overridden
  if (!captureScene) return undefined
  const envelope = (data: unknown) => ({ location, data })
  if (call.route.endsWith("/autonomy")) return { data: sceneAutonomy }
  if (call.route === "/api/coordination") return { data: [{ id: sceneGroup.id }] }
  if (call.route === "/api/coordination/settings") return { data: { enabled: true, categories: [] } }
  if (call.route === `/api/coordination/${sceneGroup.id}`) return { data: sceneGroup }
  if (call.route === "/api/project/inventory") return { data: [sceneRepository], cursor: {} }
  if (call.route === "/api/project/global/directories") return [{ directory: "/synthetic/repo", strategy: "git_worktree" }]
  if (call.route === "/api/usage") return { data: sceneMetrics }
  if (call.route === "/api/usage/report") return { data: { group: "model", rows: [{ ...sceneMetrics, key: "synthetic/synthetic", label: "Synthetic Model", model: selection() }], total: sceneMetrics, rowCount: 1 } }
  if (call.route === "/api/provider/usage") return envelope([{ providerID: "synthetic", label: "Synthetic provider", status: "available", source: "provider_api", stability: "stable", updatedAt: 1, windows: [{ id: "daily", label: "Daily requests", unit: "requests", used: 12, limit: 100 }] }])
  if (call.route.endsWith("/todo")) return { data: [{ content: "Verify pagination", status: "in_progress", priority: "high" }] }
  if (/^\/api\/session\/[^/]+\/diagnostics$/.test(call.route)) return {}
  if (call.route.endsWith("/compaction")) return { data: [], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 }
  if (call.route.endsWith("/usage")) return { data: sceneMetrics }
  if (call.route.endsWith("/usage/tasks")) return { data: { tasks: [], total: {}, history: "retained" } }
  if (call.route === "/api/mcp") return envelope([{ name: "synthetic-docs", status: { status: "connected" } }, { name: "synthetic-search", status: { status: "failed", error: "Synthetic server is unavailable" } }])
  if (call.route === "/api/mcp/resource") return envelope({ resources: [{ server: "synthetic-docs", name: "Pagination guide", uri: "synthetic://pagination", mimeType: "text/plain" }], templates: [] })
  if (call.route === "/api/skill") return envelope([{ id: "synthetic-review", name: "Synthetic review", description: "Inspect synthetic changes" }])
  if (call.route.endsWith("/skills")) return { data: [{ id: "synthetic-review", name: "Synthetic review", state: "active" }] }
  if (call.route === "/api/plugin") return envelope([{ id: "synthetic-plugin" }])
  if (call.route === "/api/remote") return { data: { state: "off" } satisfies Remote.Status }
  if (call.route === "/api/dots") return { data: { access: { enabled: false, revision: 1 }, configuration: { ready: false }, connection: { state: "unavailable" } } satisfies Dots.NativeStatus }
  if (call.route === "/api/server") return { urls: ["http://127.0.0.1:1234"] }
  if (call.route.endsWith("/browser")) return { data: { state: "unavailable" } }
  if (call.route.endsWith("/browser/isolated")) return { data: { mode: "isolated", state: "stopped" } }
  if (call.route.endsWith("/tabs")) return { data: [] }
  if (call.route === "/api/config/diagnostics") return envelope([{ path: "/synthetic/repo/ycoding.json", reason: "invalid-values", jsonPath: "$.model", message: "Synthetic model configuration requires review", failClosed: true }])
  if (call.route === "/api/provider") return envelope([{ id: "synthetic", name: "Synthetic provider", package: "@synthetic/provider", integrationID: "synthetic" }])
  if (call.route === "/api/reference") return envelope([{ name: "Synthetic docs", path: "/synthetic/docs", source: { type: "local", path: "/synthetic/docs" } }])
  if (call.route === "/api/artifact") return { data: [{ scope: "project", kind: "skill", id: "synthetic-review", name: "Synthetic review", stage: "active", revision: 1, currentVersionID: "pav_scene", currentDigest: "a".repeat(64) }] }
  if (call.route === "/api/artifact/project/skill/synthetic-review") return { data: { artifact: { id: "synthetic-review", kind: "skill", revision: 1, stage: "active", name: "Synthetic review" }, definition: { content: "Inspect the synthetic change." }, currentVersion: { id: "pav_scene", contentDigest: "a".repeat(64) }, versions: [{ id: "pav_scene" }], diagnostics: [] } }
  if (call.route === "/api/artifact/project/skill/synthetic-review/metrics") return { data: { score: 1, confidence: "low", rewardUnits: 1, penaltyUnits: 0 } }
  if (call.route === "/api/artifact/project/skill/synthetic-review/promotion" && call.method === "POST") return { data: { token: "synthetic-preview", expiresAt: 4102444800000, renderedContent: "Inspect the synthetic change.", risk: "declarative" } }
  if (call.route === "/api/incident/report") return { data: { rows: [{ providerID: "synthetic", modelID: "synthetic", fallbacks: 2, escalated: 1, rejected: 0, last: 1 }], groups: 1 } }
  if (call.route === "/api/usage/dashboard") return { data: { status: "preparing" } }
  if (call.route === "/api/incident/recent") return { data: { items: [] } }
  if (call.route === "/api/incident/guidance") return { data: { text: "Use the reported context limit", enabled: true } }
  if (call.route === "/api/pty") return envelope([scenePty])
  if (call.route === "/api/pty/pty_scene") return envelope(scenePty)
  if (call.route === "/api/pty/pty_scene/connect-token") return { data: { ticket: "synthetic-inspection-ticket", access: "inspect", generation: 1 } }
  if (call.route.endsWith("/shell/sh_synthetic/output")) {
    const output = "Synthetic pagination check: 6 passed, 0 failed\n"
    return envelope({ output, cursor: output.length, size: output.length, truncated: false })
  }
  return undefined
}
const review = {
  itemID: "rvw_synthetic", sessionID: "ses_child", rootSessionID: "ses_test", sessionTitle: "Synthetic child", kind: "question", reason: "Choose synthetic targets", created: 1,
  origin: { requestID: "question-synthetic" }, payload: { type: "question", questions: [
    { header: "Targets", question: "Choose the synthetic targets", multiple: true, custom: false, options: [{ label: "Local", description: "Local target" }, { label: "Preview", description: "Preview target" }] },
    { header: "Details", question: "Describe the synthetic result", options: [], custom: true },
  ] },
}
const processTask = () => ({ sessionID: "ses_child", parentID: "ses_test", description: "Synthetic waiting worker", agent: "build", model: selection(), background: true, state: waitingTask ? "waiting" : "running", revision: 1, time: { created: 1, updated: 2 }, ...(waitingTask ? { question: { id: "qst_synthetic", text: "Choose the synthetic process response", time: 2 } } : {}), ...(stoppedTask ? { stoppedRecovery: { itemID: "rvw_recovery" } } : {}) })

beforeAll(async () => {
  owned = await syntheticDesktop((call) => {
    const scene = sceneResponse(call)
    if (scene !== undefined) return scene
    if (call.route === "/api/session/ses_test/autonomy") {
      if (call.method === "PUT") {
        if (typeof call.body.defer === "boolean") deferred = call.body.defer
        for (const key of ["permissions", "guardrails", "answers"] as const) if (typeof call.body[key] === "string") autonomyModes[key] = String(call.body[key])
      }
      return { data: { mode: "normal", ...autonomyModes, goal: null, defer: deferred ? {} : null, effective: { ...autonomyModes, inherited: {}, deferred, guardrailsEnabled: true } } }
    }
    if (call.route === "/api/keep-awake") return { data: { state: "off" } }
    if (call.route === "/api/permission/saved") return { data: [] }
    if (call.route === "/api/server/telemetry/consent") return { consent: { enabled: telemetryConsent, noticeVersion: 1, decidedAt: 1 }, noticeVersion: 1 }
    if (call.method === "POST" && call.route === "/api/server/web-latency") return { accepted: Array.isArray(call.body.samples) ? call.body.samples.length : 0 }
    if (call.route === "/api/form/request") return { location, data: globalFormPending ? [{ id: "frm_synthetic", sessionID: "global", title: "Global synthetic choice", fields: [{ key: "choice", type: "string", title: "Choice" }], time: { created: 1 } }] : [] }
    if (call.method === "POST" && call.route === "/api/session/global/form/frm_synthetic/reply") { globalFormPending = false; return new Response(null, { status: 204 }) }
    if (directoryStatus && call.route === "/api/session/outstanding") return { data: [], running: ["ses_other"], failed: [], lost: [] }
    if (directoryStatus && call.route === "/api/decision") return { data: [{ kind: "permission", sessionID: "ses_child", sessionTitle: "Synthetic child", directory: "/synthetic/repo", id: "per_synthetic", summary: "Synthetic decision", decide: [] }] }
    if (call.method === "GET" && call.route === "/api/session") return { data: [session("ses_test"), session("ses_other")], cursor: {} }
    if (call.route === "/api/session/active") return { data: running ? { ses_test: { type: "running" } } : {} }
    if (call.route === "/api/model") return { location, data: [model] }
    if (call.route === "/api/model/default") return { location, data: { selection: selection() } }
    if (providerScene && call.route === "/api/integration") return { location, data: [{ id: "synthetic", name: "Synthetic Provider", methods: [{ type: "key", label: "Synthetic API key" }, { type: "oauth", id: "browser", label: "Synthetic browser sign-in" }], connections: [{ type: "credential", id: "cred_synthetic", label: "Synthetic account", active: true, kind: "key" }] }] }
    if (call.route === "/api/shell") return { location, data: referenceScene ? [{ id: "sh_synthetic", status: "running", command: "bun test test/session-page.test.ts", cwd: "/synthetic/repo", shell: "sh", file: "output", time: { started: 1 }, metadata: { sessionID: "ses_test" } }] : [] }
    if (call.route === "/api/vcs/branch") return { location, data: { current: "synthetic", default: "main" } }
    if (call.route === "/api/vcs/status") return { location, data: [] }
    if (call.route === "/api/vcs/diff") return { location, data: ["a.ts", "b.ts"].map((file) => ({ file, patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" })) }
    if (call.method === "GET" && (call.route === "/api/fs/find" || call.route === "/api/fs/list")) {
      const query = call.query.get("query") ?? ""
      const reply = { location, data: [{ path: `src/${query}.ts`, type: "file" }] }
      if (fileGate?.query === query) { fileGate.reached(); return fileGate.wait.then(() => reply) }
      return reply
    }
    if (call.method === "GET" && /^\/api\/session\/ses_[^/]+$/.test(call.route)) return { data: session(call.route.split("/").at(-1)!) }
    if (processControls && call.route === "/api/session/ses_test/subagent") return { data: [processTask()], summary: { total: 1, active: 1 }, cursor: {} }
    if (processControls && call.route === "/api/session/ses_test/subagent/ses_child/question/qst_synthetic/answer") { waitingTask = false; return { data: processTask() } }
    if (processControls && call.method === "GET" && call.route === "/api/session/ses_child/review") return { data: stoppedTask ? [{ itemID: "rvw_recovery", sessionID: "ses_child", rootSessionID: "ses_test", sessionTitle: "Synthetic child", kind: "recovery", reason: "Synthetic stopped worker", created: 1, origin: { requestID: "recovery" }, payload: { type: "recovery", tools: [] } }] : [] }
    if (processControls && call.route === "/api/session/ses_child/review/rvw_recovery/decide") { stoppedTask = false; return new Response(null, { status: 204 }) }
    if (call.route.endsWith("/subagent")) return { data: familyEnabled && call.route === "/api/session/ses_test/subagent" ? ["ses_child_a", "ses_child_b"].map((sessionID) => ({ sessionID, parentID: "ses_test", description: sessionID, agent: "build", model: selection(), background: true, state: "running", revision: 1, time: { created: 1, updated: 2 } })) : [], summary: { total: familyEnabled && call.route === "/api/session/ses_test/subagent" ? 2 : 0, active: familyEnabled && call.route === "/api/session/ses_test/subagent" ? 2 : 0 }, cursor: {} }
    if (call.route.endsWith("/snapshot")) {
      const sessionID = call.route.split("/")[3]!
      const messages = transcript().map((message) => ({ ...message, sessionID }))
      const end = Number(call.query.get("before") ?? messages.length)
      const start = Math.max(0, end - Number(call.query.get("limit") ?? 100))
      return { sourceEpoch: "synthetic", session: session(sessionID), messages: messages.slice(start, end), watermark: { type: "log.synced", aggregateID: sessionID, seq: 1000 }, ...(start > 0 ? { before: String(start) } : {}) }
    }
    if (call.route.endsWith("/captured-inputs")) return { data: [] }
    if (call.route.endsWith("/message")) return { data: transcript() }
    if (call.method === "GET" && call.route.endsWith("/review")) return { data: pending && call.route === "/api/session/ses_test/review" ? [formReview ? { ...review, payload: { type: "form", title: "Synthetic typed review", fields: [{ key: "details", type: "boolean", default: true }, { key: "hidden", type: "string", when: [{ key: "details", op: "eq", value: false }] }, { key: "answer", title: "Reviewed answer", type: "string", required: true, minLength: 5, when: [{ key: "details", op: "eq", value: true }] }] } } : review] : [] }
    if (call.method === "GET" && call.route.endsWith("/question")) return { data: questionPending && call.route === "/api/session/ses_test/question" ? [{ id: "que_active", sessionID: "ses_test", questions: review.payload.questions }] : [] }
    if (call.method === "POST" && /\/question\/que_active\/(reply|reject)$/.test(call.route)) { questionPending = false; return new Response(null, { status: 204 }) }
    if (call.method === "GET" && ["/permission", "/form", "/guardrail/request", "/file-change", "/active", "/pending", "/todo"].some((suffix) => call.route.endsWith(suffix))) return { data: [] }
    if (call.method === "POST" && call.route.endsWith("/decide")) { const finish = () => { pending = false; return new Response(null, { status: 204 }) }; return decideGate ? decideGate.then(finish) : finish() }
    if (call.method === "POST" && call.route.endsWith("/pin")) { pinned = true; return new Response(null, { status: 204 }) }
    if (call.method === "POST" && call.route.endsWith("/prompt")) return { data: { id: call.body.id, sessionID: call.route.split("/")[3], type: "user", delivery: call.body.delivery ?? "steer", admittedSeq: 1, timeCreated: 1, data: { text: call.body.text } } }
    if (call.method === "POST" && call.route.endsWith("/synthetic")) return { data: { id: call.body.id, sessionID: call.route.split("/")[3], type: "synthetic", delivery: "queue", admittedSeq: 1, timeCreated: 1, data: { text: call.body.text } } }
    if (call.method === "POST" && call.route.endsWith("/interrupt")) { if (failInterrupt) return new Response(JSON.stringify({ message: "Synthetic interrupt failed" }), { status: 500, headers: { "content-type": "application/json" } }); running = false; return new Response(null, { status: 204 }) }
    if (call.method === "POST" && call.route.endsWith("/model")) { const selected = call.body.model; if (!selected || typeof selected !== "object" || !("variant" in selected) || typeof selected.variant !== "string") throw new Error("Expected a synthetic variant selection"); currentVariant = selected.variant; return new Response(null, { status: 204 }) }
    if (call.method === "POST" && call.route.endsWith("/revert/stage")) { if (typeof call.body.messageID !== "string") throw new Error("Expected a synthetic revert boundary"); stagedMessage = call.body.messageID; return { data: { messageID: stagedMessage, files: [] } } }
    if (call.method === "POST" && call.route.endsWith("/revert/clear")) { stagedMessage = undefined; return new Response(null, { status: 204 }) }
    if (call.route.endsWith("/archive")) { archived = call.method === "POST"; return new Response(null, { status: 204 }) }
    if (call.method === "POST" && call.route.endsWith("/fork")) return { data: { ...session("ses_fork"), parentID: "ses_test" } }
    if (call.method === "POST" && call.route.endsWith("/compact")) return { data: { id: call.body.id, sessionID: "ses_test", trigger: "manual", status: "ended", requestedThrough: { messageID: "msg_prompt_239", seq: 240 }, timeCreated: 1 } }
    if (call.method === "POST" && call.route.endsWith("/prompt-generate")) return { data: { status: "generated", text: "Generated synthetic draft" } }
    return undefined
  }, { editor: { read: async () => { if (ideFailure) throw new Error("Synthetic IDE read failure"); return ideEnabled ? { status: "connected", selection: { source: "websocket", filePath: "/synthetic/repo/src/editor.ts", ranges: [{ text: "const sample = 1", selection: { start: { line: 1, character: 1 }, end: { line: 1, character: 17 } } }] } } : { status: "disabled" } }, close: () => {} }, openEditor: async () => externalEdit === undefined ? { kind: "fallback" } : { kind: "edited", text: externalEdit } })
  const rpc = createDesktopRPC(owned.controller, { path: path.join(owned.resources, "preferences"), read: async () => ({}), save: async () => {}, validate: () => ({ mode: "shared" }) }, {
    readClipboard: () => pastedClipboard ?? { text: null, formats: [] },
    writeClipboard: (text) => { if (clipboardFailure) throw new DesktopError("Synthetic clipboard unavailable."); clipboard.push(text) },
    notify: (input) => { notifications.push(input) },
    saveExport: async (exported, current) => { if (!current()) throw new Error("Synthetic export connection changed"); if (exportFailure) throw new DesktopError("Synthetic destination denied access (EACCES). No file was written."); saved.push(exported); return { saved: true, path: `/synthetic/exports/${exported.filename}` } },
  })
  server = await createServer({ root: path.resolve(import.meta.dir, ".."), configFile: path.resolve(import.meta.dir, "../vite.config.ts"), plugins: [{ name: "desktop-synthetic-rpc", configureServer(server) {
    server.middlewares.use("/__desktop/rpc", (request, response, next) => { void (async () => {
    response.setHeader("content-type", "application/json")
    try {
      let body = ""
      for await (const chunk of request) body += String(chunk)
      const input: unknown = JSON.parse(body)
      if (!input || typeof input !== "object" || !("method" in input) || typeof input.method !== "string" || !("args" in input) || !Array.isArray(input.args)) throw new Error("Invalid synthetic RPC request")
      if (input.method === "browseDirectory" && browseListing !== undefined) {
        if (browseListing instanceof Error) throw browseListing
        response.end(JSON.stringify({ value: browseListing })); return
      }
      const handler: unknown = Reflect.get(rpc, input.method)
      if (typeof handler !== "function") throw new Error("Unknown synthetic RPC method")
      response.end(JSON.stringify({ value: await Reflect.apply(handler, rpc, input.args) ?? null }))
    } catch (error) { response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Synthetic RPC failed" })) }
    })().catch(next) })
  } }], server: { host: "127.0.0.1", port: 0, strictPort: false } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string") throw new Error("Desktop fixture has no listening port")
  origin = `http://127.0.0.1:${address.port}`
  browser = await launchBrowser(chrome, 1280, 900)
}, 30_000)

afterAll(async () => { await browser?.close(); await server?.close(); await owned?.close() })
beforeEach(() => { ideEnabled = false; externalEdit = undefined; deferred = false; autonomyModes = { permissions: "manual", guardrails: "manual", answers: "manual" } })
beforeEach(() => { ideEnabled = false; ideFailure = false; externalEdit = undefined; populatedKind = undefined })
beforeEach(() => { referenceScene = false; providerScene = false; captureScene = false; sceneRead = undefined; exportFailure = false; sessionCost = 0 })
beforeEach(() => { browseListing = undefined })
beforeEach(() => { clipboardFailure = false; pastedClipboard = undefined })
beforeEach(() => { presentationParts = false; questionPending = false; pending = true; pinned = false; replyText = "Initial synthetic response"; running = false; currentVariant = undefined; stagedMessage = undefined; archived = false; familyEnabled = false; failInterrupt = false; directoryStatus = false; telemetryConsent = false; globalFormPending = false; formReview = false; processControls = false; waitingTask = true; stoppedTask = true; decideGate = undefined; fileGate = undefined; clipboard.length = 0; saved.length = 0; notifications.length = 0; if (owned) owned.calls.length = 0 })

const inject = `(() => {
  const events = new Set(), states = new Set(), resyncs = new Set(), menus = new Set(); let sequence = 0;
  const subscriptions = { onEvent: events, onState: states, onResync: resyncs, onMenuAction: menus };
  window.__desktopFixture = { errors: [], completed: {}, sounds: [], emit: event => events.forEach(callback => callback({ id: 'evt_fixture_' + sequence++, created: 1, ...event })), resync: () => resyncs.forEach(callback => callback()) };
  window.Audio = class { constructor(src) { this.src = src; this.volume = 1; } play() { window.__desktopFixture.sounds.push({ src: this.src, volume: this.volume }); return Promise.resolve(); } pause() {} };
  window.addEventListener('error', event => window.__desktopFixture.errors.push(event.error?.stack ?? event.message));
  window.addEventListener('unhandledrejection', event => window.__desktopFixture.errors.push(String(event.reason?.stack ?? event.reason)));
  window.__ycodingDesktop = new Proxy({}, { get: (_, method) => {
    if (subscriptions[method]) return callback => { subscriptions[method].add(callback); return () => subscriptions[method].delete(callback); };
    return async (...args) => { while (args.length && args.at(-1) === undefined) args.pop(); const response = await fetch('/__desktop/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) }); const result = await response.json(); window.__desktopFixture.completed[method] = (window.__desktopFixture.completed[method] ?? 0) + 1; if (result.error) throw new Error(result.error); return result.value; };
  } });
})()`

type Page = Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>
async function wait(page: Page, expression: string) {
  try {
    await page.evaluate(`new Promise((resolve, reject) => { const deadline = performance.now() + 10000; const check = () => { if (${expression}) return resolve(true); if (performance.now() >= deadline) return reject(new Error('Desktop fixture condition timed out: ' + ${JSON.stringify(expression)})); requestAnimationFrame(check); }; check(); })`)
  } catch (cause) {
    const state = await page.evaluate(`({ errors: window.__desktopFixture.errors, alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent), text: document.body.innerText.slice(-8000), completed: window.__desktopFixture.completed })`)
    throw new Error(`${String(cause)}\n${JSON.stringify(state)}\n${JSON.stringify(owned?.calls.slice(-12).map(call => [call.method, call.route]))}`, { cause })
  }
}
async function open(ready = `document.querySelector('#turn-msg_response')`) {
  if (!browser) throw new Error("Desktop browser fixture is not ready")
  const page = await browser.openPage()
  await page.injectOnNewDocument(inject)
  try {
    await page.navigate(`${origin}/#/sessions/ses_test`)
    await wait(page, `document.querySelector('.rl-session-row-title') && (${ready}) && document.fonts.status === 'loaded'`)
    return page
  } catch (cause) {
    const state = await page.evaluate(`({ errors: window.__desktopFixture.errors, text: document.body.innerText, completed: window.__desktopFixture.completed })`)
    await page.close()
    throw new Error(`${String(cause)}\n${JSON.stringify(state)}\n${JSON.stringify(page.networkFailures())}`, { cause })
  }
}

async function command(page: Page, label: string, capture?: string) {
  await page.evaluate(`document.querySelector('.desktop__palette').click()`)
  await wait(page, `!![...document.querySelectorAll('.palette__option')].find(button => button.textContent.includes(${JSON.stringify(label)}))`)
  await page.evaluate(`(() => { const input = document.querySelector('.palette__input'); input.value = ${JSON.stringify(label)}; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.focus(); })()`)
  await wait(page, `document.querySelector('.palette__option[aria-selected="true"]')?.textContent.includes(${JSON.stringify(label)})`)
  if (capture && process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, capture), Buffer.from(await page.screenshot(), "base64"))
  await page.pressKey("Enter", "Enter", 13, "\r")
}

async function message(page: Page, text: string) {
  await page.evaluate(`(() => { const input = document.querySelector('.rl-capsule textarea'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}

async function confirm(page: Page, label = "Confirm") {
  await wait(page, `document.querySelector('.confirm[open]')`)
  await page.evaluate(`[...document.querySelectorAll('.confirm button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).focus()`)
  await page.pressKey("Enter", "Enter", 13, "\r")
}

test("defer toggles independently and YOLO requires explicit risk consent", async () => {
  pending = false
  const page = await open()
  const changes = () => owned!.calls.filter((call) => call.method === "PUT" && call.route.endsWith("/autonomy"))
  const submit = async (text: string) => {
    await message(page, text)
    await page.evaluate(`document.querySelector('form.composer').requestSubmit()`)
  }
  try {
    await wait(page, `document.body.textContent.includes('Defer off')`)
    await submit("/defer")
    await confirm(page)
    await wait(page, `document.body.textContent.includes('Defer on')`)
    expect(changes().map((call) => call.body)).toEqual([{ defer: true }])
    await submit("Synthetic ordinary message")
    await wait(page, `(window.__desktopFixture.completed.prompt ?? 0) >= 1`)
    expect(deferred).toBe(true)
    await submit("/autonomous yolo")
    await wait(page, `document.querySelector('.confirm[open]')?.textContent.includes('Accept these risks')`)
    expect(await page.evaluate(`document.querySelector('.confirm').textContent`)).toContain("hard policies and custom rules")
    expect(await page.evaluate(`document.querySelector('.confirm').textContent`)).toContain("full responsibility")
    await confirm(page, "Cancel")
    expect(changes()).toHaveLength(1)
    expect(autonomyModes).toEqual({ permissions: "manual", guardrails: "manual", answers: "manual" })
    await submit("/autonomous yolo")
    await wait(page, `document.querySelector('.confirm[open]')?.textContent.includes('Accept these risks')`)
    await page.pressKey("Escape", "Escape", 27)
    await wait(page, `!document.querySelector('.confirm[open]')`)
    expect(changes()).toHaveLength(1)
    expect(autonomyModes).toEqual({ permissions: "manual", guardrails: "manual", answers: "manual" })
    await submit("/autonomous yolo")
    await confirm(page)
    await wait(page, `document.querySelector('.composer-policy-chip')?.getAttribute('aria-label') === 'Autonomous YOLO · Defer on'`)
    expect(changes()).toHaveLength(2)
    expect(autonomyModes).toEqual({ permissions: "yolo", guardrails: "yolo", answers: "yolo" })
    await submit("/defer")
    await confirm(page)
    await wait(page, `document.body.textContent.includes('Defer off')`)
    expect(changes().map((call) => call.body)).toEqual([{ defer: true }, { permissions: "yolo", guardrails: "yolo", answers: "yolo" }, { defer: false }])
    expect(autonomyModes.answers).toBe("yolo")
    expect(await page.evaluate(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

async function openReference(ready = `document.querySelector('#turn-msg_response')`) {
  const page = await open(ready)
  try {
    await page.setViewport(1440, 900)
    await page.evaluate(`(() => { localStorage.setItem('ycoding.desktop.theme', 'dark'); localStorage.setItem('ycoding.desktop.animations', 'false'); location.reload(); })()`)
    await wait(page, `(${ready}) && document.fonts.status === 'loaded'`)
    if (captureScene) {
      await page.evaluate(`(() => { if (document.querySelector('.rl-companion')) document.querySelector('.rl-companion-toggle').click(); })()`)
      await wait(page, `!document.querySelector('.rl-companion')`)
    }
    return page
  } catch (cause) { await page.close(); throw cause }
}

test("Stitch reference geometry preserves the rail, transcript, dock and inspector hierarchy", async () => {
  referenceScene = true
  pending = false
  running = true
  familyEnabled = true
  presentationParts = true
  replyText = "Running regression test on virtual scroll indices. Waiting for the bundle compiler to confirm no duplicate DOM nodes are emitted."
  const page = await openReference()
  try {
    await page.evaluate(`(() => { if (!document.querySelector('.rl-companion')) document.querySelector('.rl-companion-toggle').click(); window.__desktopFixture.emit({ type: 'session.execution.started', data: { sessionID: 'ses_test' } }); })()`)
    await wait(page, `document.querySelector('.rl-companion') && document.querySelector('.rl-session-row[data-state="running"]')`)
    await page.evaluate(`[...document.querySelectorAll('.rl-companion [role="tab"]')].find(button => button.textContent.trim() === 'Running').click()`)
    await wait(page, `document.querySelector('.rl-companion [role="tab"][aria-selected="true"]')?.textContent.trim() === 'Running' && document.querySelector('.rl-running')?.textContent.includes('ses_child_a') && document.querySelector('.rl-running')?.textContent.includes('bun test test/session-page.test.ts')`)
    await message(page, "Also inspect the SQLite journal mode after hot reload.")
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "stitch-streaming.png"), Buffer.from(await page.screenshot(), "base64"))
    const geometry = await page.evaluate(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const rail = rect('.rl-nav'), brand = rect('.rl-nav-brand'), newChat = rect('.rl-new-chat'), head = rect('.rl-top'), companion = rect('.rl-companion'), capsule = rect('.rl-capsule'), column = rect('.conversation__column'), user = rect('.rl-me .transcript-message__bubble'), assistant = rect('.rl-them');
      return { rail: rail.width, separateNewChat: newChat.top >= brand.bottom, header: head.height, companion: companion.width, fullColumnComposer: Math.abs(capsule.width - column.width) <= 1, dockedSurface: getComputedStyle(document.querySelector('.rl-dock')).backgroundColor !== 'rgba(0, 0, 0, 0)', trailingBubble: Math.abs(user.right - assistant.right) <= 1 && user.left > assistant.left, metadataVisible: getComputedStyle(document.querySelector('.workspace__status')).visibility === 'visible', connectionFooter: !!document.querySelector('.workspace__rail-footer')?.textContent.includes('Connected') };
    })()`)
    console.log("Stitch geometry", JSON.stringify(geometry))
    expect(geometry).toEqual({ rail: 256, separateNewChat: true, header: 40, companion: 320, fullColumnComposer: true, dockedSurface: true, trailingBubble: true, metadataVisible: true, connectionFooter: true })
    expect(await page.evaluate(`['.rl-nav-brand', '.desktop-companion-head'].map(selector => document.querySelector(selector).getBoundingClientRect().height)`, decodeArray(decodeNumber))).toEqual([40, 40])
    expect(await page.evaluate(`(() => { const pane = document.querySelector('.rl-companion').getBoundingClientRect(); return [...document.querySelectorAll('.rl-companion .companion__header button, .rl-companion [role="tab"]')].every(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= pane.left && bounds.right <= pane.right; }); })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith('/web-latency'))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Stitch Settings exposes its sections and management entry points without changing backend state", async () => {
  pending = false
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/settings`)
    await wait(page, `document.querySelector('main[data-surface="settings"] [aria-label="Machine & Backend"]')`)
    expect(await page.evaluate(`!!document.querySelector('nav[aria-label="Settings sections"]')`, decodeBoolean)).toBe(true)
    const navigation = await page.evaluate(`document.querySelector('nav[aria-label="Settings sections"]').textContent`, decodeString)
    for (const label of ["Machine & Backend", "Models & Providers", "MCP", "Updates", "Appearance", "Session display", "Keyboard shortcuts"]) expect(navigation).toContain(label)
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "stitch-settings.png"), Buffer.from(await page.screenshot(), "base64"))
  } finally { await page.close() }
}, 30_000)

test("Stitch starter commands stage an editable draft without creating a Session", async () => {
  pending = false
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/chat`)
    await wait(page, `document.querySelector('[data-new-chat] .rl-capsule textarea')`)
    await page.evaluate(`(() => { if (document.querySelector('.rl-companion')) document.querySelector('.rl-companion-toggle').click(); })()`)
    expect(await page.evaluate(`document.querySelectorAll('[aria-label="Starter commands"] button').length`, decodeNumber)).toBe(3)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "stitch-new-chat.png"), Buffer.from(await page.screenshot(), "base64"))
    await message(page, "Keep this unsent draft")
    expect(await page.evaluate(`[...document.querySelectorAll('[aria-label="Starter commands"] button')].every(button => button.disabled)`, decodeBoolean)).toBe(true)
    await page.evaluate(`document.querySelector('[aria-label="Starter commands"] button').click()`)
    expect(await page.evaluate(`document.querySelector('[data-new-chat] .rl-capsule textarea').value`, decodeString)).toBe("Keep this unsent draft")
    await message(page, "")
    const selected = await page.evaluate(`(() => { const button = document.querySelector('[aria-label="Starter commands"] button'); const text = button.textContent; button.click(); return text; })()`, decodeString)
    expect(await page.evaluate(`document.querySelector('[data-new-chat] .rl-capsule textarea').value`, decodeString)).toBe(`${selected} `)
    expect(await page.evaluate(`document.activeElement === document.querySelector('[data-new-chat] .rl-capsule textarea')`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Stitch provider inspection keeps the list beside its connection details", async () => {
  pending = false
  providerScene = true
  const page = await openReference()
  try {
    await command(page, "Connect providers")
    await wait(page, `document.querySelector('dialog[open] [aria-label="Providers"]')`)
    await wait(page, `document.querySelector('dialog[open] .provider-picker button')?.textContent.includes('Synthetic Provider')`)
    await page.evaluate(`document.querySelector('dialog[open] .provider-picker button').click()`)
    await wait(page, `document.querySelector('dialog[open] [aria-label="Provider connection"]')?.textContent.includes('Synthetic browser sign-in')`)
    expect(await page.evaluate(`(() => { const list = document.querySelector('dialog[open] [aria-label="Providers"]'); const detail = document.querySelector('dialog[open] [aria-label="Provider connection"]'); return !!detail && list.getBoundingClientRect().right <= detail.getBoundingClientRect().left; })()`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "stitch-providers.png"), Buffer.from(await page.screenshot(), "base64"))
  } finally { await page.close() }
}, 30_000)

async function clickText(page: Page, selector: string, label: string) {
  await wait(page, `[...document.querySelectorAll(${JSON.stringify(selector)})].some(element => element.textContent.trim() === ${JSON.stringify(label)})`)
  await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(element => element.textContent.trim() === ${JSON.stringify(label)}).click()`)
}

test("Desktop provider cards switch the default credential through the existing integration route", async () => {
  prepareImplementedSurface()
  let active = "cred_work"
  sceneRead = call => {
    if (call.route === "/api/integration") return { location, data: [{ id: "synthetic", name: "Synthetic Provider", methods: [{ type: "key", label: "Synthetic API key" }, { type: "oauth", id: "browser", label: "Synthetic browser sign-in" }, { type: "oauth", id: "headless", label: "Synthetic headless sign-in" }], connections: ["work", "personal"].map(name => ({ type: "credential", id: `cred_${name}`, label: name, active: active === `cred_${name}`, kind: "oauth" })) }] }
    if (call.method === "POST" && call.route === "/api/credential/cred_personal/activate") { active = "cred_personal"; return new Response(null, { status: 204 }) }
    return undefined
  }
  const page = await openReference()
  try {
    await command(page, "/connect", "command-palette-connect.png")
    await clickContaining(page, '.provider-picker button', "Synthetic Provider")
    const cards = `[...document.querySelectorAll('.desktop-credential-card')]`
    await wait(page, `${cards}.length === 2`)
    expect(await page.evaluate(`${cards}.map(card => card.querySelector('.desktop-state-badge').textContent.trim())`, decodeArray(decodeString))).toEqual(["Default", "Not default"])
    await clickText(page, '.desktop-credential-card button', "Set default")
    await wait(page, `${cards}[1]?.querySelector('.desktop-state-badge')?.textContent.trim() === 'Default'`)
    expect(await page.evaluate(`!document.querySelector('.desktop-credential-list').textContent.includes('· true') && !document.querySelector('.desktop-credential-list').textContent.includes('· false') && document.querySelector('input[type="password"]') !== null`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method === "POST" && call.route.includes("/credential/")).map(call => call.route)).toEqual(["/api/credential/cred_personal/activate"])
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "providers-default-profile.png"), Buffer.from(await page.screenshot(), "base64"))
  } finally { await page.close() }
}, 30_000)

test("Desktop tools keep an Artifacts read failure in its tab and expose semantic Dots state", async () => {
  prepareImplementedSurface()
  sceneRead = call => {
    if (call.route === "/api/artifact") return new Response(JSON.stringify({ message: "Synthetic artifact read refused" }), { status: 500, headers: { "content-type": "application/json" } })
    return undefined
  }
  const page = await openReference()
  try {
    await command(page, "/status")
    for (const [index, label] of ["Status & Debug", "Agents & Skills", "Browser", "Remote & Pairing", "Artifacts & Plugins", "Dots"].entries()) {
      await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="tab"]')].find(tab => tab.textContent.trim() === ${JSON.stringify(label)}).focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      const panel = `document.querySelector('dialog[open] [role="tabpanel"]')`
      await wait(page, `${panel}?.getAttribute('aria-label') === ${JSON.stringify(label)} && !document.querySelector('dialog[open]').textContent.includes('Reading status…')`)
      if (label === "Artifacts & Plugins") await wait(page, `${panel}?.querySelector('[role="alert"]')?.textContent.includes('Artifacts could not be read')`)
      else expect(await page.evaluate(`!document.querySelector('dialog[open]').textContent.includes('Artifacts could not be read')`, decodeBoolean)).toBe(true)
      if (label === "Dots") expect(await page.evaluate(`(() => { const text = document.querySelector('dialog[open] section[aria-label="Dots computer access"]').innerText.split(/\\s+/); return text.includes('Disabled') && !text.includes('true') && !text.includes('false'); })()`, decodeBoolean)).toBe(true)
      if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, `system-tab-${index + 1}.png`), Buffer.from(await page.screenshot(), "base64"))
    }
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 40_000)

async function clickContaining(page: Page, selector: string, label: string) {
  await wait(page, `[...document.querySelectorAll(${JSON.stringify(selector)})].some(element => element.textContent.includes(${JSON.stringify(label)}))`)
  await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(element => element.textContent.includes(${JSON.stringify(label)})).click()`)
}

async function companion(page: Page, tab: string) {
  await page.evaluate(`(() => { if (!document.querySelector('.rl-companion')) document.querySelector('.rl-companion-toggle').click(); })()`)
  await clickText(page, '.rl-companion [role="tab"]', tab)
  await wait(page, `document.querySelector('.rl-companion [role="tab"][aria-selected="true"]')?.textContent.trim() === ${JSON.stringify(tab)}`)
}

test("Desktop shows the full Companion breakdown and wraps long Activity rows", async () => {
  referenceScene = true
  captureScene = true
  pending = false
  const long = "UnbrokenActivityDescription".repeat(16)
  sceneRead = call => {
    if (call.route === "/api/shell") return { location, data: [{ id: "sh_synthetic", status: "running", command: `bun test ${long}`, cwd: `/synthetic/${long}`, shell: "sh", file: "output", time: { started: 1 }, metadata: { sessionID: "ses_test" } }] }
    if (call.route.endsWith("/subagent")) return { data: [{ ...processTask(), description: long, state: "running", question: undefined, progress: { text: long, time: 2 } }], summary: { total: 1, active: 1 }, cursor: {} }
    if (call.route.endsWith("/diagnostics")) return { data: { model: selection(), context: { total: 12_000, limit: 200_000 }, tokens: { uncachedInput: 4000, output: 600, reasoning: 200, cacheRead: 8000, cacheWrite: 0 }, cache: { eligible: 8000, mechanism: "provider-reported", readReported: true, writeReported: true } } }
    return undefined
  }
  const page = await open()
  try {
    await companion(page, "Context")
    await wait(page, `document.querySelector('.companion__context-breakdown') && document.querySelector('#companion-context').textContent.includes('Session usage')`)
    expect(await page.evaluate(`(() => {
      const pane = document.querySelector('#companion-context .rl-pane-body'), dl = pane.querySelector('.companion__context-breakdown');
      const room = pane.clientWidth - parseFloat(getComputedStyle(pane).paddingLeft) - parseFloat(getComputedStyle(pane).paddingRight);
      return dl.clientWidth >= room - 1 && [pane, dl].every(el => el.scrollWidth <= el.clientWidth) && [...dl.children].every(row => [...row.children].every(cell => cell.clientWidth > 0 && cell.scrollWidth <= cell.clientWidth));
    })()`, decodeBoolean)).toBe(true)
    const diagnostics = `([...document.querySelectorAll('#companion-context summary')].find(row => row.textContent.trim() === 'Diagnostics'))`
    expect(await page.evaluate(`['Diagnostics', 'Loaded child task costs', 'Compaction history'].every(label => [...document.querySelectorAll('#companion-context details:not([open]) > summary')].some(row => row.textContent.trim() === label && row.querySelector('svg')))`, decodeBoolean)).toBe(true)
    await page.evaluate(`${diagnostics}.focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `${diagnostics}.parentElement.open`)
    expect(await page.evaluate(`(() => { const body = ${diagnostics}.parentElement; const value = [...body.querySelectorAll('dt')].find(term => term.textContent === 'Context')?.nextElementSibling; return !!value && value.textContent.includes('200000') && value.clientWidth >= body.clientWidth * .8 && value.scrollWidth <= value.clientWidth && body.scrollWidth <= body.clientWidth; })()`, decodeBoolean)).toBe(true)
    for (const tab of ["Activity", "Running"]) {
      await companion(page, tab)
      const panel = JSON.stringify(`#companion-${tab.toLowerCase()}`)
      await wait(page, `document.querySelector(${panel}).textContent.includes(${JSON.stringify(long)})`)
      expect(await page.evaluate(`(() => { const panel = document.querySelector(${panel}), rows = [...panel.querySelectorAll('.rl-activity-row')]; return rows.length >= 2 && [panel, ...rows].every(el => el.scrollWidth <= el.clientWidth) && rows.every(row => row.querySelector('svg') && getComputedStyle(row).borderTopWidth === '0px') && [...panel.querySelectorAll('.rl-activity-row :is(strong, small)')].every(text => getComputedStyle(text).whiteSpace === 'normal' && text.scrollWidth <= text.clientWidth); })()`, decodeBoolean)).toBe(true)
    }
  } finally { await page.close() }
}, 30_000)

test("Desktop transcript omits routine notices and keeps actionable messages and trailing prompts", async () => {
  referenceScene = true
  pending = false
  const long = "UnbrokenPrompt".repeat(90)
  const notice = (id: string, text: string, description: string | undefined, metadata: Record<string, unknown>) => ({ id, type: "synthetic", sessionID: "ses_test", text, description, metadata, time: { created: 503 } })
  sceneRead = call => call.route === "/api/session/ses_test/snapshot" ? {
    sourceEpoch: "synthetic", session: session("ses_test"), watermark: { type: "log.synced", aggregateID: "ses_test", seq: 1000 },
    messages: [...transcript().map(entry => entry.type === "user" ? { ...entry, text: `\`\`\`txt\n${long}\n\`\`\`` } : entry),
      notice("msg_repeated_child", "Subagent notification", "Subagent notification", { source: "subagent_notification", type: "completed", childID: "ses_child" }),
      notice("msg_project_progress", "Project notification", "Project notification", { source: "project_notification", event: "progress", memberSessionID: "ses_other", title: "Builder" }),
      notice("msg_project_review", "Project notification", "Project notification", { source: "project_notification", event: "review", memberSessionID: "ses_other", title: "Builder" }),
      notice("msg_parent_answer", 'Parent answer:\n{"questionID":"q1","text":"Use the retained cursor"}', "Parent answer", { source: "subagent_parent", kind: "answer", questionID: "q1" }),
      notice("msg_goal_steer", "Verify the new cursor", "Goal steer", { autonomy: { goal: true } }),
    ],
  } : undefined
  const page = await open()
  try {
    await wait(page, `document.querySelector('#turn-msg_goal_steer')`)
    expect(await page.evaluate(`!document.querySelector('#turn-msg_repeated_child, #turn-msg_project_progress') && document.querySelector('#turn-msg_project_review a')?.getAttribute('href').endsWith('/sessions/ses_other') && document.querySelector('#turn-msg_parent_answer').textContent.includes('Use the retained cursor') && document.querySelector('#turn-msg_goal_steer').textContent.includes('Verify the new cursor')`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => {
      const turn = document.querySelector('#turn-msg_prompt_239[data-speaker="user"]'), bubble = turn.querySelector('.transcript-message__bubble'), attachment = turn.querySelector('.conversation__chip'), receipt = turn.querySelector('[aria-label="Message created"]'), right = element => element.getBoundingClientRect().right;
      return { noAuthor: !turn.querySelector('.transcript-message__author'), sized: bubble.clientWidth <= turn.clientWidth * .78 + 1, trailing: [bubble, attachment, receipt].map(el => Math.abs(right(el) - right(turn)) <= 1), fits: [turn, bubble, bubble.querySelector('pre')].map(el => el.scrollWidth <= el.clientWidth), attachment: attachment.textContent, border: getComputedStyle(bubble).borderTopWidth };
    })()`, decodeRecord)).toEqual({ noAuthor: true, sized: true, trailing: [true, true, true], fits: [true, true, true], attachment: "restored-notes.txt", border: "0px" })
    const header = await page.evaluate(`(() => { const title = document.querySelector('.rl-top .rl-title'), status = document.querySelector('.rl-presence'), actions = document.querySelector('.rl-top-actions'), head = document.querySelector('.rl-top'); const range = document.createRange(); range.selectNodeContents(status); const ink = range.getBoundingClientRect(), bounds = status.getBoundingClientRect(); return { connected: status.textContent.includes('Connected · Shared backend'), gap: Math.round(bounds.left - title.getBoundingClientRect().right), overflow: ink.right - bounds.right, rendered: bounds.width, scroll: status.scrollWidth, trailing: Math.round(head.getBoundingClientRect().right - actions.getBoundingClientRect().right - parseFloat(getComputedStyle(head).paddingRight)) }; })()`, decodeRecord)
    expect(header).toMatchObject({ connected: true, gap: 12, trailing: 0 })
    expect(decodeNumber(header.overflow), JSON.stringify(header)).toBeLessThanOrEqual(0.5)
    await clickText(page, '#turn-msg_project_review a', 'Open')
    await wait(page, `location.hash === '#/sessions/ses_other'`)
    expect(clipboard).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop rotates only the Working arc and keeps it static when motion is disabled", async () => {
  referenceScene = true
  pending = false
  running = true
  const page = await open()
  try {
    await page.setReducedMotion(false)
    await page.evaluate(`document.documentElement.dataset.animations = 'on'`)
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.started', data: { sessionID: 'ses_test' } })`)
    const strip = `.desktop-transient-activity`
    const icon = `${strip} .desktop-native-badge svg`
    await wait(page, `document.querySelector('${icon}')`)
    expect(await page.evaluate(`(() => { const strip = document.querySelector('${strip}'), icon = document.querySelector('${icon}'); const animations = strip.getAnimations({ subtree: true }); const motion = animations.find(item => item.effect.target === icon); if (!motion) return { name: getComputedStyle(icon).animationName }; motion.pause(); motion.currentTime = motion.effect.getComputedTiming().duration / 4; const turn = new DOMMatrix(getComputedStyle(icon).transform); return { name: getComputedStyle(icon).animationName, turn: Math.abs(turn.a) < .001 && Math.abs(turn.b - 1) < .001 && Math.abs(turn.c + 1) < .001 && Math.abs(turn.d) < .001, onlyArc: animations.length === 1, continuous: motion.effect.getComputedTiming().iterations === Infinity }; })()`, decodeRecord)).toEqual({ name: "desktop-spin", turn: true, onlyArc: true, continuous: true })
    await page.setReducedMotion(true)
    await wait(page, `getComputedStyle(document.querySelector('${icon}')).animationName === 'none'`)
    await page.setReducedMotion(false)
    await page.evaluate(`document.documentElement.dataset.animations = 'off'`)
    expect(await page.evaluate(`getComputedStyle(document.querySelector('${icon}')).animationName`, decodeString)).toBe("none")
  } finally { await page.close() }
}, 30_000)

test("Desktop copies fenced code through native clipboard without a browser clipboard", async () => {
  referenceScene = true
  pending = false
  const code = "  function cursor() {\n\n    return retained\n  }"
  replyText = `# Safe sample\n\n\`\`\`typescript\n${code}\n\`\`\``
  const page = await open()
  try {
    const button = `document.querySelector('#turn-msg_response .transcript-md__code-head button')`
    await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })`)
    expect(await page.evaluate(`(() => { const pre = document.querySelector('#turn-msg_response .transcript-md__code pre'); return pre.textContent === ${JSON.stringify(code)} && [pre, pre.querySelector('code'), pre.closest('.transcript-md')].every(el => getComputedStyle(el).userSelect === 'text') && ${button}.querySelector('svg') !== null; })()`, decodeBoolean)).toBe(true)
    clipboardFailure = true
    await page.evaluate(`${button}.focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `${button}.textContent.trim() === 'Copy failed'`)
    expect(clipboard).toEqual([])
    clipboardFailure = false
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `${button}.textContent.trim() === 'Copied'`)
    expect(clipboard).toEqual([code])
  } finally { await page.close() }
}, 30_000)

test("Desktop opens a 600-model catalog from both composer chips and applies selections", async () => {
  pending = false
  currentVariant = "low"
  const catalog = [model, ...Array.from({ length: 599 }, (_, index) => ({ ...model, id: `model-${index}`, modelID: `model-${index}`, name: `Catalog model ${index}`, providerID: `provider-${index % 12}` }))]
  let selected: { id: string; providerID: string; variant?: string } = selection()
  sceneRead = call => {
    if (call.route === "/api/model") return { location, data: catalog }
    if (call.route === "/api/session/ses_test") return { data: { ...session("ses_test"), model: selected } }
    if (call.method === "POST" && call.route === "/api/session/ses_test/model") {
      const value = decodeRecord(call.body.model)
      selected = { id: decodeString(value.id), providerID: decodeString(value.providerID), ...(typeof value.variant === "string" ? { variant: value.variant } : {}) }
      return new Response(null, { status: 204 })
    }
    return undefined
  }
  const page = await open()
  try {
    const openCatalog = async (chip: "model" | "effort", expected: number) => {
      const selector = `.composer-chip--${chip}`
      await wait(page, `document.querySelector('${selector}:enabled')`)
      const elapsed = await page.evaluate(`new Promise(resolve => { const chip = document.querySelector('${selector}'); chip.focus(); const start = performance.now(); chip.click(); requestAnimationFrame(() => resolve(performance.now() - start)); })`, decodeNumber)
      expect(elapsed).toBeLessThan(1000)
      expect(await page.evaluate(`document.querySelectorAll('.model-popover [role="option"]').length`, decodeNumber)).toBe(expected)
    }
    await openCatalog("effort", 600)
    await page.pressEscape()
    await wait(page, `!document.querySelector('.model-popover') && document.activeElement.matches('.composer-chip--effort')`)
    await openCatalog("model", 600)
    await page.evaluate(`(() => { const input = document.querySelector('.model-popover input'); input.focus(); input.value = 'Catalog model 598'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
    await clickText(page, '.model-popover [role="option"]', 'Catalog model 598')
    await wait(page, `!document.querySelector('.model-popover') && document.querySelector('.composer-chip--model').textContent.includes('Catalog model 598')`)
    expect(selected).toEqual({ id: "model-598", providerID: "provider-10" })
    await page.navigate(`${origin}/#/chat`)
    await wait(page, `document.querySelector('[data-new-chat] .composer-chip--model')?.textContent.includes('Synthetic Model')`)
    await openCatalog("model", 600)
    await page.pressEscape()
    await wait(page, `!document.querySelector('.model-popover') && document.activeElement.matches('.composer-chip--model')`)
    await openCatalog("effort", 600)
    await page.evaluate(`document.querySelector('.model-popover [role="slider"]').focus()`)
    await page.pressKey("End", "End", 35)
    await wait(page, `document.querySelector('.composer-chip--effort').textContent.includes('High')`)
    expect(await page.evaluate(`document.activeElement.matches('.model-popover [role="slider"]')`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
    expect(owned!.calls.filter(call => call.method === "POST" && call.route.endsWith("/model"))).toHaveLength(1)
  } finally { await page.close() }
}, 30_000)

async function tools(page: Page, tab: string) {
  await command(page, "Open shell, editor context, side-chat and prompt tools")
  await clickText(page, 'dialog[open] [role="radio"]', tab)
}

async function captureReference(page: Page, id: string, expected: string, writes: readonly string[] = []) {
  await wait(page, expected)
  expect(await page.evaluate(expected, decodeBoolean)).toBe(true)
  await wait(page, `document.fonts.status === 'loaded'`)
  expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  expect(await page.evaluate(`[innerWidth, innerHeight]`, decodeArray(decodeNumber))).toEqual([1440, 900])
  const geometry = await page.evaluate(`(() => {
    const rail = document.querySelector('.rl-nav').getBoundingClientRect();
    const main = document.querySelector('.rl-main').getBoundingClientRect();
    return { railWidth: rail.width, alignedTop: rail.top === main.top, adjacentColumns: Math.abs(rail.right - main.left) <= 1, conversation: !!document.querySelector('.conversation'), headerHeight: document.querySelector('.rl-top')?.getBoundingClientRect().height ?? null };
  })()`, (value: unknown) => { const result = decodeRecord(value); return { railWidth: (decodeNumber)(result["railWidth"]), alignedTop: (decodeBoolean)(result["alignedTop"]), adjacentColumns: (decodeBoolean)(result["adjacentColumns"]), conversation: (decodeBoolean)(result["conversation"]), headerHeight: (decodeNullable(decodeNumber))(result["headerHeight"]) } })
  expect({ railWidth: geometry.railWidth, alignedTop: geometry.alignedTop, adjacentColumns: geometry.adjacentColumns }).toEqual({ railWidth: 256, alignedTop: true, adjacentColumns: true })
  if (geometry.conversation) expect(geometry.headerHeight).toBe(40)
  expect(await page.evaluate(`[...document.querySelectorAll('dialog[open]')].every(dialog => { const bounds = dialog.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight; })`, decodeBoolean)).toBe(true)
  expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency")).map(call => `${call.method} ${call.route}`)).toEqual([...writes])
  const output = process.env.YCODING_DESKTOP_CAPTURE_DIR
  await page.evaluate(`Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))`)
  const correctedOwners: Readonly<Record<string, string>> = {
    "37f03514": `(() => { const agents = document.querySelector('.desktop-agent-list'), skills = document.querySelector('.desktop-skill-list'), inspector = document.querySelector('[aria-label="Catalog item details"]'); return !!inspector && agents.getBoundingClientRect().right <= skills.getBoundingClientRect().left && skills.getBoundingClientRect().right <= inspector.getBoundingClientRect().left && inspector.getBoundingClientRect().width > 300; })()`,
    "072ae46f": `(() => { const list = document.querySelector('[aria-label="Artifact list"]'), detail = document.querySelector('[aria-label="Artifact details"]'); return !!list && !!detail && list.getBoundingClientRect().right <= detail.getBoundingClientRect().left && list.getBoundingClientRect().height > 100; })()`,
    "6fc8e392": `!!document.querySelector('[aria-label="Backend connection"] dl') && !!document.querySelector('[aria-label="Backend connection"] code')`,
    "abd33e8b": `!!document.querySelector('[aria-label="Browser pairing"] h3') && !!document.querySelector('[aria-label="Remote Session relay"] button')`,
    "c3668f0e": `!!document.querySelector('section[aria-label="Dots computer access"] h3') && !!document.querySelector('section[aria-label="Dots computer access"] button')`,
    "35bf7193": `document.querySelector('dialog[open]').getBoundingClientRect().width === 740 && document.querySelector('dialog[open]').getBoundingClientRect().height < 750`,
    "bf4de94b": `document.querySelector('dialog[open]').getBoundingClientRect().width === 680 && document.querySelector('dialog[open]').getBoundingClientRect().height < 750`,
    "fea2212a": `(() => { const dialog = document.querySelector('dialog[open]'), error = dialog.querySelector('[role="alert"]'), style = error && getComputedStyle(error); return dialog.getBoundingClientRect().width === 520 && dialog.getBoundingClientRect().height < 750 && style?.borderTopStyle === 'solid' && parseFloat(style.paddingTop) >= 12; })()`,
    "5e357147": `document.querySelector('dialog[open]').getBoundingClientRect().width === 560 && document.querySelector('dialog[open]').getBoundingClientRect().height < 750`,
    "f4476b36": `document.querySelector('dialog[open]').getBoundingClientRect().height < 750`,
    "b605fc0a": `(() => { const row = [...document.querySelectorAll('[aria-label="MCP servers"] article')].find(row => row.textContent.includes('Synthetic server is unavailable')); return !!row && row.querySelector('header')?.querySelectorAll('button').length === 3 && !!row.querySelector('[role="alert"]'); })()`,
    "c3831b3b": `(() => { const editor = document.querySelector('[aria-label="Shortcut editor"]'), input = editor?.querySelector('input'), command = editor?.querySelector('[role="combobox"]'), list = document.querySelector('[aria-label="Assigned shortcuts"]'), rows = [...list.querySelectorAll('button')], commands = rows.filter(row => row.querySelector('span')?.textContent === 'Commands'); return !!command && !!input && Math.abs(input.getBoundingClientRect().top - command.getBoundingClientRect().top) <= 1 && commands.length === 1 && commands[0].querySelectorAll('kbd').length === 2 && rows.every(row => Math.abs(row.getBoundingClientRect().width * 2 + 24 - list.getBoundingClientRect().width) <= 1); })()`,
    "e0c0c425": `document.querySelectorAll('input[role="switch"]').length >= 3 && !!document.querySelector('input[type="range"][aria-label="Sound volume (%)"]') && !!document.querySelector('output[aria-label="Sound volume"]')`,
    "936d1769": `!!document.querySelector('.model-popover input[placeholder="Search models"]') && !!document.querySelector('.model-popover [role="listbox"]') && !!document.querySelector('.model-popover [role="slider"][aria-label="Reasoning effort"]')`,
    "ffbef175": `!!document.querySelector('.desktop-context-ring svg[role="img"]') && !!document.querySelector('[aria-label="Estimated context token breakdown"]') && document.querySelector('.desktop-context--ring .companion__context-bar').getBoundingClientRect().height === 0`,
    "4ed4c89a": `(() => { const empty = document.querySelector('[aria-label="Empty transcript"]'), frame = document.querySelector('.rl-scroll'); if (!empty || !frame) return false; const e = empty.getBoundingClientRect(), f = frame.getBoundingClientRect(); return Math.abs((e.top + e.bottom) / 2 - (f.top + f.bottom) / 2) < 80; })()`,
    "f941de34": `(() => { const intro = document.querySelector('.rl-intro'), mark = intro?.querySelector('.rl-brand-mark'); if (!mark) return false; const parent = intro.getBoundingClientRect(), icon = mark.getBoundingClientRect(); return Math.abs((parent.left + parent.right) / 2 - (icon.left + icon.right) / 2) <= 1; })()`,
    "d870471b": `!!document.querySelector('details[aria-label="Blockers & escalations"]') && !document.querySelector('details[aria-label="Blockers & escalations"]').open`,
    "adedc0ab": `!!document.querySelector('details[aria-label="Ownership & drivers"]') && !document.querySelector('details[aria-label="Ownership & drivers"]').open && !!document.querySelector('details[aria-label="Pending requests & escalations"]')`,
    "61265341": `!!document.querySelector('table[aria-label="Incident report"]') && [...document.querySelectorAll('table[aria-label="Incident report"] th')].map(cell => cell.textContent).join('|') === 'Provider ID|Model ID|Agent|Fallbacks|Escalated|Rejected|Last'`,
  }
  for (const [prefix, check] of Object.entries(correctedOwners)) if (id.startsWith(prefix)) expect(await page.evaluate(check, decodeBoolean)).toBe(true)
  const components = await page.evaluate(`Object.fromEntries(['.rl-top', '.desktop-companion-head', '.rl-companion', '.rl-page-head', '.ws-workspaces-detail', '.desktop-project-inspector', '.desktop-selected-inspector', '.desktop-dialog', '.desktop-dialog__head', '.desktop-diff > nav', '.desktop-agent-list', '.palette', '.palette__search', '.confirm'].flatMap(selector => { const element = document.querySelector(selector); if (!element || !element.getClientRects().length) return []; const box = element.getBoundingClientRect(), style = getComputedStyle(element); return [[selector, { width: box.width, height: box.height, top: box.top, right: box.right, bottom: box.bottom, left: box.left, background: style.backgroundColor, border: style.borderColor, radius: style.borderRadius, padding: style.padding }]]; }))`, decodeDictionary((value: unknown) => { const result = decodeRecord(value); return { width: (decodeNumber)(result["width"]), height: (decodeNumber)(result["height"]), top: (decodeNumber)(result["top"]), right: (decodeNumber)(result["right"]), bottom: (decodeNumber)(result["bottom"]), left: (decodeNumber)(result["left"]), background: (decodeString)(result["background"]), border: (decodeString)(result["border"]), radius: (decodeString)(result["radius"]), padding: (decodeString)(result["padding"]) } }))
  const independent: Record<string, readonly (readonly [string, "width" | "height" | "left", number])[]> = {
    "70ca078090f64321b1f264ab4cdc88e2": [[".rl-page-head", "height", 48], [".ws-workspaces-detail", "width", 420]],
    "9121b2a17ffb4d81a7f021e6325329f4": [[".rl-page-head", "height", 44], [".desktop-project-inspector", "width", 400]],
    "825f05dcc7724e0fb83ffb3667c0d627": [[".desktop-diff > nav", "width", 340], [".desktop-dialog", "width", 1080], [".desktop-dialog", "height", 720], [".desktop-dialog__head", "height", 57]],
    "3028c78f000946fca0c223267169bffd": [[".desktop-diff > nav", "width", 240], [".desktop-diff > nav", "left", 256]],
    "54caadddf8524b49911de95d58636e7a": [[".desktop-diff > nav", "width", 220], [".desktop-diff > nav", "left", 256]],
    "9715087f99c9431a938a353cb05ca9a9": [[".rl-page-head", "height", 40]],
    "d870471b750a42df8e17ff0fb5d29e67": [[".rl-top", "height", 40], [".desktop-selected-inspector", "width", 320]],
    "adedc0ab360c471d9996962413cf247d": [[".rl-page-head", "height", 56], [".desktop-selected-inspector", "width", 320]],
    "37f0351447f34e448556eb9d7b6276c9": [[".desktop-dialog__head", "height", 48], [".desktop-dialog", "width", 1080], [".desktop-agent-list", "width", 320]],
    "80928cfab4bc4b20b3042c2f089574ef": [[".desktop-dialog__head", "height", 44], [".desktop-dialog", "width", 660]],
    "d584aabe84d942089c45a938ed4d4c8c": [[".desktop-dialog__head", "height", 48], [".desktop-dialog", "width", 960]],
    "6fc8e392a42b4433a08a7a1564e4b7d3": [[".desktop-dialog__head", "height", 88], [".desktop-dialog", "width", 980]],
    "f4476b36068c4c41adbb0f97a88e33d8": [[".desktop-dialog", "width", 580]],
    "309bc47fe0d642a2a9775391b92c1451": [[".palette", "width", 640], [".palette__search", "height", 48]],
    "359f63a0638846f6b5f764c0a9e44c38": [[".confirm", "width", 460]],
    "6ac6a9dd73b6451fa41dfa46d4d18b8b": [[".desktop-dialog__head", "height", 48], [".desktop-dialog", "width", 920]],
  }
  for (const [selector, dimension, value] of independent[id] ?? []) expect(components[selector]?.[dimension]).toBe(value)
  if (["825f05dcc7724e0fb83ffb3667c0d627", "3028c78f000946fca0c223267169bffd", "54caadddf8524b49911de95d58636e7a"].includes(id)) expect(await page.evaluate(`['.desktop-diff__file', '.desktop-diff__hunk'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor)`, decodeArray(decodeString))).toEqual(["rgb(11, 17, 21)", "rgb(14, 21, 26)"])
  if (id === "825f05dcc7724e0fb83ffb3667c0d627") {
    expect(await page.evaluate(`(() => { const head = document.querySelector('dialog[open] header'), box = head.getBoundingClientRect(); return { scope: !!head.querySelector('[role="radiogroup"][aria-label="Diff scope"]'), totals: [...head.querySelectorAll('[aria-label="Diff totals"] > span')].map(span => span.textContent), refresh: [...head.querySelectorAll('button')].some(button => button.textContent.trim() === 'Refresh'), contained: [...head.querySelectorAll('button, [role="radiogroup"], output')].every(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= box.left && bounds.right <= box.right && bounds.top >= box.top && bounds.bottom <= box.bottom; }) }; })()`, decodeRecord)).toEqual({ scope: true, totals: ["2 files", "+2", "−2"], refresh: true, contained: true })
  }
  if (output) {
    await Bun.write(path.join(output, `${id}.png`), Buffer.from(await page.screenshot(), "base64"))
    await Bun.write(path.join(output, `${id}.geometry.json`), JSON.stringify(components, null, 2))
  }
  console.log("Stitch source capture", id)
}

type ReferenceCase = { id: string; label: string; prepare?: () => void; ready?: string; show: (page: Page) => Promise<void>; expected: string; writes?: readonly string[]; afterCapture?: (page: Page) => Promise<void> }
const referenceCases: readonly ReferenceCase[] = [
  {
    id: "247859938ae742cea7c31d352e62ea80", label: "idle conversation with attributed activity",
    show: async page => { await companion(page, "Activity") },
    expected: `document.querySelector('#turn-msg_response')?.textContent.includes('Initial synthetic response') && document.querySelector('.rl-companion')?.textContent.includes('No subagent tasks')`,
  },
  {
    id: "4ed4c89ad7794d658a0b1f4898f10255", label: "empty canonical Session history",
    prepare: () => { sceneRead = call => call.route.endsWith("/snapshot") ? { sourceEpoch: "synthetic", session: session("ses_test"), messages: [], watermark: { type: "log.synced", aggregateID: "ses_test", seq: 0 } } : undefined },
    ready: `window.__desktopFixture.completed.sessionSnapshot > 0 && !document.querySelector('#turn-msg_response')`,
    show: async page => { await message(page, "") },
    expected: `window.__desktopFixture.completed.sessionSnapshot > 0 && !document.querySelector('.rl-thread article') && !!document.querySelector('.rl-capsule textarea')`,
  },
  {
    id: "4d7d498f3ac5407780179f5008b1c02d", label: "history read failure preserves the unsent composer",
    prepare: () => { sceneRead = call => call.route.endsWith("/snapshot") ? new Response(null, { status: 503 }) : undefined },
    ready: `[...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes('history'))`,
    show: async page => { await message(page, "Retain this draft while history is unavailable") },
    expected: `[...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes('history')) && document.querySelector('.rl-capsule textarea').value === 'Retain this draft while history is unavailable'`,
  },
  {
    id: "44adb2e99e704c8298c2a81db0b24496", label: "activity retains its first page when the next page fails",
    prepare: () => {
      familyEnabled = true
      sceneRead = call => call.route === "/api/session/ses_test/subagent" ? call.query.has("cursor") ? new Response(null, { status: 503 }) : { data: [processTask()], summary: { total: 2, active: 2 }, cursor: { next: "synthetic-next" } } : undefined
    },
    show: async page => { await companion(page, "Activity"); await clickText(page, '.rl-companion button', "Load more subagents") },
    expected: `document.querySelector('.rl-companion')?.textContent.includes('Synthetic waiting worker') && !!document.querySelector('.rl-companion [role="alert"]')`,
  },
  {
    id: "ffbef1756a384be48e4a6a2db500337b", label: "reported context and per-section diagnostics",
    show: async page => { await companion(page, "Context") },
    expected: `document.querySelector('.rl-companion')?.textContent.includes('Verify pagination') && !!document.querySelector('.companion__context-bar')`,
  },
  {
    id: "936d17691f6241e3819c91d4870c9aa6", label: "model and reported reasoning variants",
    show: async page => { await wait(page, `document.querySelector('.composer-chip--model')`); await page.evaluate(`document.querySelector('.composer-chip--model').click()`) },
    expected: `!!document.querySelector('.model-popover') && !!document.querySelector('[role="slider"]')`,
  },
  {
    id: "2c66dd75095b4881a87b9a76eb7374b6", label: "reported goal and autonomy without applying changes",
    show: async page => { await wait(page, `document.querySelector('.composer-policy-chip')`); await page.evaluate(`document.querySelector('.composer-policy-chip').click()`) },
    expected: `document.body.textContent.includes('Apply autonomy') && [...document.querySelectorAll('input,textarea')].some(input => input.value === sceneGoal)`.replace("sceneGoal", JSON.stringify(sceneAutonomy.goal.text)),
  },
  {
    id: "d809a506560e43e299c04a61ee9ea350", label: "canonical pending permission",
    prepare: () => { sceneRead = call => call.route.endsWith("/permission") ? { data: [scenePermission] } : undefined },
    show: async page => { await wait(page, `document.querySelector('.request')?.textContent.includes('src/pagination.ts')`) },
    expected: `document.querySelector('.request')?.textContent.includes('src/pagination.ts') && document.querySelectorAll('.request button').length > 0`,
  },
  {
    id: "2ff9628be7764a1080d725abc44e8591", label: "typed form validation before admission",
    prepare: () => { sceneRead = call => call.route === "/api/session/ses_test/form" ? { data: [{ id: "frm_scene", sessionID: "ses_test", title: "Synthetic numeric limit", fields: [{ key: "limit", title: "Limit", type: "number", required: true, minimum: 1, maximum: 10 }], time: { created: 1 } }] } : undefined },
    show: async page => { await wait(page, `document.querySelector('.request input[type="number"]')`); await page.evaluate(`(() => { const input = document.querySelector('.request input[type="number"]'); input.value = '20'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('blur', { bubbles: true })); input.closest('.request').scrollIntoView({ block: 'center' }); })()`) },
    expected: `!!document.querySelector('.request [aria-invalid="true"]')`,
  },
  {
    id: "5d43880ad7b241a8a89d8d3847741853", label: "multiple-choice and custom pending questions",
    prepare: () => { questionPending = true },
    show: async page => { await wait(page, `document.querySelector('.request')?.textContent.includes('Choose the synthetic targets')`) },
    expected: `document.querySelector('.request')?.textContent.includes('Local') && document.querySelector('.request')?.textContent.includes('Preview')`,
  },
  {
    id: "fb201f4e896b4fe4be502d02228c6766", label: "separate hard-review and permission decisions",
    prepare: () => { sceneRead = call => call.route.endsWith("/permission") ? { data: [scenePermission] } : call.route.endsWith("/guardrail/request") ? { data: [sceneGuardrail] } : undefined },
    show: async page => { await wait(page, `document.querySelectorAll('.request').length === 2`) },
    expected: `document.querySelectorAll('.request').length === 2 && [...document.querySelectorAll('.rl-decision-card')].some(card => card.textContent.includes('Hard review'))`,
  },
  ...(["3028c78f000946fca0c223267169bffd", "54caadddf8524b49911de95d58636e7a"] as const).map((id, index): ReferenceCase => ({
    id, label: index ? "captured changes in split mode" : "captured changes in unified mode",
    prepare: () => { sceneRead = call => call.route.endsWith("/file-change") ? { data: [scenePatch] } : undefined },
    show: async page => {
      await companion(page, "Changes")
      await clickText(page, '.rl-companion button', index ? "Split" : "Unified")
      await clickText(page, '.rl-companion button', "Open full changes page")
    },
    expected: `document.querySelector('.rl-companion[data-full="true"] .desktop-diff')?.getAttribute('data-view') === ${JSON.stringify(index ? "split" : "unified")} && document.querySelector('.rl-companion .desktop-diff')?.textContent.includes('src/pagination.ts') && document.querySelector('.rl-companion .desktop-diff')?.textContent.includes('pageSize')`,
    afterCapture: async page => {
      const placement = await page.evaluate(`(() => { const diff = document.querySelector('.rl-companion[data-full="true"] .desktop-diff'); return { toolbarBottom: diff.querySelector('.desktop-diff__toolbar').getBoundingClientRect().bottom, filePaneTop: diff.querySelector('nav').getBoundingClientRect().top, patchPaneTop: diff.querySelector('.desktop-diff__files').getBoundingClientRect().top }; })()`, (value: unknown) => { const result = decodeRecord(value); return { toolbarBottom: (decodeNumber)(result["toolbarBottom"]), filePaneTop: (decodeNumber)(result["filePaneTop"]), patchPaneTop: (decodeNumber)(result["patchPaneTop"]) } })
      console.log("Session diff placement", id, placement)
      expect(placement.toolbarBottom).toBeLessThanOrEqual(placement.filePaneTop)
      expect(placement.toolbarBottom).toBeLessThanOrEqual(placement.patchPaneTop)
    },
  })),
  {
    id: "825f05dcc7724e0fb83ffb3667c0d627", label: "Git working-tree diff list and patches",
    show: async page => { await command(page, "Git working-tree diff"); await wait(page, `document.querySelector('dialog[open] .desktop-diff__file')`); await clickText(page, 'dialog[open] [role="radio"]', "Unified"); await page.evaluate(`(() => { const input = [...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.trim() === 'Show selected file only')?.querySelector('input'); if (!input.checked) input.click(); })()`) },
    expected: `document.querySelector('dialog[open] .desktop-diff')?.textContent.includes('a.ts') && document.querySelector('dialog[open] .desktop-diff')?.textContent.includes('b.ts') && document.querySelector('dialog[open] .desktop-diff')?.getAttribute('data-view') === 'unified' && document.querySelectorAll('dialog[open] .desktop-diff__file').length === 1`,
    afterCapture: async page => { await clickText(page, 'dialog[open] [role="radio"]', "Automatic"); await page.evaluate(`(() => { const input = [...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.trim() === 'Show selected file only')?.querySelector('input'); if (input.checked) input.click(); })()`) },
  },
  {
    id: "309bc47fe0d642a2a9775391b92c1451", label: "command palette groups and canonical actions",
    show: async page => { await page.evaluate(`document.querySelector('.desktop__palette').click()`) },
    expected: `document.querySelector('.palette')?.textContent.includes('Providers & MCP') && document.activeElement === document.querySelector('.palette__input')`,
  },
  {
    id: "359f63a0638846f6b5f764c0a9e44c38", label: "revert confirmation before any admission",
    show: async page => { await command(page, "/undo") },
    expected: `!!document.querySelector('.confirm[open]') && document.querySelector('.confirm[open]')?.textContent.includes('restore')`,
  },
  {
    id: "f941de344e504c8583ac3a6a89e976da", label: "standalone new chat with supported starter commands",
    show: async page => { await page.navigate(`${origin}/#/chat`); await wait(page, `document.querySelector('[data-new-chat]')`); await page.evaluate(`(() => { if (document.querySelector('.rl-companion')) document.querySelector('.rl-companion-toggle').click(); })()`) },
    expected: `document.querySelectorAll('[aria-label="Starter commands"] button').length === 3 && document.querySelector('[data-new-chat]')?.textContent.includes('Start a conversation')`,
  },
  ...([
    ["3c1ec4a1812445abb88562e81231dd22", "Settings overview", "Machine & Backend"],
    ["322cf88622b84814b38ecfc0e9bbe5cb", "Session display preferences", "Session display"],
    ["c3831b3b0baf422e80584bafab051540", "keyboard binding editor", "Keyboard shortcuts"],
  ] as const).map(([id, label, section]): ReferenceCase => ({
    id, label,
    show: async page => {
      await page.navigate(`${origin}/#/settings`)
      await wait(page, `document.querySelector('nav[aria-label="Settings sections"]')`)
      if (section === "Machine & Backend") return
      await clickText(page, 'nav[aria-label="Settings sections"] button', section)
      await wait(page, `document.activeElement?.tagName === 'H3' && (document.activeElement.textContent.trim() === ${JSON.stringify(section)} || document.activeElement.closest('.st-section')?.getAttribute('aria-label') === ${JSON.stringify(section)})`)
    },
    expected: section === "Machine & Backend" ? `document.querySelector('nav[aria-label="Settings sections"]')?.getBoundingClientRect().top >= 0 && document.querySelector('nav[aria-label="Settings sections"]')?.getBoundingClientRect().bottom <= innerHeight` : `document.activeElement?.tagName === 'H3' && (document.activeElement.textContent.trim() === ${JSON.stringify(section)} || document.activeElement.closest('.st-section')?.getAttribute('aria-label') === ${JSON.stringify(section)}) && document.activeElement.getBoundingClientRect().top >= 0 && document.activeElement.getBoundingClientRect().bottom <= innerHeight`,
  })),
  {
    id: "e0c0c42546a64b9bae63a0a2405ee6ff", label: "notification and sound preferences",
    show: async page => { await page.navigate(`${origin}/#/settings`); await wait(page, `document.querySelector('[data-action-id="st-open-notifications"]')`); await page.evaluate(`document.querySelector('[data-action-id="st-open-notifications"]').click(); document.querySelector('[data-part="st-notify"]').scrollIntoView({ block: 'start' })`) },
    expected: `document.querySelector('[data-action-id="st-open-notifications"]')?.getAttribute('aria-expanded') === 'true' && document.querySelector('[data-part="st-notify"]')?.textContent.includes('Sound')`,
  },
  {
    id: "5e357147cdc24647befd44ce514bc8e2", label: "canonical theme choices without selecting a theme",
    show: async page => { await command(page, "Choose a theme") },
    expected: `document.querySelector('dialog[open] h2')?.textContent === 'Appearance' && !!document.querySelector('dialog[open] [aria-checked="true"]')`,
  },
  ...(["94251220f6b24c288ce33202fe86e567", "9121b2a17ffb4d81a7f021e6325329f4"] as const).map((id): ReferenceCase => ({
    id, label: "project list and selected member controls",
    show: async page => { await page.navigate(`${origin}/#/projects`); await wait(page, `document.body.textContent.includes('Synthetic project')`); await clickContaining(page, 'main button, main [role="option"]', "Synthetic project") },
    expected: `document.querySelector('main')?.textContent.includes('Synthetic master') && document.querySelector('main')?.textContent.includes('Synthetic member')`,
  })),
  {
    id: "9715087f99c9431a938a353cb05ca9a9", label: "Session directory with canonical waiting and running roots",
    prepare: () => { directoryStatus = true },
    show: async page => { await page.navigate(`${origin}/#/sessions`) },
    expected: `document.querySelector('main')?.textContent.includes('Sessions') && !!document.querySelector('main input[type="search"]')`,
  },
  {
    id: "70ca078090f64321b1f264ab4cdc88e2", label: "reported workspace and copy form before creation",
    show: async page => { await page.navigate(`${origin}/#/workspaces`); await wait(page, `document.querySelector('main')?.textContent.includes('Synthetic repository')`); await clickText(page, 'main button', "New copy") },
    expected: `document.querySelector('main')?.textContent.includes('Synthetic repository') && document.querySelector('main')?.textContent.includes('Create copy')`,
  },
  {
    id: "4bff4148cf26491587127a52f9570dcf", label: "usage and reported provider quota",
    show: async page => { await page.navigate(`${origin}/#/usage`) },
    expected: `document.querySelector('main')?.textContent.includes('Synthetic provider') && document.querySelector('main')?.textContent.includes('Daily requests')`,
  },
  {
    id: "6126534122d5459bb530beb1411c99f2", label: "model incident report without changing guidance",
    show: async page => { await page.navigate(`${origin}/#/usage`); await clickText(page, 'main button', "Usage dashboard and incidents"); await clickText(page, 'main button', "Read incident report") },
    expected: `document.querySelector('main')?.textContent.includes('Provider ID') && document.querySelector('main')?.textContent.includes('Fallbacks') && document.querySelector('main')?.textContent.includes('synthetic')`,
    writes: ["POST /api/usage/dashboard"],
  },
  ...([
    ["6fc8e392a42b4433a08a7a1564e4b7d3", "/status", "Synthetic model configuration requires review"],
    ["37f0351447f34e448556eb9d7b6276c9", "/agents", "Synthetic review"],
    ["d584aabe84d942089c45a938ed4d4c8c", "/browser", "unavailable"],
    ["abd33e8b09f3438990d96f759c3f4f08", "/remote", "off"],
    ["c3668f0e62cf459b9708788b015e8001", "/dots", "unavailable"],
  ] as const).map(([id, action, text]): ReferenceCase => ({
    id, label: `${action} reported management state`,
    prepare: () => { if (action === "/agents") sceneRead = call => call.route === "/api/agent" ? { location, data: [{ id: "synthetic-reviewer", name: "Synthetic reviewer", description: "Inspect the synthetic pagination boundary", mode: "subagent", hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] }] } : call.route === "/api/command" ? { location, data: [{ name: "synthetic-verify", description: "Verify the synthetic change", template: "Inspect the synthetic change" }] } : undefined },
    show: async page => { await command(page, action) },
    expected: `document.querySelector('dialog[open]')?.textContent.includes(${JSON.stringify(text)})${action === "/agents" ? ` && document.querySelector('dialog[open]')?.textContent.includes('Synthetic reviewer') && !document.querySelector('dialog[open]')?.textContent.includes('could not be read')` : ""}`,
  })),
  {
    id: "072ae46f74714289a7e13cb9bec036ac", label: "artifact identity, definition and metrics",
    show: async page => { await command(page, "/artifacts"); await clickText(page, 'dialog[open] button', "Details, metrics and history"); await clickText(page, 'dialog[open] button', "Preview promotion"); await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('Confirm preview')`); await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Confirm preview').scrollIntoView({ block: 'end' })`) },
    expected: `document.querySelector('dialog[open]')?.textContent.includes('Inspect the synthetic change.') && document.querySelector('dialog[open]')?.textContent.includes('Confirm preview')`,
    writes: ["POST /api/artifact/project/skill/synthetic-review/promotion"],
  },
  {
    id: "b605fc0a1b6f4c55a645935747f4e948", label: "connected and failed MCP servers with resources",
    show: async page => { await command(page, "/mcp") },
    expected: `document.querySelector('dialog[open]')?.textContent.includes('Pagination guide') && document.querySelector('dialog[open] [role="alert"]')?.textContent.includes('Synthetic server is unavailable')`,
  },
  {
    id: "35bf71933d5945eeb63ac9605785664d", label: "retained prompt stash before restoration",
    show: async page => {
      await page.evaluate(`localStorage.setItem('ycoding.desktop.prompt-stashes', JSON.stringify([{ id: 'stash_scene', text: 'Synthetic retained draft', files: [], agents: [], picks: [], createdAt: 1 }]))`)
      await command(page, "Stash or restore the prompt")
    },
    expected: `document.querySelector('dialog[open]')?.textContent.includes('Synthetic retained draft')`,
  },
  {
    id: "bf4de94bc265448a87ae20d91c0c5109", label: "unsent draft in the built-in editor fallback",
    show: async page => { await message(page, "Inspect the synthetic pagination change without sending it."); await command(page, "Edit the full prompt draft") },
    expected: `document.querySelector('dialog[open] textarea')?.value === 'Inspect the synthetic pagination change without sending it.'`,
  },
  {
    id: "fea2212a85a649968cdb4852537cec6d", label: "native save-port error without writing an export",
    prepare: () => { exportFailure = true },
    show: async page => { await command(page, "Export the transcript"); await clickText(page, 'dialog[open] button', "Save transcript…") },
    expected: `document.querySelector('dialog[open] [role="alert"]')?.textContent.includes('EACCES')`,
  },
  {
    id: "6ac6a9dd73b6451fa41dfa46d4d18b8b", label: "Session shell inspection without command execution",
    show: async page => { await tools(page, "Shell") },
    expected: `document.querySelector('dialog[open]')?.textContent.includes('Shell command') && [...document.querySelectorAll('dialog[open] [role="radio"]')].some(button => button.getAttribute('aria-checked') === 'true' && button.textContent.trim() === 'Shell')`,
    afterCapture: async page => {
      await page.pressKey("Escape", "Escape", 27)
      await companion(page, "Activity")
      await clickContaining(page, '.rl-companion button', "bun test test/session-page.test.ts")
      await wait(page, `document.querySelector('.rl-companion')?.textContent.includes('Synthetic pagination check: 6 passed, 0 failed') && window.__desktopFixture.completed.shellOutput > 0`)
      expect(await page.evaluate(`document.querySelector('.rl-companion')?.textContent.includes('Synthetic pagination check: 6 passed, 0 failed') && window.__desktopFixture.completed.shellOutput > 0`, decodeBoolean)).toBe(true)
    },
  },
  {
    id: "dc5b9536f52849ab8e396f963af693ad", label: "reported editor selection before admission",
    prepare: () => { ideEnabled = true },
    show: async page => { await tools(page, "Editor context") },
    expected: `document.querySelector('dialog[open] [aria-label="Reported IDE selection"]')?.textContent.includes('editor.ts') && document.querySelector('dialog[open] [aria-label="Reported IDE selection"]')?.textContent.includes('const sample = 1') && document.querySelector('dialog[open] textarea')?.value === '' && [...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Send editor context')?.disabled`,
  },
  {
    id: "f1b26a42d41f4531a16f98aa4962b685", label: "side-chat draft without opening a child Session",
    show: async page => { await tools(page, "Side chat"); await page.evaluate(`(() => { const input = document.querySelector('dialog[open] textarea'); input.value = 'Review the synthetic pagination boundary'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`) },
    expected: `document.querySelector('dialog[open] textarea')?.value === 'Review the synthetic pagination boundary' && document.querySelector('dialog[open]')?.textContent.includes('Open side chat')`,
  },
  {
    id: "35c98a608b9c40628e6e2c9bd1182e74", label: "child-to-parent message draft before sending",
    show: async page => { await page.navigate(`${origin}/#/sessions/ses_child`); await wait(page, `document.querySelector('#turn-msg_response')`); await tools(page, "Message parent") },
    expected: `document.querySelector('dialog[open] p code')?.textContent === 'ses_test' && document.querySelector('dialog[open] textarea')?.value === ''`,
  },
  {
    id: "f3856445bf3341c89ef2c5d71501b060", label: "attributed terminal inventory without opening a PTY stream",
    show: async page => { await tools(page, "Terminals") },
    expected: `document.querySelector('dialog[open]')?.textContent.includes('Synthetic terminal')`,
  },
]

test("Desktop ordinary directories exclude leaked helpers and off-page children while direct children and parent navigation remain open", async () => {
  pending = false
  referenceScene = true
  const child = (id: string) => ({ ...session(id), title: `Direct ${id}`, parentID: "ses_test", ...(id === "ses_btw" ? { agent: "btw" } : {}) })
  sceneRead = call => {
    if (call.route === "/api/session") return { data: [session("ses_test"), session("ses_other"), { ...session("ses_discussion"), title: "Compaction discussion" }, { ...session("ses_helper"), agent: "compaction", title: "Compaction cmp_agent" }, { ...session("ses_compaction_0123456789abcdef01234567"), title: "Compaction cmp_identity" }, { ...child("ses_loaded_btw"), agent: "btw" }, { ...child("ses_loaded_fork"), parentID: "ses_loaded_btw" }, { ...child("ses_offpage"), parentID: "ses_outside_page" }], cursor: {} }
    if (call.route === "/api/session/ses_test/subagent") {
      const next = call.query.has("cursor")
      return { data: [{ sessionID: next ? "ses_btw" : "ses_subagent", parentID: "ses_test", description: "Reported worker description", agent: "build", model: selection(), background: true, state: "waiting", revision: 1, time: { created: 1, updated: 2 } }], summary: { total: 2, active: 2 }, cursor: next ? {} : { next: "child-next" } }
    }
    if (call.route === "/api/session/ses_test/usage/tasks") return { data: { tasks: ["ses_loaded_btw", "ses_loaded_fork", "ses_subagent", "ses_btw"].filter(id => call.query.toString().includes(id)).map(sessionID => ({ sessionID })), history: "retained" } }
    const id = call.route.split("/").at(-1)
    if (id && ["ses_subagent", "ses_btw", "ses_fork", "ses_loaded_btw", "ses_loaded_fork"].includes(id)) return { data: { ...child(id), ...(id === "ses_loaded_fork" ? { parentID: "ses_loaded_btw" } : {}) } }
    return undefined
  }
  const page = await openReference()
  try {
    expect(await page.evaluate(`document.querySelectorAll('.rl-session-row').length`, decodeNumber)).toBe(3)
    expect(await page.evaluate(`[...document.querySelectorAll('.rl-rail-filter')].map(button => button.getAttribute('aria-label'))`, decodeArray(decodeString))).toEqual(["All 3", "Waiting 0", "Running 0", "Idle 0"])
    await page.evaluate(`document.querySelector('.desktop__palette').click()`)
    await wait(page, `document.querySelector('.palette__option')`)
    expect(await page.evaluate(`document.querySelector('.palette').textContent`, decodeString)).not.toMatch(/ses_loaded_btw|ses_loaded_fork|ses_offpage|Compaction cmp_/)
    await page.pressKey("Escape", "Escape", 27)
    await page.navigate(`${origin}/#/sessions`)
    await wait(page, `document.querySelector('.desktop-session-row')`)
    expect(await page.evaluate(`document.querySelectorAll('.desktop-session-row').length`, decodeNumber)).toBe(3)
    expect(await page.evaluate(`document.querySelector('main').textContent`, decodeString)).not.toContain("Compaction cmp_")
    for (const id of ["ses_subagent", "ses_btw", "ses_fork"]) {
      await page.navigate(`${origin}/#/sessions/${id}`)
      await wait(page, `document.querySelector('#conversation-title')?.textContent === ${JSON.stringify(`Direct ${id}`)} && document.querySelector('.rl-capsule textarea')`)
      await command(page, "Open the parent Session")
      await wait(page, `location.hash === '#/sessions/ses_test' && document.querySelector('#conversation-title')?.textContent !== ${JSON.stringify(`Direct ${id}`)}`)
    }
    await companion(page, "Activity")
    await wait(page, `document.querySelector('.rl-companion')?.textContent.includes('Direct ses_loaded_btw') && document.querySelector('.rl-companion')?.textContent.includes('Direct ses_loaded_fork')`)
    await page.evaluate(`[...document.querySelectorAll('.rl-companion button, .rl-companion a')].find(element => element.textContent.includes('Direct ses_loaded_fork')).click()`)
    await wait(page, `location.hash === '#/sessions/ses_loaded_fork' && document.querySelector('#conversation-title')?.textContent === 'Direct ses_loaded_fork'`)
    await command(page, "Open the parent Session")
    await wait(page, `location.hash === '#/sessions/ses_loaded_btw' && document.querySelector('#conversation-title')?.textContent === 'Direct ses_loaded_btw'`)
    await command(page, "Open the parent Session")
    await wait(page, `location.hash === '#/sessions/ses_test'`)
    await companion(page, "Activity")
    await wait(page, `document.querySelector('.rl-companion')?.textContent.includes('Direct ses_subagent')`)
    await page.evaluate(`[...document.querySelectorAll('.rl-companion button, .rl-companion a')].find(element => element.textContent.includes('Direct ses_subagent')).click()`)
    await wait(page, `location.hash === '#/sessions/ses_subagent'`)
    await command(page, "Open the parent Session")
    await wait(page, `location.hash === '#/sessions/ses_test'`)
    await companion(page, "Activity")
    await clickContaining(page, '.rl-companion button', "Load older subagents")
    await wait(page, `document.querySelector('.rl-companion')?.textContent.includes('Direct ses_btw')`)
    await companion(page, "Context")
    await wait(page, `document.querySelector('.rl-companion')?.textContent.includes('ses_btw') && document.querySelector('.rl-companion')?.textContent.includes('ses_subagent')`)
    expect(owned!.calls.filter(call => call.route === "/api/session/ses_test/usage/tasks").some(call => ["ses_loaded_btw", "ses_loaded_fork", "ses_subagent", "ses_btw"].every(id => call.query.toString().includes(id)))).toBe(true)
    expect(owned!.calls.filter(call => call.route === "/api/session").every(call => !call.query.has("parentID") && call.query.get("background") === "exclude" && call.query.get("limit") === "40")).toBe(true)
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 60_000)

async function desktopAuditDesign() {
  const design: unknown = Bun.YAML.parse((await Bun.file(path.join(import.meta.dir, "../DESIGN.md")).text()).split("---")[1]!)
  if (design === null || typeof design !== "object" || !("controls" in design) || !("layout" in design)) throw new Error("Desktop DESIGN requires controls and layout mappings.")
  const controls = design.controls
  if (controls === null || typeof controls !== "object") throw new Error("Desktop DESIGN requires a controls mapping.")
  const controlHeights = Object.values(controls).map((value: unknown) => {
    if (typeof value !== "string") throw new Error("Desktop DESIGN requires string control heights.")
    return parseFloat(value)
  })
  const layout = design.layout
  if (layout === null || typeof layout !== "object" || !("conversation-max" in layout) || typeof layout["conversation-max"] !== "string") throw new Error("Desktop DESIGN requires a conversation-max value.")
  const maximum = parseFloat(layout["conversation-max"])
  expect(maximum).toBeGreaterThanOrEqual(960)
  expect(maximum).toBeLessThanOrEqual(1040)
  return { controlHeights, maximum }
}

for (const name of ["composer", "settings", "keyboard", "projects", "project-states"] as const) test(`Desktop r6 ${name} fills its workspace and keeps compact controls readable`, async () => {
  const output = process.env.YCODING_DESKTOP_CAPTURE_DIR
  const auditScript = process.env.YCODING_DESKTOP_AUDIT_SCRIPT
  if (!output || !auditScript) throw new Error("Set Desktop capture directory and render auditor.")
  const audit = await Bun.file(auditScript).text()
  const { controlHeights, maximum } = await desktopAuditDesign()
  const failures: string[] = []
  sceneRead = undefined; pending = false; referenceScene = true; captureScene = true; presentationParts = true; currentVariant = "high"
  if (name === "project-states") sceneRead = call => call.route === `/api/coordination/${sceneGroup.id}` ? { data: { ...sceneGroup, master: { ...sceneGroup.master, state: "running" }, members: ["idle", "waiting", "failed", "idle", "running"].map((state, index) => ({ ...sceneParticipant(`ses_state_${index}`), state, title: `Synthetic ${state} member ${index + 1}` })) } } : undefined
  for (const theme of ["dark", "light"]) for (const width of [390, 768, 1440, 1920]) {
    const page = await openReference()
    try {
      await page.setViewport(width, width <= 768 ? 844 : 900)
      await page.setCoarsePointer(width <= 768)
      await page.evaluate(`localStorage.setItem('ycoding.desktop.theme', ${JSON.stringify(theme)}); location.reload()`)
      await wait(page, `document.querySelector('#turn-msg_response') && document.fonts.status === 'loaded'`)
      if (name === "composer") {
        await page.evaluate(`if (document.querySelector('.rl-companion')) document.querySelector('.rl-companion-toggle').click()`)
      } else {
        await page.navigate(`${origin}/#/${name === "projects" || name === "project-states" ? "projects" : "settings"}`)
        await wait(page, name === "projects" || name === "project-states" ? `document.querySelector('.desktop-project-settings') && document.querySelector('[data-action-id="project-member-remove"]')` : `document.querySelector('.st-machine') && document.querySelector('[aria-label="Assigned shortcuts"]')`)
        if (name === "keyboard") await page.evaluate(`document.querySelector('section[aria-label="Keyboard shortcuts"]').scrollIntoView({block:'start'})`)
      }
      await page.evaluate(`Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))`)
      await page.evaluate(audit)
      const result = await page.evaluate(`(() => {
        const findings = [], box = selector => document.querySelector(selector)?.getBoundingClientRect();
        const visible = e => !!e?.getClientRects().length && e.getBoundingClientRect().width > 0;
        if (${name === "composer"}) {
          const main = box('.conversation__scroll'), transcript = box('.rl-scroll .rl-col'), composer = box('.rl-dock .rl-col');
          if (${width >= 1440}) {
            if (!main || !transcript || !composer) findings.push('Conversation track is missing');
            else {
              const pane = document.querySelector('.conversation__scroll');
              const left = transcript.left - main.left - pane.clientLeft, right = pane.clientWidth - left - transcript.width;
              if (Math.abs(transcript.width - ${maximum}) > 1 || left < 24 || right < 24 || Math.abs(left - right) > 1) findings.push('Conversation maximum or balanced gutters');
              if (Math.abs(transcript.left - composer.left) > 1 || Math.abs(transcript.right - composer.right) > 1) findings.push('Transcript/composer track mismatch');
            }
          }
          if (${width >= 1440} && (!composer || Math.abs((main.right - composer.right) - (composer.left - main.left)) > 8)) findings.push('Unbalanced composer gutters');
          const effort = document.querySelector('.composer-chip--effort');
          if (!effort?.querySelector('svg') || !effort.textContent.includes('High')) findings.push('Effort anatomy');
          if (!document.querySelector('.composer-chip--model svg') || !document.querySelector('.composer-policy-chip svg')) findings.push('Composer icon anatomy');
          for (const e of document.querySelectorAll('.composer-chip--effort span, .composer-metric')) if (visible(e) && e.scrollWidth > e.clientWidth + 1) findings.push('Clipped composer label');
          const controls = [...document.querySelectorAll('.composer-bar > *, .composer-anchor > button')].filter(e => visible(e) && getComputedStyle(e).visibility !== 'hidden' && !e.matches('.composer-bar__spacer, .composer-bar__note, .composer-attachments, .composer-anchor'));
          for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) { const a=controls[i].getBoundingClientRect(), b=controls[j].getBoundingClientRect(); if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1) findings.push('Composer collision'); }
        } else if (${name === "settings" || name === "keyboard"}) {
          const commands = [...document.querySelectorAll('[aria-label="Assigned shortcuts"] button')].filter(e => e.querySelector('span')?.textContent === 'Commands');
          if (commands.length !== 1 || commands[0]?.querySelectorAll('kbd').length !== 2) findings.push('Commands must group both chords');
          if (document.querySelector('#st-keep-awake-state')?.textContent.trim() === 'on') findings.push('Redundant keep-awake state');
          if (${width >= 1440}) { const ledger = box('.st-ledger'), pane = box('.rl-page-content'); if (!ledger || pane.right-ledger.right>32) findings.push('Unused Settings right pane'); }
          if (!document.querySelector('.st-settings-nav svg')) findings.push('Settings navigation icons');
          const editor = box('[aria-label="Shortcut editor"]');
          for (const input of document.querySelectorAll('[aria-label="Shortcut editor"] input, [aria-label="Shortcut editor"] [role="combobox"]')) { const rect = input.getBoundingClientRect(); if (visible(input) && (rect.left < editor.left - 1 || rect.right > editor.right + 1)) findings.push('Shortcut editor control overflow'); }
        } else {
          if (document.querySelector('.desktop-project-inspector ul.st-rows')) findings.push('Duplicated member roster');
          if (document.querySelectorAll('[data-project-roster]').length !== 1) findings.push('One canonical project roster');
          if (!document.querySelector('[data-state-indicator][aria-label] svg')) findings.push('Semantic project state icons');
          for (const e of document.querySelectorAll('[data-action-id="project-member-remove"], [data-action-id="project-member-delete"]')) if (!e.querySelector('svg') || !e.getAttribute('aria-label')) findings.push('Project icon action');
        }
        return { findings: [...new Set(findings)], audit: auditRender({ controlHeights: ${JSON.stringify(controlHeights)} }), rawAudit: auditRender(), errors: window.__desktopFixture.errors };
      })()`, (value: unknown) => { const result = decodeRecord(value); return { findings: (decodeArray(decodeString))(result["findings"]), audit: ((value: unknown) => { const result = decodeRecord(value); return { findings: (decodeArray((value: unknown) => { const result = decodeRecord(value); return { code: (decodeString)(result["code"]) } }))(result["findings"]) } })(result["audit"]) } })
      const key = `r6-${name}-${theme}-${width}`
      await Bun.write(path.join(output, `${key}.png`), Buffer.from(await page.screenshot(), "base64"))
      await Bun.write(path.join(output, `${key}.audit.json`), JSON.stringify(result, null, 2))
      failures.push(...result.findings.map(f => `${key}: ${f}`))
      const codes = new Set(["page-overflow-x", "icon-control-unnamed", "target-too-small", "text-below-floor"])
      failures.push(...result.audit.findings.filter(f => codes.has(f.code) || f.code.startsWith("native-") || f.code === "scrollbar-default").map(f => `${key}: ${f.code}`))
      if (name === "project-states") expect(await page.evaluate(`document.querySelectorAll('[data-project-roster] > li').length === 6 && ['running', 'idle', 'waiting', 'failed'].every(state => document.querySelector('[data-project-roster] [data-state="' + state + '"][role="img"][aria-label] svg'))`, decodeBoolean)).toBe(true)
      expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
    } finally { await page.close() }
  }
  console.log("Desktop r6 findings", failures)
  expect(failures).toEqual([])
}, 300_000)

for (const [name, id] of [
  ["conversation", "247859938ae742cea7c31d352e62ea80"], ["sessions", "9715087f99c9431a938a353cb05ca9a9"],
  ["workspaces", "70ca078090f64321b1f264ab4cdc88e2"], ["git-diff", "825f05dcc7724e0fb83ffb3667c0d627"],
  ["projects", "9121b2a17ffb4d81a7f021e6325329f4"], ["usage", "4bff4148cf26491587127a52f9570dcf"],
  ["settings", "3c1ec4a1812445abb88562e81231dd22"], ["dialog", "bf4de94bc265448a87ae20d91c0c5109"],
  ["popover", "936d17691f6241e3819c91d4870c9aa6"], ["team", "team"],
] as const) test(`Desktop layout audit matrix ${name} captures dark and light at the authorized widths`, async () => {
  const output = process.env.YCODING_DESKTOP_CAPTURE_DIR
  if (!output) throw new Error("Set YCODING_DESKTOP_CAPTURE_DIR for the Desktop layout audit matrix.")
  const auditScript = process.env.YCODING_DESKTOP_AUDIT_SCRIPT
  if (!auditScript) throw new Error("Set YCODING_DESKTOP_AUDIT_SCRIPT to the installed Daedalus render auditor.")
  const audit = await Bun.file(auditScript).text()
  const { controlHeights, maximum } = await desktopAuditDesign()
  const failures: string[] = []
    const scene = referenceCases.find(scene => scene.id === id)
    sceneRead = undefined; pending = false; referenceScene = true; captureScene = true; presentationParts = true; familyEnabled = name === "team"; directoryStatus = false
    scene?.prepare?.()
    for (const theme of ["dark", "light"] as const) for (const width of [320, 390, 700, 768, 1280, 1440, 1920, 2560]) {
      const page = await openReference()
      try {
        await page.setViewport(width, width <= 700 ? 844 : 900)
        await page.setCoarsePointer(width <= 768)
        await page.evaluate(`localStorage.setItem('ycoding.desktop.theme', ${JSON.stringify(theme)}); location.reload()`)
        await wait(page, `document.querySelector('#turn-msg_response') && document.fonts.status === 'loaded'`)
        if (name === "conversation") {
          await page.evaluate(`if (document.querySelector('.rl-companion')) document.querySelector('.rl-companion-toggle').click()`)
        } else if (name === "team") {
          await clickText(page, '.rl-top button', "Team")
          await wait(page, `document.querySelector('[data-team-view]')`)
        } else if (scene) {
          await scene.show(page)
          await wait(page, scene.expected)
        }
        await page.evaluate(`Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))`)
        await page.evaluate(audit)
        const results = await page.evaluate(`(() => {
          const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
          const geometry = Object.fromEntries(['.rl-nav', '.rl-top', '.rl-ident', '.rl-col', '.rl-dock .rl-col', '.rl-page-head', '.rl-page-content', '.desktop-team', '.desktop-dialog', '.model-popover'].flatMap(selector => { const element = document.querySelector(selector); return element?.getClientRects().length ? [[selector, element.getBoundingClientRect().toJSON()]] : []; }));
          const layout = [];
          if (${name === "conversation" && width >= 1280}) {
            const pane = document.querySelector('.conversation__scroll'), frame = pane.getBoundingClientRect(), track = rect('.rl-col'), composer = rect('.rl-dock .rl-col');
            const left = track.left - frame.left - pane.clientLeft, right = pane.clientWidth - left - track.width;
            if (Math.abs(frame.left - rect('.rl-nav').right) > 1) layout.push('Conversation pane alignment');
            if (left < 24 || right < 24 || Math.abs(left - right) > 1) layout.push('Balanced transcript gutters');
            if (track.width > ${maximum} + 1 || (${width >= 1440} && Math.abs(track.width - ${maximum}) > 1)) layout.push('Documented conversation maximum');
            if (Math.abs(track.left - composer.left) > 1 || Math.abs(track.right - composer.right) > 1) layout.push('Composer alignment');
          }
          return { audit: auditRender(), designAudit: auditRender({ controlHeights: ${JSON.stringify(controlHeights)} }), geometry, layout, errors: window.__desktopFixture.errors };
        })()`, (value: unknown) => { const result = decodeRecord(value); return { audit: ((value: unknown) => { const result = decodeRecord(value); return { findings: (decodeArray((value: unknown) => { const result = decodeRecord(value); return { code: (decodeString)(result["code"]), level: (decodeString)(result["level"]) } }))(result["findings"]) } })(result["audit"]), designAudit: ((value: unknown) => { const result = decodeRecord(value); return { findings: (decodeArray((value: unknown) => { const result = decodeRecord(value); return { code: (decodeString)(result["code"]), level: (decodeString)(result["level"]) } }))(result["findings"]) } })(result["designAudit"]), layout: (decodeArray(decodeString))(result["layout"]) } })
        const key = `${name}-${theme}-${width}`
        await Bun.write(path.join(output, `${key}.png`), Buffer.from(await page.screenshot(), "base64"))
        await Bun.write(path.join(output, `${key}.audit.json`), JSON.stringify(results, null, 2))
        expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
        const contractCodes = new Set(["page-overflow-x", "icon-control-unnamed", "target-too-small", "text-below-floor"])
        const contractFindings = [...results.audit.findings, ...results.designAudit.findings].filter(finding => contractCodes.has(finding.code))
        if (contractFindings.length || results.layout.length) failures.push(`${key}: ${[...new Set(contractFindings.map(finding => finding.code)), ...results.layout].join(", ")}`)
        console.log("Desktop audit capture", key)
      } finally { await page.close() }
    }
  console.log("Desktop layout audit findings", failures)
  expect(failures).toEqual([])
}, 600_000)

for (const scene of referenceCases) test(`Stitch scene ${scene.id} ${scene.label}`, async () => {
  pending = false
  referenceScene = true
  captureScene = true
  presentationParts = true
  scene.prepare?.()
  const page = await openReference(scene.ready)
  try {
    await scene.show(page)
    try { await captureReference(page, scene.id, scene.expected, scene.writes); await scene.afterCapture?.(page) }
    catch (cause) {
      const output = process.env.YCODING_DESKTOP_CAPTURE_DIR
      if (output) await Bun.write(path.join(output, `${scene.id}-unmatched.png`), Buffer.from(await page.screenshot(), "base64"))
      console.log("Stitch unmatched source capture", scene.id)
      throw cause
    }
    expect(saved).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Stitch scene 207018d81f6940b0ad9fcc75e1b6a8c4 transcript loading before the snapshot resolves", async () => {
  pending = false
  captureScene = true
  referenceScene = true
  const release = Promise.withResolvers<void>()
  sceneRead = call => call.route.endsWith("/snapshot") ? release.promise.then(() => ({ sourceEpoch: "synthetic", session: session("ses_test"), messages: transcript(), watermark: { type: "log.synced", aggregateID: "ses_test", seq: 1 } })) : undefined
  let page: Page | undefined
  try {
    page = await openReference(`document.querySelector('.conversation')?.textContent.includes('Loading the transcript…')`)
    await captureReference(page, "207018d81f6940b0ad9fcc75e1b6a8c4", `document.querySelector('.conversation')?.textContent.includes('Loading the transcript…') && !document.querySelector('#turn-msg_response')`)
    release.resolve()
    await wait(page, `document.querySelector('#turn-msg_response')`)
  } finally { release.resolve(); await page?.close() }
}, 30_000)

test("Stitch scene 4f5f9735ce8d45388c1034a3c8a10b1d reported running children and attributed shells", async () => {
  pending = false
  captureScene = true
  referenceScene = true
  running = true
  familyEnabled = true
  presentationParts = true
  replyText = "Running the synthetic pagination checks. Waiting for the remaining verification output."
  const page = await openReference()
  try {
    await companion(page, "Running")
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.started', data: { sessionID: 'ses_test' } })`)
    await message(page, "Inspect the synthetic pagination cursor next.")
    await captureReference(page, "4f5f9735ce8d45388c1034a3c8a10b1d", `document.querySelector('.rl-running')?.textContent.includes('ses_child_a') && document.querySelector('.rl-running')?.textContent.includes('bun test test/session-page.test.ts') && !!document.querySelector('.rl-send[data-stopping="true"]')`)
  } finally { await page.close() }
}, 30_000)

test("Stitch scene 80928cfab4bc4b20b3042c2f089574ef pending authorization stays inside the synthetic integration boundary", async () => {
  pending = false
  captureScene = true
  referenceScene = true
  providerScene = true
  sceneRead = call => call.method === "POST" && call.route.endsWith("/connect/oauth") ? { data: { attemptID: "con_scene", url: "https://example.test/synthetic-authorization", mode: "code", instructions: "Synthetic authorization is pending. No browser was opened.", manualCode: true, time: { created: 1, expires: 4102444800000 } } } : undefined
  const page = await openReference()
  try {
    await command(page, "Connect providers")
    await clickContaining(page, '.provider-picker button', "Synthetic Provider")
    await clickText(page, 'dialog[open] button', "Synthetic browser sign-in")
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('Authorization · pending')`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] h3')].find(heading => heading.textContent.includes('Authorization · pending')).scrollIntoView({ block: 'start' })`)
    expect(await page.evaluate(`(() => { const body = document.querySelector('dialog[open] .desktop-dialog__body').getBoundingClientRect(); const provider = document.querySelector('dialog[open] [aria-label="Providers"] button').getBoundingClientRect(); return provider.width > 0 && provider.height > 0 && provider.top >= body.top && provider.bottom <= body.bottom && provider.left >= body.left && provider.right <= body.right; })()`, decodeBoolean)).toBe(true)
    await captureReference(page, "80928cfab4bc4b20b3042c2f089574ef", `document.querySelector('dialog[open]')?.textContent.includes('Authorization · pending') && document.querySelector('dialog[open]')?.textContent.includes('No browser was opened.')`, ["POST /api/integration/synthetic/connect/oauth"])
    expect(await page.evaluate(`window.__desktopFixture.completed.openExternalUrl`)).toBeUndefined()
    await page.setViewport(650, 900)
    expect(await page.evaluate(`(() => { const list = document.querySelector('dialog[open] [aria-label="Provider list"]').getBoundingClientRect(); const detail = document.querySelector('dialog[open] [aria-label="Provider connection"]').getBoundingClientRect(); const provider = document.querySelector('dialog[open] [aria-label="Providers"] button').getBoundingClientRect(); return list.height >= 80 && detail.height > 0 && list.bottom <= detail.top && provider.top >= list.top && provider.bottom <= list.bottom && document.documentElement.scrollWidth <= innerWidth; })()`, decodeBoolean)).toBe(true)
  } finally { await page.close() }
}, 30_000)

const referenceAliases = { "5d2b6fbd40e84b53a2fbb947ff739515": "247859938ae742cea7c31d352e62ea80", "7dc0aa9f1fbd49e089d42fa98d994bef": "247859938ae742cea7c31d352e62ea80", "78c9dfc7992545b9b1b2dc5a37b82c57": "d870471b750a42df8e17ff0fb5d29e67" }
const implementedReferences = ["d870471b750a42df8e17ff0fb5d29e67", "adedc0ab360c471d9996962413cf247d", "49335c0b2469436280298bda555bdc50", "ba7c7489375448f99efdeacb0b49b3ea", "d0108ca2870b4ee5a9f9a641253e8d97", "74f69eda7960459cb43bf87828c71c12"]
const frozenBoundaryReferences = ["e7a4acd92c964bed8fcc0341240cc447"]

test("Stitch source inventory keeps existing owners, historical aliases and the frozen VCS boundary distinct", () => {
  const owners = [...referenceCases.map(scene => scene.id), "207018d81f6940b0ad9fcc75e1b6a8c4", "4f5f9735ce8d45388c1034a3c8a10b1d", "80928cfab4bc4b20b3042c2f089574ef", "f4476b36068c4c41adbb0f97a88e33d8", ...implementedReferences]
  expect(owners).toHaveLength(53)
  expect(frozenBoundaryReferences).toHaveLength(1)
  expect(new Set([...owners, ...Object.keys(referenceAliases), ...frozenBoundaryReferences]).size).toBe(57)
  for (const owner of Object.values(referenceAliases)) expect(owners).toContain(owner)
})

test("Desktop component chrome keeps directory inspectors and toolbar variants at their own boundaries", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/workspaces`)
    await wait(page, `document.querySelector('.ws-workspaces-detail')`)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "workspaces.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(await page.evaluate(`(() => { const main = document.querySelector('.rl-main').getBoundingClientRect(), header = document.querySelector('.rl-page-head').getBoundingClientRect(), pane = document.querySelector('.ws-workspaces-detail').getBoundingClientRect(), list = document.querySelector('.ws-workspaces-list').getBoundingClientRect(); return { header: header.height, inspector: pane.width, flushRight: Math.abs(main.right - pane.right) <= 1, adjacent: Math.abs(list.right - pane.left) <= 1 }; })()`, decodeRecord)).toEqual({ header: 48, inspector: 420, flushRight: true, adjacent: true })
    await page.navigate(`${origin}/#/projects`)
    await wait(page, `document.querySelector('.desktop-project-inspector') && document.querySelector('[data-project-roster] [data-action-id="project-member-remove"]')`)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "projects.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(await page.evaluate(`(() => { const main = document.querySelector('.rl-main').getBoundingClientRect(), header = document.querySelector('.rl-page-head').getBoundingClientRect(), pane = document.querySelector('.desktop-project-inspector').getBoundingClientRect(); return { header: header.height, inspector: pane.width, flushRight: Math.abs(main.right - pane.right) <= 1, memberActions: !!document.querySelector('[data-project-roster] [data-action-id="project-member-remove"]') }; })()`, decodeRecord)).toEqual({ header: 44, inspector: 400, flushRight: true, memberActions: true })
    await clickText(page, 'main button', "Coordination")
    await wait(page, `document.querySelector('[data-project-coordination]')`)
    expect(await page.evaluate(`({ header: document.querySelector('.rl-page-head').getBoundingClientRect().height, inspector: document.querySelector('[aria-label="Selected member"]').getBoundingClientRect().width })`, decodeRecord)).toEqual({ header: 56, inspector: 320 })
    await page.navigate(`${origin}/#/sessions`)
    await wait(page, `document.querySelector('.desktop-session-row')`)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "sessions.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(await page.evaluate(`({ header: document.querySelector('.rl-page-head').getBoundingClientRect().height, cells: document.querySelector('.desktop-session-row').children.length, title: [...document.querySelectorAll('.desktop-session-row')].some(row => row.textContent.includes('Refactor session pagination')) })`, decodeRecord)).toEqual({ header: 40, cells: 6, title: true })
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop component chrome changes Team geometry without losing the Master draft", async () => {
  prepareImplementedSurface()
  familyEnabled = true
  const page = await openReference()
  try {
    await message(page, "Keep the local Master draft")
    await clickText(page, '.rl-top button', "Team")
    await wait(page, `document.querySelector('[aria-label="Selected child"]')`)
    expect(await page.evaluate(`({ header: document.querySelector('.rl-top').getBoundingClientRect().height, inspector: document.querySelector('[aria-label="Selected child"]').getBoundingClientRect().width })`, decodeRecord)).toEqual({ header: 40, inspector: 320 })
    await clickText(page, '.rl-top button', "Conversation")
    expect(await page.evaluate(`({ header: document.querySelector('.rl-top').getBoundingClientRect().height, draft: document.querySelector('.rl-capsule textarea').value })`, decodeRecord)).toEqual({ header: 40, draft: "Keep the local Master draft" })
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop component chrome stacks directory inspectors at their breakpoint and keeps coarse dialog controls reachable", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    for (const [route, list, inspector] of [["workspaces", ".ws-workspaces-list", ".ws-workspaces-detail"], ["projects", ".desktop-project-settings > .relay-settings", ".desktop-project-inspector"]]) {
      await page.navigate(`${origin}/#/${route}`)
      await wait(page, `document.querySelector(${JSON.stringify(inspector)})`)
      await page.setViewport(1101, 900)
      expect(await page.evaluate(`(() => { const list = document.querySelector(${JSON.stringify(list)}).getBoundingClientRect(), pane = document.querySelector(${JSON.stringify(inspector)}).getBoundingClientRect(); return Math.abs(list.right - pane.left) <= 1 && pane.width > 0; })()`, decodeBoolean)).toBe(true)
      await page.setViewport(1100, 900)
      expect(await page.evaluate(`(() => { const list = document.querySelector(${JSON.stringify(list)}).getBoundingClientRect(), pane = document.querySelector(${JSON.stringify(inspector)}).getBoundingClientRect(); return pane.top >= list.bottom && Math.abs(list.left - pane.left) <= 1; })()`, decodeBoolean)).toBe(true)
    }
    await page.navigate(`${origin}/#/sessions/ses_test`)
    await wait(page, `document.querySelector('#turn-msg_response')`)
    await command(page, "/agents")
    await wait(page, `document.querySelector('dialog[data-kind="agents"][open]')`)
    await page.setViewport(701, 900)
    expect(await page.evaluate(`document.querySelector('dialog[open]').getBoundingClientRect().right <= innerWidth`, decodeBoolean)).toBe(true)
    await page.setMobileViewport(700, 900)
    expect(await page.evaluate(`matchMedia('(pointer: coarse)').matches && document.querySelector('dialog[open] .desktop-dialog__head').getBoundingClientRect().height >= 44 && [...document.querySelectorAll('dialog[open] .desktop-dialog__head button, dialog[open] [role="tab"]')].every(button => { const box = button.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; })`, decodeBoolean)).toBe(true)
    await page.pressKey("Escape", "Escape", 27)
    await wait(page, `!document.querySelector('dialog[open]')`)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

function prepareImplementedSurface() {
  pending = false
  captureScene = true
  referenceScene = true
}

async function compactPage() {
  prepareImplementedSurface()
  const page = await openReference()
  await page.setViewport(390, 844)
  await page.setCoarsePointer(true)
  await wait(page, `matchMedia('(pointer: coarse)').matches`)
  return page
}

function decodePair(value: unknown): [number, number] {
  const pair = decodeArray(decodeNumber)(value)
  if (pair.length !== 2) throw new Error("Expected a numeric pair")
  return [pair[0]!, pair[1]!]
}

const decodeLayoutBounds = (value: unknown) => {
  const result = decodeRecord(value)
  return {
    x: decodeNumber(result["x"]),
    y: decodeNumber(result["y"]),
    width: decodeNumber(result["width"]),
    height: decodeNumber(result["height"]),
    right: decodeNumber(result["right"]),
    bottom: decodeNumber(result["bottom"]),
  }
}

type LayoutBounds = ReturnType<typeof decodeLayoutBounds>

const decodeR7Geometry = (value: unknown) => {
  const result = decodeRecord(value)
  return {
    overflow: decodeArray(decodeString)(result["overflow"]),
    smallControls: decodeArray(decodeString)(result["smallControls"]),
    unnamedControls: decodeArray(decodeString)(result["unnamedControls"]),
    nativeHints: decodeArray(decodeString)(result["nativeHints"]),
    offscreenComposer: decodeArray(decodeString)(result["offscreenComposer"]),
    offscreenComposerContainers: decodeArray(decodeString)(result["offscreenComposerContainers"]),
    nestedBorders: decodeArray(decodeString)(result["nestedBorders"]),
    visibleMetadata: decodeArray(decodeString)(result["visibleMetadata"]),
    errors: decodeArray((value: unknown) => value)(result["errors"]),
    columns: decodeNullable((value: unknown) => {
      const result = decodeRecord(value)
      return {
        left: decodeNumber(result["left"]),
        right: decodeNumber(result["right"]),
        ratio: decodeNumber(result["ratio"]),
        composerLeft: decodeNumber(result["composerLeft"]),
        composerRight: decodeNumber(result["composerRight"]),
      }
    })(result["columns"]),
    roster: decodeNullable((value: unknown) => {
      const result = decodeRecord(value)
      return {
        height: decodeNumber(result["height"]),
        rowHeights: decodeArray(decodeNumber)(result["rowHeights"]),
        gap: decodeNumber(result["gap"]),
        padding: decodeNumber(result["padding"]),
      }
    })(result["roster"]),
    readingTrack: decodeNullable((value: unknown) => {
      const result = decodeRecord(value)
      return {
        outer: decodeLayoutBounds(result["outer"]),
        viewport: decodeLayoutBounds(result["viewport"]),
        rows: decodeArray((value: unknown) => {
          const result = decodeRecord(value)
          return {
            kind: decodeString(result["kind"]),
            turn: decodeString(result["turn"]),
            bounds: decodeLayoutBounds(result["bounds"]),
          }
        })(result["rows"]),
        controls: decodeArray((value: unknown) => {
          const result = decodeRecord(value)
          return {
            kind: decodeString(result["kind"]),
            bounds: decodeLayoutBounds(result["bounds"]),
            row: decodeLayoutBounds(result["row"]),
          }
        })(result["controls"]),
        floating: decodeArray((value: unknown) => {
          const result = decodeRecord(value)
          return { label: decodeString(result["label"]), bounds: decodeLayoutBounds(result["bounds"]) }
        })(result["floating"]),
        turnGaps: decodeArray(decodeNumber)(result["turnGaps"]),
      }
    })(result["readingTrack"]),
    composerCluster: decodeNullable((value: unknown) => {
      const result = decodeRecord(value)
      return {
        card: decodeLayoutBounds(result["card"]),
        send: decodeLayoutBounds(result["send"]),
        delivery: decodeLayoutBounds(result["delivery"]),
        metrics: decodeLayoutBounds(result["metrics"]),
        leading: decodeLayoutBounds(result["leading"]),
        leftInset: decodeNumber(result["leftInset"]),
        rightInset: decodeNumber(result["rightInset"]),
        bottomInset: decodeNumber(result["bottomInset"]),
        autoSendGap: decodeNumber(result["autoSendGap"]),
        targets: decodeArray((value: unknown) => {
          const result = decodeRecord(value)
          return { label: decodeString(result["label"]), bounds: decodeLayoutBounds(result["bounds"]) }
        })(result["targets"]),
      }
    })(result["composerCluster"]),
    coordination: decodeNullable((value: unknown) => {
      const result = decodeRecord(value)
      return {
        pane: decodeLayoutBounds(result["pane"]),
        viewportBottom: decodeNumber(result["viewportBottom"]),
        main: decodeLayoutBounds(result["main"]),
        mainFlexColumn: decodeBoolean(result["mainFlexColumn"]),
        sidebar: decodeNullable(decodeLayoutBounds)(result["sidebar"]),
        sidebarBackground: decodeNullable(decodeString)(result["sidebarBackground"]),
        sidebarBorder: decodeNullable(decodeNumber)(result["sidebarBorder"]),
        footer: decodeLayoutBounds(result["footer"]),
        footerBorder: decodeNumber(result["footerBorder"]),
        list: decodeLayoutBounds(result["list"]),
        listClientHeight: decodeNumber(result["listClientHeight"]),
        listScrollHeight: decodeNumber(result["listScrollHeight"]),
        listOverflow: decodeString(result["listOverflow"]),
        listFlex: decodeBoolean(result["listFlex"]),
      }
    })(result["coordination"]),
  }
}

type R7Geometry = ReturnType<typeof decodeR7Geometry>

async function settleR7(page: Page) {
  await page.evaluate(`Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))`)
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
}

async function captureR7(page: Page, name: string) {
  await settleR7(page)
  const geometry = await page.evaluate(`(() => {
    const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
    const visible = element => { const box = element.getBoundingClientRect(); return box.width > 1 && box.height > 1 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('details:not([open]) > :not(summary)'); };
    const label = element => element.getAttribute('aria-label') || element.className || element.tagName;
    const selectors = 'html, body, .rl-main, .conversation, .conversation__scroll, .rl-scroll .rl-col, .rl-dock, .rl-dock .rl-col, .rl-capsule, .composer-bar, .composer-attachments, .composer-attachments > *, .conversation__chip, .composer-chip, .composer-policy-chip, .transcript-message__text, .transcript-md pre, .rl-output, .rl-tools-card, .rl-step-card, .rl-step-head, .rl-reason, .transcript-reasoning, .desktop-diff, .desktop-diff__files, .desktop-diff table, .desktop-diff td, .desktop-diff pre, .desktop-diff code, .desktop-project-settings, .desktop-project-overview, .desktop-project-inspector, .desktop-project-roster, .desktop-project-roster > li';
    const innerCodeViewports = [...document.querySelectorAll('.desktop-diff__file *')].filter(element => /^(auto|scroll)$/.test(getComputedStyle(element).overflowX) && (element.matches('table, pre, code') || element.querySelector('table, pre, code')));
    const allowedNoWrapViewport = element => { const file = element.closest('.desktop-diff[data-wrap="none"] .desktop-diff__file'); if (!file) return false; const pane = file.closest('.desktop-diff__files'); for (let owner = element; owner && owner !== file; owner = owner.parentElement) { if (!innerCodeViewports.includes(owner) || owner.clientWidth === 0) continue; const box = rect(owner); const parent = rect(file); const bounds = rect(pane); return box.x >= parent.x && box.right <= parent.right && parent.x >= bounds.x && parent.right <= bounds.right; } return false; };
    const regions = [...new Set([...document.querySelectorAll(selectors), ...innerCodeViewports])].filter(visible).map(element => ({ label: label(element), rect: rect(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflowX: getComputedStyle(element).overflowX, border: getComputedStyle(element).border, fontSize: getComputedStyle(element).fontSize, allowedInnerNoWrap: allowedNoWrapViewport(element) }));
    const controls = [...document.querySelectorAll('.rl-capsule button, .rl-capsule input, .rl-capsule textarea, .desktop-project-settings button, .desktop-project-settings input, .transcript-tools__button, .transcript-reasoning summary')].filter(visible);
    const pane = document.querySelector('.conversation__scroll'); const column = document.querySelector('.rl-scroll .rl-col'); const composer = document.querySelector('.rl-dock .rl-col');
    const diagnosticStyle = (element, pseudo) => { const style = getComputedStyle(element, pseudo); return Object.fromEntries(['content', 'display', 'position', 'boxSizing', 'inlineSize', 'minInlineSize', 'maxInlineSize', 'marginLeft', 'marginRight', 'marginInlineStart', 'marginInlineEnd', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'insetInlineStart', 'insetInlineEnd', 'transform', 'translate', 'overflowX', 'overflowY', 'whiteSpace', 'contain', 'contentVisibility'].map(key => [key, style[key]])); };
    const diagnosticNode = element => ({ tag: element.tagName, id: element.id, class: element.getAttribute('class'), turn: element.closest('.transcript__turn')?.id, rect: rect(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientLeft: element.clientLeft, hiddenInClosedDetails: !!element.closest('details:not([open]) > :not(summary)'), parent: element.parentElement ? { tag: element.parentElement.tagName, id: element.parentElement.id, class: element.parentElement.getAttribute('class'), rect: rect(element.parentElement), clientWidth: element.parentElement.clientWidth, scrollWidth: element.parentElement.scrollWidth } : null, style: diagnosticStyle(element), before: diagnosticStyle(element, '::before'), after: diagnosticStyle(element, '::after') });
    const roster = document.querySelector('[data-project-roster]');
    const card = document.querySelector('.rl-dock .rl-capsule'), send = card?.querySelector('.rl-send'), delivery = card?.querySelector('.composer-bar button[aria-label="Send mode"]'), metrics = card?.querySelector('.composer-metrics'), leading = card?.querySelector('.composer-bar > :first-child');
    const projectPane = document.querySelector('.desktop-project-settings'), projectMain = document.querySelector('.desktop-project-overview'), projectSidebar = document.querySelector('.desktop-project-inspector'), projectFooter = document.querySelector('.desktop-project-options');
    let projectList = roster; for (let node = roster; node && node !== projectMain; node = node.parentElement) { if (!node.contains(projectFooter) && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) { projectList = node; break; } }
    const trackSelectors = [['assistant head', '.transcript-message__head'], ['Thought', '.transcript-reasoning > summary'], ['Ran tools', '.transcript-tools__button'], ['Step provenance', '.desktop-step-provenance > summary'], ['Shell finished', '#turn-r8_shell_finished .transcript-notice-pill'], ['user bubble', '.transcript-message--user .transcript-message__bubble'], ['markdown', '.transcript-message__text > .transcript-md'], ['prose', '.transcript-message__text > .transcript-md > p']];
    const turns = [...document.querySelectorAll('.transcript > .transcript__turn')].filter(visible);
    const bordered = element => parseFloat(getComputedStyle(element).borderTopWidth) > 0 && getComputedStyle(element).borderTopStyle !== 'none';
    return { viewport: { width: innerWidth, height: innerHeight, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, coarse: matchMedia('(pointer: coarse)').matches }, regions,
      overflow: regions.filter(item => item.clientWidth > 0 && item.scrollWidth > item.clientWidth && !item.allowedInnerNoWrap).map(item => item.label + ': ' + item.scrollWidth + ' > ' + item.clientWidth),
      rawOverflow: regions.filter(item => item.clientWidth > 0 && item.scrollWidth > item.clientWidth).map(item => ({ label: item.label, scrollWidth: item.scrollWidth, clientWidth: item.clientWidth, allowedInnerNoWrap: item.allowedInnerNoWrap })),
      innerDiffViewports: innerCodeViewports.filter(visible).map(element => ({ label: label(element), rect: rect(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollLeft: element.scrollLeft, allowedInnerNoWrap: allowedNoWrapViewport(element) })),
      columnOverflow: column ? { column: diagnosticNode(column), pane: diagnosticNode(pane), promptRail: [...column.querySelectorAll('.transcript-navigation__rail-slot, .transcript-navigation__rail, .transcript-navigation__ticks')].map(diagnosticNode), offenders: [...column.querySelectorAll('*')].filter(element => rect(element).right > rect(column).right + 0.5 || element.scrollWidth > element.clientWidth).map(diagnosticNode) } : null,
      smallControls: controls.filter(element => parseFloat(getComputedStyle(element).fontSize) < 12).map(label),
      unnamedControls: controls.filter(element => element.tagName === 'BUTTON' && !(element.getAttribute('aria-label') || element.textContent.trim())).map(label),
      nativeHints: controls.filter(element => element.hasAttribute('title')).map(label),
      offscreenComposer: document.querySelector('dialog:modal') ? [] : [...document.querySelectorAll('.rl-capsule .composer-bar button')].filter(element => visible(element) && (rect(element).y < visualViewport.offsetTop || rect(element).bottom > visualViewport.offsetTop + visualViewport.height)).map(label),
      offscreenComposerContainers: document.querySelector('dialog:modal') ? [] : [...document.querySelectorAll('.rl-capsule, .composer-bar')].filter(element => visible(element) && (rect(element).y < visualViewport.offsetTop || rect(element).bottom > visualViewport.offsetTop + visualViewport.height)).map(element => label(element) + ': ' + rect(element).y + '..' + rect(element).bottom + ' outside ' + visualViewport.offsetTop + '..' + (visualViewport.offsetTop + visualViewport.height)),
      nestedBorders: [...document.querySelectorAll('.rl-tools-card .rl-step-card:not([data-status="failed"])')].filter(element => visible(element) && bordered(element) && bordered(element.closest('.rl-tools-card'))).map(label),
      visibleMetadata: [...document.querySelectorAll('.transcript-message__head')].filter(visible).map(element => element.textContent.trim()),
      columns: pane && column && composer ? { left: rect(column).x - rect(pane).x - pane.clientLeft, right: pane.clientWidth - (rect(column).right - rect(pane).x - pane.clientLeft), ratio: rect(column).width / pane.clientWidth, composerLeft: rect(composer).x - rect(column).x, composerRight: rect(composer).right - rect(column).right } : null,
      readingTrack: card && column && pane ? { outer: rect(card), viewport: rect(pane), rows: trackSelectors.flatMap(([kind, selector]) => [...document.querySelectorAll(selector)].filter(visible).map(element => ({ kind, turn: element.closest('.transcript__turn')?.id ?? '', bounds: rect(element) }))), controls: [...document.querySelectorAll('.rl-disclosure-head .rl-disclosure-chev, .rl-disclosure-head .rl-disclosure-time')].filter(visible).map(element => ({ kind: label(element), bounds: rect(element), row: rect(element.closest('summary, button')) })), floating: [...document.querySelectorAll('.transcript-navigation__rail, .transcript-navigation__controls')].filter(visible).map(element => ({ label: label(element), bounds: rect(element) })), turnGaps: turns.slice(1).map((element, index) => rect(element).y - rect(turns[index]).bottom) } : null,
      composerCluster: card && send && delivery && metrics && leading ? { card: rect(card), send: rect(send), delivery: rect(delivery), metrics: rect(metrics), leading: rect(leading), leftInset: rect(leading).x - rect(card).x, rightInset: rect(card).right - rect(send).right, bottomInset: rect(card).bottom - rect(send).bottom, autoSendGap: rect(send).x - rect(delivery).right, targets: [...card.querySelectorAll('.composer-bar button')].filter(visible).map(element => ({ label: label(element), bounds: rect(element) })) } : null,
      coordination: projectPane && projectMain && projectFooter && projectList && visible(projectMain) ? { pane: rect(projectPane), viewportBottom: document.documentElement.clientHeight, main: rect(projectMain), mainFlexColumn: getComputedStyle(projectMain).display === 'flex' && getComputedStyle(projectMain).flexDirection === 'column' && getComputedStyle(projectMain).minHeight === '0px', sidebar: projectSidebar && visible(projectSidebar) ? rect(projectSidebar) : null, sidebarBackground: projectSidebar && visible(projectSidebar) ? getComputedStyle(projectSidebar).backgroundColor : null, sidebarBorder: projectSidebar && visible(projectSidebar) ? parseFloat(getComputedStyle(projectSidebar).borderLeftWidth) : null, footer: rect(projectFooter), footerBorder: parseFloat(getComputedStyle(projectFooter).borderTopWidth), list: rect(projectList), listClientHeight: projectList.clientHeight, listScrollHeight: projectList.scrollHeight, listOverflow: getComputedStyle(projectList).overflowY, listFlex: parseFloat(getComputedStyle(projectList).flexGrow) > 0 && getComputedStyle(projectList).minHeight === '0px' } : null,
      roster: roster && visible(roster) ? { height: rect(roster).height, rowHeights: [...roster.children].map(element => rect(element).height), gap: parseFloat(getComputedStyle(roster).rowGap) || 0, padding: parseFloat(getComputedStyle(roster).paddingTop) + parseFloat(getComputedStyle(roster).paddingBottom) } : null,
      prose: [...document.querySelectorAll('.transcript-message__text .transcript-md > p')].map(element => ({ rect: rect(element), textLength: element.textContent.length })),
      errors: window.__desktopFixture.errors,
    };
  })()`, decodeR7Geometry)
  const output = process.env.YCODING_DESKTOP_CAPTURE_DIR
  if (output) {
    const image = path.join(output, `${name}.png`)
    const measurements = path.join(output, `${name}.geometry.json`)
    if (await Bun.file(image).exists() || await Bun.file(measurements).exists()) throw new Error(`Capture already exists: ${name}`)
    await Bun.write(image, Buffer.from(await page.screenshot(), "base64"))
    await Bun.write(measurements, JSON.stringify(geometry, null, 2))
  }
  return geometry
}

async function openR7(width: number, reduce = false) {
  const page = await open()
  try {
    await page.setViewport(width, width === 390 ? 844 : 900)
    await page.setCoarsePointer(width === 390)
    await page.setReducedMotion(reduce)
    await page.evaluate(`(() => { localStorage.setItem('ycoding.desktop.theme', 'dark'); localStorage.setItem('ycoding.desktop.animations', 'true'); location.reload(); })()`)
    await wait(page, `document.querySelector('#turn-msg_response') && document.fonts.status === 'loaded'`)
    await page.evaluate(`(() => { if (document.querySelector('.rl-companion')) document.querySelector('.rl-companion-toggle').click(); })()`)
    await wait(page, `!document.querySelector('.rl-companion')`)
    await settleR7(page)
    return page
  } catch (cause) { await page.close(); throw cause }
}

function r7Failures(geometry: R7Geometry, name: string) {
  return [
    ...geometry.overflow.map(item => `${name}: overflow ${item}`),
    ...geometry.smallControls.map(item => `${name}: text below 12px ${item}`),
    ...geometry.unnamedControls.map(item => `${name}: unnamed ${item}`),
    ...geometry.nativeHints.map(item => `${name}: native hint ${item}`),
    ...geometry.offscreenComposer.map(item => `${name}: composer action outside viewport ${item}`),
    ...geometry.offscreenComposerContainers.map(item => `${name}: composer container outside viewport ${item}`),
    ...geometry.nestedBorders.map(item => `${name}: nested outline ${item}`),
    ...geometry.errors.map(item => `${name}: runtime ${String(item)}`),
  ]
}

function r8ConversationFailures(geometry: R7Geometry, name: string, width: number, maximum: number) {
  const failures: string[] = []
  const reading = geometry.readingTrack
  if (!reading) failures.push(`${name}: reading track is missing`)
  else {
    if (width === 1440 && Math.abs(reading.outer.width - maximum) > 1) failures.push(`${name}: wide outer track is ${reading.outer.width}px, expected the documented ${maximum}px maximum`)
    for (const kind of ['assistant head', 'Thought', 'Ran tools', 'Step provenance', 'Shell finished', 'user bubble', 'markdown', 'prose']) if (!reading.rows.some(row => row.kind === kind)) failures.push(`${name}: required ${kind} row is missing`)
    for (const row of reading.rows) {
      const leftFits = row.kind === 'user bubble' ? row.bounds.width <= reading.outer.width * .78 + 1 : Math.abs(row.bounds.x - reading.outer.x) <= 1
      if (!leftFits || Math.abs(row.bounds.right - reading.outer.right) > 1) failures.push(`${name}: ${row.kind} ${row.turn} bounds ${row.bounds.x}..${row.bounds.right} do not fit the track ${reading.outer.x}..${reading.outer.right}`)
    }
    if (!reading.controls.some(control => control.kind.includes('rl-disclosure-time')) || !reading.controls.some(control => control.kind.includes('rl-disclosure-chev'))) failures.push(`${name}: duration/chevron controls are missing`)
    for (const control of reading.controls) if (control.bounds.x < reading.outer.x || control.bounds.right > reading.outer.right || Math.abs(reading.outer.x - control.row.x) > 1 || Math.abs(reading.outer.right - control.row.right) > 1) failures.push(`${name}: duration/chevron is detached from the outer track: ${JSON.stringify(control)}`)
    for (const floating of reading.floating) if (floating.bounds.x < reading.outer.right && floating.bounds.right > reading.outer.x && floating.bounds.y < reading.viewport.bottom && floating.bounds.bottom > reading.viewport.y) failures.push(`${name}: floating ${floating.label} overlaps the reading track: ${JSON.stringify(floating.bounds)}`)
  }
  const cluster = geometry.composerCluster
  if (!cluster) failures.push(`${name}: composer metrics/delivery/Send cluster is missing`)
  else {
    if (cluster.autoSendGap < 8 || cluster.autoSendGap > 10 || Math.abs(cluster.delivery.bottom - cluster.send.bottom) > 1) failures.push(`${name}: Auto-to-Send gap is ${cluster.autoSendGap}px, expected 8–10px on one baseline`)
    if (cluster.rightInset < 10 || cluster.rightInset > 12 || cluster.bottomInset < 10 || cluster.bottomInset > 12 || Math.abs(cluster.leftInset - cluster.rightInset) > 1) failures.push(`${name}: composer insets are not symmetric 10–12px: ${JSON.stringify({ left: cluster.leftInset, right: cluster.rightInset, bottom: cluster.bottomInset })}`)
    if (cluster.metrics.right > cluster.delivery.x || cluster.delivery.right > cluster.send.x) failures.push(`${name}: metrics/delivery/Send order is not retained`)
    if (width === 390) for (const target of cluster.targets) if (target.bounds.width < 44 || target.bounds.height < 44) failures.push(`${name}: compact target is below 44px: ${target.label}`)
  }
  return failures
}

function r8CoordinationFailures(geometry: R7Geometry, name: string, width: number) {
  const layout = geometry.coordination
  if (!layout) return [`${name}: Coordination pane geometry is missing`]
  const failures: string[] = []
  if (!layout.mainFlexColumn || Math.abs(layout.pane.bottom - layout.viewportBottom) > 1 || Math.abs(layout.main.y - layout.pane.y) > 1 || Math.abs(layout.main.bottom - layout.pane.bottom) > 1 || Math.abs(layout.footer.bottom - layout.pane.bottom) > 1) failures.push(`${name}: Coordination main/footer do not fill the pane: ${JSON.stringify(layout)}`)
  if (!layout.listFlex || layout.footerBorder < 1 || layout.list.bottom > layout.footer.y + 1 || !['auto', 'scroll'].includes(layout.listOverflow)) failures.push(`${name}: member list does not own the remaining scroll region above a bordered footer: ${JSON.stringify(layout)}`)
  if (width === 1440 && (!layout.sidebar || Math.abs(layout.sidebar.y - layout.pane.y) > 1 || Math.abs(layout.sidebar.bottom - layout.pane.bottom) > 1 || layout.sidebarBorder === null || layout.sidebarBorder < 1 || !layout.sidebarBackground || layout.sidebarBackground === 'rgba(0, 0, 0, 0)')) failures.push(`${name}: Add-existing/New-member sidebar does not fill the pane with its surface and left border: ${JSON.stringify(layout)}`)
  return failures
}

async function r7Motion(page: Page, selector: string) {
  return page.evaluate(`(() => { const animations = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity && (animation.effect?.target?.closest(${JSON.stringify(selector)}) || animation.effect?.pseudoElement?.includes('view-transition'))); const spatial = animations.filter(animation => animation.effect.getKeyframes().some(frame => frame.transform && frame.transform !== 'none' || frame.translate && frame.translate !== 'none' || frame.height || frame.gridTemplateRows)); return { count: animations.length, content: animations.filter(animation => !animation.effect.target.closest('.rl-disclosure-chev') && animation.effect.getKeyframes().some(frame => ['opacity', 'transform', 'translate', 'height', 'gridTemplateRows'].some(key => key in frame))).length, spatial: spatial.length, slowEffects: animations.filter(animation => Number(animation.effect.getTiming().duration) > 150).length, effects: animations.map(animation => ({ target: animation.effect.target.tagName + '.' + animation.effect.target.getAttribute('class'), name: animation.animationName || animation.transitionProperty || '', duration: animation.effect.getTiming().duration, properties: [...new Set(animation.effect.getKeyframes().flatMap(frame => Object.keys(frame).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))))] })) }; })()`, (value: unknown) => { const result = decodeRecord(value); return { count: (decodeNumber)(result["count"]), content: (decodeNumber)(result["content"]), spatial: (decodeNumber)(result["spatial"]), slowEffects: (decodeNumber)(result["slowEffects"]) } })
}

test("Desktop r7 provenance groups only consecutive intermediate steps and restarts at user and result boundaries", async () => {
  prepareImplementedSurface(); referenceScene = false; populatedKind = "multiagent"
  replyText = "Selected checks remain read-only. Native execution is not established by this fixture."
  const page = await openR7(1440)
  try {
    const expected = ["r7_prompt_0", "r7_intermediate_0", "r7_intermediate_1", "r7_intermediate_2", "r7_intermediate_3", "r7_intermediate_4", "r7_response_0", "r7_intermediate_5", "r7_intermediate_6", "r7_prompt_1", "r7_response_1", "r7_prompt_2", "r7_response_2", "r7_prompt_3", "r7_response_3", "r7_prompt_4", "r7_response_4", "r7_prompt_5", "msg_response"]
    expect(await page.evaluate(`[...document.querySelectorAll('.transcript__turn[data-speaker]')].map(turn => turn.id.slice(5))`, decodeArray(decodeString))).toEqual(expected)
    const provenance = await page.evaluate(`[...document.querySelectorAll('.transcript__turn[data-speaker="assistant"]')].map(turn => { const head = turn.querySelector('.transcript-message__head'); const box = head?.getBoundingClientRect(); return { id: turn.id.slice(5), prominent: !!box && box.width > 0 && box.height > 0 && getComputedStyle(head).visibility !== 'hidden' && !head.closest('details:not([open]) > :not(summary)'), text: head?.textContent.trim() || '' }; })`, decodeArray((value: unknown) => { const result = decodeRecord(value); return { id: (decodeString)(result["id"]), prominent: (decodeBoolean)(result["prominent"]), text: (decodeString)(result["text"]) } }))
    const boundaries = ["r7_intermediate_0", "r7_intermediate_2", "r7_intermediate_3", "r7_response_0", "r7_intermediate_5", "r7_response_1", "r7_response_2", "r7_response_3", "r7_response_4", "msg_response"]
    expect(provenance.filter(item => boundaries.includes(item.id)).map(item => ({ id: item.id, prominent: item.prominent }))).toEqual(boundaries.map(id => ({ id, prominent: true })))
    expect(provenance.find(item => item.id === "r7_intermediate_2")?.text).toContain("reviewer · synthetic/synthetic")
    expect(provenance.find(item => item.id === "r7_intermediate_3")?.text).toContain("reviewer · synthetic/synthetic-review")
    await page.evaluate(`(() => { for (const button of document.querySelectorAll('.transcript-tools__button[aria-expanded="false"], .transcript-reasoning summary[aria-expanded="false"]')) button.click(); document.querySelector('#turn-r7_intermediate_0').scrollIntoView({ block: 'start', behavior: 'instant' }); })()`)
    await wait(page, `document.querySelectorAll('.rl-step-card').length === 11 && document.querySelectorAll('.transcript-reasoning[open]').length === 10`)
    expect(await page.evaluate(`(() => { const ids = ['r7_response_0', 'r7_response_1', 'r7_response_2', 'r7_response_3', 'r7_response_4', 'msg_response']; return ids.every((id, index) => { const turn = document.getElementById('turn-' + id); return turn.querySelector('.transcript-reasoning__body').textContent.includes('Reasoning provenance: retained synthetic review ' + (index + 1)) && [...turn.querySelectorAll('.transcript-message__text pre code')].length === 2 && [...turn.querySelectorAll('.transcript-message__text pre code')].every(code => code.textContent.includes(${JSON.stringify(populatedLongLine)})); }) && document.querySelectorAll('.rl-step-card[data-status="failed"]').length === 1 && document.body.textContent.includes(${JSON.stringify(populatedToolError)}) && document.querySelector('#turn-msg_response').textContent.includes('Final result:') && Array.from({ length: 7 }, (_, step) => document.querySelector('#turn-r7_intermediate_' + step).textContent.includes('Intermediate ' + ([1, 3, 5].includes(step) ? 'read' : 'reasoning') + ' provenance ' + (step + 1))).every(Boolean); })()`, decodeBoolean)).toBe(true)
    await captureR7(page, "r7-provenance-boundaries-1440-expanded")
    const output = process.env.YCODING_DESKTOP_CAPTURE_DIR
    if (output) { const file = path.join(output, "r7-provenance-boundaries.json"); if (await Bun.file(file).exists()) throw new Error("Provenance capture already exists"); await Bun.write(file, JSON.stringify(provenance, null, 2)) }
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    expect(provenance.filter(item => ["r7_intermediate_1", "r7_intermediate_4", "r7_intermediate_6"].includes(item.id)).map(item => ({ id: item.id, prominent: item.prominent }))).toEqual(["r7_intermediate_1", "r7_intermediate_4", "r7_intermediate_6"].map(id => ({ id, prominent: false })))
    expect(await page.evaluate(`['r7_intermediate_1', 'r7_intermediate_4', 'r7_intermediate_6'].every(id => { const turn = document.getElementById('turn-' + id); const details = turn.querySelector('details[aria-label="Step provenance"]'); details.querySelector('summary').click(); const head = details.querySelector('.transcript-message__head'); return details.open && !head.closest('details:not([open]) > :not(summary)') && head.getBoundingClientRect().height > 0 && head.textContent.includes('synthetic/') && details.textContent.includes(id); })`, decodeBoolean)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("Desktop r7 commentary, ordinary prose and final results restart intermediate provenance", async () => {
  prepareImplementedSurface(); referenceScene = false
  const commentary = "The retained cursor belongs to this connection. Keep the reader's visible message while the next page arrives."
  const ordinary = "The source read confirms the retained boundary. This paragraph explains the result before another inspection."
  const final = "Final result: the cursor and visible message remain separate, and the selected evidence is complete."
  const profile = "synthetic-review-profile"
  const ids = ["r7_commentary_before", "r7_commentary_prose", "r7_commentary_after", "r7_ordinary_prose", "r7_ordinary_after", "r7_final_result", "msg_response"]
  const messages = ids.map((id, index) => {
    const created = 1000 + index * 10
    const prose = index === 1 ? commentary : index === 3 ? ordinary : index === 5 ? final : undefined
    return { id, sessionID: "ses_test", type: "assistant", agent: "reviewer", model: { id: "synthetic", providerID: "synthetic", variant: "high", profile }, finish: index === 5 ? "stop" : "tool-calls", content: prose ? [{ id: id + "_text", type: "text", text: prose, ...(index === 1 ? { phase: "commentary" } : index === 5 ? { phase: "final_answer" } : {}), time: { created } }] : [
      { id: id + "_reasoning", type: "reasoning", text: "Reasoning retained for " + id, time: { created, completed: created + 1 } },
      { id: id + "_read", type: "tool", name: "read", state: { status: "completed", input: { path: "src/synthetic-cursor.ts" }, structured: {}, content: [{ type: "text", text: "Read output retained for " + id }] }, time: { created: created + 1, completed: created + 2 } },
    ], time: { created, completed: created + 3 } }
  })
  sceneRead = call => call.route.endsWith('/snapshot') ? { sourceEpoch: "synthetic", session: session("ses_test"), messages, watermark: { type: "log.synced", aggregateID: "ses_test", seq: 1000 } } : call.route.endsWith('/message') ? { data: messages } : undefined
  const page = await openR7(1440)
  try {
    expect(await page.evaluate(`[...document.querySelectorAll('.transcript__turn[data-speaker="assistant"]')].map(turn => turn.id.slice(5))`, decodeArray(decodeString))).toEqual(ids)
    const provenance = await page.evaluate(`[...document.querySelectorAll('.transcript__turn[data-speaker="assistant"]')].map(turn => { const head = turn.querySelector('.transcript-message__head'); const box = head?.getBoundingClientRect(); return { id: turn.id.slice(5), prominent: !!box && box.width > 0 && box.height > 0 && getComputedStyle(head).visibility !== 'hidden' && !head.closest('details:not([open]) > :not(summary)') }; })`, decodeArray((value: unknown) => { const result = decodeRecord(value); return { id: (decodeString)(result["id"]), prominent: (decodeBoolean)(result["prominent"]) } }))
    expect(await page.evaluate(`[...document.querySelectorAll('.transcript-message__text')].map(element => element.textContent.trim())`, decodeArray(decodeString))).toEqual([commentary, ordinary, final])
    await page.evaluate(`(() => { for (const button of document.querySelectorAll('.transcript-tools__button[aria-expanded="false"], .transcript-reasoning summary[aria-expanded="false"]')) button.click(); })()`)
    await wait(page, `document.querySelectorAll('.rl-step-card').length === 4 && document.querySelectorAll('.transcript-reasoning__body').length === 4`)
    expect(await page.evaluate(`${JSON.stringify(ids.filter((_, index) => index % 2 === 0))}.every(id => { const turn = document.getElementById('turn-' + id); return turn.querySelector('.transcript-reasoning__body').textContent.trim() === 'Reasoning retained for ' + id && turn.querySelector('.desktop-tool-evidence:last-of-type pre code').textContent === 'Read output retained for ' + id && turn.querySelector('[aria-label="Copy input"]') && turn.querySelector('[aria-label="Copy output"]'); })`, decodeBoolean)).toBe(true)
    await page.evaluate(`document.querySelector('#turn-r7_commentary_before [aria-label="Copy output"]').click()`)
    await wait(page, `document.querySelector('#turn-r7_commentary_before [role="status"]')?.textContent === 'Output copied'`)
    expect(clipboard).toEqual(["Read output retained for r7_commentary_before"])
    await captureR7(page, "r7-commentary-boundaries-1440-expanded")
    const output = process.env.YCODING_DESKTOP_CAPTURE_DIR
    if (output) { const file = path.join(output, "r7-commentary-boundaries.json"); if (await Bun.file(file).exists()) throw new Error("Commentary capture already exists"); await Bun.write(file, JSON.stringify(provenance, null, 2)) }
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    expect(provenance).toEqual(ids.map(id => ({ id, prominent: true })))
    expect(await page.evaluate(`[...document.querySelectorAll('.transcript__turn[data-speaker="assistant"]')].every(turn => { const text = turn.querySelector('.transcript-message__head').textContent; return ['reviewer', 'synthetic/synthetic', 'high', ${JSON.stringify(profile)}].every(value => text.includes(value)); })`, decodeBoolean)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("Desktop r7 populated transcripts retain centered tracks and long evidence", async () => {
  const design: unknown = Bun.YAML.parse((await Bun.file(path.join(import.meta.dir, "../DESIGN.md")).text()).split("---")[1]!)
  if (design === null || typeof design !== "object" || !("layout" in design)) throw new Error("Desktop DESIGN requires a layout mapping.")
  const layout = design.layout
  if (layout === null || typeof layout !== "object" || !("conversation-max" in layout) || typeof layout["conversation-max"] !== "string") throw new Error("Desktop DESIGN requires a conversation-max value.")
  const maximum = parseFloat(layout["conversation-max"])
  expect(maximum).toBeGreaterThanOrEqual(960)
  expect(maximum).toBeLessThanOrEqual(1040)
  const failures: string[] = []
  for (const kind of ["multiagent", "tool-heavy", "thought-heavy"] as const) for (const width of [1440, 390]) {
    prepareImplementedSurface(); referenceScene = false; populatedKind = kind; sessionCost = 3.21
    replyText = "Selected checks remain read-only. Native execution is not established by this fixture."
    const messages = () => [...transcript(), { id: "r8_shell_finished", sessionID: "ses_test", type: "synthetic", text: "The selected cursor boundary check finished without changing files.", description: "The selected cursor boundary check finished without changing files.", metadata: { source: "shell", state: "completed" }, time: { created: 1600 } }]
    sceneRead = call => call.route.endsWith('/snapshot') ? { sourceEpoch: "synthetic", session: session("ses_test"), messages: messages(), watermark: { type: "log.synced", aggregateID: "ses_test", seq: 1000 } } : call.route.endsWith('/message') ? { data: messages() } : call.route === "/api/vcs/diff" ? { location, data: [{ file: "src/session/cursor-pagination-and-retained-message-boundaries.ts", patch: `@@ -1 +1 @@\n-${populatedLongLine}\n+${populatedLongLine.replace("updated-descending", "created-ascending")}`, additions: 1, deletions: 1, status: "modified" }] } : call.route === "/api/session/ses_test/subagent" ? { data: ["ses_child_a", "ses_child_b"].map((sessionID, index) => ({ sessionID, parentID: "ses_test", description: index === 0 ? "Trace cursor ownership and retained history" : "Review keyboard focus and streaming layout", agent: index === 0 ? "planner" : "reviewer", model: selection(), background: true, state: index === 0 ? "running" : "waiting", revision: 1, time: { created: 1, updated: 2 } })), summary: { total: 2, active: 2 }, cursor: {} } : undefined
    const page = await openR7(width)
    const name = `r7-${kind}-${width}`
    try {
      await page.evaluate(`localStorage.setItem('ycoding.desktop.prompt-stashes', JSON.stringify([{ ...${JSON.stringify(populatedDraft)}, id: 'r7-populated-draft', createdAt: 1 }]))`)
      await command(page, "Stash or restore the prompt")
      await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Pop and restore').click()`)
      await wait(page, `!document.querySelector('dialog[open]') && document.querySelector('.rl-capsule textarea').value === ${JSON.stringify(populatedDraft.text)}`)
      const point = await page.evaluate(`(() => { const box = document.querySelector('.conversation__scroll').getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()`, decodePair)
      await page.wheel(point[0], point[1], 0, -800)
      await wait(page, `document.querySelector('[aria-label="Jump to latest"]')`)
      await page.evaluate(`document.querySelector('#turn-msg_response').scrollIntoView({ block: 'start', behavior: 'instant' })`)
      const collapsed = await captureR7(page, `${name}-collapsed`)
      failures.push(...r7Failures(collapsed, `${name}-collapsed`))
      failures.push(...r8ConversationFailures(collapsed, `${name}-collapsed`, width, maximum))
      const columns = collapsed.columns
      if (!columns || Math.abs(columns.left - columns.right) > 1 || columns.left < (width === 390 ? 12 : 24) || columns.right < (width === 390 ? 12 : 24) || columns.ratio < 0.75 || Math.abs(columns.composerLeft) > 1 || Math.abs(columns.composerRight) > 1) failures.push(`${name}: transcript/composer tracks are not balanced and aligned: ${JSON.stringify(columns)}`)
      const metadata = collapsed.visibleMetadata.map(value => value.split(' · ').slice(0, 3).join(' · '))
      if (!metadata.length || (kind === "multiagent" && !["planner", "build", "reviewer"].every(actor => metadata.some(value => value.startsWith(actor + " · "))))) failures.push(`${name}: changed actor/model provenance is missing`)
      expect(await page.evaluate(`document.querySelector('#turn-msg_response .transcript-message__text').textContent.includes('Final result:') && document.querySelectorAll('.transcript-tools__button[aria-expanded="false"]').length > 0`, decodeBoolean)).toBe(true)
      await page.evaluate(`(() => { for (const button of document.querySelectorAll('.transcript-tools__button[aria-expanded="false"], .transcript-reasoning summary[aria-expanded="false"]')) button.click(); })()`)
      await wait(page, `document.querySelector('.rl-step-card[data-status="failed"]') && document.querySelector('.transcript-reasoning[open]')`)
      const expanded = await captureR7(page, `${name}-expanded`)
      failures.push(...r7Failures(expanded, `${name}-expanded`))
      failures.push(...r8ConversationFailures(expanded, `${name}-expanded`, width, maximum))
      expect(await page.evaluate(`document.querySelector('#turn-r8_shell_finished .transcript-notice-pill')?.textContent.includes('Shell · finished')`, decodeBoolean)).toBe(true)
      expect(await page.evaluate(`document.body.textContent.includes(${JSON.stringify(populatedToolError)}) && document.body.textContent.includes('Read provenance: synthetic source fixture, lines 120–160.') && document.body.textContent.includes('Reasoning provenance: retained synthetic review 6') && [...document.querySelectorAll('pre code')].some(code => code.textContent.includes(${JSON.stringify(populatedLongLine)}))`, decodeBoolean)).toBe(true)
      expect(await page.evaluate(`(() => { const turns = [...document.querySelectorAll('.transcript__turn[data-speaker="assistant"]')].filter(turn => turn.id === 'turn-msg_response' || /^turn-r7_response_[0-4]$/.test(turn.id)); return turns.length === 6 && document.querySelectorAll('.transcript__turn[data-speaker="user"]').length === 6 && turns.every((turn, index) => turn.id === (index === 5 ? 'turn-msg_response' : 'turn-r7_response_' + index) && turn.querySelector('.transcript-reasoning__body').textContent.includes('Reasoning provenance: retained synthetic review ' + (index + 1)) && [...turn.querySelectorAll('.transcript-message__text pre code')].length === 2 && [...turn.querySelectorAll('.transcript-message__text pre code')].every(code => code.textContent.includes(${JSON.stringify(populatedLongLine)}))) && document.querySelectorAll('.rl-step-card').length === ${kind === "tool-heavy" ? 21 : 11} && document.querySelectorAll('.rl-step-card[data-status="failed"]').length === ${kind === "tool-heavy" ? 6 : 1}; })()`, decodeBoolean)).toBe(true)
      if (kind === "tool-heavy") {
        await command(page, "/diff")
        await wait(page, `document.querySelector('dialog[data-kind="diff"] .desktop-diff')`)
        if (width === 390) await tap(page, '.desktop-diff nav button[aria-label="src/session/cursor-pagination-and-retained-message-boundaries.ts"]')
        await wait(page, `document.querySelector('.desktop-diff__files')?.textContent.includes('created-ascending')`)
        for (const wrap of ["none", "word"] as const) {
          await page.evaluate(`(() => { const input = [...document.querySelectorAll('.desktop-diff label')].find(label => label.textContent.trim() === 'Wrap diff lines').querySelector('input'); if (input.checked !== ${wrap === "word"}) input.click(); })()`)
          await wait(page, `document.querySelector('.desktop-diff').getAttribute('data-wrap') === ${JSON.stringify(wrap)}`)
          await settleR7(page)
          expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.diffs')).wrap`, decodeString)).toBe(wrap)
          expect(await page.evaluate(`(() => { const tables = [...document.querySelectorAll('.desktop-diff table')].filter(table => table.getBoundingClientRect().width > 0); return tables.length === 1 && tables.every(table => { const codes = [...table.querySelectorAll('code')]; const text = codes.map(code => code.textContent); const unified = table.classList.contains('desktop-diff__unified'); return text.includes((unified ? '−' : '') + ${JSON.stringify(populatedLongLine)}) && text.includes((unified ? '+' : '') + ${JSON.stringify(populatedLongLine.replace("updated-descending", "created-ascending"))}) && codes.every(code => ${wrap === "none" ? "getComputedStyle(code).whiteSpace === 'pre'" : "['pre-wrap', 'break-spaces'].includes(getComputedStyle(code).whiteSpace)"}); }); })()`, decodeBoolean)).toBe(true)
          if (wrap === "none") {
            const point = await page.evaluate(`(() => { const viewport = [...document.querySelectorAll('.desktop-diff__file *')].find(element => /^(auto|scroll)$/.test(getComputedStyle(element).overflowX) && (element.matches('table, pre, code') || element.querySelector('table, pre, code')) && element.clientWidth > 0 && element.scrollWidth > element.clientWidth); if (!viewport) return []; window.__r7DiffViewport = viewport; const box = viewport.getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()`, decodeUnion((value: unknown) => { const result = decodeArray((item: unknown) => item)(value); if (result.length) throw new Error("Expected an empty array"); return [] as const }, decodePair))
            expect(point).toHaveLength(2)
            if (point.length !== 2) throw new Error("Diff overflow viewport coordinates are missing")
            await page.wheel(point[0], point[1], 200, 0)
            await wait(page, `window.__r7DiffViewport.scrollLeft > 0`)
            expect(await page.evaluate(`(() => { const viewport = window.__r7DiffViewport; const bounds = viewport.closest('.desktop-diff__files').getBoundingClientRect(); const box = viewport.getBoundingClientRect(); return viewport.scrollWidth > viewport.clientWidth && viewport.scrollLeft > 0 && box.x >= bounds.x && box.right <= bounds.right; })()`, decodeBoolean)).toBe(true)
          } else {
            expect(await page.evaluate(`[...document.querySelectorAll('.desktop-diff__file *')].filter(element => /^(auto|scroll)$/.test(getComputedStyle(element).overflowX) && (element.matches('table, pre, code') || element.querySelector('table, pre, code'))).every(element => element.scrollWidth <= element.clientWidth && element.scrollLeft === 0)`, decodeBoolean)).toBe(true)
          }
          const diff = await captureR7(page, `${name}-diff-${wrap}`)
          failures.push(...r7Failures(diff, `${name}-diff-${wrap}`))
        }
        await page.pressEscape()
        if (width === 390) await page.pressEscape()
        await wait(page, `!document.querySelector('dialog[open]')`)
      }
      expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.prompt-stashes'); localStorage.removeItem('ycoding.desktop.diffs')`); await page.close() }
  }
  expect(failures).toEqual([])
}, 120_000)

test("Desktop r7 sparse and populated Projects keep natural member rows and compact back navigation", async () => {
  const failures: string[] = []
  for (const count of [1, 7]) for (const width of [1440, 390]) {
    prepareImplementedSurface(); populatedKind = "multiagent"
    const names = ["Build cursor reconciliation", "Review keyboard focus", "Verify long code wrapping", "Inspect retained history", "Reconcile tool failures", "Check streaming anchors", "Consolidate final findings"]
    const group = { ...sceneGroup, name: "Cursor pagination", master: { ...sceneParticipant("ses_test"), title: "Pagination workstream" }, members: Array.from({ length: count }, (_, index) => ({ ...sceneParticipant(`ses_member_${index}`), title: names[index]!, state: ["running", "waiting", "idle", "failed"][index % 4]! })) }
    const second = { ...sceneGroup, id: "cgrp_accessibility", name: "Keyboard accessibility", master: { ...sceneParticipant("ses_other"), title: "Keyboard workstream" }, members: [{ ...sceneParticipant("ses_accessibility"), title: "Audit disclosure focus and reachable controls" }] }
    sceneRead = call => call.route === "/api/coordination" ? { data: [{ id: group.id }, { id: second.id }] } : call.route === `/api/coordination/${group.id}` ? { data: group } : call.route === `/api/coordination/${second.id}` ? { data: second } : undefined
    const page = await openR7(width)
    const name = `r7-projects-${count === 1 ? "sparse" : "populated"}-${width}`
    try {
      await page.navigate(`${origin}/#/projects`)
      await wait(page, `document.querySelectorAll('[data-project-roster] > li').length === ${count + 1} && document.querySelectorAll('.desktop-project-overview .rl-list > button[aria-pressed]').length === 2`)
      const geometry = await captureR7(page, name)
      failures.push(...r7Failures(geometry, name))
      failures.push(...r8CoordinationFailures(geometry, name, width))
      const roster = geometry.roster
      if (!roster || roster.rowHeights.some(height => height > 96)) failures.push(`${name}: member rows stretch beyond natural height: ${JSON.stringify(roster)}`)
      if (geometry.coordination && geometry.coordination.listScrollHeight > geometry.coordination.listClientHeight) {
        const before = geometry.coordination.footer.bottom
        expect(await page.evaluate(`(() => { const footer = document.querySelector('.desktop-project-options'); for (let node = document.querySelector('[data-project-roster]'); node && node !== document.querySelector('.desktop-project-overview'); node = node.parentElement) { if (!node.contains(footer) && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) { node.scrollTop = node.scrollHeight; return node.scrollTop > 0; } } return false; })()`, decodeBoolean)).toBe(true)
        expect(await page.evaluate(`document.querySelector('.desktop-project-options').getBoundingClientRect().bottom`, decodeNumber)).toBe(before)
      }
      expect(await page.evaluate(`[...document.querySelectorAll('[data-project-roster] button')].every(button => button.getAttribute('aria-label') && button.querySelector('svg') && button.getAttribute('data-tooltip'))`, decodeBoolean)).toBe(true)
      const button = '.desktop-project-overview .rl-list > button[aria-pressed]'
      if (width === 390) {
        await tap(page, button)
        await wait(page, `document.querySelector('[aria-label="Back to project list"]')?.getClientRects().length`)
        failures.push(...r7Failures(await captureR7(page, `${name}-inspector`), `${name}-inspector`))
        await page.pressEscape()
        await wait(page, `document.querySelector(${JSON.stringify(button)}).getClientRects().length > 0`)
        expect(await page.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(button)})`, decodeBoolean)).toBe(true)
      }
      await page.evaluate(`document.querySelectorAll(${JSON.stringify(button)})[1].click()`)
      await wait(page, `document.querySelector('.desktop-project-detail h3')?.textContent === 'Keyboard accessibility' || (document.querySelector('[aria-label="Back to project list"]')?.getClientRects().length > 0 && document.body.textContent.includes('Keyboard accessibility'))`)
      if (width === 390) await page.pressEscape()
      await wait(page, `document.querySelectorAll('[data-project-roster] > li').length === 2`)
      const selected = await captureR7(page, `${name}-selected`)
      failures.push(...r7Failures(selected, `${name}-selected`), ...r8CoordinationFailures(selected, `${name}-selected`, width))
      expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    } finally { await page.close() }
  }
  expect(failures).toEqual([])
}, 90_000)

test("Desktop r7 disclosure motion retains focus, mounted streaming content and detached reader position", async () => {
  const failures: string[] = []
  for (const reduce of [false, true]) for (const width of [1440, 390]) {
    prepareImplementedSurface(); referenceScene = false; populatedKind = "thought-heavy"; running = true
    replyText = "Streaming review checkpoint: retain the reader and the draft."
    const page = await openR7(width, reduce)
    const name = `r7-motion-${reduce ? "reduced" : "normal"}-${width}`
    try {
      await message(page, "Retain this draft while the response streams.")
      const point = await page.evaluate(`(() => { const box = document.querySelector('.conversation__scroll').getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()`, decodePair)
      await page.evaluate(`document.querySelector('[aria-label="Jump to latest"]')?.click()`)
      await wait(page, `(() => { const scroll = document.querySelector('.conversation__scroll'); return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 1; })()`)
      replyText += "\n\nAttached streaming evidence. ".repeat(12)
      await page.evaluate(`window.__desktopFixture.emit({ type: 'session.text.delta', data: { sessionID: 'ses_test', assistantMessageID: 'msg_response', ordinal: 4, delta: 'Attached streaming evidence.' } })`)
      await wait(page, `document.querySelector('#turn-msg_response').textContent.includes('Attached streaming evidence.')`)
      await settleR7(page)
      const attachedDistance = await page.evaluate(`(() => { const scroll = document.querySelector('.conversation__scroll'); return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight; })()`, decodeNumber)
      if (attachedDistance > 1) failures.push(`${name}: attached reader left the latest response by ${attachedDistance}px`)
      failures.push(...r7Failures(await captureR7(page, `${name}-attached`), name))
      await page.wheel(point[0], point[1], 0, -700)
      await wait(page, `document.querySelector('[aria-label="Jump to latest"]')`)
      await page.evaluate(`document.querySelector('#turn-msg_response .transcript-reasoning').scrollIntoView({ block: 'start', behavior: 'instant' })`)
      await settleR7(page)
      await page.evaluate(`(() => { const button = document.querySelector('#turn-msg_response .transcript-tools__button'); button.focus({ preventScroll: true }); window.__r7Stable = { input: document.querySelector('.rl-capsule textarea'), turn: document.querySelector('#turn-msg_response'), button, top: document.querySelector('.conversation__scroll').scrollTop, shifts: [] }; window.__r7Stable.observer = new PerformanceObserver(list => window.__r7Stable.shifts.push(...list.getEntries().filter(entry => !entry.hadRecentInput).map(entry => entry.value))); window.__r7Stable.observer.observe({ type: 'layout-shift', buffered: false }); })()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      const motion = await r7Motion(page, '#turn-msg_response')
      expect(await page.evaluate(`document.activeElement === window.__r7Stable.button`, decodeBoolean)).toBe(true)
      if (!reduce && motion.content === 0) failures.push(`${name}: disclosure content has no observable functional transition`)
      if (reduce && (motion.spatial > 0 || motion.slowEffects > 0)) failures.push(`${name}: reduced motion retains spatial or slow effects: ${JSON.stringify(motion)}`)
      await wait(page, `document.querySelector('#turn-msg_response .transcript-tools__button').getAttribute('aria-expanded') === 'true'`)
      const expanded = await captureR7(page, `${name}-expanded`)
      failures.push(...r7Failures(expanded, name))
      const anchor = await page.evaluate(`document.querySelector('#turn-msg_response .transcript-reasoning').getBoundingClientRect().top`, decodeNumber)
      replyText += "\n\nDetached streaming evidence. ".repeat(16)
      await page.evaluate(`window.__desktopFixture.emit({ type: 'session.text.delta', data: { sessionID: 'ses_test', assistantMessageID: 'msg_response', ordinal: 4, delta: 'Detached streaming evidence.' } })`)
      await wait(page, `document.querySelector('#turn-msg_response').textContent.includes('Detached streaming evidence.')`)
      await settleR7(page)
      expect(await page.evaluate(`document.querySelector('.rl-capsule textarea') === window.__r7Stable.input && document.querySelector('#turn-msg_response') === window.__r7Stable.turn && document.querySelector('#turn-msg_response .transcript-tools__button') === window.__r7Stable.button && document.activeElement === window.__r7Stable.button && document.querySelector('.rl-capsule textarea').value === 'Retain this draft while the response streams.'`, decodeBoolean)).toBe(true)
      expect(await page.evaluate(`Math.abs(document.querySelector('#turn-msg_response .transcript-reasoning').getBoundingClientRect().top - ${anchor})`, decodeNumber)).toBeLessThanOrEqual(1)
      await page.pressKey("Enter", "Enter", 13, "\r")
      const exit = await r7Motion(page, '#turn-msg_response')
      if (!reduce && exit.content === 0) failures.push(`${name}: disclosure content has no observable exit transition`)
      if (reduce && (exit.spatial > 0 || exit.slowEffects > 0)) failures.push(`${name}: reduced-motion exit retains spatial or slow effects`)
      await wait(page, `document.querySelector('#turn-msg_response .transcript-tools__button').getAttribute('aria-expanded') === 'false'`)
      failures.push(...r7Failures(await captureR7(page, `${name}-collapsed`), name))
      const stable = await page.evaluate(`({ shifts: window.__r7Stable.shifts, focusRetained: document.activeElement === window.__r7Stable.button })`, (value: unknown) => { const result = decodeRecord(value); return { shifts: (decodeArray(decodeNumber))(result["shifts"]), focusRetained: (decodeBoolean)(result["focusRetained"]) } })
      expect(stable.shifts.reduce((sum, value) => sum + value, 0)).toBe(0)
      expect(stable.focusRetained).toBe(true)
      await page.evaluate(`window.__r7Stable.observer.disconnect()`)
      const second = { ...sceneGroup, id: "cgrp_motion", name: "Keyboard accessibility", master: { ...sceneParticipant("ses_other"), title: "Keyboard workstream" }, members: [{ ...sceneParticipant("ses_accessibility"), title: "Audit disclosure focus" }] }
      sceneRead = call => call.route === "/api/coordination" ? { data: [{ id: sceneGroup.id }, { id: second.id }] } : call.route === `/api/coordination/${second.id}` ? { data: second } : undefined
      await page.navigate(`${origin}/#/projects`)
      await wait(page, `document.querySelectorAll('.desktop-project-overview .rl-list > button[aria-pressed]').length === 2`)
      await settleR7(page)
      await page.evaluate(`document.querySelectorAll('.desktop-project-overview .rl-list > button[aria-pressed]')[1].focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `document.querySelector('.desktop-project-detail h3')?.textContent === 'Keyboard accessibility'`)
      const project = await r7Motion(page, '.desktop-project-settings')
      if (!reduce && project.content === 0) failures.push(`${name}: Project selection has no observable content transition`)
      if (reduce && (project.spatial > 0 || project.slowEffects > 0)) failures.push(`${name}: reduced-motion Project selection retains spatial or slow effects`)
      failures.push(...r7Failures(await captureR7(page, `${name}-project-selected`), name))
      if (width === 390) {
        await page.pressEscape()
        await wait(page, `document.querySelector('.desktop-project-overview .rl-list > button[aria-pressed="true"]').getClientRects().length > 0`)
        expect(await page.evaluate(`document.activeElement === document.querySelector('.desktop-project-overview .rl-list > button[aria-pressed="true"]')`, decodeBoolean)).toBe(true)
        failures.push(...r7Failures(await captureR7(page, `${name}-project-back`), name))
      }
      const detail = { motion, exit, project, attachedDistance, ...stable }
      const output = process.env.YCODING_DESKTOP_CAPTURE_DIR
      if (output) { const file = path.join(output, `${name}.motion.json`); if (await Bun.file(file).exists()) throw new Error(`Capture already exists: ${name}`); await Bun.write(file, JSON.stringify(detail, null, 2)) }
      expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    } finally { await page.close() }
  }
  expect(failures).toEqual([])
}, 90_000)

async function tap(page: Page, selector: string) {
  await wait(page, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) return false; const box = element.getBoundingClientRect(); const viewport = visualViewport; return Math.abs(document.querySelector('.desktop.rl-ledger').getBoundingClientRect().height - viewport.height) <= 1 && box.width > 0 && box.height > 0 && box.top >= viewport.offsetTop && box.bottom <= viewport.offsetTop + viewport.height && element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })()`)
  const point = await page.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()`, decodeArray(decodeNumber))
  await page.touch("touchStart", point[0], point[1]); await page.touch("touchEnd")
}

async function compactCapture(page: Page, name: string) {
  const output = process.env.DESKTOP_COMPACT_OUTPUT
  if (output) await Bun.write(path.join(output, `${name}.png`), Buffer.from(await page.screenshot(), "base64"))
  expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth`, decodeBoolean)).toBe(true)
}

test("compact coarse navigation, model, policy, delivery and companion preserve drafts and dismiss by touch", async () => {
  const page = await compactPage()
  try {
    await message(page, "Retain this compact draft")
    await page.setCoarsePointer(false); await page.setViewport(1440, 900)
    await wait(page, `innerWidth === 1440 && !matchMedia('(pointer: coarse)').matches`)
    const dialogs: { role: string | null; name: string | null }[] = []
    for (const [trigger, layer] of [['.composer-chip--model', '.model-popover'], ['.composer-policy-chip', '.rl-policy-panel']]) {
      await page.evaluate(`document.querySelector(${JSON.stringify(trigger)}).focus(); document.querySelector(${JSON.stringify(trigger)}).click()`)
      await wait(page, `document.querySelector(${JSON.stringify(layer)})`)
      dialogs.push(await page.evaluate(`(() => { const layer = document.querySelector(${JSON.stringify(layer)}); return { role: layer.getAttribute('role'), name: layer.getAttribute('aria-label') }; })()`, (value) => {
        const dialog = decodeRecord(value)
        return { role: decodeNullable(decodeString)(dialog.role), name: decodeNullable(decodeString)(dialog.name) }
      }))
      if (layer === '.rl-policy-panel') await clickText(page, '.rl-policy-panel button', "Close")
      else await page.pressEscape()
      await wait(page, `!document.querySelector(${JSON.stringify(layer)})`)
      if (trigger === '.composer-chip--model') expect(await page.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(trigger)})`, decodeBoolean)).toBe(true)
    }
    expect(dialogs).toEqual([{ role: "dialog", name: "Model and reasoning effort" }, { role: "dialog", name: "Goal and autonomy" }])
    await page.setViewport(390, 844); await page.setCoarsePointer(true)
    await wait(page, `innerWidth === 390 && matchMedia('(pointer: coarse)').matches`)
    expect(await page.evaluate(`[...document.querySelectorAll('.rl-capsule .composer-bar button')].filter(button => button.getClientRects().length).every(button => { const box = button.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; })`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => { const header = document.querySelector('.rl-top'); return header.getBoundingClientRect().height <= 64 && [...header.querySelectorAll('button')].filter(button => button.getClientRects().length).every(button => { const box = button.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; }); })()`, decodeBoolean)).toBe(true)
    await tap(page, '.rl-mobile-menu')
    await wait(page, `document.querySelector('#session-rail:modal')`)
    expect(await page.evaluate(`document.querySelector('[aria-label="Close navigation"]').getBoundingClientRect().height >= 44`, decodeBoolean)).toBe(true)
    await compactCapture(page, "drawer")
    await page.touch("touchStart", 210, 420); await page.touch("touchMove", 60, 422); await page.touch("touchEnd")
    await wait(page, `!document.querySelector('#session-rail:modal')`)
    expect(await page.evaluate(`document.activeElement.matches('.rl-mobile-menu')`, decodeBoolean)).toBe(true)
    await tap(page, '.rl-mobile-menu'); await wait(page, `document.querySelector('#session-rail:modal')`)
    await page.touch("touchStart", 380, 420); await page.touch("touchEnd")
    await wait(page, `!document.querySelector('#session-rail:modal')`)
    await tap(page, '.rl-mobile-menu'); await wait(page, `document.querySelector('#session-rail:modal')`)
    await page.pressEscape(); await wait(page, `!document.querySelector('#session-rail:modal')`)
    await tap(page, '.composer-chip--model')
    await wait(page, `document.querySelector('.model-popover:modal')`)
    expect(await page.evaluate(`document.querySelector('.model-popover:modal').getAttribute('aria-label')`, decodeString)).toBe("Model and reasoning effort")
    expect(await page.evaluate(`(() => { const r = document.querySelector('.model-popover').getBoundingClientRect(); return Math.abs(r.bottom-innerHeight) <= 1 && r.height < innerHeight && [...document.querySelectorAll('.model-popover button')].filter(b=>b.getClientRects().length).every(b=>b.getBoundingClientRect().height>=44); })()`, decodeBoolean)).toBe(true)
    await compactCapture(page, "model-sheet")
    await page.evaluate(`[...document.querySelectorAll('.model-popover button')].at(-1).focus()`)
    await page.pressKey("Tab", "Tab", 9)
    expect(await page.evaluate(`document.querySelector('.model-popover').contains(document.activeElement)`, decodeBoolean)).toBe(true)
    const handle = await page.evaluate(`(() => {const r=document.querySelector('.model-popover .compact-layer__handle').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})()`, decodeArray(decodeNumber))
    await page.touch("touchStart", handle[0], handle[1]); await page.touch("touchMove", handle[0], handle[1]!+90); await page.touch("touchEnd")
    await wait(page, `!document.querySelector('.model-popover')`)
    await tap(page, '.composer-chip--model'); await wait(page, `document.querySelector('.model-popover:modal')`)
    await page.pressEscape(); await wait(page, `!document.querySelector('.model-popover')`)
    await tap(page, '.composer-policy-chip')
    await wait(page, `document.querySelector('.rl-policy-panel:modal')`)
    expect(await page.evaluate(`document.querySelector('.rl-policy-panel:modal').getAttribute('aria-label')`, decodeString)).toBe("Goal and autonomy")
    await compactCapture(page, "policy-sheet")
    await page.evaluate(`(() => {const field=document.querySelector('.rl-policy-panel textarea');field.value='Retain this staged goal';field.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await page.setCoarsePointer(false); await page.setViewport(1100, 844)
    await wait(page, `document.querySelector('.rl-policy-panel:not(dialog)')`)
    await page.setViewport(390, 844); await page.setCoarsePointer(true)
    await wait(page, `document.querySelector('.rl-policy-panel:modal')`)
    expect(await page.evaluate(`document.querySelector('.rl-policy-panel textarea').value`, decodeString)).toBe("Retain this staged goal")
    await page.setViewport(390, 480)
    expect(await page.evaluate(`document.querySelector('.rl-policy-panel').getBoundingClientRect().bottom <= 480 && [...document.querySelectorAll('.rl-policy-panel textarea')].every(e=>parseFloat(getComputedStyle(e).fontSize)>=16)`, decodeBoolean)).toBe(true)
    await page.pressEscape(); await wait(page, `!document.querySelector('.rl-policy-panel')`)
    await page.setViewport(390, 844)
    await tap(page, '[aria-label="Send mode"]')
    await wait(page, `document.querySelector('.desktop-select__list:modal')`)
    expect(await page.evaluate(`[...document.querySelectorAll('.desktop-select__option')].every(e=>e.getBoundingClientRect().height>=44)`, decodeBoolean)).toBe(true)
    await compactCapture(page, "delivery-sheet")
    await page.pressEscape(); await wait(page, `!document.querySelector('.desktop-select__list')`)
    const scroll = await page.evaluate(`document.querySelector('.conversation__scroll').scrollTop`, decodeNumber)
    await tap(page, '.rl-companion-toggle'); await wait(page, `document.querySelector('.rl-companion:modal')`)
    await compactCapture(page, "companion")
    await tap(page, '.rl-companion [aria-label="Close companion"]'); await wait(page, `!document.querySelector('.rl-companion')`)
    expect(await page.evaluate(`document.querySelector('.conversation__scroll').scrollTop`, decodeNumber)).toBe(scroll)
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`, decodeString)).toBe("Retain this compact draft")
    expect(owned!.calls.filter(call=>call.method!=="GET"&&!call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 40_000)

test("compact directory, coordination and diff inspectors use dismissible single-pane drill-ins", async () => {
  familyEnabled = true
  const page = await compactPage()
  try {
    for (const [route, option, back] of [["workspaces", '.ws-workspaces-list [role="option"]', '[aria-label="Back to workspace list"]'], ["projects", '.desktop-project-overview .rl-list > button[aria-pressed]', '[aria-label="Back to project list"]']] as const) {
      await page.navigate(`${origin}/#/${route}`); await wait(page, `document.querySelector(${JSON.stringify(option)})`)
      await tap(page, option)
      await wait(page, `document.querySelector(${JSON.stringify(back)})?.getClientRects().length`)
      await compactCapture(page, `${route}-inspector`)
      await tap(page, back)
      expect(await page.evaluate(`document.querySelector(${JSON.stringify(option)}).getClientRects().length > 0`, decodeBoolean)).toBe(true)
    }
    await clickText(page, 'button', 'Coordination')
    await tap(page, '.desktop-coordination .desktop-row-select')
    await wait(page, `document.querySelector('[aria-label="Back to member list"]')?.getClientRects().length`)
    await compactCapture(page, "coordination-inspector")
    await page.pressEscape()
    expect(await page.evaluate(`document.querySelector('.desktop-coordination-main').getClientRects().length > 0`, decodeBoolean)).toBe(true)
    await page.navigate(`${origin}/#/sessions/ses_test`); await wait(page, `document.querySelector('#turn-msg_response')`)
    await clickText(page, '.rl-top button', "Team")
    await wait(page, `document.querySelector('.desktop-team .desktop-row-select')`)
    await tap(page, '.desktop-team .desktop-row-select')
    await wait(page, `document.querySelector('[aria-label="Back to child list"]')?.getClientRects().length`)
    await compactCapture(page, "team-inspector")
    await page.pressEscape()
    await clickText(page, '.rl-top button', "Conversation")
    await command(page, "/diff")
    await wait(page, `document.querySelector('dialog[data-kind="diff"]')`)
    await wait(page, `document.querySelector('.desktop-diff nav [aria-label="a.ts"]')`)
    await tap(page, '.desktop-diff nav [aria-label="a.ts"]')
    await wait(page, `document.querySelector('[aria-label="Back to changed files"]')?.getClientRects().length`)
    await clickText(page, 'dialog[data-kind="diff"] button[aria-label="Mark reviewed: a.ts"]', 'Mark reviewed')
    await compactCapture(page, "diff-inspector")
    await tap(page, '[aria-label="Back to changed files"]')
    expect(await page.evaluate(`document.querySelector('.desktop-diff nav [role="status"]').textContent`, decodeString)).toBe("1 reviewed")
    await tap(page, '.desktop-diff nav [aria-label="a.ts"]')
    await wait(page, `document.querySelector('[aria-label="Back to changed files"]')?.getClientRects().length`)
    await page.pressEscape()
    expect(await page.evaluate(`document.querySelector('dialog[data-kind="diff"][open] .desktop-diff nav').getClientRects().length > 0`, decodeBoolean)).toBe(true)
    await page.pressEscape(); await wait(page, `!document.querySelector('dialog[open]')`)
    expect(owned!.calls.filter(call=>call.method!=="GET"&&!call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 40_000)

test("compact 320px boundary contains page, composer, code and sheet overflow", async () => {
  const page = await compactPage()
  try {
    await page.setViewport(320, 844)
    await compactCapture(page, "boundary-320")
    expect(await page.evaluate(`parseFloat(getComputedStyle(document.querySelector('.rl-capsule textarea')).fontSize)>=16`, decodeBoolean)).toBe(true)
    await tap(page, '.composer-chip--model'); await wait(page, `document.querySelector('.model-popover:modal')`)
    await compactCapture(page, "model-320")
    await page.pressEscape()
    for (const route of ['workspaces','projects']) {
      await page.navigate(`${origin}/#/${route}`); await wait(page, `document.querySelector('main[data-surface="${route}"]')`)
      await compactCapture(page, `${route}-320`)
    }
  } finally { await page.close() }
}, 30_000)

test("Stitch approved source typography, palette and dense chrome load from owned assets", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    const actual = await page.evaluate(`(() => {
      const root = getComputedStyle(document.documentElement);
      const style = selector => getComputedStyle(document.querySelector(selector));
      return { mono: root.getPropertyValue('--yc-font-mono').trim(), border: root.getPropertyValue('--yc-border').trim(), muted: root.getPropertyValue('--yc-text-muted').trim(), sunken: root.getPropertyValue('--yc-surface-sunken').trim(), header: document.querySelector('.rl-top').getBoundingClientRect().height, radius: style('.rl-capsule').borderRadius, loaded: [...document.fonts].some(face => face.family.replaceAll('"', '') === 'JetBrains Mono' && face.status === 'loaded') };
    })()`)
    expect(actual).toEqual({ mono: '"JetBrains Mono", monospace', border: '#263039', muted: '#99A2AD', sunken: '#0E151A', header: 40, radius: '4px', loaded: true })
    if (!await page.evaluate(`!!document.querySelector('.rl-companion')`, decodeBoolean)) await page.evaluate(`document.querySelector('[aria-label="Open Session companion"]').click()`)
    await wait(page, `document.querySelector('.desktop-companion-head')`)
    expect(await page.evaluate(`(() => { const pane = document.querySelector('.rl-companion').getBoundingClientRect(), header = document.querySelector('.desktop-companion-head').getBoundingClientRect(), tabs = document.querySelector('.desktop-companion-head [role="tablist"]').getBoundingClientRect(), close = document.querySelector('[aria-label="Close companion"]').getBoundingClientRect(); return { width: pane.width, height: header.height, oneRow: tabs.top >= header.top && tabs.bottom <= header.bottom && close.left >= tabs.right && close.bottom <= header.bottom }; })()`, (value: unknown) => { const result = decodeRecord(value); return { width: (decodeNumber)(result["width"]), height: (decodeNumber)(result["height"]), oneRow: (decodeBoolean)(result["oneRow"]) } })).toEqual({ width: 320, height: 40, oneRow: true })
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.rl-top')).backgroundColor`, decodeString)).toBe("rgb(17, 24, 29)")
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "approved-source-foundation.png"), Buffer.from(await page.screenshot(), "base64"))
  } finally { await page.close() }
}, 30_000)

test("Desktop D5 correction target reads distinguish pending and failed repositories from confirmed empty results", async () => {
  prepareImplementedSurface()
  const release = Promise.withResolvers<void>()
  let inventory: "pending" | "failed" | "empty" | "reported" = "pending"
  sceneRead = call => call.route === "/api/project/inventory" ? inventory === "pending" ? release.promise.then(() => new Response(null, { status: 503 })) : inventory === "failed" ? new Response(null, { status: 503 }) : { data: inventory === "empty" ? [] : [sceneRepository], cursor: {} } : undefined
  let page: Page | undefined
  try {
    page = await openReference()
    await page.navigate(`${origin}/#/chat`)
    await wait(page, `document.querySelector('[data-new-chat] .rl-capsule textarea')`)
    await clickText(page, '[data-new-chat] button', "Target Workspace / Worktree")
    await wait(page, `document.querySelector('.desktop-target-picker')?.textContent.includes('Reading registered repositories')`)
    expect(await page.evaluate(`!document.querySelector('.desktop-target-picker').textContent.includes('No registered repositories.')`, decodeBoolean)).toBe(true)
    inventory = "failed"; release.resolve()
    await wait(page, `document.querySelector('.desktop-target-picker [role="alert"]')`)
    expect(await page.evaluate(`!document.querySelector('.desktop-target-picker').textContent.includes('No registered repositories.') && [...document.querySelectorAll('.desktop-target-picker button')].some(button => button.textContent === 'Browse folders…')`, decodeBoolean)).toBe(true)
    inventory = "empty"
    await clickText(page, '.desktop-target-picker button', "Refresh repositories")
    await wait(page, `document.querySelector('.desktop-target-picker')?.textContent.includes('No registered repositories.')`)
    expect(await page.evaluate(`!document.querySelector('.desktop-target-picker [role="alert"]')`, decodeBoolean)).toBe(true)
    inventory = "failed"
    await page.evaluate(`window.__desktopFixture.resync()`)
    await wait(page, `document.querySelector('.desktop-target-picker [role="alert"]')`)
    expect(await page.evaluate(`!document.querySelector('.desktop-target-picker').textContent.includes('No registered repositories.')`, decodeBoolean)).toBe(true)
    inventory = "reported"
    await clickText(page, '.desktop-target-picker button', "Refresh repositories")
    await wait(page, `document.querySelector('[aria-label="Repositories"]')?.textContent.includes('Synthetic repository')`)
    expect(await page.evaluate(`!document.querySelector('.desktop-target-picker [role="alert"]') && !document.querySelector('.desktop-target-picker').textContent.includes('No registered repositories.')`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { release.resolve(); await page?.close() }
}, 30_000)

test("Desktop D5 correction Team totals stay unreported until a successful activity read confirms zeros", async () => {
  prepareImplementedSurface()
  const release = Promise.withResolvers<void>()
  let activity: "pending" | "zero" = "pending"
  sceneRead = call => call.route === "/api/session/ses_test/subagent" ? activity === "pending" ? release.promise.then(() => new Response(null, { status: 503 })) : { data: [], summary: { total: 0, active: 0 }, cursor: {} } : undefined
  let page: Page | undefined
  try {
    page = await openReference()
    await clickText(page, '.rl-top button', "Team")
    await wait(page, `document.querySelector('[data-team-view]')?.textContent.includes('Reading direct subagents')`)
    expect(await page.evaluate(`document.querySelector('[data-team-view] header p').textContent`, decodeString)).toBe("0 loaded · Direct subagent total unreported · Active count unreported")
    release.resolve()
    await wait(page, `document.querySelector('[data-team-view] [role="alert"]')`)
    expect(await page.evaluate(`document.querySelector('[data-team-view] header p').textContent`, decodeString)).toBe("0 loaded · Direct subagent total unreported · Active count unreported")
    activity = "zero"
    await clickText(page, '[data-team-view] button', "Refresh Team")
    await wait(page, `document.querySelector('[data-team-view] [aria-label="Direct subagents"]')`)
    expect(await page.evaluate(`document.querySelector('[data-team-view] header p').textContent`, decodeString)).toBe("0 loaded of 0 reported direct subagents · 0 active")
    expect(await page.evaluate(`!document.querySelector('[data-team-view] [role="alert"]')`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { release.resolve(); await page?.close() }
}, 30_000)

test("Stitch implemented surface d870471b750a42df8e17ff0fb5d29e67 direct Team composition answers only its selected child", async () => {
  prepareImplementedSurface()
  let answered = false
  const startedAt = Date.now()
  const tasks = () => ["running", "waiting", "supervising", "completed", "failed"].map((state, index) => ({ sessionID: `ses_child_${state}`, parentID: "ses_test", description: `Own synthetic ${state} work; stop after its reported checks.`, agent: `worker-${state}`, model: { id: "synthetic", providerID: "synthetic", variant: "high", profile: "review-profile" }, background: true, state: state === "waiting" && answered ? "running" : state, progress: { text: `Synthetic ${state} progress`, time: 2 }, revision: 1, time: { created: startedAt - 840000 - index * 1000, updated: startedAt - 1000 }, ...(state === "waiting" && !answered ? { question: { id: "qst_team", text: "Choose the synthetic cursor format", time: 2 } } : {}) }))
  sceneRead = call => {
    if (call.route === "/api/session/ses_test/subagent") return { data: tasks(), summary: { total: 5, active: 3, running: 1, waiting: 1 }, cursor: {} }
    if (call.route.endsWith("/usage/tasks")) return { data: { tasks: tasks().map(task => ({ sessionID: task.sessionID, total: { tokens: { input: 1000, output: 400, reasoning: 200, cache: { read: 0, write: 0 } } }, status: "so-far", history: "retained" })), history: "retained" } }
    if (call.method === "POST" && call.route === "/api/session/ses_test/subagent/ses_child_waiting/question/qst_team/answer") { answered = true; return { data: tasks()[1] } }
    return undefined
  }
  const page = await openReference()
  try {
    await clickText(page, '.rl-top button', "Team")
    await wait(page, `document.querySelector('[aria-label="Direct subagents"] tbody tr') && document.querySelector('[aria-label="Selected child"]')?.textContent.includes('Synthetic running progress')`)
    expect(await page.evaluate(`document.querySelectorAll('[aria-label="Direct subagents"] tbody tr').length`, decodeNumber)).toBe(5)
    expect(await page.evaluate(`document.querySelector('[aria-label="Direct subagents"]').textContent`, decodeString)).toContain("review-profile")
    expect(await page.evaluate(`document.querySelector('[aria-label="Direct subagents"]').textContent`, decodeString)).toContain("1.6K")
    expect(await page.evaluate(`(() => { const table = document.querySelector('[aria-label="Direct subagents"]').getBoundingClientRect(), inspector = document.querySelector('[aria-label="Selected child"]').getBoundingClientRect(), blockers = document.querySelector('[aria-label="Blockers & escalations"]').getBoundingClientRect(), dock = document.querySelector('.rl-dock').getBoundingClientRect(); return blockers.bottom <= table.top && table.right <= inspector.left && inspector.bottom <= dock.top && dock.bottom <= innerHeight; })()`, decodeBoolean)).toBe(true)
    await captureReference(page, "d870471b750a42df8e17ff0fb5d29e67", `document.querySelector('[data-team-view]')?.textContent.includes('worker-failed') && document.querySelector('.rl-capsule textarea') && !document.body.textContent.includes('Spawn Subagent') && !document.body.textContent.includes('Pause All')`)
    await clickText(page, '[aria-label="Blockers & escalations"] button', "Answer")
    await wait(page, `document.querySelector('[aria-label="Selected child"] textarea')`)
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="Selected child"] textarea'); input.value = 'Use keyset'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
    await clickText(page, '[aria-label="Selected child"] button', "Send answer")
    await confirm(page)
    await wait(page, `!document.querySelector('[aria-label="Selected child"] textarea')`)
    expect(owned!.calls.filter(call => call.method === "POST" && call.route.includes("/answer")).map(call => [call.route, call.body.text])).toEqual([["/api/session/ses_test/subagent/ses_child_waiting/question/qst_team/answer", "Use keyset"]])
    await message(page, "Keep the Master draft")
    await clickText(page, '.rl-top button', "Conversation")
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`, decodeString)).toBe("Keep the Master draft")
  } finally { await page.close() }
}, 30_000)

test("Stitch implemented surface adedc0ab360c471d9996962413cf247d Project coordination retains ownership and member identity", async () => {
  prepareImplementedSurface()
  const member = { ...sceneParticipant("ses_other"), title: "Storage worker", state: "waiting", owner: { sessionID: "ses_supervisor", title: "Storage supervisor" }, drivenBy: { sessionID: "ses_test", title: "Synthetic master" }, pending: [{ kind: "review", requestID: "grq_project", fingerprint: "synthetic", summary: "Review schema write" }] }
  sceneRead = call => call.route === `/api/coordination/${sceneGroup.id}` ? { data: { ...sceneGroup, members: [member] } } : undefined
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/projects`)
    await clickText(page, 'main button', "Coordination")
    await wait(page, `document.querySelector('[aria-label="Ownership & drivers"]')?.textContent.includes('Storage supervisor')`)
    expect(await page.evaluate(`(() => { const chain = document.querySelector('[aria-label="Ownership & drivers"]').getBoundingClientRect(), members = document.querySelector('[aria-label="Member Sessions"]').getBoundingClientRect(), inspector = document.querySelector('[aria-label="Selected member"]').getBoundingClientRect(); return chain.bottom <= members.top && members.right <= inspector.left; })()`, decodeBoolean)).toBe(true)
    await captureReference(page, "adedc0ab360c471d9996962413cf247d", `document.querySelector('[aria-label="Selected member"]')?.textContent.includes('Storage worker') && document.querySelector('[aria-label="Pending requests & escalations"]')?.textContent.includes('Review schema write')`)
    expect(await page.evaluate(`document.querySelector('[data-project-coordination]').textContent`, decodeString)).not.toMatch(/Run Checks|Fork Pipeline|Deploy Changes|c8f12a9|NEW PROPOSAL/)
    await clickText(page, '[aria-label="Selected member"] button', "Open member Session")
    await wait(page, `location.hash === '#/sessions/ses_other'`)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Stitch implemented surface 49335c0b2469436280298bda555bdc50 target picker applies with Enter and dismisses without replacing a draft", async () => {
  prepareImplementedSurface()
  let copied = false
  const copyDirectory = "/synthetic/worktrees/test-copy"
  sceneRead = call => {
    const requestedLocation = { directory: call.query.get("location[directory]") ?? location.directory }
    if (call.route === "/api/model") return { location: requestedLocation, data: [model] }
    if (call.route === "/api/model/default") return { location: requestedLocation, data: { selection: selection() } }
    if (call.route === "/api/form/request") return { location: requestedLocation, data: [] }
    if (call.route === "/experimental/project/global/copy" && call.method === "POST") { copied = true; return { directory: copyDirectory } }
    if (call.route === "/api/project/inventory") return { data: [sceneRepository, { ...sceneRepository, directory: "/synthetic/repo/pagination-cursor", strategy: "git_worktree" }, ...(copied ? [{ ...sceneRepository, directory: copyDirectory, strategy: "git_worktree" }] : []), { ...sceneRepository, projectID: "a".repeat(40), projectName: "Synthetic web", projectWorktree: "/synthetic/web", directory: "/synthetic/web" }], cursor: {} }
    if (call.route === "/api/project/global/directories") return [{ directory: "/synthetic/repo" }, { directory: "/synthetic/repo/pagination-cursor", strategy: "git_worktree" }, ...(copied ? [{ directory: copyDirectory, strategy: "git_worktree" }] : [])]
    return undefined
  }
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/chat`)
    await wait(page, `document.querySelector('[data-new-chat] .rl-capsule textarea')`)
    await message(page, "Keep this workspace draft")
    await clickText(page, '[data-new-chat] button', "Target Workspace / Worktree")
    await wait(page, `document.querySelector('[aria-label="Target Workspace / Worktree"] [aria-label="Worktrees"]')?.textContent.includes('pagination-cursor')`)
    expect(await page.evaluate(`(() => { const repositories = document.querySelector('[aria-label="Repositories"]').getBoundingClientRect(), worktrees = document.querySelector('[aria-label="Worktrees"]').getBoundingClientRect(); return repositories.right <= worktrees.left; })()`, decodeBoolean)).toBe(true)
    await captureReference(page, "49335c0b2469436280298bda555bdc50", `document.querySelector('[aria-label="Repositories"]')?.textContent.includes('Synthetic web') && document.querySelector('[aria-label="Worktrees"]')?.textContent.includes('pagination-cursor')`)
    await clickContaining(page, '[aria-label="Worktrees"] button', "pagination-cursor")
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!document.querySelector('[aria-label="Target Workspace / Worktree"]') && document.querySelector('[data-new-chat]')?.textContent.includes('/synthetic/repo/pagination-cursor')`)
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`, decodeString)).toBe("Keep this workspace draft")
    await clickText(page, '[data-new-chat] button', "Target Workspace / Worktree")
    expect(await page.evaluate(`!!document.activeElement?.closest('.desktop-target-picker')`, decodeBoolean)).toBe(true)
    await page.pressKey("Escape", "Escape", 27)
    await wait(page, `!document.querySelector('[aria-label="Target Workspace / Worktree"]')`)
    expect(await page.evaluate(`document.activeElement === document.querySelector('.desktop-target-anchor > button')`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    await clickText(page, '[data-new-chat] button', "Target Workspace / Worktree")
    await clickText(page, '[aria-label="Worktrees"] button', "New worktree…")
    await page.evaluate(`for (const [name, value] of [['Parent directory', '/synthetic/worktrees'], ['Folder name (optional)', 'test-copy']]) { const label = [...document.querySelectorAll('.desktop-target-create label')].find(element => element.textContent.includes(name)); const input = label.querySelector('input'); input.value = value; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }`)
    await clickText(page, '.desktop-target-create button', "Create worktree")
    await confirm(page)
    await wait(page, `document.querySelector('[aria-label="Worktrees"]')?.textContent.includes('/synthetic/worktrees/test-copy')`)
    const copy = owned!.calls.filter(call => call.method === "POST" && call.route === "/experimental/project/global/copy")
    expect(copy.length).toBe(1)
    expect(copy[0]!.body).toEqual({ strategy: "git_worktree", directory: "/synthetic/worktrees", name: "test-copy" })
    expect(copy[0]!.query.get("location[directory]")).toBe("/synthetic/repo")
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`, decodeString)).toBe("Keep this workspace draft")
    await clickContaining(page, '[aria-label="Worktrees"] button', "test-copy")
    await clickText(page, '.desktop-target-picker footer button', "Apply · Enter")
    await wait(page, `!document.querySelector('[aria-label="Target Workspace / Worktree"]') && document.querySelector('[data-new-chat]')?.textContent.includes('/synthetic/worktrees/test-copy')`)
    expect(owned!.calls.some(call => call.method === "POST" && call.route === "/api/session")).toBe(false)
  } finally { await page.close() }
}, 30_000)

test("Desktop pending worktree creation settles after repository drift without applying or retrying it", async () => {
  prepareImplementedSurface()
  const release = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  const webID = "a".repeat(40), copyDirectory = "/synthetic/worktrees/pending-copy"
  let copied = false
  sceneRead = call => {
    if (call.route === "/api/project/inventory") return { data: [sceneRepository, { ...sceneRepository, projectID: webID, projectName: "Synthetic web", projectWorktree: "/synthetic/web", directory: "/synthetic/web" }], cursor: {} }
    if (call.route === "/api/project/global/directories") return [{ directory: "/synthetic/repo" }, ...(copied ? [{ directory: copyDirectory, strategy: "git_worktree" }] : [])]
    if (call.route === `/api/project/${webID}/directories`) return [{ directory: "/synthetic/web" }]
    if (call.route === "/experimental/project/global/copy" && call.method === "POST") { reached.resolve(); return release.promise.then(() => { copied = true; return { directory: copyDirectory } }) }
    return undefined
  }
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/chat`)
    await wait(page, `document.querySelector('[data-new-chat] .rl-capsule textarea')`)
    await message(page, "Retain this pending worktree draft")
    const context = await page.evaluate(`document.querySelector('[data-new-chat] .rl-presence').textContent`, decodeString)
    await clickText(page, '[data-new-chat] button', "Target Workspace / Worktree")
    await wait(page, `document.querySelector('[aria-label="Worktrees"] [data-target-directory]')`)
    await clickText(page, '[aria-label="Worktrees"] button', "New worktree…")
    await page.evaluate(`for (const [name, value] of [['Parent directory', '/synthetic/worktrees'], ['Folder name (optional)', 'pending-copy']]) { const input = [...document.querySelectorAll('.desktop-target-create label')].find(label => label.textContent.includes(name)).querySelector('input'); input.value = value; input.dispatchEvent(new InputEvent('input', { bubbles: true })); }`)
    await clickText(page, '.desktop-target-create button', "Create worktree")
    await confirm(page)
    await reached.promise
    expect(await page.evaluate(`document.querySelector('.desktop-target-create button').textContent === 'Creating…' && document.querySelector('.desktop-target-picker > header button').disabled`, decodeBoolean)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('[aria-label="Repositories"] button')].find(button => button.textContent.includes('Synthetic web')).focus()`)
    await clickContaining(page, '[aria-label="Repositories"] button', "Synthetic web")
    await wait(page, `document.querySelector('[aria-label="Worktrees"] [data-target-directory]')?.textContent.includes('/synthetic/web')`)
    const reads = owned!.calls.filter(call => call.route === "/api/project/inventory" || call.route.endsWith("/directories")).length
    const completed = await page.evaluate(`window.__desktopFixture.completed.changeWorkspace || 0`, decodeNumber)
    release.resolve()
    await wait(page, `window.__desktopFixture.completed.changeWorkspace > ${completed}`)
    await settleR7(page)
    const writes = owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))
    expect(writes.map(call => [call.route, call.body, call.query.get("location[directory]")])).toEqual([["/experimental/project/global/copy", { strategy: "git_worktree", directory: "/synthetic/worktrees", name: "pending-copy" }, "/synthetic/repo"]])
    expect(owned!.calls.filter(call => call.route === "/api/project/inventory" || call.route.endsWith("/directories")).slice(reads).map(call => call.route)).toEqual(["/api/project/global/directories"])
    expect(await page.evaluate(`(() => { const picker = document.querySelector('.desktop-target-picker'); return { busy: picker.querySelector('.desktop-target-create button').textContent === 'Creating…', canClose: !picker.querySelector('header button').disabled, applyDisabled: [...picker.querySelectorAll('footer button')].find(button => button.textContent === 'Apply · Enter').disabled, createDisabled: picker.querySelector('.desktop-target-create button').disabled }; })()`, (value: unknown) => { const result = decodeRecord(value); return { busy: (decodeBoolean)(result["busy"]), canClose: (decodeBoolean)(result["canClose"]), applyDisabled: (decodeBoolean)(result["applyDisabled"]), createDisabled: (decodeBoolean)(result["createDisabled"]) } })).toEqual({ busy: false, canClose: true, applyDisabled: true, createDisabled: true })
    expect(await page.evaluate(`document.querySelector('.desktop-target-picker [role="alert"]')?.textContent || ''`, decodeString)).toMatch(/unconfirmed|not confirmed/i)
    expect(await page.evaluate(`(() => { const warning = document.querySelector('.desktop-target-picker [role="alert"]'); return warning.getBoundingClientRect().height > 0 && parseFloat(getComputedStyle(warning).fontSize) >= 12; })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.desktop-target-picker').contains(document.activeElement) && document.activeElement.textContent.includes('Synthetic web') && !document.activeElement.disabled`, decodeBoolean)).toBe(true)
    await page.pressEscape()
    await wait(page, `!document.querySelector('.desktop-target-picker')`)
    expect(await page.evaluate(`document.activeElement === document.querySelector('.desktop-target-anchor > button')`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`document.querySelector('[data-new-chat] .rl-presence').textContent`, decodeString)).toBe(context)
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`, decodeString)).toBe("Retain this pending worktree draft")
    await clickText(page, '[data-new-chat] button', "Target Workspace / Worktree")
    await wait(page, `document.querySelector('[aria-label="Worktrees"] [data-target-directory]')?.textContent.includes('/synthetic/repo')`)
    expect(await page.evaluate(`!document.querySelector('.desktop-target-picker > header button').disabled && ![...document.querySelectorAll('[aria-label="Worktrees"] button')].find(button => button.textContent === 'New worktree…').disabled`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method === "POST" && call.route === "/experimental/project/global/copy")).toHaveLength(1)
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { release.resolve(); await page.close() }
}, 30_000)

test("Stitch implemented surface d0108ca2870b4ee5a9f9a641253e8d97 quota policy removes unsupported without hiding account errors", async () => {
  prepareImplementedSurface()
  sceneRead = call => call.route === "/api/provider/usage" ? { location, data: ["available", "unsupported", "unauthorized", "error"].map(status => ({ providerID: `provider-${status}`, label: `Provider ${status}`, status, source: "provider_api", stability: "stable", updatedAt: 1, windows: status === "available" ? [{ id: "daily", label: "Daily requests", unit: "requests", used: 42, limit: 100 }] : [], message: status === "unauthorized" ? "Authentication expired" : status === "error" ? "Provider unavailable" : undefined })) } : undefined
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/usage`)
    await wait(page, `document.querySelectorAll('.st-quota').length >= 3`)
    expect(await page.evaluate(`[...document.querySelectorAll('.st-quota-provider')].map(element => element.textContent)`, decodeArray(decodeString))).toEqual(["Provider available", "Provider unauthorized", "Provider error"])
    expect(await page.evaluate(`(() => { const summary = document.querySelector('[data-part="st-usage-summary"]').getBoundingClientRect(), quotas = document.querySelector('[data-part="st-quota"]').getBoundingClientRect(); return summary.bottom <= quotas.top; })()`, decodeBoolean)).toBe(true)
    await captureReference(page, "d0108ca2870b4ee5a9f9a641253e8d97", `document.querySelector('[data-part="st-quota"]')?.textContent.includes('Authentication expired') && document.querySelector('[data-part="st-quota"]')?.textContent.includes('Provider unavailable') && !document.querySelector('[data-part="st-quota"]')?.textContent.includes('Provider unsupported')`)
  } finally { await page.close() }
}, 30_000)

test("Stitch implemented surface 74f69eda7960459cb43bf87828c71c12 Context decisions are structured and missing historical fields stay unrecorded", async () => {
  prepareImplementedSurface()
  sceneRead = call => call.route === "/api/session/ses_test/guardrail" ? { data: { rootSessionID: "ses_test", profile: "standard", customRules: 0, approvals: 1, blocked: 1, counters: [], invalidFiles: [], decisions: [{ sessionID: "ses_test", created: 1000, requestID: "grq_history", reply: "once", ruleIDs: ["synthetic.exec"], source: { messageID: "msg_response", callID: "call_read" } }, { sessionID: "ses_child", created: 2000, requestID: "grq_denied", reply: "reject", confidence: 0.9 }] } } : undefined
  const page = await openReference()
  try {
    await companion(page, "Context")
    await wait(page, `document.querySelectorAll('[aria-label="Guardrail decisions"] article').length === 2`)
    const history = await page.evaluate(`document.querySelector('[aria-label="Guardrail decisions"]').textContent`, decodeString)
    for (const value of ["Allowed once", "Rejected", "synthetic.exec", "Action unrecorded", "Scope unrecorded", "Resources unrecorded"]) expect(history).toContain(value)
    expect(await page.evaluate(`(() => { const pane = document.querySelector('.rl-companion').getBoundingClientRect(), cards = [...document.querySelectorAll('[aria-label="Guardrail decisions"] article')].map(element => element.getBoundingClientRect()); return cards[0].top < cards[1].top && cards.every(card => card.left >= pane.left && card.right <= pane.right) && !document.querySelector('[aria-label="Guardrail decisions"] pre'); })()`, decodeBoolean)).toBe(true)
    await captureReference(page, "74f69eda7960459cb43bf87828c71c12", `document.querySelector('.rl-companion [aria-label="Guardrail decisions"]')?.textContent.includes('grq_history')`)
  } finally { await page.close() }
}, 30_000)

test("Stitch implemented surface ba7c7489375448f99efdeacb0b49b3ea native inline activity follows execution, validated peers and reported bridges", async () => {
  prepareImplementedSurface()
  running = true
  presentationParts = true
  let phase: "writing" | "reasoning" | "tool" = "writing"
  let sequence = 1000
  let dots: Dots.NativeStatus = { access: { enabled: true, revision: 2 }, configuration: { ready: true }, connection: { state: "connected" }, computer: { state: "detached" } }
  let remote: Remote.Status = { state: "on" }
  const peer = { origin: "dots-peer", profile: "synthetic-profile", dotID: "synthetic-dot", threadID: "synthetic-thread", itemID: "synthetic-item" } satisfies Dots.Peer
  const exchange = { sessionID: SessionID.make("ses_anchor"), targetSessionID: SessionID.make("ses_test"), exchangeID: "synthetic-exchange", attachment: { profile: "synthetic-profile", dotID: "synthetic-task-dot", threadID: "synthetic-task-thread", generation: "synthetic-generation", label: "Synthetic attachment" } } satisfies Dots.ExchangeMetadata
  sceneRead = call => {
    if (call.route === "/api/dots") return { data: dots }
    if (call.route === "/api/remote") return { data: remote }
    const parts: NonNullable<Extract<Messages[number], { type: "assistant" }>["content"]> = phase === "reasoning" ? [{ type: "reasoning", text: "Checking the synthetic cursor boundary", time: { created: 501 } }] : phase === "tool" ? [{ id: "part_live_read", type: "tool", name: "read", state: { status: "running", input: { path: "src/pagination.ts" }, structured: {}, content: [] }, time: { created: 501 } }] : []
    if (call.route.endsWith("/snapshot")) return { sourceEpoch: "synthetic", session: session("ses_test"), messages: [...transcript().map(message => "content" in message && Array.isArray(message.content) ? { ...message, content: [...message.content, ...parts] } : message),
      { id: "msg_dots", sessionID: "ses_test", type: "synthetic", text: "External pagination note", description: "External pagination note", metadata: { dots: peer }, time: { created: 502 } },
      { id: "msg_exchange", sessionID: "ses_test", type: "user", text: "Review the synthetic task", metadata: { inputOrigin: "plugin", remoteMcp: { requestID: "synthetic-request", epoch: "synthetic-epoch", principal: { ownerID: "synthetic-owner", deviceID: "synthetic-device", clientID: "synthetic-client" } }, dotsExchange: exchange }, time: { created: 503 } },
      { id: "msg_not_peer", sessionID: "ses_test", type: "synthetic", text: "Ordinary pagination note", description: "Ordinary pagination note", metadata: { dots: { operation: "invented-operation", path: "invented-path", processId: "invented-process" } }, time: { created: 504 } },
    ], watermark: { type: "log.synced", aggregateID: "ses_test", seq: sequence } }
    return undefined
  }
  const page = await openReference()
  try {
    await companion(page, "Running")
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.started', data: { sessionID: 'ses_test' } })`)
    await wait(page, `document.querySelector('[aria-label="Current activity"]') && document.querySelector('[aria-label="Channel bridges"]')?.textContent.includes('Dots') && document.querySelector('[data-dots-message]')`)
    expect(await page.evaluate(`(() => { const tail = document.querySelector('[aria-label="Current activity"]'), row = tail.querySelector('.desktop-native-activity-row'); return !!row && row.getBoundingClientRect().height <= 48 && !tail.querySelector('.rl-indeterminate') && tail.textContent.includes('Writing'); })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`document.querySelector('#turn-msg_dots [data-dots-message]')?.textContent`, decodeString)).toContain("Dot synthetic-dot · external peer · synthetic-thread")
    expect(await page.evaluate(`document.querySelector('#turn-msg_exchange [data-dots-message]')?.textContent`, decodeString)).toContain("Synthetic attachment · external peer · Remote MCP · user-chosen name")
    expect(await page.evaluate(`['msg_exchange', 'msg_prompt_239'].map(id => document.querySelector('#turn-' + id + ' .transcript-message__author')?.textContent ?? null)`, decodeArray(decodeNullable(decodeString)))).toEqual(["External peer", null])
    expect(await page.evaluate(`!document.querySelector('#turn-msg_not_peer [data-dots-message]') && !document.body.textContent.includes('invented-operation') && !document.body.textContent.includes('invented-path') && !document.body.textContent.includes('invented-process')`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`['msg_dots', 'msg_exchange'].every(id => { const turn = document.querySelector('#turn-' + id), row = turn.querySelector('[data-dots-message]'); return turn.dataset.layout === 'activity' && row.matches('.desktop-native-activity-row') && row.getBoundingClientRect().height <= 48 && !turn.querySelector('.transcript-message--user, .transcript-notice-pill'); })`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`[...document.querySelectorAll('[data-dots-message] .desktop-native-badge')].map(badge => badge.textContent)`, decodeArray(decodeString))).toEqual(["Dots", "Remote MCP"])
    await captureReference(page, "ba7c7489375448f99efdeacb0b49b3ea-writing", `document.querySelector('[aria-label="Current activity"]')?.textContent.includes('Writing')`)
    await page.evaluate(`window.__nativeActivityRow = document.querySelector('[aria-label="Current activity"] .desktop-native-activity-row'); window.__nativePeerTurn = document.querySelector('#turn-msg_dots'); document.querySelector('#turn-msg_dots .desktop-peer-attribution').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('#turn-msg_dots .desktop-peer-attribution').getAttribute('aria-expanded') === 'true'`)
    expect(await page.evaluate(`(() => { const identity = [...document.querySelectorAll('#turn-msg_dots p')].find(node => node.textContent.includes('Dot synthetic-dot · external peer')), next = document.querySelector('#turn-msg_exchange [data-dots-message]'); return identity.getBoundingClientRect().bottom <= next.getBoundingClientRect().top; })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`Object.fromEntries([...document.querySelectorAll('[aria-label="Channel bridges"] dt')].map(term => [term.textContent, term.nextElementSibling.textContent]))`, decodeDictionary(decodeString))).toEqual({ "Dots connection": "connected", "Computer attachment": "detached", "Remote Session relay": "on" })
    expect(await page.evaluate(`(() => { const tail = document.querySelector('[aria-label="Current activity"]').getBoundingClientRect(), transcript = document.querySelector('.conversation__scroll').getBoundingClientRect(), dock = document.querySelector('.rl-dock').getBoundingClientRect(); return tail.top >= transcript.top && tail.bottom <= dock.top; })()`, decodeBoolean)).toBe(true)
    for (const [next, label] of [["reasoning", "Thinking"], ["tool", "Tool · read"]] as const) {
      phase = next
      sequence++
      await page.evaluate(`window.__desktopFixture.resync(); window.__desktopFixture.emit({ type: 'session.execution.started', data: { sessionID: 'ses_test' } })`)
      await wait(page, `document.querySelector('[aria-label="Current activity"]')?.textContent.includes(${JSON.stringify(label)}) && document.querySelector('.rl-session-row[aria-current="page"]')?.textContent.includes('Running')`)
      expect(await page.evaluate(`window.__nativeActivityRow === document.querySelector('[aria-label="Current activity"] .desktop-native-activity-row') && window.__nativePeerTurn === document.querySelector('#turn-msg_dots') && document.querySelector('#turn-msg_dots .desktop-peer-attribution').getAttribute('aria-expanded') === 'true'`, decodeBoolean)).toBe(true)
      if (next === "reasoning") await captureReference(page, "ba7c7489375448f99efdeacb0b49b3ea-reasoning", `document.querySelector('[aria-label="Current activity"]')?.textContent.includes('Thinking') && document.querySelector('#turn-msg_dots .desktop-peer-attribution').getAttribute('aria-expanded') === 'true'`)
    }
    await page.evaluate(`document.querySelector('#turn-msg_dots .desktop-peer-attribution').focus()`)
    await page.pressKey("Escape", "Escape", 27)
    expect(await page.evaluate(`document.querySelector('#turn-msg_dots .desktop-peer-attribution').getAttribute('aria-expanded') === 'false' && document.activeElement === document.querySelector('#turn-msg_dots .desktop-peer-attribution')`, decodeBoolean)).toBe(true)
    await page.evaluate(`document.activeElement.blur()`)
    await captureReference(page, "ba7c7489375448f99efdeacb0b49b3ea", `document.querySelector('[aria-label="Current activity"]')?.textContent.includes('Tool · read') && document.querySelector('[data-dots-message]')?.textContent.includes('external peer') && document.querySelector('[aria-label="Channel bridges"]')?.textContent.includes('Remote Session relay') && !document.body.textContent.includes('WhatsApp Bridge') && !document.body.textContent.includes('Google Meet Call')`)
    dots = { ...dots, connection: { state: "error", message: "Synthetic Dots connection needs refresh." }, computer: { state: "unavailable" } }
    remote = { state: "connecting", message: "Synthetic relay is connecting." }
    await clickText(page, '[aria-label="Channel bridges"] button', "Refresh bridges")
    await wait(page, `document.querySelector('[aria-label="Channel bridges"]')?.textContent.includes('Synthetic Dots connection needs refresh.') && document.querySelector('[aria-label="Channel bridges"]')?.textContent.includes('Synthetic relay is connecting.')`)
    expect(await page.evaluate(`Object.fromEntries([...document.querySelectorAll('[aria-label="Channel bridges"] dt')].map(term => [term.textContent, term.nextElementSibling.textContent]))`, decodeDictionary(decodeString))).toEqual({ "Dots connection": "error", "Computer attachment": "unavailable", "Remote Session relay": "connecting" })
    dots = { access: { enabled: false, revision: 3 }, configuration: { ready: false }, connection: { state: "off" } }
    remote = { state: "off" }
    await clickText(page, '[aria-label="Channel bridges"] button', "Refresh bridges")
    await wait(page, `document.querySelector('[aria-label="Channel bridges"] dd')?.textContent === 'off'`)
    expect(await page.evaluate(`Object.fromEntries([...document.querySelectorAll('[aria-label="Channel bridges"] dt')].map(term => [term.textContent, term.nextElementSibling.textContent]))`, decodeDictionary(decodeString))).toEqual({ "Dots connection": "off", "Computer attachment": "Not reported", "Remote Session relay": "off" })
    running = false
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_test' } })`)
    await wait(page, `!document.querySelector('[aria-label="Current activity"]')`)
    expect(await page.evaluate(`document.querySelectorAll('[data-dots-message]').length`, decodeNumber)).toBe(2)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Stitch scene f4476b36068c4c41adbb0f97a88e33d8 folder chooser reads only the existing synthetic bundle", async () => {
  pending = false
  captureScene = true
  referenceScene = true
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/chat`)
    await wait(page, `document.querySelector('[data-new-chat] [aria-haspopup="menu"]')`)
    await page.evaluate(`document.querySelector('[data-new-chat] [aria-haspopup="menu"]').click()`)
    await clickText(page, '[data-new-chat] [role="menuitem"]', "Open folder…")
    await captureReference(page, "f4476b36068c4c41adbb0f97a88e33d8", `document.querySelector('dialog[open]')?.textContent.includes(${JSON.stringify(path.basename(owned!.resources))}) && document.querySelector('dialog[open]')?.textContent.includes('backend.json') && window.__desktopFixture.completed.browseDirectory > 0`)
  } finally { await page.close() }
}, 30_000)

test("Stitch generated prompt remains a synthetic preview before the user chooses to use it", async () => {
  pending = false
  captureScene = true
  referenceScene = true
  const page = await openReference()
  try {
    await tools(page, "Prompt assistance")
    await page.evaluate(`(() => { const input = document.querySelector('dialog[open] textarea'); input.value = 'Inspect the synthetic pagination change'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
    await clickText(page, 'dialog[open] button', "Generate prompt draft")
    await confirm(page)
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('Generated synthetic draft')`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] h3')].find(heading => heading.textContent === 'Generated draft').closest('section').scrollIntoView({ block: 'center' })`)
    await captureReference(page, "f1b26a42d41f4531a16f98aa4962b685-prompt-assistance", `document.querySelector('dialog[open]')?.textContent.includes('Generated synthetic draft') && document.querySelector('.rl-capsule textarea').value === ''`, ["POST /api/session/ses_test/prompt-generate"])
  } finally { await page.close() }
}, 30_000)

test("Stitch editor context keeps its retained selection warning visible without admitting input", async () => {
  pending = false
  captureScene = true
  referenceScene = true
  ideEnabled = true
  const page = await openReference()
  try {
    await tools(page, "Editor context")
    await wait(page, `document.querySelector('dialog[open] [aria-label="Reported IDE selection"]')?.textContent.includes('const sample = 1')`)
    ideFailure = true
    await wait(page, `document.querySelector('.rl-capsule')?.textContent.includes('IDE context could not be read')`)
    await captureReference(page, "dc5b9536f52849ab8e396f963af693ad-retained-warning", `document.querySelector('dialog[open]')?.textContent.includes('IDE context could not be read') && document.querySelector('dialog[open] [aria-label="Reported IDE selection"]')?.textContent.includes('const sample = 1') && document.querySelector('dialog[open] textarea')?.value === ''`)
    expect(saved).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Stitch observed execution status distinguishes unknown, running, idle and resync", async () => {
  pending = false
  const page = await openReference()
  try {
    const row = `[...document.querySelectorAll('.rl-session-row')].find(element => element.textContent.includes(${JSON.stringify(title)}))`
    const status = `${row}?.getAttribute('aria-label')`
    await wait(page, `${status}?.endsWith(', Status unknown')`)
    const idleCount = `document.querySelector('.rl-rail-filter[aria-label^="Idle "]')?.getAttribute('aria-label')`
    expect(await page.evaluate(idleCount, decodeString)).toBe("Idle 0")
    await page.evaluate(`document.querySelector('.rl-rail-filter[aria-label^="Idle "]').click()`)
    await wait(page, `document.querySelector('.rl-nav-scroll')?.textContent.includes('No Sessions match this filter.')`)
    expect(await page.evaluate(`document.querySelectorAll('.rl-session-row').length`, decodeNumber)).toBe(0)
    await page.evaluate(`document.querySelector('.rl-rail-filter[aria-label^="All "]').click()`)
    await wait(page, `${status}?.endsWith(', Status unknown')`)
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.started', data: { sessionID: 'ses_test' } })`)
    await wait(page, `${status}?.endsWith(', Running')`)
    expect(await page.evaluate(`${row}.textContent.trim()`, decodeString)).toBe(title)
    expect(await page.evaluate(idleCount, decodeString)).toBe("Idle 0")
    expect(await page.evaluate(`!!document.querySelector('.rl-rail-filter[aria-label="Running 1"]')`, decodeBoolean)).toBe(true)
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_test' } })`)
    await wait(page, `${status}?.endsWith(', Idle')`)
    expect(await page.evaluate(idleCount, decodeString)).toBe("Idle 1")
    await page.evaluate(`document.querySelector('.rl-rail-filter[aria-label^="Idle "]').click()`)
    await wait(page, `${status}?.endsWith(', Idle')`)
    expect(await page.evaluate(`document.querySelectorAll('.rl-session-row').length`, decodeNumber)).toBe(1)
    await page.evaluate(`document.querySelector('.rl-rail-filter[aria-label^="All "]').click()`)
    expect(await page.evaluate(status, decodeString)).not.toContain("Status unknown")
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.failed', data: { sessionID: 'ses_test', error: { type: 'synthetic', message: 'Synthetic execution failure' } } })`)
    await wait(page, `${status}?.endsWith(', Failed')`)
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.idle', data: { sessionID: 'ses_test' } })`)
    expect(await page.evaluate(status, decodeString)).toContain("Failed")
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.interrupted', data: { sessionID: 'ses_test', reason: 'user' } })`)
    await wait(page, `${status}?.endsWith(', Idle')`)
    await page.evaluate(`window.__desktopFixture.resync()`)
    await wait(page, `${status}?.endsWith(', Status unknown')`)
    expect(await page.evaluate(idleCount, decodeString)).toBe("Idle 0")
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Stitch Settings navigation scrolls and focuses sections and opens its owned management dialogs", async () => {
  pending = false
  captureScene = true
  providerScene = true
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/settings`)
    await wait(page, `document.querySelector('nav[aria-label="Settings sections"] button')`)
    expect(await page.evaluate(`[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].every(button => { const bounds = button.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight; })`, decodeBoolean)).toBe(true)
    for (const label of ["Keyboard shortcuts", "Permissions", "Updates", "Session display", "Machine & Backend"]) {
      await page.evaluate(`document.querySelector('nav[aria-label="Settings sections"]').scrollIntoView({ block: 'start' })`)
      await clickText(page, 'nav[aria-label="Settings sections"] button', label)
      await wait(page, `document.activeElement?.tagName === 'H3' && (document.activeElement.textContent.trim() === ${JSON.stringify(label)} || document.activeElement.closest('.st-section')?.getAttribute('aria-label') === ${JSON.stringify(label)})`)
      expect(await page.evaluate(`(() => { const bounds = document.activeElement.getBoundingClientRect(), header = document.querySelector('main[data-surface="settings"] .rl-page-head').getBoundingClientRect(), title = document.querySelector('main[data-surface="settings"] h1').getBoundingClientRect(); return bounds.top >= header.bottom && bounds.bottom <= innerHeight && title.top >= header.top && title.bottom <= header.bottom; })()`, decodeBoolean)).toBe(true)
    }
    for (const [label, title] of [["Appearance", "Appearance"], ["Models & Providers", "Connect providers"], ["MCP", "MCP servers"]]) {
      await page.evaluate(`document.querySelector('nav[aria-label="Settings sections"]').scrollIntoView({ block: 'start' })`)
      await clickText(page, 'nav[aria-label="Settings sections"] button', label!)
      await wait(page, `document.querySelector('dialog[open] h2')?.textContent === ${JSON.stringify(title)}`)
      await page.pressKey("Escape", "Escape", 27)
      await wait(page, `!document.querySelector('dialog[open]')`)
    }
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop structured correction system diagnostics expose reported labels without raw primary JSON", async () => {
  prepareImplementedSurface()
  sceneRead = call => call.route === "/api/provider" ? new Response("Synthetic provider read unavailable", { status: 503 }) : undefined
  const page = await openReference()
  try {
    await command(page, "/status")
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('Synthetic model configuration requires review')`)
    expect(await page.evaluate(`(() => { const dialog = document.querySelector('dialog[open]'), diagnostics = [...dialog.querySelectorAll('section')].find(section => section.querySelector('h3')?.textContent === 'Configuration diagnostics'); return !!diagnostics.querySelector('dl') && ['Path', 'Reason', 'Json Path', 'Fail Closed', 'Message'].every(label => [...diagnostics.querySelectorAll('dt')].some(term => term.textContent === label)) && !dialog.querySelector('pre') && dialog.textContent.includes('Providers could not be read') && dialog.textContent.includes('Not reported'); })()`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "structured-system.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop structured correction browser status and tabs retain separately labelled reported state", async () => {
  prepareImplementedSurface()
  sceneRead = call => call.route.endsWith("/browser") ? { data: { state: "connected", paired: true, profileGranted: false, generation: 3 } } : call.route.endsWith("/browser/tabs") ? { data: [{ id: "btab_synthetic", sessionID: "ses_test", title: "Synthetic review tab", page: { origin: "https://example.invalid", path: "/synthetic-review" }, status: "shared", generation: 3, documentGeneration: 1, observationRevision: 0 }] } : undefined
  const page = await openReference()
  try {
    await command(page, "/browser")
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('Synthetic review tab')`)
    expect(await page.evaluate(`(() => { const dialog = document.querySelector('dialog[open]'), paired = dialog.querySelector('section[aria-label="Paired browser"]'), isolated = dialog.querySelector('section[aria-label="Isolated browser"]'); return !!paired?.querySelector('dl') && paired.textContent.includes('connected') && paired.textContent.includes('/synthetic-review') && [...paired.querySelectorAll('h4')].some(heading => heading.textContent === 'Tabs') && !!isolated?.textContent.includes('stopped') && !dialog.querySelector('pre'); })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => { const value = [...document.querySelectorAll('section[aria-label="Paired browser"] dt')].find(term => term.textContent === 'Origin').nextElementSibling.querySelector('span'), range = document.createRange(); range.selectNodeContents(value); return range.getClientRects().length <= Math.ceil(value.textContent.length / 6); })()`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "structured-browser.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop structured correction incident report uses public row fields and compact filters", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/usage`)
    await clickText(page, 'main button', "Usage dashboard and incidents")
    await clickText(page, 'main button', "Read incident report")
    await wait(page, `window.__desktopFixture.completed.incidents > 0`)
    expect(await page.evaluate(`(() => { const section = document.querySelector('section[aria-label="Usage dashboard and incidents"]'), labels = [...section.querySelectorAll('table[aria-label="Incident report"] th')].map(term => term.textContent), fields = [...section.querySelectorAll('label')].filter(label => ['Provider ID', 'Model ID', 'Agent filter'].includes(label.querySelector('span')?.textContent)); return ['Provider ID', 'Model ID', 'Fallbacks', 'Escalated', 'Rejected', 'Last'].every(label => labels.includes(label)) && !section.querySelector('pre') && fields.length === 3 && Math.max(...fields.map(field => field.getBoundingClientRect().top)) - Math.min(...fields.map(field => field.getBoundingClientRect().top)) <= 1; })()`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "structured-incidents.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency")).map(call => `${call.method} ${call.route}`)).toEqual(["POST /api/usage/dashboard"])
  } finally { await page.close() }
}, 30_000)

test("Desktop pairing keeps a synthetic issued secret masked until reveal and reports clipboard failures", async () => {
  prepareImplementedSurface()
  const secret = "synthetic-pairing-value-not-a-live-secret"
  sceneRead = call => call.method === "POST" && call.route === "/api/session/ses_test/browser/start" ? { data: { secret, expiresAt: Date.now() + 60_000 } } : undefined
  const page = await openReference()
  try {
    await command(page, "/remote")
    await clickText(page, 'dialog[open] button:not(:disabled)', "Pair browser")
    await confirm(page)
    await wait(page, `document.querySelector('code[aria-label="Pairing secret"]')`)
    expect(await page.evaluate(`document.querySelector('code[aria-label="Pairing secret"]').textContent === '••••••••••••••••' && !document.querySelector('dialog[open]').textContent.includes(${JSON.stringify(secret)})`, decodeBoolean)).toBe(true)
    clipboardFailure = true
    await clickText(page, 'dialog[open] button', "Copy pairing secret")
    await wait(page, `[...document.querySelectorAll('dialog[open] [role="alert"]')].some(node => node.textContent.includes('Synthetic clipboard unavailable'))`)
    expect(clipboard).toEqual([])
    clipboardFailure = false
    await clickText(page, 'dialog[open] button', "Copy pairing secret")
    await wait(page, `[...document.querySelectorAll('dialog[open] [role="status"]')].some(node => node.textContent === 'Pairing secret copied')`)
    expect(clipboard).toEqual([secret])
    clipboardFailure = true
    await clickText(page, 'dialog[open] button', "Copy pairing secret")
    await wait(page, `[...document.querySelectorAll('dialog[open] [role="alert"]')].some(node => node.textContent.includes('Synthetic clipboard unavailable'))`)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="status"]')].some(node => node.textContent === 'Pairing secret copied')`, decodeBoolean)).toBe(false)
    clipboardFailure = false
    await clickText(page, 'dialog[open] button', "Reveal pairing secret")
    expect(await page.evaluate(`document.querySelector('code[aria-label="Pairing secret"]').textContent`, decodeString)).toBe(secret)
    await clickText(page, 'dialog[open] button', "Hide pairing secret")
    expect(await page.evaluate(`document.querySelector('code[aria-label="Pairing secret"]').textContent`, decodeString)).toBe("••••••••••••••••")
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency")).map(call => `${call.method} ${call.route}`)).toEqual(["POST /api/session/ses_test/browser/start"])
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop structured correction workspace distinguishes failed and empty reads and recovers current entries", async () => {
  prepareImplementedSurface()
  browseListing = new Error("Synthetic workspace folder unavailable.")
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/workspaces`)
    await wait(page, `document.querySelector('main [role="alert"]')?.textContent.includes('Synthetic workspace folder unavailable')`)
    expect(await page.evaluate(`!document.querySelector('main [data-part="ws-files"]') && !document.querySelector('main').textContent.includes('This folder is empty.')`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "workspace-read-failed.png"), Buffer.from(await page.screenshot(), "base64"))
    browseListing = { directory: "/synthetic/repo", parent: "/synthetic", home: "/synthetic", entries: [], truncated: false }
    await clickText(page, 'main button', "Retry folder read")
    await wait(page, `document.querySelector('main [data-part="ws-files"]')?.textContent.includes('This folder is empty.')`)
    expect(await page.evaluate(`!document.querySelector('main [role="alert"]')`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "workspace-read-empty.png"), Buffer.from(await page.screenshot(), "base64"))
    browseListing = new Error("Synthetic workspace read interrupted.")
    await page.evaluate(`window.__desktopFixture.resync()`)
    await wait(page, `document.querySelector('main [role="alert"]')?.textContent.includes('Synthetic workspace read interrupted')`)
    expect(await page.evaluate(`!document.querySelector('main [data-part="ws-files"]') && !document.querySelector('main').textContent.includes('This folder is empty.')`, decodeBoolean)).toBe(true)
    browseListing = { directory: "/synthetic/repo", parent: "/synthetic", home: "/synthetic", entries: [{ name: "recovered.txt", path: "/synthetic/repo/recovered.txt", kind: "file" }], truncated: false }
    await clickText(page, 'main button', "Retry folder read")
    await wait(page, `document.querySelector('main [data-part="ws-files"]')?.textContent.includes('recovered.txt')`)
    expect(await page.evaluate(`!document.querySelector('main [role="alert"]') && !document.querySelector('main').textContent.includes('This folder is empty.')`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "workspace-read-recovered.png"), Buffer.from(await page.screenshot(), "base64"))
  } finally { await page.close() }
}, 30_000)

test("Desktop structured correction dialog textarea owns editable prose and keyboard focus", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    await message(page, "Synthetic editable draft")
    await command(page, "Edit the full prompt draft")
    await wait(page, `document.querySelector('dialog[open] textarea')`)
    expect(await page.evaluate(`(() => { const area = document.querySelector('dialog[open] textarea'), style = getComputedStyle(area); return style.fontFamily.includes('Geist') && !style.fontFamily.includes('Mono') && style.backgroundColor === 'rgb(11, 17, 21)' && style.borderTopWidth === '1px' && Number.parseFloat(style.paddingTop) > 0 && style.resize === 'vertical'; })()`, decodeBoolean)).toBe(true)
    await page.evaluate(`document.querySelector('dialog[open] textarea').focus()`)
    await page.pressKey("End", "End", 35)
    await page.pressKey("x", "KeyX", 88, "x")
    expect(await page.evaluate(`(() => { const area = document.querySelector('dialog[open] textarea'); return area === document.activeElement && area.value === 'Synthetic editable draftx' && getComputedStyle(area).borderTopColor === 'rgb(103, 215, 164)' && getComputedStyle(area).boxShadow !== 'none'; })()`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "dialog-owned-textarea.png"), Buffer.from(await page.screenshot(), "base64"))
    await clickText(page, 'dialog[open] button', "Save draft")
    await wait(page, `!document.querySelector('dialog[open]')`)
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`, decodeString)).toBe("Synthetic editable draftx")
    expect(owned!.calls.filter(call => call.method === "POST" && call.route.endsWith("/prompt"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop visual correction long rail titles retain their names within two visible lines", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    expect(await page.evaluate(`(() => {
      const title = [...document.querySelectorAll('.rl-session-row-title')].find(node => node.textContent === ${JSON.stringify(unbroken)}), row = title.closest('.workspace__row'), link = title.closest('a'), status = row.querySelector('.rl-rail-status');
      link.focus();
      const bounds = title.getBoundingClientRect(), metadata = status.getBoundingClientRect(), pin = row.querySelector('.workspace__pin');
      return title.textContent === ${JSON.stringify(unbroken)} && link.textContent.trim() === ${JSON.stringify(unbroken)} && link.getAttribute('aria-label').startsWith(title.textContent + ', ') && bounds.height <= Number.parseFloat(getComputedStyle(title).lineHeight) * 2 + 1 && metadata.right <= bounds.left + 1 && metadata.height > 0 && getComputedStyle(pin).visibility === 'visible';
    })()`, decodeBoolean)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('.workspace__row')].find(row => row.textContent.includes(${JSON.stringify(unbroken)})).querySelector('.workspace__pin').focus()`)
    expect(await page.evaluate(`document.activeElement.matches('.workspace__pin') && !!document.activeElement.getAttribute('aria-label')`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "rail-two-line-title.png"), Buffer.from(await page.screenshot(), "base64"))
  } finally { await page.close() }
}, 30_000)

test("Desktop visual correction presentation rows expose visible subjects and aligned controls", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/settings`)
    await clickText(page, 'nav[aria-label="Settings sections"] button', "Session display")
    await wait(page, `document.activeElement?.textContent.trim() === 'Session display'`)
    expect(await page.evaluate(`(() => {
      const section = document.querySelector('section[aria-label="Session display"]');
      const rows = ['Reasoning', 'Tool calls', 'Session companion at launch', 'Large pastes'].map(label => {
        const title = [...section.querySelectorAll('*')].find(node => !node.children.length && node.textContent.trim() === label && node.getBoundingClientRect().height > 0);
        const group = section.querySelector('[role="radiogroup"][aria-label="' + label + '"]');
        if (!title || !group) return undefined;
        let row = title.parentElement;
        while (row && !row.contains(group)) row = row.parentElement;
        const bounds = group.getBoundingClientRect(), heading = title.getBoundingClientRect();
        return row && row !== section && row.querySelector('p')?.textContent.trim() && bounds.left >= heading.right && bounds.height > 0 ? bounds.right : undefined;
      });
      return rows.every(right => right !== undefined && Math.abs(right - rows[0]) <= 1) && section.innerText.includes('over 150 characters') && section.querySelectorAll('[role="radio"][aria-checked="true"]').length === 4;
    })()`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "presentation-labelled-rows.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop visual correction target chooser overlays its composer entry without moving the draft", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    await page.navigate(`${origin}/#/chat`)
    await wait(page, `document.querySelector('[data-new-chat] .rl-capsule textarea')`)
    await message(page, "Retain the anchored workspace draft")
    await page.evaluate(`window.__targetDraftBounds = JSON.stringify(document.querySelector('.rl-capsule').getBoundingClientRect().toJSON())`)
    await clickText(page, '[data-new-chat] button', "Target Workspace / Worktree")
    await wait(page, `document.querySelector('[aria-label="Target Workspace / Worktree"] [data-target-directory]')`)
    expect(await page.evaluate(`(() => {
      const picker = document.querySelector('[aria-label="Target Workspace / Worktree"]'), capsule = document.querySelector('.rl-capsule'), trigger = [...document.querySelectorAll('[data-new-chat] button')].find(button => button.textContent.trim() === 'Target Workspace / Worktree');
      const panel = picker.getBoundingClientRect(), entry = trigger.getBoundingClientRect();
      return capsule.contains(trigger) && Math.abs(panel.left - entry.left) <= 1 && panel.bottom <= entry.top && entry.top - panel.bottom <= 12 && panel.top >= 0 && panel.right <= innerWidth && window.__targetDraftBounds === JSON.stringify(capsule.getBoundingClientRect().toJSON());
    })()`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "target-composer-overlay.png"), Buffer.from(await page.screenshot(), "base64"))
    await page.pressKey("Escape", "Escape", 27)
    await wait(page, `!document.querySelector('[aria-label="Target Workspace / Worktree"]')`)
    expect(await page.evaluate(`document.activeElement?.textContent.trim() === 'Target Workspace / Worktree' && document.querySelector('.rl-capsule textarea').value === 'Retain the anchored workspace draft' && window.__targetDraftBounds === JSON.stringify(document.querySelector('.rl-capsule').getBoundingClientRect().toJSON())`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop floating composer keeps one Send or Stop slot and preserves steering and reduced-motion status", async () => {
  prepareImplementedSurface()
  const page = await openReference()
  try {
    expect(await page.evaluate(`(() => { const label = document.querySelector('.composer-bar > .composer-chip[aria-haspopup="dialog"] span'); return label.textContent.includes('Mixed') && label.scrollWidth <= label.clientWidth; })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => { const dock = document.querySelector('.rl-dock'), style = getComputedStyle(dock); return style.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(style.borderTopWidth) === 0 && !dock.innerText.includes('Working') && parseFloat(getComputedStyle(dock.querySelector('.rl-capsule')).borderTopLeftRadius) === 16 && dock.querySelector('.rl-send').getAttribute('aria-label') === 'Send prompt'; })()`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "composer-ready.png"), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`(() => { const capsule = document.querySelector('.rl-capsule').getBoundingClientRect(); window.__fixedExecutionSlots = ['.rl-send', '.composer-bar button[aria-label="Send mode"]'].map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [rect.left - capsule.left, rect.top - capsule.top, rect.width, rect.height]; }); })()`)
    running = true
    await page.evaluate(`window.__desktopFixture.resync(); window.__desktopFixture.emit({ type: 'session.execution.started', data: { sessionID: 'ses_test' } })`)
    await wait(page, `document.querySelector('.rl-send[data-stopping="true"]') && document.querySelector('[aria-label="Current activity"]')`)
    expect(await page.evaluate(`(() => {
      const capsule = document.querySelector('.rl-capsule').getBoundingClientRect(), stop = document.querySelector('.rl-send[data-stopping="true"]'), bounds = stop.getBoundingClientRect(), label = document.querySelector('.composer-bar > .composer-chip[aria-haspopup="dialog"] span');
      const selectors = ['.rl-send', '.composer-bar button[aria-label="Send mode"]'], controls = selectors.map(selector => document.querySelector(selector).getBoundingClientRect());
      const stable = JSON.stringify(window.__fixedExecutionSlots) === JSON.stringify(controls.map(rect => [rect.left - capsule.left, rect.top - capsule.top, rect.width, rect.height]));
      const contained = bounds.left >= capsule.left && bounds.right <= capsule.right && bounds.top >= capsule.top && bounds.bottom <= capsule.bottom && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
      const separate = [controls[1], label.getBoundingClientRect()].every(rect => bounds.right <= rect.left || bounds.left >= rect.right || bounds.bottom <= rect.top || bounds.top >= rect.bottom);
      const reachable = bounds.width >= 32 && bounds.height >= 32 && !stop.disabled && document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('.rl-send') === stop;
      const danger = document.createElement('span'); danger.style.color = 'var(--yc-danger)'; stop.parentElement.append(danger); const red = getComputedStyle(stop).color === getComputedStyle(danger).color; danger.remove();
      return stable && contained && separate && reachable && red && !document.querySelector('.composer-live-action--stop') && !document.querySelector('.rl-dock').innerText.includes('Working') && label.textContent.includes('Mixed') && label.scrollWidth <= label.clientWidth && !!document.querySelector('.composer-bar button[aria-label="Send mode"]') && !!document.querySelector('[aria-label="Send and steer now"]');
    })()`, decodeBoolean)).toBe(true)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "composer-readable-autonomy.png"), Buffer.from(await page.screenshot(), "base64"))
    await page.setReducedMotion(true)
    await wait(page, `matchMedia('(prefers-reduced-motion: reduce)').matches`)
    expect(await page.evaluate(`(() => { const row = document.querySelector('.rl-session-row[data-state="running"]'), arc = row?.querySelector('.desktop-state__orbit'); return !!arc && getComputedStyle(arc).animationName === 'none' && row.getAttribute('aria-label').endsWith(', Running') && !row.querySelector('.workspace__status'); })()`, decodeBoolean)).toBe(true)
    await page.evaluate(`document.querySelector('[aria-label="Stop generation"]').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.rl-dock').innerText.includes('Stop requested') || !document.querySelector('.rl-send[data-stopping="true"]')`)
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.interrupted', data: { sessionID: 'ses_test', reason: 'user' } })`)
    await wait(page, `!document.querySelector('.rl-send[data-stopping="true"]')`)
    expect(owned!.calls.filter(call => call.method === "POST" && call.route.endsWith("/interrupt"))).toHaveLength(1)
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Ledger Dark owns its palette and keeps the unified composer usable through resize", async () => {
  pending = false
  const page = await open()
  try {
    await page.evaluate(`(() => { localStorage.setItem('ycoding.desktop.theme', 'dark'); localStorage.setItem('ycoding.desktop.animations', 'false'); location.reload(); })()`)
    await wait(page, `document.documentElement.dataset.theme === 'dark' && document.querySelector('#turn-msg_response') && document.fonts.status === 'loaded'`)
    await message(page, "Retained Ledger draft")
    await wait(page, `document.querySelector('.rl-capsule textarea').getBoundingClientRect().height === 44`)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "ledger-desktop.png"), Buffer.from(await page.screenshot(), "base64"))
    const palette = await page.evaluate(`(() => { const style = getComputedStyle(document.documentElement); return Object.fromEntries(['--yc-bg', '--yc-surface', '--yc-surface-raised', '--yc-surface-overlay', '--yc-text', '--yc-primary-bg', '--yc-focus'].map(name => [name, style.getPropertyValue(name).trim().toLowerCase()])); })()`, decodeDictionary(decodeString))
    const design = Bun.YAML.parse((await Bun.file(path.join(import.meta.dir, "../DESIGN.md")).text()).split("---")[1]!) as { colors: Record<string, string>; typography: { body: { fontFamily: string }; mono: { fontFamily: string } } }
    expect(palette).toEqual({ "--yc-bg": design.colors.bg!.toLowerCase(), "--yc-surface": design.colors.surface!.toLowerCase(), "--yc-surface-raised": design.colors["surface-raised"]!.toLowerCase(), "--yc-surface-overlay": design.colors["surface-overlay"]!.toLowerCase(), "--yc-text": design.colors.text!.toLowerCase(), "--yc-primary-bg": design.colors["primary-bg"]!.toLowerCase(), "--yc-focus": design.colors.focus!.toLowerCase() })
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.rl')).fontFamily.includes(${JSON.stringify(design.typography.body.fontFamily)}) && getComputedStyle(document.querySelector('.composer-chip')).fontFamily.includes(${JSON.stringify(design.typography.body.fontFamily)})`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.rl-capsule')).filter`, decodeString)).toBe("none")
    await page.evaluate(`document.querySelector('.composer-bar button[aria-label="Send mode"]').focus()`)
    await page.pressKey(" ", "Space", 32, " ")
    await wait(page, `document.querySelector('[role="listbox"][aria-label="Send mode"]')`)
    const delivery = await page.evaluate(`(() => { const list = document.querySelector('[role="listbox"][aria-label="Send mode"]'), rect = list.getBoundingClientRect(), capsule = document.querySelector('.rl-capsule').getBoundingClientRect(); return { width: rect.width, minimum: Math.min(280, capsule.width - 32), withinViewport: rect.left >= 0 && rect.right <= innerWidth, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth }; })()`, (value: unknown) => { const result = decodeRecord(value); return { width: (decodeNumber)(result["width"]), minimum: (decodeNumber)(result["minimum"]), withinViewport: (decodeBoolean)(result["withinViewport"]), scrollWidth: (decodeNumber)(result["scrollWidth"]), clientWidth: (decodeNumber)(result["clientWidth"]) } })
    expect(delivery.width).toBeGreaterThanOrEqual(delivery.minimum)
    expect(delivery.withinViewport).toBe(true)
    expect(delivery.scrollWidth).toBeLessThanOrEqual(delivery.clientWidth)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "ledger-delivery.png"), Buffer.from(await page.screenshot(), "base64"))
    await page.pressKey("ArrowDown", "ArrowDown", 40)
    await page.pressKey("Enter", "Enter", 13, "\r")
    expect(await page.evaluate(`document.querySelector('.composer-bar button[aria-label="Send mode"]').textContent.trim()`, decodeString)).toBe("Queue")
    await page.setViewport(840, 760)
    await wait(page, `innerWidth === 840`)
    const layout = await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const capsule = document.querySelector('.rl-capsule').getBoundingClientRect(); const controls = [...document.querySelectorAll('.composer-bar button')].filter(node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible'); resolve({ fits: controls.every(node => { const rect = node.getBoundingClientRect(); return rect.left >= capsule.left && rect.right <= capsule.right && rect.top >= capsule.top && rect.bottom <= capsule.bottom; }), draft: document.querySelector('.rl-capsule textarea').value, send: !document.querySelector('.rl-send').disabled }); })))`, (value: unknown) => { const result = decodeRecord(value); return { fits: (decodeBoolean)(result["fits"]), draft: (decodeString)(result["draft"]), send: (decodeBoolean)(result["send"]) } })
    expect(layout).toEqual({ fits: true, draft: "Retained Ledger draft", send: true })
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "ledger-narrow.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(owned?.calls.filter(call => call.method === "POST" && call.route.endsWith("/prompt"))).toHaveLength(0)
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("layout stability keeps streaming disclosures mounted and follows only the attached reader", async () => {
  pending = false
  running = true
  presentationParts = true
  const page = await open()
  try {
    await page.evaluate(`(() => {
      const scroller = document.querySelector('.conversation__scroll');
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      window.__stableReason = document.querySelector('#turn-msg_response details');
      window.__stableReason.open = true;
      window.__stableProse = document.querySelector('#turn-msg_response .transcript-message__text');
    })()`)
    replyText = "Streaming synthetic text. ".repeat(180)
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.text.delta', data: { sessionID: 'ses_test', assistantMessageID: 'msg_response', ordinal: 3, delta: 'synthetic' } })`)
    await wait(page, `document.querySelector('#turn-msg_response').textContent.includes(${JSON.stringify(replyText)})`)
    const result = await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const scroller = document.querySelector('.conversation__scroll'); resolve({ reason: window.__stableReason === document.querySelector('#turn-msg_response details'), prose: window.__stableProse === document.querySelector('#turn-msg_response .transcript-message__text'), open: document.querySelector('#turn-msg_response details').open, distance: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop }); })))`)
    expect(result).toEqual({ reason: true, prose: true, open: true, distance: 0 })
    const top = await page.evaluate(`(() => { const scroller = document.querySelector('.conversation__scroll'); scroller.scrollTop -= 500; scroller.dispatchEvent(new Event('scroll')); return scroller.scrollTop; })()`)
    replyText += " Detached streaming text. ".repeat(160)
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.text.delta', data: { sessionID: 'ses_test', assistantMessageID: 'msg_response', ordinal: 3, delta: 'more' } })`)
    await wait(page, `document.querySelector('#turn-msg_response').textContent.includes('Detached streaming text.')`)
    expect(await page.evaluate(`document.querySelector('.conversation__scroll').scrollTop`)).toBe(top)
    expect(await page.evaluate(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("layout stability retains rail focus and transcript nodes when older history is prepended", async () => {
  pending = false
  const page = await open()
  try {
    await page.evaluate(`(() => { window.__stablePrompt = document.querySelector('#turn-msg_prompt_239'); document.querySelector('.rl-session-row').focus(); window.__stablePin = document.querySelector('.workspace__pin'); window.__stablePin.focus(); if (document.activeElement !== window.__stablePin) throw new Error('Pin must own focus before refresh'); window.__desktopFixture.resync(); })()`)
    await wait(page, `(window.__desktopFixture.completed.sessionSnapshot ?? 0) >= 2`)
    expect(await page.evaluate(`window.__stablePin === document.activeElement && window.__stablePin.isConnected`)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('.conversation__scroll button')].find(button => button.textContent === 'Load older messages').click()`)
    await wait(page, `document.querySelector('#turn-msg_prompt_41')`)
    expect(await page.evaluate(`window.__stablePrompt === document.querySelector('#turn-msg_prompt_239')`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("layout stability bounds live counters and waiting badges without moving adjacent controls", async () => {
  pending = false
  const page = await open()
  try {
    const stable = await page.evaluate(`(() => {
      const filters = [...document.querySelectorAll('.rl-rail-filter')];
      const before = filters.map(element => element.getBoundingClientRect().toJSON());
      filters.forEach(element => element.lastElementChild.textContent = '999');
      const after = filters.map(element => element.getBoundingClientRect().toJSON());
      return before.every((rect, index) => rect.x === after[index].x && rect.width === after[index].width && rect.height === after[index].height);
    })()`)
    expect(stable).toBe(true)
    const title = await page.evaluate(`(() => { const rect = document.querySelector('.rl-session-row[aria-current="page"] .rl-session-row-title').getBoundingClientRect(); return { width: rect.width, height: rect.height }; })()`)
    await page.evaluate(`window.__desktopFixture.emit({ type: 'permission.asked', data: { id: 'per_geometry', sessionID: 'ses_test', action: 'synthetic', resources: [] } })`)
    await wait(page, `document.querySelector('.rl-session-row[data-state="waiting"]')`)
    expect(await page.evaluate(`(() => { const rect = document.querySelector('.rl-session-row[aria-current="page"] .rl-session-row-title').getBoundingClientRect(); return { width: rect.width, height: rect.height }; })()`)).toEqual(title)
  } finally { await page.close() }
}, 30_000)

test("layout stability coalesces composer growth and preserves bottom anchoring on shrink", async () => {
  pending = false
  const page = await open()
  try {
    const reads = await page.evaluate(`(() => {
      const input = document.querySelector('.rl-capsule textarea');
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
      let reads = 0;
      Object.defineProperty(input, 'scrollHeight', { configurable: true, get() { reads++; return descriptor.get.call(this); } });
      for (let index = 0; index < 30; index++) { input.value = ('Synthetic line ' + index + '\\n').repeat(index + 1); input.dispatchEvent(new InputEvent('input', { bubbles: true })); }
      delete input.scrollHeight;
      return reads;
    })()`)
    expect(reads).toBeLessThanOrEqual(1)
    await wait(page, `document.querySelector('.rl-capsule textarea').getBoundingClientRect().height >= 160`)
    const bottom = await page.evaluate(`document.querySelector('.rl-capsule').getBoundingClientRect().bottom`)
    await message(page, "Short draft")
    await wait(page, `document.querySelector('.rl-capsule textarea').getBoundingClientRect().height === 44`)
    expect(await page.evaluate(`document.querySelector('.rl-capsule').getBoundingClientRect().bottom`)).toBe(bottom)
    expect(await page.evaluate(`(() => { const scroller = document.querySelector('.conversation__scroll'); return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop; })()`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("layout stability reserves composer actions through live metadata and running-state changes", async () => {
  pending = false
  sessionCost = 1.23
  const page = await open()
  const geometry = `(() => { const nodes = ['.rl-send', '.composer-bar button[aria-label="Send mode"]']; return nodes.map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }); })()`
  try {
    await message(page, "Retained synthetic draft")
    await wait(page, `document.querySelector('.composer-metrics') && document.querySelector('.rl-capsule textarea').getBoundingClientRect().height === 44`)
    const original = await page.evaluate(geometry, decodeArray((value: unknown) => value))
    await page.evaluate(`(() => { for (const [kind, value] of [['input', '999,999,999'], ['output', '999,999'], ['cost', '$999.99']]) document.querySelector('.composer-metric[data-kind="' + kind + '"] strong').textContent = value; document.querySelector('.composer-chip--model > span').textContent = 'Synthetic model name with a long provider and profile label'; })()`)
    expect(await page.evaluate(geometry, decodeArray((value: unknown) => value))).toEqual(original)
    running = true
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.started', data: { sessionID: 'ses_test' } })`)
    await wait(page, `document.querySelector('[aria-label="Stop"]')`)
    expect(await page.evaluate(geometry, decodeArray((value: unknown) => value))).toEqual(original)
    expect(await page.evaluate(`(() => { const stop = document.querySelector('[aria-label="Stop"]').getBoundingClientRect(), send = document.querySelector('.rl-send').getBoundingClientRect(), card = document.querySelector('.rl-capsule').getBoundingClientRect(); return stop.width >= send.width && stop.height >= send.height && stop.left >= card.left && stop.right <= card.right && stop.top >= card.top && stop.bottom <= card.bottom && (stop.right <= send.left || stop.left >= send.right || stop.bottom <= send.top || stop.top >= send.bottom); })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`, decodeString)).toBe("Retained synthetic draft")
    running = false
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.idle', data: { sessionID: 'ses_test' } })`)
    await wait(page, `!document.querySelector('[aria-label="Stop"]')`)
    expect(await page.evaluate(geometry)).toEqual(original)
    expect(await page.evaluate(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("active question controls require complete answers and send their ordered selections once", async () => {
  pending = false
  questionPending = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('#question-que_active')`)
    await page.evaluate(`document.querySelector('#question-que_active').closest('article').querySelector('button[type="submit"]').click()`)
    await wait(page, `document.querySelector('#question-que_active').closest('article').querySelector('[role="alert"]')`)
    expect(owned?.calls.filter((call) => call.method === "POST" && call.route.includes("/question/"))).toHaveLength(0)
    await page.evaluate(`(() => {
      const card = document.querySelector('#question-que_active').closest('article');
      for (const input of card.querySelectorAll('input[type="checkbox"]')) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
      const input = card.querySelector('input[type="text"]'); input.value = 'Detailed synthetic answer'; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      card.querySelector('button[type="submit"]').click();
    })()`)
    await wait(page, `!document.querySelector('#question-que_active')`)
    expect(owned?.calls.filter((call) => call.method === "POST" && call.route.includes("/question/"))).toEqual([expect.objectContaining({ route: "/api/session/ses_test/question/que_active/reply", body: { answers: [["Local", "Preview"], ["Detailed synthetic answer"]] } })])
    expect(await page.evaluate(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity opens composition commands without submitting their text as a prompt", async () => {
  pending = false
  const page = await open()
  try {
    for (const [input, tab, draft] of [["/btw Synthetic side chat", "Side chat", "Synthetic side chat"], ["/suggest Synthetic hint", "Prompt assistance", "Synthetic hint"], ["/prompt Synthetic intent", "Prompt assistance", "Synthetic intent"]]) {
      await message(page, input!)
      await page.evaluate(`document.querySelector('.rl-send').click()`)
      await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Session actions' && document.querySelector('dialog[open] [role="radio"][aria-checked="true"]')?.textContent === ${JSON.stringify(tab)}`)
      expect(await page.evaluate(`document.querySelector('dialog[open] textarea').value`)).toBe(draft!)
      expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
      await page.pressKey("Escape", "Escape", 27)
      await wait(page, `!document.querySelector('dialog[open]')`)
    }
    await message(page, "/btw-send Not a side chat")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.body.textContent.includes('available only in a BTW side chat')`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity edits a prompt without submitting it and preserves file and agent attachments", async () => {
  pending = false
  const page = await open()
  try {
    await command(page, "/undo")
    await confirm(page)
    await wait(page, `document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.')`)
    await command(page, "Edit the full prompt draft")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Edit prompt'`)
    await page.evaluate(`(() => { const input = document.querySelector('dialog[open] textarea'); input.value = 'Edited synthetic draft'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); [...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Save draft').click(); })()`)
    await wait(page, `!document.querySelector('dialog[open]') && document.querySelector('.rl-capsule textarea').value === 'Edited synthetic draft'`)
    expect(await page.evaluate(`document.querySelector('[aria-label="Attached workspace files"]').textContent`)).toContain("restored-notes.txt")
    expect(await page.evaluate(`document.querySelector('[aria-label="Restored agent attachments"]').textContent`)).toContain("reviewer")
    expect(owned!.calls.filter((call) => call.route.endsWith("/prompt"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("native IDE context can be excluded, included and admitted once before the message", async () => {
  pending = false
  ideEnabled = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('[aria-label="IDE context"]')`)
    await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Exclude IDE selection').click()`)
    await message(page, "without IDE context")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    expect(owned!.calls.filter((call) => call.route.endsWith("/synthetic"))).toEqual([])
    await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Include IDE selection').click()`)
    await message(page, "with IDE context")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    await message(page, "same IDE context")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    const admitted = owned!.calls.filter((call) => call.method === "POST" && (call.route.endsWith("/synthetic") || call.route.endsWith("/prompt")))
    expect(admitted.map((call) => call.route.split("/").at(-1))).toEqual(["prompt", "synthetic", "prompt", "prompt"])
    expect(admitted[1]!.body.text).toContain("const sample = 1")
    expect(admitted[1]!.body.resume).toBe(false)
    expect(admitted[2]!.body.text).toBe("with IDE context")
  } finally { await page.close() }
}, 30_000)

test("native external editing preserves attachments and accepts an intentionally empty draft", async () => {
  pending = false
  externalEdit = ""
  const page = await open()
  try {
    await command(page, "/undo")
    await confirm(page)
    await wait(page, `document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.')`)
    await command(page, "Edit the full prompt draft")
    await wait(page, `window.__desktopFixture.completed.editDraft === 1 && document.querySelector('.rl-capsule textarea').value === ''`)
    expect(await page.evaluate(`!!document.querySelector('dialog[open]')`)).toBe(false)
    expect(await page.evaluate(`document.querySelector('[aria-label="Attached workspace files"]').textContent`)).toContain("restored-notes.txt")
    expect(await page.evaluate(`document.querySelector('[aria-label="Restored agent attachments"]').textContent`)).toContain("reviewer")
    expect(owned!.calls.filter((call) => call.route.endsWith("/prompt"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity preserves full stashed drafts across both composers", async () => {
  pending = false
  const page = await open()
  const draft = {
    text: "@helper @a.ts @reviewer @b.ts",
    files: [{ uri: "file:///synthetic/a.ts", name: "a.ts", mention: { start: 8, end: 13, text: "@a.ts" } }],
    agents: [{ name: "helper", mention: { start: 0, end: 7, text: "@helper" } }],
    picks: [{ kind: "agent", name: "reviewer", display: "@reviewer" }, { kind: "file", uri: "file:///synthetic/b.ts", name: "b.ts", display: "@b.ts" }],
  }
  try {
    for (const route of ["/sessions/ses_test", "/chat"]) {
      await page.navigate(`${origin}/#${route}`)
      await wait(page, `document.querySelector('.rl-capsule textarea') && document.querySelector('.desktop__palette')`)
      await page.evaluate(`localStorage.setItem('ycoding.desktop.prompt-stashes', JSON.stringify([{ ...${JSON.stringify(draft)}, id: 'synthetic-stash', createdAt: 1 }]))`)
      await command(page, "Stash or restore the prompt")
      await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Pop and restore').click()`)
      await wait(page, `!document.querySelector('dialog[open]') && document.querySelector('.rl-capsule textarea').value === ${JSON.stringify(draft.text)}`)
      await command(page, "Stash or restore the prompt")
      await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Stash current draft').click()`)
      expect(await page.evaluate(`(() => { const { text, files, agents, picks } = JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))[0]; return { text, files, agents, picks }; })()`)).toEqual(draft)
      await page.pressKey("Escape", "Escape", 27)
      await wait(page, `!document.querySelector('dialog[open]')`)
    }
    expect(owned!.calls.filter((call) => call.route.endsWith("/prompt"))).toEqual([])
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.prompt-stashes')`); await page.close() }
}, 30_000)

test("Desktop Session changes keep controls above clean file navigation and review inside each patch header", async () => {
  prepareImplementedSurface()
  sceneRead = call => call.route.endsWith("/file-change") ? { data: [scenePatch] } : undefined
  const page = await openReference()
  try {
    await companion(page, "Changes")
    await clickText(page, '.rl-companion button', "Open full changes page")
    for (const [mode, width] of [["Unified", 240], ["Split", 220]] as const) {
      await clickText(page, '.rl-companion [role="radio"]', mode)
      expect(await page.evaluate(`(() => { const surface = document.querySelector('.rl-companion[data-full="true"] [aria-label="File changes"]'); const nav = surface.querySelector('nav'); const controls = surface.querySelector('[aria-label="Diff display controls"]'); if (!controls) return false; const n = nav.getBoundingClientRect(), c = controls.getBoundingClientRect(); return Math.abs(n.width - ${width}) <= 1 && c.bottom <= n.top && c.left <= n.left + 16 && !nav.querySelector('input, [role="radio"], [role="combobox"]') && !/review|Refresh|Captured changes/.test(nav.textContent); })()`, decodeBoolean)).toBe(true)
      expect(await page.evaluate(`(() => { const surface = document.querySelector('.rl-companion[data-full="true"] [aria-label="File changes"]'); const nav = surface.querySelector('nav').getBoundingClientRect(); return [...surface.querySelectorAll('[aria-label="Change scope"], [aria-label="Reviewed files"], button')].filter(element => element.matches('[aria-label="Change scope"], [aria-label="Reviewed files"]') || ['Refresh', 'Compact changes view'].includes(element.textContent)).every(element => element.getBoundingClientRect().bottom <= nav.top); })()`, decodeBoolean)).toBe(true)
      expect(await page.evaluate(`(() => { const file = document.querySelector('.rl-companion .desktop-diff__file'); const heading = file.querySelector('header'); const review = file.querySelector('button[aria-label="Mark reviewed: src/pagination.ts"]'); if (!heading || !review) return false; const h = heading.getBoundingClientRect(), r = review.getBoundingClientRect(); return heading.textContent.includes('src/pagination.ts') && heading.textContent.includes('+1') && heading.textContent.includes('−1') && r.top >= h.top && r.bottom <= h.bottom && h.height <= 44; })()`, decodeBoolean)).toBe(true)
      if (mode === "Unified") expect(await page.evaluate(`(() => { const table = document.querySelector('.rl-companion .desktop-diff__unified'); return table.querySelector('thead').getBoundingClientRect().height <= 1 && table.querySelector('caption').getBoundingClientRect().height <= 1 && table.querySelector('.desktop-diff__hunk').textContent.startsWith('@@'); })()`, decodeBoolean)).toBe(true)
      else expect(await page.evaluate(`[...document.querySelectorAll('.rl-companion .desktop-diff__split thead th')].map(element => element.textContent)`, decodeArray(decodeString))).toEqual(["ORIGINAL", "MODIFIED"])
    }
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("Desktop Git diff keeps display controls in the patch pane and copies a path without changing files", async () => {
  prepareImplementedSurface()
  sceneRead = call => call.route === "/api/vcs/diff" ? { location, data: ["src/a.ts", "src/b.ts"].map(file => ({ file, patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" })) } : undefined
  const page = await openReference()
  try {
    await command(page, "Git working-tree diff")
    await wait(page, `document.querySelector('dialog[open] .desktop-diff__file')`)
    expect(await page.evaluate(`(() => { const dialog = document.querySelector('dialog[open]'), nav = dialog.querySelector('nav[aria-label="Changed files"]'), tools = dialog.querySelector('[aria-label="Diff display controls"]'), footer = dialog.querySelector('footer'); if (!tools || !footer) return false; const d = dialog.getBoundingClientRect(), h = dialog.querySelector('.desktop-dialog__head').getBoundingClientRect(), n = nav.getBoundingClientRect(), t = tools.getBoundingClientRect(), f = footer.getBoundingClientRect(); return d.width === 1080 && d.height === 720 && h.height === 57 && n.width === 340 && Math.abs(n.top - h.bottom) <= 1 && t.left >= n.right && Math.abs(f.bottom - (d.bottom - 1)) <= 1 && !nav.querySelector('input, [role="radio"], [role="combobox"]') && !/review|Working tree|Branch/.test(nav.textContent); })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => { const row = document.querySelector('dialog[open] nav button[aria-label="src/a.ts"]'); return row.textContent.includes('a.ts') && row.querySelector('small')?.textContent === 'src' && [...row.querySelectorAll('.ws-add, .ws-del')].map(element => element.textContent).join(' ') === '+1 −1'; })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`document.querySelector('dialog[open] footer').textContent`, decodeString)).toContain("Read-only")
    await clickText(page, 'dialog[open] footer button', "Copy path")
    await wait(page, `document.querySelector('dialog[open] footer')?.textContent.includes('Copied path')`)
    expect(clipboard).toEqual(["src/a.ts"])
    await page.evaluate(`document.querySelector('dialog[open] nav button[aria-label="src/b.ts"]').click()`)
    clipboardFailure = true
    await clickText(page, 'dialog[open] footer button', "Copy path")
    await wait(page, `document.querySelector('dialog[open] footer [role="alert"]')?.textContent.includes('Synthetic clipboard unavailable')`)
    expect(clipboard).toEqual(["src/a.ts"])
    clipboardFailure = false
    await clickText(page, 'dialog[open] footer button', "Copy path")
    await wait(page, `document.querySelector('dialog[open] footer')?.textContent.includes('Copied path') && !document.querySelector('dialog[open] footer [role="alert"]')`)
    expect(clipboard).toEqual(["src/a.ts", "src/b.ts"])
    await clickText(page, 'dialog[open] footer button', "Done")
    await wait(page, `!document.querySelector('dialog[open]')`)
    expect(owned!.calls.filter(call => call.method !== "GET" && !call.route.endsWith("/web-latency"))).toEqual([])
    expect(await page.evaluate(`window.__desktopFixture.errors`, decodeArray((value: unknown) => value))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity marks diff files reviewed and preserves display controls without changing files", async () => {
  pending = false
  let replacement = "new"
  sceneRead = call => call.route === "/api/vcs/diff" ? { location, data: ["a.ts", "b.ts"].map(file => ({ file, patch: `@@ -1 +1 @@\n-old\n+${replacement}`, additions: 1, deletions: 1, status: "modified" })) } : undefined
  const page = await open()
  try {
    await command(page, "Git working-tree diff")
    await wait(page, `document.querySelector('dialog[open] button[aria-label="Mark reviewed: a.ts"]')`)
    await settleR7(page)
    expect(await page.evaluate(`document.querySelector('dialog[open] nav[aria-label="Changed files"] h3')?.textContent`, decodeString)).toBe("Changed files")
    expect(await page.evaluate(`[...document.querySelector('dialog[open] nav button[aria-label="a.ts"]').querySelectorAll('.ws-add, .ws-del')].map(element => element.textContent)`, decodeArray(decodeString))).toEqual(["+1", "−1"])
    expect(await page.evaluate(`(() => { const file = document.querySelector('dialog[open] nav button[aria-label="a.ts"]'); return file.getAttribute('aria-current') === 'true' && parseFloat(getComputedStyle(file).borderInlineStartWidth) >= 2; })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`['added', 'removed'].every((kind, index) => getComputedStyle(document.querySelector('dialog[open] .desktop-diff__unified [data-kind="' + kind + '"] code')).color === getComputedStyle(document.querySelector('dialog[open] .desktop-diff__file .' + ['ws-add', 'ws-del'][index])).color)`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => { const header = document.querySelector('dialog[open] header').getBoundingClientRect(); const file = document.querySelector('dialog[open] nav[aria-label="Changed files"] button[aria-label="a.ts"]').getBoundingClientRect(); return file.top >= header.bottom && file.top <= header.bottom + 64; })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => { const header = document.querySelector('dialog[open] header').getBoundingClientRect(); const tree = document.querySelector('dialog[open] nav[aria-label="Changed files"]').getBoundingClientRect(); return Math.abs(tree.top - header.bottom) <= 1 && tree.width === 340; })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => { const tree = document.querySelector('dialog[open] nav[aria-label="Changed files"]').getBoundingClientRect(); const patches = document.querySelector('dialog[open] [aria-label="File patches"]').getBoundingClientRect(); return Math.abs(tree.right - patches.left) <= 1 && Math.abs(tree.top - patches.top) <= 1; })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`document.querySelectorAll('dialog[open] button[aria-label="Mark reviewed: a.ts"]').length`, decodeNumber)).toBe(1)
    expect(await page.evaluate(`document.querySelectorAll('dialog[open] button[aria-label="Mark reviewed: b.ts"]').length`, decodeNumber)).toBe(1)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="status"]')].map(element => element.textContent).filter(text => /^\\d+ reviewed$/.test(text))`, decodeArray(decodeString))).toEqual(["0 reviewed"])
    expect(await page.evaluate(`document.querySelector('dialog[open] footer').textContent.includes('Working tree · Branch: synthetic')`, decodeBoolean)).toBe(true)
    await page.evaluate(`document.querySelector('dialog[open] button[aria-label="Mark reviewed: a.ts"]').click()`)
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('1 reviewed')`)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="status"]')].map(element => element.textContent).filter(text => /^\\d+ reviewed$/.test(text))`, decodeArray(decodeString))).toEqual(["1 reviewed"])
    expect(await page.evaluate(`document.querySelectorAll('dialog[open] button[aria-label="Mark unreviewed: a.ts"][aria-pressed="true"]').length`, decodeNumber)).toBe(1)
    const reads = await page.evaluate(`window.__desktopFixture.completed.vcsDiff`, decodeNumber)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] header button')].find(button => button.textContent === 'Refresh').click()`)
    await wait(page, `window.__desktopFixture.completed.vcsDiff > ${reads} && ![...document.querySelectorAll('dialog[open] header button')].find(button => button.textContent === 'Refresh').disabled`)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="status"]')].find(element => /^\\d+ reviewed$/.test(element.textContent)).textContent`, decodeString)).toBe("1 reviewed")
    await page.evaluate(`[...document.querySelectorAll('dialog[open] nav[aria-label="Changed files"] button')].find(button => button.textContent.includes('b.ts')).click()`)
    await wait(page, `document.querySelector('dialog[open] button[aria-label="Mark reviewed: b.ts"]')`)
    await page.evaluate(`(() => { [...document.querySelectorAll('dialog[open] [role="radio"]')].find(button => button.textContent === 'Split').click(); const labels = [...document.querySelectorAll('dialog[open] label')]; labels.find(label => label.textContent === 'Wrap diff lines').querySelector('input').click(); labels.find(label => label.textContent === 'Show selected file only').querySelector('input').click(); })()`)
    await wait(page, `document.querySelector('dialog[open] .desktop-diff').dataset.view === 'split' && document.querySelectorAll('dialog[open] .desktop-diff__file').length === 1`)
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.diffs'))`)).toEqual({ view: "split", wrap: "none", tree: true, single: true })
    expect(await page.evaluate(`getComputedStyle(document.querySelector('dialog[open] .desktop-diff__split')).display`, decodeString)).toBe("table")
    expect(await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="status"]')].find(element => /^\\d+ reviewed$/.test(element.textContent)).textContent`, decodeString)).toBe("1 reviewed")
    await clickText(page, 'dialog[open] button[aria-label="Mark reviewed: b.ts"]', 'Mark reviewed')
    await wait(page, `document.querySelector('dialog[open] .desktop-diff')?.textContent.includes('2 reviewed')`)
    const changedReads = await page.evaluate(`window.__desktopFixture.completed.vcsDiff`, decodeNumber)
    replacement = "updated"
    await clickText(page, 'dialog[open] header button', 'Refresh')
    await wait(page, `window.__desktopFixture.completed.vcsDiff > ${changedReads} && document.querySelector('dialog[open] .desktop-diff')?.textContent.includes('updated')`)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="status"]')].find(element => /^\\d+ reviewed$/.test(element.textContent)).textContent`, decodeString)).toBe("0 reviewed")
    await clickText(page, 'dialog[open] button[aria-label="Mark reviewed: a.ts"]', 'Mark reviewed')
    await wait(page, `document.querySelector('dialog[open] .desktop-diff')?.textContent.includes('1 reviewed')`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="radio"]')].find(button => button.textContent === 'Branch').click()`)
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('0 reviewed')`)
    await page.evaluate(`document.querySelector('dialog[open] nav button[aria-label="b.ts"]').click()`)
    expect(await page.evaluate(`document.querySelectorAll('dialog[open] button[aria-label="Mark reviewed: b.ts"]').length`, decodeNumber)).toBe(1)
    await clickText(page, 'dialog[open] button[aria-label="Mark reviewed: b.ts"]', 'Mark reviewed')
    await wait(page, `document.querySelector('dialog[open] .desktop-diff')?.textContent.includes('1 reviewed')`)
    await page.pressEscape()
    await wait(page, `!document.querySelector('dialog[open]')`)
    await command(page, "Git working-tree diff")
    await wait(page, `document.querySelector('dialog[open] .desktop-diff')?.textContent.includes('0 reviewed')`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.diffs')`); await page.close() }
}, 30_000)

test("rendered parity retains readable patches and review controls across a long changed-file list", async () => {
  pending = false
  sceneRead = call => call.route === "/api/vcs/diff" ? { location, data: Array.from({ length: 23 }, (_, index) => ({ file: `src/file-${index}.ts`, patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" })) } : undefined
  const page = await open()
  try {
    await command(page, "Git working-tree diff")
    await wait(page, `document.querySelectorAll('dialog[open] .desktop-diff__file').length === 23`)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog[open] .desktop-diff__file')].every(file => { const row = file.getBoundingClientRect(); const review = file.querySelector('button').getBoundingClientRect(); const patch = [...file.querySelectorAll('table')].find(table => table.getClientRects().length)?.getBoundingClientRect(); return patch && review.top >= row.top && review.bottom <= row.bottom && patch.top >= row.top && patch.bottom <= row.bottom && patch.height > 0; })`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => { const patches = document.querySelector('dialog[open] [aria-label="File patches"]'); return patches.scrollHeight > patches.clientHeight && document.documentElement.scrollWidth <= innerWidth; })()`, decodeBoolean)).toBe(true)
    expect(owned!.calls.filter(call => call.method !== "GET")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity gives conditional Family Review fields stable errors and locks them during submission", async () => {
  formReview = true
  const decision = Promise.withResolvers<void>()
  decideGate = decision.promise
  const page = await open()
  try {
    await wait(page, `document.querySelector('[aria-label="Reviewed answer"]')`)
    await page.evaluate(`[...document.querySelectorAll('.request button')].find(button => button.textContent === 'Send answer').click()`)
    expect(await page.evaluate(`document.querySelector('[aria-label="Reviewed answer"]').getAttribute('aria-describedby')`)).toBe("rvw_synthetic-2-error")
    expect(await page.evaluate(`document.querySelector('#rvw_synthetic-2-error').textContent`)).toBe("Required.")
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="Reviewed answer"]'); input.value = 'Reviewed synthetic answer'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); [...document.querySelectorAll('.request button')].find(button => button.textContent === 'Send answer').click(); })()`)
    await wait(page, `document.querySelector('[aria-label="Reviewed answer"]').matches(':disabled')`)
    decision.resolve()
    await wait(page, `!document.querySelector('[aria-label="Reviewed answer"]')`)
    expect(owned!.calls.filter((call) => call.route.endsWith("/decide")).map((call) => call.body)).toEqual([{ decision: { kind: "question", answers: { details: true, answer: "Reviewed synthetic answer" } } }])
  } finally { decision.resolve(); await page.close() }
}, 30_000)

async function delivery(page: Page, index: number) {
  await page.evaluate(`document.querySelector('[aria-label="Send mode"]').focus()`)
  await page.pressKey("ArrowDown", "ArrowDown", 40)
  await page.pressKey("Home", "Home", 36)
  for (let i = 0; i < index; i++) await page.pressKey("ArrowDown", "ArrowDown", 40)
  await page.pressKey("Enter", "Enter", 13, "\r")
}

test("rendered directory filters use canonical running Sessions and waiting family roots", async () => {
  directoryStatus = true
  const page = await open()
  try {
    await page.navigate(`${origin}/#/sessions`)
    await wait(page, `document.body.innerText.includes('Server-reported status and current live events')`)
    await page.evaluate(`[...document.querySelectorAll('main[data-surface="sessions"] button')].find(button => /^Running(?:\\s|$)/.test(button.textContent.trim())).click()`)
    await wait(page, `document.querySelector('main').innerText.includes(${JSON.stringify(unbroken)}) && !document.querySelector('main').innerText.includes(${JSON.stringify(title)})`)
    await page.evaluate(`[...document.querySelectorAll('main[data-surface="sessions"] button')].find(button => /^Waiting(?:\\s|$)/.test(button.textContent.trim())).click()`)
    await wait(page, `document.querySelector('main').innerText.includes(${JSON.stringify(title)}) && !document.querySelector('main').innerText.includes(${JSON.stringify(unbroken)})`)
    expect(await page.evaluate(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered global MCP forms submit at their bound location without sending a prompt", async () => {
  globalFormPending = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('section[aria-label="Global MCP forms"] input')`)
    await page.evaluate(`(() => { const input = document.querySelector('section[aria-label="Global MCP forms"] input'); input.value = 'Synthetic choice'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); document.querySelector('section[aria-label="Global MCP forms"] button[type="submit"]').click(); })()`)
    await wait(page, `!document.querySelector('section[aria-label="Global MCP forms"]')`)
    const posts = owned!.calls.filter((call) => call.method === "POST")
    expect(posts.map((call) => call.route)).toEqual(["/api/session/global/form/frm_synthetic/reply"])
    expect(JSON.stringify(posts[0]!.body)).toContain("Synthetic choice")
    expect(await page.evaluate(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered consented client timings batch real admission and transcript measurements without draft content", async () => {
  telemetryConsent = true
  const page = await open()
  try {
    await wait(page, `window.__desktopFixture.completed.telemetryConsent >= 1`)
    await page.evaluate(`window.__desktopFixture.resync()`)
    await message(page, "Synthetic timing draft that must not appear in diagnostics")
    await page.evaluate(`document.querySelector('.rl-capsule textarea').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `window.__desktopFixture.completed.appendTelemetry >= 1`)
    const batches = owned!.calls.filter((call) => call.method === "POST" && call.route === "/api/server/web-latency")
    expect(batches).toHaveLength(1)
    const payload = JSON.stringify(batches[0]!.body)
    expect(payload).toContain('"surface":"web"')
    expect(payload).toContain('"metric":"prompt.admit"')
    expect(payload).toContain('"metric":"transcript.load"')
    expect(payload).not.toContain("Synthetic timing draft")
    expect(payload).not.toContain("/synthetic/repo")
    expect(await page.evaluate(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered rail titles keep two visible lines, complete names and keyboard-operated Pin controls", async () => {
  const page = await open()
  try {
    await page.evaluate(`['ses_test','ses_other'].forEach(sessionID => window.__desktopFixture.emit({ type: 'permission.asked', data: { sessionID, id: 'prm_' + sessionID } }))`)
    await wait(page, `document.querySelectorAll('.rl-session-row[data-state="waiting"]').length === 2`)
    const geometry = await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.rl-nav .workspace__row')], rail = document.querySelector('.rl-nav-scroll');
      const titles = rows.map(row => row.querySelector('.rl-session-row-title'));
      const rects = rows.map(row => { const title = row.querySelector('.rl-session-row-title'), status = row.querySelector('.rl-rail-status'), pin = row.querySelector('.workspace__pin'); return { row: row.getBoundingClientRect(), title: title.getBoundingClientRect(), status: status.getBoundingClientRect(), pin: pin.getBoundingClientRect(), line: parseFloat(getComputedStyle(title).lineHeight) }; });
      return { contained: rects.every(r => r.title.left >= r.row.left && r.title.right <= r.row.right && r.title.bottom <= r.row.bottom && r.status.left >= r.row.left && r.status.right <= r.row.right && r.status.bottom <= r.row.bottom && r.pin.right <= r.row.right), separate: rects.every(r => r.status.right <= r.title.left + 1 && r.status.right <= r.pin.left + 1), clamped: rects.every(r => r.title.height > r.line && r.title.height <= r.line * 2 && r.row.height >= r.title.height), overflow: rail.scrollWidth > rail.clientWidth, fullText: ${JSON.stringify([title, unbroken])}.every(expected => titles.some(node => node.textContent === expected && node.closest('a').getAttribute('aria-label') === expected + ', Waiting')) };
    })()`, (value: unknown) => { const result = decodeRecord(value); return { contained: (decodeBoolean)(result["contained"]), separate: (decodeBoolean)(result["separate"]), clamped: (decodeBoolean)(result["clamped"]), overflow: (decodeBoolean)(result["overflow"]), fullText: (decodeBoolean)(result["fullText"]) } })
    expect(geometry).toEqual({ contained: true, separate: true, clamped: true, overflow: false, fullText: true })
    await page.evaluate(`document.querySelector('.rl-session-row[aria-current="page"]').focus()`)
    await page.pressKey("Tab", "Tab", 9)
    expect(await page.evaluate(`document.activeElement.matches('.workspace__pin')`)).toBe(true)
    await wait(page, `Number(getComputedStyle(document.activeElement).opacity) === 1`)
    expect(await page.evaluate(`document.activeElement.matches('.workspace__pin') && getComputedStyle(document.activeElement).visibility === 'visible' && Number(getComputedStyle(document.activeElement).opacity) === 1 && getComputedStyle(document.querySelector('.rl-session-row[aria-current="page"] .rl-rail-status')).visibility === 'visible'`)).toBe(true)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.workspace__pin[aria-label^="Unpin "]')`)
    expect(owned!.calls.filter((call) => call.method === "POST" && call.route.endsWith("/pin")).map((call) => call.route)).toEqual(["/api/session/ses_test/pin"])
  } finally { await page.close() }
}, 30_000)

test("scrolling and streamed content do not measure every retained prompt or refresh captured files", async () => {
  const page = await open()
  try {
    await page.evaluate(`window.__promptReads = 0; const read = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function() { if (this.matches('.transcript__turn[data-speaker="user"]')) window.__promptReads++; return read.call(this); }`)
    const point = await page.evaluate(`(() => { const rect = document.querySelector('.conversation__scroll').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, x: (decodeNumber)(record["x"]), y: (decodeNumber)(record["y"]) } })
    await page.wheel(point.x, point.y, 0, -1200)
    await wait(page, `document.querySelector('.conversation__scroll').scrollTop < document.querySelector('.conversation__scroll').scrollHeight - document.querySelector('.conversation__scroll').clientHeight - 100`)
    const files = owned!.calls.filter((call) => call.route.endsWith("/file-change")).length
    replyText = "Updated synthetic streaming response"
    await page.evaluate(`Array.from({length: 50}, (_, index) => window.__desktopFixture.emit({ type: index % 2 ? 'session.text.delta' : 'session.reasoning.delta', data: { sessionID: 'ses_test', assistantMessageID: 'msg_response', ordinal: 0, delta: 'synthetic' } }))`)
    await wait(page, `document.querySelector('#turn-msg_response').textContent.includes('Updated synthetic streaming response')`)
    expect(owned!.calls.filter((call) => call.route.endsWith("/file-change"))).toHaveLength(files)
    expect(await page.evaluate(`window.__promptReads`)).toBeLessThan(12)
  } finally { await page.close() }
}, 30_000)

test("older history keeps its reading position and survives a newest-window stream refresh", async () => {
  const page = await open()
  try {
    expect(await page.evaluate(`!!document.querySelector('#turn-msg_prompt_141') && !document.querySelector('#turn-msg_prompt_140')`)).toBe(true)
    await page.evaluate(`const scroll = document.querySelector('.conversation__scroll'); scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll'));`)
    const anchor = await page.evaluate(`document.querySelector('#turn-msg_prompt_141').getBoundingClientRect().top`, decodeNumber)
    await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Load older messages').click()`)
    await wait(page, `document.querySelector('#turn-msg_prompt_41') && [...document.querySelectorAll('button')].some(button => button.textContent === 'Load older messages')`)
    expect(Math.abs(await page.evaluate(`document.querySelector('#turn-msg_prompt_141').getBoundingClientRect().top`, decodeNumber) - anchor)).toBeLessThan(3)
    replyText = "Updated response after loading older history"
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.text.delta', data: { sessionID: 'ses_test', assistantMessageID: 'msg_response', ordinal: 0, delta: 'synthetic' } })`)
    await wait(page, `document.querySelector('#turn-msg_response').textContent.includes('Updated response after loading older history')`)
    expect(await page.evaluate(`!!document.querySelector('#turn-msg_prompt_41')`)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Load older messages').click()`)
    await wait(page, `document.querySelector('#turn-msg_prompt_0') && ![...document.querySelectorAll('button')].some(button => button.textContent === 'Load older messages')`)
    expect(owned!.calls.filter((call) => call.route.endsWith('/snapshot') && call.query.has('before')).map((call) => call.query.get('before'))).toEqual(["141", "41"])
    expect(owned!.calls.filter((call) => call.route.endsWith('/message'))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("prompt assistance confirms generation and stages a goal draft without sending it or changing the goal", async () => {
  const page = await open()
  try {
    await command(page, "Open shell, editor context, side-chat and prompt tools")
    await wait(page, `document.querySelector('.desktop-dialog textarea')`)
    await page.evaluate(`(() => { const input = document.querySelector('.desktop-dialog textarea'); input.value = 'Check the synthetic change'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); [...document.querySelectorAll('.desktop-dialog [role="radio"]')].find(button => button.textContent.trim() === 'Goal').click(); [...document.querySelectorAll('.desktop-dialog button')].find(button => button.textContent === 'Generate prompt draft').click(); })()`)
    await wait(page, `document.querySelector('.confirm[open]')`)
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
    await page.evaluate(`[...document.querySelectorAll('.confirm button')].find(button => button.textContent.trim() === 'Confirm').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.desktop-dialog').textContent.includes('Generated synthetic draft')`)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([["/api/session/ses_test/prompt-generate", { mode: "goal", intent: "Check the synthetic change", memory: [] }]])
    await page.evaluate(`[...document.querySelectorAll('.desktop-dialog button')].find(button => button.textContent === 'Use draft in composer').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!document.querySelector('.desktop-dialog[open]') && document.querySelector('.rl-capsule textarea').value === '/goal Generated synthetic draft'`)
    expect(owned!.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  } finally { await page.close() }
}, 30_000)

test("saved command shortcuts update key dispatch and accessible hints after a reload", async () => {
  pending = false
  const page = await open()
  try {
    await page.navigate(`${origin}/#/settings`)
    await wait(page, `document.querySelector('[aria-label="Keyboard shortcuts"] input')`)
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="Keyboard shortcuts"] input'); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true })); })()`)
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.keybindings'))`)).toEqual({ palette: { key: "J", modifier: "primary" } })
    await page.navigate(`${origin}/#/sessions/ses_test`)
    await wait(page, `document.querySelector('.desktop__palette')?.getAttribute('aria-keyshortcuts')?.endsWith('+J')`)
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true }))`)
    await wait(page, `document.querySelector('.palette__input')`)
    await page.pressKey("Escape", "Escape", 27)
    await wait(page, `!document.querySelector('.palette__input')`)
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true }))`)
    expect(await page.evaluate(`!!document.querySelector('.palette__input')`)).toBe(false)
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.keybindings')`); await page.close() }
}, 30_000)

test("saved Session display choices expand reasoning, separate tool calls and remember the companion", async () => {
  presentationParts = true
  const page = await open()
  const session = `${origin}/#/sessions/ses_test`
  const choose = (group: string, option: string) => page.evaluate(`[...document.querySelector('[role="radiogroup"][aria-label="${group}"]').querySelectorAll('[role="radio"]')].find(radio => radio.textContent === '${option}').click()`)
  try {
    await page.navigate(session)
    await wait(page, `document.querySelectorAll('.transcript-tools__button').length === 1 && !!document.querySelector('.transcript-reasoning')`)
    expect(await page.evaluate(`document.querySelector('.transcript-reasoning').open`, decodeBoolean)).toBe(false)
    expect(await page.evaluate(`document.querySelector('.transcript-reasoning summary').getAttribute('aria-expanded')`, decodeString)).toBe("false")
    await page.evaluate(`document.querySelector('.transcript-reasoning summary').focus({ preventScroll: true })`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.transcript-reasoning summary').getAttribute('aria-expanded') === 'true'`)
    expect(await page.evaluate(`(() => { const button = document.querySelector('.transcript-reasoning summary'); const panel = document.getElementById(button.getAttribute('aria-controls')); return document.activeElement === button && panel && !panel.inert && panel.getAttribute('aria-hidden') === 'false' && panel.textContent.trim() === 'Synthetic reasoning summary'; })()`, decodeBoolean)).toBe(true)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.transcript-reasoning summary').getAttribute('aria-expanded') === 'false'`)
    await settleR7(page)
    expect(await page.evaluate(`(() => { const button = document.querySelector('.transcript-reasoning summary'); const panel = document.getElementById(button.getAttribute('aria-controls')); return document.activeElement === button && !document.querySelector('.transcript-reasoning').open && (!panel || panel.inert && panel.getAttribute('aria-hidden') === 'true'); })()`, decodeBoolean)).toBe(true)
    await page.navigate(`${origin}/#/settings`)
    await wait(page, `document.querySelector('[aria-label="Session display"] [role="radiogroup"][aria-label="Tool calls"]')`)
    await choose("Reasoning", "Expanded")
    await choose("Tool calls", "Show each call separately")
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.presentation'))`)).toEqual({ thinking: "show", grouping: "none", companion: "hide" })
    await page.navigate(session)
    await wait(page, `document.querySelectorAll('.transcript-tools__button').length === 2 && document.querySelector('.transcript-reasoning')?.open === true`)
    expect(await page.evaluate(`(() => { const button = document.querySelector('.transcript-reasoning summary'); const panel = document.getElementById(button.getAttribute('aria-controls')); return button.getAttribute('aria-expanded') === 'true' && panel && !panel.inert && panel.getAttribute('aria-hidden') === 'false' && panel.textContent.trim() === 'Synthetic reasoning summary'; })()`, decodeBoolean)).toBe(true)
    await page.evaluate(`document.querySelector('.rl-companion-toggle').click()`)
    await wait(page, `!!document.querySelector('.rl-companion')`)
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.presentation')).companion`)).toBe("auto")
    await page.evaluate(`document.querySelector('.rl-companion-toggle').click()`)
    await wait(page, `!document.querySelector('.rl-companion')`)
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.presentation')).companion`)).toBe("hide")
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.presentation')`); await page.close() }
}, 30_000)

test("attention settings persist independent sound and native notification choices at the selected volume", async () => {
  const page = await open()
  const settings = `${origin}/#/settings`
  try {
    await page.navigate(settings)
    await wait(page, `document.querySelector('[data-action-id="st-open-notifications"]')`)
    await page.evaluate(`document.querySelector('[data-action-id="st-open-notifications"]').click()`)
    await wait(page, `[...document.querySelectorAll('label')].some(label => label.textContent === 'Enable attention')`)
    await page.evaluate(`(() => { const labels = [...document.querySelectorAll('label')]; labels.find(label => label.textContent === 'Enable attention').querySelector('input').click(); labels.find(label => label.textContent === 'Native attention notifications').querySelector('input').click(); const volume = labels.find(label => label.textContent === 'Sound volume (%)').querySelector('input'); volume.value = '25'; volume.dispatchEvent(new Event('change', { bubbles: true })); window.__desktopFixture.emit({ type: 'permission.asked', data: { sessionID: 'ses_test', id: 'per_audio_one' } }); })()`)
    await wait(page, `window.__desktopFixture.sounds.length === 1`)
    expect(await page.evaluate(`window.__desktopFixture.sounds.map(sound => ({ volume: sound.volume, permission: sound.src.endsWith('/staplebops-06.mp3') }))`)).toEqual([{ volume: 0.25, permission: true }])
    expect(notifications).toEqual([])
    await page.navigate(`${origin}/?reload=settings#/settings`)
    await wait(page, `document.querySelector('[data-action-id="st-open-notifications"]')`)
    await page.evaluate(`document.querySelector('[data-action-id="st-open-notifications"]').click()`)
    await wait(page, `[...document.querySelectorAll('label')].some(label => label.textContent === 'Sound volume (%)')`)
    expect(await page.evaluate(`(() => { const labels = [...document.querySelectorAll('label')]; return { enabled: labels.find(label => label.textContent === 'Enable attention').querySelector('input').checked, notifications: labels.find(label => label.textContent === 'Native attention notifications').querySelector('input').checked, volume: labels.find(label => label.textContent === 'Sound volume (%)').querySelector('input').value }; })()`)).toEqual({ enabled: true, notifications: false, volume: "25" })
  } finally {
    await page.evaluate(`['attention', 'notifications', 'notification-sound', 'notification-volume'].forEach(name => localStorage.removeItem('ycoding.desktop.' + name))`)
    await page.close()
  }
}, 30_000)

test("process controls answer the current child question and continue only its issued recovery review", async () => {
  processControls = true
  const page = await open()
  try {
    await command(page, "Manage Session shells and subagents")
    await wait(page, `document.querySelector('.desktop-dialog textarea')`)
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
    await page.evaluate(`(() => { const dialog = document.querySelector('.desktop-dialog'); const input = dialog.querySelector('textarea'); input.value = 'Synthetic accepted response'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Answer subagent').click(); })()`)
    await confirm(page)
    await wait(page, `!document.querySelector('.desktop-dialog textarea')`)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([["/api/session/ses_test/subagent/ses_child/question/qst_synthetic/answer", { text: "Synthetic accepted response" }]])
    await command(page, "Manage Session shells and subagents")
    await wait(page, `[...document.querySelectorAll('.desktop-dialog button')].some(button => button.textContent === 'Continue stopped subagent')`)
    await page.evaluate(`[...document.querySelectorAll('.desktop-dialog button')].find(button => button.textContent === 'Continue stopped subagent').click()`)
    await confirm(page)
    await wait(page, `![...document.querySelectorAll('.desktop-dialog button')].some(button => button.textContent === 'Continue stopped subagent')`)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([["/api/session/ses_test/subagent/ses_child/question/qst_synthetic/answer", { text: "Synthetic accepted response" }], ["/api/session/ses_child/review/rvw_recovery/decide", { decision: { kind: "recovery", choice: "continue" } }]])
  } finally { await page.close() }
}, 30_000)

test("a Family Review answer travels from rendered controls through RPC and Client to its owning child once", async () => {
  const page = await open()
  try {
    await wait(page, `document.querySelector('.request form')`)
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
    await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('.request')].find(card => card.textContent.includes('Choose synthetic targets'));
      for (const name of ['Preview','Local']) [...card.querySelectorAll('label')].find(label => label.textContent.includes(name)).querySelector('input').click();
      const details = [...card.querySelectorAll('fieldset')].find(field => field.querySelector('legend').textContent === 'Details').querySelector('input'); details.value = 'Synthetic free text'; details.dispatchEvent(new InputEvent('input', { bubbles: true }));
      card.querySelector('button[type="submit"]').focus();
    })()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!document.querySelector('.request form')`)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([
      ["/api/session/ses_child/review/rvw_synthetic/decide", { decision: { kind: "question", answers: [["Preview", "Local"], ["Synthetic free text"]] } }],
    ])
  } finally { await page.close() }
}, 30_000)

test("a child review settled elsewhere disappears from the open parent inbox without submitting an answer", async () => {
  const page = await open()
  try {
    await wait(page, `document.querySelector('.request form')`)
    const reads = owned!.calls.filter((call) => call.method === "GET" && call.route === "/api/session/ses_test/review").length
    pending = false
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.review.decided', durable: { aggregateID: 'ses_child', seq: 1001, version: 1 }, data: { sessionID: 'ses_child', itemID: 'rvw_synthetic', decision: { kind: 'question', answers: [['Local'], ['Settled elsewhere']] } } })`)
    await wait(page, `!document.querySelector('.request form')`)
    expect(owned!.calls.filter((call) => call.method === "GET" && call.route === "/api/session/ses_test/review").length).toBeGreaterThan(reads)
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("full transcript copy and structured export reach the canonical backend and native delivery ports", async () => {
  const page = await open()
  try {
    await command(page, "Copy the full transcript")
    await wait(page, `document.body.textContent.includes('Copied the full transcript.')`)
    expect(clipboard).toHaveLength(1)
    expect(clipboard[0]).toContain("Synthetic prompt 0.")
    expect(clipboard[0]).toContain("Synthetic prompt 239.")
    expect(clipboard[0]).toContain(replyText)
    await command(page, "Export the transcript")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Export Session'`)
    await page.evaluate(`[...document.querySelectorAll('dialog [role="radio"]')].find(button => button.textContent === 'JSON').click(); [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Copy transcript').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('dialog').textContent.includes('Transcript copied to the clipboard.')`)
    const structured = JSON.parse(clipboard.at(-1)!)
    expect(structured.info.id).toBe("ses_test")
    expect(structured.messages).toHaveLength(241)
    expect(structured.messages[0].text).toContain("Synthetic prompt 0.")
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Save transcript…').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('dialog').textContent.includes('Saved to /synthetic/exports/')`)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.filename).toEndWith(".json")
    expect(JSON.parse(saved[0]!.content)).toEqual(structured)
    expect(owned!.calls.filter((call) => call.method === "GET" && call.route.endsWith("/message"))).toHaveLength(3)
  } finally { await page.close() }
}, 30_000)

test("rendered parity opens Appearance without changing the theme and scopes shortcut help and view toggles", async () => {
  const page = await open()
  try {
    const original = await page.evaluate(`document.documentElement.dataset.theme`)
    await command(page, "Choose a theme")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Appearance'`)
    expect(await page.evaluate(`document.documentElement.dataset.theme`)).toBe(original)
    expect(await page.evaluate(`(() => { const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }); document.querySelector('dialog [role="radio"]').dispatchEvent(event); return event.defaultPrevented || location.hash !== '#/sessions/ses_test'; })()`)).toBe(false)
    await page.evaluate(`[...document.querySelectorAll('dialog [role="radio"]')].find(button => button.textContent.trim() === 'Dark').click()`)
    await wait(page, `localStorage.getItem('ycoding.desktop.theme') === 'dark' && document.querySelector('dialog [role="radio"][aria-checked="true"]').textContent.trim() === 'Dark'`)
    await page.pressKey("Escape", "Escape", 27)
    await command(page, "Show commands and shortcuts")
    await wait(page, `document.querySelector('dialog[open]').textContent.includes('Ctrl+T') && document.querySelector('dialog[open]').textContent.includes('outside text fields')`)
    await page.pressKey("Escape", "Escape", 27)
    const collapsed = await page.evaluate(`document.querySelector('.workspace').getAttribute('data-collapsed')`)
    await command(page, "Toggle navigation rail")
    await wait(page, `document.querySelector('.workspace').getAttribute('data-collapsed') !== ${JSON.stringify(collapsed)}`)
    await command(page, "Toggle navigation rail")
    const companion = await page.evaluate(`document.querySelector('.workspace').getAttribute('data-companion-open')`)
    await command(page, "Toggle Session companion")
    await wait(page, `document.querySelector('.workspace').getAttribute('data-companion-open') !== ${JSON.stringify(companion)}`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered large pastes show a placeholder, copy, stash and restore their text and send the full text", async () => {
  const page = await open()
  const pasted = "line one\nline two @a.ts\nline three"
  const composer = `document.querySelector('.rl-capsule textarea')`
  try {
    await message(page, "Use @a.ts after ")
    await page.evaluate(`(() => { const input = ${composer}; input.focus(); input.setSelectionRange(input.value.length, input.value.length); const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(pasted)}); input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`)
    await wait(page, `${composer}.value === 'Use @a.ts after [Pasted ~3 lines]'`)
    expect(await page.evaluate(`(() => { const input = ${composer}; input.setSelectionRange(0, input.value.length); const data = new DataTransfer(); input.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })); return data.getData('text/plain'); })()`)).toBe(`Use @a.ts after ${pasted}`)
    await command(page, "Stash or restore the prompt")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Stash current draft').click()`)
    expect(await page.evaluate(`(() => { const { text, pasted } = JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))[0]; return { text, pasted }; })()`)).toEqual({ text: "Use @a.ts after [Pasted ~3 lines]", pasted: [{ label: "[Pasted ~3 lines]", text: pasted }] })
    await wait(page, `${composer}.value === ''`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Pop and restore').click()`)
    await wait(page, `!document.querySelector('dialog[open]') && ${composer}.value === 'Use @a.ts after [Pasted ~3 lines]'`)
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `${composer}.value === ''`)
    expect(owned!.calls.filter((call) => call.method === "POST" && call.route.endsWith("/prompt")).map((call) => call.body.text)).toEqual([`Use @a.ts after ${pasted}`])
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.prompt-stashes')`); await page.close() }
}, 30_000)

test("composer pastes text and a browser-owned image without requiring a host file path", async () => {
  const page = await open()
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6foAAAAASUVORK5CYII="
  try {
    await page.evaluate(`(() => {
      const input = document.querySelector('.rl-capsule textarea');
      const data = new DataTransfer();
      data.setData('text/plain', 'Describe the pasted image');
      data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png)}), c => c.charCodeAt(0))], 'clipboard.png', {type: 'image/png'}));
      input.focus();
      input.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
    })()`)
    await wait(page, `document.querySelector('[aria-label="Remove clipboard.png"]')`)
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`, decodeString)).toBe("Describe the pasted image")
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "composer-paste.png"), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`document.querySelector('.rl-capsule button[aria-label="Send prompt"]').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    expect(owned!.calls.filter(call => call.method === "POST" && call.route.endsWith("/prompt")).map(call => call.body.files)).toEqual([[{ name: "clipboard.png", uri: `data:image/png;base64,${png}` }]])
  } finally { await page.close() }
}, 30_000)

test("composer uses native clipboard text and image when a menu paste has no DOM payload", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6foAAAAASUVORK5CYII="
  pastedClipboard = { text: "Describe the native clipboard image", imageBase64: png, formats: ["text/plain", "image/png"] }
  const page = await open()
  try {
    await page.evaluate(`(() => { const input = document.querySelector('.rl-capsule textarea'); input.focus(); input.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true})); })()`)
    await wait(page, `document.querySelector('[aria-label="Remove Clipboard image.png"]') && document.querySelector('.rl-capsule textarea').value === 'Describe the native clipboard image'`)
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    expect(owned!.calls.filter(call => call.method === "POST" && call.route.endsWith("/prompt")).map(call => call.body.files)).toEqual([[{ name: "Clipboard image.png", uri: `data:image/png;base64,${png}` }]])
  } finally { await page.close() }
}, 30_000)

test("composer lights the drop target, accepts actual files and submits only retained chips", async () => {
  const page = await open()
  try {
    await message(page, "Review the retained notes")
    expect(await page.evaluate(`(() => {
      const data = new DataTransfer(); data.items.add(new File(['outside'], 'unused.txt', {type: 'text/plain'}));
      const event = new DragEvent('drop', {dataTransfer: data, bubbles: true, cancelable: true});
      document.querySelector('.rl-top').dispatchEvent(event);
      return event.defaultPrevented && !document.querySelector('[aria-label="Remove unused.txt"]');
    })()`, decodeBoolean)).toBe(true)
    expect(await page.evaluate(`(() => {
      const target = document.querySelector('.rl-capsule textarea');
      const data = new DataTransfer();
      data.items.add(new File(['keep'], 'remove.txt', {type: 'text/plain'}));
      data.items.add(new File(['keep'], 'notes.txt', {type: 'text/plain'}));
      window.__desktopTestDrop = data;
      target.dispatchEvent(new DragEvent('dragenter', {dataTransfer: data, bubbles: true, cancelable: true}));
      const over = new DragEvent('dragover', {dataTransfer: data, bubbles: true, cancelable: true});
      target.dispatchEvent(over);
      const feedback = document.querySelector('.rl-capsule').innerText.includes('Drop files to attach');
      return [over.defaultPrevented, feedback];
    })()`, decodeArray(decodeBoolean))).toEqual([true, true])
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "composer-drag-target.png"), Buffer.from(await page.screenshot(), "base64"))
    expect(await page.evaluate(`(() => { const drop = new DragEvent('drop', {dataTransfer: window.__desktopTestDrop, bubbles: true, cancelable: true}); document.querySelector('.rl-capsule textarea').dispatchEvent(drop); delete window.__desktopTestDrop; return drop.defaultPrevented; })()`, decodeBoolean)).toBe(true)
    await wait(page, `document.querySelector('[aria-label="Remove notes.txt"]') && document.querySelector('[aria-label="Remove remove.txt"]')`)
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "composer-dropped-files.png"), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`document.querySelector('.rl-capsule button[aria-label="Remove remove.txt"]').click()`)
    expect(await page.evaluate(`document.querySelector('.rl-capsule').innerText.includes('Drop files to attach')`, decodeBoolean)).toBe(false)
    await page.evaluate(`document.querySelector('.rl-capsule button[aria-label="Send prompt"]').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    expect(owned!.calls.filter(call => call.method === "POST" && call.route.endsWith("/prompt")).map(call => call.body.files)).toEqual([[{ name: "notes.txt", uri: "data:text/plain;base64,a2VlcA==" }]])
  } finally { await page.close() }
}, 30_000)

test("Team reveals the correct reported child from a table row and a keyboard-activated Grid card", async () => {
  prepareImplementedSurface()
  const now = Date.now()
  const tasks = ["first", "second"].map((name) => ({ sessionID: `ses_child_${name}`, parentID: "ses_test", description: `Review ${name} index`, agent: `worker-${name}`, state: "supervising", model: { ...selection(), variant: "high", profile: "review" }, background: true, revision: 1, time: { created: now - 120_000, updated: now }, progress: { text: `Complete ${name} progress summary`, time: now } }))
  sceneRead = call => call.route === "/api/session/ses_test/subagent" ? { data: tasks, summary: { total: 2, active: 2, running: 0, waiting: 0 }, cursor: {} } : undefined
  const page = await openReference()
  try {
    await clickText(page, '.rl-top button', "Team")
    await wait(page, `document.querySelectorAll('table[aria-label="Direct subagents"] tbody tr').length === 2`)
    await page.evaluate(`document.querySelectorAll('table[aria-label="Direct subagents"] tbody tr')[1].cells[1].click()`)
    const detail = `document.querySelector('[aria-label="Selected child"]')`
    expect(await page.evaluate(`${detail}.innerText`, decodeString)).toContain("Complete second progress summary")
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "team-table-selected.png"), Buffer.from(await page.screenshot(), "base64"))
    await clickText(page, '[data-team-view] button', "Grid")
    await page.evaluate(`[...document.querySelectorAll('[data-team-view] button')].find(item => item.getAttribute('aria-label')?.includes('worker-first')).focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `${detail}?.innerText.includes('Complete first progress summary')`)
    expect(await page.evaluate(`${detail}.innerText`, decodeString)).toContain("Complete first progress summary")
    expect(await page.evaluate(`${detail}.innerText`, decodeString)).toContain("Open Dedicated Child Session")
    if (process.env.YCODING_DESKTOP_CAPTURE_DIR) await Bun.write(path.join(process.env.YCODING_DESKTOP_CAPTURE_DIR, "team-grid-selected.png"), Buffer.from(await page.screenshot(), "base64"))
    await clickText(page, '[aria-label="Selected child"] button', "Open Dedicated Child Session")
    await wait(page, `location.hash.endsWith('/sessions/ses_child_first')`)
  } finally { await page.close() }
}, 30_000)

test("rendered parity sends Auto, Queue and step-boundary Steer with distinct captured admissions", async () => {
  const page = await open()
  try {
    for (const [index, mode] of ["auto", "queue", "steer"].entries()) {
      await delivery(page, index)
      await message(page, `Synthetic ${mode} delivery`)
      await page.evaluate(`document.querySelector('.rl-send').click()`)
      await wait(page, `document.querySelector('.rl-capsule textarea').value === '' && !document.querySelector('[aria-label="Send mode"]').disabled`)
    }
    const prompts = owned!.calls.filter((call) => call.method === "POST" && call.route.endsWith("/prompt"))
    expect(prompts.map((call) => call.body.delivery ?? "auto")).toEqual(["auto", "queue", "steer"])
    expect(new Set(prompts.map((call) => call.body.id)).size).toBe(3)
    expect(prompts.every((call) => !("steerNow" in call.body) && !("resume" in call.body))).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("rendered parity sends and steers now in admission, interruption and wake order", async () => {
  running = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('[aria-label="Send and steer now"]')`)
    await message(page, "Synthetic immediate steering")
    await page.evaluate(`document.querySelector('[aria-label="Send and steer now"]').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    const writes = owned!.calls.filter((call) => call.method !== "GET")
    expect(writes.map((call) => call.route)).toEqual(["/api/session/ses_test/prompt", "/api/session/ses_test/interrupt", "/api/session/ses_test/prompt"])
    expect(writes[0]!.body).toMatchObject({ text: "Synthetic immediate steering", delivery: "steer", resume: false })
    expect(writes[2]!.body).toEqual({ ...writes[0]!.body, resume: true })
  } finally { await page.close() }
}, 30_000)

test("rendered parity retains and locks an unconfirmed steer without waking or resubmitting it", async () => {
  running = true
  failInterrupt = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('[aria-label="Send and steer now"]')`)
    await message(page, "Synthetic retained steer")
    await page.evaluate(`document.querySelector('[aria-label="Send and steer now"]').click()`)
    await wait(page, `document.body.textContent.includes('will not interrupt or wake again')`)
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value === 'Synthetic retained steer' && document.querySelector('.rl-capsule textarea').readOnly && document.querySelector('[aria-label="Send mode"]').disabled && document.querySelector('.rl-send').disabled`)).toBe(true)
    await page.evaluate(`document.querySelector('.rl-send').click(); document.querySelector('[aria-label="Send and steer now"]').click()`)
    expect(owned!.calls.filter((call) => call.method !== "GET").map((call) => call.route)).toEqual(["/api/session/ses_test/prompt", "/api/session/ses_test/interrupt"])
  } finally { await page.close() }
}, 30_000)

test("rendered parity previews undo of an uncaptured message, restores its draft and clears the staged revert", async () => {
  const page = await open()
  try {
    await message(page, "/undo")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await confirm(page, "Cancel")
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
    expect(await page.evaluate(`document.querySelector('.rl-capsule textarea').value`)).toBe("/undo")
    await wait(page, `!document.querySelector('.confirm[open]') && !document.querySelector('.rl-send').disabled`)
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await confirm(page)
    await wait(page, `document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.') && !document.querySelector('#turn-msg_prompt_239')`)
    expect(await page.evaluate(`document.querySelector('[aria-label="Attached workspace files"]').textContent.includes('restored-notes.txt') && document.querySelector('[aria-label="Restored agent attachments"]').textContent.includes('reviewer')`)).toBe(true)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([["/api/session/ses_test/revert/stage", { messageID: "msg_prompt_239", files: true }]])
    await command(page, "Redo the undone turn")
    await confirm(page)
    await wait(page, `document.querySelector('#turn-msg_prompt_239') && !document.body.textContent.includes('Staged revert · preview and confirmation required')`)
    expect(owned!.calls.filter((call) => call.method !== "GET").map((call) => call.route)).toEqual(["/api/session/ses_test/revert/stage", "/api/session/ses_test/revert/clear"])
  } finally { await page.close() }
}, 30_000)

test("rendered parity stashes and restores file and agent attachments without sending a prompt", async () => {
  const page = await open()
  try {
    await message(page, "/undo")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await confirm(page)
    await wait(page, `document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.')`)
    await command(page, "/stash")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Stash current draft').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === '' && !document.querySelector('[aria-label="Attached workspace files"]') && !document.querySelector('[aria-label="Restored agent attachments"]')`)
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))[0].files.map(file => file.name)`)).toEqual(["restored-notes.txt"])
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))[0].agents`)).toEqual([{ name: "reviewer" }])
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Pop and restore').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!document.querySelector('dialog[open]') && document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.') && document.querySelector('[aria-label="Attached workspace files"]')?.textContent.includes('restored-notes.txt') && document.querySelector('[aria-label="Restored agent attachments"]')?.textContent.includes('reviewer')`)
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))`)).toEqual([])
    expect(owned!.calls.filter((call) => call.route.endsWith('/prompt'))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity stages reasoning while running and applies it before admitting the next message", async () => {
  running = true
  const page = await open()
  try {
    await command(page, "Choose a reasoning variant")
    await wait(page, `document.body.textContent.includes('Effort staged locally; not applied')`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
    await page.pressKey("Escape", "Escape", 27)
    running = false
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_test' } })`)
    await wait(page, `!document.querySelector('[aria-label="Stop"]')`)
    await message(page, "Use the staged synthetic effort")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    expect(owned!.calls.filter((call) => call.method !== "GET").map((call) => [call.route, call.body])).toEqual([
      ["/api/session/ses_test/model", { model: { id: "synthetic", providerID: "synthetic", variant: "low" } }],
      ["/api/session/ses_test/prompt", expect.objectContaining({ text: "Use the staged synthetic effort" })],
    ])
  } finally { await page.close() }
}, 30_000)

test("rendered parity archives and restores with confirmation and reports sharing unavailable without a write", async () => {
  const page = await open()
  try {
    await command(page, "Archive the Session")
    await confirm(page, "Cancel")
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
    await command(page, "Archive the Session")
    await confirm(page)
    await wait(page, `window.__desktopFixture.completed.manageSession === 1`)
    await command(page, "Restore the archived Session")
    await confirm(page)
    await wait(page, `window.__desktopFixture.completed.manageSession === 2`)
    await command(page, "Inspect Session sharing availability")
    await wait(page, `document.body.textContent.includes('Session sharing is unavailable')`)
    expect(owned!.calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.route])).toEqual([["POST", "/api/session/ses_test/archive"], ["DELETE", "/api/session/ses_test/archive"]])
  } finally { await page.close() }
}, 30_000)

test("rendered parity moves between parent and sibling Sessions and focuses a chosen timeline message", async () => {
  familyEnabled = true
  const page = await open()
  try {
    await command(page, "Open the next subagent")
    await wait(page, `location.hash === '#/sessions/ses_child_a' && document.querySelector('#conversation-title').textContent.includes('ses_child_a')`)
    await command(page, "Open the next subagent")
    await wait(page, `location.hash === '#/sessions/ses_child_b' && document.querySelector('#conversation-title').textContent.includes('ses_child_b')`)
    await command(page, "Open the parent Session")
    await wait(page, `location.hash === '#/sessions/ses_test' && document.querySelector('#turn-msg_prompt_141')`)
    await command(page, "Show the session timeline")
    await wait(page, `document.querySelector('dialog h2')?.textContent === 'Session timeline'`)
    await page.evaluate(`document.querySelector('dialog .desktop-dialog__entries li button').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.activeElement.id === 'turn-msg_prompt_141'`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity confirms compaction with a canonical job ID and forks from the selected timeline message", async () => {
  const page = await open()
  try {
    await command(page, "Compact the conversation")
    await confirm(page)
    await wait(page, `document.body.textContent.includes('Compaction requested.')`)
    const compact = owned!.calls.find((call) => call.method === "POST" && call.route.endsWith("/compact"))
    expect(compact?.body.id).toMatch(/^cmp_/)
    expect(compact?.body).not.toHaveProperty("promptID")
    await command(page, "Show the session timeline")
    await wait(page, `document.querySelector('dialog h2')?.textContent === 'Session timeline'`)
    await page.evaluate(`[...document.querySelector('dialog .desktop-dialog__entries li').querySelectorAll('button')].find(button => button.textContent === 'Fork from this message').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await confirm(page)
    await wait(page, `location.hash === '#/sessions/ses_fork'`)
    expect(owned!.calls.filter((call) => call.method === "POST" && call.route.endsWith("/fork")).map((call) => call.body)).toEqual([{ messageID: "msg_prompt_141" }])
  } finally { await page.close() }
}, 30_000)

test("rendered parity discards a file lookup after its mention closes and never exposes it in a later completion", async () => {
  const slow = Promise.withResolvers<void>(), slowReached = Promise.withResolvers<void>()
  const fast = Promise.withResolvers<void>(), fastReached = Promise.withResolvers<void>()
  fileGate = { query: "slow", reached: () => slowReached.resolve(), wait: slow.promise }
  const page = await open()
  try {
    await message(page, "@slow")
    await slowReached.promise
    await message(page, "Ordinary synthetic text")
    slow.resolve()
    await wait(page, `window.__desktopFixture.completed.findFiles === 1`)
    fileGate = { query: "fast", reached: () => fastReached.resolve(), wait: fast.promise }
    await message(page, "@fast")
    await fastReached.promise
    expect(await page.evaluate(`document.querySelector('.composer-suggestions')?.textContent.includes('src/slow.ts') ?? false`)).toBe(false)
    fast.resolve()
    await wait(page, `document.querySelector('.composer-suggestions')?.textContent.includes('src/fast.ts')`)
    expect(await page.evaluate(`document.querySelector('.composer-suggestions').textContent.includes('src/slow.ts')`)).toBe(false)
  } finally { slow.resolve(); fast.resolve(); fileGate = undefined; await page.close() }
}, 30_000)
