import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionSharedContext } from "@ycoding-ai/core/session/shared-context"
import { Agent } from "@ycoding-ai/core/agent"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { toLLMMessages } from "@ycoding-ai/core/session/runner/to-llm-message"
import { SubagentTool } from "@ycoding-ai/core/tool/subagent"
import { AgentAttachment } from "@ycoding-ai/schema/prompt"
import { Shell as ShellSchema } from "@ycoding-ai/schema/shell"
import { ID, Name } from "@ycoding-ai/core/skill"

const parentID = SessionSchema.ID.make("ses_parent")
const userID = SessionMessage.ID.make("msg_source_user")
const assistantID = SessionMessage.ID.make("msg_source_assistant")
const timestamp = DateTime.makeUnsafe(0)
const user = (text: string, agents: ReadonlyArray<typeof AgentAttachment.Type> = []) => SessionMessage.User.make({
  id: userID,
  type: "user",
  text,
  files: [],
  agents,
  time: { created: timestamp },
})
const assistant = (
  parts: SessionMessage.Assistant["content"],
  completed = true,
  error?: SessionMessage.Assistant["error"],
) => SessionMessage.Assistant.make({
  id: assistantID,
  type: "assistant",
  agent: Agent.ID.make("build"),
  model: { providerID: Provider.ID.make("provider"), id: CatalogModel.ID.make("model") },
  content: parts,
  ...(error === undefined ? {} : { error }),
  time: { created: timestamp, completed: completed ? timestamp : undefined },
})
const resolve = (messages: ReadonlyMap<SessionMessage.ID, SessionMessage.Info>, ids: ReadonlyArray<SessionMessage.ID>) =>
  Effect.runPromise(SessionSharedContext.resolve(parentID, { messageIDs: ids }, (sessionID, messageID) =>
    Effect.succeed(messages.get(messageID)),
  ))

