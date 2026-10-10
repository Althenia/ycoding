import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const workflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/release.yml")).text()
const testWorkflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/test.yml")).text()
const checks = workflow.split("\n").filter((line) => line.trim().startsWith("tar -tz"))

for (const valid of [true, false])
  test(
    valid ? "archive checks consume complete listings" : "archive checks reject a missing executable and app",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-release-check-"))
      try {
        const entries = path.join(root, "entries")
        await fs.mkdir(entries)
        await Bun.write(path.join(entries, "ycoding"), "synthetic executable\n")
        if (valid) {
          await fs.chmod(path.join(entries, "ycoding"), 0o755)
          await Bun.write(path.join(entries, "YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use"), "synthetic app\n")
          await fs.chmod(path.join(entries, "YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use"), 0o755)
          await Bun.write(path.join(entries, "ycoding-chrome-extension/manifest.json"), "{}\n")
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
            ...(valid ? ["YCoding Computer Use.app", "ycoding-chrome-extension"] : []),
            ...(await fs.readdir(entries)).filter((name) => !name.toLowerCase().startsWith("ycoding")),
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
    'tar -C unpacked/ycoding-darwin-arm64 -czf "release/ycoding-$version-darwin-arm64.tar.gz" "${mac_entries[@]}"',
  )
  expect(workflow).toContain(
    'tar -C unpacked/ycoding-darwin-x64 -czf "release/ycoding-$version-darwin-x64.tar.gz" "${mac_entries[@]}"',
  )
  expect(workflow).toContain(
    'tar -C unpacked/ycoding-linux-x64 -czf "release/ycoding-$version-linux-x64.tar.gz" ycoding',
  )
  expect(workflow).toContain('zip -r "../../release/ycoding-$version-windows-x64.zip" ycoding.exe ycoding-chrome-extension')
  expect(workflow).toContain(
    '(cd release && sha256sum "ycoding-$version-"*.tar.gz "ycoding-$version-"*.zip LICENSE NOTICE > "ycoding-$version-checksums.txt")',
  )
  expect(workflow).toContain("needs: [build, isolated-browser-acceptance]")
})

test("macOS release builds sign the app with the pinned release certificate and never fall back to ad hoc", () => {
  const build = workflow.split("\n  build:")[1]?.split("\n  isolated-browser-acceptance:")[0] ?? ""
  const importStep = build.split("      - name: Import macOS signing identity")[1]?.split("      - name: Build TUI artifact")[0] ?? ""
  const stage = build.split("      - name: Stage native executables")[1]?.split("      - name: Upload native executables")[0] ?? ""
  expect(build).toContain("      YCODING_MACOS_SIGNING_IDENTITY: YCoding Code Signing")
  expect(build).toContain("      YCODING_MACOS_SIGNING_SHA1: 9dd524184b0db949ffac7f0ada0ae860ac7f5f85\n")
  expect(importStep).toContain("if: runner.os == 'macOS'")
  expect(importStep).toContain("YCODING_MACOS_SIGNING_P12: ${{ secrets.YCODING_MACOS_SIGNING_P12 }}")
  expect(importStep).toContain("YCODING_MACOS_SIGNING_PASSWORD: ${{ secrets.YCODING_MACOS_SIGNING_PASSWORD }}")
  expect(importStep).toContain('test -n "$YCODING_MACOS_SIGNING_P12" || { echo "Missing YCODING_MACOS_SIGNING_P12 Actions secret" >&2; exit 1; }')
  expect(importStep).toContain('test -n "$YCODING_MACOS_SIGNING_PASSWORD" || { echo "Missing YCODING_MACOS_SIGNING_PASSWORD Actions secret" >&2; exit 1; }')
  for (const command of [
    'security create-keychain -p "$keychain_password" "$keychain"',
    'security unlock-keychain -p "$keychain_password" "$keychain"',
    '-T /usr/bin/codesign',
    'security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"',
    'security list-keychains -d user -s "$keychain" ${original[@]+"${original[@]}"}',
    'echo "::add-mask::$keychain_password"',
  ])
    expect(importStep).toContain(command)
  expect(importStep).not.toContain("|| true")
  expect(importStep).not.toContain("login.keychain")
  expect(importStep).toContain('grep -F "$(printf \'%s\' "$YCODING_MACOS_SIGNING_SHA1" | tr a-f A-F) \\"$YCODING_MACOS_SIGNING_IDENTITY\\""')
  expect(build.indexOf("- name: Import macOS signing identity")).toBeLessThan(build.indexOf("- name: Build TUI artifact"))
  expect(stage).toContain('codesign --verify --deep --strict "$staging/YCoding Computer Use.app"')
  expect(stage).toContain('codesign -d -r- "$staging/YCoding Computer Use.app" 2>&1 | grep -Ex "designated => identifier')
  expect(build).toContain("if: ${{ always() && runner.os == 'macOS' }}")
  expect(build).toContain('security list-keychains -d user -s "${original[@]}"')
  expect(build).toContain('security delete-keychain "$keychain"')
  expect(workflow).not.toContain("codesign --force --sign -")
  expect(workflow).not.toContain("ad-hoc")
})

