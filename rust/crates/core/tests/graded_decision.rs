use ycoding_core::resources::decision::{self, judgment::Request};
use ycoding_schema::{JsonValue, parse_json, stringify_json};

fn graded_request(grade: &str) -> Request {
    Request::decode(
        &parse_json(&format!(
            r#"{{"state":null,"questions":[{{"type":"choice","name":"grade","instructions":"Grade each alternative"{grade},"choices":[{{"value":false}},{{"value":"false"}}]}}]}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

fn graded() -> Request {
    graded_request(r#","grade":true"#)
}

fn grades() -> &'static str {
    r#"[{"choice":false,"confidence":0,"evidence":"Unsupported"},{"choice":"false","confidence":1,"evidence":"Supported"}]"#
}

fn answer(fields: &str) -> String {
    format!(
        r#"{{"name":"grade","type":"choice","answer":null,"choice":null,"score":null,"confidence":0{fields}}}"#
    )
}

fn wire(answer: &str) -> String {
    stringify_json(
        &parse_json(&format!(
            r#"{{"decisions":{{"version":1,"answers":[{answer}]}}}}"#
        ))
        .unwrap(),
    )
}

fn valid() -> String {
    answer(&format!(r#","grades":{}"#, grades()))
}

#[test]
fn a_graded_choice_returns_exactly_one_typed_grade_per_listed_choice_and_no_pick() {
    let request = graded();
    let parsed = request.parse(&wire(&valid())).unwrap();
    assert_eq!(
        stringify_json(&JsonValue::Array(parsed)),
        stringify_json(&parse_json(&format!("[{}]", valid())).unwrap())
    );
    assert!(request.parse(&request.template()).is_ok());
}

#[test]
fn grades_accept_the_exact_confidence_and_evidence_bounds() {
    let request = graded();
    let evidence = "e".repeat(500);
    let boundary = format!(
        r#","grades":[{{"choice":false,"confidence":0,"evidence":"{evidence}"}},{{"choice":"false","confidence":1,"evidence":"\u00a0x\u00a0"}}]"#
    );
    assert!(request.parse(&wire(&answer(&boundary))).is_ok());
}

#[test]
fn a_graded_choice_rejects_picks_missing_duplicate_extra_or_unlisted_grades() {
    let request = graded();
    let first = r#"{"choice":false,"confidence":0,"evidence":"Unsupported"}"#;
    let second = r#"{"choice":"false","confidence":1,"evidence":"Supported"}"#;
    let extra = r#"{"choice":"extra","confidence":0.9,"evidence":"Extra"}"#;
    for invalid in [
        valid().replace(r#""choice":null"#, r#""choice":false"#),
        valid().replace(r#""answer":null"#, r#""answer":true"#),
        valid().replace(r#""score":null"#, r#""score":0"#),
        valid().replace(r#""confidence":0,"grades""#, r#""confidence":0.8,"grades""#),
        answer(""),
        answer(&format!(r#","grades":[{second}]"#)),
        answer(&format!(r#","grades":[{first},{first}]"#)),
        answer(&format!(r#","grades":[{first},{second},{extra}]"#)),
        answer(&format!(r#","grades":[{first},{extra}]"#)),
        answer(r#","grades":[]"#),
        answer(&format!(
            r#","grades":[{{"choice":0,"confidence":0,"evidence":"Wrong type"}},{second}]"#
        )),
        answer(&format!(
            r#","grades":[{{"choice":"False","confidence":0,"evidence":"Wrong case"}},{second}]"#
        )),
    ] {
        assert_eq!(
            request.parse(&wire(&invalid)),
            Err(decision::Error::InvalidOutput),
            "{invalid}"
        );
    }
}

#[test]
fn grades_reject_out_of_range_confidence_and_blank_or_oversized_evidence() {
    let request = graded();
    let second = r#"{"choice":"false","confidence":1,"evidence":"Supported"}"#;
    let long = "e".repeat(501);
    let units = "😀".repeat(251);
    let mut invalid = ["-0.01", "1.01", "2"]
        .iter()
        .map(|confidence| {
            format!(r#"{{"choice":false,"confidence":{confidence},"evidence":"Unsupported"}}"#)
        })
        .collect::<Vec<_>>();
    invalid.extend(
        [
            "",
            " ",
            "\\t\\n",
            "\\u00a0\\u2003",
            long.as_str(),
            units.as_str(),
        ]
        .iter()
        .map(|evidence| format!(r#"{{"choice":false,"confidence":0,"evidence":"{evidence}"}}"#)),
    );
    invalid.push(r#"{"choice":false,"confidence":"0.5","evidence":"Text confidence"}"#.into());
    invalid.push(r#"{"choice":false,"confidence":0,"evidence":"Extra field","note":"x"}"#.into());
    invalid.push(r#"{"choice":false,"confidence":0}"#.into());
    for first in invalid {
        let document = answer(&format!(r#","grades":[{first},{second}]"#));
        assert_eq!(
            request.parse(&wire(&document)),
            Err(decision::Error::InvalidOutput),
            "{first}"
        );
    }
    let text = wire(&valid()).replace(
        r#""confidence":0,"evidence":"Unsupported""#,
        r#""confidence":NaN,"evidence":"Unsupported""#,
    );
    assert_eq!(request.parse(&text), Err(decision::Error::InvalidOutput));
}

#[test]
fn a_graded_choice_may_refuse_only_in_the_plain_refusal_shape() {
    let request = graded();
    let refusal = r#"{"name":"grade","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}"#;
    assert!(request.parse(&wire(refusal)).is_ok());
    for invalid in [
        refusal.replace(r#""confidence":0"#, r#""confidence":0.1"#),
        refusal.replace(
            r#""confidence":0"#,
            &format!(r#""confidence":0,"grades":{}"#, grades()),
        ),
    ] {
        assert_eq!(
            request.parse(&wire(&invalid)),
            Err(decision::Error::InvalidOutput),
            "{invalid}"
        );
    }
}

#[test]
fn ungraded_choices_reject_grades_and_keep_the_single_pick_contract() {
    let pick = answer("").replace(r#""choice":null"#, r#""choice":"false""#);
    for request in [graded_request(""), graded_request(r#","grade":false"#)] {
        assert!(request.parse(&wire(&pick)).is_ok());
        assert_eq!(
            request.parse(&wire(&valid())),
            Err(decision::Error::InvalidOutput)
        );
        let graded_pick = pick.replace(
            r#""confidence":0"#,
            &format!(r#""confidence":0.5,"grades":{}"#, grades()),
        );
        assert_eq!(
            request.parse(&wire(&graded_pick)),
            Err(decision::Error::InvalidOutput)
        );
    }
    assert_eq!(
        graded().parse(&wire(
            &pick.replace(r#""confidence":0"#, r#""confidence":0.8"#)
        )),
        Err(decision::Error::InvalidOutput)
    );
}

#[test]
fn grades_are_valid_only_for_choice_answers_to_graded_choice_questions() {
    let request = Request::decode(
        &parse_json(
            r#"{"state":{},"questions":[{"type":"predicate","name":"safe","instructions":"Safe?"},{"type":"score","name":"effort","instructions":"Grade","levels":[{"label":"low"},{"label":"high"}]}]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let wire = |predicate: &str, score: &str| {
        stringify_json(
            &parse_json(&format!(
                r#"{{"decisions":{{"version":1,"answers":[{predicate},{score}]}}}}"#
            ))
            .unwrap(),
        )
    };
    let predicate = r#"{"name":"safe","type":"predicate","answer":true,"choice":null,"score":null,"confidence":0.9}"#;
    let score = r#"{"name":"effort","type":"score","answer":null,"choice":null,"score":1,"confidence":0.7}"#;
    assert!(request.parse(&wire(predicate, score)).is_ok());
    let with_grades = |answer: &str| {
        answer.replace(
            "}",
            r#","grades":[{"choice":true,"confidence":0.5,"evidence":"Because"}]}"#,
        )
    };
    for (predicate, score) in [
        (with_grades(predicate), score.to_owned()),
        (predicate.to_owned(), with_grades(score)),
    ] {
        assert_eq!(
            request.parse(&wire(&predicate, &score)),
            Err(decision::Error::InvalidOutput)
        );
    }
}

#[test]
fn a_graded_question_may_coexist_with_ordinary_questions_in_one_request() {
    let request = Request::decode(
        &parse_json(
            r#"{"state":{},"questions":[{"type":"predicate","name":"safe","instructions":"Safe?"},{"type":"choice","name":"route","instructions":"Grade","grade":true,"choices":[{"value":"keep"},{"value":"change"}]},{"type":"choice","name":"pick","instructions":"Pick","choices":[{"value":"a"},{"value":"b"}]}]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let document = |route: &str| {
        stringify_json(
            &parse_json(&format!(
                r#"{{"decisions":{{"version":1,"answers":[{{"name":"pick","type":"choice","answer":null,"choice":"b","score":null,"confidence":0.6}},{route},{{"name":"safe","type":"predicate","answer":false,"choice":null,"score":null,"confidence":0.9}}]}}}}"#
            ))
            .unwrap(),
        )
    };
    let route = r#"{"name":"route","type":"choice","answer":null,"choice":null,"score":null,"confidence":0,"grades":[{"choice":"keep","confidence":0.7,"evidence":"Cheaper"},{"choice":"change","confidence":0.3,"evidence":"Riskier"}]}"#;
    let parsed = request.parse(&document(route)).unwrap();
    assert_eq!(
        parsed
            .iter()
            .map(|answer| match answer {
                JsonValue::Object(fields) => stringify_json(fields.get(&"name".into()).unwrap()),
                _ => panic!(),
            })
            .collect::<Vec<_>>(),
        [r#""safe""#, r#""route""#, r#""pick""#]
    );
    assert!(request.parse(&request.template()).is_ok());
    assert_eq!(
        request.parse(&document(
            &route.replace(r#""choice":"change""#, r#""choice":"keep""#)
        )),
        Err(decision::Error::InvalidOutput)
    );
}

#[test]
fn grade_must_be_a_boolean_on_a_choice_question_and_is_rejected_elsewhere() {
    for invalid in [
        r#"{"state":{},"questions":[{"type":"choice","name":"a","instructions":"Grade","grade":"true","choices":[{"value":"x"}]}]}"#,
        r#"{"state":{},"questions":[{"type":"choice","name":"a","instructions":"Grade","grade":null,"choices":[{"value":"x"}]}]}"#,
        r#"{"state":{},"questions":[{"type":"choice","name":"a","instructions":"Grade","grade":1,"choices":[{"value":"x"}]}]}"#,
        r#"{"state":{},"questions":[{"type":"predicate","name":"a","instructions":"Judge","grade":true}]}"#,
        r#"{"state":{},"questions":[{"type":"score","name":"a","instructions":"Judge","grade":true,"levels":[{"label":"low"},{"label":"high"}]}]}"#,
    ] {
        assert_eq!(
            Request::decode(&parse_json(invalid).unwrap()),
            Err(decision::Error::InvalidRequest),
            "{invalid}"
        );
    }
    for valid in [
        r#"{"state":{},"questions":[{"type":"choice","name":"a","instructions":"Grade","grade":true,"choices":[{"value":"x"}]}]}"#,
        r#"{"state":{},"questions":[{"type":"choice","name":"a","instructions":"Pick","grade":false,"choices":[{"value":"x"}]}]}"#,
    ] {
        assert!(
            Request::decode(&parse_json(valid).unwrap()).is_ok(),
            "{valid}"
        );
    }
}

#[test]
fn the_graded_template_is_a_plain_refusal() {
    let request = graded();
    let template = parse_json(&request.template()).unwrap();
    let JsonValue::Object(root) = &template else {
        panic!()
    };
    let JsonValue::Object(decisions) = root.get(&"decisions".into()).unwrap() else {
        panic!()
    };
    let JsonValue::Array(answers) = decisions.get(&"answers".into()).unwrap() else {
        panic!()
    };
    assert_eq!(answers.len(), 1);
    let JsonValue::Object(answer) = &answers[0] else {
        panic!()
    };
    assert_eq!(answer.iter().count(), 6);
    assert_eq!(
        answer.get(&"type".into()),
        Some(&JsonValue::String("refusal".into()))
    );
}

#[test]
fn the_tool_contract_declares_optional_grade_and_grades_and_documents_them() {
    let contract = parse_json(include_str!("../src/tools/builtin/decision.tool.json")).unwrap();
    let JsonValue::Object(contract) = &contract else {
        panic!()
    };
    let description = stringify_json(contract.get(&"description".into()).unwrap());
    for expected in [
        "Choice grade defaults to false for a single pick.",
        "Set grade: true to receive grades: [{ choice, confidence, evidence }] for every listed choice exactly once, with no pick;",
        "evidence is nonempty and at most 500 characters and confidence is in [0,1].",
        r#"\"grade\":true"#,
    ] {
        assert!(description.contains(expected), "{expected}");
    }
    let input = stringify_json(contract.get(&"inputSchema".into()).unwrap());
    assert!(
        input.contains(r#""grade":{"anyOf":[{"type":"boolean"},{"type":"null"}]}"#),
        "{input}"
    );
    assert_eq!(input.matches(r#""grade":"#).count(), 1, "{input}");
    let output = stringify_json(contract.get(&"outputSchema".into()).unwrap());
    assert!(
        output.contains(r#""grades":{"anyOf":[{"type":"array""#),
        "{output}"
    );
    assert!(output.contains("500"), "{output}");
    let required = output
        .split(r#""required":["name","type","answer","choice","score","confidence"]"#)
        .count();
    assert_eq!(required, 2, "{output}");
    assert!(
        !output.contains(
            r#""required":["name","type","answer","choice","score","confidence","grades"]"#
        )
    );
}
