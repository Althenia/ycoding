import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"
import { ComputerPolicy } from "@ycoding-ai/core/computer/policy"
import { ComputerHistory } from "@ycoding-ai/core/computer/history"
import { ComputerTool } from "@ycoding-ai/core/tool/computer"

describe("computer app policy", () => {
  test("forbids system-security and credential apps closed", () => {
    for (const bundleID of ["com.apple.systempreferences", "com.apple.keychainaccess", "com.1password.1password", "app.ycoding.computer-use"]) {
      expect(ComputerPolicy.evaluate(bundleID).decision).toBe("forbidden")
    }
  })

  test("marks terminals elevated-risk and ordinary apps allowed", () => {
    expect(ComputerPolicy.evaluate("com.apple.Terminal").decision).toBe("elevated")
    expect(ComputerPolicy.evaluate("com.googlecode.iterm2").decision).toBe("elevated")
    expect(ComputerPolicy.evaluate("com.example.fixture").decision).toBe("allowed")
  })

  test("an explicit override removes a bundle from the forbidden list only", () => {
    const policy = ComputerPolicy.evaluate("com.apple.systempreferences", { allow: ["com.apple.systempreferences"] })
    expect(policy.decision).toBe("allowed")
    expect(ComputerPolicy.evaluate("com.apple.Terminal", { allow: ["com.apple.Terminal"] }).decision).toBe("elevated")
  })

  test("parses the environment override list", () => {
    expect(ComputerPolicy.overrideFromEnv(" com.a ,, com.b ")).toEqual(["com.a", "com.b"])
    expect(ComputerPolicy.overrideFromEnv(undefined)).toEqual([])
  })
})

describe("xdotool key chords", () => {
  test("parses modifier chords into key and modifiers", () => {
    expect(MacOSComputer.keyChord("super+c")).toEqual({ key: "c", modifiers: ["command"] })
    expect(MacOSComputer.keyChord("ctrl+shift+Return")).toEqual({ key: "enter", modifiers: ["control", "shift"] })
    expect(MacOSComputer.keyChord("alt+Tab")).toEqual({ key: "tab", modifiers: ["option"] })
    expect(MacOSComputer.keyChord("KP_0")).toEqual({ key: "0", modifiers: [] })
  })

  test("passes plain keys through and merges explicit modifiers", () => {
    expect(MacOSComputer.keyChord("a")).toEqual({ key: "a", modifiers: [] })
    expect(MacOSComputer.keyChord("a", ["command"])).toEqual({ key: "a", modifiers: ["command"] })
    expect(MacOSComputer.keyChord("cmd+a", ["command"])).toEqual({ key: "a", modifiers: ["command"] })
  })

  test("rejects unknown modifiers and empty keys", () => {
    expect(MacOSComputer.keyChord("hyper+a")).toBeUndefined()
    expect(MacOSComputer.keyChord("super+")).toBeUndefined()
    expect(MacOSComputer.keyChord("")).toBeUndefined()
  })
})

describe("AX element diff", () => {
  const element = (path: number[], role: string, label: string, value?: string) => ({
    path, role, label, frame: [0, 0, 10, 10] as const, actions: [] as const, enabled: true, focused: false, value,
  })

  test("renders added, removed, and changed elements and omits unchanged ones", () => {
    const before = [element([0], "AXWindow", "Fixture"), element([0, 1], "AXButton", "Save"), element([0, 2], "AXStaticText", "Old")]
    const after = [element([0], "AXWindow", "Fixture"), element([0, 1], "AXButton", "Saved"), element([0, 3], "AXStaticText", "New")]
    const diff = MacOSComputer.diffElements(before, after)
    expect(diff).toContain("~ [0,1] AXButton \"Saved\"")
    expect(diff).toContain("+ [0,3] AXStaticText \"New\"")
    expect(diff).toContain("- [0,2] AXStaticText \"Old\"")
    expect(diff).not.toContain("AXWindow")
  })

  test("returns an empty diff for identical trees and a full-add diff without a baseline", () => {
    const tree = [element([0], "AXWindow", "Fixture")]
    expect(MacOSComputer.diffElements(tree, tree)).toBe("")
    expect(MacOSComputer.diffElements(undefined, tree)).toContain("+ [0] AXWindow \"Fixture\"")
  })
})

