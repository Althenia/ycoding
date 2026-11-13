import { smokeUnavailable } from "../script/build-preflight"

export async function setupWindowSmoke() {
  throw new Error(smokeUnavailable)
}

if (import.meta.main) await setupWindowSmoke()
