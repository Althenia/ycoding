import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BrowserExtension } from "../packages/core/src/browser/extension"

const temporary: string[] = []
const installer = path.join(import.meta.dir, "install.sh")
const fixtureVersion = "0.7.0"
const macTest = process.platform === "darwin" ? test : test.skip
setDefaultTimeout(30_000)

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

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

  macTest("installs the signed app bundle alongside the executable pair from v0.7.1", async () => {
    const fixture = await setup({ version: "0.7.1" })
    await appArchive(fixture)
    const result = await runInstaller(fixture)
    expect(result.exitCode).toBe(0)
    expect(Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", path.join(fixture.home, ".local/bin/ycoding-computer-helper.app")]).exitCode).toBe(0)
    expect(await readFile(path.join(fixture.home, ".local/bin/ycoding-computer-helper.app/Contents/Resources/YCoding.icns"), "utf8")).toBe("fixture icon\n")
    expect(await readFile(path.join(fixture.home, ".local/bin/ycoding-computer-helper.app/Contents/Info.plist"), "utf8")).toContain("<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>")
    expect(await readFile(path.join(fixture.home, ".local/bin/ycoding-computer-helper"), "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  macTest("rejects a signed app without its icon before replacing the installed pair", async () => {
    const fixture = await setup({ version: "0.7.1" })
    await appArchive(fixture, false, false)
    const install = path.join(fixture.home, ".local/bin")
    await mkdir(install, { recursive: true })
    await writeFile(path.join(install, "ycoding"), "old executable\n")
    await writeFile(path.join(install, "ycoding-computer-helper"), "old helper\n")
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("missing required entries")
    expect(result.stderr).toContain("YCoding.icns")
    expect(await readFile(path.join(install, "ycoding"), "utf8")).toBe("old executable\n")
    expect(await Bun.file(path.join(install, "ycoding-computer-helper.app")).exists()).toBe(false)
  })

  macTest("installs releases after v0.7.1 with only YCoding Computer Use.app and removes superseded helpers", async () => {
    const fixture = await setup({ version: "0.7.2" })
    await appArchive(fixture, false, true, true)
    const install = path.join(fixture.home, ".local/bin")
    const legacy = path.join(install, "ycoding-computer-helper.app/Contents")
    await mkdir(legacy, { recursive: true })
    await writeFile(path.join(legacy, "Info.plist"), "old app\n")
    await writeFile(path.join(install, "ycoding-computer-helper"), "old helper\n")
    const result = await runInstaller(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", path.join(install, "YCoding Computer Use.app")]).exitCode).toBe(0)
    expect(await readFile(path.join(install, "YCoding Computer Use.app/Contents/Info.plist"), "utf8")).toContain("<key>CFBundleIdentifier</key><string>app.ycoding.computer-use</string>")
    expect(await Bun.file(path.join(install, "ycoding-computer-use")).exists()).toBe(false)
    expect(await Bun.file(path.join(install, "ycoding-computer-helper")).exists()).toBe(false)
    expect(await readFile(path.join(install, "ycoding-chrome-extension/manifest.json"), "utf8")).toBe("fixture manifest.json\n")
    expect(await Bun.file(path.join(legacy, "Info.plist")).exists()).toBe(false)
    expect(await Array.fromAsync(new Bun.Glob(".ycoding*").scan({ cwd: install, dot: true, onlyFiles: false }))).toEqual([])
  })

  test("installs the Chrome extension beside a Linux executable from releases after v0.7.1", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64", version: "0.7.2" })
    await linuxExtensionArchive(fixture)
    const install = path.join(fixture.home, ".local/bin")
    await mkdir(path.join(install, "ycoding-chrome-extension"), { recursive: true })
    await writeFile(path.join(install, "ycoding-chrome-extension/stale.js"), "old\n")
    const result = await runInstaller(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(await readFile(path.join(install, "ycoding-chrome-extension/manifest.json"), "utf8")).toBe("fixture manifest.json\n")
    expect(await Bun.file(path.join(install, "ycoding-chrome-extension/stale.js")).exists()).toBe(false)
    expect(await Array.fromAsync(new Bun.Glob(".ycoding*").scan({ cwd: install, dot: true, onlyFiles: false }))).toEqual([])
  })

  test.each(["0.7.14", "0.7.15"])("installs a v%s release that carries LICENSE and NOTICE without copying them into the install directory", async (version) => {
    const fixture = await setup({ system: "Linux", machine: "x86_64", version })
    await linuxExtensionArchive(fixture, ["LICENSE", "NOTICE"])
    const install = path.join(fixture.home, ".local/bin")
    const result = await runInstaller(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect((await readdir(install)).sort()).toEqual(["ycoding", "ycoding-chrome-extension"])
  })

  test("installs a release archive without LICENSE and NOTICE", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64", version: "0.7.16" })
    await linuxExtensionArchive(fixture)
    const install = path.join(fixture.home, ".local/bin")
    const result = await runInstaller(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect((await readdir(install)).sort()).toEqual(["ycoding", "ycoding-chrome-extension"])
  })

  test("skips unknown archive files and directories without extracting or installing them", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64", version: "0.7.2" })
    await linuxExtensionArchive(fixture, ["LICENSE"])
    await writeFile(path.join(fixture.fixture, "extra"), "extra\n")
    await mkdir(path.join(fixture.fixture, "nested/deep"), { recursive: true })
    await writeFile(path.join(fixture.fixture, "nested/deep/file"), "nested\n")
    await writeFile(path.join(fixture.fixture, "ycoding-chrome-extension/unlisted.js"), "unlisted\n")
    const tar = Bun.spawnSync(["tar", "-C", fixture.fixture, "-czf", path.join(fixture.fixture, fixture.asset), "ycoding", "ycoding-chrome-extension", "LICENSE", "extra", "nested"], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
    expect(tar.exitCode).toBe(0)
    await writeChecksum(fixture.fixture, fixture.asset)
    const install = path.join(fixture.home, ".local/bin")
    const result = await runInstaller(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect((await readdir(install)).sort()).toEqual(["ycoding", "ycoding-chrome-extension"])
    expect((await readdir(path.join(install, "ycoding-chrome-extension"))).sort()).toEqual(["icons", ...BrowserExtension.files.filter((file) => !file.includes("/"))].sort())
  })

  test.each([
    ["symbolic link", "invalid entry types", tarEntry("link", { type: "2", link: "ycoding" })],
    ["hard link", "invalid entry types", tarEntry("link", { type: "1", link: "ycoding" })],
    ["named pipe", "invalid entry types", tarEntry("pipe", { type: "6" })],
    ["absolute path", "unsafe or duplicate entry names", tarEntry("/tmp/ycoding-escape", { content: "x\n" })],
    ["parent directory", "unsafe or duplicate entry names", tarEntry("../ycoding-escape", { content: "x\n" })],
    ["nested parent directory", "unsafe or duplicate entry names", tarEntry("nested/../ycoding-escape", { content: "x\n" })],
    ["current directory prefix", "unsafe or duplicate entry names", tarEntry("./extra", { content: "x\n" })],
    ["control character", "unsafe or duplicate entry names", tarEntry("bad\u0007name", { content: "x\n" })],
    ["backslash", "unsafe or duplicate entry names", tarEntry("nested\\extra", { content: "x\n" })],
    ["duplicate entry", "unsafe or duplicate entry names", tarEntry("ycoding", { content: "replacement\n" })],
  ])("rejects an unknown %s entry before installing anything", async (_, message, entry) => {
    const fixture = await setup({ system: "Linux", machine: "x86_64", version: "0.7.0" })
    await craftedArchive(fixture, [tarEntry("ycoding", { content: "new executable\n" }), entry])
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(message)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(false)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding-escape")).exists()).toBe(false)
  })

  test("rejects an archive with more entries than the limit before installing anything", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64", version: "0.7.0" })
    await craftedArchive(fixture, [tarEntry("ycoding", { content: "new executable\n" }), ...Array.from({ length: 1025 }, (_, index) => tarEntry(`extra-${index}`, { content: "x" }))])
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("too many entries")
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(false)
  })

  test("rejects an entry that declares more than the archive size limit before installing anything", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64", version: "0.7.0" })
    await craftedArchive(fixture, [tarEntry("ycoding", { content: "new executable\n" }), tarEntry("extra", { size: 600 * 1024 * 1024 })])
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(false)
  })

  test("restores the installed Chrome extension when final executable replacement fails", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64", version: "0.7.2" })
    await linuxExtensionArchive(fixture)
    const install = path.join(fixture.home, ".local/bin")
    await mkdir(path.join(install, "ycoding-chrome-extension"), { recursive: true })
    await writeFile(path.join(install, "ycoding-chrome-extension/manifest.json"), "old manifest\n")
    await writeFile(path.join(install, "ycoding"), "old executable\n")
    await writeExecutable(path.join(fixture.path.split(":")[0]!, "mv"), `#!/bin/sh\ndestination=\nfor argument do destination=$argument; done\nif [ "$destination" = "$HOME/.local/bin/ycoding" ] && [ ! -e "$FIXTURE/mv-failed" ]; then touch "$FIXTURE/mv-failed"; exit 70; fi\nexec /bin/mv "$@"\n`)
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(path.join(install, "ycoding-chrome-extension/manifest.json"), "utf8")).toBe("old manifest\n")
    expect(await readFile(path.join(install, "ycoding"), "utf8")).toBe("old executable\n")
    expect(await Array.fromAsync(new Bun.Glob(".ycoding*").scan({ cwd: install, dot: true, onlyFiles: false }))).toEqual([])
  })

  macTest("skips a bare computer-use executable in a later release", async () => {
    const fixture = await setup({ version: "0.7.2" })
    await appArchive(fixture, false, true, true)
    await copyFile(path.join(fixture.fixture, "ycoding-computer-helper"), path.join(fixture.fixture, "ycoding-computer-use"))
    const tar = Bun.spawnSync(["tar", "-C", fixture.fixture, "-czf", path.join(fixture.fixture, fixture.asset), "ycoding", "ycoding-computer-use", "ycoding-chrome-extension", "YCoding Computer Use.app"], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
    expect(tar.exitCode).toBe(0)
    await writeChecksum(fixture.fixture, fixture.asset)
    const result = await runInstaller(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect((await readdir(path.join(fixture.home, ".local/bin"))).sort()).toEqual(["YCoding Computer Use.app", "ycoding", "ycoding-chrome-extension"])
  })

  macTest("rejects v0.7.1 helper names in a later release", async () => {
    const fixture = await setup({ version: "0.7.2" })
    await appArchive(fixture)
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("missing required entries")
  })

  macTest.each(["0.7.14", "0.7.15"])("installs the published macOS %s layout with LICENSE and NOTICE and installs neither", async (version) => {
    const fixture = await setup({ version })
    await appArchive(fixture, false, true, true, ["LICENSE", "NOTICE"])
    const result = await runInstaller(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect((await readdir(path.join(fixture.home, ".local/bin"))).sort()).toEqual(["YCoding Computer Use.app", "ycoding", "ycoding-chrome-extension"])
  })

  macTest("restores superseded helpers when a renamed release fails its final replacement", async () => {
    const fixture = await setup({ version: "0.7.2" })
    await appArchive(fixture, false, true, true)
    const install = path.join(fixture.home, ".local/bin")
    const legacy = path.join(install, "ycoding-computer-helper.app/Contents")
    await mkdir(legacy, { recursive: true })
    await writeFile(path.join(legacy, "Info.plist"), "old app\n")
    await writeFile(path.join(install, "ycoding"), "old executable\n")
    await writeFile(path.join(install, "ycoding-computer-helper"), "old helper\n")
    await writeExecutable(path.join(fixture.path.split(":")[0]!, "mv"), `#!/bin/sh\ndestination=\nfor argument do destination=$argument; done\nif [ "$destination" = "$HOME/.local/bin/ycoding" ] && [ ! -e "$FIXTURE/mv-failed" ]; then touch "$FIXTURE/mv-failed"; exit 70; fi\nexec /bin/mv "$@"\n`)
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(path.join(legacy, "Info.plist"), "utf8")).toBe("old app\n")
    expect(await readFile(path.join(install, "ycoding-computer-helper"), "utf8")).toBe("old helper\n")
    expect(await Bun.file(path.join(install, "ycoding-computer-use")).exists()).toBe(false)
    expect(await Bun.file(path.join(install, "YCoding Computer Use.app/Contents/Info.plist")).exists()).toBe(false)
    expect(await readFile(path.join(install, "ycoding"), "utf8")).toBe("old executable\n")
    expect(await Array.fromAsync(new Bun.Glob(".ycoding*").scan({ cwd: install, dot: true, onlyFiles: false }))).toEqual([])
  })

  test("keeps the published pair format for a prerelease below v0.7.1", async () => {
    const fixture = await setup({ version: "0.7.1-beta.1" })
    const result = await runInstaller(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding-computer-helper.app/Contents/Info.plist")).exists()).toBe(false)
  })

  test("rejects missing app and app symlinks without modifying installed files", async () => {
    const fixture = await setup({ version: "0.7.1" })
    const install = path.join(fixture.home, ".local/bin")
    await mkdir(install, { recursive: true })
    await writeFile(path.join(install, "ycoding"), "old executable\n")
    expect((await runInstaller(fixture)).stderr).toContain("missing required entries")
    await appArchive(fixture, true)
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(path.join(install, "ycoding"), "utf8")).toBe("old executable\n")
    expect(await Bun.file(path.join(install, "ycoding-computer-helper.app/Contents/Info.plist")).exists()).toBe(false)
  })

  macTest("restores an existing app bundle when final executable replacement fails", async () => {
    const fixture = await setup({ version: "0.7.1" })
    await appArchive(fixture)
    const install = path.join(fixture.home, ".local/bin")
    const oldApp = path.join(install, "ycoding-computer-helper.app/Contents")
    await mkdir(oldApp, { recursive: true })
    await writeFile(path.join(oldApp, "Info.plist"), "old app\n")
    await writeFile(path.join(install, "ycoding"), "old executable\n")
    await writeFile(path.join(install, "ycoding-computer-helper"), "old helper\n")
    await writeExecutable(path.join(fixture.path.split(":")[0]!, "mv"), `#!/bin/sh\ndestination=\nfor argument do destination=$argument; done\nif [ "$destination" = "$HOME/.local/bin/ycoding" ] && [ ! -e "$FIXTURE/mv-failed" ]; then touch "$FIXTURE/mv-failed"; exit 70; fi\nexec /bin/mv "$@"\n`)
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(path.join(oldApp, "Info.plist"), "utf8")).toBe("old app\n")
    expect(await readFile(path.join(install, "ycoding"), "utf8")).toBe("old executable\n")
    expect(await Array.fromAsync(new Bun.Glob(".ycoding*").scan(install))).toEqual([])
  })

  macTest("removes a newly added app bundle when final executable replacement fails", async () => {
    const fixture = await setup({ version: "0.7.1" })
    await appArchive(fixture)
    const install = path.join(fixture.home, ".local/bin")
    await mkdir(install, { recursive: true })
    await writeFile(path.join(install, "ycoding"), "old executable\n")
    await writeFile(path.join(install, "ycoding-computer-helper"), "old helper\n")
    await writeExecutable(path.join(fixture.path.split(":")[0]!, "mv"), `#!/bin/sh\ndestination=\nfor argument do destination=$argument; done\nif [ "$destination" = "$HOME/.local/bin/ycoding" ] && [ ! -e "$FIXTURE/mv-failed" ]; then touch "$FIXTURE/mv-failed"; exit 70; fi\nexec /bin/mv "$@"\n`)
    const result = await runInstaller(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(path.join(install, "ycoding"), "utf8")).toBe("old executable\n")
    expect(await readFile(path.join(install, "ycoding-computer-helper"), "utf8")).toBe("old helper\n")
    expect(await Bun.file(path.join(install, "ycoding-computer-helper.app/Contents/Info.plist")).exists()).toBe(false)
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
    expect(result.stderr).toContain("missing required entries: ycoding-computer-helper")
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(false)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding-computer-helper")).exists()).toBe(false)
  })

  test("installs a Linux archive without a macOS helper", async () => {
    const fixture = await setup({ system: "Linux", machine: "x86_64" })
    const result = await runInstaller(fixture)

    expect(result.exitCode, result.stderr).toBe(0)
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

  test("rejects the removed --office flag instead of installing a desktop app", async () => {
    const fixture = await setup()
    const result = await runInstaller(fixture, {}, ["--office"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Unknown argument: --office")
    expect(await Bun.file(path.join(fixture.fixture, "curl-called")).exists()).toBe(false)
    expect(await Bun.file(path.join(fixture.home, ".local/bin/ycoding")).exists()).toBe(false)
  })

  test("rejects an unsupported argument instead of installing less than asked", async () => {
    const fixture = await setup()
    const result = await runInstaller(fixture, {}, ["--ofice"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Unknown argument: --ofice")
    expect(await Bun.file(path.join(fixture.fixture, "curl-called")).exists()).toBe(false)
  })
})

async function setup(platform: { system?: string; machine?: string; version?: string } = {}) {
  const system = platform.system ?? "Darwin"
  const machine = platform.machine ?? "arm64"
  const version = platform.version ?? fixtureVersion
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
  const target = `${system === "Darwin" ? "darwin" : "linux"}-${["arm64", "aarch64"].includes(machine) ? "arm64" : "x64"}`
  const asset = `ycoding-${version}-${target}.tar.gz`
  const archive = path.join(fixture, asset)
  const entries = system === "Darwin" ? ["ycoding", "ycoding-computer-helper"] : ["ycoding"]
  const tar = Bun.spawnSync(["tar", "-C", fixture, "-czf", archive, ...entries])
  expect(tar.exitCode).toBe(0)
  await writeChecksum(fixture, asset)
  await writeExecutable(
    path.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in\n  -s) printf '%s\\n' '${system}' ;;\n  -m) printf '%s\\n' '${machine}' ;;\n  *) exit 1 ;;\nesac\n`,
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
    --max-filesize) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
[ "$proto" = true ] && [ "$proto_redir" = true ] || exit 45
case "$url" in
  https://github.com/Althenia/ycoding/releases/latest)
    printf '%s' 'https://github.com/Althenia/ycoding/releases/tag/v${version}' ;;
  https://github.com/Althenia/ycoding/releases/download/v${version}/ycoding-${version}-checksums.txt)
    cp "$FIXTURE/checksums" "$output" ;;
  https://github.com/Althenia/ycoding/releases/download/v${version}/${asset})
    cp "$FIXTURE/${asset}" "$output" ;;
  *)
    printf 'unexpected URL: %s\\n' "$url" >&2
    exit 42 ;;
esac
`,
  )
  return { home, fixture, tmp, asset, version, path: `${bin}:/usr/bin:/bin` }
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
      YCODING_VERSION: fixture.version,
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

async function appArchive(fixture: Awaited<ReturnType<typeof setup>>, linked = false, icon = true, renamed = false, files: string[] = []) {
  const name = renamed ? "YCoding Computer Use.app" : "ycoding-computer-helper.app"
  const helper = renamed ? "ycoding-computer-use" : "ycoding-computer-helper"
  const bundleID = renamed ? "app.ycoding.computer-use" : "app.ycoding.computer-helper"
  const contents = path.join(fixture.fixture, name, "Contents")
  await mkdir(path.join(contents, "MacOS"), { recursive: true })
  await mkdir(path.join(contents, "_CodeSignature"))
  if (icon) await mkdir(path.join(contents, "Resources"))
  await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${helper}</string><key>CFBundleIdentifier</key><string>${bundleID}</string><key>CFBundleDisplayName</key><string>YCoding Computer Use</string><key>CFBundleIconFile</key><string>YCoding.icns</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>`)
  if (icon) await writeFile(path.join(contents, "Resources/YCoding.icns"), "fixture icon\n")
  if (linked) await symlink(`../../../${helper}`, path.join(contents, `MacOS/${helper}`))
  else {
    await copyFile("/usr/bin/true", path.join(contents, `MacOS/${helper}`))
    await chmod(path.join(contents, `MacOS/${helper}`), 0o755)
    const sign = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", path.join(fixture.fixture, name)])
    expect(sign.exitCode).toBe(0)
  }
  if (linked) await writeFile(path.join(contents, "_CodeSignature/CodeResources"), "signature\n")
  for (const file of files) await writeFile(path.join(fixture.fixture, file), `fixture ${file}\n`)
  const tar = Bun.spawnSync(["tar", "-C", fixture.fixture, "-czf", path.join(fixture.fixture, fixture.asset), "ycoding", ...(renamed ? [] : [helper]), name, ...(renamed ? [await writeExtension(fixture.fixture)] : []), ...files], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
  expect(tar.exitCode).toBe(0)
  await writeChecksum(fixture.fixture, fixture.asset)
}

async function writeExtension(directory: string) {
  const extension = path.join(directory, "ycoding-chrome-extension")
  await mkdir(path.join(extension, "icons"), { recursive: true })
  for (const file of BrowserExtension.files) await writeFile(path.join(extension, file), `fixture ${file}\n`)
  return "ycoding-chrome-extension"
}

async function linuxExtensionArchive(fixture: Awaited<ReturnType<typeof setup>>, files: string[] = []) {
  const extension = await writeExtension(fixture.fixture)
  for (const file of files) await writeFile(path.join(fixture.fixture, file), `fixture ${file}\n`)
  const tar = Bun.spawnSync(["tar", "-C", fixture.fixture, "-czf", path.join(fixture.fixture, fixture.asset), "ycoding", extension, ...files], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
  expect(tar.exitCode).toBe(0)
  await writeChecksum(fixture.fixture, fixture.asset)
}

async function craftedArchive(fixture: Awaited<ReturnType<typeof setup>>, parts: Uint8Array[]) {
  await writeFile(path.join(fixture.fixture, fixture.asset), Bun.gzipSync(Buffer.concat([...parts, new Uint8Array(1024)])))
  await writeChecksum(fixture.fixture, fixture.asset)
}

function tarEntry(name: string, options: { type?: string; content?: string; link?: string; size?: number } = {}) {
  const text = new TextEncoder()
  const content = text.encode(options.content ?? "")
  const header = new Uint8Array(512)
  const field = (value: string, offset: number) => header.set(text.encode(value), offset)
  field(name, 0)
  field("0000644\0", 100)
  field("0000000\0", 108)
  field("0000000\0", 116)
  field(`${(options.size ?? content.length).toString(8).padStart(11, "0")}\0`, 124)
  field("00000000000\0", 136)
  field("        ", 148)
  field(options.type ?? "0", 156)
  field(options.link ?? "", 157)
  field("ustar\x0000", 257)
  field(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148)
  const data = new Uint8Array(Math.ceil(content.length / 512) * 512)
  data.set(content)
  return Buffer.concat([header, data])
}
