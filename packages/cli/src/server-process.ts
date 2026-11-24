export * as ServerProcess from "./server-process"

import { NativeProcess } from "./native-process"

export { openUserApp } from "./user-app"
export type { UserApp, UserAppOptions, UserAppSelection } from "./user-app"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
}

export const run = (options: Options) => NativeProcess.run(options)