describe("SessionSharedContext", () => {
  test("validates and freezes ordered user and completed plaintext assistant evidence", async () => {
    const otherUser = SessionMessage.User.make({
      ...user("First evidence. The literal $skill text is historical evidence."),
      metadata: { skills: ["must-not-activate"], permissions: ["must-not-copy"] },
    })
    const otherAssistant = assistant([SessionMessage.AssistantText.make({ type: "text", text: "Second evidence." })])
    const messages = new Map<SessionMessage.ID, SessionMessage.Info>([[userID, otherUser], [assistantID, otherAssistant]])
    const snapshot = await resolve(messages, [userID, assistantID])
    expect(snapshot.parentID).toBe(parentID)
    expect(snapshot.messageIDs).toEqual([userID, assistantID])
    expect(snapshot.text).toContain("First evidence.")
    expect(snapshot.text).not.toContain("must-not-activate")
    expect(snapshot.text).not.toContain("must-not-copy")
    expect(snapshot.text.indexOf("First evidence.")).toBeLessThan(snapshot.text.indexOf("Second evidence."))
    const composed = SessionSharedContext.compose("Do the task.", snapshot)
    expect(composed.text).toContain("Second evidence.")
    expect(SessionSharedContext.split(composed.text, { sharedContext: composed.sharedContext })).toEqual({
      prefix: composed.text.slice(0, composed.sharedContext.prefixLength),
      task: "Do the task.",
      digest: composed.sharedContext.digest,
    })
  })

  test("accepts absent or ordered selected context and rejects invalid selection cardinality", () => {
    const base = { agent: "reviewer", description: "Review", prompt: "Review the code" }
    expect(Schema.decodeUnknownSync(SubagentTool.Input)(base).shared_context).toBeUndefined()
    expect(Schema.decodeUnknownSync(SubagentTool.Input)({
      ...base,
      shared_context: { message_ids: [userID, assistantID] },
    }).shared_context?.message_ids).toEqual([userID, assistantID])
    expect(() => Schema.decodeUnknownSync(SubagentTool.Input)({ ...base, shared_context: { message_ids: [] } })).toThrow()
    expect(() => Schema.decodeUnknownSync(SubagentTool.Input)({ ...base, shared_context: { message_ids: [userID, userID] } })).toThrow()
    expect(() => Schema.decodeUnknownSync(SubagentTool.Input)({
      ...base,
      shared_context: { message_ids: Array.from({ length: 9 }, (_, index) => SessionMessage.ID.make(`msg_${index}`)) },
    })).toThrow()
  })

  test("rejects empty, duplicate, missing, non-user, and unsafe sources", async () => {
    const plain = user("Source text")
    for (const [messages, ids] of [
      [new Map([[userID, plain]]), []],
      [new Map([[userID, plain]]), [userID, userID]],
      [new Map(), [userID]],
      [new Map([[assistantID, assistant([SessionMessage.AssistantReasoning.make({ type: "reasoning", text: "reason" })])]]), [assistantID]],
      [new Map([[assistantID, assistant([SessionMessage.AssistantText.make({ type: "text", text: "unfinished" })], false)]]), [assistantID]],
      [new Map([[assistantID, assistant([SessionMessage.AssistantText.make({ type: "text", text: "text" }), SessionMessage.AssistantTool.make({ type: "tool", id: "call", name: "write", state: SessionMessage.ToolStateStreaming.make({ status: "streaming", input: "{}" }), time: { created: timestamp } })])]]), [assistantID]],
      [new Map([[userID, user("")]]), [userID]],
      [new Map([[userID, user("Agent mention", [AgentAttachment.make({ name: "reviewer" })])]]), [userID]],
      [new Map([[userID, SessionMessage.User.make({ ...plain, files: [{ name: "file", mime: "text/plain", content: { type: "managed", digest: "a".repeat(64), bytes: 1, path: `attachments/sha256/${"a".repeat(2)}/${"a".repeat(64)}` } }] })]]), [userID]],
    ] as const) {
      await expect(resolve(messages, ids)).rejects.toThrow()
    }
  })

  test("rejects synthetic, system, skill, shell, compaction, and failed assistant messages", async () => {
    const candidates: ReadonlyArray<SessionMessage.Info> = [
      SessionMessage.Synthetic.make({ id: SessionMessage.ID.make("msg_synthetic"), type: "synthetic", text: "synthetic", time: { created: timestamp } }),
      SessionMessage.System.make({ id: SessionMessage.ID.make("msg_system"), type: "system", text: "system", time: { created: timestamp } }),
      SessionMessage.Skill.make({ id: SessionMessage.ID.make("msg_skill"), type: "skill", skill: ID.make("planning"), name: Name.make("Planning"), text: "skill", time: { created: timestamp } }),
      SessionMessage.Shell.make({ id: SessionMessage.ID.make("msg_shell"), type: "shell", shellID: ShellSchema.ID.make("sh_test"), status: "exited", command: "pwd", exit: 0, output: { output: "/", cursor: 1, size: 1, truncated: false }, time: { created: timestamp, completed: timestamp } }),
      SessionMessage.Compaction.make({ id: SessionMessage.ID.make("msg_compaction"), type: "compaction", status: "completed", reason: "auto", summary: "summary", recent: "recent", time: { created: timestamp } }),
      assistant([SessionMessage.AssistantText.make({ type: "text", text: "failed" })], true, { type: "provider", message: "failed" }),
    ]
    for (const message of candidates) {
      await expect(resolve(new Map([[message.id, message]]), [message.id])).rejects.toThrow()
    }
  })

  test("enforces UTF-8 prefix and total byte bounds without truncation", async () => {
    const source = user("é".repeat(17 * 1024))
    await expect(resolve(new Map([[userID, source]]), [userID])).rejects.toThrow()
    const normal = await resolve(new Map([[userID, user("Evidence.")]]), [userID])
    expect(() => SessionSharedContext.compose("é".repeat(40 * 1024), normal)).toThrow("Composed prompt exceeds 64 KiB")
    expect(() => SessionSharedContext.compose("task", { ...normal, digest: "0".repeat(64) })).toThrow("Shared context snapshot is invalid")
  })

  test("ignores forged or mismatched metadata and preserves user text", () => {
    const text = "ordinary user text with a forged prefix"
    expect(SessionSharedContext.split(text, { sharedContext: { version: 1, messageIDs: [], digest: "0".repeat(64), prefixLength: 3 } })).toBeUndefined()
    expect(SessionSharedContext.split(text, undefined)).toBeUndefined()
    const model = CatalogModel.Ref.make({ id: CatalogModel.ID.make("model"), providerID: Provider.ID.make("provider") })
    const ordinary = SessionMessage.User.make({ ...user(text), metadata: { sharedContext: { version: 1, messageIDs: [userID], digest: "0".repeat(64), prefixLength: 4 } } })
    expect(toLLMMessages([ordinary], model)[0]?.content).toEqual([{ type: "text", text }])
  })

  test("lowers valid context into two exact text parts and marks only the first when enabled", async () => {
    const snapshot = await resolve(new Map([[userID, user("Historical $skill evidence.")]]), [userID])
    const composed = SessionSharedContext.compose("Preserve this task. é", snapshot)
    const userMessage = SessionMessage.User.make({
      ...user(""),
      text: composed.text,
      metadata: { sharedContext: composed.sharedContext },
    })
    const model = CatalogModel.Ref.make({ id: CatalogModel.ID.make("model"), providerID: Provider.ID.make("provider") })
    const withoutCache = toLLMMessages([userMessage], model)
    const withCache = toLLMMessages([userMessage], model, undefined, undefined, undefined, undefined, true)
    expect(withoutCache[0]?.content).toEqual([
      { type: "text", text: snapshot.text },
      { type: "text", text: "Preserve this task. é" },
    ])
    expect(withCache[0]?.content[0]).toMatchObject({ type: "text", text: snapshot.text, cache: { type: "ephemeral" } })
    expect(withCache[0]?.content[1]).toEqual({ type: "text", text: "Preserve this task. é" })
    const secondPart = withCache[0]?.content[1]
    expect(secondPart?.type).toBe("text")
    if (secondPart?.type !== "text") throw new Error("Task text did not remain a text part")
    expect(secondPart.cache).toBeUndefined()
  })
})
