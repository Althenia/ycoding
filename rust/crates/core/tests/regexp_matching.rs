use ycoding_core::regexp::{Budget, Error, RegExp};

fn text(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[test]
fn surrogate_pairs_and_lone_units() {
    let input = text("😀");
    for (flags, size) in [("", 1), ("u", 2), ("v", 2)] {
        let matched = RegExp::new(&text("."), flags)
            .unwrap()
            .exec(&input, &mut Budget::unlimited())
            .unwrap()
            .unwrap();
        assert_eq!(matched.captures[0].as_ref().unwrap().len(), size);
    }
    assert!(
        RegExp::new(&[0xd800], "u")
            .unwrap()
            .exec(&[0xd800], &mut Budget::unlimited())
            .unwrap()
            .is_some()
    );
}

#[test]
fn captures_lookaround_and_backtracking() {
    for (pattern, input, expected) in [
        ("(?<=([ab]+)([bc]+))$", "abc", vec!["", "a", "bc"]),
        ("(a|ab)c", "abc", vec!["abc", "ab"]),
        (
            "^(a+)\\1*,\\1+$",
            "aaaaaaaaaa,aaaaaaaaaaaaaaa",
            vec!["aaaaaaaaaa,aaaaaaaaaaaaaaa", "aaaaa"],
        ),
        ("(?=(a+))a*b\\1", "baaabac", vec!["aba", "a"]),
    ] {
        let matched = RegExp::new(&text(pattern), "")
            .unwrap()
            .exec(&text(input), &mut Budget::unlimited())
            .unwrap()
            .unwrap();
        assert_eq!(
            matched.captures,
            expected
                .into_iter()
                .map(|s| Some(text(s)))
                .collect::<Vec<_>>(),
            "{pattern}"
        );
    }
}

#[test]
fn canonicalization_and_unicode_properties() {
    for (pattern, flags, input, expected) in [
        ("k", "i", "K", false),
        ("k", "iu", "K", true),
        ("s", "i", "ſ", false),
        ("s", "iv", "ſ", true),
        ("i", "iu", "ı", false),
        ("ß", "iu", "ẞ", true),
        ("\\p{Script=Han}", "u", "𠮷", true),
        ("\\P{Lowercase_Letter}", "iu", "a", true),
        ("\\P{Lowercase_Letter}", "iv", "a", false),
        ("[\\p{ASCII}&&[^A-Z]]", "v", "a", true),
        ("[\\p{ASCII}--[a-z]]", "v", "a", false),
        ("[\\q{ab|a}]", "v", "ab", true),
        ("\\p{Basic_Emoji}", "v", "🛤️", true),
    ] {
        assert_eq!(
            RegExp::new(&text(pattern), flags)
                .unwrap()
                .exec(&text(input), &mut Budget::unlimited())
                .unwrap()
                .is_some(),
            expected,
            "{pattern}/{flags} on {input}"
        );
    }
}

#[test]
fn sticky_global_and_match_indices() {
    let mut regex = RegExp::new(&text("(?<a>a)(b)?"), "dy").unwrap();
    assert!(
        regex
            .exec(&text("ba"), &mut Budget::unlimited())
            .unwrap()
            .is_none()
    );
    regex.last_index = 1;
    let matched = regex
        .exec(&text("ba"), &mut Budget::unlimited())
        .unwrap()
        .unwrap();
    assert_eq!(regex.last_index, 2);
    assert_eq!(
        matched.indices,
        Some(vec![Some((1, 2)), Some((1, 2)), None])
    );
    assert_eq!(matched.index_groups, Some(vec![(text("a"), Some((1, 2)))]));
    assert!(
        regex
            .exec(&text("ba"), &mut Budget::unlimited())
            .unwrap()
            .is_none()
    );
    assert_eq!(regex.last_index, 0);
}

#[test]
fn work_limit_and_cancellation_are_inside_backtracking() {
    let mut regex = RegExp::new(&text("(a+)+$"), "").unwrap();
    assert_eq!(
        regex.exec(
            &text("aaaaaaaaaaaaaaaaaaaaaaaa!"),
            &mut Budget {
                remaining: Some(100),
                cancelled: None
            }
        ),
        Err(Error::StepLimit)
    );
    assert_eq!(
        regex.exec(
            &text("aaaa"),
            &mut Budget {
                remaining: None,
                cancelled: Some(&|| true)
            }
        ),
        Err(Error::Cancelled)
    );
}
