import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const workflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/release.yml")).text()
const testWorkflow = await Bun.file(path.join(import.meta.dir, "../.github/workflows/test.yml")).text()
const workflowJob = (content: string, name: string) =>
  content
    .split("\njobs:\n")[1]!
    .split(new RegExp(`(?:^|\\n)  ${name}:\\n`))[1]
    ?.split(/\n  [\w-]+:\n/)[0] ?? ""
const darwinJob = "build-desktop-runtime"
const darwinBuild = workflowJob(workflow, darwinJob)
const darwinStep = (name: string) => darwinBuild.split(`      - name: ${name}\n`)[1]?.split("\n      - name: ")[0] ?? ""

test("native archive finalization preserves both TUI shards and every accepted command exactly once", () => {
  const verify = workflowJob(workflow, "verify-source")
  expect([...verify.matchAll(/- suite: (\S+)/g)].map((match) => match[1])).toEqual([
    "types", "web", "cli", "cli-antigravity", "cli-muse", "tui-project", "tui-runtime",
  ])
  for (const [name, shard, hash] of [
    ["Verify transcript and approval suites", "tui-project", "f131e4462bff135d8cfd8a8a55acd1415019649c260364bf590f923992b446b2"],
    ["Verify goal continuation", "tui-project", "eba471157159a351c38806fed91e1b202a1614b594b5f2c5942eb40e1ee07129"],
    ["Verify typed decision suites", "tui-project", "cff504b51cc79572eee39b1ca2a3796a57f654b8cd4aff685289d7882904be2e"],
    ["Verify Project ownership and native routing", "tui-project", "b2c051fad3b6237567b352b72d7fd8a05d3dea54f2b66649b51388d041936ba1"],
    ["Verify ownership upgrade and native decision boundaries", "tui-project", "10cb8dcc5dbb20e82da03b82faeaccf2b3f31da1f68841ac9f2c066093bc12ee"],
    ["Verify footer state and short-terminal controls", "tui-project", "01be3653bc1191ba5f3db6120255da2f8f04379edaa62add22258ccad823fb67"],
    ["Verify compact Project and transcript layouts", "tui-project", "7b817f020dc3bbccb9d2e63e342377564c8395f551a9453b967c4be65a363528"],
    ["Verify native Dots access and retirement boundaries", "tui-project", "938f5cd2eabcaa6c31134de20750085823a44b06f93467e1e2041ddac65a83e9"],
    ["Verify question grading and native Form views", "tui-project", "ddaed34f767789cff87f5d822d5b2d5b1df5df47ac88e081b37f250969825d98"],
    ["Verify subagent model selection boundaries", "tui-project", "a08d919abbe6505424fab1af1ecc2626e53f917794d330ace37dbf537ddd1749"],
  ] as const) {
    const steps = verify.split("\n      - name: ").slice(1).filter((step) => step.startsWith(`${name}\n`))
    expect(steps).toHaveLength(1)
    const step = Bun.YAML.parse(`name: ${steps[0]!.replace(/^ {8}/gm, "")}`)
    if (typeof step !== "object" || step === null || !("run" in step) || typeof step.run !== "string") throw new Error(`Missing command for ${name}`)
    expect("if" in step ? step.if : undefined).toBe(`matrix.suite == '${shard}'`)
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify({ run: step.run, cwd: "working-directory" in step ? step["working-directory"] : null })).digest("hex")).toBe(hash)
  }
})

test("the Linux runtime shard runs the three exact native recovery cases after the existing contracts", () => {
  const verify = workflowJob(workflow, "verify-source")
  expect(verify).toContain("- suite: tui-runtime\n            runner: ubuntu-24.04")
  const steps = verify.split("\n      - name: ").slice(1).filter((step) => step.startsWith("Verify native contract boundaries\n"))
  expect(steps).toHaveLength(1)
  const cargo = "cargo test --locked --manifest-path rust/Cargo.toml -p"
  expect(Bun.YAML.parse(`name: ${steps[0]!.replace(/^ {8}/gm, "")}`)).toEqual({
    name: "Verify native contract boundaries",
    if: "matrix.suite == 'tui-runtime'",
    run: [
      `${cargo} ycoding-schema --test autonomy_review`,
      `${cargo} ycoding-protocol --test wire_session`,
      `${cargo} ycoding-protocol --test connection ac_wire_002_handshake_invalid_input_matrix_dispatches_nothing`,
      `${cargo} ycoding-core --test coordination_admission admitted_project_input_reaches_execution_through_pause_gate_restart_and_settlement -- --exact`,
      `${cargo} ycoding-runtime --test daily_workflows restarting_with_a_running_root_tool_exposes_its_unknown_effect_without_resuming -- --exact`,
      `${cargo} ycoding-runtime --test events reconnect_reconciles_an_unacknowledged_prompt_by_its_durable_identity -- --exact`,
    ].join("\n") + "\n",
  })
})

test("release source verification selects the native startup diagnostic regressions", () => {
  const verify = workflowJob(workflow, "verify-source")
  const steps = verify.split("\n      - name: ").slice(1)
  const selected = steps.filter((step) => step.startsWith("Verify native startup diagnostics\n"))
  expect(selected).toHaveLength(1)
  const cargo = "cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-runtime"
  expect(Bun.YAML.parse(`name: ${selected[0]!.replace(/^ {8}/gm, "")}`)).toEqual({
    name: "Verify native startup diagnostics",
    if: "matrix.suite == 'tui-runtime'",
    run: [
      `${cargo} --test service_failed_boot failed_composition_registration_deletion_stops_owner_and_releases_listener -- --exact`,
      `${cargo} --test service_failed_boot failed_store_boot_retains_native_owner_until_authenticated_exact_instance_stop -- --exact`,
      `${cargo} --lib production::tests::retention_settings_fail_startup_when_the_first_load_fails -- --exact`,
    ].join("\n") + "\n",
  })
  expect(steps.indexOf(selected[0]!)).toBeGreaterThan(steps.findIndex((step) => step.startsWith("Build and verify native runtime receipt\n")))
})

test("release source verification selects duplicate-pin and reclaim durability cases", () => {
  const verify = workflowJob(workflow, "verify-source")
  const steps = verify.split("\n      - name: ").slice(1)
  const selected = steps.filter((step) => step.startsWith("Verify Session pin durability\n"))
  expect(selected).toHaveLength(1)
  const cargo = "cargo test --locked --manifest-path rust/Cargo.toml -p"
  expect(Bun.YAML.parse(`name: ${selected[0]!.replace(/^ {8}/gm, "")}`)).toEqual({
    name: "Verify Session pin durability",
    if: "matrix.suite == 'tui-runtime'",
    run: [
      `${cargo} ycoding-core --test session_lifecycle duplicate_pin_leaves_the_file_unchanged_and_pin_follows_a_queued_unpin -- --exact`,
      `${cargo} ycoding-core --test session_lifecycle pin_and_unpin_toggle_the_pinned_time_and_ignore_repeats -- --exact`,
      `${cargo} ycoding-store --lib engine::tests::ordinary_empty_submissions_and_both_reclaim_passes_sync -- --exact`,
    ].join("\n") + "\n",
  })
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
  const oneShot = "both entrypoints advertise|already pending decision|every decision kind|completion is reported only|failed, interrupted, and rejected|timeout reports progress|resume command keeps|root accepted receipt|a family checkpoint|checkpoint boundary: rejects invalid|explicit conflicting root cursor is rejected|zero cursor against absent watermark rejects|assessment cut off by the deadline|read cut off by the deadline outside the assessment|resumed after an unavailable assessment|cancelling or killing a watch during a stalled assessment|queued work in outstanding data blocks completion only inside the watched scope"
  expect(step.run).toBe([
    `bun test --timeout 30000 ${files.join(" ")}`,
    `bun test --timeout 30000 ./test/decision-watch.test.ts -t "${oneShot}"`,
  ].join("\n") + "\n")
  expect(await Bun.file(path.join(import.meta.dir, "../packages/cli/test/decision-watch.test.ts")).exists()).toBe(true)
  for (const file of files) expect(await Bun.file(path.join(import.meta.dir, "../packages/cli", file)).exists()).toBe(true)
})

