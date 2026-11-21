mod support;

use std::{sync::Arc, time::Duration};
use support::{wire::*, *};
use tokio::time::timeout;
use v5::form_field::Kind as FieldKind;
use ycoding_core::{
    process::guardrails::{
        Input,
        decision::{EvaluateFuture, Evaluator},
    },
    resources::decision::{Error as DecisionError, Invocation},
    session::autonomy::{DecisionChange, DecisionMode},
    session::review::{FingerprintInput, OpenInput, fingerprint},
    tools::policy::{Effect, questions::Admission},
    ycoding_schema::{
        DomainDecode, JsonValue, form, parse_json, question, session, session_id::SessionId,
    },
    ycoding_store::session::{NewEvent, SessionTable},
};
use ycoding_protocol::v5;

const PERMISSION: i32 = 1;
const QUESTION: i32 = 3;
const GUARDRAIL: i32 = 2;
const FORM: i32 = 4;
const REVIEW: i32 = 5;

fn permission(session: &str, action: &str) -> v5::SessionPermissionCreateRequest {
    v5::SessionPermissionCreateRequest {
        params: v5::SessionPermissionCreateRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPermissionCreateRequestPayload {
            id: None,
            action: text(action),
            resources: v5::SessionPermissionCreateRequestPayloadResources {
                items: vec![text("x")],
            },
            save: None,
            metadata: None,
            source: None,
            agent: None,
        },
    }
}

fn question_request(id: &str, session: &str) -> question::Request {
    question::Request {
        id: question::Id::decode(&JsonValue::String(id.into())).unwrap(),
        session_id: SessionId::new(session).unwrap(),
        questions: vec![question::Info {
            question: "Which?".into(),
            header: "Pick".into(),
            options: vec![question::Option {
                label: "One".into(),
                description: "first".into(),
            }],
            multiple: None,
            custom: Some(false),
        }],
        tool: None,
    }
}

async fn list(client: &mut Client) -> Vec<v5::DecisionItem> {
    let result: v5::DecisionListResult = ask(
        client,
        "decision.list",
        machine(),
        v5::DecisionListRequest {},
    )
    .await;
    result.data.items
}

fn ids(items: &[v5::DecisionItem], kind: i32, session: &str) -> Vec<String> {
    items
        .iter()
        .filter(|item| item.kind == kind && units(&item.session_id) == session)
        .map(|item| units(&item.id))
        .collect()
}

