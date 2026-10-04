import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { DEFAULT_THEMES } from "../src/theme"
import { ThemeFile } from "../src/theme"
import { resolveThemeFile } from "../src/theme/resolve"
import { themeModes } from "../src/theme/select"

const root = path.resolve(import.meta.dir, "..")

describe("TUI current-only surface", () => {
  test("does not expose V1 theme, config, or command paths", async () => {
    const blocked = ["src/config/v1", "src/theme/v1", "src/config/v1-migrate", "src/command-shim"]
    expect(blocked.filter((entry) => existsSync(path.join(root, entry)))).toEqual([])
    const manifest = await Bun.file(path.join(root, "package.json")).json()
    const matches: string[] = []
    for (const [key, value] of Object.entries(manifest.exports as Record<string, string>)) {
      for (const deniedPath of ["/v1", "v1-migrate", "command-shim"]) {
        if (key.includes(deniedPath) || value.includes(deniedPath)) matches.push(`package.json: ${key} -> ${value}`)
      }
    }

    expect(matches).toEqual([])
  })

  test("resolves every built-in theme from a current theme file", () => {
    const decode = Schema.decodeUnknownSync(ThemeFile)
    for (const [name, input] of Object.entries(DEFAULT_THEMES)) {
      const file = decode(input)
      const modes = themeModes(file)
      expect(modes.length).toBeGreaterThan(0)
      for (const mode of modes) {
        expect(resolveThemeFile(file, mode, name).background.default).toBeDefined()
      }
    }
  })
})
