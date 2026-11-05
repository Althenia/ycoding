import { runDesktopWorker } from "@ycoding-ai/desktop/worker"
import { Effect } from "effect"
import { DesktopClientCommand } from "../desktop-client"
import { Runtime } from "../../framework/runtime"

export default Runtime.handler(DesktopClientCommand, (input) => Effect.tryPromise(() => runDesktopWorker(input)))
