import path from "node:path"
import { interactionApplication, interactionCLIIdentifier, interactionSigningRequirement, interactionSigningSHA1 } from "../src/update/interaction-layout"
import { buildInteractionMacOS } from "./build-interaction-macos"

export async function packageMacOSInteraction(executable: string, arch: "arm64" | "x64") {
  if (process.platform !== "darwin") throw new Error("A macOS signing host is required")
  await buildInteractionMacOS(path.resolve(path.dirname(executable), interactionApplication.name), interactionSigningSHA1, arch)
  const sign = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", interactionSigningSHA1,
    "--identifier", interactionCLIIdentifier, "--timestamp=none", executable], { stderr: "inherit" })
  if (!sign.success) throw new Error("Could not sign the CLI with the release identity")
  verifyMacOSInteractionPackage(executable)
}

export function verifyMacOSInteractionPackage(executable: string) {
  verifyMacOSInteractionSignature(executable, "cli")
  verifyMacOSInteractionSignature(path.join(path.dirname(executable), interactionApplication.name), "helper")
}

export function verifyMacOSInteractionSignature(target: string, component: "cli" | "helper") {
  const identifier = component === "cli" ? interactionCLIIdentifier : interactionApplication.identifier
  const options = component === "cli" ? [] : ["--deep"]
  const result = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", ...options, "-R",
    interactionSigningRequirement(identifier), target], { stderr: "inherit" })
  if (!result.success) throw new Error(`${identifier} signature does not match the release identity`)
}
