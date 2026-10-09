import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../src")

// Every built-in tool the internal plugin registers. A value-import cycle from one of these back
// to itself through the plugin supervisor leaves a layer node in its temporal dead zone when the
// Node bundle evaluates, which the Bun runtime hides; the packaged CLI then fails at startup.
const registered = readFileSync(path.join(root, "plugin/internal.ts"), "utf8")
const tools = [...registered.matchAll(/^import \{ \w+ \} from "\.\.\/tool\/([\w-]+)"/gm)].map((match) => match[1]!)

function resolveImport(from: string, specifier: string) {
  if (!specifier.startsWith(".")) return undefined
  const base = path.resolve(path.dirname(from), specifier)
  return [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((candidate) => existsSync(candidate))
}

function valueImports(file: string) {
  return [...readFileSync(file, "utf8").matchAll(/^import\s+(?!type\s)[^"']*from\s+"([^"]+)"/gm)]
    .map((match) => resolveImport(file, match[1]!))
    .filter((dependency): dependency is string => dependency !== undefined)
}

function cycleBackTo(target: string) {
  const stack: string[] = []
  const seen = new Set<string>()
  const visit = (file: string): readonly string[] | undefined => {
    if (file === target && stack.length > 0) return [...stack, file]
    if (seen.has(file)) return undefined
    seen.add(file)
    stack.push(file)
    for (const dependency of valueImports(file)) {
      const found = visit(dependency)
      if (found) return found
    }
    stack.pop()
    return undefined
  }
  return visit(target)
}

describe("built-in tool modules", () => {
  test("registers at least the scope tool", () => {
    expect(tools).toContain("scope")
  })

  for (const tool of tools) {
    test(`${tool} has no value-import cycle back through the plugin supervisor`, () => {
      const cycle = cycleBackTo(path.join(root, `tool/${tool}.ts`))
      expect(cycle?.map((file) => path.relative(root, file))).toBeUndefined()
    })
  }
})
