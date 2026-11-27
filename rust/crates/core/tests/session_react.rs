use ycoding_ai::llm::FinishReason;
use ycoding_core::session::runner::react::{Basis, Decision, Observation, Verdict, evaluate};

fn verdict(decision: Decision, basis: Basis) -> Verdict {
    Verdict { decision, basis }
}

fn observation(
    finish: Option<FinishReason>,
    text: bool,
    tools: bool,
    recovering: bool,
) -> Observation {
    Observation {
        finish,
        assistant_text: text,
        continuation: tools,
        recovering,
    }
}

#[test]
fn tool_results_continue_the_loop_even_when_the_step_was_silent() {
    for recovered in [false, true] {
        for text in [false, true] {
            assert_eq!(
                evaluate(
                    &observation(Some(FinishReason::ToolCalls), text, true, false),
                    recovered
                ),
                verdict(Decision::Continue, Basis::ToolResults)
            );
        }
    }
    assert_eq!(
        evaluate(&observation(None, false, true, true), false),
        verdict(Decision::Continue, Basis::ToolResults)
    );
}

#[test]
fn a_silent_settled_step_recovers_once_then_completes() {
    let silent = observation(Some(FinishReason::Stop), false, false, false);
    assert_eq!(
        evaluate(&silent, false),
        verdict(Decision::Recover, Basis::Silent)
    );
    assert_eq!(
        evaluate(&silent, true),
        verdict(Decision::Complete, Basis::Silent)
    );
}

#[test]
fn an_answered_or_truncated_step_completes() {
    assert_eq!(
        evaluate(
            &observation(Some(FinishReason::Stop), true, false, false),
            false
        ),
        verdict(Decision::Complete, Basis::Answered)
    );
    assert_eq!(
        evaluate(
            &observation(Some(FinishReason::Length), false, false, false),
            false
        ),
        verdict(Decision::Complete, Basis::Truncated)
    );
}

#[test]
fn an_unsettled_step_recovers_unless_it_already_was_a_recovery() {
    assert_eq!(
        evaluate(&observation(None, false, false, false), false),
        verdict(Decision::Recover, Basis::Unsettled)
    );
    assert_eq!(
        evaluate(&observation(None, false, false, true), false),
        verdict(Decision::Complete, Basis::Unsettled)
    );
    assert_eq!(
        evaluate(&observation(None, false, false, false), true),
        verdict(Decision::Complete, Basis::Unsettled)
    );
}
