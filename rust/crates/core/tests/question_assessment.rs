include!("tool_fixture.rs");
#[path = "decision_support/mod.rs"]
mod modes;

use std::{
    collections::{BTreeSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_ai::llm;
use ycoding_core::{
    coordination::decisions::{Gate, Reconsider, Source},
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision::{self, Invocation},
    session::{
        autonomy::{self, DecisionMode},
        review, store,
    },
    tools::{
        builtin::question::Question,
        materialization::Settlement,
        policy::{Reviews, forms::Forms},
        registry::{Options, Registration, Registry},
    },
};
use ycoding_schema::{DomainDecode, JsonValue, form, parse_json, stringify_json};

const BOUND: Duration = Duration::from_secs(10);
const INPUT: &str = r#"{"questions":[{"header":"Plan","question":"Which plan?","options":[{"label":"Fast","description":"Ship now"},{"label":"Careful","description":"Roll out slowly"}]}]}"#;

type Reply = Box<dyn Fn(&JsonValue) -> Result<JsonValue, decision::Error> + Send + Sync>;

struct Scripted {
    script: Mutex<VecDeque<Reply>>,
    hold: bool,
    entered: Notify,
    release: Notify,
}

impl Scripted {
    fn new(script: Vec<Reply>, hold: bool) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            hold,
            entered: Notify::new(),
            release: Notify::new(),
        })
    }
}

impl Evaluator for Scripted {
    fn evaluate<'a>(&'a self, input: JsonValue, invocation: Invocation<'a>) -> EvaluateFuture<'a> {
        let reply = self
            .script
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected helper call");
        Box::pin(async move {
            if self.hold {
                self.entered.notify_one();
                tokio::select! {
                    _ = self.release.notified() => {}
                    _ = invocation.cancellation.cancelled() => return Err(decision::Error::Cancelled),
                }
            }
            reply(&input)
        })
    }
}

fn response(answer: &str) -> Result<JsonValue, decision::Error> {
    Ok(parse_json(&format!(
        r#"{{"provider":"agent","response":{{"model":{{"providerID":"local","id":"judge"}},"semantics":"model-estimate","version":1,"answers":[{answer}]}}}}"#
    ))
    .unwrap())
}

fn graded(scores: &'static [f64]) -> Reply {
    Box::new(move |input| {
        let JsonValue::Object(input) = input else {
            panic!("helper input is an object")
        };
        let Some(JsonValue::Object(request)) = input.get(&"request".into()) else {
            panic!("helper input carries a request")
        };
        let Some(JsonValue::Array(questions)) = request.get(&"questions".into()) else {
            panic!("request carries questions")
        };
        let JsonValue::Object(question) = &questions[0] else {
            panic!("question is an object")
        };
        let Some(JsonValue::String(name)) = question.get(&"name".into()) else {
            panic!("question is named")
        };
        let Some(JsonValue::Array(choices)) = question.get(&"choices".into()) else {
            panic!("question lists choices")
        };
        let grades = choices
            .iter()
            .zip(scores)
            .map(|(choice, score)| {
                let JsonValue::Object(choice) = choice else {
                    panic!("choice is an object")
                };
                format!(
                    r#"{{"choice":{},"confidence":{score},"evidence":"Grounded in the stated goal."}}"#,
                    stringify_json(choice.get(&"value".into()).unwrap())
                )
            })
            .collect::<Vec<_>>();
        response(&format!(
            r#"{{"name":"{}","type":"choice","answer":null,"choice":null,"score":null,"confidence":0,"grades":[{}]}}"#,
            name.to_utf8().unwrap(),
            grades.join(",")
        ))
    })
}

struct Delivery;

impl review::Delivery for Delivery {
    fn wake(&self, _: &ycoding_schema::session::Id) {}

    fn answer_child<'a>(&'a self, _: review::ChildAnswer) -> review::DeliveryFuture<'a> {
        Box::pin(async {
            Err(review::DeliveryError::Conflict(
                "no child delivery in this fixture".into(),
            ))
        })
    }

    fn resolve_recovery<'a>(&'a self, _: review::RecoveryResolution) -> review::DeliveryFuture<'a> {
        Box::pin(async {
            Err(review::DeliveryError::Conflict(
                "no recovery in this fixture".into(),
            ))
        })
    }
}

