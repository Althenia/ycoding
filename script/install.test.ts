import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const temporary: string[] = []
const installer = path.join(import.meta.dir, "install.sh")
const fixtureVersion = process.env.YCODING_TEST_VERSION ?? "9.9.9"
setDefaultTimeout(30_000)

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

// ditto and hdiutil only exist on macOS, so the disk image path cannot be
// exercised on the Linux runner that also runs this suite. The skip is declared
// once here so the gap is visible in the report instead of passing quietly.
const macTest = process.platform === "darwin" ? test : test.skip

describe("curl installer", () => {
  test("installs the verified release in ~/.local/bin and adds zsh PATH once", async () => {
    const fixture = await setup()
    const first = await runInstaller(fixture)

    expect(first.exitCode).toBe(0)
    expect(await readFile(path.join(fixture.home, ".local/bin/ycoding"), "utf8")).toBe(
      `#!/bin/sh\necho ycoding ${fixtureVersion}\n`,
    )
    expect((await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).stat()).mode & 0o111).not.toBe(0)
    expect(await readFile(path.join(fixture.home, ".local/bin/ycoding-computer-helper"), "utf8")).toBe(
      "#!/bin/sh\nexit 0\n",
    )
    expect(
      (await Bun.file(path.join(fixture.home, ".local/bin/ycoding-computer-helper")).stat()).mode & 0o111,
    ).not.toBe(0)
    expect(await readFile(path.join(fixture.home, ".zshrc"), "utf8")).toBe(
      '# existing profile\nexport PATH="$HOME/.local/bin:$PATH"\n',
    )
    expect(first.stdout).toContain(`Installed ycoding ${fixtureVersion}`)
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
    expect(await readFile(path.join(equivalent.home, ".zshrc"), "utf8")).toBe('export PATH="$PATH:$HOME/.local/bin"\n')
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
    expect(result.stdout).toContain(`Installed ycoding ${fixtureVersion}`)
  })

  test("prints a manual fallback for unsupported shells without creating a profile", async () => {
    const fixture = await setup()
    const result = await runInstaller(fixture, { SHELL: "/usr/local/bin/fish" })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Add $HOME/.local/bin to PATH in your fish shell configuration")
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

  test("restores the installed macOS pair when the final executable replacement fails", async () => {
    const fixture = await setup()
    const install = path.join(fixture.home, ".local/bin")
    await mkdir(install, { recursive: true })
    await writeFile(path.join(install, "ycoding"), "old ycoding\n")
    await writeFile(path.join(install, "ycoding-computer-helper"), "old helper\n")
    await writeExecutable(
      path.join(fixture.path.split(":")[0]!, "mv"),
      `#!/bin/sh
destination=
for argument do destination=$argument; done
if [ "$destination" = "$HOME/.local/bin/ycoding" ] && [ ! -e "$FIXTURE/mv-failed" ]; then
  touch "$FIXTURE/mv-failed"
  exit 70
fi
exec /bin/mv "$@"
`,
    )

    const result = await runInstaller(fixture)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Failed to install ycoding")
    expect(await readFile(path.join(install, "ycoding"), "utf8")).toBe("old ycoding\n")
    expect(await readFile(path.join(install, "ycoding-computer-helper"), "utf8")).toBe("old helper\n")
    expect(await Array.fromAsync(new Bun.Glob(".ycoding*").scan(install))).toEqual([])
  })

  test("retains an old helper backup with recovery guidance when rollback also fails", async () => {
    const fixture = await setup()
    const install = path.join(fixture.home, ".local/bin")
    await mkdir(install, { recursive: true })
    await writeFile(path.join(install, "ycoding"), "old ycoding\n")
    await writeFile(path.join(install, "ycoding-computer-helper"), "old helper\n")
    await writeExecutable(
      path.join(fixture.path.split(":")[0]!, "mv"),
      `#!/bin/sh
source=
destination=
for argument do
  case "$argument" in
    -*) ;;
    *) source=$destination; destination=$argument ;;
  esac
done
if [ "$destination" = "$HOME/.local/bin/ycoding" ] && [ ! -e "$FIXTURE/mv-failed" ]; then
  touch "$FIXTURE/mv-failed"
  exit 70
fi
case "$source:$destination" in
  */.ycoding-computer-helper-backup.*:"$HOME/.local/bin/ycoding-computer-helper") exit 71 ;;
esac
exec /bin/mv "$@"
`,
    )

    const result = await runInstaller(fixture)

    expect(result.exitCode).not.toBe(0)
    expect(await readFile(path.join(install, "ycoding"), "utf8")).toBe("old ycoding\n")
    expect(await Bun.file(path.join(install, "ycoding-computer-helper")).exists()).toBe(false)
    const backups = await Array.fromAsync(new Bun.Glob(".ycoding-computer-helper-backup.*").scan(install))
    expect(backups).toHaveLength(1)
    expect(await readFile(path.join(install, backups[0]!), "utf8")).toBe("old helper\n")
    expect(result.stderr).toContain(`Computer helper backup retained at ${path.join(install, backups[0]!)}`)
    expect(result.stderr).toContain(`Move that backup to ${path.join(install, "ycoding-computer-helper")}`)
  })

  test("rejects a macOS archive without the direct computer helper", async () => {
    const fixture = await setup()
    const tar = Bun.spawnSync([
      "tar",
      "-C",
      fixture.fixture,
      "-czf",
      path.join(fixture.fixture, fixture.asset),
      "ycoding",
    ])
    expect(tar.exitCode).toBe(0)
    await writeChecksum(fixture.fixture, fixture.asset)

    const result = await runInstaller(fixture)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Release archive has invalid direct entries")
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(false)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding-computer-helper")).exists()).toBe(false)
  })

  test("installs a Linux archive without a macOS helper", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64" })
    const result = await runInstaller(fixture)

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(true)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding-computer-helper")).exists()).toBe(false)
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

  test("leaves the desktop app uninstalled unless it is requested", async () => {
    const fixture = await setup(undefined, { office: true })
    const apps = path.join(fixture.home, "Applications")
    const result = await runInstaller(fixture, { YCODING_OFFICE_DIR: apps })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("YCoding Office")
    expect(await Bun.file(path.join(apps, "YCoding Office.app")).exists()).toBe(false)
  })

  macTest("installs the desktop app bundle when asked", async () => {
    const fixture = await setup(undefined, { office: true })
    const apps = path.join(fixture.home, "Applications")
    const result = await runInstaller(fixture, { YCODING_OFFICE_DIR: apps }, ["--office"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`Installed YCoding Office ${fixtureVersion} to ${apps}/YCoding Office.app`)
    const binary = path.join(apps, "YCoding Office.app/Contents/MacOS/YCoding Office")
    expect(await Bun.file(binary).exists()).toBe(true)
    expect((await Bun.file(binary).stat()).mode & 0o111).not.toBe(0)
    // Asking for the app must not cost the terminal install.
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(true)
  })

  test("installs the Linux desktop app beside the terminal executable", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64" }, { office: true })
    const result = await runInstaller(fixture, {}, ["--office"])

    expect(result.exitCode).toBe(0)
    const installed = path.join(fixture.home, ".local/bin/ycoding-office")
    expect(await Bun.file(installed).exists()).toBe(true)
    expect((await Bun.file(installed).stat()).mode & 0o111).not.toBe(0)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding-office.pck")).exists()).toBe(true)
  })

  test("fails a requested app install without undoing the terminal install", async () => {
    // No app artifact in the fixture, so the download cannot succeed.
    const fixture = await setup()
    const result = await runInstaller(
      fixture,
      { YCODING_OFFICE_DIR: path.join(fixture.home, "Applications") },
      ["--office"],
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Failed to download ycoding-office-")
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(true)
  })

  macTest("replaces an already installed desktop app instead of nesting it", async () => {
    const fixture = await setup(undefined, { office: true })
    const apps = path.join(fixture.home, "Applications")
    const previous = path.join(apps, "YCoding Office.app/Contents")
    await mkdir(previous, { recursive: true })
    await writeFile(path.join(previous, "stale"), "previous install\n")

    const result = await runInstaller(fixture, { YCODING_OFFICE_DIR: apps }, ["--office"])

    expect(result.exitCode).toBe(0)
    const installed = path.join(apps, "YCoding Office.app")
    expect(await Bun.file(path.join(installed, "Contents/stale")).exists()).toBe(false)
    expect(await Bun.file(path.join(installed, "Contents/MacOS/YCoding Office")).exists()).toBe(true)
    // A move onto an existing directory would leave the new bundle inside the old.
    const nested = await Array.fromAsync(new Bun.Glob("YCoding Office.app/.YCoding Office.app.*").scan(apps))
    expect(nested).toHaveLength(0)
  })

  macTest("releases the mounted image when the app bundle is unusable", async () => {
    const fixture = await setup(undefined, { office: true, unusableBundle: true })
    const result = await runInstaller(
      fixture,
      { YCODING_OFFICE_DIR: path.join(fixture.home, "Applications") },
      ["--office"],
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("The desktop app bundle has no runnable executable")
    // The failed attempt must not leave a mounted volume behind.
    const mounted = Bun.spawnSync(["mount"]).stdout.toString()
    expect(mounted).not.toContain(fixture.fixture)
    // And it must not cost the terminal install that already succeeded.
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(true)
  })

  test("rejects an unsupported argument instead of installing less than asked", async () => {
    const fixture = await setup()
    const result = await runInstaller(fixture, {}, ["--ofice"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Unknown argument: --ofice")
    expect(await Bun.file(path.join(fixture.fixture, "curl-called")).exists()).toBe(false)
  })
})

async function setup(
  platform: { system: string; machine: string } = { system: "Darwin", machine: "arm64" },
  options: { office?: boolean; unusableBundle?: boolean } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-installer-test-"))
  temporary.push(root)
  const home = path.join(root, "home")
  const fixture = path.join(root, "fixture")
  const bin = path.join(root, "bin")
  const tmp = path.join(root, "tmp")
  await Promise.all([mkdir(home), mkdir(fixture), mkdir(bin), mkdir(tmp)])
  await writeFile(path.join(home, ".zshrc"), "# existing profile\n")
  await writeFile(path.join(fixture, "ycoding"), `#!/bin/sh\necho ycoding ${fixtureVersion}\n`)
  await writeFile(path.join(fixture, "ycoding-computer-helper"), "#!/bin/sh\nexit 0\n")
  await chmod(path.join(fixture, "ycoding"), 0o755)
  await chmod(path.join(fixture, "ycoding-computer-helper"), 0o755)
  const target = `${platform.system === "Darwin" ? "darwin" : "linux"}-${["arm64", "aarch64"].includes(platform.machine) ? "arm64" : "x64"}`
  const asset = `ycoding-${fixtureVersion}-${target}.tar.gz`
  const archive = path.join(fixture, asset)
  const entries = platform.system === "Darwin" ? ["ycoding", "ycoding-computer-helper"] : ["ycoding"]
  const tar = Bun.spawnSync(["tar", "-C", fixture, "-czf", archive, ...entries])
  expect(tar.exitCode).toBe(0)
  await writeChecksum(fixture, asset)
  const officeAsset = options.office
    ? await writeOfficeArtifact(fixture, platform.system, { unusableBundle: options.unusableBundle })
    : undefined
  await writeExecutable(
    path.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in\n  -s) printf '%s\\n' '${platform.system}' ;;\n  -m) printf '%s\\n' '${platform.machine}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  const officeCase = officeAsset
    ? `  https://github.com/Althenia/ycoding/releases/download/v${fixtureVersion}/${officeAsset})\n    cp "$FIXTURE/${officeAsset}" "$output" ;;\n`
    : ""
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
    printf '%s' 'https://github.com/Althenia/ycoding/releases/tag/v${fixtureVersion}' ;;
  https://github.com/Althenia/ycoding/releases/download/v${fixtureVersion}/ycoding-${fixtureVersion}-checksums.txt)
    cp "$FIXTURE/checksums" "$output" ;;
  https://github.com/Althenia/ycoding/releases/download/v${fixtureVersion}/${asset})
    cp "$FIXTURE/${asset}" "$output" ;;
${officeCase}  *)
    printf 'unexpected URL: %s\\n' "$url" >&2
    exit 42 ;;
esac
`,
  )
  return { home, fixture, tmp, asset, officeAsset, path: `${bin}:/usr/bin:/bin` }
}

async function runInstaller(
  fixture: Awaited<ReturnType<typeof setup>>,
  environment: Record<string, string> = {},
  args: string[] = [],
) {
  const child = Bun.spawn(["/bin/sh", installer, ...args], {
    env: {
      HOME: fixture.home,
      SHELL: "/bin/zsh",
      PATH: fixture.path,
      TMPDIR: fixture.tmp,
      FIXTURE: fixture.fixture,
      YCODING_VERSION: fixtureVersion,
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

async function writeChecksum(fixture: string, asset: string) {
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path.join(fixture, asset)).arrayBuffer())
    .digest("hex")
  await writeFile(path.join(fixture, "checksums"), `${digest}  ${asset}\n`)
}

// Build an app artifact shaped like the released one and append its checksum to
// the release checksum file, which covers every asset in the release.
async function writeOfficeArtifact(fixture: string, system: string, options: { unusableBundle?: boolean } = {}) {
  if (system === "Darwin") {
    const stage = path.join(fixture, "stage")
    const macos = path.join(stage, "YCoding Office.app/Contents/MacOS")
    await mkdir(macos, { recursive: true })
    // An image whose bundle has no executable mounts fine and only fails once the
    // installer inspects it, which is the path that must still release the image.
    if (!options.unusableBundle) {
      const binary = path.join(macos, "YCoding Office")
      await writeFile(binary, "#!/bin/sh\nexit 0\n")
      await chmod(binary, 0o755)
    }
    await symlink("/Applications", path.join(stage, "Applications"))
    const officeAsset = `ycoding-office-${fixtureVersion}-darwin-universal.dmg`
    const archive = Bun.spawnSync([
      "hdiutil",
      "create",
      "-volname",
      "YCoding Office",
      "-srcfolder",
      stage,
      "-ov",
      "-format",
      "UDZO",
      path.join(fixture, officeAsset),
    ])
    expect(archive.exitCode).toBe(0)
    await appendChecksum(fixture, officeAsset)
    return officeAsset
  }
  const binary = path.join(fixture, "ycoding-office")
  await writeFile(binary, "#!/bin/sh\nexit 0\n")
  await chmod(binary, 0o755)
  await writeFile(path.join(fixture, "ycoding-office.pck"), "synthetic data pack\n")
  const officeAsset = `ycoding-office-${fixtureVersion}-linux-x64.tar.gz`
  const archive = Bun.spawnSync([
    "tar",
    "-C",
    fixture,
    "-czf",
    path.join(fixture, officeAsset),
    "ycoding-office",
    "ycoding-office.pck",
  ])
  expect(archive.exitCode).toBe(0)
  await appendChecksum(fixture, officeAsset)
  return officeAsset
}

async function appendChecksum(fixture: string, asset: string) {
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path.join(fixture, asset)).arrayBuffer())
    .digest("hex")
  const existing = await readFile(path.join(fixture, "checksums"), "utf8")
  await writeFile(path.join(fixture, "checksums"), `${existing}${digest}  ${asset}\n`)
}
