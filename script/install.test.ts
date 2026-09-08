import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const temporary: string[] = []
const installer = path.join(import.meta.dir, "install.sh")
setDefaultTimeout(30_000)

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("curl installer", () => {
  test("installs the verified release in ~/.local/bin and adds zsh PATH once", async () => {
    const fixture = await setup()
    const first = await runInstaller(fixture)

    expect(first.exitCode).toBe(0)
    expect(await readFile(path.join(fixture.home, ".local/bin/ycoding"), "utf8")).toBe("#!/bin/sh\necho ycoding 0.1.0\n")
    expect((await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).stat()).mode & 0o111).not.toBe(0)
    expect(await readFile(path.join(fixture.home, ".zshrc"), "utf8")).toBe(
      "# existing profile\nexport PATH=\"$HOME/.local/bin:$PATH\"\n",
    )
    expect(first.stdout).toContain("Installed ycoding 0.1.0")
    expect(first.stdout).toContain("Restart your shell")

    const second = await runInstaller(fixture)
    expect(second.exitCode).toBe(0)
    expect((await readFile(path.join(fixture.home, ".zshrc"), "utf8")).match(/\.local\/bin/g)?.length).toBe(1)
  })

  test("does not mutate a profile when ~/.local/bin is already on PATH", async () => {
    const fixture = await setup()
    const result = await runInstaller(fixture, { PATH: `${path.join(fixture.home, ".local/bin")}:${fixture.path}` })

    expect(result.exitCode).toBe(0)
    expect(await readFile(path.join(fixture.home, ".zshrc"), "utf8")).toBe("# existing profile\n")
  })

  test("recognizes an equivalent $HOME profile PATH entry", async () => {
    const equivalent = await setup()
    await writeFile(path.join(equivalent.home, ".zshrc"), 'export PATH="$PATH:$HOME/.local/bin"\n')
    const equivalentResult = await runInstaller(equivalent)
    expect(equivalentResult.exitCode).toBe(0)
    expect(await readFile(path.join(equivalent.home, ".zshrc"), "utf8")).toBe(
      'export PATH="$PATH:$HOME/.local/bin"\n',
    )

  })

  test("recognizes an equivalent absolute profile PATH entry", async () => {
    const absolute = await setup()
    await writeFile(path.join(absolute.home, ".zshrc"), `export PATH="${absolute.home}/.local/bin:$PATH"\n`)
    const absoluteResult = await runInstaller(absolute)
    expect(absoluteResult.exitCode).toBe(0)
    expect(await readFile(path.join(absolute.home, ".zshrc"), "utf8")).toBe(
      `export PATH="${absolute.home}/.local/bin:$PATH"\n`,
    )
  })

  test("does not confuse an unrelated .local/bin mention with a PATH entry", async () => {
    const fixture = await setup()
    await writeFile(path.join(fixture.home, ".zshrc"), "alias local-bin='echo $HOME/.local/bin'\n")
    const result = await runInstaller(fixture)

    expect(result.exitCode).toBe(0)
    expect(await readFile(path.join(fixture.home, ".zshrc"), "utf8")).toBe(
      "alias local-bin='echo $HOME/.local/bin'\nexport PATH=\"$HOME/.local/bin:$PATH\"\n",
    )
  })

  test("respects zsh ZDOTDIR", async () => {
    const zdotdir = await setup()
    const profiles = path.join(zdotdir.home, "zsh")
    await mkdir(profiles)
    const zdotdirResult = await runInstaller(zdotdir, { ZDOTDIR: profiles })
    expect(zdotdirResult.exitCode).toBe(0)
    expect(await readFile(path.join(profiles, ".zshrc"), "utf8")).toBe('export PATH="$HOME/.local/bin:$PATH"\n')
    expect(await readFile(path.join(zdotdir.home, ".zshrc"), "utf8")).toBe("# existing profile\n")
  })

  test("resolves the latest version from the fixed GitHub repository", async () => {
    const fixture = await setup()
    const result = await runInstaller(fixture, { YCODING_VERSION: "" })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Installed ycoding 0.1.0")
  })

  test("prints a manual fallback for unsupported shells without creating a profile", async () => {
    const fixture = await setup()
    const result = await runInstaller(fixture, { SHELL: "/usr/local/bin/fish" })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Add $HOME/.local/bin to PATH in your fish shell configuration')
    expect(await readFile(path.join(fixture.home, ".zshrc"), "utf8")).toBe("# existing profile\n")

    const unset = await setup()
    const unsetResult = await runInstaller(unset, { SHELL: "" })
    expect(unsetResult.exitCode).toBe(0)
    expect(unsetResult.stdout).toContain("Add $HOME/.local/bin to PATH in your shell configuration")
  })

  test("keeps the installed binary when checksum verification fails and cleans temporary files", async () => {
    const fixture = await setup()
    await mkdir(path.join(fixture.home, ".local/bin"), { recursive: true })
    await writeFile(path.join(fixture.home, ".local/bin/ycoding"), "old binary\n")
    await writeFile(path.join(fixture.fixture, "checksums"), `${"0".repeat(64)}  ${fixture.asset}\n`)

    const result = await runInstaller(fixture)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Checksum verification failed")
    expect(await readFile(path.join(fixture.home, ".local/bin/ycoding"), "utf8")).toBe("old binary\n")
    expect(await Array.fromAsync(new Bun.Glob("ycoding-install.*").scan(fixture.tmp))).toEqual([])
  })

  test("rejects invalid versions and unsupported platforms before downloading", async () => {
    const invalid = await setup()
    const invalidResult = await runInstaller(invalid, { YCODING_VERSION: "../../bad" })
    expect(invalidResult.exitCode).not.toBe(0)
    expect(invalidResult.stderr).toContain("Invalid YCoding version")
    expect(await Bun.file(path.join(invalid.fixture, "curl-called")).exists()).toBe(false)

    const unsupported = await setup({ system: "Linux", machine: "aarch64" })
    const unsupportedResult = await runInstaller(unsupported)
    expect(unsupportedResult.exitCode).not.toBe(0)
    expect(unsupportedResult.stderr).toContain("Unsupported platform: linux-arm64")
    expect(await Bun.file(path.join(unsupported.fixture, "curl-called")).exists()).toBe(false)
  })
})

