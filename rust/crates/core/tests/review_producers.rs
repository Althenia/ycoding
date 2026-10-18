include!("policy_fixture.rs");
use std::sync::{Arc, Mutex};
use ycoding_core::{
    process::guardrails::{self, Guardrails, Input, Limits, Paths, ReviewPolicy, Settings},
    session::{
        autonomy,
        review::{
            ChildAnswer, DecideInput, Delivery, DeliveryError, DeliveryFuture, FingerprintInput,
            RecoveryResolution, Service as ReviewService, fingerprint, prompt_id,
        },
        store,
    },
    tools::policy::{
        Effect, Reviews,
        forms::Forms,
        permissions::{self, Permissions},
        questions::{self, Admission, Questions},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, form, parse_json, permission, question, session,
    session_id::SessionId,
    session_review::{Decision, Item, Kind, Payload, Reason},
};
use ycoding_store::{KeyPart, session::PendingTable, tuple_key};

const WORKDIR: &str = "/workspace/project";

#[derive(Default)]
struct Woken(Mutex<Vec<session::Id>>);

impl Delivery for Woken {
    fn wake(&self, session_id: &session::Id) {
        self.0.lock().unwrap().push(session_id.clone());
    }
    fn answer_child<'a>(&'a self, _: ChildAnswer) -> DeliveryFuture<'a> {
        Box::pin(async { Err(DeliveryError::Conflict("no child in this fixture".into())) })
    }
    fn resolve_recovery<'a>(&'a self, _: RecoveryResolution) -> DeliveryFuture<'a> {
        Box::pin(async {
            Err(DeliveryError::Conflict(
                "no recovery in this fixture".into(),
            ))
        })
    }
}

struct Harness {
    fixture: Fixture,
    reviews: ReviewService,
    autonomy: autonomy::Service,
}

fn harness() -> Harness {
    let fixture = Fixture::default();
    let client = fixture.store.client();
    Harness {
        reviews: ReviewService::new(
            store::Service::new(client.clone()),
            Arc::new(Woken::default()),
        ),
        autonomy: autonomy::Service::new(client),
        fixture,
    }
}

impl Harness {
    fn reviews(&self, limit: usize) -> Reviews {
        Reviews {
            service: self.reviews.clone(),
            limit,
        }
    }
    fn questions(&self, limit: usize) -> Questions {
        Questions::new(self.fixture.authority(), self.fixture.publisher())
            .with_reviews(self.reviews(limit))
    }
    fn forms(&self, limit: usize) -> Forms {
        Forms::new(self.fixture.authority(), self.fixture.publisher())
            .with_reviews(self.reviews(limit))
    }
    fn permissions(&self, limit: usize) -> Permissions {
        self.fixture
            .permissions()
            .with_reviews(self.reviews(limit), WORKDIR.into())
    }
    fn guardrails(&self, limit: usize, decide_reviews: bool) -> Guardrails {
        Guardrails::new(
            self.fixture.authority(),
            self.fixture.permissions(),
            settings(decide_reviews),
            self.fixture.publisher(),
        )
        .with_reviews(self.reviews(limit))
    }
    fn events(&self, kind: &str) -> Vec<JsonValue> {
        self.fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.type_ == kind)
            .map(|event| event.data.clone())
            .collect()
    }
    fn items(&self, session: &SessionId) -> Vec<Item> {
        self.reviews.list(session).unwrap()
    }
    async fn decide(&self, session: &SessionId, item: &Item, decision: &str) {
        self.reviews
            .decide(DecideInput {
                session_id: session.clone(),
                item_id: item.deferral.item_id.clone(),
                decision: Decision::decode(&parse_json(decision).unwrap()).unwrap(),
                now: 20,
            })
            .await
            .unwrap();
    }
}

fn settings(decide_reviews: bool) -> Settings {
    Settings {
        paths: Paths {
            workdir: WORKDIR.into(),
            project: WORKDIR.into(),
            home: "/home/operator".into(),
            tmpdir: None,
            trusted_paths: vec![],
        },
        global_roots: vec!["/home/operator/.config/ycoding".into()],
        custom: Arc::new(Vec::new),
        enabled: true,
        limits: Limits::default(),
        decide_reviews,
        decide_hard_reviews: true,
    }
}

