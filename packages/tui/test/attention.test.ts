import { expect, test } from "bun:test"
import type { AudioSound, AudioVoice } from "@opentui/core"
import { createTuiAttention } from "../src/attention"

test("plays the built-in done sound through the TUI audio host", async () => {
  const loaded: string[] = []
  const played: Array<{ sound: AudioSound; volume: number | undefined }> = []
  // The audio boundary is the only external object in this unit test.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const sound = {} as AudioSound
  // The audio boundary is the only external object in this unit test.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const voice = {} as AudioVoice
  const attention = createTuiAttention({
    renderer: {
      isDestroyed: false,
      on() {},
      off() {},
      triggerNotification: () => false,
    },
    config: {
      attention: {
        enabled: true,
        notifications: false,
        sound: true,
        volume: 0.4,
        sound_pack: "ycoding.default",
        sounds: {},
      },
    },
    audio: {
      async loadSoundFile(file) {
        loaded.push(file)
        return sound
      },
      play(current, options) {
        played.push({ sound: current, volume: options?.volume })
        return voice
      },
    },
  })

  const result = await attention.notify({
    message: "Session done",
    notification: false,
    sound: { name: "done", when: "always" },
  })

  expect(result.sound).toBe(true)
  expect(loaded).toHaveLength(1)
  expect(played).toEqual([{ sound, volume: 0.4 }])
  attention.dispose()
})
