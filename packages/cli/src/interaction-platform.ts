import { stat } from "node:fs/promises"
import path from "node:path"
import { macOSInteractionApplication, macOSInteractionExecutable } from "@ycoding-ai/core/interaction/macos"
import type { InteractionPlatforms } from "@ycoding-ai/server/interaction-platform"
import { BUN_BINARY, NODE_BINARY } from "./binary"
import { interactionSigningSHA1 } from "./update/interaction-layout"

export async function packagedInteractionPlatforms(platform: NodeJS.Platform, executable: string): Promise<InteractionPlatforms | undefined> {
  if (platform !== "darwin" || !path.isAbsolute(executable) || ![BUN_BINARY, NODE_BINARY].includes(path.basename(executable))) return undefined
  const application = path.join(path.dirname(executable), macOSInteractionApplication)
  const info = await stat(path.join(application, "Contents", "MacOS", macOSInteractionExecutable)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") return undefined
    throw error
  })
  if (!info?.isFile() || (info.mode & 0o111) === 0) return undefined
  return { macOS: { application, certificateSHA1: interactionSigningSHA1 } }
}
