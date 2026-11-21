use ycoding_ai::llm;
use ycoding_core::session::{command, model_switch};
use ycoding_schema::{DomainDecode, LosslessString, model, parse_json};

#[test]
fn command_arguments_preserve_positions_quotes_images_and_raw_arguments() {
    for (template, input, expected) in [
        (
            "Review $1 and $2",
            "one two three",
            "Review one and two three",
        ),
        (
            "$1 / $3",
            "\"one two\" ignored 'three four' rest",
            "one two / three four rest",
        ),
        (
            "Review $ARGUMENTS",
            "'one two' three",
            "Review 'one two' three",
        ),
        ("Review", "one two", "Review\n\none two"),
        (" $2 ", "one", ""),
        ("$1 / $2", "[Image 1] rest", "[Image 1] / rest"),
        ("  Review  ", "", "Review"),
    ] {
        assert_eq!(
            command::arguments(&template.into(), &input.into()),
            LosslessString::from(expected)
        );
    }
    assert_eq!(
        command::arguments(
            &"$ARGUMENTS".into(),
            &LosslessString::from_utf16(vec![0xd800])
        ),
        LosslessString::from_utf16(vec![0xd800])
    );
}

#[test]
fn model_switch_fit_boundary_excludes_output_reservation_and_preserves_blocked_metrics() {
    let current =
        model::Ref::decode(&parse_json(r#"{"providerID":"p","id":"large"}"#).unwrap()).unwrap();
    let target =
        model::Ref::decode(&parse_json(r#"{"providerID":"p","id":"small"}"#).unwrap()).unwrap();
    let messages = vec![llm::Message::user("context")];
    let size = model_switch::estimate(&messages);
    assert_eq!(
        model_switch::decide(Some(&current), &target, &messages, size),
        model_switch::Outcome::Switched
    );
    let model_switch::Outcome::Blocked(blocked) =
        model_switch::decide(Some(&current), &target, &messages, size - 1)
    else {
        panic!("must block outside the budget")
    };
    assert_eq!(blocked.required_reduction_tokens.get(), 1);
    assert_eq!(blocked.current_context_tokens.get(), size);
    assert_eq!(blocked.current_model, current);
    assert_eq!(blocked.target_model, target);
    assert_eq!(
        model_switch::decide(None, &target, &messages, 1),
        model_switch::Outcome::Switched
    );
}