test("isolated-browser acceptance accepts installed Chrome 152 or newer", async () => {
  const browserHost = await Bun.file(
    path.join(import.meta.dir, "../.github/actions/verify-browser-host/action.yml"),
  ).text()
  const check = /\n(\s*major="\$\(printf[\s\S]*?\n\s*\})\n/.exec(browserHost)?.[1]
  expect(check).toBeDefined()
  const accepts = (version: string) =>
    Bun.spawnSync(["bash", "-euo", "pipefail", "-c", `version=${JSON.stringify(version)}\n${check}`], { stdout: "pipe", stderr: "pipe" })
      .exitCode === 0
  expect(accepts("Google Chrome 151.0.7000.10")).toBe(false)
  expect(accepts("Google Chrome 152.0.7100.20")).toBe(true)
  expect(accepts("Google Chrome 153.0.8010.54")).toBe(true)
  expect(accepts("Google Chrome 1000.0.1.2")).toBe(true)
  expect(accepts("Google Chrome")).toBe(false)
  expect(workflow).not.toContain("Chrome 152)")
})

test("release archives include the Chrome extension beside the executable", () => {
  expect(workflow).toContain('cp -R "dist/tui/tui-${{ matrix.target }}/bin/ycoding-chrome-extension" "$staging/"')
  expect(workflow).toContain('tar -C unpacked/ycoding-linux-x64 -czf "release/ycoding-$version-linux-x64.tar.gz" ycoding ycoding-chrome-extension')
  expect(workflow).toContain('zip -r "../../release/ycoding-$version-windows-x64.zip" ycoding.exe ycoding-chrome-extension')
  for (const target of ["darwin-arm64", "darwin-x64", "linux-x64"])
    expect(workflow).toContain(`tar -tzf "release/ycoding-$version-${target}.tar.gz" | grep -x 'ycoding-chrome-extension/manifest.json' >/dev/null`)
})

test("macOS release archives stage the signed app and preserve its bundle tree", () => {
  expect(workflow).toContain('cp -R "dist/tui/tui-${{ matrix.target }}/bin/YCoding Computer Use.app" "$staging/"')
  expect(workflow).toContain('codesign --verify --deep --strict "$staging/YCoding Computer Use.app"')
  expect(workflow).toContain('"unpacked/ycoding-darwin-arm64/YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use"')
  expect(workflow).toContain('app="unpacked/ycoding-$target/YCoding Computer Use.app"')
  expect(workflow).toContain("mac_entries=(ycoding ycoding-chrome-extension)")
  expect(workflow).toContain(`grep -x 'YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use'`)
  expect(workflow).not.toContain("bin/ycoding-computer-use")
  expect(workflow).toContain('mac_entries+=("YCoding Computer Use.app")')
  expect(workflow).toContain("Contents/Resources/YCoding.icns")
  expect(workflow).toContain(
    'test -f "$app/Contents/Resources/YCoding.icns" && test ! -L "$app/Contents/Resources/YCoding.icns" && test -s "$app/Contents/Resources/YCoding.icns"',
  )
  expect(workflow).toContain("<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>")
  const packageJob = workflow.split("\n  package:")[1]?.split("\n  release-tui:")[0]
  expect(packageJob).toContain("runs-on: ubuntu-24.04")
  expect(packageJob).toContain('find "$app" -mindepth 1 -printf')
})

const pin = "9dd524184b0db949ffac7f0ada0ae860ac7f5f85"

test.each([
  ["a self-signed root requirement", `identifier "app.ycoding.computer-use" and certificate root = H"${pin}"`, true],
  ["a self-signed leaf requirement", `identifier "app.ycoding.computer-use" and certificate leaf = H"${pin}"`, true],
  ["an ad-hoc cdhash requirement", 'cdhash H"1593f00c9269224608bcfc16986b4c7b1b09a2d5"', false],
  ["a different certificate", `identifier "app.ycoding.computer-use" and certificate leaf = H"${"0".repeat(40)}"`, false],
  ["a different identifier", `identifier "app.ycoding.other" and certificate leaf = H"${pin}"`, false],
  ["an unanchored identifier only", 'identifier "app.ycoding.computer-use"', false],
])("the release signature check accepts only the pinned certificate: %s", (_, requirement, accepted) => {
  const stage = workflow.split("      - name: Stage native executables")[1]?.split("      - name: Upload native executables")[0] ?? ""
  const check = stage.split("\n").find((line) => line.includes("codesign -d -r-"))?.trim()
  expect(check).toBeDefined()
  const command = check!.replace(/^codesign -d -r- "[^"]+" 2>&1/, 'printf "%s\\n" "designated => $REQUIREMENT"')
  const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", command], {
    env: { ...process.env, REQUIREMENT: requirement, YCODING_MACOS_SIGNING_SHA1: pin },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode === 0, result.stderr.toString()).toBe(accepted)
})

