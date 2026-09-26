import { InstallationLocal, InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Effect, Option } from "effect"
import { Runtime } from "../../framework/runtime"
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
        return
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
    } catch (error) {
      process.exitCode = 1
      process.stderr.write(`ycoding update failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }),
)
