import { expect, test } from "bun:test"
import { mkdtemp, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { copyCommand, materializeClipboardImage } from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

test("CLP-001 materializes concurrent clipboard images in distinct mode-0600 files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-clipboard-test-"))
  const results = await Promise.all(
    ["first", "second"].map((content) =>
      materializeClipboardImage(root, async (file) => {
        await Bun.write(file, content)
      }),
    ),
  )

  try {
    const paths = results.map((result) => fileURLToPath(result.uri))
    expect(new Set(paths).size).toBe(2)
    expect(paths.every((file) => file.startsWith(path.join(root, "ycoding-clipboard-")))).toBe(true)
    expect(await Promise.all(paths.map((file) => Bun.file(file).text()))).toEqual(["first", "second"])
    expect(await Promise.all(paths.map(async (file) => (await stat(file)).mode & 0o777))).toEqual([0o600, 0o600])
    expect(results.every((result) => result.uri.startsWith("file://"))).toBe(true)
  } finally {
    await Promise.all(results.map((result) => result.temporary.cleanup()))
  }

  expect(await readdir(root)).toEqual([])
})

test("CLP-002 removes a partial clipboard file when acquisition fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-clipboard-failure-test-"))

  await expect(
    materializeClipboardImage(root, async (file) => {
      await Bun.write(file, "partial")
      throw new Error("clipboard read failed")
    }),
  ).rejects.toThrow("clipboard read failed")

  expect(await readdir(root)).toEqual([])
})

test("CLP-003 aborts clipboard materialization and releases its owned temporary file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-clipboard-abort-test-"))
  const controller = new AbortController()
  let started!: () => void
  const writing = new Promise<void>((resolve) => (started = resolve))

  const acquisition = materializeClipboardImage(
    root,
    async (file) => {
      await Bun.write(file, "partial")
      started()
      await new Promise<void>((_resolve, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
      )
    },
    { signal: controller.signal },
  )

  await writing
  controller.abort(new Error("cancel clipboard acquisition"))
  await expect(acquisition).rejects.toThrow("cancel clipboard acquisition")
  expect(await readdir(root)).toEqual([])
})
