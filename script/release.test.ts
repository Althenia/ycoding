import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const workflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/release.yml")).text()
const testWorkflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/test.yml")).text()
const workflowJob = (content: string, name: string) =>
  content
    .split("\njobs:\n")[1]!
    .split(new RegExp(`(?:^|\\n)  ${name}:\\n`))[1]
    ?.split(/\n  [\w-]+:\n/)[0] ?? ""

test("native archive finalization preserves both TUI shards and every accepted command exactly once", () => {
  const verify = workflowJob(workflow, "verify-source")
  expect([...verify.matchAll(/- suite: (\S+)/g)].map((match) => match[1])).toEqual([
    "types", "web", "cli", "tui-project", "tui-runtime",
  ])
  for (const [name, shard, hash] of [
    ["Verify transcript and approval suites", "tui-project", "f131e4462bff135d8cfd8a8a55acd1415019649c260364bf590f923992b446b2"],
    ["Verify goal continuation", "tui-project", "eba471157159a351c38806fed91e1b202a1614b594b5f2c5942eb40e1ee07129"],
    ["Verify typed decision suites", "tui-runtime", "cff504b51cc79572eee39b1ca2a3796a57f654b8cd4aff685289d7882904be2e"],
    ["Verify Project ownership and native routing", "tui-project", "b2c051fad3b6237567b352b72d7fd8a05d3dea54f2b66649b51388d041936ba1"],
    ["Verify ownership upgrade and native decision boundaries", "tui-project", "10cb8dcc5dbb20e82da03b82faeaccf2b3f31da1f68841ac9f2c066093bc12ee"],
    ["Verify footer state and short-terminal controls", "tui-runtime", "01be3653bc1191ba5f3db6120255da2f8f04379edaa62add22258ccad823fb67"],
    ["Verify compact Project and transcript layouts", "tui-runtime", "7b817f020dc3bbccb9d2e63e342377564c8395f551a9453b967c4be65a363528"],
    ["Verify native Dots access and retirement boundaries", "tui-runtime", "938f5cd2eabcaa6c31134de20750085823a44b06f93467e1e2041ddac65a83e9"],
    ["Verify question grading and native Form views", "tui-runtime", "ddaed34f767789cff87f5d822d5b2d5b1df5df47ac88e081b37f250969825d98"],
    ["Verify subagent model selection boundaries", "tui-runtime", "a08d919abbe6505424fab1af1ecc2626e53f917794d330ace37dbf537ddd1749"],
  ] as const) {
    const steps = verify.split("\n      - name: ").slice(1).filter((step) => step.startsWith(`${name}\n`))
    expect(steps).toHaveLength(1)
    const step = Bun.YAML.parse(`name: ${steps[0]!.replace(/^ {8}/gm, "")}`)
    if (typeof step !== "object" || step === null || !("run" in step) || typeof step.run !== "string") throw new Error(`Missing command for ${name}`)
    expect("if" in step ? step.if : undefined).toBe(`matrix.suite == '${shard}'`)
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify({ run: step.run, cwd: "working-directory" in step ? step["working-directory"] : null })).digest("hex")).toBe(hash)
  }
})

test("source verification runs the native decision follow regression files in the CLI suite", async () => {
  const verify = workflowJob(workflow, "verify-source")
  const steps = verify.split("\n      - name: ").slice(1).filter((step) => step.startsWith("Verify native decision follow\n"))
  expect(steps).toHaveLength(1)
  const step = Bun.YAML.parse(`name: ${steps[0]!.replace(/^ {8}/gm, "")}`)
  if (typeof step !== "object" || step === null || !("run" in step) || typeof step.run !== "string") throw new Error("Missing native decision follow command")
  expect("if" in step ? step.if : undefined).toBe("matrix.suite == 'cli'")
  expect("working-directory" in step ? step["working-directory"] : undefined).toBe("packages/cli")
  const files = ["decision-follow-state", "decision-follow", "decision-follow-command"].map((name) => `./test/${name}.test.ts`)
  const oneShot = "both entrypoints advertise|already pending decision|every decision kind|completion is reported only|failed, interrupted, and rejected|timeout reports progress|resume command keeps|root accepted receipt|a family checkpoint|checkpoint boundary: rejects invalid|explicit conflicting root cursor is rejected|zero cursor against absent watermark rejects"
  expect(step.run).toBe([
    `bun test --timeout 30000 ${files.join(" ")}`,
    `bun test --timeout 30000 ./test/decision-watch.test.ts -t "${oneShot}"`,
  ].join("\n") + "\n")
  expect(await Bun.file(path.join(import.meta.dir, "../packages/cli/test/decision-watch.test.ts")).exists()).toBe(true)
  for (const file of files) expect(await Bun.file(path.join(import.meta.dir, "../packages/cli", file)).exists()).toBe(true)
})

test("native archive finalization transfers each prepared archive once and leaves manual publication disabled", () => {
  const build = workflowJob(workflow, "build")
  const release = workflowJob(workflow, "release-tui")
  expect(workflow).not.toContain("\n  package:")
  expect(build).toContain('bun script/release-archive.ts create "${{ matrix.target }}" "$RELEASE_VERSION"')
  expect(build).toContain("compression-level: 0")
  expect(build).toContain("name: release-archive-${{ matrix.target }}")
  expect(release).toContain("needs: [verify-source, build]")
  expect(release).toContain("pattern: release-archive-*")
  expect(release).toContain("merge-multiple: true")
  expect(release).toContain('bun script/release-archive.ts finalize "$RELEASE_VERSION" downloaded release')
  expect(release).not.toContain("uses: ./.github/actions/setup-bun")
  expect(release).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
  const publish = release.split("      - name: Publish GitHub release\n")[1] ?? ""
  expect(publish).toStartWith("        if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n")
  expect(release.indexOf("release-archive.ts finalize")).toBeLessThan(release.indexOf("- name: Publish GitHub release"))
  expect(release).not.toContain("release-assets-")
})

