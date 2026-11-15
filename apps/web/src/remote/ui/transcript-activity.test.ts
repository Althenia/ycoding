import { expect, test } from "bun:test"
import { transcriptActivity } from "../view-model"

const active = { status: "running", connection: "connected", transport: "open", messages: [], requests: 0, sending: false } as const

test("live activity names thinking, tool execution and reply streaming and disappears at idle", () => {
  expect(transcriptActivity(active)).toEqual({ kind: "typing", label: "Thinking" })
  const message = { kind: "assistant", id: "a", created: 1, parts: [{ kind: "tool", ordinal: 0, callID: "call", name: "read", status: "running", content: [] }] } as const
  expect(transcriptActivity({ ...active, messages: [message] })).toEqual({ kind: "typing", label: "Running Read" })
  expect(transcriptActivity({ ...active, messages: [{ ...message, parts: [{ kind: "reasoning", ordinal: 0, text: "Considering", started: 1 }] }] })).toEqual({ kind: "typing", label: "Thinking" })
  expect(transcriptActivity({ ...active, messages: [{ ...message, parts: [{ kind: "text", ordinal: 0, text: "Hello" }] }] })).toEqual({ kind: "typing", label: "Writing" })
  expect(transcriptActivity({ ...active, status: "idle", messages: [message] })).toBeUndefined()
})

test("activity lives after transcript rows, outside the composer, with motion gated by preference", async () => {
  const navigation = await Bun.file(new URL("./transcript-nav.tsx", import.meta.url)).text()
  expect(navigation.indexOf("<TranscriptActivityRow />")).toBeGreaterThan(navigation.indexOf("</ol>"))
  const stylesheet = await Bun.file(new URL("./transcript.css", import.meta.url)).text()
  expect(stylesheet).toContain("@media (prefers-reduced-motion:no-preference)")
  expect(stylesheet).toContain(':root[data-motion="off"] .transcript-activity__typing span { animation:none; }')
})
