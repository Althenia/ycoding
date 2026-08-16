/** @jsxImportSource @opentui/solid */
import {
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  type TuiPaths,
} from "../../src/context/runtime"
import type { ParentProps } from "solid-js"
import { LogProvider, type LogSink } from "../../src/context/log"

export function TestTuiContexts(
  props: ParentProps<{
    cwd?: string
    directory?: string
    paths?: Partial<TuiPaths>
    log?: LogSink
  }>,
) {
  return (
    <LogProvider log={props.log ?? (() => {})}>
      <TuiPathsProvider
        value={{
          cwd: props.cwd ?? props.directory ?? "/tmp/ycoding/packages/tui",
          home: "/tmp/ycoding/home",
          state: "/tmp/ycoding/state",
          worktree: "/tmp/ycoding",
          ...props.paths,
        }}
      >
        <TuiTerminalEnvironmentProvider value={{ platform: "linux" }}>
          <TuiStartupProvider value={{ skipInitialLoading: false }}>{props.children}</TuiStartupProvider>
        </TuiTerminalEnvironmentProvider>
      </TuiPathsProvider>
    </LogProvider>
  )
}
