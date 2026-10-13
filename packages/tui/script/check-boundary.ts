import ts from "typescript"
import path from "node:path"

const repository = path.resolve(import.meta.dir, "../../..")
const manifest = await Bun.file(path.join(import.meta.dir, "../package.json")).json()
const entries = Object.values(manifest.exports).filter(
  (value): value is string => typeof value === "string" && !value.includes("*"),
)
const pending = entries.map((entry) => path.resolve(import.meta.dir, "..", entry))
const seen = new Set<string>()
const violations: { file: string; importer?: string }[] = []
const edges: { from: string; to: string }[] = []
while (pending.length) {
  const file = pending.pop()!
  if (seen.has(file)) continue
  seen.add(file)
  if (
    file.startsWith(path.join(repository, "packages/core/")) ||
    file.startsWith(path.join(repository, "packages/server/"))
  )
    violations.push({ file: path.relative(repository, file), importer: edges.find((edge) => edge.to === file)?.from })
  if (!/\.[cm]?[jt]sx?$/.test(file) || file.includes("/node_modules/")) continue
  const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier))
      specifiers.push(node.moduleSpecifier.text)
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text)
    node.forEachChild(visit)
  }
  visit(source)
  for (const specifier of specifiers.filter((value) => value.startsWith(".") || value.startsWith("@ycoding-ai/"))) {
    const target = Bun.resolveSync(specifier, path.dirname(file))
    edges.push({ from: path.relative(repository, file), to: target })
    pending.push(target)
  }
}
console.log(JSON.stringify({ entries, resolvedModules: seen.size, resolvedEdges: edges.length, violations }, null, 2))
if (violations.length) process.exit(1)