struct Rig {
    fixture: ToolFixture,
    forms: Forms,
    registry: Arc<Registry>,
    registration: Registration,
}

impl Rig {
    async fn new(evaluator: Option<&Arc<Scripted>>, mode: DecisionMode, asleep: bool) -> Self {
        let fixture = ToolFixture::new();
        let reviews = Reviews {
            service: review::Service::new(
                store::Service::new(fixture.authority.store.client()),
                Arc::new(Delivery),
            ),
            limit: 16,
        };
        let mut forms = Forms::new(fixture.authority.authority(), fixture.authority.publisher())
            .with_reviews(reviews);
        if let Some(evaluator) = evaluator {
            forms = forms.with_decision(evaluator.clone());
        }
        let autonomy = autonomy::Service::new(fixture.authority.store.client());
        let session = fixture.context().session_id;
        modes::answers(&autonomy, &session, mode).await;
        if asleep {
            autonomy.set_defer(&session, true).await.unwrap();
        }
        let registry = Arc::new(fixture.registry());
        let registration = registry
            .register(
                vec![(
                    "question".into(),
                    Arc::new(Question {
                        forms: forms.clone(),
                        policy: fixture.policy.clone(),
                    }),
                )],
                Options::direct(),
            )
            .unwrap();
        Self {
            fixture,
            forms,
            registry,
            registration,
        }
    }

    fn spawn(&self) -> tokio::task::JoinHandle<Settlement> {
        let registry = self.registry.clone();
        let context = self.fixture.context();
        tokio::spawn(async move {
            registry
                .materialize(&[])
                .invoke("question", parse_json(INPUT).unwrap(), context)
                .await
                .unwrap()
        })
    }