test("release archives keep the layout installed updaters accept and ship the license texts as separate assets", () => {
  expect(workflow).not.toContain('cp LICENSE NOTICE "$staging/"')
  expect(workflow).not.toMatch(/ycoding-chrome-extension LICENSE/)
  expect(workflow).toContain("cp LICENSE NOTICE release/\n")
  const packageJob = workflow.split("\n  package:")[1]?.split("\n  release-tui:")[0] ?? ""
  expect(packageJob.indexOf("cp LICENSE NOTICE release/")).toBeLessThan(packageJob.indexOf("sha256sum"))
  expect(workflow.split("\n  release-tui:")[1]).toContain("gh release create \"v$version\" release/*")
})

for (const extra of [undefined, "LICENSE", "NOTICE", "extra"])
  test(
    extra
      ? `the archive layout guard rejects an extra ${extra} entry`
      : "the archive layout guard accepts exactly the entries installed updaters accept",
    async () => {
      const guard = /\n *for target in darwin-arm64 darwin-x64 linux-x64; do\n *expected=[\s\S]*?\n(?= *cp LICENSE NOTICE release\/)/.exec(workflow)?.[0]
      expect(guard).toBeDefined()
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-release-layout-"))
      try {
        const source = path.join(root, "source")
        await fs.mkdir(path.join(source, "YCoding Computer Use.app/Contents"), { recursive: true })
        await fs.mkdir(path.join(source, "ycoding-chrome-extension"))
        for (const file of ["ycoding", "ycoding.exe", "ycoding-chrome-extension/manifest.json", "YCoding Computer Use.app/Contents/Info.plist", "LICENSE", "NOTICE", "extra"])
          await Bun.write(path.join(source, file), `${file}\n`)
        await fs.mkdir(path.join(root, "release"))
        const add = extra ? [extra] : []
        const mac = ["ycoding", "ycoding-chrome-extension", "YCoding Computer Use.app", ...add]
        for (const [name, entries] of [
          ["darwin-arm64", mac],
          ["darwin-x64", mac],
          ["linux-x64", ["ycoding", "ycoding-chrome-extension", ...add]],
        ] as const)
          expect(Bun.spawnSync(["tar", "-C", source, "-czf", path.join(root, `release/ycoding-9.9.9-${name}.tar.gz`), ...entries], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).exitCode).toBe(0)
        expect(
          Bun.spawnSync(["zip", "-qr", path.join(root, "release/ycoding-9.9.9-windows-x64.zip"), "ycoding.exe", "ycoding-chrome-extension", ...add], { cwd: source }).exitCode,
        ).toBe(0)
        const result = Bun.spawnSync(
          ["bash", "-euo", "pipefail", "-c", `version=9.9.9\nmac_entries=(ycoding ycoding-chrome-extension 'YCoding Computer Use.app')\n${guard}`],
          { cwd: root, stdout: "pipe", stderr: "pipe" },
        )
        expect(result.exitCode === 0, result.stderr.toString()).toBe(extra === undefined)
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
  )

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
  expect(tui?.match(/--title "[^"]+"/g)).toEqual(['--title "YCoding $version"'])
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
      "      - name: Build web application",
      "        if: matrix.suite == 'web' || matrix.suite == 'remote'",
      "        run: bun run build:web",
    ].join("\n"),
  )
  expect(workflow).toContain(
    [
      "      - name: Verify local remote integration",
      "        if: matrix.suite == 'remote'",
      "        timeout-minutes: 20",
      "        run: bun run test:integration:remote",
    ].join("\n"),
  )
})

test("release types verification checks cache invalidation before typechecking", () => {
  const step = workflow.split("      - name: Check workspace and types")[1]?.split("\n      - name:")[0] ?? ""
  const check = "bun test --cwd script ./typecheck-cache.integration.test.ts"
  expect(step).toContain("if: matrix.suite == 'types'")
  expect(step).toContain(check)
  expect(step.indexOf(check)).toBeLessThan(step.indexOf("bun run typecheck"))
})

