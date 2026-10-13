import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FrontendPaths } from "../src/frontend-paths"
import { Slug } from "../src/util/slug"
import { BrowserExtension } from "../src/install-layout"
import { PtyProtocol } from "../src/pty-protocol"

test("S2 resolves frontend XDG roots without initializing backend directories", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ycoding-frontend-paths-"))
  try {
    const roots = FrontendPaths.resolve({
      home,
      env: {
        XDG_STATE_HOME: path.join(home, "ui-state"),
        XDG_CONFIG_HOME: path.join(home, "ui-config"),
        XDG_CACHE_HOME: path.join(home, "ui-cache"),
        XDG_DATA_HOME: path.join(home, "backend-data"),
      },
    })
    expect(roots).toEqual({
      home,
      state: path.join(home, "ui-state", "ycoding"),
      config: path.join(home, "ui-config", "ycoding"),
      cache: path.join(home, "ui-cache", "ycoding"),
    })
    expect(await readdir(home)).toEqual([])
    expect(FrontendPaths.resolve({ home, env: {} }).state).toBe(path.join(home, ".local", "state", "ycoding"))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("S3 generates human-readable project copy slugs", () => {
  for (let index = 0; index < 20; index++) expect(Slug.create()).toMatch(/^[a-z]+-[a-z]+$/)
})

test("S5 derives extension location from the frontend executable layout", () => {
  expect(BrowserExtension.location("/installed/bin/ycoding", "/checkout/extensions/chrome")).toBe(
    "/installed/bin/ycoding-chrome-extension",
  )
  expect(BrowserExtension.location("/installed/bun", "/checkout/extensions/chrome")).toBe("/checkout/extensions/chrome")
  expect(BrowserExtension.files).toHaveLength(10)
})

test("S4 validates tagged PTY controls and byte limits without runtime imports", () => {
  const replay = { type: "replay" as const, generation: 1, startOffset: 0, endOffset: 2, gap: true }
  expect(PtyProtocol.decodeServerFrame(PtyProtocol.controlFrame(replay))).toEqual({ type: "control", value: replay })
  expect(PtyProtocol.decodeServerFrame(PtyProtocol.dataFrame(new Uint8Array([0, 255])))).toEqual({
    type: "data",
    value: new Uint8Array([0, 255]),
  })
  for (const generation of [0, -1, 1.5])
    expect(PtyProtocol.decodeServerFrame(PtyProtocol.controlFrame({ ...replay, generation }))).toBeUndefined()
  expect(PtyProtocol.decodeInput(new Uint8Array([255]))).toBeUndefined()
  expect(PtyProtocol.decodeInput("é".repeat(PtyProtocol.MAX_INPUT_BYTES / 2))).toHaveLength(
    PtyProtocol.MAX_INPUT_BYTES / 2,
  )
  expect(PtyProtocol.decodeInput("é".repeat(PtyProtocol.MAX_INPUT_BYTES / 2 + 1))).toBeUndefined()
  expect(
    PtyProtocol.chunks(new Uint8Array(PtyProtocol.REPLAY_CHUNK + 1), 42).map((chunk) => [
      chunk.startOffset,
      chunk.endOffset,
    ]),
  ).toEqual([
    [42, 42 + PtyProtocol.REPLAY_CHUNK],
    [42 + PtyProtocol.REPLAY_CHUNK, 43 + PtyProtocol.REPLAY_CHUNK],
  ])
})