fn question(session: &SessionId, id: &str, options: &str) -> question::Request {
    question::Request::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":"{}","questions":[{{"header":"Plan","question":"Which plan?","options":{options}}}]}}"#,
            text(session.as_lossless())
        ))
        .unwrap(),
    )
    .unwrap()
}

fn form(session: &SessionId, id: &str) -> form::Info {
    form::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":"{}","title":"Evidence","fields":[{{"key":"text","type":"string","required":true,"default":"Suggested"}}]}}"#,
            text(session.as_lossless())
        ))
        .unwrap(),
    )
    .unwrap()
}

fn request(session: &SessionId, id: &str, resource: &str) -> permission::Request {
    permission::Request {
        id: permission::Id::new(id).unwrap(),
        session_id: session.clone(),
        action: "edit".into(),
        resources: vec![resource.into()],
        save: Some(vec![resource.into()]),
        metadata: None,
        source: None,
    }
}

fn shell(session: &SessionId, command: &str) -> Input {
    Input {
        session_id: session.clone(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: None,
        skip_review: false,
        holder: None,
        source: None,
    }
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap()
}

fn field(value: &JsonValue, key: &str) -> Option<JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()).cloned(),
        _ => None,
    }
}

fn admitted(harness: &Harness, item: &Item) -> bool {
    harness
        .fixture
        .store
        .snapshot()
        .unwrap()
        .get::<PendingTable>(&tuple_key(&[KeyPart::String(
            prompt_id(&item.deferral.item_id).as_lossless(),
        )]))
        .unwrap()
        .is_some()
}

async fn asleep(harness: &Harness, session: &SessionId) {
    harness.autonomy.set_sleep(session, true).await.unwrap();
}

#[tokio::test]
async fn a_sleeping_question_without_auto_answer_defers_disabled_and_a_human_answer_is_admitted() {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 2, false, None);
    let child = harness
        .fixture
        .session("ses_child", Some("ses_root"), 0, false, None);
    asleep(&harness, &root).await;
    let questions = harness.questions(16);
    let Admission::Pending(wait) = questions
        .ask(question(
            &child,
            "que_disabled",
            r#"[{"label":"A","description":"First"}]"#,
        ))
        .unwrap()
    else {
        panic!("a sleeping family must not answer without auto-answer");
    };
    let deferred = wait.await.unwrap().unwrap_err();
    let questions::Error::Deferred { item_id } = deferred else {
        panic!("expected a deferred question, got {deferred:?}");
    };
    assert!(questions.list().is_empty());
    let items = harness.items(&root);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].deferral.item_id, item_id);
    assert_eq!(
        (items[0].deferral.kind, items[0].deferral.reason),
        (Kind::Question, Reason::Disabled)
    );
    assert_eq!(text(items[0].session_id.as_lossless()), "ses_child");
    assert!(matches!(items[0].deferral.payload, Payload::Question(_)));
    let event = harness.events("question.deferred");
    assert_eq!(event.len(), 1);
    assert_eq!(
        field(&event[0], "itemID"),
        Some(JsonValue::String(item_id.as_lossless().clone()))
    );
    harness
        .decide(&root, &items[0], r#"{"kind":"question","answers":[["A"]]}"#)
        .await;
    assert!(admitted(&harness, &items[0]));
    assert!(harness.autonomy.get(&root).unwrap().is_asleep());
}

#[tokio::test]
async fn a_sleeping_free_text_question_defers_even_with_auto_answer_on() {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let Admission::Pending(wait) = harness
        .questions(16)
        .ask(question(&root, "que_free", "[]"))
        .unwrap()
    else {
        panic!("free text must not be answered automatically while asleep");
    };
    assert!(matches!(
        wait.await.unwrap(),
        Err(questions::Error::Deferred { .. })
    ));
    assert_eq!(harness.items(&root)[0].deferral.reason, Reason::FreeText);
}