test("source verification legs start in parallel with the native builds", () => {
  const verify = workflow.split("\n  verify-source:")[1]?.split("\n  build:")[0] ?? ""
  const build = workflow.split("\n  build:")[1]?.split("\n  isolated-browser-acceptance:")[0] ?? ""
  expect(verify).not.toContain("needs:")
  expect(build).not.toContain("needs:")
  expect(verify).toContain("fail-fast: false")
  expect(verify).toContain("runs-on: ${{ matrix.runner }}")
  expect([...verify.matchAll(/- suite: (\S+)/g)].map((match) => match[1])).toEqual([
    "types",
    "web",
    "remote",
    "cli",
    "tui",
    "browser",
  ])
  expect(verify).toContain(["          - suite: browser", "            runner: macos-26"].join("\n"))
  for (const [step, condition] of [
    ["Check workspace and types", "matrix.suite == 'types'"],
    ["Verify web application and relay", "matrix.suite == 'web'"],
    ["Build web application", "matrix.suite == 'web' || matrix.suite == 'remote'"],
    ["Verify built web integration", "matrix.suite == 'web'"],
    ["Verify local remote integration", "matrix.suite == 'remote'"],
    ["Verify Cloudflare Worker", "matrix.suite == 'web'"],
    ["Verify CLI suites", "matrix.suite == 'cli'"],
    ["Verify Chrome extension suites", "matrix.suite == 'cli'"],
    ["Verify transcript and approval suites", "matrix.suite == 'tui'"],
    ["Verify goal continuation", "matrix.suite == 'tui'"],
    ["Verify installer and web assets", "matrix.suite == 'web'"],
    ["Verify approved browser host", "matrix.suite == 'browser'"],
    ["Verify isolated-browser integration suites", "matrix.suite == 'browser'"],
    ["Provision Chrome for Testing", "matrix.suite == 'browser'"],
    ["Verify Chrome extension integration suite", "matrix.suite == 'browser'"],
  ])
    expect(verify).toContain(`      - name: ${step}\n        if: ${condition}\n`)
  expect(verify).toContain("uses: ./.github/actions/verify-browser-host")
  expect(verify).toContain("run: bun run test:extension")
  expect(verify).toContain("run: bun run test:integration:extension")
  expect(verify).toContain('executable="$(bun script/chrome-for-testing.ts "$RUNNER_TEMP/chrome-for-testing")"')
  expect(verify).toContain("YCODING_TEST_ISOLATED_BROWSER_CHROME=$executable")
  expect(verify).not.toContain("puppeteer")
  expect(verify).toContain('"$GITHUB_WORKSPACE/script/chrome-for-testing.test.ts"')
  expect(verify.indexOf("- name: Provision Chrome for Testing")).toBeLessThan(
    verify.indexOf("- name: Verify Chrome extension integration suite"),
  )
})

test("the packaged isolated-browser smoke waits for the native builds on the approved host", () => {
  const acceptance = workflow.split("\n  isolated-browser-acceptance:")[1]?.split("\n  package:")[0] ?? ""
  expect(acceptance).toContain("needs: build")
  expect(acceptance).toContain("runs-on: macos-26")
  expect(acceptance).toContain("uses: ./.github/actions/verify-browser-host")
  expect(acceptance).toContain("isolated-browser-smoke.ts")
  expect(acceptance).not.toContain("test:integration:browser")
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

const setupBun = await Bun.file(path.join(import.meta.dir, "../.github/actions/setup-bun/action.yml")).text()

test("setup installs the latest Bun on baseline and native runners without a version pin", () => {
  expect(setupBun).toContain("https://github.com/oven-sh/bun/releases/latest/download/bun-${OS}-x64-baseline.zip")
  expect(setupBun).toContain("bun-download-url: ${{ steps.bun-url.outputs.url }}")
  expect(setupBun).toMatch(/\n {8}bun-version: latest\n/)
  expect(setupBun).not.toContain("bun-version-file")
  expect(setupBun).not.toContain("packageManager")
})

test("setup installs Bun dependencies cold, without an Actions dependency cache or cache-warming workflow", async () => {
  expect(setupBun).not.toContain("actions/cache")
  expect(setupBun).toContain("bun install ${{ inputs.install-flags }}")
  expect(await Bun.file(path.join(import.meta.dir, "../.github/workflows/bun-cache.yml")).exists()).toBe(false)
})

test("Windows keeps the Bun cache on the runner's workspace disk before installing dependencies", () => {
  const beforeInstall = setupBun.split("- name: Install dependencies")[0] ?? ""
  expect(beforeInstall).toContain("if: runner.os == 'Windows'")
  expect(beforeInstall).toContain("BUN_INSTALL_CACHE_DIR=$RUNNER_TEMP/bun-install-cache")
})
