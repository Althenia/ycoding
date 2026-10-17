use ycoding_core::session::store::Service;
use ycoding_schema::{
    DomainDecode, model, parse_json, session, session_cache_diagnostics::GenerationSpeedHistory,
    session_message, session_revert,
};
use ycoding_store::{
    Store,
    resources::{Request, RequestTable},
    session::{Document, Message, MessageTable, SessionTable},
};

#[path = "session_support/mod.rs"]
mod support;

const SECOND_NS: u64 = 1_000_000_000;

fn model_ref(provider: &str, id: &str) -> model::Ref {
    model::Ref::decode(
        &parse_json(&format!(r#"{{"providerID":"{provider}","id":"{id}"}}"#)).unwrap(),
    )
    .unwrap()
}

fn tested() -> model::Ref {
    model_ref("local", "test")
}

fn other() -> model::Ref {
    model_ref("local", "other")
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn message_id(value: &str) -> session_message::Id {
    session_message::Id::new(value).unwrap()
}

fn session_row(store: &Store, session: &str, selected: &model::Ref, revert: Option<&str>) {
    let mut row = support::record(session);
    row.model = Some(Document::from_domain(selected).unwrap());
    row.revert = revert.map(|boundary| {
        Document::from_domain(&session_revert::Revert {
            message_id: message_id(boundary),
            snapshot: None,
            files: None,
        })
        .unwrap()
    });
    store
        .submit(move |tx| SessionTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
}

fn message(store: &Store, session: &str, name: &str, type_: &str, seq: i64, model: &str) {
    let data = if type_ == "assistant" {
        format!(
            r#"{{"time":{{"created":1}},"agent":"build","model":{{"providerID":"local","id":"{model}"}},"content":[],"tokens":{{"input":10,"output":2,"reasoning":1,"cache":{{"read":3,"write":4}}}}}}"#
        )
    } else {
        r#"{"text":"user","time":{"created":1}}"#.to_string()
    };
    let row = Message {
        id: format!("msg_{session}_{name}").as_str().into(),
        session_id: session.into(),
        type_: type_.into(),
        seq,
        time_created: 1,
        time_updated: 1,
        data: parse_json(&data).unwrap(),
    };
    store
        .submit(move |tx| MessageTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
}

struct Step<'a> {
    session: &'a str,
    ordinal: i64,
    assistant: Option<&'a str>,
    source: &'a str,
    model: model::Ref,
    timing: Option<String>,
}

fn timing(tokens: u64) -> Option<String> {
    Some(format!(
        r#"{{"generatedTokens":{tokens},"observedGenerationDurationNs":{SECOND_NS}}}"#
    ))
}

impl<'a> Step<'a> {
    fn new(session: &'a str, ordinal: i64, assistant: &'a str, tokens: u64) -> Self {
        Self {
            session,
            ordinal,
            assistant: Some(assistant),
            source: "step",
            model: tested(),
            timing: timing(tokens),
        }
    }

    fn insert(self, store: &Store) {
        let row = Request {
            id: format!("prq_{}_{}", self.session, self.ordinal)
                .as_str()
                .into(),
            session_id: self.session.into(),
            input_id: None,
            assistant_message_id: self
                .assistant
                .map(|name| format!("msg_{}_{name}", self.session).as_str().into()),
            connection_identity_digest: None,
            source: self.source.into(),
            agent: "build".into(),
            model: Document::from_domain(&self.model).unwrap(),
            route_id: "test".into(),
            prompt_cache_key: format!("cachekey-{}", self.ordinal).as_str().into(),
            system_digest: "system".into(),
            tool_digest: "tools".into(),
            request: self.ordinal,
            attempts: 1,
            invalidation: "first-request".into(),
            continuation: "full".into(),
            cache_read_reported: None,
            timing: self
                .timing
                .as_deref()
                .map(|value| Document::new(parse_json(value).unwrap()).unwrap()),
            cost: None,
            tokens: Document::new(
                parse_json(r#"{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                    .unwrap(),
            )
            .unwrap(),
            time_created: self.ordinal,
            usage_anchor: None,
        };
        store
            .submit(move |tx| RequestTable::insert(tx, &row))
            .unwrap()
            .wait()
            .unwrap();
    }
}

/// Seq 0 `a0` (100 tok/s), seq 1 `a1` (200), seq 2 user `boundary`, seq 3 `a3` (400).
fn timeline(store: &Store, session: &str, selected: &model::Ref, revert: Option<&str>) {
    session_row(store, session, selected, revert);
    message(store, session, "a0", "assistant", 0, "test");
    message(store, session, "a1", "assistant", 1, "test");
    message(store, session, "boundary", "user", 2, "test");
    message(store, session, "a3", "assistant", 3, "test");
    Step::new(session, 1, "a0", 100).insert(store);
    Step::new(session, 2, "a1", 200).insert(store);
    Step::new(session, 3, "a3", 400).insert(store);
}

fn speed(service: &Service, session: &str, boundary: Option<&str>) -> GenerationSpeedHistory {
    service
        .diagnostics(&id(session), boundary.map(message_id).as_ref())
        .unwrap()
        .unwrap()
        .generation_speed
        .unwrap()
}

fn tokens(history: &GenerationSpeedHistory) -> Vec<i64> {
    history
        .recent
        .iter()
        .map(|sample| sample.tokens.get())
        .collect()
}

#[test]
fn diagnostics_counts_only_requests_whose_assistant_precedes_the_boundary() {
    let store = support::store();
    let service = Service::new(store.client());
    timeline(&store, "ses_gen", &tested(), None);

    assert_eq!(tokens(&speed(&service, "ses_gen", None)), [100, 200, 400]);
    assert_eq!(
        tokens(&speed(&service, "ses_gen", Some("msg_ses_gen_boundary"))),
        [100, 200]
    );
    assert_eq!(
        tokens(&speed(&service, "ses_gen", Some("msg_ses_gen_a3"))),
        [100, 200]
    );
    assert_eq!(
        tokens(&speed(&service, "ses_gen", Some("msg_ses_gen_a1"))),
        [100]
    );
}

#[test]
fn bounded_speed_aggregates_only_the_bounded_samples() {
    let store = support::store();
    let service = Service::new(store.client());
    timeline(&store, "ses_gen", &tested(), None);

    let history = speed(&service, "ses_gen", Some("msg_ses_gen_boundary"));
    let latest = history.latest.unwrap();
    assert_eq!(
        (
            latest.tokens.get(),
            latest.duration_ns.get(),
            latest.tokens_per_second
        ),
        (300, 2 * SECOND_NS as i64, 150.0)
    );
}

#[test]
fn bounded_speed_follows_the_measured_model_and_unbounded_speed_follows_the_selected_model() {
    let store = support::store();
    let service = Service::new(store.client());
    session_row(&store, "ses_gen", &other(), None);
    message(&store, "ses_gen", "a0", "assistant", 0, "test");
    message(&store, "ses_gen", "boundary", "user", 1, "test");
    message(&store, "ses_gen", "a2", "assistant", 2, "other");
    let mut earlier = Step::new("ses_gen", 1, "a0", 7);
    earlier.model = other();
    earlier.insert(&store);
    Step::new("ses_gen", 2, "a0", 100).insert(&store);
    Step::new("ses_gen", 3, "a2", 25).insert(&store);
    let mut later = Step::new("ses_gen", 4, "a2", 50);
    later.model = other();
    later.insert(&store);

    let unbounded = speed(&service, "ses_gen", None);
    assert_eq!(unbounded.model, Some(other()));
    assert_eq!(tokens(&unbounded), [7, 50]);
    let bounded = speed(&service, "ses_gen", Some("msg_ses_gen_boundary"));
    assert_eq!(bounded.model, Some(tested()));
    assert_eq!(tokens(&bounded), [100]);
}

#[test]
fn bounded_speed_keeps_the_newest_eight_valid_samples_before_the_boundary() {
    let store = support::store();
    let service = Service::new(store.client());
    session_row(&store, "ses_gen", &tested(), None);
    let mut seq = 0;
    let mut ordinal = 0;
    for tokens in (1..=10).map(|index| index * 10) {
        let name = format!("a{seq}");
        message(&store, "ses_gen", &name, "assistant", seq, "test");
        ordinal += 1;
        Step::new("ses_gen", ordinal, &name, tokens).insert(&store);
        let mut invalid = [
            Step {
                timing: None,
                ..Step::new("ses_gen", 0, &name, 0)
            },
            Step {
                timing: Some(r#"{"totalMs":5,"firstOutputMs":1}"#.into()),
                ..Step::new("ses_gen", 0, &name, 0)
            },
            Step {
                timing: Some(r#"{"generatedTokens":9}"#.into()),
                ..Step::new("ses_gen", 0, &name, 0)
            },
            Step {
                source: "title",
                ..Step::new("ses_gen", 0, &name, 999)
            },
            Step {
                model: other(),
                ..Step::new("ses_gen", 0, &name, 888)
            },
        ];
        for step in &mut invalid {
            ordinal += 1;
            step.ordinal = ordinal;
        }
        invalid.into_iter().for_each(|step| step.insert(&store));
        seq += 1;
    }
    message(&store, "ses_gen", "boundary", "user", seq, "test");
    for (offset, tokens) in [7_000, 8_000].into_iter().enumerate() {
        let name = format!("later{offset}");
        message(
            &store,
            "ses_gen",
            &name,
            "assistant",
            seq + 1 + offset as i64,
            "test",
        );
        ordinal += 1;
        Step::new("ses_gen", ordinal, &name, tokens).insert(&store);
    }

    let history = speed(&service, "ses_gen", Some("msg_ses_gen_boundary"));
    assert_eq!(tokens(&history), [30, 40, 50, 60, 70, 80, 90, 100]);
    assert_eq!(history.latest.unwrap().tokens.get(), 520);
    assert_eq!(
        tokens(&speed(&service, "ses_gen", None)),
        [50, 60, 70, 80, 90, 100, 7_000, 8_000]
    );
}

#[test]
fn bounded_speed_without_valid_samples_reports_no_numeric_sample() {
    let store = support::store();
    let service = Service::new(store.client());
    session_row(&store, "ses_gen", &tested(), None);
    message(&store, "ses_gen", "a0", "assistant", 0, "test");
    message(&store, "ses_gen", "boundary", "user", 1, "test");
    message(&store, "ses_gen", "a2", "assistant", 2, "test");
    Step {
        timing: None,
        ..Step::new("ses_gen", 1, "a0", 0)
    }
    .insert(&store);
    Step {
        timing: Some(r#"{"totalMs":5}"#.into()),
        ..Step::new("ses_gen", 2, "a0", 0)
    }
    .insert(&store);
    Step::new("ses_gen", 3, "a2", 300).insert(&store);

    let history = speed(&service, "ses_gen", Some("msg_ses_gen_boundary"));
    assert_eq!(history.model, Some(tested()));
    assert!(history.recent.is_empty());
    assert!(history.latest.is_none());
    assert_eq!(tokens(&speed(&service, "ses_gen", None)), [300]);
}

#[test]
fn bounded_speed_follows_request_order_up_to_the_boundary_assistants_newest_request() {
    let store = support::store();
    let service = Service::new(store.client());
    session_row(&store, "ses_gen", &tested(), None);
    message(&store, "ses_gen", "a0", "assistant", 0, "test");
    message(&store, "ses_gen", "boundary", "user", 1, "test");
    message(&store, "ses_gen", "a2", "assistant", 2, "test");
    Step {
        assistant: None,
        ..Step::new("ses_gen", 1, "a0", 100)
    }
    .insert(&store);
    Step::new("ses_gen", 2, "a0", 200).insert(&store);
    Step::new("ses_gen", 3, "a2", 300).insert(&store);
    Step {
        assistant: None,
        ..Step::new("ses_gen", 4, "a2", 400)
    }
    .insert(&store);

    assert_eq!(
        tokens(&speed(&service, "ses_gen", Some("msg_ses_gen_boundary"))),
        [100, 200]
    );
    assert_eq!(
        tokens(&speed(&service, "ses_gen", None)),
        [100, 200, 300, 400]
    );
}

#[test]
fn bounded_speed_is_empty_when_the_boundary_assistant_has_no_linked_request() {
    let store = support::store();
    let service = Service::new(store.client());
    session_row(&store, "ses_gen", &tested(), None);
    message(&store, "ses_gen", "a0", "assistant", 0, "test");
    message(&store, "ses_gen", "boundary", "user", 1, "test");
    message(&store, "ses_gen", "a2", "assistant", 2, "test");
    Step {
        assistant: None,
        ..Step::new("ses_gen", 1, "a0", 100)
    }
    .insert(&store);
    Step::new("ses_gen", 2, "a2", 200).insert(&store);

    let history = speed(&service, "ses_gen", Some("msg_ses_gen_boundary"));
    assert_eq!(history.model, Some(tested()));
    assert!(history.recent.is_empty());
    assert!(history.latest.is_none());
    assert_eq!(tokens(&speed(&service, "ses_gen", None)), [100, 200]);
}

#[test]
fn snapshot_speed_stops_at_the_staged_revert_boundary() {
    let store = support::store();
    let service = Service::new(store.client());
    timeline(&store, "ses_live", &tested(), None);
    timeline(
        &store,
        "ses_revert",
        &tested(),
        Some("msg_ses_revert_boundary"),
    );

    let live = service.snapshot(&id("ses_live"), 100, None).unwrap();
    assert_eq!(tokens(&live.generation_speed.unwrap()), [100, 200, 400]);

    let reverted = service.snapshot(&id("ses_revert"), 100, None).unwrap();
    let history = reverted.generation_speed.unwrap();
    assert_eq!(tokens(&history), [100, 200]);
    assert_eq!(
        Some(history),
        service
            .diagnostics(
                &id("ses_revert"),
                Some(&message_id("msg_ses_revert_boundary"))
            )
            .unwrap()
            .unwrap()
            .generation_speed
    );
}

#[test]
fn snapshot_speed_is_absent_when_no_measured_assistant_precedes_the_revert() {
    let store = support::store();
    let service = Service::new(store.client());
    session_row(
        &store,
        "ses_revert",
        &tested(),
        Some("msg_ses_revert_boundary"),
    );
    message(&store, "ses_revert", "boundary", "user", 0, "test");
    message(&store, "ses_revert", "a1", "assistant", 1, "test");
    Step::new("ses_revert", 1, "a1", 100).insert(&store);

    assert!(
        service
            .snapshot(&id("ses_revert"), 100, None)
            .unwrap()
            .generation_speed
            .is_none()
    );
}
