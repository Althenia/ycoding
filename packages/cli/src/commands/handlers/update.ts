import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/promise"
import { InstallationLocal, InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Effect, Option, Result } from "effect"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { ServiceConfig } from "../../services/service-config"
import { UpdateCommand } from "../update"

export default Runtime.handler(UpdateCommand, (input) =>
  Effect.promise(async () => {
    try {
      if (InstallationLocal) throw new Error("Self-update is unavailable for local development builds")
      const { installRelease, latestRelease, validVersion } = await import("../../update/update")
      const { UpdateProgress } = await import("../../update/progress")
      const requested = Option.getOrUndefined(input.version)
      if (requested && !validVersion(requested)) throw new Error(`Invalid YCoding version: ${requested}`)
      const version = requested ?? (await latestRelease())
      if (version === InstallationVersion) {
        process.stdout.write(`ycoding ${InstallationVersion} is already up to date\n`)
        return undefined
      }
      process.stdout.write(`Updating ycoding from ${InstallationVersion} to ${version}...\n`)
      const progress = UpdateProgress.terminal({
        write: (text) => process.stdout.write(text),
        interactive: process.stdout.isTTY,
        width: 30,
      })
      await installRelease({
        version,
        executable: process.execPath,
        platform: process.platform,
        arch: process.arch,
        onProgress: progress.report,
      }).finally(progress.end)
      process.stdout.write(`Updated ycoding to ${version}\n`)
      return version
    } catch (error) {
      process.exitCode = 1
      process.stderr.write(`ycoding update failed: ${message(error)}\n`)
      return undefined
    }
  }).pipe(Effect.flatMap((installed) => (installed === undefined ? Effect.void : restartServer(installed, input.force)))),
)

const restartCommand = "`ycoding service restart`"

function restartServer(installed: string, force: boolean) {
  return Effect.gen(function* () {
    const options = yield* ServiceConfig.options()
    const endpoint = yield* Service.discover({ ...options, version: undefined })
    if (endpoint === undefined) {
      process.stdout.write("No background server is running; nothing to restart\n")
      return
    }
    const outstanding = yield* Effect.tryPromise({
      try: () =>
        YCoding.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }).session.outstanding(undefined, {
          signal: AbortSignal.timeout(5_000),
        }),
      catch: (cause) => cause,
    }).pipe(Effect.result)
    if (Result.isFailure(outstanding) && !force) {
      process.stderr.write(
        `Could not check the background server for running work (${message(outstanding.failure)}), so it was not restarted. Run ${restartCommand} to apply the update.\n`,
      )
      return
    }
    if (Result.isFailure(outstanding))
      process.stderr.write(
        `Could not check the background server for running work (${message(outstanding.failure)}); restarting it anyway because --force was given.\n`,
      )
    const running = Result.isSuccess(outstanding) ? outstanding.success.running.length : 0
    if (running > 0 && !force) {
      process.stdout.write(
        `${running} ${running === 1 ? "Session has" : "Sessions have"} running work, so the background server was not restarted. Run ${restartCommand} to apply the update once they finish.\n`,
      )
      return
    }
    if (running > 0)
      process.stdout.write(
        `Interrupting ${running} running ${running === 1 ? "Session" : "Sessions"} to restart the background server...\n`,
      )
    else process.stdout.write("Restarting the background server...\n")
    yield* ServerConnection.managedService(options).restart()
    process.stdout.write("Restarted the background server\n")
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.exitCode = 1
        process.stderr.write(
          `ycoding ${installed} is installed, but the background server could not be restarted: ${message(error)}\nRun ${restartCommand} to apply the update.\n`,
        )
      }),
    ),
  )
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