test("the Darwin job uploads each archive once and the finalizer checks the complete set", () => {
  expect(darwinBuild).toContain("timeout-minutes: 60")
  const release = workflowJob(workflow, "finalize-release")
  expect(workflow).not.toContain("\n  package:")
  expect(darwinBuild).toContain('bun script/release-archive.ts create darwin-arm64 "$RELEASE_VERSION"')
  expect([...darwinBuild.matchAll(/^          name: (release-archive-\S+)$/gm)].map((match) => match[1])).toEqual([
    "release-archive-darwin-arm64", "release-archive-desktop-darwin-arm64",
  ])
  expect(release).toContain(`needs: [verify-source, ${darwinJob}]`)
  expect(release).toContain("pattern: release-archive-*")
  expect(release).toContain("merge-multiple: true")
  expect(release).toContain('bun script/release-archive.ts finalize "$RELEASE_VERSION" downloaded release')
  expect(release).not.toContain("uses: ./.github/actions/setup-bun")
  expect(release).toContain("uses: ./.github/actions/install-bun")
  expect(release).not.toContain("- name: Publish GitHub release")
  expect(release.indexOf("release-archive.ts finalize")).toBeLessThan(release.indexOf("- name: Upload release checksums"))
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

test("release workflow packages and checksums only the Apple Silicon CLI archive", () => {
  const build = darwinBuild
  expect(darwinStep("Verify native build host")).toContain('process.platform !== "darwin" || process.arch !== "arm64"')
  expect(build.indexOf("Verify build metadata")).toBeLessThan(build.indexOf("Create and validate native archive"))
  expect(build.indexOf("Stage native executables")).toBeLessThan(build.indexOf("Create and validate native archive"))
  expect(build.indexOf("Create and validate native archive")).toBeLessThan(build.indexOf("Upload native archive"))
  expect(workflowJob(workflow, "finalize-release")).toContain('bun script/release-archive.ts finalize "$RELEASE_VERSION" downloaded release')
})

test("the independent Windows PR gate still verifies a native x64 executable", () => {
  const pr = workflowJob(testWorkflow, "native-windows")
  expect(pr).toContain("name: native runtime build (windows)")
  expect(pr).toContain("runs-on: windows-2025")
  expect(pr).toContain("    needs: build-inputs\n    if: ${{ !cancelled() }}\n")
  expect(pr).not.toContain("continue-on-error")
  const steps = ["uses: ./.github/actions/setup-rust", "--runtime-receipt=", "verify-embedded"].map((text) => pr.indexOf(text))
  expect(steps.every((index) => index >= 0)).toBe(true)
  expect(steps).toEqual([...steps].sort((a, b) => a - b))
})

test("compressed release assets are uploaded without an additional compression pass", () => {
  const upload = darwinStep("Upload native archive")
  expect(upload).toContain("compression-level: 0")
  expect(upload).toContain("if-no-files-found: error")
})

test("macOS release builds sign the app with the pinned release certificate and never fall back to ad hoc", () => {
  const build = darwinBuild
  const importStep = build.split("      - name: Import macOS signing identity")[1]?.split("      - name: Build TUI artifact")[0] ?? ""
  const stage = build.split("      - name: Verify packaged macOS signatures")[1]?.split("      - name: Upload native archive")[0] ?? ""
  expect(build).toContain("      YCODING_MACOS_SIGNING_IDENTITY: YCoding Code Signing")
  expect(build).toContain("      YCODING_MACOS_SIGNING_SHA1: 9dd524184b0db949ffac7f0ada0ae860ac7f5f85\n")
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
  expect(stage).toContain("codesign --verify --strict -R")
  expect(stage).toContain("codesign --verify --deep --strict -R")
  expect(build).toContain("- name: Remove macOS signing keychain\n        if: always()")
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
  expect(darwinBuild).toContain('cp -R dist/tui/tui-darwin-arm64/bin/ycoding-chrome-extension "$staging/"')
  expect(darwinBuild).toContain('dist/release-bin/darwin-arm64 dist/release-archive/darwin-arm64')
})

test("macOS release archives stage the signed app and preserve its bundle tree", () => {
  expect(darwinBuild).toContain('cp -R "dist/tui/tui-darwin-arm64/bin/YCoding Interaction.app" "$staging/"')
  expect(workflow).toContain('"$payload/YCoding Interaction.app"')
  expect(workflow).not.toContain("bin/ycoding-computer-use")
  expect(darwinBuild).toContain("Create and validate native archive")
})

test.each([
  ["cli", "$executable", ""],
  ["interaction", "YCoding Interaction.app", " --deep"],
])("the release verifies the archived %s against the pinned certificate before upload", (identifier, entry, deep) => {
  const stage = workflow.split("      - name: Verify packaged macOS signatures")[1]?.split("      - name: Upload native archive")[0] ?? ""
  expect(stage).toContain('executable="$(bun script/release-archive.ts executable darwin-arm64 "$RELEASE_VERSION")"')
  expect(stage).toContain(
    String.raw`codesign --verify${deep} --strict -R "=identifier \"app.ycoding.${identifier}\" and certificate leaf = H\"$YCODING_MACOS_SIGNING_SHA1\"" "$payload/${entry}"`,
  )
})

test("release archives keep the layout installed updaters accept and ship the license texts as separate assets", () => {
  expect(workflow).not.toContain('cp LICENSE NOTICE "$staging/"')
  expect(workflow).not.toMatch(/ycoding-chrome-extension LICENSE/)
  expect(workflow).toContain('bun script/release-archive.ts finalize "$RELEASE_VERSION" downloaded release')
  expect(workflowJob(workflow, "release-tui")).toContain('gh release create "$tag" release/* "$notes"')
})

test("one v tag verifies a shared note and publishes only the TUI GitHub release", () => {
  const verify = workflowJob(workflow, "verify-source")
  const tui = workflow.split("\n  release-tui:")[1]?.split("\n  deploy-web:")[0]
  expect(workflow).toContain("      - v*")
  expect(Bun.YAML.parse(workflow)).toHaveProperty("on.push.tags", ["v*"])
  expect(workflow).not.toContain("      - tui-v*")
  expect(workflow).not.toContain("      - web-v*")
  expect(verify).toContain("run: bash script/release-version.sh")
  expect(verify).toContain("bun test --cwd apps/web ./src/content/changelog.test.ts")
  expect(verify).toContain("bun test --cwd packages/remote ./test/contract.test.ts")
  expect(verify).toContain("bun test --cwd apps/web ./test/remote-store-container.test.ts")
  expect(verify).not.toContain("bun run test:integration:remote")
  expect(verify).toContain("bun run build:cloudflare")
  expect(tui).toContain("if: ${{ github.event_name == 'push' && !github.event.deleted && startsWith(github.ref, 'refs/tags/v') }}")
  expect(tui).toContain('gh release create "$tag"')
  expect(tui?.match(/--title "[^"]+"/g)).toEqual(['--title "YCoding $version"', '--title "YCoding $version"'])
  expect(tui).toContain('notes="docs/releases/$tag.md"')
  expect(tui).toContain('test("^v[0-9]")')
  expect(tui).toContain("contents: write")
  expect((workflow.match(/gh release create /g) ?? []).length).toBe(1)
})

test("the first unified release has nonempty shared notes", async () => {
  const notes = Bun.file(path.join(import.meta.dir, "../docs/releases/v0.6.5.md"))
  expect(await notes.exists()).toBe(true)
  expect((await notes.text()).trim()).toContain("# YCoding v0.6.5")
})

test("same v tag deploys web after the GitHub release is published, without GitHub write access", () => {
  const deploy = workflowJob(workflow, "deploy-web")
  expect(deploy).toContain("needs: release-tui")
  expect(deploy).toContain("github.event_name == 'push' && !github.event.deleted && startsWith(github.ref, 'refs/tags/v')")
  expect(deploy).toContain("name: verified-web")
  expect(deploy).toContain("bun run deploy:cloudflare")
  expect(deploy?.indexOf("name: verified-web")).toBeLessThan(deploy?.indexOf("bun run deploy:cloudflare") ?? -1)
  expect(deploy).not.toContain("gh release")
  expect(deploy).not.toContain("GH_TOKEN:")
  expect(deploy).not.toContain("contents: write")
  expect(workflow).not.toContain("verify-source-web:")
})

test("app preview Worker deploys only after the relay and only when the repository variable opts in", () => {
  const deploy = workflowJob(workflow, "deploy-web")
  const step = deploy.split("- name: Deploy app preview Worker")[1] ?? ""
  expect(step).toContain("if: vars.YCODING_APP_PREVIEW_DEPLOY == 'true'")
  expect(step).toContain('test -n "$CLOUDFLARE_API_TOKEN"')
  expect(step).toContain("bun run deploy:cloudflare-preview")
  expect(deploy.indexOf("bun run deploy:cloudflare\n")).toBeLessThan(deploy.indexOf("- name: Deploy app preview Worker"))
  expect(workflow.split("\n  deploy-web:")[0]).not.toContain("deploy:cloudflare-preview")
})

test("publish and deploy consume only digest-checked artifacts from the current run", () => {
  const finalizer = workflowJob(workflow, "finalize-release")
  const release = workflowJob(workflow, "release-tui")
  const deploy = workflowJob(workflow, "deploy-web")
  for (const [job, downloads] of [[finalizer, 1], [release, 2], [deploy, 1]] as const) {
    expect(job).not.toMatch(/run-id:|github-token:|artifact-ids:/)
    expect(job.match(/digest-mismatch: error/g)).toHaveLength(downloads)
  }
  expect(finalizer).toContain("name: release-checksums-")
  expect(finalizer).not.toMatch(/gh release|release-publish-manifest/)
  expect(release).toContain("needs.finalize-release.outputs.checksums-sha256")
  expect(release).toContain("cp LICENSE NOTICE release/")
  expect(release.match(/sha256sum --check --strict/g)).toHaveLength(2)
  expect(release).toContain("contents: write")
  expect(deploy).toContain("test -s apps/web/dist/index.html ||")
  expect(deploy).not.toContain("_bun")
})

test("publication checks the tag at the write boundary and retains a replacement recovery manifest", () => {
  const release = workflowJob(workflow, "release-tui")
  expect(release).toContain("persist-credentials: false")
  expect(release).toContain('bash script/release-version.sh --verify-tag\n            bun script/release-publish.ts')
  expect(release).toContain('bash script/release-version.sh --verify-tag\n            gh release create')
  expect(release).toContain('--run "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --manifest release-publish-manifest.json release/* "$notes"')
  expect(release.indexOf("- name: Install Bun")).toBeLessThan(release.indexOf("- name: Publish GitHub release"))
  const manifest = release.split("- name: Upload release publication manifest")[1] ?? ""
  expect(manifest).toContain("if: always()")
  expect(manifest).toContain("path: release-publish-manifest.json")
})

test.each([
  ["existing", "0.13.2", [[{ tag_name: "v0.12.2", draft: false }], [{ tag_name: "v0.13.2", draft: true }]], "v0.12.2", true],
  ["new stable", "0.13.2", [[{ tag_name: "v0.12.2", draft: false }]], "v0.13.2", true],
  ["new prerelease", "0.13.2-rc.1", [[{ tag_name: "v0.12.2", draft: false }]], "v0.12.2", true],
  ["wrong Latest", "0.13.2", [[]], "v0.12.2", false],
  ["incomplete API response", "0.13.2", [], "v0.13.2", false],
  ["invalid API records", "0.13.2", [[{ message: "Bad credentials" }]], "v0.13.2", false],
  ["failed API request", "0.13.2", null, "v0.13.2", false],
] as const)("the publication step handles %s without guessing release state", (scenario, version, pages, latestAfter, success) => {
  const publish = workflowJob(workflow, "release-tui").split("- name: Publish GitHub release")[1]?.split("\n      - name:")[0] ?? ""
  const command = /^ {8}run: \|\n([\s\S]*)/m.exec(publish)?.[1]
  expect(command).toBeDefined()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-release-step-"))
  try {
    const notes = `docs/releases/v${version}.md`
    fs.mkdirSync(path.join(directory, "docs/releases"), { recursive: true })
    fs.mkdirSync(path.join(directory, "script"))
    fs.mkdirSync(path.join(directory, "release"))
    fs.writeFileSync(path.join(directory, "release/asset"), "archive")
    fs.writeFileSync(path.join(directory, notes), "Tagged notes\n")
    fs.writeFileSync(path.join(directory, "script/release-version.sh"), '[ "$1" = --verify-tag ] || exit 2\nprintf "checked tag\\n" >> calls\n')
    fs.writeFileSync(path.join(directory, "calls"), "")
    fs.writeFileSync(path.join(directory, "gh"), [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "api --paginate") [ "$3" = --slurp ] && [ -n "$RELEASE_PAGES" ] || exit 1; printf "%s\\n" "$RELEASE_PAGES" ;;',
      '  "api repos/example/ycoding/releases/latest") if [ -e created ]; then printf "%s\\n" "$LATEST_AFTER"; else echo v0.12.2; fi ;;',
      '  "release create") printf "create %s\\n" "$*" >> calls; touch created ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join("\n"), { mode: 0o755 })
    fs.writeFileSync(path.join(directory, "bun"), [
      '#!/bin/sh',
      'case "$2" in',
      '  latest) exec "$REAL_BUN" "$PUBLISHER" latest "$3" "$4" ;;',
      '  --repository) printf "replace %s\\n" "$*" >> calls ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join("\n"), { mode: 0o755 })
    const result = Bun.spawnSync(["bash", "-c", command!], {
      cwd: directory,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GH_TOKEN: "fixture", GH_REPO: "example/ycoding",
        RELEASE_VERSION: version, GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", LATEST_AFTER: latestAfter,
        RELEASE_PAGES: pages === null ? "" : JSON.stringify(pages), REAL_BUN: process.execPath, PUBLISHER: path.join(import.meta.dir, "release-publish.ts") },
    })
    expect(result.success, result.stderr.toString()).toBe(success)
    const calls = fs.readFileSync(path.join(directory, "calls"), "utf8")
    if (scenario === "existing") {
      expect(calls).toStartWith("checked tag\nreplace ")
      expect(calls).toContain(`--tag v${version}`)
      expect(calls).not.toContain("create ")
    } else if (scenario.startsWith("new") || scenario === "wrong Latest") {
      expect(calls).toStartWith(`checked tag\ncreate release create v${version} `)
      expect(calls).toContain(`release/asset ${notes} --verify-tag --latest=${scenario !== "new prerelease"}`)
      expect(calls.includes(" --prerelease ")).toBe(scenario === "new prerelease")
    } else {
      expect(calls).toBe("")
    }
    if (success) expect(fs.readFileSync(path.join(directory, "release-notes.md"), "utf8")).toBe(
      `Tagged notes\n\n**Full Changelog**: https://github.com/example/ycoding/compare/v0.12.2...v${version}\n`,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("Cloudflare deployment requires a scoped Actions token before Wrangler runs", () => {
  const deploy = workflow.split("\n  deploy-web:")[1]
  expect(deploy).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}")
  expect(deploy).toContain('test -n "$CLOUDFLARE_API_TOKEN"')
  expect(deploy?.indexOf('test -n "$CLOUDFLARE_API_TOKEN"')).toBeLessThan(
    deploy?.indexOf("bun run deploy:cloudflare") ?? -1,
  )
})

test("release contexts stay out of the version resolver's shell source", () => {
  expect(workflow).toContain("REQUESTED_RELEASE_VERSION: ${{ inputs.version }}")
  expect(workflow).toContain("RELEASE_REF_NAME: ${{ github.ref_name }}")
  expect(workflow).not.toMatch(/"\$\{\{ (?:inputs.version|github.ref_name) \}\}"/)
})

test("release source checks cover Interaction and stored OpenAI Responses without live services", () => {
  const verify = workflowJob(workflow, "verify-source")
  const expected = [
    ["Verify Interaction wire and runtime boundaries", "types", [
      "./test/interaction-chrome.test.ts", "./test/interaction-macos.test.ts", "./test/session-interaction.test.ts", "./test/interaction-platform.test.ts",
    ]],
    ["Verify stored OpenAI Responses continuation", "types", [
      "./test/provider/openai-responses.test.ts", "./test/openai-api-key-cache-boundary.test.ts",
    ]],
    ["Verify Interaction connector and extension", "cli", [
      "./test/remote-interaction.test.ts", "./test/interaction-chrome-controller.test.js",
    ]],
  ] as const
  for (const [name, suite, files] of expected) {
    const step = verify.split(`      - name: ${name}\n`)[1]?.split("\n      - name: ")[0] ?? ""
    expect(step).toContain(`if: matrix.suite == '${suite}'`)
    expect(step).not.toMatch(/test-integration|\.integration\.test|smoke:/)
    for (const file of files) expect(step).toContain(file)
  }
})

function resolveReleaseVersion(directory: string, envFile: string, input: Record<string, string>) {
  return Bun.spawnSync(["bash", path.join(import.meta.dir, "release-version.sh")], {
    cwd: directory,
    env: { PATH: process.env.PATH, GITHUB_ENV: envFile, ...input },
    stdout: "pipe",
    stderr: "pipe",
  })
}

test.each([
  ["0.12.0-rc.1+build.2", "preview", "branch", "0.12.0-rc.1+build.2"],
  ["", "v0.12.0", "tag", "0.12.0"],
  ["", "v0.13.0", "tag", "0.13.0"],
  ["", "v0.11.0-preview", "branch", "0.13.1"],
  ["0.12.04", "preview", "branch", null],
  ["0.12.0-rc.01", "preview", "branch", null],
  ["0.12.0\nANOTHER=value", "preview", "branch", null],
  ["0.12.0$(printf unexpected)", "preview", "branch", null],
  ["", "v0.12.0/invalid", "tag", null],
])("release version validates the selected input before environment export (%j, %j, %s)", (requested, ref, type, expected) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-release-version-"))
  try {
    const envFile = path.join(directory, "github-env")
    const initial = "EXISTING=value\n"
    fs.writeFileSync(envFile, initial)
    fs.mkdirSync(path.join(directory, "docs/releases"), { recursive: true })
    for (const version of ["0.12.0", "0.12.0-rc.1+build.2", "0.12.2", "0.13.1", "0.13.0"]) {
      fs.writeFileSync(path.join(directory, `docs/releases/v${version}.md`), "Release notes\n")
    }
    const result = resolveReleaseVersion(directory, envFile, {
      REQUESTED_RELEASE_VERSION: requested, RELEASE_REF_NAME: ref, RELEASE_REF_TYPE: type,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(expected === null ? 1 : 0)
    expect(result.stdout.toString()).toBe("")
    expect(result.stderr.toString()).toBe(expected === null ? "Invalid release version\n" : "")
    expect(fs.readFileSync(envFile, "utf8")).toBe(
      expected === null ? initial : `${initial}RELEASE_VERSION=${expected}\nYCODING_VERSION=${expected}\n`,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test.each(["missing", "empty"])("a release with %s notes fails before exporting its version", (notes) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-release-notes-"))
  try {
    const envFile = path.join(directory, "github-env")
    fs.writeFileSync(envFile, "")
    if (notes === "empty") {
      fs.mkdirSync(path.join(directory, "docs/releases"), { recursive: true })
      fs.writeFileSync(path.join(directory, "docs/releases/v0.13.0.md"), "")
    }
    const result = resolveReleaseVersion(directory, envFile, { REQUESTED_RELEASE_VERSION: "0.13.0" })
    expect(result.exitCode, result.stderr.toString()).toBe(1)
    expect(fs.readFileSync(envFile, "utf8")).toBe("")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test.each([
  ["refs/tags/v0.13.0", 0, ""],
  ["refs/tags/v0.12.2", 1, "Release version does not match the pushed tag\n"],
])("release version binds exports to a synthetic tag push for %s", (ref, exitCode, diagnostic) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-release-tag-version-"))
  try {
    const envFile = path.join(directory, "github-env")
    fs.writeFileSync(envFile, "")
    fs.mkdirSync(path.join(directory, "docs/releases"), { recursive: true })
    fs.writeFileSync(path.join(directory, "docs/releases/v0.13.0.md"), "Release notes\n")
    const result = resolveReleaseVersion(directory, envFile, {
      GITHUB_EVENT_NAME: "push", GITHUB_REF: ref, RELEASE_REF_TYPE: "tag", RELEASE_REF_NAME: "v0.13.0",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(exitCode)
    expect(result.stderr.toString()).toBe(diagnostic)
    expect(fs.readFileSync(envFile, "utf8")).toBe(exitCode === 0 ? "RELEASE_VERSION=0.13.0\nYCODING_VERSION=0.13.0\n" : "")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
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

test("the verified Web artifact contains only the current Web build", () => {
  const source = workflowJob(workflow, "verify-source")
  expect(source).not.toContain("BUN_WEB_SOURCE")
  expect(source).not.toContain("--bun-dist")
  expect(source.indexOf("bun run build:web")).toBeLessThan(source.indexOf("name: verified-web"))
  expect(source.match(/name: verified-web/g)).toHaveLength(1)
})

test("active source checks select named files without package-wide test commands", () => {
  const source = [workflowJob(workflow, "verify-source"), workflowJob(testWorkflow, "source")].join("\n")
  for (const script of ["test:web", "test:remote", "test:integration:web", "test:cloudflare", "test:extension"])
    expect(source).not.toContain(`bun run ${script}`)
  const commands = source.split("\n").filter((line) => /\bbun test\b/.test(line))
  expect(commands.length).toBeGreaterThan(10)
  for (const command of commands) {
    expect(command).not.toMatch(/\*|\?[^\s]*\.test/)
    const args = Array.from(command.replace(/^.*?\bbun test\s+/, "").matchAll(/"([^"]*)"|'([^']*)'|\S+/g),
      ([token, doubleQuoted, singleQuoted]) => doubleQuoted ?? singleQuoted ?? token,
    )
    const files = args.filter((argument, index) =>
      !argument.startsWith("-") && !["--cwd", "--timeout", "-t"].includes(args[index - 1] ?? ""),
    )
    expect(files.length, command).toBeGreaterThan(0)
    for (const file of files) expect(file, command).toMatch(/\.test\.[jt]sx?$/)
  }
})

test("active test manifests resolve every selected file in its owning directory", async () => {
  const source = [workflowJob(workflow, "verify-source"), darwinBuild, workflowJob(testWorkflow, "source"), workflowJob(testWorkflow, "build")].join("\n      - name:")
  for (const step of source.split("\n      - name:")) {
    for (const command of step.split("\n").filter((line) => /\bbun test\b/.test(line))) {
      const cwd = /--cwd\s+(\S+)/.exec(command)?.[1] ?? /\n        working-directory: (\S+)/.exec(step)?.[1] ?? "."
      const files = command.match(/(?:\.\/|test\/|\$GITHUB_WORKSPACE\/)[\w/.-]+\.test\.[jt]sx?/g) ?? []
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
  expect(verify).toContain("./test/plugin/provider-antigravity-signature-replay.test.ts")
  expect(verify).toContain("./antigravity-build-env.test.ts")
  expect(verify).toContain("./antigravity-build.test.ts")
})

test("release verification covers incomplete provider streams and disabled tool declarations", () => {
  const verify = workflowJob(workflow, "verify-source")
  const step = verify.split("      - name: Check workspace and types\n")[1]?.split("\n      - name: ")[0] ?? ""
  expect(step).toContain("if: matrix.suite == 'types'")
  expect(step).toContain('bun test --cwd packages/core ./test/aisdk.test.ts -t "AI SDK incomplete completion|AI SDK disabled-tool declarations"')
  expect(step).toContain('bun test --cwd packages/core --timeout 40000 ./test/session-runner.test.ts -t "disabled-tool declarations|rejects a declared (Google|Codex|OpenAI SDK) tool during terminal recovery|fails provider-executed tool-only terminal response recovery without a third request|fails repeated (empty|reasoning-only) responses without a third response step"')
})

test("release verification covers Muse provider and build fixtures", () => {
  const verify = workflowJob(workflow, "verify-source")
  expect(verify).toContain("Verify Muse provider and build fixture boundaries")
  expect(verify).toContain("./test/plugin/provider-muse.test.ts")
  expect(verify).toContain("./test/plugin/provider-muse-tools.test.ts")
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
  for (const [file, suite] of [
    ["./test/dots-connection.test.ts", "tui-project"],
    ["./test/dots-connection-dialog.test.tsx", "tui-project"],
    ["./test/dots-native.test.ts", "tui-project"],
    ["./test/remote-control-native.test.ts", "cli"],
    ["./test/remote-control-sequence.test.ts", "cli"],
  ] as const) {
    const selected = steps.filter((step) => step.split("\n").some((line) => /\bbun test\b/.test(line) && line.includes(file)))
    expect(selected, file).toHaveLength(1)
    expect(selected[0]).toContain(`if: matrix.suite == '${suite}'`)
    const commands = selected[0]!.split("\n").filter((line) => /\bbun test\b/.test(line) && line.includes(file))
    expect(commands, file).toHaveLength(1)
    expect(commands[0]).not.toMatch(/\s-t\s/)
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
  expect(questionGate).toContain("if: matrix.suite == 'tui-project'")
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
    "- name: Verify subagent model selection boundaries\n        if: matrix.suite == 'tui-project'\n        run: |",
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
  expect(darwinBuild).toContain("bun test --cwd packages/cli ./test/import-boundaries.test.ts")
})

test("test workflow verifies the web application and relay before the Cloudflare build", () => {
  expect(testWorkflow).toContain("bun test --cwd apps/web ./src/content/changelog.test.ts")
  expect(testWorkflow).toContain("bun test --cwd packages/remote ./test/contract.test.ts")
  expect(testWorkflow).toContain("bun run build:web")
  expect(testWorkflow).toContain("bun test --cwd infra/cloudflare ./test/mcp-boundary.test.ts")
  expect(testWorkflow).toContain("bun run build:cloudflare")
  expect(testWorkflow.indexOf("bun run build:web")).toBeLessThan(testWorkflow.indexOf("bun run build:cloudflare"))
})

test("release and test workflows keep both relay versions in source verification", () => {
  const releaseSource = workflowJob(workflow, "verify-source")
  for (const source of [releaseSource, workflowJob(testWorkflow, "source")]) {
    for (const check of [
      "./test/router.test.ts",
      "./test/relay-authority.test.ts",
      "./test/relay-handoff.test.ts",
      "./test/relay-http.test.ts",
      "./test/relay-mcp.test.ts",
      "./test/relay-resync.test.ts",
      "./test/remote-http.test.ts",
      "./test/remote-http-bulk.test.ts",
      "./test/remote-sync.test.ts -t 'oversized live invalidations'",
      "./test/http-bulk.test.ts",
      "./src/pwa/offline.test.ts",
      "./src/service-worker.push.test.ts",
      "bun run build:cloudflare",
    ]) expect(source).toContain(check)
    expect(source).not.toContain("wrangler dev")
  }
  expect(releaseSource).toContain("ac_wire_002_handshake_invalid_input_matrix_dispatches_nothing")
  const deploy = workflowJob(workflow, "deploy-web")
  expect(deploy).toContain("needs: release-tui")
  expect(workflow).toContain("\npermissions:\n  contents: read\n")
  expect(deploy).toContain("    permissions:\n      contents: read\n    steps:")
  expect(deploy).toContain("name: verified-web\n          path: apps/web/dist")
  expect(deploy).toContain("bun run deploy:cloudflare")
})

test("release verification runs the Cloudflare typecheck through the required types leg once", () => {
  const source = workflowJob(workflow, "verify-source")
  const types = source.split("      - name: Check workspace and types\n")[1]?.split("\n      - name: ")[0] ?? ""
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../package.json"), "utf8"))
  expect(types).toContain("if: matrix.suite == 'types'")
  expect(types).toContain("bun run typecheck\n")
  expect(pkg.scripts.typecheck).toEndWith(" && bun run typecheck:cloudflare")
  expect(source).not.toContain("bun run typecheck:cloudflare")
  expect(workflowJob(testWorkflow, "source")).toContain("bun run typecheck:cloudflare")
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
  const verify = workflowJob(workflow, "verify-source")
  const build = darwinBuild
  expect(workflowJob(workflow, "verify-source")).not.toContain("needs:")
  expect(workflowJob(workflow, "build-desktop-runtime")).not.toContain("needs:")
  expect(verify).toContain("fail-fast: false")
  expect(verify).toContain("runs-on: ${{ matrix.runner }}")
  expect([...verify.matchAll(/- suite: (\S+)/g)].map((match) => match[1])).toEqual([
    "types",
    "web",
    "cli",
    "cli-antigravity",
    "cli-muse",
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
    ["Verify typed decision suites", "matrix.suite == 'tui-project'"],
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

test("one release run gates publication and deployment on its own verification and archives", () => {
  const parsed: unknown = Bun.YAML.parse(workflow)
  expect(parsed).toHaveProperty("on.workflow_dispatch.inputs", {
    version: { description: expect.any(String), required: false, default: "" },
  })
  expect(parsed).toHaveProperty("on.push.tags", ["v*"])
  expect(parsed).toHaveProperty("concurrency", { group: "release", "cancel-in-progress": false })
  expect(parsed).toHaveProperty("permissions", { contents: "read" })
  const jobs = workflow.split("\njobs:\n")[1]!.split(/(?:^|\n)  ([\w-]+):\n/).slice(1)
  const dependencies = [
    ["verify-source", undefined],
    [darwinJob, undefined],
    ["finalize-release", `[verify-source, ${darwinJob}]`],
    ["release-tui", "finalize-release"],
    ["deploy-web", "release-tui"],
  ] as const
  expect(jobs.filter((_, index) => index % 2 === 0).sort()).toEqual(dependencies.map(([name]) => name).sort())
  const tagPush = "github.event_name == 'push' && !github.event.deleted && startsWith(github.ref, 'refs/tags/v')"
  for (const [name, needs] of dependencies) {
    const job = jobs[jobs.indexOf(name) + 1] ?? ""
    expect(/^    needs: (.+)$/m.exec(job)?.[1]).toBe(needs)
    expect(/^    if: (.+)$/m.exec(job)?.[1]).toBe(name === "release-tui" || name === "deploy-web"
      ? `\${{ ${tagPush} }}` : `\${{ github.event_name == 'workflow_dispatch' || (${tagPush}) }}`)
    expect(job).not.toMatch(/^    environment:/m)
    if (name !== "release-tui") expect(job).not.toContain("contents: write")
  }
  expect(workflow).not.toContain("continue-on-error:")
  expect(workflow).toContain("permissions:\n  contents: read\n")
  const verify = workflowJob(workflow, "verify-source")
  expect(verify).not.toContain("secrets.")
  expect(verify).not.toContain("token:")
  expect(verify).not.toContain("permissions:")
  expect(verify).toContain("persist-credentials: false")
})

test("both Darwin packagers use the local runtime and receipt digest from their own dispatch attempt", () => {
  expect(darwinBuild.match(/^    runs-on: macos-26$/gm)).toHaveLength(1)
  expect(darwinBuild).not.toContain("actions/download-artifact@")
  for (const name of ["Checkout repository", "Setup Bun", "Setup Rust", "Stage Apple Silicon release runtime", "Upload Apple Silicon release runtime", "Import macOS signing identity", "Build TUI artifact", "Build desktop app", "Remove macOS signing keychain"])
    expect(darwinBuild.split(`      - name: ${name}\n`)).toHaveLength(2)
  const stage = darwinStep("Stage Apple Silicon release runtime")
  expect(stage).toContain("id: runtime")
  expect(stage).toContain('bun packages/cli/script/runtime.ts stage-release "$RUNNER_TEMP/release-runtime"')
  expect(stage).toContain('shasum -a 256 < "$RUNNER_TEMP/release-runtime/receipt.json"')
  expect(stage).toContain(`printf 'receipt-sha256=%s\\n' "$digest" >> "$GITHUB_OUTPUT"`)
  const upload = darwinStep("Upload Apple Silicon release runtime")
  expect(upload).toContain("uses: actions/upload-artifact@")
  expect(upload).toContain("name: release-runtime-darwin-arm64-${{ github.run_attempt }}")
  expect(upload).toContain("if-no-files-found: error")
  expect(upload).toContain("path: ${{ runner.temp }}/release-runtime/")
  const order = ["Stage Apple Silicon release runtime", "Upload Apple Silicon release runtime", "Import macOS signing identity", "Build TUI artifact", "Build desktop app", "Remove macOS signing keychain"].map((name) => darwinBuild.indexOf(`- name: ${name}\n`))
  expect(order).toEqual([...order].sort((a, b) => a - b))
  const producer = darwinBuild.slice(0, order[2])
  const oauth = ["YCODING_ANTIGRAVITY_CLIENT_ID", "YCODING_ANTIGRAVITY_CLIENT_SECRET", "YCODING_MUSE_CLIENT_ID", "YCODING_MUSE_CLIENT_SECRET"]
  expect([...producer.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])).toEqual(oauth)
  for (const name of oauth) expect(stage).toContain(`${name}: \${{ secrets.${name} }}`)
  for (const name of ["YCODING_MACOS_SIGNING_P12", "YCODING_MACOS_SIGNING_PASSWORD"]) {
    expect([...darwinBuild.matchAll(new RegExp(`secrets\\.${name}`, "g"))]).toHaveLength(1)
    expect(darwinStep("Import macOS signing identity")).toContain(`secrets.${name}`)
  }
  const required = "YCODING_ANTIGRAVITY_CLIENT_ID YCODING_ANTIGRAVITY_CLIENT_SECRET YCODING_MUSE_CLIENT_ID"
  const check = `for name in ${required}; do`
  expect(stage.split(check)).toHaveLength(3)
  expect(stage).toContain('test -n "${!name}" || { echo "Missing $name Actions secret" >&2; exit 1; }')
  expect(stage).toContain('LC_ALL=C grep -qaF -- "${!name}" "$RUNNER_TEMP/release-runtime/ycoding-runtime" || { echo "The release runtime does not embed $name" >&2; exit 1; }')
  expect(stage.match(/test -n "\$\{!name\}"/g)).toHaveLength(1)
  expect(stage.match(/grep -qaF -- "\$\{!name\}"/g)).toHaveLength(1)
  expect(stage).not.toMatch(/echo[^\n]*\$\{!name\}"[^\n]*>&2|printf[^\n]*\$\{!name\}"[^\n]*>>/)
  const buildIndex = stage.indexOf('bun packages/cli/script/runtime.ts stage-release')
  expect(stage.indexOf(check)).toBeLessThan(buildIndex)
  expect(stage.lastIndexOf(check)).toBeGreaterThan(buildIndex)
  for (const name of ["Build TUI artifact", "Build desktop app"]) {
    const packaging = darwinStep(name)
    expect(packaging).toContain("YCODING_RELEASE_RUNTIME_DIR: ${{ runner.temp }}/release-runtime\n")
    expect(packaging).toContain("RECEIPT_SHA256: ${{ steps.runtime.outputs.receipt-sha256 }}")
  }
})

test("release runtime uses a versioned compiler cache and uploads build timings", () => {
  const outside = workflow.replace(darwinBuild, "")
  for (const name of ["sccache-store", 'sccache: "true"', "release-cache: writer", "Save Apple Silicon release dependencies"]) {
    expect(outside).not.toContain(name)
    expect(testWorkflow).not.toContain(name)
  }
  expect(testWorkflow).not.toContain('sccache: "true"')
  expect(testWorkflow).not.toContain("release-cache:")
  expect(darwinBuild).toContain("    env:\n      SCCACHE_DIR: ${{ runner.temp }}/sccache-store\n      SCCACHE_CACHE_SIZE: 3G\n      RUSTC_WRAPPER: sccache\n    defaults:\n")
  expect(darwinBuild).not.toContain("CARGO_INCREMENTAL")
  expect(darwinStep("Setup Rust")).toContain('sccache: "true"')
  const restore = darwinStep("Restore release compiler cache")
  const save = darwinStep("Save release compiler cache")
  const key = '${{ runner.os }}-${{ runner.arch }}-sccache-0.19.0-${{ github.run_id }}-${{ github.run_attempt }}'
  expect(restore).toContain("uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9")
  expect(restore).toContain(`key: ${key}`)
  expect(restore).toContain('restore-keys: |\n            ${{ runner.os }}-${{ runner.arch }}-sccache-0.19.0-')
  expect(save).toContain("uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9")
  expect(save).toContain("if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
  expect(save).not.toContain("always()")
  expect(save).toContain(`key: ${key}`)
  for (const cache of [restore, save]) expect(cache).toContain('path: ${{ runner.temp }}/sccache-store')
  const stage = darwinStep("Stage Apple Silicon release runtime")
  expect(stage).toContain("SAVES_RELEASE_CACHES: ${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}")
  const embed = stage.lastIndexOf('LC_ALL=C grep -qaF -- "${!name}"')
  const stats = stage.indexOf("sccache --show-stats")
  const guarded = stage.indexOf('if [ "$SAVES_RELEASE_CACHES" = true ]; then')
  const stop = stage.indexOf("sccache --stop-server")
  const purge = ['rm -f "$release/ycoding-runtime" "$release/ycoding-runtime.d"', 'find "$release/deps" -maxdepth 1 -name \'ycoding_runtime-*\' -exec rm -rf {} +', "bin-ycoding-runtime*"].map((text) => stage.indexOf(text))
  const scan = stage.indexOf('for cached in "$HOME/.cargo/registry/index" "$HOME/.cargo/registry/cache" "$HOME/.cargo/git/db" "$release" "$SCCACHE_DIR"; do')
  const refusal = stage.indexOf('A provider client value is present in the release cache path $leaked" >&2; exit 1')
  const digest = stage.indexOf("digest=$(shasum")
  expect([embed, stats, guarded, stop, ...purge, scan, refusal, digest].every((index) => index >= 0)).toBe(true)
  expect([embed, stats, guarded, stop, ...purge, scan, refusal, digest]).toEqual([embed, stats, guarded, stop, ...purge, scan, refusal, digest].sort((a, b) => a - b))
  expect(stage).toContain("if [ -n \"${!name}\" ]; then values+=(\"${!name}\"); fi")
  expect(stage).toContain('LC_ALL=C grep -rlaF -f /dev/stdin "$cached"')
  const timings = darwinStep("Upload release build timings")
  expect(timings).toContain("uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
  expect(timings).toContain('name: release-runtime-timings-${{ github.run_attempt }}')
  expect(timings).toContain("path: rust/target/cargo-timings/\n")
  expect(timings).toContain("if-no-files-found: error")
  expect(timings).toContain("retention-days: 1")
  expect(timings).not.toContain("always()")
  const names = ["Setup Rust", "Restore release compiler cache", "Stage Apple Silicon release runtime", "Upload release build timings", "Upload Apple Silicon release runtime", "Save Apple Silicon release dependencies", "Save release compiler cache"]
  const order = names.map((name) => darwinBuild.indexOf(`- name: ${name}\n`))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  for (const name of ["Save Apple Silicon release dependencies", "Save release compiler cache"])
    expect(darwinStep(name)).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
  expect(darwinStep("Save Apple Silicon release dependencies")).not.toContain("always()")
})

test("test workflow saves generic Rust dependency caches only after workspace artifacts are removed", () => {
  const saves = [
    ["build", "Save Rust dependencies", "needs.build-inputs.outputs.native != 'false' && steps.rust.outcome == 'success'", "steps.rust"],
    ["native-windows", "Save Rust dependencies", "needs.build-inputs.outputs.native != 'false' && steps.rust.outcome == 'success'", "steps.rust"],
  ] as const
  for (const [job, name, condition, id] of saves) {
    const step = workflowJob(testWorkflow, job).split(`      - name: ${name}\n`)[1]?.split("\n      - name: ")[0] ?? ""
    expect(step).toContain(`if: always() && ${condition}`)
    expect(step).toContain("uses: ./.github/actions/setup-rust/save")
    expect(step).toContain(`cache-key: \${{ ${id}.outputs.cargo-cache-key }}`)
    expect(step).toContain(`cache-hit: \${{ ${id}.outputs.cargo-cache-hit }}`)
  }
  const verify = workflowJob(workflow, "verify-source")
  const save = verify.split("      - name: Save native contract dependencies\n")[1]?.split("\n      - name: ")[0] ?? ""
  expect(save).toContain("if: always() && matrix.suite == 'tui-runtime' && steps.native-rust.outcome == 'success'")
  expect(save).toContain("uses: ./.github/actions/setup-rust/save")
  expect(save).toContain("cache-key: ${{ steps.native-rust.outputs.cargo-cache-key }}")
  expect(save).toContain("cache-hit: ${{ steps.native-rust.outputs.cargo-cache-hit }}")
  expect(verify).toContain("      - name: Setup Rust for native contracts\n        id: native-rust\n")
  expect(verify).not.toContain("secrets.")
  for (const job of ["build", "native-windows"]) expect(workflowJob(testWorkflow, job)).not.toContain("secrets.")
})

test("the web verification leg runs the relay and protocol deadline regressions", () => {
  const verify = workflowJob(workflow, "verify-source")
  expect(verify).toContain("bun test --cwd packages/protocol ./test/http-bulk.test.ts ./test/connection-deadline.test.ts")
  expect(verify).toContain("./test/relay-resync.test.ts ./test/relay-deadline.test.ts ./test/relay-adapter-alarm.test.ts")
})

test("source and package jobs reject unsafe tags and missing notes before setup", () => {
  for (const job of [workflowJob(workflow, "verify-source"), darwinBuild]) {
    const order = ["ref: ${{ github.sha }}", "persist-credentials: false", "- name: Verify release tag provenance",
      "bash script/release-version.sh --verify-tag", "run: bash script/release-version.sh\n", "- name: Setup Bun"].map((step) => job.indexOf(step))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  }
  expect(darwinBuild.indexOf("- name: Setup Bun")).toBeLessThan(darwinBuild.indexOf("- name: Setup Rust"))
  expect(darwinBuild.indexOf("- name: Setup Rust")).toBeLessThan(darwinBuild.indexOf("- name: Import macOS signing identity"))
})

test("release workflow builds and archives the macOS desktop app from the locked Electrobun package", () => {
  const desktop = darwinBuild
  expect(desktop).toContain("timeout-minutes: 60")
  const pinned = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../packages/desktop/package.json"), "utf8")).dependencies.electrobun as string
  const base = `https://github.com/blackboardsh/electrobun/releases/download/v${pinned}`
  expect(desktop).toContain("runs-on: macos-26")
  expect(desktop).toContain("      - name: Setup Bun\n        uses: ./.github/actions/setup-bun\n        with:\n          install-flags: --frozen-lockfile\n")
  expect(desktop).toContain(`test "$(node -p 'require(process.argv[1]).version' "$sdk/package.json")" = "${pinned}"`)
  expect(pinned).toBe("1.18.1")
  expect(desktop).toContain(`${base}/electrobun-cli-darwin-arm64.tar.gz`)
  expect(desktop).toContain(`${base}/electrobun-core-darwin-arm64.tar.gz`)
  expect(desktop).toContain('echo "1ef4a4b42a957d3349f491f7fbe53153d1d5f427bacbda340c8d7fadce6b58d9  electrobun-cli-darwin-arm64.tar.gz" | shasum -a 256 -c -')
  expect(desktop).toContain('echo "474c24f3af26eb5d59ce9fa90483fef2a35974fcdedebb8df969aebc4350e62f  electrobun-core-darwin-arm64.tar.gz" | shasum -a 256 -c -')
  expect(desktop).toContain("    env:\n      SCCACHE_DIR: ${{ runner.temp }}/sccache-store\n      SCCACHE_CACHE_SIZE: 3G\n      RUSTC_WRAPPER: sccache\n    defaults:\n")
  const build = '/bin/sh packages/desktop/script/build.sh --outdir="$RUNNER_TEMP/desktop" --sign-identity=9dd524184b0db949ffac7f0ada0ae860ac7f5f85'
  const archive = 'bun script/release-archive.ts create-desktop "$RELEASE_VERSION" "$RUNNER_TEMP/desktop/YCoding Desktop.app" dist/release-archive/desktop-darwin-arm64'
  expect(desktop).toContain(build)
  expect(desktop).toContain(archive)
  const upload = desktop.split("      - name: Upload desktop archive\n")[1] ?? ""
  expect(upload).toContain("name: release-archive-desktop-darwin-arm64")
  expect(upload).toContain("path: dist/release-archive/desktop-darwin-arm64/")
  expect(upload).toContain("compression-level: 0")
  expect(upload).toContain("if-no-files-found: error")
  const order = ["- name: Provision Electrobun native assets", build, "- name: Verify desktop backend version", archive, "- name: Upload desktop archive"].map((marker) => desktop.indexOf(marker))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
})

test("Desktop stages its actual CLI distribution for candidate checks without changing release archives", () => {
  const desktop = darwinBuild
  const readback = darwinStep("Verify and archive the Desktop CLI distribution")
  const upload = darwinStep("Upload Desktop CLI distribution for verification")
  expect(readback).toContain('dist="packages/cli/dist/cli-darwin-arm64"')
  expect(readback).toContain('"$GITHUB_WORKSPACE/$dist/package.json"')
  expect(readback).toContain('cmp "$dist/bin/ycoding" "$backend/ycoding"')
  expect(readback).toContain('tar -czf "$RUNNER_TEMP/cli-darwin-arm64.tar.gz" -C packages/cli/dist cli-darwin-arm64')
  expect(upload).toContain("name: desktop-cli-distribution-darwin-arm64-${{ github.run_attempt }}")
  expect(upload).toContain("${{ runner.temp }}/desktop/build-receipt.json")
  expect(upload).toContain("if-no-files-found: error")
  const order = ["Build desktop app", "Verify desktop signature", "Verify and archive the Desktop CLI distribution", "Upload Desktop CLI distribution for verification", "Upload desktop archive"].map((name) => desktop.indexOf(`- name: ${name}\n`))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(workflowJob(workflow, "finalize-release")).not.toContain("desktop-cli-distribution")
  expect(workflowJob(workflow, "release-tui")).not.toContain("desktop-cli-distribution")
})

test("release workflow signs the desktop app with the pinned self-signed identity, verifies it and always removes the keychain", () => {
  const desktop = darwinBuild
  const importStep = darwinStep("Import macOS signing identity")
  const build = darwinStep("Build desktop app")
  const verify = darwinStep("Verify desktop signature")
  const cleanup = darwinStep("Remove macOS signing keychain")
  expect(desktop).toContain("    env:\n      SCCACHE_DIR: ${{ runner.temp }}/sccache-store\n      SCCACHE_CACHE_SIZE: 3G\n      RUSTC_WRAPPER: sccache\n    defaults:\n")
  expect(importStep).toContain("        env:\n          YCODING_MACOS_SIGNING_P12: ${{ secrets.YCODING_MACOS_SIGNING_P12 }}\n          YCODING_MACOS_SIGNING_PASSWORD: ${{ secrets.YCODING_MACOS_SIGNING_PASSWORD }}\n          YCODING_MACOS_SIGNING_IDENTITY: YCoding Code Signing\n          YCODING_MACOS_SIGNING_SHA1: 9dd524184b0db949ffac7f0ada0ae860ac7f5f85\n")
  for (const command of [
    'security create-keychain -p "$keychain_password" "$keychain"',
    'security import "$RUNNER_TEMP/ycoding-signing.p12" -k "$keychain" -P "$YCODING_MACOS_SIGNING_PASSWORD" -T /usr/bin/codesign',
    'security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"',
    'security list-keychains -d user -s "$keychain" ${original[@]+"${original[@]}"}',
    'echo "::add-mask::$keychain_password"',
    'grep -F "$(printf \'%s\' "$YCODING_MACOS_SIGNING_SHA1" | tr a-f A-F) \\"$YCODING_MACOS_SIGNING_IDENTITY\\""',
  ])
    expect(importStep).toContain(command)
  expect(importStep).not.toContain("|| true")
  expect(importStep).not.toContain("login.keychain")
  const outside = desktop.replace(importStep, "")
  expect(outside.replace(darwinStep("Build TUI artifact"), "").replace(darwinStep("Stage Apple Silicon release runtime"), "")).not.toContain("secrets.")
  expect(outside).not.toContain("YCODING_MACOS_SIGNING_P12")
  expect(outside).not.toContain("YCODING_MACOS_SIGNING_PASSWORD")
  expect(build).toContain('/bin/sh packages/desktop/script/build.sh --outdir="$RUNNER_TEMP/desktop" --sign-identity=9dd524184b0db949ffac7f0ada0ae860ac7f5f85')
  expect([...build.matchAll(/^          ([A-Z0-9_]+):/gm)].map((match) => match[1]).sort()).toEqual([
    "RECEIPT_SHA256", "YCODING_RELEASE_RUNTIME_DIR",
  ])
  expect(verify).toContain('codesign --verify --deep --strict "$RUNNER_TEMP/desktop/YCoding Desktop.app"')
  expect(verify).toContain('codesign -d -r- "$RUNNER_TEMP/desktop/YCoding Desktop.app" 2>&1 | grep -Ex "designated => identifier \\"app\\.ycoding\\.desktop\\" and certificate (leaf|root) = H\\"9dd524184b0db949ffac7f0ada0ae860ac7f5f85\\""')
  expect(cleanup).toContain("        if: always()\n")
  const archived = darwinStep("Verify archived Desktop signatures")
  expect(archived).toContain('certificate leaf = H"9dd524184b0db949ffac7f0ada0ae860ac7f5f85"')
  expect(archived).toContain('codesign --verify --deep --strict -R "$requirement" "$app"')
  expect(archived).toContain('codesign --verify --deep --strict -R "$requirement" "$payload/inner/YCoding Desktop.app"')
  expect(desktop.indexOf("- name: Verify archived Desktop signatures")).toBeLessThan(desktop.indexOf("- name: Upload desktop archive"))
  for (const command of ['security list-keychains -d user -s "${original[@]}"', 'security delete-keychain "$keychain"', 'rm -f "$RUNNER_TEMP/ycoding-signing.p12"'])
    expect(cleanup).toContain(command)
  const order = ["- name: Provision Electrobun native assets", "- name: Import macOS signing identity", "- name: Build desktop app", "- name: Verify desktop signature", "- name: Upload desktop archive", "- name: Remove macOS signing keychain"].map((marker) => desktop.indexOf(marker))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(desktop.indexOf("bun script/release-archive.ts create-desktop")).toBeGreaterThan(desktop.indexOf("- name: Verify desktop signature"))
})

test.each([
  ["a self-signed root requirement", 'identifier "app.ycoding.desktop" and certificate root = H"9dd524184b0db949ffac7f0ada0ae860ac7f5f85"', true],
  ["a self-signed leaf requirement", 'identifier "app.ycoding.desktop" and certificate leaf = H"9dd524184b0db949ffac7f0ada0ae860ac7f5f85"', true],
  ["an ad-hoc cdhash requirement", 'cdhash H"1593f00c9269224608bcfc16986b4c7b1b09a2d5"', false],
  ["a different certificate", `identifier "app.ycoding.desktop" and certificate leaf = H"${"0".repeat(40)}"`, false],
  ["a different identifier", 'identifier "app.ycoding.computer-use" and certificate leaf = H"9dd524184b0db949ffac7f0ada0ae860ac7f5f85"', false],
  ["an unanchored identifier only", 'identifier "app.ycoding.desktop"', false],
])("the desktop signature check accepts only the pinned certificate: %s", (_, requirement, accepted) => {
  const check = darwinStep("Verify desktop signature").split("\n").find((line) => line.includes("codesign -d -r-"))?.trim()
  expect(check).toBeDefined()
  const command = check!.replace(/^codesign -d -r- "[^"]+" 2>&1/, 'printf "%s\\n" "designated => $REQUIREMENT"')
  const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", command], { env: { ...process.env, REQUIREMENT: requirement }, stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode === 0, result.stderr.toString()).toBe(accepted)
})

test.each(["lightweight", "annotated", "moved", "deleted", "off main", "wrong checkout"])("release provenance reads main and the exact incoming tag: %s", (scenario) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-release-ancestry-"))
  try {
    const git = (cwd: string, args: string[], stdin = "") => {
      const result = Bun.spawnSync(["git", ...args], { cwd, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    const remote = path.join(directory, "origin.git")
    git(directory, ["init", "--quiet", "--bare", remote])
    const tree = git(remote, ["mktree"])
    const author = "Release Fixture <release@example.test> 0 +0000"
    const commit = (label: string, parent?: string) => git(remote, ["hash-object", "-t", "commit", "-w", "--stdin"],
      [`tree ${tree}`, ...(parent ? [`parent ${parent}`] : []), `author ${author}`, `committer ${author}`, "", label, ""].join("\n"))
    const released = commit("release")
    const main = commit("main", released)
    const outside = commit("other branch", released)
    const sha = scenario === "off main" ? outside : released
    const ref = "refs/tags/v0.13.2"
    git(remote, ["update-ref", "refs/heads/main", main])
    git(remote, ["update-ref", "refs/heads/other", outside])
    git(remote, ["update-ref", "refs/tags/v0.13.1", main])
    if (scenario !== "deleted") {
      const tag = scenario === "annotated"
        ? git(remote, ["mktag"], `object ${sha}\ntype commit\ntag v0.13.2\ntagger ${author}\n\nRelease\n`)
        : scenario === "moved" ? main : sha
      git(remote, ["update-ref", ref, tag])
    }
    const checkout = path.join(directory, "checkout")
    git(directory, ["init", "--quiet", checkout])
    git(checkout, ["remote", "add", "origin", pathToFileURL(remote).href])
    git(checkout, ["fetch", "--depth=1", "--no-tags", "origin", scenario === "wrong checkout" ? main : sha])
    git(checkout, ["checkout", "--quiet", "--detach", "FETCH_HEAD"])
    const result = Bun.spawnSync(["bash", path.join(import.meta.dir, "release-version.sh"), "--verify-tag"], {
      cwd: checkout,
      env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: ref, GITHUB_SHA: sha, GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe", stderr: "pipe",
    })
    const accepted = scenario === "lightweight" || scenario === "annotated"
    expect(result.exitCode === 0, result.stderr.toString()).toBe(accepted)
    if (accepted) {
      expect(git(checkout, ["for-each-ref", "--format=%(refname)", "refs/tags"])).toBe(ref)
      expect(git(checkout, ["rev-parse", "refs/remotes/origin/main"])).toBe(main)
    } else if (scenario === "deleted" || scenario === "wrong checkout") {
      expect(git(checkout, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin", "refs/tags"])).toBe("")
    }
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
const installBun = await Bun.file(path.join(import.meta.dir, "../.github/actions/install-bun/action.yml")).text()

test("every Bun-installing job installs the pinned Bun through the hardened install action", async () => {
  const workflows = path.join(import.meta.dir, "../.github/workflows")
  for (const name of ["release.yml", "test.yml", "typecheck.yml"]) {
    const content = await Bun.file(path.join(workflows, name)).text()
    expect(content).not.toContain("oven-sh/setup-bun")
    expect(content).not.toContain("bun-download-url")
    expect(content).not.toContain("bun-version")
  }
  expect(setupBun).toContain("      uses: ./.github/actions/install-bun\n")
  expect(setupBun).not.toContain("oven-sh/setup-bun")
  expect(setupBun.indexOf("uses: ./.github/actions/install-bun")).toBeLessThan(setupBun.indexOf("Install dependencies"))
  for (const job of ["finalize-release", "release-tui"]) expect(workflowJob(workflow, job)).toContain("      - name: Install Bun\n        uses: ./.github/actions/install-bun\n")
  for (const job of ["verify-source", darwinJob, "deploy-web"]) expect(workflowJob(workflow, job)).toContain("uses: ./.github/actions/setup-bun")
})

test("install pins one Bun version for the release download, the setup action and the npm fallback", () => {
  const pins = installBun.match(/version=\d+\.\d+\.\d+/g) ?? []
  expect(pins).toEqual(["version=1.4.4"])
  expect(installBun).toContain("      id: bun-pin\n")
  expect(installBun).toContain("releases/download/bun-v${{ steps.bun-pin.outputs.version }}/bun-${OS}-x64-baseline.zip")
  expect(installBun).not.toContain("releases/latest")
  expect(installBun).not.toContain("latest")
  expect(installBun.match(/\n {8}bun-version: \$\{\{ steps\.bun-pin\.outputs\.version \}\}\n/g)).toHaveLength(2)
  expect(installBun.match(/\n {8}bun-download-url: \$\{\{ steps\.bun-url\.outputs\.url \}\}\n/g)).toHaveLength(2)
  expect(installBun).not.toContain("bun-version-file")
  expect(installBun).not.toContain("packageManager")
})

test("install retries the pinned Bun action once, then installs the same pinned Bun from npm and fails the job if that fails", () => {
  const pinned = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
  expect(installBun.split(pinned)).toHaveLength(3)
  expect(installBun).toContain("      id: bun-attempt-1\n      continue-on-error: true\n")
  expect(installBun).toContain("      id: bun-attempt-2\n      if: steps.bun-attempt-1.outcome == 'failure'\n      continue-on-error: true\n")
  const fallback = installBun.split("    - name: Install Bun from the npm registry\n")[1] ?? ""
  expect(fallback).toContain("      if: steps.bun-attempt-1.outcome == 'failure' && steps.bun-attempt-2.outcome == 'failure'\n")
  expect(fallback).not.toContain("continue-on-error")
  expect(fallback).toContain("BUN_VERSION: ${{ steps.bun-pin.outputs.version }}")
  for (const entry of [
    "Linux-X64) package=@oven/bun-linux-x64-baseline",
    "macOS-X64) package=@oven/bun-darwin-x64-baseline",
    "macOS-ARM64) package=@oven/bun-darwin-aarch64",
    "Windows-X64) package=@oven/bun-windows-x64-baseline",
  ])
    expect(fallback).toContain(entry)
  expect(fallback).toContain("set -euo pipefail")
  expect(fallback).toContain('"$package@$BUN_VERSION"')
  expect(fallback).toContain('test "$installed" = "$BUN_VERSION"')
  expect(fallback).not.toContain("|| true")
  expect(installBun).not.toContain("actions/setup-node")
  expect(installBun).not.toContain("bun install")
})

test("Bun setup installs dependencies without transferring the remote package store", async () => {
  expect(setupBun).not.toContain("actions/cache")
  expect(setupBun).not.toContain("BUN_INSTALL_CACHE_DIR")
  expect(setupBun).toContain("bun install ${{ inputs.install-flags }}")
  expect(setupBun).toContain("bun install --linker hoisted ${{ inputs.install-flags }}")
  expect(await Bun.file(path.join(import.meta.dir, "../.github/workflows/bun-cache.yml")).exists()).toBe(false)
})

test("Turbo restore keys are shared across CI without hashing installed packages", async () => {
  const types = await Bun.file(path.join(import.meta.dir, "../.github/workflows/typecheck.yml")).text()
  const key = "turbo-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('turbo.json', 'tsconfig.json', 'bun.lock') }}-"
  for (const content of [workflow, testWorkflow, types]) {
    const cache = content.split("- name: Cache Turbo\n")[1]?.split("\n      - name: ")[0] ?? ""
    expect(cache).toContain(`key: ${key}\${{ github.sha }}`)
    expect(cache).toContain(`\n            ${key}\n`)
    expect(cache).not.toContain("**/")
  }
})

test("PR verification retains the standard Linux and Windows runners", async () => {
  for (const runner of ["ubuntu-24.04", "windows-2025"]) expect(testWorkflow).toContain(`host: ${runner}`)
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
  expect(source).toContain("    needs: build-inputs\n    if: ${{ !cancelled() }}\n")
  expect(build).toContain("    needs: build-inputs\n    if: ${{ !cancelled() }}\n")
  for (const job of [source, build]) {
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

test("the independent build matrix retains native and Node compilations on Linux", () => {
  const lifecycle = workflowJob(testWorkflow, "build")
  expect(lifecycle).toContain("name: native and Node builds (${{ matrix.settings.name }})")
  expect(lifecycle).toContain("fail-fast: false")
  expect(lifecycle).toContain("runs-on: ${{ matrix.settings.host }}")
  expect(lifecycle).toContain("host: ubuntu-24.04")
  expect(lifecycle).not.toContain("windows-2025")
  expect(lifecycle).toContain("shell: bash")
  expect(lifecycle.indexOf("uses: ./.github/actions/setup-rust")).toBeGreaterThan(-1)
  expect(lifecycle.indexOf("uses: ./.github/actions/setup-rust")).toBeLessThan(lifecycle.indexOf("name: Build native executable"))
  const compiled = lifecycle.split("      - name: Build native executable\n")[1]?.split("\n      - name:")[0] ?? ""
  expect(compiled).toContain("timeout-minutes: 30")
  expect(compiled).toContain("working-directory: packages/cli")
  expect(compiled).toContain("run: bun run script/build.ts --single")
  const node = lifecycle.split("      - name: Verify Node build\n")[1] ?? ""
  expect(node).toContain("if: always() && needs.build-inputs.outputs.native != 'false'")
  expect(node).toContain("timeout-minutes: 10")
  expect(node).toContain("run: bun run script/build-node.ts --single --skip-install --outdir=dist/node")
  expect(lifecycle).not.toContain("service-smoke")
  expect(lifecycle).toContain('node-version: "24"')
  expect(lifecycle).toContain('node-version: "26.4.0"')
  expect(lifecycle.indexOf('node-version: "24"')).toBeLessThan(lifecycle.indexOf('node-version: "26.4.0"'))
  expect(lifecycle.indexOf("Verify compiled service lifecycle")).toBeLessThan(lifecycle.indexOf('node-version: "26.4.0"'))
  expect(lifecycle.indexOf('node-version: "26.4.0"')).toBeLessThan(lifecycle.indexOf("Verify Node build"))
})

test("native build jobs run only for native inputs and report each skip", () => {
  expect(testWorkflow).toContain("      native: ${{ steps.select.outputs.native }}")
  for (const name of ["build", "native-windows"]) {
    const job = workflowJob(testWorkflow, name)
    const steps = job.split("\n      - name: ").slice(1)
    const skip = steps.filter((step) => step.startsWith("Report native build skip\n"))
    expect(skip).toHaveLength(1)
    expect(skip[0]).toContain("if: needs.build-inputs.outputs.native == 'false'")
    expect(skip[0]).toContain('run: echo "Native runtime build inputs are unchanged."')
    for (const step of steps.filter((step) => !step.startsWith("Report native build skip\n")))
      expect(step, step.split("\n")[0]).toMatch(/if: (?:always\(\) && )?needs\.build-inputs\.outputs\.native != 'false'/)
  }
})

test("every external action in the test workflow is pinned to a full commit", () => {
  const uses = [...testWorkflow.matchAll(/^\s+uses: (\S+)/gm)].map((match) => match[1]!)
  expect(uses.length).toBeGreaterThan(0)
  for (const action of uses) expect(action.startsWith("./") || /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(action), action).toBe(true)
})

test("release source verification runs the typed decision suites and the guardrail failure-reason regression in the TUI leg", () => {
  const verify = workflowJob(workflow, "verify-source")
  const step = verify.split("      - name: Verify typed decision suites\n")[1]?.split("\n      - name:")[0] ?? ""
  expect(step).toContain("if: matrix.suite == 'tui-project'")
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

test("OAuth source checks run in separate Linux legs before release finalization", () => {
  const parsed = Bun.YAML.parse(workflow) as {
    jobs: {
      "verify-source": {
        needs?: unknown
        strategy: { "fail-fast": boolean; matrix: { include: { suite: string; runner: string }[] } }
        steps: { name?: string; if?: string; run?: string; "working-directory"?: string }[]
      }
      "finalize-release": { needs: string[] }
    }
  }
  const verifyConfig = parsed.jobs["verify-source"]
  expect(verifyConfig.needs).toBeUndefined()
  expect(verifyConfig.strategy["fail-fast"]).toBe(false)
  expect(verifyConfig.strategy.matrix.include).toContainEqual({ suite: "cli-antigravity", runner: "ubuntu-24.04" })
  expect(verifyConfig.strategy.matrix.include).toContainEqual({ suite: "cli-muse", runner: "ubuntu-24.04" })

  for (const [suite, commands] of Object.entries({
    "cli-antigravity": [
      "bun test --cwd packages/core ./test/plugin/provider-antigravity.test.ts ./test/plugin/provider-antigravity-signature-replay.test.ts",
      "bun test --cwd packages/cli/script ./antigravity-build-env.test.ts ./antigravity-build.test.ts",
    ],
    "cli-muse": [
      "bun test --cwd packages/core ./test/plugin/provider-muse.test.ts ./test/plugin/provider-muse-tools.test.ts ./test/provider-usage-muse.test.ts",
      "bun test --cwd packages/cli/script ./muse-build-env.test.ts ./muse-build.test.ts",
    ],
  })) {
    const checks = verifyConfig.steps.filter((step) => commands.some((command) => step.run?.includes(command)))
    expect(checks, suite).toHaveLength(1)
    expect(checks[0], suite).toMatchObject({ if: `matrix.suite == '${suite}'`, run: `${commands.join("\n")}\n` })
    expect(checks[0]?.["working-directory"], suite).toBeUndefined()
  }

  expect(parsed.jobs["finalize-release"].needs).toEqual(["verify-source", darwinJob])
})
