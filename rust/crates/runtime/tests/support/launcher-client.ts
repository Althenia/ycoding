import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { Service } from "../../../../../packages/client/src/promise/service"

export async function fixture(binary: string) {
  const root = await mkdtemp(join(tmpdir(), "ycoding-ready-runtime-"))
  await mkdir(join(root, "home"))
  const configDir = join(root, "watched-config")
  await mkdir(configDir, { mode: 0o700 })
  const excluded = [
    "YCODING_DB",
    "YCODING_SQLITE_IMPORT_SOURCE",
    "YCODING_DISABLE_CHANNEL_DB",
    "YCODING_CONFIG",
    "YCODING_CONFIG_CONTENT",
    "YCODING_PASSWORD",
    "YCODING_SERVER_PASSWORD",
    "YCODING_TEST_HOME",
    "YCODING_MODELS_PATH",
    "YCODING_MODELS_URL",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
  ]
  const environment = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      TMPDIR: join(root, "tmp"),
      YCODING_CONFIG_DIR: configDir,
      YCODING_CHANNEL: "beta",
      YCODING_CONFIG_PROJECT_DISABLE: "true",
      YCODING_DISABLE_MODELS_FETCH: "true",
    }).filter(([key]) => !excluded.includes(key) && key !== "YCODING_SERVICE_STARTUP_ERROR_FILE"),
  )
  const resolved = spawnSync(binary, ["--paths"], { env: environment, encoding: "utf8", timeout: 30_000 })
  if (resolved.status !== 0) throw new Error(`Runtime path resolution failed: ${resolved.stderr}`)
  const paths = JSON.parse(resolved.stdout) as { state: string; serviceFilename: string }
  const file = join(paths.state, paths.serviceFilename)
  return {
    file,
    configDir,
    startupErrorFile: file + ".startup-error",
    command(version: string) {
      return [
        "/usr/bin/env",
        ...excluded.flatMap((key) => ["-u", key]),
        ...Object.entries(environment)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${value}`),
        `YCODING_VERSION=${version}`,
        binary,
        "serve",
        "--service",
        "--port",
        "0",
      ]
    },
    async registration() {
      return JSON.parse(await readFile(file, "utf8")) as {
        id: string
        pid: number
        url: string
        version: string
        password: string
      }
    },
    async dispose() {
      await Service.stop({ file })
      await rm(root, { recursive: true, force: true })
    },
  }
}
