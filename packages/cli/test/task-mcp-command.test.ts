import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const flags = (overrides: Record<string, string>) =>
  Object.entries({
    directory: "/",
    "workspace-root": "/tmp/ycoding-task-mcp-command",
    issuer: "https://identity.example.test",
    "jwks-url": "https://identity.example.test/keys",
    resource: "https://tasks.example.test/mcp",
    subject: "owner",
    ...overrides,
  }).flatMap(([name, value]) => [`--${name}`, value])

test.each([
  [{ resource: "https://tasks.example.test/other" }, "MCP resource URL must end in /mcp"],
  [{ issuer: "http://identity.example.test" }, "Invalid task MCP OAuth configuration"],
  [{ subject: "two words" }, "Invalid task MCP OAuth configuration"],
  [{ port: "70000" }, "Invalid MCP port"],
])(
  "mcp serve rejects %p before claiming a registry or starting the runtime",
  async (overrides, message) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-task-mcp-command-"))
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          `--tsconfig-override=${path.resolve(import.meta.dirname, "../tsconfig.json")}`,
          path.resolve(import.meta.dirname, "../src/index.ts"),
          "mcp",
          "serve",
          ...flags(overrides),
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: root,
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
            YCODING_CONFIG_DIR: path.join(root, "config/ycoding"),
            YCODING_RUNTIME_EXECUTABLE: path.join(root, "missing-runtime"),
          },
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode).not.toBe(0)
      expect(stdout + stderr).toContain(message)
      expect(await readdir(root)).not.toContain("state")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
