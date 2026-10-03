import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { YCoding } from "@ycoding-ai/client/promise"
import { deltaChunk, finishChunk, toolCallChunk } from "../../../ai/test/lib/openai-chunks"
import { auth, createSession, startServer } from "../remote-harness"

test("required human review stays pending until answered and continues without a completion receipt", async () => {
  const scratch = path.resolve(import.meta.dir, "../../../../.cache/tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(path.join(scratch, "human-input-flow-"))
  let questionRequests = 0
  const server = await startServer(directory, {
    provider: {
      text: "Continued after review.",
      reply: (request) => {
        const tools = typeof request === "object" && request !== null ? Reflect.get(request, "tools") : undefined
        if (!Array.isArray(tools) || !tools.some((tool) => tool?.function?.name === "question"))
          return [deltaChunk({ role: "assistant", content: "Human review" }), finishChunk("stop")]
        questionRequests++
        if (questionRequests > 1)
          return [deltaChunk({ role: "assistant", content: "Continued after review." }), finishChunk("stop")]
        return [
          toolCallChunk(
            "call_review",
            "question",
            JSON.stringify({
              questions: [
                {
                  header: "Evidence",
                  question: "The defect did not reproduce. Paste the exact failing input so I can continue.",
                  options: [],
                },
              ],
            }),
          ),
          finishChunk("tool_calls"),
        ]
      },
    },
  })
  const client = YCoding.make({ baseUrl: server.base, headers: { authorization: auth } })
  const sessionID = "ses_human_input_flow"
  const live = client.event.subscribe({ signal: AbortSignal.timeout(10000) })[Symbol.asyncIterator]()
  try {
    if (!server.provider) throw new Error("Missing isolated provider")
    await createSession(server, sessionID, directory, {
      providerID: server.provider.providerID,
      id: server.provider.modelID,
    })
    await live.next()
    await client.session.prompt({ sessionID, text: "Investigate the defect and ask me for missing evidence." })
    const pending = await (async () => {
      while (true) {
        const next = await live.next()
        if (next.done) throw new Error("Event stream ended before the human-input request")
        const event = next.value
        if (event.type === "form.created" && event.data.form.sessionID === sessionID) return event.data.form
      }
    })()
    expect(await client.form.list({ sessionID })).toEqual([pending])
    expect(await client.form.state({ sessionID, formID: pending.id })).toEqual({ status: "pending" })
    expect(pending.metadata).toMatchObject({ kind: "question", tool: { callID: "call_review" } })
    expect(questionRequests).toBe(1)
    expect(JSON.stringify(server.provider.requests())).toContain(
      "When progress requires user input, a decision, or review, call question",
    )
    await client.form.reply({ sessionID, formID: pending.id, answer: { q0: "Synthetic failing input" } })
    while (true) {
      const next = await live.next()
      if (next.done) throw new Error("Event stream ended before execution settled")
      const event = next.value
      if (event.type !== "session.execution.succeeded" || event.data.sessionID !== sessionID) continue
      break
    }
    expect(questionRequests).toBe(2)
    expect(await client.form.list({ sessionID })).toEqual([])
    const snapshot = await client.session.snapshot({ sessionID })
    expect(
      snapshot.messages.flatMap((message) => (message.type === "assistant" ? message.content : [])),
    ).toContainEqual(expect.objectContaining({ type: "text", text: "Continued after review." }))
    expect(await (await server.request("/api/session/completions")).json()).toEqual({ data: [] })
  } finally {
    await live.return?.()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
