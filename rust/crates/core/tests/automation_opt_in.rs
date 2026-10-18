include!("policy_fixture.rs");

#[path = "autonomy_support/mod.rs"]
mod support;

use std::sync::{Arc, Mutex, OnceLock};
use ycoding_core::{
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    session::{
        autonomy::{self, Error as AutonomyError, Goal, Service as Autonomy, YoloLevel},
        orchestration::{Execution, LaunchInput, Prepared, Service as Orchestration},
        review::{self, ChildAnswer, Delivery, DeliveryFuture, RecoveryResolution},
        run_coordinator::{Outcome, RunFuture},
        store,
        usage_attribution::Attribution,
    },
    tools::policy::{
        Authority, Publisher, Reviews,
        forms::Forms,
        permissions::Permissions,
        questions::{Admission, Questions},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, form, model, parse_json, permission, question,
    session, session_message,
    session_orchestration::State,
    session_review::{Kind, Reason},
};
use ycoding_store::{KeyPart, Store, session::SessionTable, tuple_key};

const ACTIVE_GOAL: &str = r#"{"text":"Finish safely","rawText":"Finish safely","iteration":0,"noProgress":0,"maxNoProgress":3,"status":"active"}"#;

fn request(id: &str, session: &str) -> question::Request {
    question::Request::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":"{session}","questions":[{{"question":"Which?","header":"Choice","options":[]}}]}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

fn input(id: &str, session: &str) -> form::Info {
    form::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":"{session}","title":"Confirm","fields":[{{"key":"ack","type":"external","url":"https://example.test/setup"}}]}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

fn question_answered(service: &Questions, id: &str, session: &str) -> bool {
    let asked = request(id, session);
    match service.ask(asked.clone()).unwrap() {
        Admission::Answered(answers) => {
            assert_eq!(
                answers,
                vec![vec![LosslessString::from(autonomy::AUTOMATIC_ANSWER)]]
            );
            true
        }
        Admission::Pending(wait) => {
            assert!(service.list().iter().any(|pending| pending.id == asked.id));
            drop(wait);
            false
        }
    }
}

fn form_answered(service: &Forms, id: &str, session: &str) -> bool {
    let form = input(id, session);
    let wait = service.ask(form.clone()).unwrap();
    let state = service.state(&form.id).unwrap();
    drop(wait);
    match state {
        form::State::Answered(_) => true,
        form::State::Pending => false,
        other => panic!("unexpected form state {other:?}"),
    }
}

fn published(fixture: &Fixture, type_: &str) -> usize {
    fixture
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.type_ == type_)
        .count()
}

fn stored(store: &Store, session: &str) -> ycoding_store::session::Session {
    store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&session.into())]))
        .unwrap()
        .unwrap()
}

fn put_autonomy(store: &Store, session: &str, autonomy: &str) {
    let session = LosslessString::from(session);
    let autonomy = parse_json(autonomy).unwrap();
    store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&session)]))?
                .unwrap();
            row.autonomy = Some(autonomy);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn field(value: &Option<JsonValue>, key: &str) -> Option<JsonValue> {
    match value {
        Some(JsonValue::Object(object)) => object.get(&key.into()).cloned(),
        _ => None,
    }
}

