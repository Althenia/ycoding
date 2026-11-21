import { SchemaAST } from "effect"
import type { Schema } from "effect"
import type { Constraints } from "./constraints.js"

export function requireConstraintCoverage(schema: Schema.Top, source: string, constraints: Constraints | undefined) {
  const ast = SchemaAST.toType(schema.ast)
  if ((schema.ast.checks?.length || ast.checks?.length) && !constraints?.domainObligations?.includes(source))
    throw new Error(`uncovered source constraints: ${source}`)
  return { source, domainObligations: constraints?.domainObligations ?? [], enforced: false as const }
}
