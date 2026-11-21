import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"
import pkg from "../package.json"

const remoteControl = "src/remote-control/"
const operatorSkill = "src/remote-control/ycoding-operator-skill.ts"
const remoteHost = "src/remote-host.ts"

function specifiers(file: string, source: string) {
  const found: string[] = []
  function visit(node: ts.Node) {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          ? node.moduleReference.expression
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(node.expression) && node.expression.text === "require"))
              ? node.arguments[0]
              : undefined
    if (specifier && ts.isStringLiteralLike(specifier)) found.push(specifier.text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true))
  return found
}

function importsRemoteControl(file: string, source: string) {
  return specifiers(file, source).some((specifier) => {
    if (!specifier.startsWith(".")) return false
    const target = path.posix.join(path.posix.dirname(file), specifier).replace(/\.(?:[cm]?[jt]sx?)$/, "")
    return (
      (target === "src/remote-host" || target.startsWith("src/remote-control")) &&
      target !== operatorSkill.replace(/\.ts$/, "") &&
      !(file === operatorSkill && target === "src/remote-control/ycoding-operator.md")
    )
  })
}

const sdkHosts = ["src/plugin-host/sdk.ts", "src/node/plugin-runtime.promise.ts", "src/node/plugin-runtime.effect.ts"]
const sdkModules = ["@ycoding-ai/plugin", "@ycoding-ai/plugin/effect", "@ycoding-ai/plugin/tool", "@ycoding-ai/plugin/effect/tool"]
const typeOnlyHosts = ["src/native-process.ts", "src/server-process.ts", "src/user-app-api.d.ts"]
const launcherModule = "@ycoding-ai/plugin/effect/plugin"

function typeOnly(node: ts.Node) {
  if (!ts.isImportDeclaration(node) || !node.importClause) return false
  const clause = node.importClause
  if (clause.isTypeOnly) return true
  return (
    !clause.name &&
    !!clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  )
}

function allowed(file: string, specifier: string, isTypeOnly: boolean) {
  if (sdkHosts.includes(file)) return sdkModules.includes(specifier)
  if (typeOnlyHosts.includes(file)) return specifier === launcherModule && isTypeOnly
  return false
}

function forbidden(file: string, source: string) {
  function visit(node: ts.Node): boolean {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          ? node.moduleReference.expression
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(node.expression) && node.expression.text === "require"))
              ? node.arguments[0]
              : undefined
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      /^@ycoding-ai\/(?:core|server|meeting|plugin)(?:\/|$)/.test(specifier.text) &&
      !allowed(file, specifier.text, typeOnly(node))
    )
      return true
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true))
}

test("CLI source and manifest keep execution behind the client boundary", async () => {
  const root = path.resolve(import.meta.dirname, "..")
  const files = Array.from(new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root }))
  const standalone = (file: string) => file === remoteHost || (file.startsWith(remoteControl) && file !== operatorSkill)
  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(path.join(root, file), "utf8") })),
  )
  expect(sources.filter(({ file, source }) => !standalone(file) && forbidden(file, source)).map((item) => item.file)).toEqual([])
  expect(
    sources.filter(({ file, source }) => !standalone(file) && importsRemoteControl(file, source)).map((item) => item.file),
  ).toEqual([])
  expect(pkg.files).toEqual(["bin", "lib"])
})

test("frontend files may import only the operator skill from remote-control", () => {
  expect(importsRemoteControl("src/index.ts", `import "./remote-control/backend"`)).toBe(true)
  expect(importsRemoteControl("src/a/b.ts", `import("../remote-control/cca-relay.js")`)).toBe(true)
  expect(importsRemoteControl("src/index.ts", `import "./remote-control/ycoding-operator-skill"`)).toBe(false)
  expect(importsRemoteControl("src/index.ts", `import "./other"`)).toBe(false)
  expect(importsRemoteControl("src/index.ts", `import "./remote-host"`)).toBe(true)
  expect(importsRemoteControl("src/a/b.ts", `import("../remote-host.js")`)).toBe(true)
})

test("only the plugin runtime hosts embed the public plugin SDK", () => {
  for (const host of sdkHosts) {
    for (const module of sdkModules) {
      expect(forbidden(host, `import("${module}")`)).toBe(false)
      expect(forbidden("src/index.ts", `import("${module}")`)).toBe(true)
    }
    for (const module of ["@ycoding-ai/core", "@ycoding-ai/server", "@ycoding-ai/meeting", "@ycoding-ai/plugin/tui"]) {
      expect(forbidden(host, `import("${module}")`)).toBe(true)
    }
  }
})

test("module registration keys and quoted metadata are not imports", () => {
  for (const module of [
    "@ycoding-ai/core",
    "@ycoding-ai/server",
    "@ycoding-ai/meeting",
    "@ycoding-ai/plugin/effect/plugin",
  ]) {
    const source = `const modules = { "${module}": {} }; const label = "${module}"`
    expect(forbidden("src/plugin-host/sdk.ts", source)).toBe(false)
    expect(forbidden("src/index.ts", source)).toBe(false)
  }
})

test("import syntax preserves the exact host-only SDK allowance", () => {
  const sources = (module: string) => [
    `import "${module}"`,
    `import type { Context } from "${module}"`,
    `export { Context } from "${module}"`,
    `import("${module}")`,
    `import(\`${module}\`)`,
    `require("${module}")`,
    `import Context = require("${module}")`,
    `type Context = typeof import("${module}")`,
  ]
  for (const module of [
    "@ycoding-ai/core",
    "@ycoding-ai/server",
    "@ycoding-ai/meeting",
    "@ycoding-ai/plugin/tui",
    "@ycoding-ai/plugin/effect/plugin",
  ]) {
    for (const source of sources(module)) {
      for (const host of sdkHosts) expect(forbidden(host, source)).toBe(true)
      expect(forbidden("src/index.ts", source)).toBe(true)
    }
  }
  for (const module of sdkModules) {
    for (const source of sources(module)) {
      for (const host of sdkHosts) expect(forbidden(host, source)).toBe(false)
      expect(forbidden("src/plugin-host/sdk-extra.ts", source)).toBe(true)
    }
  }
})

test("launcher files may only import the plugin launcher type", () => {
  for (const file of typeOnlyHosts) {
    expect(forbidden(file, `import type { Plugin } from "${launcherModule}"`)).toBe(false)
    expect(forbidden(file, `import { type Plugin } from "${launcherModule}"`)).toBe(false)
    expect(forbidden(file, `import { Plugin } from "${launcherModule}"`)).toBe(true)
    expect(forbidden(file, `import { type Plugin, make } from "${launcherModule}"`)).toBe(true)
    expect(forbidden(file, `import "${launcherModule}"`)).toBe(true)
    expect(forbidden(file, `import("${launcherModule}")`)).toBe(true)
    expect(forbidden(file, `import type { Plugin } from "@ycoding-ai/plugin"`)).toBe(true)
    for (const module of ["@ycoding-ai/core", "@ycoding-ai/server", "@ycoding-ai/meeting"]) {
      expect(forbidden(file, `import type { X } from "${module}"`)).toBe(true)
    }
  }
  expect(forbidden("src/index.ts", `import type { Plugin } from "${launcherModule}"`)).toBe(true)
})
