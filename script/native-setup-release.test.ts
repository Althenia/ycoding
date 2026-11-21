import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const action = Bun.YAML.parse(await Bun.file(path.join(import.meta.dir, "../.github/actions/setup-rust/action.yml")).text()) as {
  runs: { steps: { name: string; run?: string }[] }
}
const install = action.runs.steps.find((step) => step.name === "Install protoc")?.run
if (!install) throw new Error("Missing protoc installation step")

async function run(osName: string, arch: string, digest: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-protoc-setup-"))
  try {
    const bin = path.join(root, "bin")
    await mkdir(bin)
    const scripts: Record<string, string> = {
      curl: 'while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; printf archive > "$1"; fi; shift; done',
      sha256sum: 'printf "%s  archive\\n" "$SHIM_DIGEST"',
      unzip: 'echo unpack >> "$SHIM_LOG"; mkdir -p "$RUNNER_TEMP/protoc-36.2/bin"; printf "#!/bin/sh\\necho libprotoc 36.2\\n" > "$RUNNER_TEMP/protoc-36.2/bin/protoc"; chmod +x "$RUNNER_TEMP/protoc-36.2/bin/protoc"',
      powershell: 'echo unpack >> "$SHIM_LOG"; mkdir -p "$RUNNER_TEMP/protoc-36.2/bin"; printf "#!/bin/sh\\necho libprotoc 36.2\\n" > "$RUNNER_TEMP/protoc-36.2/bin/protoc.exe"; chmod +x "$RUNNER_TEMP/protoc-36.2/bin/protoc.exe"',
      cygpath: 'case "$2" in */protoc.exe) printf "C:\\\\synthetic\\\\protoc.exe\\n" ;; *) printf "%s\\n" "$2" ;; esac',
    }
    for (const [name, script] of Object.entries(scripts)) {
      const file = path.join(bin, name)
      await writeFile(file, `#!/bin/sh\n${script}\n`)
      await chmod(file, 0o755)
    }
    const envFile = path.join(root, "env")
    const log = path.join(root, "log")
    const child = Bun.spawn(["bash", "-euo", "pipefail", "-c", install], {
      env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: root, RUNNER_OS: osName, RUNNER_ARCH: arch,
        GITHUB_ENV: envFile, PROTOC_VERSION: "36.2", SHIM_DIGEST: digest, SHIM_LOG: log },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { code, stderr, env: await readFile(envFile, "utf8").catch(() => ""), log: await readFile(log, "utf8").catch(() => "") }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("Windows exports a native protoc path for cargo", async () => {
  const result = await run("Windows", "X64", "f0c128dc0d8492eceece83bb459a4c0e316764b929ffbf1aa416357fd644edd3")
  expect(result.code, result.stderr).toBe(0)
  expect(result.env).toBe("PROTOC=C:\\synthetic\\protoc.exe\n")
})

test("a checksum mismatch fails before extraction and never exports protoc", async () => {
  const result = await run("Linux", "X64", "0".repeat(64))
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("protoc checksum mismatch")
  expect(result.log).toBe("")
  expect(result.env).toBe("")
})

test("an unsupported runner fails before extraction and never exports protoc", async () => {
  const result = await run("Linux", "ARM64", "0".repeat(64))
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Unsupported runner")
  expect(result.log).toBe("")
  expect(result.env).toBe("")
})

test("the runtime source shard checks the setup and receipt contracts before using them", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(path.join(import.meta.dir, "../.github/workflows/release.yml")).text()) as {
    jobs: { "verify-source": { steps: { name: string; if?: string; run?: string }[] } }
  }
  const steps = workflow.jobs["verify-source"].steps
  const check = steps.findIndex((step) => step.name === "Verify native release bootstrap")
  const setup = steps.findIndex((step) => step.name === "Setup Rust for native contracts")
  expect(check).toBeGreaterThanOrEqual(0)
  expect(check).toBeLessThan(setup)
  expect(steps[check]?.if).toBe("matrix.suite == 'tui-runtime'")
  expect(steps[check]?.run).toContain("./native-bootstrap.test.ts ./native-setup-release.test.ts ./runtime-receipt.test.ts")
})
