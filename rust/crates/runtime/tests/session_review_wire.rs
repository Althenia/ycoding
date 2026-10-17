mod support;

use std::time::Duration;
use support::{wire::*, *};
use tokio::time::timeout;
use ycoding_core::{
    session::{
        autonomy::YoloLevel,
        review::{FingerprintInput, OpenInput, fingerprint, prompt_id},
    },
    tools::policy::{permissions, questions},
    ycoding_schema::{
        DomainDecode, JsonValue, parse_json, permission, question, session,
        session_orchestration::QuestionId,
        session_review::{Id, Item},
    },
    ycoding_store::session::NewEvent,
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, Server, standard};

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

async fn create(id: &str, parent: Option<&str>) {
    let parent = parent.map_or_else(String::new, |parent| format!(r#","parentID":"{parent}""#));
    world()
        .core
        .sessions
        .create(NewEvent {
            id: format!("evt_create_{id}").as_str().into(),
            aggregate_id: id.into(),
            created: 5,
            type_: "session.created.2".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{id}","projectID":"prj_one","location":{{"directory":"/project"}},"title":"Review {id}","created":5{parent}}}"#
            ))
            .unwrap(),
        })
        .await
        .unwrap();
}

async fn publish(session: &str, event: &str, type_: &str, data: &str) {
    world()
        .core
        .sessions
        .publish(NewEvent {
            id: event.into(),
            aggregate_id: session.into(),
            created: 6,
            type_: type_.into(),
            data: parse_json(data).unwrap(),
        })
        .await
        .unwrap();
}

fn input(session: &str, kind: &str, reason: &str, origin: &str, payload: &str) -> OpenInput {
    let literal = |value: &str| JsonValue::String(value.into());
    OpenInput {
        session_id: id(session),
        kind: DomainDecode::decode(&literal(kind)).unwrap(),
        reason: DomainDecode::decode(&literal(reason)).unwrap(),
        choice: None,
        confidence: None,
        grades: None,
        origin: DomainDecode::decode(&parse_json(origin).unwrap()).unwrap(),
        payload: DomainDecode::decode(&parse_json(payload).unwrap()).unwrap(),
        limit: 16,
        conversion: false,
        created: 10,
    }
}

async fn open(input: OpenInput) -> Item {
    world().core.reviews.open(input).await.unwrap()
}

fn form_item(session: &str) -> OpenInput {
    input(
        session,
        "question",
        "free_text",
        r#"{"requestID":"frm_wire"}"#,
        r#"{"type":"form","title":"Plan","fields":[{"key":"plan","type":"string","required":true}]}"#,
    )
}

fn permission_item(session: &str) -> OpenInput {
    let digest = fingerprint(&FingerprintInput {
        action: "edit".into(),
        resources: vec!["outside.txt".into()],
        workdir: "/project".into(),
        rule_ids: vec![],
        hard_review: false,
        metadata: None,
    });
    input(
        session,
        "permission",
        "sleep_entry",
        r#"{"requestID":"per_wire"}"#,
        &format!(
            r#"{{"type":"permission","action":"edit","resources":["outside.txt"],"fingerprint":"{}","requestID":"per_wire"}}"#,
            digest.as_lossless().to_utf8().unwrap()
        ),
    )
}

fn hard_guardrail_item(session: &str) -> OpenInput {
    input(
        session,
        "guardrail",
        "disabled",
        r#"{"requestID":"grq_wire"}"#,
        &format!(
            r#"{{"type":"guardrail","action":"shell","resources":["git reset --hard"],"ruleIDs":["standard.review.git-destructive"],"reason":"Review","hardReview":true,"directories":[],"fingerprint":"{}","requestID":"grq_wire"}}"#,
            "c".repeat(64)
        ),
    )
}

fn item_id(item: &v5::SessionReviewItem) -> String {
    use v5::session_review_item::Kind;
    let id = match item.kind.as_ref().unwrap() {
        Kind::Value1(value) => &value.item_id,
        Kind::Value2(value) => &value.item_id,
        Kind::Value3(value) => &value.item_id,
        Kind::Value4(value) => &value.item_id,
        Kind::Value5(value) => &value.item_id,
    };
    units(id)
}

fn root_of(item: &v5::SessionReviewItem) -> String {
    use v5::session_review_item::Kind;
    let id = match item.kind.as_ref().unwrap() {
        Kind::Value1(value) => &value.root_session_id,
        Kind::Value2(value) => &value.root_session_id,
        Kind::Value3(value) => &value.root_session_id,
        Kind::Value4(value) => &value.root_session_id,
        Kind::Value5(value) => &value.root_session_id,
    };
    units(id)
}

fn list_request(session: &str) -> v5::SessionReviewListRequest {
    v5::SessionReviewListRequest {
        params: v5::SessionReviewListRequestParams {
            session_id: text(session),
        },
    }
}

