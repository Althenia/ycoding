import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("native packaged MCP resource reads preserve authored HTML and original PNG bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-mcp-resource-"))
  const fixture = path.resolve(import.meta.dir, "../test/fixture/mcp-artifact-resource.ts")
  const executable = path.join(directory, process.platform === "win32" ? "resource.exe" : "resource")
  try {
    const build = await Bun.build({
      entrypoints: [fixture],
      format: "esm",
      minify: true,
      sourcemap: "inline",
      splitting: true,
      bytecode: true,
      compile: {
        outfile: executable,
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: true,
        autoloadPackageJson: true,
      },
    })
    expect(build.success).toBe(true)
    const expected = {
      html: {
        uri: "ui://ycoding/artifact-demo/v1.html",
        mime: "text/html;profile=mcp-app",
        sha256: createHash("sha256")
          .update(await Bun.file(path.resolve(import.meta.dir, "../script/mcp-artifact-demo/index.html")).bytes())
          .digest("hex"),
        startsWithDoctype: true,
        metadata: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } },
      },
      png: {
        mime: "image/png",
        size: 79,
        sha256: "d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5",
      },
      unknownCode: -32602,
      expiredCode: -32602,
      htmlAfterExpiryUnchanged: true,
      listedAfterExpiry: ["ui://ycoding/artifact-demo/v1.html"],
    }
    for (const command of [[process.execPath, fixture], [executable]]) {
      const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
      const [status, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(status, error).toBe(0)
      expect(JSON.parse(output)).toEqual(expected)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)
