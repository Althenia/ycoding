use ycoding_core::regexp::RegExp;

#[test]
fn flag_early_errors_and_canonical_order() {
    for flags in ["gg", "uv", "z", "dii", "G"] {
        assert!(RegExp::new(&[97], flags).is_err(), "{flags}");
    }
    assert_eq!(
        RegExp::new(&[97], "yusmig d".replace(' ', "").as_str())
            .unwrap()
            .flags(),
        "dgimsuy"
    );
}

#[test]
fn syntax_early_errors_by_mode() {
    for pattern in ["(", "[", "a{2,1}", "*", "(?q)", "(?<x>a)(?<x>b)"] {
        assert!(
            RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "").is_err(),
            "{pattern}"
        );
    }
    for pattern in ["\\q", "\\1", "a{", "[\\d-a]", "]", "(?=a)*"] {
        assert!(
            RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "u").is_err(),
            "{pattern}"
        );
    }
    for pattern in ["\\q", "\\1", "a{", "[\\d-a]", "]", "(?=a)*"] {
        assert!(
            RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "").is_ok(),
            "{pattern}"
        );
    }
}