async function setup(platform: { system: string; machine: string } = { system: "Darwin", machine: "arm64" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-installer-test-"))
  temporary.push(root)
  const home = path.join(root, "home")
  const fixture = path.join(root, "fixture")
  const bin = path.join(root, "bin")
  const tmp = path.join(root, "tmp")
  await Promise.all([mkdir(home), mkdir(fixture), mkdir(bin), mkdir(tmp)])
  await writeFile(path.join(home, ".zshrc"), "# existing profile\n")
  await writeFile(path.join(fixture, "ycoding"), "#!/bin/sh\necho ycoding 0.1.0\n")
  await chmod(path.join(fixture, "ycoding"), 0o755)
  const asset = "ycoding-0.1.0-darwin-arm64.tar.gz"
  const archive = path.join(fixture, asset)
  const tar = Bun.spawnSync(["tar", "-C", fixture, "-czf", archive, "ycoding"])
  expect(tar.exitCode).toBe(0)
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
  await writeFile(path.join(fixture, "checksums"), `${digest}  ${asset}\n`)
  await writeExecutable(
    path.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in\n  -s) printf '%s\\n' '${platform.system}' ;;\n  -m) printf '%s\\n' '${platform.machine}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  await writeExecutable(
    path.join(bin, "curl"),
    `#!/bin/sh
set -eu
touch "$FIXTURE/curl-called"
output=
url=
proto=false
proto_redir=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -w) shift 2 ;;
    --proto) [ "$2" = '=https' ] || exit 43; proto=true; shift 2 ;;
    --proto-redir) [ "$2" = '=https' ] || exit 44; proto_redir=true; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
[ "$proto" = true ] && [ "$proto_redir" = true ] || exit 45
case "$url" in
  https://github.com/Althenia/ycoding/releases/latest)
    printf '%s' 'https://github.com/Althenia/ycoding/releases/tag/v0.1.0' ;;
  https://github.com/Althenia/ycoding/releases/download/v0.1.0/ycoding-0.1.0-checksums.txt)
    cp "$FIXTURE/checksums" "$output" ;;
  https://github.com/Althenia/ycoding/releases/download/v0.1.0/ycoding-0.1.0-darwin-arm64.tar.gz)
    cp "$FIXTURE/ycoding-0.1.0-darwin-arm64.tar.gz" "$output" ;;
  *)
    printf 'unexpected URL: %s\\n' "$url" >&2
    exit 42 ;;
esac
`,
  )
  return { home, fixture, tmp, asset, path: `${bin}:/usr/bin:/bin` }
}

async function runInstaller(
  fixture: Awaited<ReturnType<typeof setup>>,
  environment: Record<string, string> = {},
) {
  const child = Bun.spawn(["/bin/sh", installer], {
    env: {
      HOME: fixture.home,
      SHELL: "/bin/zsh",
      PATH: fixture.path,
      TMPDIR: fixture.tmp,
      FIXTURE: fixture.fixture,
      YCODING_VERSION: "0.1.0",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function writeExecutable(file: string, content: string) {
  await writeFile(file, content)
  await chmod(file, 0o755)
}
