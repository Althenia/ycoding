#[path = "../src/field_constraints.rs"]
mod field_constraints;
use field_constraints::{Constraints, validate_constraints};

#[test]
fn field_constraints_preserve_integer_and_text_units() {
    let integer = Constraints {
        integer_min: Some(-9007199254740991),
        integer_max: Some(9007199254740991),
        ..Default::default()
    };
    assert!(validate_constraints(&integer, Some(-9007199254740991), None, None).is_ok());
    assert!(validate_constraints(&integer, Some(9007199254740992), None, None).is_err());
    let uint64 = Constraints {
        integer_max: Some(u64::MAX as i128),
        ..Default::default()
    };
    assert!(validate_constraints(&uint64, Some(u64::MAX as i128), None, None).is_ok());
    let text = Constraints {
        utf16_max: Some(1),
        codepoints_max: Some(1),
        utf8_bytes_max: Some(3),
        ..Default::default()
    };
    assert!(validate_constraints(&text, None, Some(&[0xd800]), None).is_ok());
    assert!(validate_constraints(&text, None, Some(&[0xd83d, 0xde00]), None).is_err());
    let count = Constraints {
        count_min: Some(1),
        count_max: Some(2),
        ..Default::default()
    };
    assert!(validate_constraints(&count, None, None, Some(0)).is_err());
    assert!(validate_constraints(&count, None, None, Some(2)).is_ok());
}