test("native archive finalization deploys the verified web artifact without rebuilding or GitHub write permission", () => {
  const verify = workflowJob(workflow, "verify-source")
  const deploy = workflowJob(workflow, "deploy-web")
  expect(verify).toContain("name: verified-web")
  expect(verify).toContain("path: apps/web/dist/")
  expect(verify.indexOf("run: bun run build:web")).toBeLessThan(verify.indexOf("name: verified-web"))
  expect(deploy).toContain("needs: release-tui")
  expect(deploy).toContain("name: verified-web")
  expect(deploy).toContain("path: apps/web/dist")
  expect(deploy).not.toContain("bun run build:web")
  expect(deploy).not.toContain("contents: write")
  expect(deploy).not.toContain("GH_TOKEN:")
})

test("release workflow ships no Godot desktop client", () => {
  expect(workflow).not.toMatch(/godot/i)
  expect(workflow).not.toMatch(/\boffice\b/i)
})

test("release workflow packages and checksums every CLI archive", () => {
  const build = workflowJob(workflow, "build")
  expect([...build.matchAll(/- target: (\S+)/g)].map((match) => match[1])).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"])
  expect(build).toContain("fail-fast: false")
  expect(build.indexOf("Verify build metadata")).toBeLessThan(build.indexOf("Create and validate native archive"))
  expect(build.indexOf("Stage native executables")).toBeLessThan(build.indexOf("Create and validate native archive"))
  expect(build.indexOf("Create and validate native archive")).toBeLessThan(build.indexOf("Upload native archive"))
  expect(workflowJob(workflow, "release-tui")).toContain('bun script/release-archive.ts finalize "$RELEASE_VERSION" downloaded release')
})

test("compressed release assets are uploaded without an additional compression pass", () => {
  const upload = workflowJob(workflow, "build").split("      - name: Upload native archive\n")[1] ?? ""
  expect(upload).toContain("compression-level: 0")
  expect(upload).toContain("if-no-files-found: error")
})