async fn insert_archived(id: &str, directory: &str) {
    let mut row = record(id);
    row.directory = directory.into();
    row.time_archived = Some(7);
    world()
        .store
        .submit(move |tx| SessionTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
}

fn review_input(session: &str, request: &str) -> OpenInput {
    let digest = fingerprint(&FingerprintInput {
        action: "edit".into(),
        resources: vec!["outside.txt".into()],
        workdir: "/project".into(),
        rule_ids: vec![],
        hard_review: false,
        metadata: None,
    });
    OpenInput {
        session_id: session::Id::new(session).unwrap(),
        kind: DomainDecode::decode(&JsonValue::String("permission".into())).unwrap(),
        reason: DomainDecode::decode(&JsonValue::String("defer_entry".into())).unwrap(),
        choice: None,
        confidence: None,
        grades: None,
        origin: DomainDecode::decode(
            &parse_json(&format!(r#"{{"requestID":"{request}"}}"#)).unwrap(),
        )
        .unwrap(),
        payload: DomainDecode::decode(
            &parse_json(&format!(
                r#"{{"type":"permission","action":"edit","resources":["outside.txt"],"fingerprint":"{}","fingerprintVersion":2,"requestID":"{request}"}}"#,
                digest.as_lossless().to_utf8().unwrap()
            ))
            .unwrap(),
        )
        .unwrap(),
        limit: 16,
        conversion: false,
        created: 10,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_requests_follow_location_load_order_then_kind_then_creation_order() {
    timeout(Duration::from_secs(60), async {
        insert_session("ses_dl_z", "/loc/dl-z", None).await;
        insert_session("ses_dl_m", "/loc/dl-m", None).await;
        insert_session("ses_dl_a", "/loc/dl-a", None).await;
        let (_server, mut client) = open().await;
        for session in ["ses_dl_z", "ses_dl_m", "ses_dl_a"] {
            world()
                .core
                .locations
                .session(&SessionId::new(session).unwrap())
                .unwrap();
        }
        let (_, services_a) = world()
            .core
            .locations
            .session(&SessionId::new("ses_dl_a").unwrap())
            .unwrap();
        let Admission::Pending(_wait) = services_a
            .questions
            .ask(question_request("que_dl_a", "ses_dl_a"))
            .unwrap()
        else {
            panic!("a question at normal autonomy stays pending");
        };
        for (session, action) in [
            ("ses_dl_a", "a-first"),
            ("ses_dl_m", "m-first"),
            ("ses_dl_z", "z-first"),
            ("ses_dl_a", "a-second"),
            ("ses_dl_z", "z-second"),
        ] {
            let _: v5::SessionPermissionCreateResult = ask(
                &mut client,
                "session.permission.create",
                session_scope(session),
                permission(session, action),
            )
            .await;
        }
        let items = list(&mut client).await;
        let order = items
            .iter()
            .filter(|item| {
                ["ses_dl_z", "ses_dl_m", "ses_dl_a"].contains(&units(&item.session_id).as_str())
            })
            .map(|item| units(&item.summary))
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            [
                "z-first: x",
                "z-second: x",
                "m-first: x",
                "a-first: x",
                "a-second: x",
                "Which?",
            ]
        );
        let mine = |items: &[v5::DecisionItem]| {
            items
                .iter()
                .filter(|item| {
                    ["ses_dl_z", "ses_dl_m", "ses_dl_a"].contains(&units(&item.session_id).as_str())
                })
                .map(|item| units(&item.id))
                .collect::<Vec<_>>()
        };
        let again = list(&mut client).await;
        assert_eq!(mine(&again), mine(&items));
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retired_generation_still_lists_its_live_requests_beside_the_current_one() {
    timeout(Duration::from_secs(60), async {
        insert_session("ses_dl_retired", "/loc/dl-retired", None).await;
        let (_server, mut client) = open().await;
        let _: v5::SessionPermissionCreateResult = ask(
            &mut client,
            "session.permission.create",
            session_scope("ses_dl_retired"),
            permission("ses_dl_retired", "before-reload"),
        )
        .await;
        let (_, services) = world()
            .core
            .locations
            .session(&SessionId::new("ses_dl_retired").unwrap())
            .unwrap();
        world().core.locations.reload(&services.info).unwrap();
        let _: v5::SessionPermissionCreateResult = ask(
            &mut client,
            "session.permission.create",
            session_scope("ses_dl_retired"),
            permission("ses_dl_retired", "after-reload"),
        )
        .await;
        let items = list(&mut client).await;
        let summaries = items
            .iter()
            .filter(|item| item.kind == PERMISSION && units(&item.session_id) == "ses_dl_retired")
            .map(|item| units(&item.summary))
            .collect::<Vec<_>>();
        assert_eq!(summaries, ["before-reload: x", "after-reload: x"]);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cold_session_in_an_unbuildable_location_lists_its_durable_review_and_archived_ones_stay_hidden()
 {
    timeout(Duration::from_secs(60), async {
        insert_session("ses_dl_unbuildable", "/definitely/missing/dl-cold", None).await;
        insert_archived("ses_dl_archived", "/loc/dl-archived").await;
        let (_server, mut client) = open().await;
        world()
            .core
            .reviews
            .open(review_input("ses_dl_unbuildable", "per_cold_unbuildable"))
            .await
            .unwrap();
        world()
            .core
            .reviews
            .open(review_input("ses_dl_archived", "per_cold_archived"))
            .await
            .unwrap();
        let hard = OpenInput {
            kind: DomainDecode::decode(&JsonValue::String("guardrail".into())).unwrap(),
            reason: DomainDecode::decode(&JsonValue::String("disabled".into())).unwrap(),
            origin: DomainDecode::decode(&parse_json(r#"{"requestID":"grq_cold_hard"}"#).unwrap())
                .unwrap(),
            payload: DomainDecode::decode(
                &parse_json(&format!(
                    r#"{{"type":"guardrail","action":"shell","resources":["git reset --hard"],"ruleIDs":["standard.review.git-destructive"],"reason":"Review","hardReview":true,"directories":[],"fingerprint":"{}","requestID":"grq_cold_hard"}}"#,
                    "c".repeat(64)
                ))
                .unwrap(),
            )
            .unwrap(),
            ..review_input("ses_dl_unbuildable", "per_cold_unbuildable")
        };
        world().core.reviews.open(hard).await.unwrap();
        let items = list(&mut client).await;
        let cold = items
            .iter()
            .filter(|item| item.kind == REVIEW && units(&item.session_id) == "ses_dl_unbuildable")
            .collect::<Vec<_>>();
        assert_eq!(cold.len(), 2);
        let mut choices = cold.iter().map(|item| labels(item)).collect::<Vec<_>>();
        choices.sort();
        assert_eq!(choices, [vec!["once", "always", "reject"], vec!["once", "reject"]]);
        assert!(ids(&items, REVIEW, "ses_dl_archived").is_empty());
    })
    .await
    .unwrap();
}

fn global_form_scope(directory: &str) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::GlobalForm(v5::GlobalFormScope {
            directory: text(directory),
            workspace_id: None,
        })),
    }
}

fn argv(item: &v5::DecisionItemDecideItem) -> Vec<String> {
    item.argv.items.iter().map(units).collect()
}

fn labels(item: &v5::DecisionItem) -> Vec<String> {
    item.decide
        .items
        .iter()
        .map(|choice| units(&choice.label))
        .collect()
}

fn text_form(session: &str, id: &str) -> v5::SessionFormCreateRequest {
    v5::SessionFormCreateRequest {
        params: v5::SessionFormCreateRequestParams {
            session_id: text(session),
        },
        payload: v5::FormCreatePayload {
            id: Some(text(id)),
            title: text("Profile"),
            metadata: None,
            fields: v5::FormFields {
                items: vec![v5::FormField {
                    kind: Some(FieldKind::Value1(v5::FormStringField {
                        key: text("email"),
                        title: None,
                        description: None,
                        required: Some(true),
                        when: None,
                        r#type: 1,
                        format: None,
                        min_length: None,
                        max_length: None,
                        pattern: None,
                        placeholder: None,
                        default: None,
                        options: None,
                        custom: None,
                    })),
                }],
            },
        },
    }
}

fn guardrail_input(session: &str, command: &str) -> Input {
    Input {
        session_id: SessionId::new(session).unwrap(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: None,
        skip_review: false,
        holder: None,
        source: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_live_kind_carries_its_exact_decide_commands_templates_and_hints() {
    timeout(Duration::from_secs(60), async {
        insert_session("ses_dl_kinds", "/loc/dl-kinds", None).await;
        let (_server, mut client) = open().await;
        let _: v5::SessionPermissionCreateResult = ask(
            &mut client,
            "session.permission.create",
            session_scope("ses_dl_kinds"),
            permission("ses_dl_kinds", "edit"),
        )
        .await;
        let (_, services) = world()
            .core
            .locations
            .session(&SessionId::new("ses_dl_kinds").unwrap())
            .unwrap();
        let Admission::Pending(_finite) = services
            .questions
            .ask(question_request("que_dl_finite", "ses_dl_kinds"))
            .unwrap()
        else {
            panic!("a question at normal autonomy stays pending");
        };
        let mut open_ended = question_request("que_dl_open", "ses_dl_kinds");
        open_ended.questions[0].custom = None;
        let Admission::Pending(_open) = services.questions.ask(open_ended).unwrap() else {
            panic!("a question at normal autonomy stays pending");
        };
        let ordinary = services
            .guardrails
            .assert(guardrail_input("ses_dl_kinds", "touch /other/file"))
            .unwrap();
        assert_eq!(ordinary.effect, Effect::Ask);
        let guardrail_id = match ycoding_core::ycoding_schema::DomainEncode::encode(
            &ordinary.request.as_ref().unwrap().id,
        ) {
            JsonValue::String(id) => id.to_utf8().unwrap(),
            _ => panic!("a guardrail request id encodes as text"),
        };
        let hard = services
            .guardrails
            .assert(guardrail_input("ses_dl_kinds", "rm -rf ~/notes"))
            .unwrap();
        let hard_id = match ycoding_core::ycoding_schema::DomainEncode::encode(
            &hard.request.as_ref().unwrap().id,
        ) {
            JsonValue::String(id) => id.to_utf8().unwrap(),
            _ => panic!("a guardrail request id encodes as text"),
        };
        let lossy = [0x41, 0x22, 0x0a, 0xd800, 0x42];
        let mut lossless = question_request("que_dl_lossless", "ses_dl_kinds");
        lossless.questions[0].options[0].label =
            ycoding_core::ycoding_schema::LosslessString::from_utf16(lossy.to_vec());
        let Admission::Pending(_lossless) = services.questions.ask(lossless).unwrap() else {
            panic!("a question at normal autonomy stays pending");
        };
        let _: v5::SessionFormCreateResult = ask(
            &mut client,
            "session.form.create",
            global_form_scope("/loc/dl-kinds"),
            text_form("global", "frm_dl_global"),
        )
        .await;
        let items = list(&mut client).await;
        let permission_item = items
            .iter()
            .find(|item| item.kind == PERMISSION && units(&item.session_id) == "ses_dl_kinds")
            .unwrap();
        assert_eq!(labels(permission_item), ["once", "always", "reject"]);
        let reply = &permission_item.decide.items[0];
        assert_eq!(
            argv(reply)[..3],
            ["ycoding", "api", "session.permission.reply"]
        );
        assert_eq!(argv(reply).last().unwrap(), r#"{"reply":"once"}"#);
        assert!(reply.template.is_none() && reply.hint.is_none());
        let guardrail_item = items
            .iter()
            .find(|item| item.kind == GUARDRAIL && units(&item.id) == guardrail_id)
            .unwrap();
        assert_eq!(labels(guardrail_item), ["once", "always", "reject"]);
        let hard_item = items
            .iter()
            .find(|item| item.kind == GUARDRAIL && units(&item.id) == hard_id)
            .unwrap();
        assert_eq!(labels(hard_item), ["once", "reject"]);
        assert_eq!(
            argv(&hard_item.decide.items[1]).last().unwrap(),
            r#"{"reply":"reject"}"#
        );
        let escaped = items
            .iter()
            .find(|item| units(&item.id) == "que_dl_lossless")
            .unwrap();
        assert_eq!(
            ycoding_protocol::decode_lossless(&escaped.decide.items[0].label, 64).unwrap(),
            lossy
        );
        let Some(v5::decision_item_options::Kind::Value1(options)) = escaped
            .options
            .as_ref()
            .and_then(|options| options.kind.as_ref())
        else {
            panic!("a question lists its question options");
        };
        assert_eq!(
            ycoding_protocol::decode_lossless(&options.items[0].options.items[0].label, 64)
                .unwrap(),
            lossy
        );
        assert_eq!(
            argv(&escaped.decide.items[0]).last().unwrap(),
            r##"{"answers":[["A\"\n\ud800B"]]}"##
        );
        let finite = items
            .iter()
            .find(|item| units(&item.id) == "que_dl_finite")
            .unwrap();
        assert_eq!(labels(finite), ["One", "Reject"]);
        assert_eq!(
            argv(&finite.decide.items[0]),
            [
                "ycoding",
                "api",
                "session.question.reply",
                "--param",
                "sessionID=ses_dl_kinds",
                "--param",
                "requestID=que_dl_finite",
                "--data",
                r#"{"answers":[["One"]]}"#
            ]
        );
        assert_eq!(
            argv(&finite.decide.items[1]),
            [
                "ycoding",
                "api",
                "session.question.reject",
                "--param",
                "sessionID=ses_dl_kinds",
                "--param",
                "requestID=que_dl_finite"
            ]
        );
        let open = items
            .iter()
            .find(|item| units(&item.id) == "que_dl_open")
            .unwrap();
        assert_eq!(
            labels(open),
            ["One", "Reply (replace answer values)", "Reject"]
        );
        let template = &open.decide.items[1];
        assert_eq!(template.template, Some(true));
        assert!(units(template.hint.as_ref().unwrap()).contains("entire quoted placeholder"));
        assert_eq!(
            argv(template).last().unwrap(),
            r#"{"answers":[["<answer:0>"]]}"#
        );
        let global = items
            .iter()
            .find(|item| item.kind == FORM && units(&item.id) == "frm_dl_global")
            .unwrap();
        assert_eq!(units(&global.session_id), "global");
        assert_eq!(units(&global.session_title), "Global");
        assert_eq!(units(&global.directory), "/loc/dl-kinds");
        let cancel = global.decide.items.last().unwrap();
        assert_eq!(units(&cancel.label), "Cancel");
        assert!(
            argv(cancel)
                .windows(2)
                .any(|pair| pair == ["--header", "x-ycoding-directory:/loc/dl-kinds"])
        );
        let reply = &global.decide.items[0];
        assert_eq!(reply.template, Some(true));
        assert_eq!(
            argv(reply).last().unwrap(),
            r#"{"answer":{"email":"<answer:email>"}}"#
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_titles_and_directories_stay_lossless_in_decision_items() {
    timeout(Duration::from_secs(60), async {
        let title =
            ycoding_core::ycoding_schema::LosslessString::from_utf16(vec![0x54, 0xd800, 0x55]);
        let mut row = record("ses_dl_lossless");
        row.directory = "/loc/dl-lossless".into();
        row.title = title.clone();
        world()
            .store
            .submit(move |tx| SessionTable::insert(tx, &row))
            .unwrap()
            .wait()
            .unwrap();
        let (_server, mut client) = open().await;
        let _: v5::SessionPermissionCreateResult = ask(
            &mut client,
            "session.permission.create",
            session_scope("ses_dl_lossless"),
            permission("ses_dl_lossless", "edit"),
        )
        .await;
        let items = list(&mut client).await;
        let item = items
            .iter()
            .find(|item| units(&item.session_id) == "ses_dl_lossless")
            .unwrap();
        assert_eq!(
            ycoding_protocol::decode_lossless(&item.session_title, 1024).unwrap(),
            vec![0x54, 0xd800, 0x55]
        );
    })
    .await
    .unwrap();
}

#[derive(Default)]
struct HeldFormDecision {
    entered: tokio::sync::Notify,
}

impl Evaluator for HeldFormDecision {
    fn evaluate<'a>(&'a self, _: JsonValue, invocation: Invocation<'a>) -> EvaluateFuture<'a> {
        Box::pin(async move {
            self.entered.notify_one();
            invocation.cancellation.cancelled().await;
            Err(DecisionError::Cancelled)
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_form_held_for_a_sleeping_decision_stays_hidden_while_a_visible_one_is_listed() {
    timeout(Duration::from_secs(60), async {
        insert_session("ses_dl_hidden", "/loc/dl-hidden", None).await;
        let (_server, mut client) = open().await;
        let id = session::Id::new("ses_dl_hidden").unwrap();
        let (_, services) = world()
            .core
            .locations
            .session(&SessionId::new("ses_dl_hidden").unwrap())
            .unwrap();
        let held = Arc::new(HeldFormDecision::default());
        let forms = services.forms.clone().with_decision(held.clone());
        let _: v5::SessionFormCreateResult = ask(
            &mut client,
            "session.form.create",
            form_scope("ses_dl_hidden"),
            text_form("ses_dl_hidden", "frm_dl_visible"),
        )
        .await;
        world()
            .core
            .autonomy
            .set_decisions(
                &id,
                DecisionChange::new(None, None, Some(DecisionMode::Yolo)).unwrap(),
            )
            .await
            .unwrap();
        world().core.autonomy.set_defer(&id, true).await.unwrap();
        let hidden = form::Info::decode(
            &parse_json(
                r#"{"id":"frm_dl_hidden","sessionID":"ses_dl_hidden","title":"Choose","fields":[{"key":"proceed","type":"boolean","required":true}]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let _wait = forms.ask(hidden).unwrap();
        held.entered.notified().await;
        assert!(forms.has_pending());
        let items = list(&mut client).await;
        assert_eq!(ids(&items, FORM, "ses_dl_hidden"), ["frm_dl_visible"]);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn durable_reviews_sort_by_item_id_in_utf16_units_not_by_session_or_code_point() {
    timeout(Duration::from_secs(60), async {
        let astral_session = "ses_dl_ux_\u{10000}";
        let private_session = "ses_dl_ux_\u{e000}";
        insert_session(astral_session, "/definitely/missing/dl-ux", None).await;
        insert_session(private_session, "/definitely/missing/dl-ux", None).await;
        let (_server, mut client) = open().await;
        for (index, (session, session_escape, item_escape)) in [
            (astral_session, r"\ud800\udc00", r"\ue000"),
            (private_session, r"\ue000", r"\ud800\udc00"),
        ]
        .into_iter()
        .enumerate()
        {
            world()
                .core
                .sessions
                .publish(NewEvent {
                    id: format!("evt_dl_ux_{index}").as_str().into(),
                    aggregate_id: session.into(),
                    created: 6,
                    type_: "session.review.deferred.1".into(),
                    data: parse_json(&format!(
                        r#"{{"sessionID":"ses_dl_ux_{session_escape}","itemID":"rvw_dl_ux_{item_escape}","kind":"question","reason":"defer_entry","origin":{{"requestID":"frm_dl_ux"}},"payload":{{"type":"form","title":"Plan","fields":[{{"key":"plan","type":"string","required":true}}]}}}}"#
                    ))
                    .unwrap(),
                })
                .await
                .unwrap();
        }
        let items = list(&mut client).await;
        let mine = items
            .iter()
            .filter(|item| item.kind == REVIEW && units(&item.session_id).starts_with("ses_dl_ux_"))
            .map(|item| (units(&item.session_id), units(&item.id)))
            .collect::<Vec<_>>();
        assert_eq!(
            mine,
            [
                (private_session.to_owned(), "rvw_dl_ux_\u{10000}".to_owned()),
                (astral_session.to_owned(), "rvw_dl_ux_\u{e000}".to_owned()),
            ]
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retired_set_keeps_listing_its_pending_requests_after_its_location_is_evicted() {
    timeout(Duration::from_secs(60), async {
        insert_session("ses_dl_evicted", "/loc/dl-evicted", None).await;
        let (_server, mut client) = open().await;
        let (_, lease) = world()
            .core
            .locations
            .session(&SessionId::new("ses_dl_evicted").unwrap())
            .unwrap();
        world().core.locations.reload(&lease.info).unwrap();
        let directory = lease.info.directory.as_lossless().clone();
        world().core.locations.evict(&directory, None).unwrap();
        assert!(
            world()
                .core
                .locations
                .cached()
                .iter()
                .all(|(cached, _)| cached != &directory),
            "the Location has no current entry"
        );
        let Admission::Pending(_wait) = lease
            .questions
            .ask(question_request("que_dl_evicted", "ses_dl_evicted"))
            .unwrap()
        else {
            panic!("a question at normal autonomy stays pending");
        };
        let items = list(&mut client).await;
        assert_eq!(ids(&items, QUESTION, "ses_dl_evicted"), ["que_dl_evicted"]);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_item_larger_than_a_mebibyte_is_listed_within_the_bulk_message_ceiling() {
    timeout(Duration::from_secs(60), async {
        insert_session("ses_dl_large", "/loc/dl-large", None).await;
        let (_server, mut client) = open().await;
        let (_, services) = world()
            .core
            .locations
            .session(&SessionId::new("ses_dl_large").unwrap())
            .unwrap();
        let mut large = question_request("que_dl_large", "ses_dl_large");
        let text = "q".repeat(1_200_000);
        large.questions[0].question = text.as_str().into();
        let Admission::Pending(_wait) = services.questions.ask(large).unwrap() else {
            panic!("a question at normal autonomy stays pending");
        };
        let items = list(&mut client).await;
        let item = items
            .iter()
            .find(|item| units(&item.id) == "que_dl_large")
            .unwrap();
        assert_eq!(
            ycoding_protocol::decode_lossless(&item.summary, 2_000_000)
                .unwrap()
                .len(),
            1_200_000
        );
    })
    .await
    .unwrap();
}
