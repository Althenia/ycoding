import { expect, test } from "bun:test"
import { meetingConfigSchema } from "../src/config"

test("meeting defaults retain Thai locally and require human knowledge approval", () => {
  const config = meetingConfigSchema.parse({})
  expect(config.transcription.model).toBe("biodatlab/whisper-th-large-v3-combined")
  expect(config.transcription.language).toBe("th")
  expect(config.transcription.task).toBe("transcribe")
  expect(config.storage.retainAudio).toBe(false)
  expect(config.knowledge.autoApply).toBe(false)
  expect(config.knowledge.requireApproval).toBe(true)
})

test("configuration rejects automatic canonical mutation and unknown fields", () => {
  expect(() => meetingConfigSchema.parse({ knowledge: { autoApply: true } })).toThrow()
  expect(() => meetingConfigSchema.parse({ storage: { retainAudio: true } })).toThrow()
  expect(() => meetingConfigSchema.parse({ bridge: { host: "0.0.0.0" } })).toThrow()
})
