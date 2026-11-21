import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const action = Bun.YAML.parse(await Bun.file(path.join(import.meta.dir, "../.github/actions/setup-rust/action.yml")).text()) as {
  runs: { steps: { name: string; if?: string; shell?: string; run?: string }[] }
}
const install = action.runs.steps.find((step) => step.name === "Install protoc")?.run ?? ""
if (!install) throw new Error("Missing protoc installation step")

async function run(osName: string, arch: string, digest: string, source: "download" | "cache" = "download") {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-protoc-setup-"))
  try {
    const bin = path.join(root, "bin")
    await mkdir(bin)
    const runnerTemp = osName === "Windows" ? path.join(root, "D:\\a\\_temp") : root
    if (source === "cache") {
      const cache = path.join(runnerTemp, "protoc-cache-36.2")
      await mkdir(cache, { recursive: true })
      await writeFile(path.join(cache, "protoc-36.2-win64.zip"), "archive")
    }
    const scripts: Record<string, string> = {
      curl: '[ "$SHIM_SOURCE" = download ] || exit 77; while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; printf archive > "$1"; fi; shift; done',
      sha256sum: String.raw`if [ "$#" = 0 ]; then [ "$(cat)" = archive ] || exit 78; fi; case "$1" in *\\*) printf '\\';; esac; printf '%s  archive\n' "$SHIM_DIGEST"`,
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
      env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: runnerTemp, RUNNER_OS: osName, RUNNER_ARCH: arch,
        GITHUB_ENV: envFile, PROTOC_VERSION: "36.2", SHIM_DIGEST: digest, SHIM_LOG: log, SHIM_SOURCE: source },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { code, stderr, env: await readFile(envFile, "utf8").catch(() => ""), log: await readFile(log, "utf8").catch(() => "") }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test.each(["download", "cache"] as const)("Windows verifies the protoc %s and exports a native path for cargo", async (source) => {
  const result = await run("Windows", "X64", "f0c128dc0d8492eceece83bb459a4c0e316764b929ffbf1aa416357fd644edd3", source)
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

test.each(["complete", "missing module"] as const)("Windows native tools verify Strawberry Perl with %s", async (perl) => {
  const step = action.runs.steps.find((entry) => entry.run?.includes("AWS_LC_SYS_PREBUILT_NASM"))
  expect(step?.if).toBe("runner.os == 'Windows'")
  expect(step?.shell).toBe("bash")
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-windows-build-tools-"))
  try {
    const envFile = path.join(root, "env")
    const nativePerl = String.raw`C:\Strawberry\perl\bin\perl.exe`
    const scripts = {
      cygpath: 'test "$1" = -u && test "$2" = "$SHIM_NATIVE_PERL" && printf "%s\\n" "$SHIM_ROOT/Strawberry Perl.exe"',
      perl: 'echo "Git Bash Perl was selected" >&2; exit 1',
      "Strawberry Perl.exe": `test "$1" = -MIPC::Cmd && test "$2" = -MLocale::Maketext::Simple && test "$3" = -e || exit 78
        if [ "$SHIM_PERL" = 'missing module' ]; then echo "Can't locate Locale/Maketext/Simple.pm" >&2; exit 1; fi`,
      nasm: 'test "$1" = -v && echo "NASM version 2.16.03"',
    }
    for (const [name, script] of Object.entries(scripts)) {
      const file = path.join(root, name)
      await writeFile(file, `#!/bin/sh\n${script}\n`)
      await chmod(file, 0o755)
    }
    await writeFile(envFile, "")
    const result = Bun.spawnSync(["bash", "-c", step?.run ?? "exit 79"], {
      env: { PATH: `${root}:/usr/bin:/bin`, GITHUB_ENV: envFile, SHIM_ROOT: root, SHIM_NATIVE_PERL: nativePerl, SHIM_PERL: perl },
      stdout: "pipe", stderr: "pipe",
    })
    if (perl === "missing module") {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain("Can't locate Locale/Maketext/Simple.pm")
      expect(await readFile(envFile, "utf8")).toBe("")
    } else {
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("NASM version")
      expect(await readFile(envFile, "utf8")).toBe(`OPENSSL_SRC_PERL=${nativePerl}\nAWS_LC_SYS_PREBUILT_NASM=1\n`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