describe("computer history recorder", () => {
  test("preserves history header defaults and JSON errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-computer-history-"))
    try {
      await writeFile(path.join(directory, "empty.jsonl"), "")
      await writeFile(path.join(directory, "partial.jsonl"), JSON.stringify({ sessionID: 7, started: null }))
      expect((await ComputerHistory.list(directory)).map(({ id, sessionID, started, events }) => ({ id, sessionID, started, events })))
        .toEqual([{ id: "empty", sessionID: "", started: "", events: 0 }, { id: "partial", sessionID: "", started: "", events: 0 }])
      await writeFile(path.join(directory, "invalid.jsonl"), "{")
      await expect(ComputerHistory.list(directory)).rejects.toBeInstanceOf(SyntaxError)
      await expect(ComputerHistory.read(directory, "invalid")).resolves.toEqual([])
      await writeFile(path.join(directory, "invalid.jsonl"), "{}\n{")
      await expect(ComputerHistory.read(directory, "invalid")).rejects.toBeInstanceOf(SyntaxError)
      await expect(ComputerHistory.read(directory, "missing")).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("preserves event metadata, optional fields and limits, and rejects malformed events", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-computer-history-"))
    try {
      const recorder = ComputerHistory.recorder(directory, () => new Date("2026-11-04T10:00:00.000Z"))
      const base = { sessionID: "ses_fixture", action: "desktop.capture", bundleID: "com.example.fixture", pid: 1, windowID: 2, revision: "rev" }
      const screenshot = { sha256: "synthetic-digest", width: 320, height: 240, scale: 1 }
      await recorder.record({ ...base, screenshot, effect: "changed" })
      await recorder.record(base)
      const [entry] = await ComputerHistory.list(directory)
      const events = await ComputerHistory.read(directory, entry!.id)
      expect(events).toEqual([
        { type: "event", at: "2026-11-04T10:00:00.000Z", ...base, screenshot, effect: "changed" },
        { type: "event", at: "2026-11-04T10:00:00.000Z", ...base },
      ])
      expect(await ComputerHistory.read(directory, entry!.id, 1)).toEqual([events[0]])
      await writeFile(path.join(directory, "invalid-event.jsonl"), '{}\n{"type":"other"}\n{"type":"event","legacy":true}\n')
      await expect(ComputerHistory.read(directory, "invalid-event")).rejects.toThrow()
      await writeFile(path.join(directory, "invalid-event.jsonl"), `{}\n${JSON.stringify({ ...events[0], screenshot: { ...screenshot, width: "invalid" } })}\n`)
      await expect(ComputerHistory.read(directory, "invalid-event")).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("records session-scoped events, lists, reads, prunes, and clears them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-computer-history-"))
    try {
      const recorder = ComputerHistory.recorder(directory, () => new Date("2026-11-04T10:00:00.000Z"))
      await recorder.record({ sessionID: "ses_a", action: "desktop.inspect", bundleID: "com.example.fixture", pid: 451, windowID: 73, revision: "rev-1" })
      await recorder.record({ sessionID: "ses_a", action: "desktop.click", bundleID: "com.example.fixture", pid: 451, windowID: 73, revision: "rev-2", effect: "changed" })
      await recorder.record({ sessionID: "ses_b", action: "desktop.capture", bundleID: "com.example.other", pid: 9, windowID: 2, revision: "rev-9", screenshot: { sha256: "abc", width: 320, height: 240, scale: 1 } })

      const listed = await ComputerHistory.list(directory)
      expect(listed.map((entry) => entry.sessionID).sort()).toEqual(["ses_a", "ses_b"])
      const a = listed.find((entry) => entry.sessionID === "ses_a")!
      expect(a.events).toBe(2)
      const events = await ComputerHistory.read(directory, a.id)
      expect(events.map((event) => event.action)).toEqual(["desktop.inspect", "desktop.click"])
      expect(events[1]).toMatchObject({ effect: "changed", revision: "rev-2" })
      const raw = await readFile(path.join(directory, a.file), "utf8")
      expect(raw.trim().split("\n")).toHaveLength(3)
      expect(JSON.parse(raw.split("\n")[0])).toMatchObject({ type: "session", sessionID: "ses_a", schema: 1 })

      const pruned = await ComputerHistory.prune(directory, new Date("2027-01-01T00:00:00.000Z"))
      expect(pruned).toBe(2)
      expect(await ComputerHistory.list(directory)).toEqual([])

      await recorder.record({ sessionID: "ses_c", action: "desktop.inspect", bundleID: "com.example.x", pid: 1, windowID: 1, revision: "r" })
      expect(await ComputerHistory.clear(directory)).toBe(1)
      expect(await ComputerHistory.list(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects history ids that escape the history directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-computer-history-"))
    try {
      await expect(ComputerHistory.read(directory, "../outside")).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("computer parity tool input", () => {
  const decode = Schema.decodeUnknownSync(ComputerTool.Input)
  const base = { platform: "macos", bundle_id: "com.example.fixture", pid: 451, window_id: 73 }

  test("accepts observe and paste with bounded fields", () => {
    expect(decode({ action: "desktop.observe", ...base })).toMatchObject({ action: "desktop.observe" })
    expect(decode({ action: "desktop.paste", ...base, expected_revision: "rev", text: "hello" })).toMatchObject({ action: "desktop.paste", text: "hello" })
    expect(decode({ action: "desktop.paste", ...base, expected_revision: "rev", text: "<b>x</b>", format: "html" })).toMatchObject({ format: "html" })
    expect(() => decode({ action: "desktop.paste", ...base, expected_revision: "rev", text: "x".repeat(16_385) })).toThrow()
    expect(() => decode({ action: "desktop.paste", ...base, expected_revision: "rev", text: "x", format: "rtf" })).toThrow()
  })

  test("accepts click/key durations and key-during-click within bounds", () => {
    expect(decode({ action: "desktop.click", ...base, expected_revision: "rev", x: 1, y: 2, duration_ms: 800, key: "shift" })).toMatchObject({ duration_ms: 800, key: "shift" })
    expect(() => decode({ action: "desktop.click", ...base, expected_revision: "rev", x: 1, y: 2, duration_ms: 5001 })).toThrow()
    expect(decode({ action: "desktop.key", ...base, expected_revision: "rev", key: "super+c", duration_ms: 120 })).toMatchObject({ key: "super+c", duration_ms: 120 })
    expect(() => decode({ action: "desktop.key", ...base, expected_revision: "rev", key: "hyper+c" })).toThrow()
  })

  test("accepts history read operations", () => {
    expect(decode({ action: "desktop.history", op: "list" })).toMatchObject({ action: "desktop.history", op: "list" })
    expect(decode({ action: "desktop.history", op: "read", id: "2026-11-04T10-00-00.000Z-ses_a", limit: 5 })).toMatchObject({ op: "read", limit: 5 })
    expect(() => decode({ action: "desktop.history", op: "wipe" })).toThrow()
  })
})
