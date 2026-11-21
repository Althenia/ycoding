import { createHash } from "node:crypto"
import { chmod, copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { CONTRACT_DIGEST } from "@ycoding-ai/protocol/v5"
import { compileUserAppModule, type LibraryInput } from "./user-app-compiler"

export function userAppPackageMetadata(enabled: boolean) {
  return enabled
    ? {
        type: "module",
        exports: { "./server-process": { types: "./lib/server-process.d.ts", import: "./lib/server-process.mjs" } },
      }
    : {}
}

export async function writePacket(
  directory: string,
  input: {
    readonly version: string
    readonly channel: string
    readonly os: string
    readonly arch: string
    readonly frontend: string
    readonly runtime: { readonly file: string; readonly sha256: string; readonly payloadSha256: string }
  },
) {
  const file = async (filename: string) => ({
    file: filename,
    sha256: createHash("sha256")
      .update(await readFile(path.join(directory, filename)))
      .digest("hex"),
  })
  const [frontend, module, declarations, payload] = await Promise.all([
    file(input.frontend),
    file("server-process.mjs"),
    file("server-process.d.ts"),
    file(input.runtime.file),
  ])
  if (payload.sha256 !== input.runtime.payloadSha256)
    throw new Error("User-app native payload does not match its build receipt")
  const manifest = {
    version: input.version,
    channel: input.channel,
    os: input.os,
    arch: input.arch,
    wireRevision: 5,
    contractDigest: CONTRACT_DIGEST,
    frontend,
    module,
    declarations,
    runtime: input.runtime,
  }
  await writeFile(path.join(directory, "user-app.packet.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  })
}

export async function buildUserAppLibrary(input: LibraryInput, compile = compileUserAppModule) {
  await mkdir(input.directory)
  await compile(input)
  await Promise.all([
    copyFile(
      path.resolve(import.meta.dirname, "../src/user-app-api.d.ts"),
      path.join(input.directory, "server-process.d.ts"),
    ),
    ...[
      { source: input.runtimeAsset.path, file: "assets/runtime/ycoding-runtime" },
      { source: input.pluginSDKAsset.path, file: "assets/plugin/sdk.mjs" },
    ].map(async ({ source, file }) => {
      await mkdir(path.dirname(path.join(input.directory, file)), { recursive: true })
      await copyFile(source, path.join(input.directory, file))
    }),
  ])
}

export async function buildUserAppPackage(
  input: LibraryInput & {
    readonly frontend: string
    readonly os: string
    readonly arch: string
    readonly packageDirectory: string
    readonly selection: {
      readonly requested?: string
      readonly targets: ReadonlyArray<{ readonly os: string; readonly arch: string }>
    }
  },
  compile = compileUserAppModule,
) {
  await buildUserAppLibrary(input, compile)
  const frontend = "frontend/" + path.basename(input.frontend)
  await mkdir(path.dirname(path.join(input.directory, frontend)))
  await copyFile(input.frontend, path.join(input.directory, frontend))
  await chmod(path.join(input.directory, frontend), 0o755)
  await writePacket(input.directory, {
    version: input.version,
    channel: input.channel,
    os: input.os,
    arch: input.arch,
    frontend,
    runtime: {
      file: "assets/runtime/ycoding-runtime",
      sha256: input.runtimeAsset.sha256,
      payloadSha256: input.runtimeAsset.payloadSha256,
    },
  })
  const selected = input.selection.targets[0]
  if (
    input.selection.requested === `${process.platform}-${process.arch}` &&
    input.selection.targets.length === 1 &&
    selected?.os === process.platform &&
    selected.arch === process.arch &&
    input.os === process.platform &&
    input.arch === process.arch
  ) {
    const shipped = path.join(input.packageDirectory, "lib")
    await mkdir(shipped)
    await Promise.all(
      (await readdir(input.directory)).map((name) =>
        cp(path.join(input.directory, name), path.join(shipped, name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        }),
      ),
    )
  }
}
