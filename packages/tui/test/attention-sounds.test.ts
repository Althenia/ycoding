import { expect, test } from "bun:test"
import path from "node:path"
import {
  defaultSoundPath,
  errorSoundPath,
  permissionSoundPath,
  questionSoundPath,
  subagentDoneSoundPath,
} from "../src/attention-sounds.bun"

test.each([
  ["default", defaultSoundPath],
  ["question", questionSoundPath],
  ["permission", permissionSoundPath],
  ["error", errorSoundPath],
  ["subagentDone", subagentDoneSoundPath],
])("%s attention sound is a non-empty mp3 file", async (_name, soundPath) => {
  expect(path.extname(soundPath)).toBe(".mp3")
  expect(Bun.file(soundPath).size).toBeGreaterThan(0)
})
