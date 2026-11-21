import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { nodeExecArgv, nodeTarget } from "../src/node/target"
import { mainConfig } from "../vite.node.config"

const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-operator-build-"))

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

const pinned = {
  bytes: 29_055,
  sha256: "554aabefcb0258eaa5c1966f8a719d049b56fb4e8db6bd9c953fe17cf25ccad8",
  finalNewline: true,
}

async function bundle(kind: "bun" | "node") {
  const entry = path.join(directory, `${kind}.ts`)
  await Bun.write(
    entry,
    `
    import { createHash } from "node:crypto"
    import { ycodingOperatorSkill } from ${JSON.stringify(path.resolve(import.meta.dirname, "../src/remote-control/ycoding-operator-skill.ts"))}
    const bytes = new TextEncoder().encode(ycodingOperatorSkill)
    console.log(JSON.stringify({
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      finalNewline: ycodingOperatorSkill.endsWith("\\n"),
    }))
  `,
  )
  const output = path.join(directory, kind === "bun" ? kind : `${kind}.mjs`)
  if (kind === "bun") {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      minify: true,
      compile: { outfile: output, autoloadDotenv: false, autoloadBunfig: false },
    })
    expect(result.success, result.logs.map(String).join("\n")).toBe(true)
    return [output]
  }
  const config = mainConfig({
    version: "synthetic",
    channel: "synthetic",
    models: "undefined",
    assetHash: "synthetic",
    target: nodeTarget(process.platform, process.arch),
  })
  const productionOutput = config.build?.rollupOptions?.output
  if (!productionOutput || Array.isArray(productionOutput)) throw new Error("Expected one Node output configuration")
  await build({
    ...config,
    configFile: false,
    envFile: false,
    logLevel: "silent",
    build: {
      ...config.build,
      ssr: entry,
      target: "node24",
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: { output: { ...productionOutput, entryFileNames: path.basename(output) } },
    },
  })
  return ["node", ...nodeExecArgv.filter((argument) => argument.startsWith("--disable-warning=")), output]
}

async function run(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  expect(stderr).toBe("")
  return JSON.parse(stdout)
}

for (const kind of ["bun", "node"] as const) {
  describe(`${kind} packaged operator skill`, () => {
    test("the built executable reports the pinned operator bytes", async () => {
      expect(await run(await bundle(kind))).toEqual(pinned)
    }, 120_000)
  })
}
