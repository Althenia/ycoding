export * as ServerProcess from "./server-process.js"
import type { V5Client, V5Options } from "@ycoding-ai/client/v5"
import type { Effect } from "effect"

export type Mode = "default" | "service" | "stdio"
export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
}
export type UserAppSelection = { mode: "managed" } | { mode: "external"; url: string } | { mode: "private" }
export type UserAppOptions = { location: NonNullable<V5Options["location"]>; signal?: AbortSignal }
export type UserApp = { readonly api: Omit<V5Client, "transport">; close(): Promise<void> }
export declare const run: (options: Options) => Effect.Effect<void, unknown>
export declare function openUserApp(selection: UserAppSelection, options: UserAppOptions): Promise<UserApp>
