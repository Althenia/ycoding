import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = new URL("../../../../../../../", import.meta.url)
const tokens = new URL("apps/web/src/styles/tokens.css", root)
const names = ["base.css", "bridge.js", "build.mjs", "client.js", "model.js", "template.html"]

export async function inputDigest() {
  const hash = createHash("sha256")
  const inputs = [...names.map((name) => new URL(name, import.meta.url)), tokens].sort((left, right) =>
    left.pathname < right.pathname ? -1 : left.pathname > right.pathname ? 1 : 0,
  )
  for (const input of inputs) {
    hash.update(input.pathname.slice(root.pathname.length))
    hash.update("\0")
    hash.update(await readFile(input))
    hash.update("\0")
  }
  return hash.digest("hex")
}

export async function build() {
  const source = (await readFile(tokens, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]+$/gm, "")
  const light = source.match(/:root\s*\{([^}]+)\}/)?.[1]
  const dark = source.match(/\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1]
  if (!light || !dark) throw new Error("The current shared token themes are unavailable")
  const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), "--internal-bundle-client"], {
    cwd: fileURLToPath(root),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    killSignal: "SIGKILL",
  })
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`The local HTTP app bundler failed (${code}): ${errors.slice(0, 4096)}`)
  const script = output.trimEnd().replaceAll("</script", "<\\/script")
  const base = `:root { color-scheme: light dark;${light}}\n@media (prefers-color-scheme: dark) { :root {${dark}} }\n${await readFile(new URL("base.css", import.meta.url), "utf8")}`
  const html = (await readFile(new URL("template.html", import.meta.url), "utf8"))
    .replaceAll("{{BASE_CSS}}", base.trimEnd())
    .replaceAll("{{CLIENT_SCRIPT}}", script)
    .replaceAll("{{INPUT_DIGEST}}", await inputDigest())
  if (html.includes("{{") || script.includes("</script")) throw new Error("The local HTTP app document is incomplete")
  return html
}

async function main() {
  if (process.argv.includes("--internal-bundle-client")) {
    const bundle = await Bun.build({
      root: fileURLToPath(root),
      entrypoints: [fileURLToPath(new URL("client.js", import.meta.url))],
      target: "browser",
      format: "iife",
    })
    if (!bundle.success) throw new AggregateError(bundle.logs, "The local HTTP app client could not be bundled")
    await Bun.write(Bun.stdout, await bundle.outputs[0].text())
    return
  }
  const generated = await build()
  const output = new URL("index.html", import.meta.url)
  if (process.argv.includes("--check")) {
    const current = await readFile(output, "utf8").catch(() => undefined)
    if (current !== generated) throw new Error("The local HTTP app document does not match its maintained inputs")
  } else {
    await Bun.write(output, generated)
  }
}

if (import.meta.main) await main()
