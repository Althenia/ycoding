import ts from "typescript"

const suites = ["callbacks", "parity", "stdlib", "regexp-math-test262", "promise", "lexical-test262"]
const matcherKind: Record<string, string> = {
  toEqual: "toEqual",
  toStrictEqual: "toEqual",
  toMatchObject: "toEqual",
  toBe: "toBe",
  toBeNull: "toBe",
  toHaveLength: "toBe",
  toContain: "toContain",
  toBeUndefined: "toEqual",
  toMatch: "toContain",
}
const literalPattern = (node: ts.Expression | undefined) => {
  if (node === undefined || !ts.isRegularExpressionLiteral(node)) return undefined
  const body = node.text.match(/^\/(.*)\/$/)?.[1]
  if (body === undefined || !/^(?:[^\\^$.*+?()[\]{}|]|\\[\\^$.*+?()[\]{}|/])*$/.test(body)) return undefined
  return JSON.stringify(body.replace(/\\(.)/g, "$1"))
}
const errorHelpers = new Set(["error", "toolError"])

type Observation = { observe: string; code: ts.Expression | string }
type Manual = { suite: string; test: string; file: string; rust: string }

const manual: Manual[] = await Bun.file(new URL("code-mode-manual.json", import.meta.url)).json()
const cases: Array<{
  suite: string
  line: number
  at: number
  test: string
  code: string
  observe: string
  assertion: string
  expected: unknown
}> = []
const excluded: Array<{ suite: string; line: number; at: number; test: string; reason: string }> = []
const covered = new Map<string, number>()

