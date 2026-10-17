import { For, Show } from "solid-js"
import { Icon } from "../../ui/icon"
import { gradeLabel, type DecisionProvenanceView, type GradeView, type GuardrailDecisionView } from "../decision-grades"

export function DecisionGrades(props: { readonly grades: readonly GradeView[]; readonly selected?: string }) {
  return <ul class="decision-grades" aria-label="Choice grades">
    <For each={props.grades}>{(grade) => <li data-selected={grade.choice === props.selected ? "true" : undefined}>
      <strong class="decision-grades__choice">{gradeLabel(grade.choice)}</strong>
      <span class="decision-grades__meta">confidence {String(grade.confidence)}<Show when={grade.choice === props.selected}> · Selected</Show></span>
      <p>{grade.evidence}</p>
    </li>}</For>
  </ul>
}

export function DecisionProvenance(props: { readonly provenance: DecisionProvenanceView }) {
  return <Show when={props.provenance.grades?.length} fallback={<Show when={props.provenance.choice !== undefined || props.provenance.confidence !== undefined}>
    <p class="request__note">model choice {props.provenance.choice ?? "unreported"} · confidence {props.provenance.confidence === undefined ? "unreported" : String(props.provenance.confidence)}</p>
  </Show>}><DecisionGrades grades={props.provenance.grades ?? []} selected={props.provenance.choice} /></Show>
}

export function GuardrailDecisionRows(props: { readonly decisions: readonly GuardrailDecisionView[] }) {
  return <Show when={props.decisions.length}><section class="guardrail-decisions" aria-label="Guardrail decisions">
    <For each={props.decisions.map((item) => item.requestID)}>{(id) => {
      const item = () => props.decisions.find((entry) => entry.requestID === id)!
      return <article data-guardrail-request={id}><details class="transcript-notice">
        <summary><Icon name="chevron-right" size={16} /><strong>Guardrail</strong><span class="transcript-notice__status">{item().reply === "reject" ? "rejected" : item().reply === "always" ? "approved always" : "approved once"}</span></summary>
        <p class="request__note">Request <code>{id}</code><Show when={item().ruleIDs?.length}> · Rules: {item().ruleIDs?.join(", ")}</Show></p>
        <DecisionProvenance provenance={item()} />
      </details></article>
    }}</For>
  </section></Show>
}
