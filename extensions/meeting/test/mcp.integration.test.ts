import { expect, test } from "bun:test"
import { startBackend } from "./fixture/runtime"

test("Rust Meeting retrieves through the live MCP registry and writes only after reviewed revision/read-back", async () => {
  const backend = await startBackend("local", true)
  try {
    await backend.control({ action: "start", title: "Live registry" })
    const capture = async (payload: unknown) => {
      const reply = await fetch(`${backend.origin}/view/capture`, {
        method: "POST",
        headers: {
          origin: backend.origin,
          authorization: `Bearer ${new URL(backend.url).hash.slice(5)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      })
      expect(reply.status).toBe(200)
      return reply.json()
    }
    await capture({ type: "start", captureID: "mcp", microphone: false, consent: true })
    await capture({
      type: "audio",
      captureID: "mcp",
      source: "remote",
      sequence: 0,
      startMs: 0,
      sampleRate: 16000,
      pcm: Buffer.from(new Float32Array(16000).fill(0.1).buffer).toString("base64"),
    })
    await capture({ type: "stop", captureID: "mcp", reason: "fixture complete" })
    await backend.control({ action: "summary" })
    const view = await backend.settled()
    const proposal = view.proposals[0]
    expect(proposal, JSON.stringify(view)).toMatchObject({
      status: "pending",
      expectedRevision: "r1",
      existingContent: "Original canonical content",
    })
    expect(proposal.references).toMatchObject([
      { server: "knowledge", target: "doc-1", revision: "r1", content: "Original canonical content" },
    ])
    const before = await Bun.file(backend.knowledgeState).json()
    expect(before.searches).toContainEqual({
      query: "เราจะทดสอบ canary rollout และ transcription latency",
      limit: 3,
    })
    expect(before.reads).toContainEqual({ id: "doc-1" })
    expect(before.writes).toEqual([])
    await backend.control({ action: "approve", proposalID: proposal.id })
    expect((await backend.status()).proposals[0]).toMatchObject({ status: "applied", expectedRevision: "r1" })
    const after = await Bun.file(backend.knowledgeState).json()
    expect(after.writes).toEqual([{ id: "doc-1", content: "Reviewed canonical replacement", expectedRevision: "r1" }])
    expect(after).toMatchObject({ revision: "r2", content: "Reviewed canonical replacement" })
    expect(after.reads.length).toBeGreaterThan(before.reads.length)
  } finally {
    await backend.stop()
  }
}, 60000)
