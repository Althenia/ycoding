import { spawn } from "node:child_process"
import { Service } from "../../../../../packages/client/src/promise/service"
import { fixture } from "./launcher-client"

const [binary, command, ...args] = process.argv.slice(2)
if (!binary || !command) throw new Error("Usage: ready-runtime.ts <runtime-binary> <test-command> [args...]")
const runtime = await fixture(binary)
try {
  const endpoint = await Service.ensure({
    file: runtime.file,
    version: "ready-runtime-test",
    command: runtime.command("ready-runtime-test"),
    startupErrorFile: runtime.startupErrorFile,
  })
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      YCODING_V5_TEST_URL: endpoint.url,
      YCODING_V5_TEST_PASSWORD: endpoint.auth?.password,
      YCODING_V5_TEST_CONFIG_DIR: runtime.configDir,
    },
    timeout: 120_000,
  })
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
} finally {
  await runtime.dispose()
}
