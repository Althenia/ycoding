import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { v5Server } from "./fixture/v5-server"

test.each([
  {
    scope: "project",
    args: ["--url", "https://mcp.example.test/rpc", "--header", "X-Fixture=fixture"],
    config: { type: "remote", url: "https://mcp.example.test/rpc", headers: { "X-Fixture": "fixture" } },
  },
  {
    scope: "global",
    args: ["--global", "--env", "FIXTURE=value", "--", "fixture-mcp", "--fixture"],
    config: { type: "local", command: ["fixture-mcp", "--fixture"], environment: { FIXTURE: "value" } },
  },
])(
  "mcp add delegates $scope configuration and reports the backend-selected target",
  async ({ scope, args, config }) => {
    const result = await runMcp(args, {
      data: { name: "fixture", target: { scope, path: "/backend/selected/ycoding.jsonc" }, reloaded: true },
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.requests).toEqual([
      { query: { location: { directory: result.directory } }, payload: { name: "fixture", scope, config } },
    ])
    expect(result.stdout).toContain("/backend/selected/ycoding.jsonc")
    expect(result.localConfig).toBe('{"fixture":"unchanged"}')
  },
)

test("mcp add reports backend rejection without locally writing or claiming success", async () => {
  const result = await runMcp(["--url", "https://mcp.example.test/rpc"], new Error("reject"))
  expect(result.exitCode).not.toBe(0)
  expect(result.requests).toHaveLength(1)
  expect(result.stdout).not.toContain("added to")
  expect(result.localConfig).toBe('{"fixture":"unchanged"}')
})

test.each([
  { args: [], message: "Provide either --url" },
  { args: ["--url", "not a URL"], message: "Invalid URL" },
  { args: ["--url", "https://mcp.example.test", "--", "fixture"], message: "not both" },
  { args: ["--url", "https://mcp.example.test", "--env", "FIXTURE=value"], message: "--env is only valid" },
  { args: ["--header", "X-Fixture=fixture", "--", "fixture"], message: "--header is only valid" },
])("mcp add rejects invalid operands before backend configuration: $message", async ({ args, message }) => {
  const result = await runMcp(args, new Error("unexpected configuration"))
  expect(result.exitCode).not.toBe(0)
  expect(result.stdout + result.stderr).toContain(message)
  expect(result.requests).toEqual([])
  expect(result.localConfig).toBe('{"fixture":"unchanged"}')
})

async function runMcp(args: readonly string[], configured: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-config-cli-"))
  const directory = path.join(root, "project")
  const requests: unknown[] = []
  await mkdir(directory)
  await mkdir(path.join(root, "state/ycoding"), { recursive: true })
  await writeFile(path.join(directory, "ycoding.json"), '{"fixture":"unchanged"}')
  const owner = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
  const server = v5Server((name, input) => {
    if (name === "health.get")
      return { data: { healthy: true, version: "local", pid: owner.pid, sourceEpoch: "source_fixture" } }
    if (name === "mcp.configure") {
      requests.push(input)
      return configured
    }
    throw new Error(name)
  })
  await writeFile(
    path.join(root, "state/ycoding/service-local.json"),
    JSON.stringify({ id: "service_fixture", version: "local", url: server.url, pid: owner.pid }),
  )
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        `--tsconfig-override=${path.resolve(import.meta.dirname, "../tsconfig.json")}`,
        path.resolve(import.meta.dirname, "../src/index.ts"),
        "mcp",
        "add",
        "fixture",
        ...args,
      ],
      {
        cwd: directory,
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
          YCODING_VERSION: "local",
        },
      },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return {
        exitCode,
        stdout,
        stderr,
        requests,
        directory: await realpath(directory),
        localConfig: await readFile(path.join(directory, "ycoding.json"), "utf8"),
      }
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await server.close()
    await owner.stdin.end()
    await owner.exited
    await rm(root, { recursive: true, force: true })
  }
}
