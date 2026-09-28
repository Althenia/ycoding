import { expect, test } from "bun:test"
import { createCliRenderer, type AudioSound, type AudioVoice } from "@opentui/core"
import { Readable, Writable } from "node:stream"
import { createTuiAttention } from "../src/attention"

test("delivers a blurred notification before focus is reported through Ghostty's renderer", async () => {
  const chunks: Buffer[] = []
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {} })
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    }),
    { isTTY: true, columns: 80, rows: 24 },
  )
  const renderer = await createCliRenderer({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    useThread: false,
    useMouse: false,
    consoleMode: "disabled",
  })
  const attention = createTuiAttention({
    renderer,
    config: {
      attention: {
        enabled: true,
        notifications: true,
        sound: false,
        volume: 0.4,
        sound_pack: "ycoding.default",
        sounds: {},
      },
    },
  })
  try {
    stdin.emit("data", Buffer.from("\u001bP>|ghostty 1.1.3\u001b\\"))
    expect(renderer.capabilities?.notifications).toBe(true)
    expect(await attention.notify({ message: "Session done", notification: { when: "blurred" }, sound: false })).toEqual({
      ok: true,
      notification: true,
      sound: false,
    })
    expect(Buffer.concat(chunks).toString()).toContain("\u001b]777;notify;YCoding;Session done\u001b\\")

    stdin.emit("data", Buffer.from("\u001b[?1004;1$y"))
    expect(Buffer.concat(chunks).toString()).toContain("\u001b[?1004h")
    stdin.emit("data", Buffer.from("\u001b[I"))
    expect(await attention.notify({ message: "Session done", notification: { when: "blurred" }, sound: false })).toEqual({
      ok: false,
      notification: false,
      sound: false,
      skipped: "focused",
    })
    stdin.emit("data", Buffer.from("\u001b[O"))
    expect(
      (await attention.notify({ message: "Session done", notification: { when: "blurred" }, sound: false })).notification,
    ).toBe(true)
  } finally {
    attention.dispose()
    renderer.destroy()
  }
})

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