#[test]
fn questions_and_forms_answer_only_with_the_asking_sessions_own_toggle() {
    let fixture = Fixture::default();
    let questions = Questions::new(fixture.authority(), fixture.publisher());
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    let goal_off = format!(r#"{{"mode":"normal","yolo":0,"goal":{ACTIVE_GOAL}}}"#);
    let goal_on = format!(r#"{{"mode":"normal","yolo":0,"autoAnswer":true,"goal":{ACTIVE_GOAL}}}"#);
    for (session, autonomy, automatic) in [
        ("ses_manual", r#"{"mode":"normal","yolo":0}"#, false),
        (
            "ses_reviews_off",
            r#"{"mode":"normal","yolo":2,"autoAnswer":false}"#,
            false,
        ),
        ("ses_goal_off", goal_off.as_str(), false),
        (
            "ses_manual_on",
            r#"{"mode":"normal","yolo":0,"autoAnswer":true}"#,
            true,
        ),
        (
            "ses_tools_on",
            r#"{"mode":"normal","yolo":1,"autoAnswer":true}"#,
            true,
        ),
        ("ses_goal_on", goal_on.as_str(), true),
    ] {
        fixture.session(session, None, 0, false, None);
        put_autonomy(&fixture.store, session, autonomy);
        assert_eq!(
            question_answered(&questions, &format!("que_{session}"), session),
            automatic,
            "{session}"
        );
        assert_eq!(
            form_answered(&forms, &format!("frm_{session}"), session),
            automatic,
            "{session}"
        );
    }
    assert_eq!(published(&fixture, "question.asked"), 3);
    assert_eq!(published(&fixture, "form.replied"), 3);
}

#[test]
fn the_toggle_is_never_inherited_by_children_or_parents() {
    let fixture = Fixture::default();
    let questions = Questions::new(fixture.authority(), fixture.publisher());
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    fixture.session("ses_parent", None, 0, false, None);
    fixture.session("ses_child", Some("ses_parent"), 0, false, None);
    put_autonomy(
        &fixture.store,
        "ses_parent",
        r#"{"mode":"normal","yolo":2,"autoAnswer":true}"#,
    );
    put_autonomy(&fixture.store, "ses_child", r#"{"mode":"normal","yolo":2}"#);
    assert!(question_answered(&questions, "que_parent", "ses_parent"));
    assert!(!question_answered(&questions, "que_child", "ses_child"));
    assert!(!form_answered(&forms, "frm_child", "ses_child"));

    put_autonomy(
        &fixture.store,
        "ses_parent",
        r#"{"mode":"normal","yolo":2,"autoAnswer":false}"#,
    );
    put_autonomy(
        &fixture.store,
        "ses_child",
        r#"{"mode":"normal","yolo":0,"autoAnswer":true}"#,
    );
    assert!(question_answered(&questions, "que_child_on", "ses_child"));
    assert!(form_answered(&forms, "frm_child_on", "ses_child"));
    assert!(!question_answered(
        &questions,
        "que_parent_off",
        "ses_parent"
    ));
}

#[tokio::test]
async fn each_ask_reads_the_current_toggle() {
    let fixture = Fixture::default();
    let questions = Questions::new(fixture.authority(), fixture.publisher());
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    fixture.session("ses_live", None, 2, true, None);
    let autonomy = Autonomy::new(fixture.store.client());
    let live = session::Id::new("ses_live").unwrap();
    assert!(!question_answered(&questions, "que_before", "ses_live"));
    autonomy.set_auto_answer(&live, true).await.unwrap();
    assert!(question_answered(&questions, "que_enabled", "ses_live"));
    assert!(form_answered(&forms, "frm_enabled", "ses_live"));
    autonomy.set_auto_answer(&live, false).await.unwrap();
    assert!(!question_answered(&questions, "que_disabled", "ses_live"));
    assert!(!form_answered(&forms, "frm_disabled", "ses_live"));
}

#[test]
fn a_sleeping_family_never_answers_with_the_deterministic_default() {
    let fixture = Fixture::default();
    let questions = Questions::new(fixture.authority(), fixture.publisher());
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    fixture.session("ses_root", None, 0, false, None);
    fixture.session("ses_member", Some("ses_root"), 0, false, None);
    put_autonomy(
        &fixture.store,
        "ses_root",
        r#"{"mode":"normal","yolo":2,"autoAnswer":true,"sleep":{}}"#,
    );
    put_autonomy(
        &fixture.store,
        "ses_member",
        r#"{"mode":"normal","yolo":0,"autoAnswer":true}"#,
    );
    for session in ["ses_root", "ses_member"] {
        assert!(
            !question_answered(&questions, &format!("que_asleep_{session}"), session),
            "{session}"
        );
        assert!(
            !form_answered(&forms, &format!("frm_asleep_{session}"), session),
            "{session}"
        );
    }
    put_autonomy(
        &fixture.store,
        "ses_root",
        r#"{"mode":"normal","yolo":2,"autoAnswer":true}"#,
    );
    for session in ["ses_root", "ses_member"] {
        assert!(
            question_answered(&questions, &format!("que_awake_{session}"), session),
            "{session}"
        );
        assert!(
            form_answered(&forms, &format!("frm_awake_{session}"), session),
            "{session}"
        );
    }
}

#[tokio::test]
async fn setting_the_toggle_stores_only_the_toggle_and_bumps_the_revision_once() {
    let store = support::store();
    put_autonomy(
        &store,
        "ses_one",
        &format!(r#"{{"mode":"normal","yolo":2,"sleep":{{}},"goal":{ACTIVE_GOAL}}}"#),
    );
    let autonomy = Autonomy::new(store.client());
    let before = stored(&store, "ses_one");

    let enabled = autonomy
        .set_auto_answer(&id("ses_one"), true)
        .await
        .unwrap();
    assert_eq!(enabled.auto_answer, Some(true));
    assert_eq!(enabled.yolo, YoloLevel::GUARDRAILS);
    assert!(enabled.sleep);
    assert!(enabled.goal.as_ref().is_some_and(Goal::is_active));
    let after = stored(&store, "ses_one");
    assert_eq!(after.autonomy_revision, before.autonomy_revision + 1);
    assert_eq!(
        field(&after.autonomy, "autoAnswer"),
        Some(JsonValue::Bool(true))
    );
    assert_eq!(field(&after.autonomy, "yolo"), Some(JsonValue::Number(2.0)));
    assert_eq!(
        autonomy::State::read(after.autonomy.as_ref()).goal,
        autonomy::State::read(before.autonomy.as_ref()).goal
    );
    assert_eq!(
        field(&after.autonomy, "sleep"),
        field(&before.autonomy, "sleep")
    );
    assert!(autonomy.can_auto_answer(&id("ses_one")).unwrap());

    autonomy
        .set_auto_answer(&id("ses_one"), true)
        .await
        .unwrap();
    assert_eq!(
        stored(&store, "ses_one").autonomy_revision,
        after.autonomy_revision
    );

    let disabled = autonomy
        .set_auto_answer(&id("ses_one"), false)
        .await
        .unwrap();
    assert_eq!(disabled.auto_answer, Some(false));
    let off = stored(&store, "ses_one");
    assert_eq!(off.autonomy_revision, after.autonomy_revision + 1);
    assert_eq!(
        field(&off.autonomy, "autoAnswer"),
        Some(JsonValue::Bool(false))
    );
    assert!(!autonomy.can_auto_answer(&id("ses_one")).unwrap());

    assert!(matches!(
        autonomy.set_auto_answer(&id("ses_missing"), true).await,
        Err(AutonomyError::NotFound(_))
    ));
    assert!(matches!(
        autonomy.can_auto_answer(&id("ses_missing")),
        Err(AutonomyError::NotFound(_))
    ));
}

#[derive(Default)]
struct Recorder(Mutex<Vec<String>>);

impl Execution for Recorder {
    fn resume(&self, _: &session::Id) -> RunFuture {
        panic!("unexpected explicit resumption")
    }

    fn wake(&self, id: &session::Id) -> Outcome {
        self.0
            .lock()
            .unwrap()
            .push(id.as_lossless().as_str().unwrap().into());
        Ok(())
    }
    fn interrupt(&self, _id: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Default)]
struct Bridge(OnceLock<Orchestration>);

impl Delivery for Bridge {
    fn wake(&self, _: &session::Id) {}
    fn answer_child<'a>(&'a self, answer: ChildAnswer) -> DeliveryFuture<'a> {
        Box::pin(self.0.get().unwrap().answer_review(answer))
    }
    fn resolve_recovery<'a>(&'a self, resolution: RecoveryResolution) -> DeliveryFuture<'a> {
        Box::pin(self.0.get().unwrap().resolve_recovery(resolution))
    }
}

struct Family {
    store: ycoding_store::Store,
    service: Orchestration,
    reviews: review::Service,
}

impl Family {
    fn new() -> Self {
        let store = support::store();
        let sessions = store::Service::new(store.client());
        let bridge = Arc::new(Bridge::default());
        let reviews = review::Service::new(sessions.clone(), bridge.clone());
        let service =
            Orchestration::new(sessions, Arc::new(Recorder::default())).with_reviews(Reviews {
                service: reviews.clone(),
                limit: Limits::default().reviews as usize,
            });
        assert!(bridge.0.set(service.clone()).is_ok());
        Self {
            store,
            service,
            reviews,
        }
    }

    async fn child(&self, call: &str) -> session::Id {
        let authority = Authority {
            store: self.store.client(),
            agents: Arc::new(|agent| {
                Some((agent.cloned().unwrap_or_else(|| "build".into()), Vec::new()))
            }),
        };
        let publisher: Publisher = Arc::new(|_| Ok(()));
        let guardrails = Guardrails::new(
            authority.clone(),
            Permissions::new(
                authority,
                ycoding_schema::project_id::ProjectId::new("prj_one").unwrap(),
                publisher.clone(),
            ),
            Settings {
                paths: Paths {
                    workdir: "/project".into(),
                    project: "/project".into(),
                    home: "/home/operator".into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom: Arc::new(Vec::new),
                enabled: true,
                limits: Limits {
                    subagents: 8,
                    ..Limits::default()
                },
                decide_reviews: false,
                decide_hard_reviews: true,
            },
            publisher,
        );
        self.service
            .launch(LaunchInput {
                parent_id: id("ses_one"),
                parent_assistant_message_id: session_message::Id::new("msg_parent").unwrap(),
                tool_call_id: call.into(),
                description: "Explore".into(),
                prompt: "Look around".into(),
                depth_limit: 1,
                prepared: Prepared {
                    agent: "explore".into(),
                    caller_permissions: permission::Ruleset::decode(&parse_json("[]").unwrap())
                        .unwrap(),
                    model: model::Ref::decode(
                        &parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
                    )
                    .unwrap(),
                    profile_binding: None,
                },
                guardrails,
            })
            .await
            .unwrap()
            .session_id
    }

    async fn asked(&self, child: &session::Id) -> bool {
        let asked = self
            .service
            .question_attributed(child, "Which cache?", None, &Attribution::Unset)
            .await
            .unwrap();
        let state = self.service.get(&id("ses_one"), child).unwrap().state;
        assert_eq!(
            state,
            if asked.auto_answered {
                State::Running
            } else {
                State::Waiting
            }
        );
        asked.auto_answered
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

#[tokio::test]
async fn a_childs_effective_policy_inherits_levels_but_answers_only_with_its_own_toggle() {
    let family = Family::new();
    let autonomy = Autonomy::new(family.store.client());
    autonomy
        .set_yolo(&id("ses_one"), YoloLevel::GUARDRAILS)
        .await
        .unwrap();
    autonomy
        .set_auto_answer(&id("ses_one"), true)
        .await
        .unwrap();
    let child = family.child("call_inherit").await;

    let effective = autonomy.effective(&child).unwrap();
    assert!(effective.can_auto_permission());
    assert!(effective.can_auto_guardrail());
    assert!(!effective.can_auto_answer());
    assert!(!autonomy.can_auto_answer(&child).unwrap());
    assert!(autonomy.can_auto_answer(&id("ses_one")).unwrap());
    assert!(!family.asked(&child).await);

    autonomy
        .set_auto_answer(&id("ses_one"), false)
        .await
        .unwrap();
    let own = family.child("call_own").await;
    autonomy.set_auto_answer(&own, true).await.unwrap();
    assert!(autonomy.effective(&own).unwrap().can_auto_answer());
    assert!(!autonomy.can_auto_answer(&id("ses_one")).unwrap());
    assert!(family.asked(&own).await);
}

#[tokio::test]
async fn subagent_questions_answer_only_with_the_childs_toggle_regardless_of_level_or_goal() {
    let family = Family::new();
    let autonomy = Autonomy::new(family.store.client());
    autonomy
        .set_goal(&id("ses_one"), Goal::new("Finish", None, None))
        .await
        .unwrap();
    autonomy
        .set_yolo(&id("ses_one"), YoloLevel::GUARDRAILS)
        .await
        .unwrap();
    let off = family.child("call_goal_off").await;
    assert!(!family.asked(&off).await);

    let manual = Family::new();
    let on = manual.child("call_manual_on").await;
    Autonomy::new(manual.store.client())
        .set_auto_answer(&on, true)
        .await
        .unwrap();
    assert!(manual.asked(&on).await);
    let unset = manual.child("call_unset").await;
    assert!(
        !manual
            .service
            .question(&unset, "Which?", None)
            .await
            .unwrap()
            .auto_answered
    );
}

#[tokio::test]
async fn a_sleeping_family_child_question_waits_and_the_toggle_reads_live() {
    let family = Family::new();
    let autonomy = Autonomy::new(family.store.client());
    let child = family.child("call_asleep").await;
    autonomy.set_auto_answer(&child, true).await.unwrap();
    put_autonomy(
        &family.store,
        "ses_one",
        r#"{"mode":"normal","yolo":0,"sleep":{}}"#,
    );
    assert!(autonomy.effective(&child).unwrap().asleep);
    assert!(autonomy.can_auto_answer(&child).unwrap());
    assert!(!family.asked(&child).await);
    let deferred = family
        .reviews
        .list(&id("ses_one"))
        .unwrap()
        .into_iter()
        .filter(|item| item.session_id.as_lossless() == child.as_lossless())
        .collect::<Vec<_>>();
    assert_eq!(deferred.len(), 1);
    assert_eq!(deferred[0].deferral.kind, Kind::SubagentQuestion);
    assert_eq!(deferred[0].deferral.reason, Reason::FreeText);
    assert_eq!(deferred[0].deferral.choice, None);

    autonomy.set_auto_answer(&child, false).await.unwrap();
    assert!(!autonomy.can_auto_answer(&child).unwrap());
    autonomy.set_auto_answer(&child, true).await.unwrap();
    assert!(autonomy.can_auto_answer(&child).unwrap());
    assert_eq!(
        field(
            &stored(&family.store, child.as_lossless().as_str().unwrap()).autonomy,
            "sleep"
        ),
        None,
        "the child row never stores the family marker"
    );
}