test("macOS release builds sign the app with the pinned release certificate and never fall back to ad hoc", () => {
  const build = workflowJob(workflow, "build")
  const importStep = build.split("      - name: Import macOS signing identity")[1]?.split("      - name: Build TUI artifact")[0] ?? ""
  const stage = build.split("      - name: Stage native executables")[1]?.split("      - name: Create and validate native archive")[0] ?? ""
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

test("local browser acceptance accepts installed Chrome 152 or newer", async () => {
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
  expect(workflow).toContain('"dist/release-bin/${{ matrix.target }}" "dist/release-archive/${{ matrix.target }}"')
})

test("macOS release archives stage the signed app and preserve its bundle tree", () => {
  expect(workflow).toContain('cp -R "dist/tui/tui-${{ matrix.target }}/bin/YCoding Computer Use.app" "$staging/"')
  expect(workflow).toContain('codesign --verify --deep --strict "$staging/YCoding Computer Use.app"')
  expect(workflow).not.toContain("bin/ycoding-computer-use")
  expect(workflowJob(workflow, "build")).toContain("Create and validate native archive")
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
  const stage = workflow.split("      - name: Stage native executables")[1]?.split("      - name: Create and validate native archive")[0] ?? ""
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
  expect(workflow).toContain('bun script/release-archive.ts finalize "$RELEASE_VERSION" downloaded release')
  expect(workflow.split("\n  release-tui:")[1]).toContain("gh release create \"v$version\" release/*")
})

test("one v tag verifies a shared note and publishes only the TUI GitHub release", () => {
  const verify = workflow.split("\n  verify-source:")[1]?.split("\n  build:")[0]
  const tui = workflow.split("\n  release-tui:")[1]?.split("\n  deploy-web:")[0]
  expect(workflow).toContain("      - v*")
  expect(Bun.YAML.parse(workflow)).toHaveProperty("on.push.tags", ["v*"])
  expect(workflow).not.toContain("      - tui-v*")
  expect(workflow).not.toContain("      - web-v*")
  expect(verify).toContain('release_notes="docs/releases/v$RELEASE_VERSION.md"')
  expect(verify).toContain("bun test --cwd apps/web ./src/content/changelog.test.ts")
  expect(verify).toContain("bun test --cwd packages/remote ./test/contract.test.ts")
  expect(verify).toContain("bun test --cwd apps/web ./test/remote-store-container.test.ts")
  expect(verify).not.toContain("bun run test:integration:remote")
  expect(verify).toContain("bun run build:cloudflare")
  expect(tui).toContain("if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  expect(tui).toContain('gh release create "v$version"')
  expect(tui?.match(/--title "[^"]+"/g)).toEqual(['--title "YCoding $version"', '--title "YCoding $version"'])
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

test("same v tag deploys web after the GitHub release is published, without GitHub write access", () => {
  const deploy = workflow.split("\n  deploy-web:")[1]
  expect(deploy).toContain("needs: release-tui")
  expect(deploy).toContain("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  expect(deploy).toContain("name: verified-web")
  expect(deploy).toContain("bun run deploy:cloudflare")
  expect(deploy?.indexOf("name: verified-web")).toBeLessThan(deploy?.indexOf("bun run deploy:cloudflare") ?? -1)
  expect(deploy).not.toContain("gh release")
  expect(deploy).not.toContain("GH_TOKEN:")
  expect(deploy).not.toContain("contents: write")
  expect(workflow).not.toContain("verify-source-web:")
})

test("app preview Worker deploys only after the relay and only when the repository variable opts in", () => {
  const deploy = workflow.split("\n  deploy-web:")[1] ?? ""
  const step = deploy.split("- name: Deploy app preview Worker")[1] ?? ""
  expect(step).toContain("if: vars.YCODING_APP_PREVIEW_DEPLOY == 'true'")
  expect(step).toContain('test -n "$CLOUDFLARE_API_TOKEN"')
  expect(step).toContain("bun run deploy:cloudflare-preview")
  expect(deploy.indexOf("bun run deploy:cloudflare\n")).toBeLessThan(deploy.indexOf("- name: Deploy app preview Worker"))
  expect(workflow.split("\n  deploy-web:")[0]).not.toContain("deploy:cloudflare-preview")
})

test("GitHub Release publication waits for every check and web deployment waits for publication", () => {
  const tui = workflow.split("\n  release-tui:")[1]?.split("\n  deploy-web:")[0]
  expect(tui).toContain("needs: [verify-source, build]")
  expect(tui).toContain("github.event_name == 'push'")
  expect(workflow.split("\n  deploy-web:")[1]).toContain("needs: release-tui")
})

test("an existing release is replaced through staged, verified publication with a retained recovery manifest", () => {
  const tui = workflow.split("\n  release-tui:")[1]?.split("\n  deploy-web:")[0] ?? ""
  const publish = tui.split("- name: Publish GitHub release")[1]?.split("\n      - name:")[0] ?? ""
  expect(publish).not.toContain("already exists")
  expect(publish.indexOf('if gh release view "$RELEASE_TAG"')).toBeLessThan(publish.indexOf("bun script/release-publish.ts"))
  expect(publish).toContain('--run "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --manifest release-publish-manifest.json release/* "docs/releases/v$version.md"')
  expect(publish.indexOf("bun script/release-publish.ts")).toBeLessThan(publish.indexOf('gh release create "v$version"'))
  expect(tui.indexOf("- name: Setup Bun")).toBeLessThan(tui.indexOf("- name: Publish GitHub release"))
  const manifest = tui.split("- name: Upload release publication manifest")[1] ?? ""
  expect(manifest).toContain("if: always()")
  expect(manifest).toContain("path: release-publish-manifest.json")
  expect(workflow).not.toContain('"$GITHUB_WORKSPACE/script/release-publish.test.ts"')
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
  expect(workflow).toContain("bun test --cwd apps/web ./src/content/changelog.test.ts")
  expect(workflow).toContain("bun test --cwd packages/remote ./test/contract.test.ts")
  expect(workflow).toContain("bun run build:web")
  expect(workflow).toContain("bun test --cwd infra/cloudflare ./test/mcp-boundary.test.ts")
  expect(workflow).toContain("bun run build:cloudflare")
  expect(workflow.indexOf("bun run build:web")).toBeLessThan(workflow.indexOf("bun run build:cloudflare"))
  expect(workflow).toContain("bun test --cwd packages/cli ./test/import-boundaries.test.ts")
  expect(workflow).not.toContain("bun run test:integration:browser")
  expect(workflow).not.toContain("isolated-browser-smoke.ts")
})

test("active source checks select named files without package-wide test commands", () => {
  const source = [workflowJob(workflow, "verify-source"), workflowJob(testWorkflow, "source")].join("\n")
  for (const script of ["test:web", "test:remote", "test:integration:web", "test:cloudflare", "test:extension"])
    expect(source).not.toContain(`bun run ${script}`)
  const commands = source.split("\n").filter((line) => /\bbun test\b/.test(line))
  expect(commands.length).toBeGreaterThan(10)
  for (const command of commands) {
    expect(command).toMatch(/\S+\.test\.[jt]sx?\b/)
    expect(command).not.toMatch(/\*|\?[^\s]*\.test/)
    const args = command.replace(/^.*?\bbun test\s+/, "").match(/"[^"]+"|\S+/g) ?? []
    for (const argument of args.filter((argument, index) =>
      !argument.startsWith("-") && !["--cwd", "--timeout", "-t"].includes(args[index - 1] ?? ""),
    )) expect(argument).toMatch(/\.test\.[jt]sx?"?$/)
  }
})

test("active test manifests resolve every selected file in its owning directory", async () => {
  const source = [workflowJob(workflow, "verify-source"), workflowJob(workflow, "build"), workflowJob(testWorkflow, "source"), workflowJob(testWorkflow, "build")].join("\n      - name:")
  for (const step of source.split("\n      - name:")) {
    for (const command of step.split("\n").filter((line) => /\bbun test\b/.test(line))) {
      const cwd = /--cwd\s+(\S+)/.exec(command)?.[1] ?? /\n        working-directory: (\S+)/.exec(step)?.[1] ?? "."
      const files = command.match(/(?:\.\/|test\/|\$GITHUB_WORKSPACE\/script\/)[\w/.-]+\.test\.[jt]sx?/g) ?? []
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const selected = file.startsWith("$GITHUB_WORKSPACE/")
          ? file.slice("$GITHUB_WORKSPACE/".length)
          : path.join(cwd, file)
        expect(await Bun.file(path.join(import.meta.dir, "..", selected)).exists(), selected).toBe(true)
      }
    }
  }
})

for (const [name, file, retained, excluded] of [
  ["connector", "./test/remote-bridge.test.ts", ["remote bridge", "quota observations use the global control frame without Session subscriptions or private fields", "global Dots reads remain available during a pending write without Session inventory"], ["MCP Events relay authorization budget", "relay MCP mutation lanes", "MCP event authority uses the current connector credential and cancels on detach", "connector reconnect discards registered apps without renewing old access", "connector reconnect retires MRTR tokens and observations while preserving uncertain exchange holds", "relay MCP state is acknowledged only for the current enable epoch"]],
  ["native control", "./test/remote-control.test.ts", ["remote-control wire types", "remote-control envelope", "remote-control app-server mapping", "state store persists installation and enrollment without configuration or tokens", "host enrolls, connects with headers, serves one RPC, and answers ping with pong", "enabling reports connecting before credentials resolve", "fresh host enrolls when only an old websocket URL key exists", "fresh host refreshes saved enrollment and uses the refreshed token", "refresh 404 deletes the enrollment and re-enrolls; unrecognized enroll 404 preserves and fails closed"], ["socket sends handshake headers over a local websocket"]],
  ["native access", "./test/remote-access.test.ts", ["global Dots operations need no Session inventory and preserve exact revision and conflicts"], ["global Dots local adapter sends no Session or Location and only revision-fenced fields"]],
  ["helper", "./test/computer-use-packaging.test.ts", ["filters unsupported targets without planning a native helper", "plans a sibling helper for each supported macOS architecture", "signs with a configured stable identity and a secure timestamp, otherwise ad hoc", "keeps only complete artifacts when the host cannot compile the macOS helper", "plans the explicit source-development helper in Core's ignored cache", "rejects a macOS package without the signed application bundle", "rejects an unexpected macOS application bundle in a non-macOS package"], ["builds a signed YCoding Computer Use app with the product icon", "lists every desktop window with a Space placement consistent with its visibility"]],
  ["transcript", "./test/session-transcript-live-fixes.test.tsx", ["derives pending, running, terminal, cancelled, and overridden tool lifecycle states from durable time"], ["sleeping header does not warn that the machine may sleep before its keep-awake read settles", "caps large transcript at bounded mounted window"]],
  ["picker", "./test/screen/subagent-picker-capture.test.tsx", ["captures populated subagent picker states at reference terminal dimensions", "sizes picker metadata to the measured composer width with and without the docked rail"], ["renders populated subagents in the parent-session rail", "keeps the parent header status informational while subagents are active"]],
  ["Dots attribution", "./test/screen/dots.screen.test.ts", ["remote source attribution accepts resident reactive metadata"], ["stored named exchanges retain external provenance and canonical source details"]],
  ["web todo", "./test/remote-todo.test.ts", ["a connector that never answers todo.list does not hold Session hydration or raise a state notice", "a superseded same-Session read cannot overwrite reconnect's newer todo list"], ["selection reads todos, live updates replace the list, and reconnect reads again"]],
  ["web guardrail", "./test/remote-guardrail.test.ts", ["preserves inspectable guardrail metadata in the family read"], ["a human can reject a review with missing targets but cannot approve it blindly"]],
] as const)
  test(`mixed ${name} suites select only named unit and mock cases`, () => {
    const commands = workflowJob(workflow, "verify-source").split("\n").filter((line) => line.includes(file))
    expect(commands).toHaveLength(1)
    const pattern = /-t "([^"]+)"/.exec(commands[0] ?? "")?.[1] ?? ""
    expect(pattern).not.toBe("")
    const match = new RegExp(pattern)
    for (const title of retained) expect(match.test(title), title).toBe(true)
    for (const title of excluded) expect(match.test(title), title).toBe(false)
    expect(commands[0]?.match(/\.test\.[jt]sx?/g)).toHaveLength(1)
  })

test("release verification covers Antigravity provider and build fixtures", () => {
  const verify = workflowJob(workflow, "verify-source")
  expect(verify).toContain("Verify Antigravity provider and build fixture boundaries")
  expect(verify).toContain("./test/plugin/provider-antigravity.test.ts")
  expect(verify).toContain("./antigravity-build-env.test.ts")
  expect(verify).toContain("./antigravity-build.test.ts")
})

test("release verification covers Muse provider and build fixtures", () => {
  const verify = workflowJob(workflow, "verify-source")
  expect(verify).toContain("Verify Muse provider and build fixture boundaries")
  expect(verify).toContain("./test/plugin/provider-muse.test.ts")
  expect(verify).toContain("./test/provider-usage-muse.test.ts")
  expect(verify).toContain("./muse-build-env.test.ts")
  expect(verify).toContain("./muse-build.test.ts")
})

test("release source gates retain native access, retirement and web unit contracts", () => {
  const verify = workflowJob(workflow, "verify-source")
  for (const file of [
    "./test/dots-context.test.ts",
    "./test/dots-access.test.ts",
    "./test/dots-access-config.test.ts",
    "./test/dots-native.test.ts",
    "./test/dots-native-admission.test.ts",
    "./test/dots-native-projection.test.ts",
    "./test/dots-native-decisions.test.ts",
    "./test/dots-native-source.test.ts",
    "./test/dots-retirement.test.ts",
    "./test/dots-retirement-promotion.test.ts",
    "./test/native-dots-only.test.ts",
    "./test/dots-access-contract.test.ts",
    "./test/dots-report-state.test.ts",
    "./test/dots-peer.test.ts",
    "./test/dots-codegen.test.ts",
    "./test/dots-connection.test.ts",
    "./test/dots-connection-dialog.test.tsx",
    "./test/dots-access-boundary.test.ts",
    "./test/dots-delegation-review.test.tsx",
    "./test/screen/dots.screen.test.ts",
    "./src/remote/autonomy.test.ts",
    "./src/remote/ui/composer-layout.test.ts",
    "./src/remote/ui/settings-layout.test.ts",
    "./src/remote/ui/status-bar.test.ts",
    "./src/remote/ui/todo-panel.test.ts",
    "./src/remote/ui/usage-accounting.test.ts",
    "./src/remote/ui/usage-filters.test.ts",
    "./src/remote/ui/usage-layout.test.ts",
  ]) expect(verify).toContain(file)
  for (const file of ["remote-retirement", "remote-decision-boundary", "remote-control-config", "remote-control-native", "remote-control-native-escalation", "remote-control-projection", "remote-control-sequence", "remote-control-stream-isolation", "mcp-boundary"])
    expect(verify).toContain(`./test/${file}.test.ts`)
  for (const file of ["remote-mcp", "remote-mcp-schemas", "remote-mcp-directory", "mcp-consent", "mcp-router", "dots-exchange", "dots-report-tool", "dots-session"])
    expect(verify).not.toContain(`./test/${file}.test.ts`)
  expect(verify).toContain("bun test --cwd apps/web ./test/dots.test.ts ./src/remote/ui/dots-composer.test.ts")
  expect(verify).not.toContain("YCODING_WEB_CHROME")
})

test("global Dots release gates select current mocks once and leave listener acceptance local", async () => {
  const verify = workflowJob(workflow, "verify-source")
  const steps = verify.split("\n      - name: ").slice(1)
  for (const file of ["./test/dots-connection.test.ts", "./test/dots-connection-dialog.test.tsx"]) {
    const selected = steps.filter((step) => step.split("\n").some((line) => /\bbun test\b/.test(line) && line.includes(file)))
    expect(selected, file).toHaveLength(1)
    expect(selected[0]).toContain("if: matrix.suite == 'tui-runtime'")
  }
  for (const [file, title] of [
    ["./test/remote-access.test.ts", "global Dots operations need no Session inventory and preserve exact revision and conflicts"],
    ["./test/remote-bridge.test.ts", "global Dots reads remain available during a pending write without Session inventory"],
  ] as const) {
    const commands = verify.split("\n").filter((line) => /\bbun test\b/.test(line) && line.includes(file))
    expect(commands).toHaveLength(1)
    expect(new RegExp(/-t "([^"]+)"/.exec(commands[0] ?? "")?.[1] ?? "^$").test(title)).toBe(true)
    expect(await Bun.file(path.join(import.meta.dir, "../packages/cli", file)).text()).toContain(`test("${title}"`)
  }
  for (const file of ["./test/prompt/dots-access.test.ts", "./test/dots-access-palette.test.tsx", "./test/screen/dots-connection.screen.test.ts"])
    expect(verify).not.toContain(file)
  expect(await Bun.file(path.join(import.meta.dir, "../packages/tui/test/screen/dots-connection.screen.test.ts")).exists()).toBe(true)
})

test("release source gates select native task delegation and question grading", () => {
  const verify = workflowJob(workflow, "verify-source")
  for (const file of [
    "./test/question-grading.test.ts",
    "./test/yolo-decision.test.ts",
    "./test/form.test.ts",
    "./test/cli/tui/form.test.tsx",
  ])
    expect(verify).toContain(file)
  expect(verify).toContain("bun test --cwd packages/schema ./test/form.test.ts")
  expect(verify).toContain(
    'bun test --cwd packages/core --timeout 40000 ./test/yolo-decision.test.ts -t "graded values retain their original mapping when an environment credential rotates during evaluation"',
  )
  expect(verify).toContain(
    "graded values retain their original mapping when an environment credential rotates during evaluation",
  )
  const questionGate =
    verify.split("      - name: Verify question grading and native Form views\n")[1]?.split("\n      - name: ")[0] ?? ""
  expect(questionGate).toContain("if: matrix.suite == 'tui-runtime'")
  expect(questionGate).toContain(
    'bun test --cwd packages/tui --timeout 40000 ./test/cli/tui/inline-tool-wrap-snapshot.test.tsx -t "filters malformed nested tool wire data|preserves native question selection modes|renders parsed multi-choice recommendations"',
  )
})

test("release source gates select Form, access clients, model-selection and runner regressions", () => {
  const verify = workflowJob(workflow, "verify-source")
  for (const file of [
    "./src/remote/form-contract.test.ts",
    "./src/remote/question-history.test.ts",
    "./test/session-orchestration.test.ts",
    "./test/subagent-model-selection.test.ts",
    "./test/session-step-boundary.test.ts",
    "./test/session-subagent-model-switch.test.ts",
    "./test/subagent-model-codegen.test.ts",
    "./test/dots-access.test.ts",
    "./test/subagent-model-boundary.test.ts",
    "./test/cli/tui/subagent-model-selection.test.tsx",
    "test/session-runner.test.ts",
  ])
    expect(verify).toContain(file)
  expect(
    verify
      .split("\n")
      .some(
        (line) =>
          line.includes("bun test --cwd apps/web") &&
          line.includes("./src/remote/form-contract.test.ts") &&
          line.includes("./src/remote/question-history.test.ts"),
      ),
  ).toBe(true)
  expect(verify).toContain("Verify subagent model selection boundaries")
  expect(verify).toContain(
    "- name: Verify subagent model selection boundaries\n        if: matrix.suite == 'tui-runtime'\n        run: |",
  )
  for (const command of [
    "bun test --cwd packages/schema ./test/subagent-model-selection.test.ts",
    "bun test --cwd packages/core --timeout 40000 ./test/session-step-boundary.test.ts ./test/session-subagent-model-switch.test.ts",
    "bun test --cwd packages/server --timeout 40000 ./test/session-subagent-model-switch.test.ts",
    "bun test --cwd packages/client ./test/subagent-model-codegen.test.ts",
    "bun test --cwd packages/remote ./test/subagent-model-boundary.test.ts",
    "bun test --cwd packages/protocol ./test/session-orchestration.test.ts",
    "bun test --cwd packages/tui --timeout 40000 ./test/cli/tui/subagent-model-selection.test.tsx",
    "bun test --cwd packages/client ./test/dots-peer.test.ts ./test/dots-access.test.ts ./test/dots-codegen.test.ts",
  ])
    expect(verify).toContain(command)
  const runnerCases = [
    "promotes queued input after continuation ends",
    "resets the configured step allowance when steering input promotes",
    "keeps the configured step allowance when only Dots peer input promotes",
    "resets the step allowance when Dots peer input promotes with user steering",
    "resets the step allowance when an ordinary synthetic input promotes without Dots attribution",
    "promotes queued inputs one at a time in FIFO order",
    "promotes queued input after steering continuation ends",
    "promotes steers before the next queued input",
    "coalesces multiple active steering prompts into one continuation step",
    "preserves durable queued input for a later wake after interruption",
  ].join("|")
  expect(verify).toContain(`bun test --timeout 40000 test/session-runner.test.ts -t "${runnerCases}"`)
})

test("release source gates include ownership, chronology and compact-footer regressions", () => {
  const verify = workflowJob(workflow, "verify-source")
  for (const file of [
    "./src/styles/design-md.test.ts",
    "./src/content/boundary.test.ts",
    "./src/remote/ui/transcript-rows.test.ts",
    "./test/coordination-assignment.test.ts",
    "./test/coordination-hierarchy-prompt.test.ts",
    "./test/database-migration.test.ts",
    "./test/coordination-decisions-native.test.ts",
    "./test/coordination-decision-runtime.test.ts",
    "./test/coordination-instructions.test.ts",
    "./test/coordination-model-request.test.ts",
    "./test/session-projector.test.ts",
    "./test/session-footer-autonomy.test.tsx",
    "./test/theme-v1-parity.test.ts",
    "./test/isolated-browser-dialog.test.tsx",
    "./test/cli/tui/projects-layout.test.tsx",
    "./test/decision-choice-redaction.test.ts",
    "./script/migration.test.ts",
    "./test/coordination-http.test.ts",
    "./test/coordination.test.ts",
    "./test/session-text.test.ts",
    "./test/form-contract.test.ts",
    "./test/cli/tui/session-rows-chronology.test.tsx",
  ]) expect(verify).toContain(file)
  expect(workflowJob(workflow, "build")).toContain("bun test --cwd packages/cli ./test/import-boundaries.test.ts")
})

test("test workflow verifies the web application and relay before the Cloudflare build", () => {
  expect(testWorkflow).toContain("bun test --cwd apps/web ./src/content/changelog.test.ts")
  expect(testWorkflow).toContain("bun test --cwd packages/remote ./test/contract.test.ts")
  expect(testWorkflow).toContain("bun run build:web")
  expect(testWorkflow).toContain("bun test --cwd infra/cloudflare ./test/mcp-boundary.test.ts")
  expect(testWorkflow).toContain("bun run build:cloudflare")
  expect(testWorkflow.indexOf("bun run build:web")).toBeLessThan(testWorkflow.indexOf("bun run build:cloudflare"))
})

test("active verification selects unit and mock boundaries without browser, listener or runtime suites", () => {
  for (const content of [workflowJob(workflow, "verify-source"), workflowJob(testWorkflow, "source")]) {
    for (const excluded of [
      "test:integration:", "./verify/", "./test/build-output.test.ts", "./test/commands.test.ts",
      "./test/remote-session.test.ts", "./test/remote-session-send.test.ts", "./test/remote-speed.test.ts",
      "./test/remote-control-flow.integration.test.ts", "./test/remote-goal-deadline.test.ts",
      "./test/remote-coordination.integration.test.ts",
      "./test/coordination-activation.integration.test.ts", "./test/decision-recovery.integration.test.ts",
      "./test/yolo-continuation.integration.test.ts", "./test/screen/projects-tab.screen.test.tsx",
      "./test/screen/projects-flow.screen.test.tsx", "./test/screen/session-chrome-row.screen.test.tsx",
      "./test/screen/autonomy-summaries.screen.test.tsx", "./test/screen/session-rail-design-match.test.tsx",
      "./test/screen/transcript-chronology.screen.test.tsx", "./test/screen/dots-notice-display.screen.test.ts",
      "./test/cli/tui/projects-screen.test.tsx",
      "script/release-publish.test.ts", "YCODING_WEB_CHROME", "verify-browser-host",
    ]) expect(content, excluded).not.toContain(excluded)
    expect(content).not.toContain("continue-on-error:")
    expect(content).toContain("bun test --cwd apps/web ./test/remote-store-container.test.ts")
  }
})

test("real browser, relay, publisher and runtime suites remain available locally", async () => {
  const rootPackage = JSON.parse(await Bun.file(path.join(import.meta.dir, "../package.json")).text())
  expect(rootPackage.scripts["test:integration:remote"]).toBe("bun infra/cloudflare/test/integration/real-flow.ts")
  for (const name of ["test:integration:web", "test:integration:browser", "test:integration:extension", "smoke:tui", "smoke:runtime"])
    expect(rootPackage.scripts[name]).toBeTruthy()
  for (const file of [
    "infra/cloudflare/test/integration/real-flow.ts", "script/release-publish.test.ts", "script/chrome-for-testing.test.ts",
    "packages/cli/script/isolated-browser-smoke.ts", "packages/cli/script/service-smoke.ts",
    "packages/cli/test/commands.test.ts", "packages/cli/test/remote-control-flow.integration.test.ts",
    "packages/cli/test/remote-goal-deadline.test.ts", "packages/cli/test/remote-access.test.ts",
    "packages/cli/test/remote-coordination.integration.test.ts", "packages/cli/test/coordination-activation.integration.test.ts",
    "packages/cli/test/decision-recovery.integration.test.ts", "packages/cli/test/yolo-continuation.integration.test.ts",
    "apps/web/test/build-output.test.ts", "apps/web/test/remote-session.test.ts", "apps/web/test/remote-session-send.test.ts",
    "apps/web/test/remote-speed.test.ts", "apps/web/verify/composer-controls.integration.test.ts",
    "apps/web/verify/conversation-questions.integration.test.ts", "apps/web/verify/project-notification-card.integration.test.ts",
    "apps/web/verify/model-replay.integration.test.ts", "apps/web/verify/incident-usage.integration.test.ts",
    "apps/web/verify/keep-awake-settings.integration.test.ts", "apps/web/verify/machine-row.integration.test.ts",
    "apps/web/verify/mobile-composer.integration.test.ts", "apps/web/verify/mobile-usage.integration.test.ts",
    "apps/web/verify/remote-shell-layout.integration.test.ts", "apps/web/verify/status-panel-motion.integration.test.ts",
    "apps/web/verify/todo.integration.test.ts", "apps/web/verify/usage-page.integration.test.ts",
    "packages/tui/test/screen/projects-tab.screen.test.tsx", "packages/tui/test/screen/projects-flow.screen.test.tsx",
    "packages/tui/test/screen/session-chrome-row.screen.test.tsx", "packages/tui/test/screen/autonomy-summaries.screen.test.tsx",
    "packages/tui/test/screen/session-rail-design-match.test.tsx", "packages/tui/test/screen/transcript-chronology.screen.test.tsx",
    "packages/tui/test/screen/dots-notice-display.screen.test.ts", "packages/tui/test/screen/dots.screen.test.ts",
    "packages/tui/test/cli/tui/projects-screen.test.tsx",
  ]) expect(await Bun.file(path.join(import.meta.dir, "..", file)).exists(), file).toBe(true)
})

test("release types verification checks cache invalidation before typechecking", () => {
  const step = workflow.split("      - name: Check workspace and types")[1]?.split("\n      - name:")[0] ?? ""
  const check = "bun test --cwd script ./typecheck-cache.integration.test.ts"
  expect(step).toContain("if: matrix.suite == 'types'")
  expect(step).toContain(check)
  expect(step.indexOf(check)).toBeLessThan(step.indexOf("bun run typecheck"))
})

test("Chrome pin selector names an existing source case", async () => {
  const verify = workflowJob(workflow, "verify-source")
  const selected = /bun test "\$GITHUB_WORKSPACE\/script\/chrome-for-testing\.test\.ts" -t "([^"]+)"/.exec(verify)?.[1]
  expect(selected).toBeDefined()
  const source = await Bun.file(path.join(import.meta.dir, "chrome-for-testing.test.ts")).text()
  expect([...source.matchAll(/^\s*test\("([^"]+)",/gm)].map((match) => match[1])).toContain(selected)
})

test("source verification legs start in parallel with the native builds", () => {
  const verify = workflow.split("\n  verify-source:")[1]?.split("\n  build:")[0] ?? ""
  const build = workflowJob(workflow, "build")
  expect(verify).not.toContain("needs:")
  expect(build).not.toContain("needs:")
  expect(verify).toContain("fail-fast: false")
  expect(verify).toContain("runs-on: ${{ matrix.runner }}")
  expect([...verify.matchAll(/- suite: (\S+)/g)].map((match) => match[1])).toEqual([
    "types",
    "web",
    "cli",
    "tui-project",
    "tui-runtime",
  ])
  for (const [step, condition] of [
    ["Check workspace and types", "matrix.suite == 'types'"],
    ["Verify web application and relay", "matrix.suite == 'web'"],
    ["Build web application", "matrix.suite == 'web'"],
    ["Verify Cloudflare Worker", "matrix.suite == 'web'"],
    ["Verify CLI suites", "matrix.suite == 'cli'"],
    ["Verify Chrome extension suites", "matrix.suite == 'cli'"],
    ["Verify transcript and approval suites", "matrix.suite == 'tui-project'"],
    ["Verify typed decision suites", "matrix.suite == 'tui-runtime'"],
    ["Verify installer and web assets", "matrix.suite == 'web'"],
  ])
    expect(verify).toContain(`      - name: ${step}\n        if: ${condition}\n`)
  expect(verify).not.toContain("uses: ./.github/actions/verify-browser-host")
  expect(verify).toContain("bun test --cwd extensions/chrome ./test/protocol.test.js ./test/service-worker.test.js ./test/design-md.test.js")
  expect(verify).not.toContain("test:integration:")
  expect(verify).not.toContain("script/chrome-for-testing.ts")
  expect(verify).not.toContain("YCODING_TEST_ISOLATED_BROWSER_CHROME")
  expect(verify).not.toContain("YCODING_WEB_CHROME")
  expect(verify).not.toContain("puppeteer")
  expect(verify).toContain('"$GITHUB_WORKSPACE/script/chrome-for-testing.test.ts"')
  expect(verify).toContain('-t "pins one exact version whose root metadata document is the default source"')
  expect(build).toContain("bun test --cwd packages/cli ./test/import-boundaries.test.ts")
  expect(build).not.toMatch(/smoke:|service-smoke|isolated-browser-smoke|test:integration:/)
})

test("packaging overlaps source verification without bypassing publication or deployment gates", () => {
  const jobs = workflow.split("\njobs:\n")[1]!.split(/(?:^|\n)  ([\w-]+):\n/).slice(1)
  const dependencies = [
    ["verify-source", undefined],
    ["build", undefined],
    ["release-tui", "[verify-source, build]"],
    ["deploy-web", "release-tui"],
  ] as const
  expect(jobs.filter((_, index) => index % 2 === 0).sort()).toEqual(dependencies.map(([name]) => name).sort())
  for (const [name, needs] of dependencies) {
    const job = jobs[jobs.indexOf(name) + 1] ?? ""
    expect(/^    needs: (.+)$/m.exec(job)?.[1]).toBe(needs)
    expect(/^    if: (.+)$/m.exec(job)?.[1]).toBe(
      name === "deploy-web"
        ? "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}"
        : "${{ github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/v') }}",
    )
  }
  expect(workflow).not.toContain("continue-on-error:")
  expect(workflow).toContain("permissions:\n  contents: read\n")
  const verify = workflow.split("\n  verify-source:")[1]?.split("\n  build:")[0] ?? ""
  expect(verify).not.toContain("secrets.")
  expect(verify).not.toContain("token:")
  expect(verify).not.toContain("permissions:")
  expect(verify).toContain("fetch-depth: 0")
  expect(verify).toContain("persist-credentials: false")
  expect(verify).toContain("git merge-base --is-ancestor \"$GITHUB_SHA\" origin/main")
  expect(verify).toContain("      - name: Verify tag is reachable from main\n        if: github.event_name == 'push'\n")
})

test.each([
  ["ancestor", 0],
  ["nonancestor", 1],
  ["missing main", 128],
] as const)("release ancestry guard uses checkout refs without a remote: %s", (scenario, status) => {
  const guard = workflowJob(workflow, "verify-source")
    .split("      - name: Verify tag is reachable from main\n")[1]
    ?.split("\n      - name:")[0] ?? ""
  const command = /\n {8}run: \|\n([\s\S]*)/.exec(guard)?.[1]
  expect(command).toBeDefined()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-release-ancestry-"))
  try {
    const git = (args: string[], stdin = "") => {
      const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    git(["init", "--quiet"])
    const tree = git(["mktree"])
    const commit = (parent?: string) => git(["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Release Fixture <release@example.test> 0 +0000\ncommitter Release Fixture <release@example.test> 0 +0000\n\nfixture\n`)
    const ancestor = commit()
    const descendant = commit(ancestor)
    if (scenario !== "missing main")
      git(["update-ref", "refs/remotes/origin/main", scenario === "nonancestor" ? ancestor : descendant])
    const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", command!], {
      cwd: directory,
      env: { ...process.env, GITHUB_SHA: scenario === "nonancestor" ? descendant : ancestor, GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(status)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("release runs serialize without cancelling a preceding release", () => {
  expect(workflow).not.toContain("\n  isolated-browser-acceptance:")
  expect(workflow).toContain("concurrency:\n  group: release\n  cancel-in-progress: false")
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

test("PR verification uses the same standard hosted runners as release", async () => {
  for (const runner of ["ubuntu-24.04", "windows-2025"]) {
    expect(workflow).toContain(`runner: ${runner}`)
    expect(testWorkflow).toContain(`host: ${runner}`)
  }
  const types = await Bun.file(path.join(import.meta.dir, "../.github/workflows/typecheck.yml")).text()
  expect(types).toContain("runs-on: ubuntu-24.04")
})

test("local and remote Usage budgets remain explicit developer benchmarks", async () => {
  for (const [name, file] of [["core", "usage-dashboard.performance.ts"], ["cli", "remote-usage-dashboard.performance.ts"]]) {
    const pkg = await Bun.file(path.join(import.meta.dir, `../packages/${name}/package.json`)).json()
    expect(pkg.scripts["test:performance"]).toContain(`./test/${file}`)
    expect(await Bun.file(path.join(import.meta.dir, `../packages/${name}/test/${file}`)).exists()).toBe(true)
    expect(pkg.scripts.test).not.toContain("performance")
  }
  expect(await Bun.file(path.join(import.meta.dir, "../packages/core/test/usage-dashboard-performance.test.ts")).exists()).toBe(false)
  expect(workflow).not.toContain("test:performance")
  expect(testWorkflow).not.toContain("test:performance")
})

test("Windows portability regressions run directly without replacing the full unit matrix", () => {
  const portability = testWorkflow.slice(testWorkflow.indexOf("  portability:"))
  expect(portability).toContain("runs-on: windows-2025")
  expect(portability).toContain("permissions:\n      contents: read")
  expect(portability).not.toContain("checks: write")
  expect(portability).toContain("test/remote-operations.test.ts")
  expect(portability).toContain("test-integration/task-mcp-node.test.ts")
  expect(portability).toContain("test/session-guardrail-service.test.ts")
  expect(portability).toContain("test/project-inventory.test.ts")
  expect(portability).toContain("if: always()")
  expect(testWorkflow).toContain("run: GITHUB_ACTIONS=false bun turbo test")
  for (const host of ["ubuntu-24.04", "windows-2025"]) expect(testWorkflow).toContain(`host: ${host}`)
})

test("source contracts and production builds run independently while legacy jobs stay skipped", () => {
  const skipped = "    # Temporarily disabled until the Rust release; remove this job-level if to restore.\n    if: ${{ false }}\n"
  const unit = workflowJob(testWorkflow, "unit")
  const source = workflowJob(testWorkflow, "source")
  const build = workflowJob(testWorkflow, "build")
  expect(unit).toContain(skipped)
  expect(workflowJob(testWorkflow, "portability")).toContain(skipped)
  expect(unit).toContain("run: GITHUB_ACTIONS=false bun turbo test")
  expect(unit).toContain("name: Cache Turbo")
  for (const job of [source, build]) {
    expect(job).not.toMatch(/^    if:/m)
    expect(job).not.toContain("continue-on-error:")
    expect(job).not.toContain("actions/cache")
    expect(job).not.toContain("secrets.")
    expect(job).toContain("    permissions:\n      contents: read\n")
    expect(job).not.toContain("checks: write")
    expect(job).toContain("uses: ./.github/actions/setup-bun")
    expect(job).toContain('git config --global user.name "ycoding"')
  }
  for (const command of [
    "bun test --cwd apps/web ./src/content/changelog.test.ts",
    "bun test --cwd packages/remote ./test/contract.test.ts",
    "bun run build:web",
    "bun test --cwd infra/cloudflare ./test/mcp-boundary.test.ts",
    "bun run build:cloudflare",
    "bun run check:generated",
    "bun run script/build.ts --single",
    "bun run script/build-node.ts --single --skip-install --outdir=dist/node",
  ]) {
    expect(unit).not.toContain(command)
    expect(testWorkflow.split(command).length - 1, command).toBeGreaterThanOrEqual(1)
  }
  expect(unit).not.toContain("service-smoke")
  expect(build).not.toMatch(/service-smoke|smoke:|test:integration:/)
  expect(testWorkflow).not.toContain("\n  lifecycle:")
  expect(unit).not.toContain("runner.os == 'Linux'")
  expect(unit).not.toContain("setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version: \"26.4.0\"")
})

test("the independent source verification job runs the Linux-only gates in order", () => {
  const source = workflowJob(testWorkflow, "source")
  expect(source).toContain("name: source verification (linux)")
  expect(source).toContain("runs-on: ubuntu-24.04")
  expect(source).toContain("timeout-minutes: 20")
  const order = [
    "bun test --cwd apps/web ./src/content/changelog.test.ts",
    "bun test --cwd packages/remote ./test/contract.test.ts",
    "bun run build:web",
    "bun test --cwd infra/cloudflare ./test/mcp-boundary.test.ts",
    "bun run build:cloudflare",
    "bun run check:generated",
  ].map((command) => source.indexOf(command))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(source).toContain("working-directory: packages/client\n        run: bun run check:generated")
  expect(source).not.toContain("matrix.")
})

test("the independent build matrix retains native and Node compilations on Linux and Windows", () => {
  const lifecycle = workflowJob(testWorkflow, "build")
  expect(lifecycle).toContain("name: native and Node builds (${{ matrix.settings.name }})")
  expect(lifecycle).toContain("fail-fast: false")
  expect(lifecycle).toContain("runs-on: ${{ matrix.settings.host }}")
  for (const host of ["ubuntu-24.04", "windows-2025"]) expect(lifecycle).toContain(`host: ${host}`)
  expect(lifecycle).toContain("shell: bash")
  const compiled = lifecycle.split("      - name: Build native executable\n")[1]?.split("\n      - name:")[0] ?? ""
  expect(compiled).toContain("timeout-minutes: 10")
  expect(compiled).toContain("working-directory: packages/cli")
  expect(compiled).toContain("run: bun run script/build.ts --single")
  const node = lifecycle.split("      - name: Verify Node build\n")[1] ?? ""
  expect(node).toContain("if: always()")
  expect(node).toContain("timeout-minutes: 15")
  expect(node).toContain("run: bun run script/build-node.ts --single --skip-install --outdir=dist/node")
  expect(lifecycle).not.toContain("service-smoke")
  expect(lifecycle).toContain('node-version: "24"')
  expect(lifecycle).toContain('node-version: "26.4.0"')
  expect(lifecycle.indexOf('node-version: "24"')).toBeLessThan(lifecycle.indexOf('node-version: "26.4.0"'))
  expect(lifecycle.indexOf("Verify compiled service lifecycle")).toBeLessThan(lifecycle.indexOf('node-version: "26.4.0"'))
  expect(lifecycle.indexOf('node-version: "26.4.0"')).toBeLessThan(lifecycle.indexOf("Verify Node build"))
})

test("every external action in the test workflow is pinned to a full commit", () => {
  const uses = [...testWorkflow.matchAll(/^\s+uses: (\S+)/gm)].map((match) => match[1]!)
  expect(uses.length).toBeGreaterThan(0)
  for (const action of uses) expect(action.startsWith("./") || /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(action), action).toBe(true)
})

test("release source verification runs the typed decision suites and the guardrail failure-reason regression in the TUI leg", () => {
  const verify = workflowJob(workflow, "verify-source")
  const step = verify.split("      - name: Verify typed decision suites\n")[1]?.split("\n      - name:")[0] ?? ""
  expect(step).toContain("if: matrix.suite == 'tui-runtime'")
  expect(step).toContain("working-directory: packages/core")
  expect(step).toContain(
    "run: bun test test/decision-agent-provider.test.ts test/decision-agent.test.ts test/decision-judgment.test.ts test/decision.test.ts test/session-guardrail-service.test.ts",
  )
  const transcript = verify.split("      - name: Verify transcript and approval suites\n")[1]?.split("\n      - name:")[0] ?? ""
  expect(transcript).toContain("working-directory: packages/tui")
  expect(transcript).toContain("test/cli/tui/permission.test.ts test/cli/tui/guardrail.test.tsx")
  expect(verify).not.toContain("continue-on-error")
  expect(workflow).not.toContain("continue-on-error:")
})
