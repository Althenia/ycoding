import { runInteractiveDeferredMode, type RunDeferredInput } from "./runtime"
import type { RunClient } from "./types"

export type MiniFrontendInput<Client extends RunClient = RunClient> = RunDeferredInput<Client>
export type MiniFrontendResult = {
  exitCode: number
}

export async function runMiniFrontend<Client extends RunClient>(
  input: MiniFrontendInput<Client>,
): Promise<MiniFrontendResult> {
  await runInteractiveDeferredMode(input)
  return { exitCode: 0 }
}
