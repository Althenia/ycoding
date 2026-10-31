import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSourceFile, isCallExpression, isFunctionDeclaration, isObjectLiteralExpression, isPropertyAssignment, isSpreadAssignment, ScriptTarget, type Node } from "typescript"
import { museBuildDefinitions } from "./muse-build-env"

test("release OAuth secrets are supplied only to the TUI build step", async () => {
  const workflow = await Bun.file(new URL("../../../.github/workflows/release.yml", import.meta.url)).text()
  const step = workflow.split("      - name: Build TUI artifact\n")[1]?.split("\n      - name:")[0] ?? ""
  expect(step).toContain("        run: bun run build:tui")
  for (const name of ["YCODING_MUSE_CLIENT_ID", "YCODING_MUSE_CLIENT_SECRET"]) {
    expect(step).toContain(`          ${name}: \${{ secrets.${name} }}`)
    expect(workflow.split(name)).toHaveLength(3)
  }
})

test("build definitions preserve selected credentials and distinguish missing and empty values", () => {
  const env = { YCODING_MUSE_CLIENT_ID: 'synthetic-id-"\\\n雪', YCODING_MUSE_CLIENT_SECRET: "synthetic-secret-'\"\\\n${literal}&=雪", UNRELATED: "synthetic-unrelated" }
  for (const [input, expected] of [
    [env, { clientID: env.YCODING_MUSE_CLIENT_ID, clientSecret: env.YCODING_MUSE_CLIENT_SECRET }],
    [{}, {}],
    [{ YCODING_MUSE_CLIENT_ID: "synthetic-id" }, { clientID: "synthetic-id" }],
    [{ YCODING_MUSE_CLIENT_SECRET: "synthetic-secret" }, { clientSecret: "synthetic-secret" }],
    [{ YCODING_MUSE_CLIENT_ID: "", YCODING_MUSE_CLIENT_SECRET: "" }, { clientID: "", clientSecret: "" }],
  ]) expect(JSON.parse(museBuildDefinitions(input).YCODING_MUSE_OAUTH)).toEqual(expected)
  expect(museBuildDefinitions(env).YCODING_MUSE_OAUTH).not.toContain(env.UNRELATED)
})

test("build owners spread Muse definitions into their define objects", async () => {
  for (const [file, owner, importPath] of [["./build.ts", "Bun.build", "./muse-build-env"], ["../vite.node.config.ts", "mainConfig", "./script/muse-build-env"]]) {
    const source = await Bun.file(new URL(file, import.meta.url)).text()
    expect(source).toContain(`import { museBuildDefinitions } from "${importPath}"`)
    const tree = createSourceFile(file, source, ScriptTarget.Latest, true)
    const defines: Node[] = []
    const visit = (node: Node) => {
      if (isPropertyAssignment(node) && node.name.getText(tree) === "define" && isObjectLiteralExpression(node.initializer)) defines.push(node.initializer)
      node.forEachChild(visit)
    }
    visit(tree)
    expect(source).toContain(owner)
    expect(defines.some((node) => {
      if (!isObjectLiteralExpression(node) || !node.properties.some((property) => isSpreadAssignment(property) && property.expression.getText(tree) === "museBuildDefinitions()")) return false
      for (const ancestor of ancestors(node)) {
        if (owner === "Bun.build" && isCallExpression(ancestor) && ancestor.expression.getText(tree) === owner) return true
        if (owner === "mainConfig" && isFunctionDeclaration(ancestor) && ancestor.name?.text === owner) return true
      }
      return false
    })).toBe(true)
    if (owner === "Bun.build") {
      const calls: Node[] = []
      const find = (node: Node) => { if (isCallExpression(node) && node.expression.getText(tree) === owner) calls.push(node); node.forEachChild(find) }
      find(tree)
      expect(calls).toHaveLength(1)
    }
  }
})

function ancestors(node: Node): Node[] {
  const result: Node[] = []
  for (let current = node.parent; current; current = current.parent) result.push(current)
  return result
}

test("the packaged fixture restores absent, empty, and nonempty OAuth environment values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-muse-restore-"))
  try {
    const wrapper = path.join(directory, "restore.test.ts")
    await Bun.write(wrapper, `
      import { afterAll } from "bun:test"
      const names = ["YCODING_MUSE_CLIENT_ID", "YCODING_MUSE_CLIENT_SECRET"]
      const original = names.map(name => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }))
      await import(${JSON.stringify(fileURLToPath(new URL("./muse-build.test.ts", import.meta.url)))})
      afterAll(() => {
        const restored = original.every(item => Object.hasOwn(process.env, item.name) === item.present && process.env[item.name] === item.value)
        process.stderr.write(restored ? "environment-restored\\n" : "environment-not-restored\\n")
        if (!restored) throw new Error("Fixture environment was not restored")
      })
    `)
    for (const env of [{}, { YCODING_MUSE_CLIENT_ID: "synthetic-id", YCODING_MUSE_CLIENT_SECRET: "" }, { YCODING_MUSE_CLIENT_ID: "", YCODING_MUSE_CLIENT_SECRET: "synthetic-secret" }]) {
      const child = Bun.spawn([process.execPath, "test", wrapper, "-t", "keeps OAuth inputs synthetic while the fixture is active"], { cwd: directory, env: { PATH: process.env.PATH, HOME: directory, ...env }, stdout: "pipe", stderr: "pipe", timeout: 20_000 })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(code, stderr).toBe(0)
      expect(stderr).toContain("environment-restored")
      expect(stderr).not.toContain("environment-not-restored")
      for (const value of ["synthetic-id", "synthetic-secret"]) expect(stdout + stderr).not.toContain(value)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
