import { Show, type JSX } from "solid-js"

export const usageSections = ["spend", "generation", "quotas", "charts", "trends", "speed", "consumption", "breakdown", "incidents"] as const
export type UsageSection = (typeof usageSections)[number]

export function usageSectionNumbers(omitted: readonly UsageSection[]): Readonly<Record<UsageSection, number>> {
  let next = 0
  return Object.fromEntries(usageSections.map((section) => [section, omitted.includes(section) ? 0 : ++next])) as Record<UsageSection, number>
}

export function sectionOrdinalLabel(number: number) {
  return `§${String(number).padStart(2, "0")}`
}

export function UsageHeading(props: { readonly level: 2 | 3; readonly id?: string; readonly ordinal?: number | undefined; readonly children: JSX.Element }) {
  const heading = () => props.level === 2 ? <h2 id={props.id}>{props.children}</h2> : <h3 id={props.id}>{props.children}</h3>
  return <Show when={props.ordinal} fallback={heading()}>{(number) => <div class="usage-title"><span class="usage-ordinal" aria-hidden="true">{sectionOrdinalLabel(number())}</span>{heading()}</div>}</Show>
}
