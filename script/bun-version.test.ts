import { expect, test } from "bun:test"
import path from "node:path"

test("workspace and build scripts run with the installed Bun without a version pin", async () => {
  const root = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(root.packageManager).toBe("bun@https://github.com/oven-sh/bun/releases/latest")
  const result = Bun.spawn(
    [
      "bun",
      "-e",
      'const { Script } = await import("./packages/script/src/index.ts"); if (Script.version !== "0.0.0-test") throw new Error("Unexpected script version")',
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, YCODING_CHANNEL: "test", YCODING_VERSION: "0.0.0-test" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  )
  const error = await new Response(result.stderr).text()
  expect(await result.exited, error).toBe(0)
})

test("Nix packaging and the pre-push hook do not enforce or patch a Bun version gate", async () => {
  expect(await Bun.file(new URL("../nix/ycoding.nix", import.meta.url)).text()).not.toContain("expectedBunVersionRange")
  const hook = await Bun.file(new URL("../.husky/pre-push", import.meta.url)).text()
  expect(hook).not.toContain("packageManager")
  expect(hook).toContain("bun typecheck")
})
