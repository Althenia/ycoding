import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TerminalColors } from "@opentui/core"
import { DEFAULT_THEMES, addTheme, allThemes, hasTheme } from "../src/theme"
import { resolveThemeFile } from "../src/theme/resolve"
import { discoverThemes, themeDirectories } from "../src/theme/discovery"
import { terminalMode } from "../src/theme/system"
import type { ThemeFile } from "../src/theme"
import { tmpdir } from "./fixture/fixture"

test("default themes export ycoding without inherited OC theme identifiers", () => {
  expect(DEFAULT_THEMES.ycoding).toBeDefined()
  expect(DEFAULT_THEMES["oc-2"]).toBeUndefined()
})

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  expect(addTheme(name, DEFAULT_THEMES.ycoding)).toBe(true)
  expect(allThemes()[name]).toBeDefined()
})

test("addTheme keeps first current theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = withDarkText(DEFAULT_THEMES.ycoding!, "#101010")
  const two = withDarkText(DEFAULT_THEMES.ycoding!, "#fefefe")

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)
  expect(allThemes()[name]!.dark?.text?.default).toBe("#101010")
})

test("addTheme rejects non-current theme files", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { theme: { primary: "#ffffff" } })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, DEFAULT_THEMES.ycoding)).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

test("resolving a theme file rejects circular color references", () => {
  const item = DEFAULT_THEMES.ycoding!
  const dark = item.dark!
  const circular: ThemeFile = {
    ...item,
    dark: {
      ...dark,
      text: {
        ...dark.text,
        default: "$text.subdued",
        subdued: "$text.default",
      },
    },
  }

  expect(() => resolveThemeFile(circular, "dark")).toThrow("Circular theme reference")
})

test("theme files resolve semantic selection roles without presentation opacity", () => {
  const theme = resolveThemeFile(DEFAULT_THEMES.ycoding!, "dark")
  expect(theme.text.action.primary.selected).toBeDefined()
  expect(theme.text.action.primary.focused).toBeDefined()
  expect("thinkingOpacity" in theme).toBe(false)
})

function withDarkText(file: ThemeFile, color: `#${string}`): ThemeFile {
  const dark = file.dark
  if (!dark) throw new Error("Expected a dark theme mode")
  return { ...file, dark: { ...dark, text: { ...dark.text, default: color } } }
}

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})

test("theme directories include global config before project directories", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "repo", "package")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, ".ycoding", "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "global.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, ".ycoding", "themes", "project.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes(themeDirectories(global, project))).resolves.toEqual({
    global: { source: "global" },
    project: { source: "project" },
  })
})
