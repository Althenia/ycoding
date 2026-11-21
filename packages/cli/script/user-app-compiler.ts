import { fileURLToPath } from "node:url"

export type LibraryInput = Parameters<typeof import("../vite.node.config").userAppConfig>[0]

export async function compileUserAppModule(input: LibraryInput) {
  const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), JSON.stringify(input)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`User-app module build failed (${code}): ${stderr || stdout}`)
}

async function compile(input: LibraryInput) {
  const [{ build }, { userAppConfig }] = await Promise.all([import("vite"), import("../vite.node.config")])
  await build(userAppConfig(input))
}

if (import.meta.main) {
  const serialized = process.argv[2]
  if (!serialized) throw new Error("User-app module builder requires a JSON input argument")
  await compile(JSON.parse(serialized) as LibraryInput)
}
