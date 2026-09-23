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

test("one v tag verifies a shared note and publishes only the TUI GitHub release", () => {
  const verify = workflow.split("\n  verify-source:")[1]?.split("\n  build:")[0]
  const tui = workflow.split("\n  release-tui:")[1]?.split("\n  deploy-web:")[0]
  expect(workflow).toContain("      - v*")
  expect(workflow).not.toContain("      - tui-v*")
  expect(workflow).not.toContain("      - web-v*")
  expect(verify).toContain('release_notes="docs/releases/v$RELEASE_VERSION.md"')
  expect(verify).toContain("bun run test:web")
  expect(verify).toContain("bun run test:remote")
  expect(verify).toContain("bun run test:integration:web")
  expect(verify).toContain("bun run test:integration:remote")
  expect(verify).toContain("bun run build:cloudflare")
  expect(tui).toContain("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  expect(tui).toContain('gh release create "v$version"')
  expect(tui).toContain('"docs/releases/v$version.md" --verify-tag')
  expect(tui).toContain('test("^v[0-9]")')
  expect(tui).toContain('test(\\"^v[0-9]\\")')
  expect(tui).toContain("contents: write")
  expect((workflow.match(/gh release create /g) ?? []).length).toBe(1)
})

test("the first unified release has nonempty shared notes", async () => {
  const notes = Bun.file(path.join(import.meta.dir, "../docs/releases/v0.6.5.md"))
  expect(await notes.exists()).toBe(true)
  expect((await notes.text()).trim()).toContain("# YCoding v0.6.5")
})

test("same v tag deploys web after the shared checks without GitHub write access", () => {
  const deploy = workflow.split("\n  deploy-web:")[1]
  expect(deploy).toContain("needs: [verify-source, package]")
  expect(deploy).toContain("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  expect(deploy).toContain("bun run build:web")
  expect(deploy).toContain("bun run deploy:cloudflare")
  expect(deploy?.indexOf("bun run build:web")).toBeLessThan(deploy?.indexOf("bun run deploy:cloudflare") ?? -1)
  expect(deploy).not.toContain("gh release")
  expect(deploy).not.toContain("GH_TOKEN:")
  expect(deploy).not.toContain("contents: write")
  expect(workflow).not.toContain("verify-source-web:")
})

test("GitHub Release publication waits for successful web deployment", () => {
  const tui = workflow.split("\n  release-tui:")[1]?.split("\n  deploy-web:")[0]
  expect(tui).toContain("needs: deploy-web")
  expect(tui).toContain("github.event_name == 'push'")
  expect(workflow.split("\n  deploy-web:")[1]).toContain("needs: [verify-source, package]")
})

test("Cloudflare deployment requires a scoped Actions token before Wrangler runs", () => {
  const deploy = workflow.split("\n  deploy-web:")[1]
  expect(deploy).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}")
  expect(deploy).toContain('test -n "$CLOUDFLARE_API_TOKEN"')
  expect(deploy?.indexOf('test -n "$CLOUDFLARE_API_TOKEN"')).toBeLessThan(
    deploy?.indexOf("bun run deploy:cloudflare") ?? -1,
  )
})

test("manual release runs prepare assets without publishing or deploying", () => {
  const prepare = workflow.split("\n  build:")[1]?.split("\n  release-tui:")[0]
  expect(prepare).toContain("github.event_name == 'workflow_dispatch'")
  expect(workflow).toContain("workflow_dispatch:")
  expect(workflow.split("\n  release-tui:")[1]).toContain("github.event_name == 'push'")
  expect(workflow.split("\n  deploy-web:")[1]).toContain("github.event_name == 'push'")
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
