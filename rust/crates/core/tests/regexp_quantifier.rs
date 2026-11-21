use ycoding_core::regexp::{Budget, RegExp};

#[test]
fn required_zero_width_iterations_do_not_expand_unobservable_work() {
    for (pattern, input) in [
        ("(?:){10000}", ""),
        ("(a?){10000}", ""),
        ("(?=a){10000}", "a"),
    ] {
        assert!(
            RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "")
                .unwrap()
                .exec(
                    &input.encode_utf16().collect::<Vec<_>>(),
                    &mut Budget {
                        remaining: Some(100),
                        cancelled: None
                    }
                )
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn absent_budget_does_not_infer_a_native_extreme_count_threshold() {
    let mut regex = RegExp::new(
        &"(?:){1000000000000000}".encode_utf16().collect::<Vec<_>>(),
        "",
    )
    .unwrap();
    let matched = regex.exec(&[], &mut Budget::unlimited()).unwrap().unwrap();
    assert_eq!(matched.captures, vec![Some(Vec::new())]);
    assert_eq!(matched.index, 0);
}