async fn list(client: &mut Client, session: &str) -> Vec<v5::SessionReviewItem> {
    let result: v5::SessionReviewListResult = ask(
        client,
        "session.review.list",
        session_scope(session),
        list_request(session),
    )
    .await;
    result.data.items
}

fn decide_request(
    session: &str,
    item: &str,
    decision: v5::session_review_decision::Kind,
) -> v5::SessionReviewDecideRequest {
    v5::SessionReviewDecideRequest {
        params: v5::SessionReviewDecideRequestParams {
            session_id: text(session),
            item_id: text(item),
        },
        payload: v5::SessionReviewDecide {
            decision: v5::SessionReviewDecision {
                kind: Some(decision),
            },
        },
    }
}

async fn decide(
    client: &mut Client,
    session: &str,
    item: &str,
    decision: v5::session_review_decision::Kind,
) {
    let _: v5::SessionReviewDecideResult = ask(
        client,
        "session.review.decide",
        session_scope(session),
        decide_request(session, item, decision),
    )
    .await;
}

fn permission_once() -> v5::session_review_decision::Kind {
    v5::session_review_decision::Kind::Value4(v5::SessionReviewDecisionValue4 {
        kind: v5::SessionReviewDecisionValue4Kind::SessionreviewDecisionvalue4KindPermission as i32,
        reply: v5::PermissionReply::Once as i32,
    })
}

fn guardrail_always() -> v5::session_review_decision::Kind {
    v5::session_review_decision::Kind::Value3(v5::SessionReviewDecisionValue3 {
        kind: v5::SessionReviewDecisionValue3Kind::SessionreviewDecisionvalue3KindGuardrail as i32,
        reply: v5::GuardrailReply::Always as i32,
    })
}

fn question_dismissed() -> v5::session_review_decision::Kind {
    v5::session_review_decision::Kind::Value6(v5::SessionReviewDecisionValue6 {
        kind: v5::SessionReviewDecisionValue6Kind::SessionreviewDecisionvalue6KindQuestion as i32,
        dismissed: true,
    })
}

fn subagent_answer(value: &str) -> v5::session_review_decision::Kind {
    v5::session_review_decision::Kind::Value2(v5::SessionReviewDecisionValue2 {
        kind: v5::SessionReviewDecisionValue2Kind::SessionreviewDecisionvalue2KindSubagentQuestion
            as i32,
        text: text(value),
        data: None,
    })
}

fn recovery_continue() -> v5::session_review_decision::Kind {
    v5::session_review_decision::Kind::Value5(v5::SessionReviewDecisionValue5 {
        kind: v5::SessionReviewDecisionValue5Kind::SessionreviewDecisionvalue5KindRecovery as i32,
        choice: v5::SessionReviewDecisionValue5Choice::SessionreviewDecisionvalue5ChoiceContinue
            as i32,
    })
}

fn admitted(item: &str) -> bool {
    world()
        .core
        .sessions
        .pending(&prompt_id(&Id::new(item).unwrap()))
        .unwrap()
        .is_some()
}

fn set_request(
    session: &str,
    kind: v5::session_autonomy_set::Kind,
) -> v5::SessionAutonomySetRequest {
    v5::SessionAutonomySetRequest {
        params: v5::SessionAutonomySetRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionAutonomySet { kind: Some(kind) },
    }
}

async fn set(
    client: &mut Client,
    session: &str,
    kind: v5::session_autonomy_set::Kind,
) -> v5::SessionAutonomyView {
    let result: v5::SessionAutonomySetResult = ask(
        client,
        "session.autonomy.set",
        session_scope(session),
        set_request(session, kind),
    )
    .await;
    result.data
}

async fn sleep(client: &mut Client, session: &str, asleep: bool) {
    set(
        client,
        session,
        v5::session_autonomy_set::Kind::Value3(v5::SessionAutonomySetValue3 { sleep: asleep }),
    )
    .await;
}

async fn view(client: &mut Client, session: &str) -> v5::SessionAutonomyView {
    let result: v5::SessionAutonomyGetResult = ask(
        client,
        "session.autonomy.get",
        session_scope(session),
        v5::SessionAutonomyGetRequest {
            params: v5::SessionAutonomyGetRequestParams {
                session_id: text(session),
            },
        },
    )
    .await;
    result.data
}

