import type { SessionInfo, SessionMessageInfo, ShellInfo } from "@ycoding-ai/client"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

type BtwSessionApi = {
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
  prompt(input: { sessionID: string; text: string; delivery?: "steer" }): Promise<unknown>
  generate?(input: { sessionID: string; prompt: string }): Promise<{ data: { text: string } } | { text: string }>
}

function rawParentSlice(messages: readonly SessionMessageInfo[]): string {
  const recent = messages
    .flatMap((message) => {
      if (message.type === "user") return [{ role: "User", text: message.text }]
      if (message.type === "synthetic") return [{ role: "Context", text: message.text }]
      if (message.type !== "assistant") return []
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => ({ role: "Assistant", text: part.text }))
    })
    .slice(-12)
  return ["Recent parent session history:", ...recent.map((item) => `${item.role}:\n${item.text}`)].join("\n\n")
}

async function summarizeParentContext(
  api: BtwSessionApi,
  parentID: string,
  messages: readonly SessionMessageInfo[],
): Promise<string> {
  const fallback = rawParentSlice(messages)
  const generate = api.generate
  if (!generate) return fallback
  try {
    const raw = messages
      .slice(-12)
      .map((m) => {
        if (m.type === "user") return `User: ${m.text}`
        if (m.type === "synthetic") return `Context: ${m.text}`
        if (m.type === "assistant")
          return `Assistant: ${m.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n")}`
        return ""
      })
      .filter(Boolean)
      .join("\n\n")
    if (!raw.trim()) return fallback
    const result = await generate({
      sessionID: parentID,
      prompt: `Summarize parent session history for btw context. Keep key facts, decisions, file paths, and open questions concise (<=12 bullets). History:\n${raw.slice(0, 6000)}`,
    })
    const text = (result as { data?: { text?: string }; text?: string })?.data?.text ?? (result as { text?: string }).text
    if (typeof text === "string" && text.trim()) return `Parent summary (synthesized):\n${text.trim()}\n\nFallback raw (truncated):\n${fallback.slice(0, 2000)}`
  } catch {
    // fall through
  }
  return fallback
}

export async function openBtwSession(input: {
  api: BtwSessionApi
  parentID: string
  messages: readonly SessionMessageInfo[]
  model: { providerID: string; id: string; variant?: string }
  text?: string
}) {
  const session = await input.api.create({ parentID: input.parentID, agent: "btw", model: input.model })
  const summarized = await summarizeParentContext(input.api, input.parentID, input.messages)
  await input.api.synthetic({
    sessionID: session.id,
    text: summarized,
    description: "Parent session history snapshot",
    delivery: "steer",
    resume: false,
  })
  if (input.text?.trim()) await input.api.prompt({ sessionID: session.id, text: input.text })
  return session
}

export async function steerBtwConclusion(input: {
  api: Pick<BtwSessionApi, "prompt" | "generate">
  parentID: string
  text: string
  btwMessages?: readonly SessionMessageInfo[]
  btwSessionID?: string
}) {
  let text = input.text
  if (input.btwMessages?.length) {
    const raw = input.btwMessages
      .flatMap((m) => {
        if (m.type === "user") return [`User: ${m.text}`]
        if (m.type === "assistant")
          return [
            `Assistant: ${m.content
              .filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text)
              .join("\n")}`,
          ]
        if (m.type === "synthetic") return [`Context: ${m.text}`]
        return []
      })
      .join("\n\n")
      .slice(0, 6000)
    if (raw.trim() && input.btwSessionID && (input.api as BtwSessionApi).generate) {
      try {
        const result = await (input.api as BtwSessionApi).generate!({
          sessionID: input.btwSessionID,
          prompt: `Summarize this btw side-chat for steering the parent. Keep decisions, findings, and next steps. Then append the user conclusion:\nConclusion: ${text}\n\nChat:\n${raw}`,
        })
        const summarized = (result as { data?: { text?: string }; text?: string })?.data?.text ?? (result as { text?: string }).text
        if (typeof summarized === "string" && summarized.trim()) text = summarized.trim()
        else text = `BTW summary:\n${raw.slice(0, 3000)}\n\nConclusion: ${text}`
      } catch {
        text = `BTW summary:\n${raw.slice(0, 3000)}\n\nConclusion: ${text}`
      }
    } else if (raw.trim()) {
      text = `BTW summary:\n${raw.slice(0, 3000)}\n\nConclusion: ${text}`
    }
  }
  await input.api.prompt({ sessionID: input.parentID, text, delivery: "steer" })
}

export type SessionShellGroup = {
  owner: { label: string }
  shells: ShellInfo[]
}

export function groupSessionShells(
  shells: readonly ShellInfo[],
  sessions: readonly SessionInfo[],
  currentSessionID: string,
): SessionShellGroup[] {
  const descendantIDs = childSessionIDs(sessions, currentSessionID)
  const ownerIDs = new Set([currentSessionID, ...descendantIDs])
  const visible = shells.filter((shell) => {
    if (shell.status !== "running") return false
    const sessionID = shell.metadata.sessionID
    if (typeof sessionID !== "string") return true
    const owner = sessions.find((session) => session.id === sessionID)
    if (!owner) return true
    return ownerIDs.has(owner.id)
  })
  const groups = [currentSessionID, ...descendantIDs].flatMap((sessionID) => {
    const owned = visible.filter((shell) => shell.metadata.sessionID === sessionID)
    if (!owned.length) return []
    const owner = sessions.find((session) => session.id === sessionID)
    const label = sessionID === currentSessionID ? "Main chat" : `${owner?.agent === "btw" ? "BTW" : owner?.agent ?? "Subagent"} · ${owner?.title ?? ""}`
    return [{ owner: { label }, shells: owned }]
  })
  const unknown = visible.filter((shell) => {
    const sessionID = shell.metadata.sessionID
    if (typeof sessionID !== "string") return true
    return !sessions.some((session) => session.id === sessionID)
  })
  if (!unknown.length) return groups
  return [...groups, { owner: { label: "Unknown session" }, shells: unknown }]
}

function childSessionIDs(sessions: readonly SessionInfo[], parentID: string): string[] {
  return sessions
    .filter((session) => session.parentID === parentID)
    .flatMap((session) => [session.id, ...childSessionIDs(sessions, session.id)])
}
