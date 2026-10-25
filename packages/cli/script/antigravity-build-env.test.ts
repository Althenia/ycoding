import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  createSourceFile,
  isCallExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  ScriptTarget,
  type CallExpression,
  type Node,
} from "typescript"
import { antigravityBuildDefinitions } from "./antigravity-build-env"

test("release OAuth secrets are supplied only to the TUI build step", async () => {
  const workflow = await Bun.file(new URL("../../../.github/workflows/release.yml", import.meta.url)).text()
  const step = workflow.split("      - name: Build TUI artifact\n")[1]?.split("\n      - name:")[0] ?? ""
  expect(step).toContain("        run: bun run build:tui")
  for (const name of ["YCODING_ANTIGRAVITY_CLIENT_ID", "YCODING_ANTIGRAVITY_CLIENT_SECRET"]) {
    expect(step).toContain(`          ${name}: \${{ secrets.${name} }}`)
    expect(workflow.split(name)).toHaveLength(3)
  }
})

test("build definitions serialize only the selected OAuth environment variables", () => {
  const env = {
    YCODING_ANTIGRAVITY_CLIENT_ID: 'synthetic-id-"\\\n雪',
    YCODING_ANTIGRAVITY_CLIENT_SECRET: "synthetic-secret-'\"\\\n${literal}&=雪",
    UNRELATED: "synthetic-unrelated",
  }
  expect(JSON.parse(antigravityBuildDefinitions(env).YCODING_ANTIGRAVITY_OAUTH)).toEqual({
    clientID: env.YCODING_ANTIGRAVITY_CLIENT_ID,
    clientSecret: env.YCODING_ANTIGRAVITY_CLIENT_SECRET,
  })
  expect(antigravityBuildDefinitions(env).YCODING_ANTIGRAVITY_OAUTH).not.toContain(env.UNRELATED)
})

test("absent, partial, and empty build credentials remain distinct for connection-time validation", () => {
  for (const [env, expected] of [
    [{}, {}],
    [{ YCODING_ANTIGRAVITY_CLIENT_ID: "synthetic-id" }, { clientID: "synthetic-id" }],
    [{ YCODING_ANTIGRAVITY_CLIENT_SECRET: "synthetic-secret" }, { clientSecret: "synthetic-secret" }],
    [
      { YCODING_ANTIGRAVITY_CLIENT_ID: "", YCODING_ANTIGRAVITY_CLIENT_SECRET: "" },
      { clientID: "", clientSecret: "" },
    ],
  ]) {
    expect(JSON.parse(antigravityBuildDefinitions(env).YCODING_ANTIGRAVITY_OAUTH)).toEqual(expected)
  }
})

test("the Bun build owner spreads the shared OAuth definitions into its actual build call", async () => {
  const source = await Bun.file(new URL("./build.ts", import.meta.url)).text()
  expect(source).toMatch(/import\s*\{\s*antigravityBuildDefinitions\s*\}\s*from\s*["']\.\/antigravity-build-env["']/)
  const tree = createSourceFile("build.ts", source, ScriptTarget.Latest, true)
  const calls: CallExpression[] = []
  const visit = (node: Node) => {
    if (isCallExpression(node) && node.expression.getText(tree) === "Bun.build") calls.push(node)
    node.forEachChild(visit)
  }
  visit(tree)
  expect(calls).toHaveLength(1)
  const options = calls[0].arguments[0]
  if (!isObjectLiteralExpression(options)) throw new Error("Expected a Bun build options object")
  const define = options.properties.find(
    (property) => isPropertyAssignment(property) && property.name.getText(tree) === "define",
  )
  if (!define || !isPropertyAssignment(define) || !isObjectLiteralExpression(define.initializer))
    throw new Error("Expected a Bun build define object")
  expect(
    define.initializer.properties.some(
      (property) =>
        isSpreadAssignment(property) && property.expression.getText(tree) === "antigravityBuildDefinitions()",
    ),
  ).toBe(true)
})

test("the packaged fixture restores absent, empty, and nonempty OAuth environment values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-antigravity-restore-"))
  try {
    const wrapper = path.join(directory, "restore.test.ts")
    await Bun.write(
      wrapper,
      `
      import { afterAll } from "bun:test"
      const names = ["YCODING_ANTIGRAVITY_CLIENT_ID", "YCODING_ANTIGRAVITY_CLIENT_SECRET"]
      const original = names.map(name => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }))
      await import(${JSON.stringify(fileURLToPath(new URL("./antigravity-build.test.ts", import.meta.url)))})
      afterAll(() => {
        const restored = original.every(item =>
          Object.hasOwn(process.env, item.name) === item.present && process.env[item.name] === item.value)
        process.stderr.write(restored ? "environment-restored\\n" : "environment-not-restored\\n")
        if (!restored) throw new Error("Fixture environment was not restored")
      })
    `,
    )
    for (const env of [
      {},
      { YCODING_ANTIGRAVITY_CLIENT_ID: "synthetic-id", YCODING_ANTIGRAVITY_CLIENT_SECRET: "" },
      { YCODING_ANTIGRAVITY_CLIENT_ID: "", YCODING_ANTIGRAVITY_CLIENT_SECRET: "synthetic-secret" },
    ]) {
      const child = Bun.spawn(
        [process.execPath, "test", wrapper, "-t", "keeps OAuth inputs synthetic while the fixture is active"],
        {
          cwd: directory,
          env: { PATH: process.env.PATH, HOME: directory, ...env },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, stderr).toBe(0)
      expect(stderr).toContain("environment-restored")
      expect(stderr).not.toContain("environment-not-restored")
      for (const value of ["synthetic-id", "synthetic-secret"]) expect(stdout + stderr).not.toContain(value)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
