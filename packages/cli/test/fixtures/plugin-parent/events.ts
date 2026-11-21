export function selectEvent(
  evidence: readonly Record<string, unknown>[],
  kind: string,
  matches: (item: Record<string, unknown>) => boolean = () => true,
  from = 0,
) {
  return evidence.slice(from).find((item) => item.kind === kind && matches(item))
}
