import { describe, expect, test } from "bun:test"

/**
 * The documentation column is a fixed-width track, so an unbreakable inline value
 * inside prose widens the whole page instead of wrapping in its column. Measured
 * in Chrome for Testing 152 against the built site at a 320px viewport:
 *
 * - `/docs/configuration`: a paragraph's `` `YCODING_CONFIG_PROJECT_DISABLE` ``
 *   run is 305.2 pixels wide in a 280 pixel column, so `document.scrollWidth`
 *   became 325 for a 320 pixel viewport.
 * - `/docs/usage/sessions`: a list item's `` `compaction.keep_recent_messages`. ``
 *   run is 282 pixels wide in the same column, so the document became 322 wide.
 *
 * Code blocks and wide tables scroll inside their own box by design, so the wrap
 * policy belongs to prose and must not be applied to them. The redesign renamed the
 * article container from `.docs__content` to `.docs-article`; the policy moved with it.
 */
const BREAK_CAPABLE = ["anywhere", "break-word"]

describe("documentation prose wrapping", () => {
  test("lets long values wrap inside the documentation column", async () => {
    const rules = await rulesOf("docs.css")
    for (const selector of [".docs-article p", ".docs-article li"]) {
      const declared = declaredValue(rules, selector, "overflow-wrap") ?? ""
      expect(BREAK_CAPABLE, `${selector} overflow-wrap`).toContain(declared)
    }
  })

  test("keeps code blocks and wide tables inside their own scroll container", async () => {
    const rules = await rulesOf("base.css")
    expect(declaredValue(rules, ".table-scroll", "overflow-x")).toBe("auto")
    expect(declaredValue(rules, ".code-block pre", "overflow-x")).toBe("auto")
    expect(declaredValue(rules, ".output", "overflow-x")).toBe("auto")
  })
})

type Declarations = Record<string, string>

/**
 * Indexes unconditional rules by selector. Rules nested inside an at-rule are
 * skipped: a wrap policy that only applies above a breakpoint would not fix the
 * narrow viewport this defect appears at.
 */
function parseRules(css: string): Map<string, Declarations> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const rules = new Map<string, Declarations>()
  let index = 0
  let selector = ""
  while (index < source.length) {
    const character = source[index]!
    if (character === "{") {
      const end = matchingBrace(source, index)
      if (!selector.trim().startsWith("@")) record(rules, selector, declarationsOf(source.slice(index + 1, end)))
      selector = ""
      index = end + 1
      continue
    }
    if (character === "}") {
      selector = ""
      index += 1
      continue
    }
    selector += character
    index += 1
  }
  return rules
}

function matchingBrace(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1
    if (source[index] === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error("unbalanced css block")
}

function record(rules: Map<string, Declarations>, selectors: string, declarations: Declarations): void {
  for (const selector of selectors
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)) {
    rules.set(selector, { ...rules.get(selector), ...declarations })
  }
}

function declarationsOf(block: string): Declarations {
  return Object.fromEntries(
    block
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separator = entry.indexOf(":")
        return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]
      }),
  )
}

function declaredValue(rules: Map<string, Declarations>, selector: string, property: string): string | undefined {
  return rules.get(selector)?.[property]
}

async function rulesOf(name: string): Promise<Map<string, Declarations>> {
  return parseRules(await Bun.file(new URL(name, import.meta.url)).text())
}