#[tokio::test]
async fn an_awake_question_waits_for_the_human_without_a_review_item() {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    let questions = harness.questions(16);
    let Admission::Pending(_wait) = questions.ask(question(&root, "que_awake", "[]")).unwrap()
    else {
        panic!("an awake question without auto-answer waits");
    };
    assert_eq!(questions.list().len(), 1);
    assert!(harness.items(&root).is_empty());
    assert!(harness.events("question.deferred").is_empty());
}

#[tokio::test]
async fn a_full_review_box_reports_the_limit_without_recording_a_question() {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    asleep(&harness, &root).await;
    let questions = harness.questions(1);
    let Admission::Pending(first) = questions.ask(question(&root, "que_first", "[]")).unwrap()
    else {
        panic!("expected deferral")
    };
    assert!(matches!(
        first.await.unwrap(),
        Err(questions::Error::Deferred { .. })
    ));
    let Admission::Pending(second) = questions.ask(question(&root, "que_second", "[]")).unwrap()
    else {
        panic!("expected deferral attempt")
    };
    assert!(matches!(
        second.await.unwrap(),
        Err(questions::Error::ReviewFull { limit: 1 })
    ));
    assert_eq!(harness.items(&root).len(), 1);
    assert_eq!(harness.events("question.deferred").len(), 1);
}

#[tokio::test]
async fn a_sleeping_required_free_text_form_defers_despite_a_suggested_default() {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let forms = harness.forms(16);
    let state = forms
        .ask(form(&root, "frm_default"))
        .unwrap()
        .await
        .unwrap();
    let form::State::Deferred { item_id } = state else {
        panic!("expected a deferred form, got {state:?}");
    };
    let items = harness.items(&root);
    assert_eq!(items[0].deferral.item_id, item_id);
    assert_eq!(items[0].deferral.reason, Reason::FreeText);
    assert!(forms.list(None).is_empty());
    assert_eq!(harness.events("form.deferred").len(), 1);
}