    async fn pending(&self) -> form::Info {
        tokio::time::timeout(BOUND, async {
            loop {
                if let Some(pending) = self.forms.list(None).into_iter().next() {
                    return pending;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("question form was not created")
    }

    fn close(self) {
        drop(self.registration);
        self.fixture.cleanup();
    }
}

fn output(result: &Settlement) -> &JsonValue {
    &result
        .output
        .as_ref()
        .expect("tool did not succeed")
        .structured
}

fn find<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(value) = value else {
        panic!("not an object")
    };
    value.get(&key.into())
}

fn get<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    find(value, key).unwrap_or_else(|| panic!("missing {key}"))
}

fn first_field(value: &JsonValue) -> &JsonValue {
    let JsonValue::Array(fields) = get(get(value, "assessment"), "fields") else {
        panic!("fields is an array")
    };
    &fields[0]
}

fn string(text: &str) -> JsonValue {
    JsonValue::String(text.into())
}

fn message(result: &Settlement) -> String {
    match &result.result {
        llm::ToolResultValue::Text(JsonValue::String(text)) => text.to_utf8().unwrap(),
        other => panic!("unexpected tool result {other:?}"),
    }
}

#[tokio::test]
async fn an_automatic_answer_returns_its_via_confidence_and_assessment() {
    let evaluator = Scripted::new(vec![graded(&[0.96, 0.5])], false);
    let rig = Rig::new(Some(&evaluator), modes::yolo(true), false).await;
    let result = tokio::time::timeout(BOUND, rig.spawn())
        .await
        .unwrap()
        .unwrap();
    let out = output(&result);
    assert_contract(out);
    assert_eq!(get(out, "answers"), &parse_json(r#"[["Fast"]]"#).unwrap());
    assert_eq!(get(out, "automatic"), &JsonValue::Bool(true));
    assert_eq!(get(out, "via"), &string("yolo"));
    assert_eq!(get(out, "confidence"), &JsonValue::Number(0.96));
    assert_eq!(get(first_field(out), "status"), &string("assessed"));
    assert_eq!(
        get(first_field(out), "recommendation"),
        &parse_json(r#"["Fast"]"#).unwrap()
    );
    assert!(find(out, "source").is_none() && find(out, "deferredItemID").is_none());
    assert!(message(&result).contains("selected automatically"));
    rig.close();
}

#[tokio::test]
async fn a_human_answer_returns_the_unassessed_field_without_automatic_markers() {
    let rig = Rig::new(None, modes::yolo(false), false).await;
    let task = rig.spawn();
    let pending = rig.pending().await;
    rig.forms
        .reply(
            &pending.id,
            form::Answer::decode(&parse_json(r#"{"q0":"Careful"}"#).unwrap()).unwrap(),
        )
        .unwrap();
    let result = tokio::time::timeout(BOUND, task).await.unwrap().unwrap();
    let out = output(&result);
    assert_contract(out);
    assert_eq!(
        get(out, "answers"),
        &parse_json(r#"[["Careful"]]"#).unwrap()
    );
    for key in ["automatic", "via", "confidence", "source"] {
        assert!(find(out, key).is_none(), "{key}");
    }
    assert_eq!(get(first_field(out), "status"), &string("not_assessed"));
    assert!(message(&result).contains("User has answered your questions"));
    rig.close();
}

#[tokio::test]
async fn a_deferred_inconclusive_assessment_returns_a_valid_fallback_and_its_final_evidence() {
    let evaluator = Scripted::new(vec![graded(&[0.7, 0.5])], false);
    let rig = Rig::new(Some(&evaluator), modes::yolo(true), true).await;
    let result = tokio::time::timeout(BOUND, rig.spawn())
        .await
        .unwrap()
        .unwrap();
    let out = output(&result);
    assert_contract(out);
    assert_eq!(get(out, "answers"), &parse_json(r#"[["Fast"]]"#).unwrap());
    assert!(find(out, "deferredItemID").is_none());
    assert_eq!(get(first_field(out), "status"), &string("assessed"));
    assert!(find(first_field(out), "recommendation").is_none());
    assert_eq!(get(out, "automatic"), &JsonValue::Bool(true));
    assert_eq!(get(out, "via"), &string("yolo"));
    assert!(find(out, "confidence").is_none());
    rig.close();
}

#[tokio::test]
async fn a_deferred_question_without_an_evaluator_returns_a_valid_fallback_and_unavailable_assessment()
 {
    let rig = Rig::new(None, modes::yolo(true), true).await;
    let result = tokio::time::timeout(BOUND, rig.spawn())
        .await
        .unwrap()
        .unwrap();
    let out = output(&result);
    assert_contract(out);
    assert!(find(out, "deferredItemID").is_none());
    assert_eq!(get(out, "answers"), &parse_json(r#"[["Fast"]]"#).unwrap());
    assert_eq!(get(out, "automatic"), &JsonValue::Bool(true));
    assert_eq!(get(out, "via"), &string("yolo"));
    assert_eq!(get(first_field(out), "status"), &string("unavailable"));
    assert_eq!(get(get(out, "assessment"), "mode"), &string("yolo"));
    assert!(rig.forms.list(None).is_empty());
    rig.close();
}

#[tokio::test]
async fn a_coordinator_answer_during_native_assessment_returns_its_source_and_keeps_the_assessment()
{
    let evaluator = Scripted::new(vec![graded(&[0.96, 0.5])], true);
    let rig = Rig::new(Some(&evaluator), modes::yolo(true), false).await;
    let task = rig.spawn();
    let pending = rig.pending().await;
    tokio::time::timeout(BOUND, evaluator.entered.notified())
        .await
        .unwrap();
    let fingerprint = rig.forms.snapshot(&pending.id).unwrap().fingerprint;
    let settled = rig
        .forms
        .reconsider(
            &pending.id,
            Reconsider {
                fingerprint,
                source: Source {
                    coordinator_session_id: ycoding_schema::session_id::SessionId::new(
                        "ses_native_coordinator",
                    )
                    .unwrap(),
                    group_id: Some("cgrp_native".into()),
                    rationale: "Careful fits the assigned scope.".into(),
                },
                decision: None,
                answer: Some(
                    form::Answer::decode(&parse_json(r#"{"q0":"Careful"}"#).unwrap()).unwrap(),
                ),
                confidence: Some(0.9),
                gate: Gate {
                    validate: Arc::new(|_| Box::pin(async { true })),
                    current: Arc::new(|| true),
                },
            },
        )
        .await
        .unwrap();
    assert!(settled.settled);
    evaluator.release.notify_one();
    let result = tokio::time::timeout(BOUND, task).await.unwrap().unwrap();
    let out = output(&result);
    assert_contract(out);
    assert_eq!(
        get(out, "answers"),
        &parse_json(r#"[["Careful"]]"#).unwrap()
    );
    assert_eq!(get(get(out, "source"), "kind"), &string("coordinator"));
    assert_eq!(get(get(out, "source"), "via"), &string("coordination"));
    assert_eq!(
        get(get(out, "source"), "confidence"),
        &JsonValue::Number(0.9)
    );
    assert!(find(out, "automatic").is_none());
    assert!(find(out, "assessment").is_some());
    assert!(message(&result).contains("The native coordinator answered these questions"));
    rig.close();
}

fn contract() -> serde_json::Value {
    serde_json::from_str(include_str!("../src/tools/builtin/question.tool.json")).unwrap()
}

fn assert_contract(out: &JsonValue) {
    let validator = jsonschema::validator_for(&contract()["outputSchema"]).unwrap();
    let instance: serde_json::Value = serde_json::from_str(&stringify_json(out)).unwrap();
    assert!(validator.is_valid(&instance), "{instance}");
}

#[test]
fn the_advertised_contract_carries_every_canonical_field_and_rejects_unknown_ones() {
    let definition = contract();
    let properties = definition["outputSchema"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        properties,
        BTreeSet::from([
            "answers",
            "automatic",
            "via",
            "confidence",
            "assessment",
            "source",
            "timedOutAfterSeconds",
            "deferredItemID",
            "reviewFull",
        ])
    );
    let output = jsonschema::validator_for(&definition["outputSchema"]).unwrap();
    let coordinated = serde_json::json!({"answers":[["Careful"]],"source":{"kind":"coordinator","coordinatorSessionID":"ses_coordinator","via":"coordination","confidence":0.9,"rationale":"Fits the scope."}});
    assert!(output.is_valid(&coordinated), "{coordinated}");
    assert!(!output.is_valid(&serde_json::json!({"answers":[[]],"unexpected":true})));
    assert!(!output.is_valid(&serde_json::json!({"answers":[[]],"via":"coordination"})));
    assert!(!output.is_valid(&serde_json::json!({"answers":[[]],"confidence":1.5})));
    let input = jsonschema::validator_for(&definition["inputSchema"]).unwrap();
    let prompt = |extra: serde_json::Value| {
        let mut prompt = serde_json::json!({"question":"Which plan?","header":"Plan","options":[]});
        prompt
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::json!({"questions":[prompt]})
    };
    assert!(input.is_valid(&prompt(serde_json::json!({"custom":false}))));
    assert!(!input.is_valid(&prompt(serde_json::json!({"custom":"no"}))));
    assert!(!input.is_valid(&prompt(serde_json::json!({"unexpected":true}))));
}

#[tokio::test]
async fn a_prompt_with_custom_disabled_creates_a_field_that_forbids_typed_answers() {
    let rig = Rig::new(None, modes::yolo(false), false).await;
    let registry = rig.registry.clone();
    let context = rig.fixture.context();
    let task = tokio::spawn(async move {
        registry
            .materialize(&[])
            .invoke(
                "question",
                parse_json(r#"{"questions":[{"header":"Plan","question":"Which plan?","custom":false,"options":[{"label":"Fast","description":"Ship now"}]}]}"#).unwrap(),
                context,
            )
            .await
            .unwrap()
    });
    let pending = rig.pending().await;
    let rejected = rig.forms.reply(
        &pending.id,
        form::Answer::decode(&parse_json(r#"{"q0":"Something else"}"#).unwrap()).unwrap(),
    );
    assert!(rejected.is_err());
    rig.forms
        .reply(
            &pending.id,
            form::Answer::decode(&parse_json(r#"{"q0":"Fast"}"#).unwrap()).unwrap(),
        )
        .unwrap();
    let result = tokio::time::timeout(BOUND, task).await.unwrap().unwrap();
    assert_contract(output(&result));
    rig.close();
}
