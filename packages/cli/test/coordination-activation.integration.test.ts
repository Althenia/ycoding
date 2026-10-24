import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { createSession, providerConfig, startProviderStandIn, startServer } from "./remote-harness"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const json = { "content-type": "application/json" }
const masterPrompt = "Start the project."
const memberPrompt = "Run the member check."

test.each([
  ["a human Master prompt activates the Project, and", true],
  ["while the Project stays inactive,", false],
] as const)("%s a member permission ask wakes the Master with a notification", async (_title, activate) => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-project-activation-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const masterStarted = gate()
  const notified = gate<string>()
  const standIn = await startProviderStandIn({
    text: "Done.",
    reply: (request) => {
      const contents = messagesOf(request)
      const notice = contents.map((content) => /Project notification:\n(\{.*\})/.exec(content)?.[1]).find((match) => match !== undefined)
      if (notice !== undefined) notified.open(notice)
      if (contents.some((content) => content.includes(masterPrompt))) masterStarted.open(undefined)
      const member = contents.some((content) => content.includes(memberPrompt)) && !(Reflect.get(request as object, "messages") as Array<{ role?: string }>).some((message) => message.role === "tool")
      if (member) return [toolCallChunk("call_member_check", "shell", JSON.stringify({ command: "echo member-check", description: "Synthetic member check" })), finishChunk("tool_calls")]
      return [deltaChunk({ role: "assistant", content: "Done." }), finishChunk("stop")]
    },
  })
  cleanups.push(() => standIn.close())
  const server = await startServer(directory, {
    config: {
      ...JSON.parse(providerConfig(standIn)),
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
      guardrails: { decide_reviews: false },
    },
  })
  cleanups.push(() => server.close())
  const model = { providerID: standIn.providerID, id: standIn.modelID }
  await createSession(server, "ses_master", directory, model)
  await createSession(server, "ses_member", directory, model)
  const created = await server.request("/api/coordination", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Project", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] }),
  })
  expect(created.status, await created.clone().text()).toBe(200)
  const groupID = ((await created.json()) as { data: { id: string; active: boolean } }).data.id
  const active = async () => ((await (await server.request(`/api/coordination/${groupID}`)).json()) as { data: { active: boolean } }).data.active
  expect(await active()).toBe(false)

  if (activate) {
    await prompt(server, "ses_master", masterPrompt)
    await masterStarted.promise
    expect(await active()).toBe(true)
  }

  await prompt(server, "ses_member", memberPrompt)
  const notice = JSON.parse(await notified.promise) as Record<string, unknown>
  const asks = await permissions(server, "ses_member")
  expect(asks.map((ask) => [ask.sessionID, ask.action])).toEqual([["ses_member", "shell"]])
  const requestID = String(asks[0]!.id)
  expect(notice).toMatchObject({
    source: "project_notification",
    groupID,
    memberSessionID: "ses_member",
    event: "permission",
    requestID,
  })
  expect(await active()).toBe(activate)
  expect(server.logs.filter((line) => line.includes("Project event handling failed"))).toEqual([])
  const rejected = await server.request(`/api/session/ses_member/permission/${requestID}/reject`, { method: "POST", headers: json, body: "{}" })
  expect(rejected.status, await rejected.clone().text()).toBeLessThan(300)
}, 30000)

async function prompt(server: Awaited<ReturnType<typeof startServer>>, sessionID: string, text: string) {
  const response = await server.request(`/api/session/${sessionID}/prompt`, { method: "POST", headers: json, body: JSON.stringify({ text }) })
  expect(response.status, await response.clone().text()).toBe(200)
}

async function permissions(server: Awaited<ReturnType<typeof startServer>>, sessionID: string) {
  const response = await server.request(`/api/session/${sessionID}/permission`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: Array<Record<string, unknown>> }).data
}

function messagesOf(request: unknown) {
  const messages = typeof request === "object" && request !== null ? Reflect.get(request, "messages") : undefined
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message: { content?: unknown }) =>
    typeof message.content === "string"
      ? [message.content]
      : Array.isArray(message.content)
        ? message.content.flatMap((part: { text?: unknown }) => (typeof part.text === "string" ? [part.text] : []))
        : [],
  )
}

function gate<T = undefined>() {
  let open = (_value: T) => {}
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}