#[tokio::test]
async fn a_sleeping_permission_ask_defers_and_a_once_grant_admits_one_identical_reissue() {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    asleep(&harness, &root).await;
    let permissions = harness.permissions(16);
    let error = permissions
        .assert(request(&root, "per_first", "outside.txt"), None)
        .await
        .unwrap_err();
    let permissions::Error::Deferred { item_id } = error else {
        panic!("expected deferral, got {error:?}");
    };
    assert!(permissions.list().is_empty());
    let item = harness.items(&root).remove(0);
    assert_eq!(item.deferral.item_id, item_id);
    let Payload::Permission(payload) = &item.deferral.payload else {
        panic!("expected a permission payload");
    };
    assert_eq!(
        payload.fingerprint,
        fingerprint(&FingerprintInput {
            action: "edit".into(),
            resources: vec!["outside.txt".into()],
            workdir: WORKDIR.into(),
            rule_ids: vec![],
            hard_review: false,
            metadata: None,
        })
    );
    assert_eq!(harness.events("permission.deferred").len(), 1);
    harness
        .decide(&root, &item, r#"{"kind":"permission","reply":"once"}"#)
        .await;
    assert!(matches!(
        permissions
            .assert(request(&root, "per_changed", "other.txt"), None)
            .await,
        Err(permissions::Error::Deferred { .. })
    ));
    permissions
        .assert(request(&root, "per_again", "outside.txt"), None)
        .await
        .unwrap();
    assert!(matches!(
        permissions
            .assert(request(&root, "per_third", "outside.txt"), None)
            .await,
        Err(permissions::Error::Deferred { .. })
    ));
}

#[tokio::test]
async fn permission_auto_approval_and_awake_asks_do_not_defer() {
    let harness = harness();
    let automatic = harness.fixture.session("ses_auto", None, 1, false, None);
    let awake = harness.fixture.session("ses_awake", None, 0, false, None);
    asleep(&harness, &automatic).await;
    let permissions = harness.permissions(16);
    permissions
        .assert(request(&automatic, "per_auto", "outside.txt"), None)
        .await
        .unwrap();
    let admission = permissions
        .ask(request(&awake, "per_awake", "outside.txt"), None)
        .unwrap();
    assert_eq!(admission.effect, Effect::Ask);
    assert_eq!(permissions.list().len(), 1);
    assert!(harness.items(&automatic).is_empty() && harness.items(&awake).is_empty());
}

#[tokio::test]
async fn a_sleeping_guardrail_review_defers_redacted_and_grants_one_identical_reissue() {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 2, false, None);
    asleep(&harness, &root).await;
    let guardrails = harness.guardrails(16, false);
    let command = "TOKEN=synthetic-secret git reset --hard";
    let admission = guardrails.assert(shell(&root, command)).unwrap();
    assert!(admission.request.is_some());
    let error = admission
        .wait
        .unwrap()
        .await
        .unwrap()
        .err()
        .expect("a sleeping review must defer");
    let guardrails::Error::Deferred { item_id, .. } = error else {
        panic!("expected deferral, got {error:?}");
    };
    let item = harness.items(&root).remove(0);
    assert_eq!(item.deferral.item_id, item_id);
    assert_eq!(
        (item.deferral.kind, item.deferral.reason),
        (Kind::Guardrail, Reason::Disabled)
    );
    let Payload::Guardrail(payload) = &item.deferral.payload else {
        panic!("expected a guardrail payload");
    };
    assert!(payload.hard_review);
    assert_eq!(
        payload.resources,
        vec![LosslessString::from("TOKEN=[redacted] git reset --hard")]
    );
    assert!(!format!("{:?}", harness.items(&root)).contains("synthetic-secret"));
    assert_eq!(
        payload.fingerprint,
        fingerprint(&FingerprintInput {
            action: "shell".into(),
            resources: vec![command.into()],
            workdir: WORKDIR.into(),
            rule_ids: payload.rule_ids.clone(),
            hard_review: true,
            metadata: None,
        })
    );
    assert!(guardrails.for_session(&root).unwrap().is_empty());
    assert_eq!(harness.events("guardrail.deferred").len(), 1);
    assert!(
        harness
            .reviews
            .decide(DecideInput {
                session_id: root.clone(),
                item_id: item.deferral.item_id.clone(),
                decision: Decision::decode(
                    &parse_json(r#"{"kind":"guardrail","reply":"always"}"#).unwrap()
                )
                .unwrap(),
                now: 20,
            })
            .await
            .is_err()
    );
    harness
        .decide(&root, &item, r#"{"kind":"guardrail","reply":"once"}"#)
        .await;
    let granted = guardrails.assert(shell(&root, command)).unwrap();
    assert_eq!(granted.effect, Effect::Allow);
    granted.reservation.unwrap().release();
    let again = guardrails.assert(shell(&root, command)).unwrap();
    assert!(matches!(
        again.wait.unwrap().await.unwrap(),
        Err(guardrails::Error::Deferred { .. })
    ));
    assert!(guardrails.assert(shell(&root, "rm -rf /")).is_err());
    assert_eq!(harness.items(&root).len(), 1);
}

#[tokio::test]
async fn awake_guardrail_reviews_still_reach_the_human_and_yolo_two_skips_only_awake_ordinary_reviews()
 {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    let automatic = harness
        .fixture
        .session("ses_automatic", None, 2, false, None);
    let guardrails = harness.guardrails(16, false);
    let admission = guardrails.assert(shell(&root, "git reset --hard")).unwrap();
    assert_eq!(admission.effect, Effect::Ask);
    assert_eq!(guardrails.for_session(&root).unwrap().len(), 1);
    let ordinary = "touch /outside/review-note";
    let approved = guardrails.assert(shell(&automatic, ordinary)).unwrap();
    assert_eq!(approved.effect, Effect::Allow);
    approved.reservation.unwrap().release();
    asleep(&harness, &automatic).await;
    let sleeping = guardrails.assert(shell(&automatic, ordinary)).unwrap();
    assert!(matches!(
        sleeping.wait.unwrap().await.unwrap(),
        Err(guardrails::Error::Deferred { .. })
    ));
    assert!(harness.items(&root).is_empty());
    assert_eq!(harness.items(&automatic).len(), 1);
}

#[tokio::test]
async fn a_full_review_box_declines_a_sleeping_guardrail_review_without_recording_it() {
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    asleep(&harness, &root).await;
    let guardrails = harness.guardrails(1, false);
    let first = guardrails.assert(shell(&root, "git reset --hard")).unwrap();
    assert!(matches!(
        first.wait.unwrap().await.unwrap(),
        Err(guardrails::Error::Deferred { .. })
    ));
    let second = guardrails.assert(shell(&root, "git clean -fdx")).unwrap();
    assert!(matches!(
        second.wait.unwrap().await.unwrap(),
        Err(guardrails::Error::ReviewFull { limit: 1 })
    ));
    assert_eq!(harness.items(&root).len(), 1);
    assert!(guardrails.for_session(&root).unwrap().is_empty());
}

#[tokio::test]
async fn sleep_entry_converts_every_pending_request_beyond_the_cap_and_settles_waiters_as_deferred()
{
    let harness = harness();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    let child = harness
        .fixture
        .session("ses_child", Some("ses_root"), 0, false, None);
    let questions = harness.questions(1);
    let forms = harness.forms(1);
    let permissions = harness.permissions(1);
    let guardrails = harness.guardrails(1, false);
    let Admission::Pending(question_wait) =
        questions.ask(question(&root, "que_pending", "[]")).unwrap()
    else {
        panic!("awake question waits")
    };
    let form_wait = forms.ask(form(&child, "frm_pending")).unwrap();
    let created = forms.create(form(&root, "frm_created")).unwrap();
    let permission_wait = permissions
        .ask(request(&child, "per_pending", "outside.txt"), None)
        .unwrap()
        .wait
        .unwrap();
    let guardrail_wait = guardrails
        .assert(shell(&root, "git reset --hard"))
        .unwrap()
        .wait
        .unwrap();
    asleep(&harness, &root).await;
    assert_eq!(questions.defer_pending(&root).await.unwrap(), 1);
    assert_eq!(forms.defer_pending(&child).await.unwrap(), 1);
    assert_eq!(forms.defer_pending(&root).await.unwrap(), 0);
    assert_eq!(permissions.defer_pending(&child).await.unwrap(), 1);
    assert_eq!(guardrails.defer_pending(&root).await.unwrap(), 1);
    assert!(matches!(
        question_wait.await.unwrap(),
        Err(questions::Error::Deferred { .. })
    ));
    assert!(matches!(
        form_wait.await.unwrap(),
        form::State::Deferred { .. }
    ));
    assert!(matches!(
        permission_wait.await.unwrap(),
        Err(permissions::Error::Deferred { .. })
    ));
    assert!(matches!(
        guardrail_wait.await.unwrap(),
        Err(guardrails::Error::Deferred { .. })
    ));
    let items = harness.items(&root);
    assert_eq!(items.len(), 4);
    assert!(
        items
            .iter()
            .all(|item| item.deferral.reason == Reason::SleepEntry)
    );
    assert_eq!(
        items
            .iter()
            .map(|item| item.deferral.kind)
            .collect::<Vec<_>>(),
        [
            Kind::Question,
            Kind::Question,
            Kind::Permission,
            Kind::Guardrail
        ]
    );
    assert!(questions.list().is_empty() && permissions.list().is_empty());
    assert_eq!(
        forms
            .list(None)
            .iter()
            .map(|info| info.id.clone())
            .collect::<Vec<_>>(),
        [created.id]
    );
    assert!(guardrails.for_session(&root).unwrap().is_empty());
    assert_eq!(questions.defer_pending(&root).await.unwrap(), 0);
}

#[test]
fn the_review_policy_reports_the_configured_model_review_switches() {
    let harness = harness();
    assert_eq!(
        harness.guardrails(16, false).review_policy(),
        ReviewPolicy {
            enabled: true,
            decide_reviews: false,
            decide_hard_reviews: true,
        }
    );
    assert!(harness.guardrails(16, true).review_policy().decide_reviews);
}

#[derive(Default)]
struct HeldFormDecision {
    entered: tokio::sync::Notify,
    finish: tokio::sync::Notify,
}

impl ycoding_core::process::guardrails::decision::Evaluator for HeldFormDecision {
    fn evaluate<'a>(
        &'a self,
        _: JsonValue,
        invocation: ycoding_core::resources::decision::Invocation<'a>,
    ) -> ycoding_core::process::guardrails::decision::EvaluateFuture<'a> {
        Box::pin(async move {
            self.entered.notify_one();
            tokio::select! {
                biased;
                _ = invocation.cancellation.cancelled() => Err(ycoding_core::resources::decision::Error::Cancelled),
                _ = self.finish.notified() => Ok(parse_json(r#"{"response":{"answers":[{"name":"f0","type":"choice","answer":null,"choice":true,"score":null,"confidence":1}]}}"#).unwrap()),
            }
        })
    }
}

fn boolean_form(session: &SessionId, id: &str) -> form::Info {
    form::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":"{}","title":"Choose","fields":[{{"key":"proceed","type":"boolean","required":true}}]}}"#,
            text(session.as_lossless())
        )).unwrap(),
    ).unwrap()
}

