import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  clampDesktopWindowFrame,
  clampDesktopWindowSize,
  DESKTOP_DEFAULT_WINDOW_HEIGHT,
  DESKTOP_DEFAULT_WINDOW_WIDTH,
  DESKTOP_MIN_WINDOW_HEIGHT,
  DESKTOP_MIN_WINDOW_SIZE,
  DESKTOP_MIN_WINDOW_WIDTH,
  enforceNativeWindowMinimumSize,
} from "../src/window-bounds"

test("desktop window minimum constants reflect the non-compact desktop geometry", () => {
  expect(DESKTOP_MIN_WINDOW_WIDTH).toBe(800)
  expect(DESKTOP_MIN_WINDOW_HEIGHT).toBe(600)
  expect(DESKTOP_MIN_WINDOW_SIZE).toEqual({ width: 800, height: 600 })
  expect(DESKTOP_DEFAULT_WINDOW_WIDTH).toBe(1360)
  expect(DESKTOP_DEFAULT_WINDOW_HEIGHT).toBe(860)
})

test("clampDesktopWindowFrame clamps sizes below minimum while preserving larger bounds", () => {
  expect(clampDesktopWindowSize({ width: 360, height: 480 })).toEqual({ width: 800, height: 600 })
  expect(clampDesktopWindowSize({ width: 799, height: 900 })).toEqual({ width: 800, height: 900 })
  expect(clampDesktopWindowSize({ width: 1200, height: 599 })).toEqual({ width: 1200, height: 600 })
  expect(clampDesktopWindowSize({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 })
  expect(clampDesktopWindowFrame({ x: 80, y: 80, width: 640, height: 480 })).toEqual({
    x: 80,
    y: 80,
    width: 800,
    height: 600,
  })
  expect(clampDesktopWindowFrame({ x: 120, y: 40, width: 1440, height: 900 })).toEqual({
    x: 120,
    y: 40,
    width: 1440,
    height: 900,
  })
})

test("enforceNativeWindowMinimumSize clamps resize events below minimum without interfering above minimum", () => {
  const listeners = new Map<string, (event: unknown) => void>()
  const setSizeCalls: Array<{ width: number; height: number }> = []
  const fakeWindow = {
    on(name: string, handler: (event: unknown) => void) {
      listeners.set(name, handler)
    },
    setSize(width: number, height: number) {
      setSizeCalls.push({ width, height })
      listeners.get("resize")?.({ data: { width, height } })
    },
  }

  enforceNativeWindowMinimumSize(fakeWindow)
  const resize = listeners.get("resize")
  expect(resize).toBeDefined()

  resize!({ data: { width: 800, height: 600 } })
  resize!({ data: { width: 1440, height: 900 } })
  expect(setSizeCalls).toEqual([])

  resize!({ data: { width: 640, height: 720 } })
  resize!({ data: { width: 960, height: 420 } })
  resize!({ data: { width: 360, height: 480 } })
  expect(setSizeCalls).toEqual([
    { width: 800, height: 720 },
    { width: 960, height: 600 },
    { width: 800, height: 600 },
  ])
})

test("native entry clamps initial BrowserWindow frame and enforces native minimum size before loading URL", async () => {
  const entry = await fs.readFile(path.join(import.meta.dir, "../src/bun/index.ts"), "utf8")
  const clampIdx = entry.indexOf("clampDesktopWindowFrame(")
  const windowIdx = entry.indexOf("new BrowserWindow(")
  const enforceIdx = entry.indexOf("enforceNativeWindowMinimumSize(window)")
  const loadIdx = entry.indexOf("loadURL(")
  expect(clampIdx).toBeGreaterThan(-1)
  expect(windowIdx).toBeGreaterThan(clampIdx)
  expect(enforceIdx).toBeGreaterThan(windowIdx)
  expect(loadIdx).toBeGreaterThan(enforceIdx)
})
