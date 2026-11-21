use ycoding_schema::{DomainDecode, DomainEncode, browser, parse_json};

#[test]
fn history_input_preserves_optional_search_bounds_and_rejects_out_of_range_limits() {
    for text in [
        r#"{"sessionID":"ses_fixture","generation":1,"callID":"call_fixture"}"#,
        r#"{"sessionID":"ses_fixture","generation":1,"callID":"call_fixture","query":"","limit":1,"startTime":0,"endTime":0}"#,
        r#"{"sessionID":"ses_fixture","generation":1,"callID":"call_fixture","limit":100}"#,
    ] {
        let value = parse_json(text).unwrap();
        assert_eq!(
            browser::HistoryInput::decode(&value).unwrap().encode(),
            value
        );
    }
    for fields in [
        r#""limit":0"#,
        r#""limit":101"#,
        r#""startTime":-1"#,
        r#""query":null"#,
    ] {
        let text = format!(
            r#"{{"sessionID":"ses_fixture","generation":1,"callID":"call_fixture",{fields}}}"#
        );
        assert!(browser::HistoryInput::decode(&parse_json(&text).unwrap()).is_err());
    }
}

#[test]
fn history_results_bound_entry_count_and_utf8_urls_while_preserving_optional_visit_counts() {
    for entry in [
        r#"{"url":"https://example.test/","title":"Fixture","lastVisitTime":0}"#.to_owned(),
        r#"{"url":"https://example.test/","title":"Fixture","lastVisitTime":0,"visitCount":0}"#
            .to_owned(),
        format!(
            r#"{{"url":"{}","title":"Fixture","lastVisitTime":0}}"#,
            "é".repeat(1024)
        ),
    ] {
        let value = parse_json(&entry).unwrap();
        assert_eq!(
            browser::HistoryEntry::decode(&value).unwrap().encode(),
            value
        );
    }
    let long = format!(
        r#"{{"url":"{}","title":"Fixture","lastVisitTime":0}}"#,
        "é".repeat(1025)
    );
    assert!(browser::HistoryEntry::decode(&parse_json(&long).unwrap()).is_err());
    for count in [0, 100, 101] {
        let entry = r#"{"url":"https://example.test/","title":"Fixture","lastVisitTime":0}"#;
        let value = parse_json(&format!(
            r#"{{"entries":[{}]}}"#,
            vec![entry; count].join(",")
        ))
        .unwrap();
        let result = browser::HistoryResult::decode(&value);
        if count <= 100 {
            assert_eq!(result.unwrap().encode(), value);
        } else {
            assert!(result.is_err());
        }
    }
}