#[tokio::test]
async fn sleeping_form_decision_is_invisible_untimed_and_respects_auto_answer_revocation() {
    let harness = harness();
    let root = harness.fixture.session("ses_hidden", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let evaluator = Arc::new(HeldFormDecision::default());
    let forms = harness
        .forms(16)
        .with_timeout_seconds(1)
        .with_decision(evaluator.clone());
    let info = boolean_form(&root, "frm_hidden");
    let wait = forms.ask(info.clone()).unwrap();
    evaluator.entered.notified().await;
    assert!(forms.has_pending());
    assert!(forms.list(None).is_empty());
    assert!(harness.events("form.created").is_empty());
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert_eq!(forms.state(&info.id).unwrap(), form::State::Pending);
    assert!(harness.events("form.timed_out").is_empty());
    harness
        .autonomy
        .set_auto_answer(&root, false)
        .await
        .unwrap();
    evaluator.finish.notify_one();
    assert!(matches!(wait.await.unwrap(), form::State::Deferred { .. }));
    assert_eq!(harness.items(&root)[0].deferral.reason, Reason::Disabled);
    assert!(!forms.has_pending());
    assert!(harness.events("form.created").is_empty());
    assert!(harness.events("form.replied").is_empty());
}

#[tokio::test]
async fn shutdown_settles_an_invisible_form_decision_without_visible_events_or_reviews() {
    let harness = harness();
    let root = harness
        .fixture
        .session("ses_shutdown", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let evaluator = Arc::new(HeldFormDecision::default());
    let forms = harness.forms(16).with_decision(evaluator.clone());
    let wait = forms.ask(boolean_form(&root, "frm_shutdown")).unwrap();
    evaluator.entered.notified().await;
    assert!(forms.shutdown().is_empty());
    assert_eq!(wait.await.unwrap(), form::State::Cancelled);
    evaluator.finish.notify_one();
    tokio::task::yield_now().await;
    assert!(forms.list(None).is_empty());
    assert!(harness.events("form.created").is_empty());
    assert!(harness.events("form.cancelled").is_empty());
    assert!(harness.events("form.replied").is_empty());
    assert!(harness.items(&root).is_empty());
}

#[tokio::test]
async fn sleeping_inference_reports_a_full_review_box_without_publishing_a_form() {
    let harness = harness();
    let root = harness
        .fixture
        .session("ses_full_inference", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let evaluator = Arc::new(HeldFormDecision::default());
    let forms = harness.forms(0).with_decision(evaluator.clone());
    let info = boolean_form(&root, "frm_full_inference");
    let wait = forms.ask(info.clone()).unwrap();
    evaluator.entered.notified().await;
    harness
        .autonomy
        .set_auto_answer(&root, false)
        .await
        .unwrap();
    evaluator.finish.notify_one();
    assert_eq!(wait.await.unwrap(), form::State::Cancelled);
    assert!(matches!(
        forms.failure(&info.id),
        Some(ycoding_core::tools::policy::forms::Error::ReviewFull { limit: 0 })
    ));
    assert!(forms.list(None).is_empty());
    assert!(harness.events("form.created").is_empty());
    assert!(harness.events("form.cancelled").is_empty());
    assert!(harness.items(&root).is_empty());
}

#[tokio::test]
async fn session_cancellation_settles_invisible_form_work_without_publishing_it() {
    let harness = harness();
    let root = harness
        .fixture
        .session("ses_session_cancel", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let evaluator = Arc::new(HeldFormDecision::default());
    let forms = harness.forms(16).with_decision(evaluator.clone());
    let wait = forms
        .ask(boolean_form(&root, "frm_session_cancel"))
        .unwrap();
    evaluator.entered.notified().await;
    assert!(forms.has_pending());
    assert!(forms.cancel_session(&root).is_empty());
    assert!(!forms.has_pending());
    assert_eq!(wait.await.unwrap(), form::State::Cancelled);
    evaluator.finish.notify_one();
    tokio::task::yield_now().await;
    assert!(forms.list(None).is_empty());
    assert!(harness.events("form.created").is_empty());
    assert!(harness.events("form.cancelled").is_empty());
    assert!(harness.events("form.replied").is_empty());
    assert!(harness.items(&root).is_empty());
}

#[derive(Default)]
struct FirstListedDecision(Mutex<Vec<JsonValue>>);
impl ycoding_core::process::guardrails::decision::Evaluator for FirstListedDecision {
    fn evaluate<'a>(
        &'a self,
        input: JsonValue,
        _: ycoding_core::resources::decision::Invocation<'a>,
    ) -> ycoding_core::process::guardrails::decision::EvaluateFuture<'a> {
        Box::pin(async move {
            self.0.lock().unwrap().push(input.clone());
            let JsonValue::Object(input) = input else {
                panic!()
            };
            let Some(JsonValue::Object(request)) = input.get(&"request".into()) else {
                panic!()
            };
            let Some(JsonValue::Array(questions)) = request.get(&"questions".into()) else {
                panic!()
            };
            let answers = questions
                .iter()
                .map(|question| {
                    let JsonValue::Object(question) = question else {
                        panic!()
                    };
                    let Some(JsonValue::Array(choices)) = question.get(&"choices".into()) else {
                        panic!()
                    };
                    let JsonValue::Object(first) = &choices[0] else {
                        panic!()
                    };
                    ycoding_schema::ObjectEncoder::new()
                        .field("name", question.get(&"name".into()).unwrap())
                        .field("type", "choice")
                        .field("answer", &JsonValue::Null)
                        .field("choice", first.get(&"value".into()).unwrap())
                        .field("score", &JsonValue::Null)
                        .field("confidence", &1.0)
                        .finish()
                })
                .collect::<Vec<_>>();
            Ok(ycoding_schema::ObjectEncoder::new()
                .field(
                    "response",
                    &ycoding_schema::ObjectEncoder::new()
                        .field("answers", &answers)
                        .finish(),
                )
                .finish())
        })
    }
}

#[tokio::test]
async fn sleeping_question_and_form_helpers_redact_evidence_and_map_choices_to_original_values() {
    let harness = harness();
    let root = harness
        .fixture
        .session("ses_redacted_choices", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let evaluator = Arc::new(FirstListedDecision::default());
    let questions = harness.questions(16).with_decision(evaluator.clone());
    let mut request = question(
        &root,
        "que_redacted",
        r#"[{"label":"TOKEN=question-choice-secret","description":"Bearer question-description-secret"},{"label":"Safe","description":"Fallback"}]"#,
    );
    request.questions[0].question = "Bearer question-evidence-secret".into();
    let Admission::Pending(wait) = questions.ask(request).unwrap() else {
        panic!()
    };
    assert_eq!(
        wait.await.unwrap().unwrap(),
        vec![vec![LosslessString::from("TOKEN=question-choice-secret")]]
    );
    let forms = harness.forms(16).with_decision(evaluator.clone());
    let info = form::Info::decode(&parse_json(&format!(r#"{{"id":"frm_redacted","sessionID":"{}","title":"Bearer form-evidence-secret","fields":[{{"key":"result","type":"string","required":true,"options":[{{"value":"TOKEN=form-choice-secret","label":"Bearer form-description-secret"}},{{"value":"safe","label":"Safe"}}]}}]}}"#, text(root.as_lossless()))).unwrap()).unwrap();
    let form::State::Answered(answer) = forms.ask(info).unwrap().await.unwrap() else {
        panic!()
    };
    assert_eq!(
        answer.0.get(&"result".into()),
        Some(&JsonValue::String("TOKEN=form-choice-secret".into()))
    );
    let calls = evaluator.0.lock().unwrap();
    assert_eq!(calls.len(), 2);
    for input in &*calls {
        let sent = ycoding_schema::stringify_json(input);
        assert!(sent.contains("[redacted]"));
        for secret in [
            "question-choice-secret",
            "question-description-secret",
            "question-evidence-secret",
            "form-choice-secret",
            "form-description-secret",
            "form-evidence-secret",
        ] {
            assert!(!sent.contains(secret), "helper received {secret}");
        }
    }
    assert!(harness.items(&root).is_empty());
}

#[tokio::test]
async fn redaction_collisions_defer_without_invoking_a_question_or_form_helper() {
    let harness = harness();
    let root = harness
        .fixture
        .session("ses_colliding_choices", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let evaluator = Arc::new(FirstListedDecision::default());
    let questions = harness.questions(16).with_decision(evaluator.clone());
    let Admission::Pending(wait) = questions.ask(question(&root, "que_collision", r#"[{"label":"TOKEN=alpha-secret","description":"First"},{"label":"TOKEN=beta-secret","description":"Second"}]"#)).unwrap() else { panic!() };
    assert!(matches!(
        wait.await.unwrap(),
        Err(questions::Error::Deferred { .. })
    ));
    let forms = harness.forms(16).with_decision(evaluator.clone());
    let info = form::Info::decode(&parse_json(&format!(r#"{{"id":"frm_collision","sessionID":"{}","title":"Choose","fields":[{{"key":"result","type":"string","required":true,"options":[{{"value":"TOKEN=alpha-secret","label":"First"}},{{"value":"TOKEN=beta-secret","label":"Second"}}]}}]}}"#, text(root.as_lossless()))).unwrap()).unwrap();
    assert!(matches!(
        forms.ask(info).unwrap().await.unwrap(),
        form::State::Deferred { .. }
    ));
    assert!(evaluator.0.lock().unwrap().is_empty());
    let items = harness.items(&root);
    assert_eq!(items.len(), 2);
    assert!(
        items
            .iter()
            .all(|item| item.deferral.reason == Reason::InvalidRequest)
    );
}

#[tokio::test]
async fn oversized_sleeping_question_evidence_never_reaches_the_helper() {
    let harness = harness();
    let root = harness
        .fixture
        .session("ses_oversized_choice", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    asleep(&harness, &root).await;
    let evaluator = Arc::new(FirstListedDecision::default());
    let questions = harness.questions(16).with_decision(evaluator.clone());
    let mut request = question(
        &root,
        "que_oversized",
        r#"[{"label":"Safe","description":"Fallback"}]"#,
    );
    request.questions[0].question = "x"
        .repeat(ycoding_core::resources::decision::judgment::BYTE_LIMIT + 1)
        .into();
    let Admission::Pending(wait) = questions.ask(request).unwrap() else {
        panic!()
    };
    assert!(matches!(
        wait.await.unwrap(),
        Err(questions::Error::Deferred { .. })
    ));
    assert!(evaluator.0.lock().unwrap().is_empty());
    assert_eq!(
        harness.items(&root)[0].deferral.reason,
        Reason::InputTooLarge
    );
}
