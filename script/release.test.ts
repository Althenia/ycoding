import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const workflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/release.yml")).text()
const testWorkflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/test.yml")).text()
const checks = workflow.split("\n").filter((line) => line.trim().startsWith("tar -tz"))

for (const valid of [true, false])
  test(
    valid ? "archive checks consume complete listings" : "archive checks reject missing executable and helper",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-release-check-"))
      try {
        const entries = path.join(root, "entries")
        await fs.mkdir(entries)
        await Bun.write(path.join(entries, "ycoding"), "synthetic executable\n")
        if (valid) {
          await fs.chmod(path.join(entries, "ycoding"), 0o755)
          await Bun.write(path.join(entries, "ycoding-computer-helper"), "synthetic helper\n")
          await fs.chmod(path.join(entries, "ycoding-computer-helper"), 0o755)
        }
        // Exceed the pipe buffer after the first match to expose an early-closing grep.
        for (let index = 0; index < 500; index++)
          await Bun.write(path.join(entries, `${index}-${"fixture".repeat(20)}`), "synthetic listing entry\n")
        const archive = path.join(root, "archive.tar.gz")
        const create = Bun.spawn(
          [
            "tar",
            "-czf",
            archive,
            "-C",
            entries,
            "ycoding",
            ...(valid ? ["ycoding-computer-helper"] : []),
            ...(await fs.readdir(entries)).filter((name) => !name.startsWith("ycoding")),
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        expect(await create.exited).toBe(0)
        expect(checks.length).toBeGreaterThan(0)
        for (const check of checks) {
          const command = check.trim().replace(/"release\/[^"]+"/, '"$ARCHIVE"')
          // BSD tar can hide EPIPE; cat preserves a producer failure like GNU tar in release CI.
          const result = Bun.spawn(
            ["bash", "-o", "pipefail", "-c", `tar() { command tar "$@" > "$LISTING" && cat "$LISTING"; }; ${command}`],
            {
              env: { ...process.env, ARCHIVE: archive, LISTING: path.join(root, "listing") },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const error = await new Response(result.stderr).text()
          expect((await result.exited) === 0, `${command}: ${error}`).toBe(valid)
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
  )

test("release workflow ships no Godot desktop client", () => {
  expect(workflow).not.toMatch(/godot/i)
  expect(workflow).not.toMatch(/\boffice\b/i)
})

test("release workflow packages and checksums every CLI archive", () => {
  expect(workflow).toContain(
    'tar -C unpacked/ycoding-darwin-arm64 -czf "release/ycoding-$version-darwin-arm64.tar.gz" ycoding ycoding-computer-helper',
  )
  expect(workflow).toContain(
    'tar -C unpacked/ycoding-darwin-x64 -czf "release/ycoding-$version-darwin-x64.tar.gz" ycoding ycoding-computer-helper',
  )
  expect(workflow).toContain(
    'tar -C unpacked/ycoding-linux-x64 -czf "release/ycoding-$version-linux-x64.tar.gz" ycoding',
  )
  expect(workflow).toContain('zip "../../release/ycoding-$version-windows-x64.zip" ycoding.exe')
  expect(workflow).toContain(
    '(cd release && sha256sum "ycoding-$version-"*.tar.gz "ycoding-$version-"*.zip > "ycoding-$version-checksums.txt")',
  )
  expect(workflow).toContain("needs: [build, isolated-browser-acceptance]")
})

test("release workflow verifies the web application and relay before the Cloudflare build", () => {
  expect(workflow).toContain("bun run test:web")
  expect(workflow).toContain("bun run test:remote")
  expect(workflow).toContain("bun run build:web")
  expect(workflow).toContain("bun run test:cloudflare")
  expect(workflow).toContain("bun run build:cloudflare")
  expect(workflow.indexOf("bun run build:web")).toBeLessThan(workflow.indexOf("bun run build:cloudflare"))
  // CLI, helper, and isolated-browser release checks stay in place.
  expect(workflow).toContain("bun run test:integration:browser")
  expect(workflow).toContain("isolated-browser-smoke.ts")
})

test("test workflow verifies the web application and relay before the Cloudflare build", () => {
  expect(testWorkflow).toContain("bun run test:web")
  expect(testWorkflow).toContain("bun run test:remote")
  expect(testWorkflow).toContain("bun run build:web")
  expect(testWorkflow).toContain("bun run test:cloudflare")
  expect(testWorkflow).toContain("bun run build:cloudflare")
  expect(testWorkflow.indexOf("bun run build:web")).toBeLessThan(testWorkflow.indexOf("bun run build:cloudflare"))
})

test("web integration gates run against built artifacts in both workflows", () => {
  for (const content of [workflow, testWorkflow]) {
    expect(content).toContain("bun run test:integration:web")
    expect(content.indexOf("bun run build:web")).toBeLessThan(content.indexOf("bun run test:integration:web"))
  }
})

test("remote integration gate runs the composed real flow after the web build in both workflows", async () => {
  const rootPackage = JSON.parse(await Bun.file(path.join(import.meta.dir, "../package.json")).text())
  expect(rootPackage.scripts["test:integration:remote"]).toBe("bun infra/cloudflare/test/integration/real-flow.ts")
  expect(await Bun.file(path.join(import.meta.dir, "../infra/cloudflare/test/integration/real-flow.ts")).exists()).toBe(
    true,
  )
  for (const content of [workflow, testWorkflow]) {
    expect(content).toContain("bun run test:integration:remote")
    expect(content.indexOf("bun run build:web")).toBeLessThan(content.indexOf("bun run test:integration:remote"))
  }
  expect(testWorkflow).toContain(
    [
      "      - name: Verify local remote integration",
      "        if: runner.os == 'Linux'",
      "        timeout-minutes: 20",
      "        run: bun run test:integration:remote",
    ].join("\n"),
  )
  expect(workflow).toContain(
    [
      "      - name: Verify local remote integration",
      "        timeout-minutes: 20",
      "        run: bun run test:integration:remote",
    ].join("\n"),
  )
})

test("obsolete Pages publishing is replaced by the web asset publisher", async () => {
  expect(await Bun.file(path.join(import.meta.dir, "../.github/workflows/pages.yml")).exists()).toBe(false)
  expect(await Bun.file(path.join(import.meta.dir, "pages.ts")).exists()).toBe(false)
  expect(await Bun.file(path.join(import.meta.dir, "pages.test.ts")).exists()).toBe(false)
  expect(await Bun.file(path.join(import.meta.dir, "build-pages.ts")).exists()).toBe(false)
  expect(await Bun.file(path.join(import.meta.dir, "build-web-assets.ts")).exists()).toBe(true)
  expect(workflow).toContain("script/build-web-assets.test.ts")
  expect(workflow).not.toContain("script/pages.test.ts")
})
