use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json,
    session_id::SessionId,
    session_message_id,
    usage_accounting::{
        Attribution, Breakdown, Cost, Helper, History, PromptCost, PromptCosts, PromptInput,
        Status, TaskCost, TaskCosts, TaskInput,
    },
};

const ZERO_TOKENS: &str = r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#;
const TOKENS: &str = r#"{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}"#;

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn same(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same(value, other)))
        }
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same(left, right))
        }
        _ => left == right,
    }
}

fn breakdown(requests: u32, tokens: &str, cost: &str) -> String {
    format!(r#"{{"requests":{requests},"tokens":{tokens},"cost":{cost}}}"#)
}

fn empty() -> String {
    breakdown(
        0,
        ZERO_TOKENS,
        r#"{"pricedRequests":0,"unpricedRequests":0}"#,
    )
}

fn prompt_costs() -> String {
    format!(
        r#"{{"units":[{{"anchor":{{"sessionID":"ses_one","inputID":"msg_one"}},"status":"so-far","attribution":"complete","history":"retained","total":{},"main":{},"children":{},"helpers":[{{"source":"title","requests":1,"tokens":{TOKENS},"cost":{{"known":4,"pricedRequests":1,"unpricedRequests":0,"provenance":"current_catalog","total":4}}}}]}},{{"anchor":{{"sessionID":"ses_one","inputID":"msg_missing"}},"status":"settled","attribution":"unattributed","history":"partial","total":{},"main":{},"children":{},"helpers":[]}}],"unattributed":{},"history":"partial"}}"#,
        breakdown(
            2,
            TOKENS,
            r#"{"total":6,"known":6,"pricedRequests":2,"unpricedRequests":0,"provenance":"current_catalog"}"#
        ),
        breakdown(
            2,
            TOKENS,
            r#"{"total":6,"known":6,"pricedRequests":2,"unpricedRequests":0,"provenance":"current_catalog"}"#
        ),
        empty(),
        empty(),
        empty(),
        empty(),
        breakdown(
            1,
            TOKENS,
            r#"{"known":7,"pricedRequests":1,"unpricedRequests":1,"provenance":"recorded"}"#
        ),
    )
}

fn task_costs() -> String {
    format!(
        r#"{{"tasks":[{{"sessionID":"ses_task","usageAnchor":{{"sessionID":"ses_one","inputID":"msg_one"}},"status":"settled","attribution":"complete","history":"retained","total":{},"main":{},"children":{},"helpers":[]}},{{"sessionID":"ses_nested","status":"so-far","attribution":"complete","history":"partial","total":{},"main":{},"children":{},"helpers":[{{"source":"compaction","requests":1,"tokens":{TOKENS},"cost":{{"pricedRequests":0,"unpricedRequests":1}}}}]}}],"total":{},"history":"partial"}}"#,
        breakdown(
            1,
            TOKENS,
            r#"{"total":5,"known":5,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#
        ),
        breakdown(
            1,
            TOKENS,
            r#"{"total":5,"known":5,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#
        ),
        empty(),
        breakdown(1, TOKENS, r#"{"pricedRequests":0,"unpricedRequests":1}"#),
        breakdown(1, TOKENS, r#"{"pricedRequests":0,"unpricedRequests":1}"#),
        empty(),
        breakdown(
            2,
            TOKENS,
            r#"{"known":5,"pricedRequests":1,"unpricedRequests":1,"provenance":"recorded"}"#
        ),
    )
}

#[test]
fn prompt_costs_round_trip_with_settled_and_so_far_units_helpers_and_unattributed_usage() {
    let value = json(&prompt_costs());
    let decoded = PromptCosts::decode(&value).unwrap();
    assert!(same(&decoded.encode(), &value));
    assert_eq!(decoded.units.len(), 2);
    let unit: &PromptCost = &decoded.units[0];
    assert_eq!(unit.anchor.session_id, SessionId::new("ses_one").unwrap());
    assert_eq!(
        unit.anchor.input_id,
        session_message_id::Id::new("msg_one").unwrap()
    );
    assert_eq!(unit.status, Status("so-far".into()));
    assert_eq!(unit.attribution, Attribution("complete".into()));
    assert_eq!(unit.history, History("retained".into()));
    let helper: &Helper = &unit.helpers[0];
    assert_eq!(helper.source.0, "title".into());
    assert_eq!(decoded.history, History("partial".into()));
    assert_eq!(PromptCosts::decode(&decoded.encode()).unwrap(), decoded);
}

#[test]
fn task_costs_round_trip_with_and_without_a_usage_anchor() {
    let value = json(&task_costs());
    let decoded = TaskCosts::decode(&value).unwrap();
    assert!(same(&decoded.encode(), &value));
    let first: &TaskCost = &decoded.tasks[0];
    assert_eq!(first.session_id, SessionId::new("ses_task").unwrap());
    assert!(first.usage_anchor.is_some());
    assert_eq!(decoded.tasks[1].usage_anchor, None);
    let JsonValue::Object(encoded) = &decoded.tasks[1].encode() else {
        panic!("task cost encodes as an object")
    };
    assert!(encoded.get(&"usageAnchor".into()).is_none());
    assert_eq!(TaskCosts::decode(&decoded.encode()).unwrap(), decoded);
}

#[test]
fn cost_accepts_known_coverage_only_with_provenance_and_a_total_only_when_complete() {
    for valid in [
        r#"{"pricedRequests":0,"unpricedRequests":0}"#,
        r#"{"pricedRequests":0,"unpricedRequests":3}"#,
        r#"{"known":0,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
        r#"{"total":0,"known":0,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
        r#"{"total":2.5,"known":2.5,"pricedRequests":2,"unpricedRequests":0,"provenance":"current_catalog"}"#,
        r#"{"known":1,"pricedRequests":1,"unpricedRequests":2,"provenance":"current_catalog"}"#,
        r#"{"total":-1,"known":-1,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
    ] {
        let value = json(valid);
        let cost = Cost::decode(&value).unwrap_or_else(|error| panic!("{valid}: {error:?}"));
        assert!(same(&cost.encode(), &value), "{valid}");
    }
    for invalid in [
        r#"{"known":1,"pricedRequests":1,"unpricedRequests":0}"#,
        r#"{"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
        r#"{"pricedRequests":1,"unpricedRequests":0}"#,
        r#"{"known":1,"pricedRequests":0,"unpricedRequests":1,"provenance":"recorded"}"#,
        r#"{"total":1,"pricedRequests":0,"unpricedRequests":0}"#,
        r#"{"total":1,"known":1,"pricedRequests":1,"unpricedRequests":1,"provenance":"recorded"}"#,
        r#"{"total":2,"known":1,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
        r#"{"known":1,"pricedRequests":1,"unpricedRequests":0,"provenance":"estimated"}"#,
        r#"{"pricedRequests":-1,"unpricedRequests":0}"#,
        r#"{"pricedRequests":0.5,"unpricedRequests":0}"#,
        r#"{"pricedRequests":0}"#,
        r#"{"unpricedRequests":0}"#,
        "null",
    ] {
        assert!(Cost::decode(&json(invalid)).is_err(), "{invalid}");
    }
}

#[test]
fn breakdowns_require_whole_request_counts_token_usage_and_a_valid_cost() {
    assert!(Breakdown::decode(&json(&empty())).is_ok());
    for invalid in [
        breakdown(
            0,
            ZERO_TOKENS,
            r#"{"pricedRequests":1,"unpricedRequests":0}"#,
        ),
        format!(
            r#"{{"requests":-1,"tokens":{ZERO_TOKENS},"cost":{{"pricedRequests":0,"unpricedRequests":0}}}}"#
        ),
        format!(
            r#"{{"requests":1.5,"tokens":{ZERO_TOKENS},"cost":{{"pricedRequests":0,"unpricedRequests":0}}}}"#
        ),
        r#"{"requests":0,"cost":{"pricedRequests":0,"unpricedRequests":0}}"#.to_owned(),
        format!(r#"{{"requests":0,"tokens":{ZERO_TOKENS}}}"#),
    ] {
        assert!(Breakdown::decode(&json(&invalid)).is_err(), "{invalid}");
    }
}

#[test]
fn status_attribution_history_and_helper_source_accept_only_their_literals() {
    let replace = |from: &str, to: &str| json(&prompt_costs().replacen(from, to, 1));
    for invalid in [
        replace(r#""status":"so-far""#, r#""status":"so_far""#),
        replace(r#""status":"so-far""#, r#""status":"running""#),
        replace(r#""attribution":"complete""#, r#""attribution":"none""#),
        replace(r#""history":"retained""#, r#""history":"pruned""#),
        replace(r#""source":"title""#, r#""source":"chat""#),
        replace(
            r#""anchor":{"sessionID":"ses_one","inputID":"msg_one"}"#,
            r#""anchor":{"sessionID":"ses_one","inputID":"msg_one","extra":1}"#,
        ),
        replace(
            r#""anchor":{"sessionID":"ses_one","inputID":"msg_one"}"#,
            r#""anchor":null"#,
        ),
    ] {
        assert!(PromptCosts::decode(&invalid).is_err());
    }
    for (status, attribution, history) in [
        ("settled", "complete", "retained"),
        ("so-far", "partial", "partial"),
        ("settled", "unattributed", "partial"),
    ] {
        let value = json(
            &prompt_costs()
                .replacen(
                    r#""status":"so-far""#,
                    &format!(r#""status":"{status}""#),
                    1,
                )
                .replacen(
                    r#""attribution":"complete""#,
                    &format!(r#""attribution":"{attribution}""#),
                    1,
                )
                .replacen(
                    r#""history":"retained""#,
                    &format!(r#""history":"{history}""#),
                    1,
                ),
        );
        assert!(
            PromptCosts::decode(&value).is_ok(),
            "{status} {attribution} {history}"
        );
    }
    for source in [
        "step",
        "title",
        "goal",
        "compaction",
        "decision",
        "prediction",
        "prompt",
    ] {
        let value = json(&prompt_costs().replacen(
            r#""source":"title""#,
            &format!(r#""source":"{source}""#),
            1,
        ));
        assert!(PromptCosts::decode(&value).is_ok(), "{source}");
    }
}

fn ids(prefix: &str, count: usize) -> String {
    (0..count)
        .map(|index| format!(r#""{prefix}_{index:03}""#))
        .collect::<Vec<_>>()
        .join(",")
}

#[test]
fn prompt_input_requires_one_to_one_hundred_distinct_message_ids() {
    let input =
        PromptInput::decode(&json(&format!(r#"{{"inputIDs":[{}]}}"#, ids("msg", 100)))).unwrap();
    assert_eq!(input.input_ids.len(), 100);
    assert_eq!(
        input.input_ids[0],
        session_message_id::Id::new("msg_000").unwrap()
    );
    for invalid in [
        r#"{"inputIDs":[]}"#.to_owned(),
        format!(r#"{{"inputIDs":[{}]}}"#, ids("msg", 101)),
        r#"{"inputIDs":["msg_one","msg_one"]}"#.to_owned(),
        r#"{"inputIDs":["ses_one"]}"#.to_owned(),
        r#"{"inputIDs":["one"]}"#.to_owned(),
        r#"{"inputIDs":"msg_one"}"#.to_owned(),
        r#"{"inputIDs":[1]}"#.to_owned(),
        r#"{}"#.to_owned(),
    ] {
        assert!(PromptInput::decode(&json(&invalid)).is_err(), "{invalid}");
    }
}

#[test]
fn task_input_requires_one_to_one_hundred_distinct_session_ids() {
    let input =
        TaskInput::decode(&json(&format!(r#"{{"sessionIDs":[{}]}}"#, ids("ses", 100)))).unwrap();
    assert_eq!(input.session_ids.len(), 100);
    assert_eq!(input.session_ids[99], SessionId::new("ses_099").unwrap());
    for invalid in [
        r#"{"sessionIDs":[]}"#.to_owned(),
        format!(r#"{{"sessionIDs":[{}]}}"#, ids("ses", 101)),
        r#"{"sessionIDs":["ses_one","ses_one"]}"#.to_owned(),
        r#"{"sessionIDs":["msg_one"]}"#.to_owned(),
        r#"{"sessionIDs":"ses_one"}"#.to_owned(),
        r#"{}"#.to_owned(),
    ] {
        assert!(TaskInput::decode(&json(&invalid)).is_err(), "{invalid}");
    }
}
