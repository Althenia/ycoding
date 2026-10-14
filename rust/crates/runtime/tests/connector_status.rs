mod connector_status_support;
mod connector_support;
mod support;

use connector_support::{Command, Relay};
use std::{sync::Arc, time::Duration};
use support::{services, world};
use ycoding_core::{
    session::pending::Request,
    ycoding_schema::{
        DomainDecode, event, form, guardrail, parse_json, permission, question, session,
        session_message, session_pending,
    },
};
use ycoding_protocol::{connection::Budgets, v5};
use ycoding_runtime::{
    Environment, LocalAuth, Subscriptions,
    connector::{Connector, Control, Credential, Credentials, Enrolled, Error, Settings},
    standard,
};

struct Access(String);
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl Credentials for Access {
    fn enrolled(&self) -> ycoding_runtime::Boxed<Result<Enrolled, Error>> {
        let enrolled = Enrolled::new(&self.0, "device-status".into());
        Box::pin(async move { enrolled })
    }
    fn access(&self) -> ycoding_runtime::Boxed<Result<Credential, Error>> {
        let origin = self.0.clone();
        Box::pin(async move {
            Ok(Credential::new(
                "stand-in-token".into(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
                    + 600_000,
                origin,
                "device-status".into(),
            ))
        })
    }
}

async fn status(relay: &mut Relay, generation: usize, attention: &[&str]) -> v5::Status {
    let frame = relay.matching(generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::Status(status)) })) if status.attention == attention)).await;
    let Some(v5::frame::Body::Control(v5::Control {
        kind: Some(v5::control::Kind::Status(status)),
    })) = frame.body
    else {
        unreachable!()
    };
    status
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authoritative_family_requests_failures_and_reconnect_publish_status() {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(Duration::from_secs(60), async {
        let root = session::Id::new("ses_get").unwrap();
        let child = session::Id::new("ses_status_child").unwrap();
        world().store.submit(|tx| {
            let mut row = support::record("ses_status_child");
            row.parent_id = Some("ses_get".into());
            row.directory = "/project/team".into();
            ycoding_core::ycoding_store::session::SessionTable::insert(tx, &row)
        }).unwrap().await.unwrap();
        world().core.sessions.change(&root, ycoding_core::session::lifecycle::Change::Rename(format!("\u{202e} Review\n{}", "🦀".repeat(130)).into())).await.unwrap();
        let mut relay = Relay::start(5, false, Budgets::default()).await;
        let directory = std::env::temp_dir().join(format!("connector-status-{}", std::process::id()));
        let control = Control::open(&directory).await.unwrap();
        let mut settings = Settings::new(Arc::new(Access(relay.origin())));
        settings.reconnect_initial = Duration::from_millis(10);
        let connector = Connector::start(control.clone(), settings, Arc::new(Environment { services: services(LocalAuth::disabled(), true), urls: vec![], subscriptions: Subscriptions::default(), uploads: Default::default() }), Arc::new(standard().unwrap())).unwrap();
        control.set(true).await.unwrap();
        let first = relay.opening().await;
        assert!(status(&mut relay, first.generation, &[]).await.running.is_empty());
        world().core.execution.prompt(Request { id: session_message::Id::new("msg_status_child").unwrap(), session_id: child.clone(), input: session_pending::Message::decode(&parse_json(r#"{"type":"user","data":{"text":"queued"},"delivery":"queue"}"#).unwrap()).unwrap(), event_id: event::Id::new("evt_status_child").unwrap(), created: 10 }, Some(false)).await.unwrap();
        world().core.execution.wake(&child).unwrap();
        world().active_children.started(&child).await;
        let (_, location) = world().core.locations.session(&child).unwrap();
        let question = question::Request::decode(&parse_json(r#"{"id":"que_status","sessionID":"ses_status_child","questions":[{"question":"Continue?","header":"Status","options":[]}]}"#).unwrap()).unwrap();
        let question_wait = location.questions.ask(question.clone()).unwrap();
        let asked = status(&mut relay, first.generation, &["ses_get"]).await;
        assert_eq!(asked.running, ["ses_get"]);
        let detail = &asked.details.unwrap().items[0];
        assert_eq!(detail.need, Some(v5::AttentionNeed::Question as i32));
        let title = support::units(detail.title.as_ref().unwrap());
        assert_eq!(title.chars().count(), 120);
        assert!(title.starts_with("Review ") && title.ends_with('…'));
        let permission = permission::Request::decode(&parse_json(r#"{"id":"per_status","sessionID":"ses_status_child","action":"fixture","resources":["resource"]}"#).unwrap()).unwrap();
        let permission_wait = location.permissions.ask(permission.clone(), None).unwrap();
        let permitted = relay.matching(first.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::Status(value)) })) if value.details.as_ref().is_some_and(|details| details.items[0].need == Some(v5::AttentionNeed::Permission as i32)))).await;
        assert!(matches!(permitted.body, Some(v5::frame::Body::Control(_))));
        first.commands.send(Command::Close(1012)).await.unwrap();
        let second = relay.opening().await;
        let replayed = status(&mut relay, second.generation, &["ses_get"]).await;
        assert_eq!(replayed.details.unwrap().items[0].need, Some(v5::AttentionNeed::Permission as i32));
        location.permissions.reply(&permission.id, permission::Reply("once".into()), None).unwrap();
        permission_wait.wait.unwrap().await.unwrap().unwrap();
        let review = location.guardrails.assert(ycoding_core::process::guardrails::Input { session_id: child.clone(), action: "shell".into(), resources: vec!["rm -rf /project".into()], metadata: None, skip_review: false, holder: None }).unwrap();
        location.questions.reject(&question.id).unwrap();
        drop(question_wait);
        let reviewed = status(&mut relay, second.generation, &["ses_get"]).await;
        assert_eq!(reviewed.details.unwrap().items[0].need, Some(v5::AttentionNeed::Review as i32));
        location.guardrails.reply(&child, &review.request.unwrap().id, guardrail::Reply::Reject).unwrap();
        assert!(review.wait.unwrap().await.unwrap().is_err());
        assert!(status(&mut relay, second.generation, &[]).await.attention.is_empty());
        world().core.execution.interrupt(&child).await.unwrap();
        connector_status_support::fail(&world().store, &child).await;
        let failed = status(&mut relay, second.generation, &["ses_get"]).await;
        assert_eq!(failed.failed.unwrap().items, ["ses_get"]);
        assert!(failed.running.is_empty());
        assert_eq!(failed.outstanding.unwrap().items, ["ses_get"]);
        connector_status_support::complete(&world().store, &world().core, &session::Id::new("ses_other").unwrap()).await;
        let live = relay.matching(second.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::Completions(value)) })) if value.items.iter().any(|item| item.session_id == "ses_other"))).await;
        assert!(matches!(live.body, Some(v5::frame::Body::Control(_))));
        second.commands.send(Command::Close(1012)).await.unwrap();
        let third = relay.opening().await;
        let resent = relay.matching(third.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::Status(_)) })))).await;
        assert!(matches!(resent.body, Some(v5::frame::Body::Control(_))));
        let replay = relay.matching(third.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::Completions(value)) })) if value.items.iter().any(|item| item.session_id == "ses_other" && item.title.is_some()))).await;
        assert!(matches!(replay.body, Some(v5::frame::Body::Control(_))));
        let (_, idle) = world().core.locations.session(&root).unwrap();
        let form = form::Info::decode(&parse_json(r#"{"id":"frm_status_idle","sessionID":"ses_get","title":"Idle request","fields":[{"key":"approve","type":"boolean"}]}"#).unwrap()).unwrap();
        idle.forms.create(form.clone()).unwrap();
        relay.matching(third.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::Status(value)) })) if value.details.as_ref().is_some_and(|details| details.items.iter().any(|item| item.session_id == "ses_get" && item.need == Some(v5::AttentionNeed::Question as i32))))).await;
        third.commands.send(Command::Close(1012)).await.unwrap();
        let fourth = relay.opening().await;
        let pending = status(&mut relay, fourth.generation, &["ses_get"]).await;
        assert!(pending.running.is_empty());
        assert!(pending.failed.is_none());
        assert_eq!(pending.details.unwrap().items[0].need, Some(v5::AttentionNeed::Question as i32));
        idle.forms.cancel(&form.id).unwrap();
        connector.shutdown().await.unwrap();
        relay.shutdown().await;
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completion_baseline_pages_are_bounded_ordered_and_terminated() {
    let _serial = SERIAL.lock().await;
    use ycoding_core::ycoding_store::session::{NewEvent, SessionTable, append};
    world().store.submit(|tx| {
        for index in 0..201 {
            let id = format!("ses_status_page_{index:03}");
            SessionTable::insert(tx, &support::record(&id))?;
            append(tx, &NewEvent {
                id: format!("evt_status_page_{index:03}").into(),
                aggregate_id: id.as_str().into(),
                created: 10,
                type_: "session.work.completed.1".into(),
                data: parse_json(&format!(r#"{{"sessionID":"{id}","inputID":"msg_status_input","assistantMessageID":"msg_status_final"}}"#)).unwrap(),
            }, None)?;
        }
        Ok(())
    }).unwrap().await.unwrap();
    let mut relay = Relay::start(5, false, Budgets::default()).await;
    let directory =
        std::env::temp_dir().join(format!("connector-completions-{}", std::process::id()));
    let control = Control::open(&directory).await.unwrap();
    let connector = Connector::start(
        control.clone(),
        Settings::new(Arc::new(Access(relay.origin()))),
        Arc::new(Environment {
            services: services(LocalAuth::disabled(), true),
            urls: vec![],
            subscriptions: Subscriptions::default(),
            uploads: Default::default(),
        }),
        Arc::new(standard().unwrap()),
    )
    .unwrap();
    control.set(true).await.unwrap();
    let opening = relay.opening().await;
    let mut ids = Vec::new();
    let mut pages = 0;
    loop {
        let frame = relay
            .matching(opening.generation, |frame| {
                matches!(
                    &frame.body,
                    Some(v5::frame::Body::Control(v5::Control {
                        kind: Some(v5::control::Kind::Completions(_))
                    }))
                )
            })
            .await;
        let Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Completions(page)),
        })) = frame.body
        else {
            unreachable!()
        };
        assert!(page.items.len() <= 200);
        if pages == 0 {
            assert_eq!(page.items.len(), 200);
            assert!(page.more);
        }
        pages += 1;
        ids.extend(page.items.into_iter().map(|item| item.session_id));
        if !page.more {
            break;
        }
    }
    assert_eq!(pages, 2);
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(
        ids.iter()
            .filter(|id| id.starts_with("ses_status_page_"))
            .count(),
        201
    );
    connector.shutdown().await.unwrap();
    relay.shutdown().await;
}