for (const suite of suites) {
  const original = Bun.spawnSync(["git", "show", `main:packages/codemode/test/${suite}.test.ts`])
  if (original.exitCode !== 0) throw new Error(`Cannot read committed suite ${suite}`)
  const text = original.stdout.toString()
  const source = ts.createSourceFile(suite, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node
  const calledName = (node: ts.Node) =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined
  const literal = (node: ts.Node | undefined) =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
  const visitTest = (node: ts.Node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "test") {
      ts.forEachChild(node, visitTest)
      return
    }
    const label = node.arguments[0]
    const body = node.arguments[1]
    if (label === undefined || !ts.isStringLiteral(label) || body === undefined) return
    const declarations: Array<{ name: string; initializer: ts.Expression; position: number }> = []
    const collect = (child: ts.Node) => {
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer !== undefined)
        declarations.push({ name: child.name.text, initializer: child.initializer, position: child.getStart(source) })
      ts.forEachChild(child, collect)
    }
    collect(body)
    const resolve = (value: ts.Expression): ts.Expression => {
      const target = unwrap(value)
      if (!ts.isIdentifier(target)) return target
      const declaration = declarations
        .filter((item) => item.name === target.text && item.position < target.getStart(source))
        .at(-1)
      return declaration === undefined ? target : resolve(declaration.initializer)
    }
    const awaitedCall = (value: ts.Expression) => {
      const target = resolve(value)
      return ts.isAwaitExpression(target) ? unwrap(target.expression) : undefined
    }
    const bindings = (site: ts.Node) => {
      for (let parent = site.parent; parent !== undefined && parent !== body; parent = parent.parent) {
        if (!ts.isForOfStatement(parent)) continue
        const declaration = parent.initializer
        if (!ts.isVariableDeclarationList(declaration) || !ts.isArrayBindingPattern(declaration.declarations[0]!.name))
          continue
        const names = declaration.declarations[0]!.name.elements.map((item) =>
          ts.isBindingElement(item) && ts.isIdentifier(item.name) ? item.name.text : "",
        )
        const rows: unknown[][] = new Function(`return (${resolve(parent.expression).getText(source)})`)()
        return { names, rows }
      }
      return undefined
    }
    const evaluate = (expression: ts.Expression, names: string[], row: unknown[]) =>
      new Function(...names, `return (${resolve(expression).getText(source)})`)(...row)
    const programOf = (call: ts.Expression | undefined) => {
      if (call === undefined || !ts.isCallExpression(call) || call.arguments[0] === undefined) return undefined
      if ((call.arguments[1]?.getText(source) ?? "").includes("limits")) return undefined
      return call.arguments[0]
    }
    const resultFields = ["warnings", "toolCalls", "logs", "truncated", "ok", "value"]
    const observations = (observed: ts.Expression, matcher: string): Observation[] | undefined => {
      const target = resolve(observed)
      const awaited = ts.isAwaitExpression(target) ? unwrap(target.expression) : undefined
      const name = awaited === undefined ? undefined : calledName(awaited)
      if ((matcher === "toMatchObject") !== (name === "withTool")) return undefined
      if ((matcher === "toHaveLength") !== (name === "logsOf")) return undefined
      const single = (observe: string, code: ts.Expression | string | undefined): Observation[] | undefined =>
        code === undefined ? undefined : [{ observe, code }]
      if (name === "value" || name === "withTool") return single("value", programOf(awaited))
      if (name === "pair" && ts.isCallExpression(awaited!) && awaited!.arguments.length === 2)
        return awaited!.arguments.map((code) => ({ observe: "value", code }))
      if (name === "logsOf") return single("logs.length", programOf(awaited))
      if (ts.isCallExpression(target) && target.expression.getText(source) === "ToolRuntime.copyOut") {
        const argument = target.arguments[0]
        if (argument === undefined || argument.getText(source).includes("undefined")) return undefined
        return single("value", `return (${argument.getText(source)})`)
      }
      if (ts.isPropertyAccessExpression(target)) {
        const holder = awaitedCall(target.expression)
        const holderName = holder === undefined ? undefined : calledName(holder)
        if (target.name.text === "length" && holderName === "logsOf") return single("logs.length", programOf(holder))
        if (["message", "kind"].includes(target.name.text) && holderName !== undefined && errorHelpers.has(holderName))
          return single(`error.${target.name.text}`, programOf(holder))
        if (holderName === "run" && resultFields.includes(target.name.text))
          return single(target.name.text, programOf(holder))
        const nested = unwrap(target.expression)
        if (
          ["message", "kind"].includes(target.name.text) &&
          ts.isPropertyAccessExpression(nested) &&
          nested.name.text === "error"
        ) {
          const failing = awaitedCall(nested.expression)
          if (failing !== undefined && calledName(failing) === "run")
            return single(`error.${target.name.text}`, programOf(failing))
        }
      }
      if (ts.isElementAccessExpression(target) && ts.isNumericLiteral(target.argumentExpression)) {
        const index = target.argumentExpression.text
        const holder = unwrap(target.expression)
        const logged = ts.isIdentifier(holder)
          ? awaitedCall(holder)
          : ts.isPropertyAccessExpression(holder) && holder.name.text === "logs"
            ? awaitedCall(holder.expression)
            : undefined
        const loggedName = logged === undefined ? undefined : calledName(logged)
        if (loggedName === "logsOf" || loggedName === "run") return single(`logs[${index}]`, programOf(logged))
      }
      return undefined
    }
    const exclude = (child: ts.Node, reason: string) =>
      excluded.push({ suite, line: line(node), at: line(child), test: label.text, reason })
    const seen = new Set<ts.Node>()
    const visit = (child: ts.Node) => {
      if (!ts.isCallExpression(child) || !ts.isPropertyAccessExpression(child.expression)) {
        ts.forEachChild(child, visit)
        return
      }
      const chain = child.expression
      const negated = ts.isPropertyAccessExpression(chain.expression) && chain.expression.name.text === "not"
      const assertion = chain.name.text
      const expectation = negated ? (chain.expression as ts.PropertyAccessExpression).expression : chain.expression
      if (
        !ts.isCallExpression(expectation) ||
        !ts.isIdentifier(expectation.expression) ||
        expectation.expression.text !== "expect"
      ) {
        ts.forEachChild(child, visit)
        return
      }
      seen.add(expectation)
      const observed = expectation.arguments[0]
      if (observed === undefined) return
      const matcher = negated ? `not.${assertion}` : assertion
      const supported = negated ? assertion === "toContain" : assertion in matcherKind
      const planned = supported
        ? observations(observed, assertion)?.filter(
            (item) => assertion !== "toBeUndefined" || item.observe === "warnings",
          )
        : undefined
      if (planned?.length === 0) {
        exclude(child, `matcher ${matcher} is only a literal assertion for omitted warnings`)
        return
      }
      if (planned === undefined) {
        exclude(
          child,
          supported
            ? "observation requires a host trace, custom tool, or postprocessing"
            : `matcher ${matcher} is not a literal assertion`,
        )
        return
      }
      const expectedNode = child.arguments[0]
      const resolvedExpected = expectedNode === undefined ? undefined : resolve(expectedNode)
      const expectedText =
        assertion === "toBeNull"
          ? "null"
          : assertion === "toBeUndefined"
            ? "[]"
            : assertion === "toMatch"
              ? literalPattern(resolvedExpected)
              : assertion === "toMatchObject" &&
                  resolvedExpected !== undefined &&
                  ts.isObjectLiteralExpression(resolvedExpected)
                ? resolvedExpected.properties
                    .filter(ts.isPropertyAssignment)
                    .find((item) => item.name.getText(source) === "value")
                    ?.initializer.getText(source)
                : resolvedExpected?.getText(source)
      if (expectedText === undefined) {
        exclude(child, "expected value requires specification setup")
        return
      }
      const emitted: typeof cases = []
      const loop = bindings(child)
      for (const plan of planned) {
        const fixed = typeof plan.code === "string" ? plan.code : literal(plan.code)
        const programs =
          fixed !== undefined
            ? [{ code: fixed, names: [] as string[], row: [] as unknown[] }]
            : loop === undefined
              ? []
              : loop.rows.map((row) => ({
                  code: evaluate(plan.code as ts.Expression, loop.names, row) as string,
                  names: loop.names,
                  row,
                }))
        if (programs.length === 0) {
          exclude(child, "program requires dynamic input")
          return
        }
        for (const program of programs) {
          try {
            const value: unknown = new Function(...program.names, `return (${expectedText})`)(...program.row)
            const portable = JSON.stringify(value, (_, item) =>
              item === undefined || (typeof item === "number" && !Number.isFinite(item)) ? Symbol("") : item,
            )
            if (portable === undefined) throw new Error("expected value is not portable JSON")
            emitted.push({
              suite,
              line: line(node),
              at: line(child),
              test: label.text,
              code: program.code,
              observe: plan.observe,
              assertion: negated ? `not.${assertion}` : matcherKind[assertion]!,
              expected: value,
            })
          } catch {
            exclude(child, "expected value requires specification setup")
            return
          }
        }
      }
      cases.push(...emitted)
    }
    ts.forEachChild(body, visit)
    const unclassified = (child: ts.Node) => {
      if (calledName(child) === "expect" && !seen.has(child)) exclude(child, "assertion is not a direct matcher call")
      ts.forEachChild(child, unclassified)
    }
    ts.forEachChild(body, unclassified)
  }
  visitTest(source)
}

const remaining = excluded.filter((item) => {
  const entry = manual.find((candidate) => candidate.suite === item.suite && candidate.test === item.test)
  if (entry === undefined) return true
  covered.set(`${item.suite}\0${item.test}`, (covered.get(`${item.suite}\0${item.test}`) ?? 0) + 1)
  return false
})
for (const entry of manual)
  if (!covered.has(`${entry.suite}\0${entry.test}`))
    throw new Error(`Manual coverage names no excluded assertion: ${entry.suite} / ${entry.test}`)
const manualCoverage = manual.map((entry) => ({
  ...entry,
  assertions: covered.get(`${entry.suite}\0${entry.test}`)!,
}))
await Bun.write(
  new URL("code-mode-assertions.json", import.meta.url),
  JSON.stringify({ cases, manual: manualCoverage, excluded: remaining }, null, 2) + "\n",
)
