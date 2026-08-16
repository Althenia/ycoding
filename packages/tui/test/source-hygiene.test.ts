import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { DEFAULT_THEMES } from "../src/theme"
import { ThemeFile } from "../src/theme/v2"
import { resolveThemeFile } from "../src/theme/v2/resolve"
import { themeModes } from "../src/theme/v2/select"

const root = path.resolve(import.meta.dir, "..")

describe("TUI current-only surface", () => {
  test("contains no V1 config, theme, or command compatibility", async () => {
    const denied = [
      "src/config/v1",
      "src/theme/v1",
      "v1-migrate",
      "command-shim",
      "TuiConfigV1",
      "Legacy `api.command`",
    ]
    const matches: string[] = []
    for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: root })) {
      const source = await Bun.file(path.join(root, file)).text()
      for (const value of denied) {
        if (source.includes(value)) matches.push(`${file}: ${value}`)
      }
    }

    const manifest = await Bun.file(path.join(root, "package.json")).json()
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
