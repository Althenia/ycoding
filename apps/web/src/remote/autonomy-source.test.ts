import { expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"
import ts from "typescript"

const root = path.join(import.meta.dir, "..")
const removed = /\b(setYolo|setAutoPermission|setAutoGuardrail|setAutoAnswer|autoPermission|autoGuardrail|autoAnswer|permissionsAuto|ordinaryReviewsAuto|permissionModelReviews|yoloLabel|autonomyDeciders)\b|"auto-(permission|guardrail|answer)"|\/yolo\b/

test("no web source reads or writes the removed independent autonomy flags or slash commands", async () => {
  const offenders: string[] = []
  for await (const file of new Glob("**/*.{ts,tsx,css}").scan({ cwd: root })) {
    if (/\.test\.tsx?$/.test(file) || file === "content/changelog.ts") continue
    const source = await Bun.file(path.join(root, file)).text()
    offenders.push(...removedAutonomyLines(source, file).map(line => `${file}:${line}`))
  }
  expect(offenders).toEqual([])
})

for (const operator of ["===", "!==", "==", "!="]) test(`canonical attribution comparisons permit ${operator} without restoring a control`, () => {
  for (const source of [
    `source.via ${operator} "auto-answer"`,
    `"auto-answer" ${operator} source.via`,
    `source?.via ${operator} "auto-answer"`,
    `((source.via)) ${operator} (("auto-answer"))`,
    `source.via\n${operator}\n"auto-answer"`,
    `const view = <span>{source.via ${operator} "auto-answer" ? "Auto" : "Other"}</span>`,
  ]) expect(removedAutonomyLines(source)).toEqual([])
})

test("every retired symbol, control and command remains rejected beside a real attribution comparison", () => {
  for (const source of [
    ...["setYolo", "setAutoPermission", "setAutoGuardrail", "setAutoAnswer", "autoPermission", "autoGuardrail", "autoAnswer", "permissionsAuto", "ordinaryReviewsAuto", "permissionModelReviews", "yoloLabel", "autonomyDeciders"].map(name => `source.${name}`),
    'const control = "auto-permission"',
    'const control = "auto-guardrail"',
    'const control = "auto-answer"',
    'const command = "/yolo"',
    'const command = "/yolo on"',
  ]) {
    expect(removedAutonomyLines(source)).toEqual([1])
    expect(removedAutonomyLines(`source.via === "auto-answer"; ${source}`)).toEqual([1])
    expect(removedAutonomyLines(`${source}; source.via === "auto-answer"`)).toEqual([1])
  }
})

test("comments, displayed comparisons and other literal uses do not earn an attribution exception", () => {
  for (const source of [
    '// source.via === "auto-answer"',
    '/* source.via === "auto-answer" */',
    `const message = 'source.via === "auto-answer"'`,
    'const message = `source.via === "auto-answer"`',
    'const pattern = /source.via === "auto-answer"/',
    'const view = <span>source.via === "auto-answer"</span>',
    'const view = <button data-control="auto-answer" />',
    'const source = { via: "auto-answer" }',
    'source.kind === "auto-answer"',
    'source["via"] === "auto-answer"',
    'source.via = "auto-answer"',
    'source.via + "auto-answer"',
    'source.via === "auto-answer" || "auto-answer"',
    'source.via === "auto-answer"; // source.via === "auto-answer"',
  ]) expect(removedAutonomyLines(source)).toEqual([1])
})

test("offending line numbers stay one-based and unique after exact attribution literals are excluded", () => {
  expect(removedAutonomyLines('source.via === "auto-answer"\nconst control = "auto-answer", other = "auto-guardrail"\nsource.autoAnswer')).toEqual([2, 3])
})

test("CSS text cannot introduce a TypeScript attribution exception", () => {
  expect(removedAutonomyLines('a { content: \'source.via === "auto-answer"\'; }', "fixture.css")).toEqual([1])
})

test("the Autonomous trigger and dialog replace the YOLO trigger and popover in the footer", async () => {
  const source = await Bun.file(path.join(root, "remote/ui/status-bar.tsx")).text()
  expect(source).toContain("AutonomousDialog")
  expect(source).toContain("aria-haspopup=\"dialog\"")
  expect(source).not.toMatch(/session-status__yolo|yoloTrigger|type="checkbox"/)
})

test("the Autonomous dialog uses the shared Modal for focus containment, Escape, and focus return", async () => {
  const source = await Bun.file(path.join(root, "remote/ui/autonomous-dialog.tsx")).text()
  expect(source).toContain("<Modal")
  expect(source).toContain("returnFocus")
  expect(source).not.toContain("setTimeout")
})

function removedAutonomyLines(source: string, fileName = "fixture.tsx") {
  const matches = [...source.matchAll(new RegExp(removed, "g"))]
  if (matches.length === 0) return []
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest)
  const attribution = new Map<number, number>()
  const operand = (expression: ts.Expression): ts.Expression => ts.isParenthesizedExpression(expression) ? operand(expression.expression) : expression
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      const operands = [operand(node.left), operand(node.right)]
      const literal = operands.find(expression => ts.isStringLiteral(expression) && expression.text === "auto-answer")
      if (literal && operands.some(expression => ts.isPropertyAccessExpression(expression) && expression.name.text === "via")) {
        attribution.set(literal.getStart(file), literal.end)
      }
    }
    ts.forEachChild(node, visit)
  }
  if (/\.tsx?$/.test(fileName)) visit(file)
  return [...new Set(matches
    .filter(match => attribution.get(match.index) !== match.index + match[0].length)
    .map(match => file.getLineAndCharacterOfPosition(match.index).line + 1))]
}