async fn served() -> (Server, Client) {
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let client = Client::open(server.address(), &[]).await.unwrap();
    (server, client)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review_list_and_decide_cover_the_family_and_map_outcomes_to_typed_failures() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = served().await;
        create("ses_rw_root", None).await;
        create("ses_rw_kid", Some("ses_rw_root")).await;
        create("ses_rw_other", None).await;
        world()
            .core
            .autonomy
            .set_sleep(&id("ses_rw_root"), true)
            .await
            .unwrap();
        let permission = open(permission_item("ses_rw_kid")).await;
        let hard = open(hard_guardrail_item("ses_rw_root")).await;
        let form = open(form_item("ses_rw_kid")).await;
        let listed = list(&mut client, "ses_rw_kid").await;
        assert_eq!(
            listed.iter().map(item_id).collect::<Vec<_>>(),
            [&permission, &hard, &form].map(|item| item
                .deferral
                .item_id
                .as_lossless()
                .to_utf8()
                .unwrap())
        );
        assert!(listed.iter().all(|item| root_of(item) == "ses_rw_root"));
        let _: v5::SessionNotFoundError = refuse(
            &mut client,
            "session.review.list",
            session_scope("ses_rw_missing"),
            list_request("ses_rw_missing"),
        )
        .await;

        let permission_id = item_id(&listed[0]);
        decide(
            &mut client,
            "ses_rw_root",
            &permission_id,
            permission_once(),
        )
        .await;
        assert!(admitted(&permission_id));
        assert!(
            world()
                .core
                .autonomy
                .get(&id("ses_rw_root"))
                .unwrap()
                .is_asleep()
        );
        let _: v5::ConflictError = refuse(
            &mut client,
            "session.review.decide",
            session_scope("ses_rw_root"),
            decide_request("ses_rw_root", &permission_id, permission_once()),
        )
        .await;
        let _: v5::InvalidRequestError = refuse(
            &mut client,
            "session.review.decide",
            session_scope("ses_rw_root"),
            decide_request("ses_rw_root", &item_id(&listed[1]), guardrail_always()),
        )
        .await;
        let missing: v5::ReviewItemNotFoundError = refuse(
            &mut client,
            "session.review.decide",
            session_scope("ses_rw_root"),
            decide_request("ses_rw_root", "rvw_missing", permission_once()),
        )
        .await;
        assert_eq!(units(&missing.item_id), "rvw_missing");
        let _: v5::ReviewItemNotFoundError = refuse(
            &mut client,
            "session.review.decide",
            session_scope("ses_rw_other"),
            decide_request("ses_rw_other", &item_id(&listed[2]), question_dismissed()),
        )
        .await;
        decide(
            &mut client,
            "ses_rw_kid",
            &item_id(&listed[2]),
            question_dismissed(),
        )
        .await;
        assert!(admitted(&item_id(&listed[2])));
        assert_eq!(
            list(&mut client, "ses_rw_root")
                .await
                .iter()
                .map(item_id)
                .collect::<Vec<_>>(),
            [item_id(&listed[1])]
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sleep_entry_over_the_wire_converts_live_location_requests_and_waking_keeps_them_deferred()
{
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = served().await;
        create("ses_rw_sleep", None).await;
        create("ses_rw_sleep_kid", Some("ses_rw_sleep")).await;
        let services = world()
            .core
            .locations
            .location(&"/project".into(), None)
            .unwrap();
        let request = question::Request::decode(
            &parse_json(r#"{"id":"que_rw_sleep","sessionID":"ses_rw_sleep","questions":[{"header":"Plan","question":"Which plan?","options":[]}]}"#)
                .unwrap(),
        )
        .unwrap();
        let questions::Admission::Pending(question) = services.questions.ask(request).unwrap() else {
            panic!("an awake question waits for the human");
        };
        let permission = services
            .permissions
            .ask(
                permission::Request {
                    id: permission::Id::new("per_rw_sleep").unwrap(),
                    session_id: id("ses_rw_sleep_kid"),
                    action: "edit".into(),
                    resources: vec!["outside.txt".into()],
                    save: None,
                    metadata: None,
                    source: None,
                },
                Some("build".into()),
            )
            .unwrap()
            .wait
            .expect("the build agent asks for edits");
        sleep(&mut client, "ses_rw_sleep_kid", true).await;
        assert!(matches!(question.await.unwrap(), Err(questions::Error::Deferred { .. })));
        assert!(matches!(permission.await.unwrap(), Err(permissions::Error::Deferred { .. })));
        assert!(services.questions.list().iter().all(|pending| pending.session_id != id("ses_rw_sleep")));
        let items = list(&mut client, "ses_rw_sleep").await;
        assert_eq!(items.len(), 2);
        sleep(&mut client, "ses_rw_sleep", false).await;
        assert_eq!(
            list(&mut client, "ses_rw_sleep").await.iter().map(item_id).collect::<Vec<_>>(),
            items.iter().map(item_id).collect::<Vec<_>>()
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_converted_child_question_accepts_only_the_human_review_answer() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = served().await;
        create("ses_rw_parent", None).await;
        create("ses_rw_child", Some("ses_rw_parent")).await;
        publish(
            "ses_rw_child",
            "evt_rw_child_launched",
            "session.task.updated.1",
            r#"{"sessionID":"ses_rw_child","change":{"type":"launched","parentID":"ses_rw_parent","parentAssistantMessageID":"msg_rw_parent","toolCallID":"call_rw_child","inputID":"msg_rw_child_input","description":"Review child","agent":"build","model":{"providerID":"openai","id":"gpt-runtime"},"promptDigest":"digest","background":true,"delivery":"steer"}}"#,
        )
        .await;
        publish(
            "ses_rw_child",
            "evt_rw_child_started",
            "session.task.updated.1",
            r#"{"sessionID":"ses_rw_child","change":{"type":"started"}}"#,
        )
        .await;
        let asked = world()
            .core
            .orchestration
            .question(&id("ses_rw_child"), "Need literal evidence", None)
            .await
            .unwrap();
        sleep(&mut client, "ses_rw_parent", true).await;
        let items = list(&mut client, "ses_rw_parent").await;
        assert_eq!(items.len(), 1);
        assert!(matches!(
            items[0].kind,
            Some(v5::session_review_item::Kind::Value2(_))
        ));
        assert!(!asked.auto_answered);
        let question: QuestionId = asked.question.id.clone();
        assert!(
            world()
                .core
                .orchestration
                .answer(&id("ses_rw_parent"), &id("ses_rw_child"), &question, Some("Agent answer"), None)
                .await
                .is_err()
        );
        decide(&mut client, "ses_rw_parent", &item_id(&items[0]), subagent_answer("/literal review answer")).await;
        let task = world()
            .core
            .orchestration
            .get(&id("ses_rw_parent"), &id("ses_rw_child"))
            .unwrap();
        assert_eq!(format!("{:?}", task.state).to_lowercase(), "running");
        let pending = world().core.sessions.pending_list(&id("ses_rw_child")).unwrap();
        assert!(
            pending
                .iter()
                .any(|row| ycoding_core::ycoding_schema::stringify_json(&row.data).contains("/literal review answer"))
        );
        assert!(list(&mut client, "ses_rw_parent").await.is_empty());
        assert!(world().core.autonomy.get(&id("ses_rw_parent")).unwrap().is_asleep());
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_recovery_decision_is_refused_without_the_installed_recovery_resolver() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = served().await;
        create("ses_rw_recovery", None).await;
        create("ses_rw_recovery_kid", Some("ses_rw_recovery")).await;
        let recovery = open(input(
            "ses_rw_recovery_kid",
            "recovery",
            "restart",
            r#"{"questionID":"qst_rw_recovery"}"#,
            r#"{"type":"recovery","tools":[{"messageID":"msg_rw_tool","callID":"call_rw_edit","name":"edit"}]}"#,
        ))
        .await;
        let item = recovery.deferral.item_id.as_lossless().to_utf8().unwrap();
        let _: v5::ConflictError = refuse(
            &mut client,
            "session.review.decide",
            session_scope("ses_rw_recovery"),
            decide_request("ses_rw_recovery", &item, recovery_continue()),
        )
        .await;
        assert_eq!(
            list(&mut client, "ses_rw_recovery").await.iter().map(item_id).collect::<Vec<_>>(),
            [item]
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autonomy_reads_report_the_effective_review_policy_and_auto_answer_is_session_local() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = served().await;
        create("ses_rw_view", None).await;
        create("ses_rw_view_kid", Some("ses_rw_view")).await;
        let initial = view(&mut client, "ses_rw_view_kid").await;
        assert_eq!(initial.auto_answer, None);
        assert!(!initial.effective.asleep);
        assert!(initial.effective.guardrails_enabled);
        assert!(!initial.effective.ordinary_reviews_auto);
        assert!(!initial.effective.model_reviews);
        assert!(!initial.effective.hard_model_reviews);

        let toggled = set(
            &mut client,
            "ses_rw_view_kid",
            v5::session_autonomy_set::Kind::Value4(v5::SessionAutonomySetValue4 {
                auto_answer: true,
            }),
        )
        .await;
        assert_eq!(toggled.auto_answer, Some(true));
        assert_eq!(view(&mut client, "ses_rw_view").await.auto_answer, None);
        assert_eq!(
            view(&mut client, "ses_rw_view_kid").await.auto_answer,
            Some(true)
        );

        world()
            .core
            .autonomy
            .set_yolo(&id("ses_rw_view"), YoloLevel::GUARDRAILS)
            .await
            .unwrap();
        assert!(
            view(&mut client, "ses_rw_view_kid")
                .await
                .effective
                .ordinary_reviews_auto
        );
        sleep(&mut client, "ses_rw_view", true).await;
        let asleep = view(&mut client, "ses_rw_view_kid").await;
        assert!(asleep.effective.asleep);
        assert!(!asleep.effective.ordinary_reviews_auto);
        assert_eq!(asleep.auto_answer, Some(true));
    })
    .await
    .unwrap();
}
