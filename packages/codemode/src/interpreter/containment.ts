import { Effect } from "effect"
import type { ResolvedExecutionLimits } from "../codemode.js"
import { type AstNode, InterpreterRuntimeError } from "./model.js"
import { RegexRuntime } from "./regex-runtime.js"

export class Containment {
  steps = 0
  fatal: InterpreterRuntimeError | undefined
  readonly regex: RegexRuntime

  constructor(readonly limits: ResolvedExecutionLimits) {
    this.regex = new RegexRuntime(limits.regexTimeoutMs, (error) => {
      this.fatal ??= error
    })
  }

  step(node: AstNode): void {
    this.check()
    this.steps += 1
    if (this.limits.maxSteps !== undefined && this.steps > this.limits.maxSteps) {
      this.fatal = new InterpreterRuntimeError(
        `Execution exceeded ${this.limits.maxSteps} evaluator steps.`,
        node,
        "StepLimitExceeded",
      )
      throw this.fatal
    }
  }

  check(): void {
    if (this.fatal) throw this.fatal
  }

  close(): Effect.Effect<void> {
    return this.regex.close()
  }
}
