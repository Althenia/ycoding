use ycoding_core::regexp::{Error, RegExp};

#[test]
fn unavailable_string_properties_are_typed_not_fabricated() {
    for name in [
        "Emoji_Keycap_Sequence",
        "RGI_Emoji_Modifier_Sequence",
        "RGI_Emoji_Flag_Sequence",
        "RGI_Emoji_Tag_Sequence",
        "RGI_Emoji_ZWJ_Sequence",
        "RGI_Emoji",
    ] {
        let pattern = format!("\\p{{{name}}}").encode_utf16().collect::<Vec<_>>();
        assert_eq!(
            RegExp::new(&pattern, "v").unwrap_err(),
            Error::UnsupportedStringProperty(name.into())
        );
        assert!(matches!(RegExp::new(&pattern, "u"), Err(Error::Syntax(_))));
    }
}
