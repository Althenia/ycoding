export type Constraints = {
  integerMin?: string
  integerMax?: string
  utf16Min?: number
  utf16Max?: number
  codepointsMin?: number
  codepointsMax?: number
  utf8BytesMin?: number
  utf8BytesMax?: number
  countMin?: number
  countMax?: number
  domainObligations?: readonly string[]
}

export function validateConstraints(rule: Constraints, integer?: bigint, text?: string, count?: number) {
  if (
    integer !== undefined &&
    ((rule.integerMin !== undefined && integer < BigInt(rule.integerMin)) ||
      (rule.integerMax !== undefined && integer > BigInt(rule.integerMax)))
  )
    throw new Error("integer constraint")
  const bounded = (value: number, min?: number, max?: number) =>
    (min !== undefined && value < min) || (max !== undefined && value > max)
  if (count !== undefined && bounded(count, rule.countMin, rule.countMax)) throw new Error("count constraint")
  if (text === undefined) return
  if (
    bounded(text.length, rule.utf16Min, rule.utf16Max) ||
    bounded(Array.from(text).length, rule.codepointsMin, rule.codepointsMax) ||
    bounded(new TextEncoder().encode(text).length, rule.utf8BytesMin, rule.utf8BytesMax)
  )
    throw new Error("text constraint")
}
