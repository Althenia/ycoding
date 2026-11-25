import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const full = { desktop: true, web: true, native: true }
const sha = /^(?!0{40}$)[0-9a-f]{40}$/

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe", timeout: 30_000 })
  if (!result.success) throw new Error(`git ${args[0]} did not complete successfully`)
  return result.stdout
}

function changedPaths() {
  const env = process.env
  const head = env.GITHUB_SHA ?? ""
  if (!sha.test(head) || git("rev-parse", "HEAD").toString().trim() !== head) throw new Error("The event revision is not checked out")
  const base = env.CI_PR_BASE
  if (!base || !sha.test(base)) throw new Error("The event has no usable comparison base")
  const parents = git("rev-list", "--parents", "-n", "1", head).toString().trim().split(" ")
  if (parents.length !== 3 || parents[1] !== base || parents[2] !== env.CI_PR_HEAD) {
    throw new Error("The checked-out PR merge does not match the event parents")
  }
  const output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    git("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head, "--"),
  )
  if (output && !output.endsWith("\0")) throw new Error("Git returned an incomplete path list")
  return output.split("\0").slice(0, -1)
}

function matches(file: string, inputs: readonly string[]) {
  return inputs.some((input) => input.endsWith("/") ? file.startsWith(input) : file === input)
}

const shared = [
  "package.json", "bun.lock", "bunfig.toml", "tsconfig.json", ".gitattributes", "patches/",
  ".github/workflows/test.yml", ".github/actions/setup-bun/", ".github/actions/install-bun/",
  "script/ci-build-inputs.ts", "packages/core/bunfig.toml", "packages/core/script/fix-node-pty.ts",
  "packages/client/src/", "packages/client/tsconfig.json", "packages/schema/src/", "packages/schema/tsconfig.json",
  "packages/remote/src/", "packages/remote/tsconfig.json", "assets/brand/fonts/Geist.woff2", "assets/brand/fonts/Geist-Italic.woff2",
]
const desktop = [
  "packages/desktop/src/", "packages/desktop/public/", "packages/desktop/index.html", "packages/desktop/vite.config.ts",
  "packages/desktop/tsconfig.json", "packages/desktop/bunfig.toml", "packages/protocol/src/", "packages/protocol/tsconfig.json",
  ...["bip-bop-01.mp3", "bip-bop-03.mp3", "staplebops-06.mp3", "nope-03.mp3"].map((name) => `packages/tui/src/assets/audio/${name}`),
]
const web = [
  "apps/web/src/", "apps/web/public/", "apps/web/index.html", "apps/web/vite.config.ts", "apps/web/tsconfig.json", "apps/web/bunfig.toml",
  "packages/core/src/", "packages/core/tsconfig.json", "packages/ai/src/", "packages/ai/tsconfig.json",
  "infra/cloudflare/src/", "infra/cloudflare/tsconfig.json", "infra/cloudflare/worker-configuration.d.ts",
  "infra/cloudflare/wrangler.jsonc", "infra/cloudflare/wrangler.preview.jsonc",
  "script/build-web-assets.ts", "script/install.sh", "docs/examples/ycoding.jsonc",
  "assets/brand/fonts/GeistMono.woff2", "assets/brand/fonts/OFL.txt",
]
const native = [
  "rust/", "protocol/", "packages/", "extensions/", "assets/", "patches/", ".github/actions/setup-rust/",
  "script/ycoding-workspace.ts", "script/release-version.sh", "script/runtime-receipt.sh",
]
const sourceTest = /^(?:apps\/web|packages\/[^/]+|infra\/cloudflare)\/src\/.*\.test(?:-helper)?\.[cm]?[jt]sx?$/

async function desktopWebSources() {
  const visited = new Set<string>()
  const pending = ["packages/desktop/src/renderer.tsx"]
  const ts = new Bun.Transpiler({ loader: "ts" })
  const tsx = new Bun.Transpiler({ loader: "tsx" })
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    if (!matches(file, ["packages/desktop/src/", "apps/web/src/"]) || !/\.(?:[cm]?[jt]sx?|css)$/.test(file)) continue
    const source = await Bun.file(path.join(root, file)).text()
    if (/import\.meta\.glob\s*\(/.test(source)) throw new Error("The Desktop source graph contains a glob import")
    const imports = file.endsWith(".css")
      ? Array.from(source.matchAll(/(?:@import\s+(?:url\(\s*)?|\burl\(\s*)(?:"([^"]+)"|'([^']+)'|([^\s'";)]+))/g), (match) => match[1] ?? match[2] ?? match[3]!)
      : [
          ...(file.endsWith("x") ? tsx : ts).scanImports(source).map((entry) => entry.path),
          ...Array.from(source.matchAll(/\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g), (match) => match[1]!),
        ]
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) continue
      const target = path.posix.join(path.posix.dirname(file), specifier.split(/[?#]/, 1)[0]!)
      if (!matches(target, ["packages/desktop/src/", "apps/web/"])) continue
      const candidates = path.posix.extname(target)
        ? [target, target.replace(/\.jsx?$/, ".ts"), target.replace(/\.jsx?$/, ".tsx")]
        : [target, ...[".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json", "/index.ts", "/index.tsx"].map((suffix) => `${target}${suffix}`)]
      const existing = await Promise.all(candidates.map(async (candidate) => await Bun.file(path.join(root, candidate)).exists() ? candidate : undefined))
      const resolved = existing.find((candidate) => candidate !== undefined)
      if (!resolved) throw new Error("A relative Desktop source dependency could not be resolved")
      pending.push(resolved)
    }
  }
  return visited
}

async function selectBuilds() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") return full
  try {
    const changed = changedPaths()
    const manifest: { workspaces: { packages: string[] } } = await Bun.file(path.join(root, "package.json")).json()
    if (!manifest.workspaces.packages.every((workspace) => /^(?:apps|extensions|packages)\/[\w.-]+$/.test(workspace))) {
      throw new Error("The workspace manifest uses an unrecognized package layout")
    }
    const workspaceManifests = new Set(manifest.workspaces.packages.map((workspace) => `${workspace}/package.json`))
    if (changed.some((file) => workspaceManifests.has(file) || matches(file, shared))) return full
    const inputs = changed.filter((file) => !sourceTest.test(file))
    const needsDesktop = inputs.some((file) => matches(file, desktop))
    const needsWeb = inputs.some((file) => matches(file, web))
    const needsNative = inputs.some((file) => matches(file, native))
    if (needsDesktop || !inputs.some((file) => file.startsWith("apps/web/"))) return { desktop: needsDesktop, web: needsWeb, native: needsNative }
    const borrowed = await desktopWebSources()
    return { desktop: inputs.some((file) => borrowed.has(file)), web: needsWeb, native: needsNative }
  } catch (error) {
    console.error(`Build input selection is uncertain; running both builds: ${error instanceof Error ? error.message : String(error)}`)
    return full
  }
}

const selected = await selectBuilds()
console.log(`desktop=${selected.desktop}\nweb=${selected.web}\nnative=${selected.native}`)
